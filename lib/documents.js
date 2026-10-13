"use strict";

const fs = require("node:fs");
const path = require("node:path");
const PDFDocument = require("pdfkit");

const NAVY = "#14345b", BLUE = "#2159b4", MUTED = "#596879";
const MARGIN = 48;
function text(value, fallback = "—") {
  const clean = String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 1200);
  return clean || fallback;
}
function amount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(parsed, 0) : 0;
}
function money(value) { return `${amount(value).toLocaleString("fr-FR")} FCFA`; }
function displayDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  return match ? `${match[3]}/${match[2]}/${match[1]}` : text(value);
}
function inRange(value, from, to) {
  if (!from && !to) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  return (!from || value >= from) && (!to || value <= to);
}
function titleSchool(doc, school = {}) {
  write(doc, text(school.name, "Cours de renforcement scolaire"), { size: 18, color: NAVY, gap: 6 });
  const phones = Array.isArray(school.phones) ? school.phones.map((p) => text(p, "")).filter(Boolean).join(" · ") : text(school.phones, "");
  if (phones) write(doc, `Contact : ${phones}`, { size: 9, color: MUTED, gap: 8 });
  doc.moveTo(MARGIN, doc.y).lineTo(doc.page.width - MARGIN, doc.y).strokeColor("#dce4ec").stroke();
  doc.y += 18;
}
function ensureRoom(doc, height) {
  if (doc.y + height > doc.page.height - MARGIN - 12) doc.addPage();
}
function write(doc, value, { size = 10, color = NAVY, gap = 7 } = {}) {
  const content = text(value), width = doc.page.width - MARGIN * 2;
  doc.fontSize(size);
  const height = doc.heightOfString(content, { width });
  ensureRoom(doc, height + gap);
  doc.fillColor(color).text(content, MARGIN, doc.y, { width });
  doc.y += gap;
}
function section(doc, title) {
  ensureRoom(doc, 62);
  doc.y += 8;
  write(doc, title, { size: 13, color: BLUE, gap: 10 });
}
function details(doc, entries) {
  for (const [label, value] of entries) write(doc, `${label} : ${text(value)}`);
}
function table(doc, headers, rows, fractions) {
  if (!rows.length) { write(doc, "Aucune donnée enregistrée pour cette période.", { color: MUTED }); return; }
  const width = doc.page.width - MARGIN * 2;
  const widths = fractions.map((f) => f * width);
  const cellText = (value) => {
    const content = text(value);
    return content.length > 240 ? content.slice(0, 237) + "…" : content;
  };
  function height(cells) {
    doc.fontSize(9);
    return Math.max(24, ...cells.map((cell, i) => doc.heightOfString(cellText(cell), { width: widths[i] - 12 }) + 14));
  }
  function row(cells, header = false) {
    const rowHeight = height(cells), startY = doc.y;
    doc.rect(MARGIN, startY, width, rowHeight).fill(header ? NAVY : "#f2f5f9");
    let x = MARGIN;
    cells.forEach((cell, i) => {
      doc.fontSize(9).fillColor(header ? "#ffffff" : NAVY)
        .text(cellText(cell), x + 6, startY + 6, { width: widths[i] - 12 });
      x += widths[i];
    });
    doc.y = startY + rowHeight + 2;
  }
  ensureRoom(doc, height(headers) + height(rows[0]) + 4);
  row(headers, true);
  for (const cells of rows) {
    if (doc.y + height(cells) > doc.page.height - MARGIN - 12) {
      doc.addPage();
      row(headers, true);
    }
    row(cells);
  }
  doc.y += 8;
}
function footer(doc) {
  const range = doc.bufferedPageRange();
  for (let page = range.start; page < range.start + range.count; page++) {
    doc.switchToPage(page);
    doc.fontSize(8).fillColor(MUTED).text(
      `Document réservé à l’établissement et au responsable de l’élève · Page ${page - range.start + 1} / ${range.count}`,
      MARGIN, doc.page.height - 30, { width: doc.page.width - MARGIN * 2, align: "center", lineBreak: false },
    );
  }
}
function pdf(title, generate) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: MARGIN, bufferPages: true, info: { Title: title, Author: "Gestion scolaire" } });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      const candidates = [path.join(process.cwd(), "lib", "assets", "DejaVuSans.ttf"), path.join(__dirname, "assets", "DejaVuSans.ttf")];
      const font = candidates.find((filename) => fs.existsSync(filename));
      if (!font) throw new Error("La police Unicode du document est indisponible.");
      doc.registerFont("School", font).font("School");
      generate(doc);
      footer(doc);
      doc.end();
    } catch (error) {
      doc.destroy();
      reject(error);
    }
  });
}

function createStudentReport({ student = {}, courses = [], grades = [], attendance = [], payments = [], school = {}, from, to } = {}) {
  return pdf("Bilan scolaire", (doc) => {
    titleSchool(doc, school);
    write(doc, "Bilan de l’élève", { size: 20, color: NAVY, gap: 12 });
    details(doc, [
      ["Élève", student.name], ["Classe", student.class], ["Centre", student.centre], ["Groupe", student.group],
      ["Responsable", student.guardian], ["Téléphone", student.phone],
      ["Période", from || to ? `${from ? displayDate(from) : "Début des dossiers"} au ${to ? displayDate(to) : "Derniers dossiers"}` : "Toutes les dates"],
    ]);
    const courseMap = new Map(courses.map((course) => [course.id, course]));
    const pupilGrades = grades.filter((grade) => grade.student === student.id && grade.score !== null && grade.score !== "" && Number.isFinite(Number(grade.score)) && Number(grade.score) >= 0 && Number(grade.score) <= 20 && inRange(courseMap.get(grade.course)?.date, from, to))
      .sort((a, b) => String(courseMap.get(a.course)?.date || "").localeCompare(String(courseMap.get(b.course)?.date || "")));
    section(doc, "Notes et résultats");
    const average = pupilGrades.length ? (pupilGrades.reduce((sum, grade) => sum + Number(grade.score), 0) / pupilGrades.length).toFixed(1) : null;
    write(doc, average ? `Moyenne générale : ${average.replace(".", ",")} / 20` : "Moyenne générale : non disponible");
    const subjects = new Map();
    for (const grade of pupilGrades) {
      const subject = text(courseMap.get(grade.course)?.subject, "Cours introuvable");
      const values = subjects.get(subject) || [];
      values.push(Number(grade.score));
      subjects.set(subject, values);
    }
    if (subjects.size) table(doc, ["Matière", "Moyenne / 20", "Évaluations"], [...subjects].map(([subject, scores]) => [subject, (scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(1).replace(".", ","), scores.length]), [.58, .24, .18]);
    write(doc, "Les moyennes sont calculées sans coefficient, à partir des notes saisies.", { size: 9, color: MUTED });
    table(doc, ["Date", "Matière", "Évaluation", "Note / 20"], pupilGrades.map((grade) => {
      const course = courseMap.get(grade.course);
      return [displayDate(course?.date), text(course?.subject, "Cours introuvable"), grade.label, Number(grade.score).toLocaleString("fr-FR")];
    }), [.16, .29, .39, .16]);
    const pupilAttendance = attendance.filter((entry) => entry.student === student.id && ["Présent", "Retard", "Absent", "Excusé"].includes(entry.status) && inRange(courseMap.get(entry.course)?.date, from, to))
      .sort((a, b) => String(courseMap.get(a.course)?.date || "").localeCompare(String(courseMap.get(b.course)?.date || "")));
    const counts = Object.fromEntries(["Présent", "Retard", "Absent", "Excusé"].map((status) => [status, pupilAttendance.filter((entry) => entry.status === status).length]));
    const counted = counts.Présent + counts.Retard + counts.Absent;
    section(doc, "Présences");
    write(doc, `Taux de présence : ${counted ? `${Math.round((counts.Présent + counts.Retard) / counted * 100)} %` : "non disponible"}`);
    write(doc, `Présents : ${counts.Présent} · Retards : ${counts.Retard} · Absents : ${counts.Absent} · Excusés : ${counts.Excusé}`);
    write(doc, "Les retards comptent comme présence. Les absences excusées sont exclues du taux.", { size: 9, color: MUTED });
    table(doc, ["Date", "Matière", "Statut"], pupilAttendance.map((entry) => {
      const course = courseMap.get(entry.course);
      return [displayDate(course?.date), text(course?.subject, "Cours introuvable"), entry.status];
    }), [.2, .5, .3]);
    const pupilPayments = payments.filter((payment) => payment.student === student.id && inRange(payment.date, from, to))
      .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    const realPayments = pupilPayments.filter((payment) => payment.mode !== "sandbox");
    section(doc, "Règlements réels");
    write(doc, `Total des règlements réels : ${money(realPayments.reduce((sum, payment) => sum + amount(payment.amount), 0))}`);
    write(doc, "Le filtre de dates porte sur la date d’encaissement. Le mois indiqué est la mensualité concernée.", { size: 9, color: MUTED });
    table(doc, ["Date", "Mensualité", "Montant", "Mode"], realPayments.map((payment) => [displayDate(payment.date), payment.period, money(payment.amount), payment.source === "KKiaPay" ? "En ligne — KKiaPay confirmé" : "En présentiel"]), [.2, .2, .27, .33]);
    const tests = pupilPayments.filter((payment) => payment.mode === "sandbox");
    if (tests.length) {
      section(doc, "Transactions de test — hors règlements");
      write(doc, "Ces transactions ne constituent aucun paiement réel et sont exclues du total.", { size: 9, color: MUTED });
      table(doc, ["Date", "Mensualité", "Montant de test"], tests.map((payment) => [displayDate(payment.date), payment.period, money(payment.amount)]), [.3, .3, .4]);
    }
  });
}

function createPaymentReceipt({ payment = {}, student = {}, school = {} } = {}) {
  return pdf(payment.mode === "sandbox" ? "Transaction de test" : "Reçu de paiement", (doc) => {
    titleSchool(doc, school);
    const sandbox = payment.mode === "sandbox";
    write(doc, sandbox ? "Confirmation de test" : "Reçu de paiement", { size: 21, gap: 14 });
    if (sandbox) write(doc, "TRANSACTION DE TEST — AUCUN RÈGLEMENT RÉEL", { size: 12, color: "#995100", gap: 14 });
    details(doc, [["Élève", text(student.name, "Élève introuvable")], ["Classe", student.class], ["Centre", student.centre], ["Groupe", student.group], ["Responsable de l’élève", student.guardian], ["Mensualité", payment.period], ["Date d’encaissement", displayDate(payment.date)]]);
    section(doc, sandbox ? "Montant de la transaction de test" : "Montant reçu");
    write(doc, money(payment.amount), { size: 23, color: BLUE, gap: 15 });
    const online = payment.source === "KKiaPay";
    const cash = payment.channel === "cash" || payment.source === "Caisse";
    details(doc, [["Mode", online ? "En ligne — KKiaPay — transaction confirmée" : cash ? "En présentiel — espèces" : "En présentiel — saisie administrative"], ["Référence du reçu", payment.id]]);
    if (online && payment.transactionId) details(doc, [["Référence de transaction", payment.transactionId]]);
    if (!online) details(doc, [["Encaissé par", text(payment.collectedByName, "Non renseigné (ancien enregistrement)")]]);
    write(doc, sandbox ? "Ce document concerne uniquement un essai. Aucun encaissement réel n’est attesté." : "Ce reçu correspond au règlement enregistré par l’établissement pour la mensualité indiquée. Il ne constitue pas un bulletin scolaire.", { color: MUTED, gap: 10 });
  });
}

module.exports = { createStudentReport, createPaymentReceipt };
