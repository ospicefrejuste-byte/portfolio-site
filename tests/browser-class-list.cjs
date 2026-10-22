"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");
const applicationModule = require(process.env.CLOUD_APP_MODULE || "../lib/application");

// Every account and pupil below lives in a disposable, isolated database.
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crs-class-list-browser-"));
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "crs-class-list-artifacts-"));
  const instance = await applicationModule.createApplication({ dataDir: dir, setupToken: "class-list-browser-setup" });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const password = "Class-list-browser-fixture-123!";
  const errors = [], external = [];
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/usr/bin/chromium", args: ["--no-sandbox"] });
    async function context(viewport) {
      const result = await browser.newContext({ viewport, locale: "fr-FR" });
      await result.route(url => url.origin !== base, route => {
        external.push(route.request().url());
        return route.abort("blockedbyclient");
      });
      result.on("page", page => page.on("pageerror", error => errors.push(error.message)));
      return result;
    }
    const adminContext = await context({ width: 1440, height: 1000 });
    const setup = await adminContext.request.post(base + "/api/auth/setup", { data: {
      token: "class-list-browser-setup", username: "class-list-responsable", password,
    }});
    assert.equal(setup.status(), 200);
    const session = await setup.json();
    async function api(route, method = "GET", data) {
      const response = await adminContext.request.fetch(base + route, {
        method, headers: { "X-CSRF-Token": session.csrf }, ...(data === undefined ? {} : { data }),
      });
      assert.ok(response.ok(), method + " " + route + ": " + response.status() + " " + await response.text());
      return response.json();
    }
    const school = await api("/api/catalogue");
    const [centre, otherCentre] = school.centres;
    assert.ok(centre && otherCentre, "The fixture catalogue offers two schools");
    async function pupil(name, status = "Inscrit", selectedCentre = centre, level = "6e") {
      return api("/api/records/students", "POST", {
        name, registrationStatus: status, class: level, centre: selectedCentre, group: level + " · " + selectedCentre,
        guardian: "CONTACT FAMILIAL CONFIDENTIEL", phone: "+2290199887766", monthlyFee: 4321,
        subjects: ["Mathématiques"],
      });
    }
    const registered = await pupil("Grâce Élève inscrite");
    const pending = await pupil("Élodie Élève préinscrite", "Préinscription");
    const suspended = await pupil("Noël Élève suspendu", "Suspendu");
    const elsewhere = await pupil("AUTRE ÉCOLE À EXCLURE", "Inscrit", otherCentre);
    const otherClass = await pupil("AUTRE CLASSE À EXCLURE", "Inscrit", centre, "5e");
    await api("/api/admin/users", "POST", { username: "class-list-cashier", role: "cashier", password });
    const expectedNames = [registered, pending, suspended].map(student => student.name);
    function inspectPdf(buffer, label) {
      assert.equal(buffer.subarray(0, 5).toString(), "%PDF-");
      assert.equal((buffer.toString("latin1").match(/\/Type \/Page\b/g) || []).length, 1, "A three-pupil list fits one page including its footer");
      const filename = path.join(artifacts, label + ".pdf");
      fs.writeFileSync(filename, buffer);
      const text = execFileSync("pdftotext", ["-layout", filename, "-"], { encoding: "utf8", timeout: 30000 });
      assert.match(text, /Liste de classe/);
      assert.match(text, /Nom et prénoms/);
      assert.match(text, /Signature/);
      assert.match(text, /Page 1 \/ 1/);
      for (const value of [school.name, centre, ...expectedNames]) assert.ok(text.includes(value), label + ": " + value);
      assert.doesNotMatch(text, /AUTRE ÉCOLE À EXCLURE|AUTRE CLASSE À EXCLURE|CONTACT FAMILIAL CONFIDENTIEL|0199887766|4[\s\u202f]*321|FCFA|class-list-cashier/);
      return text;
    }
    async function download(page, button, label) {
      const pendingDownload = page.waitForEvent("download");
      await button.click();
      const result = await pendingDownload;
      assert.match(result.suggestedFilename(), /\.pdf$/);
      return inspectPdf(fs.readFileSync(await result.path()), label);
    }
    async function noOverflow(page, label) {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, label);
    }
    const admin = await adminContext.newPage();
    await admin.goto(base + "/gestion.html?section=students");
    const adminButton = admin.locator("#enrollment-class-list-pdf");
    await adminButton.waitFor();
    assert.equal(await adminButton.isDisabled(), true, "A class and school are both required");
    await admin.locator("#enrollment-class").selectOption("6e");
    assert.equal(await adminButton.isDisabled(), true);
    await admin.locator("#enrollment-centre").selectOption(centre);
    assert.equal(await adminButton.isEnabled(), true);
    // Search and status narrow the on-screen dossiers, while the PDF remains the whole class.
    await admin.locator("#enrollment-status").selectOption("Inscrit");
    await admin.locator("#enrollment-search").fill(registered.name);
    await admin.waitForFunction(() => document.querySelectorAll(".enrollment-table tbody tr").length === 1);
    const adminText = await download(admin, adminButton, "responsable-class-list");
    execFileSync("pdftoppm", ["-f", "1", "-singlefile", "-png", "-r", "100", path.join(artifacts, "responsable-class-list.pdf"), path.join(artifacts, "responsable-class-list")], { timeout: 30000 });
    await admin.setViewportSize({ width: 390, height: 844 });
    await noOverflow(admin, "Class PDF controls fit the responsible's phone");
    await admin.screenshot({ path: path.join(artifacts, "responsable-mobile.png"), fullPage: true });

    const cashContext = await context({ width: 390, height: 844 });
    const login = await cashContext.request.post(base + "/api/auth/login", { data: { username: "class-list-cashier", password, space: "cashier" } });
    assert.equal(login.status(), 200);
    const cashSession = await login.json();
    const change = await cashContext.request.post(base + "/api/auth/password", {
      headers: { "X-CSRF-Token": cashSession.csrf },
      data: { currentPassword: password, password: "Personal-class-list-cashier-123!" },
    });
    assert.equal(change.status(), 200);
    const cash = await cashContext.newPage();
    await cash.goto(base + "/gestion.html?section=dailyAttendance");
    const cashButton = cash.locator("#daily-attendance-class-list-pdf");
    await cashButton.waitFor();
    assert.equal(await cashButton.isDisabled(), true);
    await cash.locator("#daily-attendance-centre").selectOption(centre);
    assert.equal(await cashButton.isDisabled(), true);
    await cash.locator("#daily-attendance-class").selectOption("6e");
    const present = cash.locator('[data-daily-status="' + registered.id + '"][value="Présent"]');
    await present.waitFor();
    await present.check();
    assert.equal(await cash.locator("#daily-attendance-form").getAttribute("data-crs-unsaved"), "true");
    assert.equal(await cash.locator("#daily-attendance-save").isEnabled(), true);
    const savedBefore = await api("/api/data");
    assert.equal(savedBefore.dailyAttendance.length, 0);

    let releaseDownload, markStarted;
    const hold = new Promise(resolve => { releaseDownload = resolve; });
    const started = new Promise(resolve => { markStarted = resolve; });
    let classRequests = 0;
    await cash.route("**/api/reports/class.pdf?*", async route => {
      classRequests++;
      markStarted();
      await hold;
      await route.continue();
    });
    const cashDownload = cash.waitForEvent("download");
    await cashButton.click();
    await started;
    await cash.waitForFunction(() => document.querySelector("#daily-attendance-class-list-pdf").disabled);
    await cashButton.evaluate(button => { button.click(); button.click(); });
    assert.equal(classRequests, 1, "A pending PDF download cannot create duplicate requests");
    assert.equal(await present.isChecked(), true, "Preparing the PDF preserves the pending attendance mark");
    releaseDownload();
    const downloaded = await cashDownload;
    assert.match(downloaded.suggestedFilename(), /\.pdf$/);
    const cashText = inspectPdf(fs.readFileSync(await downloaded.path()), "cashier-class-list");
    assert.equal(cashText, adminText, "Both authorized spaces download the same complete class list");
    await cash.unroute("**/api/reports/class.pdf?*");
    await cash.waitForFunction(() => !document.querySelector("#daily-attendance-class-list-pdf").disabled);
    assert.equal(await present.isChecked(), true);
    assert.equal(await cash.locator("#daily-attendance-form").getAttribute("data-crs-unsaved"), "true");

    await cash.route("**/api/reports/class.pdf?*", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Liste temporairement indisponible : réessayez." }) }));
    await cashButton.click();
    await cash.getByText("Liste temporairement indisponible : réessayez.", { exact: true }).waitFor();
    assert.equal(await cashButton.isEnabled(), true, "A failed download can be retried");
    assert.equal(await present.isChecked(), true, "A failed PDF request preserves the pending mark");
    assert.equal(await cash.locator("#daily-attendance-save").isEnabled(), true);
    assert.equal(await cash.locator("#daily-attendance-form").getAttribute("data-crs-unsaved"), "true");
    const savedAfter = await api("/api/data");
    assert.equal(savedAfter.dailyAttendance.length, 0, "Downloading never saves or discards unfinished attendance");
    assert.equal(savedAfter.students.length, 5, "All student fixtures remain present after the exports");
    assert.ok(savedAfter.students.some(student => student.id === elsewhere.id));
    assert.ok(savedAfter.students.some(student => student.id === otherClass.id));
    await noOverflow(cash, "Class PDF controls and unsaved attendance fit the cashier's phone");
    await cash.screenshot({ path: path.join(artifacts, "cashier-drafts-mobile.png"), fullPage: true });
    assert.deepEqual(errors, []);
    assert.deepEqual(external, [], "The test never contacts an external service");
    console.log("PASS listes PDF responsable et caisse : école/classe exactes, accents, tous les statuts, aucun contact ni montant, filtres obligatoires, téléchargement unique, erreurs et présences non enregistrées conservées, affichage mobile. Artefacts : " + artifacts);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    await instance.db.close();
    if (applicationModule.cleanup) await applicationModule.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
