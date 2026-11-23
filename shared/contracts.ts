/**
 * Club Maison : contrats partagés entre les quatre parties du projet.
 *
 *   extension/   pilote les deux lecteurs Deezer (platines A et B), capte leur son, héberge la table de mixage
 *   shared/audio la table de mixage Web Audio + les recettes de transitions et d'effets (automation)
 *   shared/brain le cerveau DJ : analyse, choix des morceaux, du moment et de la technique
 *   web/ + api/  page invités (QR code), page hôte, API Vercel + base Upstash Redis
 *
 * Ce fichier ne contient QUE des types et quelques constantes. Toute modification doit rester
 * rétro-compatible : les quatre parties sont développées en parallèle.
 *
 * Unités : temps du contexte audio en secondes (AudioContext.currentTime) = "ctx". Position dans un
 * morceau en secondes = "pos". Les gains sont linéaires 0..1 sauf mention dB.
 */

// ---------------------------------------------------------------------------------------------
// Morceaux
// ---------------------------------------------------------------------------------------------

/** Morceau Deezer, tel que renvoyé (en version réduite) par l'API publique api.deezer.com. */
export interface TrackRef {
  id: number;
  title: string;
  artist: string;
  artistId?: number;     // id Deezer de l'artiste (radio, artistes proches)
  album?: string;
  cover?: string;        // URL pochette (cover_medium)
  duration: number;      // secondes, morceau complet
  preview?: string;      // URL MP3 de 30 s (cdn-preview-*.dzcdn.net)
  bpm?: number;          // champ "bpm" de /track/{id}, souvent 0 ou absent
  gain?: number;         // champ "gain" de /track/{id} (dB, loudness)
  rank?: number;         // popularité Deezer
  releaseYear?: number;
  genres?: Genre[];      // genres déduits (catalogue / recherche)
}

export const GENRES = [
  'tech-house', 'house', 'deep-house', 'techno', 'minimal', 'afro-house', 'melodic',
  'disco', 'nu-disco', 'french-touch', 'funk',
  '80s', '90s', '2000s',
  'rap-fr', 'rap-us', 'rnb', 'afro', 'amapiano', 'latino', 'reggaeton', 'dancehall',
  'pop', 'electro', 'drum-bass', 'uk-garage', 'rock',
] as const;
export type Genre = (typeof GENRES)[number];

/** Libellés français pour l'UI. */
export const GENRE_LABELS: Record<Genre, string> = {
  'tech-house': 'Tech house', house: 'House', 'deep-house': 'Deep house', techno: 'Techno',
  minimal: 'Minimal', 'afro-house': 'Afro house', melodic: 'Melodic techno',
  disco: 'Disco', 'nu-disco': 'Nu-disco', 'french-touch': 'French touch', funk: 'Funk',
  '80s': 'Années 80', '90s': 'Années 90', '2000s': 'Années 2000',
  'rap-fr': 'Rap français', 'rap-us': 'Rap US', rnb: 'R&B', afro: 'Afro', amapiano: 'Amapiano',
  latino: 'Latino', reggaeton: 'Reggaeton', dancehall: 'Dancehall',
  pop: 'Pop', electro: 'Électro', 'drum-bass': 'Drum & bass', 'uk-garage': 'UK garage', rock: 'Rock',
};

/** Notation Camelot : '1A'..'12A' (mineur), '1B'..'12B' (majeur). */
export type Camelot = `${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12}${'A' | 'B'}`;

/** Analyse hors ligne (faite sur l'extrait de 30 s + métadonnées). Pas de phase : l'extrait ne
 *  dit pas où il se situe dans le morceau complet. */
export interface TrackAnalysis {
  trackId: number;
  bpm: number;              // tempo normalisé dans [70, 180]
  bpmConfidence: number;    // 0..1
  key?: Camelot;
  keyConfidence?: number;   // 0..1
  energy: number;           // 0..1 (RMS + densité d'attaques + brillance)
  danceability: number;     // 0..1 (régularité de la pulsation)
  /** 0..1 stabilité du tempo dans le temps (1 = machine, bas = rubato). Optionnel : absent = inconnu.
   *  Le re-edit exige une valeur élevée. */
  tempoStability?: number;
  brightness: number;       // 0..1 (centroïde spectral normalisé)
  vocalness?: number;       // 0..1 estimation grossière de présence vocale
  loudnessDb: number;       // RMS en dBFS de l'extrait
  genres: Genre[];
  analyzedAt: number;       // Date.now()
  /** Structure du morceau COMPLET, quand il a été pré-écouté (scan accéléré, voir TrackScan). */
  structure?: TrackStructure;
}

/** Une section repérée dans le morceau complet. Positions en secondes dans le morceau (vitesse 1). */
export interface StructureSection { section: Section; startPos: number; endPos: number; energy: number }

/** Structure du morceau complet issue du scan : grille de temps, phrases, sections, moments forts. */
export interface TrackStructure {
  bpm: number;
  /** Position (s) d'un premier temps de mesure ; les temps suivants : firstDownbeatPos + k * 60/bpm. */
  firstDownbeatPos: number;
  phraseBeats: 16 | 32;
  sections: StructureSection[];
  /** Débuts des drops / refrains (s), du plus marquant au moins marquant. */
  dropPositions: number[];
  /** Début de l'outro (s), si repéré. */
  outroPos?: number;
  confidence: number;       // 0..1
}

/** Forme d'onde complète d'un morceau, par bande (enveloppes 0..1), pointsPerSecond points par seconde
 *  de morceau (vitesse 1). Construite par computeWaveform (démo) ou par le scan accéléré (Deezer). */
export interface TrackWaveform {
  trackId: number;
  pointsPerSecond: number;
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  peak: Float32Array;
  /** Fraction du morceau déjà couverte (0..1) : le scan la remplit progressivement. */
  coverage: number;
}

/** Analyse en direct d'une platine en cours de lecture (signal capté). */
export type Section = 'intro' | 'body' | 'build' | 'drop' | 'breakdown' | 'outro' | 'unknown';

export interface LiveAnalysis {
  bpm: number;
  /** Instant ctx d'un premier temps de mesure récent (downbeat). Les temps suivants : + k * 60/bpm. */
  downbeatCtx: number;
  beatConfidence: number;   // 0..1
  /** Numéro du temps courant depuis le début de la lecture (approx), utile pour les phrases de 16/32. */
  beatIndex: number;
  /** Énergie courte (≈1 s) et longue (≈8 s), 0..1. */
  energyShort: number;
  energyLong: number;
  lowEnergy: number;        // énergie < 150 Hz, 0..1 (présence du kick / basse)
  section: Section;
  /** Prochain début de phrase prévu (ctx), sur une grille de 16 ou 32 temps. */
  nextPhraseCtx?: number;
  phraseBeats: 16 | 32;
}

// ---------------------------------------------------------------------------------------------
// Platines (pilotage des lecteurs Deezer, ou des extraits en mode démo)
// ---------------------------------------------------------------------------------------------

export type DeckId = 'A' | 'B';

export type DeckStatus = 'empty' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'error';

export interface DeckCapabilities {
  canSeek: boolean;
  canSetRate: boolean;      // playbackRate disponible (calage du tempo)
  preservesPitch: boolean;
  maxRateDelta: number;     // ex. 0.08 = ±8 %
}

export interface DeckState {
  id: DeckId;
  status: DeckStatus;
  track?: TrackRef;
  analysis?: TrackAnalysis;
  live?: LiveAnalysis;
  position: number;         // pos (s)
  duration: number;         // s
  rate: number;             // playbackRate courant
  caps: DeckCapabilities;
  error?: string;
}

export type DeckEvent =
  | { type: 'status'; deck: DeckId; status: DeckStatus; error?: string }
  | { type: 'track'; deck: DeckId; track?: TrackRef }
  | { type: 'position'; deck: DeckId; position: number; duration: number; rate: number }
  | { type: 'caps'; deck: DeckId; caps: DeckCapabilities };

/** Contrôle d'une platine. Implémenté par l'extension (Deezer) et par shared/audio (PreviewDeck, démo). */
export interface DeckController {
  readonly id: DeckId;
  /** Charge un morceau et le met en pause à `startAt` secondes. Résout quand il est prêt à jouer. */
  load(track: TrackRef, startAt?: number): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(position: number): Promise<void>;
  setRate(rate: number): Promise<void>;
  getState(): DeckState;
  /** Flux audio de la platine, branché sur la table de mixage. */
  getStream(): Promise<MediaStream | AudioNode>;
  on(listener: (e: DeckEvent) => void): () => void;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Table de mixage : paramètres automatisables
// ---------------------------------------------------------------------------------------------

/** Paramètres par platine. eqX en dB (-26 = coupé, 0 = neutre, +6 max). filter : -1 = passe-bas
 *  fermé, 0 = neutre, +1 = passe-haut fermé (un seul bouton comme sur une table DJ). */
export type DeckParam = 'gain' | 'trim' | 'eqLow' | 'eqMid' | 'eqHigh' | 'filter' | 'echoSend' | 'reverbSend';
export type MasterParam =
  | 'master.gain'
  | 'master.filter'
  | 'fx.echo.feedback'      // 0..0.95
  | 'fx.echo.time'          // secondes (le cerveau envoie des valeurs calées sur le tempo)
  | 'fx.echo.tone'          // -1..1 (filtre dans la boucle d'écho)
  | 'fx.reverb.return'      // 0..1
  | 'fx.noise.gain'         // 0..1 (bruit blanc / riser)
  | 'fx.noise.filter'       // Hz fréquence centrale du filtre du bruit
  | 'fx.gate.depth'         // 0..1 coupure rythmique (stutter / trance gate) sur le master
  | 'fx.gate.rate'          // divisions de temps : 1, 2, 4, 8 (par temps)
  | 'groove.gain'           // 0..1 fader de la boîte à rythmes (re-edit / mashup)
  | 'groove.filter'         // -1..1 filtre DJ de la boîte à rythmes
  | 'groove.eqLow';         // dB, comme les platines
export type ParamTarget = `${DeckId}.${DeckParam}` | MasterParam;

export type Curve = 'linear' | 'exp' | 'step' | 'smooth';

export interface AutomationPoint { t: number; v: number; curve?: Curve } // t en ctx
export interface AutomationLane { target: ParamTarget; points: AutomationPoint[] }

// ---------------------------------------------------------------------------------------------
// Transitions et effets (décidés par le cerveau, exécutés par la table)
// ---------------------------------------------------------------------------------------------

export type TransitionTechnique =
  | 'long-blend'      // 16-64 temps, échange des basses au milieu (house, tech house)
  | 'bass-swap'       // 8-16 temps, coupe des basses sortantes pile sur un début de phrase
  | 'filter-swap'     // le sortant monte en passe-haut pendant que l'entrant s'ouvre du passe-bas
  | 'echo-out'        // le sortant part dans l'écho sur un temps fort, l'entrant tombe sur le 1
  | 'cut'             // coupe sèche sur le 1 (rap, changement brutal assumé)
  | 'riser-drop'      // montée bruit blanc + passe-haut, silence d'un temps, l'entrant tombe sur le drop
  | 'reverb-wash'     // le sortant se noie dans la réverb (breaks mélodiques, changement de tempo)
  | 'loop-roll'       // stutter qui accélère (1/2, 1/4, 1/8) puis drop de l'entrant
  | 'brake';          // effet platine qui s'arrête (vinyl brake), puis l'entrant

export interface TransitionPlan {
  id: string;
  from: DeckId;
  to: DeckId;
  technique: TransitionTechnique;
  /** Début de la transition (ctx), placé sur un début de phrase du morceau sortant. */
  startCtx: number;
  /** Durée en temps (beats) du morceau de référence. */
  beats: number;
  /** Tempo de référence (celui de la piste sortante, après calage éventuel). */
  bpm: number;
  /** Instant ctx où le premier temps de l'entrant doit tomber (pour la lecture de l'entrant). */
  incomingStartCtx: number;
  /** Position (s) dans le morceau entrant à laquelle il démarre. */
  incomingStartPos: number;
  /** Calage du tempo : rate à appliquer sur l'entrant au départ, et retour progressif à 1 ensuite. */
  incomingRate: number;
  rateRelaxBeats?: number;
  /** Nombre de temps pendant lesquels l'entrant tourne déjà, fader fermé, AVANT son entrée audible
   *  (absorbe la latence de démarrage de Deezer et permet de caler la phase). La platine entrante est
   *  donc lancée à incomingStartPos - preRollBeats * 60/bpm (borné à 0). Défaut côté chef d'orchestre : 8. */
  preRollBeats?: number;
  /** Filet de sécurité : si l'entrant n'est pas réellement en lecture au moment prévu, la table boucle le
   *  dernier temps (ou mesure) du sortant jusqu'à ce qu'il le soit, au lieu de laisser un blanc. Défaut true. */
  holdWithLoop?: boolean;
  /** Effets d'accompagnement ajoutés par le cerveau (en plus de la recette de base). */
  accents: FxCue[];
  /** Intensité générale 0..1 (dosage des effets dans la recette). */
  intensity: number;
  reason: string;           // explication lisible, affichée dans le journal du DJ
}

export type FxKind =
  | 'echo-throw'      // envoi ponctuel d'un temps/une phrase dans l'écho (fin de phrase vocale)
  | 'reverb-throw'    // envoi ponctuel dans la réverb
  | 'filter-sweep'    // balayage du filtre (montée passe-haut avant un drop)
  | 'low-cut'         // coupe des basses N temps avant un drop puis retour sur le 1
  | 'riser'           // bruit blanc qui monte sur N temps
  | 'impact'          // retombée (downlifter) sur le 1
  | 'gate'            // stutter rythmique
  | 'brake'
  | 'loop'            // vraie boucle : rejoue les derniers `loopBeats` temps captés de la platine (échantillonneur)
  | 'loop-roll'       // boucle qui raccourcit (1 -> 1/2 -> 1/4 -> 1/8 temps) jusqu'au drop
  // Sons d'ambiance « boîte » générés par la table (DjSettings.stingers), à placer avec parcimonie :
  | 'airhorn'         // corne de brume « pa-pa-paaa » calée sur les doubles-croches, sur un gros drop
  | 'siren'           // sirène qui monte et descend, pendant une montée
  | 'scratch';        // scratch de vinyle sur la grille, juste avant un drop ou un changement

export interface FxCue {
  kind: FxKind;
  target: DeckId | 'master';
  atCtx: number;
  beats: number;
  bpm: number;
  amount: number;           // 0..1
  /** Pour 'loop' : longueur de la boucle en temps (4, 2, 1, 0.5, 0.25…). Pour 'loop-roll' : longueur de départ. */
  loopBeats?: number;
  reason?: string;
}

// ---------------------------------------------------------------------------------------------
// Public : invités, votes, demandes (API Vercel)
// ---------------------------------------------------------------------------------------------

export type EnergyVote = -1 | 1;

export interface GuestRequest {
  id: string;
  guestId: string;
  guestName?: string;
  track: TrackRef;
  createdAt: number;
  status: 'pending' | 'accepted' | 'played' | 'rejected';
}

export interface CrowdState {
  /** Poids des genres, déjà amortis dans le temps (demi-vie ≈ 20 min). */
  genreWeights: Partial<Record<Genre, number>>;
  /** Somme amortie des votes d'énergie, ramenée dans -1..1. */
  energy: number;
  requests: GuestRequest[];
  /** Réglages de l'hôte. */
  host: HostSettings;
  updatedAt: number;
}

export interface HostSettings {
  blockedGenres: Genre[];
  blockedTrackIds: number[];
  forcedGenre?: Genre;      // virage imposé par l'hôte
  votesOpen: boolean;
  requestsOpen: boolean;
  maxRequestsPerGuest: number;
  /** « Suivant » demandé par l'hôte depuis son téléphone (Date.now()). La console traite chaque valeur une fois. */
  skipAt?: number;
}

export interface NowPlaying {
  current?: TrackRef;
  next?: TrackRef;
  genre?: Genre;
  updatedAt: number;
}

/** Réponse de GET /api/state */
export interface PartyState {
  crowd: CrowdState;
  nowPlaying: NowPlaying;
}

/**
 * API (toutes les routes prennent ?party=<id>, défaut "maison") :
 *   GET  /api/state                         -> PartyState
 *   GET  /api/search?q=...                  -> TrackRef[]           (proxy api.deezer.com/search)
 *   GET  /api/catalog?genre=...&bpmMin&bpmMax -> TrackRef[]         (sélection par genre)
 *   POST /api/vote     { guestId, genre }   -> CrowdState
 *   POST /api/energy   { guestId, vote }    -> CrowdState
 *   POST /api/request  { guestId, guestName?, track } -> GuestRequest
 *   POST /api/host/now-playing  (en-tête x-host-key) NowPlaying     -> ok
 *   POST /api/host/request      (x-host-key) { id, status }         -> GuestRequest
 *   POST /api/host/settings     (x-host-key) Partial<HostSettings>  -> HostSettings
 */
export const DEFAULT_PARTY = 'maison';

// ---------------------------------------------------------------------------------------------
// Cerveau DJ
// ---------------------------------------------------------------------------------------------

export type StyleProfileId = 'soiree' | 'paris-tech-house' | 'open-format' | 'lounge' | 'peak-time';

export interface DjSettings {
  style: StyleProfileId;
  /** 0..1 : dosage global des effets (0 = mix propre, 1 = démonstratif). */
  fxAmount: number;
  /** Durée de jeu par morceau : bornes en secondes (le cerveau peut sortir dès 30 s). */
  minPlaySeconds: number;
  maxPlaySeconds: number;
  /** Laisse le public piloter (votes + demandes). */
  followCrowd: boolean;
  /** Autorise les re-edits (morceau ralenti/accéléré jusqu'à ±30 % + boîte à rythmes). Optionnel, défaut true. */
  allowReEdits?: boolean;
  /** Sons d'ambiance générés par la table (corne de brume, sirène, scratch). Optionnel, défaut true. */
  stingers?: boolean;
  /** Tempo cible de la soirée (le cerveau le fait évoluer) ; absent = déduit du profil. */
  targetBpm?: number;
  /** Genre de départ / courant si personne ne vote. */
  baseGenre: Genre;
}

export interface PlayedTrack { track: TrackRef; startedAt: number; endedAt?: number; genre?: Genre }

export interface QueueItem {
  track: TrackRef;
  source: 'host' | 'guest' | 'brain';
  requestId?: string;
  addedAt: number;
  genre?: Genre;
}

export interface BrainInput {
  nowCtx: number;
  nowMs: number;            // Date.now()
  decks: Record<DeckId, DeckState>;
  /** Morceaux ajoutés à la main (hôte) ou acceptés (invités), dans l'ordre. */
  queue: QueueItem[];
  /** Candidats proposés par le catalogue pour le genre visé, déjà analysés si possible. */
  candidates: Array<{ track: TrackRef; analysis?: TrackAnalysis; genre: Genre; /** 'similar' = radio/artistes proches du morceau en cours */ source?: 'catalog' | 'similar' }>;
  crowd: CrowdState;
  settings: DjSettings;
  history: PlayedTrack[];
  /** Transition en cours, si la table en exécute une. */
  activeTransition?: TransitionPlan;
  /** « Suivant » demandé (console ou téléphone de l'hôte) : Date.now() de la demande. Le cerveau sort du
   *  morceau en cours au plus vite (prochaine mesure, transition courte), une seule fois par valeur, et
   *  traite le zappage comme un avis négatif pour ajuster la suite du set. */
  skipRequestedAt?: number;
  /** Analyses connues (file, candidats, platines), par trackId. */
  analyses?: Record<number, TrackAnalysis>;
}

// ---------------------------------------------------------------------------------------------
// Tempo et re-edit (mashup) : calage permanent et boîte à rythmes sous un morceau
// ---------------------------------------------------------------------------------------------

/** Limites de vitesse. Normal : inaudible avec preservesPitch. Re-edit : assumé, masqué par le groove. */
export const RATE_LIMITS = { normal: 0.08, reEdit: 0.3 } as const;

export type GrooveStyle = 'house' | 'tech-house' | 'disco' | 'afro-house' | 'techno';

/** Boîte à rythmes synthétisée dans la table, calée sur la grille d'une platine. */
export interface GroovePlan {
  style: GrooveStyle;
  bpm: number;              // tempo de sortie (après calage du morceau)
  anchorCtx: number;        // un premier temps de mesure (ctx) ; la grille = anchorCtx + k * 60/bpm
  key?: Camelot;            // tonalité du morceau, pour la basse (absente si inconnue -> pas de basse)
  bass: boolean;
  /** Parties actives : kick, clap, hats ouverts/fermés, percussions. */
  parts: Array<'kick' | 'clap' | 'hat' | 'openhat' | 'perc' | 'bass'>;
  startCtx: number;         // entrée (sur un début de phrase)
  fadeBeats: number;        // montée du fader
  /** Coupe des basses du morceau d'origine pendant le groove (dB, ex. -12). */
  sourceLowCutDb: number;
  deck: DeckId;             // platine accompagnée
}

export type BrainDecision =
  | { type: 'rate'; deck: DeckId; rate: number; overBeats: number; reason: string }          // rampe de vitesse (calage, montée de tempo de la soirée)
  | { type: 'groove-start'; plan: GroovePlan; reason: string }
  | { type: 'groove-update'; bpm: number; anchorCtx: number }                                // suit la phase de la platine
  | { type: 'groove-stop'; atCtx: number; fadeBeats: number }
  | { type: 'want-genre'; genre: Genre; bpmMin: number; bpmMax: number; reason: string }   // demande des candidats au catalogue
  | { type: 'analyze'; track: TrackRef }                                                   // analyse de l'extrait à faire
  | { type: 'load'; deck: DeckId; track: TrackRef; startAt: number; reason: string }
  | { type: 'transition'; plan: TransitionPlan }
  | { type: 'fx'; cue: FxCue }
  | { type: 'stop'; deck: DeckId }
  | { type: 'consume-queue'; trackId: number }
  | { type: 'log'; message: string };

export interface DjBrain {
  /** Appelé ~10 fois par seconde. Doit être pur vis-à-vis de l'entrée (l'état interne est permis
   *  pour mémoriser les décisions déjà prises, mais pas d'accès réseau/audio). */
  tick(input: BrainInput): BrainDecision[];
  reset(): void;
}
