/**
 * Platine de démo : joue l'extrait de 30 s (track.preview) dans un HTMLAudioElement branché
 * sur l'AudioContext fourni. Sert au mode démo et aux essais sans Deezer.
 */
import type {
  DeckCapabilities, DeckController, DeckEvent, DeckId, DeckState, DeckStatus, TrackRef,
} from '../contracts';

const CAPS: DeckCapabilities = { canSeek: true, canSetRate: true, preservesPitch: true, maxRateDelta: 0.08 };

export class PreviewDeck implements DeckController {
  readonly id: DeckId;
  private readonly ctx: AudioContext;
  private readonly el: HTMLAudioElement;
  private readonly src: MediaElementAudioSourceNode;
  private readonly out: GainNode;
  private readonly listeners = new Set<(e: DeckEvent) => void>();
  private status: DeckStatus = 'empty';
  private track?: TrackRef;
  private error?: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private loadSeq = 0;
  private disposed = false;
  private readonly onEnded = () => {
    this.stopTimer();
    this.emitPosition();
    this.setStatus('ended');
  };
  private readonly onError = () => {
    if (!this.el.getAttribute('src')) return;
    this.setStatus('error', `Lecture de l'extrait impossible (${this.el.error?.message || this.el.error?.code || 'inconnu'})`);
  };

  constructor(id: DeckId, ctx: AudioContext) {
    this.id = id;
    this.ctx = ctx;
    this.el = new Audio();
    this.el.crossOrigin = 'anonymous';
    this.el.preload = 'auto';
    this.el.preservesPitch = true;
    this.src = ctx.createMediaElementSource(this.el);
    this.out = new GainNode(ctx, { gain: 1 });
    this.src.connect(this.out);
    this.el.addEventListener('ended', this.onEnded);
    this.el.addEventListener('error', this.onError);
  }

  async load(track: TrackRef, startAt = 0): Promise<void> {
    if (this.disposed) throw new Error('PreviewDeck détruite');
    const seq = ++this.loadSeq;
    this.stopTimer();
    this.el.pause();
    this.track = track;
    this.emit({ type: 'track', deck: this.id, track });
    if (!track.preview) {
      this.setStatus('error', "Ce morceau n'a pas d'extrait");
      throw new Error("Ce morceau n'a pas d'extrait");
    }
    this.setStatus('loading');
    this.el.src = track.preview;
    this.el.playbackRate = 1;
    this.el.preservesPitch = true;
    try {
      await waitFor(this.el, 'loadedmetadata', 15000);
      if (seq !== this.loadSeq) return;
      const dur = Number.isFinite(this.el.duration) ? this.el.duration : 30;
      const pos = Math.max(0, Math.min(startAt, Math.max(0, dur - 0.5)));
      if (pos > 0) {
        this.el.currentTime = pos;
        await waitFor(this.el, 'seeked', 5000).catch(() => undefined);
      }
      if (this.el.readyState < 3) await waitFor(this.el, 'canplay', 15000);
      if (seq !== this.loadSeq) return;
      this.setStatus('ready');
      this.emitPosition();
    } catch (e) {
      if (seq !== this.loadSeq) return;
      const msg = e instanceof Error ? e.message : String(e);
      this.setStatus('error', msg);
      throw e;
    }
  }

  async play(): Promise<void> {
    if (!this.el.getAttribute('src')) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => undefined);
    await this.el.play();
    this.setStatus('playing');
    this.startTimer();
  }

  async pause(): Promise<void> {
    this.el.pause();
    this.stopTimer();
    if (this.status === 'playing') this.setStatus('paused');
    this.emitPosition();
  }

  async seek(position: number): Promise<void> {
    const dur = Number.isFinite(this.el.duration) ? this.el.duration : 30;
    this.el.currentTime = Math.max(0, Math.min(position, dur));
    this.emitPosition();
  }

  async setRate(rate: number): Promise<void> {
    const r = Math.max(1 - CAPS.maxRateDelta, Math.min(1 + CAPS.maxRateDelta, Number.isFinite(rate) ? rate : 1));
    this.el.preservesPitch = true;
    this.el.playbackRate = r;
    this.emitPosition();
  }

  getState(): DeckState {
    return {
      id: this.id,
      status: this.status,
      track: this.track,
      position: this.el.currentTime || 0,
      duration: Number.isFinite(this.el.duration) ? this.el.duration : 0,
      rate: this.el.playbackRate,
      caps: { ...CAPS },
      error: this.error,
    };
  }

  /** Nœud audio de la platine (même AudioContext que celui passé au constructeur). */
  async getStream(): Promise<MediaStream | AudioNode> {
    return this.out;
  }

  on(listener: (e: DeckEvent) => void): () => void {
    this.listeners.add(listener);
    listener({ type: 'caps', deck: this.id, caps: { ...CAPS } });
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loadSeq++;
    this.stopTimer();
    this.el.pause();
    this.el.removeEventListener('ended', this.onEnded);
    this.el.removeEventListener('error', this.onError);
    this.el.removeAttribute('src');
    this.el.load();
    try {
      this.src.disconnect();
      this.out.disconnect();
    } catch {
      /* rien */
    }
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------------------------

  private emit(e: DeckEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        /* un écouteur fautif ne casse pas la platine */
      }
    }
  }

  private setStatus(status: DeckStatus, error?: string): void {
    this.status = status;
    this.error = error;
    this.emit(error ? { type: 'status', deck: this.id, status, error } : { type: 'status', deck: this.id, status });
  }

  private emitPosition(): void {
    this.emit({
      type: 'position',
      deck: this.id,
      position: this.el.currentTime || 0,
      duration: Number.isFinite(this.el.duration) ? this.el.duration : 0,
      rate: this.el.playbackRate,
    });
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => this.emitPosition(), 250);
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

function waitFor(el: HTMLMediaElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (fn: () => void) => {
      clearTimeout(timer);
      el.removeEventListener(event, ok);
      el.removeEventListener('error', ko);
      fn();
    };
    const ok = () => done(resolve);
    const ko = () => done(() => reject(new Error(`Erreur de chargement de l'extrait (${el.error?.code ?? '?'})`)));
    const timer = setTimeout(() => done(() => reject(new Error(`Délai dépassé (${event})`))), timeoutMs);
    el.addEventListener(event, ok, { once: true });
    el.addEventListener('error', ko, { once: true });
  });
}
