"use strict";

sections.cashier = ["▣", "Caisse en présentiel"];

const cashierState = {
  period: cashierCurrentPeriod(),
  class: "",
  centre: "",
  student: "",
  status: "",
  query: "",
  revision: 0,
  cache: new Map(),
  intents: new Map(),
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

function cashierMonthOffset(period, offset) {
  const [year, month] = String(period).split("-").map(Number);
  const serial = year * 12 + month - 1 + offset;
  if (!Number.isInteger(serial) || serial < 2000 * 12 || serial > 2099 * 12 + 11) return "";
  return `${Math.floor(serial / 12)}-${String(serial % 12 + 1).padStart(2, "0")}`;
}

function cashierMonthsRemaining(period) {
  const [year, month] = String(period).split("-").map(Number);
  return (2099 - year) * 12 + 13 - month;
}

function cashierPaymentPeriods(payment) {
  const periods = Array.isArray(payment.periods) ? payment.periods : [payment.period];
  return [...new Set(periods.filter(period => /^\d{4}-(0[1-9]|1[0-2])$/.test(period)))].sort();
}

function cashierPaymentMonths(payment) {
  return cashierPaymentPeriods(payment).map(cashierPeriodLabel).join(" · ");
}

function cashierUncertainPayments() {
  if (!cashierState.intents.size) return "";
  return `<section class="panel cashier-unresolved" role="status"><strong>Un encaissement reste à vérifier</strong><p>Reprenez sa confirmation pour retrouver le reçu avant de modifier les mois ou le montant.</p>${[...cashierState.intents.values()].map(intent => `<button class="secondary" type="button" data-cashier-resume="${esc(intent.row.id)}">Reprendre · ${esc(intent.row.name)}</button>`).join("")}</section>`;
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

function cashierCanCollect(row) {
  return !!row && row.registrationStatus !== "Suspendu" && cashierAmount(row.balance) > 0 && !row.blockedReason;
}

function cashierCanChooseMonths(row) {
  return !!row && row.registrationStatus !== "Suspendu" && cashierAmount(row.fee) > 0;
}

function cashierCollectLabel(row) {
  if (!row) return "Choisir un élève";
  if (cashierCanCollect(row)) return "Encaisser en espèces";
  if (row.registrationStatus === "Suspendu") return "Dossier suspendu";
  if (row.blockedReason) return "Vérification nécessaire";
  if (cashierAmount(row.balance) === 0 && cashierAmount(row.fee) > 0) return "Mensualité payée ✓";
  return "Aucun montant à encaisser";
}

function cashierPage() {
  if (!cashierAllowed()) return '<div class="empty-note">Cet espace est réservé au caissier et au responsable.</div>';
  const rows = cashierState.cache.get(cashierState.period)?.students || [];
  const classes = [...catalogue.levels.map(([name]) => name), ...rows.map(row => row.class)];
  const centres = [...catalogue.centres, ...rows.map(row => row.centre)];
  return `<section class="cashier-intro"><div><span class="cashier-eyebrow">Encaissement au centre</span><h2>Un paiement reçu, un reçu remis.</h2><p>Choisissez l’école, la classe puis l’élève dans la liste. Vérifiez sa mensualité et enregistrez l’argent effectivement reçu en espèces.</p></div><span class="cashier-access">Caissier · Responsable</span></section>
    <div class="cashier-filters">
      <label>École / centre<select id="cashier-centre">${cashierOptions(centres, cashierState.centre, "Toutes les écoles / centres")}</select></label>
      <label>Classe<select id="cashier-class">${cashierOptions(classes, cashierState.class, "Toutes les classes")}</select></label>
      <label>Mois concerné<input id="cashier-period" type="month" value="${esc(cashierState.period)}" required></label>
      <label>Situation<select id="cashier-status"><option value="">Toutes les situations</option>${["À payer", "Partiellement payé", "Payé", "Sans frais", "Suspendu"].map(value => `<option${cashierState.status === value ? " selected" : ""}>${esc(value)}</option>`).join("")}</select></label>
      <label class="cashier-search-label">Recherche facultative<input id="cashier-search" type="search" value="${esc(cashierState.query)}" placeholder="Élève, parent ou téléphone…"></label>
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

function cashierStudentSelection(rows, selected) {
  const ready = !!cashierState.centre && !!cashierState.class;
  const situation = selected ? cashierSituation(selected) : null;
  return `<section class="panel cashier-selection" aria-labelledby="cashier-selection-title"><div><h2 id="cashier-selection-title">Encaisser un élève</h2><p class="cashier-note">${ready ? "Sélectionnez l’élève dans la liste de cette classe." : "Choisissez d’abord une école / centre et une classe dans les menus ci-dessus."}</p></div>
    <div class="cashier-selection-controls"><label for="cashier-student">Élève de la classe<select id="cashier-student"${ready ? "" : " disabled"}><option value="">${ready && !rows.length ? "Aucun élève pour ces filtres" : "Choisir un élève"}</option>${ready ? rows.map(row => `<option value="${esc(row.id)}"${row.id === selected?.id ? " selected" : ""}>${esc(row.name)} · ${esc(row.registrationStatus === "Préinscription" ? "Préinscription · " : "")}${esc(cashierSituation(row).label)}</option>`).join("") : ""}</select></label>
      <button id="cashier-selected-collect" class="${cashierCanCollect(selected) ? "primary" : "secondary"}" type="button"${cashierCanCollect(selected) ? "" : " disabled"}>${esc(cashierCollectLabel(selected))}</button>${cashierCanChooseMonths(selected) && !cashierCanCollect(selected) ? '<button id="cashier-selected-months" class="secondary" type="button">Choisir d’autres mois</button>' : ""}</div>
    ${selected ? `<div class="cashier-selection-summary"><strong>${esc(selected.name)}</strong><span class="cashier-status ${situation.tone}">${esc(situation.label)}</span><span>Reste à payer : <strong>${esc(money(cashierAmount(selected.balance)))}</strong></span>${selected.blockedReason ? `<p class="cashier-blocked" role="status">${esc(selected.blockedReason)}</p>` : ""}</div>` : ""}
  </section>`;
}

function cashierResults() {
  const entry = cashierState.cache.get(cashierState.period);
  if (!entry || entry.loading) return cashierUncertainPayments() + '<div class="panel cashier-loading" role="status">Chargement de la caisse…</div>';
  if (entry.error) return `${cashierUncertainPayments()}<div class="panel cashier-error"><p role="alert">${esc(entry.error)}</p><button id="cashier-retry" class="secondary" type="button">Réessayer</button></div>`;
  const rows = cashierFilteredRows(entry.students);
  let selected = rows.find(row => row.id === cashierState.student);
  if (cashierState.student && (!selected || !cashierState.centre || !cashierState.class)) {
    cashierState.student = "";
    selected = undefined;
  }
  const remaining = entry.students.reduce((sum, row) => sum + cashierAmount(row.balance), 0);
  const counts = entry.students.filter(row => cashierAmount(row.balance) > 0 && row.registrationStatus !== "Suspendu").length;
  const metrics = [
    ["Reçu en présentiel", money(cashierAmount(entry.totals.cash)), "Caisse et saisies administratives", "cash"],
    ["Reçu en ligne", money(cashierAmount(entry.totals.online)), "Paiements confirmés · hors tests", "online"],
    ["Reste à régler", money(remaining), `${counts} dossier(s) sur le mois`, "due"],
  ];
  const visibleIds = new Set(selected ? [selected.id] : rows.map(row => row.id));
  const payments = entry.payments.filter(payment => visibleIds.has(payment.student))
    .sort((a, b) => String(b.createdAt || b.date).localeCompare(String(a.createdAt || a.date)) || String(b.id).localeCompare(String(a.id)));
  return `${cashierUncertainPayments()}${cashierStudentSelection(rows, selected)}<div class="cashier-metrics">${metrics.map(([label, amount, detail, tone]) => `<div class="stat cashier-metric ${tone}"><span class="stat-label">${esc(label)}</span><strong>${esc(amount)}</strong><small>${esc(detail)}</small></div>`).join("")}</div>
    <section class="panel cashier-students" aria-labelledby="cashier-students-title"><div class="panel-head"><div><h2 id="cashier-students-title">Élèves · ${esc(cashierPeriodLabel(cashierState.period))}</h2><p>${rows.length} dossier(s) affiché(s)</p></div><button id="cashier-reload" class="secondary" type="button">Actualiser</button></div>
      <p class="cashier-note">Le solde tient compte des paiements en présentiel et des paiements en ligne confirmés. Le tarif actuel du dossier est utilisé pour le mois choisi. Les tests en ligne ne règlent pas la mensualité.</p>
      ${rows.length ? `<div class="cashier-student-grid">${rows.map(cashierStudentCard).join("")}</div>` : '<div class="empty-note">Aucun élève ne correspond à ces filtres.</div>'}
    </section>
    <section class="panel cashier-history" aria-labelledby="cashier-history-title"><div class="panel-head"><div><h2 id="cashier-history-title">Reçus de la caisse</h2><p>Encaissements en présentiel · ${esc(cashierPeriodLabel(cashierState.period))}${selected ? " · " + esc(selected.name) : cashierState.query || cashierState.class || cashierState.centre || cashierState.status ? " · avec les filtres" : ""}</p></div><span class="cashier-history-count">${payments.length} reçu(s)</span></div>
      ${payments.length ? `<div class="cashier-receipt-list">${payments.map(payment => cashierReceiptRow(payment, entry.students)).join("")}</div>` : '<div class="empty-note">Aucun encaissement en présentiel pour ces dossiers et ce mois.</div>'}
      <p class="cashier-note">Téléchargez le PDF pour l’imprimer ou le remettre à la famille. Le bouton Partager propose les applications disponibles sur votre appareil.</p>
    </section>`;
}

function cashierStudentCard(row) {
  const situation = cashierSituation(row);
  const balance = cashierAmount(row.balance);
  const eligible = cashierCanCollect(row);
  return `<article class="cashier-student-card${row.id === cashierState.student ? " cashier-student-selected" : ""}"><div class="cashier-student-heading"><div><h3>${esc(row.name)}</h3><p>${esc(row.class)} · ${esc(row.centre || "Centre non renseigné")}</p></div><span class="cashier-status ${situation.tone}">${esc(situation.label)}</span></div>
    <p class="cashier-parent">${esc(row.guardian || "Parent non renseigné")}${row.phone ? ` · ${esc(row.phone)}` : ""}</p>
    ${row.registrationStatus === "Préinscription" ? '<span class="cashier-enrollment">Préinscription · validation du dossier par le responsable</span>' : ""}
    <dl class="cashier-amounts"><div><dt>Mensualité</dt><dd>${esc(money(cashierAmount(row.fee)))}</dd></div><div><dt>Déjà reçu</dt><dd>${esc(money(cashierAmount(row.paid)))}</dd></div><div class="cashier-balance"><dt>Reste à payer</dt><dd>${esc(money(balance))}</dd></div></dl>
    <p class="cashier-channel-detail">Présentiel : ${esc(money(cashierAmount(row.cashPaid)))}<br>En ligne : ${esc(money(cashierAmount(row.onlinePaid)))}</p>
    ${row.blockedReason ? `<p class="cashier-blocked" role="status">${esc(row.blockedReason)}</p>` : ""}
    <button class="${eligible ? "primary" : "secondary"} cashier-collect" type="button" data-cashier-collect="${esc(row.id)}"${eligible ? "" : " disabled"}>${esc(cashierCollectLabel(row))}</button>${cashierCanChooseMonths(row) && !eligible ? `<button class="secondary cashier-other-months" type="button" data-cashier-months="${esc(row.id)}">Choisir d’autres mois</button>` : ""}
  </article>`;
}

function cashierReceiptRow(payment, students) {
  const row = students.find(student => student.id === payment.student);
  return `<article class="cashier-receipt-row"><div class="cashier-receipt-person"><strong>${esc(row?.name || "Élève non renseigné")}</strong><span>${esc(row?.class || "")} ${row?.centre ? "· " + esc(row.centre) : ""}</span><small>Reçu ${esc(payment.id)}</small></div><div class="cashier-receipt-details"><strong>${esc(money(cashierAmount(payment.amount)))}</strong><span>${esc(cashierPaymentMonths(payment))}</span><span>${esc(cashierDateLabel(payment.date || payment.createdAt))}</span><small>Enregistré par ${esc(payment.collectedByName || "Saisie administrative")}</small></div><div class="cashier-receipt-actions"><button class="secondary" type="button" data-cashier-pdf="${esc(payment.id)}">Télécharger PDF</button><button class="secondary" type="button" data-cashier-share="${esc(payment.id)}">Partager</button><button class="secondary" type="button" data-cashier-whatsapp="${esc(payment.id)}">Préparer WhatsApp</button></div></article>`;
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
  if ($("cashier-centre")) $("cashier-centre").innerHTML = cashierOptions([...catalogue.centres, ...rows.map(row => row.centre)], cashierState.centre, "Toutes les écoles / centres");
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
    Object.assign(cashierState, { class: "", centre: "", student: "", status: "", query: "" });
    render();
  };
  bindCashierActions();
  cashierFetch();
}

function bindCashierActions() {
  document.querySelectorAll("[data-cashier-resume]").forEach(button => button.onclick = () => {
    const intent = cashierState.intents.get(button.dataset.cashierResume);
    if (intent) cashierCollectDialog(intent.row, intent.period);
  });
  if ($("cashier-reload")) $("cashier-reload").onclick = cashierReload;
  if ($("cashier-retry")) $("cashier-retry").onclick = cashierReload;
  if ($("cashier-student")) $("cashier-student").onchange = event => {
    cashierState.student = event.target.value;
    cashierUpdateResults();
    $("cashier-student")?.focus();
  };
  if ($("cashier-selected-collect")) $("cashier-selected-collect").onclick = () => {
    const row = cashierState.cache.get(cashierState.period)?.students.find(student => student.id === cashierState.student);
    if (cashierState.centre && cashierState.class && cashierCanCollect(row) && row.centre === cashierState.centre && row.class === cashierState.class) cashierCollectDialog(row, cashierState.period);
  };
  if ($("cashier-selected-months")) $("cashier-selected-months").onclick = () => {
    const row = cashierState.cache.get(cashierState.period)?.students.find(student => student.id === cashierState.student);
    if (cashierState.centre && cashierState.class && cashierCanChooseMonths(row) && row.centre === cashierState.centre && row.class === cashierState.class) cashierCollectDialog(row, cashierState.period);
  };
  document.querySelectorAll("[data-cashier-collect]").forEach(button => button.onclick = () => {
    const row = cashierState.cache.get(cashierState.period)?.students.find(student => student.id === button.dataset.cashierCollect);
    if (cashierCanCollect(row)) cashierCollectDialog(row, cashierState.period);
  });
  document.querySelectorAll("[data-cashier-months]").forEach(button => button.onclick = () => {
    const row = cashierState.cache.get(cashierState.period)?.students.find(student => student.id === button.dataset.cashierMonths);
    if (cashierCanChooseMonths(row)) cashierCollectDialog(row, cashierState.period);
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
  if (!cashierAllowed()) return;
  const saved = cashierState.intents.get(row.id);
  if (!saved && !cashierCanChooseMonths(row)) return;
  if (saved) ({ row, period } = saved);
  const previous = $("cashier-collect-dialog");
  if (previous) {
    if (previous.dataset.pending === "true") return;
    previous.remove();
  }
  const dialog = document.createElement("dialog");
  dialog.id = "cashier-collect-dialog";
  dialog.className = "cashier-dialog";
  dialog.setAttribute("aria-labelledby", "cashier-collect-title");
  const draft = saved?.draft || {
    stage: "amount", months: [], pages: new Map(), pageStart: period, loadStart: period,
    selected: new Set(), initialized: false, shortcutCount: 3, retryCount: 0, loading: true, loadError: "",
    amount: cashierAmount(row.balance), requestId: crypto.randomUUID(), intent: null,
    pending: false, attempted: false, uncertain: false, error: "", receipt: null, refreshError: "",
  };
  const canSelectMonth = month => !month.blockedReason && row.registrationStatus !== "Suspendu" && month.balance > 0;
  const selectedMonths = () => draft.months.filter(month => draft.selected.has(month.period) && canSelectMonth(month));
  const selectedTotal = () => selectedMonths().reduce((total, month) => total + month.balance, 0);
  const visibleMonths = () => (draft.pages.get(draft.pageStart) || []).map(period => draft.months.find(month => month.period === period)).filter(Boolean);
  const selectedSummary = () => selectedMonths().map(month => `<div><dt>${esc(cashierPeriodLabel(month.period))}</dt><dd>${esc(money(draft.selected.size === 1 ? draft.amount : month.balance))}</dd></div>`).join("");
  const close = () => { if (!draft.pending) dialog.close(); };
  const resetAttempt = () => {
    if (draft.attempted) {
      draft.requestId = crypto.randomUUID();
      draft.attempted = false;
      draft.intent = null;
    }
  };
  const changed = () => {
    if (draft.pending || draft.uncertain) return;
    resetAttempt();
    draft.amount = selectedTotal();
    draft.error = "";
    paint();
  };
  const monthPicker = () => {
    const visible = visibleMonths();
    const previous = cashierMonthOffset(draft.pageStart, -12) || (draft.pageStart !== "2000-01" ? "2000-01" : "");
    const next = cashierMonthOffset(draft.pageStart, 12);
    const elsewhere = selectedMonths().filter(month => !visible.some(item => item.period === month.period)).length;
    return `<fieldset class="cashier-month-picker"><legend>Mois à régler</legend><p class="cashier-note">Choisissez autant de mois que nécessaire, même sur plusieurs années. Les mois déjà réglés restent cochés et ne sont pas ajoutés au paiement.</p><div class="cashier-month-navigation"><button id="cashier-month-prev" class="secondary" type="button"${previous ? "" : " disabled"}>← Mois précédents</button><span id="cashier-month-page-label">${esc(cashierPeriodLabel(draft.pageStart))} – ${esc(cashierPeriodLabel(visible.at(-1)?.period || draft.pageStart))}</span><button id="cashier-month-next" class="secondary" type="button"${next ? "" : " disabled"}>Mois suivants →</button></div><div class="cashier-month-shortcuts"><button class="secondary" type="button" data-cashier-month-count="3">3 mois</button><button class="secondary" type="button" data-cashier-month-count="6">6 mois</button><button id="cashier-month-clear" class="secondary" type="button"${draft.selected.size ? "" : " disabled"}>Effacer les mois à régler</button></div><div class="cashier-month-custom-count"><label for="cashier-month-count">Nombre de mois à régler<input id="cashier-month-count" type="number" inputmode="numeric" min="1" max="${cashierMonthsRemaining(draft.pageStart)}" step="1" value="${draft.shortcutCount}" aria-describedby="cashier-month-count-help"></label><button id="cashier-month-count-apply" class="secondary" type="button">Sélectionner</button></div><p class="cashier-note" id="cashier-month-count-help">Les raccourcis remplacent votre sélection par les prochains mois disponibles à partir de ${esc(cashierPeriodLabel(draft.pageStart))}, jusqu’en décembre 2099.</p><div class="cashier-month-list">${visible.map(month => {
    const eligible = canSelectMonth(month);
    const selected = draft.selected.has(month.period);
    const settled = month.balance === 0 && month.fee > 0;
    const status = settled ? "Déjà réglé" : month.blockedReason ? "Paiement en cours" : month.balance === 0 ? "Sans frais" : month.paid > 0 ? "Partiellement payé" : "À payer";
    return `<label class="cashier-month-option${selected ? " selected" : ""}${settled ? " settled" : ""}${eligible ? "" : " unavailable"}"><input type="checkbox" name="periods" value="${esc(month.period)}" data-cashier-month="${esc(month.period)}"${selected || settled ? " checked" : ""}${eligible ? "" : " disabled"}><span class="cashier-month-name"><strong>${esc(cashierPeriodLabel(month.period))}</strong><small>${esc(status)}</small>${month.blockedReason ? `<small class="cashier-month-reason">${esc(month.blockedReason)}</small>` : ""}</span><span class="cashier-month-balance">${esc(money(month.balance))}</span></label>`;
  }).join("")}</div><p class="cashier-month-total" aria-live="polite"><span>${draft.selected.size} mois à régler${elsewhere ? ` · ${elsewhere} hors de cette page` : ""}</span><strong>Total restant : ${esc(money(selectedTotal()))}</strong></p></fieldset>`;
  };
  const paint = () => {
    dialog.dataset.pending = String(draft.pending);
    const receipt = draft.receipt;
    const multiple = draft.selected.size > 1;
    const monthly = selectedMonths()[0];
    const selectedLabels = selectedMonths().map(month => cashierPeriodLabel(month.period)).join(" · ");
    dialog.innerHTML = `<div class="dialog-head"><h2 id="cashier-collect-title">${receipt ? "Encaissement enregistré" : draft.stage === "confirm" ? "Confirmer le paiement reçu" : "Encaisser en espèces"}</h2><button class="icon-button" id="cashier-collect-close" type="button" aria-label="Fermer"${draft.pending ? " disabled" : ""}>×</button></div>
      <div class="cashier-dialog-student"><strong>${esc(row.name)}</strong><span>${esc(row.class)} · ${esc(row.centre || "Centre non renseigné")}</span><span>${esc(row.guardian || "Parent non renseigné")}${row.phone ? " · " + esc(row.phone) : ""}</span></div>
      ${receipt ? `<div class="cashier-success" role="status"><span aria-hidden="true">✓</span><div><strong>${esc(money(cashierAmount(receipt.amount)))}</strong><p>Reçu en présentiel pour ${esc(cashierPaymentMonths(receipt))}.</p></div></div><p class="cashier-receipt-reference">Référence : ${esc(receipt.id)}</p><p class="cashier-note">Un seul reçu couvre les mois sélectionnés. Vous pouvez le télécharger pour l’imprimer ou le partager au parent.</p>${draft.refreshError ? `<p class="cashier-dialog-error" role="alert">${esc(draft.refreshError)}</p>` : ""}<div class="cashier-dialog-receipt-actions"><button id="cashier-success-pdf" class="primary" type="button">Télécharger le reçu PDF</button><button id="cashier-success-share" class="secondary" type="button">Partager le PDF</button><button id="cashier-success-whatsapp" class="secondary" type="button">Préparer WhatsApp</button></div><button id="cashier-collect-done" class="secondary cashier-dialog-done" type="button">Terminer</button>`
        : draft.loading ? '<p class="cashier-loading" role="status">Chargement des mensualités de cet élève…</p>'
          : draft.loadError ? `<p class="cashier-dialog-error" role="alert">${esc(draft.loadError)}</p><div class="cashier-dialog-buttons"><button id="cashier-collect-cancel" class="secondary" type="button">Annuler</button><button id="cashier-month-retry" class="primary" type="button">Réessayer</button></div>`
            : draft.stage === "amount" ? `${monthPicker()}${draft.selected.size === 1 ? `<dl class="cashier-dialog-summary"><div><dt>Mensualité</dt><dd>${esc(money(monthly.fee))}</dd></div><div><dt>Déjà réglé</dt><dd>${esc(money(monthly.paid))}</dd></div><div><dt>Reste à payer</dt><dd>${esc(money(monthly.balance))}</dd></div></dl>` : ""}<form id="cashier-amount-form"><label for="cashier-amount">Montant remis en espèces (FCFA)</label><input id="cashier-amount" name="amount" type="number" inputmode="numeric" min="1" max="${selectedTotal()}" step="1" value="${draft.amount}"${multiple ? " readonly" : ""}${draft.selected.size ? "" : " disabled"} required><p class="cashier-note">${multiple ? "Le paiement de plusieurs mois règle tout le montant restant des mois cochés. Un seul reçu sera créé." : "Pour un seul mois, vous pouvez enregistrer un paiement partiel. Le statut « Payé » apparaît lorsque toute la mensualité est réglée."}</p><p class="cashier-dialog-error" id="cashier-amount-error" role="alert">${esc(draft.error)}</p><div class="cashier-dialog-buttons"><button id="cashier-collect-cancel" class="secondary" type="button">Annuler</button><button class="primary" type="submit"${draft.selected.size ? "" : " disabled"}>Vérifier l’encaissement</button></div></form>`
              : `<div class="cashier-confirm-amount"><span>Argent reçu en espèces</span><strong>${esc(money(draft.amount))}</strong><p>${draft.selected.size} mois · un seul reçu</p></div><dl class="cashier-dialog-summary cashier-confirm-months">${selectedSummary()}<div><dt>Total reçu</dt><dd>${esc(money(draft.amount))}</dd></div></dl><p class="cashier-confirm-note">${multiple ? "Ce paiement règle le reste de tous les mois cochés." : draft.amount < monthly.balance ? `Paiement partiel : il restera ${esc(money(monthly.balance - draft.amount))} à régler pour ${esc(selectedLabels)}.` : "Ce paiement règle le reste de la mensualité."}</p><p class="cashier-note">Confirmez uniquement après avoir reçu l’argent. Un reçu sera créé et le règlement sera visible par le responsable.</p>${draft.error ? `<p class="cashier-dialog-error" role="alert">${esc(draft.error)}</p>` : ""}${draft.uncertain ? '<p class="cashier-note">La réponse du serveur n’a pas été reçue. Réessayez cette même confirmation pour retrouver le paiement sans créer un second encaissement. Les mois et le montant resteront identiques.</p>' : ""}<div class="cashier-dialog-buttons">${draft.uncertain ? "" : `<button id="cashier-collect-back" class="secondary" type="button"${draft.pending ? " disabled" : ""}>Modifier le montant et les mois</button>`}<button id="cashier-collect-confirm" class="primary" type="button"${draft.pending ? " disabled" : ""}>${draft.pending ? "Enregistrement…" : draft.uncertain ? "Réessayer la confirmation" : "Confirmer l’encaissement"}</button></div>`}`;
    $("cashier-collect-close").onclick = close;
    if (receipt) {
      $("cashier-collect-done").onclick = close;
      for (const action of ["pdf", "share", "whatsapp"]) $("cashier-success-" + action).onclick = event => cashierReceiptAction(action, event.currentTarget, receipt, row);
    } else if (draft.loading) {
      return;
    } else if (draft.loadError) {
      $("cashier-collect-cancel").onclick = close;
      $("cashier-month-retry").onclick = () => draft.retryCount ? selectUpcoming(draft.retryCount) : loadMonths(draft.loadStart);
    } else if (draft.stage === "amount") {
      $("cashier-collect-cancel").onclick = close;
      dialog.querySelectorAll("[data-cashier-month]").forEach(input => input.onchange = () => {
        if (draft.pending || draft.uncertain) return;
        const month = draft.months.find(item => item.period === input.value);
        if (!month || !canSelectMonth(month)) return;
        if (input.checked) draft.selected.add(month.period);
        else draft.selected.delete(month.period);
        changed();
        dialog.querySelector(`[data-cashier-month="${input.value}"]`)?.focus();
      });
      dialog.querySelectorAll("[data-cashier-month-count]").forEach(button => button.onclick = () => selectUpcoming(Number(button.dataset.cashierMonthCount)));
      $("cashier-month-prev").onclick = () => loadMonths(cashierMonthOffset(draft.pageStart, -12) || "2000-01");
      $("cashier-month-next").onclick = () => loadMonths(cashierMonthOffset(draft.pageStart, 12));
      $("cashier-month-count").oninput = event => { draft.shortcutCount = event.target.value; };
      $("cashier-month-count-apply").onclick = () => {
        const input = $("cashier-month-count");
        if (input.reportValidity()) selectUpcoming(Number(input.value));
      };
      $("cashier-month-clear").onclick = () => {
        if (draft.pending || draft.uncertain) return;
        draft.selected.clear();
        changed();
      };
      $("cashier-amount").oninput = event => {
        if (draft.pending || draft.uncertain || draft.selected.size !== 1) return;
        const amount = Number(event.target.value);
        if (amount !== draft.amount && draft.attempted) {
          draft.requestId = crypto.randomUUID();
          draft.attempted = false;
          draft.intent = null;
        }
        draft.amount = amount;
      };
      $("cashier-amount-form").onsubmit = event => {
        event.preventDefault();
        if (draft.pending || draft.uncertain) return;
        const amount = Number($("cashier-amount").value);
        const total = selectedTotal();
        if (!draft.selected.size || selectedMonths().length !== draft.selected.size) {
          $("cashier-amount-error").textContent = "Cochez au moins un mois disponible à régler.";
          return;
        }
        if (!Number.isSafeInteger(amount) || amount <= 0 || amount > total || (draft.selected.size > 1 && amount !== total)) {
          $("cashier-amount-error").textContent = draft.selected.size > 1 ? "Le montant doit correspondre au total restant des mois cochés." : "Indiquez un montant entier entre 1 FCFA et le reste à payer.";
          return;
        }
        if (amount !== draft.amount && draft.attempted) {
          draft.requestId = crypto.randomUUID();
          draft.attempted = false;
          draft.intent = null;
        }
        draft.amount = amount;
        draft.stage = "confirm";
        draft.error = "";
        paint();
        $("cashier-collect-confirm").focus();
      };
    } else {
      if ($("cashier-collect-back")) $("cashier-collect-back").onclick = () => {
        if (draft.pending || draft.uncertain) return;
        draft.stage = "amount";
        draft.error = "";
        paint();
      };
      $("cashier-collect-confirm").onclick = submit;
    }
  };
  const fetchMonths = async start => {
    if (draft.pages.has(start)) return (draft.pages.get(start) || []).map(period => draft.months.find(month => month.period === period));
    const result = await schoolAPI.request(`/api/cashier/students/${encodeURIComponent(row.id)}/months?start=${encodeURIComponent(start)}`);
    const expected = Math.min(12, cashierMonthsRemaining(start));
    if (result.student?.id !== row.id || result.start !== start || !Array.isArray(result.months) || result.months.length !== expected) {
      throw new Error("Les mensualités n’ont pas pu être chargées. Réessayez.");
    }
    const months = result.months.slice().sort((a, b) => String(a.period).localeCompare(String(b.period)));
    for (const [index, month] of months.entries()) {
      if (month.period !== cashierMonthOffset(start, index) || [month.fee, month.paid, month.balance].some(amount => !Number.isSafeInteger(amount) || amount < 0)) {
        throw new Error("Les mensualités n’ont pas pu être chargées. Réessayez.");
      }
    }
    Object.assign(row, result.student);
    const combined = new Map(draft.months.map(month => [month.period, month]));
    for (const month of months) combined.set(month.period, month);
    draft.months = [...combined.values()].sort((a, b) => a.period.localeCompare(b.period));
    draft.pages.set(start, months.map(month => month.period));
    return months;
  };
  const removeUnavailable = () => {
    const selected = new Set(selectedMonths().map(month => month.period));
    if (selected.size !== draft.selected.size) {
      draft.selected = selected;
      draft.amount = selectedTotal();
      resetAttempt();
    }
  };
  const loadMonths = async (start = draft.pageStart) => {
    if (!start || draft.pending || draft.uncertain) return;
    draft.pageStart = start;
    draft.loadStart = start;
    draft.retryCount = 0;
    draft.loading = true;
    draft.loadError = "";
    paint();
    try {
      await fetchMonths(start);
      removeUnavailable();
      if (!draft.initialized) {
        draft.selected = new Set(draft.months.filter(month => month.period === period && canSelectMonth(month)).map(month => month.period));
        draft.amount = selectedTotal();
        draft.initialized = true;
      }
    } catch (err) {
      if (err.status === 401) location.assign("/connexion.html");
      draft.loadError = err.message || "Les mensualités sont indisponibles. Réessayez.";
    } finally {
      draft.loading = false;
      if (dialog.isConnected) {
        paint();
        if ($("cashier-amount") && !$("cashier-amount").disabled) {
          $("cashier-amount").focus();
          $("cashier-amount").select();
        }
      }
    }
  };
  const selectUpcoming = async count => {
    if (draft.pending || draft.uncertain || draft.loading || !Number.isSafeInteger(count) || count < 1) return;
    draft.shortcutCount = count;
    draft.retryCount = count;
    draft.loading = true;
    draft.loadError = "";
    draft.error = "";
    paint();
    try {
      const selected = [];
      let start = draft.pageStart;
      while (start && selected.length < count) {
        const months = await fetchMonths(start);
        for (const month of months) {
          if (canSelectMonth(month)) selected.push(month.period);
          if (selected.length === count) break;
        }
        start = cashierMonthOffset(start, 12);
      }
      resetAttempt();
      draft.selected = new Set(selected);
      draft.amount = selectedTotal();
      if (selected.length < count) draft.error = `${selected.length} mois disponible(s) à régler jusqu’en décembre 2099. Vérifiez les mois sélectionnés.`;
    } catch (err) {
      if (err.status === 401) location.assign("/connexion.html");
      draft.loadError = err.message || "Les mensualités sont indisponibles. Réessayez.";
    } finally {
      removeUnavailable();
      draft.loading = false;
      if (dialog.isConnected) paint();
    }
  };
  const submit = async () => {
    if (draft.pending || draft.receipt || !cashierAllowed()) return;
    if (!draft.intent) {
      const periods = [...draft.selected].sort();
      draft.intent = {
        requestId: draft.requestId, student: row.id,
        ...(periods.length === 1 ? { period: periods[0] } : { periods }),
        amount: draft.amount,
      };
    }
    draft.pending = true;
    draft.attempted = true;
    draft.error = "";
    paint();
    try {
      const receipt = await schoolAPI.request("/api/cashier/payments", "POST", draft.intent);
      const periods = draft.intent.periods || [draft.intent.period];
      if (!receipt || !receipt.id || receipt.student !== row.id || receipt.period !== periods[0] || Number(receipt.amount) !== draft.intent.amount || cashierPaymentPeriods(receipt).join(",") !== periods.join(",")) {
        throw new Error("La réponse du serveur est incomplète. Réessayez la confirmation pour retrouver votre reçu.");
      }
      draft.receipt = receipt;
      draft.uncertain = false;
      cashierState.intents.delete(row.id);
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
      if (draft.uncertain) cashierState.intents.set(row.id, { row, period, draft });
      else {
        cashierState.intents.delete(row.id);
        cashierReload();
      }
    } finally {
      draft.pending = false;
      if (dialog.isConnected) paint();
      cashierUpdateResults();
    }
  };
  dialog.oncancel = event => { if (draft.pending) event.preventDefault(); };
  dialog.onclose = () => {
    dialog.remove();
    if (draft.uncertain) cashierReload();
  };
  document.body.append(dialog);
  paint();
  dialog.showModal();
  if (saved) $("cashier-collect-confirm").focus();
  else loadMonths();
}
