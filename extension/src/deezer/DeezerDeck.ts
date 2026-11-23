/**
 * Platine Deezer côté console : pilote le lecteur web officiel d'un onglet www.deezer.com via le
 * service worker, et récupère son son (capture d'onglet ou périphérique virtuel).
 * Le son n'est jamais téléchargé ni déchiffré : on commande le lecteur et on mixe sa sortie.
 */
import type { DeckCapabilities, DeckController, DeckEvent, DeckId, DeckState, TrackRef } from '../../../shared/contracts';
import type { ConsoleSettings } from '../lib/storage';
import { getBridge, type ExtBridge } from './bridge';
import { captureDevice, captureTab } from './capture';
import type { TabSnapshot } from './protocol';

const DEFAULT_CAPS: DeckCapabilities = { canSeek: false, canSetRate: false, preservesPitch: true, maxRateDelta: 0.08 };

export class DeezerDeck implements DeckController {
  private bridge: ExtBridge;
  private state: DeckState;
  private snap?: TabSnapshot;
  private listeners = new Set<(e: DeckEvent) => void>();
  private stream?: MediaStream;
  private streamTab?: number;
  private latency = 0.45; // estimation initiale du démarrage (s), affinée à chaque play()
  private off: () => void;

  constructor(
    readonly id: DeckId,
    _ctx: AudioContext,
    private settings: ConsoleSettings,
  ) {
    this.bridge = getBridge();
    this.state = { id, status: 'empty', position: 0, duration: 0, rate: 1, caps: { ...DEFAULT_CAPS } };
    this.off = this.bridge.onEvent((deck, _tab, evt) => {
      if (deck !== this.id) return;
      if (evt.type === 'state') this.applySnapshot(evt.state);
    });
  }

  private emit(e: DeckEvent): void {
    for (const l of this.listeners) l(e);
  }

  private applySnapshot(s: TabSnapshot): void {
    const prev = this.state;
    this.snap = s;
    const capsChanged = JSON.stringify(prev.caps) !== JSON.stringify(s.caps);
    let status = s.status;
    // pendant un chargement, l'onglet peut passer par "playing" (lecture muette) : on garde "loading"
    if (prev.status === 'loading' && status !== 'error') status = 'loading';
    this.state = { ...prev, status, position: s.position, duration: s.duration || prev.duration, rate: s.rate, caps: s.caps, error: s.error };
    if (capsChanged) this.emit({ type: 'caps', deck: this.id, caps: s.caps });
    if (status !== prev.status) this.emit({ type: 'status', deck: this.id, status, error: s.error });
    this.emit({ type: 'position', deck: this.id, position: s.position, duration: this.state.duration, rate: s.rate });
  }

  private setStatus(status: DeckState['status'], error?: string): void {
    this.state = { ...this.state, status, error };
    this.emit({ type: 'status', deck: this.id, status, error });
  }

  async load(track: TrackRef, startAt = 0): Promise<void> {
    this.state = { ...this.state, track, duration: track.duration, position: startAt };
    this.emit({ type: 'track', deck: this.id, track });
    this.setStatus('loading');
    try {
      await this.bridge.command(
        this.id,
        { op: 'load', track: { id: track.id, title: track.title, artist: track.artist, duration: track.duration }, startAt },
        45_000,
      );
      this.setStatus('ready');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setStatus('error', msg);
      throw e;
    }
  }

  async play(): Promise<void> {
    const sent = Date.now();
    const r = await this.bridge.command<{ startedWall?: number }>(this.id, { op: 'play' }, 8000);
    if (r?.startedWall) {
      const measured = Math.max(0, (r.startedWall - sent) / 1000) + this.settings.captureLatency;
      if (measured < 3) this.latency = this.latency * 0.6 + measured * 0.4;
    }
    this.state = { ...this.state, status: 'playing' };
  }

  async pause(): Promise<void> {
    await this.bridge.command(this.id, { op: 'pause' }, 5000);
  }

  async seek(position: number): Promise<void> {
    await this.bridge.command(this.id, { op: 'seek', position }, 6000);
  }

  async setRate(rate: number): Promise<void> {
    if (!this.state.caps.canSetRate) return;
    this.state = { ...this.state, rate };
    await this.bridge.command(this.id, { op: 'rate', rate }, 3000);
  }

  /** Latence mesurée par le chef d'orchestre (position qui avance / son capté). */
  recordLatency(seconds: number): void {
    const m = seconds + this.settings.captureLatency;
    if (m > 0 && m < 5) this.latency = this.latency * 0.5 + m * 0.5;
  }

  /** Latence de démarrage mesurée (s) : de play() au son capté dans la console. */
  startLatency(): number {
    return this.latency;
  }

  getState(): DeckState {
    const s = this.state;
    if (s.status === 'playing' && this.snap) {
      // extrapolation entre deux rapports de position (4 par seconde)
      const dt = Math.max(0, Math.min(2, (Date.now() - this.snap.wall) / 1000));
      return { ...s, position: Math.min(s.duration || Infinity, this.snap.position + dt * (this.snap.rate || 1)) };
    }
    return { ...s };
  }

  async getStream(): Promise<MediaStream> {
    if (this.settings.captureMode === 'device') {
      const label = this.id === 'A' ? this.settings.deviceLabelA : this.settings.deviceLabelB;
      if (!this.stream) {
        this.stream = await captureDevice(label);
        // demande à l'onglet Deezer d'envoyer son son vers ce périphérique
        await this.bridge.command(this.id, { op: 'setSink', label }, 15_000).catch(() => {});
      }
      return this.stream;
    }
    let tabId = this.bridge.assignment[this.id];
    if (tabId === undefined) {
      await this.bridge.waitTabs(1500);
      tabId = this.bridge.assignment[this.id];
    }
    if (tabId === undefined) {
      throw new Error(
        this.id === 'A'
          ? 'Aucun onglet Deezer pour la platine A : ouvre www.deezer.com dans une fenêtre normale (compte 1).'
          : 'Aucun onglet Deezer pour la platine B : ouvre www.deezer.com dans une fenêtre de navigation privée (compte 2).',
      );
    }
    if (this.stream && this.streamTab === tabId && this.stream.getAudioTracks().some((t) => t.readyState === 'live')) {
      return this.stream;
    }
    this.stream = await captureTab(tabId);
    this.streamTab = tabId;
    return this.stream;
  }

  on(listener: (e: DeckEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.off();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.listeners.clear();
  }
}
