/**
 * Logique métier d'une soirée (party) : votes, énergie, demandes, réglages de l'hôte.
 * Pure vis-à-vis du réseau : tout passe par un Store et une horloge `now` passés en paramètre.
 */
import {
  DEFAULT_PARTY, GENRES,
  type CrowdState, type EnergyVote, type Genre, type GuestRequest, type HostSettings,
  type NowPlaying, type PartyState, type TrackRef,
} from '../../shared/contracts.js';
import type { Store } from './store.js';

// ---------------------------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------------------------

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
/** Demi-vie des votes de genre. */
export const GENRE_HALF_LIFE = 20 * MINUTE;
/** Demi-vie des votes d'énergie (plus réactive que les genres). */
export const ENERGY_HALF_LIFE = 10 * MINUTE;
/** Délai minimal entre deux votes d'énergie d'un même invité. */
export const ENERGY_COOLDOWN = 30_000;
/** Accumulateur d'énergie par invité plafonné : un invité seul ne fait pas la loi. */
const ENERGY_GUEST_CAP = 2;
/** Un morceau joué ne peut pas être redemandé pendant ce délai. */
export const REPLAY_WINDOW = 2 * HOUR;
/** Nettoyage des demandes. */
const DONE_RETENTION = 2 * HOUR;       // played / rejected
const PENDING_RETENTION = 4 * HOUR;
const ACCEPTED_RETENTION = 6 * HOUR;
/** Durée de vie des clés d'une soirée (rafraîchie à chaque écriture). */
const PARTY_TTL_SEC = 3 * 24 * 3600;
/** Un vote de genre dont le poids passe sous ce seuil est oublié. */
const MIN_WEIGHT = 0.01;

/* Garde-fous anti-abus. Attention : à une soirée, tous les invités en Wi-Fi partagent la même
 * IP publique (la box). Les limites par IP sont donc larges : elles arrêtent un script, pas une fête. */
/** Écritures (votes, énergie, demandes) par IP et par fenêtre. */
export const IP_WRITE_LIMIT = 300;
export const IP_WRITE_WINDOW_SEC = 10 * 60;
/** Demandes de morceaux par IP et par heure. */
export const IP_REQUEST_LIMIT = 40;
export const IP_REQUEST_WINDOW_SEC = 3600;
/** Plafond global de demandes en attente pour une soirée. */
export const MAX_PENDING_TOTAL = 50;
/** Demandes renvoyées par GET /api/state (public / hôte). */
export const PUBLIC_REQUESTS_MAX = 30;
export const HOST_REQUESTS_MAX = 100;
/** Anti-force-brute de la clé hôte : N échecs par IP dans la fenêtre -> blocage pour la fenêtre. */
export const HOST_FAIL_LIMIT = 5;
export const HOST_FAIL_WINDOW_SEC = 10 * 60;
/** Verrou court autour des « vérifier puis écrire ». */
const LOCK_TTL_SEC = 5;

export const DEFAULT_HOST: HostSettings = {
  blockedGenres: [],
  blockedTrackIds: [],
  votesOpen: true,
  requestsOpen: true,
  maxRequestsPerGuest: 3,
};

// ---------------------------------------------------------------------------------------------
// Résultats
// ---------------------------------------------------------------------------------------------

export type ErrorCode =
  | 'invalid' | 'votes-closed' | 'requests-closed' | 'genre-blocked' | 'track-blocked'
  | 'energy-too-soon' | 'too-many-requests' | 'already-requested' | 'recently-played'
  | 'not-found' | 'host-key-missing' | 'host-key-invalid'
  | 'queue-full' | 'rate-limited' | 'busy' | 'host-locked' | 'deezer-down';

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: ErrorCode; message: string; retryAfter?: number };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (status: number, code: ErrorCode, message: string, retryAfter?: number): Result<never> =>
  ({ ok: false, status, code, message, ...(retryAfter !== undefined ? { retryAfter } : {}) });

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

export function normalizeParty(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(s) ? s : DEFAULT_PARTY;
}

export function isGenre(v: unknown): v is Genre {
  return typeof v === 'string' && (GENRES as readonly string[]).includes(v);
}

export function parseGuestId(v: unknown): string | null {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(v) ? v : null;
}

export function parseGuestName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
  return s || undefined;
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s ? s.slice(0, max) : undefined;
}

function num(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

function deezerUrl(v: unknown): string | undefined {
  const s = str(v, 500);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:') return undefined;
    const h = u.hostname;
    return h.endsWith('.dzcdn.net') || h.endsWith('.deezer.com') || h === 'deezer.com' ? s : undefined;
  } catch { return undefined; }
}

/** Nettoie un TrackRef venu du client. Renvoie null si inexploitable. */
export function sanitizeTrack(v: unknown): TrackRef | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const id = typeof o.id === 'number' && Number.isInteger(o.id) && o.id > 0 && o.id < 1e12 ? o.id : 0;
  const title = str(o.title, 200);
  const artist = str(o.artist, 200);
  if (!id || !title || !artist) return null;
  const t: TrackRef = { id, title, artist, duration: Math.round(num(o.duration, 0, 7200) ?? 0) };
  const album = str(o.album, 200); if (album) t.album = album;
  const cover = deezerUrl(o.cover); if (cover) t.cover = cover;
  const preview = deezerUrl(o.preview); if (preview) t.preview = preview;
  const bpm = num(o.bpm, 1, 300); if (bpm) t.bpm = bpm;
  const gain = num(o.gain, -100, 100); if (gain !== undefined) t.gain = gain;
  const rank = num(o.rank, 0, 1e9); if (rank) t.rank = rank;
  const year = num(o.releaseYear, 1900, 2100); if (year) t.releaseYear = Math.round(year);
  if (Array.isArray(o.genres)) {
    const g = o.genres.filter(isGenre).slice(0, 5);
    if (g.length) t.genres = g;
  }
  return t;
}

/** Valide un Partial<HostSettings>. `forcedGenre: null` ou '' efface le genre forcé. */
export function parseSettingsPatch(v: unknown): Result<Partial<HostSettings> & { clearForced?: boolean }> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return fail(400, 'invalid', 'Réglages invalides.');
  const o = v as Record<string, unknown>;
  const p: Partial<HostSettings> & { clearForced?: boolean } = {};
  if ('blockedGenres' in o) {
    if (!Array.isArray(o.blockedGenres)) return fail(400, 'invalid', 'blockedGenres doit être une liste.');
    p.blockedGenres = [...new Set(o.blockedGenres.filter(isGenre))];
  }
  if ('blockedTrackIds' in o) {
    if (!Array.isArray(o.blockedTrackIds)) return fail(400, 'invalid', 'blockedTrackIds doit être une liste.');
    p.blockedTrackIds = [...new Set(o.blockedTrackIds.filter(
      (n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0,
    ))].slice(-1000);
  }
  if ('forcedGenre' in o) {
    if (o.forcedGenre === null || o.forcedGenre === '' || o.forcedGenre === undefined) p.clearForced = true;
    else if (isGenre(o.forcedGenre)) p.forcedGenre = o.forcedGenre;
    else return fail(400, 'invalid', 'Genre forcé inconnu.');
  }
  for (const k of ['votesOpen', 'requestsOpen'] as const) {
    if (k in o) {
      if (typeof o[k] !== 'boolean') return fail(400, 'invalid', `${k} doit être vrai ou faux.`);
      p[k] = o[k] as boolean;
    }
  }
  // « Suivant » depuis le téléphone : la valeur envoyée est ignorée, l'heure du serveur fait foi.
  if ('skipAt' in o || o.skip === true) p.skipAt = Date.now();
  if ('maxRequestsPerGuest' in o) {
    const n = o.maxRequestsPerGuest;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 20) {
      return fail(400, 'invalid', 'maxRequestsPerGuest doit être un entier entre 0 et 20.');
    }
    p.maxRequestsPerGuest = n;
  }
  return ok(p);
}

// ---------------------------------------------------------------------------------------------
// Authentification hôte
// ---------------------------------------------------------------------------------------------

function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export function checkHostKey(provided: unknown, expected: string | undefined): Result<true> {
  if (!expected) {
    return fail(503, 'host-key-missing',
      "La clé hôte n'est pas configurée sur le serveur : ajoute la variable d'environnement HOST_KEY dans Vercel puis redéploie.");
  }
  const p = Array.isArray(provided) ? provided[0] : provided;
  if (typeof p !== 'string' || !p || !safeEqual(p, expected)) {
    return fail(401, 'host-key-invalid', 'Clé hôte incorrecte.');
  }
  return ok(true);
}

/** IP du client (Vercel pose x-real-ip et x-forwarded-for). Inconnue -> 'unknown'. */
export function clientIp(headers: Record<string, string | string[] | undefined>): string {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim();
  const ip = first(headers['x-real-ip']) || first(headers['x-forwarded-for']) || '';
  return /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? ip.toLowerCase() : 'unknown';
}

/** Compteur par IP en fenêtre fixe (INCR + EXPIRE). */
export async function rateLimit(
  store: Store, bucket: string, ip: string, limit: number, windowSec: number,
): Promise<Result<true>> {
  const n = await store.incr(`cm:rl:${bucket}:${ip}`, windowSec);
  if (n > limit) {
    const msg = bucket === 'request'
      ? 'Beaucoup de demandes depuis ce réseau. Laisse passer un peu de musique et réessaie.'
      : 'Ça vote beaucoup depuis ce réseau. Souffle un peu et réessaie dans quelques minutes.';
    return fail(429, 'rate-limited', msg, windowSec);
  }
  return ok(true);
}

/**
 * Vérifie la clé hôte avec anti-force-brute : après HOST_FAIL_LIMIT échecs en HOST_FAIL_WINDOW_SEC
 * pour une IP, toute tentative (même juste) est refusée en 429 jusqu'à la fin de la fenêtre.
 */
export async function hostAccess(
  store: Store, ip: string, provided: unknown, expected: string | undefined,
): Promise<Result<true>> {
  if (!expected) return checkHostKey(provided, expected);
  const key = `cm:hostfail:${ip}`;
  const fails = Number(await store.get(key)) || 0;
  if (fails >= HOST_FAIL_LIMIT) {
    return fail(429, 'host-locked', 'Trop de clés incorrectes. Réessaie dans 10 minutes.', HOST_FAIL_WINDOW_SEC);
  }
  const r = checkHostKey(provided, expected);
  if (!r.ok && r.status === 401) await store.incr(key, HOST_FAIL_WINDOW_SEC);
  return r;
}

async function withLock<T>(store: Store, name: string, fn: () => Promise<Result<T>>, busy: Result<T>): Promise<Result<T>> {
  const key = `cm:lock:${name}`;
  if (!(await store.setNX(key, '1', LOCK_TTL_SEC))) return busy;
  try { return await fn(); } finally { await store.del(key).catch(() => undefined); }
}

// ---------------------------------------------------------------------------------------------
// Stockage d'une soirée
// ---------------------------------------------------------------------------------------------

interface GenreVoteRec { genre: Genre; t: number }
interface EnergyRec { s: number; t: number; last: number }
type RequestRec = GuestRequest & { updatedAt: number };

const k = (party: string) => ({
  genre: `cm:${party}:genre`,       // hash guestId -> GenreVoteRec
  energy: `cm:${party}:energy`,     // hash guestId -> EnergyRec
  req: `cm:${party}:req`,           // hash requestId -> RequestRec
  played: `cm:${party}:played`,     // hash trackId -> timestamp
  host: `cm:${party}:host`,         // HostSettings
  now: `cm:${party}:now`,           // NowPlaying
});

function parse<T>(s: string | null | undefined): T | undefined {
  if (!s) return undefined;
  try { return JSON.parse(s) as T; } catch { return undefined; }
}

const decay = (age: number, halfLife: number) => Math.pow(0.5, Math.max(0, age) / halfLife);

async function touch(store: Store, key: string) {
  await store.expire(key, PARTY_TTL_SEC);
}

export async function getHost(store: Store, party: string): Promise<HostSettings> {
  const h = parse<Partial<HostSettings>>(await store.get(k(party).host));
  return { ...DEFAULT_HOST, ...(h ?? {}) };
}

export async function getNowPlaying(store: Store, party: string, now: number): Promise<NowPlaying> {
  return parse<NowPlaying>(await store.get(k(party).now)) ?? { updatedAt: now };
}

async function loadRequests(store: Store, party: string, now: number): Promise<RequestRec[]> {
  return parseRequests(store, party, await store.hgetall(k(party).req), now);
}

async function parseRequests(store: Store, party: string, all: Record<string, string>, now: number): Promise<RequestRec[]> {
  const out: RequestRec[] = [];
  const stale: string[] = [];
  for (const [id, raw] of Object.entries(all)) {
    const r = parse<RequestRec>(raw);
    if (!r) { stale.push(id); continue; }
    const age = now - (r.updatedAt ?? r.createdAt);
    const expired =
      ((r.status === 'played' || r.status === 'rejected') && age > DONE_RETENTION) ||
      (r.status === 'pending' && age > PENDING_RETENTION) ||
      (r.status === 'accepted' && age > ACCEPTED_RETENTION);
    if (expired) stale.push(id); else out.push(r);
  }
  if (stale.length) await store.hdel(k(party).req, ...stale);
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

async function loadPlayed(store: Store, party: string, now: number): Promise<Map<number, number>> {
  const all = await store.hgetall(k(party).played);
  const out = new Map<number, number>();
  const stale: string[] = [];
  for (const [id, raw] of Object.entries(all)) {
    const t = Number(raw);
    if (!Number.isFinite(t) || now - t > REPLAY_WINDOW) stale.push(id);
    else out.set(Number(id), t);
  }
  if (stale.length) await store.hdel(k(party).played, ...stale);
  return out;
}

/** Empreinte non réversible d'un guestId (les invités ne voient pas les identifiants des autres). */
export function maskGuestId(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return 'g' + (h >>> 0).toString(36);
}

/** Au plus `max` demandes : en attente d'abord (plus anciennes en tête), puis acceptées,
 *  puis les plus récentes jouées / refusées (pour que les invités voient le sort des leurs). */
export function limitRequests<T extends GuestRequest>(list: T[], max: number): T[] {
  const by = (st: GuestRequest['status']) => list.filter((r) => r.status === st);
  const done = list.filter((r) => r.status === 'played' || r.status === 'rejected')
    .sort((a, b) => b.createdAt - a.createdAt);
  return [...by('pending'), ...by('accepted'), ...done].slice(0, max);
}

function publicRequest(r: RequestRec, reveal: boolean): GuestRequest {
  const { updatedAt: _u, ...rest } = r;
  return reveal ? rest : { ...rest, guestId: maskGuestId(r.guestId) };
}

interface PartyRaw { host: string | null; now: string | null; genre: Record<string, string>; energy: Record<string, string>; req: Record<string, string> }

/** Toutes les lectures d'une soirée en un seul aller-retour. */
async function readParty(store: Store, party: string): Promise<PartyRaw> {
  const keys = k(party);
  const r = await store.readMany([keys.host, keys.now], [keys.genre, keys.energy, keys.req]);
  return { host: r.strings[0], now: r.strings[1], genre: r.hashes[0], energy: r.hashes[1], req: r.hashes[2] };
}

export async function getCrowd(
  store: Store, party: string, now: number, opts: { reveal?: boolean } = {},
): Promise<CrowdState> {
  return crowdFrom(store, party, await readParty(store, party), now, opts);
}

async function crowdFrom(
  store: Store, party: string, raw: PartyRaw, now: number, opts: { reveal?: boolean },
): Promise<CrowdState> {
  const host: HostSettings = { ...DEFAULT_HOST, ...(parse<Partial<HostSettings>>(raw.host) ?? {}) };
  const genreAll = raw.genre;
  const energyAll = raw.energy;
  const requests = await parseRequests(store, party, raw.req, now);

  const genreWeights: Partial<Record<Genre, number>> = {};
  let lastUpdate = 0;
  for (const raw of Object.values(genreAll)) {
    const v = parse<GenreVoteRec>(raw);
    if (!v || !isGenre(v.genre) || host.blockedGenres.includes(v.genre)) continue;
    const w = decay(now - v.t, GENRE_HALF_LIFE);
    if (w < MIN_WEIGHT) continue;
    genreWeights[v.genre] = (genreWeights[v.genre] ?? 0) + w;
    lastUpdate = Math.max(lastUpdate, v.t);
  }
  for (const g of Object.keys(genreWeights) as Genre[]) {
    genreWeights[g] = Math.round(genreWeights[g]! * 1000) / 1000;
  }

  let total = 0;
  let abs = 0;
  for (const raw of Object.values(energyAll)) {
    const e = parse<EnergyRec>(raw);
    if (!e) continue;
    const s = e.s * decay(now - e.t, ENERGY_HALF_LIFE);
    total += s;
    abs += Math.abs(s);
    lastUpdate = Math.max(lastUpdate, e.t);
  }
  const energy = Math.max(-1, Math.min(1, total / Math.max(3, abs)));
  for (const r of requests) lastUpdate = Math.max(lastUpdate, r.updatedAt ?? r.createdAt);

  return {
    genreWeights,
    energy: Math.round(energy * 1000) / 1000,
    requests: limitRequests(requests, opts.reveal ? HOST_REQUESTS_MAX : PUBLIC_REQUESTS_MAX)
      .map((r) => publicRequest(r, !!opts.reveal)),
    host,
    updatedAt: lastUpdate || now,
  };
}

export async function getPartyState(
  store: Store, party: string, now: number, opts: { reveal?: boolean } = {},
): Promise<PartyState> {
  const raw = await readParty(store, party);
  const crowd = await crowdFrom(store, party, raw, now, opts);
  const nowPlaying = parse<NowPlaying>(raw.now) ?? { updatedAt: now };
  return { crowd, nowPlaying };
}

// ---------------------------------------------------------------------------------------------
// Actions invités
// ---------------------------------------------------------------------------------------------

export async function voteGenre(
  store: Store, party: string, input: { guestId: unknown; genre: unknown }, now: number,
): Promise<Result<CrowdState>> {
  const guestId = parseGuestId(input.guestId);
  if (!guestId) return fail(400, 'invalid', 'Identifiant invité manquant.');
  if (!isGenre(input.genre)) return fail(400, 'invalid', 'Genre inconnu.');
  const host = await getHost(store, party);
  if (!host.votesOpen) return fail(403, 'votes-closed', "Les votes sont fermés pour l'instant.");
  if (host.blockedGenres.includes(input.genre)) return fail(403, 'genre-blocked', "Ce style n'est pas au programme ce soir.");

  const key = k(party).genre;
  await store.hset(key, guestId, JSON.stringify({ genre: input.genre, t: now } satisfies GenreVoteRec));
  await touch(store, key);

  // Ménage occasionnel des votes oubliés.
  if (Math.random() < 0.1) {
    const all = await store.hgetall(key);
    const stale = Object.entries(all)
      .filter(([, raw]) => { const v = parse<GenreVoteRec>(raw); return !v || decay(now - v.t, GENRE_HALF_LIFE) < MIN_WEIGHT; })
      .map(([id]) => id);
    if (stale.length) await store.hdel(key, ...stale);
  }
  return ok(await getCrowd(store, party, now));
}

export async function voteEnergy(
  store: Store, party: string, input: { guestId: unknown; vote: unknown }, now: number,
): Promise<Result<CrowdState>> {
  const guestId = parseGuestId(input.guestId);
  if (!guestId) return fail(400, 'invalid', 'Identifiant invité manquant.');
  if (input.vote !== 1 && input.vote !== -1) return fail(400, 'invalid', 'Le vote doit valoir 1 ou -1.');
  const vote = input.vote as EnergyVote;
  const host = await getHost(store, party);
  if (!host.votesOpen) return fail(403, 'votes-closed', "Les votes sont fermés pour l'instant.");

  const key = k(party).energy;
  // Verrou par invité : deux appuis simultanés ne passent pas tous les deux le délai de 30 s.
  const written = await withLock<true>(store, `${party}:energy:${guestId}`, async () => {
    const prev = parse<EnergyRec>(await store.hget(key, guestId));
    if (prev && now - prev.last < ENERGY_COOLDOWN) {
      const wait = Math.ceil((ENERGY_COOLDOWN - (now - prev.last)) / 1000);
      return fail(429, 'energy-too-soon', `Doucement : tu pourras revoter dans ${wait} s.`, wait);
    }
    const carried = prev ? prev.s * decay(now - prev.t, ENERGY_HALF_LIFE) : 0;
    const s = Math.max(-ENERGY_GUEST_CAP, Math.min(ENERGY_GUEST_CAP, carried + vote));
    await store.hset(key, guestId, JSON.stringify({ s, t: now, last: now } satisfies EnergyRec));
    await touch(store, key);
    return ok(true);
  }, fail(429, 'energy-too-soon', 'Doucement : ton vote est déjà en route.', 2));
  if (!written.ok) return written;

  // Ménage occasionnel des votes d'énergie éteints.
  if (Math.random() < 0.1) await purgeEnergy(store, party, now);
  return ok(await getCrowd(store, party, now));
}

/** Supprime les votes d'énergie dont le poids est devenu négligeable. */
export async function purgeEnergy(store: Store, party: string, now: number): Promise<number> {
  const key = k(party).energy;
  const all = await store.hgetall(key);
  const stale = Object.entries(all)
    .filter(([, raw]) => {
      const e = parse<EnergyRec>(raw);
      return !e || (now - e.last > ENERGY_COOLDOWN && Math.abs(e.s * decay(now - e.t, ENERGY_HALF_LIFE)) < MIN_WEIGHT);
    })
    .map(([id]) => id);
  if (stale.length) await store.hdel(key, ...stale);
  return stale.length;
}

export async function addRequest(
  store: Store, party: string,
  input: { guestId: unknown; guestName?: unknown; track: unknown },
  now: number,
  newId: () => string = randomId,
): Promise<Result<GuestRequest>> {
  const guestId = parseGuestId(input.guestId);
  if (!guestId) return fail(400, 'invalid', 'Identifiant invité manquant.');
  const track = sanitizeTrack(input.track);
  if (!track) return fail(400, 'invalid', 'Morceau invalide.');
  const host = await getHost(store, party);
  if (!host.requestsOpen || host.maxRequestsPerGuest <= 0) {
    return fail(403, 'requests-closed', "Les demandes sont fermées pour l'instant.");
  }
  if (host.blockedTrackIds.includes(track.id)) {
    return fail(403, 'track-blocked', "Ce morceau n'est pas au programme ce soir.");
  }
  // Verrous courts : même morceau demandé en même temps par deux invités, ou même invité qui
  // envoie deux demandes d'un coup (sinon les vérifications ci-dessous laissent passer les deux).
  return withLock(store, `${party}:track:${track.id}`, () =>
    withLock(store, `${party}:guest:${guestId}`, () => insertRequest(store, party, guestId, track, input.guestName, host, now, newId),
      fail(429, 'busy', 'Une demande est déjà en route, une seconde.')),
  fail(409, 'already-requested', 'Quelqu’un demande ce son au même moment, il est dans la file.'));
}

async function insertRequest(
  store: Store, party: string, guestId: string, track: TrackRef, guestNameRaw: unknown,
  host: HostSettings, now: number, newId: () => string,
): Promise<Result<GuestRequest>> {
  const [requests, played, np] = await Promise.all([
    loadRequests(store, party, now),
    loadPlayed(store, party, now),
    getNowPlaying(store, party, now),
  ]);
  if (requests.some((r) => r.track.id === track.id && (r.status === 'pending' || r.status === 'accepted'))) {
    return fail(409, 'already-requested', 'Quelqu’un a déjà demandé ce son, il est dans la file.');
  }
  if (played.has(track.id) || np.current?.id === track.id) {
    return fail(409, 'recently-played', 'Ce son vient de passer. Laisse-lui un peu de temps.');
  }
  if (np.next?.id === track.id) {
    return fail(409, 'already-requested', 'Ce son arrive juste après, tends l’oreille.');
  }
  if (requests.filter((r) => r.status === 'pending').length >= MAX_PENDING_TOTAL) {
    return fail(429, 'queue-full', 'File pleine : le DJ a déjà de quoi faire. Réessaie un peu plus tard.');
  }
  const mine = requests.filter((r) => r.guestId === guestId && r.status === 'pending').length;
  if (mine >= host.maxRequestsPerGuest) {
    return fail(429, 'too-many-requests',
      `Tu as déjà ${mine} demande${mine > 1 ? 's' : ''} en attente. Attends qu’une passe avant d’en proposer une autre.`);
  }
  const rec: RequestRec = {
    id: newId(),
    guestId,
    track,
    createdAt: now,
    updatedAt: now,
    status: 'pending',
  };
  const name = parseGuestName(guestNameRaw);
  if (name) rec.guestName = name;
  const key = k(party).req;
  if (!(await store.hsetnx(key, rec.id, JSON.stringify(rec)))) {
    return fail(429, 'busy', 'Petit accroc, renvoie ta demande.');
  }
  await touch(store, key);
  return ok(publicRequest(rec, true));
}

export function randomId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '').slice(0, 16);
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ---------------------------------------------------------------------------------------------
// Actions hôte
// ---------------------------------------------------------------------------------------------

export async function hostSetRequestStatus(
  store: Store, party: string, input: { id: unknown; status: unknown }, now: number,
): Promise<Result<GuestRequest>> {
  if (typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.id)) return fail(400, 'invalid', 'Identifiant de demande invalide.');
  const status = input.status;
  if (status !== 'pending' && status !== 'accepted' && status !== 'played' && status !== 'rejected') {
    return fail(400, 'invalid', 'Statut invalide.');
  }
  const key = k(party).req;
  const rec = parse<RequestRec>(await store.hget(key, input.id));
  if (!rec) return fail(404, 'not-found', 'Demande introuvable.');
  rec.status = status;
  rec.updatedAt = now;
  await store.hset(key, rec.id, JSON.stringify(rec));
  await touch(store, key);
  if (status === 'played') {
    await store.hset(k(party).played, String(rec.track.id), String(now));
    await touch(store, k(party).played);
  }
  return ok(publicRequest(rec, true));
}

export async function hostUpdateSettings(
  store: Store, party: string, patch: unknown,
): Promise<Result<HostSettings>> {
  const parsed = parseSettingsPatch(patch);
  if (!parsed.ok) return parsed;
  const { clearForced, ...p } = parsed.value;
  const next: HostSettings = { ...(await getHost(store, party)), ...p };
  if (clearForced) delete next.forcedGenre;
  if (next.forcedGenre && next.blockedGenres.includes(next.forcedGenre)) {
    next.blockedGenres = next.blockedGenres.filter((g) => g !== next.forcedGenre);
  }
  await store.set(k(party).host, JSON.stringify(next), PARTY_TTL_SEC);
  return ok(next);
}

export async function hostSetNowPlaying(
  store: Store, party: string, body: unknown, now: number,
): Promise<Result<NowPlaying>> {
  if (!body || typeof body !== 'object') return fail(400, 'invalid', 'Corps invalide.');
  const o = body as Record<string, unknown>;
  const np: NowPlaying = { updatedAt: now };
  if (o.current != null) {
    const t = sanitizeTrack(o.current);
    if (!t) return fail(400, 'invalid', 'Morceau en cours invalide.');
    np.current = t;
  }
  if (o.next != null) {
    const t = sanitizeTrack(o.next);
    if (!t) return fail(400, 'invalid', 'Morceau suivant invalide.');
    np.next = t;
  }
  if (o.genre != null) {
    if (!isGenre(o.genre)) return fail(400, 'invalid', 'Genre inconnu.');
    np.genre = o.genre;
  }
  const keys = k(party);
  const prev = await getNowPlaying(store, party, now);
  await store.set(keys.now, JSON.stringify(np), PARTY_TTL_SEC);

  if (np.current && np.current.id !== prev.current?.id) {
    await store.hset(keys.played, String(np.current.id), String(now));
    await touch(store, keys.played);
    // Les demandes de ce morceau passent en « joué ».
    const requests = await loadRequests(store, party, now);
    for (const r of requests) {
      if (r.track.id === np.current.id && (r.status === 'pending' || r.status === 'accepted')) {
        r.status = 'played';
        r.updatedAt = now;
        await store.hset(keys.req, r.id, JSON.stringify(r));
      }
    }
  }
  return ok(np);
}
