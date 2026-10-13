"use strict";

sections.dailyAttendance = ["✓", "Présences du jour"];

function dailyAttendanceToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

const dailyAttendanceState = {
  date: dailyAttendanceToday(), centre: "", class: "", student: "",
  cache: new Map(), drafts: new Map(), generation: 0, saving: false,
  error: "", feedback: "", conflict: false,
};

function dailyAttendanceAllowed() {
  return role === "admin" || role === "cashier";
}

function hasDailyDrafts() {
  return dailyAttendanceState.drafts.size > 0 || dailyAttendanceState.saving;
}
window.hasDailyDrafts = hasDailyDrafts;

function dailyAttendanceKey() {
  return JSON.stringify([dailyAttendanceState.date, dailyAttendanceState.centre, dailyAttendanceState.class]);
}

function invalidateDailyAttendance() {
  dailyAttendanceState.generation += 1;
  // A background data refresh must not replace a roster that still has unsaved marks.
  const current = hasDailyDrafts() ? dailyAttendanceState.cache.get(dailyAttendanceKey()) : null;
  dailyAttendanceState.cache.clear();
  if (current) dailyAttendanceState.cache.set(dailyAttendanceKey(), current);
}

function dailyAttendanceOptions(values, selected, placeholder) {
  const choices = [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), "fr", { numeric: true }));
  return `<option value="">${esc(placeholder)}</option>${choices.map(value => `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(value)}</option>`).join("")}`;
}

function dailyAttendanceValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T12:00:00");
  return Number.isFinite(parsed.getTime()) && `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}` === value;
}

function dailyAttendancePage() {
  if (!dailyAttendanceAllowed()) return '<div class="empty-note">Les présences du jour sont réservées au caissier et au responsable.</div>';
  return `<section class="daily-attendance-intro"><div><span class="daily-attendance-eyebrow">Pointage par école et par classe</span><h2>Qui est présent aujourd’hui ?</h2><p>Choisissez l’école puis la classe. Cochez Présent ou Absent devant chaque élève et enregistrez le pointage.</p></div><span class="daily-attendance-access">Caissier · Responsable</span></section>
    <section id="daily-attendance-form" class="daily-attendance-shell" data-crs-unsaved="${hasDailyDrafts() ? "true" : "false"}">
      <div class="daily-attendance-filters"><label for="daily-attendance-date">Jour du cours<input id="daily-attendance-date" type="date" value="${esc(dailyAttendanceState.date)}" required${dailyAttendanceState.saving ? " disabled" : ""}></label>
      <label for="daily-attendance-centre">École<select id="daily-attendance-centre" required${dailyAttendanceState.saving ? " disabled" : ""}>${dailyAttendanceOptions(catalogue.centres, dailyAttendanceState.centre, "Choisir une école")}</select></label>
      <label for="daily-attendance-class">Classe<select id="daily-attendance-class" required${!dailyAttendanceState.centre || dailyAttendanceState.saving ? " disabled" : ""}>${dailyAttendanceOptions(catalogue.levels.map(([name]) => name), dailyAttendanceState.class, "Choisir une classe")}</select></label></div>
      <div id="daily-attendance-results" aria-live="polite">${dailyAttendanceResults()}</div>
    </section>`;
}

function dailyAttendanceRows() {
  return dailyAttendanceState.cache.get(dailyAttendanceKey())?.students || [];
}

function dailyAttendanceStatus(row) {
  return dailyAttendanceState.drafts.has(row.id) ? dailyAttendanceState.drafts.get(row.id).status : row.status;
}

function dailyAttendanceTotals(rows, drafts) {
  const result = { present: 0, absent: 0, unmarked: 0 };
  for (const row of rows) {
    const status = drafts ? dailyAttendanceStatus(row) : row.status;
    if (status === "Présent") result.present += 1;
    else if (status === "Absent") result.absent += 1;
    else result.unmarked += 1;
  }
  return result;
}

function dailyAttendanceResults() {
  if (!dailyAttendanceState.centre || !dailyAttendanceState.class) return '<div class="panel daily-attendance-empty">Choisissez une école et une classe pour afficher la liste des élèves.</div>';
  const entry = dailyAttendanceState.cache.get(dailyAttendanceKey());
  if (!entry || entry.loading) return '<div class="panel daily-attendance-empty" role="status">Chargement des élèves et des présences…</div>';
  if (entry.error) return `<div class="panel daily-attendance-empty"><p role="alert">${esc(entry.error)}</p><button id="daily-attendance-retry" type="button" class="secondary">Réessayer</button></div>`;
  const rows = entry.students;
  const saved = dailyAttendanceTotals(rows, false), preview = dailyAttendanceTotals(rows, true);
  const changed = dailyAttendanceState.drafts.size;
  const visible = dailyAttendanceState.student ? rows.filter(row => row.id === dailyAttendanceState.student) : rows;
  return `<div class="daily-attendance-metrics">${[["Présents", preview.present, "present"], ["Absents", preview.absent, "absent"], ["Non renseignés", preview.unmarked, "unmarked"]].map(([name, count, tone]) => `<div class="daily-attendance-metric ${tone}"><span>${esc(name)}</span><strong>${count}</strong></div>`).join("")}</div>
    <p class="daily-attendance-summary">${changed ? `Aperçu avant enregistrement · Enregistré sur le serveur : ${saved.present} présent(s), ${saved.absent} absent(s), ${saved.unmarked} non renseigné(s).` : `Pointage enregistré : ${saved.present} présent(s), ${saved.absent} absent(s), ${saved.unmarked} non renseigné(s).`}</p>
    <section class="panel daily-attendance-roster"><div class="daily-attendance-list-head"><div><h2>${esc(dailyAttendanceState.class)}</h2><p>${esc(dailyAttendanceState.centre)} · ${rows.length} élève(s)</p></div><button id="daily-attendance-reload" type="button" class="secondary"${changed || dailyAttendanceState.saving ? " disabled" : ""}>Actualiser la liste</button></div>
      ${rows.length ? `<label class="daily-attendance-pupil-picker" for="daily-attendance-student">Élève<select id="daily-attendance-student"${dailyAttendanceState.saving ? " disabled" : ""}><option value="">Toute la classe</option>${rows.map(row => `<option value="${esc(row.id)}"${dailyAttendanceState.student === row.id ? " selected" : ""}>${esc(row.name)}</option>`).join("")}</select></label><div class="daily-attendance-list">${visible.map(dailyAttendancePupilRow).join("")}</div>` : '<div class="daily-attendance-empty">Aucun élève actif dans cette école et cette classe. Le responsable peut vérifier les dossiers.</div>'}
    </section>
    <div class="daily-attendance-savebar"><div><strong id="daily-attendance-draft-count">${changed} modification(s) à enregistrer</strong><p>Aucun élève n’est marqué absent automatiquement.</p></div><div class="daily-attendance-save-actions"><button id="daily-attendance-discard" class="secondary" type="button"${!changed || dailyAttendanceState.saving ? " disabled" : ""}>Abandonner les modifications</button><button id="daily-attendance-save" class="primary" type="button"${!changed || dailyAttendanceState.saving ? " disabled" : ""}>${dailyAttendanceState.saving ? "Enregistrement…" : "Enregistrer les présences"}</button></div></div>
    ${dailyAttendanceState.error ? `<div class="daily-attendance-error" role="alert"><p>${esc(dailyAttendanceState.error)}</p>${dailyAttendanceState.conflict ? '<p>Vos choix sont conservés. Pour consulter les dernières présences, abandonnez les modifications puis actualisez la liste avant de recommencer.</p>' : ""}</div>` : ""}
    ${dailyAttendanceState.feedback ? `<p class="daily-attendance-feedback" role="status">${esc(dailyAttendanceState.feedback)}</p>` : ""}`;
}

function dailyAttendancePupilRow(row) {
  const status = dailyAttendanceStatus(row);
  const changed = dailyAttendanceState.drafts.has(row.id);
  const options = [["Présent", "Présent", "present"], ["Absent", "Absent", "absent"], ["", "Non renseigné", "unmarked"]];
  return `<article class="daily-attendance-pupil${changed ? " daily-attendance-edited" : ""}" data-daily-student="${esc(row.id)}"><div class="daily-attendance-pupil-name"><strong>${esc(row.name)}</strong>${row.registrationStatus === "Préinscription" ? '<small>Préinscription</small>' : ""}${changed ? '<small class="daily-attendance-pending">À enregistrer</small>' : ""}</div>
    <fieldset class="daily-attendance-statuses"><legend class="daily-attendance-sr-only">Présence de ${esc(row.name)}</legend>${options.map(([value, label, tone]) => `<label class="daily-attendance-status ${tone}${(status || "") === value ? " selected" : ""}"><input type="radio" name="daily-status-${esc(row.id)}" data-daily-status="${esc(row.id)}" value="${esc(value)}"${(status || "") === value ? " checked" : ""}${dailyAttendanceState.saving ? " disabled" : ""}><span>${esc(label)}</span></label>`).join("")}</fieldset></article>`;
}

function dailyAttendanceUpdateResults() {
  if (!dailyAttendanceAllowed() || page !== "dailyAttendance" || !$("daily-attendance-results")) return;
  $("daily-attendance-results").innerHTML = dailyAttendanceResults();
  if ($("daily-attendance-form")) $("daily-attendance-form").dataset.crsUnsaved = hasDailyDrafts() ? "true" : "false";
  for (const name of ["date", "centre", "class"]) {
    const input = $("daily-attendance-" + name);
    if (input) input.disabled = dailyAttendanceState.saving || (name === "class" && !dailyAttendanceState.centre);
  }
  bindDailyAttendanceResults();
}

async function dailyAttendanceFetch() {
  if (!dailyAttendanceAllowed() || page !== "dailyAttendance" || !dailyAttendanceState.centre || !dailyAttendanceState.class) return;
  const key = dailyAttendanceKey();
  if (dailyAttendanceState.cache.has(key)) return;
  const generation = dailyAttendanceState.generation;
  const entry = { loading: true, error: "", students: [] };
  dailyAttendanceState.cache.set(key, entry);
  const params = new URLSearchParams({ date: dailyAttendanceState.date, centre: dailyAttendanceState.centre, class: dailyAttendanceState.class });
  try {
    const result = await schoolAPI.request(`/api/cashier/attendance?${params}`);
    if (!Array.isArray(result.students) || result.date !== params.get("date") || result.centre !== params.get("centre") || result.class !== params.get("class")) throw new Error("La liste des présences est indisponible. Réessayez.");
    entry.students = result.students.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), "fr", { numeric: true }));
    if (dailyAttendanceKey() === key && dailyAttendanceState.student && !entry.students.some(row => row.id === dailyAttendanceState.student)) dailyAttendanceState.student = "";
  } catch (err) {
    if (err.status === 401) { location.assign("/connexion.html?espace=caisse"); return; }
    entry.error = err.message || "La liste des présences est indisponible. Réessayez.";
  } finally {
    entry.loading = false;
    if (generation === dailyAttendanceState.generation && dailyAttendanceState.cache.get(key) === entry && dailyAttendanceKey() === key) dailyAttendanceUpdateResults();
  }
}

function dailyAttendanceReload() {
  if (hasDailyDrafts()) return;
  dailyAttendanceState.cache.delete(dailyAttendanceKey());
  dailyAttendanceState.error = "";
  dailyAttendanceState.conflict = false;
  dailyAttendanceUpdateResults();
  dailyAttendanceFetch();
}

function bindDailyAttendance() {
  if (!dailyAttendanceAllowed() || page !== "dailyAttendance") return;
  for (const name of ["date", "centre", "class"]) {
    const input = $("daily-attendance-" + name);
    if (!input) continue;
    input.onchange = event => {
      const previous = dailyAttendanceState[name];
      if (hasDailyDrafts()) {
        event.target.value = previous;
        toast("Enregistrez les présences ou abandonnez les modifications avant de changer de date, d’école ou de classe.");
        return;
      }
      if (name === "date" && !dailyAttendanceValidDate(event.target.value)) { event.target.value = previous; return; }
      dailyAttendanceState[name] = event.target.value;
      if (name === "centre") dailyAttendanceState.class = "";
      dailyAttendanceState.student = "";
      dailyAttendanceState.error = "";
      dailyAttendanceState.feedback = "";
      dailyAttendanceState.conflict = false;
      render();
    };
  }
  bindDailyAttendanceResults();
  dailyAttendanceFetch();
}

function bindDailyAttendanceResults() {
  if ($("daily-attendance-retry")) $("daily-attendance-retry").onclick = dailyAttendanceReload;
  if ($("daily-attendance-reload")) $("daily-attendance-reload").onclick = dailyAttendanceReload;
  if ($("daily-attendance-student")) $("daily-attendance-student").onchange = event => {
    dailyAttendanceState.student = event.target.value;
    dailyAttendanceUpdateResults();
  };
  document.querySelectorAll("[data-daily-status]").forEach(input => {
    input.onchange = () => {
      if (dailyAttendanceState.saving) return;
      const row = dailyAttendanceRows().find(student => student.id === input.dataset.dailyStatus);
      if (!row) return;
      const value = input.value || null;
      if ((row.status || null) === value) dailyAttendanceState.drafts.delete(row.id);
      else if (!dailyAttendanceState.drafts.has(row.id) && dailyAttendanceState.drafts.size >= 200) {
        toast("Enregistrez les 200 modifications en cours avant de poursuivre avec les autres élèves.");
        dailyAttendanceUpdateResults();
        return;
      } else dailyAttendanceState.drafts.set(row.id, { student: row.id, status: value, revision: row.revision });
      dailyAttendanceState.error = "";
      dailyAttendanceState.feedback = "";
      dailyAttendanceUpdateResults();
    };
  });
  if ($("daily-attendance-discard")) $("daily-attendance-discard").onclick = () => {
    if (dailyAttendanceState.saving || !dailyAttendanceState.drafts.size) return;
    if (!window.confirm("Abandonner toutes les présences non enregistrées ? Vos choix en cours seront perdus et la liste sera rechargée depuis le serveur.")) return;
    dailyAttendanceState.drafts.clear();
    dailyAttendanceState.feedback = "Modifications abandonnées. La liste est rechargée.";
    dailyAttendanceReload();
  };
  if ($("daily-attendance-save")) $("daily-attendance-save").onclick = dailyAttendanceSave;
}

async function dailyAttendanceSave() {
  if (!dailyAttendanceAllowed() || dailyAttendanceState.saving || !dailyAttendanceState.drafts.size) return;
  if (dailyAttendanceState.drafts.size > 200) { toast("Enregistrez au maximum 200 modifications à la fois."); return; }
  const key = dailyAttendanceKey();
  const body = {
    date: dailyAttendanceState.date, centre: dailyAttendanceState.centre, class: dailyAttendanceState.class,
    entries: [...dailyAttendanceState.drafts.values()].map(entry => ({ ...entry })),
  };
  dailyAttendanceState.saving = true;
  dailyAttendanceState.error = "";
  dailyAttendanceState.feedback = "";
  dailyAttendanceUpdateResults();
  let saved = false;
  try {
    await schoolAPI.request("/api/cashier/attendance", "POST", body);
    saved = true;
    dailyAttendanceState.drafts.clear();
    dailyAttendanceState.conflict = false;
    dailyAttendanceState.feedback = `${body.entries.length} présence(s) enregistrée(s). Le responsable retrouve ce pointage dans son espace.`;
    dailyAttendanceState.cache.delete(key);
    try { await refresh(); } catch (err) {
      dailyAttendanceState.feedback += " La liste sera actualisée à sa prochaine ouverture.";
      if (err.status === 401) location.assign("/connexion.html?espace=caisse");
    }
  } catch (err) {
    if (err.status === 401) location.assign("/connexion.html?espace=caisse");
    dailyAttendanceState.conflict = err.status === 409;
    dailyAttendanceState.error = dailyAttendanceState.conflict
      ? "Ce pointage a été modifié par un autre compte. Aucun de vos changements n’a été enregistré."
      : (err.message || "Les présences n’ont pas été enregistrées. Vos choix sont conservés ; réessayez.");
  } finally {
    dailyAttendanceState.saving = false;
    dailyAttendanceUpdateResults();
    if (saved && page === "dailyAttendance") dailyAttendanceFetch();
  }
}
