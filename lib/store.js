"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const fs = require("node:fs");
const path = require("node:path");
const { postgresConfiguration, normalizeCaCertificate } = require("./database-config");

function createSqlite({ dataDir }) {
  const { DatabaseSync } = require("node:sqlite");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const raw = new DatabaseSync(path.join(dataDir, "adeoye.sqlite"));
  raw.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const context = new AsyncLocalStorage();
  let tail = Promise.resolve();
  return {
    dialect: "sqlite",
    async exec(sql) { raw.exec(sql); },
    prepare(sql) { return { async get(...values) { return raw.prepare(sql).get(...values); }, async all(...values) { return raw.prepare(sql).all(...values); }, async run(...values) { return raw.prepare(sql).run(...values); } }; },
    async transaction(fn) {
      if (context.getStore()) return fn();
      const previous = tail;
      let release;
      tail = new Promise(resolve => { release = resolve; });
      await previous;
      try {
        raw.exec("BEGIN IMMEDIATE");
        try { const result = await context.run(true, fn); raw.exec("COMMIT"); return result; }
        catch (error) { raw.exec("ROLLBACK"); throw error; }
      } finally { release(); }
    },
    async close() { await tail; raw.close(); },
  };
}
function createPostgres(options = {}) {
  const { Pool } = require("pg");
  const context = new AsyncLocalStorage();
  let pool = options.pool;
  if (!pool) {
    pool = new Pool(postgresConfiguration({ connectionString: options.connectionString || process.env.ADEOYE_DATABASE_URL, password: process.env.ADEOYE_DATABASE_PASSWORD, ca: options.ca || process.env.ADEOYE_DATABASE_CA_CERT }));
    pool.on("error", error => console.error("Connexion ADEOYE interrompue :", error.code || error.name));
  }
  const query = (sql, values = []) => { let index = 0; return (context.getStore() || pool).query(sql.replace(/\?/g, () => "$" + (++index)), values); };
  const normalize = row => {
    if (!row) return row;
    for (const key of ["n", "expires", "hits", "reset_at", "quantity_milli", "min_quantity_milli", "unit_value", "version", "balance_milli"])
      if (typeof row[key] === "string") row[key] = Number(row[key]);
    return row;
  };
  return {
    dialect: "postgres",
    async exec(sql) { await query(sql); },
    prepare(sql) { return { async get(...values) { return normalize((await query(sql, values)).rows[0]); }, async all(...values) { return (await query(sql, values)).rows.map(normalize); }, async run(...values) { const result = await query(sql, values); return { changes: result.rowCount }; } }; },
    async transaction(fn) {
      if (context.getStore()) return fn();
      const client = await pool.connect();
      try { await client.query("BEGIN"); await client.query("SELECT pg_advisory_xact_lock(672901349)"); const result = await context.run(client, fn); await client.query("COMMIT"); return result; }
      catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    },
    async close() { await pool.end(); },
  };
}
module.exports = { createSqlite, createPostgres, normalizeCaCertificate };
