"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");
const { createApplication } = require("../lib/application");

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "adeoye-browser-data-"));
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "adeoye-browser-artifacts-"));
  const setupToken = "adeoye-browser-isolated-setup";
  const adminPassword = "Test-admin-ADEOYE-5930!";
  const viewerInitialPassword = "Test-viewer-initial-5930!";
  const viewerPassword = "Test-viewer-personal-5930!";
  const errors = [], externalRequests = [];
  let instance, server, browser;
  const today = new Date().toISOString().slice(0, 10);
  let base;
  async function stopServer() {
    if (!server) return;
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    server = null;
  }
  try {
    instance = await createApplication({ dataDir, setupToken });
    server = instance.app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    base = "http://127.0.0.1:" + server.address().port;
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/usr/bin/chromium", args: ["--no-sandbox"] });
    async function context(options = {}) {
      const result = await browser.newContext({ locale: "fr-FR", viewport: { width: 1440, height: 1000 }, ...options });
      await result.route(url => url.origin !== base, route => { externalRequests.push(route.request().url()); return route.abort(); });
      result.on("page", page => page.on("pageerror", error => errors.push(error.message)));
      return result;
    }
    const adminContext = await context();
    const page = await adminContext.newPage();
    assert.deepEqual(await (await adminContext.request.get(base + "/api/auth/status")).json(), { initialized: false });
    assert.equal((await adminContext.request.get(base + "/api/state")).status(), 401);
    const protectedPage = await adminContext.request.get(base + "/app.html", { maxRedirects: 0 });
    assert.ok([302, 303, 401].includes(protectedPage.status()), "The private workspace cannot be loaded anonymously");
    await page.goto(base);
    assert.ok((await page.locator("body").textContent()).includes("ADEOYE"));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(artifacts, "accueil-desktop.png"), fullPage: true });
    const setup = await adminContext.request.post(base + "/api/auth/setup", { headers: { Origin: base }, data: { token: setupToken, username: "responsable-test", password: adminPassword } });
    assert.ok(setup.ok(), await setup.text());
    let adminCsrf = (await setup.json()).csrf;
    async function api(route, method = "GET", data) {
      const response = await adminContext.request.fetch(base + route, { method, headers: { Origin: base, "X-CSRF-Token": adminCsrf }, ...(data === undefined ? {} : { data }) });
      assert.ok(response.ok(), method + " " + route + " " + response.status() + " " + await response.text());
      return response.json();
    }
    const emptyState = await api("/api/state");
    assert.deepEqual(emptyState.items, [], "No fictitious inventory is seeded");
    assert.deepEqual(emptyState.movements, []);
    await api("/api/auth/logout", "POST", {});
    await page.goto(base + "/connexion.html");
    await page.getByLabel("Identifiant", { exact: true }).fill("responsable-test");
    await page.getByLabel("Mot de passe", { exact: true }).fill(adminPassword);
    await page.getByRole("button", { name: "Se connecter", exact: true }).click();
    await page.locator("#workspace").waitFor();
    adminCsrf = (await (await adminContext.request.get(base + "/api/auth/me")).json()).csrf;
    async function nav(target, onPage = page) {
      const button = onPage.locator('[data-page="' + target + '"]');
      await button.waitFor({ state: "attached" });
      const toggle = onPage.locator("#mobile-menu, #menu-toggle, #sidebar-toggle, [data-menu-toggle]").first();
      if (await toggle.count() && await toggle.isVisible()) {
        const expanded = await toggle.getAttribute("aria-expanded");
        if (expanded !== "true") await toggle.click();
      }
      await button.click();
    }
    async function submitEditor(onPage = page) {
      await onPage.locator("#editor-submit").click();
      await onPage.locator("#editor").waitFor({ state: "hidden" });
    }
    async function fillEditor(values, onPage = page) {
      for (const [name, value] of Object.entries(values)) {
        const field = onPage.locator('#editor-form [name="' + name + '"]');
        const tag = await field.evaluate(input => input.tagName);
        if (tag === "SELECT") await field.selectOption(String(value));
        else await field.fill(String(value));
      }
    }
    await nav("inventory");
    await page.locator("#add-item").click();
    await fillEditor({ name: "Maïs de test accentué", category: "Aliments et intrants", unit: "kg", location: "Magasin de test", quantity: 10, minQuantity: 3, unitValue: 450, notes: "Dossier fictif pour vérification" });
    await submitEditor();
    await page.locator("#inventory-table").filter({ hasText: "Maïs de test accentué" }).waitFor();
    let state = await api("/api/state");
    assert.equal(state.items.length, 1);
    const item = state.items[0];
    assert.equal(item.quantity, 10);
    assert.equal(state.movements.filter(movement => movement.type === "opening").length, 1);
    await nav("movements");
    await page.locator("#add-movement").click();
    await fillEditor({ itemId: item.id, type: "exit", quantity: 2.5, reason: "Alimentation des animaux de test", date: today });
    await submitEditor();
    state = await api("/api/state");
    assert.equal(state.items[0].quantity, 7.5);
    assert.equal(state.movements.filter(movement => movement.type === "exit").length, 1);
    await page.locator("#add-movement").click();
    await fillEditor({ itemId: item.id, type: "loss", quantity: 1.5, reason: "Perte constatée lors du contrôle de test", date: today });
    await submitEditor();
    state = await api("/api/state");
    assert.equal(state.items[0].quantity, 6);
    const beforeInvalid = state.movements.length;
    const tooMuch = await adminContext.request.post(base + "/api/movements", { headers: { Origin: base, "X-CSRF-Token": adminCsrf }, data: { requestId: crypto.randomUUID(), itemId: item.id, type: "exit", quantity: 7, reason: "Sortie excessive refusée", date: today } });
    assert.ok([400, 409].includes(tooMuch.status()));
    state = await api("/api/state");
    assert.equal(state.items[0].quantity, 6);
    assert.equal(state.movements.length, beforeInvalid);
    await nav("journal");
    await page.locator("#add-note").click();
    await fillEditor({ title: "Contrôle de test du magasin", body: "Stock physique compté ; zone propre et ventilée.", date: today });
    await submitEditor();
    assert.ok((await page.locator("#workspace").textContent()).includes("Contrôle de test du magasin"));
    await nav("reports");
    const downloadPdf = page.waitForEvent("download");
    await page.locator("#report-inventory-pdf").click();
    const pdf = await downloadPdf;
    const pdfPath = path.join(artifacts, "inventaire-test.pdf");
    await pdf.saveAs(pdfPath);
    assert.equal(fs.readFileSync(pdfPath).subarray(0, 5).toString(), "%PDF-");
    const text = execFileSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8", timeout: 30000 });
    assert.match(text, /ADEOYE/);
    assert.match(text, /Maïs de test accentué/);
    assert.match(text, /Magasin de test/);
    assert.ok(!text.includes(adminPassword) && !text.includes(viewerInitialPassword), "Reports must not expose credentials");
    const downloadCsv = page.waitForEvent("download");
    await page.locator("#report-inventory-csv").click();
    const csv = await downloadCsv;
    const csvPath = path.join(artifacts, "inventaire-test.csv");
    await csv.saveAs(csvPath);
    assert.ok(fs.readFileSync(csvPath, "utf8").includes("Maïs de test accentué"));
    await nav("users");
    await page.locator("#add-user").click();
    await fillEditor({ username: "consultation-usa-test", password: viewerInitialPassword, role: "viewer" });
    await submitEditor();
    const users = await api("/api/users");
    const viewer = users.users.find(user => user.username === "consultation-usa-test");
    assert.equal(viewer.role, "viewer");
    assert.equal(viewer.mustChangePassword, true);
    const viewerContext = await context();
    const viewerPage = await viewerContext.newPage();
    await viewerPage.goto(base + "/connexion.html");
    await viewerPage.getByLabel("Identifiant", { exact: true }).fill("consultation-usa-test");
    await viewerPage.getByLabel("Mot de passe", { exact: true }).fill(viewerInitialPassword);
    await viewerPage.getByRole("button", { name: "Se connecter", exact: true }).click();
    await viewerPage.locator("#password-dialog").waitFor({ state: "visible" });
    await viewerPage.locator('#password-form [name="currentPassword"]').fill(viewerInitialPassword);
    await viewerPage.locator('#password-form [name="password"]').fill(viewerPassword);
    await viewerPage.locator('#password-form [name="confirmPassword"]').fill(viewerPassword);
    await viewerPage.locator('#password-form button[type="submit"]').click();
    await viewerPage.locator("#password-dialog").waitFor({ state: "hidden" });
    await viewerPage.locator("#readonly-banner").waitFor({ state: "visible" });
    assert.equal(await viewerPage.locator('[data-page="users"]').count(), 0);
    assert.equal(await viewerPage.locator('[data-page="settings"]').count(), 0);
    await nav("inventory", viewerPage);
    assert.equal(await viewerPage.locator("#add-item").count(), 0);
    assert.equal(await viewerPage.locator("[data-item-edit],[data-item-entry],[data-item-exit],[data-item-archive]").count(), 0);
    assert.ok((await viewerPage.locator("#inventory-table").textContent()).includes("Maïs de test accentué"));
    const viewerMe = await (await viewerContext.request.get(base + "/api/auth/me")).json();
    const rejectedWrite = await viewerContext.request.post(base + "/api/movements", { headers: { Origin: base, "X-CSRF-Token": viewerMe.csrf }, data: { requestId: crypto.randomUUID(), itemId: item.id, type: "entry", quantity: 50, reason: "Modification interdite au lecteur", date: today } });
    assert.equal(rejectedWrite.status(), 403);
    assert.equal((await viewerContext.request.get(base + "/api/users")).status(), 403);
    const entryIntent = { requestId: crypto.randomUUID(), itemId: item.id, type: "entry", quantity: 4, reason: "Livraison enregistrée pendant consultation distante", date: today };
    await api("/api/movements", "POST", entryIntent);
    await api("/api/movements", "POST", entryIntent);
    assert.equal((await api("/api/state")).items[0].quantity, 10, "Retrying an uncertain write cannot double stock");
    await viewerPage.locator("#refresh").click();
    await viewerPage.waitForFunction(() => document.querySelector("#inventory-table")?.textContent.includes("10"));
    const shared = await (await viewerContext.request.get(base + "/api/state")).json();
    assert.equal(shared.items[0].quantity, 10);
    assert.equal(shared.movements.length, 4);
    assert.equal(shared.notes.length, 1);
    await viewerPage.screenshot({ path: path.join(artifacts, "inventaire-lecture-desktop.png"), fullPage: true });
    await viewerPage.setViewportSize({ width: 390, height: 844 });
    for (const target of ["dashboard", "inventory", "movements", "journal", "reports"]) {
      await nav(target, viewerPage);
      assert.equal(await viewerPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "Mobile page cannot overflow: " + target);
    }
    await nav("dashboard", viewerPage);
    if (await viewerPage.locator("#mobile-backdrop").isVisible()) await viewerPage.locator("#mobile-backdrop").click({ position: { x: 370, y: 100 } });
    await viewerPage.screenshot({ path: path.join(artifacts, "tableau-de-bord-mobile.png"), fullPage: true });
    await nav("inventory", page);
    await page.screenshot({ path: path.join(artifacts, "inventaire-admin-desktop.png"), fullPage: true });

    // The server commits successfully but the browser loses that response.
    // A reload must restore the original UUID before any retry is possible.
    async function lostResponseRecovery(route, createDraft, inspectCommitted) {
      const bodies = [];
      let committedStatus = null;
      const handler = async intercepted => {
        if (intercepted.request().method() !== "POST") return intercepted.continue();
        bodies.push(intercepted.request().postDataJSON());
        if (bodies.length === 1) {
          const response = await intercepted.fetch();
          committedStatus = response.status();
          return intercepted.abort("failed");
        }
        return intercepted.continue();
      };
      await page.route("**" + route, handler);
      await createDraft();
      await page.locator("#editor-submit").click();
      await page.locator("#editor-error").waitFor({ state: "visible" });
      assert.equal(committedStatus, 201, "The server committed the operation before its response was lost");
      assert.equal(bodies.length, 1);
      const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(key => key.startsWith("adeoye-pending-intent:")))));
      assert.deepEqual(saved.payload, bodies[0], "The complete original intent is persisted before a reply is received");
      await inspectCommitted(await api("/api/state"));
      page.once("dialog", dialog => dialog.accept());
      await page.reload();
      await page.locator("#resume-intent").click();
      await page.locator("#editor").waitFor({ state: "visible" });
      assert.ok(await page.locator("#editor-fields input").evaluateAll(inputs => inputs.every(input => input.disabled)), "An uncertain operation cannot silently change its payload");
      await submitEditor();
      assert.equal(bodies.length, 2);
      assert.deepEqual(bodies[1], bodies[0], "Reload and retry preserve the original request UUID and payload");
      await inspectCommitted(await api("/api/state"));
      assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("adeoye-pending-intent:")).length), 0, "A confirmed retry clears the persisted intent");
      await page.unroute("**" + route, handler);
    }
    await lostResponseRecovery("/api/items", async () => {
      await nav("inventory");
      await page.locator("#add-item").click();
      await fillEditor({ name: "Article réponse perdue", category: "Cultures et récoltes", unit: "kg", location: "Zone de test", quantity: 12, minQuantity: 2, unitValue: 300, notes: "Reprise d’une réponse perdue après enregistrement" });
    }, async committed => {
      const matching = committed.items.filter(value => value.name === "Article réponse perdue");
      assert.equal(matching.length, 1);
      assert.equal(matching[0].quantity, 12);
      assert.equal(committed.movements.filter(value => value.itemId === matching[0].id).length, 1, "The opening balance is counted only once");
    });
    const recoveryItem = (await api("/api/state")).items.find(value => value.name === "Article réponse perdue");
    await lostResponseRecovery("/api/movements", async () => {
      await nav("movements");
      await page.locator("#add-movement").click();
      await fillEditor({ itemId: recoveryItem.id, type: "entry", quantity: 2.125, reason: "Livraison avec réponse perdue après validation", date: today });
    }, async committed => {
      assert.equal(committed.items.find(value => value.id === recoveryItem.id).quantity, 14.125);
      assert.equal(committed.movements.filter(value => value.itemId === recoveryItem.id).length, 2, "The recovered delivery affects stock exactly once");
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, [], "The platform does not load third-party scripts or contact outside services");
    await browser.close(); browser = null;
    await stopServer();
    await instance.db.close(); instance = null;
    instance = await createApplication({ dataDir, setupToken });
    server = instance.app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    const persistedBase = "http://127.0.0.1:" + server.address().port;
    const persistedBrowser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/usr/bin/chromium", args: ["--no-sandbox"] });
    try {
      const requestContext = await persistedBrowser.newContext();
      const login = await requestContext.request.post(persistedBase + "/api/auth/login", { headers: { Origin: persistedBase }, data: { username: "consultation-usa-test", password: viewerPassword } });
      assert.ok(login.ok());
      const persisted = await (await requestContext.request.get(persistedBase + "/api/state")).json();
      assert.equal(persisted.items.find(value => value.id === item.id).quantity, 10);
      assert.equal(persisted.items.find(value => value.id === recoveryItem.id).quantity, 14.125);
      assert.equal(persisted.movements.length, 6);
      assert.equal(persisted.notes.length, 1);
    } finally { await persistedBrowser.close(); }
    console.log("PASS ADEOYE : données initiales vides, connexion, inventaire et mouvements tracés, stock non négatif et idempotent, réponses perdues après enregistrement puis rechargement sans double article ni livraison, PDF/CSV, journal, compte distant lecture seule/changement du mot de passe, partage entre sessions, persistance et mobile. Artefacts : " + artifacts);
  } finally {
    if (browser) await browser.close();
    await stopServer();
    if (instance) await instance.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
