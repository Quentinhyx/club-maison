/**
 * Assistant d'installation et diagnostic : teste pas à pas ce dont la console a besoin et dit en
 * français ce qui marche et quoi faire.
 */
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import type { DeckId } from '../../../shared/contracts';
import { getBridge } from '../deezer/bridge';
import { captureTab, findInputDevice, unlockDeviceLabels } from '../deezer/capture';
import type { DiagReport, TabInfo } from '../deezer/protocol';
import { isExtension } from '../lib/env';
import './diagnostic.css';

type St = 'idle' | 'run' | 'ok' | 'warn' | 'fail';
interface Res { st: St; title: string; detail?: string; advice?: string; extra?: string[] }

const STEPS = ['incognito', 'tabs', 'player-A', 'player-B', 'rate', 'capture-A', 'capture-B', 'both', 'blackhole'] as const;
type Step = (typeof STEPS)[number];

const TITLES: Record<Step, string> = {
  incognito: 'Extension autorisée en navigation privée',
  tabs: 'Deux onglets Deezer, deux comptes différents',
  'player-A': 'Platine A : lecteur Deezer détecté',
  'player-B': 'Platine B : lecteur Deezer détecté',
  rate: 'Vitesse de lecture réglable (calage du tempo)',
  'capture-A': 'Capture du son de la platine A',
  'capture-B': 'Capture du son de la platine B',
  both: 'Les deux platines jouent en même temps',
  blackhole: 'Solution de repli BlackHole',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function measureLevel(stream: MediaStream, seconds = 3): Promise<number> {
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser();
  an.fftSize = 2048;
  src.connect(an);
  // la capture coupe le son local de l'onglet : on le renvoie aux haut-parleurs pendant le test
  src.connect(ctx.destination);
  const buf = new Float32Array(an.fftSize);
  let peak = 0;
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    an.getFloatTimeDomainData(buf);
    let s = 0;
    for (const v of buf) s += v * v;
    peak = Math.max(peak, Math.sqrt(s / buf.length));
    await sleep(50);
  }
  await ctx.close();
  return peak;
}

function App() {
  const [res, setRes] = useState<Partial<Record<Step, Res>>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: Step, r: Omit<Res, 'title'>) => setRes((p) => ({ ...p, [k]: { title: TITLES[k], ...r } }));

  const tabsFor = async (): Promise<{ tabs: TabInfo[]; asg: Partial<Record<DeckId, number>> }> => {
    const b = getBridge();
    const tabs = await b.waitTabs(1500);
    return { tabs, asg: b.assignment };
  };

  const run = async (only?: Step) => {
    setBusy(true);
    const want = (s: Step) => !only || only === s;
    try {
      if (!isExtension) {
        set('incognito', { st: 'fail', detail: 'Cette page n’est pas ouverte depuis l’extension Chrome.', advice: 'Installe l’extension (voir la notice ci-dessous) puis ouvre l’assistant depuis la console de l’extension.' });
      }
      const b = isExtension ? getBridge() : undefined;
      if (b && want('incognito')) {
        set('incognito', { st: 'run' });
        const ok = await chrome.extension.isAllowedIncognitoAccess();
        set('incognito', ok ? { st: 'ok', detail: 'La platine B peut tourner dans une fenêtre privée.' } : { st: 'fail', detail: 'Refusé.', advice: 'chrome://extensions > Club Maison > Détails > « Autoriser en navigation privée ».' });
      }
      let tabs: TabInfo[] = [];
      let asg: Partial<Record<DeckId, number>> = {};
      if (b) ({ tabs, asg } = await tabsFor());
      if (b && want('tabs')) {
        const normal = tabs.filter((t) => !t.incognito);
        const priv = tabs.filter((t) => t.incognito);
        const users = new Set(tabs.map((t) => t.hello?.userId).filter(Boolean));
        const ta = tabs.find((t) => t.tabId === asg.A);
        const tb = tabs.find((t) => t.tabId === asg.B);
        const extra = tabs.map((t) => `${t.incognito ? 'Privée ' : 'Normale'} · onglet ${t.tabId} · compte ${t.hello?.userName ?? '?'} (${t.hello?.userId ?? 'id inconnu'})${t.tabId === asg.A ? ' · platine A' : t.tabId === asg.B ? ' · platine B' : ''}`);
        if (!tabs.length) set('tabs', { st: 'fail', detail: 'Aucun onglet www.deezer.com détecté.', advice: 'Ouvre www.deezer.com dans une fenêtre normale (compte 1) et dans une fenêtre privée (compte 2), connecte-toi, puis recharge ces onglets.' });
        else if (!ta || !tb) set('tabs', { st: 'fail', detail: `Un seul onglet Deezer (${normal.length} normal, ${priv.length} privé).`, advice: 'Il faut deux onglets : un en fenêtre normale, un en fenêtre privée.', extra });
        else if (ta.hello?.userId && tb.hello?.userId && ta.hello.userId === tb.hello.userId) set('tabs', { st: 'fail', detail: 'Les deux platines utilisent le même compte Deezer.', advice: 'Dans la fenêtre privée, connecte-toi avec un autre profil de l’abonnement Famille (sinon Deezer coupe l’une des deux).', extra });
        else if (!ta.hello?.userId || !tb.hello?.userId) set('tabs', { st: 'warn', detail: 'Deux onglets trouvés, mais un compte n’a pas pu être identifié.', advice: 'Vérifie que tu es bien connecté dans les deux onglets (avec deux comptes différents).', extra });
        else set('tabs', { st: 'ok', detail: `Deux comptes différents (${users.size}).`, extra });
      }
      const diags: Partial<Record<DeckId, DiagReport>> = {};
      for (const d of ['A', 'B'] as DeckId[]) {
        const k = `player-${d}` as Step;
        if (!b || !want(k)) continue;
        set(k, { st: 'run' });
        try {
          const r = await b.command<DiagReport>(d, { op: 'diag' }, 8000);
          diags[d] = r;
          const extra = [
            `Objet lecteur : ${r.playerObject.found ? r.playerObject.name : 'absent'}`,
            ...(r.playerObject.methods.length ? [`Méthodes : ${r.playerObject.methods.slice(0, 40).join(', ')}${r.playerObject.methods.length > 40 ? '…' : ''}`] : []),
            ...(r.playerObject.controlMethods.length ? [`control : ${r.playerObject.controlMethods.join(', ')}`] : []),
            `Éléments média interceptés : ${r.media.intercepted}${r.media.current ? ` (${r.media.current.tag}, ${r.media.current.paused ? 'en pause' : 'en lecture'}, vitesse ${r.media.current.rate})` : ''}`,
            `Web Audio : ${r.webAudio.contexts} contexte(s), ${r.webAudio.mediaElementSources} source(s) média, ${r.webAudio.bufferSources} buffer(s)`,
            `Titre en cours (mediaSession) : ${r.mediaSession?.title ?? '—'}`,
            ...r.notes,
          ];
          if (r.otherDevice) set(k, { st: 'fail', detail: 'Deezer dit que ce compte joue sur un autre appareil.', advice: 'Chaque platine doit avoir son propre compte Famille.', extra });
          else if (!r.media.current) set(k, { st: 'warn', detail: 'Onglet connecté, mais aucun son intercepté pour l’instant.', advice: 'Lance n’importe quel titre dans cet onglet, puis relance ce test.', extra });
          else set(k, { st: 'ok', detail: `Lecteur piloté${r.playerObject.found ? ' (objet lecteur + élément média)' : ' (élément média)'}.`, extra });
        } catch (e) {
          set(k, { st: 'fail', detail: String((e as Error).message), advice: 'Recharge l’onglet Deezer de cette platine (l’extension doit y être active), puis réessaie.' });
        }
      }
      if (b && want('rate')) {
        set('rate', { st: 'run' });
        const lines: string[] = [];
        let all = true;
        for (const d of ['A', 'B'] as DeckId[]) {
          try {
            const r = await b.command<{ ok: boolean; readBack: number; after: number }>(d, { op: 'probeRate' }, 5000);
            lines.push(`Platine ${d} : ${r.ok ? 'vitesse modifiable' : `refusée (lu ${r.readBack}, puis ${r.after})`}`);
            all &&= r.ok;
          } catch (e) {
            lines.push(`Platine ${d} : ${(e as Error).message}`);
            all = false;
          }
        }
        set('rate', all ? { st: 'ok', detail: 'Le calage du tempo fonctionnera.', extra: lines } : { st: 'warn', detail: 'Vitesse non réglable sur au moins une platine.', advice: 'Le DJ fonctionnera quand même, avec des transitions sans calage (écho, coupe, réverb). Lance un titre puis relance ce test.', extra: lines });
      }
      for (const d of ['A', 'B'] as DeckId[]) {
        const k = `capture-${d}` as Step;
        if (!b || !want(k)) continue;
        set(k, { st: 'run', detail: 'Capture en cours, mesure du niveau pendant 3 s…' });
        const tabId = asg[d];
        if (tabId === undefined) {
          set(k, { st: 'fail', detail: 'Pas d’onglet pour cette platine.' });
          continue;
        }
        try {
          await b.command(d, { op: 'play' }, 8000).catch(() => {});
          const stream = await captureTab(tabId);
          const lvl = await measureLevel(stream, 3);
          stream.getTracks().forEach((t) => t.stop());
          await b.command(d, { op: 'pause' }, 5000).catch(() => {});
          const db = 20 * Math.log10(lvl + 1e-9);
          if (lvl < 0.0005) set(k, { st: 'fail', detail: `Capture acceptée mais muette (${db.toFixed(0)} dBFS).`, advice: 'Vérifie qu’un titre joue dans cet onglet. Si c’est muet malgré tout, utilise la solution BlackHole.' });
          else set(k, { st: 'ok', detail: `Son capté (${db.toFixed(0)} dBFS).` });
        } catch (e) {
          set(k, { st: 'fail', detail: (e as Error).message, advice: d === 'B' ? 'Si Chrome refuse de capturer la fenêtre privée, passe à la solution BlackHole (Réglages > Source des platines).' : 'Ferme la console si elle est ouverte (un onglet ne peut être capturé qu’une fois), clique sur l’icône Club Maison dans l’onglet Deezer, puis réessaie.' });
        }
      }
      if (b && want('both')) {
        set('both', { st: 'run', detail: 'Lecture des deux platines pendant 8 s…' });
        try {
          await Promise.all((['A', 'B'] as DeckId[]).map((d) => b.command(d, { op: 'play' }, 8000)));
          await sleep(8000);
          const { tabs: t2, asg: a2 } = await tabsFor();
          const st = (d: DeckId) => t2.find((t) => t.tabId === a2[d])?.lastState;
          const sa = st('A');
          const sb = st('B');
          await Promise.all((['A', 'B'] as DeckId[]).map((d) => b.command(d, { op: 'pause' }, 5000).catch(() => {})));
          const extra = [`A : ${sa?.status ?? '?'}${sa?.error ? ` (${sa.error})` : ''}`, `B : ${sb?.status ?? '?'}${sb?.error ? ` (${sb.error})` : ''}`];
          if (sa?.status === 'playing' && sb?.status === 'playing') set('both', { st: 'ok', detail: 'Deezer laisse jouer les deux comptes en même temps.', extra });
          else set('both', { st: 'fail', detail: 'Une platine s’est arrêtée.', advice: 'Deezer coupe un compte quand il joue ailleurs : utilise deux comptes différents de la Famille.', extra });
        } catch (e) {
          set('both', { st: 'fail', detail: (e as Error).message });
        }
      }
      if (want('blackhole')) {
        set('blackhole', { st: 'run' });
        try {
          await unlockDeviceLabels();
          const a = await findInputDevice('BlackHole 2ch');
          const bb = await findInputDevice('BlackHole 16ch');
          const sink = 'setSinkId' in AudioContext.prototype;
          const extra = [`BlackHole 2ch : ${a ? 'présent' : 'absent'}`, `BlackHole 16ch : ${bb ? 'présent' : 'absent'}`, `Choix de la sortie audio de la console : ${sink ? 'possible' : 'non pris en charge par ce Chrome'}`];
          if (a && bb) set('blackhole', { st: 'ok', detail: 'Les deux périphériques virtuels sont installés.', extra });
          else set('blackhole', { st: 'warn', detail: 'Facultatif : seulement si la capture d’onglet ne marche pas.', advice: 'Installe BlackHole 2ch et BlackHole 16ch (gratuits) depuis existential.audio/blackhole, puis recharge cette page.', extra });
        } catch (e) {
          const nf = (e as Error).name === 'NotFoundError';
          set('blackhole', nf
            ? { st: 'warn', detail: 'Aucune entrée audio sur ce Mac : BlackHole n’est pas installé.', advice: 'Facultatif : installe BlackHole 2ch et 16ch (existential.audio/blackhole) seulement si la capture d’onglet échoue.' }
            : { st: 'warn', detail: `Accès au micro refusé (${(e as Error).message}).`, advice: 'Autorise le micro pour l’extension : c’est ce qui permet de lire le nom des périphériques audio.' });
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dg">
      <header>
        <div className="brand">
          CLUB<span>MAISON</span>
        </div>
        <h1>Assistant d’installation</h1>
        <button className="primary" disabled={busy} onClick={() => void run()}>
          {busy ? 'Tests en cours…' : 'Lancer tous les tests'}
        </button>
      </header>
      <main>
        <section className="tests">
          <h2>Diagnostic</h2>
          <p className="dim">Avant de lancer : ouvre Deezer dans les deux fenêtres, connecte-toi avec deux comptes, et lance un titre dans chacune. La console doit être fermée pendant les tests de capture.</p>
          <ol>
            {STEPS.map((s) => {
              const r = res[s];
              return (
                <li key={s} className={`t t-${r?.st ?? 'idle'}`}>
                  <div className="t-head">
                    <span className="dot" />
                    <span className="t-title">{TITLES[s]}</span>
                    <span className="t-st">{r ? { idle: '', run: 'EN COURS', ok: 'OK', warn: 'À VÉRIFIER', fail: 'À CORRIGER' }[r.st] : ''}</span>
                    <button disabled={busy} onClick={() => void run(s)}>
                      Tester
                    </button>
                  </div>
                  {r?.detail && <div className="t-detail">{r.detail}</div>}
                  {r?.advice && <div className="t-advice">À faire : {r.advice}</div>}
                  {r?.extra && (
                    <ul className="t-extra mono">
                      {r.extra.map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
        <section className="guide">
          <h2>Notice pas à pas</h2>
          <ol>
            <li>
              <b>Installer l’extension.</b> Dans le dossier du projet : <code>npm install</code> puis <code>npm run build:ext</code>. Ouvre <code>chrome://extensions</code>, active le <i>mode développeur</i>, clique <i>Charger l’extension non empaquetée</i> et choisis le dossier <code>extension-dist</code>.
            </li>
            <li>
              <b>Autoriser la navigation privée.</b> Sur la carte Club Maison : <i>Détails</i> puis <i>Autoriser en navigation privée</i>.
            </li>
            <li>
              <b>Platine A.</b> Fenêtre normale : ouvre www.deezer.com et connecte-toi avec le compte 1.
            </li>
            <li>
              <b>Platine B.</b> Fenêtre de navigation privée (Cmd + Maj + N) : ouvre www.deezer.com et connecte-toi avec le compte 2 (un autre profil de l’abonnement Famille).
            </li>
            <li>
              <b>Garder les deux fenêtres visibles</b> (pas réduites dans le Dock) : Chrome ralentit les onglets cachés.
            </li>
            <li>
              <b>Lancer ce diagnostic</b> avec un titre en lecture dans chaque fenêtre. Corrige ce qui est en rouge.
            </li>
            <li>
              <b>Ouvrir la console</b> (icône Club Maison), brancher l’enceinte sur le Mac, puis <i>Lancer la soirée</i>. Le son des onglets Deezer est coupé localement : tout passe par la table de mixage de la console.
            </li>
            <li>
              <b>Si la capture échoue ou reste muette</b> (souvent pour la fenêtre privée) : installe BlackHole 2ch et BlackHole 16ch (gratuits, existential.audio/blackhole). Dans la console : Réglages &gt; Source des platines &gt; Périphériques BlackHole. Chrome demandera l’accès au micro dans la console et dans chaque onglet Deezer (pour choisir la sortie audio) : accepte.
            </li>
            <li>
              <b>Pour tester sans Deezer</b> : Réglages &gt; Source des platines &gt; Démo hors ligne (morceaux de démonstration générés par le Mac).
            </li>
          </ol>
        </section>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
