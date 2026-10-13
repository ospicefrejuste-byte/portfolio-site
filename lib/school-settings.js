"use strict";
const catalogue = require("./catalogue");
const fail = (status, message) => Object.assign(new Error(message), { status });
const defaults = {
  name: "COURS DE RENFORCEMENT SCOLAIRE",
  tagline: "Ensemble pour une meilleure réussite",
  description: "Un accompagnement pour consolider les connaissances, progresser et préparer les évaluations scolaires.",
  phones: ["01 41 77 84 49", "01 95 48 91 34"],
  logoUrl: "",
  ...catalogue,
};
function defaultSchoolSettings() { return JSON.parse(JSON.stringify(defaults)); }
function validateSchoolSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail(400, "Paramètres invalides.");
  const text = (name, max, optional = false) => {
    const raw = value[name];
    if (typeof raw !== "string" || raw.trim().length > max || (!optional && !raw.trim())) throw fail(400, `${name} : texte invalide.`);
    return raw.trim();
  };
  const strings = (raw, label, max, min = 1, count = 30) => {
    if (!Array.isArray(raw) || raw.length < min || raw.length > count || raw.some((s) => typeof s !== "string" || !s.trim() || s.trim().length > max)) throw fail(400, `${label} invalides.`);
    const result = raw.map((s) => s.trim());
    if (new Set(result.map((s) => s.toLocaleLowerCase("fr"))).size !== result.length) throw fail(400, `${label} : retirez les doublons.`);
    return result;
  };
  if (!Array.isArray(value.levels) || !value.levels.length || value.levels.length > 30) throw fail(400, "Classes invalides.");
  const names = strings(value.levels.map((l) => Array.isArray(l) && l[0]), "Classes", 80);
  const levels = value.levels.map((l, i) => {
    if (l.length !== 2 || !Number.isInteger(l[1]) || l[1] < 0 || l[1] > 1000000) throw fail(400, "Chaque tarif doit être un entier entre 0 et 1 000 000 FCFA.");
    return [names[i], l[1]];
  });
  const phones = strings(value.phones, "Téléphones", 20, 0, 5);
  if (phones.some((p) => !/^[+0-9 ()-]{8,20}$/.test(p) || p.replace(/\D/g, "").length < 8 || p.replace(/\D/g, "").length > 15)) throw fail(400, "Chaque téléphone doit contenir de 8 à 15 chiffres.");
  const logoUrl = text("logoUrl", 24000, true);
  if (logoUrl && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(logoUrl)) {
    let url;
    try { url = new URL(logoUrl); } catch { throw fail(400, "Logo invalide."); }
    if (url.protocol !== "https:" || url.username || url.password || logoUrl.length > 2048) throw fail(400, "Choisissez une image ou une adresse de logo HTTPS.");
  }
  return { name: text("name", 120), tagline: text("tagline", 180, true), description: text("description", 2000, true), phones, logoUrl, levels, centres: strings(value.centres, "Centres", 100), subjects: strings(value.subjects, "Matières", 80) };
}
function protectUsedCatalogue(previous, next, data) {
  const ensure = (oldNames, newNames, usedNames, label) => {
    const missing = oldNames.find((name) => !newNames.includes(name) && usedNames.includes(name));
    if (missing) throw fail(409, `${label} « ${missing} » est utilisé dans des dossiers. Conservez cette entrée ; vous pouvez en ajouter une nouvelle.`);
  };
  ensure(previous.levels.map((l) => l[0]), next.levels.map((l) => l[0]), data.students.map((s) => s.class), "La classe");
  ensure(previous.centres, next.centres, data.students.map((s) => s.centre), "Le centre");
  ensure(previous.subjects, next.subjects, [...data.students.flatMap((s) => s.subjects || []), ...data.teachers.map((t) => t.subject), ...data.courses.map((c) => c.subject)], "La matière");
}
module.exports = { defaultSchoolSettings, validateSchoolSettings, protectUsedCatalogue };
