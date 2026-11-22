/**
 * Tempo de soirée et re-edits (mashup).
 *
 * - Tempo de soirée : un BPM cible (settings.targetBpm ou courbe du profil) vers lequel le cerveau
 *   amène doucement les morceaux électroniques par des rampes de 'rate' (limite RATE_LIMITS.normal).
 * - Re-edit : un morceau lent ou d'une autre époque (80s, funk, disco, pop, R&B...) joué dans une
 *   ambiance house, calé sur le tempo de la soirée jusqu'à RATE_LIMITS.reEdit, avec une boîte à
 *   rythmes (GroovePlan) en dessous qui masque l'accélération et fait le lien avec la house.
 */
import type { DeckCapabilities, DjSettings, Genre, GrooveStyle, TrackAnalysis } from '../contracts';
import { RATE_LIMITS } from '../contracts';
import type { StyleProfile } from './profiles';
import { tempoMatch } from './scoring';

/** Genres qu'on peut passer en re-edit sous un beat house. */
export const REEDIT_GENRES: ReadonlySet<Genre> = new Set<Genre>(['80s', '90s', '2000s', 'funk', 'disco', 'pop', 'rnb', 'rock']);

/** Tempo stable exigé pour un re-edit au-delà de RATE_LIMITS.normal. */
export const REEDIT_MIN_STABILITY = 0.8;

/** Style de boîte à rythmes selon le genre visé. */
export function grooveStyleFor(g?: Genre): GrooveStyle {
  switch (g) {
    case 'tech-house': case 'minimal': case 'uk-garage': return 'tech-house';
    case 'techno': case 'melodic': case 'drum-bass': return 'techno';
    case 'afro-house': case 'afro': case 'amapiano': case 'latino': case 'reggaeton': case 'dancehall': return 'afro-house';
    case 'disco': case 'nu-disco': case 'funk': case '80s': case '90s': case '2000s': case 'pop': case 'rnb': case 'rock': return 'disco';
    default: return 'house';
  }
}

/** Rate qui amène un morceau de `nativeBpm` vers `targetBpm` (demi/double tempo compris), borné à ±limit. */
export function partyRate(nativeBpm: number, targetBpm: number, limit: number): { rate: number; mult: number; pct: number } {
  const tm = tempoMatch(targetBpm, nativeBpm);
  return { rate: Math.max(1 - limit, Math.min(1 + limit, tm.rate)), mult: tm.mult, pct: tm.pct };
}

export interface ReEditCheck {
  ok: boolean;
  /** Rate à appliquer (tempo de sortie = bpm × mult × rate). */
  rate: number;
  mult: number;
  /** Écart relatif |rate - 1|. */
  pct: number;
  /** Écart maximal permis pour ce morceau (caps, profil, contrat). */
  limit: number;
  reason: string;
}

/**
 * Le morceau peut-il être joué à `targetBpm` en re-edit ?
 * Refus si : allowReEdits === false ; platine sans rate ; écart > min(caps.maxRateDelta, profil, RATE_LIMITS.reEdit) ;
 * tempoStability < 0.8 ; tempoStability inconnue et écart > RATE_LIMITS.normal.
 */
export function checkReEdit(analysis: Pick<TrackAnalysis, 'bpm' | 'tempoStability'>, targetBpm: number, caps: DeckCapabilities | undefined,
  settings: Pick<DjSettings, 'allowReEdits'>, profile: Pick<StyleProfile, 'reEditMaxDelta'>): ReEditCheck {
  const tm = tempoMatch(targetBpm, analysis.bpm);
  const limit = Math.min(caps?.maxRateDelta ?? 0, profile.reEditMaxDelta, RATE_LIMITS.reEdit);
  const base = { rate: tm.rate, mult: tm.mult, pct: tm.pct, limit };
  const no = (reason: string): ReEditCheck => ({ ok: false, ...base, reason });
  if (settings.allowReEdits === false) return no('re-edits désactivés');
  if (!caps?.canSetRate) return no('la platine ne sait pas changer de vitesse');
  if (tm.pct > limit + 1e-9) return no(`écart de ${(tm.pct * 100).toFixed(0)} % au-delà de la limite (${(limit * 100).toFixed(0)} %)`);
  const st = analysis.tempoStability;
  if (st !== undefined && st < REEDIT_MIN_STABILITY) return no(`tempo trop instable (${st.toFixed(2).replace('.', ',')})`);
  if (st === undefined && tm.pct > RATE_LIMITS.normal + 1e-9) return no('stabilité du tempo inconnue, pas au-delà de 8 %');
  return { ok: true, ...base, reason: 'ok' };
}
