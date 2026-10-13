"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApplication } = require("../lib/application");
const password = "Daily-attendance-test-123!";

test("Présences quotidiennes de caisse : autorisations, classes, sauvegarde atomique et conflits", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "crs-daily-attendance-"));
  let instance = createApplication({ dataDir, setupToken: "daily-test-only" });
  let server = instance.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  let base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); instance.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  async function call(route, method = "GET", body, session, headers = {}) {
    const response = await fetch(base + route, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(session ? { Cookie: session.cookie, "X-CSRF-Token": session.csrf } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    return { status: response.status, data, cookie: response.headers.get("set-cookie")?.split(";")[0], csrf: data.csrf };
  }
  const admin = await call("/api/auth/setup", "POST", { username: "responsable-daily", password, token: "daily-test-only" });
  assert.equal(admin.status, 200);
  const school = (await call("/api/catalogue")).data;
  const centre = school.centres[0], secondCentre = school.centres[1];
  async function create(kind, body) { const result = await call("/api/records/" + kind, "POST", body, admin); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data; }
  const defaults = { class: "6e", centre, group: "6e · " + centre, guardian: "Parent privé", phone: "+2290100000000", monthlyFee: 5000 };
  const first = await create("students", { ...defaults, name: "Alpha quotidien" });
  const second = await create("students", { ...defaults, name: "Bêta préinscription", registrationStatus: "Préinscription" });
  const untouched = await create("students", { ...defaults, name: "Gamma non pointé" });
  const elsewhere = await create("students", { ...defaults, name: "Autre école", centre: secondCentre, group: "6e · " + secondCentre });
  const otherClass = await create("students", { ...defaults, name: "Autre classe", class: "4e", group: "4e · " + centre });
  const suspended = await create("students", { ...defaults, name: "Suspendu", registrationStatus: "Suspendu" });
  const teacher = await create("teachers", { name: "Professeur privé", subject: "Mathématiques" });
  const actors = {};
  for (const [role, entityId] of [["cashier", undefined], ["teacher", teacher.id], ["student", first.id]]) {
    assert.equal((await call("/api/admin/users", "POST", { username: role + "-daily", role, password, entityId }, admin)).status, 201);
    const logged = await call("/api/auth/login", "POST", { username: role + "-daily", password, ...(role === "cashier" ? { space: "cashier" } : {}) });
    assert.equal(logged.status, 200);
    actors[role] = await call("/api/auth/password", "POST", { currentPassword: password, password: "Personal-" + role + "-daily-123!" }, logged);
    assert.equal(actors[role].status, 200);
  }
  const query = (day = "2026-10-13", location = centre, level = "6e") => "/api/cashier/attendance?" + new URLSearchParams({ date: day, centre: location, class: level });
  const body = (entries, extra = {}) => ({ date: "2026-10-13", centre, class: "6e", entries, ...extra });
  const entry = (student, status, revision = 0) => ({ student: student.id, status, revision });
  assert.equal((await call(query())).status, 401);
  for (const role of ["teacher", "student"]) {
    assert.equal((await call(query(), "GET", undefined, actors[role])).status, 403);
    assert.equal((await call("/api/cashier/attendance", "POST", body([entry(first, "Présent")]), actors[role])).status, 403);
  }
  for (const route of ["/api/admin/users", "/api/admin/settings", "/api/admin/export", "/api/admin/monthly-balances?period=2026-10"])
    assert.equal((await call(route, "GET", undefined, actors.cashier)).status, 403);
  assert.ok(Object.values((await call("/api/data", "GET", undefined, actors.cashier)).data).every((rows) => Array.isArray(rows) && rows.length === 0));
  for (const method of ["POST", "PUT", "DELETE"]) {
    const route = "/api/records/dailyAttendance" + (method === "POST" ? "" : "/invented");
    for (const actor of [admin, actors.cashier]) assert.equal((await call(route, method, method === "DELETE" ? undefined : {}, actor)).status, 403);
  }
  for (const route of ["/api/records/students", "/api/records/attendance", "/api/records/grades"])
    assert.equal((await call(route, "POST", {}, actors.cashier)).status, 403);
  for (const route of [query("2026-02-30"), query("not-a-date"), query("2026-10-13", ""), query("2026-10-13", "École inconnue"), query("2026-10-13", centre, "Classe inconnue")])
    assert.equal((await call(route, "GET", undefined, actors.cashier)).status, 400);
  const initial = (await call(query(), "GET", undefined, actors.cashier)).data;
  assert.deepEqual(initial.students.map((student) => student.id), [first.id, second.id, untouched.id]);
  assert.deepEqual(initial.totals, { present: 0, absent: 0, unmarked: 3 });
  assert.equal(initial.students[1].registrationStatus, "Préinscription");
  assert.ok(initial.students.every((student) => student.status === null && student.revision === 0));
  assert.ok(initial.students.every((student) => student.phone === undefined && student.guardian === undefined));
  assert.equal((await call("/api/cashier/attendance", "POST", body([entry(first, "Présent")]), { ...actors.cashier, csrf: "incorrect" })).status, 403);
  assert.equal((await call("/api/cashier/attendance", "POST", body([entry(first, "Présent")]), actors.cashier, { Origin: "https://untrusted.example" })).status, 403);
  for (const bad of [body([]), body([entry(first, "Présent"), entry(first, "Absent")]), body([entry(first, "Présent"), entry(second, "Retard")]), body([entry(first, "Présent"), entry(second, "Absent", -1)]), body([entry(first, "Présent"), entry(elsewhere, "Absent")]), body([entry(first, "Présent"), entry(otherClass, "Absent")]), body([entry(first, "Présent"), entry(suspended, "Absent")])]) {
    const response = await call("/api/cashier/attendance", "POST", bad, actors.cashier);
    assert.ok([400, 409].includes(response.status), JSON.stringify(response.data));
    assert.equal((await call("/api/data", "GET", undefined, admin)).data.dailyAttendance.length, 0, "Une erreur de lot ne crée aucun pointage partiel.");
  }
  const intent = body([entry(first, "Présent"), entry(second, "Absent"), entry(untouched, null)], { markedBy: admin.data.user.id, markedByName: "acteur falsifié" });
  const marked = await call("/api/cashier/attendance", "POST", intent, actors.cashier);
  assert.equal(marked.status, 200); assert.deepEqual(marked.data.totals, { present: 1, absent: 1, unmarked: 1 });
  let data = (await call("/api/data", "GET", undefined, admin)).data;
  assert.equal(data.courses.length, 0, "Le pointage quotidien ne nécessite pas de séance planifiée.");
  assert.equal(data.dailyAttendance.length, 2);
  const firstRecord = data.dailyAttendance.find((record) => record.student === first.id);
  assert.equal(firstRecord.markedBy, actors.cashier.data.user.id); assert.equal(firstRecord.markedByName, "cashier-daily"); assert.equal(firstRecord.studentName, first.name); assert.equal(firstRecord.revision, 1);
  assert.equal(data.students.find((student) => student.id === second.id).registrationStatus, "Préinscription", "La présence ne valide pas l’inscription.");
  assert.equal((await call("/api/cashier/attendance", "POST", intent, actors.cashier)).status, 200);
  assert.deepEqual((await call("/api/data", "GET", undefined, admin)).data.dailyAttendance, data.dailyAttendance, "Un nouvel essai identique ne modifie ni révision ni horodatage.");
  assert.equal((await call("/api/cashier/attendance", "POST", body([entry(first, "Absent", 1)]), admin)).status, 200);
  assert.equal((await call("/api/cashier/attendance", "POST", body([entry(first, "Présent", 1), entry(second, "Présent", 1)]), actors.cashier)).status, 409);
  data = (await call("/api/data", "GET", undefined, admin)).data;
  assert.equal(data.dailyAttendance.find((record) => record.student === second.id).status, "Absent");
  assert.equal(data.dailyAttendance.find((record) => record.student === first.id).revision, 2);
  assert.equal((await call("/api/cashier/attendance", "POST", body([entry(first, "Absent", 1)]), actors.cashier)).status, 200);
  assert.equal((await call("/api/cashier/attendance", "POST", body([entry(first, "Absent", 99)]), actors.cashier)).status, 409);
  const competing = await Promise.all(["Présent", null].map((status) => call("/api/cashier/attendance", "POST", body([entry(second, status, 1)]), actors.cashier)));
  assert.deepEqual(competing.map((result) => result.status).sort(), [200, 409]);
  const cleared = await call("/api/cashier/attendance", "POST", body([entry(first, null, 2)]), actors.cashier);
  assert.equal(cleared.status, 200); assert.equal(cleared.data.students.find((student) => student.id === first.id).revision, 3);
  assert.equal((await call("/api/records/students/" + first.id, "DELETE", undefined, admin)).status, 409, "Le responsable ne peut pas effacer un élève lié au pointage.");
  const moved = await call("/api/records/students/" + first.id, "PUT", { class: "4e", centre: secondCentre, group: "4e · " + secondCentre, registrationStatus: "Suspendu" }, admin);
  assert.equal(moved.status, 200);
  const history = (await call(query(), "GET", undefined, actors.cashier)).data.students.find((student) => student.id === first.id);
  assert.equal(history.class, "6e"); assert.equal(history.centre, centre); assert.equal(history.status, null); assert.equal(history.revision, 3); assert.equal(history.registrationStatus, "Suspendu");
  assert.equal((await call(query("2026-10-13", secondCentre, "4e"), "GET", undefined, actors.cashier)).data.students.some((student) => student.id === first.id), false);
  assert.equal((await call(query("2026-10-14"), "GET", undefined, actors.cashier)).data.students.some((student) => student.id === first.id), false);
  assert.equal((await call("/api/data", "GET", undefined, actors.teacher)).data.dailyAttendance.length, 0);
  const own = (await call("/api/data", "GET", undefined, actors.student)).data.dailyAttendance;
  assert.equal(own.length, 1); assert.equal(own[0].student, first.id); assert.equal(own[0].markedByName, undefined);

  // The portal chooses which roles may sign in, without granting new rights.
  let sessionCount = Number(instance.db.prepare("SELECT count(*) n FROM sessions").get().n);
  for (const [username, role, space] of [["cashier-daily", "cashier", "administration"], ["teacher-daily", "teacher", "cashier"], ["student-daily", "student", "cashier"]]) {
    const denied = await call("/api/auth/login", "POST", { username, password: "Personal-" + role + "-daily-123!", space });
    assert.equal(denied.status, 403); assert.equal(denied.cookie, undefined);
  }
  assert.equal(Number(instance.db.prepare("SELECT count(*) n FROM sessions").get().n), sessionCount);
  assert.equal((await call("/api/auth/login", "POST", { username: "cashier-daily", password: "wrong", space: "administration" })).status, 401);
  assert.equal((await call("/api/auth/login", "POST", { username: "responsable-daily", password, space: "unexpected" })).status, 400);
  for (const space of ["administration", "cashier"]) assert.equal((await call("/api/auth/login", "POST", { username: "responsable-daily", password, space })).status, 200);
  for (const [route, location] of [["/caisse", "/connexion.html?espace=caisse"], ["/caisse/", "/connexion.html?espace=caisse"], ["/administration", "/connexion.html?espace=administration"]]) {
    const response = await fetch(base + route, { redirect: "manual" });
    assert.equal(response.status, 302); assert.equal(response.headers.get("location"), location); assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const retained = (await call("/api/data", "GET", undefined, admin)).data.dailyAttendance;
  await new Promise((resolve) => server.close(resolve)); instance.db.close();
  instance = createApplication({ dataDir }); server = instance.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve)); base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual((await call("/api/data", "GET", undefined, admin)).data.dailyAttendance, retained, "Les pointages et sessions persistent après redémarrage.");
});
