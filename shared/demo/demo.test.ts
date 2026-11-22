/**
 * Tests des morceaux de démo : npx tsx shared/demo/demo.test.ts
 * (script tsx, node:assert, code de sortie non nul en cas d'échec)
 */
import assert from 'node:assert/strict';
import { GENRES } from '../contracts';
import { computeWaveform, computeWaveformAsync, prewarmDemo, getDemoKey, getDemoMeta, getDemoStructure, isDemoTrack, listDemoTracks, renderDemoPcm, SynthDeck } from './index';

const SR = 44100;
let failures = 0;

function check(name: string, fn: () => void): void {
  try { fn(); } catch (err) {
    failures++;
    console.error(`ÉCHEC ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Passe-bas biquad 200 Hz appliqué à la somme L+R. */
function lowBand(l: Float32Array, r: Float32Array): Float32Array {
  const w = (2 * Math.PI * 200) / SR, cw = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2), a0 = 1 + al;
  const b0 = (1 - cw) / 2 / a0, b1 = (1 - cw) / a0, a1 = (-2 * cw) / a0, a2 = (1 - al) / a0;
  const out = new Float32Array(l.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < l.length; i++) {
    const x = (l[i] + r[i]) * 0.5;
    const y = b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y; out[i] = y;
  }
  return out;
}

function rmsRange(x: Float32Array, a: number, b: number): number {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

/** Tempo par autocorrélation de l'enveloppe (flux positif) des basses, peigne de multiples. */
function estimateBpm(low: Float32Array, a: number, b: number): number {
  const hop = 256, fps = SR / hop;
  const nf = Math.floor((b - a) / hop);
  const env = new Float32Array(nf);
  for (let f = 0; f < nf; f++) {
    let s = 0;
    for (let i = a + f * hop, e = i + hop; i < e; i++) s += low[i] < 0 ? -low[i] : low[i];
    env[f] = s / hop;
  }
  const on = new Float32Array(nf);
  let mean = 0;
  for (let f = 1; f < nf; f++) { on[f] = Math.max(0, env[f] - env[f - 1]); mean += on[f]; }
  mean /= nf;
  for (let f = 0; f < nf; f++) on[f] -= mean;
  const maxLag = Math.ceil(fps * 9);
  const ac = new Float32Array(maxLag + 2);
  for (let lag = 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let f = 0; f + lag < nf; f++) s += on[f] * on[f + lag];
    ac[lag] = s / (nf - lag);
  }
  const at = (lag: number) => { const i = Math.floor(lag), t = lag - i; return ac[i] * (1 - t) + ac[i + 1] * t; };
  let best = 0, bestScore = -Infinity;
  for (let bpm = 70; bpm <= 180; bpm += 0.02) {
    const period = (60 / bpm) * fps;
    const K = Math.max(1, Math.floor(maxLag / period));
    let s = 0;
    for (let k = 1; k <= K; k++) s += at(k * period);
    s /= K;
    if (s > bestScore) { bestScore = s; best = bpm; }
  }
  return best;
}

const tracks = listDemoTracks();

check('catalogue', () => {
  assert.ok(tracks.length >= 14 && tracks.length <= 24, `nombre de morceaux ${tracks.length}`);
  const ids = new Set<number>();
  for (const t of tracks) {
    assert.ok(t.id < 0, `id négatif ${t.id}`);
    assert.ok(!ids.has(t.id), `id unique ${t.id}`);
    ids.add(t.id);
    assert.ok(isDemoTrack(t.id));
    assert.ok(t.duration >= 150 && t.duration <= 300, `${t.title} : durée ${t.duration}`);
    assert.ok(t.bpm && t.bpm >= 70 && t.bpm <= 180, `${t.title} : bpm`);
    assert.ok(t.genres && t.genres.length > 0 && t.genres.every((g) => (GENRES as readonly string[]).includes(g)), `${t.title} : genres`);
    assert.ok(t.cover?.startsWith('data:image/svg+xml'), `${t.title} : cover`);
    assert.ok(getDemoKey(t.id), `${t.title} : tonalité`);
  }
  assert.equal(isDemoTrack(12345), false);
  const all = new Set(tracks.flatMap((t) => t.genres ?? []));
  for (const g of ['tech-house', 'house', 'techno', 'minimal', 'nu-disco', '80s', 'afro-house', 'rap-fr', 'reggaeton', 'drum-bass', 'deep-house'] as const) {
    assert.ok(all.has(g), `genre couvert : ${g}`);
  }
  for (const g of ['funk', 'pop'] as const) assert.ok(all.has(g), `genre couvert : ${g}`);
  // re-edits : 3 morceaux organiques à tempo régulier + 1 rubato
  const metas = tracks.map((t) => getDemoMeta(t.id)!);
  const re = metas.filter((m) => m.reEditCandidate);
  assert.ok(re.length >= 3, `candidats re-edit : ${re.length}`);
  for (const m of re) {
    assert.ok(m.tempoStable && !m.fourOnTheFloor, `re-edit ${m.id} : stable, pas de 4/4`);
    assert.ok(m.bpm >= 90 && m.bpm <= 110, `re-edit ${m.id} : bpm ${m.bpm}`);
  }
  const rub = metas.filter((m) => !m.tempoStable);
  assert.equal(rub.length, 1, 'un seul morceau rubato');
  assert.ok(!rub[0].reEditCandidate);
  assert.ok(rub[0].tempoDeviation > 0.03 && rub[0].tempoDeviation <= 0.0500001, `rubato : écart ${rub[0].tempoDeviation}`);
  assert.ok(Math.abs(rub[0].realBpm - rub[0].bpm) < 3, `rubato : tempo moyen ${rub[0].realBpm}`);
  for (const m of metas) {
    if (!m.tempoStable) continue;
    assert.equal(m.tempoDeviation, 0);
    assert.ok(Math.abs(m.realBpm - m.bpm) < 1e-6);
  }
  for (const m of metas.filter((x) => x.fourOnTheFloor)) assert.ok(!m.reEditCandidate);
  // caps de la platine de démo
  assert.equal(SynthDeck.CAPS.maxRateDelta, 0.3);
  assert.equal(SynthDeck.CAPS.preservesPitch, false);
  // stabilité
  assert.deepEqual(listDemoTracks().map((t) => t.id), tracks.map((t) => t.id));
});

const rows: string[] = [];
for (const t of tracks) {
  const t0 = performance.now();
  let pcm: { left: Float32Array; right: Float32Array };
  try { pcm = renderDemoPcm(t.id, SR); } catch (err) {
    failures++;
    console.error(`ÉCHEC rendu ${t.title}:`, err);
    continue;
  }
  const ms = performance.now() - t0;
  const { left, right } = pcm;
  const st = getDemoStructure(t.id);
  let detected = 0;
  let ratio = 0;
  let peak = 0;
  check(`${t.title} : rendu`, () => {
    assert.equal(left.length, t.duration * SR, 'longueur = duration');
    assert.equal(right.length, t.duration * SR);
    for (let i = 0; i < left.length; i++) {
      const a = left[i], b = right[i];
      if (a !== a || b !== b) throw new Error(`NaN à l'échantillon ${i}`);
      const m = Math.max(Math.abs(a), Math.abs(b));
      if (m > peak) peak = m;
    }
    assert.ok(peak <= 0.9, `crête ${peak.toFixed(3)}`);
    assert.ok(peak > 0.3, `trop faible ${peak.toFixed(3)}`);
  });
  const low = lowBand(left, right);
  const meta = getDemoMeta(t.id)!;
  const secOf = (beat: number) => meta.beatTimes[Math.min(beat, meta.beatTimes.length - 1)];
  check(`${t.title} : structure`, () => {
    const total = st.reduce((a, s) => a + s.beats, 0);
    assert.ok(secOf(total) * SR <= left.length, 'structure dans la durée');
    for (const s of st) assert.ok(Math.abs(s.startSec - secOf(s.startBeat)) < 1e-9);
    assert.equal(st[0].startBeat, 0);
    for (let i = 1; i < st.length; i++) assert.equal(st[i].startBeat, st[i - 1].startBeat + st[i - 1].beats);
    assert.ok(st.some((s) => s.section === 'drop') && st.some((s) => s.section === 'breakdown'));
  });
  check(`${t.title} : tempo`, () => {
    const drop = st.find((s) => s.section === 'drop')!;
    const a = Math.round(secOf(drop.startBeat) * SR), b = Math.min(left.length, Math.round(secOf(drop.startBeat + drop.beats) * SR));
    detected = estimateBpm(low, a, b);
    const bpm = t.bpm!;
    if (!meta.tempoStable) return;   // rubato : pas de tempo unique à retrouver
    const ok = [bpm, bpm / 2, bpm * 2].some((c) => Math.abs(detected - c) <= 1);
    assert.ok(ok, `bpm détecté ${detected.toFixed(2)} pour ${bpm}`);
  });
  check(`${t.title} : breakdown`, () => {
    const energy = (sec: string) => {
      let s = 0, n = 0;
      for (const it of st.filter((x) => x.section === sec)) {
        const a = Math.round(it.startSec * SR), b = Math.round((it.startSec + it.durationSec) * SR);
        const r = rmsRange(low, a, b);
        s += r * r * (b - a); n += b - a;
      }
      return Math.sqrt(s / n);
    };
    ratio = energy('breakdown') / energy('drop');
    assert.ok(ratio < 0.5, `basses breakdown/drop = ${ratio.toFixed(2)}`);
  });
  check(`${t.title} : waveform`, () => {
    const w0 = performance.now();
    const wf = computeWaveform({ left, right, sampleRate: SR }, 150);
    const wms = performance.now() - w0;
    const n = Math.ceil(t.duration * 150);
    for (const k of ['low', 'mid', 'high', 'peak'] as const) {
      assert.equal(wf[k].length, n, `${k} taille`);
      let mx = 0;
      for (const v of wf[k]) { assert.ok(v >= 0 && v <= 1, `${k} hors 0..1`); if (v > mx) mx = v; }
      assert.ok(Math.abs(mx - 1) < 1e-6, `${k} normalisé`);
    }
    assert.equal(wf.pointsPerSecond, 150);
    assert.ok(wms < 600, `waveform trop lente ${wms.toFixed(0)} ms`);
    if (t === tracks[0]) console.log(`computeWaveform 150 pts/s sur ${t.duration} s : ${wms.toFixed(0)} ms`);
  });
  rows.push(`${String(t.id).padStart(6)}  ${t.title.padEnd(32)} ${(t.genres ?? []).join('/').padEnd(22)} ${String(t.bpm).padStart(3)} BPM (mesuré ${detected.toFixed(1)}${meta.tempoStable ? '' : ', rubato'})  ${getDemoKey(t.id)!.padStart(3)}  ${String(t.duration).padStart(3)} s  crête ${(20 * Math.log10(peak)).toFixed(1)} dBFS  basses bkdn/drop ${ratio.toFixed(2)}  rendu ${ms.toFixed(0)} ms`);
}


// ---------------------------------------------------------------------------------------------
// SynthDeck avec un faux AudioContext (horloge pilotée à la main)
// ---------------------------------------------------------------------------------------------
async function deckTest(): Promise<void> {
  const fake = {
    currentTime: 0, state: 'running',
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
    createBuffer: (ch: number, len: number, sr: number) => {
      const data = Array.from({ length: ch }, () => new Float32Array(len));
      return { numberOfChannels: ch, length: len, sampleRate: sr, duration: len / sr, getChannelData: (c: number) => data[c] };
    },
    createBufferSource: () => ({
      buffer: null as unknown, onended: null as unknown, startedAt: -1,
      playbackRate: { value: 1, setValueAtTime(v: number) { this.value = v; } },
      connect() {}, disconnect() {}, start(_w: number, off: number) { this.startedAt = off; }, stop() {},
    }),
    resume: async () => {},
  };
  const deck = new SynthDeck('A', fake as unknown as AudioContext);
  const events: string[] = [];
  deck.on((e) => events.push(e.type === 'status' ? `status:${e.status}` : e.type));
  const track = listDemoTracks().find((t) => t.id === -1006)!;
  await deck.load(track, 10);
  let s = deck.getState();
  assert.equal(s.status, 'ready');
  assert.equal(s.position, 10);
  assert.equal(s.duration, track.duration);
  assert.deepEqual(s.caps, { canSeek: true, canSetRate: true, preservesPitch: false, maxRateDelta: 0.3 });
  assert.ok(events.includes('status:loading') && events.includes('track') && events.includes('caps'));
  await deck.play();
  fake.currentTime = 2;
  assert.ok(Math.abs(deck.getState().position - 12) < 1e-9, 'position à rate 1');
  await deck.setRate(1.2);
  fake.currentTime = 4;
  assert.ok(Math.abs(deck.getState().position - 14.4) < 1e-9, `position après changement de rate ${deck.getState().position}`);
  await deck.setRate(2);
  assert.equal(deck.getState().rate, 1.3, 'rate plafonné à +30 %');
  await deck.pause();
  fake.currentTime = 10;
  assert.ok(Math.abs(deck.getState().position - 14.4) < 1e-9, 'position figée en pause');
  await deck.seek(track.duration - 1);
  await deck.setRate(1);
  await deck.play();
  fake.currentTime = 12;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(deck.getState().status, 'ended');
  deck.dispose();
  // chemins asynchrones (sans Worker sous Node : repli synchrone)
  await prewarmDemo([-1009, 99999], fake as unknown as AudioContext);
  const wf = await computeWaveformAsync({ left: new Float32Array(44100), sampleRate: 44100 }, 50);
  assert.equal(wf.low.length, 50);
}

console.log(rows.join('\n'));
try { await deckTest(); console.log('SynthDeck (faux AudioContext) : OK'); } catch (err) {
  failures++;
  console.error('ÉCHEC SynthDeck :', err);
}
if (failures) {
  console.error(`\n${failures} échec(s)`);
  process.exit(1);
}
console.log('\nOK : tous les tests des morceaux de démo passent');
