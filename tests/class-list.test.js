"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createClassList } = require("../lib/documents");
const { createApplication } = require("../lib/application");

function inspectPdf(buffer) {
  assert.equal(buffer.subarray(0, 5).toString(), "%PDF-");
  assert.match(buffer.toString("latin1"), /%%EOF\s*$/);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "crs-class-list-pdf-"));
  try {
    const filename = path.join(folder, "liste.pdf");
    fs.writeFileSync(filename, buffer);
    return {
      text: execFileSync("pdftotext", ["-layout", filename, "-"], { encoding: "utf8", timeout: 30000 }),
      coordinates: execFileSync("pdftotext", ["-bbox", filename, "-"], { encoding: "utf8", timeout: 30000 }),
    };
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
}

test("La liste PDF garde le nom complet, les accents et tous les statuts de la classe exacte sans données privées", async () => {
  const className = "6e", centre = "École des Érables";
  const base = { class: className, centre, guardian: "RESPONSABLE CONFIDENTIEL", phone: "+2290198765432", monthlyFee: 987654, username: "COMPTE CONFIDENTIEL" };
  const students = [
    { ...base, name: "Grâce Élodie D’ALMEIDA épouse SÈHOUN", registrationStatus: "Suspendu" },
    { ...base, name: "Benoît François", registrationStatus: "Préinscription" },
    { ...base, name: "Alice Prénoms composés", registrationStatus: "Inscrit" },
    { ...base, name: "AUTRE ÉCOLE", centre: "École de Grâce" },
    { ...base, name: "AUTRE CLASSE", class: "5e" },
  ];
  const original = JSON.stringify(students);
  const { text } = inspectPdf(await createClassList({ students, school: { name: "Cours de l’Espérance", phones: ["CONTACT PRIVÉ"] }, className, centre }));
  assert.match(text, /Cours de l’Espérance/);
  assert.match(text, /Liste de classe/);
  assert.match(text, /École \/ centre : École des Érables/);
  assert.match(text, /Classe : 6e · Établie le \d{2} [a-zéû]+ \d{4}/);
  assert.match(text, /Effectif : 3 élève\(s\)/);
  assert.match(text, /N°\s+Nom et prénoms\s+Classe\s+Signature/);
  for (const [number, name] of [[1, students[2].name], [2, students[1].name], [3, students[0].name]]) {
    assert.ok(text.includes(name), "Le nom combiné est imprimé tel qu’il est enregistré.");
    assert.match(text, new RegExp("\\b" + number + "\\s+" + name + "\\s+6e"));
  }
  assert.doesNotMatch(text, /AUTRE ÉCOLE|AUTRE CLASSE|RESPONSABLE CONFIDENTIEL|0198765432|987654|COMPTE CONFIDENTIEL|CONTACT PRIVÉ|Préinscription|Suspendu|FCFA/);
  assert.equal(JSON.stringify(students), original, "L’export ne modifie ni ne supprime aucun dossier.");
  const empty = inspectPdf(await createClassList({ students, className: "4e", centre })).text;
  assert.match(empty, /Aucun élève enregistré/);
  assert.match(empty, /Effectif : 0/);
});

test("Une longue liste A4 conserve chaque élève, les en-têtes répétés et assez de place pour signer", async () => {
  const students = Array.from({ length: 85 }, (_, index) => ({
    id: String(index), name: `Élève-${String(index).padStart(3, "0")} Grâce Adélaïde`, class: "Première D", centre: "École des Érables",
  }));
  const { text, coordinates } = inspectPdf(await createClassList({ students, school: { name: "Établissement de l’Espérance" }, className: "Première D", centre: students[0].centre }));
  const pages = coordinates.match(/<page\b[\s\S]*?<\/page>/g) || [];
  assert.ok(pages.length >= 5, "La liste longue est répartie sur plusieurs feuilles à signer.");
  const printed = [];
  for (const [index, page] of pages.entries()) {
    assert.match(page, /width="595\.\d+" height="841\.\d+"/, "Chaque feuille respecte le format A4.");
    for (const word of ["Établissement", "Liste", "Classe", "Signature", "École", "Page"]) assert.ok(page.includes(">" + word + "</word>"), `En-tête et pied de page présents sur la page ${index + 1} : ${word}`);
    const rows = [...page.matchAll(/<word\b[^>]*yMin="([\d.]+)"[^>]*>(Élève-\d{3})<\/word>/g)];
    assert.ok(rows.length > 0, "Aucune feuille vide n’est ajoutée.");
    for (let row = 1; row < rows.length; row++) assert.ok(Number(rows[row][1]) - Number(rows[row - 1][1]) >= 40, "Chaque élève dispose d’au moins 40 points pour signer.");
    printed.push(...rows.map(row => row[2]));
  }
  assert.deepEqual(printed, students.map(student => student.name.split(" ")[0]), "Chaque élève figure une seule fois dans l’ordre alphabétique.");
  assert.equal((text.match(/Nom et prénoms/g) || []).length, pages.length);
  assert.equal((text.match(/Effectif : 85/g) || []).length, pages.length);
  assert.match(text, new RegExp(`Page ${pages.length} / ${pages.length}`));
});

test("L’API de liste PDF réserve l’export au responsable et au caissier et exige une école et une classe exactes", async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "crs-class-list-api-"));
  const instance = await createApplication({ dataDir: folder, setupToken: "class-list-test-setup" });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await instance.db.close(); fs.rmSync(folder, { recursive: true, force: true }); });
  async function call(route, method = "GET", body, session) {
    const response = await fetch(base + route, { method, redirect: "manual", headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(session ? { Cookie: session.cookie, "X-CSRF-Token": session.csrf } : {}),
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = response.headers.get("content-type")?.includes("application/json") ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, data, type: response.headers.get("content-type"), disposition: response.headers.get("content-disposition"), cookie: response.headers.get("set-cookie")?.split(";")[0], csrf: data.csrf };
  }
  const password = "Class-list-fixture-123!";
  const admin = await call("/api/auth/setup", "POST", { username: "class-list-admin", password, token: "class-list-test-setup" });
  assert.equal(admin.status, 200);
  const school = (await call("/api/catalogue")).data;
  const centre = school.centres[0], otherCentre = school.centres[1];
  assert.ok(centre && otherCentre);
  async function create(kind, body) { const result = await call("/api/records/" + kind, "POST", body, admin); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data; }
  const defaults = { class: "6e", centre, group: "6e · " + centre, guardian: "PARENT PRIVÉ API", phone: "+2290198765432", monthlyFee: 987654 };
  const first = await create("students", { ...defaults, name: "Élodie Élève inscrite" });
  await create("students", { ...defaults, name: "Benoît Préinscrit", registrationStatus: "Préinscription" });
  await create("students", { ...defaults, name: "Camille Suspendu", registrationStatus: "Suspendu" });
  await create("students", { ...defaults, name: "AUTRE ÉCOLE API", centre: otherCentre });
  await create("students", { ...defaults, name: "AUTRE CLASSE API", class: "5e" });
  const teacher = await create("teachers", { name: "Professeur confidentiel", subject: "Mathématiques" });
  const actors = {};
  for (const [role, entityId] of [["cashier", undefined], ["teacher", teacher.id], ["student", first.id]]) {
    const created = await call("/api/admin/users", "POST", { username: "class-list-" + role, role, entityId, password }, admin);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const logged = await call("/api/auth/login", "POST", { username: "class-list-" + role, password, ...(role === "cashier" ? { space: "cashier" } : {}) });
    assert.equal(logged.status, 200);
    actors[role] = await call("/api/auth/password", "POST", { currentPassword: password, password: "Personal-class-list-" + role + "-123!" }, logged);
    assert.equal(actors[role].status, 200);
  }
  const query = (className = "6e", location = centre) => "/api/reports/class.pdf?" + new URLSearchParams({ class: className, centre: location });
  assert.equal((await call(query())).status, 401);
  for (const role of ["teacher", "student"]) assert.equal((await call(query(), "GET", undefined, actors[role])).status, 403);
  const before = (await call("/api/data", "GET", undefined, admin)).data;
  for (const actor of [admin, actors.cashier]) {
    for (const route of ["/api/reports/class.pdf", query(""), query("6e", ""), query(" ", " ")]) assert.equal((await call(route, "GET", undefined, actor)).status, 400);
    for (const route of [query("Classe inconnue"), query("6E"), query("6e", "École inconnue"), query("6e", centre.toLocaleLowerCase("fr-FR"))]) assert.equal((await call(route, "GET", undefined, actor)).status, 404, route);
    for (const route of [query(), query(" 6e ", " " + centre + " ")]) {
      const result = await call(route, "GET", undefined, actor);
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.match(result.type, /application\/pdf/);
      assert.match(result.disposition, /attachment;.*\.pdf/);
      const output = inspectPdf(result.data).text;
      for (const name of [first.name, "Benoît Préinscrit", "Camille Suspendu"]) assert.ok(output.includes(name));
      assert.match(output, /Effectif : 3/);
      assert.doesNotMatch(output, /AUTRE ÉCOLE API|AUTRE CLASSE API|PARENT PRIVÉ API|0198765432|987654|Professeur confidentiel|FCFA|class-list-admin/);
    }
    const empty = await call(query("4e"), "GET", undefined, actor);
    assert.equal(empty.status, 200);
    assert.match(inspectPdf(empty.data).text, /Aucun élève enregistré/);
  }
  const after = (await call("/api/data", "GET", undefined, admin)).data;
  assert.deepEqual(after, before, "L’export conserve tous les dossiers et ne crée aucune présence ni aucun paiement.");
});
