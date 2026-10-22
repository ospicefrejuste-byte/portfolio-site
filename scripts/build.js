"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const root = path.join(__dirname, "..");
const required = ["index.html", "connexion.html", "installation.html", "app.html", "app.js", "app.css", "auth.js", "welcome.js", "welcome.css", "mark.svg"];
const hash = crypto.createHash("sha256");
for (const name of required) hash.update(name).update(fs.readFileSync(path.join(root, "public", name)));
fs.writeFileSync(path.join(root, "public", "version.json"), JSON.stringify({ version: hash.digest("hex") }) + "\n");
console.log("Plateforme ADEOYE préparée. Aucun secret ni jeu de données inclus.");
