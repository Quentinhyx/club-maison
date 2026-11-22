import type { VercelRequest, VercelResponse } from '@vercel/node';
import { searchTracks } from '../shared/deezer/index.js';
import { CACHE_TTL_SEC, cached, guard, prelude, queryString, sendError } from './_lib/http.js';

/** GET /api/search?q=... -> TrackRef[] */
const run = guard(async (req, res, store) => {
  if (!prelude(req, res, 'GET')) return;
  const q = (queryString(req, 'q') ?? '').replace(/\s+/g, ' ').trim();
  if (!q) return void res.status(200).json([]);
  if (q.length > 100) return sendError(res, 400, 'invalid', 'Recherche trop longue (100 caractères max).');
  const limitRaw = Number(queryString(req, 'limit') ?? 20);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.round(limitRaw))) : 20;
  try {
    const tracks = await cached(store, `cm:cache:search:${limit}:${q.toLowerCase()}`, CACHE_TTL_SEC,
      () => searchTracks(q, { limit }));
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=600');
    res.status(200).json(tracks);
  } catch (e) {
    console.error('search', e);
    sendError(res, 502, 'deezer', 'Deezer ne répond pas pour le moment. Réessaie dans un instant.');
  }
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await run(req, res);
}
