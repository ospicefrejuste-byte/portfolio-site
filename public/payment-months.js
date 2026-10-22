"use strict";
(() => {
  const valid = value => typeof value === "string" && /^20\d{2}-(0[1-9]|1[0-2])$/.test(value);
  function allocations(payment) {
    if (!payment || typeof payment !== "object") return [];
    if (payment.allocations !== undefined && payment.allocations !== null) {
      const rows = payment.allocations;
      if (!Array.isArray(rows) || !rows.length || rows.length > 1200 || rows.some(row => !row || !valid(row.period) || !Number.isSafeInteger(Number(row.amount)) || Number(row.amount) < 0) || new Set(rows.map(row => row.period)).size !== rows.length) return [];
      const result = rows.map(row => ({ period: row.period, amount: Number(row.amount) })).sort((a, b) => a.period.localeCompare(b.period));
      const total = result.reduce((sum, row) => sum + row.amount, 0);
      return Number.isSafeInteger(total) && total === Number(payment.amount) ? result : [];
    }
    if (!valid(payment.period)) return [];
    const amount = Number(payment.amount);
    return [{ period: payment.period, amount: Number.isSafeInteger(amount) && amount >= 0 ? amount : 0 }];
  }
  function periods(start, count) {
    if (!valid(start) || !["number", "string"].includes(typeof count) || !Number.isInteger(Number(count)) || Number(count) < 1 || Number(count) > 1200) return [];
    const [year, month] = start.split("-").map(Number);
    const result = [];
    for (let index = 0; index < Number(count); index++) {
      const serial = year * 12 + month - 1 + index;
      const period = `${Math.floor(serial / 12)}-${String(serial % 12 + 1).padStart(2, "0")}`;
      if (!valid(period)) return [];
      result.push(period);
    }
    return result;
  }
  function label(period) {
    if (!valid(period)) return String(period || "");
    const [year, month] = period.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("fr-FR", { timeZone: "UTC", month: "long", year: "numeric" });
  }
  window.paymentMonths = { allocations, amountFor: (payment, period) => allocations(payment).filter(row => row.period === period).reduce((sum, row) => sum + row.amount, 0), periods, label, labels: payment => allocations(payment).map(row => label(row.period)) };
})();
