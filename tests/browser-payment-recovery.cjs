"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const applicationModule = require(process.env.CLOUD_APP_MODULE || "../lib/application");

const compact = (value) => String(value).replace(/\s/g, "");
const widgetStub = `
window.__widgetOrders = [];
window.openKkiapayWidget = order => window.__widgetOrders.push(JSON.parse(JSON.stringify(order)));
window.closeKkiapayWidget = () => {};
window.addSuccessListener = callback => window.successCallback = callback;
window.addFailedListener = callback => window.failedCallback = callback;
window.addKkiapayCloseListener = callback => window.closeCallback = callback;
window.addPaymentAbortedListener = callback => window.abortedCallback = callback;
window.addPendingListener = callback => window.pendingCallback = callback;
`;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crs-payment-recovery-"));
  const transactions = new Map(), verifiedSuccesses = new Set();
  let verificationCalls = 0;
  const options = {
    dataDir: dir, setupToken: "recovery-browser-setup",
    paymentConfig: { publicKey: "test-public", privateKey: "test-private", secretKey: "test-secret", sandbox: true },
    verifyTransaction: async (id) => {
      verificationCalls++;
      assert.ok(transactions.has(id), "The provider only knows explicitly mocked transactions");
      const result = transactions.get(id);
      if (result.status === "SUCCESS") verifiedSuccesses.add(id);
      return result;
    },
  };
  let instance = await applicationModule.createApplication(options);
  let server = instance.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  let base = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/usr/bin/chromium", args: ["--no-sandbox"] });
  const contexts = [], errors = [], externalRequests = [];
  async function context() {
    const result = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "fr-FR" });
    contexts.push(result);
    await result.route((url) => url.origin !== base, (route) => { externalRequests.push(route.request().url()); return route.abort("blockedbyclient"); });
    await result.route((url) => url.pathname === "/vendor/kkiapay-2.0.38.js", (route) => route.fulfill({ contentType: "application/javascript", body: widgetStub }));
    result.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
    return result;
  }
  async function commit(page, selector, value) {
    await page.locator(selector).fill(value);
    await page.locator(selector).blur();
  }
  async function ready(page, root) {
    await page.waitForFunction((selector) => {
      const element = document.querySelector(selector);
      return element && !element.querySelector(".payment-calendar-status") && !element.querySelector(".payment-calendar-error");
    }, root);
  }
  async function widgetCount(page, count) {
    await page.waitForFunction((expected) => window.__widgetOrders?.length === expected, count);
    return page.evaluate(() => window.__widgetOrders.at(-1));
  }
  async function assertCounts(orders, payments, verifications) {
    assert.equal((await instance.db.prepare("SELECT count(*) n FROM payment_orders").get()).n, orders, "Closing or resuming preserves the number of payment orders");
    assert.equal((await instance.db.prepare("SELECT count(*) n FROM records WHERE kind='payments'").get()).n, payments, "Opening or resuming a widget does not record a receipt");
    assert.equal(verificationCalls, verifications, "A provider verification only follows a transaction callback or explicit verification");
  }
  async function displaySelection(page, root, startInput, countInput, start, count) {
    await commit(page, startInput, start);
    await ready(page, root);
    await commit(page, countInput, String(count));
    await ready(page, root);
  }
  async function summary(page, root) {
    return page.locator(root).evaluate((element) => ({
      count: element.querySelector("[data-payment-count]").textContent,
      total: element.querySelector("[data-payment-total]").textContent,
      selected: element.querySelector("[data-payment-selected]").textContent,
    }));
  }
  async function assertResumeUnavailable(page, id, message) {
    const button = page.locator('[data-resume-order="' + id + '"]');
    assert.ok(!(await button.count()) || await button.isDisabled(), message);
  }
  try {
    const adminContext = await context();
    const setup = await adminContext.request.post(base + "/api/auth/setup", { data: {
      token: options.setupToken, username: "recovery-admin", password: "Recovery-admin-password-123!",
    }});
    assert.equal(setup.status(), 200);
    const headers = { "X-CSRF-Token": (await setup.json()).csrf };
    async function api(route, method = "GET", data) {
      const response = await adminContext.request.fetch(base + route, { method, headers, ...(data === undefined ? {} : { data }) });
      assert.ok(response.ok(), route + " returned " + response.status() + ": " + await response.text());
      return response.json();
    }
    const catalogue = await api("/api/catalogue");
    const pupil = await api("/api/records/students", "POST", {
      name: "Élève reprise privée", class: "6e", centre: catalogue.centres[0], group: "6e · " + catalogue.centres[0],
      monthlyFee: 3500, registrationStatus: "Inscrit", subjects: ["Mathématiques"], guardian: "Parent test", phone: "0100000000",
    });
    const page = await adminContext.newPage();
    await page.goto(base + "/gestion.html?section=payments");
    await page.locator("#pay-online").click();
    const privateRoot = "#checkout-month-picker";
    await displaySelection(page, privateRoot, "#f-period", "#f-monthCount", "2034-11", 2);
    await page.locator(privateRoot + ' [data-payment-period="2034-12"]').uncheck();
    await page.locator(privateRoot + ' [data-payment-period="2035-02"]').check();
    const privatePeriods = ["2034-11", "2035-02"];
    const beforeDisplayChange = await summary(page, privateRoot);
    assert.match(beforeDisplayChange.count, /^2 mois/);
    assert.equal(compact(beforeDisplayChange.total), "7000FCFA");
    await commit(page, "#f-period", "2037-01");
    await ready(page, privateRoot);
    await page.locator(privateRoot + ' [data-payment-period="2037-01"]').waitFor();
    assert.deepEqual(await summary(page, privateRoot), beforeDisplayChange, "Changing the private display date preserves every selected month and its total");
    await commit(page, "#f-period", "2034-11");
    await ready(page, privateRoot);
    for (const period of privatePeriods) assert.equal(await page.locator(privateRoot + ' [data-payment-period="' + period + '"]').isChecked(), true);
    const firstCheckout = page.waitForResponse((response) => response.url().endsWith("/api/payments/checkout") && response.request().method() === "POST");
    await page.locator('#form button[type="submit"]').click();
    const firstResponse = await firstCheckout;
    assert.equal(firstResponse.status(), 201);
    const order = await firstResponse.json();
    const selection = { student: pupil.id, periods: privatePeriods };
    assert.deepEqual(firstResponse.request().postDataJSON(), selection);
    const originalWidget = await widgetCount(page, 1);
    assert.equal(originalWidget.amount, 7000);
    const resume = () => page.locator('[data-resume-order="' + order.orderId + '"]');
    await page.evaluate(() => window.closeCallback());
    await resume().waitFor();
    await page.waitForFunction((id) => !document.querySelector('[data-resume-order="' + id + '"]')?.disabled, order.orderId);
    await assertCounts(1, 0, 0);
    async function resumeSame(expectedWidgetCount) {
      const pending = page.waitForResponse((response) => response.url().endsWith("/api/payments/checkout") && response.request().method() === "POST");
      await resume().click();
      const response = await pending;
      assert.equal(response.status(), 201);
      assert.deepEqual(response.request().postDataJSON(), selection, "Resume resubmits the complete original selection");
      const resumed = await response.json();
      assert.equal(resumed.orderId, order.orderId, "The server reuses the original order UUID");
      assert.deepEqual(resumed.allocations, order.allocations);
      assert.equal(resumed.amount, order.amount);
      const widget = await widgetCount(page, expectedWidgetCount);
      assert.equal(widget.data, originalWidget.data);
      assert.equal(widget.amount, originalWidget.amount);
    }
    await resumeSame(2);
    await page.evaluate(() => window.failedCallback());
    await page.waitForFunction((id) => !document.querySelector('[data-resume-order="' + id + '"]')?.disabled, order.orderId);
    await resumeSame(3);
    await page.evaluate(() => window.pendingCallback({}));
    await assertResumeUnavailable(page, order.orderId, "A provider PENDING callback prevents opening another widget");
    await page.evaluate(() => window.closeCallback());
    await assertResumeUnavailable(page, order.orderId, "Closing a pending provider window keeps payment recovery blocked");
    await assertCounts(1, 0, 0);
    await page.evaluate(() => window.abortedCallback());
    await page.waitForFunction((id) => !document.querySelector('[data-resume-order="' + id + '"]')?.disabled, order.orderId);
    await resumeSame(4);
    await page.evaluate(() => window.closeCallback());
    await page.reload();
    await resume().waitFor();
    await resumeSame(1);
    await page.evaluate(() => window.closeCallback());
    await assertCounts(1, 0, 0);
    console.log("PASS fermeture, échec, attente prestataire et reprise après rechargement : même ordre, mêmes mois et montant, aucun reçu ni appel prestataire automatique");

    await api("/api/records/students/" + pupil.id, "PUT", { ...pupil, monthlyFee: 4000 });
    const conflict = page.waitForResponse((response) => response.url().endsWith("/api/payments/checkout") && response.status() === 409);
    await resume().click();
    await conflict;
    await page.locator("#toast").filter({ hasText: /responsable|administration|attente|réglé/ }).waitFor();
    assert.equal(await page.evaluate(() => window.__widgetOrders.length), 1, "A changed fee does not silently open a widget with a new amount");
    await assertCounts(1, 0, 0);
    await api("/api/records/students/" + pupil.id, "PUT", pupil);
    await page.reload();
    await resumeSame(1);
    transactions.set("private-known-transaction", { status: "PENDING" });
    await page.evaluate(() => window.successCallback({ transactionId: "private-known-transaction" }));
    await page.locator("#toast").filter({ hasText: /confirmé|prestataire/ }).waitFor();
    await assertCounts(1, 0, 1);
    await assertResumeUnavailable(page, order.orderId, "A known transaction whose confirmation failed must be verified instead of charged again");
    await page.evaluate(() => { window.failedCallback(); window.closeCallback(); window.successCallback({ transactionId: "private-known-transaction" }); });
    await assertResumeUnavailable(page, order.orderId, "Late close/failure/duplicate callbacks preserve the known transaction guard");
    await assertCounts(1, 0, 1);
    await page.reload();
    await page.locator('[data-verify-order="' + order.orderId + '"]').waitFor();
    await assertResumeUnavailable(page, order.orderId, "Reloading preserves a known transaction awaiting verification");
    assert.equal(await page.evaluate(() => window.__widgetOrders.length), 0);
    transactions.set("private-known-transaction", { status: "SUCCESS", amount: order.amount, data: JSON.stringify({ orderId: order.orderId }) });
    await page.locator('[data-verify-order="' + order.orderId + '"]').click();
    assert.equal(await page.locator("#f-transactionId").inputValue(), "private-known-transaction");
    const confirmation = page.waitForResponse((response) => response.url().endsWith("/api/payments/confirm") && response.status() === 200);
    await page.locator('#form button[type="submit"]').click();
    await confirmation;
    await page.locator("#modal").waitFor({ state: "hidden" });
    await assertCounts(1, 1, 2);
    await page.evaluate(() => window.successCallback({ transactionId: "private-known-transaction" }));
    await assertCounts(1, 1, 2);
    console.log("PASS tarif modifié refusé sans nouveau montant ; transaction connue vérifiée explicitement et doublons ignorés");

    const publicContext = await context();
    const publicPage = await publicContext.newPage();
    await publicPage.goto(base);
    await publicPage.locator('[name="name"]').fill("Élève affichage public");
    await publicPage.locator('[name="guardian"]').fill("Parent test");
    await publicPage.locator('[name="phone"]').fill("0100000000");
    await publicPage.locator("#consent").check();
    await publicPage.getByRole("button", { name: "Valider mon inscription" }).click();
    await publicPage.locator("#confirmation").waitFor({ state: "visible" });
    const publicRoot = "#payment-month-picker";
    await ready(publicPage, publicRoot);
    await displaySelection(publicPage, publicRoot, "#payment-period", "#payment-month-count", "2036-03", 3);
    await publicPage.locator(publicRoot + ' [data-payment-period="2036-04"]').uncheck();
    await publicPage.locator(publicRoot + ' [data-payment-period="2036-08"]').check();
    const publicPeriods = ["2036-03", "2036-05", "2036-08"];
    const publicSummary = await summary(publicPage, publicRoot);
    assert.match(publicSummary.count, /^3 mois/);
    assert.equal(compact(publicSummary.total), "10500FCFA");
    await commit(publicPage, "#payment-period", "2040-01");
    await ready(publicPage, publicRoot);
    await publicPage.locator(publicRoot + ' [data-payment-period="2040-01"]').waitFor();
    assert.deepEqual(await summary(publicPage, publicRoot), publicSummary, "Changing the public display date preserves arbitrary choices and their total");
    await commit(publicPage, "#payment-period", "2036-03");
    await ready(publicPage, publicRoot);
    for (const period of publicPeriods) assert.equal(await publicPage.locator(publicRoot + ' [data-payment-period="' + period + '"]').isChecked(), true);
    const publicCheckout = publicPage.waitForResponse((response) => response.url().endsWith("/api/registration-payments/checkout") && response.request().method() === "POST");
    await publicPage.locator("#pay").click();
    const publicResponse = await publicCheckout;
    assert.equal(publicResponse.status(), 201);
    assert.deepEqual(publicResponse.request().postDataJSON(), { periods: publicPeriods });
    const publicOrder = await publicResponse.json();
    await widgetCount(publicPage, 1);
    await publicPage.evaluate(() => window.pendingCallback({}));
    assert.equal(await publicPage.locator("#pay").isDisabled(), true);
    await publicPage.evaluate(() => window.closeCallback());
    assert.equal(await publicPage.locator("#pay").isDisabled(), true, "Public pending callbacks also preserve the provider guard after close");
    await publicPage.evaluate(() => window.abortedCallback());
    await publicPage.waitForFunction(() => !document.querySelector("#pay").disabled);
    await publicPage.locator("#pay").click();
    const publicWidget = await widgetCount(publicPage, 2);
    assert.equal(JSON.parse(publicWidget.data).orderId, publicOrder.orderId);
    await assertCounts(2, 1, 2);
    transactions.set("public-known-transaction", { status: "PENDING" });
    await publicPage.evaluate(() => window.successCallback({ transactionId: "public-known-transaction" }));
    await publicPage.locator("#retry-confirmation").waitFor({ state: "visible" });
    assert.equal(await publicPage.locator("#pay").isDisabled(), true);
    await publicPage.evaluate(() => { window.failedCallback(); window.closeCallback(); window.successCallback({ transactionId: "public-known-transaction" }); });
    await assertCounts(2, 1, 3);
    transactions.set("public-known-transaction", { status: "SUCCESS", amount: publicOrder.amount, data: JSON.stringify({ orderId: publicOrder.orderId }) });
    await publicPage.locator("#retry-confirmation").click();
    await publicPage.locator("#paid").waitFor({ state: "visible" });
    await assertCounts(2, 2, 4);
    assert.equal(verifiedSuccesses.size, 2, "Only the two explicitly confirmed transactions produce successful provider records");
    console.log("PASS affichage privé/public sans perte de sélection et protections d’attente/reprise/vérification publiques conservées");

    const deferredPupil = await api("/api/records/students", "POST", { ...pupil, name: "Élève paiement différé" });
    const deferredOrder = await api("/api/payments/checkout", "POST", { student: deferredPupil.id, periods: ["2038-01"] });
    await page.reload();
    await page.locator('[data-resume-order="' + deferredOrder.orderId + '"]').click();
    await widgetCount(page, 1);
    await page.evaluate(() => window.pendingCallback({}));
    await page.reload();
    await page.locator('[data-verify-order="' + deferredOrder.orderId + '"]').waitFor();
    await assertResumeUnavailable(page, deferredOrder.orderId, "Reloading preserves the provider PENDING guard without a transaction reference");
    await assertCounts(3, 2, 4);
    for (const browserContext of contexts) for (const openPage of browserContext.pages()) await openPage.goto("about:blank");
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await instance.db.close();
    instance = await applicationModule.createApplication({ ...options, paymentConfig: {} });
    server = instance.app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = "http://127.0.0.1:" + server.address().port;
    const deferredRequests = [];
    page.on("request", (request) => { if (/\/payments\/(checkout|confirm)$/.test(new URL(request.url()).pathname)) deferredRequests.push(request.url()); });
    await page.goto(base + "/gestion.html?section=payments");
    await page.locator("#pay-online").waitFor();
    await assertResumeUnavailable(page, deferredOrder.orderId, "An unconfigured provider never exposes an enabled resume action");
    assert.deepEqual(deferredRequests, []);
    await assertCounts(3, 2, 4);
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, [], "The test never contacts a real payment gateway");
    console.log("PASS paiement différé : aucune reprise prestataire disponible et aucun ordre/encaissement supplémentaire");
  } finally {
    await browser.close();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await instance.db.close();
    if (applicationModule.cleanup) await applicationModule.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
