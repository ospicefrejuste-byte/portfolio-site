"use strict";

sections.settings = ["⚙", "Paramètres de l’établissement"];

function settingsLogoIsAllowed(value) {
  if (!value) return true;
  if (value.startsWith("data:image/"))
    return value.length <= 24000 && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
  try {
    const url = new URL(value);
    return value.length <= 2048 && url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function settingsLevelRow(name = "", fee = "") {
  return `<div class="settings-level-row"><label>Nom de la classe<input class="settings-level-name" maxlength="80" value="${esc(name)}" autocomplete="off" placeholder="Ex. : 6e"></label><label>Tarif mensuel (FCFA)<input class="settings-level-fee" type="number" min="0" max="1000000" step="1" value="${esc(fee)}" inputmode="numeric" placeholder="Ex. : 3500"></label><button type="button" class="secondary settings-remove-level" aria-label="Supprimer cette classe" title="Supprimer cette classe">×</button></div>`;
}

function settingsPage() {
  if (role !== "admin") return '<div class="empty-note">Les paramètres sont réservés à l’administration.</div>';
  const logo = catalogue.logoUrl || "";
  const logoVisible = logo && settingsLogoIsAllowed(logo);
  return `<div class="settings-intro"><div><span class="settings-kicker">VOTRE ÉTABLISSEMENT</span><h2>Une plateforme à votre image.</h2><p>Personnalisez l’accueil et préparez les choix proposés aux familles.</p></div><span class="settings-intro-icon" aria-hidden="true">✦</span></div>
    <form id="school-settings" class="settings-form" novalidate>
      <div class="settings-layout">
        <section class="panel settings-card" aria-labelledby="settings-brand-heading">
          <div class="settings-card-head"><span class="settings-step" aria-hidden="true">01</span><div><h2 id="settings-brand-heading">Présentation & contacts</h2><p>Les informations affichées sur la page d’accueil.</p></div></div>
          <label for="settings-name">Nom de l’établissement<input id="settings-name" name="name" maxlength="120" value="${esc(catalogue.name || "COUR DE RENFORCEMENT SCOLAIRE")}" autocomplete="organization" required></label>
          <label for="settings-tagline">Slogan<input id="settings-tagline" name="tagline" maxlength="180" value="${esc(catalogue.tagline || "")}" placeholder="Ex. : Ensemble pour une meilleure réussite !"></label>
          <label for="settings-description">Courte présentation<textarea id="settings-description" name="description" maxlength="2000" rows="4" placeholder="Présentez votre accompagnement et vos objectifs.">${esc(catalogue.description || "")}</textarea></label>
          <label for="settings-phones">Téléphones de contact<textarea id="settings-phones" name="phones" rows="3" aria-describedby="settings-phones-hint" placeholder="01 41 77 84 49&#10;01 95 48 91 34">${esc((catalogue.phones || []).join("\n"))}</textarea></label>
          <p id="settings-phones-hint" class="settings-hint">Un numéro par ligne, jusqu’à 5 numéros. Indiquez entre 8 et 15 chiffres ; les espaces et le préfixe + sont acceptés.</p>
        </section>
        <section class="panel settings-card" aria-labelledby="settings-logo-heading">
          <div class="settings-card-head"><span class="settings-step" aria-hidden="true">02</span><div><h2 id="settings-logo-heading">Logo de l’établissement</h2><p>Un repère pour les élèves et leurs parents.</p></div></div>
          <div class="settings-logo-preview" id="settings-logo-preview">${logoVisible ? `<img src="${esc(logo)}" alt="Logo actuel de l’établissement">` : '<span class="settings-logo-placeholder" aria-hidden="true">CR</span><span>Votre logo apparaîtra ici</span>'}</div>
          <label for="settings-logo-file">Choisir une image<input id="settings-logo-file" type="file" accept="image/jpeg,image/png,image/webp" aria-describedby="settings-logo-hint"></label>
          <p id="settings-logo-hint" class="settings-hint">JPG, PNG ou WebP, jusqu’à 5 Mo. L’image est réduite automatiquement avant l’enregistrement.</p>
          <div class="settings-divider"><span>ou utiliser une adresse d’image</span></div>
          <label for="settings-logo-url">Adresse HTTPS du logo<input id="settings-logo-url" type="url" maxlength="2048" value="${esc(logo.startsWith("https://") ? logo : "")}" placeholder="https://…" aria-describedby="settings-logo-error"></label>
          <p id="settings-logo-error" class="settings-field-error" role="alert"></p>
          <button id="settings-remove-logo" type="button" class="secondary">Retirer le logo</button>
        </section>
        <section class="panel settings-card settings-full" aria-labelledby="settings-levels-heading">
          <div class="settings-card-head"><span class="settings-step" aria-hidden="true">03</span><div><h2 id="settings-levels-heading">Classes & tarifs</h2><p>Les frais mensuels proposés lors des nouvelles inscriptions.</p></div></div>
          <div id="settings-levels">${catalogue.levels.map(([name, fee]) => settingsLevelRow(name, fee)).join("")}</div>
          <button id="settings-add-level" type="button" class="secondary">+ Ajouter une classe</button>
          <div class="settings-notice"><strong>Les dossiers existants gardent leur tarif.</strong><p>Un changement de prix s’applique aux nouvelles inscriptions. Pour modifier le tarif d’un élève déjà inscrit, ouvrez son dossier dans Élèves.</p></div>
        </section>
        <section class="panel settings-card" aria-labelledby="settings-centres-heading">
          <div class="settings-card-head"><span class="settings-step" aria-hidden="true">04</span><div><h2 id="settings-centres-heading">Centres de formation</h2><p>Les lieux que les familles peuvent choisir.</p></div></div>
          <label for="settings-centres">Un centre par ligne<textarea id="settings-centres" name="centres" rows="5" placeholder="Ex. : CSP Les Adorables de la Cité">${esc(catalogue.centres.join("\n"))}</textarea></label>
          <p class="settings-hint">Jusqu’à 30 centres, 100 caractères chacun. Conservez les centres déjà utilisés par des dossiers ou des cours.</p>
        </section>
        <section class="panel settings-card" aria-labelledby="settings-subjects-heading">
          <div class="settings-card-head"><span class="settings-step" aria-hidden="true">05</span><div><h2 id="settings-subjects-heading">Matières proposées</h2><p>Les matières disponibles à l’inscription et dans les cours.</p></div></div>
          <label for="settings-subjects">Une matière par ligne<textarea id="settings-subjects" name="subjects" rows="5" placeholder="Ex. : Mathématiques">${esc(catalogue.subjects.join("\n"))}</textarea></label>
          <p class="settings-hint">Jusqu’à 30 matières. Conservez les matières déjà utilisées par des élèves, des enseignants ou des cours.</p>
        </section>
      </div>
      <div class="settings-save-bar"><div><p id="settings-error" class="settings-field-error" role="alert" tabindex="-1"></p><p id="settings-save-status" class="settings-hint" role="status">Les modifications seront visibles après l’enregistrement.</p></div><button id="settings-save" type="submit" class="primary">Enregistrer les paramètres</button></div>
    </form>`;
}

async function settingsCompressLogo(file) {
  if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type))
    throw new Error("Choisissez une image JPG, PNG ou WebP.");
  if (file.size > 5 * 1024 * 1024) throw new Error("Cette image dépasse 5 Mo. Choisissez une image plus petite.");
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("Impossible de lire cette image. Essayez une autre image."));
      img.src = objectUrl;
    });
    if (!img.naturalWidth || !img.naturalHeight)
      throw new Error("Cette image est vide ou invalide.");
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Votre navigateur ne permet pas de préparer ce logo. Utilisez son adresse HTTPS.");
    for (const size of [384, 256, 192, 128]) {
      const ratio = Math.min(1, size / Math.max(img.naturalWidth, img.naturalHeight));
      canvas.width = Math.max(1, Math.round(img.naturalWidth * ratio));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * ratio));
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.85, 0.7, 0.5]) {
        const value = canvas.toDataURL("image/jpeg", quality);
        if (settingsLogoIsAllowed(value)) return value;
      }
    }
    throw new Error("Ce logo reste trop volumineux. Choisissez une image plus simple.");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function bindSettings() {
  const form = $("school-settings");
  if (!form || role !== "admin") return;
  let logoValue = catalogue.logoUrl || "", saving = false, preparingLogo = false, logoGeneration = 0;
  const error = $("settings-error"), logoError = $("settings-logo-error"), status = $("settings-save-status");
  const showError = (message, field) => {
    error.textContent = message;
    if (field) field.setAttribute("aria-invalid", "true");
    (field || error).focus();
  };
  const previewLogo = () => {
    const preview = $("settings-logo-preview");
    preview.innerHTML = "";
    if (logoValue && settingsLogoIsAllowed(logoValue)) {
      const image = document.createElement("img");
      image.alt = "Aperçu du logo de l’établissement";
      image.src = logoValue;
      image.addEventListener("error", () => {
        if (image.isConnected)
          logoError.textContent = "L’aperçu ne peut pas être affiché. Vérifiez que l’adresse de l’image est accessible.";
      });
      preview.append(image);
    } else {
      preview.innerHTML = '<span class="settings-logo-placeholder" aria-hidden="true">CR</span><span>Votre logo apparaîtra ici</span>';
    }
  };
  const syncDeleteButtons = () => {
    const buttons = form.querySelectorAll(".settings-remove-level");
    buttons.forEach(button => { button.disabled = buttons.length <= 1 || saving; });
    $("settings-add-level").disabled = buttons.length >= 30 || saving;
  };
  const clearErrors = () => {
    form.dataset.crsUnsaved = "true";
    error.textContent = "";
    form.querySelectorAll('[aria-invalid="true"]').forEach(field => field.removeAttribute("aria-invalid"));
    status.textContent = "Modifications en cours. Pensez à enregistrer.";
  };
  form.addEventListener("input", clearErrors);
  form.addEventListener("change", clearErrors);
  $("settings-levels").addEventListener("click", event => {
    const button = event.target.closest(".settings-remove-level");
    if (!button || saving || form.querySelectorAll(".settings-level-row").length <= 1) return;
    button.closest(".settings-level-row").remove();
    clearErrors();
    syncDeleteButtons();
  });
  $("settings-add-level").addEventListener("click", () => {
    if (saving || form.querySelectorAll(".settings-level-row").length >= 30) return;
    $("settings-levels").insertAdjacentHTML("beforeend", settingsLevelRow());
    $("settings-levels").lastElementChild.querySelector("input").focus();
    clearErrors();
    syncDeleteButtons();
  });
  $("settings-logo-file").addEventListener("change", async event => {
    const file = event.target.files[0], generation = ++logoGeneration;
    if (!file) return;
    preparingLogo = true;
    logoError.textContent = "";
    $("settings-save").disabled = true;
    status.textContent = "Préparation du logo…";
    try {
      const compressed = await settingsCompressLogo(file);
      if (!form.isConnected || generation !== logoGeneration) return;
      logoValue = compressed;
      $("settings-logo-url").value = "";
      previewLogo();
      status.textContent = "Logo prêt. Enregistrez les paramètres pour le publier.";
    } catch (err) {
      if (!form.isConnected || generation !== logoGeneration) return;
      logoError.textContent = err.message;
      event.target.value = "";
      status.textContent = "Le logo précédent est conservé.";
    } finally {
      if (form.isConnected && generation === logoGeneration) {
        preparingLogo = false;
        $("settings-save").disabled = saving;
      }
    }
  });
  $("settings-logo-url").addEventListener("input", event => {
    const value = event.target.value.trim();
    ++logoGeneration;
    preparingLogo = false;
    $("settings-save").disabled = saving;
    $("settings-logo-file").value = "";
    logoValue = value;
    logoError.textContent = !settingsLogoIsAllowed(value) ? "Utilisez une adresse HTTPS complète pour le logo." : "";
    previewLogo();
  });
  $("settings-remove-logo").addEventListener("click", () => {
    ++logoGeneration;
    preparingLogo = false;
    logoValue = "";
    $("settings-logo-file").value = "";
    $("settings-logo-url").value = "";
    $("settings-save").disabled = saving;
    logoError.textContent = "";
    previewLogo();
    clearErrors();
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (saving || preparingLogo) return;
    clearErrors();
    const lines = id => $(id).value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    const settings = {
      name: $("settings-name").value.trim(),
      tagline: $("settings-tagline").value.trim(),
      description: $("settings-description").value.trim(),
      phones: lines("settings-phones"),
      logoUrl: logoValue.trim(),
      levels: [],
      centres: lines("settings-centres"),
      subjects: lines("settings-subjects"),
    };
    if (!settings.name || settings.name.length > 120) return showError("Indiquez le nom de l’établissement, jusqu’à 120 caractères.", $("settings-name"));
    if (settings.tagline.length > 180) return showError("Le slogan doit contenir au maximum 180 caractères.", $("settings-tagline"));
    if (settings.description.length > 2000) return showError("La présentation doit contenir au maximum 2 000 caractères.", $("settings-description"));
    if (settings.phones.length > 5 || settings.phones.some(phone => !/^[+0-9 ()-]{8,20}$/.test(phone) || phone.replace(/\D/g, "").length < 8 || phone.replace(/\D/g, "").length > 15)) return showError("Indiquez jusqu’à 5 numéros, un par ligne, entre 8 et 15 chiffres (20 caractères maximum avec les espaces).", $("settings-phones"));
    if (!settingsLogoIsAllowed(settings.logoUrl)) return showError("Choisissez une image ou indiquez une adresse HTTPS valide pour le logo.", $("settings-logo-url"));
    const names = new Set();
    for (const row of form.querySelectorAll(".settings-level-row")) {
      const nameField = row.querySelector(".settings-level-name"), feeField = row.querySelector(".settings-level-fee");
      const name = nameField.value.trim(), feeText = feeField.value.trim(), fee = Number(feeText);
      if (!name || name.length > 80) return showError("Chaque classe doit avoir un nom, jusqu’à 80 caractères.", nameField);
      if (names.has(name.toLocaleLowerCase("fr"))) return showError("Une classe apparaît deux fois. Gardez une seule ligne par classe.", nameField);
      if (!feeText || !Number.isInteger(fee) || fee < 0 || fee > 1000000) return showError("Le tarif doit être un montant entier entre 0 et 1 000 000 FCFA.", feeField);
      names.add(name.toLocaleLowerCase("fr"));
      settings.levels.push([name, fee]);
    }
    if (!settings.levels.length || settings.levels.length > 30) return showError("Conservez entre 1 et 30 classes.");
    for (const [key, label, max] of [["centres", "centre", 100], ["subjects", "matière", 80]]) {
      const field = $("settings-" + key), list = settings[key];
      if (!list.length || list.length > 30 || list.some(value => value.length > max)) return showError(`Indiquez entre 1 et 30 ${key === "centres" ? "centres" : "matières"}, jusqu’à ${max} caractères par ${label}.`, field);
      if (new Set(list.map(value => value.toLocaleLowerCase("fr"))).size !== list.length) return showError(`Une ${key === "centres" ? "entrée" : "matière"} apparaît deux fois. Gardez une seule ligne par ${label}.`, field);
    }
    if (new Set(settings.phones).size !== settings.phones.length) return showError("Un numéro apparaît deux fois. Gardez une seule ligne par numéro.", $("settings-phones"));
    saving = true;
    const controls = [...form.querySelectorAll("input, textarea, button")];
    controls.forEach(control => { control.disabled = true; });
    $("settings-save").textContent = "Enregistrement…";
    status.textContent = "Enregistrement des paramètres…";
    let saved = false;
    try {
      await schoolAPI.request("/api/admin/settings", "PUT", settings);
      saved = true;
      await refresh();
      render();
      toast("Paramètres enregistrés. L’accueil a été mis à jour.");
    } catch (err) {
      if (err.status === 401) {
        location.assign("/connexion.html");
        return;
      }
      if (saved) {
        Object.assign(catalogue, settings);
        showError("Les paramètres sont enregistrés, mais l’actualisation a échoué. Actualisez la page pour retrouver votre espace.");
        status.textContent = "Enregistrement réussi.";
      } else {
        showError(err.message || "Impossible d’enregistrer les paramètres. Réessayez.");
        status.textContent = "Les modifications n’ont pas été enregistrées.";
      }
    } finally {
      saving = false;
      if (form.isConnected) {
        controls.forEach(control => { control.disabled = false; });
        $("settings-save").textContent = "Enregistrer les paramètres";
        syncDeleteButtons();
      }
    }
  });
  syncDeleteButtons();
}
