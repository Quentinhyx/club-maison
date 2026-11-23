/**
 * Client de l'API Vercel des invités (routes décrites en bas de shared/contracts.ts).
 */
import type { GuestRequest, HostSettings, NowPlaying, PartyState } from '../../../shared/contracts';

export interface GuestApiLike {
  getState(): Promise<PartyState>;
  postNowPlaying(np: NowPlaying): Promise<void>;
  setRequestStatus(id: string, status: GuestRequest['status']): Promise<void>;
  setHostSettings?(s: Partial<HostSettings>): Promise<void>;
}

export class GuestApi implements GuestApiLike {
  private base: string;
  constructor(
    apiUrl: string,
    private hostKey: string,
    private party: string,
    private fetcher: typeof fetch = (...a) => fetch(...a),
  ) {
    this.base = apiUrl.replace(/\/+$/, '');
  }

  private url(path: string): string {
    const sep = path.includes('?') ? '&' : '?';
    return `${this.base}${path}${sep}party=${encodeURIComponent(this.party)}`;
  }

  /** fetch avec délai de 8 s et messages d'erreur lisibles. */
  private async call(path: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetcher(this.url(path), { ...init, signal: timeoutSignal(8000) });
    } catch (e) {
      const name = (e as Error)?.name;
      throw new Error(name === 'TimeoutError' || name === 'AbortError' ? 'API invités : pas de réponse (8 s)' : 'API invités injoignable (réseau)');
    }
    if (!res.ok) throw new Error(apiErrorMessage(res.status));
    return res;
  }

  private async post(path: string, body: unknown): Promise<any> {
    const res = await this.call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-host-key': this.hostKey },
      body: JSON.stringify(body),
    });
    return res.json().catch(() => null);
  }

  async getState(): Promise<PartyState> {
    const res = await this.call('/api/state', { headers: { accept: 'application/json' } });
    return (await res.json()) as PartyState;
  }

  async postNowPlaying(np: NowPlaying): Promise<void> {
    await this.post('/api/host/now-playing', np);
  }

  async setRequestStatus(id: string, status: GuestRequest['status']): Promise<void> {
    await this.post('/api/host/request', { id, status });
  }

  async setHostSettings(s: Partial<HostSettings>): Promise<void> {
    await this.post('/api/host/settings', s);
  }
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
}

/** Message affiché dans l'onglet Invités selon le code HTTP. */
export function apiErrorMessage(status: number): string {
  if (status === 401 || status === 403) return 'Clé hôte refusée : vérifie la clé dans Réglages.';
  if (status === 503) return 'HOST_KEY manquante sur Vercel : ajoute la variable d’environnement puis redéploie.';
  if (status === 404) return 'API invités introuvable : vérifie l’adresse dans Réglages.';
  if (status >= 500) return `API invités en panne (HTTP ${status}).`;
  return `API invités : HTTP ${status}.`;
}

export function qrPageUrl(apiUrl: string, party: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/qr?party=${encodeURIComponent(party)}`;
}
