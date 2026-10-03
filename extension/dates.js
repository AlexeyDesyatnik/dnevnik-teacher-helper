// Даты — строками "ГГГГ-ММ-ДД": их можно сравнивать как строки
// и без сюрпризов хранить в chrome.storage.

const pad = (n) => String(n).padStart(2, "0");

export const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Дневник отдаёт даты как unix-секунды полуночи UTC (строкой).
export function fromUnixUtc(seconds) {
  return new Date(Number(seconds) * 1000).toISOString().slice(0, 10);
}

// Полдень по местному времени: полночь по Москве — это ещё вчера по UTC.
export function toUnixNoon(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.floor(new Date(y, m - 1, d, 12).getTime() / 1000);
}

export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from, to) {
  return Math.round((Date.parse(to) - Date.parse(from)) / 864e5);
}

// Пн = 0 ... Вс = 6
export function weekday(iso) {
  return (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;
}

export function monday(iso) {
  return addDays(iso, -weekday(iso));
}

// "Ср 14.10"
export function dayLabel(iso) {
  const [, m, d] = iso.split("-");
  return `${WEEKDAYS[weekday(iso)]} ${d}.${m}`;
}

// "14.10"
export function shortDate(iso) {
  const [, m, d] = iso.split("-");
  return `${d}.${m}`;
}

// "сегодня", "завтра", "через 3 дн."
export function inDays(n) {
  if (n === 0) return "сегодня";
  if (n === 1) return "завтра";
  return `через ${n} дн.`;
}
