/**
 * Mesures pour l'affichage (vumètres stéréo, énergie du kick, bandes de fréquence pour la forme
 * d'onde en direct). Lecture à la demande depuis la boucle d'animation (requestAnimationFrame).
 */
import type { DeckId } from '../../shared/contracts';

interface TapLike {
  getDeckTap(id: DeckId): AudioNode;
  getMasterTap(): AudioNode;
}

export interface StereoLevel { l: number; r: number; peakL: number; peakR: number }
export interface Bands { low: number; mid: number; high: number; peak: number }

class StereoMeter {
  private aL: AnalyserNode;
  private aR: AnalyserNode;
  private spec: AnalyserNode;
  private buf: Float32Array<ArrayBuffer>;
  private fbuf: Float32Array<ArrayBuffer>;
  private peaks = { l: 0, r: 0, tl: 0, tr: 0 };
  constructor(private ctx: AudioContext, input: AudioNode) {
    const split = ctx.createChannelSplitter(2);
    this.aL = ctx.createAnalyser();
    this.aR = ctx.createAnalyser();
    this.aL.fftSize = this.aR.fftSize = 1024;
    this.spec = ctx.createAnalyser();
    this.spec.fftSize = 2048;
    this.spec.smoothingTimeConstant = 0.5;
    input.connect(split);
    input.connect(this.spec);
    split.connect(this.aL, 0);
    split.connect(this.aR, 1);
    this.buf = new Float32Array(1024);
    this.fbuf = new Float32Array(this.spec.frequencyBinCount);
  }

  private rms(a: AnalyserNode): { rms: number; peak: number } {
    a.getFloatTimeDomainData(this.buf);
    let s = 0;
    let p = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const v = this.buf[i];
      s += v * v;
      const av = v < 0 ? -v : v;
      if (av > p) p = av;
    }
    return { rms: Math.sqrt(s / this.buf.length), peak: p };
  }

  level(): StereoLevel {
    const L = this.rms(this.aL);
    let R = this.rms(this.aR);
    if (R.rms === 0 && L.rms > 0) R = L; // source mono
    const now = this.ctx.currentTime;
    const toMeter = (rms: number) => {
      const db = 20 * Math.log10(rms + 1e-9);
      return Math.max(0, Math.min(1, (db + 48) / 48));
    };
    const l = toMeter(L.rms);
    const r = toMeter(R.rms);
    if (l >= this.peaks.l || now - this.peaks.tl > 1.2) {
      this.peaks.l = l;
      this.peaks.tl = now;
    }
    if (r >= this.peaks.r || now - this.peaks.tr > 1.2) {
      this.peaks.r = r;
      this.peaks.tr = now;
    }
    return { l, r, peakL: this.peaks.l, peakR: this.peaks.r };
  }

  bands(): Bands {
    this.spec.getFloatFrequencyData(this.fbuf);
    const hz = this.ctx.sampleRate / 2 / this.fbuf.length;
    let lo = 0, mi = 0, hi = 0, nl = 0, nm = 0, nh = 0;
    for (let i = 1; i < this.fbuf.length; i++) {
      const f = i * hz;
      const mag = Math.pow(10, this.fbuf[i] / 20);
      if (f < 180) { lo += mag; nl++; }
      else if (f < 2200) { mi += mag; nm++; }
      else if (f < 14000) { hi += mag; nh++; }
    }
    const n = (v: number, k: number, gain: number) => Math.max(0, Math.min(1, Math.pow((v / Math.max(1, k)) * gain, 0.6)));
    const low = n(lo, nl, 18);
    const mid = n(mi, nm, 60);
    const high = n(hi, nh, 220);
    return { low, mid, high, peak: Math.max(low, mid, high) };
  }
}

export class Meters {
  private m: Record<DeckId | 'master', StereoMeter>;
  constructor(ctx: AudioContext, mixer: TapLike) {
    this.m = {
      A: new StereoMeter(ctx, mixer.getDeckTap('A')),
      B: new StereoMeter(ctx, mixer.getDeckTap('B')),
      master: new StereoMeter(ctx, mixer.getMasterTap()),
    };
  }
  level(id: DeckId | 'master'): StereoLevel {
    return this.m[id].level();
  }
  bands(id: DeckId | 'master'): Bands {
    return this.m[id].bands();
  }
}
