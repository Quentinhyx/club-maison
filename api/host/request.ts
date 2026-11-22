import type { VercelRequest, VercelResponse } from '@vercel/node';
import { hostSetRequestStatus } from '../_lib/party.js';
import { guard, jsonBody, partyOf, prelude, requireHost, sendError, sendResult } from '../_lib/http.js';

/** POST /api/host/request (x-host-key) { id, status } -> GuestRequest */
const run = guard(async (req, res, store) => {
  if (!prelude(req, res, 'POST')) return;
  if (!requireHost(req, res)) return;
  const body = jsonBody(req);
  if (!body) return sendError(res, 400, 'invalid', 'Corps JSON attendu.');
  sendResult(res, await hostSetRequestStatus(store, partyOf(req), { id: body.id, status: body.status }, Date.now()));
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await run(req, res);
}
