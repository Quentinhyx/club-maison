/**
 * Club Maison : Web Worker de rendu des morceaux de démo (évite de bloquer le thread principal).
 * Messages entrants  : { kind: 'pcm', reqId, id, sampleRate }
 *                      { kind: 'waveform', reqId, left, right?, sampleRate, pointsPerSecond }
 * Messages sortants  : { reqId, ok: true, left, right } | { reqId, ok: true, waveform } | { reqId, ok: false, error }
 * Les Float32Array sont renvoyés en Transferable (pas de copie).
 */
import { renderDemoPcmImpl } from './synth';
import { computeWaveform } from './waveform';

type Req =
  | { kind: 'pcm'; reqId: number; id: number; sampleRate: number }
  | { kind: 'waveform'; reqId: number; left: Float32Array; right?: Float32Array; sampleRate: number; pointsPerSecond: number };

interface WorkerScope {
  onmessage: ((e: MessageEvent<Req>) => void) | null;
  postMessage(msg: unknown, transfer: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

scope.onmessage = (e) => {
  const req = e.data;
  try {
    if (req.kind === 'pcm') {
      const { left, right } = renderDemoPcmImpl(req.id, req.sampleRate);
      scope.postMessage({ reqId: req.reqId, ok: true, left, right }, [left.buffer, right.buffer]);
    } else {
      const wf = computeWaveform({ left: req.left, right: req.right, sampleRate: req.sampleRate }, req.pointsPerSecond);
      scope.postMessage({ reqId: req.reqId, ok: true, waveform: wf }, [wf.low.buffer, wf.mid.buffer, wf.high.buffer, wf.peak.buffer]);
    }
  } catch (err) {
    scope.postMessage({ reqId: req.reqId, ok: false, error: err instanceof Error ? err.message : String(err) }, []);
  }
};
