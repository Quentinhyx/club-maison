/**
 * Suivi de temps en direct (PUR, sans Web Audio) : on lui pousse des trames mono successives
 * horodatées en temps ctx, il estime tempo, phase, premier temps de mesure, énergie, section et
 * grille de phrases.
 *
 * Principe :
 *  - par échantillon : passe-bas 150 Hz (kick/basse) et passe-haut 2 kHz (charleys, caisse claire) ;
 *  - par pas de ~5 ms : énergies RMS -> fonction d'attaque (flux positif des amplitudes, normalisé) ;
 *  - toutes les 250 ms : autocorrélation sur 8 s + peigne (4 multiples) autour du bpmHint -> tempo
 *    lissé ; phase par peigne d'impulsions sur les 8 derniers temps -> boucle à verrouillage de phase
 *    (correction partielle, la grille ne saute pas) ;
 *  - quand le kick disparaît (breakdown), la grille continue « au volant d'inertie » sans correction ;
 *  - premier temps : position (mod 4) où l'énergie basse au moment du temps est la plus forte,
 *    accumulée sur plusieurs mesures avec hystérésis ; réancré sur un drop ;
 *  - sections : machine à états sur les énergies par temps (voir updateSection).
 */
import type { LiveAnalysis, Section } from '../contracts';
import { Biquad, ampToDb, autocorr, clamp01, combScore, dbTo01, interp, plausibility } from './dsp';

export interface LiveBeatTrackerOptions {
  sampleRate: number;
  bpmHint?: number;
}

interface BeatRec {
  idx: number;
  ctx: number;
  lowPeak: number;
  lowMean: number;
  highMean: number;
}

const RING_SECONDS = 12;
const WINDOW_SECONDS = 8;
const EST_INTERVAL = 0.25;
const MIN_SECONDS_BEFORE_LOCK = 3;
/** Retard moyen entre l'attaque réelle et le pic de la fonction d'attaque (s), calibré sur un kick. */
const ONSET_LATENCY = 0.0;

export class LiveBeatTracker {
  private readonly sr: number;
  private readonly hop: number;
  private readonly fps: number;
  private readonly R: number;
  private bpmHint = 0;

  // anneaux par pas
  private odfLow!: Float64Array;
  private odfHigh!: Float64Array;
  private lowAmp!: Float64Array;
  private highAmp!: Float64Array;
  private times!: Float64Array;
  private hopCount = 0;

  // filtres + accumulateurs
  private lp!: Biquad;
  private hp!: Biquad;
  private accN = 0;
  private accLow = 0;
  private accHigh = 0;
  private accFull = 0;
  private prevLowA = 0;
  private prevHighA = 0;
  private mFluxLow = 0;
  private mFluxHigh = 0;
  private lastSampleCtx = 0;
  private startCtx: number | undefined;

  // enveloppes (puissance)
  private pLowFast = 0;
  private pLowShort = 0;
  private pFullShort = 0;
  private pFullLong = 0;
  private pHighShort = 0;
  private lowRef = 0;

  // grille de temps
  private bpm = 0;
  private bpmDisagree = 0;
  private beatCtx: number | undefined;
  private beatIdx = 0;
  private phaseUpdates = 0;
  private phaseErrAvg = 0.5;
  private bigErrCount = 0;
  private strength = 0;
  private estHist: number[] = [];
  /** Écart (s) entre l'attaque basse mesurée et le temps de la grille, par temps (NaN = pas d'attaque). */
  private devHist: number[] = [];
  private pending: Array<{ idx: number; ctx: number }> = [];
  private beats: BeatRec[] = [];

  // mesure / phrase / section
  private barScores = [0, 0, 0, 0];
  private downPos = 0;
  private downChallenger = -1;
  private downChallengeCount = 0;
  private downStableBars = 0;
  private anchorIdx: number | undefined;
  private phraseBeats: 16 | 32 = 32;
  private section: Section = 'unknown';
  private sectionStartIdx = 0;
  private quietBeats = 0;
  private quietStartIdx = 0;
  private seenStructure = false;
  private trackPos: { pos: number; at: number; duration?: number } | undefined;

  constructor(opts: LiveBeatTrackerOptions) {
    this.sr = opts.sampleRate;
    this.hop = Math.max(16, Math.round(this.sr / 200));
    this.fps = this.sr / this.hop;
    this.R = Math.ceil(this.fps * RING_SECONDS);
    this.reset(opts.bpmHint);
  }

  reset(bpmHint?: number): void {
    this.bpmHint = bpmHint && bpmHint > 0 ? bpmHint : 0;
    this.odfLow = new Float64Array(this.R);
    this.odfHigh = new Float64Array(this.R);
    this.lowAmp = new Float64Array(this.R);
    this.highAmp = new Float64Array(this.R);
    this.times = new Float64Array(this.R);
    this.hopCount = 0;
    this.lp = Biquad.lowpass(this.sr, 150);
    this.hp = Biquad.highpass(this.sr, 2000);
    this.accN = this.accLow = this.accHigh = this.accFull = 0;
    this.prevLowA = this.prevHighA = 0;
    this.mFluxLow = this.mFluxHigh = 0;
    this.lastSampleCtx = 0;
    this.startCtx = undefined;
    this.pLowFast = this.pLowShort = this.pFullShort = this.pFullLong = this.pHighShort = 0;
    this.lowRef = 0;
    this.bpm = this.bpmHint;
    this.bpmDisagree = 0;
    this.beatCtx = undefined;
    this.beatIdx = 0;
    this.phaseUpdates = 0;
    this.phaseErrAvg = 0.5;
    this.bigErrCount = 0;
    this.strength = 0;
    this.estHist = [];
    this.devHist = [];
    this.pending = [];
    this.beats = [];
    this.barScores = [0, 0, 0, 0];
    this.downPos = 0;
    this.downChallenger = -1;
    this.downChallengeCount = 0;
    this.downStableBars = 0;
    this.anchorIdx = undefined;
    this.phraseBeats = 32;
    this.section = 'unknown';
    this.sectionStartIdx = 0;
    this.quietBeats = 0;
    this.quietStartIdx = 0;
    this.seenStructure = false;
    this.trackPos = undefined;
  }

  /** Optionnel : position dans le morceau (s) à l'instant ctx `atCtx`, et durée totale si connue.
   *  Sert à l'intro / l'outro. */
  setTrackPosition(pos: number, atCtx: number, duration?: number): void {
    this.trackPos = { pos, at: atCtx, duration };
  }

  push(frame: Float32Array, frameEndCtx: number): void {
    const n = frame.length;
    if (n === 0) return;
    const first = frameEndCtx - n / this.sr;
    if (this.startCtx === undefined) this.startCtx = first;
    const H = this.hop;
    for (let i = 0; i < n; i++) {
      const x = frame[i];
      const lo = this.lp.process(x);
      const hi = this.hp.process(x);
      this.accLow += lo * lo;
      this.accHigh += hi * hi;
      this.accFull += x * x;
      if (++this.accN === H) {
        const tEnd = first + (i + 1) / this.sr;
        this.processHop(tEnd - H / (2 * this.sr), tEnd);
        this.accN = 0;
        this.accLow = this.accHigh = this.accFull = 0;
      }
    }
    this.lastSampleCtx = frameEndCtx;
  }

  getState(): LiveAnalysis | undefined {
    if (this.beatCtx === undefined || this.bpm <= 0) return undefined;
    const Ps = 60 / this.bpm;
    const back = (((this.beatIdx - this.downPos) % 4) + 4) % 4;
    const downbeatCtx = this.beatCtx - back * Ps;
    const nextPhraseCtx = this.computeNextPhrase(Ps);
    const lockRamp = clamp01(this.phaseUpdates / 8);
    const beatConfidence = clamp01(
      clamp01(this.strength * 1.6) * clamp01(1 - this.phaseErrAvg * 3) * lockRamp,
    );
    return {
      bpm: Math.round(this.bpm * 100) / 100,
      downbeatCtx,
      beatConfidence,
      beatIndex: this.beatIdx,
      energyShort: dbTo01(ampToDb(Math.sqrt(this.pFullShort)), -48, -6),
      energyLong: dbTo01(ampToDb(Math.sqrt(this.pFullLong)), -48, -6),
      lowEnergy: dbTo01(ampToDb(Math.sqrt(this.pLowShort)), -50, -8),
      section: this.section,
      nextPhraseCtx,
      phraseBeats: this.phraseBeats,
    };
  }

  /**
   * Stabilité du tempo en direct, 0..1 (1 = tempo de machine). Combine la dispersion des estimations
   * brutes de tempo sur les ~16 dernières secondes (0 vers 3 %), l'erreur de phase moyenne de la
   * boucle (0 vers 6 % de période), la gigue des intervalles entre attaques basses successives
   * (0 vers 2,5 % de période) et la force de la pulsation. 0 tant qu'il n'y a pas assez de recul.
   */
  getTempoStability(): number {
    const h = this.estHist;
    if (h.length < 12 || this.beatCtx === undefined) return 0;
    const m = h.reduce((a, b) => a + b, 0) / h.length;
    const cv = Math.sqrt(h.reduce((a, b) => a + (b - m) ** 2, 0) / h.length) / m;
    const sTempo = clamp01(1 - (cv - 0.003) / (0.03 - 0.003));
    const sPhase = clamp01(1 - (this.phaseErrAvg - 0.015) / 0.045);
    // gigue des intervalles entre attaques successives, relative à la période
    const Ps = 60 / this.bpm;
    let d2 = 0, nd = 0;
    for (let i = 1; i < this.devHist.length; i++) {
      const a = this.devHist[i - 1], b = this.devHist[i];
      if (Number.isFinite(a) && Number.isFinite(b)) { d2 += (b - a) ** 2; nd++; }
    }
    const sJit = nd >= 8 ? clamp01(1 - (Math.sqrt(d2 / nd) / Ps - 0.008) / (0.025 - 0.008)) : 0;
    return clamp01(Math.min(sTempo, sPhase, sJit) * clamp01(this.strength / 0.35));
  }

  // -------------------------------------------------------------------------------------------

  private processHop(tc: number, tEnd: number): void {
    const H = this.hop;
    const lowA = Math.sqrt(this.accLow / H);
    const highA = Math.sqrt(this.accHigh / H);
    const pFull = this.accFull / H;
    const fl = Math.max(0, lowA - this.prevLowA);
    const fh = Math.max(0, highA - this.prevHighA);
    this.prevLowA = lowA;
    this.prevHighA = highA;
    const aMean = 1 / (this.fps * 4);
    this.mFluxLow += (fl - this.mFluxLow) * (this.hopCount < this.fps ? 1 / (this.hopCount + 1) : aMean);
    this.mFluxHigh += (fh - this.mFluxHigh) * (this.hopCount < this.fps ? 1 / (this.hopCount + 1) : aMean);

    const r = this.hopCount % this.R;
    this.odfLow[r] = fl / (this.mFluxLow + 1e-9);
    this.odfHigh[r] = fh / (this.mFluxHigh + 1e-9);
    this.lowAmp[r] = lowA;
    this.highAmp[r] = highA;
    this.times[r] = tc;
    this.hopCount++;

    const k = (tau: number) => 1 - Math.exp(-1 / (this.fps * tau));
    const pLow = lowA * lowA;
    this.pLowFast += (pLow - this.pLowFast) * k(0.12);
    this.pLowShort += (pLow - this.pLowShort) * k(0.6);
    this.pHighShort += (highA * highA - this.pHighShort) * k(0.6);
    this.pFullShort += (pFull - this.pFullShort) * k(1);
    this.pFullLong += (pFull - this.pFullLong) * k(8);
    const lowS = Math.sqrt(this.pLowShort);
    if (lowS > this.lowRef) this.lowRef += (lowS - this.lowRef) * k(1.5);
    else this.lowRef *= 1 - k(90);

    // retour du kick après un breakdown / build : drop, détecté au plus vite
    if ((this.section === 'breakdown' || this.section === 'build') && this.beatCtx !== undefined) {
      if (Math.sqrt(this.pLowFast) > 0.5 * this.lowRef) this.triggerDrop(tc);
    }

    if (this.hopCount % Math.round(this.fps * EST_INTERVAL) === 0
      && this.hopCount >= this.fps * MIN_SECONDS_BEFORE_LOCK) {
      this.estimate(tEnd);
    }
    this.advanceBeats(tEnd);
  }

  private lowEstablished(): boolean {
    return this.lowRef > 0.004;
  }

  private kickActive(): boolean {
    return Math.sqrt(this.pLowShort) > 0.35 * this.lowRef;
  }

  private estimate(now: number): void {
    const fps = this.fps;
    const W = Math.min(this.hopCount, Math.floor(fps * WINDOW_SECONDS), this.R);
    const established = this.lowEstablished();
    const active = this.kickActive();
    // pas de kick alors qu'il existait : on garde la grille (volant d'inertie)
    if (established && !active && this.beatCtx !== undefined) return;

    const wHigh = established ? 0.3 : 1;
    const raw = new Float64Array(W);
    const low = new Float64Array(W);
    const start = this.hopCount - W;
    for (let i = 0; i < W; i++) {
      const r = (start + i) % this.R;
      low[i] = this.odfLow[r];
      raw[i] = this.odfLow[r] + wHigh * this.odfHigh[r];
    }
    const sm = smooth3(raw);
    let mean = 0;
    for (let i = 0; i < W; i++) mean += sm[i];
    mean /= W;
    const c = new Float64Array(W);
    for (let i = 0; i < W; i++) c[i] = sm[i] - mean;

    // ---- tempo
    const hint = this.bpmHint;
    const lo = hint > 0 ? hint * 0.94 : 70;
    const hi = hint > 0 ? hint * 1.06 : 180;
    const K = 4;
    const maxLag = Math.min(W - 2, Math.ceil((fps * 60 / lo) * K) + 2);
    const ac = autocorr(c, maxLag);
    const a0 = ac[0] || 1;
    for (let i = 0; i < ac.length; i++) ac[i] /= a0;
    let bestB = 0, bestS = -Infinity;
    const step = 0.05;
    for (let b = lo; b <= hi + 1e-9; b += step) {
      const s = combScore(ac, (fps * 60) / b, K) * (hint > 0 ? 1 : 0.6 + 0.4 * plausibility(b, 1));
      if (s > bestS) { bestS = s; bestB = b; }
    }
    if (hint <= 0 && bestB > 0) bestB = this.resolveOctave(bestB, ac, low, fps);
    const est = bestB;
    this.strength = clamp01(interp(ac, (fps * 60) / est));
    if (this.strength < 0.05) return;
    this.estHist.push(est);
    if (this.estHist.length > 64) this.estHist.shift();

    if (this.bpm <= 0 || this.beatCtx === undefined) this.bpm = est;
    else {
      const rel = Math.abs(est - this.bpm) / this.bpm;
      if (rel < 0.03) { this.bpm += (est - this.bpm) * 0.15; this.bpmDisagree = 0; }
      else if (++this.bpmDisagree > 8) { this.bpm = est; this.bpmDisagree = 0; }
    }

    // ---- phase (peigne d'impulsions sur les derniers temps, récents pondérés plus fort)
    const P = (fps * 60) / this.bpm;
    const phaseSig = established ? smooth3(low) : sm;
    const B = Math.max(2, Math.min(8, Math.floor((W - 1) / P)));
    let bestPhi = 0, bestPs = -Infinity;
    const scores: number[] = [];
    const phStep = 0.5;
    for (let phi = 0; phi < P; phi += phStep) {
      let s = 0;
      for (let kk = 0, w = 1; kk < B; kk++, w *= 0.85) s += w * interp(phaseSig, W - 1 - phi - kk * P);
      scores.push(s);
      if (s > bestPs) { bestPs = s; bestPhi = phi; }
    }
    const bi = Math.round(bestPhi / phStep);
    if (bi > 0 && bi < scores.length - 1) {
      const y0 = scores[bi - 1], y1 = scores[bi], y2 = scores[bi + 1];
      const den = y0 - 2 * y1 + y2;
      if (den < 0) bestPhi += 0.5 * ((y0 - y2) / den) * phStep;
    }
    const lastR = (this.hopCount - 1) % this.R;
    const obs = this.times[lastR] - bestPhi / fps - ONSET_LATENCY;
    const Ps = 60 / this.bpm;

    if (this.beatCtx === undefined) {
      this.beatCtx = obs;
      this.beatIdx = 0;
      this.phaseUpdates = 1;
      this.advanceBeats(now);
      return;
    }
    let e = obs - this.beatCtx;
    e -= Math.round(e / Ps) * Ps;
    const relErr = Math.abs(e) / Ps;
    this.bigErrCount = relErr > 0.2 ? this.bigErrCount + 1 : 0;
    const alpha = this.phaseUpdates < 6 ? 0.5 : this.bigErrCount > 6 ? 0.5 : 0.15;
    this.beatCtx += alpha * e;
    this.phaseErrAvg += (relErr - this.phaseErrAvg) * 0.2;
    this.phaseUpdates++;
  }

  /** Sans a priori : demi ou double ? Le double est retenu si la bande basse pulse aussi au double. */
  private resolveOctave(b: number, ac: Float64Array, low: Float64Array, fps: number): number {
    const slow = b / 2 >= 70 ? b / 2 : b;
    const fast = b * 2 <= 180 ? b * 2 : b;
    if (slow === fast) return b;
    const s = slow === b ? b : slow, f = fast === b ? b : fast;
    let m = 0;
    for (let i = 0; i < low.length; i++) m += low[i];
    m /= low.length;
    const lc = new Float64Array(low.length);
    for (let i = 0; i < low.length; i++) lc[i] = low[i] - m;
    const acl = autocorr(lc, Math.ceil((fps * 60) / s) + 2);
    const sl = interp(acl, (fps * 60) / s);
    const rLow = sl > 0 ? interp(acl, (fps * 60) / f) / sl : 0;
    const rFull = interp(ac, (fps * 60) / s) > 0 ? interp(ac, (fps * 60) / f) / interp(ac, (fps * 60) / s) : 0;
    return rLow > 0.5 || rFull > 0.75 ? f : s;
  }

  private advanceBeats(now: number): void {
    if (this.beatCtx === undefined || this.bpm <= 0) return;
    const Ps = 60 / this.bpm;
    let guard = 0;
    while (this.beatCtx + Ps <= now && guard++ < 64) {
      this.beatCtx += Ps;
      this.beatIdx++;
      this.pending.push({ idx: this.beatIdx, ctx: this.beatCtx });
    }
    // un temps est mesuré quand on a ~1 temps de recul
    while (this.pending.length && this.pending[0].ctx + Ps * 0.95 <= now) {
      const p = this.pending.shift() as { idx: number; ctx: number };
      this.measureBeat(p.idx, p.ctx, Ps);
    }
  }

  /** Statistiques sur [t0, t1] (s) depuis l'anneau. */
  private windowStats(t0: number, t1: number): { lowPeak: number; lowMean: number; highMean: number } {
    const lastR = (this.hopCount - 1) % this.R;
    const tLast = this.times[lastR];
    const h1 = Math.min(this.hopCount - 1, this.hopCount - 1 - Math.floor((tLast - t1) * this.fps));
    const h0 = Math.max(this.hopCount - this.R + 1, this.hopCount - 1 - Math.ceil((tLast - t0) * this.fps), 0);
    let lowPeak = 0, ls = 0, hs = 0, n = 0;
    for (let h = h0; h <= h1; h++) {
      const r = h % this.R;
      const la = this.lowAmp[r];
      if (la > lowPeak) lowPeak = la;
      ls += la; hs += this.highAmp[r]; n++;
    }
    return { lowPeak, lowMean: n ? ls / n : 0, highMean: n ? hs / n : 0 };
  }

  /** Instant de l'attaque basse la plus forte à ±1/4 de temps de `ctx`, moins `ctx` (NaN si aucune). */
  private onsetDeviation(ctx: number, Ps: number): number {
    const lastR = (this.hopCount - 1) % this.R;
    const tLast = this.times[lastR];
    const h1 = Math.min(this.hopCount - 1, this.hopCount - 1 - Math.floor((tLast - (ctx + Ps / 4)) * this.fps));
    const h0 = Math.max(this.hopCount - this.R + 1, this.hopCount - 1 - Math.ceil((tLast - (ctx - Ps / 4)) * this.fps), 0);
    let best = -1, bv = 2; // au moins 2x le flux moyen
    for (let h = h0; h <= h1; h++) {
      const v = this.odfLow[h % this.R];
      if (v > bv) { bv = v; best = h; }
    }
    return best < 0 ? NaN : this.times[best % this.R] - ctx;
  }

  private measureBeat(idx: number, ctx: number, Ps: number): void {
    const near = this.windowStats(ctx - 0.03, ctx + 0.07);
    const whole = this.windowStats(ctx, ctx + Ps);
    const rec: BeatRec = { idx, ctx, lowPeak: near.lowPeak, lowMean: whole.lowMean, highMean: whole.highMean };
    this.beats.push(rec);
    if (this.beats.length > 256) this.beats.shift();
    this.devHist.push(this.onsetDeviation(ctx, Ps));
    if (this.devHist.length > 33) this.devHist.shift();

    // premier temps de mesure
    const pos = ((idx % 4) + 4) % 4;
    const lowRel = this.lowRef > 0 ? rec.lowMean / this.lowRef : 0;
    if (lowRel > 0.3) this.barScores[pos] = this.barScores[pos] * 0.8 + rec.lowPeak * 0.2;
    if (pos === 3) this.updateDownbeat();

    this.updateSection(rec, lowRel);
  }

  private updateDownbeat(): void {
    let lead = 0;
    for (let i = 1; i < 4; i++) if (this.barScores[i] > this.barScores[lead]) lead = i;
    if (lead === this.downPos) {
      this.downChallenger = -1;
      this.downChallengeCount = 0;
      this.downStableBars++;
    } else if (this.barScores[lead] > this.barScores[this.downPos] * 1.08) {
      if (lead === this.downChallenger) this.downChallengeCount++;
      else { this.downChallenger = lead; this.downChallengeCount = 1; }
      // au démarrage on bascule vite, ensuite il faut 3 mesures d'affilée
      const needed = this.downStableBars < 3 ? 1 : 3;
      if (this.downChallengeCount >= needed) {
        this.downPos = lead;
        this.downChallenger = -1;
        this.downChallengeCount = 0;
        this.downStableBars = 0;
        if (this.anchorIdx !== undefined) this.anchorIdx = this.snapToDownbeat(this.anchorIdx);
      }
    }
    if (this.anchorIdx === undefined && this.downStableBars >= 2) {
      // ancre : début du morceau si la position est connue, sinon le premier temps courant
      let a = this.beatIdx;
      if (this.trackPos && this.beatCtx !== undefined) {
        const t0 = this.trackPos.at - this.trackPos.pos; // instant ctx du début du morceau
        a = this.beatIdx - Math.round((this.beatCtx - t0) / (60 / this.bpm));
      }
      this.anchorIdx = this.snapToDownbeat(a);
    }
  }

  private snapToDownbeat(idx: number): number {
    const d = (((idx - this.downPos) % 4) + 4) % 4;
    return d <= 2 ? idx - d : idx + (4 - d);
  }

  private posAt(ctx: number): number | undefined {
    if (!this.trackPos) return undefined;
    return this.trackPos.pos + (ctx - this.trackPos.at);
  }

  private setSection(s: Section, idx: number): void {
    if (s === this.section) return;
    this.section = s;
    this.sectionStartIdx = idx;
  }

  private noteChangePoint(idx: number): void {
    if (this.anchorIdx === undefined) return;
    const off = (((idx - this.anchorIdx) % 32) + 32) % 32;
    if (Math.abs(off - 16) <= 1) this.phraseBeats = 16;
  }

  private updateSection(rec: BeatRec, lowRel: number): void {
    const idx = rec.idx;
    if (lowRel < 0.3) { if (this.quietBeats++ === 0) this.quietStartIdx = idx; }
    else this.quietBeats = 0;
    const established = this.lowEstablished();
    const s = this.section;

    // outro si la durée est connue
    const pos = this.posAt(rec.ctx);
    const dur = this.trackPos?.duration;
    if (pos !== undefined && dur && dur > 0) {
      const remaining = dur - pos;
      if (remaining < 30 || (remaining < 60 && lowRel < 0.5 && s !== 'breakdown' && s !== 'build')) {
        this.setSection('outro', idx);
        return;
      }
    }

    if (s === 'breakdown' || s === 'build') {
      if (this.quietBeats > 96) { this.setSection('outro', idx); return; }
      if (s === 'breakdown') {
        // montée des aigus pendant que la basse est absente
        const recent = this.beats.slice(-8), before = this.beats.slice(-16, -8);
        if (recent.length === 8 && before.length === 8 && idx - this.sectionStartIdx >= 8) {
          const hr = avg(recent.map((b) => b.highMean)), hb = avg(before.map((b) => b.highMean));
          if (hb > 0 && hr > hb * 1.3) this.setSection('build', idx);
        }
      }
      return; // la sortie (drop) est détectée au fil des pas
    }

    if (established && this.quietBeats >= 8) {
      this.noteChangePoint(this.snapToDownbeat(this.quietStartIdx));
      this.setSection('breakdown', this.quietStartIdx);
      this.seenStructure = true;
      return;
    }
    if (s === 'drop' && idx - this.sectionStartIdx < 16) return;

    const beatsFromStart = pos !== undefined ? pos / (60 / this.bpm) : idx;
    if (!this.seenStructure && beatsFromStart < 32) { this.setSection('intro', idx); return; }
    if (this.section === 'outro' && !(pos !== undefined && dur)) {
      if (lowRel > 0.6) this.setSection('body', idx);
      return;
    }
    this.setSection('body', idx);
  }

  private triggerDrop(t: number): void {
    if (this.beatCtx === undefined) return;
    const Ps = 60 / this.bpm;
    // le kick revient sur le temps le plus proche de l'attaque (détection ~1 temps de retard au plus)
    const onset = t - 0.06;
    const dropIdx = this.beatIdx + Math.round((onset - this.beatCtx) / Ps);
    this.noteChangePoint(dropIdx);
    this.downPos = ((dropIdx % 4) + 4) % 4;
    const mx = Math.max(...this.barScores, 1e-6);
    this.barScores = this.barScores.map((v, i) => (i === this.downPos ? mx * 1.2 : v * 0.7));
    this.downStableBars = 3;
    this.downChallenger = -1;
    this.downChallengeCount = 0;
    this.anchorIdx = dropIdx;
    this.quietBeats = 0;
    this.seenStructure = true;
    this.section = 'drop';
    this.sectionStartIdx = dropIdx;
    // reprise de la correction de phase un peu plus vive après le volant d'inertie
    this.bigErrCount = 0;
  }

  private computeNextPhrase(Ps: number): number | undefined {
    if (this.beatCtx === undefined || this.anchorIdx === undefined) return undefined;
    const PB = this.phraseBeats;
    const now = Math.max(this.lastSampleCtx, this.beatCtx);
    const curFloat = this.beatIdx + (now - this.beatCtx) / Ps;
    const n = Math.floor((curFloat - this.anchorIdx) / PB) + 1;
    const nextIdx = this.anchorIdx + n * PB;
    return this.beatCtx + (nextIdx - this.beatIdx) * Ps;
  }
}

function smooth3(x: Float64Array): Float64Array {
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const a = i > 0 ? x[i - 1] : x[i];
    const c = i < x.length - 1 ? x[i + 1] : x[i];
    out[i] = 0.25 * a + 0.5 * x[i] + 0.25 * c;
  }
  return out;
}

function avg(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}
