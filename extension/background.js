// Фон: раз в REFRESH_MINUTES обновляет сводку, цифру на значке
// (важные уроки в ближайшие LEAD_DAYS дней) и показывает уведомления.
//
// Сводка (в ней ФИО и оценки) лежит только в chrome.storage.session —
// это память браузера, на диск не пишется и очищается при закрытии Chrome.
// В storage.local — только ID уроков, о которых уже напомнили, неделя
// последней сводки и номер новой версии расширения, если она вышла.

import { loadSummary } from "./analysis.js";
import { LoginRequired } from "./api.js";
import { DIGEST_HOUR, LEAD_DAYS, REFRESH_MINUTES, REPO } from "./settings.js";
import { addDays, dayLabel, inDays, shortDate, weekday } from "./dates.js";

const PAGE = "summary.html";

let running = null;

function refresh() {
  running ??= doRefresh().finally(() => (running = null));
  return running;
}

async function doRefresh() {
  const setState = (state) => chrome.storage.session.set({ state });
  await setState({ status: "loading", done: 0, total: 0 });
  try {
    const summary = await loadSummary((done, total) => setState({ status: "loading", done, total }));
    await chrome.storage.session.set({ summary, state: { status: "ok" } });
    await updateBadge(summary);
    await notify(summary);
  } catch (e) {
    const login = e instanceof LoginRequired;
    await setState({ status: login ? "login" : "error", message: e.message });
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#d97706" });
    await chrome.action.setTitle({
      title: login ? "Дневник: нужно войти и обновить сводку" : `Дневник: ошибка — ${e.message}`,
    });
  }
}

async function updateBadge(summary) {
  const { soon, red, yellow } = summary.counts;
  await chrome.action.setBadgeText({ text: soon ? String(soon) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
  await chrome.action.setTitle({
    title: [
      "Сводка Дневника",
      `Важных уроков в ближайшие ${LEAD_DAYS} дн.: ${soon}`,
      `Нужна оценка на каждом уроке: ${red} уч.`,
      `Отстают или пропустили работу: ${yellow} уч.`,
    ].join("\n"),
  });
}

const lessonLine = (l) => `${dayLabel(l.date)} · ${l.journal} — ${l.title}`;

function show(id, title, lines) {
  return chrome.notifications.create(`${id}-${Date.now()}`, {
    type: "basic",
    iconUrl: "icon.png",
    title,
    message: lines.join("\n"),
    priority: 1,
  });
}

async function notify(summary) {
  const stored = await chrome.storage.local.get(["notified", "digestWeek"]);
  const notified = stored.notified || {};
  for (const [id, date] of Object.entries(notified)) {
    if (date < summary.today) delete notified[id];
  }

  // Напоминание: важный урок вошёл в окно LEAD_DAYS дней — один раз на урок.
  const fresh = summary.important.filter((l) => l.daysLeft <= LEAD_DAYS && !notified[l.id]);
  if (fresh.length) {
    const first = fresh[0];
    await show("soon", fresh.length === 1 ? `Подготовиться: ${inDays(first.daysLeft)}` : "Подготовиться",
      fresh.slice(0, 4).map(lessonLine).concat(fresh.length > 4 ? [`и ещё ${fresh.length - 4}`] : []));
    for (const l of fresh) notified[l.id] = l.date;
  }

  // Сводка на неделю: в воскресенье после DIGEST_HOUR или в понедельник.
  const day = weekday(summary.today);
  const hour = new Date().getHours();
  const week = day === 6 && hour >= DIGEST_HOUR ? addDays(summary.today, 1) : day === 0 ? summary.today : null;
  let digestWeek = stored.digestWeek;
  if (week && digestWeek !== week) {
    digestWeek = week;
    const days = summary.weeks.find((w) => w.start === week)?.days || [];
    const holidays = days.length && days.filter((d) => weekday(d.date) < 5).every((d) => d.holiday);
    if (!holidays) {
      const end = addDays(week, 6);
      const items = summary.important.filter((l) => l.date >= week && l.date <= end);
      const { red, yellow } = summary.counts;
      const lines = items.length
        ? items.slice(0, 4).map(lessonLine).concat(items.length > 4 ? [`и ещё ${items.length - 4}`] : [])
        : ["Контрольных, самостоятельных и практических нет."];
      if (red || yellow) lines.push(`Оценки: впритык ${red} уч., отстают ${yellow} уч.`);
      await show("digest", `Неделя с ${shortDate(week)}`, lines);
    }
  }

  await chrome.storage.local.set({ notified, digestWeek });
}

async function openPage() {
  const url = chrome.runtime.getURL(PAGE);
  const [ctx] = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] });
  if (ctx) {
    await chrome.tabs.update(ctx.tabId, { active: true });
    await chrome.windows.update(ctx.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

// "2.10" новее "2.9": сравниваем номера версий по частям.
function isNewer(version, current) {
  const a = version.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

// Новая версия — последний релиз в публичном репозитории на GitHub.
// Уходит только запрос номера версии, никаких данных.
async function checkUpdate() {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!r.ok) return;
    const release = await r.json();
    const version = String(release.tag_name || "").replace(/^v/, "");
    const current = chrome.runtime.getManifest().version;
    const update = version && isNewer(version, current) ? { version, url: release.html_url } : null;
    await chrome.storage.local.set({ update });
  } catch {
    // Нет связи с GitHub — проверим завтра.
  }
}

async function ensureAlarms() {
  if (!(await chrome.alarms.get("refresh"))) {
    await chrome.alarms.create("refresh", { periodInMinutes: REFRESH_MINUTES });
  }
  if (!(await chrome.alarms.get("update"))) {
    await chrome.alarms.create("update", { periodInMinutes: 24 * 60 });
  }
}

function start() {
  ensureAlarms().then(refresh);
  checkUpdate();
}

chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "refresh") refresh();
  if (alarm.name === "update") checkUpdate();
});
chrome.action.onClicked.addListener(openPage);
chrome.notifications.onClicked.addListener((id) => {
  chrome.notifications.clear(id);
  openPage();
});
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "refresh") refresh();
});
