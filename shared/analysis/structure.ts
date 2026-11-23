/**
 * Scan accéléré d'un morceau complet (pré-écoute ×4, preservesPitch) -> forme d'onde 3 bandes +
 * structure (tempo, grille, phrases, sections, drops, outro). Tout est PUR et testable.
 *
 * Les positions sont TOUJOURS en temps-morceau (vitesse 1) : la console donne, pour chaque trame
 * captée, la position de début et de fin dans le morceau. Comme la hauteur est préservée, les bandes
 * de fréquence restent valables ; seule l'échelle de temps est comprimée, et on la défait en rangeant
 * chaque échantillon dans le point (1/pps s de morceau) qui lui correspond.
 */
import type { Section, StructureSection, TrackStructure, TrackWaveform } from '../contracts';
import { Biquad, clamp01, interp, normalizeBpm, plausibility } from './dsp';

export interface TrackScannerOptions {
  sampleRate: number;
  duration: number;
  pointsPerSecond?: number;
  bpmHint?: number;
}

/** Saut de position au-delà duquel on considère un « seek » (filtres remis à zéro). */
const SEEK_GAP = 0.25;

export class TrackScanner {
  readonly sampleRate: number;
  readonly duration: number;
  readonly pps: number;
  private readonly bpmHint: number;
  private readonly n: number;
  private sLow: Float64Array;
  private sMid: Float64Array;
  private sHigh: Float64Array;
  private cnt: Float64Array;
  private pk: Float32Array;
  private covered = 0;
  private lp200: Biquad;
  private lp2000: Biquad;
  private lastEnd = NaN;

  constructor(opts: TrackScannerOptions) {
    this.sampleRate = opts.sampleRate;
    this.duration = Math.max(0, opts.duration);
    this.pps = opts.pointsPerSecond && opts.pointsPerSecond > 0 ? opts.pointsPerSecond : 50;
    this.bpmHint = opts.bpmHint ?? 0;
    this.n = Math.max(1, Math.ceil(this.duration * this.pps));
    this.sLow = new Float64Array(this.n);
    this.sMid = new Float64Array(this.n);
    this.sHigh = new Float64Array(this.n);
    this.cnt = new Float64Array(this.n);
    this.pk = new Float32Array(this.n);
    this.lp200 = Biquad.lowpass(this.sampleRate, 200);
    this.lp2000 = Biquad.lowpass(this.sampleRate, 2000);
  }

  /** Trame mono captée, couvrant [trackPosStart, trackPosEnd] du morceau (s, vitesse 1). */
  push(frame: Float32Array, trackPosStart: number, trackPosEnd: number): void {
    const len = frame.length;
    if (len === 0 || !Number.isFinite(trackPosStart) || !Number.isFinite(trackPosEnd)) return;
    if (trackPosEnd <= trackPosStart) return; // pause / retour arrière : ignoré
    if (!(Math.abs(trackPosStart - this.lastEnd) < SEEK_GAP)) {
      this.lp200.reset();
      this.lp2000.reset();
    }
    this.lastEnd = trackPosEnd;
    const span = trackPosEnd - trackPosStart;
    const step = span / len;
    const pps = this.pps;
    for (let i = 0; i < len; i++) {
      const x = frame[i];
      const yl = this.lp200.process(x);
      const ym = this.lp2000.process(x);
      const pos = trackPosStart + (i + 0.5) * step;
      const p = Math.floor(pos * pps);
      if (p < 0 || p >= this.n) continue;
      const vm = ym - yl, vh = x - ym;
      if (this.cnt[p] === 0) this.covered++;
      this.sLow[p] += yl * yl;
      this.sMid[p] += vm * vm;
      this.sHigh[p] += vh * vh;
      this.cnt[p]++;
      const ax = x < 0 ? -x : x;
      if (ax > this.pk[p]) this.pk[p] = ax;
    }
  }

  coverage(): number {
    return this.covered / this.n;
  }

  getWaveform(trackId: number): TrackWaveform {
    const n = this.n;
    const low = new Float32Array(n), mid = new Float32Array(n), high = new Float32Array(n), peak = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      const c = this.cnt[p];
      if (!c) continue;
      low[p] = Math.sqrt(this.sLow[p] / c);
      mid[p] = Math.sqrt(this.sMid[p] / c);
      high[p] = Math.sqrt(this.sHigh[p] / c);
      peak[p] = this.pk[p];
    }
    for (const a of [low, mid, high, peak]) normalizeMax(a);
    return { trackId, pointsPerSecond: this.pps, low, mid, high, peak, coverage: this.coverage() };
  }

  getStructure(bpmHint?: number): TrackStructure | undefined {
    const w = this.getWaveform(0);
    const mask = new Uint8Array(this.n);
    for (let p = 0; p < this.n; p++) mask[p] = this.cnt[p] > 0 ? 1 : 0;
    return computeStructure(w, mask, bpmHint && bpmHint > 0 ? bpmHint : this.bpmHint);
  }
}

function normalizeMax(a: Float32Array): void {
  let m = 0;
  for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
  if (m > 0) for (let i = 0; i < a.length; i++) a[i] /= m;
}

/** Forme d'onde d'un tampon complet (démo, tests) : coverage 1. */
export function waveformFromBuffer(
  buf: { left: Float32Array; right?: Float32Array; sampleRate: number },
  trackId: number,
  pps = 50,
): TrackWaveform {
  const { left, right, sampleRate } = buf;
  const duration = left.length / sampleRate;
  const sc = new TrackScanner({ sampleRate, duration, pointsPerSecond: pps });
  const CH = 8192;
  const tmp = new Float32Array(CH);
  for (let s = 0; s < left.length; s += CH) {
    const e = Math.min(left.length, s + CH);
    const fr = e - s === CH ? tmp : new Float32Array(e - s);
    for (let i = s; i < e; i++) fr[i - s] = right ? 0.5 * (left[i] + right[i]) : left[i];
    sc.push(fr, s / sampleRate, e / sampleRate);
  }
  return sc.getWaveform(trackId);
}

/** Structure depuis une forme d'onde (points tous nuls = non couverts). */
export function structureFromWaveform(w: TrackWaveform, bpmHint?: number): TrackStructure | undefined {
  const n = w.low.length;
  const mask = new Uint8Array(n);
  for (let p = 0; p < n; p++) mask[p] = w.low[p] + w.mid[p] + w.high[p] + w.peak[p] > 0 ? 1 : 0;
  return computeStructure(w, mask, bpmHint ?? 0);
}

// ---------------------------------------------------------------------------------------------
// Analyse de structure
// ---------------------------------------------------------------------------------------------

interface Bar {
  start: number;     // position (s) du premier temps de la mesure
  low: number;
  mid: number;
  high: number;
  energy: number;
  covered: boolean;
}

function percentile(vals: number[], q: number): number {
  if (!vals.length) return 0;
  const s = vals.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}

/** Autocorrélation avec masque (paires valides seulement), signal centré sur les points valides. */
function maskedAutocorr(x: Float64Array, m: Uint8Array, maxLag: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0, c = 0;
    for (let i = 0; i + lag < n; i++) {
      if (m[i] && m[i + lag]) { s += x[i] * x[i + lag]; c++; }
    }
    out[lag] = c > 0 ? s / c : 0;
  }
  const a0 = out[0] || 1;
  for (let i = 0; i <= maxLag; i++) out[i] /= a0;
  return out;
}

function computeStructure(w: TrackWaveform, mask: Uint8Array, bpmHint: number): TrackStructure | undefined {
  const fps = w.pointsPerSecond;
  const n = w.low.length;
  let nCov = 0;
  for (let i = 0; i < n; i++) nCov += mask[i];
  if (nCov < fps * 15) return undefined;

  // ---- fonction d'attaque (flux positif ; nul aux bords des zones non couvertes)
  const odf = new Float64Array(n);
  const om = new Uint8Array(n);
  let mL = 0, mO = 0, cL = 0;
  for (let i = 1; i < n; i++) {
    if (!mask[i] || !mask[i - 1]) continue;
    mL += Math.max(0, w.low[i] - w.low[i - 1]);
    mO += Math.max(0, w.mid[i] - w.mid[i - 1]) + Math.max(0, w.high[i] - w.high[i - 1]);
    cL++;
  }
  mL = mL / Math.max(1, cL) || 1;
  mO = mO / Math.max(1, cL) || 1;
  for (let i = 1; i < n; i++) {
    if (!mask[i] || !mask[i - 1]) continue;
    om[i] = 1;
    odf[i] = Math.max(0, w.low[i] - w.low[i - 1]) / mL
      + 0.5 * (Math.max(0, w.mid[i] - w.mid[i - 1]) + Math.max(0, w.high[i] - w.high[i - 1])) / mO;
  }
  // centrage (moyenne locale ~1 s retirée)
  const odfc = new Float64Array(n);
  {
    const half = Math.round(fps * 0.5);
    for (let i = 0; i < n; i++) {
      if (!om[i]) continue;
      let s = 0, c = 0;
      for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j += 2) if (om[j]) { s += odf[j]; c++; }
      odfc[i] = Math.max(0, odf[i] - (c ? s / c : 0));
    }
    let s = 0, c = 0;
    for (let i = 0; i < n; i++) if (om[i]) { s += odfc[i]; c++; }
    const m = c ? s / c : 0;
    for (let i = 0; i < n; i++) if (om[i]) odfc[i] -= m;
  }

  // ---- tempo : peigne sur l'autocorrélation masquée
  const hint = normalizeBpm(bpmHint);
  const lo = hint > 0 ? hint * 0.96 : 70;
  const hi = hint > 0 ? hint * 1.04 : 180;
  const K = 8;
  const maxLag = Math.min(n - 2, Math.ceil((fps * 60 / lo) * K) + 2);
  const ac = maskedAutocorr(odfc, om, maxLag);
  let bpm = 0, bestS = -Infinity;
  const combAt = (b: number) => {
    let s = 0, c = 0;
    for (let k = 1; k <= K; k++) {
      const lag = (k * fps * 60) / b;
      if (lag > maxLag - 1) break;
      s += interp(ac, lag); c++;
    }
    return c ? s / c : 0;
  };
  for (let b = lo; b <= hi; b += 0.05) {
    const sc = combAt(b) * (hint > 0 ? 1 : 0.6 + 0.4 * plausibility(b, 1));
    if (sc > bestS) { bestS = sc; bpm = b; }
  }
  if (bpm <= 0) return undefined;
  if (hint <= 0) {
    // demi / double : le double est retenu s'il est aussi présent à mi-période
    const half = bpm / 2, dbl = bpm * 2;
    if (dbl <= 180 && combAt(dbl) > 0.75 * combAt(bpm)) bpm = dbl;
    else if (half >= 70 && interp(ac, (fps * 60) / bpm) < 0.5 * interp(ac, (fps * 60) / half) && plausibility(half) > plausibility(bpm)) bpm = half;
  }

  // ---- affinage tempo + phase : longueur du vecteur moyen (moyenne circulaire) sur tout le morceau
  const phaseFit = (b: number) => {
    const P = (fps * 60) / b;
    let cx = 0, cy = 0, sw = 0;
    for (let i = 0; i < n; i++) {
      const v = odf[i];
      if (!om[i] || v <= 0) continue;
      const a = (2 * Math.PI * i) / P;
      cx += v * Math.cos(a); cy += v * Math.sin(a); sw += v;
    }
    return { r: sw > 0 ? Math.hypot(cx, cy) / sw : 0, ang: Math.atan2(cy, cx) };
  };
  let fit = phaseFit(bpm);
  for (let b = bpm * 0.995; b <= bpm * 1.005; b += bpm * 0.0001) {
    const f = phaseFit(b);
    if (f.r > fit.r) { fit = f; bpm = b; }
  }
  const beatSec = 60 / bpm;
  // pic d'attaque = point i (centre du point à (i + 0.5)/fps) ; la montée commence ~1/2 point avant
  let firstBeat = ((fit.ang / (2 * Math.PI)) * beatSec + beatSec) % beatSec;
  firstBeat = ((firstBeat - 0.5 / fps) % beatSec + beatSec) % beatSec;
  const nBeats = Math.floor((n / fps - firstBeat) / beatSec) + 1;

  // ---- par temps : basse au temps (kick), énergies moyennes
  const beatLow = new Float64Array(nBeats);
  const beatCov = new Uint8Array(nBeats);
  for (let k = 0; k < nBeats; k++) {
    const t = firstBeat + k * beatSec;
    const a = Math.max(0, Math.floor(t * fps) - 1), z = Math.min(n - 1, Math.floor((t + 0.08) * fps));
    let mx = 0, cov = 0;
    for (let i = a; i <= z; i++) if (mask[i]) { cov++; if (w.low[i] > mx) mx = w.low[i]; }
    beatLow[k] = mx;
    beatCov[k] = cov > 0 ? 1 : 0;
  }
  // premier temps de mesure : (1) position mod 4 où la basse au temps est la plus forte ;
  // (2) position mod 4 où tombent les grands changements d'énergie (débuts de sections = premiers temps)
  const beatE = new Float64Array(nBeats);
  for (let k = 0; k < nBeats; k++) beatE[k] = beatEnergy(firstBeat + k * beatSec, beatSec, w, mask, fps);
  const lowSc = [0, 0, 0, 0], chSc = [0, 0, 0, 0];
  for (let k = 0; k < nBeats; k++) if (beatCov[k]) lowSc[k % 4] += beatLow[k];
  // novelté de la basse (kick qui disparaît / revient) et de l'énergie globale, sur 4 temps de part et d'autre
  const novelty = (src: Float64Array): Float64Array => {
    const out = new Float64Array(nBeats);
    for (let k = 4; k + 4 <= nBeats; k++) {
      let a = 0, b = 0, ok = true;
      for (let j = 0; j < 4; j++) { if (!beatCov[k - 1 - j] || !beatCov[k + j]) ok = false; a += src[k - 1 - j]; b += src[k + j]; }
      if (ok) out[k] = Math.abs(b - a) / 4;
    }
    return out;
  };
  // seuls les grands changements (pics) votent : les breaks de batterie en fin de phrase ne doivent pas compter
  const vote = (nov: Float64Array, thr: number, weight: number) => {
    let mx = 0;
    for (let k = 0; k < nBeats; k++) if (nov[k] > mx) mx = nov[k];
    if (mx <= 0) return;
    for (let k = 2; k + 2 < nBeats; k++) {
      const v = nov[k];
      if (v < thr * mx || v < nov[k - 1] || v < nov[k + 1] || v < nov[k - 2] || v < nov[k + 2]) continue;
      chSc[k % 4] += weight * (v / mx) ** 2;
    }
  };
  vote(novelty(beatLow), 0.5, 1);
  const norm = (v: number[]) => { const m = Math.max(...v); return m > 0 ? v.map((x) => x / m) : v.map(() => 0); };
  const lowN = norm(lowSc), chN = norm(chSc);
  const lowSpread = Math.max(...lowSc) > 0 ? 1 - Math.min(...lowSc) / Math.max(...lowSc) : 0;
  const chSpread = Math.max(...chSc) > 0 ? 1 - percentile(chSc, 0.67) / Math.max(...chSc) : 0;
  const sc4 = [0, 1, 2, 3].map((i) => lowN[i] * lowSpread + chN[i] * chSpread * 2);
  let down = 0;
  for (let i = 1; i < 4; i++) if (sc4[i] > sc4[down]) down = i;
  const downContrast = Math.max(...sc4) > 0 ? (sc4[down] - percentile(sc4, 0.67)) / sc4[down] : 0;

  // ---- mesures
  const bars: Bar[] = [];
  const firstDown = firstBeat + down * beatSec;
  const barSec = 4 * beatSec;
  // mesure partielle avant le premier temps fort : ignorée (souvent du silence ou une levée)
  for (let b = 0; firstDown + b * barSec < n / fps; b++) {
    const s = firstDown + b * barSec;
    const a = Math.floor(s * fps), z = Math.min(n, Math.floor((s + barSec) * fps));
    let l = 0, m = 0, h = 0, c = 0;
    for (let i = a; i < z; i++) if (mask[i]) { l += w.low[i]; m += w.mid[i]; h += w.high[i]; c++; }
    const covered = c > (z - a) * 0.5;
    bars.push({ start: s, low: c ? l / c : 0, mid: c ? m / c : 0, high: c ? h / c : 0, energy: c ? (l + m + h) / (3 * c) : 0, covered });
  }
  const cov = bars.filter((b) => b.covered);
  if (cov.length < 4) return undefined;
  const lowRef = percentile(cov.map((b) => b.low), 0.9) || 1;
  const eRef = percentile(cov.map((b) => b.energy), 0.9) || 1;

  // ---- caractéristiques par mesure (trous comblés par la mesure couverte la plus proche)
  const vRef = percentile(cov.map((b) => b.mid + b.high), 0.9) || 1;
  const nb = bars.length;
  const lr = new Float64Array(nb), vv = new Float64Array(nb);
  for (let i = 0; i < nb; i++) {
    let j = i;
    if (!bars[i].covered) {
      let d = 1;
      while (d < nb && !(i - d >= 0 && bars[i - d].covered) && !(i + d < nb && bars[i + d].covered)) d++;
      j = i - d >= 0 && bars[i - d].covered ? i - d : Math.min(nb - 1, i + d);
    }
    lr[i] = Math.min(1.5, bars[j].low / lowRef);
    vv[i] = Math.min(1.5, (bars[j].mid + bars[j].high) / vRef);
  }

  // ---- frontières : pics de nouveauté (médianes sur 4 mesures de part et d'autre, robustes aux breaks)
  const W = 4;
  const novB = new Float64Array(nb);
  for (let i = 2; i <= nb - 2; i++) {
    const L0 = Math.max(0, i - W), R1 = Math.min(nb, i + W);
    const dl = median(Array.from(lr.slice(i, R1))) - median(Array.from(lr.slice(L0, i)));
    const dv = median(Array.from(vv.slice(i, R1))) - median(Array.from(vv.slice(L0, i)));
    // les médianes donnent un plateau de ±1 mesure autour d'un échelon : la moyenne (pic net) départage
    const ml = avg(Array.from(lr.slice(i, R1))) - avg(Array.from(lr.slice(L0, i)));
    const mv = avg(Array.from(vv.slice(i, R1))) - avg(Array.from(vv.slice(L0, i)));
    novB[i] = Math.abs(dl) + 1.5 * Math.abs(dv) + 0.3 * (Math.abs(ml) + 1.5 * Math.abs(mv));
  }
  const cand: number[] = [];
  for (let i = 2; i <= nb - 2; i++) {
    if (novB[i] < 0.15) continue;
    let isMax = true;
    for (let d = -3; d <= 3 && isMax; d++) {
      const j = i + d;
      if (d !== 0 && j >= 0 && j < nb && (novB[j] > novB[i] || (novB[j] === novB[i] && j < i))) isMax = false;
    }
    if (isMax) cand.push(i);
  }
  const boundsIdx = [0, ...cand, nb];

  interface Seg { a: number; z: number; lr: number; v: number; kick: boolean; section: Section }
  let segs: Seg[] = [];
  for (let k = 0; k + 1 < boundsIdx.length; k++) {
    const a0 = boundsIdx[k], z0 = boundsIdx[k + 1] - 1;
    const l = median(Array.from(lr.slice(a0, z0 + 1))), v = median(Array.from(vv.slice(a0, z0 + 1)));
    segs.push({ a: a0, z: z0, lr: l, v, kick: l >= 0.4, section: 'unknown' });
  }

  // ---- noms de sections
  // niveau d'un segment avec kick : médiums + aigus, plus la basse (la basse qui s'ajoute au kick compte)
  const level = (g: Seg) => g.v + 0.5 * Math.min(1, g.lr);
  // niveau « principal » : quantile 75 % des mesures avec kick (robuste aux breaks et segments courts)
  const levKick: number[] = [];
  for (let i = 0; i < nb; i++) if (lr[i] >= 0.4) levKick.push(vv[i] + 0.5 * Math.min(1, lr[i]));
  const vMax = percentile(levKick, 0.75);
  const isHi = (g: Seg) => g.kick && level(g) >= vMax - 0.1;
  let seenMain = false;
  for (let i = 0; i < segs.length; i++) {
    const g = segs[i], prev = segs[i - 1];
    const isFirst = i === 0, isLast = i === segs.length - 1;
    if (!g.kick) g.section = isFirst ? 'intro' : isLast && seenMain ? 'outro' : isLast ? 'outro' : 'breakdown';
    else if (prev && !prev.kick) g.section = 'drop';
    else if (isHi(g) && prev && prev.kick && level(g) - level(prev) >= 0.1) g.section = 'drop';
    else if (!isHi(g) && isFirst && segs.length > 1) g.section = 'intro';
    else if (!isHi(g) && isLast && seenMain) g.section = 'outro';
    else g.section = 'body';
    if (g.kick && (g.section === 'drop' || g.section === 'body')) seenMain = true;
  }
  // intro / outro : toute la suite de segments calmes (sans kick ou en dessous du niveau principal)
  // avant le premier / après le dernier segment principal
  const calm = (g: Seg) => !g.kick || !isHi(g);
  const firstMain = segs.findIndex((g) => !calm(g));
  // (intro : seulement les segments sans kick du début, plus le premier s'il est calme ; un couplet
  // calme avant le premier refrain reste un « body »)
  if (firstMain > 0) {
    for (let i = 0; i < firstMain; i++) {
      if (segs[i].section === 'drop') break;
      if (i === 0 || !segs[i].kick) segs[i].section = 'intro';
      else break;
    }
  }
  let lastMain = -1;
  for (let i = segs.length - 1; i >= 0; i--) if (!calm(segs[i])) { lastMain = i; break; }
  if (lastMain >= 0) for (let i = lastMain + 1; i < segs.length; i++) segs[i].section = 'outro';
  // validation stricte de l'outro (dans le doute, pas d'outro : le cerveau gère la fin par la durée) :
  // (a) dans le dernier tiers ; (b) basse en baisse d'au moins 40 % jusqu'à la fin par rapport au
  // dernier passage principal, OU énergie en baisse (>= 10 %) puis non croissante jusqu'à la fin sur >= 16 temps.
  // Un « body » plus calme mais qui varie encore (breaks, remontées) n'est pas une outro.
  {
    const dur = n / fps;
    const mainRef = lastMain >= 0 ? median(Array.from(lr.slice(segs[lastMain].a, segs[lastMain].z + 1))) : 1;
    const valid = (j: number): boolean => {
      const a0 = segs[j].a;
      if (bars[a0].start < dur * (2 / 3)) return false;
      if (dur - bars[a0].start < 16 * beatSec) return false; // au moins 16 temps jusqu'à la fin
      const tailLow = median(Array.from(lr.slice(a0, nb)));
      if (tailLow <= 0.6 * mainRef) return true;
      // énergie : marche descendante par rapport aux 4 mesures précédentes, puis plus aucune remontée
      // jusqu'à la fin (dernière mesure incomplète ignorée), sur au moins 4 mesures (16 temps)
      const e = bars.slice(a0).filter((b) => b.covered && b.start + barSec <= dur + 1e-6).map((b) => b.energy);
      if (e.length < 4) return false;
      for (let i = 1; i < e.length; i++) if (e[i] > e[i - 1] * 1.08 + 1e-3) return false;
      const before = bars.slice(Math.max(0, a0 - 4), a0).filter((b) => b.covered).map((b) => b.energy);
      return before.length > 0 && avg(e) <= 0.9 * avg(before);
    };
    let start = -1;
    for (let j = 0; j < segs.length; j++) {
      if (segs[j].section !== 'outro') continue;
      if (valid(j)) { start = j; break; }
    }
    for (let j = 0; j < segs.length; j++) {
      if (segs[j].section === 'outro' && (start < 0 || j < start)) segs[j].section = segs[j].kick ? 'body' : 'breakdown';
    }
    // un « breakdown » final non validé comme outro reste un breakdown ; un body final reste un body
  }
  // montée : fin d'un breakdown où médiums + aigus montent nettement -> build
  const withBuild: Seg[] = [];
  for (const g of segs) {
    if (g.section === 'breakdown' && g.z - g.a >= 3) {
      const vals = Array.from(vv.slice(g.a, g.z + 1));
      const q = Math.max(2, Math.floor(vals.length / 4));
      const first = avg(vals.slice(0, q)), last = avg(vals.slice(-q));
      if (first > 0 && last > first * 1.3) {
        const thr = (first + last) / 2;
        let j = vals.findIndex((x, k) => k >= q && x > thr);
        if (j < 1) j = vals.length - q;
        withBuild.push({ ...g, z: g.a + j - 1 });
        withBuild.push({ ...g, a: g.a + j, section: 'build' });
        continue;
      }
    }
    withBuild.push(g);
  }
  segs = withBuild;
  // fusion des voisins de même nom
  segs = segs.reduce<Seg[]>((acc, g) => {
    const last = acc[acc.length - 1];
    if (last && last.section === g.section && g.section !== 'drop') last.z = g.z;
    else if (last && last.section === 'drop' && g.section === 'drop' && !(level(g) - level(last) >= 0.1)) last.z = g.z;
    else acc.push({ ...g });
    return acc;
  }, []);
  const segE = (g: Seg) => avg(bars.slice(g.a, g.z + 1).filter((b) => b.covered).map((b) => b.energy));

  // ---- drops : retour net des basses + énergie, au temps près
  // recalage d'un début de drop au temps près : retour du kick après un breakdown : contraste « 4 temps
  // après - 4 temps avant » (énergie + basse), maximal, parmi les premiers temps de mesure à ±2 mesures
  const lowP90 = percentile(Array.from(beatLow), 0.9) || 1;
  const eP90 = percentile(Array.from(beatE), 0.9) || 1;
  const refine = (barStart: number, sign = 1): number => {
    const k0 = Math.round((barStart - firstBeat) / beatSec);
    let best = k0, bestSc = -Infinity;
    for (let k = Math.max(4, k0 - 8); k <= Math.min(nBeats - 4, k0 + 8); k++) {
      if ((((k - down) % 4) + 4) % 4 !== 0) continue; // un drop tombe sur un premier temps
      let ea = 0, eb = 0, la = 0, lb = 0, ok = true;
      for (let j = 0; j < 4; j++) {
        if (!beatCov[k - 1 - j] || !beatCov[k + j]) ok = false;
        ea += beatE[k - 1 - j]; eb += beatE[k + j]; la += beatLow[k - 1 - j]; lb += beatLow[k + j];
      }
      if (!ok) continue;
      const sc = sign * ((0.5 * (eb - ea)) / (4 * eP90) + (1.5 * (lb - la)) / (4 * lowP90)) - 0.01 * Math.abs(k - k0);
      if (sc > bestSc) { bestSc = sc; best = k; }
    }
    return firstBeat + best * beatSec;
  };
  const drops: Array<{ pos: number; score: number; order: number }> = [];
  segs.forEach((s, i) => {
    if (s.section !== 'drop') return;
    const prev = segs[i - 1];
    if (!prev) return;
    const before = bars.slice(Math.max(0, s.a - 2), s.a).filter((b) => b.covered);
    const after = bars.slice(s.a, Math.min(bars.length, s.a + 2)).filter((b) => b.covered);
    if (!before.length || !after.length) return;
    const dE = avg(after.map((b) => b.energy)) - avg(before.map((b) => b.energy));
    const dL = avg(after.map((b) => b.low)) - avg(before.map((b) => b.low));
    const score = Math.max(0, dE) / eRef + 0.7 * Math.max(0, dL) / lowRef
      + (prev.section === 'breakdown' || prev.section === 'build' ? 0.3 : 0);
    // retour du kick : recalé au temps près ; refrain (le kick était déjà là) : la frontière de mesure
    // trouvée par la nouveauté est plus fiable (les breaks de fin de couplet trompent un recalage local)
    const pos = prev.kick ? bars[s.a].start : refine(bars[s.a].start);
    drops.push({ pos, score, order: i });
  });
  drops.sort((a, b) => (Math.abs(a.score - b.score) < 0.1 * Math.max(a.score, b.score) ? a.order - b.order : b.score - a.score));

  // ---- phrases : 16 si les frontières tombent plus souvent sur 16 (mod 32) que sur 0
  const bounds = segs.slice(1).map((s) => Math.round((bars[s.a].start - firstDown) / beatSec));
  let on0 = 0, on16 = 0;
  for (const bt of bounds) { const m = ((bt % 32) + 32) % 32; if (m === 0) on0++; else if (m === 16) on16++; }
  // origine des phrases : décalage (en mesures, mod 8) qui aligne le plus de frontières
  const offScore = new Array(8).fill(0);
  for (const bt of bounds) offScore[(((Math.round(bt / 4)) % 8) + 8) % 8]++;
  let bestOff = 0;
  for (let i = 1; i < 8; i++) if (offScore[i] > offScore[bestOff]) bestOff = i;
  const barsOff = bestOff % (on16 > on0 ? 4 : 8);
  const phraseBeats: 16 | 32 = on16 > on0 ? 16 : 32;
  let firstDownbeatPos = firstDown + barsOff * barSec;
  while (firstDownbeatPos - phraseBeats * beatSec >= -0.05) firstDownbeatPos -= phraseBeats * beatSec;
  // en dessous de 0, on garde le premier premier-temps positif sur la même grille de mesures
  while (firstDownbeatPos < -0.05) firstDownbeatPos += barSec;

  const sections: StructureSection[] = segs.map((s, i) => ({
    section: s.section,
    startPos: i === 0 ? 0 : bars[s.a].start,
    endPos: i === segs.length - 1 ? n / fps : bars[s.z].start + barSec,
    energy: clamp01(segE(s) / eRef),
  }));
  // les sections « drop » commencent au temps recalé
  for (const d of drops) {
    const cur = sections[d.order], prev = sections[d.order - 1];
    if (prev && d.pos > prev.startPos && d.pos < cur.endPos) { cur.startPos = d.pos; prev.endPos = d.pos; }
  }
  const outro = segs.findIndex((s) => s.section === 'outro');
  // début d'outro recalé sur le premier temps où l'énergie et la basse baissent le plus (±2 mesures)
  if (outro > 0) {
    const p = refine(sections[outro].startPos, -1);
    if (p > sections[outro - 1].startPos && p < sections[outro].endPos && p >= (n / fps) * (2 / 3)) { sections[outro].startPos = p; sections[outro - 1].endPos = p; }
  }
  const covFrac = nCov / n;
  const contrast = clamp01(1 - (percentile(cov.map((b) => b.low), 0.1) / lowRef));
  const confidence = clamp01(
    (0.45 * clamp01(fit.r * 2.5) + 0.25 * clamp01(downContrast * 3) + 0.3 * (drops.length ? 1 : contrast * 0.5)) * Math.min(1, covFrac * 1.1),
  );
  return {
    bpm: Math.round(bpm * 100) / 100,
    firstDownbeatPos: Math.round(firstDownbeatPos * 1000) / 1000,
    phraseBeats,
    sections,
    dropPositions: drops.map((d) => Math.round(d.pos * 1000) / 1000),
    outroPos: outro >= 0 ? sections[outro].startPos : undefined,
    confidence,
  };
}

function beatEnergy(t: number, beatSec: number, w: TrackWaveform, mask: Uint8Array, fps: number): number {
  const a = Math.max(0, Math.floor(t * fps)), z = Math.min(w.low.length, Math.floor((t + beatSec) * fps));
  let s = 0, c = 0;
  for (let i = a; i < z; i++) if (mask[i]) { s += w.low[i] + w.mid[i] + w.high[i]; c++; }
  return c ? s / (3 * c) : 0;
}

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

function avg(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}
