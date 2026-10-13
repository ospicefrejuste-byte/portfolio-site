"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");
const jsQR = require("jsqr");
const { PNG } = require("pngjs");
const { createApplication } = require("../lib/application");

function scanPdf(buffer, dir, label) {
  assert.equal(buffer.subarray(0, 5).toString(), "%PDF-");
  const pdf = path.join(dir, label + ".pdf");
  const prefix = path.join(dir, label);
  fs.writeFileSync(pdf, buffer);
  execFileSync("pdftoppm", ["-png", "-r", "150", pdf, prefix], { stdio: "pipe", timeout: 30000 });
  const images = fs.readdirSync(dir).filter(name => name.startsWith(label + "-") && name.endsWith(".png")).sort();
  for (const name of images) {
    const image = PNG.sync.read(fs.readFileSync(path.join(dir, name)));
    const qr = jsQR(new Uint8ClampedArray(image.data), image.width, image.height, { inversionAttempts: "dontInvert" });
    if (qr) {
      const url = new URL(qr.data);
      assert.equal(url.pathname, "/verification-recu.html");
      assert.match(url.hash.slice(1), /^r1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
      return url;
    }
  }
  assert.fail("The actual rendered receipt PDF must contain a readable QR code: " + label);
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crs-receipt-qr-browser-"));
  const instance = createApplication({ dataDir: dir, setupToken: "receipt-qr-browser-setup" });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/usr/bin/chromium", args: ["--no-sandbox"] });
  const errors = [], external = [], requests = [];
  async function noOverflow(page, label) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, label);
  }
  async function state(page, value) {
    await page.locator('#receipt-verification[data-state="' + value + '"]').waitFor();
  }
  try {
    const adminContext = await browser.newContext();
    const setup = await adminContext.request.post(base + "/api/auth/setup", { data: {
      token: "receipt-qr-browser-setup", username: "qr-browser-responsable", password: "Receipt-QR-browser-password-123!",
    }});
    assert.equal(setup.status(), 200);
    const session = await setup.json();
    const headers = { "X-CSRF-Token": session.csrf };
    const school = await (await adminContext.request.get(base + "/api/admin/settings")).json();
    const centre = school.centres[0];
    const pupilResponse = await adminContext.request.post(base + "/api/records/students", { headers, data: {
      name: "Grâce Élève du reçu original", class: "6e", centre, group: "6e · " + centre,
      guardian: "Parent du reçu privé", phone: "+2290100000000", monthlyFee: 6000, registrationStatus: "Inscrit",
    }});
    assert.equal(pupilResponse.status(), 201);
    const pupil = await pupilResponse.json();
    async function collect(amount) {
      const response = await adminContext.request.post(base + "/api/cashier/payments", { headers, data: {
        requestId: crypto.randomUUID(), student: pupil.id, amount, period: "2026-10",
      }});
      assert.equal(response.status(), 201); return response.json();
    }
    const firstPayment = await collect(1500);
    const secondPayment = await collect(500);
    const sandbox = { id: crypto.randomUUID(), student: pupil.id, amount: 3500, period: "2026-11", date: "2026-10-13", source: "KKiaPay", mode: "sandbox", transactionId: "browser-qr-fixture-test" };
    // A sandbox-only isolated record avoids any real gateway or transaction.
    instance.db.prepare("INSERT INTO records(kind,id,payload) VALUES('payments',?,?)").run(sandbox.id, JSON.stringify(sandbox));
    async function pdfFor(payment) {
      const response = await adminContext.request.get(base + "/api/payments/" + payment.id + "/receipt.pdf");
      assert.equal(response.status(), 200); return response.body();
    }
    const firstUrl = scanPdf(await pdfFor(firstPayment), dir, "receipt-first");
    const secondUrl = scanPdf(await pdfFor(secondPayment), dir, "receipt-second");
    const testUrl = scanPdf(await pdfFor(sandbox), dir, "receipt-test");
    const repeatedUrl = scanPdf(await pdfFor(firstPayment), dir, "receipt-repeated");
    assert.equal(firstUrl.origin, base, "The actual QR points to this application instance");
    assert.notEqual(firstUrl.hash, secondUrl.hash, "Every different receipt has a different QR");
    assert.equal(repeatedUrl.href, firstUrl.href, "Reprinting one receipt keeps its original QR");

    const parentContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "fr-FR" });
    const page = await parentContext.newPage();
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.origin !== base) external.push(request.url());
      requests.push({ method: request.method(), url: request.url(), headers: request.headers(), body: request.postData() });
    });
    await page.goto(firstUrl.href);
    await state(page, "verified");
    assert.equal(new URL(page.url()).hash, "", "The scanned code is removed from the address immediately");
    assert.equal(await page.locator("#receipt-reference").textContent(), firstPayment.id);
    assert.equal(await page.locator("#receipt-student").textContent(), pupil.name);
    assert.equal(await page.locator("#receipt-class").textContent(), pupil.class);
    assert.equal(await page.locator("#receipt-centre").textContent(), centre);
    assert.equal(await page.locator("#receipt-school").textContent(), school.name);
    assert.match(await page.locator("#receipt-amount").textContent(), /1\s?500 FCFA/);
    assert.match(await page.locator("#receipt-period").textContent(), /octobre 2026/);
    assert.equal(await page.locator("#receipt-channel").textContent(), "Paiement en présentiel");
    assert.equal(await page.locator("#receipt-comparison").isVisible(), true);
    assert.doesNotMatch(await page.locator("#verified-receipt").textContent(), /Parent du reçu privé|0100000000|qr-browser-responsable/);
    await noOverflow(page, "Verified receipt fits a phone");
    assert.deepEqual(await parentContext.cookies(), [], "A parent can verify a receipt without a login or administrator session");
    const verificationRequest = requests.find(request => new URL(request.url).pathname === "/api/receipts/verify");
    assert.equal(verificationRequest.method, "POST");
    assert.equal(JSON.parse(verificationRequest.body).token, firstUrl.hash.slice(1));
    assert.equal(verificationRequest.headers.cookie, undefined);
    assert.ok(!verificationRequest.headers.referer, "The verification request sends no referring URL");
    assert.ok(requests.every(request => !request.url.includes(firstUrl.hash.slice(1))), "The capability is never sent in a page or resource URL");
    await page.screenshot({ path: "/tmp/crs-verified-receipt-mobile.png", fullPage: true });

    await page.goto(secondUrl.href);
    await state(page, "verified");
    assert.equal(await page.locator("#receipt-reference").textContent(), secondPayment.id);
    assert.equal(await page.locator("#receipt-amount").textContent(), "500 FCFA");
    // A QR copied onto another document still reveals the original receipt.
    // Arbitrary printed/query values cannot change the authoritative response.
    const copied = new URL(firstUrl);
    copied.searchParams.set("amount", "999999"); copied.searchParams.set("reference", secondPayment.id);
    await page.goto(copied.href);
    await state(page, "verified");
    assert.equal(await page.locator("#receipt-reference").textContent(), firstPayment.id);
    assert.match(await page.locator("#receipt-amount").textContent(), /1\s?500 FCFA/);
    assert.equal(await page.locator("#receipt-comparison").isVisible(), true);

    const renamed = await adminContext.request.put(base + "/api/records/students/" + pupil.id, { headers, data: { ...pupil, name: "Élève renommé après émission" } });
    assert.equal(renamed.status(), 200);
    await page.goto(firstUrl.href);
    await state(page, "verified");
    assert.equal(await page.locator("#receipt-student").textContent(), pupil.name);
    await page.goto(testUrl.href);
    await state(page, "test");
    assert.equal(await page.locator("#verification-title").textContent(), "Reçu de test");
    assert.match(await page.locator("#verification-message").textContent(), /pas.*paiement réel/);
    assert.match(await page.locator("#verification-help").textContent(), /ne prouve aucun encaissement/);
    assert.equal(await page.locator("#receipt-reference").textContent(), sandbox.id);
    await noOverflow(page, "A sandbox receipt remains clearly a test on a phone");
    const tampered = new URL(firstUrl);
    const parts = tampered.hash.slice(1).split(".");
    parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
    tampered.hash = parts.join(".");
    await page.goto(tampered.href);
    await state(page, "invalid");
    assert.equal(await page.locator("#verified-receipt").isVisible(), false);
    assert.equal(await page.locator("#verification-retry").isVisible(), false);

    let failure = "server";
    await page.route("**/api/receipts/verify", route => {
      if (failure === "server") return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Isolated server interruption"}' });
      if (failure === "limit") return route.fulfill({ status: 429, contentType: "application/json", body: '{"error":"Isolated rate limit"}' });
      if (failure === "malformed") return route.fulfill({ contentType: "application/json", body: '{"status":"verified","receipt":{"amount":999999}}' });
      if (failure === "offline") return route.abort("internetdisconnected");
      return route.continue();
    });
    for (const outage of ["server", "limit", "malformed", "offline"]) {
      failure = outage;
      await page.goto(firstUrl.href);
      await state(page, "unavailable");
      assert.equal(await page.locator("#verified-receipt").isVisible(), false);
      assert.equal(await page.locator("#verification-retry").isVisible(), true);
      assert.doesNotMatch(await page.locator("#verification-title").textContent(), /non reconnu|fraud|faux/i);
      assert.equal(new URL(page.url()).hash, "");
      failure = "";
      await page.locator("#verification-retry").click();
      await state(page, "verified");
      assert.equal(await page.locator("#receipt-reference").textContent(), firstPayment.id, "Retry retains the scanned code in memory after clearing the fragment");
    }
    await page.unroute("**/api/receipts/verify");
    await page.goto(base + "/verification-recu.html");
    await state(page, "missing");
    assert.equal(await page.locator("#verified-receipt").isVisible(), false);
    await noOverflow(page, "The scanner help fits a phone");
    assert.deepEqual(external, [], "No external service receives the parent or verification code");
    assert.deepEqual(errors, []);
    console.log("PASS QR de chaque PDF réellement décodé, signatures distinctes et réimpression stable, vérification publique sans compte, vérité serveur comparée au document, snapshot original, test distinct du réel, falsification refusée, panne distincte d’un faux reçu, code retiré de l’adresse et aucun appel externe, mobile 390px.");
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    instance.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
