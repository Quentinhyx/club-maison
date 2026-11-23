/**
 * Table de mixage : boutons EQ/filtre et faders qui bougent tout seuls quand le cerveau automatise
 * (valeurs lues sur la vraie table via mixer.getParam), vumètres stéréo à segments, VU master,
 * LED des effets, indicateur de phase A/B, crossfader. Manipulable en mode manuel.
 */
import { useEffect, useRef } from 'react';
import type { DeckId, ParamTarget } from '../../../shared/contracts';
import type { Engine } from '../engine';
import type { MixerLike } from '../conductor';
import { getFrame, phaseDiff, useFrame } from './frame';
import { fmtLoop } from './labels';

const EQ_MIN = -26;
const EQ_MAX = 6;

type KnobKind = 'eq' | 'filter';

function knobAngle(kind: KnobKind, v: number): number {
  if (kind === 'filter') return Math.max(-1, Math.min(1, v)) * 135;
  return v < 0 ? (Math.max(EQ_MIN, v) / -EQ_MIN) * 135 : (Math.min(EQ_MAX, v) / EQ_MAX) * 135;
}

function knobText(kind: KnobKind, v: number): string {
  if (kind === 'filter') {
    if (Math.abs(v) < 0.02) return 'OFF';
    return `${v < 0 ? 'PB' : 'PH'} ${Math.round(Math.abs(v) * 100)}`;
  }
  if (v <= EQ_MIN + 0.5) return 'KILL';
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(0)} dB`;
}

interface Bind {
  target: ParamTarget;
  kind: 'knob-eq' | 'knob-filter' | 'fader';
  el: HTMLElement;
}

export function MixerPanel({ engine, manual }: { engine: Engine; manual: boolean }) {
  const binds = useRef<Bind[]>([]);
  const vu = useRef<Record<string, HTMLCanvasElement | null>>({});
  const leds = useRef<Record<string, HTMLElement | null>>({});
  const phase = useRef<HTMLDivElement>(null);
  const phaseTxt = useRef<HTMLSpanElement>(null);
  const xf = useRef<HTMLDivElement>(null);
  const grooveEl = useRef<HTMLDivElement>(null);
  const grooveStyle = useRef<HTMLDivElement>(null);
  const grooveBeat = useRef<HTMLDivElement>(null);
  const manualRef = useRef(manual);
  manualRef.current = manual;

  const bind = (target: ParamTarget, kind: Bind['kind']) => (el: HTMLElement | null) => {
    binds.current = binds.current.filter((b) => b.target !== target || b.kind !== kind);
    if (el) binds.current.push({ target, kind, el });
  };

  useEffect(() => {
    for (const c of Object.values(vu.current)) {
      if (!c) continue;
      const r = c.getBoundingClientRect();
      c.width = Math.max(1, Math.round(r.width * 2));
      c.height = Math.max(1, Math.round(r.height * 2));
    }
  }, []);

  useFrame((t) => {
    const f = getFrame(engine, t);
    const mx = engine.mixer;
    const get = (p: ParamTarget, d = 0) => {
      try {
        const v = mx.getParam(p);
        return Number.isFinite(v) ? v : d;
      } catch {
        return d;
      }
    };
    for (const b of binds.current) {
      const v = get(b.target, b.kind === 'fader' ? 1 : 0);
      if (b.kind === 'fader') {
        const cap = b.el.querySelector<HTMLElement>('.cap');
        if (cap) cap.style.bottom = `calc(${(Math.max(0, Math.min(1, v)) * 100).toFixed(1)}% - 9px)`;
      } else {
        const kind: KnobKind = b.kind === 'knob-filter' ? 'filter' : 'eq';
        const ind = b.el.querySelector<HTMLElement>('.ind');
        if (ind) ind.style.transform = `rotate(${knobAngle(kind, v).toFixed(1)}deg)`;
        const val = b.el.querySelector<HTMLElement>('.val');
        const s = knobText(kind, v);
        if (val && val.textContent !== s) val.textContent = s;
        const active = kind === 'filter' ? Math.abs(v) > 0.02 : Math.abs(v) > 0.5;
        b.el.dataset.active = active ? '1' : '0';
      }
    }
    // crossfader (déduit des gains de voie)
    const gA = get('A.gain', 1);
    const gB = get('B.gain', 1);
    const pos = gA + gB > 0.001 ? gB / (gA + gB) : 0.5;
    if (xf.current) xf.current.style.left = `calc(${(pos * 100).toFixed(1)}% - 14px)`;

    // vumètres
    drawVu(vu.current.A, engine.meters.level('A'));
    drawVu(vu.current.B, engine.meters.level('B'));
    drawVu(vu.current.M, engine.meters.level('master'));

    // tranche groove (re-edit)
    const gs = (mx as unknown as MixerLike).getGrooveState?.();
    const gv = engine.conductor.getGroove();
    const gOn = !!(gs?.running || (gv && (gv.endCtx === undefined || f.now < gv.endCtx)));
    if (grooveEl.current) grooveEl.current.dataset.on = gOn ? '1' : '0';
    const style = gs?.style ?? gv?.plan.style;
    const gtxt = (el: HTMLElement | null, s: string) => {
      if (el && el.textContent !== s) el.textContent = s;
    };
    gtxt(grooveStyle.current, gOn && style ? style.toUpperCase() : 'ÉTEINT');
    let beatTxt = '-.-';
    if (gOn) {
      if (gs?.beat !== undefined) beatTxt = `${Math.floor(gs.beat / 4) % 8 + 1}.${(Math.floor(gs.beat) % 4) + 1}`;
      else if (gv) {
        const b = Math.floor((f.now - gv.plan.anchorCtx) / (60 / gv.plan.bpm));
        beatTxt = `${(((Math.floor(b / 4) % 8) + 8) % 8) + 1}.${(((b % 4) + 4) % 4) + 1}`;
      }
    }
    gtxt(grooveBeat.current, beatTxt);
    const gl = gOn ? (engine.mixer.getLevels() as { groove?: number }).groove ?? 0 : 0;
    const gm = Math.max(0, Math.min(1, (20 * Math.log10(gl + 1e-9) + 48) / 48));
    drawVu(vu.current.G, { l: gm, r: gm, peakL: gm, peakR: gm }, true);

    // effets
    const echo = Math.max(get('A.echoSend'), get('B.echoSend'));
    const rev = Math.max(get('A.reverbSend'), get('B.reverbSend'));
    const riser = get('fx.noise.gain');
    const gate = get('fx.gate.depth');
    const filt = Math.max(Math.abs(get('A.filter')), Math.abs(get('B.filter')), Math.abs(get('master.filter')));
    const fxState: Record<string, [number, number]> = {
      ECHO: [echo, 0.02],
      REVERB: [rev, 0.02],
      RISER: [riser, 0.01],
      GATE: [gate, 0.02],
      FILTER: [filt, 0.03],
    };
    for (const [k, [v, th]] of Object.entries(fxState)) {
      const el = leds.current[k];
      if (!el) continue;
      const on = v > th;
      el.dataset.on = on ? '1' : '0';
      const val = el.querySelector('.v');
      const s = on ? `${Math.round(Math.min(1, v) * 100)}` : '—';
      if (val && val.textContent !== s) val.textContent = s;
    }
    // boucle : LED avec la longueur (A 1/2, B 4…)
    const loops = engine.conductor.getLoops();
    const lel = leds.current.LOOP;
    if (lel) {
      const parts = (['A', 'B'] as DeckId[]).filter((d) => loops[d]).map((d) => `${d} ${fmtLoop(loops[d]!.beats)}`);
      lel.dataset.on = parts.length ? '1' : '0';
      const val = lel.querySelector('.v');
      const s = parts.length ? parts.join(' ') : '—';
      if (val && val.textContent !== s) val.textContent = s;
    }

    // phase
    const d = phaseDiff(f.views.A, f.views.B);
    if (phase.current) {
      phase.current.style.opacity = d === undefined ? '0.25' : '1';
      phase.current.style.left = `calc(${(50 + (d ?? 0) * 100).toFixed(1)}% - 2px)`;
      phase.current.dataset.ok = d !== undefined && Math.abs(d) < 0.03 ? '1' : '0';
    }
    if (phaseTxt.current) {
      const bpm = f.views.A.grid?.bpm ?? 120;
      const ms = d === undefined ? '' : `${d >= 0 ? '+' : '−'}${Math.abs((d * 60000) / (bpm * (f.views.A.rate || 1))).toFixed(0)} ms`;
      if (phaseTxt.current.textContent !== ms) phaseTxt.current.textContent = ms;
    }
  });

  // ------------------------------------------------------------------ manipulation manuelle
  const drag = (target: ParamTarget, kind: Bind['kind']) => (e: React.PointerEvent<HTMLElement>) => {
    if (!manualRef.current) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const min = kind === 'knob-eq' ? EQ_MIN : kind === 'knob-filter' ? -1 : 0;
    const max = kind === 'knob-eq' ? EQ_MAX : 1;
    const rect = el.getBoundingClientRect();
    let start = engine.mixer.getParam(target);
    let y0 = e.clientY;
    const apply = (ev: PointerEvent) => {
      let v: number;
      if (kind === 'fader') {
        const track = el.querySelector('.track')!.getBoundingClientRect();
        v = 1 - (ev.clientY - track.top) / track.height;
      } else {
        v = start + ((y0 - ev.clientY) / 140) * (max - min);
        start = v;
        y0 = ev.clientY;
      }
      v = Math.max(min, Math.min(max, v));
      engine.mixer.setParam(target, v);
    };
    void rect;
    if (kind === 'fader') apply(e.nativeEvent);
    const move = (ev: PointerEvent) => apply(ev);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  const reset = (target: ParamTarget, v: number) => () => {
    if (manualRef.current) engine.mixer.setParam(target, v);
  };
  const xfDrag = (e: React.PointerEvent<HTMLElement>) => {
    if (!manualRef.current) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const apply = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      // courbe à puissance constante
      engine.mixer.setParam('A.gain', Math.cos((x * Math.PI) / 2));
      engine.mixer.setParam('B.gain', Math.sin((x * Math.PI) / 2));
    };
    apply(e.nativeEvent);
    const move = (ev: PointerEvent) => apply(ev);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const knob = (id: DeckId | ParamTarget, p: 'eqHigh' | 'eqMid' | 'eqLow' | 'filter', label: string) => {
    const target = (id.includes('.') ? id : `${id}.${p}`) as ParamTarget;
    const kind = p === 'filter' ? 'knob-filter' : 'knob-eq';
    return (
      <div className={`knob ${p === 'filter' ? 'knob-filter' : ''}`} ref={bind(target, kind)} onPointerDown={drag(target, kind)} onDoubleClick={reset(target, 0)} data-active="0">
        <div className="dial">
          <div className="ind" />
        </div>
        <div className="klabel">{label}</div>
        <div className="val">0 dB</div>
      </div>
    );
  };

  const channel = (id: DeckId) => (
    <div className={`ch ch-${id}`}>
      <div className="ch-name">{id}</div>
      {knob(id, 'eqHigh', 'HI')}
      {knob(id, 'eqMid', 'MID')}
      {knob(id, 'eqLow', 'LOW')}
      {knob(id, 'filter', 'FILTRE')}
      <div className="ch-fader-row">
        <div className="fader" ref={bind(`${id}.gain` as ParamTarget, 'fader')} onPointerDown={drag(`${id}.gain` as ParamTarget, 'fader')}>
          <div className="track" />
          <div className="cap" />
        </div>
        <canvas className="vu" ref={(el) => { vu.current[id] = el; }} />
      </div>
    </div>
  );

  return (
    <section className={`mixer ${manual ? 'is-manual' : ''}`}>
      <div className="mx-phase">
        <span className="lbl">PHASE A/B</span>
        <div className="phase-track">
          <div className="phase-center" />
          <div className="phase-dot" ref={phase} />
        </div>
        <span className="mono" ref={phaseTxt} />
      </div>
      <div className="mx-body">
        {channel('A')}
        <div className="master">
          <div className="ch-name">MASTER</div>
          <canvas className="vu vu-master" ref={(el) => { vu.current.M = el; }} />
          <div className="leds">
            {['ECHO', 'REVERB', 'RISER', 'GATE', 'FILTER', 'LOOP'].map((k) => (
              <div className="led" key={k} ref={(el) => { leds.current[k] = el; }} data-on="0">
                <i />
                <span className="k">{k}</span>
                <span className="v">—</span>
              </div>
            ))}
          </div>
        </div>
        <div className="ch ch-groove" ref={grooveEl} data-on="0">
          <div className="ch-name">GROOVE</div>
          <div className="gr-style mono" ref={grooveStyle}>—</div>
          <div className="gr-beat mono" ref={grooveBeat}>-.-</div>
          {knob('groove.filter', 'filter', 'FILTRE')}
          {knob('groove.eqLow', 'eqLow', 'LOW')}
          <div className="ch-fader-row">
            <div className="fader" ref={bind('groove.gain', 'fader')} onPointerDown={drag('groove.gain', 'fader')}>
              <div className="track" />
              <div className="cap" />
            </div>
            <canvas className="vu vu-mono" ref={(el) => { vu.current.G = el; }} />
          </div>
        </div>
        {channel('B')}
      </div>
      <div className="mx-xf">
        <span>A</span>
        <div className="xf-track" onPointerDown={xfDrag}>
          <div className="xf-line" />
          <div className="xf-cap" ref={xf} />
        </div>
        <span>B</span>
      </div>
    </section>
  );
}

function drawVu(cv: HTMLCanvasElement | null | undefined, lv: { l: number; r: number; peakL: number; peakR: number }, mono = false) {
  if (!cv) return;
  if (cv.width < 4) {
    const r = cv.getBoundingClientRect();
    cv.width = Math.max(1, Math.round(r.width * 2));
    cv.height = Math.max(1, Math.round(r.height * 2));
  }
  const g = cv.getContext('2d')!;
  const W = cv.width;
  const H = cv.height;
  g.clearRect(0, 0, W, H);
  const segs = 20;
  const gap = 2 * 2;
  const segH = (H - gap * (segs - 1)) / segs;
  const colW = mono ? W : (W - 4) / 2;
  const cols: Array<[number, number]> = mono
    ? [[lv.l, lv.peakL]]
    : [
        [lv.l, lv.peakL],
        [lv.r, lv.peakR],
      ];
  cols.forEach(([v, pk], c) => {
    const x = c * (colW + 4);
    const lit = Math.round(v * segs);
    const peakSeg = Math.min(segs - 1, Math.round(pk * segs) - 1);
    for (let i = 0; i < segs; i++) {
      const y = H - (i + 1) * segH - i * gap;
      const hot = i >= segs - 2;
      const warm = i >= segs - 6;
      const on = i < lit || i === peakSeg;
      g.fillStyle = on ? (hot ? '#FF3B30' : warm ? '#F2F2F2' : '#D7FF3A') : '#1c1c1f';
      g.fillRect(x, y, colW, segH);
    }
  });
}
