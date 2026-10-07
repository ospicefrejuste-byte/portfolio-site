'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { StockService } = require('../lib/business');

function fixture(t) {
  const service = new StockService({ dbPath: ':memory:', production: false });
  t.after(() => service.close());
  const login = role => service.authenticate(`${role}@stock.local`, 'Demo2026!');
  const admin = login('admin').user;
  const run = (type, payload, user = admin, id = randomUUID()) => service.command(user, { id, type, payload });
  const state = (user = admin) => service.state(user);
  const stock = (productId, storeId = 'store-centre') => state().stocks.find(row => row.productId === productId && row.storeId === storeId);
  return { service, admin, login, run, state, stock };
}

function fails(code, fn, status) {
  assert.throws(fn, error => error.code === code && (status == null || error.status === status));
}

function sale(productId = 'product-riz', quantity = 1, unitPrice = 4500) {
  return { type: 'sale', storeId: 'store-centre', lines: [{ productId, quantity, unitPrice }], paid: Math.round(quantity * unitPrice) };
}

test('replayed commands are idempotent, while reused IDs with different payloads or actors conflict', t => {
  const f = fixture(t);
  const id = randomUUID();
  const before = f.state();
  const initialQuantity = f.stock('product-riz').quantity;
  const payload = sale();

  assert.deepEqual(f.run('document.create', payload, f.admin, id), { ok: true });
  const reordered = { paid: payload.paid, lines: payload.lines, storeId: payload.storeId, type: payload.type };
  assert.deepEqual(f.run('document.create', reordered, f.admin, id), { ok: true, duplicate: true });
  assert.equal(f.stock('product-riz').quantity, initialQuantity - 1);
  assert.equal(f.state().documents.length, before.documents.length + 1);

  fails('IDEMPOTENCY_CONFLICT', () => f.run('document.create', sale('product-riz', 2), f.admin, id), 409);
  fails('IDEMPOTENCY_CONFLICT', () => f.run('document.create', payload, f.login('cashier').user, id), 409);
  assert.equal(f.stock('product-riz').quantity, initialQuantity - 1);
});

test('cashiers and inventory agents receive only authorized financial data and cannot perform administrator commands', t => {
  const f = fixture(t);
  const cashier = f.login('cashier').user;
  const inventory = f.login('inventory').user;
  const cashState = f.state(cashier);
  const countState = f.state(inventory);

  assert.ok(cashState.products.length > 0);
  assert.ok(cashState.documents.length > 0);
  assert.ok(cashState.products.every(product => !Object.hasOwn(product, 'purchasePrice') && Object.hasOwn(product, 'sellingPrice')));
  assert.ok(cashState.documents.every(doc => doc.type === 'sale' && doc.lines.every(line => !Object.hasOwn(line, 'purchaseCost'))));
  assert.ok(cashState.contacts.every(contact => contact.type === 'customer'));
  assert.deepEqual(cashState.expenses, []);
  assert.deepEqual(cashState.inventories, []);
  assert.ok(countState.products.every(product => !Object.hasOwn(product, 'purchasePrice') && !Object.hasOwn(product, 'sellingPrice')));
  assert.deepEqual(countState.documents, []);
  assert.deepEqual(countState.expenses, []);
  assert.deepEqual(countState.contacts, []);

  for (const [type, payload] of [
    ['product.save', { name: 'Interdit' }],
    ['document.create', { type: 'purchase' }],
    ['document.create', { type: 'transfer' }],
    ['inventory.create', { storeId: 'store-centre', name: 'Interdit' }],
    ['settings.update', { noPrices: true, businessName: 'Interdit' }],
    ['expense.create', { amount: 1 }]
  ]) fails('FORBIDDEN', () => f.run(type, payload, cashier), 403);
  fails('FORBIDDEN', () => f.run('document.create', sale(), inventory), 403);
  fails('FORBIDDEN', () => f.run('inventory.validate', { inventoryId: 'any' }, inventory), 403);
  fails('UNAUTHORIZED', () => f.service.state(null), 401);
  fails('UNAUTHORIZED', () => f.run('document.create', sale(), null), 401);

  f.run('document.create', sale(), cashier);
  const createdSale = f.state().documents.at(-1);
  assert.equal(createdSale.createdBy, cashier.id);
  f.run('inventory.create', { storeId: 'store-centre', name: 'Comptage agent', category: 'Boissons / Eaux' }, inventory);
  const createdInventory = f.state().inventories.at(-1);
  f.run('inventory.count', { inventoryId: createdInventory.id, counts: [{ productId: 'product-eau', quantity: 12 }] }, inventory);
  assert.equal(f.state(inventory).inventories.at(-1).lines[0].counted, 12);
});

test('an insufficient second line rolls back the first line, document and command ID', t => {
  const f = fixture(t);
  const initial = f.state();
  const id = randomUUID();
  const input = {
    type: 'sale', storeId: 'store-centre', contactId: 'customer-awa', paid: 0,
    lines: [
      { productId: 'product-eau', quantity: 1 },
      { productId: 'product-riz', quantity: f.stock('product-riz').quantity + 1 }
    ]
  };

  fails('INSUFFICIENT_STOCK', () => f.run('document.create', input, f.admin, id), 409);
  assert.deepEqual(f.state().stocks, initial.stocks);
  assert.deepEqual(f.state().documents, initial.documents);
  assert.equal(f.service.db.prepare('SELECT id FROM commands WHERE id=?').get(id), undefined);
  assert.deepEqual(f.run('document.create', sale('product-eau', 1, 400), f.admin, id), { ok: true });
});

test('transfers conserve stock across stores with exact three-decimal quantities', t => {
  const f = fixture(t);
  const productId = 'product-farine';
  const beforeSource = f.stock(productId);
  const beforeDestination = f.stock(productId, 'store-nord');
  const beforeAll = f.state().stocks.filter(row => row.productId === productId).reduce((sum, row) => sum + row.quantity * 1000, 0);

  f.run('document.create', {
    type: 'transfer', storeId: 'store-centre', toStoreId: 'store-nord',
    lines: [{ productId, quantity: 1.125 }]
  });
  assert.equal(f.stock(productId).quantity, beforeSource.quantity - 1.125);
  assert.equal(f.stock(productId, 'store-nord').quantity, beforeDestination.quantity + 1.125);
  assert.equal(f.stock(productId).version, beforeSource.version + 1);
  assert.equal(f.stock(productId, 'store-nord').version, beforeDestination.version + 1);
  const afterAll = f.state().stocks.filter(row => row.productId === productId).reduce((sum, row) => sum + row.quantity * 1000, 0);
  assert.equal(afterAll, beforeAll);
  const beforeInvalid = f.state();
  fails('INVALID_INPUT', () => f.run('document.create', { type: 'transfer', storeId: 'store-centre', toStoreId: 'store-nord', lines: [{ productId, quantity: 0.0001 }] }));
  fails('INVALID_INPUT', () => f.run('document.create', { type: 'transfer', storeId: 'store-centre', toStoreId: 'store-centre', lines: [{ productId, quantity: 1 }] }));
  assert.deepEqual(f.state(), beforeInvalid);
});

test('partial payments accumulate once, reject overpayment and preserve stock on rejected document creation', t => {
  const f = fixture(t);
  const initial = f.state();
  fails('OVERPAYMENT', () => f.run('document.create', { ...sale(), paid: 4501 }));
  fails('CONTACT_REQUIRED', () => f.run('document.create', { ...sale(), paid: 2000 }));
  assert.deepEqual(f.state().stocks, initial.stocks);
  assert.deepEqual(f.state().documents, initial.documents);

  f.run('document.create', { ...sale(), contactId: 'customer-awa', paid: 1500 });
  const doc = f.state().documents.at(-1);
  assert.equal(doc.total, 4500);
  assert.equal(doc.paid, 1500);
  fails('OVERPAYMENT', () => f.run('payment.create', { documentId: doc.id, amount: 3001 }));
  assert.deepEqual(f.state().documents.at(-1), doc);
  const cashier = f.login('cashier').user;
  const id = randomUUID();
  const payment = { documentId: doc.id, amount: 3000 };
  f.run('payment.create', payment, cashier, id);
  f.run('payment.create', payment, cashier, id);
  const paid = f.state().documents.at(-1);
  assert.equal(paid.paid, 4500);
  assert.equal(paid.payments.length, 2);
  assert.equal(paid.payments[1].createdBy, cashier.id);
  fails('OVERPAYMENT', () => f.run('payment.create', { documentId: doc.id, amount: 1 }));

  const purchase = f.state().documents.find(document => document.type === 'purchase');
  fails('FORBIDDEN', () => f.run('payment.create', { documentId: purchase.id, amount: 1 }, cashier), 403);
});

test('inventory validation detects a sale after its stock snapshot without overwriting the sale', t => {
  const f = fixture(t);
  f.run('inventory.create', { storeId: 'store-centre', name: 'Épicerie du matin', category: 'Épicerie / Céréales' });
  const session = f.state().inventories.at(-1);
  f.run('inventory.count', { inventoryId: session.id, counts: session.lines.map(line => ({ productId: line.productId, quantity: line.theoretical })) });
  f.run('document.create', sale());
  const beforeValidation = f.state();
  fails('INVENTORY_CONFLICT', () => f.run('inventory.validate', { inventoryId: session.id }), 409);
  assert.deepEqual(f.state().stocks, beforeValidation.stocks);
  assert.deepEqual(f.state().documents, beforeValidation.documents);
  assert.equal(f.state().inventories.at(-1).status, 'draft');
});

test('validated counts update quantities and create one signed adjustment ledger document', t => {
  const f = fixture(t);
  f.run('inventory.create', { storeId: 'store-centre', name: 'Comptage céréales', category: 'Épicerie / Céréales' });
  const session = f.state().inventories.at(-1);
  const beforeStocks = f.state().stocks;
  const beforeDocuments = f.state().documents.length;
  const counts = session.lines.map(line => ({
    productId: line.productId,
    quantity: line.theoretical + (line.productId === 'product-riz' ? 2 : line.productId === 'product-farine' ? -0.125 : 0)
  }));
  fails('INVENTORY_INCOMPLETE', () => f.run('inventory.validate', { inventoryId: session.id }));
  assert.deepEqual(f.state().stocks, beforeStocks);
  f.run('inventory.count', { inventoryId: session.id, counts });
  const id = randomUUID();
  f.run('inventory.validate', { inventoryId: session.id }, f.admin, id);
  assert.deepEqual(f.run('inventory.validate', { inventoryId: session.id }, f.admin, id), { ok: true, duplicate: true });

  const final = f.state();
  const validated = final.inventories.at(-1);
  assert.equal(validated.status, 'validated');
  assert.equal(validated.validatedBy, f.admin.id);
  assert.equal(final.documents.length, beforeDocuments + 1);
  const adjustment = final.documents.find(doc => doc.id === validated.documentId);
  assert.equal(adjustment.type, 'adjustment');
  assert.equal(adjustment.inventoryId, session.id);
  assert.equal(adjustment.total, 0);
  assert.deepEqual(adjustment.lines.map(line => [line.productId, line.quantity]), [['product-riz', 2], ['product-farine', -0.125]]);
  for (const count of counts) assert.equal(f.stock(count.productId).quantity, count.quantity);
  for (const stock of beforeStocks.filter(row => row.storeId !== 'store-centre')) assert.deepEqual(f.stock(stock.productId, stock.storeId), stock);
  fails('INVENTORY_CLOSED', () => f.run('inventory.validate', { inventoryId: session.id }), 409);
  fails('INVENTORY_CLOSED', () => f.run('inventory.count', { inventoryId: session.id, counts }), 409);
});

test('product uniqueness and optimistic versions protect edits; new stock is introduced through purchase documents', t => {
  const f = fixture(t);
  const initial = f.state().products.find(product => product.id === 'product-riz');
  fails('DUPLICATE_SKU', () => f.run('product.save', { name: 'Doublon', sku: initial.sku.toLowerCase() }), 409);
  fails('VERSION_CONFLICT', () => f.run('product.save', { ...initial, expectedVersion: initial.version - 1, name: 'Périmé' }), 409);
  assert.deepEqual(f.state().products.find(product => product.id === initial.id), initial);
  f.run('product.save', { ...initial, expectedVersion: initial.version, name: 'Riz parfumé sélection' });
  const edited = f.state().products.find(product => product.id === initial.id);
  assert.equal(edited.version, initial.version + 1);
  assert.equal(edited.name, 'Riz parfumé sélection');
  fails('VERSION_CONFLICT', () => f.run('product.save', { ...initial, expectedVersion: initial.version }), 409);

  f.run('product.save', { id: 'test-product', sku: 'NEW-001', name: 'Haricots', purchasePrice: 350, sellingPrice: 500, unit: 'kg', minStock: 0.5, quantity: 100 });
  const newStocks = f.state().stocks.filter(stock => stock.productId === 'test-product');
  assert.equal(newStocks.length, f.state().stores.length);
  assert.ok(newStocks.every(stock => stock.quantity === 0));
  f.run('document.create', { type: 'purchase', storeId: 'store-centre', contactId: 'supplier-sodico', lines: [{ productId: 'test-product', quantity: 2.5 }], paid: 875 });
  assert.equal(f.stock('test-product').quantity, 2.5);
  assert.equal(f.state().documents.at(-1).total, 875);
});

test('units stay fixed when positive stock, historical movements or count sessions reference a product', t => {
  const f = fixture(t);
  const product = id => f.state().products.find(item => item.id === id);
  const changeUnit = (id, unit) => {
    const current = product(id);
    return f.run('product.save', { ...current, unit, expectedVersion: current.version });
  };
  const create = (id, category = '') => f.run('product.save', { id, name: id, sku: id, category, unit: 'pièce', purchasePrice: 100, sellingPrice: 150 });

  // This seeded article has stock but has never appeared in a document or count.
  const stocked = product('product-lait');
  assert.ok(f.state().stocks.some(row => row.productId === stocked.id && row.quantity > 0));
  assert.ok(f.state().documents.every(doc => doc.lines.every(line => line.productId !== stocked.id)));
  fails('UNIT_IN_USE', () => changeUnit(stocked.id, 'carton'), 409);
  assert.deepEqual(product(stocked.id), stocked);
  f.run('product.save', { ...stocked, name: 'Lait en poudre renommé', expectedVersion: stocked.version });
  assert.equal(product(stocked.id).name, 'Lait en poudre renommé');
  assert.equal(product(stocked.id).unit, stocked.unit);

  // Historical quantities remain meaningful even after every store reaches zero.
  create('test-unit-history');
  f.run('document.create', { type: 'purchase', storeId: 'store-centre', lines: [{ productId: 'test-unit-history', quantity: 1 }], paid: 100 });
  f.run('document.create', { type: 'sale', storeId: 'store-centre', lines: [{ productId: 'test-unit-history', quantity: 1 }], paid: 150 });
  assert.ok(f.state().stocks.filter(row => row.productId === 'test-unit-history').every(row => row.quantity === 0));
  const historical = product('test-unit-history');
  fails('UNIT_IN_USE', () => changeUnit(historical.id, 'kg'), 409);
  assert.deepEqual(product(historical.id), historical);

  // An unvalidated snapshot protects its unit without requiring stock or history.
  create('test-unit-counted', 'Tests / Comptage');
  f.run('inventory.create', { storeId: 'store-centre', category: 'Tests / Comptage', name: 'Unité du comptage' });
  const counted = product('test-unit-counted');
  assert.ok(f.state().stocks.filter(row => row.productId === counted.id).every(row => row.quantity === 0));
  assert.ok(f.state().documents.every(doc => doc.lines.every(line => line.productId !== counted.id)));
  fails('UNIT_IN_USE', () => changeUnit(counted.id, 'litre'), 409);
  assert.deepEqual(product(counted.id), counted);

  create('test-unit-unused');
  changeUnit('test-unit-unused', 'kg');
  assert.equal(product('test-unit-unused').unit, 'kg');
  assert.equal(product('test-unit-unused').version, 2);
});

test('document references lock a contact type while other details and unused types remain editable', t => {
  const f = fixture(t);
  const contact = id => f.state().contacts.find(item => item.id === id);
  for (const [id, type] of [['customer-awa', 'supplier'], ['supplier-sodico', 'customer']]) {
    const current = contact(id);
    fails('CONTACT_TYPE_IN_USE', () => f.run('contact.save', { ...current, type }), 409);
    assert.deepEqual(contact(id), current);
    f.run('contact.save', { ...current, name: `${current.name} actualisé`, phone: '+225 00 00 00 00 00' });
    assert.equal(contact(id).type, current.type);
    assert.equal(contact(id).phone, '+225 00 00 00 00 00');
  }
  f.run('contact.save', { id: 'test-unused-contact', type: 'customer', name: 'Nouveau tiers' });
  f.run('contact.save', { ...contact('test-unused-contact'), type: 'supplier' });
  assert.equal(contact('test-unused-contact').type, 'supplier');
  f.run('document.create', { type: 'purchase', storeId: 'store-centre', contactId: 'test-unused-contact', lines: [{ productId: 'product-riz', quantity: 1 }], paid: 0 });
  const supplier = contact('test-unused-contact');
  fails('CONTACT_TYPE_IN_USE', () => f.run('contact.save', { ...supplier, type: 'customer' }), 409);
  assert.deepEqual(contact(supplier.id), supplier);
  assert.equal(f.state().documents.at(-1).contactId, supplier.id);
});

test('no-prices display mode preserves master sale prices, payments and stock movements', t => {
  const f = fixture(t);
  const current = f.state().products.find(product => product.id === 'product-riz');
  const beforeStock = f.stock(current.id);
  f.run('settings.update', { noPrices: true, businessName: 'Comptage sans prix' });
  f.run('document.create', {
    type: 'sale', storeId: 'store-centre', contactId: 'customer-awa',
    lines: [{ productId: current.id, quantity: 2 }], paid: 1000
  });
  const doc = f.state().documents.at(-1);
  assert.equal(f.state().settings.noPrices, true);
  assert.equal(doc.lines[0].unitPrice, current.sellingPrice);
  assert.equal(doc.lines[0].purchaseCost, current.purchasePrice);
  assert.equal(doc.total, current.sellingPrice * 2);
  assert.equal(doc.paid, 1000);
  assert.equal(doc.payments[0].amount, 1000);
  assert.equal(f.stock(current.id).quantity, beforeStock.quantity - 2);
  assert.equal(f.stock(current.id).version, beforeStock.version + 1);
  f.run('payment.create', { documentId: doc.id, amount: doc.total - doc.paid });
  assert.equal(f.state().documents.at(-1).paid, doc.total);
});

test('a database restart preserves stocks, documents, settings and idempotency without reseeding history', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'stock-restart-tests-'));
  const dbPath = path.join(dir, 'stock.sqlite');
  let service;
  t.after(() => { if (service) service.close(); rmSync(dir, { recursive: true, force: true }); });
  service = new StockService({ dbPath, production: false });
  let admin = service.authenticate('admin@stock.local', 'Demo2026!').user;
  const id = randomUUID();
  const command = { id, type: 'document.create', payload: sale() };
  service.command(admin, command);
  service.command(admin, { id: randomUUID(), type: 'settings.update', payload: { noPrices: true, businessName: 'Commerce persistant' } });
  const before = service.state(admin);
  const commandCount = service.db.prepare('SELECT count(*) AS total FROM commands').get().total;
  service.close(); service = null;

  service = new StockService({ dbPath, production: false });
  admin = service.authenticate('admin@stock.local', 'Demo2026!').user;
  assert.deepEqual(service.state(admin), before);
  assert.deepEqual(service.command(admin, command), { ok: true, duplicate: true });
  assert.deepEqual(service.state(admin), before);
  assert.equal(service.db.prepare('SELECT count(*) AS total FROM commands').get().total, commandCount);
});

test('fresh production databases remain free of demo catalog and preserve custom settings on restart', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'stock-production-tests-'));
  const dbPath = path.join(dir, 'stock.sqlite');
  let service;
  t.after(() => { if (service) service.close(); rmSync(dir, { recursive: true, force: true }); });
  service = new StockService({ dbPath, production: true, adminEmail: 'owner@example.com', adminPassword: 'Secure-Production-2026!' });
  let admin = service.authenticate('owner@example.com', 'Secure-Production-2026!').user;
  const state = service.state(admin);
  for (const key of ['products', 'documents', 'stocks', 'contacts', 'inventories', 'expenses']) assert.deepEqual(state[key], []);
  assert.equal(state.stores.length, 1);
  assert.equal(service.db.prepare('SELECT count(*) AS total FROM users WHERE demo=1').get().total, 0);
  service.command(admin, { id: randomUUID(), type: 'settings.update', payload: { noPrices: true, businessName: 'Boutique réelle' } });
  const customized = service.state(admin);
  service.close(); service = null;

  // The existing real administrator is reused without creating another account.
  service = new StockService({ dbPath, production: true });
  admin = service.authenticate('owner@example.com', 'Secure-Production-2026!').user;
  assert.deepEqual(service.state(admin), customized);
  assert.equal(service.db.prepare('SELECT count(*) AS total FROM users').get().total, 1);
  fails('INVALID_CREDENTIALS', () => service.authenticate('admin@stock.local', 'Demo2026!'), 401);
});

test('authentication normalizes emails, hashes session tokens and honors expiration and logout', t => {
  const f = fixture(t);
  fails('INVALID_CREDENTIALS', () => f.service.authenticate('admin@stock.local', 'wrong'), 401);
  fails('INVALID_CREDENTIALS', () => f.service.authenticate('missing@stock.local', 'Demo2026!'), 401);
  const login = f.service.authenticate(' ADMIN@STOCK.LOCAL ', 'Demo2026!');
  assert.deepEqual(Object.keys(login.user).sort(), ['email', 'id', 'name', 'role']);
  assert.match(login.token, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.service.session(login.token), login.user);
  assert.equal(f.service.session('malformed'), null);
  assert.equal(f.service.db.prepare('SELECT token FROM sessions WHERE token=?').get(login.token), undefined);
  const digest = createHash('sha256').update(login.token).digest('hex');
  assert.ok(f.service.db.prepare('SELECT token FROM sessions WHERE token=?').get(digest));
  f.service.logout(login.token);
  assert.equal(f.service.session(login.token), null);
  const expiring = f.login('cashier');
  const expiringDigest = createHash('sha256').update(expiring.token).digest('hex');
  f.service.db.prepare('UPDATE sessions SET expires=? WHERE token=?').run(Date.now() - 1000, expiringDigest);
  assert.equal(f.service.session(expiring.token), null);
});

test('production requires real administrator credentials and rejects demo logins and existing demo sessions', t => {
  const adminEmail = process.env.STOCK_ADMIN_EMAIL;
  const adminPassword = process.env.STOCK_ADMIN_PASSWORD;
  delete process.env.STOCK_ADMIN_EMAIL;
  delete process.env.STOCK_ADMIN_PASSWORD;
  try {
    assert.throws(() => new StockService({ dbPath: ':memory:', production: true }), /STOCK_ADMIN_EMAIL et STOCK_ADMIN_PASSWORD/);
    assert.throws(() => new StockService({ dbPath: ':memory:', production: true, adminEmail: 'owner@example.com', adminPassword: 'short' }), /au moins 12 caractères/);
  } finally {
    if (adminEmail !== undefined) process.env.STOCK_ADMIN_EMAIL = adminEmail;
    if (adminPassword !== undefined) process.env.STOCK_ADMIN_PASSWORD = adminPassword;
  }

  const dir = mkdtempSync(path.join(tmpdir(), 'stock-tests-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'stock.sqlite');
  const development = new StockService({ dbPath, production: false });
  const demo = development.authenticate('admin@stock.local', 'Demo2026!');
  development.close();
  const production = new StockService({ dbPath, production: true, adminEmail: 'owner@example.com', adminPassword: 'Secure-Production-2026!' });
  t.after(() => production.close());
  fails('INVALID_CREDENTIALS', () => production.authenticate('admin@stock.local', 'Demo2026!'), 401);
  assert.equal(production.session(demo.token), null);
  const owner = production.authenticate('owner@example.com', 'Secure-Production-2026!');
  assert.equal(owner.user.role, 'admin');
  assert.deepEqual(production.session(owner.token), owner.user);
});

test('implicit commercial dates and document numbering use the Benin calendar at UTC year rollover', t => {
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-12-31T23:30:00Z');
  t.after(() => { Date.now = realNow; });
  const f = fixture(t);
  assert.equal(f.state().documents.find(document => document.note === 'Vente du jour').date, '2027-01-01');
  f.run('document.create', sale());
  const document = f.state().documents.at(-1);
  assert.equal(document.date, '2027-01-01');
  assert.match(document.number, /^VEN-2027-/);
  f.run('expense.create', { storeId: 'store-centre', category: 'Transport', amount: 500, note: 'Nuit du nouvel an' });
  assert.equal(f.state().expenses.at(-1).date, '2027-01-01');
  f.run('inventory.create', { storeId: 'store-centre', name: 'Comptage nouvelle année', category: 'Boissons / Eaux' });
  const inventory = f.state().inventories.at(-1);
  f.run('inventory.count', { inventoryId: inventory.id, counts: inventory.lines.map(line => ({ productId: line.productId, quantity: line.theoretical + 1 })) });
  f.run('inventory.validate', { inventoryId: inventory.id });
  const adjustment = f.state().documents.at(-1);
  assert.equal(adjustment.date, '2027-01-01');
  assert.match(adjustment.number, /^AJU-2027-/);
});
