import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { DEFAULT_PARTY } from '../../../shared/contracts';
import { currentParty } from '../api';

type Paper = 'A4' | 'A5';

/** Échappe les caractères spéciaux du format WIFI: (\ ; , : "). */
function wifiEscape(s: string): string {
  return s.replace(/([\\;,:"])/g, '\\$1');
}

function useQrSvg(text: string | null): string {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    if (!text) { setSvg(''); return; }
    let alive = true;
    QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 0, color: { dark: '#000000', light: '#ffffff' } })
      .then((s) => { if (alive) setSvg(s); })
      .catch(() => { if (alive) setSvg(''); });
    return () => { alive = false; };
  }, [text]);
  return svg;
}

export function QrPage() {
  const [party, setParty] = useState(currentParty());
  const [paper, setPaper] = useState<Paper>('A5');
  const [ssid, setSsid] = useState('');
  const [wifiPass, setWifiPass] = useState('');
  const [wifiOpen, setWifiOpen] = useState(false);

  const cleanParty = /^[a-z0-9][a-z0-9-]{0,31}$/.test(party) ? party : DEFAULT_PARTY;
  const guestUrl = useMemo(() => {
    const u = new URL('/', window.location.origin);
    u.searchParams.set('party', cleanParty);
    return u.toString();
  }, [cleanParty]);

  // Généré ici, dans le navigateur ; rien n'est envoyé au serveur.
  const wifiText = ssid.trim()
    ? `WIFI:T:${wifiPass ? 'WPA' : 'nopass'};S:${wifiEscape(ssid.trim())};${wifiPass ? `P:${wifiEscape(wifiPass)};` : ''};`
    : null;

  const mainSvg = useQrSvg(guestUrl);
  const wifiSvg = useQrSvg(wifiText);

  useEffect(() => {
    document.title = 'Club Maison · QR à imprimer';
  }, []);

  return (
    <div className={`qr-page qr-page--${paper.toLowerCase()}`}>
      <style>{`@media print { @page { size: ${paper} portrait; margin: 0; } }`}</style>

      <div className="qr-controls no-print">
        <div className="qr-controls__row">
          <span className="wordmark wordmark--sm">Club Maison</span>
          <a className="btn btn--ghost btn--sm" href={`/hote?party=${cleanParty}`}>Espace hôte</a>
        </div>
        <label className="field">
          <span className="field__label">Nom de la soirée</span>
          <input className="input mono" value={party} maxLength={32} onChange={(e) => setParty(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} />
        </label>
        <div className="field">
          <span className="field__label">Format</span>
          <div className="seg" role="radiogroup" aria-label="Format de papier">
            {(['A5', 'A4'] as Paper[]).map((p) => (
              <button key={p} type="button" role="radio" aria-checked={paper === p} className={`seg__btn ${paper === p ? 'seg__btn--on' : ''}`} onClick={() => setPaper(p)}>{p}</button>
            ))}
          </div>
        </div>
        <button type="button" className={`disclosure ${wifiOpen ? 'disclosure--open' : ''}`} aria-expanded={wifiOpen} onClick={() => setWifiOpen(!wifiOpen)}>
          Ajouter le Wi-Fi <span className="muted">(facultatif)</span>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
        </button>
        {wifiOpen ? (
          <div className="wifi-fields">
            <label className="field">
              <span className="field__label">Nom du réseau (SSID)</span>
              <input className="input" value={ssid} autoComplete="off" onChange={(e) => setSsid(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">Mot de passe</span>
              <input className="input" value={wifiPass} autoComplete="off" type="text" onChange={(e) => setWifiPass(e.target.value)} />
            </label>
            <p className="muted small">Le QR Wi-Fi est fabriqué sur cet appareil. Rien n'est envoyé ni enregistré.</p>
          </div>
        ) : null}
        <button type="button" className="btn btn--primary btn--xl btn--block" onClick={() => window.print()}>Imprimer</button>
      </div>

      <div className="sheet-wrap">
        <article className={wifiSvg ? 'sheet sheet--wifi' : 'sheet'} aria-label="Affiche à imprimer">
          <header className="sheet__head">
            <span className="sheet__kicker">Ce soir à la maison</span>
            <h1 className="sheet__title">Club<br />Maison</h1>
          </header>

          <div className="sheet__qr" dangerouslySetInnerHTML={{ __html: mainSvg }} />

          <p className="sheet__tagline">Scanne, choisis l'ambiance, propose ton son.</p>
          <p className="sheet__url">{guestUrl.replace(/^https?:\/\//, '')}</p>

          {wifiSvg ? (
            <div className="sheet__wifi">
              <div className="sheet__wifi-qr" dangerouslySetInnerHTML={{ __html: wifiSvg }} />
              <div className="sheet__wifi-text">
                <span className="sheet__kicker">Wi-Fi</span>
                <strong>{ssid.trim()}</strong>
                <span>Scanne pour te connecter</span>
              </div>
            </div>
          ) : null}

          <footer className="sheet__foot">
            <span>Votes</span><span>Énergie</span><span>Demandes</span>
          </footer>
        </article>
      </div>
    </div>
  );
}
