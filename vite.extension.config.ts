/**
 * Construction de l'extension Chrome Club Maison : `npm run build:ext` -> extension-dist/
 *
 *  - console.html, diagnostic.html (React) et le service worker background.js (module ES) ;
 *  - scripts de contenu en IIFE autonomes (aucun import à l'exécution), construits à part :
 *      content/deezer-main.js  (monde MAIN de www.deezer.com, document_start)
 *      content/deezer-relay.js (monde isolé, messagerie avec le service worker)
 *  - manifest.json copié, icônes PNG générées.
 */
import { defineConfig, build, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
// sources des AudioWorklets : écrites en vrais fichiers (la CSP MV3 refuse les Blob URL)
import { LIVE_WORKLET_SRC } from './shared/analysis/liveAnalyzer';
import { LOOP_WORKLET_SRC } from './shared/audio/loop';

const root = resolve(import.meta.dirname, 'extension');
const outDir = resolve(import.meta.dirname, 'extension-dist');

const CONTENT_SCRIPTS: Record<string, string> = {
  'deezer-main': resolve(root, 'src/content/deezer-main.ts'),
  'deezer-relay': resolve(root, 'src/content/deezer-relay.ts'),
};

/** Icône : disque noir, sillons, repère vert acide (pas de logo de marque). */
function icon(size: number): Buffer {
  const png = new PNG({ width: size, height: size });
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x + 0.5 - c;
      const dy = y + 0.5 - c;
      const r = Math.sqrt(dx * dx + dy * dy) / c;
      let rgba = [0, 0, 0, 0];
      if (r <= 1) {
        rgba = [11, 11, 12, 255];
        if (r > 0.93) rgba = [42, 42, 46, 255];
        else if (r < 0.3) rgba = [215, 255, 58, 255];
        else if (r < 0.36) rgba = [11, 11, 12, 255];
        else if (Math.abs(dx) < Math.max(1, size * 0.05) && dy < 0 && r > 0.45 && r < 0.85) rgba = [215, 255, 58, 255];
        else if (size >= 48 && Math.round(r * 20) % 3 === 0) rgba = [27, 27, 30, 255];
        if (r < 0.06) rgba = [11, 11, 12, 255];
      }
      png.data[i] = rgba[0];
      png.data[i + 1] = rgba[1];
      png.data[i + 2] = rgba[2];
      png.data[i + 3] = rgba[3];
    }
  }
  return PNG.sync.write(png);
}

function extensionAssets(): Plugin {
  return {
    name: 'club-maison-extension-assets',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: readFileSync(resolve(root, 'manifest.json'), 'utf8') });
      for (const s of [16, 48, 128]) this.emitFile({ type: 'asset', fileName: `icons/icon${s}.png`, source: icon(s) });
      this.emitFile({ type: 'asset', fileName: 'worklets/live-capture.js', source: LIVE_WORKLET_SRC });
      // même contournement que loopWorkletFix pour la source importée par cette config
      const loopSrc = /\bclass LoopCore\b/.test(LOOP_WORKLET_SRC) ? LOOP_WORKLET_SRC : LOOP_WORKLET_SRC.replace(/^class \{/m, 'var LoopCore = class {');
      this.emitFile({ type: 'asset', fileName: 'worklets/loop.js', source: loopSrc });
    },
    async closeBundle() {
      // un build par script de contenu : format IIFE, tout en un seul fichier
      for (const [name, entry] of Object.entries(CONTENT_SCRIPTS)) {
        await build({
          configFile: false,
          logLevel: 'warn',
          build: {
            outDir: resolve(outDir, 'content'),
            emptyOutDir: false,
            minify: false,
            sourcemap: false,
            lib: { entry, name: name.replace(/-/g, '_'), formats: ['iife'], fileName: () => `${name}.js` },
          },
        });
      }
    },
  };
}

/**
 * Contournement : shared/audio/loop.ts sérialise la classe LoopCore avec `${LoopCore.toString()}`, mais
 * un bundler transforme `class LoopCore {}` en `var LoopCore = class {}` : la source du worklet devient
 * `class { … }` (anonyme, invalide) et l'échantillonneur retombe sur le ScriptProcessor. On rend la
 * source robuste au moment du build (sans modifier le fichier) : `var LoopCore = <classe>;`.
 */
function loopWorkletFix(): Plugin {
  return {
    name: 'club-maison-loop-worklet-fix',
    enforce: 'pre',
    transform(code, id) {
      if (!/shared[\\/]audio[\\/]loop\.ts$/.test(id)) return null;
      const needle = '${LoopCore.toString()}';
      if (!code.includes(needle) || code.includes('var LoopCore = ${LoopCore.toString()}')) return null;
      return { code: code.replace(needle, 'var LoopCore = ${LoopCore.toString()};'), map: null };
    },
  };
}

export default defineConfig({
  root,
  base: './',
  plugins: [loopWorkletFix(), react(), extensionAssets()],
  build: {
    outDir,
    emptyOutDir: true,
    target: 'chrome116',
    sourcemap: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        console: resolve(root, 'console.html'),
        diagnostic: resolve(root, 'diagnostic.html'),
        background: resolve(root, 'src/background.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
