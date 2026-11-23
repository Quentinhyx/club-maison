/** Cerveau DJ de Club Maison : API publique. */
export { createBrain, chooseStartAt, chooseEntryPoint, entryKindFor, usableStructure, exitReason, bridgeRange, BEAT_CONFIDENCE_MIN, GUEST_MAX_WAIT_MS, GUEST_FIT_SCORE, MIN_LOAD_LEAD_S, STRUCTURE_MIN_CONFIDENCE } from './brain';
export type { EntryKind, EntryPointInput } from './brain';
export type { BrainInputExtras } from './brain';
export { DEFAULT_SETTINGS, STYLE_PROFILES, SITUATIONS, energyAt, targetBpmAt } from './profiles';
export type { StyleProfile, TransitionSituation } from './profiles';
export { GENRE_BPM, GENRE_GRAPH, GENRE_EDGES, ELECTRONIC_GENRES, genrePath, genrePathCost, isElectronic } from './genres';
export { camelotDistance, harmonicScore } from './harmony';
export { chooseTechnique, techniqueWeights, pickBeats, needsSync, SYNC_TECHNIQUES, NO_GRID_TECHNIQUES } from './technique';
export type { TechniqueContext } from './technique';
export { scoreCandidate, tempoMatch, tempoScore, artistKey, REPLAY_WINDOW_MS } from './scoring';
export type { CandidateInfo, ScoreContext, ScoreResult, SkipMark } from './scoring';
export { checkReEdit, grooveStyleFor, partyRate, REEDIT_GENRES, REEDIT_MIN_STABILITY } from './tempo';
export type { ReEditCheck } from './tempo';
