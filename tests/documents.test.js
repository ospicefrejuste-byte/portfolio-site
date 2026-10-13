"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createStudentReport, createPaymentReceipt } = require("../lib/documents");

const canExtract = !spawnSync("pdftotext", ["-v"]).error;
function extract(buffer) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "crs-document-test-"));
  try {
    const filename = path.join(folder, "document.pdf");
    fs.writeFileSync(filename, buffer);
    const result = spawnSync("pdftotext", ["-layout", filename, "-"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.replace(/\s+/g, " ");
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
}
function assertPdf(buffer) {
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.subarray(0, 5).toString(), "%PDF-");
  assert.match(buffer.toString("latin1"), /%%EOF\s*$/);
}

test("Le bilan PDF conserve les accents, filtre les dates et sépare les paiements de test", { skip: !canExtract }, async () => {
  const student = { id: "pupil", name: "Grâce Élodie — élève", class: "Première D – C", centre: "La Boussole", group: "Première", guardian: "Responsable fictif" };
  const courses = [{ id: "a", date: "2026-10-05", subject: "Mathématiques" }, { id: "b", date: "2026-10-12", subject: "Physique-Chimie" }, { id: "past", date: "2026-09-01", subject: "ANCIEN COURS" }];
  const grades = [{ student: "pupil", course: "a", label: "Contrôle", score: 12 }, { student: "pupil", course: "b", label: "Devoir", score: 18 }, { student: "pupil", course: "past", label: "ANCIENNE NOTE", score: 0 }, { student: "other", course: "a", label: "AUTRE ÉLÈVE", score: 2 }];
  const attendance = [
    { student: "pupil", course: "a", status: "Présent" }, { student: "pupil", course: "b", status: "Absent" },
    { student: "pupil", course: "a", status: "Retard" }, { student: "pupil", course: "a", status: "Excusé" },
  ];
  const payments = [
    { student: "pupil", period: "2026-09", amount: 1500, date: "2026-10-10" },
    { student: "pupil", period: "2026-10", amount: 999, date: "2026-10-11", mode: "sandbox" },
    { student: "pupil", period: "2026-10", amount: 8000, date: "2026-11-01" },
    { student: "other", period: "2026-10", amount: 7777, date: "2026-10-10" },
  ];
  const buffer = await createStudentReport({ student, courses, grades, attendance, payments, school: { name: "École de la réussite", phones: ["01 00 00 00 00"] }, from: "2026-10-01", to: "2026-10-31" });
  assertPdf(buffer);
  const output = extract(buffer);
  assert.match(output, /École de la réussite/);
  assert.match(output, /Grâce Élodie — élève/);
  assert.match(output, /Moyenne générale : 15,0 \/ 20/);
  assert.match(output, /Taux de présence : 67 %/);
  assert.match(output, /Total des règlements réels : 1 500 FCFA/);
  assert.match(output, /Transactions de test — hors règlements/);
  assert.match(output, /999 FCFA/);
  assert.doesNotMatch(output, /ANCIENNE NOTE|AUTRE ÉLÈVE|ANCIEN COURS|8 000 FCFA|7 777 FCFA/);
});

test("Le bilan sépare les présences du jour des cours et conserve l’école et la classe du pointage", { skip: !canExtract }, async () => {
  const student = { id: "pupil", name: "Grâce Élève", class: "4e", centre: "Centre actuel" };
  const buffer = await createStudentReport({
    student,
    courses: [{ id: "course", date: "2026-10-10", subject: "Mathématiques" }],
    attendance: [{ student: "pupil", course: "course", status: "Absent" }],
    dailyAttendance: [
      { id: "private-row-id", student: "pupil", date: "2026-10-05", class: "6e", centre: "École des Érables", status: "Présent", revision: 4, markedByName: "private-cashier-name" },
      { student: "pupil", date: "2026-10-12", class: "6e", centre: "École des Érables", status: "Absent" },
      { student: "pupil", date: "2026-10-22", class: "5e", centre: "École de Grâce", status: "Présent" },
      { student: "pupil", date: "2026-10-23", class: "POINTAGE EFFACÉ", centre: "ÉCOLE EFFACÉE", status: null },
      { student: "pupil", date: "2026-09-30", class: "ANCIEN POINTAGE", centre: "ANCIEN CENTRE", status: "Absent" },
      { student: "pupil", date: "2026-11-01", class: "POINTAGE FUTUR", centre: "CENTRE FUTUR", status: "Absent" },
      { student: "other", date: "2026-10-13", class: "AUTRE ÉLÈVE", centre: "AUTRE CENTRE", status: "Absent" },
    ],
    from: "2026-10-01", to: "2026-10-31",
  });
  assertPdf(buffer);
  const output = extract(buffer);
  assert.match(output, /Présences par cours/);
  assert.match(output, /Taux de présence : 0 %/);
  assert.match(output, /Présences du jour/);
  assert.match(output, /Taux de présence par jour : 67 %/);
  assert.match(output, /Jours présents : 2 · Jours absents : 1/);
  assert.match(output, /École \/ centre/);
  assert.match(output, /05\/10\/2026 6e École des Érables Présent/);
  assert.match(output, /22\/10\/2026 5e École de Grâce Présent/);
  assert.doesNotMatch(output, /POINTAGE EFFACÉ|ÉCOLE EFFACÉE|ANCIEN POINTAGE|ANCIEN CENTRE|POINTAGE FUTUR|CENTRE FUTUR|AUTRE ÉLÈVE|AUTRE CENTRE|private-row-id|private-cashier-name/);
  const clearedOnly = extract(await createStudentReport({ student, dailyAttendance: [{ student: "pupil", date: "2026-10-10", status: null }] }));
  assert.match(clearedOnly, /Taux de présence par jour : non disponible/);
  assert.match(clearedOnly, /Jours présents : 0 · Jours absents : 0/);
});

test("Le reçu distingue les paiements réels et les essais et garde les références", { skip: !canExtract }, async () => {
  const student = { id: "pupil", name: "Élève Grâce", class: "6e" };
  const payment = { id: "receipt-123", student: "pupil", amount: 3500, period: "2026-10", date: "2026-10-13", source: "KKiaPay", transactionId: "transaction-456", mode: "live" };
  const real = await createPaymentReceipt({ student, payment });
  assertPdf(real);
  const realText = extract(real);
  assert.match(realText, /Reçu de paiement/);
  assert.match(realText, /3 500 FCFA/);
  assert.match(realText, /receipt-123/);
  assert.match(realText, /transaction-456/);
  assert.match(realText, /13\/10\/2026/);
  assert.match(realText, /En ligne — KKiaPay — transaction confirmée/);
  assert.doesNotMatch(realText, /TRANSACTION DE TEST/);
  const trial = await createPaymentReceipt({ student, payment: { ...payment, mode: "sandbox" } });
  assert.match(extract(trial), /TRANSACTION DE TEST — AUCUN RÈGLEMENT RÉEL/);
});

test("Le reçu de caisse identifie le parent et le caissier avec une référence complète", { skip: !canExtract }, async () => {
  const student = { id: "internal-pupil-id", name: "Élève Camille", class: "5e", centre: "Centre École", guardian: "Parent Camille" };
  const payment = {
    id: "642111d7-b523-48dd-8332-9dcb3e037014", student: student.id,
    amount: 4500, period: "2026-10", date: "2026-10-13", source: "Caisse", channel: "cash",
    collectedByName: "caissière-école", collectedBy: "internal-user-id", idempotencyKey: "secret-operation-key",
  };
  const buffer = await createPaymentReceipt({ student, payment, school: { name: "Établissement de test" } });
  assertPdf(buffer);
  const output = extract(buffer);
  assert.match(output, /En présentiel — espèces/);
  assert.match(output, /4 500 FCFA/);
  assert.match(output, /Mensualité : 2026-10/);
  assert.match(output, /Responsable de l’élève : Parent Camille/);
  assert.match(output, /Encaissé par : caissière-école/);
  assert.match(output, /642111d7-b523-48dd-8332-9dcb3e037014/);
  assert.doesNotMatch(output, /internal-pupil-id|internal-user-id|secret-operation-key|TRANSACTION DE TEST|KKiaPay/);
  const legacy = extract(await createPaymentReceipt({ student, payment: { id: "old-receipt", amount: 1000, period: "2026-10", date: "2026-10-13" } }));
  assert.match(legacy, /En présentiel — saisie administrative/);
  assert.match(legacy, /Non renseigné \(ancien enregistrement\)/);
});

test("Les bilans longs sont paginés et les dossiers avec références manquantes restent exportables", async () => {
  const student = { id: "pupil", name: "Élève très long ".repeat(12) + "\u0000", class: "6e" };
  const grades = Array.from({ length: 150 }, (_, i) => ({ student: "pupil", course: "missing", score: i % 21, label: `Évaluation ${i} — vérification de pagination` }));
  const buffer = await createStudentReport({ student, grades, attendance: [{ student: "pupil", course: "missing", status: "Excusé" }], payments: [{ student: "pupil", amount: 2000, period: "2026-10" }] });
  assertPdf(buffer);
  const pages = buffer.toString("latin1").match(/\/Type \/Page\b/g) || [];
  assert.ok(pages.length >= 4, "Toutes les évaluations doivent pouvoir occuper plusieurs pages.");
  if (canExtract) {
    const output = extract(buffer);
    assert.match(output, /Évaluation 149/);
    assert.match(output, /Cours introuvable/);
    assert.match(output, /Taux de présence : non disponible/);
  }
  assertPdf(await createPaymentReceipt({ payment: { amount: 1500, period: "2026-10" } }));
});
