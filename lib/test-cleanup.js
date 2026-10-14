"use strict";
const crypto = require("node:crypto");
const { canonical } = require("./receipt-verification");
const studentRemovalKey = id => "removed_student:" + id;
const paymentRemovalKey = id => "removed_payment:" + id;
const relatedKinds = ["payments", "grades", "attendance", "dailyAttendance"];
function prepareTestCleanup({ data, id, accounts = [], orders = [] }) {
  const student = data.students.find(item => item.id === id);
  if (!student) throw Object.assign(new Error("Dossier élève introuvable."), { status: 404 });
  const records = Object.fromEntries(relatedKinds.map(kind => [kind, (data[kind] || []).filter(item => item.student === id).sort((a, b) => a.id.localeCompare(b.id))]));
  const counts = Object.fromEntries(relatedKinds.map(kind => [kind, records[kind].length]));
  counts.accounts = accounts.length;
  counts.orders = orders.length;
  const amounts = { cash: 0, online: 0, sandbox: 0 };
  for (const payment of records.payments) {
    const channel = payment.mode === "sandbox" ? "sandbox" : payment.source === "KKiaPay" ? "online" : "cash";
    amounts[channel] += Math.max(0, Number(payment.amount) || 0);
  }
  let reason = "";
  if (records.payments.some(payment => payment.source === "KKiaPay" && payment.mode !== "sandbox") || orders.some(order => order.mode !== "sandbox"))
    reason = "Ce dossier possède un paiement ou une échéance en ligne en mode réel. Conservez l’historique et suspendez l’inscription si nécessaire.";
  else if (accounts.some(account => account.role !== "student"))
    reason = "Un compte du personnel est lié à ce dossier. Le nettoyage ne peut pas le supprimer.";
  const fingerprint = crypto.createHash("sha256").update(canonical({ student, records, accounts: [...accounts].sort((a, b) => a.id.localeCompare(b.id)), orders: [...orders].sort((a, b) => a.id.localeCompare(b.id)) })).digest("hex");
  return { records, accounts, orders, preview: { student: { id, name: student.name, class: student.class || "", centre: student.centre || "" }, fingerprint, canPurgeTest: !reason, reason, counts, amounts } };
}
module.exports = { prepareTestCleanup, studentRemovalKey, paymentRemovalKey };
