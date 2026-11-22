/**
 * Paramètres logiques de la table : plages, valeurs neutres, interpolation des courbes et
 * conversions logique -> nœuds Web Audio. Tout est PUR (aucun accès Web Audio) et testable.
 *
 * Sémantique d'une lane : les points sont triés par t croissant. Le premier point fixe la valeur
 * (setValueAtTime). Pour chaque point suivant, `curve` décrit comment on y arrive depuis le point
 * précédent : 'linear' (rampe), 'exp' (exponentielle si les deux valeurs sont > 0, sinon linéaire),
 * 'smooth' (courbe en S, cosinus), 'step' (on garde la valeur précédente jusqu'à t, puis saut).
 * Courbe par défaut : 'linear'.
 */
import type {
  AutomationLane, AutomationPoint, Curve, DeckId, DeckParam, MasterParam, ParamTarget,
} from '../contracts';

export interface ParamSpec {
  min: number;
  max: number;
  /** Valeur par défaut à la création de la table. */
  def: number;
  /** Valeur « neutre » attendue en fin de transition / d'effet (absente = pas de neutre, ex. temps d'écho). */
  neutral?: number;
}

export const EQ_KILL_DB = -26;
export const EQ_MAX_DB = 6;

export const DECK_PARAMS: readonly DeckParam[] = [
  'gain', 'trim', 'eqLow', 'eqMid', 'eqHigh', 'filter', 'echoSend', 'reverbSend',
];
export const DECK_IDS: readonly DeckId[] = ['A', 'B'];

export const DECK_PARAM_SPECS: Record<DeckParam, ParamSpec> = {
  gain: { min: 0, max: 1, def: 1, neutral: 1 },
  trim: { min: 0, max: 4, def: 1, neutral: 1 },
  eqLow: { min: EQ_KILL_DB, max: EQ_MAX_DB, def: 0, neutral: 0 },
  eqMid: { min: EQ_KILL_DB, max: EQ_MAX_DB, def: 0, neutral: 0 },
  eqHigh: { min: EQ_KILL_DB, max: EQ_MAX_DB, def: 0, neutral: 0 },
  filter: { min: -1, max: 1, def: 0, neutral: 0 },
  echoSend: { min: 0, max: 1, def: 0, neutral: 0 },
  reverbSend: { min: 0, max: 1, def: 0, neutral: 0 },
};

export const ECHO_FEEDBACK_NEUTRAL = 0.35;
export const REVERB_RETURN_NEUTRAL = 0.8;

export const MASTER_PARAM_SPECS: Record<MasterParam, ParamSpec> = {
  'master.gain': { min: 0, max: 1, def: 1, neutral: 1 },
  'master.filter': { min: -1, max: 1, def: 0, neutral: 0 },
  'fx.echo.feedback': { min: 0, max: 0.95, def: ECHO_FEEDBACK_NEUTRAL, neutral: ECHO_FEEDBACK_NEUTRAL },
  'fx.echo.time': { min: 0.01, max: 3, def: 0.35 },
  'fx.echo.tone': { min: -1, max: 1, def: 0, neutral: 0 },
  'fx.reverb.return': { min: 0, max: 1, def: REVERB_RETURN_NEUTRAL, neutral: REVERB_RETURN_NEUTRAL },
  'fx.noise.gain': { min: 0, max: 1, def: 0, neutral: 0 },
  'fx.noise.filter': { min: 20, max: 20000, def: 1000 },
  'fx.gate.depth': { min: 0, max: 1, def: 0, neutral: 0 },
  'fx.gate.rate': { min: 1, max: 8, def: 4 },
  'groove.gain': { min: 0, max: 1, def: 0, neutral: 0 },
  'groove.filter': { min: -1, max: 1, def: 0, neutral: 0 },
  'groove.eqLow': { min: EQ_KILL_DB, max: EQ_MAX_DB, def: 0, neutral: 0 },
};

export const MASTER_PARAMS = Object.keys(MASTER_PARAM_SPECS) as MasterParam[];

/** Toutes les cibles automatisables. */
export const ALL_TARGETS: readonly ParamTarget[] = [
  ...DECK_IDS.flatMap((d) => DECK_PARAMS.map((p) => `${d}.${p}` as ParamTarget)),
  ...MASTER_PARAMS,
];

export function isDeckTarget(t: ParamTarget): t is `${DeckId}.${DeckParam}` {
  return t.startsWith('A.') || t.startsWith('B.');
}

export function splitDeckTarget(t: `${DeckId}.${DeckParam}`): { deck: DeckId; param: DeckParam } {
  return { deck: t[0] as DeckId, param: t.slice(2) as DeckParam };
}

export function paramSpec(t: ParamTarget): ParamSpec {
  if (isDeckTarget(t)) return DECK_PARAM_SPECS[splitDeckTarget(t).param];
  return MASTER_PARAM_SPECS[t];
}

export function clampParam(t: ParamTarget, v: number): number {
  const s = paramSpec(t);
  if (!Number.isFinite(v)) return s.def;
  return Math.min(s.max, Math.max(s.min, v));
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------------------------

/** Valeur entre a et b pour x dans [0, 1] selon la courbe. */
export function interp(curve: Curve | undefined, a: number, b: number, x: number): number {
  const u = clamp(x, 0, 1);
  switch (curve ?? 'linear') {
    case 'step':
      return u < 1 ? a : b;
    case 'smooth':
      return a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * u));
    case 'exp':
      if (a > 0 && b > 0) return a * Math.pow(b / a, u);
      return a + (b - a) * u;
    default:
      return a + (b - a) * u;
  }
}

/** Valeur d'une suite de points à l'instant t (avant le premier point : valeur du premier). */
export function valueAtPoints(points: readonly AutomationPoint[], t: number): number | undefined {
  if (points.length === 0) return undefined;
  if (t < points[0].t) return points[0].v;
  // dernier point dont t <= instant (points triés ; en cas d'égalité, le dernier gagne)
  let i = 0;
  for (let k = 0; k < points.length; k++) {
    if (points[k].t <= t) i = k;
    else break;
  }
  const p = points[i];
  const n = points[i + 1];
  if (!n) return p.v;
  const dur = n.t - p.t;
  if (dur <= 0) return n.v;
  return interp(n.curve, p.v, n.v, (t - p.t) / dur);
}

export function valueAt(lane: AutomationLane, t: number): number | undefined {
  return valueAtPoints(lane.points, t);
}

export function sortPoints(points: readonly AutomationPoint[]): AutomationPoint[] {
  return points
    .map((p, i) => ({ p, i }))
    .sort((x, y) => x.p.t - y.p.t || x.i - y.i)
    .map((x) => x.p);
}

// ---------------------------------------------------------------------------------------------
// Conversions logique -> nœuds
// ---------------------------------------------------------------------------------------------

export const FILTER_LP_MIN_HZ = 80;     // passe-bas complètement fermé (bouton à -1)
export const FILTER_HP_MIN_HZ = 15;     // passe-haut juste engagé
export const FILTER_HP_MAX_HZ = 6000;   // passe-haut complètement fermé (bouton à +1)
/** Q des biquads en dB (convention Web Audio pour lowpass/highpass) : -3.01 dB = Butterworth, plat. */
export const Q_FLAT_DB = -3.01;
export const Q_RES_DB = 3;              // résonance légère quand le filtre est engagé

/**
 * Filtre DJ un bouton. À 0 : passe-bas à Nyquist et passe-haut à 0 Hz, ce que les biquads Web Audio
 * traitent comme une identité exacte (bypass propre, aucune coloration). Mapping exponentiel.
 */
export function djFilterToNodes(v: number, nyquist: number): { lpHz: number; hpHz: number; qDb: number } {
  const x = clamp(v, -1, 1);
  const top = Math.max(FILTER_LP_MIN_HZ * 2, nyquist);
  // résonance qui monte vite puis plafonne (léger)
  const qDb = Q_FLAT_DB + (Q_RES_DB - Q_FLAT_DB) * Math.min(1, Math.abs(x) / 0.25);
  if (x < 0) {
    return { lpHz: FILTER_LP_MIN_HZ * Math.pow(top / FILTER_LP_MIN_HZ, 1 + x), hpHz: 0, qDb };
  }
  if (x > 0) {
    return { lpHz: top, hpHz: FILTER_HP_MIN_HZ * Math.pow(FILTER_HP_MAX_HZ / FILTER_HP_MIN_HZ, x), qDb };
  }
  return { lpHz: top, hpHz: 0, qDb: Q_FLAT_DB };
}

/** Tonalité de l'écho : -1 sombre (passe-bas 700 Hz), 0 légèrement assombri, +1 fin (passe-haut 2,5 kHz). */
export function echoToneToNodes(v: number): { lpHz: number; hpHz: number } {
  const x = clamp(v, -1, 1);
  if (x < 0) return { lpHz: 700 * Math.pow(8000 / 700, 1 + x), hpHz: 100 };
  return { lpHz: 8000 + 6000 * x, hpHz: 100 * Math.pow(2500 / 100, x) };
}

/** Gain du bruit blanc (le bruit plein pot est très fort : plafonné à -10 dB environ). */
export const NOISE_MAX_GAIN = 0.3;

// ---------------------------------------------------------------------------------------------
// Gate rythmique : rendu en impulsions calées sur la grille
// ---------------------------------------------------------------------------------------------

/**
 * Transforme les lanes logiques fx.gate.depth / fx.gate.rate en automation du gain de gate
 * (1 = ouvert). Chaque division (beat / rate) : ouvert sur la première moitié, fermé (1 - depth)
 * sur la seconde, fronts de 3 ms pour éviter les clics. Les divisions partent de `from`
 * (normalement un temps) et sont recalées sur la grille de la division courante.
 */
export function renderGate(
  depth: readonly AutomationPoint[],
  rate: readonly AutomationPoint[],
  bpm: number,
  from: number,
  to: number,
  defaultRate = MASTER_PARAM_SPECS['fx.gate.rate'].def,
): AutomationPoint[] {
  const beat = 60 / clamp(bpm, 40, 250);
  const out: AutomationPoint[] = [{ t: from, v: 1 }];
  let t = from;
  let guard = 0;
  while (t < to - 1e-6 && guard++ < 20000) {
    const r = clamp(Math.round(valueAtPoints(rate, t + 1e-6) ?? defaultRate), 1, 16);
    const d = beat / r;
    const dep = clamp(valueAtPoints(depth, t + 1e-6) ?? 0, 0, 1);
    const end = Math.min(t + d, to);
    if (dep > 0.001 && end - t > 0.004) {
      const edge = Math.min(0.003, d / 8);
      const half = t + d / 2;
      if (half + edge < end) {
        out.push({ t: half, v: 1, curve: 'linear' });
        out.push({ t: half + edge, v: 1 - dep, curve: 'linear' });
        out.push({ t: Math.max(half + edge, end - edge), v: 1 - dep, curve: 'linear' });
        out.push({ t: end, v: 1, curve: 'linear' });
      }
    }
    t = end;
  }
  out.push({ t: Math.max(to, t), v: 1, curve: 'linear' });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Réponse impulsionnelle de réverb (grande salle sombre)
// ---------------------------------------------------------------------------------------------

/** PRNG déterministe (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * IR stéréo : pré-délai, quelques réflexions précoces, queue de bruit à décroissance
 * exponentielle (RT60 = `seconds`), assombrie au fil du temps (passe-bas à un pôle dont la
 * coupure descend de ~6 kHz à ~700 Hz). Les deux canaux sont décorrélés.
 */
export function generateImpulse(sampleRate: number, seconds = 4, seed = 7): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  const len = Math.max(1, Math.floor(sampleRate * (seconds + 0.3)));
  const pre = Math.floor(0.022 * sampleRate);
  const chans: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] = [new Float32Array(len), new Float32Array(len)];
  for (let c = 0; c < 2; c++) {
    const rnd = prng(seed + c * 101);
    const data = chans[c];
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sampleRate;
      const env = Math.exp((-6.9 * t) / seconds) * Math.min(1, t / 0.012);
      const cutoff = 700 + 5300 * Math.exp(-t / 0.9);
      const a = 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate);
      lp += a * (rnd() * 2 - 1 - lp);
      data[i] = lp * env;
    }
    // réflexions précoces (salle large)
    const taps = [0.011, 0.019, 0.027, 0.041, 0.053, 0.067];
    for (let k = 0; k < taps.length; k++) {
      const i = pre + Math.floor((taps[k] + c * 0.0037) * sampleRate);
      if (i < len) data[i] += (rnd() > 0.5 ? 1 : -1) * 0.5 * Math.pow(0.8, k);
    }
  }
  return chans;
}
