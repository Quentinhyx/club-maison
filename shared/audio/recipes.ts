/**
 * Recettes de transitions et d'effets : TransitionPlan / FxCue -> lanes d'automation.
 * PUR : aucune dépendance Web Audio, tout est testable dans recipes.test.ts.
 *
 * Toutes les recettes sont calées sur la grille : beat = 60 / bpm, startCtx = début de phrase.
 * Le « 1 » d'arrivée de l'entrant, pour les techniques à drop, est startCtx + beats * beat.
 */
import type {
  AutomationLane, AutomationPoint, Curve, DeckId, DeckParam, FxCue, MasterParam, ParamTarget,
  TransitionPlan,
} from '../contracts';
import {
  DECK_PARAMS, DECK_PARAM_SPECS, ECHO_FEEDBACK_NEUTRAL, EQ_KILL_DB, MASTER_PARAM_SPECS,
  REVERB_RETURN_NEUTRAL, clamp, clampParam, isDeckTarget, sortPoints, valueAtPoints,
} from './params';

// ---------------------------------------------------------------------------------------------
// Construction des lanes
// ---------------------------------------------------------------------------------------------

/** Petit utilitaire pour empiler des points par cible ; trie et borne à la fin. */
export class LaneBuilder {
  private readonly map = new Map<ParamTarget, AutomationPoint[]>();

  point(target: ParamTarget, t: number, v: number, curve?: Curve): this {
    let pts = this.map.get(target);
    if (!pts) this.map.set(target, (pts = []));
    pts.push(curve ? { t, v, curve } : { t, v });
    return this;
  }
  /** Saut à t (on garde la valeur précédente jusqu'à t). */
  set(target: ParamTarget, t: number, v: number): this {
    return this.point(target, t, v, 'step');
  }
  ramp(target: ParamTarget, t: number, v: number, curve: Curve = 'linear'): this {
    return this.point(target, t, v, curve);
  }
  /** Maintient la valeur courante (à l'instant t) jusqu'à t : point de départ d'une rampe. */
  hold(target: ParamTarget, t: number): this {
    const v = this.valueAt(target, t);
    if (v === undefined) return this;
    return this.point(target, t, v, 'step');
  }
  /**
   * Fondu à puissance constante entre a et b : g(x) = sqrt(a² cos²(πx/2) + b² sin²(πx/2)).
   * Deux fondus complémentaires (0->1 et 1->0 sur la même fenêtre) gardent gA² + gB² = 1.
   */
  powerFade(target: ParamTarget, t0: number, t1: number, a: number, b: number, steps = 16): this {
    this.point(target, t0, a, 'step');
    for (let k = 1; k <= steps; k++) {
      const x = k / steps;
      const c = Math.cos((Math.PI / 2) * x);
      const s = Math.sin((Math.PI / 2) * x);
      this.point(target, t0 + (t1 - t0) * x, Math.sqrt(a * a * c * c + b * b * s * s), 'linear');
    }
    return this;
  }
  /** Courbe quelconque échantillonnée (f(0) au départ, f(1) à l'arrivée). */
  shape(target: ParamTarget, t0: number, t1: number, f: (x: number) => number, steps = 12): this {
    this.point(target, t0, f(0), 'step');
    for (let k = 1; k <= steps; k++) {
      const x = k / steps;
      this.point(target, t0 + (t1 - t0) * x, f(x), 'linear');
    }
    return this;
  }
  has(target: ParamTarget): boolean {
    return (this.map.get(target)?.length ?? 0) > 0;
  }
  valueAt(target: ParamTarget, t: number): number | undefined {
    const pts = this.map.get(target);
    return pts ? valueAtPoints(sortPoints(pts), t) : undefined;
  }
  last(target: ParamTarget): AutomationPoint | undefined {
    const pts = this.map.get(target);
    if (!pts || pts.length === 0) return undefined;
    return sortPoints(pts)[pts.length - 1];
  }
  targets(): ParamTarget[] {
    return [...this.map.keys()];
  }
  build(): AutomationLane[] {
    const out: AutomationLane[] = [];
    for (const [target, pts] of this.map) {
      if (pts.length === 0) continue;
      out.push({
        target,
        points: sortPoints(pts).map((p) => ({ ...p, v: clampParam(target, p.v) })),
      });
    }
    return out.sort((x, y) => x.target.localeCompare(y.target));
  }
}

const dp = (deck: DeckId, p: DeckParam): ParamTarget => `${deck}.${p}` as ParamTarget;

/** Demi-largeur d'une bascule de fader « sèche » (évite le clic d'un saut pur). */
const XFADE_EDGE = 0.003;

/** Bascule sèche autour de t : `from` 1 -> 0, `to` 0 -> 1 (somme de puissance >= 0,5 au milieu). */
function hardSwap(b: LaneBuilder, t: number, from: DeckId | null, to: DeckId | null): void {
  if (from) {
    b.hold(dp(from, 'gain'), t - XFADE_EDGE);
    b.ramp(dp(from, 'gain'), t + XFADE_EDGE, 0);
  }
  if (to) {
    b.hold(dp(to, 'gain'), t - XFADE_EDGE);
    b.ramp(dp(to, 'gain'), t + XFADE_EDGE, 1);
  }
}

function deckNeutral(p: DeckParam): number {
  return DECK_PARAM_SPECS[p].neutral ?? DECK_PARAM_SPECS[p].def;
}

/** Fixe l'état de départ de toutes les tranches (les deux platines) à startCtx. */
function initDecks(b: LaneBuilder, plan: TransitionPlan, incomingStart: Partial<Record<DeckParam, number>>): void {
  for (const p of DECK_PARAMS) {
    if (p === 'trim') continue;
    b.set(dp(plan.from, p), plan.startCtx, deckNeutral(p));
    b.set(dp(plan.to, p), plan.startCtx, incomingStart[p] ?? (p === 'gain' ? 0 : deckNeutral(p)));
  }
}

/**
 * Garantit l'état final : entrante neutre, sortante à gain 0 (et ses autres réglages remis au
 * neutre un temps après, une fois muette), paramètres master touchés revenus au neutre.
 */
function finalize(b: LaneBuilder, plan: TransitionPlan, endT: number, beat: number): void {
  for (const p of DECK_PARAMS) {
    if (p === 'trim') continue;
    const inc = dp(plan.to, p);
    const last = b.last(inc);
    if (!last || Math.abs(last.v - deckNeutral(p)) > 1e-9) {
      b.set(inc, Math.max(endT, last?.t ?? endT), deckNeutral(p));
    }
  }
  const og = dp(plan.from, 'gain');
  const lg = b.last(og);
  if (!lg || lg.v !== 0) b.set(og, Math.max(endT, lg?.t ?? endT), 0);
  const mutedAt = b.last(og)!.t;
  for (const p of DECK_PARAMS) {
    if (p === 'trim' || p === 'gain') continue;
    const t = dp(plan.from, p);
    const last = b.last(t);
    if (last && Math.abs(last.v - deckNeutral(p)) > 1e-9) {
      b.set(t, Math.max(last.t, mutedAt) + beat, deckNeutral(p));
    }
  }
  finalizeMaster(b, endT);
}

function finalizeMaster(b: LaneBuilder, endT: number): void {
  for (const target of b.targets()) {
    if (isDeckTarget(target)) continue;
    const spec = MASTER_PARAM_SPECS[target as MasterParam];
    if (spec.neutral === undefined) continue;
    const last = b.last(target)!;
    if (Math.abs(last.v - spec.neutral) > 1e-9) b.set(target, Math.max(last.t, endT), spec.neutral);
  }
}

/** Arrondit un nombre de temps dans [lo, hi] sur un multiple de `mult`. */
function snapBeats(beats: number, lo: number, hi: number, mult: number): number {
  const v = Math.round((Number.isFinite(beats) ? beats : lo) / mult) * mult;
  return clamp(v, lo, hi);
}

// ---------------------------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------------------------

interface Ctx {
  b: LaneBuilder;
  plan: TransitionPlan;
  beat: number;
  /** instant du temps n depuis startCtx */
  T: (n: number) => number;
  I: number;
  out: DeckId;
  inc: DeckId;
}

type Recipe = (c: Ctx) => number; // renvoie l'instant de fin « musicale » (le 1 d'arrivée)

/** LA transition tech house : longue, invisible, échange des basses net sur un multiple de 8 temps. */
const longBlend: Recipe = ({ b, plan, T, I, out, inc }) => {
  const N = snapBeats(plan.beats, 16, 64, 8);
  const M = clamp(Math.round(N / 2 / 8) * 8, 8, N - 8);   // échange des basses
  const tail = N - M;
  initDecks(b, plan, { eqLow: EQ_KILL_DB, eqMid: -4, eqHigh: -3 });
  // entrant : monte basses coupées, médiums/aigus un peu bas
  b.powerFade(dp(inc, 'gain'), T(0), T(M / 2), 0, 1);
  b.ramp(dp(inc, 'eqHigh'), T(M / 2), -3).ramp(dp(inc, 'eqHigh'), T(M), 0);
  // sortant : aigus qui s'effacent un peu pour laisser la place
  b.hold(dp(out, 'eqHigh'), T(M / 2)).ramp(dp(out, 'eqHigh'), T(M), -6);
  // échange des basses NET, pile sur le temps M (multiple de 8)
  b.set(dp(out, 'eqLow'), T(M), EQ_KILL_DB);
  b.set(dp(inc, 'eqLow'), T(M), 0);
  // ensuite : médiums de l'entrant au neutre, médiums du sortant qui baissent
  b.hold(dp(inc, 'eqMid'), T(M)).ramp(dp(inc, 'eqMid'), T(M + tail / 2), 0, 'smooth');
  b.hold(dp(out, 'eqMid'), T(M)).ramp(dp(out, 'eqMid'), T(M + tail / 2), -10, 'smooth');
  // le sortant redescend
  b.powerFade(dp(out, 'gain'), T(M + tail / 4), T(N), 1, 0);
  // aigus coupés en dernier
  b.hold(dp(out, 'eqHigh'), T(N - tail / 4)).ramp(dp(out, 'eqHigh'), T(N), EQ_KILL_DB);
  if (I > 0.05) {
    b.hold(dp(out, 'filter'), T(M + tail / 2)).ramp(dp(out, 'filter'), T(N), 0.3 * I);
  }
  return T(N);
};

const bassSwap: Recipe = ({ b, plan, T, I, out, inc }) => {
  const N = snapBeats(plan.beats, 8, 16, 4);
  const S = clamp(Math.round(N / 2 / 4) * 4, 4, N - 4);
  initDecks(b, plan, { eqLow: EQ_KILL_DB, eqMid: -3 });
  b.powerFade(dp(inc, 'gain'), T(0), T(S), 0, 1);
  b.set(dp(out, 'eqLow'), T(S), EQ_KILL_DB);
  b.set(dp(inc, 'eqLow'), T(S), 0);
  b.hold(dp(inc, 'eqMid'), T(S)).ramp(dp(inc, 'eqMid'), T(N), 0);
  b.powerFade(dp(out, 'gain'), T(S), T(N), 1, 0);
  if (I > 0.05) b.hold(dp(out, 'filter'), T(S)).ramp(dp(out, 'filter'), T(N), 0.35 * I);
  return T(N);
};

const filterSwap: Recipe = ({ b, plan, T, I, out, inc }) => {
  const N = snapBeats(plan.beats, 8, 32, 4);
  const H = N / 2;
  const depth = 0.6 + 0.3 * I;
  initDecks(b, plan, { filter: -depth });
  b.ramp(dp(out, 'filter'), T(H), depth * 0.6).ramp(dp(out, 'filter'), T(N), depth);
  b.ramp(dp(inc, 'filter'), T(N), 0);
  b.powerFade(dp(inc, 'gain'), T(0), T(H), 0, 1);
  b.powerFade(dp(out, 'gain'), T(H), T(N), 1, 0);
  return T(N);
};

const echoOut: Recipe = ({ b, plan, T, I, beat, out, inc }) => {
  const N = snapBeats(plan.beats, 2, 16, 1);
  const E = T(N);
  const L = T(N - 1);
  const div = I >= 0.66 ? 0.5 : I >= 0.33 ? 0.75 : 1;
  const fb = 0.6 + 0.3 * I;
  initDecks(b, plan, {});
  b.set('fx.echo.time', T(0), div * beat);
  b.set('fx.echo.feedback', T(0), ECHO_FEEDBACK_NEUTRAL).set('fx.echo.feedback', T(N - 2), fb);
  b.set('fx.echo.tone', T(0), 0).set('fx.echo.tone', T(N - 2), -0.25);
  if (N >= 4 && I > 0.3) {
    b.hold(dp(out, 'echoSend'), T(N - 4)).ramp(dp(out, 'echoSend'), L, 0.35 * I);
  }
  b.set(dp(out, 'echoSend'), L, 1);      // 100 % sur le dernier temps
  hardSwap(b, E, out, inc);              // sortant coupé sur le 1, entrant plein sur le 1
  // la queue d'écho vit sa vie, puis on rend le feedback et la tonalité
  b.hold('fx.echo.feedback', E + 4 * beat).ramp('fx.echo.feedback', E + 8 * beat, ECHO_FEEDBACK_NEUTRAL);
  b.hold('fx.echo.tone', E + 4 * beat).ramp('fx.echo.tone', E + 8 * beat, 0);
  return E;
};

const cut: Recipe = ({ b, plan, T, I, beat, out, inc }) => {
  const N = snapBeats(plan.beats, 1, 32, 1);
  const E = T(N);
  initDecks(b, plan, {});
  if (I >= 0.5) {
    // petite queue d'écho d'un demi-temps pour adoucir la coupe
    b.set('fx.echo.time', T(0), beat / 2);
    b.set('fx.echo.feedback', T(0), ECHO_FEEDBACK_NEUTRAL).set('fx.echo.feedback', E - beat / 2, 0.45);
    b.set(dp(out, 'echoSend'), E - beat / 2, 0.8 * I);
    b.hold('fx.echo.feedback', E + 2 * beat).ramp('fx.echo.feedback', E + 4 * beat, ECHO_FEEDBACK_NEUTRAL);
  }
  hardSwap(b, E, out, inc);
  return E;
};

const riserDrop: Recipe = ({ b, plan, T, I, out, inc }) => {
  const N = snapBeats(plan.beats, 4, 32, 4);
  const S = T(N - 1);                      // un temps de silence (ou de queue de réverb)
  const E = T(N);
  const peak = 0.45 + 0.45 * I;
  initDecks(b, plan, {});
  b.shape('fx.noise.gain', T(0), S, (x) => peak * x * x);
  b.ramp('fx.noise.gain', S + 0.03, 0);
  b.set('fx.noise.filter', T(0), 300).ramp('fx.noise.filter', S, 9000, 'exp');
  b.ramp(dp(out, 'filter'), S, 0.6 + 0.3 * I);
  b.hold(dp(out, 'reverbSend'), T(Math.max(0, N - 4))).ramp(dp(out, 'reverbSend'), S, 0.3 + 0.5 * I);
  hardSwap(b, S, out, null);
  hardSwap(b, E, null, inc);
  return E;
};

const reverbWash: Recipe = ({ b, plan, T, I, beat, out, inc }) => {
  const N = snapBeats(plan.beats, 4, 16, 2);
  const H = N / 2;
  const E = T(N);
  initDecks(b, plan, { filter: -0.7, eqLow: EQ_KILL_DB });
  b.ramp(dp(out, 'reverbSend'), T(H), 0.55 + 0.45 * I, 'smooth');
  if (I > 0.5) {
    b.set('fx.reverb.return', T(0), REVERB_RETURN_NEUTRAL).ramp('fx.reverb.return', T(H), 1);
    b.hold('fx.reverb.return', E + 4 * beat).ramp('fx.reverb.return', E + 8 * beat, REVERB_RETURN_NEUTRAL);
  }
  b.hold(dp(out, 'filter'), T(H)).ramp(dp(out, 'filter'), E, 0.25 + 0.2 * I);
  b.powerFade(dp(out, 'gain'), T(H), E, 1, 0);
  b.powerFade(dp(inc, 'gain'), T(H), E, 0, 1);
  b.hold(dp(inc, 'filter'), T(H)).ramp(dp(inc, 'filter'), E, 0, 'smooth');
  b.set(dp(inc, 'eqLow'), E, 0);
  return E;
};

const loopRoll: Recipe = ({ b, plan, T, I, out, inc }) => {
  const N = snapBeats(plan.beats, 2, 16, 2);
  const R = Math.min(N, 8);
  const E = T(N);
  const depth = 0.8 + 0.2 * I;
  initDecks(b, plan, {});
  b.set('fx.gate.depth', T(0), 0).set('fx.gate.depth', T(N - R), depth).set('fx.gate.depth', E, 0);
  b.set('fx.gate.rate', T(N - R), 2).set('fx.gate.rate', T(N - R / 2), 4).set('fx.gate.rate', T(N - R / 4), 8);
  b.hold(dp(out, 'filter'), T(N - R)).ramp(dp(out, 'filter'), E, 0.15 + 0.35 * I);
  if (I > 0.5) {
    b.set('fx.noise.filter', T(N - R), 400).ramp('fx.noise.filter', E, 7000, 'exp');
    b.set('fx.noise.gain', T(N - R), 0).ramp('fx.noise.gain', E, 0.3 * I).ramp('fx.noise.gain', E + 0.03, 0);
  }
  hardSwap(b, E, out, inc);
  return E;
};

/** Nombre de temps occupés par l'arrêt de platine dans la recette brake. */
export function brakeBeats(beats: number): number {
  return Math.min(snapBeats(beats, 1, 8, 1), 2);
}

const brake: Recipe = ({ b, plan, T, I, out, inc }) => {
  const N = snapBeats(plan.beats, 1, 8, 1);
  const Bk = brakeBeats(plan.beats);
  const E = T(N);
  const s = T(N - Bk);
  initDecks(b, plan, {});
  if (I > 0.05) b.set(dp(out, 'reverbSend'), s, 0.5 * I);
  b.shape(dp(out, 'gain'), s, E, (x) => 1 - Math.pow(x, 1.6));
  b.shape(dp(out, 'filter'), s, E, (x) => -0.95 * Math.pow(x, 0.8));
  hardSwap(b, E, null, inc);
  return E;
};

const RECIPES: Record<TransitionPlan['technique'], Recipe> = {
  'long-blend': longBlend,
  'bass-swap': bassSwap,
  'filter-swap': filterSwap,
  'echo-out': echoOut,
  cut,
  'riser-drop': riserDrop,
  'reverb-wash': reverbWash,
  'loop-roll': loopRoll,
  brake,
};

/** Convertit un plan de transition en lanes d'automation (recette de base, sans les accents). */
export function planToAutomation(plan: TransitionPlan): AutomationLane[] {
  const bpm = clamp(Number.isFinite(plan.bpm) ? plan.bpm : 120, 40, 250);
  const beat = 60 / bpm;
  const b = new LaneBuilder();
  const recipe = RECIPES[plan.technique] ?? longBlend;
  const from = plan.from;
  const to = plan.to === from ? (from === 'A' ? 'B' : 'A') : plan.to;
  const p: TransitionPlan = { ...plan, to, bpm };
  const ctx: Ctx = {
    b, plan: p, beat,
    T: (n) => plan.startCtx + n * beat,
    I: clamp(Number.isFinite(plan.intensity) ? plan.intensity : 0.5, 0, 1),
    out: from, inc: to,
  };
  const endT = recipe(ctx);
  finalize(b, p, endT, beat);
  return b.build();
}

// ---------------------------------------------------------------------------------------------
// Effets ponctuels
// ---------------------------------------------------------------------------------------------

/** Temps d'écho en divisions du temps : 1/2 pour un coup court, 3/4 classique, 1 temps pour long. */
export function echoDivision(beats: number): number {
  if (beats <= 1) return 0.5;
  if (beats <= 2) return 0.75;
  return 1;
}

export function fxToAutomation(cue: FxCue): AutomationLane[] {
  const bpm = clamp(Number.isFinite(cue.bpm) ? cue.bpm : 120, 40, 250);
  const beat = 60 / bpm;
  const A = clamp(Number.isFinite(cue.amount) ? cue.amount : 0.5, 0, 1);
  const N = Math.max(0.25, Number.isFinite(cue.beats) ? cue.beats : 1);
  const t0 = cue.atCtx;
  const t1 = t0 + N * beat;
  const decks: DeckId[] = cue.target === 'master' ? ['A', 'B'] : [cue.target];
  const b = new LaneBuilder();

  switch (cue.kind) {
    case 'echo-throw': {
      b.set('fx.echo.time', t0, echoDivision(N) * beat);
      b.set('fx.echo.feedback', t0, ECHO_FEEDBACK_NEUTRAL + 0.4 * A);
      b.set('fx.echo.tone', t0, -0.3);
      for (const d of decks) {
        b.set(dp(d, 'echoSend'), t0, 0).ramp(dp(d, 'echoSend'), t0 + 0.01, 0.4 + 0.6 * A);
        b.hold(dp(d, 'echoSend'), t1 - 0.02).ramp(dp(d, 'echoSend'), t1, 0);
      }
      b.hold('fx.echo.feedback', t1).ramp('fx.echo.feedback', t1 + 4 * beat, ECHO_FEEDBACK_NEUTRAL);
      b.hold('fx.echo.tone', t1).ramp('fx.echo.tone', t1 + 4 * beat, 0);
      break;
    }
    case 'reverb-throw': {
      for (const d of decks) {
        b.set(dp(d, 'reverbSend'), t0, 0).ramp(dp(d, 'reverbSend'), t0 + 0.01, 0.5 + 0.5 * A);
        b.hold(dp(d, 'reverbSend'), t1 - 0.03).ramp(dp(d, 'reverbSend'), t1, 0);
      }
      break;
    }
    case 'filter-sweep': {
      const tgt: ParamTarget[] = cue.target === 'master' ? ['master.filter'] : [dp(cue.target, 'filter')];
      for (const t of tgt) b.set(t, t0, 0).ramp(t, t1, 0.4 + 0.5 * A).set(t, t1 + 1e-3, 0);
      break;
    }
    case 'low-cut': {
      // coupe des basses puis retour PILE sur le 1 (t1)
      if (cue.target === 'master') {
        b.set('master.filter', t0, 0).set('master.filter', t0 + 1e-3, 0.38).set('master.filter', t1, 0);
      } else {
        const t = dp(cue.target, 'eqLow');
        b.set(t, t0, 0).set(t, t0 + 1e-3, EQ_KILL_DB).set(t, t1, 0);
      }
      break;
    }
    case 'riser': {
      b.shape('fx.noise.gain', t0, t1, (x) => (0.3 + 0.6 * A) * x * x);
      b.ramp('fx.noise.gain', t1 + 0.03, 0);
      b.set('fx.noise.filter', t0, 300).ramp('fx.noise.filter', t1, 8000, 'exp');
      break;
    }
    case 'impact': {
      const peak = 0.3 + 0.5 * A;
      b.set('fx.noise.gain', t0, 0).ramp('fx.noise.gain', t0 + 0.005, peak);
      b.shape('fx.noise.gain', t0 + 0.005, t1, (x) => peak * Math.pow(1 - x, 2.5));
      b.set('fx.noise.filter', t0, 6000).ramp('fx.noise.filter', t1, 200, 'exp');
      break;
    }
    case 'gate': {
      b.set('fx.gate.rate', t0, A < 0.5 ? 2 : 4);
      b.set('fx.gate.depth', t0, 0).set('fx.gate.depth', t0 + 1e-3, 0.6 + 0.4 * A).set('fx.gate.depth', t1, 0);
      break;
    }
    case 'brake': {
      if (cue.target === 'master') {
        b.shape('master.gain', t0, t1, (x) => 1 - Math.pow(x, 1.6));
        b.shape('master.filter', t0, t1, (x) => -0.95 * Math.pow(x, 0.8));
        b.set('master.gain', t1, 0).ramp('master.gain', t1 + XFADE_EDGE * 2, 1);
        b.set('master.filter', t1, 0);
      } else {
        const g = dp(cue.target, 'gain');
        const f = dp(cue.target, 'filter');
        b.shape(g, t0, t1, (x) => 1 - Math.pow(x, 1.6));
        b.shape(f, t0, t1, (x) => -0.95 * Math.pow(x, 0.8));
        // la platine repart sur le 1
        b.ramp(g, t1 + XFADE_EDGE * 2, 1);
        b.set(f, t1, 0);
      }
      break;
    }
  }
  finalizeMaster(b, t1);
  return b.build();
}

// ---------------------------------------------------------------------------------------------
// Fusion recette + accents
// ---------------------------------------------------------------------------------------------

/**
 * Fusionne des lanes : pour une même cible, la lane de base est prioritaire ; les points des
 * lanes ajoutées qui tombent dans la fenêtre [premier, dernier] de la base sont ignorés.
 */
export function mergeLanes(base: AutomationLane[], extra: AutomationLane[]): AutomationLane[] {
  const map = new Map<ParamTarget, AutomationPoint[]>();
  for (const l of base) map.set(l.target, [...(map.get(l.target) ?? []), ...l.points]);
  for (const l of extra) {
    const cur = map.get(l.target);
    if (!cur || cur.length === 0) {
      map.set(l.target, [...l.points]);
      continue;
    }
    const sorted = sortPoints(cur);
    const lo = sorted[0].t;
    const hi = sorted[sorted.length - 1].t;
    const keep = l.points.filter((p) => p.t < lo || p.t > hi);
    if (keep.length) {
      // un point isolé avant/après la base doit être un saut net, pas une rampe vers la base
      map.set(l.target, [...cur, ...keep.map((p, i) => (i === 0 ? { ...p, curve: 'step' as Curve } : p))]);
    }
  }
  return [...map.entries()]
    .map(([target, pts]) => ({ target, points: sortPoints(pts) }))
    .sort((x, y) => x.target.localeCompare(y.target));
}

/** Recette + accents du cerveau, prêtes à programmer. */
export function transitionLanes(plan: TransitionPlan): AutomationLane[] {
  let lanes = planToAutomation(plan);
  for (const cue of plan.accents ?? []) lanes = mergeLanes(lanes, fxToAutomation(cue));
  return lanes;
}
