"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const { createApplication } = require("../lib/application");

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crs-cashier-browser-"));
  const instance = createApplication({ dataDir: dir, setupToken: "cashier-browser-setup" });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const period = new Date().toISOString().slice(0, 7);
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/usr/bin/chromium", args: ["--no-sandbox"] });
  const errors = [];
  function track(page) { page.on("pageerror", error => errors.push(error.message)); }
  async function api(page, route, method = "GET", data) {
    return page.evaluate(({ route, method, data }) => schoolAPI.request(route, method, data), { route, method, data });
  }
  async function downloadPdf(page, click) {
    const pending = page.waitForEvent("download");
    await click();
    const download = await pending;
    assert.match(download.suggestedFilename(), /\.pdf$/);
    const file = fs.readFileSync(await download.path());
    assert.equal(file.subarray(0, 5).toString(), "%PDF-");
    return download;
  }
  async function login(page, username, password) {
    await page.goto(base + "/connexion.html");
    await page.locator("#username").fill(username);
    await page.locator("#password").fill(password);
    await page.getByRole("button", { name: "Se connecter" }).click();
    await page.waitForURL("**/gestion.html");
  }
  async function noOverflow(page, label) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, label);
  }
  try {
    const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const admin = await adminContext.newPage(); track(admin);
    await admin.goto(base + "/installation.html");
    await admin.locator("#token").fill("cashier-browser-setup");
    await admin.locator("#username").fill("admin");
    await admin.locator("#password").fill("Admin-cashier-browser-123!");
    await admin.locator("#confirm-password").fill("Admin-cashier-browser-123!");
    await admin.getByRole("button", { name: "Créer mon compte administrateur" }).click();
    await admin.waitForURL("**/gestion.html");
    await admin.locator("[data-page=users]").waitFor();
    const catalogue = await api(admin, "/api/catalogue");
    const centre = catalogue.centres[0];
    const pupil = await api(admin, "/api/records/students", "POST", {
      name: "Élève caisse navigateur", class: "6e", centre, group: "6e · " + centre,
      guardian: "Parent caisse", phone: "+2290100000000", subjects: ["Mathématiques"], monthlyFee: 3500,
    });
    const onlinePupil = await api(admin, "/api/records/students", "POST", {
      name: "Élève paiement en ligne", class: "6e", centre, group: "6e · " + centre, monthlyFee: 3500,
    });
    // Verified-provider records are seeded only in this isolated test database;
    // the browser never connects to a payment gateway or sends a real message.
    const online = { id: crypto.randomUUID(), student: onlinePupil.id, period, date: new Date().toISOString().slice(0, 10), amount: 1000, source: "KKiaPay", mode: "live", transactionId: "cashier-browser-fixture" };
    const sandbox = { ...online, id: crypto.randomUUID(), mode: "sandbox", amount: 3500, transactionId: "cashier-browser-test-fixture" };
    for (const payment of [online, sandbox]) instance.db.prepare("INSERT INTO records(kind,id,payload) VALUES('payments',?,?)").run(payment.id, JSON.stringify(payment));
    await admin.reload();
    await admin.locator("[data-page=users]").click();
    await admin.locator("#add").click();
    await admin.locator("#f-username").fill("cashier-browser");
    await admin.locator("#f-role").selectOption("cashier");
    assert.equal(await admin.locator("#f-entityId").isVisible(), false);
    assert.equal(await admin.locator("#f-entityId").isDisabled(), true);
    await admin.locator("#f-password").fill("Initial-cashier-browser-123!");
    await admin.locator("#form button[type=submit]").click();
    await admin.locator("#modal").waitFor({ state: "hidden" });
    const accounts = await api(admin, "/api/admin/users");
    const cashierAccount = accounts.find(account => account.username === "cashier-browser");
    assert.equal(cashierAccount.role, "cashier");
    assert.equal(cashierAccount.entityId, null);

    const cashContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await cashContext.addInitScript(() => {
      Object.defineProperty(navigator, "canShare", { configurable: true, value: options => Array.isArray(options.files) && options.files.length === 1 });
      Object.defineProperty(navigator, "share", { configurable: true, value: async options => {
        const file = options.files[0];
        window.__sharedReceipt = { name: file.name, type: file.type, prefix: await file.slice(0, 5).text(), text: options.text };
      }});
      window.open = url => { window.__whatsappUrl = String(url); return null; };
    });
    const cash = await cashContext.newPage(); track(cash);
    await login(cash, "cashier-browser", "Initial-cashier-browser-123!");
    await cash.locator("#modal").waitFor({ state: "visible" });
    assert.equal(await cash.locator("#close").isVisible(), false);
    assert.equal((await cash.request.get(base + "/api/cashier?period=" + period)).status(), 403);
    await cash.locator("#f-currentPassword").fill("Initial-cashier-browser-123!");
    await cash.locator("#f-password").fill("Personal-cashier-browser-123!");
    await cash.locator("#f-confirmation").fill("Personal-cashier-browser-123!");
    await cash.locator("#form button[type=submit]").click();
    await cash.locator("#modal").waitFor({ state: "hidden" });
    await cash.locator(".cashier-student-card").first().waitFor();
    assert.deepEqual(await cash.locator("nav [data-page]").evaluateAll(links => links.map(link => link.dataset.page)), ["cashier"]);
    for (const route of ["/api/admin/users", "/api/admin/export", "/api/admin/settings", "/api/payments/config", "/api/payments/" + online.id + "/receipt.pdf"])
      assert.equal((await cash.request.get(base + route)).status(), 403, route);
    assert.ok(Object.values(await api(cash, "/api/data")).every(records => records.length === 0));

    await cash.locator("#cashier-search").fill("Parent caisse");
    assert.equal(await cash.locator(".cashier-student-card").count(), 1);
    await cash.locator("#cashier-class").selectOption("6e");
    await cash.locator("#cashier-centre").selectOption(centre);
    await cash.locator("#cashier-status").selectOption("À payer");
    const studentCard = cash.locator(".cashier-student-card").filter({ hasText: pupil.name });
    await studentCard.locator("[data-cashier-collect]").click();
    await cash.locator("#cashier-amount").fill("1000");
    await cash.locator("#cashier-amount-form button[type=submit]").click();
    await cash.locator("#cashier-collect-confirm").click();
    await cash.locator("#cashier-success-pdf").waitFor();
    await downloadPdf(cash, () => cash.locator("#cashier-success-pdf").click());
    await cash.locator("#cashier-success-share").click();
    await cash.waitForFunction(() => Boolean(window.__sharedReceipt));
    const shared = await cash.evaluate(() => window.__sharedReceipt);
    assert.equal(shared.prefix, "%PDF-"); assert.equal(shared.type, "application/pdf"); assert.match(shared.name, /^recu-.*\.pdf$/);
    assert.ok(shared.text.includes(pupil.name));
    await cash.locator("#cashier-collect-done").click();
    await cash.locator("#cashier-reset").click();
    await studentCard.filter({ hasText: "Partiellement payé" }).waitFor();
    assert.match(await studentCard.locator(".cashier-balance").textContent(), /2.?500/);
    const firstLedger = await api(cash, "/api/cashier?period=" + period);
    const firstReceipt = firstLedger.payments.find(payment => payment.student === pupil.id);
    assert.equal(firstReceipt.amount, 1000);
    assert.equal(firstReceipt.collectedByName, "cashier-browser");
    assert.match(await cash.locator(".cashier-receipt-row").textContent(), /Enregistré par cashier-browser/);
    assert.deepEqual(firstLedger.totals, { cash: 1000, online: 1000 });
    assert.equal(firstLedger.students.find(student => student.id === onlinePupil.id).balance, 2500);

    await cash.locator('[data-cashier-whatsapp="' + firstReceipt.id + '"]').click();
    await cash.locator("#whatsapp-receipt-dialog").waitFor({ state: "visible" });
    const phone = cash.locator('#whatsapp-receipt-dialog [name=phone]');
    const message = cash.locator('#whatsapp-receipt-dialog [name=message]');
    assert.ok((await message.inputValue()).includes(firstReceipt.id));
    await phone.fill("0100000000");
    await cash.locator("#whatsapp-receipt-dialog button[type=submit]").click();
    await cash.locator("[data-receipt-error]").filter({ hasText: "indicatif" }).waitFor();
    assert.equal(await cash.evaluate(() => window.__whatsappUrl), undefined);
    await phone.fill("+2290100000000");
    await message.fill("Bonjour parent. Référence : " + firstReceipt.id + ". Reçu PDF à joindre.");
    await downloadPdf(cash, () => cash.locator("#whatsapp-receipt-dialog button[type=submit]").click());
    const whatsappUrl = new URL(await cash.evaluate(() => window.__whatsappUrl));
    assert.equal(whatsappUrl.hostname, "wa.me"); assert.equal(whatsappUrl.pathname, "/2290100000000");
    assert.equal(whatsappUrl.searchParams.get("text"), "Bonjour parent. Référence : " + firstReceipt.id + ". Reçu PDF à joindre.");

    await studentCard.locator("[data-cashier-collect]").click();
    assert.equal(await cash.locator("#cashier-amount").inputValue(), "2500");
    await cash.locator("#cashier-amount-form button[type=submit]").click();
    await cash.locator("#cashier-collect-confirm").click();
    await cash.locator("#cashier-collect-done").click();
    await studentCard.locator(".cashier-status").filter({ hasText: "Payé" }).waitFor();
    assert.equal(await studentCard.locator("[data-cashier-collect]").isDisabled(), true);
    assert.equal((await api(cash, "/api/cashier?period=" + period)).payments.filter(payment => payment.student === pupil.id).length, 2);

    await admin.reload();
    await admin.locator("[data-page=payments]").click();
    await admin.locator("[data-payment-channel=cash]").click();
    assert.equal(await admin.locator("#payment-channel").inputValue(), "cash");
    assert.equal(await admin.locator("#table tbody tr").count(), 2);
    assert.match(await admin.locator("#table").textContent(), /Caisse en présentiel/);
    await admin.locator("#payment-channel").selectOption("online");
    assert.equal(await admin.locator("#table tbody tr").count(), 1);
    assert.match(await admin.locator("#table").textContent(), /KKiaPay/);
    await admin.locator("#payment-channel").selectOption("test");
    assert.equal(await admin.locator("#table tbody tr").count(), 1);
    await admin.locator("[data-page=balances]").click();
    await admin.locator("#finance-period").fill(period);
    await admin.getByRole("row").filter({ hasText: pupil.name }).filter({ hasText: "Réglé" }).waitFor();
    await admin.locator("[data-page=cashier]").click();
    await admin.locator(".cashier-student-card").first().waitFor();
    assert.equal(await admin.locator(".cashier-receipt-row").count(), 2);

    // An unfinished live online order blocks the cashier until the responsible
    // explicitly confirms that the family has not already paid online.
    const pendingPeriod = period.slice(0, 4) + (period.endsWith("-11") ? "-12" : "-11");
    const pendingId = crypto.randomUUID();
    instance.db.prepare("INSERT INTO payment_orders(id,student_id,period,amount,mode,state,created_at) VALUES(?,?,?,?,'live','pending',?)").run(pendingId, pupil.id, pendingPeriod, 3500, new Date().toISOString());
    await cash.locator("#cashier-period").fill(pendingPeriod);
    await studentCard.locator(".cashier-blocked").waitFor();
    assert.equal(await studentCard.locator("[data-cashier-collect]").isDisabled(), true);
    const denied = await cash.evaluate(async id => {
      try { await schoolAPI.request("/api/admin/payment-orders/" + id + "/authorize-cash", "POST", { confirmedUnpaid: true }); return 200; }
      catch (error) { return error.status; }
    }, pendingId);
    assert.equal(denied, 403);
    await admin.reload();
    await admin.locator("[data-page=payments]").click();
    await admin.locator('[data-authorize-cash="' + pendingId + '"]').click();
    await admin.locator("#f-confirmedUnpaid").waitFor();
    assert.equal(await admin.locator("#f-confirmedUnpaid").isChecked(), false);
    await admin.locator("#form button[type=submit]").click();
    assert.equal(instance.db.prepare("SELECT state FROM payment_orders WHERE id=?").get(pendingId).state, "pending");
    assert.equal(await admin.locator("#modal").isVisible(), true);
    await admin.locator("#f-confirmedUnpaid").check();
    await admin.locator("#form button[type=submit]").click();
    await admin.locator("#modal").waitFor({ state: "hidden" });
    const recoveredOrder = (await api(admin, "/api/payments/orders")).find(order => order.id === pendingId);
    assert.equal(recoveredOrder.status, "cash_authorized");
    const authorization = JSON.parse(instance.db.prepare("SELECT value FROM settings WHERE key=?").get("cash_authorization:" + pendingId).value);
    assert.equal(authorization.authorizedByName, "admin");
    await cash.locator("#cashier-reload").click();
    await studentCard.locator("[data-cashier-collect]").waitFor();
    assert.equal(await studentCard.locator("[data-cashier-collect]").isEnabled(), true);
    assert.equal(await studentCard.locator(".cashier-blocked").count(), 0);
    assert.equal((await api(cash, "/api/cashier?period=" + pendingPeriod)).payments.length, 0);
    await cash.locator("#cashier-period").fill(period);
    await cash.locator(".cashier-receipt-row").first().waitFor();

    // Teacher and pupil accounts must remain excluded even when they request
    // the API directly instead of using the navigation.
    const teacher = await api(admin, "/api/records/teachers", "POST", { name: "Enseignant exclu caisse", subject: "Mathématiques" });
    for (const [role, entityId] of [["teacher", teacher.id], ["student", pupil.id]]) {
      await api(admin, "/api/admin/users", "POST", { username: role + "-cashier-browser", role, entityId, password: "Initial-other-cashier-123!" });
      const context = await browser.newContext();
      const response = await context.request.post(base + "/api/auth/login", { data: { username: role + "-cashier-browser", password: "Initial-other-cashier-123!" } });
      assert.equal(response.status(), 200);
      const session = await response.json();
      const changed = await context.request.post(base + "/api/auth/password", { headers: { "X-CSRF-Token": session.csrf }, data: { currentPassword: "Initial-other-cashier-123!", password: "Personal-other-cashier-123!" } });
      assert.equal(changed.status(), 200);
      assert.equal((await context.request.get(base + "/api/cashier?period=" + period)).status(), 403);
      await context.close();
    }
    await cash.setViewportSize({ width: 390, height: 844 });
    await noOverflow(cash, "cashier mobile cards and history");
    await cash.locator('[data-cashier-whatsapp="' + firstReceipt.id + '"]').click();
    await cash.locator("#whatsapp-receipt-dialog").waitFor({ state: "visible" });
    await noOverflow(cash, "WhatsApp mobile dialog");
    await cash.locator("[data-receipt-close]").click();
    await cash.locator("#cashier-period").fill(period.slice(0, 4) + "-12");
    await cash.locator(".cashier-student-card").first().waitFor();
    await cash.locator('[data-cashier-collect="' + pupil.id + '"]').click();
    await noOverflow(cash, "cash collection mobile dialog");
    await cash.screenshot({ path: "/tmp/crs-cashier-mobile.png", fullPage: true });
    await cash.reload();
    await cash.locator(".cashier-student-card").first().waitFor();
    assert.equal(await cash.locator(".cashier-receipt-row").count(), 2);
    assert.deepEqual(errors, []);
    console.log("PASS compte caissier sans dossier lié, mot de passe personnel, caisse protégée, paiements partiels et complets, séparation en ligne/présentiel, PDF et partage simulé, mensualités, autorisation du responsable après paiement en ligne inachevé, persistance et mobile.");
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    instance.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
