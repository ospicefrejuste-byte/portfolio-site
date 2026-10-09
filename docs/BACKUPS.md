# Sauvegarder et restaurer Comptoir

La version serveur sauvegarde **la base SQLite complète et toutes les photos**. L’export JSON depuis les rapports sert à consulter les données ; il ne remplace pas cette sauvegarde. La démonstration Windows fonctionne dans le navigateur et n’utilise pas la base SQLite du serveur.

## Sauvegarde automatique du serveur

Configurez les variables suivantes chez votre hébergeur, dans des dossiers situés sur le disque persistant :

```text
STOCK_DB_PATH=/var/lib/comptoir/data/stock.sqlite
STOCK_UPLOAD_DIR=/var/lib/comptoir/uploads
STOCK_BACKUP_DIR=/var/lib/comptoir/data/backups
STOCK_BACKUP_INTERVAL_HOURS=24
STOCK_BACKUP_RETENTION=7
```

Lorsque `STOCK_BACKUP_DIR` est défini, le serveur réalise une première sauvegarde au démarrage, puis une sauvegarde toutes les 24 heures. La rétention conserve **les 7 dernières sauvegardes complètes**, et non 7 jours. L’intervalle et le nombre conservé se règlent avec les deux dernières variables ; les valeurs par défaut sont 24 heures et 7 sauvegardes. Une sauvegarde incomplète n’est jamais publiée comme terminée. Les erreurs sont signalées dans les journaux du serveur. Un seul processus doit gérer ce disque et ce calendrier.

Le dossier de sauvegarde doit être distinct du dossier des photos. Il doit être lisible et accessible en écriture par l’utilisateur du serveur. Les dossiers créés reçoivent les permissions `0700` et les fichiers `0600` sur les systèmes qui les prennent en charge. La sauvegarde contient les clients, les informations commerciales et les empreintes des mots de passe ; elle doit rester privée. Elle n’est pas chiffrée par Comptoir.

**Une sauvegarde sur le même disque protège contre une mauvaise manipulation ; elle ne protège pas contre la perte de ce disque ou du compte d’hébergement.** L’hébergeur doit organiser une copie chiffrée quotidienne vers un espace distinct, avec accès limité, alertes en cas d’échec et essai de restauration périodique. Ces copies extérieures ne sont pas réalisées par ce module.

## Sauvegarde manuelle

Avec Node.js 24 ou supérieur, depuis le dossier du projet :

```bash
node scripts/backup.js --db=/var/lib/comptoir/data/stock.sqlite --uploads=/var/lib/comptoir/uploads --to=/var/lib/comptoir/data/backups --retention=7
```

`STOCK_DB_PATH`, `STOCK_UPLOAD_DIR` et `STOCK_BACKUP_DIR` peuvent remplacer les trois options de chemin. La base doit déjà exister : cette commande ne crée pas de base vide. La sauvegarde peut être réalisée pendant que le serveur fonctionne. L’API de sauvegarde SQLite produit un instantané cohérent, même si des ventes sont enregistrées dans le journal WAL. Les photos du serveur sont immuables ; le module vérifie que chaque photo référencée par le catalogue sauvegardé est présente, et copie aussi les images téléversées qui ne sont pas encore associées à un article.

Une sauvegarde crée ce dossier :

```text
comptoir-20261008T120000000Z-<identifiant>/
  manifest.json
  stock.sqlite
  uploads/
    <identifiant>.png
    ...
```

Le manifeste version 1 contient la date de création, la taille et l’empreinte SHA-256 de chaque fichier. La vérification contrôle aussi l’intégrité SQLite, les tables attendues, les relations et les références des photos. Elle refuse les chemins hors du dossier, les liens symboliques et les fichiers inattendus.

Pour vérifier une sauvegarde existante :

```bash
node scripts/backup.js --verify=/var/lib/comptoir/data/backups/comptoir-20261008T120000000Z-<identifiant>
```

Les limites de validation sont de 2 Gio pour la base, 5 Mio par photo, 100 000 photos et 20 Gio pour l’ensemble. Ces limites évitent de charger des fichiers anormalement volumineux pendant une restauration.

Une archive `.tar.gz` est facultative. Elle requiert le programme système `tar`, présent dans l’image Docker du projet, et une destination qui n’existe pas encore :

```bash
node scripts/backup.js --db=/var/lib/comptoir/data/stock.sqlite --uploads=/var/lib/comptoir/uploads --to=/var/lib/comptoir/data/backups --archive=/dossier-prive/comptoir-sauvegarde.tar.gz
```

La sauvegarde sous forme de dossier fonctionne sans `tar`, y compris avec Node.js sous Windows. Sous Windows, adaptez les chemins et entourez l’option complète de guillemets lorsqu’un chemin contient des espaces : `"--to=C:\Comptoir\Mes sauvegardes"`.

## Restaurer sans écraser les données actives

1. Arrêtez le service Comptoir chez l’hébergeur. Conservez la base et les photos actuelles jusqu’à validation de la restauration.
2. Si vous disposez d’une archive, extrayez-la dans **un nouveau dossier privé**, puis utilisez ce dossier comme source. Ne l’extrayez pas par-dessus l’installation active.
3. Vérifiez la sauvegarde avec `--verify`.
4. Restaurez dans un **nouveau dossier qui n’existe pas** :

```bash
node scripts/restore.js --from=/dossier-prive/sauvegarde --to=/var/lib/comptoir/restauration-20261008 --service-stopped
```

La confirmation `--service-stopped` est obligatoire. Le script refuse de remplacer un dossier existant ; il ne peut pas deviner si le service a réellement été arrêté. Il vérifie les empreintes avant la copie, puis pendant la copie, et contrôle la base restaurée. Une restauration ratée ne remplace pas les fichiers de production.

5. Configurez les chemins indiqués par la commande :

```text
STOCK_DB_PATH=/var/lib/comptoir/restauration-20261008/stock.sqlite
STOCK_UPLOAD_DIR=/var/lib/comptoir/restauration-20261008/uploads
```

6. Redémarrez Comptoir, reconnectez-vous avec le mot de passe du compte sauvegardé, puis vérifiez les références, le stock, une vente et une photo.

Les comptes et les mots de passe sont conservés, mais **toutes les anciennes sessions sont révoquées** : chaque utilisateur doit se reconnecter. Les opérations reçues après la date de la sauvegarde ne figurent pas dans la restauration ; il faut les contrôler avant de reprendre l’activité. N’effacez l’ancienne base et les anciens dossiers qu’après validation métier.

Un essai de restauration doit être effectué sur un environnement séparé avant la mise en service, puis régulièrement. Les tests du projet couvrent les sauvegardes avec écritures actives, les photos, les contrôles SHA-256, les chemins malveillants, la rétention, le refus d’écraser les données et la révocation des sessions.
