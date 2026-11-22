/**
 * Club Maison : platine de démo (lecture d'un AudioBuffer synthétique).
 * Le calage du tempo passe par playbackRate : la hauteur suit le tempo (preservesPitch = false),
 * comme une vraie platine vinyle sans « master tempo ».
 */
import type { DeckCapabilities, DeckController, DeckEvent, DeckId, DeckState, DeckStatus, TrackRef } from '../contracts';
import { getDemoBuffer, isDemoTrack } from './buffer';

/** ±30 % : la démo sert aussi à tester les re-edits (morceau lent accéléré). preservesPitch = false :
 *  AudioBufferSourceNode.playbackRate change aussi la hauteur (+30 % ≈ +4,5 demi-tons). */
const CAPS: DeckCapabilities = { canSeek: true, canSetRate: true, preservesPitch: false, maxRateDelta: 0.3 };

export class SynthDeck implements DeckController {
  static readonly CAPS: Readonly<DeckCapabilities> = CAPS;
  readonly id: DeckId;
  private readonly ctx: AudioContext;
  private readonly out: GainNode;
  private buffer?: AudioBuffer;
  private src?: AudioBufferSourceNode;
  private status: DeckStatus = 'empty';
  private track?: TrackRef;
  private error?: string;
  private rate = 1;
  private basePos = 0;      // position (s) à l'instant baseCtx
  private baseCtx = 0;
  private playing = false;
  private loadToken = 0;
  private timer?: ReturnType<typeof setInterval>;
  private readonly listeners = new Set<(e: DeckEvent) => void>();

  constructor(id: DeckId, ctx: AudioContext) {
    this.id = id;
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 1;
  }

  private get duration(): number {
    return this.buffer?.duration ?? this.track?.duration ?? 0;
  }

  private position(): number {
    const p = this.playing ? this.basePos + (this.ctx.currentTime - this.baseCtx) * this.rate : this.basePos;
    return Math.max(0, Math.min(this.duration, p));
  }

  private emit(e: DeckEvent): void {
    for (const l of this.listeners) {
      try { l(e); } catch (err) { console.error('[SynthDeck] listener', err); }
    }
  }

  private setStatus(s: DeckStatus, error?: string): void {
    this.status = s;
    this.error = error;
    this.emit({ type: 'status', deck: this.id, status: s, error });
  }

  private emitPosition(): void {
    this.emit({ type: 'position', deck: this.id, position: this.position(), duration: this.duration, rate: this.rate });
  }

  private stopSource(): void {
    const s = this.src;
    this.src = undefined;
    if (s) {
      s.onended = null;
      try { s.stop(); } catch { /* déjà arrêtée */ }
      s.disconnect();
    }
  }

  private startSource(): void {
    if (!this.buffer) return;
    this.stopSource();
    const s = this.ctx.createBufferSource();
    s.buffer = this.buffer;
    s.playbackRate.value = this.rate;
    s.connect(this.out);
    s.onended = () => { if (this.src === s && this.playing) this.finish(); };
    this.baseCtx = this.ctx.currentTime;
    s.start(0, Math.min(this.basePos, Math.max(0, this.buffer.duration - 1e-3)));
    this.src = s;
  }

  private finish(): void {
    this.basePos = this.duration;
    this.playing = false;
    this.stopSource();
    this.stopTimer();
    this.emitPosition();
    this.setStatus('ended');
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => {
      if (!this.playing) return;
      if (this.position() >= this.duration - 0.005) { this.finish(); return; }
      this.emitPosition();
    }, 100);
  }

  private stopTimer(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  async load(track: TrackRef, startAt = 0): Promise<void> {
    const token = ++this.loadToken;
    this.playing = false;
    this.stopSource();
    this.stopTimer();
    this.buffer = undefined;
    this.track = track;
    this.rate = 1;
    this.basePos = 0;
    this.emit({ type: 'track', deck: this.id, track });
    this.emit({ type: 'caps', deck: this.id, caps: CAPS });
    this.setStatus('loading');
    if (!isDemoTrack(track.id)) {
      this.setStatus('error', `SynthDeck ne lit que les morceaux de démo (id ${track.id})`);
      throw new Error(this.error);
    }
    try {
      // laisse le temps à l'UI d'afficher « chargement » avant le rendu (qui bloque ~1 s)
      await new Promise((r) => setTimeout(r, 0));
      const buf = await getDemoBuffer(track.id, this.ctx);
      if (token !== this.loadToken) return;
      this.buffer = buf;
      this.basePos = Math.max(0, Math.min(buf.duration, startAt));
      this.setStatus('ready');
      this.emitPosition();
    } catch (err) {
      if (token !== this.loadToken) return;
      this.setStatus('error', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async play(): Promise<void> {
    if (!this.buffer || this.playing) return;
    if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch { /* geste requis */ } }
    if (this.basePos >= this.duration - 0.005) this.basePos = 0;
    this.playing = true;
    this.startSource();
    this.startTimer();
    this.setStatus('playing');
    this.emitPosition();
  }

  async pause(): Promise<void> {
    if (!this.playing) return;
    this.basePos = this.position();
    this.playing = false;
    this.stopSource();
    this.stopTimer();
    this.setStatus('paused');
    this.emitPosition();
  }

  async seek(position: number): Promise<void> {
    if (!this.buffer) return;
    this.basePos = Math.max(0, Math.min(this.duration, position));
    if (this.playing) this.startSource();
    else if (this.status === 'ended') this.setStatus('paused');
    this.emitPosition();
  }

  async setRate(rate: number): Promise<void> {
    const r = Math.max(1 - CAPS.maxRateDelta, Math.min(1 + CAPS.maxRateDelta, rate));
    if (this.playing) {
      // re-base : la position avant le changement suit l'ancien rate
      this.basePos = this.position();
      this.baseCtx = this.ctx.currentTime;
    }
    this.rate = r;
    if (this.src) this.src.playbackRate.setValueAtTime(r, this.ctx.currentTime);
    this.emitPosition();
  }

  getState(): DeckState {
    return {
      id: this.id, status: this.status, track: this.track, position: this.position(),
      duration: this.duration, rate: this.rate, caps: { ...CAPS }, error: this.error,
    };
  }

  async getStream(): Promise<AudioNode> {
    return this.out;
  }

  on(listener: (e: DeckEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose(): void {
    this.loadToken++;
    this.playing = false;
    this.stopSource();
    this.stopTimer();
    this.listeners.clear();
    this.out.disconnect();
  }
}
