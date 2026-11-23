import type { VercelRequest, VercelResponse } from '@vercel/node';
import { voteGenre } from './_lib/party.js';
import { guard, jsonBody, limitIp, partyOf, prelude, sendError, sendResult } from './_lib/http.js';

/** POST /api/vote { guestId, genre } -> CrowdState */
const run = guard(async (req, res, store) => {
  if (!prelude(req, res, 'POST')) return;
  const body = jsonBody(req);
  if (!body) return sendError(res, 400, 'invalid', 'Corps JSON attendu.');
  if (!(await limitIp(req, res, store, 'write'))) return;
  sendResult(res, await voteGenre(store, partyOf(req), { guestId: body.guestId, genre: body.genre }, Date.now()));
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await run(req, res);
}
