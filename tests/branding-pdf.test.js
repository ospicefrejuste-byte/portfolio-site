"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");
const { inventoryPdf, expensesPdf } = require("../lib/reports");
const { goliathPdf } = require("../lib/goliath-reports");

function logoPng() {
  function chunk(kind, data) {
    const type = Buffer.from(kind), bytes = Buffer.concat([type, data]);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, bytes, checksum]);
  }
  const width = 32, height = 16, header = Buffer.alloc(13), pixels = Buffer.alloc((width * 4 + 1) * height);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const position = y * (width * 4 + 1) + 1 + x * 4;
    pixels[position] = 22; pixels[position + 1] = x < 16 ? 71 : 170; pixels[position + 2] = 52;
    pixels[position + 3] = x < 2 || y < 2 ? 0 : 255;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

const logo = logoPng();
const settings = { name: "Ferme ADEOYE", location: "Ferme fictive de validation", timezone: "Africa/Porto-Novo" };
const generatedAt = "2026-03-10T12:30:00.000Z";
const item = index => ({ id: "item-" + index, name: "Maïs témoin " + index, category: "Aliments et intrants", quantity: 10, minQuantity: 2, unit: "kg", unitValue: 300, estimatedValue: 3000, location: "Magasin fictif", active: true });
const expense = index => ({ id: "expense-" + index, description: "Achat témoin " + index, category: "Transport", supplier: "Fournisseur fictif", amount: 1200, date: "2026-03-01", time: "09:45", timezone: "Africa/Porto-Novo", notes: "Note de test", createdBy: "responsable-test", reference: "EXP-" + index });
const batch = { id: "lot-1", reference: "LOT-GOLIATH-TEST", name: "Lot témoin Goliath", arrivalDate: "2026-02-01", hatchDate: null, initialCount: 100, deadCount: 0, soldCount: 30, remainingCount: 70, ageDays: null, daysSinceArrival: 37, stage: "growing", location: "Poulailler fictif", supplier: "Couvoir fictif", notes: "Lot de test", createdBy: "responsable-test", createdAt: "2026-02-01T09:00:00.000Z" };
const event = index => ({ id: "event-" + index, batchId: batch.id, type: "sale", quantity: 1, date: "2026-03-01", time: "10:45", timezone: "Africa/Porto-Novo", buyer: "Acheteur témoin", totalAmount: 2500, remainingAfter: 99 - index, reason: "Vente fictive " + index, createdBy: "responsable-test", reference: "SALE-" + index, createdAt: "2026-03-01T09:45:00.000Z" });

function inspect(t, bytes) {
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "adeoye-branding-pdf-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "report.pdf"); fs.writeFileSync(filename, bytes);
  const text = execFileSync("pdftotext", ["-layout", filename, "-"], { encoding: "utf8" });
  const raw = execFileSync("pdftotext", ["-raw", filename, "-"], { encoding: "utf8" });
  const info = execFileSync("pdfinfo", [filename], { encoding: "utf8" });
  const images = execFileSync("pdfimages", ["-list", filename], { encoding: "utf8" }).split("\n").filter(line => /^\s*\d+\s+\d+\s+(?:image|smask)\s/.test(line)).map(line => {
    const fields = line.trim().split(/\s+/);
    return { page: Number(fields[0]), type: fields[2], width: Number(fields[3]), height: Number(fields[4]), xppi: Number(fields[12]), yppi: Number(fields[13]) };
  });
  return { text, compact: text.replace(/\s+/g, ""), rawCompact: raw.replace(/\s+/g, ""), pages: Number(/Pages:\s+(\d+)/.exec(info)?.[1]), images };
}

function everyPageHasLogo(result) {
  const actual = result.images.filter(image => image.type === "image");
  for (let page = 1; page <= result.pages; page++) {
    const image = actual.find(value => value.page === page);
    assert.ok(image, "Logo absent de la page " + page);
    assert.equal(image.width, 32); assert.equal(image.height, 16);
    assert.ok(Math.abs(image.xppi - image.yppi) <= 1, "Les proportions du logo sont conservées");
  }
  assert.ok(result.images.some(image => image.type === "smask"), "La transparence PNG est conservée dans le PDF");
}

test("le logo transparent est intégré sur chaque page des trois rapports sans perdre chiffres ou détails", async t => {
  const inventory = inspect(t, await inventoryPdf({ items: Array.from({ length: 90 }, (_, index) => item(index)), settings, generatedAt, logo }));
  assert.ok(inventory.pages > 3); everyPageHasLogo(inventory);
  assert.match(inventory.text, /Maïs témoin 89/);
  assert.ok(inventory.compact.includes("270000FCFA"));
  const expenses = inspect(t, await expensesPdf({ expenses: Array.from({ length: 45 }, (_, index) => expense(index)), settings, generatedAt, logo }));
  assert.ok(expenses.pages > 3); everyPageHasLogo(expenses);
  assert.match(expenses.text, /EXP-44/); assert.ok(expenses.compact.includes("Totaldesdépenses:54000FCFA"));
  const poultry = inspect(t, await goliathPdf({ batches: [batch], events: Array.from({ length: 30 }, (_, index) => event(index)), settings, generatedAt, logo }));
  assert.ok(poultry.pages > 3); everyPageHasLogo(poultry);
  assert.match(poultry.text, /SALE-29/); assert.ok(poultry.compact.includes("Recettesdeventesrenseignées:75000FCFA"));
});

test("les rapports vides utilisent le logo personnalisé et restent valables après son retrait", async t => {
  for (const generator of [inventoryPdf, expensesPdf, goliathPdf]) {
    const branded = inspect(t, await generator({ settings, generatedAt, logo }));
    assert.equal(branded.pages, 1); everyPageHasLogo(branded);
    const reset = inspect(t, await generator({ settings, generatedAt, logo: null }));
    assert.equal(reset.pages, 1); assert.deepEqual(reset.images, []);
    assert.match(reset.text, /Ferme ADEOYE/);
  }
});

test("le logo ne coupe pas les noms maximaux ni les longues observations des rapports", async t => {
  const farm = { ...settings, name: "W".repeat(120), location: "W".repeat(200) };
  const inventory = inspect(t, await inventoryPdf({ items: Array.from({ length: 12 }, (_, index) => ({ ...item(index), name: "W".repeat(150) + "FINARTICLE", location: "W".repeat(150) + "FINLIEU" })), settings: farm, generatedAt, logo }));
  everyPageHasLogo(inventory); assert.ok(inventory.rawCompact.includes("FINARTICLE")); assert.ok(inventory.rawCompact.includes("FINLIEU"));
  const expenses = inspect(t, await expensesPdf({ expenses: [{ ...expense(1), description: "W".repeat(160), supplier: "W".repeat(160), notes: "W".repeat(1984) + "FINNOTEMAXIMALE" }], settings: farm, generatedAt, logo }));
  everyPageHasLogo(expenses); assert.ok(expenses.compact.includes("FINNOTEMAXIMALE"));
  const poultry = inspect(t, await goliathPdf({ batches: [{ ...batch, name: "W".repeat(160), notes: "W".repeat(1984) + "FINOBSERVATIONLOT" }], events: [{ ...event(1), reason: "W".repeat(984) + "FINOBSVENTEGOLIA" }], settings: farm, generatedAt, logo }));
  everyPageHasLogo(poultry); assert.ok(poultry.compact.includes("FINOBSERVATIONLOT")); assert.ok(poultry.compact.includes("FINOBSVENTEGOLIA"));
});

test("un chemin ou une URL ne peut pas servir de source d’image au générateur PDF", async () => {
  for (const generator of [inventoryPdf, expensesPdf, goliathPdf]) {
    await assert.rejects(generator({ logo: "/etc/passwd" }), /image PNG validée/);
    await assert.rejects(generator({ logo: "https://example.com/logo.png" }), /image PNG validée/);
  }
});
