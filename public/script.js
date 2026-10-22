"use strict";
window.addEventListener("pageshow", (event) => { if (event.persisted) location.reload(); });
window.addEventListener("pagehide", () => { document.body.style.visibility = "hidden"; });
let db = {
  students: [],
  teachers: [],
  courses: [],
  attendance: [],
  payments: [],
  grades: [],
};
let role = "",
  identity = "",
  page = "dashboard",
  search = "",
  user = null,
  users = [],
  paymentChannel = "all",
  paymentConfig = { configured: false, sandbox: true },
  paymentOrders = [];
const catalogue = {
  levels: [
    ["6e", 3500],
    ["4e", 4000],
    ["3e", 4500],
    ["Seconde D – C", 4500],
    ["Première D – C", 4500],
    ["Terminale D – C", 5000],
  ],
  centres: ["CSP Les Adorables de la Cité", "CP La Boussole", "EPP Borarou"],
  subjects: ["Mathématiques", "Physique-Chimie", "SVT"],
};
const $ = (id) => document.getElementById(id);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const student = (id) => db.students.find((s) => s.id === id);
const course = (id) => db.courses.find((c) => c.id === id);
const teacher = (id) => db.teachers.find((t) => t.id === id);
function groupCentre(group) {
  const locations = [...new Set(db.students.filter((s) => s.group === group).map((s) => s.centre || ""))];
  return locations.length === 1 ? locations[0] : "";
}
const money = (n) => new Intl.NumberFormat("fr-FR").format(n) + " FCFA";
const date = (d) =>
  new Date(d + "T12:00:00").toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
const sections = {
  dashboard: ["◈", "Tableau de bord"],
  cashier: ["▣", "Caisse en présentiel"],
  dailyAttendance: ["✓", "Présences du jour"],
  students: ["♙", "Élèves"],
  teachers: ["♧", "Enseignants"],
  courses: ["▦", "Cours & planning"],
  attendance: ["✓", "Présences par cours"],
  payments: ["◇", "Paiements"],
  grades: ["▤", "Notes & résultats"],
  users: ["♧", "Comptes & accès"],
};
window.crsHasUnsavedWork = () => schoolAPI.pendingRequests > 0 || currentOrder !== null || Boolean(checkoutDraft?.locked) || (typeof cashierState !== "undefined" && cashierState.intents.size > 0) || (typeof window.hasDailyDrafts === "function" && window.hasDailyDrafts());
window.crsPrepareReload = () => {
  if (!accessibleSections().includes(page)) return;
  const url = new URL(location.href);
  url.searchParams.set("section", page);
  history.replaceState(null, "", url);
};
const visibleCourses = () =>
  db.courses.filter(
    (c) =>
      role === "admin" ||
      (role === "teacher"
        ? c.teacher === identity
        : c.group === student(identity)?.group),
  );
const visibleStudents = () =>
  db.students.filter(
    (s) =>
      role === "admin" ||
      (role === "student"
        ? s.id === identity
        : visibleCourses().some((c) => c.group === s.group)),
  );
function toast(message) {
  $("toast").textContent = message;
  $("toast").style.display = "block";
  setTimeout(() => ($("toast").style.display = "none"), 3000);
}
async function refresh() {
  Object.assign(catalogue, await schoolAPI.request("/api/catalogue"));
  db = await schoolAPI.request("/api/data");
  if (typeof invalidateMonthlyBalances === "function") invalidateMonthlyBalances();
  if (typeof invalidateCashier === "function") invalidateCashier();
  if (typeof invalidateDailyAttendance === "function") invalidateDailyAttendance();
  const brand = document.querySelector(".brand");
  if (brand) {
    brand.querySelector("span:last-child").textContent = catalogue.name;
    const logo = brand.querySelector(".logo");
    logo.replaceChildren();
    if (catalogue.logoUrl) {
      const image = document.createElement("img"); image.src = catalogue.logoUrl; image.alt = "Logo de l’établissement"; image.style.cssText = "width:100%;height:100%;object-fit:contain"; logo.append(image);
    } else logo.textContent = "CR";
  }
  document.title = catalogue.name;
  const footer = document.querySelector("main > footer");
  if (footer) footer.firstChild.textContent = catalogue.name + " ";
  if (role === "admin") users = await schoolAPI.request("/api/admin/users");
  if (["admin", "student"].includes(role)) {
    paymentConfig = await schoolAPI.request("/api/payments/config");
    paymentOrders = await schoolAPI.request("/api/payments/orders");
  }
}
function handleError(err) {
  if (err.status === 401) {
    location.assign(role === "cashier" ? "/connexion.html?espace=caisse" : "/connexion.html");
    return;
  }
  toast(err.message || "Serveur indisponible. Réessayez.");
}
function accessibleSections() {
  return Object.keys(sections).filter((x) =>
    role === "admin" ||
    (role === "cashier" && ["cashier", "dailyAttendance"].includes(x)) ||
    (["teacher", "student"].includes(role) &&
      (["dashboard", "courses", "calendar", "attendance", "grades"].includes(x) ||
        (role === "student" && x === "payments"))));
}
function navigation() {
  const entries = accessibleSections();
  $("nav").innerHTML = entries
    .map(
      (x) =>
        `<button data-page="${x}" class="${page === x ? "active" : ""}"><span>${sections[x][0]}</span>${sections[x][1]}</button>`,
    )
    .join("");
  $("nav")
    .querySelectorAll("button")
    .forEach(
      (b) =>
        (b.onclick = () => {
          page = b.dataset.page;
          search = "";
          window.crsPrepareReload();
          render();
        }),
    );
}
function table(headers, rows) {
  return rows.length
    ? `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`
    : '<div class="empty">Aucune donnée à afficher.</div>';
}
function person(s) {
  return `<span class="avatar">${esc(
    s.name
      .split(" ")
      .map((p) => p[0])
      .slice(0, 2)
      .join(""),
  )}</span>${esc(s.name)}`;
}
function panel(title, subtitle, body) {
  return `<div class="panel"><div class="panel-head"><div><h2>${title}</h2><p>${subtitle}</p></div></div>${body}</div>`;
}
function accountDashboard() {
  const students = visibleStudents(),
    courses = visibleCourses();
  const grades = db.grades.filter(
    (g) =>
      students.some((s) => s.id === g.student) &&
      courses.some((c) => c.id === g.course),
  );
  const average = grades.length
    ? (grades.reduce((s, g) => s + Number(g.score), 0) / grades.length).toFixed(
        1,
      )
    : "—";
  const payments = db.payments.filter((p) =>
    students.some((s) => s.id === p.student),
  );
  const future = courses
    .filter((c) => new Date(c.date + "T" + c.time).getTime() + Number(c.duration) * 60000 > Date.now())
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const stats =
    role === "teacher"
      ? [
          ["Élèves accompagnés", students.length, "Dans vos groupes"],
          ["Cours planifiés", courses.length, "Toutes les séances"],
          ["Moyenne des notes", average + " / 20", "Évaluations enregistrées"],
          [
            "Présences saisies",
            db.attendance.filter((a) => courses.some((c) => c.id === a.course))
              .length,
            "Statuts renseignés",
          ],
        ]
      : [
          [
            "Élèves inscrits",
            students.length,
            role === "student" ? "Votre dossier" : "Tous les groupes",
          ],
          ["Cours planifiés", courses.length, "Toutes les séances"],
          [
            "Paiements enregistrés",
            money(
              payments
                .filter((p) => p.mode !== "sandbox")
                .reduce((s, p) => s + Number(p.amount), 0),
            ),
            "Total des encaissements",
          ],
          ["Moyenne des notes", average + " / 20", "Évaluations enregistrées"],
        ];
  return `<div class="welcome"><div><h2>${role === "admin" ? "Un nouvel élan pour la réussite." : "Bienvenue, " + esc((role === "teacher" ? teacher(identity) : student(identity))?.name || "") + "."}</h2><p>${role === "admin" ? "Organisez les cours, accompagnez les élèves et suivez leurs progrès.<br>Tout votre établissement dans un seul espace." : "Retrouvez vos cours et suivez les progrès, séance après séance."}</p></div><div class="art">✧</div></div><div class="stats">${stats.map((s) => `<div class="stat"><span class="stat-label">${s[0]}</span><strong>${s[1]}</strong><small>${s[2]}</small></div>`).join("")}</div><div class="columns">${panel(
    "Prochaines séances",
    "Le planning des cours de renforcement",
    future.length
      ? future
          .slice(0, 5)
          .map(
            (c) =>
              `<div class="lesson"><div class="lesson-time">${esc(c.time)}</div><div><strong>${esc(c.subject)}</strong><p>${date(c.date)} · ${esc(c.group)}</p><span class="badge">${esc(c.room)} · ${c.duration} min</span></div></div>`,
          )
          .join("")
      : '<div class="empty">Aucune séance à venir.</div>',
  )}${panel(role === "student" ? "Mon parcours" : "Les groupes", "Des cours adaptés à chaque niveau", [...new Set(students.map((s) => s.group))].map((g) => `<div class="lesson"><div><strong>${esc(g)}</strong><p>${students.filter((s) => s.group === g).length} élève(s) · ${courses.filter((c) => c.group === g).length} séance(s)</p></div></div>`).join("") + '<p class="helper">Les montants sont affichés en FCFA. Les frais peuvent être suivis et réglés depuis l’espace Paiements. Les tests KKiaPay sont identifiés séparément.</p>')}</div>`;
}
const addLabels = {
  students: "Inscrire un élève",
  teachers: "Ajouter un enseignant",
  courses: "Planifier un cours",
  payments: "Enregistrer un paiement",
  grades: "Ajouter une note",
};
function canAdd() {
  return (
    (role === "admin" &&
      ["students", "teachers", "courses", "payments", "grades"].includes(
        page,
      )) ||
    (role === "teacher" && page === "grades")
  );
}
function rowsForPage() {
  let rows = [];
  if (page === "students")
    rows = db.students
      .filter((s) => (s.name + " " + s.group).toLowerCase().includes(search))
      .map(
        (s) =>
          `<tr><td>${person(s)}</td><td>${esc(s.class)}</td><td><span class="badge">${esc(s.centre || "—")}</span></td><td>${esc(s.group)}</td><td>${esc((s.subjects || []).join(", ") || "Non renseignées")}</td><td>${esc(s.registrationStatus || "Inscrit")}</td><td>${actions(s.id)}</td></tr>`,
      );
  if (page === "teachers")
    rows = db.teachers
      .filter((t) => (t.name + " " + t.subject).toLowerCase().includes(search))
      .map(
        (t) =>
          `<tr><td>${person(t)}</td><td>${esc(t.subject)}</td><td>${db.courses.filter((c) => c.teacher === t.id).length} séance(s)</td><td>${actions(t.id)}</td></tr>`,
      );
  if (page === "courses")
    rows = visibleCourses()
      .filter((c) => (c.subject + " " + c.group).toLowerCase().includes(search))
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
      .map(
        (c) =>
          `<tr><td><strong>${esc(c.subject)}</strong></td><td>${esc(c.group)}</td><td>${esc(teacher(c.teacher)?.name || "—")}</td><td>${date(c.date)} · ${esc(c.time)}</td><td>${esc(c.room)} · ${c.duration} min</td>${role === "admin" ? `<td>${actions(c.id)}</td>` : ""}</tr>`,
      );
  if (page === "payments")
    rows = db.payments
      .filter(
        (p) =>
          (paymentChannel === "all" || (paymentChannel === "test" ? p.mode === "sandbox" : p.mode !== "sandbox" && (paymentChannel === "online" ? p.source === "KKiaPay" : p.source !== "KKiaPay"))) &&
          visibleStudents().some((s) => s.id === p.student) &&
          (student(p.student)?.name + " " + window.paymentMonths.allocations(p).map((allocation) => allocation.period).join(" ") + " " + window.paymentMonths.labels(p).join(" "))
            .toLowerCase()
            .includes(search),
      )
      .map(
        (p) =>
          `<tr><td>${esc(student(p.student)?.name)}</td><td>${esc(window.paymentMonths.labels(p).join(", "))}</td><td>${money(p.amount)}</td><td>${date(p.date)}</td><td><span class="badge ${p.mode === "sandbox" ? "orange" : ""}">${p.mode === "sandbox" ? "Test confirmé" : p.source === "KKiaPay" ? "KKiaPay confirmé" : p.source === "Caisse" ? "Caisse en présentiel" : "Saisie administrative"}</span></td><td><button class="secondary" data-receipt="${esc(p.id)}">Reçu</button><a class="secondary" href="/api/payments/${encodeURIComponent(p.id)}/receipt.pdf" download>Télécharger PDF</a>${role === "admin" && p.source !== "KKiaPay" && p.source !== "Caisse" ? actions(p.id) : ""}</td></tr>`,
      );
  if (page === "grades")
    rows = db.grades
      .filter(
        (g) =>
          visibleStudents().some((s) => s.id === g.student) &&
          visibleCourses().some((c) => c.id === g.course) &&
          (
            student(g.student)?.name +
            " " +
            g.label +
            " " +
            course(g.course)?.subject
          )
            .toLowerCase()
            .includes(search),
      )
      .map(
        (g) =>
          `<tr><td>${esc(student(g.student)?.name)}</td><td>${esc(course(g.course)?.subject)}</td><td>${esc(g.label)}</td><td><span class="badge ${g.score < 10 ? "orange" : ""}">${g.score} / 20</span></td>${role !== "student" ? `<td>${actions(g.id)}</td>` : ""}</tr>`,
      );
  return rows;
}
function actions(id) {
  return `<div class="row-actions"><button class="secondary" data-edit="${esc(id)}">Modifier</button><button class="secondary danger" data-delete="${esc(id)}">Supprimer</button></div>`;
}
function list() {
  let headers = {
    students: ["Élève", "Classe", "Centre", "Groupe", "Matières", "Statut", "Actions"],
    teachers: ["Enseignant", "Matière", "Cours", "Actions"],
    courses: ["Matière", "Groupe", "Enseignant", "Date & heure", "Lieu"],
    payments: ["Élève", "Période", "Montant", "Date", "Statut"],
    grades: ["Élève", "Matière", "Évaluation", "Note"],
  }[page].slice();
  if (
    page === "payments" ||
    (page === "courses" && role === "admin") ||
    (page === "grades" && role !== "student")
  )
    headers.push("Actions");
  return `<div class="panel"><div class="toolbar"><input id="search" type="search" placeholder="Rechercher…" aria-label="Rechercher" value="${esc(search)}">${page === "payments" && role === "admin" ? `<label>Type d’encaissement<select id="payment-channel">${[["all", "Tous les paiements"], ["online", "En ligne · KKiaPay"], ["cash", "En présentiel · caisse"], ["test", "Transactions de test"]].map(([value, label]) => `<option value="${value}" ${paymentChannel === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>` : ""}${canAdd() ? `<button class="primary" id="add">+ ${addLabels[page]}</button>` : ""}</div><div id="table">${table(headers, rowsForPage())}</div>${page === "payments" ? '<p class="helper">Les paiements de test sont identifiés et exclus des encaissements réels du tableau de bord.</p>' : ""}</div>`;
}
let selectedCourse = "";
function attendance() {
  const courses = visibleCourses();
  if (!courses.some((c) => c.id === selectedCourse))
    selectedCourse = courses[0]?.id || "";
  const c = course(selectedCourse);
  const students = visibleStudents().filter((s) => s.group === c?.group);
  return `<div class="panel"><div class="filter"><label for="session">Séance</label><select id="session">${courses.map((c) => `<option value="${c.id}" ${c.id === selectedCourse ? "selected" : ""}>${esc(c.subject)} · ${esc(c.group)} · ${date(c.date)} ${c.time}</option>`).join("")}</select></div>${table(
    ["Élève", "Statut"],
    students.map((s) => {
      const a = db.attendance.find(
        (a) => a.student === s.id && a.course === selectedCourse,
      );
      return `<tr><td>${person(s)}</td><td>${role === "student" ? esc(a?.status || "Non renseigné") : `<select data-attendance="${s.id}" aria-label="Présence de ${esc(s.name)}">${["Non renseigné", "Présent", "Absent", "Retard", "Excusé"].map((v) => `<option ${v === (a?.status || "Non renseigné") ? "selected" : ""}>${v}</option>`).join("")}</select>`}</td></tr>`;
    }),
  )}<p class="helper">Chaque statut est enregistré dès sa sélection.</p></div>`;
}
function render() {
  if (!accessibleSections().includes(page)) page = role === "cashier" ? "cashier" : "dashboard";
  navigation();
  $("title").textContent = sections[page][1];
  $("content").innerHTML =
    page === "dashboard"
      ? dashboard()
      : page === "attendance"
        ? attendance()
        : page === "users"
          ? accountsPage()
          : page === "cashier" ? cashierPage()
          : page === "dailyAttendance" ? dailyAttendancePage()
          : page === "payments"
            ? paymentPage()
            : page === "students" && role === "admin" ? enrollmentPage()
              : page === "calendar" ? calendarPage()
                : page === "settings" ? settingsPage()
                  : page === "balances" ? monthlyBalancesPage()
                    : page === "assignments" ? assignmentsPage() : page === "statistics" ? statisticsPage() : page === "help" ? helpPage() : list();
  if (role === "admin" && typeof bindAnalytics === "function") bindAnalytics();
  if (page === "calendar") bindCalendar();
  if (page === "settings" && role === "admin") bindSettings();
  if (page === "balances" && role === "admin") bindMonthlyBalances();
  if (page === "cashier" && ["admin", "cashier"].includes(role)) bindCashier();
  if (page === "dailyAttendance" && ["admin", "cashier"].includes(role)) bindDailyAttendance();
  if ($("add"))
    $("add").onclick = () => (page === "users" ? openUserForm() : openForm());
  if ($("export")) $("export").onclick = exportRecords;
  if ($("pay-online")) $("pay-online").onclick = openCheckout;
  document
    .querySelectorAll("[data-verify-order]")
    .forEach((b) => (b.onclick = () => verifyOrderForm(b.dataset.verifyOrder)));
  document.querySelectorAll("[data-resume-order]").forEach((button) => {
    button.onclick = () => resumePaymentOrder(button.dataset.resumeOrder);
  });
  document.querySelectorAll("[data-authorize-cash]").forEach((button) => {
    button.onclick = () => authorizeCashForm(button.dataset.authorizeCash);
  });
  document
    .querySelectorAll("[data-receipt]")
    .forEach((b) => (b.onclick = () => showReceipt(b.dataset.receipt)));
  if ($("search"))
    $("search").oninput = (e) => {
      search = e.target.value.toLowerCase();
      const pos = e.target.selectionStart;
      render();
      $("search").focus();
      if (pos !== null && $("search").type !== "search")
        $("search").setSelectionRange(pos, pos);
    };
  if ($("payment-channel")) $("payment-channel").onchange = (e) => { paymentChannel = e.target.value; render(); };
  document.querySelectorAll("[data-payment-channel]").forEach((button) => { button.onclick = () => { paymentChannel = button.dataset.paymentChannel; render(); }; });
  document
    .querySelectorAll("[data-edit]")
    .forEach((b) => (b.onclick = () => openForm(b.dataset.edit)));
  document
    .querySelectorAll("[data-delete]")
    .forEach((b) => (b.onclick = () => remove(b.dataset.delete)));
  if ($("session"))
    $("session").onchange = (e) => {
      selectedCourse = e.target.value;
      render();
    };
  document.querySelectorAll("[data-attendance]").forEach(
    (select) =>
      (select.onchange = async () => {
        const value = select.value;
        const old = db.attendance.find(
          (a) =>
            a.student === select.dataset.attendance &&
            a.course === selectedCourse,
        );
        select.disabled = true;
        try {
          if (value === "Non renseigné") {
            if (old)
              await schoolAPI.request(
                "/api/records/attendance/" + old.id,
                "DELETE",
              );
          } else {
            await schoolAPI.request(
              "/api/records/attendance" + (old ? "/" + old.id : ""),
              old ? "PUT" : "POST",
              {
                student: select.dataset.attendance,
                course: selectedCourse,
                status: value,
              },
            );
          }
          await refresh();
          render();
          toast("Présence enregistrée");
        } catch (err) {
          handleError(err);
          render();
        }
      }),
  );
  document
    .querySelectorAll("[data-toggle-user]")
    .forEach((b) => (b.onclick = () => toggleUser(b.dataset.toggleUser)));
  document
    .querySelectorAll("[data-reset-user]")
    .forEach((b) => (b.onclick = () => resetUser(b.dataset.resetUser)));
  if (page === "students" && role === "admin") bindEnrollments();
}
function openCourseForm(id) { page = "courses"; render(); openForm(id); }
function openPaymentForm(studentId, period) {
  page = "payments"; render(); openForm();
  if ($("f-student")) $("f-student").value = studentId;
  if ($("f-period")) $("f-period").value = period;
  if ($("fields")) $("fields").insertAdjacentHTML("afterbegin", '<p class="helper">Saisissez uniquement une somme effectivement reçue par l’établissement.</p>');
}

function field(
  name,
  label,
  type = "text",
  options = null,
  value = "",
  optional = false,
) {
  const required = optional ? "" : "required";
  return `<label for="f-${name}">${label}</label>${options ? `<select id="f-${name}" name="${name}" ${required}>${options.map((o) => `<option value="${esc(o[0])}" ${String(value) === String(o[0]) ? "selected" : ""}>${esc(o[1])}</option>`).join("")}</select>` : `<input id="f-${name}" name="${name}" type="${type}" ${required} value="${esc(value)}" ${name === "score" ? 'min="0" max="20" step="0.5"' : name === "amount" ? 'min="1" max="100000000" step="1"' : name === "monthlyFee" ? 'min="0" max="1000000" step="1"' : name === "duration" ? 'min="15" max="480" step="15"' : type === "password" ? 'minlength="12" maxlength="128" autocomplete="new-password"' : name === "group" ? 'maxlength="200"' : 'maxlength="100"'}>`}`;
}

function openForm(id) {
  const r = db[page].find((x) => x.id === id) || {};
  let fields = "";
  const f = (
    n,
    l,
    t = "text",
    opts = null,
    defaultValue = "",
    optional = false,
  ) => field(n, l, t, opts, r[n] ?? defaultValue, optional);
  if (page === "students")
    fields =
      f("name", "Nom complet") +
      f(
        "class",
        "Classe",
        "text",
        catalogue.levels.map(([l]) => [l, l]),
      ) +
      f("group", "Groupe") +
      f(
        "centre",
        "Centre",
        "text",
        [["", "Non renseigné"], ...catalogue.centres.map((c) => [c, c])],
        "",
        true,
      ) +
      f(
        "guardian",
        "Parent / responsable (facultatif)",
        "text",
        null,
        "",
        true,
      ) +
      f(
        "phone",
        "Téléphone du responsable (facultatif)",
        "tel",
        null,
        "",
        true,
      ) +
      f("monthlyFee", "Tarif mensuel (FCFA)", "number", null, 3500) +
      f("registrationStatus", "Statut", "text", [
        ["Inscrit", "Inscrit"],
        ["Préinscription", "Préinscription"],
        ["Suspendu", "Suspendu"],
      ]) +
      `<fieldset class="subject-fields"><legend>Matières souhaitées</legend>${catalogue.subjects.map((subject) => `<label><input type="checkbox" name="subjects" value="${esc(subject)}" ${(r.subjects || []).includes(subject) ? "checked" : ""}>${esc(subject)}</label>`).join("")}<small>Choix transmis par la famille, modifiables par l’administration.</small></fieldset>`;
  if (page === "teachers")
    fields =
      f("name", "Nom complet") +
      f(
        "subject",
        "Matière",
        "text",
        catalogue.subjects.map((x) => [x, x]),
      );
  if (page === "courses") {
    if (!db.teachers.length || !db.students.length)
      return toast(
        "Ajoutez un enseignant et un élève avant de planifier un cours.",
      );
    fields =
      f(
        "subject",
        "Matière",
        "text",
        catalogue.subjects.map((x) => [x, x]),
      ) +
      f(
        "group",
        "Groupe",
        "text",
        [...new Set(db.students.map((s) => s.group))].map((g) => [g, g]),
      ) +
      f(
        "teacher",
        "Enseignant",
        "text",
        db.teachers.map((t) => [t.id, t.name]),
      ) +
      f("date", "Date", "date") +
      f("time", "Heure de début", "time") +
      f("duration", "Durée en minutes", "number", null, 60) +
      f("room", "Salle");
  }
  if (page === "payments") {
    if (!db.students.length)
      return toast("Inscrivez un élève avant de saisir un paiement.");
    fields =
      f(
        "student",
        "Élève",
        "text",
        db.students.map((s) => [s.id, s.name]),
      ) +
      f("amount", "Montant reçu (FCFA)", "number") +
      f(
        "period",
        "Mois concerné",
        "month",
        null,
        new Date().toISOString().slice(0, 7),
      ) +
      f(
        "date",
        "Date du paiement",
        "date",
        null,
        new Date().toLocaleDateString("en-CA"),
      );
  }
  if (page === "grades") {
    if (!visibleCourses().length || !visibleStudents().length)
      return toast(
        "Planifiez un cours avec des élèves avant de saisir une note.",
      );
    fields =
      f(
        "course",
        "Cours",
        "text",
        visibleCourses().map((c) => [
          c.id,
          `${c.subject} · ${c.group} · ${date(c.date)}`,
        ]),
      ) +
      f(
        "student",
        "Élève",
        "text",
        visibleStudents().map((s) => [s.id, s.name]),
      ) +
      f("label", "Nom de l’évaluation") +
      f("score", "Note sur 20", "number");
  }
  $("modal-title").textContent = id ? "Modifier le dossier" : addLabels[page];
  $("fields").innerHTML = fields;
  $("error").textContent = "";
  if (page === "students")
    $("f-class").onchange = () => {
      $("f-monthlyFee").value =
        catalogue.levels.find(([l]) => l === $("f-class").value)?.[1] || 0;
    };
  if (page === "grades") {
    const sync = () => {
      const group = course($("f-course").value)?.group;
      const old = $("f-student").value;
      $("f-student").innerHTML = visibleStudents()
        .filter((s) => s.group === group)
        .map(
          (s) =>
            `<option value="${s.id}" ${s.id === old ? "selected" : ""}>${esc(s.name)}</option>`,
        )
        .join("");
    };
    $("f-course").onchange = sync;
    sync();
  }
  $("form").onsubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData);
    delete data.subjects;
    Object.keys(data).forEach((k) => (data[k] = data[k].trim()));
    if (
      Object.entries(data).some(
        ([k, v]) => !v && !["centre", "guardian", "phone"].includes(k),
      )
    ) {
      return ($("error").textContent = "Veuillez renseigner tous les champs.");
    }
    for (const k of ["amount", "score", "duration", "monthlyFee"])
      if (k in data) data[k] = Number(data[k]);
    if (page === "students") data.subjects = formData.getAll("subjects");
    if (
      page === "grades" &&
      student(data.student)?.group !== course(data.course)?.group
    )
      return ($("error").textContent =
        "Cet élève ne fait pas partie du groupe de ce cours.");
    if (page === "courses") {
      const overlaps = db.courses.some((c) => {
        if (c.id === id || c.date !== data.date) return false;
        const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
        return (
          (c.teacher === data.teacher ||
            c.group === data.group ||
            (c.room.toLowerCase() === data.room.toLowerCase() &&
              (!groupCentre(c.group) || !groupCentre(data.group) || groupCentre(c.group) === groupCentre(data.group)))) &&
          mins(c.time) < mins(data.time) + data.duration &&
          mins(data.time) < mins(c.time) + c.duration
        );
      });
      if (overlaps)
        return ($("error").textContent =
          "Créneau déjà occupé pour cet enseignant, ce groupe ou cette salle.");
    }
    const button = e.target.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await schoolAPI.request(
        "/api/records/" + page + (id ? "/" + id : ""),
        id ? "PUT" : "POST",
        data,
      );
      $("modal").close();
      await refresh();
      render();
      toast("Enregistrement effectué");
    } catch (err) {
      if (err.status === 401) handleError(err);
      else $("error").textContent = err.message;
    } finally {
      button.disabled = false;
    }
  };
  $("modal").showModal();
}
async function remove(id) {
  if (page === "students" && role === "admin") {
    const record = db.students.find((entry) => entry.id === id);
    if (record && typeof window.openStudentCleanup === "function") {
      window.openStudentCleanup(record);
    } else {
      toast("Le parcours de suppression est indisponible. Rechargez la page.");
    }
    return;
  }
  if (!confirm("Supprimer cet enregistrement ?")) return;
  try {
    await schoolAPI.request("/api/records/" + page + "/" + id, "DELETE");
    await refresh();
    render();
    toast("Enregistrement supprimé");
  } catch (err) {
    handleError(err);
  }
}
function collectionSummary() {
  const real = db.payments.filter((p) => p.mode !== "sandbox");
  const sum = (online) => real.filter((p) => (p.source === "KKiaPay") === online).reduce((total, p) => total + Number(p.amount || 0), 0);
  return `<div class="analytics-grid">${panel("Paiements en ligne", "KKiaPay confirmés · totalité des encaissements réels", `<div class="mini-summary"><strong>${money(sum(true))}</strong></div><button class="secondary" data-payment-channel="online">Voir les paiements en ligne</button>`)}${panel("Encaissements en présentiel", "Caisse et anciennes saisies administratives · hors tests", `<div class="mini-summary"><strong>${money(sum(false))}</strong></div><div class="quick-actions"><button class="secondary" data-payment-channel="cash">Voir les paiements en présentiel</button><button class="primary" data-go="cashier">Ouvrir la caisse</button></div>`)}</div>`;
}
function paymentPage() {
  return (role === "admin" ? collectionSummary() : "") + `<div class="panel payment-intro"><div class="panel-head"><div><h2>Régler les frais mensuels</h2><p>${!paymentConfig.configured ? "Soldes réels · Paiement en ligne différé" : paymentConfig.sandbox ? "KKiaPay · Mode test : aucune somme réelle n’est encaissée." : "KKiaPay · Paiement en ligne"}</p></div><button class="primary" id="pay-online" ${currentOrder || checkoutInFlight || paymentConfirmationInFlight ? "disabled" : ""}>${paymentConfig.configured ? "Payer en ligne" : "Choisir les mois à régler"}</button></div>${!paymentConfig.configured ? '<p class="helper">Le paiement en ligne est différé jusqu’à son activation par l’établissement. Vous pouvez préparer votre choix de mois.</p>' : ""}${currentOrder ? '<p class="helper">Une tentative de paiement est en attente. Vérifiez cette transaction avant de préparer un autre règlement.</p>' : ""}<p class="helper">Choisissez librement les mois à régler, même sur plusieurs années. Le total est calculé à partir du tarif de l’élève et du solde de chaque mois. La confirmation est vérifiée auprès de KKiaPay.</p></div>${list()}${
    paymentOrders.length
      ? panel(
          "Échéances en ligne",
          "En cas d’interruption, utilisez la référence de transaction KKiaPay pour vérifier le règlement.",
          table(
            ["Élève", "Mois", "Montant", "Mode", "Statut", "Action"],
            paymentOrders.map(
              (o) =>
                `<tr><td>${esc(student(o.student)?.name || "—")}</td><td>${esc(window.paymentMonths.labels(o).join(", "))}</td><td>${money(o.amount)}</td><td>${o.mode === "sandbox" ? "Test" : "Réel"}</td><td>${o.status === "paid" ? "Confirmé" : o.status === "cash_authorized" ? "Présentiel autorisé · en ligne non confirmé" : "En attente"}</td><td><div class="row-actions">${["pending", "cash_authorized"].includes(o.status) ? `<button class="secondary" data-verify-order="${esc(o.id)}" ${checkoutInFlight || paymentConfirmationInFlight || currentOrder?.widgetActive ? "disabled" : ""}>Vérifier la transaction</button>` : ""}${o.status === "pending" && o.mode === (paymentConfig.sandbox ? "sandbox" : "live") && !privateAttemptState(o).transactionId ? `<button class="secondary" data-resume-order="${esc(o.id)}" ${canResumePaymentOrder(o) ? "" : "disabled"}>Reprendre le paiement</button>` : ""}${role === "admin" && o.mode === "live" && o.status === "pending" ? `<button class="secondary" data-authorize-cash="${esc(o.id)}">Autoriser la caisse</button>` : ""}</div>${privateAttemptState(o).providerPending ? '<p class="helper">Paiement en cours : attendez sa confirmation avant de reprendre.</p>' : ""}${paymentResumeErrors.has(o.id) ? `<p class="helper" role="alert">${esc(paymentResumeErrors.get(o.id))}</p>` : ""}</td></tr>`,
            ),
          ),
        )
      : ""
  }`;
}
let currentOrder = null;
let checkoutDraft = null, checkoutInFlight = false, paymentConfirmationInFlight = false;
const paymentResumeErrors = new Map();
function privateAttemptKey(id) { return "crs-payment-attempt:" + user.id + ":" + id; }
function privateAttemptState(order) {
  const id = order.orderId || order.id;
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem(privateAttemptKey(id)) || "{}"); } catch (_) { /* Storage may be unavailable. */ }
  const active = currentOrder?.orderId === id ? currentOrder : null;
  return { transactionId: active?.transactionId || order.transactionId || saved.transactionId || "", providerPending: Boolean(active?.providerPending || saved.providerPending) };
}
function rememberPrivateAttempt(order) {
  const state = { transactionId: order.transactionId || "", providerPending: Boolean(order.providerPending) };
  try {
    if (state.transactionId || state.providerPending) sessionStorage.setItem(privateAttemptKey(order.orderId || order.id), JSON.stringify(state));
    else sessionStorage.removeItem(privateAttemptKey(order.orderId || order.id));
  } catch (_) { /* The current page still keeps the active attempt in memory. */ }
}
function canResumePaymentOrder(order) {
  const state = privateAttemptState(order);
  return paymentConfig.configured && order.status === "pending" && order.mode === (paymentConfig.sandbox ? "sandbox" : "live") && !state.transactionId && !state.providerPending && !checkoutInFlight && !paymentConfirmationInFlight && !currentOrder?.widgetActive && (!currentOrder || currentOrder.orderId === (order.id || order.orderId));
}
function openPrivatePaymentWidget(order) {
  order.widgetActive = true;
  order.providerPending = false;
  rememberPrivateAttempt(order);
  render();
  try {
    openKkiapayWidget({ amount: order.amount, key: order.publicKey, sandbox: order.sandbox, fullname: order.studentName, data: order.data, position: "center", theme: "#1c59bc" });
  } catch (error) {
    order.widgetActive = false;
    throw error;
  }
}
async function resumePaymentOrder(id) {
  const previous = paymentOrders.find((order) => order.id === id);
  if (!previous || !canResumePaymentOrder(previous)) return;
  if (typeof openKkiapayWidget !== "function") return toast("Le module de paiement est indisponible. Réessayez.");
  const allocations = window.paymentMonths.allocations(previous);
  if (!allocations.length) return toast("Les mois de cette échéance sont indisponibles. Contactez le responsable.");
  checkoutInFlight = true;
  render();
  try {
    const order = await schoolAPI.request("/api/payments/checkout", "POST", { student: previous.student, periods: allocations.map((allocation) => allocation.period) });
    if (order.orderId !== id || Number(order.amount) !== Number(previous.amount) || JSON.stringify(window.paymentMonths.allocations(order)) !== JSON.stringify(allocations)) {
      throw Object.assign(Error("Cette échéance a changé. Contactez le responsable avant de reprendre le paiement."), { status: 409 });
    }
    if (privateAttemptState(previous).transactionId || privateAttemptState(previous).providerPending || paymentConfirmationInFlight) return;
    currentOrder = { ...order, student: previous.student, mode: previous.mode, status: "pending" };
    paymentResumeErrors.delete(id);
    openPrivatePaymentWidget(currentOrder);
  } catch (error) {
    if (error.status === 409) paymentResumeErrors.set(id, error.message + " Contactez le responsable avant de reprendre le paiement.");
    handleError(error);
  } finally {
    checkoutInFlight = false;
    render();
  }
}
function openCheckout() {
  if (currentOrder || checkoutInFlight || paymentConfirmationInFlight) return toast("Une tentative de paiement est en attente. Vérifiez sa transaction avant de changer les mois.");
  const students = visibleStudents().filter((s) => s.registrationStatus === "Inscrit");
  if (!students.length) return toast("Une inscription validée est nécessaire pour payer.");
  $("modal-title").textContent = paymentConfig.configured && paymentConfig.sandbox ? "Paiement KKiaPay de test" : "Régler les mois de cours";
  if (!checkoutDraft || !students.some((s) => s.id === checkoutDraft.student)) {
    const period = new Date().toISOString().slice(0, 7);
    checkoutDraft = { student: students[0].id, period, monthCount: 1, periods: [period], locked: false };
  }
  const draft = checkoutDraft;
  $("fields").innerHTML =
    field("student", "Élève", "text", students.map((s) => [s.id, s.name]), draft.student) +
    field("period", "Afficher à partir de", "month", null, draft.period) +
    '<label for="f-monthCount">Sélection rapide de mois consécutifs</label><input id="f-monthCount" name="monthCount" type="number" min="1" step="1" value="' + esc(draft.monthCount) + '">' +
    '<div id="checkout-summary"><div id="checkout-month-picker"></div></div>' +
    `<p class="helper">${!paymentConfig.configured ? "Paiement en ligne différé : vous pouvez choisir vos mois. Le paiement sera disponible après son activation par l’établissement." : paymentConfig.sandbox ? "Mode test : aucun encaissement réel. Les soldes de test sont distincts des soldes réels." : "Le montant définitif est calculé sur le serveur avant l’ouverture de KKiaPay."}</p>`;
  $("error").textContent = "";
  const controls = [$("f-student"), $("f-period"), $("f-monthCount")];
  const submit = $("form").querySelector('button[type="submit"]');
  let picker;
  const updateSummary = (selection = picker?.selection()) => {
    if (checkoutDraft !== draft || !selection) return;
    if (!draft.locked) draft.periods = [...selection.periods];
    controls.forEach((control) => { control.disabled = checkoutInFlight || draft.locked; });
    picker?.setLocked(checkoutInFlight || draft.locked);
    submit.disabled = checkoutInFlight || !paymentConfig.configured || (draft.locked ? !draft.periods.length || selection.loading || Boolean(selection.error) : !selection.ready);
    submit.textContent = draft.locked ? "Reprendre le même paiement" : "Payer " + selection.count + " mois";
  };
  function mountPicker(selected) {
    picker?.destroy();
    const studentId = draft.student;
    picker = window.paymentMonthPicker.create({
      root: $("checkout-month-picker"), start: draft.period, selected,
      summaryIds: { total: "checkout-total", selected: "checkout-months" },
      load: (start) => schoolAPI.request("/api/payments/months?student=" + encodeURIComponent(studentId) + "&start=" + encodeURIComponent(start)),
      onPageChange: (start) => { draft.period = start; controls[1].value = start; },
      onChange: updateSummary,
    });
    picker.setLocked(checkoutInFlight || draft.locked);
    picker.refresh();
  }
  controls[0].onchange = () => {
    if (draft.locked) return;
    draft.student = controls[0].value;
    draft.periods = [draft.period];
    draft.monthCount = 1;
    controls[2].value = "1";
    mountPicker(draft.periods);
  };
  controls[1].onchange = () => {
    if (draft.locked) return;
    draft.period = controls[1].value;
    picker.setStart(draft.period);
  };
  controls[2].onchange = () => {
    if (draft.locked) return;
    draft.monthCount = Number(controls[2].value);
    picker.chooseRange(controls[1].value, draft.monthCount);
  };
  mountPicker(draft.periods || window.paymentMonthPicker.range(draft.period, draft.monthCount));
  $("modal").oncancel = (event) => { if (checkoutInFlight) event.preventDefault(); };
  $("modal").onclose = () => { picker.destroy(); submit.textContent = "Enregistrer"; submit.disabled = false; $("modal").oncancel = null; };
  $("form").onsubmit = async (event) => {
    event.preventDefault();
    if (currentOrder || checkoutInFlight || paymentConfirmationInFlight || !paymentConfig.configured) return;
    if (typeof openKkiapayWidget !== "function") { $("error").textContent = "Le module de paiement est indisponible. Réessayez."; return; }
    updateSummary();
    if (submit.disabled) return;
    const selection = { student: draft.student, periods: [...draft.periods] };
    checkoutInFlight = true;
    draft.locked = true;
    updateSummary();
    try {
      const order = await schoolAPI.request("/api/payments/checkout", "POST", selection);
      if (checkoutDraft !== draft) return;
      currentOrder = { ...order, student: selection.student, mode: order.sandbox ? "sandbox" : "live", status: "pending" };
      if (!paymentOrders.some((pending) => pending.id === order.orderId)) paymentOrders.unshift({ ...order, id: order.orderId, student: selection.student, mode: order.sandbox ? "sandbox" : "live", status: "pending" });
      $("modal").close();
      openPrivatePaymentWidget(currentOrder);
      await refresh();
      render();
    } catch (error) {
      if (!currentOrder && error.status >= 400 && error.status < 500) {
        draft.locked = false;
        if (error.status === 409) picker.refresh({ clear: true });
      }
      $("error").textContent = error.message;
      if (currentOrder) { render(); handleError(error); }
    } finally {
      checkoutInFlight = false;
      if ($("modal").open && $("checkout-summary")) updateSummary();
      if (currentOrder) render();
      if ($("pay-online")) $("pay-online").disabled = Boolean(currentOrder) || paymentConfirmationInFlight;
    }
  };
  $("modal").showModal();
}
async function confirmPayment(orderId, transactionId) {
  const result = await schoolAPI.request("/api/payments/confirm", "POST", {
    orderId,
    transactionId,
  });
  rememberPrivateAttempt({ orderId });
  paymentResumeErrors.delete(orderId);
  if (currentOrder?.orderId === orderId) {
    if (typeof closeKkiapayWidget === "function") closeKkiapayWidget();
    currentOrder = null;
    checkoutDraft = null;
  }
  await refresh();
  render();
  toast(
    result.sandbox
      ? "Paiement de test confirmé. Aucun encaissement réel."
      : "Paiement confirmé. Votre reçu est disponible.",
  );
  return result;
}
async function receivePrivateTransaction(response) {
  if (!currentOrder || paymentConfirmationInFlight || currentOrder.transactionId || !response?.transactionId) return;
  const pendingOrder = currentOrder, id = pendingOrder.orderId;
  pendingOrder.transactionId = response.transactionId;
  pendingOrder.widgetActive = false;
  pendingOrder.providerPending = false;
  rememberPrivateAttempt(pendingOrder);
  paymentConfirmationInFlight = true;
  closeKkiapayWidget();
  render();
  try {
    await confirmPayment(id, response.transactionId);
  } catch (error) {
    handleError(error);
    toast(error.message + " Ne payez pas une seconde fois : vérifiez la transaction.");
  } finally {
    paymentConfirmationInFlight = false;
    render();
  }
}
function pausePrivatePayment(failed = false) {
  if (!currentOrder || currentOrder.transactionId || paymentConfirmationInFlight) return;
  currentOrder.widgetActive = false;
  if (failed) currentOrder.providerPending = false;
  rememberPrivateAttempt(currentOrder);
  if (!currentOrder.providerPending && typeof closeKkiapayWidget === "function") closeKkiapayWidget();
  render();
  toast(currentOrder.providerPending ? "Le paiement est en cours de traitement. Attendez sa confirmation avant de reprendre." : "Le paiement n’est pas confirmé. Vous pouvez reprendre le même paiement depuis son échéance.");
}
if (typeof addSuccessListener === "function") addSuccessListener(receivePrivateTransaction);
if (typeof addFailedListener === "function") addFailedListener(() => pausePrivatePayment(true));
if (typeof addKkiapayCloseListener === "function") addKkiapayCloseListener(() => pausePrivatePayment());
if (typeof addPaymentAbortedListener === "function") addPaymentAbortedListener(() => pausePrivatePayment(true));
if (typeof addPendingListener === "function") addPendingListener(async (response) => {
  if (!currentOrder || currentOrder.transactionId || paymentConfirmationInFlight) return;
  if (response?.transactionId) return receivePrivateTransaction(response);
  currentOrder.providerPending = true;
  rememberPrivateAttempt(currentOrder);
  render();
  toast("Le paiement est en cours de traitement. Attendez sa confirmation avant de reprendre.");
});
function verifyOrderForm(id) {
  if (checkoutInFlight || paymentConfirmationInFlight || currentOrder?.widgetActive) return toast("Le paiement ou sa vérification est en cours.");
  const pendingOrder = paymentOrders.find((order) => order.id === id);
  $("modal-title").textContent = "Vérifier une transaction KKiaPay";
  $("fields").innerHTML = field(
    "transactionId",
    "Référence de transaction KKiaPay",
    "text", null, pendingOrder ? privateAttemptState(pendingOrder).transactionId : "",
  );
  $("error").textContent = "";
  $("form").onsubmit = async (e) => {
    e.preventDefault();
    if (paymentConfirmationInFlight) return;
    const b = e.target.querySelector('button[type="submit"]');
    b.disabled = true;
    paymentConfirmationInFlight = true;
    const transactionId = $("f-transactionId").value.trim();
    if (currentOrder?.orderId === id) {
      currentOrder.transactionId = transactionId;
      currentOrder.providerPending = false;
    }
    rememberPrivateAttempt({ orderId: id, transactionId });
    try {
      await confirmPayment(id, transactionId);
      $("modal").close();
    } catch (err) {
      $("error").textContent = err.message;
    } finally {
      paymentConfirmationInFlight = false;
      b.disabled = false;
      render();
    }
  };
  $("modal").showModal();
}
function authorizeCashForm(id) {
  if (role !== "admin") return;
  const order = paymentOrders.find((candidate) => candidate.id === id && candidate.mode === "live" && candidate.status === "pending");
  if (!order) return toast("Cette échéance a changé. Actualisez les paiements.");
  $("modal-title").textContent = "Autoriser le paiement en présentiel";
  $("fields").innerHTML = `<p><strong>${esc(student(order.student)?.name || "Élève")}</strong> · ${esc(window.paymentMonths.labels(order).join(", "))} · ${money(order.amount)}</p><p class="helper">Cette tentative de paiement en ligne n’a pas été confirmée. Si le parent dispose d’une référence de transaction, vérifiez-la d’abord avec « Vérifier la transaction ».</p><p class="helper">Après vérification avec le parent, vous pouvez autoriser le caissier à recevoir des espèces. Cette action n’enregistre aucun paiement. Si un paiement en ligne est confirmé plus tard, les deux sommes resteront visibles dans les comptes.</p><label style="display:flex;align-items:flex-start;gap:12px"><input id="f-confirmedUnpaid" type="checkbox" required style="width:auto;margin-top:3px"><span>J’ai vérifié avec le parent que ce paiement en ligne n’a pas été effectué.</span></label>`;
  $("error").textContent = "";
  const submit = $("form").querySelector('button[type="submit"]');
  submit.textContent = "Autoriser la caisse";
  $("modal").onclose = () => { submit.textContent = "Enregistrer"; };
  $("form").onsubmit = async (event) => {
    event.preventDefault();
    if (!$("f-confirmedUnpaid").checked) return;
    submit.disabled = true;
    try {
      await schoolAPI.request("/api/admin/payment-orders/" + encodeURIComponent(id) + "/authorize-cash", "POST", { confirmedUnpaid: true });
      $("modal").close();
      await refresh(); render();
      toast("La caisse est autorisée pour cet élève et ce mois.");
    } catch (error) { if (error.status === 401) handleError(error); else $("error").textContent = error.message; }
    finally { submit.disabled = false; }
  };
  $("modal").showModal();
}
function showReceipt(id) {
  const p = db.payments.find((p) => p.id === id);
  if (!p) return;
  $("modal-title").textContent =
    p.mode === "sandbox"
      ? "Reçu de test — sans valeur de paiement"
      : "Reçu de paiement";
  $("fields").innerHTML =
    `<div class="receipt"><h3>${esc(catalogue.name)}</h3><p>Élève : ${esc(student(p.student)?.name)}</p><p>Mois couverts : ${esc(window.paymentMonths.labels(p).join(", "))}</p><p>Montant total : <strong>${money(p.amount)}</strong></p><p>Date : ${date(p.date)}</p><p>Mode : ${p.source === "KKiaPay" ? "KKiaPay" : p.source === "Caisse" ? "Caisse en présentiel · espèces" : "Saisie administrative"}</p><p>Référence : ${esc(p.transactionId || p.id)}</p>${p.mode === "sandbox" ? '<p class="helper">Transaction de test. Aucun règlement réel.</p>' : ""}</div>`;
  $("error").textContent = "";
  $("form").querySelector('button[type="submit"]').textContent =
    "Imprimer le reçu";
  $("form").onsubmit = (e) => {
    e.preventDefault();
    window.print();
  };
  $("modal").onclose = () => {
    $("form").querySelector('button[type="submit"]').textContent =
      "Enregistrer";
  };
  $("modal").showModal();
}
function accountsPage() {
  return `<div class="panel"><div class="toolbar"><div><h2>Comptes & accès</h2><p class="helper">Un identifiant par personne. Le mot de passe initial doit être changé à la première connexion.</p></div><button class="primary" id="add">+ Créer un compte</button></div>${table(
    ["Identifiant", "Rôle", "Dossier lié", "Statut", "Actions"],
    users.map(
      (u) =>
        `<tr><td>${esc(u.username)}</td><td>${esc({ admin: "Responsable / administrateur", cashier: "Caissier", teacher: "Enseignant", student: "Élève" }[u.role])}</td><td>${esc(u.role === "teacher" ? teacher(u.entityId)?.name : u.role === "student" ? student(u.entityId)?.name : u.role === "cashier" ? "Caisse en présentiel" : "Administration")}</td><td><span class="badge ${u.enabled ? "" : "orange"}">${u.enabled ? "Actif" : "Désactivé"}</span></td><td>${u.id === user.id ? "Votre compte" : `<div class="row-actions"><button class="secondary" data-toggle-user="${u.id}">${u.enabled ? "Désactiver" : "Activer"}</button><button class="secondary" data-reset-user="${u.id}">Réinitialiser le mot de passe</button></div>`}</td></tr>`,
    ),
  )}<p class="helper">Les autorisations sont contrôlées côté serveur. Désactiver un compte ou réinitialiser son mot de passe ferme ses sessions.</p><button class="secondary" id="export">Exporter les dossiers (JSON)</button></div>`;
}
function openUserForm() {
  $("modal-title").textContent = "Créer un compte";
  $("fields").innerHTML =
    field("username", "Identifiant") +
    field("role", "Rôle", "text", [
      ["student", "Élève"],
      ["teacher", "Enseignant"],
      ["cashier", "Caissier"],
      ["admin", "Administrateur"],
    ]) +
    field("entityId", "Dossier lié", "text", []) +
    field(
      "password",
      "Mot de passe initial (12 caractères minimum)",
      "password",
    );
  $("error").textContent = "";
  const sync = () => {
    const r = $("f-role").value,
      list = r === "teacher" ? db.teachers : db.students;
    const available = list.filter(
      (x) => !users.some((u) => u.role === r && u.entityId === x.id),
    );
    $("f-entityId").innerHTML = available
      .map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`)
      .join("");
    const linked = ["teacher", "student"].includes(r);
    $("f-entityId").hidden = !linked;
    $("f-entityId").previousElementSibling.hidden = !linked;
    $("f-entityId").required = linked;
    $("f-entityId").disabled = !linked;
  };
  $("f-role").onchange = sync;
  sync();
  $("form").onsubmit = async (e) => {
    e.preventDefault();
    const button = e.target.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await schoolAPI.request(
        "/api/admin/users",
        "POST",
        Object.fromEntries(new FormData(e.target)),
      );
      $("modal").close();
      await refresh();
      render();
      toast(
        "Compte créé. Transmettez les accès à son titulaire de manière privée.",
      );
    } catch (err) {
      $("error").textContent = err.message;
    } finally {
      button.disabled = false;
    }
  };
  $("modal").showModal();
}
async function toggleUser(id) {
  const u = users.find((u) => u.id === id);
  if (
    !confirm(
      (u.enabled ? "Désactiver" : "Activer") +
        " le compte " +
        u.username +
        " ?",
    )
  )
    return;
  try {
    await schoolAPI.request("/api/admin/users/" + id, "PUT", {
      enabled: !u.enabled,
    });
    await refresh();
    render();
    toast("Compte mis à jour");
  } catch (err) {
    handleError(err);
  }
}
function resetUser(id) {
  $("modal-title").textContent = "Réinitialiser le mot de passe";
  $("fields").innerHTML = field(
    "password",
    "Nouveau mot de passe initial",
    "password",
  );
  $("error").textContent = "";
  $("form").onsubmit = async (e) => {
    e.preventDefault();
    const b = e.target.querySelector('button[type="submit"]');
    b.disabled = true;
    try {
      await schoolAPI.request("/api/admin/users/" + id, "PUT", {
        password: $("f-password").value,
      });
      $("modal").close();
      toast(
        "Mot de passe réinitialisé. Les anciennes sessions ont été fermées.",
      );
    } catch (err) {
      $("error").textContent = err.message;
    } finally {
      b.disabled = false;
    }
  };
  $("modal").showModal();
}
async function exportRecords() {
  try {
    const response = await fetch("/api/admin/export", {
      credentials: "same-origin",
    });
    if (!response.ok)
      throw new Error("Export impossible. Vérifiez votre connexion.");
    const blob = await response.blob(),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download =
      "dossiers-cours-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("Export téléchargé. Conservez-le dans un emplacement privé.");
  } catch (err) {
    handleError(err);
  }
}
function passwordForm(forced = false) {
  $("modal-title").textContent = forced
    ? "Choisissez votre mot de passe personnel"
    : "Changer mon mot de passe";
  $("fields").innerHTML =
    field("currentPassword", "Mot de passe actuel", "password") +
    field("password", "Nouveau mot de passe", "password") +
    field("confirmation", "Confirmer le nouveau mot de passe", "password");
  $("f-currentPassword").autocomplete = "current-password";
  $("f-currentPassword").removeAttribute("minlength");
  $("error").textContent = "";
  $("close").hidden = forced;
  $("modal").onclose = () => {
    if (user?.mustChangePassword) passwordForm(true);
  };
  $("modal").oncancel = (e) => {
    if (user?.mustChangePassword) e.preventDefault();
  };
  $("form").onsubmit = async (e) => {
    e.preventDefault();
    if ($("f-password").value !== $("f-confirmation").value) {
      $("error").textContent = "Les mots de passe ne correspondent pas.";
      return;
    }
    const b = e.target.querySelector('button[type="submit"]');
    b.disabled = true;
    try {
      const result = await schoolAPI.request("/api/auth/password", "POST", {
        currentPassword: $("f-currentPassword").value,
        password: $("f-password").value,
      });
      user = result.user;
      $("close").hidden = false;
      $("modal").close();
      await refresh();
      render();
      toast("Mot de passe changé");
    } catch (err) {
      $("error").textContent = err.message;
    } finally {
      b.disabled = false;
    }
  };
  $("modal").showModal();
}
$("close").onclick = () => { if (!checkoutInFlight) $("modal").close(); };
$("change-password").onclick = () => passwordForm();
$("logout").onclick = async () => {
  try {
    await schoolAPI.request("/api/auth/logout", "POST", {});
    location.assign(role === "cashier" ? "/connexion.html?espace=caisse" : "/connexion.html");
  } catch (err) {
    handleError(err);
  }
};
(async () => {
  await new Promise((resolve) => document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", resolve, { once: true }) : resolve());
  try {
    const result = await schoolAPI.request("/api/auth/me");
    user = result.user;
    role = user.role;
    if (!["admin", "cashier", "teacher", "student"].includes(role)) throw new Error("Ce compte n’a pas d’espace autorisé.");
    if (role === "cashier") page = "cashier";
    const requestedPage = new URLSearchParams(location.search).get("section");
    if (accessibleSections().includes(requestedPage)) page = requestedPage;
    identity = user.entityId || "";
    $("account-name").textContent =
      user.username +
      " · " +
      { admin: "Administration", cashier: "Caisse", teacher: "Enseignant", student: "Élève" }[
        role
      ];
    $("connection-status").textContent =
      "Connecté · Données enregistrées sur le serveur";
    if (user.mustChangePassword) {
      passwordForm(true);
      return;
    }
    await refresh();
    render();
  } catch (err) {
    handleError(err);
    if (err.status !== 401)
      $("connection-status").textContent =
        "Chargement impossible : " + err.message;
  }
})();
