"use strict";
(() => {
  const setup = document.body.dataset.auth === "setup";
  const form = document.getElementById("auth-form"), button = document.getElementById("auth-submit");
  const error = document.getElementById("auth-error"), state = document.getElementById("auth-state");
  let busy = false;
  async function status() {
    try {
      const response = await fetch("/api/auth/status", { credentials: "same-origin", headers: { Accept: "application/json" } });
      if (!response.ok) return;
      const data = await response.json();
      if (setup && data.initialized) {
        form.hidden = true;
        state.textContent = "La ferme est déjà configurée. Utilisez la page de connexion avec votre compte personnel.";
      } else if (!setup && !data.initialized) {
        document.getElementById("setup-link").hidden = false;
        state.textContent = "Le compte responsable doit d’abord être créé avec le code d’installation.";
      }
    } catch (_) { /* A failed status check never changes login credentials. */ }
  }
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy) return;
    error.textContent = "";
    const password = form.elements.password.value;
    if (setup && password !== form.elements.confirmation.value) { error.textContent = "Les deux mots de passe doivent être identiques."; return; }
    busy = true; button.disabled = true; button.setAttribute("aria-busy", "true");
    try {
      const body = { username: form.elements.username.value.trim(), password, ...(setup ? { token: form.elements.token.value.trim() } : {}) };
      const response = await fetch(setup ? "/api/auth/setup" : "/api/auth/login", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
      let result; try { result = await response.json(); } catch { throw new Error("Le serveur est indisponible. Réessayez dans un instant."); }
      if (!response.ok) throw new Error(result.error || "Connexion impossible. Vérifiez vos accès.");
      form.elements.password.value = "";
      if (setup) { form.elements.token.value = ""; form.elements.confirmation.value = ""; }
      location.assign("/app.html");
    } catch (cause) {
      error.textContent = cause.message || "La connexion a été interrompue. Réessayez.";
      busy = false; button.disabled = false; button.removeAttribute("aria-busy");
    }
  });
  status();
})();
