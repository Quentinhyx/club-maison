/**
 * Service worker de l'extension Club Maison (Manifest V3, mode "spanning" : un seul service worker
 * pour les fenêtres normales ET de navigation privée).
 *
 *  - tient la liste des onglets Deezer (chaque onglet ouvre un Port "deezer-tab" via le relais) ;
 *  - affecte les onglets aux platines : A = fenêtre normale, B = fenêtre privée (modifiable) ;
 *  - relaie les commandes de la console vers l'onglet de la platine et les événements en retour ;
 *  - clic sur l'icône : ouvre (ou ramène) la console ; sur un onglet Deezer, ce clic "invoque"
 *    aussi l'extension pour cet onglet, ce que Chrome peut exiger pour autoriser sa capture.
 */
import type { DeckId } from '../../shared/contracts';
import { computeAssignment, RELOAD_GRACE_MS } from './deezer/assign';
import type { Assignment, ConsoleToSw, SwToConsole, SwToTab, TabInfo, TabToSw } from './deezer/protocol';

interface TabEntry extends TabInfo {
  port: chrome.runtime.Port;
  /** Port fermé (rechargement de l'onglet) : on garde la platine RELOAD_GRACE_MS. */
  goneAt?: number;
}

const tabs = new Map<number, TabEntry>();
const consoles = new Set<chrome.runtime.Port>();
const pending = new Map<string, chrome.runtime.Port>(); // id commande -> console qui attend la réponse
let assignment: Assignment = {};
let manual: Assignment = {}; // choix explicites de l'hôte

const DEEZER_URL = 'https://www.deezer.com/fr/';

async function restore(): Promise<void> {
  try {
    const r = await chrome.storage.session.get('manualAssignment');
    manual = (r?.manualAssignment as Assignment) ?? {};
  } catch {
    /* stockage de session indisponible */
  }
}
void restore();

function recompute(): void {
  const list = [...tabs.values()].map((t) => ({ tabId: t.tabId, incognito: t.incognito, goneAt: t.goneAt }));
  assignment = computeAssignment(list, manual, assignment, Date.now());
}

function deckOf(tabId: number): DeckId | null {
  if (assignment.A === tabId) return 'A';
  if (assignment.B === tabId) return 'B';
  return null;
}

async function broadcastTabs(): Promise<void> {
  recompute();
  let incognitoAllowed = false;
  try {
    incognitoAllowed = await chrome.extension.isAllowedIncognitoAccess();
  } catch {
    /* rien */
  }
  const msg: SwToConsole = {
    kind: 'tabs',
    tabs: [...tabs.values()].filter((t) => t.goneAt === undefined).map(({ port: _p, goneAt: _g, ...t }) => t),
    assignment,
    incognitoAllowed,
  };
  for (const c of consoles) safePost(c, msg);
}

function safePost(p: chrome.runtime.Port, m: unknown): void {
  try {
    p.postMessage(m);
  } catch {
    /* port fermé */
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'deezer-tab') {
    const tab = port.sender?.tab;
    if (!tab?.id) return;
    const entry: TabEntry = {
      tabId: tab.id,
      windowId: tab.windowId,
      incognito: tab.incognito,
      title: tab.title ?? 'Deezer',
      url: tab.url ?? '',
      port,
    };
    tabs.set(tab.id, entry);
    port.onMessage.addListener((m: TabToSw) => {
      if (m.kind === 'hello') {
        entry.hello = m.hello;
        void broadcastTabs();
      } else if (m.kind === 'reply') {
        const c = pending.get(m.id);
        pending.delete(m.id);
        if (c) safePost(c, m satisfies SwToConsole);
      } else if (m.kind === 'evt') {
        if (m.evt.type === 'state') entry.lastState = m.evt.state;
        const out: SwToConsole = { kind: 'evt', deck: deckOf(entry.tabId), tabId: entry.tabId, evt: m.evt };
        for (const c of consoles) safePost(c, out);
      }
    });
    port.onDisconnect.addListener(() => {
      if (tabs.get(entry.tabId)?.port !== port) return;
      // rechargement probable : la platine reste affectée quelques secondes
      entry.goneAt = Date.now();
      void broadcastTabs();
      setTimeout(() => {
        const cur = tabs.get(entry.tabId);
        if (cur === entry && entry.goneAt !== undefined) {
          tabs.delete(entry.tabId);
          void broadcastTabs();
        }
      }, RELOAD_GRACE_MS + 100);
    });
    void broadcastTabs();
    return;
  }

  if (port.name === 'console') {
    consoles.add(port);
    port.onDisconnect.addListener(() => {
      consoles.delete(port);
      for (const [id, p] of pending) if (p === port) pending.delete(id);
    });
    port.onMessage.addListener((m: ConsoleToSw) => void onConsole(port, m));
    void broadcastTabs();
  }
});

async function onConsole(port: chrome.runtime.Port, m: ConsoleToSw): Promise<void> {
  switch (m.kind) {
    case 'list-tabs':
      await broadcastTabs();
      break;
    case 'assign':
      if (m.tabId === null) delete manual[m.deck];
      else {
        manual[m.deck] = m.tabId;
        const otherDeck: DeckId = m.deck === 'A' ? 'B' : 'A';
        if (manual[otherDeck] === m.tabId) delete manual[otherDeck];
      }
      try {
        await chrome.storage.session.set({ manualAssignment: manual });
      } catch {
        /* rien */
      }
      await broadcastTabs();
      break;
    case 'open-deezer':
      try {
        if (m.incognito) {
          const allowed = await chrome.extension.isAllowedIncognitoAccess();
          if (!allowed) {
            safePost(port, {
              kind: 'evt',
              deck: null,
              tabId: -1,
              evt: { type: 'log', msg: 'Autorise l’extension en navigation privée (chrome://extensions > Club Maison > Détails).' },
            } satisfies SwToConsole);
            return;
          }
          await chrome.windows.create({ url: DEEZER_URL, incognito: true });
        } else {
          await chrome.windows.create({ url: DEEZER_URL });
        }
      } catch (e) {
        safePost(port, { kind: 'evt', deck: null, tabId: -1, evt: { type: 'log', msg: `Ouverture impossible : ${String(e)}` } } satisfies SwToConsole);
      }
      break;
    case 'cmd':
    case 'cmd-tab': {
      const tabId = m.kind === 'cmd' ? assignment[m.deck] : m.tabId;
      const entry = tabId !== undefined ? tabs.get(tabId) : undefined;
      if (!entry || entry.goneAt !== undefined) {
        const where = m.kind === 'cmd' ? `la platine ${m.deck}` : `l’onglet ${m.tabId}`;
        safePost(port, { kind: 'reply', id: m.id, ok: false, error: `Aucun onglet Deezer connecté pour ${where}. Ouvre www.deezer.com puis recharge l’onglet.` } satisfies SwToConsole);
        return;
      }
      pending.set(m.id, port);
      safePost(entry.port, { kind: 'cmd', id: m.id, cmd: m.cmd } satisfies SwToTab);
      break;
    }
  }
}

// Clic sur l'icône : ouvre ou ramène la console.
chrome.action.onClicked.addListener(async (tab) => {
  const url = chrome.runtime.getURL('console.html');
  if (tab?.url?.startsWith('https://www.deezer.com/')) {
    // l'extension est maintenant "invoquée" sur cet onglet (activeTab) : sa capture est autorisée.
    // On reste sur l'onglet Deezer, on ne fait que signaler à la console.
    for (const c of consoles) safePost(c, { kind: 'evt', deck: deckOf(tab.id!), tabId: tab.id!, evt: { type: 'log', msg: 'Capture autorisée pour cet onglet Deezer.' } } satisfies SwToConsole);
    if (consoles.size) return;
  }
  const existing = await chrome.tabs.query({ url });
  if (existing[0]?.id) {
    await chrome.tabs.update(existing[0].id, { active: true });
    if (existing[0].windowId) await chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});

chrome.tabs.onRemoved.addListener((id) => {
  if (tabs.delete(id)) void broadcastTabs();
});
