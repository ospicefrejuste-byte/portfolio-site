"use strict";

const { paymentAllocations, paymentAmountFor } = require("./payment-months");

// SQLite cannot extend a CHECK constraint in place. Keep the original table
// name and restore foreign-key enforcement without deleting existing sessions.
function migrateSqliteCashierUsers(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (!table || table.sql.includes("'cashier'")) return;
  db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;");
  try {
    db.exec(`CREATE TABLE users_cashier_upgrade (id TEXT PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','teacher','student','cashier')), entity_id TEXT, enabled INTEGER NOT NULL DEFAULT 1, must_change INTEGER NOT NULL DEFAULT 0);
      INSERT INTO users_cashier_upgrade SELECT id,username,password_hash,role,entity_id,enabled,must_change FROM users;
      DROP TABLE users;
      ALTER TABLE users_cashier_upgrade RENAME TO users;
      CREATE UNIQUE INDEX users_entity ON users(role, entity_id) WHERE entity_id IS NOT NULL;`);
    if (db.prepare("PRAGMA foreign_key_check").get()) throw Error("Migration des comptes : lien de session invalide.");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
}

const realCashPayment = (payment) => payment.source !== "KKiaPay" && payment.mode !== "sandbox";
const nonnegative = (value) => Number.isFinite(Number(value)) ? Math.max(Number(value), 0) : 0;
function cashierLedger(data, period, pendingOnlineOrders = []) {
  const current = data.payments.filter((payment) => payment.mode !== "sandbox" && paymentAllocations(payment).some((allocation) => allocation.period === period));
  const received = new Map();
  const totals = { cash: 0, online: 0 };
  for (const payment of current) {
    const channel = realCashPayment(payment) ? "cash" : "online";
    const amount = nonnegative(paymentAmountFor(payment, period));
    const row = received.get(payment.student) || { cash: 0, online: 0 };
    row[channel] += amount;
    received.set(payment.student, row);
    totals[channel] += amount;
  }
  const students = data.students.map((student) => {
    const registrationStatus = student.registrationStatus || "Inscrit";
    const fee = ["Inscrit", "Préinscription"].includes(registrationStatus) ? nonnegative(student.monthlyFee) : 0;
    const receivedRow = received.get(student.id) || { cash: 0, online: 0 };
    const paid = receivedRow.cash + receivedRow.online;
    const balance = Math.max(fee - paid, 0);
    const status = registrationStatus === "Suspendu" ? "Suspendu" : fee === 0 ? "Non facturé" : balance === 0 ? "Payé" : paid > 0 ? "Partiel" : "À payer";
    const blocked = pendingOnlineOrders.some((order) => order.student_id === student.id && (Array.isArray(order.periods) ? order.periods.includes(period) : order.period === period) && order.mode === "live" && order.state === "pending");
    return {
      id: student.id, name: student.name || "", class: student.class || "", centre: student.centre || "", group: student.group || "",
      guardian: student.guardian || "", phone: student.phone || "", registrationStatus,
      fee, paid, cashPaid: receivedRow.cash, onlinePaid: receivedRow.online, balance, status,
      ...(blocked ? { blockedReason: "Un paiement en ligne doit être vérifié par le responsable avant d’encaisser." } : {}),
    };
  });
  return { period, students, payments: current.filter(realCashPayment), totals };
}

module.exports = { migrateSqliteCashierUsers, cashierLedger, realCashPayment };
