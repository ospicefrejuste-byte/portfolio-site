"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApplication } = require("../lib/application");

const password = "Free-months-fixture-password-123!";

async function fixture(t, { sandbox = false, configured = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "crs-free-months-"));
  const savedEnvironment = {};
  if (!configured) {
    for (const key of ["KKIAPAY_PUBLIC_KEY", "KKIAPAY_PRIVATE_KEY", "KKIAPAY_SECRET_KEY"]) {
      savedEnvironment[key] = process.env[key];
      delete process.env[key];
    }
  }
  let verified = { status: "FAILED" };
  const verificationCalls = [];
  const instance = await createApplication({
    dataDir, setupToken: "free-months-fixture-setup", publicOrigin: "https://receipts.example.test",
    paymentConfig: { sandbox, ...(configured ? { publicKey: "fixture-public", privateKey: "fixture-private", secretKey: "fixture-secret" } : {}) },
    verifyTransaction: async transactionId => { verificationCalls.push(transactionId); return verified; },
  });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await instance.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const base = "http://127.0.0.1:" + server.address().port;
  async function call(route, method = "GET", body, session, headers = {}) {
    const response = await fetch(base + route, {
      method, redirect: "manual",
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(session ? { Cookie: session.cookie, "X-CSRF-Token": session.csrf } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = response.headers.get("content-type")?.includes("application/json") ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, data, cookie: response.headers.get("set-cookie")?.split(";")[0], csrf: data.csrf };
  }
  const admin = await call("/api/auth/setup", "POST", { username: "free-months-admin", password, token: "free-months-fixture-setup" });
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
    const username = "free-months-" + role;
    const created = await call("/api/admin/users", "POST", { username, role, entityId, password }, admin);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const logged = await call("/api/auth/login", "POST", { username, password, ...(role === "cashier" ? { space: "cashier" } : {}) });
    assert.equal(logged.status, 200, JSON.stringify(logged.data));
    const changed = await call("/api/auth/password", "POST", { currentPassword: password, password: "Personal-" + username + "-123!" }, logged);
    assert.equal(changed.status, 200, JSON.stringify(changed.data));
    return changed;
  }
  async function payments() { return (await call("/api/data", "GET", undefined, admin)).data.payments; }
  async function ledger(pupil, period) {
    const result = await call("/api/cashier?period=" + period, "GET", undefined, admin);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return { ...result.data, row: result.data.students.find(student => student.id === pupil.id) };
  }
  return { call, admin, school, create, pupil, account, payments, ledger, db: instance.db, verificationCalls, setVerified: value => { verified = value; } };
}

function periodsFrom(start, count, step = 1) {
  const [year, month] = start.split("-").map(Number);
  return Array.from({ length: count }, (_, index) => {
    const serial = year * 12 + month - 1 + index * step;
    return `${Math.floor(serial / 12)}-${String(serial % 12 + 1).padStart(2, "0")}`;
  });
}
function cashIntent(pupil, periods, amount) { return { requestId: crypto.randomUUID(), student: pupil.id, periods, amount }; }
function assertMinimalQuote(quote, pupil, start, mode = "live") {
  assert.deepEqual(Object.keys(quote).sort(), ["mode", "months", "start", "student"]);
  assert.deepEqual(quote.student, { id: pupil.id, name: pupil.name, class: pupil.class, centre: pupil.centre, registrationStatus: pupil.registrationStatus });
  assert.equal(quote.start, start);
  assert.equal(quote.mode, mode);
  assert.doesNotMatch(JSON.stringify(quote), /guardian|phone|transactionId|orderId|collectedBy|private-|password|token/);
}
function receiptToken(pdf) {
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  const links = [...pdf.toString("latin1").matchAll(/\/URI\s*\(([^)]*)\)/g)].map(match => match[1].replace(/\\([\\()])/g, "$1"));
  const link = links.find(value => value.includes("/verification-recu.html#"));
  assert.ok(link, "The receipt includes a signed verification link");
  return new URL(link).hash.slice(1);
}

test("Mois libres en caisse : 2, 4, 7 et 18 mois disjoints, soldes exacts et recettes réparties une seule fois", async t => {
  const f = await fixture(t);
  for (const count of [2, 4, 7, 18]) {
    const pupil = await f.pupil("Élève sélection libre " + count);
    const start = `${2028 + count * 2}-11`;
    const periods = periodsFrom(start, count, 2);
    await f.create("payments", { student: pupil.id, period: periods[0], amount: 1000, date: "2026-10-14" });
    const amount = count * 3500 - 1000;
    for (const wrongAmount of [amount - 1, amount + 1]) {
      const invalid = await f.call("/api/cashier/payments", "POST", cashIntent(pupil, periods, wrongAmount), f.admin);
      assert.equal(invalid.status, 409, JSON.stringify(invalid.data));
    }
    const result = await f.call("/api/cashier/payments", "POST", cashIntent(pupil, [...periods].reverse(), amount), f.admin);
    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.equal(result.data.amount, amount);
    assert.equal(result.data.period, periods[0]);
    assert.deepEqual(result.data.periods, periods);
    assert.deepEqual(result.data.allocations, periods.map((period, index) => ({ period, amount: index === 0 ? 2500 : 3500 })));
    let income = 0;
    for (const period of periods) {
      const ledger = await f.ledger(pupil, period);
      assert.deepEqual([ledger.row.paid, ledger.row.balance, ledger.row.status], [3500, 0, "Payé"]);
      assert.deepEqual(ledger.totals, { cash: 3500, online: 0 });
      assert.equal(ledger.payments.filter(payment => payment.id === result.data.id).length, 1);
      income += ledger.totals.cash;
    }
    assert.equal(income, amount + 1000);
    assert.equal((await f.ledger(pupil, `${2028 + count * 2}-12`)).row.paid, 0, "An unselected gap remains unpaid");
    assert.equal((await f.payments()).filter(payment => payment.student === pupil.id).length, 2);
  }
  assert.equal(f.verificationCalls.length, 0);
});

test("Mois libres en ligne : durées 2, 4, 7 et 18, devis figé et confirmations concurrentes sans double recette", async t => {
  const f = await fixture(t);
  for (const count of [2, 4, 7, 18]) {
    const pupil = await f.pupil("Élève durée libre " + count);
    const periods = periodsFrom(`${2035 + count * 2}-11`, count);
    await f.create("payments", { student: pupil.id, period: periods[0], amount: 1000, date: "2026-10-14" });
    const order = await f.call("/api/payments/checkout", "POST", { student: pupil.id, period: periods[0], monthCount: count, amount: 1 }, f.admin);
    assert.equal(order.status, 201, JSON.stringify(order.data));
    assert.equal(order.data.amount, count * 3500 - 1000);
    assert.deepEqual(order.data.periods, periods);
    assert.deepEqual(order.data.allocations, periods.map((period, index) => ({ period, amount: index === 0 ? 2500 : 3500 })));
    const resumed = await f.call("/api/payments/checkout", "POST", { student: pupil.id, periods: [...periods].reverse() }, f.admin);
    assert.equal(resumed.status, 201, JSON.stringify(resumed.data));
    assert.equal(resumed.data.orderId, order.data.orderId);
    if (count === 18) assert.equal((await f.call("/api/records/students/" + pupil.id, "PUT", { ...pupil, monthlyFee: 5000 }, f.admin)).status, 200);
    const confirmation = { orderId: order.data.orderId, transactionId: "free_months_live_" + count };
    f.setVerified({ status: "SUCCESS", amount: order.data.amount - 1, data: order.data.data });
    assert.equal((await f.call("/api/payments/confirm", "POST", confirmation, f.admin)).status, 409);
    f.setVerified({ status: "SUCCESS", amount: order.data.amount, data: order.data.data });
    const confirmed = await Promise.all([1, 2].map(() => f.call("/api/payments/confirm", "POST", confirmation, f.admin)));
    assert.ok(confirmed.every(result => result.status === 200), JSON.stringify(confirmed));
    assert.equal(confirmed.filter(result => result.data.alreadyConfirmed === true).length, 1);
    assert.equal((await f.call("/api/payments/webhook", "POST", { transactionId: confirmation.transactionId })).status, 200);
    const payments = (await f.payments()).filter(payment => payment.orderId === order.data.orderId);
    assert.equal(payments.length, 1);
    assert.deepEqual(payments[0].allocations, order.data.allocations);
    assert.equal(payments[0].amount, order.data.amount);
    let received = 0;
    for (const [index, period] of periods.entries()) {
      const ledger = await f.ledger(pupil, period);
      assert.equal(ledger.row.onlinePaid, index === 0 ? 2500 : 3500);
      assert.equal(ledger.row.paid, 3500);
      received += ledger.totals.online;
    }
    assert.equal(received, order.data.amount);
    assert.equal((await f.call("/api/payments/checkout", "POST", { student: pupil.id, periods: [`${2035 + count * 2}-10`, periods.at(-1)] }, f.admin)).status, 409);
  }
});

test("Devis en lecture seule : périmètre élève, confidentialité, soldes réels sans prestataire et bornes de calendrier", async t => {
  const f = await fixture(t, { configured: false, sandbox: true });
  const pupil = await f.pupil("Élève devis privé", { guardian: "private-parent", phone: "0100000000" });
  const other = await f.pupil("Élève dossier tiers");
  const teacher = await f.create("teachers", { name: "Enseignant devis interdit", subject: "Mathématiques" });
  const student = await f.account("student", pupil.id);
  const cashier = await f.account("cashier");
  const teacherSession = await f.account("teacher", teacher.id);
  await f.create("payments", { student: pupil.id, period: "2026-11", amount: 3500, date: "2026-10-14" });
  await f.create("payments", { student: pupil.id, period: "2026-12", amount: 1000, date: "2026-10-14" });
  const before = await f.payments();
  const settingsBefore = await f.db.prepare("SELECT key,value FROM settings ORDER BY key").all();
  const route = `/api/payments/months?student=${pupil.id}&start=2026-11`;
  assert.equal((await f.call(route)).status, 401);
  for (const forbidden of [cashier, teacherSession]) assert.equal((await f.call(route, "GET", undefined, forbidden)).status, 403);
  assert.equal((await f.call(`/api/payments/months?student=${other.id}&start=2026-11`, "GET", undefined, student)).status, 403);
  for (const session of [f.admin, student]) {
    const quote = await f.call(route, "GET", undefined, session);
    assert.equal(quote.status, 200, JSON.stringify(quote.data));
    assertMinimalQuote(quote.data, pupil, "2026-11");
    assert.deepEqual(quote.data.months.map(month => month.period), periodsFrom("2026-11", 12));
    assert.deepEqual(quote.data.months.slice(0, 3).map(({ paid, balance, status }) => ({ paid, balance, status })), [
      { paid: 3500, balance: 0, status: "Payé" }, { paid: 1000, balance: 2500, status: "Partiel" }, { paid: 0, balance: 3500, status: "À payer" },
    ]);
  }
  assert.equal((await f.call("/api/payments/months?start=2026-11", "GET", undefined, student)).data.student.id, pupil.id);
  for (const start of ["2000-01", "2099-11", "2099-12"]) {
    for (const endpoint of [`/api/payments/months?student=${pupil.id}&start=${start}`, `/api/cashier/students/${pupil.id}/months?start=${start}`]) {
      const quote = await f.call(endpoint, "GET", undefined, f.admin);
      assert.equal(quote.status, 200, JSON.stringify(quote.data));
      assert.equal(quote.data.months.length, start === "2099-12" ? 1 : start === "2099-11" ? 2 : 12);
      assert.ok(quote.data.months.every(month => month.period >= "2000-01" && month.period <= "2099-12"));
    }
  }
  for (const start of ["1999-12", "2100-01", "2026-00", "2026-13", "2026-1", ""]) assert.equal((await f.call(`/api/payments/months?student=${pupil.id}&start=${start}`, "GET", undefined, f.admin)).status, 400);
  assert.equal((await f.call(`/api/payments/months?student=${crypto.randomUUID()}&start=2026-11`, "GET", undefined, f.admin)).status, 404);
  assert.deepEqual(await f.payments(), before);
  assert.deepEqual(await f.db.prepare("SELECT key,value FROM settings ORDER BY key").all(), settingsBefore);
  assert.deepEqual((await f.call("/api/payments/orders", "GET", undefined, f.admin)).data, []);
  assert.equal(f.verificationCalls.length, 0, "Reading paid states never verifies or creates a provider payment");
});

test("Préinscription : devis et 18 mois disjoints réservés au jeton propriétaire, soldes de test séparés de la caisse", async t => {
  const f = await fixture(t, { sandbox: true });
  async function register(name) {
    const result = await f.call("/api/registrations", "POST", { name, guardian: "private-public-parent", phone: "0100000000", class: "6e", centre: f.school.centres[0], subjects: ["Mathématiques"], consent: true });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return { result, headers: { Authorization: "Bearer " + result.data.paymentToken } };
  }
  const own = await register("Préinscription mois libres");
  const other = await register("Préinscription dossier tiers");
  const route = "/api/registration-payments/months?start=2028-11";
  assert.equal((await f.call(route)).status, 401);
  assert.equal((await f.call(route, "GET", undefined, undefined, { Authorization: "Bearer invalid" })).status, 401);
  const quote = await f.call(route, "GET", undefined, undefined, own.headers);
  assert.equal(quote.status, 200, JSON.stringify(quote.data));
  const data = (await f.call("/api/data", "GET", undefined, f.admin)).data;
  const pupil = data.students.find(student => student.id === quote.data.student.id);
  assertMinimalQuote(quote.data, pupil, "2028-11", "sandbox");
  assert.equal((await f.call(route + "&student=" + pupil.id, "GET", undefined, undefined, other.headers)).status, 403);
  const periods = periodsFrom("2028-11", 18, 2);
  const cash = await f.call("/api/cashier/payments", "POST", { requestId: crypto.randomUUID(), student: pupil.id, period: periods[0], amount: 1000 }, f.admin);
  assert.equal(cash.status, 201);
  const testQuote = await f.call(route, "GET", undefined, undefined, own.headers);
  assert.deepEqual([testQuote.data.mode, testQuote.data.months[0].paid, testQuote.data.months[0].balance], ["sandbox", 0, 3500]);
  const order = await f.call("/api/registration-payments/checkout", "POST", { periods: [...periods].reverse(), amount: 1 }, undefined, own.headers);
  assert.equal(order.status, 201, JSON.stringify(order.data));
  assert.equal(order.data.amount, 18 * 3500);
  assert.deepEqual(order.data.periods, periods);
  f.setVerified({ status: "SUCCESS", amount: order.data.amount, data: order.data.data });
  const confirmation = { orderId: order.data.orderId, transactionId: "free_months_public_18" };
  assert.equal((await f.call("/api/registration-payments/confirm", "POST", confirmation, undefined, other.headers)).status, 403);
  assert.equal(f.verificationCalls.length, 0);
  assert.equal((await f.call("/api/registration-payments/confirm", "POST", confirmation, undefined, own.headers)).status, 200);
  const paidQuote = await f.call(route, "GET", undefined, undefined, own.headers);
  assert.deepEqual([paidQuote.data.mode, paidQuote.data.months[0].paid, paidQuote.data.months[0].balance, paidQuote.data.months[0].status], ["sandbox", 3500, 0, "Payé"]);
  const adminQuote = await f.call(`/api/payments/months?student=${pupil.id}&start=2028-11`, "GET", undefined, f.admin);
  assert.deepEqual(adminQuote.data, paidQuote.data);
  assert.equal((await f.ledger(pupil, periods[0])).row.paid, 1000);
  assert.equal((await f.ledger(pupil, periods.at(-1))).row.paid, 0);
  const receipt = await f.call("/api/registration-payments/receipt.pdf?orderId=" + order.data.orderId, "GET", undefined, undefined, own.headers);
  assert.equal(receipt.status, 200);
  const verified = await f.call("/api/receipts/verify", "POST", { token: receiptToken(receipt.data) });
  assert.equal(verified.data.status, "test");
  assert.deepEqual(verified.data.receipt.periods, periods);
  assert.deepEqual(verified.data.receipt.allocations, order.data.allocations);
  assert.doesNotMatch(JSON.stringify(verified.data), /guardian|phone|transactionId|orderId|token|private-/);
});

test("Mois libres : entrées invalides, plafond monétaire et durée maximale de 1200 mois sans écritures partielles", async t => {
  const f = await fixture(t);
  const pupil = await f.pupil("Élève bornes");
  for (const periods of [[], ["2026-11", "2026-11"], ["2026-13"], ["1999-12"], ["2100-01"], ["2026-1"], [null], "2026-11", periodsFrom("2000-01", 1201)]) {
    assert.equal((await f.call("/api/cashier/payments", "POST", cashIntent(pupil, periods, 7000), f.admin)).status, 400, JSON.stringify(periods).slice(0, 100));
    assert.equal((await f.call("/api/payments/checkout", "POST", { student: pupil.id, periods }, f.admin)).status, 400);
  }
  for (const monthCount of [0, -1, 1.5, 1201, null]) assert.equal((await f.call("/api/payments/checkout", "POST", { student: pupil.id, period: "2000-01", monthCount }, f.admin)).status, 400);
  assert.equal((await f.call("/api/payments/checkout", "POST", { student: pupil.id, period: "2099-12", monthCount: 2 }, f.admin)).status, 400);
  for (const amount of [0, -1, 0.5, null, "not-money", 100000001]) assert.equal((await f.call("/api/cashier/payments", "POST", cashIntent(pupil, ["2026-11", "2026-12"], amount), f.admin)).status, 400);
  const expensive = await f.pupil("Élève plafond", { monthlyFee: 1000000 });
  const tooExpensive = periodsFrom("2040-01", 101);
  assert.equal((await f.call("/api/payments/checkout", "POST", { student: expensive.id, periods: tooExpensive }, f.admin)).status, 400);
  assert.equal((await f.call("/api/cashier/payments", "POST", cashIntent(expensive, tooExpensive, 101000000), f.admin)).status, 400);
  assert.deepEqual(await f.payments(), []);
  assert.deepEqual((await f.call("/api/payments/orders", "GET", undefined, f.admin)).data, []);
  const fullRange = periodsFrom("2000-01", 1200);
  const order = await f.call("/api/payments/checkout", "POST", { student: pupil.id, period: "2000-01", monthCount: 1200 }, f.admin);
  assert.equal(order.status, 201, JSON.stringify(order.data));
  assert.deepEqual(order.data.periods, fullRange);
  assert.equal(order.data.amount, 1200 * 3500);
  const cashPupil = await f.pupil("Élève siècle en caisse", { monthlyFee: 1 });
  const cash = await f.call("/api/cashier/payments", "POST", cashIntent(cashPupil, [...fullRange].reverse(), 1200), f.admin);
  assert.equal(cash.status, 201, JSON.stringify(cash.data));
  assert.deepEqual(cash.data.periods, fullRange);
  assert.equal(cash.data.allocations.length, 1200);
  assert.equal((await f.ledger(cashPupil, "2099-12")).row.paid, 1);
});

test("Mois libres concurrents : reprise du même UUID et un seul gagnant pour deux encaissements qui se chevauchent", async t => {
  const f = await fixture(t);
  const periods = periodsFrom("2045-11", 18, 2);
  const pupil = await f.pupil("Élève reprise UUID");
  const request = cashIntent(pupil, periods, periods.length * 3500);
  const repeated = await Promise.all([
    f.call("/api/cashier/payments", "POST", request, f.admin),
    f.call("/api/cashier/payments", "POST", { ...request, periods: [...periods].reverse() }, f.admin),
  ]);
  assert.deepEqual(repeated.map(result => result.status).sort(), [200, 201]);
  assert.deepEqual(repeated[0].data, repeated[1].data);
  assert.equal((await f.payments()).filter(payment => payment.student === pupil.id).length, 1);
  const contested = await f.pupil("Élève UUID concurrents");
  const alternatives = [periods, ["2045-10", ...periods.slice(1)]];
  const results = await Promise.all(alternatives.map(selected => f.call("/api/cashier/payments", "POST", cashIntent(contested, selected, selected.length * 3500), f.admin)));
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409], JSON.stringify(results));
  const winner = results.find(result => result.status === 201).data;
  const losingOnly = winner.periods.includes("2045-10") ? "2045-11" : "2045-10";
  assert.equal((await f.ledger(contested, losingOnly)).row.paid, 0, "The rejected bundle leaves no partial payment behind");
  assert.equal((await f.payments()).filter(payment => payment.student === contested.id).length, 1);
  const pendingPupil = await f.pupil("Élève chevauchement en ligne");
  const pending = await f.call("/api/payments/checkout", "POST", { student: pendingPupil.id, periods }, f.admin);
  assert.equal(pending.status, 201);
  const resumed = await f.call("/api/payments/checkout", "POST", { student: pendingPupil.id, periods: [...periods].reverse() }, f.admin);
  assert.equal(resumed.data.orderId, pending.data.orderId);
  assert.equal((await f.call("/api/payments/checkout", "POST", { student: pendingPupil.id, periods: ["2045-10", periods.at(-1)] }, f.admin)).status, 409);
  assert.equal((await f.call("/api/cashier/payments", "POST", cashIntent(pendingPupil, ["2045-10", periods.at(-1)], 7000), f.admin)).status, 409);
  for (const period of periods) assert.match((await f.ledger(pendingPupil, period)).row.blockedReason, /ligne/);
  const quote = await f.call(`/api/payments/months?student=${pendingPupil.id}&start=${periods.at(-1)}`, "GET", undefined, f.admin);
  assert.match(quote.data.months[0].blockedReason, /ligne/);
  assert.equal((await f.payments()).some(payment => payment.student === pendingPupil.id), false);
});

test("Reçu de 18 mois : toutes les allocations sont signées, l’ancien code reste stable et l’annulation est isolée au dossier fictif", async t => {
  const f = await fixture(t);
  const pupil = await f.pupil("Élève fictif reçu long", { guardian: "private-parent", phone: "0100000000" });
  const witness = await f.pupil("Élève témoin reçu conservé");
  const legacy = await f.create("payments", { student: witness.id, period: "2026-10", amount: 500, date: "2026-10-14" });
  const legacyPdf = await f.call("/api/payments/" + legacy.id + "/receipt.pdf", "GET", undefined, f.admin);
  assert.equal(legacyPdf.status, 200);
  const legacyToken = receiptToken(legacyPdf.data);
  const periods = periodsFrom("2050-11", 18, 2);
  const payment = await f.call("/api/cashier/payments", "POST", cashIntent(pupil, [...periods].reverse(), 18 * 3500), f.admin);
  assert.equal(payment.status, 201);
  const pdf = await f.call("/api/payments/" + payment.data.id + "/receipt.pdf", "GET", undefined, f.admin);
  assert.equal(pdf.status, 200);
  const token = receiptToken(pdf.data);
  const original = await f.call("/api/receipts/verify", "POST", { token });
  assert.equal(original.data.status, "verified");
  assert.deepEqual(original.data.receipt.periods, periods);
  assert.deepEqual(original.data.receipt.allocations, payment.data.allocations);
  assert.equal(original.data.receipt.amount, 18 * 3500);
  assert.doesNotMatch(JSON.stringify(original.data), /guardian|phone|collectedBy|transactionId|orderId|token|private-/);
  const changed = { ...pupil, name: "Élève fictif reçu renommé", monthlyFee: 5000 };
  assert.equal((await f.call("/api/records/students/" + pupil.id, "PUT", changed, f.admin)).status, 200);
  assert.deepEqual((await f.call("/api/receipts/verify", "POST", { token })).data, original.data);
  assert.equal(receiptToken((await f.call("/api/payments/" + payment.data.id + "/receipt.pdf", "GET", undefined, f.admin)).data), token);
  const tampered = structuredClone(payment.data);
  tampered.allocations[0].amount += 1;
  tampered.allocations.at(-1).amount -= 1;
  await f.db.prepare("UPDATE records SET payload=? WHERE kind='payments' AND id=?").run(JSON.stringify(tampered), payment.data.id);
  assert.equal((await f.call("/api/receipts/verify", "POST", { token })).status, 404, "The last allocation is signed even though the total is unchanged");
  await f.db.prepare("UPDATE records SET payload=? WHERE kind='payments' AND id=?").run(JSON.stringify(payment.data), payment.data.id);
  const preview = await f.call("/api/admin/students/" + pupil.id + "/deletion-preview", "GET", undefined, f.admin);
  assert.equal(preview.status, 200);
  const removed = await f.call("/api/admin/students/" + pupil.id + "/purge-test", "POST", { currentPassword: password, confirmedFictitious: true, confirmation: changed.name, fingerprint: preview.data.fingerprint }, f.admin);
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.deepEqual((await f.call("/api/receipts/verify", "POST", { token })).data, { status: "cancelled", reference: payment.data.id });
  const retained = await f.call("/api/receipts/verify", "POST", { token: legacyToken });
  assert.equal(retained.data.status, "verified");
  assert.equal(Object.hasOwn(retained.data.receipt, "allocations"), false);
  assert.equal((await f.payments()).some(saved => saved.id === legacy.id), true);
});
