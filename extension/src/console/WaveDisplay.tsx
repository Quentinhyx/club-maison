/**
 * Formes d'onde défilantes (A en haut, B en bas) autour d'une tête de lecture fixe, avec la grille
 * des temps, et sous chacune la vue d'ensemble du morceau. Dessin canvas à 60 i/s.
 */
import { useEffect, useRef } from 'react';
import type { DeckId, TransitionPlan } from '../../../shared/contracts';
import type { Engine } from '../engine';
import type { Waveform } from '../waveforms';
import type { GrooveView } from '../conductor';
import { beatIndexAt, getFrame, useFrame, type DeckView } from './frame';

const C = {
  bg: '#0B0B0C',
  lane: '#0E0E10',
  rule: '#2A2A2E',
  beat: 'rgba(11,11,12,0.45)',
  bar: 'rgba(236,236,236,0.5)',
  phrase: '#D7FF3A',
  low: '#2F6BFF',
  mid: '#FFB23F',
  high: '#F4F4F4',
  text: '#ECECEC',
  dim: '#8A8A90',
  accent: '#D7FF3A',
  live: '#FF3B30',
};

const WAVE_SECONDS = 12; // fenêtre visible (secondes de contexte audio)

export function WaveDisplay({ engine }: { engine: Engine }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 0, h: 0, dpr: 1 });

  useEffect(() => {
    const cv = ref.current!;
    const ro = new ResizeObserver(() => {
      const r = cv.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      size.current = { w: r.width, h: r.height, dpr };
      cv.width = Math.round(r.width * dpr);
      cv.height = Math.round(r.height * dpr);
    });
    ro.observe(cv);
    return () => ro.disconnect();
  }, []);

  useFrame((t) => {
    const cv = ref.current;
    if (!cv) return;
    const { w, h, dpr } = size.current;
    if (!w || !h) return;
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = C.bg;
    g.fillRect(0, 0, w, h);

    const f = getFrame(engine, t);
    const tr = f.transition;
    const onAir = f.onAir;
    const views: Record<DeckId, DeckView> = f.views;
    const gap = 6;
    const ovH = 22;
    const waveH = Math.max(40, (h - 2 * ovH - 3 * gap) / 2);
    const now = f.now;

    (['A', 'B'] as DeckId[]).forEach((id, i) => {
      const v = views[id];
      const wf = engine.waves.get(v.state.track);
      // forme d'onde en direct : on enregistre ce qu'on entend
      if (wf && !wf.full && v.playing) engine.waves.record(v.state.track, v.pos, engine.meters.bands(id));
      const y0 = i * (waveH + ovH + 2 * gap);
      drawWave(g, 0, y0, w, waveH, v, wf, id, onAir === id, tr?.plan, now, engine.conductor.getGroove());
      drawOverview(g, 0, y0 + waveH + gap * 0.6, w, ovH, v, wf, tr?.plan, now);
    });

    // tête de lecture
    const x = Math.round(w / 2) + 0.5;
    g.strokeStyle = C.accent;
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.stroke();
    g.fillStyle = C.accent;
    g.beginPath();
    g.moveTo(x - 5, 0);
    g.lineTo(x + 5, 0);
    g.lineTo(x, 6);
    g.fill();
  });

  return <canvas ref={ref} className="waves" aria-label="Formes d'onde des platines A et B" />;
}

function bandAt(a: Float32Array, i0: number, i1: number): number {
  let m = 0;
  const lo = Math.max(0, Math.floor(i0));
  const hi = Math.min(a.length - 1, Math.ceil(i1));
  for (let i = lo; i <= hi; i++) if (a[i] > m) m = a[i];
  return m;
}

function drawWave(
  g: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  w: number,
  h: number,
  v: DeckView,
  wf: Waveform | undefined,
  id: DeckId,
  onAir: boolean,
  plan: TransitionPlan | undefined,
  now: number,
  groove?: GrooveView,
) {
  g.fillStyle = C.lane;
  g.fillRect(x0, y0, w, h);
  const mid = y0 + h / 2;
  const pxPerSec = w / WAVE_SECONDS; // secondes de contexte : à vitesse égale, les temps s'alignent
  const rate = v.rate || 1;
  const cx = x0 + w / 2;

  // zone de transition prévue (sur l'axe du temps réel)
  if (plan && (plan.from === id || plan.to === id)) {
    const spb = 60 / plan.bpm;
    const xs = cx + (plan.startCtx - now) * pxPerSec;
    const xe = cx + (plan.startCtx + plan.beats * spb - now) * pxPerSec;
    if (xe > x0 && xs < x0 + w) {
      g.fillStyle = 'rgba(215,255,58,0.07)';
      g.fillRect(Math.max(x0, xs), y0, Math.min(x0 + w, xe) - Math.max(x0, xs), h);
    }
  }

  // forme d'onde par bandes
  if (wf && v.state.track) {
    const layers: Array<[Float32Array, string, number]> = [
      [wf.low, C.low, 1],
      [wf.mid, C.mid, 0.72],
      [wf.high, C.high, 0.42],
    ];
    const half = (h / 2 - 3) * 0.86;
    const step = 2;
    for (const [arr, color, scale] of layers) {
      g.fillStyle = color;
      g.globalAlpha = color === C.high ? 0.85 : 0.9;
      g.beginPath();
      for (let x = 0; x < w; x += step) {
        const p0 = v.pos + ((x - w / 2) / pxPerSec) * rate;
        const p1 = v.pos + ((x + step - w / 2) / pxPerSec) * rate;
        if (p1 < 0) continue;
        const val = bandAt(arr, p0 * wf.pps, p1 * wf.pps);
        if (val <= 0.002) continue;
        const hh = Math.max(0.5, val * half * scale);
        g.rect(x0 + x, mid - hh, step - 0.5, hh * 2);
      }
      g.fill();
    }
    g.globalAlpha = 1;
    // le futur d'une onde en direct est inconnu : on l'indique
    if (!wf.full) {
      g.fillStyle = 'rgba(11,11,12,0.55)';
      g.fillRect(cx, y0, w / 2, h);
      g.fillStyle = C.dim;
      g.font = '500 10px "JetBrains Mono", ui-monospace, monospace';
      g.fillText('onde construite en direct', cx + 12, mid + 3);
    }
  } else {
    g.fillStyle = C.dim;
    g.font = '500 11px "JetBrains Mono", ui-monospace, monospace';
    g.fillText(v.state.track ? 'calcul de la forme d’onde…' : 'platine vide', cx + 12, mid + 4);
  }

  // grille des temps (par-dessus l'onde : temps sombres, mesures claires, phrases numérotées)
  if (v.grid && v.state.track) {
    const { period, origin, times } = v.grid;
    const secHalf = (WAVE_SECONDS / 2) * rate;
    g.font = '600 10px "JetBrains Mono", ui-monospace, monospace';
    const line = (b: number, p: number) => {
      if (p < 0) return;
      const x = Math.round(cx + ((p - v.pos) / rate) * pxPerSec) + 0.5;
      const isPhrase = b % 32 === 0;
      const isBar = b % 4 === 0;
      g.strokeStyle = isPhrase ? 'rgba(215,255,58,0.7)' : isBar ? C.bar : C.beat;
      g.lineWidth = isPhrase ? 1.5 : 1;
      g.beginPath();
      g.moveTo(x, y0);
      g.lineTo(x, y0 + h);
      g.stroke();
      if (isPhrase) {
        g.fillStyle = C.phrase;
        g.fillText(String(b / 32 + 1), x + 3, y0 + h - 4);
      }
    };
    if (times) {
      const i0 = Math.max(0, beatIndexAt(times, v.pos - secHalf));
      for (let b = i0; b < times.length && times[b] <= v.pos + secHalf; b++) line(b, times[b]);
    } else {
      const bStart = Math.max(0, Math.ceil((v.pos - secHalf - origin) / period));
      const bEnd = Math.floor((v.pos + secHalf - origin) / period);
      for (let b = bStart; b <= bEnd; b++) line(b, origin + b * period);
    }
  }

  // temps du groove (re-edit) calé sur cette platine : petits marqueurs en bas de la voie
  const gr = groove;
  if (gr && gr.plan.deck === id && (gr.endCtx === undefined || now < gr.endCtx)) {
    const spb = 60 / gr.plan.bpm;
    const tStart = now - WAVE_SECONDS / 2;
    const k0 = Math.ceil((tStart - gr.plan.anchorCtx) / spb);
    const k1 = Math.floor((now + WAVE_SECONDS / 2 - gr.plan.anchorCtx) / spb);
    for (let k = k0; k <= k1; k++) {
      const tb = gr.plan.anchorCtx + k * spb;
      if (tb < gr.plan.startCtx - 1e-3) continue;
      const x = cx + (tb - now) * pxPerSec;
      const bar = ((k % 4) + 4) % 4 === 0;
      g.fillStyle = bar ? C.accent : 'rgba(215,255,58,0.55)';
      const s2 = bar ? 5 : 3.5;
      g.beginPath();
      g.moveTo(x, y0 + h - 2 - s2 * 1.4);
      g.lineTo(x - s2, y0 + h - 2);
      g.lineTo(x + s2, y0 + h - 2);
      g.fill();
    }
    g.fillStyle = C.accent;
    g.font = '700 10px "JetBrains Mono", ui-monospace, monospace';
    g.fillText(`GROOVE ${gr.plan.style.toUpperCase()}`, x0 + w - 150, y0 + 13);
  }

  // étiquette de voie
  g.fillStyle = onAir ? C.live : '#151517';
  g.fillRect(x0, y0, 22, 18);
  g.fillStyle = onAir ? '#fff' : C.text;
  g.font = '700 12px Archivo, "Helvetica Neue", Arial, sans-serif';
  g.fillText(id, x0 + 7, y0 + 13);
  if (v.state.track) {
    g.fillStyle = 'rgba(11,11,12,0.7)';
    const label = `${v.state.track.title} · ${v.state.track.artist}`;
    g.font = '600 11px Archivo, "Helvetica Neue", Arial, sans-serif';
    const tw = Math.min(w / 2 - 60, g.measureText(label).width);
    g.fillRect(x0 + 26, y0, tw + 12, 18);
    g.fillStyle = C.text;
    g.save();
    g.beginPath();
    g.rect(x0 + 26, y0, tw + 12, 18);
    g.clip();
    g.fillText(label, x0 + 32, y0 + 13);
    g.restore();
  }
  g.strokeStyle = C.rule;
  g.lineWidth = 1;
  g.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
}

function drawOverview(
  g: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  w: number,
  h: number,
  v: DeckView,
  wf: Waveform | undefined,
  plan: TransitionPlan | undefined,
  now: number,
) {
  g.fillStyle = '#121214';
  g.fillRect(x0, y0, w, h);
  const dur = v.state.duration || v.state.track?.duration || 0;
  if (!dur) return;
  const pxs = w / dur;
  if (wf) {
    const step = 2;
    for (const [arr, color, scale] of [
      [wf.low, C.low, 1],
      [wf.mid, C.mid, 0.7],
    ] as Array<[Float32Array, string, number]>) {
      g.fillStyle = color;
      g.globalAlpha = 0.55;
      g.beginPath();
      for (let x = 0; x < w; x += step) {
        const val = bandAt(arr, (x / pxs) * wf.pps, ((x + step) / pxs) * wf.pps);
        if (val <= 0.002) continue;
        const hh = val * (h / 2 - 2) * scale;
        g.rect(x0 + x, y0 + h / 2 - hh, step - 0.5, hh * 2);
      }
      g.fill();
    }
    g.globalAlpha = 1;
  }
  // partie déjà jouée assombrie
  const px = x0 + v.pos * pxs;
  g.fillStyle = 'rgba(11,11,12,0.5)';
  g.fillRect(x0, y0, px - x0, h);

  // transition prévue : zone surlignée + repère de sortie
  if (plan && (plan.from === v.id || plan.to === v.id)) {
    const spb = 60 / plan.bpm;
    const rate = v.rate || 1;
    let ps: number;
    let pe: number;
    if (plan.from === v.id) {
      ps = v.pos + (plan.startCtx - now) * rate;
      pe = v.pos + (plan.startCtx + plan.beats * spb - now) * rate;
    } else {
      const offset = plan.startCtx - plan.incomingStartCtx;
      ps = plan.incomingStartPos + offset * rate;
      pe = ps + plan.beats * spb * rate;
      if (v.playing) {
        ps = v.pos + (plan.startCtx - now) * rate;
        pe = v.pos + (plan.startCtx + plan.beats * spb - now) * rate;
      }
    }
    const xs = x0 + Math.max(0, ps) * pxs;
    const xe = x0 + Math.min(dur, pe) * pxs;
    g.fillStyle = 'rgba(215,255,58,0.22)';
    g.fillRect(xs, y0, Math.max(2, xe - xs), h);
    g.fillStyle = C.accent;
    g.fillRect(Math.round(xs), y0, 2, h);
  }
  g.fillStyle = C.text;
  g.fillRect(Math.round(px), y0 - 1, 2, h + 2);
  g.strokeStyle = C.rule;
  g.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
}
