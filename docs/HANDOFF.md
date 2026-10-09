# Dossier de remise — Comptoir

## Résultat attendu

Mettre Comptoir en ligne pour un commerce du **Bénin** et remettre à son propriétaire une **URL HTTPS utilisable sur ordinateur et téléphone**, un parcours d'inscription par adresse e-mail, une première boutique créée pendant l'accueil, un compte administrateur personnel et une sauvegarde restaurable. Le propriétaire souhaite confier la mise en ligne à un prestataire ; aucun message n'a été envoyé et aucun service payant n'a été créé dans ce travail.

Le code est disponible. La création du compte d'hébergement, le choix de son tarif et le déploiement public restent à réaliser. La démonstration Windows permet d'examiner les parcours sans installation ; elle utilise des données locales et des rôles simulés, et ne remplace pas le service de production.

## À qui remettre ce dossier

Choisir un **développeur ou prestataire informatique maîtrisant Node.js, Docker, les bases de données persistantes et l'envoi de courriels transactionnels**. Il doit pouvoir déployer l'application, configurer un SMTP avec une adresse expéditrice vérifiée, vérifier les droits et organiser les sauvegardes. Un hébergement de pages HTML seules ne peut pas exécuter l'API Node.js, envoyer le code de vérification ni conserver la base serveur.

Pour les questions propres à la plateforme Render, utiliser son [tableau de bord](https://dashboard.render.com/) et son [assistance officielle](https://render.com/support). L'assistance de la plateforme et la prestation d'installation/maintenance de l'application sont deux services distincts. La page d'assistance n'a pas pu être consultée depuis l'environnement de travail ; aucun nom, téléphone ou prestataire local n'est présenté comme vérifié.

Le texte prêt à copier figure dans [MESSAGE-HEBERGEUR.txt](MESSAGE-HEBERGEUR.txt). Il demande un devis et une mise en ligne concrète. Le propriétaire l'enverra lui-même au prestataire choisi.

## Sources et documents à transmettre

| Élément | Référence |
| --- | --- |
| Dépôt | [ospicefrejuste-byte/portfolio-site](https://github.com/ospicefrejuste-byte/portfolio-site) |
| Branche de livraison | [`codex/comptoir-cloud-deploy`](https://github.com/ospicefrejuste-byte/portfolio-site/tree/codex/comptoir-cloud-deploy) |
| Version à déployer | Tag `comptoir-v0.2.1` — son SHA est à consigner dans la remise |
| Lancement, fonctionnalités et tests | [README](../README.md) |
| Déploiement Render et variables | [DEPLOYMENT.md](DEPLOYMENT.md) |
| Modèle métier et étapes suivantes | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Sauvegarde et restauration | [BACKUPS.md](BACKUPS.md) |
| Image de production et disque | [Dockerfile](../Dockerfile), [render.yaml](../render.yaml), [entrypoint](../deploy/docker-entrypoint.sh) |

Le prestataire confirme dans sa remise le commit effectivement déployé. La branche `main` historique ne doit pas être choisie à la place de la branche de livraison. Les identifiants d'hébergement, mots de passe et fichiers `.env` se transmettent par les outils sécurisés du fournisseur, jamais dans le message ni dans le dépôt.

## Hébergement demandé

Le chemin fourni est **Render Blueprint → conteneur Docker → une instance avec disque persistant**. Le prestataire connecte le dépôt à un compte Render appartenant au propriétaire, sélectionne la branche indiquée, relit le service et son coût, puis déclenche le déploiement. Render attribue ensuite l'URL HTTPS ; un domaine personnalisé pourra être ajouté.

Configuration technique :

- Node.js 24, Express et SQLite ; l'image est épinglée sur `node:24.19.0-bookworm-slim` et installe les dépendances avec le lockfile.
- `NODE_ENV=production`, initialisation sécurisée du premier administrateur et refus des comptes publics de démonstration.
- Inscription configurable par `REGISTRATION_ENABLED`, avec code e-mail à durée limitée et limites d'essais/renvoi ; le relais SMTP est fourni par les variables `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` et `SMTP_SECURE`.
- La devise et le fuseau proposés à une nouvelle boutique sont `XOF` et `Africa/Porto-Novo` ; le propriétaire vérifié devient administrateur et crée le premier magasin.
- **Une seule instance**. Le disque monté sur `/var/lib/comptoir` contient la base et les photos ; les données ne doivent pas résider dans le système de fichiers éphémère du conteneur.
- `/api/health` pour le contrôle de santé, port fourni par `PORT`, écoute sur `0.0.0.0`, origine HTTPS réelle dans `APP_ORIGIN` et proxy configuré pour ce déploiement.
- Base : `/var/lib/comptoir/data/stock.sqlite`. Photos : `/var/lib/comptoir/uploads`. Processus applicatif sous UID/GID 1000.

Un VPS ou une autre plateforme convient aussi si le prestataire fournit le serveur Node/Docker, HTTPS, un volume durable, les mêmes variables et les mêmes critères de réception. Le déploiement SQLite actuel ne permet pas de multiplier les instances serveur.

## Périmètre à réceptionner

La plateforme accueille **plusieurs commerces indépendants**, chacun avec ses magasins et ses utilisateurs aux rôles administrateur, caissier et agent d'inventaire. Elle fournit un catalogue recherché par texte, les mouvements, les tiers, les paiements partiels, les comptages, les rapports et les exports CSV. Le propriétaire renseigne sa boutique et son compte, confirme le code reçu et obtient son espace administrateur vide. La monnaie est le franc CFA BCEAO (XOF), les IFU sont des champs d'identification et les résultats financiers sont estimatifs hors taxes.

Le code d'inscription est à usage unique, expire selon la configuration et ne doit pas être visible dans les journaux. Le prestataire teste l'adresse expéditrice, la réception réelle, l'expiration, la réutilisation, le nombre maximal d'essais et le renvoi temporisé. `SMTP_USER` et `SMTP_PASSWORD` sont saisis comme secrets dans l'hébergeur ; aucune valeur secrète ne figure dans le dépôt ou ce dossier.

Les applications natives Android/iOS, la récupération de mot de passe, l'import Excel, les imprimantes Bluetooth/Wi-Fi et la facturation fiscale **e-MECeF** constituent des étapes supplémentaires. La PWA est une application Web installable lorsque le navigateur le permet. Un reçu imprimé n'est pas une facture fiscale certifiée.

## Sauvegarde et reprise

Le projet prépare des sauvegardes cohérentes de SQLite et des images, avec manifeste et contrôle d'intégrité. Le prestataire doit conserver des copies **hors du disque et de l'instance de production**, définir leur fréquence et leur rétention, et fournir une procédure de restauration essayée. Les commandes techniques sont détaillées dans le [guide de déploiement](DEPLOYMENT.md).

L'export JSON du navigateur et la persistance du disque ne remplacent pas cette sauvegarde. Le devis distingue les sauvegardes locales réalisées par l'application et leur copie extérieure, avec contrôle des échecs.

## Critères de réception

Avant de considérer la mise en ligne comme livrée, demander au prestataire de démontrer les points suivants :

1. **Accès et inscription** : URL HTTPS active depuis Windows et un téléphone ; propriétaire capable de créer son compte avec une adresse e-mail, de saisir le code reçu et de créer sa première boutique ; comptes de démonstration refusés en production.
2. **Catalogue et persistance** : création d'un produit et de sa photo, entrée de stock, puis conservation des données et de la photo après un redéploiement.
3. **Magasins et personnel** : propriétaire capable de compléter sa boutique, de créer un second magasin et un utilisateur ; transfert cohérent entre magasins ; caissier incapable de voir les coûts d'achat ou d'administrer les utilisateurs ; agent incapable de valider les stocks.
4. **Vente et comptage** : vente avec paiement partiel puis complément, calcul du solde, annulation motivée d'un document non payé avec stock compensé, validation d'un inventaire sans perte de mouvements intervenus pendant le comptage ; refus d'une sortie dépassant le stock. Les remboursements des documents payés restent une évolution distincte.
5. **Reprise réseau** : saisie hors-ligne présentée comme en attente, puis acceptation une seule fois à la reconnexion ; rejet visible si le stock disponible a changé.
6. **Sauvegarde** : copie extérieure identifiable et restauration de la base et d'au moins une photo vers une instance séparée, sans écraser le service en activité.
7. **Remise** : compte d'hébergement et accès administrateur sous le contrôle du propriétaire, commit déployé, procédure de mise à jour, sauvegarde/restauration et tarifs convenus.

Ces vérifications s'effectuent d'abord avec des données fictives. Leur résultat et l'URL sont consignés dans la remise du prestataire.

## Devis à demander

Demander séparément le **coût initial** de mise en ligne, configuration SMTP, tests d'inscription et recette, puis les **coûts récurrents** : hébergement, disque, éventuel domaine, fournisseur de courriel, copies de sauvegarde extérieures et maintenance. Render `starter` et le disque persistant sont payants ; le tarif réel doit être présenté avant création. Aucun prix ni délai ferme n'est inventé dans ce dossier.

La maintenance doit préciser qui applique les mises à jour, surveille les sauvegardes, contrôle la délivrabilité des courriels et intervient en cas de panne. Le propriétaire choisit l'offre après réception du devis et garde la maîtrise de son compte, de son domaine d'envoi et de ses données.

Demander au prestataire de vérifier deux inscriptions indépendantes dans la même plateforme : aucun compte ne doit voir ou modifier les produits, magasins, stocks, utilisateurs ou photos de l'autre commerce. Ces accès sont couverts par les tests HTTP livrés. La récupération de compte et la double authentification restent des étapes séparées.
