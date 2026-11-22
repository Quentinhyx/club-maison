/**
 * Club Maison : catalogue des morceaux de démo synthétiques (hors ligne, aucun vrai artiste).
 * Ids négatifs stables : ne jamais renuméroter, ajouter les nouveaux en fin de liste.
 */
import type { Camelot, Genre } from '../contracts';

/** Style de synthèse (pilote les motifs rythmiques, la basse, les accords, la voix). */
export type DemoStyle =
  | 'tech-house' | 'house' | 'deep' | 'techno' | 'minimal' | 'nudisco' | 'disco'
  | 'synthpop' | 'afro' | 'boombap' | 'trap' | 'reggaeton' | 'dnb'
  // morceaux « organiques » (sans 4/4 électronique), pour tester les re-edits du cerveau
  | 'chanson' | 'slow80s' | 'funk' | 'rubato';

export interface DemoSpec {
  id: number;
  title: string;
  artist: string;
  album: string;
  genres: Genre[];
  style: DemoStyle;
  bpm: number;
  key: Camelot;
  /** Durée visée (s) ; la durée réelle est calée sur un nombre entier de phrases. */
  targetSec: number;
  seed: number;
  releaseYear: number;
}

export const DEMO_SPECS: readonly DemoSpec[] = [
  { id: -1001, title: 'Pastis & Kick Drum', artist: 'Le Comité des Fêtes', album: 'Apéro Prolongé', genres: ['tech-house'], style: 'tech-house', bpm: 125, key: '8A', targetSec: 250, seed: 11, releaseYear: 2024 },
  { id: -1002, title: 'Afterwork à Pigalle', artist: 'Monsieur Bassline', album: 'Note de Frais', genres: ['tech-house'], style: 'tech-house', bpm: 124, key: '5A', targetSec: 270, seed: 23, releaseYear: 2023 },
  { id: -1003, title: 'Rooftop Sans Ascenseur', artist: 'Les Frangins Groove', album: 'Septième Étage', genres: ['tech-house', 'house'], style: 'tech-house', bpm: 126, key: '11A', targetSec: 235, seed: 37, releaseYear: 2025 },
  { id: -1004, title: 'La Conciergerie', artist: 'Dame Sono', album: 'Bâtiment C', genres: ['house'], style: 'house', bpm: 123, key: '4A', targetSec: 260, seed: 41, releaseYear: 2022 },
  { id: -1005, title: 'Béton Armé', artist: 'Unité 130', album: 'Zone Industrielle', genres: ['techno'], style: 'techno', bpm: 130, key: '1A', targetSec: 280, seed: 53, releaseYear: 2024 },
  { id: -1006, title: 'Clic Clac Merci Kodak', artist: 'Micro Minimal', album: 'Pellicule 24 Poses', genres: ['minimal', 'tech-house'], style: 'minimal', bpm: 124, key: '6A', targetSec: 255, seed: 67, releaseYear: 2021 },
  { id: -1007, title: 'Boule à Facettes Sous la Pluie', artist: 'Disco Mamie', album: 'Thé Dansant', genres: ['nu-disco', 'french-touch'], style: 'nudisco', bpm: 118, key: '9B', targetSec: 240, seed: 71, releaseYear: 2023 },
  { id: -1008, title: 'Paillettes Obligatoires', artist: 'The Velvet Moustaches', album: 'Dress Code: Sequins', genres: ['disco', 'funk'], style: 'disco', bpm: 116, key: '3B', targetSec: 230, seed: 83, releaseYear: 1979 },
  { id: -1009, title: 'Néon Walkman', artist: 'Cassette Royale', album: 'Face B', genres: ['80s', 'pop'], style: 'synthpop', bpm: 120, key: '10A', targetSec: 215, seed: 97, releaseYear: 1985 },
  { id: -1010, title: 'Minitel Mon Amour', artist: 'Les Synthés Électriques', album: '3615 Romance', genres: ['80s', 'pop'], style: 'synthpop', bpm: 118, key: '7B', targetSec: 225, seed: 101, releaseYear: 1984 },
  { id: -1011, title: 'Soleil de Minuit', artist: 'Kalimba Collective', album: 'Lagos-Belleville', genres: ['afro-house'], style: 'afro', bpm: 122, key: '2A', targetSec: 275, seed: 113, releaseYear: 2025 },
  { id: -1012, title: 'Escalier B', artist: 'MC Ticket de Métro', album: 'Correspondance', genres: ['rap-fr'], style: 'boombap', bpm: 92, key: '12A', targetSec: 200, seed: 127, releaseYear: 1997 },
  { id: -1013, title: 'Pas de Réseau', artist: 'Lil Forfait', album: 'Hors Forfait', genres: ['rap-fr'], style: 'trap', bpm: 94, key: '3A', targetSec: 190, seed: 131, releaseYear: 2024 },
  { id: -1014, title: 'Calor en el Ascensor', artist: 'DJ Sobremesa feat. La Prima', album: 'Planta Baja', genres: ['reggaeton', 'latino'], style: 'reggaeton', bpm: 95, key: '8A', targetSec: 195, seed: 149, releaseYear: 2023 },
  { id: -1015, title: 'Périphérique 174', artist: 'Amen ou Jamais', album: 'Porte de Bagnolet', genres: ['drum-bass'], style: 'dnb', bpm: 174, key: '6A', targetSec: 250, seed: 151, releaseYear: 2022 },
  { id: -1016, title: 'Velours Bleu', artist: 'Sofa Club', album: 'Coussins Profonds', genres: ['deep-house'], style: 'deep', bpm: 118, key: '9A', targetSec: 265, seed: 163, releaseYear: 2021 },
  { id: -1017, title: 'Machine à Café', artist: 'Bureau 404', album: 'Open Space', genres: ['tech-house'], style: 'tech-house', bpm: 125, key: '10A', targetSec: 245, seed: 173, releaseYear: 2025 },
  // --- re-edits : tempo régulier, pas de batterie électronique 4/4
  { id: -1018, title: 'Les Parapluies de Romainville', artist: 'Josiane et ses Copains', album: 'Yé-Yé Toujours', genres: ['pop'], style: 'chanson', bpm: 100, key: '8B', targetSec: 175, seed: 181, releaseYear: 1966 },
  { id: -1019, title: 'Slow de la Boum', artist: 'Patrick Velours', album: 'Quart d\'heure Américain', genres: ['80s'], style: 'slow80s', bpm: 96, key: '4B', targetSec: 200, seed: 191, releaseYear: 1983 },
  { id: -1020, title: 'Funky Préfecture', artist: 'The Guichet Brothers', album: 'Prenez un Ticket', genres: ['funk'], style: 'funk', bpm: 104, key: '7A', targetSec: 190, seed: 193, releaseYear: 1976 },
  // --- tempo libre (rubato, ±5 %) : le cerveau doit refuser de le re-éditer
  { id: -1021, title: 'Valse Hésitante pour Piano Fatigué', artist: 'Hortense Rubato', album: 'Au Fond du Café', genres: ['pop'], style: 'rubato', bpm: 90, key: '11B', targetSec: 170, seed: 197, releaseYear: 1971 },
];

const SPEC_BY_ID = new Map<number, DemoSpec>(DEMO_SPECS.map((s) => [s.id, s]));

export function getDemoSpec(id: number): DemoSpec | undefined {
  return SPEC_BY_ID.get(id);
}

// ---------------------------------------------------------------------------------------------
// Pochettes : SVG géométrique sobre, une couleur par genre principal
// ---------------------------------------------------------------------------------------------

const GENRE_COLORS: Partial<Record<Genre, string>> = {
  'tech-house': '#e0475b', house: '#f08a24', 'deep-house': '#3c6fd1', techno: '#8a8f98',
  minimal: '#c9c9c0', 'afro-house': '#d9a521', disco: '#c447c9', 'nu-disco': '#e85fb4',
  '80s': '#29c4d6', 'rap-fr': '#6cbf3f', reggaeton: '#ff6a3d', 'drum-bass': '#7d5cff',
};

export function demoCover(spec: DemoSpec): string {
  const color = GENRE_COLORS[spec.genres[0]] ?? '#bbbbbb';
  const s = Math.abs(spec.seed);
  const motif = s % 4;
  let shapes = '';
  if (motif === 0) {
    for (let i = 0; i < 6; i++) shapes += `<circle cx="150" cy="150" r="${130 - i * 20}" fill="none" stroke="${color}" stroke-width="${3 + (i % 2) * 5}" opacity="${0.35 + i * 0.1}"/>`;
  } else if (motif === 1) {
    for (let i = 0; i < 10; i++) shapes += `<rect x="${i * 30}" y="0" width="${12 + (i * 7 + s) % 14}" height="300" fill="${color}" opacity="${0.2 + ((i * 3 + s) % 7) / 10}"/>`;
  } else if (motif === 2) {
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
      const on = (x * 7 + y * 3 + s) % 3 !== 0;
      shapes += `<rect x="${25 + x * 52}" y="${25 + y * 52}" width="40" height="40" rx="${(x + y + s) % 2 ? 20 : 4}" fill="${on ? color : 'none'}" stroke="${color}" stroke-width="2" opacity="${on ? 0.85 : 0.5}"/>`;
    }
  } else {
    for (let i = 0; i < 7; i++) shapes += `<polygon points="150,${30 + i * 18} ${270 - i * 17},${270 - i * 9} ${30 + i * 17},${270 - i * 9}" fill="none" stroke="${color}" stroke-width="3" opacity="${0.3 + i * 0.1}"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><rect width="300" height="300" fill="#121016"/>${shapes}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
