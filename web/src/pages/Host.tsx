import { useMemo, useState } from 'react';
import { GENRES, GENRE_LABELS, type Genre, type GuestRequest, type HostSettings } from '../../../shared/contracts';
import { api, ApiError, currentParty, errorText, lsGet, lsSet, usePartyState, useToast } from '../api';
import { Cover, isLive, Section, ToastView, TopBar, TrackLine, Wordmark } from '../ui';

const party = currentParty();
const KEY_STORAGE = 'cm.hostKey';

export function HostPage() {
  const [hostKey, setHostKey] = useState<string | null>(() => lsGet(KEY_STORAGE));
  if (!hostKey) return <KeyGate onOk={(k) => { lsSet(KEY_STORAGE, k); setHostKey(k); }} />;
  return <Dashboard hostKey={hostKey} onLogout={() => { lsSet(KEY_STORAGE, null); setHostKey(null); }} />;
}

function KeyGate({ onOk }: { onOk: (key: string) => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const k = key.trim();
    if (!k) return;
    setBusy(true);
    setErr(null);
    try {
      await api.hostSettings(k, {});
      onOk(k);
    } catch (e) {
      setErr(e instanceof ApiError && e.offline ? 'Serveur injoignable. Vérifie la connexion ou que l’API tourne.' : errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page page--gate">
      <div className="gate">
        <Wordmark />
        <p className="eyebrow">Espace hôte · <span className="mono">{party}</span></p>
        <form className="gate__form" onSubmit={submit}>
          <label className="field">
            <span className="field__label">Clé hôte</span>
            <input className="input" type="password" autoComplete="current-password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="La valeur de HOST_KEY" autoFocus />
          </label>
          {err ? <p className="form-error" role="alert">{err}</p> : null}
          <button className="btn btn--primary btn--xl btn--block" disabled={busy || !key.trim()}>{busy ? 'Vérification…' : 'Entrer'}</button>
        </form>
        <p className="muted small">La clé reste sur cet appareil. Elle est définie dans les variables d'environnement Vercel.</p>
      </div>
    </div>
  );
}

function Dashboard({ hostKey, onLogout }: { hostKey: string; onLogout: () => void }) {
  const { state, setState, offline, loading, authError, refresh } = usePartyState(hostKey);
  const { toast, show } = useToast();
  const crowd = state?.crowd;
  const host = crowd?.host;
  const np = state?.nowPlaying;
  const [busy, setBusy] = useState<string | null>(null);

  const weights = useMemo(() => {
    const entries = Object.entries(crowd?.genreWeights ?? {}) as Array<[Genre, number]>;
    return entries.filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]);
  }, [crowd]);
  const total = weights.reduce((s, [, w]) => s + w, 0);

  const pending = (crowd?.requests ?? []).filter((r) => r.status === 'pending');
  const accepted = (crowd?.requests ?? []).filter((r) => r.status === 'accepted');

  function patchHost(next: HostSettings) {
    setState((s) => (s ? { ...s, crowd: { ...s.crowd, host: next } } : s));
  }

  async function saveSettings(patch: Partial<Record<keyof HostSettings, unknown>>, msg?: string) {
    try {
      const next = await api.hostSettings(hostKey, patch);
      patchHost(next);
      if (msg) show('ok', msg);
    } catch (e) {
      show('err', errorText(e));
      void refresh();
    }
  }

  async function setStatus(r: GuestRequest, status: GuestRequest['status'], block = false) {
    setBusy(r.id);
    try {
      await api.hostRequest(hostKey, r.id, status);
      if (block && host) {
        await saveSettings({ blockedTrackIds: [...host.blockedTrackIds, r.track.id] });
      }
      show('ok', block ? 'Refusé et bloqué pour la soirée.' : status === 'accepted' ? 'Ajouté à la file.' : status === 'played' ? 'Marqué comme passé.' : 'Refusé.');
      await refresh();
    } catch (e) {
      show('err', errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const unauthorized = authError && (authError.status === 401 || authError.status === 503);

  return (
    <div className="page page--host">
      <TopBar
        party={party}
        compact
        offline={offline}
        live={isLive(np?.updatedAt, !!np?.current)}
        right={<button type="button" className="btn btn--ghost btn--sm" onClick={onLogout}>Sortir</button>}
      />

      {offline ? <div className="banner banner--off"><strong>Hors ligne.</strong> L'API ne répond pas. On réessaie toutes les 5 secondes.</div> : null}
      {state?.storage === 'memory' ? (
        <div className="banner banner--warn">
          <strong>Base de données non branchée :</strong> les votes peuvent se perdre. Ajoute Upstash Redis au projet Vercel.
        </div>
      ) : null}
      {unauthorized ? (
        <div className="banner banner--off">
          <strong>Accès refusé.</strong> {authError!.message} <button type="button" className="link" onClick={onLogout}>Changer de clé</button>
        </div>
      ) : null}

      <section className="hero hero--host">
        <p className="eyebrow">Espace hôte · <span className="accent">{party}</span></p>
        <h1 className="hero__title">La cabine.</h1>
        <div className="hero__links">
          <a className="btn btn--ghost btn--sm" href={`/qr?party=${party}`}>QR à imprimer</a>
          <a className="btn btn--ghost btn--sm" href={`/?party=${party}`}>Page invités</a>
        </div>
      </section>

      <Section title="Sur la piste" aside={np?.genre ? <span className="mono muted">{GENRE_LABELS[np.genre]}</span> : null}>
        {np?.current ? (
          <div className="now__current">
            <Cover track={np.current} size={72} />
            <div className="now__text">
              <div className="now__title">{np.current.title}</div>
              <div className="now__artist">{np.current.artist}</div>
              <div className="mono muted small">{np.current.bpm ? `${Math.round(np.current.bpm)} BPM` : 'BPM inconnu'}</div>
            </div>
          </div>
        ) : (
          <p className="empty">{loading ? 'Chargement…' : "L'extension n'a encore rien publié."}</p>
        )}
        {np?.next ? <div className="now__next"><span className="label">Ensuite</span><TrackLine track={np.next} size={40} /></div> : null}
        {np?.current ? (
          <button
            type="button"
            className="btn btn--primary"
            style={{ width: '100%', marginTop: 16 }}
            onClick={() => saveSettings({ skipAt: Date.now() }, 'Suivant demandé : le DJ enchaîne sur la prochaine mesure.')}
          >
            Suivant
          </button>
        ) : null}
      </Section>

      <Section title="Votes" aside={<span className="mono muted">demi-vie 20 min</span>}>
        {weights.length ? (
          <ul className="bars">
            {weights.map(([g, w]) => (
              <li key={g} className={`bar ${host?.forcedGenre === g ? 'bar--forced' : ''}`}>
                <span className="bar__label">{GENRE_LABELS[g]}</span>
                <span className="bar__track"><span className="bar__fill" style={{ width: `${(w / weights[0][1]) * 100}%` }} /></span>
                <span className="bar__value mono">{Math.round((w / total) * 100)}%</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">Pas encore de vote.</p>
        )}
        <div className="energy-read">
          <span className="label">Énergie demandée</span>
          <span className="mono energy-read__value">{crowd ? `${crowd.energy > 0 ? '+' : ''}${crowd.energy.toFixed(2)}` : '--'}</span>
        </div>
        <div className="meter__track meter__track--host">
          <span className="meter__mid" />
          {crowd ? (
            <span
              className={`meter__fill ${crowd.energy >= 0 ? 'meter__fill--up' : 'meter__fill--down'}`}
              style={crowd.energy >= 0 ? { left: '50%', width: `${crowd.energy * 50}%` } : { right: '50%', width: `${-crowd.energy * 50}%` }}
            />
          ) : null}
        </div>
      </Section>

      <Section title="Demandes" aside={<span className="mono muted">{pending.length} en attente</span>}>
        {pending.length ? (
          <ul className="list">
            {pending.map((r) => (
              <li key={r.id} className="list__item list__item--req">
                <TrackLine track={r.track} size={48} meta={`${r.guestName ?? 'Anonyme'} · ${ago(r.createdAt)}`} />
                <div className="req-actions">
                  <button type="button" className="btn btn--primary btn--sm" disabled={busy === r.id} onClick={() => setStatus(r, 'accepted')}>Accepter</button>
                  <button type="button" className="btn btn--ghost btn--sm" disabled={busy === r.id} onClick={() => setStatus(r, 'rejected')}>Refuser</button>
                  <button type="button" className="btn btn--ghost btn--sm btn--danger" disabled={busy === r.id} onClick={() => setStatus(r, 'rejected', true)}>Bloquer</button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">Aucune demande en attente.</p>
        )}
        {accepted.length ? (
          <>
            <h3 className="subhead">Dans la file</h3>
            <ul className="list">
              {accepted.map((r) => (
                <li key={r.id} className="list__item">
                  <TrackLine track={r.track} size={40} meta={r.guestName ?? 'Anonyme'}>
                    <button type="button" className="btn btn--ghost btn--sm" disabled={busy === r.id} onClick={() => setStatus(r, 'played')}>Passé</button>
                    <button type="button" className="btn btn--ghost btn--sm" disabled={busy === r.id} onClick={() => setStatus(r, 'rejected')}>Retirer</button>
                  </TrackLine>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </Section>

      {host ? (
        <Section title="Réglages">
          <div className="settings">
            <Toggle label="Votes ouverts" on={host.votesOpen} onChange={(v) => saveSettings({ votesOpen: v }, v ? 'Votes ouverts.' : 'Votes fermés.')} />
            <Toggle label="Demandes ouvertes" on={host.requestsOpen} onChange={(v) => saveSettings({ requestsOpen: v }, v ? 'Demandes ouvertes.' : 'Demandes fermées.')} />
            <div className="setting">
              <span className="setting__label">Demandes en attente par invité</span>
              <div className="stepper">
                <button type="button" className="icon-btn" aria-label="Moins" disabled={host.maxRequestsPerGuest <= 0} onClick={() => saveSettings({ maxRequestsPerGuest: host.maxRequestsPerGuest - 1 })}>-</button>
                <span className="mono stepper__value">{host.maxRequestsPerGuest}</span>
                <button type="button" className="icon-btn" aria-label="Plus" disabled={host.maxRequestsPerGuest >= 20} onClick={() => saveSettings({ maxRequestsPerGuest: host.maxRequestsPerGuest + 1 })}>+</button>
              </div>
            </div>
            <label className="setting setting--col">
              <span className="setting__label">Genre forcé</span>
              <select
                className="input select"
                value={host.forcedGenre ?? ''}
                onChange={(e) => saveSettings({ forcedGenre: e.target.value || null }, e.target.value ? `Cap sur ${GENRE_LABELS[e.target.value as Genre]}.` : 'Le public reprend la main.')}
              >
                <option value="">Aucun : le public décide</option>
                {GENRES.map((g) => <option key={g} value={g}>{GENRE_LABELS[g]}</option>)}
              </select>
            </label>
            <div className="setting setting--col">
              <span className="setting__label">Genres bloqués <span className="muted">(masqués chez les invités)</span></span>
              <div className="tags">
                {GENRES.map((g) => {
                  const on = host.blockedGenres.includes(g);
                  return (
                    <button
                      key={g}
                      type="button"
                      className={`tag ${on ? 'tag--blocked' : ''}`}
                      aria-pressed={on}
                      onClick={() => saveSettings({ blockedGenres: on ? host.blockedGenres.filter((x) => x !== g) : [...host.blockedGenres, g] })}
                    >
                      {GENRE_LABELS[g]}
                    </button>
                  );
                })}
              </div>
            </div>
            {host.blockedTrackIds.length ? (
              <div className="setting">
                <span className="setting__label">{host.blockedTrackIds.length} morceau{host.blockedTrackIds.length > 1 ? 'x' : ''} bloqué{host.blockedTrackIds.length > 1 ? 's' : ''}</span>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => saveSettings({ blockedTrackIds: [] }, 'Morceaux débloqués.')}>Tout débloquer</button>
              </div>
            ) : null}
          </div>
        </Section>
      ) : null}

      <ToastView toast={toast} />
    </div>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className="setting setting--toggle" role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <span className="setting__label">{label}</span>
      <span className={`switch ${on ? 'switch--on' : ''}`} aria-hidden><span /></span>
    </button>
  );
}

function ago(t: number): string {
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return "à l'instant";
  if (m < 60) return `il y a ${m} min`;
  return `il y a ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}
