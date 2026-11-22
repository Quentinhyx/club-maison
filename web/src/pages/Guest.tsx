import { useEffect, useMemo, useRef, useState } from 'react';
import { GENRES, GENRE_LABELS, type EnergyVote, type Genre, type GuestRequest, type TrackRef } from '../../../shared/contracts';
import { api, ApiError, currentParty, errorText, lsGet, lsSet, usePartyState, useToast } from '../api';
import { Cover, isLive, PlayIcon, Section, StatusChip, ToastView, TopBar, TrackLine, fmtDuration } from '../ui';

const party = currentParty();
const VOTE_KEY = `cm.vote.${party}`;
const REQ_KEY = `cm.myRequests.${party}`;
const NAME_KEY = 'cm.guestName';
const ENERGY_KEY = `cm.energyAt.${party}`;
const ENERGY_COOLDOWN_MS = 30_000;

function loadMyRequests(): GuestRequest[] {
  try {
    const v = JSON.parse(lsGet(REQ_KEY) ?? '[]');
    return Array.isArray(v) ? v.slice(-20) : [];
  } catch { return []; }
}

export function GuestPage() {
  const { state, setCrowd, offline, loading } = usePartyState();
  const { toast, show } = useToast();
  const crowd = state?.crowd;
  const np = state?.nowPlaying;
  const host = crowd?.host;

  // ---- Vote de genre
  const [myGenre, setMyGenre] = useState<Genre | null>(() => (lsGet(VOTE_KEY) as Genre | null));
  const [busyGenre, setBusyGenre] = useState<Genre | null>(null);
  const visibleGenres = useMemo(() => GENRES.filter((g) => !host?.blockedGenres.includes(g)), [host]);
  const maxWeight = useMemo(
    () => Math.max(0.0001, ...Object.values(crowd?.genreWeights ?? {}).map((w) => w ?? 0)),
    [crowd],
  );

  async function vote(g: Genre) {
    if (busyGenre) return;
    setBusyGenre(g);
    try {
      const c = await api.vote(g);
      setCrowd(c);
      setMyGenre(g);
      lsSet(VOTE_KEY, g);
      show('ok', g === myGenre ? `Vote relancé : ${GENRE_LABELS[g]}.` : `C'est noté : ${GENRE_LABELS[g]}.`);
    } catch (e) {
      show('err', errorText(e));
    } finally {
      setBusyGenre(null);
    }
  }

  // ---- Énergie
  const [energyAt, setEnergyAt] = useState<number>(() => Number(lsGet(ENERGY_KEY)) || 0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const cooldown = Math.max(0, Math.ceil((energyAt + ENERGY_COOLDOWN_MS - now) / 1000));

  async function energy(v: EnergyVote) {
    if (cooldown > 0) return;
    try {
      const c = await api.energy(v);
      setCrowd(c);
      const t = Date.now();
      setEnergyAt(t);
      lsSet(ENERGY_KEY, String(t));
      show('ok', v > 0 ? 'Message passé : ça monte.' : 'Message passé : on respire.');
    } catch (e) {
      if (e instanceof ApiError && e.retryAfter) {
        const t = Date.now() - ENERGY_COOLDOWN_MS + e.retryAfter * 1000;
        setEnergyAt(t);
        lsSet(ENERGY_KEY, String(t));
      }
      show('err', errorText(e));
    }
  }

  // ---- Demandes
  const [name, setName] = useState(() => lsGet(NAME_KEY) ?? '');
  const [mine, setMine] = useState<GuestRequest[]>(loadMyRequests);
  useEffect(() => { lsSet(NAME_KEY, name.trim() || null); }, [name]);

  // Mise à jour des statuts depuis l'état serveur.
  const mineLive = useMemo(() => {
    const byId = new Map((crowd?.requests ?? []).map((r) => [r.id, r]));
    return mine.map((r) => byId.get(r.id) ?? r).slice().reverse();
  }, [crowd, mine]);

  const takenIds = useMemo(() => {
    const s = new Set<number>();
    for (const r of crowd?.requests ?? []) if (r.status === 'pending' || r.status === 'accepted') s.add(r.track.id);
    return s;
  }, [crowd]);
  const myIds = useMemo(() => new Set(mineLive.filter((r) => r.status !== 'rejected').map((r) => r.track.id)), [mineLive]);

  async function propose(t: TrackRef) {
    try {
      const r = await api.request(t, name.trim() || undefined);
      const next = [...mine, r].slice(-20);
      setMine(next);
      lsSet(REQ_KEY, JSON.stringify(next));
      show('ok', 'Proposé. Le DJ jette une oreille.');
    } catch (e) {
      show('err', errorText(e));
    }
  }

  const live = isLive(np?.updatedAt, !!np?.current);
  const requestsOpen = !!host && host.requestsOpen && host.maxRequestsPerGuest > 0;
  const votesOpen = !host || host.votesOpen;
  const disabled = offline || !state;

  return (
    <div className="page page--guest">
      <TopBar party={party} offline={offline} live={live} />

      {offline ? (
        <div className="banner banner--off">
          <strong>Hors ligne.</strong> La piste ne répond pas pour l'instant. On réessaie toutes les 5 secondes.
        </div>
      ) : null}

      <section className="hero">
        <p className="eyebrow">Ce soir, c'est toi qui choisis</p>
        <h1 className="hero__title">Donne le ton.</h1>
      </section>

      {/* ---- Ce qui passe */}
      <Section title="Sur la piste" aside={np?.genre ? <span className="mono muted">{GENRE_LABELS[np.genre]}</span> : null}>
        <div className="now">
          {np?.current ? (
            <div className="now__current">
              <Cover track={np.current} size={88} />
              <div className="now__text">
                <span className="label">{live ? <><span className="dot dot--live" />Maintenant</> : 'Dernier passage'}</span>
                <div className="now__title">{np.current.title}</div>
                <div className="now__artist">{np.current.artist}</div>
                {np.current.bpm ? <div className="mono muted small">{Math.round(np.current.bpm)} BPM</div> : null}
              </div>
            </div>
          ) : (
            <div className="empty">
              {loading ? 'Connexion à la piste…' : offline ? 'Rien à afficher hors ligne.' : 'Le DJ chauffe les platines. Premier son dans un instant.'}
            </div>
          )}
          {np?.next ? (
            <div className="now__next">
              <span className="label">Ensuite</span>
              <TrackLine track={np.next} size={40} />
            </div>
          ) : null}
        </div>
      </Section>

      {/* ---- Genres */}
      <Section
        title="L'ambiance"
        aside={myGenre && !host?.blockedGenres.includes(myGenre) ? <span className="mono accent">Ton vote : {GENRE_LABELS[myGenre]}</span> : <span className="muted small">Un vote, tu peux changer</span>}
      >
        {host?.forcedGenre ? (
          <p className="note">L'hôte a pris la main : <strong>{GENRE_LABELS[host.forcedGenre]}</strong> pour le moment. Ton vote compte pour la suite.</p>
        ) : null}
        {!votesOpen ? <p className="note">Les votes sont fermés pour l'instant.</p> : null}
        <div className="genres">
          {visibleGenres.map((g) => {
            const w = crowd?.genreWeights[g] ?? 0;
            const active = g === myGenre;
            return (
              <button
                key={g}
                type="button"
                className={`genre ${active ? 'genre--active' : ''}`}
                aria-pressed={active}
                disabled={disabled || !votesOpen || busyGenre !== null}
                onClick={() => vote(g)}
              >
                <span className="genre__label">{GENRE_LABELS[g]}</span>
                <span className="genre__bar" aria-hidden><span style={{ width: `${Math.round((w / maxWeight) * 100)}%` }} /></span>
              </button>
            );
          })}
        </div>
      </Section>

      {/* ---- Énergie */}
      <Section title="L'énergie" aside={cooldown > 0 ? <span className="mono muted">Revote dans {cooldown} s</span> : null}>
        <EnergyMeter value={crowd?.energy ?? 0} />
        <div className="energy">
          <button type="button" className="btn btn--ghost btn--xl" disabled={disabled || !votesOpen || cooldown > 0} onClick={() => energy(-1)}>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden><path d="M5 9l7 7 7-7" fill="none" stroke="currentColor" strokeWidth="2.2" /></svg>
            Calme le jeu
          </button>
          <button type="button" className="btn btn--primary btn--xl" disabled={disabled || !votesOpen || cooldown > 0} onClick={() => energy(1)}>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden><path d="M5 15l7-7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" /></svg>
            Fais monter
          </button>
        </div>
      </Section>

      {/* ---- Proposer un son */}
      <Section title="Propose ton son" aside={host ? <span className="mono muted">{host.maxRequestsPerGuest} max</span> : null}>
        {!requestsOpen && host ? <p className="note">Les demandes sont fermées pour l'instant. Reviens un peu plus tard.</p> : null}
        <label className="field">
          <span className="field__label">Ton prénom <span className="muted">(facultatif)</span></span>
          <input className="input" value={name} maxLength={24} autoComplete="given-name" placeholder="Pour que le DJ sache à qui il fait plaisir" onChange={(e) => setName(e.target.value)} />
        </label>
        <Search
          disabled={disabled || (!!host && !requestsOpen)}
          takenIds={takenIds}
          myIds={myIds}
          blockedIds={host?.blockedTrackIds ?? []}
          onPropose={propose}
          onError={(m) => show('err', m)}
        />
      </Section>

      {/* ---- Mes demandes */}
      {mineLive.length ? (
        <Section title="Mes demandes">
          <ul className="list">
            {mineLive.map((r) => (
              <li key={r.id} className="list__item">
                <TrackLine track={r.track} size={44}><StatusChip status={r.status} /></TrackLine>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <footer className="foot muted small">
        Le DJ tient compte des votes à chaque enchaînement. Pas de panique si ça ne change pas tout de suite.
      </footer>
      <ToastView toast={toast} />
    </div>
  );
}

function EnergyMeter({ value }: { value: number }) {
  const v = Math.max(-1, Math.min(1, value));
  const pct = Math.abs(v) * 50;
  const word = v > 0.5 ? 'Ça chauffe' : v > 0.15 ? 'Ça monte' : v < -0.5 ? 'On souffle' : v < -0.15 ? 'On redescend' : 'Équilibre';
  return (
    <div className="meter" role="meter" aria-valuemin={-1} aria-valuemax={1} aria-valuenow={v} aria-label="Énergie demandée">
      <div className="meter__track">
        <span className="meter__mid" />
        <span className={`meter__fill ${v >= 0 ? 'meter__fill--up' : 'meter__fill--down'}`} style={v >= 0 ? { left: '50%', width: `${pct}%` } : { right: '50%', width: `${pct}%` }} />
      </div>
      <div className="meter__legend">
        <span className="muted small">Calme</span>
        <span className="mono small">{word}</span>
        <span className="muted small">Intense</span>
      </div>
    </div>
  );
}

function Search({ disabled, takenIds, myIds, blockedIds, onPropose, onError }: {
  disabled: boolean;
  takenIds: Set<number>;
  myIds: Set<number>;
  blockedIds: number[];
  onPropose: (t: TrackRef) => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<TrackRef[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [sending, setSending] = useState<number | null>(null);
  const [playing, setPlaying] = useState<number | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const seq = useRef(0);

  useEffect(() => () => { audio.current?.pause(); }, []);

  async function run(query: string) {
    const term = query.trim();
    if (term.length < 2) { setResults(null); return; }
    const my = ++seq.current;
    setSearching(true);
    try {
      const r = await api.search(term);
      if (my === seq.current) setResults(r);
    } catch (e) {
      if (my === seq.current) { setResults(null); onError(errorText(e)); }
    } finally {
      if (my === seq.current) setSearching(false);
    }
  }

  useEffect(() => {
    if (disabled) return;
    const id = window.setTimeout(() => void run(q), 450);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, disabled]);

  function toggle(t: TrackRef) {
    if (!t.preview) return;
    if (playing === t.id) { audio.current?.pause(); setPlaying(null); return; }
    if (!audio.current) {
      audio.current = new Audio();
      audio.current.addEventListener('ended', () => setPlaying(null));
    }
    audio.current.src = t.preview;
    audio.current.volume = 0.8;
    audio.current.play().then(() => setPlaying(t.id)).catch(() => { setPlaying(null); onError("Impossible de lire l'extrait."); });
  }

  async function send(t: TrackRef) {
    setSending(t.id);
    try { await onPropose(t); } finally { setSending(null); }
  }

  return (
    <div className="search">
      <form className="search__form" role="search" onSubmit={(e) => { e.preventDefault(); void run(q); }}>
        <svg className="search__icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="2" /></svg>
        <input
          className="input input--search"
          type="search"
          inputMode="search"
          enterKeyHint="search"
          placeholder={disabled ? 'Recherche indisponible' : 'Titre, artiste…'}
          value={q}
          maxLength={100}
          disabled={disabled}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Rechercher un morceau sur Deezer"
        />
        {searching ? <span className="search__spin mono muted">…</span> : null}
      </form>

      {results && results.length === 0 && !searching ? <p className="empty">Rien trouvé. Essaie avec l'artiste.</p> : null}

      {results?.length ? (
        <ul className="list">
          {results.map((t) => {
            const isMine = myIds.has(t.id);
            const taken = takenIds.has(t.id);
            const blocked = blockedIds.includes(t.id);
            return (
              <li key={t.id} className="list__item">
                <TrackLine track={t} size={48} meta={fmtDuration(t.duration)}>
                  {t.preview ? (
                    <button type="button" className={`icon-btn ${playing === t.id ? 'icon-btn--on' : ''}`} onClick={() => toggle(t)} aria-label={playing === t.id ? "Couper l'extrait" : "Écouter l'extrait"}>
                      <PlayIcon playing={playing === t.id} />
                    </button>
                  ) : null}
                  {isMine ? (
                    <span className="chip chip--accepted">Proposé</span>
                  ) : taken ? (
                    <span className="chip">Déjà demandé</span>
                  ) : blocked ? (
                    <span className="chip">Pas ce soir</span>
                  ) : (
                    <button type="button" className="btn btn--primary btn--sm" disabled={disabled || sending !== null} onClick={() => send(t)}>
                      {sending === t.id ? '…' : 'Proposer'}
                    </button>
                  )}
                </TrackLine>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
