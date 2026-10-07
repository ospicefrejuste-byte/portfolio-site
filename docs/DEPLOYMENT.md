# Héberger Comptoir avec une URL HTTPS

Cette configuration prépare une instance **Render Docker** avec un disque persistant pour la base SQLite et les photos. Elle ne provisionne aucun compte Render et ne constitue pas la preuve d'un déploiement réalisé. L'hébergement doit être activé dans un compte disposant d'un accès au dépôt et d'un moyen de paiement.

## Configuration livrée

- [Dockerfile](../Dockerfile) : Node.js `24.19.0-bookworm-slim`, installation des dépendances depuis le lockfile, contrôle de santé et serveur exécuté avec l'utilisateur `node` (UID/GID 1000).
- [deploy/docker-entrypoint.sh](../deploy/docker-entrypoint.sh) : préparation des deux répertoires persistants, puis remplacement du processus par le serveur via `gosu node`.
- [render.yaml](../render.yaml) : service Web `starter`, région Francfort, une instance, déploiement automatique désactivé et disque persistant de 1 Go.
- [.dockerignore](../.dockerignore) : données locales, images, dépendances, fichiers `.env` et métadonnées exclus du contexte de construction.

Le plan `starter` et le disque sont **payants**. Vérifier le tarif présenté par Render avant de créer le service. Une instance sans disque persistant perdrait les données SQLite et les images lors d'un redéploiement ou remplacement du conteneur.

La base et les photos utilisent **le même disque** :

| Donnée | Chemin |
| --- | --- |
| Base SQLite et fichiers WAL/SHM | `/var/lib/comptoir/data/stock.sqlite` et fichiers voisins |
| Photos des produits | `/var/lib/comptoir/uploads` |

Le conteneur initialise uniquement les sous-répertoires `data` et `uploads` du disque avec les permissions nécessaires, puis `gosu` abandonne les privilèges root et remplace son processus par le serveur. L'application s'exécute sous UID/GID 1000. Les données de l'hôte ne sont pas copiées dans l'image. La première mise en route de production crée le magasin principal vide et l'administrateur configuré.

## Créer le service

1. Publier cette version du dépôt et son `render.yaml` sur la branche `codex/comptoir-cloud-deploy`, ciblée par la configuration. La branche `main` historique ne contient pas nécessairement l'application Comptoir.
2. Dans le [tableau de bord Render](https://dashboard.render.com/), connecter le compte GitHub au dépôt `ospicefrejuste-byte/portfolio-site`, puis choisir **New → Blueprint**, ce dépôt et la branche **`codex/comptoir-cloud-deploy`**. Relire le service et le disque proposés avant d'engager leur coût.
3. Renseigner les deux variables demandées dans le formulaire sécurisé Render :
   - `STOCK_ADMIN_EMAIL` : une adresse administrateur réelle, distincte des comptes publics de démonstration.
   - `STOCK_ADMIN_PASSWORD` : un mot de passe unique d'au moins **12 caractères**. Ne jamais l'ajouter à `render.yaml`, au dépôt ou à un message de discussion.
4. Créer le service, lancer son déploiement et attendre que `/api/health` retourne HTTP 200. Le serveur écoute `0.0.0.0` et le port défini par `PORT`.
5. Ouvrir **l'URL HTTPS effectivement attribuée par Render** et se connecter avec l'administrateur configuré. Aucun lien public propre à cette instance ne peut être déterminé avant sa création.
6. Dans les variables du service, définir `APP_ORIGIN` sur cette origine HTTPS exacte, sans chemin, puis redéployer. Exemple de format : `https://nom-attribue.onrender.com`. Si un domaine personnalisé est ensuite choisi, modifier l'origine en conséquence.

Les connexions publiques `admin@stock.local`, `cashier@stock.local` et `inventory@stock.local` sont refusées en production. Les variables administrateur servent uniquement à la création initiale : changer leur valeur ne remplace pas le mot de passe d'un compte déjà existant.

`TRUST_PROXY=1` correspond au proxy HTTPS frontal prévu ici. Ne pas reprendre cette valeur dans une architecture comprenant plusieurs proxies ou un accès public direct au conteneur sans vérifier sa chaîne de confiance. Les cookies de production sont sécurisés et exigent HTTPS dans le navigateur.

## Vérifier le déploiement

Avant d'y enregistrer des opérations commerciales réelles :

1. Vérifier `/api/config` : `demoMode` doit être `false`, et `/api/health` doit répondre `{ "ok": true }`.
2. Se connecter, créer un produit fictif, téléverser une photo et enregistrer une entrée de stock.
3. Redéployer le service, puis vérifier que la fiche, son stock et la photo existent toujours.
4. Vérifier que les comptes de démonstration sont refusés et qu'une session de production fonctionne sur l'URL HTTPS.
5. Contrôler les journaux sans y afficher de secrets ; vérifier le statut du disque et l'espace disponible.

Les commandes de tests du dépôt restent celles du [README](../README.md). Le scénario de persistance après redéploiement complète ces tests ; la présence d'un contrôle de santé ne suffit pas à le démontrer.

### Validation effectuée dans cet environnement

La construction Docker a réussi et le conteneur a été exécuté en production avec des identifiants temporaires de test. Le contrôle de santé, le chargement de l'interface sous UID/GID 1000, le refus du compte de démonstration et les attributs du cookie de session ont été vérifiés. Un article, une entrée de stock de 2,5 kg et une photo ont été conservés après arrêt propre et redémarrage avec le même volume. La base locale de développement n'a pas été utilisée. Les 28 tests métier/HTTP et les 8 scénarios navigateur passent également.

Le réseau de cet environnement exige son proxy et son certificat d'autorité. Le build local a utilisé les arguments de proxy Docker et un certificat fourni uniquement comme secret BuildKit `build_ca` ; ce certificat n'est pas incorporé dans l'image. Sur Render, le build normal ne nécessite pas ce secret. Cette validation locale ne remplace pas l'ouverture de l'URL HTTPS après création du service.

## Exploitation et limites

Conserver **une seule instance** : SQLite, ses écritures et le répertoire local de photos dépendent de ce disque. Le Blueprint fixe `numInstances: 1` ; ne pas activer de montée en charge horizontale. Pour plusieurs instances, migrer d'abord vers PostgreSQL et un stockage objet, avec isolation des commerces et migrations contrôlées. Un redéploiement peut interrompre brièvement l'instance ; les saisies locales en attente doivent reprendre après le retour du service.

Le disque persistant n'est pas une sauvegarde externe. Prévoir des sauvegardes cohérentes de SQLite, des photos et des paramètres, puis tester une restauration vers une instance séparée. En mode WAL, copier seulement le fichier principal pendant une écriture n'est pas une procédure de sauvegarde valide. L'automatisation complète reste une étape de la [feuille de route](ARCHITECTURE.md).

Cette publication rend le MVP Web accessible par HTTPS ; elle n'ajoute pas les applications natives, la synchronisation Cloud multi-organisations ni la facturation fiscale e-MECeF du Bénin. Les règles métier et limites du prototype restent applicables.

## Références officielles

- [Spécification des Blueprints Render](https://docs.render.com/blueprint-spec)
- [Disques persistants Render](https://docs.render.com/disks)
- [Déploiements Docker Render](https://docs.render.com/docker)
- [Exemple Express officiel Render](https://github.com/render-examples/express-hello-world/blob/039c34770852fb07cef7f9f0f8534c5de408b207/render.yaml)

L'accès aux pages de documentation a été refusé par le proxy réseau de l'environnement lors de la préparation. L'exemple GitHub officiel a été consulté pour confirmer la structure générale du Blueprint. La variante du bouton de déploiement permettant de sélectionner une branche n'a pas été vérifiée ; utiliser la sélection explicite du dépôt et de la branche dans le tableau de bord. Le Blueprint doit être validé par Render lors de son import ; aucun service ni coût n'a été engagé par ces fichiers seuls.
