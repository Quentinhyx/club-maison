# Club Maison

Un DJ automatique pour faire une soirée boîte de nuit à la maison. Il enchaîne les morceaux comme un DJ :
blends calés sur le tempo, échange des basses, effets dosés, re-edits avec une boîte à rythmes. Les invités
choisissent l'ambiance depuis leur téléphone en scannant un QR code.

## Les morceaux du projet

- `extension/` : la console DJ (en localhost pour l'instant) et la future extension Chrome qui pilotera deux lecteurs Deezer.
- `shared/audio/` : la table de mixage, les transitions, les effets, la boîte à rythmes.
- `shared/analysis/` : tempo, tonalité, énergie, sections (intro, break, drop…).
- `shared/brain/` : le cerveau DJ, qui choisit quoi jouer, quand et comment enchaîner.
- `shared/demo/` : des morceaux synthétiques pour tester sans Deezer.
- `web/` et `api/` : la page invités, la page hôte et le QR code, en ligne sur Vercel.

## Lancer en local

```bash
npm install
npm run dev:console   # console DJ : http://localhost:5190
npm run dev           # page invités, /hote et /qr
```

## En ligne

- Page invités : https://club-maison.vercel.app
- Page hôte : https://club-maison.vercel.app/hote (mot de passe : la variable `HOST_KEY` sur Vercel)
- QR code à imprimer : https://club-maison.vercel.app/qr

Chaque envoi sur `main` est mis en ligne automatiquement par Vercel.

## Vérifier avant d'envoyer

```bash
npm run typecheck
npm test
npx tsx extension/src/conductor.test.ts
```
