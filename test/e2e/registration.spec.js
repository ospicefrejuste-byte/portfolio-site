const { test, expect } = require('@playwright/test');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { StockService } = require('../../lib/business');
const { createApp } = require('../../server');

// Real browser, HTTP routes, SQLite transactions and verification code.
// Only delivery is captured in memory; no email is sent to a real address.
test.describe('inscription et vérification de boutique', () => {
  let service, server, base, uploadDir, verified, registrationRequest, verificationRequest;
  const account = {
    user: { id: 'new-owner', email: 'awa@example.test', name: 'Awa Adom', role: 'admin' },
    settings: { businessName: 'Épicerie La Grâce', currency: 'XOF', noPrices: false },
    products: [], stores: [{ id: 'new-store', name: 'Épicerie La Grâce', city: 'Cotonou', version: 1 }],
    stocks: [], documents: [], contacts: [], inventories: [], expenses: []
  };

  test.beforeEach(async ({ page }) => {
    verified = false; registrationRequest = null; verificationRequest = null;
    service = new StockService({ dbPath: ':memory:', production: false });
    uploadDir = mkdtempSync(path.join(tmpdir(), 'comptoir-registration-'));
    const app = createApp({ service, uploadDir });
    server = await new Promise(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    base = `http://127.0.0.1:${server.address().port}`;
    page.on('request',request=>{
      if(request.method()!=='POST')return;
      if(request.url()===base+'/api/register')registrationRequest=request.postDataJSON();
      if(request.url()===base+'/api/register/verify')verificationRequest=request.postDataJSON();
    });
    await page.goto(base);
    await expect(page.locator('#login-form')).toBeVisible();
  });

  test.afterEach(async ({ page }) => {
    await page.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    service.close();
    rmSync(uploadDir, { recursive: true, force: true });
  });

  test('crée le compte, vérifie le code et ouvre le tableau de bord', async ({ page }) => {
    await page.getByRole('button', { name: 'Créer un compte', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Votre commerce commence ici.', exact: true })).toBeVisible();
    await page.getByLabel('Nom complet').fill('Awa Adom');
    await page.getByLabel('Adresse e-mail').fill('Awa@Example.test');
    await page.locator('#field-password').fill('UnePhraseSecrete2026!');
    await page.getByLabel('Confirmer le mot de passe').fill('UnePhraseSecrete2026!');
    await page.getByLabel('Nom de la boutique').fill('Épicerie La Grâce');
    await page.getByLabel('Ville / commune').fill('Cotonou');
    await page.getByRole('button', { name: 'Créer mon espace', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Vérifions votre adresse.', exact: true })).toBeVisible();
    expect(registrationRequest).toMatchObject({
      email: 'awa@example.test', name: 'Awa Adom',
      shop: { name: 'Épicerie La Grâce', city: 'Cotonou' }
    });
    expect(registrationRequest.password).toBe('UnePhraseSecrete2026!');
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('UnePhraseSecrete2026!');
    const code=service.mailer.getCapturedMessages({includeCode:true}).at(-1).code;
    await page.getByLabel('Code de vérification').fill(code);
    await page.getByRole('button', { name: 'Vérifier et ouvrir mon espace', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Vue d’ensemble', exact: true })).toBeVisible();
    expect(verificationRequest).toMatchObject({ email: 'awa@example.test', code });
    expect(verificationRequest.registrationId).toMatch(/^[a-f0-9]{64}$/);
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(code);
    await expect(page.locator('.store-card')).toContainText('Épicerie La Grâce');
    await page.reload();
    await expect(page.locator('.store-card')).toContainText('Épicerie La Grâce');
    expect(service.state(service.authenticate('awa@example.test','UnePhraseSecrete2026!').user).products).toEqual([]);
  });

  test('refuse une confirmation de mot de passe différente sans appel réseau', async ({ page }) => {
    await page.getByRole('button', { name: 'Créer un compte', exact: true }).click();
    await page.getByLabel('Nom complet').fill('Awa Adom');
    await page.getByLabel('Adresse e-mail').fill('awa@example.test');
    await page.locator('#field-password').fill('UnePhraseSecrete2026!');
    await page.getByLabel('Confirmer le mot de passe').fill('UneAutrePhrase2026!');
    await page.getByLabel('Nom de la boutique').fill('Épicerie La Grâce');
    await page.getByLabel('Ville / commune').fill('Cotonou');
    await page.getByRole('button', { name: 'Créer mon espace', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('ne correspondent pas');
    expect(registrationRequest).toBeNull();
  });
});
