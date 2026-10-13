"use strict";

const enrollmentState = {
  query: "",
  class: "",
  centre: "",
  status: "",
  from: "",
  to: "",
  selected: new Set(),
  busy: false,
  error: "",
};

function enrollmentNormalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr-FR")
    .trim()
    .replace(/\s+/g, " ");
}

function enrollmentStatus(record) {
  return record.registrationStatus || "Inscrit";
}

function enrollmentDuplicates(records = db.students) {
  const groups = new Map();
  for (const record of records) {
    const name = enrollmentNormalize(record.name);
    const phone = String(record.phone || "").replace(/\D/g, "");
    if (!name || !phone) continue;
    const key = JSON.stringify([
      name,
      phone,
      enrollmentNormalize(record.class),
      enrollmentNormalize(record.centre),
    ]);
    const ids = groups.get(key) || [];
    ids.push(record.id);
    groups.set(key, ids);
  }
  const duplicateGroups = [...groups.values()].filter((ids) => ids.length > 1);
  return {
    ids: new Set(duplicateGroups.flat()),
    groups: duplicateGroups.length,
  };
}

function enrollmentFilteredStudents() {
  const query = enrollmentNormalize(enrollmentState.query);
  return db.students.filter((record) => {
    if (enrollmentState.class && record.class !== enrollmentState.class) return false;
    if (enrollmentState.centre && record.centre !== enrollmentState.centre) return false;
    if (enrollmentState.status && enrollmentStatus(record) !== enrollmentState.status) return false;
    const text = enrollmentNormalize([
      record.name,
      record.guardian,
      record.phone,
      record.class,
      record.centre,
      record.group,
      ...(record.subjects || []),
    ].join(" "));
    return !query || text.includes(query);
  });
}

function enrollmentOptions(values, selected) {
  return [...new Set(values.filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "fr-FR", { numeric: true }))
    .map((value) => `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(value)}</option>`)
    .join("");
}

function enrollmentDateError() {
  return enrollmentState.from && enrollmentState.to && enrollmentState.from > enrollmentState.to
    ? "La date de début doit précéder la date de fin du bulletin."
    : "";
}

function enrollmentReportUrl(id) {
  const params = new URLSearchParams();
  if (enrollmentState.from) params.set("from", enrollmentState.from);
  if (enrollmentState.to) params.set("to", enrollmentState.to);
  const query = params.toString();
  return `/api/admin/students/${encodeURIComponent(id)}/report.pdf${query ? "?" + query : ""}`;
}

function enrollmentPage() {
  if (role !== "admin") return '<div class="empty-note">La gestion des inscriptions est réservée à l’administration.</div>';
  const eligibleIds = new Set(db.students.filter((record) => enrollmentStatus(record) === "Préinscription").map((record) => record.id));
  enrollmentState.selected = new Set([...enrollmentState.selected].filter((id) => eligibleIds.has(id)));
  const records = enrollmentFilteredStudents();
  const selectable = records.filter((record) => eligibleIds.has(record.id));
  const allSelected = selectable.length > 0 && selectable.every((record) => enrollmentState.selected.has(record.id));
  const duplicates = enrollmentDuplicates();
  const selectedCount = enrollmentState.selected.size;
  const disabled = enrollmentState.busy ? "disabled" : "";
  const dateError = enrollmentDateError();
  const pending = db.students.filter((record) => eligibleIds.has(record.id)).length;
  return `<div class="panel enrollments-panel">
    <div class="toolbar enrollments-toolbar">
      <div><h2>Dossiers élèves</h2><p class="helper">${db.students.length} dossier(s) · ${pending} préinscription(s) à valider</p></div>
      <button class="primary" id="add" ${disabled}>+ Inscrire un élève</button>
    </div>
    <div class="enrollment-filters">
      <label class="enrollment-search-label" for="enrollment-search">Recherche<input id="enrollment-search" type="search" placeholder="Nom, responsable, téléphone…" value="${esc(enrollmentState.query)}" ${disabled}></label>
      <label for="enrollment-class">Classe<select id="enrollment-class" ${disabled}><option value="">Toutes les classes</option>${enrollmentOptions([...catalogue.levels.map(([name]) => name), ...db.students.map((record) => record.class)], enrollmentState.class)}</select></label>
      <label for="enrollment-centre">Centre<select id="enrollment-centre" ${disabled}><option value="">Tous les centres</option>${enrollmentOptions([...catalogue.centres, ...db.students.map((record) => record.centre)], enrollmentState.centre)}</select></label>
      <label for="enrollment-status">Statut<select id="enrollment-status" ${disabled}><option value="">Tous les statuts</option>${enrollmentOptions(["Préinscription", "Inscrit", "Suspendu"], enrollmentState.status)}</select></label>
      <button class="secondary" id="enrollment-reset" ${disabled}>Effacer les filtres</button>
    </div>
    ${duplicates.groups ? `<div class="enrollment-duplicate-note" role="status"><strong>${duplicates.groups} rapprochement(s) à vérifier</strong><p>Des dossiers partagent le même nom, téléphone, classe et centre. Vérifiez les fiches marquées « Doublon possible » avant de décider. Aucun dossier n’est supprimé automatiquement.</p></div>` : ""}
    <details class="enrollment-report-period" ${enrollmentState.from || enrollmentState.to ? "open" : ""}>
      <summary>Période des bulletins PDF</summary>
      <p class="helper">Sans dates, le bulletin reprend tout le suivi disponible. Chaque téléchargement concerne uniquement l’élève de la ligne.</p>
      <div class="enrollment-period-fields"><label for="enrollment-from">Du<input id="enrollment-from" type="date" value="${esc(enrollmentState.from)}" ${disabled}></label><label for="enrollment-to">Au<input id="enrollment-to" type="date" value="${esc(enrollmentState.to)}" ${disabled}></label><button class="secondary" id="enrollment-clear-period" ${disabled}>Toutes les dates</button></div>
      ${dateError ? `<p class="enrollment-error" role="alert">${esc(dateError)}</p>` : ""}
    </details>
    <div class="enrollment-bulk-bar">
      <div><strong id="enrollment-selection-count">${selectedCount} dossier(s) sélectionné(s)</strong><span>Seules les préinscriptions peuvent être sélectionnées. Maximum : 100 dossiers.</span></div>
      <div class="enrollment-bulk-actions"><button class="secondary" id="enrollment-clear-selection" ${!selectedCount || enrollmentState.busy ? "disabled" : ""}>Désélectionner</button><button class="primary" id="enrollment-validate" ${!selectedCount || enrollmentState.busy ? "disabled" : ""}>${enrollmentState.busy ? "Validation en cours…" : `Valider ${selectedCount ? selectedCount + " " : "les "}préinscription(s)`}</button></div>
    </div>
    <p id="enrollment-feedback" class="enrollment-error" role="alert" ${enrollmentState.error ? "" : "hidden"}>${esc(enrollmentState.error)}</p>
    <p class="enrollment-results" role="status">${records.length} dossier(s) affiché(s) sur ${db.students.length}${selectedCount ? " · La sélection est conservée entre les filtres." : ""}</p>
    ${records.length ? `<div class="enrollment-table-scroll" tabindex="0" role="region" aria-label="Dossiers élèves, tableau défilant"><table class="enrollment-table"><thead><tr><th><input type="checkbox" id="enrollment-select-all" aria-label="Sélectionner les préinscriptions affichées" ${allSelected ? "checked" : ""} ${!selectable.length || enrollmentState.busy ? "disabled" : ""}></th><th>Élève</th><th>Classe</th><th>Centre</th><th>Groupe</th><th>Matières</th><th>Statut</th><th>Actions</th></tr></thead><tbody>${records.map((record) => {
      const status = enrollmentStatus(record);
      const selectableRecord = eligibleIds.has(record.id);
      const report = dateError
        ? '<span class="enrollment-report-disabled">Bulletin PDF</span>'
        : `<a class="secondary enrollment-report" href="${esc(enrollmentReportUrl(record.id))}" data-enrollment-report="${esc(record.id)}" aria-label="Télécharger le bulletin PDF de ${esc(record.name)}">Bulletin PDF</a>`;
      return `<tr class="${enrollmentState.selected.has(record.id) ? "enrollment-selected" : ""}"><td><input type="checkbox" data-enrollment-select="${esc(record.id)}" aria-label="Sélectionner la préinscription de ${esc(record.name)}" ${enrollmentState.selected.has(record.id) ? "checked" : ""} ${!selectableRecord || enrollmentState.busy ? "disabled" : ""}></td><td><div class="enrollment-person">${person(record)}</div>${duplicates.ids.has(record.id) ? '<span class="enrollment-duplicate-badge">Doublon possible</span>' : ""}</td><td>${esc(record.class)}</td><td class="enrollment-wrap">${esc(record.centre || "Non renseigné")}</td><td class="enrollment-wrap">${esc(record.group)}</td><td class="enrollment-wrap">${esc((record.subjects || []).join(", ") || "Non renseignées")}</td><td><span class="enrollment-status ${status === "Préinscription" ? "pending" : status === "Suspendu" ? "suspended" : "registered"}">${esc(status)}</span></td><td><div class="enrollment-row-actions">${actions(record.id)}${report}</div></td></tr>`;
    }).join("")}</tbody></table></div>` : '<div class="empty-note">Aucun dossier ne correspond aux filtres. Effacez les filtres ou inscrivez un élève.</div>'}
  </div>`;
}

function enrollmentRender() {
  if (role === "admin" && page === "students") render();
}

function enrollmentSetError(message) {
  enrollmentState.error = message;
  const feedback = $("enrollment-feedback");
  if (feedback) {
    feedback.textContent = message;
    feedback.hidden = !message;
  }
}

async function enrollmentValidate() {
  if (enrollmentState.busy || !enrollmentState.selected.size) return;
  const ids = [...enrollmentState.selected];
  if (ids.length > 100) return enrollmentSetError("Sélectionnez au maximum 100 préinscriptions à la fois.");
  enrollmentState.busy = true;
  enrollmentState.error = "";
  enrollmentRender();
  let validated = false;
  try {
    await schoolAPI.request("/api/admin/registrations/validate", "POST", { ids });
    validated = true;
    enrollmentState.selected.clear();
    await refresh();
    toast(`${ids.length} préinscription(s) validée(s).`);
  } catch (err) {
    enrollmentState.error = validated
      ? "Validation enregistrée, mais l’actualisation a échoué. Rechargez la page pour voir les statuts à jour."
      : err.message || "La validation n’a pas pu être confirmée. Actualisez les dossiers avant de réessayer.";
    if (err.status === 401) location.assign("/connexion.html");
  } finally {
    enrollmentState.busy = false;
    enrollmentRender();
  }
}

async function enrollmentDownloadReport(link) {
  if (link.dataset.downloading) return;
  const dateError = enrollmentDateError();
  if (dateError) return enrollmentSetError(dateError);
  link.dataset.downloading = "true";
  link.setAttribute("aria-busy", "true");
  link.textContent = "Préparation…";
  enrollmentSetError("");
  try {
    const response = await fetch(link.href, { credentials: "same-origin", headers: { Accept: "application/pdf" } });
    if (!response.ok) {
      let message = "Le bulletin n’a pas pu être téléchargé. Réessayez.";
      try { message = (await response.json()).error || message; } catch (_) { /* A network gateway may return a non-JSON error. */ }
      if (response.status === 401) location.assign("/connexion.html");
      throw new Error(message);
    }
    if (!String(response.headers.get("content-type") || "").toLowerCase().includes("application/pdf")) {
      throw new Error("Le serveur n’a pas renvoyé un bulletin PDF. Reconnectez-vous puis réessayez.");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const download = document.createElement("a");
    download.href = url;
    download.download = `bulletin-${link.dataset.enrollmentReport}.pdf`;
    document.body.appendChild(download);
    download.click();
    download.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast("Bulletin PDF téléchargé.");
  } catch (err) {
    enrollmentSetError(err.message || "Le téléchargement a échoué. Réessayez.");
  } finally {
    delete link.dataset.downloading;
    link.removeAttribute("aria-busy");
    link.textContent = "Bulletin PDF";
  }
}

function bindEnrollments() {
  if (role !== "admin" || page !== "students" || !$("enrollment-search")) return;
  if (enrollmentState.busy) {
    document.querySelectorAll(".enrollment-row-actions button").forEach((button) => { button.disabled = true; });
  }
  $("enrollment-search").oninput = (event) => {
    const position = event.target.selectionStart;
    enrollmentState.query = event.target.value;
    enrollmentRender();
    const input = $("enrollment-search");
    input.focus();
    if (position !== null) input.setSelectionRange(position, position);
  };
  for (const key of ["class", "centre", "status", "from", "to"]) {
    $(`enrollment-${key}`).onchange = (event) => {
      enrollmentState[key] = event.target.value;
      enrollmentState.error = "";
      enrollmentRender();
    };
  }
  $("enrollment-reset").onclick = () => {
    for (const key of ["query", "class", "centre", "status"]) enrollmentState[key] = "";
    enrollmentState.error = "";
    enrollmentRender();
  };
  $("enrollment-clear-period").onclick = () => {
    enrollmentState.from = "";
    enrollmentState.to = "";
    enrollmentState.error = "";
    enrollmentRender();
  };
  $("enrollment-clear-selection").onclick = () => {
    enrollmentState.selected.clear();
    enrollmentState.error = "";
    enrollmentRender();
  };
  $("enrollment-validate").onclick = enrollmentValidate;
  document.querySelectorAll("[data-enrollment-select]").forEach((checkbox) => {
    checkbox.onchange = () => {
      enrollmentState.error = "";
      if (checkbox.checked) {
        if (enrollmentState.selected.size >= 100) {
          checkbox.checked = false;
          return enrollmentSetError("La sélection est limitée à 100 dossiers. Validez ce premier lot avant de poursuivre.");
        }
        enrollmentState.selected.add(checkbox.dataset.enrollmentSelect);
      } else enrollmentState.selected.delete(checkbox.dataset.enrollmentSelect);
      enrollmentRender();
    };
  });
  const selectAll = $("enrollment-select-all");
  if (selectAll) {
    const visible = enrollmentFilteredStudents().filter((record) => enrollmentStatus(record) === "Préinscription");
    const selected = visible.filter((record) => enrollmentState.selected.has(record.id)).length;
    selectAll.indeterminate = selected > 0 && selected < visible.length;
    selectAll.onchange = () => {
      enrollmentState.error = "";
      if (selectAll.checked) {
        for (const record of visible) {
          if (enrollmentState.selected.size >= 100) break;
          enrollmentState.selected.add(record.id);
        }
        if (visible.some((record) => !enrollmentState.selected.has(record.id))) {
          enrollmentState.error = "La sélection est limitée à 100 dossiers. Validez ce premier lot avant de poursuivre.";
        }
      } else for (const record of visible) enrollmentState.selected.delete(record.id);
      enrollmentRender();
    };
  }
  document.querySelectorAll("[data-enrollment-report]").forEach((link) => {
    link.onclick = (event) => { event.preventDefault(); enrollmentDownloadReport(link); };
  });
}
