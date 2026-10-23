"use strict";
(() => {
  const fallback = "/mark.svg";
  function url(settings) {
    const value = settings?.logoUrl;
    if (typeof value !== "string") return fallback;
    try {
      const parsed = new URL(value, location.origin);
      if (parsed.origin === location.origin && parsed.pathname === "/api/branding/logo.png" && !parsed.hash && !parsed.username && !parsed.password) return parsed.pathname + parsed.search;
    } catch (_) {}
    return fallback;
  }
  function apply(settings) {
    const source = url(settings), custom = source !== fallback;
    document.querySelectorAll("img[data-brand-logo]").forEach(image => {
      image.classList.toggle("custom-logo", custom);
      image.onerror = () => { image.onerror = null; image.src = fallback; image.classList.remove("custom-logo"); };
      if (image.getAttribute("src") !== source) image.src = source;
    });
    let favicon = document.querySelector('link[rel="icon"]');
    if (!favicon) { favicon = document.createElement("link"); favicon.rel = "icon"; document.head.append(favicon); }
    favicon.type = custom ? "image/png" : "image/svg+xml";
    favicon.href = source;
  }
  let ready;
  function load() {
    if (!ready) ready = fetch("/api/settings", { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(response => response.ok ? response.json() : null)
      .then(settings => { if (settings) apply(settings); return settings; }).catch(() => null);
    return ready;
  }
  window.AdeoyeBranding = { apply, url, load };
  if (!document.body.hasAttribute("data-branding-private")) load();
})();
