/**
 * shared/audio : table de mixage Web Audio + recettes de transitions et d'effets.
 */
export { Mixer } from './mixer';
export type { MixerOptions } from './mixer';
export { LoopSampler } from './loop-sampler';
export {
  LoopCore, LOOP_WORKLET_SRC, LOOP_WORKLET_NAME, LOOP_FADE_SECONDS, LOOP_BUFFER_SECONDS, loopWindow, microFade,
  loopRollSchedule, fxLoopActions, transitionLoopActions, transitionRollBeats, loopRollCut,
} from './loop';
export type { LoopSegment, LoopMessage, LoopAction } from './loop';
export { PreviewDeck } from './preview-deck';
export { GrooveMachine, GROOVE_LOOKAHEAD, GROOVE_TICK_MS } from './groove-machine';
export { grooveSchedule, camelotRootMidi, retimeGroove, midiToHz, GROOVE_PATTERNS } from './groove';
export type { GrooveEvent, GroovePart } from './groove';
export {
  planToAutomation, fxToAutomation, transitionLanes, mergeLanes, echoDivision, brakeBeats, LaneBuilder,
} from './recipes';
export { phaseNudge, tempoMatchRate, rateRamp, wrapHalf, PHASE_HORIZON_BEATS, PHASE_DEADBAND_BEATS } from './sync';
export {
  DECK_PARAM_SPECS, MASTER_PARAM_SPECS, EQ_KILL_DB, EQ_MAX_DB, ALL_TARGETS, paramSpec, clampParam,
  interp, valueAt, valueAtPoints, djFilterToNodes, renderGate, generateImpulse,
} from './params';
export type { ParamSpec } from './params';
export { stingerSchedule, stingerEnd, playStinger, isStinger, STINGER_KINDS } from './stingers';
export type { StingerKind, StingerNote } from './stingers';
