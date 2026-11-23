/**
 * Console Club Maison : la page que l'hôte garde ouverte pendant la soirée.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DeckId } from '../../../shared/contracts';
import type { ConductorSnapshot } from '../conductor';
import { Engine, MODE_LABELS } from '../engine';
import { isExtension, urlParam } from '../lib/env';
import { saveSettings, type ConsoleSettings } from '../lib/storage';
import { BottomTabs } from './BottomTabs';
import { DeckPanel } from './DeckPanel';
import { getFrame, useFrame } from './frame';
import { MixerPanel } from './MixerPanel';
import { TransitionBar } from './TransitionBar';
import { WaveDisplay } from './WaveDisplay';

export function App({ initial }: { initial: ConsoleSettings }) {
  const [settings, setSettings] = useState(initial);
  const fast = urlParam('fast') === '1';
  const engine = useMemo(() => new Engine({ settings: initial, fast }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [snap, setSnap] = useState<ConductorSnapshot>(() => engine.conductor.getSnapshot());
  const [starting, setStarting] = useState(false);

  // raccourcis : flèche droite ou N = morceau suivant
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.key === 'ArrowRight' || e.key === 'n' || e.key === 'N') && engine.conductor.isRunning()) {
        e.preventDefault();
        engine.conductor.requestSkip('clavier');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine]);

  useEffect(() => {
    const t = setInterval(() => setSnap(engine.conductor.getSnapshot()), 250);
    (window as any).__club = engine; // accès console de debug
    return () => {
      clearInterval(t);
      engine.dispose();
    };
  }, [engine]);

  const manual = !snap.autopilot;
  const running = snap.running;

  const start = async () => {
    setStarting(true);
    try {
      await engine.start();
    } finally {
      setStarting(false);
      setSnap(engine.conductor.getSnapshot());
    }
  };

  const onSave = (s: ConsoleSettings, restart: boolean) => {
    setSettings(s);
    void saveSettings(s).then(() => {
      if (restart) location.reload();
    });
  };

  const loadNext = (id: DeckId) => {
    const it = snap.queue[0];
    if (it) void engine.conductor.manualLoad(id, it.track);
  };

  const openAssistant = () => {
    if (!isExtension) {
      window.alert('L’assistant d’installation teste Deezer : il n’existe que dans l’extension Chrome. Ouvre la console en cliquant sur l’icône Club Maison (barre d’extensions de Chrome).');
      return;
    }
    window.open(chrome.runtime.getURL('diagnostic.html'), '_blank');
  };

  return (
    <div className="app">
      <Halo engine={engine} />
      <header className="top">
        <div className="brand">
          CLUB<span>MAISON</span>
        </div>
        <span className={`live ${running && snap.onAir ? 'on' : ''}`}>
          <i />
          {running && snap.onAir ? 'EN DIRECT' : 'HORS ANTENNE'}
        </span>
        <span className="chip">{MODE_LABELS[engine.mode]}</span>
        {fast && <span className="chip">morceaux courts</span>}
        {!isExtension && (
          <span className="chip" title="Deezer et la capture d’onglet sont disponibles dans l’extension Chrome.">
            {location.hostname === "localhost" || location.hostname.startsWith("127.") ? "localhost" : "en ligne"}
          </span>
        )}
        <span className={`chip ${manual ? 'warn' : 'accent'}`}>{manual ? 'MANUEL' : 'PILOTE AUTO'}</span>
        <PartyClock engine={engine} running={running} />
        <div className="top-actions">
          {!running ? (
            <button className="primary" onClick={() => void start()} disabled={starting}>
              {starting ? 'Démarrage…' : 'Lancer la soirée'}
            </button>
          ) : (
            <button onClick={() => engine.conductor.stop()}>Pause</button>
          )}
          <button className="next-btn" disabled={!running} onClick={() => engine.conductor.requestSkip('bouton Suivant')} title="Suivant (flèche droite ou N)">
            Suivant
          </button>
          <button className={manual ? 'accent-outline' : ''} onClick={() => engine.conductor.setAutopilot(manual)}>
            {manual ? 'Rendre la main au pilote' : 'Je reprends la main'}
          </button>
          <button onClick={openAssistant}>Assistant d’installation</button>
        </div>
      </header>

      <WaveDisplay engine={engine} />
      <TransitionBar engine={engine} running={running} />

      <main className="stage">
        <DeckPanel engine={engine} id="A" manual={manual} onLoadNext={loadNext} connectError={engine.connectErrors.A} />
        <MixerPanel engine={engine} manual={manual} />
        <DeckPanel engine={engine} id="B" manual={manual} onLoadNext={loadNext} connectError={engine.connectErrors.B} />
      </main>

      <BottomTabs engine={engine} snap={snap} manual={manual} settings={settings} onSaveSettings={onSave} />
    </div>
  );
}

/** Lumière d'ambiance : léger halo vert acide qui pulse sur le kick du master. */
function Halo({ engine }: { engine: Engine }) {
  const ref = useRef<HTMLDivElement>(null);
  const lvl = useRef(0);
  useFrame((t) => {
    const f = getFrame(engine, t);
    const air = f.onAir;
    const b = engine.meters.bands('master');
    const kick = air ? Math.max(b.low, f.states[air].live?.lowEnergy ?? 0) : 0;
    lvl.current = Math.max(kick, lvl.current * 0.88);
    if (ref.current) ref.current.style.opacity = (Math.pow(lvl.current, 2.2) * 0.55).toFixed(3);
  });
  return <div className="halo" ref={ref} aria-hidden />;
}

function PartyClock({ engine, running }: { engine: Engine; running: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const t0 = useRef<number | undefined>(undefined);
  useFrame(() => {
    if (running && t0.current === undefined) t0.current = Date.now();
    const el = ref.current;
    if (!el) return;
    const now = new Date();
    const clock = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    let s = clock;
    if (t0.current !== undefined) {
      const m = Math.floor((Date.now() - t0.current) / 60000);
      s = `${clock} · soirée ${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
    }
    if (el.textContent !== s) el.textContent = s;
    void engine;
  });
  return <span className="clock mono" ref={ref} />;
}
