/** Outils DSP partagés (purs). */
import type { Camelot } from '../contracts';

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0);
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Ramène un tempo dans [lo, hi] par doublements / divisions par 2. 0 ou invalide -> 0. */
export function normalizeBpm(bpm: number, lo = 70, hi = 180): number {
  if (!Number.isFinite(bpm) || bpm <= 0) return 0;
  let b = bpm;
  let guard = 0;
  while (b < lo && guard++ < 16) b *= 2;
  while (b > hi && guard++ < 32) b /= 2;
  return b;
}

/** dBFS -> 0..1 linéaire entre lo et hi. */
export function dbTo01(db: number, lo: number, hi: number): number {
  return clamp01((db - lo) / (hi - lo));
}

export function ampToDb(a: number): number {
  return 20 * Math.log10(Math.max(a, 1e-9));
}

// ---------------------------------------------------------------------------------------------
// Tonalités
// ---------------------------------------------------------------------------------------------

export const PITCH_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/** Tonique (0 = do) + mode -> Camelot. Do majeur = 8B, la mineur = 8A. */
export function toCamelot(tonic: number, minor: boolean): Camelot {
  const majorPc = minor ? (tonic + 3) % 12 : tonic % 12;
  const num = (((7 * majorPc) % 12) + 7) % 12 + 1;
  return `${num}${minor ? 'A' : 'B'}` as Camelot;
}

// ---------------------------------------------------------------------------------------------
// Signal
// ---------------------------------------------------------------------------------------------

/** Mixe en mono puis sous-échantillonne d'un facteur entier (moyenne glissante en guise de passe-bas). */
export function monoDecimate(channels: Float32Array[], factor: number): Float32Array {
  const len = channels.reduce((m, c) => Math.min(m, c.length), Infinity);
  const nCh = channels.length;
  if (!Number.isFinite(len) || len === 0 || nCh === 0) return new Float32Array(0);
  const f = Math.max(1, Math.floor(factor));
  const outLen = Math.floor(len / f);
  const out = new Float32Array(outLen);
  const norm = 1 / (nCh * f);
  // passe-bas : moyenne sur 2f échantillons centrée (atténuation correcte au-delà de la Nyquist cible)
  const win = f === 1 ? 1 : 2 * f;
  const half = Math.floor((win - f) / 2);
  const winNorm = f === 1 ? norm : 1 / (nCh * win);
  for (let o = 0; o < outLen; o++) {
    const start = o * f - half;
    let s = 0;
    for (let i = 0; i < win; i++) {
      const idx = start + i;
      if (idx < 0 || idx >= len) continue;
      for (let c = 0; c < nCh; c++) s += channels[c][idx];
    }
    out[o] = s * (f === 1 ? norm : winNorm);
  }
  return out;
}

/** Biquad (RBJ) en forme directe I transposée, état interne. */
export class Biquad {
  private b0 = 1; private b1 = 0; private b2 = 0; private a1 = 0; private a2 = 0;
  private z1 = 0; private z2 = 0;

  static lowpass(sr: number, f: number, q = Math.SQRT1_2): Biquad {
    return new Biquad().set('lp', sr, f, q);
  }
  static highpass(sr: number, f: number, q = Math.SQRT1_2): Biquad {
    return new Biquad().set('hp', sr, f, q);
  }
  static bandpass(sr: number, f: number, q = 0.7): Biquad {
    return new Biquad().set('bp', sr, f, q);
  }

  set(type: 'lp' | 'hp' | 'bp', sr: number, f: number, q: number): this {
    const w0 = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr;
    const cw = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    let b0: number, b1: number, b2: number;
    if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; }
    else if (type === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
    else { b0 = alpha; b1 = 0; b2 = -alpha; }
    const a0 = 1 + alpha;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = (-2 * cw) / a0; this.a2 = (1 - alpha) / a0;
    return this;
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  reset(): void { this.z1 = 0; this.z2 = 0; }
}

// ---------------------------------------------------------------------------------------------
// Tempo : autocorrélation + peigne
// ---------------------------------------------------------------------------------------------

/** Autocorrélation non biaisée (divisée par N - lag) d'un signal déjà centré, lags 0..maxLag. */
export function autocorr(x: ArrayLike<number>, maxLag: number, start = 0, len = x.length - start): Float64Array {
  const ml = Math.min(maxLag, len - 1);
  const out = new Float64Array(ml + 1);
  for (let lag = 0; lag <= ml; lag++) {
    let s = 0;
    const end = start + len - lag;
    for (let i = start; i < end; i++) s += x[i] * x[i + lag];
    out[lag] = s / (len - lag);
  }
  return out;
}

export function interp(a: ArrayLike<number>, pos: number): number {
  if (pos < 0) return 0;
  const i = Math.floor(pos);
  if (i >= a.length - 1) return i === a.length - 1 ? a[i] : 0;
  const fr = pos - i;
  return a[i] * (1 - fr) + a[i + 1] * fr;
}

/** Score de peigne : moyenne de l'autocorrélation aux multiples de la période (en trames). */
export function combScore(ac: ArrayLike<number>, periodFrames: number, maxMultiple: number): number {
  let s = 0;
  let n = 0;
  for (let k = 1; k <= maxMultiple; k++) {
    const lag = k * periodFrames;
    if (lag > ac.length - 2) break;
    s += interp(ac, lag);
    n++;
  }
  return n ? s / n : 0;
}

/** Lissage gaussien (sigma en échantillons). */
export function gaussianSmooth(x: Float64Array, sigma: number): Float64Array {
  if (sigma <= 0) return x.slice();
  const r = Math.ceil(sigma * 3);
  const k = new Float64Array(2 * r + 1);
  let ks = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); ks += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let s = 0;
    for (let j = -r; j <= r; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < x.length) s += x[idx] * k[j + r];
    }
    out[i] = s;
  }
  return out;
}

/** Retire la moyenne glissante (fenêtre en échantillons) et redresse (>= 0). */
export function adaptiveRectify(x: Float64Array, win: number): Float64Array {
  const out = new Float64Array(x.length);
  const half = Math.max(1, Math.floor(win / 2));
  let s = 0;
  let lo = 0, hi = -1;
  for (let i = 0; i < x.length; i++) {
    const a = Math.max(0, i - half), b = Math.min(x.length - 1, i + half);
    while (hi < b) s += x[++hi];
    while (lo < a) s -= x[lo++];
    const m = s / (hi - lo + 1);
    out[i] = Math.max(0, x[i] - m);
  }
  return out;
}

/** A priori « tempo plausible » : gaussienne en log2 centrée sur 122 BPM. */
export function plausibility(bpm: number, sigmaOct = 0.75): number {
  const d = Math.log2(bpm / 122) / sigmaOct;
  return Math.exp(-0.5 * d * d);
}
