"use strict";

sections.calendar = ["▦", "Calendrier"];

// Keep school dates as local calendar dates, including around daylight saving time.
function calendarISO(value) {
  return `${String(value.getFullYear()).padStart(4, "0")}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
function calendarParseISO(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
  const result = new Date(`${value}T12:00:00`);
  return Number.isFinite(result.getTime()) && calendarISO(result) === value ? result : null;
}
function calendarMonday(value = new Date()) {
  const result = typeof value === "string" ? calendarParseISO(value) : new Date(value.getTime());
  if (!result || !Number.isFinite(result.getTime())) return null;
  result.setHours(12, 0, 0, 0);
  result.setDate(result.getDate() - (result.getDay() + 6) % 7);
  return calendarISO(result);
}
function calendarShiftISO(value, days) {
  const result = calendarParseISO(value);
  if (!result) return null;
  result.setDate(result.getDate() + days);
  return calendarISO(result);
}
function calendarEndTime(time, duration) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(time));
  if (!match) return "";
  const total = Number(match[1]) * 60 + Number(match[2]) + Number(duration || 0);
  if (!Number.isFinite(total)) return "";
  const hour = Math.floor(total / 60) % 24, minute = total % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}${total >= 1440 ? " (+1 j)" : ""}`;
}

let calendarWeek = calendarMonday();
let calendarTeacher = "", calendarCentre = "", calendarSubject = "";

function calendarCourseCentre(record) {
  return record.centre || groupCentre(record.group) || "";
}
function calendarCourses() {
  const end = calendarShiftISO(calendarWeek, 7);
  return visibleCourses().filter((record) =>
    record.date >= calendarWeek && record.date < end &&
    (!calendarTeacher || record.teacher === calendarTeacher) &&
    (!calendarCentre || calendarCourseCentre(record) === calendarCentre) &&
    (!calendarSubject || record.subject === calendarSubject)
  ).sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`) || String(a.id).localeCompare(String(b.id)));
}
function calendarTone(subject) {
  return ({ "Mathématiques": "blue", "Physique-Chimie": "orange", "SVT": "green" })[subject] || "purple";
}
function calendarSelectOptions(values, selected, emptyLabel) {
  return `<option value="">${esc(emptyLabel)}</option>${values.map(([value, label]) => `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(label)}</option>`).join("")}`;
}
function calendarFilters() {
  const available = visibleCourses();
  const teacherIds = [...new Set(available.map((record) => record.teacher).filter(Boolean))];
  const teachers = teacherIds.map((id) => [id, teacher(id)?.name || "Enseignant introuvable"]).sort((a, b) => a[1].localeCompare(b[1], "fr"));
  const centres = [...new Set(available.map(calendarCourseCentre).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
  const subjects = [...new Set(available.map((record) => record.subject).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
  return `<div class="calendar-filters"><label for="calendar-teacher">Enseignant<select id="calendar-teacher">${calendarSelectOptions(teachers, calendarTeacher, "Tous les enseignants")}</select></label><label for="calendar-centre">Centre<select id="calendar-centre">${calendarSelectOptions(centres.map((name) => [name, name]), calendarCentre, "Tous les centres")}</select></label><label for="calendar-subject">Matière<select id="calendar-subject">${calendarSelectOptions(subjects.map((name) => [name, name]), calendarSubject, "Toutes les matières")}</select></label><button id="calendar-reset" class="secondary" type="button">Effacer les filtres</button></div>`;
}
function calendarCourseCard(record) {
  const centre = calendarCourseCentre(record), teacherName = teacher(record.teacher)?.name || "Enseignant non renseigné";
  const body = `<span class="calendar-course-time">${esc(record.time)}${calendarEndTime(record.time, record.duration) ? ` – ${esc(calendarEndTime(record.time, record.duration))}` : ""}</span><strong class="calendar-course-subject">${esc(record.subject)}</strong><span class="calendar-course-group">${esc(record.group)}</span><span class="calendar-course-detail">${esc(teacherName)}</span><span class="calendar-course-detail">${esc(record.room || "Salle non renseignée")}</span><span class="calendar-course-centre">${esc(centre || "Centre non renseigné")}</span>`;
  const tone = calendarTone(record.subject);
  return role === "admin"
    ? `<button type="button" class="calendar-course" data-calendar-course="${esc(record.id)}" data-subject-tone="${tone}" aria-label="Modifier le cours de ${esc(record.subject)}, ${esc(record.group)}, le ${esc(date(record.date))} à ${esc(record.time)}">${body}<span class="calendar-course-edit">Modifier la séance ↗</span></button>`
    : `<article class="calendar-course" data-subject-tone="${tone}">${body}</article>`;
}
function calendarPage() {
  const courses = calendarCourses(), today = calendarISO(new Date());
  const start = calendarParseISO(calendarWeek), end = calendarParseISO(calendarShiftISO(calendarWeek, 6));
  const format = (value, options) => value.toLocaleDateString("fr-FR", options);
  const range = `${format(start, { day: "numeric", month: "long" })} – ${format(end, { day: "numeric", month: "long", year: "numeric" })}`;
  const subjects = [...new Set(courses.map((record) => record.subject))];
  const days = Array.from({ length: 7 }, (_, index) => {
    const iso = calendarShiftISO(calendarWeek, index), day = calendarParseISO(iso);
    const sessions = courses.filter((record) => record.date === iso);
    return `<section class="calendar-day ${iso === today ? "calendar-day-today" : ""}" aria-labelledby="calendar-day-${index}"><div class="calendar-day-heading"><div><span>${esc(format(day, { weekday: "long" }))}</span><h3 id="calendar-day-${index}"><time datetime="${iso}">${esc(format(day, { day: "numeric", month: "short" }))}</time></h3></div>${iso === today ? '<span class="calendar-today-label">Aujourd’hui</span>' : ""}<span class="calendar-day-count">${sessions.length} séance${sessions.length === 1 ? "" : "s"}</span></div><div class="calendar-day-courses">${sessions.length ? sessions.map(calendarCourseCard).join("") : '<p class="calendar-day-empty">Aucune séance</p>'}</div></section>`;
  }).join("");
  return `<div class="calendar-shell"><section class="calendar-intro"><div><span class="calendar-eyebrow">Un planning clair, semaine après semaine</span><h2>Organisez les prochains progrès.</h2><p>Retrouvez les séances, les enseignants et les lieux en un regard.</p></div>${role === "admin" ? '<button id="calendar-add" class="primary" type="button">+ Planifier un cours</button>' : ""}</section><div class="calendar-toolbar"><div class="calendar-week-controls"><button id="calendar-previous" class="secondary" type="button" aria-label="Semaine précédente">←</button><button id="calendar-today" class="secondary" type="button">Aujourd’hui</button><button id="calendar-next" class="secondary" type="button" aria-label="Semaine suivante">→</button></div><h2 class="calendar-range" aria-live="polite">${esc(range)}</h2><label class="calendar-date-label" for="calendar-date">Choisir une date<input id="calendar-date" type="date" value="${calendarWeek}"></label></div>${calendarFilters()}<div class="calendar-summary"><p><strong>${courses.length}</strong> séance${courses.length === 1 ? "" : "s"} cette semaine${calendarTeacher || calendarCentre || calendarSubject ? " avec ces filtres" : ""}</p><div class="calendar-legend" aria-label="Couleurs des matières">${subjects.map((subject) => `<span data-subject-tone="${calendarTone(subject)}"><i aria-hidden="true"></i>${esc(subject)}</span>`).join("")}</div></div>${courses.length ? "" : `<div class="calendar-empty-week" role="status">${calendarTeacher || calendarCentre || calendarSubject ? "Aucune séance ne correspond aux filtres cette semaine. Effacez les filtres ou choisissez une autre semaine." : "Aucune séance planifiée cette semaine. Choisissez une autre semaine" + (role === "admin" ? " ou planifiez votre premier cours." : ".")}</div>`}<div class="calendar-week-container"><div class="calendar-week">${days}</div></div>${role === "admin" ? '<p class="calendar-helper">Cliquez sur une séance pour modifier ses informations. Les groupes et enseignants sont gérés dans Cours & planning.</p>' : '<p class="calendar-helper">Ce calendrier présente les séances auxquelles votre compte a accès.</p>'}</div>`;
}
function bindCalendar() {
  if (page !== "calendar") return;
  document.getElementById("calendar-previous").onclick = () => { calendarWeek = calendarShiftISO(calendarWeek, -7); render(); };
  document.getElementById("calendar-next").onclick = () => { calendarWeek = calendarShiftISO(calendarWeek, 7); render(); };
  document.getElementById("calendar-today").onclick = () => { calendarWeek = calendarMonday(); render(); };
  document.getElementById("calendar-date").onchange = (event) => {
    const week = calendarMonday(event.target.value);
    if (week) { calendarWeek = week; render(); }
  };
  for (const name of ["teacher", "centre", "subject"]) document.getElementById(`calendar-${name}`).onchange = (event) => {
    if (name === "teacher") calendarTeacher = event.target.value;
    else if (name === "centre") calendarCentre = event.target.value;
    else calendarSubject = event.target.value;
    render();
  };
  document.getElementById("calendar-reset").onclick = () => { calendarTeacher = ""; calendarCentre = ""; calendarSubject = ""; render(); };
  if (role === "admin") {
    document.getElementById("calendar-add").onclick = () => openCourseForm();
    document.querySelectorAll("[data-calendar-course]").forEach((button) => { button.onclick = () => openCourseForm(button.dataset.calendarCourse); });
  }
}
