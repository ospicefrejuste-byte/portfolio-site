#!/usr/bin/env node
'use strict';
// Build artifact only: use the standard zip utility on the cloud build machine.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {execFileSync}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const root=path.resolve(__dirname,'..');
const output=path.resolve(process.argv[2]||path.join(root,'dist','Comptoir-Windows.zip'));
execFileSync(process.execPath,[path.join(root,'scripts','build-demo.js')],{stdio:'inherit'});
const staging=fs.mkdtempSync(path.join(os.tmpdir(),'comptoir-windows-package-'));
const temporary=output+'.'+randomUUID()+'.zip';
try{
  fs.mkdirSync(path.dirname(output),{recursive:true});
  fs.copyFileSync(path.join(root,'dist','Comptoir-demo.html'),path.join(staging,'Ouvrir-Comptoir.html'));
  const instructions=[
    'COMPTOIR — VERSION WINDOWS 0.2.0',
    '',
    '1. Faites un clic droit sur le ZIP, puis choisissez « Extraire tout ».',
    '2. Dans le dossier extrait, ouvrez Ouvrir-Comptoir.html avec Microsoft Edge ou Chrome.',
    '3. Choisissez Administrateur pour explorer la démonstration.',
    '',
    'Aucun logiciel à installer. La démonstration fonctionne sans Internet.',
    'Utilisez des données fictives : les comptes et rôles sont simulés.',
    '',
    'Vos modifications restent dans le stockage de ce navigateur sur cet appareil.',
    'Paramètres > Télécharger une sauvegarde conserve les produits, photos et profils.',
    'Paramètres > Restaurer une sauvegarde remplace les données présentes.',
    'Sauvegardez avant de changer de navigateur, de dossier ou d’ordinateur.',
    '',
    'L’INSCRIPTION RÉELLE PAR E-MAIL',
    'La plateforme serveur propose la création d’un compte avec mot de passe,',
    'la vérification par code e-mail et la création d’une boutique indépendante.',
    'Ce parcours nécessite un serveur hébergé et le service d’e-mail configuré.',
    'Le fichier autonome ne crée pas de compte serveur et n’envoie pas de codes.',
    '',
    'Code et dossier à transmettre au prestataire :',
    'https://github.com/ospicefrejuste-byte/portfolio-site/tree/comptoir-v0.2.0',
    'Message prêt à envoyer : docs/MESSAGE-HEBERGEUR.txt dans le dépôt.',
    ''
  ].join('\r\n');
  fs.writeFileSync(path.join(staging,'LIRE-MOI.txt'),'\ufeff'+instructions);
  execFileSync('zip',['-q','-9',temporary,'Ouvrir-Comptoir.html','LIRE-MOI.txt'],{cwd:staging});
  fs.renameSync(temporary,output);
  console.log('Livraison Windows générée : '+output);
}finally{
  fs.rmSync(staging,{recursive:true,force:true});
  if(fs.existsSync(temporary))fs.unlinkSync(temporary);
}
