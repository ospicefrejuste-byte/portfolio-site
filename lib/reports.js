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
module.exports = { inventoryPdf };
