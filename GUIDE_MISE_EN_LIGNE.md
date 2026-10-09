# Option gratuite avec base partagée

Pour Netlify + Supabase, suivre [GUIDE_HEBERGEMENT_GRATUIT.md](GUIDE_HEBERGEMENT_GRATUIT.md). Le guide ci-dessous concerne une installation autonome Node.js ou Docker.

# Mettre le site en ligne

Le dossier contient la vraie application avec un serveur et une base de données. Elle doit être installée sur un hébergement Node.js 24 ou Docker, avec un disque persistant pour conserver les élèves, comptes et paiements.

1. Choisir l’hébergement et un nom de domaine. Le site sera accessible en HTTPS.
2. Installer l’application : les commandes détaillées sont dans README.md. Une configuration Docker avec HTTPS automatique est fournie.
3. Ouvrir la page **installation.html** sur le site. Récupérer le code privé dans la console de l’hébergement et choisir son identifiant et son mot de passe administrateur.
4. Se connecter, puis valider les préinscriptions dans **Élèves**. Créer les enseignants, les cours et leurs comptes dans **Comptes & accès**.
5. Dans les paramètres sécurisés de l’hébergement, saisir les trois nouvelles clés KKiaPay : publique, privée et secrète. Remplacer toutes les clés déjà envoyées dans une conversation. Ne pas les inscrire dans le code.
6. Garder **KKIAPAY_SANDBOX=true** pour un premier paiement de test. Vérifier le reçu et sa confirmation auprès de KKiaPay. Les essais automatiques utilisent un prestataire simulé ; ils ne remplacent pas cet essai.
7. Après activation du compte marchand par KKiaPay, configurer les clés réelles et le mode réel. Programmer des sauvegardes régulières du disque de données.

Les identifiants ne sont pas prédéfinis. Aucun mot de passe ni clé de paiement n’est inclus dans ce dossier. Les paiements réels et l’hébergement doivent encore être activés sur les services correspondants.
