"use strict";
const levels = [
  ["6e", 3500],
  ["4e", 4000],
  ["3e", 4500],
  ["Seconde D – C", 4500],
  ["Première D – C", 4500],
  ["Terminale D – C", 5000],
];
const formatFee = (n) => new Intl.NumberFormat("fr-FR").format(n) + " F CFA";
const select = document.getElementById("registration-class");
select.innerHTML = levels.map(([name]) => `<option>${name}</option>`).join("");
const updateFee = () =>
  (document.getElementById("registration-fee").textContent =
    formatFee(levels.find(([name]) => name === select.value)[1]) + " / mois");
select.onchange = updateFee;
updateFee();
document.getElementById("price-grid").innerHTML = levels
  .map(
    ([name, fee], i) =>
      `<a class="price-card ${i === 5 ? "featured" : ""}" href="#inscription" data-class="${name}"><span class="price-level">${name}</span><strong>${new Intl.NumberFormat("fr-FR").format(fee)} <small>F / mois</small></strong><span class="price-link">Choisir cette classe <b>→</b></span></a>`,
  )
  .join("");
document.querySelectorAll("[data-class]").forEach(
  (a) =>
    (a.onclick = () => {
      select.value = a.dataset.class;
      updateFee();
    }),
);
document
  .querySelectorAll("[data-centre]")
  .forEach(
    (a) =>
      (a.onclick = () =>
        (document.getElementById("registration-centre").value =
          a.dataset.centre)),
  );
document.getElementById("registration").onsubmit = async (e) => {
  e.preventDefault();
  const form = e.target,
    data = new FormData(form),
    result = document.getElementById("registration-result"),
    button = form.querySelector("button");
  const subjects = data.getAll("subjects");
  if (!subjects.length) {
    result.textContent = "Choisissez au moins une matière.";
    return;
  }
  const body = {
    name: data.get("name").trim(),
    class: data.get("class"),
    centre: data.get("centre"),
    guardian: data.get("guardian").trim(),
    phone: data.get("phone").trim(),
    subjects,
    consent: form.querySelector(".consent input").checked,
  };
  button.disabled = true;
  result.textContent = "Envoi en cours…";
  try {
    const response = await schoolAPI.request(
      "/api/registrations",
      "POST",
      body,
    );
    result.textContent =
      "Préinscription reçue ! Référence : " +
      response.reference +
      ". L’administration vous contactera pour confirmer votre inscription.";
    form.reset();
    updateFee();
  } catch (err) {
    result.textContent = err.message;
  } finally {
    button.disabled = false;
  }
};
