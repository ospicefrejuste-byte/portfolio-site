#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { createBackup, createBackupArchive, verifyBackup, pruneBackups } = require('../lib/backups');

function argumentsOf(argv) {
  const options = {};
  for (const arg of argv) {
    const match = /^--(to|db|uploads|archive|verify|retention)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(options, match[1])) throw new Error('Usage : node scripts/backup.js --to=/dossier [--db=/base.sqlite --uploads=/photos --archive=/archive.tar.gz --retention=7], ou --verify=/sauvegarde');
    options[match[1]] = match[2];
  }
  return options;
}

async function main() {
  const args = argumentsOf(process.argv.slice(2));
  if (args.verify) {
    if (Object.keys(args).length !== 1) throw new Error('--verify doit être utilisé seul.');
    const result = await verifyBackup(args.verify);
    console.log(`Sauvegarde vérifiée : ${result.path} (${result.manifest.files.length - 1} photos).`);
    return;
  }
  const targetDir = args.to || process.env.STOCK_BACKUP_DIR;
  if (!targetDir) throw new Error('Définissez --to=/dossier ou STOCK_BACKUP_DIR.');
  const retention = args.retention === undefined ? undefined : Number(args.retention);
  if (retention !== undefined && (!Number.isInteger(retention) || retention < 1 || retention > 365)) throw new Error('--retention doit être un entier compris entre 1 et 365.');
  const result = await createBackup({ targetDir, dbPath: args.db, uploadDir: args.uploads });
  if (args.archive) {
    const archive = await createBackupArchive({ backupDir: result.path, outputPath: path.resolve(args.archive) });
    console.log(`Archive créée : ${archive.path}.`);
  }
  if (retention !== undefined) await pruneBackups(targetDir, retention);
  console.log(`Sauvegarde complète : ${result.path} (${result.manifest.files.length - 1} photos).`);
}

main().catch(error => { console.error(`Sauvegarde impossible : ${error.message}`); process.exitCode = 1; });
