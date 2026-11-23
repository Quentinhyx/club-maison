import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getTrack } from '../shared/deezer/index.js';
import { addRequest, sanitizeTrack } from './_lib/party.js';
import { guard, jsonBody, limitIp, partyOf, prelude, sendError, sendResult } from './_lib/http.js';

/** POST /api/request { guestId, guestName?, track } -> GuestRequest */
const run = guard(async (req, res, store) => {
  if (!prelude(req, res, 'POST')) return;
  const body = jsonBody(req);
  if (!body) return sendError(res, 400, 'invalid', 'Corps JSON attendu.');
  const claimed = sanitizeTrack(body.track);
  if (!claimed) return sendError(res, 400, 'invalid', 'Morceau invalide.');
  if (!(await limitIp(req, res, store, 'request'))) return;
  // On ne fait jamais confiance aux métadonnées du client : seul le morceau relu chez Deezer est
  // enregistré (avec bpm et gain). Si Deezer ne répond pas, la demande est refusée.
  let track;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    track = await Promise.race([
      getTrack(claimed.id),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), 5000); }),
    ]);
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code === 800) return sendError(res, 404, 'invalid', 'Ce morceau est introuvable chez Deezer.');
    return sendError(res, 503, 'deezer-down', 'Deezer ne répond pas, réessaie dans un instant.');
  } finally {
    clearTimeout(timer);
  }
  if (track.id !== claimed.id || !track.title || !track.artist) {
    return sendError(res, 404, 'invalid', 'Ce morceau est introuvable chez Deezer.');
  }
  sendResult(res, await addRequest(store, partyOf(req),
    { guestId: body.guestId, guestName: body.guestName, track }, Date.now()));
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await run(req, res);
}
