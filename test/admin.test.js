'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, scryptSync } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { StockService, AppError } = require('../lib/business');

function fixture(t) {
  const password = randomUUID();
  const service = new StockService({ dbPath: ':memory:', production: true, adminEmail: 'owner@example.test', adminPassword: password });
  t.after(() => service.close());
  const owner = service.authenticate('owner@example.test', password);
  const run = (type, payload, user = owner.user, id = randomUUID()) => service.command(user, { id, type, payload });
  const create = (email, role = 'cashier', extra = {}) => {
    const userPassword = randomUUID();
    const user = service.createUser(owner.user, { email, name: email, role, password: userPassword, ...extra });
    return { user, password: userPassword };
  };
  return { service, owner, password, run, create };
}

function fails(code, operation, status) {
  assert.throws(operation, error => error instanceof AppError && error.code === code && (status == null || error.status === status));
}

function assertPublicUser(user, forbiddenSecret) {
  assert.ok(user.id);
  assert.ok(Object.keys(user).every(key => ['id', 'email', 'name', 'role', 'active', 'demo'].includes(key)));
  assert.equal(Object.hasOwn(user, 'password'), false);
  assert.equal(Object.hasOwn(user, 'passwordHash'), false);
  if (forbiddenSecret) assert.equal(JSON.stringify(user).includes(forbiddenSecret), false);
}

test('administrators create normalized unique users without exposing credentials and persisted roles reject forged actors', t => {
  const f = fixture(t);
  const password = randomUUID();
  const created = f.service.createUser(f.owner.user, { email: ' CASHIER@Example.Test ', name: 'Vendeur', role: 'cashier', password });
  assertPublicUser(created, password);
  assert.equal(created.email, 'cashier@example.test');
  assert.equal(created.role, 'cashier');
  const authenticated = f.service.authenticate('cashier@example.test', password);
  assert.equal(authenticated.user.id, created.id);
  const users = f.service.listUsers(f.owner.user);
  assert.equal(users.length, 2);
  users.forEach(user => assertPublicUser(user, password));
  assert.equal(users.find(user => user.id === created.id).active, true);
  assert.equal(users.find(user => user.id === created.id).demo, false);
  fails('DUPLICATE_EMAIL', () => f.service.createUser(f.owner.user, { email: 'Cashier@EXAMPLE.TEST', name: 'Doublon', role: 'inventory', password: randomUUID() }), 409);
  fails('DUPLICATE_EMAIL', () => f.service.updateUser(f.owner.user, created.id, { email: ' OWNER@EXAMPLE.TEST ' }), 409);
  fails('FORBIDDEN', () => f.service.listUsers(authenticated.user), 403);
  fails('FORBIDDEN', () => f.service.createUser({ ...authenticated.user, role: 'admin' }, { email: 'forged@example.test', name: 'Forgé', role: 'admin', password: randomUUID() }), 403);
  f.run('product.save', { id: 'private-cost', sku: 'PRIVATE-001', name: 'Article', purchasePrice: 100, sellingPrice: 200 });
  const forgedState = f.service.state({ ...authenticated.user, role: 'admin' });
  assert.equal(forgedState.user.role, 'cashier');
  assert.ok(forgedState.products.every(product => !Object.hasOwn(product, 'purchasePrice')));
  fails('FORBIDDEN', () => f.run('store.save', { name: 'Rôle forgé' }, { ...authenticated.user, role: 'admin' }), 403);
  fails('FORBIDDEN', () => f.service.updateUser(authenticated.user, f.owner.user.id, { active: false }), 403);
  fails('UNAUTHORIZED', () => f.service.listUsers(null), 401);
  assert.equal(f.service.listUsers(f.owner.user).length, 2);
});

test('invalid roles, active flags, emails and passwords leave user records and valid sessions unchanged', t => {
  const f = fixture(t);
  const worker = f.create('worker@example.test');
  f.service.createUser(f.owner.user, { email: 'minimum@example.test', name: 'Minimum', role: 'inventory', password: randomUUID().slice(0, 12) });
  f.service.createUser(f.owner.user, { email: 'maximum@example.test', name: 'Maximum', role: 'inventory', password: randomUUID().repeat(6).slice(0, 200), active: false });
  const login = f.service.authenticate(worker.user.email, worker.password);
  const before = f.service.listUsers(f.owner.user);
  const valid = { email: 'invalid@example.test', name: 'Invalid', role: 'cashier', password: randomUUID() };
  for (const patch of [
    { password: 'x'.repeat(11) }, { password: 'x'.repeat(201) }, { role: 'manager' },
    { active: 'true' }, { active: null }, { email: 'invalid-address' }
  ]) fails('INVALID_INPUT', () => f.service.createUser(f.owner.user, { ...valid, ...patch }), 400);
  for (const patch of [{ password: 'short' }, { password: 'x'.repeat(201) }, { role: 'manager' }, { role: null }, { active: 1 }, { active: null }, { email: 'invalid-address' }]) {
    fails('INVALID_INPUT', () => f.service.updateUser(f.owner.user, worker.user.id, patch), 400);
  }
  assert.deepEqual(f.service.listUsers(f.owner.user), before);
  assert.deepEqual(f.service.session(login.token), login.user);
});

test('role, email, password and activation changes revoke every affected session and enforce new credentials', t => {
  const f = fixture(t);
  const worker = f.create('worker@example.test');
  const first = f.service.authenticate(worker.user.email, worker.password);
  const second = f.service.authenticate(worker.user.email, worker.password);
  f.service.updateUser(f.owner.user, worker.user.id, { name: 'Agent renommé' });
  assert.equal(f.service.listUsers(f.owner.user).find(user => user.id === worker.user.id).name, 'Agent renommé');

  f.service.updateUser(f.owner.user, worker.user.id, { role: 'inventory' });
  assert.equal(f.service.session(first.token), null);
  assert.equal(f.service.session(second.token), null);
  const promoted = f.service.authenticate(worker.user.email, worker.password);
  assert.equal(promoted.user.role, 'inventory');
  f.service.updateUser(f.owner.user, worker.user.id, { email: ' UPDATED@EXAMPLE.TEST ' });
  assert.equal(f.service.session(promoted.token), null);
  fails('INVALID_CREDENTIALS', () => f.service.authenticate(worker.user.email, worker.password), 401);
  const renamed = f.service.authenticate('updated@example.test', worker.password);

  const resetPassword = randomUUID();
  const reset = f.service.updateUser(f.owner.user, worker.user.id, { password: resetPassword });
  assertPublicUser(reset, resetPassword);
  assert.equal(f.service.session(renamed.token), null);
  fails('INVALID_CREDENTIALS', () => f.service.authenticate('updated@example.test', worker.password), 401);
  const resetLogin = f.service.authenticate('updated@example.test', resetPassword);
  f.service.updateUser(f.owner.user, worker.user.id, { active: false });
  assert.equal(f.service.session(resetLogin.token), null);
  fails('INVALID_CREDENTIALS', () => f.service.authenticate('updated@example.test', resetPassword), 401);
  f.service.updateUser(f.owner.user, worker.user.id, { active: true });
  assert.equal(f.service.authenticate('updated@example.test', resetPassword).user.id, worker.user.id);
  assert.deepEqual(f.service.session(f.owner.token), f.owner.user);
});

test('the last active real administrator is protected, and a second administrator enables safe self-demotion', t => {
  const f = fixture(t);
  f.create('inactive-admin@example.test', 'admin', { active: false });
  fails('LAST_ADMIN', () => f.service.updateUser(f.owner.user, f.owner.user.id, { active: false }), 409);
  fails('LAST_ADMIN', () => f.service.updateUser(f.owner.user, f.owner.user.id, { role: 'cashier' }), 409);
  assert.deepEqual(f.service.session(f.owner.token), f.owner.user);
  const other = f.create('second-admin@example.test', 'admin');
  const otherLogin = f.service.authenticate(other.user.email, other.password);
  const demoted = f.service.updateUser(f.owner.user, f.owner.user.id, { role: 'cashier' });
  assert.equal(demoted.role, 'cashier');
  assert.equal(f.service.session(f.owner.token), null);
  fails('FORBIDDEN', () => f.service.listUsers(f.owner.user), 403);
  assert.equal(f.service.authenticate('owner@example.test', f.password).user.role, 'cashier');
  fails('LAST_ADMIN', () => f.service.updateUser(otherLogin.user, other.user.id, { role: 'inventory' }), 409);
  fails('LAST_ADMIN', () => f.service.updateUser(otherLogin.user, other.user.id, { active: false }), 409);
  assert.deepEqual(f.service.session(otherLogin.token), otherLogin.user);
});

test('new stores start with zero stock and optimistic renames preserve quantities and document history', t => {
  const f = fixture(t);
  for (const [id, sku] of [['p1', 'ART-001'], ['p2', 'ART-002']]) f.run('product.save', { id, sku, name: id, purchasePrice: 100, sellingPrice: 200 });
  const source = f.service.state(f.owner.user).stores[0];
  f.run('document.create', { type: 'purchase', storeId: source.id, lines: [{ productId: 'p1', quantity: 2.125 }], paid: 213 });
  const before = f.service.state(f.owner.user);
  const newStore = { id: 'store-new', name: 'Boutique du marché', city: 'Cotonou', expectedVersion: 0 };
  const createId = randomUUID();
  f.run('store.save', newStore, f.owner.user, createId);
  assert.deepEqual(f.run('store.save', newStore, f.owner.user, createId), { ok: true, duplicate: true });
  const added = f.service.state(f.owner.user).stores.find(store => store.id === newStore.id);
  assert.equal(added.version, 1);
  const newStocks = f.service.state(f.owner.user).stocks.filter(stock => stock.storeId === added.id);
  assert.equal(newStocks.length, 2);
  assert.ok(newStocks.every(stock => stock.quantity === 0));
  const renameId = randomUUID();
  f.run('store.save', { id: source.id, name: 'Magasin renommé', city: 'Porto-Novo', expectedVersion: source.version }, f.owner.user, renameId);
  const renamed = f.service.state(f.owner.user);
  assert.equal(renamed.stores.find(store => store.id === source.id).version, source.version + 1);
  assert.deepEqual(renamed.stocks.filter(stock => stock.storeId === source.id), before.stocks.filter(stock => stock.storeId === source.id));
  assert.deepEqual(renamed.documents, before.documents);
  const retryId = randomUUID();
  fails('VERSION_CONFLICT', () => f.run('store.save', { id: source.id, name: 'Édition périmée', expectedVersion: source.version }, f.owner.user, retryId), 409);
  assert.deepEqual(f.service.state(f.owner.user), renamed);
  f.run('store.save', { id: source.id, name: 'Nom final', expectedVersion: source.version + 1 }, f.owner.user, retryId);
  assert.equal(f.service.state(f.owner.user).stores.find(store => store.id === source.id).name, 'Nom final');
  const cashier = f.create('cashier@example.test');
  fails('FORBIDDEN', () => f.run('store.save', { name: 'Interdit' }, cashier.user), 403);
});

test('legacy databases migrate active users and unversioned stores without resetting existing records', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'stock-admin-migration-'));
  const dbPath = path.join(dir, 'legacy.sqlite');
  const password = randomUUID();
  const salt = randomBytes(16).toString('hex');
  const hash = `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, password TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE stores (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE settings (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
  legacy.prepare('INSERT INTO users(id,email,name,role,password,demo) VALUES(?,?,?,?,?,?)').run('legacy-admin', 'legacy@example.test', 'Propriétaire existant', 'admin', hash, 0);
  legacy.prepare('INSERT INTO users(id,email,name,role,password,demo) VALUES(?,?,?,?,?,?)').run('legacy-demo-admin', 'demo@example.test', 'Administrateur démo', 'admin', hash, 1);
  legacy.prepare('INSERT INTO stores(id,data) VALUES(?,?)').run('legacy-store', JSON.stringify({ id: 'legacy-store', name: 'Ancienne boutique', city: 'Cotonou' }));
  legacy.prepare('INSERT INTO settings(id,data) VALUES(?,?)').run('main', JSON.stringify({ id: 'main', currency: 'XOF', noPrices: true, businessName: 'Commerce existant' }));
  legacy.close();
  const service = new StockService({ dbPath, production: true });
  t.after(() => { service.close(); rmSync(dir, { recursive: true, force: true }); });
  const login = service.authenticate('legacy@example.test', password);
  assert.equal(login.user.id, 'legacy-admin');
  assert.equal(service.listUsers(login.user).find(user => user.id === login.user.id).active, true);
  assert.equal(service.listUsers(login.user).length, 2);
  fails('INVALID_CREDENTIALS', () => service.authenticate('demo@example.test', password), 401);
  const migratedStore = service.state(login.user).stores[0];
  assert.equal(migratedStore.version, 1);
  assert.equal(migratedStore.name, 'Ancienne boutique');
  assert.equal(service.state(login.user).settings.businessName, 'Commerce existant');
  service.command(login.user, { id: randomUUID(), type: 'store.save', payload: { id: migratedStore.id, name: 'Boutique migrée', city: migratedStore.city, expectedVersion: 1 } });
  assert.equal(service.state(login.user).stores[0].version, 2);
  fails('LAST_ADMIN', () => service.updateUser(login.user, login.user.id, { active: false }), 409);
});
