'use strict';

// These checks are deliberately kept separate from the business workflow tests.
// They protect the trust boundary that a public self-registration flow will use:
// the browser must receive only a public user, cookies must remain server-side,
// and a public endpoint must not weaken the existing origin/rate-limit rules.

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { StockService } = require('../lib/business');
const { createApp } = require('../server');

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

function stop(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    // A test must never retain a keep-alive connection after its service closes.
    server.closeAllConnections?.();
  });
}

async function json(response) {
  return response.json();
}

test('production login returns a public identity while keeping bearer material server-side', async t => {
  const password = `registration-${randomUUID()}`;
  const service = new StockService({ dbPath: ':memory:', production: true, adminEmail: 'owner@example.test', adminPassword: password });
  const app = createApp({ service });
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await stop(server); service.close(); });

  const response = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ' OWNER@EXAMPLE.TEST ', password })
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /^stock_session=[a-f0-9]{64};/);
  assert.match(setCookie, /; HttpOnly(?:;|$)/i);
  assert.match(setCookie, /; SameSite=Strict(?:;|$)/i);
  assert.match(setCookie, /; Secure(?:;|$)/i);
  assert.doesNotMatch(setCookie, /registration-/);
  const body = await json(response);
  assert.deepEqual(Object.keys(body), ['user']);
  assert.deepEqual(Object.keys(body.user).sort(), ['email', 'id', 'name', 'role']);
  assert.doesNotMatch(JSON.stringify(body), /registration-|password|token/i);

  const token = setCookie.match(/^stock_session=([^;]+)/)[1];
  assert.equal(service.db.prepare('SELECT token FROM sessions WHERE token=?').get(token), undefined);
  assert.ok(service.db.prepare('SELECT token FROM sessions WHERE token=?').get(createHash('sha256').update(token).digest('hex')));

  const state = await fetch(`${base}/api/state`, { headers: { Cookie: `stock_session=${token}` } });
  assert.equal(state.status, 200);
  assert.deepEqual((await json(state)).user, body.user);
});

test('state-changing requests reject cross-site origins even with a valid session', async t => {
  const password = `csrf-${randomUUID()}`;
  const service = new StockService({ dbPath: ':memory:', production: true, adminEmail: 'owner@example.test', adminPassword: password });
  const app = createApp({ service });
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await stop(server); service.close(); });

  const loggedIn = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test', password })
  });
  const cookie = loggedIn.headers.get('set-cookie').split(';')[0];
  const command = { id: randomUUID(), type: 'settings.update', payload: { businessName: 'cross-site' } };

  for (const headers of [{ Origin: 'https://attacker.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const response = await fetch(`${base}/api/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers },
      body: JSON.stringify(command)
    });
    assert.equal(response.status, 403);
    assert.equal((await json(response)).code, 'BAD_ORIGIN');
  }
  assert.equal(service.state(service.authenticate('owner@example.test', password).user).settings.businessName, 'Comptoir');
});

test('login brute-force limiter stops repeated failures before a session is issued', async t => {
  const password = `limit-${randomUUID()}`;
  const service = new StockService({ dbPath: ':memory:', production: true, adminEmail: 'owner@example.test', adminPassword: password });
  const app = createApp({ service });
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await stop(server); service.close(); });

  const attempt = () => fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test', password: 'wrong-password' })
  });
  for (let index = 0; index < 20; index += 1) {
    const response = await attempt();
    assert.equal(response.status, 401);
    assert.equal((await json(response)).code, 'INVALID_CREDENTIALS');
    assert.equal(response.headers.get('set-cookie'), null);
  }
  const blocked = await attempt();
  assert.equal(blocked.status, 429);
  assert.equal((await json(blocked)).code, 'RATE_LIMITED');
  const legitimate = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test', password })
  });
  assert.equal(legitimate.status, 429);
  assert.equal(legitimate.headers.get('set-cookie'), null);
});

// Registration expiry, consumption, attempt limits and tenant access are
// exercised through the real HTTP endpoints in registration.test.js.
