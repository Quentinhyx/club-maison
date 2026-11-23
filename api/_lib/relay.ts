/**
 * Filtres purs du relais des extraits Deezer (api/dz-cdn.ts), testés dans store.test.ts.
 * Formats d'URL d'extraits rencontrés : https://cdns-preview-<x>.dzcdn.net/stream/c-…-<n>.mp3
 * et https://cdnt-preview.dzcdn.net/api/1/1/…/0/…mp3?hdnea=exp=…~acl=…~hmac=…
 */

/** Taille maximale relayée (un extrait de 30 s en MP3 128 kb/s fait ~500 Ko). */
export const RELAY_MAX_BYTES = 2 * 1024 * 1024;

const PREVIEW_HOST = /^(?:e-)?cdn[st]?-preview(?:-[a-z0-9]+)?\.dzcdn\.net$/i;

export function isPreviewHost(host: string): boolean {
  return PREVIEW_HOST.test(host);
}

/** URL cible ou null si l'hôte ou le chemin sont refusés. */
export function previewTarget(host: string, path: string, query: Record<string, string | string[] | undefined>): string | null {
  if (!isPreviewHost(host)) return null;
  const p = path.replace(/^\/+/, '');
  if (!p || p.length > 500 || p.includes('..') || !/^[A-Za-z0-9._~\/-]+$/.test(p)) return null;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (k === 'host' || k === 'path') continue;
    for (const x of ([] as string[]).concat(v ?? [])) qs.append(k, x);
  }
  const s = qs.toString();
  if (s.length > 2000) return null;
  return `https://${host.toLowerCase()}/${p}${s ? `?${s}` : ''}`;
}
