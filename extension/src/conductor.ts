/**
 * Chef d'orchestre : relie le cerveau DJ (shared/brain), la table de mixage (shared/audio), les deux
 * platines (Deezer, extraits ou morceaux synthétiques), l'analyse et l'API des invités.
 *
 * Aucune dépendance au navigateur ici : tout passe par `ConductorDeps`, ce qui permet de tester la
 * logique avec tsx (voir conductor.test.ts). La boucle tourne à ~10 Hz (`tick`).
 */
import type {
  BrainDecision,
  BrainInput,
  CrowdState,
  DeckController,
  DeckId,
  DeckState,
  DjBrain,
  DjSettings,
  FxCue,
  Genre,
  GuestRequest,
  LiveAnalysis,
  NowPlaying,
  ParamTarget,
  PlayedTrack,
  QueueItem,
  TrackAnalysis,
  TrackRef,
  TransitionPlan,
  AutomationLane,
  GroovePlan,
  GrooveStyle,
} from '../../shared/contracts';
import type { GuestApiLike } from './lib/guestApi';

export const DECK_IDS: DeckId[] = ['A', 'B'];
export const other = (d: DeckId): DeckId => (d === 'A' ? 'B' : 'A');

export interface MixerLike {
  setParam(t: ParamTarget, v: number): void;
  getParam(t: ParamTarget): number;
  cancelFrom(ctxTime: number): void;
  runTransition(plan: TransitionPlan): AutomationLane[];
  fx(cue: FxCue): AutomationLane[];
  getLevels(): { A: number; B: number; master: number };
  setTempo?(bpm: number): void;
  // re-edit (boîte à rythmes calée sur une platine), optionnel selon la version de la table
  startGroove?(plan: GroovePlan): AutomationLane[];
  updateGroove?(bpm: number, anchorCtx: number): void;
  stopGroove?(atCtx: number, fadeBeats: number): AutomationLane[];
  getGrooveState?(): { running: boolean; style?: GrooveStyle; bpm?: number; beat?: number };
}

export type RateRampFn = (from: number, to: number, startCtx: number, overBeats: number, bpm: number, steps?: number) => Array<{ t: number; rate: number }>;

/** Rampe de vitesse par paliers (repli si shared/audio ne fournit pas rateRamp). */
export const defaultRateRamp: RateRampFn = (from, to, startCtx, overBeats, bpm, steps) => {
  const spb = 60 / (bpm > 0 ? bpm : 120);
  const n = Math.max(1, steps ?? Math.max(1, Math.min(32, Math.round(overBeats * 2))));
  const out: Array<{ t: number; rate: number }> = [];
  for (let i = 1; i <= n; i++) out.push({ t: startCtx + (i / n) * overBeats * spb, rate: from + ((to - from) * i) / n });
  return out;
};

export interface AnalyzerLike {
  getState(): LiveAnalysis | undefined;
  reset(bpmHint?: number): void;
  setTrackPosition?(pos: number, atCtx: number, duration?: number): void;
}

export type PhaseNudgeFn = (a: {
  bpm: number;
  refDownbeatCtx: number;
  deckDownbeatCtx: number;
  nowCtx: number;
  maxDelta: number;
  currentRate: number;
}) => { rate: number; errorBeats: number };

export interface ConductorDeps {
  /** Temps du contexte audio (s). */
  nowCtx(): number;
  nowMs(): number;
  mixer: MixerLike;
  decks: Record<DeckId, DeckController>;
  analyzers: Record<DeckId, AnalyzerLike>;
  brain: DjBrain;
  settings: DjSettings;
  /** Candidats pour un genre (catalogue Deezer ou morceaux démo). */
  catalog(genre: Genre, opts: { bpmMin?: number; bpmMax?: number; limit?: number }): Promise<TrackRef[]>;
  analyze(track: TrackRef): Promise<TrackAnalysis>;
  cachedAnalysis?(id: number): TrackAnalysis | undefined;
  phaseNudge?: PhaseNudgeFn;
  rateRamp?: RateRampFn;
  guestApi?: GuestApiLike | null;
  /** Morceaux de secours si plus rien n'est prêt. */
  fallbackTracks?(): TrackRef[] | Promise<TrackRef[]>;
  /** Latence de démarrage de la platine (s) entre play() et le son effectivement capté. */
  startLatency?(deck: DeckId): number;
  /** Retard du son capté par rapport à la position rapportée par la platine (s). */
  outputLatency?(deck: DeckId): number;
  timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
  tickMs?: number;
  guestPollMs?: number;
  maxAnalysisConcurrency?: number;
}

export type LogLevel = 'info' | 'brain' | 'warn' | 'error';
export interface LogEntry { t: number; level: LogLevel; msg: string }

export type TransitionPhase = 'scheduled' | 'running' | 'relaxing';
export interface TransitionView {
  plan: TransitionPlan;
  phase: TransitionPhase;
  endCtx: number;
  playAtCtx: number;
}

export interface ActiveFx { cue: FxCue; endCtx: number }

export interface GrooveView { plan: GroovePlan; stopAtCtx?: number; endCtx?: number }

export interface ConductorSnapshot {
  running: boolean;
  autopilot: boolean;
  decks: Record<DeckId, DeckState>;
  onAir: DeckId | null;
  queue: QueueItem[];
  guestNames: Record<string, string>;
  transition?: TransitionView;
  activeFx: ActiveFx[];
  logs: LogEntry[];
  crowd: CrowdState;
  candidates: number;
  analyzing: number;
  history: PlayedTrack[];
  guest: { configured: boolean; ok: boolean; lastError?: string; lastOkMs?: number };
  currentGenre?: Genre;
  groove?: GrooveView;
  baseRate: Record<DeckId, number>;
}

export function defaultCrowd(): CrowdState {
  return {
    genreWeights: {},
    energy: 0,
    requests: [],
    host: { blockedGenres: [], blockedTrackIds: [], votesOpen: true, requestsOpen: true, maxRequestsPerGuest: 3 },
    updatedAt: 0,
  };
}

interface RunningTransition {
  plan: TransitionPlan;
  lanes: AutomationLane[];
  phase: TransitionPhase;
  playAtCtx: number;
  seekTo?: number;
  playIssued: boolean;
  startedHistory: boolean;
  endCtx: number;
  relaxEndCtx: number;
  outgoingStopped: boolean;
  playTimer?: unknown;
}

const PREROLL_BEATS = 8;
const TAIL_SECONDS = 4;
const SILENCE_LIMIT = 3;

export class Conductor {
  private d: ConductorDeps;
  private settings: DjSettings;
  private running = false;
  private autopilot = true;
  private loop?: ReturnType<typeof setInterval>;
  private queue: QueueItem[] = [];
  private guestNames: Record<string, string> = {};
  private candidates = new Map<number, { track: TrackRef; analysis?: TrackAnalysis; genre: Genre }>();
  private analyses = new Map<number, TrackAnalysis>();
  private analysisFailed = new Set<number>();
  private analysisQueue: TrackRef[] = [];
  private analysisInflight = new Set<number>();
  private genreRequests = new Map<string, number>(); // clé genre:bpm -> nowMs
  private history: PlayedTrack[] = [];
  private crowd: CrowdState = defaultCrowd();
  private tr?: RunningTransition;
  private activeFx: ActiveFx[] = [];
  private logs: LogEntry[] = [];
  private loading: Partial<Record<DeckId, number>> = {}; // trackId en cours de chargement
  private deckGenre: Partial<Record<DeckId, Genre>> = {};
  private readySince: Partial<Record<DeckId, number>> = {};
  private silentSince?: number;
  private lastGuestPoll = -Infinity;
  private guestStatus: ConductorSnapshot['guest'];
  private seenRequests = new Set<string>();
  private playedRequests = new Set<string>();
  private emergencyAt = -Infinity;
  private currentGenre?: Genre;
  private listeners = new Set<() => void>();
  private lastRateSent: Partial<Record<DeckId, number>> = {};
  /** Vitesse de base de chaque platine (calage de tempo, rampes) ; le calage de phase se fait autour. */
  private baseRate: Record<DeckId, number> = { A: 1, B: 1 };
  private ramps: Array<{ deck: DeckId; t: number; rate: number }> = [];
  private groove?: GrooveView;

  constructor(deps: ConductorDeps) {
    this.d = deps;
    this.settings = { ...deps.settings };
    this.guestStatus = { configured: !!deps.guestApi, ok: false };
    for (const id of DECK_IDS) {
      deps.decks[id].on((e) => {
        if (e.type === 'status' && e.status === 'error') {
          this.log('error', `Platine ${id} en erreur : ${e.error ?? 'raison inconnue'}`);
        }
      });
    }
  }

  // ------------------------------------------------------------------------------- cycle de vie

  start(): void {
    if (this.running) return;
    this.running = true;
    this.log('info', 'Soirée lancée. Le pilote automatique prend les platines.');
    const ms = this.d.tickMs ?? 100;
    this.loop = setInterval(() => this.tick(), ms);
  }

  stop(): void {
    this.running = false;
    if (this.loop) clearInterval(this.loop);
    this.loop = undefined;
    for (const id of DECK_IDS) void this.d.decks[id].pause().catch(() => {});
    this.cancelTransition('arrêt de la soirée');
    this.log('info', 'Soirée en pause.');
  }

  isRunning(): boolean {
    return this.running;
  }

  setAutopilot(on: boolean): void {
    if (this.autopilot === on) return;
    this.autopilot = on;
    if (!on) {
      this.cancelTransition('tu as repris la main');
      this.log('warn', 'Pilote automatique coupé : les commandes sont à toi.');
    } else {
      this.d.brain.reset();
      this.log('info', 'Pilote automatique réactivé.');
    }
  }

  setSettings(s: Partial<DjSettings>): void {
    this.settings = { ...this.settings, ...s };
  }

  getSettings(): DjSettings {
    return { ...this.settings };
  }

  setGuestApi(api: GuestApiLike | null): void {
    this.d.guestApi = api;
    this.guestStatus = { configured: !!api, ok: false };
    this.lastGuestPoll = -Infinity;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ------------------------------------------------------------------------------- file d'attente

  addToQueue(track: TrackRef, source: QueueItem['source'] = 'host', extra?: Partial<QueueItem>): void {
    if (this.queue.some((q) => q.track.id === track.id)) return;
    this.queue.push({ track, source, addedAt: this.d.nowMs(), ...extra });
    this.enqueueAnalysis(track, true);
    this.emit();
  }

  removeFromQueue(trackId: number): void {
    this.queue = this.queue.filter((q) => q.track.id !== trackId);
    this.emit();
  }

  moveInQueue(trackId: number, delta: number): void {
    const i = this.queue.findIndex((q) => q.track.id === trackId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.queue.length) return;
    const [it] = this.queue.splice(i, 1);
    this.queue.splice(j, 0, it);
    this.emit();
  }

  async answerRequest(req: GuestRequest, accept: boolean): Promise<void> {
    const api = this.d.guestApi;
    if (!api) return;
    try {
      await api.setRequestStatus(req.id, accept ? 'accepted' : 'rejected');
      if (accept) this.acceptRequest(req);
      this.log('info', `${accept ? 'Demande acceptée' : 'Demande refusée'} : ${req.track.title} (${req.guestName ?? 'invité'})`);
    } catch (e) {
      this.log('warn', `Réponse à la demande impossible : ${errMsg(e)}`);
    }
  }

  // ------------------------------------------------------------------------------- commandes manuelles

  async manualLoad(deck: DeckId, track: TrackRef): Promise<void> {
    await this.loadDeck(deck, track, 0, 'chargé à la main');
  }

  async manualPlay(deck: DeckId): Promise<void> {
    await this.d.decks[deck].play().catch((e) => this.log('error', `Lecture ${deck} : ${errMsg(e)}`));
    this.markStarted(deck);
  }

  async manualPause(deck: DeckId): Promise<void> {
    await this.d.decks[deck].pause().catch(() => {});
    this.markEnded(deck);
  }

  // ------------------------------------------------------------------------------- lecture d'état

  getAnalysis(id: number): TrackAnalysis | undefined {
    return this.analyses.get(id) ?? this.d.cachedAnalysis?.(id);
  }

  deckStates(): Record<DeckId, DeckState> {
    const out = {} as Record<DeckId, DeckState>;
    for (const id of DECK_IDS) {
      const s = this.d.decks[id].getState();
      const analysis = s.analysis ?? (s.track ? this.getAnalysis(s.track.id) : undefined);
      const live = s.status === 'playing' ? this.d.analyzers[id].getState() : undefined;
      out[id] = { ...s, analysis, live: live ?? s.live };
    }
    return out;
  }

  /** Platine qu'on entend (en lecture, gain le plus fort). */
  onAir(states = this.deckStates()): DeckId | null {
    let best: DeckId | null = null;
    let bestGain = 0.05;
    for (const id of DECK_IDS) {
      if (states[id].status !== 'playing') continue;
      const g = safeParam(this.d.mixer, `${id}.gain` as ParamTarget, 1);
      if (g > bestGain) {
        bestGain = g;
        best = id;
      }
    }
    return best;
  }

  getTransition(): TransitionView | undefined {
    const tr = this.tr;
    return tr ? { plan: tr.plan, phase: tr.phase, endCtx: tr.endCtx, playAtCtx: tr.playAtCtx } : undefined;
  }

  getActiveFx(): ActiveFx[] {
    return this.activeFx;
  }

  getGroove(): GrooveView | undefined {
    return this.groove;
  }

  getBaseRate(id: DeckId): number {
    return this.baseRate[id];
  }

  isAutopilot(): boolean {
    return this.autopilot;
  }

  getSnapshot(): ConductorSnapshot {
    const decks = this.deckStates();
    return {
      running: this.running,
      autopilot: this.autopilot,
      decks,
      onAir: this.onAir(decks),
      queue: [...this.queue],
      guestNames: { ...this.guestNames },
      transition: this.getTransition(),
      activeFx: [...this.activeFx],
      logs: this.logs,
      crowd: this.crowd,
      candidates: this.candidates.size,
      analyzing: this.analysisInflight.size + this.analysisQueue.length,
      history: [...this.history],
      guest: { ...this.guestStatus },
      currentGenre: this.currentGenre,
      groove: this.groove,
      baseRate: { ...this.baseRate },
    };
  }

  // ------------------------------------------------------------------------------- boucle

  tick(): void {
    const now = this.d.nowCtx();
    const nowMs = this.d.nowMs();
    try {
      this.pumpAnalysis();
      this.activeFx = this.activeFx.filter((f) => f.endCtx > now);
      const states = this.deckStates();
      for (const id of DECK_IDS) {
        const st = states[id];
        if (st.status === 'playing') this.d.analyzers[id].setTrackPosition?.(st.position, now, st.duration || undefined);
      }
      this.trackReady(states, nowMs);
      if (this.running) {
        this.driveTransition(now, states);
        this.driveFx(now, states);
        this.applyRamps(now, states);
        this.keepTempo(nowMs, states);
        if (this.autopilot) {
          const decisions = this.callBrain(now, nowMs, states);
          for (const dec of decisions) this.execute(dec, now);
          this.watchdog(now, nowMs, this.deckStates());
        }
        if (nowMs - this.lastGuestPoll >= (this.d.guestPollMs ?? 3000)) {
          this.lastGuestPoll = nowMs;
          void this.pollGuests();
        }
      }
    } catch (e) {
      this.log('error', `Erreur dans la boucle : ${errMsg(e)}`);
    }
    this.emit();
  }

  private callBrain(now: number, nowMs: number, decks: Record<DeckId, DeckState>): BrainDecision[] {
    const input: BrainInput = {
      nowCtx: now,
      nowMs,
      decks,
      queue: this.queue,
      candidates: [...this.candidates.values()]
        .filter((c) => !this.isUsed(c.track.id))
        .map((c) => ({ ...c, analysis: c.analysis ?? this.getAnalysis(c.track.id) })),
      crowd: this.crowd,
      settings: this.settings,
      history: this.history,
      activeTransition: this.tr?.plan,
    };
    // toutes les analyses connues (file, candidats, platines) : le cerveau juge ainsi les re-edits avant chargement
    const analyses: Record<number, TrackAnalysis> = {};
    for (const [id, a] of this.analyses) analyses[id] = a;
    for (const q of this.queue) {
      const a = this.getAnalysis(q.track.id);
      if (a) analyses[q.track.id] = a;
    }
    for (const id of DECK_IDS) {
      const a = decks[id].analysis;
      if (a) analyses[a.trackId] = a;
    }
    (input as BrainInput & { analyses?: Record<number, TrackAnalysis> }).analyses = analyses;
    try {
      return this.d.brain.tick(input) ?? [];
    } catch (e) {
      this.log('error', `Le cerveau a planté : ${errMsg(e)}`);
      return [];
    }
  }

  private isUsed(id: number): boolean {
    if (this.history.some((h) => h.track.id === id)) return true;
    if (this.queue.some((q) => q.track.id === id)) return true;
    for (const d of DECK_IDS) if (this.d.decks[d].getState().track?.id === id) return true;
    return false;
  }

  // ------------------------------------------------------------------------------- décisions

  execute(dec: BrainDecision, now = this.d.nowCtx()): void {
    switch (dec.type) {
      case 'log':
        this.log('brain', dec.message);
        break;
      case 'want-genre':
        this.wantGenre(dec.genre, dec.bpmMin, dec.bpmMax, dec.reason);
        break;
      case 'analyze':
        this.enqueueAnalysis(dec.track, true);
        break;
      case 'load':
        if (this.tr && this.tr.phase === 'scheduled') {
          this.cancelTransition('nouveau morceau choisi, transition replanifiée');
        }
        if (this.tr && this.tr.plan.from === dec.deck && this.tr.phase !== 'relaxing') {
          this.log('warn', `Chargement ignoré sur ${dec.deck} : elle joue encore la sortie.`);
          break;
        }
        void this.loadDeck(dec.deck, dec.track, dec.startAt, dec.reason);
        break;
      case 'transition':
        this.startTransition(dec.plan, now);
        break;
      case 'fx':
        try {
          this.d.mixer.fx(dec.cue);
          this.activeFx.push({ cue: dec.cue, endCtx: dec.cue.atCtx + (dec.cue.beats * 60) / dec.cue.bpm });
        } catch (e) {
          this.log('warn', `Effet ${dec.cue.kind} impossible : ${errMsg(e)}`);
        }
        break;
      case 'stop': {
        void this.d.decks[dec.deck].pause().catch(() => {});
        this.markEnded(dec.deck);
        break;
      }
      case 'rate':
        this.scheduleRate(dec.deck, dec.rate, dec.overBeats, now, dec.reason);
        break;
      case 'groove-start':
        try {
          this.d.mixer.startGroove?.(dec.plan);
          this.groove = { plan: dec.plan };
          if (!this.d.mixer.startGroove) this.log('warn', 'La table ne sait pas encore jouer de groove (version de shared/audio).');
        } catch (e) {
          this.log('warn', `Groove impossible : ${errMsg(e)}`);
        }
        break;
      case 'groove-update':
        try {
          this.d.mixer.updateGroove?.(dec.bpm, dec.anchorCtx);
          if (this.groove) this.groove = { ...this.groove, plan: { ...this.groove.plan, bpm: dec.bpm, anchorCtx: dec.anchorCtx } };
        } catch {
          /* rien */
        }
        break;
      case 'groove-stop':
        try {
          this.d.mixer.stopGroove?.(dec.atCtx, dec.fadeBeats);
        } catch {
          /* rien */
        }
        if (this.groove) {
          const spb = 60 / this.groove.plan.bpm;
          this.groove = { ...this.groove, stopAtCtx: dec.atCtx, endCtx: dec.atCtx + dec.fadeBeats * spb };
        }
        break;
      case 'consume-queue': {
        const it = this.queue.find((q) => q.track.id === dec.trackId);
        this.queue = this.queue.filter((q) => q.track.id !== dec.trackId);
        if (it?.requestId) this.markRequestPlayed(it.requestId);
        break;
      }
    }
  }

  private scheduleRate(deck: DeckId, rate: number, overBeats: number, now: number, _reason: string): void {
    const st = this.d.decks[deck].getState();
    if (!st.caps.canSetRate) {
      this.log('warn', `Platine ${deck} : vitesse non réglable, calage ignoré.`);
      return;
    }
    let target = rate;
    const lim = st.caps.maxRateDelta;
    if (Math.abs(target - 1) > lim + 1e-9) {
      target = clamp(target, 1 - lim, 1 + lim);
      this.log('warn', `Platine ${deck} : vitesse ${fmtRate(rate)} demandée, bornée à ${fmtRate(target)} (limite de la platine).`);
    }
    const bpm = st.live?.bpm || (st.analysis?.bpm ?? 120) * (st.rate || 1);
    const ramp = (this.d.rateRamp ?? defaultRateRamp)(this.baseRate[deck], target, now, Math.max(0, overBeats), bpm);
    this.ramps = this.ramps.filter((r) => r.deck !== deck).concat(ramp.map((r) => ({ deck, ...r })));
    if (!ramp.length) this.baseRate[deck] = target;
  }

  /** Applique les paliers de rampe échus ; la platine en transition est gérée par driveTransition. */
  private applyRamps(now: number, states: Record<DeckId, DeckState>): void {
    if (this.ramps.length) {
      const due = this.ramps.filter((r) => r.t <= now);
      if (due.length) {
        this.ramps = this.ramps.filter((r) => r.t > now);
        for (const r of due) this.baseRate[r.deck] = r.rate;
      }
    }
    for (const id of DECK_IDS) {
      if (this.tr && this.tr.plan.to === id && this.tr.playIssued) continue; // calage de phase en cours
      if (this.tr && this.tr.plan.technique === 'brake' && this.tr.plan.from === id) continue;
      if (this.activeFx.some((f) => f.cue.kind === 'brake' && f.cue.target === id)) continue;
      const st = states[id];
      if (!st.caps.canSetRate || st.status !== 'playing') continue;
      const want = this.baseRate[id];
      const last = this.lastRateSent[id] ?? st.rate;
      if (Math.abs(want - last) > 0.0004) {
        this.lastRateSent[id] = want;
        void this.d.decks[id].setRate(want).catch(() => {});
      }
    }
    if (this.groove?.endCtx !== undefined && now > this.groove.endCtx) this.groove = undefined;
  }

  private wantGenre(genre: Genre, bpmMin: number, bpmMax: number, reason: string): void {
    const key = `${genre}:${Math.round(bpmMin)}-${Math.round(bpmMax)}`;
    const nowMs = this.d.nowMs();
    const last = this.genreRequests.get(key);
    if (last !== undefined && nowMs - last < 60_000) return;
    this.genreRequests.set(key, nowMs);
    this.currentGenre = genre;
    this.log('brain', `Cherche du ${genre} (${Math.round(bpmMin)}-${Math.round(bpmMax)} BPM) : ${reason}`);
    this.d
      .catalog(genre, { bpmMin, bpmMax, limit: 40 })
      .then((tracks) => {
        let added = 0;
        for (const t of tracks) {
          if (this.isUsed(t.id) || this.crowd.host.blockedTrackIds.includes(t.id)) continue;
          if (!this.candidates.has(t.id)) {
            this.candidates.set(t.id, { track: t, genre, analysis: this.getAnalysis(t.id) });
            added++;
          }
        }
        // limite la taille : on garde les plus récents
        while (this.candidates.size > 120) {
          const first = this.candidates.keys().next().value as number;
          this.candidates.delete(first);
        }
        tracks.slice(0, 12).forEach((t) => this.enqueueAnalysis(t));
        this.log('info', `${added} morceaux ${genre} ajoutés aux candidats.`);
      })
      .catch((e) => {
        this.genreRequests.delete(key);
        this.log('warn', `Catalogue ${genre} indisponible : ${errMsg(e)}`);
      });
  }

  private enqueueAnalysis(track: TrackRef, priority = false): void {
    if (this.getAnalysis(track.id) || this.analysisFailed.has(track.id) || this.analysisInflight.has(track.id)) return;
    if (this.analysisQueue.some((t) => t.id === track.id)) {
      if (priority) {
        this.analysisQueue = [track, ...this.analysisQueue.filter((t) => t.id !== track.id)];
      }
      return;
    }
    if (priority) this.analysisQueue.unshift(track);
    else this.analysisQueue.push(track);
  }

  private pumpAnalysis(): void {
    const max = this.d.maxAnalysisConcurrency ?? 2;
    while (this.analysisInflight.size < max && this.analysisQueue.length) {
      const t = this.analysisQueue.shift()!;
      if (this.getAnalysis(t.id)) continue;
      this.analysisInflight.add(t.id);
      this.d
        .analyze(t)
        .then((a) => {
          this.analyses.set(t.id, a);
          const c = this.candidates.get(t.id);
          if (c) c.analysis = a;
        })
        .catch((e) => {
          this.analysisFailed.add(t.id);
          this.log('warn', `Analyse impossible pour « ${t.title} » : ${errMsg(e)}`);
        })
        .finally(() => this.analysisInflight.delete(t.id));
    }
  }

  async loadDeck(deck: DeckId, track: TrackRef, startAt: number, _reason: string): Promise<void> {
    if (this.loading[deck] === track.id) return;
    this.loading[deck] = track.id;
    this.readySince[deck] = undefined;
    const c = this.candidates.get(track.id);
    this.deckGenre[deck] = c?.genre ?? track.genres?.[0] ?? this.currentGenre;
    this.candidates.delete(track.id);
    try {
      safeSet(this.d.mixer, `${deck}.gain` as ParamTarget, 0);
      await this.d.decks[deck].load(track, startAt);
      const st = this.d.decks[deck].getState();
      this.baseRate[deck] = 1;
      this.ramps = this.ramps.filter((r) => r.deck !== deck);
      if (st.caps.canSetRate && Math.abs(st.rate - 1) > 0.0005) await this.d.decks[deck].setRate(1).catch(() => {});
      const a = this.getAnalysis(track.id);
      this.d.analyzers[deck].reset(a?.bpm ?? (track.bpm || undefined));
      this.lastRateSent[deck] = undefined;
    } catch (e) {
      this.log('error', `Chargement de « ${track.title} » sur ${deck} raté : ${errMsg(e)}`);
    } finally {
      if (this.loading[deck] === track.id) delete this.loading[deck];
    }
  }

  // ------------------------------------------------------------------------------- transitions

  private startTransition(plan: TransitionPlan, now: number): void {
    if (this.tr && this.tr.plan.id === plan.id) return;
    if (this.tr && this.tr.phase === 'scheduled') this.cancelTransition('nouvelle transition');
    else if (this.tr && this.tr.phase === 'running') {
      this.log('warn', 'Transition refusée : une autre est déjà en cours.');
      return;
    }
    const deck = this.d.decks[plan.to];
    const st = deck.getState();
    if (!st.track || (st.status !== 'ready' && st.status !== 'paused' && st.status !== 'playing')) {
      this.log('warn', `Transition vers ${plan.to} impossible : platine pas prête (${st.status}).`);
      return;
    }
    const spb = 60 / plan.bpm;
    const lat = Math.max(0, this.d.startLatency?.(plan.to) ?? 0);
    const rate = st.caps.canSetRate ? plan.incomingRate : 1;
    // pré-lancement fader fermé : quelques mesures avant le premier temps, si on peut reculer
    let preroll = 0;
    if (st.caps.canSeek && st.status !== 'playing') {
      preroll = Math.min(PREROLL_BEATS * spb, Math.max(0, plan.incomingStartPos) / Math.max(0.5, rate));
    }
    const outgoingAudible =
      this.d.decks[plan.from].getState().status === 'playing' && safeParam(this.d.mixer, `${plan.from}.gain` as ParamTarget, 0) > 0.05;
    if (!outgoingAudible) preroll = 0; // ouverture ou reprise après un silence : pas de calage à faire
    let p = { ...plan };
    let playAt = p.incomingStartCtx - preroll - lat;
    if (st.status !== 'playing' && playAt < now + 0.05 && !outgoingAudible) {
      // rien à caler : on décale juste ce qu'il faut pour absorber la latence de la platine
      const shift = now + 0.05 - playAt;
      p = { ...p, startCtx: p.startCtx + shift, incomingStartCtx: p.incomingStartCtx + shift };
      playAt += shift;
    } else if (st.status !== 'playing' && playAt < now + 0.05) {
      // trop tard : on décale toute la transition d'un nombre entier de mesures (la grille reste juste)
      const bar = 4 * spb;
      const shift = Math.ceil((now + 0.05 - playAt) / bar) * bar;
      p = { ...p, startCtx: p.startCtx + shift, incomingStartCtx: p.incomingStartCtx + shift };
      playAt += shift;
      this.log('warn', `Transition décalée de ${Math.round(shift / spb)} temps (platine ${plan.to} trop lente à démarrer).`);
    }
    let lanes: AutomationLane[] = [];
    this.d.mixer.setTempo?.(p.bpm);
    if (st.status !== 'playing') safeSet(this.d.mixer, `${p.to}.gain` as ParamTarget, 0);
    try {
      lanes = this.d.mixer.runTransition(p);
    } catch (e) {
      this.log('error', `La table n'a pas pu programmer la transition : ${errMsg(e)}`);
      return;
    }
    for (const cue of p.accents ?? []) {
      this.activeFx.push({ cue, endCtx: cue.atCtx + (cue.beats * 60) / cue.bpm });
    }
    const endCtx = p.startCtx + p.beats * spb;
    const tr: RunningTransition = {
      plan: p,
      lanes,
      phase: 'scheduled',
      playAtCtx: playAt,
      playIssued: st.status === 'playing',
      startedHistory: false,
      endCtx,
      relaxEndCtx: endCtx + (p.rateRelaxBeats ?? 0) * spb,
      outgoingStopped: false,
    };
    if (preroll > 0) tr.seekTo = Math.max(0, p.incomingStartPos - preroll * rate);
    else tr.seekTo = p.incomingStartPos;
    this.tr = tr;
    this.baseRate[p.to] = rate;
    this.ramps = this.ramps.filter((r) => r.deck !== p.to);
    if (st.caps.canSetRate && Math.abs(st.rate - rate) > 0.0005) void deck.setRate(rate).catch(() => {});
    if (st.status !== 'playing' && st.caps.canSeek && tr.seekTo !== undefined && Math.abs(st.position - tr.seekTo) > 0.05) {
      void deck.seek(tr.seekTo).catch(() => {});
    }
  }

  private cancelTransition(why: string): void {
    const tr = this.tr;
    if (!tr) return;
    const now = this.d.nowCtx();
    if (tr.playTimer !== undefined) this.d.timers?.clearTimeout(tr.playTimer);
    try {
      this.d.mixer.cancelFrom(now);
    } catch {
      /* rien */
    }
    if (tr.phase === 'scheduled') {
      // l'entrant éventuellement pré-lancé fader fermé est arrêté, le sortant reste ouvert
      const to = this.d.decks[tr.plan.to];
      if (tr.playIssued && now < tr.plan.incomingStartCtx) void to.pause().catch(() => {});
      safeSet(this.d.mixer, `${tr.plan.to}.gain` as ParamTarget, 0);
      if (this.d.decks[tr.plan.from].getState().status === 'playing') {
        safeSet(this.d.mixer, `${tr.plan.from}.gain` as ParamTarget, 1);
      }
    }
    this.activeFx = [];
    this.tr = undefined;
    this.log('info', `Transition annulée : ${why}.`);
  }

  private driveTransition(now: number, states: Record<DeckId, DeckState>): void {
    const tr = this.tr;
    if (!tr) return;
    const p = tr.plan;
    const deck = this.d.decks[p.to];
    const st = states[p.to];
    const tickS = (this.d.tickMs ?? 100) / 1000;

    if (!tr.playIssued && now >= tr.playAtCtx - tickS * 1.5) {
      tr.playIssued = true;
      const delayMs = Math.max(0, (tr.playAtCtx - now) * 1000);
      const go = () => {
        void deck.play().catch((e) => this.log('error', `Lecture ${p.to} impossible : ${errMsg(e)}`));
      };
      if (delayMs > 5 && this.d.timers) tr.playTimer = this.d.timers.setTimeout(go, delayMs);
      else go();
    }

    if (now >= p.startCtx && tr.phase === 'scheduled') tr.phase = 'running';
    if (!tr.startedHistory && now >= p.incomingStartCtx) {
      tr.startedHistory = true;
      this.markStarted(p.to);
    }

    // calage de phase de l'entrant
    if (st.caps.canSetRate && st.status === 'playing' && now >= tr.playAtCtx) {
      // rate de base COURANT (rampes du cerveau comprises), jamais le rate déjà corrigé
      let base = this.baseRate[p.to];
      const relax = p.rateRelaxBeats !== undefined && p.rateRelaxBeats > 0 && !this.ramps.some((r) => r.deck === p.to);
      if (relax && now > tr.endCtx) {
        const k = Math.min(1, (now - tr.endCtx) / Math.max(0.001, tr.relaxEndCtx - tr.endCtx));
        base = p.incomingRate + (1 - p.incomingRate) * k;
        this.baseRate[p.to] = base;
      }
      let target = base;
      if (now <= tr.endCtx && this.d.phaseNudge) {
        const dbCtx = this.incomingDownbeat(tr, st, now);
        if (dbCtx !== undefined) {
          const r = this.d.phaseNudge({
            bpm: p.bpm,
            refDownbeatCtx: p.incomingStartCtx,
            deckDownbeatCtx: dbCtx,
            nowCtx: now,
            maxDelta: st.caps.maxRateDelta,
            currentRate: base,
          });
          if (Number.isFinite(r.rate)) target = r.rate;
        }
      }
      target = clamp(target, 1 - st.caps.maxRateDelta, 1 + st.caps.maxRateDelta);
      const last = this.lastRateSent[p.to] ?? st.rate;
      if (Math.abs(target - last) > 0.0004) {
        this.lastRateSent[p.to] = target;
        void deck.setRate(target).catch(() => {});
      }
    }

    // frein platine : la sortante ralentit par paliers vers ~0.1 juste avant le 1 de l'entrant
    if (p.technique === 'brake' && !tr.outgoingStopped) {
      const spb = 60 / p.bpm;
      const dur = Math.min(2, Math.max(1, p.beats / 4)) * spb;
      this.applyBrake(p.from, p.incomingStartCtx - dur, dur, now, states[p.from]);
    }

    // fin : on coupe le sortant une fois son fader fermé (et la queue des effets passée)
    if (!tr.outgoingStopped && now >= tr.endCtx + TAIL_SECONDS) {
      tr.outgoingStopped = true;
      const from = states[p.from];
      if (from.status === 'playing' && safeParam(this.d.mixer, `${p.from}.gain` as ParamTarget, 0) < 0.08) {
        void this.d.decks[p.from].pause().catch(() => {});
      }
      this.markEnded(p.from);
    }
    if (now >= tr.endCtx && tr.phase === 'running') tr.phase = 'relaxing';
    if (now >= Math.max(tr.relaxEndCtx, tr.endCtx + TAIL_SECONDS)) {
      if (tr.outgoingStopped) {
        this.tr = undefined;
        this.lastRateSent[p.to] = undefined;
      }
    }
  }


  /** Ralentit une platine par paliers (effet platine qui s'arrête), si elle accepte de changer de vitesse. */
  private applyBrake(deck: DeckId, startCtx: number, dur: number, now: number, st: DeckState): void {
    if (!st.caps.canSetRate || st.status !== 'playing' || now < startCtx) return;
    const k = Math.min(1, (now - startCtx) / dur);
    const steps = 6;
    const rate = Math.max(0.1, 1 - 0.9 * (Math.ceil(k * steps) / steps));
    const last = this.lastRateSent[deck] ?? st.rate;
    if (Math.abs(rate - last) > 0.01) {
      this.lastRateSent[deck] = rate;
      void this.d.decks[deck].setRate(rate).catch(() => {});
    }
  }

  private driveFx(now: number, states: Record<DeckId, DeckState>): void {
    for (const f of this.activeFx) {
      if (f.cue.kind !== 'brake' || f.cue.target === 'master') continue;
      const dur = (f.cue.beats * 60) / f.cue.bpm;
      this.applyBrake(f.cue.target, f.cue.atCtx, dur, now, states[f.cue.target]);
    }
  }

  /** Premier temps de mesure de l'entrant (ctx), d'après sa position, affiné par l'analyse en direct. */
  private incomingDownbeat(tr: RunningTransition, st: DeckState, now: number): number | undefined {
    if (!st.rate) return undefined;
    const outLat = this.d.outputLatency?.(st.id) ?? 0;
    const predicted = now - (st.position - tr.plan.incomingStartPos) / st.rate + outLat;
    const live = st.live;
    if (live && live.beatConfidence >= 0.55 && now - tr.playAtCtx > 4) {
      const spb = 60 / live.bpm;
      const k = Math.round((predicted - live.downbeatCtx) / spb);
      const refined = live.downbeatCtx + k * spb;
      if (Math.abs(refined - predicted) < spb * 0.5) return refined;
    }
    return predicted;
  }

  // ------------------------------------------------------------------------------- robustesse

  private trackReady(states: Record<DeckId, DeckState>, nowMs: number): void {
    for (const id of DECK_IDS) {
      const s = states[id];
      if ((s.status === 'ready' || s.status === 'paused') && s.track) this.readySince[id] ??= nowMs;
      else this.readySince[id] = undefined;
    }
  }

  private watchdog(now: number, nowMs: number, states: Record<DeckId, DeckState>): void {
    const air = this.onAir(states);
    const pendingSoon = !!this.tr;
    if (air || pendingSoon) {
      this.silentSince = undefined;
      return;
    }
    // platine à l'antenne tombée en erreur ou finie : réaction immédiate
    const crashed = DECK_IDS.some(
      (id) => (states[id].status === 'error' || states[id].status === 'ended') && safeParam(this.d.mixer, `${id}.gain` as ParamTarget, 0) > 0.5,
    );
    this.silentSince ??= now;
    const silentFor = now - this.silentSince;
    const firstStart = this.history.length === 0;
    // au démarrage, le cerveau ouvre lui-même (transition 'cut') : on ne relance qu'en secours
    const limit = crashed ? 0 : firstStart ? 6 : SILENCE_LIMIT;
    if (silentFor < limit) return;
    if (now - this.emergencyAt < 2) return;
    this.emergencyAt = now;

    // une platine prête ? on la lance plein pot
    const ready = DECK_IDS.filter((id) => {
      const s = states[id];
      return s.track && (s.status === 'ready' || s.status === 'paused') && this.readySince[id] !== undefined;
    });
    if (ready.length) {
      const id = ready[0];
      this.cancelTransition('silence détecté');
      safeSet(this.d.mixer, `${other(id)}.gain` as ParamTarget, 0);
      safeSet(this.d.mixer, `${id}.gain` as ParamTarget, 1);
      void this.d.decks[id].play().catch((e) => this.log('error', `Relance ${id} : ${errMsg(e)}`));
      this.markStarted(id);
      this.log(firstStart ? 'info' : 'warn', firstStart ? `Premier morceau lancé sur ${id}.` : `Silence : la platine ${id} prend le relais.`);
      return;
    }
    if (this.loading.A !== undefined || this.loading.B !== undefined) return;
    // rien de prêt : morceau de secours sur une platine saine
    const deck = DECK_IDS.find((id) => states[id].status !== 'error') ?? 'A';
    void this.pickFallback().then((t) => {
      if (!t) {
        this.log('error', 'Aucun morceau de secours disponible.');
        return;
      }
      this.log('warn', `Silence : morceau de secours « ${t.title} » sur ${deck}.`);
      this.queue = this.queue.filter((q) => q.track.id !== t.id);
      void this.loadDeck(deck, t, 0, 'secours');
    });
    void nowMs;
  }

  private async pickFallback(): Promise<TrackRef | undefined> {
    if (this.queue.length) return this.queue[0].track;
    const cands = [...this.candidates.values()].filter((c) => !this.isUsed(c.track.id));
    const analysed = cands.filter((c) => c.analysis ?? this.getAnalysis(c.track.id));
    if (analysed.length) return analysed[0].track;
    if (cands.length) return cands[0].track;
    const fb = (await this.d.fallbackTracks?.()) ?? [];
    const unused = fb.filter((t) => !this.isUsed(t.id));
    const pool = unused.length ? unused : fb;
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : undefined;
  }

  private lastTempoMs = 0;
  /** Tempo de référence de la table (gate rythmique) = platine à l'antenne. */
  private keepTempo(nowMs: number, states: Record<DeckId, DeckState>): void {
    if (nowMs - this.lastTempoMs < 2000 || !this.d.mixer.setTempo) return;
    this.lastTempoMs = nowMs;
    const air = this.onAir(states);
    if (!air) return;
    const st = states[air];
    const bpm = st.live && st.live.beatConfidence >= 0.5 ? st.live.bpm : (st.analysis?.bpm ?? 0) * (st.rate || 1);
    if (bpm > 0) this.d.mixer.setTempo(bpm);
  }

  private markStarted(deck: DeckId): void {
    const t = this.d.decks[deck].getState().track;
    if (!t) return;
    const last = this.history[this.history.length - 1];
    if (last && last.track.id === t.id && last.endedAt === undefined) return;
    this.history.push({ track: t, startedAt: this.d.nowMs(), genre: this.deckGenre[deck] });
    if (this.history.length > 300) this.history.shift();
    const qi = this.queue.find((q) => q.track.id === t.id);
    if (qi) {
      this.queue = this.queue.filter((q) => q !== qi);
      if (qi.requestId) this.markRequestPlayed(qi.requestId);
    }
  }

  private markEnded(deck: DeckId): void {
    const t = this.d.decks[deck].getState().track;
    if (!t) return;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const h = this.history[i];
      if (h.track.id === t.id) {
        h.endedAt ??= this.d.nowMs();
        break;
      }
    }
  }

  // ------------------------------------------------------------------------------- invités

  private acceptRequest(r: GuestRequest): void {
    if (this.seenRequests.has(r.id)) return;
    this.seenRequests.add(r.id);
    if (this.history.some((h) => h.track.id === r.track.id)) return;
    if (r.guestName) this.guestNames[r.id] = r.guestName;
    this.addToQueue(r.track, 'guest', { requestId: r.id });
    this.log('info', `Demande de ${r.guestName ?? 'un invité'} ajoutée à la file : ${r.track.title}`);
  }

  private markRequestPlayed(id: string): void {
    if (this.playedRequests.has(id)) return;
    this.playedRequests.add(id);
    void this.d.guestApi?.setRequestStatus(id, 'played').catch(() => {});
  }

  async pollGuests(): Promise<void> {
    const api = this.d.guestApi;
    if (!api) return;
    try {
      const st = await api.getState();
      this.crowd = st.crowd ?? this.crowd;
      for (const r of this.crowd.requests ?? []) if (r.status === 'accepted') this.acceptRequest(r);
      this.guestStatus = { configured: true, ok: true, lastOkMs: this.d.nowMs() };
    } catch (e) {
      this.guestStatus = { ...this.guestStatus, configured: true, ok: false, lastError: errMsg(e) };
    }
    try {
      const states = this.deckStates();
      const air = this.onAir(states);
      const np: NowPlaying = {
        current: air ? states[air].track : undefined,
        next: air ? states[other(air)].track ?? this.queue[0]?.track : this.queue[0]?.track,
        genre: (air && this.deckGenre[air]) || this.currentGenre,
        updatedAt: this.d.nowMs(),
      };
      // envoi à chaque cycle (3 s) : l'API garde ainsi un "updatedAt" frais
      await api.postNowPlaying(np);
    } catch (e) {
      this.guestStatus = { ...this.guestStatus, ok: false, lastError: errMsg(e) };
    }
  }

  // ------------------------------------------------------------------------------- divers

  log(level: LogLevel, msg: string): void {
    this.logs = [...this.logs.slice(-299), { t: this.d.nowMs(), level, msg }];
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

function clamp(v: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, v));
}

function safeParam(m: MixerLike, t: ParamTarget, dflt: number): number {
  try {
    const v = m.getParam(t);
    return Number.isFinite(v) ? v : dflt;
  } catch {
    return dflt;
  }
}

function safeSet(m: MixerLike, t: ParamTarget, v: number): void {
  try {
    m.setParam(t, v);
  } catch {
    /* paramètre absent */
  }
}

function fmtRate(r: number): string {
  const p = (r - 1) * 100;
  return `${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(1)} %`;
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
