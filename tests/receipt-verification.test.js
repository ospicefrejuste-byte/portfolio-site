"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApplication } = require("../lib/application");

function verificationLink(buffer) {
  assert.equal(buffer.subarray(0, 5).toString(), "%PDF-");
  const text = buffer.toString("latin1");
  const links = [...text.matchAll(/\/URI\s*\(([^)]*)\)/g)].map(match => match[1].replace(/\\([\\()])/g, "$1"));
  const link = links.find(value => value.includes("/verification-recu.html#"));
  assert.ok(link, "The delivered PDF contains its own verification link");
  const url = new URL(link);
  assert.equal(url.pathname, "/verification-recu.html");
  assert.equal(url.search, "");
  assert.match(url.hash.slice(1), /^r1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  return { url, token: url.hash.slice(1) };
}

test("Chaque reçu signé reste stable, privé, immuable et vérifiable après changement du dossier ou redémarrage", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "crs-receipt-verification-"));
  let verified = { status: "FAILED" };
  const options = {
    dataDir, setupToken: "receipt-verification-test-only", publicOrigin: "https://receipts.example.test",
    paymentConfig: { sandbox: true, publicKey: "receipt-fixture-public", privateKey: "receipt-fixture-private", secretKey: "receipt-fixture-secret" },
    verifyTransaction: async () => verified,
  };
  let instance = createApplication(options);
  let server, base;
  async function listen() {
    server = instance.app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    base = "http://127.0.0.1:" + server.address().port;
  }
  await listen();
  t.after(async () => { await new Promise(resolve => server.close(resolve)); instance.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  async function call(route, method = "GET", body, session, headers = {}) {
    const response = await fetch(base + route, {
      method, redirect: "manual",
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(session ? { Cookie: session.cookie, "X-CSRF-Token": session.csrf } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = response.headers.get("content-type")?.includes("application/json") ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, data, cookie: response.headers.get("set-cookie")?.split(";")[0], csrf: data.csrf, headers: response.headers };
  }
  const password = "Receipt-verification-password-123!";
  const admin = await call("/api/auth/setup", "POST", { token: options.setupToken, username: "receipt-admin", password });
  assert.equal(admin.status, 200);
  const school = (await call("/api/admin/settings", "GET", undefined, admin)).data;
  const centre = school.centres[0];
  async function create(kind, body) {
    const result = await call("/api/records/" + kind, "POST", body, admin);
    assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data;
  }
  const pupil = await create("students", { name: "Élève QR original", class: "6e", centre, group: "6e · " + centre, monthlyFee: 6000, guardian: "Parent QR privé", phone: "+2290100000000", subjects: ["Mathématiques"] });
  const otherPupil = await create("students", { name: "Autre élève QR privé", class: "6e", centre, group: "6e · " + centre, monthlyFee: 6000 });
  const teacher = await create("teachers", { name: "Enseignant QR privé", subject: "Mathématiques" });
  async function account(role, entityId, username = role + "-receipt-test") {
    const created = await call("/api/admin/users", "POST", { username, role, entityId, password }, admin);
    assert.equal(created.status, 201);
    const logged = await call("/api/auth/login", "POST", { username, password, ...(role === "cashier" ? { space: "cashier" } : {}) });
    assert.equal(logged.status, 200);
    const changed = await call("/api/auth/password", "POST", { currentPassword: password, password: "Personal-" + username + "-123!" }, logged);
    assert.equal(changed.status, 200); return changed;
  }
  const cashier = await account("cashier");
  const student = await account("student", pupil.id);
  const otherStudent = await account("student", otherPupil.id, "other-student-receipt-test");
  const teacherSession = await account("teacher", teacher.id);
  const cash = await call("/api/cashier/payments", "POST", { requestId: crypto.randomUUID(), student: pupil.id, period: "2026-10", amount: 1500 }, cashier);
  assert.equal(cash.status, 201);
  const manual = await create("payments", { student: pupil.id, period: "2026-11", date: "2026-10-13", amount: 250 });
  const online = { id: crypto.randomUUID(), student: pupil.id, amount: 3500, period: "2026-10", date: "2026-10-13", source: "KKiaPay", mode: "live", transactionId: "verified-receipt-fixture" };
  const sandbox = { ...online, id: crypto.randomUUID(), mode: "sandbox", transactionId: "sandbox-receipt-fixture" };
  // These provider records exist only in this local fixture; no gateway is contacted.
  for (const payment of [online, sandbox]) instance.db.prepare("INSERT INTO records(kind,id,payload) VALUES('payments',?,?)").run(payment.id, JSON.stringify(payment));
  const snapshotsBefore = instance.db.prepare("SELECT key,value FROM settings ORDER BY key").all();
  for (const [session, id, status] of [[undefined, cash.data.id, 401], [teacherSession, cash.data.id, 403], [otherStudent, cash.data.id, 403], [cashier, online.id, 403], [cashier, sandbox.id, 403]])
    assert.equal((await call("/api/payments/" + id + "/receipt.pdf", "GET", undefined, session)).status, status);
  assert.deepEqual(instance.db.prepare("SELECT key,value FROM settings ORDER BY key").all(), snapshotsBefore, "Forbidden downloads issue no verification snapshot");

  const receiptPath = "/api/payments/" + cash.data.id + "/receipt.pdf";
  const parallel = await Promise.all([admin, student, cashier].map(session => call(receiptPath, "GET", undefined, session)));
  assert.ok(parallel.every(result => result.status === 200));
  const first = verificationLink(parallel[0].data);
  assert.equal(first.url.origin, "https://receipts.example.test");
  assert.ok(parallel.every(result => verificationLink(result.data).token === first.token), "Concurrent downloads of one receipt have the same signature");
  const manualPdf = await call("/api/payments/" + manual.id + "/receipt.pdf", "GET", undefined, admin);
  assert.equal(manualPdf.status, 200);
  const second = verificationLink(manualPdf.data);
  assert.notEqual(second.token, first.token, "Each different receipt has its own QR code");
  async function verify(token, extra = {}) { return call("/api/receipts/verify", "POST", { token, ...extra }); }
  const checked = await verify(first.token, { amount: 1, studentName: "Nom falsifié" });
  assert.equal(checked.status, 200);
  assert.deepEqual(checked.data, { status: "verified", receipt: {
    reference: cash.data.id, studentName: pupil.name, class: pupil.class, centre,
    amount: 1500, currency: "FCFA", date: cash.data.date, period: cash.data.period, channel: "cash", schoolName: school.name,
  }});
  assert.match(checked.headers.get("cache-control") || "", /no-store/);
  assert.doesNotMatch(JSON.stringify(checked.data), /Parent QR privé|0100000000|collectedBy|guardian|phone|issuedAt|csrf|password|signature|token/);
  const manualChecked = await verify(second.token);
  assert.equal(manualChecked.data.receipt.reference, manual.id); assert.equal(manualChecked.data.receipt.amount, 250);
  assert.equal(manualChecked.data.receipt.channel, "administrative");
  const onlineLink = verificationLink((await call("/api/payments/" + online.id + "/receipt.pdf", "GET", undefined, student)).data);
  assert.equal((await verify(onlineLink.token)).data.receipt.channel, "online");
  const testLink = verificationLink((await call("/api/payments/" + sandbox.id + "/receipt.pdf", "GET", undefined, admin)).data);
  const trial = await verify(testLink.token);
  assert.equal(trial.status, 200); assert.equal(trial.data.status, "test");
  assert.equal(trial.data.receipt.reference, sandbox.id);

  const forgedId = "r1." + Buffer.from(crypto.randomUUID()).toString("base64url") + "." + crypto.randomBytes(32).toString("base64url");
  const forgedSignature = first.token.slice(0, first.token.lastIndexOf(".") + 1) + crypto.randomBytes(32).toString("base64url");
  for (const token of ["", cash.data.id, forgedId, forgedSignature, first.token + "x", first.token.slice(0, -1), "x".repeat(500)])
    assert.equal((await verify(token)).status, 404, "Invalid or guessed tokens disclose no receipt");
  const key = instance.db.prepare("SELECT value FROM settings WHERE key=?").get("receipt_verification_key").value;
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Number(instance.db.prepare("SELECT count(*) n FROM settings WHERE key=?").get("receipt_snapshot:" + cash.data.id).n), 1);
  for (const route of ["/api/data", "/api/admin/export", "/api/admin/settings"]) {
    const json = JSON.stringify((await call(route, "GET", undefined, admin)).data);
    assert.ok(!json.includes(first.token) && !json.includes(second.token) && !json.includes(key));
    assert.doesNotMatch(json, /receipt_snapshot:|receipt_verification_key|issuedAt/);
  }
  for (const method of ["PUT", "DELETE"]) {
    const result = await call("/api/records/payments/" + manual.id, method, method === "PUT" ? { ...manual, amount: 1 } : undefined, admin);
    assert.equal(result.status, 409, "An issued legacy receipt cannot later be rewritten or deleted");
  }

  const renamed = await call("/api/records/students/" + pupil.id, "PUT", { ...pupil, name: "Élève renommé après reçu", guardian: "Nouveau parent" }, admin);
  assert.equal(renamed.status, 200);
  const renamedSchool = await call("/api/admin/settings", "PUT", { ...school, name: "École renommée après reçu" }, admin);
  assert.equal(renamedSchool.status, 200);
  assert.deepEqual((await verify(first.token)).data, checked.data, "The QR attests the original receipt, not mutable pupil/settings details");
  assert.equal(verificationLink((await call(receiptPath, "GET", undefined, admin)).data).token, first.token);

  const snapshotKey = "receipt_snapshot:" + cash.data.id;
  const saved = instance.db.prepare("SELECT value FROM settings WHERE key=?").get(snapshotKey).value;
  const modified = saved.replace(pupil.name, "Élève QR falsifié");
  assert.notEqual(modified, saved);
  instance.db.prepare("UPDATE settings SET value=? WHERE key=?").run(modified, snapshotKey);
  assert.equal((await verify(first.token)).status, 404, "Changing the stored snapshot cannot preserve a valid signature");
  assert.equal((await call(receiptPath, "GET", undefined, admin)).status, 409, "A corrupted snapshot is refused rather than silently signed again");
  instance.db.prepare("UPDATE settings SET value=? WHERE key=?").run(saved, snapshotKey);
  assert.equal((await verify(first.token)).status, 200);

  const originalPayment = instance.db.prepare("SELECT payload FROM records WHERE kind='payments' AND id=?").get(cash.data.id).payload;
  const alteredPayment = { ...JSON.parse(originalPayment), amount: 999999 };
  instance.db.prepare("UPDATE records SET payload=? WHERE kind='payments' AND id=?").run(JSON.stringify(alteredPayment), cash.data.id);
  assert.equal((await verify(first.token)).status, 404, "A payment rewritten outside the application cannot be verified with the old receipt");
  assert.equal((await call(receiptPath, "GET", undefined, admin)).status, 409);
  instance.db.prepare("UPDATE records SET payload=? WHERE kind='payments' AND id=?").run(originalPayment, cash.data.id);
  assert.deepEqual((await verify(first.token)).data, checked.data);

  instance.db.prepare("DELETE FROM settings WHERE key=?").run("receipt_verification_key");
  assert.equal((await call(receiptPath, "GET", undefined, admin)).status, 500, "A missing signing key fails closed for an existing receipt");
  assert.equal(instance.db.prepare("SELECT value FROM settings WHERE key=?").get("receipt_verification_key"), undefined, "An old receipt never causes key rotation when its key is missing");
  const newManual = await create("payments", { student: pupil.id, period: "2026-12", date: "2026-10-13", amount: 100 });
  assert.equal((await call("/api/payments/" + newManual.id + "/receipt.pdf", "GET", undefined, admin)).status, 500, "Issuing a new receipt also fails closed while historical receipts have lost their key");
  assert.equal(instance.db.prepare("SELECT value FROM settings WHERE key=?").get("receipt_verification_key"), undefined);
  assert.equal(instance.db.prepare("SELECT value FROM settings WHERE key=?").get("receipt_snapshot:" + newManual.id), undefined, "A failed issuance leaves no partial snapshot");
  instance.db.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run("receipt_verification_key", key);
  assert.equal(verificationLink((await call(receiptPath, "GET", undefined, admin)).data).token, first.token);

  // The public registration credential may issue only its own confirmed receipt.
  const registrationBody = { name: "Élève QR inscription publique", guardian: "Parent public privé", phone: "0100000000", class: "6e", centre, subjects: ["Mathématiques"], consent: true };
  const registration = await call("/api/registrations", "POST", registrationBody);
  const otherRegistration = await call("/api/registrations", "POST", { ...registrationBody, name: "Autre dossier QR public" });
  assert.equal(registration.status, 201); assert.equal(otherRegistration.status, 201);
  const publicHeaders = { Authorization: "Bearer " + registration.data.paymentToken };
  const checkout = await call("/api/registration-payments/checkout", "POST", { period: "2026-10" }, undefined, publicHeaders);
  assert.equal(checkout.status, 201);
  verified = { status: "SUCCESS", amount: checkout.data.amount, data: checkout.data.data };
  const confirmed = await call("/api/registration-payments/confirm", "POST", { orderId: checkout.data.orderId, transactionId: "public-qr-sandbox-fixture" }, undefined, publicHeaders);
  assert.equal(confirmed.status, 200);
  const publicPdfRoute = "/api/registration-payments/receipt.pdf?orderId=" + checkout.data.orderId;
  assert.equal((await call(publicPdfRoute, "GET")).status, 401);
  assert.equal((await call(publicPdfRoute, "GET", undefined, undefined, { Authorization: "Bearer " + otherRegistration.data.paymentToken })).status, 404);
  const publicPdf = await call(publicPdfRoute, "GET", undefined, undefined, publicHeaders);
  assert.equal(publicPdf.status, 200);
  const publicLink = verificationLink(publicPdf.data);
  const publicChecked = await verify(publicLink.token);
  assert.equal(publicChecked.data.status, "test"); assert.equal(publicChecked.data.receipt.studentName, registrationBody.name);

  await new Promise(resolve => server.close(resolve));
  instance.db.close();
  instance = createApplication(options);
  await listen();
  assert.deepEqual((await verify(first.token)).data, checked.data, "The signing key and receipt survive an application restart");
  assert.equal(verificationLink((await call(receiptPath, "GET", undefined, admin)).data).token, first.token);
});
