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

test("Les règlements groupés répartissent le montant entre les mensualités sans répéter le total", () => {
  const data = {
    students: [{ id: "pupil", monthlyFee: 4500 }],
    payments: [
      { id: "three-months", student: "pupil", period: "2026-10", periods: ["2026-10", "2026-11", "2026-12"], amount: 11000, date: "2026-09-30", allocations: [{ period: "2026-10", amount: 2000 }, { period: "2026-11", amount: 4500 }, { period: "2026-12", amount: 4500 }] },
      { student: "pupil", period: "2026-10", amount: 500 },
      { student: "pupil", period: "2026-10", periods: ["2026-10", "2026-11"], amount: 9000, allocations: [{ period: "2026-10", amount: 4500 }, { period: "2026-11", amount: 4500 }], mode: "sandbox" },
    ],
  };
  const original = structuredClone(data);
  const row = (period) => calculateMonthlyBalances(data, period)[0];
  assert.deepEqual([row("2026-10").paid, row("2026-10").balance, row("2026-10").status], [2500, 2000, "Partiel"]);
  for (const period of ["2026-11", "2026-12"])
    assert.deepEqual([row(period).paid, row(period).balance, row(period).status], [4500, 0, "Réglé"]);
  assert.equal(row("2027-01").paid, 0);
  assert.equal(["2026-10", "2026-11", "2026-12"].reduce((total, period) => total + row(period).paid, 0), 11500);
  assert.deepEqual(data, original);
});
