'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, rmSync, chmodSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const { StockService } = require('../lib/business');
const { createApp } = require('../server');

const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yafEAAAAASUVORK5CYII=', 'base64');
function restoreEnv(t, names) {
  const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
}
const listen = app => new Promise((resolve, reject) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
  server.once('error', reject);
});
const stop = server => new Promise((resolve, reject) => {
  server.close(error => error ? reject(error) : resolve());
  server.closeAllConnections();
});

test('upload paths prefer explicit configuration, honor persistent storage and fail early on invalid configuration', t => {
  restoreEnv(t, ['STOCK_UPLOAD_DIR', 'APP_ORIGIN']);
  delete process.env.APP_ORIGIN;
  const directory = mkdtempSync(path.join(tmpdir(), 'comptoir-config-'));
  const service = new StockService({ dbPath: ':memory:', production: false });
  t.after(() => { service.close(); rmSync(directory, { recursive: true, force: true }); });
  process.env.STOCK_UPLOAD_DIR = path.join(directory, 'persistent', 'images');
  const app = createApp({ service });
  assert.equal(app.locals.uploadDir, path.resolve(process.env.STOCK_UPLOAD_DIR));
  const override = path.join(directory, 'override');
  assert.equal(createApp({ service, uploadDir: override }).locals.uploadDir, path.resolve(override));
  process.env.APP_ORIGIN = 'https://stock.example.test/incorrect-path';
  assert.throws(() => createApp({ service }), /APP_ORIGIN/);
  process.env.APP_ORIGIN = 'https://owner:password@stock.example.test';
  assert.throws(() => createApp({ service }), /APP_ORIGIN/);
  delete process.env.APP_ORIGIN;
  if (process.getuid?.() !== 0) {
    chmodSync(override, 0o500);
    try { assert.throws(() => createApp({ service, uploadDir: override }), error => error.code === 'EACCES'); }
    finally { chmodSync(override, 0o700); }
  }
});

test('production behind an HTTPS proxy uses a real admin, Secure cookies and persistent images across restart', async t => {
  restoreEnv(t, ['STOCK_UPLOAD_DIR', 'APP_ORIGIN', 'TRUST_PROXY']);
  const directory = mkdtempSync(path.join(tmpdir(), 'comptoir-production-'));
  process.env.STOCK_UPLOAD_DIR = path.join(directory, 'uploads');
  process.env.APP_ORIGIN = 'https://stock.example.test';
  process.env.TRUST_PROXY = '1';
  const password = `test-${randomUUID()}`;
  const email = 'owner@example.test';
  const dbPath = path.join(directory, 'data', 'stock.sqlite');
  let service = new StockService({ dbPath, production: true, adminEmail: email, adminPassword: password });
  let app = createApp({ service });
  app.get('/__test-proxy', (req, res) => res.json({ secure: req.secure, protocol: req.protocol }));
  assert.equal(app.get('trust proxy'), 1);
  let server = await listen(app);
  t.after(async () => {
    await stop(server); service.close(); rmSync(directory, { recursive: true, force: true });
  });
  const base = () => `http://127.0.0.1:${server.address().port}`;
  const proxyHeaders = { Origin: 'https://stock.example.test', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '192.0.2.8' };
  const post = (route, body, cookie, headers = proxyHeaders) => fetch(base() + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body)
  });
  const login = async () => {
    const response = await post('/api/login', { email, password });
    assert.equal(response.status, 200);
    const rawCookie = response.headers.get('set-cookie');
    assert.match(rawCookie, /; Secure(?:;|$)/i);
    assert.match(rawCookie, /; HttpOnly(?:;|$)/i);
    assert.match(rawCookie, /; SameSite=Strict(?:;|$)/i);
    const body = await response.json();
    assert.equal(body.user.role, 'admin');
    assert.equal(body.user.email, email);
    assert.equal(Object.hasOwn(body, 'token'), false);
    return rawCookie.split(';')[0];
  };
  assert.deepEqual(await (await fetch(base() + '/api/config')).json(), { demoMode: false });
  assert.deepEqual(await (await fetch(base() + '/api/health')).json(), { ok: true });
  assert.deepEqual(await (await fetch(base() + '/__test-proxy', { headers: proxyHeaders })).json(), { secure: true, protocol: 'https' });
  const demo = await post('/api/login', { email: 'admin@stock.local', password: 'Demo2026!' });
  assert.equal(demo.status, 401);
  assert.equal(demo.headers.get('set-cookie'), null);
  const cookie = await login();
  const initial = await (await fetch(base() + '/api/state', { headers: { Cookie: cookie } })).json();
  assert.deepEqual(initial.products, []);
  assert.deepEqual(initial.documents, []);
  assert.equal(initial.stores.length, 1);
  const wrongOrigin = await post('/api/logout', {}, cookie, { ...proxyHeaders, Origin: 'https://other.example.test' });
  assert.equal(wrongOrigin.status, 403);
  assert.equal((await wrongOrigin.json()).code, 'BAD_ORIGIN');
  const form = new FormData();
  form.append('images', new Blob([tinyPng], { type: 'image/png' }), 'photo.png');
  const uploaded = await fetch(base() + '/upload', { method: 'POST', headers: { ...proxyHeaders, Cookie: cookie }, body: form });
  assert.equal(uploaded.status, 200);
  const imagePath = (await uploaded.json())[0];
  assert.deepEqual(readFileSync(path.join(process.env.STOCK_UPLOAD_DIR, path.basename(imagePath))), tinyPng);
  assert.equal((await post('/api/logout', {}, cookie)).status, 200);
  await stop(server); service.close();
  service = new StockService({ dbPath, production: true });
  app = createApp({ service });
  server = await listen(app);
  const renewedCookie = await login();
  const persisted = await fetch(base() + imagePath, { headers: { Cookie: renewedCookie } });
  assert.equal(persisted.status, 200);
  assert.deepEqual(Buffer.from(await persisted.arrayBuffer()), tinyPng);
  assert.deepEqual(await (await fetch(base() + '/api/config')).json(), { demoMode: false });
});

test('production without APP_ORIGIN accepts the actual external Host and rejects a different origin', async t => {
  restoreEnv(t, ['APP_ORIGIN', 'TRUST_PROXY']);
  delete process.env.APP_ORIGIN;
  process.env.TRUST_PROXY = '1';
  const directory = mkdtempSync(path.join(tmpdir(), 'comptoir-public-host-'));
  const email = 'owner@example.test';
  const password = `test-${randomUUID()}`;
  const service = new StockService({ dbPath: ':memory:', production: true, adminEmail: email, adminPassword: password });
  const app = createApp({ service, uploadDir: directory });
  const server = await listen(app);
  t.after(async () => { await stop(server); service.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = origin => new Promise((resolve, reject) => {
    const body = JSON.stringify({ email, password });
    const outgoing = http.request(base + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Host: 'public-stock.example.test', Origin: origin, 'X-Forwarded-Proto': 'https' }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      response.on('error', reject);
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
  const accepted = await request('https://public-stock.example.test');
  assert.equal(accepted.status, 200);
  assert.match(accepted.headers['set-cookie'][0], /; Secure(?:;|$)/i);
  const rejected = await request('https://elsewhere.example.test');
  assert.equal(rejected.status, 403);
  assert.equal(rejected.body.code, 'BAD_ORIGIN');
});

test('SIGTERM stops a production process promptly and safely closes persistent SQLite', { timeout: 15_000 }, async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'comptoir-shutdown-'));
  const dbPath = path.join(directory, 'data', 'stock.sqlite');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'production', PORT: '0', STOCK_DB_PATH: dbPath, STOCK_UPLOAD_DIR: path.join(directory, 'uploads'), STOCK_ADMIN_EMAIL: 'shutdown@example.test', STOCK_ADMIN_PASSWORD: `test-${randomUUID()}`, APP_ORIGIN: '', TRUST_PROXY: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let socket;
  t.after(() => { socket?.destroy(); if (child.exitCode === null) child.kill('SIGKILL'); rmSync(directory, { recursive: true, force: true }); });
  const exit = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); const match = output.match(/serveur prêt \(port (\d+)\)/); if (match) resolve(Number(match[1])); });
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Le serveur est sorti avant son démarrage.')));
  });
  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(health.status, 200); await health.json();
  // A partial HTTP upload keeps an active connection open to exercise the shutdown deadline.
  socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.write('POST /api/login HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\nConnection: keep-alive\r\n\r\n{');
  child.kill('SIGTERM');
  const result = await exit;
  assert.equal(result.signal, null);
  assert.ok(result.code === 0 || result.code === 1);
  const reopened = new StockService({ dbPath, production: true });
  assert.equal(reopened.all('stores').length, 1);
  assert.deepEqual(reopened.all('products'), []);
  reopened.close();
});
