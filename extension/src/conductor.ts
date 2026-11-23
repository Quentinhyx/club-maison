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
  TrackStructure,
  TrackWaveform,
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
  // échantillonneur de boucles (optionnel selon la version de la table)
  holdLoop?(deck: DeckId, o: { atCtx: number; beats: number; bpm: number }): unknown;
  setLoopLength?(deck: DeckId, beats: number, atCtx?: number): unknown;
  releaseLoop?(deck: DeckId, atCtx: number): unknown;
  isLooping?(deck: DeckId): boolean;
  /** Boucle le sortant tant que isReady() est faux ; renvoie (ou promet) l'instant ctx de relâche. */
  holdUntil?(deck: DeckId, atCtx: number, bpm: number, isReady: () => boolean, maxBeats: number): number | Promise<number> | unknown;
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

/** Scanner d'un morceau complet (shared/analysis TrackScanner). */
export interface ScannerLike {
  push(frame: Float32Array, trackPosStart: number, trackPosEnd: number): void;
  getWaveform(trackId: number): TrackWaveform;
  getStructure(bpmHint?: number): TrackStructure | undefined;
  coverage(): number;
}

/** Pré-écoute accélérée sur la platine libre (Deezer) : fourni par le moteur, absent en démo. */
export interface ScanSupport {
  /** Vrai si cette platine peut être pré-écoutée (lecteur Deezer). */
  supported(deck: DeckId): boolean;
  sampleRate: number;
  create(opts: { sampleRate: number; duration: number; bpmHint?: number }): ScannerLike;
  /** Branche une capture PCM sur la sortie (avant fader) de la platine ; renvoie la fonction d'arrêt. */
  capture(deck: DeckId, onFrame: (frame: Float32Array, endCtx: number) => void): () => void;
}

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
  /** Latence de démarrage réellement mesurée (s) : la platine peut affiner son estimation. */
  reportLatency?(deck: DeckId, seconds: number): void;
  /** Morceaux similaires au morceau qui commence (radio de l'artiste, artistes proches, ou démo). */
  similar?(track: TrackRef): Promise<TrackRef[]>;
  scan?: ScanSupport;
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
  /** Pré-écoute en cours : platine, morceau, couverture 0..1. */
  scans: Partial<Record<DeckId, { trackId: number; coverage: number }>>;
  skipRequestedAt?: number;
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

interface ScanJob {
  trackId: number;
  scanner: ScannerLike;
  rate: number;
  startAt: number;
  stop: () => void;
  lastStructAt: number;
  startedCtx: number;
  verified: boolean;
}

/** Vitesses essayées pour la pré-écoute (Chrome coupe le son au-delà de ×4). */
const SCAN_RATES = [4, 2];

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
  /** Instant où l'entrant doit devenir audible (son « 1 »). */
  audibleAt: number;
  /** Position de l'entrant au moment du play (pour savoir s'il avance vraiment). */
  playPos?: number;
  playIssuedAt?: number;
  latencyMeasured?: boolean;
  readyWarned?: boolean;
  waitingReady?: boolean;
  hold: 'none' | 'holding' | 'released';
  holdStartedAt?: number;
  ownLoop?: boolean;
  holdToken?: number;
}

export interface LoopView { deck: DeckId; atCtx: number; beats: number; bpm: number; kind: 'loop' | 'loop-roll' | 'hold' }

const PREROLL_BEATS = 8;
/** Au-delà, on abandonne l'entrant qui ne démarre pas (en temps du sortant). */
const MAX_HOLD_BEATS = 64;
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
  private candidates = new Map<number, { track: TrackRef; analysis?: TrackAnalysis; genre: Genre; source?: 'catalog' | 'similar' }>();
  private skipRequestedAt?: number;
  private lastHostSkip = 0;
  private similarDone = new Set<number>();
  private scans: Partial<Record<DeckId, ScanJob>> = {};
  private waveforms = new Map<number, TrackWaveform>();
  private structures = new Map<number, TrackStructure>();
  private noScan = new Set<number>();
  private loadStartAt: Partial<Record<DeckId, number>> = {};
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
  private failedTracks = new Set<number>();
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
    for (const id of DECK_IDS) this.stopScan(id, 'arrêt');
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
    this.stopScan(deck, 'lecture à la main');
    await this.d.decks[deck].play().catch((e) => this.log('error', `Lecture ${deck} : ${errMsg(e)}`));
    this.markStarted(deck);
  }

  async manualPause(deck: DeckId): Promise<void> {
    await this.d.decks[deck].pause().catch(() => {});
    this.markEnded(deck);
  }

  // ------------------------------------------------------------------------------- lecture d'état

  getAnalysis(id: number): TrackAnalysis | undefined {
    const a = this.analyses.get(id) ?? this.d.cachedAnalysis?.(id);
    const st = this.structures.get(id);
    return a && st && !a.structure ? { ...a, structure: st } : a;
  }

  /** Forme d'onde complète issue de la pré-écoute (Deezer), si elle existe. */
  getWaveform(id: number): TrackWaveform | undefined {
    return this.waveforms.get(id);
  }

  /** Position de départ choisie par le cerveau pour le morceau chargé sur cette platine. */
  getLoadStartAt(id: DeckId): number | undefined {
    return this.loadStartAt[id];
  }

  /** « Suivant » : le cerveau sort du morceau en cours au plus vite (bouton, clavier, téléphone). */
  requestSkip(from = 'console'): void {
    this.skipRequestedAt = this.d.nowMs();
    this.log('info', `Suivant demandé (${from}).`);
    this.emit();
  }

  /** Couverture de la pré-écoute en cours sur cette platine (0..1), ou undefined. */
  getScan(id: DeckId): { trackId: number; coverage: number } | undefined {
    const j = this.scans[id];
    return j ? { trackId: j.trackId, coverage: j.scanner.coverage() } : undefined;
  }

  getSkipRequestedAt(): number | undefined {
    return this.skipRequestedAt;
  }

  deckStates(): Record<DeckId, DeckState> {
    const out = {} as Record<DeckId, DeckState>;
    for (const id of DECK_IDS) {
      let s = this.d.decks[id].getState();
      const job = this.scans[id];
      // pendant la pré-écoute, la platine reste « prête » au point de départ pour le reste du monde
      if (job) s = { ...s, status: 'ready', position: job.startAt, rate: 1, live: undefined };
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
      if (states[id].status !== 'playing' && !this.d.mixer.isLooping?.(id)) continue;
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

  /** Boucles en cours, par platine (effets 'loop' / 'loop-roll' et maintien du sortant). */
  getLoops(): Partial<Record<DeckId, LoopView>> {
    const now = this.d.nowCtx();
    const out: Partial<Record<DeckId, LoopView>> = {};
    for (const f of this.activeFx) {
      const c = f.cue;
      if ((c.kind !== 'loop' && c.kind !== 'loop-roll') || c.target === 'master' || now < c.atCtx) continue;
      let beats = c.loopBeats ?? 1;
      if (c.kind === 'loop-roll') {
        const k = Math.min(3, Math.floor(((now - c.atCtx) / Math.max(0.01, f.endCtx - c.atCtx)) * 4));
        beats = beats / Math.pow(2, k);
      }
      out[c.target] = { deck: c.target, atCtx: c.atCtx, beats, bpm: c.bpm, kind: c.kind };
    }
    const tr = this.tr;
    if (tr && tr.hold === 'holding' && tr.plan.holdWithLoop !== false && !out[tr.plan.from]) {
      out[tr.plan.from] = { deck: tr.plan.from, atCtx: tr.holdStartedAt ?? now, beats: 4, bpm: tr.plan.bpm, kind: 'hold' };
    }
    for (const id of DECK_IDS) {
      if (!out[id] && this.d.mixer.isLooping?.(id)) out[id] = { deck: id, atCtx: now, beats: 4, bpm: tr?.plan.bpm ?? 120, kind: 'hold' };
    }
    return out;
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
      scans: Object.fromEntries(
        DECK_IDS.filter((d) => this.scans[d]).map((d) => [d, { trackId: this.scans[d]!.trackId, coverage: this.scans[d]!.scanner.coverage() }]),
      ) as ConductorSnapshot['scans'],
      skipRequestedAt: this.skipRequestedAt,
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
        this.driveScans(now, states);
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
        .map((c) => ({ ...c, analysis: this.getAnalysis(c.track.id) ?? c.analysis })),
      crowd: this.crowd,
      settings: this.settings,
      history: this.history,
      activeTransition: this.tr?.plan,
      skipRequestedAt: this.skipRequestedAt,
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
    if (this.failedTracks.has(id)) return true;
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

  // ----------------------------------------------------------------------------- pré-écoute accélérée

  /** Lance / suit / arrête la pré-écoute ×4 du morceau chargé sur la platine libre. */
  private driveScans(now: number, _states: Record<DeckId, DeckState>): void {
    const sc = this.d.scan;
    if (!sc) return;
    for (const id of DECK_IDS) {
      const job = this.scans[id];
      const raw = this.d.decks[id].getState();
      if (job) {
        // vérification que la vitesse ×N a été acceptée
        if (!job.verified && now - job.startedCtx > 1.5) {
          job.verified = true;
          if (raw.status !== 'playing' || Math.abs(raw.rate - job.rate) > 0.05) {
            const next = SCAN_RATES[SCAN_RATES.indexOf(job.rate) + 1];
            this.stopScan(id, `vitesse ×${job.rate} refusée`);
            if (next) this.startScan(id, next, now);
            else this.noScan.add(job.trackId);
            continue;
          }
        }
        if (now - job.lastStructAt > 3) {
          job.lastStructAt = now;
          this.publishScan(job);
        }
        const nearEnd = raw.duration > 0 && raw.position >= raw.duration - 0.6;
        if (raw.status === 'ended' || nearEnd || job.scanner.coverage() >= 0.995) this.stopScan(id, 'fin du morceau');
        continue;
      }
      if (!this.canScanNow(id, raw)) continue;
      this.startScan(id, SCAN_RATES[0], now);
    }
  }

  private canScanNow(id: DeckId, st: DeckState): boolean {
    const sc = this.d.scan;
    if (!sc || !sc.supported(id) || !st.track) return false;
    if (st.status !== 'ready' && st.status !== 'paused') return false;
    if (this.loading[id] !== undefined || !st.caps.canSetRate) return false;
    if (this.noScan.has(st.track.id)) return false;
    const w = this.waveforms.get(st.track.id);
    if (w && w.coverage >= 0.98) return false;
    if (this.tr && (this.tr.plan.to === id || this.tr.plan.from === id)) return false; // jamais pendant pré-lancement / transition
    if (this.isAudible(id)) return false;
    // il faut un morceau à l'antenne qui dure encore un peu, sinon on garde la platine prête
    const other = DECK_IDS.find((d) => d !== id)!;
    const o = this.d.decks[other].getState();
    if (o.status !== 'playing' || (o.duration || 0) - o.position < 25) return false;
    return true;
  }

  private startScan(id: DeckId, rate: number, now: number): void {
    const sc = this.d.scan!;
    const deck = this.d.decks[id];
    const st = deck.getState();
    const track = st.track!;
    const scanner = sc.create({ sampleRate: sc.sampleRate, duration: st.duration || track.duration, bpmHint: this.getAnalysis(track.id)?.bpm ?? track.bpm });
    const outLat = this.d.outputLatency?.(id) ?? 0;
    const job: ScanJob = {
      trackId: track.id,
      scanner,
      rate,
      startAt: this.loadStartAt[id] ?? st.position,
      stop: () => {},
      lastStructAt: now,
      startedCtx: now,
      verified: false,
    };
    safeSet(this.d.mixer, `${id}.gain` as ParamTarget, 0);
    job.stop = sc.capture(id, (frame, endCtx) => {
      const s = deck.getState();
      if (s.status !== 'playing') return;
      const r = s.rate || rate;
      const posEnd = s.position - (this.d.nowCtx() - endCtx) * r - outLat * r;
      const posStart = posEnd - (frame.length / sc.sampleRate) * r;
      if (posStart >= 0) scanner.push(frame, posStart, posEnd);
    });
    this.scans[id] = job;
    void deck.seek(0).catch(() => {});
    void deck.setRate(rate).catch(() => {});
    void deck.play().catch(() => {});
    this.log('info', `Pré-écoute ×${rate} de « ${track.title} » sur ${id} (forme d'onde et structure du morceau complet).`);
  }

  /** Arrête la pré-écoute : pause, vitesse de base, retour au point de départ choisi par le cerveau. */
  private stopScan(id: DeckId, why: string): void {
    const job = this.scans[id];
    if (!job) return;
    delete this.scans[id];
    try {
      job.stop();
    } catch {
      /* rien */
    }
    this.publishScan(job);
    const deck = this.d.decks[id];
    void deck.pause().catch(() => {});
    void deck.setRate(this.baseRate[id] || 1).catch(() => {});
    void deck.seek(job.startAt).catch(() => {});
    this.lastRateSent[id] = undefined;
    this.d.analyzers[id].reset(this.getAnalysis(job.trackId)?.bpm);
    const cov = Math.round(job.scanner.coverage() * 100);
    this.log('info', `Pré-écoute arrêtée sur ${id} (${why}) : ${cov} % du morceau analysé.`);
  }

  /** Publie la forme d'onde et la structure (donc BrainInput.analyses) au fil du scan. */
  private publishScan(job: ScanJob): void {
    try {
      const w = job.scanner.getWaveform(job.trackId);
      this.waveforms.set(job.trackId, w);
      const st = job.scanner.getStructure(this.getAnalysis(job.trackId)?.bpm);
      if (st) {
        this.structures.set(job.trackId, st);
        const a = this.analyses.get(job.trackId);
        if (a) this.analyses.set(job.trackId, { ...a, structure: st });
      }
    } catch {
      /* scan trop court pour conclure */
    }
  }

  /** Similaires du morceau qui commence : candidats « similar » (même genre que le morceau en cours). */
  private fetchSimilar(deck: DeckId, t: TrackRef): void {
    if (!this.d.similar || this.similarDone.has(t.id)) return;
    this.similarDone.add(t.id);
    const genre = this.deckGenre[deck] ?? t.genres?.[0] ?? this.currentGenre ?? this.settings.baseGenre;
    this.d
      .similar(t)
      .then((list) => {
        let added = 0;
        for (const s2 of list) {
          if (this.isUsed(s2.id) || this.crowd.host.blockedTrackIds.includes(s2.id) || this.candidates.has(s2.id)) continue;
          this.candidates.set(s2.id, { track: s2, genre, source: 'similar', analysis: this.getAnalysis(s2.id) });
          added++;
        }
        list.slice(0, 10).forEach((x) => this.enqueueAnalysis(x));
        if (added) this.log('info', `${added} morceaux proches de « ${t.title} » ajoutés aux candidats.`);
      })
      .catch((e) => this.log('warn', `Similaires de « ${t.title} » indisponibles : ${errMsg(e)}`));
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
            this.candidates.set(t.id, { track: t, genre, source: 'catalog', analysis: this.getAnalysis(t.id) });
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
    this.stopScan(deck, 'nouveau morceau');
    this.loading[deck] = track.id;
    this.readySince[deck] = undefined;
    this.loadStartAt[deck] = startAt;
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
    const stillLoading = st.status === 'loading' || this.loading[plan.to] !== undefined;
    if (!st.track && !stillLoading) {
      this.log('warn', `Transition vers ${plan.to} impossible : platine vide.`);
      return;
    }
    if (!stillLoading && st.status !== 'ready' && st.status !== 'paused' && st.status !== 'playing') {
      this.log('warn', `Transition vers ${plan.to} impossible : platine ${st.status}.`);
      return;
    }
    if (stillLoading) this.log('warn', `Platine ${plan.to} encore en chargement : la boucle tiendra le sortant si besoin.`);
    this.stopScan(plan.to, 'transition');
    const spb = 60 / plan.bpm;
    const lat = Math.max(0, this.d.startLatency?.(plan.to) ?? 0);
    const rate = st.caps.canSetRate ? plan.incomingRate : 1;
    const outgoingAudible = this.isAudible(plan.from);
    // pré-lancement fader fermé, pour TOUTES les techniques : l'entrant tourne déjà quand il doit sonner
    let preroll = 0;
    let seekTo: number | undefined = plan.incomingStartPos;
    if (st.status !== 'playing' && outgoingAudible) {
      const want = Math.max(0, plan.preRollBeats ?? PREROLL_BEATS) * spb;
      if (st.caps.canSeek || stillLoading) {
        preroll = Math.min(want, Math.max(0, plan.incomingStartPos) / Math.max(0.5, rate));
        seekTo = Math.max(0, plan.incomingStartPos - preroll * rate);
      } else {
        seekTo = undefined; // pas de seek : on part d'où la platine est
        preroll = Math.max(0, (plan.incomingStartPos - st.position) / Math.max(0.5, rate));
      }
    }
    let p = { ...plan };
    let playAt = p.incomingStartCtx - preroll - lat;
    if (st.status !== 'playing' && playAt < now + 0.05 && !outgoingAudible) {
      // ouverture : rien à caler, on décale juste ce qu'il faut pour absorber la latence
      p = shiftPlan(p, now + 0.05 - playAt);
      playAt = now + 0.05;
    } else if (st.status !== 'playing' && playAt < now + 0.05) {
      // trop tard : on décale toute la transition d'un nombre entier de mesures (la grille reste juste)
      const bar = 4 * spb;
      const shift = Math.ceil((now + 0.05 - playAt) / bar) * bar;
      p = shiftPlan(p, shift);
      playAt += shift;
      this.log('warn', `Transition décalée de ${Math.round(shift / spb)} temps (platine ${plan.to} trop lente à démarrer).`);
    }
    let lanes: AutomationLane[] = [];
    this.d.mixer.setTempo?.(p.bpm);
    if (st.status !== 'playing') safeSet(this.d.mixer, `${p.to}.gain` as ParamTarget, 0);
    if (this.d.mixer.isLooping?.(p.from)) this.d.mixer.releaseLoop?.(p.from, Math.max(now, p.startCtx));
    try {
      lanes = this.d.mixer.runTransition(p);
    } catch (e) {
      this.log('error', `La table n'a pas pu programmer la transition : ${errMsg(e)}`);
      return;
    }
    for (const cue of p.accents ?? []) this.activeFx.push({ cue, endCtx: cue.atCtx + (cue.beats * 60) / cue.bpm });
    const endCtx = p.startCtx + p.beats * spb;
    this.tr = {
      plan: p,
      lanes,
      phase: 'scheduled',
      playAtCtx: playAt,
      seekTo,
      playIssued: st.status === 'playing',
      playPos: st.status === 'playing' ? st.position : undefined,
      startedHistory: false,
      endCtx,
      relaxEndCtx: endCtx + (p.rateRelaxBeats ?? 0) * spb,
      outgoingStopped: false,
      audibleAt: p.incomingStartCtx,
      hold: 'none',
    };
    this.baseRate[p.to] = rate;
    this.ramps = this.ramps.filter((r) => r.deck !== p.to);
    if (!stillLoading) this.prepareIncoming(this.tr, st, rate);
  }

  /** Vitesse et seek de l'entrant avant son pré-lancement. */
  private prepareIncoming(tr: RunningTransition, st: DeckState, rate: number): void {
    const deck = this.d.decks[tr.plan.to];
    if (st.caps.canSetRate && Math.abs(st.rate - rate) > 0.0005) void deck.setRate(rate).catch(() => {});
    if (st.status !== 'playing' && st.caps.canSeek && tr.seekTo !== undefined && Math.abs(st.position - tr.seekTo) > 0.05) {
      void deck.seek(tr.seekTo).catch(() => {});
    }
  }

  /** La platine est-elle entendue (en lecture ou tenue par une boucle, fader ouvert) ? */
  private isAudible(id: DeckId): boolean {
    const st = this.d.decks[id].getState();
    const looping = !!this.d.mixer.isLooping?.(id);
    return (st.status === 'playing' || looping) && safeParam(this.d.mixer, `${id}.gain` as ParamTarget, 0) > 0.05;
  }

  /** L'entrant joue-t-il réellement (position qui avance, ou son capté) ? */
  private incomingRunning(tr: RunningTransition): boolean {
    const st = this.d.decks[tr.plan.to].getState();
    if (st.status !== 'playing') return false;
    const advanced = tr.playPos !== undefined ? st.position > tr.playPos + 0.03 : true;
    let level = 0;
    try {
      level = (this.d.mixer.getLevels() as Record<string, number>)[tr.plan.to] ?? 0;
    } catch {
      /* rien */
    }
    return advanced || level > 0.003;
  }

  /** L'entrant n'a pas démarré à temps : on tient le sortant en boucle et on décale la transition. */
  private startHold(tr: RunningTransition, now: number): void {
    const p = tr.plan;
    const spb = 60 / p.bpm;
    tr.hold = 'holding';
    tr.holdStartedAt = now;
    tr.holdToken = (tr.holdToken ?? 0) + 1;
    const token = tr.holdToken;
    try {
      this.d.mixer.cancelFrom(now);
    } catch {
      /* rien */
    }
    safeSet(this.d.mixer, `${p.to}.gain` as ParamTarget, 0);
    safeSet(this.d.mixer, `${p.from}.gain` as ParamTarget, 1);
    this.activeFx = this.activeFx.filter((f) => f.cue.atCtx < now);
    const useLoop = p.holdWithLoop !== false;
    this.log('warn', `La platine ${p.to} n'a pas encore démarré : ${useLoop ? 'boucle sur' : 'on prolonge'} la platine ${p.from} en attendant.`);
    if (!useLoop) return;
    const m = this.d.mixer;
    if (m.holdUntil) {
      try {
        const r = m.holdUntil(p.from, now, p.bpm, () => this.incomingRunning(tr), MAX_HOLD_BEATS);
        const onR = (R: unknown) => {
          if (this.tr !== tr || tr.holdToken !== token || typeof R !== 'number' || !Number.isFinite(R)) return;
          if (this.incomingRunning(tr)) this.releaseHold(tr, R);
          else this.failIncoming(tr, 'la platine ne démarre pas');
        };
        if (r && typeof (r as Promise<number>).then === 'function') void (r as Promise<number>).then(onR, () => {});
        else onR(r);
      } catch (e) {
        this.log('warn', `Boucle impossible : ${errMsg(e)}`);
      }
    } else if (m.holdLoop) {
      try {
        m.holdLoop(p.from, { atCtx: now + 0.02, beats: 4, bpm: p.bpm });
        tr.ownLoop = true;
      } catch (e) {
        this.log('warn', `Boucle impossible : ${errMsg(e)}`);
      }
    }
    void spb;
  }

  /** L'entrant tourne enfin : on cale la nouvelle entrée sur la grille et on replanifie la transition. */
  private releaseHold(tr: RunningTransition, releaseCtx: number): void {
    const now = this.d.nowCtx();
    const p = tr.plan;
    const spb = 60 / p.bpm;
    const st = this.d.decks[p.to].getState();
    const rate = st.rate || 1;
    const outLat = this.d.outputLatency?.(p.to) ?? 0;
    // instant où l'entrant arrivera à son point d'entrée, ramené sur la grille du sortant
    const tStar = now + (p.incomingStartPos - st.position) / rate + outLat;
    const old = p.incomingStartCtx;
    let newStart = old + Math.round((tStar - old) / spb) * spb;
    let posShift = 0;
    const earliest = Math.max(releaseCtx, now + 0.1);
    if (newStart < earliest) {
      const n = Math.ceil((earliest - newStart) / (4 * spb));
      newStart += n * 4 * spb;
      posShift = n * 4 * spb * rate; // on entre quelques mesures plus loin dans l'entrant
    }
    const shift = newStart - old;
    const np = shiftPlan({ ...p, incomingStartPos: p.incomingStartPos + posShift }, shift);
    if (tr.ownLoop) this.d.mixer.releaseLoop?.(p.from, Math.max(now, Math.min(releaseCtx, np.startCtx)));
    try {
      this.d.mixer.cancelFrom(now);
      tr.lanes = this.d.mixer.runTransition(np);
    } catch (e) {
      this.log('error', `Replanification impossible : ${errMsg(e)}`);
    }
    for (const cue of np.accents ?? []) this.activeFx.push({ cue, endCtx: cue.atCtx + (cue.beats * 60) / cue.bpm });
    tr.plan = np;
    tr.audibleAt = np.incomingStartCtx;
    tr.endCtx = np.startCtx + np.beats * spb;
    tr.relaxEndCtx = tr.endCtx + (np.rateRelaxBeats ?? 0) * spb;
    tr.phase = now < np.startCtx ? 'scheduled' : 'running';
    tr.hold = 'released';
    this.log('warn', `Transition décalée de ${shift.toFixed(1)} s : la platine ${p.to} a démarré en retard.`);
  }

  /** L'entrant ne démarre jamais : abandon, le sortant continue (ou reste en boucle), morceau de secours. */
  private failIncoming(tr: RunningTransition, why: string): void {
    const now = this.d.nowCtx();
    const p = tr.plan;
    this.log('error', `Platine ${p.to} : ${why}. Transition abandonnée, morceau de secours.`);
    try {
      this.d.mixer.cancelFrom(now);
    } catch {
      /* rien */
    }
    safeSet(this.d.mixer, `${p.to}.gain` as ParamTarget, 0);
    safeSet(this.d.mixer, `${p.from}.gain` as ParamTarget, 1);
    const from = this.d.decks[p.from].getState();
    const left = (from.duration || 0) - from.position;
    if (tr.ownLoop && from.status === 'playing' && left > 8) this.d.mixer.releaseLoop?.(p.from, now);
    void this.d.decks[p.to].pause().catch(() => {});
    const failed = this.d.decks[p.to].getState().track;
    if (failed) this.failedTracks.add(failed.id);
    this.activeFx = [];
    this.tr = undefined;
    void this.pickFallback().then((t) => {
      if (t) void this.loadDeck(p.to, t, 0, 'secours');
    });
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

    const isReady = st.status === 'ready' || st.status === 'paused' || st.status === 'playing';
    if (!isReady && !tr.readyWarned && now >= tr.playAtCtx - 3) {
      tr.readyWarned = true;
      this.log('warn', `Platine ${p.to} pas prête ${Math.max(0, tr.playAtCtx - now).toFixed(1)} s avant son pré-lancement.`);
    }
    if (tr.waitingReady && isReady) {
      tr.waitingReady = false;
      this.prepareIncoming(tr, st, this.baseRate[p.to]);
    }
    if (!tr.playIssued && now >= tr.playAtCtx - tickS * 1.5) {
      if (!isReady) {
        tr.waitingReady = true; // la boucle tiendra le sortant si besoin
      } else {
        tr.playIssued = true;
        const delayMs = Math.max(0, (tr.playAtCtx - now) * 1000);
        const go = () => {
          tr.playIssuedAt = this.d.nowCtx();
          tr.playPos = this.d.decks[p.to].getState().position;
          void deck.play().catch((e) => this.log('error', `Lecture ${p.to} impossible : ${errMsg(e)}`));
        };
        if (delayMs > 5 && this.d.timers) tr.playTimer = this.d.timers.setTimeout(go, delayMs);
        else go();
      }
    }
    // latence réelle de démarrage : du play() au moment où la position avance / le son arrive
    if (tr.playIssuedAt !== undefined && !tr.latencyMeasured && this.incomingRunning(tr)) {
      tr.latencyMeasured = true;
      const measured = now - tr.playIssuedAt;
      if (measured >= 0 && measured < 10) this.d.reportLatency?.(p.to, measured);
    }
    // plus jamais de blanc : l'entrant doit tourner quand il devient audible, sinon on tient le sortant
    if (tr.hold === 'none' && now >= tr.audibleAt - 0.15 && !this.incomingRunning(tr) && this.isAudible(p.from)) {
      this.startHold(tr, now);
    }
    if (tr.hold === 'holding') {
      const spb = 60 / p.bpm;
      if (!this.d.mixer.holdUntil && this.incomingRunning(tr)) {
        // boucle maison (ou pas de boucle) : relâche sur la prochaine mesure
        const t0 = tr.holdStartedAt ?? now;
        const bar = 4 * spb;
        const R = t0 + Math.ceil((now + 0.05 - t0) / bar) * bar;
        this.releaseHold(tr, R);
      } else if (now - (tr.holdStartedAt ?? now) > MAX_HOLD_BEATS * spb + 1) {
        this.failIncoming(tr, 'elle ne démarre pas');
        return;
      }
      if (this.tr !== tr || tr.hold === 'holding') return; // en attente : pas de calage ni de fin
    }

    if (now >= p.startCtx && tr.phase === 'scheduled') tr.phase = 'running';
    if (!tr.startedHistory && now >= p.incomingStartCtx) {
      tr.startedHistory = true;
      this.markStarted(p.to);
    }

    // calage de phase de l'entrant
    if (st.caps.canSetRate && st.status === 'playing' && now >= tr.playAtCtx && this.incomingRunning(tr)) {
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
      if (safeParam(this.d.mixer, `${p.from}.gain` as ParamTarget, 0) < 0.08) {
        if (from.status === 'playing') void this.d.decks[p.from].pause().catch(() => {});
        if (this.d.mixer.isLooping?.(p.from)) this.d.mixer.releaseLoop?.(p.from, now);
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
      (id) =>
        (states[id].status === 'error' || states[id].status === 'ended') &&
        !this.d.mixer.isLooping?.(id) &&
        safeParam(this.d.mixer, `${id}.gain` as ParamTarget, 0) > 0.5,
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
      this.stopScan(id, 'relance d’urgence');
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
    this.fetchSimilar(deck, t);
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
      const skipAt = this.crowd.host?.skipAt;
      if (skipAt && skipAt > this.lastHostSkip) {
        const first = this.lastHostSkip === 0 && this.history.length === 0;
        this.lastHostSkip = skipAt;
        if (!first && this.d.nowMs() - skipAt < 60_000) this.requestSkip('téléphone de l’hôte');
      }
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

/** Décale tout un plan de transition (et ses effets d'accompagnement) dans le temps. */
export function shiftPlan(p: TransitionPlan, shift: number): TransitionPlan {
  if (!shift) return p;
  return {
    ...p,
    startCtx: p.startCtx + shift,
    incomingStartCtx: p.incomingStartCtx + shift,
    accents: (p.accents ?? []).map((c) => ({ ...c, atCtx: c.atCtx + shift })),
  };
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
