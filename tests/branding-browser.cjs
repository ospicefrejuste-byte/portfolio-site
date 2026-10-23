"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");
const { createApplication } = require("../lib/application");

// These synthetic images and all accounts belong to a disposable local farm.
(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "adeoye-branding-browser-data-"));
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "adeoye-branding-browser-artifacts-"));
  const errors = [], externalRequests = [], uploads = [];
  let instance, server, browser, base;
  const setupToken = "branding-browser-isolated-setup";
  async function stop() {
    if (server) { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); server = null; }
    if (instance) { await instance.db.close(); instance = null; }
  }
  async function start() {
    instance = await createApplication({ dataDir, setupToken });
    server = instance.app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    base = "http://127.0.0.1:" + server.address().port;
  }
  try {
    await start();
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/usr/bin/chromium", args: ["--no-sandbox"] });
    async function context(options = {}) {
      const value = await browser.newContext({ locale: "fr-FR", viewport: { width: 1440, height: 1000 }, ...options });
      await value.route(url => ![base, "null"].includes(url.origin), route => { externalRequests.push(route.request().url()); return route.abort(); });
      value.on("page", page => {
        page.on("pageerror", error => errors.push(error.message));
        page.on("request", request => {
          if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/settings/logo") uploads.push(request.postDataJSON());
        });
      });
      return value;
    }
    const adminContext = await context();
    const setup = await adminContext.request.post(base + "/api/auth/setup", { headers: { Origin: base }, data: { token: setupToken, username: "responsable-logo-test", password: "Branding-admin-fixture-5830!" } });
    assert.ok(setup.ok(), await setup.text());
    const adminCsrf = (await setup.json()).csrf;
    async function api(route, method = "GET", data) {
      const response = await adminContext.request.fetch(base + route, { method, headers: { Origin: base, "X-CSRF-Token": adminCsrf }, ...(data === undefined ? {} : { data }) });
      assert.ok(response.ok(), method + " " + route + " " + response.status() + " " + await response.text());
      return response.json();
    }
    const page = await adminContext.newPage();
    await page.goto(base + "/app.html#settings");
    await page.locator("#logo-form").waitFor();
    const initialSettings = await api("/api/settings");
    assert.equal(initialSettings.logoUrl, null);
    await page.waitForFunction(() => document.querySelector(".brand [data-brand-logo]")?.getAttribute("src") === "/mark.svg");
    const images = await page.evaluate(() => {
      const wide = document.createElement("canvas"); wide.width = 800; wide.height = 400;
      const first = wide.getContext("2d"); first.fillStyle = "#164734"; first.fillRect(0, 0, 800, 400); first.fillStyle = "#dceba9"; first.fillRect(70, 60, 660, 70); first.fillStyle = "#ffffff"; first.font = "bold 64px sans-serif"; first.fillText("ADEOYE TEST", 80, 270);
      const transparent = document.createElement("canvas"); transparent.width = 160; transparent.height = 160;
      const second = transparent.getContext("2d"); second.fillStyle = "#164734"; second.beginPath(); second.arc(80, 80, 65, 0, Math.PI * 2); second.fill(); second.fillStyle = "#dceba9"; second.font = "bold 65px sans-serif"; second.fillText("A", 55, 103);
      return { jpeg: wide.toDataURL("image/jpeg", .9), png: transparent.toDataURL("image/png") };
    });
    const fixture = (name, mimeType, dataUrl) => ({ name, mimeType, buffer: Buffer.from(dataUrl.split(",")[1], "base64") });
    const jpeg = fixture("logo-fictif.jpg", "image/jpeg", images.jpeg), png = fixture("logo-transparent-fictif.png", "image/png", images.png);
    await page.locator("#logo-file").setInputFiles(jpeg);
    await page.waitForFunction(() => !document.querySelector("#logo-save").disabled);
    assert.equal(uploads.length, 0, "Selecting a file only previews it; publishing requires an explicit save");
    assert.equal((await api("/api/settings")).logoUrl, null);
    assert.equal(await page.locator('#settings-form [name="name"]').isDisabled(), true, "A pending logo cannot silently discard a second settings draft");
    const uploadReply = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/settings/logo");
    await page.locator("#logo-save").click();
    const saved = await uploadReply;
    assert.ok(saved.ok(), await saved.text());
    await page.waitForFunction(() => !document.querySelector('#settings-form [name="name"]').disabled);
    const firstSettings = await api("/api/settings"), firstLogo = firstSettings.logoUrl;
    assert.match(firstLogo, /^\/api\/branding\/logo\.png\?v=[a-f0-9]+$/);
    assert.equal(uploads.length, 1);
    assert.match(uploads[0].dataUrl, /^data:image\/png;base64,/);
    const imageResponse = await adminContext.request.get(base + firstLogo);
    assert.ok(imageResponse.ok());
    assert.match(imageResponse.headers()["content-type"], /image\/png/);
    assert.equal(imageResponse.headers()["x-content-type-options"], "nosniff");
    const bytes = await imageResponse.body();
    assert.ok(bytes.length <= 40 * 1024);
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.ok(bytes.readUInt32BE(16) <= 512 && bytes.readUInt32BE(20) <= 512);
    assert.ok(Math.abs(bytes.readUInt32BE(16) / bytes.readUInt32BE(20) - 2) < .02, "The logo keeps its original aspect ratio");
    await page.waitForFunction(expected => [...document.querySelectorAll(".brand [data-brand-logo]")].some(image => image.getAttribute("src") === expected && image.complete && image.naturalWidth > 0), firstLogo);

    const publicContext = await context(), publicPage = await publicContext.newPage();
    for (const route of ["/", "/connexion.html", "/installation.html"]) {
      await publicPage.goto(base + route);
      await publicPage.waitForFunction(expected => [...document.querySelectorAll("img[data-brand-logo]")].some(image => image.getAttribute("src") === expected && image.complete && image.naturalWidth > 0), firstLogo);
    }
    assert.equal((await publicContext.request.get(base + "/api/state")).status(), 401, "Making a logo public does not expose farm records");
    for (const [route, filename] of [["/api/reports/inventory.pdf", "inventaire-logo.pdf"], ["/api/reports/expenses.pdf", "depenses-logo.pdf"], ["/api/reports/goliath.pdf", "goliath-logo.pdf"]]) {
      const response = await adminContext.request.get(base + route);
      assert.ok(response.ok(), route + " " + await response.text());
      const report = path.join(artifacts, filename); fs.writeFileSync(report, await response.body());
      const listing = execFileSync("pdfimages", ["-list", report], { encoding: "utf8", timeout: 30000 });
      assert.match(listing, /\d+\s+\d+\s+image\s+512\s+256/, "The actual stored logo is embedded in " + route);
    }

    const newName = "Ferme ADEOYE — paramètres de test";
    await page.locator('#settings-form [name="name"]').fill(newName);
    assert.equal(await page.locator("#logo-file").isDisabled(), true, "Unsaved farm settings lock the independent logo controls");
    assert.equal(await page.locator("#logo-reset").isDisabled(), true);
    const settingsReply = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/settings");
    await page.locator("#settings-submit").click();
    assert.ok((await settingsReply).ok());
    await page.waitForFunction(() => !document.querySelector("#logo-file").disabled);
    assert.equal((await api("/api/settings")).name, newName);
    assert.equal((await api("/api/settings")).logoUrl, firstLogo, "Saving ordinary farm settings preserves the uploaded logo");

    const beforeInvalid = uploads.length;
    await page.locator("#logo-file").setInputFiles({ name: "refus.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') });
    await page.locator("#logo-error").waitFor({ state: "visible" });
    assert.ok((await page.locator("#logo-error").textContent()).trim());
    assert.equal((await api("/api/settings")).logoUrl, firstLogo);
    await page.locator("#logo-file").setInputFiles({ name: "trop-grand.png", mimeType: "image/png", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
    await page.locator("#logo-error").waitFor({ state: "visible" });
    assert.equal(uploads.length, beforeInvalid, "Invalid file choices cannot replace the saved logo");
    assert.equal((await api("/api/settings")).logoUrl, firstLogo);
    await page.locator("#logo-file").setInputFiles(png);
    await page.waitForFunction(() => !document.querySelector("#logo-save").disabled);
    await page.locator("#logo-cancel").click();
    assert.equal((await api("/api/settings")).logoUrl, firstLogo, "Cancel only discards the local preview");
    // Hold an old snapshot while publishing a replacement. It must not later
    // restore the old logo when the next shared refresh completes.
    let releaseOldRead, capturedOldRead, stateReads = 0;
    const oldReadGate = new Promise(resolve => { releaseOldRead = resolve; });
    const oldReadCaptured = new Promise(resolve => { capturedOldRead = resolve; });
    const delayedState = async route => {
      stateReads++;
      const response = await route.fetch();
      if (stateReads === 1) { capturedOldRead(); await oldReadGate; }
      return route.fulfill({ response });
    };
    await page.route("**/api/state", delayedState);
    await page.locator("#refresh").click(); await oldReadCaptured;
    await page.locator("#logo-file").setInputFiles(png);
    await page.waitForFunction(() => !document.querySelector("#logo-save").disabled);
    const nextUpload = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/settings/logo");
    await page.locator("#logo-save").click(); assert.ok((await nextUpload).ok());
    const secondLogo = (await api("/api/settings")).logoUrl;
    releaseOldRead();
    await page.waitForFunction(expected => !document.querySelector("#logo-file").disabled && document.querySelector(".brand [data-brand-logo]")?.getAttribute("src") === expected, secondLogo, { timeout: 5000 });
    assert.ok(stateReads >= 2, "A fresh snapshot follows a stale read that began before the logo was saved");
    await page.unroute("**/api/state", delayedState);
    assert.notEqual(secondLogo, firstLogo);
    assert.equal((await api("/api/settings")).name, newName);

    async function roleSession(role) {
      const username = role + "-logo-test", initialPassword = "Initial-" + role + "-branding-596!", personalPassword = "Personal-" + role + "-branding-317!";
      await api("/api/users", "POST", { username, password: initialPassword, role });
      const result = await context();
      const login = await result.request.post(base + "/api/auth/login", { headers: { Origin: base }, data: { username, password: initialPassword } });
      assert.ok(login.ok(), await login.text()); const auth = await login.json();
      const changed = await result.request.post(base + "/api/auth/password", { headers: { Origin: base, "X-CSRF-Token": auth.csrf }, data: { currentPassword: initialPassword, password: personalPassword } });
      assert.ok(changed.ok(), await changed.text());
      return { context: result, page: await result.newPage(), csrf: (await changed.json()).csrf };
    }
    for (const role of ["manager", "viewer"]) {
      const reader = await roleSession(role);
      await reader.page.goto(base + "/app.html");
      await reader.page.waitForFunction(expected => document.querySelector(".brand [data-brand-logo]")?.getAttribute("src") === expected, secondLogo);
      assert.equal(await reader.page.locator('[data-page="settings"]').count(), 0);
      assert.equal(await reader.page.locator("#logo-file").count(), 0);
      const denied = await reader.context.request.put(base + "/api/settings/logo", { headers: { Origin: base, "X-CSRF-Token": reader.csrf }, data: { dataUrl: null } });
      assert.equal(denied.status(), 403, role + " cannot change the farm logo through the API");
      await reader.context.close();
    }
    await page.reload(); await page.locator("#logo-file").waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector("#sidebar").getBoundingClientRect().right <= 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    for (const selector of ["#logo-form", "#logo-file", "#logo-save", "#logo-reset", "#logo-preview"]) {
      const box = await page.locator(selector).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 391, "Logo controls fit the phone viewport: " + selector);
    }
    await page.screenshot({ path: path.join(artifacts, "logo-parametres-mobile.png"), fullPage: true });

    await page.goto("about:blank"); await publicPage.goto("about:blank");
    await stop(); await start();
    const persisted = await api("/api/settings");
    assert.equal(persisted.logoUrl, secondLogo); assert.equal(persisted.name, newName);
    await page.goto(base + "/app.html#settings"); await page.locator("#logo-reset").waitFor();
    const resetReply = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/settings/logo");
    page.once("dialog", dialog => dialog.accept());
    await page.locator("#logo-reset").click();
    assert.ok((await resetReply).ok());
    await page.waitForFunction(() => document.querySelector(".brand [data-brand-logo]")?.getAttribute("src") === "/mark.svg");
    assert.equal((await api("/api/settings")).logoUrl, null);
    assert.equal((await api("/api/settings")).name, newName);
    await publicPage.goto(base + "/");
    await publicPage.waitForFunction(() => document.querySelector("img[data-brand-logo]")?.getAttribute("src") === "/mark.svg");
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
    console.log("PASS ADEOYE logo : aperçu sans publication, normalisation JPEG/PNG, logo public et privé, trois PDF, paramètres préservés, erreurs et droits contrôlés, persistance et rétablissement du logo initial, mobile390. Artefacts : " + artifacts);
  } finally {
    if (browser) await browser.close();
    await stop(); fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
