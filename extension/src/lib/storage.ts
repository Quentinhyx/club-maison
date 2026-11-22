/**
 * Réglages persistants : chrome.storage.local dans l'extension, localStorage en localhost.
 */
import type { DjSettings } from '../../../shared/contracts';
import { isExtension } from './env';

export type DeckMode = 'synth' | 'preview' | 'deezer';
export type CaptureMode = 'tab' | 'device';

export interface ConsoleSettings {
  apiUrl: string;          // ex. https://club-maison.vercel.app (sans / final)
  hostKey: string;
  party: string;
  deckMode: DeckMode;
  captureMode: CaptureMode;
  /** Périphériques virtuels (repli BlackHole) : libellés recherchés côté console et côté Deezer. */
  deviceLabelA: string;
  deviceLabelB: string;
  /** Sortie de la console (vraies enceintes), deviceId ou '' = défaut. */
  outputDeviceId: string;
  /** Latence de capture ajoutée (s), utilisée pour caler la phase des platines Deezer. */
  captureLatency: number;
  dj?: Partial<DjSettings>;
}

export const DEFAULT_CONSOLE_SETTINGS: ConsoleSettings = {
  apiUrl: '',
  hostKey: '',
  party: 'maison',
  deckMode: isExtension ? 'deezer' : 'synth',
  captureMode: 'tab',
  deviceLabelA: 'BlackHole 2ch',
  deviceLabelB: 'BlackHole 16ch',
  outputDeviceId: '',
  captureLatency: 0.12,
};

const KEY = 'clubMaison.settings';

export async function loadSettings(): Promise<ConsoleSettings> {
  try {
    if (isExtension) {
      const r = await chrome.storage.local.get(KEY);
      return { ...DEFAULT_CONSOLE_SETTINGS, ...((r?.[KEY] as Partial<ConsoleSettings>) ?? {}) };
    }
    const raw = localStorage.getItem(KEY);
    return { ...DEFAULT_CONSOLE_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULT_CONSOLE_SETTINGS };
  }
}

export async function saveSettings(s: ConsoleSettings): Promise<void> {
  try {
    if (isExtension) await chrome.storage.local.set({ [KEY]: s });
    else localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* stockage indisponible : réglages gardés en mémoire */
  }
}
