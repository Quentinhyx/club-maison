import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getTrack } from '../shared/deezer/index.js';
import { addRequest, sanitizeTrack } from './_lib/party.js';
import { guard, jsonBody, partyOf, prelude, sendError, sendResult } from './_lib/http.js';

/** POST /api/request { guestId, guestName?, track } -> GuestRequest */
const run = guard(async (req, res, store) => {
  if (!prelude(req, res, 'POST')) return;
  const body = jsonBody(req);
  if (!body) return sendError(res, 400, 'invalid', 'Corps JSON attendu.');
  const claimed = sanitizeTrack(body.track);
  if (!claimed) return sendError(res, 400, 'invalid', 'Morceau invalide.');
  // On ne fait pas confiance aux métadonnées du client : on relit le morceau chez Deezer
  // (récupère aussi bpm et gain). Si Deezer ne répond pas, on garde la version nettoyée.
  let track = claimed;
  try {
    const fresh = await Promise.race([
      getTrack(claimed.id),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
    ]);
    if (fresh.id === claimed.id && fresh.title) track = fresh;
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code === 800) return sendError(res, 404, 'invalid', 'Ce morceau est introuvable chez Deezer.');
  }
  sendResult(res, await addRequest(store, partyOf(req),
    { guestId: body.guestId, guestName: body.guestName, track }, Date.now()));
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await run(req, res);
}
