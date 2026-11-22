import { GuestPage } from './pages/Guest';
import { HostPage } from './pages/Host';
import { QrPage } from './pages/Qr';

/** Routage minimal sur location.pathname (vercel.json renvoie tout vers index.html hors /api). */
export function App() {
  const path = window.location.pathname.replace(/\/+$/, '').toLowerCase();
  if (path === '/hote' || path === '/host') return <HostPage />;
  if (path === '/qr') return <QrPage />;
  return <GuestPage />;
}
