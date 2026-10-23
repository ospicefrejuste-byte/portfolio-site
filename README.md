# Ferme ADEOYE

Plateforme privée en français pour inventorier les animaux, cultures et récoltes, aliments et intrants, matériel et autres biens de la ferme. Les données sont enregistrées sur le serveur et partagées entre les comptes. Aucun jeu de données, compte ou mot de passe par défaut.

Fonctions : tableau de bord, recherche et filtres, seuils de stock, entrées/sorties/pertes datées et attribuées, suivi des lots Goliath de l’arrivée aux ventes, dépenses et achats avec total par période et rapport PDF, journal de terrain, rapports PDF A4 et CSV, gestion des accès. Les stocks sont mis à jour sous transaction ; les références d’opération évitent un double enregistrement lors d’une reprise. L’archivage conserve l’historique et exige un stock nul. Une valeur de stock est une estimation, pas une vente ni un bénéfice.

| Compte | Consultation et rapports | Inventaire, élevage, dépenses et journal | Comptes et paramètres |
| --- | --- | --- | --- |
| Consultation à distance | Oui | Non | Non |
| Équipe de la ferme | Oui | Oui | Non |
| Responsable | Oui | Oui | Oui |

Le compte aux États-Unis doit être créé avec le rôle **Consultation à distance**. Il devra changer son mot de passe initial à la première connexion. Désactiver ou réinitialiser un compte ferme ses sessions sur tous les serveurs.

## Développement

Node.js 24 et npm. Depuis le dossier du projet :

```sh
npm ci
npm run build
npm test
npm start
```

Le serveur écoute le port `PORT` (3000 par défaut). En développement seulement, SQLite se trouve dans `.data/adeoye.sqlite` ; le code d’installation est dans `.data/setup-token`, fichier privé. Ouvrir `/installation.html`, créer le premier responsable puis attribuer les comptes depuis **Accès & équipe**. Ne jamais publier `.data`, les sauvegardes, les secrets ou un fichier `.env`.

`ADEOYE_DATA_DIR` permet de choisir un autre dossier privé pour SQLite. La production exige PostgreSQL et une origine HTTPS explicite : aucun repli silencieux vers un fichier temporaire sur Netlify.

## Tests

```sh
npm test
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:browser
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:expenses-browser
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:goliath-browser
ADEOYE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:15433/adeoye_test npm run test:cloud
```

Le navigateur requiert Chromium et Poppler (`pdftotext`) pour inspecter le vrai PDF. Les tests utilisent des dossiers et schémas temporaires. La suite PostgreSQL est explicitement ignorée si son adresse de test manque ; cela ne valide pas PostgreSQL. N’utilisez jamais une base de production pour les tests. Les tests de transport exercent aussi les chemins Netlify, les cookies, les corps JSON limités à 64 Ko et le PDF transmis en base64.

## Publication

Voir [MISE_EN_LIGNE.md](MISE_EN_LIGNE.md). Les fichiers sont autonomes sur la branche **ferme-adeoye**. Le site scolaire reste sur **site-complet-gratuit** et n’est pas remplacé. Utiliser un **nouveau projet Netlify** et une **base PostgreSQL ADEOYE distincte**. Ne pas réutiliser les variables ou les données du site scolaire.

Variables privées : `ADEOYE_DATABASE_URL`, `ADEOYE_DATABASE_PASSWORD` si le mot de passe est fourni séparément, `ADEOYE_DATABASE_CA_CERT` si la chaîne nécessite une autorité particulière, `ADEOYE_PUBLIC_ORIGIN`, `ADEOYE_SETUP_TOKEN`. La vérification TLS reste obligatoire. Aucun secret dans le navigateur ni dans Git.

Pour les hôtes `*.supabase.co` et `*.supabase.com`, les racines de production officielles Supabase 2021 et 2025 sont fournies avec l’application et ajoutées aux autorités normales de Node. Leur signature et leur empreinte sont contrôlées ; le nom du serveur et sa chaîne restent vérifiés. Aucun téléchargement de certificat n’est nécessaire au démarrage. Une valeur explicite `ADEOYE_DATABASE_CA_CERT` permet de fournir une autre chaîne si nécessaire. Les erreurs de démarrage distinguent désormais la configuration, l’adresse, l’authentification, le certificat, le réseau et les droits, sans exposer de valeur privée.

## Sauvegarde

En local, `npm run backup` crée une copie cohérente privée dans `.data/backups` (ou dans le dossier défini par `ADEOYE_DATA_DIR`). Le fichier contient aussi les comptes : le conserver et le transférer uniquement par un moyen privé. Pour restaurer, arrêter l’application, préserver la base actuelle et remplacer `adeoye.sqlite` par la sauvegarde. Les fichiers WAL/SHM de l’ancienne base doivent être traités avec la base arrêtée ; ne jamais mélanger les journaux de deux copies. Redémarrer et vérifier les quantités et accès.

En production, activer les sauvegardes PostgreSQL chez le fournisseur, conserver des copies privées et vérifier une restauration sur une base distincte. Les CSV et PDF sont des rapports, pas des sauvegardes complètes des comptes et de l’historique.

Le rafraîchissement des données se fait toutes les 30 secondes quand la page est visible et sans saisie en cours, ou avec **Actualiser**. Cela ne fonctionne pas hors connexion : une panne doit être résolue avant de reprendre une opération. En cas de réponse incertaine à une création, un mouvement ou une dépense, utiliser la reprise proposée pour conserver la même référence.

**Dépenses et achats** conserve la désignation, la catégorie, le fournisseur facultatif, le montant entier en F CFA, la date et l’heure locales de la ferme, l’auteur et une référence d’opération. Les bornes de période sont inclusives ; les totaux sont calculés en entiers exacts, y compris au-delà de la précision des nombres JavaScript. Le PDF utilise la même période que la liste affichée. Une dépense n’ajoute pas automatiquement de stock : enregistrer aussi une entrée si l’achat approvisionne l’inventaire. Les nouveaux déploiements ajoutent la table `adeoye_expenses` sans réinitialiser les données existantes.

**Élevage Goliath** suit chaque arrivage comme un lot indépendant : effectif initial, arrivée, éclosion facultative, âge connu ou durée depuis l’arrivée, stade choisi par l’équipe, mortalités, ventes et effectif restant. La création du lot ajoute sa fiche d’inventaire `Animaux` en `tête` ; chaque mortalité ou vente met atomiquement à jour le lot et le mouvement de stock correspondant. Les fiches liées se gèrent par cet onglet pour éviter une divergence des effectifs. Les historiques ne sont pas supprimés, même quand le lot est épuisé. Les recettes connues sont additionnées exactement ; une vente sans prix reste signalée comme non chiffrée, sans être assimilée à zéro. Ces recettes ne sont ni un bénéfice calculé ni un paiement en ligne. Les PDF couvrent un lot ou l’ensemble de l’élevage. Les anciennes fiches d’inventaire ne sont pas converties automatiquement en lots.

Les quantités acceptent trois décimales ; les unités `tête`, `pièce` et `plateau` restent entières. Le stock ne peut pas être négatif. Les dates de mouvements passées restent possibles, mais l’historique représente l’ordre d’enregistrement ; le stock après opération n’est pas une reconstitution chronologique des dates antérieures. Aucune comptabilité, facturation, gestion sanitaire détaillée ou paiement en ligne n’est activé.
