import type { VercelRequest, VercelResponse } from '@vercel/node';
import { hostUpdateSettings } from '../_lib/party.js';
import { guard, jsonBody, partyOf, prelude, requireHost, sendError, sendResult } from '../_lib/http.js';

/** POST /api/host/settings (x-host-key) Partial<HostSettings> -> HostSettings.
 *  Un corps vide {} sert à vérifier la clé et lire les réglages. forcedGenre: null efface le genre forcé. */
const run = guard(async (req, res, store) => {
  if (!prelude(req, res, 'POST')) return;
  if (!(await requireHost(req, res, store))) return;
  const body = jsonBody(req) ?? (req.body == null || req.body === '' ? {} : null);
  if (!body) return sendError(res, 400, 'invalid', 'Corps JSON attendu.');
  sendResult(res, await hostUpdateSettings(store, partyOf(req), body));
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await run(req, res);
}
