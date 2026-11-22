/**
 * Club Maison : morceaux de démo synthétiques (mode hors ligne, sans Deezer).
 *
 *   listDemoTracks()          catalogue (ids négatifs stables)
 *   isDemoTrack(id)
 *   getDemoBuffer(id, ctx)    AudioBuffer stéréo 44,1 kHz (rendu PCM par code, mis en cache)
 *   renderDemoPcm(id, sr)     rendu pur (Node, Worker)
 *   getDemoStructure(id)      sections (intro/body/drop/breakdown/build/outro) en temps
 *   getDemoKey(id)            tonalité Camelot
 *   getDemoMeta(id)           tempo réel, tempo stable ou non (rubato), carte des temps, structure
 *   computeWaveform(...)      forme d'onde 3 bandes (computeWaveformAsync : dans le worker)
 *   prewarmDemo(ids, ctx)     rendu à l'avance en arrière-plan (Web Worker render.worker.ts)
 *   SynthDeck                 platine DeckController qui lit ces morceaux
 */
import type { Camelot, TrackRef } from '../contracts';
import { DEMO_SPECS, demoCover, getDemoSpec } from './tracks';
import { camelotInfo, demoDurationOf, demoMetaOf, demoStructureOf, renderDemoPcmImpl, type DemoMeta, type DemoStructureItem } from './synth';

export { computeWaveform, type Waveform, type WaveformInput } from './waveform';
export { SynthDeck } from './deck';
export type { DemoMeta, DemoStructureItem } from './synth';
export { getDemoBuffer, isDemoTrack, DEMO_SAMPLE_RATE, prewarmDemo, computeWaveformAsync, renderDemoPcmAsync } from './buffer';

let tracksCache: TrackRef[] | undefined;

export function listDemoTracks(): TrackRef[] {
  if (!tracksCache) {
    tracksCache = DEMO_SPECS.map((s) => ({
      id: s.id,
      title: s.title,
      artist: s.artist,
      album: s.album,
      cover: demoCover(s),
      duration: demoDurationOf(s),
      bpm: s.bpm,
      gain: -10,
      rank: 500000 + ((s.seed * 7919) % 400000),
      releaseYear: s.releaseYear,
      genres: [...s.genres],
    }));
  }
  return tracksCache.map((t) => ({ ...t, genres: t.genres ? [...t.genres] : undefined }));
}

export function getDemoKey(id: number): Camelot | undefined {
  return getDemoSpec(id)?.key;
}

/** Nom usuel de la tonalité (ex. « Am », « G »). */
export function getDemoKeyName(id: number): string | undefined {
  const s = getDemoSpec(id);
  return s ? camelotInfo(s.key).name : undefined;
}

export function getDemoStructure(id: number): DemoStructureItem[] {
  const s = getDemoSpec(id);
  return s ? demoStructureOf(s) : [];
}

export function renderDemoPcm(id: number, sampleRate: number): { left: Float32Array; right: Float32Array } {
  return renderDemoPcmImpl(id, sampleRate);
}

/** Vérité terrain : tonalité, tempo réel, stabilité du tempo, carte des temps, structure. */
export function getDemoMeta(id: number): DemoMeta | undefined {
  const s = getDemoSpec(id);
  return s ? demoMetaOf(s) : undefined;
}
