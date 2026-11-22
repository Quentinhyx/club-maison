/**
 * Console Club Maison en localhost (hors extension) : `npm run dev:console` -> http://localhost:5190/console.html
 * Mode démo par défaut. api.deezer.com et les extraits (dzcdn.net) n'envoient pas d'en-têtes CORS :
 * on les relaie par le serveur de dev :
 *   /dz-api/<chemin>          -> https://api.deezer.com/<chemin>
 *   /dz-cdn/<hôte>/<chemin>   -> https://<hôte>/<chemin>   (hôte en *.dzcdn.net uniquement)
 */
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

function deezerProxy(): Plugin {
  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = req.url ?? '';
    let target: string | undefined;
    if (url.startsWith('/dz-api/')) target = `https://api.deezer.com/${url.slice('/dz-api/'.length)}`;
    else if (url.startsWith('/dz-cdn/')) {
      const rest = url.slice('/dz-cdn/'.length);
      const slash = rest.indexOf('/');
      const host = slash > 0 ? rest.slice(0, slash) : '';
      if (!/^[a-z0-9.-]+\.dzcdn\.net$/i.test(host)) {
        res.statusCode = 400;
        res.end('hôte refusé');
        return;
      }
      target = `https://${host}${rest.slice(slash)}`;
    }
    if (!target) return next();
    try {
      const r = await fetch(target, { headers: { accept: String(req.headers.accept ?? '*/*') } });
      res.statusCode = r.status;
      const ct = r.headers.get('content-type');
      if (ct) res.setHeader('content-type', ct);
      res.setHeader('cache-control', 'public, max-age=3600');
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.statusCode = 502;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { type: 'proxy', message: `Deezer injoignable : ${(e as Error).message}` } }));
    }
  };
  return {
    name: 'club-maison-deezer-proxy',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  root: resolve(import.meta.dirname, 'extension'),
  plugins: [react(), deezerProxy()],
  server: { port: 5190, strictPort: false, open: false },
  preview: { port: 5190 },
  build: {
    outDir: resolve(import.meta.dirname, 'dist/console'),
    emptyOutDir: true,
    rollupOptions: { input: { console: resolve(import.meta.dirname, 'extension/console.html') } },
  },
});
