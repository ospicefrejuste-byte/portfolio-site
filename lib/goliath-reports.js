"use strict";

const PDFDocument = require("pdfkit");
const fs = require("node:fs");
const path = require("node:path");

const clean = value => String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
const formatNumber = value => (typeof value === "bigint" ? value : Number(value || 0)).toLocaleString("fr-FR");
const money = value => formatNumber(value) + " F CFA";
const dateLabel = value => /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value.slice(8, 10) + "/" + value.slice(5, 7) + "/" + value.slice(0, 4) : clean(value);
const stages = { chicks: "Poussins", growing: "Croissance", adult: "Adultes" };

function sales(events) {
  let total = 0n, unpriced = 0;
  for (const event of events) {
    if (event.type !== "sale") continue;
    if (event.totalAmount === null || event.totalAmount === undefined) { unpriced++; continue; }
    if (!Number.isSafeInteger(event.totalAmount) || event.totalAmount <= 0) throw new Error("Le montant d’une vente Goliath est invalide.");
    total += BigInt(event.totalAmount);
  }
  return { total, unpriced };
}

function goliathPdf({ batches = [], events = [], settings = {}, generatedAt = new Date().toISOString(), logo = null } = {}) {
  return new Promise((resolve, reject) => {
    const farmName = clean(settings.name || "Ferme ADEOYE");
    const doc = new PDFDocument({ size: "A4", margin: 40, bufferPages: true, info: { Title: "Élevage Goliath — " + farmName, Author: farmName } });
    const chunks = [];
    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      if (logo !== null && (!Buffer.isBuffer(logo) || !logo.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))) throw new Error("Le logo du rapport doit être une image PNG validée.");
      const font = [path.join(process.cwd(), "lib", "assets", "DejaVuSans.ttf"), path.join(__dirname, "assets", "DejaVuSans.ttf")].find(filename => fs.existsSync(filename));
      if (!font) throw new Error("La police Unicode du rapport est indisponible.");
      doc.registerFont("Farm", font).font("Farm");
      const width = doc.page.width - 80, bottom = doc.page.height - 56;
      const green = "#164734", ink = "#263e30", muted = "#687667";
      let timezone = settings.timezone || "Africa/Porto-Novo";
      try { new Intl.DateTimeFormat("fr-FR", { timeZone: timezone }).format(); } catch { timezone = "UTC"; }
      const generated = new Date(generatedAt).toLocaleString("fr-FR", { timeZone: timezone });
      const auditDate = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString("fr-FR", { timeZone: timezone }) + " · " + timezone : clean(value);
      const orderedBatches = [...batches].sort((a, b) => String(a.arrivalDate).localeCompare(String(b.arrivalDate)) || String(a.name).localeCompare(String(b.name), "fr") || String(a.id).localeCompare(String(b.id)));
      const ids = new Set(orderedBatches.map(batch => batch.id));
      const selectedEvents = events.filter(event => ids.has(event.batchId));
      let context = "";

      // Explicit line wrapping keeps long names and notes on every page rather
      // than relying on PDFKit's automatic page breaks (which omit headings).
      function wrap(text, size, available) {
        doc.fontSize(size);
        const lines = []; let current = "";
        for (let word of clean(text).split(" ")) {
          const candidate = current ? current + " " + word : word;
          if (doc.widthOfString(candidate) <= available) { current = candidate; continue; }
          if (current) { lines.push(current); current = ""; }
          while (doc.widthOfString(word) > available) {
            const points = Array.from(word); let low = 1, high = points.length;
            while (low < high) {
              const middle = Math.ceil((low + high) / 2);
              if (doc.widthOfString(points.slice(0, middle).join("")) <= available) low = middle;
              else high = middle - 1;
            }
            lines.push(points.slice(0, low).join("")); word = points.slice(low).join("");
          }
          current = word;
        }
        if (current || !lines.length) lines.push(current);
        return lines;
      }
      function raw(text, size, color, gap = 4) {
        const lines = wrap(text, size, width), height = doc.fontSize(size).currentLineHeight(true) + 1;
        for (const line of lines) {
          const top = doc.y;
          doc.fillColor(color).text(line, 40, top, { lineBreak: false }); doc.y = top + height;
        }
        doc.y += gap;
      }
      function heading() {
        doc.y = 36;
        if (logo) { doc.image(logo, 40, doc.y, { fit: [64, 44] }); doc.y = 90; }
        raw(farmName, 16, green, 5);
        raw("Élevage Goliath · Suivi des lots", 13, green, 5);
        raw("Édité le " + generated + " · " + timezone, 7.5, muted, 5);
        if (context) raw(context, 7.5, muted, 5);
        doc.moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).strokeColor("#dce6d0").stroke(); doc.y += 14;
      }
      function freshPage() { doc.addPage(); heading(); }
      function ensure(height) { if (doc.y + height > bottom) freshPage(); }
      function write(text, { size = 8.5, color = ink, background = null, gap = 5, inset = 0 } = {}) {
        const lines = wrap(text, size, width - inset * 2);
        const lineHeight = doc.fontSize(size).currentLineHeight(true) + 2;
        for (const line of lines) {
          ensure(lineHeight);
          const top = doc.y;
          if (background) doc.rect(40, top - 1, width, lineHeight).fill(background);
          doc.fontSize(size).fillColor(color).text(line, 40 + inset, top, { lineBreak: false });
          doc.y = top + lineHeight;
        }
        doc.y += gap;
      }
      function rule() { ensure(10); doc.moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).strokeColor("#e6ebe2").stroke(); doc.y += 10; }
      heading();
      if (settings.location) write(settings.location, { size: 8, color: muted, gap: 9 });
      const total = { initial: 0n, dead: 0n, sold: 0n, remaining: 0n };
      for (const batch of orderedBatches) {
        total.initial += BigInt(batch.initialCount || 0); total.dead += BigInt(batch.deadCount || 0);
        total.sold += BigInt(batch.soldCount || 0); total.remaining += BigInt(batch.remainingCount || 0);
      }
      const receipts = sales(selectedEvents);
      write(orderedBatches.length + " lot(s) suivi(s)", { size: 11, color: green });
      write("Effectif de départ : " + formatNumber(total.initial) + " · Décès : " + formatNumber(total.dead) + " · Vendus : " + formatNumber(total.sold) + " · Restants : " + formatNumber(total.remaining), { size: 9, background: "#eaf0df", inset: 8, gap: 8 });
      write("Recettes de ventes renseignées : " + money(receipts.total), { size: 11, color: green });
      write(receipts.unpriced + " vente(s) sans montant renseigné. Les montants manquants ne sont pas comptés comme des ventes gratuites.", { size: 7.5, color: muted, gap: 12 });
      if (!orderedBatches.length) write("Aucun lot Goliath enregistré.", { size: 10, color: green });

      for (const batch of orderedBatches) {
        const batchEvents = selectedEvents.filter(event => event.batchId === batch.id).sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.time).localeCompare(String(b.time)) || String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
        const batchSales = sales(batchEvents);
        context = "Lot en cours : " + clean(batch.name);
        ensure(150); rule();
        write(batch.name, { size: 13, color: green });
        write("Lot " + clean(batch.reference || batch.id) + " · Arrivée : " + dateLabel(batch.arrivalDate), { size: 8.5, color: muted });
        write("Effectif de départ : " + formatNumber(batch.initialCount) + " · Décès : " + formatNumber(batch.deadCount) + " · Vendus : " + formatNumber(batch.soldCount) + " · Restants : " + formatNumber(batch.remainingCount), { size: 9, background: "#eaf0df", inset: 8, gap: 8 });
        const age = batch.ageDays === null || batch.ageDays === undefined ? "Âge non renseigné" : "Âge : " + formatNumber(batch.ageDays) + " jour(s)";
        write(age + " · " + formatNumber(batch.daysSinceArrival) + " jour(s) depuis l’arrivée · Stade saisi : " + (stages[batch.stage] || clean(batch.stage)), { size: 8.5 });
        write(batch.hatchDate ? "Date d’éclosion : " + dateLabel(batch.hatchDate) : "Date d’éclosion non renseignée.", { size: 8, color: muted });
        if (batch.mortalityRate !== null && batch.mortalityRate !== undefined) write("Mortalité du lot : " + Number(batch.mortalityRate).toLocaleString("fr-FR", { maximumFractionDigits: 2 }) + " % de l’effectif de départ", { size: 8 });
        if (batch.location) write("Emplacement : " + clean(batch.location));
        if (batch.supplier) write("Fournisseur : " + clean(batch.supplier));
        if (batch.notes) write("Observations : " + clean(batch.notes), { size: 8 });
        write("Créé par : " + clean(batch.createdBy || "—") + " · " + auditDate(batch.createdAt), { size: 7, color: muted, gap: 9 });
        write("Recettes renseignées de ce lot : " + money(batchSales.total) + " · " + batchSales.unpriced + " vente(s) sans montant", { size: 9, color: green, gap: 11 });
        write("Historique des mortalités et des ventes", { size: 10, color: green });
        if (!batchEvents.length) write("Aucune mortalité ni vente enregistrée pour ce lot.", { size: 8, color: muted, gap: 12 });
        for (const event of batchEvents) {
          ensure(75);
          const label = event.type === "mortality" ? "Mortalité" : "Vente";
          const date = dateLabel(event.date) + " à " + clean(event.time) + " · " + clean(event.timezone || timezone);
          write(date, { size: 8, color: muted, gap: 2 });
          write(label + " : " + formatNumber(event.quantity) + " poulet(s) · Restants après enregistrement : " + formatNumber(event.remainingAfter), { size: 9, background: event.type === "mortality" ? "#fff4e8" : "#f0f5ea", inset: 7, gap: 5 });
          if (event.type === "sale") {
            write(event.totalAmount === null || event.totalAmount === undefined ? "Montant de vente : non renseigné" : "Montant de vente : " + money(BigInt(event.totalAmount)), { size: 8.5, color: green });
            if (event.buyer) write("Acheteur : " + clean(event.buyer), { size: 8 });
          }
          if (event.reason) write("Observation : " + clean(event.reason), { size: 8 });
          write("Référence : " + clean(event.reference || event.id) + " · Saisi par : " + clean(event.createdBy || "—") + " · " + auditDate(event.createdAt), { size: 7, color: muted, gap: 10 });
        }
      }
      context = "";
      rule();
      write("Les effectifs sont ceux des opérations enregistrées. Les recettes renseignées ne constituent pas un calcul de bénéfice. Les stades de croissance sont saisis par l’équipe, sans déduction automatique d’un âge de maturité.", { size: 7.5, color: muted });
      const pages = doc.bufferedPageRange();
      for (let page = pages.start; page < pages.start + pages.count; page++) {
        doc.switchToPage(page); const marginBottom = doc.page.margins.bottom; doc.page.margins.bottom = 0;
        const text = "Document interne · " + farmName + " · " + (page + 1) + " / " + pages.count;
        doc.fontSize(7); const size = Math.min(7, 7 * width / doc.widthOfString(text));
        doc.fontSize(size).fillColor(muted).text(text, 40, doc.page.height - 27, { width, align: "center", lineBreak: false });
        doc.page.margins.bottom = marginBottom;
      }
      doc.end();
    } catch (error) { doc.destroy(); reject(error); }
  });
}

module.exports = { goliathPdf };
