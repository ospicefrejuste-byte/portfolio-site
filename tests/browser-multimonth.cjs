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
const applicationModule = require(process.env.CLOUD_APP_MODULE || "../lib/application");

const compact = value => String(value).replace(/\s/g, "");
const monthLabels = periods => periods.map(period => {
  const [year, month] = period.split("-").map(Number);
  return new Date(year, month - 1, 1, 12).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
});
const consecutive = (start, count) => {
  const [year, month] = start.split("-").map(Number);
  return Array.from({ length: count }, (_, index) => {
    const serial = year * 12 + month - 1 + index;
    return Math.floor(serial / 12) + "-" + String(serial % 12 + 1).padStart(2, "0");
  });
};

function inspectPdf(buffer, dir, label, allocations, amount) {
  assert.equal(buffer.subarray(0, 5).toString(), "%PDF-");
  const filename = path.join(dir, label + ".pdf");
  fs.writeFileSync(filename, buffer);
  const text = execFileSync("pdftotext", ["-layout", filename, "-"], { encoding: "utf8", timeout: 30000 });
  for (const allocation of allocations) {
    assert.ok(text.includes(allocation.period), label + ": printed month " + allocation.period);
    assert.ok(compact(text).includes(allocation.amount + "FCFA"), label + ": printed allocation " + allocation.amount);
  }
  assert.equal(compact(text).split(amount + "FCFA").length - 1, 1, label + ": the payment total is printed once");
  execFileSync("pdftoppm", ["-png", "-r", "150", filename, path.join(dir, label)], { stdio: "pipe", timeout: 30000 });
  const codes = [];
  for (const name of fs.readdirSync(dir).filter(name => name.startsWith(label + "-") && name.endsWith(".png"))) {
    const png = PNG.sync.read(fs.readFileSync(path.join(dir, name)));
    const qr = jsQR(new Uint8ClampedArray(png.data), png.width, png.height, { inversionAttempts: "dontInvert" });
    if (qr) codes.push(new URL(qr.data));
  }
  assert.equal(codes.length, 1, label + ": one readable QR for the entire receipt");
  assert.equal(codes[0].pathname, "/verification-recu.html");
  assert.match(codes[0].hash.slice(1), /^r1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  return codes[0];
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crs-multimonth-browser-"));
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "crs-multimonth-artifacts-"));
  const providerOrigin = "https://widget-v3.kkiapay.me";
  const transactions = new Map();
  let verificationCalls = 0;
  const applicationOptions = {
    dataDir: dir, setupToken: "multimonth-browser-setup",
    paymentConfig: { publicKey: "test-public", privateKey: "test-private", secretKey: "test-secret", sandbox: true },
    verifyTransaction: async id => {
      verificationCalls++;
      assert.ok(transactions.has(id), "Only explicitly mocked provider transactions can be verified");
      return transactions.get(id);
    },
  };
  let instance = await applicationModule.createApplication(applicationOptions);
  let server = instance.app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  let base = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/usr/bin/chromium", args: ["--no-sandbox"] });
  const errors = [], unexpectedExternal = [], qrTokens = new Set();
  const contexts = [];
  async function context(options = {}) {
    const result = await browser.newContext({ locale: "fr-FR", ...options });
    contexts.push(result);
    await result.route(url => url.origin !== base, route => {
      const url = new URL(route.request().url());
      if (url.origin === providerOrigin) return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><body><p id="test-widget">Paiement de test local</p></body></html>' });
      unexpectedExternal.push(route.request().url());
      return route.abort("blockedbyclient");
    });
    result.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    return result;
  }
  async function download(page, button) {
    const pending = page.waitForEvent("download");
    await button.click();
    const result = await pending;
    assert.match(result.suggestedFilename(), /\.pdf$/);
    return fs.readFileSync(await result.path());
  }
  function assertAllocations(payment, periods, amounts) {
    assert.deepEqual(payment.allocations, periods.map((period, index) => ({ period, amount: amounts[index] })));
    assert.equal(payment.amount, amounts.reduce((sum, amount) => sum + amount, 0));
  }
  const parent = await context({ viewport: { width: 390, height: 844 } });
  const verifier = await parent.newPage();
  async function verifyPdf(buffer, label, payment, sandbox = false) {
    const url = inspectPdf(buffer, artifacts, label, payment.allocations, payment.amount);
    assert.equal(url.origin, base);
    assert.ok(!qrTokens.has(url.hash), label + ": a distinct payment has a unique QR");
    qrTokens.add(url.hash);
    await verifier.goto(url.href);
    await verifier.locator('#receipt-verification[data-state="' + (sandbox ? "test" : "verified") + '"]').waitFor();
    assert.equal(await verifier.locator("#receipt-reference").textContent(), payment.id);
    assert.equal(compact(await verifier.locator("#receipt-amount").textContent()), payment.amount + "FCFA");
    assert.deepEqual(await verifier.locator("#receipt-allocations dt").allTextContents(), monthLabels(payment.allocations.map(allocation => allocation.period)));
    assert.deepEqual((await verifier.locator("#receipt-allocations dd").allTextContents()).map(compact), payment.allocations.map(allocation => allocation.amount + "FCFA"));
    for (const label of monthLabels(payment.allocations.map(allocation => allocation.period)))
      assert.ok((await verifier.locator("#receipt-period").textContent()).includes(label));
    assert.equal(await verifier.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(await parent.cookies(), [], "Public verification never creates an authenticated session");
    return url;
  }
  try {
    const adminContext = await context({ viewport: { width: 1440, height: 1000 } });
    const setup = await adminContext.request.post(base + "/api/auth/setup", { data: {
      token: "multimonth-browser-setup", username: "multimonth-admin", password: "Multimonth-admin-password-123!",
    }});
    assert.equal(setup.status(), 200);
    const headers = { "X-CSRF-Token": (await setup.json()).csrf };
    async function api(route, method = "GET", data) {
      const response = await adminContext.request.fetch(base + route, { method, headers, ...(data === undefined ? {} : { data }) });
      assert.ok(response.ok(), method + " " + route + ": " + response.status() + " " + await response.text());
      return response.json();
    }
    const settings = await api("/api/admin/settings");
    const centre = settings.centres[0];
    async function pupil(name, monthlyFee = 3500) {
      return api("/api/records/students", "POST", { name, class: "6e", centre, group: "6e · " + centre, guardian: "Parent de test", phone: "+2290100000000", monthlyFee, registrationStatus: "Inscrit" });
    }
    const cashPupil = await pupil("Élève huit et dix-huit mois en caisse");
    const arbitraryPupil = await pupil("Élève mois espacés sur plusieurs pages");
    const privatePupil = await pupil("Élève paiement privé libre", 4500);
    await api("/api/cashier/payments", "POST", { requestId: crypto.randomUUID(), student: cashPupil.id, period: "2026-12", amount: 3500 });
    await api("/api/cashier/payments", "POST", { requestId: crypto.randomUUID(), student: cashPupil.id, period: "2027-01", amount: 1000 });
    const admin = await adminContext.newPage();
    await admin.goto(base + "/gestion.html?section=cashier");
    await admin.locator("#cashier-period").fill("2026-12");
    const card = id => admin.locator('.cashier-student-card').filter({ has: admin.locator('[data-cashier-collect="' + id + '"]') });
    await card(cashPupil.id).locator('[data-cashier-months="' + cashPupil.id + '"]').waitFor();
    assert.equal(await card(cashPupil.id).locator("[data-cashier-collect]").isDisabled(), true);
    await card(cashPupil.id).locator("[data-cashier-months]").click();
    await admin.locator('[data-cashier-month="2026-12"]').waitFor();
    assert.equal(await admin.locator("[data-cashier-month]").count(), 12);
    assert.equal(await admin.locator('[data-cashier-month="2026-12"]').isDisabled(), true);
    assert.equal(await admin.locator('[data-cashier-month="2026-12"]').isChecked(), true, "Settled months remain checked and read only");
    const selected = () => admin.locator("[data-cashier-month]:checked:not(:disabled)").evaluateAll(inputs => inputs.map(input => input.value));
    async function cashCount(count) {
      await admin.locator("#cashier-month-count").fill(String(count));
      await admin.locator("#cashier-month-count-apply").click();
      await admin.waitForFunction(count => document.querySelector(".cashier-month-total")?.textContent.includes(count + " mois à régler"), count);
    }
    await admin.locator('[data-cashier-month-count="3"]').click();
    await admin.waitForFunction(() => document.querySelector("#cashier-amount")?.value === "9500");
    assert.deepEqual(await selected(), consecutive("2027-01", 3), "The legacy shortcut still skips paid months");
    await cashCount(8);
    const eightPeriods = consecutive("2027-01", 8);
    assert.deepEqual(await selected(), eightPeriods);
    assert.equal(await admin.locator("#cashier-amount").inputValue(), "27000");
    assert.equal(await admin.locator("#cashier-amount").getAttribute("readonly"), "");
    assert.equal(await admin.locator('[data-cashier-month="2027-09"]').isEnabled(), true, "There is no six-month selection ceiling");
    await admin.setViewportSize({ width: 390, height: 844 });
    assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await admin.screenshot({ path: path.join(artifacts, "cashier-month-picker-mobile.png"), fullPage: true });
    await admin.locator("#cashier-amount-form button[type=submit]").click();
    for (const label of monthLabels(eightPeriods)) assert.ok((await admin.locator(".cashier-confirm-months").textContent()).includes(label));
    assert.ok(!(await admin.locator(".cashier-confirm-months").textContent()).includes("décembre 2026"), "A checked settled month is excluded from the confirmation");
    const cashRequests = [];
    let lostReceipt;
    await admin.route("**/api/cashier/payments", async route => {
      cashRequests.push(route.request().postDataJSON());
      if (!lostReceipt) {
        const response = await route.fetch();
        assert.equal(response.status(), 201);
        lostReceipt = await response.json();
        return route.abort("failed");
      }
      return route.continue();
    });
    await admin.locator("#cashier-collect-confirm").click();
    await admin.getByRole("button", { name: "Réessayer la confirmation", exact: true }).waitFor();
    assert.equal(await admin.locator("#cashier-collect-back").count(), 0, "An uncertain payment keeps the original month selection immutable");
    await admin.locator("#cashier-collect-confirm").evaluate(button => { button.click(); button.click(); });
    await admin.locator("#cashier-success-pdf").waitFor();
    assert.equal(cashRequests.length, 2, "Repeated clicks create only one retry request");
    assert.deepEqual(cashRequests[0], cashRequests[1]);
    assert.deepEqual(cashRequests[0].periods, eightPeriods, "Settled checked months are excluded from the actual request");
    assert.equal(cashRequests[0].amount, 27000);
    assertAllocations(lostReceipt, eightPeriods, [2500, ...Array(7).fill(3500)]);
    let cashPayments = (await api("/api/data")).payments.filter(payment => payment.student === cashPupil.id);
    assert.equal(cashPayments.length, 3, "The uncertain retry creates no duplicate receipt");
    const firstBuffer = await download(admin, admin.locator("#cashier-success-pdf"));
    const firstUrl = await verifyPdf(firstBuffer, "cash-eight-partial", lostReceipt);
    const repeatedBuffer = await download(admin, admin.locator("#cashier-success-pdf"));
    assert.equal(inspectPdf(repeatedBuffer, artifacts, "cash-eight-reprinted", lostReceipt.allocations, lostReceipt.amount).href, firstUrl.href);
    await admin.unroute("**/api/cashier/payments");
    await admin.locator("#cashier-collect-done").click();
    await card(cashPupil.id).locator("[data-cashier-months]").click();
    await admin.locator('[data-cashier-month="2026-12"]').waitFor();
    await cashCount(18);
    const eighteenCashPeriods = consecutive("2027-09", 18);
    assert.equal(await admin.locator("#cashier-amount").inputValue(), "63000");
    await admin.locator("#cashier-month-next").click();
    await admin.locator('[data-cashier-month="2027-12"]').waitFor();
    assert.deepEqual(await selected(), consecutive("2027-12", 12));
    await admin.locator("#cashier-month-prev").click();
    await admin.locator('[data-cashier-month="2026-12"]').waitFor();
    assert.deepEqual(await selected(), consecutive("2027-09", 3), "Returning to the first page preserves the whole selection");
    assert.equal(await admin.locator('[data-cashier-month="2027-01"]').isChecked(), true);
    assert.equal(await admin.locator('[data-cashier-month="2027-01"]').isDisabled(), true);
    await admin.locator("#cashier-amount-form button[type=submit]").click();
    for (const label of monthLabels(eighteenCashPeriods)) assert.ok((await admin.locator(".cashier-confirm-months").textContent()).includes(label));
    await admin.locator("#cashier-collect-confirm").click();
    await admin.locator("#cashier-success-pdf").waitFor();
    cashPayments = (await api("/api/data")).payments.filter(payment => payment.student === cashPupil.id);
    assert.equal(cashPayments.length, 4);
    const eighteenCashPayment = cashPayments.find(payment => payment.allocations?.length === 18);
    assertAllocations(eighteenCashPayment, eighteenCashPeriods, Array(18).fill(3500));
    await verifyPdf(await download(admin, admin.locator("#cashier-success-pdf")), "cash-eighteen", eighteenCashPayment);
    await admin.locator("#cashier-collect-done").click();

    await card(arbitraryPupil.id).locator("[data-cashier-collect]").click();
    await admin.locator("#cashier-month-clear").click();
    const arbitraryPeriods = ["2026-12", "2027-02", "2027-06", "2028-01", "2028-05", "2029-01", "2029-02", "2030-03"];
    for (const group of [arbitraryPeriods.slice(0, 3), arbitraryPeriods.slice(3, 5), arbitraryPeriods.slice(5, 7), arbitraryPeriods.slice(7)]) {
      await admin.locator('[data-cashier-month="' + group[0] + '"]').waitFor();
      for (const period of group) await admin.locator('[data-cashier-month="' + period + '"]').check();
      if (group[0] !== "2030-03") await admin.locator("#cashier-month-next").click();
    }
    for (let page = 0; page < 3; page++) {
      const expected = ["2028-12", "2027-12", "2026-12"][page];
      await admin.locator("#cashier-month-prev").click();
      await admin.locator('[data-cashier-month="' + expected + '"]').waitFor();
    }
    assert.deepEqual(await selected(), arbitraryPeriods.slice(0, 3));
    assert.equal(await admin.locator("#cashier-amount").inputValue(), "28000");
    await admin.locator("#cashier-amount-form button[type=submit]").click();
    for (const label of monthLabels(arbitraryPeriods)) assert.ok((await admin.locator(".cashier-confirm-months").textContent()).includes(label));
    await admin.locator("#cashier-collect-confirm").click();
    await admin.locator("#cashier-success-pdf").waitFor();
    const arbitraryPayment = (await api("/api/data")).payments.find(payment => payment.student === arbitraryPupil.id);
    assertAllocations(arbitraryPayment, arbitraryPeriods, Array(8).fill(3500));
    await verifyPdf(await download(admin, admin.locator("#cashier-success-pdf")), "cash-nonconsecutive-eight", arbitraryPayment);
    await admin.locator("#cashier-collect-done").click();
    for (const [period, total] of [["2026-12", 7000], ["2027-01", 3500], ["2027-02", 7000], ["2028-01", 7000]]) {
      const ledger = await api("/api/cashier?period=" + period);
      assert.equal(ledger.totals.cash, total, "Cash ledger attributes only each month's allocation: " + period);
    }
    await api("/api/cashier/payments", "POST", { requestId: crypto.randomUUID(), student: privatePupil.id, period: "2026-11", amount: 4500 });
    for (const [period, amount] of [["2026-11", 4500], ["2026-12", 1000]]) {
      const payment = { id: crypto.randomUUID(), student: privatePupil.id, period, amount, date: "2026-10-22", source: "KKiaPay", mode: "sandbox" };
      await instance.db.prepare("INSERT INTO records(kind,id,payload) VALUES('payments',?,?)").run(payment.id, JSON.stringify(payment));
    }

    await api("/api/admin/users", "POST", { username: "multimonth-student", role: "student", entityId: privatePupil.id, password: "Initial-multimonth-student-123!" });
    const privateContext = await context({ viewport: { width: 1440, height: 1000 } });
    const login = await privateContext.request.post(base + "/api/auth/login", { data: { username: "multimonth-student", password: "Initial-multimonth-student-123!" } });
    assert.equal(login.status(), 200);
    const changed = await privateContext.request.post(base + "/api/auth/password", { headers: { "X-CSRF-Token": (await login.json()).csrf }, data: { currentPassword: "Initial-multimonth-student-123!", password: "Personal-multimonth-student-123!" } });
    assert.equal(changed.status(), 200);
    const privatePage = await privateContext.newPage();
    await privatePage.goto(base + "/gestion.html?section=payments");
    async function captureWidget(page) {
      await page.evaluate(() => {
        const original = window.openKkiapayWidget;
        window.__widgetOrders = [];
        window.openKkiapayWidget = options => { window.__widgetOrders.push(options); return original(options); };
      });
    }
    async function confirmWidget(page, transactionId, confirmPath) {
      await page.waitForFunction(() => window.__widgetOrders?.length > 0);
      const widget = await page.evaluate(() => window.__widgetOrders.at(-1));
      assert.equal(widget.sandbox, true);
      const orderId = JSON.parse(widget.data).orderId;
      transactions.set(transactionId, { status: "SUCCESS", amount: widget.amount, data: widget.data });
      const frame = await (await page.locator('iframe[src="' + providerOrigin + '"]').elementHandle()).contentFrame();
      assert.ok(frame);
      await frame.locator("#test-widget").waitFor();
      const before = verificationCalls;
      await page.evaluate(transactionId => new Promise(resolve => {
        const listener = event => {
          if (event.source === window && event.data?.data?.transactionId === transactionId) {
            window.removeEventListener("message", listener); resolve();
          }
        };
        window.addEventListener("message", listener);
        window.postMessage({ name: "PAYMENT_SUCCESS", data: { transactionId } }, "*");
      }), transactionId);
      assert.equal(verificationCalls, before, "Parent-window messages cannot spoof the official widget");
      const requests = [];
      const listener = request => { if (new URL(request.url()).pathname === confirmPath && request.method() === "POST") requests.push(request.postDataJSON()); };
      page.on("request", listener);
      const confirmed = page.waitForResponse(response => new URL(response.url()).pathname === confirmPath && response.request().method() === "POST" && response.status() === 200);
      await frame.evaluate(({ parentOrigin, transactionId }) => {
        const event = { name: "PAYMENT_SUCCESS", data: { transactionId } };
        window.parent.postMessage(event, parentOrigin);
        window.parent.postMessage(event, parentOrigin);
      }, { parentOrigin: base, transactionId });
      await confirmed;
      assert.equal(verificationCalls, before + 1, "Duplicate iframe messages require one server verification");
      assert.equal(requests.length, 1, "Duplicate iframe messages submit one confirmation");
      page.off("request", listener);
      const matches = (await api("/api/data")).payments.filter(payment => payment.transactionId === transactionId);
      assert.equal(matches.length, 1, "Only one online receipt is persisted");
      return { widget, orderId, payment: matches[0] };
    }
    async function chooseCount(page, periodSelector, countSelector, start, count, rootSelector) {
      await page.locator(periodSelector).fill(start);
      await page.locator(periodSelector).dispatchEvent("change");
      await page.locator(periodSelector).blur();
      await page.locator(rootSelector + " .payment-calendar-status").waitFor({ state: "hidden" });
      await page.locator(countSelector).fill(String(count));
      await page.locator(countSelector).dispatchEvent("change");
      await page.locator(countSelector).blur();
      await page.locator(rootSelector + " .payment-calendar-status").waitFor({ state: "hidden" });
      await page.waitForFunction(({ rootSelector, count }) => document.querySelector(rootSelector + " [data-payment-count]")?.textContent === count + " mois sélectionné" + (count > 1 ? "s" : ""), { rootSelector, count });
      assert.equal(await page.locator(rootSelector + " .payment-calendar-error").count(), 0);
    }
    const privateRoot = "#checkout-month-picker";
    for (const [count, start] of [[2, "2026-12"], [7, "2027-12"], [18, "2028-12"]]) {
      await captureWidget(privatePage);
      await privatePage.locator("#pay-online").click();
      if (count === 2) {
        await privatePage.locator("#f-period").fill("2026-11");
        await privatePage.locator("#f-period").dispatchEvent("change");
        await privatePage.locator(privateRoot + ' [data-payment-period="2026-11"]:checked:disabled').waitFor();
        // Changing only the display date preserves the previous selection.
        // Explicitly choose this paid month to verify that it adds no amount.
        await privatePage.locator("#f-monthCount").fill("1");
        await privatePage.locator("#f-monthCount").dispatchEvent("change");
        await privatePage.locator(privateRoot + " .payment-calendar-status").waitFor({ state: "hidden" });
        assert.equal(compact(await privatePage.locator("#checkout-total").textContent()), "0FCFA", "Paid test months remain checked and excluded from the total");
      }
      await chooseCount(privatePage, "#f-period", "#f-monthCount", start, count, privateRoot);
      let periods = consecutive(start, count);
      if (count === 7) {
        await privatePage.locator(privateRoot + ' [data-payment-period="2028-01"]').uncheck();
        await privatePage.locator(privateRoot + ' [data-payment-period="2028-08"]').check();
        periods = periods.filter(period => period !== "2028-01").concat("2028-08").sort();
      }
      if (count === 18) {
        await privatePage.locator(privateRoot + ' [data-payment-nav="next"]').click();
        await privatePage.locator(privateRoot + ' [data-payment-period="2029-12"]:checked').waitFor();
        await privatePage.locator(privateRoot + ' [data-payment-period="2030-05"]').uncheck();
        await privatePage.locator(privateRoot + ' [data-payment-period="2030-07"]').check();
        periods = periods.filter(period => period !== "2030-05").concat("2030-07").sort();
        await privatePage.locator(privateRoot + ' [data-payment-nav="previous"]').click();
        await privatePage.locator(privateRoot + ' [data-payment-period="2028-12"]:checked').waitFor();
      }
      const amounts = periods.map(period => period === "2026-12" ? 3500 : 4500);
      const total = amounts.reduce((sum, amount) => sum + amount, 0);
      assert.equal(await privatePage.locator("#checkout-months").textContent(), monthLabels(periods).join(", "));
      assert.equal(compact(await privatePage.locator("#checkout-total").textContent()), total + "FCFA");
      const checkoutRequest = privatePage.waitForRequest(request => new URL(request.url()).pathname === "/api/payments/checkout" && request.method() === "POST", { timeout: 10000 });
      await privatePage.locator("#form button[type=submit]").click();
      let submitted;
      try { submitted = await checkoutRequest; }
      catch (error) {
        await privatePage.screenshot({ path: path.join(artifacts, "private-checkout-failure.png"), fullPage: true });
        console.error("Private checkout diagnostics", { count, errors, message: await privatePage.locator("#error").textContent(), invalid: await privatePage.locator("#form :invalid").evaluateAll(inputs => inputs.map(input => ({ id: input.id, value: input.value, message: input.validationMessage }))) });
        throw error;
      }
      assert.deepEqual(submitted.postDataJSON(), { student: privatePupil.id, periods });
      const result = await confirmWidget(privatePage, "multimonth-private-" + count, "/api/payments/confirm");
      assert.equal(result.widget.amount, total);
      assertAllocations(result.payment, periods, amounts);
      await privatePage.locator('[data-receipt="' + result.payment.id + '"]').waitFor();
      await privatePage.locator('[data-receipt="' + result.payment.id + '"]').click();
      for (const label of monthLabels(periods)) assert.ok((await privatePage.locator(".receipt").textContent()).includes(label));
      await privatePage.locator("#close").click();
      const response = await privatePage.request.get(base + "/api/payments/" + result.payment.id + "/receipt.pdf");
      assert.equal(response.status(), 200);
      await verifyPdf(await response.body(), "private-" + count, result.payment, true);
      await privatePage.locator("#pay-online").click();
      await privatePage.locator("#f-period").fill(start);
      await privatePage.locator("#f-period").dispatchEvent("change");
      await privatePage.locator(privateRoot + ' [data-payment-period="' + periods[0] + '"]:checked:disabled').waitFor();
      await privatePage.locator("#f-monthCount").fill("1");
      await privatePage.locator("#f-monthCount").dispatchEvent("change");
      await privatePage.locator(privateRoot + " .payment-calendar-status").waitFor({ state: "hidden" });
      assert.equal(compact(await privatePage.locator("#checkout-total").textContent()), "0FCFA");
      await privatePage.locator("#close").click();
    }

    async function register(page, name) {
      await page.goto(base);
      await page.locator('[name="name"]').fill(name);
      await page.locator('[name="guardian"]').fill("Parent public fictif");
      await page.locator('[name="phone"]').fill("0100000000");
      await page.locator("#consent").check();
      await page.getByRole("button", { name: "Valider mon inscription" }).click();
      await page.locator("#confirmation").waitFor({ state: "visible" });
      await page.locator("#payment-month-picker .payment-calendar-status").waitFor({ state: "hidden" });
    }
    for (const count of [2, 7, 18]) {
      const publicContext = await context({ viewport: { width: 390, height: 844 } });
      const publicPage = await publicContext.newPage();
      await register(publicPage, "Élève public " + count + " mois");
      const root = "#payment-month-picker";
      await chooseCount(publicPage, "#payment-period", "#payment-month-count", "2026-12", count, root);
      let periods = consecutive("2026-12", count);
      if (count === 7) {
        await publicPage.locator(root + ' [data-payment-period="2027-01"]').uncheck();
        await publicPage.locator(root + ' [data-payment-period="2027-08"]').check();
        periods = periods.filter(period => period !== "2027-01").concat("2027-08").sort();
      }
      if (count === 18) {
        await publicPage.locator(root + ' [data-payment-nav="next"]').click();
        await publicPage.locator(root + ' [data-payment-period="2027-12"]:checked').waitFor();
        await publicPage.locator(root + ' [data-payment-period="2028-05"]').uncheck();
        await publicPage.locator(root + ' [data-payment-period="2028-07"]').check();
        periods = periods.filter(period => period !== "2028-05").concat("2028-07").sort();
        await publicPage.locator(root + ' [data-payment-nav="previous"]').click();
        await publicPage.locator(root + ' [data-payment-period="2026-12"]:checked').waitFor();
      }
      assert.equal(await publicPage.locator("#payment-months").textContent(), monthLabels(periods).join(", "));
      const monthlyFee = Number(compact(await publicPage.locator("#amount").textContent()).replace("FCFA", ""));
      assert.ok(monthlyFee > 0);
      assert.equal(compact(await publicPage.locator("#payment-total").textContent()), count * monthlyFee + "FCFA");
      await captureWidget(publicPage);
      const checkoutRequest = publicPage.waitForRequest(request => new URL(request.url()).pathname === "/api/registration-payments/checkout" && request.method() === "POST");
      await publicPage.locator("#pay").click();
      assert.deepEqual((await checkoutRequest).postDataJSON(), { periods });
      await publicPage.waitForFunction(() => window.__widgetOrders?.length > 0);
      assert.equal(await publicPage.locator("#payment-period").isDisabled(), true);
      assert.equal(await publicPage.locator("#payment-month-count").isDisabled(), true);
      const result = await confirmWidget(publicPage, "multimonth-public-" + count, "/api/registration-payments/confirm");
      assert.equal(result.widget.amount, count * monthlyFee);
      assertAllocations(result.payment, periods, Array(count).fill(monthlyFee));
      await publicPage.locator("#paid").waitFor({ state: "visible" });
      assert.equal(await publicPage.locator("#receipt-months").textContent(), monthLabels(periods).join(", "));
      assert.equal(compact(await publicPage.locator("#receipt-amount").textContent()), count * monthlyFee + "FCFA");
      assert.equal(await publicPage.locator("#pay").isVisible(), false);
      await publicPage.locator(root + ' [data-payment-period="' + periods[0] + '"]:checked:disabled').waitFor();
      assert.equal(compact(await publicPage.locator("#payment-total").textContent()), "0FCFA");
      assert.equal(await publicPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await verifyPdf(await download(publicPage, publicPage.locator("#download-receipt")), "public-" + count, result.payment, true);
      await publicPage.locator("#another-payment").click();
      await publicPage.locator(root + ' [data-payment-period="' + periods[0] + '"]:checked:disabled').waitFor();
      assert.equal(await publicPage.locator("#download-receipt").isVisible(), true, "A new choice retains the previous receipt");
      assert.equal(compact(await publicPage.locator("#payment-total").textContent()), "0FCFA");
      if (count === 18) await publicPage.screenshot({ path: path.join(artifacts, "public-eighteen-months-mobile.png"), fullPage: true });
    }
    await verifier.route("**/api/receipts/verify", async route => {
      const response = await route.fetch();
      const payload = await response.json();
      payload.receipt.allocations[0].amount++;
      return route.fulfill({ response, json: payload });
    });
    await verifier.goto(firstUrl.href);
    await verifier.locator('#receipt-verification[data-state="unavailable"]').waitFor();
    assert.equal(await verifier.locator("#verified-receipt").isVisible(), false, "Malformed allocation totals never appear as a verified receipt");
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedExternal, [], "All provider iframes are intercepted; no real gateway or other external service is contacted");
    assert.equal(verificationCalls, 6);
    assert.equal(qrTokens.size, 9);
    // Restart the same persisted fixture without provider credentials. Cash
    // receipts must remain visible while actual checkout remains deferred.
    for (const browserContext of contexts) for (const page of browserContext.pages()) await page.goto("about:blank");
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await instance.db.close();
    instance = await applicationModule.createApplication({ ...applicationOptions, paymentConfig: {} });
    server = instance.app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    base = "http://127.0.0.1:" + server.address().port;
    assert.equal((await api("/api/payments/config")).configured, false);
    const deferredRequests = [];
    privatePage.on("request", request => { if (/\/(checkout|confirm)$/.test(new URL(request.url()).pathname)) deferredRequests.push(request.url()); });
    await privatePage.goto(base + "/gestion.html?section=payments");
    await privatePage.locator("#pay-online").click();
    await privatePage.locator("#f-period").fill("2026-11");
    await privatePage.locator("#f-period").dispatchEvent("change");
    await privatePage.locator('#checkout-month-picker [data-payment-period="2026-11"]:checked:disabled').waitFor();
    assert.match(await privatePage.locator("#checkout-month-picker .payment-calendar-mode").textContent(), /Soldes réels/);
    await chooseCount(privatePage, "#f-period", "#f-monthCount", "2032-01", 18, "#checkout-month-picker");
    assert.equal(await privatePage.locator('#form button[type="submit"]').isDisabled(), true);
    assert.match(await privatePage.locator("#fields").textContent(), /différé/);
    const deferredContext = await context({ viewport: { width: 390, height: 844 } });
    const deferredPage = await deferredContext.newPage();
    deferredPage.on("request", request => { if (/\/(checkout|confirm)$/.test(new URL(request.url()).pathname)) deferredRequests.push(request.url()); });
    await register(deferredPage, "Élève public paiement différé");
    const deferredStudent = (await api("/api/data")).students.find(student => student.name === "Élève public paiement différé");
    await api("/api/cashier/payments", "POST", { requestId: crypto.randomUUID(), student: deferredStudent.id, period: "2026-12", amount: deferredStudent.monthlyFee });
    await deferredPage.locator("#payment-period").fill("2026-12");
    await deferredPage.locator("#payment-period").dispatchEvent("change");
    await deferredPage.locator('#payment-month-picker [data-payment-period="2026-12"]:checked:disabled').waitFor();
    assert.match(await deferredPage.locator("#payment-month-picker .payment-calendar-mode").textContent(), /Soldes réels/);
    await chooseCount(deferredPage, "#payment-period", "#payment-month-count", "2027-01", 7, "#payment-month-picker");
    assert.equal(await deferredPage.locator("#pay").isDisabled(), true);
    assert.match(await deferredPage.locator("#payment-note").textContent(), /différé/);
    assert.deepEqual(deferredRequests, [], "Unconfigured calendars never create provider orders or confirmations");
    assert.equal(verificationCalls, 6);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedExternal, []);
    console.log("PASS caisse 8/18 mois et huit mois espacés sur quatre pages; payé coché et exclu, soldes partiels, reprise incertaine idempotente; privé/public 2/7/18 avec calendrier libre et iframe KKiaPay simulée; neuf PDF et QR uniques, total unique, réimpression stable; soldes réels sans clés et paiement différé. Artefacts : " + artifacts);
  } finally {
    await browser.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await instance.db.close();
    if (applicationModule.cleanup) await applicationModule.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
