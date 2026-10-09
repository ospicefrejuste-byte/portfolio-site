"use strict";
(async () => {
  const form = document.getElementById("auth-form"),
    result = document.getElementById("auth-result");
  const setup = form.dataset.setup === "true";
  try {
    const status = await schoolAPI.request("/api/health");
    if (setup && !status.setupRequired) {
      form.hidden = true;
      result.textContent =
        "Installation terminée. Utilisez la page de connexion.";
      form.after(result);
    }
    if (!setup)
      document.getElementById("setup-link").hidden = !status.setupRequired;
  } catch {
    result.textContent = "Serveur indisponible. Réessayez plus tard.";
  }
  form.onsubmit = async (e) => {
    e.preventDefault();
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
})();
