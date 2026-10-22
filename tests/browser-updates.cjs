"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const { createApplication } = require("../lib/application");

// Each visitor gets a separate cookie/storage context. Deployment changes are
// simulated at the public static endpoint; no production data or gateway is used.
(async () => {
  const release = JSON.parse(fs.readFileSync(path.join(__dirname, "../public/version.json"), "utf8"));
  assert.match(release.version, /^[a-f0-9]{64}$/i, "Run the release build before the browser test");
  const baseVersion = release.version.toLowerCase();
  const nextVersion = baseVersion === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64);
  const laterVersion = "c".repeat(64);
  const finalVersion = "d".repeat(64);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crs-updates-browser-"));
  const instance = createApplication({ dataDir: dir, setupToken: "updates-browser-private-setup" });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  const errors = [];

  async function visitor(viewport) {
    const context = await browser.newContext({ viewport });
    const state = { version: baseVersion, documentVersion: baseVersion, failure: false, requests: 0 };
    await context.addInitScript(() => {
      const originalFetch = window.fetch;
      window.__updateFetches = [];
      window.fetch = function (input, options) {
        const url = typeof input === "string" ? input : input.url;
        if (new URL(url, location.href).pathname === "/version.json") {
          window.__updateFetches.push({
            cache: options && options.cache,
            credentials: options && options.credentials,
            method: (options && options.method) || "GET",
          });
        }
        return originalFetch.apply(this, arguments);
      };
    });
    await context.route(url => url.origin === base && url.pathname === "/version.json", async route => {
      state.requests++;
      await route.fulfill({
        status: state.failure ? 503 : 200,
        contentType: "application/json",
        headers: { "Cache-Control": "no-store" },
        body: state.failure ? '{"error":"Fixture temporarily unavailable"}' : JSON.stringify({ version: state.version }),
      });
    });
    await context.route(url => url.origin === base && ["/", "/index.html"].includes(url.pathname), async route => {
      const response = await route.fetch();
      const body = (await response.text()).replace(
        /(<meta\b[^>]*name=["']crs-version["'][^>]*content=["'])[^"']+(["'][^>]*>)/i,
        "$1" + state.documentVersion + "$2",
      );
      await route.fulfill({ response, body });
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    let navigations = 0;
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations++; });
    const mutations = [];
    page.on("request", request => {
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) mutations.push(new URL(request.url()).pathname);
    });
    return { context, page, state, mutations, navigations: () => navigations };
  }
  async function ready(page) {
    await page.waitForFunction(() => Boolean(window.crsUpdates));
    await page.evaluate(() => window.crsUpdates.check());
  }
  async function check(visitor, version) {
    visitor.state.version = version;
    await visitor.page.evaluate(() => window.crsUpdates.check());
  }
  async function notice(page, visible) {
    await page.waitForFunction(expected => {
      const node = document.getElementById("site-update-notice");
      return expected ? Boolean(node && !node.hidden) : !node || node.hidden;
    }, visible);
  }
  async function noOverflow(page) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const box = await page.locator("#site-update-notice").boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390, "The entire update notice fits on a phone");
  }
  async function fillRegistration(page, name) {
    await page.locator('[name="name"]').fill(name);
    await page.locator('[name="guardian"]').fill("Parent essai mise à jour");
    await page.locator('[name="phone"]').fill("0100000000");
    await page.locator("#consent").check();
  }
  async function assertFreshHeaders(request, routes) {
    for (const route of routes) {
      const response = await request.get(base + route);
      assert.equal(response.status(), 200, route);
      assert.match(response.headers()["cache-control"] || "", /\bno-store\b/i, route + " must not retain an old release");
    }
  }

  async function pendingPaymentPreservesPage() {
    const paymentDir = fs.mkdtempSync(path.join(os.tmpdir(), "crs-pending-update-browser-"));
    let paymentApp;
    let verifications = 0;
    paymentApp = createApplication({
      dataDir: paymentDir, setupToken: "pending-update-fixture-setup",
      paymentConfig: { sandbox: true, publicKey: "fixture-public", privateKey: "fixture-private", secretKey: "fixture-secret" },
      verifyTransaction: async id => {
        assert.equal(id, "update_browser_fixture_transaction");
        verifications++;
        const order = paymentApp.db.prepare("SELECT * FROM payment_orders WHERE state='pending'").get();
        return { status: "SUCCESS", amount: order.amount, data: JSON.stringify({ orderId: order.id }) };
      },
    });
    const paymentServer = paymentApp.app.listen(0, "127.0.0.1");
    await new Promise(resolve => paymentServer.once("listening", resolve));
    const paymentBase = "http://127.0.0.1:" + paymentServer.address().port;
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    let version = baseVersion;
    try {
      await context.route(url => url.origin === paymentBase && url.pathname === "/version.json", route => route.fulfill({
        contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify({ version }),
      }));
      await context.route(url => url.origin === paymentBase && url.pathname === "/vendor/kkiapay-2.0.38.js", route => route.fulfill({
        contentType: "application/javascript",
        body: "window.openKkiapayWidget=o=>{window.__pendingUpdateWidget=o};window.addSuccessListener=f=>{window.__pendingUpdateSuccess=f};window.addFailedListener=f=>{};window.closeKkiapayWidget=()=>{};",
      }));
      const setup = await context.request.post(paymentBase + "/api/auth/setup", {
        data: { token: "pending-update-fixture-setup", username: "admin-pending-update", password: "Fixture-pending-update-browser-123!" },
      });
      assert.equal(setup.status(), 200);
      const { csrf } = await setup.json();
      const catalogue = await (await context.request.get(paymentBase + "/api/catalogue")).json();
      const [studentClass, monthlyFee] = catalogue.levels[0];
      const centre = catalogue.centres[0];
      const created = await context.request.post(paymentBase + "/api/records/students", {
        headers: { "X-CSRF-Token": csrf },
        data: { name: "Élève paiement protégé", class: studentClass, centre, group: studentClass + " · " + centre, monthlyFee, registrationStatus: "Inscrit" },
      });
      assert.equal(created.status(), 201);
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(error.message));
      let navigations = 0;
      page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations++; });
      await page.goto(paymentBase + "/gestion.html?section=payments");
      await ready(page);
      await page.locator("#pay-online").click();
      await page.locator('#form button[type="submit"]').click();
      await page.waitForFunction(() => Boolean(window.__pendingUpdateWidget) && schoolAPI.pendingRequests === 0);
      await page.locator("#modal").waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => window.__pendingUpdateWidget.sandbox), true);
      // The checkout modal is closed and its controls are removed. Only the
      // pending in-memory order can protect the external payment operation.
      await page.evaluate(() => {
        document.getElementById("form").reset();
        document.getElementById("fields").replaceChildren();
      });
      assert.equal(await page.evaluate(() => schoolAPI.pendingRequests), 0);
      assert.equal(await page.evaluate(() => window.crsHasUnsavedWork()), true);
      const before = navigations;
      await page.clock.install();
      version = laterVersion;
      await page.evaluate(() => window.crsUpdates.check());
      await notice(page, true);
      await page.clock.fastForward(12000);
      assert.equal(navigations, before, "A closed checkout modal must not discard the pending KKiaPay order");
      assert.equal(paymentApp.db.prepare("SELECT count(*) n FROM payment_orders WHERE state='pending'").get().n, 1);
      assert.equal(paymentApp.db.prepare("SELECT count(*) n FROM records WHERE kind='payments'").get().n, 0);
      await page.evaluate(() => window.__pendingUpdateSuccess({ transactionId: "update_browser_fixture_transaction" }));
      await page.getByRole("cell", { name: "Test confirmé", exact: true }).waitFor();
      await page.waitForFunction(() => schoolAPI.pendingRequests === 0 && !window.crsHasUnsavedWork());
      assert.equal(verifications, 1);
      assert.equal(paymentApp.db.prepare("SELECT count(*) n FROM records WHERE kind='payments'").get().n, 1);
      assert.equal((await context.request.get(paymentBase + "/api/auth/me")).status(), 200);
    } finally {
      await context.close();
      await new Promise(resolve => paymentServer.close(resolve));
      paymentApp.db.close();
      fs.rmSync(paymentDir, { recursive: true, force: true });
    }
  }

  try {
    const family = await visitor({ width: 390, height: 844 });
    const clean = await visitor({ width: 1280, height: 900 });
    const admin = await visitor({ width: 1440, height: 1000 });
    await assertFreshHeaders(family.context.request, [
      "/", "/index.html", "/connexion.html", "/installation.html", "/version.json",
      "/inscription.js", "/eleve.css", "/site-updates.js", "/site-updates.css",
    ]);
    assert.equal((await family.context.request.get(base + "/api/data")).status(), 401);
    const setup = await admin.context.request.post(base + "/api/auth/setup", {
      data: { token: "updates-browser-private-setup", username: "admin-updates", password: "Local-updates-browser-password-123!" },
    });
    assert.equal(setup.status(), 200);
    await Promise.all([family.page.goto(base), clean.page.goto(base), admin.page.goto(base + "/gestion.html?section=cashier")]);
    await Promise.all([ready(family.page), ready(clean.page), ready(admin.page)]);
    await family.page.locator('[name="name"]').waitFor({ state: "visible" });
    await admin.page.locator("#cashier-period").waitFor();
    await assertFreshHeaders(admin.context.request, ["/gestion.html"]);
    await notice(family.page, false);
    await notice(clean.page, false);
    await fillRegistration(family.page, "Élève formulaire conservé");
    // Keep a real management form open while proving that checking for a
    // release cannot close it or revoke the responsible's session.
    await admin.page.locator("nav [data-page=teachers]").click();
    await admin.page.locator("#add").click();
    await admin.page.locator("#modal").waitFor({ state: "visible" });
    const familyBefore = family.navigations();
    const cleanBefore = clean.navigations();
    const adminBefore = admin.navigations();
    clean.state.documentVersion = nextVersion;
    const automaticReload = clean.page.waitForEvent("framenavigated", {
      predicate: frame => frame === clean.page.mainFrame(), timeout: 20000,
    });
    await Promise.all([check(family, nextVersion), check(clean, nextVersion), check(admin, nextVersion)]);
    await Promise.all([notice(family.page, true), notice(clean.page, true), notice(admin.page, true)]);
    await noOverflow(family.page);
    await family.page.screenshot({ path: "/tmp/crs-update-notice-mobile.png", fullPage: true });
    await automaticReload;
    await ready(clean.page);
    assert.equal(await clean.page.locator('meta[name="crs-version"]').getAttribute("content"), nextVersion);
    await notice(clean.page, false);
    assert.equal(clean.navigations(), cleanBefore + 1, "A clean visitor receives the release automatically");
    assert.equal(family.navigations(), familyBefore, "Typing must prevent automatic reload");
    assert.equal(admin.navigations(), adminBefore, "An operation in progress must prevent automatic reload");
    assert.equal(await admin.page.locator("#modal").isVisible(), true);
    assert.equal(await family.page.locator('[name="name"]').inputValue(), "Élève formulaire conservé");
    assert.equal(await family.page.locator('[name="guardian"]').inputValue(), "Parent essai mise à jour");
    assert.equal(await family.page.locator("#consent").isChecked(), true);
    assert.deepEqual(family.mutations, []);
    assert.deepEqual(admin.mutations, []);
    assert.equal((await admin.context.request.get(base + "/api/auth/me")).status(), 200);
    assert.equal((await family.context.request.get(base + "/api/auth/me")).status(), 401);

    // Returning to an already open tab checks the currently published release.
    const focusCheck = family.page.waitForResponse(response => new URL(response.url()).pathname === "/version.json");
    const focusRequests = family.state.requests;
    await family.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await focusCheck;
    assert.ok(family.state.requests > focusRequests);

    // The explicit deferral and a failed final verification must both cancel
    // a clean page's automatic reload, including a rolled-back deployment.
    await clean.page.clock.install();
    const cleanReloaded = clean.navigations();
    await check(clean, laterVersion);
    await notice(clean.page, true);
    await clean.page.locator("#site-update-dismiss").click();
    await clean.page.clock.fastForward(12000);
    assert.equal(clean.navigations(), cleanReloaded);
    await notice(clean.page, false);
    await check(clean, finalVersion);
    await notice(clean.page, true);
    clean.state.failure = true;
    const verificationFailure = clean.page.waitForResponse(response => new URL(response.url()).pathname === "/version.json" && response.status() === 503);
    await clean.page.clock.fastForward(12000);
    await verificationFailure;
    await clean.page.evaluate(() => window.crsUpdates.check());
    assert.equal(clean.navigations(), cleanReloaded);
    await notice(clean.page, true);
    clean.state.failure = false;
    await check(clean, nextVersion);
    await notice(clean.page, false);

    // Release C can arrive during the final verification of release B. The
    // obsolete B timer must leave C's new automatic countdown intact.
    const rapidFirstVersion = "e".repeat(64), rapidFinalVersion = "f".repeat(64);
    clean.state.documentVersion = rapidFinalVersion;
    await check(clean, rapidFirstVersion);
    await notice(clean.page, true);
    clean.state.version = rapidFinalVersion;
    const newerRelease = clean.page.waitForResponse(response => new URL(response.url()).pathname === "/version.json" && response.status() === 200);
    await clean.page.clock.fastForward(10001);
    await newerRelease;
    // Let the response JSON and updater's microtasks finish without forcing
    // a second check that could accidentally repair a cancelled countdown.
    await clean.page.waitForTimeout(50);
    const rapidReload = clean.page.waitForEvent("framenavigated", { predicate: frame => frame === clean.page.mainFrame(), timeout: 5000 });
    await clean.page.clock.fastForward(12000);
    await rapidReload;
    await ready(clean.page);
    assert.equal(clean.navigations(), cleanReloaded + 1);
    assert.equal(await clean.page.locator('meta[name="crs-version"]').getAttribute("content"), rapidFinalVersion);
    await notice(clean.page, false);

    // Deferring is specific to this release; another release is announced.
    await family.page.locator("#site-update-dismiss").click();
    await notice(family.page, false);
    await check(family, nextVersion);
    await notice(family.page, false);
    await check(family, laterVersion);
    await notice(family.page, true);
    assert.equal(await family.page.locator('[name="name"]').inputValue(), "Élève formulaire conservé");
    const cancelled = family.page.waitForEvent("dialog");
    const cancelClick = family.page.locator("#site-update-refresh").click();
    const cancelDialog = await cancelled;
    assert.equal(cancelDialog.type(), "confirm");
    await cancelDialog.dismiss();
    await cancelClick;
    assert.equal(family.navigations(), familyBefore);
    assert.equal(await family.page.locator('[name="name"]').inputValue(), "Élève formulaire conservé");
    const accepted = family.page.waitForEvent("dialog");
    const explicitReload = family.page.waitForEvent("framenavigated", { predicate: frame => frame === family.page.mainFrame() });
    family.state.documentVersion = laterVersion;
    const acceptClick = family.page.locator("#site-update-refresh").click();
    const acceptDialog = await accepted;
    await acceptDialog.accept();
    await acceptClick;
    await explicitReload;
    await ready(family.page);
    assert.equal(family.navigations(), familyBefore + 1);
    assert.equal(await family.page.locator('[name="name"]').inputValue(), "");
    await notice(family.page, false);

    // The public version service can fail without blocking a registration.
    family.state.failure = true;
    await fillRegistration(family.page, "Élève confirmation conservée");
    await family.page.evaluate(() => window.crsUpdates.check());
    await notice(family.page, false);
    await family.page.getByRole("button", { name: "Valider mon inscription" }).click();
    await family.page.locator("#confirmation").waitFor({ state: "visible" });
    assert.deepEqual(family.mutations, ["/api/registrations"]);
    const reference = await family.page.locator("#reference").textContent();
    const registeredNavigations = family.navigations();
    // Reset input tracking; the confirmation itself still protects the
    // registration's in-memory payment access from an automatic reload.
    await family.page.evaluate(() => document.getElementById("registration").reset());
    family.state.failure = false;
    await check(family, finalVersion);
    await notice(family.page, true);
    await family.page.clock.install();
    await family.page.clock.fastForward(12000);
    assert.equal(family.navigations(), registeredNavigations);
    assert.equal(await family.page.locator("#reference").textContent(), reference);
    // This fixture has no payment-provider keys. The month quote remains
    // available while checkout stays disabled until the school activates it.
    const selectedPeriod = await family.page.locator("#payment-period").inputValue();
    await family.page.waitForFunction(period => {
      const month = document.querySelector(`[data-payment-period="${period}"]`);
      return month && month.checked && !month.disabled;
    }, selectedPeriod);
    await family.page.locator("#payment-note").filter({ hasText: "activation" }).waitFor();
    assert.equal(await family.page.locator("#pay").isDisabled(), true);
    assert.equal(await family.page.locator("#payment-month-picker [data-payment-period]:checked").count(), 1);
    assert.equal(await family.page.locator("#payment-total").textContent(), await family.page.locator("#amount").textContent());
    assert.equal(await family.page.locator("#confirmation").isVisible(), true);
    assert.deepEqual(family.mutations, ["/api/registrations"]);
    assert.equal(instance.db.prepare("SELECT count(*) n FROM records WHERE kind='students'").get().n, 1);
    assert.equal(instance.db.prepare("SELECT count(*) n FROM payment_orders").get().n, 0);
    assert.equal(instance.db.prepare("SELECT count(*) n FROM records WHERE kind='payments'").get().n, 0);

    // Structural settings edits emit no input/change event. Removing a class
    // or a data-URL logo must still protect the unsaved configuration.
    admin.state.version = baseVersion;
    await admin.page.goto(base + "/gestion.html?section=settings");
    await ready(admin.page);
    await admin.page.locator("#school-settings").waitFor();
    await admin.page.waitForFunction(() => schoolAPI.pendingRequests === 0);
    const png = await admin.page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 8; canvas.height = 8;
      canvas.getContext("2d").fillRect(0, 0, 8, 8);
      return canvas.toDataURL("image/png");
    });
    await admin.page.evaluate(async logoUrl => {
      const settings = await schoolAPI.request("/api/admin/settings");
      await schoolAPI.request("/api/admin/settings", "PUT", { ...settings, logoUrl });
    }, png);
    await admin.page.goto(base + "/gestion.html?section=settings");
    await ready(admin.page);
    await admin.page.locator("#settings-logo-preview img").waitFor();
    await admin.page.waitForFunction(() => schoolAPI.pendingRequests === 0);
    await admin.page.clock.install();
    const classes = await admin.page.locator(".settings-level-row").count();
    await admin.page.locator(".settings-remove-level").last().click();
    assert.equal(await admin.page.locator(".settings-level-row").count(), classes - 1);
    assert.equal(await admin.page.locator("#school-settings").getAttribute("data-crs-unsaved"), "true");
    assert.equal(await admin.page.evaluate(() => window.crsHasUnsavedWork()), false);
    const structuralBefore = admin.navigations();
    await check(admin, laterVersion);
    await notice(admin.page, true);
    await admin.page.clock.fastForward(12000);
    assert.equal(admin.navigations(), structuralBefore);
    assert.equal(await admin.page.locator(".settings-level-row").count(), classes - 1);
    assert.equal(await admin.page.locator("#settings-logo-preview img").getAttribute("src"), png);
    admin.state.version = baseVersion;
    await admin.page.goto(base + "/gestion.html?section=settings");
    await ready(admin.page);
    await admin.page.locator("#settings-logo-preview img").waitFor();
    await admin.page.waitForFunction(() => schoolAPI.pendingRequests === 0);
    assert.equal(await admin.page.locator(".settings-level-row").count(), classes);
    await admin.page.locator("#settings-remove-logo").click();
    assert.equal(await admin.page.locator("#settings-logo-preview img").count(), 0);
    assert.equal(await admin.page.locator("#settings-logo-url").inputValue(), "");
    assert.equal(await admin.page.locator("#school-settings").getAttribute("data-crs-unsaved"), "true");
    assert.equal(await admin.page.evaluate(() => window.crsHasUnsavedWork()), false);
    const logoBefore = admin.navigations();
    await check(admin, finalVersion);
    await notice(admin.page, true);
    await admin.page.clock.fastForward(12000);
    assert.equal(admin.navigations(), logoBefore);
    assert.equal(await admin.page.locator("#settings-logo-preview img").count(), 0);
    assert.equal((await (await admin.context.request.get(base + "/api/admin/settings")).json()).logoUrl, png, "Unsaved logo removal must not alter server data");
    assert.equal((await admin.context.request.get(base + "/api/auth/me")).status(), 200);
    await pendingPaymentPreservesPage();

    for (const visitor of [family, clean, admin]) {
      const checks = await visitor.page.evaluate(() => window.__updateFetches);
      assert.ok(checks.length > 0);
      for (const request of checks) assert.deepEqual(request, { cache: "no-store", credentials: "omit", method: "GET" });
    }
    assert.deepEqual(errors, []);
    console.log("PASS mises à jour pour visiteurs indépendants, actualisation automatique sûre y compris versions successives, saisie/confirmation/paramètres/session/paiement en cours préservés, différer, panne réseau et mobile.");
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    instance.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
