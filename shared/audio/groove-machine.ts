/**
 * Boîte à rythmes synthétisée (Web Audio) pour les re-edits. Planificateur à anticipation
 * (« A Tale of Two Clocks ») : un minuteur JS toutes les 25 ms programme, à l'échantillon près sur
 * l'horloge audio, les événements des 100 ms à venir (grooveSchedule, pur).
 *
 * Niveau : crête ~ -6 dBFS (kick à pleine vélocité) à la sortie, comme une platine avant fader.
 */
import type { GroovePlan, GrooveStyle } from '../contracts';
import { grooveSchedule, midiToHz, retimeGroove, type GrooveEvent } from './groove';

export const GROOVE_LOOKAHEAD = 0.1;
export const GROOVE_TICK_MS = 25;

interface KickVoice { f0: number; f1: number; pitchT: number; decay: number; click: number; drive: boolean }
const KICKS: Record<GrooveStyle, KickVoice> = {
  house: { f0: 140, f1: 48, pitchT: 0.05, decay: 0.38, click: 0.3, drive: false },
  'tech-house': { f0: 165, f1: 50, pitchT: 0.035, decay: 0.26, click: 0.5, drive: false },
  disco: { f0: 120, f1: 52, pitchT: 0.06, decay: 0.3, click: 0.2, drive: false },
  'afro-house': { f0: 130, f1: 47, pitchT: 0.05, decay: 0.36, click: 0.25, drive: false },
  techno: { f0: 190, f1: 45, pitchT: 0.045, decay: 0.5, click: 0.6, drive: true },
};
const BASS_CUTOFF: Record<GrooveStyle, number> = {
  house: 380, 'tech-house': 300, disco: 650, 'afro-house': 350, techno: 250,
};
/** Niveau relatif de chaque partie (le kick fait la crête). */
const LEVEL: Record<string, number> = {
  kick: 1, clap: 0.45, hat: 0.16, openhat: 0.2, perc: 0.35, rumble: 0.4, bass: 0.42,
};

interface Segment { plan: GroovePlan; until: number }

export class GrooveMachine {
  /** Sortie de la machine (à brancher sur le canal groove de la table). */
  readonly output: GainNode;
  private readonly ctx: AudioContext;
  private readonly bus: GainNode;
  private readonly drive: GainNode; // entrée de la saturation (pré-atténuée)
  private readonly shaper: WaveShaperNode;
  private readonly noise: AudioBuffer;
  private segments: Segment[] = [];
  private cursor = 0;
  private stopAt = Infinity;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.output = new GainNode(ctx, { gain: 0.5 });
    const safety = new WaveShaperNode(ctx, { curve: softClip(), oversample: '2x' });
    this.bus = new GainNode(ctx, { gain: 1 });
    this.bus.connect(safety).connect(this.output);
    // la saturation tanh amplifie ~2,2x les petits signaux : on compense en entrée
    this.drive = new GainNode(ctx, { gain: 0.45 });
    this.shaper = new WaveShaperNode(ctx, { curve: driveCurve(2.2), oversample: '2x' });
    this.drive.connect(this.shaper).connect(this.bus);
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** Plan en cours à l'instant t (le dernier segment commencé). */
  currentPlan(t = this.ctx.currentTime): GroovePlan | undefined {
    let cur: GroovePlan | undefined;
    for (const s of this.segments) if (s.plan.startCtx <= t || !cur) cur = s.plan;
    return cur;
  }

  start(plan: GroovePlan): void {
    if (this.disposed) return;
    if (this.timer && this.segments.length > 0 && this.stopAt === Infinity) {
      // Déjà en marche (construction du groove : on ajoute des parties) : le nouveau motif prend le
      // relais à son startCtx, sans redémarrer ni rejouer les coups déjà programmés.
      while (this.segments.length > 1 && this.segments[this.segments.length - 1].plan.startCtx > this.cursor) {
        this.segments.pop();
      }
      const switchAt = Math.max(plan.startCtx, this.cursor);
      this.segments[this.segments.length - 1].until = switchAt;
      this.segments.push({ plan: { ...plan, startCtx: switchAt }, until: Infinity });
      return;
    }
    this.segments = [{ plan, until: Infinity }];
    this.stopAt = Infinity;
    this.cursor = Math.max(plan.startCtx, this.ctx.currentTime);
    if (!this.timer) this.timer = setInterval(() => this.tick(), GROOVE_TICK_MS);
    this.tick();
  }

  /** Recalage tempo/phase, appliqué au prochain temps de la grille actuelle. */
  retime(bpm: number, anchorCtx: number): void {
    if (this.disposed || this.segments.length === 0 || !(bpm > 0) || !Number.isFinite(anchorCtx)) return;
    // un segment pas encore commencé est remplacé, pas empilé
    while (this.segments.length > 1 && this.segments[this.segments.length - 1].plan.startCtx > this.cursor) {
      this.segments.pop();
    }
    const last = this.segments[this.segments.length - 1];
    const r = retimeGroove(last.plan, bpm, anchorCtx, this.cursor);
    last.until = r.switchCtx;
    this.segments.push({ plan: r.plan, until: Infinity });
  }

  /** Plus aucun événement à partir de atCtx. */
  stop(atCtx: number): void {
    this.stopAt = Math.max(atCtx, this.ctx.currentTime);
  }

  getState(): { running: boolean; style?: GrooveStyle; bpm?: number; beat?: number } {
    const p = this.running ? this.currentPlan() : undefined;
    if (!p) return { running: false };
    const beatLen = 60 / p.bpm;
    const k = Math.floor((this.ctx.currentTime - p.anchorCtx) / beatLen);
    return { running: true, style: p.style, bpm: p.bpm, beat: (((k % 4) + 4) % 4) + 1 };
  }

  dispose(): void {
    this.disposed = true;
    this.halt();
    try {
      this.output.disconnect();
      this.bus.disconnect();
      this.drive.disconnect();
      this.shaper.disconnect();
    } catch {
      /* rien */
    }
  }

  // -------------------------------------------------------------------------------------------

  private halt(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.segments = [];
  }

  private tick(): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    const horizon = Math.min(now + GROOVE_LOOKAHEAD, this.stopAt);
    if (horizon > this.cursor) {
      for (const s of this.segments) {
        const to = Math.min(horizon, s.until);
        if (to <= this.cursor) continue;
        for (const ev of grooveSchedule(s.plan, this.cursor, to)) {
          if (ev.t < now - 0.005) continue; // trop tard (onglet en arrière-plan) : on saute
          this.play(ev, Math.max(ev.t, now), s.plan.style, s.plan.bpm);
        }
      }
      this.cursor = horizon;
      this.segments = this.segments.filter((s) => s.until > this.cursor);
    }
    if (this.cursor >= this.stopAt) this.halt();
  }

  private play(ev: GrooveEvent, t: number, style: GrooveStyle, bpm: number): void {
    const v = ev.velocity * (LEVEL[ev.part] ?? 0.3);
    switch (ev.part) {
      case 'kick': return this.kick(t, v, KICKS[style]);
      case 'clap': return this.clap(t, v);
      case 'hat': return this.hat(t, v, 0.035, 8500);
      case 'openhat': return this.hat(t, v, 0.26, 6500);
      case 'perc': return this.perc(t, v, ev.note ?? 72);
      case 'rumble': return this.rumble(t, v);
      case 'bass': return this.bass(t, v, ev.note ?? 33, BASS_CUTOFF[style], (60 / bpm / 4) * 1.7);
    }
  }

  private env(g: AudioParam, t: number, peak: number, attack: number, decay: number): void {
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(peak, t + attack);
    g.exponentialRampToValueAtTime(Math.max(1e-4, peak * 1e-4), t + attack + decay);
    g.setValueAtTime(0, t + attack + decay + 0.001);
  }

  private noiseSrc(t: number, dur: number): AudioBufferSourceNode {
    const s = new AudioBufferSourceNode(this.ctx, { buffer: this.noise, loop: true });
    s.start(t, Math.random() * 0.9);
    s.stop(t + dur + 0.02);
    return s;
  }

  /** Kick : sinus avec enveloppe de hauteur + clic de bruit filtré. */
  private kick(t: number, v: number, k: KickVoice): void {
    const osc = new OscillatorNode(this.ctx, { type: 'sine', frequency: k.f0 });
    const g = new GainNode(this.ctx, { gain: 0 });
    osc.frequency.setValueAtTime(k.f0, t);
    osc.frequency.exponentialRampToValueAtTime(k.f1, t + k.pitchT);
    this.env(g.gain, t, v, 0.0015, k.decay);
    osc.connect(g).connect(k.drive ? this.drive : this.bus);
    osc.start(t);
    osc.stop(t + k.decay + 0.05);
    // clic
    const n = this.noiseSrc(t, 0.01);
    const hp = new BiquadFilterNode(this.ctx, { type: 'highpass', frequency: 1800 });
    const cg = new GainNode(this.ctx, { gain: 0 });
    this.env(cg.gain, t, v * k.click, 0.0005, 0.007);
    n.connect(hp).connect(cg).connect(this.bus);
  }

  /** Clap : bruit filtré en trois rafales puis petite queue. */
  private clap(t: number, v: number): void {
    const n = this.noiseSrc(t, 0.3);
    const bp = new BiquadFilterNode(this.ctx, { type: 'bandpass', frequency: 1150, Q: 0.9 });
    const hp = new BiquadFilterNode(this.ctx, { type: 'highpass', frequency: 500 });
    const g = new GainNode(this.ctx, { gain: 0 });
    const p = g.gain;
    p.setValueAtTime(0, t);
    for (let i = 0; i < 3; i++) {
      const tb = t + i * 0.011;
      p.setValueAtTime(v, tb);
      p.exponentialRampToValueAtTime(v * 0.15, tb + 0.009);
    }
    p.setValueAtTime(v * 0.8, t + 0.033);
    p.exponentialRampToValueAtTime(1e-4, t + 0.033 + 0.2);
    p.setValueAtTime(0, t + 0.24);
    n.connect(bp).connect(hp).connect(g).connect(this.bus);
  }

  /** Charley / shaker : bruit passe-haut + enveloppe courte. */
  private hat(t: number, v: number, decay: number, hpHz: number): void {
    const n = this.noiseSrc(t, decay + 0.01);
    const hp = new BiquadFilterNode(this.ctx, { type: 'highpass', frequency: hpHz, Q: 0.7 });
    const pk = new BiquadFilterNode(this.ctx, { type: 'peaking', frequency: 10000, Q: 1, gain: 4 });
    const g = new GainNode(this.ctx, { gain: 0 });
    this.env(g.gain, t, v, 0.001, decay);
    n.connect(hp).connect(pk).connect(g).connect(this.bus);
  }

  /** Percussion accordée (congas synthétiques, rim) : sinus/triangle avec chute de hauteur. */
  private perc(t: number, v: number, note: number): void {
    const f = midiToHz(note);
    const rim = note >= 72;
    const osc = new OscillatorNode(this.ctx, { type: rim ? 'triangle' : 'sine', frequency: f * 1.4 });
    osc.frequency.setValueAtTime(f * 1.4, t);
    osc.frequency.exponentialRampToValueAtTime(f, t + 0.02);
    const g = new GainNode(this.ctx, { gain: 0 });
    const decay = rim ? 0.05 : 0.17;
    this.env(g.gain, t, v, 0.001, decay);
    osc.connect(g).connect(this.bus);
    osc.start(t);
    osc.stop(t + decay + 0.03);
  }

  /** Rumble techno : grave roulant filtré derrière le kick. */
  private rumble(t: number, v: number): void {
    const osc = new OscillatorNode(this.ctx, { type: 'triangle', frequency: 52 });
    const lp = new BiquadFilterNode(this.ctx, { type: 'lowpass', frequency: 140 });
    const g = new GainNode(this.ctx, { gain: 0 });
    this.env(g.gain, t, v, 0.006, 0.12);
    osc.connect(lp).connect(g).connect(this.drive);
    osc.start(t);
    osc.stop(t + 0.16);
  }

  /** Basse : dent de scie + sous-oscillateur, passe-bas avec enveloppe. */
  private bass(t: number, v: number, note: number, cutoff: number, len: number): void {
    const f = midiToHz(note);
    const saw = new OscillatorNode(this.ctx, { type: 'sawtooth', frequency: f });
    const sub = new OscillatorNode(this.ctx, { type: 'sine', frequency: f });
    const subG = new GainNode(this.ctx, { gain: 0.7 });
    const lp = new BiquadFilterNode(this.ctx, { type: 'lowpass', frequency: cutoff * 3, Q: 6 });
    lp.frequency.setValueAtTime(cutoff * 3, t);
    lp.frequency.exponentialRampToValueAtTime(cutoff, t + 0.08);
    const g = new GainNode(this.ctx, { gain: 0 });
    const p = g.gain;
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(v, t + 0.004);
    p.setValueAtTime(v, t + Math.max(0.01, len - 0.03));
    p.linearRampToValueAtTime(0, t + len);
    saw.connect(lp);
    sub.connect(subG).connect(lp);
    lp.connect(g).connect(this.bus);
    for (const o of [saw, sub]) {
      o.start(t);
      o.stop(t + len + 0.02);
    }
  }
}

function softClip(): Float32Array<ArrayBuffer> {
  const n = 2048;
  const c = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    c[i] = Math.sign(x) * (a <= 0.8 ? a : 0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2));
  }
  return c;
}

function driveCurve(k: number): Float32Array<ArrayBuffer> {
  const n = 2048;
  const c = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return c;
}
