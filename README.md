# Comptoir 0.2.1

## Ouvrir la démonstration sur Windows

Télécharger `Comptoir-Windows.zip`, choisir **Extraire tout**, puis ouvrir
`Ouvrir-Comptoir.html` avec Microsoft Edge ou Chrome et choisir **Administrateur**.
La démonstration fonctionne sans serveur ni connexion. Les profils sont simulés
et les données fictives restent dans le navigateur de cet appareil.

Les paramètres permettent d'ajouter des magasins et des profils de démonstration,
de télécharger une sauvegarde JSON complète et de la restaurer. Les annulations
de documents impayés conservent l'historique et compensent le stock.

## Plateforme avec inscription réelle

`Comptoir-Plateforme.zip` contient les sources et les guides de déploiement de la
version serveur. Chaque commerçant peut s'inscrire avec son adresse e-mail et un
mot de passe, vérifier son code à six chiffres, puis accéder à sa propre boutique.
La plateforme sépare les produits, stocks, utilisateurs et photos des commerces.

Ce parcours exige un serveur Node.js 24/Docker, un disque persistant, HTTPS et
un relais SMTP configuré. Le fichier HTML autonome n'envoie pas d'e-mails.
Aucune URL de serveur de production n'est créée par cette branche statique.

Transmettre `MESSAGE-HEBERGEUR.txt` à un prestataire Node.js/Docker : il précise
la demande de mise en ligne, d'e-mail, de sauvegarde et de réception du service.

Sources vérifiées :
https://github.com/ospicefrejuste-byte/portfolio-site/tree/comptoir-v0.2.1

GitHub Pages peut publier cette démonstration : **Settings → Pages → Deploy from
a branch → comptoir-demo → /(root)**. Utiliser l'adresse réellement attribuée
après déploiement. Pages héberge la démonstration ; la plateforme serveur doit
être déployée séparément.
