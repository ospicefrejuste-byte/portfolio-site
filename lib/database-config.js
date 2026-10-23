"use strict";
const fs = require("node:fs");
const path = require("node:path");
const tls = require("node:tls");
const { X509Certificate } = require("node:crypto");
const fail = (code, message) => Object.assign(new Error(message), { code });
const SUPABASE_ROOTS = [
  ["supabase-prod-ca-2021.crt", "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA"],
  ["supabase-prod-ca-2025.crt", "5F:9B:77:95:1A:7A:A1:30:3F:9B:58:EE:A9:BF:A8:9E:35:8C:FD:C1:5F:97:86:FF:10:D4:93:0A:72:2C:9A:E2"],
];
function normalizeCaCertificate(value) {
  if (!value) return undefined;
  const blocks = [...String(value).replace(/\\r\\n|\\n|\\r/g, "\n").matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)];
  if (!blocks.length) throw fail("ADEOYE_CA_INVALID", "ADEOYE_DATABASE_CA_CERT doit contenir un certificat PEM complet.");
  return blocks.map(([, body]) => {
    const base64 = body.replace(/\s/g, "");
    const pem = "-----BEGIN CERTIFICATE-----\n" + (base64.match(/.{1,64}/g) || []).join("\n") + "\n-----END CERTIFICATE-----\n";
    try { new X509Certificate(pem); }
    catch { throw fail("ADEOYE_CA_INVALID", "Le certificat de la base est invalide."); }
    return pem;
  }).join("");
}
function supabaseCertificates() {
  return SUPABASE_ROOTS.map(([name, fingerprint]) => {
    const filename = [path.join(process.cwd(), "lib", "assets", name), path.join(__dirname, "assets", name)].find(candidate => fs.existsSync(candidate));
    if (!filename) throw fail("ADEOYE_CA_INVALID", "Un certificat Supabase fourni avec le site est indisponible.");
    const pem = fs.readFileSync(filename, "utf8"), certificate = new X509Certificate(pem);
    if (!certificate.ca || certificate.fingerprint256 !== fingerprint || !certificate.verify(certificate.publicKey)) throw fail("ADEOYE_CA_INVALID", "Un certificat Supabase fourni avec le site ne correspond pas à sa référence officielle.");
    return pem;
  });
}
function postgresConfiguration({ connectionString, password, ca } = {}) {
  if (typeof connectionString !== "string" || !connectionString.trim()) throw fail("ADEOYE_CONFIG_MISSING", "Configurez ADEOYE_DATABASE_URL dans l’hébergement de la ferme.");
  let url;
  try { url = new URL(connectionString); }
  catch { throw fail("ADEOYE_DATABASE_URL_INVALID", "L’adresse de connexion PostgreSQL est invalide."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) throw fail("ADEOYE_DATABASE_URL_INVALID", "L’adresse de connexion PostgreSQL est invalide.");
  if (password) url.password = encodeURIComponent(password);
  for (const key of ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert"]) url.searchParams.delete(key);
  const provided = normalizeCaCertificate(ca);
  const providerHost = /\.(?:supabase\.co|supabase\.com)$/i.test(url.hostname);
  const certificates = provided ? [provided] : providerHost ? supabaseCertificates() : [];
  // Additional CAs extend the normal trust store; hostname and chain checks stay on.
  const defaults = tls.getCACertificates ? tls.getCACertificates("default") : tls.rootCertificates;
  return { connectionString: url.href, max: 3, connectionTimeoutMillis: 15000, idleTimeoutMillis: 20000, ssl: { rejectUnauthorized: true, ...(certificates.length ? { ca: [...defaults, ...certificates] } : {}) } };
}
module.exports = { postgresConfiguration, normalizeCaCertificate };
