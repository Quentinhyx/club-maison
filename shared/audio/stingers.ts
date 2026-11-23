/**
 * Sons d'ambiance « boîte » synthétisés par la table : corne de brume, sirène, scratch.
 *
 * La partie pure (`stingerSchedule`) calcule les notes sur la grille du tempo et se teste sans Web
 * Audio. `playStinger` les joue avec des oscillateurs, sur un bus dédié qui passe par la dynamique du
 * master (le limiteur empêche toute saturation). Aucun fichier son : tout est généré.
 */
import type { FxKind } from '../contracts';

export type StingerKind = Extract<FxKind, 'airhorn' | 'siren' | 'scratch'>;

export const STINGER_KINDS: readonly StingerKind[] = ['airhorn', 'siren', 'scratch'];

export function isStinger(kind: FxKind): kind is StingerKind {
  return (STINGER_KINDS as readonly string[]).includes(kind);
}

/** Une note : départ et durée (s), hauteur de départ et d'arrivée (Hz), niveau 0..1. */
export interface StingerNote { t: number; dur: number; f0: number; f1: number; level: number }

/**
 * Notes d'un son d'ambiance, calées sur le tempo.
 *  - airhorn : trois coups en doubles-croches puis un long, le dernier qui retombe un peu ;
 *  - siren : montées/descentes d'un demi-temps sur `beats` temps ;
 *  - scratch : allers-retours en croches (aller plus aigu que le retour), sur `beats` temps.
 */
export function stingerSchedule(kind: StingerKind, atCtx: number, bpm: number, beats: number, amount: number): StingerNote[] {
  const beat = 60 / Math.max(40, Math.min(220, bpm || 120));
  const lvl = Math.max(0, Math.min(1, amount));
  const out: StingerNote[] = [];
  if (kind === 'airhorn') {
    const s16 = beat / 4;
    for (let i = 0; i < 3; i++) out.push({ t: atCtx + i * s16, dur: s16 * 0.8, f0: 466, f1: 466, level: lvl });
    out.push({ t: atCtx + 3 * s16, dur: beat * 1.5, f0: 466, f1: 415, level: lvl });
  } else if (kind === 'siren') {
    const n = Math.max(2, Math.round(Math.max(1, beats) * 2));
    for (let i = 0; i < n; i++) {
      const up = i % 2 === 0;
      out.push({ t: atCtx + (i * beat) / 2, dur: beat / 2, f0: up ? 620 : 1320, f1: up ? 1320 : 620, level: lvl * (0.6 + (0.4 * i) / n) });
    }
  } else {
    const n = Math.max(2, Math.round(Math.max(0.5, beats) * 2));
    for (let i = 0; i < n; i++) {
      const fwd = i % 2 === 0;
      out.push({ t: atCtx + (i * beat) / 2, dur: (beat / 2) * 0.85, f0: fwd ? 180 : 700, f1: fwd ? 900 : 160, level: lvl * (fwd ? 1 : 0.75) });
    }
  }
  return out;
}

/** Fin (s) du dernier son, pour savoir quand le bus redevient libre. */
export function stingerEnd(notes: StingerNote[]): number {
  return notes.reduce((m, n) => Math.max(m, n.t + n.dur), 0);
}

/** Joue un son d'ambiance sur `dest` (bus des sons d'ambiance). */
export function playStinger(ctx: BaseAudioContext, dest: AudioNode, kind: StingerKind, atCtx: number, bpm: number, beats: number, amount: number): void {
  const t0 = Math.max(atCtx, ctx.currentTime + 0.01);
  const notes = stingerSchedule(kind, t0, bpm, beats, amount);
  if (kind === 'airhorn') {
    for (const n of notes) {
      const g = new GainNode(ctx, { gain: 0 });
      const bp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 1400, Q: 0.8 });
      const shaper = new WaveShaperNode(ctx, { curve: hornCurve(), oversample: '2x' });
      shaper.connect(bp).connect(g).connect(dest);
      for (const det of [-14, -5, 6, 15]) {
        const o = new OscillatorNode(ctx, { type: 'sawtooth', frequency: n.f0, detune: det });
        o.frequency.setValueAtTime(n.f0, n.t);
        o.frequency.linearRampToValueAtTime(n.f1, n.t + n.dur);
        const og = new GainNode(ctx, { gain: 0.22 });
        o.connect(og).connect(shaper);
        o.start(n.t);
        o.stop(n.t + n.dur + 0.05);
      }
      g.gain.setValueAtTime(0, n.t);
      g.gain.linearRampToValueAtTime(0.5 * n.level, n.t + 0.012);
      g.gain.setValueAtTime(0.5 * n.level, n.t + n.dur - 0.03);
      g.gain.linearRampToValueAtTime(0, n.t + n.dur);
    }
  } else if (kind === 'siren') {
    const o = new OscillatorNode(ctx, { type: 'square', frequency: notes[0].f0 });
    const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 2600, Q: 0.7 });
    const g = new GainNode(ctx, { gain: 0 });
    o.connect(lp).connect(g).connect(dest);
    for (const n of notes) {
      o.frequency.setValueAtTime(n.f0, n.t);
      o.frequency.exponentialRampToValueAtTime(n.f1, n.t + n.dur);
      g.gain.setValueAtTime(0.16 * n.level, n.t);
    }
    const end = stingerEnd(notes);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.16 * notes[0].level, t0 + 0.05);
    g.gain.setValueAtTime(0.16 * notes[notes.length - 1].level, end - 0.08);
    g.gain.linearRampToValueAtTime(0, end);
    o.start(t0);
    o.stop(end + 0.05);
  } else {
    // scratch : bruit + dent de scie dont la hauteur suit le geste, coupé par le crossfader (gain)
    const len = Math.ceil(ctx.sampleRate * 0.5);
    const nb = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = nb.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    for (const n of notes) {
      const src = new AudioBufferSourceNode(ctx, { buffer: nb, loop: true });
      const bp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: n.f0 * 2, Q: 3 });
      const o = new OscillatorNode(ctx, { type: 'sawtooth', frequency: n.f0 });
      const og = new GainNode(ctx, { gain: 0.35 });
      const g = new GainNode(ctx, { gain: 0 });
      src.connect(bp).connect(g);
      o.connect(og).connect(g);
      g.connect(dest);
      bp.frequency.setValueAtTime(n.f0 * 2, n.t);
      bp.frequency.exponentialRampToValueAtTime(n.f1 * 2, n.t + n.dur);
      o.frequency.setValueAtTime(n.f0, n.t);
      o.frequency.exponentialRampToValueAtTime(n.f1, n.t + n.dur);
      g.gain.setValueAtTime(0, n.t);
      g.gain.linearRampToValueAtTime(0.45 * n.level, n.t + 0.008);
      g.gain.setValueAtTime(0.45 * n.level, n.t + n.dur - 0.01);
      g.gain.linearRampToValueAtTime(0, n.t + n.dur);
      src.start(n.t);
      src.stop(n.t + n.dur + 0.02);
      o.start(n.t);
      o.stop(n.t + n.dur + 0.02);
    }
  }
}

let hornCache: Float32Array<ArrayBuffer> | undefined;
function hornCurve(): Float32Array<ArrayBuffer> {
  if (hornCache) return hornCache;
  const n = 1024;
  const c = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(2.5 * x) / Math.tanh(2.5);
  }
  hornCache = c;
  return c;
}
