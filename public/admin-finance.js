"use strict";

sections.balances = ["◷", "Mensualités"];

const monthlyBalanceState = {
  period: monthlyBalanceCurrentPeriod(),
  class: "",
  centre: "",
  status: "",
  query: "",
  revision: 0,
  cache: new Map(),
};
const monthlyBalanceStatuses = ["À régler", "Partiel", "Réglé", "Avance", "Non facturé"];

function monthlyBalanceCurrentPeriod() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// Call after refresh(): server writes can change fees, enrollment and payments.
function invalidateMonthlyBalances() {
  monthlyBalanceState.revision += 1;
  monthlyBalanceState.cache.clear();
}

function monthlyBalanceAmount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function monthlyBalancePeriodLabel(period) {
  const [year, month] = period.split("-").map(Number);
  return new Date(year, month - 1, 1, 12).toLocaleDateString("fr-FR", {
    month: "long", year: "numeric",
  });
}

function monthlyBalanceOptions(values, selected, label) {
  return `<option value="">${esc(label)}</option>${[...new Set(values.filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "fr"))
    .map(value => `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(value)}</option>`)
    .join("")}`;
}

function monthlyBalancesPage() {
  if (role !== "admin") return '<div class="empty-note">Cet espace est réservé à l’administration.</div>';
  const state = monthlyBalanceState;
  const classes = [...catalogue.levels.map(([name]) => name), ...db.students.map(row => row.class)];
  const centres = [...catalogue.centres, ...db.students.map(row => row.centre)];
  return `<div class="finance-intro"><div><h2>Chaque mensualité, clairement.</h2><p>Retrouvez les sommes reçues, les restes à régler et préparez vos rappels aux familles.</p><p class="helper">Le montant attendu utilise le tarif et le statut actuels du dossier. Ce suivi ne remplace pas des factures historiques.</p></div></div>
    <div class="finance-filters">
      <label>Mois concerné<input id="finance-period" type="month" value="${esc(state.period)}" required></label>
      <label>Classe<select id="finance-class">${monthlyBalanceOptions(classes, state.class, "Toutes les classes")}</select></label>
      <label>Centre<select id="finance-centre">${monthlyBalanceOptions(centres, state.centre, "Tous les centres")}</select></label>
      <label>Situation<select id="finance-status"><option value="">Toutes les situations</option>${monthlyBalanceStatuses.map(status => `<option${status === state.status ? " selected" : ""}>${esc(status)}</option>`).join("")}</select></label>
      <label class="finance-search-label">Élève ou responsable<input id="finance-search" type="search" value="${esc(state.query)}" placeholder="Nom, responsable ou téléphone…"></label>
      <button class="secondary" id="finance-clear-filters">Réinitialiser</button>
    </div>
    <div id="finance-results" aria-live="polite">${monthlyBalanceResults()}</div>`;
}

function monthlyBalanceFilteredRows(rows) {
  const state = monthlyBalanceState;
  const term = state.query.trim().toLocaleLowerCase("fr");
  return rows.filter(row =>
    (!state.class || row.class === state.class) &&
    (!state.centre || row.centre === state.centre) &&
    (!state.status || row.status === state.status) &&
    (!term || [row.name, row.guardian, row.phone, row.group].some(value => String(value || "").toLocaleLowerCase("fr").includes(term)))
  ).sort((a, b) => monthlyBalanceAmount(b.balance) - monthlyBalanceAmount(a.balance) || String(a.name).localeCompare(String(b.name), "fr"));
}

function monthlyBalanceResults() {
  const entry = monthlyBalanceState.cache.get(monthlyBalanceState.period);
  if (!entry || entry.loading) return '<div class="panel finance-loading" role="status">Chargement des mensualités…</div>';
  if (entry.error) return `<div class="panel finance-error"><p role="alert">${esc(entry.error)}</p><button class="secondary" id="finance-retry">Réessayer</button></div>`;
  const rows = monthlyBalanceFilteredRows(entry.rows);
  const enrolled = rows.filter(row => (row.registrationStatus || "Inscrit") === "Inscrit");
  const sum = field => enrolled.reduce((total, row) => total + monthlyBalanceAmount(row[field]), 0);
  const metrics = [
    ["Montant attendu", money(sum("fee")), `${enrolled.length} élève(s) inscrit(s)`],
    ["Montant reçu", money(sum("paid")), "Mensualité sélectionnée · hors tests"],
    ["Reste à régler", money(sum("balance")), `${enrolled.filter(row => monthlyBalanceAmount(row.balance) > 0).length} dossier(s) à suivre`],
    ["Avances", money(sum("advance")), "Excédents sur le mois sélectionné"],
  ];
  return `<div class="finance-metrics">${metrics.map(([label, amount, detail]) => `<div class="stat"><span class="stat-label">${esc(label)}</span><strong>${esc(amount)}</strong><small>${esc(detail)}</small></div>`).join("")}</div>
    <section class="panel finance-ledger" aria-labelledby="finance-ledger-title">
      <div class="panel-head"><div><h2 id="finance-ledger-title">${esc(monthlyBalancePeriodLabel(monthlyBalanceState.period))}</h2><p>${rows.length} dossier(s) · les restes à régler en premier</p></div><button class="secondary" id="finance-reload">Actualiser</button></div>
      <p class="finance-note">Les montants attendus suivent le tarif et le statut actuels du dossier. Les préinscriptions et dossiers suspendus ne sont pas facturés. Les paiements de test sont exclus.</p>
      ${rows.length ? `<div class="finance-table-scroll" tabindex="0" role="region" aria-label="Tableau des mensualités"><table class="finance-table"><thead><tr><th>Élève</th><th>Classe / centre</th><th>Attendu</th><th>Reçu</th><th>Reste</th><th>Situation</th><th>Actions</th></tr></thead><tbody>${rows.map(monthlyBalanceRow).join("")}</tbody></table></div>` : '<div class="empty-note">Aucun dossier ne correspond à ces filtres.</div>'}
    </section>`;
}

function monthlyBalanceRow(row) {
  const balance = monthlyBalanceAmount(row.balance);
  const enrolled = (row.registrationStatus || "Inscrit") === "Inscrit";
  const statusClass = { "À régler": "due", "Partiel": "partial", "Réglé": "settled", "Avance": "advance", "Non facturé": "unbilled" }[row.status] || "unbilled";
  return `<tr><td><strong>${esc(row.name)}</strong><small>${esc(row.guardian || "Responsable non renseigné")}</small>${row.phone ? `<small>${esc(row.phone)}</small>` : ""}</td>
    <td>${esc(row.class)}<small>${esc(row.centre || "Centre non renseigné")}</small></td>
    <td class="finance-amount">${esc(money(monthlyBalanceAmount(row.fee)))}</td>
    <td class="finance-amount">${esc(money(monthlyBalanceAmount(row.paid)))}</td>
    <td class="finance-amount${balance > 0 ? " finance-due" : ""}">${esc(money(balance))}${monthlyBalanceAmount(row.advance) > 0 ? `<small>Avance : ${esc(money(monthlyBalanceAmount(row.advance)))}</small>` : ""}</td>
    <td><span class="finance-status ${statusClass}">${esc(row.status)}</span>${!enrolled ? `<small>${esc(row.registrationStatus || "Inscrit")}</small>` : ""}</td>
    <td><div class="finance-actions">${balance > 0 ? `<button class="secondary" data-finance-reminder="${esc(row.student)}">Préparer un rappel</button>` : ""}<button class="secondary" data-finance-payment="${esc(row.student)}">Enregistrer un règlement</button><a class="secondary finance-report" href="/api/admin/students/${encodeURIComponent(row.student)}/report.pdf" download>Bulletin PDF</a></div></td></tr>`;
}

async function monthlyBalanceFetch() {
  if (role !== "admin" || page !== "balances") return;
  const state = monthlyBalanceState;
  const period = state.period;
  if (state.cache.has(period)) return;
  const revision = state.revision;
  const entry = { loading: true, rows: [], error: "" };
  state.cache.set(period, entry);
  try {
    const response = await schoolAPI.request(`/api/admin/monthly-balances?period=${encodeURIComponent(period)}`);
    if (response.period !== period || !Array.isArray(response.rows)) throw new Error("Réponse des mensualités invalide. Réessayez.");
    entry.rows = response.rows;
  } catch (err) {
    if (err.status === 401) {
      location.assign("/connexion.html");
      return;
    }
    entry.error = err.message || "Impossible de charger les mensualités. Réessayez.";
  } finally {
    entry.loading = false;
    // A newer refresh invalidates this request, and navigation never changes pages here.
    if (revision === state.revision && state.cache.get(period) === entry && role === "admin" && page === "balances" && state.period === period) monthlyBalanceUpdateResults();
  }
}

function monthlyBalanceUpdateResults() {
  const results = $("finance-results");
  if (!results || page !== "balances" || role !== "admin") return;
  results.innerHTML = monthlyBalanceResults();
  bindMonthlyBalanceActions();
}

function bindMonthlyBalanceActions() {
  const reload = () => {
    monthlyBalanceState.cache.delete(monthlyBalanceState.period);
    monthlyBalanceUpdateResults();
    monthlyBalanceFetch();
  };
  if ($("finance-reload")) $("finance-reload").onclick = reload;
  if ($("finance-retry")) $("finance-retry").onclick = reload;
  document.querySelectorAll("[data-finance-reminder]").forEach(button => button.onclick = () => {
    const rows = monthlyBalanceState.cache.get(monthlyBalanceState.period)?.rows || [];
    const row = rows.find(value => value.student === button.dataset.financeReminder);
    if (row && monthlyBalanceAmount(row.balance) > 0) monthlyBalanceReminder(row, monthlyBalanceState.period);
  });
  document.querySelectorAll("[data-finance-payment]").forEach(button => button.onclick = () => {
    openPaymentForm(button.dataset.financePayment, monthlyBalanceState.period);
  });
}

function bindMonthlyBalances() {
  if (role !== "admin" || page !== "balances") return;
  $("finance-period").onchange = event => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) {
      event.target.value = monthlyBalanceState.period;
      return;
    }
    monthlyBalanceState.period = event.target.value;
    monthlyBalanceUpdateResults();
    monthlyBalanceFetch();
  };
  for (const key of ["class", "centre", "status"]) $("finance-" + key).onchange = event => {
    monthlyBalanceState[key] = event.target.value;
    monthlyBalanceUpdateResults();
  };
  $("finance-search").oninput = event => {
    monthlyBalanceState.query = event.target.value;
    monthlyBalanceUpdateResults();
  };
  $("finance-clear-filters").onclick = () => {
    Object.assign(monthlyBalanceState, { class: "", centre: "", status: "", query: "" });
    render();
  };
  bindMonthlyBalanceActions();
  monthlyBalanceFetch();
}

function monthlyBalanceReminder(row, period) {
  const previous = $("finance-reminder-dialog");
  if (previous) previous.remove();
  const message = `Bonjour${row.guardian ? " " + row.guardian : ""}, nous vous rappelons que les cours de renforcement de ${row.name} pour ${monthlyBalancePeriodLabel(period)} sont de ${money(monthlyBalanceAmount(row.fee))}. Nous avons reçu ${money(monthlyBalanceAmount(row.paid))}. Le reste à régler est de ${money(monthlyBalanceAmount(row.balance))}. Merci de contacter l’établissement pour organiser votre règlement. Si vous avez déjà réglé cette somme, merci de nous transmettre votre justificatif.`;
  const dialog = document.createElement("dialog");
  dialog.id = "finance-reminder-dialog";
  dialog.className = "finance-reminder-dialog";
  dialog.setAttribute("aria-labelledby", "finance-reminder-title");
  dialog.innerHTML = `<div class="dialog-head"><h2 id="finance-reminder-title">Préparer un rappel</h2><button class="icon-button" id="finance-reminder-close" type="button" aria-label="Fermer">×</button></div>
    <p class="finance-reminder-recipient"><strong>${esc(row.name)}</strong>${row.phone ? `<br>Responsable : ${esc(row.phone)}` : "<br>Aucun téléphone renseigné dans le dossier."}</p>
    <label for="finance-reminder-message">Message à relire et à adapter</label>
    <textarea id="finance-reminder-message" rows="8">${esc(message)}</textarea>
    <p class="helper">Ce message est un brouillon. Aucun rappel n’est envoyé automatiquement. Copiez-le pour le transmettre vous-même à la famille.</p>
    <p id="finance-copy-status" role="status"></p>
    <div class="finance-reminder-buttons"><button class="primary" type="button" id="finance-reminder-copy">Copier le message</button><button class="secondary" type="button" id="finance-reminder-cancel">Fermer</button></div>`;
  document.body.append(dialog);
  dialog.onclose = () => dialog.remove();
  $("finance-reminder-close").onclick = $("finance-reminder-cancel").onclick = () => dialog.close();
  $("finance-reminder-copy").onclick = async () => {
    const text = $("finance-reminder-message");
    const feedback = $("finance-copy-status");
    try {
      await navigator.clipboard.writeText(text.value);
      feedback.textContent = "Message copié. Vous pouvez le transmettre à la famille.";
    } catch (_) {
      text.focus();
      text.select();
      feedback.textContent = "La copie automatique est indisponible. Le texte est sélectionné : utilisez Ctrl + C (ou Copier sur votre téléphone).";
    }
  };
  dialog.showModal();
}
