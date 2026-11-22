# Club Maison : la console DJ (extension Chrome)

Club Maison transforme ton MacBook en DJ automatique pour une soirée à la maison. Deux lecteurs
Deezer servent de platines A et B (un compte de l’abonnement Famille chacun). L’extension Chrome
les pilote, récupère leur son et le mixe dans une vraie table de mixage. Un « cerveau » choisit les
morceaux, le moment de la transition, la technique et les effets. Tu peux reprendre la main quand tu veux.

Le son n’est jamais téléchargé ni copié : l’extension commande le lecteur officiel de Deezer et
mixe ce qui sort de l’onglet.

---

## Tester tout de suite, sans Deezer (mode démo)

Dans le dossier du projet, dans le Terminal :

```bash
npm install
npm run dev:console
```

Ouvre ensuite http://localhost:5190/console.html dans Chrome, puis clique **Lancer la soirée**.
La console joue des morceaux de démonstration fabriqués par l’ordinateur (aucun réseau).
Ajoute `?fast=1` à l’adresse pour des morceaux courts et voir les transitions plus vite.

---

## Installer l’extension (une seule fois)

1. Dans le Terminal, dans le dossier du projet :
   ```bash
   npm install
   npm run build:ext
   ```
   Un dossier **extension-dist** apparaît.
2. Dans Chrome, va à l’adresse `chrome://extensions`.
3. En haut à droite, active **Mode développeur**.
4. Clique **Charger l’extension non empaquetée** et choisis le dossier **extension-dist**.
5. Sur la carte « Club Maison », clique **Détails** puis active **Autoriser en navigation privée**
   (indispensable : la platine B tourne dans une fenêtre privée).
6. Épingle l’icône Club Maison dans la barre de Chrome (icône puzzle, puis l’épingle).

Après une mise à jour du code : refais `npm run build:ext`, puis clique la flèche « recharger »
sur la carte de l’extension.

---

## Préparer la soirée

1. **Platine A** : fenêtre Chrome normale, ouvre https://www.deezer.com et connecte-toi avec le **compte 1**.
2. **Platine B** : nouvelle fenêtre de navigation privée (Cmd + Maj + N), ouvre https://www.deezer.com
   et connecte-toi avec le **compte 2** (un autre profil de l’abonnement Famille).
   Deux comptes différents sont obligatoires : Deezer coupe un compte qui joue à deux endroits.
3. Laisse les deux fenêtres **visibles** (côte à côte, pas réduites dans le Dock) : Chrome ralentit
   les onglets cachés.
4. Clique l’icône **Club Maison** : la console s’ouvre. Garde-la ouverte toute la soirée.
5. Clique **Assistant d’installation** dans la console et lance les tests (lance un titre dans chaque
   fenêtre Deezer avant, et ferme la console pendant les tests de capture). Tout doit être vert.
6. Branche l’enceinte sur le Mac (câble ou Bluetooth) et choisis-la comme sortie du Mac.
7. Dans la console : **Lancer la soirée**.

Le son des onglets Deezer est coupé dans les onglets eux-mêmes : c’est normal, tout passe par la
table de mixage de la console.

---

## Si le son d’une platine ne passe pas : la solution BlackHole

Chrome peut refuser de capturer l’onglet de la fenêtre privée, ou capter un son muet. Dans ce cas :

1. Installe **BlackHole 2ch** et **BlackHole 16ch** (gratuits) : https://existential.audio/blackhole/
2. Redémarre Chrome.
3. Dans la console : **Réglages** > **Source des platines** > **Périphériques BlackHole**, puis
   **Appliquer**.
4. Chrome demande l’accès au micro dans la console et dans chaque onglet Deezer : accepte (c’est ce
   qui permet de choisir les sorties audio). La platine A sort sur BlackHole 2ch, la platine B sur
   BlackHole 16ch, et la console les écoute puis envoie le mix vers tes vraies enceintes.

---

## Les invités (QR code)

Si la page invités est en ligne (Vercel) : **Réglages** > **Invités**, colle l’adresse (par ex.
`https://ton-projet.vercel.app`) et ta clé hôte, **Enregistrer**, puis **Ouvrir la page QR à
imprimer**. Les invités votent pour un style et l’énergie, et demandent des sons ; tu acceptes ou
refuses les demandes dans l’onglet **Invités**. Les demandes acceptées arrivent dans la file.

---

## Pendant la soirée

- **Je reprends la main** : coupe le pilote automatique. Les faders, boutons d’égaliseur, filtres
  et le crossfader deviennent manipulables à la souris ; chaque platine a Lecture / Pause /
  « Charger le 1er de la file ». **Rendre la main au pilote** pour relancer le DJ automatique.
- **File d’attente** : cherche un morceau, **Ajouter**. La file passe avant les choix du cerveau.
- **Journal du DJ** : ce que le cerveau décide, et pourquoi.
- **Réglages** : style (Paris tech house, open format, lounge, peak time), dosage des effets,
  durée de jeu par morceau, suivre le public ou non, genre de départ.

---

## Ce qui ne peut être vérifié que sur ton Mac avec Deezer

L’extension a été construite sans accès à Deezer. L’adaptateur du lecteur essaie plusieurs méthodes
et l’assistant d’installation dit lesquelles marchent chez toi : objet du lecteur Deezer, élément
audio, changement de vitesse, capture d’onglet (normal et privé), lecture simultanée des deux
comptes, BlackHole. Si quelque chose est rouge, le message dit quoi faire ; sinon, le mode démo
permet toujours de faire tourner la console.
