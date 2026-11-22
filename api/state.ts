import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPartyState } from './_lib/party.js';
import { guard, isHost, partyOf, prelude } from './_lib/http.js';

/** GET /api/state?party=... -> PartyState (identifiants invités masqués, sauf pour l'hôte). */
const run = guard(async (req, res, store) => {
  if (!prelude(req, res, 'GET')) return;
  const state = await getPartyState(store, partyOf(req), Date.now(), { reveal: isHost(req) });
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(state);
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await run(req, res);
}
