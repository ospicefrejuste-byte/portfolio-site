"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const serverless = require("serverless-http");
const { createApplication } = require("../lib/application");
const { options, normalizeEvent } = require("../lib/serverless");
test("transport Netlify : chemins, session partagée et vrai PDF binaire sans corruption", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adeoye-transport-test-"));
  const instance = await createApplication({ dataDir: dir, setupToken: "transport-test-only", publicOrigin: "https://adeoye.example" });
  const handler = serverless(instance.app, options);
  let cookie = "", csrf = "";
  async function request(route, method = "GET", body) {
    const result = await handler(normalizeEvent({ httpMethod: method, path: "/.netlify/functions/api" + route, headers: { host: "adeoye.example", origin: "https://adeoye.example", ...(cookie ? { cookie } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}), ...(body ? { "content-type": "application/json" } : {}) }, requestContext: { identity: { sourceIp: "127.0.0.1" } }, body: body ? JSON.stringify(body) : null, isBase64Encoded: false }), {});
    const cookies = result.multiValueHeaders?.["set-cookie"] || result.multiValueHeaders?.["Set-Cookie"] || (result.headers?.["set-cookie"] ? [result.headers["set-cookie"]] : []);
    if (cookies.length) cookie = cookies.at(-1).split(";", 1)[0];
    if ((result.headers?.["content-type"] || "").includes("application/json")) {
      result.data = JSON.parse(result.body); if (result.data.csrf) csrf = result.data.csrf;
    }
    return result;
  }
  try {
    assert.equal((await request("/api/health")).statusCode, 200);
    const privatePage = await request("/app.html"); assert.equal(privatePage.statusCode, 302);
    const setup = await request("/api/auth/setup", "POST", { token: "transport-test-only", username: "transport-test", password: "Transport-test-only-847!" });
    assert.equal(setup.statusCode, 200, setup.data?.error);
    assert.ok(cookie && csrf);
    assert.equal((await request("/api/items", "POST", { requestId: crypto.randomUUID(), name: "Récolte de maïs", category: "Cultures et récoltes", unit: "kg", quantity: 12.5, minQuantity: 2, unitValue: 250, location: "Magasin de test" })).statusCode, 201);
    const report = await request("/api/reports/inventory.pdf"); assert.equal(report.statusCode, 200); assert.equal(report.isBase64Encoded, true);
    const bytes = Buffer.from(report.body, "base64"); assert.equal(bytes.subarray(0, 5).toString(), "%PDF-"); assert.ok(bytes.length > 2000);
    const state = await request("/api/state"); assert.equal(state.statusCode, 200); assert.equal(state.data.items[0].quantity, 12.5);
    assert.equal((await request("/app.html")).statusCode, 200);
    assert.equal((await request("/api/notes", "POST", { title: "Trop volumineux", body: "x".repeat(70000), date: new Date().toISOString().slice(0, 10) })).statusCode, 413);
    assert.equal((await request("/api/notes", "POST", ["objet JSON requis"])).statusCode, 400);
    assert.equal((await request("/api/state")).data.notes.length, 0);
  } finally { await instance.db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
