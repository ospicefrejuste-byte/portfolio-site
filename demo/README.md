# Essayer Comptoir sans serveur

La démonstration autonome se construit depuis le dépôt :

```sh
node scripts/build-demo.js
```

Ouvrir ensuite `dist/Comptoir-demo.html` directement dans le navigateur. Le fichier contient l'interface et les règles métier ; aucun serveur Node.js, compte d'hébergement ou connexion Internet n'est nécessaire pour l'essayer. Choisir **Administrateur** sur l'écran d'accueil pour commencer.

Les articles, mouvements, paiements et inventaires sont enregistrés dans le stockage du navigateur de cet appareil. Les comptes et les rôles sont des exemples publics permettant de tester les parcours ; ils ne protègent pas ce stockage comme une authentification serveur. Utiliser des données fictives pour cette démonstration. Effacer les données du navigateur efface également celles de la démo ; exporter les données utiles avant cette opération.

La version serveur conserve son fonctionnement et sa configuration de déploiement décrits dans `docs/DEPLOYMENT.md`. La démonstration autonome ne réalise aucun partage de stock entre appareils.

## Adresse gratuite avec GitHub Pages

La même page autonome peut être publiée sur GitHub Pages dans ce dépôt public. L'activation du site nécessite un réglage du propriétaire du dépôt : **Settings → Pages → Deploy from a branch**, puis choisir la branche de démonstration et **/(root)**. Utiliser l'adresse HTTPS réellement indiquée par GitHub après son déploiement ; la présence d'une branche seule ne prouve pas qu'un site est actif.

La branche **`comptoir-demo`** fournit `index.html` et le fichier à télécharger `Comptoir-demo.html`. Elle contient uniquement la démonstration autonome et ses données fictives.

Un [aperçu interactif HTMLPreview](https://htmlpreview.github.io/?https://github.com/ospicefrejuste-byte/portfolio-site/blob/comptoir-demo/index.html) peut ouvrir ce fichier public sans activer Pages. Ce service tiers utilise une origine partagée : utiliser uniquement des données fictives. Son code officiel a été exercé localement avec le fichier autonome ; son adresse publique est bloquée par le proxy de cet environnement, donc son disponibilité en ligne n'a pas pu être vérifiée ici.

## Vérification de la démonstration

Les 13 tests du moteur vérifient les règles de stock, paiements, rôles et inventaires. Quatre parcours navigateur vérifient la vente, le paiement, les photos et leur conservation après rechargement, l'inventaire, les vues mobiles et les écritures simultanées de deux fenêtres. Ils chargent le fichier HTML complet par une requête interceptée, puis fonctionnent sans réseau ni backend. Le Chromium géré de cet environnement interdit `file://` ; l'ouverture directe d'un fichier téléchargé n'a donc pas été testée dans ce navigateur.
