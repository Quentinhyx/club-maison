/**
 * Protocole de messages entre la console, le service worker et les onglets Deezer.
 *
 *   console (page extension) --Port "console"-->  service worker  --Port "deezer-tab"--> relais (monde isolé)
 *                                                                    --window.postMessage--> adaptateur (monde MAIN)
 */
import type { DeckCapabilities, DeckId, DeckStatus } from '../../../shared/contracts';

export const MAIN_SRC = 'club-maison/main';
export const RELAY_SRC = 'club-maison/relay';

export interface LoadTrack { id: number; title: string; artist: string; duration: number }

export type DeckCommand =
  | { op: 'load'; track: LoadTrack; startAt: number }
  | { op: 'play' }
  | { op: 'pause' }
  | { op: 'seek'; position: number }
  | { op: 'rate'; rate: number }
  | { op: 'probeRate' }
  | { op: 'diag' }
  | { op: 'setSink'; label: string };

export interface TabSnapshot {
  status: DeckStatus;
  position: number;
  duration: number;
  rate: number;
  trackId?: number;
  title?: string;
  artist?: string;
  caps: DeckCapabilities;
  error?: string;
  /** Date.now() côté onglet au moment de la mesure (même horloge que la console : même machine). */
  wall: number;
}

export type TabEvent = { type: 'state'; state: TabSnapshot } | { type: 'log'; msg: string };

export interface TabHello {
  url: string;
  userId?: string;
  userName?: string;
  playerObject: boolean;
}

export interface TabInfo {
  tabId: number;
  windowId: number;
  incognito: boolean;
  title: string;
  url: string;
  hello?: TabHello;
  lastState?: TabSnapshot;
}

export type Assignment = Partial<Record<DeckId, number>>;

export interface DiagReport {
  url: string;
  user?: { id?: string; name?: string };
  playerObject: { found: boolean; name?: string; methods: string[]; controlMethods: string[] };
  media: { intercepted: number; current?: { tag: string; src: string; paused: boolean; rate: number; preservesPitch: boolean; currentTime: number; duration: number; muted: boolean; volume: number } };
  webAudio: { contexts: number; mediaElementSources: number; bufferSources: number };
  mediaSession?: { title?: string; artist?: string };
  otherDevice: boolean;
  caps: DeckCapabilities;
  notes: string[];
}

// messages console <-> service worker
export type ConsoleToSw =
  | { kind: 'cmd'; id: string; deck: DeckId; cmd: DeckCommand }
  | { kind: 'cmd-tab'; id: string; tabId: number; cmd: DeckCommand }
  | { kind: 'list-tabs' }
  | { kind: 'assign'; deck: DeckId; tabId: number | null }
  | { kind: 'open-deezer'; incognito: boolean };

export type SwToConsole =
  | { kind: 'reply'; id: string; ok: boolean; result?: any; error?: string }
  | { kind: 'evt'; deck: DeckId | null; tabId: number; evt: TabEvent }
  | { kind: 'tabs'; tabs: TabInfo[]; assignment: Assignment; incognitoAllowed: boolean };

// messages service worker <-> onglet (relais) <-> monde MAIN
export type SwToTab = { kind: 'cmd'; id: string; cmd: DeckCommand };
export type TabToSw =
  | { kind: 'reply'; id: string; ok: boolean; result?: any; error?: string }
  | { kind: 'evt'; evt: TabEvent }
  | { kind: 'hello'; hello: TabHello };
