"use strict";

const crypto = require("node:crypto");
const error = (status, message) => Object.assign(new Error(message), {
  status
});
async function createPaymentService({
  db,
  snapshot,
  insert,
  transaction,
  config = {},
  verifyTransaction
}) {
  const sandbox = config.sandbox ?? process.env.KKIAPAY_SANDBOX !== "false";
  const mode = sandbox ? "sandbox" : "live";
  const publicKey = config.publicKey || process.env.KKIAPAY_PUBLIC_KEY;
  const privateKey = config.privateKey || process.env.KKIAPAY_PRIVATE_KEY;
  const secretKey = config.secretKey || process.env.KKIAPAY_SECRET_KEY;
  const configured = Boolean(publicKey && privateKey && secretKey);
  await db.transaction(async () => {
    await db.exec(`CREATE TABLE IF NOT EXISTS payment_orders (id TEXT PRIMARY KEY, student_id TEXT NOT NULL, period TEXT NOT NULL, amount INTEGER NOT NULL, mode TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', transaction_id TEXT UNIQUE, created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS orders_paid_month ON payment_orders(student_id,period,mode) WHERE state='paid';`);
  });
  function requireConfiguration() {
    if (!configured) throw error(503, "Paiement en ligne non configuré. Contactez l’administration.");
  }
  const configuration = () => ({
    configured,
    sandbox,
    publicKey: configured ? publicKey : null
  });
  async function orders(user) {
    if (user.role === "teacher") return [];
    const rows = user.role === "admin" ? await db.prepare("SELECT * FROM payment_orders ORDER BY created_at DESC").all() : await db.prepare("SELECT * FROM payment_orders WHERE student_id=? ORDER BY created_at DESC").all(user.entity_id);
    return rows.map(r => ({
      id: r.id,
      student: r.student_id,
      amount: r.amount,
      period: r.period,
      mode: r.mode,
      status: r.state,
      createdAt: r.created_at,
      transactionId: r.transaction_id
    }));
  }
  async function checkout(user, body, options = {}) {
    requireConfiguration();
    if (!["admin", "student"].includes(user.role)) throw error(403, "Accès au paiement refusé.");
    const studentId = user.role === "student" ? user.entity_id : body.student;
    if (user.role === "student" && body.student && body.student !== studentId) throw error(403, "Vous ne pouvez payer que votre propre dossier.");
    if (typeof body.period !== "string" || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(body.period)) throw error(400, "Choisissez le mois à régler.");
    return await transaction(async () => {
      const data = await snapshot(),
        student = data.students.find(s => s.id === studentId);
      if (!student || student.registrationStatus !== "Inscrit" && !(options.allowPreinscription && student.registrationStatus === "Préinscription")) throw error(400, "L’inscription doit être validée par l’administration avant le paiement.");
      if (!Number.isInteger(student.monthlyFee) || student.monthlyFee <= 0) throw error(400, "Le tarif mensuel doit être renseigné par l’administration.");
      if (await db.prepare("SELECT id FROM payment_orders WHERE student_id=? AND period=? AND mode=? AND state='paid'").get(studentId, body.period, mode)) throw error(409, "Ce mois a déjà été réglé en ligne.");
      // Manual receipts also prevent collecting more than the monthly fee for the same ISO month.
      const received = data.payments.filter(p => p.student === studentId && p.period === body.period && (p.mode || "live") === mode).reduce((n, p) => n + p.amount, 0);
      const amount = student.monthlyFee - received;
      if (amount <= 0) throw error(409, "Ce mois est déjà réglé.");
      let order = await db.prepare("SELECT * FROM payment_orders WHERE student_id=? AND period=? AND mode=? AND amount=? AND state='pending'").get(studentId, body.period, mode, amount);
      if (!order) {
        const id = crypto.randomUUID();
        await db.prepare("INSERT INTO payment_orders(id,student_id,period,amount,mode,created_at) VALUES(?,?,?,?,?,?)").run(id, studentId, body.period, amount, mode, new Date().toISOString());
        order = await db.prepare("SELECT * FROM payment_orders WHERE id=?").get(id);
      }
      return {
        orderId: order.id,
        amount,
        period: body.period,
        sandbox,
        publicKey,
        studentName: student.name,
        data: JSON.stringify({
          orderId: order.id
        })
      };
    });
  }
  const providerVerify = verifyTransaction || (async transactionId => {
    try {
      const response = await fetch(`${sandbox ? "https://api-sandbox.kkiapay.me" : "https://api.kkiapay.me"}/api/v1/transactions/status`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": publicKey,
          "x-private-key": privateKey,
          "x-secret-key": secretKey
        },
        body: JSON.stringify({
          transactionId
        }),
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) throw error(502, "La transaction ne peut pas être vérifiée auprès de KKiaPay.");
      return await response.json();
    } catch (e) {
      if (e.status) throw e;
      throw error(502, "KKiaPay est temporairement indisponible. Réessayez la vérification.");
    }
  });
  function metadata(result) {
    const value = result.data;
    if (value && typeof value === "object") return value;
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {}
    }
    throw error(409, "La transaction ne contient pas la référence de l’échéance. Contactez l’administration.");
  }
  async function confirm(user, body) {
    requireConfiguration();
    if (user && !["admin", "student"].includes(user.role)) throw error(403, "Accès au paiement refusé.");
    if (typeof body.transactionId !== "string" || !/^[a-zA-Z0-9_-]{6,100}$/.test(body.transactionId)) throw error(400, "Référence de transaction invalide.");
    let expected;
    if (user) {
      expected = await db.prepare("SELECT * FROM payment_orders WHERE id=?").get(body.orderId);
      if (!expected || user.role === "student" && expected.student_id !== user.entity_id) throw error(403, "Échéance inaccessible.");
    }
    const result = await providerVerify(body.transactionId);
    if (!result || result.status !== "SUCCESS") throw error(409, "Le prestataire n’a pas confirmé la réussite du paiement.");
    if (result.transactionId && result.transactionId !== body.transactionId) throw error(409, "Référence de transaction incohérente.");
    const meta = metadata(result);
    return await transaction(async () => {
      const order = await db.prepare("SELECT * FROM payment_orders WHERE id=?").get(meta.orderId);
      if (!order || expected && order.id !== expected.id || order.mode !== mode || user?.role === "student" && order.student_id !== user.entity_id) throw error(409, "La transaction ne correspond pas à cette échéance.");
      if (!Number.isFinite(Number(result.amount)) || Number(result.amount) !== order.amount) throw error(409, "Le montant confirmé ne correspond pas au montant attendu.");
      if (order.state === "paid") {
        if (order.transaction_id !== body.transactionId) throw error(409, "Cette échéance a déjà été réglée par une autre transaction.");
        return {
          ok: true,
          alreadyConfirmed: true,
          sandbox,
          orderId: order.id
        };
      }
      if (await db.prepare("SELECT id FROM payment_orders WHERE transaction_id=?").get(body.transactionId)) throw error(409, "Cette transaction a déjà été utilisée.");
      if (await db.prepare("SELECT id FROM payment_orders WHERE student_id=? AND period=? AND mode=? AND state='paid'").get(order.student_id, order.period, mode)) throw error(409, "Cette échéance a déjà été réglée. Contactez l’administration.");
      if (!(await snapshot()).students.some(s => s.id === order.student_id)) throw error(409, "Dossier élève introuvable.");
      await insert("payments", {
        id: crypto.randomUUID(),
        student: order.student_id,
        amount: order.amount,
        date: new Date().toISOString().slice(0, 10),
        period: order.period,
        source: "KKiaPay",
        mode,
        transactionId: body.transactionId,
        orderId: order.id
      });
      await db.prepare("UPDATE payment_orders SET state='paid',transaction_id=? WHERE id=?").run(body.transactionId, order.id);
      return {
        ok: true,
        sandbox,
        orderId: order.id
      };
    });
  }
  return {
    configuration,
    checkout,
    confirm,
    orders
  };
}
module.exports = {
  createPaymentService
};
