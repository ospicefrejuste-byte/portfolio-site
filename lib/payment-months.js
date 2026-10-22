"use strict";
const fail = message => Object.assign(new Error(message), { status: 400 });
const validPeriod = value => typeof value === "string" && /^20\d{2}-(0[1-9]|1[0-2])$/.test(value);
const MAX_PERIODS = 1200;
const MAX_PAYMENT_AMOUNT = 100000000;
function consecutivePeriods(start, count) {
  if (!validPeriod(start) || !Number.isInteger(count) || count < 1 || count > MAX_PERIODS) throw fail("Choisissez un mois de départ et un nombre entier de mois valide.");
  const [year, month] = start.split("-").map(Number);
  const result = [];
  for (let index = 0; index < count; index++) {
    const serial = year * 12 + month - 1 + index;
    const period = `${Math.floor(serial / 12)}-${String(serial % 12 + 1).padStart(2, "0")}`;
    if (!validPeriod(period)) throw fail("Les mois choisis dépassent la période autorisée.");
    result.push(period);
  }
  return result;
}
function rollingPeriods(start, count = 12) {
  if (!validPeriod(start) || !Number.isInteger(count) || count < 1 || count > MAX_PERIODS) throw fail("Choisissez un mois de départ et un nombre entier de mois valide.");
  const [year, month] = start.split("-").map(Number);
  return consecutivePeriods(start, Math.min(count, (2100 - year) * 12 - month + 1));
}
function selectedPeriods(body) {
  if (!body || typeof body !== "object") throw fail("Choisissez les mois à régler.");
  if (body.periods !== undefined) {
    if (!Array.isArray(body.periods) || body.periods.length < 1 || body.periods.length > MAX_PERIODS || body.periods.some(period => !validPeriod(period)) || new Set(body.periods).size !== body.periods.length)
      throw fail("Sélectionnez des mois distincts entre janvier 2000 et décembre 2099, au format AAAA-MM.");
    return [...body.periods].sort();
  }
  if (body.monthCount !== undefined && !["number", "string"].includes(typeof body.monthCount)) throw fail("Choisissez un nombre entier de mois valide.");
  const count = body.monthCount === undefined ? 1 : Number(body.monthCount);
  if (!Number.isInteger(count) || count < 1 || count > MAX_PERIODS) throw fail("Choisissez un nombre entier de mois valide.");
  return consecutivePeriods(body.period, count);
}
function paymentAllocations(payment) {
  if (!payment || typeof payment !== "object") return [];
  if (payment.allocations !== undefined && payment.allocations !== null) {
    const rows = payment.allocations;
    if (!Array.isArray(rows) || !rows.length || rows.length > MAX_PERIODS || rows.some(row => !row || !validPeriod(row.period) || !Number.isSafeInteger(Number(row.amount)) || Number(row.amount) < 0) || new Set(rows.map(row => row.period)).size !== rows.length) return [];
    const allocations = rows.map(row => ({ period: row.period, amount: Number(row.amount) })).sort((a, b) => a.period.localeCompare(b.period));
    const total = allocations.reduce((sum, row) => sum + row.amount, 0);
    if (!Number.isSafeInteger(total) || total !== Number(payment.amount)) return [];
    return allocations;
  }
  if (!validPeriod(payment.period)) return [];
  const amount = Number(payment.amount);
  return [{ period: payment.period, amount: Number.isSafeInteger(amount) && amount >= 0 ? amount : 0 }];
}
const paymentAmountFor = (payment, period) => paymentAllocations(payment).filter(row => row.period === period).reduce((sum, row) => sum + row.amount, 0);
module.exports = { MAX_PERIODS, MAX_PAYMENT_AMOUNT, validPeriod, consecutivePeriods, rollingPeriods, selectedPeriods, paymentAllocations, paymentAmountFor };
