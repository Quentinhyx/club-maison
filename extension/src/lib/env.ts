/**
 * Détection de l'environnement : la même console tourne
 *   - dans l'extension Chrome (chrome-extension://…/console.html) : Deezer, capture d'onglet, stockage chrome ;
 *   - en localhost (npm run dev:console) : mode démo, réseau Deezer via le proxy du serveur Vite.
 */
import type { TrackRef } from '../../../shared/contracts';

export const isExtension: boolean =
  typeof chrome !== 'undefined' && !!(chrome as any)?.runtime?.id && location.protocol === 'chrome-extension:';

/** Réécrit les URL Deezer pour passer par le proxy local (CORS) quand on n'est pas dans l'extension. */
export function rewriteUrl(url: string): string {
  if (isExtension) return url;
  try {
    const u = new URL(url);
    if (u.hostname === 'api.deezer.com') return `/dz-api${u.pathname}${u.search}`;
    if (u.hostname.endsWith('.dzcdn.net')) return `/dz-cdn/${u.hostname}${u.pathname}${u.search}`;
  } catch {
    /* URL relative : inchangée */
  }
  return url;
}

/** fetch à passer aux fonctions de shared/deezer et shared/analysis. */
export const envFetch: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return fetch(rewriteUrl(url), init);
}) as typeof fetch;

/** Copie du morceau dont l'URL d'extrait passe par le proxy local si besoin. */
export function envTrack(t: TrackRef): TrackRef {
  if (!t.preview || isExtension) return t;
  return { ...t, preview: rewriteUrl(t.preview) };
}

export function urlParam(name: string): string | null {
  try {
    return new URLSearchParams(location.search).get(name);
  } catch {
    return null;
  }
}
