"use strict";
window.schoolAPI = {
  csrf: "",
  async request(path, method = "GET", body) {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(this.csrf ? { "X-CSRF-Token": this.csrf } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(
        result.error || "Impossible de terminer la requête.",
      );
      error.status = response.status;
      throw error;
    }
    if (result.csrf) this.csrf = result.csrf;
    return result;
  },
};
