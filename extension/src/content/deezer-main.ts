/**
 * Adaptateur du lecteur web Deezer, exécuté dans le MONDE PRINCIPAL de www.deezer.com au
 * document_start (avant les scripts de Deezer). Construit en IIFE, sans import à l'exécution.
 *
 * On ne peut pas vérifier l'interface réelle de Deezer depuis l'atelier : tout est détecté à
 * l'exécution, avec plusieurs stratégies par fonction, et chaque hypothèse est notée [H…].
 *
 *  [H1] Objet global du lecteur : historiquement `window.dzPlayer` (méthodes getSongId,
 *       getCurrentSong, getPosition, getDuration, isPlaying, control.play/pause/seek(ratio)…).
 *       S'il existe, on liste ses méthodes dans le diagnostic et on s'en sert en priorité pour
 *       lecture/pause/position. Sa signature exacte n'est pas garantie : chaque appel est vérifié.
 *  [H2] Le son sort d'un élément <audio>/<video> (MSE) : on l'intercepte en patchant
 *       HTMLMediaElement.prototype.play, document.createElement et le constructeur Audio. On lit
 *       currentTime/duration, on règle playbackRate (preservesPitch = true) et on tente le seek.
 *  [H3] Si le lecteur passe par Web Audio (AudioContext) sans élément média, la vitesse ne peut
 *       pas être réglée : canSetRate = false.
 *  [H4] Chargement d'un titre : la page https://www.deezer.com/fr/track/{id} contient un bouton
 *       de lecture (data-testid ou aria-label « Écouter »/« Lecture »/« Play »). Navigation
 *       d'abord sans rechargement (history.pushState + popstate, routeur de l'appli), sinon
 *       rechargement complet (la commande en cours est reprise après rechargement).
 *  [H5] Identité du titre en cours : dzPlayer, sinon navigator.mediaSession.metadata (que Deezer
 *       renseigne pour les touches multimédia), sinon le lien /track/ID de la barre du lecteur.
 *  [H6] « Deezer est utilisé sur un autre appareil » s'affiche dans une fenêtre/bandeau
 *       (role=dialog/alert) : détecté par son texte (français et anglais).
 *  [H7] Les comptes Famille ont leur identifiant dans https://www.deezer.com/ajax/gw-light.php
 *       (méthode deezer.getUserData, lecture seule, même origine) : sert à vérifier que les deux
 *       platines utilisent des comptes différents.
 *  [H8] Un onglet caché et silencieux voit ses minuteurs ralentis par Chrome : les commandes
 *       arrivent par événements (postMessage), mais les attentes internes peuvent prendre ~1 s.
 *       Garder les deux fenêtres Deezer visibles (pas réduites) est plus sûr.
 */
import type { DeckCapabilities, DeckStatus } from '../../../shared/contracts';
import { MAIN_SRC, RELAY_SRC, type DeckCommand, type DiagReport, type LoadTrack, type TabSnapshot, type TabToSw } from '../deezer/protocol';

declare global {
  interface Window {
    __clubMaisonMain?: boolean;
    dzPlayer?: any;
  }
}

(() => {
  if (window.__clubMaisonMain) return;
  window.__clubMaisonMain = true;

  // ------------------------------------------------------------------ interception des médias [H2][H3]
  const media = new Set<HTMLMediaElement>();
  let current: HTMLMediaElement | undefined;
  const contexts = new Set<BaseAudioContext>();
  let mediaElementSources = 0;
  let bufferSources = 0;
  let sinkId: string | undefined;

  const adopt = (el: HTMLMediaElement) => {
    if (media.has(el)) return;
    media.add(el);
    for (const ev of ['playing', 'pause', 'ended', 'ratechange', 'seeked', 'emptied', 'loadedmetadata', 'durationchange']) {
      el.addEventListener(ev, () => onMediaEvent(el, ev));
    }
    el.addEventListener('timeupdate', () => onTimeUpdate(el));
    if (sinkId && 'setSinkId' in el) void (el as any).setSinkId(sinkId).catch(() => {});
  };

  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    adopt(this);
    current = this;
    return origPlay.call(this);
  };
  const origCreate = Document.prototype.createElement;
  Document.prototype.createElement = function (this: Document, tag: string, opts?: ElementCreationOptions) {
    const el = origCreate.call(this, tag, opts);
    if (el instanceof HTMLMediaElement) adopt(el);
    return el;
  } as typeof Document.prototype.createElement;
  const OrigAudio = window.Audio;
  if (OrigAudio) {
    const Patched = function (this: unknown, src?: string) {
      const a = new OrigAudio(src);
      adopt(a);
      return a;
    } as unknown as typeof Audio;
    Patched.prototype = OrigAudio.prototype;
    window.Audio = Patched;
  }
  const AC: typeof AudioContext | undefined = (window as any).AudioContext ?? (window as any).webkitAudioContext;
  if (AC) {
    const proto = AC.prototype as any;
    const origMES = proto.createMediaElementSource;
    if (origMES) {
      proto.createMediaElementSource = function (this: AudioContext, el: HTMLMediaElement) {
        contexts.add(this);
        mediaElementSources++;
        adopt(el);
        return origMES.call(this, el);
      };
    }
    const base = (window as any).BaseAudioContext?.prototype ?? proto;
    const origBS = base.createBufferSource;
    if (origBS) {
      base.createBufferSource = function (this: BaseAudioContext) {
        contexts.add(this);
        bufferSources++;
        return origBS.call(this);
      };
    }
  }

  // métadonnées pour les touches multimédia [H5]
  let msTitle: string | undefined;
  let msArtist: string | undefined;
  try {
    const desc = Object.getOwnPropertyDescriptor(MediaSession.prototype, 'metadata');
    if (desc?.set && desc.get) {
      Object.defineProperty(MediaSession.prototype, 'metadata', {
        configurable: true,
        get() {
          return desc.get!.call(this);
        },
        set(v: MediaMetadata | null) {
          msTitle = v?.title || undefined;
          msArtist = v?.artist || undefined;
          desc.set!.call(this, v);
          queueMicrotask(() => guard('metadata'));
        },
      });
    }
  } catch {
    /* MediaSession absent */
  }

  // ------------------------------------------------------------------ état
  let expected: LoadTrack | undefined;
  let loading = false;
  let ready = false;
  let ended = false;
  let errorText: string | undefined;
  let adText: string | undefined;
  let desiredRate = 1;
  let settingRate = false;
  let caps: DeckCapabilities = { canSeek: false, canSetRate: false, preservesPitch: true, maxRateDelta: 0.08 };
  let seekVerified: boolean | undefined;
  let lastSent = 0;
  let savedVolume: number | undefined;

  const post = (msg: TabToSw) => window.postMessage({ source: MAIN_SRC, msg }, location.origin);
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const norm = (s?: string) => (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

  const player = (): any => {
    try {
      return window.dzPlayer;
    } catch {
      return undefined;
    }
  };

  const call = (obj: any, path: string, ...args: unknown[]): { ok: boolean; value?: any } => {
    try {
      const parts = path.split('.');
      let o = obj;
      for (let i = 0; i < parts.length - 1; i++) o = o?.[parts[i]];
      const fn = o?.[parts[parts.length - 1]];
      if (typeof fn !== 'function') return { ok: false };
      return { ok: true, value: fn.apply(o, args) };
    } catch {
      return { ok: false };
    }
  };

  /** Élément média qui joue (ou le dernier utilisé). */
  const el = (): HTMLMediaElement | undefined => {
    if (current && current.isConnected !== false) return current;
    for (const m of media) if (!m.paused) return (current = m);
    for (const m of document.querySelectorAll('audio,video')) adopt(m as HTMLMediaElement);
    return current ?? [...media][0];
  };

  const identity = (): { id?: number; title?: string; artist?: string } => {
    const dz = player();
    let id: number | undefined;
    for (const p of ['getSongId', 'getCurrentSongId']) {
      const r = call(dz, p);
      if (r.ok && Number(r.value) > 0) id = Number(r.value);
    }
    let title: string | undefined;
    let artist: string | undefined;
    const song = call(dz, 'getCurrentSong');
    if (song.ok && song.value) {
      const s = song.value;
      if (!id && Number(s.SNG_ID) > 0) id = Number(s.SNG_ID);
      title = s.SNG_TITLE ?? s.title;
      artist = s.ART_NAME ?? s.artist?.name;
      if (s.__TYPE__ === 'ad' || s.type === 'ad') adText = 'Publicité Deezer en cours';
    }
    title ??= msTitle;
    artist ??= msArtist;
    if (!id) {
      const bar = document.querySelector('[data-testid*="player" i], #page_player, .player-bottom, footer');
      const a = bar?.querySelector<HTMLAnchorElement>('a[href*="/track/"]');
      const m = a?.getAttribute('href')?.match(/\/track\/(\d+)/);
      if (m) id = Number(m[1]);
    }
    return { id, title, artist };
  };

  const matches = (want: LoadTrack): boolean | undefined => {
    const idn = identity();
    if (idn.id) return idn.id === want.id;
    if (idn.title) {
      const a = norm(idn.title);
      const b = norm(want.title);
      return a === b || a.startsWith(b) || b.startsWith(a);
    }
    return undefined; // inconnu
  };

  const position = (): { position: number; duration: number; rate: number } => {
    const m = el();
    const dz = player();
    let pos = m && Number.isFinite(m.currentTime) ? m.currentTime : NaN;
    let dur = m && Number.isFinite(m.duration) && m.duration > 0 ? m.duration : NaN;
    if (!Number.isFinite(pos)) {
      const r = call(dz, 'getPosition');
      if (r.ok && Number.isFinite(Number(r.value))) pos = Number(r.value);
    }
    if (!Number.isFinite(dur)) {
      const r = call(dz, 'getDuration');
      if (r.ok && Number(r.value) > 0) dur = Number(r.value);
    }
    return { position: Number.isFinite(pos) ? pos : 0, duration: Number.isFinite(dur) ? dur : expected?.duration ?? 0, rate: m?.playbackRate ?? 1 };
  };

  const status = (): DeckStatus => {
    if (errorText) return 'error';
    if (loading) return 'loading';
    if (!expected) return 'empty';
    if (ended) return 'ended';
    const m = el();
    if (m && !m.paused) return 'playing';
    return ready ? 'ready' : 'paused';
  };

  const detectCaps = () => {
    const m = el();
    const webAudioOnly = !m && bufferSources > 0;
    caps = {
      canSeek: seekVerified ?? !!m,
      canSetRate: !!m && !webAudioOnly,
      preservesPitch: !!m && 'preservesPitch' in m,
      maxRateDelta: 0.08,
    };
  };

  const snapshot = (): TabSnapshot => {
    detectCaps();
    const p = position();
    const idn = identity();
    return {
      status: status(),
      ...p,
      trackId: idn.id,
      title: idn.title,
      artist: idn.artist,
      caps,
      error: errorText ?? adText,
      wall: Date.now(),
    };
  };

  const send = () => {
    lastSent = Date.now();
    post({ kind: 'evt', evt: { type: 'state', state: snapshot() } });
  };

  // ------------------------------------------------------------------ garde-fous
  /** Empêche Deezer d'enchaîner seul : si le titre change sans ordre de la console, pause immédiate. */
  function guard(_why: string) {
    if (!expected || loading) return;
    const m = matches(expected);
    if (m === false && !ended) {
      pauseNow();
      ended = true;
      post({ kind: 'evt', evt: { type: 'log', msg: 'Deezer a voulu passer au titre suivant : mis en pause.' } });
      send();
    }
  }

  function onMediaEvent(m: HTMLMediaElement, ev: string) {
    if (ev === 'playing') current = m;
    if (ev === 'ended' && expected && !loading) ended = true;
    if (ev === 'ratechange' && !settingRate && Math.abs(m.playbackRate - desiredRate) > 0.001 && expected && !loading) {
      // Deezer a remis la vitesse : on réapplique la nôtre
      applyRate(desiredRate);
    }
    if (ev === 'emptied' || ev === 'loadedmetadata') queueMicrotask(() => guard(ev));
    send();
  }

  function onTimeUpdate(m: HTMLMediaElement) {
    if (expected && !loading && !m.paused && m.duration > 0 && m.currentTime >= m.duration - 0.25) {
      // fin du titre : on coupe avant que Deezer n'enchaîne
      pauseNow();
      ended = true;
      send();
      return;
    }
    if (Date.now() - lastSent > 200) send();
  }

  // autre appareil [H6]
  const OTHER_DEVICE = /(autre appareil|another device|utilis[ée] (ailleurs|sur un autre)|being used on|listening on another|écoute sur un autre)/i;
  let lastScan = 0;
  const scanOtherDevice = () => {
    const now = Date.now();
    if (now - lastScan < 800) return;
    lastScan = now;
    const nodes = document.querySelectorAll('[role="dialog"],[role="alertdialog"],[role="alert"],[role="status"],[data-testid*="modal" i],[class*="modal" i],[class*="toast" i]');
    let found = false;
    for (const n of nodes) {
      if (OTHER_DEVICE.test(n.textContent ?? '')) {
        found = true;
        break;
      }
    }
    const msg = found ? 'Ce compte Deezer joue sur un autre appareil : chaque platine doit utiliser un compte différent de l’abonnement Famille.' : undefined;
    if (msg !== errorText && (found || errorText?.startsWith('Ce compte Deezer'))) {
      errorText = msg;
      send();
    }
  };
  const startObserver = () => {
    if (!document.body) return void setTimeout(startObserver, 200);
    new MutationObserver(() => scanOtherDevice()).observe(document.body, { childList: true, subtree: true });
  };
  startObserver();

  // ------------------------------------------------------------------ commandes de base
  const PLAY_SELECTORS = [
    '[data-testid="play"]',
    '[data-testid="play-button"]',
    '[data-testid="playButton"]',
    '[data-testid="play_button"]',
    '[data-testid="play_button_play"]',
    'button[aria-label="Écouter"]',
    'button[aria-label="Lecture"]',
    'button[aria-label="Lire"]',
    'button[aria-label="Play"]',
    'button[aria-label="Listen"]',
    'button[aria-label*="Écouter" i]',
    'button[aria-label*="Lecture" i]',
    'button[aria-label*="Play" i]',
  ];
  const PAUSE_SELECTORS = ['[data-testid="play_button_pause"]', '[data-testid="pause"]', 'button[aria-label="Pause"]', 'button[aria-label*="Pause" i]'];

  const visible = (b: Element) => {
    const r = (b as HTMLElement).getBoundingClientRect?.();
    return !!r && r.width > 0 && r.height > 0 && !(b as HTMLButtonElement).disabled;
  };

  const findButton = (selectors: string[], root: ParentNode = document, textRe?: RegExp): HTMLElement | undefined => {
    for (const s of selectors) {
      for (const b of root.querySelectorAll(s)) if (visible(b)) return b as HTMLElement;
    }
    if (textRe) {
      for (const b of root.querySelectorAll('button')) if (textRe.test((b.textContent ?? '').trim()) && visible(b)) return b as HTMLElement;
    }
    return undefined;
  };

  const playerBar = (): ParentNode => document.querySelector('[data-testid*="player" i], #page_player, .player-bottom, footer') ?? document;

  function pauseNow() {
    const dz = player();
    if (call(dz, 'control.pause').ok || call(dz, 'pause').ok) {
      /* fait par le lecteur */
    }
    const m = el();
    if (m && !m.paused) {
      const b = findButton(PAUSE_SELECTORS, playerBar());
      if (b) b.click();
      if (!m.paused) m.pause();
    }
  }

  async function waitFor(cond: () => boolean, ms: number, step = 50): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (cond()) return true;
      await sleep(step);
    }
    return cond();
  }

  /** Lance la lecture ; renvoie l'heure murale estimée où le son a réellement démarré. */
  async function playNow(): Promise<number | undefined> {
    ended = false;
    ready = false;
    const m0 = el();
    const t0 = m0?.currentTime ?? 0;
    const dz = player();
    let done = call(dz, 'control.play').ok || call(dz, 'play').ok;
    await sleep(30);
    if (!el() || el()!.paused) {
      const b = findButton(PLAY_SELECTORS, playerBar());
      if (b) {
        b.click();
        done = true;
      }
    }
    await sleep(30);
    const m = el();
    if (m && m.paused) {
      try {
        await m.play();
        done = true;
      } catch {
        /* lecture refusée */
      }
    }
    if (!done && !m) throw new Error('Impossible de lancer la lecture (aucun lecteur trouvé)');
    const ok = await waitFor(() => !!el() && !el()!.paused && el()!.currentTime > t0 + 0.01, 4000, 5);
    if (!ok) throw new Error('Deezer ne démarre pas la lecture');
    const mm = el()!;
    return Date.now() - ((mm.currentTime - t0) * 1000) / (mm.playbackRate || 1);
  }

  async function seekTo(pos: number): Promise<void> {
    const m = el();
    const dz = player();
    const near = () => !!el() && Math.abs(el()!.currentTime - pos) < 0.35;
    if (m) {
      let inBuf = false;
      for (let i = 0; i < m.buffered.length; i++) if (m.buffered.start(i) <= pos && pos <= m.buffered.end(i)) inBuf = true;
      if (inBuf || !dz) {
        m.currentTime = pos;
        if (await waitFor(near, 1500)) {
          seekVerified = true;
          return;
        }
      }
    }
    const dur = position().duration;
    if (dur > 0 && call(dz, 'control.seek', pos / dur).ok && (await waitFor(near, 2000))) {
      seekVerified = true;
      return;
    }
    if (m) {
      m.currentTime = pos;
      if (await waitFor(near, 2500)) {
        seekVerified = true;
        return;
      }
    }
    seekVerified = false;
    throw new Error('Déplacement dans le morceau impossible sur ce lecteur');
  }

  function applyRate(r: number) {
    const m = el();
    if (!m) throw new Error('Pas d’élément média : vitesse non réglable');
    settingRate = true;
    try {
      // en dessous de 0.5 (effet frein) on laisse la hauteur descendre, comme une vraie platine
      (m as any).preservesPitch = r >= 0.5;
      m.playbackRate = r;
    } finally {
      settingRate = false;
    }
    desiredRate = r;
  }

  // ------------------------------------------------------------------ chargement [H4]
  const PENDING_KEY = 'clubMaison.pendingLoad';

  async function load(id: string, track: LoadTrack, startAt: number): Promise<void> {
    expected = track;
    loading = true;
    ready = false;
    ended = false;
    adText = undefined;
    send();
    try {
      const m0 = el();
      if (m0 && !m0.paused) pauseNow();
      const path = `/fr/track/${track.id}`;
      if (!location.pathname.endsWith(`/track/${track.id}`)) {
        history.pushState(null, '', path);
        window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
        const rendered = await waitFor(() => !!mainPlayButton(), 6000, 100);
        if (!rendered) {
          // le routeur n'a pas suivi : rechargement complet, la commande reprendra après
          sessionStorage.setItem(PENDING_KEY, JSON.stringify({ id, track, startAt, t: Date.now() }));
          location.assign(`https://www.deezer.com${path}`);
          return new Promise(() => {}); // la page va se recharger
        }
      } else {
        await waitFor(() => !!mainPlayButton(), 6000, 100);
      }
      await startAndPark(track, startAt);
      loading = false;
      ready = true;
      send();
    } catch (e) {
      loading = false;
      throw e;
    }
  }

  function mainPlayButton(): HTMLElement | undefined {
    const main = document.querySelector('main, #page_content, [role="main"]') ?? document;
    return findButton(PLAY_SELECTORS, main, /^(écouter|lecture|lire|play|listen)$/i);
  }

  /** Clique « écouter » sur la page du titre, attend qu'il joue (muet), met en pause à startAt. */
  async function startAndPark(track: LoadTrack, startAt: number): Promise<void> {
    const b = mainPlayButton();
    if (!b) throw new Error('Bouton de lecture introuvable sur la page du titre');
    const m0 = el();
    if (m0) {
      savedVolume = m0.volume;
      m0.muted = true; // pas de son pendant le calage (et la capture reste propre)
    }
    b.click();
    const ok = await waitFor(() => {
      const m = el();
      if (m && savedVolume === undefined) {
        savedVolume = m.volume;
        m.muted = true;
      }
      if (!m || m.paused || m.currentTime <= 0) return false;
      const id = matches(track);
      return id !== false;
    }, 15000, 50);
    const m = el();
    if (!ok || !m) {
      if (m) m.muted = false;
      throw new Error(matches(track) === false ? 'Deezer joue un autre titre que celui demandé' : 'Le titre ne démarre pas (indisponible sur ce compte ?)');
    }
    pauseNow();
    await waitFor(() => !!el()?.paused, 2000);
    if (startAt > 0.05) await seekTo(startAt).catch(() => {});
    else if (m.currentTime > 0.3) await seekTo(0).catch(() => {});
    applyRateSafe(1);
    m.muted = false;
    savedVolume = undefined;
  }

  function applyRateSafe(r: number) {
    try {
      applyRate(r);
    } catch {
      /* sans élément média */
    }
  }

  // ------------------------------------------------------------------ sortie audio (repli BlackHole)
  async function setSink(label: string): Promise<string> {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    const devs = await navigator.mediaDevices.enumerateDevices();
    const d = devs.find((x) => x.kind === 'audiooutput' && x.label.toLowerCase().includes(label.toLowerCase()));
    if (!d) throw new Error(`Sortie « ${label} » introuvable dans Chrome`);
    sinkId = d.deviceId;
    for (const m of media) if ('setSinkId' in m) await (m as any).setSinkId(sinkId).catch(() => {});
    for (const c of contexts) if ('setSinkId' in c) await (c as any).setSinkId(sinkId).catch(() => {});
    return d.label;
  }

  // ------------------------------------------------------------------ diagnostic
  function methodsOf(o: any): string[] {
    const out = new Set<string>();
    let p = o;
    for (let depth = 0; p && p !== Object.prototype && depth < 4; depth++) {
      for (const k of Object.getOwnPropertyNames(p)) {
        try {
          if (k !== 'constructor' && typeof o[k] === 'function') out.add(k);
        } catch {
          /* accesseur qui lève */
        }
      }
      p = Object.getPrototypeOf(p);
    }
    return [...out].sort();
  }

  async function userInfo(): Promise<{ id?: string; name?: string }> {
    try {
      const r = await fetch('/ajax/gw-light.php?method=deezer.getUserData&input=3&api_version=1.0&api_token=', { credentials: 'include' });
      const j = await r.json();
      const u = j?.results?.USER;
      if (u && Number(u.USER_ID) > 0) return { id: String(u.USER_ID), name: u.BLOG_NAME || u.FIRSTNAME };
    } catch {
      /* pas connecté ou API interne changée */
    }
    return {};
  }

  async function diag(): Promise<DiagReport> {
    const dz = player();
    const m = el();
    detectCaps();
    const notes: string[] = [];
    if (!dz) notes.push('Objet window.dzPlayer absent : pilotage par l’élément média et les boutons.');
    if (!m) notes.push('Aucun élément audio intercepté : lance un titre dans cet onglet puis relance le test.');
    if (!m && bufferSources > 0) notes.push('Le lecteur passe par Web Audio : vitesse non réglable.');
    return {
      url: location.href,
      user: await userInfo(),
      playerObject: {
        found: !!dz,
        name: dz ? 'window.dzPlayer' : undefined,
        methods: dz ? methodsOf(dz) : [],
        controlMethods: dz?.control ? methodsOf(dz.control) : [],
      },
      media: {
        intercepted: media.size,
        current: m
          ? {
              tag: m.tagName.toLowerCase(),
              src: m.currentSrc ? m.currentSrc.split(':')[0] + ':…' : '(aucune)',
              paused: m.paused,
              rate: m.playbackRate,
              preservesPitch: !!(m as any).preservesPitch,
              currentTime: m.currentTime,
              duration: m.duration,
              muted: m.muted,
              volume: m.volume,
            }
          : undefined,
      },
      webAudio: { contexts: contexts.size, mediaElementSources, bufferSources },
      mediaSession: { title: msTitle, artist: msArtist },
      otherDevice: !!errorText?.startsWith('Ce compte Deezer'),
      caps,
      notes,
    };
  }

  async function probeRate(): Promise<{ ok: boolean; readBack: number; after: number }> {
    const m = el();
    if (!m) return { ok: false, readBack: 0, after: 0 };
    const before = m.playbackRate;
    applyRate(1.03);
    const readBack = m.playbackRate;
    await sleep(400);
    const after = m.playbackRate;
    applyRate(before);
    return { ok: Math.abs(readBack - 1.03) < 0.001 && Math.abs(after - 1.03) < 0.001, readBack, after };
  }

  // ------------------------------------------------------------------ messagerie
  async function handle(cmd: DeckCommand, id: string): Promise<unknown> {
    switch (cmd.op) {
      case 'load':
        await load(id, cmd.track, cmd.startAt);
        return { ok: true };
      case 'play': {
        const startedWall = await playNow();
        applyRateSafe(desiredRate);
        send();
        return { startedWall };
      }
      case 'pause':
        pauseNow();
        await waitFor(() => !el() || el()!.paused, 1500);
        send();
        return {};
      case 'seek':
        await seekTo(cmd.position);
        send();
        return {};
      case 'rate':
        applyRate(cmd.rate);
        send();
        return { rate: el()?.playbackRate };
      case 'probeRate':
        return probeRate();
      case 'diag':
        return diag();
      case 'setSink':
        return { label: await setSink(cmd.label) };
    }
  }

  async function hello() {
    const u = await userInfo();
    post({ kind: 'hello', hello: { url: location.href, userId: u.id, userName: u.name, playerObject: !!player() } });
    send();
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== RELAY_SRC) return;
    const msg = e.data.msg;
    if (msg?.kind === 'hello-request') {
      void hello();
      return;
    }
    if (msg?.kind !== 'cmd') return;
    handle(msg.cmd as DeckCommand, msg.id)
      .then((result) => post({ kind: 'reply', id: msg.id, ok: true, result }))
      .catch((err) => {
        send();
        post({ kind: 'reply', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      });
  });

  // reprise d'un chargement interrompu par un rechargement de page
  const resume = () => {
    try {
      const raw = sessionStorage.getItem(PENDING_KEY);
      if (!raw) return;
      sessionStorage.removeItem(PENDING_KEY);
      const p = JSON.parse(raw) as { id: string; track: LoadTrack; startAt: number; t: number };
      if (Date.now() - p.t > 60_000) return;
      expected = p.track;
      loading = true;
      void (async () => {
        await waitFor(() => !!mainPlayButton(), 15000, 200);
        try {
          await startAndPark(p.track, p.startAt);
          loading = false;
          ready = true;
          send();
          post({ kind: 'reply', id: p.id, ok: true, result: { ok: true } });
        } catch (err) {
          loading = false;
          send();
          post({ kind: 'reply', id: p.id, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      })();
    } catch {
      /* rien */
    }
  };

  const boot = () => {
    void hello();
    resume();
    setInterval(() => {
      scanOtherDevice();
      guard('poll');
      const playing = !!el() && !el()!.paused;
      if (Date.now() - lastSent > (playing ? 250 : 1000)) send();
    }, 250);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
