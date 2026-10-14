"use strict";

(() => {
  let dialog;
  let state = null;
  const countLabels = [
    ["payments", "Paiements"],
    ["grades", "Notes"],
    ["attendance", "Présences par cours"],
    ["dailyAttendance", "Présences du jour"],
    ["accounts", "Comptes élèves"],
    ["orders", "Tentatives de paiement"],
  ];
  const amountLabels = [
    ["cash", "Espèces / saisies administratives à retirer"],
    ["online", "Paiements réels en ligne"],
    ["sandbox", "Paiements de test à retirer"],
  ];

  const element = (id) => dialog.querySelector(`#cleanup-${id}`);
  const number = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  };

  function clearSecrets() {
    element("password").value = "";
  }

  function updateSubmit() {
    element("submit").disabled = !state || state.busy || state.preview?.canPurgeTest !== true ||
      !element("fictitious").checked ||
      element("confirmation").value !== state.preview.student.name ||
      !element("password").value;
  }

  function setBusy(busy) {
    if (!state) return;
    state.busy = busy;
    dialog.setAttribute("aria-busy", String(busy));
    dialog.querySelectorAll("button, input").forEach((control) => {
      control.disabled = busy;
    });
    updateSubmit();
  }

  function clearPreview() {
    state.preview = null;
    element("preview").hidden = true;
    element("confirmation-fields").hidden = true;
    element("blocked").hidden = true;
    element("reload").hidden = false;
    element("fictitious").checked = false;
    element("confirmation").value = "";
    clearSecrets();
    updateSubmit();
  }

  function makeList(target, labels, values, format) {
    target.replaceChildren();
    for (const [key, label] of labels) {
      const row = document.createElement("div");
      const term = document.createElement("dt");
      const value = document.createElement("dd");
      term.textContent = label;
      value.textContent = format(number(values?.[key]));
      row.append(term, value);
      target.append(row);
    }
  }

  function showPreview(preview) {
    if (!preview || preview.student?.id !== state.id ||
        typeof preview.student.name !== "string" || !preview.student.name ||
        typeof preview.fingerprint !== "string" || !preview.fingerprint) {
      throw new Error("L’aperçu du dossier est incomplet. Rechargez-le avant de continuer.");
    }
    state.preview = preview;
    element("student").textContent = [preview.student.name, preview.student.class,
      preview.student.centre].filter(Boolean).join(" · ");
    makeList(element("counts"), countLabels, preview.counts,
      (value) => new Intl.NumberFormat("fr-FR").format(value));
    makeList(element("amounts"), amountLabels, preview.amounts, money);
    element("name").textContent = preview.student.name;
    element("preview").hidden = false;
    element("reload").hidden = true;
    const permitted = preview.canPurgeTest === true;
    element("confirmation-fields").hidden = !permitted;
    element("blocked").hidden = permitted;
    element("reason").textContent = preview.reason ||
      "Ce dossier contient des opérations réelles qui doivent être conservées.";
    updateSubmit();
  }

  async function loadPreview() {
    if (!state || state.busy) return;
    clearPreview();
    element("error").textContent = "";
    element("status").textContent = "Chargement de l’aperçu…";
    setBusy(true);
    try {
      const preview = await schoolAPI.request(
        `/api/admin/students/${encodeURIComponent(state.id)}/deletion-preview`,
      );
      showPreview(preview);
    } catch (error) {
      clearPreview();
      element("error").textContent = error.message ||
        "L’aperçu est indisponible. Rechargez-le pour continuer.";
      if (error.status === 401) handleError(error);
    } finally {
      element("status").textContent = "";
      setBusy(false);
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (!state || state.busy) return;
    updateSubmit();
    if (element("submit").disabled) {
      element("error").textContent =
        "Confirmez le caractère fictif du dossier, recopiez son nom exactement et saisissez votre mot de passe.";
      return;
    }
    const studentId = state.id;
    const payload = {
      currentPassword: element("password").value,
      confirmedFictitious: true,
      confirmation: element("confirmation").value,
      fingerprint: state.preview.fingerprint,
    };
    setBusy(true);
    element("error").textContent = "";
    element("status").textContent = "Suppression du dossier d’essai…";
    try {
      const request = schoolAPI.request(
        `/api/admin/students/${encodeURIComponent(studentId)}/purge-test`, "POST", payload,
      );
      clearSecrets();
      await request;
    } catch (error) {
      clearPreview();
      element("error").textContent =
        `${error.message || "La suppression n’a pas pu être confirmée."} Rechargez l’aperçu avant toute nouvelle tentative.`;
      element("status").textContent = "";
      setBusy(false);
      if (error.status === 401) handleError(error);
      return;
    } finally {
      payload.currentPassword = "";
      clearSecrets();
    }

    element("status").textContent = "Dossier supprimé. Actualisation de la liste…";
    let refreshError;
    try {
      await refresh();
      render();
    } catch (error) {
      refreshError = error;
    }
    dialog.close();
    if (refreshError?.status === 401) handleError(refreshError);
    else toast(refreshError
      ? "Dossier supprimé. L’actualisation a échoué ; rechargez la page."
      : "Dossier d’essai supprimé définitivement.");
  }

  function createDialog() {
    dialog = document.createElement("dialog");
    dialog.id = "student-cleanup-modal";
    dialog.className = "student-cleanup-modal";
    dialog.setAttribute("aria-labelledby", "cleanup-title");
    dialog.innerHTML = `<form id="cleanup-form">
      <div class="dialog-head"><h2 id="cleanup-title">Supprimer un dossier d’essai</h2><button id="cleanup-close" class="icon-button" type="button" aria-label="Fermer">×</button></div>
      <p id="cleanup-student" class="cleanup-student"></p>
      <p id="cleanup-status" role="status" aria-live="polite"></p>
      <div id="cleanup-preview" hidden>
        <p class="cleanup-warning">Cette action est irréversible : le dossier élève et les données ci-dessous seront supprimés définitivement.</p>
        <dl id="cleanup-counts" class="cleanup-counts"></dl>
        <dl id="cleanup-amounts" class="cleanup-amounts"></dl>
        <p class="helper">Si ce dossier est réel ou si des espèces ont réellement été reçues, conservez-le : ouvrez « Modifier » et choisissez le statut « Suspendu ».</p>
      </div>
      <div id="cleanup-blocked" hidden><p id="cleanup-reason" class="cleanup-warning" role="alert"></p><p>Pour arrêter le suivi de cet élève en conservant les comptes, ouvrez son dossier et choisissez le statut « Suspendu ».</p><button id="cleanup-edit" class="secondary" type="button">Modifier le dossier</button></div>
      <div id="cleanup-confirmation-fields" hidden>
        <label class="cleanup-confirmation"><input id="cleanup-fictitious" type="checkbox" required><strong>Je confirme que ce dossier est un essai et qu’aucun argent réel n’a été reçu</strong></label>
        <label for="cleanup-confirmation">Recopiez exactement le nom : <strong id="cleanup-name"></strong></label>
        <input id="cleanup-confirmation" type="text" autocomplete="off" spellcheck="false" required>
        <label for="cleanup-password">Votre mot de passe de responsable</label>
        <input id="cleanup-password" type="password" autocomplete="current-password" maxlength="128" required>
        <button id="cleanup-submit" class="primary cleanup-delete" type="submit" disabled>Supprimer définitivement cet essai</button>
      </div>
      <p id="cleanup-error" class="cleanup-error" role="alert"></p>
      <button id="cleanup-reload" class="secondary" type="button" hidden>Recharger l’aperçu</button>
    </form>`;
    document.body.append(dialog);
    element("form").onsubmit = submit;
    element("close").onclick = () => { if (!state?.busy) dialog.close(); };
    element("reload").onclick = loadPreview;
    element("edit").onclick = () => {
      if (!state || state.busy) return;
      const id = state.id;
      dialog.close();
      openForm(id);
    };
    for (const id of ["fictitious", "confirmation", "password"]) {
      element(id).addEventListener("input", updateSubmit);
    }
    dialog.addEventListener("cancel", (event) => {
      if (state?.busy) event.preventDefault();
    });
    dialog.addEventListener("close", () => {
      if (dialog.open) return;
      clearSecrets();
      element("confirmation").value = "";
      element("fictitious").checked = false;
      state = null;
    });
  }

  window.openStudentCleanup = (record) => {
    if (role !== "admin" || !record?.id || dialog?.open) return;
    if (!dialog) createDialog();
    state = { id: record.id, preview: null, busy: false };
    element("student").textContent = record.name || "Dossier élève";
    dialog.showModal();
    loadPreview();
  };
})();
