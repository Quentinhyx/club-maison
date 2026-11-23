/** Utilitaires HTTP communs aux fonctions Vercel. */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  clientIp, hostAccess, IP_REQUEST_LIMIT, IP_REQUEST_WINDOW_SEC, IP_WRITE_LIMIT, IP_WRITE_WINDOW_SEC,
  normalizeParty, rateLimit, type Result,
} from './party.js';
import { getStore, type Store } from './store.js';

const MAX_BODY = 16 * 1024;

/** CORS ouvert : l'extension Chrome appelle l'API depuis chrome-extension://. */
export function cors(req: VercelRequest, res: VercelResponse): boolean {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-host-key');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

export function sendError(res: VercelResponse, status: number, code: string, message: string, extra?: object) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json({ error: { code, message, ...(extra ?? {}) } });
}

export function sendResult<T>(res: VercelResponse, r: Result<T>) {
  if (r.ok) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(r.value);
  } else {
    if (r.retryAfter) res.setHeader('Retry-After', String(r.retryAfter));
    sendError(res, r.status, r.code, r.message, r.retryAfter ? { retryAfter: r.retryAfter } : undefined);
  }
}

/** Gère CORS + méthode. Renvoie false si la réponse est déjà partie. */
export function prelude(req: VercelRequest, res: VercelResponse, method: 'GET' | 'POST'): boolean {
  if (cors(req, res)) return false;
  if (req.method !== method) {
    res.setHeader('Allow', `${method}, OPTIONS`);
    sendError(res, 405, 'method', `Méthode ${req.method} non autorisée (attendu : ${method}).`);
    return false;
  }
  return true;
}

export function partyOf(req: VercelRequest): string {
  const p = req.query?.party;
  return normalizeParty(Array.isArray(p) ? p[0] : p);
}

export function queryString(req: VercelRequest, name: string): string | undefined {
  const v = req.query?.[name];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' ? s : undefined;
}

/** Corps JSON (objet) ou null si invalide / trop gros. */
export function jsonBody(req: VercelRequest): Record<string, unknown> | null {
  let b: unknown = req.body;
  if (typeof b === 'string') {
    if (b.length > MAX_BODY) return null;
    try { b = JSON.parse(b); } catch { return null; }
  } else if (b && typeof b === 'object' && !Array.isArray(b)) {
    if (JSON.stringify(b).length > MAX_BODY) return null;
  }
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
}

export function ipOf(req: VercelRequest): string {
  return clientIp(req.headers);
}

/** Clé hôte obligatoire (avec anti-force-brute par IP). Envoie l'erreur et renvoie false sinon. */
export async function requireHost(req: VercelRequest, res: VercelResponse, store: Store): Promise<boolean> {
  const r = await hostAccess(store, ipOf(req), req.headers['x-host-key'], process.env.HOST_KEY);
  if (!r.ok) { sendResult(res, r); return false; }
  return true;
}

/** Vrai si l'en-tête x-host-key est présent et juste (un essai faux compte comme un échec). */
export async function isHost(req: VercelRequest, store: Store): Promise<boolean> {
  if (!req.headers['x-host-key']) return false;
  return (await hostAccess(store, ipOf(req), req.headers['x-host-key'], process.env.HOST_KEY)).ok;
}

/** Limites par IP pour les écritures invités ('write'), et en plus pour les demandes ('request'). */
export async function limitIp(req: VercelRequest, res: VercelResponse, store: Store, kind: 'write' | 'request'): Promise<boolean> {
  const ip = ipOf(req);
  const w = await rateLimit(store, 'write', ip, IP_WRITE_LIMIT, IP_WRITE_WINDOW_SEC);
  if (!w.ok) { sendResult(res, w); return false; }
  if (kind === 'request') {
    const r = await rateLimit(store, 'request', ip, IP_REQUEST_LIMIT, IP_REQUEST_WINDOW_SEC);
    if (!r.ok) { sendResult(res, r); return false; }
  }
  return true;
}

/** Garde-fou : toute exception devient une 500 propre (avec CORS déjà posé). */
export function guard(fn: (req: VercelRequest, res: VercelResponse, store: Store) => Promise<void>) {
  return async function handler(req: VercelRequest, res: VercelResponse) {
    try {
      await fn(req, res, getStore());
    } catch (e) {
      console.error(e);
      if (!res.headersSent) sendError(res, 500, 'server', 'Le serveur a trébuché. Réessaie dans un instant.');
    }
  };
}

/** Cache court (10 min) dans le store, pour /api/search et /api/catalog. */
export const CACHE_TTL_SEC = 600;

export async function cached<T>(store: Store, key: string, ttlSec: number, compute: () => Promise<T>): Promise<T> {
  const hit = await store.get(key).catch(() => null);
  if (hit) {
    try { return JSON.parse(hit) as T; } catch { /* recalcul */ }
  }
  const value = await compute();
  await store.set(key, JSON.stringify(value), ttlSec).catch(() => undefined);
  return value;
}
