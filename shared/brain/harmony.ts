/** Harmonie : roue de Camelot. */
import type { Camelot } from '../contracts';

function parse(c: Camelot): [number, 'A' | 'B'] {
  return [parseInt(c.slice(0, -1), 10), c.slice(-1) as 'A' | 'B'];
}

/** Distance sur la roue : écart de numéro (circulaire, 0..6) + 1 si on change de lettre (mineur/majeur). */
export function camelotDistance(a: Camelot, b: Camelot): number {
  const [na, la] = parse(a);
  const [nb, lb] = parse(b);
  const d = Math.abs(na - nb);
  return Math.min(d, 12 - d) + (la === lb ? 0 : 1);
}

/**
 * Compatibilité harmonique 0..1 du passage a -> b.
 *  même clé 1 ; ±1 même lettre 0.9 ; relatif (8A <-> 8B) 0.85 ; +2 (boost d'énergie) 0.7 ;
 *  -2 0.55 ; diagonale (±1 et changement de lettre) 0.45 ; inconnu 0.5 ; distance 3 0.3 ; au-delà 0.1.
 */
export function harmonicScore(a?: Camelot, b?: Camelot): number {
  if (!a || !b) return 0.5;
  if (a === b) return 1;
  const [na, la] = parse(a);
  const [nb, lb] = parse(b);
  const up = (nb - na + 12) % 12; // pas vers le haut sur la roue
  const circ = Math.min(up, 12 - up);
  if (la === lb) {
    if (circ === 1) return 0.9;
    if (up === 2) return 0.7;
    if (circ === 2) return 0.55;
  } else {
    if (circ === 0) return 0.85;
    if (circ === 1) return 0.45;
  }
  return camelotDistance(a, b) <= 3 ? 0.3 : 0.1;
}
