/**
 * Branche un LiveBeatTracker sur un nœud Web Audio (sortie d'une platine).
 *
 * Capture : AudioWorklet embarqué en Blob URL (trames de 1024 échantillons horodatées par le thread
 * audio, sans perte). Si le worklet n'est pas disponible (CSP, ancien navigateur), repli sur un
 * AnalyserNode lu toutes les ~20 ms : on ne pousse que les échantillons nouveaux depuis la lecture
 * précédente (gestion du recouvrement), un trou éventuel est simplement sauté.
 */
import type { LiveAnalysis } from '../contracts';
import { LiveBeatTracker } from './live';

const WORKLET_NAME = 'club-maison-capture';
const FRAME = 1024;

/** Source du processeur de capture : exportée pour en faire un vrai fichier quand la CSP interdit
 *  les Blob URL (extension Chrome MV3), voir l'option `workletUrl`. */
export const LIVE_WORKLET_SRC = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(${FRAME});
    this.n = 0;
    this.alive = true;
    this.port.onmessage = (e) => { if (e.data === 'stop') this.alive = false; };
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const ch = input.length;
      const len = input[0].length;
      for (let i = 0; i < len; i++) {
        let s = 0;
        for (let c = 0; c < ch; c++) s += input[c][i];
        this.buf[this.n++] = s / ch;
        if (this.n === ${FRAME}) {
          const endTime = currentTime + (i + 1) / sampleRate;
          this.port.postMessage({ frame: this.buf, end: endTime }, [this.buf.buffer]);
          this.buf = new Float32Array(${FRAME});
          this.n = 0;
        }
      }
    }
    return this.alive;
  }
}
registerProcessor('${WORKLET_NAME}', CaptureProcessor);
`;

const workletLoads = new WeakMap<BaseAudioContext, Promise<void>>();

function loadWorklet(ctx: AudioContext, fileUrl?: string): Promise<void> {
  let p = workletLoads.get(ctx);
  if (!p) {
    if (fileUrl) p = ctx.audioWorklet.addModule(fileUrl);
    else {
      const url = URL.createObjectURL(new Blob([LIVE_WORKLET_SRC], { type: 'application/javascript' }));
      p = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    }
    workletLoads.set(ctx, p);
  }
  return p;
}

export interface LiveAnalyzerOptions {
  bpmHint?: number;
  /** 'auto' (défaut) : worklet puis repli analyser. */
  mode?: 'auto' | 'worklet' | 'analyser';
  /** URL d'un vrai fichier contenant LIVE_WORKLET_SRC (CSP sans Blob URL, ex. extension MV3). */
  workletUrl?: string;
}

export class LiveAnalyzer {
  readonly tracker: LiveBeatTracker;
  private readonly ctx: AudioContext;
  private readonly input: AudioNode;
  private sink: GainNode;
  private worklet?: AudioWorkletNode;
  private analyser?: AnalyserNode;
  private timer?: ReturnType<typeof setInterval>;
  private lastAnalyserCtx = -1;
  private disposed = false;

  constructor(ctx: AudioContext, input: AudioNode, opts: LiveAnalyzerOptions = {}) {
    this.ctx = ctx;
    this.input = input;
    this.tracker = new LiveBeatTracker({ sampleRate: ctx.sampleRate, bpmHint: opts.bpmHint });
    // puits muet : garantit que le graphe de capture est bien « tiré » par le moteur audio
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.sink.connect(ctx.destination);
    const mode = opts.mode ?? 'auto';
    if (mode !== 'analyser' && typeof AudioWorkletNode !== 'undefined' && ctx.audioWorklet) {
      loadWorklet(ctx, opts.workletUrl).then(
        () => { if (!this.disposed) this.startWorklet(); },
        () => { if (!this.disposed) this.startAnalyser(); },
      );
    } else {
      this.startAnalyser();
    }
  }

  /** Mode de capture effectif : 'worklet', 'analyser' (repli) ou 'pending' (chargement). */
  get captureMode(): 'worklet' | 'analyser' | 'pending' {
    return this.worklet ? 'worklet' : this.analyser ? 'analyser' : 'pending';
  }

  getState(): LiveAnalysis | undefined {
    return this.tracker.getState();
  }

  reset(bpmHint?: number): void {
    this.tracker.reset(bpmHint);
    this.lastAnalyserCtx = -1;
  }

  /** Voir LiveBeatTracker.setTrackPosition. */
  setTrackPosition(pos: number, atCtx: number, duration?: number): void {
    this.tracker.setTrackPosition(pos, atCtx, duration);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    if (this.worklet) {
      this.worklet.port.postMessage('stop');
      this.worklet.port.onmessage = null;
      safeDisconnect(this.input, this.worklet);
      safeDisconnect(this.worklet);
      this.worklet = undefined;
    }
    if (this.analyser) {
      safeDisconnect(this.input, this.analyser);
      safeDisconnect(this.analyser);
      this.analyser = undefined;
    }
    safeDisconnect(this.sink);
  }

  private startWorklet(): void {
    try {
      const node = new AudioWorkletNode(this.ctx, WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      });
      node.port.onmessage = (e: MessageEvent<{ frame: Float32Array; end: number }>) => {
        if (this.disposed) return;
        this.tracker.push(e.data.frame, e.data.end);
      };
      this.input.connect(node);
      node.connect(this.sink);
      this.worklet = node;
    } catch {
      this.startAnalyser();
    }
  }

  private startAnalyser(): void {
    const an = this.ctx.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0;
    an.channelCount = 2;
    an.channelCountMode = 'explicit';
    this.input.connect(an);
    an.connect(this.sink);
    this.analyser = an;
    const buf = new Float32Array(an.fftSize);
    const sr = this.ctx.sampleRate;
    this.timer = setInterval(() => {
      if (this.disposed || !this.analyser || this.ctx.state !== 'running') return;
      const now = this.ctx.currentTime;
      if (now <= this.lastAnalyserCtx) return;
      this.analyser.getFloatTimeDomainData(buf);
      let fresh = this.lastAnalyserCtx < 0 ? buf.length : Math.round((now - this.lastAnalyserCtx) * sr);
      if (fresh <= 0) return;
      if (fresh > buf.length) fresh = buf.length; // trou : on saute ce qui manque
      this.lastAnalyserCtx = now;
      this.tracker.push(buf.slice(buf.length - fresh), now);
    }, 20);
  }
}

function safeDisconnect(a: AudioNode, b?: AudioNode): void {
  try {
    if (b) a.disconnect(b);
    else a.disconnect();
  } catch {
    /* déjà déconnecté */
  }
}
