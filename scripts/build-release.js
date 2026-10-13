"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const versionMeta = '<meta name="crs-version" content="">';
const requiredPages = ["index.html", "connexion.html", "installation.html", "gestion.html"];
const fontExtensions = [".woff", ".woff2", ".ttf", ".otf"];
const publicExtensions = [".html", ".js", ".css", ".svg", ".png", ".jpeg", ".jpg", ".gif", ".webp", ".avif", ".ico", ...fontExtensions];

function attributes(tag) {
  const result = {};
  const source = tag.replace(/^<\w+\b/, "").replace(/\/?>$/, "");
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g;
  for (const match of source.matchAll(pattern)) result[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  return result;
}

function decodeAttribute(value) {
  return value.replace(/&amp;/gi, "&").replace(/&#(?:38|x26);/gi, "&");
}

function escapeAttribute(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function versionAsset(value, page, publicDir, version) {
  const decoded = decodeAttribute(value);
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(decoded)) return value;
  const address = new URL(decoded, `https://release.invalid/${page}`);
  if (!/\.(?:js|css)$/i.test(address.pathname)) return value;
  const filename = path.resolve(publicDir, `.${decodeURIComponent(address.pathname)}`);
  const relative = path.relative(publicDir, filename);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(filename) || !fs.statSync(filename).isFile())
    throw new Error(`Ressource locale introuvable dans ${page} : ${decoded}`);
  const realRelative = path.relative(publicDir, fs.realpathSync(filename));
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw new Error(`Ressource hors du dossier public : ${decoded}`);
  const fragmentIndex = decoded.indexOf("#");
  const fragment = fragmentIndex < 0 ? "" : decoded.slice(fragmentIndex);
  const beforeFragment = fragmentIndex < 0 ? decoded : decoded.slice(0, fragmentIndex);
  const queryIndex = beforeFragment.indexOf("?");
  const pathname = queryIndex < 0 ? beforeFragment : beforeFragment.slice(0, queryIndex);
  const query = queryIndex < 0 ? [] : beforeFragment.slice(queryIndex + 1).split("&").filter(Boolean);
  const retained = query.filter((parameter) => decodeURIComponent(parameter.split("=", 1)[0]) !== "v");
  if (version) retained.push(`v=${version}`);
  return escapeAttribute(`${pathname}${retained.length ? `?${retained.join("&")}` : ""}${fragment}`);
}

function prepareHtml(source, page, publicDir, version = "") {
  let foundMeta = false;
  let result = source.replace(/<!--[\s\S]*?-->|<(script|link|meta)\b[^>]*>/gi, (tag, name) => {
    if (!name) return tag;
    const values = attributes(tag);
    if (name.toLowerCase() === "meta" && values.name?.toLowerCase() === "crs-version") {
      if (foundMeta) return "";
      foundMeta = true;
      return versionMeta.replace('content=""', `content="${version}"`);
    }
    const attribute = name.toLowerCase() === "script" ? "src" : name.toLowerCase() === "link" && values.rel?.toLowerCase().split(/\s+/).includes("stylesheet") ? "href" : null;
    if (!attribute || values[attribute] == null) return tag;
    const replacement = versionAsset(values[attribute], page, publicDir, version);
    return tag.replace(new RegExp(`\\s${attribute}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'<>\x60]+)`, "i"), ` ${attribute}="${replacement}"`);
  });
  if (!foundMeta) {
    if (!/<head\b[^>]*>/i.test(result)) throw new Error(`Balise head absente : ${page}`);
    result = result.replace(/(<head\b[^>]*>)(\s*)/i, (_, head, spacing) => `${head}${spacing}${versionMeta.replace('content=""', `content="${version}"`)}${spacing}`);
  }
  return result;
}

function collectFiles(root, folder, extensions) {
  const base = path.join(root, folder);
  if (!fs.existsSync(base)) return [];
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Lien symbolique inattendu : ${path.relative(root, filename)}`);
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase())) files.push(path.relative(root, filename).split(path.sep).join("/"));
    }
  }
  visit(base);
  return files;
}

function buildRelease(root = path.join(__dirname, "..")) {
  root = path.resolve(root);
  const publicDir = path.join(root, "public");
  for (const page of requiredPages) if (!fs.existsSync(path.join(publicDir, page))) throw new Error(`Page de publication absente : ${page}`);
  const files = new Set([
    ...collectFiles(root, "public", publicExtensions),
    ...collectFiles(root, "lib", [".js"]),
    ...collectFiles(root, "lib/assets", fontExtensions),
    ...collectFiles(root, "netlify/functions", [".js"]),
    "scripts/build-cloud.js", "scripts/build-release.js", "netlify.toml", "package-lock.json",
  ]);
  for (const entry of ["server.js", "package.json"]) if (fs.existsSync(path.join(root, entry))) files.add(entry);
  const hash = createHash("sha256");
  const html = new Map();
  for (const relative of [...files].sort()) {
    let content = fs.readFileSync(path.join(root, relative));
    if (relative.startsWith("public/") && relative.endsWith(".html")) {
      const page = relative.slice("public/".length);
      const prepared = prepareHtml(content.toString("utf8"), page, publicDir);
      html.set(page, prepared);
      content = Buffer.from(prepared);
    }
    hash.update(`${relative}\0${content.length}\0`).update(content).update("\0");
  }
  const version = hash.digest("hex");
  // Validate and hash every source before changing any published output.
  for (const [page, source] of html) fs.writeFileSync(path.join(publicDir, page), prepareHtml(source, page, publicDir, version));
  fs.writeFileSync(path.join(publicDir, "version.json"), `${JSON.stringify({ version })}\n`);
  return { version };
}

module.exports = { buildRelease };
if (require.main === module) {
  const { version } = buildRelease();
  console.log(`Version de publication : ${version}`);
}
