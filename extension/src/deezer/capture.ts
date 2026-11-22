/**
 * Capture du son des platines Deezer.
 *
 * 1. Capture d'onglet (par défaut) : chrome.tabCapture.getMediaStreamId({ targetTabId, consumerTabId })
 *    puis getUserMedia({ chromeMediaSource: 'tab' }) dans la console. Le son local de l'onglet est
 *    coupé pendant la capture : c'est voulu, tout passe par la table de mixage.
 *    Hypothèse : Chrome peut exiger que l'extension ait été "invoquée" sur l'onglet (clic sur l'icône
 *    de l'extension dans cet onglet, équivalent activeTab). Le message d'erreur le dit alors.
 *    Hypothèse : la capture d'un onglet de navigation privée depuis la console (fenêtre normale) est
 *    permise en mode "spanning" si l'extension est autorisée en navigation privée. Sinon : repli 2.
 * 2. Repli périphérique virtuel (BlackHole 2ch / 16ch) : l'onglet Deezer envoie son son vers le
 *    périphérique (setSinkId), la console l'écoute avec getUserMedia({ deviceId }).
 */

export async function currentTabId(): Promise<number | undefined> {
  try {
    const t = await chrome.tabs.getCurrent();
    return t?.id;
  } catch {
    return undefined;
  }
}

export async function captureTab(targetTabId: number): Promise<MediaStream> {
  const consumerTabId = await currentTabId();
  const streamId = await new Promise<string>((resolve, reject) => {
    try {
      chrome.tabCapture.getMediaStreamId({ targetTabId, consumerTabId }, (id) => {
        const err = chrome.runtime.lastError;
        if (err || !id) reject(new Error(explainCaptureError(err?.message)));
        else resolve(id);
      });
    } catch (e) {
      reject(new Error(explainCaptureError(e instanceof Error ? e.message : String(e))));
    }
  });
  return navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } as any,
    video: false,
  });
}

export function explainCaptureError(msg?: string): string {
  const m = msg ?? '';
  if (/invoked|activeTab/i.test(m)) {
    return 'Chrome demande d’autoriser la capture : va dans l’onglet Deezer de cette platine, clique une fois sur l’icône Club Maison (rien ne s’affiche, c’est normal), puis réessaie.';
  }
  if (/active stream|already/i.test(m)) return 'Cet onglet est déjà capturé (ferme les autres consoles ouvertes).';
  if (/incognito|off.?the.?record/i.test(m)) {
    return 'Chrome refuse de capturer l’onglet de navigation privée. Utilise la solution BlackHole (voir l’assistant d’installation).';
  }
  return `Capture d’onglet refusée${m ? ` (${m})` : ''}. Essaie la solution BlackHole (assistant d’installation).`;
}

/** Demande l'autorisation micro (nécessaire pour lire les noms des périphériques audio). */
export async function unlockDeviceLabels(): Promise<void> {
  const s = await navigator.mediaDevices.getUserMedia({ audio: true });
  s.getTracks().forEach((t) => t.stop());
}

export async function findInputDevice(label: string): Promise<MediaDeviceInfo | undefined> {
  let devs = await navigator.mediaDevices.enumerateDevices();
  if (!devs.some((d) => d.label)) {
    await unlockDeviceLabels();
    devs = await navigator.mediaDevices.enumerateDevices();
  }
  const l = label.toLowerCase();
  return devs.find((d) => d.kind === 'audioinput' && d.label.toLowerCase().includes(l));
}

export async function captureDevice(label: string): Promise<MediaStream> {
  const dev = await findInputDevice(label);
  if (!dev) throw new Error(`Périphérique « ${label} » introuvable. Installe BlackHole (existential.audio/blackhole) puis recharge la console.`);
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: dev.deviceId },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
    },
    video: false,
  });
}
