/**
 * Le cerveau DJ : décide quoi jouer, quand sortir d'un morceau, avec quelle transition et quels effets.
 *
 * tick() est appelé ~10 fois/s. Il ne fait aucune E/S : il lit l'entrée, garde en mémoire ce qu'il a
 * déjà décidé (morceau préparé, transition engagée, phrases déjà évaluées) et renvoie des décisions.
 *
 * Cycle d'un morceau :
 *   1. cap de genre (hôte > votes avec inertie > genre de base), chemin de genres si éloigné
 *   2. choix du suivant (file d'abord, sinon meilleur candidat), 'load' sur la platine libre
 *   3. à l'approche de chaque début de phrase du morceau en cours : faut-il sortir ? (durée visée,
 *      section, fin du morceau, durée max) -> 'transition' avec un plan complet
 *   4. à la fin de la transition : 'stop' de la platine sortante, 'consume-queue' si besoin
 *   5. entre deux transitions : quelques effets rares, placés sur la grille
 *
 * Démarrage : rien ne joue -> 'load' puis un 'transition' d'ouverture (technique 'cut', depuis la
 * platine vide) : c'est le seul moyen du contrat pour lancer la lecture.
 */
import type {
  BrainDecision, BrainInput, DeckId, DeckState, DjBrain, DjSettings, FxCue, FxKind, Genre, GroovePlan, GrooveStyle, QueueItem,
  Section, TrackAnalysis, TrackRef, TransitionPlan, TransitionTechnique,
} from '../contracts';
import { GENRE_LABELS, RATE_LIMITS } from '../contracts';
import { GENRE_BPM, GENRE_GRAPH, genrePath, genrePathCost, isElectronic } from './genres';
import { checkReEdit, grooveStyleFor, partyRate, REEDIT_GENRES, type ReEditCheck } from './tempo';
import { harmonicScore } from './harmony';
import { energyAt, STYLE_PROFILES, targetBpmAt, type StyleProfile, type TransitionSituation } from './profiles';
import { bpmOf, primaryGenre, scoreCandidate, tempoMatch, type CandidateInfo, type ScoreContext } from './scoring';
import { chooseTechnique, needsSync, pickBeats, weightedPick } from './technique';

/** En dessous, la grille de temps du live n'est pas fiable : pas de calage, grille de l'analyse. */
export const BEAT_CONFIDENCE_MIN = 0.5;
/** Un son d'invité accepté passe au plus tard après ce délai, même s'il ne colle pas parfaitement. */
export const GUEST_MAX_WAIT_MS = 15 * 60 * 1000;
export const GUEST_FIT_SCORE = 0.55;
const WANT_GENRE_COOLDOWN_MS = 20_000;
const MIN_CANDIDATES = 3;
/** Inertie des votes : part minimale du genre en tête, et avance sur le genre visé actuel. */
const VOTE_SHARE_MIN = 0.4;
const VOTE_LEAD = 1.25;
const VOTE_TOTAL_MIN = 1;

/** Champs optionnels qu'un orchestrateur peut ajouter à BrainInput (hors contrat). */
export interface BrainInputExtras {
  /** Résultats d'analyse (par trackId), notamment pour les sons de la file. */
  analyses?: Record<number, TrackAnalysis> | TrackAnalysis[];
}

interface Pick {
  track: TrackRef;
  analysis?: TrackAnalysis;
  genre?: Genre;
  source: 'queue' | 'candidate';
  queueSource?: QueueItem['source'];
  queueIndex?: number;
  score: number;
  why: string;
}
type ReEdit = ReEditCheck & { style: GrooveStyle; text: string };
interface Planned extends Pick { deck: DeckId; startAt: number; reEdit?: ReEdit; reEditWanted?: boolean }
interface Current {
  deck: DeckId;
  track: TrackRef;
  analysis?: TrackAnalysis;
  genre?: Genre;
  source: Pick['source'];
  /** Instant ctx où le morceau est devenu audible. */
  startedCtx: number;
  transitionEndCtx: number;
  /** Durée de jeu visée (s). */
  playTarget: number;
  bridge: boolean;
  reEdit?: ReEdit;
}
interface GrooveState { deck: DeckId; plan: GroovePlan; stage: 1 | 2; lastUpdateCtx: number; wantBass: boolean }
interface Running { plan: TransitionPlan; endCtx: number; incoming: Planned; hadOutgoing: boolean }
interface Grid { bpm: number; beatLen: number; phraseBeats: number; phraseLen: number; nextPhrase: number; reliable: boolean }
interface TickEnv { profile: StyleProfile; targetEnergy: number; targetBpm: number; blockedGenres: Set<Genre>; blockedIds: Set<number>; recentPlays: Map<number, number> }

interface State {
  partyStartMs?: number;
  target?: Genre;
  targetSince: number;
  path: Genre[];
  lastPathKey?: string;
  current?: Current;
  planned?: Planned;
  running?: Running;
  lastEvalS: number;
  lastFxCtx: number;
  analyses: Map<number, TrackAnalysis>;
  analyzeAsked: Set<number>;
  wantAsked: Map<Genre, number>;
  plays: Map<number, number>;
  artists: string[];
  badIds: Set<number>;
  logged: Set<string>;
  planCounter: number;
  groove?: GrooveState;
  /** Action sur le groove à faire après la fin de la transition (jamais pendant : la table automatise eqLow). */
  pendingGroove?: 'start' | 'stop-after';
  lastRatePhrase: number;
  tracksSinceReEdit: number;
  reEditCount: number;
}

const label = (g?: Genre) => (g ? GENRE_LABELS[g] : 'genre inconnu');
const other = (d: DeckId): DeckId => (d === 'A' ? 'B' : 'A');
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const r0 = (x: number) => Math.round(x);
const trackName = (t: TrackRef) => `${t.artist} - ${t.title}`;

/**
 * Point de départ dans le morceau entrant.
 *  - genres électroniques : 0, l'intro est faite pour être mixée (on blende dessus).
 *  - rap, pop, 80s, latino... : intros souvent non mixables (a cappella, nappes, sketch). Si le morceau
 *    sera joué court (open-format, peak-time, ou durée visée < 100 s) et qu'il dure plus de 2 min, on
 *    saute 16 temps (4 mesures, ~8-11 s), toujours sur un début de phrase et jamais plus de 15 % du
 *    morceau ; les techniques choisies pour ces genres (cut, echo-out) font tomber l'entrant sur le 1.
 *  - sinon 0.
 */
export function chooseStartAt(track: TrackRef, genre: Genre | undefined, bpm: number, profile: StyleProfile, expectedPlay: number): number {
  if (!genre || isElectronic(genre)) return 0;
  if (track.duration < 120) return 0;
  const shortPlay = expectedPlay < 100 || profile.id === 'open-format' || profile.id === 'peak-time';
  if (!shortPlay) return 0;
  const intro = (16 * 60) / bpm;
  if (intro > track.duration * 0.15) return 0;
  return Math.round(intro * 1000) / 1000;
}

/** Raison de sortir au prochain début de phrase, selon la section qui se termine et la durée jouée. */
export function exitReason(section: Section, ratio: number): string | undefined {
  if (ratio < 0.75) return undefined;
  switch (section) {
    case 'outro': return 'le morceau entre dans son outro';
    case 'drop': return ratio >= 0.9 ? 'fin du drop' : undefined;
    case 'breakdown': return ratio >= 0.9 ? 'breakdown, moment idéal pour fondre' : undefined;
    case 'body': return ratio >= 1 ? 'fin de phrase, durée visée atteinte' : undefined;
    case 'build': return ratio >= 1.5 ? 'trop long, on sort malgré la montée' : undefined;
    case 'intro': return ratio >= 1.2 ? 'durée visée largement atteinte' : undefined;
    default: return ratio >= 1 ? 'durée visée atteinte' : undefined;
  }
}

function initialState(): State {
  return {
    targetSince: 0, path: [], lastEvalS: -Infinity, lastFxCtx: -Infinity,
    analyses: new Map(), analyzeAsked: new Set(), wantAsked: new Map(), plays: new Map(),
    artists: [], badIds: new Set(), logged: new Set(), planCounter: 0,
    lastRatePhrase: -Infinity, tracksSinceReEdit: Infinity, reEditCount: 0,
  };
}

class Brain implements DjBrain {
  private s: State = initialState();
  private random: () => number;
  private env!: TickEnv;

  constructor(random: () => number) { this.random = random; }

  reset(): void { this.s = initialState(); }

  tick(input: BrainInput): BrainDecision[] {
    const s = this.s;
    const out: BrainDecision[] = [];
    if (s.partyStartMs === undefined) { s.partyStartMs = input.nowMs; s.targetSince = input.nowMs; }
    this.ingest(input);
    this.env = this.makeEnv(input);
    this.adopt(input, out);
    this.updateTarget(input, out);
    const step = this.computeStep(out);
    this.requests(input, step, out);

    if (s.running) {
      if (input.nowCtx >= s.running.endCtx) this.finish(input, out);
      else return out;
    }
    if (input.activeTransition) return out; // une transition qu'on n'a pas lancée : on attend
    if (s.current) this.checkCurrentAlive(input, out);
    this.plan(input, step, out);
    if (!s.current) this.open(input, out);
    else {
      this.evaluate(input, out);
      if (s.current && !s.running) {
        this.maybeRate(input, out);
        this.grooveFollow(input, out);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ état / contexte

  private ingest(input: BrainInput): void {
    const a = this.s.analyses;
    for (const c of input.candidates) if (c.analysis) a.set(c.track.id, c.analysis);
    for (const d of Object.values(input.decks)) if (d.analysis) a.set(d.analysis.trackId, d.analysis);
    const extra = (input as BrainInput & BrainInputExtras).analyses;
    if (extra) for (const x of Array.isArray(extra) ? extra : Object.values(extra)) a.set(x.trackId, x);
  }

  private makeEnv(input: BrainInput): TickEnv {
    const profile = STYLE_PROFILES[input.settings.style] ?? STYLE_PROFILES['paris-tech-house'];
    const minutes = (input.nowMs - (this.s.partyStartMs ?? input.nowMs)) / 60000;
    const recentPlays = new Map(this.s.plays);
    for (const h of input.history) {
      const prev = recentPlays.get(h.track.id);
      if (prev === undefined || h.startedAt > prev) recentPlays.set(h.track.id, h.startedAt);
    }
    const host = input.crowd.host;
    return {
      profile,
      targetEnergy: clamp(energyAt(profile, minutes) + (input.crowd.energy || 0) * 0.15, 0.1, 1),
      targetBpm: input.settings.targetBpm && input.settings.targetBpm > 0 ? input.settings.targetBpm : targetBpmAt(profile, minutes),
      blockedGenres: new Set(host?.blockedGenres ?? []),
      blockedIds: new Set([...(host?.blockedTrackIds ?? []), ...this.s.badIds]),
      recentPlays,
    };
  }

  private log(out: BrainDecision[], message: string): void { out.push({ type: 'log', message }); }
  private logOnce(out: BrainDecision[], key: string, message: string): void {
    if (this.s.logged.has(key)) return;
    this.s.logged.add(key);
    this.log(out, message);
  }

  /** Après un reset (ou si la lecture a été lancée ailleurs) : reprend le morceau qui joue. */
  private adopt(input: BrainInput, out: BrainDecision[]): void {
    const s = this.s;
    if (s.current || s.running || input.activeTransition) return;
    for (const d of Object.values(input.decks)) {
      if (d.status !== 'playing' || !d.track) continue;
      const genre = primaryGenre({ track: d.track, analysis: d.analysis });
      s.current = {
        deck: d.id, track: d.track, analysis: d.analysis ?? s.analyses.get(d.track.id), genre, source: 'candidate',
        startedCtx: input.nowCtx - d.position / (d.rate || 1), transitionEndCtx: input.nowCtx,
        playTarget: this.choosePlayTarget(input.settings, genre, false), bridge: false,
      };
      if (!s.plays.has(d.track.id)) s.plays.set(d.track.id, input.nowMs);
      this.pushArtist(d.track);
      if (s.planned?.deck === d.id) s.planned = undefined;
      this.log(out, `Reprise du morceau en cours sur la platine ${d.id} : ${trackName(d.track)}`);
      return;
    }
  }

  private checkCurrentAlive(input: BrainInput, out: BrainDecision[]): void {
    const cur = this.s.current!;
    const d = input.decks[cur.deck];
    if (d.track?.id === cur.track.id && (d.status === 'playing' || d.status === 'paused')) return;
    this.log(out, `Le morceau ${trackName(cur.track)} s'est arrêté (${d.status}) : on relance la suite`);
    this.stopGroove(input.nowCtx, 0, out);
    this.s.current = undefined;
    this.s.lastEvalS = -Infinity;
  }

  private pushArtist(t: TrackRef): void {
    this.s.artists.push(t.artist.toLowerCase());
    if (this.s.artists.length > 10) this.s.artists.shift();
  }

  // ------------------------------------------------------------------ 1. genre visé

  private updateTarget(input: BrainInput, out: BrainDecision[]): void {
    const s = this.s;
    const { settings, crowd } = input;
    const blocked = this.env.blockedGenres;
    const forced = crowd.host?.forcedGenre;
    if (forced && !blocked.has(forced)) {
      if (s.target !== forced) {
        s.target = forced; s.targetSince = input.nowMs;
        this.log(out, `L'hôte impose le genre ${label(forced)}`);
      }
      return;
    }
    let desired: Genre = s.target ?? settings.baseGenre;
    if (settings.followCrowd) {
      const entries = (Object.entries(crowd.genreWeights ?? {}) as Array<[Genre, number]>)
        .filter(([g, w]) => !blocked.has(g) && w > 0);
      const total = entries.reduce((a, [, w]) => a + w, 0);
      if (total >= VOTE_TOTAL_MIN) {
        entries.sort((a, b) => b[1] - a[1]);
        const [top, wTop] = entries[0];
        const wCur = s.target ? (crowd.genreWeights[s.target] ?? 0) : 0;
        if (top !== s.target && wTop / total >= VOTE_SHARE_MIN && wTop >= wCur * VOTE_LEAD) desired = top;
      } else if (total < 0.3) desired = settings.baseGenre; // plus personne ne vote : retour au genre de base
    } else desired = settings.baseGenre;
    if (blocked.has(desired)) desired = s.target && !blocked.has(s.target) ? s.target : settings.baseGenre;
    if (s.target === undefined) {
      s.target = desired; s.targetSince = input.nowMs;
      this.log(out, `Genre de départ : ${label(desired)}`);
      return;
    }
    if (desired === s.target) return;
    const dwellMs = this.env.profile.genreDwellMinutes * 60000;
    if (input.nowMs - s.targetSince < dwellMs) {
      this.logOnce(out, `dwell:${desired}:${s.targetSince}`, `Le public pousse vers ${label(desired)}, on attend encore un peu avant de changer de cap`);
      return;
    }
    this.log(out, `Nouveau cap : ${label(s.target)} -> ${label(desired)}${settings.followCrowd ? ' (votes du public)' : ''}`);
    s.target = desired; s.targetSince = input.nowMs;
  }

  /** Genre de la prochaine étape : le genre visé, ou l'étape suivante du chemin s'il est loin. */
  private computeStep(out: BrainDecision[]): Genre {
    const s = this.s;
    const target = s.target!;
    const from = s.running ? s.running.incoming.genre : s.current?.genre;
    if (!from || from === target) { s.path = [target]; return target; }
    const path = genrePath(from, target, this.env.blockedGenres);
    s.path = path;
    const cost = genrePathCost(path);
    const direct = path.length <= 2 || cost <= this.env.profile.maxDirectJumpCost;
    const step = direct ? target : path[1];
    const key = `${path.join('>')}|${this.env.profile.id}`;
    if (key !== s.lastPathKey) {
      s.lastPathKey = key;
      if (path.length > 2) {
        this.log(out, direct
          ? `Saut direct ${label(from)} -> ${label(target)} (rupture assumée)`
          : `Chemin vers ${label(target)} : ${path.map(label).join(' -> ')}`);
      }
    }
    return step;
  }

  // ------------------------------------------------------------------ demandes : catalogue, analyses

  private refBpm(input: BrainInput): number | undefined {
    const s = this.s;
    if (s.running) {
      const p = s.running.incoming;
      return bpmOf(p) * s.running.plan.incomingRate;
    }
    const cur = s.current;
    if (!cur) return undefined;
    const d = input.decks[cur.deck];
    if (d.live && d.live.beatConfidence >= BEAT_CONFIDENCE_MIN && d.live.bpm > 0) return d.live.bpm;
    return bpmOf({ track: cur.track, analysis: cur.analysis, genre: cur.genre }) * (d.rate || 1);
  }

  private scoreCtx(input: BrainInput, step: Genre): ScoreContext {
    const s = this.s;
    const excludeIds = new Set<number>();
    for (const d of Object.values(input.decks)) if (d.track) excludeIds.add(d.track.id);
    if (s.current) excludeIds.add(s.current.track.id);
    if (s.running) excludeIds.add(s.running.incoming.track.id);
    const refAna = s.running ? s.running.incoming.analysis : s.current?.analysis;
    return {
      refBpm: this.refBpm(input),
      refKey: refAna?.key,
      targetEnergy: this.env.targetEnergy,
      targetBpm: this.env.targetBpm,
      stepGenre: step,
      targetGenre: s.target!,
      path: s.path,
      blockedGenres: this.env.blockedGenres,
      blockedIds: this.env.blockedIds,
      recentPlays: this.env.recentPlays,
      nowMs: input.nowMs,
      recentArtists: s.artists.slice(-3),
      excludeIds,
      random: this.random,
    };
  }

  private requests(input: BrainInput, step: Genre, out: BrainDecision[]): void {
    const s = this.s;
    let n = 0;
    for (const q of input.queue) {
      const id = q.track.id;
      if (!s.analyses.has(id) && !s.analyzeAsked.has(id)) { s.analyzeAsked.add(id); out.push({ type: 'analyze', track: q.track }); }
    }
    for (const c of input.candidates) {
      const id = c.track.id;
      if (n >= 4) break;
      if (!c.analysis && !s.analyses.has(id) && !s.analyzeAsked.has(id)) { s.analyzeAsked.add(id); n++; out.push({ type: 'analyze', track: c.track }); }
    }
    const ctx = this.scoreCtx(input, step);
    const usable = input.candidates.filter((c) => c.genre === step && !scoreCandidate({ ...c, analysis: c.analysis ?? s.analyses.get(c.track.id), source: 'candidate' }, ctx).excluded).length;
    if (usable >= MIN_CANDIDATES) return;
    const ref = ctx.refBpm ?? this.env.targetBpm;
    const last = s.wantAsked.get(step);
    if (last === undefined || input.nowMs - last >= WANT_GENRE_COOLDOWN_MS) {
      s.wantAsked.set(step, input.nowMs);
      const [bpmMin, bpmMax] = bridgeRange(step, ref);
      const bridging = step !== s.target;
      out.push({
        type: 'want-genre', genre: step, bpmMin, bpmMax,
        reason: `Il manque des morceaux ${label(step)} (${usable} dispo) autour de ${r0(ref)} BPM${bridging ? `, pour faire le pont vers ${label(s.target)}` : ''}`,
      });
      return;
    }
    // Déjà demandé et toujours rien : on élargit aux genres voisins (le plus proche d'abord).
    if (usable > 0) return;
    const neighbours = (Object.entries(GENRE_GRAPH[step]) as Array<[Genre, number]>)
      .filter(([g]) => !this.env.blockedGenres.has(g))
      .sort((a, b) => a[1] - b[1]);
    for (const [g] of neighbours) {
      const t = s.wantAsked.get(g);
      if (t !== undefined && input.nowMs - t < WANT_GENRE_COOLDOWN_MS * 3) continue;
      s.wantAsked.set(g, input.nowMs);
      const [bpmMin, bpmMax] = bridgeRange(g, ref);
      out.push({ type: 'want-genre', genre: g, bpmMin, bpmMax, reason: `Plus rien de jouable en ${label(step)}, on élargit à ${label(g)}` });
      return;
    }
  }

  // ------------------------------------------------------------------ 2-3. choix et préparation

  private info(track: TrackRef, genre: Genre | undefined, source: Pick['source'], queueSource?: QueueItem['source']): CandidateInfo {
    const analysis = this.s.analyses.get(track.id);
    return { track, analysis, genre: genre ?? primaryGenre({ track, analysis }), source, queueSource };
  }

  /** Premier son de la file qui peut passer maintenant. Renvoie aussi un son d'invité en secours. */
  private pickFromQueue(input: BrainInput, ctx: ScoreContext, out: BrainDecision[]): { pick?: Pick; fallback?: Pick } {
    let fallback: Pick | undefined;
    for (let i = 0; i < input.queue.length; i++) {
      const item = input.queue[i];
      const info = this.info(item.track, item.genre, 'queue', item.source);
      const r = scoreCandidate(info, ctx);
      if (r.excluded) {
        if (r.excluded !== 'déjà sur une platine') this.logOnce(out, `qx:${item.track.id}`, `File : ${trackName(item.track)} ignoré (${r.excluded})`);
        continue;
      }
      const pick: Pick = { ...info, queueIndex: i, score: r.score, why: '' };
      if (item.source === 'guest') {
        const waited = input.nowMs - item.addedAt;
        if (waited < GUEST_MAX_WAIT_MS && r.score < GUEST_FIT_SCORE) {
          fallback ??= { ...pick, why: 'demande d’invité (rien d’autre sous la main)' };
          this.logOnce(out, `qd:${item.track.id}`, `Demande d'invité ${trackName(item.track)} gardée pour plus tard : elle ne colle pas encore (score ${r.score.toFixed(2)})`);
          continue;
        }
        pick.why = waited >= GUEST_MAX_WAIT_MS ? 'demande d’invité en attente depuis 15 min' : 'demande d’invité, elle colle au moment';
      } else pick.why = item.source === 'host' ? 'ajouté par l’hôte' : 'file';
      return { pick, fallback };
    }
    return { fallback };
  }

  private pickCandidate(input: BrainInput, ctx: ScoreContext): Pick | undefined {
    for (const allowArtistRepeat of [false, true]) {
      let best: Pick | undefined;
      const c2 = { ...ctx, allowArtistRepeat };
      for (const c of input.candidates) {
        const info = this.info(c.track, c.genre, 'candidate');
        const r = scoreCandidate(info, c2);
        if (r.excluded) continue;
        if (!best || r.score > best.score) best = { ...info, score: r.score, why: '' };
      }
      if (best) {
        const parts: string[] = [];
        if (best.genre === ctx.stepGenre && ctx.stepGenre !== ctx.targetGenre) parts.push(`pont vers ${label(ctx.targetGenre)}`);
        else parts.push(`meilleur candidat ${label(best.genre)}`);
        parts.push(`score ${best.score.toFixed(2)}`);
        best.why = parts.join(', ');
        return best;
      }
    }
    return undefined;
  }

  private plan(input: BrainInput, step: Genre, out: BrainDecision[]): void {
    const s = this.s;
    const ctx = this.scoreCtx(input, step);
    if (s.planned) {
      const d = input.decks[s.planned.deck];
      if (d.status === 'error' && (!d.track || d.track.id === s.planned.track.id)) {
        s.badIds.add(s.planned.track.id);
        this.env.blockedIds.add(s.planned.track.id);
        this.log(out, `Chargement impossible de ${trackName(s.planned.track)}${d.error ? ` (${d.error})` : ''}, on en prend un autre`);
        s.planned = undefined;
      } else if (s.current && s.planned.deck === s.current.deck) s.planned = undefined;
    }
    const pl = s.planned;
    if (pl && !pl.analysis && s.analyses.has(pl.track.id)) {
      pl.analysis = s.analyses.get(pl.track.id);
      if (pl.reEditWanted) pl.reEdit = this.checkPlannedReEdit(input, { ...pl, analysis: pl.analysis! }, pl.deck, out);
    }
    const { pick: q, fallback } = this.pickFromQueue(input, ctx, out);
    const p = s.planned;
    let next: Pick | undefined;
    let why = '';
    if (!p) {
      next = q ?? this.pickCandidate(input, ctx) ?? fallback;
    } else {
      const pIdx = p.source === 'queue' ? input.queue.findIndex((x) => x.track.id === p.track.id) : -1;
      const pInfo = { ...this.info(p.track, p.genre, p.source, p.queueSource) };
      const pCtx = { ...ctx, excludeIds: new Set([...ctx.excludeIds].filter((id) => id !== p.track.id)), allowArtistRepeat: true };
      const pExcl = scoreCandidate(pInfo, pCtx).excluded;
      if (q && q.track.id !== p.track.id && (p.source !== 'queue' || pIdx < 0 || (q.queueIndex ?? 0) < pIdx)) {
        next = q; why = 'La file a changé';
      } else if (p.source === 'queue' && pIdx < 0) {
        next = q ?? this.pickCandidate(input, ctx) ?? fallback; why = 'Retiré de la file';
      } else if (pExcl && pExcl !== 'joué il y a moins de 2 h') {
        next = q ?? this.pickCandidate(input, ctx) ?? fallback; why = `Plus possible (${pExcl})`;
      } else if (p.source === 'candidate' && p.genre !== step) {
        const c = this.pickCandidate(input, ctx);
        if (c && c.genre === step) { next = c; why = `Nouveau cap ${label(step)}`; }
      }
    }
    if (!next || (p && next.track.id === p.track.id)) return;
    const deck: DeckId = p?.deck ?? (s.current ? other(s.current.deck) : input.decks.A.status === 'playing' ? 'B' : 'A');
    this.emitLoad(input, next, deck, why, out);
  }

  private emitLoad(input: BrainInput, pick: Pick, deck: DeckId, why: string, out: BrainDecision[]): void {
    const profile = this.env.profile;
    const bpm = bpmOf(pick);
    const range = profile.playSeconds[pick.genre ?? 'house'];
    const startAt = chooseStartAt(pick.track, pick.genre, bpm, profile, (range[0] + range[1]) / 2);
    const wanted = this.wantReEdit(pick);
    const analysis = pick.analysis ?? this.s.analyses.get(pick.track.id);
    const reEdit = wanted && analysis ? this.checkPlannedReEdit(input, { ...pick, analysis }, deck, out) : undefined;
    this.s.planned = { ...pick, analysis, deck, startAt, reEdit, reEditWanted: wanted };
    const reason = `${why ? `${why} : ` : ''}${pick.why}${reEdit ? ', prévu en re-edit' : ''}`;
    out.push({ type: 'load', deck, track: pick.track, startAt, reason });
    this.log(out, `Platine ${deck} : ${trackName(pick.track)} (${label(pick.genre)}, ${r0(bpm)} BPM${startAt > 0 ? `, départ à ${startAt.toFixed(1)} s` : ''}) ; ${reason}`);
  }

  private ready(input: BrainInput, p: Planned): boolean {
    const d = input.decks[p.deck];
    return d.track?.id === p.track.id && (d.status === 'ready' || d.status === 'paused');
  }

  /**
   * Re-edit : un morceau lent / d'une autre époque qui arrive après de la house peut être joué au tempo
   * de la soirée avec un beat en dessous. Dosé : probabilité du profil et N morceaux minimum entre deux.
   * La vérification (tempo, stabilité, caps) attend l'analyse du morceau si elle n'est pas encore là.
   */
  private wantReEdit(pick: Pick): boolean {
    const s = this.s;
    const profile = this.env.profile;
    const cur = s.current;
    if (!pick.genre || !REEDIT_GENRES.has(pick.genre) || !cur) return false;
    if (!(isElectronic(cur.genre) || cur.reEdit)) return false;
    if (s.tracksSinceReEdit < profile.reEditCooldownTracks) return false;
    return this.random() < profile.reEditChance;
  }

  private checkPlannedReEdit(input: BrainInput, pick: Pick & { analysis: TrackAnalysis }, deck: DeckId, out: BrainDecision[]): ReEdit | undefined {
    const s = this.s;
    const cur = s.current;
    const analysis = pick.analysis;
    const target = this.env.targetBpm;
    const check = checkReEdit(analysis, target, input.decks[deck].caps, input.settings, this.env.profile);
    if (!check.ok) {
      this.log(out, `Re-edit refusé pour ${trackName(pick.track)} : ${check.reason}`);
      return undefined;
    }
    const style = grooveStyleFor(s.target && !REEDIT_GENRES.has(s.target) ? s.target : cur?.genre && isElectronic(cur.genre) ? cur.genre : s.target);
    const nb = analysis.bpm;
    const outBpm = nb * check.mult * check.rate;
    const sign = check.rate >= 1 ? '+' : '-';
    const st = analysis.tempoStability;
    const text = `Re-edit : ${label(pick.genre)} à ${r0(nb)} BPM passé à ${r0(outBpm)} (${sign}${(check.pct * 100).toFixed(0)} %${check.mult !== 1 ? (check.mult === 2 ? ', en double tempo' : ', en demi-tempo') : ''})`
      + `, ${st !== undefined ? `tempo stable (${st.toFixed(2).replace('.', ',')})` : 'écart faible'}, beat ${style} en dessous, basses d'origine allégées`;
    this.log(out, `${text} : prévu pour ${trackName(pick.track)}`);
    return { ...check, style, text };
  }

  private choosePlayTarget(settings: DjSettings, genre: Genre | undefined, bridge: boolean): number {
    const profile = this.env.profile;
    let [a, b] = profile.playSeconds[genre ?? 'house'];
    if (bridge) { a *= profile.bridgePlayFactor; b *= profile.bridgePlayFactor; }
    let t = a + (b - a) * this.random();
    if (this.random() < profile.playFullChance) t = settings.maxPlaySeconds; // celui-là, on le laisse en entier
    return clamp(t, settings.minPlaySeconds, settings.maxPlaySeconds);
  }

  // ------------------------------------------------------------------ transitions

  private open(input: BrainInput, out: BrainDecision[]): void {
    const p = this.s.planned;
    if (!p || !this.ready(input, p)) return;
    p.reEdit = undefined;
    const bpm = bpmOf(p);
    const startCtx = input.nowCtx + 0.1;
    const plan: TransitionPlan = {
      id: this.planId(p), from: other(p.deck), to: p.deck, technique: 'cut', startCtx, beats: 1, bpm,
      incomingStartCtx: startCtx, incomingStartPos: p.startAt, incomingRate: 1, accents: [], intensity: 0,
      reason: `Ouverture : ${trackName(p.track)} (${label(p.genre)}, ${r0(bpm)} BPM)`,
    };
    this.commit(input, plan, p, false, out);
  }

  private planId(p: Pick): string { return `t${++this.s.planCounter}-${p.track.id}`; }

  private commit(input: BrainInput, plan: TransitionPlan, incoming: Planned, hadOutgoing: boolean, out: BrainDecision[]): void {
    const s = this.s;
    s.running = { plan, endCtx: plan.startCtx + (plan.beats * 60) / plan.bpm, incoming, hadOutgoing };
    s.plays.set(incoming.track.id, input.nowMs);
    this.pushArtist(incoming.track);
    out.push({ type: 'transition', plan });
    this.log(out, plan.reason);
  }

  private finish(input: BrainInput, out: BrainDecision[]): void {
    const s = this.s;
    const r = s.running!;
    if (r.hadOutgoing) out.push({ type: 'stop', deck: r.plan.from });
    if (r.incoming.source === 'queue') out.push({ type: 'consume-queue', trackId: r.incoming.track.id });
    const bridge = !!r.incoming.genre && r.incoming.genre !== s.target;
    s.current = {
      deck: r.plan.to, track: r.incoming.track, analysis: r.incoming.analysis ?? s.analyses.get(r.incoming.track.id),
      genre: r.incoming.genre, source: r.incoming.source, startedCtx: r.plan.incomingStartCtx, transitionEndCtx: r.endCtx,
      playTarget: this.choosePlayTarget(input.settings, r.incoming.genre, bridge), bridge, reEdit: r.incoming.reEdit,
    };
    if (r.incoming.reEdit) { s.tracksSinceReEdit = 0; s.reEditCount++; } else s.tracksSinceReEdit++;
    s.running = undefined;
    s.planned = undefined;
    s.lastEvalS = -Infinity;
    this.log(out, `En piste : ${trackName(s.current.track)}, environ ${r0(s.current.playTarget)} s${bridge ? ' (morceau de pont)' : ''}`);
    this.grooveAfterTransition(input, r.incoming, out);
  }

  private grid(d: DeckState, cur: Current, now: number): Grid {
    const live = d.live;
    if (live && live.beatConfidence >= BEAT_CONFIDENCE_MIN && live.nextPhraseCtx !== undefined && live.bpm > 0) {
      const beatLen = 60 / live.bpm;
      const phraseBeats = live.phraseBeats || 16;
      return { bpm: live.bpm, beatLen, phraseBeats, phraseLen: phraseBeats * beatLen, nextPhrase: live.nextPhraseCtx, reliable: true };
    }
    // Repli : grille du BPM d'analyse depuis le début audible (départs choisis sur des phrases).
    const bpm = bpmOf({ track: cur.track, analysis: cur.analysis, genre: cur.genre }) * (d.rate || 1);
    const beatLen = 60 / bpm;
    const phraseLen = 16 * beatLen;
    const k = Math.max(0, Math.ceil((now - cur.startedCtx) / phraseLen - 1e-6));
    return { bpm, beatLen, phraseBeats: 16, phraseLen, nextPhrase: cur.startedCtx + k * phraseLen, reliable: false };
  }

  private evaluate(input: BrainInput, out: BrainDecision[]): void {
    const s = this.s;
    const cur = s.current!;
    const d = input.decks[cur.deck];
    if (d.status !== 'playing') return;
    const now = input.nowCtx;
    const settings = input.settings;
    const profile = this.env.profile;
    const g = this.grid(d, cur, now);
    const rate = d.rate || 1;
    const duration = d.duration || cur.track.duration;
    const endCtx = now + Math.max(0, duration - d.position) / rate;
    const p = s.planned;
    const isReady = !!p && this.ready(input, p);

    if (endCtx - now < 0.75) {
      if (isReady) this.emergencyCut(input, cur, p!, g, out);
      return;
    }
    let S = g.nextPhrase;
    while (S - now < 0.25) S += g.phraseLen;
    if (S - now > Math.max(3, 10 * g.beatLen)) return;
    if (Math.abs(S - s.lastEvalS) < g.phraseLen * 0.5) return;
    s.lastEvalS = S;

    const maxCtx = cur.startedCtx + settings.maxPlaySeconds;
    const hardEnd = endCtx - 0.5;
    const prefEnd = Math.min(hardEnd, maxCtx);
    const estDur = profile.typicalTransitionBeats * g.beatLen;
    const forced = S + g.phraseLen + estDur > prefEnd;
    const played = S - cur.startedCtx;
    const section: Section = d.live?.section ?? 'unknown';
    let why: string | undefined;
    if (forced) {
      why = S + g.phraseLen + estDur > hardEnd ? 'sortie forcée, fin du morceau proche' : 'sortie forcée, durée max atteinte';
    } else if (played >= settings.minPlaySeconds && S >= cur.transitionEndCtx + g.phraseLen * 0.99) {
      why = exitReason(section, played / cur.playTarget);
    }
    if (why && p && isReady && S < hardEnd) {
      const plan = this.buildPlan(input, g, S, prefEnd, hardEnd, cur, p, section, forced, why);
      this.grooveAtTransition(input.nowCtx, plan, p, out); // avant la transition : rien ne doit tomber pendant
      this.commit(input, plan, p, true, out);
      return;
    }
    this.grooveBuild(S, g, out);
    if (why && !isReady) this.logOnce(out, `nr:${cur.track.id}`, `Il faudrait sortir (${why}) mais le morceau suivant n'est pas prêt`);
    this.maybeFx(input, g, S, cur, out);
  }

  private emergencyCut(input: BrainInput, cur: Current, p: Planned, g: Grid, out: BrainDecision[]): void {
    const startCtx = input.nowCtx + 0.1;
    p.reEdit = undefined;
    this.s.pendingGroove = undefined;
    this.stopGroove(input.nowCtx, 0, out);
    const plan: TransitionPlan = {
      id: this.planId(p), from: cur.deck, to: p.deck, technique: 'cut', startCtx, beats: 1, bpm: g.bpm,
      incomingStartCtx: startCtx, incomingStartPos: p.startAt, incomingRate: 1, accents: [], intensity: 0,
      reason: `Sortie d'urgence : ${trackName(cur.track)} se termine, coupe sèche vers ${trackName(p.track)}`,
    };
    this.commit(input, plan, p, true, out);
  }

  private buildPlan(input: BrainInput, g: Grid, S: number, prefEnd: number, hardEnd: number, cur: Current, p: Planned,
    section: Section, forced: boolean, exitWhy: string): TransitionPlan {
    const profile = this.env.profile;
    const settings = input.settings;
    const inDeck = input.decks[p.deck];
    const inAna = p.analysis ?? this.s.analyses.get(p.track.id);
    const inBpm = bpmOf({ track: p.track, analysis: inAna, genre: p.genre });
    const outBpm = g.bpm;
    const tm = tempoMatch(outBpm, inBpm);
    let maxDelta = Math.min(inDeck.caps?.maxRateDelta ?? 0, 0.06);
    const canRate = !!inDeck.caps?.canSetRate && maxDelta > 0;
    if (p.reEdit) {
      // Re-edit : calage large permis (déjà validé), seulement si la grille est fiable.
      const lim = Math.min(inDeck.caps?.maxRateDelta ?? 0, p.reEdit.limit);
      if (g.reliable && canRate && tm.pct <= lim) maxDelta = lim;
      else { p.reEdit = undefined; }
    }
    const syncOk = (canRate && tm.pct <= maxDelta) || tm.pct <= 0.02;
    const genreChange = !!cur.genre && !!p.genre && cur.genre !== p.genre;
    const remainingBeats = (prefEnd - S) / g.beatLen;
    let situation: TransitionSituation;
    if (forced && remainingBeats < 16) situation = 'emergency';
    else if (!syncOk) situation = 'tempo-jump';
    else if (genreChange) situation = 'genre-change';
    else if (section === 'breakdown') situation = 'breakdown';
    else if (section === 'outro') situation = 'outro';
    else situation = 'same-genre';

    let technique: TransitionTechnique = chooseTechnique({
      profile, situation, syncOk, beatReliable: g.reliable, outgoingGenre: cur.genre, incomingGenre: p.genre, random: this.random,
    });
    let beats = technique === 'cut' ? 1 : pickBeats(profile, technique, this.random);
    // La transition doit finir avant la durée max (si possible) et avant la fin du morceau (toujours).
    const limPref = Math.floor((prefEnd - S) / g.beatLen + 1e-6);
    const limHard = Math.floor((hardEnd - S) / g.beatLen + 1e-6);
    const limit = limPref >= 4 ? limPref : limHard;
    while (beats > limit && beats > 4) beats = Math.floor(beats / 2);
    if (technique === 'long-blend' && beats < 16) technique = 'bass-swap';
    if (beats > limit) {
      if (limit >= 4) { technique = 'echo-out'; beats = 4; } else { technique = 'cut'; beats = 1; }
    }
    if (needsSync(technique) && !(syncOk && g.reliable)) technique = 'echo-out';

    const beatLen = g.beatLen;
    const total = beats * beatLen;
    let incomingStartCtx: number;
    if (needsSync(technique) || technique === 'cut') incomingStartCtx = S;
    else if (technique === 'reverb-wash') incomingStartCtx = S + Math.max(1, Math.floor(beats / 2)) * beatLen;
    else incomingStartCtx = S + total;
    // Re-edit : l'entrant démarre directement au tempo de sortie, quelle que soit la technique.
    const incomingRate = (needsSync(technique) || p.reEdit) && canRate ? clamp(tm.rate, 1 - maxDelta, 1 + maxDelta) : 1;
    // Après la transition : retour à 1 (rateRelaxBeats) sauf si le cerveau garde la main (tempo de soirée, re-edit).
    const keepRate = !!p.reEdit || (profile.followPartyTempo && isElectronic(p.genre));
    const peak = this.env.targetEnergy >= 0.85;
    let intensity = settings.fxAmount <= 0 ? 0
      : clamp(settings.fxAmount * (0.5 + profile.fxDensity) + (genreChange ? 0.15 : 0) + (peak ? 0.1 : 0), 0, profile.maxIntensity);
    intensity = Math.round(intensity * 100) / 100;
    const accents = this.accents(technique, cur, S, beats, beatLen, outBpm, incomingStartCtx, intensity, genreChange, peak);

    // Raison lisible
    const head = genreChange ? `Passage ${label(cur.genre)} vers ${label(p.genre)}` : `On reste en ${label(cur.genre)}`;
    const diff = Math.abs(outBpm - inBpm * tm.mult);
    let tempo = syncOk
      ? `écart de ${r0(diff)} BPM${tm.mult !== 1 ? (tm.mult === 2 ? ' (en double tempo)' : ' (en demi-tempo)') : ''}`
      : `écart de tempo trop grand pour caler (${r0(outBpm)} -> ${r0(inBpm * tm.mult)} BPM)`;
    if (Math.abs(incomingRate - 1) > 1e-4) tempo += `, calage à ${(incomingRate * 100).toFixed(1).replace('.', ',')} %`;
    const k1 = cur.analysis?.key;
    const k2 = inAna?.key;
    const h = harmonicScore(k1, k2);
    const harmony = !k1 || !k2 ? 'clé inconnue'
      : h >= 0.7 ? `clés compatibles (${k1} -> ${k2})` : `clés éloignées (${k1} -> ${k2}), on évite de les superposer longtemps`;
    const tech = describeTechnique(technique, beats);
    const bridge = p.genre && this.s.target && p.genre !== this.s.target ? ` (pont vers ${label(this.s.target)})` : '';
    const noGrid = g.reliable ? '' : ' ; grille de temps peu fiable, transition sans calage';
    const re = p.reEdit ? ` ; ${p.reEdit.text}` : '';
    const reason = `${head}${bridge} : ${tempo}, ${harmony}, ${tech} ; ${exitWhy}${noGrid}${re}`;

    return {
      id: this.planId(p), from: cur.deck, to: p.deck, technique, startCtx: S, beats, bpm: outBpm,
      incomingStartCtx, incomingStartPos: p.startAt, incomingRate: Math.round(incomingRate * 10000) / 10000,
      rateRelaxBeats: Math.abs(incomingRate - 1) > 1e-4 && !keepRate ? profile.rateRelaxBeats : undefined,
      accents, intensity, reason,
    };
  }

  /** Accents ajoutés à la recette : peu, et seulement quand ils servent. */
  private accents(t: TransitionTechnique, cur: Current, S: number, beats: number, beatLen: number, bpm: number,
    incomingStartCtx: number, intensity: number, genreChange: boolean, peak: boolean): FxCue[] {
    const profile = this.env.profile;
    const cues: FxCue[] = [];
    if (intensity < 0.2) return cues;
    const vocal = cur.analysis?.vocalness ?? 0;
    const riserOk = profile.allowRiser && (!profile.riserOnlyOnGenreChangeOrPeak || genreChange || peak);
    if (needsSync(t)) {
      const swap = t === 'bass-swap' ? S + beats * beatLen : S + Math.floor(beats / 2) * beatLen;
      if (vocal >= 0.5 && intensity >= 0.3 && swap - beatLen > S) {
        cues.push({ kind: 'echo-throw', target: cur.deck, atCtx: swap - beatLen, beats: 1, bpm, amount: intensity, reason: 'dernière syllabe du sortant dans l’écho' });
      }
      if (riserOk && genreChange && intensity >= 0.35 && beats >= 16) {
        const n = Math.min(8, Math.floor(beats / 2));
        cues.push({ kind: 'riser', target: 'master', atCtx: swap - n * beatLen, beats: n, bpm, amount: Math.round(intensity * 60) / 100, reason: 'montée discrète vers le nouveau style' });
      }
      if (profile.allowGate && intensity >= 0.6 && t === 'bass-swap' && beats >= 8) {
        cues.push({ kind: 'gate', target: 'master', atCtx: swap - 2 * beatLen, beats: 2, bpm, amount: intensity * 0.7, reason: 'stutter juste avant l’échange' });
      }
    } else if ((t === 'riser-drop' || t === 'loop-roll') && intensity >= 0.5) {
      cues.push({ kind: 'impact', target: 'master', atCtx: incomingStartCtx, beats: 1, bpm, amount: intensity * 0.8, reason: 'impact sur le drop de l’entrant' });
    } else if (t === 'cut' && genreChange && intensity >= 0.6) {
      cues.push({ kind: 'impact', target: 'master', atCtx: incomingStartCtx, beats: 1, bpm, amount: intensity * 0.6, reason: 'impact sur la coupe' });
    }
    return cues;
  }

  // ------------------------------------------------------------------ tempo de soirée et re-edit

  /**
   * Rampe de vitesse au début d'une phrase (jamais dans un drop, jamais pendant une transition ni dans les
   * 8 premiers temps du morceau) : amène le morceau vers le tempo de soirée, par pas de 2,5 % au plus.
   * Pendant un build, peut pousser de 1 % pour faire tomber le drop plus fort (la rampe finit avant le drop).
   */
  private maybeRate(input: BrainInput, out: BrainDecision[]): void {
    const s = this.s;
    const cur = s.current!;
    const d = input.decks[cur.deck];
    const profile = this.env.profile;
    const now = input.nowCtx;
    if (d.status !== 'playing' || !d.caps?.canSetRate || !d.live || input.activeTransition) return;
    const g = this.grid(d, cur, now);
    const prevStart = g.nextPhrase - now < 0.05 ? g.nextPhrase : g.nextPhrase - g.phraseLen;
    if (now < prevStart || now - prevStart > 1.5 * g.beatLen) return;
    const key = Math.round(prevStart * 4);
    if (key === s.lastRatePhrase) return;
    s.lastRatePhrase = key;
    if (prevStart < cur.startedCtx + 8 * g.beatLen || prevStart < cur.transitionEndCtx) return;
    const section = d.live.section;
    if (section === 'drop') return;
    const native = bpmOf({ track: cur.track, analysis: cur.analysis, genre: cur.genre });
    const target = this.env.targetBpm;
    let limit: number;
    if (cur.reEdit) limit = Math.min(d.caps.maxRateDelta, cur.reEdit.limit);
    else if (profile.followPartyTempo && isElectronic(cur.genre)) limit = Math.min(d.caps.maxRateDelta, RATE_LIMITS.normal);
    else return;
    let desired = partyRate(native, target, limit).rate;
    let push = false;
    if (section === 'build') {
      if (g.phraseBeats < 32) return;
      const fx = input.settings.fxAmount;
      if (fx > 0 && this.random() < profile.buildPushChance * fx * 2 && d.rate + 0.01 <= 1 + limit) { desired = d.rate + 0.01; push = true; }
    }
    const step = clamp(desired - d.rate, -0.025, 0.025);
    if (!push && Math.abs(step) < 0.004) return;
    const rate = Math.round((d.rate + step) * 10000) / 10000;
    const remaining = Math.floor((prevStart + g.phraseLen - now) / g.beatLen);
    let overBeats = push ? g.phraseBeats - 4 : Math.abs(step) > 0.012 && g.phraseBeats >= 32 ? 24 : 16;
    overBeats = Math.min(overBeats, remaining - 1);
    if (overBeats < 12) return;
    const from = native * d.rate * (cur.reEdit?.mult ?? partyRate(native, target, limit).mult);
    const to = (from * rate) / d.rate;
    const f1 = (x: number) => x.toFixed(1).replace('.', ',');
    const reason = push
      ? `On pousse le tempo de 1 % pendant la montée pour un drop plus fort (${f1(from)} -> ${f1(to)} BPM)`
      : `Tempo de soirée : ${f1(from)} -> ${f1(to)} BPM sur ${overBeats} temps (cible ${f1(target)})`;
    out.push({ type: 'rate', deck: cur.deck, rate, overBeats, reason });
    this.log(out, reason);
  }

  private startGroove(deck: DeckId, p: Planned, startCtx: number, bpm: number, out: BrainDecision[], reason: string): void {
    const ana = p.analysis ?? this.s.analyses.get(p.track.id);
    const wantBass = !!ana?.key && (ana.keyConfidence ?? 0) >= 0.6;
    const plan: GroovePlan = {
      style: p.reEdit!.style, bpm, anchorCtx: startCtx, key: ana?.key, bass: false, parts: ['kick', 'hat'],
      startCtx, fadeBeats: 16, sourceLowCutDb: -Math.round(10 + Math.min(8, p.reEdit!.pct * 40)), deck,
    };
    this.s.groove = { deck, plan, stage: 1, lastUpdateCtx: startCtx, wantBass };
    out.push({ type: 'groove-start', plan, reason });
    this.log(out, reason);
  }

  private stopGroove(atCtx: number, fadeBeats: number, out: BrainDecision[], reason?: string): void {
    if (!this.s.groove) return;
    out.push({ type: 'groove-stop', atCtx, fadeBeats });
    if (reason) this.log(out, reason);
    this.s.groove = undefined;
  }

  /**
   * À l'engagement d'une transition (avant son début). La table automatise l'eqLow de la platine
   * accompagnée pendant un groove : aucun groove-start/stop ne doit tomber pendant une transition.
   *  - morceau suivant en re-edit : groove démarré APRÈS la transition (ou relié, si un groove tourne déjà) ;
   *  - morceau suivant house : le groove tourne pendant la transition (pont), arrêté juste après ;
   *  - sinon : groove-stop placé pour finir de s'effacer avant le début de la transition.
   */
  private grooveAtTransition(now: number, plan: TransitionPlan, p: Planned, out: BrainDecision[]): void {
    const s = this.s;
    const beatLen = 60 / plan.bpm;
    if (p.reEdit) {
      s.pendingGroove = 'start';
      if (s.groove) this.log(out, `Le beat du re-edit continue pendant la transition, il passera sous ${trackName(p.track)}`);
      return;
    }
    if (!s.groove) return;
    if (isElectronic(p.genre)) {
      s.pendingGroove = 'stop-after';
      this.log(out, `Le beat du re-edit fait le pont vers ${label(p.genre)} pendant la transition`);
      return;
    }
    const lead = Math.floor((plan.startCtx - now) / beatLen - 0.25);
    const fade = clamp(lead, 0, 8);
    this.stopGroove(plan.startCtx - fade * beatLen, fade, out, `Fin du re-edit : le beat s’efface sur ${fade} temps avant la transition`);
  }

  /** Après la transition : démarre (ou relie) le groove du re-edit sur la phrase suivante, ou arrête le pont. */
  private grooveAfterTransition(input: BrainInput, incoming: Planned, out: BrainDecision[]): void {
    const s = this.s;
    const what = s.pendingGroove;
    s.pendingGroove = undefined;
    if (!what) return;
    const cur = s.current!;
    if (what === 'stop-after') {
      this.stopGroove(input.nowCtx, 8, out, `Le pont est fait : le beat du re-edit s'efface sous ${label(cur.genre)}`);
      return;
    }
    if (!incoming.reEdit) return;
    const d = input.decks[cur.deck];
    const g = this.grid(d, cur, input.nowCtx);
    let S = g.nextPhrase;
    while (S - input.nowCtx < 0.25) S += g.phraseLen;
    const relink = !!s.groove;
    this.startGroove(cur.deck, incoming, S, g.bpm, out, relink ? `Le beat continue sous ${trackName(cur.track)} ; ${incoming.reEdit.text}` : incoming.reEdit.text);
  }

  /** Une phrase après son entrée, le groove se construit : clap, charley ouvert, basse si la clé est sûre. */
  private grooveBuild(S: number, g: Grid, out: BrainDecision[]): void {
    const s = this.s;
    const gs = s.groove;
    if (!gs || gs.stage !== 1 || !s.current || gs.deck !== s.current.deck) return;
    if (S < gs.plan.startCtx + g.phraseLen - 0.5 * g.beatLen) return;
    const parts: GroovePlan['parts'] = ['kick', 'hat', 'clap', 'openhat', 'perc'];
    if (gs.wantBass) parts.push('bass');
    gs.plan = { ...gs.plan, parts, bass: gs.wantBass, startCtx: S, fadeBeats: 1 };
    gs.stage = 2;
    const reason = `Le groove se construit : clap et charley ouvert${gs.wantBass ? ', basse dans la tonalité' : ''} sur la phrase suivante`;
    out.push({ type: 'groove-start', plan: gs.plan, reason });
    this.log(out, reason);
  }

  /** Suit la phase et le tempo live de la platine accompagnée (au plus 2 fois par seconde). */
  private grooveFollow(input: BrainInput, out: BrainDecision[]): void {
    const s = this.s;
    const gs = s.groove;
    const cur = s.current;
    if (!gs || !cur || gs.deck !== cur.deck) return;
    const live = input.decks[cur.deck].live;
    if (!live || live.beatConfidence < BEAT_CONFIDENCE_MIN || live.bpm <= 0) return;
    const now = input.nowCtx;
    if (now - gs.lastUpdateCtx < 0.5) return;
    const bl = 60 / gs.plan.bpm;
    const k = Math.round((live.downbeatCtx - gs.plan.anchorCtx) / bl);
    const phase = live.downbeatCtx - (gs.plan.anchorCtx + k * bl);
    if (Math.abs(live.bpm - gs.plan.bpm) <= 0.05 && Math.abs(phase) < 0.01) return;
    gs.plan = { ...gs.plan, bpm: live.bpm, anchorCtx: live.downbeatCtx };
    gs.lastUpdateCtx = now;
    out.push({ type: 'groove-update', bpm: Math.round(live.bpm * 100) / 100, anchorCtx: live.downbeatCtx });
  }

  // ------------------------------------------------------------------ 6. effets en cours de morceau

  private maybeFx(input: BrainInput, g: Grid, S: number, cur: Current, out: BrainDecision[]): void {
    const s = this.s;
    const profile = this.env.profile;
    const fxAmount = input.settings.fxAmount;
    if (fxAmount <= 0 || s.running || input.activeTransition) return;
    const now = input.nowCtx;
    if (now - s.lastFxCtx < profile.fxEveryPhrases * g.phraseLen) return;
    const section = input.decks[cur.deck].live?.section ?? 'unknown';
    const peak = this.env.targetEnergy >= 0.85;
    const vocal = cur.analysis?.vocalness ?? 0;
    const allowed: FxKind[] = [];
    if (section === 'build') {
      allowed.push('low-cut', 'filter-sweep');
      if (profile.allowGate) allowed.push('gate');
      if (profile.allowRiser && (!profile.riserOnlyOnGenreChangeOrPeak || peak)) allowed.push('riser');
    } else if ((section === 'drop' || section === 'body') && vocal >= 0.4) allowed.push('echo-throw');
    else if (section === 'breakdown') allowed.push('reverb-throw');
    if (allowed.length === 0) return;
    const w: Partial<Record<FxKind, number>> = {};
    for (const k of allowed) if (profile.fxWeights[k]) w[k] = profile.fxWeights[k];
    const p = Math.min(0.9, profile.fxDensity * fxAmount * 2);
    if (this.random() >= p) return;
    const kind = weightedPick(w, this.random);
    if (!kind) return;
    let beats = 1;
    let reason = '';
    switch (kind) {
      case 'low-cut': beats = profile.id === 'paris-tech-house' && this.random() < 0.5 ? 8 : 4; reason = `basses coupées ${beats} temps avant le drop`; break;
      case 'filter-sweep': beats = 8; reason = 'balayage du filtre pendant la montée'; break;
      case 'gate': beats = this.random() < 0.5 ? 2 : 4; reason = 'stutter juste avant le drop'; break;
      case 'riser': beats = 8; reason = 'riser pour le moment fort'; break;
      case 'echo-throw': beats = 1; reason = 'fin de phrase vocale dans l’écho'; break;
      case 'reverb-throw': beats = 2; reason = 'fin du breakdown dans la réverb'; break;
      default: return;
    }
    const atCtx = S - beats * g.beatLen;
    if (atCtx < now + 0.05) return;
    if (atCtx < cur.startedCtx + 8 * g.beatLen || atCtx < cur.transitionEndCtx) return;
    const target: FxCue['target'] = kind === 'gate' || kind === 'riser' ? 'master' : cur.deck;
    const amount = Math.round(clamp(fxAmount * (0.4 + profile.fxDensity), 0.1, 1) * (kind === 'riser' ? 0.7 : 1) * 100) / 100;
    s.lastFxCtx = now;
    out.push({ type: 'fx', cue: { kind, target, atCtx, beats, bpm: g.bpm, amount, reason } });
    this.log(out, `Effet : ${reason}`);
  }
}

function describeTechnique(t: TransitionTechnique, beats: number): string {
  switch (t) {
    case 'long-blend': return `blend de ${beats} temps avec échange des basses sur le temps ${Math.floor(beats / 2) + 1}`;
    case 'bass-swap': return `bass swap sur ${beats} temps, basses échangées sur le 1 de la phrase suivante`;
    case 'filter-swap': return `filter swap sur ${beats} temps (passe-haut sur le sortant, l’entrant s’ouvre)`;
    case 'echo-out': return `echo-out sur ${beats} temps, l’entrant tombe sur le 1`;
    case 'cut': return 'coupe sèche sur le 1';
    case 'riser-drop': return `montée de ${beats} temps, un temps de silence, l’entrant tombe sur le drop`;
    case 'reverb-wash': return `le sortant se noie dans la réverb sur ${beats} temps`;
    case 'loop-roll': return `loop roll sur ${beats} temps puis drop de l’entrant`;
    case 'brake': return 'arrêt platine puis l’entrant';
  }
}

/** Plage de BPM demandée au catalogue : proche du BPM courant (±8 %, demi/double tempo), dans la plage du genre. */
export function bridgeRange(genre: Genre, ref: number): [number, number] {
  const [gmin, gmax] = GENRE_BPM[genre];
  for (const m of [1, 0.5, 2]) {
    const r = ref * m;
    const lo = Math.max(gmin, r * 0.92);
    const hi = Math.min(gmax, r * 1.08);
    if (lo <= hi) return [Math.floor(lo), Math.ceil(hi)];
  }
  return [gmin, gmax];
}

export function createBrain(opts?: { random?: () => number }): DjBrain {
  return new Brain(opts?.random ?? Math.random);
}
