/**
 * Tests de l'analyse musicale, sur signaux SYNTHÉTIQUES générés ici.
 *   npx tsx shared/analysis/analysis.test.ts
 */
import assert from 'node:assert/strict';
import type { Section, TrackRef } from '../contracts';
import { analyzeBuffer, analyzePreview, getCachedAnalysis, LiveBeatTracker, normalizeBpm, toCamelot } from './index';

const SR = 44100;
let failures = 0;
const results: string[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Générateurs
// ---------------------------------------------------------------------------------------------

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

function addKick(buf: Float32Array, t0: number, amp: number, sr = SR): void {
  const start = Math.round(t0 * sr);
  const len = Math.round(0.25 * sr);
  let phase = 0;
  for (let i = 0; i < len && start + i < buf.length; i++) {
    if (start + i < 0) continue;
    const t = i / sr;
    const f = 50 + 70 * Math.exp(-t / 0.03);
    phase += (2 * Math.PI * f) / sr;
    buf[start + i] += amp * Math.exp(-t / 0.09) * Math.sin(phase);
  }
}

function addNoiseBurst(buf: Float32Array, t0: number, amp: number, decay: number, r: () => number, hpf = true, sr = SR): void {
  const start = Math.round(t0 * sr);
  const len = Math.round(decay * 6 * sr);
  let prev = 0;
  for (let i = 0; i < len && start + i < buf.length; i++) {
    if (start + i < 0) continue;
    const n = r();
    const v = hpf ? n - prev : n;
    prev = n;
    buf[start + i] += amp * Math.exp(-i / sr / decay) * v;
  }
}

interface LoopOpts {
  bpm: number;
  seconds: number;
  sr?: number;
  hats?: 'off' | 'eighths' | 'none';
  snare24?: boolean;
  accent?: number;          // gain du kick sur le 1 (les autres = 0.65)
  kickOn?: (beat: number) => boolean;
  offset?: number;          // instant du premier temps (s)
  riser?: (beat: number) => number; // gain d'un bruit montant (build), par temps
  seed?: number;
}

function drumLoop(o: LoopOpts): Float32Array {
  const sr = o.sr ?? SR;
  const buf = new Float32Array(Math.round(o.seconds * sr));
  const r = rng(o.seed ?? 7);
  const P = 60 / o.bpm;
  const off = o.offset ?? 0;
  for (let b = 0; off + b * P < o.seconds; b++) {
    const t = off + b * P;
    const kickGain = o.accent !== undefined ? (b % 4 === 0 ? o.accent : 0.65) : 0.8;
    if (!o.kickOn || o.kickOn(b)) addKick(buf, t, kickGain, sr);
    if (o.hats === 'off' || o.hats === undefined) addNoiseBurst(buf, t + P / 2, 0.25, 0.015, r, true, sr);
    if (o.hats === 'eighths') {
      addNoiseBurst(buf, t, 0.15, 0.012, r, true, sr);
      addNoiseBurst(buf, t + P / 2, 0.2, 0.012, r, true, sr);
    }
    if (o.snare24 && b % 2 === 1) addNoiseBurst(buf, t, 0.35, 0.05, r, false, sr);
    if (o.riser) {
      const g = o.riser(b);
      if (g > 0) {
        const s0 = Math.round(t * sr), s1 = Math.min(buf.length, Math.round((t + P) * sr));
        let prev = 0;
        for (let i = s0; i < s1; i++) { const n = r(); buf[i] += g * (n - prev); prev = n; }
      }
    }
  }
  return buf;
}

/** Batterie sur des instants de temps arbitraires (dérive, rubato). Contretemps = milieu des temps. */
function drumAt(beats: number[], seconds: number, seed = 11, sr = SR): Float32Array {
  const buf = new Float32Array(Math.round(seconds * sr));
  const r = rng(seed);
  for (let i = 0; i < beats.length; i++) {
    addKick(buf, beats[i], i % 4 === 0 ? 1 : 0.65, sr);
    if (i + 1 < beats.length) addNoiseBurst(buf, (beats[i] + beats[i + 1]) / 2, 0.25, 0.015, r, true, sr);
  }
  return buf;
}

function beatsFixed(bpm: number, seconds: number): number[] {
  const out: number[] = [];
  for (let t = 0.05; t < seconds; t += 60 / bpm) out.push(t);
  return out;
}

/** Tempo qui glisse linéairement de b0 à b1 sur la durée. */
function beatsDrift(b0: number, b1: number, seconds: number): number[] {
  const out: number[] = [];
  for (let t = 0.05; t < seconds;) { out.push(t); t += 60 / (b0 + (b1 - b0) * (t / seconds)); }
  return out;
}

/** Intervalles aléatoires ±jitter autour de bpm (chanson jouée sans clic). */
function beatsRubato(bpm: number, jitter: number, seconds: number, seed = 5): number[] {
  const r = rng(seed);
  const out: number[] = [];
  for (let t = 0.05; t < seconds;) { out.push(t); t += (60 / bpm) * (1 + 2 * jitter * r()); }
  return out;
}

const NOTE = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

/** Accords répétés (notes MIDI), 4 harmoniques décroissantes, enveloppe douce. */
function chords(seq: number[][], chordSeconds: number, seconds: number, sr = SR): Float32Array {
  const buf = new Float32Array(Math.round(seconds * sr));
  const harm = [1, 0.5, 0.25, 0.12];
  const n = Math.round(chordSeconds * sr);
  for (let s = 0, ci = 0; s < buf.length; s += n, ci++) {
    const notes = seq[ci % seq.length];
    for (const m of notes) {
      const f = NOTE(m);
      for (let h = 0; h < harm.length; h++) {
        const w = (2 * Math.PI * f * (h + 1)) / sr;
        for (let i = 0; i < n && s + i < buf.length; i++) {
          const env = Math.min(1, i / (0.02 * sr)) * Math.min(1, (n - i) / (0.05 * sr));
          buf[s + i] += (0.12 * harm[h] * env * Math.sin(w * i));
        }
      }
    }
  }
  return buf;
}

const track = (id: number, extra: Partial<TrackRef> = {}): TrackRef => ({
  id, title: `t${id}`, artist: 'synth', duration: 240, ...extra,
});

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Analyse musicale : tests synthétiques');

  await test('normalizeBpm', () => {
    assert.equal(normalizeBpm(62), 124);
    assert.equal(normalizeBpm(248), 124);
    assert.equal(normalizeBpm(95), 95);
    assert.equal(normalizeBpm(360), 180);
    assert.equal(normalizeBpm(0), 0);
    assert.equal(normalizeBpm(50, 100, 200), 100);
  });

  await test('Camelot : do majeur 8B, la mineur 8A, sol majeur 9B, mi mineur 9A, fa mineur 4A', () => {
    assert.equal(toCamelot(0, false), '8B');
    assert.equal(toCamelot(9, true), '8A');
    assert.equal(toCamelot(7, false), '9B');
    assert.equal(toCamelot(4, true), '9A');
    assert.equal(toCamelot(5, true), '4A');
    assert.equal(toCamelot(11, false), '1B');
  });

  for (const [bpm, opts] of [
    [124, { hats: 'off' }],
    [95, { hats: 'eighths', snare24: true }],
    [174, { hats: 'eighths', snare24: true }],
    [128, { hats: 'off', snare24: true }],
    [100, { hats: 'off' }],
    [140, { hats: 'eighths' }],
  ] as Array<[number, Partial<LoopOpts>]>) {
    await test(`tempo hors ligne ${bpm} BPM (sans a priori) à ±1`, () => {
      const buf = drumLoop({ bpm, seconds: 30, ...opts });
      const a = analyzeBuffer(buf, SR, track(bpm));
      results.push(`hors ligne ${bpm} BPM -> ${a.bpm.toFixed(2)} (confiance ${a.bpmConfidence.toFixed(2)}, dansabilité ${a.danceability.toFixed(2)})`);
      assert.ok(Math.abs(a.bpm - bpm) <= 1, `estimé ${a.bpm}`);
      assert.ok(a.bpmConfidence > 0.4, `confiance ${a.bpmConfidence}`);
    });
  }

  await test('a priori Deezer : 124 BPM annoncé 62 (moitié) -> 124 ; stéréo', () => {
    const l = drumLoop({ bpm: 124, seconds: 30 });
    const a = analyzeBuffer([l, l], SR, track(1, { bpm: 62 }));
    assert.ok(Math.abs(a.bpm - 124) <= 1, `estimé ${a.bpm}`);
  });

  await test('a priori Deezer lève l\'ambiguïté : 87 annoncé sur un 174 -> 87 (demi-temps assumé)', () => {
    const buf = drumLoop({ bpm: 174, seconds: 30, hats: 'eighths', snare24: true });
    const a = analyzeBuffer(buf, SR, track(2, { bpm: 87 }));
    assert.ok(Math.abs(a.bpm - 87) <= 1, `estimé ${a.bpm}`);
  });

  await test('genre drum-bass -> plage rapide', () => {
    const buf = drumLoop({ bpm: 87, seconds: 30, hats: 'off' });
    const a = analyzeBuffer(buf, SR, track(3, { genres: ['drum-bass'] }));
    assert.ok(Math.abs(a.bpm - 174) <= 2, `estimé ${a.bpm}`);
    assert.deepEqual(a.genres, ['drum-bass']);
  });

  await test('tonalité : accord de la mineur répété -> 8A', () => {
    const buf = chords([[57, 60, 64]], 1, 30); // A3 C4 E4
    const a = analyzeBuffer(buf, SR, track(10));
    results.push(`la mineur (accord) -> ${a.key} (confiance ${a.keyConfidence?.toFixed(2)})`);
    assert.equal(a.key, '8A');
  });

  await test('tonalité : do majeur (I-IV-V-I) -> 8B', () => {
    const buf = chords([[48, 60, 64, 67], [53, 60, 65, 69], [55, 59, 62, 67], [48, 60, 64, 67]], 1, 30);
    const a = analyzeBuffer(buf, SR, track(11));
    results.push(`do majeur (I-IV-V-I) -> ${a.key} (confiance ${a.keyConfidence?.toFixed(2)})`);
    assert.equal(a.key, '8B');
  });

  await test('tonalité : accord de do majeur seul -> 8B', () => {
    const buf = chords([[60, 64, 67]], 1, 30);
    const a = analyzeBuffer(buf, SR, track(12));
    results.push(`do majeur (accord seul) -> ${a.key} (confiance ${a.keyConfidence?.toFixed(2)})`);
    assert.equal(a.key, '8B');
  });

  await test('tonalité avec batterie : la mineur + kick 124 -> 8A, tempo 124', () => {
    const d = drumLoop({ bpm: 124, seconds: 30 });
    const c = chords([[57, 60, 64], [53, 57, 60], [55, 59, 62], [57, 60, 64]], 60 / 124 * 4, 30); // Am F G Am
    for (let i = 0; i < d.length; i++) d[i] += c[i];
    const a = analyzeBuffer(d, SR, track(13));
    results.push(`la mineur + batterie -> ${a.key}, ${a.bpm.toFixed(2)} BPM`);
    assert.equal(a.key, '8A');
    assert.ok(Math.abs(a.bpm - 124) <= 1, `estimé ${a.bpm}`);
  });

  await test('descripteurs bornés et cohérents (silence, bruit, kick)', () => {
    const sil = analyzeBuffer(new Float32Array(SR * 30), SR, track(20));
    assert.ok(sil.loudnessDb < -90 && sil.energy === 0);
    const kick = analyzeBuffer(drumLoop({ bpm: 124, seconds: 30, hats: 'none' }), SR, track(21));
    const full = analyzeBuffer(drumLoop({ bpm: 124, seconds: 30, hats: 'eighths', snare24: true }), SR, track(22));
    for (const a of [kick, full]) {
      for (const k of ['energy', 'danceability', 'brightness', 'vocalness', 'bpmConfidence'] as const) {
        const v = a[k] ?? 0;
        assert.ok(v >= 0 && v <= 1, `${k}=${v}`);
      }
    }
    assert.ok(full.brightness > kick.brightness, `brillance ${full.brightness} <= ${kick.brightness}`);
    assert.ok(kick.danceability > 0.5, `dansabilité ${kick.danceability}`);
    results.push(`descripteurs kick seul : énergie ${kick.energy.toFixed(2)} brillance ${kick.brightness.toFixed(2)} voix ${kick.vocalness?.toFixed(2)} ; complet : énergie ${full.energy.toFixed(2)} brillance ${full.brightness.toFixed(2)} voix ${full.vocalness?.toFixed(2)}`);
  });

  await test('temps d\'analyse d\'un extrait de 30 s stéréo 44,1 kHz', () => {
    const d = drumLoop({ bpm: 124, seconds: 30 });
    const c = chords([[57, 60, 64]], 2, 30);
    for (let i = 0; i < d.length; i++) d[i] += c[i];
    const r = d.slice();
    analyzeBuffer([d, r], SR, track(30)); // chauffe JIT
    const N = 5;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) analyzeBuffer([d, r], SR, track(30 + i));
    const ms = (performance.now() - t0) / N;
    results.push(`temps d'analyse 30 s stéréo 44,1 kHz : ${ms.toFixed(0)} ms (moyenne sur ${N})`);
    console.log(`       -> ${ms.toFixed(1)} ms`);
    assert.ok(ms < 600, `${ms} ms`);
  });

  await test('analyzePreview : fetch + decode + cache', async () => {
    const buf = drumLoop({ bpm: 124, seconds: 30 });
    let fetches = 0;
    const fakeFetch = (async () => { fetches++; return new Response(new ArrayBuffer(8)); }) as typeof fetch;
    const fakeCtx = {
      decodeAudioData: async () => ({ numberOfChannels: 1, sampleRate: SR, getChannelData: () => buf }),
    } as unknown as BaseAudioContext;
    const t = track(777, { preview: 'https://example.invalid/p.mp3' });
    const [a, b] = await Promise.all([analyzePreview(fakeCtx, t, fakeFetch), analyzePreview(fakeCtx, t, fakeFetch)]);
    assert.equal(fetches, 1);
    assert.equal(a, b);
    assert.equal(getCachedAnalysis(777), a);
    assert.ok(Math.abs(a.bpm - 124) <= 1);
    await analyzePreview(fakeCtx, t, fakeFetch);
    assert.equal(fetches, 1);
    await assert.rejects(analyzePreview(fakeCtx, track(778), fakeFetch));
  });

  await test('tempoStability hors ligne : fixe > 0,9 ; dérive 100->104 < 0,5 ; rubato ±6 % < 0,3', () => {
    const fixed = analyzeBuffer(drumAt(beatsFixed(100, 30), 30), SR, track(40));
    const fixed124 = analyzeBuffer(drumLoop({ bpm: 124, seconds: 30, hats: 'eighths', snare24: true }), SR, track(41));
    const drift = analyzeBuffer(drumAt(beatsDrift(100, 104, 30), 30), SR, track(42));
    const rub = analyzeBuffer(drumAt(beatsRubato(100, 0.06, 30), 30), SR, track(43));
    const rub3 = analyzeBuffer(drumAt(beatsRubato(100, 0.03, 30, 9), 30), SR, track(44));
    results.push(`tempoStability hors ligne : fixe 100 ${fixed.tempoStability} ; fixe 124 complet ${fixed124.tempoStability} ; dérive 100->104 ${drift.tempoStability} ; rubato ±3 % ${rub3.tempoStability} ; rubato ±6 % ${rub.tempoStability}`);
    assert.ok((fixed.tempoStability ?? 0) > 0.9, `fixe ${fixed.tempoStability}`);
    assert.ok((fixed124.tempoStability ?? 0) > 0.9, `fixe 124 ${fixed124.tempoStability}`);
    assert.ok((drift.tempoStability ?? 1) < 0.5, `dérive ${drift.tempoStability}`);
    assert.ok((rub.tempoStability ?? 1) < 0.3, `rubato ${rub.tempoStability}`);
    assert.ok((rub3.tempoStability ?? 1) < 0.5, `rubato ±3 % ${rub3.tempoStability}`);
  });

  // ------------------------------------------------------------------------------------------
  // Direct
  // ------------------------------------------------------------------------------------------

  /** Pousse un signal par trames de `frame` échantillons, ctx = ctx0 + temps. */
  function feed(tr: LiveBeatTracker, sig: Float32Array, ctx0: number, frame: number, onFrame?: (ctxEnd: number) => void, sr = SR): void {
    for (let s = 0; s + frame <= sig.length; s += frame) {
      const end = ctx0 + (s + frame) / sr;
      tr.push(sig.subarray(s, s + frame), end);
      onFrame?.(end);
    }
  }

  await test('LiveBeatTracker : kick 126 BPM accentué sur le 1, avec a priori -> bpm et premier temps (< 30 ms)', () => {
    const bpm = 126, P = 60 / bpm, off = 0.137, ctx0 = 12.345;
    const sig = drumLoop({ bpm, seconds: 40, accent: 1, offset: off });
    const tr = new LiveBeatTracker({ sampleRate: SR, bpmHint: 126 });
    feed(tr, sig, ctx0, 1024);
    const st = tr.getState();
    assert.ok(st, 'pas d\'état');
    const bar = 4 * P;
    const firstDown = ctx0 + off;
    const ph = ((st.downbeatCtx - firstDown) % bar + bar) % bar;
    const err = Math.min(ph, bar - ph);
    results.push(`direct 126 (a priori) : ${st.bpm} BPM, erreur premier temps ${(err * 1000).toFixed(1)} ms, confiance ${st.beatConfidence.toFixed(2)}, temps n° ${st.beatIndex}`);
    assert.ok(Math.abs(st.bpm - bpm) < 0.5, `bpm ${st.bpm}`);
    assert.ok(err < 0.03, `erreur premier temps ${(err * 1000).toFixed(1)} ms`);
    assert.ok(st.beatConfidence > 0.5, `confiance ${st.beatConfidence}`);
    assert.ok(st.nextPhraseCtx !== undefined && st.nextPhraseCtx > ctx0 + 40 - 1e-6, 'nextPhraseCtx');
    const k = (st.nextPhraseCtx! - firstDown) / P;
    assert.ok(Math.abs(k - Math.round(k)) < 0.1 && Math.round(k) % 4 === 0, `phrase non calée sur un premier temps (${k})`);
  });

  await test('LiveBeatTracker : 126 BPM sans a priori, trames de 2048, phase stable (pas de saut)', () => {
    const bpm = 126, P = 60 / bpm, off = 0.41, ctx0 = 3;
    const sig = drumLoop({ bpm, seconds: 40, accent: 1, offset: off, hats: 'eighths' });
    const tr = new LiveBeatTracker({ sampleRate: SR });
    let prevDown: number | undefined;
    let maxJump = 0;
    feed(tr, sig, ctx0, 2048, (end) => {
      const st = tr.getState();
      if (!st || end < ctx0 + 15) return;
      if (prevDown !== undefined) {
        const bar = 4 * P;
        let d = (st.downbeatCtx - prevDown) % bar;
        if (d > bar / 2) d -= bar;
        if (d < -bar / 2) d += bar;
        maxJump = Math.max(maxJump, Math.abs(d));
      }
      prevDown = st.downbeatCtx;
    });
    const st = tr.getState()!;
    const bar = 4 * P;
    const ph = ((st.downbeatCtx - (ctx0 + off)) % bar + bar) % bar;
    const err = Math.min(ph, bar - ph);
    results.push(`direct 126 (sans a priori, trames 2048) : ${st.bpm} BPM, erreur premier temps ${(err * 1000).toFixed(1)} ms, saut max ${(maxJump * 1000).toFixed(1)} ms`);
    assert.ok(Math.abs(st.bpm - bpm) < 1, `bpm ${st.bpm}`);
    assert.ok(err < 0.03, `erreur ${(err * 1000).toFixed(1)} ms`);
    assert.ok(maxJump < 0.01, `saut de phase ${(maxJump * 1000).toFixed(1)} ms`);
  });

  await test('LiveBeatTracker : breakdown (32 temps sans kick) puis drop, grille de phrase réancrée', () => {
    const bpm = 124, P = 60 / bpm, ctx0 = 100;
    const BODY = 64, BREAK = 32, AFTER = 48;
    const total = BODY + BREAK + AFTER;
    const sig = drumLoop({
      bpm, seconds: total * P + 0.5, accent: 1, hats: 'off',
      kickOn: (b) => b < BODY || b >= BODY + BREAK,
      riser: (b) => (b >= BODY + 16 && b < BODY + BREAK ? 0.02 * (b - BODY - 15) : 0),
    });
    const tr = new LiveBeatTracker({ sampleRate: SR, bpmHint: 124 });
    const seen: Array<{ s: Section; t: number }> = [];
    let phraseAfterDrop: number | undefined;
    let downAfterDrop: number | undefined;
    feed(tr, sig, ctx0, 1024, (end) => {
      const st = tr.getState();
      if (!st) return;
      if (!seen.length || seen[seen.length - 1].s !== st.section) seen.push({ s: st.section, t: end - ctx0 });
      if (st.section === 'drop') { phraseAfterDrop = st.nextPhraseCtx; downAfterDrop = st.downbeatCtx; }
    });
    const order = seen.map((x) => `${x.s}@${(x.t / P).toFixed(0)}`).join(' > ');
    results.push(`sections (temps) : ${order}`);
    const iB = seen.findIndex((x) => x.s === 'breakdown');
    const iD = seen.findIndex((x) => x.s === 'drop');
    assert.ok(iB >= 0, `pas de breakdown : ${order}`);
    assert.ok(iD > iB, `pas de drop après le breakdown : ${order}`);
    const tBreak = seen[iB].t / P, tDrop = seen[iD].t / P;
    assert.ok(tBreak > BODY && tBreak < BODY + 16, `breakdown détecté au temps ${tBreak}`);
    assert.ok(tDrop >= BODY + BREAK && tDrop < BODY + BREAK + 2, `drop détecté au temps ${tDrop}`);
    const dropCtx = ctx0 + (BODY + BREAK) * P;
    assert.ok(phraseAfterDrop !== undefined);
    const k = (phraseAfterDrop! - dropCtx) / P;
    assert.ok(Math.abs(k - 32) < 0.15 || Math.abs(k - 16) < 0.15, `prochaine phrase à ${k.toFixed(2)} temps du drop`);
    const kd = (downAfterDrop! - dropCtx) / P;
    assert.ok(Math.abs(kd - Math.round(kd)) < 0.06 && Math.round(kd) % 4 === 0, `premier temps décalé (${kd.toFixed(2)})`);
    const st = tr.getState()!;
    assert.ok(Math.abs(st.bpm - bpm) < 0.5, `bpm ${st.bpm}`);
  });

  await test('LiveBeatTracker.getTempoStability : fixe > 0,9 ; rubato ±6 % < 0,3', () => {
    const run = (beats: number[], hint: number) => {
      const tr = new LiveBeatTracker({ sampleRate: SR, bpmHint: hint });
      assert.equal(tr.getTempoStability(), 0);
      feed(tr, drumAt(beats, 40), 7, 1024);
      return tr.getTempoStability();
    };
    const fixed = run(beatsFixed(100, 40), 100);
    const drift = run(beatsDrift(100, 104, 40), 100);
    const rub = run(beatsRubato(100, 0.06, 40), 100);
    results.push(`tempoStability direct : fixe ${fixed.toFixed(2)} ; dérive 100->104 ${drift.toFixed(2)} ; rubato ±6 % ${rub.toFixed(2)}`);
    assert.ok(fixed > 0.9, `fixe ${fixed}`);
    assert.ok(rub < 0.3, `rubato ${rub}`);
  });

  await test('LiveBeatTracker : reset + outro avec durée connue', () => {
    const bpm = 124, ctx0 = 50;
    const sig = drumLoop({ bpm, seconds: 20, accent: 1 });
    const tr = new LiveBeatTracker({ sampleRate: SR, bpmHint: 124 });
    tr.setTrackPosition(200, ctx0, 215);
    feed(tr, sig, ctx0, 1024);
    assert.equal(tr.getState()?.section, 'outro');
    tr.reset(124);
    assert.equal(tr.getState(), undefined);
  });

  console.log('\nRésultats :');
  for (const r of results) console.log(`  - ${r}`);
  if (failures) {
    console.log(`\n${failures} test(s) en échec`);
    process.exit(1);
  }
  console.log('\nTous les tests passent.');
}

main().catch((e) => { console.error(e); process.exit(1); });
