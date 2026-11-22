import type { VercelRequest, VercelResponse } from '@vercel/node';
import { voteEnergy } from './_lib/party.js';
import { guard, jsonBody, partyOf, prelude, sendError, sendResult } from './_lib/http.js';

/** POST /api/energy { guestId, vote: 1 | -1 } -> CrowdState */
const run = guard(async (req, res, store) => {
  if (!prelude(req, res, 'POST')) return;
  const body = jsonBody(req);
  if (!body) return sendError(res, 400, 'invalid', 'Corps JSON attendu.');
  sendResult(res, await voteEnergy(store, partyOf(req), { guestId: body.guestId, vote: body.vote }, Date.now()));
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await run(req, res);
}
