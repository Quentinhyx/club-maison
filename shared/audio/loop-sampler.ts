/**
 * Échantillonneur de boucles d'une platine (Web Audio). S'insère après le trim :
 *
 *   trim -> direct (gain) ------------------------> EQ ...
 *        -> moteur (AudioWorklet ou ScriptProcessor) -> boucle (gain) -> EQ ...
 *
 * Le moteur (LoopCore) enregistre en continu les ~16 dernières secondes et produit la boucle à
 * l'échantillon près. Les bascules direct <-> boucle se font sur les gains (fondu de 5 ms).
 */
import type { DeckId } from '../contracts';
import {
  LOOP_BUFFER_SECONDS, LOOP_FADE_SECONDS, LOOP_WORKLET_NAME, LoopCore, type LoopMessage, type LoopSegment,
} from './loop';

function hold(p: AudioParam, t: number): void {
  if (typeof p.cancelAndHoldAtTime === 'function') p.cancelAndHoldAtTime(t);
  else {
    const v = p.value;
    p.cancelScheduledValues(t);
    p.setValueAtTime(v, t);
  }
}

interface HoldInfo { at: number; bpm: number; beats: number; winStart: number }

export class LoopSampler {
  readonly id: DeckId;
  private readonly ctx: AudioContext;
  private readonly input: AudioNode;
  private readonly direct: GainNode;
  private readonly loopOut: GainNode;
  private sp?: ScriptProcessorNode;
  private spCore?: LoopCore;
  private wk?: AudioWorkletNode;
  private holdInfo?: HoldInfo;
  private releaseAt?: number;
  private future: LoopSegment[] = [];
  private disposed = false;

  constructor(id: DeckId, ctx: AudioContext, input: AudioNode, dest: AudioNode) {
    this.id = id;
    this.ctx = ctx;
    this.input = input;
    this.direct = new GainNode(ctx, { gain: 1 });
    this.loopOut = new GainNode(ctx, { gain: 0 });
    input.connect(this.direct).connect(dest);
    this.loopOut.connect(dest);
    // repli immédiat : ScriptProcessor (remplacé par le worklet dès qu'il est chargé)
    this.sp = ctx.createScriptProcessor(1024, 2, 2);
    this.spCore = new LoopCore(ctx.sampleRate, LOOP_BUFFER_SECONDS, 2);
    const core = this.spCore;
    this.sp.onaudioprocess = (e: AudioProcessingEvent) => {
      const inb = e.inputBuffer;
      const ins: Float32Array[] = [];
      for (let c = 0; c < inb.numberOfChannels; c++) ins.push(inb.getChannelData(c));
      // horodatage approché : le bloc d'entrée a été capté deux tampons avant sa sortie
      core.write(ins, e.playbackTime - 2 * inb.duration);
      const outb = e.outputBuffer;
      const outs: Float32Array[] = [];
      for (let c = 0; c < outb.numberOfChannels; c++) outs.push(outb.getChannelData(c));
      core.render(outs, e.playbackTime);
    };
    input.connect(this.sp);
    this.sp.connect(this.loopOut);
  }

  /** Mode courant du moteur, pour le diagnostic. */
  get engine(): 'worklet' | 'script-processor' {
    return this.wk ? 'worklet' : 'script-processor';
  }

  /** Passe sur l'AudioWorklet (le module LOOP_WORKLET_NAME doit être chargé). */
  useWorklet(): void {
    if (this.disposed || this.wk) return;
    const wk = new AudioWorkletNode(this.ctx, LOOP_WORKLET_NAME, {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    });
    this.input.connect(wk);
    wk.connect(this.loopOut);
    this.wk = wk;
    // les segments à venir sont rejoués côté worklet (l'historique enregistré repart de zéro)
    const now = this.ctx.currentTime;
    for (const seg of this.future) if (seg.from >= now - 1) this.post({ type: 'segment', seg });
    if (this.sp) {
      try {
        this.input.disconnect(this.sp);
        this.sp.disconnect();
      } catch {
        /* rien */
      }
      this.sp.onaudioprocess = null;
      this.sp = undefined;
      this.spCore = undefined;
    }
  }

  /** Coupe le direct à atCtx et rejoue les `beats` derniers temps [atCtx - beats*beat, atCtx[. */
  hold(atCtx: number, beats: number, bpm: number): void {
    const beat = 60 / (bpm > 0 ? bpm : 120);
    const len = Math.max(1 / 64, beats) * beat;
    const winStart = atCtx - len;
    this.holdInfo = { at: atCtx, bpm: bpm > 0 ? bpm : 120, beats, winStart };
    this.releaseAt = undefined;
    this.send({ from: atCtx, winStart, len, anchor: atCtx });
    this.crossfade(atCtx, true);
  }

  /** Change la longueur au prochain temps (ou division de temps pour les longueurs < 1 temps). */
  setLength(beats: number, atCtx: number): number | null {
    const h = this.holdInfo;
    if (!h || !(beats > 0)) return null;
    const beat = 60 / h.bpm;
    const g = Math.min(beats, 1) * beat;
    const from = Math.max(atCtx, this.ctx.currentTime, h.at);
    const t = h.at + Math.ceil((from - h.at) / g - 1e-9) * g;
    const len = beats * beat;
    // plus court : même début de fenêtre (roll) ; plus long : fenêtre qui finit au point de capture
    const winStart = beats <= h.beats ? h.winStart : h.at - len;
    this.send({ from: t, winStart, len, anchor: h.at });
    return t;
  }

  /** Retour au direct à atCtx. */
  release(atCtx: number): void {
    if (!this.holdInfo) return;
    this.releaseAt = atCtx;
    this.crossfade(atCtx, false);
    const h = this.holdInfo;
    this.send({ from: atCtx + LOOP_FADE_SECONDS, off: true, winStart: h.winStart, len: 1, anchor: h.at });
  }

  isLooping(): boolean {
    const now = this.ctx.currentTime;
    if (!this.holdInfo) return false;
    if (this.releaseAt !== undefined && this.releaseAt <= now) {
      this.holdInfo = undefined;
      this.releaseAt = undefined;
      return false;
    }
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      if (this.sp) {
        this.sp.onaudioprocess = null;
        this.sp.disconnect();
      }
      this.wk?.port.close();
      this.wk?.disconnect();
      this.direct.disconnect();
      this.loopOut.disconnect();
    } catch {
      /* rien */
    }
  }

  // -------------------------------------------------------------------------------------------

  private send(seg: LoopSegment): void {
    this.future = this.future.filter((s) => s.from < seg.from && s.from >= this.ctx.currentTime - 2).concat([seg]);
    if (this.spCore) this.spCore.schedule(seg);
    this.post({ type: 'segment', seg });
  }

  private post(m: LoopMessage): void {
    this.wk?.port.postMessage(m);
  }

  /** Fondu de 5 ms à partir de t : vers la boucle (toLoop) ou vers le direct. */
  private crossfade(t: number, toLoop: boolean): void {
    const t0 = Math.max(t, this.ctx.currentTime);
    const t1 = t0 + LOOP_FADE_SECONDS;
    for (const [g, target] of [[this.direct.gain, toLoop ? 0 : 1], [this.loopOut.gain, toLoop ? 1 : 0]] as const) {
      hold(g, t0);
      g.linearRampToValueAtTime(target, t1);
    }
  }
}
