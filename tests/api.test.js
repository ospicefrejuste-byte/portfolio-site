"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createApplication } = require("../lib/application");

const ADMIN_PASSWORD = "Test-admin-only-123!";
const INITIAL_PASSWORD = "Test-initial-only-456!";
const PERSONAL_PASSWORD = "Test-personal-only-789!";
const today = () => new Date().toISOString().slice(0, 10);
const clone = value => JSON.parse(JSON.stringify(value));

async function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "adeoye-api-"));
  const instance = await createApplication({ dataDir, setupToken: "test-setup-only", ...options });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await instance.db.close();
  }
  t.after(async () => { await close(); if (options.removeDirectory !== false) fs.rmSync(dataDir, { recursive: true, force: true }); });
  function client() {
    let cookie = "", csrf = "";
    return {
      async request(route, method = "GET", data, extras = {}) {
        const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(data !== undefined ? { "Content-Type": "application/json" } : {}) };
        if (!["GET", "HEAD"].includes(method)) {
          headers.Origin = options.publicOrigin || base;
          if (csrf) headers["X-CSRF-Token"] = csrf;
        }
        Object.assign(headers, extras.headers || {});
        for (const key of Object.keys(headers)) if (headers[key] === null) delete headers[key];
        const response = await fetch(base + route, { method, headers, redirect: "manual", ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
        for (const value of response.headers.getSetCookie()) cookie = value.split(";", 1)[0];
        const bytes = Buffer.from(await response.arrayBuffer());
        const text = bytes.toString("utf8");
        let body;
        if ((response.headers.get("content-type") || "").includes("application/json")) body = JSON.parse(text);
        if (body?.csrf) csrf = body.csrf;
        return { status: response.status, ok: response.ok, body, text, bytes, headers: response.headers };
      },
    };
  }
  const anonymous = client(), admin = client();
  return { ...instance, dataDir, base, server, close, client, anonymous, admin };
}
async function setup(f) {
  const response = await f.admin.request("/api/auth/setup", "POST", { token: "test-setup-only", username: "proprietaire", password: ADMIN_PASSWORD });
  assert.equal(response.ok, true, response.body?.error);
  assert.equal(response.body.user.role, "admin");
  return response;
}
function itemBody(overrides = {}) {
  return { requestId: crypto.randomUUID(), name: "Maïs récolté", category: "Cultures et récoltes", unit: "kg", location: "Magasin A", quantity: 10, minQuantity: 2, unitValue: 500, notes: "Lot fictif pour les tests", ...overrides };
}
async function addItem(f, overrides) {
  const response = await f.admin.request("/api/items", "POST", itemBody(overrides));
  assert.equal(response.ok, true, response.body?.error);
  assert.ok(response.body.id);
  return response.body;
}
async function createUser(f, role, name = role) {
  const result = await f.admin.request("/api/users", "POST", { username: "test-" + name, password: INITIAL_PASSWORD, role });
  assert.equal(result.ok, true, result.body?.error);
  assert.equal(result.body.mustChangePassword, true);
  const account = f.client();
  const login = await account.request("/api/auth/login", "POST", { username: result.body.username, password: INITIAL_PASSWORD });
  assert.equal(login.ok, true, login.body?.error);
  return { user: result.body, account };
}
async function changeInitial(account) {
  const changed = await account.request("/api/auth/password", "POST", { currentPassword: INITIAL_PASSWORD, password: PERSONAL_PASSWORD });
  assert.equal(changed.ok, true, changed.body?.error);
  assert.equal(changed.body.user.mustChangePassword, false);
}
function movement(item, overrides = {}) {
  return { requestId: crypto.randomUUID(), itemId: item.id, type: "entry", quantity: 1, reason: "Contrôle local fictif", date: today(), ...overrides };
}

test("installation privée unique, cookies protégés, aucune donnée ni connexion par défaut", async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.anonymous.request("/api/auth/status")).body, { initialized: false });
  assert.deepEqual((await f.anonymous.request("/api/health")).body, { ok: true });
  assert.equal((await f.anonymous.request("/api/state")).status, 401);
  assert.equal((await f.anonymous.request("/api/users")).status, 401);
  const wrong = await f.anonymous.request("/api/auth/setup", "POST", { token: "wrong-test-token", username: "proprietaire", password: ADMIN_PASSWORD });
  assert.ok(wrong.status >= 400 && wrong.status < 500);
  assert.equal((await f.anonymous.request("/api/auth/status")).body.initialized, false);
  const installed = await setup(f);
  assert.match(installed.headers.get("set-cookie"), /HttpOnly/i);
  assert.match(installed.headers.get("set-cookie"), /SameSite=Lax/i);
  assert.ok(installed.body.csrf.length >= 24);
  assert.equal((await f.anonymous.request("/api/auth/status")).body.initialized, true);
  const duplicate = await f.anonymous.request("/api/auth/setup", "POST", { token: "test-setup-only", username: "other", password: ADMIN_PASSWORD });
  assert.equal(duplicate.status, 409);
  const state = await f.admin.request("/api/state");
  assert.match(state.headers.get("cache-control") || "", /no-store/i);
  assert.deepEqual(state.body.items, []);
  assert.deepEqual(state.body.movements, []);
  assert.deepEqual(state.body.notes, []);
  assert.ok(!JSON.stringify(state.body).includes(ADMIN_PASSWORD));
  assert.ok(!JSON.stringify(state.body).includes("test-setup-only"));
  const users = await f.admin.request("/api/users");
  assert.equal(users.body.users.length, 1);
  for (const user of users.body.users) {
    assert.equal(user.password, undefined);
    assert.equal(user.passwordHash, undefined);
    assert.equal(user.hash, undefined);
  }
  assert.equal((await f.admin.request("/api/auth/logout", "POST", {})).ok, true);
  assert.equal((await f.admin.request("/api/state")).status, 401);
});

test("origine, CSRF, mot de passe et accès anonyme restent contrôlés côté serveur", async t => {
  const f = await fixture(t);
  await setup(f);
  const crossOrigin = await f.admin.request("/api/items", "POST", itemBody(), { headers: { Origin: "https://attacker.invalid" } });
  assert.equal(crossOrigin.status, 403);
  const csrf = await f.admin.request("/api/items", "POST", itemBody(), { headers: { "X-CSRF-Token": null } });
  assert.equal(csrf.status, 403);
  assert.equal((await f.admin.request("/api/state")).body.items.length, 0);
  const short = await f.admin.request("/api/users", "POST", { username: "weak-password", password: "too-short", role: "viewer" });
  assert.equal(short.status, 400);
  const wrongLogin = await f.anonymous.request("/api/auth/login", "POST", { username: "proprietaire", password: "Unknown-password-only-123" });
  assert.equal(wrongLogin.status, 401);
  const page = await f.anonymous.request("/app.html");
  assert.ok([302, 303, 401].includes(page.status));
  assert.ok(!page.text.includes("Maïs récolté"));
});

test("compte distant en lecture seule, changement initial obligatoire et rôles sans élévation", async t => {
  const f = await fixture(t);
  await setup(f);
  const item = await addItem(f);
  const viewer = await createUser(f, "viewer");
  assert.equal((await viewer.account.request("/api/state")).status, 403);
  await changeInitial(viewer.account);
  const state = await viewer.account.request("/api/state");
  assert.equal(state.ok, true);
  assert.equal(state.body.items[0].id, item.id);
  for (const [route, method, body] of [
    ["/api/items", "POST", itemBody()],
    ["/api/items/" + item.id, "PUT", { ...item, version: item.version, name: "Modification interdite" }],
    ["/api/items/" + item.id + "/archive", "POST", { version: item.version }],
    ["/api/movements", "POST", movement(item)],
    ["/api/notes", "POST", { title: "Interdit", body: "Lecture seule", date: today() }],
    ["/api/settings", "PUT", { ...state.body.settings, name: "Usurpation" }],
    ["/api/users", "POST", { username: "escalation", password: PERSONAL_PASSWORD, role: "admin" }],
  ]) assert.equal((await viewer.account.request(route, method, body)).status, 403, route);
  assert.equal((await viewer.account.request("/api/users")).status, 403);
  assert.equal((await viewer.account.request("/api/export/inventory.csv")).ok, true);
  const manager = await createUser(f, "manager");
  await changeInitial(manager.account);
  const managerItem = await manager.account.request("/api/items", "POST", itemBody({ name: "Aliment poussin", category: "Aliments et intrants" }));
  assert.equal(managerItem.ok, true, managerItem.body?.error);
  assert.equal((await manager.account.request("/api/movements", "POST", movement(managerItem.body))).ok, true);
  assert.equal((await manager.account.request("/api/notes", "POST", { title: "Observation", body: "Ronde effectuée", date: today() })).ok, true);
  assert.equal((await manager.account.request("/api/users")).status, 403);
  assert.equal((await manager.account.request("/api/settings", "PUT", state.body.settings)).status, 403);
});

test("inventaire exact, décimales, unités et mises à jour concurrentes ne réécrivent pas le stock", async t => {
  const f = await fixture(t);
  await setup(f);
  const body = itemBody({ quantity: 10.125, minQuantity: 1.5 });
  const created = await f.admin.request("/api/items", "POST", body);
  assert.equal(created.ok, true, created.body?.error);
  const item = created.body;
  assert.equal(item.quantity, 10.125);
  const repeat = await f.admin.request("/api/items", "POST", body);
  assert.equal(repeat.ok, true);
  assert.equal(repeat.body.id, item.id);
  assert.equal((await f.admin.request("/api/items", "POST", { ...body, quantity: 99 })).status, 409);
  const original = (await f.admin.request("/api/state")).body;
  assert.equal(original.items.length, 1);
  assert.equal(original.movements.length, 1);
  assert.equal(original.movements[0].type, "opening");
  assert.equal(original.movements[0].quantity, 10.125);
  for (const overrides of [{ quantity: -1 }, { quantity: 1.0001 }, { quantity: "NaN" }, { unitValue: -1 }, { unitValue: 0.5 }, { unit: "tête", quantity: 1.2 }, { category: "Non autorisée" }]) {
    assert.equal((await f.admin.request("/api/items", "POST", itemBody(overrides))).status, 400, JSON.stringify(overrides));
  }
  const attemptedQuantity = await f.admin.request("/api/items/" + item.id, "PUT", { ...item, quantity: 999999, version: item.version });
  assert.equal(attemptedQuantity.status, 400, "Stock cannot be rewritten outside a movement");
  const update = { name: "Maïs sec", category: item.category, location: "Magasin B", minQuantity: item.minQuantity, unitValue: item.unitValue, notes: item.notes, version: item.version };
  const saved = await f.admin.request("/api/items/" + item.id, "PUT", update);
  assert.equal(saved.ok, true, saved.body?.error);
  assert.equal(saved.body.quantity, 10.125, "Only movement endpoints may change stock");
  assert.ok(saved.body.version > item.version);
  assert.equal((await f.admin.request("/api/items/" + item.id, "PUT", update)).status, 409);
  assert.equal((await f.admin.request("/api/items/" + item.id + "/archive", "POST", { version: saved.body.version })).status, 409, "Positive stock cannot be archived");
});

test("sorties concurrentes, mouvements idempotents et pertes gardent un stock positif et un historique exact", async t => {
  const f = await fixture(t);
  await setup(f);
  const item = await addItem(f, { quantity: 10 });
  const exit = movement(item, { type: "exit", quantity: 7 });
  const secondExit = movement(item, { type: "exit", quantity: 7 });
  const results = await Promise.all([f.admin.request("/api/movements", "POST", exit), f.admin.request("/api/movements", "POST", secondExit)]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.filter(r => r.status === 409).length, 1);
  const winnerBody = results[0].ok ? exit : secondExit;
  const winner = results.find(r => r.ok).body;
  const retries = await Promise.all(Array.from({ length: 3 }, () => f.admin.request("/api/movements", "POST", winnerBody)));
  assert.ok(retries.every(r => r.ok && r.body.id === winner.id));
  assert.equal((await f.admin.request("/api/movements", "POST", { ...winnerBody, quantity: 1 })).status, 409);
  let state = (await f.admin.request("/api/state")).body;
  assert.equal(state.items[0].quantity, 3);
  assert.equal(state.movements.length, 2);
  assert.equal(state.movements.find(m => m.id === winner.id).balanceAfter, 3);
  const loss = await f.admin.request("/api/movements", "POST", movement(item, { type: "loss", quantity: 3, reason: "Perte de lot fictif" }));
  assert.equal(loss.ok, true, loss.body?.error);
  state = (await f.admin.request("/api/state")).body;
  assert.equal(state.items[0].quantity, 0);
  assert.equal(state.movements.length, 3);
  const archived = await f.admin.request("/api/items/" + item.id + "/archive", "POST", { version: state.items[0].version });
  assert.equal(archived.ok, true, archived.body?.error);
  assert.equal((await f.admin.request("/api/movements", "POST", movement(item))).status, 409);
  state = (await f.admin.request("/api/state")).body;
  assert.equal(state.movements.length, 3, "Archiving retains the audit trail");
  assert.equal(state.items.find(row => row.id === item.id).active, false);
});

test("dates, raisons et quantités de mouvements sont validées avant toute écriture", async t => {
  const f = await fixture(t);
  await setup(f);
  const item = await addItem(f, { unit: "tête", category: "Animaux", quantity: 20 });
  for (const overrides of [
    { quantity: 0 }, { quantity: -1 }, { quantity: 1.5 }, { date: "2026-02-30" },
    { date: "2099-01-01" }, { reason: "" }, { type: "opening" }, { requestId: "invalid" },
  ]) assert.equal((await f.admin.request("/api/movements", "POST", movement(item, overrides))).status, 400, JSON.stringify(overrides));
  const after = (await f.admin.request("/api/state")).body;
  assert.equal(after.items[0].quantity, 20);
  assert.equal(after.movements.length, 1);
});

test("désactivation et réinitialisation ferment les sessions, aucun blocage du dernier propriétaire", async t => {
  const f = await fixture(t);
  const installed = await setup(f);
  const viewer = await createUser(f, "viewer");
  await changeInitial(viewer.account);
  assert.equal((await f.admin.request("/api/users/" + installed.body.user.id, "PATCH", { enabled: false })).status, 409);
  assert.equal((await f.admin.request("/api/users/" + viewer.user.id, "PATCH", { enabled: false })).ok, true);
  assert.equal((await viewer.account.request("/api/state")).status, 401);
  assert.equal((await viewer.account.request("/api/auth/login", "POST", { username: viewer.user.username, password: PERSONAL_PASSWORD })).status, 401);
  assert.equal((await f.admin.request("/api/users/" + viewer.user.id, "PATCH", { enabled: true })).ok, true);
  assert.equal((await viewer.account.request("/api/auth/login", "POST", { username: viewer.user.username, password: PERSONAL_PASSWORD })).ok, true);
  const resetPassword = "Test-reset-only-123!";
  const reset = await f.admin.request("/api/users/" + viewer.user.id + "/reset-password", "POST", { password: resetPassword });
  assert.equal(reset.ok, true, reset.body?.error);
  assert.equal((await viewer.account.request("/api/state")).status, 401);
  assert.equal((await viewer.account.request("/api/auth/login", "POST", { username: viewer.user.username, password: PERSONAL_PASSWORD })).status, 401);
  const fresh = await viewer.account.request("/api/auth/login", "POST", { username: viewer.user.username, password: resetPassword });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.body.user.mustChangePassword, true);
  assert.equal((await viewer.account.request("/api/state")).status, 403);
});

test("exports UTF-8 neutralisent les formules et les rapports sont de vrais PDF réservés aux comptes", async t => {
  const f = await fixture(t);
  await setup(f);
  await addItem(f, { name: '=HYPERLINK("https://invalid.test")', location: "+danger", quantity: 2.5 });
  await f.admin.request("/api/notes", "POST", { title: "Météo", body: "Observation fictive", date: today() });
  for (const route of ["/api/export/inventory.csv", "/api/export/movements.csv", "/api/reports/inventory.pdf"]) assert.equal((await f.anonymous.request(route)).status, 401);
  const csv = await f.admin.request("/api/export/inventory.csv");
  assert.equal(csv.ok, true);
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  assert.deepEqual([...csv.bytes.subarray(0, 3)], [239, 187, 191]);
  assert.match(csv.text, /'=HYPERLINK/);
  assert.match(csv.text, /'\+danger/);
  const history = await f.admin.request("/api/export/movements.csv");
  assert.equal(history.ok, true);
  assert.match(history.text, /'=HYPERLINK/);
  const pdf = await f.admin.request("/api/reports/inventory.pdf");
  assert.equal(pdf.ok, true, pdf.body?.error);
  assert.match(pdf.headers.get("content-type"), /application\/pdf/);
  assert.equal(pdf.bytes.subarray(0, 5).toString(), "%PDF-");
  const state = (await f.admin.request("/api/state")).body;
  assert.equal(state.notes.length, 1);
  assert.equal(state.items.length, 1);
});

test("les données de ferme persistent après redémarrage et restent partagées entre sessions", async t => {
  const f = await fixture(t, { removeDirectory: false });
  await setup(f);
  const created = await addItem(f, { name: "Chèvres", category: "Animaux", unit: "tête", quantity: 12 });
  await f.admin.request("/api/movements", "POST", movement(created, { type: "entry", quantity: 2 }));
  const previous = clone((await f.admin.request("/api/state")).body);
  await f.close();
  const second = await createApplication({ dataDir: f.dataDir, setupToken: "test-setup-only" });
  const server = second.app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await second.db.close(); fs.rmSync(f.dataDir, { recursive: true, force: true }); });
  const base = "http://127.0.0.1:" + server.address().port;
  const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ username: "proprietaire", password: ADMIN_PASSWORD }) });
  assert.equal(login.ok, true);
  const cookie = login.headers.getSetCookie()[0].split(";", 1)[0];
  const result = await fetch(base + "/api/state", { headers: { Cookie: cookie } });
  const current = await result.json();
  assert.deepEqual(current.items, previous.items);
  assert.deepEqual(current.movements, previous.movements);
  assert.equal(current.items[0].quantity, 14);
});

test("JSON malformé et alias encodés de la page privée ne contournent pas les contrôles", async t => {
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), "adeoye-private-page-"));
  const privateMarker = "PRIVATE-ADEOYE-FIXTURE-ONLY";
  fs.writeFileSync(path.join(publicDir, "app.html"), '<!doctype html><html lang="fr"><body>' + privateMarker + '</body></html>');
  const f = await fixture(t, { publicDir });
  t.after(() => fs.rmSync(publicDir, { recursive: true, force: true }));
  await setup(f);
  for (const body of [[], [{}], null]) {
    const response = await f.admin.request("/api/items", "POST", body);
    assert.equal(response.status, 400, "Only a JSON object is accepted for writes");
    assert.equal(typeof response.body.error, "string");
  }
  const malformed = await fetch(f.base + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: f.base }, body: '{"username":',
  });
  assert.equal(malformed.status, 400);
  assert.equal(typeof (await malformed.json()).error, "string");
  const crossSite = await f.admin.request("/api/notes", "POST", { title: "Interdit", body: "Aucune écriture", date: today() }, { headers: { Origin: "https://attacker.invalid", "Sec-Fetch-Site": "cross-site" } });
  assert.equal(crossSite.status, 403);
  for (const route of ["/app.html", "/app%2ehtml", "/%61pp.html", "/.//app.html"]) {
    const anonymous = await f.anonymous.request(route);
    assert.ok([302, 303, 401].includes(anonymous.status), route + " requires authentication");
    assert.ok(!anonymous.text.includes(privateMarker), route + " must never expose private HTML anonymously");
    const authenticated = await f.admin.request(route);
    assert.equal(authenticated.status, 200, route + " resolves to the guarded page for a signed-in account");
    assert.ok(authenticated.text.includes(privateMarker));
    assert.match(authenticated.headers.get("cache-control") || "", /no-store/i);
  }
  const state = (await f.admin.request("/api/state")).body;
  assert.deepEqual(state.items, []);
  assert.deepEqual(state.movements, []);
  assert.deepEqual(state.notes, []);
});

test("les estimations extrêmes restent des entiers exacts et un dépassement n’altère jamais le stock", async t => {
  const f = await fixture(t);
  await setup(f);
  const refused = await f.admin.request("/api/items", "POST", itemBody({ quantity: 1000000000, unitValue: 100000000 }));
  assert.equal(refused.status, 400);
  assert.deepEqual((await f.admin.request("/api/state")).body.items, []);
  const item = await addItem(f, { quantity: 90071992, unitValue: 100000000 });
  assert.equal(item.estimatedValue, 9007199200000000);
  const before = (await f.admin.request("/api/state")).body;
  const entry = await f.admin.request("/api/movements", "POST", movement(item, { quantity: 1 }));
  assert.equal(entry.status, 400);
  const after = (await f.admin.request("/api/state")).body;
  assert.deepEqual(after.items, before.items);
  assert.deepEqual(after.movements, before.movements);
  const largeStock = await addItem(f, { quantity: 1000000000, unitValue: 0 });
  const edit = await f.admin.request("/api/items/" + largeStock.id, "PUT", { version: largeStock.version, unitValue: 100000000 });
  assert.equal(edit.status, 400);
  const unchanged = (await f.admin.request("/api/state")).body.items.find(row => row.id === largeStock.id);
  assert.equal(unchanged.unitValue, 0);
  assert.equal(unchanged.version, largeStock.version);
  const fractional = await addItem(f, { quantity: 0.001, unitValue: 1500 });
  assert.equal(fractional.estimatedValue, 2, "Half a franc is rounded to a whole franc using exact integer arithmetic");
});
