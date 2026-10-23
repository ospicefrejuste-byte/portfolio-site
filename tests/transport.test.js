"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const serverless = require("serverless-http");
const { createApplication } = require("../lib/application");
const { options, normalizeEvent } = require("../lib/serverless");
const { png, dataUrl } = require("./helpers-logo.cjs");
const { canonicalLogo } = require("../lib/branding");
test("transport Netlify : chemins, session partagée et vrai PDF binaire sans corruption", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adeoye-transport-test-"));
  const instance = await createApplication({ dataDir: dir, setupToken: "transport-test-only", publicOrigin: "https://adeoye.example" });
  const handler = serverless(instance.app, options);
  let cookie = "", csrf = "";
  async function request(route, method = "GET", body) {
    const parsed = new URL(route, "https://adeoye.example");
    const result = await handler(normalizeEvent({ httpMethod: method, path: "/.netlify/functions/api" + parsed.pathname, queryStringParameters: Object.fromEntries(parsed.searchParams), headers: { host: "adeoye.example", origin: "https://adeoye.example", ...(cookie ? { cookie } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}), ...(body ? { "content-type": "application/json" } : {}) }, requestContext: { identity: { sourceIp: "127.0.0.1" } }, body: body ? JSON.stringify(body) : null, isBase64Encoded: false }), {});
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
    const purchase = { requestId: crypto.randomUUID(), description: "Transport de récolte", category: "Transport", supplier: "Fournisseur fictif", amount: 18500, date: "2025-03-01", time: "09:15", notes: "Fixture isolée" };
    assert.equal((await request("/api/expenses", "POST", purchase)).statusCode, 201);
    assert.equal((await request("/api/expenses", "POST", { ...purchase, requestId: crypto.randomUUID(), amount: 5000, date: "2025-03-02" })).statusCode, 201);
    const filtered = await request("/api/expenses?from=2025-03-01&to=2025-03-01");
    assert.equal(filtered.statusCode, 200); assert.equal(filtered.data.count, 1); assert.equal(filtered.data.total, "18500");
    const expenseReport = await request("/api/reports/expenses.pdf?from=2025-03-01&to=2025-03-01");
    assert.equal(expenseReport.statusCode, 200); assert.equal(expenseReport.isBase64Encoded, true);
    assert.equal(Buffer.from(expenseReport.body, "base64").subarray(0, 5).toString(), "%PDF-");
    assert.equal((await request("/api/reports/expenses.pdf?from=2025-03-02&to=2025-03-01")).statusCode, 400);
    const batch = await request("/api/goliath/batches", "POST", { requestId: crypto.randomUUID(), name: "Lot Goliath transport fictif", arrivalDate: "2025-01-01", initialCount: 40, stage: "chicks" });
    assert.equal(batch.statusCode, 201, batch.data?.error);
    assert.equal(batch.data.ageDays, null);
    const batchId = batch.data.id;
    const event = await request("/api/goliath/batches/" + batchId + "/events", "POST", { requestId: crypto.randomUUID(), type: "sale", quantity: 4, date: "2025-03-01", time: "11:30", totalAmount: 26000, buyer: "Client fictif" });
    assert.equal(event.statusCode, 201, event.data?.error);
    const poultry = (await request("/api/state")).data;
    assert.equal(poultry.goliathBatches[0].remainingCount, 36);
    assert.equal(poultry.goliathBatches[0].salesTotal, "26000");
    assert.equal(poultry.items.find(item => item.id === batch.data.itemId).quantity, 36);
    const poultryReport = await request("/api/reports/goliath.pdf?batchId=" + batchId);
    assert.equal(poultryReport.statusCode, 200); assert.equal(poultryReport.isBase64Encoded, true);
    assert.equal(Buffer.from(poultryReport.body, "base64").subarray(0, 5).toString(), "%PDF-");
    assert.equal((await request("/api/reports/goliath.pdf?batchId=incorrect")).statusCode, 400);
    const preparedLogo = dataUrl(png());
    const logoSaved = await request("/api/settings/logo", "PUT", { dataUrl: preparedLogo });
    assert.equal(logoSaved.statusCode, 200, logoSaved.data?.error);
    assert.match(logoSaved.data.logoUrl, /^\/api\/branding\/logo\.png\?v=/);
    const logoImage = await request(logoSaved.data.logoUrl);
    assert.equal(logoImage.statusCode, 200); assert.equal(logoImage.isBase64Encoded, true, "Le logo PNG doit rester binaire à travers Netlify");
    assert.deepEqual(Buffer.from(logoImage.body, "base64"), Buffer.from(canonicalLogo(preparedLogo).data, "base64"));
    assert.equal((await request("/api/settings/logo", "PUT", { dataUrl: null })).data.logoUrl, null);
  } finally { await instance.db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
