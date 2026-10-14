"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApplication } = require("../lib/application");

const password = "Cleanup-fixture-password-123!";
const providerConfig = { sandbox: true, publicKey: "cleanup-fixture-public", privateKey: "cleanup-fixture-private", secretKey: "cleanup-fixture-secret" };

async function fixture(t, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "crs-test-cleanup-"));
  const options = { dataDir, setupToken: "cleanup-fixture-setup", paymentConfig: providerConfig, ...extra };
  let instance = await createApplication(options);
  let server, base;
  async function listen() {
    server = instance.app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    base = "http://127.0.0.1:" + server.address().port;
  }
  await listen();
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await instance.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  async function call(route, method = "GET", body, session, headers = {}) {
    const response = await fetch(base + route, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(session ? { Cookie: session.cookie, "X-CSRF-Token": session.csrf } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = response.headers.get("content-type")?.includes("application/json") ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, data, cookie: response.headers.get("set-cookie")?.split(";")[0], csrf: data.csrf };
  }
  const admin = await call("/api/auth/setup", "POST", { token: options.setupToken, username: "cleanup-responsable", password });
  assert.equal(admin.status, 200);
  const school = (await call("/api/catalogue")).data;
  async function create(kind, body) {
    const result = await call("/api/records/" + kind, "POST", body, admin);
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data;
  }
  async function pupil(name) {
    return create("students", { name, class: "6e", centre: school.centres[0], group: "6e · " + school.centres[0], subjects: ["Mathématiques"], monthlyFee: 3500 });
  }
  async function account(role, entityId, username = role + "-cleanup") {
    const created = await call("/api/admin/users", "POST", { username, role, entityId, password }, admin);
    assert.equal(created.status, 201);
    const logged = await call("/api/auth/login", "POST", { username, password, ...(role === "cashier" ? { space: "cashier" } : {}) });
    assert.equal(logged.status, 200);
    const session = await call("/api/auth/password", "POST", { currentPassword: password, password: "Personal-" + username + "-123!" }, logged);
    assert.equal(session.status, 200);
    return { ...session, account: created.data };
  }
  async function state() {
    const records = await instance.db.prepare("SELECT kind,id,payload FROM records ORDER BY kind,id").all();
    const users = await instance.db.prepare("SELECT * FROM users ORDER BY id").all();
    const sessions = await instance.db.prepare("SELECT * FROM sessions ORDER BY token_hash").all();
    const access = await instance.db.prepare("SELECT * FROM registration_access ORDER BY token_hash").all();
    const orders = await instance.db.prepare("SELECT * FROM payment_orders ORDER BY id").all();
    const settings = await instance.db.prepare("SELECT key,value FROM settings ORDER BY key").all();
    return { records, users, sessions, access, orders, settings };
  }
  async function restart() {
    await new Promise(resolve => server.close(resolve));
    await instance.db.close();
    instance = await createApplication(options);
    await listen();
  }
  const previewRoute = id => "/api/admin/students/" + id + "/deletion-preview";
  const purgeRoute = id => "/api/admin/students/" + id + "/purge-test";
  async function preview(id) {
    const result = await call(previewRoute(id), "GET", undefined, admin);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  }
  const intent = (student, fingerprint) => ({ currentPassword: password, confirmedFictitious: true, confirmation: student.name, fingerprint });
  return { call, create, pupil, account, state, restart, preview, previewRoute, purgeRoute, intent, admin, school, get instance() { return instance; } };
}

function receiptToken(pdf) {
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  const links = [...pdf.toString("latin1").matchAll(/\/URI\s*\(([^)]*)\)/g)].map(match => match[1].replace(/\\([\\()])/g, "$1"));
  const link = links.find(value => value.includes("/verification-recu.html#"));
  assert.ok(link, "Issued fixture receipts have a signed verification link");
  return new URL(link).hash.slice(1);
}

test("Nettoyage fictif atomique : liens supprimés, autres dossiers conservés et reçus annulés après redémarrage", async t => {
  let verified = { status: "FAILED" }, verificationCalls = 0;
  const f = await fixture(t, { verifyTransaction: async () => { verificationCalls++; return verified; } });
  const centre = f.school.centres[0];
  const registration = await f.call("/api/registrations", "POST", {
    name: "Élève fictif à nettoyer", class: "6e", centre, guardian: "Parent fictif cleanup privé", phone: "0100000000", subjects: ["Mathématiques"], consent: true,
  });
  assert.equal(registration.status, 201);
  const dataBefore = (await f.call("/api/data", "GET", undefined, f.admin)).data;
  const pupil = dataBefore.students.find(student => student.name === "Élève fictif à nettoyer");
  assert.ok(pupil);
  const other = await f.pupil("Élève témoin conservé");
  const teacher = await f.create("teachers", { name: "Enseignant partagé conservé", subject: "Mathématiques" });
  const course = await f.create("courses", { subject: "Mathématiques", group: pupil.group, teacher: teacher.id, date: "2026-10-13", time: "16:00", duration: 60, room: "Salle fictive" });
  await f.create("grades", { student: pupil.id, course: course.id, label: "Évaluation fictive", score: 12 });
  const otherGrade = await f.create("grades", { student: other.id, course: course.id, label: "Évaluation témoin", score: 17 });
  await f.create("attendance", { student: pupil.id, course: course.id, status: "Présent" });
  const otherAttendance = await f.create("attendance", { student: other.id, course: course.id, status: "Absent" });
  const marked = await f.call("/api/cashier/attendance", "POST", { date: "2026-10-13", class: "6e", centre, entries: [{ student: pupil.id, status: "Présent", revision: 0 }, { student: other.id, status: "Absent", revision: 0 }] }, f.admin);
  assert.equal(marked.status, 200);
  const pupilSession = await f.account("student", pupil.id);
  const otherSession = await f.account("student", other.id, "student-cleanup-witness");
  const publicHeaders = { Authorization: "Bearer " + registration.data.paymentToken };
  const checkout = await f.call("/api/registration-payments/checkout", "POST", { period: "2026-12" }, undefined, publicHeaders);
  assert.equal(checkout.status, 201);
  verified = { status: "SUCCESS", amount: checkout.data.amount, data: checkout.data.data };
  assert.equal((await f.call("/api/registration-payments/confirm", "POST", { orderId: checkout.data.orderId, transactionId: "cleanup-sandbox-paid-fixture" }, undefined, publicHeaders)).status, 200);
  const pending = await f.call("/api/registration-payments/checkout", "POST", { period: "2027-01" }, undefined, publicHeaders);
  assert.equal(pending.status, 201);
  const requestId = crypto.randomUUID();
  const cashIntent = { requestId, student: pupil.id, amount: 1000, period: "2026-10" };
  const cash = await f.call("/api/cashier/payments", "POST", cashIntent, f.admin);
  assert.equal(cash.status, 201);
  const manual = await f.create("payments", { student: pupil.id, amount: 250, period: "2026-11", date: "2026-10-13" });
  const otherCash = await f.call("/api/cashier/payments", "POST", { requestId: crypto.randomUUID(), student: other.id, amount: 250, period: "2026-10" }, f.admin);
  assert.equal(otherCash.status, 201);
  const all = (await f.call("/api/data", "GET", undefined, f.admin)).data;
  const payments = all.payments.filter(payment => payment.student === pupil.id);
  assert.equal(payments.length, 3);
  const tokens = [];
  for (const payment of payments) {
    const pdf = await f.call("/api/payments/" + payment.id + "/receipt.pdf", "GET", undefined, f.admin);
    assert.equal(pdf.status, 200);
    tokens.push({ reference: payment.id, token: receiptToken(pdf.data) });
  }
  const otherToken = receiptToken((await f.call("/api/payments/" + otherCash.data.id + "/receipt.pdf", "GET", undefined, f.admin)).data);
  for (const payment of [cash.data, manual]) {
    for (const method of ["PUT", "DELETE"])
      assert.equal((await f.call("/api/records/payments/" + payment.id, method, method === "PUT" ? { amount: 1 } : undefined, f.admin)).status, 409);
  }
  assert.equal((await f.call("/api/records/students/" + pupil.id, "DELETE", undefined, f.admin)).status, 409);
  const preview = await f.preview(pupil.id);
  assert.deepEqual(preview.student, { id: pupil.id, name: pupil.name, class: pupil.class, centre });
  assert.equal(preview.canPurgeTest, true);
  assert.deepEqual(preview.counts, { payments: 3, grades: 1, attendance: 1, dailyAttendance: 1, accounts: 1, orders: 2 });
  assert.deepEqual(preview.amounts, { cash: 1250, online: 0, sandbox: 3500 });
  assert.equal(typeof preview.fingerprint, "string");
  const purged = await f.call(f.purgeRoute(pupil.id), "POST", f.intent(pupil, preview.fingerprint), f.admin);
  assert.equal(purged.status, 200, JSON.stringify(purged.data));
  const remaining = (await f.call("/api/data", "GET", undefined, f.admin)).data;
  assert.equal(remaining.students.some(student => student.id === pupil.id), false);
  for (const kind of ["payments", "grades", "attendance", "dailyAttendance"])
    assert.equal(remaining[kind].some(record => record.student === pupil.id), false, kind);
  assert.deepEqual(remaining.students.find(student => student.id === other.id), other);
  assert.deepEqual(remaining.teachers.find(record => record.id === teacher.id), teacher);
  assert.deepEqual(remaining.courses.find(record => record.id === course.id), all.courses.find(record => record.id === course.id));
  assert.deepEqual(remaining.grades.find(record => record.id === otherGrade.id), otherGrade);
  assert.deepEqual(remaining.attendance.find(record => record.id === otherAttendance.id), otherAttendance);
  assert.equal(remaining.dailyAttendance.filter(record => record.student === other.id).length, 1);
  const state = await f.state();
  assert.equal(state.users.some(user => user.id === pupilSession.account.id), false);
  assert.equal(state.sessions.some(session => session.user_id === pupilSession.account.id), false);
  assert.equal(state.access.some(access => access.student_id === pupil.id), false);
  for (const order of state.orders.filter(order => order.student_id === pupil.id)) assert.equal(order.state, "purged");
  assert.equal(state.orders.some(order => order.id === checkout.data.orderId && order.state === "purged"), true);
  const privateSettings = JSON.stringify(state.settings);
  for (const value of [pupil.name, pupil.guardian, pupil.phone, pupilSession.account.username, registration.data.paymentToken]) assert.ok(!privateSettings.includes(value), "Purge audit/tombstones contain no pupil identity or credential: " + value);
  for (const { reference, token } of tokens) {
    assert.equal(state.settings.some(setting => setting.key === "receipt_snapshot:" + reference), false);
    const result = await f.call("/api/receipts/verify", "POST", { token });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { status: "cancelled", reference });
    assert.ok(!privateSettings.includes(token), "Tombstones store the hash, never the signed credential");
    const altered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    assert.equal((await f.call("/api/receipts/verify", "POST", { token: altered })).status, 404, "A cancelled reference is disclosed only for the exact issued credential");
    assert.equal((await f.call("/api/payments/" + reference + "/receipt.pdf", "GET", undefined, f.admin)).status, 404);
  }
  assert.equal((await f.call("/api/auth/me", "GET", undefined, pupilSession)).status, 401);
  assert.equal((await f.call("/api/auth/me", "GET", undefined, otherSession)).status, 200);
  assert.equal((await f.call("/api/registration-payments/config", "GET", undefined, undefined, publicHeaders)).status, 401);
  const callsBeforeReplay = verificationCalls;
  assert.equal((await f.call("/api/payments/confirm", "POST", { orderId: checkout.data.orderId, transactionId: "cleanup-sandbox-paid-fixture" }, f.admin)).status, 409);
  assert.equal(verificationCalls, callsBeforeReplay, "Purged orders are rejected before calling the provider");
  assert.equal((await f.call("/api/cashier/payments", "POST", { ...cashIntent, student: other.id }, f.admin)).status, 409, "A removed receipt's request UUID cannot collect again on a different pupil");
  assert.equal((await f.call("/api/receipts/verify", "POST", { token: otherToken })).data.status, "verified");
  assert.equal((await f.call("/api/receipts/verify", "POST", { token: "r1." + Buffer.from(crypto.randomUUID()).toString("base64url") + "." + crypto.randomBytes(32).toString("base64url") })).status, 404);
  for (const route of ["/api/data", "/api/admin/export", "/api/admin/settings"]) {
    const exposed = JSON.stringify((await f.call(route, "GET", undefined, f.admin)).data);
    for (const { token } of tokens) assert.ok(!exposed.includes(token));
    assert.ok(!exposed.includes(pupil.name));
  }
  await f.restart();
  for (const { reference, token } of tokens) assert.deepEqual((await f.call("/api/receipts/verify", "POST", { token })).data, { status: "cancelled", reference });
  assert.equal((await f.call("/api/cashier/payments", "POST", { ...cashIntent, student: other.id }, f.admin)).status, 409);
  assert.equal((await f.call("/api/receipts/verify", "POST", { token: otherToken })).data.status, "verified");
  assert.equal((await f.call(f.previewRoute(pupil.id), "GET", undefined, f.admin)).status, 404);
});

test("Seul le responsable réauthentifié peut confirmer le nettoyage fictif d’un aperçu toujours à jour", async t => {
  const f = await fixture(t);
  const pupil = await f.pupil("Fichier fictif protégé par confirmation");
  const teacher = await f.create("teachers", { name: "Professeur du contrôle", subject: "Mathématiques" });
  const actors = [await f.account("cashier"), await f.account("teacher", teacher.id), await f.account("student", pupil.id)];
  const manual = await f.create("payments", { student: pupil.id, amount: 100, period: "2026-10", date: "2026-10-13" });
  const preview = await f.preview(pupil.id);
  const intent = f.intent(pupil, preview.fingerprint);
  async function rejected(status, session, body = intent, headers = {}) {
    const before = await f.state();
    const result = await f.call(f.purgeRoute(pupil.id), "POST", body, session, headers);
    assert.equal(result.status, status, JSON.stringify(result.data));
    assert.deepEqual(await f.state(), before, "Every refused cleanup leaves all business data, receipts, accounts and credentials intact");
  }
  assert.equal((await f.call(f.previewRoute(pupil.id))).status, 401);
  await rejected(401, undefined);
  for (const actor of actors) {
    assert.equal((await f.call(f.previewRoute(pupil.id), "GET", undefined, actor)).status, 403);
    await rejected(403, actor);
  }
  await rejected(403, { ...f.admin, csrf: "incorrect" });
  await rejected(403, f.admin, intent, { Origin: "https://untrusted.example.test" });
  await rejected(403, f.admin, { ...intent, currentPassword: "Wrong-cleanup-password-123!" });
  const missingPassword = { ...intent }; delete missingPassword.currentPassword;
  await rejected(403, f.admin, missingPassword);
  const missingFingerprint = { ...intent }; delete missingFingerprint.fingerprint;
  await rejected(400, f.admin, missingFingerprint);
  await rejected(400, f.admin, { ...intent, confirmedFictitious: false });
  await rejected(400, f.admin, { ...intent, confirmedFictitious: "true" });
  const missingCheckbox = { ...intent }; delete missingCheckbox.confirmedFictitious;
  await rejected(400, f.admin, missingCheckbox);
  await rejected(400, f.admin, { ...intent, confirmation: pupil.name.toUpperCase() });
  const withoutName = { ...intent }; delete withoutName.confirmation;
  await rejected(400, f.admin, withoutName);
  assert.equal((await f.call("/api/records/students/" + pupil.id, "DELETE", undefined, f.admin)).status, 409);
  const extra = await f.create("payments", { student: pupil.id, amount: 50, period: "2026-11", date: "2026-10-13" });
  await rejected(409, f.admin);
  const refreshed = await f.preview(pupil.id);
  assert.notEqual(refreshed.fingerprint, preview.fingerprint, "A new dependent payment invalidates the reviewed preview");
  assert.deepEqual(refreshed.counts, { payments: 2, grades: 0, attendance: 0, dailyAttendance: 0, accounts: 1, orders: 0 });
  const success = await f.call(f.purgeRoute(pupil.id), "POST", f.intent(pupil, refreshed.fingerprint), f.admin);
  assert.equal(success.status, 200);
  assert.equal(success.data.ok, true);
  assert.deepEqual(success.data.counts, refreshed.counts);
  assert.deepEqual(success.data.amounts, refreshed.amounts);
  const after = await f.state();
  assert.equal(after.records.some(record => [pupil.id, manual.id, extra.id].includes(record.id)), false);
  const retry = await f.call(f.purgeRoute(pupil.id), "POST", f.intent(pupil, refreshed.fingerprint), f.admin);
  assert.equal(retry.status, 200, JSON.stringify(retry.data));
  assert.equal(retry.data.alreadyDeleted, true);
  assert.deepEqual(await f.state(), after, "An authenticated retry returns the prior result without another audit or deletion");
});

test("Aucun nettoyage fictif ne peut enlever un paiement KKiaPay réel ou une échéance réelle, même ancienne", async t => {
  const f = await fixture(t);
  const examples = [
    { label: "Paiement réel", payment: { source: "KKiaPay", mode: "live" } },
    { label: "Ancien paiement sans mode", payment: { source: "KKiaPay" } },
    { label: "Paiement au mode inconnu", payment: { source: "KKiaPay", mode: "unexpected" } },
    { label: "Échéance réelle ouverte", order: "pending" },
    { label: "Échéance réelle payée", order: "paid" },
    { label: "Échéance réelle autorisée en caisse", order: "cash_authorized" },
  ];
  for (const example of examples) {
    const pupil = await f.pupil("Fictif déclaré — " + example.label);
    if (example.payment) {
      const payment = { id: crypto.randomUUID(), student: pupil.id, amount: 100, period: "2026-10", date: "2026-10-13", transactionId: "fake-local-" + crypto.randomUUID(), ...example.payment };
      await f.instance.db.prepare("INSERT INTO records(kind,id,payload) VALUES('payments',?,?)").run(payment.id, JSON.stringify(payment));
    } else {
      await f.instance.db.prepare("INSERT INTO payment_orders(id,student_id,period,amount,mode,state,created_at) VALUES(?,?,?,?,'live',?,?)").run(crypto.randomUUID(), pupil.id, "2026-10", 100, example.order, new Date().toISOString());
    }
    const preview = await f.preview(pupil.id);
    assert.equal(preview.canPurgeTest, false, example.label);
    assert.equal(typeof preview.reason, "string");
    assert.ok(preview.reason.length > 0);
    const before = await f.state();
    const result = await f.call(f.purgeRoute(pupil.id), "POST", f.intent(pupil, preview.fingerprint), f.admin);
    assert.equal(result.status, 409, example.label + ": " + JSON.stringify(result.data));
    assert.deepEqual(await f.state(), before, "No record/order is changed for " + example.label);
  }
});

test("Une confirmation sandbox en cours ne peut recréer le paiement après le nettoyage fictif", async t => {
  let startedResolve, releaseResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const release = new Promise(resolve => { releaseResolve = resolve; });
  let checkout;
  const f = await fixture(t, { verifyTransaction: async () => {
    startedResolve();
    await release;
    return { status: "SUCCESS", amount: checkout.data.amount, data: checkout.data.data };
  } });
  const pupil = await f.pupil("Sandbox fictif en cours de confirmation");
  checkout = await f.call("/api/payments/checkout", "POST", { student: pupil.id, period: "2026-10" }, f.admin);
  assert.equal(checkout.status, 201);
  const confirming = f.call("/api/payments/confirm", "POST", { orderId: checkout.data.orderId, transactionId: "cleanup-inflight-sandbox-fixture" }, f.admin);
  await started;
  const preview = await f.preview(pupil.id);
  const result = await f.call(f.purgeRoute(pupil.id), "POST", f.intent(pupil, preview.fingerprint), f.admin);
  releaseResolve();
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const confirmation = await confirming;
  assert.equal(confirmation.status, 409, JSON.stringify(confirmation.data));
  const state = await f.state();
  assert.equal(state.records.some(record => record.id === pupil.id || JSON.parse(record.payload).student === pupil.id), false);
  assert.equal(state.orders.find(order => order.id === checkout.data.orderId).state, "purged");
  await f.restart();
  const afterRestart = await f.state();
  assert.equal(afterRestart.orders.find(order => order.id === checkout.data.orderId).state, "purged");
  assert.equal(afterRestart.records.some(record => record.id === pupil.id || JSON.parse(record.payload).student === pupil.id), false);
});

test("La réauthentification du nettoyage est limitée sans changer le dossier après des mots de passe erronés", async t => {
  const f = await fixture(t);
  const pupil = await f.pupil("Dossier fictif pour la limite de réauthentification");
  const preview = await f.preview(pupil.id);
  const before = await f.state();
  const bad = { ...f.intent(pupil, preview.fingerprint), currentPassword: "Incorrect-cleanup-fixture-123!" };
  for (let attempt = 0; attempt < 20; attempt++)
    assert.equal((await f.call(f.purgeRoute(pupil.id), "POST", bad, f.admin)).status, 403);
  assert.equal((await f.call(f.purgeRoute(pupil.id), "POST", f.intent(pupil, preview.fingerprint), f.admin)).status, 429);
  assert.deepEqual(await f.state(), before);
  assert.equal((await f.preview(pupil.id)).canPurgeTest, true, "The password limit never marks or deletes the pupil");
});
