"use strict";
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
const money = (n) => new Intl.NumberFormat("fr-FR").format(n) + " FCFA";
const date = (d) =>
  new Date(d + "T12:00:00").toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
const sections = {
  dashboard: ["◈", "Tableau de bord"],
  students: ["♙", "Élèves"],
  teachers: ["♧", "Enseignants"],
  courses: ["▦", "Cours & planning"],
  attendance: ["✓", "Présences"],
  payments: ["◇", "Paiements"],
  grades: ["▤", "Notes & résultats"],
  users: ["♧", "Comptes & accès"],
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
  db = await schoolAPI.request("/api/data");
  if (role === "admin") users = await schoolAPI.request("/api/admin/users");
  if (role !== "teacher") {
    paymentConfig = await schoolAPI.request("/api/payments/config");
    paymentOrders = await schoolAPI.request("/api/payments/orders");
  }
}
function handleError(err) {
  if (err.status === 401) {
    location.assign("/connexion.html");
    return;
  }
  toast(err.message || "Serveur indisponible. Réessayez.");
}
function navigation() {
  let entries = Object.keys(sections).filter(
    (x) =>
      role === "admin" ||
      ["dashboard", "courses", "attendance", "grades"].includes(x) ||
      (role === "student" && x === "payments"),
  );
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
    .filter((c) => c.date >= new Date().toLocaleDateString("en-CA"))
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
          `<tr><td>${person(s)}</td><td>${esc(s.class)}</td><td><span class="badge">${esc(s.centre || "—")}</span></td><td>${esc(s.group)}</td><td>${esc(s.registrationStatus || "Inscrit")}</td><td>${actions(s.id)}</td></tr>`,
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
          visibleStudents().some((s) => s.id === p.student) &&
          (student(p.student)?.name + " " + p.period)
            .toLowerCase()
            .includes(search),
      )
      .map(
        (p) =>
          `<tr><td>${esc(student(p.student)?.name)}</td><td>${esc(p.period)}</td><td>${money(p.amount)}</td><td>${date(p.date)}</td><td><span class="badge ${p.mode === "sandbox" ? "orange" : ""}">${p.mode === "sandbox" ? "Test confirmé" : p.source === "KKiaPay" ? "KKiaPay confirmé" : "Saisie manuelle"}</span></td><td><button class="secondary" data-receipt="${p.id}">Reçu</button>${role === "admin" && p.source !== "KKiaPay" ? actions(p.id) : ""}</td></tr>`,
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
    students: ["Élève", "Classe", "Centre", "Groupe", "Statut", "Actions"],
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
  return `<div class="panel"><div class="toolbar"><input id="search" type="search" placeholder="Rechercher…" aria-label="Rechercher" value="${esc(search)}">${canAdd() ? `<button class="primary" id="add">+ ${addLabels[page]}</button>` : ""}</div><div id="table">${table(headers, rowsForPage())}</div>${page === "payments" ? '<p class="helper">Les paiements de test sont identifiés et exclus des encaissements réels du tableau de bord.</p>' : ""}</div>`;
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
  navigation();
  $("title").textContent = sections[page][1];
  $("content").innerHTML =
    page === "dashboard"
      ? dashboard()
      : page === "attendance"
        ? attendance()
        : page === "users"
          ? accountsPage()
          : page === "payments"
            ? paymentPage()
            : page === "assignments" ? assignmentsPage() : page === "statistics" ? statisticsPage() : list();
  if (role === "admin" && typeof bindAnalytics === "function") bindAnalytics();
  if ($("add"))
    $("add").onclick = () => (page === "users" ? openUserForm() : openForm());
  if ($("export")) $("export").onclick = exportRecords;
  if ($("pay-online")) $("pay-online").onclick = openCheckout;
  document
    .querySelectorAll("[data-verify-order]")
    .forEach((b) => (b.onclick = () => verifyOrderForm(b.dataset.verifyOrder)));
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
  return `<label for="f-${name}">${label}</label>${options ? `<select id="f-${name}" name="${name}" ${required}>${options.map((o) => `<option value="${esc(o[0])}" ${String(value) === String(o[0]) ? "selected" : ""}>${esc(o[1])}</option>`).join("")}</select>` : `<input id="f-${name}" name="${name}" type="${type}" ${required} value="${esc(value)}" ${name === "score" ? 'min="0" max="20" step="0.5"' : name === "amount" ? 'min="1" max="100000000" step="1"' : name === "monthlyFee" ? 'min="0" max="1000000" step="1"' : name === "duration" ? 'min="15" max="480" step="15"' : type === "password" ? 'minlength="12" maxlength="128" autocomplete="new-password"' : name === "group" ? 'maxlength="180"' : 'maxlength="100"'}>`}`;
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
      ]);
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
    const data = Object.fromEntries(new FormData(e.target));
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
            c.room.toLowerCase() === data.room.toLowerCase()) &&
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
function paymentPage() {
  return `<div class="panel payment-intro"><div class="panel-head"><div><h2>Régler les frais mensuels</h2><p>${paymentConfig.sandbox ? "KKiaPay · Mode test : aucune somme réelle n’est encaissée." : "KKiaPay · Paiement en ligne"}</p></div><button class="primary" id="pay-online" ${paymentConfig.configured ? "" : "disabled"}>Payer en ligne</button></div>${!paymentConfig.configured ? '<p class="helper">Le paiement en ligne attend la configuration des trois clés KKiaPay dans les paramètres sécurisés du serveur.</p>' : ""}<p class="helper">Le montant est calculé à partir du tarif de l’élève et des paiements déjà enregistrés pour le mois. La confirmation est vérifiée auprès de KKiaPay.</p></div>${list()}${
    paymentOrders.length
      ? panel(
          "Échéances en ligne",
          "En cas d’interruption, utilisez la référence de transaction KKiaPay pour vérifier le règlement.",
          table(
            ["Élève", "Mois", "Montant", "Mode", "Statut", "Action"],
            paymentOrders.map(
              (o) =>
                `<tr><td>${esc(student(o.student)?.name || "—")}</td><td>${esc(o.period)}</td><td>${money(o.amount)}</td><td>${o.mode === "sandbox" ? "Test" : "Réel"}</td><td>${o.status === "paid" ? "Confirmé" : "En attente"}</td><td>${o.status === "pending" ? `<button class="secondary" data-verify-order="${o.id}">Vérifier la transaction</button>` : "—"}</td></tr>`,
            ),
          ),
        )
      : ""
  }`;
}
let currentOrder = null;
function openCheckout() {
  const students = visibleStudents().filter(
    (s) => s.registrationStatus === "Inscrit",
  );
  if (!students.length)
    return toast("Une inscription validée est nécessaire pour payer.");
  $("modal-title").textContent = paymentConfig.sandbox
    ? "Paiement KKiaPay de test"
    : "Régler un mois de cours";
  $("fields").innerHTML =
    field(
      "student",
      "Élève",
      "text",
      students.map((s) => [s.id, s.name]),
    ) +
    field(
      "period",
      "Mois à régler",
      "month",
      null,
      new Date().toISOString().slice(0, 7),
    ) +
    `<p class="helper">${paymentConfig.sandbox ? "Mode test : ne saisissez pas de coordonnées de paiement réelles." : "Le montant définitif est calculé sur le serveur avant l’ouverture de KKiaPay."}</p>`;
  $("error").textContent = "";
  $("form").onsubmit = async (e) => {
    e.preventDefault();
    const b = e.target.querySelector('button[type="submit"]');
    b.disabled = true;
    try {
      const order = await schoolAPI.request(
        "/api/payments/checkout",
        "POST",
        Object.fromEntries(new FormData(e.target)),
      );
      currentOrder = order;
      $("modal").close();
      openKkiapayWidget({
        amount: order.amount,
        key: order.publicKey,
        sandbox: order.sandbox,
        fullname: order.studentName,
        data: order.data,
        position: "center",
        theme: "#1c59bc",
      });
      await refresh();
      render();
    } catch (err) {
      $("error").textContent = err.message;
    } finally {
      b.disabled = false;
    }
  };
  $("modal").showModal();
}
async function confirmPayment(orderId, transactionId) {
  const result = await schoolAPI.request("/api/payments/confirm", "POST", {
    orderId,
    transactionId,
  });
  await refresh();
  render();
  toast(
    result.sandbox
      ? "Paiement de test confirmé. Aucun encaissement réel."
      : "Paiement confirmé. Votre reçu est disponible.",
  );
  return result;
}
if (typeof addSuccessListener === "function")
  addSuccessListener(async (response) => {
    if (!currentOrder) return;
    const id = currentOrder.orderId;
    closeKkiapayWidget();
    try {
      await confirmPayment(id, response.transactionId);
      currentOrder = null;
    } catch (err) {
      handleError(err);
    }
  });
if (typeof addFailedListener === "function")
  addFailedListener(() => {
    toast("Paiement non confirmé. Vérifiez votre échéance avant de réessayer.");
  });
function verifyOrderForm(id) {
  $("modal-title").textContent = "Vérifier une transaction KKiaPay";
  $("fields").innerHTML = field(
    "transactionId",
    "Référence de transaction KKiaPay",
  );
  $("error").textContent = "";
  $("form").onsubmit = async (e) => {
    e.preventDefault();
    const b = e.target.querySelector('button[type="submit"]');
    b.disabled = true;
    try {
      await confirmPayment(id, $("f-transactionId").value.trim());
      $("modal").close();
    } catch (err) {
      $("error").textContent = err.message;
    } finally {
      b.disabled = false;
    }
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
    `<div class="receipt"><h3>COURS DE RENFORCEMENT SCOLAIRE</h3><p>Élève : ${esc(student(p.student)?.name)}</p><p>Mois : ${esc(p.period)}</p><p>Montant : <strong>${money(p.amount)}</strong></p><p>Date : ${date(p.date)}</p><p>Mode : ${p.source === "KKiaPay" ? "KKiaPay" : "Saisie administrative"}</p><p>Référence : ${esc(p.transactionId || p.id)}</p>${p.mode === "sandbox" ? '<p class="helper">Transaction de test. Aucun règlement réel.</p>' : ""}</div>`;
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
        `<tr><td>${esc(u.username)}</td><td>${esc({ admin: "Administrateur", teacher: "Enseignant", student: "Élève" }[u.role])}</td><td>${esc(u.role === "teacher" ? teacher(u.entityId)?.name : u.role === "student" ? student(u.entityId)?.name : "Administration")}</td><td><span class="badge ${u.enabled ? "" : "orange"}">${u.enabled ? "Actif" : "Désactivé"}</span></td><td>${u.id === user.id ? "Votre compte" : `<div class="row-actions"><button class="secondary" data-toggle-user="${u.id}">${u.enabled ? "Désactiver" : "Activer"}</button><button class="secondary" data-reset-user="${u.id}">Réinitialiser le mot de passe</button></div>`}</td></tr>`,
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
    $("f-entityId").hidden = r === "admin";
    $("f-entityId").previousElementSibling.hidden = r === "admin";
    $("f-entityId").required = r !== "admin";
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
$("close").onclick = () => $("modal").close();
$("change-password").onclick = () => passwordForm();
$("logout").onclick = async () => {
  try {
    await schoolAPI.request("/api/auth/logout", "POST", {});
    location.assign("/connexion.html");
  } catch (err) {
    handleError(err);
  }
};
(async () => {
  try {
    const result = await schoolAPI.request("/api/auth/me");
    user = result.user;
    role = user.role;
    identity = user.entityId || "";
    $("account-name").textContent =
      user.username +
      " · " +
      { admin: "Administration", teacher: "Enseignant", student: "Élève" }[
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
