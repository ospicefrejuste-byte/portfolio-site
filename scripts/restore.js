#!/usr/bin/env node
'use strict';

const { restoreBackup } = require('../lib/backups');

async function main() {
  const args = {};
  let serviceStopped = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === '--service-stopped' && !serviceStopped) { serviceStopped = true; continue; }
    const match = /^--(from|to)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(args, match[1])) throw new Error('Usage : node scripts/restore.js --from=/sauvegarde --to=/nouveau-dossier --service-stopped');
    args[match[1]] = match[2];
  }
  const result = await restoreBackup({ backupDir: args.from, targetDir: args.to, serviceStopped });
  console.log(`Restauration complète : ${result.path}. Les anciennes sessions sont révoquées.`);
  console.log(`STOCK_DB_PATH=${result.dbPath}`);
  console.log(`STOCK_UPLOAD_DIR=${result.uploadDir}`);
  console.log('Configurez ces deux chemins puis redémarrez Comptoir. Le mot de passe des comptes est conservé.');
}

main().catch(error => { console.error(`Restauration impossible : ${error.message}`); process.exitCode = 1; });
