"use strict";
window.AdeoyeBranding.load().then(settings => {
  if (settings?.description?.trim()) document.getElementById("farm-description").textContent = settings.description;
}).catch(() => {});
