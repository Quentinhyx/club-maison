/**
 * Onglets du bas : file d'attente, journal du DJ, invités, réglages.
 */
import { useEffect, useRef, useState } from 'react';
import { GENRES, GENRE_LABELS, type DeckId, type DjSettings, type Genre, type StyleProfileId, type TrackRef } from '../../../shared/contracts';
import { STYLE_PROFILES } from '../../../shared/brain/index';
import type { ConductorSnapshot } from '../conductor';
import type { Engine } from '../engine';
import { MODE_LABELS } from '../engine';
import { isExtension } from '../lib/env';
import { qrPageUrl } from '../lib/guestApi';
import type { ConsoleSettings, DeckMode } from '../lib/storage';
import { STYLE_LABELS, fmtTime, styleOrder } from './labels';
import { DeezerTabsPanel } from './DeezerTabsPanel';

type Tab = 'queue' | 'log' | 'guests' | 'settings';

interface Props {
  engine: Engine;
  snap: ConductorSnapshot;
  manual: boolean;
  settings: ConsoleSettings;
  onSaveSettings: (s: ConsoleSettings, restart: boolean) => void;
}

export function BottomTabs(p: Props) {
  const [tab, setTab] = useState<Tab>('queue');
  const pending = p.snap.crowd.requests.filter((r) => r.status === 'pending').length;
  return (
    <section className="tabs">
      <nav className="tab-nav" role="tablist">
        {(
          [
            ['queue', `File d’attente`, p.snap.queue.length],
            ['log', 'Journal du DJ', 0],
            ['guests', 'Invités', pending],
            ['settings', 'Réglages', 0],
          ] as Array<[Tab, string, number]>
        ).map(([id, label, n]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {label}
            {n > 0 && <span className="badge">{n}</span>}
          </button>
        ))}
        <span className="tab-meta mono">
          {p.snap.candidates} candidats · {p.snap.analyzing ? `${p.snap.analyzing} en analyse` : 'analyses à jour'}
          {p.snap.currentGenre ? ` · cap : ${GENRE_LABELS[p.snap.currentGenre]}` : ''}
        </span>
      </nav>
      <div className="tab-body">
        {tab === 'queue' && <QueueTab {...p} />}
        {tab === 'log' && <LogTab snap={p.snap} />}
        {tab === 'guests' && <GuestsTab {...p} />}
        {tab === 'settings' && <SettingsTab {...p} />}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------------------------- file

function QueueTab({ engine, snap, manual }: Props) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<TrackRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const run = async (query: string) => {
    setBusy(true);
    setErr('');
    try {
      setRes(await engine.search(query));
    } catch (e) {
      setErr(`Recherche impossible : ${e instanceof Error ? e.message : String(e)}`);
      setRes([]);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (engine.mode === 'synth') void run('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const queued = new Set(snap.queue.map((x) => x.track.id));
  const loadOn = (d: DeckId, t: TrackRef) => void engine.conductor.manualLoad(d, t);
  return (
    <div className="queue">
      <div className="q-search">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(q);
          }}
        >
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={engine.mode === 'synth' ? 'Chercher dans les morceaux démo (titre, artiste, genre)' : 'Chercher sur Deezer (titre, artiste)'}
          />
          <button type="submit" disabled={busy}>
            {busy ? '…' : 'Chercher'}
          </button>
        </form>
        {err && <div className="err">{err}</div>}
        <ul className="list">
          {res.map((t) => (
            <li key={t.id}>
              <TrackLine t={t} />
              <div className="acts">
                {manual && (
                  <>
                    <button onClick={() => loadOn('A', t)}>A</button>
                    <button onClick={() => loadOn('B', t)}>B</button>
                  </>
                )}
                <button disabled={queued.has(t.id)} onClick={() => engine.conductor.addToQueue(t, 'host')}>
                  {queued.has(t.id) ? 'Dans la file' : 'Ajouter'}
                </button>
              </div>
            </li>
          ))}
          {!res.length && !busy && <li className="empty">Lance une recherche pour ajouter des morceaux.</li>}
        </ul>
      </div>
      <div className="q-list">
        <div className="q-head">
          <span>File ({snap.queue.length})</span>
          <span className="dim">passe avant les choix du cerveau, dans l’ordre</span>
        </div>
        <ul className="list">
          {snap.queue.map((it, i) => (
            <li key={it.track.id}>
              <span className="num mono">{String(i + 1).padStart(2, '0')}</span>
              <TrackLine t={it.track} tag={it.source === 'guest' ? `Demande · ${snap.guestNames[it.requestId ?? ''] ?? 'invité'}` : undefined} />
              <div className="acts">
                <button aria-label="Monter" onClick={() => engine.conductor.moveInQueue(it.track.id, -1)} disabled={i === 0}>
                  ↑
                </button>
                <button aria-label="Descendre" onClick={() => engine.conductor.moveInQueue(it.track.id, 1)} disabled={i === snap.queue.length - 1}>
                  ↓
                </button>
                <button aria-label="Retirer" onClick={() => engine.conductor.removeFromQueue(it.track.id)}>
                  Retirer
                </button>
              </div>
            </li>
          ))}
          {!snap.queue.length && <li className="empty">File vide : le cerveau choisit seul dans le catalogue.</li>}
        </ul>
      </div>
    </div>
  );
}

function TrackLine({ t, tag }: { t: TrackRef; tag?: string }) {
  return (
    <div className="tl">
      {t.cover ? <img src={t.cover} alt="" /> : <span className="noimg" />}
      <div className="tl-txt">
        <span className="tl-title">{t.title}</span>
        <span className="tl-sub">
          {t.artist}
          {t.bpm ? ` · ${Math.round(t.bpm)} BPM` : ''} · {fmtTime(t.duration)}
          {t.genres?.length ? ` · ${t.genres.map((g) => GENRE_LABELS[g]).join(', ')}` : ''}
        </span>
      </div>
      {tag && <span className="tag">{tag}</span>}
    </div>
  );
}

// ------------------------------------------------------------------------------------- journal

function LogTab({ snap }: { snap: ConductorSnapshot }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [snap.logs]);
  return (
    <div
      className="log mono"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
      }}
    >
      {snap.logs.map((l, i) => (
        <div key={i} className={`ll ll-${l.level}`}>
          <span className="lt">{new Date(l.t).toLocaleTimeString('fr-FR')}</span>
          <span className="lv">{l.level === 'brain' ? 'DJ' : l.level === 'info' ? 'INFO' : l.level === 'warn' ? 'ALERTE' : 'ERREUR'}</span>
          <span className="lm">{l.msg}</span>
        </div>
      ))}
      {!snap.logs.length && <div className="empty">Le journal se remplit dès que la soirée démarre.</div>}
    </div>
  );
}

// ------------------------------------------------------------------------------------- invités

function GuestsTab({ engine, snap, settings }: Props) {
  const c = snap.crowd;
  const weights = Object.entries(c.genreWeights ?? {}).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)) as Array<[Genre, number]>;
  const max = Math.max(1e-6, ...weights.map((w) => w[1]));
  const pending = c.requests.filter((r) => r.status === 'pending');
  const accepted = c.requests.filter((r) => r.status === 'accepted' || r.status === 'played');
  if (!settings.apiUrl) {
    return (
      <div className="guests empty-state">
        <p>Les invités votent et demandent des sons depuis leur téléphone (QR code).</p>
        <p className="dim">Renseigne l’adresse de l’API invités et ta clé hôte dans l’onglet Réglages pour activer cette partie.</p>
      </div>
    );
  }
  return (
    <div className="guests">
      <div className="g-col">
        <div className="g-head">
          Public{' '}
          <span className={`pill ${snap.guest.ok ? 'ok' : 'ko'}`}>{snap.guest.ok ? 'API connectée' : snap.guest.lastError ? 'API en erreur' : 'connexion…'}</span>
        </div>
        {!snap.guest.ok && snap.guest.lastError && <div className="g-err">{snap.guest.lastError}</div>}
        {snap.guest.storage === 'memory' && <div className="g-err">Base de données non branchée sur Vercel : les votes peuvent se perdre.</div>}
        <div className="energy">
          <span className="lbl">ÉNERGIE DEMANDÉE</span>
          <div className="en-track">
            <div className="en-zero" />
            <div className="en-dot" style={{ left: `calc(${(50 + c.energy * 50).toFixed(0)}% - 5px)` }} />
          </div>
          <span className="mono">{c.energy >= 0 ? '+' : '−'}{Math.abs(c.energy).toFixed(2)}</span>
        </div>
        <div className="g-sub">Votes de genre</div>
        <ul className="bars">
          {weights.slice(0, 8).map(([g, w]) => (
            <li key={g}>
              <span>{GENRE_LABELS[g]}</span>
              <div className="bar">
                <i style={{ width: `${(w / max) * 100}%` }} />
              </div>
              <span className="mono">{w.toFixed(1)}</span>
            </li>
          ))}
          {!weights.length && <li className="empty">Pas encore de vote.</li>}
        </ul>
      </div>
      <div className="g-col">
        <div className="g-head">Demandes en attente ({pending.length})</div>
        <ul className="list">
          {pending.map((r) => (
            <li key={r.id}>
              <TrackLine t={r.track} tag={r.guestName ?? 'invité'} />
              <div className="acts">
                <button onClick={() => void engine.conductor.answerRequest(r, true)}>Accepter</button>
                <button onClick={() => void engine.conductor.answerRequest(r, false)}>Refuser</button>
              </div>
            </li>
          ))}
          {!pending.length && <li className="empty">Aucune demande en attente.</li>}
        </ul>
      </div>
      <div className="g-col">
        <div className="g-head">Acceptées</div>
        <ul className="list">
          {accepted.map((r) => (
            <li key={r.id}>
              <TrackLine t={r.track} tag={r.status === 'played' ? 'jouée' : r.guestName ?? 'invité'} />
            </li>
          ))}
          {!accepted.length && <li className="empty">Les demandes acceptées arrivent dans la file.</li>}
        </ul>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------- réglages

function SettingsTab({ engine, settings, onSaveSettings }: Props) {
  const [s, setS] = useState<ConsoleSettings>(settings);
  const [dj, setDj] = useState<DjSettings>(engine.conductor.getSettings());
  const upd = (patch: Partial<DjSettings>, extra: Partial<ConsoleSettings> = {}) => {
    const next = { ...dj, ...patch };
    setDj(next);
    engine.conductor.setSettings(patch);
    const ns = { ...s, ...extra, dj: next };
    setS(ns);
    onSaveSettings(ns, false);
  };
  const modeChanged = s.deckMode !== engine.mode || s.captureMode !== settings.captureMode;
  // durées validées à la sortie du champ : min >= 30 s, max >= min + 15 s
  const [minTxt, setMinTxt] = useState(String(dj.minPlaySeconds));
  const [maxTxt, setMaxTxt] = useState(String(dj.maxPlaySeconds));
  const commitDurations = () => {
    let mn = Math.round(Number(minTxt));
    let mx = Math.round(Number(maxTxt));
    if (!Number.isFinite(mn)) mn = dj.minPlaySeconds;
    if (!Number.isFinite(mx)) mx = dj.maxPlaySeconds;
    mn = Math.min(600, Math.max(30, mn));
    mx = Math.min(900, Math.max(mn + 15, mx));
    setMinTxt(String(mn));
    setMaxTxt(String(mx));
    if (mn !== dj.minPlaySeconds || mx !== dj.maxPlaySeconds) upd({ minPlaySeconds: mn, maxPlaySeconds: mx });
  };
  return (
    <div className="settings">
      <div className="s-col">
        <div className="s-head">Pilote</div>
        <label>
          Style
          <select value={dj.style} onChange={(e) => upd({ style: e.target.value as StyleProfileId }, { styleTouched: true })}>
            {styleOrder(Object.keys(STYLE_PROFILES) as StyleProfileId[]).map((id) => (
              <option key={id} value={id}>
                {STYLE_LABELS[id] ?? STYLE_PROFILES[id]?.label ?? id}
              </option>
            ))}
          </select>
        </label>
        <p className="hint">{STYLE_PROFILES[dj.style]?.description}</p>
        <label>
          Dosage des effets <span className="mono">{Math.round(dj.fxAmount * 100)} %</span>
          <input type="range" min={0} max={1} step={0.05} value={dj.fxAmount} onChange={(e) => upd({ fxAmount: Number(e.target.value) })} />
        </label>
        <div className="row2">
          <label>
            Durée min (s)
            <input type="number" min={30} max={600} value={minTxt} onChange={(e) => setMinTxt(e.target.value)} onBlur={commitDurations} />
          </label>
          <label>
            Durée max (s)
            <input type="number" min={45} max={900} value={maxTxt} onChange={(e) => setMaxTxt(e.target.value)} onBlur={commitDurations} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={dj.followCrowd} onChange={(e) => upd({ followCrowd: e.target.checked })} />
          Suivre le public (votes et demandes)
        </label>
        <label className="check">
          <input type="checkbox" checked={dj.stingers !== false} onChange={(e) => upd({ stingers: e.target.checked })} />
          Sons d’ambiance (corne, sirène, scratch)
        </label>
        <label>
          Genre de base
          <select value={dj.baseGenre} onChange={(e) => upd({ baseGenre: e.target.value as Genre })}>
            {GENRES.map((g) => (
              <option key={g} value={g}>
                {GENRE_LABELS[g]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="s-col">
        <div className="s-head">Source des platines</div>
        {(Object.keys(MODE_LABELS) as DeckMode[]).map((m) => {
          const disabled = m === 'deezer' && !isExtension;
          return (
            <label key={m} className={`check ${disabled ? 'disabled' : ''}`}>
              <input type="radio" name="mode" disabled={disabled} checked={s.deckMode === m} onChange={() => setS({ ...s, deckMode: m })} />
              {MODE_LABELS[m]}
              {disabled && <span className="dim"> · Disponible dans l’extension Chrome</span>}
            </label>
          );
        })}
        <div className={`s-sub ${isExtension ? '' : 'disabled'}`}>
          Capture du son Deezer {!isExtension && <span className="dim">· Disponible dans l’extension Chrome</span>}
        </div>
        <label className={`check ${isExtension ? '' : 'disabled'}`}>
          <input type="radio" name="cap" disabled={!isExtension} checked={s.captureMode === 'tab'} onChange={() => setS({ ...s, captureMode: 'tab' })} />
          Capture des onglets (recommandé)
        </label>
        <label className={`check ${isExtension ? '' : 'disabled'}`}>
          <input type="radio" name="cap" disabled={!isExtension} checked={s.captureMode === 'device'} onChange={() => setS({ ...s, captureMode: 'device' })} />
          Périphériques BlackHole ({s.deviceLabelA} / {s.deviceLabelB})
        </label>
        {modeChanged && (
          <button className="primary" onClick={() => onSaveSettings({ ...s, dj }, true)}>
            Appliquer (recharge la console)
          </button>
        )}
        <DeezerTabsPanel engine={engine} />
      </div>
      <div className="s-col">
        <div className="s-head">Invités</div>
        <label>
          Adresse de l’API invités
          <input placeholder="https://ton-projet.vercel.app" value={s.apiUrl} onChange={(e) => setS({ ...s, apiUrl: e.target.value.trim() })} />
        </label>
        <div className="row2">
          <label>
            Clé hôte
            <input type="password" value={s.hostKey} onChange={(e) => setS({ ...s, hostKey: e.target.value })} />
          </label>
          <label>
            Soirée
            <input value={s.party} onChange={(e) => setS({ ...s, party: e.target.value.trim() || 'maison' })} />
          </label>
        </div>
        <div className="btns">
          <button className="primary" onClick={() => onSaveSettings({ ...s, dj }, true)}>
            Enregistrer
          </button>
          <button disabled={!s.apiUrl} onClick={() => window.open(qrPageUrl(s.apiUrl, s.party), '_blank')}>
            Ouvrir la page QR à imprimer
          </button>
        </div>
        <p className="hint">Enregistré sur cet ordinateur uniquement{isExtension ? ' (stockage de l’extension)' : ' (navigateur)'}.</p>
      </div>
    </div>
  );
}
