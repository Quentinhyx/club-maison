/**
 * Moteur de la console : crée le contexte audio, la table de mixage, les platines (selon le mode),
 * les analyseurs en direct, le cerveau et le chef d'orchestre. Fournit à l'interface ce qu'elle
 * anime à 60 i/s (formes d'onde, vumètres, grille des temps).
 */
import type { DeckController, DeckId, DjSettings, Genre, TrackAnalysis, TrackRef } from '../../shared/contracts';
import { Mixer, PreviewDeck, phaseNudge, rateRamp } from '../../shared/audio/index';
import { LiveAnalyzer, analyzePreview, analyzeBuffer, getCachedAnalysis } from '../../shared/analysis/index';
import { createBrain, DEFAULT_SETTINGS, GENRE_GRAPH } from '../../shared/brain/index';
import { TrackScanner, structureFromWaveform } from '../../shared/analysis/structure';
import { SynthDeck, listDemoTracks, getDemoBuffer, isDemoTrack, computeWaveformAsync } from '../../shared/demo/index';
import { catalogForGenre, searchTracks, similarTracks } from '../../shared/deezer/index';
import { Conductor, DECK_IDS, type AnalyzerLike } from './conductor';
import { envFetch, envTrack, isExtension } from './lib/env';
import { GuestApi } from './lib/guestApi';
import type { ConsoleSettings, DeckMode } from './lib/storage';
import { DeezerDeck } from './deezer/DeezerDeck';
import { getBridge } from './deezer/bridge';
import { Meters } from './meters';
import { WaveformStore } from './waveforms';

export const MODE_LABELS: Record<DeckMode, string> = {
  synth: 'Démo hors ligne',
  preview: 'Démo Deezer (extraits 30 s)',
  deezer: 'Deezer (deux comptes)',
};

/** Enveloppe une platine pour réécrire l'URL d'extrait (proxy local hors extension). */
class EnvDeck implements DeckController {
  constructor(private inner: DeckController) {}
  get id() {
    return this.inner.id;
  }
  load(t: TrackRef, s?: number) {
    return this.inner.load(envTrack(t), s);
  }
  play() {
    return this.inner.play();
  }
  pause() {
    return this.inner.pause();
  }
  seek(p: number) {
    return this.inner.seek(p);
  }
  setRate(r: number) {
    return this.inner.setRate(r);
  }
  getState() {
    return this.inner.getState();
  }
  getStream() {
    return this.inner.getStream();
  }
  on(l: Parameters<DeckController['on']>[0]) {
    return this.inner.on(l);
  }
  dispose() {
    this.inner.dispose();
  }
}

export interface EngineOptions {
  settings: ConsoleSettings;
  fast?: boolean;
}

export class Engine {
  readonly ctx: AudioContext;
  readonly mixer: Mixer;
  readonly decks: Record<DeckId, DeckController>;
  readonly analyzers: Record<DeckId, LiveAnalyzer | AnalyzerLike>;
  readonly conductor: Conductor;
  readonly meters: Meters;
  readonly waves: WaveformStore;
  readonly mode: DeckMode;
  private connected: Record<DeckId, boolean> = { A: false, B: false };
  connectErrors: Partial<Record<DeckId, string>> = {};

  constructor(private opts: EngineOptions) {
    const s = opts.settings;
    this.mode = !isExtension && s.deckMode === 'deezer' ? 'synth' : s.deckMode;
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    // extension MV3 : les worklets (analyse, échantillonneur de boucles) sont de vrais fichiers du build,
    // car la CSP refuse les Blob URL ; en localhost, les modules gardent leurs Blob URL.
    const mixerWorklet = isExtension ? chrome.runtime.getURL('worklets/loop.js') : undefined;
    this.mixer = new Mixer(this.ctx, { workletUrl: mixerWorklet });
    this.mixer.output.connect(this.ctx.destination);
    if (s.outputDeviceId && 'setSinkId' in this.ctx) {
      void (this.ctx as any).setSinkId(s.outputDeviceId).catch(() => {});
    }
    this.decks = {
      A: this.makeDeck('A'),
      B: this.makeDeck('B'),
    };
    const liveWorklet = isExtension ? chrome.runtime.getURL('worklets/live-capture.js') : undefined;
    this.analyzers = {
      A: new LiveAnalyzer(this.ctx, this.mixer.getDeckTap('A'), { workletUrl: liveWorklet }),
      B: new LiveAnalyzer(this.ctx, this.mixer.getDeckTap('B'), { workletUrl: liveWorklet }),
    };
    this.meters = new Meters(this.ctx, this.mixer);
    this.waves = new WaveformStore(this.ctx, this.mixer, computeWaveformAsync);

    const settings: DjSettings = { ...DEFAULT_SETTINGS, ...(s.dj ?? {}) };
    if (opts.fast) Object.assign(settings, { minPlaySeconds: 25, maxPlaySeconds: 40 });

    const demo = this.mode === 'synth';
    this.conductor = new Conductor({
      nowCtx: () => this.ctx.currentTime,
      nowMs: () => Date.now(),
      mixer: this.mixer,
      decks: this.decks,
      analyzers: this.analyzers,
      brain: createBrain(),
      settings,
      phaseNudge,
      rateRamp,
      catalog: (genre, o) => (demo ? Promise.resolve(demoCatalog(genre, o.bpmMin, o.bpmMax)) : catalogForGenre(genre, { ...o, fetcher: envFetch })),
      analyze: (t) => this.analyze(t),
      cachedAnalysis: (id) => getCachedAnalysis(id),
      fallbackTracks: () => (demo ? listDemoTracks() : []),
      startLatency: (id) => {
        const d = this.decks[id];
        return d instanceof DeezerDeck ? d.startLatency() : 0.02;
      },
      similar: (t) => (demo ? Promise.resolve(demoSimilar(t)) : similarTracks(t, { limit: 30, fetcher: envFetch })),
      scan:
        this.mode === 'deezer'
          ? {
              supported: (id) => this.decks[id] instanceof DeezerDeck,
              sampleRate: this.ctx.sampleRate,
              create: (o) => new TrackScanner({ ...o, pointsPerSecond: 40 }),
              capture: (id, onFrame) => this.capturePcm(id, onFrame),
            }
          : undefined,
      deckHealth: (id) => {
        const d = this.decks[id];
        return d instanceof DeezerDeck ? d.health() : {};
      },
      reconnect: (id) => this.reconnect(id),
      reportLatency: (id, s2) => {
        const d = this.decks[id];
        if (d instanceof DeezerDeck) d.recordLatency(s2);
      },
      outputLatency: (id) => (this.decks[id] instanceof DeezerDeck ? s.captureLatency : 0),
      timers: { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h as number) },
      guestApi: s.apiUrl ? new GuestApi(s.apiUrl, s.hostKey, s.party) : null,
    });
    if (this.mode === 'deezer') {
      getBridge().onEvent((deck, _tab, evt) => {
        if (evt.type === 'log') this.conductor.log('warn', `${deck ? `Platine ${deck} : ` : ''}${evt.msg}`);
      });
    }
    this.waves.external = (id) => this.conductor.getWaveform(id);
    // veille, enceinte débranchée : le contexte audio passe en pause -> on tente de relancer
    this.ctx.onstatechange = () => {
      const st = this.ctx.state as string;
      if ((st === 'suspended' || st === 'interrupted') && this.conductor.isRunning()) {
        this.conductor.log('warn', 'Le son est en pause (veille ou sortie audio perdue) : tentative de relance.');
        void this.ctx.resume().catch(() => {});
      }
      this.emitStatus();
    };
    if (this.mode === 'deezer') {
      // un onglet de platine revient (rechargement, nouvel onglet) : on rebranche sa capture
      let prev: Partial<Record<DeckId, number>> = {};
      getBridge().onTabs((_tabs, asg) => {
        for (const id of DECK_IDS) {
          const t = asg[id];
          if (t !== undefined && (t !== prev[id] || this.conductor.isDead(id) || this.connectErrors[id]) && this.conductor.isRunning()) {
            void this.reconnect(id);
          }
        }
        prev = { ...asg };
      });
    }
    for (const id of DECK_IDS) {
      this.decks[id].on((e) => {
        if (e.type === 'track' && e.track) void this.waves.prepare(id, e.track);
      });
    }
  }

  /** Capture PCM mono de la sortie (avant fader) d'une platine, pour la pré-écoute accélérée. */
  private capturePcm(id: DeckId, onFrame: (frame: Float32Array, endCtx: number) => void): () => void {
    const tap = this.mixer.getDeckTap(id);
    const sp = this.ctx.createScriptProcessor(4096, 2, 1);
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    sp.onaudioprocess = (e) => {
      const L = e.inputBuffer.getChannelData(0);
      const R = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : L;
      const m = new Float32Array(L.length);
      for (let i = 0; i < L.length; i++) m[i] = 0.5 * (L[i] + R[i]);
      onFrame(m, this.ctx.currentTime);
    };
    tap.connect(sp);
    sp.connect(mute);
    mute.connect(this.ctx.destination);
    return () => {
      sp.onaudioprocess = null;
      try {
        tap.disconnect(sp);
      } catch {
        /* déjà débranché */
      }
      sp.disconnect();
      mute.disconnect();
    };
  }

  private makeDeck(id: DeckId): DeckController {
    switch (this.mode) {
      case 'deezer':
        return new DeezerDeck(id, this.ctx, this.opts.settings);
      case 'preview':
        return new EnvDeck(new PreviewDeck(id, this.ctx));
      default:
        return new SynthDeck(id, this.ctx);
    }
  }

  /** Branche le son des platines sur la table (à refaire si un onglet Deezer change). */
  async connectDecks(only?: DeckId): Promise<void> {
    for (const id of DECK_IDS) {
      if (only && id !== only) continue;
      if (this.connected[id]) continue;
      try {
        const src = await this.decks[id].getStream();
        this.mixer.connectDeck(id, src);
        this.connected[id] = true;
        delete this.connectErrors[id];
      } catch (e) {
        this.connectErrors[id] = e instanceof Error ? e.message : String(e);
        // la soirée tourne sur l'autre platine ; un bandeau dit quoi faire
        this.conductor.markDead(id, `son non capté (${this.connectErrors[id]})`);
      }
      this.emitStatus();
    }
  }

  /** Rebranche le son d'une platine (bouton « Reconnecter », retour d'un onglet, platine HS). */
  private reconnectAt: Partial<Record<DeckId, number>> = {};
  private reconnectBusy = new Set<DeckId>();

  async reconnect(id: DeckId): Promise<boolean> {
    if (this.reconnectBusy.has(id) || Date.now() - (this.reconnectAt[id] ?? 0) < 3000) return this.connected[id];
    this.reconnectBusy.add(id);
    this.reconnectAt[id] = Date.now();
    try {
      return await this.reconnectNow(id);
    } finally {
      this.reconnectBusy.delete(id);
    }
  }

  private async reconnectNow(id: DeckId): Promise<boolean> {
    const d = this.decks[id];
    if (d instanceof DeezerDeck) d.dropStream();
    this.connected[id] = false;
    await this.connectDecks(id);
    return this.connected[id];
  }

  // ------------------------------------------------------------------ état du son (veille, enceinte)
  private statusListeners = new Set<() => void>();
  onStatus(fn: () => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }
  private emitStatus(): void {
    for (const f of this.statusListeners) f();
  }
  /** État du contexte audio : 'running', 'suspended', 'interrupted' (veille, sortie audio perdue)… */
  audioState(): string {
    return this.ctx.state as string;
  }
  async resumeAudio(): Promise<void> {
    try {
      await this.ctx.resume();
    } catch {
      /* il faudra un clic */
    }
    this.emitStatus();
  }

  resetConnection(id: DeckId): void {
    this.connected[id] = false;
  }

  isConnected(id: DeckId): boolean {
    return this.connected[id];
  }

  async analyze(t: TrackRef): Promise<TrackAnalysis> {
    if (isDemoTrack(t.id)) {
      const buf = await getDemoBuffer(t.id, this.ctx);
      // comme pour un extrait Deezer : 30 s prises au tiers du morceau (analyse rapide, pas de gel de l'interface)
      const sr = buf.sampleRate;
      const from = Math.min(Math.max(0, buf.length - 30 * sr), Math.floor(buf.length / 3));
      const ch = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i).subarray(from, from + 30 * sr));
      const a = analyzeBuffer(ch, buf.sampleRate, t);
      // même information qu'après une pré-écoute Deezer : structure du morceau complet (drops, outro…)
      try {
        const wf = await computeWaveformAsync(buf, 50);
        const structure = structureFromWaveform({ trackId: t.id, low: wf.low, mid: wf.mid, high: wf.high, peak: wf.peak, pointsPerSecond: 50, coverage: 1 }, a.bpm);
        if (structure) return { ...a, structure };
      } catch {
        /* structure facultative */
      }
      return a;
    }
    return analyzePreview(this.ctx, envTrack(t), envFetch);
  }

  async search(q: string): Promise<TrackRef[]> {
    if (this.mode === 'synth') {
      const n = norm(q);
      return listDemoTracks().filter((t) => norm(`${t.title} ${t.artist} ${(t.genres ?? []).join(' ')}`).includes(n));
    }
    return searchTracks(q, { limit: 25, fetcher: envFetch });
  }

  async start(): Promise<void> {
    await this.ctx.resume();
    await this.mixer.ready.catch(() => {});
    await this.connectDecks();
    this.conductor.start();
  }

  dispose(): void {
    this.conductor.stop();
    for (const id of DECK_IDS) {
      this.decks[id].dispose();
      (this.analyzers[id] as LiveAnalyzer).dispose?.();
    }
    this.mixer.dispose();
    void this.ctx.close();
  }
}

function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

/** Similaires en démo hors ligne : même genre ou genres voisins, tempo à ±6 %. */
export function demoSimilar(t: TrackRef): TrackRef[] {
  const g = t.genres ?? [];
  const near = new Set<Genre>(g);
  for (const x of g) for (const n of Object.keys(GENRE_GRAPH[x] ?? {})) near.add(n as Genre);
  const bpm = t.bpm ?? 0;
  return listDemoTracks().filter(
    (o) => o.id !== t.id && (o.genres ?? []).some((x) => near.has(x)) && (!bpm || !o.bpm || Math.abs(o.bpm / bpm - 1) <= 0.06),
  );
}

/** Catalogue de la démo hors ligne : morceaux synthétiques du genre, sinon les plus proches en BPM. */
export function demoCatalog(genre: Genre, bpmMin?: number, bpmMax?: number): TrackRef[] {
  const all = listDemoTracks();
  const inRange = (t: TrackRef) => !t.bpm || ((bpmMin ?? 0) <= t.bpm && t.bpm <= (bpmMax ?? 999));
  const same = all.filter((t) => t.genres?.includes(genre));
  const pool = same.filter(inRange).length ? same.filter(inRange) : same.length ? same : all.filter(inRange);
  const res = pool.length ? pool : all;
  return [...res].sort(() => Math.random() - 0.5);
}
