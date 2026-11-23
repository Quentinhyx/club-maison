/** Téléchargement + décodage + analyse d'un extrait Deezer, avec cache mémoire par trackId. */
import type { TrackAnalysis, TrackRef } from '../contracts';
import { analyzeBuffer } from './offline';

const cache = new Map<number, TrackAnalysis>();
const CACHE_MAX = 200;
const inflight = new Map<number, Promise<TrackAnalysis>>();

export function getCachedAnalysis(id: number): TrackAnalysis | undefined {
  const a = cache.get(id);
  if (a) {
    // rafraîchit sa place dans le LRU
    cache.delete(id);
    cache.set(id, a);
  }
  return a;
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
    // délai de 8 s : un extrait bloqué ne doit jamais occuper un emplacement d'analyse
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(8000) : undefined;
    const res = await fetcher(track.preview as string, signal ? { signal } : undefined);
    if (!res.ok) throw new Error(`Extrait ${track.id} : HTTP ${res.status}`);
    const data = await res.arrayBuffer();
    const audio = await ctx.decodeAudioData(data);
    const channels: Float32Array[] = [];
    for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c));
    const analysis = analyzeBuffer(channels, audio.sampleRate, track);
    cache.set(track.id, analysis);
    // LRU d'environ 200 analyses (soirée de 6 h)
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as number);
    return analysis;
  })();
  inflight.set(track.id, job);
  try {
    return await job;
  } finally {
    inflight.delete(track.id);
  }
}
