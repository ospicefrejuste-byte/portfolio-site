"use strict";

const fs = require("node:fs");
const path = require("node:path");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");
const { paymentAllocations } = require("./payment-months");

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
function paymentPeriods(payment) {
  return paymentAllocations(payment).map((allocation) => allocation.period).join(", ") || payment.period;
}
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
function footer(doc, notice = "Document réservé à l’établissement et au responsable de l’élève") {
  const range = doc.bufferedPageRange();
  for (let page = range.start; page < range.start + range.count; page++) {
    doc.switchToPage(page);
    const bottom = doc.page.margins.bottom;
    // The footer sits below the content margin; PDFKit must not move it onto a new page.
    doc.page.margins.bottom = 0;
    try {
      doc.fontSize(8).fillColor(MUTED).text(
        `${notice} · Page ${page - range.start + 1} / ${range.count}`,
        MARGIN, doc.page.height - 30, { width: doc.page.width - MARGIN * 2, align: "center", lineBreak: false },
      );
    } finally { doc.page.margins.bottom = bottom; }
  }
}
function pdf(title, generate, footerNotice) {
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
      footer(doc, footerNotice);
      doc.end();
    } catch (error) {
      doc.destroy();
      reject(error);
    }
  });
}

function createClassList({ students = [], school = {}, className, centre } = {}) {
  const roster = students.filter((student) => student.class === className && student.centre === centre)
    .slice().sort((a, b) => String(a.name).localeCompare(String(b.name), "fr-FR", { numeric: true }));
  return pdf("Liste de classe", (doc) => {
    const width = doc.page.width - MARGIN * 2;
    const widths = [.07, .46, .18, .29].map((fraction) => fraction * width);
    const date = new Date().toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric", timeZone: "Africa/Porto-Novo" });
    function row(cells, header = false) {
      doc.fontSize(9);
      const height = header ? 30 : Math.max(42, ...cells.map((cell, index) => doc.heightOfString(cell, { width: widths[index] - 14 }) + 20));
      const top = doc.y;
      if (header) doc.rect(MARGIN, top, width, height).fill(NAVY);
      let left = MARGIN;
      cells.forEach((cell, index) => {
        doc.rect(left, top, widths[index], height).lineWidth(.6).strokeColor("#bac7d5").stroke();
        if (cell) doc.fillColor(header ? "#ffffff" : NAVY).text(cell, left + 7, top + (header ? 8 : 10), { width: widths[index] - 14 });
        left += widths[index];
      });
      doc.y = top + height;
      return height;
    }
    function heading() {
      write(doc, text(school.name, "Cours de renforcement scolaire"), { size: 16, gap: 6 });
      write(doc, "Liste de classe", { size: 21, gap: 10 });
      write(doc, `École / centre : ${text(centre)}`, { size: 10, gap: 5 });
      write(doc, `Classe : ${text(className)} · Établie le ${date}`, { size: 10, gap: 7 });
      write(doc, `Effectif : ${roster.length} élève(s)`, { size: 9, color: MUTED, gap: 12 });
      row(["N°", "Nom et prénoms", "Classe", "Signature"], true);
    }
    heading();
    if (!roster.length) {
      doc.y += 14;
      write(doc, "Aucun élève enregistré dans cette école et cette classe.", { color: MUTED });
      return;
    }
    roster.forEach((student, index) => {
      const cells = [String(index + 1), text(student.name), text(student.class), ""];
      doc.fontSize(9);
      const height = Math.max(42, ...cells.map((cell, column) => doc.heightOfString(cell, { width: widths[column] - 14 }) + 20));
      if (doc.y + height > doc.page.height - MARGIN - 12) {
        doc.addPage();
        heading();
      }
      row(cells);
    });
  }, "Liste réservée à l’établissement");
}

function createStudentReport({ student = {}, courses = [], grades = [], attendance = [], dailyAttendance = [], payments = [], school = {}, from, to } = {}) {
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
    section(doc, "Présences par cours");
    write(doc, `Taux de présence : ${counted ? `${Math.round((counts.Présent + counts.Retard) / counted * 100)} %` : "non disponible"}`);
    write(doc, `Présents : ${counts.Présent} · Retards : ${counts.Retard} · Absents : ${counts.Absent} · Excusés : ${counts.Excusé}`);
    write(doc, "Les retards comptent comme présence. Les absences excusées sont exclues du taux.", { size: 9, color: MUTED });
    table(doc, ["Date", "Matière", "Statut"], pupilAttendance.map((entry) => {
      const course = courseMap.get(entry.course);
      return [displayDate(course?.date), text(course?.subject, "Cours introuvable"), entry.status];
    }), [.2, .5, .3]);
    const pupilDailyAttendance = dailyAttendance.filter((entry) => entry.student === student.id && ["Présent", "Absent"].includes(entry.status) && inRange(entry.date, from, to))
      .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    const presentDays = pupilDailyAttendance.filter((entry) => entry.status === "Présent").length;
    const absentDays = pupilDailyAttendance.filter((entry) => entry.status === "Absent").length;
    section(doc, "Présences du jour");
    write(doc, `Taux de présence par jour : ${pupilDailyAttendance.length ? `${Math.round(presentDays / pupilDailyAttendance.length * 100)} %` : "non disponible"}`);
    write(doc, `Jours présents : ${presentDays} · Jours absents : ${absentDays}`);
    write(doc, "Le pointage quotidien compte les jours renseignés comme présent ou absent.", { size: 9, color: MUTED });
    table(doc, ["Date", "Classe", "École / centre", "Statut"], pupilDailyAttendance.map((entry) => [
      displayDate(entry.date), entry.class || student.class, entry.centre || student.centre, entry.status,
    ]), [.19, .2, .38, .23]);
    const pupilPayments = payments.filter((payment) => payment.student === student.id && inRange(payment.date, from, to))
      .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    const realPayments = pupilPayments.filter((payment) => payment.mode !== "sandbox");
    section(doc, "Règlements réels");
    write(doc, `Total des règlements réels : ${money(realPayments.reduce((sum, payment) => sum + amount(payment.amount), 0))}`);
    const multipleMonths = pupilPayments.some((payment) => paymentAllocations(payment).length > 1);
    write(doc, multipleMonths ? "Le filtre de dates porte sur la date d’encaissement. Les mois indiqués sont les mensualités concernées." : "Le filtre de dates porte sur la date d’encaissement. Le mois indiqué est la mensualité concernée.", { size: 9, color: MUTED });
    table(doc, ["Date", multipleMonths ? "Mensualités" : "Mensualité", "Montant", "Mode"], realPayments.map((payment) => [displayDate(payment.date), paymentPeriods(payment), money(payment.amount), payment.source === "KKiaPay" ? "En ligne — KKiaPay confirmé" : "En présentiel"]), [.2, .2, .27, .33]);
    const tests = pupilPayments.filter((payment) => payment.mode === "sandbox");
    if (tests.length) {
      section(doc, "Transactions de test — hors règlements");
      write(doc, "Ces transactions ne constituent aucun paiement réel et sont exclues du total.", { size: 9, color: MUTED });
      table(doc, ["Date", multipleMonths ? "Mensualités" : "Mensualité", "Montant de test"], tests.map((payment) => [displayDate(payment.date), paymentPeriods(payment), money(payment.amount)]), [.3, .3, .4]);
    }
  });
}

function receiptVerificationUrl(value) {
  if (typeof value !== "string" || value.length > 2048 || value.trim() !== value) throw new Error("Le lien de vérification du reçu est invalide.");
  let url;
  try { url = new URL(value); } catch { throw new Error("Le lien de vérification du reçu est invalide."); }
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !local) || url.username || url.password || url.pathname !== "/verification-recu.html" || !url.hash || url.search)
    throw new Error("Le lien de vérification du reçu est invalide.");
  return url.href;
}
function receiptVerificationBlock(doc, verification) {
  const imageSize = 116, textX = MARGIN + imageSize + 18;
  const textWidth = doc.page.width - MARGIN - textX;
  const lines = [
    { value: "Scanner pour vérifier", size: 13, color: BLUE, gap: 9 },
    { value: `Site de vérification : ${new URL(verification.url).host}`, size: 9, color: NAVY, gap: 10 },
    { value: "Ouvrir la vérification du reçu", size: 10, color: BLUE, gap: 10, link: verification.url },
    { value: "Le montant et la référence du règlement peuvent être consultés sur ce site.", size: 9, color: MUTED, gap: 0 },
  ];
  const textHeight = lines.reduce((sum, line) => sum + doc.fontSize(line.size).heightOfString(line.value, { width: textWidth }) + line.gap, 0);
  const height = Math.max(imageSize, textHeight);
  ensureRoom(doc, height + 24);
  const startY = doc.y + 8;
  doc.image(verification.image, MARGIN, startY, { width: imageSize, height: imageSize });
  let y = startY;
  for (const line of lines) {
    doc.fontSize(line.size).fillColor(line.color);
    doc.text(line.value, textX, y, { width: textWidth, link: line.link, underline: Boolean(line.link) });
    y = doc.y + line.gap;
  }
  doc.y = startY + height + 16;
}
async function createPaymentReceipt({ payment = {}, student = {}, school = {}, verification } = {}) {
  let code;
  if (verification !== undefined && verification !== null) {
    const url = receiptVerificationUrl(verification.url);
    const image = await QRCode.toBuffer(url, { type: "png", errorCorrectionLevel: "Q", margin: 4, width: 600, color: { dark: "#000000ff", light: "#ffffffff" } });
    code = { url, image };
  }
  return pdf(payment.mode === "sandbox" ? "Transaction de test" : "Reçu de paiement", (doc) => {
    titleSchool(doc, school);
    const sandbox = payment.mode === "sandbox";
    const allocations = paymentAllocations(payment);
    const multipleMonths = allocations.length > 1;
    write(doc, sandbox ? "Confirmation de test" : "Reçu de paiement", { size: 21, gap: 14 });
    if (sandbox) write(doc, "TRANSACTION DE TEST — AUCUN RÈGLEMENT RÉEL", { size: 12, color: "#995100", gap: 14 });
    details(doc, [["Élève", text(student.name, "Élève introuvable")], ["Classe", student.class], ["Centre", student.centre], ["Groupe", student.group], ["Responsable de l’élève", student.guardian], [multipleMonths ? "Mensualités" : "Mensualité", paymentPeriods(payment)], ["Date d’encaissement", displayDate(payment.date)]]);
    if (multipleMonths) {
      section(doc, "Détail des mensualités");
      table(doc, ["Mensualité", sandbox ? "Montant de test" : "Montant réglé"], allocations.map((allocation) => [allocation.period, money(allocation.amount)]), [.5, .5]);
    }
    const amountTitle = sandbox
      ? multipleMonths ? "Montant total de la transaction de test" : "Montant de la transaction de test"
      : multipleMonths ? "Montant total reçu" : "Montant reçu";
    section(doc, amountTitle);
    write(doc, money(payment.amount), { size: 23, color: BLUE, gap: 15 });
    const online = payment.source === "KKiaPay";
    const cash = payment.channel === "cash" || payment.source === "Caisse";
    details(doc, [["Mode", online ? "En ligne — KKiaPay — transaction confirmée" : cash ? "En présentiel — espèces" : "En présentiel — saisie administrative"], ["Référence du reçu", payment.id]]);
    if (online && payment.transactionId) details(doc, [["Référence de transaction", payment.transactionId]]);
    if (!online) details(doc, [["Encaissé par", text(payment.collectedByName, "Non renseigné (ancien enregistrement)")]]);
    write(doc, sandbox ? "Ce document concerne uniquement un essai. Aucun encaissement réel n’est attesté." : `Ce reçu correspond au règlement enregistré par l’établissement pour ${multipleMonths ? "les mensualités indiquées" : "la mensualité indiquée"}. Il ne constitue pas un bulletin scolaire.`, { color: MUTED, gap: 10 });
    if (code) receiptVerificationBlock(doc, code);
  });
}

module.exports = { createStudentReport, createPaymentReceipt, createClassList };
