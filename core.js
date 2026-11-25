'use strict';
/* Общие помощники: DOM, даты, склонения, тема, уведомления. */

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const MARK_CODES = [
  ['П', 'Присутствовал'],
  ['УП', 'Уважительный пропуск'],
  ['НП', 'Неуважительный пропуск'],
  ['оп', 'Опоздал'],
  ['вк', 'Камера выключена'],
  ['пвк', 'Выключал камеру'],
  ['У', 'Ушёл с урока'],
  ['тел', 'С телефона'],
  ['молчит', 'Не отвечал'],
];

const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** Поиск без учёта регистра и разницы «ё/е». */
const normalizeText = value => String(value ?? '').toLocaleLowerCase('ru').replace(/ё/g, 'е').trim();

/** Номер столбца Excel → буквы: 1 → A, 27 → AA. */
function column(n) {
  let value = '';
  while (n) { n--; value = String.fromCharCode(65 + n % 26) + value; n = Math.floor(n / 26); }
  return value;
}

/* ---------- Даты ---------- */
const isoDate = d => new Date(d + 'T12:00:00Z');
function formatDate(value, options = { day: 'numeric', month: 'long' }) {
  return isoDate(value).toLocaleDateString('ru-RU', { ...options, timeZone: 'UTC' });
}
function localToday() {
  const date = new Date();
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
/** Понедельник календарной недели для даты ISO. */
function weekStart(iso) {
  const d = isoDate(iso), shift = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - shift);
  return d.toISOString().slice(0, 10);
}
/** Разбивает отсортированные даты на календарные недели: [{start, indexes:[...]}]. */
function calendarWeeks(dates) {
  const weeks = [];
  dates.forEach((date, index) => {
    const start = weekStart(date);
    if (!weeks.length || weeks.at(-1).start !== start) weeks.push({ start, indexes: [] });
    weeks.at(-1).indexes.push(index);
  });
  return weeks;
}
/** Индекс даты урока, ближайшей к target: сначала та же или следующая, иначе последняя прошедшая. */
function nearestDateIndex(dates, target) {
  const exact = dates.indexOf(target);
  if (exact >= 0) return exact;
  const next = dates.findIndex(date => date > target);
  if (next >= 0) {
    const prev = next - 1;
    // Если ближайшая будущая дата в пределах той же недели — берём её, иначе последнюю прошедшую.
    if (prev < 0 || weekStart(dates[next]) === weekStart(target)) return next;
    return prev;
  }
  return dates.length - 1;
}

/* ---------- Склонения ---------- */
function plural(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return few;
  return many;
}
const studentsWord = n => n + ' ' + plural(n, 'ученик', 'ученика', 'учеников');
const percent = (value, digits = 1) => Number.isFinite(value)
  ? value.toLocaleString('ru-RU', { maximumFractionDigits: digits, minimumFractionDigits: 0 }) + '%'
  : '—';

/* ---------- Отметки ---------- */
/** Разбивает отметку («оп; вк», «У-50 мин») на коды. */
function markTokens(value) {
  return String(value ?? '').split(/[;,\s]+/).map(t => t.trim()).filter(Boolean);
}
function markKind(value) {
  if (value === 'П') return 'present';
  if (value === 'УП') return 'excused';
  if (value === 'НП') return 'absent';
  if (value) return 'note';
  return '';
}
const isAbsence = value => value === 'УП' || value === 'НП';

/* ---------- Тема ---------- */
const THEME_KEY = 'masters-journal-theme';
function currentTheme() {
  return document.documentElement.dataset.theme || 'dark';
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch {}
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'dark' ? '#0f1012' : '#f6f7f9';
  $$('[data-theme-toggle]').forEach(button => {
    button.setAttribute('aria-label', theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему');
    button.setAttribute('aria-pressed', String(theme === 'light'));
  });
}
(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch {}
  const preferred = window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  applyTheme(saved || preferred);
})();
document.addEventListener('click', event => {
  if (event.target.closest('[data-theme-toggle]')) applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
});

/* ---------- Уведомления ---------- */
let toastTimer;
/** Короткое уведомление. action — {label, run} для кнопки «Отменить» и т. п. */
function toast(message, action) {
  const box = $('#toast');
  box.replaceChildren();
  const text = document.createElement('span');
  text.textContent = message;
  box.append(text);
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.onclick = () => { box.classList.remove('visible'); action.run(); };
    box.append(button);
  }
  box.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('visible'), action ? 6000 : 3500);
}

function download(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function initials(name) {
  return personName(name).initials.toUpperCase();
}

/* ---------- Имена учеников: «Фамилия Имя», сортировка по фамилии ---------- */
const FIRST_NAMES = new Set(('александр алексей анатолий андрей антон аркадий арсений артем артемий артур богдан борис вадим валентин валерий василий виктор виталий владимир владислав всеволод вячеслав гавриил георгий глеб григорий давид даниил данил данила демид денис дмитрий добрыня евгений егор елисей захар иван игнат игорь илья ильяс камиль карим кирилл константин лев леон леонид макар максим марат марк матвей мирон мирослав михаил назар никита никола николай олег павел петр платон прохор радмир ратмир роберт родион роман руслан рустам савва савелий самуил святослав семен сергей станислав степан тагир тамерлан тимофей тимур тихон федор филипп эмиль эмир юрий ян ярослав '
  + 'агата аглая ада адель алевтина александра алена алиса алла алсу альбина алина амина амелия анастасия ангелина анна антонина арина ариана асель асия валентина валерия варвара василиса вера вероника виктория виолетта галина дарина дарья диана дина ева евгения екатерина елена елизавета есения жанна зарина злата зоя ирина камила камилла карина кира клавдия кристина ксения лариса лейла лиана лидия лилия любовь людмила майя маргарита марианна марина мария марьям мелания милана милена мирослава надежда нелли ника николь нина оксана олеся ольга полина рената регина роза сабина серафима снежана софия софья стефания таисия тамара татьяна ульяна устинья эвелина элина элеонора эльвира юлиана юлия яна ярослава').split(' '));
const PATRONYMIC = /(вич|вна|ична|инична|оглы|кызы)$/i;
const SURNAME_END = /(ов|ова|ев|ева|ёв|ёва|ин|ина|ын|ына|ский|ская|цкий|цкая|ко|ук|юк|чук|ян|янц|дзе|швили|их|ых|ман|берг)$/i;
const nameCache = new Map();
function personName(raw) {
  const text = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (nameCache.has(text)) return nameCache.get(text);
  const parts = text.split(' ');
  let last = parts[0] || '', rest = parts.slice(1);
  if (parts.length >= 2) {
    const low = w => w.toLocaleLowerCase('ru').replace(/ё/g, 'е');
    const firstIsName = FIRST_NAMES.has(low(parts[0])), secondIsName = FIRST_NAMES.has(low(parts[1]));
    const surnameFirst = parts.length === 3 && PATRONYMIC.test(parts[2]);
    // «Имя Фамилия» → «Фамилия Имя»; «Фамилия Имя (Отчество)» оставляем как есть.
    const swap = !surnameFirst && ((firstIsName && !secondIsName)
      || (!firstIsName && !secondIsName && parts.length === 2 && SURNAME_END.test(parts[1]) && !SURNAME_END.test(parts[0])));
    if (swap) { last = parts.at(-1); rest = parts.slice(0, -1); }
  }
  const display = [last, ...rest].join(' ');
  const result = { display, key: normalizeText(display), initials: (last[0] || '') + (rest[0]?.[0] || '') };
  nameCache.set(text, result);
  return result;
}
const displayName = raw => personName(raw).display;
const byName = (a, b) => personName(a).key.localeCompare(personName(b).key, 'ru');
