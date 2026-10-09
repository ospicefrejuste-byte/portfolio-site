/* Local demonstration engine. Roles are simulated; this provides no authentication. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('../lib/reversals') : root.ComptoirReversals);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ComptoirDemoCore = api.DemoCore;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (reversals) {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const now = () => new Date().toISOString();
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Porto-Novo', year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = () => formatter.format(new Date(Date.now()));
  const uuid = () => globalThis.crypto?.randomUUID?.() || `demo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  class DemoError extends Error {
    constructor(message, code = 'INVALID_INPUT', status = 400) { super(message); this.code = code; this.status = status; }
  }
  const fail = (message, code, status) => { throw new DemoError(message, code, status); };
  function text(value, label, max = 200, required = true) {
    if (value == null && !required) return '';
    if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) fail(`${label} invalide.`);
    return value.trim();
  }
  function amount(value, label = 'Montant') {
    if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_000) fail(`${label} doit être un entier positif ou nul.`);
    return value;
  }
  function ticks(value, signed = false) {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1_000_000_000 || (!signed && value < 0)) fail('Quantité invalide.');
    const result = Math.round(value * 1000);
    if (Math.abs(result / 1000 - value) > 1e-8) fail('La quantité accepte au maximum trois décimales.');
    return result;
  }
  function day(value) {
    const result = value || today();
    if (typeof result !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result) fail('Date invalide.');
    return result;
  }
  function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  }
  class DemoCore {
    constructor(seed) {
      if (!seed || typeof seed !== 'object') fail('Sauvegarde de démonstration invalide.');
      this.data = {};
      for (const name of ['products', 'stores', 'stocks', 'documents', 'contacts', 'inventories', 'expenses']) {
        if (!Array.isArray(seed[name])) fail(`Données ${name} invalides.`);
        this.data[name] = copy(seed[name]);
      }
      this.data.settings = copy(seed.settings || { currency: 'XOF', noPrices: false, businessName: 'Comptoir' });
      this.data.stores.forEach(store => { store.version ||= 1; });
      this.data.stocks.forEach(stock => { stock.quantity = ticks(stock.quantity); });
      this.commands = new Map((seed._commands || []).map(command => [command.id, copy(command)]));
    }
    all(table) { return this.data[table]; }
    get(table, id) { return this.data[table].find(item => item.id === id); }
    need(table, id, label) {
      const entity = typeof id === 'string' && this.data[table].find(item => item.id === id);
      if (!entity) fail(`${label} introuvable.`, 'NOT_FOUND', 404);
      return entity;
    }
    put(table, entity) {
      const index = this.data[table].findIndex(item => item.id === entity.id);
      if (index < 0) this.data[table].push(entity); else this.data[table][index] = entity;
    }
    role(user) {
      if (!user || typeof user.id !== 'string') fail('Choisissez un profil de démonstration.', 'UNAUTHORIZED', 401);
      if (!['admin', 'cashier', 'inventory'].includes(user.role)) fail('Profil de démonstration invalide.', 'FORBIDDEN', 403);
    }
    state(user) {
      this.role(user);
      const result = this.exportState(); delete result._commands;
      result.user = copy(user);
      if (user.role !== 'admin') {
        result.products.forEach(product => { delete product.purchasePrice; if (user.role === 'inventory') delete product.sellingPrice; });
        result.expenses = [];
        if (user.role === 'inventory') { result.documents = []; result.contacts = []; }
        else {
          result.inventories = [];
          result.contacts = result.contacts.filter(contact => contact.type === 'customer');
          result.documents = result.documents.filter(document => document.type === 'sale' && !document.reversalOf);
          result.documents.forEach(document => document.lines.forEach(line => { delete line.purchaseCost; }));
        }
      }
      return result;
    }
    exportState() {
      const result = copy(this.data);
      result.stocks.forEach(stock => { stock.quantity /= 1000; });
      result._commands = [...this.commands.values()].map(copy);
      return result;
    }
    authorize(user, type, payload) {
      this.role(user);
      if (user.role === 'admin') return;
      if (user.role === 'cashier' && type === 'document.create' && payload.type === 'sale') return;
      if (user.role === 'cashier' && type === 'payment.create' && this.need('documents', payload.documentId, 'Document').type === 'sale') return;
      if (user.role === 'inventory' && ['inventory.create', 'inventory.count'].includes(type)) return;
      fail('Cette action nécessite un autre profil de démonstration.', 'FORBIDDEN', 403);
    }
    command(user, input) {
      if (!input || typeof input !== 'object') fail('Commande invalide.');
      const id = text(input.id, 'Identifiant de commande', 120), type = text(input.type, 'Type', 60);
      if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) fail('Données de commande invalides.');
      let payload;
      try { payload = copy(input.payload); } catch { fail('Données de commande invalides.'); }
      this.authorize(user, type, payload);
      const signature = canonical({ type, payload }), previous = this.commands.get(id);
      if (previous) {
        if (previous.userId !== user.id || previous.signature !== signature) fail('Cet identifiant est déjà utilisé pour une autre opération.', 'IDEMPOTENCY_CONFLICT', 409);
        return { ok: true, duplicate: true };
      }
      const handlers = {
        'product.save': () => this.product(payload), 'contact.save': () => this.contact(payload),
        'document.create': () => this.document(user, payload), 'payment.create': () => this.payment(user, payload),
        'inventory.create': () => this.inventory(user, payload), 'inventory.count': () => this.count(payload),
        'inventory.validate': () => this.validate(user, payload), 'expense.create': () => this.expense(user, payload),
        'settings.update': () => this.settings(payload), 'store.save': () => this.store(payload),
        'document.cancel': () => reversals.cancelDocument(this,user,payload)
      };
      if (!Object.hasOwn(handlers, type)) fail('Type de commande inconnu.', 'UNKNOWN_COMMAND');
      const before = copy(this.data);
      try {
        handlers[type]();
        this.commands.set(id, { id, userId: user.id, signature, createdAt: now() });
        return { ok: true };
      } catch (error) { this.data = before; throw error; }
    }
    store(input) {
      const id = input.id ? text(input.id,'Identifiant',120) : uuid(), previous = this.get('stores',id);
      if (previous && input.expectedVersion !== previous.version) fail('Ce magasin a changé. Actualisez les données.','VERSION_CONFLICT',409);
      if (!previous && input.expectedVersion != null && input.expectedVersion !== 0) fail('Ce magasin n’existe plus.','VERSION_CONFLICT',409);
      const name = text(input.name,'Nom du magasin',160), city = text(input.city,'Ville',160,false);
      if (this.data.stores.some(store => store.id !== id && store.name.toLocaleLowerCase() === name.toLocaleLowerCase())) fail('Un magasin porte déjà ce nom.','DUPLICATE_STORE',409);
      this.put('stores',{...previous,id,name,city,address:text(input.address ?? previous?.address,'Adresse',500,false),phone:text(input.phone ?? previous?.phone,'Téléphone',50,false),taxId:text(input.taxId ?? previous?.taxId,'IFU',100,false),version:(previous?.version || 0)+1});
      this.data.products.forEach(product => { if (!this.data.stocks.some(stock => stock.productId === product.id && stock.storeId === id)) this.data.stocks.push({productId:product.id,storeId:id,quantity:0,version:1}); });
    }
    product(input) {
      const id = input.id ? text(input.id, 'Identifiant', 120) : uuid(), previous = this.data.products.find(product => product.id === id);
      if (previous && input.expectedVersion !== previous.version) fail('Cet article a changé. Actualisez les données.', 'VERSION_CONFLICT', 409);
      if (!previous && input.expectedVersion != null && input.expectedVersion !== 0) fail('Cet article n’existe plus.', 'VERSION_CONFLICT', 409);
      const sku = text(input.sku, 'Référence', 100), unit = text(input.unit || 'pièce', 'Unité', 30);
      if (this.data.products.some(product => product.id !== id && product.sku.toLocaleLowerCase() === sku.toLocaleLowerCase())) fail('Cette référence existe déjà.', 'DUPLICATE_SKU', 409);
      if (previous && previous.unit !== unit && (this.data.stocks.some(stock => stock.productId === id && stock.quantity > 0) || this.data.documents.some(document => document.lines.some(line => line.productId === id)) || this.data.inventories.some(inventory => inventory.lines.some(line => line.productId === id)))) fail('L’unité d’un article déjà utilisé ne peut pas changer.', 'UNIT_IN_USE', 409);
      const tags = input.tags ?? [], color = input.color || '#dde8e0', photo = text(input.photo, 'Photo', 7_000_000, false);
      if (!Array.isArray(tags) || tags.length > 30) fail('Tags invalides.');
      if (!/^#[0-9a-f]{6}$/i.test(color)) fail('Couleur invalide.');
      if (photo && !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(photo)) fail('Photo de démonstration invalide.');
      if (photo) { try { atob(photo.slice(photo.indexOf(',') + 1)); } catch { fail('Photo de démonstration invalide.'); } }
      this.put('products', { id, name: text(input.name, 'Nom', 160), sku, category: text(input.category, 'Catégorie', 160, false), brand: text(input.brand, 'Marque', 100, false), unit,
        tags: tags.map(tag => text(tag, 'Tag', 60)), purchasePrice: amount(input.purchasePrice ?? previous?.purchasePrice ?? 0, 'Prix d’achat'), sellingPrice: amount(input.sellingPrice ?? previous?.sellingPrice ?? 0, 'Prix de vente'),
        minStock: ticks(input.minStock ?? 0) / 1000, location: text(input.location, 'Emplacement', 160, false), notes: text(input.notes, 'Notes', 3000, false), color, photo, version: (previous?.version || 0) + 1 });
      this.data.stores.forEach(store => { if (!this.data.stocks.some(stock => stock.productId === id && stock.storeId === store.id)) this.data.stocks.push({ productId: id, storeId: store.id, quantity: 0, version: 1 }); });
    }
    contact(input) {
      const id = input.id ? text(input.id, 'Identifiant', 120) : uuid(), previous = this.data.contacts.find(contact => contact.id === id);
      if (!['customer', 'supplier'].includes(input.type)) fail('Type de tiers invalide.');
      if (previous && previous.type !== input.type && this.data.documents.some(document => document.contactId === id)) fail('Un tiers documenté ne peut pas changer de type.', 'CONTACT_TYPE_IN_USE', 409);
      this.put('contacts', { id, type: input.type, name: text(input.name, 'Nom', 160), phone: text(input.phone, 'Téléphone', 50, false), address: text(input.address, 'Adresse', 500, false), taxId: text(input.taxId, 'IFU', 100, false) });
    }
    stock(productId, storeId) { return this.data.stocks.find(stock => stock.productId === productId && stock.storeId === storeId) || { productId, storeId, quantity: 0, version: 0 }; }
    move(productId, storeId, delta) {
      const stock = this.stock(productId, storeId), next = stock.quantity + delta;
      if (next < 0) fail(`Stock insuffisant pour ${this.need('products', productId, 'Article').name}.`, 'INSUFFICIENT_STOCK', 409);
      if (!Number.isSafeInteger(next) || next > 1_000_000_000_000) fail('Quantité de stock trop importante.');
      if (!this.data.stocks.includes(stock)) this.data.stocks.push(stock);
      stock.quantity = next; stock.version++;
    }
    number(type) {
      const prefix = { sale: 'VEN', purchase: 'ACH', transfer: 'TRA', adjustment: 'AJU' }[type];
      return `${prefix}-${today().slice(0, 4)}-${String(this.data.documents.filter(document => document.type === type).length + 1).padStart(4, '0')}`;
    }
    document(user, input) {
      const type = input.type;
      if (!['sale', 'purchase', 'transfer', 'adjustment'].includes(type)) fail('Type de document invalide.');
      const storeId = this.need('stores', input.storeId, 'Magasin').id, toStoreId = type === 'transfer' ? this.need('stores', input.toStoreId, 'Destination').id : null;
      if (storeId === toStoreId) fail('Un transfert nécessite deux magasins distincts.');
      let contactId = null;
      if (input.contactId) {
        const contact = this.need('contacts', input.contactId, 'Tiers');
        if (!['sale', 'purchase'].includes(type) || contact.type !== (type === 'sale' ? 'customer' : 'supplier')) fail('Le tiers ne correspond pas au document.');
        contactId = contact.id;
      }
      if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 500) fail('Ajoutez entre 1 et 500 articles.');
      const unique = new Set(), financial = ['sale', 'purchase'].includes(type);
      const lines = input.lines.map(line => {
        const product = this.need('products', line.productId, 'Article'), quantity = ticks(line.quantity, type === 'adjustment');
        if (!quantity) fail('Une quantité ne peut pas être nulle.');
        if (unique.has(product.id)) fail('Un article ne peut figurer qu’une fois dans le document.'); unique.add(product.id);
        const unitPrice = financial ? amount(line.unitPrice ?? (type === 'sale' ? product.sellingPrice : product.purchasePrice), 'Prix unitaire') : 0;
        this.move(product.id, storeId, ['sale', 'transfer'].includes(type) ? -quantity : quantity);
        if (type === 'transfer') this.move(product.id, toStoreId, quantity);
        return { productId: product.id, quantity: quantity / 1000, unitPrice, purchaseCost: type === 'purchase' ? unitPrice : product.purchasePrice, name: product.name, sku: product.sku, unit: product.unit };
      });
      const total = amount(lines.reduce((sum, line) => sum + Math.round(line.quantity * line.unitPrice), 0), 'Total'), paid = amount(input.paid ?? 0, 'Montant payé');
      if (paid > total) fail('Le paiement dépasse le total.', 'OVERPAYMENT');
      if (paid < total && !contactId) fail('Choisissez un tiers pour suivre le solde impayé.', 'CONTACT_REQUIRED');
      const date = day(input.date), payments = paid ? [{ id: uuid(), amount: paid, date, createdBy: user.id, createdAt: now() }] : [];
      this.put('documents', { id: uuid(), number: this.number(type), type, storeId, toStoreId, contactId, lines, total, paid, payments, note: text(input.note, 'Note', 3000, false), date, createdAt: now(), createdBy: user.id });
    }
    payment(user, input) {
      const document = this.need('documents', input.documentId, 'Document'), value = amount(input.amount);
      if (document.status === 'cancelled' || document.reversalOf) fail('Un document annulé ne reçoit plus de paiement.','DOCUMENT_CANCELLED',409);
      if (!['sale', 'purchase'].includes(document.type)) fail('Ce document ne reçoit pas de paiement.');
      if (!value) fail('Le paiement doit être supérieur à zéro.');
      if (document.paid + value > document.total) fail('Le paiement dépasse le solde restant.', 'OVERPAYMENT');
      document.payments.push({ id: uuid(), amount: value, date: day(input.date), createdBy: user.id, createdAt: now() }); document.paid += value;
    }
    inventory(user, input) {
      const storeId = this.need('stores', input.storeId, 'Magasin').id, category = text(input.category, 'Catégorie', 160, false);
      const products = this.data.products.filter(product => !category || product.category === category || product.category.startsWith(`${category} / `));
      if (!products.length) fail('Aucun article ne correspond à cette sélection.');
      const lines = products.map(product => { const stock = this.stock(product.id, storeId); return { productId: product.id, theoretical: stock.quantity / 1000, counted: null, stockVersion: stock.version }; });
      this.put('inventories', { id: uuid(), name: text(input.name, 'Nom de l’inventaire', 160), storeId, category, status: 'draft', createdAt: now(), createdBy: user.id, lines });
    }
    count(input) {
      const inventory = this.need('inventories', input.inventoryId, 'Inventaire');
      if (inventory.status !== 'draft') fail('Cet inventaire est déjà validé.', 'INVENTORY_CLOSED', 409);
      if (!Array.isArray(input.counts) || !input.counts.length || input.counts.length > 5000) fail('Comptages invalides.');
      const unique = new Set();
      input.counts.forEach(count => {
        if (unique.has(count.productId)) fail('Article compté plusieurs fois.'); unique.add(count.productId);
        const line = inventory.lines.find(item => item.productId === count.productId);
        if (!line) fail('Cet article ne fait pas partie de l’inventaire.'); line.counted = ticks(count.quantity) / 1000;
      });
    }
    validate(user, input) {
      const inventory = this.need('inventories', input.inventoryId, 'Inventaire');
      if (inventory.status !== 'draft') fail('Cet inventaire est déjà validé.', 'INVENTORY_CLOSED', 409);
      if (inventory.lines.some(line => line.counted === null)) fail('Comptez tous les articles avant de valider.', 'INVENTORY_INCOMPLETE');
      if (inventory.lines.some(line => this.stock(line.productId, inventory.storeId).version !== line.stockVersion)) fail('Le stock a changé depuis le début du comptage. Créez un nouvel inventaire.', 'INVENTORY_CONFLICT', 409);
      const lines = [];
      inventory.lines.forEach(line => {
        const delta = ticks(line.counted) - ticks(line.theoretical);
        if (!delta) return;
        const product = this.need('products', line.productId, 'Article'); this.move(line.productId, inventory.storeId, delta);
        lines.push({ productId: product.id, quantity: delta / 1000, unitPrice: 0, purchaseCost: product.purchasePrice, name: product.name, sku: product.sku, unit: product.unit });
      });
      inventory.status = 'validated'; inventory.validatedAt = now(); inventory.validatedBy = user.id;
      if (lines.length) {
        const document = { id: uuid(), number: this.number('adjustment'), type: 'adjustment', storeId: inventory.storeId, toStoreId: null, contactId: null, lines, total: 0, paid: 0, payments: [], note: `Inventaire : ${inventory.name}`, date: day(), createdAt: now(), createdBy: user.id, inventoryId: inventory.id };
        this.put('documents', document); inventory.documentId = document.id;
      }
    }
    expense(user, input) {
      this.put('expenses', { id: uuid(), storeId: this.need('stores', input.storeId, 'Magasin').id, category: text(input.category, 'Catégorie', 100), amount: amount(input.amount), date: day(input.date), note: text(input.note, 'Note', 2000, false), createdBy: user.id, createdAt: now() });
    }
    settings(input) {
      if (typeof input.noPrices !== 'boolean') fail('Le mode sans prix doit être booléen.');
      this.data.settings = { id: 'main', currency: 'XOF', noPrices: input.noPrices, businessName: text(input.businessName, 'Nom du commerce', 160) };
    }
  }
  return { DemoCore, DemoError };
});
