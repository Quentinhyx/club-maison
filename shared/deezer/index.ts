/**
 * Accès à l'API publique Deezer (api.deezer.com), sans clé.
 * Utilisé par l'API Vercel (Node) ET par l'extension Chrome : uniquement fetch, aucune API Node.
 */
import type { Genre, TrackRef } from '../contracts.js';

export const DEEZER_API = 'https://api.deezer.com';

type Fetcher = typeof fetch;

export class DeezerError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'DeezerError';
    this.code = code;
  }
}

/** AbortSignal.timeout si disponible (navigateurs récents, Node 18+). */
function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Codes d'erreur Deezer : 4 = quota dépassé, 700 = service occupé. */
const RETRYABLE = new Set([4, 700]);

async function deezerGet(path: string, fetcher: Fetcher = fetch, attempts = 3): Promise<any> {
  const url = path.startsWith('http') ? path : `${DEEZER_API}${path}`;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(400 * i + Math.random() * 300);
    try {
      // délai de 8 s : un appel bloqué ne doit jamais geler le catalogue
      const res = await fetcher(url, { headers: { Accept: 'application/json' }, signal: timeoutSignal(8000) });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new DeezerError(res.status, `Deezer HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) throw new DeezerError(res.status, `Deezer HTTP ${res.status}`);
      const json: any = await res.json();
      if (json && typeof json === 'object' && json.error) {
        const code = Number(json.error.code) || 0;
        const err = new DeezerError(code, String(json.error.message || json.error.type || 'Erreur Deezer'));
        if (RETRYABLE.has(code)) { lastErr = err; continue; }
        throw err;
      }
      return json;
    } catch (e) {
      if (e instanceof DeezerError && !RETRYABLE.has(e.code) && e.code !== 429 && e.code < 500) throw e;
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new DeezerError(0, 'Deezer injoignable');
}

function yearOf(date: unknown): number | undefined {
  if (typeof date !== 'string') return undefined;
  const y = parseInt(date.slice(0, 4), 10);
  return y > 1900 && y < 2100 ? y : undefined;
}

/** Mappe un objet "track" de api.deezer.com vers TrackRef. */
export function toTrackRef(raw: any): TrackRef {
  const t: TrackRef = {
    id: Number(raw?.id) || 0,
    title: String(raw?.title_short || raw?.title || ''),
    artist: String(raw?.artist?.name || ''),
    duration: Number(raw?.duration) || 0,
  };
  const artistId = Number(raw?.artist?.id);
  if (artistId > 0) t.artistId = artistId;
  // title_short perd les "(Extended Mix)" utiles au DJ : on garde le titre complet s'il existe.
  if (typeof raw?.title === 'string' && raw.title) t.title = raw.title;
  if (raw?.album?.title) t.album = String(raw.album.title);
  const cover = raw?.album?.cover_medium || raw?.album?.cover || raw?.cover_medium;
  if (cover) t.cover = String(cover);
  if (raw?.preview) t.preview = String(raw.preview);
  const bpm = Number(raw?.bpm);
  if (bpm > 0) t.bpm = Math.round(bpm * 100) / 100;
  const gain = Number(raw?.gain);
  if (raw?.gain !== undefined && raw?.gain !== null && Number.isFinite(gain)) t.gain = gain;
  const rank = Number(raw?.rank);
  if (rank > 0) t.rank = rank;
  const year = yearOf(raw?.release_date) ?? yearOf(raw?.album?.release_date);
  if (year) t.releaseYear = year;
  return t;
}

function usable(raw: any): boolean {
  return raw && raw.type !== 'radio' && Number(raw.id) > 0 && raw.readable !== false;
}

export async function searchTracks(
  q: string,
  opts: { limit?: number; fetcher?: Fetcher } = {},
): Promise<TrackRef[]> {
  const query = q.trim();
  if (!query) return [];
  const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
  const json = await deezerGet(`/search?q=${encodeURIComponent(query)}&limit=${limit}`, opts.fetcher);
  return (Array.isArray(json?.data) ? json.data : []).filter(usable).map(toTrackRef);
}

export async function getTrack(id: number, fetcher?: Fetcher): Promise<TrackRef> {
  if (!Number.isInteger(id) || id <= 0) throw new DeezerError(400, 'Identifiant de morceau invalide');
  const json = await deezerGet(`/track/${id}`, fetcher);
  return toTrackRef(json);
}

// ---------------------------------------------------------------------------------------------
// Catalogue par genre
// ---------------------------------------------------------------------------------------------

export const GENRE_QUERIES: Record<Genre, { playlistKeywords: string[]; seedArtists: string[] }> = {
  'tech-house': {
    playlistKeywords: ['tech house', 'tech house hits', 'tech house club'],
    seedArtists: ['Fisher', 'Chris Lake', 'John Summit', 'Dom Dolla', 'Michael Bibi', 'Mau P', 'Cloonee', 'Hugel', 'Biscits', 'James Hype'],
  },
  house: {
    playlistKeywords: ['house music', 'house hits', 'club house'],
    seedArtists: ['Purple Disco Machine', 'Fred again..', 'Disclosure', 'Duke Dumont', 'MK', 'Joel Corry', 'Meduza', 'Peggy Gou', 'Sonny Fodera'],
  },
  'deep-house': {
    playlistKeywords: ['deep house', 'deep house relax', 'deep house sunset'],
    seedArtists: ['Kerri Chandler', 'Lane 8', 'Jamie Jones', 'Larry Heard', 'Klingande', 'Kygo', 'Lost Frequencies', 'Bob Moses'],
  },
  techno: {
    playlistKeywords: ['techno', 'techno bunker', 'peak time techno'],
    seedArtists: ['Charlotte de Witte', 'Amelie Lens', 'Adam Beyer', 'Jeff Mills', 'Nina Kraviz', 'Kobosil', 'I Hate Models', 'Enrico Sangiuliano'],
  },
  minimal: {
    playlistKeywords: ['minimal techno', 'minimal deep tech', 'minimal house'],
    seedArtists: ['Richie Hawtin', 'Ricardo Villalobos', 'Zip', 'Raresh', 'Paco Osuna', 'Dennis Ferrer', 'Sidney Charles', 'Rossko'],
  },
  'afro-house': {
    playlistKeywords: ['afro house', 'afro house hits', 'afro tech'],
    seedArtists: ['Black Coffee', 'Keinemusik', '&ME', 'Rampa', 'Adam Port', 'Themba', 'Enoo Napa', 'Da Capo', 'Hugel'],
  },
  melodic: {
    playlistKeywords: ['melodic techno', 'melodic house techno', 'afterlife'],
    seedArtists: ['Tale Of Us', 'Anyma', 'Artbat', 'Stephan Bodzin', 'Camelphat', 'Argy', 'Massano', 'Mathame'],
  },
  disco: {
    playlistKeywords: ['disco classics', 'disco 70s', 'disco party'],
    seedArtists: ['Donna Summer', 'Chic', 'Bee Gees', 'Earth, Wind & Fire', 'Sister Sledge', 'Gloria Gaynor', 'Boney M.', 'Village People', 'Cerrone'],
  },
  'nu-disco': {
    playlistKeywords: ['nu disco', 'nu disco indie dance', 'disco house'],
    seedArtists: ['Purple Disco Machine', 'Dimitri From Paris', 'Folamour', 'Crazy P', 'Todd Terje', 'Breakbot', 'Roosevelt', 'Kungs'],
  },
  'french-touch': {
    playlistKeywords: ['french touch', 'french house', 'french touch classics'],
    seedArtists: ['Daft Punk', 'Cassius', 'Modjo', 'Stardust', 'Bob Sinclar', 'Alan Braxe', 'Justice', 'Martin Solveig', 'Kavinsky', 'Breakbot'],
  },
  funk: {
    playlistKeywords: ['funk classics', 'funk soul party', 'funky'],
    seedArtists: ['James Brown', 'Kool & The Gang', 'Parliament', 'Prince', 'Chaka Khan', 'Jamiroquai', 'Vulfpeck', 'Cory Wong', 'The Gap Band'],
  },
  '80s': {
    playlistKeywords: ['années 80', '80s hits', '80s party'],
    seedArtists: ['Michael Jackson', 'Madonna', 'Whitney Houston', 'a-ha', 'Cyndi Lauper', 'Desireless', 'Indochine', 'Daniel Balavoine', 'Wham!', 'Kim Wilde'],
  },
  '90s': {
    playlistKeywords: ['années 90', '90s hits', 'eurodance 90s'],
    seedArtists: ['Haddaway', 'Corona', 'Dr. Alban', 'Spice Girls', 'Backstreet Boys', 'Ace of Base', 'Snap!', 'Vengaboys', 'Alliance Ethnik', 'IAM'],
  },
  '2000s': {
    playlistKeywords: ['années 2000', '2000s hits', '2000s party'],
    seedArtists: ['Beyoncé', 'Britney Spears', 'Black Eyed Peas', 'David Guetta', 'Shakira', 'Rihanna', 'Usher', 'Nelly Furtado', 'Sean Paul', 'Bob Sinclar'],
  },
  'rap-fr': {
    playlistKeywords: ['rap français', 'rap fr hits', 'rap fr soirée'],
    seedArtists: ['Ninho', 'Jul', 'SDM', 'Gazo', 'Booba', 'PNL', 'Aya Nakamura', 'Tiakola', 'Werenoi', 'Damso', 'Niska', 'Naps'],
  },
  'rap-us': {
    playlistKeywords: ['rap us', 'hip hop party', 'hip hop hits'],
    seedArtists: ['Drake', 'Travis Scott', 'Kendrick Lamar', 'Future', '50 Cent', 'Cardi B', 'Megan Thee Stallion', 'Jay-Z', 'Kanye West', 'Lil Wayne'],
  },
  rnb: {
    playlistKeywords: ['rnb', 'rnb hits', 'r&b party'],
    seedArtists: ['SZA', 'The Weeknd', 'Chris Brown', 'Usher', 'Ne-Yo', 'Rihanna', 'Bryson Tiller', 'Destiny\'s Child', 'Aaliyah', 'Tems'],
  },
  afro: {
    playlistKeywords: ['afrobeats', 'afro hits', 'afro party'],
    seedArtists: ['Burna Boy', 'Wizkid', 'Davido', 'Rema', 'Ayra Starr', 'Asake', 'Fally Ipupa', 'Tems', 'CKay'],
  },
  amapiano: {
    playlistKeywords: ['amapiano', 'amapiano hits', 'amapiano party'],
    seedArtists: ['Kabza De Small', 'DJ Maphorisa', 'Uncle Waffles', 'Tyler ICU', 'Focalistic', 'Kelvin Momo', 'Young Stunna', 'Major League DJz'],
  },
  latino: {
    playlistKeywords: ['latino hits', 'latin party', 'fiesta latina'],
    seedArtists: ['Bad Bunny', 'J Balvin', 'Karol G', 'Daddy Yankee', 'Shakira', 'Ozuna', 'Maluma', 'Rauw Alejandro', 'Marc Anthony'],
  },
  reggaeton: {
    playlistKeywords: ['reggaeton', 'reggaeton hits', 'perreo'],
    seedArtists: ['Daddy Yankee', 'Don Omar', 'Bad Bunny', 'Feid', 'Myke Towers', 'Wisin & Yandel', 'Nicky Jam', 'Anuel AA'],
  },
  dancehall: {
    playlistKeywords: ['dancehall', 'dancehall hits', 'dancehall party'],
    seedArtists: ['Sean Paul', 'Vybz Kartel', 'Popcaan', 'Shenseea', 'Spice', 'Konshens', 'Charly Black', 'Busy Signal'],
  },
  pop: {
    playlistKeywords: ['pop hits', 'pop party', 'top hits'],
    seedArtists: ['Dua Lipa', 'Taylor Swift', 'Harry Styles', 'Calvin Harris', 'Lady Gaga', 'Ariana Grande', 'Bruno Mars', 'Sabrina Carpenter', 'Angèle'],
  },
  electro: {
    playlistKeywords: ['electro', 'edm hits', 'electro party'],
    seedArtists: ['David Guetta', 'Avicii', 'Martin Garrix', 'Swedish House Mafia', 'Calvin Harris', 'Tiësto', 'Alok', 'Armin van Buuren'],
  },
  'drum-bass': {
    playlistKeywords: ['drum and bass', 'drum & bass', 'liquid drum and bass'],
    seedArtists: ['Chase & Status', 'Sub Focus', 'Pendulum', 'Netsky', 'Wilkinson', 'Dimension', 'Andy C', 'Hybrid Minds', 'Goldie'],
  },
  'uk-garage': {
    playlistKeywords: ['uk garage', 'uk garage classics', 'speed garage'],
    seedArtists: ['Artful Dodger', 'Craig David', 'Sammy Virji', 'Interplanetary Criminal', 'Conducta', 'MJ Cole', 'DJ EZ', 'Todd Edwards'],
  },
  rock: {
    playlistKeywords: ['rock party', 'rock classics', 'indie rock'],
    seedArtists: ['AC/DC', 'Queen', 'Arctic Monkeys', 'The Killers', 'Red Hot Chili Peppers', 'Muse', 'Téléphone', 'The Strokes', 'Franz Ferdinand'],
  },
};

const MIN_DURATION = 90;
const MAX_DURATION = 12 * 60;

function shuffle<T>(arr: T[], rng: () => number = Math.random): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pick<T>(arr: T[], n: number): T[] {
  return shuffle(arr).slice(0, n);
}

/** BPM compatible (avec tolérance et doublement / moitié, ex. 64 ~ 128). Inconnu = accepté. */
function bpmFits(bpm: number | undefined, min?: number, max?: number): boolean {
  if (!bpm || (!min && !max)) return true;
  const lo = (min ?? 0) - 3;
  const hi = (max ?? 999) + 3;
  return [bpm, bpm * 2, bpm / 2].some((b) => b >= lo && b <= hi);
}

/** Exécute les tâches avec une concurrence limitée ; une tâche qui échoue renvoie []. */
async function settle<T>(tasks: Array<() => Promise<T[]>>, concurrency = 4): Promise<T[][]> {
  const out: T[][] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      try { out[i] = await tasks[i](); } catch { out[i] = []; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return out;
}

/**
 * Sélection de morceaux pour un genre, sans identifiant de playlist codé en dur :
 * recherche de playlists par mots-clés + recherche de morceaux par artistes repères (et par plage
 * de BPM si fournie). Les résultats sont dédupliqués, filtrés (durée), marqués du genre, mélangés.
 */
export async function catalogForGenre(
  genre: Genre,
  opts: { bpmMin?: number; bpmMax?: number; limit?: number; fetcher?: Fetcher } = {},
): Promise<TrackRef[]> {
  const q = GENRE_QUERIES[genre];
  if (!q) throw new DeezerError(400, `Genre inconnu : ${genre}`);
  const limit = Math.max(1, Math.min(200, opts.limit ?? 60));
  const f = opts.fetcher;
  const { bpmMin, bpmMax } = opts;

  const tasks: Array<() => Promise<TrackRef[]>> = [];

  // 1. Playlists : on prend les 2 meilleures (plus de fans) de 2 mots-clés.
  for (const kw of pick(q.playlistKeywords, 2)) {
    tasks.push(async () => {
      const res = await deezerGet(`/search/playlist?q=${encodeURIComponent(kw)}&limit=10`, f);
      const lists: any[] = (Array.isArray(res?.data) ? res.data : [])
        .filter((p: any) => p && Number(p.id) > 0 && (p.nb_tracks ?? 0) >= 15)
        .sort((a: any, b: any) => (b.fans ?? 0) - (a.fans ?? 0))
        .slice(0, 2);
      const tracks = await settle<TrackRef>(
        lists.map((p) => async (): Promise<TrackRef[]> => {
          const r = await deezerGet(`/playlist/${p.id}/tracks?limit=80`, f);
          return (Array.isArray(r?.data) ? r.data : []).filter(usable).map(toTrackRef);
        }),
        2,
      );
      return tracks.flat();
    });
  }

  // 2. Artistes repères.
  for (const artist of pick(q.seedArtists, 4)) {
    tasks.push(() => searchTracks(`artist:"${artist}"`, { limit: 20, fetcher: f }));
  }

  // 3. Recherche avancée par BPM (le champ bpm est souvent vide chez Deezer : complément seulement).
  if (bpmMin || bpmMax) {
    const parts = [q.playlistKeywords[0]];
    if (bpmMin) parts.push(`bpm_min:"${Math.round(bpmMin)}"`);
    if (bpmMax) parts.push(`bpm_max:"${Math.round(bpmMax)}"`);
    tasks.push(() => searchTracks(parts.join(' '), { limit: 40, fetcher: f }));
  }

  const results = (await settle(tasks, 4)).flat();

  const seen = new Set<number>();
  const seenTitle = new Set<string>();
  const out: TrackRef[] = [];
  for (const t of results) {
    if (!t.id || seen.has(t.id)) continue;
    if (t.duration < MIN_DURATION || t.duration > MAX_DURATION) continue;
    if (!bpmFits(t.bpm, bpmMin, bpmMax)) continue;
    const key = `${t.artist}|${t.title}`.toLowerCase();
    if (seenTitle.has(key)) continue;
    seen.add(t.id);
    seenTitle.add(key);
    out.push({ ...t, genres: [genre] });
  }

  // Mélange léger : on garde une préférence pour les morceaux populaires.
  const scored = out.map((t) => ({ t, s: Math.log10((t.rank ?? 1000) + 10) + Math.random() * 2.5 }));
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.t);
}

// ---------------------------------------------------------------------------------------------
// Morceaux similaires (file vide : rester dans le même registre)
// ---------------------------------------------------------------------------------------------

/**
 * Morceaux proches de `track` : radio de l'artiste (mix Deezer d'artistes voisins) + meilleurs titres de
 * quelques artistes proches. Sans artistId, on le retrouve par une recherche sur le nom.
 * Le morceau lui-même est exclu ; durées absurdes filtrées ; dédoublonné ; mélange léger.
 */
export async function similarTracks(
  track: TrackRef,
  opts: { limit?: number; fetcher?: Fetcher } = {},
): Promise<TrackRef[]> {
  const f = opts.fetcher;
  const limit = Math.max(1, Math.min(60, opts.limit ?? 30));
  let artistId = track.artistId;
  if (!artistId && track.artist) {
    try {
      const json = await deezerGet(`/search/artist?q=${encodeURIComponent(track.artist)}&limit=1`, f);
      artistId = Number(json?.data?.[0]?.id) || undefined;
    } catch {
      /* rien : pas de similaires */
    }
  }
  if (!artistId) return [];

  const list = (json: any): TrackRef[] => (Array.isArray(json?.data) ? json.data : []).filter(usable).map(toTrackRef);
  const tasks: Array<() => Promise<TrackRef[]>> = [
    () => deezerGet(`/artist/${artistId}/radio?limit=40`, f).then(list),
    async () => {
      const rel = await deezerGet(`/artist/${artistId}/related?limit=6`, f);
      const ids: number[] = (Array.isArray(rel?.data) ? rel.data : []).map((a: any) => Number(a?.id)).filter((x: number) => x > 0).slice(0, 4);
      const tops = await Promise.all(ids.map((id) => deezerGet(`/artist/${id}/top?limit=5`, f).then(list).catch(() => [] as TrackRef[])));
      return tops.flat();
    },
  ];
  const results = (await Promise.all(tasks.map((t) => t().catch(() => [] as TrackRef[])))).flat();

  const seen = new Set<number>([track.id]);
  const seenTitle = new Set<string>([`${track.artist}|${track.title}`.toLowerCase()]);
  const out: TrackRef[] = [];
  for (const t of results) {
    if (!t.id || seen.has(t.id)) continue;
    if (t.duration < MIN_DURATION || t.duration > MAX_DURATION) continue;
    const key = `${t.artist}|${t.title}`.toLowerCase();
    if (seenTitle.has(key)) continue;
    seen.add(t.id);
    seenTitle.add(key);
    out.push(track.genres ? { ...t, genres: track.genres } : t);
  }
  const scored = out.map((t) => ({ t, s: Math.log10((t.rank ?? 1000) + 10) + Math.random() * 2 }));
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.t);
}
