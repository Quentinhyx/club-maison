/**
 * Stockage : Upstash Redis si les variables d'environnement existent, sinon mémoire (dev, tests).
 * Les valeurs sont des chaînes (JSON sérialisé par l'appelant).
 */
import { Redis } from '@upstash/redis';

export interface Store {
  readonly kind: 'redis' | 'memory';
  get(key: string): Promise<string | null>;
  /** ttlSec : expiration en secondes (facultative). */
  set(key: string, value: string, ttlSec?: number): Promise<void>;
  /** Pose la clé seulement si elle n'existe pas. Renvoie true si posée. */
  setNX(key: string, value: string, ttlSec: number): Promise<boolean>;
  del(key: string): Promise<void>;
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<void>;
  hdel(key: string, ...fields: string[]): Promise<void>;
  hgetall(key: string): Promise<Record<string, string>>;
  expire(key: string, ttlSec: number): Promise<void>;
}

// ---------------------------------------------------------------------------------------------

type Entry = { v: string | Map<string, string>; exp?: number };

export class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  private m = new Map<string, Entry>();
  /** Horloge injectable (tests). */
  now: () => number = () => Date.now();

  private live(key: string): Entry | undefined {
    const e = this.m.get(key);
    if (!e) return undefined;
    if (e.exp !== undefined && e.exp <= this.now()) { this.m.delete(key); return undefined; }
    return e;
  }
  private hash(key: string, create: boolean): Map<string, string> | undefined {
    const e = this.live(key);
    if (e && e.v instanceof Map) return e.v;
    if (!create) return undefined;
    const h = new Map<string, string>();
    this.m.set(key, { v: h, exp: e?.exp });
    return h;
  }

  async get(key: string) {
    const e = this.live(key);
    return e && typeof e.v === 'string' ? e.v : null;
  }
  async set(key: string, value: string, ttlSec?: number) {
    this.m.set(key, { v: value, exp: ttlSec ? this.now() + ttlSec * 1000 : undefined });
  }
  async setNX(key: string, value: string, ttlSec: number) {
    if (this.live(key)) return false;
    await this.set(key, value, ttlSec);
    return true;
  }
  async del(key: string) { this.m.delete(key); }
  async hget(key: string, field: string) { return this.hash(key, false)?.get(field) ?? null; }
  async hset(key: string, field: string, value: string) { this.hash(key, true)!.set(field, value); }
  async hdel(key: string, ...fields: string[]) {
    const h = this.hash(key, false);
    if (h) for (const f of fields) h.delete(f);
  }
  async hgetall(key: string) { return Object.fromEntries(this.hash(key, false) ?? []); }
  async expire(key: string, ttlSec: number) {
    const e = this.live(key);
    if (e) e.exp = this.now() + ttlSec * 1000;
  }
}

// ---------------------------------------------------------------------------------------------

export class RedisStore implements Store {
  readonly kind = 'redis' as const;
  constructor(private r: Redis) {}

  async get(key: string) {
    const v = await this.r.get<string>(key);
    return v === null || v === undefined ? null : String(v);
  }
  async set(key: string, value: string, ttlSec?: number) {
    if (ttlSec) await this.r.set(key, value, { ex: Math.ceil(ttlSec) });
    else await this.r.set(key, value);
  }
  async setNX(key: string, value: string, ttlSec: number) {
    const res = await this.r.set(key, value, { nx: true, ex: Math.ceil(ttlSec) });
    return res === 'OK';
  }
  async del(key: string) { await this.r.del(key); }
  async hget(key: string, field: string) {
    const v = await this.r.hget<string>(key, field);
    return v === null || v === undefined ? null : String(v);
  }
  async hset(key: string, field: string, value: string) { await this.r.hset(key, { [field]: value }); }
  async hdel(key: string, ...fields: string[]) { if (fields.length) await this.r.hdel(key, ...fields); }
  async hgetall(key: string) {
    const raw: unknown = await this.r.hgetall(key);
    const out: Record<string, string> = {};
    if (Array.isArray(raw)) {
      // automaticDeserialization: false -> tableau plat [champ, valeur, ...]
      for (let i = 0; i + 1 < raw.length; i += 2) out[String(raw[i])] = String(raw[i + 1]);
    } else if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) out[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    return out;
  }
  async expire(key: string, ttlSec: number) { await this.r.expire(key, Math.ceil(ttlSec)); }
}

// ---------------------------------------------------------------------------------------------

let singleton: Store | undefined;

export function getStore(): Store {
  if (singleton) return singleton;
  const env = typeof process !== 'undefined' ? process.env : {};
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  singleton = url && token
    ? new RedisStore(new Redis({ url, token, automaticDeserialization: false }))
    : new MemoryStore();
  return singleton;
}

/** Pour les tests. */
export function setStore(s: Store | undefined) { singleton = s; }
