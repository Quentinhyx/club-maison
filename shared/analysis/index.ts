/** Analyse musicale Club Maison : hors ligne (extraits 30 s) et en direct (signal d'une platine). */
export { analyzeBuffer, estimateKey, estimateTempo } from './offline';
export { analyzePreview, getCachedAnalysis, clearAnalysisCache } from './preview';
export { LiveBeatTracker } from './live';
export type { LiveBeatTrackerOptions } from './live';
export { LiveAnalyzer } from './liveAnalyzer';
export type { LiveAnalyzerOptions } from './liveAnalyzer';
export { normalizeBpm, toCamelot } from './dsp';
export { TrackScanner, waveformFromBuffer, structureFromWaveform } from './structure';
export type { TrackScannerOptions } from './structure';
