'use strict';

const { DatabaseSync } = require('node:sqlite');
const { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const businessDateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Porto-Novo', year: 'numeric', month: '2-digit', day: '2-digit' });
const businessDate = (offset = 0) => businessDateFormatter.format(new Date(Date.now() + offset * 86_400_000));

class AppError extends Error {
  constructor(message, code = 'INVALID_INPUT', status = 400) {
    super(message); this.code = code; this.status = status;
  }
}
const fail = (message, code, status) => { throw new AppError(message, code, status); };
function string(value, label, max = 200, required = true) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) fail(`${label} invalide.`);
  return value.trim();
}
function integer(value, label, max = 1_000_000_000_000) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail(`${label} doit être un entier positif ou nul.`);
  return value;
}
function quantity(value, label = 'Quantité', signed = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1_000_000_000 || (!signed && value < 0)) fail(`${label} invalide.`);
  const scaled = Math.round(value * 1000);
  if (Math.abs(scaled / 1000 - value) > 1e-8) fail(`${label} accepte au maximum trois décimales.`);
  return scaled;
}
function date(value) {
  const result = value || businessDate();
  if (typeof result !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result) fail('Date invalide.');
  return result;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
const passwordHash = (password, salt = randomBytes(16).toString('hex')) => `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
function passwordMatches(password, stored) {
  const [salt, hash] = stored.split(':');
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
const publicUser = row => ({ id: row.id, email: row.email, name: row.name, role: row.role });

class StockService {
  constructor(options = {}) {
    this.production = options.production ?? process.env.NODE_ENV === 'production';
    const dbPath = options.dbPath || process.env.STOCK_DB_PATH || path.join(__dirname, '..', 'data', 'stock.sqlite');
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, password TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS stocks (product_id TEXT NOT NULL, store_id TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity >= 0), version INTEGER NOT NULL, PRIMARY KEY(product_id,store_id));
      CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS stores (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inventories (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS expenses (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
    try {
      this.ensureUsers(options);
      if (options.seed !== false && !this.get('settings', 'main')) this.seed();
    } catch (error) { this.db.close(); throw error; }
    this.dummyHash = passwordHash(randomBytes(24).toString('hex'));
  }
  close() { this.db.close(); }
  all(table) { return this.db.prepare(`SELECT data FROM ${table}`).all().map(row => JSON.parse(row.data)); }
  get(table, id) { const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id); return row ? JSON.parse(row.data) : null; }
  put(table, object) { this.db.prepare(`INSERT INTO ${table} (id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(object.id, JSON.stringify(object)); }
  need(table, id, label) { const found = typeof id === 'string' && this.get(table, id); if (!found) fail(`${label} introuvable.`, 'NOT_FOUND', 404); return found; }
  ensureUsers(options) {
    if (this.production) {
      const existing = this.db.prepare("SELECT id FROM users WHERE role='admin' AND demo=0").get();
      if (existing) return;
      const email = options.adminEmail || process.env.STOCK_ADMIN_EMAIL;
      const password = options.adminPassword || process.env.STOCK_ADMIN_PASSWORD;
      if (!email || !password || password.length < 12 || password.length > 200 || email.length > 254 || password === 'Demo2026!' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error('Production : définissez STOCK_ADMIN_EMAIL et STOCK_ADMIN_PASSWORD (au moins 12 caractères) pour créer le premier administrateur.');
      }
      const old = this.db.prepare('SELECT demo FROM users WHERE email=?').get(email.toLowerCase());
      if (old) throw new Error('Production : choisissez une adresse administrateur distincte des comptes de démonstration.');
      this.addUser(email.toLowerCase(), 'Administrateur', 'admin', password, false);
      return;
    }
    for (const [email, name, role] of [['admin@stock.local', 'Aminata Diallo', 'admin'], ['cashier@stock.local', 'Moussa Traoré', 'cashier'], ['inventory@stock.local', 'Fatou Koné', 'inventory']]) {
      if (!this.db.prepare('SELECT id FROM users WHERE email=?').get(email)) this.addUser(email, name, role, 'Demo2026!', true);
    }
  }
  addUser(email, name, role, password, demo) {
    this.db.prepare('INSERT INTO users(id,email,name,role,password,demo) VALUES(?,?,?,?,?,?)').run(randomUUID(), email, name, role, passwordHash(password), demo ? 1 : 0);
  }
  authenticate(email, password) {
    if (typeof email !== 'string' || typeof password !== 'string' || email.length > 254 || password.length > 200) fail('Identifiants incorrects.', 'INVALID_CREDENTIALS', 401);
    const row = this.db.prepare('SELECT * FROM users WHERE email=?').get(email.trim().toLowerCase());
    const valid = passwordMatches(password, row?.password || this.dummyHash);
    if (!row || !valid || (this.production && row.demo)) fail('Identifiants incorrects.', 'INVALID_CREDENTIALS', 401);
    const token = randomBytes(32).toString('hex');
    const digest = createHash('sha256').update(token).digest('hex');
    this.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    this.db.prepare('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)').run(digest, row.id, Date.now() + 12 * 60 * 60 * 1000);
    return { user: publicUser(row), token };
  }
  session(token) {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const digest = createHash('sha256').update(token).digest('hex');
    const row = this.db.prepare('SELECT users.* FROM users JOIN sessions ON users.id=sessions.user_id WHERE sessions.token=? AND sessions.expires>?').get(digest, Date.now());
    return row && !(this.production && row.demo) ? publicUser(row) : null;
  }
  logout(token) { if (token) this.db.prepare('DELETE FROM sessions WHERE token=?').run(createHash('sha256').update(token).digest('hex')); }
  authorize(user, type, payload) {
    if (!user) fail('Connexion requise.', 'UNAUTHORIZED', 401);
    if (user.role === 'admin') return;
    if (user.role === 'cashier' && type === 'document.create' && payload.type === 'sale') return;
    if (user.role === 'cashier' && type === 'payment.create' && this.need('documents', payload.documentId, 'Document').type === 'sale') return;
    if (user.role === 'inventory' && ['inventory.create', 'inventory.count'].includes(type)) return;
    fail('Cette action nécessite un autre rôle.', 'FORBIDDEN', 403);
  }
  state(user) {
    if (!user) fail('Connexion requise.', 'UNAUTHORIZED', 401);
    const admin = user.role === 'admin';
    const inventory = user.role === 'inventory';
    const products = this.all('products').map(product => {
      if (admin) return product;
      const { purchasePrice, ...safe } = product;
      if (inventory) delete safe.sellingPrice;
      return safe;
    });
    const documents = inventory ? [] : this.all('documents').filter(doc => admin || doc.type === 'sale').map(doc => {
      if (admin) return doc;
      return { ...doc, lines: doc.lines.map(({ purchaseCost, ...line }) => line) };
    });
    return {
      user, products, stores: this.all('stores'),
      stocks: this.db.prepare('SELECT product_id AS productId, store_id AS storeId, quantity, version FROM stocks').all().map(row => ({ ...row, quantity: row.quantity / 1000 })),
      documents, contacts: inventory ? [] : this.all('contacts').filter(contact => admin || contact.type === 'customer'),
      inventories: user.role === 'cashier' ? [] : this.all('inventories'),
      expenses: admin ? this.all('expenses') : [],
      settings: this.get('settings', 'main') || { currency: 'XOF', noPrices: false, businessName: 'Comptoir' }
    };
  }
  command(user, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Commande invalide.');
    const id = string(input.id, 'Identifiant de commande', 120);
    const type = string(input.type, 'Type de commande', 60);
    const payload = input.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('Données de commande invalides.');
    this.authorize(user, type, payload);
    const hash = createHash('sha256').update(canonical({ type, payload })).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT user_id,hash FROM commands WHERE id=?').get(id);
      if (previous) {
        if (previous.user_id !== user.id || previous.hash !== hash) fail('Cet identifiant de commande est déjà utilisé pour une autre opération.', 'IDEMPOTENCY_CONFLICT', 409);
        this.db.exec('COMMIT'); return { ok: true, duplicate: true };
      }
      const handlers = {
        'product.save': () => this.saveProduct(payload), 'contact.save': () => this.saveContact(payload),
        'document.create': () => this.createDocument(user, payload), 'payment.create': () => this.createPayment(user, payload),
        'inventory.create': () => this.createInventory(user, payload), 'inventory.count': () => this.countInventory(payload),
        'inventory.validate': () => this.validateInventory(user, payload), 'expense.create': () => this.createExpense(user, payload),
        'settings.update': () => this.updateSettings(payload)
      };
      if (!handlers[type]) fail('Type de commande inconnu.', 'UNKNOWN_COMMAND');
      handlers[type]();
      this.db.prepare('INSERT INTO commands(id,user_id,hash,created_at) VALUES(?,?,?,?)').run(id, user.id, hash, new Date().toISOString());
      this.db.exec('COMMIT');
      return { ok: true };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  saveProduct(input) {
    const id = input.id ? string(input.id, 'Identifiant', 120) : randomUUID();
    const previous = this.get('products', id);
    if (previous && input.expectedVersion !== previous.version) fail('Cet article a changé. Actualisez les données avant de le modifier.', 'VERSION_CONFLICT', 409);
    if (!previous && input.expectedVersion != null && input.expectedVersion !== 0) fail('Cet article n’existe plus.', 'VERSION_CONFLICT', 409);
    const sku = string(input.sku, 'Référence', 100);
    if (this.all('products').some(product => product.id !== id && product.sku.toLocaleLowerCase() === sku.toLocaleLowerCase())) fail('Cette référence existe déjà.', 'DUPLICATE_SKU', 409);
    const tags = input.tags ?? [];
    if (!Array.isArray(tags) || tags.length > 30) fail('Les tags sont invalides.');
    const photo = string(input.photo, 'Photo', 250, false);
    if (photo && !/^\/uploads\/[a-f0-9-]+\.(?:jpg|png|webp)$/.test(photo)) fail('La photo doit provenir du téléversement local.');
    const color = input.color || '#dde8e0';
    if (!/^#[0-9a-f]{6}$/i.test(color)) fail('Couleur invalide.');
    const unit = string(input.unit || 'pièce', 'Unité', 30);
    if (previous && previous.unit !== unit) {
      const hasStock = this.db.prepare('SELECT 1 FROM stocks WHERE product_id=? AND quantity>0 LIMIT 1').get(id);
      const hasHistory = this.all('documents').some(document => document.lines.some(line => line.productId === id));
      const hasCount = this.all('inventories').some(inventory => inventory.lines.some(line => line.productId === id));
      if (hasStock || hasHistory || hasCount) fail('L’unité d’un article déjà stocké ou documenté ne peut pas être changée. Créez une nouvelle référence pour cette unité.', 'UNIT_IN_USE', 409);
    }
    const product = {
      id, name: string(input.name, 'Nom', 160), sku,
      category: string(input.category, 'Catégorie', 160, false), brand: string(input.brand, 'Marque', 100, false),
      tags: tags.map(tag => string(tag, 'Tag', 60)), unit,
      purchasePrice: integer(input.purchasePrice ?? previous?.purchasePrice ?? 0, 'Prix d’achat'),
      sellingPrice: integer(input.sellingPrice ?? previous?.sellingPrice ?? 0, 'Prix de vente'),
      minStock: quantity(input.minStock ?? 0, 'Seuil minimum') / 1000,
      location: string(input.location, 'Emplacement', 160, false), notes: string(input.notes, 'Notes', 3000, false),
      color, photo, version: (previous?.version || 0) + 1
    };
    this.put('products', product);
    for (const store of this.all('stores')) this.db.prepare('INSERT OR IGNORE INTO stocks(product_id,store_id,quantity,version) VALUES(?,?,0,1)').run(id, store.id);
  }
  saveContact(input) {
    const id = input.id ? string(input.id, 'Identifiant', 120) : randomUUID();
    if (!['customer', 'supplier'].includes(input.type)) fail('Type de tiers invalide.');
    const previous = this.get('contacts', id);
    if (previous && previous.type !== input.type && this.all('documents').some(document => document.contactId === id)) fail('Un tiers associé à des documents ne peut pas changer de type. Créez une fiche séparée pour le nouveau rôle.', 'CONTACT_TYPE_IN_USE', 409);
    this.put('contacts', { id, type: input.type, name: string(input.name, 'Nom', 160), phone: string(input.phone, 'Téléphone', 50, false), address: string(input.address, 'Adresse', 500, false), taxId: string(input.taxId, 'Identifiant fiscal', 100, false) });
  }
  stock(productId, storeId) {
    return this.db.prepare('SELECT quantity,version FROM stocks WHERE product_id=? AND store_id=?').get(productId, storeId) || { quantity: 0, version: 0 };
  }
  move(productId, storeId, delta) {
    const current = this.stock(productId, storeId);
    const next = current.quantity + delta;
    if (next < 0) fail(`Stock insuffisant pour ${this.need('products', productId, 'Article').name}.`, 'INSUFFICIENT_STOCK', 409);
    if (!Number.isSafeInteger(next) || next > 1_000_000_000_000) fail('Quantité de stock trop importante.');
    this.db.prepare('INSERT INTO stocks(product_id,store_id,quantity,version) VALUES(?,?,?,?) ON CONFLICT(product_id,store_id) DO UPDATE SET quantity=excluded.quantity,version=excluded.version').run(productId, storeId, next, current.version + 1);
  }
  nextNumber(type) {
    const prefix = { sale: 'VEN', purchase: 'ACH', transfer: 'TRA', adjustment: 'AJU' }[type];
    return `${prefix}-${businessDate().slice(0, 4)}-${String(this.all('documents').filter(doc => doc.type === type).length + 1).padStart(4, '0')}`;
  }
  createDocument(user, input) {
    const type = input.type;
    if (!['sale', 'purchase', 'transfer', 'adjustment'].includes(type)) fail('Type de document invalide.');
    const storeId = this.need('stores', input.storeId, 'Magasin').id;
    const toStoreId = type === 'transfer' ? this.need('stores', input.toStoreId, 'Magasin de destination').id : null;
    if (toStoreId === storeId) fail('Choisissez deux magasins distincts pour un transfert.');
    let contactId = null;
    if (input.contactId) {
      const contact = this.need('contacts', input.contactId, 'Tiers');
      if ((type === 'sale' && contact.type !== 'customer') || (type === 'purchase' && contact.type !== 'supplier') || !['sale', 'purchase'].includes(type)) fail('Le tiers ne correspond pas au document.');
      contactId = contact.id;
    }
    if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 500) fail('Ajoutez entre 1 et 500 articles.');
    const unique = new Set();
    const lines = input.lines.map(line => {
      const product = this.need('products', line.productId, 'Article');
      if (unique.has(product.id)) fail('Un article ne peut figurer qu’une fois dans le document.');
      unique.add(product.id);
      const scaled = quantity(line.quantity, 'Quantité', type === 'adjustment');
      if (scaled === 0) fail('Une quantité ne peut pas être nulle.');
      const financial = type === 'sale' || type === 'purchase';
      const unitPrice = financial ? integer(line.unitPrice ?? (type === 'sale' ? product.sellingPrice : product.purchasePrice), 'Prix unitaire') : 0;
      const item = { productId: product.id, quantity: scaled / 1000, unitPrice, purchaseCost: type === 'purchase' ? unitPrice : product.purchasePrice, name: product.name, sku: product.sku, unit: product.unit };
      if (type === 'sale' || type === 'transfer') this.move(product.id, storeId, -scaled);
      else this.move(product.id, storeId, scaled);
      if (type === 'transfer') this.move(product.id, toStoreId, scaled);
      return item;
    });
    const total = lines.reduce((sum, line) => sum + Math.round(line.quantity * line.unitPrice), 0);
    integer(total, 'Total');
    const paid = integer(input.paid ?? 0, 'Montant payé');
    if (paid > total) fail('Le paiement ne peut pas dépasser le total.', 'OVERPAYMENT');
    if (paid < total && !contactId) fail('Choisissez un client ou fournisseur pour suivre le solde impayé.', 'CONTACT_REQUIRED');
    const docDate = date(input.date);
    const payments = paid ? [{ id: randomUUID(), amount: paid, date: docDate, createdBy: user.id, createdAt: new Date().toISOString() }] : [];
    const doc = { id: randomUUID(), number: this.nextNumber(type), type, storeId, toStoreId, contactId, lines, total, paid, payments, note: string(input.note, 'Note', 3000, false), date: docDate, createdAt: new Date().toISOString(), createdBy: user.id };
    this.put('documents', doc);
  }
  createPayment(user, input) {
    const doc = this.need('documents', input.documentId, 'Document');
    if (!['sale', 'purchase'].includes(doc.type)) fail('Ce document ne peut pas recevoir de paiement.');
    const amount = integer(input.amount, 'Montant');
    if (amount === 0) fail('Le paiement doit être supérieur à zéro.');
    if (doc.paid + amount > doc.total) fail('Le paiement dépasse le solde restant.', 'OVERPAYMENT');
    doc.paid += amount;
    doc.payments.push({ id: randomUUID(), amount, date: date(input.date), createdBy: user.id, createdAt: new Date().toISOString() });
    this.put('documents', doc);
  }
  createInventory(user, input) {
    const storeId = this.need('stores', input.storeId, 'Magasin').id;
    const category = string(input.category, 'Catégorie', 160, false);
    const products = this.all('products').filter(product => !category || product.category === category || product.category.startsWith(`${category} / `));
    if (!products.length) fail('Aucun article ne correspond à cette sélection.');
    const lines = products.map(product => { const stock = this.stock(product.id, storeId); return { productId: product.id, theoretical: stock.quantity / 1000, counted: null, stockVersion: stock.version }; });
    this.put('inventories', { id: randomUUID(), name: string(input.name, 'Nom de l’inventaire', 160), storeId, category, status: 'draft', createdAt: new Date().toISOString(), createdBy: user.id, lines });
  }
  countInventory(input) {
    const session = this.need('inventories', input.inventoryId, 'Inventaire');
    if (session.status !== 'draft') fail('Cet inventaire est déjà validé.', 'INVENTORY_CLOSED', 409);
    if (!Array.isArray(input.counts) || !input.counts.length || input.counts.length > 5000) fail('Comptages invalides.');
    const unique = new Set();
    for (const count of input.counts) {
      if (unique.has(count.productId)) fail('Article compté plusieurs fois dans la même commande.');
      unique.add(count.productId);
      const line = session.lines.find(item => item.productId === count.productId);
      if (!line) fail('Cet article ne fait pas partie de l’inventaire.');
      line.counted = quantity(count.quantity) / 1000;
    }
    this.put('inventories', session);
  }
  validateInventory(user, input) {
    const session = this.need('inventories', input.inventoryId, 'Inventaire');
    if (session.status !== 'draft') fail('Cet inventaire est déjà validé.', 'INVENTORY_CLOSED', 409);
    if (session.lines.some(line => line.counted === null)) fail('Comptez tous les articles avant la validation.', 'INVENTORY_INCOMPLETE');
    for (const line of session.lines) if (this.stock(line.productId, session.storeId).version !== line.stockVersion) fail('Le stock a changé depuis le début du comptage. Créez un nouvel inventaire pour éviter d’écraser ces mouvements.', 'INVENTORY_CONFLICT', 409);
    const lines = [];
    for (const line of session.lines) {
      const delta = quantity(line.counted) - quantity(line.theoretical);
      if (delta) {
        this.move(line.productId, session.storeId, delta);
        const product = this.need('products', line.productId, 'Article');
        lines.push({ productId: line.productId, quantity: delta / 1000, unitPrice: 0, purchaseCost: product.purchasePrice, name: product.name, sku: product.sku, unit: product.unit });
      }
    }
    session.status = 'validated'; session.validatedAt = new Date().toISOString(); session.validatedBy = user.id;
    if (lines.length) {
      const doc = { id: randomUUID(), number: this.nextNumber('adjustment'), type: 'adjustment', storeId: session.storeId, toStoreId: null, contactId: null, lines, total: 0, paid: 0, payments: [], note: `Inventaire : ${session.name}`, date: date(), createdAt: new Date().toISOString(), createdBy: user.id, inventoryId: session.id };
      this.put('documents', doc); session.documentId = doc.id;
    }
    this.put('inventories', session);
  }
  createExpense(user, input) {
    this.put('expenses', { id: randomUUID(), storeId: this.need('stores', input.storeId, 'Magasin').id, category: string(input.category, 'Catégorie de frais', 100), amount: integer(input.amount, 'Montant'), date: date(input.date), note: string(input.note, 'Note', 2000, false), createdBy: user.id, createdAt: new Date().toISOString() });
  }
  updateSettings(input) {
    if (typeof input.noPrices !== 'boolean') fail('Le mode sans prix doit être booléen.');
    this.put('settings', { id: 'main', currency: 'XOF', noPrices: input.noPrices, businessName: string(input.businessName, 'Nom du commerce', 160) });
  }
  seed() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.production) {
        if (!this.all('stores').length) this.put('stores', { id: 'store-main', name: 'Magasin principal', city: '' });
        this.put('settings', { id: 'main', currency: 'XOF', noPrices: false, businessName: 'Comptoir' });
        this.db.exec('COMMIT'); return;
      }
      const stores = [{ id: 'store-centre', name: 'Boutique du Centre', city: 'Cotonou' }, { id: 'store-nord', name: 'Boutique du Nord', city: 'Porto-Novo' }, { id: 'store-depot', name: 'Dépôt principal', city: 'Cotonou' }];
      stores.forEach(store => this.put('stores', store));
      const articles = [
        ['riz', 'Riz parfumé 5 kg', 'ALI-RIZ-005', 'Épicerie / Céréales', 'Royal', 'sac', 3200, 4500, 20, 'A1', '#f4e4c8', [36, 14, 120]],
        ['huile', 'Huile de tournesol 1 L', 'ALI-HUI-001', 'Épicerie / Huiles', 'Lesieur', 'bouteille', 1150, 1600, 15, 'A2', '#f5e9b2', [9, 26, 80]],
        ['sucre', 'Sucre blanc 1 kg', 'ALI-SUC-001', 'Épicerie / Céréales', 'Sucrivoire', 'sachet', 600, 850, 20, 'A3', '#f2e3ed', [48, 18, 100]],
        ['lait', 'Lait en poudre 400 g', 'ALI-LAI-400', 'Épicerie / Petit déjeuner', 'Nido', 'boîte', 2200, 2900, 12, 'B1', '#e5ebd2', [7, 16, 45]],
        ['cafe', 'Café instantané 100 g', 'ALI-CAF-100', 'Épicerie / Petit déjeuner', 'Nescafé', 'pot', 1800, 2500, 10, 'B2', '#e4d8cf', [25, 12, 40]],
        ['eau', 'Eau minérale 1,5 L', 'BOI-EAU-150', 'Boissons / Eaux', 'Awa', 'bouteille', 250, 400, 30, 'C1', '#d5e7eb', [96, 42, 240]],
        ['jus', 'Jus de mangue 1 L', 'BOI-JUS-001', 'Boissons / Jus', 'Ivorio', 'brique', 650, 1000, 15, 'C2', '#f3dfc2', [22, 8, 60]],
        ['savon', 'Savon de Marseille 200 g', 'HYG-SAV-200', 'Hygiène / Corps', 'Le Chat', 'pièce', 450, 700, 15, 'D1', '#d5e4d4', [12, 20, 100]],
        ['lessive', 'Lessive en poudre 1 kg', 'ENT-LES-001', 'Entretien / Linge', 'Omo', 'sachet', 950, 1400, 10, 'D2', '#dbdeed', [32, 15, 65]],
        ['farine', 'Farine de blé', 'ALI-FAR-VRA', 'Épicerie / Céréales', 'Les Grands Moulins', 'kg', 400, 600, 25, 'A4', '#ece3d5', [42.5, 21.75, 180]]
      ];
      for (const [key, name, sku, category, brand, unit, purchasePrice, sellingPrice, minStock, location, color, quantities] of articles) {
        const id = `product-${key}`;
        this.put('products', { id, name, sku, category, brand, tags: category.startsWith('Épicerie') ? ['alimentaire'] : [], unit, purchasePrice, sellingPrice, minStock, location, color, photo: '', notes: '', version: 1 });
        stores.forEach((store, index) => this.db.prepare('INSERT INTO stocks(product_id,store_id,quantity,version) VALUES(?,?,?,1)').run(id, store.id, Math.round(quantities[index] * 1000)));
      }
      const contacts = [
        { id: 'customer-awa', type: 'customer', name: 'Awa Coulibaly', phone: '+229 01 97 12 34 56', address: 'Cadjèhoun, Cotonou', taxId: '' },
        { id: 'customer-restaurant', type: 'customer', name: 'Restaurant Le Palmier', phone: '+229 01 96 54 32 10', address: 'Ganhi, Cotonou', taxId: 'EXEMPLE-IFU-001' },
        { id: 'supplier-sodico', type: 'supplier', name: 'Sodico Distribution', phone: '+229 01 21 00 11 22', address: 'Akpakpa, Cotonou', taxId: 'EXEMPLE-IFU-002' },
        { id: 'supplier-moulins', type: 'supplier', name: 'Les Grands Moulins', phone: '+229 01 21 30 40 50', address: 'Port de Cotonou', taxId: 'EXEMPLE-IFU-003' }
      ];
      contacts.forEach(contact => this.put('contacts', contact));
      this.put('settings', { id: 'main', currency: 'XOF', noPrices: false, businessName: 'Comptoir' });
      if (!this.production) this.seedHistory();
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  seedHistory() {
    const user = publicUser(this.db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get());
    const day = businessDate;
    const entries = [
      { type: 'purchase', storeId: 'store-depot', contactId: 'supplier-sodico', lines: [{ productId: 'product-riz', quantity: 30, unitPrice: 3200 }, { productId: 'product-huile', quantity: 20, unitPrice: 1150 }], paid: 80000, date: day(-5), note: 'Réapprovisionnement hebdomadaire' },
      { type: 'sale', storeId: 'store-centre', contactId: 'customer-restaurant', lines: [{ productId: 'product-riz', quantity: 5, unitPrice: 4500 }, { productId: 'product-huile', quantity: 3, unitPrice: 1600 }], paid: 15000, date: day(-2), note: 'Livraison au restaurant' },
      { type: 'sale', storeId: 'store-centre', lines: [{ productId: 'product-cafe', quantity: 2, unitPrice: 2500 }, { productId: 'product-eau', quantity: 6, unitPrice: 400 }], paid: 7400, date: day(-1), note: 'Vente comptoir' },
      { type: 'transfer', storeId: 'store-depot', toStoreId: 'store-nord', lines: [{ productId: 'product-savon', quantity: 12 }, { productId: 'product-jus', quantity: 8 }], date: day(-1), note: 'Mise en rayon Nord' },
      { type: 'sale', storeId: 'store-nord', contactId: 'customer-awa', lines: [{ productId: 'product-sucre', quantity: 4, unitPrice: 850 }, { productId: 'product-farine', quantity: 2.5, unitPrice: 600 }], paid: 4900, date: day(), note: 'Vente du jour' }
    ];
    entries.forEach(entry => this.createDocument(user, entry));
    this.createExpense(user, { storeId: 'store-centre', category: 'Transport', amount: 3500, date: day(-2), note: 'Livraison clients' });
    this.createExpense(user, { storeId: 'store-centre', category: 'Électricité', amount: 18000, date: day(-3), note: 'Facture mensuelle' });
  }
}

module.exports = { StockService, AppError };
