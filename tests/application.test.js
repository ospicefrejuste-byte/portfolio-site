"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApplication } = require("../lib/application");
const password = "Test-only-password-123!";
test("Gestion des matières, coordonnées et salles distinctes par centre", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "crs-management-test-"));
  const instance = createApplication({ dataDir, setupToken: "management-test-only" });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    instance.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let session;
  async function call(route, body, method = "POST", authenticated = true) {
    const response = await fetch(base + route, {
      method,
      headers: { "Content-Type": "application/json", ...(session && authenticated ? { Cookie: session.cookie, "X-CSRF-Token": session.csrf } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  }
  const setup = await call("/api/auth/setup", { username: "admin", password, token: "management-test-only" });
  assert.equal(setup.status, 200);
  session = { cookie: setup.cookie, csrf: setup.data.csrf };
  const registration = { name: "Élève matières", class: "6e", centre: "CP La Boussole", guardian: "Responsable fictif", phone: "01 00 00 00 00", subjects: ["Mathématiques", "SVT"], consent: true };
  for (const phone of ["--------", "((((((((", "0000000000000000"])
    assert.equal((await call("/api/registrations", { ...registration, phone }, "POST", false)).status, 400);
  assert.equal((await call("/api/registrations", registration, "POST", false)).status, 201);
  const snapshot = (await call("/api/data", undefined, "GET")).data;
  const student = snapshot.students[0];
  const changed = await call("/api/records/students/" + student.id, { registrationStatus: "Inscrit" }, "PUT");
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.data.subjects, registration.subjects);
  assert.equal(changed.data.createdAt, student.createdAt);
  assert.equal((await call("/api/records/students/" + student.id, { phone: "--------" }, "PUT")).status, 400);
  async function create(kind, body) {
    const response = await call("/api/records/" + kind, body);
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data;
  }
  const elsewhere = await create("students", { name: "Élève autre centre", class: "4e", centre: "EPP Borarou", group: "4e · EPP Borarou" });
  const sameCentre = await create("students", { name: "Élève même centre", class: "3e", centre: student.centre, group: "3e · CP La Boussole" });
  const firstTeacher = await create("teachers", { name: "Enseignant A", subject: "Mathématiques" });
  const secondTeacher = await create("teachers", { name: "Enseignant B", subject: "Mathématiques" });
  const thirdTeacher = await create("teachers", { name: "Enseignant C", subject: "Mathématiques" });
  const course = { subject: "Mathématiques", group: student.group, teacher: firstTeacher.id, date: "2026-11-15", time: "16:00", duration: 60, room: "Salle 01" };
  await create("courses", course);
  await create("courses", { ...course, group: elsewhere.group, teacher: secondTeacher.id });
  assert.equal((await call("/api/records/courses", { ...course, group: sameCentre.group, teacher: thirdTeacher.id })).status, 409);
  assert.equal((await call("/api/records/courses", { ...course, group: elsewhere.group, room: "Salle 02" })).status, 409);
});
test("Authentification, dossiers, rôles et conservation des données", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "crs-api-test-"));
  let instance = createApplication({
    dataDir,
    setupToken: "test-only-setup-token",
  });
  let server = instance.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  let base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    instance.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  async function request(route, method = "GET", body, session, extra = {}) {
    const r = await fetch(base + route, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(session
          ? { Cookie: session.cookie, "X-CSRF-Token": session.csrf }
          : {}),
        ...extra,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json();
    return {
      status: r.status,
      data,
      cookie: r.headers.get("set-cookie")?.split(";")[0],
      csrf: data.csrf,
    };
  }
  const login = async (username) => {
    const r = await request("/api/auth/login", "POST", { username, password });
    assert.equal(r.status, 200);
    return r;
  };
  assert.equal((await request("/api/data")).status, 401);
  assert.equal(
    (
      await request("/api/auth/setup", "POST", {
        username: "admin",
        password,
        token: "wrong",
      })
    ).status,
    403,
  );
  let admin = await request("/api/auth/setup", "POST", {
    username: "admin",
    password,
    token: "test-only-setup-token",
  });
  assert.equal(admin.status, 200);
  assert.equal(
    (
      await request("/api/auth/setup", "POST", {
        username: "other",
        password,
        token: "test-only-setup-token",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request("/api/auth/login", "POST", {
        username: "admin",
        password: "wrong",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request(
        "/api/records/students",
        "POST",
        { name: "Fake" },
        { cookie: admin.cookie, csrf: "wrong" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/registrations", "POST", {}, null, {
        Origin: "https://untrusted.example",
      })
    ).status,
    403,
  );
  const registration = await request("/api/registrations", "POST", {
    name: "Élève public",
    class: "6e",
    centre: "CP La Boussole",
    guardian: "Parent test",
    phone: "0000000000",
    subjects: ["Mathématiques"],
    consent: true,
    registrationStatus: "Inscrit",
    monthlyFee: 1,
  });
  assert.equal(registration.status, 201);
  let data = (await request("/api/data", "GET", undefined, admin)).data;
  assert.equal(data.students[0].registrationStatus, "Préinscription");
  assert.equal(data.students[0].monthlyFee, 3500);
  assert.equal(
    (
      await request("/api/registrations", "POST", {
        name: "Bad",
        class: "6e",
        centre: "CP La Boussole",
        guardian: "Parent",
        phone: "0000000000",
        subjects: [],
        consent: true,
      })
    ).status,
    400,
  );
  const create = async (kind, body, session = admin) => {
    const r = await request("/api/records/" + kind, "POST", body, session);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data;
  };
  const s = await create("students", {
    name: "Élève A",
    class: "6e",
    group: "6e A",
    guardian: "Confidentiel",
    phone: "0000000000",
  });
  const unrelated = await create("students", {
    name: "Élève B",
    class: "4e",
    group: "4e B",
  });
  const teacher = await create("teachers", {
    name: "Enseignant A",
    subject: "Mathématiques",
  });
  const otherTeacher = await create("teachers", {
    name: "Enseignant B",
    subject: "SVT",
  });
  const c = await create("courses", {
    subject: "Mathématiques",
    group: s.group,
    teacher: teacher.id,
    date: "2026-10-12",
    time: "16:00",
    duration: 90,
    room: "Salle A",
  });
  const otherCourse = await create("courses", {
    subject: "SVT",
    group: unrelated.group,
    teacher: otherTeacher.id,
    date: "2026-10-12",
    time: "16:00",
    duration: 90,
    room: "Salle B",
  });
  assert.equal(
    (
      await request(
        "/api/records/courses",
        "POST",
        { ...c, time: "16:30" },
        admin,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await request(
        "/api/records/courses",
        "POST",
        { ...c, date: "2026-02-30" },
        admin,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/api/records/courses",
        "POST",
        { ...c, time: "23:45" },
        admin,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/api/admin/users",
        "POST",
        {
          username: "teacher",
          password,
          role: "teacher",
          entityId: teacher.id,
        },
        admin,
      )
    ).status,
    201,
  );
  let teacherSession = await login("teacher");
  assert.equal(
    (await request("/api/data", "GET", undefined, teacherSession)).status,
    403,
  );
  const changed = "Changed-only-password-123!";
  teacherSession = await request(
    "/api/auth/password",
    "POST",
    { currentPassword: password, password: changed },
    teacherSession,
  );
  assert.equal(teacherSession.status, 200);
  data = (await request("/api/data", "GET", undefined, teacherSession)).data;
  assert.equal(data.students.length, 1);
  assert.equal(data.students[0].guardian, undefined);
  assert.equal(data.courses.length, 1);
  assert.deepEqual(data.payments, []);
  assert.equal(
    (await request("/api/admin/users", "GET", undefined, teacherSession))
      .status,
    403,
  );
  assert.equal(
    (
      await request(
        "/api/records/payments",
        "POST",
        { student: s.id, amount: 3500, date: "2026-10-12", period: "2026-10" },
        teacherSession,
      )
    ).status,
    403,
  );
  const grade = await create(
    "grades",
    { student: s.id, course: c.id, score: 17, label: "Test" },
    teacherSession,
  );
  assert.equal(
    (
      await request(
        "/api/records/grades/" + grade.id,
        "PUT",
        {
          student: unrelated.id,
          course: otherCourse.id,
          score: 18,
          label: "Forbidden",
        },
        teacherSession,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        "/api/records/grades",
        "POST",
        { student: s.id, course: c.id, score: 25, label: "Bad" },
        teacherSession,
      )
    ).status,
    400,
  );
  const attendance = await create(
    "attendance",
    { student: s.id, course: c.id, status: "Présent" },
    teacherSession,
  );
  assert.equal(
    (
      await request(
        "/api/records/attendance",
        "POST",
        { student: s.id, course: c.id, status: "Absent" },
        teacherSession,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await request(
        "/api/records/attendance/" + attendance.id,
        "PUT",
        { status: "Retard", course: c.id },
        teacherSession,
      )
    ).status,
    200,
  );
  const payment = await create("payments", {
    student: s.id,
    amount: 3500,
    date: "2026-10-12",
    period: "2026-10",
  });
  assert.equal(
    (
      await request(
        "/api/records/students/" + s.id,
        "PUT",
        { group: "Different" },
        admin,
      )
    ).status,
    409,
  );
  assert.equal(
    (await request("/api/records/students/" + s.id, "DELETE", undefined, admin))
      .status,
    409,
  );
  let studentAccount = await request(
    "/api/admin/users",
    "POST",
    { username: "student", password, role: "student", entityId: s.id },
    admin,
  );
  assert.equal(studentAccount.status, 201);
  let studentSession = await login("student");
  studentSession = await request(
    "/api/auth/password",
    "POST",
    { currentPassword: password, password: changed },
    studentSession,
  );
  data = (await request("/api/data", "GET", undefined, studentSession)).data;
  assert.equal(data.students.length, 1);
  assert.equal(data.students[0].id, s.id);
  assert.equal(data.payments[0].id, payment.id);
  assert.equal(data.grades[0].id, grade.id);
  assert.equal(
    (
      await request(
        "/api/records/grades/" + grade.id,
        "DELETE",
        undefined,
        studentSession,
      )
    ).status,
    403,
  );
  assert.equal(
    (await request("/api/admin/export", "GET", undefined, studentSession))
      .status,
    403,
  );
  assert.equal(
    (await request("/api/admin/export", "GET", undefined, admin)).status,
    200,
  );
  assert.equal(
    (
      await request(
        "/api/admin/users/" + admin.data.user.id,
        "PUT",
        { enabled: false },
        admin,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/api/admin/users/" + studentAccount.data.id,
        "PUT",
        { password: "Reset-only-password-123!" },
        admin,
      )
    ).status,
    200,
  );
  assert.equal(
    (await request("/api/data", "GET", undefined, studentSession)).status,
    401,
  );
  assert.equal(
    (
      await request(
        "/api/admin/users/" + studentAccount.data.id,
        "PUT",
        { enabled: false },
        admin,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/api/auth/login", "POST", {
        username: "student",
        password: "Reset-only-password-123!",
      })
    ).status,
    401,
  );
  assert.equal(
    (await request("/api/auth/logout", "POST", {}, teacherSession)).status,
    200,
  );
  assert.equal(
    (await request("/api/data", "GET", undefined, teacherSession)).status,
    401,
  );
  await new Promise((resolve) => server.close(resolve));
  instance.db.close();
  instance = createApplication({ dataDir });
  server = instance.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login("admin");
  data = (await request("/api/data", "GET", undefined, admin)).data;
  assert.equal(data.payments[0].id, payment.id);
  assert.equal(data.students.length, 3);
  assert.equal((await request("/api/health")).data.setupRequired, false);
});
