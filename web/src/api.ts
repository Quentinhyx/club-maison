import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_PARTY,
  type CrowdState, type EnergyVote, type Genre, type GuestRequest, type HostSettings,
  type PartyState, type TrackRef,
} from '../../shared/contracts';

// ---------------------------------------------------------------------------------------------
// Petits utilitaires navigateur
// ---------------------------------------------------------------------------------------------

export function lsGet(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
export function lsSet(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch { /* stockage indisponible : tant pis */ }
}

export function currentParty(): string {
  const p = new URLSearchParams(window.location.search).get('party')?.trim().toLowerCase() ?? '';
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(p) ? p : DEFAULT_PARTY;
}

let memGuestId: string | null = null;
export function guestId(): string {
  const saved = lsGet('cm.guestId');
  if (saved && /^[A-Za-z0-9_-]{6,64}$/.test(saved)) return saved;
  if (!memGuestId) {
    const rnd = (globalThis.crypto?.randomUUID?.() ?? `${Math.random()}${Date.now()}`).replace(/[^a-z0-9]/gi, '');
    memGuestId = `g${rnd.slice(0, 20)}`;
    lsSet('cm.guestId', memGuestId);
  }
  return memGuestId;
}

// ---------------------------------------------------------------------------------------------
// Appels API
// ---------------------------------------------------------------------------------------------

export class ApiError extends Error {
  status: number;
  code: string;
  offline: boolean;
  retryAfter?: number;
  constructor(status: number, code: string, message: string, offline = false, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.offline = offline;
    this.retryAfter = retryAfter;
  }
}

const OFFLINE_MSG = 'La piste ne répond pas. Vérifie ta connexion, on réessaie.';

async function call<T>(method: 'GET' | 'POST', path: string, opts: { body?: unknown; hostKey?: string; party?: string } = {}): Promise<T> {
  const url = new URL(`/api/${path}`, window.location.origin);
  url.searchParams.set('party', opts.party ?? currentParty());
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.hostKey) headers['x-host-key'] = opts.hostKey;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method, headers, signal: ctrl.signal, cache: 'no-store',
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'offline', OFFLINE_MSG, true);
  } finally {
    clearTimeout(timer);
  }
  let data: any;
  try {
    data = await res.json();
  } catch {
    // Pas du JSON : API absente (dev sans `vercel dev`) ou passerelle en panne.
    throw new ApiError(res.status, 'offline', OFFLINE_MSG, true);
  }
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? 'Quelque chose a coincé. Réessaie.',
      res.status >= 502 && !e.code, e.retryAfter);
  }
  return data as T;
}

export const api = {
  state: (hostKey?: string) => call<PartyState>('GET', 'state', { hostKey }),
  search: (q: string) => call<TrackRef[]>('GET', `search?q=${encodeURIComponent(q)}`),
  vote: (genre: Genre) => call<CrowdState>('POST', 'vote', { body: { guestId: guestId(), genre } }),
  energy: (vote: EnergyVote) => call<CrowdState>('POST', 'energy', { body: { guestId: guestId(), vote } }),
  request: (track: TrackRef, guestName?: string) =>
    call<GuestRequest>('POST', 'request', { body: { guestId: guestId(), guestName, track } }),
  hostSettings: (hostKey: string, patch: Partial<Record<keyof HostSettings, unknown>>) =>
    call<HostSettings>('POST', 'host/settings', { hostKey, body: patch }),
  hostRequest: (hostKey: string, id: string, status: GuestRequest['status']) =>
    call<GuestRequest>('POST', 'host/request', { hostKey, body: { id, status } }),
};

// ---------------------------------------------------------------------------------------------
// État de la soirée, rafraîchi toutes les 5 s
// ---------------------------------------------------------------------------------------------

export function usePartyState(hostKey?: string) {
  const [state, setState] = useState<PartyState | null>(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<ApiError | null>(null);
  const inflight = useRef(false);

  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const s = await api.state(hostKey);
      setState(s);
      setOffline(false);
      setAuthError(null);
    } catch (e) {
      if (e instanceof ApiError && !e.offline) setAuthError(e);
      else setOffline(true);
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, [hostKey]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 5000);
    const onVis = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', onVis);
    };
  }, [refresh]);

  /** Applique localement une nouvelle foule (réponse d'un vote) sans attendre le prochain tour. */
  const setCrowd = useCallback((crowd: CrowdState) => {
    setState((s) => (s ? { ...s, crowd } : s));
  }, []);

  return { state, setState, setCrowd, offline, loading, authError, refresh };
}

// ---------------------------------------------------------------------------------------------
// Message éphémère
// ---------------------------------------------------------------------------------------------

export type Toast = { kind: 'ok' | 'err'; text: string; id: number };

export function useToast() {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback((kind: Toast['kind'], text: string) => {
    window.clearTimeout(timer.current);
    setToast({ kind, text, id: Date.now() });
    timer.current = window.setTimeout(() => setToast(null), 3800);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { toast, show };
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return 'Quelque chose a coincé. Réessaie.';
}
