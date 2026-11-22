/**
 * Calage tempo / phase des platines (PUR).
 */

/** Ramène une valeur dans [-0.5, 0.5[ (modulo 1). */
export function wrapHalf(x: number): number {
  return x - Math.floor(x + 0.5);
}

/** Horizon de correction : l'erreur de phase est rattrapée en ~8 temps (doux, inaudible). */
export const PHASE_HORIZON_BEATS = 8;
/** Zone morte : en dessous de ~1 % de temps (≈ 5 ms à 128 BPM) on ne touche à rien. */
export const PHASE_DEADBAND_BEATS = 0.01;

/**
 * Calcule le playbackRate à appliquer à la platine entrante pour réaligner sa phase.
 *
 * - `currentRate` doit être le rate de BASE (calage du tempo, ex. tempoMatchRate), pas le rate
 *   déjà corrigé par un appel précédent : la correction est alors purement proportionnelle
 *   (système du 1er ordre), elle converge sans osciller même si on l'appelle 10 fois par seconde.
 * - errorBeats > 0 : la platine est en retard sur la référence (son premier temps tombe après)
 *   -> rate > currentRate. Erreur ramenée dans [-0.5, 0.5] (modulo un temps).
 * - La correction |rate - currentRate| est bornée par maxDelta.
 * - Si la mesure de phase de la platine est vieille (> 16 temps avant nowCtx), on corrige deux
 *   fois moins fort (elle a pu dériver avec la correction déjà appliquée).
 */
export function phaseNudge(a: {
  bpm: number;
  refDownbeatCtx: number;
  deckDownbeatCtx: number;
  nowCtx: number;
  maxDelta: number;
  currentRate: number;
}): { rate: number; errorBeats: number } {
  const base = Number.isFinite(a.currentRate) && a.currentRate > 0 ? a.currentRate : 1;
  if (!(a.bpm > 0) || !Number.isFinite(a.refDownbeatCtx) || !Number.isFinite(a.deckDownbeatCtx)) {
    return { rate: base, errorBeats: 0 };
  }
  const beat = 60 / a.bpm;
  const errorBeats = wrapHalf((a.deckDownbeatCtx - a.refDownbeatCtx) / beat);
  if (Math.abs(errorBeats) < PHASE_DEADBAND_BEATS) return { rate: base, errorBeats };
  const stale = Number.isFinite(a.nowCtx) && a.nowCtx - a.deckDownbeatCtx > 16 * beat ? 0.5 : 1;
  const maxDelta = Math.max(0, Number.isFinite(a.maxDelta) ? a.maxDelta : 0);
  // rattraper errorBeats en PHASE_HORIZON_BEATS temps : delta relatif = erreur / horizon
  let delta = (errorBeats / PHASE_HORIZON_BEATS) * stale * base;
  delta = Math.max(-maxDelta, Math.min(maxDelta, delta));
  return { rate: base + delta, errorBeats };
}

/**
 * Rate à appliquer à un morceau joué à `fromBpm` pour qu'il sonne à `toBpm`. Essaie aussi le
 * demi / double tempo (64 -> 128 donne 1). Renvoie null si l'écart dépasse maxDelta.
 */
export function tempoMatchRate(fromBpm: number, toBpm: number, maxDelta: number): number | null {
  if (!(fromBpm > 0) || !(toBpm > 0)) return null;
  const candidates = [toBpm / fromBpm, (toBpm / 2) / fromBpm, (toBpm * 2) / fromBpm];
  let best: number | null = null;
  for (const r of candidates) {
    if (Math.abs(r - 1) <= maxDelta + 1e-12 && (best === null || Math.abs(r - 1) < Math.abs(best - 1))) best = r;
  }
  return best;
}

/**
 * Rampe de vitesse par paliers, pour une platine dont le playbackRate n'est pas un AudioParam
 * (élément média) : le chef d'orchestre applique chaque palier à son instant `t` (ctx).
 * Courbe en S (départ et arrivée en douceur). Le premier point est `from` à startCtx, le dernier
 * `to` à startCtx + overBeats temps. Par défaut, 2 paliers par temps (au moins 1, au plus 128).
 */
export function rateRamp(
  from: number, to: number, startCtx: number, overBeats: number, bpm: number, steps?: number,
): Array<{ t: number; rate: number }> {
  const dur = overBeats > 0 && bpm > 0 ? overBeats * (60 / bpm) : 0;
  if (!(dur > 0) || from === to) return [{ t: startCtx, rate: to }];
  const n = Math.max(1, Math.min(128, Math.round(steps ?? Math.ceil(overBeats * 2))));
  const out: Array<{ t: number; rate: number }> = [];
  for (let i = 0; i <= n; i++) {
    const x = i / n;
    out.push({ t: startCtx + dur * x, rate: from + (to - from) * (0.5 - 0.5 * Math.cos(Math.PI * x)) });
  }
  return out;
}
