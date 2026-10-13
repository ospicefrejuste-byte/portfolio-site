"use strict";
(async () => {
  const form = document.getElementById("auth-form"),
    result = document.getElementById("auth-result");
  const setup = form.dataset.setup === "true";
  window.crsHasUnsavedWork = () => schoolAPI.pendingRequests > 0;
  const submit = form.querySelector('button[type="submit"]');
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "Réessayer la connexion";
  retry.hidden = true;
  form.after(retry);
  let ready = false;
  async function prepare() {
    ready = false;
    submit.disabled = true;
    retry.hidden = true;
    try {
      if (!setup) {
        try {
          await schoolAPI.request("/api/auth/me");
          await schoolAPI.request("/api/auth/logout", "POST", {});
          schoolAPI.csrf = "";
        } catch (err) {
          if (err.status !== 401) throw err;
        }
      }
      const status = await schoolAPI.request("/api/health");
      if (setup && !status.setupRequired) {
        form.hidden = true;
        result.textContent = "Installation terminée. Utilisez la page de connexion.";
        form.after(result);
        return;
      }
      if (!setup) document.getElementById("setup-link").hidden = !status.setupRequired;
      ready = true;
      submit.disabled = false;
      result.textContent = "";
    } catch {
      result.textContent = "Impossible de préparer la connexion. Cliquez sur Réessayer.";
      retry.hidden = false;
    }
  }
  retry.onclick = prepare;
  window.addEventListener("pageshow", (event) => { if (event.persisted) location.reload(); });
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!ready) return;
    result.textContent = "";
    const data = Object.fromEntries(new FormData(form));
    if (setup && data.password !== data.confirmation) {
      result.textContent = "Les mots de passe ne correspondent pas.";
      return;
    }
    delete data.confirmation;
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      await schoolAPI.request(
        setup ? "/api/auth/setup" : "/api/auth/login",
        "POST",
        data,
      );
      location.assign("/gestion.html");
    } catch (err) {
      result.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  };
  await prepare();
})();
