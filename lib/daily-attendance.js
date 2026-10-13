"use strict";
const crypto = require("node:crypto");

const fail = (status, message) => Object.assign(new Error(message), { status });
const activeStudent = (student) => ["Inscrit", "Préinscription"].includes(student.registrationStatus || "Inscrit");

function selection(data, school, input) {
  const day = input.date;
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day)
    throw fail(400, "Choisissez une date valide.");
  const centre = input.centre, level = input.class;
  if (typeof centre !== "string" || !centre.trim() || centre.length > 100 || typeof level !== "string" || !level.trim() || level.length > 80)
    throw fail(400, "Choisissez l’école et la classe.");
  const knownCentre = school.centres.includes(centre) || data.students.some((student) => student.centre === centre) || (data.dailyAttendance || []).some((record) => record.centre === centre);
  const knownClass = school.levels.some(([name]) => name === level) || data.students.some((student) => student.class === level) || (data.dailyAttendance || []).some((record) => record.class === level);
  if (!knownCentre || !knownClass) throw fail(400, "École ou classe inconnue.");
  return { date: day, centre, class: level };
}

function dailyAttendanceRoster(data, school, input) {
  const selected = selection(data, school, input);
  const records = new Map((data.dailyAttendance || []).filter((record) => record.date === selected.date).map((record) => [record.student, record]));
  const students = [];
  for (const student of data.students) {
    const record = records.get(student.id);
    // The first mark fixes the class and school for this day, even if the pupil
    // later changes class. Clearing a mark keeps that historical assignment.
    const belongs = record
      ? record.class === selected.class && record.centre === selected.centre
      : student.class === selected.class && student.centre === selected.centre && activeStudent(student);
    if (!belongs) continue;
    students.push({
      id: student.id,
      name: student.name,
      class: record?.class || student.class,
      centre: record?.centre || student.centre,
      registrationStatus: student.registrationStatus || "Inscrit",
      status: record?.status ?? null,
      revision: record?.revision || 0,
    });
  }
  students.sort((first, second) => first.name.localeCompare(second.name, "fr", { sensitivity: "base" }) || first.id.localeCompare(second.id));
  const present = students.filter((student) => student.status === "Présent").length;
  const absent = students.filter((student) => student.status === "Absent").length;
  return { ...selected, students, totals: { present, absent, unmarked: students.length - present - absent } };
}

function prepareDailyAttendance(data, school, input, actor) {
  const roster = dailyAttendanceRoster(data, school, input);
  const entries = input.entries;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 200 || new Set(entries.map((entry) => entry?.student)).size !== entries.length)
    throw fail(400, "Sélectionnez entre 1 et 200 élèves distincts.");
  const current = new Map((data.dailyAttendance || []).filter((record) => record.date === roster.date).map((record) => [record.student, record]));
  const pupils = new Set(roster.students.map((student) => student.id));
  const changed = [];
  const now = new Date().toISOString();
  for (const entry of entries) {
    if (!entry || typeof entry.student !== "string" || ![null, "Présent", "Absent"].includes(entry.status) || !Number.isSafeInteger(entry.revision) || entry.revision < 0)
      throw fail(400, "Présence ou version invalide. Actualisez la liste.");
    if (!pupils.has(entry.student)) throw fail(409, "Un élève ne fait plus partie de cette école et de cette classe. Actualisez la liste.");
    const old = current.get(entry.student);
    const revision = old?.revision || 0;
    const sameStatus = (old?.status ?? null) === entry.status;
    if (entry.revision !== revision && !(entry.revision < revision && sameStatus))
      throw fail(409, "Des présences ont été modifiées entre-temps. Actualisez la liste avant de continuer.");
    // An unchanged mark is a safe retry; untouched pupils remain unmarked.
    if (sameStatus) continue;
    const pupil = data.students.find((student) => student.id === entry.student);
    changed.push({
      ...(old || { id: crypto.randomUUID(), student: pupil.id, studentName: pupil.name, date: roster.date, class: roster.class, centre: roster.centre, createdAt: now }),
      status: entry.status,
      revision: revision + 1,
      markedBy: actor.id,
      markedByName: actor.username,
      updatedAt: now,
    });
  }
  return { roster, changed };
}

module.exports = { dailyAttendanceRoster, prepareDailyAttendance };
