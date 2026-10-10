# Version complète : Netlify et Supabase

Le dépôt propose une version serveur pour Netlify Functions avec une base PostgreSQL Supabase. Les inscriptions sont partagées entre appareils et l'accès administrateur est vérifié par le serveur. La version statique `demo-cours-netlify` reste une démonstration locale.

Choisir les offres **Free** des deux fournisseurs et rester dans leurs quotas. Les conditions des offres peuvent évoluer ; vérifier les limites dans leurs tableaux de bord. Un projet gratuit peut être mis en pause ou limité après une période d'inactivité ou un dépassement de quota. Aucun forfait payant n'est nécessaire à cette configuration et aucun service n'a été créé automatiquement.

## 1. Créer la base

1. Se connecter sur https://supabase.com/dashboard, avec GitHub ou une adresse e-mail.
2. Créer une organisation sur le plan **Free**, puis un projet nommé `cours-renforcement-scolaire`.
3. Choisir un mot de passe de base de données solide et le conserver en privé. Ce mot de passe ne sera pas celui du superviseur du site.
4. Choisir une région proche des utilisateurs et attendre que le projet soit prêt.
5. Ouvrir **Connect** et sélectionner la connexion PostgreSQL du **Transaction pooler**, généralement sur le port 6543. Copier l'adresse de connexion PostgreSQL et remplacer le mot de passe réservé par celui du projet. Si un mot de passe contient des caractères spéciaux, les encoder dans l'URL ou utiliser l'adresse générée par le fournisseur.

Ne pas envoyer l'adresse de connexion, le mot de passe ou les clés dans une conversation. Le navigateur n'utilise aucune clé Supabase. Les tables sont créées par le serveur et leur RLS est activée sans politique d'accès public : les utilisateurs de l'API publique Supabase ne peuvent pas les lire. Le serveur PostgreSQL accède aux tables avec le compte de base de données configuré en privé.

## 2. Configurer Netlify

Sur le projet Netlify existant, ouvrir **Project configuration → Environment variables**. Ajouter des variables pour le périmètre **Functions** et le contexte **Production** :

| Variable | Valeur à définir en privé |
| --- | --- |
| `DATABASE_URL` | Adresse PostgreSQL du pooler Supabase, avec le mot de passe du projet |
| `PUBLIC_ORIGIN` | `https://cours-renforcement-scolaire.netlify.app` (sans `/` final) |
| `CRS_SETUP_TOKEN` | Un code d'installation aléatoire d'au moins 32 caractères, conservé en privé |
| `KKIAPAY_SANDBOX` | `true` |

La connexion à PostgreSQL utilise TLS avec vérification du certificat. Si le fournisseur nécessite une autorité de certification spécifique, télécharger son certificat officiel et définir `DATABASE_CA_CERT` avec son contenu PEM. Ne pas désactiver la vérification TLS.

Le code d'installation est réservé au propriétaire du projet. Il permet de créer le premier compte depuis la page d'installation, une seule fois. Il n'est jamais ajouté au code ou envoyé au navigateur automatiquement. Le mot de passe du superviseur sera choisi lors de l'installation.

Configurer les paiements ensuite : `KKIAPAY_PUBLIC_KEY`, `KKIAPAY_PRIVATE_KEY` et `KKIAPAY_SECRET_KEY`. Utiliser de nouvelles clés à la place des clés qui ont déjà été partagées. Sans ces variables, les inscriptions fonctionnent et le site indique que le paiement n'est pas encore activé. Aucune réussite de paiement ne sera simulée dans cette version.

## 3. Déployer le serveur

Dans **Build & deploy**, sélectionner :

- Branche : `site-complet-gratuit`.
- Base directory : vide.
- Build command : `npm run build:cloud`.
- Publish directory : `public`.
- Functions directory : `netlify/functions`.

Le fichier `netlify.toml` fournit les règles de routage et les réglages de construction. Il force le passage de `/administration` et `/gestion.html` par le serveur : même leur URL directe nécessite une session valide. Ne pas remplacer ces règles par une redirection générale vers un fichier statique.

Déclencher un déploiement et attendre le statut **Published**. La génération n'utilise pas la base de données et ne nécessite aucun secret dans le périmètre Build. Les tables sont créées lors de la première requête serveur.

## 4. Créer le compte superviseur

1. Ouvrir le site et cliquer sur **Administration**.
2. Cliquer sur **Configurer le premier administrateur**.
3. Entrer le code `CRS_SETUP_TOKEN` défini dans Netlify, puis choisir son identifiant et un mot de passe d'au moins 12 caractères et le confirmer.
4. Se connecter et vérifier les listes, affectations et statistiques. Aucun compte ni mot de passe par défaut n'est fourni. Un visiteur sans code privé ne peut pas créer le compte superviseur.
5. Tester l'inscription depuis un autre navigateur : elle doit apparaître dans l'administration sur l'autre appareil. Tester ensuite le paiement KKiaPay en mode test avant toute activation réelle.

## Contrôles et limites

La version serveur a été testée localement contre PostgreSQL 17 : authentification, rôles, persistance, validation des paiements, protection des dossiers, création concurrente d'un unique superviseur, confirmations de paiement simultanées et cookies sécurisés en mode serverless. Les transactions sont sérialisées pour empêcher les doublons de paiement. Les limites de tentatives sont stockées en base et restent actives entre plusieurs instances serveur.

Le projet Supabase réel et le déploiement Netlify de cette version ne sont pas encore configurés. Les tests KKiaPay utilisent un vérificateur simulé ; la connexion au prestataire et les certificats du fournisseur seront à vérifier avec les services réels. Il n'y a pas de migration automatique des exemples locaux de la démo vers la base réelle : commencer les inscriptions réelles sur la version serveur uniquement.

L'export des dossiers est disponible dans l'administration. Prévoir également les sauvegardes de la base proposées par Supabase ou un export PostgreSQL privé. Les comptes et mots de passe ne sont pas inclus dans l'export public des dossiers.

### Mot de passe séparé (facultatif)

Pour éviter d’encoder les symboles manuellement, ajoutez `DATABASE_PASSWORD` comme variable secrète dans Netlify, disponible pour les Functions en Production. Sa valeur est le mot de passe actuel de la base Supabase, saisi tel quel. Il remplace le mot de passe inclus dans `DATABASE_URL`, dont le serveur, le port et l’utilisateur restent nécessaires. Redéployez après modification. Ne partagez aucune de ces valeurs.
