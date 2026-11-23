/**
 * Tests du cerveau DJ : npx tsx shared/brain/brain.test.ts
 * Petit simulateur : horloge fictive, deux platines simulées, LiveAnalysis synthétique (grille de
 * phrases de 32 temps, sections intro / body / build / drop / breakdown / outro).
 */
import assert from 'node:assert/strict';
import type {
  BrainDecision, BrainInput, Camelot, CrowdState, DeckCapabilities, DeckId, DeckState, DjSettings, FxCue, Genre, GroovePlan, TrackStructure,
  LiveAnalysis, PlayedTrack, QueueItem, Section, StyleProfileId, TrackAnalysis, TrackRef, TransitionPlan, TransitionTechnique,
} from '../contracts';
import { GENRES, GENRE_LABELS, RATE_LIMITS } from '../contracts';
import {
  camelotDistance, chooseTechnique, createBrain, DEFAULT_SETTINGS, GENRE_BPM, GENRE_GRAPH, genrePath, harmonicScore,
  checkReEdit, isElectronic, NO_GRID_TECHNIQUES, scoreCandidate, STYLE_PROFILES, SYNC_TECHNIQUES, targetBpmAt, tempoMatch,
} from './index';
import type { ScoreContext } from './index';

// --------------------------------------------------------------------------------------------- outils

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}`);
    console.log(e instanceof Error ? e.stack ?? e.message : e);
  }
}

// --------------------------------------------------------------------------------------------- catalogue

interface SimTrack { track: TrackRef; analysis: TrackAnalysis; genre: Genre }

function makeCatalogue(seed = 7, perGenre = 40): Map<number, SimTrack> {
  const r = mulberry32(seed);
  const cat = new Map<number, SimTrack>();
  GENRES.forEach((g, gi) => {
    const [lo, hi] = GENRE_BPM[g];
    for (let i = 0; i < perGenre; i++) {
      const id = (gi + 1) * 1000 + i;
      const bpm = Math.round((lo + r() * (hi - lo)) * 10) / 10;
      const duration = Math.round(isElectronic(g) ? 300 + r() * 120 : 170 + r() * 90);
      const key = `${1 + Math.floor(r() * 12)}${r() < 0.5 ? 'A' : 'B'}` as Camelot;
      const track: TrackRef = {
        id, title: `${GENRE_LABELS[g]} n°${i}`, artist: `Artiste ${g} ${i % 13}`, duration, rank: Math.floor(r() * 900000), genres: [g],
      };
      const analysis: TrackAnalysis = {
        trackId: id, bpm, bpmConfidence: 0.9, key, keyConfidence: 0.8, energy: 0.4 + r() * 0.55, danceability: 0.8,
        brightness: 0.5, vocalness: isElectronic(g) ? 0.2 + r() * 0.4 : 0.5 + r() * 0.4, loudnessDb: -9, genres: [g], analyzedAt: 0,
        tempoStability: isElectronic(g) ? 0.97 : i % 7 === 0 ? undefined : 0.6 + r() * 0.4,
      };
      cat.set(id, { track, analysis, genre: g });
    }
  });
  return cat;
}
const CATALOGUE = makeCatalogue();

const SECTION_ENERGY: Record<Section, number> = { intro: 0.4, body: 0.6, build: 0.7, drop: 0.9, breakdown: 0.3, outro: 0.4, unknown: 0.5 };

/** Structure synthétique du morceau complet, cohérente avec la LiveAnalysis du simulateur. */
function structureOf(t: SimTrack): TrackStructure {
  const nb = 60 / t.analysis.bpm;
  const ph = 32 * nb;
  const P = Math.floor(t.track.duration / ph);
  const sections: TrackStructure['sections'] = [];
  const runs: number[] = [];
  for (let p = 0; p < P; p++) {
    const sec = simSection(p, P);
    sections.push({ section: sec, startPos: p * ph, endPos: (p + 1) * ph, energy: SECTION_ENERGY[sec] });
    if (sec === 'drop' && (p === 0 || simSection(p - 1, P) !== 'drop')) runs.push(p * ph);
  }
  // le 2e drop est le plus marquant, puis le 1er, puis les autres
  const dropPositions = runs.length >= 2 ? [runs[1], runs[0], ...runs.slice(2)] : runs;
  return { bpm: t.analysis.bpm, firstDownbeatPos: 0, phraseBeats: 32, sections, dropPositions, outroPos: (P - 1) * ph, confidence: 0.8 };
}
function simSection(p: number, P: number): Section {
  return p === 0 ? 'intro' : p >= P - 1 ? 'outro' : SECTION_PATTERN[(p - 1) % SECTION_PATTERN.length];
}
const byGenre = (g: Genre) => [...CATALOGUE.values()].filter((t) => t.genre === g);

// --------------------------------------------------------------------------------------------- simulateur

interface SimDeck {
  id: DeckId;
  status: DeckState['status'];
  track?: TrackRef;
  analysis?: TrackAnalysis;
  position: number;
  rate: number;
  caps: DeckCapabilities;
  startedCtx: number;
  readyAt: number;
  relax?: { from: number; to: number; t0: number; t1: number };
}

interface TransitionRecord {
  plan: TransitionPlan;
  atNow: number;
  outTrack?: TrackRef;
  outGenre?: Genre;
  inTrack: TrackRef;
  inGenre?: Genre;
  played?: number;      // secondes jouées du sortant au début de la transition
  phaseDist?: number;   // distance (en temps) au début de phrase le plus proche
  endsBeforeOut?: boolean;
  outReliable: boolean;
  endCtx: number;
  phaseDistIn?: number;
  outSectionEnd?: Section;
  shortened?: boolean;
}

interface SimOptions {
  style?: StyleProfileId;
  fxAmount?: number;
  seed?: number;
  beatConfidence?: number;
  baseGenre?: Genre;
  canSetRate?: boolean;
  loadLatency?: number;
  maxRateDelta?: number;
  random?: () => number;
  targetBpm?: number;
  allowReEdits?: boolean;
  /** Structures des morceaux fournies ; delay : disponibles seulement N s après le chargement. */
  structure?: boolean;
  structureDelay?: number;
  /** Une partie des candidats vient de la radio de l'artiste en cours ('similar'). */
  similar?: boolean;
  minPlay?: number;
  maxPlay?: number;
}

const SECTION_PATTERN: Section[] = ['body', 'build', 'drop', 'drop', 'breakdown', 'build', 'drop', 'drop'];

class Sim {
  nowCtx = 100;
  nowMs = Date.UTC(2026, 10, 21, 22, 0, 0);
  readonly dt = 0.1;
  readonly brain;
  decks: Record<DeckId, SimDeck>;
  queue: QueueItem[] = [];
  requested: Genre[] = [];
  analyzed = new Set<number>();
  crowd: CrowdState;
  settings: DjSettings;
  history: PlayedTrack[] = [];
  active?: TransitionPlan;
  activeEnd = 0;
  incomingStarted = false;
  transitions: TransitionRecord[] = [];
  fx: Array<{ cue: FxCue; now: number }> = [];
  loads: Array<{ now: number; deck: DeckId; track: TrackRef; startAt: number }> = [];
  wants: Array<{ now: number; genre: Genre }> = [];
  rates: Array<{ now: number; deck: DeckId; from: number; rate: number; overBeats: number; reason: string }> = [];
  grooveStarts: Array<{ now: number; plan: GroovePlan; reason: string; trackId?: number }> = [];
  grooveUpdates = 0;
  grooveStops: Array<{ now: number; atCtx: number; fadeBeats: number; bpm: number; deckTrackEnd?: number }> = [];
  groove?: { deck: DeckId; trackId?: number; bpm: number };
  bpmTrace: Array<{ min: number; bpm: number; target: number }> = [];
  logs: string[] = [];
  decisions: BrainDecision[][] = [];
  violations: string[] = [];
  silence = 0;
  started = false;
  beatConfidence: number;
  loadLatency: number;
  keepDecisions = false;
  withStructure: boolean;
  structureDelay: number;
  structureAt = new Map<number, number>();
  withSimilar: boolean;
  skipAt?: number;
  loopOffGrid = 0;

  constructor(o: SimOptions = {}) {
    this.brain = createBrain({ random: o.random ?? mulberry32(o.seed ?? 42) });
    const caps: DeckCapabilities = { canSeek: true, canSetRate: o.canSetRate ?? true, preservesPitch: true, maxRateDelta: o.maxRateDelta ?? 0.3 };
    const mk = (id: DeckId): SimDeck => ({ id, status: 'empty', position: 0, rate: 1, caps: { ...caps }, startedCtx: 0, readyAt: 0 });
    this.decks = { A: mk('A'), B: mk('B') };
    this.beatConfidence = o.beatConfidence ?? 0.9;
    this.withStructure = !!o.structure;
    this.structureDelay = o.structureDelay ?? 0;
    this.withSimilar = !!o.similar;
    this.loadLatency = o.loadLatency ?? 1.5;
    this.settings = {
      ...DEFAULT_SETTINGS, style: o.style ?? 'paris-tech-house', fxAmount: o.fxAmount ?? 0.5,
      baseGenre: o.baseGenre ?? 'tech-house', minPlaySeconds: o.minPlay ?? 30, maxPlaySeconds: o.maxPlay ?? 420,
      targetBpm: o.targetBpm, allowReEdits: o.allowReEdits,
    };
    this.crowd = {
      genreWeights: {}, energy: 0, requests: [], updatedAt: 0,
      host: { blockedGenres: [], blockedTrackIds: [], votesOpen: true, requestsOpen: true, maxRequestsPerGuest: 3 },
    };
  }

  minutes(): number { return (this.nowMs - Date.UTC(2026, 10, 21, 22, 0, 0)) / 60000; }

  private live(d: SimDeck): LiveAnalysis | undefined {
    if (d.status !== 'playing' || !d.analysis || !d.track) return undefined;
    const nb = 60 / d.analysis.bpm;
    const beatPos = d.position / nb;
    const bl = nb / d.rate;
    const nextPhraseIdx = Math.ceil(beatPos / 32 - 1e-9) * 32;
    const p = Math.floor(beatPos / 32);
    const P = Math.floor(d.track.duration / (32 * nb));
    const section: Section = p === 0 ? 'intro' : p >= P - 1 ? 'outro' : SECTION_PATTERN[(p - 1) % SECTION_PATTERN.length];
    return {
      bpm: d.analysis.bpm * d.rate,
      downbeatCtx: this.nowCtx - (beatPos - Math.floor(beatPos / 4) * 4) * bl,
      beatConfidence: this.beatConfidence,
      beatIndex: Math.floor(beatPos),
      energyShort: d.analysis.energy, energyLong: d.analysis.energy, lowEnergy: section === 'breakdown' ? 0.1 : 0.7,
      section,
      nextPhraseCtx: this.nowCtx + (nextPhraseIdx - beatPos) * bl,
      phraseBeats: 32,
    };
  }

  /** Analyse telle que l'orchestrateur la connaît (avec la structure si elle est disponible). */
  analysisOf(id: number): TrackAnalysis | undefined {
    const t = CATALOGUE.get(id);
    if (!t) return undefined;
    if (!this.withStructure) return t.analysis;
    const at = this.structureDelay > 0 ? this.structureAt.get(id) : 0;
    if (at === undefined || this.nowCtx < at) return t.analysis;
    return { ...t.analysis, structure: structureOf(t) };
  }

  private deckState(d: SimDeck): DeckState {
    return {
      id: d.id, status: d.status, track: d.track, analysis: d.track ? this.analysisOf(d.track.id) : undefined, live: this.live(d), position: d.position,
      duration: d.track?.duration ?? 0, rate: d.rate, caps: d.caps,
    };
  }

  private candidates(): BrainInput['candidates'] {
    const out: BrainInput['candidates'] = [];
    for (const g of this.requested) {
      for (const t of byGenre(g)) {
        const hasAna = this.analyzed.has(t.track.id) || t.track.id % 5 !== 0; // 20 % sans analyse au départ
        out.push({ track: t.track, analysis: hasAna ? this.analysisOf(t.track.id) : undefined, genre: g, source: this.withSimilar && t.track.id % 4 === 0 ? 'similar' : 'catalog' });
      }
    }
    return out;
  }

  input(): BrainInput {
    return {
      nowCtx: this.nowCtx, nowMs: this.nowMs,
      decks: { A: this.deckState(this.decks.A), B: this.deckState(this.decks.B) },
      queue: this.queue.map((q) => ({ ...q })), candidates: this.candidates(), crowd: this.crowd, settings: this.settings,
      history: this.history.slice(), activeTransition: this.active, skipRequestedAt: this.skipAt,
      // résultats d'analyse des sons de la file (champ optionnel BrainInputExtras)
      analyses: Object.fromEntries(this.queue.filter((q) => this.analyzed.has(q.track.id) && CATALOGUE.has(q.track.id)).map((q) => [q.track.id, this.analysisOf(q.track.id)!])),
    };
  }

  genreOf(t?: TrackRef): Genre | undefined { return t ? CATALOGUE.get(t.id)?.genre ?? t.genres?.[0] : undefined; }

  private apply(decs: BrainDecision[]): void {
    for (const d of decs) {
      switch (d.type) {
        case 'log': this.logs.push(`[${this.minutes().toFixed(1)} min] ${d.message}`); break;
        case 'want-genre':
          this.wants.push({ now: this.nowCtx, genre: d.genre });
          this.requested = [d.genre, ...this.requested.filter((g) => g !== d.genre)].slice(0, 3);
          assert.ok(d.bpmMin <= d.bpmMax, 'plage de BPM valide');
          break;
        case 'analyze': this.analyzed.add(d.track.id); break;
        case 'load': {
          const deck = this.decks[d.deck];
          if (deck.status === 'playing') this.violations.push(`load sur une platine qui joue (${d.deck})`);
          const g = this.genreOf(d.track);
          if (g && this.crowd.host.blockedGenres.includes(g)) this.violations.push(`load d'un genre bloqué ${g}`);
          this.loads.push({ now: this.nowCtx, deck: d.deck, track: d.track, startAt: d.startAt });
          deck.status = 'loading';
          deck.track = d.track;
          deck.analysis = CATALOGUE.get(d.track.id)?.analysis;
          deck.position = d.startAt;
          deck.rate = 1;
          deck.relax = undefined;
          deck.readyAt = this.nowCtx + this.loadLatency;
          if (this.structureDelay > 0 && !this.structureAt.has(d.track.id)) this.structureAt.set(d.track.id, this.nowCtx + this.structureDelay);
          break;
        }
        case 'transition': {
          const plan = d.plan;
          if (this.active && plan.id === this.active.id) {
            // mise à jour (transition raccourcie après un « suivant »)
            this.active = plan;
            this.activeEnd = plan.startCtx + (plan.beats * 60) / plan.bpm;
            const r = this.transitions[this.transitions.length - 1];
            r.plan = plan;
            r.endCtx = this.activeEnd;
            r.shortened = true;
            break;
          }
          if (this.active) this.violations.push(`transition ${plan.id} pendant ${this.active.id}`);
          if (plan.startCtx < this.nowCtx - 1e-6) this.violations.push(`transition ${plan.id} dans le passé`);
          const inDeck = this.decks[plan.to];
          if (inDeck.status !== 'ready' && !(plan.holdWithLoop && inDeck.status === 'loading')) this.violations.push(`transition vers une platine pas prête (${inDeck.status})`);
          const out = this.decks[plan.from];
          const rec: TransitionRecord = {
            plan, atNow: this.nowCtx, inTrack: inDeck.track!, inGenre: this.genreOf(inDeck.track),
            outReliable: this.beatConfidence >= 0.5, endCtx: plan.startCtx + (plan.beats * 60) / plan.bpm,
          };
          if (out.status === 'playing' && out.track && out.analysis) {
            const nb = 60 / out.analysis.bpm;
            const posAt = out.position + (plan.startCtx - this.nowCtx) * out.rate;
            const phase = ((posAt / nb) % 32 + 32) % 32;
            rec.phaseDist = Math.min(phase, 32 - phase);
            const phIn = ((((out.position + (plan.incomingStartCtx - this.nowCtx) * out.rate) / nb) % 32) + 32) % 32;
            rec.phaseDistIn = Math.min(phIn, 32 - phIn);
            rec.outSectionEnd = simSection(Math.floor((posAt / nb - 0.5) / 32), Math.floor(out.track.duration / (32 * nb)));
            rec.played = plan.startCtx - out.startedCtx;
            const outEnd = this.nowCtx + (out.track.duration - out.position) / out.rate;
            rec.endsBeforeOut = rec.endCtx <= outEnd + 1e-6;
            rec.outTrack = out.track;
            rec.outGenre = this.genreOf(out.track);
          }
          this.transitions.push(rec);
          this.active = plan;
          this.activeEnd = rec.endCtx;
          this.incomingStarted = false;
          break;
        }
        case 'fx': {
          this.fx.push({ cue: d.cue, now: this.nowCtx });
          if (d.cue.kind === 'loop' || d.cue.kind === 'loop-roll') {
            const td = d.cue.target === 'master' ? this.playingDeck() : this.decks[d.cue.target];
            if (td?.analysis) {
              const b = (td.position + (d.cue.atCtx - this.nowCtx) * td.rate) / (60 / td.analysis.bpm);
              if (Math.abs(b - Math.round(b)) > 0.05) this.loopOffGrid++;
            }
          }
          if (this.active) this.violations.push(`effet ${d.cue.kind} pendant la transition ${this.active.id}`);
          const deck = d.cue.target === 'master' ? Object.values(this.decks).find((x) => x.status === 'playing') : this.decks[d.cue.target];
          if (deck && d.cue.atCtx < deck.startedCtx + 8 * (60 / d.cue.bpm) - 1e-6) this.violations.push(`effet ${d.cue.kind} dans les 8 premiers temps`);
          break;
        }
        case 'stop': {
          const deck = this.decks[d.deck];
          if (this.active && this.active.to === d.deck) this.violations.push('stop de la platine entrante');
          deck.status = 'empty'; deck.track = undefined; deck.analysis = undefined; deck.relax = undefined;
          break;
        }
        case 'consume-queue': this.queue = this.queue.filter((q) => q.track.id !== d.trackId); break;
        case 'rate': {
          const deck = this.decks[d.deck];
          if (this.active) this.violations.push('rate pendant une transition');
          if (!deck.caps.canSetRate) this.violations.push('rate sur une platine sans rate');
          const reEditDeck = this.groove?.deck === d.deck;
          const lim = reEditDeck ? RATE_LIMITS.reEdit : Math.min(deck.caps.maxRateDelta, RATE_LIMITS.normal);
          if (Math.abs(d.rate - 1) > lim + 1e-9) this.violations.push(`rate ${d.rate} hors limite ${lim}`);
          if (d.overBeats < 12 || d.overBeats > 32) this.violations.push(`rampe de ${d.overBeats} temps`);
          if (deck.analysis && deck.track) {
            // la rampe ne doit pas toucher les 8 premiers temps d'un drop
            const nb = 60 / deck.analysis.bpm;
            const b0 = deck.position / nb;
            const b1 = b0 + d.overBeats * (Math.max(deck.rate, d.rate) / deck.rate) * 1.01; // temps natifs parcourus
            const P = Math.floor(deck.track.duration / (32 * nb));
            for (let p = Math.floor(b0 / 32); p * 32 <= b1; p++) {
              const sec: Section = p === 0 ? 'intro' : p >= P - 1 ? 'outro' : SECTION_PATTERN[(p - 1) % SECTION_PATTERN.length];
              const prev: Section | undefined = p <= 1 ? undefined : SECTION_PATTERN[(p - 2) % SECTION_PATTERN.length];
              if (sec === 'drop' && prev !== 'drop' && b1 > p * 32 && b0 < p * 32 + 8) this.violations.push(`rampe pendant le début d'un drop (${d.reason}) b0=${b0.toFixed(2)} b1=${b1.toFixed(2)} p=${p}`);
            }
          }
          this.rates.push({ now: this.nowCtx, deck: d.deck, from: deck.rate, rate: d.rate, overBeats: d.overBeats, reason: d.reason });
          deck.relax = { from: deck.rate, to: d.rate, t0: this.nowCtx, t1: this.nowCtx + (d.overBeats * 60) / ((deck.analysis?.bpm ?? 120) * deck.rate) };
          break;
        }
        case 'groove-start': {
          if (d.plan.startCtx < this.nowCtx - 1e-6) this.violations.push('groove-start dans le passé');
          if (this.active) this.violations.push('groove-start émis pendant une transition');
          this.grooveStarts.push({ now: this.nowCtx, plan: d.plan, reason: d.reason, trackId: this.decks[d.plan.deck].track?.id });
          this.groove = { deck: d.plan.deck, trackId: this.decks[d.plan.deck].track?.id, bpm: d.plan.bpm };
          break;
        }
        case 'groove-update': this.grooveUpdates++; break;
        case 'groove-stop': {
          const gd = this.groove ? this.decks[this.groove.deck] : undefined;
          const end = gd?.track && gd.status === 'playing' ? this.nowCtx + (gd.track.duration - gd.position) / gd.rate : undefined;
          if (this.active) this.violations.push('groove-stop émis pendant une transition');
          this.grooveStops.push({ now: this.nowCtx, atCtx: d.atCtx, fadeBeats: d.fadeBeats, bpm: this.groove?.bpm ?? 120, deckTrackEnd: end });
          this.groove = undefined;
          break;
        }
      }
    }
    for (const d of decs) {
      if (d.type === 'transition' && Math.abs(d.plan.incomingRate - 1) > RATE_LIMITS.reEdit + 1e-9) this.violations.push('calage au-delà de la limite re-edit');
    }
  }

  step(): BrainDecision[] {
    const decs = this.brain.tick(this.input());
    if (this.keepDecisions) this.decisions.push(decs);
    this.apply(decs);
    // temps qui passe
    this.nowCtx += this.dt;
    this.nowMs += this.dt * 1000;
    for (const d of Object.values(this.decks)) {
      if (d.status === 'loading' && this.nowCtx >= d.readyAt) d.status = 'ready';
      if (d.status !== 'playing' || !d.track) continue;
      if (d.relax) {
        const k = Math.min(1, Math.max(0, (this.nowCtx - d.relax.t0) / (d.relax.t1 - d.relax.t0)));
        d.rate = d.relax.from + (d.relax.to - d.relax.from) * k;
        if (k >= 1) d.relax = undefined;
      }
      d.position += this.dt * d.rate;
      if (d.position >= d.track.duration) d.status = 'ended';
    }
    const a = this.active;
    if (a && !this.incomingStarted && this.nowCtx >= a.incomingStartCtx && this.decks[a.to].status === 'ready') {
      const d = this.decks[a.to];
      d.status = 'playing';
      d.rate = a.incomingRate;
      d.position = a.incomingStartPos + (this.nowCtx - a.incomingStartCtx) * d.rate;
      d.startedCtx = a.incomingStartCtx;
      if (a.rateRelaxBeats && a.incomingRate !== 1) {
        d.relax = { from: a.incomingRate, to: 1, t0: this.activeEnd, t1: this.activeEnd + (a.rateRelaxBeats * 60) / a.bpm };
      }
      this.incomingStarted = true;
      this.started = true;
      this.history.push({ track: d.track!, startedAt: this.nowMs, genre: this.genreOf(d.track) });
    }
    if (a && this.nowCtx >= this.activeEnd && this.incomingStarted) this.active = undefined;
    if (this.started && !Object.values(this.decks).some((d) => d.status === 'playing')) this.silence += this.dt;
    const pd = this.playingDeck();
    if (pd?.analysis && Math.round(this.nowCtx * 10) % 6000 === 0) {
      const tm = tempoMatch(125, pd.analysis.bpm);
      this.bpmTrace.push({ min: this.minutes(), bpm: pd.analysis.bpm * pd.rate * tm.mult, target: this.settings.targetBpm ?? targetBpmAt(STYLE_PROFILES[this.settings.style], this.minutes()) });
    }
    return decs;
  }

  runFor(seconds: number, hook?: (sim: Sim) => void): void {
    const n = Math.round(seconds / this.dt);
    for (let i = 0; i < n; i++) {
      this.step();
      hook?.(this);
    }
  }

  playingDeck(): SimDeck | undefined { return Object.values(this.decks).find((d) => d.status === 'playing'); }
  played(): TrackRef[] { return this.history.map((h) => h.track); }
  playedGenres(): Genre[] { return this.history.map((h) => h.genre!).filter(Boolean); }
  mixes(): TransitionRecord[] { return this.transitions.filter((t) => t.outTrack); }
  avgPlay(): number {
    const m = this.mixes();
    return m.reduce((a, t) => a + (t.played ?? 0), 0) / Math.max(1, m.length);
  }
}

/** Invariants communs à toutes les simulations. */
function checkInvariants(sim: Sim, label: string): void {
  assert.deepEqual(sim.violations, [], `${label} : violations`);
  const ids = sim.played().map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, `${label} : un morceau a été rejoué`);
  assert.ok(sim.silence < 0.5, `${label} : silence de ${sim.silence.toFixed(1)} s`);
  assert.equal(sim.loopOffGrid, 0, `${label} : boucle hors de la grille`);
  for (const t of sim.mixes()) {
    const where = `${label} : ${t.plan.id} (${t.plan.technique})`;
    assert.ok(t.endsBeforeOut, `${where} finit après la fin du morceau sortant`);
    const skip = /Suivant demandé/.test(t.plan.reason);
    if (!skip) assert.ok((t.played ?? 0) >= sim.settings.minPlaySeconds - 0.01, `${where} avant minPlaySeconds (${t.played?.toFixed(1)} s)`);
    if (t.outReliable && !skip) assert.ok(Math.min(t.phaseDist ?? 99, t.phaseDistIn ?? 99) < 0.3, `${where} pas sur un début de phrase (écart ${t.phaseDist?.toFixed(2)} temps)`);
    assert.ok(t.plan.preRollBeats !== undefined && t.plan.holdWithLoop === true, `${where} : preRollBeats / holdWithLoop absents`);
    assert.ok(t.plan.reason.length > 20, `${where} : raison vide`);
    assert.ok(t.plan.intensity >= 0 && t.plan.intensity <= 1, `${where} : intensité hors bornes`);
  }
  // une seule transition à la fois (intervalles disjoints)
  const tr = sim.transitions;
  for (let i = 1; i < tr.length; i++) assert.ok(tr[i].plan.startCtx >= tr[i - 1].endCtx - 1e-6, `${label} : transitions qui se chevauchent`);
  // groove : jamais de start/stop (ni leur fondu) pendant une transition (la table automatise eqLow)
  const inTr = (a: number, b: number) => tr.find((t) => a < t.endCtx - 1e-6 && b > t.plan.startCtx + 1e-6);
  for (const g of sim.grooveStarts) {
    const t = inTr(g.plan.startCtx, g.plan.startCtx + (g.plan.fadeBeats * 60) / g.plan.bpm);
    assert.ok(!t, `${label} : groove-start pendant ${t?.plan.id}`);
  }
  for (const g of sim.grooveStops) {
    const t = inTr(g.atCtx, g.atCtx + (g.fadeBeats * 60) / g.bpm - 0.02);
    assert.ok(!t, `${label} : groove-stop pendant ${t?.plan.id}`);
    if (g.deckTrackEnd !== undefined) assert.ok(g.atCtx <= g.deckTrackEnd, `${label} : groove-stop après la fin du morceau`);
  }
  // un calage au-delà de 8 % n'existe qu'en re-edit (un groove suit sur ce morceau)
  for (const t of tr) {
    if (Math.abs(t.plan.incomingRate - 1) <= RATE_LIMITS.normal + 1e-9) continue;
    assert.ok(sim.grooveStarts.some((g) => g.trackId === t.inTrack.id), `${label} : calage ${t.plan.incomingRate} sans groove`);
    assert.ok(/Re-edit/.test(t.plan.reason), `${label} : raison sans re-edit`);
  }
  // effets jamais pendant une transition
  for (const f of sim.fx) {
    const a = f.cue.atCtx;
    const b = a + (f.cue.beats * 60) / f.cue.bpm;
    for (const t of tr) {
      const overlap = a < t.endCtx - 1e-6 && b > t.plan.startCtx + 1e-6;
      assert.ok(!overlap, `${label} : effet ${f.cue.kind} pendant ${t.plan.id}`);
    }
  }
}

// --------------------------------------------------------------------------------------------- tests unitaires

test('camelotDistance', () => {
  assert.equal(camelotDistance('8A', '8A'), 0);
  assert.equal(camelotDistance('8A', '9A'), 1);
  assert.equal(camelotDistance('12A', '1A'), 1);
  assert.equal(camelotDistance('8A', '8B'), 1);
  assert.equal(camelotDistance('8A', '10A'), 2);
  assert.equal(camelotDistance('1A', '7A'), 6);
  assert.equal(camelotDistance('1A', '7B'), 7);
});

test('harmonicScore cohérent', () => {
  assert.equal(harmonicScore('8A', '8A'), 1);
  assert.equal(harmonicScore(undefined, '8A'), 0.5);
  assert.equal(harmonicScore('8A', undefined), 0.5);
  const s1 = harmonicScore('8A', '9A');
  const sRel = harmonicScore('8A', '8B');
  const sBoost = harmonicScore('8A', '10A');
  const sFar = harmonicScore('8A', '2B');
  assert.ok(1 > s1 && s1 >= sRel && sRel > sBoost && sBoost > 0.5 && 0.5 > sFar, `ordre ${s1} ${sRel} ${sBoost} ${sFar}`);
  assert.equal(harmonicScore('12B', '1B'), harmonicScore('1B', '12B'));
  assert.ok(harmonicScore('8A', '10A') > harmonicScore('8A', '6A'), '+2 (boost) mieux que -2');
  for (const a of ['1A', '5B', '11A'] as Camelot[]) for (const b of ['2A', '5A', '12B'] as Camelot[]) {
    const h = harmonicScore(a, b);
    assert.ok(h >= 0 && h <= 1);
  }
});

test('GENRE_BPM et GENRE_GRAPH', () => {
  for (const g of GENRES) {
    const [lo, hi] = GENRE_BPM[g];
    assert.ok(lo < hi && lo >= 60 && hi <= 180, g);
    assert.ok(Object.keys(GENRE_GRAPH[g]).length > 0, `${g} isolé`);
    for (const [h, c] of Object.entries(GENRE_GRAPH[g]) as Array<[Genre, number]>) assert.equal(GENRE_GRAPH[h][g], c, 'graphe symétrique');
  }
});

test('genrePath : ponts attendus', () => {
  assert.deepEqual(genrePath('80s', 'tech-house'), ['80s', 'nu-disco', 'house', 'tech-house']);
  assert.deepEqual(genrePath('tech-house', '80s'), ['tech-house', 'house', 'nu-disco', '80s']);
  assert.deepEqual(genrePath('rap-fr', 'tech-house'), ['rap-fr', 'afro', 'afro-house', 'tech-house']);
  assert.deepEqual(genrePath('reggaeton', 'tech-house').slice(0, 3), ['reggaeton', 'latino', 'afro-house']);
  assert.deepEqual(genrePath('house', 'house'), ['house']);
  assert.deepEqual(genrePath('house', 'tech-house'), ['house', 'tech-house']);
  const avoid = genrePath('tech-house', '80s', ['house']);
  assert.ok(!avoid.includes('house') && avoid[0] === 'tech-house' && avoid[avoid.length - 1] === '80s', avoid.join('>'));
  for (const a of GENRES) for (const b of GENRES) {
    const p = genrePath(a, b);
    assert.equal(p[0], a);
    assert.equal(p[p.length - 1], b);
    for (let i = 1; i < p.length; i++) assert.ok(GENRE_GRAPH[p[i - 1]][p[i]] !== undefined, `${a}->${b} : étapes non voisines`);
  }
});

test('tempoMatch : demi / double tempo', () => {
  assert.equal(tempoMatch(128, 64).mult, 2);
  assert.ok(tempoMatch(128, 64).pct < 1e-9);
  assert.equal(tempoMatch(85, 170).mult, 0.5);
  assert.ok(Math.abs(tempoMatch(126, 124).rate - 126 / 124) < 1e-9);
});

test('chooseTechnique : filtres', () => {
  const r = mulberry32(3);
  for (let i = 0; i < 300; i++) {
    for (const id of Object.keys(STYLE_PROFILES) as StyleProfileId[]) {
      const profile = STYLE_PROFILES[id];
      for (const situation of ['same-genre', 'genre-change', 'tempo-jump', 'breakdown', 'outro', 'emergency'] as const) {
        const noGrid = chooseTechnique({ profile, situation, syncOk: true, beatReliable: false, outgoingGenre: 'tech-house', incomingGenre: 'house', random: r });
        assert.ok(NO_GRID_TECHNIQUES.has(noGrid), `${id}/${situation} grille peu fiable -> ${noGrid}`);
        const noSync = chooseTechnique({ profile, situation, syncOk: false, beatReliable: true, outgoingGenre: 'tech-house', incomingGenre: 'rap-fr', random: r });
        assert.ok(!SYNC_TECHNIQUES.has(noSync), `${id}/${situation} sans calage -> ${noSync}`);
        if (id === 'lounge') {
          const t = chooseTechnique({ profile, situation, syncOk: true, beatReliable: true, random: r });
          assert.ok(t !== 'riser-drop' && t !== 'loop-roll', `lounge -> ${t}`);
        }
      }
    }
  }
  // paris, même genre électronique : surtout des blends
  const counts: Partial<Record<TransitionTechnique, number>> = {};
  for (let i = 0; i < 500; i++) {
    const t = chooseTechnique({ profile: STYLE_PROFILES['paris-tech-house'], situation: 'same-genre', syncOk: true, beatReliable: true, outgoingGenre: 'tech-house', incomingGenre: 'tech-house', random: r });
    counts[t] = (counts[t] ?? 0) + 1;
  }
  assert.ok((counts['long-blend'] ?? 0) > 250, JSON.stringify(counts));
});

test('scoreCandidate : exclusions et préférences', () => {
  const base: ScoreContext = {
    refBpm: 125, refKey: '8A', targetEnergy: 0.7, targetBpm: 125, stepGenre: 'tech-house', targetGenre: 'tech-house', path: ['tech-house'],
    blockedGenres: new Set(['techno']), blockedIds: new Set([42]), recentPlays: new Map([[7, Date.now() - 3600_000]]), nowMs: Date.now(),
    recentArtists: ['dj truc'], excludeIds: new Set(),
  };
  const mk = (id: number, bpm: number, key: Camelot, genre: Genre, artist = 'X'): Parameters<typeof scoreCandidate>[0] => ({
    track: { id, title: 't', artist, duration: 300, genres: [genre] }, genre, source: 'candidate',
    analysis: { trackId: id, bpm, bpmConfidence: 1, key, energy: 0.7, danceability: 1, brightness: 0.5, loudnessDb: -8, genres: [genre], analyzedAt: 0 },
  });
  assert.equal(scoreCandidate(mk(1, 125, '8A', 'techno'), base).excluded, 'genre bloqué');
  assert.ok(scoreCandidate(mk(42, 125, '8A', 'tech-house'), base).excluded);
  assert.ok(scoreCandidate(mk(7, 125, '8A', 'tech-house'), base).excluded, 'rejoué < 2 h');
  assert.ok(scoreCandidate(mk(8, 125, '8A', 'tech-house', 'DJ Truc'), base).excluded, 'artiste récent');
  const good = scoreCandidate(mk(2, 125, '9A', 'tech-house'), base).score;
  const farTempo = scoreCandidate(mk(3, 100, '9A', 'tech-house'), base).score;
  const farKey = scoreCandidate(mk(4, 125, '2B', 'tech-house'), base).score;
  const otherGenre = scoreCandidate(mk(5, 125, '9A', 'reggaeton'), base).score;
  assert.ok(good > farTempo && good > farKey && good > otherGenre, `${good} ${farTempo} ${farKey} ${otherGenre}`);
  const host = scoreCandidate({ ...mk(9, 125, '8A', 'techno'), source: 'queue', queueSource: 'host' }, base);
  assert.ok(!host.excluded, 'l’hôte peut forcer un genre bloqué pour les invités');
});

// --------------------------------------------------------------------------------------------- simulations

test('démarrage à vide : want-genre puis load puis lecture', () => {
  const sim = new Sim();
  const first = sim.step();
  const want = first.find((d) => d.type === 'want-genre');
  assert.ok(want && want.type === 'want-genre' && want.genre === 'tech-house', 'want-genre tech-house au premier tick');
  assert.ok(!first.some((d) => d.type === 'load'), 'pas de load sans candidats');
  sim.runFor(5);
  assert.ok(sim.loads.length >= 1, 'load émis');
  assert.ok(sim.loads[0].now > sim.wants[0].now - 1e-9, 'load après want-genre');
  assert.equal(sim.transitions[0]?.plan.technique, 'cut', 'ouverture en cut');
  assert.ok(sim.playingDeck(), 'une platine joue');
  assert.equal(sim.playingDeck()!.track!.id, sim.loads[0].track.id);
  assert.equal(sim.genreOf(sim.playingDeck()!.track), 'tech-house');
});

test('paris-tech-house 45 min : phrases, minPlay, fin du morceau, une transition à la fois', () => {
  const sim = new Sim({ seed: 1 });
  sim.runFor(45 * 60);
  checkInvariants(sim, 'paris');
  assert.ok(sim.mixes().length >= 6, `assez de transitions (${sim.mixes().length})`);
  const blends = sim.mixes().filter((t) => ['long-blend', 'bass-swap', 'filter-swap'].includes(t.plan.technique)).length;
  assert.ok(blends / sim.mixes().length >= 0.6, 'surtout des blends calés');
  const lb = sim.mixes().filter((t) => t.plan.technique === 'long-blend');
  assert.ok(lb.length > 0 && lb.every((t) => t.plan.beats >= 16), 'blends longs');
  for (const t of sim.mixes()) if (SYNC_TECHNIQUES.has(t.plan.technique)) assert.equal(t.plan.incomingStartCtx, t.plan.startCtx);
  assert.ok(sim.avgPlay() >= 150, `morceaux joués longtemps (${sim.avgPlay().toFixed(0)} s)`);
  const genres = new Set(sim.playedGenres());
  assert.deepEqual([...genres], ['tech-house'], 'reste en tech house sans votes');
});

test('la file passe avant les candidats', () => {
  const sim = new Sim({ seed: 2 });
  const hostTrack = byGenre('house')[3].track;
  sim.queue.push({ track: hostTrack, source: 'host', addedAt: sim.nowMs, genre: 'house' });
  sim.runFor(5);
  assert.equal(sim.played()[0]?.id, hostTrack.id, 'le son de l’hôte ouvre la soirée');
  sim.runFor(60);
  assert.equal(sim.queue.length, 0, 'consume-queue après la transition');
  // ajout en cours de lecture : c'est le suivant
  const t2 = byGenre('tech-house')[5].track;
  sim.queue.push({ track: t2, source: 'host', addedAt: sim.nowMs, genre: 'tech-house' });
  const before = sim.played().length;
  sim.runFor(10 * 60);
  assert.equal(sim.played()[before]?.id, t2.id, 'le son ajouté passe juste après');
  checkInvariants(sim, 'file');
});

test('ajout en tête de file pendant la préparation -> nouveau load', () => {
  const sim = new Sim({ seed: 3 });
  // attendre que le premier morceau joue et que le suivant soit préparé
  let guard = 0;
  while (!(sim.history.length === 1 && sim.loads.length >= 2 && !sim.active) && guard++ < 20000) sim.step();
  assert.ok(guard < 20000, 'préparation atteinte');
  const prepared = sim.loads[sim.loads.length - 1];
  assert.equal(sim.transitions.length, 1, 'pas encore de transition');
  const head = byGenre('tech-house')[11].track;
  sim.queue.unshift({ track: head, source: 'host', addedAt: sim.nowMs, genre: 'tech-house' });
  sim.runFor(1);
  const reload = sim.loads[sim.loads.length - 1];
  assert.equal(reload.track.id, head.id, 'nouveau load du son en tête');
  assert.equal(reload.deck, prepared.deck, 'sur la même platine libre');
  sim.runFor(8 * 60);
  assert.equal(sim.played()[1]?.id, head.id, 'c’est lui qui passe');
  // retrait de la file pendant la préparation : on reprend un candidat
  let g2 = 0;
  while (!(sim.loads.length > 0 && sim.loads[sim.loads.length - 1].now > sim.transitions[sim.transitions.length - 1].atNow && !sim.active) && g2++ < 20000) sim.step();
  const extra = byGenre('tech-house')[12].track;
  sim.queue.unshift({ track: extra, source: 'host', addedAt: sim.nowMs });
  sim.runFor(1);
  assert.equal(sim.loads[sim.loads.length - 1].track.id, extra.id);
  sim.queue = [];
  sim.runFor(1);
  assert.notEqual(sim.loads[sim.loads.length - 1].track.id, extra.id, 'retiré de la file -> autre morceau chargé');
  checkInvariants(sim, 'tête de file');
});

function adjacentOrSame(a?: Genre, b?: Genre): boolean {
  return !a || !b || a === b || GENRE_GRAPH[a][b] !== undefined;
}

test('vote massif 80s depuis la tech house : chemin par des genres intermédiaires', () => {
  const sim = new Sim({ seed: 4 });
  sim.runFor(12 * 60);
  const nBefore = sim.history.length;
  sim.crowd.genreWeights = { '80s': 30, 'tech-house': 2 };
  sim.runFor(80 * 60);
  checkInvariants(sim, 'vote 80s');
  const after = sim.playedGenres().slice(nBefore - 1);
  const i80 = after.indexOf('80s');
  assert.ok(i80 > 0, `les 80s arrivent (${after.join(' > ')})`);
  const bridge = after.slice(0, i80);
  assert.ok(bridge.includes('house') && bridge.includes('nu-disco'), `pont house + nu-disco (${after.join(' > ')})`);
  for (let i = 1; i < after.length; i++) assert.ok(adjacentOrSame(after[i - 1], after[i]), `saut ${after[i - 1]} -> ${after[i]}`);
  assert.ok(sim.wants.some((w) => w.genre === 'nu-disco'), 'want-genre nu-disco émis');
  const tr = sim.mixes().find((t) => t.outGenre === 'tech-house' && t.inGenre === 'house');
  assert.ok(tr && /Passage Tech house vers House/.test(tr.plan.reason), tr?.plan.reason ?? 'pas de passage tech house -> house');
});

test('genre bloqué jamais joué (et contourné par le chemin)', () => {
  const sim = new Sim({ seed: 5 });
  sim.crowd.host.blockedGenres = ['house'];
  sim.runFor(11 * 60);
  sim.crowd.genreWeights = { '80s': 30, house: 50 };
  sim.runFor(80 * 60);
  checkInvariants(sim, 'bloqué');
  assert.ok(!sim.playedGenres().includes('house'), 'house jamais jouée');
  assert.ok(!sim.loads.some((l) => sim.genreOf(l.track) === 'house'), 'house jamais chargée');
  assert.ok(sim.playedGenres().includes('80s'), `80s atteintes (${sim.playedGenres().join(' > ')})`);
});

test('pas de répétition sur 2 h même avec un petit catalogue de genre', () => {
  const sim = new Sim({ seed: 6, style: 'open-format' });
  sim.runFor(100 * 60);
  checkInvariants(sim, 'répétitions');
  assert.ok(sim.played().length > 40, `beaucoup de morceaux (${sim.played().length})`);
  const artists = sim.played().map((t) => t.artist);
  let repeats = 0;
  for (let i = 1; i < artists.length; i++) if (artists.slice(Math.max(0, i - 3), i).includes(artists[i])) repeats++;
  assert.equal(repeats, 0, 'pas d’artiste répété dans les 3 derniers');
});

test('open-format sort plus tôt que paris-tech-house', () => {
  const paris = new Sim({ seed: 7 });
  const open = new Sim({ seed: 7, style: 'open-format' });
  const openRap = new Sim({ seed: 7, style: 'open-format', baseGenre: 'rap-fr' });
  paris.runFor(60 * 60);
  open.runFor(60 * 60);
  openRap.runFor(40 * 60);
  checkInvariants(paris, 'paris');
  checkInvariants(open, 'open');
  checkInvariants(openRap, 'open rap');
  assert.ok(open.avgPlay() < paris.avgPlay() * 0.6, `open ${open.avgPlay().toFixed(0)} s vs paris ${paris.avgPlay().toFixed(0)} s`);
  assert.ok(openRap.avgPlay() <= 100, `rap en open-format : mix rapides (${openRap.avgPlay().toFixed(0)} s)`);
  const rapTech = new Set(openRap.mixes().map((t) => t.plan.technique));
  assert.ok(!rapTech.has('long-blend') || openRap.mixes().filter((t) => t.plan.technique === 'long-blend').length <= 2, 'peu de longs blends sur du rap');
  assert.ok(openRap.loads.some((l) => l.startAt > 0), 'départ après l’intro pour le rap');
});

test('beatConfidence faible -> techniques sans calage', () => {
  const sim = new Sim({ seed: 8, beatConfidence: 0.2 });
  sim.runFor(45 * 60);
  checkInvariants(sim, 'beat faible');
  assert.ok(sim.mixes().length >= 5);
  for (const t of sim.mixes()) {
    assert.ok(NO_GRID_TECHNIQUES.has(t.plan.technique), `technique ${t.plan.technique}`);
    assert.equal(t.plan.incomingRate, 1);
    assert.ok(/peu fiable/.test(t.plan.reason));
  }
});

test('platine sans calage de tempo : rate 1', () => {
  const sim = new Sim({ seed: 9, canSetRate: false });
  sim.runFor(40 * 60);
  checkInvariants(sim, 'sans rate');
  for (const t of sim.transitions) assert.equal(t.plan.incomingRate, 1);
});

test('effets : jamais pendant une transition, budget respecté', () => {
  const sim = new Sim({ seed: 10, style: 'peak-time', fxAmount: 1 });
  sim.runFor(60 * 60);
  checkInvariants(sim, 'peak fx');
  assert.ok(sim.fx.length >= 5, `des effets en peak-time (${sim.fx.length})`);
  const paris = new Sim({ seed: 10, fxAmount: 0.5 });
  paris.runFor(60 * 60);
  checkInvariants(paris, 'paris fx');
  assert.ok(paris.fx.length < sim.fx.length, `paris plus sobre (${paris.fx.length} vs ${sim.fx.length})`);
  assert.ok(!paris.fx.some((f) => f.cue.kind === 'gate'), 'pas de gate en paris');
  const clean = new Sim({ seed: 10, fxAmount: 0 });
  clean.runFor(30 * 60);
  assert.equal(clean.fx.length, 0, 'fxAmount 0 : aucun effet');
  assert.ok(clean.transitions.every((t) => t.plan.accents.length === 0 && t.plan.intensity === 0));
  const lounge = new Sim({ seed: 10, style: 'lounge', fxAmount: 1 });
  lounge.runFor(40 * 60);
  checkInvariants(lounge, 'lounge');
  assert.ok(!lounge.fx.some((f) => f.cue.kind === 'gate' || f.cue.kind === 'riser'), 'lounge : ni gate ni riser');
  assert.ok(!lounge.transitions.some((t) => t.plan.technique === 'riser-drop' || t.plan.technique === 'loop-roll'));
});

test('maxPlaySeconds respecté', () => {
  const sim = new Sim({ seed: 11, maxPlay: 120 });
  sim.runFor(40 * 60);
  checkInvariants(sim, 'max');
  for (const t of sim.mixes()) assert.ok(t.endCtx - (t.plan.startCtx - (t.played ?? 0)) <= 120 + 1e-6, `${t.plan.id} dépasse maxPlay`);
});

test('reset : reprend le morceau qui joue sans tout casser', () => {
  const sim = new Sim({ seed: 12 });
  sim.runFor(5 * 60);
  sim.brain.reset();
  sim.runFor(20 * 60);
  // après un reset, la mémoire des passages est perdue mais l'historique (input.history) protège
  checkInvariants(sim, 'reset');
});

// --------------------------------------------------------------------------------------------- tempo et re-edit

const CAPS30: DeckCapabilities = { canSeek: true, canSetRate: true, preservesPitch: true, maxRateDelta: 0.3 };

test('checkReEdit : acceptations et refus', () => {
  const paris = STYLE_PROFILES['paris-tech-house'];
  const ok = checkReEdit({ bpm: 104, tempoStability: 0.93 }, 124, CAPS30, {}, paris);
  assert.ok(ok.ok && ok.mult === 1 && Math.abs(ok.rate - 124 / 104) < 1e-9, JSON.stringify(ok));
  assert.match(checkReEdit({ bpm: 104, tempoStability: 0.6 }, 124, CAPS30, {}, paris).reason, /instable/);
  assert.ok(!checkReEdit({ bpm: 104, tempoStability: 0.93 }, 124, { ...CAPS30, maxRateDelta: 0.08 }, {}, paris).ok, 'caps à 8 %');
  assert.ok(!checkReEdit({ bpm: 104, tempoStability: 0.93 }, 124, { ...CAPS30, canSetRate: false }, {}, paris).ok, 'pas de rate');
  assert.ok(!checkReEdit({ bpm: 104 }, 124, CAPS30, {}, paris).ok, 'stabilité inconnue au-delà de 8 %');
  assert.ok(checkReEdit({ bpm: 118 }, 124, CAPS30, {}, paris).ok, 'stabilité inconnue mais écart de 5 %');
  const dbl = checkReEdit({ bpm: 64, tempoStability: 0.9 }, 128, CAPS30, {}, paris);
  assert.ok(dbl.ok && dbl.mult === 2 && dbl.pct < 1e-9, 'double tempo 64 -> 128');
  assert.ok(!checkReEdit({ bpm: 104, tempoStability: 0.93 }, 124, CAPS30, {}, STYLE_PROFILES.lounge).ok, 'lounge : jamais au-delà de 8 %');
  assert.ok(!checkReEdit({ bpm: 104, tempoStability: 0.93 }, 124, CAPS30, { allowReEdits: false }, paris).ok, 'désactivé');
  assert.ok(checkReEdit({ bpm: 100, tempoStability: 0.95 }, 128, CAPS30, {}, paris).ok, '+28 %');
  assert.ok(!checkReEdit({ bpm: 95, tempoStability: 0.95 }, 128, CAPS30, {}, paris).ok, '+35 % : trop');
});

/** Ajoute au catalogue un morceau 80s spécial (bpm, stabilité). */
function special(id: number, bpm: number, tempoStability: number | undefined, keyConfidence = 0.7): TrackRef {
  const track: TrackRef = { id, title: `Spécial ${id}`, artist: `Artiste spécial ${id}`, duration: 240, genres: ['80s'], rank: 500000 };
  CATALOGUE.set(id, {
    track, genre: '80s',
    analysis: { trackId: id, bpm, bpmConfidence: 0.9, key: '8A', keyConfidence, energy: 0.65, danceability: 0.8, brightness: 0.5, vocalness: 0.7, loudnessDb: -9, genres: ['80s'], analyzedAt: 0, tempoStability },
  });
  return track;
}

/** Joue `track` (ajouté en tête de file pendant le premier morceau) et rend la simulation. */
function runReEdit(track: TrackRef, o: SimOptions): Sim {
  const sim = new Sim({ seed: 21, random: () => 0.01, ...o });
  sim.runFor(60);
  sim.queue.unshift({ track, source: 'host', addedAt: sim.nowMs, genre: '80s' });
  let guard = 0;
  while (guard++ < 30 * 600) {
    sim.step();
    const i = sim.history.findIndex((h) => h.track.id === track.id);
    if (i >= 0 && sim.history.length > i + 1 && !sim.active) break;
  }
  sim.runFor(5);
  return sim;
}

test('re-edit accepté : 80s 104 -> 124 avec un beat en dessous', () => {
  const track = special(990001, 104, 0.93);
  const sim = runReEdit(track, { targetBpm: 124 });
  checkInvariants(sim, 're-edit 104');
  const t = sim.transitions.find((x) => x.inTrack.id === track.id)!;
  assert.ok(t, 'le morceau est passé');
  assert.ok(t.plan.incomingRate > 1.15 && t.plan.incomingRate < 1.25, `calage ${t.plan.incomingRate}`);
  assert.match(t.plan.reason, /Re-edit : Années 80 à 104 BPM passé à 12[45] \(\+(19|20) %\), tempo stable \(0,93\)/);
  const starts = sim.grooveStarts.filter((g) => g.trackId === track.id);
  assert.ok(starts.length >= 2, `groove-start puis construction (${starts.length})`);
  const g1 = starts[0].plan;
  assert.deepEqual(g1.parts, ['kick', 'hat']);
  assert.equal(g1.bass, false);
  assert.equal(g1.key, '8A');
  assert.ok(g1.sourceLowCutDb <= -10 && g1.sourceLowCutDb >= -18, `low cut ${g1.sourceLowCutDb}`);
  assert.equal(g1.style, 'tech-house');
  assert.ok(g1.startCtx >= t.endCtx - 1e-6, 'groove démarré après la transition');
  // début de phrase du morceau entrant
  const nb = 60 / 104;
  const beats = (t.plan.incomingStartPos + (g1.startCtx - t.plan.incomingStartCtx) * t.plan.incomingRate) / nb;
  const ph = ((beats % 32) + 32) % 32;
  assert.ok(Math.min(ph, 32 - ph) < 0.3, `groove pas sur un début de phrase (${ph.toFixed(2)})`);
  const g2 = starts[1].plan;
  assert.ok(g2.parts.includes('clap') && g2.parts.includes('bass') && g2.bass, 'clap et basse ajoutés');
  assert.ok(g2.startCtx >= g1.startCtx + 32 * (60 / g1.bpm) - 0.5, 'une phrase plus tard');
  const stop = sim.grooveStops.find((s) => s.now > starts[0].now);
  assert.ok(stop, 'groove-stop émis');
  const next = sim.transitions[sim.transitions.indexOf(t) + 1];
  assert.ok(stop.atCtx + (stop.fadeBeats * 60) / stop.bpm <= next.plan.startCtx + 1e-6 || stop.atCtx >= next.endCtx - 1e-6, 'stop hors transition');
  assert.ok(sim.grooveUpdates >= 0);
});

test('re-edit refusé : tempo instable, platine limitée, désactivé', () => {
  const unstable = special(990002, 104, 0.6);
  const s1 = runReEdit(unstable, { targetBpm: 124 });
  checkInvariants(s1, 'instable');
  assert.equal(s1.grooveStarts.length, 0);
  assert.ok(s1.logs.some((l) => /Re-edit refusé.*instable/.test(l)), 'refus journalisé');
  assert.ok(s1.transitions.every((t) => Math.abs(t.plan.incomingRate - 1) <= RATE_LIMITS.normal + 1e-9));
  const t2 = special(990004, 104, 0.95);
  const s2 = runReEdit(t2, { targetBpm: 124, maxRateDelta: 0.08 });
  checkInvariants(s2, 'caps');
  assert.equal(s2.grooveStarts.length, 0);
  const t3 = special(990005, 104, 0.95);
  const s3 = runReEdit(t3, { targetBpm: 124, allowReEdits: false });
  assert.equal(s3.grooveStarts.length, 0);
});

test('re-edit en double tempo : 64 -> 128', () => {
  const track = special(990003, 64, 0.95);
  const sim = runReEdit(track, { targetBpm: 128 });
  checkInvariants(sim, 'double tempo');
  const t = sim.transitions.find((x) => x.inTrack.id === track.id)!;
  assert.ok(t && /double tempo/.test(t.plan.reason), t?.plan.reason ?? 'absent');
  assert.ok(Math.abs(t.plan.incomingRate - 1) < 0.08);
  assert.ok(sim.grooveStarts.some((g) => g.trackId === track.id));
});

test('rampes de rate : bornées, hors drop, vers le tempo de soirée', () => {
  const sim = new Sim({ seed: 31 });
  sim.runFor(90 * 60);
  checkInvariants(sim, 'rampes');
  assert.ok(sim.rates.length >= 10, `rampes émises (${sim.rates.length})`);
  for (const r of sim.rates) assert.ok(Math.abs(r.rate - r.from) <= 0.0251 && Math.abs(r.rate - 1) <= RATE_LIMITS.normal + 1e-9, r.reason);
  const late = sim.bpmTrace.filter((x) => x.min > 20);
  const close = late.filter((x) => Math.abs(x.bpm - x.target) < 1.5).length;
  assert.ok(close / Math.max(1, late.length) >= 0.7, `suit le tempo cible (${close}/${late.length})`);
  const peak = new Sim({ seed: 32, style: 'peak-time', fxAmount: 1 });
  peak.runFor(40 * 60);
  checkInvariants(peak, 'push');
  assert.ok(peak.rates.some((r) => /drop plus fort/.test(r.reason)), 'tempo poussé pendant un build');
  const fixed = new Sim({ seed: 33, canSetRate: false });
  fixed.runFor(20 * 60);
  assert.equal(fixed.rates.length, 0, 'pas de rampe sans rate');
});

test('re-edits pendant une soirée open-format (vote 80s depuis la house)', () => {
  const sim = new Sim({ seed: 41, style: 'open-format', baseGenre: 'house' });
  sim.runFor(10 * 60);
  sim.crowd.genreWeights = { '80s': 20, house: 3 };
  sim.runFor(50 * 60);
  checkInvariants(sim, 'open re-edit');
  const n = new Set(sim.grooveStarts.map((g) => g.trackId)).size;
  console.log(`     re-edits en open-format : ${n}, morceaux : ${sim.played().length}`);
  assert.ok(n >= 1, 'au moins un re-edit');
  assert.ok(n <= sim.played().length / 2, 're-edits dosés');
});

// --------------------------------------------------------------------------------------------- soirée de 2 h

test('soirée de 2 h : votes, demandes, hôte, blocage', () => {
  const sim = new Sim({ seed: 2026 });
  sim.keepDecisions = false;
  sim.crowd.host.blockedGenres = ['rock'];
  const guestTrack = byGenre('80s')[7].track;
  let guestAt = 0;
  const schedule: Array<[number, (s: Sim) => void]> = [
    [15, (s) => { s.crowd.genreWeights = { 'afro-house': 12, 'tech-house': 4 }; }],
    [30, (s) => { guestAt = s.nowMs; s.queue.push({ track: guestTrack, source: 'guest', requestId: 'r1', addedAt: s.nowMs, genre: '80s' }); }],
    [45, (s) => { s.crowd.genreWeights = { 'rap-fr': 20, 'afro-house': 5 }; s.crowd.energy = 0.5; }],
    [60, (s) => {
      s.queue.push({ track: byGenre('afro')[2].track, source: 'host', addedAt: s.nowMs, genre: 'afro' });
      s.queue.push({ track: byGenre('afro-house')[4].track, source: 'host', addedAt: s.nowMs, genre: 'afro-house' });
    }],
    [75, (s) => { s.crowd.genreWeights = { '80s': 25, 'rap-fr': 3, rock: 40 }; }],
    [100, (s) => { s.crowd.genreWeights = {}; s.crowd.host.forcedGenre = 'tech-house'; s.crowd.energy = 1; }],
  ];
  let k = 0;
  const t0 = Date.now();
  sim.runFor(120 * 60, (s) => {
    while (k < schedule.length && s.minutes() >= schedule[k][0]) schedule[k++][1](s);
  });
  const ms = Date.now() - t0;
  checkInvariants(sim, 'soirée');
  const guestPlay = sim.history.find((h) => h.track.id === guestTrack.id);
  assert.ok(guestPlay, 'la demande d’invité est passée');
  assert.ok(guestPlay!.startedAt - guestAt <= 25 * 60000, `demande passée en ${((guestPlay!.startedAt - guestAt) / 60000).toFixed(1)} min`);
  assert.ok(!sim.playedGenres().includes('rock'), 'rock bloqué');
  assert.ok(sim.playedGenres().includes('rap-fr') && sim.playedGenres().includes('80s'));

  // résumé
  const techniques: Record<string, number> = {};
  for (const t of sim.mixes()) techniques[t.plan.technique] = (techniques[t.plan.technique] ?? 0) + 1;
  const fxKinds: Record<string, number> = {};
  for (const f of sim.fx) fxKinds[f.cue.kind] = (fxKinds[f.cue.kind] ?? 0) + 1;
  const seq: string[] = [];
  for (const g of sim.playedGenres()) if (seq[seq.length - 1] !== g) seq.push(g);
  console.log('\n--- Résumé de la soirée simulée (2 h, paris-tech-house, fxAmount 0.5) ---');
  console.log(`morceaux joués : ${sim.played().length}, durée moyenne : ${sim.avgPlay().toFixed(0)} s, calcul : ${ms} ms`);
  console.log(`techniques : ${Object.entries(techniques).map(([a, b]) => `${a} ×${b}`).join(', ')}`);
  console.log(`effets hors transition : ${Object.entries(fxKinds).map(([a, b]) => `${a} ×${b}`).join(', ') || 'aucun'}`);
  console.log(`accents dans les transitions : ${sim.transitions.reduce((a, t) => a + t.plan.accents.length, 0)}`);
  console.log(`re-edits : ${new Set(sim.grooveStarts.map((g) => g.trackId)).size}, rampes de tempo : ${sim.rates.length}, groove-update : ${sim.grooveUpdates}`);
  console.log(`tempo (min : joué / cible) : ${sim.bpmTrace.filter((_, i) => i % 2 === 0).map((x) => `${x.min.toFixed(0)}: ${x.bpm.toFixed(1)}/${x.target.toFixed(1)}`).join(', ')}`);
  console.log(`genres traversés : ${seq.join(' > ')}`);
  console.log('exemples de raisons :');
  const seen = new Set<string>();
  for (const t of sim.mixes()) {
    if (seen.has(t.plan.technique)) continue;
    seen.add(t.plan.technique);
    console.log(`  - ${t.plan.reason}`);
  }
  console.log('extrait du journal :');
  for (const l of sim.logs.filter((x) => /cap|Chemin|Demande|invité|impose/i.test(x)).slice(0, 12)) console.log(`  ${l}`);
  console.log('');
});

console.log(`\n${passed} réussis, ${failed} échoués`);
if (failed > 0) process.exit(1);
