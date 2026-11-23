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
  /** L'hôte a choisi le style lui-même (sinon on peut le faire évoluer d'une version à l'autre). */
  styleTouched?: boolean;
  /** Migrations déjà faites (une seule fois chacune). */
  migrations?: string[];
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

/** Migrations des réglages sauvegardés (une fois chacune). */
export function migrateSettings(s: ConsoleSettings): ConsoleSettings {
  const done = new Set(s.migrations ?? []);
  let out = s;
  if (!done.has('style-soiree')) {
    // nouveau profil par défaut « Soirée » : on y passe sauf si l'hôte avait choisi son style à la main
    if (out.dj?.style === 'paris-tech-house' && !out.styleTouched) out = { ...out, dj: { ...out.dj, style: 'soiree' } };
    done.add('style-soiree');
    out = { ...out, migrations: [...done] };
  }
  return out;
}

/** Console servie en ligne (https, hors localhost) : l'API des invités est sur le même site. */
const hostedOrigin: string = (() => {
  try {
    if (isExtension) return 'https://club-maison.vercel.app';
    if (location.protocol !== 'https:') return '';
    return /^(localhost|127\.|\[::1\])/.test(location.hostname) ? '' : location.origin;
  } catch {
    return '';
  }
})();

function withDefaults(s: ConsoleSettings): ConsoleSettings {
  return s.apiUrl ? s : { ...s, apiUrl: hostedOrigin };
}

export async function loadSettings(): Promise<ConsoleSettings> {
  try {
    if (isExtension) {
      const r = await chrome.storage.local.get(KEY);
      const stored = r?.[KEY] as Partial<ConsoleSettings> | undefined;
      const m = migrateSettings({ ...DEFAULT_CONSOLE_SETTINGS, ...(stored ?? {}) });
      if (stored && (stored.migrations?.length ?? 0) !== (m.migrations?.length ?? 0)) await saveSettings(m);
      return withDefaults(m);
    }
    const raw = localStorage.getItem(KEY);
    const stored = raw ? (JSON.parse(raw) as Partial<ConsoleSettings>) : undefined;
    const m = migrateSettings({ ...DEFAULT_CONSOLE_SETTINGS, ...(stored ?? {}) });
    if (stored && (stored.migrations?.length ?? 0) !== (m.migrations?.length ?? 0)) await saveSettings(m);
    return withDefaults(m);
  } catch {
    return withDefaults({ ...DEFAULT_CONSOLE_SETTINGS });
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
