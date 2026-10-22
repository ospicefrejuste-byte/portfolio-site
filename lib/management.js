"use strict";

const { paymentAmountFor } = require("./payment-months");

/** Monthly tuition follows the month owed, independently of the receipt date. */
function calculateMonthlyBalances(data, period) {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(String(period || "")))
    throw new RangeError("Le mois doit être au format AAAA-MM.");
  const received = new Map();
  for (const payment of data?.payments || []) {
    if (payment.mode === "sandbox") continue;
    received.set(payment.student, (received.get(payment.student) || 0) + amount(paymentAmountFor(payment, period)));
  }
  return (data?.students || []).map((student) => {
    const registrationStatus = student.registrationStatus || "Inscrit";
    const fee = registrationStatus === "Inscrit" ? amount(student.monthlyFee) : 0;
    const paid = received.get(student.id) || 0;
    const balance = Math.max(fee - paid, 0);
    const advance = Math.max(paid - fee, 0);
    const status = fee === 0 ? "Non facturé"
      : advance > 0 ? "Avance"
        : balance === 0 ? "Réglé"
          : paid > 0 ? "Partiel" : "À régler";
    return {
      student: student.id,
      name: student.name || "",
      class: student.class || "",
      centre: student.centre || "",
      group: student.group || "",
      guardian: student.guardian || "",
      phone: student.phone || "",
      registrationStatus, fee, paid, balance, advance, status,
    };
  });
}

function amount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

module.exports = { calculateMonthlyBalances };
