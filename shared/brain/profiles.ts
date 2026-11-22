/**
 * Profils de style : comment le DJ mixe (techniques, durées, effets, tempo, énergie de la soirée).
 */
import type { DjSettings, FxKind, Genre, StyleProfileId, TransitionTechnique } from '../contracts';
import { GENRES } from '../contracts';
import { isElectronic } from './genres';

/** Situation au moment de sortir d'un morceau : sert à choisir la technique. */
export type TransitionSituation =
  | 'same-genre'    // on reste dans le style
  | 'genre-change'  // on change de style (pont ou saut)
  | 'tempo-jump'    // écart de tempo impossible à caler
  | 'breakdown'     // on sort pendant un breakdown (réverb, mélodique)
  | 'outro'         // le sortant entre dans son outro
  | 'emergency';    // plus le temps : fin du morceau imminente

export const SITUATIONS: TransitionSituation[] = ['same-genre', 'genre-change', 'tempo-jump', 'breakdown', 'outro', 'emergency'];

export interface StyleProfile {
  id: StyleProfileId;
  label: string;
  description: string;
  /** Poids des techniques par situation (tirage pondéré, 0/absent = jamais). */
  techniqueWeights: Record<TransitionSituation, Partial<Record<TransitionTechnique, number>>>;
  /** Durée de transition en temps [min, max] par technique (puissances de 2 entre les bornes). */
  transitionBeats: Record<TransitionTechnique, [number, number]>;
  /** Durée typique, utilisée pour anticiper une sortie forcée. */
  typicalTransitionBeats: number;
  /** Densité d'effets 0..1 (multipliée par fxAmount). */
  fxDensity: number;
  /** Budget : au plus un effet en cours de morceau toutes les N phrases. */
  fxEveryPhrases: number;
  /** Effets autorisés en cours de morceau, avec leur poids. */
  fxWeights: Partial<Record<FxKind, number>>;
  allowRiser: boolean;
  allowGate: boolean;
  /** Riser seulement pour un changement de genre ou un moment de pic. */
  riserOnlyOnGenreChangeOrPeak: boolean;
  /** Durée de jeu typique (s) [min, max] par genre. */
  playSeconds: Record<Genre, [number, number]>;
  /** Facteur appliqué à la durée de jeu d'un morceau de pont (genre intermédiaire). */
  bridgePlayFactor: number;
  /** Probabilité de laisser un morceau jusqu'au bout (« en entier »). */
  playFullChance: number;
  /** BPM cible : de bpmRange[0] en début de soirée à bpmRange[1] après bpmRampMinutes. */
  bpmRange: [number, number];
  bpmRampMinutes: number;
  /** Courbe d'énergie de soirée : [minutes depuis le début, énergie 0..1], interpolée. */
  energyCurve: Array<[number, number]>;
  /** Durée minimale (min) dans un genre visé avant de suivre un nouveau vote. */
  genreDwellMinutes: number;
  /** Saut direct vers le genre visé si le coût du chemin est <= à ceci (0 = toujours faire le pont). */
  maxDirectJumpCost: number;
  /** Retour progressif du rate à 1 après un calage. */
  rateRelaxBeats: number;
  /** Plafond d'intensité des effets dans les transitions. */
  maxIntensity: number;
  /** Les morceaux électroniques suivent le tempo de soirée (rampes de rate) au lieu de revenir à 1. */
  followPartyTempo: boolean;
  /** Probabilité de tenter un re-edit quand l'occasion se présente (morceau lent après de la house). */
  reEditChance: number;
  /** Écart de vitesse maximal en re-edit (lounge : 8 %). */
  reEditMaxDelta: number;
  /** Au moins N morceaux entre deux re-edits. */
  reEditCooldownTracks: number;
  /** Probabilité (× fxAmount × 2) de pousser le tempo de 1 % pendant un build. */
  buildPushChance: number;
}

function playMap(electro: [number, number], other: [number, number], over: Partial<Record<Genre, [number, number]>> = {}): Record<Genre, [number, number]> {
  return Object.fromEntries(GENRES.map((g) => [g, over[g] ?? (isElectronic(g) ? electro : other)])) as Record<Genre, [number, number]>;
}

const HITS: Genre[] = ['rap-fr', 'rap-us', 'rnb', 'pop', 'latino', 'reggaeton', 'dancehall', 'afro', '80s', '90s', '2000s', 'rock', 'funk', 'disco'];

export const STYLE_PROFILES: Record<StyleProfileId, StyleProfile> = {
  'paris-tech-house': {
    id: 'paris-tech-house',
    label: 'Paris tech house',
    description: 'Tech house froide : blends longs avec échange des basses, peu d’effets mais bien placés, morceaux joués longtemps.',
    techniqueWeights: {
      'same-genre': { 'long-blend': 6, 'bass-swap': 2, 'filter-swap': 2 },
      'genre-change': { 'long-blend': 3, 'filter-swap': 3, 'riser-drop': 1, 'echo-out': 1 },
      'tempo-jump': { 'echo-out': 3, 'reverb-wash': 3, 'riser-drop': 1 },
      breakdown: { 'reverb-wash': 3, 'long-blend': 3, 'filter-swap': 1 },
      outro: { 'long-blend': 5, 'bass-swap': 2 },
      emergency: { 'echo-out': 3, 'bass-swap': 1, cut: 0.5 },
    },
    transitionBeats: {
      'long-blend': [32, 64], 'bass-swap': [16, 16], 'filter-swap': [16, 32], 'echo-out': [4, 8], cut: [1, 1],
      'riser-drop': [8, 16], 'reverb-wash': [8, 16], 'loop-roll': [4, 8], brake: [2, 2],
    },
    typicalTransitionBeats: 32,
    fxDensity: 0.25,
    fxEveryPhrases: 6,
    fxWeights: { 'echo-throw': 2, 'reverb-throw': 1.5, 'low-cut': 2, 'filter-sweep': 0.5, riser: 0.5 },
    allowRiser: true,
    allowGate: false,
    riserOnlyOnGenreChangeOrPeak: true,
    playSeconds: playMap([180, 360], [100, 200]),
    bridgePlayFactor: 0.6,
    playFullChance: 0.12,
    bpmRange: [122, 128],
    bpmRampMinutes: 300,
    energyCurve: [[0, 0.45], [60, 0.6], [150, 0.8], [240, 0.9], [330, 0.75]],
    genreDwellMinutes: 10,
    maxDirectJumpCost: 0,
    rateRelaxBeats: 64,
    maxIntensity: 0.7,
    followPartyTempo: true,
    reEditChance: 0.35,
    reEditMaxDelta: 0.3,
    reEditCooldownTracks: 4,
    buildPushChance: 0.15,
  },
  'open-format': {
    id: 'open-format',
    label: 'Open format',
    description: 'Tous les styles, mix rapides pour les tubes, changements de genre fréquents avec des ruptures assumées.',
    techniqueWeights: {
      'same-genre': { 'bass-swap': 2, 'echo-out': 3, cut: 2, 'filter-swap': 1, 'long-blend': 1 },
      'genre-change': { 'echo-out': 3, cut: 3, 'riser-drop': 2, 'loop-roll': 1 },
      'tempo-jump': { 'loop-roll': 3, 'echo-out': 3, cut: 2, 'riser-drop': 1, brake: 0.5 },
      breakdown: { 'reverb-wash': 1, 'echo-out': 2, cut: 1 },
      outro: { 'bass-swap': 2, 'echo-out': 2, cut: 1 },
      emergency: { 'echo-out': 2, cut: 2 },
    },
    transitionBeats: {
      'long-blend': [16, 32], 'bass-swap': [8, 16], 'filter-swap': [8, 16], 'echo-out': [4, 8], cut: [1, 1],
      'riser-drop': [8, 8], 'reverb-wash': [8, 8], 'loop-roll': [4, 4], brake: [2, 2],
    },
    typicalTransitionBeats: 8,
    fxDensity: 0.5,
    fxEveryPhrases: 3,
    fxWeights: { 'echo-throw': 2, 'filter-sweep': 2, 'low-cut': 1, 'reverb-throw': 1, riser: 0.5 },
    allowRiser: true,
    allowGate: false,
    riserOnlyOnGenreChangeOrPeak: false,
    playSeconds: playMap([60, 150], [30, 90], Object.fromEntries(HITS.map((g) => [g, [30, 90]]))),
    bridgePlayFactor: 1,
    playFullChance: 0,
    bpmRange: [118, 126], // tempo de soirée des morceaux électroniques (les tubes gardent leur tempo)
    bpmRampMinutes: 240,
    energyCurve: [[0, 0.55], [60, 0.7], [150, 0.85], [300, 0.8]],
    genreDwellMinutes: 4,
    maxDirectJumpCost: Infinity,
    rateRelaxBeats: 32,
    maxIntensity: 0.9,
    followPartyTempo: true,
    reEditChance: 0.6,
    reEditMaxDelta: 0.3,
    reEditCooldownTracks: 2,
    buildPushChance: 0.2,
  },
  lounge: {
    id: 'lounge',
    label: 'Lounge',
    description: 'Début de soirée : transitions longues et douces, réverb, ni riser ni gate.',
    techniqueWeights: {
      'same-genre': { 'long-blend': 5, 'filter-swap': 2, 'reverb-wash': 2 },
      'genre-change': { 'reverb-wash': 3, 'long-blend': 2, 'filter-swap': 2, 'echo-out': 1 },
      'tempo-jump': { 'reverb-wash': 4, 'echo-out': 2 },
      breakdown: { 'reverb-wash': 4, 'long-blend': 1 },
      outro: { 'long-blend': 4, 'reverb-wash': 1 },
      emergency: { 'echo-out': 2, 'reverb-wash': 2, cut: 0.2 },
    },
    transitionBeats: {
      'long-blend': [32, 64], 'bass-swap': [16, 16], 'filter-swap': [32, 32], 'echo-out': [8, 8], cut: [1, 1],
      'riser-drop': [8, 8], 'reverb-wash': [16, 32], 'loop-roll': [4, 4], brake: [4, 4],
    },
    typicalTransitionBeats: 32,
    fxDensity: 0.2,
    fxEveryPhrases: 8,
    fxWeights: { 'reverb-throw': 2, 'echo-throw': 1, 'filter-sweep': 1 },
    allowRiser: false,
    allowGate: false,
    riserOnlyOnGenreChangeOrPeak: true,
    playSeconds: playMap([150, 300], [150, 300]),
    bridgePlayFactor: 0.7,
    playFullChance: 0.2,
    bpmRange: [100, 120],
    bpmRampMinutes: 180,
    energyCurve: [[0, 0.3], [90, 0.45], [180, 0.55]],
    genreDwellMinutes: 12,
    maxDirectJumpCost: 0,
    rateRelaxBeats: 64,
    maxIntensity: 0.45,
    followPartyTempo: true,
    reEditChance: 0.2,
    reEditMaxDelta: 0.08,
    reEditCooldownTracks: 6,
    buildPushChance: 0,
  },
  'peak-time': {
    id: 'peak-time',
    label: 'Peak time',
    description: 'Énergie maximale : riser-drop, loop-roll, low-cut, plus d’effets.',
    techniqueWeights: {
      'same-genre': { 'bass-swap': 3, 'long-blend': 2, 'filter-swap': 2, 'riser-drop': 2, 'loop-roll': 1 },
      'genre-change': { 'riser-drop': 3, 'loop-roll': 2, 'echo-out': 2, 'filter-swap': 1 },
      'tempo-jump': { 'loop-roll': 3, 'riser-drop': 2, 'echo-out': 2 },
      breakdown: { 'riser-drop': 2, 'reverb-wash': 2, 'bass-swap': 1 },
      outro: { 'bass-swap': 3, 'long-blend': 1 },
      emergency: { 'echo-out': 2, cut: 1 },
    },
    transitionBeats: {
      'long-blend': [16, 32], 'bass-swap': [8, 16], 'filter-swap': [16, 16], 'echo-out': [4, 8], cut: [1, 1],
      'riser-drop': [8, 16], 'reverb-wash': [8, 8], 'loop-roll': [4, 8], brake: [2, 2],
    },
    typicalTransitionBeats: 16,
    fxDensity: 0.7,
    fxEveryPhrases: 2,
    fxWeights: { 'low-cut': 2, gate: 2, 'filter-sweep': 2, 'echo-throw': 1, riser: 1 },
    allowRiser: true,
    allowGate: true,
    riserOnlyOnGenreChangeOrPeak: false,
    playSeconds: playMap([120, 240], [60, 120]),
    bridgePlayFactor: 0.7,
    playFullChance: 0,
    bpmRange: [126, 132],
    bpmRampMinutes: 120,
    energyCurve: [[0, 0.8], [60, 0.9], [180, 0.95]],
    genreDwellMinutes: 6,
    maxDirectJumpCost: 2.5,
    rateRelaxBeats: 32,
    maxIntensity: 1,
    followPartyTempo: true,
    reEditChance: 0.5,
    reEditMaxDelta: 0.3,
    reEditCooldownTracks: 3,
    buildPushChance: 0.5,
  },
};

export const DEFAULT_SETTINGS: DjSettings = {
  style: 'paris-tech-house',
  fxAmount: 0.5,
  minPlaySeconds: 30,
  maxPlaySeconds: 420,
  followCrowd: true,
  baseGenre: 'tech-house',
  allowReEdits: true,
};

/** Énergie cible de la courbe de soirée à `minutes` depuis le début. */
export function energyAt(profile: StyleProfile, minutes: number): number {
  const c = profile.energyCurve;
  if (minutes <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    if (minutes <= c[i][0]) {
      const [t0, e0] = c[i - 1];
      const [t1, e1] = c[i];
      return e0 + ((e1 - e0) * (minutes - t0)) / (t1 - t0);
    }
  }
  return c[c.length - 1][1];
}

/** BPM cible à `minutes` depuis le début (monte doucement). */
export function targetBpmAt(profile: StyleProfile, minutes: number): number {
  const [a, b] = profile.bpmRange;
  const k = Math.max(0, Math.min(1, minutes / profile.bpmRampMinutes));
  return a + (b - a) * k;
}
