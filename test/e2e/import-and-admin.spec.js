'use strict';

const { test, expect } = require('@playwright/test');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { StockService } = require('../../lib/business');
const { createApp } = require('../../server');

let service, server, base, uploadDir, errors;
test.beforeEach(async ({ page }) => {
  service = new StockService({ dbPath: ':memory:', production: false });
  uploadDir = mkdtempSync(path.join(tmpdir(), 'comptoir-import-admin-'));
  const app = createApp({ service, uploadDir });
  server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.locator('[data-demo="admin"]').click();
  await expect(page.getByRole('heading', { name: 'Vue d’ensemble', exact: true })).toBeVisible();
  await expect(page.locator('#sync-state')).toHaveText('À jour');
});
test.afterEach(async ({ page }) => {
  await page.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  service.close();
  rmSync(uploadDir, { recursive: true, force: true });
  expect(errors).toEqual([]);
});
const getState = async page => (await page.request.get(base + '/api/state')).json();
const stock = (state, productId, storeId) => state.stocks.find(row => row.productId === productId && row.storeId === storeId).quantity;

async function createMovement(page, type, productId, quantity, note, destination) {
  await page.getByRole('button', { name: 'Nouvelle opération', exact: true }).click();
  await page.locator('[name=type]').selectOption(type);
  await page.locator('[name=lineProduct]').selectOption(productId);
  await page.locator('[name=lineQuantity]').fill(String(quantity));
  if (destination) await page.locator('[name=toStoreId]').selectOption(destination);
  await page.getByLabel('Note / motif').fill(note);
  await page.getByRole('button', { name: 'Valider l’opération', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('import CSV quoted accents and rejected row, existing unit edit and uploaded photo', async ({ page }) => {
  const before = await getState(page);
  await page.getByRole('button', { name: 'Catalogue produits', exact: true }).click();
  await page.getByRole('button', { name: 'Importer un CSV', exact: true }).click();
  const csv = '\uFEFFNom;SKU;Catégorie;Unité;Marque;Prix achat;Prix vente;Stock;Tags\r\n'
    + '"Café ""Étoile""; torréfié\nintense";CSV-ETOILE;Épicerie / Café;paquet;Bénin;500;750;999;local,café\r\n'
    + 'Produit rejeté;;Épicerie;pièce;;100;150;500;\r\n';
  await page.getByLabel('Fichier CSV UTF-8').setInputFiles({ name: 'catalogue-accents.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Importer', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Bilan de l’import');
  await expect(page.getByRole('dialog')).toContainText('1 article(s) importé(s), 1 ligne(s) rejetée(s).');
  await expect(page.getByRole('dialog')).toContainText('Référence invalide.');
  const imported = await getState(page);
  const product = imported.products.find(item => item.sku === 'CSV-ETOILE');
  expect(product.name).toBe('Café "Étoile"; torréfié\nintense');
  expect(product.category).toBe('Épicerie / Café');
  expect(product.brand).toBe('Bénin');
  expect(product.tags).toEqual(['local', 'café']);
  expect(imported.products.some(item => item.name === 'Produit rejeté')).toBe(false);
  expect(imported.stocks.filter(row => row.productId === product.id)).toHaveLength(3);
  expect(imported.stocks.filter(row => row.productId === product.id).every(row => row.quantity === 0)).toBe(true);
  expect(imported.stocks.filter(row => row.productId !== product.id)).toEqual(before.stocks);
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();

  await page.locator('[data-edit-product="product-riz"]').click();
  await expect(page.getByLabel('Unité', { exact: true })).toHaveValue('sac');
  await page.getByLabel('Nom du produit').fill('Riz du Bénin 5 kg');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yafEAAAAASUVORK5CYII=', 'base64');
  await page.getByLabel('Photo du produit', { exact: true }).setInputFiles({ name: 'photo-riz.png', mimeType: 'image/png', buffer: png });
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const after = await getState(page);
  const edited = after.products.find(item => item.id === 'product-riz');
  expect(edited.name).toBe('Riz du Bénin 5 kg');
  expect(edited.unit).toBe('sac');
  expect(edited.version).toBe(before.products.find(item => item.id === edited.id).version + 1);
  expect(after.stocks.filter(row => row.productId === edited.id)).toEqual(before.stocks.filter(row => row.productId === edited.id));
  expect(edited.photo).toMatch(/^\/uploads\/[a-f0-9-]+\.png$/);
  const image = page.locator(`img[src="${edited.photo}"]`).first();
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(element => element.complete && element.naturalWidth)).toBe(1);
  const response = await page.request.get(base + edited.photo);
  expect(response.status()).toBe(200);
  expect(await response.body()).toEqual(png);
});

test('administrator transfer and loss preserve balances, and expense updates reports', async ({ page }) => {
  const before = await getState(page);
  const productId = 'product-farine';
  await page.getByRole('button', { name: 'Mouvements', exact: true }).click();
  await createMovement(page, 'transfer', productId, 1.125, 'Transfert de farine UI', 'store-nord');
  const transferred = await getState(page);
  expect(stock(transferred, productId, 'store-centre')).toBe(stock(before, productId, 'store-centre') - 1.125);
  expect(stock(transferred, productId, 'store-nord')).toBe(stock(before, productId, 'store-nord') + 1.125);
  expect(transferred.stocks.filter(row => row.productId === productId).reduce((sum, row) => sum + Math.round(row.quantity * 1000), 0))
    .toBe(before.stocks.filter(row => row.productId === productId).reduce((sum, row) => sum + Math.round(row.quantity * 1000), 0));
  const transfer = transferred.documents.find(document => document.note === 'Transfert de farine UI');
  expect(transfer.type).toBe('transfer');
  expect(transfer.toStoreId).toBe('store-nord');
  expect(transfer.lines[0].quantity).toBe(1.125);
  expect(transfer.total).toBe(0);

  await createMovement(page, 'adjustment', productId, -0.125, 'Perte de farine UI');
  const adjusted = await getState(page);
  expect(stock(adjusted, productId, 'store-centre')).toBe(stock(before, productId, 'store-centre') - 1.25);
  expect(stock(adjusted, productId, 'store-nord')).toBe(stock(transferred, productId, 'store-nord'));
  const adjustment = adjusted.documents.find(document => document.note === 'Perte de farine UI');
  expect(adjustment.type).toBe('adjustment');
  expect(adjustment.lines[0].quantity).toBe(-0.125);
  expect(adjustment.total).toBe(0);

  await page.getByRole('button', { name: 'Rapports & analyses', exact: true }).click();
  const priorExpenses = before.expenses.filter(expense => expense.storeId === 'store-centre').reduce((sum, expense) => sum + expense.amount, 0);
  await page.locator('[data-action="new-expense"]').click();
  await page.getByLabel('Catégorie', { exact: true }).selectOption('Transport');
  await page.getByLabel('Montant (FCFA)').fill('1250');
  await page.getByLabel('Note', { exact: true }).fill('Livraison test au Bénin');
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const result = await getState(page);
  const expense = result.expenses.find(item => item.note === 'Livraison test au Bénin');
  expect(expense.amount).toBe(1250);
  expect(expense.storeId).toBe('store-centre');
  await expect(page.locator('.activity-item').filter({ hasText: 'Livraison test au Bénin' })).toContainText('Transport');
  const displayed = await page.locator('.metric-card').filter({ hasText: 'Frais généraux' }).locator('.metric-value').textContent();
  expect(Number(displayed.replace(/[^\d-]/g, ''))).toBe(priorExpenses + 1250);
});
