/**
 * Club Maison : synthèse PCM pure (sans Web Audio) des morceaux de démo.
 *
 * Principe : le morceau est découpé en mesures. Chaque mesure est décrite par un BarSpec
 * (section, couches actives, accord, progression…). Les mesures identiques ne sont rendues
 * qu'une fois (cache), dans un tampon « mesure + traîne », puis additionnées (overlap-add) à leur
 * position exacte. Ensuite : normalisation RMS sur les drops, limiteur à anticipation (-1 dBFS).
 */
import type { Camelot, Section } from '../contracts';
import { getDemoSpec, type DemoSpec, type DemoStyle } from './tracks';

const TAU = Math.PI * 2;

/** Sinus tabulé (interpolation linéaire), argument en cycles. ~5x plus rapide que Math.sin. */
const SIN_N = 4096;
const SIN_T = new Float32Array(SIN_N + 1);
for (let i = 0; i <= SIN_N; i++) SIN_T[i] = Math.sin((TAU * i) / SIN_N);
function sinc(cycles: number): number {
  const x = (cycles - Math.floor(cycles)) * SIN_N;
  const i = x | 0;
  return SIN_T[i] + (SIN_T[i + 1] - SIN_T[i]) * (x - i);
}

// ---------------------------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------------------------

type Kind = 'intro' | 'body' | 'drop' | 'breakdown' | 'build' | 'outro';
interface Part { kind: Kind; beats: number }

const SONG_STYLES: ReadonlySet<DemoStyle> = new Set<DemoStyle>(['synthpop', 'boombap', 'trap', 'reggaeton', 'chanson', 'slow80s', 'funk', 'rubato']);

function planParts(spec: DemoSpec): Part[] {
  const targetBeats = Math.round((spec.targetSec * spec.bpm) / 60);
  let parts: Part[];
  let unit: number;
  let growOrder: number[];
  if (SONG_STYLES.has(spec.style)) {
    // intro, couplet, refrain, couplet, refrain, pont, refrain, outro
    const intro = spec.style === 'synthpop' ? 32 : 16;
    parts = [
      { kind: 'intro', beats: intro }, { kind: 'body', beats: 64 }, { kind: 'drop', beats: 32 },
      { kind: 'body', beats: 64 }, { kind: 'drop', beats: 32 }, { kind: 'breakdown', beats: 32 },
      { kind: 'drop', beats: 32 }, { kind: 'outro', beats: 16 },
    ];
    unit = 32;
    growOrder = [3, 6, 1, 4];
  } else {
    const k = spec.style === 'dnb' ? 2 : 1;
    parts = [
      { kind: 'intro', beats: 32 * k }, { kind: 'body', beats: 32 * k }, { kind: 'drop', beats: 64 * k },
      { kind: 'breakdown', beats: 32 * k }, { kind: 'build', beats: 16 * k }, { kind: 'drop', beats: 64 * k },
      { kind: 'body', beats: 32 * k }, { kind: 'outro', beats: 32 * k },
    ];
    unit = 32 * k;
    growOrder = [1, 2, 5, 6];
  }
  let total = parts.reduce((a, p) => a + p.beats, 0);
  let g = 0;
  while (total + unit <= targetBeats && g < 40) {
    parts[growOrder[g % growOrder.length]].beats += unit;
    total += unit;
    g++;
  }
  return parts;
}

const KIND_TO_SECTION: Record<Kind, Section> = {
  intro: 'intro', body: 'body', drop: 'drop', breakdown: 'breakdown', build: 'build', outro: 'outro',
};

export interface DemoStructureItem {
  section: Section;
  startBeat: number;
  beats: number;
  /** Début et durée en secondes (utile pour le morceau rubato où temps != secondes * bpm / 60). */
  startSec: number;
  durationSec: number;
}

export function demoStructureOf(spec: DemoSpec): DemoStructureItem[] {
  let start = 0;
  const bt = demoBeatTimes(spec);
  return planParts(spec).map((p) => {
    const it = {
      section: KIND_TO_SECTION[p.kind], startBeat: start, beats: p.beats,
      startSec: bt[start], durationSec: bt[start + p.beats] - bt[start],
    };
    start += p.beats;
    return it;
  });
}

/** Amplitude maximale des écarts de tempo du morceau rubato (±5 %). */
export const RUBATO_DEPTH = 0.05;

/** Instants (s) de chaque temps, de 0 à la fin du dernier temps (longueur = temps + 1).
 *  Tempo fixe : k * 60 / bpm. Rubato : chaque intervalle varie de ±5 % (dérive lente + accidents). */
export function demoBeatTimes(spec: DemoSpec): Float64Array {
  const beats = planParts(spec).reduce((a, p) => a + p.beats, 0);
  const t = new Float64Array(beats + 1);
  const b = 60 / spec.bpm;
  if (!STYLES[spec.style].rubato) {
    for (let k = 0; k <= beats; k++) t[k] = k * b;
    return t;
  }
  const r = mulberry32(spec.seed * 7 + 1);
  const ph1 = r() * TAU, ph2 = r() * TAU;
  for (let k = 0; k < beats; k++) {
    const drift = 0.6 * Math.sin(ph1 + k / 5.3) + 0.25 * Math.sin(ph2 + k / 1.7);
    let f = drift + 0.3 * (r() * 2 - 1);
    // phrasé : on ralentit sur la fin de chaque phrase de 8 temps
    if (k % 8 === 7) f += 0.5;
    f = Math.max(-1, Math.min(1, f));
    t[k + 1] = t[k] + b * (1 + RUBATO_DEPTH * f);
  }
  return t;
}

/** Durée entière (s) : fin du dernier temps + 1 s de traîne, arrondie au-dessus. */
export function demoDurationOf(spec: DemoSpec): number {
  const t = demoBeatTimes(spec);
  return Math.ceil(t[t.length - 1] + 1);
}

// ---------------------------------------------------------------------------------------------
// Tonalité
// ---------------------------------------------------------------------------------------------

const CAMELOT_A = [8, 3, 10, 5, 0, 7, 2, 9, 4, 11, 6, 1]; // 1A = la bémol mineur…
const CAMELOT_B = [11, 6, 1, 8, 3, 10, 5, 0, 7, 2, 9, 4]; // 1B = si majeur…
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export function camelotInfo(key: Camelot): { pc: number; minor: boolean; name: string } {
  const n = parseInt(key, 10);
  const minor = key.endsWith('A');
  const pc = (minor ? CAMELOT_A : CAMELOT_B)[n - 1];
  return { pc, minor, name: `${NOTE_NAMES[pc]}${minor ? 'm' : ''}` };
}

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

// ---------------------------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------------------------

type ChordKind = 'saw' | 'stab' | 'organ' | 'epiano' | 'string';
type LeadKind = 'saw' | 'square' | 'bell' | 'acid' | 'guitar';
type BassKind = 'saw' | 'square' | 'sine' | 'reese' | 'pluck';
type VoxKind = 'chop' | 'sung' | 'chant' | 'none';
type SnareKind = 'clap' | 'snare' | 'gated' | 'rim' | 'brush';

interface StyleCfg {
  swing: number;            // fraction de double-croche de retard sur les doubles-croches impaires
  kick: string;             // 16 pas : X=1, x=0.75, o=0.4
  kick808?: boolean;        // kick long accordé sur la basse (trap)
  kickF: [number, number];  // fréquence finale / initiale
  kickDecay: number;
  snare: string; snareKind: SnareKind;
  hat: string; ohat: string;
  hatRolls?: boolean;
  shaker?: string; rim?: string; conga?: string; tom?: string;
  bass: string[]; bassKind: BassKind; bassCut: number; bassEnv: number; bassGain: number;
  chord: string[]; chordKind: ChordKind; chordCut: number; chordGain: number;
  lead?: string[]; leadKind?: LeadKind; leadGain?: number;
  vox: VoxKind; rapVerse?: boolean;
  pump: number;
  barsPerChord: number;
  progs: number[][];        // degrés (0 = tonique)
  strings?: boolean;        // nappe de cordes tenue en plus dans refrains et pont
  rubato?: boolean;         // tempo libre (voir demoBeatTimes)
  electronicDrums?: boolean; // false = batterie « jouée » / pas de 4/4 électronique
}

const MINOR_PROGS = [[0, 5, 2, 6], [0, 3, 6, 2], [0, 0, 5, 6], [0, 6, 5, 6], [0, 3, 0, 4]];
const MAJOR_PROGS = [[0, 4, 5, 3], [0, 5, 3, 4], [3, 4, 0, 0], [0, 3, 4, 3]];

const STYLES: Record<DemoStyle, StyleCfg> = {
  'tech-house': {
    swing: 0.1, kick: 'X...X...X...X...', kickF: [48, 170], kickDecay: 0.22,
    snare: '....X.......X...', snareKind: 'clap',
    hat: '.o.o.o.o.o.o.o.o', ohat: '..X...X...X...X.', shaker: 'xoxoxoxoxoxoxoxo', rim: '.......x.....x..',
    bass: ['r-.r..r.5..r.or.', 'r..r..ro..r.r.o.', '.r.r.r..o..r.5r.'], bassKind: 'saw', bassCut: 500, bassEnv: 1400, bassGain: 0.34,
    chord: ['.......x-.....x.', '...x-......x-...'], chordKind: 'stab', chordCut: 2200, chordGain: 0.07,
    lead: ['0..2..1.....3...', '0.....2...1.....'], leadKind: 'square', leadGain: 0.05,
    vox: 'chop', pump: 0.45, barsPerChord: 2, progs: MINOR_PROGS,
  },
  house: {
    swing: 0.14, kick: 'X...X...X...X...', kickF: [50, 160], kickDecay: 0.24,
    snare: '....X.......X...', snareKind: 'clap',
    hat: 'o.oxo.oxo.oxo.ox', ohat: '..X...X...X...X.', shaker: '.o.o.o.o.o.o.o.o',
    bass: ['r..r..o.r..5..o.', 'r-.o.r.-r..o.5..'], bassKind: 'pluck', bassCut: 700, bassEnv: 1800, bassGain: 0.34,
    chord: ['x..x..x...x..x..', 'x..x...x..x..x..'], chordKind: 'organ', chordCut: 3500, chordGain: 0.06,
    lead: ['4.3.2.1.0.......'], leadKind: 'saw', leadGain: 0.04,
    vox: 'chop', pump: 0.35, barsPerChord: 1, progs: MINOR_PROGS,
  },
  deep: {
    swing: 0.16, kick: 'X...X...X...X...', kickF: [50, 140], kickDecay: 0.26,
    snare: '....X.......X...', snareKind: 'rim',
    hat: '..x...x...x...x.', ohat: '..............x.', shaker: 'o.oxo.oxo.oxo.ox', rim: '...x..x....x..x.',
    bass: ['r-...r.-..5-.r..', 'r--..r..o-...5..'], bassKind: 'sine', bassCut: 600, bassEnv: 300, bassGain: 0.42,
    chord: ['x-----..x-----..', 'x-------...x----'], chordKind: 'epiano', chordCut: 2600, chordGain: 0.085,
    lead: ['....4.....3.....'], leadKind: 'bell', leadGain: 0.05,
    vox: 'sung', pump: 0.25, barsPerChord: 2, progs: MINOR_PROGS,
  },
  techno: {
    swing: 0, kick: 'X...X...X...X...', kickF: [46, 180], kickDecay: 0.3,
    snare: '....x.......x...', snareKind: 'rim',
    hat: 'xoxoXoxoxoxoXoxo', ohat: '..X...X...X...X.', tom: '..........x...o.',
    bass: ['.rrr.rrr.rrr.rrr', '.r.r.rr..r.r.rro'], bassKind: 'saw', bassCut: 300, bassEnv: 900, bassGain: 0.30,
    chord: ['x---------------'], chordKind: 'saw', chordCut: 900, chordGain: 0.045,
    lead: ['0.0.1.0.0.2.0.1.', '00.1.0.200.1.0.3'], leadKind: 'acid', leadGain: 0.05,
    vox: 'chop', pump: 0.2, barsPerChord: 4, progs: [[0, 0, 0, 0], [0, 0, 6, 0], [0, 5, 0, 6]],
  },
  minimal: {
    swing: 0.14, kick: 'X...X...X...X...', kickF: [52, 150], kickDecay: 0.18,
    snare: '....x.......x...', snareKind: 'clap',
    hat: '..o...o...o...oo', ohat: '......x.......x.', rim: 'x..x..x...x..x..', shaker: '.o.o.o.o.o.o.o.o',
    bass: ['r..r.....r..o...', '.r...r.r..o..r..'], bassKind: 'sine', bassCut: 500, bassEnv: 500, bassGain: 0.4,
    chord: ['......x.........'], chordKind: 'stab', chordCut: 1500, chordGain: 0.05,
    lead: ['0.....2.....1...'], leadKind: 'bell', leadGain: 0.05,
    vox: 'chop', pump: 0.2, barsPerChord: 2, progs: MINOR_PROGS,
  },
  nudisco: {
    swing: 0.06, kick: 'X...X...X...X...', kickF: [52, 150], kickDecay: 0.22,
    snare: '....X.......X...', snareKind: 'snare',
    hat: 'xoxoxoxoxoxoxoxo', ohat: '..X...X...X...X.',
    bass: ['roroo.rororoo.ro', 'r.o.r.o.r.o.5.o.'], bassKind: 'pluck', bassCut: 900, bassEnv: 2200, bassGain: 0.3,
    chord: ['x---------------'], chordKind: 'string', chordCut: 3000, chordGain: 0.05,
    lead: ['0123432101234321', '0.2.4.2.1.3.5.3.'], leadKind: 'saw', leadGain: 0.035,
    vox: 'sung', pump: 0.3, barsPerChord: 1, progs: MAJOR_PROGS,
  },
  disco: {
    swing: 0.08, kick: 'X...X...X...X...', kickF: [55, 140], kickDecay: 0.2,
    snare: '....X.......X...', snareKind: 'snare',
    hat: 'x.x.x.x.x.x.x.x.', ohat: '..X...X...X...X.', conga: 'x..x..o...x.o...',
    bass: ['r.o.r.o.r.o.5.o.', 'ro.oro.oro.o5o.o'], bassKind: 'pluck', bassCut: 1000, bassEnv: 2500, bassGain: 0.3,
    chord: ['x-------x-------'], chordKind: 'string', chordCut: 3500, chordGain: 0.05,
    lead: ['....4-3-2-1-0---'], leadKind: 'saw', leadGain: 0.035,
    vox: 'sung', pump: 0.15, barsPerChord: 1, progs: MAJOR_PROGS,
  },
  synthpop: {
    swing: 0, kick: 'X.......X.x.....', kickF: [55, 160], kickDecay: 0.22,
    snare: '....X.......X...', snareKind: 'gated',
    hat: 'x.x.x.x.x.x.x.x.', ohat: '..............X.',
    bass: ['r-r-r-r-r-r-o-r-', 'r.r.r.r.o.o.r.r.'], bassKind: 'saw', bassCut: 700, bassEnv: 1200, bassGain: 0.3,
    chord: ['x---------------'], chordKind: 'saw', chordCut: 2000, chordGain: 0.045,
    lead: ['0123012301230123', '0246024602460246'], leadKind: 'square', leadGain: 0.035,
    vox: 'sung', pump: 0, barsPerChord: 1, progs: MINOR_PROGS,
  },
  afro: {
    swing: 0.1, kick: 'X...X...X...X...', kickF: [50, 150], kickDecay: 0.24,
    snare: '....x.......x...', snareKind: 'clap',
    hat: '..x...x...x...x.', ohat: '..............X.', shaker: 'xoooxoooxoooxooo', conga: 'X..x..o...X.o.x.', rim: 'x..x..x...x..x..',
    bass: ['r-..r-.5..r-..o.', 'r-.r..5-..r-.o..'], bassKind: 'sine', bassCut: 600, bassEnv: 500, bassGain: 0.4,
    chord: ['x---------------'], chordKind: 'string', chordCut: 1600, chordGain: 0.045,
    lead: ['0.2.1..30.2.1.4.', '0..2.1..3..2.1..'], leadKind: 'bell', leadGain: 0.06,
    vox: 'chant', pump: 0.3, barsPerChord: 2, progs: MINOR_PROGS,
  },
  boombap: {
    swing: 0.2, kick: 'X......x..X.....', kickF: [50, 130], kickDecay: 0.28,
    snare: '....X.......X...', snareKind: 'snare',
    hat: 'x.x.x.x.x.x.x.xo', ohat: '..............x.',
    bass: ['r-.....r-.r-....', 'r-.....5-.r--...'], bassKind: 'sine', bassCut: 500, bassEnv: 200, bassGain: 0.42,
    chord: ['x-------x-------', 'x-----x-------x-'], chordKind: 'epiano', chordCut: 2200, chordGain: 0.09,
    lead: ['4---3---2-------'], leadKind: 'bell', leadGain: 0.04,
    vox: 'sung', rapVerse: true, pump: 0, barsPerChord: 1, progs: MINOR_PROGS,
  },
  trap: {
    swing: 0, kick: 'X.......X.x.....', kick808: true, kickF: [45, 120], kickDecay: 0.55,
    snare: '....X.......X...', snareKind: 'clap',
    hat: 'xoxoxoxoxoxoxoxo', ohat: '................', hatRolls: true,
    bass: ['................'], bassKind: 'sine', bassCut: 400, bassEnv: 0, bassGain: 0,
    chord: ['x---------------'], chordKind: 'saw', chordCut: 1100, chordGain: 0.04,
    lead: ['0..2..1.0..3..2.', '4..3..2.1..2..0.'], leadKind: 'bell', leadGain: 0.06,
    vox: 'sung', rapVerse: true, pump: 0, barsPerChord: 1, progs: MINOR_PROGS,
  },
  reggaeton: {
    swing: 0, kick: 'X...X...X...X...', kickF: [50, 150], kickDecay: 0.22,
    snare: '...x..x....x..x.', snareKind: 'snare',
    hat: 'x.x.x.x.x.x.x.x.', ohat: '................', rim: '..x...x...x...x.',
    bass: ['r...r...5...r...', 'r..r..r.5..5..o.'], bassKind: 'sine', bassCut: 500, bassEnv: 300, bassGain: 0.4,
    chord: ['x..x..x.x..x..x.'], chordKind: 'stab', chordCut: 2500, chordGain: 0.055,
    lead: ['0.1.2.1.0.1.2.1.', '2.1.0.1.2.3.2.1.'], leadKind: 'bell', leadGain: 0.05,
    vox: 'sung', rapVerse: true, pump: 0, barsPerChord: 1, progs: MINOR_PROGS,
  },
  dnb: {
    swing: 0, kick: 'X.........X.....', kickF: [50, 180], kickDecay: 0.22,
    snare: '....X..o.o..X..o', snareKind: 'snare',
    hat: 'x.x.x.x.x.x.x.x.', ohat: '......X.......X.', shaker: 'oxoxoxoxoxoxoxox',
    bass: ['r-------5-------', 'r-----r-o-----5-'], bassKind: 'reese', bassCut: 500, bassEnv: 300, bassGain: 0.3,
    chord: ['x---------------'], chordKind: 'string', chordCut: 1800, chordGain: 0.045,
    lead: ['0.......2.......'], leadKind: 'bell', leadGain: 0.05,
    vox: 'sung', pump: 0, barsPerChord: 2, progs: MINOR_PROGS,
  },
  // --- morceaux « organiques » pour les re-edits (pas de 4/4 électronique)
  chanson: {
    swing: 0.08, kick: 'X.......x.......', kickF: [58, 110], kickDecay: 0.16,
    snare: '....x.......x...', snareKind: 'brush',
    hat: 'x..ox..ox..ox..o', ohat: '................',
    bass: ['r...5...r...5.3.', 'r...3...5...o...'], bassKind: 'pluck', bassCut: 400, bassEnv: 500, bassGain: 0.5,
    chord: ['x---x---x---x---', 'x-----x-x---x---'], chordKind: 'epiano', chordCut: 3000, chordGain: 0.075,
    lead: ['0.1.2.1.3.1.2.1.', '0.2.1.2.0.2.1.2.'], leadKind: 'guitar', leadGain: 0.12,
    vox: 'sung', pump: 0, barsPerChord: 1, progs: MAJOR_PROGS, strings: true, electronicDrums: false,
  },
  slow80s: {
    swing: 0, kick: 'X.......X.......', kickF: [52, 130], kickDecay: 0.25,
    snare: '....X.......X...', snareKind: 'gated',
    hat: 'x.o.x.o.x.o.x.o.', ohat: '................',
    bass: ['r-------r---5---', 'r-----r-o---5---'], bassKind: 'saw', bassCut: 350, bassEnv: 400, bassGain: 0.32,
    chord: ['x---------------'], chordKind: 'saw', chordCut: 1800, chordGain: 0.045,
    lead: ['4-------3---2---', '2---3---4-------'], leadKind: 'bell', leadGain: 0.06,
    vox: 'sung', pump: 0, barsPerChord: 1, progs: MAJOR_PROGS, strings: true, electronicDrums: false,
  },
  funk: {
    swing: 0.12, kick: 'X.......X.x.....', kickF: [55, 120], kickDecay: 0.2,
    snare: '....X..o.o..X..o', snareKind: 'snare',
    hat: 'xoxoxoxoxoxoxoxo', ohat: '..............x.',
    bass: ['r.r.o.r.5.r.o.r.', 'r.o.r.o.5.o.r.o.'], bassKind: 'pluck', bassCut: 800, bassEnv: 2600, bassGain: 0.33,
    chord: ['..x...x...x.x.x.', '.x..x..x.x..x...'], chordKind: 'stab', chordCut: 3500, chordGain: 0.06,
    lead: ['0.0.0.1.0.0.2.0.', '0..0.1..0..2.1..'], leadKind: 'guitar', leadGain: 0.09,
    vox: 'chop', pump: 0, barsPerChord: 2, progs: [[0, 0, 3, 3], [0, 3, 0, 4]], electronicDrums: false,
  },
  rubato: {
    swing: 0, kick: '................', kickF: [55, 120], kickDecay: 0.2,
    snare: '................', snareKind: 'brush',
    hat: '................', ohat: '................',
    bass: ['r-------5-------', 'r-------3---5---'], bassKind: 'sine', bassCut: 400, bassEnv: 0, bassGain: 0.4,
    chord: ['x---x---x---x---', 'x-------x---x---'], chordKind: 'epiano', chordCut: 3000, chordGain: 0.085,
    lead: ['0...1...2...1...', '2.1.0...3.2.1...'], leadKind: 'guitar', leadGain: 0.1,
    vox: 'sung', pump: 0, barsPerChord: 1, progs: MAJOR_PROGS, strings: true, rubato: true, electronicDrums: false,
  },
};

// ---------------------------------------------------------------------------------------------
// Générateur pseudo-aléatoire et filtre d'état (TPT SVF)
// ---------------------------------------------------------------------------------------------

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

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Bruit blanc pré-calculé (déterministe), lu à partir d'un décalage aléatoire. */
const NOISE_MASK = (1 << 17) - 1;
const NOISE = (() => {
  const r = mulberry32(0x5eed);
  const t = new Float32Array(NOISE_MASK + 1);
  for (let i = 0; i < t.length; i++) t[i] = r() * 2 - 1;
  return t;
})();

class Svf {
  private a1 = 0; private a2 = 0; private a3 = 0; private k = 1;
  private ic1 = 0; private ic2 = 0;
  low = 0; band = 0; high = 0;
  constructor(private sr: number, fc = 1000, q = 0.707) { this.set(fc, q); }
  set(fc: number, q: number): void {
    const f = Math.min(Math.max(fc, 10), this.sr * 0.45);
    const g = Math.tan((Math.PI * f) / this.sr);
    this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  tick(x: number): void {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.low = v2; this.band = v1; this.high = x - this.k * v1 - v2;
  }
}

// ---------------------------------------------------------------------------------------------
// Voix (écrivent en additionnant dans un bus stéréo)
// ---------------------------------------------------------------------------------------------

interface Bus { L: Float32Array; R: Float32Array }
const newBus = (n: number): Bus => ({ L: new Float32Array(n), R: new Float32Array(n) });

function panGains(pan: number): [number, number] {
  return [Math.min(1, 1 - pan), Math.min(1, 1 + pan)];
}

class Voices {
  constructor(readonly sr: number, readonly rnd: () => number) {}

  kick(b: Bus, s0: number, f0: number, f1: number, decay: number, gain: number, click = 0.25): void {
    const sr = this.sr;
    const n = Math.min(b.L.length - s0, Math.floor((decay * 4 + 0.05) * sr));
    const kp = Math.exp(-1 / (0.035 * sr));
    const kd = Math.exp(-1 / (decay * sr));
    const cl = Math.floor(0.004 * sr);
    const rel = Math.floor(0.02 * sr);
    let ph = 0, pe = 1, de = 1;
    for (let i = 0; i < n; i++) {
      ph += (f0 + (f1 - f0) * pe) / sr;
      pe *= kp; de *= kd;
      let v = sinc(ph) * de;
      if (i < 40) v *= i / 40;
      if (i > n - rel) v *= (n - i) / rel;
      if (i < cl) v += (this.rnd() * 2 - 1) * click * (1 - i / cl);
      v *= gain;
      b.L[s0 + i] += v; b.R[s0 + i] += v;
    }
  }

  /** Bruit filtré à enveloppe exponentielle (charleys, shaker, clap, crash, consonnes). */
  noise(b: Bus, s0: number, mode: 'hp' | 'bp' | 'lp', fc: number, q: number, attack: number, decay: number, gain: number, pan = 0, lenSec = decay * 6): void {
    const sr = this.sr;
    const n = Math.min(b.L.length - s0, Math.floor(lenSec * sr));
    if (n <= 0) return;
    const f = new Svf(sr, fc, q);
    const kd = Math.exp(-1 / (decay * sr));
    const na = Math.max(1, Math.floor(attack * sr));
    const [gl, gr] = panGains(pan);
    const rel = Math.min(n, Math.floor(0.005 * sr));
    let de = 1;
    let off = (this.rnd() * NOISE_MASK) | 0;
    for (let i = 0; i < n; i++) {
      f.tick(NOISE[off]); off = (off + 1) & NOISE_MASK;
      const x = mode === 'hp' ? f.high : mode === 'bp' ? f.band : f.low;
      let env = i < na ? i / na : (de *= kd);
      if (i > n - rel) env *= (n - i) / rel;
      const v = x * env * gain;
      b.L[s0 + i] += v * gl; b.R[s0 + i] += v * gr;
    }
  }

  hat(b: Bus, s0: number, open: boolean, gain: number, pan: number): void {
    this.noise(b, s0, 'hp', 7500, 0.9, 0.001, open ? 0.11 : 0.025, gain, pan, open ? 0.45 : 0.12);
  }

  clap(b: Bus, s0: number, gain: number): void {
    const sr = this.sr;
    for (let k = 0; k < 3; k++) this.noise(b, s0 + Math.floor(k * 0.009 * sr), 'bp', 1300, 1.4, 0.0005, 0.006, gain * 1.6, (k - 1) * 0.2, 0.012);
    this.noise(b, s0 + Math.floor(0.027 * sr), 'bp', 1200, 1.2, 0.001, 0.09, gain * 1.4, 0, 0.4);
    // petite pièce : deux réflexions
    this.noise(b, s0 + Math.floor(0.045 * sr), 'bp', 1600, 1, 0.003, 0.12, gain * 0.25, -0.7, 0.4);
    this.noise(b, s0 + Math.floor(0.061 * sr), 'bp', 1600, 1, 0.003, 0.12, gain * 0.25, 0.7, 0.4);
  }

  snare(b: Bus, s0: number, gain: number, tone = 185, gated = false): void {
    const sr = this.sr;
    const n = Math.min(b.L.length - s0, Math.floor(0.2 * sr));
    const kd = Math.exp(-1 / (0.05 * sr));
    let ph = 0, de = 1;
    for (let i = 0; i < n; i++) {
      ph += (tone * (1 + 0.5 * Math.exp(-i / (0.006 * sr)))) / sr;
      de *= kd;
      const v = sinc(ph) * de * gain * 0.8 * (i < 30 ? i / 30 : 1);
      b.L[s0 + i] += v; b.R[s0 + i] += v;
    }
    if (gated) {
      this.noise(b, s0, 'bp', 2500, 0.6, 0.001, 0.6, gain * 1.1, -0.15, 0.24);
      this.noise(b, s0, 'bp', 2700, 0.6, 0.001, 0.6, gain * 1.1, 0.15, 0.24);
    } else {
      this.noise(b, s0, 'bp', 3200, 0.7, 0.001, 0.08, gain * 1.2, 0, 0.35);
    }
  }

  rim(b: Bus, s0: number, gain: number, pan: number): void {
    this.noise(b, s0, 'bp', 1800, 4, 0.0005, 0.012, gain * 2, pan, 0.06);
    this.tone(b, s0, 820, 820, 0.018, gain * 0.6, pan);
  }

  tone(b: Bus, s0: number, fStart: number, fEnd: number, decay: number, gain: number, pan: number): void {
    const sr = this.sr;
    const n = Math.min(b.L.length - s0, Math.floor(decay * 6 * sr));
    const kd = Math.exp(-1 / (decay * sr));
    const kp = Math.exp(-1 / (0.03 * sr));
    const [gl, gr] = panGains(pan);
    let ph = 0, de = 1, pe = 1;
    for (let i = 0; i < n; i++) {
      ph += (fEnd + (fStart - fEnd) * pe) / sr;
      pe *= kp; de *= kd;
      const v = sinc(ph) * de * gain * (i < 30 ? i / 30 : 1);
      b.L[s0 + i] += v * gl; b.R[s0 + i] += v * gr;
    }
  }

  bassNote(b: Bus, s0: number, len: number, f: number, kind: BassKind, cut: number, env: number, gain: number): void {
    const sr = this.sr;
    const rel = Math.floor(0.012 * sr);
    const n = Math.min(b.L.length - s0, len + rel);
    const filt = new Svf(sr, cut, kind === 'reese' ? 0.9 : 1.1);
    const kenv = Math.exp(-(32 / (0.09 * sr)));
    const kpl = Math.exp(-1 / (0.25 * sr));
    let ph1 = 0, ph2 = 0, phs = 0, e = 1, pl = 1;
    const d1 = f / sr, d2 = (f * 1.007) / sr, d3 = (f * 0.993) / sr;
    for (let i = 0; i < n; i++) {
      if ((i & 31) === 0) { filt.set(cut + env * e, kind === 'reese' ? 0.9 : 1.1); e *= kenv; }
      ph1 += d1; if (ph1 >= 1) ph1 -= 1;
      let x: number;
      if (kind === 'sine') {
        phs += d1; if (phs >= 1) phs -= 1;
        x = sinc(phs) + 0.15 * sinc(2 * phs);
      } else {
        phs += d1; if (phs >= 1) phs -= 1;
        if (kind === 'square') x = ph1 < 0.5 ? 0.7 : -0.7;
        else if (kind === 'reese') {
          ph2 += d2; if (ph2 >= 1) ph2 -= 1;
          x = (ph1 * 2 - 1) * 0.5 + (ph2 * 2 - 1) * 0.5;
          // troisième oscillateur désaccordé de l'autre côté
          const p3 = ((i * d3) % 1);
          x = x * 0.75 + (p3 * 2 - 1) * 0.35;
        } else x = ph1 * 2 - 1;
        filt.tick(x);
        x = filt.low + 0.6 * sinc(phs);
      }
      let a = i < 90 ? i / 90 : 1;
      if (kind === 'pluck') { a *= 0.35 + 0.65 * pl; pl *= kpl; }
      if (i >= len) a *= Math.max(0, 1 - (i - len) / rel);
      const v = x * a * gain;
      b.L[s0 + i] += v; b.R[s0 + i] += v;
    }
  }

  /** Accord : 2 oscillateurs par note (chorus gauche/droite), écrit SANS filtre (filtré au niveau mesure). */
  chord(b: Bus, s0: number, len: number, freqs: number[], kind: ChordKind, gain: number): void {
    const sr = this.sr;
    const attack = kind === 'string' ? 0.18 : kind === 'saw' ? 0.06 : 0.004;
    const release = kind === 'stab' ? 0.05 : 0.25;
    const decay = kind === 'stab' ? 0.16 : kind === 'organ' ? 0.35 : kind === 'epiano' ? 1.1 : 1e9;
    const na = Math.floor(attack * sr), nr = Math.floor(release * sr);
    let n = Math.min(b.L.length - s0, len + nr);
    if (decay < 1e8) n = Math.min(n, Math.ceil(decay * 6 * sr));   // -52 dB : on s'arrête
    if (n <= 0) return;
    // enveloppe commune à toutes les notes (gain inclus)
    const env = new Float32Array(n);
    const kd = Math.exp(-1 / (decay * sr));
    let de = 1;
    for (let i = 0; i < n; i++) {
      let a = i < na ? i / na : 1;
      a *= de; de *= kd;
      if (i >= len) a *= Math.max(0, 1 - (i - len) / nr);
      env[i] = a * gain;
    }
    const L = b.L, R = b.R;
    if (kind === 'epiano') {
      const kb = Math.exp(-1 / (0.08 * sr));
      const tl = new Float32Array(n), tr = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const trem = 0.5 + 0.5 * sinc((4.5 * (s0 + i)) / sr);
        tl[i] = env[i] * (0.6 + 0.4 * trem) * 1.4; tr[i] = env[i] * (1 - 0.4 * trem) * 1.4;
      }
      for (const f of freqs) {
        const d1 = f / sr;
        let p1 = this.rnd(), bell = 0.2;
        for (let i = 0; i < n; i++) {
          p1 += d1; if (p1 >= 1) p1 -= 1;
          bell *= kb;
          const v = sinc(p1 + bell * sinc(2 * p1));
          L[s0 + i] += v * tl[i]; R[s0 + i] += v * tr[i];
        }
      }
      return;
    }
    for (const f of freqs) {
      const d1 = (f * 1.0046) / sr, d2 = (f * 0.9954) / sr;
      let p1 = this.rnd(), p2 = this.rnd();
      if (kind === 'organ') {
        for (let i = 0; i < n; i++) {
          p1 += d1; if (p1 >= 1) p1 -= 1;
          p2 += d2; if (p2 >= 1) p2 -= 1;
          const e = env[i];
          L[s0 + i] += (sinc(p1) + 0.5 * sinc(2 * p1) + 0.3 * sinc(4 * p1)) * e;
          R[s0 + i] += (sinc(p2) + 0.5 * sinc(2 * p2) + 0.3 * sinc(3 * p2)) * e;
        }
      } else {
        for (let i = 0; i < n; i++) {
          p1 += d1; if (p1 >= 1) p1 -= 1;
          p2 += d2; if (p2 >= 1) p2 -= 1;
          const a1 = p1 * 2 - 1, a2 = p2 * 2 - 1, e = env[i];
          L[s0 + i] += (0.75 * a1 + 0.35 * a2) * e; R[s0 + i] += (0.35 * a1 + 0.75 * a2) * e;
        }
      }
    }
  }

  lead(b: Bus, s0: number, len: number, f: number, kind: LeadKind, gain: number, pan: number, bright: number): void {
    const sr = this.sr;
    const n = Math.min(b.L.length - s0, len + Math.floor(0.3 * sr));
    if (n <= 0) return;
    const filt = new Svf(sr, 2000, kind === 'acid' ? 6 : 1);
    const [gl, gr] = panGains(pan);
    const kdec = Math.exp(-1 / ((kind === 'bell' ? 0.35 : 0.18) * sr));
    const kenv = Math.exp(-(32 / ((kind === 'acid' ? 0.12 : 0.08) * sr)));
    const d = f / sr;
    let ph = 0, de = 1, e = 1;
    for (let i = 0; i < n; i++) {
      ph += d; if (ph >= 1) ph -= 1;
      let x: number;
      if (kind === 'bell') {
        x = sinc(ph) + 0.3 * Math.exp(-i / (0.02 * sr)) * sinc(3 * ph);
      } else {
        if ((i & 31) === 0) { filt.set((kind === 'acid' ? 300 : 600) + bright * (kind === 'acid' ? 2500 : 3500) * e, kind === 'acid' ? 6 : 1); e *= kenv; }
        filt.tick(kind === 'square' ? (ph < 0.5 ? 1 : -1) : ph * 2 - 1);
        x = filt.low;
      }
      de *= kdec;
      let a = (i < 60 ? i / 60 : 1) * de;
      if (i >= len) a *= Math.max(0, 1 - (i - len) / (0.03 * sr));
      const v = x * a * gain;
      b.L[s0 + i] += v * gl; b.R[s0 + i] += v * gr;
    }
  }

  /** Voix suggérée : onde glottale (dent de scie) + souffle, 3 formants en parallèle. */
  vox(b: Bus, s0: number, len: number, f: number, vowel: number, gain: number, pan: number, glide = 0, breath = 0.15): void {
    const sr = this.sr;
    const V = VOWELS[vowel % VOWELS.length];
    const rel = Math.floor(0.08 * sr);
    const n = Math.min(b.L.length - s0, len + rel);
    if (n <= 0) return;
    const f1 = new Svf(sr, V[0], 8), f2 = new Svf(sr, V[1], 12), f3 = new Svf(sr, V[2], 16);
    const [gl, gr] = panGains(pan);
    const na = Math.floor(Math.min(0.04, len / sr / 3) * sr);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const fr = f * (1 + 0.012 * sinc(5.2 * t) * Math.min(1, t * 3) - glide * Math.min(1, t / 0.15));
      ph += fr / sr; if (ph >= 1) ph -= 1;
      const src = (ph * 2 - 1) * (1 - breath) + (this.rnd() * 2 - 1) * breath;
      f1.tick(src); f2.tick(src); f3.tick(src);
      let a = i < na ? i / na : 1;
      if (i >= len) a *= Math.max(0, 1 - (i - len) / rel);
      const v = (f1.band + 0.6 * f2.band + 0.3 * f3.band) * a * gain;
      b.L[s0 + i] += v * gl; b.R[s0 + i] += v * gr;
    }
  }

  /** Corde pincée (Karplus-Strong) : guitare / piano-guitare pour les morceaux organiques. */
  guitar(b: Bus, s0: number, len: number, f: number, gain: number, pan: number): void {
    const sr = this.sr;
    const n = Math.min(b.L.length - s0, len + Math.floor(0.05 * sr));
    if (n <= 0) return;
    const P = Math.max(2, Math.round(sr / f));
    const line = new Float32Array(P);
    let off = (this.rnd() * NOISE_MASK) | 0;
    for (let i = 0; i < P; i++) { line[i] = NOISE[off]; off = (off + 1) & NOISE_MASK; }
    const [gl, gr] = panGains(pan);
    const rel = Math.floor(0.05 * sr);
    let idx = 0, prev = 0;
    for (let i = 0; i < n; i++) {
      const cur = line[idx];
      const next = 0.4985 * (cur + prev);
      prev = cur;
      line[idx] = next;
      idx++; if (idx === P) idx = 0;
      let a = gain;
      if (i >= len) a *= Math.max(0, 1 - (i - len) / rel);
      const v = cur * a;
      b.L[s0 + i] += v * gl; b.R[s0 + i] += v * gr;
    }
  }

  riser(b: Bus, s0: number, n: number, p0: number, p1: number, gain: number): void {
    const sr = this.sr;
    const fl = new Svf(sr, 500, 3), fr = new Svf(sr, 500, 3);
    n = Math.min(n, b.L.length - s0);
    for (let i = 0; i < n; i++) {
      const p = p0 + ((p1 - p0) * i) / n;
      if ((i & 63) === 0) { const fc = 300 * Math.pow(25, p); fl.set(fc, 3); fr.set(fc * 1.05, 3); }
      fl.tick(this.rnd() * 2 - 1); fr.tick(this.rnd() * 2 - 1);
      const a = gain * p * p;
      b.L[s0 + i] += fl.band * a; b.R[s0 + i] += fr.band * a;
    }
  }
}

const VOWELS: number[][] = [
  [800, 1200, 2500], // a
  [500, 1800, 2500], // é
  [500, 850, 2400],  // o
  [330, 2200, 2900], // i
  [350, 750, 2300],  // ou
];

// ---------------------------------------------------------------------------------------------
// Mesures
// ---------------------------------------------------------------------------------------------

const L_KICK = 1, L_BASS = 2, L_HAT = 4, L_OHAT = 8, L_CLAP = 16, L_PERC = 32, L_PAD = 64,
  L_LEAD = 128, L_VOX = 256, L_RISER = 512, L_ROLL = 1024, L_RAP = 2048;

interface BarSpec {
  kind: Kind;
  layers: number;
  chord: number;       // index dans la progression
  fill: boolean;       // dernière mesure de phrase : roulement
  crash: boolean;
  prog: number;        // progression 0..1 dans la section (quantifiée)
  progEnd: number;
  vb: number;          // variante (voix, rap)
  last: boolean;       // dernière mesure de la section
}

interface TrackCtx {
  spec: DemoSpec;
  st: StyleCfg;
  sr: number;
  beatSec: number;
  stepSec: number;
  barLen: number;
  tail: number;
  /** Début (s, relatif à la mesure) de chaque temps de la mesure, 5 valeurs (fin incluse). */
  beatPos: number[];
  bassPat: string;
  chordPat: string;
  leadPat: string;
  chords: number[][];     // notes MIDI de l'accord (zone médium)
  bassRoot: number[];     // MIDI de la fondamentale (grave)
  chordSemis: number[][]; // intervalles de l'accord depuis sa fondamentale
}

function buildCtx(spec: DemoSpec, sr: number): TrackCtx {
  const st = STYLES[spec.style];
  const { pc, minor } = camelotInfo(spec.key);
  const scale = minor ? MINOR : MAJOR;
  const progs = st.progs === MINOR_PROGS && !minor ? MAJOR_PROGS : st.progs;
  const prog = progs[spec.seed % progs.length];
  const tonicBass = 33 + ((pc - 9 + 12) % 12);   // la1..sol#2
  const chords: number[][] = [], bassRoot: number[] = [], chordSemis: number[][] = [];
  for (const deg of prog) {
    const semis = [0, 2, 4, 6].map((o) => {
      const idx = deg + o;
      return scale[idx % 7] + 12 * Math.floor(idx / 7);
    });
    const rootSemi = semis[0];
    chordSemis.push(semis.map((s) => s - rootSemi));
    let br = tonicBass + rootSemi;
    if (br > tonicBass + 7) br -= 12;
    bassRoot.push(br);
    chords.push(semis.map((s) => {
      let m = 48 + pc + s;
      while (m < 53) m += 12;
      while (m >= 72) m -= 12;
      return m;
    }).sort((a, b) => a - b));
  }
  const beatSec = 60 / spec.bpm;
  const pick = (arr: string[], salt: number) => arr[(spec.seed + salt) % arr.length];
  return {
    spec, st, sr, beatSec, stepSec: beatSec / 4,
    barLen: Math.ceil(beatSec * 4 * sr),
    tail: Math.ceil(Math.max(1.6, beatSec * 2.5) * sr),
    beatPos: [0, 1, 2, 3, 4].map((k) => k * beatSec),
    bassPat: pick(st.bass, 0), chordPat: pick(st.chord, 1), leadPat: pick(st.lead ?? ['................'], 2),
    chords, bassRoot, chordSemis,
  };
}

function vel(c: string): number {
  return c === 'X' ? 1 : c === 'x' ? 0.75 : c === 'o' ? 0.4 : 0;
}

/** Notes d'un motif ('-' prolonge, '.' silence). Renvoie [pas, longueur en pas, caractère]. */
function parseNotes(pat: string): Array<[number, number, string]> {
  const out: Array<[number, number, string]> = [];
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '.' || c === '-') continue;
    let len = 1;
    while (i + len < pat.length && pat[i + len] === '-') len++;
    out.push([i, len, c]);
  }
  return out;
}

function renderBar(tc: TrackCtx, bs: BarSpec, key: string): Bus {
  const { st, sr, stepSec, barLen, tail } = tc;
  const n = barLen + tail;
  const main = newBus(n);
  const pumped = newBus(n);
  const pad = newBus(n);
  const vx = new Voices(sr, mulberry32(hashStr(key) ^ tc.spec.seed));
  const rnd = vx.rnd;
  const has = (l: number) => (bs.layers & l) !== 0;
  const bp = tc.beatPos;
  const stepAt = (i: number) => {
    const k = Math.min(3, i >> 2);
    const d = (bp[k + 1] - bp[k]) / 4;
    return Math.round((bp[k] + (i - 4 * k) * d + (i % 2 === 1 ? st.swing * d : 0)) * sr);
  };
  const ci = bs.chord;
  // cordes/piano une octave plus haut dans le pont des morceaux organiques (pont plus aérien)
  const chordF = tc.chords[ci].map((m) => mtof(m + (st.strings && bs.kind === 'breakdown' ? 12 : 0)));
  const isBuildEnd = bs.kind === 'build' && bs.last;

  // --- kick
  if (has(L_KICK)) {
    for (let i = 0; i < 16; i++) {
      const v = vel(st.kick[i]);
      if (!v) continue;
      if (st.kick808) {
        const f = mtof(tc.bassRoot[ci]);
        vx.kick(main, stepAt(i), f, f * 3, st.kickDecay, 0.95 * v, 0.3);
      } else vx.kick(main, stepAt(i), st.kickF[0], st.kickF[1], st.kickDecay, 0.95 * v);
    }
  }
  // --- caisse claire / clap
  if (has(L_CLAP)) {
    const g = 0.32;
    const hit = (i: number, v: number) => {
      const s = stepAt(i);
      if (st.snareKind === 'clap') vx.clap(main, s, g * v);
      else if (st.snareKind === 'rim') vx.rim(main, s, g * 0.7 * v, 0.1);
      else if (st.snareKind === 'brush') vx.noise(main, s, 'bp', 2800, 0.5, 0.01, 0.09, g * 0.55 * v, 0.1, 0.35);
      else vx.snare(main, s, g * v * 1.1, 190, st.snareKind === 'gated');
    };
    for (let i = 0; i < 16; i++) { const v = vel(st.snare[i]); if (v) hit(i, v); }
    if (bs.fill) { hit(13, 0.5); hit(14, 0.6); hit(15, 0.75); }
  }
  // --- charleys
  if (has(L_HAT)) {
    for (let i = 0; i < 16; i++) {
      const v = vel(st.hat[i]);
      if (!v) continue;
      if (st.hatRolls && bs.vb % 2 === 1 && i >= 12) continue;
      vx.hat(main, stepAt(i), false, 0.13 * v, 0.25);
    }
    if (st.hatRolls && bs.vb % 2 === 1) {
      const div = bs.vb % 4 === 1 ? 2 : 3;   // triples-croches ou triolets
      const cnt = 4 * div;
      for (let k = 0; k < cnt; k++) vx.hat(main, Math.round((12 * stepSec + (k * 4 * stepSec) / cnt) * sr), false, 0.09 + 0.04 * (k / cnt), 0.25);
    }
  }
  if (has(L_OHAT)) {
    for (let i = 0; i < 16; i++) { const v = vel(st.ohat[i]); if (v) vx.hat(main, stepAt(i), true, 0.1 * v, -0.2); }
  }
  // --- percussions
  if (has(L_PERC)) {
    if (st.shaker) for (let i = 0; i < 16; i++) { const v = vel(st.shaker[i]); if (v) vx.noise(main, stepAt(i), 'hp', 5500, 0.8, 0.004, 0.03, 0.07 * v, 0.45, 0.12); }
    if (st.rim) for (let i = 0; i < 16; i++) { const v = vel(st.rim[i]); if (v) vx.rim(main, stepAt(i), 0.12 * v, -0.4); }
    if (st.conga) for (let i = 0; i < 16; i++) {
      const c = st.conga[i];
      if (c === '.') continue;
      const f = c === 'X' ? 360 : c === 'x' ? 290 : 220;
      vx.tone(main, stepAt(i), f * 1.25, f, 0.09, 0.22, c === 'o' ? -0.5 : 0.4);
    }
    if (st.tom) for (let i = 0; i < 16; i++) { const v = vel(st.tom[i]); if (v) vx.tone(main, stepAt(i), 200, 110, 0.12, 0.22 * v, 0.3); }
  }
  // --- basse
  if (has(L_BASS) && st.bassGain > 0) {
    const semis = tc.chordSemis[ci];
    for (const [i, len, c] of parseNotes(tc.bassPat)) {
      const off = c === 'o' ? 12 : c === '5' ? semis[2] : c === '3' ? semis[1] : c === '7' ? semis[3] : c === 'l' ? semis[2] - 12 : 0;
      const nlen = Math.round((len * stepSec - (len === 1 ? 0.015 : 0.03)) * sr);
      vx.bassNote(pumped, stepAt(i), nlen, mtof(tc.bassRoot[ci] + off), st.bassKind, st.bassCut, st.bassEnv, st.bassGain);
    }
  }
  // --- accords / nappe
  if (has(L_PAD)) {
    const sustainedPad = bs.kind === 'breakdown' || bs.kind === 'build' || bs.kind === 'intro';
    const sec = stepSec * 16;
    if (st.strings && (bs.kind === 'drop' || bs.kind === 'breakdown' || bs.kind === 'outro')) {
      vx.chord(pad, 0, barLen, chordF.map((f) => f * 2), 'string', st.chordGain * 0.45);
    }
    if (sustainedPad && st.chordKind !== 'epiano') {
      vx.chord(pad, 0, barLen, chordF, 'string', st.chordGain * 1.1);
    } else {
      for (const [i, len] of parseNotes(tc.chordPat)) {
        vx.chord(pad, stepAt(i), Math.round(len * stepSec * sr - 0.01 * sr), chordF, st.chordKind, st.chordGain);
      }
    }
    // filtre de la nappe : ouverture progressive selon la section
    let c0 = st.chordCut, c1 = st.chordCut;
    if (bs.kind === 'breakdown' || bs.kind === 'build' || bs.kind === 'body' || bs.kind === 'intro') {
      const lo = st.chordCut * 0.25;
      c0 = lo + (st.chordCut * 1.2 - lo) * bs.prog;
      c1 = lo + (st.chordCut * 1.2 - lo) * bs.progEnd;
    }
    const fl = new Svf(sr), fr = new Svf(sr);
    let used = n;
    while (used > 0 && pad.L[used - 1] === 0 && pad.R[used - 1] === 0) used--;
    used = Math.min(n, used + Math.round(0.05 * sr));
    for (let i = 0; i < used; i++) {
      if ((i & 63) === 0) { const p = Math.min(1, i / (sec * sr)); const c = c0 + (c1 - c0) * p; fl.set(c, 0.8); fr.set(c, 0.8); }
      fl.tick(pad.L[i]); fr.tick(pad.R[i]);
      pumped.L[i] += fl.low; pumped.R[i] += fr.low;
    }
  }
  // --- lead / arpège, avec écho pointé (3 répétitions)
  if (has(L_LEAD) && st.lead && st.leadKind) {
    const arp: number[] = [];
    for (let o = 0; o < 2; o++) for (const m of tc.chords[ci]) arp.push(m + 12 + 12 * o);
    const soft = bs.kind === 'breakdown' ? 0.6 : 1;
    const delay = Math.round(stepSec * 3 * sr);
    for (const [i, len, c] of parseNotes(tc.leadPat)) {
      const idx = parseInt(c, 10);
      if (Number.isNaN(idx)) continue;
      const f = mtof(arp[idx % arp.length]);
      const nl = Math.round(len * stepSec * sr * 0.9);
      if (st.leadKind === 'guitar') {
        vx.guitar(pumped, stepAt(i), Math.max(nl, Math.round(stepSec * 3 * sr)), f / 2, (st.leadGain ?? 0.1) * soft, (i % 4) / 4 - 0.4);
        continue;
      }
      for (let k = 0; k < 3; k++) {
        vx.lead(pumped, stepAt(i) + k * delay, nl, f, st.leadKind, (st.leadGain ?? 0.05) * soft * Math.pow(0.42, k), k === 0 ? 0 : k % 2 ? -0.6 : 0.6, soft * (1 - 0.3 * k));
      }
    }
  }
  // --- voix
  if (has(L_VOX) && st.vox !== 'none') {
    const ch = tc.chords[ci];
    if (st.vox === 'chop') {
      const at = bs.vb % 2 ? [0, 6] : [10];
      for (const i of at) {
        const s = stepAt(i);
        const len = Math.round(stepSec * 2 * sr);
        vx.vox(main, s, len, mtof(ch[1] + 12), (bs.vb + i) % 3 === 0 ? 0 : 2, 0.16, 0, 0.04);
        vx.vox(main, s + Math.round(stepSec * 3 * sr), len, mtof(ch[1] + 12), 0, 0.05, -0.6, 0.04);
      }
    } else if (st.vox === 'chant') {
      const notes = [ch[0], ch[2], ch[1]];
      [0, 3, 6].forEach((i, k) => vx.vox(main, stepAt(i + (bs.vb % 2) * 8), Math.round(stepSec * 2.2 * sr), mtof(notes[k] + 12), k % 2 ? 2 : 1, 0.13, 0.15 * (k - 1)));
    } else {
      // chanté : deux notes longues par mesure
      const notes = bs.vb % 2 ? [ch[2], ch[1]] : [ch[1], ch[3]];
      const g = bs.kind === 'drop' ? 0.12 : 0.08;
      [0, 8].forEach((i, k) => vx.vox(main, stepAt(i), Math.round(stepSec * 7 * sr), mtof(notes[k] + 12), k === 0 ? 0 : 2, g, 0, 0, 0.1));
    }
  }
  // --- « rap » : syllabes sur la grille de doubles-croches
  if (has(L_RAP)) {
    const RAP = ['xx.xx.x.xx.x.xx.', 'x.xxx.xx.x.xx...', '.xx.xx.xxx.x.x.x', 'xx.x.xx.x.xx.x..'];
    const pat = RAP[bs.vb % RAP.length];
    for (let i = 0; i < 16; i++) {
      if (pat[i] !== 'x') continue;
      const s = stepAt(i);
      const f = 118 + rnd() * 26 + (i % 4 === 0 ? 12 : 0);
      vx.noise(main, s, 'hp', 4000, 0.8, 0.001, 0.008, 0.12, 0, 0.02);
      vx.vox(main, s, Math.round(stepSec * 0.75 * sr), f, Math.floor(rnd() * 5), 0.15, 0, 0.12, 0.2);
    }
  }
  // --- montée : roulement de caisse claire + riser
  if (has(L_ROLL)) {
    const div = bs.prog < 0.25 ? 4 : bs.prog < 0.5 ? 2 : 1;   // noire, croche, double
    const endStep = isBuildEnd ? 12 : 16;
    for (let i = 0; i < endStep; i += div) {
      const p = bs.prog + ((bs.progEnd - bs.prog) * i) / 16;
      vx.snare(main, stepAt(i), 0.1 + 0.2 * p, 190 + 120 * p);
    }
    if (isBuildEnd) for (let k = 0; k < 4; k++) vx.snare(main, Math.round((10 + k * 0.5) * stepSec * sr), 0.3, 320);
  }
  if (has(L_RISER)) vx.riser(main, 0, isBuildEnd ? Math.round(stepSec * 15 * sr) : barLen, bs.prog, bs.progEnd, 0.12);
  if (bs.crash) {
    vx.noise(main, 0, 'hp', 5000, 0.7, 0.002, 0.42, 0.11, -0.8, 1.55);
    vx.noise(main, 0, 'hp', 5200, 0.7, 0.002, 0.42, 0.11, 0.8, 1.55);
  }

  // --- pompe (sidechain) sur basse + nappe + lead quand le kick est là
  const depth = has(L_KICK) ? st.pump : 0;
  const beatS = tc.beatSec * sr;
  const kt = Math.exp(-1 / (0.11 * sr));
  const atk = 1 / (0.004 * sr);
  let ph = 0, e = 1;
  let usedP = n;
  while (usedP > 0 && pumped.L[usedP - 1] === 0 && pumped.R[usedP - 1] === 0) usedP--;
  for (let i = 0; i < usedP; i++) {
    const g = depth > 0 ? 1 - depth * e * Math.min(1, ph * atk + 0.3) : 1;
    main.L[i] += pumped.L[i] * g;
    main.R[i] += pumped.R[i] * g;
    ph++; e *= kt;
    if (ph >= beatS) { ph -= beatS; e = Math.exp(-ph / (0.11 * sr)); }
  }
  return main;
}

function planBars(tc: TrackCtx): Array<{ bar: number; spec: BarSpec }> {
  const parts = planParts(tc.spec);
  const st = tc.st;
  const song = SONG_STYLES.has(tc.spec.style);
  const out: Array<{ bar: number; spec: BarSpec }> = [];
  let bar = 0;
  for (const p of parts) {
    const nb = p.beats / 4;
    for (let b = 0; b < nb; b++) {
      const pb = b % 8;
      const half = b >= nb / 2;
      const last = b === nb - 1;
      let layers = 0;
      let crash = false;
      let fill = pb === 7 || last;
      let vb = b % 4;
      const q = (x: number) => Math.round(x * 16) / 16;
      let prog = q(b / nb), progEnd = q((b + 1) / nb);
      if (!song) {
        switch (p.kind) {
          case 'intro': layers = L_KICK | L_HAT | L_PERC | (half ? L_OHAT | L_CLAP : 0); fill = fill && half; break;
          case 'body': layers = L_KICK | L_HAT | L_OHAT | L_CLAP | L_PERC | L_BASS | (b % 8 >= 4 ? L_PAD : 0) | (pb === 6 || pb === 7 ? L_VOX : 0); break;
          case 'drop': layers = L_KICK | L_HAT | L_OHAT | L_CLAP | L_PERC | L_BASS | L_PAD | L_LEAD | (pb === 3 || pb === 7 ? L_VOX : 0); crash = b === 0; break;
          case 'breakdown': layers = L_PAD | L_VOX | (half ? L_LEAD : 0); crash = b === 0; fill = false; break;
          case 'build': layers = L_PAD | L_ROLL | L_RISER | L_HAT; fill = false; break;
          case 'outro': layers = L_KICK | L_HAT | L_PERC | (half ? 0 : L_OHAT | L_CLAP); fill = fill && !half; break;
        }
        if (st.vox === 'sung' && p.kind === 'drop') layers |= L_VOX;
      } else {
        switch (p.kind) {
          case 'intro': layers = L_PAD | L_HAT | (half || tc.spec.style === 'synthpop' ? L_KICK | L_LEAD : 0); fill = last; break;
          case 'body': layers = L_KICK | L_CLAP | L_HAT | L_PERC | L_BASS | L_PAD | (st.rapVerse ? L_RAP : L_VOX); break;
          case 'drop': layers = L_KICK | L_CLAP | L_HAT | L_OHAT | L_PERC | L_BASS | L_PAD | L_LEAD | L_VOX; crash = b === 0; break;
          case 'breakdown': layers = L_PAD | L_VOX | (half ? L_LEAD : 0); fill = false; break;
          case 'outro': layers = L_KICK | L_CLAP | L_HAT | L_PAD; break;
          default: layers = L_PAD;
        }
        if (p.kind === 'body') vb = b % 4;
      }
      if (st.hatRolls) vb = b % 4;
      // les paramètres qui n'influent pas sur le rendu sont neutralisés (meilleur cache)
      const tonal = (layers & (L_BASS | L_PAD | L_LEAD | L_VOX | L_RAP)) !== 0 || st.kick808;
      const chord = tonal ? Math.floor(b / st.barsPerChord) % tc.chords.length : 0;
      if (!(p.kind === 'breakdown' || p.kind === 'build' || p.kind === 'body' || p.kind === 'intro') || !(layers & (L_PAD | L_RISER | L_ROLL))) { prog = 0; progEnd = 0; }
      if (!(layers & (L_VOX | L_RAP)) && !st.hatRolls) vb = 0;
      out.push({ bar, spec: { kind: p.kind, layers, chord, fill, crash, prog, progEnd, vb, last: last && p.kind === 'build' } });
      bar++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Rendu complet
// ---------------------------------------------------------------------------------------------

const TARGET_RMS = Math.pow(10, -11 / 20);
const CEILING = Math.pow(10, -1.1 / 20);

export interface DemoPcm { left: Float32Array; right: Float32Array }

export function renderSpecPcm(spec: DemoSpec, sampleRate: number): DemoPcm {
  const tc = buildCtx(spec, sampleRate);
  const total = demoDurationOf(spec) * sampleRate;
  const left = new Float32Array(total), right = new Float32Array(total);
  const cache = new Map<string, Bus>();
  const bt = demoBeatTimes(spec);
  const rubato = !!tc.st.rubato;
  const dropMask = new Uint8Array(Math.ceil(total / 4096) + 1);
  for (const { bar, spec: bs } of planBars(tc)) {
    let key = `${bs.kind}|${bs.layers}|${bs.chord}|${+bs.fill}|${+bs.crash}|${bs.prog}|${bs.progEnd}|${bs.vb}|${+bs.last}`;
    let btc = tc;
    if (rubato) {
      // tempo libre : chaque mesure a sa propre carte des temps, donc pas de cache
      const t0 = bt[4 * bar];
      const beatPos = [0, 1, 2, 3, 4].map((k) => bt[4 * bar + k] - t0);
      const barSec = beatPos[4];
      btc = { ...tc, beatPos, beatSec: barSec / 4, stepSec: barSec / 16, barLen: Math.ceil(barSec * sampleRate) };
      key += `|bar${bar}`;
    }
    let bus = cache.get(key);
    if (!bus) { bus = renderBar(btc, bs, key); if (!rubato) cache.set(key, bus); }
    const s0 = Math.round(bt[4 * bar] * sampleRate);
    const n = Math.min(bus.L.length, total - s0);
    const bl = bus.L, br = bus.R;
    for (let i = 0; i < n; i++) { left[s0 + i] += bl[i]; right[s0 + i] += br[i]; }
    if (bs.kind === 'drop') for (let k = Math.floor(s0 / 4096); k < Math.floor((s0 + btc.barLen) / 4096); k++) dropMask[k] = 1;
  }
  // normalisation sur l'énergie RMS des drops
  let acc = 0, cnt = 0;
  for (let k = 0; k < dropMask.length; k++) {
    if (!dropMask[k]) continue;
    const a = k * 4096, b = Math.min(total, a + 4096);
    for (let i = a; i < b; i += 3) { acc += left[i] * left[i] + right[i] * right[i]; cnt += 2; }
  }
  const rms = Math.sqrt(acc / Math.max(1, cnt)) || 1e-9;
  const gain = TARGET_RMS / rms;
  limit(left, right, gain, sampleRate);
  return { left, right };
}

/** Gain puis limiteur à anticipation par blocs (pas de saturation : gain toujours <= besoin). */
function limit(L: Float32Array, R: Float32Array, gain: number, sr: number): void {
  const B = 32;
  const nb = Math.ceil(L.length / B);
  const need = new Float32Array(nb);
  for (let k = 0; k < nb; k++) {
    let pk = 0;
    const end = Math.min(L.length, (k + 1) * B);
    for (let i = k * B; i < end; i++) {
      const a = Math.abs(L[i]), b = Math.abs(R[i]);
      if (a > pk) pk = a;
      if (b > pk) pk = b;
    }
    pk *= gain;
    need[k] = pk > CEILING ? CEILING / pk : 1;
  }
  const look = Math.max(2, Math.round((0.004 * sr) / B));
  const relCoef = 1 - Math.exp(-B / (0.12 * sr));
  // minimum glissant sur [k-1, k+look]
  const g = new Float32Array(nb);
  let cur = 1;
  for (let k = 0; k < nb; k++) {
    let m = 1;
    for (let j = Math.max(0, k - 1); j <= Math.min(nb - 1, k + look); j++) if (need[j] < m) m = need[j];
    cur = m < cur ? m : cur + (m - cur) * relCoef;
    if (cur > m) cur = m;
    g[k] = cur;
  }
  let prev = g[0];
  for (let k = 0; k < nb; k++) {
    const gk = g[k];
    const end = Math.min(L.length, (k + 1) * B);
    for (let i = k * B; i < end; i++) {
      const t = (i - k * B + 1) / B;
      const gg = gain * (prev + (gk - prev) * t);
      let l = L[i] * gg, r = R[i] * gg;
      if (l > CEILING) l = CEILING; else if (l < -CEILING) l = -CEILING;
      if (r > CEILING) r = CEILING; else if (r < -CEILING) r = -CEILING;
      L[i] = l; R[i] = r;
    }
    prev = gk;
  }
}

export function renderDemoPcmImpl(id: number, sampleRate: number): DemoPcm {
  const spec = getDemoSpec(id);
  if (!spec) throw new Error(`Morceau de démo inconnu : ${id}`);
  return renderSpecPcm(spec, sampleRate);
}

// ---------------------------------------------------------------------------------------------
// Métadonnées (vérité terrain pour l'analyse et le cerveau)
// ---------------------------------------------------------------------------------------------

export interface DemoMeta {
  id: number;
  key: Camelot;
  keyName: string;
  /** Tempo nominal (= TrackRef.bpm). Pour le rubato, tempo moyen. */
  bpm: number;
  /** Tempo moyen réel mesuré sur la carte des temps. */
  realBpm: number;
  /** true = grille parfaitement régulière ; false = tempo libre (rubato). */
  tempoStable: boolean;
  /** Écart relatif max d'un intervalle entre temps par rapport au nominal (0 si stable). */
  tempoDeviation: number;
  /** Batterie électronique 4/4 (house, techno…) ? false pour chanson, slow, funk, rubato, rap… */
  fourOnTheFloor: boolean;
  /** Morceau joué « organique » prévu pour les re-edits (accéléré + boîte à rythmes dessous). */
  reEditCandidate: boolean;
  /** Instants (s) de chaque temps du morceau (longueur = nombre de temps + 1). */
  beatTimes: Float64Array;
  structure: DemoStructureItem[];
}

export function demoMetaOf(spec: DemoSpec): DemoMeta {
  const st = STYLES[spec.style];
  const bt = demoBeatTimes(spec);
  const nominal = 60 / spec.bpm;
  let dev = 0;
  for (let k = 1; k < bt.length; k++) dev = Math.max(dev, Math.abs((bt[k] - bt[k - 1]) / nominal - 1));
  const beats = bt.length - 1;
  const four = st.kick.replace(/[xXo]/g, 'x') === 'x...x...x...x...';
  return {
    id: spec.id,
    key: spec.key,
    keyName: camelotInfo(spec.key).name,
    bpm: spec.bpm,
    realBpm: (60 * beats) / bt[beats],
    tempoStable: !st.rubato,
    tempoDeviation: dev < 1e-9 ? 0 : dev,
    fourOnTheFloor: four,
    reEditCandidate: st.electronicDrums === false && !st.rubato,
    beatTimes: bt,
    structure: demoStructureOf(spec),
  };
}
