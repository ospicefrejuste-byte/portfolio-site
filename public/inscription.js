"use strict";
const $ = (id) => document.getElementById(id);
const money = (amount) => new Intl.NumberFormat("fr-FR").format(amount) + " FCFA";
let catalogue = null;
let current = null, paymentToken = "", order = null, transactionId = "", receipt = null;
let pendingRequests = 0;
let paymentAttempt = null, paymentBusy = false, paymentVerifying = false, widgetActive = false, providerPending = false;
let paymentPicker = null, paymentConfig = null, lastConfirmed = null;
window.crsHasUnsavedWork = () => pendingRequests > 0 || Boolean(current || paymentToken || order || transactionId);

async function request(path, body, scoped = false, options = {}) {
  pendingRequests += 1;
  try {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(scoped ? { Authorization: "Bearer " + paymentToken } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    ...options,
  });
  const result = await response.json();
  if (!response.ok) {
    const error = Error(result.error || "Impossible de terminer la demande.");
    error.status = response.status;
    throw error;
  }
  return result;
  } finally {
    pendingRequests -= 1;
  }
}

function enableRegistration(enabled) {
  $("registration").querySelectorAll("input, select, button").forEach((control) => {
    control.disabled = !enabled;
  });
}

function fee() {
  const selected = catalogue && catalogue.levels.find(([name]) => name === $("class").value);
  $("fee").textContent = selected ? money(selected[1]) + " / mois" : "—";
}

function options(select, values) {
  const previous = select.value;
  select.replaceChildren(...values.map((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    return option;
  }));
  if (values.includes(previous)) select.value = previous;
}

function showBrand(school) {
  const name = String(school.name || "COURS DE RENFORCEMENT SCOLAIRE");
  $("school-name").textContent = name;
  $("footer-school-name").textContent = name;
  $("school-tagline").textContent = String(school.tagline || "");
  $("school-description").textContent = String(school.description || "");
  document.title = "Inscription · " + name;
  document.querySelector('meta[name="description"]').content = String(school.description || "Inscription aux cours de renforcement scolaire.");
  const logo = $("school-logo");
  logo.hidden = true;
  logo.removeAttribute("src");
  $("school-monogram").hidden = false;
  if (school.logoUrl) {
    try {
      const url = new URL(school.logoUrl);
      const embedded = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(school.logoUrl);
      if (!embedded && (url.protocol !== "https:" || url.username || url.password)) throw Error("Logo non valide");
      logo.referrerPolicy = "no-referrer";
      logo.onload = () => { logo.hidden = false; $("school-monogram").hidden = true; };
      logo.onerror = () => { logo.hidden = true; $("school-monogram").hidden = false; };
      logo.src = url.href;
    } catch (_) { /* Keep the monogram if a logo is unavailable. */ }
  }
  $("school-contacts").replaceChildren(...(Array.isArray(school.phones) ? school.phones : []).map((phone) => {
    const link = document.createElement("a");
    const digits = String(phone).replace(/[^0-9+]/g, "");
    link.textContent = String(phone);
    link.href = "tel:" + digits;
    return link;
  }));
}

async function loadCatalogue() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  catalogue = null;
  enableRegistration(false);
  $("fee").textContent = "—";
  $("catalogue-message").hidden = false;
  $("catalogue-message").classList.remove("is-error");
  $("catalogue-status").textContent = "Chargement des classes et des tarifs…";
  $("retry-catalogue").hidden = true;
  try {
    const school = await request("/api/catalogue", undefined, false, { signal: controller.signal });
    if (!Array.isArray(school.levels) || !school.levels.length ||
        school.levels.some((level) => !Array.isArray(level) || typeof level[0] !== "string" || !level[0].trim() || !Number.isSafeInteger(level[1]) || level[1] < 0) ||
        !Array.isArray(school.centres) || !school.centres.length || school.centres.some((name) => typeof name !== "string" || !name.trim()) ||
        !Array.isArray(school.subjects) || !school.subjects.length || school.subjects.some((name) => typeof name !== "string" || !name.trim())) {
      throw Error("Les informations d’inscription sont indisponibles.");
    }
    catalogue = school;
    showBrand(school);
    options($("class"), school.levels.map(([name]) => name));
    options($("centre"), school.centres);
    const subjects = school.subjects.map((subject) => {
      const label = document.createElement("label");
      label.className = "choice";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "subjects";
      input.value = subject;
      input.checked = true;
      input.defaultChecked = true;
      label.append(input, document.createTextNode(subject));
      return label;
    });
    $("subjects-list").replaceChildren(...subjects);
    fee();
    enableRegistration(true);
    $("catalogue-message").hidden = true;
  } catch (_) {
    $("catalogue-message").classList.add("is-error");
    $("catalogue-status").textContent = "Impossible de charger les classes et les tarifs. Réessayez avant de vous inscrire.";
    $("retry-catalogue").hidden = false;
  } finally {
    clearTimeout(timeout);
  }
}

function paymentSelection() {
  return { periods: paymentPicker?.selection().periods || [] };
}

function updatePaymentChoice() {
  if (!current) return;
  const selection = paymentPicker?.selection();
  const count = paymentAttempt ? paymentAttempt.periods.length : selection?.count || 0;
  $("pay").textContent = order || paymentAttempt ? "Reprendre le même paiement" : count === 1 ? "Payer les frais du mois" : "Payer " + count + " mois";
  const locked = paymentBusy || Boolean(paymentAttempt) || Boolean(receipt);
  $("payment-period").disabled = locked;
  $("payment-month-count").disabled = locked;
  paymentPicker?.setLocked(locked);
  $("pay").disabled = paymentBusy || widgetActive || providerPending || Boolean(transactionId) || Boolean(receipt) || !paymentConfig?.configured || (!paymentAttempt && !selection?.ready);
  $("new-registration").disabled = paymentBusy || Boolean(paymentAttempt && !receipt);
  $("another-payment").hidden = !receipt;
  $("another-payment").disabled = paymentBusy;
  $("payment-note").textContent = !paymentConfig ? "Chargement des disponibilités du paiement…" : !paymentConfig.configured ? "Le paiement en ligne est différé jusqu’à son activation par l’établissement. Les soldes réels et votre choix de mois sont disponibles." : paymentConfig.sandbox ? "KKiaPay est en mode test : aucun encaissement réel. Les règlements de test sont distincts des paiements réels." : "Le paiement sera confirmé après vérification auprès de KKiaPay.";
}

async function initializePaymentChoice() {
  paymentPicker?.destroy();
  paymentConfig = null;
  const token = paymentToken, registration = current;
  const start = new Date().toISOString().slice(0, 7);
  $("payment-period").value = start;
  $("payment-month-count").value = "1";
  paymentPicker = window.paymentMonthPicker.create({
    root: $("payment-month-picker"), start, selected: [start],
    summaryIds: { total: "payment-total", selected: "payment-months" },
    load: (period) => request("/api/registration-payments/months?start=" + encodeURIComponent(period), undefined, true),
    onPageChange: (period) => { $("payment-period").value = period; },
    onChange: updatePaymentChoice,
  });
  updatePaymentChoice();
  const loading = paymentPicker.refresh();
  try {
    const config = await request("/api/registration-payments/config", undefined, true);
    if (paymentToken !== token || current !== registration) return;
    paymentConfig = config;
  } catch (error) {
    if (paymentToken !== token || current !== registration) return;
    $("payment-status").textContent = error.message;
  }
  await loading;
  if (paymentToken === token && current === registration) updatePaymentChoice();
}

$("payment-period").value = new Date().toISOString().slice(0, 7);
$("payment-period").onchange = () => paymentPicker?.setStart($("payment-period").value);
$("payment-month-count").onchange = () => paymentPicker?.chooseRange($("payment-period").value, Number($("payment-month-count").value));

function confirmed() {
  $("registration-panel").hidden = true;
  $("welcome-panel").hidden = true;
  $("page-shell").classList.add("confirmation-mode");
  $("confirmation").hidden = false;
  $("student-name").textContent = current.name;
  $("reference").textContent = current.reference;
  $("summary-class").textContent = current.class;
  $("summary-centre").textContent = current.centre;
  $("amount").textContent = money(current.monthlyFee);
  $("paid").hidden = !receipt;
  $("pay").hidden = !!receipt;
  $("payment-note").hidden = !!receipt;
  $("payment-choice").hidden = false;
  updatePaymentChoice();
  $("paid").hidden = !lastConfirmed;
  if (lastConfirmed) {
    $("receipt-reference").textContent = lastConfirmed.receipt.orderId;
    $("receipt-amount").textContent = money(lastConfirmed.order.amount);
    $("receipt-months").textContent = window.paymentMonths.labels(lastConfirmed.order).join(", ");
    $("receipt-mode").textContent = lastConfirmed.receipt.sandbox ? "Paiement de test : aucun encaissement réel." : "Votre paiement a été vérifié auprès de KKiaPay.";
  }
  window.scrollTo(0, 0);
}

$("class").onchange = fee;
$("download-receipt").onclick = async () => {
  if (!lastConfirmed || !paymentToken) return;
  const button = $("download-receipt");
  button.disabled = true;
  try {
    const response = await fetch("/api/registration-payments/receipt.pdf?orderId=" + encodeURIComponent(lastConfirmed.receipt.orderId), { headers: { Authorization: "Bearer " + paymentToken }, credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw Error((await response.json()).error || "Reçu indisponible.");
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a"); link.href = url; link.download = "recu-" + current.reference + ".pdf"; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { $("payment-status").textContent = error.message; }
  finally { button.disabled = false; }
};
$("retry-catalogue").onclick = loadCatalogue;
$("registration").onsubmit = async (event) => {
  event.preventDefault();
  if (current || paymentBusy || paymentAttempt) return;
  $("error").textContent = "";
  if (!catalogue) {
    $("error").textContent = "Chargez les classes et les tarifs avant de vous inscrire.";
    return;
  }
  const data = new FormData(event.target);
  const name = String(data.get("name") || "").trim();
  const guardian = String(data.get("guardian") || "").trim();
  const phone = String(data.get("phone") || "").trim();
  const subjects = data.getAll("subjects");
  if (!name || !guardian) {
    $("error").textContent = "Renseignez les noms de l’élève et du responsable.";
    return;
  }
  if (!/^[+0-9 ()-]{8,20}$/.test(phone) || phone.replace(/\D/g, "").length < 8 || phone.replace(/\D/g, "").length > 15) {
    $("error").textContent = "Renseignez un numéro de téléphone contenant entre 8 et 15 chiffres.";
    return;
  }
  if (!subjects.length || !$("consent").checked) {
    $("error").textContent = "Choisissez une matière et acceptez la transmission de la préinscription.";
    return;
  }
  const body = { name, guardian, phone, subjects, class: data.get("class"), centre: data.get("centre"), consent: true };
  const button = event.target.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const result = await request("/api/registrations", body);
    current = { ...body, ...result };
    paymentToken = result.paymentToken;
    receipt = null;
    lastConfirmed = null;
    order = null;
    transactionId = "";
    paymentAttempt = null;
    widgetActive = false;
    providerPending = false;
    $("payment-period").value = new Date().toISOString().slice(0, 7);
    $("payment-month-count").value = "1";
    confirmed();
    initializePaymentChoice();
  } catch (error) {
    $("error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
};

$("pay").onclick = async () => {
  if (!current || paymentBusy || widgetActive || providerPending || transactionId || receipt) return;
  const selection = paymentAttempt || paymentSelection();
  if (!selection.periods.length || (!paymentAttempt && !paymentPicker?.selection().ready)) {
    $("payment-status").textContent = "Choisissez au moins un mois à régler et attendez le chargement des soldes.";
    return;
  }
  paymentBusy = true;
  updatePaymentChoice();
  $("payment-status").textContent = "Préparation du paiement…";
  try {
    const config = await request("/api/registration-payments/config", undefined, true);
    paymentConfig = config;
    if (!config.configured) throw Error("Le paiement en ligne est différé : il n’est pas encore activé. Votre choix de mois et votre préinscription sont conservés. Contactez l’établissement.");
    if (typeof openKkiapayWidget !== "function") throw Error("Le module de paiement ne peut pas être chargé. Réessayez.");
    if (!paymentAttempt) paymentAttempt = { ...selection, token: paymentToken, registration: current };
    const attempt = paymentAttempt;
    if (!order) {
      const checkout = await request("/api/registration-payments/checkout", { periods: [...attempt.periods] }, true);
      if (paymentAttempt !== attempt || paymentToken !== attempt.token || current !== attempt.registration) return;
      order = checkout;
      paymentPicker?.refresh();
    }
    transactionId = "";
    $("retry-confirmation").hidden = true;
    $("payment-status").textContent = order.sandbox ? "KKiaPay est en mode test. Aucun encaissement réel." : "Confirmez le paiement dans la fenêtre KKiaPay. Votre inscription est déjà reçue.";
    widgetActive = true;
    paymentBusy = false;
    openKkiapayWidget({ amount: order.amount, key: order.publicKey, sandbox: order.sandbox, fullname: attempt.registration.name, phone: attempt.registration.phone, data: order.data, position: "center", theme: "#205bcb" });
  } catch (error) {
    widgetActive = false;
    if (!order && error.status >= 400 && error.status < 500) paymentAttempt = null;
    if (paymentAttempt || error.status === 409) paymentPicker?.refresh();
    $("payment-status").textContent = error.message;
  } finally {
    if (!paymentVerifying) paymentBusy = false;
    updatePaymentChoice();
  }
};

async function verifyPayment() {
  if (!order || !transactionId || paymentBusy || paymentVerifying || receipt) return;
  const attempt = paymentAttempt, confirmedOrder = order, confirmedTransaction = transactionId;
  paymentBusy = true;
  paymentVerifying = true;
  updatePaymentChoice();
  $("retry-confirmation").disabled = true;
  $("pay").disabled = true;
  $("payment-status").textContent = "Vérification du paiement auprès de KKiaPay…";
  try {
    const result = await request("/api/registration-payments/confirm", { orderId: confirmedOrder.orderId, transactionId: confirmedTransaction }, true);
    if (paymentAttempt !== attempt || order !== confirmedOrder || transactionId !== confirmedTransaction) return;
    receipt = result;
    lastConfirmed = { receipt: result, order: confirmedOrder };
    paymentPicker?.clearSelection();
    await paymentPicker?.refresh({ clear: true });
    $("retry-confirmation").hidden = true;
    $("payment-status").textContent = "";
    confirmed();
  } catch (error) {
    $("payment-status").textContent = error.message + " Ne payez pas une seconde fois : utilisez la vérification ci-dessous.";
    $("retry-confirmation").hidden = false;
  } finally {
    paymentVerifying = false;
    paymentBusy = false;
    $("retry-confirmation").disabled = false;
    updatePaymentChoice();
  }
}

if (typeof addSuccessListener === "function") addSuccessListener(async (response) => {
  if (!order || !paymentAttempt || paymentBusy || transactionId || receipt || !response?.transactionId) return;
  transactionId = response.transactionId;
  widgetActive = false;
  providerPending = false;
  closeKkiapayWidget();
  await verifyPayment();
});
function pausePayment() {
  if (!order || paymentBusy || transactionId || receipt) return;
  if (providerPending) {
    widgetActive = false;
    updatePaymentChoice();
    return;
  }
  closeKkiapayWidget();
  widgetActive = false;
  $("payment-status").textContent = "Le paiement n’est pas confirmé. Votre préinscription et les mois choisis sont conservés. Vous pouvez reprendre le même paiement.";
  updatePaymentChoice();
}
function failedPayment() {
  if (paymentBusy || transactionId || receipt) return;
  providerPending = false;
  pausePayment();
}
if (typeof addFailedListener === "function") addFailedListener(failedPayment);
if (typeof addKkiapayCloseListener === "function") addKkiapayCloseListener(pausePayment);
if (typeof addPaymentAbortedListener === "function") addPaymentAbortedListener(failedPayment);
if (typeof addPendingListener === "function") addPendingListener(async (response) => {
  if (!order || transactionId || receipt) return;
  if (response?.transactionId && !paymentBusy) {
    transactionId = response.transactionId;
    widgetActive = false;
    closeKkiapayWidget();
    await verifyPayment();
    return;
  }
  providerPending = true;
  $("payment-status").textContent = "Le paiement est en cours de traitement. Attendez la confirmation avant de payer à nouveau.";
  updatePaymentChoice();
});
$("retry-confirmation").onclick = verifyPayment;
$("another-payment").onclick = async () => {
  if (!receipt || paymentBusy || !current) return;
  receipt = null;
  order = null;
  transactionId = "";
  paymentAttempt = null;
  widgetActive = false;
  providerPending = false;
  $("payment-status").textContent = "";
  $("retry-confirmation").hidden = true;
  paymentPicker?.setLocked(false);
  paymentPicker?.clearSelection();
  confirmed();
  await paymentPicker?.refresh({ clear: true });
};
$("new-registration").onclick = () => {
  if (paymentBusy || (paymentAttempt && !receipt)) return;
  current = null;
  paymentToken = "";
  order = null;
  transactionId = "";
  receipt = null;
  lastConfirmed = null;
  paymentPicker?.destroy();
  paymentPicker = null;
  paymentConfig = null;
  paymentAttempt = null;
  widgetActive = false;
  providerPending = false;
  $("registration").reset();
  fee();
  $("confirmation").hidden = true;
  $("registration-panel").hidden = false;
  $("welcome-panel").hidden = false;
  $("page-shell").classList.remove("confirmation-mode");
  $("error").textContent = "";
  $("payment-status").textContent = "";
  $("retry-confirmation").hidden = true;
  $("pay").disabled = false;
  $("new-registration").disabled = false;
  window.scrollTo(0, 0);
  loadCatalogue();
};
loadCatalogue();
