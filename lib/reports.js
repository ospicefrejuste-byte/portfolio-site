"use strict";
const PDFDocument = require("pdfkit");
const fs = require("node:fs");
const path = require("node:path");
const clean = value => String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
const number = value => Number(value || 0).toLocaleString("fr-FR", { maximumFractionDigits: 3 });
const money = value => (typeof value === "bigint" ? value : BigInt(Math.round(Number(value || 0)))).toLocaleString("fr-FR") + " F CFA";
const estimatedValue = item => Number.isSafeInteger(item.estimatedValue)
  ? BigInt(item.estimatedValue)
  : (BigInt(Math.round(Number(item.quantity || 0) * 1000)) * BigInt(Number(item.unitValue || 0)) + 500n) / 1000n;
function inventoryPdf({ items = [], settings = {}, generatedAt = new Date().toISOString() } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40, bufferPages: true, info: { Title: "Inventaire — " + clean(settings.name || "Ferme ADEOYE"), Author: "Ferme ADEOYE" } });
    const parts = [];
    doc.on("data", part => parts.push(part)); doc.on("end", () => resolve(Buffer.concat(parts))); doc.on("error", reject);
    try {
      const font = [path.join(process.cwd(), "lib", "assets", "DejaVuSans.ttf"), path.join(__dirname, "assets", "DejaVuSans.ttf")].find(filename => fs.existsSync(filename));
      if (!font) throw new Error("La police Unicode du rapport est indisponible.");
      doc.registerFont("Farm", font).font("Farm");
      const active = items.filter(item => item.active !== false).sort((a, b) => String(a.category).localeCompare(String(b.category), "fr") || String(a.name).localeCompare(String(b.name), "fr"));
      const width = doc.page.width - 80, columns = [.28, .19, .18, .19, .16].map(fraction => width * fraction);
      const headers = ["Désignation", "Catégorie", "Stock / seuil", "Emplacement", "Valeur estimée"];
      let timezone = settings.timezone || "Africa/Porto-Novo";
      try { new Intl.DateTimeFormat("fr-FR", { timeZone: timezone }).format(); } catch { timezone = "UTC"; }
      const date = new Date(generatedAt).toLocaleString("fr-FR", { timeZone: timezone });
      function line(value, size = 10, color = "#164734", gap = 6) {
        doc.fontSize(size).fillColor(color).text(clean(value), 40, doc.y, { width }); doc.y += gap;
      }
      function row(cells, header = false) {
        doc.fontSize(header ? 8 : 8.5);
        const height = Math.max(header ? 36 : 40, ...cells.map((value, i) => doc.heightOfString(clean(value) || "—", { width: columns[i] - 12 }) + 16));
        const top = doc.y;
        if (header) doc.rect(40, top, width, height).fill("#164734");
        else doc.rect(40, top, width, height).fill("#f5f6ef");
        let left = 40;
        cells.forEach((value, i) => { doc.fillColor(header ? "#ffffff" : "#263e30").text(clean(value) || "—", left + 6, top + 8, { width: columns[i] - 12 }); left += columns[i]; });
        doc.y = top + height + 2;
      }
      function heading() {
        line(settings.name || "Ferme ADEOYE", 21, "#164734", 10);
        line("Inventaire de la ferme", 14, "#164734", 7);
        line("Situation au " + date + " · " + timezone, 8, "#687667");
        if (settings.location) line(settings.location, 8, "#687667");
        line(active.length + " référence(s) active(s) · Les unités différentes ne sont pas additionnées.", 8, "#687667", 12);
        row(headers, true);
      }
      heading();
      if (!active.length) { doc.y += 20; line("Aucun élément enregistré dans l’inventaire.", 11); }
      let total = 0n;
      for (const item of active) {
        const estimated = estimatedValue(item); total += estimated;
        const cells = [item.name, item.category, number(item.quantity) + " " + item.unit + "\nSeuil : " + number(item.minQuantity), item.location, item.unitValue ? money(estimated) : "Non renseignée"];
        doc.fontSize(8.5);
        const height = Math.max(40, ...cells.map((value, i) => doc.heightOfString(clean(value) || "—", { width: columns[i] - 12 }) + 16));
        if (doc.y + height > doc.page.height - 72) { doc.addPage(); heading(); }
        row(cells);
      }
      if (doc.y + 80 > doc.page.height - 65) doc.addPage();
      doc.y += 16;
      line("Valeur estimée des références valorisées : " + money(total), 11);
      line("Estimation fondée sur les valeurs unitaires renseignées. Ce montant n’est ni une recette, ni un bénéfice. Les éléments sans valeur unitaire ne sont pas valorisés.", 8, "#687667", 0);
      const pages = doc.bufferedPageRange();
      for (let page = pages.start; page < pages.start + pages.count; page++) {
        doc.switchToPage(page); const bottom = doc.page.margins.bottom; doc.page.margins.bottom = 0;
        doc.fontSize(7).fillColor("#687667").text(`Document interne · ${clean(settings.name || "Ferme ADEOYE")} · ${page + 1} / ${pages.count}`, 40, doc.page.height - 28, { width, align: "center", lineBreak: false });
        doc.page.margins.bottom = bottom;
      }
      doc.end();
    } catch (error) { doc.destroy(); reject(error); }
  });
}
// Financial reports use integer CFA amounts throughout; inventory valuations are
// deliberately not involved. Each recorded local date/time keeps its original
// farm timezone, including after a later settings change.
function expensesPdf({ expenses = [], from = "", to = "", settings = {}, generatedAt = new Date().toISOString() } = {}) {
  return new Promise((resolve, reject) => {
    const farmName = clean(settings.name || "Ferme ADEOYE");
    const doc = new PDFDocument({ size: "A4", margin: 40, bufferPages: true, info: { Title: "Dépenses et achats — " + farmName, Author: farmName } });
    const parts = [];
    doc.on("data", part => parts.push(part)); doc.on("end", () => resolve(Buffer.concat(parts))); doc.on("error", reject);
    try {
      const font = [path.join(process.cwd(), "lib", "assets", "DejaVuSans.ttf"), path.join(__dirname, "assets", "DejaVuSans.ttf")].find(filename => fs.existsSync(filename));
      if (!font) throw new Error("La police Unicode du rapport est indisponible.");
      doc.registerFont("Farm", font).font("Farm");
      const rows = [...expenses].sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.time).localeCompare(String(a.time)) || String(b.createdAt).localeCompare(String(a.createdAt)) || String(b.id).localeCompare(String(a.id)));
      let timezone = settings.timezone || "Africa/Porto-Novo";
      try { new Intl.DateTimeFormat("fr-FR", { timeZone: timezone }).format(); } catch { timezone = "UTC"; }
      const width = doc.page.width - 80, bottom = doc.page.height - 64;
      const dateLabel = value => /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value.slice(8, 10) + "/" + value.slice(5, 7) + "/" + value.slice(0, 4) : clean(value);
      const period = from && to ? "Du " + dateLabel(from) + " au " + dateLabel(to) + " inclus" : from ? "À partir du " + dateLabel(from) + " inclus" : to ? "Jusqu’au " + dateLabel(to) + " inclus" : "Toutes les dépenses enregistrées";
      const generated = new Date(generatedAt).toLocaleString("fr-FR", { timeZone: timezone });
      function line(text, size = 9, color = "#687667", gap = 5) {
        doc.fontSize(size).fillColor(color).text(clean(text), 40, doc.y, { width }); doc.y += gap;
      }
      function heading() {
        doc.y = 40;
        line(farmName, 20, "#164734", 7);
        line("Dépenses et achats", 14, "#164734", 7);
        line(period, 10, "#263e30");
        line("Édité le " + generated + " · " + timezone, 8);
        if (settings.location) line(settings.location, 8);
        line("Dates d’achat inclusives · Heures locales et fuseaux conservés à la saisie.", 7.5, "#687667", 10);
        const top = doc.y;
        doc.rect(40, top, width, 26).fill("#164734");
        doc.fontSize(8).fillColor("#ffffff");
        doc.text("DATE ET HEURE", 48, top + 8, { width: 113 });
        doc.text("ACHAT / DÉPENSE", 172, top + 8, { width: width - 250 });
        doc.text("MONTANT", doc.page.width - 155, top + 8, { width: 105, align: "right" });
        doc.y = top + 34;
      }
      const freshPage = () => { doc.addPage(); heading(); };
      function noteLines(text) {
        doc.fontSize(8);
        const lines = []; let current = "";
        for (let word of clean(text).split(" ")) {
          const candidate = current ? current + " " + word : word;
          if (doc.widthOfString(candidate) <= width - 20) { current = candidate; continue; }
          if (current) { lines.push(current); current = ""; }
          while (doc.widthOfString(word) > width - 20) {
            const characters = Array.from(word); let low = 1, high = characters.length;
            while (low < high) { const middle = Math.ceil((low + high) / 2); if (doc.widthOfString(characters.slice(0, middle).join("")) <= width - 20) low = middle; else high = middle - 1; }
            lines.push(characters.slice(0, low).join("")); word = characters.slice(low).join("");
          }
          current = word;
        }
        if (current) lines.push(current);
        return lines;
      }
      heading();
      let total = 0n;
      if (!rows.length) {
        doc.y += 12;
        line("Aucune dépense enregistrée pour cette période.", 11, "#263e30", 14);
      }
      for (const expense of rows) {
        if (!Number.isSafeInteger(expense.amount) || expense.amount < 0) throw new Error("Le montant d’une dépense est invalide.");
        total += BigInt(expense.amount);
        const dateText = dateLabel(expense.date) + "\n" + clean(expense.time) + "\n" + clean(expense.timezone || timezone);
        const description = clean(expense.description) + "\n" + clean(expense.category) + (expense.supplier ? "\nFournisseur : " + clean(expense.supplier) : "");
        const amount = money(BigInt(expense.amount));
        const reference = "Référence : " + clean(expense.reference || expense.id) + " · Saisi par : " + clean(expense.createdBy || "—");
        const note = expense.notes ? "Note : " + clean(expense.notes) : "";
        doc.fontSize(8.5);
        const detailsWidth = width - 258;
        const mainHeight = Math.max(doc.heightOfString(dateText, { width: 116 }), doc.heightOfString(description, { width: detailsWidth }), doc.heightOfString(amount, { width: 116 }));
        doc.fontSize(7);
        const referenceHeight = doc.heightOfString(reference, { width: width - 20 });
        const height = 24 + mainHeight + referenceHeight;
        if (doc.y + height > bottom) freshPage();
        if (doc.y + height > bottom) throw new Error("Une dépense est trop longue pour le rapport PDF.");
        const top = doc.y;
        doc.rect(40, top, width, height).fill("#f5f6ef");
        doc.fontSize(8.5).fillColor("#263e30");
        doc.text(dateText, 48, top + 8, { width: 116 });
        doc.text(description, 172, top + 8, { width: detailsWidth });
        doc.text(amount, doc.page.width - 164, top + 8, { width: 116, align: "right" });
        doc.fontSize(7).fillColor("#687667").text(reference, 50, top + mainHeight + 15, { width: width - 20 });
        doc.y = top + height;
        // Long notes may continue on a new page, without losing text or
        // forcing a whole purchase into a clipped fixed-height table row.
        if (note) {
          const lines = noteLines(note), lineHeight = doc.currentLineHeight(true);
          let index = 0;
          while (index < lines.length) {
            let available = Math.floor((bottom - doc.y - 12) / lineHeight);
            if (available < 1) {
              freshPage();
              line("Suite de la dépense · Référence : " + clean(expense.reference || expense.id), 7, "#687667", 5);
              available = Math.floor((bottom - doc.y - 12) / lineHeight);
            }
            const count = Math.min(available, lines.length - index), start = doc.y;
            doc.rect(40, start, width, count * lineHeight + 12).fill("#f5f6ef");
            doc.fontSize(8).fillColor("#263e30");
            for (let n = 0; n < count; n++) doc.text(lines[index + n], 50, start + 6 + n * lineHeight, { lineBreak: false });
            index += count; doc.y = start + count * lineHeight + 12;
          }
        }
        doc.y += 7;
      }
      if (doc.y + 85 > bottom) freshPage();
      doc.y += 10;
      line(rows.length + " dépense(s) enregistrée(s)", 9, "#687667");
      line("Total des dépenses : " + money(total), 14, "#164734", 7);
      line("Ce total porte uniquement sur les achats et dépenses enregistrés pour la période sélectionnée.", 8);
      const pages = doc.bufferedPageRange();
      for (let page = pages.start; page < pages.start + pages.count; page++) {
        doc.switchToPage(page); const marginBottom = doc.page.margins.bottom; doc.page.margins.bottom = 0;
        const footer = `Document interne · ${farmName} · ${page + 1} / ${pages.count}`;
        doc.fontSize(7); const footerSize = Math.min(7, 7 * width / doc.widthOfString(footer));
        doc.fontSize(footerSize).fillColor("#687667").text(footer, 40, doc.page.height - 28, { width, align: "center", lineBreak: false });
        doc.page.margins.bottom = marginBottom;
      }
      doc.end();
    } catch (error) { doc.destroy(); reject(error); }
  });
}
module.exports = { inventoryPdf, expensesPdf };
