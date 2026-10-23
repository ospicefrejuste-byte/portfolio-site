"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");
const { createApplication } = require("../lib/application");

// All accounts, purchases and files belong to this disposable local fixture.
(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "adeoye-expenses-browser-data-"));
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "adeoye-expenses-browser-artifacts-"));
  const setupToken = "expenses-browser-isolated-setup";
  const farmTimezone = "Africa/Porto-Novo";
  const errors = [], externalRequests = [];
  let instance, server, browser, base;
  try {
    instance = await createApplication({ dataDir, setupToken });
    server = instance.app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    base = "http://127.0.0.1:" + server.address().port;
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/usr/bin/chromium", args: ["--no-sandbox"] });
    async function context(options = {}) {
      const value = await browser.newContext({ locale: "fr-FR", timezoneId: "America/New_York", viewport: { width: 1440, height: 1000 }, ...options });
      await value.route(url => url.origin !== base, route => { externalRequests.push(route.request().url()); return route.abort(); });
      value.on("page", page => page.on("pageerror", error => errors.push(error.message)));
      return value;
    }
    const adminContext = await context();
    const setup = await adminContext.request.post(base + "/api/auth/setup", { headers: { Origin: base }, data: { token: setupToken, username: "responsable-depenses-test", password: "Expenses-admin-fixture-5830!" } });
    assert.ok(setup.ok(), await setup.text());
    const adminCsrf = (await setup.json()).csrf;
    async function api(route, method = "GET", data) {
      const response = await adminContext.request.fetch(base + route, { method, headers: { Origin: base, "X-CSRF-Token": adminCsrf }, ...(data === undefined ? {} : { data }) });
      assert.ok(response.ok(), method + " " + route + " " + response.status() + " " + await response.text());
      return response.json();
    }
    const empty = await api("/api/state");
    assert.deepEqual(empty.expenses, [], "No purchases are seeded in a newly created farm");
    await api("/api/settings", "PUT", { ...empty.settings, timezone: farmTimezone });
    const expense = (description, date, amount, time = "08:30") => ({ requestId: crypto.randomUUID(), description, category: "Autres", supplier: "Fournisseur fictif de test", amount, date, time, notes: "Aucune dépense réelle" });
    for (const draft of [expense("Borne début janvier", "2025-01-01", 100), expense("Borne fin janvier", "2025-01-31", 200, "23:59"), expense("Hors période décembre", "2024-12-31", 5000), expense("Hors période février", "2025-02-01", 8000)]) await api("/api/expenses", "POST", draft);
    const page = await adminContext.newPage();
    await page.goto(base + "/app.html#expenses");
    await page.locator("#add-expense").waitFor();
    assert.equal(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), "America/New_York");
    async function fillEditor(values, onPage = page) {
      for (const [name, value] of Object.entries(values)) {
        const input = onPage.locator('#editor-form [name="' + name + '"]');
        if (await input.evaluate(field => field.tagName) === "SELECT") await input.selectOption(String(value));
        else await input.fill(String(value));
      }
    }
    async function submitEditor(onPage = page) {
      await onPage.locator("#editor-submit").click();
      await onPage.locator("#editor").waitFor({ state: "hidden" });
    }
    async function filterPeriod(onPage = page, from = "2025-01-01", to = "2025-01-31") {
      await onPage.locator("#expense-from").fill(from);
      await onPage.locator("#expense-to").fill(to);
      await onPage.locator('#expense-period-form button[type="submit"]').click();
    }
    const digits = text => String(text).replace(/\D/g, "");
    await page.locator("#add-expense").click();
    const clock = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: farmTimezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
    assert.equal(await page.locator('#editor-form [name="date"]').inputValue(), `${clock.year}-${clock.month}-${clock.day}`, "The purchase date defaults to the farm date instead of the browser date");
    const defaultTime = await page.locator('#editor-form [name="time"]').inputValue();
    const expectedMinutes = Number(clock.hour) * 60 + Number(clock.minute);
    const enteredMinutes = Number(defaultTime.slice(0, 2)) * 60 + Number(defaultTime.slice(3));
    assert.ok(Math.min(Math.abs(enteredMinutes - expectedMinutes), 1440 - Math.abs(enteredMinutes - expectedMinutes)) <= 1, "The purchase time defaults to the farm clock for a browser in the USA");
    await fillEditor({ description: "Réparation de la pompe accentuée", category: "Entretien", supplier: "Atelier de test Éléphant", amount: 12500, date: "2025-01-15", time: "10:45", notes: "Joint remplacé ; facture de test uniquement" });
    await submitEditor();
    let state = await api("/api/state");
    assert.equal(state.expenses.length, 5);
    const created = state.expenses.find(value => value.description === "Réparation de la pompe accentuée");
    assert.equal(created.date, "2025-01-15");
    assert.equal(created.time, "10:45");
    assert.equal(created.timezone, farmTimezone);
    assert.equal(created.amount, 12500);
    assert.equal(created.createdBy, "responsable-depenses-test");
    assert.deepEqual(state.items, [], "Recording a purchase must not invent an inventory entry");
    await filterPeriod();
    let table = await page.locator("#expenses-table").textContent();
    assert.ok(table.includes(created.description) && table.includes("Borne début janvier") && table.includes("Borne fin janvier"), "Both period boundaries are included");
    assert.ok(!table.includes("Hors période"), "Purchases outside the displayed period stay excluded");
    assert.ok(table.includes("10:45") && table.includes(farmTimezone) && table.includes("Atelier de test Éléphant"));
    assert.equal(digits(await page.locator("#expense-total").textContent()), "12800");
    assert.match(await page.locator("#report-expenses-pdf").getAttribute("href"), /from=2025-01-01&to=2025-01-31/);
    const download = page.waitForEvent("download");
    await page.locator("#report-expenses-pdf").click();
    const pdfPath = path.join(artifacts, "depenses-janvier-test.pdf");
    await (await download).saveAs(pdfPath);
    assert.equal(fs.readFileSync(pdfPath).subarray(0, 5).toString(), "%PDF-");
    const text = execFileSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8", timeout: 30000 });
    assert.match(text, /Réparation de la pompe accentuée/);
    assert.match(text, /10:45/);
    assert.match(text, /Atelier de test Éléphant/);
    assert.ok(text.includes("Borne début janvier") && text.includes("Borne fin janvier") && !text.includes("Hors période"), "The downloaded report uses the same period as the visible total");
    assert.ok(/12\s*800\s*F\s*CFA/.test(text), "The PDF contains the exact filtered total");
    await page.screenshot({ path: path.join(artifacts, "depenses-desktop.png"), fullPage: true });

    // Commit server-side, lose the response, reload, then retry the same UUID.
    const bodies = [];
    let committedStatus;
    const lostResponse = async intercepted => {
      if (intercepted.request().method() !== "POST") return intercepted.continue();
      bodies.push(intercepted.request().postDataJSON());
      if (bodies.length === 1) {
        const result = await intercepted.fetch();
        committedStatus = result.status();
        return intercepted.abort("failed");
      }
      return intercepted.continue();
    };
    await page.route("**/api/expenses", lostResponse);
    await page.locator("#add-expense").click();
    await fillEditor({ description: "Achat réponse perdue", category: "Transport", amount: 700, date: "2025-01-20", time: "12:05", notes: "Reprise après interruption de test" });
    await page.locator("#editor-submit").click();
    await page.locator("#editor-error").waitFor({ state: "visible" });
    assert.equal(committedStatus, 201);
    const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(key => key.startsWith("adeoye-pending-intent:")))));
    assert.equal(stored.kind, "expense");
    assert.deepEqual(stored.payload, bodies[0]);
    const matching = async () => (await api("/api/state")).expenses.filter(value => value.description === "Achat réponse perdue");
    assert.equal((await matching()).length, 1);
    page.once("dialog", dialog => dialog.accept());
    await page.reload();
    await page.locator("#resume-intent").click();
    await page.locator("#editor").waitFor({ state: "visible" });
    assert.ok(await page.locator("#editor-fields input").evaluateAll(inputs => inputs.every(input => input.disabled)), "A resumed uncertain expense keeps its original payload locked");
    await submitEditor();
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[1], bodies[0], "Retry after reload uses exactly the original expense request and UUID");
    assert.equal((await matching()).length, 1, "The purchase is accounted exactly once");
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("adeoye-pending-intent:")).length), 0);
    await page.unroute("**/api/expenses", lostResponse);
    await filterPeriod();
    assert.equal(digits(await page.locator("#expense-total").textContent()), "13500");

    async function roleSession(role) {
      const username = role + "-depenses-test", initialPassword = "Initial-" + role + "-expenses-test-965!", personalPassword = "Personal-" + role + "-expenses-test-317!";
      await api("/api/users", "POST", { username, password: initialPassword, role });
      const result = await context();
      const login = await result.request.post(base + "/api/auth/login", { headers: { Origin: base }, data: { username, password: initialPassword } });
      assert.ok(login.ok(), await login.text());
      const me = await login.json();
      const change = await result.request.post(base + "/api/auth/password", { headers: { Origin: base, "X-CSRF-Token": me.csrf }, data: { currentPassword: initialPassword, password: personalPassword } });
      assert.ok(change.ok(), await change.text());
      return { context: result, csrf: (await change.json()).csrf, page: await result.newPage() };
    }
    const manager = await roleSession("manager");
    await manager.page.goto(base + "/app.html#expenses");
    await manager.page.locator("#add-expense").click();
    await fillEditor({ description: "Aliment saisi par l’équipe", category: "Aliments et intrants", supplier: "Magasin de test", amount: 2200, date: "2025-03-01", time: "09:20" }, manager.page);
    await submitEditor(manager.page);
    assert.equal((await api("/api/state")).expenses.find(value => value.description === "Aliment saisi par l’équipe").createdBy, "manager-depenses-test");
    const viewer = await roleSession("viewer");
    await viewer.page.goto(base + "/app.html#expenses");
    await viewer.page.locator("#expense-total").waitFor();
    assert.equal(await viewer.page.locator("#add-expense").count(), 0, "The remote reader has no expense creation control");
    assert.equal(await viewer.page.locator('[data-page="users"]').count(), 0);
    await filterPeriod(viewer.page);
    assert.equal(digits(await viewer.page.locator("#expense-total").textContent()), "13500");
    assert.ok((await viewer.page.locator("#expenses-table").textContent()).includes("Achat réponse perdue"));
    const denied = await viewer.context.request.post(base + "/api/expenses", { headers: { Origin: base, "X-CSRF-Token": viewer.csrf }, data: expense("Écriture interdite au lecteur", "2025-01-25", 999) });
    assert.equal(denied.status(), 403, "The read-only role cannot bypass the interface to record purchases");
    const viewerReport = await viewer.context.request.get(base + await viewer.page.locator("#report-expenses-pdf").getAttribute("href"));
    assert.ok(viewerReport.ok());
    assert.equal((await viewerReport.body()).subarray(0, 5).toString(), "%PDF-");
    await viewer.page.setViewportSize({ width: 390, height: 844 });
    await viewer.page.waitForFunction(() => document.querySelector("#sidebar").getBoundingClientRect().right <= 1);
    assert.equal(await viewer.page.locator("#mobile-menu").getAttribute("aria-expanded"), "false");
    assert.equal(await viewer.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "The expenses page fits a phone viewport");
    for (const selector of ["#readonly-banner", "#expense-period-form", ".expense-summary", "#report-expenses-pdf", "#expense-from", "#expense-to"]) {
      const box = await viewer.page.locator(selector).boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 391, "Mobile controls remain within the viewport: " + selector);
    }
    await viewer.page.screenshot({ path: path.join(artifacts, "depenses-mobile-lecture.png"), fullPage: true });
    await viewer.page.locator("#expense-all").click();
    assert.equal(digits(await viewer.page.locator("#expense-total").textContent()), "28700");
    assert.ok((await viewer.page.locator("#expenses-table").textContent()).includes("Aliment saisi par l’équipe"));
    assert.deepEqual(errors, [], "No browser JavaScript error occurs during expense flows");
    assert.deepEqual(externalRequests, [], "No third-party services are contacted");
    console.log("PASS ADEOYE dépenses : date/heure de la ferme depuis un navigateur américain, achats admin et équipe, bornes inclusives et total exact, PDF imprimable conforme à la période, réponse perdue puis reprise sans doublon, consultation distante sans écriture et mobile390. Artefacts : " + artifacts);
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    if (instance) await instance.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
