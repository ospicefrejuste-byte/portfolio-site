"use strict";

(() => {
  // The QR uses a fragment: the verification code is never sent in the page URL.
  // Keep it in memory only and immediately remove it from the visible address.
  function takeFragmentToken() {
    const fragment = location.hash.slice(1);
    let value;
    try { value = decodeURIComponent(fragment); }
    catch (_) { value = fragment; }
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    return value;
  }
  let token = takeFragmentToken();

  const root = document.getElementById("receipt-verification");
  const title = document.getElementById("verification-title");
  const message = document.getElementById("verification-message");
  const receiptPanel = document.getElementById("verified-receipt");
  const allocationPanel = document.getElementById("receipt-allocation-panel");
  const allocationList = document.getElementById("receipt-allocations");
  const retry = document.getElementById("verification-retry");
  const help = document.getElementById("verification-help");
  let pending = false;
  let generation = 0;
  let activeController = null;

  function setState(state, heading, description, advice = "") {
    root.dataset.state = state;
    root.setAttribute("aria-busy", state === "loading" ? "true" : "false");
    title.textContent = heading;
    message.textContent = description;
    help.textContent = advice;
    help.hidden = !advice;
    receiptPanel.hidden = !["verified", "test"].includes(state);
    if (receiptPanel.hidden) {
      for (const name of ["reference", "school", "student", "class", "centre", "amount", "period", "date", "channel"]) document.getElementById("receipt-" + name).textContent = "";
      allocationList.replaceChildren();
      allocationPanel.hidden = true;
    }
    retry.hidden = state !== "unavailable";
    retry.disabled = state === "loading";
  }

  function validReceipt(result) {
    const value = result?.receipt;
    return ["verified", "test"].includes(result?.status) && value &&
      ["reference", "studentName", "class", "centre", "schoolName", "date", "period"].every(name => typeof value[name] === "string") &&
      value.reference.length > 0 && value.studentName.length > 0 &&
      Number.isSafeInteger(value.amount) && value.amount >= 0 && value.currency === "FCFA" &&
      ["cash", "online", "administrative"].includes(value.channel) &&
      /^\d{4}-(0[1-9]|1[0-2])$/.test(value.period) &&
      /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value.date) &&
      Number.isFinite(new Date(value.date.length === 10 ? value.date + "T12:00:00" : value.date).getTime()) &&
      receiptAllocations(value).length > 0;
  }

  function receiptAllocations(value) {
    if (value.allocations === undefined && value.periods === undefined) return [{ period: value.period, amount: value.amount }];
    const rows = value.allocations;
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 1200 ||
      rows.some(row => !row || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(row.period) || !Number.isSafeInteger(row.amount) || row.amount < 0) ||
      new Set(rows.map(row => row.period)).size !== rows.length ||
      rows.reduce((sum, row) => sum + row.amount, 0) !== value.amount) return [];
    const sorted = [...rows].sort((a, b) => a.period.localeCompare(b.period));
    if (sorted[0].period !== value.period || !Array.isArray(value.periods) ||
      value.periods.length !== sorted.length || sorted.some((row, index) => row.period !== value.periods[index])) return [];
    return sorted;
  }

  function dateLabel(value) {
    return new Date(value.length === 10 ? value + "T12:00:00" : value).toLocaleDateString("fr-FR", {
      day: "numeric", month: "long", year: "numeric",
    });
  }

  function periodLabel(value) {
    const [year, month] = value.split("-").map(Number);
    return new Date(year, month - 1, 1, 12).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  }

  function fillReceipt(value) {
    const allocations = receiptAllocations(value);
    const fields = {
      reference: value.reference,
      school: value.schoolName || "Non renseigné",
      student: value.studentName,
      class: value.class || "Non renseignée",
      centre: value.centre || "Non renseignée",
      amount: `${new Intl.NumberFormat("fr-FR").format(value.amount)} FCFA`,
      period: allocations.map(row => periodLabel(row.period)).join(", "),
      date: dateLabel(value.date),
      channel: { cash: "Paiement en présentiel", online: "Paiement en ligne", administrative: "Saisie administrative" }[value.channel],
    };
    for (const [name, text] of Object.entries(fields)) document.getElementById("receipt-" + name).textContent = text;
    allocationList.replaceChildren();
    allocationPanel.hidden = allocations.length < 2;
    if (!allocationPanel.hidden) for (const allocation of allocations) {
      const row = document.createElement("div");
      const month = document.createElement("dt");
      const amount = document.createElement("dd");
      month.textContent = periodLabel(allocation.period);
      amount.textContent = `${new Intl.NumberFormat("fr-FR").format(allocation.amount)} FCFA`;
      row.append(month, amount);
      allocationList.append(row);
    }
  }

  async function verify() {
    if (pending) return;
    const currentGeneration = ++generation;
    const currentToken = token;
    if (activeController) activeController.abort();
    activeController = null;
    if (!currentToken) {
      setState("missing", "Scannez le QR du reçu", "Aucun code de vérification n’est disponible sur cette page.", "Ouvrez cette page en scannant le QR figurant sur le reçu papier ou PDF. Si le lien a été perdu ou si vous avez actualisé la page, scannez-le de nouveau.");
      return;
    }
    pending = true;
    setState("loading", "Vérification en cours…", "Nous consultons l’enregistrement de ce reçu.");
    const controller = new AbortController();
    activeController = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch("/api/receipts/verify", {
        method: "POST", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ token: currentToken }), signal: controller.signal,
      });
      if (currentGeneration !== generation) return;
      if (response.status === 404) {
        setState("invalid", "Reçu non reconnu", "Ce code ne correspond pas à un reçu enregistré.", "Vérifiez que vous avez scanné le QR du bon document et demandez au responsable de vérifier le reçu.");
        return;
      }
      if (response.status === 429) {
        setState("unavailable", "Vérification temporairement indisponible", "Trop de vérifications ont été demandées. Réessayez dans quelques instants.", "Cette limite ne permet pas de conclure que le reçu est incorrect. Vous pouvez aussi demander au responsable de le vérifier.");
        return;
      }
      if (!response.ok) throw new Error("verification unavailable");
      const result = await response.json();
      if (currentGeneration !== generation) return;
      if (result?.status === "cancelled" && typeof result.reference === "string" && result.reference) {
        setState("cancelled", "Reçu d’essai retiré", "Le responsable a supprimé ce dossier d’essai et son paiement fictif.", `Référence : ${result.reference}. Ce document ne justifie aucun encaissement. Contactez l’établissement si vous avez réellement versé de l’argent.`);
        return;
      }
      if (!validReceipt(result)) throw new Error("unexpected verification response");
      fillReceipt(result.receipt);
      if (result.status === "test") {
        setState("test", "Reçu de test", "Cette transaction de test est enregistrée. Elle ne correspond pas à un paiement réel.", "Ce reçu ne prouve aucun encaissement et ne règle pas la mensualité de l’élève.");
      } else {
        setState("verified", "Reçu enregistré", "Un paiement correspondant à ce reçu est enregistré dans le système.");
      }
    } catch (_) {
      if (currentGeneration !== generation) return;
      setState("unavailable", "Vérification indisponible", "La vérification n’a pas pu être effectuée. Vérifiez votre connexion et réessayez.", "Cette panne ne permet pas de conclure que le reçu est incorrect. Demandez au responsable de vérifier le paiement si le problème persiste.");
    } finally {
      clearTimeout(timeout);
      if (currentGeneration === generation) {
        pending = false;
        activeController = null;
      }
    }
  }

  // Opening a different receipt can be a fragment-only navigation: the browser
  // keeps this document and does not run the script again. Supersede any request
  // for the previous receipt so its delayed response cannot replace the new one.
  window.addEventListener("hashchange", () => {
    token = takeFragmentToken();
    pending = false;
    verify();
  });
  retry.addEventListener("click", verify);
  verify();
})();
