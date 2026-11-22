/**
 * Écrit des morceaux de démo en WAV 16 bits stéréo 44,1 kHz pour écoute (hors dépôt).
 *   npx tsx shared/demo/render-wav.ts [id ...] [--out <dossier>]
 * Par défaut : -1001 (tech house) et -1012 (rap boom bap).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDemoMeta, listDemoTracks, renderDemoPcm } from './index';

const DEFAULT_OUT = '/tmp/claude-0/-home-user-le-manoir/b5251bc2-bfa2-53d4-9172-0491697b0f9b/scratchpad';
const SR = 44100;

const args = process.argv.slice(2);
let out = DEFAULT_OUT;
const ids: number[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') out = args[++i];
  else ids.push(Number(args[i]));
}
if (!ids.length) ids.push(-1001, -1012);

function wav(left: Float32Array, right: Float32Array): Buffer {
  const n = left.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i])) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i])) * 32767), 46 + i * 4);
  }
  return buf;
}

mkdirSync(out, { recursive: true });
const tracks = listDemoTracks();
for (const id of ids) {
  const t = tracks.find((x) => x.id === id);
  if (!t) { console.error(`id inconnu : ${id}`); process.exitCode = 1; continue; }
  const t0 = performance.now();
  const { left, right } = renderDemoPcm(id, SR);
  const ms = performance.now() - t0;
  let s = 0;
  for (let i = 0; i < left.length; i++) s += left[i] * left[i] + right[i] * right[i];
  const rmsDb = 10 * Math.log10(s / (2 * left.length));
  const slug = t.title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  const file = join(out, `demo${id}-${slug}.wav`);
  writeFileSync(file, wav(left, right));
  const m = getDemoMeta(id)!;
  console.log(`${file}\n  ${t.title} — ${t.artist} | ${t.bpm} BPM | ${m.key} (${m.keyName}) | ${t.duration} s | RMS ${rmsDb.toFixed(1)} dBFS | rendu ${ms.toFixed(0)} ms`);
  console.log('  ' + m.structure.map((x) => `${x.section}@${x.startSec.toFixed(1)}s/${x.beats}t`).join(' '));
}
