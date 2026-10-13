"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../public/admin-analytics.js"), "utf8");
function analytics(data = {}) {
  const db = { students: [], teachers: [], courses: [], payments: [], attendance: [], dailyAttendance: [], grades: [], ...data };
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const context = vm.createContext({
    db, sections: {}, role: "admin", esc,
    money: (n) => `${n} FCFA`, date: (value) => value,
    teacher: (id) => db.teachers.find((record) => record.id === id),
    accountDashboard: () => "Account dashboard",
    table: (headers, rows) => `<table>${rows.join("")}</table>`,
    panel: (title, subtitle, body) => `<section><h2>${esc(title)}</h2><p>${esc(subtitle)}</p>${body}</section>`,
  });
  vm.runInContext(source, context);
  return { context, run: (code) => vm.runInContext(code, context) };
}
function metric(html, label) {
  return html.match(new RegExp(`${label}</span><strong>([^<]+)`))?.[1];
}
const pupil = (id, className = "6e", centre = "CP La Boussole") => ({ id, name: id, class: className, centre, group: `${className} · ${centre}`, registrationStatus: "Inscrit" });

test("Le suivi des mensualités distingue la période réglée de la date d’encaissement", () => {
  const { run } = analytics({ students: [pupil("late"), pupil("advance")], payments: [
    { student: "late", amount: 3500, period: "2026-09", date: "2026-10-10" },
    { student: "advance", amount: 3500, period: "2026-10", date: "2026-09-30" },
  ] });
  run("scopeMonth='2026-10'");
  const html = run("counters()");
  assert.equal(metric(html, "Encaissements réels"), "3500 FCFA");
  assert.equal(metric(html, "Élèves sans paiement"), "1");
  const trend = run("paymentTrend()");
  assert.match(trend, /sept\. 26<\/span><strong>3500 FCFA/);
  assert.match(trend, /oct\. 26<\/span><strong>3500 FCFA/);
});

test("Les paiements de test restent exclus et les filtres limitent les élèves et recettes", () => {
  const { run } = analytics({ students: [pupil("unpaid"), pupil("paid"), pupil("other", "4e"), pupil("elsewhere", "6e", "EPP Borarou")], payments: [
    { student: "unpaid", amount: 3500, period: "2026-10", date: "2026-10-10", mode: "sandbox" },
    { student: "paid", amount: 1000, period: "2026-10", date: "2026-10-10" },
    { student: "other", amount: 4000, period: "2026-10", date: "2026-10-10" },
    { student: "elsewhere", amount: 3500, period: "2026-10", date: "2026-10-10" },
  ] });
  run("scopeMonth='2026-10';scopeClass='6e';scopeCentre='CP La Boussole'");
  const html = run("counters()");
  assert.equal(metric(html, "Dossiers élèves"), "2");
  assert.equal(metric(html, "Élèves sans paiement"), "1");
  assert.equal(metric(html, "Encaissements réels"), "1000 FCFA");
  const trend = run("paymentTrend()");
  assert.match(trend, /oct\. 26<\/span><strong>1000 FCFA/);
});

test("Les recettes en ligne et en présentiel sont séparées sans inclure les tests", () => {
  const { run } = analytics({ students: [pupil("payer")], payments: [
    { student: "payer", amount: 1000, source: "Caisse", period: "2026-09", date: "2026-10-13" },
    { student: "payer", amount: 500, period: "2026-10", date: "2026-10-13" },
    { student: "payer", amount: 2000, source: "KKiaPay", mode: "live", period: "2026-10", date: "2026-10-13" },
    { student: "payer", amount: 3000, source: "KKiaPay", mode: "sandbox", period: "2026-10", date: "2026-10-13" },
    { student: "payer", amount: 9000, source: "Caisse", period: "2026-10", date: "2026-09-13" },
  ] });
  run("scopeMonth='2026-10'");
  const html = run("counters()");
  assert.equal(metric(html, "En ligne"), "2000 FCFA");
  assert.equal(metric(html, "En présentiel"), "1500 FCFA");
  assert.equal(metric(html, "Encaissements réels"), "3500 FCFA");
});

test("Le planning exclut les séances terminées et conserve celles en cours ou à venir", () => {
  const student = pupil("s");
  const session = (id, date, time, duration = 60, group = student.group) => ({ id, subject: id, group, date, time, duration });
  const { run } = analytics({ students: [student], courses: [
    session("tomorrow", "2026-10-14", "08:00"),
    session("ended-now", "2026-10-13", "09:00"),
    session("early", "2026-10-13", "08:00"),
    session("future", "2026-10-13", "16:00"),
    session("ongoing", "2026-10-13", "09:30"),
    session("yesterday", "2026-10-12", "23:00"),
    session("other-group", "2026-10-13", "12:00", 60, "4e A"),
  ] });
  run("scopeClass='6e'");
  const ids = JSON.parse(run("JSON.stringify(upcomingCourses(new Date('2026-10-13T10:00:00')).map(c=>c.id))"));
  assert.deepEqual(ids, ["ongoing", "future", "tomorrow"]);
});

test("Les présences quotidiennes gardent leurs classes et écoles historiques et leur taux reste séparé des cours", () => {
  const group = "6e · École des Érables";
  const { run } = analytics({
    students: [pupil("current", "6e", "École des Érables"), pupil("moved", "4e", "Centre actuel"), pupil("fallback", "6e", "École des Érables")],
    courses: [{ id: "course", group }],
    attendance: [
      { student: "current", course: "course", status: "Présent" },
      { student: "current", course: "course", status: "Retard" },
      { student: "fallback", course: "course", status: "Absent" },
      { student: "fallback", course: "course", status: "Excusé" },
    ],
    dailyAttendance: [
      { id: "historical-present", student: "moved", date: "2026-10-10", class: "6e", centre: "École des Érables", status: "Présent" },
      { id: "current-absent", student: "current", date: "2026-10-10", class: "6e", centre: "École des Érables", status: "Absent" },
      { id: "fallback-absent", student: "fallback", date: "2026-10-11", status: "Absent" },
      { id: "different-class", student: "current", date: "2026-10-11", class: "5e", centre: "École des Érables", status: "Absent" },
      { id: "different-school", student: "current", date: "2026-10-12", class: "6e", centre: "Autre école", status: "Absent" },
      { id: "cleared", student: "current", date: "2026-10-13", class: "6e", centre: "École des Érables", status: null },
      { id: "previous-month", student: "current", date: "2026-09-30", class: "6e", centre: "École des Érables", status: "Absent" },
      { id: "removed-pupil", student: "removed", date: "2026-10-10", class: "Classe retirée", centre: "École retirée", status: "Absent" },
    ],
  });
  run("scopeMonth='2026-10';scopeClass='6e';scopeCentre='École des Érables'");
  assert.deepEqual(JSON.parse(run("JSON.stringify(scopedDailyAttendance().map(entry=>entry.id))")), ["historical-present", "current-absent", "fallback-absent"]);
  const html = run("academicStats()");
  assert.match(html, /Présences par cours &amp; résultats/);
  assert.match(html, /Présence par cours : <strong>67 %/);
  assert.match(html, /Présences du jour/);
  assert.match(html, /Présence par jour : <strong>33 %/);
  assert.match(html, /Pointages renseignés : <strong>3/);
  assert.match(html, /Jours présents<\/span><strong>1/);
  assert.match(html, /Jours absents<\/span><strong>2/);
  const filters = run("analyticsFilters()");
  assert.match(filters, /<option >5e<\/option>/);
  assert.match(filters, /<option >Autre école<\/option>/);
  assert.doesNotMatch(filters, /Classe retirée|École retirée/);
  run("scopeMonth='2026-11'");
  const empty = run("dailyAttendanceStats()");
  assert.match(empty, /Présence par jour : <strong>Non disponible/);
  assert.match(empty, /Pointages renseignés : <strong>0/);
  assert.match(run("academicStats()"), /Présence par cours : <strong>67 %/);
});

test("Le guide présente les actions disponibles et réserve son contenu à l’administration", () => {
  const { run, context } = analytics();
  assert.equal(context.sections.help[1], "Guide d’utilisation");
  const html = run("helpPage()");
  for (const destination of ["students", "teachers", "courses", "assignments", "attendance", "dailyAttendance", "grades", "payments", "users", "statistics"])
    assert.ok(html.includes(`data-go="${destination}"`), destination);
  assert.match(html, /sommes effectivement reçues/);
  assert.match(html, /matières demandées/);
  assert.match(html, /encaissements et présences du jour/);
  context.role = "teacher";
  assert.equal(run("helpPage()").includes('data-go="users"'), false);
});
