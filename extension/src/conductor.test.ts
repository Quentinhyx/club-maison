/**
 * Tests du chef d'orchestre sans navigateur : npx tsx extension/src/conductor.test.ts
 * Horloge, platines, table, cerveau et API des invités sont simulés.
 */
import type {
  BrainDecision, BrainInput, DeckCapabilities, DeckController, DeckEvent, DeckId, DeckState, DjBrain, FxCue,
  ParamTarget, PartyState, TrackAnalysis, TrackRef, TransitionPlan, AutomationLane, GuestRequest, NowPlaying,
} from '../../shared/contracts';
import { phaseNudge } from '../../shared/audio/sync';
import { Conductor, defaultCrowd, defaultRateRamp, type MixerLike } from './conductor';

let failures = 0;
let count = 0;
function ok(cond: unknown, msg: string) {
  count++;
  if (!cond) {
    failures++;
    console.error(`ÉCHEC : ${msg}`);
  }
}

const clock = { t: 100, ms: 1_000_000 };
const advance = (s: number) => {
  clock.t += s;
  clock.ms += s * 1000;
};

const track = (id: number, title = `T${id}`, duration = 240): TrackRef => ({ id, title, artist: 'X', duration, bpm: 124 });

class FakeDeck implements DeckController {
  state: DeckState;
  calls: Array<{ op: string; at: number; arg?: unknown }> = [];
  failLoad = false;
  private ls = new Set<(e: DeckEvent) => void>();
  private playStartCtx?: number;
  private playStartPos = 0;
  constructor(readonly id: DeckId, caps: Partial<DeckCapabilities> = {}) {
    this.state = { id, status: 'empty', position: 0, duration: 0, rate: 1, caps: { canSeek: true, canSetRate: true, preservesPitch: true, maxRateDelta: 0.08, ...caps } };
  }
  async load(t: TrackRef, startAt = 0) {
    this.calls.push({ op: 'load', at: clock.t, arg: t.id });
    if (this.failLoad) {
      this.state = { ...this.state, status: 'error', error: 'boum' };
      throw new Error('boum');
    }
    this.state = { ...this.state, track: t, status: 'ready', position: startAt, duration: t.duration };
  }
  async play() {
    this.calls.push({ op: 'play', at: clock.t });
    this.playStartCtx = clock.t;
    this.playStartPos = this.state.position;
    this.state = { ...this.state, status: 'playing' };
  }
  async pause() {
    this.calls.push({ op: 'pause', at: clock.t });
    this.state = { ...this.getState(), status: 'paused' };
    this.playStartCtx = undefined;
  }
  async seek(p: number) {
    this.calls.push({ op: 'seek', at: clock.t, arg: p });
    this.state = { ...this.state, position: p };
    if (this.playStartCtx !== undefined) {
      this.playStartCtx = clock.t;
      this.playStartPos = p;
    }
  }
  async setRate(r: number) {
    this.calls.push({ op: 'rate', at: clock.t, arg: r });
    if (this.playStartCtx !== undefined) {
      this.playStartPos = this.getState().position;
      this.playStartCtx = clock.t;
    }
    this.state = { ...this.state, rate: r };
  }
  getState(): DeckState {
    if (this.state.status === 'playing' && this.playStartCtx !== undefined) {
      return { ...this.state, position: this.playStartPos + (clock.t - this.playStartCtx) * this.state.rate };
    }
    return { ...this.state };
  }
  async getStream(): Promise<MediaStream> {
    throw new Error('pas de flux en test');
  }
  on(l: (e: DeckEvent) => void) {
    this.ls.add(l);
    return () => this.ls.delete(l);
  }
  dispose() {}
  crash(msg: string) {
    this.state = { ...this.getState(), status: 'error', error: msg };
    for (const l of this.ls) l({ type: 'status', deck: this.id, status: 'error', error: msg });
  }
}

class FakeMixer implements MixerLike {
  params = new Map<string, number>();
  transitions: TransitionPlan[] = [];
  fxs: FxCue[] = [];
  cancels: number[] = [];
  tempo = 0;
  grooves: string[] = [];
  setParam(t: ParamTarget, v: number) {
    this.params.set(t, v);
  }
  getParam(t: ParamTarget) {
    return this.params.get(t) ?? (t.endsWith('.gain') ? 1 : 0);
  }
  cancelFrom(t: number) {
    this.cancels.push(t);
  }
  runTransition(p: TransitionPlan): AutomationLane[] {
    this.transitions.push(p);
    return [];
  }
  fx(c: FxCue): AutomationLane[] {
    this.fxs.push(c);
    return [];
  }
  getLevels() {
    return { A: 0, B: 0, master: 0 };
  }
  setTempo(b: number) {
    this.tempo = b;
  }
  startGroove() {
    this.grooves.push('start');
    return [];
  }
  updateGroove() {
    this.grooves.push('update');
  }
  stopGroove() {
    this.grooves.push('stop');
    return [];
  }
}

class ScriptBrain implements DjBrain {
  queue: BrainDecision[][] = [];
  inputs: BrainInput[] = [];
  tick(i: BrainInput) {
    this.inputs.push(i);
    return this.queue.shift() ?? [];
  }
  reset() {}
  push(...d: BrainDecision[]) {
    this.queue.push(d);
  }
}

const analysis = (id: number): TrackAnalysis => ({
  trackId: id, bpm: 124, bpmConfidence: 0.9, energy: 0.6, danceability: 0.8, brightness: 0.5, loudnessDb: -10, genres: ['house'], analyzedAt: 0,
});

function setup(opts: { latency?: number; guest?: boolean } = {}) {
  const decks = { A: new FakeDeck('A'), B: new FakeDeck('B') };
  const mixer = new FakeMixer();
  const brain = new ScriptBrain();
  let inflight = 0;
  let maxInflight = 0;
  const analyzeResolvers: Array<() => void> = [];
  const catalogCalls: string[] = [];
  const posted: NowPlaying[] = [];
  const statusCalls: Array<[string, string]> = [];
  const requests: GuestRequest[] = [];
  const timers: Array<{ at: number; fn: () => void }> = [];
  const c = new Conductor({
    nowCtx: () => clock.t,
    nowMs: () => clock.ms,
    mixer,
    decks,
    analyzers: { A: { getState: () => undefined, reset: () => {} }, B: { getState: () => undefined, reset: () => {} } },
    brain,
    settings: { style: 'paris-tech-house', fxAmount: 0.5, minPlaySeconds: 60, maxPlaySeconds: 300, followCrowd: true, baseGenre: 'house' },
    phaseNudge,
    rateRamp: defaultRateRamp,
    catalog: async (g) => {
      catalogCalls.push(g);
      return Array.from({ length: 10 }, (_, i) => track(500 + i));
    },
    analyze: (t) =>
      new Promise((res) => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        analyzeResolvers.push(() => {
          inflight--;
          res(analysis(t.id));
        });
      }),
    fallbackTracks: () => [track(900, 'Secours')],
    startLatency: () => opts.latency ?? 0.4,
    timers: {
      setTimeout: (fn, ms) => {
        const h = { at: clock.t + ms / 1000, fn };
        timers.push(h);
        return h;
      },
      clearTimeout: (h) => {
        const i = timers.indexOf(h as any);
        if (i >= 0) timers.splice(i, 1);
      },
    },
    guestApi: opts.guest
      ? {
          getState: async (): Promise<PartyState> => ({ crowd: { ...defaultCrowd(), requests: [...requests], energy: 0.4 }, nowPlaying: { updatedAt: 0 } }),
          postNowPlaying: async (np) => {
            posted.push(np);
          },
          setRequestStatus: async (id, st) => {
            statusCalls.push([id, st]);
          },
        }
      : null,
  });
  const runTimers = () => {
    for (const h of [...timers]) {
      if (h.at <= clock.t + 1e-9) {
        timers.splice(timers.indexOf(h), 1);
        h.fn();
      }
    }
  };
  const step = async (s: number, dt = 0.1) => {
    const n = Math.round(s / dt);
    for (let i = 0; i < n; i++) {
      advance(dt);
      runTimers();
      c.tick();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
  return { c, decks, mixer, brain, step, analyzeResolvers, getMax: () => maxInflight, catalogCalls, posted, statusCalls, requests, runTimers };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// ------------------------------------------------------------------------------------------- 1
{
  const t = setup();
  t.c.start();
  t.brain.push({ type: 'want-genre', genre: 'house', bpmMin: 118, bpmMax: 128, reason: 'test' });
  await t.step(0.1);
  await flush();
  ok(t.catalogCalls.length === 1, 'want-genre appelle le catalogue');
  t.brain.push({ type: 'want-genre', genre: 'house', bpmMin: 118, bpmMax: 128, reason: 'encore' });
  await t.step(0.1);
  await flush();
  ok(t.catalogCalls.length === 1, 'want-genre identique dédoublonné');
  await t.step(0.3);
  ok(t.getMax() <= 2 && t.getMax() >= 1, `analyses limitées à 2 en parallèle (max ${t.getMax()})`);
  while (t.analyzeResolvers.length) {
    t.analyzeResolvers.shift()!();
    await flush();
    await t.step(0.1);
  }
  const lastIn = t.brain.inputs[t.brain.inputs.length - 1];
  ok(lastIn.candidates.length === 10, `candidats transmis au cerveau (${lastIn.candidates.length})`);
  ok(lastIn.candidates.filter((x) => x.analysis).length >= 10, 'candidats enrichis de leur analyse');
  t.c.stop();
}

// ------------------------------------------------------------------------------------------- 2 transition
{
  const t = setup({ latency: 0.4 });
  t.c.start();
  // A joue déjà
  await t.decks.A.load(track(1));
  await t.decks.A.play();
  t.mixer.setParam('A.gain', 1);
  await t.decks.B.load(track(2), 32);
  const bpm = 124;
  const spb = 60 / bpm;
  const startCtx = clock.t + 10;
  const plan: TransitionPlan = {
    id: 'p1', from: 'A', to: 'B', technique: 'long-blend', startCtx, beats: 32, bpm, incomingStartCtx: startCtx, incomingStartPos: 32,
    incomingRate: 1.02, accents: [], intensity: 0.5, reason: 'test',
  };
  t.brain.push({ type: 'transition', plan });
  await t.step(0.1);
  ok(t.mixer.transitions.length === 1, 'runTransition appelé');
  ok(t.mixer.params.get('B.gain') === 0, 'entrant fader fermé avant le pré-lancement');
  const seek = t.decks.B.calls.find((x) => x.op === 'seek');
  const preroll = 8 * spb;
  ok(seek && Math.abs((seek.arg as number) - (32 - preroll * 1.02)) < 1e-6, `recul pour le pré-lancement (${seek?.arg})`);
  await t.step(12);
  const play = t.decks.B.calls.find((x) => x.op === 'play');
  const expectedPlay = startCtx - preroll - 0.4;
  ok(play && Math.abs(play.at - expectedPlay) < 0.11, `play() de l'entrant à ${play?.at.toFixed(2)} (attendu ${expectedPlay.toFixed(2)})`);
  // position de l'entrant au premier temps prévu
  const posAt = 32 - preroll * 1.02 + (startCtx - (play?.at ?? 0)) * 1.02;
  ok(Math.abs(posAt - 32) < 0.6, `l'entrant arrive au bon endroit au départ (${posAt.toFixed(2)})`);
  const rates = t.decks.B.calls.filter((x) => x.op === 'rate').map((x) => x.arg as number);
  ok(rates.length > 1, 'calage de phase : plusieurs corrections de vitesse');
  ok(rates.every((r) => r >= 0.92 && r <= 1.08), 'vitesses bornées à ±8 %');
  ok(Math.abs(rates[rates.length - 1] - 1.02) < 0.01, `vitesse finale proche du rate de base (${rates[rates.length - 1]})`);
  t.mixer.setParam('A.gain', 0);
  await t.step(32 * spb + 6);
  ok(t.decks.A.calls.some((x) => x.op === 'pause'), 'sortant coupé après la transition');
  ok(t.c.getSnapshot().history.some((h) => h.track.id === 2), 'entrant ajouté à l’historique');
  ok(!t.c.getSnapshot().transition, 'transition terminée');
  t.c.stop();
}

// ------------------------------------------------------------------------------------------- 3 annulation sur nouveau load
{
  const t = setup();
  t.c.start();
  await t.decks.A.load(track(1));
  await t.decks.A.play();
  await t.decks.B.load(track(2), 0);
  const startCtx = clock.t + 20;
  t.brain.push({
    type: 'transition',
    plan: { id: 'p2', from: 'A', to: 'B', technique: 'bass-swap', startCtx, beats: 16, bpm: 124, incomingStartCtx: startCtx, incomingStartPos: 0, incomingRate: 1, accents: [], intensity: 0.5, reason: 'x' },
  });
  await t.step(1);
  t.brain.push({ type: 'load', deck: 'B', track: track(3), startAt: 0, reason: 'mieux' });
  await t.step(0.2);
  await flush();
  ok(t.mixer.cancels.length === 1, 'cancelFrom appelé quand un load arrive avant la transition');
  ok(!t.c.getSnapshot().transition, 'transition prévue abandonnée (le cerveau replanifie)');
  ok(t.decks.B.state.track?.id === 3, 'nouveau morceau chargé');
  t.c.stop();
}

// ------------------------------------------------------------------------------------------- 4 ouverture : pas de pré-lancement, décalage minimal
{
  const t = setup({ latency: 0.3 });
  t.c.start();
  await t.decks.A.load(track(7), 0);
  const s = clock.t + 0.1;
  t.brain.push({ type: 'transition', plan: { id: 'o', from: 'B', to: 'A', technique: 'cut', startCtx: s, beats: 1, bpm: 124, incomingStartCtx: s, incomingStartPos: 0, incomingRate: 1, accents: [], intensity: 0, reason: 'ouverture' } });
  await t.step(1);
  const play = t.decks.A.calls.find((x) => x.op === 'play');
  ok(play && play.at - s < 0.6, `ouverture lancée tout de suite (${play && (play.at - s).toFixed(2)} s)`);
  ok(!t.decks.A.calls.some((x) => x.op === 'seek' && (x.arg as number) < 0), 'pas de recul sous 0');
  t.c.stop();
}

// ------------------------------------------------------------------------------------------- 5 robustesse
{
  const t = setup();
  t.c.start();
  await t.decks.A.load(track(1));
  await t.decks.A.play();
  t.mixer.setParam('A.gain', 1);
  t.mixer.setParam('B.gain', 0);
  await t.decks.B.load(track(2));
  await t.step(1);
  t.decks.A.crash('onglet fermé');
  await t.step(0.3);
  ok(t.decks.B.state.status === 'playing', 'platine B prend le relais quand A plante');
  ok(t.mixer.params.get('B.gain') === 1, 'fader de B ouvert');
  t.c.stop();
}
{
  const t = setup();
  t.c.start();
  // rien de prêt : morceau de secours au bout de quelques secondes
  await t.step(7);
  await flush();
  await t.step(1);
  ok(t.decks.A.calls.some((x) => x.op === 'load') || t.decks.B.calls.some((x) => x.op === 'load'), 'morceau de secours chargé');
  await t.step(4);
  ok(t.decks.A.state.status === 'playing' || t.decks.B.state.status === 'playing', 'secours lancé : pas de silence prolongé');
  t.c.stop();
}

// ------------------------------------------------------------------------------------------- 6 invités
{
  const t = setup({ guest: true });
  t.requests.push({ id: 'r1', guestId: 'g', guestName: 'Léa', track: track(77, 'Demande'), createdAt: 0, status: 'accepted' });
  t.c.start();
  await t.step(0.2);
  await flush();
  await flush();
  const s = t.c.getSnapshot();
  ok(s.queue.some((q) => q.track.id === 77 && q.source === 'guest' && q.requestId === 'r1'), 'demande acceptée ajoutée à la file');
  ok(s.crowd.energy === 0.4, 'foule récupérée');
  ok(t.posted.length >= 1, 'now-playing envoyé');
  await t.step(3.2);
  await flush();
  ok(t.c.getSnapshot().queue.filter((q) => q.track.id === 77).length === 1, 'pas de doublon dans la file');
  t.brain.push({ type: 'consume-queue', trackId: 77 });
  await t.step(0.1);
  await flush();
  ok(t.statusCalls.some(([id, st]) => id === 'r1' && st === 'played'), 'demande marquée jouée');
  t.c.stop();
}

// ------------------------------------------------------------------------------------------- 7 rampes de vitesse, groove
{
  const t = setup();
  t.c.start();
  await t.decks.A.load(track(1));
  await t.decks.A.play();
  t.mixer.setParam('A.gain', 1);
  t.brain.push({ type: 'rate', deck: 'A', rate: 1.04, overBeats: 8, reason: 'montée de tempo' });
  await t.step(5);
  const r = t.decks.A.calls.filter((x) => x.op === 'rate').map((x) => x.arg as number);
  ok(r.length >= 4, `rampe par paliers (${r.length} paliers)`);
  ok(Math.abs(r[r.length - 1] - 1.04) < 1e-6, 'rampe arrivée à la cible');
  ok(r.every((x, i) => i === 0 || x >= r[i - 1]), 'rampe monotone');
  t.brain.push({ type: 'rate', deck: 'A', rate: 1.2, overBeats: 0, reason: 're-edit' });
  await t.step(0.3);
  ok(Math.abs(t.c.getBaseRate('A') - 1.08) < 1e-6, 'vitesse bornée à la limite de la platine');
  ok(t.c.getSnapshot().logs.some((l) => l.msg.includes('bornée')), 'bornage journalisé');
  t.brain.push({ type: 'groove-start', plan: { style: 'house', bpm: 124, anchorCtx: clock.t, bass: false, parts: ['kick'], startCtx: clock.t, fadeBeats: 8, sourceLowCutDb: -12, deck: 'A' }, reason: 'test' });
  t.brain.push({ type: 'groove-update', bpm: 125, anchorCtx: clock.t });
  t.brain.push({ type: 'groove-stop', atCtx: clock.t + 1, fadeBeats: 4 });
  await t.step(0.3);
  ok(t.mixer.grooves.join(',') === 'start,update,stop', 'groove transmis à la table');
  ok(t.c.getGroove()?.plan.bpm === 125, 'groove suivi');
  await t.step(4);
  ok(!t.c.getGroove(), 'groove terminé');
  t.c.stop();
}

console.log(`${count - failures}/${count} vérifications OK`);
if (failures) process.exit(1);
