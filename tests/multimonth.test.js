"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApplication } = require("../lib/application");

const password = "Multimonth-fixture-password-123!";
const providerConfig = { publicKey: "bundle-fixture-public", privateKey: "bundle-fixture-private", secretKey: "bundle-fixture-secret" };

// Explicit awaits make these same fixtures safe in the PostgreSQL test harness.
async function fixture(t, { sandbox = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "crs-multimonth-"));
  let verified = { status: "FAILED" };
  const verificationCalls = [];
  const options = {
    dataDir, setupToken: "multimonth-fixture-setup", publicOrigin: "https://receipts.example.test",
    paymentConfig: { ...providerConfig, sandbox },
    verifyTransaction: async transactionId => { verificationCalls.push(transactionId); return verified; },
  };
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
      method, redirect: "manual",
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(session ? { Cookie: session.cookie, "X-CSRF-Token": session.csrf } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = response.headers.get("content-type")?.includes("application/json") ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, data, cookie: response.headers.get("set-cookie")?.split(";")[0], csrf: data.csrf };
  }
  const admin = await call("/api/auth/setup", "POST", { username: "bundle-admin", password, token: options.setupToken });
  assert.equal(admin.status, 200, JSON.stringify(admin.data));
  const school = (await call("/api/catalogue")).data;
  async function create(kind, body) {
    const result = await call("/api/records/" + kind, "POST", body, admin);
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data;
  }
  async function pupil(name, extra = {}) {
    return create("students", { name, class: "6e", centre: school.centres[0], group: "6e · " + school.centres[0], subjects: ["Mathématiques"], monthlyFee: 3500, ...extra });
  }
  async function account(role, entityId) {
    const username = "bundle-" + role;
    const created = await call("/api/admin/users", "POST", { username, role, entityId, password }, admin);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const logged = await call("/api/auth/login", "POST", { username, password, ...(role === "cashier" ? { space: "cashier" } : {}) });
    assert.equal(logged.status, 200);
    const changed = await call("/api/auth/password", "POST", { currentPassword: password, password: "Personal-" + username + "-123!" }, logged);
    assert.equal(changed.status, 200);
    return { ...changed, account: created.data };
  }
  async function payments() { return (await call("/api/data", "GET", undefined, admin)).data.payments; }
  async function restart() {
    await new Promise(resolve => server.close(resolve));
    await instance.db.close();
    instance = await createApplication(options);
    await listen();
  }
  return { call, admin, school, create, pupil, account, payments, restart, verificationCalls, setVerified: value => { verified = value; }, get db() { return instance.db; } };
}

function consecutive(start, count) {
  const [year, month] = start.split("-").map(Number);
  return Array.from({ length: count }, (_, index) => {
    const serial = year * 12 + month - 1 + index;
    return `${Math.floor(serial / 12)}-${String(serial % 12 + 1).padStart(2, "0")}`;
  });
}
function intent(student, periods, amount) { return { requestId: crypto.randomUUID(), student: student.id, periods, amount }; }
function receiptToken(pdf) {
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  const links = [...pdf.toString("latin1").matchAll(/\/URI\s*\(([^)]*)\)/g)].map(match => match[1].replace(/\\([\\()])/g, "$1"));
  const link = links.find(value => value.includes("/verification-recu.html#"));
  assert.ok(link, "The bundled receipt contains a signed verification link");
  return new URL(link).hash.slice(1);
}
async function ledgerRow(f, pupil, period, session = f.admin) {
  const ledger = await f.call("/api/cashier?period=" + period, "GET", undefined, session);
  assert.equal(ledger.status, 200, JSON.stringify(ledger.data));
  return { ledger: ledger.data, row: ledger.data.students.find(student => student.id === pupil.id) };
}

test("Caisse : devis sur douze mois, reste par mois et un seul reçu pour une reprise concurrente", async t => {
  const f = await fixture(t);
  const pupil = await f.pupil("Élève devis partiel");
  const cashier = await f.account("cashier");
  const partial = await f.call("/api/cashier/payments", "POST", { requestId: crypto.randomUUID(), student: pupil.id, period: "2026-11", amount: 1000 }, cashier);
  assert.equal(partial.status, 201);
  assert.equal(Object.hasOwn(partial.data, "periods"), false);
  assert.equal(Object.hasOwn(partial.data, "allocations"), false);
  const quote = await f.call(`/api/cashier/students/${pupil.id}/months?start=2026-11`, "GET", undefined, cashier);
  assert.equal(quote.status, 200, JSON.stringify(quote.data));
  assert.equal(quote.data.start, "2026-11");
  assert.deepEqual(quote.data.student, { id: pupil.id, name: pupil.name, class: pupil.class, centre: pupil.centre, registrationStatus: pupil.registrationStatus });
  assert.deepEqual(quote.data.months.map(month => month.period), consecutive("2026-11", 12));
  assert.deepEqual(quote.data.months.slice(0, 3).map(({ fee, paid, balance }) => ({ fee, paid, balance })), [
    { fee: 3500, paid: 1000, balance: 2500 }, { fee: 3500, paid: 0, balance: 3500 }, { fee: 3500, paid: 0, balance: 3500 },
  ]);
  const request = intent(pupil, ["2027-01", "2026-11", "2026-12"], 9500);
  for (const amount of [9499, 9501]) assert.equal((await f.call("/api/cashier/payments", "POST", { ...request, requestId: crypto.randomUUID(), amount }, cashier)).status, 409);
  const concurrent = await Promise.all([1, 2].map(() => f.call("/api/cashier/payments", "POST", request, cashier)));
  assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 201]);
  assert.deepEqual(concurrent[0].data, concurrent[1].data);
  const payment = concurrent[0].data;
  assert.equal(payment.id, request.requestId);
  assert.equal(payment.amount, 9500);
  assert.equal(payment.period, "2026-11");
  assert.equal(payment.source, "Caisse");
  assert.equal(payment.collectedBy, cashier.account.id);
  assert.deepEqual(payment.periods, ["2026-11", "2026-12", "2027-01"]);
  assert.deepEqual(payment.allocations, [{ period: "2026-11", amount: 2500 }, { period: "2026-12", amount: 3500 }, { period: "2027-01", amount: 3500 }]);
  const replay = await f.call("/api/cashier/payments", "POST", { ...request, periods: [...request.periods].reverse() }, cashier);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, payment);
  assert.equal((await f.call("/api/cashier/payments", "POST", request, f.admin)).status, 409, "A receipt cannot be replayed as another collector");
  assert.equal((await f.call("/api/cashier/payments", "POST", intent(pupil, ["2027-01", "2027-02"], 3500), cashier)).status, 409, "Every selected month must have an unpaid balance");
  assert.equal((await f.payments()).filter(saved => saved.id === payment.id).length, 1);
  for (const period of payment.periods) {
    const { ledger, row } = await ledgerRow(f, pupil, period, cashier);
    assert.equal(row.paid, 3500);
    assert.equal(row.cashPaid, 3500);
    assert.equal(row.balance, 0);
    assert.deepEqual(ledger.totals, { cash: 3500, online: 0 });
    assert.equal(ledger.payments.filter(saved => saved.id === payment.id).length, 1);
  }
  const after = await f.call(`/api/cashier/students/${pupil.id}/months?start=2026-11`, "GET", undefined, f.admin);
  assert.ok(after.data.months.slice(0, 3).every(month => month.balance === 0 && month.status === "Payé"));
});

test("Caisse : règlements de un, trois, six mois et sélection personnalisée sans fausser le mois courant", async t => {
  const f = await fixture(t);
  const currentPeriod = new Date().toISOString().slice(0, 7);
  const scenarios = [
    { name: "Un mois", periods: ["2028-11"] },
    { name: "Trois mois", periods: consecutive("2028-11", 3) },
    { name: "Six mois", periods: consecutive("2029-11", 6) },
    { name: "Mois personnalisés", periods: ["2031-05", "2031-01", "2031-03", "2031-08"] },
  ];
  for (const scenario of scenarios) {
    const pupil = await f.pupil(scenario.name);
    const result = await f.call("/api/cashier/payments", "POST", intent(pupil, scenario.periods, 3500 * scenario.periods.length), f.admin);
    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.equal(result.data.amount, 3500 * scenario.periods.length);
    assert.equal(result.data.period, [...scenario.periods].sort()[0]);
    if (scenario.periods.length === 1) {
      assert.equal(Object.hasOwn(result.data, "periods"), false);
      assert.equal(Object.hasOwn(result.data, "allocations"), false);
    } else {
      assert.deepEqual(result.data.periods, [...scenario.periods].sort());
      assert.deepEqual(result.data.allocations, [...scenario.periods].sort().map(period => ({ period, amount: 3500 })));
    }
    assert.equal((await ledgerRow(f, pupil, currentPeriod)).row.paid, 0);
    for (const period of scenario.periods) assert.equal((await ledgerRow(f, pupil, period)).row.paid, 3500);
  }
  assert.equal((await f.payments()).length, scenarios.length, "A bundle creates one payment record, regardless of duration");
});

test("Caisse : validation, accès et blocage sur tous les mois des tentatives réelles en ligne", async t => {
  const f = await fixture(t);
  const pupil = await f.pupil("Élève chevauchement caisse");
  const teacher = await f.create("teachers", { name: "Enseignant sans accès caisse", subject: "Mathématiques" });
  const studentSession = await f.account("student", pupil.id);
  const teacherSession = await f.account("teacher", teacher.id);
  const quoteRoute = `/api/cashier/students/${pupil.id}/months?start=2026-11`;
  assert.equal((await f.call(quoteRoute)).status, 401);
  for (const user of [studentSession, teacherSession]) {
    assert.equal((await f.call(quoteRoute, "GET", undefined, user)).status, 403);
    assert.equal((await f.call("/api/cashier/payments", "POST", intent(pupil, ["2026-11", "2026-12"], 7000), user)).status, 403);
  }
  for (const periods of [[], ["2026-11", "2026-11"], consecutive("2000-01", 1201), ["2026-13"], ["1999-12"], ["2100-01"], "2026-11", [null]]) {
    assert.equal((await f.call("/api/cashier/payments", "POST", intent(pupil, periods, 7000), f.admin)).status, 400, JSON.stringify(periods));
  }
  assert.equal((await f.call(`/api/cashier/students/${pupil.id}/months?start=2026-13`, "GET", undefined, f.admin)).status, 400);
  assert.equal((await f.call(`/api/cashier/students/${crypto.randomUUID()}/months?start=2026-11`, "GET", undefined, f.admin)).status, 404);
  const pending = await f.call("/api/payments/checkout", "POST", { student: pupil.id, period: "2026-11", monthCount: 3 }, f.admin);
  assert.equal(pending.status, 201);
  const quote = await f.call(quoteRoute, "GET", undefined, f.admin);
  assert.ok(quote.data.months.slice(0, 3).every(month => /ligne/.test(month.blockedReason)));
  assert.equal(quote.data.months[3].blockedReason, undefined);
  assert.match((await ledgerRow(f, pupil, "2027-01")).row.blockedReason, /ligne/);
  assert.equal((await f.call("/api/cashier/payments", "POST", intent(pupil, ["2026-10", "2027-01"], 7000), f.admin)).status, 409, "A later selected month can block the entire bundle");
  assert.equal((await f.call("/api/cashier/payments", "POST", intent(pupil, ["2027-02", "2027-03"], 7000), f.admin)).status, 201);
  await f.db.prepare("UPDATE payment_orders SET mode='sandbox' WHERE id=?").run(pending.data.orderId);
  assert.equal((await f.call("/api/cashier/payments", "POST", intent(pupil, ["2026-11", "2026-12", "2027-01"], 10500), f.admin)).status, 201, "Sandbox attempts do not block a real cash receipt");
  assert.equal(f.verificationCalls.length, 0, "Quoting and cash collection never contact the provider");
});

test("Paiement réel : total vérifié, un reçu par forfait, chevauchements et devis conservé après changement du tarif", async t => {
  const f = await fixture(t);
  for (const count of [1, 3, 6]) {
    const pupil = await f.pupil("Élève paiement réel " + count);
    if (count === 3) await f.create("payments", { student: pupil.id, period: "2026-11", amount: 1000, date: "2026-10-14" });
    const order = await f.call("/api/payments/checkout", "POST", { student: pupil.id, period: "2026-11", monthCount: count, amount: 1 }, f.admin);
    assert.equal(order.status, 201, JSON.stringify(order.data));
    const periods = consecutive("2026-11", count);
    const allocations = periods.map((period, index) => ({ period, amount: count === 3 && index === 0 ? 2500 : 3500 }));
    const amount = allocations.reduce((total, allocation) => total + allocation.amount, 0);
    assert.equal(order.data.amount, amount);
    assert.equal(order.data.sandbox, false);
    assert.deepEqual(order.data.periods, periods);
    assert.deepEqual(order.data.allocations, allocations);
    assert.deepEqual(JSON.parse(order.data.data), { orderId: order.data.orderId });
    const repeated = await f.call("/api/payments/checkout", "POST", { student: pupil.id, periods: [...periods].reverse() }, f.admin);
    assert.equal(repeated.status, 201);
    assert.equal(repeated.data.orderId, order.data.orderId);
    const transactionId = "verified_bundle_" + count;
    const confirmation = { orderId: order.data.orderId, transactionId };
    f.setVerified({ status: "SUCCESS", amount: amount - 1, data: order.data.data });
    assert.equal((await f.call("/api/payments/confirm", "POST", confirmation, f.admin)).status, 409);
    f.setVerified({ status: "SUCCESS", amount, data: { orderId: crypto.randomUUID() } });
    assert.equal((await f.call("/api/payments/confirm", "POST", confirmation, f.admin)).status, 409);
    if (count === 3) {
      const changed = await f.call("/api/records/students/" + pupil.id, "PUT", { ...pupil, monthlyFee: 5000 }, f.admin);
      assert.equal(changed.status, 200);
    }
    f.setVerified({ status: "SUCCESS", transactionId, amount, data: order.data.data });
    const confirmed = await Promise.all([1, 2].map(() => f.call("/api/payments/confirm", "POST", confirmation, f.admin)));
    assert.ok(confirmed.every(result => result.status === 200));
    assert.equal(confirmed.filter(result => result.data.alreadyConfirmed === true).length, 1);
    const payments = (await f.payments()).filter(payment => payment.orderId === order.data.orderId);
    assert.equal(payments.length, 1);
    assert.equal(payments[0].amount, amount, "The confirmed amount remains the original server quote");
    assert.equal(payments[0].period, periods[0]);
    assert.equal(payments[0].mode, "live");
    assert.equal(payments[0].source, "KKiaPay");
    if (count > 1) {
      assert.deepEqual(payments[0].periods, periods);
      assert.deepEqual(payments[0].allocations, allocations);
    } else {
      assert.equal(Object.hasOwn(payments[0], "periods"), false);
      assert.equal(Object.hasOwn(payments[0], "allocations"), false);
    }
    const { row } = await ledgerRow(f, pupil, periods.at(-1));
    assert.equal(row.onlinePaid, 3500);
    assert.equal(row.paid, 3500);
    assert.equal((await f.call("/api/payments/checkout", "POST", { student: pupil.id, periods: ["2026-10", periods.at(-1)] }, f.admin)).status, 409, "Paid overlap is found beyond the first month");
  }
  const pendingPupil = await f.pupil("Élève tentatives disjointes");
  assert.equal((await f.call("/api/payments/checkout", "POST", { student: pendingPupil.id, period: "2027-04", monthCount: 3 }, f.admin)).status, 201);
  assert.equal((await f.call("/api/payments/checkout", "POST", { student: pendingPupil.id, period: "2027-02", monthCount: 3 }, f.admin)).status, 409, "Pending overlap is found beyond the first month");
  assert.equal((await f.call("/api/payments/checkout", "POST", { student: pendingPupil.id, period: "2027-07", monthCount: 3 }, f.admin)).status, 201);
  for (const body of [{ period: "2026-11", monthCount: 0 }, { period: "2026-11", monthCount: 1201 }, { period: "2099-12", monthCount: 3 }, { periods: ["2026-11", "2026-11"] }, { periods: consecutive("2000-01", 1201) }])
    assert.equal((await f.call("/api/payments/checkout", "POST", { student: pendingPupil.id, ...body }, f.admin)).status, 400);
});

test("Inscription publique : forfaits de trois et six mois réservés au jeton propriétaire et mode test séparé de la caisse", async t => {
  const f = await fixture(t, { sandbox: true });
  const registrations = [];
  for (const count of [3, 6]) {
    const name = "Inscription publique forfait " + count;
    const registration = await f.call("/api/registrations", "POST", { name, guardian: "Parent fictif privé", phone: "0100000000", class: "6e", centre: f.school.centres[0], subjects: ["Mathématiques"], consent: true });
    assert.equal(registration.status, 201);
    const headers = { Authorization: "Bearer " + registration.data.paymentToken };
    const order = await f.call("/api/registration-payments/checkout", "POST", { period: "2026-11", monthCount: count, amount: 1 }, undefined, headers);
    assert.equal(order.status, 201);
    assert.equal(order.data.amount, count * 3500);
    assert.deepEqual(order.data.periods, consecutive("2026-11", count));
    registrations.push({ name, count, registration, headers, order });
  }
  for (let index = 0; index < registrations.length; index++) {
    const own = registrations[index], other = registrations[1 - index];
    const transactionId = "public_bundle_fixture_" + own.count;
    const confirmation = { orderId: own.order.data.orderId, transactionId };
    f.setVerified({ status: "SUCCESS", amount: own.order.data.amount, data: own.order.data.data });
    const before = f.verificationCalls.length;
    assert.equal((await f.call("/api/registration-payments/confirm", "POST", confirmation, undefined, other.headers)).status, 403);
    assert.equal(f.verificationCalls.length, before, "A foreign token cannot trigger provider verification");
    assert.equal((await f.call("/api/registration-payments/confirm", "POST", confirmation, undefined, own.headers)).status, 200);
    assert.equal((await f.call("/api/registration-payments/confirm", "POST", confirmation, undefined, own.headers)).data.alreadyConfirmed, true);
    const route = "/api/registration-payments/receipt.pdf?orderId=" + own.order.data.orderId;
    assert.equal((await f.call(route, "GET", undefined, undefined, other.headers)).status, 404);
    const pdf = await f.call(route, "GET", undefined, undefined, own.headers);
    assert.equal(pdf.status, 200);
    const checked = await f.call("/api/receipts/verify", "POST", { token: receiptToken(pdf.data) });
    assert.equal(checked.data.status, "test");
    assert.equal(checked.data.receipt.amount, own.count * 3500);
    assert.deepEqual(checked.data.receipt.periods, own.order.data.periods);
    assert.deepEqual(checked.data.receipt.allocations, own.order.data.allocations);
    assert.equal(checked.data.receipt.studentName, own.name);
    assert.doesNotMatch(JSON.stringify(checked.data), /guardian|phone|orderId|transactionId|collectedBy|token|signature/);
    const payment = (await f.payments()).filter(saved => saved.orderId === own.order.data.orderId);
    assert.equal(payment.length, 1);
    assert.equal(payment[0].mode, "sandbox");
    const data = (await f.call("/api/data", "GET", undefined, f.admin)).data;
    const pupil = data.students.find(student => student.id === payment[0].student);
    assert.equal((await f.call("/api/registration-payments/checkout", "POST", { student: crypto.randomUUID(), period: "2028-01", monthCount: own.count }, undefined, own.headers)).status, 403);
    for (const period of own.order.data.periods) assert.equal((await ledgerRow(f, pupil, period)).row.paid, 0);
    const cash = await f.call("/api/cashier/payments", "POST", intent(pupil, own.order.data.periods, own.count * 3500), f.admin);
    assert.equal(cash.status, 201, "A sandbox receipt does not settle the real monthly balance");
    for (const period of own.order.data.periods) {
      const { row, ledger } = await ledgerRow(f, pupil, period);
      assert.equal(row.cashPaid, 3500);
      assert.equal(row.onlinePaid, 0);
      assert.equal(row.paid, 3500);
      assert.equal(ledger.payments.some(saved => saved.id === payment[0].id), false);
    }
  }
});

test("Reçus groupés : répartition signée immuable et nettoyage intégral avec QR annulés", async t => {
  const f = await fixture(t, { sandbox: true });
  const pupil = await f.pupil("Élève fictif reçu original", { guardian: "Parent bundle privé", phone: "0100000000" });
  const witness = await f.pupil("Élève témoin conservé");
  await f.create("payments", { student: pupil.id, period: "2026-09", amount: 1000, date: "2026-10-14" });
  const cashRequest = intent(pupil, ["2026-11", "2026-07", "2026-09"], 9500);
  const cash = await f.call("/api/cashier/payments", "POST", cashRequest, f.admin);
  assert.equal(cash.status, 201);
  const witnessCash = await f.call("/api/cashier/payments", "POST", { requestId: crypto.randomUUID(), student: witness.id, period: "2026-10", amount: 250 }, f.admin);
  assert.equal(witnessCash.status, 201);
  const order = await f.call("/api/payments/checkout", "POST", { student: pupil.id, period: "2026-12", monthCount: 6 }, f.admin);
  assert.equal(order.status, 201);
  f.setVerified({ status: "SUCCESS", amount: order.data.amount, data: order.data.data });
  assert.equal((await f.call("/api/payments/confirm", "POST", { orderId: order.data.orderId, transactionId: "cleanup_bundle_fixture" }, f.admin)).status, 200);
  const payments = (await f.payments()).filter(payment => payment.student === pupil.id);
  assert.equal(payments.length, 3);
  const tokens = [];
  for (const payment of payments) {
    const pdf = await f.call("/api/payments/" + payment.id + "/receipt.pdf", "GET", undefined, f.admin);
    assert.equal(pdf.status, 200);
    tokens.push({ reference: payment.id, token: receiptToken(pdf.data) });
  }
  const cashToken = tokens.find(item => item.reference === cash.data.id).token;
  const original = await f.call("/api/receipts/verify", "POST", { token: cashToken, amount: 1, periods: ["2099-01"] });
  assert.equal(original.data.status, "verified");
  assert.equal(original.data.receipt.amount, 9500);
  assert.equal(original.data.receipt.period, "2026-07");
  assert.deepEqual(original.data.receipt.periods, cash.data.periods);
  assert.deepEqual(original.data.receipt.allocations, cash.data.allocations);
  assert.equal(original.data.receipt.studentName, pupil.name);
  assert.doesNotMatch(JSON.stringify(original.data), /Parent bundle privé|0100000000|guardian|phone|collectedBy|transactionId|orderId|token|issuedAt/);
  const changedPupil = { ...pupil, name: "Élève fictif nom changé", monthlyFee: 5000, guardian: "Autre parent privé" };
  assert.equal((await f.call("/api/records/students/" + pupil.id, "PUT", changedPupil, f.admin)).status, 200);
  assert.deepEqual((await f.call("/api/receipts/verify", "POST", { token: cashToken })).data, original.data);
  assert.equal(receiptToken((await f.call("/api/payments/" + cash.data.id + "/receipt.pdf", "GET", undefined, f.admin)).data), cashToken);
  for (const method of ["PUT", "DELETE"])
    assert.equal((await f.call("/api/records/payments/" + cash.data.id, method, method === "PUT" ? { amount: 1 } : undefined, f.admin)).status, 409);
  const altered = { ...cash.data, allocations: cash.data.allocations.map((allocation, index) => ({ ...allocation, amount: allocation.amount + (index === 0 ? -1 : index === 1 ? 1 : 0) })) };
  await f.db.prepare("UPDATE records SET payload=? WHERE kind='payments' AND id=?").run(JSON.stringify(altered), cash.data.id);
  assert.equal((await f.call("/api/receipts/verify", "POST", { token: cashToken })).status, 404, "Moving one franc between months invalidates the signed receipt");
  assert.equal((await f.call("/api/payments/" + cash.data.id + "/receipt.pdf", "GET", undefined, f.admin)).status, 409);
  await f.db.prepare("UPDATE records SET payload=? WHERE kind='payments' AND id=?").run(JSON.stringify(cash.data), cash.data.id);
  const preview = await f.call("/api/admin/students/" + pupil.id + "/deletion-preview", "GET", undefined, f.admin);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.canPurgeTest, true);
  assert.equal(preview.data.counts.payments, 3);
  assert.deepEqual(preview.data.amounts, { cash: 10500, online: 0, sandbox: 21000 });
  const purge = await f.call("/api/admin/students/" + pupil.id + "/purge-test", "POST", { currentPassword: password, confirmedFictitious: true, confirmation: changedPupil.name, fingerprint: preview.data.fingerprint }, f.admin);
  assert.equal(purge.status, 200, JSON.stringify(purge.data));
  assert.deepEqual(purge.data.amounts, preview.data.amounts);
  assert.equal((await f.payments()).some(payment => payment.student === pupil.id), false);
  assert.equal((await f.payments()).some(payment => payment.id === witnessCash.data.id), true);
  for (const { reference, token } of tokens) {
    assert.deepEqual((await f.call("/api/receipts/verify", "POST", { token })).data, { status: "cancelled", reference });
    assert.equal((await f.call("/api/payments/" + reference + "/receipt.pdf", "GET", undefined, f.admin)).status, 404);
    assert.equal(await f.db.prepare("SELECT value FROM settings WHERE key=?").get("receipt_snapshot:" + reference), undefined);
  }
  assert.equal((await f.call("/api/cashier/payments", "POST", cashRequest, f.admin)).status, 409, "A removed bundle cannot be recreated by a retry");
  assert.equal((await f.db.prepare("SELECT state FROM payment_orders WHERE id=?").get(order.data.orderId)).state, "purged");
  for (const period of [...cash.data.periods, ...order.data.periods]) {
    const ledger = await f.call("/api/cashier?period=" + period, "GET", undefined, f.admin);
    assert.deepEqual(ledger.data.totals, { cash: 0, online: 0 });
    assert.equal(ledger.data.payments.some(payment => payment.student === pupil.id), false);
  }
  await f.restart();
  assert.deepEqual((await f.call("/api/receipts/verify", "POST", { token: cashToken })).data, { status: "cancelled", reference: cash.data.id });
});

test("Migration : anciennes échéances sans répartition, paiements et sessions conservés, protections PostgreSQL maintenues", async t => {
  const f = await fixture(t, { sandbox: true });
  const pupil = await f.pupil("Élève ancien format");
  const legacy = await f.create("payments", { student: pupil.id, period: "2026-11", amount: 1000, date: "2026-10-14" });
  const legacyOrderId = crypto.randomUUID();
  await f.db.prepare("INSERT INTO payment_orders(id,student_id,period,amount,mode,state,created_at) VALUES(?,?,?,?,'sandbox','pending',?)").run(legacyOrderId, pupil.id, "2026-12", 3500, new Date().toISOString());
  await f.db.exec("ALTER TABLE payment_orders DROP COLUMN allocations");
  await f.restart();
  assert.equal((await f.call("/api/auth/me", "GET", undefined, f.admin)).status, 200);
  const orders = await f.call("/api/payments/orders", "GET", undefined, f.admin);
  assert.equal(orders.status, 200, JSON.stringify(orders.data));
  const oldOrder = orders.data.find(order => order.id === legacyOrderId);
  assert.deepEqual(oldOrder.periods, ["2026-12"]);
  assert.deepEqual(oldOrder.allocations, [{ period: "2026-12", amount: 3500 }]);
  assert.equal((await f.db.prepare("SELECT allocations FROM payment_orders WHERE id=?").get(legacyOrderId)).allocations, null);
  assert.equal((await ledgerRow(f, pupil, "2026-11")).row.paid, 1000);
  assert.deepEqual((await f.payments()).find(payment => payment.id === legacy.id), legacy);
  f.setVerified({ status: "SUCCESS", amount: 3500, data: { orderId: legacyOrderId } });
  assert.equal((await f.call("/api/payments/confirm", "POST", { orderId: legacyOrderId, transactionId: "legacy_bundle_migration_fixture" }, f.admin)).status, 200);
  const confirmed = (await f.payments()).find(payment => payment.orderId === legacyOrderId);
  assert.equal(confirmed.amount, 3500);
  assert.equal(confirmed.period, "2026-12");
  assert.equal(Object.hasOwn(confirmed, "periods"), false);
  assert.equal(Object.hasOwn(confirmed, "allocations"), false);
  const bundle = await f.call("/api/cashier/payments", "POST", intent(pupil, ["2026-11", "2026-12", "2027-01"], 9500), f.admin);
  assert.equal(bundle.status, 201);
  assert.deepEqual(bundle.data.allocations, [{ period: "2026-11", amount: 2500 }, { period: "2026-12", amount: 3500 }, { period: "2027-01", amount: 3500 }]);
  if (process.env.CRS_TEST_DATABASE_URL) {
    const tables = await f.db.prepare("SELECT relname,relrowsecurity FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relname IN ('settings','records','users','sessions','registration_access','payment_orders','request_limits')").all();
    assert.equal(tables.length, 7);
    assert.ok(tables.every(table => table.relrowsecurity === true));
  } else {
    assert.equal((await f.db.prepare("PRAGMA foreign_keys").get()).foreign_keys, 1);
    assert.equal(await f.db.prepare("PRAGMA foreign_key_check").get(), undefined);
  }
});
