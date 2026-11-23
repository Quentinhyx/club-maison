/**
 * Tests des recettes (pur, sans Web Audio). Lancer : npx tsx shared/audio/recipes.test.ts
 */
import assert from 'node:assert/strict';
import type {
  AutomationLane, Camelot, DeckId, FxCue, FxKind, GroovePlan, GrooveStyle, ParamTarget, TransitionPlan,
  TransitionTechnique,
} from '../contracts';
import { camelotRootMidi, grooveSchedule, retimeGroove } from './groove';
import {
  LOOP_WORKLET_SRC, LoopCore, fxLoopActions, loopRollSchedule, loopWindow, microFade, transitionLoopActions,
} from './loop';
import {
  DECK_PARAMS, DECK_PARAM_SPECS, EQ_KILL_DB, MASTER_PARAM_SPECS, djFilterToNodes, interp,
  isDeckTarget, paramSpec, renderGate, valueAt,
} from './params';
import { brakeBeats, fxToAutomation, planToAutomation, transitionLanes } from './recipes';
import { phaseNudge, rateRamp, tempoMatchRate } from './sync';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${(e as Error).message.split('\n').join('\n       ')}`);
  }
}

const TECHNIQUES: TransitionTechnique[] = [
  'long-blend', 'bass-swap', 'filter-swap', 'echo-out', 'cut', 'riser-drop', 'reverb-wash', 'loop-roll', 'brake',
];
const BLENDS = new Set<TransitionTechnique>(['long-blend', 'bass-swap', 'filter-swap', 'reverb-wash']);
const FX_KINDS: FxKind[] = ['echo-throw', 'reverb-throw', 'filter-sweep', 'low-cut', 'riser', 'impact', 'gate', 'brake', 'loop-roll'];

function mkPlan(technique: TransitionTechnique, o: Partial<TransitionPlan> = {}): TransitionPlan {
  return {
    id: 't1', from: 'A', to: 'B', technique, startCtx: 100, beats: 32, bpm: 126,
    incomingStartCtx: 100, incomingStartPos: 30, incomingRate: 1, accents: [], intensity: 0.5,
    reason: 'test', ...o,
  };
}

const lane = (lanes: AutomationLane[], t: ParamTarget) => lanes.find((l) => l.target === t);
const val = (lanes: AutomationLane[], t: ParamTarget, at: number, def: number) => {
  const l = lane(lanes, t);
  return l ? valueAt(l, at)! : def;
};
const lastV = (l: AutomationLane) => l.points[l.points.length - 1].v;
const endOf = (lanes: AutomationLane[]) => Math.max(...lanes.flatMap((l) => l.points.map((p) => p.t)));

/** Puissance estimée d'une tranche : gain² × énergie des bandes (EQ + filtre), mix tech house type. */
function deckPower(lanes: AutomationLane[], d: DeckId, t: number, nyq = 24000): number {
  const g = val(lanes, `${d}.gain`, t, 1);
  const bands = [
    { w: 0.5, hz: 60, db: val(lanes, `${d}.eqLow`, t, 0) },
    { w: 0.3, hz: 1000, db: val(lanes, `${d}.eqMid`, t, 0) },
    { w: 0.2, hz: 8000, db: val(lanes, `${d}.eqHigh`, t, 0) },
  ];
  const f = djFilterToNodes(val(lanes, `${d}.filter`, t, 0), nyq);
  let p = 0;
  for (const b of bands) {
    let a = Math.pow(10, b.db / 10);
    if (b.hz > f.lpHz) a *= Math.pow(f.lpHz / b.hz, 4);
    if (f.hpHz > 0 && b.hz < f.hpHz) a *= Math.pow(b.hz / f.hpHz, 4);
    p += b.w * a;
  }
  return g * g * p;
}

function checkStructure(lanes: AutomationLane[], minT: number, label: string): void {
  assert.ok(lanes.length > 0, `${label} : aucune lane`);
  const seen = new Set<string>();
  for (const l of lanes) {
    assert.ok(!seen.has(l.target), `${label} : cible ${l.target} en double`);
    seen.add(l.target);
    assert.ok(l.points.length > 0, `${label} : lane ${l.target} vide`);
    const spec = paramSpec(l.target);
    for (let i = 0; i < l.points.length; i++) {
      const p = l.points[i];
      assert.ok(Number.isFinite(p.t) && Number.isFinite(p.v), `${label} : ${l.target} point non fini`);
      assert.ok(p.t >= minT - 1e-9, `${label} : ${l.target} point avant le début (${p.t} < ${minT})`);
      assert.ok(p.v >= spec.min - 1e-9 && p.v <= spec.max + 1e-9, `${label} : ${l.target}=${p.v} hors [${spec.min}, ${spec.max}]`);
      if (i > 0) assert.ok(p.t >= l.points[i - 1].t, `${label} : ${l.target} non trié à l'index ${i}`);
    }
  }
}

function checkFinalNeutral(lanes: AutomationLane[], plan: TransitionPlan, label: string): void {
  for (const p of DECK_PARAMS) {
    if (p === 'trim') continue;
    const l = lane(lanes, `${plan.to}.${p}`);
    assert.ok(l, `${label} : entrante ${plan.to}.${p} non fixée`);
    assert.equal(lastV(l!), DECK_PARAM_SPECS[p].neutral, `${label} : entrante ${p} finit à ${lastV(l!)}`);
    const o = lane(lanes, `${plan.from}.${p}`);
    if (p === 'gain') assert.equal(o && lastV(o), 0, `${label} : sortante gain final != 0`);
    else if (o) assert.equal(lastV(o), DECK_PARAM_SPECS[p].neutral, `${label} : sortante ${p} finit à ${lastV(o)}`);
  }
  for (const l of lanes) {
    if (isDeckTarget(l.target)) continue;
    const n = MASTER_PARAM_SPECS[l.target as keyof typeof MASTER_PARAM_SPECS].neutral;
    if (n !== undefined) assert.ok(Math.abs(lastV(l) - n) < 1e-9, `${label} : ${l.target} finit à ${lastV(l)} (neutre ${n})`);
  }
}

/** Fenêtre de silence voulue par la recette (drop), en ctx. */
function gapWindow(plan: TransitionPlan, beatsUsed: number): [number, number] | null {
  const beat = 60 / plan.bpm;
  const E = plan.startCtx + beatsUsed * beat;
  if (plan.technique === 'riser-drop') return [E - beat, E];
  if (plan.technique === 'brake') return [E - brakeBeats(plan.beats) * beat, E];
  return null;
}

/** Instant du 1 d'arrivée : quand le gain de l'entrante atteint 1 pour la dernière fois. */
function arrival(lanes: AutomationLane[], plan: TransitionPlan): number {
  const l = lane(lanes, `${plan.to}.gain`)!;
  const firstFull = l.points.find((p) => p.v >= 1 - 1e-9)!;
  return firstFull.t;
}

console.log('\nRecettes de transition');
const VARIANTS = [
  { beats: 32, intensity: 0.5, bpm: 126, from: 'A' as DeckId },
  { beats: 16, intensity: 0, bpm: 124, from: 'B' as DeckId },
  { beats: 64, intensity: 1, bpm: 128, from: 'A' as DeckId },
  { beats: 8, intensity: 0.8, bpm: 95, from: 'B' as DeckId },
  { beats: 4, intensity: 0.3, bpm: 140, from: 'A' as DeckId },
  { beats: 3, intensity: 0.66, bpm: 172, from: 'B' as DeckId },
];

for (const tech of TECHNIQUES) {
  test(`${tech} : lanes triées, bornées, rien avant startCtx, état final neutre`, () => {
    for (const v of VARIANTS) {
      const plan = mkPlan(tech, { ...v, to: v.from === 'A' ? 'B' : 'A', startCtx: 50 + v.bpm });
      const lanes = planToAutomation(plan);
      const label = `${tech} ${v.beats}t I=${v.intensity}`;
      checkStructure(lanes, plan.startCtx, label);
      checkFinalNeutral(lanes, plan, label);
    }
  });

  test(`${tech} : pas de trou de volume ni de surcharge`, () => {
    for (const v of VARIANTS) {
      const plan = mkPlan(tech, { ...v, to: v.from === 'A' ? 'B' : 'A' });
      const lanes = planToAutomation(plan);
      const beat = 60 / plan.bpm;
      const E = arrival(lanes, plan);
      const used = Math.round((E - plan.startCtx) / beat);
      const gap = BLENDS.has(tech) ? null : gapWindow(plan, used);
      const end = endOf(lanes);
      for (let t = plan.startCtx; t <= end; t += 0.0005) {
        const gA = val(lanes, 'A.gain', t, 1);
        const gB = val(lanes, 'B.gain', t, 1);
        const pw = gA * gA + gB * gB;
        if (!(gap && t > gap[0] - 0.01 && t < gap[1] + 0.01)) {
          assert.ok(pw >= 0.5 - 1e-6, `${tech} ${v.beats}t : trou de volume à t=${t.toFixed(3)} (gA=${gA.toFixed(3)}, gB=${gB.toFixed(3)})`);
        }
        const est = deckPower(lanes, 'A', t) + deckPower(lanes, 'B', t);
        assert.ok(est <= 1.6, `${tech} ${v.beats}t : surcharge estimée ${est.toFixed(2)} à t=${t.toFixed(3)}`);
      }
    }
  });
}

test('long-blend : échange des basses net, sur un temps entier multiple de 8', () => {
  for (const beats of [16, 24, 32, 48, 64]) {
    const plan = mkPlan('long-blend', { beats, startCtx: 12.345 });
    const lanes = planToAutomation(plan);
    const beat = 60 / plan.bpm;
    const inLow = lane(lanes, 'B.eqLow')!;
    const outLow = lane(lanes, 'A.eqLow')!;
    const upIn = inLow.points.find((p) => p.v === 0 && p.t > plan.startCtx)!;
    const downOut = outLow.points.find((p) => p.v === EQ_KILL_DB)!;
    assert.equal(upIn.curve, 'step', 'échange des basses entrante non net');
    assert.equal(downOut.curve, 'step', 'échange des basses sortante non net');
    assert.ok(Math.abs(upIn.t - downOut.t) < 1e-9, 'les deux basses ne basculent pas au même instant');
    const n = (upIn.t - plan.startCtx) / beat;
    assert.ok(Math.abs(n - Math.round(n)) < 1e-6, `échange à ${n} temps (pas entier)`);
    assert.equal(Math.round(n) % 8, 0, `échange à ${n} temps (pas multiple de 8)`);
    assert.ok(n > 0 && n < beats, 'échange hors de la transition');
    // l'entrant monte basses coupées
    assert.equal(valueAt(inLow, plan.startCtx + 1)!, EQ_KILL_DB);
    // aigus du sortant coupés en dernier
    const outHigh = lane(lanes, 'A.eqHigh')!;
    assert.equal(lastV(outHigh), 0);
    const kill = outHigh.points.find((p) => p.v === EQ_KILL_DB)!;
    assert.ok(Math.abs(kill.t - (plan.startCtx + beats * beat)) < 1e-6, 'aigus du sortant pas coupés à la fin');
  }
});

test('bass-swap : échange sur un temps entier multiple de 4', () => {
  for (const beats of [8, 12, 16]) {
    const plan = mkPlan('bass-swap', { beats, startCtx: 3.21, bpm: 122 });
    const lanes = planToAutomation(plan);
    const beat = 60 / plan.bpm;
    const up = lane(lanes, 'B.eqLow')!.points.find((p) => p.v === 0 && p.t > plan.startCtx)!;
    const n = (up.t - plan.startCtx) / beat;
    assert.ok(Math.abs(n - Math.round(n)) < 1e-6 && Math.round(n) % 4 === 0, `échange à ${n} temps`);
  }
});

test('echo-out : envoi 100 % sur le dernier temps, coupe du sortant et entrant plein sur le 1', () => {
  const plan = mkPlan('echo-out', { beats: 8, intensity: 0.9 });
  const lanes = planToAutomation(plan);
  const beat = 60 / plan.bpm;
  const E = plan.startCtx + 8 * beat;
  assert.equal(val(lanes, 'A.echoSend', E - beat / 2, 0), 1);
  assert.ok(val(lanes, 'fx.echo.feedback', E - beat / 2, 0) >= 0.8, 'feedback pas assez élevé');
  assert.ok(val(lanes, 'A.gain', E - 0.01, 0) === 1 && val(lanes, 'A.gain', E + 0.01, 1) === 0);
  assert.ok(val(lanes, 'B.gain', E - 0.01, 1) === 0 && val(lanes, 'B.gain', E + 0.01, 0) === 1);
  const time = lane(lanes, 'fx.echo.time')!.points[0].v;
  const div = time / beat;
  assert.ok([0.5, 0.75, 1].some((d) => Math.abs(d - div) < 1e-9), `temps d'écho ${div} temps`);
});

test('riser-drop : un temps de silence puis entrant sur le 1, bruit coupé au silence', () => {
  const plan = mkPlan('riser-drop', { beats: 16, intensity: 0.7 });
  const lanes = planToAutomation(plan);
  const beat = 60 / plan.bpm;
  const E = plan.startCtx + 16 * beat;
  assert.equal(val(lanes, 'A.gain', E - beat / 2, 1), 0);
  assert.equal(val(lanes, 'B.gain', E - beat / 2, 1), 0);
  assert.equal(val(lanes, 'B.gain', E + 0.01, 0), 1);
  assert.ok(val(lanes, 'fx.noise.gain', E - beat - 0.05, 0) > 0.5, 'riser trop faible');
  assert.equal(val(lanes, 'fx.noise.gain', E - beat / 2, 1), 0);
  assert.ok(val(lanes, 'A.reverbSend', E - beat - 0.01, 0) > 0.3, 'pas de queue de réverb');
});

test('loop-roll (transition) : vraie boucle du sortant qui accélère, passe-haut, entrant plein sur le 1', () => {
  for (const beats of [8, 16, 4]) {
    const plan = mkPlan('loop-roll', { beats, intensity: 0.7 });
    const lanes = planToAutomation(plan);
    const beat = 60 / plan.bpm;
    const E = plan.startCtx + beats * beat;
    const acts = transitionLoopActions(plan);
    const R = Math.min(beats, 8);
    assert.equal(acts[0].action, 'hold');
    assert.ok(Math.abs(acts[0].t - (E - R * beat)) < 1e-9, 'le roll ne démarre pas R temps avant le 1');
    const lens = acts.filter((x) => x.action !== 'release').map((x) => (x as { beats: number }).beats);
    assert.deepEqual(lens, [1, 0.5, 0.25, 0.125].slice(0, lens.length));
    assert.ok(lens.length >= 3, `roll trop court : ${lens}`);
    const rel = acts[acts.length - 1];
    assert.equal(rel.action, 'release');
    assert.ok(rel.t > E && rel.t < E + 0.1, 'relâche pas juste après le 1');
    assert.ok(val(lanes, 'A.filter', E - 0.001, 0) > 0.4, 'pas de passe-haut');
    assert.ok(val(lanes, 'A.echoSend', E - beat / 2, 0) > 0.3, "pas d'écho à la fin");
    assert.equal(val(lanes, 'B.gain', E + 0.01, 0), 1);
    assert.equal(val(lanes, 'A.gain', E + 0.01, 1), 0);
    assert.ok(!lane(lanes, 'fx.gate.depth'), 'le gate ne doit plus servir au roll');
  }
});

test('brake : fader qui tombe et passe-bas qui se ferme', () => {
  const plan = mkPlan('brake', { beats: 4 });
  const lanes = planToAutomation(plan);
  const beat = 60 / plan.bpm;
  const E = plan.startCtx + 4 * beat;
  assert.ok(val(lanes, 'A.filter', E - 0.001, 0) < -0.9);
  assert.ok(val(lanes, 'A.gain', E - beat, 0) < 1 && val(lanes, 'A.gain', E - 0.001, 1) < 0.01);
  assert.equal(val(lanes, 'B.gain', E + 0.01, 0), 1);
});

test('accents fusionnés : toujours triés, bornés, état final neutre', () => {
  const beat = 60 / 126;
  const accents: FxCue[] = [
    { kind: 'echo-throw', target: 'A', atCtx: 100 + 12 * beat, beats: 2, bpm: 126, amount: 0.6 },
    { kind: 'riser', target: 'master', atCtx: 100 + 8 * beat, beats: 8, bpm: 126, amount: 0.5 },
    { kind: 'low-cut', target: 'B', atCtx: 100, beats: 4, bpm: 126, amount: 1 }, // en conflit : ignoré
  ];
  const plan = mkPlan('long-blend', { accents });
  const lanes = transitionLanes(plan);
  checkStructure(lanes, plan.startCtx, 'long-blend + accents');
  checkFinalNeutral(lanes, plan, 'long-blend + accents');
  assert.ok(lane(lanes, 'fx.noise.gain'), 'le riser a disparu');
  assert.equal(val(lanes, 'B.eqLow', 100 + 2 * beat, 0), EQ_KILL_DB, "l'accent a cassé la recette");
});

console.log('\nEffets ponctuels');
for (const kind of FX_KINDS) {
  test(`${kind} : trié, borné, rien avant atCtx, retour au neutre`, () => {
    for (const target of ['A', 'B', 'master'] as const) {
      for (const amount of [0, 0.5, 1]) {
        for (const beats of [1, 2, 4, 8]) {
          const cue: FxCue = { kind, target, atCtx: 42, beats, bpm: 128, amount };
          const lanes = fxToAutomation(cue);
          const label = `${kind}/${target} A=${amount} ${beats}t`;
          checkStructure(lanes, cue.atCtx, label);
          for (const l of lanes) {
            const n = paramSpec(l.target).neutral;
            if (n !== undefined) assert.ok(Math.abs(lastV(l) - n) < 1e-9, `${label} : ${l.target} finit à ${lastV(l)}`);
          }
          if (kind === 'echo-throw') {
            const time = lane(lanes, 'fx.echo.time')!.points[0].v / (60 / 128);
            assert.ok([0.5, 0.75, 1].some((d) => Math.abs(d - time) < 1e-9), `${label} : écho ${time} temps`);
          }
        }
      }
    }
  });
}

test('low-cut revient pile sur le 1', () => {
  const cue: FxCue = { kind: 'low-cut', target: 'A', atCtx: 10, beats: 4, bpm: 120, amount: 1 };
  const l = lane(fxToAutomation(cue), 'A.eqLow')!;
  const back = l.points[l.points.length - 1];
  assert.equal(back.curve, 'step');
  assert.ok(Math.abs(back.t - 12) < 1e-9, `retour à ${back.t}, attendu 12`);
  assert.equal(valueAt(l, 11.99), EQ_KILL_DB);
});

console.log('\nCalage tempo / phase');
test('tempoMatchRate : 64/128, 128/64, 125->128, hors limites', () => {
  assert.equal(tempoMatchRate(64, 128, 0.08), 1);
  assert.equal(tempoMatchRate(128, 64, 0.08), 1);
  assert.ok(Math.abs(tempoMatchRate(125, 128, 0.08)! - 1.024) < 1e-9);
  assert.ok(Math.abs(tempoMatchRate(65, 128, 0.08)! - 128 / 130) < 1e-9);
  assert.equal(tempoMatchRate(100, 128, 0.08), null);
  assert.equal(tempoMatchRate(0, 128, 0.08), null);
});

test('phaseNudge : erreur ramenée dans [-0.5, 0.5], signe, bornes', () => {
  const beat = 60 / 128;
  const r1 = phaseNudge({ bpm: 128, refDownbeatCtx: 10, deckDownbeatCtx: 10 + 3.25 * beat, nowCtx: 11, maxDelta: 0.02, currentRate: 1 });
  assert.ok(Math.abs(r1.errorBeats - 0.25) < 1e-9);
  assert.ok(r1.rate > 1 && r1.rate <= 1.02 + 1e-12, 'platine en retard : doit accélérer');
  const r2 = phaseNudge({ bpm: 128, refDownbeatCtx: 10, deckDownbeatCtx: 10 + 0.8 * beat, nowCtx: 11, maxDelta: 0.02, currentRate: 1.01 });
  assert.ok(Math.abs(r2.errorBeats + 0.2) < 1e-9);
  assert.ok(r2.rate < 1.01, 'platine en avance : doit ralentir');
  const r3 = phaseNudge({ bpm: 128, refDownbeatCtx: 10, deckDownbeatCtx: 10.001, nowCtx: 11, maxDelta: 0.02, currentRate: 1 });
  assert.equal(r3.rate, 1, 'zone morte');
});

test('phaseNudge : convergence sans oscillation (simulation 10 Hz)', () => {
  for (const start of [0.45, -0.3, 0.1]) {
    const bpm = 126;
    const beat = 60 / bpm;
    const base = 1.016; // rate de calage du tempo
    let err = start;    // en temps
    let prevSign = Math.sign(err);
    let t = 0;
    for (let i = 0; i < 400; i++) {
      t += 0.1;
      const r = phaseNudge({ bpm, refDownbeatCtx: 1000, deckDownbeatCtx: 1000 + err * beat, nowCtx: 1000 + 0.5, maxDelta: 0.03, currentRate: base });
      assert.ok(Math.abs(r.rate - base) <= 0.03 + 1e-12, 'correction hors borne');
      // la platine avance de (rate/base - 1) temps de référence par temps écoulé
      err -= (r.rate / base - 1) * (bpm / 60) * 0.1;
      const s = Math.sign(err);
      assert.ok(Math.abs(err) < 0.02 || s === prevSign || s === 0, `oscillation (départ ${start}, pas ${i}, erreur ${err})`);
      prevSign = s || prevSign;
    }
    assert.ok(Math.abs(err) < 0.012, `pas convergé (départ ${start}) : erreur ${err.toFixed(4)} temps`);
  }
});

console.log('\nOutils');
test('renderGate : impulsions entre 1 - depth et 1, calées sur la division', () => {
  const pts = renderGate([{ t: 0, v: 0.8 }], [{ t: 0, v: 4 }], 120, 0, 2);
  for (const p of pts) assert.ok(p.v >= 0.2 - 1e-9 && p.v <= 1 + 1e-9);
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i].t >= pts[i - 1].t);
  // 120 BPM, 1/4 de temps = 0,125 s : fermé au milieu de chaque division
  const closed = pts.filter((p) => p.v < 0.5).length;
  assert.ok(closed >= 2 * 16 - 2, `trop peu de fermetures (${closed})`);
});

test('interp : courbe en S monotone, exp positive', () => {
  let prev = -Infinity;
  for (let x = 0; x <= 1; x += 0.05) {
    const v = interp('smooth', 0, 1, x);
    assert.ok(v >= prev);
    prev = v;
  }
  assert.ok(Math.abs(interp('exp', 100, 10000, 0.5) - 1000) < 1e-6);
  assert.equal(interp('step', 0, 1, 0.99), 0);
});

test('filtre DJ : neutre = identité (LP à Nyquist, HP à 0), mapping exponentiel', () => {
  const n = djFilterToNodes(0, 24000);
  assert.equal(n.lpHz, 24000);
  assert.equal(n.hpHz, 0);
  assert.ok(Math.abs(djFilterToNodes(-1, 24000).lpHz - 80) < 1e-6);
  assert.ok(Math.abs(djFilterToNodes(1, 24000).hpHz - 6000) < 1e-6);
  const half = djFilterToNodes(-0.5, 24000).lpHz;
  assert.ok(half > 1000 && half < 1600, `LP à -0.5 : ${half} Hz`);
});


console.log('\nGroove (re-edit)');
const STYLES: GrooveStyle[] = ['house', 'tech-house', 'disco', 'afro-house', 'techno'];
function mkGroove(o: Partial<GroovePlan> = {}): GroovePlan {
  return {
    style: 'house', bpm: 124, anchorCtx: 10, key: '8A', bass: true,
    parts: ['kick', 'clap', 'hat', 'openhat', 'perc'], startCtx: 10 + 16 * (60 / 124),
    fadeBeats: 8, sourceLowCutDb: -12, deck: 'A', ...o,
  };
}

test('camelotRootMidi : 8A -> la, 8B -> do, registre de basse', () => {
  assert.equal(camelotRootMidi('8A') % 12, 9);
  assert.equal(camelotRootMidi('8B') % 12, 0);
  assert.equal(camelotRootMidi('5A') % 12, 0);
  assert.equal(camelotRootMidi('1A') % 12, 8);
  assert.equal(camelotRootMidi('12B') % 12, 4);
  for (let n = 1; n <= 12; n++) {
    for (const m of ['A', 'B']) {
      const v = camelotRootMidi(`${n}${m}` as Camelot);
      assert.ok(v >= 28 && v <= 39, `${n}${m} -> ${v}`);
    }
  }
  // relatif mineur / majeur : même numéro = même armure, la tonique majeure est 3 demi-tons au-dessus
  for (let n = 1; n <= 12; n++) {
    const a = camelotRootMidi(`${n}A` as Camelot) % 12;
    const b = camelotRootMidi(`${n}B` as Camelot) % 12;
    assert.equal((a + 3) % 12, b, `${n}A / ${n}B`);
  }
});

test('grooveSchedule : sur la grille, rien avant startCtx, trié, vélocités valides', () => {
  for (const style of STYLES) {
    const plan = mkGroove({ style, parts: ['kick', 'clap', 'hat', 'openhat', 'perc', 'bass'] });
    const step = 60 / plan.bpm / 4;
    const evs = grooveSchedule(plan, 0, plan.startCtx + 32 * 4 * step);
    assert.ok(evs.length > 0, style);
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      assert.ok(e.t >= plan.startCtx - 1e-9, `${style} : événement avant startCtx`);
      if (i > 0) assert.ok(e.t >= evs[i - 1].t, `${style} : non trié`);
      assert.ok(e.velocity > 0 && e.velocity <= 1, `${style} : vélocité ${e.velocity}`);
      const k = (e.t - plan.anchorCtx) / step;
      const off = k - Math.round(k);
      if (e.part === 'hat' || e.part === 'perc') assert.ok(off >= -1e-6 && off < 0.2, `${style} ${e.part} hors grille (${off})`);
      else assert.ok(Math.abs(off) < 1e-6, `${style} ${e.part} hors grille (${off})`);
    }
  }
});

test('house : kick sur chaque temps, clap sur 2 et 4, basse en la pour 8A', () => {
  const plan = mkGroove({ startCtx: 10 });
  const beat = 60 / plan.bpm;
  const evs = grooveSchedule(plan, 10, 10 + 16 * beat);
  const kicks = evs.filter((e) => e.part === 'kick');
  assert.equal(kicks.length, 16);
  kicks.forEach((k, i) => assert.ok(Math.abs(k.t - (10 + i * beat)) < 1e-9, `kick ${i}`));
  const claps = evs.filter((e) => e.part === 'clap');
  assert.equal(claps.length, 8);
  for (const c of claps) {
    const n = Math.round((c.t - 10) / beat) % 4; // 0 = temps 1
    assert.ok(n === 1 || n === 3, `clap sur le temps ${n + 1}`);
  }
  const bass = evs.filter((e) => e.part === 'bass');
  assert.ok(bass.length > 0, 'pas de basse');
  for (const b of bass) assert.equal((b.note! - camelotRootMidi('8A')) % 12, 0, 'basse hors tonique (la)');
  assert.equal(camelotRootMidi('8A') % 12, 9);
  // sans plan.bass ou sans tonalité : pas de basse
  assert.ok(!grooveSchedule({ ...plan, bass: false }, 10, 20).some((e) => e.part === 'bass'));
  assert.ok(!grooveSchedule({ ...plan, key: undefined }, 10, 20).some((e) => e.part === 'bass'));
  // seulement les parties demandées
  const only = grooveSchedule({ ...plan, parts: ['kick'], bass: false }, 10, 20);
  assert.ok(only.every((e) => e.part === 'kick'));
});

test('grooveSchedule : fenêtres contiguës = ni doublon ni trou (planificateur 25 ms)', () => {
  const plan = mkGroove({ style: 'tech-house', parts: ['kick', 'clap', 'hat', 'openhat', 'perc'] });
  const whole = grooveSchedule(plan, 0, 30);
  const chunks: typeof whole = [];
  for (let t = 0; t < 30; t += 0.025) chunks.push(...grooveSchedule(plan, t, Math.min(30, t + 0.025)));
  assert.equal(chunks.length, whole.length);
  chunks.sort((a, b) => a.t - b.t || a.part.localeCompare(b.part));
  const w = [...whole].sort((a, b) => a.t - b.t || a.part.localeCompare(b.part));
  w.forEach((e, i) => assert.ok(Math.abs(e.t - chunks[i].t) < 1e-9 && e.part === chunks[i].part));
});

test('changement de bpm / phase : ni doublon ni trou de kick', () => {
  const cases = [
    { bpm: 126, shift: 0 }, { bpm: 122, shift: 0.03 }, { bpm: 124, shift: -0.05 },
    { bpm: 124, shift: 0.24 }, { bpm: 130, shift: 0.4 }, { bpm: 118, shift: -0.2 },
  ];
  for (const c of cases) {
    const plan = mkGroove({ startCtx: 10 });
    const after = 17.3;
    const newAnchor = plan.anchorCtx + c.shift;
    const r = retimeGroove(plan, c.bpm, newAnchor, after);
    assert.ok(r.switchCtx >= after - 1e-9, 'bascule dans le passé');
    const oldBeat = 60 / plan.bpm;
    const evs = [
      ...grooveSchedule(plan, 10, r.switchCtx),
      ...grooveSchedule(r.plan, r.switchCtx, 40),
    ].sort((a, b) => a.t - b.t);
    const ks = evs.filter((e) => e.part === 'kick').map((e) => e.t);
    const newBeat = 60 / c.bpm;
    for (let i = 1; i < ks.length; i++) {
      const d = ks[i] - ks[i - 1];
      assert.ok(d > 0.5 * Math.min(oldBeat, newBeat), `doublon de kick (écart ${d.toFixed(3)} s, ${JSON.stringify(c)})`);
      assert.ok(d < 1.55 * Math.max(oldBeat, newBeat), `trou de kick (écart ${d.toFixed(3)} s, ${JSON.stringify(c)})`);
    }
    // toutes les parties : jamais deux événements de la même partie à moins d'une demi double-croche
    const step = Math.min(oldBeat, newBeat) / 4;
    for (const part of ['clap', 'hat', 'openhat']) {
      const ts = evs.filter((e) => e.part === part).map((e) => e.t);
      for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] > 0.45 * step, `doublon ${part}`);
    }
    // le nouveau plan démarre sur un temps de la nouvelle grille, au plus un demi-temps du prochain temps
    const nextOld = plan.anchorCtx + Math.ceil((after - plan.anchorCtx) / oldBeat) * oldBeat;
    assert.ok(Math.abs(r.plan.startCtx - nextOld) <= 0.5 * newBeat + 1e-9, 'bascule loin du prochain temps');
    const k = (r.plan.startCtx - newAnchor) / newBeat;
    assert.ok(Math.abs(k - Math.round(k)) < 1e-6, 'nouveau départ hors grille');
  }
});

test('rateRamp : extrémités, monotone, paliers dans le temps', () => {
  const r = rateRamp(1, 1.24, 50, 16, 124);
  assert.equal(r[0].rate, 1);
  assert.ok(Math.abs(r[r.length - 1].rate - 1.24) < 1e-12);
  assert.ok(Math.abs(r[r.length - 1].t - (50 + 16 * 60 / 124)) < 1e-9);
  assert.equal(r.length, 33);
  for (let i = 1; i < r.length; i++) {
    assert.ok(r[i].t > r[i - 1].t && r[i].rate >= r[i - 1].rate);
  }
  const down = rateRamp(1.1, 1, 0, 4, 120, 8);
  assert.equal(down.length, 9);
  for (let i = 1; i < down.length; i++) assert.ok(down[i].rate <= down[i - 1].rate);
  assert.deepEqual(rateRamp(1, 1.05, 3, 0, 120), [{ t: 3, rate: 1.05 }]);
});


console.log('\nBoucles (échantillonneur)');

test('loopRollSchedule : 1 -> 1/2 -> 1/4 -> 1/8, sur la grille, avant la fin', () => {
  for (const [beats, L0] of [[8, 1], [4, 1], [2, 1], [16, 2], [3, 1], [8, 4]] as const) {
    const s0 = 20;
    const bpm = 126;
    const beat = 60 / bpm;
    const sch = loopRollSchedule(s0, beats, bpm, L0);
    assert.equal(sch[0].t, s0);
    assert.equal(sch[0].len, L0);
    for (let i = 1; i < sch.length; i++) {
      assert.equal(sch[i].len, sch[i - 1].len / 2, 'longueurs pas divisées par 2');
      const b = (sch[i].t - s0) / beat;
      const k = b / sch[i].len;
      assert.ok(Math.abs(k - Math.round(k)) < 1e-6, `bascule hors grille (${b} temps, len ${sch[i].len})`);
      const prevB = (sch[i - 1].t - s0) / beat;
      assert.ok(b - prevB >= sch[i - 1].len - 1e-9, 'boucle précédente pas jouée en entier');
      assert.ok(b < beats, 'bascule après la fin');
    }
    if (beats >= 2 && L0 === 1) assert.ok(sch.length >= 3, `roll ${beats} temps trop court`);
  }
});

test('loopWindow : indices, enroulement, disponibilité', () => {
  const sr = 1000;
  const N = 16000; // 16 s
  const w = loopWindow({ bufferFrames: N, sampleRate: sr, originTime: 2, writtenAbs: 20000, startCtx: 19.5, endCtx: 20.5 });
  assert.equal(w.startAbs, 17500);
  assert.equal(w.endAbs, 18500);
  assert.equal(w.frames, 1000);
  assert.equal(w.startIndex, 1500);
  assert.equal(w.endIndex, 2500);
  assert.equal(w.wraps, false);
  assert.equal(w.available, true);
  const w2 = loopWindow({ bufferFrames: N, sampleRate: sr, originTime: 0, writtenAbs: 33000, startCtx: 31.5, endCtx: 32.5 });
  assert.equal(w2.startIndex, 15500);
  assert.equal(w2.endIndex, 500);
  assert.equal(w2.wraps, true);
  assert.equal(w2.available, true);
  // trop vieux (écrasé) ou pas encore écrit
  assert.equal(loopWindow({ bufferFrames: N, sampleRate: sr, originTime: 0, writtenAbs: 33000, startCtx: 10, endCtx: 11 }).available, false);
  assert.equal(loopWindow({ bufferFrames: N, sampleRate: sr, originTime: 0, writtenAbs: 33000, startCtx: 32.5, endCtx: 33.5 }).available, false);
});

test('microFade : gain constant', () => {
  for (let x = -0.2; x <= 1.2; x += 0.1) {
    const f = microFade(x);
    assert.ok(Math.abs(f.out + f.in - 1) < 1e-12 && f.in >= 0 && f.in <= 1);
  }
});

/** Simule le moteur : signal sinusoïdal écrit et rendu par blocs de 128. */
function simulate(core: LoopCore, sig: (t: number) => number, t0: number, t1: number, sr: number): { t: number; v: number }[] {
  const out: { t: number; v: number }[] = [];
  const n = 128;
  for (let k = 0; t0 + (k * n) / sr < t1; k++) {
    const start = t0 + (k * n) / sr;
    const inp = new Float32Array(n);
    for (let i = 0; i < n; i++) inp[i] = sig(start + i / sr);
    core.write([inp, inp], start);
    const o = [new Float32Array(n), new Float32Array(n)];
    core.render(o, start);
    for (let i = 0; i < n; i++) out.push({ t: start + i / sr, v: o[0][i] });
  }
  return out;
}

test('LoopCore : rejoue la bonne fenêtre, sans clic au bouclage, au changement de longueur et au relâché', () => {
  const sr = 48000;
  const f = 219.7; // nombre de périodes non entier dans la boucle : le bouclage serait un clic sans fondu
  const sig = (t: number) => 0.8 * Math.sin(2 * Math.PI * f * t);
  const core = new LoopCore(sr, 16, 2);
  const bpm = 125;
  const beat = 60 / bpm;
  const holdAt = 3.1234; // pas aligné sur un bloc
  const len = 1 * beat;
  core.schedule({ from: holdAt, winStart: holdAt - len, len, anchor: holdAt });
  core.schedule({ from: holdAt + 2 * beat, winStart: holdAt - len, len: len / 2, anchor: holdAt });
  core.schedule({ from: holdAt + 3 * beat, off: true, winStart: 0, len: 1, anchor: holdAt });
  const out = simulate(core, sig, 0, holdAt + 4 * beat, sr);
  // contenu : juste après le départ, on entend la fenêtre [holdAt - len, ...[
  for (const x of [0.01, 0.1, 0.3]) {
    const p = out.find((o) => o.t >= holdAt + x)!;
    assert.ok(Math.abs(p.v - sig(p.t - len)) < 2e-3, `mauvais contenu à +${x} s`);
  }
  // pendant la boucle d'un demi-temps : période len/2
  const tq = holdAt + 2 * beat + 0.05;
  const q = out.find((o) => o.t >= tq)!;
  const q2 = out.find((o) => o.t >= tq + len / 2 - 1e-6)!;
  assert.ok(Math.abs(q.v - q2.v) < 0.03, 'la boucle courte ne se répète pas');
  // continuité : aucun saut d'échantillon à échantillon au-delà de ce que permet le fondu
  const maxStep = 2 * Math.PI * f * 0.8 / sr; // pente maxi du signal
  let worst = 0;
  for (let i = 1; i < out.length; i++) {
    if (out[i].t < holdAt + 1e-4) continue; // avant la boucle : sortie muette, le gain direct fait le travail
    worst = Math.max(worst, Math.abs(out[i].v - out[i - 1].v));
  }
  assert.ok(worst < maxStep + 2 * 0.8 / (0.005 * sr) + 1e-3, `clic : saut de ${worst.toFixed(4)}`);
  // relâché : silence après le fondu
  assert.ok(out.filter((o) => o.t > holdAt + 3 * beat + 0.006).every((o) => o.v === 0), 'boucle pas coupée au relâché');
});

test('LOOP_WORKLET_SRC : la source sérialisée tourne comme LoopCore', () => {
  let Proc: (new () => { port: { onmessage: (e: { data: unknown }) => void }; process: (i: Float32Array[][], o: Float32Array[][]) => boolean }) | undefined;
  class FakeAWP { port = { onmessage: (_e: { data: unknown }) => undefined as void, postMessage() {} }; }
  const sr = 48000;
  const scope = { frame: 0 };
  const run = new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', 'scope',
    `with (scope) { ${LOOP_WORKLET_SRC.replace(/currentFrame/g, 'scope.frame')} }`);
  run(FakeAWP, (_n: string, c: typeof Proc) => { Proc = c; }, sr, scope);
  assert.ok(Proc, 'registerProcessor pas appelé');
  const p = new Proc!();
  const ref = new LoopCore(sr, 16, 2);
  const seg = { from: 0.5, winStart: 0.3, len: 0.2, anchor: 0.5 };
  p.port.onmessage({ data: { type: 'segment', seg } });
  ref.schedule(seg);
  let maxDiff = 0;
  for (let k = 0; k < 400; k++) {
    const t = (k * 128) / sr;
    const inp = new Float32Array(128).map((_, i) => Math.sin(2 * Math.PI * 330 * (t + i / sr)));
    const o1 = [new Float32Array(128), new Float32Array(128)];
    const o2 = [new Float32Array(128), new Float32Array(128)];
    scope.frame = k * 128;
    p.process([[inp, inp]], [o1]);
    ref.write([inp, inp], t);
    ref.render(o2, t);
    for (let i = 0; i < 128; i++) maxDiff = Math.max(maxDiff, Math.abs(o1[0][i] - o2[0][i]));
  }
  assert.ok(maxDiff < 1e-9, `écart worklet / LoopCore : ${maxDiff}`);
});

test('fxLoopActions : loop (hold puis release) et loop-roll (raccourcit, coupure si amount fort)', () => {
  const beat = 60 / 128;
  const loop = fxLoopActions({ kind: 'loop', target: 'A', atCtx: 10, beats: 4, bpm: 128, amount: 0.5, loopBeats: 0.5 });
  assert.deepEqual(loop.map((a) => a.action), ['hold', 'release']);
  assert.equal((loop[0] as { beats: number }).beats, 0.5);
  assert.ok(Math.abs(loop[1].t - (10 + 4 * beat)) < 1e-9);
  const soft = fxLoopActions({ kind: 'loop-roll', target: 'B', atCtx: 10, beats: 8, bpm: 128, amount: 0.3 });
  assert.equal(soft[0].action, 'hold');
  assert.ok(soft.filter((a) => a.action === 'len').length >= 2);
  assert.ok(Math.abs(soft[soft.length - 1].t - (10 + 8 * beat)) < 1e-9, 'release pas à la fin');
  const hard = fxLoopActions({ kind: 'loop-roll', target: 'B', atCtx: 10, beats: 8, bpm: 128, amount: 0.9 });
  assert.ok(Math.abs(hard[hard.length - 1].t - (10 + 9 * beat)) < 1e-9, 'pas de coupure d’un temps');
  const lanes = fxToAutomation({ kind: 'loop-roll', target: 'B', atCtx: 10, beats: 8, bpm: 128, amount: 0.9 });
  assert.equal(val(lanes, 'B.gain', 10 + 8.5 * beat, 1), 0, 'coupure absente');
  assert.equal(val(lanes, 'B.gain', 10 + 9 * beat + 0.001, 0), 1);
  assert.ok(val(lanes, 'B.filter', 10 + 8 * beat - 0.001, 0) > 0.5, 'pas de passe-haut qui monte');
  assert.deepEqual(fxLoopActions({ kind: 'gate', target: 'A', atCtx: 0, beats: 4, bpm: 120, amount: 1 }), []);
});

console.log(`\n${passed} réussi(s), ${failed} échec(s)\n`);
if (failed > 0) process.exit(1);
