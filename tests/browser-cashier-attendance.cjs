"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const { createApplication } = require("../lib/application");

// Entirely isolated fixtures: no client data, gateway, or external messaging.
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crs-cashier-attendance-browser-"));
  const instance = createApplication({ dataDir: dir, setupToken: "cashier-attendance-browser-setup" });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const day = new Date().toISOString().slice(0, 10);
  const period = day.slice(0, 7);
  const otherDay = day.slice(0, 8) + (day.endsWith("-01") ? "02" : "01");
  const release = JSON.parse(fs.readFileSync(path.join(__dirname, "../public/version.json"), "utf8"));
  let version = release.version;
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/usr/bin/chromium", args: ["--no-sandbox"] });
  const errors = [];
  function track(page) { page.on("pageerror", error => errors.push(error.message)); }
  async function api(page, route, method = "GET", data) {
    return page.evaluate(({ route, method, data }) => schoolAPI.request(route, method, data), { route, method, data });
  }
  async function login(page, username, password, space) {
    await page.goto(base + "/connexion.html" + (space ? "?espace=" + space : ""));
    await page.locator("#username").fill(username);
    await page.locator("#password").fill(password);
    await page.getByRole("button", { name: "Se connecter" }).click();
    await page.waitForURL("**/gestion.html*");
  }
  function radio(page, pupil, status) {
    return page.locator('[data-daily-status="' + pupil.id + '"][value="' + status + '"]');
  }
  async function chooseRoster(page, centre, level = "6e", date = day) {
    await page.locator("#daily-attendance-date").fill(date);
    await page.locator("#daily-attendance-centre").selectOption(centre);
    await page.locator("#daily-attendance-class").selectOption(level);
    await page.locator("#daily-attendance-student").waitFor();
  }
  async function noOverflow(page, label) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, label);
  }
  function routeFor(centre, level = "6e", date = day) {
    return "/api/cashier/attendance?" + new URLSearchParams({ date, centre, class: level });
  }
  try {
    const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const admin = await adminContext.newPage(); track(admin);
    await admin.goto(base + "/installation.html");
    await admin.locator("#token").fill("cashier-attendance-browser-setup");
    await admin.locator("#username").fill("admin-daily-browser");
    await admin.locator("#password").fill("Admin-daily-browser-123!");
    await admin.locator("#confirm-password").fill("Admin-daily-browser-123!");
    await admin.getByRole("button", { name: "Créer mon compte administrateur" }).click();
    await admin.waitForURL("**/gestion.html*");
    await admin.locator("[data-page=users]").waitFor();
    const catalogue = await api(admin, "/api/catalogue");
    const [schoolA, schoolB] = catalogue.centres;
    assert.ok(schoolA && schoolB, "Two isolated school fixtures are available");
    async function pupil(name, centre = schoolA, level = "6e") {
      return api(admin, "/api/records/students", "POST", {
        name, centre, class: level, group: level + " · " + centre,
        registrationStatus: "Inscrit", guardian: "Parent essai présence", phone: "+2290100000000", subjects: ["Mathématiques"], monthlyFee: 3500,
      });
    }
    const present = await pupil("Alice présence navigateur");
    const absent = await pupil("Benoît présence navigateur");
    const untouched = await pupil("Chloé sans pointage navigateur");
    const otherSchool = await pupil("Denis autre école navigateur", schoolB);
    const otherClass = await pupil("Émilie autre classe navigateur", schoolA, "5e");

    // The responsible assigns the cashier's own credentials without a linked pupil.
    await admin.locator("[data-page=users]").click();
    await admin.locator("#add").click();
    await admin.locator("#f-username").fill("cashier-daily-browser");
    await admin.locator("#f-role").selectOption("cashier");
    assert.equal(await admin.locator("#f-entityId").isVisible(), false);
    await admin.locator("#f-password").fill("Initial-daily-browser-123!");
    await admin.locator("#form button[type=submit]").click();
    await admin.locator("#modal").waitFor({ state: "hidden" });
    const account = (await api(admin, "/api/admin/users")).find(user => user.username === "cashier-daily-browser");
    assert.equal(account.role, "cashier"); assert.equal(account.entityId, null);

    const cashContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await cashContext.route(url => url.origin === base && url.pathname === "/version.json", route => route.fulfill({
      contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify({ version }),
    }));
    const cash = await cashContext.newPage(); track(cash);
    await cash.goto(base);
    assert.equal(await cash.getByRole("link", { name: "Administration", exact: true }).getAttribute("href"), "/administration");
    assert.equal(await cash.getByRole("link", { name: "Caisse", exact: true }).getAttribute("href"), "/caisse");
    await noOverflow(cash, "Homepage with two distinct protected spaces on a phone");
    await cash.getByRole("link", { name: "Administration", exact: true }).click();
    await cash.waitForURL("**/connexion.html?espace=administration");
    await cash.locator("#username").fill("cashier-daily-browser");
    await cash.locator("#password").fill("Initial-daily-browser-123!");
    const wrongSpace = cash.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/login");
    await cash.getByRole("button", { name: "Se connecter" }).click();
    assert.equal((await wrongSpace).status(), 403, "A cashier cannot enter the Administration portal");
    await cash.locator("#auth-result").filter({ hasText: "responsable" }).waitFor();
    assert.equal((await cash.request.get(base + "/api/auth/me")).status(), 401);
    await cash.goto(base);
    await cash.getByRole("link", { name: "Caisse", exact: true }).click();
    await cash.waitForURL("**/connexion.html?espace=caisse");
    await cash.locator("#username").fill("cashier-daily-browser");
    await cash.locator("#password").fill("Incorrect-daily-browser-123!");
    await cash.getByRole("button", { name: "Se connecter" }).click();
    await cash.locator("#auth-result").filter({ hasText: "Identifiant ou mot de passe incorrect" }).waitFor();
    await cash.locator("#password").fill("Initial-daily-browser-123!");
    await cash.getByRole("button", { name: "Se connecter" }).click();
    await cash.waitForURL("**/gestion.html*");
    await cash.locator("#modal").waitFor({ state: "visible" });
    assert.equal((await cash.request.get(base + routeFor(schoolA))).status(), 403);
    await cash.locator("#f-currentPassword").fill("Initial-daily-browser-123!");
    await cash.locator("#f-password").fill("Personal-daily-browser-123!");
    await cash.locator("#f-confirmation").fill("Personal-daily-browser-123!");
    await cash.locator("#form button[type=submit]").click();
    await cash.locator("#modal").waitFor({ state: "hidden" });
    await cash.locator("#cashier-student").waitFor();
    assert.deepEqual(await cash.locator("nav [data-page]").evaluateAll(links => links.map(link => link.dataset.page)), ["cashier", "dailyAttendance"]);
    assert.equal(await cash.locator("[data-page=users]").count(), 0);
    for (const route of ["/api/admin/users", "/api/admin/settings", "/api/admin/export", "/api/admin/monthly-balances?period=" + period])
      assert.equal((await cash.request.get(base + route)).status(), 403, route);
    for (const kind of ["students", "grades", "attendance"])
      assert.equal((await cash.request.post(base + "/api/records/" + kind, { data: {} })).status(), 403, kind);
    assert.ok(Object.values(await api(cash, "/api/data")).every(rows => rows.length === 0));

    // Collect cash by school -> class -> pupil; no typed name is necessary.
    assert.equal(await cash.locator("#cashier-student").isDisabled(), true);
    await cash.locator("#cashier-centre").selectOption(schoolA);
    await cash.locator("#cashier-class").selectOption("6e");
    const cashChoices = await cash.locator("#cashier-student option").evaluateAll(options => options.map(option => option.value).filter(Boolean));
    assert.deepEqual(cashChoices.sort(), [present.id, absent.id, untouched.id].sort());
    assert.ok(!cashChoices.includes(otherSchool.id) && !cashChoices.includes(otherClass.id));
    await cash.locator("#cashier-student").selectOption(present.id);
    await cash.locator("#cashier-selected-collect").click();
    await noOverflow(cash, "Collection form on a phone");
    await cash.locator("#cashier-amount").fill("1000");
    await cash.locator("#cashier-amount-form button[type=submit]").click();
    await cash.locator("#cashier-collect-confirm").click();
    await cash.locator("#cashier-success-pdf").waitFor();
    const pendingPdf = cash.waitForEvent("download");
    await cash.locator("#cashier-success-pdf").click();
    const pdf = await pendingPdf;
    assert.match(pdf.suggestedFilename(), /\.pdf$/);
    assert.equal(fs.readFileSync(await pdf.path()).subarray(0, 5).toString(), "%PDF-");
    await cash.locator("#cashier-collect-done").click();
    const receipt = (await api(cash, "/api/cashier?period=" + period)).payments.find(payment => payment.student === present.id);
    assert.equal(receipt.amount, 1000); assert.equal(receipt.collectedByName, "cashier-daily-browser");

    await cash.locator("nav [data-page=dailyAttendance]").click();
    assert.equal(await cash.locator("#daily-attendance-class").isDisabled(), true);
    await chooseRoster(cash, schoolA);
    assert.deepEqual(await cash.locator("[data-daily-student]").evaluateAll(rows => rows.map(row => row.dataset.dailyStudent).sort()), [present.id, absent.id, untouched.id].sort());
    const initial = await api(cash, routeFor(schoolA));
    assert.deepEqual(initial.totals, { present: 0, absent: 0, unmarked: 3 });
    assert.ok(initial.students.every(student => student.status === null && student.revision === 0));
    assert.ok(initial.students.every(student => !Object.hasOwn(student, "guardian") && !Object.hasOwn(student, "phone")), "The attendance roster has no family contact or financial data");
    await noOverflow(cash, "Whole class and presence controls on a phone");
    await cash.locator("#daily-attendance-student").selectOption(present.id);
    assert.equal(await cash.locator("[data-daily-student]").count(), 1);
    await radio(cash, present, "Présent").check();
    await cash.locator("#daily-attendance-student").selectOption("");
    await radio(cash, absent, "Absent").check();
    assert.equal(await cash.locator("#daily-attendance-reload").isDisabled(), true);
    assert.equal(await cash.locator("#daily-attendance-form").getAttribute("data-crs-unsaved"), "true");
    await cash.locator("#daily-attendance-centre").selectOption(schoolB);
    assert.equal(await cash.locator("#daily-attendance-centre").inputValue(), schoolA, "Changing school cannot discard unsaved attendance");
    await cash.locator("#daily-attendance-date").fill(otherDay);
    assert.equal(await cash.locator("#daily-attendance-date").inputValue(), day);

    // A deployment notice must not reload away a cashier's pending class marks.
    await cash.waitForFunction(() => Boolean(window.crsUpdates));
    await cash.evaluate(() => window.crsUpdates.check());
    await cash.clock.install();
    let navigations = 0;
    cash.on("framenavigated", frame => { if (frame === cash.mainFrame()) navigations++; });
    version = release.version === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64);
    await cash.evaluate(() => window.crsUpdates.check());
    await cash.locator("#site-update-notice").waitFor({ state: "visible" });
    await cash.clock.fastForward(12000);
    assert.equal(navigations, 0, "Deployment updates preserve an unfinished attendance sheet");
    assert.equal(await radio(cash, present, "Présent").isChecked(), true);
    assert.equal(await radio(cash, absent, "Absent").isChecked(), true);
    await cash.locator("#site-update-dismiss").click();
    version = release.version;
    await cash.clock.resume();
    const savedResponse = cash.waitForResponse(response => new URL(response.url()).pathname === "/api/cashier/attendance" && response.request().method() === "POST");
    await cash.locator("#daily-attendance-save").click();
    assert.equal((await savedResponse).status(), 200);
    await cash.locator(".daily-attendance-feedback").filter({ hasText: "enregistrée" }).waitFor();
    await cash.waitForFunction(() => !window.hasDailyDrafts() && schoolAPI.pendingRequests === 0);
    const saved = await api(cash, routeFor(schoolA));
    assert.deepEqual(saved.totals, { present: 1, absent: 1, unmarked: 1 });
    assert.equal(saved.students.find(student => student.id === untouched.id).status, null, "An untouched pupil remains unmarked");
    assert.equal(saved.students.find(student => student.id === present.id).revision, 1);
    const shared = await api(admin, "/api/data");
    assert.equal(shared.payments.find(payment => payment.id === receipt.id).amount, 1000);
    const marks = shared.dailyAttendance.filter(mark => mark.date === day);
    assert.equal(marks.length, 2); assert.ok(marks.every(mark => mark.markedByName === "cashier-daily-browser"));
    await admin.reload();
    await admin.locator("nav [data-page=dailyAttendance]").click();
    await chooseRoster(admin, schoolA);
    assert.equal(await radio(admin, present, "Présent").isChecked(), true);
    assert.equal(await radio(admin, absent, "Absent").isChecked(), true);

    await cash.reload();
    await cash.locator("nav [data-page=dailyAttendance]").click();
    await cash.locator("#daily-attendance-date").waitFor();
    await chooseRoster(cash, schoolA);
    assert.equal(await radio(cash, present, "Présent").isChecked(), true);
    assert.equal(await radio(cash, absent, "Absent").isChecked(), true);
    await cash.locator("#daily-attendance-centre").selectOption(schoolB);
    assert.equal(await cash.locator("#daily-attendance-class").inputValue(), "");
    await cash.locator("#daily-attendance-class").selectOption("6e");
    await radio(cash, otherSchool, "").waitFor();
    assert.equal(await cash.locator("[data-daily-student]").count(), 1);
    assert.equal(await radio(cash, otherSchool, "").isChecked(), true);
    await chooseRoster(cash, schoolA, "6e", otherDay);
    assert.equal(await radio(cash, present, "").isChecked(), true, "A new date never inherits absences from another date");
    await cash.screenshot({ path: "/tmp/crs-cashier-attendance-mobile.png", fullPage: true });
    await noOverflow(cash, "Presence roster after school/day changes");

    // A forbidden deep section does not expose admin navigation or data.
    await cash.goto(base + "/gestion.html?section=users");
    await cash.locator("#cashier-student").waitFor();
    assert.equal(await cash.locator("#title").textContent(), "Caisse en présentiel");
    assert.equal(await cash.locator("nav [data-page=users]").count(), 0);
    const oldCookie = (await cashContext.cookies()).find(cookie => cookie.name === "crs_session");
    await cash.goto(base);
    await cash.getByRole("link", { name: "Administration", exact: true }).click();
    await cash.waitForURL("**/connexion.html?espace=administration");
    await cash.getByRole("button", { name: "Se connecter" }).waitFor({ state: "visible" });
    await cash.waitForFunction(() => !document.querySelector('#auth-form button[type=submit]').disabled);
    const stale = await fetch(base + "/api/cashier?period=" + period, { headers: { Cookie: oldCookie.name + "=" + oldCookie.value } });
    assert.equal(stale.status, 401, "Opening another login space revokes the previous cashier session");
    await login(cash, "cashier-daily-browser", "Personal-daily-browser-123!", "caisse");
    await cash.locator("#cashier-student").waitFor();
    assert.deepEqual(errors, []);
    console.log("PASS accueil Caisse/Administration séparés, compte caissier attribué par responsable, école/classe/élève sans saisie de nom, encaissement PDF, présences du jour persistées et partagées, absence non implicite, brouillons conservés lors des mises à jour, accès admin refusé, mobile 390px.");
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    instance.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
