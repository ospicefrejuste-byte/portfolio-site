# COURS DE RENFORCEMENT SCOLAIRE

Application Node.js 24 / Express / SQLite avec page publique, préinscriptions serveur, authentification et gestion par rôles.

## Démarrage

```sh
npm ci
npm test
npm start
```

Le serveur utilise le port 3000 (`PORT` configurable). Les données sont enregistrées dans `.data/school.sqlite` (`CRS_DATA_DIR` configurable). Ne pas utiliser plusieurs réplicas avec des disques séparés : cette version nécessite une instance et un disque persistant. Aucune donnée de démonstration ni compte par défaut n’est ajouté.

## Premier compte administrateur

1. Démarrer le serveur.
2. Ouvrir `/installation.html` sur le site.
3. Sur la console privée de l’hébergement, lire le fichier `setup-token` dans le répertoire de données, ou renseigner une variable secrète `CRS_SETUP_TOKEN` avant le premier démarrage.
4. Dans le formulaire, saisir le code et choisir un identifiant et un mot de passe personnel d’au moins 12 caractères.

Le code est à usage unique, ne doit pas être envoyé dans une conversation et n’est jamais affiché dans les logs. Le fichier est supprimé après installation. L’installation ne peut pas être répétée, même après un redémarrage.

Les connexions se font sur `/connexion.html`. L’espace `/gestion.html` contrôle la session ; les API contrôlent les autorisations côté serveur. Les mots de passe sont hachés avec scrypt et un sel unique. Les sessions durent 8 heures, utilisent des cookies HttpOnly et SameSite, et sont protégées contre les requêtes forgées. Les cookies sont Secure en production.

## Fonctions et parcours

- Accueil : 3 centres, classes et tarifs du communiqué, matières, contacts téléphoniques et formulaire de préinscription.
- Administration : valider une préinscription dans « Élèves », définir le groupe et le tarif mensuel, gérer les enseignants, cours, présences, paiements et notes.
- « Comptes & accès » : créer un identifiant pour un élève ou enseignant en liant son dossier, ou un autre administrateur ; activer/désactiver un compte ; réinitialiser son mot de passe. Le titulaire doit remplacer le mot de passe initial à sa première connexion. Transmettre ces identifiants de façon privée. Le compte administrateur actif ne peut pas se désactiver lui-même.
- Enseignants : consulter leurs groupes, saisir les présences et notes de leurs cours uniquement. Les contacts des familles et les paiements ne leur sont pas communiqués.
- Élèves : consulter leurs propres cours, notes, présences et paiements ; régler les frais avec KKiaPay lorsque l’intégration est configurée.
- Planning : détection des chevauchements pour une salle, un groupe ou un enseignant ; validation de la durée et des dates.
- Paiements : journal manuel par mois AAAA-MM, reçus imprimables, échéances en ligne avec vérification serveur. Les reçus KKiaPay confirmés ne sont pas modifiables ou supprimables.
- Export JSON des dossiers, réservé à l’administration. Il contient des données personnelles : le conserver dans un emplacement privé. Les liens de contact ouvrent l’application téléphone ; la prise de contact reste à la charge de l’administration.

Les groupes sont renseignés dans les dossiers élèves, les matières dans les cours. Les photos de centres sont des illustrations. Les horaires restent à confirmer avec l’établissement. L’ancienne démo HTML autonome reste une démo distincte ; elle ne permet pas de se connecter à cette base. Aucune migration automatique de ses données de navigateur n’est réalisée.

## KKiaPay — commencer en mode test

Dans les paramètres sécurisés du serveur, renseigner :

- `KKIAPAY_PUBLIC_KEY` : clé publique du compte de test.
- `KKIAPAY_PRIVATE_KEY` : clé privée, serveur uniquement.
- `KKIAPAY_SECRET_KEY` : clé secrète, serveur uniquement.
- `KKIAPAY_SANDBOX=true` : mode test (valeur par défaut).

Régénérer toute clé déjà divulguée. Ne jamais placer les clés privées ou secrètes dans le frontend, Git ou un fichier téléchargeable. Les secrets injectés par proxy doivent être liés à la destination HTTPS `api-sandbox.kkiapay.me` ; utiliser `NODE_USE_ENV_PROXY=1` avec Node.js 24 si l’environnement fournit un proxy.

Sans les trois clés, le bouton affiche l’indisponibilité du paiement. Le montant est calculé côté serveur selon le tarif mensuel et les reçus du même mois. L’inscription doit avoir le statut « Inscrit ». Le widget reçoit seulement la clé publique, le montant et une référence d’échéance. Le serveur vérifie le statut SUCCESS, le montant et les métadonnées de la transaction auprès de KKiaPay avant de créer un reçu. Les confirmations sont idempotentes. Un signal de réussite du navigateur ne suffit jamais à créer un paiement.

Le SDK transmet `data` avec la référence d’échéance ; la vérification exige que l’API renvoie cette même métadonnée. Si elle est absente ou différente, la transaction reste non confirmée et doit être examinée avec le prestataire. Un essai réel en sandbox est nécessaire pour valider le compte et la réponse de l’API avant toute activation en production.

Le point `/api/payments/webhook` peut recevoir `{ "transactionId": "…" }`. Il ne fait confiance à aucun montant/statut transmis et vérifie la transaction via l’API officielle. À configurer uniquement selon le format effectif des notifications du compte KKiaPay. Après une interruption du navigateur, la commande « Vérifier la transaction » permet aussi une confirmation avec la référence KKiaPay.

Les transactions de test sont marquées `sandbox`, exclues des encaissements réels, et n’ont aucune valeur de paiement. Le passage au réel exige un compte marchand activé, les clés réelles, `KKIAPAY_SANDBOX=false` et l’accès à `api.kkiapay.me`. Ne pas mélanger les clés test et production. Le site doit être accessible en HTTPS pour le widget et les sessions de production.

## Hébergement HTTPS avec Docker et Caddy

Préparer un serveur avec Docker Compose, un domaine pointant vers son IP et les ports 80/443 accessibles. Copier `.env.example` en `.env` **sur le serveur**, puis renseigner `SITE_DOMAIN`, `PUBLIC_ORIGIN` (origine HTTPS exacte, sans chemin ni slash final) et les clés KKiaPay sécurisées. Laisser le mode test actif.

```sh
docker compose up -d --build
```

Caddy gère le certificat HTTPS. Le volume `school_data` conserve la base. Pour obtenir le code d’installation via la console privée du serveur :

```sh
docker compose exec app cat /data/setup-token
```

Ouvrir ensuite `/installation.html` et choisir les accès administrateur. Ne pas publier ce code, `.env` ou le volume. Sur un hébergeur Node sans Docker, utiliser Node.js 24, `npm ci`, `npm start`, un disque persistant pour `CRS_DATA_DIR`, `NODE_ENV=production` et `PUBLIC_ORIGIN=https://votre-domaine`. Activer `TRUST_PROXY=1` uniquement derrière un unique proxy fiable qui assure le HTTPS. Ne pas exposer le port du serveur directement dans ce cas.

## Sauvegardes

Créer une sauvegarde SQLite cohérente pendant que le serveur fonctionne :

```sh
npm run backup -- /chemin/prive/school-backup.sqlite
```

Sous Docker : `docker compose exec app node scripts/backup.js /data/backups/school-backup.sqlite` puis copier le fichier hors du serveur dans un emplacement sécurisé. Programmer des sauvegardes régulières. Le fichier contient aussi les hachages des comptes : restreindre son accès.

Pour restaurer, arrêter l’application, préserver la base actuelle, remplacer `school.sqlite` par la sauvegarde et retirer uniquement les anciens fichiers WAL/SHM après arrêt, puis redémarrer. Ne jamais écraser une base utilisée. Le script de sauvegarde refuse d’écraser un fichier existant.

## Validation

`npm test` exécute les tests d’authentification, permissions, références, persistance, installation à usage unique et paiements. Les appels KKiaPay sont simulés dans les tests : ils ne constituent pas une validation du compte marchand ni un encaissement réel. Les essais de navigateur couvrent l’installation, les formulaires, les comptes et les rôles. Avec Chromium installé : `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:browser` ; sinon installer le navigateur de Playwright avec `npx playwright install chromium` avant `npm run test:browser`. Aucun hébergement public n’est créé par les commandes locales.
