"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createApplication } = require("../lib/application");
const { batchValue } = require("../lib/goliath");

const PASSWORD = "Goliath-owner-fixture-583!";
const INITIAL = "Goliath-initial-fixture-582!";
const PERSONAL = "Goliath-personal-fixture-581!";
const lot = fields => ({ requestId: crypto.randomUUID(), name: "Lot fictif de poussins Goliath", arrivalDate: "2025-01-10", hatchDate: "2025-01-08", initialCount: 100, stage: "chicks", location: "Bâtiment de test", supplier: "Couvoir fictif", notes: "Aucun élevage réel dans ces tests", ...fields });
const operation = fields => ({ requestId: crypto.randomUUID(), type: "mortality", quantity: 2, date: "2025-01-12", time: "08:30", reason: "Observation fictive de test", buyer: "", totalAmount: null, ...fields });

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "adeoye-goliath-test-"));
  let instance, server, base;
  async function close() {
    if (server) { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); server = null; }
    if (instance) { await instance.db.close(); instance = null; }
  }
  async function start() {
    instance = await createApplication({ dataDir, setupToken: "goliath-fixture-only" });
    server = instance.app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    base = "http://127.0.0.1:" + server.address().port;
  }
  function client() {
    let cookie = "", csrf = "";
    return {
      async request(route, method = "GET", data, options = {}) {
        const response = await fetch(base + route, { method, redirect: "manual", headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...(method === "GET" ? {} : { Origin: base }), ...(csrf && method !== "GET" && !options.noCsrf ? { "X-CSRF-Token": csrf } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
        for (const value of response.headers.getSetCookie()) cookie = value.split(";", 1)[0];
        const bytes = Buffer.from(await response.arrayBuffer());
        const body = (response.headers.get("content-type") || "").includes("application/json") ? JSON.parse(bytes.toString()) : undefined;
        if (body?.csrf) csrf = body.csrf;
        return { status: response.status, body, bytes, headers: response.headers };
      },
    };
  }
  await start();
  t.after(async () => { await close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const admin = client(), anonymous = client();
  assert.equal((await admin.request("/api/auth/setup", "POST", { token: "goliath-fixture-only", username: "responsable-goliath", password: PASSWORD })).status, 200);
  async function account(role) {
    const username = "goliath-" + role;
    assert.equal((await admin.request("/api/users", "POST", { username, password: INITIAL, role })).status, 201);
    const account = client();
    assert.equal((await account.request("/api/auth/login", "POST", { username, password: INITIAL })).status, 200);
    assert.equal((await account.request("/api/goliath")).status, 403, "An initial password does not yet expose the farm data");
    assert.equal((await account.request("/api/auth/password", "POST", { currentPassword: INITIAL, password: PERSONAL })).status, 200);
    return account;
  }
  return { admin, anonymous, account, client, close, start, get db() { return instance.db; } };
}

test("Goliath privé : lots vides, rôles responsables/équipe et consultation seule avec CSRF", async t => {
  const f = await fixture(t);
  assert.equal((await f.anonymous.request("/api/goliath")).status, 401);
  assert.equal((await f.anonymous.request("/api/reports/goliath.pdf")).status, 401);
  assert.equal((await f.anonymous.request("/api/goliath/batches", "POST", lot())).status, 401);
  assert.equal((await f.admin.request("/api/goliath/batches", "POST", lot(), { noCsrf: true })).status, 403);
  assert.deepEqual((await f.admin.request("/api/goliath")).body, { batches: [], events: [] });
  const manager = await f.account("manager"), viewer = await f.account("viewer");
  const added = await manager.request("/api/goliath/batches", "POST", lot());
  assert.equal(added.status, 201, added.body?.error);
  assert.equal(added.body.createdBy, "goliath-manager");
  assert.equal((await viewer.request("/api/goliath")).body.batches[0].id, added.body.id);
  assert.equal((await viewer.request("/api/goliath/batches", "POST", lot())).status, 403);
  assert.equal((await viewer.request("/api/goliath/batches/" + added.body.id, "PUT", { version: 1, stage: "adult" })).status, 403);
  assert.equal((await viewer.request("/api/goliath/batches/" + added.body.id + "/events", "POST", operation())).status, 403);
  const report = await viewer.request("/api/reports/goliath.pdf?batchId=" + added.body.id);
  assert.equal(report.status, 200, report.body?.error);
  assert.equal(report.bytes.subarray(0, 5).toString(), "%PDF-");
});

test("chaque arrivée est séparée, effectifs et stock synchronisés, mortalités et ventes datées", async t => {
  const f = await fixture(t);
  const first = (await f.admin.request("/api/goliath/batches", "POST", lot())).body;
  const second = (await f.admin.request("/api/goliath/batches", "POST", lot({ initialCount: 25, arrivalDate: "2025-02-01", hatchDate: null }))).body;
  assert.equal(first.remainingCount, 100); assert.equal(second.remainingCount, 25); assert.notEqual(first.itemId, second.itemId);
  const death = await f.admin.request("/api/goliath/batches/" + first.id + "/events", "POST", operation({ quantity: 3 }));
  assert.equal(death.status, 201, death.body?.error); assert.equal(death.body.remainingAfter, 97);
  const sale = await f.admin.request("/api/goliath/batches/" + first.id + "/events", "POST", operation({ type: "sale", quantity: 20, date: "2025-03-01", time: "11:15", buyer: "Acheteur fictif", totalAmount: 125000 }));
  assert.equal(sale.status, 201, sale.body?.error); assert.equal(sale.body.totalAmount, 125000); assert.equal(sale.body.remainingAfter, 77);
  const unknownSale = await f.admin.request("/api/goliath/batches/" + first.id + "/events", "POST", operation({ type: "sale", quantity: 1, date: "2025-03-02", buyer: "Acheteur sans prix de test" }));
  assert.equal(unknownSale.status, 201); assert.equal(unknownSale.body.totalAmount, null);
  const state = (await f.admin.request("/api/state")).body, batch = state.goliathBatches.find(row => row.id === first.id), item = state.items.find(row => row.id === first.itemId);
  assert.equal(batch.deadCount, 3); assert.equal(batch.soldCount, 21); assert.equal(batch.remainingCount, 76); assert.equal(batch.mortalityRate, 3);
  assert.equal(batch.salesTotal, "125000"); assert.equal(batch.unpricedSalesCount, 1);
  assert.equal(item.quantity, 76); assert.equal(item.goliathBatchId, first.id); assert.equal(item.category, "Animaux"); assert.equal(item.unit, "tête");
  assert.equal(state.items.find(row => row.id === second.itemId).quantity, 25);
  const linked = state.movements.filter(row => row.itemId === first.itemId);
  assert.deepEqual(linked.map(row => row.type).sort(), ["exit", "exit", "loss", "opening"]);
  assert.equal(linked.find(row => row.id === death.body.id).quantity, 3); assert.equal(linked.find(row => row.id === sale.body.id).date, "2025-03-01");
  assert.deepEqual(state.expenses, [], "A chick arrival or sale never invents an expense or payment");
  assert.equal(state.goliathBatches.find(row => row.id === second.id).ageDays, null);
});

test("reprises et sorties concurrentes atomiques empêchent les doublons et les effectifs négatifs", async t => {
  const f = await fixture(t), body = lot({ initialCount: 10 });
  const copies = await Promise.all([f.admin.request("/api/goliath/batches", "POST", body), f.admin.request("/api/goliath/batches", "POST", body)]);
  assert.ok(copies.every(result => result.status === 201)); assert.equal(copies[0].body.id, copies[1].body.id);
  assert.equal((await f.admin.request("/api/goliath/batches", "POST", { ...body, initialCount: 12 })).status, 409);
  const id = copies[0].body.id, route = "/api/goliath/batches/" + id + "/events", event = operation({ quantity: 3 });
  const repeated = await Promise.all([f.admin.request(route, "POST", event), f.admin.request(route, "POST", event)]);
  assert.ok(repeated.every(result => result.status === 201)); assert.deepEqual(repeated[0].body, repeated[1].body);
  assert.equal((await f.admin.request(route, "POST", { ...event, quantity: 4 })).status, 409);
  const manager = await f.account("manager");
  assert.equal((await manager.request(route, "POST", event)).status, 409, "Request reference is tied to its original author");
  const concurrent = await Promise.all([f.admin.request(route, "POST", operation({ quantity: 5 })), manager.request(route, "POST", operation({ type: "sale", quantity: 5, totalAmount: 25000 }))]);
  assert.equal(concurrent.filter(result => result.status === 201).length, 1); assert.equal(concurrent.filter(result => result.status === 409).length, 1);
  const state = (await f.admin.request("/api/state")).body;
  assert.equal(state.goliathBatches[0].remainingCount, 2); assert.equal(state.items[0].quantity, 2); assert.equal(state.goliathEvents.length, 2); assert.equal(state.movements.length, 3);
});

test("les fiches liées restent cohérentes et le stade se modifie par version sans effacer l’historique", async t => {
  const f = await fixture(t), batch = (await f.admin.request("/api/goliath/batches", "POST", lot())).body;
  for (const [route, method, payload] of [
    ["/api/items/" + batch.itemId, "PUT", { version: 1, name: "Modification non liée" }],
    ["/api/items/" + batch.itemId + "/archive", "POST", { version: 1 }],
    ["/api/movements", "POST", { requestId: crypto.randomUUID(), itemId: batch.itemId, type: "entry", quantity: 5, reason: "Modification manuelle refusée", date: "2025-01-12" }],
  ]) {
    const rejected = await f.admin.request(route, method, payload); assert.equal(rejected.status, 409); assert.match(rejected.body.error, /Élevage Goliath/);
  }
  const edited = await f.admin.request("/api/goliath/batches/" + batch.id, "PUT", { version: 1, name: "Lot adulte fictif", stage: "adult", location: "Poulailler adulte de test", notes: "Changement de stade observé" });
  assert.equal(edited.status, 200, edited.body?.error); assert.equal(edited.body.stage, "adult"); assert.equal(edited.body.version, 2);
  assert.equal((await f.admin.request("/api/goliath/batches/" + batch.id, "PUT", { version: 1, stage: "growing" })).status, 409);
  assert.equal((await f.admin.request("/api/goliath/batches/" + batch.id, "PUT", { version: 2, initialCount: 999 })).status, 400);
  const state = (await f.admin.request("/api/state")).body;
  assert.equal(state.items[0].name, "Lot adulte fictif"); assert.equal(state.items[0].location, "Poulailler adulte de test"); assert.equal(state.items[0].quantity, 100);
  assert.equal(state.movements[0].itemName, batch.name, "The initial historical name is preserved");
  const raw = await f.db.prepare("SELECT * FROM adeoye_goliath_batches WHERE id=?").get(batch.id);
  const age = batchValue(raw, [], "Pacific/Kiritimati", new Date("2025-01-15T10:30:00Z"));
  assert.equal(age.ageDays, 8); assert.equal(age.daysSinceArrival, 6); assert.equal(age.stage, "adult", "No breed-specific adulthood age is invented");
});

test("effectifs entiers, bornes, dates d’arrivée et ventes impossibles sont refusés avant toute écriture", async t => {
  const f = await fixture(t);
  for (const values of [{ initialCount: 0 }, { initialCount: 1.5 }, { initialCount: -1 }, { initialCount: true }, { initialCount: "1e3" }, { initialCount: 1000000001 }, { name: "" }, { stage: "unknown" }, { arrivalDate: "2025-02-30" }, { arrivalDate: "2099-01-01" }, { hatchDate: "2025-01-11" }]) assert.equal((await f.admin.request("/api/goliath/batches", "POST", lot(values))).status, 400, JSON.stringify(values));
  assert.deepEqual((await f.admin.request("/api/state")).body.items, []);
  const batch = (await f.admin.request("/api/goliath/batches", "POST", lot())).body, route = "/api/goliath/batches/" + batch.id + "/events";
  for (const values of [{ quantity: 0 }, { quantity: 1.5 }, { quantity: true }, { type: "entry" }, { date: "2025-01-09" }, { date: "2025-02-30" }, { date: "2099-01-01" }, { time: "24:00" }, { time: "1:00" }, { totalAmount: 100 }, { buyer: "Acheteur pour mortalité" }, { type: "sale", totalAmount: 0 }, { type: "sale", totalAmount: 1.2 }, { type: "sale", totalAmount: 1000000000001 }]) assert.equal((await f.admin.request(route, "POST", operation(values))).status, 400, JSON.stringify(values));
  assert.equal((await f.admin.request(route, "POST", operation({ quantity: 101 }))).status, 409);
  for (const query of ["batchId=wrong", "batchId=", "batchId=" + batch.id + "&batchId=" + batch.id, "from=2025-01-01"]) assert.equal((await f.admin.request("/api/reports/goliath.pdf?" + query)).status, 400);
  const state = (await f.admin.request("/api/state")).body;
  assert.equal(state.goliathEvents.length, 0); assert.equal(state.items[0].quantity, 100);
});

test("totaux de ventes exacts, prix inconnu distinct de zéro et reprise garde le fuseau historique", async t => {
  const f = await fixture(t), batch = (await f.admin.request("/api/goliath/batches", "POST", lot())).body, route = "/api/goliath/batches/" + batch.id + "/events";
  const body = operation({ type: "sale", quantity: 1, totalAmount: 1000000000000 });
  const first = await f.admin.request(route, "POST", body); assert.equal(first.status, 201);
  await f.admin.request(route, "POST", operation({ type: "sale", quantity: 1, totalAmount: 1000000000000 }));
  await f.admin.request(route, "POST", operation({ type: "sale", quantity: 1 }));
  const settings = (await f.admin.request("/api/settings")).body;
  assert.equal((await f.admin.request("/api/settings", "PUT", { ...settings, timezone: "America/New_York" })).status, 200);
  const replay = await f.admin.request(route, "POST", body); assert.equal(replay.status, 201); assert.equal(replay.body.timezone, "Africa/Porto-Novo");
  const result = (await f.admin.request("/api/goliath")).body;
  assert.equal(result.batches[0].salesTotal, "2000000000000"); assert.equal(result.batches[0].unpricedSalesCount, 1);
  const raw = await f.db.prepare("SELECT * FROM adeoye_goliath_batches WHERE id=?").get(batch.id);
  const events = Array.from({ length: 10000 }, () => ({ batchId: batch.id, type: "sale", totalAmount: 999999999999 }));
  assert.equal(batchValue(raw, events).salesTotal, "9999999999990000");
});

test("migration additive et redémarrage conservent comptes, dépenses, inventaire et lots", async t => {
  const f = await fixture(t);
  const inventory = await f.admin.request("/api/items", "POST", { requestId: crypto.randomUUID(), name: "Sac fictif existant", category: "Aliments et intrants", unit: "sac", quantity: 3, minQuantity: 1, unitValue: 5000 });
  assert.equal(inventory.status, 201);
  const expense = await f.admin.request("/api/expenses", "POST", { requestId: crypto.randomUUID(), description: "Dépense fictive existante", category: "Transport", amount: 3500, date: "2025-01-01", time: "08:00" }); assert.equal(expense.status, 201);
  const before = (await f.admin.request("/api/state")).body;
  await f.db.exec("DROP TABLE adeoye_goliath_events; DROP TABLE adeoye_goliath_batches;");
  await f.close(); await f.start();
  const reader = f.client();
  assert.equal((await reader.request("/api/auth/login", "POST", { username: "responsable-goliath", password: PASSWORD })).status, 200);
  const migrated = (await reader.request("/api/state")).body;
  assert.deepEqual(migrated.items, before.items); assert.deepEqual(migrated.expenses, before.expenses); assert.deepEqual(migrated.movements, before.movements); assert.deepEqual(migrated.goliathBatches, []);
  const added = await reader.request("/api/goliath/batches", "POST", lot({ hatchDate: null })); assert.equal(added.status, 201);
  assert.equal((await reader.request("/api/goliath/batches/" + added.body.id + "/events", "POST", operation())).status, 201);
  await f.close(); await f.start();
  const afterRestart = f.client(); assert.equal((await afterRestart.request("/api/auth/login", "POST", { username: "responsable-goliath", password: PASSWORD })).status, 200);
  const saved = (await afterRestart.request("/api/state")).body;
  assert.equal(saved.goliathBatches[0].remainingCount, 98); assert.equal(saved.goliathBatches[0].ageDays, null); assert.equal(saved.goliathEvents.length, 1);
  assert.equal(saved.items.find(row => row.id === added.body.itemId).quantity, 98); assert.deepEqual(saved.expenses, before.expenses);
});
