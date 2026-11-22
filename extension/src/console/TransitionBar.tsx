/**
 * Bandeau « Prochaine transition » : technique, compte à rebours (mesures + temps), progression,
 * raison lisible. Mis à jour à chaque image.
 */
import { useRef } from 'react';
import type { Engine } from '../engine';
import { getFrame, useFrame } from './frame';
import { FX_LABELS, TECHNIQUE_LABELS, fmtTime } from './labels';

export function TransitionBar({ engine, running }: { engine: Engine; running: boolean }) {
  const r = useRef<Record<string, HTMLElement | null>>({});
  const set = (k: string) => (el: HTMLElement | null) => {
    r.current[k] = el;
  };

  useFrame((t) => {
    const f = getFrame(engine, t);
    const e = r.current;
    const txt = (k: string, s: string) => {
      const el = e[k];
      if (el && el.textContent !== s) el.textContent = s;
    };
    const tr = f.transition;
    const root = e.root;
    if (!tr) {
      if (root) root.dataset.state = 'idle';
      txt('kicker', running ? 'PROCHAINE TRANSITION' : 'EN ATTENTE');
      txt('tech', running ? 'Le cerveau écoute' : 'Appuie sur « Lancer la soirée »');
      const air = f.onAir;
      if (air && running) {
        const st = f.states[air];
        txt('count', `fin du morceau dans ${fmtTime(Math.max(0, (st.duration || 0) - st.position))}`);
      } else txt('count', '');
      txt('reason', running ? 'Il choisira le moment sur un début de phrase.' : 'Le pilote automatique enchaînera tout seul.');
      txt('route', '');
      if (e.fill) e.fill.style.width = '0%';
      const fx = f.activeFx.find((x) => x.cue.atCtx <= f.now);
      txt('fx', fx ? `EFFET · ${FX_LABELS[fx.cue.kind]}` : '');
      return;
    }
    const p = tr.plan;
    const spb = 60 / p.bpm;
    const now = f.now;
    const total = p.beats * spb;
    txt('tech', TECHNIQUE_LABELS[p.technique] ?? p.technique);
    txt('route', `${p.from} → ${p.to} · ${p.beats} temps · ${p.bpm.toFixed(1)} BPM`);
    txt('reason', p.reason);
    const fx = f.activeFx.find((x) => x.cue.atCtx <= now && x.endCtx > now);
    txt('fx', fx ? `EFFET · ${FX_LABELS[fx.cue.kind]}` : '');
    if (now < p.startCtx) {
      if (root) root.dataset.state = 'scheduled';
      const left = p.startCtx - now;
      const beats = Math.ceil(left / spb);
      const bars = Math.floor(beats / 4);
      const rem = beats % 4;
      txt('kicker', 'PROCHAINE TRANSITION');
      txt('count', `dans ${bars} mes.${rem ? ` ${rem} t.` : ''} · ${left.toFixed(1)} s`);
      if (e.fill) e.fill.style.width = '0%';
    } else {
      if (root) root.dataset.state = 'running';
      const k = Math.min(1, (now - p.startCtx) / total);
      const beat = Math.min(p.beats, Math.floor((now - p.startCtx) / spb) + 1);
      txt('kicker', 'TRANSITION EN COURS');
      txt('count', `${beat}/${p.beats} temps · reste ${Math.max(0, p.startCtx + total - now).toFixed(1)} s`);
      if (e.fill) e.fill.style.width = `${(k * 100).toFixed(1)}%`;
    }
  });

  return (
    <section className="transition" ref={set('root')} data-state="idle">
      <div className="tr-left">
        <span className="kicker" ref={set('kicker')} />
        <span className="tech" ref={set('tech')} />
        <span className="route mono" ref={set('route')} />
      </div>
      <div className="tr-mid">
        <span className="reason" ref={set('reason')} />
        <div className="tr-bar">
          <div className="tr-fill" ref={set('fill')} />
        </div>
      </div>
      <div className="tr-right">
        <span className="count mono" ref={set('count')} />
        <span className="fx mono" ref={set('fx')} />
      </div>
    </section>
  );
}
