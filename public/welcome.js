"use strict";
fetch("/api/settings", { headers: { Accept: "application/json" } }).then(response => response.ok ? response.json() : null).then(settings => {
  if (settings?.description?.trim()) document.getElementById("farm-description").textContent = settings.description;
}).catch(() => {});
