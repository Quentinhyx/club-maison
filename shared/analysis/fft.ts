/**
 * FFT radix-2 itérative, en place, écrite à la main (aucune dépendance).
 * Les tables (bit-reversal, twiddles) sont mises en cache par taille.
 */

interface FftTables {
  rev: Uint32Array;
  cos: Float64Array;
  sin: Float64Array;
}

const tablesCache = new Map<number, FftTables>();

function getTables(n: number): FftTables {
  let t = tablesCache.get(n);
  if (t) return t;
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`FFT : taille ${n} non puissance de 2`);
  const bits = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const half = n >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  t = { rev, cos, sin };
  tablesCache.set(n, t);
  return t;
}

/** FFT complexe directe en place. re.length === im.length === puissance de 2. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  const { rev, cos, sin } = getTables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const halfSize = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0, tw = 0; k < halfSize; k++, tw += step) {
        const a = start + k;
        const b = a + halfSize;
        const wr = cos[tw];
        const wi = sin[tw];
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

const hannCache = new Map<number, Float64Array>();
export function hann(n: number): Float64Array {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    hannCache.set(n, w);
  }
  return w;
}

/**
 * STFT en magnitudes : renvoie un tableau [frames][n/2+1] (Float32Array par trame).
 * Deux trames réelles sont empaquetées dans une seule FFT complexe (2x plus rapide).
 */
export function stftMagnitudes(x: Float32Array, n: number, hop: number): Float32Array[] {
  const frames: Float32Array[] = [];
  if (x.length < n) return frames;
  const count = Math.floor((x.length - n) / hop) + 1;
  const w = hann(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const bins = (n >> 1) + 1;
  for (let f = 0; f < count; f += 2) {
    const o1 = f * hop;
    const hasSecond = f + 1 < count;
    const o2 = o1 + hop;
    for (let i = 0; i < n; i++) {
      re[i] = x[o1 + i] * w[i];
      im[i] = hasSecond ? x[o2 + i] * w[i] : 0;
    }
    fft(re, im);
    const m1 = new Float32Array(bins);
    const m2 = hasSecond ? new Float32Array(bins) : undefined;
    for (let k = 0; k < bins; k++) {
      const nk = (n - k) & (n - 1);
      // X1 = (Z[k] + conj(Z[n-k])) / 2; X2 = (Z[k] - conj(Z[n-k])) / 2i
      const ar = re[k], ai = im[k], br = re[nk], bi = -im[nk];
      const x1r = 0.5 * (ar + br), x1i = 0.5 * (ai + bi);
      m1[k] = Math.sqrt(x1r * x1r + x1i * x1i);
      if (m2) {
        const x2r = 0.5 * (ai - bi), x2i = -0.5 * (ar - br);
        m2[k] = Math.sqrt(x2r * x2r + x2i * x2i);
      }
    }
    frames.push(m1);
    if (m2) frames.push(m2);
  }
  return frames;
}
