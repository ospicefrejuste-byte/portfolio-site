"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { createApplication } = require("../lib/application");
test("Production HTTPS : origine, cookie sécurisé et sauvegarde restaurable", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crs-production-test-"));
  assert.throws(
    () => createApplication({ dataDir: dir, production: true }),
    /PUBLIC_ORIGIN/,
  );
  const instance = createApplication({
    dataDir: dir,
    production: true,
    publicOrigin: "https://school.example",
    setupToken: "test-production-setup",
  });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    instance.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let response = await fetch(base + "/api/auth/setup", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://other.example",
    },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 403);
  response = await fetch(base + "/api/auth/setup", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://school.example",
    },
    body: JSON.stringify({
      username: "admin",
      password: "Production-test-password-123!",
      token: "test-production-setup",
    }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  const session = await response.json();
  const saved = await fetch(base + "/api/records/students", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie.split(";")[0],
      "X-CSRF-Token": session.csrf,
      Origin: "https://school.example",
    },
    body: JSON.stringify({ name: "Backup test", class: "6e", group: "6e A" }),
  });
  assert.equal(saved.status, 201);
  const output = path.join(dir, "backup.sqlite");
  const backup = spawnSync(process.execPath, ["scripts/backup.js", output], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, CRS_DATA_DIR: dir },
    encoding: "utf8",
  });
  assert.equal(backup.status, 0, backup.stderr);
  const restored = new DatabaseSync(output);
  assert.equal(restored.prepare("SELECT count(*) n FROM users").get().n, 1);
  assert.equal(restored.prepare("SELECT count(*) n FROM records").get().n, 1);
  restored.close();
  const refused = spawnSync(process.execPath, ["scripts/backup.js", output], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, CRS_DATA_DIR: dir },
    encoding: "utf8",
  });
  assert.notEqual(refused.status, 0);
  response = await fetch(base + "/api/data", {
    headers: { Cookie: cookie.split(";")[0] },
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
  response = await fetch(base + "/.data/school.sqlite");
  assert.equal(response.status, 404);
});
