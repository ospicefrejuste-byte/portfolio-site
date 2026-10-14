"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const { createApplication } = require("../lib/application");

const password = "Cleanup-browser-fixture-password-123!";

function receiptUrl(pdf) {
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  const links = [...pdf.toString("latin1").matchAll(/\/URI\s*\(([^)]*)\)/g)]
    .map(match => match[1].replace(/\\([\\()])/g, "$1"));
  const url = links.find(value => value.includes("/verification-recu.html#"));
  assert.ok(url, "The issued fixture receipt contains its signed verification link");
  return url;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crs-cleanup-browser-"));
  const instance = await createApplication({ dataDir: dir, setupToken: "cleanup-browser-setup" });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const fixtureDate = new Date().toISOString().slice(0, 10);
  const fixturePeriod = fixtureDate.slice(0, 7);
  let browser;
  const errors = [];
  const external = [];
  try {
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/usr/bin/chromium", args: ["--no-sandbox"] });
    const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "fr-FR" });
    const setup = await adminContext.request.post(base + "/api/auth/setup", { data: {
      token: "cleanup-browser-setup", username: "cleanup-browser-responsable", password,
    }});
    assert.equal(setup.status(), 200);
    const session = await setup.json();
    const headers = { "X-CSRF-Token": session.csrf };
    async function api(route, method = "GET", data) {
      const response = await adminContext.request.fetch(base + route, { method, headers, ...(data !== undefined ? { data } : {}) });
      assert.ok(response.ok(), method + " " + route + ": " + response.status() + " " + await response.text());
      return response.json();
    }
    const school = await api("/api/catalogue");
    const centre = school.centres[0];
    async function pupil(name) {
      return api("/api/records/students", "POST", {
        name, class: "6e", centre, group: "6e · " + centre, monthlyFee: 3500,
        registrationStatus: "Inscrit", subjects: ["Mathématiques"],
      });
    }
    const target = await pupil("Élève essai privé à supprimer");
    const witness = await pupil("Élève témoin à conserver");
    const livePupil = await pupil("Élève avec paiement réel conservé");
    const teacher = await api("/api/records/teachers", "POST", { name: "Professeur partagé", subject: "Mathématiques" });
    const course = await api("/api/records/courses", "POST", {
      subject: "Mathématiques", group: target.group, teacher: teacher.id,
      date: "2026-10-13", time: "16:00", duration: 60, room: "Salle essai navigateur",
    });
    await api("/api/records/grades", "POST", { student: target.id, course: course.id, label: "Note d’essai", score: 12 });
    await api("/api/records/attendance", "POST", { student: target.id, course: course.id, status: "Présent" });
    await api("/api/cashier/attendance", "POST", { date: "2026-10-13", class: "6e", centre,
      entries: [{ student: target.id, status: "Présent", revision: 0 }],
    });
    await api("/api/admin/users", "POST", { username: "cleanup-browser-student", role: "student", entityId: target.id, password });
    const cash = await api("/api/cashier/payments", "POST", {
      requestId: crypto.randomUUID(), student: target.id, amount: 1000, period: fixturePeriod,
    });
    const witnessCash = await api("/api/cashier/payments", "POST", {
      requestId: crypto.randomUUID(), student: witness.id, amount: 250, period: fixturePeriod,
    });
    // Provider-like records exist only in this isolated database; no gateway is called.
    const sandbox = { id: crypto.randomUUID(), student: target.id, amount: 3500, period: fixturePeriod,
      date: fixtureDate, source: "KKiaPay", mode: "sandbox", transactionId: "cleanup-browser-sandbox" };
    const live = { ...sandbox, id: crypto.randomUUID(), student: livePupil.id, amount: 800,
      mode: "live", transactionId: "cleanup-browser-live-fixture" };
    for (const payment of [sandbox, live]) {
      await instance.db.prepare("INSERT INTO records(kind,id,payload) VALUES('payments',?,?)")
        .run(payment.id, JSON.stringify(payment));
    }
    const pdf = await adminContext.request.get(base + "/api/payments/" + cash.id + "/receipt.pdf");
    assert.equal(pdf.status(), 200);
    const signedUrl = receiptUrl(await pdf.body());
    assert.equal(new URL(signedUrl).origin, base);

    function track(page) {
      page.on("pageerror", error => errors.push(error.message));
      page.on("request", request => {
        if (new URL(request.url()).origin !== base) external.push(request.url());
      });
    }
    async function noOverflow(page, label) {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, label);
    }
    const admin = await adminContext.newPage();
    track(admin);
    const publicContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "fr-FR" });
    const receiptPage = await publicContext.newPage();
    track(receiptPage);
    await receiptPage.goto(signedUrl);
    await receiptPage.locator('#receipt-verification[data-state="verified"]').waitFor();
    assert.equal(await receiptPage.locator("#receipt-student").textContent(), target.name);
    assert.deepEqual(await publicContext.cookies(), [], "Public verification needs no authenticated session");

    await admin.goto(base + "/gestion.html?section=dashboard");
    await admin.locator("[data-page=students]").waitFor();
    const dashboardPayments = () => admin.locator(".stat").filter({ hasText: "Encaissements réels" }).locator("strong");
    assert.equal((await dashboardPayments().textContent()).replace(/\s/g, ""), "2050FCFA");
    await admin.locator("[data-page=students]").click();
    const modal = admin.locator("#student-cleanup-modal");
    const submit = admin.locator("#cleanup-submit");
    const previewPath = "/api/admin/students/" + target.id + "/deletion-preview";
    const purgePath = "/api/admin/students/" + target.id + "/purge-test";
    let previewRequests = 0;
    let purgeRequests = 0;
    admin.on("request", request => {
      if (new URL(request.url()).pathname === previewPath) previewRequests++;
      if (new URL(request.url()).pathname === purgePath && request.method() === "POST") purgeRequests++;
    });
    async function open(id = target.id) {
      await admin.locator('[data-delete="' + id + '"]').click();
      await modal.waitFor({ state: "visible" });
      await admin.waitForFunction(() => document.getElementById("student-cleanup-modal").getAttribute("aria-busy") === "false");
    }
    async function fillConfirmation(currentPassword = password) {
      await admin.locator("#cleanup-fictitious").check();
      await admin.locator("#cleanup-confirmation").fill(target.name);
      await admin.locator("#cleanup-password").fill(currentPassword);
      assert.equal(await submit.isDisabled(), false);
    }
    async function clearedAfterError() {
      await admin.locator("#cleanup-reload").waitFor({ state: "visible" });
      assert.equal(await admin.locator("#cleanup-password").inputValue(), "");
      assert.equal(await admin.locator("#cleanup-confirmation").inputValue(), "");
      assert.equal(await admin.locator("#cleanup-fictitious").isChecked(), false);
      assert.equal(await submit.isDisabled(), true);
      assert.equal(await admin.locator("#cleanup-confirmation-fields").isVisible(), false);
      assert.match(await admin.locator("#cleanup-error").textContent(), /Rechargez l’aperçu/);
    }
    async function reloadPreview() {
      const response = admin.waitForResponse(response => new URL(response.url()).pathname === previewPath);
      await admin.locator("#cleanup-reload").click();
      assert.equal((await response).status(), 200);
      await admin.locator("#cleanup-confirmation-fields").waitFor({ state: "visible" });
    }
    const beforeCancel = await api("/api/data");
    await open();
    assert.match(await admin.locator("#cleanup-counts").textContent(), /Paiements2/);
    assert.match((await admin.locator("#cleanup-amounts").textContent()).replace(/\s/g, ""), /1000FCFA/);
    await noOverflow(admin, "Cleanup preview fits desktop");
    await admin.setViewportSize({ width: 390, height: 844 });
    await noOverflow(admin, "Cleanup preview fits a phone");
    await admin.locator("#cleanup-close").click();
    await modal.waitFor({ state: "hidden" });
    assert.deepEqual(await api("/api/data"), beforeCancel, "Cancelling never mutates a pupil or related record");
    assert.equal(purgeRequests, 0);

    let failPreview = true;
    await admin.route("**" + previewPath, route => {
      if (failPreview) { failPreview = false; return route.abort("internetdisconnected"); }
      return route.continue();
    });
    await open();
    await admin.locator("#cleanup-reload").waitFor({ state: "visible" });
    assert.equal(await admin.locator("#cleanup-preview").isVisible(), false);
    assert.ok(await admin.locator("#cleanup-error").textContent());
    assert.equal(previewRequests, 2, "A failed preview is not automatically retried");
    await reloadPreview();
    await admin.unroute("**" + previewPath);

    assert.equal(await submit.isDisabled(), true);
    await admin.locator("#cleanup-confirmation").fill(target.name);
    await admin.locator("#cleanup-password").fill(password);
    assert.equal(await submit.isDisabled(), true, "The fictitious declaration is mandatory");
    await admin.locator("#cleanup-fictitious").check();
    await admin.locator("#cleanup-confirmation").fill(target.name + " ");
    assert.equal(await submit.isDisabled(), true, "The name must match exactly");
    await admin.locator("#cleanup-confirmation").fill(target.name);
    await admin.locator("#cleanup-password").fill("");
    assert.equal(await submit.isDisabled(), true, "The responsible person's own password is mandatory");
    assert.equal(purgeRequests, 0, "Incomplete confirmations never submit a purge");
    await fillConfirmation("Incorrect-fixture-password-123!");
    let response = admin.waitForResponse(response => new URL(response.url()).pathname === purgePath);
    await submit.click();
    assert.equal((await response).status(), 403);
    await clearedAfterError();
    assert.deepEqual(await api("/api/data"), beforeCancel, "Wrong password leaves business data intact");
    assert.equal(previewRequests, 3, "A rejected password does not silently reload or retry");
    await reloadPreview();

    let failPost = true;
    await admin.route("**" + purgePath, route => {
      if (failPost) { failPost = false; return route.abort("internetdisconnected"); }
      return route.continue();
    });
    await fillConfirmation();
    await submit.click();
    await clearedAfterError();
    assert.deepEqual(await api("/api/data"), beforeCancel, "An aborted request never mutates this fixture");
    assert.equal(previewRequests, 4, "An unconfirmed network response requires an explicit new preview");
    await admin.unroute("**" + purgePath);
    await reloadPreview();

    const latePayment = await api("/api/records/payments", "POST", {
      student: target.id, amount: 200, period: fixturePeriod, date: fixtureDate,
    });
    const beforeStale = await api("/api/data");
    await fillConfirmation();
    response = admin.waitForResponse(response => new URL(response.url()).pathname === purgePath);
    await submit.click();
    assert.equal((await response).status(), 409);
    await clearedAfterError();
    assert.deepEqual(await api("/api/data"), beforeStale, "A changed fingerprint cannot authorize deletion");
    assert.equal(previewRequests, 5);
    await reloadPreview();
    assert.match((await admin.locator("#cleanup-amounts").textContent()).replace(/\s/g, ""), /1200FCFA/);
    await admin.locator("#cleanup-close").click();
    await modal.waitFor({ state: "hidden" });

    await open(livePupil.id);
    await admin.locator("#cleanup-blocked").waitFor({ state: "visible" });
    assert.match(await admin.locator("#cleanup-reason").textContent(), /mode réel/);
    assert.equal(await submit.isVisible(), false);
    await admin.locator("#cleanup-edit").click();
    await admin.locator("#modal").waitFor({ state: "visible" });
    assert.equal(await admin.locator("#f-name").inputValue(), livePupil.name);
    assert.equal(await admin.locator('#f-registrationStatus option[value="Suspendu"]').count(), 1);
    await admin.locator("#close").click();
    await admin.locator("#modal").waitFor({ state: "hidden" });

    await admin.setViewportSize({ width: 1440, height: 1000 });
    await open();
    await fillConfirmation();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await admin.route("**" + purgePath, async route => { await gate; await route.continue(); });
    response = admin.waitForResponse(response => new URL(response.url()).pathname === purgePath);
    await submit.click();
    try {
      assert.equal(await admin.locator("#cleanup-password").inputValue(), "", "The submitted password is cleared immediately");
      assert.equal(await admin.locator("#cleanup-close").isDisabled(), true);
      assert.equal(await admin.locator("#cleanup-confirmation").isDisabled(), true);
      await admin.keyboard.press("Escape");
      assert.equal(await modal.evaluate(element => element.open), true, "An active purge cannot be dismissed");
    } finally { release(); }
    assert.equal((await response).status(), 200);
    await modal.waitFor({ state: "hidden" });
    await admin.unroute("**" + purgePath);
    assert.equal(await admin.locator('[data-delete="' + target.id + '"]').count(), 0, "Success refreshes the list without a page reload");
    assert.equal(await admin.locator("#cleanup-password").inputValue(), "");
    assert.match(await admin.locator("#toast").textContent(), /supprimé définitivement/);
    const remaining = await api("/api/data");
    assert.equal(remaining.students.some(pupil => pupil.id === target.id), false);
    assert.deepEqual(remaining.students.find(pupil => pupil.id === witness.id), witness);
    assert.deepEqual(remaining.courses.find(item => item.id === course.id), beforeCancel.courses.find(item => item.id === course.id));
    assert.deepEqual(remaining.payments.find(payment => payment.id === witnessCash.id), witnessCash);
    assert.deepEqual(remaining.payments.find(payment => payment.id === live.id), live);
    for (const id of [cash.id, sandbox.id, latePayment.id]) assert.equal(remaining.payments.some(payment => payment.id === id), false);
    await admin.locator("[data-page=dashboard]").click();
    assert.equal((await dashboardPayments().textContent()).replace(/\s/g, ""), "1050FCFA", "Dashboard excludes all removed cash and all sandbox amounts");
    assert.equal(await admin.locator(".stat").filter({ hasText: "Dossiers élèves" }).locator("strong").textContent(), "2");
    await noOverflow(admin, "The refreshed dashboard fits desktop");

    for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
      await receiptPage.setViewportSize(viewport);
      await receiptPage.goto(signedUrl);
      await receiptPage.locator('#receipt-verification[data-state="cancelled"]').waitFor();
      const visible = await receiptPage.locator("body").innerText();
      assert.match(visible, /annulé|retiré/i);
      assert.match(visible, /ne justifie aucun encaissement/);
      assert.ok(visible.includes(cash.id), "The cancelled receipt retains its reference");
      assert.ok(!visible.includes(target.name), "Cancelled public receipts disclose no pupil identity");
      assert.equal(await receiptPage.locator("#receipt-student").textContent(), "", "Hash navigation clears the previously displayed pupil");
      assert.equal(await receiptPage.locator("#verified-receipt").isVisible(), false);
      assert.equal(await receiptPage.locator("#verification-retry").isVisible(), false);
      assert.equal(new URL(receiptPage.url()).hash, "");
      await noOverflow(receiptPage, "The cancelled receipt fits width " + viewport.width);
    }
    assert.deepEqual(await publicContext.cookies(), []);
    assert.deepEqual(errors, [], "Cleanup and cancelled receipt pages have no JavaScript errors");
    assert.deepEqual(external, [], "The isolated cleanup never contacts a live provider or external service");
    console.log("PASS nettoyage navigateur : annulation sans mutation, confirmations obligatoires, mot de passe refusé sans fuite, rechargement explicite après panne et conflit, paiement réel protégé, suppression et tableau de bord actualisés, autres dossiers conservés, reçu annulé sans identité, mobile et bureau sans débordement ni erreur.");
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    await instance.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
