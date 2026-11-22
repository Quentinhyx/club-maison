/**
 * Boîte à rythmes pour les re-edits : motifs par style et planification PURE des événements.
 * La synthèse (Web Audio) est dans groove-machine.ts.
 *
 * Grille : anchorCtx est un premier temps de mesure ; double-croche k à anchorCtx + k * beat / 4.
 * Un événement est retenu si son instant NOMINAL (sur la grille, avant swing) est dans
 * [max(fromCtx, startCtx), toCtx[ : des fenêtres contiguës ne donnent ni doublon ni trou.
 */
import type { Camelot, GroovePlan, GrooveStyle } from '../contracts';

export type GroovePart = GroovePlan['parts'][number] | 'rumble';

export interface GrooveEvent {
  t: number;
  part: string;
  velocity: number;
  /** Note MIDI (basse, percussions accordées). */
  note?: number;
}

/** Classe de hauteur (0 = do) de la tonique, index = numéro Camelot - 1. */
const CAMELOT_PC_MINOR = [8, 3, 10, 5, 0, 7, 2, 9, 4, 11, 6, 1]; // 1A = la♭m ... 8A = lam ... 12A = do♯m
const CAMELOT_PC_MAJOR = [11, 6, 1, 8, 3, 10, 5, 0, 7, 2, 9, 4]; // 1B = si ... 8B = do ... 12B = mi

/**
 * Tonique d'une tonalité Camelot en note MIDI, dans le registre de basse mi1 (28) .. ré♯2 (39),
 * soit 41 à 78 Hz. Ex. 8A (la mineur) -> 33 (la1, 55 Hz).
 */
export function camelotRootMidi(key: Camelot): number {
  const m = /^(\d{1,2})([AB])$/.exec(key);
  if (!m) return 33;
  const n = Math.min(12, Math.max(1, parseInt(m[1], 10)));
  const pc = (m[2] === 'A' ? CAMELOT_PC_MINOR : CAMELOT_PC_MAJOR)[n - 1];
  return 28 + ((pc - 4 + 12) % 12);
}

export function midiToHz(n: number): number {
  return 440 * Math.pow(2, (n - 69) / 12);
}

// ---------------------------------------------------------------------------------------------
// Motifs (16 doubles-croches par mesure)
// ---------------------------------------------------------------------------------------------

interface Hit { step: number; v: number; note?: number }
interface StylePattern {
  kick: Hit[];
  clap: Hit[];
  hat: Hit[];
  openhat: Hit[];
  perc: Hit[];
  rumble: Hit[];
  /** note = décalage en demi-tons depuis la tonique */
  bass: Hit[];
  /** retard des doubles-croches impaires (fraction de double-croche) pour hat / perc */
  swing: number;
}

const FOUR = [0, 4, 8, 12];
const OFF8 = [2, 6, 10, 14];
const hits = (steps: number[], v: number, note?: number): Hit[] => steps.map((step) => ({ step, v, note }));
const sixteenths = (strong: number, weak: number): Hit[] =>
  Array.from({ length: 16 }, (_, i) => ({ step: i, v: i % 2 === 0 ? strong : weak }));

export const GROOVE_PATTERNS: Record<GrooveStyle, StylePattern> = {
  house: {
    kick: hits(FOUR, 1),
    clap: hits([4, 12], 0.85),
    hat: sixteenths(0.32, 0.22),              // shaker
    openhat: hits(OFF8, 0.6),
    perc: [{ step: 7, v: 0.35, note: 76 }, { step: 15, v: 0.25, note: 76 }],
    rumble: [],
    bass: [{ step: 2, v: 1, note: 0 }, { step: 6, v: 0.9, note: 0 }, { step: 10, v: 1, note: 0 }, { step: 14, v: 0.85, note: 12 }],
    swing: 0.12,
  },
  'tech-house': {
    kick: hits(FOUR, 1),
    clap: hits([4, 12], 0.8),
    hat: [...hits(OFF8, 0.55), ...hits([1, 3, 5, 7, 9, 11, 13, 15], 0.18)],
    openhat: hits([2, 10], 0.35),
    perc: [{ step: 3, v: 0.4, note: 72 }, { step: 7, v: 0.3, note: 67 }, { step: 11, v: 0.45, note: 72 }, { step: 14, v: 0.3, note: 64 }],
    rumble: [],
    // basse en rebond : contretemps + double-croche fantôme
    bass: [
      { step: 2, v: 1, note: 0 }, { step: 3, v: 0.55, note: 0 }, { step: 6, v: 1, note: 0 },
      { step: 10, v: 1, note: 0 }, { step: 11, v: 0.55, note: 0 }, { step: 14, v: 0.9, note: 7 },
    ],
    swing: 0.08,
  },
  disco: {
    kick: hits(FOUR, 0.95),
    clap: hits([4, 12], 0.9),
    hat: sixteenths(0.3, 0.18),
    openhat: hits(OFF8, 0.75),
    perc: [{ step: 14, v: 0.3, note: 79 }],
    rumble: [],
    // basse octaviée en croches
    bass: [0, 2, 4, 6, 8, 10, 12, 14].map((step, i) => ({ step, v: i % 2 ? 0.8 : 1, note: i % 2 ? 12 : 0 })),
    swing: 0.04,
  },
  'afro-house': {
    kick: hits(FOUR, 0.95),
    clap: hits([12], 0.6),
    hat: sixteenths(0.28, 0.2),
    openhat: hits([2, 10], 0.4),
    // congas synthétiques : aigu 69, médium 64, grave 57
    perc: [
      { step: 3, v: 0.6, note: 69 }, { step: 6, v: 0.55, note: 57 }, { step: 7, v: 0.45, note: 69 },
      { step: 10, v: 0.6, note: 64 }, { step: 13, v: 0.5, note: 69 }, { step: 14, v: 0.55, note: 57 },
      { step: 15, v: 0.35, note: 64 },
    ],
    rumble: [],
    bass: [{ step: 3, v: 0.9, note: 0 }, { step: 6, v: 1, note: 0 }, { step: 10, v: 0.9, note: 7 }, { step: 14, v: 1, note: 0 }],
    swing: 0.16,
  },
  techno: {
    kick: hits(FOUR, 1),
    clap: hits([4, 12], 0.65),
    hat: [...hits(OFF8, 0.6), ...hits([1, 3, 5, 7, 9, 11, 13, 15], 0.15)],
    openhat: [],
    perc: [{ step: 7, v: 0.3, note: 60 }, { step: 15, v: 0.25, note: 60 }],
    // rumble : queue grave roulante derrière chaque kick
    rumble: [1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15].map((step) => ({ step, v: step % 4 === 2 ? 0.7 : 0.45 })),
    bass: [{ step: 2, v: 0.9, note: 0 }, { step: 6, v: 0.9, note: 0 }, { step: 10, v: 0.9, note: 0 }, { step: 14, v: 0.9, note: 0 }],
    swing: 0,
  },
};

/**
 * Événements à jouer entre fromCtx (inclus) et toCtx (exclu). Les parties suivent plan.parts ;
 * la basse joue si plan.bass et plan.key (la partie 'bass' de parts n'est pas exigée). Le rumble
 * suit la partie 'kick'. Rien avant plan.startCtx.
 */
export function grooveSchedule(plan: GroovePlan, fromCtx: number, toCtx: number): GrooveEvent[] {
  const out: GrooveEvent[] = [];
  if (!(plan.bpm > 0) || !Number.isFinite(plan.anchorCtx)) return out;
  const pat = GROOVE_PATTERNS[plan.style] ?? GROOVE_PATTERNS.house;
  const step = 60 / plan.bpm / 4;
  const from = Math.max(fromCtx, plan.startCtx);
  if (!(toCtx > from)) return out;
  const parts = new Set<string>(plan.parts);
  const root = plan.bass && plan.key ? camelotRootMidi(plan.key) : null;

  const layers: Array<[string, Hit[], boolean]> = [
    ['kick', pat.kick, parts.has('kick')],
    ['rumble', pat.rumble, parts.has('kick')],
    ['clap', pat.clap, parts.has('clap')],
    ['hat', pat.hat, parts.has('hat')],
    ['openhat', pat.openhat, parts.has('openhat')],
    ['perc', pat.perc, parts.has('perc')],
    ['bass', pat.bass, root !== null],
  ];

  // première et dernière double-croche nominales dans la fenêtre (petite tolérance numérique)
  const eps = 1e-9;
  const k0 = Math.ceil((from - plan.anchorCtx) / step - eps);
  const k1 = Math.ceil((toCtx - plan.anchorCtx) / step - eps) - 1;
  for (let k = k0; k <= k1; k++) {
    const nominal = plan.anchorCtx + k * step;
    if (nominal < from - eps || nominal >= toCtx - eps) continue;
    const pos = ((k % 16) + 16) % 16;
    for (const [part, list, on] of layers) {
      if (!on) continue;
      for (const h of list) {
        if (h.step !== pos) continue;
        const swung = (part === 'hat' || part === 'perc') && pos % 2 === 1 ? pat.swing * step : 0;
        const ev: GrooveEvent = { t: nominal + swung, part, velocity: h.v };
        if (part === 'bass') ev.note = (root as number) + (h.note ?? 0);
        else if (h.note !== undefined) ev.note = h.note;
        out.push(ev);
      }
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Recalage en direct (tempo ou phase), appliqué au prochain temps. On vise le prochain temps de
 * l'ancienne grille après `afterCtx` (événements déjà programmés jusque-là) et on prend le temps
 * de la nouvelle grille le plus proche (`plan.startCtx` du plan renvoyé). L'ancien plan joue
 * jusqu'à `switchCtx` exclu = le plus tôt entre son prochain temps et une demi double-croche avant
 * le nouveau départ : jamais de doublon, au plus un demi-temps de décalage en cas de saut de phase.
 */
export function retimeGroove(
  plan: GroovePlan, bpm: number, anchorCtx: number, afterCtx: number,
): { switchCtx: number; plan: GroovePlan } {
  const oldBeat = 60 / plan.bpm;
  const newBeat = 60 / (bpm > 0 ? bpm : plan.bpm);
  const half = newBeat / 8;
  const kOld = Math.ceil((Math.max(afterCtx, plan.startCtx) - plan.anchorCtx) / oldBeat - 1e-9);
  const target = plan.anchorCtx + kOld * oldBeat;
  let s = anchorCtx + Math.round((target - anchorCtx) / newBeat) * newBeat;
  while (s - half < afterCtx - 1e-9) s += newBeat;
  return { switchCtx: Math.min(target, s - half), plan: { ...plan, bpm: 60 / newBeat, anchorCtx, startCtx: s } };
}
