# Comptoir

Première version exécutable d'une application de gestion de stock, de vente et d'inventaire, en français, destinée aux commerces du **Bénin**. Elle fonctionne dans le navigateur sur ordinateur ou mobile et fournit une base pour les prochaines étapes Cloud et Android/iOS.

## Essayer sans installation

Une [démonstration autonome](demo/README.md) permet d'essayer les produits, ventes, paiements et inventaires dans un fichier HTML unique. Construire le fichier avec `npm run build:demo`, puis ouvrir `dist/Comptoir-demo.html` dans le navigateur et choisir **Administrateur**. Le fichier fonctionne sans serveur ni abonnement ; les données d'essai restent sur cet appareil et les comptes sont des rôles de démonstration. Il n'envoie pas de courriel et ne crée pas de compte de production.

## Démarrer

Ces commandes lancent l’application sur la machine où elles sont exécutées. Dans cet environnement cloud, le serveur est interne à la machine distante : `localhost:3000` dans le navigateur de votre ordinateur ou téléphone ne pointe pas vers elle. Ce chat de configuration ne fournit pas d’aperçu web. Publier l’environnement Codex conserve sa configuration ; cela ne publie pas l’application comme un site Internet.

Pour utiliser l’application depuis votre appareil, exécuter le projet localement sur cet appareil, ou déployer le serveur sur un hébergement proposant une adresse HTTPS. Ouvrir directement `public/index.html` ne suffit pas : l’interface a besoin de l’API Node.js et de la base SQLite.

Prérequis : Node.js **24 ou supérieur**, npm et un navigateur récent. La persistance utilise SQLite intégré à Node.js ; aucun serveur de base de données séparé n'est nécessaire.

```bash
npm ci
npm run dev
```

Ouvrir [http://localhost:3000](http://localhost:3000). Le mode développement redémarre le serveur après modification de ses fichiers. Pour un lancement simple :

```bash
npm start
```

Si le port est occupé :

```bash
PORT=3001 npm run dev
```

Ne pas lancer deux serveurs sur la même base pour cette première version. Les données créées sont persistantes : un redémarrage du serveur ne remet pas le stock à zéro.

La base se trouve par défaut dans `data/stock.sqlite`. La variable `STOCK_DB_PATH` permet de choisir un autre emplacement ; son répertoire doit être accessible en écriture au serveur. Les photos se trouvent dans `uploads/`, ou dans le répertoire défini par `STOCK_UPLOAD_DIR`. Conserver la base et les photos ensemble.

Pour obtenir une adresse HTTPS accessible depuis un téléphone ou un ordinateur, suivre le [guide de déploiement Render](docs/DEPLOYMENT.md). Le dépôt fournit un conteneur Docker et un Blueprint avec disque persistant. Le compte Render et l'acceptation de son tarif sont nécessaires pour créer le service ; la présence de ces fichiers ne met pas l'application en ligne.

### Comptes de démonstration

| Rôle | Identifiant |
| --- | --- |
| Administrateur | `admin@stock.local` |
| Caissier / vendeur | `cashier@stock.local` |
| Agent d'inventaire | `inventory@stock.local` |

Le mot de passe de ces comptes est `Demo2026!`. Il est public et réservé aux essais locaux. Les données de démonstration permettent de tester immédiatement les recherches, les magasins et les alertes de stock. Les coordonnées et IFU de démonstration sont fictifs.

Pour un démarrage en mode production, fournir `NODE_ENV=production` et, pour le bootstrap administrateur, `STOCK_ADMIN_EMAIL` et `STOCK_ADMIN_PASSWORD` par la configuration sécurisée de l'environnement. Le mot de passe administrateur doit comporter au moins 12 caractères. Le mode production désactive les comptes de démonstration et une base neuve démarre sans catalogue commercial de démonstration. Une base déjà utilisée conserve ses données : utiliser une base distincte pour les essais et la production.

Une instance réellement ouverte au public peut aussi proposer le parcours **Créer un compte** décrit ci-dessous. Il faut alors activer `REGISTRATION_ENABLED` et configurer un relais SMTP avant de communiquer l'adresse aux commerçants. Si l'envoi de courriel n'est pas configuré, garder l'inscription publique désactivée et utiliser le compte administrateur de bootstrap.

Un déploiement commercial exige également HTTPS, la gestion complète des utilisateurs, l'isolation des organisations, la sauvegarde et les validations décrites dans l'[architecture](docs/ARCHITECTURE.md).

| Variable | Usage |
| --- | --- |
| `PORT` | Port HTTP, `3000` par défaut |
| `STOCK_DB_PATH` | Emplacement de la base, `data/stock.sqlite` par défaut |
| `STOCK_UPLOAD_DIR` | Répertoire des photos, `uploads/` par défaut, accessible en lecture/écriture |
| `NODE_ENV` | `production` pour désactiver les connexions de démonstration |
| `STOCK_ADMIN_EMAIL` | Adresse du premier administrateur de production |
| `STOCK_ADMIN_PASSWORD` | Secret initial de cet administrateur, au moins 12 caractères |
| `APP_ORIGIN` | Origine autorisée du site, par exemple `https://stock.exemple.fr` |
| `TRUST_PROXY` | `1` uniquement derrière le proxy HTTPS unique prévu par le déploiement |
| `REGISTRATION_ENABLED` | `true` pour afficher l'inscription publique après configuration du courriel |
| `SMTP_HOST` | Nom DNS du relais SMTP transactionnel |
| `SMTP_PORT` | Port SMTP du relais, généralement `587` ou `465` |
| `SMTP_USER` | Identifiant du relais SMTP, à conserver dans le gestionnaire de secrets |
| `SMTP_PASSWORD` | Mot de passe ou jeton SMTP, à conserver dans le gestionnaire de secrets |
| `MAIL_FROM` | Adresse expéditrice vérifiée, par exemple `Comptoir <no-reply@exemple.bj>` |
| `SMTP_SECURE` | `true` pour TLS implicite (souvent port 465), `false` pour STARTTLS (souvent port 587) |
| `EMAIL_TRANSPORT` | `smtp` en production ; `capture` pour les tests locaux, sans envoi réel |

Les codes à six chiffres expirent après 15 minutes, acceptent cinq essais et peuvent être renvoyés après 60 secondes, au maximum cinq envois par heure et par inscription. La devise est XOF et le fuseau Africa/Porto-Novo. En développement, les messages sont capturés en mémoire ; les tests consultent le transport directement, aucune route HTTP ne divulgue les codes.

Les variables administrateur servent au provisionnement initial ; modifier leur valeur ne remplace pas le mot de passe d'un compte déjà créé. `SMTP_USER` et `SMTP_PASSWORD` sont des secrets : les saisir dans le coffre de l'hébergeur, jamais dans `render.yaml`, le dépôt, une capture d'écran ou un message. Ne pas enregistrer de secrets dans le dépôt.

### S'inscrire et créer sa boutique (production)

Le propriétaire ouvre l'adresse HTTPS et choisit **Créer un compte**. Il saisit son nom, son adresse e-mail, un mot de passe d'au moins 12 caractères, le nom de sa boutique et sa ville. Comptoir envoie un code à usage unique à cette adresse. Le compte n'est créé et activé qu'après la saisie d'un code valide. Le code et le mot de passe sont hachés dans la demande en attente ; aucun secret n'est envoyé dans une réponse d'API ou conservé dans la file hors-ligne.

La vérification crée, dans une même transaction, le compte propriétaire **Administrateur**, son espace commercial et son premier magasin vide, puis ouvre une session. L'administrateur peut compléter l'adresse, le téléphone et l'IFU dans les paramètres du magasin, ajouter les produits et créer des comptes **Caissier / vendeur** ou **Agent d'inventaire**. Les mots de passe des collaborateurs sont choisis par l'administrateur et ne sont jamais affichés ensuite.

Une adresse e-mail ne peut correspondre qu'à un compte actif selon la règle d'unicité du serveur. Les demandes répétées sont limitées par adresse et par adresse IP ; une erreur d'envoi doit rester visible sans révéler si une adresse existe déjà. Le prestataire doit tester un vrai message reçu, un code expiré, un code réutilisé, un dépassement d'essais et une adresse déjà utilisée avant d'ouvrir l'inscription au public.

Chaque inscription crée un espace indépendant dans la plateforme. Les données métier et les photos sont filtrées par l'espace obtenu depuis la session serveur ; le navigateur ne choisit pas ce périmètre. Les comptes créés par un administrateur rejoignent son commerce. Les données historiques et de démonstration restent dans leur espace initial et ne sont pas attribuées aux nouveaux inscrits. Les tests HTTP couvrent les tentatives d'accès croisé aux magasins, produits, contacts, documents, inventaires, utilisateurs et photos.

## Parcours du premier incrément

1. Créer le compte propriétaire, vérifier l'adresse e-mail avec le code reçu, puis créer la première boutique. Se connecter comme administrateur et compléter les paramètres.
2. Choisir un magasin pour voir son catalogue et les références sous le seuil minimum. Rechercher par texte, puis créer ou modifier un produit : SKU, catégorie, unité, prix, seuil, marque, tags, emplacement et notes. Ajouter une photo si nécessaire.
3. Créer un tiers client ou fournisseur, puis enregistrer un document d'achat, de vente, de transfert ou d'ajustement. Les articles se sélectionnent par recherche. Un paiement peut être partiel ; les versements suivants complètent le règlement.
4. Créer une session d'inventaire et saisir les quantités réellement comptées. Consulter les écarts et faire valider la session par un administrateur. Si le stock a changé depuis sa création, résoudre le conflit avant validation.
5. Consulter les rapports, enregistrer les frais généraux et exporter les données en CSV. Importer un catalogue depuis un CSV pour préparer un essai avec ses propres articles.
6. Ajouter les utilisateurs depuis l'administration et essayer les deux rôles restreints : le caissier traite les ventes sans accès aux coûts d'achat ni aux marges ; l'agent saisit les comptages autorisés.

Le mode « sans prix » permet de masquer les données financières pour les parcours de comptage. Les droits restent contrôlés par l'API.

La monnaie du prototype est le **franc CFA BCEAO (XOF)**, utilisé au Bénin : les montants sont des entiers, sans centimes. Les tiers peuvent renseigner leur IFU. Les quantités acceptent jusqu'à trois décimales et sont conservées en milli-unités. Les catégories sont des chemins textuels (`Épicerie / Céréales`) ; chaque fiche a une photo et les magasins de démonstration sont préconfigurés. Les documents sont enregistrés directement ; le cycle brouillon/validation et le journal de stock normalisé font partie de la suite.

L'unité d'un article ayant du stock, des documents ou un inventaire ne peut plus être changée : créer une autre référence pour une autre unité. Un tiers référencé par un document conserve son type client ou fournisseur ; créer une fiche séparée s'il doit aussi jouer l'autre rôle.

Les marges utilisent le coût d'achat de référence mémorisé lors de la vente. Les rapports restent estimatifs tant que le coût moyen pondéré ou FIFO, les taxes et les retours ne sont pas implémentés.

### PWA et travail hors-ligne

L'interface responsive peut être installée comme PWA dans les navigateurs compatibles, y compris sur l'écran d'accueil iOS lorsque le navigateur le permet. Cette livraison reste une application Web, sans application native publiée dans les boutiques Android/iOS. En dehors de `localhost`, le service worker et l'installation nécessitent HTTPS.

Après une première connexion, la coque applicative et les données autorisées peuvent être mises en cache. Les opérations saisies hors-ligne sont conservées dans une file locale IndexedDB. Elles restent **en attente** jusqu'à leur acceptation par le serveur ; elles ne diminuent pas silencieusement le stock validé. Un conflit ou un rejet doit être traité avant de considérer l'opération comme enregistrée.

L'envoi reprend à la reconnexion et fait l'objet de nouvelles tentatives périodiques pendant que l'application est ouverte. Une expiration de session conserve les commandes en attente : se reconnecter avec le même compte pour les envoyer. Les rejets métier restent visibles dans la file et nécessitent une intervention.

Ce mécanisme vise la reprise vers cette même instance serveur. La synchronisation Cloud entre organisations ou appareils, l'arbitrage complet des conflits et la garantie de disponibilité du stock hors-ligne feront l'objet d'un incrément dédié. Deux appareils déconnectés ne peuvent pas garantir l'absence de survente sans quotas ou réservations.

## Validation

```bash
npm test
```

Les tests métier et HTTP vérifient les contrôles de rôle, le stock insuffisant, les effets des mouvements, la répétition d'une commande et l'inventaire devenu obsolète.

Les tests navigateur utilisent Playwright (`@playwright/test` 1.63.0). Installer Chromium une fois, puis lancer les scénarios :

```bash
npx playwright install chromium
npm run test:e2e
```

Si Chromium est déjà installé sur la machine, on peut préciser son chemin :

```bash
PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium npm run test:e2e
```

Chaque scénario démarre son propre serveur, une base SQLite en mémoire et un dossier de téléversement temporaire. Il utilise un port libre et ne modifie pas la base de développement. Les scénarios exercent le catalogue, les achats/ventes et paiements partiels, le comptage et sa validation, le rechargement hors-ligne puis la reprise, et les restrictions des rôles dans une vue mobile.

## Périmètre et prochaines étapes

Le premier incrément regroupe catalogue et recherche, plusieurs magasins dans une instance, documents de stock, tiers et paiements, sessions de comptage, rapports, frais, inscription vérifiée par e-mail, compte propriétaire administrateur, création de la première boutique, utilisateurs aux rôles limités, CSV et une interface Web/PWA. SQLite conserve les données métier du serveur ; les photos sont des fichiers locaux.

Le serveur permet désormais l'inscription de plusieurs commerces indépendants, avec vérification e-mail et isolation des données. La prochaine étape prépare PostgreSQL, la récupération de compte, la synchronisation incrémentale et les futures applications mobiles. Le déploiement SQLite reste limité à une instance serveur avec disque persistant.

Les capacités suivantes nécessitent encore une livraison spécifique :

- PostgreSQL et stockage objet pour plusieurs instances serveur, récupération de compte et synchronisation incrémentale avec conflits entre appareils.
- Applications natives Android/iOS et intégrations matérielles Bluetooth/Wi-Fi.
- Import/export Excel `.xlsx`, PDF générés et facturation normalisée adaptée au Bénin.
- Externalisation des sauvegardes vers un stockage distinct du serveur et surveillance des échecs ; la sauvegarde locale cohérente, sa rétention et sa restauration contrôlée sont livrées dans [BACKUPS.md](docs/BACKUPS.md).
- Valorisation comptable complète, taxes, remises et retours selon les règles retenues pour le commerce.

Le téléchargement d'un instantané JSON constitue un export local ; aucune interface de restauration de cet instantané n'est fournie. Il ne remplace pas une sauvegarde automatique incluant la base SQLite, les photos et une procédure de restauration. L'impression du navigateur, lorsqu'elle est proposée, dépend de celui-ci ; l'impression directe Bluetooth/Wi-Fi demande un adaptateur et du matériel compatible.

L'intégration **e-MECeF** reste à concevoir à partir de la documentation, des accès et des exigences officiels. Cette version ne produit pas de facture fiscale certifiée ; renseigner un IFU ou imprimer un reçu ne réalise aucune certification.

La conception détaillée, les règles de stock, les limites hors-ligne, le modèle de données cible et la progression étape par étape se trouvent dans [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
