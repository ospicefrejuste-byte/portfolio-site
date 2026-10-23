"use strict";

const { clean, fail } = require("./security");

const EXPENSE_CATEGORIES = ["Aliments et intrants", "Animaux", "Cultures et récoltes", "Matériel", "Transport", "Main-d’œuvre", "Entretien", "Autres"];

function expenseDay(value) {
  if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) throw fail(400, "Choisissez une date de dépense valide.");
  const date = new Date(value + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw fail(400, "Choisissez une date de dépense valide.");
  return value;
}

function localDay(timezone, instant = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const value = type => parts.find(part => part.type === type).value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function expenseFields(body) {
  const description = clean(body.description, "Désignation de l’achat", 160);
  const category = clean(body.category, "Catégorie de dépense", 80);
  if (!EXPENSE_CATEGORIES.includes(category)) throw fail(400, "Catégorie de dépense inconnue.");
  const supplier = clean(body.supplier, "Fournisseur", 160, true);
  const notes = clean(body.notes, "Notes", 2000, true);
  const value = body.amount;
  if (!["number", "string"].includes(typeof value) || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 1000000000000) throw fail(400, "Le montant doit être un entier entre 1 et 1 000 000 000 000 F CFA.");
  const date = expenseDay(body.date);
  const time = body.time;
  if (typeof time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw fail(400, "Choisissez une heure de dépense valide (HH:mm).");
  return { description, category, supplier, amount: Number(value), date, time, notes };
}

function expenseRange(query = {}) {
  if (!query || typeof query !== "object" || Object.keys(query).some(key => !["from", "to"].includes(key))) throw fail(400, "La période accepte uniquement une date de début et une date de fin.");
  const from = query.from === undefined ? null : expenseDay(query.from);
  const to = query.to === undefined ? null : expenseDay(query.to);
  if (from && to && from > to) throw fail(400, "La date de début doit précéder la date de fin.");
  return { from, to };
}

function selectExpenses(expenses, { from = null, to = null } = {}) {
  const selected = expenses.filter(expense => (!from || expense.date >= from) && (!to || expense.date <= to));
  const total = selected.reduce((sum, expense) => sum + BigInt(expense.amount), 0n).toString();
  return { expenses: selected, total, count: selected.length, from, to };
}

const expenseValue = row => ({ id: row.id, description: row.description, category: row.category, supplier: row.supplier, amount: Number(row.amount), date: row.date, time: row.time, timezone: row.timezone, notes: row.notes, createdAt: row.created_at, createdBy: row.created_by, reference: row.reference });

module.exports = { EXPENSE_CATEGORIES, expenseDay, localDay, expenseFields, expenseRange, selectExpenses, expenseValue };
