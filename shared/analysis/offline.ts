/**
 * Analyse hors ligne d'un extrait (30 s Deezer) : tempo, tonalité, énergie, etc. Fonction PURE.
 *
 * Chaîne : mono + sous-échantillonnage (~11 kHz) -> STFT 1024/128 (≈ 86 trames/s) -> flux spectral
 * (pleine bande + bande basse) -> autocorrélation -> peigne de tempos sur [70, 180] -> levée de
 * l'ambiguïté demi/double (a priori Deezer, genres, puis présence d'une pulsation basse au double).
 * Tonalité : STFT 4096 -> chromagramme 80 Hz-2 kHz -> corrélation de Pearson avec les profils de
 * Krumhansl-Kessler sur les 24 tonalités.
 */
import type { Genre, TrackAnalysis, TrackRef } from '../contracts';
import {
  adaptiveRectify, ampToDb, autocorr, clamp01, combScore, dbTo01, gaussianSmooth, interp,
  monoDecimate, normalizeBpm, plausibility, toCamelot,
} from './dsp';
import { stftMagnitudes } from './fft';

const BPM_LO = 70;
const BPM_HI = 180;
const GRID_STEP = 0.05;

// Profils de Krumhansl-Kessler (tonique en position 0).
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const SLOW_GENRES: Genre[] = ['rap-fr', 'rap-us', 'rnb', 'reggaeton', 'dancehall', 'latino'];
const FAST_GENRES: Genre[] = ['drum-bass'];

export interface TempoResult {
  bpm: number;
  confidence: number;
  /** Force de la pulsation (autocorrélation normalisée au tempo retenu), 0..1. */
  pulse: number;
  lowPulse: number;
  /** Stabilité du tempo 0..1 (1 = tempo de machine). */
  stability: number;
}

export function analyzeBuffer(
  channels: Float32Array | Float32Array[],
  sampleRate: number,
  meta: TrackRef,
): TrackAnalysis {
  const chans = Array.isArray(channels) ? channels : [channels];
  const len = chans.reduce((m, c) => Math.min(m, c.length), chans.length ? Infinity : 0);
  const base: TrackAnalysis = {
    trackId: meta.id,
    bpm: normalizeBpm(meta.bpm ?? 0) || 120,
    bpmConfidence: meta.bpm && meta.bpm > 0 ? 0.3 : 0,
    energy: 0,
    danceability: 0,
    brightness: 0,
    loudnessDb: -120,
    genres: meta.genres ?? [],
    analyzedAt: Date.now(),
  };
  if (!Number.isFinite(len) || len < sampleRate * 2 || sampleRate <= 0) return base;

  // --- Pleine bande : loudness + brillance (fréquence « effective » via la dérivée) ------------
  const nCh = chans.length;
  let sumSq = 0, sumD = 0, prev = 0;
  for (let i = 0; i < len; i++) {
    let m = 0;
    for (let c = 0; c < nCh; c++) m += chans[c][i];
    m /= nCh;
    sumSq += m * m;
    const d = m - prev;
    sumD += d * d;
    prev = m;
  }
  const rms = Math.sqrt(sumSq / len);
  const loudnessDb = ampToDb(rms);
  if (rms < 1e-5) return { ...base, loudnessDb };
  const ratio = Math.sqrt(sumD / sumSq);
  const fEff = (sampleRate / Math.PI) * Math.asin(Math.min(1, ratio / 2));
  const brightness = clamp01(Math.log2(Math.max(fEff, 1) / 150) / Math.log2(6000 / 150));

  // --- Signal sous-échantillonné ------------------------------------------------------------
  const factor = Math.max(1, Math.round(sampleRate / 11025));
  const fsd = sampleRate / factor;
  const x = monoDecimate(chans, factor);

  // --- STFT d'attaques ----------------------------------------------------------------------
  const N = 1024;
  const HOP = 128;
  const fps = fsd / HOP;
  const frames = stftMagnitudes(x, N, HOP);
  const nF = frames.length;
  const bins = N / 2 + 1;
  const binHz = fsd / N;
  const lowBin = Math.max(2, Math.round(200 / binHz));
  const vLo = Math.round(300 / binHz), vHi = Math.min(bins - 1, Math.round(3000 / binHz));
  const scale = 10 / ((N / 4) * rms);

  const flux = new Float64Array(nF);
  const fluxLow = new Float64Array(nF);
  const vocal = new Float64Array(nF);
  const total = new Float64Array(nF);
  let prevLog = new Float32Array(bins);
  let curLog = new Float32Array(bins);
  for (let t = 0; t < nF; t++) {
    const mag = frames[t];
    let f = 0, fl = 0, ev = 0, et = 0;
    for (let k = 1; k < bins; k++) {
      const mk = mag[k];
      const y = Math.log(1 + scale * mk);
      curLog[k] = y;
      const e2 = mk * mk;
      et += e2;
      if (k >= vLo && k <= vHi) ev += e2;
      if (t > 0) {
        const d = y - prevLog[k];
        if (d > 0) { f += d; if (k <= lowBin) fl += d; }
      }
    }
    flux[t] = f; fluxLow[t] = fl; vocal[t] = ev; total[t] = et;
    const tmp = prevLog; prevLog = curLog; curLog = tmp;
  }

  const tempo = estimateTempo(flux, fluxLow, fps, meta);

  // --- Énergie, dansabilité ----------------------------------------------------------------
  const odfN = normalizeMean(flux);
  let peaks = 0;
  for (let t = 1; t < nF - 1; t++) {
    if (odfN[t] > 1.5 && odfN[t] >= odfN[t - 1] && odfN[t] > odfN[t + 1]) peaks++;
  }
  const density = clamp01(peaks / (nF / fps) / 8);
  const loud01 = dbTo01(loudnessDb, -32, -8);
  const energy = clamp01(0.5 * loud01 + 0.3 * density + 0.2 * brightness);
  const danceability = clamp01(
    0.55 * tempo.pulse + 0.3 * tempo.lowPulse + 0.15 * plausibility(tempo.bpm, 0.35),
  );

  // --- Voix (estimation grossière) -----------------------------------------------------------
  const vocalness = estimateVocalness(vocal, total, fps, tempo.bpm);

  // --- Tonalité ------------------------------------------------------------------------------
  const keyRes = estimateKey(x, fsd);

  return {
    ...base,
    bpm: Math.round(tempo.bpm * 100) / 100,
    bpmConfidence: tempo.confidence,
    tempoStability: Math.round(tempo.stability * 1000) / 1000,
    key: keyRes?.key,
    keyConfidence: keyRes?.confidence,
    energy,
    danceability,
    brightness,
    vocalness,
    loudnessDb: Math.round(loudnessDb * 10) / 10,
  };
}

function normalizeMean(x: Float64Array): Float64Array {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i];
  const m = s / Math.max(1, x.length) || 1;
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] / m;
  return out;
}

function prepOdf(x: Float64Array, fps: number): Float64Array {
  const r = gaussianSmooth(adaptiveRectify(x, Math.round(fps * 0.4)), 1);
  let s = 0;
  for (let i = 0; i < r.length; i++) s += r[i];
  const m = s / Math.max(1, r.length);
  for (let i = 0; i < r.length; i++) r[i] -= m;
  return r;
}

function normalizedAc(x: Float64Array, maxLag: number): Float64Array {
  const ac = autocorr(x, maxLag);
  const a0 = ac[0] || 1;
  for (let i = 0; i < ac.length; i++) ac[i] /= a0;
  return ac;
}

/** Tempo depuis le flux spectral (exporté pour les tests). */
export function estimateTempo(flux: Float64Array, fluxLow: Float64Array, fps: number, meta?: TrackRef): TempoResult {
  const nF = flux.length;
  const fullN = normalizeMean(flux);
  const lowN = normalizeMean(fluxLow);
  const comb = new Float64Array(nF);
  for (let i = 0; i < nF; i++) comb[i] = fullN[i] + lowN[i];
  const odf = prepOdf(comb, fps);
  const odfLow = prepOdf(fluxLow, fps);

  const K = 8;
  const maxLag = Math.min(nF - 2, Math.ceil((fps * 60 / BPM_LO) * K) + 2);
  const ac = normalizedAc(odf, maxLag);
  const acLow = normalizedAc(odfLow, Math.min(nF - 2, Math.ceil(fps * 60 / BPM_LO) + 2));

  const nGrid = Math.round((BPM_HI - BPM_LO) / GRID_STEP) + 1;
  const S = new Float64Array(nGrid);
  for (let i = 0; i < nGrid; i++) S[i] = combScore(ac, (fps * 60) / (BPM_LO + i * GRID_STEP), K);
  const bpmAt = (i: number) => BPM_LO + i * GRID_STEP;
  const idxOf = (b: number) => Math.round((b - BPM_LO) / GRID_STEP);

  const localMax = (b: number, tol: number): number => {
    const a = Math.max(0, idxOf(b * (1 - tol))), z = Math.min(nGrid - 1, idxOf(b * (1 + tol)));
    let bi = Math.min(Math.max(idxOf(b), 0), nGrid - 1);
    for (let i = a; i <= z; i++) if (S[i] > S[bi]) bi = i;
    // affinage parabolique
    if (bi > 0 && bi < nGrid - 1) {
      const y0 = S[bi - 1], y1 = S[bi], y2 = S[bi + 1];
      const den = y0 - 2 * y1 + y2;
      if (den < 0) return bpmAt(bi) + (0.5 * (y0 - y2) / den) * GRID_STEP;
    }
    return bpmAt(bi);
  };
  const sAt = (b: number) => interp(S, (b - BPM_LO) / GRID_STEP);

  let best = 0, bestScore = -Infinity;
  for (let i = 0; i < nGrid; i++) {
    const sc = S[i] * (0.6 + 0.4 * plausibility(bpmAt(i), 1));
    if (sc > bestScore) { bestScore = sc; best = i; }
  }
  let bpm = localMax(bpmAt(best), 0.02);
  const family = [bpm / 2, bpm, bpm * 2]
    .filter((b) => b >= BPM_LO - 0.5 && b <= BPM_HI + 0.5)
    .map((b) => localMax(Math.min(BPM_HI, Math.max(BPM_LO, b)), 0.03));

  const hint = normalizeBpm(meta?.bpm ?? 0, BPM_LO, BPM_HI);
  const genres = meta?.genres ?? [];
  let hintAgrees = false;
  let decided = false;

  if (hint > 0) {
    let closest = family[0], dmin = Infinity;
    for (const b of family) {
      const d = Math.abs(b - hint) / hint;
      if (d < dmin) { dmin = d; closest = b; }
    }
    if (dmin < 0.08) { bpm = closest; hintAgrees = dmin < 0.03; decided = true; }
    else {
      const hb = localMax(hint, 0.04);
      if (sAt(hb) >= 0.5 * sAt(bpm)) { bpm = hb; hintAgrees = true; decided = true; }
    }
  }
  if (!decided && family.length > 1) {
    const fast = family[family.length - 1], slow = family[0];
    if (genres.some((g) => FAST_GENRES.includes(g))) { bpm = fast; decided = true; }
    else if (genres.some((g) => SLOW_GENRES.includes(g))) { bpm = slow; decided = true; }
    else {
      const Lf = (fps * 60) / fast, Ls = (fps * 60) / slow;
      const sLow = interp(acLow, Ls);
      const rLow = sLow > 0.05 ? interp(acLow, Lf) / sLow : 0;
      const rFull = interp(ac, Ls) > 0.05 ? interp(ac, Lf) / interp(ac, Ls) : 0;
      bpm = rLow > 0.5 || rFull > 0.75 ? fast : slow;
    }
  }

  const L = (fps * 60) / bpm;
  const peak = sAt(bpm);
  const sorted = Array.from(S).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  let confidence = clamp01((peak - median) * 2.2);
  if (hint > 0) confidence = hintAgrees ? clamp01(Math.max(confidence, 0.5) + 0.15) : confidence * 0.7;
  return {
    bpm,
    confidence,
    pulse: clamp01(interp(ac, L) * 1.4),
    lowPulse: clamp01(interp(acLow, L) * 1.4),
    stability: estimateStability(odf, fps, bpm, clamp01(interp(ac, L) * 1.4)),
  };
}

/**
 * Stabilité du tempo : (1) tempo local sur fenêtres glissantes de 6 s (pas 1,5 s), coefficient de
 * variation ; (2) écart des attaques fortes à UNE grille fixe (période + phase ajustées aux moindres
 * carrés sur les temps) : c'est ce que verrait une boîte à rythmes calée dessous ; (3) gigue des
 * intervalles entre temps (1 sous 0,6 %, 0 vers 2,5 % de période) ; (4) force de la pulsation. 1 si CV < 0,3 % et grille à ~10 ms ; 0 vers 3 % de dérive / 45 ms d'écart.
 */
function estimateStability(odf: Float64Array, fps: number, bpm: number, pulse: number): number {
  const n = odf.length;
  if (n < fps * 8 || bpm <= 0) return 0;
  // (1) tempo local
  const win = Math.round(fps * 6), step = Math.round(fps * 1.5);
  const K = 4;
  const local: number[] = [];
  for (let s = 0; s + win <= n; s += step) {
    let m = 0;
    for (let i = s; i < s + win; i++) m += odf[i];
    m /= win;
    const seg = new Float64Array(win);
    for (let i = 0; i < win; i++) seg[i] = odf[s + i] - m;
    const maxLag = Math.min(win - 2, Math.ceil((fps * 60 / (bpm * 0.9)) * K) + 2);
    const ac = autocorr(seg, maxLag);
    let bb = bpm, bs = -Infinity;
    for (let b = bpm * 0.9; b <= bpm * 1.1; b += 0.02) {
      const sc = combScore(ac, (fps * 60) / b, K);
      if (sc > bs) { bs = sc; bb = b; }
    }
    if (ac[0] > 0 && bs / ac[0] > 0.05) local.push(bb);
  }
  if (local.length < 3) return 0;
  const lm = local.reduce((a, b) => a + b, 0) / local.length;
  const cv = Math.sqrt(local.reduce((a, b) => a + (b - lm) ** 2, 0) / local.length) / lm;
  const sTempo = clamp01(1 - (cv - 0.003) / (0.03 - 0.003));

  // (2) attaques fortes vs grille fixe
  const sorted = Array.from(odf).sort((a, b) => a - b);
  const thr = Math.max(1e-9, 0.5 * sorted[Math.floor(sorted.length * 0.98)]);
  const onsets: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (odf[i] > thr && odf[i] >= odf[i - 1] && odf[i] > odf[i + 1]) {
      const y0 = odf[i - 1], y1 = odf[i], y2 = odf[i + 1];
      const den = y0 - 2 * y1 + y2;
      const d = den < 0 ? (0.5 * (y0 - y2)) / den : 0;
      onsets.push((i + d) / fps);
    }
  }
  let sGrid = 0;
  let sJit = 0;
  if (onsets.length >= 8) {
    let P = 60 / bpm;
    // phase initiale : moyenne circulaire
    let cx = 0, cy = 0;
    for (const t of onsets) { cx += Math.cos((2 * Math.PI * t) / P); cy += Math.sin((2 * Math.PI * t) / P); }
    let phi = ((Math.atan2(cy, cx) / (2 * Math.PI)) * P + P) % P;
    let rmsSec = Infinity;
    let jit = Infinity;
    let inlierFrac = 0;
    for (let it = 0; it < 5; it++) {
      // affectation au temps le plus proche (attaques loin de la grille écartées), puis moindres carrés
      const ks: number[] = [], ts: number[] = [];
      for (const t of onsets) {
        const k = Math.round((t - phi) / P);
        if (Math.abs(t - (phi + k * P)) < P / 4) { ks.push(k); ts.push(t); }
      }
      const m = ks.length;
      inlierFrac = m / onsets.length;
      if (m < 6) break;
      let sk = 0, st = 0, skk = 0, skt = 0;
      for (let j = 0; j < m; j++) { sk += ks[j]; st += ts[j]; skk += ks[j] * ks[j]; skt += ks[j] * ts[j]; }
      const den = m * skk - sk * sk;
      if (den <= 0) break;
      const nP = (m * skt - sk * st) / den;
      if (!(nP > P * 0.9 && nP < P * 1.1)) break;
      P = nP;
      phi = (st - P * sk) / m;
      let e2 = 0, d2 = 0, nd = 0;
      let prevK = NaN, prevE = 0;
      for (let j = 0; j < m; j++) {
        const e = ts[j] - (phi + ks[j] * P);
        e2 += e * e;
        if (ks[j] - prevK === 1) { d2 += (e - prevE) ** 2; nd++; }
        prevK = ks[j]; prevE = e;
      }
      rmsSec = Math.sqrt(e2 / m);
      jit = nd ? Math.sqrt(d2 / nd) / P : Infinity; // gigue relative des intervalles entre temps
    }
    const misfit = clamp01((0.9 - inlierFrac) / 0.4); // trop d'attaques hors grille
    sGrid = Number.isFinite(rmsSec) ? clamp01(1 - (rmsSec - 0.01) / (0.045 - 0.01)) * (1 - misfit) : 0;
    sJit = Number.isFinite(jit) ? clamp01(1 - (jit - 0.006) / (0.025 - 0.006)) : 0;
  }
  const sPulse = clamp01(pulse / 0.35);
  return clamp01(Math.min(sTempo, sGrid, sJit) * sPulse);
}

function estimateVocalness(vocal: Float64Array, total: Float64Array, fps: number, bpm: number): number {
  const n = vocal.length;
  if (n < 16) return 0;
  let sv = 0, st = 0;
  for (let i = 0; i < n; i++) { sv += vocal[i]; st += total[i]; }
  const frac = st > 0 ? sv / st : 0;
  // part non périodique (non expliquée par un motif calé sur le temps) de la bande voix
  const lev = new Float64Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) { lev[i] = Math.log(vocal[i] + 1e-12 * (st / n) + 1e-20); mean += lev[i]; }
  mean /= n;
  const P = (fps * 60) / bpm;
  const NB = 12;
  const tSum = new Float64Array(NB), tCnt = new Float64Array(NB);
  const binOf = (i: number) => Math.min(NB - 1, Math.floor(((i % P) / P) * NB));
  for (let i = 0; i < n; i++) { const b = binOf(i); tSum[b] += lev[i]; tCnt[b]++; }
  let vTot = 0, vRes = 0;
  for (let i = 0; i < n; i++) {
    const b = binOf(i);
    const tpl = tSum[b] / Math.max(1, tCnt[b]);
    vTot += (lev[i] - mean) ** 2;
    vRes += (lev[i] - tpl) ** 2;
  }
  const residRatio = vTot > 0 ? vRes / vTot : 0;
  const residStd = Math.sqrt(vRes / n);
  const a = clamp01((frac - 0.1) / 0.5);
  const b = clamp01((residRatio - 0.3) / 0.6);
  const c = clamp01((residStd - 0.4) / 1.2);
  return clamp01(Math.cbrt(a * b * c) * 1.1);
}

function pearson(a: ArrayLike<number>, b: ArrayLike<number>, rot: number): number {
  let ma = 0, mb = 0;
  for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
  ma /= 12; mb /= 12;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[(i + rot) % 12] - ma;
    const y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/** Tonalité (exporté pour les tests) : chromagramme + Krumhansl-Kessler. */
export function estimateKey(x: Float32Array, fs: number): { key: TrackAnalysis['key']; confidence: number; chroma: number[] } | undefined {
  const N = 4096;
  const HOP = 2048;
  const frames = stftMagnitudes(x, N, HOP);
  if (frames.length < 2) return undefined;
  const binHz = fs / N;
  const kLo = Math.ceil(80 / binHz), kHi = Math.min(N / 2, Math.floor(2000 / binHz));
  const pcOf = new Int8Array(kHi + 1);
  const wOf = new Float64Array(kHi + 1);
  for (let k = kLo; k <= kHi; k++) {
    const p = 69 + 12 * Math.log2((k * binHz) / 440);
    const r = Math.round(p);
    const dev = Math.abs(p - r);
    pcOf[k] = ((r % 12) + 12) % 12;
    const c = Math.cos(Math.PI * dev);
    // les graves portent la fondamentale de l'accord : pondération légèrement décroissante
    // avec la fréquence (limite aussi le poids des harmoniques 3, 5... qui ajoutent des notes)
    wOf[k] = c * c * Math.pow((k * binHz) / 80, -0.5);
  }
  const chroma = new Float64Array(12);
  const fr = new Float64Array(12);
  for (const mag of frames) {
    fr.fill(0);
    let s = 0;
    for (let k = kLo; k <= kHi; k++) {
      const v = Math.sqrt(mag[k]) * wOf[k];
      fr[pcOf[k]] += v;
      s += v;
    }
    if (s <= 1e-9) continue;
    for (let i = 0; i < 12; i++) chroma[i] += fr[i] / s;
  }
  let cs = 0;
  for (let i = 0; i < 12; i++) cs += chroma[i];
  if (cs <= 0) return undefined;

  const scores: Array<{ tonic: number; minor: boolean; r: number }> = [];
  for (let t = 0; t < 12; t++) {
    scores.push({ tonic: t, minor: false, r: pearson(chroma, KK_MAJOR, t) });
    scores.push({ tonic: t, minor: true, r: pearson(chroma, KK_MINOR, t) });
  }
  scores.sort((a, b) => b.r - a.r);
  const top = scores[0];
  if (top.r < 0.2) return undefined;
  const confidence = clamp01(0.6 * top.r + 3 * (top.r - scores[1].r));
  return {
    key: toCamelot(top.tonic, top.minor),
    confidence,
    chroma: Array.from(chroma, (v) => v / cs),
  };
}
