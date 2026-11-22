/**
 * Liaison console <-> service worker (un seul Port partagé par les deux platines et le diagnostic).
 */
import type { DeckId } from '../../../shared/contracts';
import type { Assignment, ConsoleToSw, DeckCommand, SwToConsole, TabEvent, TabInfo } from './protocol';

type EvtListener = (deck: DeckId | null, tabId: number, evt: TabEvent) => void;
type TabsListener = (tabs: TabInfo[], assignment: Assignment, incognitoAllowed: boolean) => void;

let seq = 0;

export class ExtBridge {
  private port?: chrome.runtime.Port;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: any }>();
  private evt = new Set<EvtListener>();
  private tabsL = new Set<TabsListener>();
  tabs: TabInfo[] = [];
  assignment: Assignment = {};
  incognitoAllowed = false;

  private ensure(): chrome.runtime.Port {
    if (this.port) return this.port;
    const p = chrome.runtime.connect({ name: 'console' });
    p.onMessage.addListener((m: SwToConsole) => this.onMessage(m));
    p.onDisconnect.addListener(() => {
      this.port = undefined;
      for (const [, w] of this.pending) {
        clearTimeout(w.timer);
        w.reject(new Error('Liaison avec le service worker perdue'));
      }
      this.pending.clear();
      // reconnexion (le service worker MV3 peut redémarrer)
      setTimeout(() => {
        try {
          this.ensure();
          this.post({ kind: 'list-tabs' });
        } catch {
          /* extension rechargée */
        }
      }, 500);
    });
    this.port = p;
    return p;
  }

  private post(m: ConsoleToSw): void {
    this.ensure().postMessage(m);
  }

  private onMessage(m: SwToConsole): void {
    if (m.kind === 'reply') {
      const w = this.pending.get(m.id);
      if (!w) return;
      this.pending.delete(m.id);
      clearTimeout(w.timer);
      if (m.ok) w.resolve(m.result);
      else w.reject(new Error(m.error || 'Commande refusée'));
    } else if (m.kind === 'evt') {
      for (const l of this.evt) l(m.deck, m.tabId, m.evt);
    } else if (m.kind === 'tabs') {
      this.tabs = m.tabs;
      this.assignment = m.assignment;
      this.incognitoAllowed = m.incognitoAllowed;
      for (const l of this.tabsL) l(m.tabs, m.assignment, m.incognitoAllowed);
    }
  }

  private request<T>(build: (id: string) => ConsoleToSw, timeoutMs: number): Promise<T> {
    const id = `c${Date.now().toString(36)}${(seq++).toString(36)}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Pas de réponse de l’onglet Deezer (délai dépassé)'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.post(build(id));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  command<T = any>(deck: DeckId, cmd: DeckCommand, timeoutMs = 8000): Promise<T> {
    return this.request<T>((id) => ({ kind: 'cmd', id, deck, cmd }), timeoutMs);
  }

  commandTab<T = any>(tabId: number, cmd: DeckCommand, timeoutMs = 8000): Promise<T> {
    return this.request<T>((id) => ({ kind: 'cmd-tab', id, tabId, cmd }), timeoutMs);
  }

  refreshTabs(): void {
    this.post({ kind: 'list-tabs' });
  }

  assign(deck: DeckId, tabId: number | null): void {
    this.post({ kind: 'assign', deck, tabId });
  }

  openDeezer(incognito: boolean): void {
    this.post({ kind: 'open-deezer', incognito });
  }

  onEvent(l: EvtListener): () => void {
    this.ensure();
    this.evt.add(l);
    return () => this.evt.delete(l);
  }

  onTabs(l: TabsListener): () => void {
    this.ensure();
    this.tabsL.add(l);
    l(this.tabs, this.assignment, this.incognitoAllowed);
    this.post({ kind: 'list-tabs' });
    return () => this.tabsL.delete(l);
  }

  /** Attend la liste des onglets (au plus `ms`). */
  async waitTabs(ms = 1500): Promise<TabInfo[]> {
    return new Promise((resolve) => {
      let done = false;
      const off = this.onTabs((tabs) => {
        if (done || !tabs.length) return;
        done = true;
        setTimeout(() => off(), 0);
        resolve(tabs);
      });
      setTimeout(() => {
        if (done) return;
        done = true;
        off();
        resolve(this.tabs);
      }, ms);
    });
  }
}

let shared: ExtBridge | undefined;
export function getBridge(): ExtBridge {
  shared ??= new ExtBridge();
  return shared;
}
