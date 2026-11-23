/**
 * Échantillonneur de boucles (vraies boucles, loop-roll, filet de sécurité) : partie PURE.
 *
 * LoopCore enregistre en continu le signal d'une platine dans un tampon circulaire horodaté en
 * temps ctx et produit la sortie « boucle » à l'échantillon près. Il tourne soit dans un
 * AudioWorklet (source sérialisée : LOOP_WORKLET_SRC), soit dans un ScriptProcessor (repli).
 *
 * IMPORTANT : LoopCore doit rester AUTONOME (aucune référence à un symbole extérieur, pas de
 * champ initialisé hors du constructeur) car sa source est sérialisée avec toString() pour le worklet.
 */
import type { FxCue, TransitionPlan } from '../contracts';

/** Segment de boucle actif à partir de `from` (ctx). off = retour au direct (sortie boucle muette). */
export interface LoopSegment {
  from: number;
  off?: boolean;
  /** Début de la fenêtre rejouée (ctx) et longueur (s). */
  winStart: number;
  len: number;
  /** Instant de référence de la position : p = (t - anchor) mod len. */
  anchor: number;
}

export type LoopMessage =
  | { type: 'segment'; seg: LoopSegment }
  | { type: 'reset' };

export const LOOP_FADE_SECONDS = 0.005;
export const LOOP_BUFFER_SECONDS = 16;

export class LoopCore {
  sr: number;
  frames: number;
  buf: Float32Array[];
  originTime: number;
  hasOrigin: boolean;
  /** Index absolu (depuis l'origine) du prochain échantillon à écrire. */
  endAbs: number;
  segments: LoopSegment[];
  fade: number;

  constructor(sampleRate: number, seconds: number, channels: number) {
    this.sr = sampleRate;
    this.frames = Math.max(1, Math.ceil(sampleRate * seconds));
    this.buf = [];
    for (let c = 0; c < Math.max(1, channels); c++) this.buf.push(new Float32Array(this.frames));
    this.originTime = 0;
    this.hasOrigin = false;
    this.endAbs = 0;
    this.segments = [];
    this.fade = Math.max(1, Math.round(0.005 * sampleRate));
  }

  /** Écrit un bloc capté dont le premier échantillon est à `startTime` (ctx). */
  write(chs: Float32Array[], startTime: number): void {
    if (!chs.length || !chs[0]) return;
    const n = chs[0].length;
    if (!this.hasOrigin) {
      this.originTime = startTime;
      this.hasOrigin = true;
      this.endAbs = 0;
    } else {
      const abs = Math.round((startTime - this.originTime) * this.sr);
      // petites gigues d'horodatage (ScriptProcessor) : on reste contigu ; gros écart : on recale
      if (Math.abs(abs - this.endAbs) > n) this.endAbs = abs;
    }
    const N = this.frames;
    for (let c = 0; c < this.buf.length; c++) {
      const src = chs[Math.min(c, chs.length - 1)];
      const dst = this.buf[c];
      let idx = ((this.endAbs % N) + N) % N;
      for (let i = 0; i < n; i++) {
        dst[idx] = src[i];
        idx++;
        if (idx === N) idx = 0;
      }
    }
    this.endAbs += n;
  }

  /** Programme un segment ; il remplace tout ce qui était prévu à partir de son instant. */
  schedule(seg: LoopSegment): void {
    const keep = this.segments.filter((s) => s.from < seg.from);
    // ménage : on garde au plus deux segments passés (pour les fondus)
    this.segments = keep.slice(Math.max(0, keep.length - 2)).concat([seg]);
  }

  reset(): void {
    this.segments = [];
  }

  /** Lecture interpolée dans le tampon à l'instant t (0 si non disponible). */
  readAt(c: number, t: number): number {
    const pos = (t - this.originTime) * this.sr;
    const i0 = Math.floor(pos);
    if (i0 < this.endAbs - this.frames || i0 + 1 >= this.endAbs) return 0;
    const N = this.frames;
    const frac = pos - i0;
    const b = this.buf[c];
    const a0 = b[((i0 % N) + N) % N];
    const a1 = b[(((i0 + 1) % N) + N) % N];
    return a0 + (a1 - a0) * frac;
  }

  /** Échantillon d'un segment à l'instant t, avec fondu au point de bouclage. */
  segValue(seg: LoopSegment, c: number, t: number): number {
    if (seg.off || !(seg.len > 0)) return 0;
    let p = (t - seg.anchor) % seg.len;
    if (p < 0) p += seg.len;
    const v = this.readAt(c, seg.winStart + p);
    const f = Math.min(this.fade / this.sr, seg.len / 4);
    const left = seg.len - p;
    if (left < f) {
      // on fond vers ce qui précède le début de fenêtre : continuité parfaite au retour en début
      const w = 1 - left / f;
      return v * (1 - w) + this.readAt(c, seg.winStart + p - seg.len) * w;
    }
    return v;
  }

  /** Remplit `out` pour un bloc dont le premier échantillon est à `startTime`. */
  render(out: Float32Array[], startTime: number): void {
    const n = out.length ? out[0].length : 0;
    const segs = this.segments;
    const fadeS = this.fade / this.sr;
    for (let i = 0; i < n; i++) {
      const t = startTime + i / this.sr;
      let k = -1;
      for (let j = segs.length - 1; j >= 0; j--) {
        if (segs[j].from <= t) {
          k = j;
          break;
        }
      }
      for (let c = 0; c < out.length; c++) {
        let v = 0;
        if (k >= 0) {
          const cur = segs[k];
          v = this.segValue(cur, Math.min(c, this.buf.length - 1), t);
          const since = t - cur.from;
          if (k > 0 && since < fadeS) {
            const prev = this.segValue(segs[k - 1], Math.min(c, this.buf.length - 1), t);
            const w = since / fadeS;
            v = prev * (1 - w) + v * w;
          }
        }
        out[c][i] = v;
      }
    }
  }

  /** Vrai si une boucle est active à t. */
  activeAt(t: number): boolean {
    for (let j = this.segments.length - 1; j >= 0; j--) {
      if (this.segments[j].from <= t) return !this.segments[j].off;
    }
    return false;
  }
}

export const LOOP_WORKLET_NAME = 'club-maison-loop';

/**
 * Source complète du processeur AudioWorklet (LoopCore sérialisé + processeur). À écrire dans un
 * vrai fichier pour l'extension MV3 (la CSP refuse les Blob URL), puis passer son URL au Mixer :
 * `new Mixer(ctx, { workletUrl })`. Protocole : port.postMessage(LoopMessage).
 */
export const LOOP_WORKLET_SRC = `
var __name = (t) => t;
${LoopCore.toString()}
class ClubMaisonLoopProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.core = new LoopCore(sampleRate, ${LOOP_BUFFER_SECONDS}, 2);
    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m) return;
      if (m.type === 'segment') this.core.schedule(m.seg);
      else if (m.type === 'reset') this.core.reset();
    };
  }
  process(inputs, outputs) {
    const t = currentFrame / sampleRate;
    const input = inputs[0];
    if (input && input.length) this.core.write(input, t);
    const out = outputs[0];
    if (out && out.length) this.core.render(out, t);
    return true;
  }
}
registerProcessor('${LOOP_WORKLET_NAME}', ClubMaisonLoopProcessor);
`;

// ---------------------------------------------------------------------------------------------
// Fenêtre dans le tampon circulaire
// ---------------------------------------------------------------------------------------------

/**
 * Indices d'une fenêtre [startCtx, endCtx[ dans un tampon circulaire de `bufferFrames` échantillons
 * dont l'échantillon absolu 0 est à `originTime` et qui a été écrit jusqu'à `writtenAbs` (exclu).
 * endIndex est exclusif ; wraps = la fenêtre traverse la fin du tampon.
 */
export function loopWindow(o: {
  bufferFrames: number; sampleRate: number; originTime: number; writtenAbs: number; startCtx: number; endCtx: number;
}): { startAbs: number; endAbs: number; frames: number; startIndex: number; endIndex: number; wraps: boolean; available: boolean } {
  const N = o.bufferFrames;
  const startAbs = Math.round((o.startCtx - o.originTime) * o.sampleRate);
  const endAbs = Math.round((o.endCtx - o.originTime) * o.sampleRate);
  const frames = Math.max(0, endAbs - startAbs);
  const mod = (x: number) => ((x % N) + N) % N;
  const startIndex = mod(startAbs);
  const endIndex = mod(endAbs);
  return {
    startAbs, endAbs, frames, startIndex, endIndex,
    wraps: frames > 0 && (startIndex + frames > N),
    available: frames > 0 && frames <= N && startAbs >= o.writtenAbs - N && endAbs <= o.writtenAbs,
  };
}

/** Fondu à gain constant (deux signaux identiques au point de bascule) : (sortant, entrant). */
export function microFade(x: number): { out: number; in: number } {
  const u = Math.min(1, Math.max(0, x));
  return { out: 1 - u, in: u };
}

// ---------------------------------------------------------------------------------------------
// Planification des rolls et des actions de boucle
// ---------------------------------------------------------------------------------------------

/**
 * Roll : longueurs startLen, /2, /4, /8 (en temps) sur `beats` temps à partir de startCtx
 * (proportions 1/2, 1/4, 1/8, 1/8 de la durée). Chaque bascule tombe sur la grille de sa
 * nouvelle longueur (relative à startCtx) et après au moins un tour complet de la boucle précédente.
 * len en temps.
 */
export function loopRollSchedule(startCtx: number, beats: number, bpm: number, startLen = 1): Array<{ t: number; len: number }> {
  const beat = 60 / (bpm > 0 ? bpm : 120);
  const B = Math.max(0, beats);
  const L0 = startLen > 0 ? startLen : 1;
  const out: Array<{ t: number; len: number }> = [{ t: startCtx, len: L0 }];
  const fractions = [0.5, 0.75, 0.875];
  let prevB = 0;
  let prevLen = L0;
  for (let i = 0; i < fractions.length; i++) {
    const len = L0 / Math.pow(2, i + 1);
    if (len < 1 / 16 - 1e-9) break;
    let b = Math.round((fractions[i] * B) / len) * len;
    b = Math.max(b, prevB + prevLen);
    b = Math.ceil(b / len - 1e-9) * len;
    if (b >= B - 1e-9) break;
    out.push({ t: startCtx + b * beat, len });
    prevB = b;
    prevLen = len;
  }
  return out;
}

export type LoopAction =
  | { t: number; action: 'hold'; beats: number }
  | { t: number; action: 'len'; beats: number }
  | { t: number; action: 'release' };

/** Actions d'échantillonneur d'un effet 'loop' / 'loop-roll' (vide pour les autres effets). */
export function fxLoopActions(cue: FxCue): LoopAction[] {
  const beat = 60 / (cue.bpm > 0 ? cue.bpm : 120);
  const N = Math.max(0.25, cue.beats);
  const end = cue.atCtx + N * beat;
  if (cue.kind === 'loop') {
    const len = cue.loopBeats && cue.loopBeats > 0 ? cue.loopBeats : 1;
    return [{ t: cue.atCtx, action: 'hold', beats: len }, { t: end, action: 'release' }];
  }
  if (cue.kind === 'loop-roll') {
    const sched = loopRollSchedule(cue.atCtx, N, cue.bpm, cue.loopBeats && cue.loopBeats > 0 ? cue.loopBeats : 1);
    const acts: LoopAction[] = sched.map((s, i) =>
      i === 0 ? { t: s.t, action: 'hold' as const, beats: s.len } : { t: s.t, action: 'len' as const, beats: s.len });
    // amount fort : coupure d'un temps (silence via le fader) avant le retour au direct
    acts.push({ t: loopRollCut(cue) ? end + beat : end, action: 'release' });
    return acts;
  }
  return [];
}

/** Le loop-roll se termine-t-il par une coupure d'un temps ? */
export function loopRollCut(cue: FxCue): boolean {
  return cue.amount >= 0.6;
}

/** Durée totale (temps) et partie roll (temps) de la transition loop-roll (mêmes règles que la recette). */
export function transitionRollBeats(plan: TransitionPlan): { total: number; roll: number } {
  const total = Math.min(16, Math.max(2, Math.round((Number.isFinite(plan.beats) ? plan.beats : 8) / 2) * 2));
  return { total, roll: Math.min(total, 8) };
}

/**
 * Actions d'échantillonneur d'une transition (seulement loop-roll) sur la platine SORTANTE :
 * roll qui accélère sur les dernières mesures, puis relâche juste après la coupure du fader.
 */
export function transitionLoopActions(plan: TransitionPlan): LoopAction[] {
  if (plan.technique !== 'loop-roll') return [];
  const bpm = plan.bpm > 0 ? plan.bpm : 120;
  const beat = 60 / bpm;
  const { total, roll } = transitionRollBeats(plan);
  const end = plan.startCtx + total * beat;
  const sched = loopRollSchedule(end - roll * beat, roll, bpm, 1);
  const acts: LoopAction[] = sched.map((s, i) =>
    i === 0 ? { t: s.t, action: 'hold' as const, beats: s.len } : { t: s.t, action: 'len' as const, beats: s.len });
  acts.push({ t: end + 0.02, action: 'release' });
  return acts;
}
