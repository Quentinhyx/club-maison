import type { ReactNode } from 'react';
import type { GuestRequest, TrackRef } from '../../shared/contracts';
import type { Toast } from './api';

export function Wordmark({ small = false }: { small?: boolean }) {
  return <span className={small ? 'wordmark wordmark--sm' : 'wordmark'}>Club Maison</span>;
}

export function TopBar({ party, offline, live, right, compact }: { party: string; offline: boolean; live?: boolean; right?: ReactNode; compact?: boolean }) {
  return (
    <header className={compact ? 'topbar topbar--compact' : 'topbar'}>
      <div className="topbar__brand">
        <Wordmark small />
        <span className="mono muted topbar__party">{party}</span>
      </div>
      <div className="topbar__right">
        {offline ? (
          <span className="pill pill--off"><span className="dot dot--off" />Hors ligne</span>
        ) : live ? (
          <span className="pill pill--live"><span className="dot dot--live" />En direct</span>
        ) : null}
        {right}
      </div>
    </header>
  );
}

export function Cover({ track, size = 56 }: { track?: TrackRef; size?: number }) {
  return track?.cover ? (
    <img className="cover" src={track.cover} alt="" width={size} height={size} loading="lazy" />
  ) : (
    <span className="cover cover--empty" style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 24 24" width={size * 0.42} height={size * 0.42}>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="12" cy="12" r="2" fill="currentColor" />
      </svg>
    </span>
  );
}

export function fmtDuration(s: number): string {
  if (!s) return '';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`;
}

export function TrackLine({ track, size = 56, meta, children }: { track: TrackRef; size?: number; meta?: ReactNode; children?: ReactNode }) {
  return (
    <div className="track">
      <Cover track={track} size={size} />
      <div className="track__text">
        <div className="track__title">{track.title}</div>
        <div className="track__artist">{track.artist}</div>
        {meta ? <div className="track__meta mono">{meta}</div> : null}
      </div>
      {children ? <div className="track__actions">{children}</div> : null}
    </div>
  );
}

const STATUS_LABEL: Record<GuestRequest['status'], string> = {
  pending: 'En attente', accepted: 'Dans la file', played: 'Passé', rejected: 'Pas ce soir',
};

export function StatusChip({ status }: { status: GuestRequest['status'] }) {
  return <span className={`chip chip--${status}`}>{STATUS_LABEL[status]}</span>;
}

export function PlayIcon({ playing }: { playing: boolean }) {
  return playing ? (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden><rect x="6" y="5" width="4" height="14" fill="currentColor" /><rect x="14" y="5" width="4" height="14" fill="currentColor" /></svg>
  ) : (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden><path d="M7 4.5v15l12-7.5z" fill="currentColor" /></svg>
  );
}

export function ToastView({ toast }: { toast: Toast | null }) {
  return (
    <div className="toast-wrap" aria-live="polite">
      {toast ? <div key={toast.id} className={`toast toast--${toast.kind}`}>{toast.text}</div> : null}
    </div>
  );
}

export function Section({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`section ${className ?? ''}`}>
      <div className="section__head">
        <h2 className="section__title">{title}</h2>
        {aside ? <div className="section__aside">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** "En direct" si l'extension a publié il y a moins de 15 min. */
export function isLive(updatedAt: number | undefined, hasTrack: boolean): boolean {
  return hasTrack && !!updatedAt && Date.now() - updatedAt < 15 * 60_000;
}
