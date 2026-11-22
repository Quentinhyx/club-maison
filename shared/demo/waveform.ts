/**
 * Club Maison : forme d'onde 3 bandes (basses < 200 Hz, médiums 200 Hz - 2 kHz, aigus > 2 kHz)
 * pour l'affichage des platines. Deux passe-bas biquad (RBJ) écrits à la main ; les bandes sont
 * obtenues par différence (médiums = LP2000 - LP200, aigus = x - LP2000). RMS par fenêtre,
 * normalisée sur le morceau (0..1). `peak` = crête absolue par fenêtre, normalisée.
 */

export interface Waveform {
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  peak: Float32Array;
  pointsPerSecond: number;
}

export type WaveformInput = AudioBuffer | { left: Float32Array; right?: Float32Array; sampleRate: number };

function lowpassCoefs(fc: number, sr: number): [number, number, number, number, number] {
  const w = (2 * Math.PI * fc) / sr;
  const cw = Math.cos(w), alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b0 = (1 - cw) / 2 / a0, b1 = (1 - cw) / a0, b2 = b0;
  const a1 = (-2 * cw) / a0, a2 = (1 - alpha) / a0;
  return [b0, b1, b2, a1, a2];
}

export function computeWaveform(input: WaveformInput, pointsPerSecond: number): Waveform {
  let left: Float32Array, right: Float32Array | undefined, sr: number;
  if ('getChannelData' in input) {
    left = input.getChannelData(0);
    right = input.numberOfChannels > 1 ? input.getChannelData(1) : undefined;
    sr = input.sampleRate;
  } else {
    left = input.left; right = input.right; sr = input.sampleRate;
  }
  const n = left.length;
  const points = Math.max(1, Math.ceil((n / sr) * pointsPerSecond));
  const low = new Float32Array(points), mid = new Float32Array(points), high = new Float32Array(points), peak = new Float32Array(points);
  const [lb0, lb1, lb2, la1, la2] = lowpassCoefs(200, sr);
  const [mb0, mb1, mb2, ma1, ma2] = lowpassCoefs(2000, sr);
  let lx1 = 0, lx2 = 0, ly1 = 0, ly2 = 0;
  let my1 = 0, my2 = 0;
  const hop = sr / pointsPerSecond;
  for (let p = 0; p < points; p++) {
    const a = Math.floor(p * hop), b = Math.min(n, Math.floor((p + 1) * hop));
    let sl = 0, sm = 0, sh = 0, pk = 0;
    for (let i = a; i < b; i++) {
      const x = right ? (left[i] + right[i]) * 0.5 : left[i];
      const yl = lb0 * x + lb1 * lx1 + lb2 * lx2 - la1 * ly1 - la2 * ly2;
      const ym = mb0 * x + mb1 * lx1 + mb2 * lx2 - ma1 * my1 - ma2 * my2;
      lx2 = lx1; lx1 = x; ly2 = ly1; ly1 = yl; my2 = my1; my1 = ym;
      const vm = ym - yl, vh = x - ym;
      sl += yl * yl; sm += vm * vm; sh += vh * vh;
      const ax = x < 0 ? -x : x;
      if (ax > pk) pk = ax;
    }
    const c = Math.max(1, b - a);
    low[p] = Math.sqrt(sl / c); mid[p] = Math.sqrt(sm / c); high[p] = Math.sqrt(sh / c); peak[p] = pk;
  }
  for (const arr of [low, mid, high, peak]) {
    let m = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
    if (m > 0) for (let i = 0; i < arr.length; i++) arr[i] = Math.min(1, arr[i] / m);
  }
  return { low, mid, high, peak, pointsPerSecond };
}
