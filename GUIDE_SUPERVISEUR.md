# Accès du superviseur

La version complète utilise un serveur, une base SQLite persistante et des sessions sécurisées. La démo statique sur Netlify reste une démonstration, sans authentification réelle.

## Première installation

1. Configurer Netlify et la base Supabase en suivant `GUIDE_HEBERGEMENT_GRATUIT.md`. Choisir les offres Free et vérifier leurs quotas.
2. Récupérer en privé la valeur `CRS_SETUP_TOKEN` dans les variables de l'hébergement. Si cette variable n'est pas définie, utiliser le fichier privé `/data/setup-token` du serveur. Ne partager ni ce code ni le mot de passe dans la conversation.
3. Cliquer sur **Administration**, puis **Configurer le premier administrateur**. Renseigner le code d'installation, choisir son identifiant et un mot de passe d'au moins 12 caractères, puis confirmer le mot de passe.
4. La création est possible une seule fois. Ensuite, utiliser son identifiant et son mot de passe pour se connecter. Un visiteur ne peut pas créer un autre compte superviseur depuis la page publique.
5. Se déconnecter en quittant l'administration, notamment sur un ordinateur partagé. La session expire après huit heures.

## Parcours des familles

L'accueil contient uniquement le formulaire d'inscription et le lien Administration. Après inscription, la famille reçoit une confirmation et peut cliquer sur Payer. Un accès de paiement aléatoire, limité à ce dossier et valable 24 heures, est utilisé pendant le parcours : il ne donne accès ni aux autres élèves ni à l'administration. Le tarif vient du serveur.

Les paiements sont confirmés uniquement après vérification serveur auprès de KKiaPay. Un callback du navigateur ne suffit pas. Sans les trois nouvelles clés configurées en privé, le site indique que le paiement n'est pas activé. En mode sandbox, les paiements sont identifiés comme des tests et exclus des encaissements réels.

## Données et statistiques

Les inscriptions sont partagées entre appareils via le serveur. Le superviseur retrouve les dossiers, enseignants, affectations, présences, paiements, notes, comptes et statistiques. Le classement des enseignants porte sur leur charge (élèves accompagnés puis séances), pas sur leur qualité pédagogique.

Effectuer un vrai essai KKiaPay en mode test après déploiement. Les tests automatiques du projet utilisent un prestataire simulé. Sauvegarder le disque de données régulièrement. Ne pas utiliser un disque éphémère pour les inscriptions réelles.
