// Запросы к внутреннему API веб-версии Дневника — только чтение.
// Подробности — docs/dnevnik-api-notes.md.
//
// Cookies отправляет сам браузер. Когда DnevnikAuth_a протухает (минут
// через 20), сайт отправляет на login.dnevnik.ru, а тот по DnevnikAuth_l
// выдаёт новую и возвращает обратно — fetch проходит эти редиректы сам.
// Если истёк и вход, ответ придёт с login.dnevnik.ru или с Госуслуг.

import { toUnixNoon } from "./dates.js";

// Адрес региона: "https://dnevnik.ru/r/<регион>". Узнаём в getTeacher().
let site = null;

export class LoginRequired extends Error {
  constructor() {
    super("Нужно войти в Дневник");
  }
}

async function request(url, accept) {
  let r;
  try {
    r = await fetch(url, { credentials: "include", headers: { Accept: accept } });
  } catch (e) {
    // Редирект на Госуслуги (вход истёк) fetch не пропускает (CORS) —
    // снаружи это выглядит как обрыв связи.
    if (navigator.onLine) throw new LoginRequired();
    throw new Error("Нет связи с интернетом");
  }
  if (new URL(r.url).hostname !== "dnevnik.ru") throw new LoginRequired();
  if (!r.ok) throw new Error(`${url.split("?")[0]} вернул ${r.status}`);
  return r;
}

async function getJson(path, params) {
  const url = `${site}/api/v2/${path}?${new URLSearchParams(params)}`;
  const r = await request(url, "application/json");
  if (!(r.headers.get("Content-Type") || "").includes("json")) throw new LoginRequired();
  return r.json();
}

// ID в Дневнике длиннее 2^53: числом JSON.parse их испортит — берём строкой.
function parseJsonWithLongIds(text) {
  return JSON.parse(text.replace(/([:,\[]\s*)(\d{16,})(?=\s*[,}\]])/g, '$1"$2"'));
}

// JSON-объект, который начинается в text с позиции start (как raw_decode в Python).
function extractObject(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}" && --depth === 0) {
      return parseJsonWithLongIds(text.slice(start, i + 1));
    }
  }
  throw new Error("Не удалось разобрать данные страницы");
}

// Свои personId и ID школы — из JSON-состояния страницы учителя.
// dnevnik.ru/teacher перенаправляет на /r/<регион>/teacher — так узнаём регион.
export async function getTeacher() {
  const r = await request("https://dnevnik.ru/teacher", "text/html");
  const region = new URL(r.url).pathname.match(/^\/r\/[^/]+/);
  if (!region) throw new LoginRequired();
  site = `https://dnevnik.ru${region[0]}`;
  const html = await r.text();
  const m = /window\.__M__INITIAL__STATE__\s*=\s*/.exec(html);
  if (!m) throw new LoginRequired();
  const { user } = extractObject(html, m.index + m[0].length);
  return { personId: String(user.personId), schoolId: String(user.defaultSchool) };
}

// Расписание учителя с start по end включительно: [{ date, holiday, lessons }].
export async function getSchedule(schoolId, personId, start, end) {
  const data = await getJson(`scheduleWidget/school/${schoolId}/person/${personId}`, {
    startDate: toUnixNoon(start),
    finishDate: toUnixNoon(end),
  });
  return data.days || [];
}

export async function getSubjectJournal(schoolId, journal) {
  const params = {
    schoolId,
    groupId: journal.groupId,
    subjectId: journal.subjectId,
    periodId: journal.periodId,
  };
  // Здесь subGroupId с большой G, в lessonPlanning/get — subgroupId.
  if (journal.subGroupId) params.subGroupId = journal.subGroupId;
  return getJson("journals/subjectJournal", params);
}
