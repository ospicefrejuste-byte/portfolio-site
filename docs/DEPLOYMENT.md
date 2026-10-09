# Héberger Comptoir avec une URL HTTPS

Cette configuration prépare une instance **Render Docker** avec un disque persistant pour la base SQLite et les photos. Elle ne provisionne aucun compte Render et ne constitue pas la preuve d'un déploiement réalisé. L'hébergement doit être activé dans un compte disposant d'un accès au dépôt et d'un moyen de paiement.

Pour confier cette étape à un prestataire, remettre le [dossier de reprise](HANDOFF.md) et le [message prêt à envoyer](MESSAGE-HEBERGEUR.txt). L'application nécessite le serveur Node.js ; le ZIP Windows autonome est une démonstration locale, avec des rôles simulés.

## Configuration livrée

- [Dockerfile](../Dockerfile) : Node.js `24.19.0-bookworm-slim`, installation des dépendances depuis le lockfile, contrôle de santé et serveur exécuté avec l'utilisateur `node` (UID/GID 1000).
- [deploy/docker-entrypoint.sh](../deploy/docker-entrypoint.sh) : préparation des deux répertoires persistants, puis remplacement du processus par le serveur via `gosu node`.
- [render.yaml](../render.yaml) : service Web `starter`, région Francfort, une instance, déploiement automatique désactivé et disque persistant de 1 Go.
- [.dockerignore](../.dockerignore) : données locales, images, dépendances, fichiers `.env` et métadonnées exclus du contexte de construction.

Le plan `starter` et le disque sont **payants**. Vérifier le tarif présenté par Render avant de créer le service. Une instance sans disque persistant perdrait les données SQLite et les images lors d'un redéploiement ou remplacement du conteneur.

Le devis distingue la mise en ligne initiale, l'hébergement et le disque, un éventuel domaine, les copies de sauvegarde extérieures et la maintenance. Le volume initial de 1 Go doit être ajusté pour contenir les données actives, les photos et les sauvegardes locales conservées.

## Inscription publique, code e-mail et première boutique

Depuis la page de connexion, le propriétaire choisit **Créer un compte**, renseigne son nom, son adresse e-mail, un mot de passe d'au moins 12 caractères, sa boutique et sa ville, puis confirme le code à usage unique reçu par e-mail. La validation crée son compte administrateur, son espace indépendant et son premier magasin vide. Il peut ensuite compléter l'adresse, le téléphone et l'IFU, ajouter les produits, les magasins supplémentaires et les comptes caissier ou agent d'inventaire.

Avant d'activer ce bouton, le prestataire configure un relais SMTP transactionnel et vérifie son domaine d'expédition. Les secrets restent dans le gestionnaire de secrets Render ; ils ne vont ni dans `render.yaml`, ni dans Git, ni dans les journaux. Les noms de variables attendus sont :

| Variable | Valeur à renseigner |
| --- | --- |
| `REGISTRATION_ENABLED` | `true` uniquement lorsque le SMTP et l'URL HTTPS sont prêts |
| `SMTP_HOST` | Hôte DNS du relais SMTP |
| `SMTP_PORT` | `587` avec STARTTLS ou `465` avec TLS implicite |
| `SMTP_USER` | Identifiant du relais, saisi comme secret |
| `SMTP_PASSWORD` | Mot de passe ou jeton du relais, saisi comme secret |
| `MAIL_FROM` | Adresse expéditrice vérifiée, par exemple `Comptoir <no-reply@exemple.bj>` |
| `SMTP_SECURE` | `false` pour STARTTLS, `true` pour TLS implicite |
| `EMAIL_TRANSPORT` | `smtp` en production |

Le code expire après 15 minutes et cinq essais ; le renvoi est limité à une fois par minute et cinq fois par heure. Les inscriptions et vérifications sont aussi limitées par IP et adresse e-mail. Les valeurs initiales de la boutique sont XOF et Africa/Porto-Novo.

`APP_ORIGIN` doit être l'origine HTTPS exacte attribuée au service, sans chemin. Elle protège les requêtes du navigateur. Tester un message reçu depuis un appareil extérieur avant de diffuser l'URL. Le code doit être saisi sur la plateforme ; aucun lien de validation contenant un secret n'est généré. L'adresse e-mail est confirmée avant la création du compte.

Le compte créé par ce parcours est le propriétaire administrateur de la boutique qu'il vient de créer. Il peut gérer le catalogue, les magasins, les paramètres et les utilisateurs. Un caissier ne voit pas les coûts d'achat ni l'administration ; un agent d'inventaire ne valide pas les inventaires. Une désactivation, un changement de rôle ou une réinitialisation de mot de passe révoque les sessions de l'utilisateur concerné.

Le bootstrap `STOCK_ADMIN_EMAIL` / `STOCK_ADMIN_PASSWORD` permet une ouverture sans inscription publique. Avec `REGISTRATION_ENABLED=true`, une base de production neuve démarre également sans ces identifiants et les propriétaires créent eux-mêmes leur compte vérifié. Chaque commerce dispose d'un périmètre serveur indépendant ; les tests d'accès croisé doivent passer avant la mise en ligne. Le compte de bootstrap et les anciennes données restent dans le périmètre historique.

La base et les photos utilisent **le même disque** :

| Donnée | Chemin |
| --- | --- |
| Base SQLite et fichiers WAL/SHM | `/var/lib/comptoir/data/stock.sqlite` et fichiers voisins |
| Photos des produits | `/var/lib/comptoir/uploads` |
| Sauvegardes locales recommandées | `/var/lib/comptoir/data/backups` |

Le conteneur initialise uniquement les sous-répertoires `data` et `uploads` du disque avec les permissions nécessaires, puis `gosu` abandonne les privilèges root et remplace son processus par le serveur. L'application s'exécute sous UID/GID 1000. Les données de l'hôte ne sont pas copiées dans l'image. La première mise en route de production crée le magasin principal vide et l'administrateur configuré.

## Créer le service

1. Publier cette version du dépôt et son `render.yaml` sur la branche `codex/comptoir-cloud-deploy`, ciblée par la configuration. La branche `main` historique ne contient pas nécessairement l'application Comptoir.
2. Dans le [tableau de bord Render](https://dashboard.render.com/), connecter le compte GitHub au dépôt `ospicefrejuste-byte/portfolio-site`, puis choisir **New → Blueprint**, ce dépôt et la branche **`codex/comptoir-cloud-deploy`**. Relire le service et le disque proposés avant d'engager leur coût.
3. Renseigner les variables demandées dans le formulaire sécurisé Render :
   - `STOCK_ADMIN_EMAIL` : une adresse administrateur réelle, distincte des comptes publics de démonstration, si le bootstrap est retenu.
   - `STOCK_ADMIN_PASSWORD` : un mot de passe unique d'au moins **12 caractères**, si le bootstrap est retenu. Ne jamais l'ajouter à `render.yaml`, au dépôt ou à un message de discussion.
   - `REGISTRATION_ENABLED=true` pour autoriser le parcours public après les essais.
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` et `SMTP_SECURE` selon le fournisseur de courriel. Marquer `SMTP_USER` et `SMTP_PASSWORD` comme secrets ; ne pas les écrire dans un fichier suivi par Git.
   - Le Blueprint active l'inscription avec `EMAIL_TRANSPORT=smtp` et les sauvegardes quotidiennes locales. Configurer les copies extérieures séparément.
4. Créer le service, lancer son déploiement et attendre que `/api/health` retourne HTTP 200. Le serveur écoute `0.0.0.0` et le port défini par `PORT`.
5. Ouvrir **l'URL HTTPS effectivement attribuée par Render**. Aucun lien public propre à cette instance ne peut être déterminé avant sa création. Définir `APP_ORIGIN` sur cette origine HTTPS exacte, sans chemin, puis redéployer. Exemple de format : `https://nom-attribue.onrender.com`. Si un domaine personnalisé est ensuite choisi, modifier l'origine en conséquence.
6. Si l'inscription est activée, choisir **Créer un compte**, utiliser une adresse de test réelle, saisir le code reçu et créer la boutique. Vérifier que le compte devient administrateur, que le premier magasin est créé et que les informations de boutique sont conservées après une nouvelle connexion. Sinon, se connecter avec le compte de bootstrap et désactiver le bouton d'inscription.
7. Ajouter un utilisateur caissier et un agent d'inventaire depuis l'administration, puis vérifier leurs limites. Ne communiquer l'URL aux commerçants qu'après la réussite de ces essais et d'un test de livraison e-mail depuis l'extérieur.

Les connexions publiques `admin@stock.local`, `cashier@stock.local` et `inventory@stock.local` sont refusées en production. Les variables administrateur servent uniquement à la création initiale : changer leur valeur ne remplace pas le mot de passe d'un compte déjà existant.

`TRUST_PROXY=1` correspond au proxy HTTPS frontal prévu ici. Ne pas reprendre cette valeur dans une architecture comprenant plusieurs proxies ou un accès public direct au conteneur sans vérifier sa chaîne de confiance. Les cookies de production sont sécurisés et exigent HTTPS dans le navigateur.

## Vérifier le déploiement

Avant d'y enregistrer des opérations commerciales réelles :

1. Vérifier `/api/config` : `demoMode` doit être `false`, et `/api/health` doit répondre `{ "ok": true }`.
2. Se connecter, créer un produit fictif, téléverser une photo et enregistrer une entrée de stock.
3. Redéployer le service, puis vérifier que la fiche, son stock et la photo existent toujours.
4. Vérifier que les comptes de démonstration sont refusés et qu'une session de production fonctionne sur l'URL HTTPS.
5. Tester le parcours public avec une adresse de test : demande de code, réception, code expiré, code réutilisé, dépassement d'essais, renvoi après délai, adresse déjà utilisée et mot de passe trop court. Contrôler que les codes et secrets ne figurent ni dans les journaux ni dans les réponses.
6. Contrôler les journaux sans y afficher de secrets ; vérifier le statut du disque et l'espace disponible.
7. Créer un magasin et un utilisateur depuis l'administration ; contrôler les restrictions du caissier et de l'agent, puis les effets d'une désactivation de compte.
8. Produire une sauvegarde, la copier hors de l'instance et démontrer la restauration de la base et d'une photo dans un environnement séparé.

Les commandes de tests du dépôt restent celles du [README](../README.md). Le scénario de persistance après redéploiement complète ces tests ; la présence d'un contrôle de santé ne suffit pas à le démontrer.

### Validation effectuée dans cet environnement

Le socle Docker a été construit et exécuté localement en production avec des identifiants temporaires de test. Le contrôle de santé, le chargement de l'interface sous UID/GID 1000, le refus du compte de démonstration et les attributs du cookie de session ont été vérifiés. Un article, une entrée de stock de 2,5 kg et une photo ont été conservés après arrêt propre et redémarrage avec le même volume. La base locale de développement n'a pas été utilisée. Les suites métier/HTTP et navigateur sont disponibles dans le dépôt ; leurs résultats doivent être consignés pour le commit effectivement livré, plutôt que figer un nombre de tests dans ce guide.

Le réseau de cet environnement exige son proxy et son certificat d'autorité. Le build local a utilisé les arguments de proxy Docker et un certificat fourni uniquement comme secret BuildKit `build_ca` ; ce certificat n'est pas incorporé dans l'image. Sur Render, le build normal ne nécessite pas ce secret. Cette validation locale ne remplace pas l'ouverture de l'URL HTTPS après création du service.

## Exploitation et limites

Conserver **une seule instance** : SQLite, ses écritures et le répertoire local de photos dépendent de ce disque. Le Blueprint fixe `numInstances: 1` ; ne pas activer de montée en charge horizontale. Pour plusieurs instances, migrer d'abord vers PostgreSQL et un stockage objet, avec isolation des commerces et migrations contrôlées. Un redéploiement peut interrompre brièvement l'instance ; les saisies locales en attente doivent reprendre après le retour du service.

Le disque persistant n'est pas une sauvegarde externe. Les outils ci-dessous produisent une sauvegarde cohérente locale ; le prestataire doit organiser sa copie extérieure et surveiller son résultat. En mode WAL, copier seulement le fichier principal pendant une écriture n'est pas une procédure de sauvegarde valide.

### Sauvegarde locale et restauration

Depuis la racine du projet ou le conteneur, un technicien peut créer une sauvegarde :

```bash
node scripts/backup.js --to=/var/lib/comptoir/data/backups
```

Les sources viennent de `STOCK_DB_PATH` et `STOCK_UPLOAD_DIR` ; les options `--db` et `--uploads` permettent de les préciser. Chaque sauvegarde crée un dossier `comptoir-...` contenant `stock.sqlite`, `uploads/` et un `manifest.json` avec version, tailles et empreintes SHA-256. La base provient de l'API de sauvegarde SQLite et les références aux photos du snapshot sont contrôlées. Le dossier doit ensuite être copié vers un stockage distinct de l'instance de production.

La planification locale se configure avec `STOCK_BACKUP_DIR`. Le répertoire recommandé, `/var/lib/comptoir/data/backups`, est accessible au processus applicatif sans donner l'écriture à la racine du disque. Une sauvegarde est lancée au démarrage, puis toutes les 24 heures par défaut. `STOCK_BACKUP_INTERVAL_HOURS` règle cet intervalle ; `STOCK_BACKUP_RETENTION=7` conserve les sept dernières sauvegardes, et non sept jours. Ne pas laisser `STOCK_BACKUP_DIR` absent en croyant disposer d'une sauvegarde automatique. L'[exploitation des sauvegardes](BACKUPS.md) détaille ces outils et leur restauration.

Pour une restauration, arrêter le service et choisir un répertoire de destination **inexistant** dans un environnement de reprise :

```bash
node scripts/restore.js --from=/chemin/sauvegarde/comptoir-... --to=/chemin/restauration-neuve --service-stopped
```

L'outil contrôle les fichiers et les empreintes, refuse d'écraser une destination existante et révoque les sessions restaurées. La destination contient `stock.sqlite` et `uploads/`. Pour l'activer, définir `STOCK_DB_PATH` et `STOCK_UPLOAD_DIR` sur ces nouveaux chemins, puis redémarrer et contrôler produits, soldes, documents, utilisateurs et photos. L'opération doit d'abord être essayée sur une instance séparée ; le drapeau `--service-stopped` ne remplace pas l'arrêt réel du serveur.

Le contrat d'exploitation doit fixer la copie extérieure, la rétention, la surveillance des échecs et un délai de reprise acceptable. PostgreSQL, la restauration à un instant donné et le stockage objet restent des évolutions de la [feuille de route](ARCHITECTURE.md).

Cette publication rend le MVP Web accessible par HTTPS ; elle n'ajoute pas les applications natives, la synchronisation Cloud multi-organisations ni la facturation fiscale e-MECeF du Bénin. Les règles métier et limites du prototype restent applicables.

L'inscription publique dépend de la disponibilité du relais SMTP et de la délivrabilité du domaine (DNS, SPF/DKIM/DMARC selon le fournisseur). La réception réelle et le lien HTTPS restent à vérifier sur l'hébergement choisi. La réinitialisation de mot de passe, la double authentification et l'appartenance d'un compte à plusieurs organisations demandent un incrément dédié. Les tests livrés couvrent déjà l'isolation des commerces inscrits dans la même base.

## Références officielles

- [Spécification des Blueprints Render](https://docs.render.com/blueprint-spec)
- [Disques persistants Render](https://docs.render.com/disks)
- [Déploiements Docker Render](https://docs.render.com/docker)
- [Exemple Express officiel Render](https://github.com/render-examples/express-hello-world/blob/039c34770852fb07cef7f9f0f8534c5de408b207/render.yaml)
- [Assistance Render](https://render.com/support), pour les questions propres au fournisseur ; la mise en ligne de l'application peut être confiée au prestataire décrit dans le [dossier de remise](HANDOFF.md).

L'accès aux pages de documentation a été refusé par le proxy réseau de l'environnement lors de la préparation. L'exemple GitHub officiel a été consulté pour confirmer la structure générale du Blueprint. La variante du bouton de déploiement permettant de sélectionner une branche n'a pas été vérifiée ; utiliser la sélection explicite du dépôt et de la branche dans le tableau de bord. Le Blueprint doit être validé par Render lors de son import ; aucun service ni coût n'a été engagé par ces fichiers seuls.
