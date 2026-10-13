(function () {
  "use strict";

  const VERSION_PATTERN = /^[a-f0-9]{64}$/i;
  const POLL_INTERVAL = 60000;
  const EVENT_THROTTLE = 5000;
  const REQUEST_TIMEOUT = 10000;
  const AUTO_DELAY = 10000;
  const RELOAD_GUARD_WINDOW = 300000;
  const RELOAD_GUARD_KEY = "crs:update-reload";

  function start() {
    const meta = document.querySelector('meta[name="crs-version"]');
    const currentVersion = meta && meta.content.trim().toLowerCase();
    if (!currentVersion || !VERSION_PATTERN.test(currentVersion)) return;

    let notice = null;
    let availableVersion = "";
    let dismissedVersion = "";
    let runningCheck = null;
    let timer = null;
    let lastCheck = 0;
    let autoTimer = null;
    let manualOnly = false;
    const editedControls = new Set();

    function cancelAutoReload() {
      if (autoTimer !== null) window.clearTimeout(autoTimer);
      autoTimer = null;
    }

    function recentlyReloaded(version) {
      try {
        const previous = JSON.parse(window.sessionStorage.getItem(RELOAD_GUARD_KEY) || "null");
        return !!previous && previous.version === version && Number.isFinite(previous.at) && Date.now() - previous.at < RELOAD_GUARD_WINDOW;
      } catch (_) {
        // If storage is unavailable, offer a manual update without risking a loop.
        return true;
      }
    }

    function rememberReload(version) {
      try {
        window.sessionStorage.setItem(RELOAD_GUARD_KEY, JSON.stringify({ version, at: Date.now() }));
        return true;
      } catch (_) { return false; }
    }

    function canAutoReload(version) {
      return !manualOnly && !document.hidden && navigator.onLine !== false && availableVersion === version && dismissedVersion !== version && !hasUnsavedWork() && !recentlyReloaded(version);
    }

    async function reloadSite(automatic) {
      cancelAutoReload();
      const targetVersion = availableVersion;
      if (automatic && !canAutoReload(targetVersion)) {
        manualOnly = true;
        updateNotice();
        return;
      }
      try {
        if (typeof window.crsPrepareReload === "function") await window.crsPrepareReload();
      } catch (_) {
        manualOnly = true;
        updateNotice();
        return;
      }
      if (automatic && !canAutoReload(targetVersion)) {
        manualOnly = true;
        updateNotice();
        return;
      }
      if (!rememberReload(targetVersion) && automatic) {
        manualOnly = true;
        updateNotice();
        return;
      }
      window.location.reload();
    }

    function scheduleAutoReload() {
      if (autoTimer !== null || !canAutoReload(availableVersion)) return;
      const targetVersion = availableVersion;
      autoTimer = window.setTimeout(async () => {
        autoTimer = null;
        if (!canAutoReload(targetVersion)) {
          manualOnly = true;
          updateNotice();
          return;
        }
        // Verify that this release is still current before an automatic refresh.
        const verified = await check(true);
        // A newer release owns its own timer; do not cancel it from this callback.
        if (availableVersion !== targetVersion) return;
        cancelAutoReload();
        if (!verified || !canAutoReload(targetVersion)) {
          manualOnly = true;
          updateNotice();
          return;
        }
        await reloadSite(true);
      }, AUTO_DELAY);
    }

    function updateNotice() {
      if (!availableVersion || availableVersion === dismissedVersion) return;
      const banner = ensureNotice();
      const message = hasUnsavedWork()
        ? "Une mise à jour du site est disponible. Terminez votre saisie, puis actualisez pour l’appliquer."
        : manualOnly || recentlyReloaded(availableVersion)
          ? "Une mise à jour du site est disponible. Vous pouvez actualiser pour l’appliquer."
          : "Une mise à jour du site est disponible. Elle sera chargée automatiquement.";
      const paragraph = banner.querySelector("p");
      if (paragraph.textContent !== message) paragraph.textContent = message;
      banner.hidden = false;
    }

    function ensureNotice() {
      if (notice) return notice;
      notice = document.createElement("section");
      notice.id = "site-update-notice";
      notice.className = "site-update-notice";
      notice.hidden = true;
      notice.setAttribute("role", "status");
      notice.setAttribute("aria-live", "polite");
      notice.setAttribute("aria-labelledby", "site-update-message");

      const message = document.createElement("p");
      message.id = "site-update-message";
      message.textContent = "Une mise à jour du site est disponible.";
      const actions = document.createElement("div");
      actions.className = "site-update-actions";

      const refresh = document.createElement("button");
      refresh.id = "site-update-refresh";
      refresh.type = "button";
      refresh.textContent = "Actualiser";
      refresh.addEventListener("click", async () => {
        if (hasUnsavedWork() && !window.confirm("Une saisie ou une opération est en cours. Actualiser peut vous faire perdre votre saisie ou l’accès au paiement et au reçu en cours. Terminez cette opération avant d’actualiser. Voulez-vous actualiser quand même ?")) return;
        await reloadSite(false);
      });

      const dismiss = document.createElement("button");
      dismiss.id = "site-update-dismiss";
      dismiss.type = "button";
      dismiss.className = "site-update-dismiss";
      dismiss.textContent = "Plus tard";
      dismiss.addEventListener("click", () => {
        dismissedVersion = availableVersion;
        cancelAutoReload();
        notice.hidden = true;
      });

      actions.append(refresh, dismiss);
      notice.append(message, actions);
      document.body.append(notice);
      return notice;
    }

    function hasUnsavedWork() {
      for (const control of editedControls) {
        if (!control.isConnected) editedControls.delete(control);
        else if (control.getClientRects().length) return true;
      }
      for (const control of document.querySelectorAll("form input:not([type='hidden']):not([type='submit']):not([type='button']):not([type='reset']), form textarea")) {
        if (!control.getClientRects().length) continue;
        if (control.type === "checkbox" || control.type === "radio") {
          if (control.checked !== control.defaultChecked) return true;
        } else if (control.value !== control.defaultValue) return true;
      }
      if (document.querySelector("dialog[open], [data-crs-pending='true'], [data-crs-unsaved='true'], form[aria-busy='true']")) return true;
      const confirmation = document.getElementById("confirmation");
      if (confirmation && !confirmation.hidden) return true;
      if (typeof window.crsHasUnsavedWork === "function") {
        try { return !!window.crsHasUnsavedWork(); } catch (_) { return true; }
      }
      return false;
    }

    function applyVersion(version) {
      if (version === currentVersion) {
        cancelAutoReload();
        availableVersion = "";
        dismissedVersion = "";
        manualOnly = false;
        if (notice) notice.hidden = true;
        return;
      }
      if (version !== availableVersion) {
        cancelAutoReload();
        manualOnly = hasUnsavedWork();
      }
      availableVersion = version;
      if (version === dismissedVersion) return;
      dismissedVersion = "";
      updateNotice();
      scheduleAutoReload();
    }

    function check(force) {
      if (runningCheck) return runningCheck;
      if (document.hidden || navigator.onLine === false) return Promise.resolve(false);
      const now = Date.now();
      if (!force && now - lastCheck < EVENT_THROTTLE) return Promise.resolve(false);
      lastCheck = now;

      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      runningCheck = (async () => {
        try {
          const response = await fetch("/version.json", {
            cache: "no-store",
            credentials: "omit",
            signal: controller.signal,
          });
          if (!response.ok) throw new Error("Update check unavailable");
          const data = await response.json();
          if (!data || typeof data.version !== "string" || !VERSION_PATTERN.test(data.version)) throw new Error("Invalid version");
          applyVersion(data.version.toLowerCase());
          return true;
        } catch (_) {
          // A failed update check must never interrupt registration or management.
          cancelAutoReload();
          if (availableVersion) { manualOnly = true; updateNotice(); }
          return false;
        } finally {
          window.clearTimeout(timeout);
        }
      })();
      runningCheck.finally(() => { runningCheck = null; });
      return runningCheck;
    }

    function trackEdits(event) {
      if (!(event.target instanceof Element)) return;
      const control = event.target.closest("input, select, textarea, [contenteditable]");
      if (control) {
        editedControls.add(control);
        if (availableVersion) {
          manualOnly = true;
          cancelAutoReload();
          updateNotice();
        }
      }
    }

    document.addEventListener("input", trackEdits, true);
    document.addEventListener("change", trackEdits, true);
    document.addEventListener("reset", event => {
      for (const control of editedControls) {
        if (event.target.contains(control)) editedControls.delete(control);
      }
    }, true);

    function resume() {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      if (document.hidden) {
        cancelAutoReload();
        return;
      }
      void check(false);
      timer = window.setInterval(() => { void check(false); }, POLL_INTERVAL);
    }

    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", () => { void check(false); });
    window.addEventListener("online", () => { void check(false); });
    window.addEventListener("offline", () => {
      cancelAutoReload();
      if (availableVersion) { manualOnly = true; updateNotice(); }
    });
    window.crsUpdates = Object.freeze({ check: () => check(true) });
    resume();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
