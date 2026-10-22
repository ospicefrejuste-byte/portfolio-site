"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { createPostgres } = require("../lib/store");
const { createApplication } = require("../lib/application");

const connectionString = process.env.ADEOYE_TEST_DATABASE_URL;

test("PostgreSQL : inventaire partagé entre serveurs, sorties atomiques, reprises idempotentes et consultation distante", { skip: connectionString ? false : "ADEOYE_TEST_DATABASE_URL doit désigner une base PostgreSQL réservée aux tests." }, async () => {
  const schema = "adeoye_test_" + crypto.randomBytes(12).toString("hex");
  const admin = new Pool({ connectionString });
  const servers = [], instances = [];
  const date = new Date().toISOString().slice(0, 10);
  await admin.query("CREATE SCHEMA " + schema);
  async function start() {
    const pool = new Pool({ connectionString, max: 4, options: "-c search_path=" + schema });
    const database = createPostgres({ pool });
    const instance = await createApplication({ database, setupToken: "test-cloud-setup-only" });
    instances.push(instance);
    const server = instance.app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise(resolve => server.once("listening", resolve));
    return "http://127.0.0.1:" + server.address().port;
  }
  function client(base) {
    let cookie = "", csrf = "";
    return {
      async request(route, method = "GET", data) {
        const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { "Content-Type": "application/json" }) };
        if (!["GET", "HEAD"].includes(method)) { headers.Origin = base; if (csrf) headers["X-CSRF-Token"] = csrf; }
        const response = await fetch(base + route, { method, headers, redirect: "manual", ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
        const cookies = response.headers.getSetCookie();
        if (cookies.length) cookie = cookies.at(-1).split(";", 1)[0];
        const bytes = Buffer.from(await response.arrayBuffer());
        const body = (response.headers.get("content-type") || "").includes("application/json") ? JSON.parse(bytes.toString()) : undefined;
        if (body?.csrf) csrf = body.csrf;
        return { status: response.status, ok: response.ok, body, bytes, headers: response.headers };
      },
    };
  }
  try {
    const first = await start();
    const owner = client(first);
    const setup = await owner.request("/api/auth/setup", "POST", { token: "test-cloud-setup-only", username: "proprietaire-cloud", password: "Cloud-admin-fixture-8925!" });
    assert.equal(setup.ok, true, setup.body?.error);
    const second = await start();
    const secondOwner = client(second);
    assert.equal((await secondOwner.request("/api/auth/status")).body.initialized, true);
    const login = await secondOwner.request("/api/auth/login", "POST", { username: "proprietaire-cloud", password: "Cloud-admin-fixture-8925!" });
    assert.equal(login.ok, true);
    const requestId = crypto.randomUUID();
    const creation = { requestId, name: "Lot de maïs cloud", category: "Cultures et récoltes", unit: "kg", location: "Magasin de test PostgreSQL", quantity: 10, minQuantity: 2, unitValue: 400, notes: "Stock fictif, base isolée" };
    const added = await owner.request("/api/items", "POST", creation);
    assert.equal(added.ok, true, added.body?.error);
    const item = added.body;
    const repeated = await secondOwner.request("/api/items", "POST", creation);
    assert.equal(repeated.ok, true);
    assert.equal(repeated.body.id, item.id);
    assert.equal((await secondOwner.request("/api/state")).body.items[0].quantity, 10);
    const outgoing = quantity => ({ requestId: crypto.randomUUID(), itemId: item.id, type: "exit", quantity, reason: "Vérification de sortie concurrente", date });
    const simultaneous = await Promise.all([owner.request("/api/movements", "POST", outgoing(7)), secondOwner.request("/api/movements", "POST", outgoing(7))]);
    assert.equal(simultaneous.filter(result => result.ok).length, 1, "Two servers cannot both remove the same available stock");
    assert.equal(simultaneous.filter(result => result.status === 409).length, 1);
    let state = (await owner.request("/api/state")).body;
    assert.equal(state.items[0].quantity, 3);
    assert.equal(state.movements.length, 2);
    const entry = { requestId: crypto.randomUUID(), itemId: item.id, type: "entry", quantity: 2.125, reason: "Livraison de test à trois décimales", date };
    const replay = await Promise.all([owner.request("/api/movements", "POST", entry), secondOwner.request("/api/movements", "POST", entry)]);
    assert.ok(replay.every(result => result.ok));
    assert.equal(replay[0].body.id, replay[1].body.id);
    state = (await owner.request("/api/state")).body;
    assert.equal(state.items[0].quantity, 5.125);
    assert.equal(state.movements.length, 3);
    const conflict = await secondOwner.request("/api/movements", "POST", { ...entry, quantity: 3 });
    assert.equal(conflict.status, 409);
    assert.equal((await secondOwner.request("/api/state")).body.items[0].quantity, 5.125);
    const viewer = await owner.request("/api/users", "POST", { username: "lecture-cloud-usa", password: "Initial-viewer-cloud-987!", role: "viewer" });
    assert.equal(viewer.ok, true, viewer.body?.error);
    const reader = client(second);
    assert.equal((await reader.request("/api/auth/login", "POST", { username: "lecture-cloud-usa", password: "Initial-viewer-cloud-987!" })).ok, true);
    assert.equal((await reader.request("/api/state")).status, 403);
    const changed = await reader.request("/api/auth/password", "POST", { currentPassword: "Initial-viewer-cloud-987!", password: "Personal-viewer-cloud-539!" });
    assert.equal(changed.ok, true, changed.body?.error);
    assert.equal((await reader.request("/api/state")).body.items[0].quantity, 5.125);
    assert.equal((await reader.request("/api/movements", "POST", { ...entry, requestId: crypto.randomUUID() })).status, 403);
    const pdf = await reader.request("/api/reports/inventory.pdf");
    assert.equal(pdf.ok, true);
    assert.equal(pdf.bytes.subarray(0, 5).toString(), "%PDF-");
    assert.equal((await reader.request("/api/export/inventory.csv")).ok, true);
    const disable = await owner.request("/api/users/" + viewer.body.id, "PATCH", { enabled: false });
    assert.equal(disable.ok, true);
    assert.equal((await reader.request("/api/state")).status, 401, "Disabling a user revokes their session on every server");
    const otherServerLogin = await secondOwner.request("/api/auth/login", "POST", { username: "proprietaire-cloud", password: "Cloud-admin-fixture-8925!" });
    assert.equal(otherServerLogin.ok, true);
    const after = (await secondOwner.request("/api/state")).body;
    assert.equal(after.items[0].quantity, 5.125);
    assert.equal(after.movements.length, 3);
  } finally {
    for (const server of servers) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    for (const instance of instances) await instance.db.close();
    try { await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE"); } finally { await admin.end(); }
  }
});
