"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), tls = require("node:tls");
const { X509Certificate } = require("node:crypto");
const { Client } = require("pg");
const { postgresConfiguration, normalizeCaCertificate } = require("../lib/database-config");
const { requireProductionConfiguration, startupDiagnostic } = require("../lib/startup-errors");
const { createApplication } = require("../lib/application");
const asset = year => fs.readFileSync(path.join(__dirname, "../lib/assets/supabase-prod-ca-" + year + ".crt"), "utf8");
const fingerprints = ["80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA", "5F:9B:77:95:1A:7A:A1:30:3F:9B:58:EE:A9:BF:A8:9E:35:8C:FD:C1:5F:97:86:FF:10:D4:93:0A:72:2C:9A:E2"];
test("les racines Supabase officielles 2021 et 2025 sont valides, signées et embarquées dans Netlify", () => {
  const configuration = fs.readFileSync(path.join(__dirname, "../netlify.toml"), "utf8");
  for (const [index, year] of [2021, 2025].entries()) {
    const certificate = new X509Certificate(asset(year));
    assert.equal(certificate.ca, true); assert.equal(certificate.verify(certificate.publicKey), true);
    assert.equal(certificate.fingerprint256, fingerprints[index]);
    assert.ok(Date.parse(certificate.validFrom) < Date.now() && Date.parse(certificate.validTo) > Date.now());
    assert.ok(configuration.includes('"lib/assets/supabase-prod-ca-' + year + '.crt"'));
  }
});
test("les connexions Supabase directes et poolées conservent les vérifications TLS et les autorités normales", () => {
  for (const host of ["db.fixture-project.supabase.co", "aws-0-eu-west-1.pooler.supabase.com"]) {
    const config = postgresConfiguration({ connectionString: "postgresql://postgres:[YOUR-PASSWORD]@" + host + ":6543/postgres?sslmode=no-verify&ssl=false&sslcert=ignored&sslkey=ignored&sslrootcert=ignored" });
    const client = new Client(config);
    assert.equal(client.connectionParameters.ssl.rejectUnauthorized, true);
    for (const key of ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert"]) assert.equal(new URL(config.connectionString).searchParams.has(key), false);
    assert.deepEqual(client.connectionParameters.ssl.ca.slice(-2).map(pem => new X509Certificate(pem).fingerprint256), fingerprints);
    const defaults = tls.getCACertificates("default");
    assert.deepEqual(client.connectionParameters.ssl.ca.slice(0, defaults.length), defaults);
  }
});
test("un domaine ressemblant à Supabase ne reçoit pas les autorités du fournisseur", () => {
  for (const host of ["postgres.example", "notsupabase.co", "db.fake.supabase.co.example"]) {
    const client = new Client(postgresConfiguration({ connectionString: "postgresql://postgres:fixture@" + host + "/postgres?ssl=false" }));
    assert.equal(client.connectionParameters.ssl.rejectUnauthorized, true);
    assert.equal(client.connectionParameters.ssl.ca, undefined);
  }
});
test("le mot de passe séparé remplace le marqueur et conserve les symboles, sans être exposé par une erreur d’URL", () => {
  const password = "Test@:$#%/ç +[]!?";
  const client = new Client(postgresConfiguration({ connectionString: "postgresql://postgres.fixture:[YOUR-PASSWORD]@aws-0-eu-west-1.pooler.supabase.com:6543/postgres", password }));
  assert.equal(client.connectionParameters.password, password);
  assert.equal(client.connectionParameters.user, "postgres.fixture");
  assert.throws(() => postgresConfiguration({ connectionString: "invalid-url-with-" + password }), error => error.code === "ADEOYE_DATABASE_URL_INVALID" && !error.message.includes(password));
});
test("un certificat explicite valide reste utilisable et un certificat incorrect ne désactive jamais TLS", () => {
  const pem = asset(2021);
  const escaped = pem.trim().split(/\r?\n/).join("\\n");
  const config = postgresConfiguration({ connectionString: "postgresql://postgres:fixture@postgres.example/postgres", ca: escaped });
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(new X509Certificate(config.ssl.ca.at(-1)).fingerprint256, fingerprints[0]);
  assert.throws(() => normalizeCaCertificate("pas un certificat"), { code: "ADEOYE_CA_INVALID" });
  assert.throws(() => postgresConfiguration({ connectionString: "postgresql://postgres:fixture@postgres.example/postgres", ca: "-----BEGIN CERTIFICATE-----invalid-----END CERTIFICATE-----" }), { code: "ADEOYE_CA_INVALID" });
});
test("les erreurs de démarrage sont distinguées sans révéler les détails privés", () => {
  const cases = [["28P01", "ADEOYE_DB_AUTH"], ["SELF_SIGNED_CERT_IN_CHAIN", "ADEOYE_DB_TLS"], ["ADEOYE_CA_INVALID", "ADEOYE_DB_TLS"], ["ENOTFOUND", "ADEOYE_DB_NETWORK"], ["42501", "ADEOYE_DB_ACCESS"], ["ADEOYE_CONFIG_MISSING", "ADEOYE_CONFIG_MISSING"], ["ADEOYE_PUBLIC_ORIGIN_INVALID", "ADEOYE_PUBLIC_ORIGIN_INVALID"], ["ERR_INVALID_URL", "ADEOYE_DATABASE_URL_INVALID"], ["other-error", "ADEOYE_STARTUP_ERROR"]];
  for (const [code, expected] of cases) {
    const result = startupDiagnostic({ code, message: "private-fixture-url-password-token" });
    assert.equal(result.code, expected);
    assert.equal(JSON.stringify(result).includes("private-fixture"), false);
  }
  assert.equal(startupDiagnostic(Error("timeout exceeded when trying to connect")).code, "ADEOYE_DB_NETWORK");
});
test("la prévalidation signale les noms des variables absentes et ignore toute valeur privée", () => {
  assert.throws(() => requireProductionConfiguration({ ADEOYE_DATABASE_URL: "fixture-private", ADEOYE_SETUP_TOKEN: "   " }), error => error.code === "ADEOYE_CONFIG_MISSING" && error.missing.join(",") === "ADEOYE_SETUP_TOKEN,ADEOYE_PUBLIC_ORIGIN" && !error.message.includes("fixture-private"));
  assert.doesNotThrow(() => requireProductionConfiguration({ ADEOYE_DATABASE_URL: "fixture", ADEOYE_SETUP_TOKEN: "fixture", ADEOYE_PUBLIC_ORIGIN: "fixture" }));
});
test("une origine invalide a un diagnostic exploitable avant d’ouvrir la base", async () => {
  await assert.rejects(createApplication({ production: true, publicOrigin: "not-an-origin-fixture", setupToken: "fixture" }), { code: "ADEOYE_PUBLIC_ORIGIN_INVALID" });
});
test("la fonction Netlify retourne la référence de configuration sans inclure de secret", async () => {
  const names = ["ADEOYE_DATABASE_URL", "ADEOYE_SETUP_TOKEN", "ADEOYE_PUBLIC_ORIGIN"];
  const saved = names.map(name => process.env[name]);
  const originalLog = console.error, logs = [];
  try {
    for (const name of names) delete process.env[name];
    console.error = (...args) => logs.push(args.join(" "));
    const response = await require("../netlify/functions/api").handler({ path: "/api/health", httpMethod: "GET", headers: {} }, {});
    assert.equal(response.statusCode, 503);
    assert.equal(JSON.parse(response.body).code, "ADEOYE_CONFIG_MISSING");
    assert.ok(logs[0].includes("ADEOYE_DATABASE_URL"));
  } finally {
    console.error = originalLog;
    names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; });
  }
});
