'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, rmSync, readdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { StockService } = require('../lib/business');
const { createApp } = require('../server');
const { verifyBackup } = require('../lib/backups');

test('production administrator HTTP routes protect accounts, credentials and sessions', async t => {
  const adminPassword = randomUUID();
  const service = new StockService({ dbPath: ':memory:', production: true, adminEmail: 'owner@example.test', adminPassword });
  const uploadDir = mkdtempSync(path.join(tmpdir(), 'stock-http-admin-'));
  const app = createApp({ service, uploadDir });
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    service.close(); rmSync(uploadDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, options = {}) => fetch(`${base}${route}`, options);
  const write = (method, route, body, cookie, headers = {}) => request(route, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: JSON.stringify(body) });
  async function error(response, status, code) {
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, code);
  }
  async function login(email, password) {
    const response = await write('POST', '/api/login', { email, password });
    assert.equal(response.status, 200);
    const setCookie = response.headers.get('set-cookie');
    assert.match(setCookie, /; HttpOnly(?:;|$)/i);
    assert.match(setCookie, /; SameSite=Strict(?:;|$)/i);
    assert.match(setCookie, /; Secure(?:;|$)/i);
    return { cookie: setCookie.split(';')[0], user: (await response.json()).user };
  }
  const admin = await login('owner@example.test', adminPassword);
  let cashier;
  let cashierLogin;
  const cashierPassword = randomUUID();

  await t.test('anonymous requests and foreign origins cannot administer users', async () => {
    await error(await request('/api/admin/users'), 401, 'UNAUTHORIZED');
    await error(await write('POST', '/api/admin/users', { email: 'anonymous@example.test', name: 'Anonymous', role: 'admin', password: randomUUID() }), 401, 'UNAUTHORIZED');
    const foreign = { Origin: 'https://untrusted.invalid' };
    await error(await write('POST', '/api/admin/users', { email: 'foreign@example.test', name: 'Foreign', role: 'admin', password: randomUUID() }, admin.cookie, foreign), 403, 'BAD_ORIGIN');
    await error(await write('PATCH', `/api/admin/users/${admin.user.id}`, { name: 'Foreign change' }, admin.cookie, foreign), 403, 'BAD_ORIGIN');
    const listed = await request('/api/admin/users', { headers: { Cookie: admin.cookie } });
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).users.length, 1);
  });

  await t.test('administrators create real users and list metadata without secrets or password hashes', async () => {
    const created = await write('POST', '/api/admin/users', { email: ' CASHIER@EXAMPLE.TEST ', name: 'Vendeur réel', role: 'cashier', password: cashierPassword }, admin.cookie);
    assert.equal(created.status, 201);
    const body = await created.json();
    cashier = body.user;
    assert.equal(cashier.email, 'cashier@example.test');
    assert.equal(cashier.role, 'cashier');
    assert.equal(Object.hasOwn(cashier, 'password'), false);
    assert.equal(JSON.stringify(body).includes(cashierPassword), false);
    cashierLogin = await login(cashier.email, cashierPassword);
    const listed = await request('/api/admin/users', { headers: { Cookie: admin.cookie } });
    assert.equal(listed.headers.get('cache-control'), 'no-store');
    const users = (await listed.json()).users;
    assert.equal(users.length, 2);
    assert.ok(users.every(user => typeof user.active === 'boolean' && user.demo === false && !Object.hasOwn(user, 'password') && !Object.hasOwn(user, 'passwordHash')));
    await error(await write('POST', '/api/admin/users', { email: 'Cashier@example.test', name: 'Doublon', role: 'inventory', password: randomUUID() }, admin.cookie), 409, 'DUPLICATE_EMAIL');
  });

  await t.test('cashiers cannot forge an administrator role to list, create or patch accounts', async () => {
    await error(await request('/api/admin/users', { headers: { Cookie: cashierLogin.cookie } }), 403, 'FORBIDDEN');
    await error(await write('POST', '/api/admin/users', { user: { role: 'admin' }, email: 'forged@example.test', name: 'Forgé', role: 'admin', password: randomUUID() }, cashierLogin.cookie), 403, 'FORBIDDEN');
    await error(await write('PATCH', `/api/admin/users/${cashier.id}`, { user: { role: 'admin' }, role: 'admin' }, cashierLogin.cookie), 403, 'FORBIDDEN');
    const session = await request('/api/session', { headers: { Cookie: cashierLogin.cookie } });
    assert.equal((await session.json()).user.role, 'cashier');
  });

  await t.test('role, password and activity changes invalidate old cookies and require valid current credentials', async () => {
    let updated = await write('PATCH', `/api/admin/users/${cashier.id}`, { role: 'inventory' }, admin.cookie);
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).user.role, 'inventory');
    await error(await request('/api/state', { headers: { Cookie: cashierLogin.cookie } }), 401, 'UNAUTHORIZED');
    const inventoryLogin = await login(cashier.email, cashierPassword);
    const resetPassword = randomUUID();
    updated = await write('PATCH', `/api/admin/users/${cashier.id}`, { password: resetPassword }, admin.cookie);
    assert.equal(updated.status, 200);
    assert.equal(JSON.stringify(await updated.json()).includes(resetPassword), false);
    await error(await request('/api/state', { headers: { Cookie: inventoryLogin.cookie } }), 401, 'UNAUTHORIZED');
    await error(await write('POST', '/api/login', { email: cashier.email, password: cashierPassword }), 401, 'INVALID_CREDENTIALS');
    const resetLogin = await login(cashier.email, resetPassword);
    updated = await write('PATCH', `/api/admin/users/${cashier.id}`, { active: false }, admin.cookie);
    assert.equal(updated.status, 200);
    await updated.json();
    await error(await request('/api/state', { headers: { Cookie: resetLogin.cookie } }), 401, 'UNAUTHORIZED');
    await error(await write('POST', '/api/login', { email: cashier.email, password: resetPassword }), 401, 'INVALID_CREDENTIALS');
    const session = await request('/api/session', { headers: { Cookie: admin.cookie } });
    assert.equal((await session.json()).user.id, admin.user.id);
  });

  await t.test('last-administrator protection is atomic, while a second active admin permits self-demotion', async () => {
    await error(await write('PATCH', `/api/admin/users/${admin.user.id}`, { active: false }, admin.cookie), 409, 'LAST_ADMIN');
    await error(await write('PATCH', `/api/admin/users/${admin.user.id}`, { role: 'cashier' }, admin.cookie), 409, 'LAST_ADMIN');
    const secondPassword = randomUUID();
    const created = await write('POST', '/api/admin/users', { email: 'second@example.test', name: 'Second administrateur', role: 'admin', password: secondPassword }, admin.cookie);
    assert.equal(created.status, 201);
    await created.json();
    const second = await login('second@example.test', secondPassword);
    const demoted = await write('PATCH', `/api/admin/users/${admin.user.id}`, { role: 'cashier' }, admin.cookie);
    assert.equal(demoted.status, 200);
    assert.equal((await demoted.json()).user.role, 'cashier');
    await error(await request('/api/admin/users', { headers: { Cookie: admin.cookie } }), 401, 'UNAUTHORIZED');
    const ownerAsCashier = await login('owner@example.test', adminPassword);
    await error(await request('/api/admin/users', { headers: { Cookie: ownerAsCashier.cookie } }), 403, 'FORBIDDEN');
    const listed = await request('/api/admin/users', { headers: { Cookie: second.cookie } });
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).users.filter(user => user.role === 'admin' && user.active).length, 1);
  });
});

test('server backup configuration persists coherent snapshots, honors retention and rejects invalid intervals', async t => {
  const keys = ['STOCK_BACKUP_DIR', 'STOCK_BACKUP_INTERVAL_HOURS', 'STOCK_BACKUP_RETENTION'];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const directory = mkdtempSync(path.join(tmpdir(), 'stock-admin-backup-'));
  const service = new StockService({ dbPath: path.join(directory, 'data', 'stock.sqlite'), production: true, adminEmail: 'owner@example.test', adminPassword: randomUUID() });
  let app;
  t.after(async () => {
    await app?.locals.backupScheduler?.stop();
    service.close(); rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.STOCK_BACKUP_DIR = path.join(directory, 'backups');
  process.env.STOCK_BACKUP_INTERVAL_HOURS = '1';
  process.env.STOCK_BACKUP_RETENTION = '2';
  app = createApp({ service, uploadDir: path.join(directory, 'uploads') });
  assert.equal(app.locals.dbPath, service.dbPath);
  assert.ok(app.locals.backupScheduler);
  await app.locals.backupScheduler.run();
  await app.locals.backupScheduler.run();
  await app.locals.backupScheduler.run();
  await app.locals.backupScheduler.stop();
  const names = readdirSync(process.env.STOCK_BACKUP_DIR);
  assert.equal(names.length, 2);
  for (const name of names) {
    const snapshot = await verifyBackup(path.join(process.env.STOCK_BACKUP_DIR, name));
    assert.equal(snapshot.manifest.format, 'comptoir-backup');
    assert.equal(snapshot.manifest.sessionsPolicy, 'revoked-on-restore');
  }
  process.env.STOCK_BACKUP_INTERVAL_HOURS = 'invalid';
  assert.throws(() => createApp({ service, uploadDir: app.locals.uploadDir }), /Intervalle de sauvegarde invalide/);
  assert.equal(service.all('stores').length, 1);
});
