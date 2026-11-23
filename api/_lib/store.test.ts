/**
 * Tests de la logique de soirée (party.ts) avec le store mémoire.
 * Lancer : npx tsx api/_lib/store.test.ts   (code de sortie non nul en cas d'échec)
 */
import assert from 'node:assert/strict';
import { MemoryStore } from './store.js';
import {
  addRequest, checkHostKey, ENERGY_COOLDOWN, GENRE_HALF_LIFE, getCrowd, getPartyState, HOUR,
  hostSetNowPlaying, hostSetRequestStatus, hostUpdateSettings, maskGuestId, MINUTE, normalizeParty,
  sanitizeTrack, voteEnergy, voteGenre,
  clientIp, hostAccess, HOST_FAIL_LIMIT, IP_REQUEST_LIMIT, IP_WRITE_LIMIT, limitRequests, MAX_PENDING_TOTAL,
  PUBLIC_REQUESTS_MAX, purgeEnergy, rateLimit,
} from './party.js';
import { isPreviewHost, previewTarget } from './relay.js';
import { catalogForGenre, getTrack, searchTracks, similarTracks, toTrackRef } from '../../shared/deezer/index.js';
import type { GuestRequest, TrackRef } from '../../shared/contracts.js';

let failures = 0;
let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures++;
    console.error(`  ECHEC  ${name}\n        ${(e as Error).stack?.split('\n').slice(0, 3).join('\n        ')}`);
  }
}

const P = 'test';
const G1 = 'guest-aaaaaa';
const G2 = 'guest-bbbbbb';
const G3 = 'guest-cccccc';
const T0 = 1_700_000_000_000;
const track = (id: number, extra: Partial<TrackRef> = {}): TrackRef =>
  ({ id, title: `Titre ${id}`, artist: `Artiste ${id}`, duration: 200, ...extra });

function fresh() {
  const s = new MemoryStore();
  s.now = () => T0;
  let n = 0;
  const ids = () => `req${++n}`;
  return { s, ids };
}

const near = (a: number | undefined, b: number, eps = 1e-3) =>
  assert.ok(a !== undefined && Math.abs(a - b) < eps, `attendu ${b}, obtenu ${a}`);

console.log('party.ts');

await test('normalizeParty : défaut maison, minuscules, refuse les caractères bizarres', () => {
  assert.equal(normalizeParty(undefined), 'maison');
  assert.equal(normalizeParty('Salon-2'), 'salon-2');
  assert.equal(normalizeParty('../etc'), 'maison');
  assert.equal(normalizeParty('a'.repeat(40)), 'maison');
});

await test('vote de genre : amortissement demi-vie 20 min', async () => {
  const { s } = fresh();
  const r = await voteGenre(s, P, { guestId: G1, genre: 'house' }, T0);
  assert.ok(r.ok);
  near(r.value.genreWeights.house, 1);
  near((await getCrowd(s, P, T0 + GENRE_HALF_LIFE)).genreWeights.house, 0.5);
  near((await getCrowd(s, P, T0 + 2 * GENRE_HALF_LIFE)).genreWeights.house, 0.25);
  // Au bout de ~2 h 15 le vote est oublié.
  assert.equal((await getCrowd(s, P, T0 + 3 * HOUR)).genreWeights.house, undefined);
});

await test('vote de genre : un vote par invité, le nouveau remplace l’ancien', async () => {
  const { s } = fresh();
  await voteGenre(s, P, { guestId: G1, genre: 'house' }, T0);
  await voteGenre(s, P, { guestId: G2, genre: 'house' }, T0);
  const r = await voteGenre(s, P, { guestId: G1, genre: 'techno' }, T0 + 10 * MINUTE);
  assert.ok(r.ok);
  near(r.value.genreWeights.techno, 1);
  near(r.value.genreWeights.house, Math.pow(0.5, 0.5)); // seul G2 reste, vieux de 10 min
});

await test('vote de genre : entrées invalides refusées', async () => {
  const { s } = fresh();
  const a = await voteGenre(s, P, { guestId: 'x', genre: 'house' }, T0);
  assert.ok(!a.ok && a.status === 400);
  const b = await voteGenre(s, P, { guestId: G1, genre: 'polka' }, T0);
  assert.ok(!b.ok && b.status === 400);
});

await test('genre bloqué : vote refusé et poids masqué', async () => {
  const { s } = fresh();
  await voteGenre(s, P, { guestId: G1, genre: 'rock' }, T0);
  await hostUpdateSettings(s, P, { blockedGenres: ['rock'] });
  const r = await voteGenre(s, P, { guestId: G2, genre: 'rock' }, T0);
  assert.ok(!r.ok && r.code === 'genre-blocked' && r.status === 403);
  assert.equal((await getCrowd(s, P, T0)).genreWeights.rock, undefined);
});

await test('votes fermés : genre et énergie refusés', async () => {
  const { s } = fresh();
  await hostUpdateSettings(s, P, { votesOpen: false });
  const a = await voteGenre(s, P, { guestId: G1, genre: 'house' }, T0);
  const b = await voteEnergy(s, P, { guestId: G1, vote: 1 }, T0);
  assert.ok(!a.ok && a.code === 'votes-closed');
  assert.ok(!b.ok && b.code === 'votes-closed');
});

await test('énergie : 1 vote toutes les 30 s par invité, valeur dans -1..1', async () => {
  const { s } = fresh();
  const a = await voteEnergy(s, P, { guestId: G1, vote: 1 }, T0);
  assert.ok(a.ok);
  near(a.value.energy, 1 / 3);
  const b = await voteEnergy(s, P, { guestId: G1, vote: 1 }, T0 + 10_000);
  assert.ok(!b.ok && b.code === 'energy-too-soon' && b.status === 429 && b.retryAfter === 20);
  const c = await voteEnergy(s, P, { guestId: G1, vote: 1 }, T0 + ENERGY_COOLDOWN);
  assert.ok(c.ok);
  // Un invité seul plafonne à 2 / 3 même s'il insiste.
  let t = T0 + ENERGY_COOLDOWN;
  for (let i = 0; i < 10; i++) { t += ENERGY_COOLDOWN; await voteEnergy(s, P, { guestId: G1, vote: 1 }, t); }
  const e = (await getCrowd(s, P, t)).energy;
  assert.ok(e <= 2 / 3 + 1e-3 && e > 0.5, `énergie ${e}`);
  // Les autres font redescendre.
  await voteEnergy(s, P, { guestId: G2, vote: -1 }, t);
  await voteEnergy(s, P, { guestId: G3, vote: -1 }, t);
  const e2 = (await getCrowd(s, P, t)).energy;
  assert.ok(e2 < e && e2 >= -1 && e2 <= 1, `énergie ${e2}`);
  const bad = await voteEnergy(s, P, { guestId: G2, vote: 3 }, t + HOUR);
  assert.ok(!bad.ok && bad.status === 400);
});

await test('énergie : amortie dans le temps', async () => {
  const { s } = fresh();
  for (const g of [G1, G2, G3]) await voteEnergy(s, P, { guestId: g, vote: 1 }, T0);
  near((await getCrowd(s, P, T0)).energy, 1);
  // Le rapport reste à 1 (même signe), mais la somme absolue passe sous 3 : la valeur baisse.
  const later = (await getCrowd(s, P, T0 + HOUR)).energy;
  assert.ok(later < 0.2, `énergie ${later}`);
});

await test('demandes : limite par invité (3 en attente par défaut)', async () => {
  const { s, ids } = fresh();
  for (let i = 1; i <= 3; i++) {
    const r = await addRequest(s, P, { guestId: G1, guestName: ' Léa ', track: track(i) }, T0 + i, ids);
    assert.ok(r.ok);
    assert.equal(r.value.guestName, 'Léa');
    assert.equal(r.value.status, 'pending');
  }
  const r4 = await addRequest(s, P, { guestId: G1, track: track(4) }, T0 + 10, ids);
  assert.ok(!r4.ok && r4.code === 'too-many-requests' && r4.status === 429);
  // Un autre invité peut demander.
  assert.ok((await addRequest(s, P, { guestId: G2, track: track(4) }, T0 + 11, ids)).ok);
  // Quand une demande passe (acceptée), G1 retrouve une place.
  assert.ok((await hostSetRequestStatus(s, P, { id: 'req1', status: 'accepted' }, T0 + 20)).ok);
  assert.ok((await addRequest(s, P, { guestId: G1, track: track(5) }, T0 + 21, ids)).ok);
  // Limite réglée par l'hôte.
  await hostUpdateSettings(s, P, { maxRequestsPerGuest: 1 });
  const r6 = await addRequest(s, P, { guestId: G2, track: track(6) }, T0 + 30, ids);
  assert.ok(!r6.ok && r6.code === 'too-many-requests');
});

await test('demandes : pas de doublon (en attente, acceptée, en cours, jouée < 2 h)', async () => {
  const { s, ids } = fresh();
  assert.ok((await addRequest(s, P, { guestId: G1, track: track(10) }, T0, ids)).ok);
  const dup = await addRequest(s, P, { guestId: G2, track: track(10) }, T0 + 1, ids);
  assert.ok(!dup.ok && dup.code === 'already-requested' && dup.status === 409);

  await hostSetNowPlaying(s, P, { current: track(20), next: track(21) }, T0);
  const cur = await addRequest(s, P, { guestId: G2, track: track(20) }, T0 + 1, ids);
  assert.ok(!cur.ok && cur.code === 'recently-played');
  const nxt = await addRequest(s, P, { guestId: G2, track: track(21) }, T0 + 1, ids);
  assert.ok(!nxt.ok && nxt.code === 'already-requested');

  // Le morceau 20 n'est plus en cours mais a été joué il y a moins de 2 h.
  await hostSetNowPlaying(s, P, { current: track(22) }, T0 + 5 * MINUTE);
  const played = await addRequest(s, P, { guestId: G2, track: track(20) }, T0 + HOUR, ids);
  assert.ok(!played.ok && played.code === 'recently-played');
  // Au-delà de 2 h, c'est de nouveau possible.
  assert.ok((await addRequest(s, P, { guestId: G2, track: track(20) }, T0 + 2 * HOUR + MINUTE, ids)).ok);
});

await test('now-playing : la demande correspondante passe en « joué »', async () => {
  const { s, ids } = fresh();
  const r = await addRequest(s, P, { guestId: G1, track: track(30) }, T0, ids);
  assert.ok(r.ok);
  await hostSetRequestStatus(s, P, { id: r.value.id, status: 'accepted' }, T0 + 1);
  await hostSetNowPlaying(s, P, { current: track(30), genre: 'house' }, T0 + 2);
  const st = await getPartyState(s, P, T0 + 3);
  assert.equal(st.crowd.requests[0].status, 'played');
  assert.equal(st.nowPlaying.current?.id, 30);
  assert.equal(st.nowPlaying.genre, 'house');
  const bad = await hostSetNowPlaying(s, P, { genre: 'polka' }, T0);
  assert.ok(!bad.ok && bad.status === 400);
});

await test('morceau bloqué et demandes fermées', async () => {
  const { s, ids } = fresh();
  await hostUpdateSettings(s, P, { blockedTrackIds: [40] });
  const a = await addRequest(s, P, { guestId: G1, track: track(40) }, T0, ids);
  assert.ok(!a.ok && a.code === 'track-blocked' && a.status === 403);
  await hostUpdateSettings(s, P, { requestsOpen: false });
  const b = await addRequest(s, P, { guestId: G1, track: track(41) }, T0, ids);
  assert.ok(!b.ok && b.code === 'requests-closed');
  await hostUpdateSettings(s, P, { requestsOpen: true, maxRequestsPerGuest: 0 });
  const c = await addRequest(s, P, { guestId: G1, track: track(41) }, T0, ids);
  assert.ok(!c.ok && c.code === 'requests-closed');
});

await test('nettoyage des vieilles demandes', async () => {
  const { s, ids } = fresh();
  await addRequest(s, P, { guestId: G1, track: track(50) }, T0, ids);           // req1 en attente
  await addRequest(s, P, { guestId: G1, track: track(51) }, T0, ids);           // req2 refusée
  await hostSetRequestStatus(s, P, { id: 'req2', status: 'rejected' }, T0);
  assert.equal((await getCrowd(s, P, T0 + HOUR)).requests.length, 2);
  const c = await getCrowd(s, P, T0 + 2 * HOUR + MINUTE);
  assert.deepEqual(c.requests.map((r) => r.id), ['req1']);
  assert.equal((await getCrowd(s, P, T0 + 5 * HOUR)).requests.length, 0);
  assert.equal(Object.keys(await s.hgetall(`cm:${P}:req`)).length, 0);
});

await test('statut de demande : validation et 404', async () => {
  const { s } = fresh();
  const a = await hostSetRequestStatus(s, P, { id: 'nope', status: 'accepted' }, T0);
  assert.ok(!a.ok && a.status === 404);
  const b = await hostSetRequestStatus(s, P, { id: 'req1', status: 'gagné' }, T0);
  assert.ok(!b.ok && b.status === 400);
});

await test('réglages hôte : validation, genre forcé, effacement', async () => {
  const { s } = fresh();
  const a = await hostUpdateSettings(s, P, { forcedGenre: 'disco', blockedGenres: ['disco', 'rock', 'polka'] });
  assert.ok(a.ok);
  assert.equal(a.value.forcedGenre, 'disco');
  assert.deepEqual(a.value.blockedGenres, ['rock']); // le genre forcé ne peut pas être bloqué
  const b = await hostUpdateSettings(s, P, { forcedGenre: null });
  assert.ok(b.ok && b.value.forcedGenre === undefined && b.value.blockedGenres[0] === 'rock');
  assert.ok(!(await hostUpdateSettings(s, P, { maxRequestsPerGuest: 99 })).ok);
  assert.ok(!(await hostUpdateSettings(s, P, { votesOpen: 'oui' })).ok);
  assert.ok(!(await hostUpdateSettings(s, P, { forcedGenre: 'polka' })).ok);
  assert.ok(!(await hostUpdateSettings(s, P, [])).ok);
  const c = await hostUpdateSettings(s, P, {});
  assert.ok(c.ok && c.value.maxRequestsPerGuest === 3 && c.value.votesOpen);
});

await test('auth hôte : 503 sans HOST_KEY, 401 si mauvaise clé, ok sinon', () => {
  const a = checkHostKey('abc', undefined);
  assert.ok(!a.ok && a.status === 503 && /HOST_KEY/.test(a.message));
  const b = checkHostKey(undefined, 'secret');
  assert.ok(!b.ok && b.status === 401);
  const c = checkHostKey('secreT', 'secret');
  assert.ok(!c.ok && c.status === 401);
  const d = checkHostKey('secre', 'secret');
  assert.ok(!d.ok);
  assert.ok(checkHostKey('secret', 'secret').ok);
  assert.ok(checkHostKey(['secret'], 'secret').ok);
});

await test('état public : guestId masqué, hôte voit le vrai', async () => {
  const { s, ids } = fresh();
  await addRequest(s, P, { guestId: G1, track: track(60) }, T0, ids);
  const pub = await getCrowd(s, P, T0);
  assert.equal(pub.requests[0].guestId, maskGuestId(G1));
  assert.notEqual(pub.requests[0].guestId, G1);
  const host = await getCrowd(s, P, T0, { reveal: true });
  assert.equal(host.requests[0].guestId, G1);
});

await test('sanitizeTrack : rejette les URL étrangères et les champs absurdes', () => {
  const t = sanitizeTrack({
    id: 3, title: ' Ok ', artist: 'A', duration: 999999, cover: 'https://evil.example/x.png',
    preview: 'https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/0/x.mp3', bpm: 124, genres: ['house', 'polka'],
  });
  assert.ok(t);
  assert.equal(t.title, 'Ok');
  assert.equal(t.duration, 0);
  assert.equal(t.cover, undefined);
  assert.ok(t.preview?.includes('dzcdn.net'));
  assert.deepEqual(t.genres, ['house']);
  assert.equal(sanitizeTrack({ id: -1, title: 'x', artist: 'y' }), null);
  assert.equal(sanitizeTrack({ id: 1, title: '', artist: 'y' }), null);
});

await test('MemoryStore : expiration et setNX', async () => {
  const s = new MemoryStore();
  let now = 0;
  s.now = () => now;
  await s.set('a', '1', 10);
  assert.equal(await s.get('a'), '1');
  assert.equal(await s.setNX('a', '2', 10), false);
  now = 11_000;
  assert.equal(await s.get('a'), null);
  assert.equal(await s.setNX('a', '2', 10), true);
  await s.hset('h', 'x', '1');
  await s.expire('h', 1);
  now += 2000;
  assert.deepEqual(await s.hgetall('h'), {});
});

// ---------------------------------------------------------------------------------------------
console.log('shared/deezer (fetch simulé)');

const RAW = (id: number, extra: object = {}) => ({
  id, readable: true, title: `T${id}`, title_short: `T${id}`, duration: 240, rank: 500000 + id,
  preview: `https://cdnt-preview.dzcdn.net/${id}.mp3`, artist: { name: `A${id}` },
  album: { title: `Al${id}`, cover_medium: `https://e-cdns-images.dzcdn.net/${id}.jpg` }, type: 'track', ...extra,
});

function mockFetch(routes: (url: string) => unknown): { f: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const body = routes(url);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}

await test('toTrackRef : mappe bpm, gain, année', () => {
  const t = toTrackRef({ ...RAW(1), bpm: 124.02, gain: -9.5, release_date: '2021-06-04' });
  assert.equal(t.title, 'T1');
  assert.equal(t.artist, 'A1');
  assert.equal(t.album, 'Al1');
  assert.equal(t.bpm, 124.02);
  assert.equal(t.gain, -9.5);
  assert.equal(t.releaseYear, 2021);
  assert.equal(toTrackRef({ ...RAW(2), bpm: 0 }).bpm, undefined);
});

await test('searchTracks / getTrack : erreurs Deezer et quota', async () => {
  let n = 0;
  const { f, calls } = mockFetch((url) => {
    if (url.includes('/track/')) return { error: { type: 'DataException', message: 'no data', code: 800 } };
    if (n++ === 0) return { error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } };
    return { data: [RAW(1), RAW(2, { readable: false })] };
  });
  const r = await searchTracks('daft punk', { fetcher: f });
  assert.equal(r.length, 1);
  assert.equal(calls.length, 2); // nouvel essai après le quota
  await assert.rejects(getTrack(5, f), (e: { code?: number }) => e.code === 800);
});

await test('catalogForGenre : playlists + artistes, dédoublonné, durées filtrées', async () => {
  const { f, calls } = mockFetch((url) => {
    if (url.includes('/search/playlist')) return { data: [{ id: 77, nb_tracks: 50, fans: 10 }, { id: 78, nb_tracks: 3 }] };
    if (url.includes('/playlist/77/tracks')) return { data: [RAW(1), RAW(2), RAW(3, { duration: 30 }), RAW(4, { duration: 900 })] };
    if (url.includes('bpm_min')) return { data: [RAW(5, { bpm: 126 }), RAW(6, { bpm: 90 })] };
    return { data: [RAW(1), RAW(7)] };
  });
  const r = await catalogForGenre('tech-house', { bpmMin: 122, bpmMax: 128, limit: 50, fetcher: f });
  const ids = r.map((t) => t.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [1, 2, 5, 7]);
  assert.ok(r.every((t) => t.genres?.[0] === 'tech-house'));
  assert.ok(!calls.some((u) => u.includes('/playlist/78/')));
  assert.ok(calls.some((u) => u.includes('artist%3A')));
});


await test('similarTracks : radio + artistes proches, sans le morceau lui-même, genre conservé', async () => {
  const { f, calls } = mockFetch((url) => {
    if (url.includes('/artist/10/radio')) return { data: [RAW(1, { artist: { id: 10, name: 'A' } }), RAW(2), RAW(3, { duration: 30 })] };
    if (url.includes('/artist/10/related')) return { data: [{ id: 20 }, { id: 21 }] };
    if (url.includes('/artist/20/top')) return { data: [RAW(4), RAW(2)] };
    if (url.includes('/artist/21/top')) return { data: [RAW(5)] };
    return { data: [] };
  });
  const seed: TrackRef = { id: 1, title: 'T1', artist: 'A', artistId: 10, duration: 200, genres: ['house'] };
  const r = await similarTracks(seed, { fetcher: f });
  assert.deepEqual(r.map((t) => t.id).sort((a, b) => a - b), [2, 4, 5]);
  assert.ok(r.every((t) => t.genres?.[0] === 'house'));
  assert.ok(!calls.some((u) => u.includes('/search/artist')));
  assert.equal(toTrackRef(RAW(9, { artist: { id: 42, name: 'X' } })).artistId, 42);
});

await test('« Suivant » depuis le téléphone : skipAt posé à l’heure du serveur', async () => {
  const s = new MemoryStore();
  const before = Date.now();
  const r = await hostUpdateSettings(s, P, { skipAt: 1 });
  assert.ok(r.ok);
  if (r.ok) assert.ok((r.value.skipAt ?? 0) >= before);
});


console.log('garde-fous anti-abus');

await test('limite par IP : écritures et demandes, fenêtre fixe, IP séparées', async () => {
  const s = new MemoryStore();
  let now = T0;
  s.now = () => now;
  for (let i = 0; i < IP_WRITE_LIMIT; i++) assert.ok((await rateLimit(s, 'write', '1.2.3.4', IP_WRITE_LIMIT, 600)).ok);
  const over = await rateLimit(s, 'write', '1.2.3.4', IP_WRITE_LIMIT, 600);
  assert.ok(!over.ok && over.status === 429 && over.code === 'rate-limited' && over.retryAfter === 600);
  assert.ok((await rateLimit(s, 'write', '5.6.7.8', IP_WRITE_LIMIT, 600)).ok, 'autre IP non touchée');
  now += 601_000;
  assert.ok((await rateLimit(s, 'write', '1.2.3.4', IP_WRITE_LIMIT, 600)).ok, 'fenêtre suivante');
  for (let i = 0; i < IP_REQUEST_LIMIT; i++) assert.ok((await rateLimit(s, 'request', '9.9.9.9', IP_REQUEST_LIMIT, 3600)).ok);
  const r = await rateLimit(s, 'request', '9.9.9.9', IP_REQUEST_LIMIT, 3600);
  assert.ok(!r.ok && /demandes/.test(r.message));
});

await test('clientIp : x-real-ip puis x-forwarded-for, valeurs bizarres ignorées', () => {
  assert.equal(clientIp({ 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9' }), '1.2.3.4');
  assert.equal(clientIp({ 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }), '9.9.9.9');
  assert.equal(clientIp({ 'x-forwarded-for': '2001:DB8::1' }), '2001:db8::1');
  assert.equal(clientIp({ 'x-real-ip': '<script>' }), 'unknown');
  assert.equal(clientIp({}), 'unknown');
});

await test('plafond global : 50 demandes en attente, puis « File pleine »', async () => {
  const { s, ids } = fresh();
  await hostUpdateSettings(s, P, { maxRequestsPerGuest: 20 });
  for (let i = 0; i < MAX_PENDING_TOTAL; i++) {
    const r = await addRequest(s, P, { guestId: `guest-${String(i % 5).padStart(6, '0')}`, track: track(1000 + i) }, T0 + i, ids);
    assert.ok(r.ok, `demande ${i}`);
  }
  const full = await addRequest(s, P, { guestId: 'guest-zzzzzz', track: track(5000) }, T0 + 100, ids);
  assert.ok(!full.ok && full.code === 'queue-full' && /File pleine/.test(full.message));
  // Une demande acceptée libère une place.
  await hostSetRequestStatus(s, P, { id: 'req1', status: 'accepted' }, T0 + 101);
  assert.ok((await addRequest(s, P, { guestId: 'guest-zzzzzz', track: track(5000) }, T0 + 102, ids)).ok);
});

await test('état public : 30 demandes max, en attente puis acceptées puis récentes', async () => {
  const mk = (i: number, status: GuestRequest['status']): GuestRequest =>
    ({ id: `r${i}`, guestId: 'g', track: track(i), createdAt: T0 + i, status });
  const list = [
    ...Array.from({ length: 10 }, (_, i) => mk(i, 'played')),
    ...Array.from({ length: 25 }, (_, i) => mk(100 + i, 'pending')),
    ...Array.from({ length: 10 }, (_, i) => mk(200 + i, 'accepted')),
  ];
  const out = limitRequests(list, PUBLIC_REQUESTS_MAX);
  assert.equal(out.length, 30);
  assert.equal(out.filter((r) => r.status === 'pending').length, 25);
  assert.equal(out.filter((r) => r.status === 'accepted').length, 5);
  assert.equal(out[0].id, 'r100');
  assert.deepEqual(limitRequests([mk(1, 'played'), mk(2, 'rejected'), mk(3, 'pending')], 30).map((r) => r.id), ['r3', 'r2', 'r1']);

  const { s, ids } = fresh();
  await hostUpdateSettings(s, P, { maxRequestsPerGuest: 20 });
  for (let i = 0; i < 40; i++) await addRequest(s, P, { guestId: `guest-${String(i % 4).padStart(6, '0')}`, track: track(300 + i) }, T0 + i, ids);
  assert.equal((await getPartyState(s, P, T0 + 100)).crowd.requests.length, 30);
  assert.equal((await getPartyState(s, P, T0 + 100, { reveal: true })).crowd.requests.length, 40);
});

await test('anti-force-brute : 5 échecs -> 429 pendant 10 min, même avec la bonne clé', async () => {
  const s = new MemoryStore();
  let now = T0;
  s.now = () => now;
  const ip = '7.7.7.7';
  for (let i = 0; i < HOST_FAIL_LIMIT; i++) {
    const r = await hostAccess(s, ip, 'faux', 'secret');
    assert.ok(!r.ok && r.status === 401);
  }
  const locked = await hostAccess(s, ip, 'secret', 'secret');
  assert.ok(!locked.ok && locked.status === 429 && locked.code === 'host-locked');
  assert.ok((await hostAccess(s, '8.8.8.8', 'secret', 'secret')).ok, 'autre IP non bloquée');
  now += 10 * MINUTE + 1000;
  assert.ok((await hostAccess(s, ip, 'secret', 'secret')).ok, 'débloqué après 10 min');
  // Sans HOST_KEY : 503, rien n'est compté.
  const m = await hostAccess(s, ip, 'x', undefined);
  assert.ok(!m.ok && m.status === 503);
  assert.equal(await s.get(`cm:hostfail:${ip}`), null);
});

await test('écritures concurrentes : même morceau ou même invité en parallèle, un seul passe', async () => {
  const { s, ids } = fresh();
  const same = await Promise.all([
    addRequest(s, P, { guestId: G1, track: track(700) }, T0, ids),
    addRequest(s, P, { guestId: G2, track: track(700) }, T0, ids),
    addRequest(s, P, { guestId: G3, track: track(700) }, T0, ids),
  ]);
  assert.equal(same.filter((r) => r.ok).length, 1);
  await hostUpdateSettings(s, P, { maxRequestsPerGuest: 1 });
  const burst = await Promise.all([701, 702, 703].map((id) => addRequest(s, P, { guestId: G2, track: track(id) }, T0, ids)));
  assert.equal(burst.filter((r) => r.ok).length, 1);
  const pending = (await getCrowd(s, P, T0, { reveal: true })).requests.filter((r) => r.guestId === G2);
  assert.equal(pending.length, 1);
  const energy = await Promise.all([1, 1, 1].map(() => voteEnergy(s, P, { guestId: G3, vote: 1 as const }, T0)));
  assert.equal(energy.filter((r) => r.ok).length, 1);
});

await test('purge du hash énergie', async () => {
  const { s } = fresh();
  await voteEnergy(s, P, { guestId: G1, vote: 1 }, T0);
  await voteEnergy(s, P, { guestId: G2, vote: -1 }, T0 + 3 * HOUR);
  assert.equal(await purgeEnergy(s, P, T0 + 3 * HOUR), 1);
  assert.deepEqual(Object.keys(await s.hgetall(`cm:${P}:energy`)), [G2]);
});

await test('relais : seuls les hôtes d’extraits Deezer passent', () => {
  for (const h of ['cdns-preview-d.dzcdn.net', 'cdnt-preview.dzcdn.net', 'CDNS-PREVIEW-1.DZCDN.NET', 'cdn-preview-5.dzcdn.net', 'e-cdns-preview-a.dzcdn.net']) {
    assert.ok(isPreviewHost(h), h);
  }
  for (const h of ['e-cdns-images.dzcdn.net', 'evil.com', 'cdns-preview-d.dzcdn.net.evil.com', 'dzcdn.net', 'x.cdnt-preview.dzcdn.net', 'api.deezer.com', '']) {
    assert.ok(!isPreviewHost(h), h);
  }
  assert.equal(previewTarget('cdnt-preview.dzcdn.net', 'api/1/1/a/b/c/0/x.mp3', { host: 'h', path: 'p', hdnea: 'exp=1~acl=/api/1/1/a/*~hmac=ab' }),
    'https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/0/x.mp3?hdnea=exp%3D1%7Eacl%3D%2Fapi%2F1%2F1%2Fa%2F*%7Ehmac%3Dab');
  assert.equal(previewTarget('cdnt-preview.dzcdn.net', '../etc/passwd', {}), null);
  assert.equal(previewTarget('cdnt-preview.dzcdn.net', '', {}), null);
  assert.equal(previewTarget('cdnt-preview.dzcdn.net', 'a b', {}), null);
  assert.equal(previewTarget('images.dzcdn.net', 'x.jpg', {}), null);
  // Les URL d'extraits produites par les tests de shared/deezer passent le filtre.
  const u = new URL(RAW(1).preview);
  assert.ok(previewTarget(u.hostname, u.pathname, {}));
});

console.log(`\n${passed} réussi(s), ${failures} échec(s)`);
if (failures) process.exit(1);
