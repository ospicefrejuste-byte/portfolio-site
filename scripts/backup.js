"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const dataDir = path.resolve(
  process.env.CRS_DATA_DIR || path.join(__dirname, "..", ".data"),
);
const destination = path.resolve(
  process.argv[2] ||
    path.join(
      __dirname,
      "..",
      "backups",
      `school-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`,
    ),
);
if (!fs.existsSync(path.join(dataDir, "school.sqlite")))
  throw Error("Base de données introuvable.");
if (fs.existsSync(destination))
  throw Error("Le fichier de destination existe déjà.");
fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(path.join(dataDir, "school.sqlite"));
try {
  db.prepare("VACUUM INTO ?").run(destination);
  fs.chmodSync(destination, 0o600);
  console.log(`Sauvegarde créée : ${destination}`);
} finally {
  db.close();
}
