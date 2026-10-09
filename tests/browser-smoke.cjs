"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const { createApplication } = require("../lib/application");
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crs-browser-test-"));
  let application;
  application = createApplication({
    dataDir: dir,
    setupToken: "browser-test-setup",
    paymentConfig: {
      sandbox: true,
      publicKey: "test-public",
      privateKey: "test-private",
      secretKey: "test-secret",
    },
    verifyTransaction: async (id) => {
      assert.equal(id, "browser_test_transaction");
      const order = application.db
        .prepare(
          "SELECT * FROM payment_orders WHERE state='pending' ORDER BY created_at DESC LIMIT 1",
        )
        .get();
      return {
        status: "SUCCESS",
        amount: order.amount,
        data: JSON.stringify({ orderId: order.id }),
      };
    },
  });
  const server = application.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
    args: ["--no-sandbox"],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const p = await context.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("dialog", (dialog) => dialog.accept());
    await p.goto(base + "/gestion.html");
    await p.waitForURL("**/connexion.html");
    await p.goto(base + "/installation.html");
    await p.locator("#token").fill("browser-test-setup");
    await p.locator("#username").fill("admin");
    await p.locator("#password").fill("Browser-admin-password-123!");
    await p.locator("#confirm-password").fill("Browser-admin-password-123!");
    await p
      .getByRole("button", { name: "Créer mon compte administrateur" })
      .click();
    await p.waitForURL("**/gestion.html");
    await p.locator('[data-page="students"]').waitFor();
    console.log(
      "PASS installation administrateur et redirection des visiteurs",
    );
    const visitor = await browser.newContext();
    const publicPage = await visitor.newPage();
    await publicPage.goto(base);
    await publicPage.locator('[name="name"]').fill("Élève navigateur");
    await publicPage.locator('[name="guardian"]').fill("Parent fictif");
    await publicPage.locator('[name="phone"]').fill("0000000000");
    await publicPage.locator(".consent input").check();
    await publicPage.locator('button[type="submit"]').click();
    await publicPage
      .getByText("Préinscription reçue !", { exact: false })
      .waitFor();
    await p.reload();
    await p.locator('[data-page="students"]').click();
    await p.getByRole("cell").filter({ hasText: "Élève navigateur" }).waitFor();
    await p.locator("[data-edit]").first().click();
    await p.locator("#f-group").fill("6e A");
    await p.locator("#f-registrationStatus").selectOption("Inscrit");
    await p.locator('#form button[type="submit"]').click();
    await p.getByRole("cell", { name: "Inscrit", exact: true }).waitFor();
    console.log("PASS préinscription serveur et validation par administration");
    await p.locator('[data-page="teachers"]').click();
    await p.locator("#add").click();
    await p.locator("#f-name").fill("Enseignant navigateur");
    await p.locator('#form button[type="submit"]').click();
    await p
      .getByRole("cell")
      .filter({ hasText: "Enseignant navigateur" })
      .waitFor();
    await p.locator('[data-page="courses"]').click();
    await p.locator("#add").click();
    await p.locator("#f-date").fill("2026-11-12");
    await p.locator("#f-time").fill("16:00");
    await p.locator("#f-room").fill("Salle 01");
    await p.locator('#form button[type="submit"]').click();
    await p.getByRole("cell", { name: "Mathématiques", exact: true }).waitFor();
    await p.locator("#add").click();
    await p.locator("#f-date").fill("2026-11-12");
    await p.locator("#f-time").fill("16:30");
    await p.locator("#f-room").fill("Salle 01");
    await p.locator('#form button[type="submit"]').click();
    await p.locator("#error").filter({ hasText: "occupé" }).waitFor();
    await p.locator("#close").click();
    await p.locator('[data-page="attendance"]').click();
    await p.locator("[data-attendance]").first().selectOption("Présent");
    await p.waitForFunction(
      () => document.querySelector("[data-attendance]")?.disabled === false,
    );
    await p.reload();
    await p.locator('[data-page="attendance"]').click();
    assert.equal(
      await p.locator("[data-attendance]").first().inputValue(),
      "Présent",
    );
    console.log(
      "PASS planning, conflits et présence conservée après rechargement",
    );
    await p.locator('[data-page="payments"]').click();
    await p.locator("#add").click();
    await p.locator("#f-amount").fill("1000");
    await p.locator("#f-period").fill("2026-11");
    await p.locator('#form button[type="submit"]').click();
    await p
      .getByRole("cell", { name: "Saisie manuelle", exact: true })
      .waitFor();
    await p.evaluate(() => {
      window.print = () => {
        window.__printed = true;
      };
    });
    await p.locator("[data-receipt]").first().click();
    await p.getByRole("button", { name: "Imprimer le reçu" }).click();
    assert.equal(await p.evaluate(() => window.__printed), true);
    await p.locator("#close").click();
    await p.evaluate(() => {
      window.openKkiapayWidget = (options) => {
        window.__paymentWidget = options;
      };
    });
    await p.locator("#pay-online").click();
    await p.locator("#f-period").fill("2026-11");
    await p.locator('#form button[type="submit"]').click();
    await p.waitForFunction(() => Boolean(window.__paymentWidget));
    const widget = await p.evaluate(() => window.__paymentWidget);
    assert.equal(widget.amount, 3500); // Manual cash receipts are real; sandbox remains independent.
    await p.evaluate(() =>
      window.postMessage(
        {
          name: "PAYMENT_SUCCESS",
          data: { transactionId: "browser_test_transaction" },
        },
        "*",
      ),
    );
    await p.getByRole("cell", { name: "Test confirmé", exact: true }).waitFor();
    console.log(
      "PASS reçu imprimable et parcours KKiaPay simulé avec confirmation serveur",
    );
    await p.locator('[data-page="users"]').click();
    await p.locator("#add").click();
    await p.locator("#f-username").fill("prof-test");
    await p.locator("#f-role").selectOption("teacher");
    await p.locator("#f-password").fill("Initial-prof-password-123!");
    await p.locator('#form button[type="submit"]').click();
    await p.getByRole("cell", { name: "prof-test", exact: true }).waitFor();
    await p.locator("#add").click();
    await p.locator("#f-username").fill("eleve-test");
    await p.locator("#f-role").selectOption("student");
    await p.locator("#f-password").fill("Initial-eleve-password-123!");
    await p.locator('#form button[type="submit"]').click();
    await p.getByRole("cell", { name: "eleve-test", exact: true }).waitFor();
    const downloadPromise = p.waitForEvent("download");
    await p.locator("#export").click();
    const download = await downloadPromise;
    assert.ok(download.suggestedFilename().endsWith(".json"));
    console.log("PASS création des comptes et export administrateur");
    const teacherContext = await browser.newContext();
    const teacherPage = await teacherContext.newPage();
    teacherPage.on("pageerror", (e) => errors.push(e.message));
    await teacherPage.goto(base + "/connexion.html");
    await teacherPage.locator("#username").fill("prof-test");
    await teacherPage.locator("#password").fill("Initial-prof-password-123!");
    await teacherPage.getByRole("button", { name: "Se connecter" }).click();
    await teacherPage.waitForURL("**/gestion.html");
    await teacherPage
      .locator("#f-currentPassword")
      .fill("Initial-prof-password-123!");
    await teacherPage
      .locator("#f-password")
      .fill("Personal-prof-password-123!");
    await teacherPage
      .locator("#f-confirmation")
      .fill("Personal-prof-password-123!");
    await teacherPage.locator('#form button[type="submit"]').click();
    await teacherPage.locator('[data-page="grades"]').waitFor();
    assert.equal(await teacherPage.locator('[data-page="users"]').count(), 0);
    await teacherPage.locator('[data-page="grades"]').click();
    await teacherPage.locator("#add").click();
    await teacherPage.locator("#f-label").fill("Évaluation navigateur");
    await teacherPage.locator("#f-score").fill("17");
    await teacherPage.locator('#form button[type="submit"]').click();
    await teacherPage
      .getByRole("cell", { name: "Évaluation navigateur" })
      .waitFor();
    const studentContext = await browser.newContext();
    const studentPage = await studentContext.newPage();
    studentPage.on("pageerror", (e) => errors.push(e.message));
    await studentPage.goto(base + "/connexion.html");
    await studentPage.locator("#username").fill("eleve-test");
    await studentPage.locator("#password").fill("Initial-eleve-password-123!");
    await studentPage.getByRole("button", { name: "Se connecter" }).click();
    await studentPage.waitForURL("**/gestion.html");
    await studentPage
      .locator("#f-currentPassword")
      .fill("Initial-eleve-password-123!");
    await studentPage
      .locator("#f-password")
      .fill("Personal-eleve-password-123!");
    await studentPage
      .locator("#f-confirmation")
      .fill("Personal-eleve-password-123!");
    await studentPage.locator('#form button[type="submit"]').click();
    await studentPage.locator('[data-page="grades"]').click();
    await studentPage
      .getByRole("cell", { name: "Évaluation navigateur" })
      .waitFor();
    assert.equal(await studentPage.locator("[data-edit]").count(), 0);
    assert.equal(await studentPage.locator('[data-page="users"]').count(), 0);
    console.log(
      "PASS changement initial obligatoire, enseignant et élève en lecture seule",
    );
    const teacherRow = p.getByRole("row").filter({ hasText: "prof-test" });
    await teacherRow.locator("[data-toggle-user]").click();
    await teacherRow.getByText("Désactivé", { exact: true }).waitFor();
    await teacherPage.reload();
    await teacherPage.waitForURL("**/connexion.html");
    await teacherRow.locator("[data-toggle-user]").click();
    await teacherRow.getByText("Actif", { exact: true }).waitFor();
    await teacherRow.locator("[data-reset-user]").click();
    await p.locator("#f-password").fill("Reset-prof-password-123!");
    await p.locator('#form button[type="submit"]').click();
    await p.locator("#modal").waitFor({ state: "hidden" });
    console.log(
      "PASS désactivation, réactivation et réinitialisation des comptes",
    );
    // Exercise create/edit/delete buttons on independent records.
    await p.locator('[data-page="teachers"]').click();
    await p.locator("#add").click();
    await p.locator("#f-name").fill("Enseignant à supprimer");
    await p.locator('#form button[type="submit"]').click();
    let row = p.getByRole("row").filter({ hasText: "Enseignant à supprimer" });
    await row.waitFor();
    await row.locator("[data-edit]").click();
    await p.locator("#f-name").fill("Enseignant modifié");
    await p.locator('#form button[type="submit"]').click();
    row = p.getByRole("row").filter({ hasText: "Enseignant modifié" });
    await row.waitFor();
    await row.locator("[data-delete]").click();
    await row.waitFor({ state: "hidden" });
    await p.locator("#change-password").click();
    await p.locator("#f-currentPassword").fill("Browser-admin-password-123!");
    await p.locator("#f-password").fill("Browser-admin-changed-password-123!");
    await p
      .locator("#f-confirmation")
      .fill("Browser-admin-changed-password-123!");
    await p.locator('#form button[type="submit"]').click();
    await p.locator("#modal").waitFor({ state: "hidden" });
    await p.setViewportSize({ width: 390, height: 844 });
    await p.locator('[data-page="dashboard"]').click();
    assert.equal(
      await p.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await p.screenshot({
      path: "/tmp/crs-real-admin-mobile.png",
      fullPage: true,
    });
    await p.locator("#logout").click();
    await p.waitForURL("**/connexion.html");
    await p.locator("#username").fill("admin");
    await p.locator("#password").fill("Browser-admin-changed-password-123!");
    await p.getByRole("button", { name: "Se connecter" }).click();
    await p.waitForURL("**/gestion.html");
    await p.locator('[data-page="dashboard"]').waitFor();
    assert.deepEqual(errors, []);
    console.log(
      "PASS modification, suppression, mot de passe admin, déconnexion/reconnexion et mobile",
    );
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
    application.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
