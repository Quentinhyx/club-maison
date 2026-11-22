/**
 * Moteur de la console : crée le contexte audio, la table de mixage, les platines (selon le mode),
 * les analyseurs en direct, le cerveau et le chef d'orchestre. Fournit à l'interface ce qu'elle
 * anime à 60 i/s (formes d'onde, vumètres, grille des temps).
 */
import type { DeckController, DeckId, DjSettings, Genre, TrackAnalysis, TrackRef } from '../../shared/contracts';
import { Mixer, PreviewDeck, phaseNudge } from '../../shared/audio/index';
import { LiveAnalyzer, analyzePreview, analyzeBuffer, getCachedAnalysis } from '../../shared/analysis/index';
import { createBrain, DEFAULT_SETTINGS } from '../../shared/brain/index';
import { SynthDeck, listDemoTracks, getDemoBuffer, isDemoTrack, computeWaveform } from '../../shared/demo/index';
import { catalogForGenre, searchTracks } from '../../shared/deezer/index';
import { Conductor, DECK_IDS, type AnalyzerLike } from './conductor';
import { envFetch, envTrack, isExtension } from './lib/env';
import { GuestApi } from './lib/guestApi';
import type { ConsoleSettings, DeckMode } from './lib/storage';
import { DeezerDeck } from './deezer/DeezerDeck';
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
    this.mixer = new Mixer(this.ctx);
    this.mixer.output.connect(this.ctx.destination);
    if (s.outputDeviceId && 'setSinkId' in this.ctx) {
      void (this.ctx as any).setSinkId(s.outputDeviceId).catch(() => {});
    }
    this.decks = {
      A: this.makeDeck('A'),
      B: this.makeDeck('B'),
    };
    this.analyzers = {
      A: new LiveAnalyzer(this.ctx, this.mixer.getDeckTap('A')),
      B: new LiveAnalyzer(this.ctx, this.mixer.getDeckTap('B')),
    };
    this.meters = new Meters(this.ctx, this.mixer);
    this.waves = new WaveformStore(this.ctx, this.mixer, computeWaveform);

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
      catalog: (genre, o) => (demo ? Promise.resolve(demoCatalog(genre, o.bpmMin, o.bpmMax)) : catalogForGenre(genre, { ...o, fetcher: envFetch })),
      analyze: (t) => this.analyze(t),
      cachedAnalysis: (id) => getCachedAnalysis(id),
      fallbackTracks: () => (demo ? listDemoTracks() : []),
      startLatency: (id) => {
        const d = this.decks[id];
        return d instanceof DeezerDeck ? d.startLatency() : 0.02;
      },
      outputLatency: (id) => (this.decks[id] instanceof DeezerDeck ? s.captureLatency : 0),
      timers: { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h as number) },
      guestApi: s.apiUrl ? new GuestApi(s.apiUrl, s.hostKey, s.party) : null,
    });
    for (const id of DECK_IDS) {
      this.decks[id].on((e) => {
        if (e.type === 'track' && e.track) void this.waves.prepare(id, e.track);
      });
    }
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
  async connectDecks(): Promise<void> {
    for (const id of DECK_IDS) {
      if (this.connected[id]) continue;
      try {
        const src = await this.decks[id].getStream();
        this.mixer.connectDeck(id, src);
        this.connected[id] = true;
        delete this.connectErrors[id];
      } catch (e) {
        this.connectErrors[id] = e instanceof Error ? e.message : String(e);
        this.conductor.log('error', `Son de la platine ${id} non capté : ${this.connectErrors[id]}`);
      }
    }
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
      return analyzeBuffer(ch, buf.sampleRate, t);
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

/** Catalogue de la démo hors ligne : morceaux synthétiques du genre, sinon les plus proches en BPM. */
export function demoCatalog(genre: Genre, bpmMin?: number, bpmMax?: number): TrackRef[] {
  const all = listDemoTracks();
  const inRange = (t: TrackRef) => !t.bpm || ((bpmMin ?? 0) <= t.bpm && t.bpm <= (bpmMax ?? 999));
  const same = all.filter((t) => t.genres?.includes(genre));
  const pool = same.filter(inRange).length ? same.filter(inRange) : same.length ? same : all.filter(inRange);
  const res = pool.length ? pool : all;
  return [...res].sort(() => Math.random() - 0.5);
}
