/**
 * Onglets Deezer servant de platines (extension uniquement) : affectation A/B, ouverture des
 * fenêtres normale et privée, reconnexion du son.
 */
import { useEffect, useState } from 'react';
import type { DeckId } from '../../../shared/contracts';
import { getBridge } from '../deezer/bridge';
import type { Assignment, TabInfo } from '../deezer/protocol';
import type { Engine } from '../engine';
import { isExtension } from '../lib/env';

export function DeezerTabsPanel({ engine }: { engine: Engine }) {
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [asg, setAsg] = useState<Assignment>({});
  const [incog, setIncog] = useState(false);
  useEffect(() => {
    if (!isExtension) return;
    return getBridge().onTabs((t, a, i) => {
      setTabs(t);
      setAsg(a);
      setIncog(i);
    });
  }, []);

  if (!isExtension) {
    return (
      <div className="s-sub disabled">
        Platines Deezer <span className="dim">· Disponible dans l’extension Chrome</span>
      </div>
    );
  }
  const b = getBridge();
  const name = (t: TabInfo) => `${t.incognito ? 'Privée' : 'Normale'} · ${t.hello?.userName ?? 'compte ?'} · onglet ${t.tabId}`;
  return (
    <div className="dz-tabs">
      <div className="s-sub">Platines Deezer</div>
      {!incog && <p className="hint warn">L’extension n’est pas autorisée en navigation privée : active-la dans chrome://extensions (Détails).</p>}
      {(['A', 'B'] as DeckId[]).map((d) => (
        <label key={d}>
          Platine {d}
          <select
            value={asg[d] ?? ''}
            onChange={(e) => {
              b.assign(d, e.target.value ? Number(e.target.value) : null);
              engine.resetConnection(d);
            }}
          >
            <option value="">(aucun onglet)</option>
            {tabs.map((t) => (
              <option key={t.tabId} value={t.tabId}>
                {name(t)}
              </option>
            ))}
          </select>
        </label>
      ))}
      <div className="btns">
        <button onClick={() => b.openDeezer(false)}>Ouvrir Deezer (fenêtre normale)</button>
        <button onClick={() => b.openDeezer(true)}>Ouvrir Deezer (fenêtre privée)</button>
        <button
          onClick={() => {
            engine.resetConnection('A');
            engine.resetConnection('B');
            void engine.connectDecks();
          }}
        >
          Reconnecter le son
        </button>
      </div>
    </div>
  );
}
