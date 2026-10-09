'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { StockService } = require('../lib/business');
const { createBackup, verifyBackup, restoreBackup, startBackupScheduler, createBackupArchive } = require('../lib/backups');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comptoir-backup-test-'));
  const dbPath = path.join(root, 'live', 'stock.sqlite');
  const uploadDir = path.join(root, 'live', 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const service = new StockService({ dbPath, production: false });
  const login = service.authenticate('admin@stock.local', 'Demo2026!');
  const image = `${randomUUID()}.png`;
  const orphan = `${randomUUID()}.jpg`;
  const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  fs.writeFileSync(path.join(uploadDir, image), imageBytes);
  fs.writeFileSync(path.join(uploadDir, orphan), Buffer.from([255, 216, 255, 4]));
  const product = service.get('products', 'product-riz');
  service.command(login.user, { id: randomUUID(), type: 'product.save', payload: { ...product, expectedVersion: product.version, photo: `/uploads/${image}` } });
  t.after(() => { service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, service, dbPath, uploadDir, login, image, orphan, imageBytes, targetDir: path.join(root, 'backups') };
}

test('online SQLite backup preserves transactional stock, images and credentials; restoration revokes sessions', async t => {
  const f = fixture(t);
  const before = f.service.state(f.login.user);
  const originalStock = before.stocks.find(row => row.productId === 'product-riz' && row.storeId === 'store-centre').quantity;
  const job = createBackup(f);
  await new Promise(resolve => setImmediate(resolve));
  for (let index = 0; index < 3; index++) f.service.command(f.login.user, { id: randomUUID(), type: 'document.create', payload: { type: 'sale', storeId: 'store-centre', lines: [{ productId: 'product-riz', quantity: 0.125, unitPrice: 4500 }], paid: 563 } });
  const result = await job;
  assert.equal(result.manifest.version, 1);
  assert.equal(result.manifest.files.length, 3);
  assert.ok(result.manifest.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.deepEqual(await fsp.readFile(path.join(result.path, 'uploads', f.image)), f.imageBytes);
  assert.ok(fs.existsSync(path.join(result.path, 'uploads', f.orphan)));
  assert.equal((await verifyBackup(result.path)).path, result.path);
  const snapshot = new DatabaseSync(path.join(result.path, 'stock.sqlite'), { readOnly: true });
  const snapshotDocs = snapshot.prepare('SELECT data FROM documents').all().map(row => JSON.parse(row.data));
  const stock = snapshot.prepare('SELECT quantity FROM stocks WHERE product_id=? AND store_id=?').get('product-riz', 'store-centre').quantity / 1000;
  assert.equal(stock, originalStock - (snapshotDocs.length - before.documents.length) * 0.125);
  assert.equal(snapshot.prepare('SELECT COUNT(*) AS total FROM sessions').get().total, 1);
  snapshot.close();

  const restored = await restoreBackup({ backupDir: result.path, targetDir: path.join(f.root, 'restored'), serviceStopped: true });
  const recovered = new StockService({ dbPath: restored.dbPath, production: false });
  try {
    assert.equal(recovered.session(f.login.token), null);
    assert.ok(f.service.session(f.login.token));
    const login = recovered.authenticate('admin@stock.local', 'Demo2026!');
    assert.equal(recovered.state(login.user).documents.length, snapshotDocs.length);
    assert.deepEqual(fs.readFileSync(path.join(restored.uploadDir, f.image)), f.imageBytes);
  } finally { recovered.close(); }
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(result.path).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(result.path, 'stock.sqlite')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(result.path, 'manifest.json')).mode & 0o777, 0o600);
  }
});

test('damaged checksums, traversal entries, missing photos and symbolic links are rejected before restoration', async t => {
  const f = fixture(t);
  const result = await createBackup(f);
  const photo = path.join(result.path, 'uploads', f.image);
  await fsp.appendFile(photo, Buffer.from([0]));
  await assert.rejects(restoreBackup({ backupDir: result.path, targetDir: path.join(f.root, 'unsafe'), serviceStopped: true }), /SHA-256/);
  assert.equal(fs.existsSync(path.join(f.root, 'unsafe')), false);
  await fsp.writeFile(photo, f.imageBytes);
  const manifestPath = path.join(result.path, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  const poisoned = structuredClone(manifest);
  poisoned.files[1].path = 'uploads/../../outside.png';
  await fsp.writeFile(manifestPath, JSON.stringify(poisoned));
  await assert.rejects(verifyBackup(result.path), /non autorisée/);
  await fsp.writeFile(manifestPath, JSON.stringify(manifest));
  await fsp.unlink(photo);
  await assert.rejects(verifyBackup(result.path));
  if (process.platform !== 'win32') {
    await fsp.symlink(path.join(f.uploadDir, f.image), photo);
    await assert.rejects(verifyBackup(result.path), /non autorisé/);
    await fsp.unlink(photo);
  }
  await fsp.writeFile(photo, f.imageBytes);
  assert.equal((await verifyBackup(result.path)).manifest.files.length, 3);
  assert.ok(f.service.session(f.login.token));
});

test('restore never replaces an existing destination and requires service stop acknowledgement', async t => {
  const f = fixture(t);
  const result = await createBackup(f);
  await assert.rejects(restoreBackup({ backupDir: result.path, targetDir: path.join(f.root, 'recovered') }), error => error.code === 'SERVICE_MUST_BE_STOPPED');
  await assert.rejects(restoreBackup({ backupDir: result.path, targetDir: path.dirname(f.dbPath), serviceStopped: true }), error => error.code === 'TARGET_EXISTS');
  assert.ok(f.service.session(f.login.token));
  await assert.rejects(restoreBackup({ backupDir: result.path, targetDir: path.join(result.path, 'restored'), serviceStopped: true }), /distinct/);
  const output = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'restore.js'), `--from=${result.path}`, `--to=${path.join(f.root, 'cli-restored')}`], { encoding: 'utf8' });
  assert.equal(output.status, 1);
  assert.match(output.stderr, /Arrêtez le service/);
  assert.equal(fs.existsSync(path.join(f.root, 'cli-restored')), false);
});

test('a missing referenced image aborts cleanly without publishing a partial backup', async t => {
  const f = fixture(t);
  await fsp.unlink(path.join(f.uploadDir, f.image));
  await assert.rejects(createBackup(f), /Photo du catalogue introuvable/);
  assert.deepEqual(await fsp.readdir(f.targetDir), []);
  assert.ok(f.service.session(f.login.token));
});

test('scheduled backup retention preserves unrelated directories and stop waits for the active backup', async t => {
  const f = fixture(t);
  await fsp.mkdir(f.targetDir);
  const keep = path.join(f.targetDir, 'important-other-data');
  await fsp.mkdir(keep);
  await fsp.writeFile(path.join(keep, 'keep.txt'), 'preserved');
  const completed = [];
  const failures = [];
  const scheduler = startBackupScheduler({ ...f, intervalMs: 100_000, runImmediately: false, retention: 2, onComplete: result => completed.push(result.path), onError: error => failures.push(error) });
  t.after(() => scheduler.stop());
  await scheduler.run();
  await scheduler.run();
  const active = scheduler.run();
  await scheduler.stop();
  await active;
  assert.equal(completed.length, 3);
  assert.deepEqual(failures, []);
  assert.equal((await fsp.readdir(f.targetDir)).filter(name => name.startsWith('comptoir-')).length, 2);
  assert.equal(await fsp.readFile(path.join(keep, 'keep.txt'), 'utf8'), 'preserved');
  await scheduler.run();
  assert.equal(completed.length, 3);
});

test('standalone backup CLI can read an existing live WAL database and validates the resulting bundle', async t => {
  const f = fixture(t);
  const script = path.join(__dirname, '..', 'scripts', 'backup.js');
  const output = spawnSync(process.execPath, [script, `--db=${f.dbPath}`, `--uploads=${f.uploadDir}`, `--to=${f.targetDir}`], { encoding: 'utf8' });
  assert.equal(output.status, 0, output.stderr);
  const [name] = await fsp.readdir(f.targetDir);
  const verification = spawnSync(process.execPath, [script, `--verify=${path.join(f.targetDir, name)}`], { encoding: 'utf8' });
  assert.equal(verification.status, 0, verification.stderr);
  assert.match(verification.stdout, /Sauvegarde vérifiée/);
  const nonexistent = spawnSync(process.execPath, [script, `--db=${path.join(f.root, 'missing.sqlite')}`, `--uploads=${f.uploadDir}`, `--to=${f.targetDir}`], { encoding: 'utf8' });
  assert.equal(nonexistent.status, 1);
  assert.equal(fs.existsSync(path.join(f.root, 'missing.sqlite')), false);
});

test('optional tar archive includes all components and refuses an existing output file', async t => {
  if (spawnSync('tar', ['--version'], { encoding: 'utf8' }).error) { t.skip('tar is unavailable'); return; }
  const f = fixture(t);
  const result = await createBackup(f);
  const outputPath = path.join(f.root, 'backup.tar.gz');
  const archive = await createBackupArchive({ backupDir: result.path, outputPath });
  assert.ok(archive.size > 0);
  const entries = spawnSync('tar', ['-tzf', outputPath], { encoding: 'utf8' });
  assert.equal(entries.status, 0, entries.stderr);
  assert.match(entries.stdout, /manifest.json/);
  assert.match(entries.stdout, /stock.sqlite/);
  assert.ok(entries.stdout.includes(`uploads/${f.image}`));
  await assert.rejects(createBackupArchive({ backupDir: result.path, outputPath }), error => error.code === 'EEXIST');
  assert.ok((await fsp.stat(outputPath)).size > 0);
});
