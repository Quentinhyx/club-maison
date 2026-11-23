/**
 * Affectation des onglets Deezer aux platines (fonction pure, testée dans conductor.test.ts) :
 *  - choix manuel de l'hôte d'abord ;
 *  - sinon A = onglet de fenêtre NORMALE uniquement, B = onglet de fenêtre PRIVÉE uniquement
 *    (deux comptes différents : un onglet normal ne devient jamais B tout seul, et inversement).
 * Un onglet en cours de rechargement (port déconnecté depuis moins de 8 s) garde sa platine.
 */
import type { DeckId } from '../../../shared/contracts';
import type { Assignment } from './protocol';

export interface AssignTab {
  tabId: number;
  incognito: boolean;
  /** Date.now() de la déconnexion du port (rechargement), absent si connecté. */
  goneAt?: number;
}

export const RELOAD_GRACE_MS = 8000;

export function computeAssignment(tabs: AssignTab[], manual: Assignment, previous: Assignment, nowMs: number): Assignment {
  const alive = (t: AssignTab) => t.goneAt === undefined || nowMs - t.goneAt < RELOAD_GRACE_MS;
  const usable = tabs.filter(alive);
  const byId = new Map(usable.map((t) => [t.tabId, t]));
  const next: Assignment = {};
  for (const d of ['A', 'B'] as DeckId[]) {
    const m = manual[d];
    if (m !== undefined && byId.has(m)) next[d] = m;
  }
  const wantIncognito: Record<DeckId, boolean> = { A: false, B: true };
  for (const d of ['A', 'B'] as DeckId[]) {
    if (next[d] !== undefined) continue;
    const used = new Set(Object.values(next));
    // garder l'onglet déjà affecté (même pendant son rechargement), puis le premier du bon type
    const prev = previous[d];
    const p = prev !== undefined ? byId.get(prev) : undefined;
    if (p && p.incognito === wantIncognito[d] && !used.has(p.tabId)) {
      next[d] = p.tabId;
      continue;
    }
    const t = usable.find((x) => x.incognito === wantIncognito[d] && !used.has(x.tabId) && x.goneAt === undefined);
    if (t) next[d] = t.tabId;
  }
  return next;
}
