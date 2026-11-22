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

  private async post(path: string, body: unknown): Promise<any> {
    const res = await this.fetcher(this.url(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-host-key': this.hostKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API invités : HTTP ${res.status} sur ${path}`);
    return res.json().catch(() => null);
  }

  async getState(): Promise<PartyState> {
    const res = await this.fetcher(this.url('/api/state'), { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`API invités : HTTP ${res.status}`);
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

export function qrPageUrl(apiUrl: string, party: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/qr?party=${encodeURIComponent(party)}`;
}
