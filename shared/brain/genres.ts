/**
 * Genres : plages de tempo typiques, graphe de voisinage (coût d'un passage) et plus court chemin.
 * Le graphe sert à « faire le pont » entre deux styles éloignés (80s -> nu-disco -> house -> tech house).
 */
import type { Genre } from '../contracts';
import { GENRES } from '../contracts';

/** Plages de BPM typiques (tempo normalisé dans [70, 180] comme l'analyse). */
export const GENRE_BPM: Record<Genre, [number, number]> = {
  'tech-house': [122, 130],
  house: [118, 128],
  'deep-house': [115, 124],
  techno: [125, 140],
  minimal: [120, 128],
  'afro-house': [118, 125],
  melodic: [118, 126],
  disco: [110, 128],
  'nu-disco': [110, 124],
  'french-touch': [115, 128],
  funk: [95, 120],
  '80s': [100, 130],
  '90s': [95, 130],
  '2000s': [90, 130],
  'rap-fr': [80, 145],
  'rap-us': [80, 150],
  rnb: [70, 110],
  afro: [95, 118],
  amapiano: [108, 116],
  latino: [90, 130],
  reggaeton: [88, 100],
  dancehall: [90, 110],
  pop: [100, 130],
  electro: [124, 132],
  'drum-bass': [165, 178],
  'uk-garage': [128, 136],
  rock: [100, 150],
};

/** Genres « club » dont les intros/outros sont faites pour être mixées (calage, blends longs). */
export const ELECTRONIC_GENRES: ReadonlySet<Genre> = new Set<Genre>([
  'tech-house', 'house', 'deep-house', 'techno', 'minimal', 'afro-house', 'melodic',
  'nu-disco', 'french-touch', 'electro', 'drum-bass', 'uk-garage', 'amapiano',
]);

export function isElectronic(g?: Genre): boolean {
  return g !== undefined && ELECTRONIC_GENRES.has(g);
}

/** Arêtes non orientées [a, b, coût]. Coût 1 = voisins naturels, 2+ = passage plus risqué. */
export const GENRE_EDGES: ReadonlyArray<readonly [Genre, Genre, number]> = [
  ['tech-house', 'house', 1], ['tech-house', 'minimal', 1], ['tech-house', 'techno', 1.5],
  ['tech-house', 'afro-house', 1.2], ['tech-house', 'deep-house', 1.2], ['tech-house', 'uk-garage', 2],
  ['house', 'deep-house', 1], ['house', 'nu-disco', 1], ['house', 'french-touch', 1],
  ['house', 'disco', 1.5], ['house', 'afro-house', 1.2], ['house', 'uk-garage', 1.5],
  ['house', 'electro', 1.5], ['house', '90s', 2], ['house', 'pop', 2],
  ['deep-house', 'melodic', 1.5], ['deep-house', 'afro-house', 1.2], ['deep-house', 'nu-disco', 1.5],
  ['techno', 'minimal', 1], ['techno', 'melodic', 1.2], ['techno', 'electro', 1.5], ['techno', 'drum-bass', 2.5],
  ['afro-house', 'afro', 1.2], ['afro-house', 'amapiano', 1], ['afro-house', 'latino', 2],
  ['disco', 'funk', 1], ['disco', 'nu-disco', 1], ['disco', '80s', 1.2],
  ['nu-disco', '80s', 1.2], ['nu-disco', 'french-touch', 1], ['nu-disco', 'funk', 1.5],
  ['french-touch', 'electro', 1], ['french-touch', '2000s', 1.5],
  ['funk', '80s', 1.2], ['funk', 'rnb', 1.5],
  ['80s', '90s', 1.2], ['80s', 'pop', 1.5], ['80s', 'rock', 1.5],
  ['90s', '2000s', 1], ['90s', 'rap-us', 1.5], ['90s', 'rnb', 1.2], ['90s', 'pop', 1.2],
  ['2000s', 'pop', 1], ['2000s', 'rnb', 1], ['2000s', 'rap-us', 1.2], ['2000s', 'electro', 1.5],
  ['rap-fr', 'rap-us', 1], ['rap-fr', 'afro', 1], ['rap-fr', 'rnb', 1.5], ['rap-fr', 'dancehall', 2],
  ['rap-us', 'rnb', 1],
  ['afro', 'amapiano', 1.2], ['afro', 'dancehall', 1.2], ['afro', 'rnb', 1.5], ['afro', 'latino', 1.5],
  ['amapiano', 'deep-house', 1.5],
  ['latino', 'reggaeton', 1], ['latino', 'pop', 1.5],
  ['reggaeton', 'dancehall', 1.2],
  ['pop', 'rock', 1.5], ['pop', 'electro', 1.5],
  ['electro', 'drum-bass', 2],
  ['drum-bass', 'uk-garage', 1.5],
  ['uk-garage', 'rnb', 1.8],
];

function buildGraph(): Record<Genre, Partial<Record<Genre, number>>> {
  const g = Object.fromEntries(GENRES.map((x) => [x, {}])) as Record<Genre, Partial<Record<Genre, number>>>;
  for (const [a, b, c] of GENRE_EDGES) {
    g[a][b] = c;
    g[b][a] = c;
  }
  return g;
}

/** Voisinages entre genres avec leur coût (symétrique). */
export const GENRE_GRAPH: Record<Genre, Partial<Record<Genre, number>>> = buildGraph();

/**
 * Plus court chemin pondéré (Dijkstra) de `from` à `to`, extrémités comprises.
 * `blocked` : genres à éviter comme étapes intermédiaires (genres bloqués par l'hôte).
 * Si aucun chemin n'existe, renvoie [from, to] (saut direct).
 */
export function genrePath(from: Genre, to: Genre, blocked?: Iterable<Genre>): Genre[] {
  if (from === to) return [from];
  const avoid = new Set<Genre>(blocked ?? []);
  avoid.delete(from);
  avoid.delete(to);
  const dist = new Map<Genre, number>([[from, 0]]);
  const prev = new Map<Genre, Genre>();
  const done = new Set<Genre>();
  for (;;) {
    let u: Genre | undefined;
    let best = Infinity;
    for (const [g, d] of dist) {
      if (!done.has(g) && d < best) { best = d; u = g; }
    }
    if (u === undefined) break;
    if (u === to) break;
    done.add(u);
    for (const [v, c] of Object.entries(GENRE_GRAPH[u]) as Array<[Genre, number]>) {
      if (avoid.has(v) || done.has(v)) continue;
      const nd = best + c;
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u); }
    }
  }
  if (!dist.has(to)) return [from, to];
  const path: Genre[] = [to];
  let cur: Genre = to;
  while (cur !== from) {
    cur = prev.get(cur)!;
    path.unshift(cur);
  }
  return path;
}

/** Coût total d'un chemin (Infinity si deux étapes ne sont pas voisines). */
export function genrePathCost(path: Genre[]): number {
  let c = 0;
  for (let i = 1; i < path.length; i++) c += GENRE_GRAPH[path[i - 1]][path[i]] ?? Infinity;
  return c;
}

export function genreMidBpm(g?: Genre): number {
  if (!g) return 120;
  const [a, b] = GENRE_BPM[g];
  return (a + b) / 2;
}
