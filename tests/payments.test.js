"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApplication } = require("../lib/application");
test("Paiements KKiaPay : vérification serveur, montant, propriété, idempotence et mode test", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crs-payment-test-"));
  let verified;
  const instance = createApplication({
    dataDir: dir,
    setupToken: "test-setup",
    paymentConfig: {
      sandbox: true,
      publicKey: "test-public",
      privateKey: "test-private",
      secretKey: "test-secret",
    },
    verifyTransaction: async () => verified,
  });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    instance.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (route, method = "GET", body, session) => {
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(session
          ? { Cookie: session.cookie, "X-CSRF-Token": session.csrf }
          : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    return {
      status: response.status,
      data,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
      csrf: data.csrf,
    };
  };
  const admin = await api("/api/auth/setup", "POST", {
    username: "admin",
    password: "Admin-test-password-123!",
    token: "test-setup",
  });
  const create = async (kind, body) => {
    const r = await api("/api/records/" + kind, "POST", body, admin);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data;
  };
  const s = await create("students", {
    name: "Test",
    class: "6e",
    group: "6e A",
    registrationStatus: "Inscrit",
    monthlyFee: 3500,
  });
  const other = await create("students", {
    name: "Other",
    class: "6e",
    group: "6e A",
    registrationStatus: "Inscrit",
    monthlyFee: 3500,
  });
  const order = await api(
    "/api/payments/checkout",
    "POST",
    { student: s.id, period: "2026-10", amount: 1 },
    admin,
  );
  assert.equal(order.status, 201);
  assert.equal(order.data.amount, 3500);
  assert.equal(order.data.sandbox, true);
  const repeated = await api(
    "/api/payments/checkout",
    "POST",
    { student: s.id, period: "2026-10" },
    admin,
  );
  assert.equal(repeated.data.orderId, order.data.orderId);
  verified = { status: "FAILED", amount: 3500, data: order.data.data };
  assert.equal(
    (
      await api(
        "/api/payments/confirm",
        "POST",
        { orderId: order.data.orderId, transactionId: "test_transaction_1" },
        admin,
      )
    ).status,
    409,
  );
  verified = { status: "SUCCESS", amount: 1, data: order.data.data };
  assert.equal(
    (
      await api(
        "/api/payments/confirm",
        "POST",
        { orderId: order.data.orderId, transactionId: "test_transaction_1" },
        admin,
      )
    ).status,
    409,
  );
  verified = { status: "SUCCESS", amount: 3500 };
  assert.equal(
    (
      await api(
        "/api/payments/confirm",
        "POST",
        { orderId: order.data.orderId, transactionId: "test_transaction_1" },
        admin,
      )
    ).status,
    409,
  );
  verified = {
    status: "SUCCESS",
    amount: 3500,
    data: JSON.stringify({ orderId: "wrong" }),
  };
  assert.equal(
    (
      await api(
        "/api/payments/confirm",
        "POST",
        { orderId: order.data.orderId, transactionId: "test_transaction_1" },
        admin,
      )
    ).status,
    409,
  );
  verified = { status: "SUCCESS", amount: 3500, data: order.data.data };
  let r = await api(
    "/api/payments/confirm",
    "POST",
    { orderId: order.data.orderId, transactionId: "test_transaction_1" },
    admin,
  );
  assert.equal(r.status, 200);
  r = await api(
    "/api/payments/confirm",
    "POST",
    { orderId: order.data.orderId, transactionId: "test_transaction_1" },
    admin,
  );
  assert.equal(r.data.alreadyConfirmed, true);
  r = await api("/api/payments/webhook", "POST", {
    transactionId: "test_transaction_1",
    amount: 1,
    status: "SUCCESS",
  });
  assert.equal(r.status, 200);
  let data = (await api("/api/data", "GET", undefined, admin)).data;
  assert.equal(data.payments.length, 1);
  assert.equal(data.payments[0].mode, "sandbox");
  assert.equal(data.payments[0].source, "KKiaPay");
  assert.equal(
    (
      await api(
        "/api/records/payments/" + data.payments[0].id,
        "DELETE",
        undefined,
        admin,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await api(
        "/api/records/payments/" + data.payments[0].id,
        "PUT",
        { amount: 1 },
        admin,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await api(
        "/api/payments/checkout",
        "POST",
        { student: s.id, period: "2026-10" },
        admin,
      )
    ).status,
    409,
  );
  const next = await api(
    "/api/payments/checkout",
    "POST",
    { student: other.id, period: "2026-10" },
    admin,
  );
  verified = { status: "SUCCESS", amount: 3500, data: next.data.data };
  assert.equal(
    (
      await api(
        "/api/payments/confirm",
        "POST",
        { orderId: next.data.orderId, transactionId: "test_transaction_1" },
        admin,
      )
    ).status,
    409,
  );
  const account = await api(
    "/api/admin/users",
    "POST",
    {
      username: "student",
      password: "Student-test-password-123!",
      role: "student",
      entityId: s.id,
    },
    admin,
  );
  assert.equal(account.status, 201);
  let student = await api("/api/auth/login", "POST", {
    username: "student",
    password: "Student-test-password-123!",
  });
  student = await api(
    "/api/auth/password",
    "POST",
    {
      currentPassword: "Student-test-password-123!",
      password: "Student-changed-password-123!",
    },
    student,
  );
  assert.equal(
    (
      await api(
        "/api/payments/checkout",
        "POST",
        { student: other.id, period: "2026-11" },
        student,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await api(
        "/api/payments/confirm",
        "POST",
        { orderId: next.data.orderId, transactionId: "test_transaction_2" },
        student,
      )
    ).status,
    403,
  );
  const own = await api(
    "/api/payments/checkout",
    "POST",
    { period: "2026-11", amount: 1 },
    student,
  );
  assert.equal(own.data.amount, 3500);
  const listed = (await api("/api/payments/orders", "GET", undefined, student))
    .data;
  assert.ok(listed.every((o) => o.student === s.id));
  const config = (await api("/api/payments/config", "GET", undefined, student))
    .data;
  assert.equal(config.privateKey, undefined);
  assert.equal(config.secretKey, undefined);
  verified = { status: "FAILED", amount: 3500, data: own.data.data };
  assert.equal(
    (
      await api("/api/payments/webhook", "POST", {
        transactionId: "test_transaction_2",
        status: "SUCCESS",
      })
    ).status,
    409,
  );
  assert.equal(
    (await api("/api/data", "GET", undefined, admin)).data.payments.length,
    1,
  );
});
test("Paiement désactivé sans clés et installation à usage unique", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crs-setup-test-"));
  const instance = createApplication({ dataDir: dir });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    instance.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const code = fs.readFileSync(path.join(dir, "setup-token"), "utf8");
  const base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + "/api/auth/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "admin",
      password: "Test-admin-password-123!",
      token: code,
    }),
  });
  assert.equal(r.status, 200);
  const user = await r.json();
  assert.equal(fs.existsSync(path.join(dir, "setup-token")), false);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const config = await fetch(base + "/api/payments/config", {
    headers: { Cookie: cookie },
  }).then((r) => r.json());
  assert.equal(config.configured, false);
  const checkout = await fetch(base + "/api/payments/checkout", {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
      "X-CSRF-Token": user.csrf,
    },
    body: JSON.stringify({ period: "2026-10" }),
  });
  assert.equal(checkout.status, 503);
});
