/**
 * Table de mixage Web Audio : deux tranches façon table DJ, envois d'effets, master protégé.
 *
 *   source -> trim -> EQ (low shelf 120 Hz, peaking 1 kHz, high shelf 6 kHz) -> filtre DJ (HP puis LP)
 *          -> fader -> bus master
 *                   -> envoi écho  (post-fader) -> écho ping-pong (delay + feedback + tonalité)
 *                   -> envoi réverb (post-fader) -> HP 180 Hz -> convolution (IR générée, ~4 s)
 *   bruit blanc (boucle) -> passe-bande -> gain -> bus master
 *   bus master -> gate rythmique -> filtre master (HP, LP) -> compresseur doux -> limiteur
 *              -> écrêteur doux de sécurité -> gain master -> sortie (ctx.destination)
 *   canal groove : GrooveMachine (synthèse) -> EQ basse -> filtre DJ -> fader -> bus master
 *                  (+ envois écho / réverb post-fader, à 0 par défaut, voir setGrooveSends)
 */
import { isStinger, playStinger } from './stingers';
import type {
  AutomationLane, AutomationPoint, DeckId, FxCue, GroovePlan, GrooveStyle, ParamTarget,
  TransitionPlan,
} from '../contracts';
import { GrooveMachine } from './groove-machine';
import {
  ALL_TARGETS, NOISE_MAX_GAIN, clamp, clampParam, djFilterToNodes, echoToneToNodes,
  generateImpulse, interp, paramSpec, renderGate, sortPoints, valueAtPoints,
} from './params';
import { fxToAutomation, transitionLanes } from './recipes';
import { LOOP_WORKLET_SRC, fxLoopActions, transitionLoopActions, type LoopAction } from './loop';
import { LoopSampler } from './loop-sampler';

export interface MixerOptions {
  /** URL d'un fichier contenant LOOP_WORKLET_SRC (obligatoire en extension MV3 : la CSP refuse les
   *  Blob URL). Absente : essai en Blob URL, et repli sur ScriptProcessor si refusé. */
  workletUrl?: string;
}

interface Binding {
  param: AudioParam;
  map: (v: number) => number;
  /** true si map est affine : une rampe linéaire logique = une rampe linéaire sur le nœud. */
  affine: boolean;
}

interface Strip {
  source?: AudioNode;
  ownsSource: boolean;
  trim: GainNode;
  eqLow: BiquadFilterNode;
  eqMid: BiquadFilterNode;
  eqHigh: BiquadFilterNode;
  hp: BiquadFilterNode;
  lp: BiquadFilterNode;
  fader: GainNode;
  echoSend: GainNode;
  reverbSend: GainNode;
  meter: AnalyserNode;
  sampler: LoopSampler;
}

const GATE_TARGETS = new Set<ParamTarget>(['fx.gate.depth', 'fx.gate.rate']);
const id = (v: number) => v;

function holdParam(p: AudioParam, t: number): void {
  if (typeof p.cancelAndHoldAtTime === 'function') {
    p.cancelAndHoldAtTime(t);
  } else {
    const v = p.value;
    p.cancelScheduledValues(t);
    p.setValueAtTime(v, t);
  }
}

export class Mixer {
  readonly output: AudioNode;
  private readonly ctx: AudioContext;
  private readonly strips: Record<DeckId, Strip>;
  private readonly bindings = new Map<ParamTarget, Binding[]>();
  /** Automation logique programmée (pour getParam / cancelFrom / affichage). */
  private readonly record = new Map<ParamTarget, AutomationPoint[]>();
  private readonly nodes: AudioNode[] = [];
  private readonly gate: GainNode;
  private readonly noiseSrc: AudioBufferSourceNode;
  private readonly stingerBus: GainNode;
  private readonly masterMeter: AnalyserNode;
  private readonly meterBuf: Float32Array<ArrayBuffer>;
  private readonly groove: GrooveMachine;
  private readonly grooveMeter: AnalyserNode;
  private readonly grooveEchoSend: GainNode;
  private readonly grooveReverbSend: GainNode;
  private grooveDeck?: DeckId;
  private bpm = 124;
  private disposed = false;
  /** Résolue quand l'échantillonneur a choisi son moteur (worklet chargé, ou repli ScriptProcessor). */
  readonly ready: Promise<void>;

  constructor(ctx: AudioContext, opts: MixerOptions = {}) {
    this.ctx = ctx;
    const nyq = ctx.sampleRate / 2;
    const reg = <T extends AudioNode>(n: T): T => (this.nodes.push(n), n);
    const gain = (v = 1) => reg(new GainNode(ctx, { gain: v }));
    const biquad = (type: BiquadFilterType, frequency: number, Q = 0.7071, g = 0) =>
      reg(new BiquadFilterNode(ctx, { type, frequency, Q, gain: g }));

    // ---------------- master ----------------
    const bus = gain(0.85); // marge avant la dynamique
    this.gate = gain(1);
    const mhp = biquad('highpass', 0, -3.01);
    const mlp = biquad('lowpass', nyq, -3.01);
    const comp = reg(new DynamicsCompressorNode(ctx, { threshold: -18, knee: 12, ratio: 2.5, attack: 0.02, release: 0.25 }));
    const limiter = reg(new DynamicsCompressorNode(ctx, { threshold: -1.5, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }));
    const clip = reg(new WaveShaperNode(ctx, { curve: softClipCurve(), oversample: '2x' }));
    const mgain = gain(1);
    const out = gain(1);
    this.masterMeter = reg(new AnalyserNode(ctx, { fftSize: 1024, smoothingTimeConstant: 0 }));
    this.meterBuf = new Float32Array(new ArrayBuffer(1024 * 4));
    bus.connect(this.gate).connect(mhp).connect(mlp).connect(comp).connect(limiter).connect(clip).connect(mgain).connect(out);
    out.connect(this.masterMeter);
    out.connect(ctx.destination);
    this.output = out;

    // ---------------- écho ping-pong ----------------
    const echoIn = reg(new GainNode(ctx, { gain: 1, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' }));
    const delayL = reg(new DelayNode(ctx, { maxDelayTime: 3.5, delayTime: 0.35 }));
    const delayR = reg(new DelayNode(ctx, { maxDelayTime: 3.5, delayTime: 0.35 }));
    const toneHP = biquad('highpass', 100, -3.01);
    const toneLP = biquad('lowpass', 8000, -3.01);
    const fbLR = gain(0.35);
    const fbRL = gain(0.35);
    const merger = reg(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
    const echoReturn = gain(1);
    echoIn.connect(delayL);
    delayL.connect(toneHP).connect(toneLP).connect(fbLR).connect(delayR);
    delayR.connect(fbRL).connect(delayL);
    delayL.connect(merger, 0, 0);
    delayR.connect(merger, 0, 1);
    merger.connect(echoReturn).connect(bus);

    // ---------------- réverb ----------------
    const revIn = gain(1);
    const revHP = biquad('highpass', 180, -3.01);
    const conv = reg(new ConvolverNode(ctx));
    const [l, r] = generateImpulse(ctx.sampleRate, 4);
    const ir = ctx.createBuffer(2, l.length, ctx.sampleRate);
    ir.copyToChannel(l, 0);
    ir.copyToChannel(r, 1);
    conv.normalize = true;
    conv.buffer = ir;
    const revReturn = gain(0.8);
    revIn.connect(revHP).connect(conv).connect(revReturn).connect(bus);

    // ---------------- bruit blanc (riser / downlifter) ----------------
    const nbuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
    const nd = nbuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    this.noiseSrc = reg(new AudioBufferSourceNode(ctx, { buffer: nbuf, loop: true }));
    const noiseBP = biquad('bandpass', 1000, 1.2);
    const noiseGain = gain(0);
    this.noiseSrc.connect(noiseBP).connect(noiseGain).connect(bus);
    this.noiseSrc.start();

    // ---------------- sons d'ambiance (corne de brume, sirène, scratch) ----------------
    this.stingerBus = gain(0.7);
    const stingerEcho = gain(0.22);
    this.stingerBus.connect(bus);
    this.stingerBus.connect(stingerEcho).connect(echoIn);

    // ---------------- tranches ----------------
    const mkStrip = (d: DeckId): Strip => {
      const s: Strip = {
        ownsSource: false,
        sampler: undefined as unknown as LoopSampler,
        trim: gain(1),
        eqLow: biquad('lowshelf', 120, 0.7071, 0),
        eqMid: biquad('peaking', 1000, 0.9, 0),
        eqHigh: biquad('highshelf', 6000, 0.7071, 0),
        hp: biquad('highpass', 0, -3.01),
        lp: biquad('lowpass', nyq, -3.01),
        fader: gain(1),
        echoSend: gain(0),
        reverbSend: gain(0),
        meter: reg(new AnalyserNode(ctx, { fftSize: 1024, smoothingTimeConstant: 0 })),
      };
      // trim -> [direct + boucle] -> EQ : transitions et effets s'appliquent aussi à la boucle
      s.sampler = new LoopSampler(d, ctx, s.trim, s.eqLow);
      s.eqLow.connect(s.eqMid).connect(s.eqHigh).connect(s.hp).connect(s.lp).connect(s.fader);
      s.fader.connect(bus);
      s.fader.connect(s.meter);
      s.fader.connect(s.echoSend).connect(echoIn);
      s.fader.connect(s.reverbSend).connect(revIn);
      return s;
    };
    this.strips = { A: mkStrip('A'), B: mkStrip('B') };
    this.ready = this.loadWorklet(opts.workletUrl);

    // ---------------- canal groove (boîte à rythmes des re-edits) ----------------
    this.groove = new GrooveMachine(ctx);
    const gEqLow = biquad('lowshelf', 120, 0.7071, 0);
    const gHP = biquad('highpass', 0, -3.01);
    const gLP = biquad('lowpass', nyq, -3.01);
    const gFader = gain(0);
    this.grooveMeter = reg(new AnalyserNode(ctx, { fftSize: 1024, smoothingTimeConstant: 0 }));
    this.grooveEchoSend = gain(0);
    this.grooveReverbSend = gain(0);
    this.groove.output.connect(gEqLow).connect(gHP).connect(gLP).connect(gFader).connect(bus);
    gFader.connect(this.grooveMeter);
    gFader.connect(this.grooveEchoSend).connect(echoIn);
    gFader.connect(this.grooveReverbSend).connect(revIn);

    // ---------------- liaisons logique -> nœuds ----------------
    const filterBindings = (hp: BiquadFilterNode, lp: BiquadFilterNode): Binding[] => [
      { param: lp.frequency, map: (v) => djFilterToNodes(v, nyq).lpHz, affine: false },
      { param: hp.frequency, map: (v) => djFilterToNodes(v, nyq).hpHz, affine: false },
      { param: lp.Q, map: (v) => djFilterToNodes(v, nyq).qDb, affine: false },
      { param: hp.Q, map: (v) => djFilterToNodes(v, nyq).qDb, affine: false },
    ];
    for (const d of ['A', 'B'] as const) {
      const s = this.strips[d];
      this.bindings.set(`${d}.gain`, [{ param: s.fader.gain, map: id, affine: true }]);
      this.bindings.set(`${d}.trim`, [{ param: s.trim.gain, map: id, affine: true }]);
      this.bindings.set(`${d}.eqLow`, [{ param: s.eqLow.gain, map: id, affine: true }]);
      this.bindings.set(`${d}.eqMid`, [{ param: s.eqMid.gain, map: id, affine: true }]);
      this.bindings.set(`${d}.eqHigh`, [{ param: s.eqHigh.gain, map: id, affine: true }]);
      this.bindings.set(`${d}.filter`, filterBindings(s.hp, s.lp));
      this.bindings.set(`${d}.echoSend`, [{ param: s.echoSend.gain, map: id, affine: true }]);
      this.bindings.set(`${d}.reverbSend`, [{ param: s.reverbSend.gain, map: id, affine: true }]);
    }
    this.bindings.set('master.gain', [{ param: mgain.gain, map: id, affine: true }]);
    this.bindings.set('master.filter', filterBindings(mhp, mlp));
    this.bindings.set('fx.echo.feedback', [
      { param: fbLR.gain, map: id, affine: true },
      { param: fbRL.gain, map: id, affine: true },
    ]);
    this.bindings.set('fx.echo.time', [
      { param: delayL.delayTime, map: id, affine: true },
      { param: delayR.delayTime, map: id, affine: true },
    ]);
    this.bindings.set('fx.echo.tone', [
      { param: toneLP.frequency, map: (v) => echoToneToNodes(v).lpHz, affine: false },
      { param: toneHP.frequency, map: (v) => echoToneToNodes(v).hpHz, affine: false },
    ]);
    this.bindings.set('fx.reverb.return', [{ param: revReturn.gain, map: id, affine: true }]);
    this.bindings.set('fx.noise.gain', [{ param: noiseGain.gain, map: (v) => v * NOISE_MAX_GAIN, affine: true }]);
    this.bindings.set('fx.noise.filter', [{ param: noiseBP.frequency, map: id, affine: true }]);
    this.bindings.set('groove.gain', [{ param: gFader.gain, map: id, affine: true }]);
    this.bindings.set('groove.filter', filterBindings(gHP, gLP));
    this.bindings.set('groove.eqLow', [{ param: gEqLow.gain, map: id, affine: true }]);

    // valeurs initiales
    const now = ctx.currentTime;
    for (const t of ALL_TARGETS) {
      const v = paramSpec(t).def;
      this.record.set(t, [{ t: now, v }]);
      for (const b of this.bindings.get(t) ?? []) b.param.setValueAtTime(b.map(v), now);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Sources
  // -------------------------------------------------------------------------------------------

  connectDeck(deck: DeckId, source: MediaStream | AudioNode): void {
    const s = this.strips[deck];
    if (s.source) {
      try {
        if (s.ownsSource) s.source.disconnect();
        else s.source.disconnect(s.trim);
      } catch {
        /* déjà déconnecté */
      }
    }
    if (source instanceof AudioNode) {
      s.source = source;
      s.ownsSource = false;
    } else {
      s.source = this.ctx.createMediaStreamSource(source);
      s.ownsSource = true;
    }
    s.source.connect(s.trim);
  }

  getDeckTap(deck: DeckId): AudioNode {
    return this.strips[deck].trim;
  }

  getMasterTap(): AudioNode {
    return this.output;
  }

  /** Tempo de référence pour le gate rythmique (mis à jour aussi par runTransition / fx). */
  setTempo(bpm: number): void {
    if (bpm > 0 && Number.isFinite(bpm)) this.bpm = bpm;
  }

  // -------------------------------------------------------------------------------------------
  // Paramètres
  // -------------------------------------------------------------------------------------------

  setParam(target: ParamTarget, value: number): void {
    const now = this.ctx.currentTime;
    const cur = this.getParam(target);
    const v = clampParam(target, value);
    if (GATE_TARGETS.has(target)) {
      this.schedule([{ target, points: [{ t: now, v }] }]);
      return;
    }
    // petite rampe de 15 ms : pas de clic
    this.schedule([{ target, points: [{ t: now, v: cur }, { t: now + 0.015, v, curve: 'linear' }] }]);
  }

  getParam(target: ParamTarget): number {
    const pts = this.record.get(target);
    return valueAtPoints(pts ?? [], this.ctx.currentTime) ?? paramSpec(target).def;
  }

  schedule(lanes: AutomationLane[]): void {
    if (this.disposed) return;
    const gateLanes: AutomationLane[] = [];
    for (const lane of lanes) {
      if (!lane || !lane.points || lane.points.length === 0) continue;
      if (GATE_TARGETS.has(lane.target)) gateLanes.push(lane);
      else this.scheduleLane(lane);
    }
    if (gateLanes.length) this.scheduleGate(gateLanes);
  }

  cancelFrom(ctxTime: number): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    const t = Math.max(ctxTime, now);
    for (const [target, binds] of this.bindings) {
      for (const b of binds) holdParam(b.param, t);
      this.truncateRecord(target, t);
    }
    // les effets transitoires ne doivent pas rester bloqués « ouverts » : bruit et gate repartent au neutre
    const fadeEnd = t + 0.25;
    for (const b of this.bindings.get('fx.noise.gain') ?? []) b.param.linearRampToValueAtTime(0, fadeEnd);
    this.appendRecord('fx.noise.gain', { t: fadeEnd, v: 0, curve: 'linear' });
    holdParam(this.gate.gain, t);
    this.gate.gain.linearRampToValueAtTime(1, t + 0.01);
    this.truncateRecord('fx.gate.depth', t);
    this.appendRecord('fx.gate.depth', { t: t + 0.01, v: 0, curve: 'step' });
    this.truncateRecord('fx.gate.rate', t);
  }

  runTransition(plan: TransitionPlan): AutomationLane[] {
    this.setTempo(plan.bpm);
    const lanes = transitionLanes(plan);
    this.schedule(lanes);
    this.runLoopActions(plan.from, transitionLoopActions(plan), plan.bpm);
    for (const cue of plan.accents ?? []) this.runCueLoops(cue);
    return lanes;
  }

  /**
   * Effet ponctuel. Si une transition programmée possède déjà une cible au-delà du début de
   * l'effet, cette cible est laissée à la transition (on ne casse pas un échange de basses).
   */
  fx(cue: FxCue): AutomationLane[] {
    this.setTempo(cue.bpm);
    if (isStinger(cue.kind)) {
      if (!this.disposed) playStinger(this.ctx, this.stingerBus, cue.kind, cue.atCtx, cue.bpm, cue.beats, cue.amount);
      return [];
    }
    const lanes = fxToAutomation(cue).filter((lane) => {
      const first = lane.points[0]?.t ?? cue.atCtx;
      const rec = this.record.get(lane.target) ?? [];
      return !rec.some((p) => p.t > first + 1e-6);
    });
    this.schedule(lanes);
    this.runCueLoops(cue);
    return lanes;
  }

  // -------------------------------------------------------------------------------------------
  // Boucles (échantillonneur par platine)
  // -------------------------------------------------------------------------------------------

  /** À atCtx (sur un temps), coupe le direct et rejoue les `beats` derniers temps captés. */
  holdLoop(deck: DeckId, opts: { atCtx: number; beats: number; bpm: number }): void {
    if (this.disposed) return;
    this.strips[deck].sampler.hold(opts.atCtx, opts.beats, opts.bpm);
  }

  /** Change la longueur de la boucle au prochain temps (division de temps si beats < 1). Renvoie
   *  l'instant effectif, ou null si la platine ne boucle pas. */
  setLoopLength(deck: DeckId, beats: number, atCtx: number): number | null {
    if (this.disposed) return null;
    return this.strips[deck].sampler.setLength(beats, atCtx);
  }

  /** Retour au direct à atCtx (fondu de 5 ms). */
  releaseLoop(deck: DeckId, atCtx: number): void {
    if (this.disposed) return;
    this.strips[deck].sampler.release(atCtx);
  }

  isLooping(deck: DeckId): boolean {
    return !this.disposed && this.strips[deck].sampler.isLooping();
  }

  /** Moteur de l'échantillonneur (diagnostic). */
  getLoopEngine(): 'worklet' | 'script-processor' {
    return this.strips.A.sampler.engine;
  }

  /**
   * Filet de sécurité contre les blancs : si isReady() est faux à atCtx, boucle la dernière mesure
   * (4 temps) de la platine, revérifie ~60 ms avant chaque temps, et relâche sur le premier temps où
   * isReady() est vrai (au plus maxBeats temps). Renvoie l'instant ctx de relâche (atCtx si prêt).
   */
  async holdUntil(deck: DeckId, atCtx: number, bpm: number, isReady: () => boolean, maxBeats = 16): Promise<number> {
    const beat = 60 / (bpm > 0 ? bpm : 120);
    const margin = 0.06;
    const ready = () => {
      try {
        return !!isReady();
      } catch {
        return false;
      }
    };
    await this.waitCtx(atCtx - margin);
    if (this.disposed || ready()) return atCtx;
    // en retard sur l'instant prévu : on boucle à partir du prochain temps de la même grille
    const now = this.ctx.currentTime;
    const start = now < atCtx - 0.005 ? atCtx : atCtx + Math.ceil((now + 0.01 - atCtx) / beat) * beat;
    this.holdLoop(deck, { atCtx: start, beats: 4, bpm });
    const limit = Math.max(1, Math.round(maxBeats));
    for (let k = 1; k <= limit; k++) {
      const t = start + k * beat;
      await this.waitCtx(t - margin);
      if (this.disposed) return t;
      if (ready() || k === limit) {
        this.releaseLoop(deck, t);
        return t;
      }
    }
    return start;
  }

  getLevels(): { A: number; B: number; master: number; groove?: number } {
    return {
      A: this.peak(this.strips.A.meter),
      B: this.peak(this.strips.B.meter),
      master: this.peak(this.masterMeter),
      groove: this.peak(this.grooveMeter),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Groove (re-edit / mashup)
  // -------------------------------------------------------------------------------------------

  /**
   * Lance la boîte à rythmes sous la platine plan.deck : fader du groove monté (courbe en S) sur
   * fadeBeats depuis startCtx, basses de la platine descendues en douceur à sourceLowCutDb.
   * Renvoie les lanes programmées.
   */
  startGroove(plan: GroovePlan): AutomationLane[] {
    this.setTempo(plan.bpm);
    this.groove.start(plan);
    this.grooveDeck = plan.deck;
    const t0 = Math.max(plan.startCtx, this.ctx.currentTime);
    const t1 = t0 + Math.max(0.02, plan.fadeBeats * (60 / plan.bpm));
    const lowTarget = `${plan.deck}.eqLow` as ParamTarget;
    const lanes: AutomationLane[] = [
      { target: 'groove.filter', points: [{ t: t0, v: 0 }] },
      { target: 'groove.eqLow', points: [{ t: t0, v: 0 }] },
      { target: 'groove.gain', points: [{ t: t0, v: this.valueAtTime('groove.gain', t0) }, { t: t1, v: 1, curve: 'smooth' }] },
      {
        target: lowTarget,
        points: [
          { t: t0, v: this.valueAtTime(lowTarget, t0) },
          { t: t1, v: clampParam(lowTarget, plan.sourceLowCutDb), curve: 'smooth' },
        ],
      },
    ];
    this.schedule(lanes);
    return lanes;
  }

  /** Suit la phase / le tempo de la platine : appliqué au prochain temps, sans à-coup. */
  updateGroove(bpm: number, anchorCtx: number): void {
    this.setTempo(bpm);
    this.groove.retime(bpm, anchorCtx);
  }

  /** Redescend le groove sur fadeBeats depuis atCtx et remet l'EQ basse de la platine au neutre. */
  stopGroove(atCtx: number, fadeBeats: number): AutomationLane[] {
    const t0 = Math.max(atCtx, this.ctx.currentTime);
    const bpm = this.groove.currentPlan(t0)?.bpm ?? this.bpm;
    const t1 = t0 + Math.max(0.02, fadeBeats * (60 / bpm));
    const lanes: AutomationLane[] = [
      { target: 'groove.gain', points: [{ t: t0, v: this.valueAtTime('groove.gain', t0) }, { t: t1, v: 0, curve: 'smooth' }] },
    ];
    if (this.grooveDeck) {
      const lowTarget = `${this.grooveDeck}.eqLow` as ParamTarget;
      lanes.push({ target: lowTarget, points: [{ t: t0, v: this.valueAtTime(lowTarget, t0) }, { t: t1, v: 0, curve: 'smooth' }] });
    }
    this.schedule(lanes);
    this.groove.stop(t1 + 0.05);
    this.grooveDeck = undefined;
    return lanes;
  }

  /** Pour l'affichage. beat = temps dans la mesure, 1..4. */
  getGrooveState(): { running: boolean; style?: GrooveStyle; bpm?: number; beat?: number } {
    return this.groove.getState();
  }

  /** Envois post-fader du groove vers l'écho et la réverb (0..1, 0 par défaut). */
  setGrooveSends(echo: number, reverb: number): void {
    const now = this.ctx.currentTime;
    for (const [g, v] of [[this.grooveEchoSend, echo], [this.grooveReverbSend, reverb]] as const) {
      holdParam(g.gain, now);
      g.gain.linearRampToValueAtTime(clamp(Number.isFinite(v) ? v : 0, 0, 1), now + 0.02);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.groove.dispose();
    this.strips.A.sampler.dispose();
    this.strips.B.sampler.dispose();
    try {
      this.noiseSrc.stop();
    } catch {
      /* déjà arrêté */
    }
    for (const d of ['A', 'B'] as const) {
      const s = this.strips[d];
      try {
        if (s.source) s.ownsSource ? s.source.disconnect() : s.source.disconnect(s.trim);
      } catch {
        /* rien */
      }
    }
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* rien */
      }
    }
    this.record.clear();
  }

  // -------------------------------------------------------------------------------------------
  // Interne
  // -------------------------------------------------------------------------------------------

  private async loadWorklet(url?: string): Promise<void> {
    const aw = (this.ctx as AudioContext & { audioWorklet?: AudioWorklet }).audioWorklet;
    if (!aw || typeof AudioWorkletNode === 'undefined') return;
    let blobUrl: string | undefined;
    try {
      if (!url) {
        blobUrl = URL.createObjectURL(new Blob([LOOP_WORKLET_SRC], { type: 'application/javascript' }));
      }
      await aw.addModule(url ?? blobUrl!);
      if (this.disposed) return;
      this.strips.A.sampler.useWorklet();
      this.strips.B.sampler.useWorklet();
    } catch {
      // CSP ou navigateur : on reste sur le ScriptProcessor
    } finally {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    }
  }

  private runLoopActions(deck: DeckId, acts: LoopAction[], bpm: number): void {
    for (const a of acts) {
      if (a.action === 'hold') this.holdLoop(deck, { atCtx: a.t, beats: a.beats, bpm });
      else if (a.action === 'len') this.setLoopLength(deck, a.beats, a.t);
      else this.releaseLoop(deck, a.t);
    }
  }

  private runCueLoops(cue: FxCue): void {
    const acts = fxLoopActions(cue);
    if (!acts.length) return;
    const decks: DeckId[] = cue.target === 'master' ? ['A', 'B'] : [cue.target];
    for (const d of decks) this.runLoopActions(d, acts, cue.bpm);
  }

  /** Attend que l'horloge audio atteigne t (garde-fou horloge murale si le contexte est suspendu). */
  private waitCtx(t: number): Promise<void> {
    const wallLimit = performance.now() + Math.max(0, t - this.ctx.currentTime) * 1000 + 3000;
    return new Promise((resolve) => {
      const tick = () => {
        const d = t - this.ctx.currentTime;
        if (d <= 0.004 || this.disposed || performance.now() > wallLimit) resolve();
        else setTimeout(tick, Math.max(4, Math.min(d * 1000 - 8, 100)));
      };
      tick();
    });
  }

  private valueAtTime(target: ParamTarget, t: number): number {
    return valueAtPoints(this.record.get(target) ?? [], t) ?? paramSpec(target).def;
  }

  private peak(a: AnalyserNode): number {
    if (this.disposed) return 0;
    const buf = this.meterBuf.length >= a.fftSize ? this.meterBuf : new Float32Array(new ArrayBuffer(a.fftSize * 4));
    const view = buf.subarray(0, a.fftSize);
    a.getFloatTimeDomainData(view);
    let m = 0;
    for (let i = 0; i < view.length; i++) {
      const x = Math.abs(view[i]);
      if (x > m) m = x;
    }
    return Math.min(1, m);
  }

  /** Points logiques triés, bornés, ramenés à partir de maintenant. */
  private preparePoints(lane: AutomationLane): AutomationPoint[] {
    const now = this.ctx.currentTime;
    let pts = sortPoints(lane.points)
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
      .map((p) => ({ ...p, v: clampParam(lane.target, p.v) }));
    if (pts.length === 0) return pts;
    if (pts[0].t < now) {
      const v = valueAtPoints(pts, now)!;
      pts = [{ t: now, v }, ...pts.filter((p) => p.t > now)];
    }
    return pts;
  }

  private scheduleLane(lane: AutomationLane): void {
    const binds = this.bindings.get(lane.target);
    if (!binds) return;
    const pts = this.preparePoints(lane);
    if (pts.length === 0) return;
    const t0 = pts[0].t;
    for (const b of binds) {
      holdParam(b.param, t0);
      b.param.setValueAtTime(b.map(pts[0].v), t0);
      for (let i = 1; i < pts.length; i++) this.segment(b, pts[i - 1], pts[i]);
    }
    this.replaceRecordFrom(lane.target, t0, pts);
  }

  private segment(b: Binding, prev: AutomationPoint, cur: AutomationPoint): void {
    const curve = cur.curve ?? 'linear';
    const dur = cur.t - prev.t;
    try {
      if (curve === 'step' || dur <= 1e-6) {
        b.param.setValueAtTime(b.map(cur.v), cur.t);
        return;
      }
      if (curve === 'linear' && b.affine) {
        b.param.linearRampToValueAtTime(b.map(cur.v), cur.t);
        return;
      }
      // courbe échantillonnée (S, exponentielle, ou mapping non linéaire comme le filtre)
      const eps = 2 / this.ctx.sampleRate;
      const start = prev.t + eps;
      const len = dur - 2 * eps;
      if (len < 0.004) {
        b.param.linearRampToValueAtTime(b.map(cur.v), cur.t);
        return;
      }
      const n = clamp(Math.ceil(len * 120), 3, 1024);
      const arr = new Float32Array(n);
      for (let k = 0; k < n; k++) arr[k] = b.map(interp(curve, prev.v, cur.v, k / (n - 1)));
      b.param.setValueCurveAtTime(arr, start, len);
      b.param.setValueAtTime(b.map(cur.v), cur.t);
    } catch {
      // chevauchement refusé par le navigateur : on retombe sur une rampe simple
      try {
        b.param.linearRampToValueAtTime(b.map(cur.v), cur.t);
      } catch {
        /* abandon du segment */
      }
    }
  }

  private scheduleGate(lanes: AutomationLane[]): void {
    const now = this.ctx.currentTime;
    const beat = 60 / this.bpm;
    const prepared = new Map<ParamTarget, AutomationPoint[]>();
    for (const l of lanes) prepared.set(l.target, this.preparePoints(l));
    let from = Infinity;
    for (const pts of prepared.values()) if (pts.length) from = Math.min(from, pts[0].t);
    if (!Number.isFinite(from)) return;
    for (const [target, pts] of prepared) if (pts.length) this.replaceRecordFrom(target, pts[0].t, pts);
    const depth = this.record.get('fx.gate.depth') ?? [];
    const rate = this.record.get('fx.gate.rate') ?? [];
    const lastDepth = depth[depth.length - 1];
    const to = lastDepth && lastDepth.v <= 0.001 ? Math.max(lastDepth.t, from) : from + 64 * beat;
    const pts = renderGate(depth, rate, this.bpm, Math.max(from, now), to);
    const g = this.gate.gain;
    holdParam(g, pts[0].t);
    g.setValueAtTime(pts[0].v, pts[0].t);
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      if (p.t <= pts[i - 1].t) g.setValueAtTime(p.v, p.t);
      else g.linearRampToValueAtTime(p.v, p.t);
    }
  }

  private replaceRecordFrom(target: ParamTarget, t0: number, pts: AutomationPoint[]): void {
    const now = this.ctx.currentTime;
    const old = (this.record.get(target) ?? []).filter((p) => p.t < t0);
    // élagage : on garde au plus le dernier point passé (au-delà d'une seconde)
    let firstKeep = 0;
    for (let i = 0; i < old.length; i++) if (old[i].t < now - 1) firstKeep = i;
    this.record.set(target, [...old.slice(firstKeep), ...pts]);
  }

  private truncateRecord(target: ParamTarget, t: number): void {
    const pts = this.record.get(target);
    if (!pts || pts.length === 0) return;
    const v = valueAtPoints(pts, t)!;
    this.record.set(target, [...pts.filter((p) => p.t < t), { t, v, curve: 'step' }]);
  }

  private appendRecord(target: ParamTarget, p: AutomationPoint): void {
    const pts = this.record.get(target) ?? [];
    this.record.set(target, [...pts.filter((q) => q.t < p.t), p]);
  }
}

/** Écrêteur de sécurité : linéaire jusqu'à 0,9 puis genou en tanh jusqu'à 1. */
function softClipCurve(): Float32Array<ArrayBuffer> {
  const n = 4096;
  const c = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= 0.9 ? a : 0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1);
    c[i] = Math.sign(x) * y;
  }
  return c;
}
