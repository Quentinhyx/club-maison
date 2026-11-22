/**
 * Formes d'onde par bande (basses / médiums / aigus) :
 *  - morceaux démo : forme d'onde complète calculée sur le buffer (computeWaveform) ;
 *  - Deezer / extraits : construite en direct depuis le signal capté, indexée par position.
 */
import type { DeckId, TrackRef } from '../../shared/contracts';
import { getDemoBuffer, isDemoTrack } from '../../shared/demo/index';
import type { Bands } from './meters';

export interface Waveform {
  trackId: number;
  pps: number;            // points par seconde de morceau
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  peak: Float32Array;
  full: boolean;          // true = calculée sur le morceau entier, false = remplie en direct
  filled?: Uint8Array;    // pour le direct : points déjà mesurés
}

type ComputeFn = (b: AudioBuffer, pps: number) => { low: Float32Array; mid: Float32Array; high: Float32Array; peak: Float32Array };

const LIVE_PPS = 40;
const FULL_PPS = 80;

export class WaveformStore {
  private byId = new Map<number, Waveform>();
  private pending = new Set<number>();

  constructor(
    private ctx: AudioContext,
    _mixer: unknown,
    private compute: ComputeFn,
  ) {}

  get(track?: TrackRef): Waveform | undefined {
    if (!track) return undefined;
    const w = this.byId.get(track.id);
    if (!w && !this.pending.has(track.id)) void this.prepare('A', track);
    return w;
  }

  async prepare(_deck: DeckId, track: TrackRef): Promise<void> {
    if (this.byId.has(track.id) || this.pending.has(track.id)) return;
    this.pending.add(track.id);
    try {
      if (isDemoTrack(track.id)) {
        const buf = await getDemoBuffer(track.id, this.ctx);
        const w = this.compute(buf, FULL_PPS);
        this.byId.set(track.id, { trackId: track.id, pps: FULL_PPS, ...normalize(w), full: true });
      } else {
        const n = Math.max(1, Math.ceil((track.duration || 30) * LIVE_PPS) + 2);
        this.byId.set(track.id, {
          trackId: track.id,
          pps: LIVE_PPS,
          low: new Float32Array(n),
          mid: new Float32Array(n),
          high: new Float32Array(n),
          peak: new Float32Array(n),
          filled: new Uint8Array(n),
          full: false,
        });
      }
    } catch {
      /* forme d'onde indisponible : l'affichage reste vide */
    } finally {
      this.pending.delete(track.id);
    }
  }

  /** Enregistre la mesure courante (forme d'onde en direct). */
  record(track: TrackRef | undefined, position: number, b: Bands): void {
    if (!track) return;
    const w = this.byId.get(track.id);
    if (!w || w.full || !w.filled) return;
    const i = Math.floor(position * w.pps);
    if (i < 0 || i >= w.low.length) return;
    w.low[i] = Math.max(w.low[i], b.low);
    w.mid[i] = Math.max(w.mid[i], b.mid);
    w.high[i] = Math.max(w.high[i], b.high);
    w.peak[i] = Math.max(w.peak[i], b.peak);
    w.filled[i] = 1;
  }
}

function normalize(w: { low: Float32Array; mid: Float32Array; high: Float32Array; peak: Float32Array }) {
  let m = 0;
  for (const a of [w.low, w.mid, w.high]) for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
  if (m <= 0 || m === 1) return w;
  const k = 1 / m;
  const sc = (a: Float32Array) => a.map((v) => v * k);
  return { low: sc(w.low), mid: sc(w.mid), high: sc(w.high), peak: sc(w.peak) };
}
