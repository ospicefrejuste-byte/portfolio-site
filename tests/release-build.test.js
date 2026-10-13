"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildRelease } = require("../scripts/build-release");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crs-release-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const folder of ["public/vendor", "lib", "scripts", "netlify/functions", "data"]) fs.mkdirSync(path.join(root, folder), { recursive: true });
  const write = (file, value) => fs.writeFileSync(path.join(root, file), value);
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  for (const page of ["index", "connexion", "installation", "gestion"]) write(`public/${page}.html`, '<!doctype html>\n<head>\n  <meta charset="utf-8">\n  <link rel="stylesheet" href="/style.css?theme=dark&amp;v=old#colors">\n</head>\n<body><script src="app.js?v=old&amp;locale=fr"></script><script src="vendor/provider.js"></script><script src="https://example.com/external.js?v=external"></script></body>\n');
  write("public/style.css", "body { color: navy; }\n");
  write("public/app.js", "console.log('bonjour');\n");
  write("public/vendor/provider.js", "/* provider */\n");
  write("lib/application.js", "module.exports = {};\n");
  write("scripts/build-cloud.js", "/* generate cloud */\n");
  write("scripts/build-release.js", "/* release helper */\n");
  write("netlify/functions/api.js", "module.exports = {};\n");
  write("netlify.toml", '[build]\npublish = "public"\n');
  write("package-lock.json", '{"lockfileVersion": 3}\n');
  return { root, write, read };
}

test("Une publication garde la même version après plusieurs builds et versionne tous les fichiers locaux", (t) => {
  const { root, read } = fixture(t);
  const { version } = buildRelease(root);
  assert.match(version, /^[a-f\d]{64}$/);
  const pages = ["index", "connexion", "installation", "gestion"].map((name) => read(`public/${name}.html`));
  for (const html of pages) {
    assert.ok(html.includes(`<meta name="crs-version" content="${version}">`));
    assert.ok(html.includes(`href="/style.css?theme=dark&amp;v=${version}#colors"`));
    assert.ok(html.includes(`src="app.js?locale=fr&amp;v=${version}"`));
    assert.ok(html.includes(`src="vendor/provider.js?v=${version}"`));
    assert.ok(html.includes('src="https://example.com/external.js?v=external"'));
    assert.equal((html.match(/name="crs-version"/g) || []).length, 1);
  }
  assert.equal(buildRelease(root).version, version);
  assert.equal(buildRelease(root).version, version);
  assert.deepEqual(["index", "connexion", "installation", "gestion"].map((name) => read(`public/${name}.html`)), pages);
  assert.deepEqual(JSON.parse(read("public/version.json")), { version });
});

test("Une modification CSS, JavaScript ou serveur génère une nouvelle version pour les visiteurs", (t) => {
  const { root, write } = fixture(t);
  let current = buildRelease(root).version;
  for (const [file, text] of [["public/style.css", "body { color: gold; }\n"], ["public/app.js", "console.log('nouveau');\n"], ["lib/application.js", "module.exports = { migration: true };\n"], ["netlify/functions/api.js", "module.exports = { fixed: true };\n"]]) {
    write(file, text);
    const next = buildRelease(root).version;
    assert.notEqual(next, current, file);
    assert.equal(buildRelease(root).version, next);
    current = next;
  }
});

test("Un changement d’image ou de police suffit à mettre à jour la publication sans boucle du manifeste", (t) => {
  const { root, write, read } = fixture(t);
  fs.mkdirSync(path.join(root, "public/images"));
  fs.mkdirSync(path.join(root, "public/fonts"));
  fs.mkdirSync(path.join(root, "lib/assets"));
  write("public/images/logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"><text>CR</text></svg>');
  write("public/images/photo.png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  write("public/fonts/interface.woff2", Buffer.from([119, 79, 70, 50, 1]));
  write("lib/assets/DejaVuSans.ttf", Buffer.from([0, 1, 0, 0, 1]));
  let current = buildRelease(root).version;
  for (const [file, content] of [
    ["public/images/logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"><text>Nouveau logo</text></svg>'],
    ["public/images/photo.png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 2])],
    ["public/fonts/interface.woff2", Buffer.from([119, 79, 70, 50, 2])],
    ["lib/assets/DejaVuSans.ttf", Buffer.from([0, 1, 0, 0, 2])],
  ]) {
    write(file, content);
    const next = buildRelease(root).version;
    assert.notEqual(next, current, file);
    write("public/version.json", '{"version":"stale-generated-manifest"}\n');
    assert.equal(buildRelease(root).version, next);
    assert.deepEqual(JSON.parse(read("public/version.json")), { version: next });
    current = next;
  }
});

test("Les valeurs générées et les fichiers privés ne changent pas la version et ne sont jamais publiés", (t) => {
  const { root, read, write } = fixture(t);
  const { version } = buildRelease(root);
  for (const page of ["index", "connexion", "installation", "gestion"]) write(`public/${page}.html`, read(`public/${page}.html`).replaceAll(version, "unrelated-draft-version"));
  write("public/version.json", '{"version":"incorrect"}\n');
  write(".env", "PRIVATE_VALUE=do-not-publish\n");
  write("data/backup.json", '{"password":"private-test-value"}\n');
  assert.equal(buildRelease(root).version, version);
  assert.deepEqual(JSON.parse(read("public/version.json")), { version });
  assert.doesNotMatch(read("public/index.html") + read("public/version.json"), /private-test-value|do-not-publish/);
});

test("Les assets inexistants arrêtent le build avant tout changement des pages ou du manifeste", (t) => {
  const { root, read, write } = fixture(t);
  buildRelease(root);
  const previous = read("public/version.json");
  write("public/gestion.html", read("public/gestion.html").replace("vendor/provider.js", "vendor/missing.js"));
  const pages = read("public/index.html");
  assert.throws(() => buildRelease(root), /Ressource locale introuvable.*missing\.js/);
  assert.equal(read("public/version.json"), previous);
  assert.equal(read("public/index.html"), pages);
});

test("Les commentaires, scripts externes et feuilles de style avec plusieurs paramètres restent corrects", (t) => {
  const { root, read, write } = fixture(t);
  write("public/index.html", '<head><meta content="draft" name="crs-version"><!-- <script src="missing.js"></script> --><link href=style.css?v=one&amp;mode=print&amp;v=two rel=stylesheet></head><script src="//cdn.example.com/provider.js"></script>');
  const { version } = buildRelease(root);
  assert.ok(read("public/index.html").includes(`href="style.css?mode=print&amp;v=${version}"`));
  assert.ok(read("public/index.html").includes('src="//cdn.example.com/provider.js"'));
  assert.equal(buildRelease(root).version, version);
});
