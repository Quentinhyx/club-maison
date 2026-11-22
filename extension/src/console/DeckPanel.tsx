/**
 * Une platine : plateau qui tourne (33 tours, ralentit au frein), pochette, BPM, tonalité, temps,
 * section, compteur de temps 1-2-3-4, position dans la phrase. Animé à 60 i/s hors React.
 */
import { useEffect, useRef } from 'react';
import type { DeckId, TrackRef } from '../../../shared/contracts';
import type { Engine } from '../engine';
import { getFrame, useFrame } from './frame';
import { SECTION_LABELS, STATUS_LABELS, camelotColor, fmtPct, fmtTime } from './labels';

const RPS = 33.333 / 60; // tours par seconde à vitesse 1

interface Props {
  engine: Engine;
  id: DeckId;
  manual: boolean;
  onLoadNext: (id: DeckId) => void;
  connectError?: string;
}

export function DeckPanel({ engine, id, manual, onLoadNext, connectError }: Props) {
  const jog = useRef<HTMLCanvasElement>(null);
  const els = useRef<Record<string, HTMLElement | null>>({});
  const set = (k: string) => (el: HTMLElement | null) => {
    els.current[k] = el;
  };
  const anim = useRef({ angle: 0, last: 0, speed: 0, beat: -999, cover: undefined as HTMLImageElement | undefined, coverUrl: '' });

  useEffect(() => {
    const cv = jog.current!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const ro = new ResizeObserver(() => {
      const r = cv.getBoundingClientRect();
      cv.width = Math.round(r.width * dpr);
      cv.height = Math.round(r.height * dpr);
    });
    ro.observe(cv);
    return () => ro.disconnect();
  }, []);

  useFrame((t) => {
    const f = getFrame(engine, t);
    const v = f.views[id];
    const st = v.state;
    const a = anim.current;
    const dt = a.last ? Math.min(0.1, (t - a.last) / 1000) : 0;
    a.last = t;

    // vitesse du plateau : suit la lecture, ralentit au frein
    let target = v.playing ? v.rate : 0;
    const brake = brakeFactor(f, id);
    if (brake !== undefined) target *= brake;
    const k = v.playing && brake === undefined ? 0.25 : 0.12;
    a.speed += (target - a.speed) * Math.min(1, k * dt * 60);
    a.angle = (a.angle + a.speed * RPS * dt * Math.PI * 2) % (Math.PI * 2);
    drawJog(jog.current, a, st.track, st.duration ? v.pos / st.duration : 0, f.onAir === id, id);

    const e = els.current;
    const txt = (key: string, s: string) => {
      const el = e[key];
      if (el && el.textContent !== s) el.textContent = s;
    };
    const tr = st.track;
    txt('title', tr?.title ?? 'Platine vide');
    txt('artist', tr ? tr.artist : manual ? 'Charge un morceau depuis la file' : 'Le pilote va charger un morceau');
    const bpmNow = v.grid ? v.grid.bpm * v.rate : st.analysis?.bpm ? st.analysis.bpm * v.rate : 0;
    txt('bpm', bpmNow ? bpmNow.toFixed(1) : '—');
    const bpmOrig = v.grid ? v.grid.bpm : st.analysis?.bpm ?? 0;
    txt('orig', bpmOrig ? `ORIGINE ${bpmOrig.toFixed(1)}` : 'ORIGINE —');
    txt('pct', fmtPct(v.rate));
    const range = Math.max(0.08, st.caps.maxRateDelta || 0.08);
    if (e.pitchCap) e.pitchCap.style.top = `calc(${(50 - ((v.rate - 1) / range) * 50).toFixed(1)}% - 4px)`;
    if (e.pitch) e.pitch.dataset.off = Math.abs(v.rate - 1) > 0.0005 ? '1' : '0';
    txt('range', `±${Math.round(range * 100)}`);
    const gr = engine.conductor.getGroove();
    const reEdit = !!gr && gr.plan.deck === id && (gr.endCtx === undefined || f.now < gr.endCtx);
    if (e.reedit) e.reedit.dataset.on = reEdit ? '1' : '0';
    const key = st.analysis?.key;
    txt('key', key ?? '—');
    if (e.key) e.key.style.color = camelotColor(key);
    txt('elapsed', fmtTime(v.pos, true));
    txt('remain', `−${fmtTime(Math.max(0, (st.duration || 0) - v.pos), true)}`);
    const section = st.live?.section && st.live.section !== 'unknown' ? SECTION_LABELS[st.live.section] : v.playing ? '…' : '—';
    txt('section', section);
    if (e.section) e.section.dataset.sec = st.live?.section ?? 'unknown';
    txt('status', st.status === 'error' ? `ERREUR` : STATUS_LABELS[st.status]);
    if (e.status) e.status.dataset.st = st.status;
    txt('error', st.error ?? connectError ?? '');
    const live = f.onAir === id;
    if (e.root) e.root.dataset.live = live ? '1' : '0';

    // compteur de temps et phrase
    const inBar = ((v.beat % 4) + 4) % 4;
    const inPhrase = ((v.beat % 32) + 32) % 32;
    if (e.beats) {
      const kids = e.beats.children;
      for (let i = 0; i < 4; i++) {
        const on = v.grid && v.playing ? i === inBar : false;
        const el = kids[i] as HTMLElement;
        const flash = on && v.beatFrac < 0.18;
        el.dataset.on = on ? (flash ? '2' : '1') : '0';
      }
    }
    txt('phrase', v.grid ? `${String(inPhrase + 1).padStart(2, '0')}/32` : '--/32');
    txt('bar', v.grid ? `M${Math.floor(Math.max(0, v.beat) / 4) + 1}` : '');
  });

  return (
    <section className={`deck deck-${id}`} ref={set('root')} data-live="0">
      <div className="deck-top">
          <div className="deck-head">
            <span className="deck-letter">{id}</span>
            <span className="deck-status" ref={set('status')}>VIDE</span>
            <span className="section" ref={set('section')} data-sec="unknown">—</span>
            <span className="deck-reedit" ref={set('reedit')} data-on="0">RE-EDIT</span>
            <span className="deck-onair">EN DIRECT</span>
          </div>
          <div className="deck-title" ref={set('title')} />
          <div className="deck-artist" ref={set('artist')} />
      </div>
      <div className="deck-jog">
        <canvas ref={jog} className="jog" />
        <div className="pitch" ref={set('pitch')} data-off="0" title="Pitch (vitesse de lecture)">
          <span className="lbl">PITCH</span>
          <div className="pitch-track">
            <i className="pitch-zero" />
            <i className="pitch-cap" ref={set('pitchCap')} />
          </div>
          <span className="lbl" ref={set('range')}>±8</span>
        </div>
      </div>
      <div className="deck-info">
        <div className="deck-row">
          <div className="deck-bpm">
            <div className="bpm-main">
              <span className="v" ref={set('bpm')}>—</span>
              <span className="u">BPM</span>
            </div>
            <div className="bpm-sub">
              <span className="orig" ref={set('orig')}>ORIGINE —</span>
              <span className="pct" ref={set('pct')}>+0.0 %</span>
            </div>
          </div>
          <div className="deck-key">
            <span className="lbl">TON</span>
            <span className="v" ref={set('key')}>—</span>
          </div>
        </div>
        <div className="deck-row times">
          <span className="t" ref={set('elapsed')}>00:00.0</span>
          <span className="t dim" ref={set('remain')}>−00:00.0</span>
        </div>
        <div className="deck-row counters">
          <div className="beats" ref={set('beats')}>
            <i data-on="0">1</i>
            <i data-on="0">2</i>
            <i data-on="0">3</i>
            <i data-on="0">4</i>
          </div>
          <span className="phrase" ref={set('phrase')}>--/32</span>
          <span className="barno" ref={set('bar')} />
        </div>
        <div className="deck-error" ref={set('error')} />
        {manual && (
          <div className="deck-actions">
            <button onClick={() => void engine.conductor.manualPlay(id)}>Lecture</button>
            <button onClick={() => void engine.conductor.manualPause(id)}>Pause</button>
            <button onClick={() => onLoadNext(id)}>Charger le 1er de la file</button>
          </div>
        )}
      </div>
    </section>
  );
}

function brakeFactor(f: ReturnType<typeof getFrame>, id: DeckId): number | undefined {
  const now = f.now;
  for (const fx of f.activeFx) {
    if (fx.cue.kind !== 'brake' || fx.cue.target !== id) continue;
    const dur = (fx.cue.beats * 60) / fx.cue.bpm;
    if (now >= fx.cue.atCtx) return Math.max(0, 1 - (now - fx.cue.atCtx) / Math.max(0.1, dur));
  }
  const tr = f.transition;
  if (tr && tr.plan.technique === 'brake' && tr.plan.from === id) {
    const spb = 60 / tr.plan.bpm;
    const dur = Math.min(tr.plan.beats, 4) * spb;
    const start = tr.plan.incomingStartCtx - dur;
    if (now >= start) return Math.max(0, 1 - (now - start) / dur);
  }
  return undefined;
}

function drawJog(
  cv: HTMLCanvasElement | null,
  a: { angle: number; cover?: HTMLImageElement; coverUrl: string },
  track: TrackRef | undefined,
  progress: number,
  live: boolean,
  id: DeckId,
) {
  if (!cv || !cv.width) return;
  const g = cv.getContext('2d')!;
  const W = cv.width;
  const H = cv.height;
  const s = Math.min(W, H);
  const cx = W / 2;
  const cy = H / 2;
  const R = s / 2 - 2;
  g.clearRect(0, 0, W, H);

  // anneau de progression
  g.lineWidth = Math.max(2, s * 0.018);
  g.strokeStyle = '#2A2A2E';
  g.beginPath();
  g.arc(cx, cy, R - g.lineWidth / 2, 0, Math.PI * 2);
  g.stroke();
  if (progress > 0) {
    g.strokeStyle = live ? '#FF3B30' : '#D7FF3A';
    g.beginPath();
    g.arc(cx, cy, R - g.lineWidth / 2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, progress));
    g.stroke();
  }

  // plateau (vinyle) avec sillons
  const r1 = R * 0.9;
  g.save();
  g.translate(cx, cy);
  g.rotate(a.angle);
  const grd = g.createRadialGradient(0, 0, r1 * 0.3, 0, 0, r1);
  grd.addColorStop(0, '#18181b');
  grd.addColorStop(1, '#0f0f11');
  g.fillStyle = grd;
  g.beginPath();
  g.arc(0, 0, r1, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.035)';
  g.lineWidth = 1;
  for (let r = r1 * 0.45; r < r1; r += Math.max(2, s * 0.012)) {
    g.beginPath();
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.stroke();
  }
  // reflet fixe donné par un secteur clair (tourne avec le disque pour rendre la rotation lisible)
  g.fillStyle = 'rgba(255,255,255,0.035)';
  g.beginPath();
  g.moveTo(0, 0);
  g.arc(0, 0, r1, -0.35, 0.35);
  g.fill();
  // repère
  g.strokeStyle = '#D7FF3A';
  g.lineWidth = Math.max(2, s * 0.02);
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(0, -r1 * 0.98);
  g.lineTo(0, -r1 * 0.62);
  g.stroke();

  // étiquette centrale : pochette
  const rc = r1 * 0.44;
  g.beginPath();
  g.arc(0, 0, rc, 0, Math.PI * 2);
  g.closePath();
  g.save();
  g.clip();
  const url = track?.cover ?? '';
  if (url !== a.coverUrl) {
    a.coverUrl = url;
    a.cover = undefined;
    if (url) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        if (a.coverUrl === url) a.cover = img;
      };
      img.src = url;
    }
  }
  if (a.cover) g.drawImage(a.cover, -rc, -rc, rc * 2, rc * 2);
  else {
    g.fillStyle = '#1d1d21';
    g.fillRect(-rc, -rc, rc * 2, rc * 2);
    g.fillStyle = '#8A8A90';
    g.font = `700 ${Math.round(rc * 0.7)}px Archivo, "Helvetica Neue", Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(id, 0, 0);
  }
  g.restore();
  g.fillStyle = '#0B0B0C';
  g.beginPath();
  g.arc(0, 0, Math.max(2, s * 0.018), 0, Math.PI * 2);
  g.fill();
  g.restore();
}
