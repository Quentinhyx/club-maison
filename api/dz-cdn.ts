import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Relais des extraits Deezer de 30 s pour la console en ligne (/console) : le CDN des extraits
 * n'envoie pas d'en-têtes CORS, et la table de mixage a besoin de lire le son.
 *   /dz-cdn/<hôte>/<chemin>  (réécrit par vercel.json)  ->  https://<hôte>/<chemin>
 * Seuls les hôtes *.dzcdn.net sont acceptés : ce n'est pas un relais ouvert.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return void res.status(405).end();
  const host = String(req.query.host ?? '');
  const path = ([] as string[]).concat(req.query.path ?? []).join('/');
  if (!/^[a-z0-9.-]+\.dzcdn\.net$/i.test(host) || !path || path.includes('..')) {
    return void res.status(400).json({ error: { code: 'invalid', message: 'Hôte ou chemin refusé.' } });
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (k === 'host' || k === 'path') continue;
    for (const x of ([] as string[]).concat(v ?? [])) qs.append(k, x);
  }
  const target = `https://${host}/${path}${qs.size ? `?${qs}` : ''}`;
  try {
    const r = await fetch(target);
    res.status(r.status);
    const ct = r.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(502).json({ error: { code: 'deezer', message: 'Extrait Deezer injoignable.' } });
  }
}
