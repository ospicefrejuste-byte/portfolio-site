'use strict';

const express = require('express');
const multer = require('multer');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { StockService, AppError } = require('./lib/business');

function createApp(options = {}) {
  let appOrigin;
  if (process.env.APP_ORIGIN) {
    try {
      const configured = new URL(process.env.APP_ORIGIN);
      if (!['http:', 'https:'].includes(configured.protocol) || configured.username || configured.password || configured.pathname !== '/' || configured.search || configured.hash) throw new Error('Invalid origin');
      appOrigin = configured.origin;
    } catch {
      throw new Error('APP_ORIGIN doit être une origine HTTP(S) complète, sans chemin, identifiants ni paramètres.');
    }
  }
  const uploadDir = path.resolve(options.uploadDir || process.env.STOCK_UPLOAD_DIR || path.join(__dirname, 'uploads'));
  fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
  fs.accessSync(uploadDir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  const app = express();
  const service = options.service || new StockService(options);
  const production = service.production;
  app.locals.service = service;
  app.locals.uploadDir = uploadDir;
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  function cookieToken(req) {
    const cookie = req.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith('stock_session='));
    return cookie ? cookie.slice('stock_session='.length) : null;
  }
  app.use((req, res, next) => { req.user = service.session(cookieToken(req)); next(); });
  const requireAuth = (req, _res, next) => req.user ? next() : next(new AppError('Connexion requise.', 'UNAUTHORIZED', 401));
  function sameOrigin(req, _res, next) {
    if (req.headers['sec-fetch-site'] === 'cross-site') return next(new AppError('Origine de requête refusée.', 'BAD_ORIGIN', 403));
    if (req.headers.origin) {
      let allowed;
      try {
        const origin = new URL(req.headers.origin);
        allowed = appOrigin ? origin.origin === appOrigin : origin.host === req.get('host');
      } catch { allowed = false; }
      if (!allowed) return next(new AppError('Origine de requête refusée.', 'BAD_ORIGIN', 403));
    }
    next();
  }
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/config', (_req, res) => res.json({ demoMode: !production }));
  const attempts = new Map();
  app.post('/api/login', sameOrigin, (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    for (const [ip, item] of attempts) if (item.until <= now) attempts.delete(ip);
    const bucket = attempts.get(key) || { count: 0, until: now + 15 * 60 * 1000 };
    if (bucket.count >= 20) return next(new AppError('Trop de tentatives. Réessayez dans quelques minutes.', 'RATE_LIMITED', 429));
    bucket.count++; attempts.set(key, bucket);
    try {
      const { user, token } = service.authenticate(req.body?.email, req.body?.password);
      attempts.delete(key);
      res.cookie('stock_session', token, { httpOnly: true, sameSite: 'strict', secure: production, maxAge: 12 * 60 * 60 * 1000, path: '/' });
      res.json({ user });
    } catch (error) { next(error); }
  });
  app.get('/api/session', (req, res) => res.json({ user: req.user }));
  app.post('/api/logout', sameOrigin, (req, res) => {
    service.logout(cookieToken(req));
    res.clearCookie('stock_session', { httpOnly: true, sameSite: 'strict', secure: production, path: '/' });
    res.json({ ok: true });
  });
  app.get('/api/state', requireAuth, (req, res, next) => {
    try { res.json(service.state(req.user)); } catch (error) { next(error); }
  });
  app.post('/api/commands', sameOrigin, requireAuth, (req, res, next) => {
    try { res.json(service.command(req.user, req.body)); } catch (error) { next(error); }
  });
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 4, fields: 0, parts: 4 }, fileFilter(_req, file, cb) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return cb(new AppError('Formats autorisés : JPEG, PNG et WebP.', 'INVALID_IMAGE'));
    cb(null, true);
  } });
  function imageExtension(buffer) {
    if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
    if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    return null;
  }
  const allowedImage = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  app.post('/upload', sameOrigin, requireAuth, (req, _res, next) => req.user.role === 'admin' ? next() : next(new AppError('Téléversement réservé aux administrateurs.', 'FORBIDDEN', 403)), upload.array('images', 4), (req, res, next) => {
    const saved = [];
    try {
      if (!req.files?.length) throw new AppError('Aucune image sélectionnée.', 'INVALID_IMAGE');
      const valid = req.files.map(file => {
        const extension = imageExtension(file.buffer);
        if (!extension || extension !== allowedImage[file.mimetype]) throw new AppError('Le contenu ne correspond pas au format image annoncé.', 'INVALID_IMAGE');
        return { buffer: file.buffer, filename: `${randomUUID()}.${extension}` };
      });
      for (const file of valid) { fs.writeFileSync(path.join(uploadDir, file.filename), file.buffer, { flag: 'wx', mode: 0o600 }); saved.push(file.filename); }
      res.json(saved.map(filename => `/uploads/${filename}`));
    } catch (error) {
      for (const filename of saved) fs.unlinkSync(path.join(uploadDir, filename));
      next(error);
    }
  });
  app.use('/uploads', requireAuth, express.static(uploadDir, { dotfiles: 'deny', immutable: true, maxAge: '7d', setHeaders(res) { res.set('Content-Security-Policy', "default-src 'none'; sandbox"); } }));
  app.use(express.static(path.join(__dirname, 'public'), { etag: true, setHeaders(res, filename) {
    if (filename.endsWith('sw.js')) res.set('Cache-Control', 'no-cache');
  } }));
  app.use('/api', (_req, _res, next) => next(new AppError('Route inconnue.', 'NOT_FOUND', 404)));
  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) return res.status(400).json({ error: 'Téléversement invalide : maximum 4 images de 5 Mo.', code: 'INVALID_UPLOAD' });
    if (error instanceof AppError) return res.status(error.status).json({ error: error.message, code: error.code });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalide.', code: 'INVALID_JSON' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Requête trop volumineuse.', code: 'BODY_TOO_LARGE' });
    console.error('Erreur serveur :', error.message);
    res.status(500).json({ error: 'Une erreur interne empêche cette opération.', code: 'INTERNAL_ERROR' });
  });
  return app;
}

if (require.main === module) {
  const app = createApp();
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, '0.0.0.0', () => console.log(`Comptoir : serveur prêt (port ${server.address().port})`));
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      app.locals.service.close();
      process.exit(1);
    }, 10_000);
    deadline.unref();
    server.close(() => {
      clearTimeout(deadline);
      app.locals.service.close();
      process.exit(0);
    });
  });
}
module.exports = { createApp };
