import type { VercelRequest, VercelResponse } from '@vercel/node';
import { previewTarget, RELAY_MAX_BYTES } from './_lib/relay.js';

/**
 * Relais des extraits Deezer de 30 s pour la console en ligne (/console) : le CDN des extraits
 * n'envoie pas d'en-têtes CORS, et la table de mixage a besoin de lire le son.
 *   /dz-cdn/<hôte>/<chemin>  (réécrit par vercel.json)  ->  https://<hôte>/<chemin>
 * Seuls les hôtes d'extraits (cdns-preview-*.dzcdn.net, cdnt-preview.dzcdn.net…) sont acceptés,
 * 2 Mo au plus : ce n'est pas un relais ouvert.
 */
function fail(res: VercelResponse, status: number, message: string) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json({ error: { code: status === 413 ? 'too-large' : 'invalid', message } });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return void res.status(405).end();
  const host = String(([] as unknown[]).concat(req.query.host ?? '')[0] ?? '');
  const path = ([] as string[]).concat(req.query.path ?? []).join('/');
  const target = previewTarget(host, path, req.query);
  if (!target) return fail(res, 400, 'Hôte ou chemin refusé.');

  try {
    const r = await fetch(target, { redirect: 'follow' });
    // Une redirection ne doit pas nous emmener hors des hôtes d'extraits.
    const finalHost = new URL(r.url || target).hostname;
    if (!previewTarget(finalHost, 'x', {})) return fail(res, 502, 'Redirection refusée.');
    const len = Number(r.headers.get('content-length'));
    if (len > RELAY_MAX_BYTES) {
      await r.body?.cancel().catch(() => undefined);
      return fail(res, 413, 'Fichier trop gros pour un extrait.');
    }
    // Lecture plafonnée (content-length absent ou mensonger).
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (r.body) {
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > RELAY_MAX_BYTES) {
          await reader.cancel().catch(() => undefined);
          return fail(res, 413, 'Fichier trop gros pour un extrait.');
        }
        chunks.push(value);
      }
    }
    res.status(r.status);
    const ct = r.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', r.status === 200 ? 'public, max-age=3600, s-maxage=86400' : 'no-store');
    res.send(Buffer.concat(chunks));
  } catch {
    fail(res, 502, 'Extrait Deezer injoignable.');
  }
}
