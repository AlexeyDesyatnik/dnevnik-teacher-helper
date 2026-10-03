// Страница «Сводка». Данные готовит background.js (storage.session),
// страница только рисует их и просит обновить, если они устарели.

import { DONATE, LEAD_DAYS, MIN_MARKS, REPO, WEEKS_AHEAD } from "./settings.js";
import { addDays, dayLabel, inDays, shortDate, weekday } from "./dates.js";

const STALE_MINUTES = 15;

// Коды отсутствия из lessonLogEntries (см. docs/dnevnik-api-notes.md).
const ABSENCE = { н: "не был", б: "болел", п: "уваж. причина", о: "опоздал" };

const $ = (id) => document.getElementById(id);

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const link = (text, url, cls) => (url
  ? h("a", { href: url, target: "_blank", rel: "noreferrer", class: cls }, text)
  : h("span", { class: cls }, text));

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} ${one}`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

const lessonsWord = (n) => plural(n, "урок", "урока", "уроков");
const marksWord = (n) => plural(n, "оценка", "оценки", "оценок");

// ——— Важные уроки ———

// Список — по всему расписанию, которое загружено (эта неделя и следующие,
// WEEKS_AHEAD недель). Подсвечены уроки в окне напоминаний: сегодня
// и LEAD_DAYS дней вперёд — о них приходит уведомление, их число на значке.
function renderImportant(summary) {
  const end = addDays(summary.weeks.at(-1)?.start ?? summary.today, 6);
  const soonEnd = addDays(summary.today, LEAD_DAYS);
  const weeks = WEEKS_AHEAD === 1 ? "эту неделю"
    : `эту и ${plural(WEEKS_AHEAD - 1, "следующую неделю", "следующие недели", "следующих недель")}`;
  const section = h("section", null,
    h("h2", null, `Важные уроки до ${shortDate(end)}`),
    h("p", { class: "hint" },
      `Уроки, в теме которых есть «контрольная», «самостоятельная» или «практическая», — по расписанию на ${weeks}. `,
      `Выделены уроки до ${shortDate(soonEnd)} (ближайшие ${LEAD_DAYS} дней): о каждом приходит напоминание, `,
      "их число — на значке расширения."));
  if (!summary.important.length) {
    section.append(h("p", { class: "muted" }, `Таких уроков до ${shortDate(end)} нет.`));
    return section;
  }
  section.append(h("ul", { class: "lessons" }, summary.important.map((l) =>
    h("li", { class: l.daysLeft <= LEAD_DAYS ? "soon" : null },
      h("span", { class: "date" }, dayLabel(l.date)),
      h("span", { class: "when" }, inDays(l.daysLeft)),
      link(l.journal, l.journalUrl, "group"),
      link(l.title, l.lessonUrl, "title"),
      l.number ? h("span", { class: "num" }, `${l.number} урок`) : null))));
  return section;
}

// ——— Оценки ———

function debtText(d) {
  const why = d.absence ? ABSENCE[d.absence] || d.absence : "был, оценки нет";
  return `${d.work} ${shortDate(d.date)} — ${why}`;
}

function redText(need, remaining) {
  if (need > remaining) return `не хватает ${need}, а уроков ${remaining} — нужно больше одной за урок`;
  return "оценка нужна на каждом оставшемся уроке";
}

function renderJournal(j) {
  const lacking = j.students.length;
  const name = link(j.name, j.url, "group");
  if (!lacking) {
    return h("div", { class: "journal ok" }, name,
      h("span", { class: "meta" }, `у всех не меньше ${MIN_MARKS} оценок`));
  }
  const red = j.students.filter((s) => s.status === "red");
  const yellow = j.students.filter((s) => s.status === "yellow");
  const rest = j.students.filter((s) => !s.status);
  const perLesson = j.remaining ? Math.ceil(j.needTotal / j.remaining) : j.needTotal;
  const left = j.remaining
    ? `осталось ${lessonsWord(j.remaining)} до ${shortDate(j.periodEnd)}`
    : "уроков в периоде не осталось";
  const meta = `${left} · не хватает ${marksWord(j.needTotal)} у ${lacking} из ${j.size}`
    + (j.remaining ? ` — ≈${perLesson} за урок` : "");

  const details = h("details", { class: "journal", open: yellow.length > 0 || (red.length > 0 && red.length < j.size) },
    h("summary", null,
      h("strong", null, j.name),
      h("span", { class: "meta" }, meta),
      red.length ? h("span", { class: "pill red", title: "оценка нужна на каждом оставшемся уроке" }, red.length) : null,
      yellow.length ? h("span", { class: "pill yellow", title: "отстаёт от группы или пропустил работу" }, yellow.length) : null));

  if (red.length && red.length === j.size) {
    details.append(h("p", { class: "note" },
      `Всем ученикам не хватает не меньше оценок, чем осталось уроков (${j.remaining}).`));
  }
  const flagged = [...red, ...yellow];
  if (flagged.length) {
    details.append(h("ul", { class: "students" }, flagged.map((s) =>
      h("li", null,
        h("span", { class: `dot ${s.status}` }),
        h("span", { class: "name" }, s.name),
        h("span", { class: "count" }, `${s.marks} из ${MIN_MARKS}`),
        h("span", { class: "debts" }, [
          s.status === "red" ? redText(s.need, j.remaining) : null,
          ...s.debts.map(debtText),
        ].filter(Boolean).join("; "))))));
  }
  if (rest.length) {
    details.append(h("p", { class: "rest" },
      h("span", { class: "muted" }, "Пока мало, как у большинства: "),
      rest.map((s) => `${s.name} — ${s.marks}`).join(", ")));
  }
  details.append(h("p", null, link("Открыть журнал →", j.url)));
  return details;
}

// Сворачиваемый блок; открыт он или нет — запоминается (localStorage).
function block(id, openByDefault, title, ...body) {
  const key = `open:${id}`;
  let open = openByDefault;
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null) open = saved === "1";
  } catch {}
  const details = h("details", { class: "block", open }, h("summary", null, title), ...body);
  details.addEventListener("toggle", () => {
    try {
      localStorage.setItem(key, details.open ? "1" : "0");
    } catch {}
  });
  return details;
}

function renderMarks(summary) {
  const { red, yellow } = summary.counts;
  return block("marks", false,
    [h("h2", null, `Оценки к концу периода — норма ${MIN_MARKS}`),
      red ? h("span", { class: "pill red", title: "оценка нужна на каждом оставшемся уроке" }, red) : null,
      yellow ? h("span", { class: "pill yellow", title: "отстаёт от группы или пропустил работу" }, yellow) : null],
    h("p", { class: "hint" },
      h("span", { class: "dot red" }), " не хватает столько же оценок, сколько осталось уроков, или больше; ",
      h("span", { class: "dot yellow" }), " оценок меньше, чем у большинства в группе, или пропущена ",
      "контрольная/самостоятельная без оценки. Считаются только оценки 1–5."),
    summary.journals.map(renderJournal));
}

// ——— Расписание ———
//
// Таблицу копируют в ИИ для подготовки к урокам, поэтому здесь нет ссылок,
// а в выделение попадает только текст «Пн 28.09 / 2 урок — 8Б, 1 п/г: тема».
// Пометки «сегодня» и кнопки — user-select: none, в копию не попадают.

const isWorkday = (d) => weekday(d.date) < 5;
const isHolidayWeek = (week) => {
  const workdays = week.days.filter(isWorkday);
  return workdays.length > 0 && workdays.every((d) => d.holiday && !d.lessons.length);
};
const shownDays = (week) => week.days.filter((d) => d.lessons.length || (d.holiday && isWorkday(d)));
const lessonText = (l) => ({
  num: `${l.number ?? "?"} урок`,
  group: `${l.journal}:`,
  title: l.title || "(тема не заполнена)",
});

// Тот же текст, что и при выделении мышью, — для кнопки «Скопировать».
function dayText(day) {
  const lessons = day.lessons.map((l) => {
    const t = lessonText(l);
    return `${t.num} — ${t.group} ${t.title}`;
  });
  return [dayLabel(day.date), ...(lessons.length ? lessons : ["каникулы"])].join("\n");
}

function weekText(week) {
  const title = `Неделя с ${shortDate(week.start)}`;
  if (isHolidayWeek(week)) return `${title}\nКаникулы.`;
  return [title, ...shownDays(week).map(dayText)].join("\n\n");
}

function copyButton(getText) {
  const button = h("button", { type: "button", class: "copy" }, "Скопировать");
  button.addEventListener("click", async (e) => {
    e.preventDefault(); // кнопка внутри <summary> не должна сворачивать блок
    await navigator.clipboard.writeText(getText());
    button.textContent = "Скопировано";
    setTimeout(() => (button.textContent = "Скопировать"), 1500);
  });
  return button;
}

function renderSchedule(summary) {
  return block("schedule", false,
    [h("h2", null, "Все уроки по дням"),
      copyButton(() => summary.weeks.map(weekText).join("\n\n"))],
    summary.weeks.map((week) => h("div", { class: "week" },
      h("h3", null, `Неделя с ${shortDate(week.start)}`, copyButton(() => weekText(week))),
      isHolidayWeek(week)
        ? h("p", null, "Каникулы.")
        : shownDays(week).map((d) =>
          h("div", { class: d.date === summary.today ? "day today" : "day" },
            h("div", { class: "date" }, dayLabel(d.date),
              d.date === summary.today ? h("span", { class: "nocopy" }, " · сегодня") : null,
              d.lessons.length ? copyButton(() => dayText(d)) : null),
            d.lessons.length
              ? h("ul", null, d.lessons.map((l) => {
                const t = lessonText(l);
                return h("li", { class: l.important ? "important" : null },
                  h("span", { class: "num" }, t.num), " — ",
                  h("span", { class: "group" }, t.group), " ",
                  h("span", { class: l.title ? "title" : "title muted" }, t.title));
              }))
              : h("p", null, "каникулы"))))));
}

// ——— Состояние ———

function renderContent(summary) {
  if (!summary) return;
  $("content").replaceChildren(renderImportant(summary), renderMarks(summary), renderSchedule(summary));
}

function renderStatus(summary, state) {
  const loading = state?.status === "loading";
  $("refresh").disabled = loading;
  if (loading) {
    $("updated").textContent = state.total ? `Обновляю… ${state.done} из ${state.total}` : "Обновляю…";
  } else if (summary) {
    const d = new Date(summary.updatedAt);
    const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    const date = d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
    $("updated").textContent = `Обновлено ${new Date().toDateString() === d.toDateString() ? time : `${date} ${time}`}`;
  } else {
    $("updated").textContent = "";
  }

  const banner = $("banner");
  banner.hidden = !(state?.status === "login" || state?.status === "error");
  if (state?.status === "login") {
    banner.className = "warn";
    banner.replaceChildren("Нужно войти в Дневник. ",
      h("a", { href: "https://dnevnik.ru/teacher", target: "_blank" }, "Открыть Дневник"),
      ", войти через Госуслуги и нажать «Обновить».");
  } else if (state?.status === "error") {
    banner.className = "error";
    banner.textContent = `Не удалось обновить: ${state.message}`;
  }
  if (!summary && !loading && !banner.hidden) $("content").replaceChildren();
}

function renderUpdate(update) {
  const el = $("update");
  el.hidden = !update;
  if (!update) return;
  el.replaceChildren(`Вышла новая версия расширения — ${update.version}. `,
    link("Скачать и посмотреть, что нового", update.url), ".");
}

function renderFooter() {
  const manifest = chrome.runtime.getManifest();
  const parts = [
    `Версия ${manifest.version}`,
    link("О данных и конфиденциальности", `https://github.com/${REPO}/blob/main/PRIVACY.md`),
  ];
  const donate = DONATE.filter((d) => d.url);
  if (donate.length) {
    parts.push(h("span", null, "Поддержать автора: ",
      donate.map((d, i) => [i ? ", " : "", h("a", {
        href: d.url, target: "_blank", rel: "noreferrer", title: d.title, class: "donate",
      }, d.label)])));
  }
  // Копирование cookies есть только в сборке автора (для Python-скриптов).
  if (manifest.permissions?.includes("cookies")) {
    parts.push(h("a", { href: "popup.html", target: "_blank" }, "Cookies для Python-скриптов"));
  }
  $("links").replaceChildren(...parts.flatMap((p, i) => (i ? [" · ", p] : [p])));
}

async function init() {
  renderFooter();
  chrome.storage.local.get("update").then(({ update }) => renderUpdate(update));
  const { summary, state } = await chrome.storage.session.get(["summary", "state"]);
  renderContent(summary);
  renderStatus(summary, state);
  if (!summary || Date.now() - summary.updatedAt > STALE_MINUTES * 60e3) {
    chrome.runtime.sendMessage({ type: "refresh" });
  }
}

$("refresh").addEventListener("click", () => chrome.runtime.sendMessage({ type: "refresh" }));

chrome.storage.session.onChanged.addListener(async (changes) => {
  const { summary, state } = await chrome.storage.session.get(["summary", "state"]);
  if (changes.summary) renderContent(summary);
  renderStatus(summary, state);
});

init();
