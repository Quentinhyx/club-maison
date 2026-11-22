/** Score d'un morceau candidat (ou d'un son de la file) pour passer après le morceau en cours. */
import type { Camelot, Genre, QueueItem, TrackAnalysis, TrackRef } from '../contracts';
import { GENRE_GRAPH, genreMidBpm, isElectronic } from './genres';
import { harmonicScore } from './harmony';

export interface CandidateInfo {
  track: TrackRef;
  analysis?: TrackAnalysis;
  genre?: Genre;
  source: 'queue' | 'candidate';
  queueSource?: QueueItem['source'];
}

export interface ScoreContext {
  /** Tempo effectif du morceau en cours (après rate), clé du morceau en cours. */
  refBpm?: number;
  refKey?: Camelot;
  targetEnergy: number;
  /** BPM cible de la soirée (profil), appliqué aux genres électroniques. */
  targetBpm?: number;
  stepGenre: Genre;
  targetGenre: Genre;
  path: Genre[];
  blockedGenres: ReadonlySet<Genre>;
  blockedIds: ReadonlySet<number>;
  /** trackId -> Date.now() du dernier passage. */
  recentPlays: ReadonlyMap<number, number>;
  nowMs: number;
  /** Artistes des 3 derniers morceaux (en cours compris). */
  recentArtists: readonly string[];
  /** Morceaux déjà sur une platine / mauvais. */
  excludeIds: ReadonlySet<number>;
  allowArtistRepeat?: boolean;
  random?: () => number;
}

export interface ScoreResult {
  score: number;
  excluded?: string;
  tempoPct: number;
  parts: { tempo: number; harmony: number; energy: number; genre: number; bpmTarget: number; popularity: number };
}

export const REPLAY_WINDOW_MS = 2 * 3600 * 1000;

/** Meilleur calage : multiplicateur (1, ×2, ÷2), rate à appliquer à l'entrant, écart relatif. */
export function tempoMatch(outBpm: number, inBpm: number): { mult: number; rate: number; pct: number } {
  let best = { mult: 1, rate: outBpm / inBpm, pct: Math.abs(outBpm / inBpm - 1) };
  for (const mult of [2, 0.5]) {
    const rate = outBpm / (inBpm * mult);
    const pct = Math.abs(rate - 1);
    if (pct < best.pct - 1e-9) best = { mult, rate, pct };
  }
  return best;
}

/** 1 si calage quasi nul, ~0.6 à 6 % (limite du calage), puis chute : il faudra une rupture. */
export function tempoScore(pct: number): number {
  if (pct <= 0.02) return 1;
  if (pct <= 0.06) return 1 - ((pct - 0.02) / 0.04) * 0.4;
  if (pct <= 0.12) return 0.45 - ((pct - 0.06) / 0.06) * 0.25;
  return 0.15;
}

export function trackGenres(c: { track: TrackRef; analysis?: TrackAnalysis; genre?: Genre }): Genre[] {
  const s = new Set<Genre>();
  if (c.genre) s.add(c.genre);
  for (const g of c.track.genres ?? []) s.add(g);
  for (const g of c.analysis?.genres ?? []) s.add(g);
  return [...s];
}

export function primaryGenre(c: { track: TrackRef; analysis?: TrackAnalysis; genre?: Genre }): Genre | undefined {
  return c.genre ?? c.track.genres?.[0] ?? c.analysis?.genres?.[0];
}

export function bpmOf(c: { track: TrackRef; analysis?: TrackAnalysis; genre?: Genre }): number {
  if (c.analysis && c.analysis.bpm > 0) return c.analysis.bpm;
  if (c.track.bpm && c.track.bpm > 0) return c.track.bpm;
  return genreMidBpm(primaryGenre(c));
}

export function scoreCandidate(c: CandidateInfo, ctx: ScoreContext): ScoreResult {
  const parts = { tempo: 0, harmony: 0, energy: 0, genre: 0, bpmTarget: 0.5, popularity: 0.5 };
  const id = c.track.id;
  const isHost = c.queueSource === 'host';
  const fail = (excluded: string): ScoreResult => ({ score: 0, excluded, tempoPct: 1, parts });
  if (ctx.excludeIds.has(id)) return fail('déjà sur une platine');
  if (ctx.blockedIds.has(id)) return fail('morceau bloqué par l’hôte');
  const genres = trackGenres(c);
  if (!isHost && genres.some((g) => ctx.blockedGenres.has(g))) return fail('genre bloqué');
  const last = ctx.recentPlays.get(id);
  if (!isHost && last !== undefined && ctx.nowMs - last < REPLAY_WINDOW_MS) return fail('joué il y a moins de 2 h');
  if (c.source === 'candidate' && !ctx.allowArtistRepeat && ctx.recentArtists.includes(c.track.artist.toLowerCase())) {
    return fail('artiste joué récemment');
  }

  const bpm = bpmOf(c);
  let tempoPct = 0.03;
  if (ctx.refBpm) {
    tempoPct = tempoMatch(ctx.refBpm, bpm).pct;
    parts.tempo = tempoScore(tempoPct);
  } else parts.tempo = 0.7;
  parts.harmony = harmonicScore(ctx.refKey, c.analysis?.key);
  const energy = c.analysis?.energy ?? 0.6;
  parts.energy = Math.max(0, 1 - Math.abs(energy - ctx.targetEnergy) * 1.6);

  const g = primaryGenre(c);
  if (!g) parts.genre = 0.4;
  else if (g === ctx.stepGenre) parts.genre = 1;
  else if (g === ctx.targetGenre) parts.genre = 0.35; // saut sans pont alors que le profil veut un pont
  else if (ctx.path.includes(g)) parts.genre = 0.5;
  else if (GENRE_GRAPH[ctx.stepGenre][g] !== undefined) parts.genre = 0.4;
  else parts.genre = 0.12;

  if (ctx.targetBpm && isElectronic(g)) {
    const t = tempoMatch(ctx.targetBpm, bpm);
    parts.bpmTarget = Math.max(0, 1 - Math.abs(bpm * t.mult - ctx.targetBpm) / 8);
  }
  if (c.track.rank !== undefined) parts.popularity = Math.min(1, c.track.rank / 900000);

  const jitter = ctx.random ? ctx.random() * 0.04 : 0;
  const score = 0.3 * parts.genre + 0.22 * parts.tempo + 0.18 * parts.harmony + 0.2 * parts.energy
    + 0.05 * parts.bpmTarget + 0.05 * parts.popularity + jitter;
  return { score, tempoPct, parts };
}
