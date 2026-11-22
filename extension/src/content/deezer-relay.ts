/**
 * Relais (monde isolé) : fait passer les messages entre l'adaptateur du monde MAIN de la page Deezer
 * (window.postMessage) et le service worker (chrome.runtime Port "deezer-tab").
 * Construit en IIFE, sans import à l'exécution.
 */
import { MAIN_SRC, RELAY_SRC, type SwToTab, type TabToSw } from '../deezer/protocol';

let port: chrome.runtime.Port | undefined;
let lastHello: TabToSw | undefined;

function connect(): void {
  try {
    port = chrome.runtime.connect({ name: 'deezer-tab' });
  } catch {
    return; // extension rechargée : ce relais est orphelin
  }
  port.onMessage.addListener((m: SwToTab) => {
    window.postMessage({ source: RELAY_SRC, msg: m }, location.origin);
  });
  port.onDisconnect.addListener(() => {
    port = undefined;
    // le service worker MV3 peut s'endormir ou redémarrer : on se reconnecte
    setTimeout(() => {
      connect();
      if (lastHello && port) port.postMessage(lastHello);
    }, 1000);
  });
}

window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.source !== MAIN_SRC) return;
  const msg = e.data.msg as TabToSw;
  if (msg.kind === 'hello') lastHello = msg;
  if (!port) connect();
  try {
    port?.postMessage(msg);
  } catch {
    port = undefined;
  }
});

connect();
// demande à l'adaptateur de se présenter (il a pu démarrer avant le relais)
window.postMessage({ source: RELAY_SRC, msg: { kind: 'hello-request' } }, location.origin);
