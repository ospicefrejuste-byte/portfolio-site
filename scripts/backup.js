"use strict";
const fs = require("node:fs"), path = require("node:path");
const { DatabaseSync, backup } = require("node:sqlite");
(async () => {
  if (process.env.ADEOYE_DATABASE_URL) throw Error("Pour PostgreSQL, utilisez les sauvegardes sécurisées du fournisseur d’hébergement.");
  const dataDir = path.resolve(process.env.ADEOYE_DATA_DIR || path.join(__dirname, "..", ".data"));
  const source = path.join(dataDir, "adeoye.sqlite");
  if (!fs.existsSync(source)) throw Error("Aucune base locale ADEOYE à sauvegarder.");
  const destinationDir = path.join(dataDir, "backups"); fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
  const destination = path.join(destinationDir, "adeoye-" + new Date().toISOString().replace(/[:.]/g, "-") + ".sqlite");
  const db = new DatabaseSync(source, { readOnly: true });
  try { await backup(db, destination); fs.chmodSync(destination, 0o600); } finally { db.close(); }
  console.log("Sauvegarde privée créée dans le dossier backups de la base ADEOYE.");
})().catch(error => { console.error(error.message); process.exitCode = 1; });
