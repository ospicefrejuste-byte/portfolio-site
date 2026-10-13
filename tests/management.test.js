"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { calculateMonthlyBalances } = require("../lib/management");

test("Les mensualités distinguent les sommes reçues, le reste dû et les tests sans facturer les préinscriptions", () => {
  const data = {
    students: [
      { id: "partial", name: "Élève partiel", monthlyFee: 4500, registrationStatus: "Inscrit" },
      { id: "old", name: "Ancien dossier", monthlyFee: 3500 },
      { id: "credit", monthlyFee: 4000, registrationStatus: "Inscrit" },
      { id: "pre", monthlyFee: 4500, registrationStatus: "Préinscription" },
      { id: "paused", monthlyFee: 5000, registrationStatus: "Suspendu" },
    ],
    payments: [
      { student: "partial", period: "2026-10", amount: 1000, date: "2026-09-30" },
      { student: "partial", period: "2026-10", amount: 500, date: "2026-11-01" },
      { student: "partial", period: "2026-10", amount: 4500, mode: "sandbox" },
      { student: "partial", period: "2026-09", amount: 9000 },
      { student: "old", period: "2026-10", amount: 3500, source: "KKiaPay", mode: "live" },
      { student: "credit", period: "2026-10", amount: 5000 },
      { student: "paused", period: "2026-10", amount: 2000 },
      { student: "unknown", period: "2026-10", amount: 1200 },
    ],
  };
  const original = structuredClone(data);
  const rows = calculateMonthlyBalances(data, "2026-10");
  assert.equal(rows.length, 5);
  const row = (id) => rows.find((value) => value.student === id);
  assert.deepEqual([row("partial").fee, row("partial").paid, row("partial").balance, row("partial").status], [4500, 1500, 3000, "Partiel"]);
  assert.deepEqual([row("old").registrationStatus, row("old").balance, row("old").status], ["Inscrit", 0, "Réglé"]);
  assert.deepEqual([row("credit").balance, row("credit").advance, row("credit").status], [0, 1000, "Avance"]);
  assert.deepEqual([row("pre").fee, row("pre").balance, row("pre").status], [0, 0, "Non facturé"]);
  assert.deepEqual([row("paused").fee, row("paused").paid, row("paused").balance, row("paused").status], [0, 2000, 0, "Non facturé"]);
  assert.deepEqual(data, original, "Calculer les mensualités ne modifie aucun dossier.");
});

test("Les anciens dossiers incomplets restent lisibles et les mois invalides sont refusés", () => {
  const result = calculateMonthlyBalances({ students: [{ id: "free", monthlyFee: -1 }, { id: "due", monthlyFee: 3500 }], payments: [{ student: "due", period: "2026-10", amount: "invalide" }] }, "2026-10");
  assert.equal(result[0].fee, 0);
  assert.equal(result[0].status, "Non facturé");
  assert.equal(result[1].status, "À régler");
  assert.equal(result[1].balance, 3500);
  assert.deepEqual(calculateMonthlyBalances({}, "2026-10"), []);
  for (const period of [undefined, "2026-00", "2026-13", "2026-1", "2026-10<script>"])
    assert.throws(() => calculateMonthlyBalances({}, period), RangeError);
});
