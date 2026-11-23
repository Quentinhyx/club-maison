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
  Section, TrackAnalysis, TrackRef, TrackStructure, TransitionPlan, TransitionTechnique,
} from '../contracts';
import { GENRE_LABELS, RATE_LIMITS } from '../contracts';
import { GENRE_BPM, GENRE_GRAPH, genrePath, genrePathCost, isElectronic } from './genres';
import { checkReEdit, grooveStyleFor, partyRate, REEDIT_GENRES, type ReEditCheck } from './tempo';
import { harmonicScore } from './harmony';
import { energyAt, STYLE_PROFILES, targetBpmAt, type StyleProfile, type TransitionSituation } from './profiles';
import { artistKey, bpmOf, primaryGenre, scoreCandidate, tempoMatch, type CandidateInfo, type ScoreContext, type SkipMark } from './scoring';
import { chooseTechnique, needsSync, pickBeats, weightedPick } from './technique';

/** En dessous, la grille de temps du live n'est pas fiable : pas de calage, grille de l'analyse. */
export const BEAT_CONFIDENCE_MIN = 0.5;
/** Un son d'invité accepté passe au plus tard après ce délai, même s'il ne colle pas parfaitement. */
export const GUEST_MAX_WAIT_MS = 15 * 60 * 1000;
export const GUEST_FIT_SCORE = 0.55;
const WANT_GENRE_COOLDOWN_MS = 20_000;
/** La platine Deezer doit avoir le temps de charger : 'load' au moins 20 s avant la transition. */
export const MIN_LOAD_LEAD_S = 20;
/** Au plus un son d'ambiance toutes les ~4 minutes. */
export const STINGER_GAP_S = 240;
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
interface Planned extends Pick { deck: DeckId; startAt: number; reEdit?: ReEdit; reEditWanted?: boolean; loadedAtCtx: number; structureUsed?: boolean }
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
interface Grid { bpm: number; beatLen: number; phraseBeats: number; phraseLen: number; nextPhrase: number; reliable: boolean; fromStructure?: boolean }
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
  /** Zappages (« suivant ») : dernière valeur vue, avis négatifs, artistes exclus, genre à éviter. */
  lastSkipSeen?: number;
  skips: SkipMark[];
  bannedArtists: Map<string, number>;
  avoidGenre?: { genre: Genre; untilMs: number };
  /** Sons d'ambiance : dernier placé (budget ~4 min, jamais deux fois le même d'affilée). */
  lastStingerCtx: number;
  lastStingerKind?: FxKind;
  /** 'stop' différé : l'entrant n'est pas encore parti (la table boucle le sortant). */
  pendingStop?: DeckId;
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
export function chooseStartAt(track: TrackRef, genre: Genre | undefined, bpm: number, profile: StyleProfile, expectedPlay: number,
  analysis?: TrackAnalysis): number {
  if (profile.incomingEntry === 'hot' || usableStructure(analysis)) {
    // Profil « soirée » ou structure connue : on prépare l'entrée sur le moment fort (drop / refrain).
    const e = chooseEntryPoint({
      structure: usableStructure(analysis), kind: 'drop', duration: track.duration, bpm, genre, energy: analysis?.energy,
      hot: profile.incomingEntry === 'hot', longPlay: wantsLongPlay(profile, genre, track.duration), trackId: track.id,
    });
    if (e.pos >= 0) return e.pos;
  }
  if (!genre || isElectronic(genre)) return 0;
  if (track.duration < 120) return 0;
  const shortPlay = expectedPlay < 100 || profile.id === 'open-format' || profile.id === 'peak-time';
  if (!shortPlay) return 0;
  const intro = (16 * 60) / bpm;
  if (intro > track.duration * 0.15) return 0;
  return Math.round(intro * 1000) / 1000;
}

/** Structure utilisable (scan du morceau complet) : confiance >= 0,5. */
export const STRUCTURE_MIN_CONFIDENCE = 0.5;
export function usableStructure(a?: TrackAnalysis): TrackStructure | undefined {
  const st = a?.structure;
  return st && st.confidence >= STRUCTURE_MIN_CONFIDENCE && st.bpm > 0 ? st : undefined;
}

function sectionAt(st: TrackStructure, pos: number): Section | undefined {
  return st.sections.find((x) => x.startPos <= pos && pos < x.endPos)?.section;
}

function wantsLongPlay(profile: StyleProfile, genre: Genre | undefined, duration: number): boolean {
  const [a, b] = profile.playSeconds[genre ?? 'house'];
  return (a + b) / 2 >= 150 && duration >= 300;
}

/** Ce que l'entrant doit faire au moment où il entre, selon ce que fait le sortant. */
export type EntryKind = 'drop' | 'build' | 'rhythmic';

/**
 * Accord des sections : sortant en fin de drop/refrain (ou drop swap) -> entrant sur son drop ;
 * sortant en breakdown ou en montée -> entrant au début de SA montée (les deux tensions montent
 * ensemble, son drop tombe en fin de phrase) ; sortant en outro -> phrase rythmique (intro/couplet).
 * Couplet : drop dans le profil soirée, phrase rythmique sinon.
 */
export function entryKindFor(endSection: Section, dropSwap: boolean, hot: boolean): EntryKind {
  if (dropSwap) return 'drop';
  switch (endSection) {
    case 'drop': return 'drop';
    case 'breakdown': case 'build': return 'build';
    case 'outro': return 'rhythmic';
    default: return hot ? 'drop' : 'rhythmic';
  }
}

export interface EntryPointInput {
  structure?: TrackStructure;
  kind: EntryKind;
  duration: number;
  /** Tempo d'analyse (sert à l'heuristique sans structure). */
  bpm: number;
  genre?: Genre;
  energy?: number;
  /** Profil qui veut entrer sur un moment fort (soirée). */
  hot: boolean;
  /** Profil qui fait durer les morceaux : on prend le premier drop plutôt que le plus marquant. */
  longPlay: boolean;
  trackId: number;
}

/**
 * Point d'entrée dans le morceau entrant (s), toujours un début de phrase, borné à [0, durée - 60 s].
 *  - Structure connue : drop = dropPositions[0] (ou le premier drop si longPlay) ; montée = section
 *    'build' qui précède ce drop (sinon une phrase avant) ; rythmique = premier couplet ('body'),
 *    sinon intro. Alignement sur firstDownbeatPos + k × phraseBeats × 60/bpm.
 *  - Sans structure, profil « hot » (heuristique par genre, le morceau complet n'est pas analysé) :
 *    électronique : drop au temps 32 (morceau < 5 min) ou 64 ; montée 32 temps avant ; rythmique au temps 32.
 *    pop / rap / 80s / latino / R&B... : refrain vers 25-35 % de la durée, arrondi à 4 mesures ; montée
 *    16 temps avant ; rythmique vers 12 %. Genre inconnu et extrait énergique : 30 %. Jamais 0.
 *  - Sans structure, autre profil : -1 (on garde le point de départ du chargement).
 * En profil soirée, jamais la position 0, sauf si le morceau commence directement fort.
 */
export function chooseEntryPoint(o: EntryPointInput): { pos: number; label: string } {
  const maxPos = Math.max(0, o.duration - 60);
  const electro = isElectronic(o.genre);
  const dropWord = electro || !o.genre ? 'son drop' : 'son refrain';
  const labels: Record<EntryKind, string> = { drop: dropWord, build: 'sa montée', rhythmic: 'une phrase rythmique' };
  const st = o.structure;
  if (st) {
    const nb = 60 / st.bpm;
    const phrase = st.phraseBeats * nb;
    const align = (x: number, mode: 'round' | 'floor' = 'round') => {
      const k = (x - st.firstDownbeatPos) / phrase;
      return st.firstDownbeatPos + (mode === 'round' ? Math.round(k) : Math.floor(k + 1e-6)) * phrase;
    };
    const drops = st.dropPositions.filter((x) => x >= 0 && x <= maxPos);
    if (drops.length === 0) {
      const d = st.sections.find((x) => x.section === 'drop' && x.startPos <= maxPos);
      if (d) drops.push(d.startPos);
    }
    const drop = drops.length ? (o.longPlay ? Math.min(...drops) : drops[0]) : undefined;
    let pos: number;
    if (o.kind === 'drop' && drop !== undefined) pos = align(drop);
    else if (o.kind === 'build' && drop !== undefined) {
      const builds = st.sections.filter((x) => x.section === 'build' && x.startPos < drop);
      const b = builds.find((x) => Math.abs(x.endPos - drop) < phrase) ?? builds[builds.length - 1];
      pos = b ? align(b.startPos) : align(drop - phrase);
    } else {
      const body = st.sections.find((x) => x.section === 'body' && x.startPos <= maxPos);
      pos = body ? align(body.startPos) : st.firstDownbeatPos + (o.hot ? phrase : 0);
    }
    if (o.hot && pos < nb) {
      const first = st.sections[0];
      const strong = !!first && (first.section === 'drop' || first.section === 'body') && first.energy >= 0.7;
      if (!strong) pos = st.firstDownbeatPos + phrase;
    }
    while (pos > maxPos && pos - phrase >= 0) pos -= phrase;
    pos = Math.max(0, Math.min(pos, maxPos));
    return { pos: Math.round(pos * 1000) / 1000, label: labels[o.kind] };
  }
  if (!o.hot) return { pos: -1, label: labels[o.kind] };
  const nb = 60 / o.bpm;
  const bar4 = 16 * nb; // 4 mesures
  const roundTo = (x: number, q: number) => Math.round(x / q) * q;
  let drop: number;
  if (electro) drop = (o.duration >= 300 ? 64 : 32) * nb;
  else if (o.genre) drop = roundTo(o.duration * (0.25 + 0.1 * (((o.trackId * 7919) % 100) / 100)), bar4);
  else drop = (o.energy ?? 0) >= 0.7 ? roundTo(o.duration * 0.3, bar4) : 32 * nb;
  let pos: number;
  if (o.kind === 'drop') pos = drop;
  else if (o.kind === 'build') pos = drop - (electro ? 32 : 16) * nb;
  else pos = electro ? 32 * nb : roundTo(o.duration * 0.12, bar4);
  if (pos < bar4) pos = Math.min(bar4, maxPos);
  pos = Math.max(0, Math.min(pos, maxPos));
  return { pos: Math.round(pos * 1000) / 1000, label: labels[o.kind] };
}

function mmss(pos: number): string {
  const m = Math.floor(pos / 60);
  const s = Math.floor(pos % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
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
    lastRatePhrase: -Infinity, lastStingerCtx: -Infinity, tracksSinceReEdit: Infinity, reEditCount: 0, skips: [], bannedArtists: new Map(),
  };
}

class Brain implements DjBrain {
  private s: State = initialState();
  private random: () => number;
  private env!: TickEnv;
  private lastNow = 0;

  constructor(random: () => number) { this.random = random; }

  reset(): void { this.s = initialState(); }

  tick(input: BrainInput): BrainDecision[] {
    const s = this.s;
    const out: BrainDecision[] = [];
    this.lastNow = input.nowCtx;
    if (s.partyStartMs === undefined) { s.partyStartMs = input.nowMs; s.targetSince = input.nowMs; }
    this.ingest(input);
    this.env = this.makeEnv(input);
    this.adopt(input, out);
    const skip = input.skipRequestedAt;
    if (skip !== undefined && skip !== s.lastSkipSeen) {
      const first = s.lastSkipSeen === undefined && !s.current && !s.running;
      s.lastSkipSeen = skip;
      if (!first) this.handleSkip(input, out);
    }
    this.updateTarget(input, out);
    const step = this.computeStep(out);
    this.requests(input, step, out);

    if (s.running) {
      if (input.nowCtx >= s.running.endCtx) this.finish(input, out);
      else return out;
    }
    if (s.pendingStop && s.current && input.decks[s.current.deck].status === 'playing') {
      out.push({ type: 'stop', deck: s.pendingStop });
      s.pendingStop = undefined;
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
    // Les analyses arrivent souvent après le lancement ou le choix d'un morceau : on complète les
    // références figées pour que tempo, tonalité et voix reflètent l'analyse la plus récente.
    const s = this.s;
    if (s.current && !s.current.analysis) s.current.analysis = a.get(s.current.track.id);
    // (le morceau préparé est complété plus loin, là où le re-edit est réexaminé à l'arrivée de son analyse)
    if (s.running && !s.running.incoming.analysis) s.running.incoming.analysis = a.get(s.running.incoming.track.id);
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

  /** File vide et aucun vote : le public ne pilote pas, on continue dans le même registre. */
  private crowdIdle(input: BrainInput): boolean {
    if (input.queue.length > 0) return false;
    const w = Object.values(input.crowd.genreWeights ?? {}).reduce((a: number, x) => a + (x ?? 0), 0);
    return w < 0.3;
  }

  // ------------------------------------------------------------------ zappage (« suivant »)

  /**
   * Suivant demandé : sortie au plus vite (prochaine mesure, ou prochain temps si la mesure est à plus
   * de 3 s), technique courte, minPlaySeconds ignoré. Transition en cours : raccourcie, jamais doublée.
   * Puis avis négatif : artiste exclu 1 h, pénalité sur ce qui ressemble, changement de genre après
   * 2 zappages dans le même genre en moins de 10 min, morceau préparé remplacé s'il ressemble trop.
   */
  private handleSkip(input: BrainInput, out: BrainDecision[]): void {
    const s = this.s;
    const now = input.nowCtx;
    if (s.running) {
      const r = s.running;
      const bl = 60 / r.plan.bpm;
      const elapsed = Math.max(0, now - r.plan.startCtx);
      const nb = Math.max(2, Math.ceil(elapsed / bl) + 2);
      if (nb < r.plan.beats) {
        const end = r.plan.startCtx + nb * bl;
        const plan: TransitionPlan = {
          ...r.plan, beats: nb, incomingStartCtx: Math.min(r.plan.incomingStartCtx, end),
          accents: r.plan.accents.filter((a) => a.atCtx < end), reason: `${r.plan.reason} ; suivant demandé : transition raccourcie à ${nb} temps`,
        };
        r.plan = plan;
        r.endCtx = end;
        out.push({ type: 'transition', plan });
        this.log(out, `Suivant demandé pendant la transition : je la raccourcis à ${nb} temps`);
      } else this.log(out, 'Suivant demandé : la transition se termine déjà');
      return;
    }
    const cur = s.current;
    if (!cur) return;
    const genreChanged = this.rememberSkip(input, cur, out);
    // morceau préparé : remplacé s'il ressemble trop au zappé ou si rien n'est prêt
    const ctx = this.scoreCtx(input, s.target ?? input.settings.baseGenre);
    let p = s.planned;
    const resembles = (x: Planned) => {
      if (scoreCandidate({ ...this.info(x.track, x.genre, x.source, x.queueSource) }, { ...ctx, excludeIds: new Set() }).excluded) return true;
      const sk = s.skips[s.skips.length - 1];
      const e = x.analysis?.energy ?? 0.6;
      if (x.source !== 'candidate') return false;
      if (genreChanged && x.genre !== s.target) return true;
      return x.genre === sk.genre && Math.abs(e - sk.energy) < 0.12 && tempoMatch(sk.bpm, bpmOf(x)).pct < 0.04;
    };
    if (!p || resembles(p)) {
      // meilleur candidat déjà analysé (chargeable tout de suite)
      const analysed = { ...input, candidates: input.candidates.filter((c) => c.analysis || s.analyses.has(c.track.id)) };
      const next = (p ? undefined : this.pickFromQueue(input, ctx, out).pick) ?? this.pickCandidate(analysed, ctx);
      if (next && (!p || next.track.id !== p.track.id)) {
        const deck: DeckId = p?.deck ?? other(cur.deck);
        this.emitLoad(input, next, deck, 'Suivant demandé', out);
        p = s.planned;
      }
    }
    if (!p) { this.log(out, 'Suivant demandé, mais aucun morceau disponible pour enchaîner'); return; }
    p.reEdit = undefined;
    s.pendingGroove = undefined;
    const d = input.decks[cur.deck];
    const g = this.grid(d, cur, now);
    const bar = 4 * g.beatLen;
    let T = g.nextPhrase - Math.floor((g.nextPhrase - now) / bar) * bar;
    while (T - now < 0.15) T += bar;
    if (T - now > 3) {
      T = g.nextPhrase - Math.floor((g.nextPhrase - now) / g.beatLen) * g.beatLen;
      while (T - now < 0.1) T += g.beatLen;
    }
    const w: Partial<Record<TransitionTechnique, number>> = { 'echo-out': 3, cut: 2 };
    if (this.env.profile.allowGate || this.env.profile.rollWithoutGrid) w['loop-roll'] = 2;
    const technique = weightedPick(w, this.random) ?? 'echo-out';
    const beats = technique === 'cut' ? 1 : 4;
    const incomingStartCtx = technique === 'cut' ? T : T + beats * g.beatLen;
    const inAna = p.analysis ?? s.analyses.get(p.track.id);
    const hot = this.env.profile.incomingEntry === 'hot';
    const e = chooseEntryPoint({
      structure: usableStructure(inAna), kind: 'drop', duration: p.track.duration, bpm: bpmOf({ ...p, analysis: inAna }), genre: p.genre,
      energy: inAna?.energy, hot, longPlay: false, trackId: p.track.id,
    });
    this.stopGroove(now, 0, out);
    const techLabel = technique === 'cut' ? 'coupe sur le 1' : technique === 'loop-roll' ? 'loop-roll de 4 temps' : 'echo-out';
    const where = T - now > 3 ? 'le prochain temps' : 'la prochaine mesure';
    const accents: FxCue[] = technique === 'loop-roll'
      ? [{ kind: 'loop-roll', target: cur.deck, atCtx: T, beats, bpm: g.bpm, loopBeats: 1, amount: 0.7, reason: 'boucle qui raccourcit (suivant demandé)' }] : [];
    const plan: TransitionPlan = {
      id: this.planId(p), from: cur.deck, to: p.deck, technique, startCtx: T, beats, bpm: g.bpm,
      incomingStartCtx, incomingStartPos: e.pos >= 0 ? e.pos : p.startAt, incomingRate: 1, accents,
      intensity: Math.min(0.6, input.settings.fxAmount), preRollBeats: 0, holdWithLoop: true,
      reason: `Suivant demandé : sortie en ${techLabel} sur ${where}. Je m'éloigne de ${cur.track.artist}`,
    };
    this.commit(input, plan, p, true, out);
  }

  private rememberSkip(input: BrainInput, cur: Current, out: BrainDecision[]): boolean {
    const s = this.s;
    const nowMs = input.nowMs;
    s.bannedArtists.set(artistKey(cur.track), nowMs + 3600_000);
    s.skips.push({ atMs: nowMs, genre: cur.genre, artist: artistKey(cur.track), bpm: bpmOf(cur), energy: cur.analysis?.energy ?? 0.6 });
    s.skips = s.skips.filter((x) => nowMs - x.atMs < 3600_000);
    const sameGenre = s.skips.filter((x) => x.genre && x.genre === cur.genre && nowMs - x.atMs < 10 * 60000).length;
    if (cur.genre && sameGenre >= 2) {
      const blocked = this.env.blockedGenres;
      const neighbours = (Object.entries(GENRE_GRAPH[cur.genre]) as Array<[Genre, number]>)
        .filter(([g]) => !blocked.has(g)).sort((a, b) => a[1] - b[1]);
      const ng = neighbours[0]?.[0];
      if (ng) {
        s.avoidGenre = { genre: cur.genre, untilMs: nowMs + 20 * 60000 };
        s.target = ng;
        s.targetSince = nowMs;
        this.log(out, `${sameGenre} zappages en ${label(cur.genre)} en moins de 10 min : je change de registre vers ${label(ng)}`);
        return true;
      }
    }
    return false;
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
    // la table tient le sortant en boucle tant que l'entrant n'est pas réellement parti (holdWithLoop)
    if (d.track?.id === cur.track.id && (d.status === 'loading' || d.status === 'ready')) return;
    this.log(out, `Le morceau ${trackName(cur.track)} s'est arrêté (${d.status}) : on relance la suite`);
    this.stopGroove(input.nowCtx, 0, out);
    this.s.current = undefined;
    this.s.lastEvalS = -Infinity;
  }

  private pushArtist(t: TrackRef): void {
    this.s.artists.push(artistKey(t));
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
      } else if (total < 0.3) {
        // Personne ne vote : on reste dans le registre du morceau en cours (pas de dérive vers baseGenre),
        // sauf s'il vient d'être zappé deux fois (genre évité).
        const cg = s.current?.genre;
        const avoided = s.avoidGenre && input.nowMs < s.avoidGenre.untilMs ? s.avoidGenre.genre : undefined;
        desired = cg && cg !== avoided && !blocked.has(cg) ? cg : s.target ?? settings.baseGenre;
      }
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
      recentArtists6: s.artists.slice(-6),
      bannedArtists: s.bannedArtists,
      skips: s.skips,
      similarBonus: this.crowdIdle(input) ? 0.15 : 0.05,
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
        const info = { ...this.info(c.track, c.genre, 'candidate'), candidateSource: c.source };
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
    const cached = pl ? s.analyses.get(pl.track.id) : undefined;
    if (pl && cached && cached !== pl.analysis) {
      const first = !pl.analysis;
      pl.analysis = cached;
      if (first && pl.reEditWanted) pl.reEdit = this.checkPlannedReEdit(input, { ...pl, analysis: cached }, pl.deck, out);
    }
    if (pl && !pl.structureUsed && usableStructure(pl.analysis)) {
      // La structure arrive après le chargement : on recale le point de départ sur le vrai drop.
      pl.structureUsed = true;
      const bpm = bpmOf(pl);
      const range = this.env.profile.playSeconds[pl.genre ?? 'house'];
      const ns = chooseStartAt(pl.track, pl.genre, bpm, this.env.profile, (range[0] + range[1]) / 2, pl.analysis);
      if (Math.abs(ns - pl.startAt) > 60 / bpm) {
        pl.startAt = ns;
        pl.loadedAtCtx = input.nowCtx;
        const reason = `Structure reçue : ${trackName(pl.track)} préparé sur son drop (${mmss(ns)})`;
        out.push({ type: 'load', deck: pl.deck, track: pl.track, startAt: ns, reason });
        this.log(out, reason);
      }
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
    const analysis = pick.analysis ?? this.s.analyses.get(pick.track.id);
    const startAt = chooseStartAt(pick.track, pick.genre, bpm, profile, (range[0] + range[1]) / 2, analysis);
    const wanted = this.wantReEdit(pick);
    const reEdit = wanted && analysis ? this.checkPlannedReEdit(input, { ...pick, analysis }, deck, out) : undefined;
    this.s.planned = { ...pick, analysis, deck, startAt, reEdit, reEditWanted: wanted, loadedAtCtx: input.nowCtx, structureUsed: !!usableStructure(analysis) };
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
    // L'entrant se cale sur le sortant : on vérifie contre le tempo joué (ou le tempo de soirée à défaut).
    const target = this.refBpm(input) ?? this.env.targetBpm;
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
      preRollBeats: 0, holdWithLoop: true,
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
    if (r.hadOutgoing) {
      if (input.decks[r.plan.to].status === 'playing') out.push({ type: 'stop', deck: r.plan.from });
      else s.pendingStop = r.plan.from;
    }
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
    // Structure du morceau complet : sa grille + la position du lecteur suffisent.
    const st = usableStructure(cur.analysis ?? d.analysis);
    if (st) {
      const rate = d.rate || 1;
      const nb = 60 / st.bpm;
      const beatLen = nb / rate;
      const beatPos = (d.position - st.firstDownbeatPos) / nb;
      const pb = st.phraseBeats;
      const idx = Math.ceil(beatPos / pb - 1e-9) * pb;
      return { bpm: st.bpm * rate, beatLen, phraseBeats: pb, phraseLen: pb * beatLen, nextPhrase: now + (idx - beatPos) * beatLen, reliable: true, fromStructure: true };
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
    // Sections : structure réelle du morceau si connue, sinon live (ignoré si la grille n'est pas fiable :
    // on sort alors à la durée visée, sans attendre la fin du morceau).
    let endSection: Section = g.reliable ? d.live?.section ?? 'unknown' : 'unknown';
    let section: Section = endSection;
    let dropAhead = endSection === 'build';
    const st = usableStructure(cur.analysis);
    if (st) {
      const nb = 60 / st.bpm;
      const posS = d.position + (S - now) * rate;
      const ending = sectionAt(st, posS - nb / 2) ?? 'unknown';
      const next = sectionAt(st, posS + nb / 2);
      endSection = ending;
      section = ending;
      dropAhead = next === 'drop' && ending !== 'drop';
      if ((st.outroPos !== undefined && posS >= st.outroPos - nb) || next === 'outro') section = 'outro';
      else if (next === 'breakdown' && ending !== 'breakdown') section = 'breakdown';
    }
    let why: string | undefined;
    let dropSwap = false;
    const canExit = played >= settings.minPlaySeconds && S >= cur.transitionEndCtx + g.phraseLen * 0.99;
    if (forced) {
      why = S + g.phraseLen + estDur > hardEnd ? 'sortie forcée, fin du morceau proche' : 'sortie forcée, durée max atteinte';
    } else if (canExit) {
      why = exitReason(section, played / cur.playTarget);
      if (!why && dropAhead && profile.dropSwapChance > 0 && played / cur.playTarget >= 0.7
        && S - now >= 4.5 * g.beatLen && this.random() < profile.dropSwapChance) {
        why = 'drop swap : la tension monte sur le sortant et c’est l’entrant qui tombe sur le 1';
        dropSwap = true;
      }
    }
    if (why && p && isReady && !forced && S - p.loadedAtCtx < MIN_LOAD_LEAD_S) {
      this.logOnce(out, `lead:${p.track.id}:${p.loadedAtCtx}`, `On attend que ${trackName(p.track)} ait fini de charger`);
      why = undefined;
    }
    if (why && p && isReady && S < hardEnd) {
      const plan = this.buildPlan(input, g, S, prefEnd, hardEnd, cur, p, section, forced, why, endSection, dropSwap);
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
      preRollBeats: 0, holdWithLoop: true,
      reason: `Sortie d'urgence : ${trackName(cur.track)} se termine, coupe sèche vers ${trackName(p.track)}`,
    };
    this.commit(input, plan, p, true, out);
  }

  private buildPlan(input: BrainInput, g: Grid, S: number, prefEnd: number, hardEnd: number, cur: Current, p: Planned,
    section: Section, forced: boolean, exitWhy: string, endSection: Section = section, dropSwap = false): TransitionPlan {
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
    let startCtx = S;
    if (dropSwap) {
      // Drop swap : la tension (roll, riser) occupe la fin de la montée du sortant, l'entrant tombe sur le 1 en S.
      const w: Partial<Record<TransitionTechnique, number>> = { 'riser-drop': 2, 'echo-out': 1 };
      if (profile.allowGate && (g.reliable || profile.rollWithoutGrid)) w['loop-roll'] = 3;
      technique = weightedPick(w, this.random) ?? 'echo-out';
      const room = Math.floor((S - input.nowCtx) / beatLen - 0.5);
      beats = room >= 8 ? 8 : 4;
      startCtx = S - beats * beatLen;
    }
    const total = beats * beatLen;
    let incomingStartCtx: number;
    if (needsSync(technique) || technique === 'cut') incomingStartCtx = startCtx;
    else if (technique === 'reverb-wash') incomingStartCtx = startCtx + Math.max(1, Math.floor(beats / 2)) * beatLen;
    else incomingStartCtx = startCtx + total;

    // Point d'entrée de l'entrant : accorder sa section avec ce que fait le sortant.
    let incomingStartPos = p.startAt;
    let entryText = '';
    const inSt = usableStructure(inAna);
    const hot = profile.incomingEntry === 'hot';
    const canSeek = inDeck.caps?.canSeek !== false;
    const introBlend = technique === 'long-blend' && isElectronic(cur.genre) && isElectronic(p.genre) && !hot && !inSt;
    if (canSeek && !introBlend && (inSt || hot)) {
      const kind = entryKindFor(endSection, dropSwap, hot);
      const e = chooseEntryPoint({
        structure: inSt, kind, duration: p.track.duration, bpm: inBpm, genre: p.genre, energy: inAna?.energy, hot,
        longPlay: wantsLongPlay(profile, p.genre, p.track.duration), trackId: p.track.id,
      });
      if (e.pos >= 0) {
        incomingStartPos = e.pos;
        if (kind === 'drop' && needsSync(technique) && inSt) {
          // en fondu, le drop de l'entrant tombe sur l'échange des basses : on entre une phrase avant si possible
          const nb = 60 / inSt.bpm;
          const swapBeats = technique === 'bass-swap' ? beats : Math.floor(beats / 2);
          const ph = inSt.phraseBeats * nb;
          const k = Math.floor((e.pos - swapBeats * nb - inSt.firstDownbeatPos) / ph + 1e-6);
          const cand = inSt.firstDownbeatPos + k * ph;
          if (cand >= 0 && cand < e.pos) incomingStartPos = Math.round(cand * 1000) / 1000;
        }
        const outWord = isElectronic(cur.genre) || !cur.genre ? 'du drop' : 'du refrain';
        const outDesc = dropSwap ? 'la montée (drop swap)' : endSection === 'drop' ? `la fin ${outWord}`
          : endSection === 'breakdown' ? 'le breakdown' : endSection === 'build' ? 'la montée'
          : endSection === 'outro' ? 'l’outro' : endSection === 'body' ? 'la fin du couplet' : 'la fin de la phrase';
        entryText = `entrée sur ${e.label} de ${p.deck} (${mmss(e.pos)}) pendant ${outDesc} de ${cur.deck}`;
      }
    } else if (technique === 'long-blend' && incomingStartPos > 0 && canSeek && !inSt) {
      incomingStartPos = 0;
      entryText = `entrée sur l’intro de ${p.deck} pour un long fondu`;
    }
    // Re-edit : l'entrant démarre directement au tempo de sortie, quelle que soit la technique.
    const incomingRate = (needsSync(technique) || p.reEdit) && canRate ? clamp(tm.rate, 1 - maxDelta, 1 + maxDelta) : 1;
    // Après la transition : retour à 1 (rateRelaxBeats) sauf si le cerveau garde la main (tempo de soirée, re-edit).
    const keepRate = !!p.reEdit || (profile.followPartyTempo && isElectronic(p.genre));
    const peak = this.env.targetEnergy >= 0.85;
    let intensity = settings.fxAmount <= 0 ? 0
      : clamp(settings.fxAmount * (0.5 + profile.fxDensity) + (genreChange ? 0.15 : 0) + (peak ? 0.1 : 0), 0, profile.maxIntensity);
    intensity = Math.round(intensity * 100) / 100;
    const accents = this.accents(technique, cur, startCtx, beats, beatLen, outBpm, incomingStartCtx, intensity, genreChange, peak);
    const sting = this.transitionStinger(input, technique, cur, inAna, incomingStartCtx, beatLen, outBpm, beats);
    if (sting) accents.push(sting);
    let funny = false;
    if (technique === 'loop-roll') {
      // Vraie boucle (échantillonneur de la table) : un temps du sortant qui raccourcit jusqu'à 1/8.
      funny = this.random() < profile.funnyDropChance;
      accents.push({
        kind: 'loop-roll', target: cur.deck, atCtx: startCtx, beats: funny ? Math.max(1, beats - 1) : beats, bpm: outBpm, loopBeats: 1,
        amount: Math.max(0.5, intensity),
        reason: funny ? 'drop marrant : boucle d’un temps qui accélère jusqu’à 1/8, un temps de silence, puis l’entrant' : 'boucle qui raccourcit jusqu’au drop',
      });
    }

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
    const bridge = p.genre && this.s.target && p.genre !== this.s.target && this.s.path.includes(p.genre) ? ` (pont vers ${label(this.s.target)})` : '';
    const noGrid = g.reliable ? '' : ' ; grille de temps peu fiable, transition sans calage';
    const re = p.reEdit ? ` ; ${p.reEdit.text}` : '';
    const fun = funny ? ' ; drop marrant (boucle d’un temps jusqu’à 1/8, un temps de silence)' : '';
    const entry = entryText ? ` ; ${entryText}` : '';
    const reason = `${head}${bridge} : ${tempo}, ${harmony}, ${tech}${fun} ; ${exitWhy}${entry}${noGrid}${re}`;

    return {
      id: this.planId(p), from: cur.deck, to: p.deck, technique, startCtx, beats, bpm: outBpm,
      incomingStartCtx, incomingStartPos, incomingRate: Math.round(incomingRate * 10000) / 10000,
      preRollBeats: needsSync(technique) && beats >= 32 ? 16 : 8, holdWithLoop: true,
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
    this.stopGroove(plan.startCtx - (fade + 0.25) * beatLen, fade, out, `Fin du re-edit : le beat s’efface sur ${fade} temps avant la transition`);
  }

  /** Après la transition : démarre (ou relie) le groove du re-edit sur la phrase suivante, ou arrête le pont. */
  private grooveAfterTransition(input: BrainInput, incoming: Planned, out: BrainDecision[]): void {
    const s = this.s;
    const what = s.pendingGroove;
    s.pendingGroove = undefined;
    if (!what) return;
    const cur = s.current!;
    if (what === 'stop-after') {
      // le fondu doit finir avant la prochaine phrase (une sortie forcée pourrait y commencer)
      const gg = this.grid(input.decks[cur.deck], cur, input.nowCtx);
      let S0 = gg.nextPhrase;
      while (S0 - input.nowCtx < 0.25) S0 += gg.phraseLen;
      const fade = clamp(Math.floor((S0 - input.nowCtx) / gg.beatLen - 0.25), 0, 8);
      this.stopGroove(input.nowCtx, fade, out, `Le pont est fait : le beat du re-edit s'efface sous ${label(cur.genre)}`);
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

  // ------------------------------------------------------------------ sons d'ambiance (stingers)

  /** Un son d'ambiance est-il permis maintenant ? Profil soirée / peak-time, réglage hôte, budget ~4 min,
   *  jamais deux fois le même d'affilée, jamais sur un morceau calme. */
  private stingerOk(input: BrainInput, kind: FxKind, energy: number | undefined): boolean {
    const s = this.s;
    if (input.settings.stingers === false || !this.env.profile.stingers) return false;
    if (input.nowCtx - s.lastStingerCtx < STINGER_GAP_S) return false;
    if (s.lastStingerKind === kind) return false;
    return (energy ?? 0.6) >= 0.55;
  }

  private markStinger(kind: FxKind): void {
    this.s.lastStingerCtx = this.lastNow;
    this.s.lastStingerKind = kind;
  }

  private pickStinger(input: BrainInput, kinds: Array<[FxKind, number]>, energy: number | undefined): FxKind | undefined {
    const w: Partial<Record<FxKind, number>> = {};
    for (const [k, v] of kinds) if (this.stingerOk(input, k, energy)) w[k] = v;
    return weightedPick(w, this.random);
  }

  /** Accent de transition : airhorn sur le drop de l'entrant (riser-drop / loop-roll), scratch avant le 1, siren sur le riser. */
  private transitionStinger(input: BrainInput, t: TransitionTechnique, cur: Current, inAna: TrackAnalysis | undefined,
    incomingStartCtx: number, beatLen: number, bpm: number, beats: number): FxCue | undefined {
    if (needsSync(t) || !['riser-drop', 'loop-roll', 'cut', 'echo-out'].includes(t)) return undefined; // jamais pendant un fondu
    if (this.random() >= 0.6) return undefined;
    const energy = Math.min(inAna?.energy ?? 0.6, cur.analysis?.energy ?? 0.6);
    const kinds: Array<[FxKind, number]> = t === 'cut' || t === 'echo-out' ? [['scratch', 1]]
      : t === 'riser-drop' ? [['airhorn', 2], ['siren', 1], ['scratch', 1]] : [['airhorn', 2], ['scratch', 1]];
    const kind = this.pickStinger(input, kinds, energy);
    if (!kind) return undefined;
    this.markStinger(kind);
    if (kind === 'airhorn') return { kind, target: 'master', atCtx: incomingStartCtx, beats: 2, bpm, amount: 0.7, reason: 'airhorn sur le drop de l’entrant' };
    if (kind === 'siren') {
      const n = Math.min(8, Math.max(4, beats));
      return { kind, target: 'master', atCtx: incomingStartCtx - n * beatLen, beats: n, bpm, amount: 0.5, reason: 'sirène sur la montée, jusqu’au 1' };
    }
    return { kind, target: 'master', atCtx: incomingStartCtx - 2 * beatLen, beats: 2, bpm, amount: 0.6, reason: 'scratch juste avant le 1' };
  }

  /** En cours de morceau, pendant une montée : sirène qui finit sur le 1, scratch juste avant, ou airhorn sur le drop. */
  private midTrackStinger(input: BrainInput, g: Grid, S: number, cur: Current, out: BrainDecision[]): boolean {
    if (this.random() >= 0.35) return false;
    const st = usableStructure(cur.analysis);
    const d = input.decks[cur.deck];
    let dropAtS = true;
    if (st) dropAtS = sectionAt(st, d.position + (S - input.nowCtx) * (d.rate || 1) + 60 / st.bpm / 2) === 'drop';
    const kinds: Array<[FxKind, number]> = [['siren', 1], ['scratch', 1]];
    if (dropAtS) kinds.push(['airhorn', 1.5]);
    const kind = this.pickStinger(input, kinds, cur.analysis?.energy);
    if (!kind) return false;
    const beats = kind === 'siren' ? 8 : 2;
    const atCtx = kind === 'airhorn' ? S : S - beats * g.beatLen;
    if (atCtx < input.nowCtx + 0.05 || atCtx < cur.startedCtx + 8 * g.beatLen || atCtx < cur.transitionEndCtx) return false;
    const amount = kind === 'airhorn' ? 0.7 : kind === 'siren' ? 0.5 : 0.6;
    const reason = kind === 'airhorn' ? 'airhorn sur le 1 du drop' : kind === 'siren' ? 'sirène pendant la montée, jusqu’au drop' : 'scratch sur les deux derniers temps avant le drop';
    this.markStinger(kind);
    this.s.lastFxCtx = input.nowCtx;
    out.push({ type: 'fx', cue: { kind, target: 'master', atCtx, beats, bpm: g.bpm, amount, reason } });
    this.log(out, `Son d'ambiance : ${reason}`);
    return true;
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
    if (section === 'build' && g.reliable && this.midTrackStinger(input, g, S, cur, out)) return;
    const peak = this.env.targetEnergy >= 0.85;
    const vocal = cur.analysis?.vocalness ?? 0;
    const allowed: FxKind[] = [];
    if (section === 'build') {
      allowed.push('low-cut', 'filter-sweep', 'loop-roll');
      if (profile.allowGate) allowed.push('gate');
      if (profile.allowRiser && (!profile.riserOnlyOnGenreChangeOrPeak || peak)) allowed.push('riser');
    } else if (section === 'drop' || section === 'body') {
      allowed.push('loop');
      if (vocal >= 0.4) allowed.push('echo-throw');
    } else if (section === 'breakdown') allowed.push('reverb-throw');
    if (allowed.length === 0) return;
    const w: Partial<Record<FxKind, number>> = {};
    for (const k of allowed) if (profile.fxWeights[k]) w[k] = profile.fxWeights[k];
    const p = Math.min(0.9, profile.fxDensity * fxAmount * 2);
    if (this.random() >= p) return;
    if (!g.reliable) { delete w.loop; delete w['loop-roll']; delete w.gate; } // boucles seulement sur une grille sûre
    const kind = weightedPick(w, this.random);
    if (!kind) return;
    let beats = 1;
    let reason = '';
    let loopBeats: number | undefined;
    switch (kind) {
      case 'loop': loopBeats = this.random() < 0.5 ? 1 : 2; beats = loopBeats * 2; reason = `petit bégaiement : boucle de ${loopBeats} temps sur la fin de la phrase`; break;
      case 'loop-roll': loopBeats = 1; beats = 4; reason = 'boucle qui raccourcit juste avant le drop'; break;
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
    out.push({ type: 'fx', cue: { kind, target, atCtx, beats, bpm: g.bpm, amount, reason, ...(loopBeats ? { loopBeats } : {}) } });
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
