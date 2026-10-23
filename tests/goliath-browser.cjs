"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");
const { createApplication } = require("../lib/application");

// Disposable local farm: no production account, animal or sale is touched.
(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "adeoye-goliath-browser-data-"));
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "adeoye-goliath-browser-artifacts-"));
  const setupToken = "goliath-browser-isolated-setup", farmTimezone = "Africa/Porto-Novo";
  const errors = [], externalRequests = [];
  let instance, server, browser, base, page;
  try {
    instance = await createApplication({ dataDir, setupToken });
    server = instance.app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    base = "http://127.0.0.1:" + server.address().port;
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/usr/bin/chromium", args: ["--no-sandbox"] });
    async function context(options = {}) {
      const result = await browser.newContext({ locale: "fr-FR", timezoneId: "America/New_York", viewport: { width: 1440, height: 1050 }, ...options });
      await result.route(url => url.origin !== base, route => { externalRequests.push(route.request().url()); return route.abort(); });
      result.on("page", current => { current.on("pageerror", error => errors.push(error.message)); current.on("dialog", dialog => dialog.accept()); });
      return result;
    }
    const adminContext = await context();
    const setup = await adminContext.request.post(base + "/api/auth/setup", { headers: { Origin: base }, data: { token: setupToken, username: "responsable-goliath-test", password: "Goliath-owner-fixture-8293!" } });
    assert.ok(setup.ok(), await setup.text());
    const adminCsrf = (await setup.json()).csrf;
    async function api(route, method = "GET", data) {
      const response = await adminContext.request.fetch(base + route, { method, headers: { Origin: base, "X-CSRF-Token": adminCsrf }, ...(data === undefined ? {} : { data }) });
      assert.ok(response.ok(), method + " " + route + " " + response.status() + " " + await response.text());
      return response.json();
    }
    const empty = await api("/api/state");
    assert.deepEqual(empty.goliathBatches, []); assert.deepEqual(empty.goliathEvents, []);
    page = await adminContext.newPage();
    await page.goto(base + "/app.html#goliath");
    await page.locator("#add-goliath-batch").waitFor();
    assert.equal(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), "America/New_York");
    async function fillEditor(values, onPage = page) {
      for (const [name, value] of Object.entries(values)) {
        const field = onPage.locator('#editor-form [name="' + name + '"]');
        if (await field.evaluate(input => input.tagName) === "SELECT") await field.selectOption(String(value));
        else await field.fill(String(value));
      }
    }
    async function submitEditor(onPage = page) { await onPage.locator("#editor-submit").click(); await onPage.locator("#editor").waitFor({ state: "hidden" }); }
    async function selectBatch(id, onPage = page) {
      const selector = onPage.locator("#goliath-batch-select");
      if (await selector.count()) await selector.selectOption(id);
      else await onPage.locator('[data-goliath-select="' + id + '"]').click();
    }
    const farmClock = () => Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: farmTimezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
    function assertFarmTime(actual) {
      const clock = farmClock(), expected = Number(clock.hour) * 60 + Number(clock.minute), entered = Number(actual.slice(0, 2)) * 60 + Number(actual.slice(3));
      assert.ok(Math.min(Math.abs(expected - entered), 1440 - Math.abs(expected - entered)) <= 1, "Event time follows the farm, even when the browser is in the USA");
    }
    await page.locator("#add-goliath-batch").click();
    const clock = farmClock();
    assert.equal(await page.locator('#editor-form [name="arrivalDate"]').inputValue(), `${clock.year}-${clock.month}-${clock.day}`);
    await fillEditor({ name: "Goliath — premier arrivage témoin", arrivalDate: "2025-01-01", hatchDate: "", initialCount: 100, stage: "chicks", location: "Poulailler fictif A", supplier: "Couvoir témoin", notes: "Lot fictif réservé aux tests" });
    await submitEditor();
    let state = await api("/api/state");
    const firstId = state.goliathBatches[0].id;
    assert.equal(state.goliathBatches[0].ageDays, null, "Unknown birth dates never become an invented age");
    assert.equal(state.goliathBatches[0].initialCount, 100);
    assert.equal(state.goliathBatches[0].remainingCount, 100);
    assert.equal(state.items.find(item => item.id === state.goliathBatches[0].itemId).quantity, 100);
    await selectBatch(firstId);
    assert.match(await page.locator("#workspace").textContent(), /[Ââ]ge non renseigné/);
    await page.locator("#goliath-mortality").click();
    assertFarmTime(await page.locator('#editor-form [name="time"]').inputValue());
    await fillEditor({ quantity: 3, date: "2025-01-02", time: "07:15", reason: "Mortalité fictive constatée au contrôle" });
    await submitEditor();
    await page.locator("#goliath-sale").click();
    await fillEditor({ quantity: 10, date: "2025-01-03", time: "14:20", buyer: "Acheteur témoin", totalAmount: 25000, reason: "Vente de test uniquement" });
    await submitEditor();
    state = await api("/api/state");
    let first = state.goliathBatches.find(batch => batch.id === firstId);
    assert.equal(first.initialCount, 100); assert.equal(first.deadCount, 3); assert.equal(first.soldCount, 10); assert.equal(first.remainingCount, 87);
    assert.equal(first.mortalityRate, 3); assert.equal(first.salesTotal, "25000");
    for (const [selector, value] of [["#goliath-initial", "100"], ["#goliath-dead", "3"], ["#goliath-sold", "10"], ["#goliath-remaining", "87"]]) assert.equal((await page.locator(selector).textContent()).replace(/\s/g, ""), value);
    assert.match(await page.locator("#goliath-events-table").textContent(), /Acheteur témoin/);
    assert.equal(state.items.find(item => item.id === first.itemId).quantity, 87, "The inventory tracks actual live chickens rather than the original arrival count");
    const linkedMovements = state.movements.filter(movement => movement.itemId === first.itemId);
    assert.deepEqual(linkedMovements.map(movement => movement.type).sort(), ["exit", "loss", "opening"]);
    assert.equal(state.goliathEvents.find(event => event.type === "sale").date, "2025-01-03");
    await page.locator("#edit-goliath-batch").click();
    await fillEditor({ stage: "growing", hatchDate: "2024-12-31" });
    await submitEditor();
    first = (await api("/api/state")).goliathBatches.find(batch => batch.id === firstId);
    assert.equal(first.stage, "growing"); assert.ok(first.ageDays > 1); assert.equal(first.hatchDate, "2024-12-31");
    assert.match(await page.locator("#workspace").textContent(), /Croissance/);
    await page.locator("#add-goliath-batch").click();
    await fillEditor({ name: "Goliath — second arrivage témoin", arrivalDate: "2025-01-10", hatchDate: "2025-01-09", initialCount: 20, stage: "chicks", location: "Poulailler fictif B" });
    await submitEditor();
    state = await api("/api/state");
    const second = state.goliathBatches.find(batch => batch.name.includes("second arrivage"));
    assert.equal(second.remainingCount, 20);
    assert.equal(second.stage, "chicks", "An old lot is never silently assigned a biological maturity threshold");
    assert.equal(state.goliathBatches.find(batch => batch.id === firstId).remainingCount, 87, "A new arrival creates a separate lot without merging generations");
    // A polling read started before a mutation must not swallow the fresh read
    // requested by that mutation, even when its old response arrives last.
    let releaseOldRead, announceOldRead, stateReads = 0;
    const oldReadReady = new Promise(resolve => { announceOldRead = resolve; });
    const oldReadGate = new Promise(resolve => { releaseOldRead = resolve; });
    const delayedState = async route => {
      stateReads++;
      if (stateReads !== 1) return route.continue();
      const oldResponse = await route.fetch();
      announceOldRead(); await oldReadGate;
      return route.fulfill({ response: oldResponse });
    };
    await page.route("**/api/state", delayedState);
    try {
      await page.locator("#refresh").click(); await oldReadReady;
      await page.locator("#add-goliath-batch").click();
      await fillEditor({ name: "Goliath — lecture retardée", arrivalDate: "2025-01-12", initialCount: 4, stage: "chicks" });
      const saved = page.waitForResponse(response => response.url() === base + "/api/goliath/batches" && response.request().method() === "POST");
      await page.locator("#editor-submit").click(); assert.equal((await saved).status(), 201);
      await page.locator("#editor").waitFor({ state: "hidden" });
      releaseOldRead();
      await page.waitForFunction(() => document.querySelector("#goliath-lots")?.textContent.includes("Goliath — lecture retardée"), null, { timeout: 5000 });
      assert.ok(stateReads >= 2, "A new read after the committed arrival refreshes stale polling data without waiting 30 seconds");
    } finally { releaseOldRead(); await page.unroute("**/api/state", delayedState); }
    await selectBatch(firstId);
    const reportLink = page.locator("#report-goliath-batch-pdf");
    const download = page.waitForEvent("download"); await reportLink.click();
    const pdfPath = path.join(artifacts, "goliath-premier-lot-test.pdf"); await (await download).saveAs(pdfPath);
    assert.equal(fs.readFileSync(pdfPath).subarray(0, 5).toString(), "%PDF-");
    const text = execFileSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8", timeout: 30000 });
    assert.match(text, /premier arrivage témoin/); assert.ok(!text.includes("second arrivage témoin"));
    assert.match(text, /Acheteur témoin/); assert.match(text, /14:20/); assert.match(text, /07:15/);
    assert.ok(/25\s*000\s*F\s*CFA/.test(text), "Sale receipts, not an estimated stock value, appear on the report");
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({ path: path.join(artifacts, "goliath-desktop.png"), fullPage: true });

    async function lostResponseReplay({ routePattern, kind, open, values, committed }) {
      const bodies = []; let firstStatus;
      const intercept = async route => {
        if (route.request().method() !== "POST") return route.continue();
        bodies.push(route.request().postDataJSON());
        if (bodies.length === 1) { const response = await route.fetch(); firstStatus = response.status(); return route.abort("failed"); }
        return route.continue();
      };
      await page.route(routePattern, intercept);
      await open(); await fillEditor(values); await page.locator("#editor-submit").click(); await page.locator("#editor-error").waitFor({ state: "visible" });
      assert.equal(firstStatus, 201);
      const pending = await page.evaluate(() => JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(key => key.startsWith("adeoye-pending-intent:")))));
      assert.equal(pending.kind, kind); assert.deepEqual(pending.payload, bodies[0]); await committed();
      await page.reload(); await page.locator("#resume-intent").click();
      assert.ok(await page.locator("#editor-fields input").evaluateAll(inputs => inputs.every(input => input.disabled)), "Uncertain operations keep the original payload locked");
      await submitEditor(); assert.equal(bodies.length, 2); assert.deepEqual(bodies[0], bodies[1]); await committed();
      await page.unroute(routePattern, intercept);
    }
    await lostResponseReplay({ routePattern: "**/api/goliath/batches", kind: "goliath-batch", open: () => page.locator("#add-goliath-batch").click(), values: { name: "Goliath — arrivée réponse perdue", arrivalDate: "2025-01-15", initialCount: 7, stage: "chicks" }, committed: async () => {
      const snapshot = await api("/api/state"), matching = snapshot.goliathBatches.filter(batch => batch.name.includes("arrivée réponse perdue"));
      assert.equal(matching.length, 1); assert.equal(snapshot.items.filter(item => item.id === matching[0].itemId).length, 1);
      assert.equal(snapshot.movements.filter(movement => movement.itemId === matching[0].itemId && movement.type === "opening").length, 1);
    } });
    await selectBatch(firstId);
    await lostResponseReplay({ routePattern: "**/api/goliath/batches/" + firstId + "/events", kind: "goliath-event", open: () => page.locator("#goliath-sale").click(), values: { quantity: 87, date: "2025-01-20", time: "12:05", buyer: "Acheteur reprise témoin", totalAmount: 260000, reason: "Vente réponse perdue" }, committed: async () => {
      const snapshot = await api("/api/state"), batch = snapshot.goliathBatches.find(value => value.id === firstId);
      assert.equal(batch.remainingCount, 0); assert.equal(batch.soldCount, 97); assert.equal(batch.salesTotal, "285000");
      assert.equal(snapshot.goliathEvents.filter(event => event.reason === "Vente réponse perdue").length, 1);
      assert.equal(snapshot.items.find(item => item.id === batch.itemId).quantity, 0);
    } });
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("adeoye-pending-intent:")).length), 0);

    async function roleSession(role) {
      const username = role + "-goliath-test", initialPassword = "Goliath-initial-" + role + "-958!", password = "Goliath-personal-" + role + "-368!";
      await api("/api/users", "POST", { username, password: initialPassword, role });
      const result = await context();
      const login = await result.request.post(base + "/api/auth/login", { headers: { Origin: base }, data: { username, password: initialPassword } });
      assert.ok(login.ok(), await login.text()); const loginData = await login.json();
      const changed = await result.request.post(base + "/api/auth/password", { headers: { Origin: base, "X-CSRF-Token": loginData.csrf }, data: { currentPassword: initialPassword, password } });
      assert.ok(changed.ok(), await changed.text());
      return { context: result, csrf: (await changed.json()).csrf, page: await result.newPage() };
    }
    const manager = await roleSession("manager");
    await manager.page.goto(base + "/app.html#goliath"); await manager.page.locator("#add-goliath-batch").click();
    await fillEditor({ name: "Goliath — équipe sur place", arrivalDate: "2025-02-01", initialCount: 5, stage: "chicks" }, manager.page); await submitEditor(manager.page);
    assert.equal((await api("/api/state")).goliathBatches.find(batch => batch.name.includes("équipe sur place")).createdBy, "manager-goliath-test");
    const viewer = await roleSession("viewer");
    await viewer.page.goto(base + "/app.html#goliath"); await viewer.page.locator("#readonly-banner").waitFor(); await selectBatch(firstId, viewer.page);
    assert.equal(await viewer.page.locator("#add-goliath-batch,#goliath-mortality,#goliath-sale,#edit-goliath-batch").count(), 0);
    const denied = await viewer.context.request.post(base + "/api/goliath/batches/" + firstId + "/events", { headers: { Origin: base, "X-CSRF-Token": viewer.csrf }, data: { requestId: crypto.randomUUID(), type: "sale", quantity: 1, date: "2025-01-21", time: "12:00", totalAmount: 100 } });
    assert.equal(denied.status(), 403);
    const deniedArrival = await viewer.context.request.post(base + "/api/goliath/batches", { headers: { Origin: base, "X-CSRF-Token": viewer.csrf }, data: { requestId: crypto.randomUUID(), name: "Arrivée interdite au lecteur", arrivalDate: "2025-01-21", initialCount: 10 } });
    assert.equal(deniedArrival.status(), 403);
    const viewerPdf = await viewer.context.request.get(base + "/api/reports/goliath.pdf?batchId=" + firstId);
    assert.ok(viewerPdf.ok()); assert.equal((await viewerPdf.body()).subarray(0, 5).toString(), "%PDF-");
    await page.locator('[data-page="inventory"]').click();
    const linkedRow = page.locator("#inventory-table tr").filter({ hasText: "Goliath — premier arrivage témoin" });
    assert.equal(await linkedRow.locator("[data-item-edit],[data-item-entry],[data-item-exit],[data-item-archive]").count(), 0, "Linked livestock cannot be changed through ordinary inventory actions");
    assert.match(await linkedRow.textContent(), /Goliath/);
    await viewer.page.setViewportSize({ width: 390, height: 844 });
    await viewer.page.waitForFunction(() => document.querySelector("#sidebar").getBoundingClientRect().right <= 1);
    assert.equal(await viewer.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    for (const selector of ["#readonly-banner", "#report-goliath-batch-pdf"]) {
      const box = await viewer.page.locator(selector).boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 391, "Goliath mobile control fits viewport: " + selector);
    }
    await viewer.page.screenshot({ path: path.join(artifacts, "goliath-mobile-consultation.png"), fullPage: true });
    assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
    console.log("PASS Goliath : lots distincts, âge connu/inconnu, stades, mortalités, ventes et recettes, inventaire synchronisé, PDF, reprises de lot et vente sans doublon, gestionnaire/consultation et mobile390. Artefacts : " + artifacts);
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
    console.error("Artefacts de diagnostic : " + artifacts); throw error;
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    if (instance) await instance.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
