'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const runFile = promisify(execFile);
const MAX_MANIFEST = 32 * 1024 * 1024;
const MAX_DATABASE = 2 * 1024 * 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_FILES = 100_001;
const MAX_TOTAL = 20 * 1024 * 1024 * 1024;
const IMAGE_NAME = /^[a-f0-9-]+\.(?:jpg|png|webp)$/;
const BACKUP_NAME = /^comptoir-\d{8}T\d{9}Z-[a-f0-9-]{36}$/;
const sourceJobs = new WeakMap();

function backupError(message, code = 'INVALID_BACKUP') {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function directory(directoryPath, create = false) {
  if (create) await fsp.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw backupError('Un dossier réel est requis ; les liens symboliques sont refusés.');
  return fsp.realpath(directoryPath);
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function regularFile(filename, maxSize) {
  const stat = await fsp.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size) || stat.size > maxSize) {
    throw backupError('Fichier non autorisé ou taille excessive dans la sauvegarde.');
  }
  return stat;
}

async function copyAndHash(source, destination, maxSize) {
  const before = await regularFile(source, maxSize);
  const input = await fsp.open(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let output;
  try {
    const opened = await input.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw backupError('Le fichier a changé pendant la sauvegarde.');
    if (destination) output = await fsp.open(destination, 'wx', 0o600);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maxSize) throw backupError('Taille excessive dans la sauvegarde.');
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (output) {
        let offset = 0;
        while (offset < chunk.length) offset += (await output.write(chunk, offset, chunk.length - offset, null)).bytesWritten;
      }
    }
    const after = await input.stat();
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw backupError('Le fichier a changé pendant la sauvegarde.');
    if (output) await output.sync();
    return { size, sha256: hash.digest('hex') };
  } finally {
    await input.close();
    if (output) await output.close();
  }
}

function referencedPhotos(db) {
  const files = new Set();
  for (const { data } of db.prepare('SELECT data FROM products').all()) {
    const product = JSON.parse(data);
    if (!product.photo) continue;
    if (typeof product.photo !== 'string' || !product.photo.startsWith('/uploads/')) throw backupError('Une référence photo du catalogue est invalide.');
    const name = product.photo.slice('/uploads/'.length);
    if (!IMAGE_NAME.test(name)) throw backupError('Une référence photo du catalogue est invalide.');
    files.add(`uploads/${name}`);
  }
  return files;
}

function checkDatabase(db, files) {
  const checks = db.prepare('PRAGMA integrity_check').all();
  if (checks.length !== 1 || checks[0].integrity_check !== 'ok') throw backupError('La base SQLite de sauvegarde est endommagée.');
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  for (const required of ['users', 'sessions', 'commands', 'stocks', 'products', 'stores', 'contacts', 'documents', 'inventories', 'expenses', 'settings']) {
    if (!tables.has(required)) throw backupError('Cette base ne contient pas toutes les tables Comptoir.');
  }
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw backupError('Des relations sont invalides dans la base SQLite.');
  if (files) for (const photo of referencedPhotos(db)) if (!files.has(photo)) throw backupError(`Photo du catalogue absente de la sauvegarde : ${photo}.`);
}

async function validateManifest(backupDir) {
  const root = await directory(path.resolve(backupDir));
  const manifestPath = path.join(root, 'manifest.json');
  await regularFile(manifestPath, MAX_MANIFEST);
  let manifest;
  try { manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8')); }
  catch { throw backupError('Le manifeste de sauvegarde est invalide.'); }
  if (!manifest || manifest.format !== 'comptoir-backup' || manifest.version !== 1 ||
      typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt)) || new Date(manifest.createdAt).toISOString() !== manifest.createdAt ||
      !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > MAX_FILES) throw backupError('Format de sauvegarde Comptoir non reconnu.');
  let total = 0;
  const paths = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' ||
        !(file.path === 'stock.sqlite' || (file.path.startsWith('uploads/') && IMAGE_NAME.test(file.path.slice(8)))) ||
        !Number.isSafeInteger(file.size) || file.size < 0 || file.size > (file.path === 'stock.sqlite' ? MAX_DATABASE : MAX_IMAGE) ||
        typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || paths.has(file.path)) throw backupError('Entrée de manifeste non autorisée.');
    total += file.size;
    if (total > MAX_TOTAL) throw backupError('La sauvegarde dépasse la taille maximale autorisée.');
    paths.add(file.path);
  }
  if (!paths.has('stock.sqlite')) throw backupError('La base SQLite manque dans la sauvegarde.');
  await directory(path.join(root, 'uploads'));
  const expectedRoot = new Set(['manifest.json', 'stock.sqlite', 'uploads']);
  for (const name of await fsp.readdir(root)) if (!expectedRoot.has(name)) throw backupError('Fichier inattendu à la racine de la sauvegarde.');
  for (const name of await fsp.readdir(path.join(root, 'uploads'))) if (!paths.has(`uploads/${name}`)) throw backupError('Photo non déclarée dans le manifeste.');
  return { root, manifest, paths };
}

async function verifyBackup(backupDir) {
  const { root, manifest, paths } = await validateManifest(backupDir);
  for (const file of manifest.files) {
    const actual = await copyAndHash(path.join(root, ...file.path.split('/')), null, file.path === 'stock.sqlite' ? MAX_DATABASE : MAX_IMAGE);
    if (actual.size !== file.size || actual.sha256 !== file.sha256) throw backupError(`Le contrôle SHA-256 a échoué : ${file.path}.`);
  }
  const db = new DatabaseSync(path.join(root, 'stock.sqlite'), { readOnly: true });
  try { checkDatabase(db, paths); } finally { db.close(); }
  return { path: root, manifest };
}

async function createBackup(options = {}) {
  if (!options.targetDir) throw backupError('Le dossier de destination de sauvegarde est requis.');
  const uploadDir = await directory(path.resolve(options.uploadDir || process.env.STOCK_UPLOAD_DIR || path.join(__dirname, '..', 'uploads')));
  const targetDir = await directory(path.resolve(options.targetDir), true);
  if (isInside(targetDir, uploadDir)) throw backupError('Le dossier de sauvegarde doit être séparé du dossier des photos.');
  let db = options.service?.db;
  let owned = false;
  if (!db) {
    const dbPath = path.resolve(options.dbPath || process.env.STOCK_DB_PATH || path.join(__dirname, '..', 'data', 'stock.sqlite'));
    await regularFile(dbPath, MAX_DATABASE);
    db = new DatabaseSync(dbPath, { readOnly: true });
    owned = true;
  }
  if (sourceJobs.has(db)) {
    if (owned) db.close();
    throw backupError('Une sauvegarde de cette base est déjà en cours.', 'BACKUP_IN_PROGRESS');
  }
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const name = `comptoir-${stamp}-${randomUUID()}`;
  const staging = path.join(targetDir, `.pending-${name}`);
  const destination = path.join(targetDir, name);
  sourceJobs.set(db, true);
  try {
    await fsp.mkdir(staging, { mode: 0o700 });
    await fsp.mkdir(path.join(staging, 'uploads'), { mode: 0o700 });
    const snapshotPath = path.join(staging, 'stock.sqlite');
    await backup(db, snapshotPath);
    await fsp.chmod(snapshotPath, 0o600);
    const snapshot = new DatabaseSync(snapshotPath);
    let references;
    try {
      snapshot.exec('PRAGMA journal_mode=DELETE');
      checkDatabase(snapshot);
      references = referencedPhotos(snapshot);
    } finally { snapshot.close(); }
    const files = [{ path: 'stock.sqlite', ...await copyAndHash(snapshotPath, null, MAX_DATABASE) }];
    let total = files[0].size;
    const images = await fsp.readdir(uploadDir);
    if (images.length + 1 > MAX_FILES) throw backupError('Trop de photos pour cette sauvegarde.');
    for (const name of images.sort()) {
      if (!IMAGE_NAME.test(name)) throw backupError('Le dossier photos contient un fichier inattendu.');
      const relative = `uploads/${name}`;
      const file = { path: relative, ...await copyAndHash(path.join(uploadDir, name), path.join(staging, 'uploads', name), MAX_IMAGE) };
      total += file.size;
      if (total > MAX_TOTAL) throw backupError('La sauvegarde dépasse la taille maximale autorisée.');
      files.push(file);
      references.delete(relative);
    }
    if (references.size) throw backupError(`Photo du catalogue introuvable : ${references.values().next().value}.`);
    const manifest = { format: 'comptoir-backup', version: 1, createdAt: new Date().toISOString(), sessionsPolicy: 'revoked-on-restore', files };
    await fsp.writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await verifyBackup(staging);
    await fsp.rename(staging, destination);
    return { path: destination, manifest };
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true });
    throw error;
  } finally {
    sourceJobs.delete(db);
    if (owned) db.close();
  }
}

async function restoreBackup(options = {}) {
  if (options.serviceStopped !== true) throw backupError('Arrêtez le service avant la restauration et confirmez serviceStopped.', 'SERVICE_MUST_BE_STOPPED');
  if (!options.backupDir || !options.targetDir) throw backupError('La sauvegarde source et un nouveau dossier cible sont requis.');
  const source = await verifyBackup(options.backupDir);
  const target = path.resolve(options.targetDir);
  if (isInside(target, source.path)) throw backupError('La restauration doit utiliser un dossier distinct de la sauvegarde.');
  await directory(path.dirname(target));
  try { await fsp.mkdir(target, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw backupError('Le dossier cible existe déjà : aucune donnée ne sera remplacée.', 'TARGET_EXISTS');
    throw error;
  }
  try {
    await fsp.mkdir(path.join(target, 'uploads'), { mode: 0o700 });
    for (const file of source.manifest.files) {
      const actual = await copyAndHash(path.join(source.path, ...file.path.split('/')), path.join(target, ...file.path.split('/')), file.path === 'stock.sqlite' ? MAX_DATABASE : MAX_IMAGE);
      if (actual.size !== file.size || actual.sha256 !== file.sha256) throw backupError('La sauvegarde a changé pendant la restauration.');
    }
    const db = new DatabaseSync(path.join(target, 'stock.sqlite'));
    try {
      checkDatabase(db, new Set(source.manifest.files.map(file => file.path)));
      db.exec('PRAGMA journal_mode=DELETE; DELETE FROM sessions;');
    } finally { db.close(); }
    await fsp.writeFile(path.join(target, 'restoration.json'), `${JSON.stringify({ format: 'comptoir-restoration', version: 1, restoredAt: new Date().toISOString(), backupCreatedAt: source.manifest.createdAt, sessionsRevoked: true }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { path: target, dbPath: path.join(target, 'stock.sqlite'), uploadDir: path.join(target, 'uploads'), sessionsRevoked: true };
  } catch (error) {
    await fsp.rm(target, { recursive: true, force: true });
    throw error;
  }
}

async function pruneBackups(targetDir, retention) {
  if (!Number.isInteger(retention) || retention < 1 || retention > 365) throw backupError('La rétention doit être comprise entre 1 et 365 sauvegardes.');
  const root = await directory(path.resolve(targetDir));
  const backups = [];
  for (const name of await fsp.readdir(root)) {
    if (!BACKUP_NAME.test(name)) continue;
    try {
      const result = await validateManifest(path.join(root, name));
      backups.push({ path: result.root, createdAt: result.manifest.createdAt });
    } catch { /* Never remove unrelated, symbolic or incomplete directories. */ }
  }
  backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.path.localeCompare(a.path));
  for (const candidate of backups.slice(retention)) await fsp.rm(candidate.path, { recursive: true, force: false });
  return { kept: Math.min(backups.length, retention), removed: Math.max(0, backups.length - retention) };
}

function startBackupScheduler(options = {}) {
  if (!options.targetDir) throw backupError('STOCK_BACKUP_DIR est requis pour programmer les sauvegardes.');
  const intervalMs = options.intervalMs ?? 24 * 60 * 60 * 1000;
  const retention = options.retention ?? 7;
  if (!Number.isFinite(intervalMs) || intervalMs < 10 || intervalMs > 2_147_483_647) throw backupError('Intervalle de sauvegarde invalide.');
  if (!Number.isInteger(retention) || retention < 1 || retention > 365) throw backupError('Rétention de sauvegarde invalide.');
  let stopped = false;
  let active;
  async function run() {
    if (stopped || active) return active;
    active = (async () => {
      try {
        const result = await createBackup(options);
        await pruneBackups(options.targetDir, retention);
        await options.onComplete?.(result);
      } catch (error) {
        if (options.onError) await options.onError(error);
        else console.error('Sauvegarde Comptoir impossible :', error.message);
      }
    })();
    try { await active; } finally { active = undefined; }
  }
  const interval = setInterval(() => { void run(); }, intervalMs);
  interval.unref();
  const first = options.runImmediately === false ? undefined : setTimeout(() => { void run(); }, 0);
  first?.unref();
  return { run, async stop() { stopped = true; clearInterval(interval); if (first) clearTimeout(first); await active; } };
}

async function createBackupArchive({ backupDir, outputPath } = {}) {
  if (!backupDir || !outputPath) throw backupError('La sauvegarde et le chemin de l’archive sont requis.');
  const source = await verifyBackup(backupDir);
  const destination = path.resolve(outputPath);
  if (isInside(destination, source.path)) throw backupError('L’archive doit être créée hors du dossier de sauvegarde.');
  await directory(path.dirname(destination));
  // Reserve the destination; tar must never overwrite an existing user file.
  const reserved = await fsp.open(destination, 'wx', 0o600);
  await reserved.close();
  try {
    await runFile('tar', ['-czf', destination, '-C', source.path, 'manifest.json', 'stock.sqlite', 'uploads'], { timeout: 120_000, maxBuffer: 1024 * 1024 });
    await fsp.chmod(destination, 0o600);
    return { path: destination, size: (await fsp.stat(destination)).size };
  } catch (error) {
    await fsp.rm(destination, { force: true });
    if (error.code === 'ENOENT') throw backupError('Le programme tar est requis uniquement pour créer une archive .tar.gz.', 'TAR_UNAVAILABLE');
    throw error;
  }
}

module.exports = { createBackup, verifyBackup, restoreBackup, pruneBackups, startBackupScheduler, createBackupArchive };
