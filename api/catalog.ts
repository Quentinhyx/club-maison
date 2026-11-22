import type { VercelRequest, VercelResponse } from '@vercel/node';
import { catalogForGenre } from '../shared/deezer/index.js';
import { isGenre } from './_lib/party.js';
import { CACHE_TTL_SEC, cached, guard, prelude, queryString, sendError } from './_lib/http.js';

function bpmParam(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 40 && n <= 220 ? Math.round(n) : undefined;
}

/** GET /api/catalog?genre=...&bpmMin&bpmMax&limit -> TrackRef[] */
const run = guard(async (req, res, store) => {
  if (!prelude(req, res, 'GET')) return;
  const genre = queryString(req, 'genre');
  if (!isGenre(genre)) return sendError(res, 400, 'invalid', 'Paramètre genre manquant ou inconnu.');
  const bpmMin = bpmParam(queryString(req, 'bpmMin'));
  const bpmMax = bpmParam(queryString(req, 'bpmMax'));
  const limitRaw = Number(queryString(req, 'limit') ?? 60);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(150, Math.round(limitRaw))) : 60;
  try {
    const tracks = await cached(store, `cm:cache:catalog:${genre}:${bpmMin ?? ''}:${bpmMax ?? ''}:${limit}`,
      CACHE_TTL_SEC, () => catalogForGenre(genre, { bpmMin, bpmMax, limit }));
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=600');
    res.status(200).json(tracks);
  } catch (e) {
    console.error('catalog', e);
    sendError(res, 502, 'deezer', 'Deezer ne répond pas pour le moment.');
  }
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await run(req, res);
}
