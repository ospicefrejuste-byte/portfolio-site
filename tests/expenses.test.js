"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApplication } = require("../lib/application");
const { localDay, selectExpenses } = require("../lib/expenses");

const PASSWORD = "Expense-owner-fixture-583!";
const INITIAL = "Expense-initial-fixture-582!";
const PERSONAL = "Expense-personal-fixture-581!";

function purchase(fields = {}) {
  return { requestId: crypto.randomUUID(), description: "Achat fictif de maïs", category: "Aliments et intrants", supplier: "Fournisseur de test", amount: 4500, date: "2024-02-15", time: "14:35", notes: "Données fictives, jamais envoyées à la ferme réelle.", ...fields };
}

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "adeoye-expense-test-"));
  let instance, server, base;
  async function close() {
    if (server) { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); server = null; }
    if (instance) { await instance.db.close(); instance = null; }
  }
  async function start() {
    instance = await createApplication({ dataDir, setupToken: "expense-setup-fixture" });
    server = instance.app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    base = "http://127.0.0.1:" + server.address().port;
  }
  function client() {
    let cookie = "", csrf = "";
    return {
      async request(route, method = "GET", data, options = {}) {
        const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...(method === "GET" ? {} : { Origin: base }), ...(csrf && method !== "GET" && !options.noCsrf ? { "X-CSRF-Token": csrf } : {}) };
        const response = await fetch(base + route, { method, headers, redirect: "manual", ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
        for (const value of response.headers.getSetCookie()) cookie = value.split(";", 1)[0];
        const bytes = Buffer.from(await response.arrayBuffer());
        const body = (response.headers.get("content-type") || "").includes("application/json") ? JSON.parse(bytes.toString()) : undefined;
        if (body?.csrf) csrf = body.csrf;
        return { status: response.status, ok: response.ok, body, bytes, headers: response.headers };
      },
    };
  }
  await start();
  t.after(async () => { await close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const admin = client(), anonymous = client();
  assert.equal((await admin.request("/api/auth/setup", "POST", { token: "expense-setup-fixture", username: "responsable-depenses", password: PASSWORD })).status, 200);
  async function account(role) {
    const username = "expense-" + role;
    assert.equal((await admin.request("/api/users", "POST", { username, password: INITIAL, role })).status, 201);
    const account = client();
    assert.equal((await account.request("/api/auth/login", "POST", { username, password: INITIAL })).status, 200);
    assert.equal((await account.request("/api/expenses")).status, 403, "Initial password must be changed before financial information is visible");
    assert.equal((await account.request("/api/auth/password", "POST", { currentPassword: INITIAL, password: PERSONAL })).status, 200);
    return account;
  }
  return { admin, anonymous, account, client, close, start, get db() { return instance.db; } };
}

test("dépenses privées : responsable et gestionnaire saisissent, consultation seule et CSRF restent appliqués", async t => {
  const f = await fixture(t);
  for (const route of ["/api/expenses", "/api/reports/expenses.pdf"]) assert.equal((await f.anonymous.request(route)).status, 401);
  assert.equal((await f.anonymous.request("/api/expenses", "POST", purchase())).status, 401);
  assert.equal((await f.admin.request("/api/expenses", "POST", purchase(), { noCsrf: true })).status, 403);
  assert.deepEqual((await f.admin.request("/api/expenses")).body, { expenses: [], total: "0", count: 0, from: null, to: null });
  const manager = await f.account("manager"), viewer = await f.account("viewer");
  const added = await manager.request("/api/expenses", "POST", purchase());
  assert.equal(added.status, 201, added.body?.error);
  assert.equal(added.body.createdBy, "expense-manager");
  assert.equal(added.body.timezone, "Africa/Porto-Novo");
  assert.equal(added.body.time, "14:35");
  assert.match(added.body.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(added.body.reference, added.body.id);
  const listing = await viewer.request("/api/expenses");
  assert.equal(listing.status, 200);
  assert.equal(listing.body.total, "4500");
  assert.equal(listing.body.expenses[0].description, "Achat fictif de maïs");
  assert.equal((await viewer.request("/api/state")).body.expenses[0].id, added.body.id);
  assert.equal((await viewer.request("/api/expenses", "POST", purchase())).status, 403);
  assert.equal((await viewer.request("/api/expenses/" + added.body.id, "PUT", purchase())).status, 404);
  assert.equal((await viewer.request("/api/expenses/" + added.body.id, "DELETE", {})).status, 404);
  const pdf = await viewer.request("/api/reports/expenses.pdf?from=2024-02-15&to=2024-02-15");
  assert.equal(pdf.status, 200, pdf.body?.error);
  assert.match(pdf.headers.get("content-type"), /application\/pdf/);
  assert.equal(pdf.bytes.subarray(0, 5).toString(), "%PDF-");
});

test("périodes de dépenses inclusives, tri date/heure et total exact sans arrondi", async t => {
  const f = await fixture(t);
  const fixtures = [
    { date: "2024-01-31", time: "23:59", amount: 9 },
    { date: "2024-02-01", time: "00:00", amount: 1000000000000 },
    { date: "2024-02-15", time: "10:01", amount: 1 },
    { date: "2024-02-15", time: "10:02", amount: 2 },
    { date: "2024-02-29", time: "23:59", amount: 3 },
    { date: "2024-03-01", time: "00:00", amount: 8 },
  ];
  for (const value of fixtures) assert.equal((await f.admin.request("/api/expenses", "POST", purchase(value))).status, 201);
  const result = (await f.admin.request("/api/expenses?from=2024-02-01&to=2024-02-29")).body;
  assert.equal(result.total, "1000000000006");
  assert.equal(result.count, 4);
  assert.deepEqual(result.expenses.map(row => row.time), ["23:59", "10:02", "10:01", "00:00"]);
  assert.equal((await f.admin.request("/api/expenses?to=2024-01-31")).body.total, "9");
  assert.equal((await f.admin.request("/api/expenses?from=2024-03-01")).body.total, "8");
  assert.equal((await f.admin.request("/api/expenses?from=2024-02-15&to=2024-02-15")).body.total, "3");
  assert.deepEqual((await f.admin.request("/api/expenses?from=2025-01-01&to=2025-01-31")).body.expenses, []);
  const large = selectExpenses(Array.from({ length: 10000 }, () => ({ date: "2024-02-01", amount: 999999999999 })));
  assert.equal(large.total, "9999999999990000", "Totals remain exact even when greater than Number.MAX_SAFE_INTEGER");
  assert.equal(localDay("Pacific/Kiritimati", new Date("2026-01-01T10:30:00Z")), "2026-01-02");
  assert.equal(localDay("America/Los_Angeles", new Date("2026-01-01T00:30:00Z")), "2025-12-31");
});

test("montants, dates, heures et filtres invalides sont refusés sans écriture", async t => {
  const f = await fixture(t);
  for (const override of [
    { amount: 0 }, { amount: -1 }, { amount: 0.5 }, { amount: true }, { amount: "1e2" }, { amount: "" }, { amount: "Infinity" }, { amount: 1000000000001 },
    { description: "" }, { description: "a".repeat(161) }, { category: "Inconnu" }, { supplier: "a".repeat(161) }, { notes: "a".repeat(2001) },
    { date: "2024-02-30" }, { date: "2023-02-29" }, { date: "2099-01-01" }, { date: "2024-2-01" }, { date: ["2024-02-01"] },
    { time: "24:00" }, { time: "12:60" }, { time: "2:01" }, { time: "14:30:30" }, { time: null }, { requestId: "not-a-uuid" },
  ]) {
    const result = await f.admin.request("/api/expenses", "POST", purchase(override));
    assert.equal(result.status, 400, JSON.stringify(override));
  }
  for (const query of ["from=2024-02-30", "to=2023-02-29", "from=2024-03-01&to=2024-02-01", "from=", "from=2024-01-01&from=2024-02-01", "from[]=2024-02-01", "untrusted=1"]) {
    for (const route of ["/api/expenses", "/api/reports/expenses.pdf"]) assert.equal((await f.admin.request(route + "?" + query)).status, 400, route + "?" + query);
  }
  assert.deepEqual((await f.admin.request("/api/state")).body.expenses, []);
});

test("reprises des dépenses sans doublon, auteur lié à la requête et fuseau historique conservé", async t => {
  const f = await fixture(t);
  const body = purchase();
  const replies = await Promise.all([f.admin.request("/api/expenses", "POST", body), f.admin.request("/api/expenses", "POST", body)]);
  assert.ok(replies.every(reply => reply.status === 201));
  assert.deepEqual(replies[0].body, replies[1].body);
  assert.equal((await f.admin.request("/api/expenses")).body.count, 1);
  assert.equal((await f.admin.request("/api/expenses", "POST", { ...body, amount: body.amount + 1 })).status, 409);
  const manager = await f.account("manager");
  assert.equal((await manager.request("/api/expenses", "POST", body)).status, 409, "A different account cannot reuse another account’s operation reference");
  const settings = (await f.admin.request("/api/settings")).body;
  assert.equal((await f.admin.request("/api/settings", "PUT", { ...settings, timezone: "America/New_York" })).status, 200);
  const replay = await f.admin.request("/api/expenses", "POST", body);
  assert.equal(replay.status, 201);
  assert.equal(replay.body.timezone, "Africa/Porto-Novo", "A retry keeps the original accounting timezone after settings change");
  const newExpense = await manager.request("/api/expenses", "POST", purchase({ time: "09:10" }));
  assert.equal(newExpense.body.timezone, "America/New_York");
  assert.equal((await f.admin.request("/api/expenses")).body.total, "9000");
  await f.close();
  await f.start();
  const reader = f.client();
  assert.equal((await reader.request("/api/auth/login", "POST", { username: "responsable-depenses", password: PASSWORD })).status, 200);
  const persisted = (await reader.request("/api/state")).body;
  assert.equal(persisted.expenses.length, 2);
  assert.equal(persisted.expenses.find(expense => expense.id === body.requestId).timezone, "Africa/Porto-Novo");
});

test("la migration ajoute le registre des dépenses sans effacer comptes, stock, notes ou historique", async t => {
  const f = await fixture(t);
  const inventory = await f.admin.request("/api/items", "POST", { requestId: crypto.randomUUID(), name: "Poules fictives de test", category: "Animaux", unit: "tête", quantity: 3, minQuantity: 0, unitValue: 1000 });
  assert.equal(inventory.status, 201);
  assert.equal((await f.admin.request("/api/notes", "POST", { title: "Note de migration", body: "Observation fictive existante", date: "2024-02-01" })).status, 201);
  const before = (await f.admin.request("/api/state")).body;
  await f.db.exec("DROP TABLE adeoye_expenses");
  await f.close();
  await f.start();
  const reader = f.client();
  assert.equal((await reader.request("/api/auth/login", "POST", { username: "responsable-depenses", password: PASSWORD })).status, 200);
  const after = (await reader.request("/api/state")).body;
  assert.deepEqual(after.items, before.items);
  assert.deepEqual(after.movements, before.movements);
  assert.deepEqual(after.notes, before.notes);
  assert.deepEqual(after.expenses, []);
  assert.equal((await reader.request("/api/expenses", "POST", purchase())).status, 201);
});
