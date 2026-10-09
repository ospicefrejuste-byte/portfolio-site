"use strict";

const express = require("express");
const {
  createPostgres
} = require("./postgres");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  promisify
} = require("node:util");
const scrypt = promisify(crypto.scrypt);
const {
  levels,
  centres,
  subjects
} = require("./catalogue");
const {
  createPaymentService
} = require("./cloud-payments");
const kinds = ["students", "teachers", "courses", "attendance", "payments", "grades"];
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = (status, message) => Object.assign(new Error(message), {
  status
});
const clean = (v, label, max = 100, optional = false) => {
  if (optional && (v === undefined || v === null || v === "")) return "";
  if (typeof v !== "string" || !v.trim() || v.trim().length > max) throw fail(400, `${label} invalide.`);
  return v.trim();
};
const number = (v, min, max, label, integer = false) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || integer && !Number.isInteger(v)) throw fail(400, `${label} invalide.`);
  return v;
};
const date = v => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v) throw fail(400, "Date invalide.");
  return v;
};
const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const safeUser = u => ({
  id: u.id,
  username: u.username,
  role: u.role,
  entityId: u.entity_id,
  enabled: Boolean(u.enabled),
  mustChangePassword: Boolean(u.must_change)
});
async function passwordHash(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 128) throw fail(400, "Le mot de passe doit contenir entre 12 et 128 caractères.");
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${hash.toString("hex")}`;
}
async function verify(password, stored) {
  if (typeof password !== "string" || password.length > 128) return false;
  const [salt, value] = stored.split(":");
  const hash = await scrypt(password, salt, 64);
  return crypto.timingSafeEqual(hash, Buffer.from(value, "hex"));
}
async function createApplication(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.CRS_DATA_DIR || path.join(__dirname, "..", ".data"));
  const production = options.production ?? process.env.NODE_ENV === "production";
  const publicOrigin = options.publicOrigin || process.env.PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL || "";
  if (production && (!publicOrigin || new URL(publicOrigin).protocol !== "https:")) throw Error("En production, PUBLIC_ORIGIN doit être l’origine HTTPS du site.");
  const db = options.database || createPostgres();
  try {
    await db.transaction(async () => {
      await db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);\n    CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT PRIMARY KEY, payload TEXT NOT NULL);\n    CREATE INDEX IF NOT EXISTS records_kind ON records(kind);\n    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','teacher','student')), entity_id TEXT, enabled INTEGER NOT NULL DEFAULT 1, must_change INTEGER NOT NULL DEFAULT 0);\n    CREATE UNIQUE INDEX IF NOT EXISTS users_entity ON users(role, entity_id) WHERE entity_id IS NOT NULL;\n    CREATE TABLE IF NOT EXISTS registration_access (token_hash TEXT PRIMARY KEY, student_id TEXT NOT NULL, expires BIGINT NOT NULL);\n    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL, expires BIGINT NOT NULL);\n  \nCREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users(lower(username));\nCREATE TABLE IF NOT EXISTS request_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires BIGINT NOT NULL);");
    });
    const publicDir = options.publicDir || path.join(__dirname, "..", "public");
    const initialized = async () => Boolean(await db.prepare("SELECT value FROM settings WHERE key='initialized'").get());
    const tokenFile = "";
    let setupToken = options.setupToken || process.env.CRS_SETUP_TOKEN;
    if (!setupToken && !(await initialized())) throw Error("Configurez le code privé CRS_SETUP_TOKEN avant la première installation.");
    const dummyHash = `${"0".repeat(32)}:${"0".repeat(128)}`;
    const app = express();
    app.disable("x-powered-by");
    if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
    app.use((req, res, next) => {
      res.set({
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src https://widget-v3.kkiapay.me; form-action 'self'; frame-ancestors 'none'; base-uri 'self'"
      });
      if (production) res.set("Strict-Transport-Security", "max-age=31536000");
      next();
    });
    app.use("/api", (req, res, next) => {
      res.set("Cache-Control", "no-store");
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        const origin = req.get("Origin");
        const expected = publicOrigin || `${req.protocol}://${req.get("host")}`;
        if (origin && origin !== expected || req.get("Sec-Fetch-Site") === "cross-site") return next(fail(403, "Origine de la requête refusée."));
      }
      next();
    });
    app.use((req, res, next) => {
      if (req.apiGateway && Buffer.isBuffer(req.body)) {
        if (req.body.length > 32768) return next(fail(413, "Données trop volumineuses."));
        if (req.body.length) {
          if (!(req.get("Content-Type") || "").toLowerCase().startsWith("application/json")) return next(fail(415, "Envoyez un objet JSON."));
          try {
            req.body = JSON.parse(req.body.toString("utf8"));
          } catch {
            return next(fail(400, "JSON invalide."));
          }
        } else req.body = undefined;
      }
      next();
    });
    app.use(express.json({
      limit: "32kb"
    }));
    app.use("/api", (req, res, next) => {
      if (["POST", "PUT", "PATCH"].includes(req.method) && (!req.body || typeof req.body !== "object" || Array.isArray(req.body))) return next(fail(400, "Envoyez un objet JSON valide."));
      next();
    });
    function limit(scope, count) {
      return async (req, res, next) => {
        const now = Date.now();
        const key = sha(scope + ":" + req.ip);
        const entry = await db.prepare("INSERT INTO request_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN request_limits.expires<? THEN 1 ELSE request_limits.count+1 END,expires=CASE WHEN request_limits.expires<? THEN excluded.expires ELSE request_limits.expires END RETURNING count,expires").get(key, now + 15 * 60 * 1000, now, now);
        if (entry.count > count) {
          res.set("Retry-After", String(Math.ceil((entry.expires - now) / 1000)));
          return next(fail(429, "Trop de tentatives. Réessayez dans quelques minutes."));
        }
        next();
      };
    }
    const snapshot = async () => {
      const data = Object.fromEntries(kinds.map(k => [k, []]));
      for (const row of await db.prepare("SELECT kind,payload FROM records").all()) if (data[row.kind]) data[row.kind].push(JSON.parse(row.payload));
      return data;
    };
    async function insert(kind, record) {
      await db.prepare("INSERT INTO records(kind,id,payload) VALUES(?,?,?)").run(kind, record.id, JSON.stringify(record));
    }
    const transaction = fn => db.transaction(fn);
    async function session(req, res, user) {
      const token = crypto.randomBytes(32).toString("hex");
      const csrf = crypto.randomBytes(24).toString("hex");
      await db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
      await db.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run(sha(token), user.id, csrf, Date.now() + 8 * 60 * 60 * 1000);
      res.cookie("crs_session", token, {
        httpOnly: true,
        secure: production,
        sameSite: "lax",
        path: "/",
        maxAge: 8 * 60 * 60 * 1000
      });
      res.json({
        user: safeUser(user),
        csrf
      });
    }
    async function auth(req, res, next) {
      const token = (req.headers.cookie || "").split(";").map(x => x.trim()).find(x => x.startsWith("crs_session="))?.slice(12);
      if (!token || !/^[a-f0-9]{64}$/.test(token)) return next(fail(401, "Veuillez vous connecter."));
      const s = await db.prepare("SELECT * FROM sessions WHERE token_hash=? AND expires>?").get(sha(token), Date.now());
      const user = s && (await db.prepare("SELECT * FROM users WHERE id=? AND enabled=1").get(s.user_id));
      if (!user) return next(fail(401, "Session expirée. Veuillez vous reconnecter."));
      req.user = user;
      req.session = s;
      if (!["GET", "HEAD"].includes(req.method) && req.get("X-CSRF-Token") !== s.csrf) return next(fail(403, "Requête invalide. Rechargez la page."));
      if (user.must_change && !["/api/auth/me", "/api/auth/password", "/api/auth/logout", "/gestion.html"].includes(req.path)) return next(fail(403, "Changez votre mot de passe pour continuer."));
      next();
    }
    const admin = (req, res, next) => req.user.role === "admin" ? next() : next(fail(403, "Accès réservé à l’administration."));
    app.get("/api/health", async (req, res) => res.json({
      ok: true,
      setupRequired: !(await initialized())
    }));
    app.get("/api/catalogue", (req, res) => res.json({
      levels,
      centres,
      subjects
    }));
    app.post("/api/auth/setup", limit("setup", 5), async (req, res) => {
      if (await initialized()) throw fail(409, "Le compte administrateur a déjà été créé.");
      if (typeof req.body.token !== "string" || !setupToken || !crypto.timingSafeEqual(Buffer.from(sha(req.body.token)), Buffer.from(sha(setupToken)))) throw fail(403, "Code d’installation incorrect.");
      const username = validateUsername(req.body.username);
      const hash = await passwordHash(req.body.password);
      const user = await transaction(async () => {
        if (await initialized()) throw fail(409, "Installation déjà terminée.");
        const id = crypto.randomUUID();
        await db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES(?,?,?,'admin')").run(id, username, hash);
        await db.prepare("INSERT INTO settings VALUES('initialized','1')").run();
        return await db.prepare("SELECT * FROM users WHERE id=?").get(id);
      });
      if (fs.existsSync(tokenFile)) fs.unlinkSync(tokenFile);
      setupToken = undefined;
      await session(req, res, user);
    });
    app.post("/api/auth/login", limit("login", 20), async (req, res) => {
      const username = typeof req.body.username === "string" ? req.body.username.trim().slice(0, 80) : "";
      const user = await db.prepare("SELECT * FROM users WHERE lower(username)=lower(?)").get(username);
      const valid = await verify(req.body.password, user?.password_hash || dummyHash);
      if (!user || !user.enabled || !valid) throw fail(401, "Identifiant ou mot de passe incorrect.");
      await session(req, res, user);
    });
    app.get("/api/auth/me", auth, (req, res) => res.json({
      user: safeUser(req.user),
      csrf: req.session.csrf
    }));
    app.post("/api/auth/logout", auth, async (req, res) => {
      await db.prepare("DELETE FROM sessions WHERE token_hash=?").run(req.session.token_hash);
      res.clearCookie("crs_session", {
        path: "/",
        httpOnly: true,
        secure: production,
        sameSite: "lax"
      });
      res.json({
        ok: true
      });
    });
    app.post("/api/auth/password", auth, async (req, res) => {
      if (!(await verify(req.body.currentPassword, req.user.password_hash))) throw fail(400, "Mot de passe actuel incorrect.");
      if (req.body.currentPassword === req.body.password) throw fail(400, "Choisissez un nouveau mot de passe.");
      const hash = await passwordHash(req.body.password);
      await transaction(async () => {
        await db.prepare("UPDATE users SET password_hash=?,must_change=0 WHERE id=?").run(hash, req.user.id);
        await db.prepare("DELETE FROM sessions WHERE user_id=?").run(req.user.id);
      });
      await session(req, res, await db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id));
    });
    function validateUsername(value) {
      const username = clean(value, "Identifiant", 80);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9@._-]{2,79}$/.test(username)) throw fail(400, "Identifiant : 3 à 80 caractères, lettres, chiffres, @, point, tiret ou soulignement.");
      return username;
    }
    function view(user, data) {
      if (user.role === "admin") return data;
      const courses = data.courses.filter(c => user.role === "teacher" ? c.teacher === user.entity_id : c.group === data.students.find(s => s.id === user.entity_id)?.group);
      const students = data.students.filter(s => user.role === "student" ? s.id === user.entity_id : courses.some(c => c.group === s.group));
      // Teachers receive only the student information needed to teach, not family contact or billing details.
      const visibleStudents = user.role === "teacher" ? students.map(({
        id,
        name,
        class: level,
        group
      }) => ({
        id,
        name,
        class: level,
        group
      })) : students;
      return {
        students: visibleStudents,
        teachers: data.teachers.filter(t => courses.some(c => c.teacher === t.id)),
        courses,
        grades: data.grades.filter(g => students.some(s => s.id === g.student) && courses.some(c => c.id === g.course)),
        attendance: data.attendance.filter(a => students.some(s => s.id === a.student) && courses.some(c => c.id === a.course)),
        payments: user.role === "student" ? data.payments.filter(p => p.student === user.entity_id) : []
      };
    }
    const payments = await createPaymentService({
      db,
      snapshot,
      insert,
      transaction,
      config: options.paymentConfig,
      verifyTransaction: options.verifyTransaction
    });
    app.get("/api/payments/config", auth, (req, res) => res.json(payments.configuration()));
    app.get("/api/payments/orders", auth, async (req, res) => res.json(await payments.orders(req.user)));
    app.post("/api/payments/checkout", auth, limit("checkout", 30), async (req, res) => res.status(201).json(await payments.checkout(req.user, req.body)));
    app.post("/api/payments/confirm", auth, limit("confirm", 60), async (req, res) => res.json(await payments.confirm(req.user, req.body)));
    // Webhook input is untrusted; only the authenticated provider verification can create a receipt.
    async function registrationAuth(req, res, next) {
      const token = (req.get("Authorization") || "").replace(/^Bearer /, "");
      if (!/^[a-f0-9]{64}$/.test(token)) return next(fail(401, "Le lien de paiement est invalide ou expiré."));
      const access = await db.prepare("SELECT * FROM registration_access WHERE token_hash=? AND expires>?").get(sha(token), Date.now());
      if (!access || !(await snapshot()).students.some(s => s.id === access.student_id)) return next(fail(401, "Le lien de paiement est invalide ou expiré."));
      req.registrationUser = {
        role: "student",
        entity_id: access.student_id
      };
      next();
    }
    app.get("/api/registration-payments/config", registrationAuth, (req, res) => res.json(payments.configuration()));
    app.post("/api/registration-payments/checkout", registrationAuth, limit("public-checkout", 30), async (req, res) => {
      res.status(201).json(await payments.checkout(req.registrationUser, req.body, {
        allowPreinscription: true
      }));
    });
    app.post("/api/registration-payments/confirm", registrationAuth, limit("public-confirm", 60), async (req, res) => {
      res.json(await payments.confirm(req.registrationUser, req.body));
    });
    app.post("/api/payments/webhook", limit("webhook", 120), async (req, res) => {
      const result = await payments.confirm(null, {
        transactionId: req.body.transactionId
      });
      res.json(result);
    });
    app.get("/api/data", auth, async (req, res) => res.json(view(req.user, await snapshot())));
    function validate(kind, body, id, data) {
      const record = {
        id
      };
      const find = (type, value) => {
        const found = data[type].find(x => x.id === value);
        if (!found) throw fail(400, "Dossier associé introuvable.");
        return found;
      };
      if (kind === "students") {
        record.name = clean(body.name, "Nom");
        record.class = clean(body.class, "Classe");
        record.group = clean(body.group, "Groupe", 180);
        record.registrationStatus = body.registrationStatus || "Inscrit";
        if (!["Préinscription", "Inscrit", "Suspendu"].includes(record.registrationStatus)) throw fail(400, "Statut invalide.");
        record.centre = clean(body.centre, "Centre", 100, true);
        record.guardian = clean(body.guardian, "Responsable", 100, true);
        record.phone = clean(body.phone, "Téléphone", 20, true);
        if (record.centre && !centres.includes(record.centre)) throw fail(400, "Centre invalide.");
        if (record.phone && !/^[+0-9 ()-]{8,20}$/.test(record.phone)) throw fail(400, "Téléphone invalide.");
        record.subjects = body.subjects || [];
        if (!Array.isArray(record.subjects) || record.subjects.length > 3 || record.subjects.some(s => !subjects.includes(s))) throw fail(400, "Matières invalides.");
        record.monthlyFee = body.monthlyFee === undefined ? levels.find(([l]) => l === record.class)?.[1] || 0 : number(body.monthlyFee, 0, 1000000, "Tarif", true);
        if ([...data.grades, ...data.attendance].some(a => a.student === id && find("courses", a.course).group !== record.group)) throw fail(409, "Ce changement de groupe rendrait les notes ou présences existantes incohérentes.");
      } else if (kind === "teachers") {
        record.name = clean(body.name, "Nom");
        record.subject = clean(body.subject, "Matière");
      } else if (kind === "courses") {
        record.subject = clean(body.subject, "Matière");
        record.group = clean(body.group, "Groupe", 180);
        record.teacher = find("teachers", body.teacher).id;
        if (!data.students.some(s => s.group === record.group)) throw fail(400, "Groupe sans élève.");
        record.date = date(body.date);
        record.time = clean(body.time, "Heure", 5);
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(record.time)) throw fail(400, "Heure invalide.");
        record.duration = number(body.duration, 15, 480, "Durée", true);
        record.room = clean(body.room, "Salle");
        if (minutes(record.time) + record.duration > 1440) throw fail(400, "La séance doit terminer avant minuit.");
        if (data.courses.some(c => c.id !== id && c.date === record.date && (c.teacher === record.teacher || c.group === record.group || c.room.toLowerCase() === record.room.toLowerCase()) && minutes(c.time) < minutes(record.time) + record.duration && minutes(record.time) < minutes(c.time) + c.duration)) throw fail(409, "Créneau déjà occupé pour cet enseignant, ce groupe ou cette salle.");
        if ([...data.grades, ...data.attendance].some(a => a.course === id && find("students", a.student).group !== record.group)) throw fail(409, "Le groupe ne peut pas changer avec ces notes ou présences.");
      } else if (kind === "payments") {
        record.student = find("students", body.student).id;
        record.amount = number(body.amount, 1, 100000000, "Montant", true);
        record.period = clean(body.period, "Période");
        if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(record.period)) throw fail(400, "Période invalide : utilisez AAAA-MM.");
        record.date = date(body.date);
      } else if (kind === "grades" || kind === "attendance") {
        const s = find("students", body.student),
          c = find("courses", body.course);
        if (s.group !== c.group) throw fail(400, "Cet élève ne fait pas partie du groupe de ce cours.");
        record.student = s.id;
        record.course = c.id;
        if (kind === "grades") {
          record.label = clean(body.label, "Évaluation");
          record.score = number(body.score, 0, 20, "Note");
        } else {
          record.status = body.status;
          if (!["Présent", "Absent", "Retard", "Excusé"].includes(record.status)) throw fail(400, "Statut de présence invalide.");
        }
      }
      return record;
    }
    function writeAllowed(user, kind, record, data) {
      if (user.role === "admin") return;
      if (user.role !== "teacher" || !["grades", "attendance"].includes(kind) || !data.courses.some(c => c.id === record.course && c.teacher === user.entity_id)) throw fail(403, "Vous ne pouvez pas modifier ce dossier.");
    }
    app.post("/api/registrations", limit("registrations", 10), async (req, res) => {
      const body = req.body;
      if (!body || body.consent !== true) throw fail(400, "Veuillez accepter la transmission de la préinscription.");
      const level = levels.find(([l]) => l === body.class);
      if (!level || !centres.includes(body.centre)) throw fail(400, "Classe ou centre invalide.");
      clean(body.guardian, "Responsable");
      clean(body.phone, "Téléphone", 20);
      if (!Array.isArray(body.subjects) || !body.subjects.length) throw fail(400, "Choisissez au moins une matière.");
      const id = crypto.randomUUID();
      const record = validate("students", {
        ...body,
        group: `${body.class} · ${body.centre}`,
        monthlyFee: level[1],
        registrationStatus: "Préinscription"
      }, id, await snapshot());
      record.createdAt = new Date().toISOString();
      const paymentToken = crypto.randomBytes(32).toString("hex");
      await transaction(async () => {
        await insert("students", record);
        await db.prepare("DELETE FROM registration_access WHERE expires<?").run(Date.now());
        await db.prepare("INSERT INTO registration_access VALUES(?,?,?)").run(sha(paymentToken), id, Date.now() + 24 * 60 * 60 * 1000);
      });
      res.status(201).json({
        ok: true,
        reference: id.slice(0, 8).toUpperCase(),
        paymentToken,
        monthlyFee: level[1]
      });
    });
    app.post("/api/records/:kind", auth, async (req, res) => {
      const kind = req.params.kind;
      if (!kinds.includes(kind)) throw fail(404, "Type de dossier inconnu.");
      const result = await transaction(async () => {
        const data = await snapshot(),
          id = crypto.randomUUID();
        writeAllowed(req.user, kind, req.body, data);
        const record = validate(kind, req.body, id, data);
        if (kind === "attendance" && data.attendance.some(a => a.student === record.student && a.course === record.course)) throw fail(409, "Une présence existe déjà pour cet élève et cette séance.");
        await insert(kind, record);
        return record;
      });
      res.status(201).json(result);
    });
    app.put("/api/records/:kind/:id", auth, async (req, res) => {
      const {
        kind,
        id
      } = req.params;
      if (!kinds.includes(kind)) throw fail(404, "Type de dossier inconnu.");
      const record = await transaction(async () => {
        const data = await snapshot(),
          old = data[kind].find(r => r.id === id);
        if (!old) throw fail(404, "Dossier introuvable.");
        if (kind === "payments" && old.source === "KKiaPay") throw fail(409, "Un reçu KKiaPay confirmé ne peut pas être modifié.");
        writeAllowed(req.user, kind, old, data);
        writeAllowed(req.user, kind, req.body, data);
        const next = validate(kind, {
          ...old,
          ...req.body
        }, id, data);
        if (old.createdAt) next.createdAt = old.createdAt;
        if (kind === "attendance" && data.attendance.some(a => a.id !== id && a.student === next.student && a.course === next.course)) throw fail(409, "Cette présence existe déjà.");
        await db.prepare("UPDATE records SET payload=? WHERE id=?").run(JSON.stringify(next), id);
        return next;
      });
      res.json(record);
    });
    app.delete("/api/records/:kind/:id", auth, async (req, res) => {
      const {
        kind,
        id
      } = req.params;
      if (!kinds.includes(kind)) throw fail(404, "Type de dossier inconnu.");
      await transaction(async () => {
        const data = await snapshot(),
          record = data[kind].find(r => r.id === id);
        if (!record) throw fail(404, "Dossier introuvable.");
        writeAllowed(req.user, kind, record, data);
        if (kind === "payments" && record.source === "KKiaPay") throw fail(409, "Un reçu KKiaPay confirmé ne peut pas être supprimé.");
        const associatedOrder = kind === "students" && (await db.prepare("SELECT id FROM payment_orders WHERE student_id=?").get(id));
        const associatedAccount = ["students", "teachers"].includes(kind) && (await db.prepare("SELECT id FROM users WHERE entity_id=?").get(id));
        if (associatedAccount || associatedOrder || kind === "students" && [...data.payments, ...data.grades, ...data.attendance].some(r => r.student === id) || kind === "teachers" && data.courses.some(r => r.teacher === id) || kind === "courses" && [...data.grades, ...data.attendance].some(r => r.course === id)) throw fail(409, "Ce dossier est utilisé par un compte ou des enregistrements. Supprimez ou réaffectez les liens avant de le supprimer.");
        await db.prepare("DELETE FROM records WHERE id=?").run(id);
      });
      res.json({
        ok: true
      });
    });
    app.get("/api/admin/users", auth, admin, async (req, res) => res.json((await db.prepare("SELECT * FROM users ORDER BY username").all()).map(safeUser)));
    app.post("/api/admin/users", auth, admin, async (req, res) => {
      const {
        role,
        entityId
      } = req.body;
      const username = validateUsername(req.body.username);
      if (!["admin", "teacher", "student"].includes(role)) throw fail(400, "Rôle invalide.");
      const hash = await passwordHash(req.body.password);
      const user = await transaction(async () => {
        if (await db.prepare("SELECT id FROM users WHERE lower(username)=lower(?)").get(username)) throw fail(409, "Cet identifiant existe déjà.");
        if (role !== "admin" && !(await snapshot())[role === "teacher" ? "teachers" : "students"].some(r => r.id === entityId)) throw fail(400, "Choisissez le dossier lié au compte.");
        if (role !== "admin" && (await db.prepare("SELECT id FROM users WHERE role=? AND entity_id=?").get(role, entityId))) throw fail(409, "Ce dossier possède déjà un compte.");
        const id = crypto.randomUUID();
        await db.prepare("INSERT INTO users(id,username,password_hash,role,entity_id,must_change) VALUES(?,?,?,?,?,1)").run(id, username, hash, role, role === "admin" ? null : entityId);
        return await db.prepare("SELECT * FROM users WHERE id=?").get(id);
      });
      res.status(201).json(safeUser(user));
    });
    app.put("/api/admin/users/:id", auth, admin, async (req, res) => {
      const existing = await db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
      if (!existing) throw fail(404, "Compte introuvable.");
      if (typeof req.body.enabled !== "boolean" && req.body.password === undefined) throw fail(400, "Aucune modification fournie.");
      const hash = req.body.password !== undefined ? await passwordHash(req.body.password) : null;
      await transaction(async () => {
        const enabled = req.body.enabled ?? Boolean(existing.enabled);
        if (!enabled && existing.id === req.user.id) throw fail(400, "Vous ne pouvez pas désactiver votre propre compte.");
        if (!enabled && existing.role === "admin" && (await db.prepare("SELECT count(*) n FROM users WHERE role='admin' AND enabled=1 AND id<>?").get(existing.id)).n === 0) throw fail(409, "Conservez au moins un administrateur actif.");
        if (hash && existing.id === req.user.id) throw fail(400, "Utilisez « Mon mot de passe » pour votre propre compte.");
        await db.prepare("UPDATE users SET enabled=?,password_hash=?,must_change=? WHERE id=?").run(enabled ? 1 : 0, hash || existing.password_hash, hash ? 1 : existing.must_change, existing.id);
        await db.prepare("DELETE FROM sessions WHERE user_id=?").run(existing.id);
      });
      res.json(safeUser(await db.prepare("SELECT * FROM users WHERE id=?").get(existing.id)));
    });
    app.get("/api/admin/export", auth, admin, async (req, res) => {
      res.attachment(`cours-export-${new Date().toISOString().slice(0, 10)}.json`);
      res.json({
        exportedAt: new Date().toISOString(),
        ...(await snapshot())
      });
    });
    await db.transaction(async () => {
      for (const name of ["settings", "records", "users", "sessions", "registration_access", "payment_orders", "request_limits"]) await db.exec("ALTER TABLE " + name + " ENABLE ROW LEVEL SECURITY");
    });
    app.use("/api", (req, res, next) => next(fail(404, "Route inconnue.")));
    app.get(["/administration", "/administration/", "/gestion.html"], async (req, res, next) => {
      res.set("Cache-Control", "no-store");
      await auth(req, res, err => {
        if (err) return res.redirect("/connexion.html");
        if (req.path !== "/gestion.html" && req.user.role !== "admin") return res.status(403).send("Cet espace est réservé au superviseur.");
        return res.sendFile(path.resolve(publicDir, "gestion.html"));
      });
    });
    app.use(express.static(path.resolve(publicDir), {
      dotfiles: "deny"
    }));
    app.use((err, req, res, next) => {
      const status = err.status || (err.type === "entity.too.large" ? 413 : 500);
      if (status === 500) console.error("Erreur serveur:", err.code || err.name);
      res.status(status).json({
        error: status === 500 ? "Erreur interne. Réessayez ou contactez l’administration." : err.message
      });
    });
    return {
      app,
      db,
      dataDir,
      initialized
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}
module.exports = {
  createApplication
};
