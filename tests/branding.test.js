"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createApplication } = require("../lib/application");
const { canonicalLogo, MAX_LOGO_BYTES } = require("../lib/branding");
const { png, chunk, dataUrl } = require("./helpers-logo.cjs");

function types(bytes) {
  const result = [];
  for (let offset = 8; offset < bytes.length;) { result.push(bytes.toString("ascii", offset + 4, offset + 8)); offset += bytes.readUInt32BE(offset) + 12; }
  return result;
}

test("logo PNG borné : image RGB/RGBA canonique, métadonnées supprimées et empreinte stable", () => {
  for (const colorType of [2, 6]) {
    const bytes = png({ colorType, metadata: "Comment\0secret-metadata-not-kept" });
    const result = canonicalLogo(dataUrl(bytes)), canonical = Buffer.from(result.data, "base64");
    assert.equal(result.width, 8); assert.equal(result.height, 8);
    assert.deepEqual(types(canonical), ["IHDR", "IDAT", "IEND"]);
    assert.ok(!canonical.includes(Buffer.from("secret-metadata")));
    assert.equal(result.digest, crypto.createHash("sha256").update(canonical).digest("hex"));
    assert.deepEqual(canonicalLogo(dataUrl(canonical)), result);
  }
  assert.equal(canonicalLogo(dataUrl(png({ width: 512, height: 512 }))).width, 512);
});

test("logos invalides, animations, bombes compressées, formats actifs et dimensions excessives restent refusés", () => {
  const valid = png(), corrupted = Buffer.from(valid); corrupted[29] ^= 1;
  const wrongFilter = Buffer.alloc(5); wrongFilter[0] = 5;
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  const animated = png({ chunks: [chunk("IHDR", header), chunk("acTL", Buffer.alloc(8)), chunk("IDAT", require("node:zlib").deflateSync(Buffer.alloc(5))), chunk("IEND", Buffer.alloc(0))] });
  const payloads = [
    undefined, null, 42, "https://example.invalid/logo.png", "/tmp/logo.png", "data:image/svg+xml;base64," + Buffer.from('<svg onload="alert(1)"/>').toString("base64"),
    "data:image/jpeg;base64," + valid.toString("base64"), "data:image/png;base64,!!!!", "data:image/png;base64,", dataUrl(Buffer.from("<svg/>")),
    dataUrl(corrupted), dataUrl(valid.subarray(0, valid.length - 2)), dataUrl(png({ suffix: Buffer.from("<script>active</script>") })),
    dataUrl(png({ width: 513, height: 1 })), dataUrl(png({ colorType: 3 })), dataUrl(png({ bitDepth: 16 })), dataUrl(png({ interlace: 1 })), dataUrl(animated),
    dataUrl(png({ width: 1, height: 1, raw: wrongFilter })), dataUrl(png({ width: 1, height: 1, raw: Buffer.alloc(1000000) })),
    dataUrl(png({ metadata: "x".repeat(MAX_LOGO_BYTES) })),
  ];
  for (const value of payloads) assert.throws(() => canonicalLogo(value), error => error.status === 400);
});

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "adeoye-branding-test-"));
  let instance, server, base;
  async function close() {
    if (server) { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); server = null; }
    if (instance) { await instance.db.close(); instance = null; }
  }
  async function start() {
    instance = await createApplication({ dataDir, setupToken: "branding-fixture-only" });
    server = instance.app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve)); base = "http://127.0.0.1:" + server.address().port;
  }
  function client() {
    let cookie = "", csrf = "";
    return {
      async request(route, method = "GET", data, options = {}) {
        const response = await fetch(base + route, { method, redirect: "manual", headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...(method === "GET" ? {} : { Origin: options.origin || base }), ...(csrf && method !== "GET" && !options.noCsrf ? { "X-CSRF-Token": csrf } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
        for (const value of response.headers.getSetCookie()) cookie = value.split(";", 1)[0];
        const bytes = Buffer.from(await response.arrayBuffer());
        const body = (response.headers.get("content-type") || "").includes("application/json") ? JSON.parse(bytes.toString()) : undefined;
        if (body?.csrf) csrf = body.csrf;
        return { status: response.status, body, bytes, headers: response.headers };
      },
    };
  }
  await start(); t.after(async () => { await close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const admin = client(), anonymous = client(), password = "Logo-owner-fixture-583!";
  assert.equal((await admin.request("/api/auth/setup", "POST", { token: "branding-fixture-only", username: "responsable-logo", password })).status, 200);
  async function account(role) {
    const username = "logo-" + role, initial = "Logo-initial-fixture-582!", personal = "Logo-personal-fixture-581!";
    assert.equal((await admin.request("/api/users", "POST", { username, password: initial, role })).status, 201);
    const user = client();
    assert.equal((await user.request("/api/auth/login", "POST", { username, password: initial })).status, 200);
    assert.equal((await user.request("/api/auth/password", "POST", { currentPassword: initial, password: personal })).status, 200);
    return user;
  }
  return { admin, anonymous, client, account, close, start, password };
}

test("seul le responsable change le logo avec origine et CSRF ; l’image et sa référence publique restent sans données privées", async t => {
  const f = await fixture(t), value = dataUrl(png({ metadata: "Private\0metadata-never-public" }));
  assert.equal((await f.anonymous.request("/api/settings/logo", "PUT", { dataUrl: value })).status, 401);
  assert.equal((await f.admin.request("/api/settings/logo", "PUT", { dataUrl: value }, { noCsrf: true })).status, 403);
  assert.equal((await f.admin.request("/api/settings/logo", "PUT", { dataUrl: value }, { origin: "https://other.example" })).status, 403);
  for (const role of ["manager", "viewer"]) {
    const user = await f.account(role);
    assert.equal((await user.request("/api/settings/logo", "PUT", { dataUrl: value })).status, 403);
    assert.equal((await user.request("/api/settings/logo", "PUT", { dataUrl: null })).status, 403);
  }
  const added = await f.admin.request("/api/settings/logo", "PUT", { dataUrl: value });
  assert.equal(added.status, 200, added.body?.error);
  assert.match(added.body.logoUrl, /^\/api\/branding\/logo\.png\?v=[a-f0-9]{64}$/);
  const settings = await f.anonymous.request("/api/settings");
  assert.equal(settings.body.logoUrl, added.body.logoUrl);
  assert.ok(!JSON.stringify(settings.body).includes("base64"));
  assert.ok(!JSON.stringify((await f.admin.request("/api/state")).body).includes("metadata-never-public"));
  const image = await f.anonymous.request(added.body.logoUrl);
  assert.equal(image.status, 200); assert.match(image.headers.get("content-type"), /^image\/png/);
  assert.equal(image.headers.get("x-content-type-options"), "nosniff"); assert.equal(image.headers.get("cache-control"), "no-store");
  assert.deepEqual(types(image.bytes), ["IHDR", "IDAT", "IEND"]);
  assert.ok(!image.bytes.includes(Buffer.from("metadata-never-public")));
  for (const data of [{}, { dataUrl: value, path: "/tmp/injected" }, { dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" }]) assert.equal((await f.admin.request("/api/settings/logo", "PUT", data)).status, 400);
  assert.equal((await f.anonymous.request("/api/settings")).body.logoUrl, added.body.logoUrl, "A rejected image does not replace the saved logo");
});

test("logo durable : les autres paramètres, comptes et stocks sont conservés ; remplacement et retour au logo par défaut", async t => {
  const f = await fixture(t);
  const inventory = await f.admin.request("/api/items", "POST", { requestId: crypto.randomUUID(), name: "Sac de test conservé", category: "Aliments et intrants", unit: "sac", quantity: 3, minQuantity: 1, unitValue: 1000 });
  assert.equal(inventory.status, 201);
  const before = (await f.admin.request("/api/state")).body;
  const first = await f.admin.request("/api/settings/logo", "PUT", { dataUrl: dataUrl(png()) });
  assert.equal(first.status, 200);
  const edit = await f.admin.request("/api/settings", "PUT", { ...first.body, name: "Ferme fictive renommée" });
  assert.equal(edit.status, 200); assert.equal(edit.body.logoUrl, first.body.logoUrl);
  await f.close(); await f.start();
  const owner = f.client();
  assert.equal((await owner.request("/api/auth/login", "POST", { username: "responsable-logo", password: f.password })).status, 200);
  const persisted = (await owner.request("/api/state")).body;
  assert.deepEqual(persisted.items, before.items); assert.deepEqual(persisted.movements, before.movements);
  assert.equal(persisted.settings.name, "Ferme fictive renommée"); assert.equal(persisted.settings.logoUrl, first.body.logoUrl);
  const second = await owner.request("/api/settings/logo", "PUT", { dataUrl: dataUrl(png({ pixel: [20, 40, 200, 255] })) });
  assert.equal(second.status, 200); assert.notEqual(second.body.logoUrl, first.body.logoUrl);
  assert.equal((await f.anonymous.request(second.body.logoUrl)).status, 200);
  const reset = await owner.request("/api/settings/logo", "PUT", { dataUrl: null });
  assert.equal(reset.status, 200); assert.equal(reset.body.logoUrl, null);
  const fallback = await f.anonymous.request("/api/branding/logo.png"); assert.equal(fallback.status, 302); assert.equal(fallback.headers.get("location"), "/mark.svg");
  assert.equal((await owner.request("/api/settings/logo", "PUT", { dataUrl: null })).status, 200, "Reset is safely repeatable");
  assert.deepEqual((await owner.request("/api/state")).body.items, before.items);
});
