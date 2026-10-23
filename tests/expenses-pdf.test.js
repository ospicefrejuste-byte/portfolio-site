"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { expensesPdf, inventoryPdf } = require("../lib/reports");

const settings = { name: "Ferme ADEOYE", location: "Exploitation fictive de test", timezone: "Africa/Porto-Novo" };
const generatedAt = "2026-03-02T12:30:00.000Z";
function expense(index = 0, extras = {}) {
  return { id: "expense-" + index, description: "Achat échantillon " + String(index).padStart(3, "0"), category: "Aliments et intrants", supplier: "Coopérative témoin", amount: 4500, date: "2026-02-28", time: "09:45", timezone: "Africa/Porto-Novo", notes: "Achat fictif uniquement pour le test.", createdAt: "2026-03-01T00:00:00.000Z", createdBy: "gestion-test", reference: "REF-" + String(index).padStart(3, "0"), ...extras };
}
function extract(t, bytes) {
  assert.equal(bytes.subarray(0, 5).toString("ascii"), "%PDF-");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "adeoye-expenses-pdf-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "expenses.pdf");
  fs.writeFileSync(filename, bytes);
  const text = execFileSync("pdftotext", ["-layout", filename, "-"], { encoding: "utf8" });
  const info = execFileSync("pdfinfo", [filename], { encoding: "utf8" });
  return { text, compact: text.replace(/\s+/g, ""), info, pages: Number(/Pages:\s+(\d+)/.exec(info)?.[1]) };
}

test("rapport de dépenses imprimable : période inclusive, heures de la ferme, accents et montant d’achat", async t => {
  const pdf = await expensesPdf({ expenses: [expense()], from: "2026-02-01", to: "2026-02-28", settings, generatedAt });
  const { text, compact, pages, info } = extract(t, pdf);
  assert.equal(pages, 1);
  assert.match(info, /A4/);
  assert.match(text, /Dépenses et achats/);
  assert.match(text, /Du 01\/02\/2026 au 28\/02\/2026 inclus/);
  assert.match(text, /28\/02\/2026/);
  assert.match(text, /09:45/);
  assert.match(text, /Africa\/Porto-Novo/);
  assert.match(text, /02\/03\/2026 13:30/);
  assert.match(text, /Coopérative témoin/);
  assert.match(text, /gestion-test/);
  assert.match(text, /REF-000/);
  assert.ok(compact.includes("Totaldesdépenses:4500FCFA"));
  assert.ok(!text.includes("Valeur estimée"));
});

test("toutes les dépenses et notes sont présentes dans un rapport multipage avec en-têtes et total exact", async t => {
  const expenses = Array.from({ length: 111 }, (_, index) => expense(index, { amount: 999999999999 }));
  expenses[0].notes = "Texte de contrôle détaillé. ".repeat(72) + "FINNOTEMAXIMALE";
  expenses[1].timezone = "America/New_York";
  const { text, compact, pages } = extract(t, await expensesPdf({ expenses, from: "2026-02-01", to: "2026-02-28", settings, generatedAt }));
  assert.ok(pages > 10);
  assert.equal((text.match(/Dépenses et achats/g) || []).length, pages);
  for (let index = 0; index < expenses.length; index++) {
    assert.equal((text.match(new RegExp("REF-" + String(index).padStart(3, "0"), "g")) || []).length, 1, "Dépense " + index + " manquante ou répétée");
  }
  assert.match(text, /FINNOTEMAXIMALE/);
  assert.match(text, /America\/New_York/);
  assert.ok(compact.includes("Totaldesdépenses:110999999999889FCFA"));
  assert.ok(compact.includes("111dépense(s)enregistrée(s)"));
  assert.equal((text.match(/Document interne/g) || []).length, pages);
});

test("un total supérieur aux entiers exacts JavaScript reste exact dans le PDF", async t => {
  // API amounts are capped below this; the report nevertheless preserves any
  // individually safe integer and never rounds an aggregate through Number.
  const expenses = [expense(1, { amount: Number.MAX_SAFE_INTEGER }), expense(2, { amount: Number.MAX_SAFE_INTEGER })];
  const { compact } = extract(t, await expensesPdf({ expenses, total: "wrong", settings, generatedAt }));
  assert.ok(compact.includes("Totaldesdépenses:18014398509481982FCFA"));
});

test("tous les champs à leur longueur maximale restent exportables sans couper les notes", async t => {
  const rows = [expense(1, { description: "W".repeat(160), supplier: "W".repeat(160), amount: 1e12, notes: "W".repeat(1985) + "FINNOTEMAXIMALE", createdBy: "W".repeat(64), reference: "A".repeat(36) })];
  assert.equal(rows[0].notes.length, 2000);
  const { text, compact, pages } = extract(t, await expensesPdf({ expenses: rows, settings: { ...settings, name: "W".repeat(120), location: "W".repeat(200) }, generatedAt }));
  assert.ok(pages >= 2);
  assert.match(text, /Suite de la dépense/);
  assert.match(text, /FINNOTEMAXIMALE/);
  assert.ok(compact.includes("Totaldesdépenses:1000000000000FCFA"));
  assert.equal((text.match(/Dépenses et achats/g) || []).length, pages);
});

test("période sans dépense : PDF valable, total nul, bornes ouvertes et inventaire toujours disponible", async t => {
  const first = extract(t, await expensesPdf({ from: "2026-02-01", expenses: [], settings, generatedAt }));
  assert.equal(first.pages, 1);
  assert.match(first.text, /À partir du 01\/02\/2026 inclus/);
  assert.match(first.text, /Aucune dépense enregistrée pour cette période/);
  assert.ok(first.compact.includes("Totaldesdépenses:0FCFA"));
  const second = extract(t, await expensesPdf({ to: "2026-02-28", expenses: [], settings, generatedAt }));
  assert.match(second.text, /Jusqu’au 28\/02\/2026 inclus/);
  const all = extract(t, await expensesPdf({ expenses: [], settings, generatedAt }));
  assert.match(all.text, /Toutes les dépenses enregistrées/);
  const inventory = extract(t, await inventoryPdf({ items: [], settings, generatedAt }));
  assert.match(inventory.text, /Inventaire de la ferme/);
});
