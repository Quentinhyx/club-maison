/**
 * Boucle d'animation unique (requestAnimationFrame) + calcul, à chaque image, de la vue de chaque
 * platine (position, grille des temps, phase). Pas de React ici : les composants s'abonnent et
 * dessinent eux-mêmes (canvas, styles).
 */
import { useEffect, useRef } from 'react';
import type { DeckId, DeckState, TrackAnalysis } from '../../../shared/contracts';
import { getDemoMeta } from '../../../shared/demo/index';
import type { Engine } from '../engine';
import type { ActiveFx, TransitionView } from '../conductor';

type FrameCb = (t: number) => void;
const cbs = new Set<FrameCb>();
let running = false;

function loop(t: number) {
  for (const cb of cbs) {
    try {
      cb(t);
    } catch (e) {
      console.error(e);
    }
  }
  if (cbs.size) requestAnimationFrame(loop);
  else running = false;
}

export function onFrame(cb: FrameCb): () => void {
  cbs.add(cb);
  if (!running) {
    running = true;
    requestAnimationFrame(loop);
  }
  return () => cbs.delete(cb);
}

export function useFrame(cb: FrameCb): void {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => onFrame((t) => ref.current(t)), []);
}

export interface Grid {
  /** Durée d'un temps en secondes de MORCEAU (indépendante de la vitesse). */
  period: number;
  /** Position (s) du temps n° 0 (début de la grille, aligné sur une phrase). */
  origin: number;
  bpm: number;      // tempo du morceau à vitesse 1
  live: boolean;    // grille issue de l'analyse en direct
  /** Instants exacts de chaque temps (morceaux démo, y compris à tempo libre). */
  times?: Float64Array;
}

/** Indice du dernier temps <= pos dans une liste triée. */
export function beatIndexAt(times: Float64Array, pos: number): number {
  let lo = 0;
  let hi = times.length - 1;
  if (pos < times[0]) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface DeckView {
  id: DeckId;
  state: DeckState;
  analysis?: TrackAnalysis;
  pos: number;
  rate: number;
  playing: boolean;
  grid?: Grid;
  /** Numéro du temps courant depuis l'origine (peut être négatif). */
  beat: number;
  /** Fraction du temps courant 0..1. */
  beatFrac: number;
}

/** Grille des temps : exacte pour les morceaux démo (temps 0 = début), sinon analyse en direct, sinon BPM analysé. */
export function deckGrid(st: DeckState, analysis: TrackAnalysis | undefined, nowCtx: number): Grid | undefined {
  const t = st.track;
  if (!t) return undefined;
  // morceau démo à tempo régulier : grille exacte (temps 0 = début du morceau)
  const meta = getDemoMeta(t.id);
  if (meta && meta.beatTimes?.length > 1) {
    const bt = meta.beatTimes;
    return { period: 60 / meta.realBpm, origin: bt[0], bpm: meta.realBpm, live: false, times: meta.tempoStable ? undefined : bt };
  }
  const live = st.live;
  if (live && live.beatConfidence >= 0.35 && live.bpm > 0 && st.rate > 0) {
    const bpm = live.bpm / st.rate;
    const period = 60 / bpm;
    const anchor = st.position - (nowCtx - live.downbeatCtx) * st.rate;
    const bar = period * 4;
    const origin = anchor - Math.floor(anchor / bar) * bar;
    return { period, origin, bpm, live: true };
  }
  const bpm = analysis?.bpm || t.bpm;
  if (bpm && bpm > 0) return { period: 60 / bpm, origin: 0, bpm, live: false };
  return undefined;
}

export function deckView(engine: Engine, id: DeckId, states?: Record<DeckId, DeckState>): DeckView {
  const st = states?.[id] ?? engine.conductor.deckStates()[id];
  const analysis = st.analysis;
  const now = engine.ctx.currentTime;
  const grid = deckGrid(st, analysis, now);
  const pos = st.position;
  let beat = 0;
  let beatFrac = 0;
  if (grid?.times) {
    const i = beatIndexAt(grid.times, pos);
    const t0 = grid.times[Math.max(0, i)];
    const t1 = grid.times[Math.min(grid.times.length - 1, Math.max(0, i) + 1)];
    beat = i;
    beatFrac = t1 > t0 ? Math.min(1, Math.max(0, (pos - t0) / (t1 - t0))) : 0;
  } else if (grid) {
    const b = (pos - grid.origin) / grid.period;
    beat = Math.floor(b);
    beatFrac = b - beat;
  }
  return { id, state: st, analysis, pos, rate: st.rate || 1, playing: st.status === 'playing', grid, beat, beatFrac };
}

export interface FrameData {
  t: number;
  now: number;
  states: Record<DeckId, DeckState>;
  views: Record<DeckId, DeckView>;
  onAir: DeckId | null;
  transition?: TransitionView;
  activeFx: ActiveFx[];
}

let cache: FrameData | undefined;

/** Données partagées par tous les composants pour l'image en cours (calculées une fois par image). */
export function getFrame(engine: Engine, t: number): FrameData {
  if (cache && cache.t === t) return cache;
  const states = engine.conductor.deckStates();
  cache = {
    t,
    now: engine.ctx.currentTime,
    states,
    views: { A: deckView(engine, 'A', states), B: deckView(engine, 'B', states) },
    onAir: engine.conductor.onAir(states),
    transition: engine.conductor.getTransition(),
    activeFx: engine.conductor.getActiveFx(),
  };
  return cache;
}

/** Écart de phase entre deux platines en temps (-0.5..0.5), ou undefined si non pertinent. */
export function phaseDiff(a: DeckView, b: DeckView): number | undefined {
  if (!a.playing || !b.playing || !a.grid || !b.grid) return undefined;
  const x = a.beatFrac - b.beatFrac;
  return x - Math.round(x);
}
