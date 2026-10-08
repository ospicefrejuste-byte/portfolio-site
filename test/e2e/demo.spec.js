const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const path = require('node:path');

// Managed Chromium in this environment blocks file:// URLs. Deliver exactly the
// self-contained HTML through a fulfilled document request, without any server.
const demoPath = path.resolve(__dirname, '../../dist/Comptoir-demo.html');
const demoUrl = 'http://localhost:39123/Comptoir-demo.html';
let errors, remoteRequests;
test.beforeEach(async ({ page, context }) => {
  errors = []; remoteRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && request.url() !== demoUrl) remoteRequests.push(request.url()); });
  await context.route('**/*', route => route.request().url() === demoUrl
    ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: readFileSync(demoPath) })
    : route.abort());
  await context.setOffline(true);
  await page.goto(demoUrl);
  await expect(page.locator('[data-demo="admin"]')).toBeVisible();
});
test.afterEach(async () => {
  expect(errors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});
async function login(page, role = 'admin') {
  await page.locator(`[data-demo="${role}"]`).click();
  await expect(page.getByRole('heading', { name: 'Vue d’ensemble', exact: true })).toBeVisible();
}
const state = page => page.evaluate(() => window.ComptoirDemoAPI.request('/api/state'));
async function operation(page, type, productId, quantity, paid) {
  await page.getByRole('button', { name: 'Nouvelle opération', exact: true }).click();
  await page.locator('[name=type]').selectOption(type);
  await page.locator('[name=lineProduct]').selectOption(productId);
  await page.locator('[name=lineQuantity]').fill(String(quantity));
  if (['sale', 'purchase'].includes(type)) {
    const contact = (await state(page)).contacts.find(c => c.type === (type === 'sale' ? 'customer' : 'supplier'));
    await page.locator('[name=contactId]').selectOption(contact.id);
  }
  if (paid != null) await page.locator('[name=paid]').fill(String(paid));
  await page.getByRole('button', { name: 'Valider l’opération', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('fichier autonome : achat, vente partielle, paiement et photo persistent sans réseau', async ({ page }, info) => {
  await login(page);
  await page.screenshot({ path: info.outputPath('demo-autonome.png'), fullPage: true });
  await page.getByRole('button', { name: 'Catalogue produits', exact: true }).click();
  await page.getByRole('button', { name: 'Ajouter un produit', exact: true }).click();
  await page.getByLabel('Nom du produit').fill('Article autonome');
  await page.getByLabel('Référence / SKU').fill('DEMO-AUTO-001');
  await page.getByLabel('Catégorie / dossier').fill('Tests / Autonome');
  await page.getByLabel('Prix d’achat (FCFA)').fill('300');
  await page.getByLabel('Prix de vente (FCFA)').fill('500');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yafEAAAAASUVORK5CYII=', 'base64');
  await page.locator('input[type=file]').setInputFiles({ name: 'article.png', mimeType: 'image/png', buffer: png });
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  let current = await state(page);
  const product = current.products.find(p => p.sku === 'DEMO-AUTO-001');
  expect(product.photo).toMatch(/^data:image\/png;base64,/);
  await page.getByRole('button', { name: 'Mouvements', exact: true }).click();
  await operation(page, 'purchase', product.id, 10.5);
  await operation(page, 'sale', product.id, 2, 250);
  current = await state(page);
  const sale = current.documents.find(d => d.type === 'sale' && d.lines.some(l => l.productId === product.id));
  expect(sale.total).toBe(1000); expect(sale.paid).toBe(250);
  expect(current.stocks.find(s => s.productId === product.id && s.storeId === 'store-centre').quantity).toBe(8.5);
  await page.getByRole('button', { name: 'Voir ' + sale.number, exact: true }).click();
  await page.getByRole('button', { name: 'Ajouter un paiement', exact: true }).click();
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Vue d’ensemble', exact: true })).toBeVisible();
  current = await state(page);
  expect(current.documents.find(d => d.id === sale.id).paid).toBe(1000);
  expect(current.products.find(p => p.id === product.id).photo).toBe(product.photo);
  expect(current.stocks.find(s => s.productId === product.id && s.storeId === 'store-centre').quantity).toBe(8.5);
  await page.getByRole('button', { name: 'Catalogue produits', exact: true }).click();
  await page.getByRole('textbox', { name: 'Rechercher un produit' }).fill('DEMO-AUTO-001');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect.poll(() => page.locator('tbody img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Exporter', exact: true }).click();
  expect((await downloaded).suggestedFilename()).toMatch(/^catalogue-.*\.csv$/);
});

test('inventaire saisi et validé dans le fichier autonome hors connexion', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Inventaires', exact: true }).click();
  await page.getByRole('button', { name: 'Nouvel inventaire', exact: true }).click();
  await page.getByLabel('Nom de la session').fill('Inventaire autonome');
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const inventory = (await state(page)).inventories.find(i => i.name === 'Inventaire autonome');
  await page.locator(`[data-inventory="${inventory.id}"]`).click();
  for (let i = 0; i < inventory.lines.length; i++) {
    await page.locator('.count-input').nth(i).fill(String(inventory.lines[i].theoretical + (i === 0 ? 1 : 0)));
  }
  await page.getByRole('button', { name: 'Enregistrer le comptage', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator(`[data-inventory="${inventory.id}"]`).click();
  await page.getByRole('button', { name: 'Valider l’inventaire', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Vue d’ensemble', exact: true })).toBeVisible();
  const current = await state(page);
  expect(current.inventories.find(i => i.id === inventory.id).status).toBe('validated');
  expect(current.stocks.find(s => s.productId === inventory.lines[0].productId && s.storeId === inventory.storeId).quantity).toBe(inventory.lines[0].theoretical + 1);
});

test('démo mobile : affichage local explicite et parcours des trois rôles', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'cashier');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const cashier = await state(page);
  expect(cashier.products.every(p => !Object.hasOwn(p, 'purchasePrice'))).toBe(true);
  await page.locator('[data-action=menu]').click();
  await page.getByRole('button', { name: 'Se déconnecter', exact: true }).click();
  await expect(page.locator('[data-demo="inventory"]')).toBeVisible();
  await login(page, 'inventory');
  const inventory = await state(page);
  expect(inventory.products.every(p => !Object.hasOwn(p, 'sellingPrice'))).toBe(true);
  await page.locator('[data-action=menu]').click();
  await page.getByRole('button', { name: 'Inventaires', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Nouvel inventaire', exact: true })).toBeVisible();
});

test('deux fenêtres enregistrent leurs articles sans écraser les données de l’autre', async ({ page, context }) => {
  await login(page);
  const other = await context.newPage();
  await other.goto(demoUrl);
  await expect(other.getByRole('heading', { name: 'Vue d’ensemble', exact: true })).toBeVisible();
  const create = (target, suffix) => target.evaluate(async suffix => {
    return window.ComptoirDemoAPI.request('/api/commands', {
      id: crypto.randomUUID(), type: 'product.save',
      payload: { id: 'tab-' + suffix, sku: 'TAB-' + suffix, name: 'Article fenêtre ' + suffix }
    });
  }, suffix);
  await Promise.all([create(page, 'A'), create(other, 'B')]);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Vue d’ensemble', exact: true })).toBeVisible();
  const current = await state(page);
  expect(current.products.filter(p => /^TAB-/.test(p.sku))).toHaveLength(2);
  await other.close();
});
