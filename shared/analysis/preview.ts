/** Téléchargement + décodage + analyse d'un extrait Deezer, avec cache mémoire par trackId. */
import type { TrackAnalysis, TrackRef } from '../contracts';
import { analyzeBuffer } from './offline';

const cache = new Map<number, TrackAnalysis>();
const inflight = new Map<number, Promise<TrackAnalysis>>();

export function getCachedAnalysis(id: number): TrackAnalysis | undefined {
  return cache.get(id);
}

/** Pour les tests / un rechargement : vide le cache. */
export function clearAnalysisCache(): void {
  cache.clear();
  inflight.clear();
}

export async function analyzePreview(
  ctx: BaseAudioContext,
  track: TrackRef,
  fetcher: typeof fetch = fetch,
): Promise<TrackAnalysis> {
  const hit = cache.get(track.id);
  if (hit) return hit;
  const pending = inflight.get(track.id);
  if (pending) return pending;
  if (!track.preview) throw new Error(`Morceau ${track.id} : pas d'extrait (preview) à analyser`);

  const job = (async () => {
    const res = await fetcher(track.preview as string);
    if (!res.ok) throw new Error(`Extrait ${track.id} : HTTP ${res.status}`);
    const data = await res.arrayBuffer();
    const audio = await ctx.decodeAudioData(data);
    const channels: Float32Array[] = [];
    for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c));
    const analysis = analyzeBuffer(channels, audio.sampleRate, track);
    cache.set(track.id, analysis);
    return analysis;
  })();
  inflight.set(track.id, job);
  try {
    return await job;
  } finally {
    inflight.delete(track.id);
  }
}
