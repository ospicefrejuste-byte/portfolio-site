"use strict";
const crypto = require("node:crypto");
const {
  paymentAllocations,
  paymentAmountFor,
  selectedPeriods,
  rollingPeriods,
  MAX_PAYMENT_AMOUNT,
} = require("./payment-months");
const { cashierLedger } = require("./cashier");
const error = (status, message) =>
  Object.assign(new Error(message), { status });
function orderAllocations(order) {
  let allocations = order.allocations;
  if (typeof allocations === "string") {
    try {
      allocations = JSON.parse(allocations);
    } catch {
      throw error(409, "La répartition de cette échéance est invalide. Contactez l’administration.");
    }
  }
  const result = paymentAllocations({ ...order, allocations });
  if (!result.length) throw error(409, "La répartition de cette échéance est invalide. Contactez l’administration.");
  return result;
}
function overlaps(allocations, periods) {
  return allocations.some((allocation) => periods.includes(allocation.period));
}
function createPaymentService({
  db,
  snapshot,
  insert,
  transaction,
  config = {},
  verifyTransaction,
}) {
  const sandbox = config.sandbox ?? process.env.KKIAPAY_SANDBOX !== "false";
  const mode = sandbox ? "sandbox" : "live";
  const publicKey = config.publicKey || process.env.KKIAPAY_PUBLIC_KEY;
  const privateKey = config.privateKey || process.env.KKIAPAY_PRIVATE_KEY;
  const secretKey = config.secretKey || process.env.KKIAPAY_SECRET_KEY;
  const configured = Boolean(publicKey && privateKey && secretKey);
  db.exec(`CREATE TABLE IF NOT EXISTS payment_orders (id TEXT PRIMARY KEY, student_id TEXT NOT NULL, period TEXT NOT NULL, amount INTEGER NOT NULL, mode TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', transaction_id TEXT UNIQUE, created_at TEXT NOT NULL, allocations TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS orders_paid_month ON payment_orders(student_id,period,mode) WHERE state='paid';`);
  if (!db.prepare("PRAGMA table_info(payment_orders)").all().some((column) => column.name === "allocations"))
    db.exec("ALTER TABLE payment_orders ADD COLUMN allocations TEXT");
  function requireConfiguration() {
    if (!configured)
      throw error(
        503,
        "Paiement en ligne non configuré. Contactez l’administration.",
      );
  }
  const configuration = () => ({
    configured,
    sandbox,
    publicKey: configured ? publicKey : null,
  });
  function orders(user) {
    if (user.role === "teacher") return [];
    const rows =
      user.role === "admin"
        ? db
            .prepare("SELECT * FROM payment_orders ORDER BY created_at DESC")
            .all()
        : db
            .prepare(
              "SELECT * FROM payment_orders WHERE student_id=? ORDER BY created_at DESC",
            )
            .all(user.entity_id);
    return rows.filter(r => r.state !== "purged").map((r) => {
      const allocations = orderAllocations(r);
      return {
        id: r.id,
        student: r.student_id,
        amount: r.amount,
        period: r.period,
        periods: allocations.map((allocation) => allocation.period),
        allocations,
        mode: r.mode,
        status: r.state,
        createdAt: r.created_at,
        transactionId: r.transaction_id,
      };
    });
  }
  function months(user, query = {}, options = {}) {
    if (!["admin", "student"].includes(user.role))
      throw error(403, "Accès au paiement refusé.");
    const studentId = user.role === "student" ? user.entity_id : query.student;
    if (user.role === "student" && query.student !== undefined && query.student !== studentId)
      throw error(403, "Vous ne pouvez consulter que votre propre dossier.");
    const periods = rollingPeriods(query.start);
    const data = snapshot();
    const student = data.students.find((record) => record.id === studentId);
    if (!student) throw error(404, "Élève introuvable.");
    // A missing provider configuration must still show actual receipts.
    const quoteMode = configured ? mode : "live";
    const pending = db.prepare("SELECT * FROM payment_orders WHERE student_id=? AND mode=? AND state='pending'").all(student.id, quoteMode).map((order) => ({
      student_id: order.student_id,
      periods: orderAllocations(order).map((allocation) => allocation.period),
      mode: "live",
      state: order.state,
    }));
    // Reuse the cash ledger statuses while limiting the ledger to this mode.
    const own = {
      students: [{ ...student, monthlyFee: Number.isSafeInteger(student.monthlyFee) && student.monthlyFee > 0 ? student.monthlyFee : 0 }],
      payments: data.payments.filter((payment) => payment.student === student.id && (payment.mode || "live") === quoteMode).map((payment) => ({ ...payment, mode: "live" })),
    };
    return {
      student: { id: student.id, name: student.name, class: student.class, centre: student.centre, registrationStatus: student.registrationStatus || "Inscrit" },
      start: query.start,
      mode: quoteMode,
      months: periods.map((period) => {
        const row = cashierLedger(own, period, pending).students[0];
        return { period, fee: row.fee, paid: row.paid, balance: row.balance, status: row.status, ...(row.blockedReason ? { blockedReason: row.blockedReason } : {}) };
      }),
    };
  }
  function checkout(user, body, options = {}) {
    requireConfiguration();
    if (!["admin", "student"].includes(user.role))
      throw error(403, "Accès au paiement refusé.");
    const studentId = user.role === "student" ? user.entity_id : body.student;
    if (user.role === "student" && body.student && body.student !== studentId)
      throw error(403, "Vous ne pouvez payer que votre propre dossier.");
    const periods = selectedPeriods(body);
    return transaction(() => {
      const data = snapshot(),
        student = data.students.find((s) => s.id === studentId);
      if (!student || (student.registrationStatus !== "Inscrit" && !(options.allowPreinscription && student.registrationStatus === "Préinscription")))
        throw error(
          400,
          "L’inscription doit être validée par l’administration avant le paiement.",
        );
      if (!Number.isInteger(student.monthlyFee) || student.monthlyFee <= 0)
        throw error(
          400,
          "Le tarif mensuel doit être renseigné par l’administration.",
        );
      const existingOrders = db
        .prepare(
          "SELECT * FROM payment_orders WHERE student_id=? AND mode=? AND state IN ('paid','pending')",
        )
        .all(studentId, mode);
      if (existingOrders.some((order) => order.state === "paid" && overlaps(orderAllocations(order), periods)))
        throw error(409, "Ce mois a déjà été réglé en ligne.");
      // Every quoted month uses its own balance, including manual partial receipts.
      const receipts = data.payments
        .filter(
          (p) =>
            p.student === studentId &&
            (p.mode || "live") === mode,
        );
      const allocations = periods.map((period) => {
        const received = receipts.reduce((total, receipt) => total + paymentAmountFor(receipt, period), 0);
        const amount = student.monthlyFee - received;
        if (amount <= 0) throw error(409, "Un des mois sélectionnés est déjà réglé.");
        return { period, amount };
      });
      const amount = allocations.reduce((total, allocation) => total + allocation.amount, 0);
      if (!Number.isSafeInteger(amount) || amount > MAX_PAYMENT_AMOUNT)
        throw error(400, "Le montant total du règlement ne peut pas dépasser 100 000 000 F CFA.");
      const serialized = JSON.stringify(allocations);
      let order;
      for (const pending of existingOrders.filter((existing) => existing.state === "pending")) {
        const pendingAllocations = orderAllocations(pending);
        if (!overlaps(pendingAllocations, periods)) continue;
        if (JSON.stringify(pendingAllocations) !== serialized)
          throw error(409, "Une autre tentative de paiement est en attente pour un des mois sélectionnés. Vérifiez son résultat ou contactez le responsable.");
        order = pending;
      }
      if (!order) {
        const id = crypto.randomUUID();
        db.prepare(
          "INSERT INTO payment_orders(id,student_id,period,amount,mode,created_at,allocations) VALUES(?,?,?,?,?,?,?)",
        ).run(
          id,
          studentId,
          periods[0],
          amount,
          mode,
          new Date().toISOString(),
          serialized,
        );
        order = db.prepare("SELECT * FROM payment_orders WHERE id=?").get(id);
      }
      return {
        orderId: order.id,
        amount,
        period: periods[0],
        periods,
        allocations,
        sandbox,
        publicKey,
        studentName: student.name,
        data: JSON.stringify({ orderId: order.id }),
      };
    });
  }
  const providerVerify =
    verifyTransaction ||
    (async (transactionId) => {
      try {
        const response = await fetch(
          `${sandbox ? "https://api-sandbox.kkiapay.me" : "https://api.kkiapay.me"}/api/v1/transactions/status`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": publicKey,
              "x-private-key": privateKey,
              "x-secret-key": secretKey,
            },
            body: JSON.stringify({ transactionId }),
            signal: AbortSignal.timeout(15000),
          },
        );
        if (!response.ok)
          throw error(
            502,
            "La transaction ne peut pas être vérifiée auprès de KKiaPay.",
          );
        return await response.json();
      } catch (e) {
        if (e.status) throw e;
        throw error(
          502,
          "KKiaPay est temporairement indisponible. Réessayez la vérification.",
        );
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
    throw error(
      409,
      "La transaction ne contient pas la référence de l’échéance. Contactez l’administration.",
    );
  }
  async function confirm(user, body) {
    requireConfiguration();
    if (user && !["admin", "student"].includes(user.role))
      throw error(403, "Accès au paiement refusé.");
    if (
      typeof body.transactionId !== "string" ||
      !/^[a-zA-Z0-9_-]{6,100}$/.test(body.transactionId)
    )
      throw error(400, "Référence de transaction invalide.");
    let expected;
    if (user) {
      expected = db
        .prepare("SELECT * FROM payment_orders WHERE id=?")
        .get(body.orderId);
      if (
        !expected ||
        (user.role === "student" && expected.student_id !== user.entity_id)
      )
        throw error(403, "Échéance inaccessible.");
      if (expected.state === "purged") throw error(409, "Cette échéance appartenait à un dossier d’essai supprimé.");
    }
    const result = await providerVerify(body.transactionId);
    if (!result || result.status !== "SUCCESS")
      throw error(
        409,
        "Le prestataire n’a pas confirmé la réussite du paiement.",
      );
    if (result.transactionId && result.transactionId !== body.transactionId)
      throw error(409, "Référence de transaction incohérente.");
    const meta = metadata(result);
    return transaction(() => {
      const order = db
        .prepare("SELECT * FROM payment_orders WHERE id=?")
        .get(meta.orderId);
      if (
        !order ||
        (expected && order.id !== expected.id) ||
        order.mode !== mode ||
        (user?.role === "student" && order.student_id !== user.entity_id)
      )
        throw error(409, "La transaction ne correspond pas à cette échéance.");
      if (order.state === "purged") throw error(409, "Cette échéance appartenait à un dossier d’essai supprimé.");
      if (
        !Number.isFinite(Number(result.amount)) ||
        Number(result.amount) !== order.amount
      )
        throw error(
          409,
          "Le montant confirmé ne correspond pas au montant attendu.",
        );
      if (order.state === "paid") {
        if (order.transaction_id !== body.transactionId)
          throw error(
            409,
            "Cette échéance a déjà été réglée par une autre transaction.",
          );
        return { ok: true, alreadyConfirmed: true, sandbox, orderId: order.id };
      }
      if (
        db
          .prepare("SELECT id FROM payment_orders WHERE transaction_id=?")
          .get(body.transactionId)
      )
        throw error(409, "Cette transaction a déjà été utilisée.");
      const allocations = orderAllocations(order);
      const periods = allocations.map((allocation) => allocation.period);
      const paidOrders = db
        .prepare(
          "SELECT * FROM payment_orders WHERE student_id=? AND mode=? AND state='paid'",
        )
        .all(order.student_id, mode);
      if (paidOrders.some((paid) => overlaps(orderAllocations(paid), periods)))
        throw error(
          409,
          "Cette échéance a déjà été réglée. Contactez l’administration.",
        );
      if (!snapshot().students.some((s) => s.id === order.student_id))
        throw error(409, "Dossier élève introuvable.");
      insert("payments", {
        id: crypto.randomUUID(),
        student: order.student_id,
        amount: order.amount,
        date: new Date().toISOString().slice(0, 10),
        period: order.period,
        ...(allocations.length > 1 ? { periods, allocations } : {}),
        source: "KKiaPay",
        mode,
        transactionId: body.transactionId,
        orderId: order.id,
      });
      db.prepare(
        "UPDATE payment_orders SET state='paid',transaction_id=? WHERE id=?",
      ).run(body.transactionId, order.id);
      return { ok: true, sandbox, orderId: order.id };
    });
  }
  return { configuration, checkout, confirm, orders, months };
}
module.exports = { createPaymentService };
