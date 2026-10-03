// Сводка: важные уроки впереди и ученики, которым не хватает оценок.
//
// Журналы (класс, подгруппа, текущий период) берём из расписания учителя,
// по каждому — journals/subjectJournal: там все уроки периода, включая
// будущие, оценки (по id работы) и отметки об отсутствии (по id урока).

import { IMPORTANT, LEAD_DAYS, MIN_MARKS, WEEKS_AHEAD } from "./settings.js";
import { getSchedule, getSubjectJournal, getTeacher } from "./api.js";
import { addDays, daysBetween, fromUnixUtc, monday, today } from "./dates.js";

// Учитываются только оценки по пятибалльной шкале («НЗ» и т.п. — нет).
const FIVE_POINT = /^[1-5][+-]?$/;

const absUrl = (url) => (url ? new URL(url, "https://dnevnik.ru").href : null);

function journalFromLesson(lesson) {
  const url = new URL(lesson.urls.journalUrl, "https://dnevnik.ru");
  const [, groupId, subjectId] = url.pathname.match(/\/group\/(\d+)\/subject\/(\d+)/);
  const subGroupId = url.searchParams.get("subGroupId"); // нет у класса без подгрупп
  const subgroup = lesson.group.subgroup;
  return {
    key: `${groupId}|${subjectId}|${subGroupId || ""}`,
    name: lesson.group.groupName + (subgroup ? `, ${subgroup.subgroupName}` : ""),
    groupId,
    subjectId,
    subGroupId,
    periodId: url.searchParams.get("periodId"),
    url: url.href,
  };
}

// Сортировка «7А» < «10А»: сначала по номеру класса.
function compareJournals(a, b) {
  const [, na = "999", ra = a.name] = a.name.match(/^(\d+)(.*)$/) || [];
  const [, nb = "999", rb = b.name] = b.name.match(/^(\d+)(.*)$/) || [];
  return Number(na) - Number(nb) || ra.localeCompare(rb, "ru");
}

// Журналы из расписания. periodId берём из урока, ближайшего к сегодня:
// на неделе смены периода у уроков могут быть ссылки на разные периоды.
function collectJournals(days, now) {
  const best = new Map();
  for (const day of days) {
    const date = fromUnixUtc(day.date);
    for (const lesson of day.lessons || []) {
      const j = journalFromLesson(lesson);
      const dist = Math.abs(daysBetween(now, date));
      if (!best.has(j.key) || dist < best.get(j.key).dist) best.set(j.key, { dist, j });
    }
  }
  return [...best.values()].map((x) => x.j).sort(compareJournals);
}

// Расписание на WEEKS_AHEAD недель с текущей. Если там одни каникулы,
// журналы ищем в соседних неделях (их уроки не показываем).
async function loadSchedule(schoolId, personId, now) {
  const first = monday(now);
  const week = (offset) => {
    const start = addDays(first, 7 * offset);
    return getSchedule(schoolId, personId, start, addDays(start, 6));
  };
  const offsets = Array.from({ length: WEEKS_AHEAD }, (_, i) => i);
  const days = (await Promise.all(offsets.map(week))).flat();
  const extra = [];
  const hasLessons = (list) => list.some((d) => d.lessons?.length);
  for (const offset of [-1, -2, -3, WEEKS_AHEAD]) {
    if (hasLessons(days) || hasLessons(extra)) break;
    extra.push(...(await week(offset)));
  }
  return { days, extra };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const isControl = (work) => work.isAnyControlOrTestWork || IMPORTANT.test(work.workName || "");

function countMarks(marks) {
  return Object.values(marks || {}).flat().filter((m) => FIVE_POINT.test(m.value)).length;
}

function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
}

// Ученики, которым не хватает оценок до MIN_MARKS к концу периода.
//   red    — не хватает не меньше, чем осталось уроков: оценка нужна на каждом;
//   yellow — оценок меньше, чем у большинства в группе, или пропущена
//            контрольная/самостоятельная и оценки за неё нет;
//   null   — просто пока мало оценок, как у всех (видно в сумме по журналу).
function analyzeJournal(journal, data, now) {
  const lessons = (data.lessons || []).map((l) => ({ ...l, date: fromUnixUtc(l.resultDate) }));
  const remaining = lessons.filter((l) => l.date >= now).length; // сегодняшний — ещё впереди
  const periodEnd = lessons.reduce((max, l) => (l.date > max ? l.date : max), "");

  const controlWorks = lessons
    .filter((l) => l.date < now)
    .flatMap((lesson) => (lesson.works || []).filter(isControl).map((work) => ({ lesson, work })));

  const persons = (data.persons || []).filter((p) => !p.excluded);
  const counted = persons.map((p) => ({ p, marks: countMarks(p.marks) }));
  const typical = median(counted.map((x) => x.marks));

  const students = [];
  for (const { p, marks } of counted) {
    const need = MIN_MARKS - marks;
    if (need <= 0) continue;
    const debts = controlWorks
      .filter(({ work }) => countMarks({ [work.id]: p.marks?.[work.id] || [] }) === 0)
      .map(({ lesson, work }) => ({
        date: lesson.date,
        work: work.workName,
        absence: p.lessonLogEntries?.[lesson.id] || null,
      }));
    const status = need >= remaining ? "red" : marks < typical || debts.length ? "yellow" : null;
    students.push({ name: `${p.lastName || ""} ${p.firstName || ""}`.trim(), marks, need, status, debts });
  }
  const rank = { red: 0, yellow: 1, null: 2 };
  students.sort((a, b) => rank[a.status] - rank[b.status]
    || a.marks - b.marks || a.name.localeCompare(b.name, "ru"));

  return {
    name: journal.name,
    url: journal.url,
    size: persons.length,
    remaining,
    periodEnd,
    typical,
    needTotal: students.reduce((n, s) => n + s.need, 0),
    students,
    controlLessons: new Set(lessons.filter((l) => (l.works || []).some(isControl)).map((l) => l.id)),
  };
}

function buildSummary(now, days, journals, journalData) {
  const byKey = new Map(journals.map((j, i) => [j.key, analyzeJournal(j, journalData[i], now)]));

  const weeks = new Map();
  const important = [];
  for (const day of days) {
    const date = fromUnixUtc(day.date);
    const lessons = (day.lessons || []).map((raw) => {
      const j = journalFromLesson(raw);
      const title = (raw.lessonTitle || "").trim();
      const lesson = {
        id: raw.id,
        date,
        number: raw.lessonStatus?.resultLessonNumber || raw.planLessonNumber || null,
        title,
        journal: j.name,
        journalUrl: j.url,
        lessonUrl: absUrl(raw.urls?.lessonUrl),
        important: IMPORTANT.test(title) || !!byKey.get(j.key)?.controlLessons.has(raw.id),
      };
      if (lesson.important && date >= now) {
        important.push({ ...lesson, daysLeft: daysBetween(now, date) });
      }
      return lesson;
    }).sort((a, b) => (a.number || 0) - (b.number || 0));

    const start = monday(date);
    if (!weeks.has(start)) weeks.set(start, { start, days: [] });
    weeks.get(start).days.push({ date, holiday: !!day.isHoliday, lessons });
  }
  important.sort((a, b) => a.date.localeCompare(b.date) || (a.number || 0) - (b.number || 0));

  const journalReports = [...byKey.values()].map(({ controlLessons, ...rest }) => rest);
  const count = (status) => journalReports
    .reduce((n, j) => n + j.students.filter((s) => s.status === status).length, 0);
  return {
    updatedAt: Date.now(),
    today: now,
    weeks: [...weeks.values()].sort((a, b) => a.start.localeCompare(b.start)),
    important,
    journals: journalReports,
    counts: {
      soon: important.filter((l) => l.daysLeft <= LEAD_DAYS).length,
      red: count("red"),
      yellow: count("yellow"),
    },
  };
}

// onProgress(сделано, всего) — для индикатора загрузки журналов.
export async function loadSummary(onProgress = () => {}) {
  const now = today();
  const { personId, schoolId } = await getTeacher();
  const { days, extra } = await loadSchedule(schoolId, personId, now);
  const journals = collectJournals([...days, ...extra], now);
  if (!journals.length) {
    throw new Error("В расписании на ±3 недели нет уроков — список журналов взять неоткуда.");
  }
  let done = 0;
  onProgress(done, journals.length);
  const data = await mapLimit(journals, 4, async (j) => {
    const d = await getSubjectJournal(schoolId, j);
    onProgress(++done, journals.length);
    return d;
  });
  return buildSummary(now, days, journals, data);
}
