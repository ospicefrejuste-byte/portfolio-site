(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory({
      uuid: require('node:crypto').randomUUID,
      // Resolve AppError at call time: business.js also imports this module.
      createError(message, code, status) {
        const { AppError } = require('./business');
        return new AppError(message, code, status);
      }
    });
  } else {
    root.ComptoirReversals = factory({
      uuid: () => root.crypto.randomUUID(),
      createError(message, code, status) {
        const error = new Error(message);
        error.code = code; error.status = status;
        return error;
      }
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (dependencies) {
'use strict';
const { uuid, createError } = dependencies;

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Porto-Novo', year: 'numeric', month: '2-digit', day: '2-digit'
});

function fail(message, code = 'INVALID_INPUT', status = 400) {
  throw createError(message, code, status);
}

function requiredText(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    fail(`${label} obligatoire, entre 1 et ${max} caractères.`);
  }
  return value.trim();
}

function scaledQuantity(line, signed) {
  const value = line.quantity;
  const scaled = Math.round(value * 1000);
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(scaled) ||
      !scaled || (!signed && scaled < 0) || Math.abs(scaled / 1000 - value) > 1e-8) {
    fail('Les quantités du document ne permettent pas son annulation.', 'INVALID_DOCUMENT', 409);
  }
  return scaled;
}

function nextCancellationNumber(service, businessDate) {
  const prefix = `ANN-${businessDate.slice(0, 4)}-`;
  const previous = service.all('documents').reduce((last, document) => {
    if (typeof document.number !== 'string' || !document.number.startsWith(prefix)) return last;
    const suffix = document.number.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) return last;
    const value = Number(suffix);
    return Number.isSafeInteger(value) ? Math.max(last, value) : last;
  }, 0);
  return `${prefix}${String(previous + 1).padStart(4, '0')}`;
}

/**
 * Cancel a whole, unpaid document without deleting its audit trail.
 * The caller must wrap this function in the same transaction as its command ID.
 * Financial reports must exclude cancelled originals and reversalOf documents.
 */
function cancelDocument(service, user, input) {
  if (!user) fail('Connexion requise.', 'UNAUTHORIZED', 401);
  if (user.role !== 'admin') fail('L’annulation est réservée aux administrateurs.', 'FORBIDDEN', 403);
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Données d’annulation invalides.');
  const documentId = requiredText(input.documentId, 'Identifiant du document', 120);
  const reason = requiredText(input.reason, 'Motif d’annulation', 1000);
  const original = service.need('documents', documentId, 'Document');

  if (original.reversalOf) fail('Un document d’annulation ne peut pas être annulé à nouveau.', 'REVERSAL_DOCUMENT', 409);
  if (original.status === 'cancelled' || original.reversalDocumentId) {
    fail('Ce document est déjà annulé.', 'DOCUMENT_CANCELLED', 409);
  }
  if (original.inventoryId) {
    fail('Ce mouvement provient d’un inventaire validé. Effectuez un nouvel inventaire pour corriger le stock.', 'INVENTORY_ADJUSTMENT', 409);
  }
  if ((original.paid || 0) > 0 || original.payments?.some(payment => payment.amount > 0)) {
    fail('Ce document comporte un paiement. Un remboursement réel doit être enregistré avant son annulation ; cette opération n’est pas encore disponible.', 'REFUND_REQUIRED', 409);
  }
  if (!['sale', 'purchase', 'transfer', 'adjustment'].includes(original.type) || !original.lines?.length) {
    fail('Ce document ne peut pas être annulé.', 'INVALID_DOCUMENT', 409);
  }

  const storeId = service.need('stores', original.storeId, 'Magasin').id;
  const toStoreId = original.type === 'transfer'
    ? service.need('stores', original.toStoreId, 'Magasin de destination').id : null;
  if (toStoreId === storeId) fail('Le transfert doit concerner deux magasins distincts.', 'INVALID_DOCUMENT', 409);

  const deltas = new Map();
  const addDelta = (productId, targetStoreId, delta) => {
    const key = JSON.stringify([productId, targetStoreId]);
    const previous = deltas.get(key);
    const sum = (previous?.delta || 0) + delta;
    if (!Number.isSafeInteger(sum)) fail('Quantité de stock trop importante.', 'INVALID_DOCUMENT', 409);
    deltas.set(key, { productId, storeId: targetStoreId, delta: sum });
  };
  const lines = original.lines.map(line => {
    const productId = service.need('products', line.productId, 'Article').id;
    const scaled = scaledQuantity(line, original.type === 'adjustment');
    if (original.type === 'sale' || original.type === 'transfer') addDelta(productId, storeId, scaled);
    else addDelta(productId, storeId, -scaled);
    if (original.type === 'transfer') addDelta(productId, toStoreId, -scaled);
    // Keep the historical labels, unit and costs instead of today's catalogue.
    return { ...line, quantity: original.type === 'adjustment' ? -scaled / 1000 : scaled / 1000 };
  });

  // Validate every store before the first write. The outer transaction also
  // protects the ledger and command ID if a later write fails.
  for (const movement of deltas.values()) {
    const next = service.stock(movement.productId, movement.storeId).quantity + movement.delta;
    if (next < 0) {
      const product = service.need('products', movement.productId, 'Article');
      fail(`Stock insuffisant pour annuler ce document : ${product.name}.`, 'INSUFFICIENT_STOCK', 409);
    }
    if (!Number.isSafeInteger(next) || next > 1_000_000_000_000) fail('Quantité de stock trop importante.');
  }

  const now = new Date();
  const businessDate = dateFormatter.format(now);
  const inverseType = { sale: 'purchase', purchase: 'sale', transfer: 'transfer', adjustment: 'adjustment' }[original.type];
  const reversal = {
    id: uuid(), number: nextCancellationNumber(service, businessDate), type: inverseType,
    storeId: original.type === 'transfer' ? toStoreId : storeId,
    toStoreId: original.type === 'transfer' ? storeId : null,
    contactId: null, lines, total: 0, paid: 0, payments: [],
    note: `Annulation de ${original.number} : ${reason}`,
    date: businessDate, createdAt: now.toISOString(), createdBy: user.id,
    reversalOf: original.id, cancellationReason: reason
  };
  const cancelled = {
    ...original, status: 'cancelled', cancelledAt: now.toISOString(),
    cancelledBy: user.id, cancellationReason: reason, reversalDocumentId: reversal.id
  };

  for (const movement of deltas.values()) service.move(movement.productId, movement.storeId, movement.delta);
  service.put('documents', reversal);
  service.put('documents', cancelled);
  return { documentId: original.id, reversalDocumentId: reversal.id };
}

return { cancelDocument };
});
