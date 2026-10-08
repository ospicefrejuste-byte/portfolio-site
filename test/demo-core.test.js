'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DemoCore, DemoError } = require('../demo/demo-core');

const admin = { id: 'admin', name: 'Administrateur démo', email: 'admin@demo.local', role: 'admin' };
const cashier = { id: 'cashier', name: 'Caissier démo', email: 'cashier@demo.local', role: 'cashier' };
const inventoryAgent = { id: 'inventory', name: 'Agent démo', email: 'inventory@demo.local', role: 'inventory' };
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=';

function seed() {
  const product = (id, name, sku, category, purchasePrice, sellingPrice, unit) => ({
    id, name, sku, category, purchasePrice, sellingPrice, unit, version: 1,
    brand: '', tags: ['démo'], minStock: 2, location: 'A1', notes: '', color: '#dde8e0', photo: ''
  });
  return {
    user: admin,
    products: [product('p1', 'Farine', 'FAR-001', 'Épicerie / Farines', 400, 600, 'kg'), product('p2', 'Eau', 'EAU-001', 'Boissons / Eaux', 200, 300, 'bouteille')],
    stores: [{ id: 'a', name: 'Boutique Cotonou', city: 'Cotonou' }, { id: 'b', name: 'Dépôt', city: 'Porto-Novo' }],
    stocks: [{ productId: 'p1', storeId: 'a', quantity: 10.5, version: 1 }, { productId: 'p1', storeId: 'b', quantity: 2, version: 1 }, { productId: 'p2', storeId: 'a', quantity: 3, version: 1 }, { productId: 'p2', storeId: 'b', quantity: 5, version: 1 }],
    contacts: [{ id: 'customer', type: 'customer', name: 'Client', phone: '', address: '', taxId: '' }, { id: 'supplier', type: 'supplier', name: 'Fournisseur', phone: '', address: '', taxId: '' }],
    documents: [], inventories: [], expenses: [],
    settings: { id: 'main', currency: 'XOF', noPrices: false, businessName: 'Commerce démo' }
  };
}

function fixture(initial = seed()) {
  const core = new DemoCore(initial);
  const run = (type, payload, user = admin, id = randomUUID()) => core.command(user, { id, type, payload });
  const state = (user = admin) => core.state(user);
  const stock = (productId, storeId = 'a') => state().stocks.find(row => row.productId === productId && row.storeId === storeId);
  return { core, run, state, stock };
}

function fails(code, fn, status) {
  assert.throws(fn, error => error instanceof DemoError && error.code === code && (status == null || error.status === status));
}

const sale = (quantity = 1) => ({ type: 'sale', storeId: 'a', contactId: 'customer', lines: [{ productId: 'p1', quantity }], paid: 0 });

test('fractional purchases, sales and partial payments retain exact stock and integer monetary totals', () => {
  const f = fixture();
  f.run('document.create', { type: 'purchase', storeId: 'a', contactId: 'supplier', lines: [{ productId: 'p1', quantity: 1.125 }], paid: 450 });
  assert.equal(f.stock('p1').quantity, 11.625);
  const purchase = f.state().documents.at(-1);
  assert.equal(purchase.lines[0].unitPrice, 400);
  assert.equal(purchase.lines[0].purchaseCost, 400);
  assert.equal(purchase.total, 450);
  assert.equal(purchase.paid, 450);

  f.run('document.create', { ...sale(0.125), paid: 25 }, cashier);
  const doc = f.state().documents.at(-1);
  assert.equal(f.stock('p1').quantity, 11.5);
  assert.equal(doc.total, 75);
  assert.equal(doc.paid, 25);
  assert.equal(doc.createdBy, cashier.id);
  const beforeRejectedPayment = f.core.exportState();
  fails('OVERPAYMENT', () => f.run('payment.create', { documentId: doc.id, amount: 51 }, cashier));
  assert.deepEqual(f.core.exportState(), beforeRejectedPayment);
  const id = randomUUID();
  const payment = { documentId: doc.id, amount: 50 };
  f.run('payment.create', payment, cashier, id);
  assert.deepEqual(f.run('payment.create', payment, cashier, id), { ok: true, duplicate: true });
  const settled = f.state().documents.at(-1);
  assert.equal(settled.paid, settled.total);
  assert.equal(settled.payments.length, 2);
  assert.equal(settled.payments[1].createdBy, cashier.id);
  fails('FORBIDDEN', () => f.run('payment.create', { documentId: purchase.id, amount: 1 }, cashier), 403);
});

test('an insufficient later line rolls back all changes and leaves its command ID reusable', () => {
  const f = fixture();
  const before = f.core.exportState();
  const id = randomUUID();
  const payload = { ...sale(), lines: [{ productId: 'p1', quantity: 1 }, { productId: 'p2', quantity: 4 }] };
  fails('INSUFFICIENT_STOCK', () => f.run('document.create', payload, admin, id), 409);
  assert.deepEqual(f.core.exportState(), before);
  const corrected = { ...payload, lines: [{ productId: 'p1', quantity: 1 }, { productId: 'p2', quantity: 1 }] };
  assert.deepEqual(f.run('document.create', corrected, admin, id), { ok: true });
  assert.equal(f.stock('p1').quantity, 9.5);
  assert.equal(f.stock('p2').quantity, 2);
  assert.equal(f.state().documents.length, 1);
});

test('transfers conserve three-decimal quantities and negative adjustments record a signed loss', () => {
  const f = fixture();
  const totalBefore = f.state().stocks.filter(row => row.productId === 'p1').reduce((sum, row) => sum + row.quantity * 1000, 0);
  f.run('document.create', { type: 'transfer', storeId: 'a', toStoreId: 'b', lines: [{ productId: 'p1', quantity: 1.125 }] });
  assert.equal(f.stock('p1', 'a').quantity, 9.375);
  assert.equal(f.stock('p1', 'b').quantity, 3.125);
  assert.equal(f.stock('p1', 'a').version, 2);
  assert.equal(f.stock('p1', 'b').version, 2);
  const totalAfter = f.state().stocks.filter(row => row.productId === 'p1').reduce((sum, row) => sum + row.quantity * 1000, 0);
  assert.equal(totalAfter, totalBefore);
  f.run('document.create', { type: 'adjustment', storeId: 'a', lines: [{ productId: 'p1', quantity: -0.375 }], note: 'Perte' });
  assert.equal(f.stock('p1').quantity, 9);
  assert.equal(f.state().documents.at(-1).lines[0].quantity, -0.375);
  assert.equal(f.state().documents.at(-1).total, 0);
  const beforeInvalid = f.core.exportState();
  fails('INSUFFICIENT_STOCK', () => f.run('document.create', { type: 'adjustment', storeId: 'a', lines: [{ productId: 'p1', quantity: -10 }] }), 409);
  fails('INVALID_INPUT', () => f.run('document.create', { type: 'transfer', storeId: 'a', toStoreId: 'a', lines: [{ productId: 'p1', quantity: 1 }] }));
  fails('INVALID_INPUT', () => f.run('document.create', sale(0.0001)));
  assert.deepEqual(f.core.exportState(), beforeInvalid);
});

test('an inventory snapshot conflict preserves intervening sales, while a fresh count validates exactly once', () => {
  const f = fixture();
  f.run('inventory.create', { storeId: 'a', name: 'Comptage initial', category: 'Épicerie' }, inventoryAgent);
  const original = f.state().inventories.at(-1);
  assert.equal(original.lines.length, 1);
  f.run('inventory.count', { inventoryId: original.id, counts: [{ productId: 'p1', quantity: 10.5 }] }, inventoryAgent);
  f.run('document.create', { ...sale(0.5), paid: 300 }, cashier);
  const afterSale = f.core.exportState();
  fails('INVENTORY_CONFLICT', () => f.run('inventory.validate', { inventoryId: original.id }), 409);
  assert.deepEqual(f.core.exportState(), afterSale);
  assert.equal(f.stock('p1').quantity, 10);

  f.run('inventory.create', { storeId: 'a', name: 'Nouveau comptage', category: 'Épicerie' }, inventoryAgent);
  const fresh = f.state().inventories.at(-1);
  assert.equal(fresh.lines[0].theoretical, 10);
  fails('INVENTORY_INCOMPLETE', () => f.run('inventory.validate', { inventoryId: fresh.id }));
  f.run('inventory.count', { inventoryId: fresh.id, counts: [{ productId: 'p1', quantity: 9.875 }] }, inventoryAgent);
  const id = randomUUID();
  f.run('inventory.validate', { inventoryId: fresh.id }, admin, id);
  assert.deepEqual(f.run('inventory.validate', { inventoryId: fresh.id }, admin, id), { ok: true, duplicate: true });
  const validated = f.state().inventories.at(-1);
  const adjustment = f.state().documents.find(doc => doc.id === validated.documentId);
  assert.equal(validated.status, 'validated');
  assert.equal(validated.validatedBy, admin.id);
  assert.equal(f.stock('p1').quantity, 9.875);
  assert.equal(adjustment.type, 'adjustment');
  assert.equal(adjustment.inventoryId, fresh.id);
  assert.equal(adjustment.lines[0].quantity, -0.125);
  assert.equal(adjustment.total, 0);
  fails('INVENTORY_CLOSED', () => f.run('inventory.validate', { inventoryId: fresh.id }), 409);
  fails('INVENTORY_CLOSED', () => f.run('inventory.count', { inventoryId: fresh.id, counts: [{ productId: 'p1', quantity: 100 }] }), 409);
});

test('one validated multi-product count writes both surplus and shortage without affecting another store', () => {
  const f = fixture();
  const otherStore = f.state().stocks.filter(row => row.storeId === 'b');
  f.run('inventory.create', { storeId: 'a', name: 'Comptage complet' });
  const session = f.state().inventories.at(-1);
  f.run('inventory.count', { inventoryId: session.id, counts: [{ productId: 'p1', quantity: 10.625 }] });
  fails('INVENTORY_INCOMPLETE', () => f.run('inventory.validate', { inventoryId: session.id }));
  f.run('inventory.count', { inventoryId: session.id, counts: [{ productId: 'p2', quantity: 2 }] });
  f.run('inventory.validate', { inventoryId: session.id });
  assert.equal(f.stock('p1').quantity, 10.625);
  assert.equal(f.stock('p2').quantity, 2);
  assert.deepEqual(f.state().documents.at(-1).lines.map(line => [line.productId, line.quantity]), [['p1', 0.125], ['p2', -1]]);
  assert.deepEqual(f.state().stocks.filter(row => row.storeId === 'b'), otherStore);
});

test('idempotency rejects a different payload or actor and survives export and restoration', () => {
  const f = fixture();
  const id = randomUUID();
  const payload = sale();
  f.run('document.create', payload, admin, id);
  const reordered = { paid: 0, lines: payload.lines, contactId: 'customer', storeId: 'a', type: 'sale' };
  assert.deepEqual(f.run('document.create', reordered, admin, id), { ok: true, duplicate: true });
  const beforeConflicts = f.core.exportState();
  fails('IDEMPOTENCY_CONFLICT', () => f.run('document.create', sale(2), admin, id), 409);
  fails('IDEMPOTENCY_CONFLICT', () => f.run('document.create', payload, cashier, id), 409);
  assert.deepEqual(f.core.exportState(), beforeConflicts);
  assert.ok(Object.hasOwn(beforeConflicts, '_commands'));
  const restored = fixture(beforeConflicts);
  assert.deepEqual(restored.core.command(admin, { id, type: 'document.create', payload }), { ok: true, duplicate: true });
  assert.deepEqual(restored.state(), f.state());
  assert.equal(restored.stock('p1').quantity, 9.5);
  assert.equal(restored.state().documents.length, 1);
  fails('IDEMPOTENCY_CONFLICT', () => restored.run('document.create', sale(2), admin, id), 409);
});

test('idempotency survives JSON storage removing undefined optional payload fields', () => {
  const f = fixture();
  const input = {
    id: randomUUID(), type: 'document.create',
    payload: { ...sale(), note: undefined, lines: [{ productId: 'p1', quantity: 1, unitPrice: undefined }] }
  };
  assert.deepEqual(f.core.command(admin, input), { ok: true });
  const persistedCommand = JSON.parse(JSON.stringify(input));
  assert.deepEqual(f.core.command(admin, persistedCommand), { ok: true, duplicate: true });
  const persistedState = JSON.parse(JSON.stringify(f.core.exportState()));
  const restored = fixture(persistedState);
  assert.deepEqual(restored.core.command(admin, persistedCommand), { ok: true, duplicate: true });
  assert.deepEqual(restored.core.command(admin, input), { ok: true, duplicate: true });
  assert.equal(restored.state().documents.length, 1);
  assert.equal(restored.stock('p1').quantity, 9.5);
  assert.equal(restored.state().documents[0].lines[0].unitPrice, 600);
});

test('expenses and no-prices settings persist without altering financial calculations or stock', () => {
  const f = fixture();
  const originalStocks = f.state().stocks;
  f.run('settings.update', { noPrices: true, businessName: 'Commerce sans prix affichés' });
  f.run('expense.create', { storeId: 'b', category: 'Transport', amount: 2500, date: '2026-10-08', note: 'Livraison' });
  assert.deepEqual(f.state().stocks, originalStocks);
  const expense = f.state().expenses[0];
  assert.equal(expense.storeId, 'b');
  assert.equal(expense.category, 'Transport');
  assert.equal(expense.amount, 2500);
  assert.equal(expense.date, '2026-10-08');
  assert.equal(expense.createdBy, admin.id);
  const beforeInvalid = f.core.exportState();
  fails('INVALID_INPUT', () => f.run('expense.create', { storeId: 'b', category: 'Transport', amount: 0.5 }));
  fails('INVALID_INPUT', () => f.run('settings.update', { noPrices: 'true', businessName: 'Invalid' }));
  assert.deepEqual(f.core.exportState(), beforeInvalid);
  f.run('document.create', { ...sale(), paid: 600 });
  assert.equal(f.state().documents[0].total, 600);
  assert.equal(f.state().documents[0].paid, 600);
  const restored = fixture(JSON.parse(JSON.stringify(f.core.exportState())));
  assert.deepEqual(restored.state().settings, { id: 'main', currency: 'XOF', noPrices: true, businessName: 'Commerce sans prix affichés' });
  assert.deepEqual(restored.state().expenses, [expense]);
  assert.equal(restored.stock('p1').quantity, 9.5);
});

test('SKU uniqueness, optimistic versions and used units protect catalog edits', () => {
  const f = fixture();
  const initial = f.state().products.find(product => product.id === 'p1');
  fails('DUPLICATE_SKU', () => f.run('product.save', { id: 'p3', name: 'Doublon', sku: 'far-001' }), 409);
  fails('VERSION_CONFLICT', () => f.run('product.save', { ...initial, expectedVersion: 0, name: 'Édition périmée' }), 409);
  fails('UNIT_IN_USE', () => f.run('product.save', { ...initial, expectedVersion: 1, unit: 'carton' }), 409);
  assert.deepEqual(f.state().products.find(product => product.id === 'p1'), initial);
  f.run('product.save', { ...initial, expectedVersion: 1, name: 'Farine renommée' });
  assert.equal(f.state().products.find(product => product.id === 'p1').version, 2);
  fails('VERSION_CONFLICT', () => f.run('product.save', { ...initial, expectedVersion: 1 }), 409);

  f.run('product.save', { id: 'p3', name: 'Nouveau produit', sku: 'NEW-001', unit: 'pièce', quantity: 100, photo: png });
  let added = f.state().products.find(product => product.id === 'p3');
  assert.equal(added.photo, png);
  const addedStocks = f.state().stocks.filter(row => row.productId === added.id);
  assert.equal(addedStocks.length, 2);
  assert.ok(addedStocks.every(row => row.quantity === 0));
  f.run('product.save', { ...added, expectedVersion: added.version, unit: 'kg' });
  added = f.state().products.find(product => product.id === 'p3');
  assert.equal(added.unit, 'kg');
  fails('INVALID_INPUT', () => f.run('product.save', { ...added, expectedVersion: added.version, photo: 'https://example.com/image.png' }));
  f.run('inventory.create', { storeId: 'a', name: 'Protection unité' });
  fails('UNIT_IN_USE', () => f.run('product.save', { ...added, expectedVersion: added.version, unit: 'litre' }), 409);
});

test('role filters hide prices and documents, and unauthorized commands cannot mutate demo state', () => {
  const f = fixture();
  f.run('document.create', { type: 'purchase', storeId: 'a', contactId: 'supplier', lines: [{ productId: 'p2', quantity: 1 }], paid: 200 });
  f.run('document.create', sale(), cashier);
  f.run('expense.create', { storeId: 'a', category: 'Transport', amount: 500 });
  f.run('inventory.create', { storeId: 'a', name: 'Comptage', category: 'Boissons' }, inventoryAgent);
  const session = f.state().inventories.at(-1);
  f.run('inventory.count', { inventoryId: session.id, counts: [{ productId: 'p2', quantity: 4 }] }, inventoryAgent);
  const cashState = f.state(cashier);
  assert.equal(cashState.user.role, 'cashier');
  assert.ok(cashState.products.every(product => !Object.hasOwn(product, 'purchasePrice') && Object.hasOwn(product, 'sellingPrice')));
  assert.equal(cashState.documents.length, 1);
  assert.ok(cashState.documents.every(doc => doc.type === 'sale' && doc.lines.every(line => !Object.hasOwn(line, 'purchaseCost'))));
  assert.ok(cashState.contacts.every(contact => contact.type === 'customer'));
  assert.deepEqual(cashState.expenses, []);
  assert.deepEqual(cashState.inventories, []);
  const countState = f.state(inventoryAgent);
  assert.ok(countState.products.every(product => !Object.hasOwn(product, 'purchasePrice') && !Object.hasOwn(product, 'sellingPrice')));
  assert.deepEqual(countState.documents, []);
  assert.deepEqual(countState.contacts, []);
  assert.deepEqual(countState.expenses, []);
  assert.equal(countState.inventories[0].lines[0].counted, 4);

  const before = f.core.exportState();
  fails('FORBIDDEN', () => f.run('document.create', { type: 'purchase' }, cashier), 403);
  fails('FORBIDDEN', () => f.run('settings.update', { noPrices: true, businessName: 'Interdit' }, cashier), 403);
  fails('FORBIDDEN', () => f.run('product.save', { id: 'p1' }, inventoryAgent), 403);
  fails('FORBIDDEN', () => f.run('inventory.validate', { inventoryId: session.id }, inventoryAgent), 403);
  fails('UNAUTHORIZED', () => f.run('document.create', sale(), null), 401);
  fails('UNAUTHORIZED', () => f.state(null), 401);
  assert.deepEqual(f.core.exportState(), before);
});

test('unknown command names, including inherited object properties, cannot be recorded as successful operations', () => {
  const f = fixture();
  const before = f.core.exportState();
  for (const type of ['unknown.action', 'constructor', 'toString', '__proto__']) {
    fails('UNKNOWN_COMMAND', () => f.run(type, {}));
  }
  assert.deepEqual(f.core.exportState(), before);
});

test('constructor input, exported snapshots and filtered states cannot mutate the core through shared references', () => {
  const original = seed();
  const f = fixture(original);
  f.run('document.create', sale());
  const before = f.core.exportState();
  original.products[0].purchasePrice = 1;
  original.stocks[0].quantity = 0;
  original.settings.businessName = 'Seed altéré';
  const exported = f.core.exportState();
  exported.products[0].tags.push('mutation');
  exported.stocks[0].quantity = 999;
  exported.documents[0].lines[0].quantity = 999;
  exported.settings.noPrices = true;
  exported._commands = {};
  const viewed = f.state(cashier);
  viewed.products[0].tags.push('mutation vendeur');
  viewed.documents[0].lines[0].unitPrice = 1;
  viewed.settings.businessName = 'État altéré';
  assert.deepEqual(f.core.exportState(), before);
});

test('default business dates and document numbering use Benin time at the UTC year boundary', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-12-31T23:30:00.000Z') });
  const f = fixture();
  f.run('document.create', { ...sale(), paid: 600 });
  const doc = f.state().documents[0];
  assert.equal(doc.date, '2027-01-01');
  assert.equal(doc.number, 'VEN-2027-0001');
  assert.equal(doc.payments[0].date, '2027-01-01');
  const before = f.core.exportState();
  fails('INVALID_INPUT', () => f.run('document.create', { ...sale(), date: '2027-02-30' }));
  assert.deepEqual(f.core.exportState(), before);
});
