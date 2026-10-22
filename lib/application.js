"use strict";
const express = require("express");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { createSqlite, createPostgres } = require("./store");
const { fail, hashPassword, verifyPassword, digest, sameSecret, clean, username, day, quantity, money, valuation, uuid, version, csv } = require("./security");
const CATEGORIES = ["Animaux", "Cultures et récoltes", "Aliments et intrants", "Matériel", "Autres"];
const DEFAULT_SETTINGS = { name: "Ferme ADEOYE", description: "Un espace partagé pour suivre l’inventaire et la vie de la ferme.", location: "", currency: "XOF", timezone: "Africa/Porto-Novo" };
const SESSION_MS = 8 * 60 * 60 * 1000;
const now = () => new Date().toISOString();
const safeUser = row => ({ id: row.id, username: row.username, role: row.role, mustChangePassword: Boolean(row.must_change), enabled: Boolean(row.enabled) });
const itemValue = row => row && ({ id: row.id, name: row.name, category: row.category, unit: row.unit, location: row.location, quantity: Number(row.quantity_milli) / 1000, minQuantity: Number(row.min_quantity_milli) / 1000, unitValue: Number(row.unit_value), estimatedValue: valuation(Number(row.quantity_milli), Number(row.unit_value)), notes: row.notes, active: Boolean(row.active), version: Number(row.version), createdAt: row.created_at, updatedAt: row.updated_at });
const movementValue = row => ({ id: row.id, itemId: row.item_id, itemName: row.item_name, unit: row.unit, type: row.type, quantity: Number(row.quantity_milli) / 1000, balanceAfter: Number(row.balance_milli) / 1000, reason: row.reason, date: row.date, createdAt: row.created_at, createdBy: row.created_by, reference: row.reference });
const noteValue = row => ({ id: row.id, title: row.title, body: row.body, date: row.date, createdAt: row.created_at, createdBy: row.created_by });
async function createApplication(options = {}) {
  const dataDir = options.dataDir || process.env.ADEOYE_DATA_DIR || path.resolve(__dirname, "../.data");
  const production = options.production ?? process.env.NODE_ENV === "production";
  const publicDir = options.publicDir || path.resolve(__dirname, "../public");
  const configuredOrigin = options.publicOrigin || process.env.ADEOYE_PUBLIC_ORIGIN;
  let publicOrigin = null;
  if (configuredOrigin) {
    const url = new URL(configuredOrigin);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) throw Error("ADEOYE_PUBLIC_ORIGIN doit être une adresse HTTPS.");
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw Error("ADEOYE_PUBLIC_ORIGIN doit contenir seulement l’origine du site.");
    publicOrigin = url.origin;
  }
  if (production && !publicOrigin) throw Error("Configurez ADEOYE_PUBLIC_ORIGIN pour l’hébergement.");
  if (production && !options.database && !process.env.ADEOYE_DATABASE_URL) throw Error("Configurez ADEOYE_DATABASE_URL pour conserver les données de production.");
  let setupToken = options.setupToken || process.env.ADEOYE_SETUP_TOKEN;
  if (!setupToken && production) throw Error("Configurez ADEOYE_SETUP_TOKEN pour l’hébergement.");
  if (!setupToken) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const tokenFile = path.join(dataDir, "setup-token");
    try { fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    setupToken = fs.readFileSync(tokenFile, "utf8").trim();
  }
  const db = options.database || (process.env.ADEOYE_DATABASE_URL ? createPostgres() : createSqlite({ dataDir }));
  try {
    await db.transaction(async () => {
    await db.exec(`CREATE TABLE IF NOT EXISTS adeoye_users (id TEXT PRIMARY KEY, username TEXT NOT NULL, canonical_name TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, must_change INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS adeoye_sessions (id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, csrf TEXT NOT NULL, expires BIGINT NOT NULL);
      CREATE INDEX IF NOT EXISTS adeoye_sessions_user ON adeoye_sessions(user_id);
      CREATE TABLE IF NOT EXISTS adeoye_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS adeoye_items (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, unit TEXT NOT NULL, location TEXT NOT NULL, quantity_milli BIGINT NOT NULL, min_quantity_milli BIGINT NOT NULL, unit_value BIGINT NOT NULL, notes TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS adeoye_movements (id TEXT PRIMARY KEY, item_id TEXT NOT NULL, item_name TEXT NOT NULL, unit TEXT NOT NULL, type TEXT NOT NULL, quantity_milli BIGINT NOT NULL, balance_milli BIGINT NOT NULL, reason TEXT NOT NULL, date TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, reference TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS adeoye_movements_item ON adeoye_movements(item_id);
      CREATE TABLE IF NOT EXISTS adeoye_notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, date TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS adeoye_requests (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, result_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS adeoye_limits (key TEXT PRIMARY KEY, hits INTEGER NOT NULL, reset_at BIGINT NOT NULL);`);
    if (db.dialect === "postgres") {
      for (const table of ["users", "sessions", "settings", "items", "movements", "notes", "requests", "limits"]) await db.exec(`ALTER TABLE adeoye_${table} ENABLE ROW LEVEL SECURITY;`);
    }
      await db.prepare("INSERT INTO adeoye_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING").run("farm", JSON.stringify(DEFAULT_SETTINGS));
      await db.prepare("INSERT INTO adeoye_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING").run("updatedAt", JSON.stringify(now()));
    });
    const initialized = Boolean((await db.prepare("SELECT count(*) n FROM adeoye_users").get()).n);
    const dummyPasswordHash = await hashPassword(crypto.randomBytes(32).toString("base64url"));
    const app = express();
    app.disable("x-powered-by");
    app.use((req, res, next) => {
      res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin", "Permissions-Policy": "camera=(), microphone=(), geolocation=()", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" });
      if (production) res.set("Strict-Transport-Security", "max-age=31536000");
      next();
    });
    // serverless-http supplies a completed request with a Buffer body. The
    // standard parser skips completed streams, so validate that body directly
    // with the same limits. Ordinary HTTP requests still use express.json.
    app.use((req, res, next) => {
      if (Buffer.isBuffer(req.body) && !["GET", "HEAD", "OPTIONS"].includes(req.method) && req.path.startsWith("/api/")) {
        if (!req.is("application/json")) throw fail(415, "Envoyez les données au format JSON.");
        const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(req.get("Content-Type") || "")?.[1];
        if (charset && !/^utf-?8$/i.test(charset) || req.get("Content-Encoding") && req.get("Content-Encoding") !== "identity") throw fail(415, "Envoyez un objet JSON non compressé en UTF-8.");
        if (req.body.length > 65536) throw fail(413, "Les données envoyées sont trop volumineuses.");
        try { req.body = JSON.parse(req.body.toString("utf8") || "{}"); }
        catch (_) { throw fail(400, "Les données JSON sont invalides."); }
      }
      next();
    });
    app.use(express.json({ limit: "64kb", strict: true }));
    app.use("/api", (req, res, next) => {
      if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
      const origin = req.get("Origin");
      const expected = publicOrigin || req.protocol + "://" + req.get("host");
      if (origin && origin !== expected || req.get("Sec-Fetch-Site") === "cross-site") throw fail(403, "Origine de la requête refusée.");
      if (!req.is("application/json")) throw fail(415, "Envoyez les données au format JSON.");
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw fail(400, "Les données envoyées doivent être un objet JSON.");
      next();
    });
    async function settings() { return JSON.parse((await db.prepare("SELECT value FROM adeoye_settings WHERE key=?").get("farm")).value); }
    async function touch() { await db.prepare("UPDATE adeoye_settings SET value=? WHERE key=?").run(JSON.stringify(now()), "updatedAt"); }
    async function userCount() { return Number((await db.prepare("SELECT count(*) n FROM adeoye_users").get()).n); }
    function cookie(req) {
      const value = (req.get("Cookie") || "").split(";").map(part => part.trim()).find(part => part.startsWith("adeoye_session="));
      return value ? value.slice("adeoye_session=".length) : "";
    }
    function setCookie(res, token) { res.cookie("adeoye_session", token, { httpOnly: true, secure: production, sameSite: "lax", path: "/", maxAge: SESSION_MS }); }
    async function newSession(user, res) {
      const token = crypto.randomBytes(32).toString("base64url"), csrf = crypto.randomBytes(32).toString("base64url");
      await db.prepare("DELETE FROM adeoye_sessions WHERE expires<?").run(Date.now());
      await db.prepare("INSERT INTO adeoye_sessions (id_hash,user_id,csrf,expires) VALUES (?,?,?,?)").run(digest(token), user.id, csrf, Date.now() + SESSION_MS);
      setCookie(res, token);
      return { user: safeUser(user), csrf };
    }
    async function auth(req, res, next) {
      const token = cookie(req);
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw fail(401, "Connectez-vous pour accéder à cet espace.");
      const session = await db.prepare("SELECT * FROM adeoye_sessions WHERE id_hash=? AND expires>?").get(digest(token), Date.now());
      const user = session && await db.prepare("SELECT * FROM adeoye_users WHERE id=?").get(session.user_id);
      if (!user || !user.enabled) throw fail(401, "Votre session a expiré. Reconnectez-vous.");
      req.user = user;
      req.session = session;
      if (!["GET", "HEAD"].includes(req.method) && !sameSecret(req.get("X-CSRF-Token") || "", session.csrf)) throw fail(403, "La vérification de sécurité a échoué. Actualisez la page.");
      if (user.must_change && req.path.startsWith("/api/") && !["/api/auth/me", "/api/auth/password", "/api/auth/logout"].includes(req.path)) throw fail(403, "Changez votre mot de passe initial pour continuer.");
      next();
    }
    const roles = (...allowed) => (req, res, next) => { if (!allowed.includes(req.user.role)) throw fail(403, "Vous ne disposez pas des droits nécessaires."); next(); };
    const write = roles("admin", "manager"), admin = roles("admin");
    async function rate(req, action, identity, max = 12) {
      const address = req.ip || "unknown";
      await db.transaction(async () => {
        const time = Date.now();
        await db.prepare("DELETE FROM adeoye_limits WHERE reset_at<?").run(time);
        const keys = [digest(action + ":ip:" + address), digest(action + ":name:" + identity)];
        for (const key of keys) {
          const row = await db.prepare("SELECT * FROM adeoye_limits WHERE key=?").get(key);
          if (row && Number(row.hits) >= max) throw fail(429, "Trop de tentatives. Patientez quinze minutes avant de réessayer.");
          if (row) await db.prepare("UPDATE adeoye_limits SET hits=hits+1 WHERE key=?").run(key);
          else await db.prepare("INSERT INTO adeoye_limits (key,hits,reset_at) VALUES (?,?,?)").run(key, 1, time + 15 * 60 * 1000);
        }
      });
    }
    async function findItem(id) { const value = await db.prepare("SELECT * FROM adeoye_items WHERE id=?").get(id); if (!value) throw fail(404, "Cette fiche d’inventaire est introuvable."); return value; }
    async function replay(id, kind, payload) {
      const previous = await db.prepare("SELECT * FROM adeoye_requests WHERE id=?").get(id);
      if (!previous) return null;
      if (previous.kind !== kind || previous.payload !== payload) throw fail(409, "Cette référence correspond déjà à une autre opération. Actualisez les données.");
      return previous;
    }
    async function saveRequest(id, kind, payload, resultId) { await db.prepare("INSERT INTO adeoye_requests (id,kind,payload,result_id) VALUES (?,?,?,?)").run(id, kind, payload, resultId); }
    async function movements() { return (await db.prepare("SELECT * FROM adeoye_movements ORDER BY created_at DESC,id DESC").all()).map(movementValue); }
    async function items() { return (await db.prepare("SELECT * FROM adeoye_items ORDER BY updated_at DESC,id DESC").all()).map(itemValue); }
    async function snapshot() { return db.transaction(async () => ({ items: await items(), movements: await movements(), notes: (await db.prepare("SELECT * FROM adeoye_notes ORDER BY created_at DESC,id DESC").all()).map(noteValue), settings: await settings(), updatedAt: JSON.parse((await db.prepare("SELECT value FROM adeoye_settings WHERE key=?").get("updatedAt")).value) })); }
    app.get("/api/health", (req, res) => res.json({ ok: true }));
    app.get("/api/auth/status", async (req, res) => res.json({ initialized: Boolean(await userCount()) }));
    app.post("/api/auth/setup", async (req, res) => {
      await rate(req, "setup", "setup", 10);
      const result = await db.transaction(async () => {
        if (await userCount()) throw fail(409, "Le compte responsable existe déjà. Connectez-vous.");
        if (!req.body || typeof req.body.token !== "string" || !sameSecret(req.body.token, setupToken)) throw fail(403, "Code d’installation incorrect.");
        const name = username(req.body.username), created = now();
        const user = { id: crypto.randomUUID(), username: name, password_hash: await hashPassword(req.body.password), role: "admin", enabled: 1, must_change: 0, created_at: created, updated_at: created };
        await db.prepare("INSERT INTO adeoye_users (id,username,canonical_name,password_hash,role,enabled,must_change,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(user.id, name, name.toLocaleLowerCase("fr"), user.password_hash, user.role, 1, 0, created, created);
        return newSession(user, res);
      });
      res.json(result);
    });
    app.post("/api/auth/login", async (req, res) => {
      const name = typeof req.body?.username === "string" ? req.body.username.trim().toLocaleLowerCase("fr") : "";
      await rate(req, "login", name);
      const user = await db.prepare("SELECT * FROM adeoye_users WHERE canonical_name=?").get(name);
      const validPassword = await verifyPassword(req.body?.password, user?.password_hash || dummyPasswordHash);
      if (!user || !user.enabled || !validPassword) throw fail(401, "Identifiant ou mot de passe incorrect.");
      const result = await db.transaction(async () => {
        const fresh = await db.prepare("SELECT * FROM adeoye_users WHERE id=?").get(user.id);
        if (!fresh || !fresh.enabled || fresh.password_hash !== user.password_hash) throw fail(401, "Identifiant ou mot de passe incorrect.");
        return newSession(fresh, res);
      });
      res.json(result);
    });
    app.get("/api/auth/me", auth, (req, res) => res.json({ user: safeUser(req.user), csrf: req.session.csrf }));
    app.post("/api/auth/logout", auth, async (req, res) => {
      await db.transaction(async () => { await db.prepare("DELETE FROM adeoye_sessions WHERE id_hash=?").run(req.session.id_hash); });
      res.clearCookie("adeoye_session", { httpOnly: true, secure: production, sameSite: "lax", path: "/" }); res.json({ ok: true });
    });
    app.post("/api/auth/password", auth, async (req, res) => {
      await rate(req, "password", req.user.id, 12);
      if (!await verifyPassword(req.body?.currentPassword, req.user.password_hash)) throw fail(403, "Le mot de passe actuel est incorrect.");
      if (req.body.password === req.body.currentPassword) throw fail(400, "Choisissez un nouveau mot de passe différent.");
      const hashed = await hashPassword(req.body.password);
      const result = await db.transaction(async () => {
        const fresh = await db.prepare("SELECT * FROM adeoye_users WHERE id=?").get(req.user.id);
        if (!fresh || !fresh.enabled || fresh.password_hash !== req.user.password_hash) throw fail(409, "Le compte a changé. Reconnectez-vous.");
        await db.prepare("UPDATE adeoye_users SET password_hash=?,must_change=0,updated_at=? WHERE id=?").run(hashed, now(), fresh.id);
        await db.prepare("DELETE FROM adeoye_sessions WHERE user_id=?").run(fresh.id);
        return newSession({ ...fresh, password_hash: hashed, must_change: 0 }, res);
      });
      res.json(result);
    });
    app.get("/api/settings", async (req, res) => res.json(await settings()));
    app.put("/api/settings", auth, admin, async (req, res) => {
      const value = { name: clean(req.body.name, "Nom de la ferme", 120), description: clean(req.body.description, "Présentation", 1200, true), location: clean(req.body.location, "Localisation", 200, true), currency: "XOF", timezone: clean(req.body.timezone || "Africa/Porto-Novo", "Fuseau horaire", 60) };
      if (req.body.currency && req.body.currency !== "XOF") throw fail(400, "La devise est le franc CFA (XOF).");
      try { new Intl.DateTimeFormat("fr-FR", { timeZone: value.timezone }); } catch { throw fail(400, "Fuseau horaire inconnu."); }
      await db.transaction(async () => { await db.prepare("UPDATE adeoye_settings SET value=? WHERE key=?").run(JSON.stringify(value), "farm"); await touch(); });
      res.json(value);
    });
    app.get("/api/state", auth, async (req, res) => res.json(await snapshot()));
    app.post("/api/items", auth, write, async (req, res) => {
      const requestId = uuid(req.body.requestId), name = clean(req.body.name, "Nom", 160), category = clean(req.body.category, "Catégorie", 80), unit = clean(req.body.unit, "Unité", 24);
      if (!CATEGORIES.includes(category)) throw fail(400, "Catégorie inconnue.");
      const location = clean(req.body.location, "Emplacement", 160, true), notes = clean(req.body.notes, "Notes", 4000, true);
      const initial = quantity(req.body.quantity ?? 0, unit), minimum = quantity(req.body.minQuantity ?? 0, unit), unitValue = money(req.body.unitValue ?? 0);
      valuation(initial, unitValue);
      const payload = JSON.stringify({ user: req.user.id, name, category, unit, location, notes, initial, minimum, unitValue });
      const result = await db.transaction(async () => {
        const previous = await replay(requestId, "item", payload);
        if (previous) return itemValue(await findItem(previous.result_id));
        const created = now(), id = requestId;
        await db.prepare("INSERT INTO adeoye_items (id,name,category,unit,location,quantity_milli,min_quantity_milli,unit_value,notes,active,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, name, category, unit, location, initial, minimum, unitValue, notes, 1, 1, created, created);
        if (initial > 0) await db.prepare("INSERT INTO adeoye_movements (id,item_id,item_name,unit,type,quantity_milli,balance_milli,reason,date,created_at,created_by,reference) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), id, name, unit, "opening", initial, initial, "Stock initial à la création de la fiche", created.slice(0, 10), created, req.user.username, requestId);
        await saveRequest(requestId, "item", payload, id); await touch();
        return itemValue(await findItem(id));
      });
      res.status(201).json(result);
    });
    app.put("/api/items/:id", auth, write, async (req, res) => {
      const expected = version(req.body.version);
      const result = await db.transaction(async () => {
        const item = await findItem(req.params.id);
        if (!item.active) throw fail(409, "Cette fiche est archivée.");
        if (item.version !== expected) throw fail(409, "Cette fiche a changé. Actualisez les données avant de la modifier.");
        if (req.body.quantity !== undefined || req.body.unit !== undefined && req.body.unit !== item.unit) throw fail(400, "La quantité se modifie par un mouvement. L’unité d’une fiche reste fixe.");
        const name = clean(req.body.name ?? item.name, "Nom", 160), category = clean(req.body.category ?? item.category, "Catégorie", 80);
        if (!CATEGORIES.includes(category)) throw fail(400, "Catégorie inconnue.");
        const location = clean(req.body.location ?? item.location, "Emplacement", 160, true), notes = clean(req.body.notes ?? item.notes, "Notes", 4000, true), minimum = quantity(req.body.minQuantity ?? Number(item.min_quantity_milli) / 1000, item.unit), value = money(req.body.unitValue ?? item.unit_value);
        valuation(Number(item.quantity_milli), value);
        await db.prepare("UPDATE adeoye_items SET name=?,category=?,location=?,min_quantity_milli=?,unit_value=?,notes=?,version=version+1,updated_at=? WHERE id=?").run(name, category, location, minimum, value, notes, now(), item.id); await touch();
        return itemValue(await findItem(item.id));
      });
      res.json(result);
    });
    app.post("/api/items/:id/archive", auth, write, async (req, res) => {
      const expected = version(req.body.version);
      const result = await db.transaction(async () => {
        const item = await findItem(req.params.id);
        if (item.version !== expected) throw fail(409, "Cette fiche a changé. Actualisez les données.");
        if (!item.active) return itemValue(item);
        if (Number(item.quantity_milli) !== 0) throw fail(409, "Enregistrez les sorties restantes avant d’archiver une fiche dont le stock n’est pas nul.");
        await db.prepare("UPDATE adeoye_items SET active=0,version=version+1,updated_at=? WHERE id=?").run(now(), item.id); await touch();
        return itemValue(await findItem(item.id));
      });
      res.json(result);
    });
    app.post("/api/movements", auth, write, async (req, res) => {
      const requestId = uuid(req.body.requestId), itemId = uuid(req.body.itemId), type = req.body.type;
      if (!["entry", "exit", "loss"].includes(type)) throw fail(400, "Type de mouvement invalide.");
      const reason = clean(req.body.reason, "Motif", 1000), date = day(req.body.date);
      const result = await db.transaction(async () => {
        const item = await findItem(itemId);
        const amount = quantity(req.body.quantity, item.unit, { positive: true });
        const payload = JSON.stringify({ user: req.user.id, itemId, type, amount, reason, date });
        const previous = await replay(requestId, "movement", payload);
        if (previous) return movementValue(await db.prepare("SELECT * FROM adeoye_movements WHERE id=?").get(previous.result_id));
        if (!item.active) throw fail(409, "Cette fiche est archivée. Aucun mouvement ne peut y être ajouté.");
        const balance = Number(item.quantity_milli) + (type === "entry" ? amount : -amount);
        if (balance < 0) throw fail(409, "Stock insuffisant pour cette sortie. Actualisez l’inventaire.");
        if (!Number.isSafeInteger(balance) || balance > 1000000000000) throw fail(400, "La quantité finale dépasse le plafond autorisé.");
        valuation(balance, Number(item.unit_value));
        const created = now();
        await db.prepare("UPDATE adeoye_items SET quantity_milli=?,version=version+1,updated_at=? WHERE id=?").run(balance, created, item.id);
        await db.prepare("INSERT INTO adeoye_movements (id,item_id,item_name,unit,type,quantity_milli,balance_milli,reason,date,created_at,created_by,reference) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(requestId, item.id, item.name, item.unit, type, amount, balance, reason, date, created, req.user.username, requestId);
        await saveRequest(requestId, "movement", payload, requestId); await touch();
        return movementValue(await db.prepare("SELECT * FROM adeoye_movements WHERE id=?").get(requestId));
      });
      res.status(201).json(result);
    });
    app.post("/api/notes", auth, write, async (req, res) => {
      const title = clean(req.body.title, "Titre", 160), body = clean(req.body.body, "Observation", 6000), date = day(req.body.date), id = crypto.randomUUID(), created = now();
      const result = await db.transaction(async () => {
        await db.prepare("INSERT INTO adeoye_notes (id,title,body,date,created_at,created_by) VALUES (?,?,?,?,?,?)").run(id, title, body, date, created, req.user.username); await touch();
        return noteValue(await db.prepare("SELECT * FROM adeoye_notes WHERE id=?").get(id));
      });
      res.status(201).json(result);
    });
    app.get("/api/users", auth, admin, async (req, res) => res.json({ users: (await db.prepare("SELECT * FROM adeoye_users ORDER BY created_at DESC,id DESC").all()).map(safeUser) }));
    app.post("/api/users", auth, admin, async (req, res) => {
      const name = username(req.body.username), role = req.body.role;
      if (!["admin", "manager", "viewer"].includes(role)) throw fail(400, "Rôle inconnu.");
      const hashed = await hashPassword(req.body.password);
      const result = await db.transaction(async () => {
        if (await db.prepare("SELECT id FROM adeoye_users WHERE canonical_name=?").get(name.toLocaleLowerCase("fr"))) throw fail(409, "Cet identifiant existe déjà.");
        const created = now(), user = { id: crypto.randomUUID(), username: name, role, enabled: 1, must_change: 1, created_at: created, updated_at: created };
        await db.prepare("INSERT INTO adeoye_users (id,username,canonical_name,password_hash,role,enabled,must_change,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(user.id, name, name.toLocaleLowerCase("fr"), hashed, role, 1, 1, created, created);
        return safeUser(user);
      });
      res.status(201).json(result);
    });
    app.patch("/api/users/:id", auth, admin, async (req, res) => {
      if (typeof req.body.enabled !== "boolean") throw fail(400, "Choisissez le statut actif ou désactivé.");
      const result = await db.transaction(async () => {
        const user = await db.prepare("SELECT * FROM adeoye_users WHERE id=?").get(req.params.id);
        if (!user) throw fail(404, "Compte introuvable.");
        if (!req.body.enabled) {
          if (user.id === req.user.id) throw fail(409, "Vous ne pouvez pas désactiver votre propre compte.");
          if (user.role === "admin" && user.enabled && Number((await db.prepare("SELECT count(*) n FROM adeoye_users WHERE role='admin' AND enabled=1").get()).n) <= 1) throw fail(409, "Conservez au moins un responsable actif.");
        }
        await db.prepare("UPDATE adeoye_users SET enabled=?,updated_at=? WHERE id=?").run(req.body.enabled ? 1 : 0, now(), user.id);
        await db.prepare("DELETE FROM adeoye_sessions WHERE user_id=?").run(user.id);
        return safeUser({ ...user, enabled: req.body.enabled ? 1 : 0 });
      });
      res.json(result);
    });
    app.post("/api/users/:id/reset-password", auth, admin, async (req, res) => {
      if (req.params.id === req.user.id) throw fail(409, "Utilisez « Mon mot de passe » pour votre propre compte.");
      const hashed = await hashPassword(req.body.password);
      const result = await db.transaction(async () => {
        const user = await db.prepare("SELECT * FROM adeoye_users WHERE id=?").get(req.params.id);
        if (!user) throw fail(404, "Compte introuvable.");
        await db.prepare("UPDATE adeoye_users SET password_hash=?,must_change=1,updated_at=? WHERE id=?").run(hashed, now(), user.id);
        await db.prepare("DELETE FROM adeoye_sessions WHERE user_id=?").run(user.id);
        return safeUser({ ...user, must_change: 1 });
      });
      res.json(result);
    });
    function sendCsv(res, filename, rows) { res.type("text/csv; charset=utf-8").attachment(filename).send(csv(rows)); }
    app.get("/api/export/inventory.csv", auth, async (req, res) => {
      const data = await snapshot();
      sendCsv(res, "inventaire-adeoye.csv", [["Nom", "Catégorie", "Quantité", "Unité", "Emplacement", "Seuil d’alerte", "Valeur unitaire estimée (F CFA)", "Valeur totale estimée (F CFA)", "Statut", "Dernière mise à jour"], ...data.items.map(item => [item.name, item.category, item.quantity, item.unit, item.location, item.minQuantity, item.unitValue, item.estimatedValue, item.active ? "Actif" : "Archivé", item.updatedAt])]);
    });
    app.get("/api/export/movements.csv", auth, async (req, res) => {
      const data = await snapshot();
      sendCsv(res, "mouvements-adeoye.csv", [["Date", "Article", "Type", "Quantité", "Unité", "Stock après opération", "Motif", "Saisi par", "Référence", "Enregistré le"], ...data.movements.map(entry => [entry.date, entry.itemName, { entry: "Entrée", exit: "Sortie", loss: "Perte", opening: "Stock initial" }[entry.type], entry.quantity, entry.unit, entry.balanceAfter, entry.reason, entry.createdBy, entry.reference, entry.createdAt])]);
    });
    app.get("/api/reports/inventory.pdf", auth, async (req, res) => {
      const data = await snapshot();
      const { inventoryPdf } = require("./reports");
      const pdf = await inventoryPdf({ items: data.items, settings: data.settings, generatedAt: now() });
      res.type("application/pdf").attachment("inventaire-adeoye.pdf").send(pdf);
    });
    app.use("/api", (req, res) => res.status(404).json({ error: "Cette opération n’existe pas." }));
    async function privatePage(req, res, next) {
      try { await auth(req, res, () => {}); }
      catch (error) { if (error.status === 401) return res.redirect("/connexion.html"); throw error; }
      res.sendFile(path.join(publicDir, "app.html"));
    }
    app.get(["/app", "/app.html", "/espace", "/espace/"], privatePage);
    // Static paths are decoded by Express. Protect encoded and normalized aliases too.
    app.use((req, res, next) => {
      let target;
      try { target = path.posix.normalize(decodeURIComponent(req.path)).toLowerCase(); } catch { throw fail(400, "Adresse de page invalide."); }
      if (target === "/app.html") return privatePage(req, res, next);
      next();
    });
    app.use(express.static(publicDir, { dotfiles: "deny", index: "index.html", maxAge: 0, redirect: false }));
    app.use((req, res) => res.status(404).type("text/plain").send("Page introuvable."));
    app.use((error, req, res, next) => {
      if (res.headersSent) return next(error);
      const status = error.type === "entity.too.large" ? 413 : error instanceof SyntaxError && error.status === 400 ? 400 : Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
      if (status === 500) console.error("ADEOYE : opération impossible.", error.code || error.name || "Error");
      const message = status === 500 ? "Le serveur est temporairement indisponible. Réessayez." : status === 413 ? "Les données envoyées sont trop volumineuses." : error instanceof SyntaxError ? "Les données JSON sont invalides." : error.message;
      res.status(status).json({ error: message });
    });
    return { app, db, dataDir, initialized };
  } catch (error) { await db.close(); throw error; }
}
module.exports = { createApplication, CATEGORIES, DEFAULT_SETTINGS };
