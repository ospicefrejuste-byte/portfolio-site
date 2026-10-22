"use strict";
const crypto = require("node:crypto");
const { paymentAllocations } = require("./payment-months");

const KEY_SETTING = "receipt_verification_key";
const snapshotSettingKey = (id) => "receipt_snapshot:" + id;
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
function createReceiptSnapshot({ payment, student = {}, school = {} }) {
  return {
    version: 1,
    issuedAt: new Date().toISOString(),
    payment: JSON.parse(JSON.stringify(payment)),
    student: { name: student?.name || "Élève introuvable", class: student?.class || "", centre: student?.centre || "", group: student?.group || "", guardian: student?.guardian || "" },
    school: { name: school.name || "Cours de renforcement scolaire", phones: Array.isArray(school.phones) ? [...school.phones] : [] },
  };
}
function parseReceiptToken(token) {
  if (typeof token !== "string" || token.length > 320) return null;
  const match = /^r1\.([A-Za-z0-9_-]{2,214})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const id = Buffer.from(match[1], "base64url").toString("utf8");
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(id) || Buffer.from(id).toString("base64url") !== match[1]) return null;
  const signature = Buffer.from(match[2], "base64url");
  if (signature.length !== 32 || signature.toString("base64url") !== match[2]) return null;
  return { id, prefix: "r1." + match[1], signature };
}
function signingKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("La clé de vérification des reçus est indisponible.");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value) throw new Error("La clé de vérification des reçus est invalide.");
  return bytes;
}
function signature(prefix, snapshot, key) {
  const { token, ...payload } = snapshot;
  return crypto.createHmac("sha256", signingKey(key)).update(prefix + "." + canonical(payload)).digest();
}
function createReceiptToken(snapshot, key) {
  if (snapshot?.version !== 1 || !/^[A-Za-z0-9._-]{1,160}$/.test(snapshot?.payment?.id || "")) throw new Error("Le reçu ne possède pas de référence valide.");
  const prefix = "r1." + Buffer.from(snapshot.payment.id).toString("base64url");
  return prefix + "." + signature(prefix, snapshot, key).toString("base64url");
}
function verifyReceiptToken(token, snapshot, key) {
  const parsed = parseReceiptToken(token);
  if (!parsed || snapshot?.version !== 1 || snapshot?.payment?.id !== parsed.id || (snapshot.token !== undefined && snapshot.token !== token)) return false;
  try { return crypto.timingSafeEqual(parsed.signature, signature(parsed.prefix, snapshot, key)); } catch { return false; }
}
function paymentMatchesSnapshot(payment, snapshot) {
  return Boolean(payment && snapshot?.version === 1 && canonical(payment) === canonical(snapshot.payment));
}
function publicReceiptSnapshot(snapshot) {
  const payment = snapshot.payment;
  const allocations = paymentAllocations(payment);
  const channel = payment.source === "KKiaPay" ? "online" : payment.source === "Caisse" || payment.channel === "cash" ? "cash" : "administrative";
  return {
    status: payment.mode === "sandbox" ? "test" : "verified",
    receipt: {
      reference: payment.id,
      studentName: snapshot.student.name,
      class: snapshot.student.class,
      centre: snapshot.student.centre,
      amount: payment.amount,
      currency: "FCFA",
      date: payment.date,
      period: payment.period,
      ...(allocations.length > 1 ? { periods: allocations.map((allocation) => allocation.period), allocations } : {}),
      channel,
      schoolName: snapshot.school.name,
    },
  };
}
function receiptVerificationUrl(origin, token, production = false) {
  let url;
  try { url = new URL(origin); } catch { throw new Error("Configurez l’origine du site pour vérifier les reçus."); }
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && (production || !local)) || url.username || url.password)
    throw new Error("L’origine de vérification des reçus doit être HTTPS.");
  const target = new URL("/verification-recu.html", url.origin);
  target.hash = token;
  return target.href;
}

module.exports = { KEY_SETTING, snapshotSettingKey, canonical, createReceiptSnapshot, createReceiptToken, parseReceiptToken, verifyReceiptToken, paymentMatchesSnapshot, publicReceiptSnapshot, receiptVerificationUrl };
