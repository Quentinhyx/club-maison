/**
 * Club Maison : rendu des morceaux de démo en AudioBuffer (cache par id).
 *
 * Dans le navigateur, le rendu (1-2 s de calcul) part dans un Web Worker (render.worker.ts) pour ne
 * pas faire craquer la platine qui joue ni figer la console : un rendu à la fois, dédoublonné par id,
 * PCM renvoyé en Transferable. Sans Worker (Node, tests) ou si le worker échoue : rendu synchrone.
 */
import { getDemoSpec } from './tracks';
import { renderDemoPcmImpl } from './synth';
import { computeWaveform, type Waveform, type WaveformInput } from './waveform';

export const DEMO_SAMPLE_RATE = 44100;

export function isDemoTrack(id: number): boolean {
  return getDemoSpec(id) !== undefined;
}

// ---------------------------------------------------------------------------------------------
// Worker (création paresseuse) + file d'attente sérielle
// ---------------------------------------------------------------------------------------------

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
let worker: Worker | null | undefined;     // undefined = pas encore essayé, null = indisponible
let nextReqId = 1;
const pending = new Map<number, Pending>();
let queue: Promise<unknown> = Promise.resolve();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === 'undefined') return (worker = null);
  try {
    const w = new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ reqId: number; ok: boolean; error?: string }>) => {
      const p = pending.get(e.data.reqId);
      if (!p) return;
      pending.delete(e.data.reqId);
      if (e.data.ok) p.resolve(e.data); else p.reject(new Error(e.data.error ?? 'rendu impossible'));
    };
    w.onerror = (e) => {
      // worker cassé (chargement impossible…) : on rejette tout et on repasse en synchrone
      e.preventDefault?.();
      console.warn('[demo] worker de rendu indisponible, rendu synchrone', e.message);
      for (const p of pending.values()) p.reject(new Error('worker indisponible'));
      pending.clear();
      w.terminate();
      worker = null;
    };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

/** Envoie une requête au worker, une à la fois (la file garde l'ordre et évite de saturer). */
function enqueue<T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
  const run = () => new Promise<T>((resolve, reject) => {
    const w = getWorker();
    if (!w) { reject(new Error('worker indisponible')); return; }
    const reqId = nextReqId++;
    pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage({ ...msg, reqId }, transfer);
  });
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}

// ---------------------------------------------------------------------------------------------
// PCM et AudioBuffer
// ---------------------------------------------------------------------------------------------

type Pcm = { left: Float32Array; right: Float32Array };
const pcmCache = new Map<number, Promise<Pcm>>();

/** Rendu PCM asynchrone (worker si possible), dédoublonné par id. */
export function renderDemoPcmAsync(id: number): Promise<Pcm> {
  let p = pcmCache.get(id);
  if (!p) {
    p = (async () => {
      if (!isDemoTrack(id)) throw new Error(`Morceau de démo inconnu : ${id}`);
      if (getWorker()) {
        try {
          const r = await enqueue<Pcm>({ kind: 'pcm', id, sampleRate: DEMO_SAMPLE_RATE });
          return { left: r.left, right: r.right };
        } catch (err) {
          if (getWorker()) throw err;     // vraie erreur de rendu
          // sinon le worker est tombé : repli synchrone ci-dessous
        }
      }
      return renderDemoPcmImpl(id, DEMO_SAMPLE_RATE);
    })();
    p.catch(() => pcmCache.delete(id));
    pcmCache.set(id, p);
  }
  return p;
}

const bufferCache = new Map<number, Promise<AudioBuffer>>();

/**
 * AudioBuffer stéréo 44,1 kHz du morceau, créé par `ctx` (un AudioBuffer n'est pas lié à son
 * contexte, le cache sert aussi aux autres). Le PCM n'est gardé que dans l'AudioBuffer.
 */
export function getDemoBuffer(id: number, ctx: BaseAudioContext): Promise<AudioBuffer> {
  let p = bufferCache.get(id);
  if (!p) {
    p = renderDemoPcmAsync(id).then(async ({ left, right }) => {
      const buf = ctx.createBuffer(2, left.length, DEMO_SAMPLE_RATE);
      // copie par tranches (~1 M échantillons) en rendant la main entre deux : pas de gel visible
      const yieldNow = typeof window !== 'undefined';
      const CH = 1 << 20;
      for (const [c, src] of [[0, left], [1, right]] as const) {
        const dst = buf.getChannelData(c);
        for (let i = 0; i < src.length; i += CH) {
          dst.set(src.subarray(i, Math.min(src.length, i + CH)), i);
          if (yieldNow) await new Promise((r) => setTimeout(r, 0));
        }
      }
      pcmCache.delete(id);            // libère la copie PCM
      return buf;
    });
    p.catch(() => bufferCache.delete(id));
    bufferCache.set(id, p);
  }
  return p;
}

/** Prépare à l'avance (en arrière-plan, l'un après l'autre) les morceaux donnés. Ne rejette jamais. */
export function prewarmDemo(ids: number[], ctx: BaseAudioContext): Promise<void> {
  return Promise.all(ids.filter(isDemoTrack).map((id) => getDemoBuffer(id, ctx).catch((err) => {
    console.warn(`[demo] préchargement ${id} impossible`, err);
  }))).then(() => undefined);
}

// ---------------------------------------------------------------------------------------------
// Forme d'onde asynchrone
// ---------------------------------------------------------------------------------------------

/**
 * computeWaveform dans le worker. Le signal est réduit en mono (L+R)/2 sur le thread principal par
 * tranches, en rendant la main entre deux (l'appelant garde ses données intactes), puis transféré.
 * Résultat identique à computeWaveform. Repli synchrone sans Worker.
 */
export async function computeWaveformAsync(input: WaveformInput, pointsPerSecond: number): Promise<Waveform> {
  if (!getWorker()) return computeWaveform(input, pointsPerSecond);
  let l: Float32Array, r: Float32Array | undefined, sampleRate: number;
  if ('getChannelData' in input) {
    l = input.getChannelData(0);
    r = input.numberOfChannels > 1 ? input.getChannelData(1) : undefined;
    sampleRate = input.sampleRate;
  } else {
    l = input.left; r = input.right; sampleRate = input.sampleRate;
  }
  const mono = new Float32Array(l.length);
  const CH = 1 << 19;
  for (let a = 0; a < l.length; a += CH) {
    const b = Math.min(l.length, a + CH);
    if (r) for (let i = a; i < b; i++) mono[i] = (l[i] + r[i]) * 0.5;
    else mono.set(l.subarray(a, b), a);
    await new Promise((res) => setTimeout(res, 0));
  }
  try {
    const res = await enqueue<{ waveform: Waveform }>({ kind: 'waveform', left: mono, sampleRate, pointsPerSecond }, [mono.buffer]);
    return res.waveform;
  } catch (err) {
    if (getWorker()) throw err;
    return computeWaveform(input, pointsPerSecond);
  }
}
