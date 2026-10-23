"use strict";

const { clean, fail } = require("./security");
const { localDay } = require("./expenses");
const STAGES = ["chicks", "growing", "adult"];

function goliathDay(value, label = "Date") {
  if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) throw fail(400, label + " invalide.");
  const date = new Date(value + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw fail(400, label + " invalide.");
  return value;
}

function count(value, label = "Effectif") {
  if (!["number", "string"].includes(typeof value) || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 1000000000) throw fail(400, label + " doit être un entier entre 1 et 1 000 000 000.");
  return Number(value);
}

function hatchDate(value, arrivalDate) {
  if (value === undefined || value === null || value === "") return null;
  const date = goliathDay(value, "Date d’éclosion");
  if (date > arrivalDate) throw fail(400, "La date d’éclosion ne peut pas être postérieure à l’arrivée.");
  return date;
}

function batchFields(body) {
  const stage = body.stage ?? "chicks";
  if (!STAGES.includes(stage)) throw fail(400, "Choisissez un stade de croissance valide.");
  const arrivalDate = goliathDay(body.arrivalDate, "Date d’arrivée");
  return { name: clean(body.name, "Nom du lot", 160), arrivalDate, hatchDate: hatchDate(body.hatchDate, arrivalDate), initialCount: count(body.initialCount, "L’effectif de départ"), stage, location: clean(body.location, "Emplacement", 160, true), supplier: clean(body.supplier, "Fournisseur", 160, true), notes: clean(body.notes, "Observations", 2000, true) };
}

function batchEdit(body, row) {
  if (Object.keys(body).some(key => !["version", "name", "stage", "location", "supplier", "hatchDate", "notes"].includes(key))) throw fail(400, "L’arrivée et les effectifs d’un lot restent fixes. Utilisez une mortalité ou une vente pour mettre à jour le nombre de poulets.");
  const stage = body.stage ?? row.stage;
  if (!STAGES.includes(stage)) throw fail(400, "Choisissez un stade de croissance valide.");
  return { name: clean(body.name ?? row.name, "Nom du lot", 160), stage, location: clean(body.location ?? row.location, "Emplacement", 160, true), supplier: clean(body.supplier ?? row.supplier, "Fournisseur", 160, true), hatchDate: hatchDate(body.hatchDate === undefined ? row.hatch_date : body.hatchDate, row.arrival_date), notes: clean(body.notes ?? row.notes, "Observations", 2000, true) };
}

function eventFields(body) {
  const type = body.type;
  if (!["mortality", "sale"].includes(type)) throw fail(400, "Choisissez une mortalité ou une vente.");
  const date = goliathDay(body.date, "Date de l’opération");
  const time = body.time;
  if (typeof time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw fail(400, "Choisissez une heure valide (HH:mm).");
  const reason = clean(body.reason, "Motif ou observations", 1000, true), buyer = clean(body.buyer, "Acheteur", 160, true);
  let totalAmount = null;
  if (body.totalAmount !== undefined && body.totalAmount !== null && body.totalAmount !== "") {
    const value = body.totalAmount;
    if (type !== "sale" || !["number", "string"].includes(typeof value) || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 1000000000000) throw fail(400, "Le montant d’une vente doit être un entier entre 1 et 1 000 000 000 000 F CFA.");
    totalAmount = Number(value);
  }
  if (type === "mortality" && buyer) throw fail(400, "Un acheteur ne se renseigne que pour une vente.");
  return { type, quantity: count(body.quantity, "Le nombre de poulets"), date, time, reason, buyer, totalAmount };
}

function validLocalDate(date, timezone, arrivalDate) {
  if (date > localDay(timezone)) throw fail(400, "Choisissez une date au plus tard aujourd’hui dans le fuseau de la ferme.");
  if (arrivalDate && date < arrivalDate) throw fail(400, "Une mortalité ou une vente ne peut pas précéder l’arrivée du lot.");
}

const eventValue = row => ({ id: row.id, batchId: row.batch_id, type: row.type, quantity: Number(row.quantity), date: row.date, time: row.time, timezone: row.timezone, reason: row.reason, buyer: row.buyer, totalAmount: row.total_amount === null ? null : Number(row.total_amount), remainingAfter: Number(row.remaining_after), createdAt: row.created_at, createdBy: row.created_by, reference: row.reference });

function batchValue(row, events = [], timezone = "Africa/Porto-Novo", instant = new Date()) {
  const today = localDay(timezone, instant);
  const elapsed = date => Math.max(0, Math.round((Date.parse(today + "T00:00:00Z") - Date.parse(date + "T00:00:00Z")) / 86400000));
  const initialCount = Number(row.initial_count), deadCount = Number(row.dead_count), soldCount = Number(row.sold_count);
  const sales = events.filter(event => event.batchId === row.id && event.type === "sale");
  return { id: row.id, itemId: row.item_id, reference: row.reference, name: row.name, arrivalDate: row.arrival_date, hatchDate: row.hatch_date, initialCount, deadCount, soldCount, remainingCount: initialCount - deadCount - soldCount, mortalityRate: Math.round(deadCount * 10000 / initialCount) / 100, ageDays: row.hatch_date ? elapsed(row.hatch_date) : null, daysSinceArrival: elapsed(row.arrival_date), stage: row.stage, location: row.location, supplier: row.supplier, notes: row.notes, version: Number(row.version), createdAt: row.created_at, updatedAt: row.updated_at, createdBy: row.created_by, salesTotal: sales.reduce((sum, event) => sum + (event.totalAmount === null ? 0n : BigInt(event.totalAmount)), 0n).toString(), unpricedSalesCount: sales.filter(event => event.totalAmount === null).length };
}

module.exports = { STAGES, goliathDay, count, hatchDate, batchFields, batchEdit, eventFields, validLocalDate, eventValue, batchValue };
