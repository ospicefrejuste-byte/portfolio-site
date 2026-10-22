"use strict";
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const scrypt = promisify(crypto.scrypt);
const fail = (status, message) => Object.assign(new Error(message), { status });
function password(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > 256) throw fail(400, "Le mot de passe doit contenir entre 12 et 256 caractères.");
  return value;
}
async function hashPassword(value) {
  password(value);
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await scrypt(value, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return "scrypt$" + salt + "$" + hash.toString("hex");
}
async function verifyPassword(value, encoded) {
  if (typeof value !== "string" || value.length > 256 || typeof encoded !== "string") return false;
  const [kind, salt, expected] = encoded.split("$");
  if (kind !== "scrypt" || !/^[a-f0-9]{32}$/.test(salt || "") || !/^[a-f0-9]{128}$/.test(expected || "")) return false;
  const hash = await scrypt(value, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(hash, Buffer.from(expected, "hex"));
}
const digest = value => crypto.createHash("sha256").update(String(value)).digest("hex");
function sameSecret(left, right) { return crypto.timingSafeEqual(Buffer.from(digest(left)), Buffer.from(digest(right))); }
function clean(value, label, max = 160, optional = false) {
  if (optional && (value === undefined || value === null || value === "")) return "";
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw fail(400, label + " invalide.");
  return value.trim();
}
function username(value) {
  const name = clean(value, "Identifiant", 80);
  if (!/^[\p{L}\p{N}_.@-]{3,80}$/u.test(name)) throw fail(400, "L’identifiant doit contenir de 3 à 80 lettres, chiffres, points, tirets ou @.");
  return name;
}
function day(value) {
  if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) throw fail(400, "Date invalide.");
  const date = new Date(value + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || value > new Date().toISOString().slice(0, 10)) throw fail(400, "Choisissez une date valide, au plus tard aujourd’hui.");
  return value;
}
function quantity(value, unit, { positive = false } = {}) {
  if (typeof value !== "number" && typeof value !== "string" || String(value).trim() === "" || !/^\d+(?:\.\d{1,3})?$/.test(String(value))) throw fail(400, "La quantité doit être positive avec trois décimales au maximum.");
  const number = Number(value), milli = Math.round(number * 1000);
  if (!Number.isFinite(number) || number < (positive ? 0.001 : 0) || number > 1000000000 || !Number.isSafeInteger(milli)) throw fail(400, "Quantité invalide.");
  if (["tête", "pièce", "plateau"].includes(unit) && !Number.isInteger(number)) throw fail(400, "Cette unité doit être comptée en nombres entiers.");
  return milli;
}
function money(value) {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "" || !Number.isSafeInteger(Number(value)) || Number(value) < 0 || Number(value) > 100000000) throw fail(400, "La valeur unitaire doit être un entier entre 0 et 100 000 000 F CFA.");
  return Number(value);
}
function valuation(quantityMilli, unitValue) {
  const value = (BigInt(quantityMilli) * BigInt(unitValue) + 500n) / 1000n;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw fail(400, "La quantité et la valeur unitaire produisent une estimation trop élevée. Réduisez la valeur avant de continuer.");
  return Number(value);
}
function uuid(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) throw fail(400, "Référence d’opération invalide.");
  return value.toLowerCase();
}
function version(value) { if (!Number.isSafeInteger(value) || value < 1) throw fail(400, "Version de fiche invalide. Actualisez les données."); return value; }
function csv(rows) {
  const cell = value => {
    let text = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
    if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  return "\uFEFF" + rows.map(row => row.map(cell).join(";")).join("\r\n") + "\r\n";
}
module.exports = { fail, password, hashPassword, verifyPassword, digest, sameSecret, clean, username, day, quantity, money, valuation, uuid, version, csv };
