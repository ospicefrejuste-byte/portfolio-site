"use strict";

sections.cashier = ["▣", "Caisse en présentiel"];

const cashierState = {
  period: cashierCurrentPeriod(),
  class: "",
  centre: "",
  status: "",
  query: "",
  revision: 0,
  cache: new Map(),
};

function cashierCurrentPeriod() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function cashierAllowed() {
  return role === "admin" || role === "cashier";
}

function invalidateCashier() {
  cashierState.revision += 1;
  cashierState.cache.clear();
}

function cashierAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.max(0, amount) : 0;
}

function cashierPeriodLabel(period) {
  const [year, month] = String(period).split("-").map(Number);
  return new Date(year, month - 1, 1, 12).toLocaleDateString("fr-FR", {
    month: "long", year: "numeric",
  });
}

function cashierDateLabel(value) {
  if (!value) return "Date non renseignée";
  const text = String(value);
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(text) ? text + "T12:00:00" : text);
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" })
    : "Date non renseignée";
}

function cashierNormalize(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr").trim();
}

function cashierOptions(values, selected, emptyLabel) {
  return `<option value="">${esc(emptyLabel)}</option>${[...new Set(values.filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "fr", { numeric: true }))
    .map(value => `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(value)}</option>`)
    .join("")}`;
}

function cashierSituation(row) {
  if (row.registrationStatus === "Suspendu") return { label: "Suspendu", tone: "suspended" };
  if (cashierAmount(row.fee) === 0) return { label: "Sans frais", tone: "settled" };
  if (cashierAmount(row.balance) === 0) return { label: "Payé", tone: "settled" };
  if (cashierAmount(row.paid) > 0) return { label: "Partiellement payé", tone: "partial" };
  return { label: "À payer", tone: "due" };
}

function cashierPage() {
  if (!cashierAllowed()) return '<div class="empty-note">Cet espace est réservé au caissier et au responsable.</div>';
  const rows = cashierState.cache.get(cashierState.period)?.students || [];
  const classes = [...catalogue.levels.map(([name]) => name), ...rows.map(row => row.class)];
  const centres = [...catalogue.centres, ...rows.map(row => row.centre)];
  return `<section class="cashier-intro"><div><span class="cashier-eyebrow">Encaissement au centre</span><h2>Un paiement reçu, un reçu remis.</h2><p>Retrouvez l’élève, vérifiez sa mensualité et enregistrez l’argent effectivement reçu en espèces.</p></div><span class="cashier-access">Caissier · Responsable</span></section>
    <div class="cashier-filters">
      <label>Mois concerné<input id="cashier-period" type="month" value="${esc(cashierState.period)}" required></label>
      <label>Classe<select id="cashier-class">${cashierOptions(classes, cashierState.class, "Toutes les classes")}</select></label>
      <label>Centre<select id="cashier-centre">${cashierOptions(centres, cashierState.centre, "Tous les centres")}</select></label>
      <label>Situation<select id="cashier-status"><option value="">Toutes les situations</option>${["À payer", "Partiellement payé", "Payé", "Sans frais", "Suspendu"].map(value => `<option${cashierState.status === value ? " selected" : ""}>${esc(value)}</option>`).join("")}</select></label>
      <label class="cashier-search-label">Élève ou parent<input id="cashier-search" type="search" value="${esc(cashierState.query)}" placeholder="Nom, parent ou téléphone…"></label>
      <button id="cashier-reset" class="secondary" type="button">Effacer les filtres</button>
    </div>
    <div id="cashier-results" aria-live="polite">${cashierResults()}</div>`;
}

function cashierFilteredRows(rows) {
  const term = cashierNormalize(cashierState.query);
  return rows.filter(row =>
    (!cashierState.class || row.class === cashierState.class) &&
    (!cashierState.centre || row.centre === cashierState.centre) &&
    (!cashierState.status || cashierSituation(row).label === cashierState.status) &&
    (!term || cashierNormalize([row.name, row.guardian, row.phone, row.class, row.centre, row.group].join(" ")).includes(term))
  ).sort((a, b) => String(a.name).localeCompare(String(b.name), "fr", { numeric: true }));
}

function cashierResults() {
  const entry = cashierState.cache.get(cashierState.period);
  if (!entry || entry.loading) return '<div class="panel cashier-loading" role="status">Chargement de la caisse…</div>';
  if (entry.error) return `<div class="panel cashier-error"><p role="alert">${esc(entry.error)}</p><button id="cashier-retry" class="secondary" type="button">Réessayer</button></div>`;
  const rows = cashierFilteredRows(entry.students);
  const remaining = entry.students.reduce((sum, row) => sum + cashierAmount(row.balance), 0);
  const counts = entry.students.filter(row => cashierAmount(row.balance) > 0 && row.registrationStatus !== "Suspendu").length;
  const metrics = [
    ["Reçu en présentiel", money(cashierAmount(entry.totals.cash)), "Caisse et saisies administratives", "cash"],
    ["Reçu en ligne", money(cashierAmount(entry.totals.online)), "Paiements confirmés · hors tests", "online"],
    ["Reste à régler", money(remaining), `${counts} dossier(s) sur le mois`, "due"],
  ];
  const visibleIds = new Set(rows.map(row => row.id));
  const payments = entry.payments.filter(payment => visibleIds.has(payment.student))
    .sort((a, b) => String(b.createdAt || b.date).localeCompare(String(a.createdAt || a.date)) || String(b.id).localeCompare(String(a.id)));
  return `<div class="cashier-metrics">${metrics.map(([label, amount, detail, tone]) => `<div class="stat cashier-metric ${tone}"><span class="stat-label">${esc(label)}</span><strong>${esc(amount)}</strong><small>${esc(detail)}</small></div>`).join("")}</div>
    <section class="panel cashier-students" aria-labelledby="cashier-students-title"><div class="panel-head"><div><h2 id="cashier-students-title">Élèves · ${esc(cashierPeriodLabel(cashierState.period))}</h2><p>${rows.length} dossier(s) affiché(s)</p></div><button id="cashier-reload" class="secondary" type="button">Actualiser</button></div>
      <p class="cashier-note">Le solde tient compte des paiements en présentiel et des paiements en ligne confirmés. Le tarif actuel du dossier est utilisé pour le mois choisi. Les tests en ligne ne règlent pas la mensualité.</p>
      ${rows.length ? `<div class="cashier-student-grid">${rows.map(cashierStudentCard).join("")}</div>` : '<div class="empty-note">Aucun élève ne correspond à ces filtres.</div>'}
    </section>
    <section class="panel cashier-history" aria-labelledby="cashier-history-title"><div class="panel-head"><div><h2 id="cashier-history-title">Reçus de la caisse</h2><p>Encaissements en présentiel · ${esc(cashierPeriodLabel(cashierState.period))}${cashierState.query || cashierState.class || cashierState.centre || cashierState.status ? " · avec les filtres" : ""}</p></div><span class="cashier-history-count">${payments.length} reçu(s)</span></div>
      ${payments.length ? `<div class="cashier-receipt-list">${payments.map(payment => cashierReceiptRow(payment, entry.students)).join("")}</div>` : '<div class="empty-note">Aucun encaissement en présentiel pour ces dossiers et ce mois.</div>'}
      <p class="cashier-note">Téléchargez le PDF pour l’imprimer ou le remettre à la famille. Le bouton Partager propose les applications disponibles sur votre appareil.</p>
    </section>`;
}

function cashierStudentCard(row) {
  const situation = cashierSituation(row);
  const balance = cashierAmount(row.balance);
  const eligible = row.registrationStatus !== "Suspendu" && balance > 0 && !row.blockedReason;
  return `<article class="cashier-student-card"><div class="cashier-student-heading"><div><h3>${esc(row.name)}</h3><p>${esc(row.class)} · ${esc(row.centre || "Centre non renseigné")}</p></div><span class="cashier-status ${situation.tone}">${esc(situation.label)}</span></div>
    <p class="cashier-parent">${esc(row.guardian || "Parent non renseigné")}${row.phone ? ` · ${esc(row.phone)}` : ""}</p>
    ${row.registrationStatus === "Préinscription" ? '<span class="cashier-enrollment">Préinscription · validation du dossier par le responsable</span>' : ""}
    <dl class="cashier-amounts"><div><dt>Mensualité</dt><dd>${esc(money(cashierAmount(row.fee)))}</dd></div><div><dt>Déjà reçu</dt><dd>${esc(money(cashierAmount(row.paid)))}</dd></div><div class="cashier-balance"><dt>Reste à payer</dt><dd>${esc(money(balance))}</dd></div></dl>
    <p class="cashier-channel-detail">Présentiel : ${esc(money(cashierAmount(row.cashPaid)))}<br>En ligne : ${esc(money(cashierAmount(row.onlinePaid)))}</p>
    ${row.blockedReason ? `<p class="cashier-blocked" role="status">${esc(row.blockedReason)}</p>` : ""}
    <button class="${eligible ? "primary" : "secondary"} cashier-collect" type="button" data-cashier-collect="${esc(row.id)}"${eligible ? "" : " disabled"}>${eligible ? "Encaisser en espèces" : row.registrationStatus === "Suspendu" ? "Dossier suspendu" : row.blockedReason ? "Vérification nécessaire" : balance === 0 && cashierAmount(row.fee) > 0 ? "Mensualité payée ✓" : "Aucun montant à encaisser"}</button>
  </article>`;
}

function cashierReceiptRow(payment, students) {
  const row = students.find(student => student.id === payment.student);
  return `<article class="cashier-receipt-row"><div class="cashier-receipt-person"><strong>${esc(row?.name || "Élève non renseigné")}</strong><span>${esc(row?.class || "")} ${row?.centre ? "· " + esc(row.centre) : ""}</span><small>Reçu ${esc(payment.id)}</small></div><div class="cashier-receipt-details"><strong>${esc(money(cashierAmount(payment.amount)))}</strong><span>${esc(cashierDateLabel(payment.date || payment.createdAt))}</span><small>Enregistré par ${esc(payment.collectedByName || "Saisie administrative")}</small></div><div class="cashier-receipt-actions"><button class="secondary" type="button" data-cashier-pdf="${esc(payment.id)}">Télécharger PDF</button><button class="secondary" type="button" data-cashier-share="${esc(payment.id)}">Partager</button><button class="secondary" type="button" data-cashier-whatsapp="${esc(payment.id)}">Préparer WhatsApp</button></div></article>`;
}

async function cashierFetch() {
  if (!cashierAllowed() || page !== "cashier") return;
  const period = cashierState.period;
  if (cashierState.cache.has(period)) return;
  const revision = cashierState.revision;
  const entry = { loading: true, students: [], payments: [], totals: { cash: 0, online: 0 }, error: "" };
  cashierState.cache.set(period, entry);
  try {
    const result = await schoolAPI.request(`/api/cashier?period=${encodeURIComponent(period)}`);
    if (result.period !== period || !Array.isArray(result.students) || !Array.isArray(result.payments) || !result.totals) {
      throw new Error("La caisse n’a pas pu être chargée. Réessayez.");
    }
    Object.assign(entry, result);
  } catch (err) {
    if (err.status === 401) location.assign("/connexion.html");
    entry.error = err.message || "La caisse est indisponible. Réessayez.";
  } finally {
    entry.loading = false;
    if (revision === cashierState.revision && cashierState.cache.get(period) === entry && cashierState.period === period && cashierAllowed() && page === "cashier") cashierUpdateResults();
  }
}

function cashierUpdateResults() {
  if (!cashierAllowed() || page !== "cashier" || !$("cashier-results")) return;
  $("cashier-results").innerHTML = cashierResults();
  const rows = cashierState.cache.get(cashierState.period)?.students || [];
  if ($("cashier-class")) $("cashier-class").innerHTML = cashierOptions([...catalogue.levels.map(([name]) => name), ...rows.map(row => row.class)], cashierState.class, "Toutes les classes");
  if ($("cashier-centre")) $("cashier-centre").innerHTML = cashierOptions([...catalogue.centres, ...rows.map(row => row.centre)], cashierState.centre, "Tous les centres");
  bindCashierActions();
}

function cashierReload() {
  cashierState.cache.delete(cashierState.period);
  cashierUpdateResults();
  cashierFetch();
}

function bindCashier() {
  if (!cashierAllowed() || page !== "cashier") return;
  $("cashier-period").onchange = event => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) {
      event.target.value = cashierState.period;
      return;
    }
    cashierState.period = event.target.value;
    cashierUpdateResults();
    cashierFetch();
  };
  for (const key of ["class", "centre", "status"]) $("cashier-" + key).onchange = event => {
    cashierState[key] = event.target.value;
    cashierUpdateResults();
  };
  $("cashier-search").oninput = event => {
    cashierState.query = event.target.value;
    cashierUpdateResults();
  };
  $("cashier-reset").onclick = () => {
    Object.assign(cashierState, { class: "", centre: "", status: "", query: "" });
    render();
  };
  bindCashierActions();
  cashierFetch();
}

function bindCashierActions() {
  if ($("cashier-reload")) $("cashier-reload").onclick = cashierReload;
  if ($("cashier-retry")) $("cashier-retry").onclick = cashierReload;
  document.querySelectorAll("[data-cashier-collect]").forEach(button => button.onclick = () => {
    const row = cashierState.cache.get(cashierState.period)?.students.find(student => student.id === button.dataset.cashierCollect);
    if (row && row.registrationStatus !== "Suspendu" && !row.blockedReason && cashierAmount(row.balance) > 0) cashierCollectDialog(row, cashierState.period);
  });
  for (const action of ["pdf", "share", "whatsapp"]) document.querySelectorAll(`[data-cashier-${action}]`).forEach(button => {
    const getPayment = () => cashierState.cache.get(cashierState.period)?.payments.find(receipt => receipt.id === button.dataset[{ pdf: "cashierPdf", share: "cashierShare", whatsapp: "cashierWhatsapp" }[action]]);
    button.onclick = () => {
      const payment = getPayment();
      const row = cashierState.cache.get(cashierState.period)?.students.find(student => student.id === payment?.student);
      if (payment) cashierReceiptAction(action, button, payment, row);
    };
    if (action === "share") button.onpointerenter = button.onfocus = () => {
      const payment = getPayment();
      if (payment && typeof preloadPaymentReceipt === "function") preloadPaymentReceipt(payment);
    };
  });
}

async function cashierReceiptAction(action, button, payment, row) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    if (action === "pdf" && typeof downloadPaymentReceipt === "function") await downloadPaymentReceipt(payment);
    else if (action === "share" && typeof sharePaymentReceipt === "function") await sharePaymentReceipt(payment, row);
    else if (action === "whatsapp" && typeof whatsappReceipt === "function") await whatsappReceipt(payment, row);
    else throw new Error("Le partage du reçu est indisponible. Actualisez la page puis réessayez.");
  } catch (err) {
    handleError(err);
  } finally {
    button.disabled = false;
  }
}

function cashierCollectDialog(row, period) {
  if (!cashierAllowed() || row.blockedReason || row.registrationStatus === "Suspendu" || cashierAmount(row.balance) <= 0) return;
  const previous = $("cashier-collect-dialog");
  if (previous) previous.remove();
  const dialog = document.createElement("dialog");
  dialog.id = "cashier-collect-dialog";
  dialog.className = "cashier-dialog";
  dialog.setAttribute("aria-labelledby", "cashier-collect-title");
  const draft = { stage: "amount", amount: cashierAmount(row.balance), requestId: crypto.randomUUID(), pending: false, attempted: false, uncertain: false, error: "", receipt: null, refreshError: "" };
  const close = () => {
    if (!draft.pending) dialog.close();
  };
  const paint = () => {
    const receipt = draft.receipt;
    dialog.innerHTML = `<div class="dialog-head"><h2 id="cashier-collect-title">${receipt ? "Encaissement enregistré" : draft.stage === "confirm" ? "Confirmer le paiement reçu" : "Encaisser en espèces"}</h2><button class="icon-button" id="cashier-collect-close" type="button" aria-label="Fermer"${draft.pending ? " disabled" : ""}>×</button></div>
      <div class="cashier-dialog-student"><strong>${esc(row.name)}</strong><span>${esc(row.class)} · ${esc(row.centre || "Centre non renseigné")}</span><span>${esc(row.guardian || "Parent non renseigné")}${row.phone ? " · " + esc(row.phone) : ""}</span></div>
      ${receipt ? `<div class="cashier-success" role="status"><span aria-hidden="true">✓</span><div><strong>${esc(money(cashierAmount(receipt.amount)))}</strong><p>Reçu en présentiel pour ${esc(cashierPeriodLabel(period))}.</p></div></div><p class="cashier-receipt-reference">Référence : ${esc(receipt.id)}</p><p class="cashier-note">Le paiement est enregistré dans l’administration. Vous pouvez télécharger le reçu pour l’imprimer ou le partager au parent.</p>${draft.refreshError ? `<p class="cashier-dialog-error" role="alert">${esc(draft.refreshError)}</p>` : ""}<div class="cashier-dialog-receipt-actions"><button id="cashier-success-pdf" class="primary" type="button">Télécharger le reçu PDF</button><button id="cashier-success-share" class="secondary" type="button">Partager le PDF</button><button id="cashier-success-whatsapp" class="secondary" type="button">Préparer WhatsApp</button></div><button id="cashier-collect-done" class="secondary cashier-dialog-done" type="button">Terminer</button>`
        : draft.stage === "amount" ? `<dl class="cashier-dialog-summary"><div><dt>Mois concerné</dt><dd>${esc(cashierPeriodLabel(period))}</dd></div><div><dt>Mensualité</dt><dd>${esc(money(cashierAmount(row.fee)))}</dd></div><div><dt>Déjà réglé</dt><dd>${esc(money(cashierAmount(row.paid)))}</dd></div><div><dt>Reste à payer</dt><dd>${esc(money(cashierAmount(row.balance)))}</dd></div></dl><form id="cashier-amount-form"><label for="cashier-amount">Montant remis en espèces (FCFA)</label><input id="cashier-amount" name="amount" type="number" inputmode="numeric" min="1" max="${cashierAmount(row.balance)}" step="1" value="${draft.amount}" required><p class="cashier-note">Vous pouvez enregistrer un paiement partiel. Le statut « Payé » apparaît lorsque toute la mensualité est réglée.</p><p class="cashier-dialog-error" id="cashier-amount-error" role="alert">${esc(draft.error)}</p><div class="cashier-dialog-buttons"><button id="cashier-collect-cancel" class="secondary" type="button">Annuler</button><button class="primary" type="submit">Vérifier l’encaissement</button></div></form>`
          : `<div class="cashier-confirm-amount"><span>Argent reçu en espèces</span><strong>${esc(money(draft.amount))}</strong><p>Pour ${esc(cashierPeriodLabel(period))}</p></div><p class="cashier-confirm-note">${draft.amount < cashierAmount(row.balance) ? `Paiement partiel : il restera ${esc(money(cashierAmount(row.balance) - draft.amount))} à régler.` : "Ce paiement règle le reste de la mensualité."}</p><p class="cashier-note">Confirmez uniquement après avoir reçu l’argent. Un reçu sera créé et le règlement sera visible par le responsable.</p>${draft.error ? `<p class="cashier-dialog-error" role="alert">${esc(draft.error)}</p>` : ""}${draft.uncertain ? '<p class="cashier-note">La réponse du serveur n’a pas été reçue. Réessayez avec ce même formulaire pour vérifier le paiement sans créer un second encaissement.</p>' : ""}<div class="cashier-dialog-buttons">${draft.uncertain ? "" : `<button id="cashier-collect-back" class="secondary" type="button"${draft.pending ? " disabled" : ""}>Modifier le montant</button>`}<button id="cashier-collect-confirm" class="primary" type="button"${draft.pending ? " disabled" : ""}>${draft.pending ? "Enregistrement…" : draft.uncertain ? "Réessayer la confirmation" : "Confirmer l’encaissement"}</button></div>`}`;
    $("cashier-collect-close").onclick = close;
    if (receipt) {
      $("cashier-collect-done").onclick = close;
      for (const action of ["pdf", "share", "whatsapp"]) $("cashier-success-" + action).onclick = event => cashierReceiptAction(action, event.currentTarget, receipt, row);
    } else if (draft.stage === "amount") {
      $("cashier-collect-cancel").onclick = close;
      $("cashier-amount-form").onsubmit = event => {
        event.preventDefault();
        const amount = Number($("cashier-amount").value);
        if (!Number.isSafeInteger(amount) || amount <= 0 || amount > cashierAmount(row.balance)) {
          $("cashier-amount-error").textContent = "Indiquez un montant entier entre 1 FCFA et le reste à payer.";
          return;
        }
        if (amount !== draft.amount && draft.attempted) {
          draft.requestId = crypto.randomUUID();
          draft.attempted = false;
        }
        draft.amount = amount;
        draft.stage = "confirm";
        draft.error = "";
        paint();
        $("cashier-collect-confirm").focus();
      };
    } else {
      if ($("cashier-collect-back")) $("cashier-collect-back").onclick = () => {
        draft.stage = "amount";
        draft.error = "";
        paint();
      };
      $("cashier-collect-confirm").onclick = submit;
    }
  };
  const submit = async () => {
    if (draft.pending || draft.receipt || !cashierAllowed()) return;
    draft.pending = true;
    draft.attempted = true;
    draft.error = "";
    paint();
    try {
      const receipt = await schoolAPI.request("/api/cashier/payments", "POST", {
        requestId: draft.requestId, student: row.id, period, amount: draft.amount,
      });
      if (!receipt || !receipt.id || receipt.student !== row.id || receipt.period !== period || Number(receipt.amount) !== draft.amount) {
        throw new Error("La réponse du serveur est incomplète. Réessayez la confirmation pour retrouver votre reçu.");
      }
      draft.receipt = receipt;
      draft.uncertain = false;
      if (typeof preloadPaymentReceipt === "function") preloadPaymentReceipt(receipt);
      invalidateCashier();
      try {
        await refresh();
      } catch (err) {
        draft.refreshError = "Le paiement est enregistré, mais la liste n’a pas pu être actualisée. Actualisez la caisse avant un autre encaissement.";
        if (err.status === 401) location.assign("/connexion.html");
      }
      if (page === "cashier" && cashierAllowed()) render();
      toast("Encaissement enregistré. Le reçu PDF est disponible.");
    } catch (err) {
      if (err.status === 401) location.assign("/connexion.html");
      draft.uncertain = !err.status || err.status >= 500;
      draft.error = err.message || "Le paiement n’a pas pu être confirmé. Réessayez.";
      if (!draft.uncertain) cashierReload();
    } finally {
      draft.pending = false;
      if (dialog.isConnected) paint();
    }
  };
  dialog.oncancel = event => {
    if (draft.pending) event.preventDefault();
  };
  dialog.onclose = () => {
    dialog.remove();
    if (draft.uncertain) cashierReload();
  };
  document.body.append(dialog);
  paint();
  dialog.showModal();
  $("cashier-amount").focus();
  $("cashier-amount").select();
}
