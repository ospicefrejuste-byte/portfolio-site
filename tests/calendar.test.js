"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const source = fs.readFileSync(path.join(__dirname, "../public/admin-calendar.js"), "utf8");

function calendar(records = [], role = "admin") {
  const db = { courses: records, teachers: [{ id: "teacher-a", name: "Alice" }, { id: "teacher-b", name: "Bob" }] };
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const context = vm.createContext({ sections: {}, db, role, esc, date: (value) => value,
    visibleCourses: () => role === "teacher" ? records.filter((record) => record.teacher === "teacher-a") : records,
    teacher: (id) => db.teachers.find((record) => record.id === id), groupCentre: (group) => group === "6e A" ? "Centre A" : "Centre B",
  });
  vm.runInContext(source, context);
  return { context, run: (code) => vm.runInContext(code, context) };
}
const session = (id, date, time, teacher = "teacher-a", group = "6e A", subject = "Mathématiques") => ({ id, date, time, teacher, group, subject, duration: 60, room: "Salle 1" });

test("Le calendrier respecte les limites de semaine et les jours locaux même lors du changement d’heure", () => {
  const { run } = calendar();
  assert.equal(run("calendarMonday('2026-10-18')"), "2026-10-12");
  assert.equal(run("calendarMonday('2026-01-01')"), "2025-12-29");
  assert.equal(run("calendarShiftISO('2026-10-25', 1)"), "2026-10-26");
  assert.equal(run("calendarParseISO('2026-02-30')"), null);
  assert.equal(run("calendarMonday('')"), null);
  const script = `const sections={};\n${source}\nif (calendarMonday('2026-10-25') !== '2026-10-19' || calendarShiftISO('2026-03-29', 1) !== '2026-03-30' || calendarMonday(new Date('2026-10-18T23:30:00')) !== '2026-10-12') process.exit(1);`;
  for (const timezone of ["Europe/Paris", "Pacific/Kiritimati", "America/Los_Angeles"]) {
    const result = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: timezone }, encoding: "utf8" });
    // A local date helper must never depend on the UTC ISO representation.
    assert.equal(result.status, 0, result.stderr);
  }
});

test("Les séances sont triées et les filtres utilisent le centre du groupe", () => {
  const { run } = calendar([
    session("later", "2026-10-13", "14:00"), session("earlier", "2026-10-13", "08:00"),
    session("other", "2026-10-14", "08:00", "teacher-b", "4e B", "SVT"),
    session("next-week", "2026-10-19", "08:00"),
  ]);
  run("calendarWeek='2026-10-12'");
  assert.deepEqual(JSON.parse(run("JSON.stringify(calendarCourses().map(record=>record.id))")), ["earlier", "later", "other"]);
  run("calendarCentre='Centre A'; calendarTeacher='teacher-a'; calendarSubject='Mathématiques'");
  assert.deepEqual(JSON.parse(run("JSON.stringify(calendarCourses().map(record=>record.id))")), ["earlier", "later"]);
  assert.equal(run("calendarEndTime('23:30', 60)"), "00:30 (+1 j)");
});

test("Le calendrier enseignant présente uniquement ses séances sans action de modification", () => {
  const records = [session("own", "2026-10-13", "08:00"), session("other", "2026-10-13", "10:00", "teacher-b")];
  const { run } = calendar(records, "teacher");
  run("calendarWeek='2026-10-12'");
  const html = run("calendarPage()");
  assert.match(html, /Alice/);
  assert.doesNotMatch(html, /Bob|data-calendar-course|id="calendar-add"/);
  assert.equal((html.match(/class="calendar-course"/g) || []).length, 1);
});

test("Les informations du calendrier sont échappées avant affichage", () => {
  const { run } = calendar([session('id" onclick="alert(1)', "2026-10-13", "08:00", "teacher-a", "<img src=x>", "<script>bad()</script>")]);
  run("calendarWeek='2026-10-12'");
  const html = run("calendarPage()");
  assert.doesNotMatch(html, /<script>|<img src=x>|data-calendar-course="id" onclick=/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
});
