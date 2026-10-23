"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { goliathPdf } = require("../lib/goliath-reports");

const settings = { name: "Ferme ADEOYE", location: "Ferme fictive pour validation", timezone: "Africa/Porto-Novo" };
const generatedAt = "2026-03-10T12:30:00.000Z";
function batch(id = "batch-1", overrides = {}) {
  return { id, itemId: id, reference: "LOT-" + id, name: "Poussins Goliath de février", arrivalDate: "2026-02-01", hatchDate: "2026-01-31", initialCount: 100, deadCount: 3, soldCount: 20, remainingCount: 77, mortalityRate: 3, ageDays: 38, daysSinceArrival: 37, stage: "growing", location: "Poulailler témoin", supplier: "Éleveur de test", notes: "Observations fictives du lot", createdAt: "2026-02-01T09:00:00.000Z", createdBy: "gestion-test", ...overrides };
}
function event(id, overrides = {}) {
  return { id, batchId: "batch-1", type: "sale", quantity: 20, date: "2026-03-01", time: "10:45", timezone: "Africa/Porto-Novo", reason: "Vente fictive de validation", buyer: "Acheteur témoin", totalAmount: 80000, remainingAfter: 77, createdAt: "2026-03-01T09:45:00.000Z", createdBy: "gestion-test", reference: "EVENT-" + id, ...overrides };
}
function extract(t, bytes) {
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "adeoye-goliath-pdf-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "goliath.pdf"); fs.writeFileSync(filename, bytes);
  const text = execFileSync("pdftotext", ["-layout", filename, "-"], { encoding: "utf8" });
  const info = execFileSync("pdfinfo", [filename], { encoding: "utf8" });
  return { text, compact: text.replace(/\s+/g, ""), info, pages: Number(/Pages:\s+(\d+)/.exec(info)?.[1]) };
}

test("PDF Goliath : lot, âge, mortalité, vente et recettes sont distincts et imprimables", async t => {
  const events = [event("mortality", { type: "mortality", quantity: 3, totalAmount: null, buyer: "", date: "2026-02-05", remainingAfter: 97, reason: "Mortalité constatée, note de test" }), event("sale")];
  const { text, compact, info } = extract(t, await goliathPdf({ batches: [batch()], events, settings, generatedAt }));
  assert.match(info, /A4/);
  for (const expected of ["Élevage Goliath", "Poussins Goliath de février", "01/02/2026", "31/01/2026", "Âge : 38 jour(s)", "Stade saisi : Croissance", "Mortalité : 3", "Vente : 20", "Acheteur témoin", "05/02/2026 à 10:45", "Africa/Porto-Novo", "EVENT-sale", "gestion-test"]) assert.ok(text.includes(expected), expected);
  assert.ok(compact.includes("Effectifdedépart:100·Décès:3·Vendus:20·Restants:77"));
  assert.ok(compact.includes("Recettesdeventesrenseignées:80000FCFA"));
  assert.match(text, /10\/03\/2026 13:30/);
});

test("plusieurs lots gardent tous les événements sur les pages avec en-têtes et chronologie", async t => {
  const batches = [batch(), batch("batch-2", { name: "Deuxième arrivée témoin", initialCount: 200, deadCount: 0, soldCount: 1, remainingCount: 199 })];
  const events = Array.from({ length: 105 }, (_, index) => event(String(index).padStart(3, "0"), { batchId: index % 2 ? "batch-2" : "batch-1", date: index % 3 ? "2026-03-02" : "2026-03-01", quantity: 1, remainingAfter: 50, totalAmount: 999999999999 }));
  const { text, compact, pages } = extract(t, await goliathPdf({ batches, events, settings, generatedAt }));
  assert.ok(pages > 10);
  assert.equal((text.match(/Élevage Goliath · Suivi des lots/g) || []).length, pages);
  assert.equal((text.match(/Document interne/g) || []).length, pages);
  for (let index = 0; index < events.length; index++) assert.equal((text.match(new RegExp("EVENT-" + String(index).padStart(3, "0"), "g")) || []).length, 1);
  assert.match(text, /Deuxième arrivée témoin/);
  assert.ok(compact.includes("Recettesdeventesrenseignées:104999999999895FCFA"));
});

test("âge inconnu et ventes sans montant ne deviennent ni des âges fictifs ni des recettes nulles", async t => {
  const events = [event("known"), event("unknown", { totalAmount: null, quantity: 1 }), event("dead", { type: "mortality", totalAmount: null, quantity: 1 })];
  const { text, compact } = extract(t, await goliathPdf({ batches: [batch("batch-1", { ageDays: null, hatchDate: null, stage: "chicks" })], events, settings, generatedAt }));
  assert.match(text, /Âge non renseigné/);
  assert.match(text, /Date d’éclosion non renseignée/);
  assert.match(text, /Stade saisi : Poussins/);
  assert.match(text, /Montant de vente : non renseigné/);
  assert.ok(compact.includes("1vente(s)sansmontantrenseigné"));
  assert.ok(compact.includes("Recettesdeventesrenseignées:80000FCFA"));
  assert.ok(!text.includes("Montant de vente : 0"));
});

test("recettes cumulées supérieures à MAX_SAFE_INTEGER restent exactes et les événements étrangers sont exclus", async t => {
  const events = [event("large1", { totalAmount: Number.MAX_SAFE_INTEGER }), event("large2", { totalAmount: Number.MAX_SAFE_INTEGER }), event("foreign", { batchId: "outside", totalAmount: 700000 })];
  const { text, compact } = extract(t, await goliathPdf({ batches: [batch()], events, settings, generatedAt }));
  assert.ok(compact.includes("Recettesdeventesrenseignées:18014398509481982FCFA"));
  assert.ok(!text.includes("EVENT-foreign"));
});

test("tous les champs maximaux et les longues observations sont exportés sans texte coupé", async t => {
  const longBatch = batch("batch-1", { name: "W".repeat(160), location: "W".repeat(160), supplier: "W".repeat(160), notes: "W".repeat(1984) + "FINOBSERVATIONLOT", createdBy: "W".repeat(80) });
  const longEvent = event("maximal", { buyer: "W".repeat(160), reason: "W".repeat(984) + "FINOBSVENTEGOLIA", createdBy: "W".repeat(80) });
  const { text, compact, pages } = extract(t, await goliathPdf({ batches: [longBatch], events: [longEvent], settings: { ...settings, name: "W".repeat(120), location: "W".repeat(200) }, generatedAt }));
  assert.ok(pages >= 3);
  assert.ok(compact.includes("FINOBSERVATIONLOT"));
  assert.ok(compact.includes("FINOBSVENTEGOLIA"));
  assert.ok(compact.includes("Recettesdeventesrenseignées:80000FCFA"));
  assert.equal((text.match(/Élevage Goliath · Suivi des lots/g) || []).length, pages);
});

test("une ferme sans lot produit un rapport PDF vide valable", async t => {
  const { text, compact, pages } = extract(t, await goliathPdf({ settings, generatedAt }));
  assert.equal(pages, 1);
  assert.match(text, /Aucun lot Goliath enregistré/);
  assert.ok(compact.includes("Recettesdeventesrenseignées:0FCFA"));
});
