"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { cashierLedger } = require("../lib/cashier");
const { createReceiptSnapshot, createReceiptToken, verifyReceiptToken, paymentMatchesSnapshot, publicReceiptSnapshot } = require("../lib/receipt-verification");

function bundledPayment(id, amounts, extra = {}) {
  const periods = ["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"].slice(0, amounts.length);
  return { id, student: "pupil", period: periods[0], periods, allocations: periods.map((period, index) => ({ period, amount: amounts[index] })), amount: amounts.reduce((sum, amount) => sum + amount, 0), date: "2026-09-30", ...extra };
}

test("La caisse répartit les paiements groupés entre les mois et garde une référence de reçu complète", () => {
  const cash = bundledPayment("cash-bundle", [2000, 3500, 1000], { source: "Caisse", channel: "cash" });
  const online = bundledPayment("online-bundle", [500, 1500, 4000], { source: "KKiaPay", mode: "live" });
  const legacy = { id: "legacy", student: "pupil", period: "2026-11", amount: 400 };
  const data = { students: [{ id: "pupil", monthlyFee: 5000 }], payments: [cash, online, legacy, { ...cash, id: "sandbox", mode: "sandbox" }] };
  const original = structuredClone(data);
  for (const [period, cashPaid, onlinePaid, balance] of [["2026-10", 2000, 500, 2500], ["2026-11", 3900, 1500, 0], ["2026-12", 1000, 4000, 0]]) {
    const ledger = cashierLedger(data, period);
    assert.deepEqual(ledger.totals, { cash: cashPaid, online: onlinePaid });
    assert.deepEqual([ledger.students[0].cashPaid, ledger.students[0].onlinePaid, ledger.students[0].paid, ledger.students[0].balance], [cashPaid, onlinePaid, cashPaid + onlinePaid, balance]);
    assert.equal(ledger.payments.filter((payment) => payment.id === cash.id).length, 1);
    assert.deepEqual(ledger.payments.find((payment) => payment.id === cash.id), cash, "Le paiement renvoyé conserve le même reçu et le montant total encaissé.");
    assert.ok(ledger.payments.every((payment) => payment.source !== "KKiaPay" && payment.mode !== "sandbox"));
  }
  assert.deepEqual(cashierLedger(data, "2027-01").payments, []);
  assert.deepEqual(cashierLedger(data, "2027-01").totals, { cash: 0, online: 0 });
  assert.deepEqual(data, original);
});

test("Un paiement de six mois couvre chaque solde une seule fois et bloque tous les mois d’un ordre en ligne en attente", () => {
  const payment = bundledPayment("six-months", [1000, 1000, 1000, 1000, 1000, 1000], { source: "Caisse" });
  const data = { students: [{ id: "pupil", monthlyFee: 1000 }], payments: [payment] };
  for (const period of payment.periods) {
    const ledger = cashierLedger(data, period);
    assert.equal(ledger.students[0].paid, 1000);
    assert.equal(ledger.students[0].balance, 0);
    assert.equal(ledger.totals.cash, 1000);
    assert.equal(ledger.payments[0].id, payment.id);
    assert.equal(ledger.payments[0].amount, 6000);
  }
  const pending = { student_id: "pupil", period: payment.period, periods: payment.periods, mode: "live", state: "pending" };
  assert.match(cashierLedger(data, "2027-02", [pending]).students[0].blockedReason, /ligne/);
  for (const order of [{ ...pending, mode: "sandbox" }, { ...pending, state: "paid" }, { ...pending, student_id: "other" }])
    assert.equal(cashierLedger(data, "2027-02", [order]).students[0].blockedReason, undefined);
  assert.equal(cashierLedger(data, "2027-04", [pending]).students[0].blockedReason, undefined);
  assert.match(cashierLedger(data, "2027-04", [{ student_id: "pupil", period: "2027-04", mode: "live", state: "pending" }]).students[0].blockedReason, /ligne/);
});

test("La vérification publique expose les allocations du reçu sans détails privés et signe leur contenu intégral", () => {
  const payment = bundledPayment("bundled-receipt", [2000, 3500, 1000], { source: "Caisse", channel: "cash", collectedBy: "private-user", collectedByName: "private-cashier", idempotencyKey: "private-operation" });
  const student = { name: "Élève Grâce", class: "6e", centre: "Centre École", guardian: "private-parent", phone: "private-phone" };
  const snapshot = createReceiptSnapshot({ payment, student, school: { name: "École de test", phones: ["private-school-phone"] } });
  const key = crypto.randomBytes(32).toString("base64url");
  const token = createReceiptToken(snapshot, key);
  assert.equal(verifyReceiptToken(token, snapshot, key), true);
  assert.equal(paymentMatchesSnapshot(payment, snapshot), true);
  assert.notEqual(snapshot.payment.allocations, payment.allocations);
  assert.notEqual(snapshot.payment.allocations[0], payment.allocations[0]);
  assert.equal(snapshot.student.guardian, student.guardian);
  const result = publicReceiptSnapshot({ ...snapshot, token });
  assert.deepEqual(result, { status: "verified", receipt: {
    reference: payment.id, studentName: student.name, class: student.class, centre: student.centre,
    amount: payment.amount, currency: "FCFA", date: payment.date, period: payment.period,
    periods: payment.periods, allocations: payment.allocations, channel: "cash", schoolName: "École de test",
  } });
  assert.doesNotMatch(JSON.stringify(result), /private-|guardian|phone|collectedBy|idempotencyKey|issuedAt|token/);
  assert.equal(publicReceiptSnapshot({ ...snapshot, payment: { ...snapshot.payment, mode: "sandbox" } }).status, "test");

  for (const change of [
    (altered) => { altered.allocations[0].amount += 100; altered.allocations[1].amount -= 100; },
    (altered) => { altered.allocations[1].period = "2027-01"; },
    (altered) => { altered.periods[1] = "2027-01"; },
  ]) {
    const altered = structuredClone(snapshot.payment);
    change(altered);
    assert.equal(altered.amount, payment.amount, "Le total reste inchangé lors d’une falsification de la répartition.");
    assert.equal(altered.period, payment.period);
    assert.equal(verifyReceiptToken(token, { ...snapshot, payment: altered }, key), false);
    assert.equal(paymentMatchesSnapshot(altered, snapshot), false);
  }
  const legacy = publicReceiptSnapshot(createReceiptSnapshot({ payment: { id: "legacy-receipt", student: "pupil", amount: 500, period: "2026-10" }, student }));
  assert.equal(Object.hasOwn(legacy.receipt, "periods"), false);
  assert.equal(Object.hasOwn(legacy.receipt, "allocations"), false);
});

test("Dix-huit mois disjoints restent intégralement répartis dans la caisse et dans la signature publique", () => {
  const periods = ["2026-11", "2027-01", "2027-03", "2027-05", "2027-07", "2027-09", "2027-11", "2028-01", "2028-03", "2028-05", "2028-07", "2028-09", "2028-11", "2029-01", "2029-03", "2029-05", "2029-07", "2029-09"];
  const allocations = periods.map((period, index) => ({ period, amount: index === 0 ? 2500 : 3500 }));
  const payment = { id: "eighteen-month-receipt", student: "pupil", period: periods[0], periods, allocations, amount: 62000, source: "Caisse", date: "2026-10-14" };
  const partial = { id: "partial", student: "pupil", period: periods[0], amount: 1000 };
  const data = { students: [{ id: "pupil", monthlyFee: 3500 }], payments: [partial, payment] };
  let received = 0;
  for (const period of periods) {
    const ledger = cashierLedger(data, period);
    assert.equal(ledger.students[0].paid, 3500);
    assert.equal(ledger.students[0].balance, 0);
    assert.equal(ledger.payments.filter(receipt => receipt.id === payment.id).length, 1);
    assert.equal(ledger.payments.find(receipt => receipt.id === payment.id).amount, 62000);
    received += ledger.totals.cash;
  }
  assert.equal(received, 63000);
  assert.deepEqual(cashierLedger(data, "2028-12").totals, { cash: 0, online: 0 });
  const snapshot = createReceiptSnapshot({ payment, student: { name: "Élève reçu long" } });
  const key = crypto.randomBytes(32).toString("base64url");
  const token = createReceiptToken(snapshot, key);
  assert.equal(verifyReceiptToken(token, snapshot, key), true);
  assert.deepEqual(publicReceiptSnapshot(snapshot).receipt.allocations, allocations);
  assert.deepEqual(publicReceiptSnapshot(snapshot).receipt.periods, periods);
  const changed = structuredClone(snapshot);
  changed.payment.allocations[0].amount += 1;
  changed.payment.allocations.at(-1).amount -= 1;
  assert.equal(changed.payment.amount, snapshot.payment.amount);
  assert.equal(verifyReceiptToken(token, changed, key), false);
  assert.equal(paymentMatchesSnapshot(changed.payment, snapshot), false);
});
