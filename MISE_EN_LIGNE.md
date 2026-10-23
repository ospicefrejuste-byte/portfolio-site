# Publier la ferme ADEOYE

La plateforme est un projet distinct du site scolaire. Ne changez pas le projet Netlify `cours-renforcement-scolaire`, sa branche de production, ni sa base.

## 1. Base de données de la ferme

Créer un projet PostgreSQL dédié à ADEOYE, par exemple dans Supabase. Conserver son mot de passe et ses paramètres dans un gestionnaire de mots de passe. Utiliser l’adresse de connexion affichée par ce projet (pooler compatible avec le réseau de l’hébergement). L’application crée ses tables `adeoye_*` et active leur protection RLS ; ne pas exposer la clé ni l’adresse de connexion dans les fichiers publics.

## 2. Nouveau projet Netlify

Depuis Netlify, ajouter un nouveau projet en important le dépôt GitHub `ospicefrejuste-byte/portfolio-site`, **branche `ferme-adeoye`**. Choisir un nouveau nom disponible pour ADEOYE. Ne pas modifier la branche de l’ancien site. Le fichier `netlify.toml` configure :

| Champ | Valeur |
| --- | --- |
| Dossier de base | Racine de la branche |
| Build command | `npm run build` |
| Publish directory | `public` |
| Functions directory | `netlify/functions` |
| Version Node | `24` |

Un simple dépôt du dossier `public` ne suffit pas : les fonctions serveur et la base partagée sont nécessaires.

## 3. Paramètres privés dans Netlify

Créer les variables suivantes pour le contexte **Production**, disponibles aux **Functions** (ou tous les périmètres autorisés). Marquer les valeurs sensibles comme secrètes. Ne pas copier des astérisques d’un champ masqué, ni coller les valeurs dans une conversation.

| Variable | Contenu |
| --- | --- |
| `ADEOYE_DATABASE_URL` | Adresse de connexion PostgreSQL complète du projet ADEOYE |
| `ADEOYE_DATABASE_PASSWORD` | Facultatif : mot de passe de cette base, fourni séparément de l’URL pour éviter l’encodage manuel des symboles |
| `ADEOYE_DATABASE_CA_CERT` | Facultatif : autre autorité PEM complète, si nécessaire. Les autorités de production Supabase 2021 et 2025 sont déjà intégrées automatiquement pour les hôtes Supabase |
| `ADEOYE_PUBLIC_ORIGIN` | Adresse HTTPS exacte du nouveau site, sans chemin, par exemple l’adresse Netlify qui vient d’être attribuée |
| `ADEOYE_SETUP_TOKEN` | Nouveau code privé long et aléatoire généré pour la première installation ADEOYE |

Pour éviter de diffuser la même base dans des aperçus, ne pas fournir les secrets de production aux Deploy Previews ou aux branches d’essai. Une instance de test doit utiliser une base distincte. La fonction renvoie une indisponibilité explicite si les paramètres requis manquent, au lieu de créer un inventaire éphémère.

## 4. Première ouverture

Après l’enregistrement des variables, lancer un déploiement de production et attendre **Published**. Ouvrir `/installation.html` sur le nouveau domaine, saisir le code privé et choisir le compte responsable. L’installation se ferme ensuite aux nouveaux comptes responsables ; les comptes supplémentaires passent par **Accès & équipe**.

Créer un compte **Consultation à distance** pour la personne aux États-Unis et un compte **Équipe de la ferme** pour la personne autorisée à enregistrer les stocks. Transmettre leurs accès par un moyen privé ; chacune choisira son propre mot de passe lors de sa première connexion.

Vérifier ensuite avec deux appareils : un mouvement réellement autorisé sur le compte de gestion, sa consultation sur l’autre compte, le téléchargement PDF et l’impossibilité pour le lecteur de modifier les stocks. Pour les essais, privilégier une base de test distincte. Ne pas inventer de stock réel pour démontrer l’interface.

## Mises à jour et sauvegardes

Les nouveaux commits de `ferme-adeoye` déclenchent la publication du nouveau projet si la publication automatique est activée. Attendre **Published** avant d’annoncer qu’une version est disponible. Les données restent dans PostgreSQL entre les déploiements. Un domaine personnalisé est possible ensuite ; actualiser `ADEOYE_PUBLIC_ORIGIN` et redéployer lors d’un changement d’adresse.

Activer les sauvegardes du fournisseur de base et vérifier les limites du forfait de l’hébergement. Une suspension de service, un manque de quota ou un incident réseau ne peut pas être corrigé par une simple modification de l’interface.

## Comprendre un démarrage refusé

Après une modification des variables, redéployer et attendre **Published**. Si l’installation échoue, le message affiché donne une référence : `ADEOYE_CONFIG_MISSING` (variable absente du contexte Production/Functions), `ADEOYE_DATABASE_URL_INVALID` (URI invalide), `ADEOYE_PUBLIC_ORIGIN_INVALID` (adresse du site invalide), `ADEOYE_DB_AUTH` (connexion à la base refusée), `ADEOYE_DB_TLS` (certificat refusé), `ADEOYE_DB_NETWORK` (base inaccessible), ou `ADEOYE_DB_ACCESS` (droits de base insuffisants). La fonction `api` journalise le code précis et les noms des variables manquantes, jamais leur contenu. Fournir uniquement cette référence au support.
