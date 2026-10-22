"use strict";
(() => {
  const valid = (period) => typeof period === "string" && /^20\d{2}-(0[1-9]|1[0-2])$/.test(period);
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const money = (amount) => new Intl.NumberFormat("fr-FR").format(amount) + " FCFA";
  function shift(period, distance) {
    if (!valid(period)) return "";
    const [year, month] = period.split("-").map(Number);
    const serial = year * 12 + month - 1 + distance;
    const result = Math.floor(serial / 12) + "-" + String(serial % 12 + 1).padStart(2, "0");
    return valid(result) ? result : "";
  }
  function range(start, count) {
    if (!valid(start) || !Number.isSafeInteger(Number(count)) || Number(count) < 1 || Number(count) > 1200) return [];
    const result = Array.from({ length: Number(count) }, (_, index) => shift(start, index));
    return result.every(Boolean) ? result : [];
  }
  function create({ root, load, start, selected = [], summaryIds = {}, onChange = () => {}, onPageChange = () => {} }) {
    let pageStart = valid(start) ? start : new Date().toISOString().slice(0, 7);
    let selectedToPay = new Set(selected.filter(valid));
    const balances = new Map();
    let locked = false, loading = false, error = "", mode = "live", revision = 0, destroyed = false;
    const isPaid = (row) => Number(row?.fee) > 0 && Number(row?.balance) === 0;
    const isBlocked = (row) => Boolean(row?.blockedReason);
    const payable = (row) => row && Number(row.balance) > 0 && !isBlocked(row);
    const periods = () => [...selectedToPay].sort();
    function selection() {
      const chosen = periods();
      return { periods: chosen, count: chosen.length, total: chosen.reduce((sum, period) => sum + Number(balances.get(period)?.balance || 0), 0), loading, error, ready: !loading && !error && chosen.length > 0 && chosen.every((period) => payable(balances.get(period))), mode, start: pageStart };
    }
    function publish() { render(); onChange(selection()); }
    function render() {
      if (destroyed || !root.isConnected) return;
      const focusedPeriod = root.contains(document.activeElement) ? document.activeElement?.dataset?.paymentPeriod : "";
      const state = selection();
      const page = range(pageStart, 12).length ? range(pageStart, 12) : Array.from({ length: 12 }, (_, index) => shift(pageStart, index)).filter(Boolean);
      const monthLabel = window.paymentMonths.label;
      root.classList.add("payment-month-picker");
      root.innerHTML = `<div class="payment-calendar-head"><button type="button" class="secondary" data-payment-nav="previous" aria-label="Afficher les douze mois précédents" ${locked || loading || !shift(pageStart, -12) ? "disabled" : ""}>←</button><strong>${escape(monthLabel(page[0]))} – ${escape(monthLabel(page[page.length - 1]))}</strong><button type="button" class="secondary" data-payment-nav="next" aria-label="Afficher les douze mois suivants" ${locked || loading || !shift(pageStart, 12) ? "disabled" : ""}>→</button></div><p class="payment-calendar-mode">${mode === "sandbox" ? "Mode test : les règlements affichés sont des tests, sans encaissement réel." : "Soldes réels de l’élève."}</p><p class="payment-calendar-help">Cochez les mois à régler. Vos choix sont conservés quand vous changez d’année.</p>${loading ? '<p class="payment-calendar-status" role="status">Chargement des soldes…</p>' : ""}${error ? `<p class="payment-calendar-error" role="alert">${escape(error)} <button type="button" class="secondary" data-payment-retry>Réessayer</button></p>` : ""}<div class="payment-calendar-grid">${page.map((period) => {
        const row = balances.get(period), paid = isPaid(row), blocked = isBlocked(row), checked = paid || (!blocked && selectedToPay.has(period));
        let status = "Chargement…";
        if (row) status = paid ? "Payé" : blocked ? "Paiement en cours" : Number(row.fee) <= 0 ? "Non facturé" : Number(row.paid) > 0 ? "Partiel · reste " + money(row.balance) : "À payer · " + money(row.balance);
        return `<label class="payment-calendar-month${paid ? " is-paid" : blocked ? " is-pending" : checked ? " is-selected" : ""}"><input type="checkbox" data-payment-period="${period}" aria-label="${escape(monthLabel(period) + " · " + status)}" ${checked ? "checked" : ""} ${locked || loading || !payable(row) ? "disabled" : ""}><span><strong>${escape(monthLabel(period))}</strong><small>${escape(status)}</small></span></label>`;
      }).join("")}</div><div class="payment-selection-summary" aria-live="polite"><p><strong data-payment-count>${state.count} mois sélectionné${state.count > 1 ? "s" : ""}</strong><strong data-payment-total${summaryIds.total ? ` id="${escape(summaryIds.total)}"` : ""}>${money(state.total)}</strong></p><p class="payment-selection-list" data-payment-selected${summaryIds.selected ? ` id="${escape(summaryIds.selected)}"` : ""}>${state.count ? state.periods.map((period) => escape(monthLabel(period))).join(", ") : "Aucun mois à payer sélectionné."}</p><small>Les mois déjà payés restent cochés et sont exclus du total. Le montant définitif est confirmé par le serveur.</small></div>`;
      root.querySelectorAll("[data-payment-period]").forEach((input) => input.addEventListener("change", () => {
        if (locked || loading || !payable(balances.get(input.dataset.paymentPeriod))) return;
        if (input.checked) selectedToPay.add(input.dataset.paymentPeriod); else selectedToPay.delete(input.dataset.paymentPeriod);
        publish();
      }));
      root.querySelectorAll("[data-payment-nav]").forEach((button) => button.addEventListener("click", () => {
        const next = shift(pageStart, button.dataset.paymentNav === "next" ? 12 : -12);
        if (next && !locked && !loading) { pageStart = next; onPageChange(next); refresh(); }
      }));
      root.querySelector("[data-payment-retry]")?.addEventListener("click", () => refresh());
      if (focusedPeriod) root.querySelector(`[data-payment-period="${focusedPeriod}"]`)?.focus({ preventScroll: true });
    }
    async function refresh({ clear = false } = {}) {
      const requestRevision = ++revision;
      if (clear) balances.clear();
      loading = true; error = ""; publish();
      const starts = new Set([pageStart]);
      for (const period of periods()) if (!balances.has(period) && ![...starts].some((start) => period >= start && period <= (shift(start, 11) || "2099-12"))) starts.add(period);
      try {
        const results = await Promise.all([...starts].map((period) => load(period)));
        if (destroyed || requestRevision !== revision) return;
        for (const result of results) {
          mode = result.mode === "sandbox" ? "sandbox" : "live";
          for (const row of result.months || []) if (valid(row.period)) balances.set(row.period, row);
        }
        for (const period of periods()) {
          const row = balances.get(period);
          if (!row || isPaid(row) || Number(row.balance) <= 0 || (isBlocked(row) && !locked)) selectedToPay.delete(period);
        }
      } catch (failure) {
        if (destroyed || requestRevision !== revision) return;
        error = failure.message || "Les soldes sont indisponibles. Réessayez.";
      } finally {
        if (!destroyed && requestRevision === revision) { loading = false; publish(); }
      }
    }
    render();
    return {
      selection,
      refresh,
      setLocked(value) { locked = Boolean(value); render(); },
      setStart(value) { if (valid(value) && !locked) { pageStart = value; onPageChange(value); return refresh(); } },
      chooseRange(value, count) {
        if (locked) return Promise.resolve();
        selectedToPay = new Set(range(value, count));
        if (valid(value)) pageStart = value;
        onPageChange(pageStart);
        return refresh();
      },
      clearSelection() { selectedToPay.clear(); publish(); },
      destroy() { destroyed = true; revision += 1; },
    };
  }
  window.paymentMonthPicker = { create, range, shift };
})();
