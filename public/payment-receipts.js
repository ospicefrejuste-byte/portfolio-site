"use strict";

(function () {
  const cache = new Map();
  const MAX_CACHED_RECEIPTS = 8;
  let receiptDialog;

  function notify(message) {
    if (typeof toast === "function") toast(message);
  }
  function cacheKey(payment) {
    return JSON.stringify([payment.id, payment.amount, payment.period, payment.date, payment.mode, payment.source, payment.collectedByName, payment.allocations]);
  }
  function filename(payment) {
    const reference = String(payment.id || "paiement").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
    return "recu-" + reference + ".pdf";
  }
  function summary(payment, student = {}) {
    const total = Number(payment.amount || 0).toLocaleString("fr-FR") + " FCFA";
    const day = /^\d{4}-\d{2}-\d{2}$/.test(payment.date || "") ? payment.date.split("-").reverse().join("/") : payment.date || "";
    const lines = [
      payment.mode === "sandbox" ? "Confirmation de test — aucun paiement réel" : "Reçu de paiement — cours de renforcement scolaire",
      "Élève : " + (student.name || "Élève"),
      student.class ? "Classe : " + student.class : "",
      "Mois réglés : " + (window.paymentMonths ? window.paymentMonths.labels(payment).join(", ") : payment.period || ""),
      "Montant : " + total,
      day ? "Date : " + day : "",
      "Référence : " + (payment.id || ""),
      "Le reçu PDF accompagne ce message.",
    ];
    return lines.filter(Boolean).join("\n");
  }
  async function receiptBlob(payment) {
    if (!payment || typeof payment.id !== "string" || !payment.id) throw new Error("Le reçu est introuvable.");
    const key = cacheKey(payment);
    if (cache.has(key)) return cache.get(key);
    const pending = (async () => {
      const response = await fetch("/api/payments/" + encodeURIComponent(payment.id) + "/receipt.pdf", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) {
        if (response.status === 401) {
          location.assign("/connexion.html");
          throw new Error("Reconnectez-vous pour télécharger votre reçu.");
        }
        let message = "Le reçu n’a pas pu être téléchargé.";
        try { const body = await response.json(); if (body.error) message = body.error; } catch (_) {}
        throw new Error(message);
      }
      if (!(response.headers.get("content-type") || "").toLowerCase().includes("application/pdf")) throw new Error("Le serveur n’a pas renvoyé un reçu PDF.");
      const blob = await response.blob();
      if ((await blob.slice(0, 5).text()) !== "%PDF-") throw new Error("Le reçu PDF est incomplet. Réessayez.");
      return blob;
    })();
    cache.set(key, pending);
    while (cache.size > MAX_CACHED_RECEIPTS) cache.delete(cache.keys().next().value);
    try { return await pending; } catch (error) { cache.delete(key); throw error; }
  }
  function saveBlob(blob, payment) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename(payment);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  async function downloadPaymentReceipt(payment) {
    try {
      saveBlob(await receiptBlob(payment), payment);
      notify("Reçu PDF téléchargé. Vous pouvez l’imprimer ou le joindre à un message.");
      return true;
    } catch (error) { notify(error.message); return false; }
  }
  async function sharePaymentReceipt(payment, student) {
    try {
      const blob = await receiptBlob(payment);
      const file = typeof File === "function" ? new File([blob], filename(payment), { type: "application/pdf" }) : null;
      if (file && typeof navigator.share === "function" && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: "Reçu de paiement", text: summary(payment, student) });
          return true;
        } catch (error) {
          if (error.name === "AbortError") return false;
        }
      }
      saveBlob(blob, payment);
      notify("Reçu PDF téléchargé. Joignez ce fichier à WhatsApp, un courriel ou l’application de votre choix.");
      return true;
    } catch (error) { notify(error.message); return false; }
  }
  function internationalPhone(value) {
    const raw = String(value || "").trim();
    const phone = raw.replace(/[\s().-]/g, "");
    if (!/^(?:\+|00)[1-9]\d{7,14}$/.test(phone)) return "";
    return phone.replace(/^(?:\+|00)/, "");
  }
  function dialog() {
    if (receiptDialog) return receiptDialog;
    receiptDialog = document.createElement("dialog");
    receiptDialog.id = "whatsapp-receipt-dialog";
    receiptDialog.setAttribute("aria-labelledby", "whatsapp-receipt-title");
    receiptDialog.innerHTML = '<form><div class="dialog-head"><h2 id="whatsapp-receipt-title">Préparer le reçu pour WhatsApp</h2><button class="icon-button" type="button" data-receipt-close aria-label="Fermer">×</button></div><p class="helper">Le reçu PDF sera téléchargé. Dans WhatsApp, joignez ce fichier au message, puis envoyez-le au parent.</p><label>Numéro du parent avec l’indicatif du pays<input type="tel" name="phone" autocomplete="tel" placeholder="+229…" required></label><p class="helper">Commencez par + ou 00, puis l’indicatif du pays. Aucun indicatif n’est ajouté automatiquement.</p><label>Message au parent<textarea name="message" rows="8" required maxlength="2500" style="width:100%;resize:vertical"></textarea></label><p data-receipt-error role="alert" style="color:#b42318"></p><button class="primary" type="submit">Télécharger le reçu et ouvrir WhatsApp</button></form>';
    document.body.appendChild(receiptDialog);
    receiptDialog.querySelector("[data-receipt-close]").onclick = () => receiptDialog.close();
    return receiptDialog;
  }
  async function whatsappReceipt(payment, student = {}) {
    // Prepare the private PDF before opening the draft, so its final click retains
    // the browser's user activation and cannot lose the WhatsApp popup.
    try {
      const blob = await receiptBlob(payment);
      const modal = dialog();
      const form = modal.querySelector("form");
      const phoneField = form.elements.namedItem("phone");
      const messageField = form.elements.namedItem("message");
      const errorField = modal.querySelector("[data-receipt-error]");
      phoneField.value = internationalPhone(student.phone) ? student.phone : "";
      messageField.value = summary(payment, student);
      errorField.textContent = "";
      form.onsubmit = (event) => {
        event.preventDefault();
        const phone = internationalPhone(phoneField.value);
        const message = messageField.value.trim();
        if (!phone) { errorField.textContent = "Indiquez le numéro complet avec + ou 00 et l’indicatif du pays."; phoneField.focus(); return; }
        if (!message) { errorField.textContent = "Écrivez un message pour le parent."; messageField.focus(); return; }
        window.open("https://wa.me/" + phone + "?text=" + encodeURIComponent(message), "_blank", "noopener,noreferrer");
        saveBlob(blob, payment);
        modal.close();
        notify("Ajoutez le PDF téléchargé au message dans WhatsApp. Le parent ne reçoit rien tant que vous n’envoyez pas le message.");
      };
      if (!modal.open) modal.showModal();
      phoneField.focus();
      return true;
    } catch (error) { notify(error.message); return false; }
  }

  window.downloadPaymentReceipt = downloadPaymentReceipt;
  window.sharePaymentReceipt = sharePaymentReceipt;
  window.whatsappReceipt = whatsappReceipt;
  window.preloadPaymentReceipt = (payment) => receiptBlob(payment).then(() => true, () => false);
})();
