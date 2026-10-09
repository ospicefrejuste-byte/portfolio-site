'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { StockService } = require('../lib/business');
const { createApp } = require('../server');

const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=', 'base64');

function imageForm(type = 'image/png', bytes = tinyPng) {
  const form = new FormData();
  form.append('images', new Blob([bytes], { type }), 'source.png');
  return form;
}

test('HTTP authentication, authorization, origin checks and authenticated image storage', async t => {
  const uploadDir = mkdtempSync(path.join(tmpdir(), 'stock-http-tests-'));
  const service = new StockService({ dbPath: ':memory:', production: false });
  const app = createApp({ service, uploadDir });
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    service.close();
    rmSync(uploadDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, options = {}) => fetch(`${base}${route}`, options);
  const jsonPost = (route, body, cookie, headers = {}) => request(route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: JSON.stringify(body)
  });
  async function expectError(response, status, code) {
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, code);
  }
  async function login(email, extra = {}) {
    const response = await jsonPost('/api/login', { email, password: 'Demo2026!', ...extra });
    assert.equal(response.status, 200);
    const setCookie = response.headers.get('set-cookie');
    assert.match(setCookie, /; HttpOnly(?:;|$)/i);
    assert.match(setCookie, /; SameSite=Strict(?:;|$)/i);
    assert.match(setCookie, /; Path=\/(?:;|$)/i);
    assert.doesNotMatch(setCookie, /; Secure(?:;|$)/i);
    const cookie = setCookie.split(';')[0];
    assert.match(cookie, /^stock_session=[a-f0-9]{64}$/);
    const body = await response.json();
    assert.ok(body.user.id);
    assert.equal(Object.hasOwn(body, 'token'), false);
    return { cookie, user: body.user, token: cookie.slice('stock_session='.length) };
  }
  let admin;
  let cashier;

  await t.test('public configuration and anonymous sessions do not expose protected state', async () => {
    const config = await request('/api/config');
    assert.equal(config.status, 200);
    assert.equal(config.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await config.json(), { demoMode: true, registrationEnabled:true });
    assert.deepEqual(await (await request('/api/session')).json(), { user: null });
    await expectError(await request('/api/state'), 401, 'UNAUTHORIZED');
    await expectError(await jsonPost('/api/commands', { id: randomUUID(), type: 'settings.update', payload: { noPrices: true, businessName: 'Interdit' } }), 401, 'UNAUTHORIZED');
  });

  await t.test('invalid credentials are rejected and successful login sets a protected session cookie', async () => {
    const failed = await jsonPost('/api/login', { email: 'admin@stock.local', password: 'incorrect' });
    assert.equal(failed.headers.get('set-cookie'), null);
    await expectError(failed, 401, 'INVALID_CREDENTIALS');
    admin = await login('admin@stock.local');
    cashier = await login('cashier@stock.local', { role: 'admin', user: { role: 'admin' } });
    assert.equal(cashier.user.role, 'cashier');
    assert.notEqual(admin.cookie, cashier.cookie);
    assert.notEqual(admin.user.id, cashier.user.id);
    assert.deepEqual(service.session(admin.token), admin.user);
    assert.deepEqual(service.session(cashier.token), cashier.user);
    const response = await request('/api/state', { headers: { Cookie: admin.cookie } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.id, admin.user.id);
  });

  await t.test('foreign origins cannot submit commands, uploads or log out a valid session', async () => {
    const initial = service.state(admin.user);
    const command = { id: randomUUID(), type: 'settings.update', payload: { noPrices: true, businessName: 'Commande étrangère' } };
    const foreign = { Origin: 'https://untrusted.invalid' };
    await expectError(await jsonPost('/api/commands', command, admin.cookie, foreign), 403, 'BAD_ORIGIN');
    await expectError(await jsonPost('/api/commands', command, admin.cookie, { 'Sec-Fetch-Site': 'cross-site' }), 403, 'BAD_ORIGIN');
    await expectError(await jsonPost('/api/logout', {}, admin.cookie, foreign), 403, 'BAD_ORIGIN');
    await expectError(await request('/upload', { method: 'POST', headers: { Cookie: admin.cookie, ...foreign }, body: imageForm() }), 403, 'BAD_ORIGIN');
    assert.deepEqual(service.state(admin.user), initial);
    assert.deepEqual(await (await request('/api/session', { headers: { Cookie: admin.cookie } })).json(), { user: admin.user });
    assert.deepEqual(readdirSync(uploadDir), []);
  });

  await t.test('cashier requests cannot override the authenticated role or upload images', async () => {
    const before = service.state(admin.user);
    const forgedCommand = {
      id: randomUUID(), type: 'document.create', user: { ...cashier.user, role: 'admin' },
      payload: { type: 'purchase', storeId: 'store-centre', contactId: 'supplier-sodico', lines: [{ productId: 'product-riz', quantity: 1 }], paid: 3200 }
    };
    await expectError(await jsonPost('/api/commands', forgedCommand, cashier.cookie), 403, 'FORBIDDEN');
    await expectError(await request('/upload', { method: 'POST', headers: { Cookie: cashier.cookie }, body: imageForm() }), 403, 'FORBIDDEN');
    assert.deepEqual(service.state(admin.user), before);
    assert.deepEqual(readdirSync(uploadDir), []);
    const saleResponse = await jsonPost('/api/commands', {
      id: randomUUID(), type: 'document.create', user: { id: admin.user.id, role: 'admin' },
      payload: { type: 'sale', storeId: 'store-centre', lines: [{ productId: 'product-riz', quantity: 1 }], paid: 4500 }
    }, cashier.cookie);
    assert.equal(saleResponse.status, 200);
    assert.deepEqual(await saleResponse.json(), { ok: true });
    assert.equal(service.state(admin.user).documents.at(-1).createdBy, cashier.user.id);
    const cashierState = await (await request('/api/state', { headers: { Cookie: cashier.cookie } })).json();
    assert.equal(cashierState.user.role, 'cashier');
    assert.ok(cashierState.products.every(product => !Object.hasOwn(product, 'purchasePrice')));
    assert.ok(cashierState.documents.every(document => document.type === 'sale' && document.lines.every(line => !Object.hasOwn(line, 'purchaseCost'))));
  });

  await t.test('invalid upload MIME and image signature are rejected before any file is written', async () => {
    await expectError(await request('/upload', { method: 'POST', headers: { Cookie: admin.cookie }, body: imageForm('text/plain', Buffer.from('not an image')) }), 400, 'INVALID_IMAGE');
    await expectError(await request('/upload', { method: 'POST', headers: { Cookie: admin.cookie }, body: imageForm('image/jpeg') }), 400, 'INVALID_IMAGE');
    await expectError(await request('/upload', { method: 'POST', headers: { Cookie: admin.cookie }, body: imageForm('image/png', Buffer.from('not a PNG')) }), 400, 'INVALID_IMAGE');
    const batch = imageForm();
    batch.append('images', new Blob([Buffer.from('bad signature')], { type: 'image/png' }), 'invalid.png');
    await expectError(await request('/upload', { method: 'POST', headers: { Cookie: admin.cookie }, body: batch }), 400, 'INVALID_IMAGE');
    assert.deepEqual(readdirSync(uploadDir), []);
  });

  await t.test('valid PNGs receive generated names and require authentication to retrieve the original bytes', async () => {
    const uploaded = await request('/upload', { method: 'POST', headers: { Cookie: admin.cookie }, body: imageForm() });
    assert.equal(uploaded.status, 200);
    const paths = await uploaded.json();
    assert.equal(paths.length, 1);
    assert.match(paths[0], /^\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/);
    assert.deepEqual(readdirSync(uploadDir), [path.basename(paths[0])]);
    await expectError(await request(paths[0]), 401, 'UNAUTHORIZED');
    const image = await request(paths[0], { headers: { Cookie: admin.cookie } });
    assert.equal(image.status, 200);
    assert.match(image.headers.get('content-type'), /^image\/png/);
    assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(image.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), tinyPng);
  });

  await t.test('logout revokes the server session even if an old cookie is replayed', async () => {
    const loggedOut = await jsonPost('/api/logout', {}, admin.cookie);
    assert.equal(loggedOut.status, 200);
    assert.deepEqual(await loggedOut.json(), { ok: true });
    assert.match(loggedOut.headers.get('set-cookie'), /^stock_session=;/);
    assert.equal(service.session(admin.token), null);
    assert.deepEqual(await (await request('/api/session', { headers: { Cookie: admin.cookie } })).json(), { user: null });
    await expectError(await request('/api/state', { headers: { Cookie: admin.cookie } }), 401, 'UNAUTHORIZED');
    assert.deepEqual(await (await request('/api/session', { headers: { Cookie: cashier.cookie } })).json(), { user: cashier.user });
    assert.deepEqual(service.session(cashier.token), cashier.user);
    assert.equal((await request('/api/state', { headers: { Cookie: cashier.cookie } })).status, 200);
  });
});
