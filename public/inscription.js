"use strict";
const $ = (id) => document.getElementById(id);
const money = (amount) => new Intl.NumberFormat("fr-FR").format(amount) + " FCFA";
let catalogue = null;
let current = null, paymentToken = "", order = null, transactionId = "", receipt = null;

async function request(path, body, scoped = false, options = {}) {
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
  if (!response.ok) throw Error(result.error || "Impossible de terminer la demande.");
  return result;
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
  if (receipt) {
    $("receipt-reference").textContent = receipt.orderId;
    $("receipt-amount").textContent = money(order.amount);
    $("receipt-mode").textContent = receipt.sandbox ? "Paiement de test : aucun encaissement réel." : "Votre paiement a été vérifié auprès de KKiaPay.";
  }
  window.scrollTo(0, 0);
}

$("class").onchange = fee;
$("download-receipt").onclick = async () => {
  if (!receipt || !paymentToken) return;
  const button = $("download-receipt");
  button.disabled = true;
  try {
    const response = await fetch("/api/registration-payments/receipt.pdf?orderId=" + encodeURIComponent(receipt.orderId), { headers: { Authorization: "Bearer " + paymentToken }, credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw Error((await response.json()).error || "Reçu indisponible.");
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a"); link.href = url; link.download = "recu-" + current.reference + ".pdf"; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { $("payment-status").textContent = error.message; }
  finally { button.disabled = false; }
};
$("retry-catalogue").onclick = loadCatalogue;
$("registration").onsubmit = async (event) => {
  event.preventDefault();
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
    order = null;
    confirmed();
  } catch (error) {
    $("error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
};

$("pay").onclick = async () => {
  const button = $("pay");
  button.disabled = true;
  $("payment-status").textContent = "Préparation du paiement…";
  try {
    const config = await request("/api/registration-payments/config", undefined, true);
    if (!config.configured) throw Error("Le paiement en ligne n’est pas encore activé. Votre préinscription est bien reçue. Contactez l’établissement.");
    if (typeof openKkiapayWidget !== "function") throw Error("Le module de paiement ne peut pas être chargé. Réessayez.");
    order = await request("/api/registration-payments/checkout", { period: new Date().toLocaleDateString("en-CA").slice(0, 7) }, true);
    transactionId = "";
    $("retry-confirmation").hidden = true;
    $("payment-status").textContent = order.sandbox ? "KKiaPay est en mode test. Aucun encaissement réel." : "Confirmez le paiement dans la fenêtre KKiaPay. Votre inscription est déjà reçue.";
    openKkiapayWidget({ amount: order.amount, key: order.publicKey, sandbox: order.sandbox, fullname: current.name, phone: current.phone, data: order.data, position: "center", theme: "#205bcb" });
  } catch (error) {
    $("payment-status").textContent = error.message;
  } finally {
    button.disabled = false;
  }
};

async function verifyPayment() {
  if (!order || !transactionId) return;
  $("retry-confirmation").disabled = true;
  $("pay").disabled = true;
  $("payment-status").textContent = "Vérification du paiement auprès de KKiaPay…";
  try {
    receipt = await request("/api/registration-payments/confirm", { orderId: order.orderId, transactionId }, true);
    $("retry-confirmation").hidden = true;
    $("payment-status").textContent = "";
    confirmed();
  } catch (error) {
    $("payment-status").textContent = error.message + " Ne payez pas une seconde fois : utilisez la vérification ci-dessous.";
    $("retry-confirmation").hidden = false;
  } finally {
    $("retry-confirmation").disabled = false;
    $("pay").disabled = !!transactionId && !receipt;
  }
}

if (typeof addSuccessListener === "function") addSuccessListener(async (response) => {
  if (!order) return;
  transactionId = response.transactionId;
  closeKkiapayWidget();
  await verifyPayment();
});
if (typeof addFailedListener === "function") addFailedListener(() => {
  $("payment-status").textContent = "Le paiement a échoué ou a été annulé. Votre préinscription est conservée. Vous pouvez réessayer.";
});
$("retry-confirmation").onclick = verifyPayment;
$("new-registration").onclick = () => {
  current = null;
  paymentToken = "";
  order = null;
  transactionId = "";
  receipt = null;
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
  window.scrollTo(0, 0);
  loadCatalogue();
};
loadCatalogue();
