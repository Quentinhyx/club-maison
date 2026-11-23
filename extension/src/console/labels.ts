import type { Camelot, DeckStatus, FxKind, Section, StyleProfileId, TransitionTechnique } from '../../../shared/contracts';

export const TECHNIQUE_LABELS: Record<TransitionTechnique, string> = {
  'long-blend': 'Long blend',
  'bass-swap': 'Échange des basses',
  'filter-swap': 'Échange au filtre',
  'echo-out': 'Sortie en écho',
  cut: 'Coupe sèche',
  'riser-drop': 'Montée et drop',
  'reverb-wash': 'Noyade en réverb',
  'loop-roll': 'Boucle qui accélère',
  brake: 'Frein platine',
};

export const FX_LABELS: Record<FxKind, string> = {
  'echo-throw': 'Lancer d’écho',
  'reverb-throw': 'Lancer de réverb',
  'filter-sweep': 'Balayage filtre',
  'low-cut': 'Coupe des basses',
  riser: 'Montée',
  impact: 'Impact',
  gate: 'Gate',
  brake: 'Frein',
  loop: 'Boucle',
  'loop-roll': 'Loop roll',
};

export const STYLE_LABELS: Partial<Record<StyleProfileId, string>> = {
  soiree: 'Soirée',
  'paris-tech-house': 'Paris tech house',
  'open-format': 'Open format',
  lounge: 'Lounge',
  'peak-time': 'Peak time',
};

/** Ordre d'affichage des styles : « Soirée » en premier. */
export function styleOrder(ids: StyleProfileId[]): StyleProfileId[] {
  return [...ids].sort((a, b) => (a === 'soiree' ? -1 : b === 'soiree' ? 1 : 0));
}

/** Longueur de boucle lisible : 4, 2, 1, 1/2, 1/4… */
export function fmtLoop(beats: number): string {
  if (beats >= 1) return String(Math.round(beats * 100) / 100);
  const d = Math.round(1 / beats);
  return `1/${d}`;
}

export const SECTION_LABELS: Record<Section, string> = {
  intro: 'INTRO',
  body: 'CORPS',
  build: 'BUILD',
  drop: 'DROP',
  breakdown: 'BREAK',
  outro: 'OUTRO',
  unknown: '—',
};

export const STATUS_LABELS: Record<DeckStatus, string> = {
  empty: 'VIDE',
  loading: 'CHARGEMENT',
  ready: 'PRÊTE',
  playing: 'LECTURE',
  paused: 'PAUSE',
  ended: 'FINI',
  error: 'ERREUR',
};

/** Couleurs de la roue Camelot (teintes réparties sur le cercle, mineur plus sombre). */
export function camelotColor(k?: Camelot): string {
  if (!k) return '#8A8A90';
  const n = parseInt(k, 10);
  const minor = k.endsWith('A');
  const hue = ((n - 1) * 30 + 150) % 360;
  return `hsl(${hue} ${minor ? 70 : 80}% ${minor ? 58 : 68}%)`;
}

export function fmtTime(s: number, tenths = false): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  const whole = Math.floor(sec);
  const base = `${String(m).padStart(2, '0')}:${String(whole).padStart(2, '0')}`;
  return tenths ? `${base}.${Math.floor((sec - whole) * 10)}` : base;
}

export function fmtPct(rate: number): string {
  const p = (rate - 1) * 100;
  const s = p >= 0 ? '+' : '−';
  return `${s}${Math.abs(p).toFixed(1)} %`;
}
