'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { StockService } = require('../lib/business');
const { cancelDocument } = require('../lib/reversals');

function fixture(t) {
  const service = new StockService({ dbPath: ':memory:', production: false });
  t.after(() => service.close());
  const user = role => service.authenticate(`${role}@stock.local`, 'Demo2026!').user;
  const admin = user('admin');
  const run = (type, payload) => service.command(admin, { id: randomUUID(), type, payload });
  const create = payload => { run('document.create', payload); return service.all('documents').at(-1); };
  const stock = (productId, storeId = 'store-centre') => ({ ...service.stock(productId, storeId) });
  const cancel = (documentId, reason = 'Erreur de saisie', actor = admin, implementation = cancelDocument) => {
    service.db.exec('BEGIN IMMEDIATE');
    try {
      const result = implementation(service, actor, { documentId, reason });
      service.db.exec('COMMIT');
      return result;
    } catch (error) { service.db.exec('ROLLBACK'); throw error; }
  };
  return { service, admin, user, run, create, stock, cancel };
}

function fails(code, fn, status = 409) {
  assert.throws(fn, error => error.code === code && error.status === status);
}

const unpaidSale = (lines = [{ productId: 'product-farine', quantity: 1.125, unitPrice: 600 }]) => ({
  type: 'sale', storeId: 'store-centre', contactId: 'customer-awa', paid: 0, lines
});
const unpaidPurchase = (lines = [{ productId: 'product-farine', quantity: 1.125, unitPrice: 400 }]) => ({
  type: 'purchase', storeId: 'store-centre', contactId: 'supplier-sodico', paid: 0, lines
});

test('cancelling an unpaid sale restores exact stock and preserves the original financial and product snapshots', t => {
  const f = fixture(t);
  const productId = 'product-farine';
  const before = f.stock(productId);
  const original = f.create(unpaidSale());
  const product = f.service.need('products', productId, 'Article');
  f.run('product.save', { ...product, name: 'Farine renommée', purchasePrice: 999, expectedVersion: product.version });
  const result = f.cancel(original.id, '  Vente saisie en double  ');
  const cancelled = f.service.get('documents', original.id);
  const reversal = f.service.get('documents', result.reversalDocumentId);

  assert.equal(f.stock(productId).quantity, before.quantity);
  assert.equal(f.stock(productId).version, before.version + 2);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancellationReason, 'Vente saisie en double');
  assert.equal(cancelled.cancelledBy, f.admin.id);
  assert.ok(Number.isFinite(Date.parse(cancelled.cancelledAt)));
  assert.equal(cancelled.reversalDocumentId, reversal.id);
  assert.equal(cancelled.total, original.total);
  assert.equal(cancelled.contactId, original.contactId);
  assert.deepEqual(cancelled.lines, original.lines);
  assert.equal(reversal.type, 'purchase');
  assert.match(reversal.number, /^ANN-\d{4}-\d{4}$/);
  assert.equal(reversal.reversalOf, original.id);
  assert.equal(reversal.total, 0);
  assert.equal(reversal.paid, 0);
  assert.equal(reversal.contactId, null);
  assert.deepEqual(reversal.payments, []);
  assert.deepEqual(reversal.lines, original.lines);
  assert.equal(reversal.createdBy, f.admin.id);
  assert.deepEqual(result, { documentId: original.id, reversalDocumentId: reversal.id });
});

test('an unpaid purchase can be cancelled while stock is available', t => {
  const f = fixture(t);
  const before = f.stock('product-farine');
  const original = f.create(unpaidPurchase());
  const result = f.cancel(original.id);
  const reversal = f.service.get('documents', result.reversalDocumentId);
  assert.equal(f.stock('product-farine').quantity, before.quantity);
  assert.equal(f.stock('product-farine').version, before.version + 2);
  assert.equal(reversal.type, 'sale');
  assert.deepEqual(reversal.lines, original.lines);
  assert.equal(reversal.total, 0);
  assert.equal(reversal.contactId, null);
});

test('cancelling a transfer moves the same fractional quantities back and increments both stock versions', t => {
  const f = fixture(t);
  const productId = 'product-farine';
  const source = f.stock(productId);
  const destination = f.stock(productId, 'store-nord');
  const original = f.create({ type: 'transfer', storeId: 'store-centre', toStoreId: 'store-nord', lines: [{ productId, quantity: 0.375 }] });
  const result = f.cancel(original.id);
  const reversal = f.service.get('documents', result.reversalDocumentId);
  assert.deepEqual(f.stock(productId), { quantity: source.quantity, version: source.version + 2 });
  assert.deepEqual(f.stock(productId, 'store-nord'), { quantity: destination.quantity, version: destination.version + 2 });
  assert.equal(reversal.type, 'transfer');
  assert.equal(reversal.storeId, original.toStoreId);
  assert.equal(reversal.toStoreId, original.storeId);
  assert.deepEqual(reversal.lines, original.lines);
});

test('cancelling a manual adjustment reverses positive and negative lines without rewriting their snapshots', t => {
  const f = fixture(t);
  const beforeFlour = f.stock('product-farine');
  const beforeSugar = f.stock('product-sucre');
  const original = f.create({
    type: 'adjustment', storeId: 'store-centre',
    lines: [{ productId: 'product-farine', quantity: -0.125 }, { productId: 'product-sucre', quantity: 2 }]
  });
  const result = f.cancel(original.id);
  const reversal = f.service.get('documents', result.reversalDocumentId);
  assert.equal(f.stock('product-farine').quantity, beforeFlour.quantity);
  assert.equal(f.stock('product-sucre').quantity, beforeSugar.quantity);
  assert.deepEqual(reversal.lines, original.lines.map(line => ({ ...line, quantity: -line.quantity })));
  assert.equal(reversal.type, 'adjustment');
});

test('stock that has already been sold prevents purchase cancellation without a partial movement or ledger write', t => {
  const f = fixture(t);
  const original = f.create(unpaidPurchase([
    { productId: 'product-farine', quantity: 1, unitPrice: 400 },
    { productId: 'product-eau', quantity: 1, unitPrice: 250 }
  ]));
  const availableWater = f.stock('product-eau').quantity / 1000;
  f.create({ ...unpaidSale([{ productId: 'product-eau', quantity: availableWater, unitPrice: 400 }]), paid: 0 });
  const before = f.service.state(f.admin);
  fails('INSUFFICIENT_STOCK', () => f.cancel(original.id));
  assert.deepEqual(f.service.state(f.admin), before);
  assert.equal(f.service.get('documents', original.id).status, undefined);
});

test('transfer cancellation is refused if destination stock is no longer available', t => {
  const f = fixture(t);
  const original = f.create({ type: 'transfer', storeId: 'store-centre', toStoreId: 'store-nord', lines: [{ productId: 'product-farine', quantity: 0.375 }] });
  const amount = f.stock('product-farine', 'store-nord').quantity / 1000;
  f.create({ ...unpaidSale([{ productId: 'product-farine', quantity: amount, unitPrice: 600 }]), storeId: 'store-nord' });
  const before = f.service.state(f.admin);
  fails('INSUFFICIENT_STOCK', () => f.cancel(original.id));
  assert.deepEqual(f.service.state(f.admin), before);
});

test('paid or partially paid documents require a real refund and cannot be cancelled', t => {
  const f = fixture(t);
  const partial = f.create({ ...unpaidSale(), paid: 100 });
  const full = f.create({ ...unpaidSale(), paid: 675 });
  const before = f.service.state(f.admin);
  for (const document of [partial, full]) fails('REFUND_REQUIRED', () => f.cancel(document.id));
  assert.deepEqual(f.service.state(f.admin), before);
});

test('cancelling a validated inventory adjustment is refused and leaves the count ledger intact', t => {
  const f = fixture(t);
  f.run('inventory.create', { storeId: 'store-centre', name: 'Contrôle eau', category: 'Boissons / Eaux' });
  const session = f.service.all('inventories').at(-1);
  f.run('inventory.count', { inventoryId: session.id, counts: session.lines.map(line => ({ productId: line.productId, quantity: line.theoretical - 1 })) });
  f.run('inventory.validate', { inventoryId: session.id });
  const documentId = f.service.get('inventories', session.id).documentId;
  const before = f.service.state(f.admin);
  fails('INVENTORY_ADJUSTMENT', () => f.cancel(documentId));
  assert.deepEqual(f.service.state(f.admin), before);
});

test('a document cannot be cancelled twice and its reversal cannot be cancelled', t => {
  const f = fixture(t);
  const original = f.create(unpaidSale());
  const result = f.cancel(original.id);
  const before = f.service.state(f.admin);
  fails('DOCUMENT_CANCELLED', () => f.cancel(original.id));
  fails('REVERSAL_DOCUMENT', () => f.cancel(result.reversalDocumentId));
  assert.deepEqual(f.service.state(f.admin), before);
});

test('only an administrator can cancel and a bounded nonempty reason is required', t => {
  const f = fixture(t);
  const original = f.create(unpaidSale());
  const before = f.service.state(f.admin);
  for (const role of ['cashier', 'inventory']) fails('FORBIDDEN', () => f.cancel(original.id, 'Erreur', f.user(role)), 403);
  fails('UNAUTHORIZED', () => f.cancel(original.id, 'Erreur', null), 401);
  for (const reason of ['', '  ', null, 100, 'x'.repeat(1001)]) fails('INVALID_INPUT', () => f.cancel(original.id, reason), 400);
  fails('NOT_FOUND', () => f.cancel('document-absent'), 404);
  assert.deepEqual(f.service.state(f.admin), before);
  f.cancel(original.id, 'x'.repeat(1000));
});

test('cancellations remain ordered with unique numbers and invalidate inventory snapshots through stock versions', t => {
  const f = fixture(t);
  const first = f.create(unpaidSale());
  const second = f.create(unpaidPurchase());
  f.run('inventory.create', { storeId: 'store-centre', name: 'Contrôle farine', category: 'Épicerie / Céréales' });
  const inventory = f.service.all('inventories').at(-1);
  f.run('inventory.count', { inventoryId: inventory.id, counts: inventory.lines.map(line => ({ productId: line.productId, quantity: line.theoretical })) });
  f.cancel(first.id);
  f.cancel(second.id);
  const reversals = f.service.all('documents').filter(document => document.reversalOf);
  assert.equal(reversals.length, 2);
  assert.notEqual(reversals[0].number, reversals[1].number);
  assert.equal(Number(reversals[1].number.split('-').at(-1)), Number(reversals[0].number.split('-').at(-1)) + 1);
  fails('INVENTORY_CONFLICT', () => f.run('inventory.validate', { inventoryId: inventory.id }));
});

test('a ledger write failure rolls back stock and both cancellation records within the outer transaction', t => {
  const f = fixture(t);
  const original = f.create(unpaidSale());
  const before = f.service.state(f.admin);
  const put = f.service.put;
  f.service.put = function (table, object) {
    if (table === 'documents' && object.id === original.id && object.status === 'cancelled') throw new Error('Échec du journal simulé');
    return put.call(this, table, object);
  };
  assert.throws(() => f.cancel(original.id), /Échec du journal simulé/);
  f.service.put = put;
  assert.deepEqual(f.service.state(f.admin), before);
});

test('the command interface replays a cancellation once and rejects changed IDs, payloads and unauthorized actors', t => {
  const f = fixture(t);
  const original = f.create(unpaidSale());
  const beforeQuantity = f.stock('product-farine').quantity;
  const command = { id: randomUUID(), type: 'document.cancel', payload: { documentId: original.id, reason: 'Doublon confirmé' } };
  assert.deepEqual(f.service.command(f.admin, command), { ok: true });
  const after = f.service.state(f.admin);
  assert.equal(f.stock('product-farine').quantity, beforeQuantity + 1125);
  assert.deepEqual(f.service.command(f.admin, command), { ok: true, duplicate: true });
  fails('IDEMPOTENCY_CONFLICT', () => f.service.command(f.admin, { ...command, payload: { ...command.payload, reason: 'Autre raison' } }));
  fails('DOCUMENT_CANCELLED', () => f.service.command(f.admin, { ...command, id: randomUUID() }));
  fails('FORBIDDEN', () => f.service.command(f.user('cashier'), { ...command, id: randomUUID() }), 403);
  fails('FORBIDDEN', () => f.service.command(f.user('inventory'), { ...command, id: randomUUID() }), 403);
  assert.deepEqual(f.service.state(f.admin), after);
});

test('a failed cancellation command reserves no ID and can be retried after genuine stock replenishment', t => {
  const f = fixture(t);
  const original = f.create(unpaidPurchase([{ productId: 'product-eau', quantity: 1, unitPrice: 250 }]));
  f.create(unpaidSale([{ productId: 'product-eau', quantity: f.stock('product-eau').quantity / 1000, unitPrice: 400 }]));
  const command = { id: randomUUID(), type: 'document.cancel', payload: { documentId: original.id, reason: 'Achat saisi en double' } };
  const before = f.service.state(f.admin);
  fails('INSUFFICIENT_STOCK', () => f.service.command(f.admin, command));
  assert.equal(f.service.db.prepare('SELECT id FROM commands WHERE id=?').get(command.id), undefined);
  assert.deepEqual(f.service.state(f.admin), before);
  f.create({ type: 'adjustment', storeId: 'store-centre', lines: [{ productId: 'product-eau', quantity: 1 }] });
  assert.deepEqual(f.service.command(f.admin, command), { ok: true });
  assert.equal(f.stock('product-eau').quantity, 0);
  assert.equal(f.service.get('documents', original.id).status, 'cancelled');
});

test('cancelled documents and reversals accept no payments, and cashier state exposes no purchase reversal prices', t => {
  const f = fixture(t);
  const original = f.create(unpaidPurchase());
  f.run('document.cancel', { documentId: original.id, reason: 'Erreur du fournisseur' });
  const cancelled = f.service.get('documents', original.id);
  const reversal = f.service.get('documents', cancelled.reversalDocumentId);
  const before = f.service.state(f.admin);
  fails('DOCUMENT_CANCELLED', () => f.run('payment.create', { documentId: original.id, amount: 1 }));
  fails('REVERSAL_DOCUMENT', () => f.run('payment.create', { documentId: reversal.id, amount: 1 }));
  assert.deepEqual(f.service.state(f.admin), before);
  const documents = f.service.state(f.user('cashier')).documents;
  assert.ok(documents.every(document => document.type === 'sale' && !document.reversalOf));
  assert.ok(documents.every(document => document.lines.every(line => !Object.hasOwn(line, 'purchaseCost'))));
  assert.ok(documents.every(document => document.id !== reversal.id));
});

test('the browser UMD export uses the same stock rules without Node imports', t => {
  const f = fixture(t);
  const context = { crypto: { randomUUID } };
  vm.runInNewContext(readFileSync(require.resolve('../lib/reversals'), 'utf8'), context);
  assert.equal(typeof context.ComptoirReversals.cancelDocument, 'function');
  const original = f.create(unpaidSale());
  const before = f.stock('product-farine').quantity;
  fails('FORBIDDEN', () => f.cancel(original.id, 'Erreur', f.user('cashier'), context.ComptoirReversals.cancelDocument), 403);
  f.cancel(original.id, 'Erreur', f.admin, context.ComptoirReversals.cancelDocument);
  assert.equal(f.stock('product-farine').quantity, before + 1125);
  assert.equal(f.service.get('documents', original.id).status, 'cancelled');
});
