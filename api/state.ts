import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { PartyState } from '../shared/contracts.js';
import { getPartyState } from './_lib/party.js';
import { guard, isHost, partyOf, prelude } from './_lib/http.js';

/** Réponse de /api/state : PartyState + indicateur du stockage (champ en plus, facultatif). */
type StateResponse = PartyState & { storage: 'redis' | 'memory' };

/** Instantané par instance de la vue publique (2 s), pour épargner Redis quand 40 téléphones sondent. */
const SNAPSHOT_MS = 2000;
const snapshots = new Map<string, { t: number; body: StateResponse }>();

/** GET /api/state?party=... -> PartyState (identifiants invités masqués, sauf pour l'hôte). */
const run = guard(async (req, res, store) => {
  if (!prelude(req, res, 'GET')) return;
  const party = partyOf(req);
  res.setHeader('Vary', 'x-host-key');

  if (await isHost(req, store)) {
    const state = await getPartyState(store, party, Date.now(), { reveal: true });
    res.setHeader('Cache-Control', 'private, no-store');
    return void res.status(200).json({ ...state, storage: store.kind } satisfies StateResponse);
  }

  const now = Date.now();
  let snap = snapshots.get(party);
  if (!snap || now - snap.t > SNAPSHOT_MS) {
    const state = await getPartyState(store, party, now);
    snap = { t: now, body: { ...state, storage: store.kind } };
    snapshots.set(party, snap);
    if (snapshots.size > 200) snapshots.delete(snapshots.keys().next().value!);
  }
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=2, stale-while-revalidate=5');
  res.status(200).json(snap.body);
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await run(req, res);
}
