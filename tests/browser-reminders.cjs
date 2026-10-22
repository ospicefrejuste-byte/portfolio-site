"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const applicationModule = require(process.env.CLOUD_APP_MODULE || "../lib/application");

const password = "Reminder-browser-password-123!";
const compact = value => String(value).replace(/\s/g, "");

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crs-reminders-browser-"));
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "crs-reminders-artifacts-"));
  const instance = await applicationModule.createApplication({ dataDir: dir, setupToken: "reminder-browser-setup" });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const period = "2026-10";
  const nextPeriod = "2026-11";
  const ledgerPath = "/api/admin/monthly-balances";
  const ledgerPattern = "**" + ledgerPath + "?period=" + period;
  const errors = [], external = [], writes = [];
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/usr/bin/chromium", args: ["--no-sandbox"] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "fr-FR" });
    await context.route(url => url.origin !== base, route => {
      external.push(route.request().url());
      return route.abort("blockedbyclient");
    });
    await context.addInitScript(() => {
      window.__reminderPopups = [];
      window.__blockReminderPopups = false;
      window.open = (url, target, features) => {
        const record = { initialUrl: String(url), target, features, closed: false, navigations: [], blocked: window.__blockReminderPopups };
        window.__reminderPopups.push(record);
        if (record.blocked) return null;
        const popup = {
          opener: window,
          closed: false,
          document: document.implementation.createHTMLDocument("Brouillon WhatsApp simulé"),
          location: { replace: value => record.navigations.push(String(value)) },
          close() { record.closed = true; popup.closed = true; },
        };
        record.popup = popup;
        return popup;
      };
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        writeText: async text => { window.__copiedReminder = text; },
      } });
    });
    const setup = await context.request.post(base + "/api/auth/setup", { data: {
      token: "reminder-browser-setup", username: "reminder-browser-admin", password,
    } });
    assert.equal(setup.status(), 200);
    const headers = { "X-CSRF-Token": (await setup.json()).csrf };
    async function api(route, method = "GET", data) {
      const response = await context.request.fetch(base + route, { method, headers, ...(data === undefined ? {} : { data }) });
      assert.ok(response.ok(), method + " " + route + ": " + response.status() + " " + await response.text());
      return response.json();
    }
    const catalogue = await api("/api/catalogue");
    const centre = catalogue.centres[0];
    async function pupil(name, extra = {}) {
      return api("/api/records/students", "POST", {
        name, class: "6e", centre, group: "6e · " + centre, monthlyFee: 3500,
        registrationStatus: "Inscrit", guardian: "Maman Joséphine", phone: "+2290100000000", ...extra,
      });
    }
    async function collect(student, amount, targetPeriod = period) {
      return api("/api/cashier/payments", "POST", { requestId: crypto.randomUUID(), student: student.id, amount, period: targetPeriod });
    }
    const partial = await pupil("Élève rappel partiel", { phone: "0100000000" });
    const missing = await pupil("Élève sans téléphone", { phone: "" });
    const sandbox = await pupil("Élève paiement de test exclu");
    const suspended = await pupil("Élève suspendu sans rappel", { registrationStatus: "Suspendu" });
    const preregistered = await pupil("Élève préinscrit sans rappel", { registrationStatus: "Préinscription" });
    const changing = await pupil("Élève dossier modifié");
    const settling = await pupil("Élève réglé pendant la préparation");
    const staleOpen = await pupil("Élève réglé avant la préparation");
    const retrying = await pupil("Élève vérification temporairement indisponible");
    await collect(partial, 2000);
    await collect(partial, 3500, nextPeriod);
    const sandboxPayment = { id: crypto.randomUUID(), student: sandbox.id, amount: 3500, period,
      date: "2026-10-22", source: "KKiaPay", mode: "sandbox", transactionId: "reminder-browser-sandbox-only" };
    await instance.db.prepare("INSERT INTO records(kind,id,payload) VALUES('payments',?,?)").run(sandboxPayment.id, JSON.stringify(sandboxPayment));

    const admin = await context.newPage();
    admin.on("pageerror", error => errors.push(error.message));
    admin.on("request", request => { if (!["GET", "HEAD"].includes(request.method())) writes.push(request.method() + " " + new URL(request.url()).pathname); });
    await admin.goto(base + "/gestion.html?section=balances");
    await admin.locator("#finance-period").fill(period);
    const reminder = student => admin.locator('[data-finance-reminder="' + student.id + '"]');
    await reminder(partial).waitFor();
    assert.equal(await reminder(partial).textContent(), "Relancer sur WhatsApp");
    assert.equal(await reminder(suspended).count(), 0);
    assert.equal(await reminder(preregistered).count(), 0);
    const balances = (await api(ledgerPath + "?period=" + period)).rows;
    assert.equal(balances.find(row => row.student === partial.id).balance, 1500);
    assert.equal(balances.find(row => row.student === sandbox.id).paid, 0);
    assert.equal(balances.find(row => row.student === sandbox.id).balance, 3500);
    await admin.locator("#finance-period").fill(nextPeriod);
    await admin.locator('[data-finance-payment="' + partial.id + '"]').waitFor();
    assert.equal(await reminder(partial).count(), 0, "A prepaid month has no reminder action");
    await admin.locator("#finance-period").fill(period);
    await reminder(partial).waitFor();

    const dialog = admin.locator("#finance-reminder-dialog");
    const phone = admin.locator("#finance-reminder-phone");
    const message = admin.locator("#finance-reminder-message");
    const send = admin.locator("#finance-reminder-whatsapp");
    const error = admin.locator("#finance-reminder-error");
    async function open(student) {
      const fresh = admin.waitForResponse(response => new URL(response.url()).pathname === ledgerPath && new URL(response.url()).searchParams.get("period") === period);
      await reminder(student).click();
      assert.equal((await fresh).status(), 200, "Opening a reminder fetches the current selected-month balance");
      await phone.waitFor();
      await admin.waitForFunction(() => !document.querySelector("#finance-reminder-whatsapp")?.disabled);
      assert.ok((await message.inputValue()).includes(student.name));
    }
    async function close() {
      await admin.locator("#finance-reminder-cancel").click();
      await dialog.waitFor({ state: "hidden" });
    }
    async function popups() {
      return admin.evaluate(() => window.__reminderPopups.map(record => ({
        initialUrl: record.initialUrl, blocked: record.blocked, closed: record.closed,
        navigations: record.navigations, openerNull: record.popup?.opener === null,
        referrer: record.popup?.document.querySelector('meta[name="referrer"]')?.content || "",
      })));
    }
    async function waitClosed(index) {
      await admin.waitForFunction(index => window.__reminderPopups[index]?.closed, index);
      const record = (await popups())[index];
      assert.deepEqual(record.navigations, [], "A failed or changed check cannot open a WhatsApp draft");
    }
    async function waitDraft(index, text, digits = "2290100000000") {
      await admin.waitForFunction(index => window.__reminderPopups[index]?.navigations.length === 1, index);
      const record = (await popups())[index];
      assert.equal(record.initialUrl, "about:blank");
      assert.equal(record.openerNull, true);
      assert.equal(record.referrer, "no-referrer");
      const url = new URL(record.navigations[0]);
      assert.equal(url.origin, "https://wa.me");
      assert.equal(url.pathname, "/" + digits);
      assert.equal(url.searchParams.get("text"), text, "WhatsApp receives the exact reviewed Unicode draft");
    }
    async function unchanged(before, label) { assert.deepEqual(await api("/api/data"), before, label); }

    let before = await api("/api/data");
    await open(partial);
    const original = compact(await message.inputValue());
    assert.ok(original.includes("octobre2026"));
    assert.ok(original.includes("3500FCFA"));
    assert.ok(original.includes("2000FCFA"));
    assert.ok(original.includes("1500FCFA"), "Only the selected month's remaining amount is requested");
    assert.equal(original.includes("novembre2026"), false);
    assert.equal((await phone.inputValue()).includes("+229"), false, "A local number never receives an invented country code");
    for (const invalid of ["", "0100000000", "+229<script>"]) {
      await phone.fill(invalid);
      await send.click();
      assert.ok((await error.textContent()).trim());
      assert.equal((await popups()).length, 0, "Invalid phone numbers do not create a tab");
    }
    await phone.fill("+2290100000000");
    await message.fill("   ");
    await send.click();
    assert.ok((await error.textContent()).trim());
    assert.equal((await popups()).length, 0, "An empty message does not create a tab");
    const edited = "Bonjour Maman Joséphine 👋\nÉlève : " + partial.name + ". Reste : 1 500 FCFA & merci de confirmer ?";
    await message.fill(edited);
    await phone.fill("00 229 01 00 00 00 00");
    await admin.locator("#finance-reminder-copy").click();
    assert.equal(await admin.evaluate(() => window.__copiedReminder), edited);
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await admin.setViewportSize(viewport);
      await dialog.evaluate(element => { element.scrollTop = 0; });
      assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await admin.screenshot({ path: path.join(artifacts, "reminder-" + viewport.width + ".png") });
    }
    await admin.setViewportSize({ width: 1440, height: 1000 });
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const checking = new Promise(resolve => { entered = resolve; });
    let checks = 0;
    const slowCheck = async route => { checks++; entered(); await gate; return route.continue(); };
    await admin.route(ledgerPattern, slowCheck);
    await send.click();
    try {
      await checking;
      assert.equal((await popups()).length, 1, "The placeholder tab opens synchronously before the fresh check finishes");
      assert.equal(await send.isDisabled(), true);
      assert.equal(await phone.isDisabled(), true, "The reviewed recipient stays fixed during the fresh balance check");
      assert.equal(await message.isDisabled(), true, "The reviewed message stays fixed during the fresh balance check");
      assert.equal(await admin.locator("#finance-reminder-copy").isDisabled(), true);
      await send.evaluate(button => button.click());
      assert.equal(checks, 1);
      assert.equal((await popups()).length, 1, "Double clicks create one check and one popup");
    } finally { release(); }
    await waitDraft(0, edited);
    assert.equal(await phone.isEnabled(), true);
    assert.equal(await message.isEnabled(), true);
    await admin.unroute(ledgerPattern, slowCheck);
    await unchanged(before, "Opening and copying a reminder never changes student or payment records");
    await close();

    await open(missing);
    assert.equal(await phone.inputValue(), "");
    await send.click();
    assert.ok((await error.textContent()).trim());
    assert.equal((await popups()).length, 1);
    await close();

    await open(sandbox);
    assert.ok(compact(await message.inputValue()).includes("3500FCFA"));
    assert.ok(compact(await message.inputValue()).includes("0FCFA"));
    await close();

    await open(changing);
    await collect(changing, 1000);
    const changed = await api("/api/records/students/" + changing.id, "PUT", {
      ...changing, name: "Élève identité actualisée", guardian: "Papa André", phone: "+2290199999999",
    });
    before = await api("/api/data");
    let index = (await popups()).length;
    await send.click();
    await waitClosed(index);
    await admin.waitForFunction(() => document.querySelector("#finance-reminder-message")?.value.includes("identité actualisée"));
    assert.ok(compact(await message.inputValue()).includes("2500FCFA"));
    assert.ok((await message.inputValue()).includes(changed.guardian));
    assert.equal(await phone.inputValue(), changed.phone);
    index = (await popups()).length;
    const revised = await message.inputValue();
    await send.click();
    await waitDraft(index, revised, "2290199999999");
    await unchanged(before, "Reviewing fresh parent details and balances does not write records");
    await close();

    await open(settling);
    await collect(settling, 3500);
    before = await api("/api/data");
    index = (await popups()).length;
    await send.click();
    await waitClosed(index);
    assert.match(await error.textContent(), /régl|solde|reste/i);
    await unchanged(before, "A monthly balance settled after preview never opens WhatsApp or creates another payment");
    await close();

    await collect(staleOpen, 3500);
    before = await api("/api/data");
    const staleCheck = admin.waitForResponse(response => new URL(response.url()).pathname === ledgerPath);
    index = (await popups()).length;
    await reminder(staleOpen).click();
    assert.equal((await staleCheck).status(), 200);
    await admin.waitForFunction(() => /régl|solde|reste/i.test(document.querySelector("#finance-reminder-error")?.textContent || document.querySelector("#toast")?.textContent || ""));
    assert.equal((await popups()).length, index, "Opening a stale paid row never creates a popup");
    await unchanged(before, "The opening freshness check does not change records");
    if (await dialog.isVisible()) await close();

    await open(retrying);
    before = await api("/api/data");
    for (const status of [403, 503]) {
      const failedCheck = route => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: "Vérification indisponible pour cet essai " + status }) });
      await admin.route(ledgerPattern, failedCheck);
      index = (await popups()).length;
      await send.click();
      await waitClosed(index);
      assert.ok((await error.textContent()).includes(String(status)));
      await admin.waitForFunction(() => !document.querySelector("#finance-reminder-whatsapp")?.disabled);
      assert.equal(await phone.isEnabled(), true, "A failed check restores recipient editing");
      assert.equal(await message.isEnabled(), true, "A failed check restores message editing");
      await admin.unroute(ledgerPattern, failedCheck);
    }
    index = (await popups()).length;
    const retried = await message.inputValue();
    await send.click();
    await waitDraft(index, retried);
    await unchanged(before, "A temporary validation error can be retried without marking a reminder as sent");
    await close();

    await open(retrying);
    await admin.evaluate(() => { window.__blockReminderPopups = true; });
    const fallbackText = "Brouillon relu, à ouvrir manuellement — merci 😊";
    await message.fill(fallbackText);
    await send.click();
    const fallback = admin.locator("#finance-reminder-whatsapp-link");
    await fallback.waitFor({ state: "visible" });
    const href = new URL(await fallback.getAttribute("href"));
    assert.equal(href.origin, "https://wa.me");
    assert.equal(href.pathname, "/2290100000000");
    assert.equal(href.searchParams.get("text"), fallbackText);
    assert.equal(await fallback.getAttribute("target"), "_blank");
    assert.match(await fallback.getAttribute("rel"), /noopener/);
    assert.match(await fallback.getAttribute("rel"), /noreferrer/);
    const beforeEdits = (await popups()).length;
    await phone.fill("+2290188888888");
    assert.equal(await fallback.isHidden(), true, "Editing the parent number hides the previous draft link");
    assert.equal(await fallback.getAttribute("href"), null, "Editing the parent number removes the previous recipient URL");
    assert.equal((await popups()).length, beforeEdits, "Editing a recipient never opens WhatsApp");
    await send.click();
    await fallback.waitFor({ state: "visible" });
    let revisedFallback = new URL(await fallback.getAttribute("href"));
    assert.equal(revisedFallback.pathname, "/2290188888888");
    assert.equal(revisedFallback.searchParams.get("text"), fallbackText);
    const changedFallbackText = "Message corrigé après la préparation — nouveau brouillon 😊";
    await message.fill(changedFallbackText);
    assert.equal(await fallback.isHidden(), true, "Editing the message hides the previous draft link");
    assert.equal(await fallback.getAttribute("href"), null, "Editing the message removes the previous draft URL");
    assert.equal((await popups()).length, beforeEdits + 1, "Editing a message never opens WhatsApp");
    await send.click();
    await fallback.waitFor({ state: "visible" });
    revisedFallback = new URL(await fallback.getAttribute("href"));
    assert.equal(revisedFallback.pathname, "/2290188888888");
    assert.equal(revisedFallback.searchParams.get("text"), changedFallbackText, "A new explicit check produces the newly reviewed fallback draft");
    await unchanged(before, "The user-controlled popup-blocked fallback never marks a reminder as sent");
    await close();

    const teacher = await api("/api/records/teachers", "POST", { name: "Professeur contrôle accès rappels", subject: "Mathématiques" });
    for (const [role, entityId] of [["cashier", null], ["student", partial.id], ["teacher", teacher.id]]) {
      const username = "reminder-browser-" + role;
      const account = await api("/api/admin/users", "POST", { username, password, role, ...(entityId ? { entityId } : {}) });
      await instance.db.prepare("UPDATE users SET must_change=0 WHERE id=?").run(account.id);
      const other = await browser.newContext();
      const login = await other.request.post(base + "/api/auth/login", { data: { username, password } });
      assert.equal(login.status(), 200);
      const me = await (await other.request.get(base + "/api/auth/me")).json();
      assert.equal(me.user.role, role);
      assert.equal(me.user.mustChangePassword, false, "Role checks run after the password-change gate");
      assert.equal((await other.request.get(base + ledgerPath + "?period=" + period)).status(), 403, role + " cannot read the administration's monthly balances");
      await other.close();
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, [], "Reminder UI makes no write request and never records a message as sent");
    assert.deepEqual(external, [], "Every popup navigation is simulated; no external message or WhatsApp request is made");
    console.log("PASS rappels WhatsApp relus : soldes mensuels partiels, prépaiements, exclusions tests/statuts, numéros internationaux explicites, Unicode, copie, double clic, fraîcheur dossier/solde, règlement concurrent, 403/503 et reprise, popup bloqué, accès admin seul, dossiers/paiements inchangés. Artefacts : " + artifacts);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    await instance.db.close();
    if (applicationModule.cleanup) await applicationModule.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
