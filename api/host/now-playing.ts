import type { VercelRequest, VercelResponse } from '@vercel/node';
import { hostSetNowPlaying } from '../_lib/party.js';
import { guard, jsonBody, partyOf, prelude, requireHost, sendError, sendResult } from '../_lib/http.js';

/** POST /api/host/now-playing (x-host-key) NowPlaying -> NowPlaying */
const run = guard(async (req, res, store) => {
  if (!prelude(req, res, 'POST')) return;
  if (!(await requireHost(req, res, store))) return;
  const body = jsonBody(req);
  if (!body) return sendError(res, 400, 'invalid', 'Corps JSON attendu.');
  const r = await hostSetNowPlaying(store, partyOf(req), body, Date.now());
  if (!r.ok) return sendResult(res, r);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, nowPlaying: r.value });
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await run(req, res);
}
