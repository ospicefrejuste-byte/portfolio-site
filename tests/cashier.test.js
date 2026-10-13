"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { createApplication } = require("../lib/application");
const password = "Cashier-test-password-123!";

test("Caisse protégée, paiements séparés, reçus immuables et reprise sans double encaissement", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "crs-cashier-test-"));
  const instance = createApplication({ dataDir, setupToken: "cashier-test-only" });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); instance.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(route, method = "GET", body, session, headers = {}) {
    const response = await fetch(base + route, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(session ? { Cookie: session.cookie, "X-CSRF-Token": session.csrf } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const data = response.headers.get("content-type")?.includes("application/json") ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, data, cookie: response.headers.get("set-cookie")?.split(";")[0], csrf: data.csrf };
  }
  const admin = await call("/api/auth/setup", "POST", { username: "admin", password, token: "cashier-test-only" });
  assert.equal(admin.status, 200);
  async function create(kind, body) { const response = await call("/api/records/" + kind, "POST", body, admin); assert.equal(response.status, 201, JSON.stringify(response.data)); return response.data; }
  const centre = (await call("/api/catalogue")).data.centres[0];
  const pupil = await create("students", { name: "Élève caisse", class: "6e", centre, group: "6e · " + centre, guardian: "Parent fictif", phone: "+2290100000000", subjects: ["Mathématiques"], monthlyFee: 5000 });
  const pre = await create("students", { name: "Préinscription caisse", class: "6e", group: "6e · " + centre, registrationStatus: "Préinscription", monthlyFee: 2000 });
  const suspended = await create("students", { name: "Dossier suspendu", class: "6e", group: "6e · " + centre, registrationStatus: "Suspendu", monthlyFee: 2000 });
  const teacher = await create("teachers", { name: "Enseignant caisse", subject: "Mathématiques" });
  const cashUser = await call("/api/admin/users", "POST", { username: "cash-test", role: "cashier", password, entityId: pupil.id }, admin);
  assert.equal(cashUser.status, 201); assert.equal(cashUser.data.entityId, null); assert.equal(cashUser.data.mustChangePassword, true);
  let cashier = await call("/api/auth/login", "POST", { username: "cash-test", password });
  assert.equal(cashier.status, 200);
  assert.equal((await call("/api/cashier?period=2026-10", "GET", undefined, cashier)).status, 403);
  cashier = await call("/api/auth/password", "POST", { currentPassword: password, password: "Personal-cashier-test-123!" }, cashier);
  assert.equal(cashier.status, 200);
  assert.equal((await call("/api/cashier?period=2026-10")).status, 401);
  assert.equal((await call("/api/cashier?period=2026-13", "GET", undefined, cashier)).status, 400);
  for (const [role, entityId] of [["teacher", teacher.id], ["student", pupil.id]]) {
    assert.equal((await call("/api/admin/users", "POST", { username: role + "-cash-test", role, entityId, password }, admin)).status, 201);
    let user = await call("/api/auth/login", "POST", { username: role + "-cash-test", password });
    user = await call("/api/auth/password", "POST", { currentPassword: password, password: "Personal-" + role + "-cash-test-123!" }, user);
    assert.equal((await call("/api/cashier?period=2026-10", "GET", undefined, user)).status, 403);
    assert.equal((await call("/api/cashier/payments", "POST", { requestId: crypto.randomUUID(), student: pupil.id, period: "2026-10", amount: 1000 }, user)).status, 403);
    assert.equal((await call("/api/admin/payment-orders/" + crypto.randomUUID() + "/authorize-cash", "POST", { confirmedUnpaid: true }, user)).status, 403);
  }
  for (const route of ["/api/admin/users", "/api/admin/settings", "/api/admin/export", "/api/admin/monthly-balances?period=2026-10", "/api/admin/students/" + pupil.id + "/report.pdf", "/api/payments/config", "/api/payments/orders"])
    assert.equal((await call(route, "GET", undefined, cashier)).status, 403, route);
  for (const route of ["/api/payments/checkout", "/api/payments/confirm", "/api/admin/users", "/api/records/payments", "/api/records/students", "/api/admin/payment-orders/" + crypto.randomUUID() + "/authorize-cash"])
    assert.equal((await call(route, "POST", {}, cashier)).status, 403, route);
  const privateData = (await call("/api/data", "GET", undefined, cashier)).data;
  assert.ok(Object.values(privateData).every((rows) => Array.isArray(rows) && rows.length === 0));
  const legacy = await create("payments", { student: pupil.id, period: "2026-10", date: "2026-10-01", amount: 500 });
  const online = { id: crypto.randomUUID(), student: pupil.id, period: "2026-10", date: "2026-10-01", amount: 1000, source: "KKiaPay", mode: "live", transactionId: "verified-fixture" };
  const sandbox = { ...online, id: crypto.randomUUID(), amount: 5000, mode: "sandbox" };
  for (const payment of [online, sandbox]) instance.db.prepare("INSERT INTO records(kind,id,payload) VALUES('payments',?,?)").run(payment.id, JSON.stringify(payment));
  let ledger = (await call("/api/cashier?period=2026-10", "GET", undefined, cashier)).data;
  let row = ledger.students.find((student) => student.id === pupil.id);
  assert.equal(row.fee, 5000); assert.equal(row.paid, 1500); assert.equal(row.cashPaid, 500); assert.equal(row.onlinePaid, 1000); assert.equal(row.balance, 3500);
  assert.deepEqual(ledger.totals, { cash: 500, online: 1000 }); assert.deepEqual(ledger.payments.map((payment) => payment.id), [legacy.id]);
  assert.equal(ledger.students.find((student) => student.id === pre.id).fee, 2000);
  const request = { requestId: crypto.randomUUID(), student: pupil.id, period: "2026-10", amount: 1500, source: "KKiaPay", date: "1999-01-01", collectedBy: admin.data.user.id };
  const receipt = await call("/api/cashier/payments", "POST", request, cashier);
  assert.equal(receipt.status, 201); assert.equal(receipt.data.id, request.requestId); assert.equal(receipt.data.source, "Caisse"); assert.equal(receipt.data.channel, "cash");
  assert.equal(receipt.data.collectedBy, cashUser.data.id); assert.equal(receipt.data.collectedByName, "cash-test"); assert.equal(receipt.data.date, new Date().toISOString().slice(0, 10));
  const replay = await call("/api/cashier/payments", "POST", request, cashier);
  assert.equal(replay.status, 200); assert.deepEqual(replay.data, receipt.data);
  assert.equal((await call("/api/cashier/payments", "POST", { ...request, amount: 1 }, cashier)).status, 409);
  assert.equal((await call("/api/cashier/payments", "POST", request, admin)).status, 409);
  for (const amount of [0, -1, 0.5, "1000"]) assert.equal((await call("/api/cashier/payments", "POST", { ...request, requestId: crypto.randomUUID(), amount }, cashier)).status, 400);
  assert.equal((await call("/api/cashier/payments", "POST", { ...request, requestId: "bad" }, cashier)).status, 400);
  assert.equal((await call("/api/cashier/payments", "POST", { ...request, requestId: crypto.randomUUID(), amount: 2001 }, cashier)).status, 409);
  assert.equal((await call("/api/cashier/payments", "POST", { ...request, requestId: crypto.randomUUID(), student: crypto.randomUUID() }, cashier)).status, 404);
  assert.equal((await call("/api/cashier/payments", "POST", { ...request, requestId: crypto.randomUUID(), student: suspended.id }, cashier)).status, 409);
  assert.equal((await call("/api/cashier/payments", "POST", { ...request, requestId: crypto.randomUUID() }, { ...cashier, csrf: "wrong" })).status, 403);
  assert.equal((await call("/api/cashier/payments", "POST", { ...request, requestId: crypto.randomUUID() }, cashier, { Origin: "https://untrusted.example" })).status, 403);
  const competing = await Promise.all([1, 2].map(() => call("/api/cashier/payments", "POST", { requestId: crypto.randomUUID(), student: pupil.id, period: "2026-10", amount: 2000 }, cashier)));
  assert.deepEqual(competing.map((result) => result.status).sort(), [201, 409]);
  assert.equal((await call("/api/cashier/payments", "POST", { ...request, requestId: crypto.randomUUID(), amount: 1 }, cashier)).status, 409);
  assert.equal((await call("/api/cashier/payments", "POST", request, cashier)).status, 200);
  const prePayment = await call("/api/cashier/payments", "POST", { requestId: crypto.randomUUID(), student: pre.id, period: "2026-10", amount: 2000 }, admin);
  assert.equal(prePayment.status, 201); assert.equal(prePayment.data.collectedByName, "admin");
  for (const method of ["PUT", "DELETE"]) {
    assert.equal((await call("/api/records/payments/" + receipt.data.id, method, method === "PUT" ? { amount: 1 } : undefined, admin)).status, 409);
    assert.equal((await call("/api/records/payments/" + receipt.data.id, method, method === "PUT" ? { amount: 1 } : undefined, cashier)).status, 403);
  }
  for (const payment of [receipt.data, legacy]) {
    const pdf = await call("/api/payments/" + payment.id + "/receipt.pdf", "GET", undefined, cashier);
    assert.equal(pdf.status, 200); assert.equal(pdf.data.subarray(0, 5).toString(), "%PDF-");
  }
  for (const payment of [online, sandbox]) assert.equal((await call("/api/payments/" + payment.id + "/receipt.pdf", "GET", undefined, cashier)).status, 403);
  ledger = (await call("/api/cashier?period=2026-10", "GET", undefined, admin)).data;
  row = ledger.students.find((student) => student.id === pupil.id);
  assert.equal(row.status, "Payé"); assert.equal(row.balance, 0); assert.equal(row.paid, 5000); assert.deepEqual(ledger.totals, { cash: 6000, online: 1000 });
  const data = (await call("/api/data", "GET", undefined, admin)).data;
  assert.equal(data.payments.filter((payment) => payment.id === receipt.data.id).length, 1);
  assert.equal(data.students.find((student) => student.id === pre.id).registrationStatus, "Préinscription");
  // An already-open real online payment must not also be collected in cash.
  const pendingId = crypto.randomUUID();
  instance.db.prepare("INSERT INTO payment_orders(id,student_id,period,amount,mode,state,created_at) VALUES(?,?,?,?,'live','pending',?)").run(pendingId, pre.id, "2026-11", 2000, new Date().toISOString());
  assert.match((await call("/api/cashier?period=2026-11", "GET", undefined, cashier)).data.students.find((student) => student.id === pre.id).blockedReason, /ligne/);
  assert.equal((await call("/api/cashier/payments", "POST", { requestId: crypto.randomUUID(), student: pre.id, period: "2026-11", amount: 2000 }, cashier)).status, 409);
  instance.db.prepare("UPDATE payment_orders SET mode='sandbox' WHERE id=?").run(pendingId);
  assert.equal((await call("/api/cashier/payments", "POST", { requestId: crypto.randomUUID(), student: pre.id, period: "2026-11", amount: 2000 }, cashier)).status, 201);
  assert.equal((await call("/api/admin/users/" + cashUser.data.id, "PUT", { enabled: false }, admin)).status, 200);
  assert.equal((await call("/api/cashier?period=2026-10", "GET", undefined, cashier)).status, 401);
});

test("Autorisation responsable après tentative en ligne : audit et paiement tardif réellement conservé", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "crs-cash-authorize-"));
  let verified;
  const instance = createApplication({ dataDir, setupToken: "cash-authorize-only", paymentConfig: { sandbox: false, publicKey: "fixture-public", privateKey: "fixture-private", secretKey: "fixture-secret" }, verifyTransaction: async () => verified });
  const server = instance.app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); instance.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(route, method = "GET", body, session) {
    const response = await fetch(base + route, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(session ? { Cookie: session.cookie, "X-CSRF-Token": session.csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json(); return { status: response.status, data, cookie: response.headers.get("set-cookie")?.split(";")[0], csrf: data.csrf };
  }
  const admin = await call("/api/auth/setup", "POST", { username: "admin-authorize", password, token: "cash-authorize-only" }); assert.equal(admin.status, 200);
  const pupil = (await call("/api/records/students", "POST", { name: "Élève autorisation", class: "6e", group: "6e A", registrationStatus: "Inscrit", monthlyFee: 3500 }, admin)).data;
  const cashUser = await call("/api/admin/users", "POST", { username: "cash-authorize", role: "cashier", password }, admin); assert.equal(cashUser.status, 201);
  let cashier = await call("/api/auth/login", "POST", { username: "cash-authorize", password });
  cashier = await call("/api/auth/password", "POST", { currentPassword: password, password: "Personal-cash-authorize-123!" }, cashier); assert.equal(cashier.status, 200);
  const checkout = await call("/api/payments/checkout", "POST", { student: pupil.id, period: "2026-10" }, admin); assert.equal(checkout.status, 201); assert.equal(checkout.data.sandbox, false);
  const orderId = checkout.data.orderId, route = "/api/admin/payment-orders/" + orderId + "/authorize-cash";
  const intent = { requestId: crypto.randomUUID(), student: pupil.id, period: "2026-10", amount: 3500 };
  assert.equal((await call("/api/cashier/payments", "POST", intent, cashier)).status, 409);
  assert.match((await call("/api/cashier?period=2026-10", "GET", undefined, cashier)).data.students[0].blockedReason, /ligne/);
  assert.equal((await call(route, "POST", { confirmedUnpaid: true })).status, 401);
  assert.equal((await call(route, "POST", { confirmedUnpaid: true }, cashier)).status, 403);
  for (const body of [{}, { confirmedUnpaid: false }, { confirmedUnpaid: "true" }]) assert.equal((await call(route, "POST", body, admin)).status, 400);
  assert.equal((await call(route, "POST", { confirmedUnpaid: true }, { ...admin, csrf: "wrong" })).status, 403);
  assert.equal((await call("/api/admin/payment-orders/" + crypto.randomUUID() + "/authorize-cash", "POST", { confirmedUnpaid: true }, admin)).status, 404);
  let orders = (await call("/api/payments/orders", "GET", undefined, admin)).data; assert.equal(orders[0].status, "pending");
  const authorized = await Promise.all([1, 2].map(() => call(route, "POST", { confirmedUnpaid: true }, admin)));
  assert.ok(authorized.every((result) => result.status === 200 && result.data.ok === true));
  const savedAuthorization = instance.db.prepare("SELECT value FROM settings WHERE key=?").get("cash_authorization:" + orderId);
  const audit = JSON.parse(savedAuthorization.value);
  assert.equal(audit.orderId, orderId); assert.equal(audit.student, pupil.id); assert.equal(audit.period, "2026-10"); assert.equal(audit.authorizedBy, admin.data.user.id); assert.equal(audit.authorizedByName, "admin-authorize"); assert.ok(Number.isFinite(Date.parse(audit.authorizedAt)));
  assert.equal(Number(instance.db.prepare("SELECT count(*) n FROM settings WHERE key=?").get("cash_authorization:" + orderId).n), 1);
  assert.equal((await call("/api/data", "GET", undefined, admin)).data.payments.length, 0);
  orders = (await call("/api/payments/orders", "GET", undefined, admin)).data; assert.equal(orders[0].status, "cash_authorized"); assert.equal(orders[0].transactionId, null);
  let row = (await call("/api/cashier?period=2026-10", "GET", undefined, cashier)).data.students[0]; assert.equal(row.blockedReason, undefined); assert.equal(row.balance, 3500);
  const cash = await call("/api/cashier/payments", "POST", intent, cashier); assert.equal(cash.status, 201); assert.equal(cash.data.collectedBy, cashUser.data.id);
  // A provider success arriving later must be recorded, even though cash was
  // subsequently received. The excess is visible for review, never discarded.
  verified = { status: "SUCCESS", transactionId: "late_verified_fixture", amount: checkout.data.amount, data: { orderId } };
  const online = await call("/api/payments/confirm", "POST", { orderId, transactionId: "late_verified_fixture" }, admin); assert.equal(online.status, 200);
  const data = (await call("/api/data", "GET", undefined, admin)).data; assert.equal(data.payments.length, 2); assert.deepEqual(data.payments.map((payment) => payment.source).sort(), ["Caisse", "KKiaPay"]);
  const balance = (await call("/api/admin/monthly-balances?period=2026-10", "GET", undefined, admin)).data.rows[0]; assert.equal(balance.paid, 7000); assert.equal(balance.advance, 3500); assert.equal(balance.status, "Avance");
  row = (await call("/api/cashier?period=2026-10", "GET", undefined, cashier)).data.students[0]; assert.equal(row.cashPaid, 3500); assert.equal(row.onlinePaid, 3500); assert.equal(row.balance, 0);
  assert.equal((await call(route, "POST", { confirmedUnpaid: true }, admin)).status, 409);
  assert.equal((await call("/api/payments/confirm", "POST", { orderId, transactionId: "late_verified_fixture" }, admin)).data.alreadyConfirmed, true);
  assert.equal((await call("/api/data", "GET", undefined, admin)).data.payments.length, 2);
  const sandboxOrder = crypto.randomUUID();
  instance.db.prepare("INSERT INTO payment_orders(id,student_id,period,amount,mode,state,created_at) VALUES(?,?,?,?,'sandbox','pending',?)").run(sandboxOrder, pupil.id, "2026-11", 3500, new Date().toISOString());
  assert.equal((await call("/api/admin/payment-orders/" + sandboxOrder + "/authorize-cash", "POST", { confirmedUnpaid: true }, admin)).status, 409);
  assert.equal(instance.db.prepare("SELECT value FROM settings WHERE key=?").get("cash_authorization:" + sandboxOrder), undefined);
  assert.equal((await call("/api/admin/users/" + cashUser.data.id, "PUT", { enabled: false }, admin)).status, 200);
  assert.equal((await call(route, "POST", { confirmedUnpaid: true }, cashier)).status, 401);
});

test("Migration de l’ancien rôle : comptes et sessions conservés", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "crs-cashier-migrate-"));
  let instance = createApplication({ dataDir, setupToken: "cashier-migration-only" });
  let server = instance.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  let base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base + "/api/auth/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "legacy-admin", password, token: "cashier-migration-only" }) });
  const session = { cookie: response.headers.get("set-cookie").split(";")[0], csrf: (await response.json()).csrf };
  await new Promise((resolve) => server.close(resolve));
  if (process.env.CRS_TEST_DATABASE_URL) {
    await instance.db.exec("ALTER TABLE users DROP CONSTRAINT users_role_check; ALTER TABLE users ADD CONSTRAINT users_role_check CHECK(role IN ('admin','teacher','student'));");
    instance.db.close();
    // Cloud creation is transformed to async; map starts both factories together.
    const upgraded = await Promise.all([dataDir, dataDir].map(async (dir) => createApplication({ dataDir: dir })));
    instance = upgraded[0]; await upgraded[1].db.close();
  } else {
    instance.db.close();
    const old = new DatabaseSync(path.join(dataDir, "school.sqlite"));
    old.exec(`PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;
      CREATE TABLE users_legacy (id TEXT PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','teacher','student')), entity_id TEXT, enabled INTEGER NOT NULL DEFAULT 1, must_change INTEGER NOT NULL DEFAULT 0);
      INSERT INTO users_legacy SELECT * FROM users; DROP TABLE users; ALTER TABLE users_legacy RENAME TO users;
      CREATE UNIQUE INDEX users_entity ON users(role,entity_id) WHERE entity_id IS NOT NULL; COMMIT;`);
    old.close();
    instance = createApplication({ dataDir });
  }
  server = instance.app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve)); base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); instance.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const me = await fetch(base + "/api/auth/me", { headers: { Cookie: session.cookie } }); assert.equal(me.status, 200); assert.equal((await me.json()).user.username, "legacy-admin");
  const added = await fetch(base + "/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json", Cookie: session.cookie, "X-CSRF-Token": session.csrf }, body: JSON.stringify({ username: "new-cashier", role: "cashier", password }) });
  assert.equal(added.status, 201); assert.equal((await added.json()).role, "cashier");
  const retained = instance.db.prepare("SELECT count(*) n FROM sessions").get(); assert.equal(Number(retained.n), 1);
  if (process.env.CRS_TEST_DATABASE_URL) {
    const constraint = instance.db.prepare("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='users'::regclass AND conname='users_role_check'").get();
    assert.match(constraint.definition, /cashier/);
    const protectedTables = instance.db.prepare("SELECT relname,relrowsecurity FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relname IN ('settings','records','users','sessions','registration_access','payment_orders','request_limits')").all();
    assert.equal(protectedTables.length, 7); assert.ok(protectedTables.every((table) => table.relrowsecurity === true));
  } else {
    assert.equal(instance.db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.equal(instance.db.prepare("PRAGMA foreign_key_check").get(), undefined);
  }
});
