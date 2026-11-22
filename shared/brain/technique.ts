/** Choix de la technique de transition et de sa durée. */
import type { Genre, TransitionTechnique } from '../contracts';
import { isElectronic } from './genres';
import type { StyleProfile, TransitionSituation } from './profiles';

/** Techniques qui supposent deux pistes calées (tempo + phase). */
export const SYNC_TECHNIQUES: ReadonlySet<TransitionTechnique> = new Set(['long-blend', 'bass-swap', 'filter-swap']);
/** Techniques sûres quand la grille de temps n'est pas fiable : rien à caler. */
export const NO_GRID_TECHNIQUES: ReadonlySet<TransitionTechnique> = new Set(['echo-out', 'cut', 'reverb-wash']);

export function needsSync(t: TransitionTechnique): boolean {
  return SYNC_TECHNIQUES.has(t);
}

export interface TechniqueContext {
  profile: StyleProfile;
  situation: TransitionSituation;
  /** Tempo calable (écart <= limite et rate disponible, ou écart négligeable). */
  syncOk: boolean;
  /** Grille de temps du live fiable (beatConfidence suffisante). */
  beatReliable: boolean;
  outgoingGenre?: Genre;
  incomingGenre?: Genre;
  random: () => number;
}

export function techniqueWeights(c: TechniqueContext): Partial<Record<TransitionTechnique, number>> {
  const w: Partial<Record<TransitionTechnique, number>> = { ...c.profile.techniqueWeights[c.situation] };
  const both = isElectronic(c.outgoingGenre) && isElectronic(c.incomingGenre);
  const mul = (t: TransitionTechnique, k: number) => { if (w[t]) w[t] = w[t]! * k; };
  if (both) {
    mul('cut', 0.3);
  } else if (c.outgoingGenre || c.incomingGenre) {
    // Rap, pop, tubes : intros/outros peu mixables, on préfère les sorties franches.
    mul('long-blend', 0.3); mul('bass-swap', 0.6); mul('filter-swap', 0.6);
    mul('cut', 1.5); mul('echo-out', 1.3);
  }
  if (!c.beatReliable) {
    for (const t of Object.keys(w) as TransitionTechnique[]) if (!NO_GRID_TECHNIQUES.has(t)) delete w[t];
  } else if (!c.syncOk) {
    for (const t of SYNC_TECHNIQUES) delete w[t];
  }
  if (!c.profile.allowRiser) delete w['riser-drop'];
  if (!c.profile.allowGate) delete w['loop-roll'];
  return w;
}

export function weightedPick<T extends string>(w: Partial<Record<T, number>>, random: () => number): T | undefined {
  const entries = (Object.entries(w) as Array<[T, number]>).filter(([, v]) => v > 0);
  const total = entries.reduce((a, [, v]) => a + v, 0);
  if (total <= 0) return undefined;
  let r = random() * total;
  for (const [k, v] of entries) {
    r -= v;
    if (r <= 0) return k;
  }
  return entries[entries.length - 1][0];
}

/** Tirage pondéré d'une technique ; repli sûr : echo-out (aucun calage nécessaire). */
export function chooseTechnique(c: TechniqueContext): TransitionTechnique {
  return weightedPick(techniqueWeights(c), c.random) ?? 'echo-out';
}

/** Durée en temps : une puissance de 2 entre les bornes du profil. */
export function pickBeats(profile: StyleProfile, t: TransitionTechnique, random: () => number): number {
  const [lo, hi] = profile.transitionBeats[t];
  const opts: number[] = [];
  for (let b = lo; b <= hi; b *= 2) opts.push(b);
  if (opts.length === 0) opts.push(lo);
  return opts[Math.min(opts.length - 1, Math.floor(random() * opts.length))];
}
