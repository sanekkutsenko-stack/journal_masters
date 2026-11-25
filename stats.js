'use strict';
/* Статистика, зона риска, контроль заполнения, карточка ученика. Всё считается в браузере. */

const RISK = { rate: 85, np: 3, streak: 2, minLessons: 5 };
const statsState = { period: 'quarter', slice: 'group', worstFirst: true };
const WEEKDAYS = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];

function emptyCounts() { return { lessons: 0, total: 0, present: 0, up: 0, np: 0, late: 0, notes: 0 }; }
function addMark(c, value) {
  c.total++;
  if (value === 'УП') c.up++;
  else if (value === 'НП') c.np++;
  else {
    c.present++;
    const tokens = markTokens(value);
    if (tokens.some(t => t.toLowerCase().startsWith('оп'))) c.late++;
    if (value !== 'П') c.notes++;
  }
}
const rateOf = c => (c.total ? (c.total - c.up - c.np) / c.total * 100 : NaN);

/** Обходит проведённые уроки листов: callback(sheet, j, student, value). */
function eachMark(sheets, callback, onLesson) {
  const today = localToday();
  for (const sheet of sheets) {
    sheet.dates.forEach((date, j) => {
      if (date > today || !lessonDone(sheet, j)) return;
      if (onLesson) onLesson(sheet, j);
      for (const student of sheet.students) {
        const value = markValue(sheet, student, j);
        if (value) callback(sheet, j, student, value);
      }
    });
  }
}

function sheetStats(sheet) {
  const c = emptyCounts();
  eachMark([sheet], (_s, _j, _st, value) => addMark(c, value), () => { c.lessons++; });
  c.rate = rateOf(c);
  return c;
}

/** Ученики в зоне риска среди листов: низкая посещаемость, много НП или НП подряд. */
function riskStudents(sheets) {
  const people = new Map();
  for (const sheet of sheets) {
    const today = localToday();
    for (const student of sheet.students) {
      const key = groupKey(sheet) + '|' + student.name;
      if (!people.has(key)) people.set(key, { name: student.name, group: groupKey(sheet), sheet, row: student.row, c: emptyCounts(), streak: 0, run: 0 });
      const p = people.get(key);
      sheet.dates.forEach((date, j) => {
        if (date > today || !lessonDone(sheet, j)) return;
        const value = markValue(sheet, student, j);
        if (!value) return;
        addMark(p.c, value);
        p.run = value === 'НП' ? p.run + 1 : 0;
        p.streak = Math.max(p.streak, p.run);
      });
    }
  }
  const result = [];
  for (const p of people.values()) {
    p.rate = rateOf(p.c);
    const reasons = [];
    if (p.c.total >= RISK.minLessons && p.rate < RISK.rate) reasons.push('посещаемость ' + percent(p.rate, 0));
    if (p.c.np >= RISK.np) reasons.push(p.c.np + ' НП');
    if (p.streak >= RISK.streak) reasons.push(p.streak + ' НП подряд');
    if (reasons.length) result.push({ ...p, reasons });
  }
  return result.sort((a, b) => (a.rate || 0) - (b.rate || 0));
}

/* ---------- Область статистики ---------- */
function statsSheets({ subjects = false } = {}) {
  const quarters = statsState.period === 'year' ? ['II', 'III', 'IV'] : [app.quarter];
  return app.journals.filter(s => {
    if (!quarters.includes(s.quarter)) return false;
    if (app.group && groupKey(s) !== app.group) return false;
    if (app.kind === 'primary') return s.kind === (subjects ? 'primarySubject' : 'primary');
    return s.kind === app.kind;
  });
}

function sliceRows(slice) {
  const sheets = statsSheets({ subjects: slice === 'subject' });
  const rows = new Map();
  const get = (key, label, extra) => {
    if (!rows.has(key)) rows.set(key, { key, label, c: emptyCounts(), ...extra });
    return rows.get(key);
  };
  eachMark(sheets, (sheet, j, student, value) => {
    let row;
    if (slice === 'group') row = get(groupKey(sheet), app.kind === 'exam' ? groupKey(sheet) : groupKey(sheet) + ' класс', { group: groupKey(sheet) });
    else if (slice === 'subject') row = get(sheet.subject + (app.kind === 'exam' ? ' · ' + sheet.exam : ''), sheet.subject + (app.kind === 'exam' ? ' · ' + sheet.exam : ''));
    else if (slice === 'student') row = get(groupKey(sheet) + '|' + student.name, displayName(student.name), { sub: groupKey(sheet), sheet, row: student.row });
    else {
      const wd = (isoDate(sheet.dates[j]).getUTCDay() + 6) % 7;
      row = get(wd, WEEKDAYS[wd], { order: wd });
    }
    addMark(row.c, value);
  });
  const list = [...rows.values()].map(r => ({ ...r, rate: rateOf(r.c) }));
  if (slice === 'weekday') return list.sort((a, b) => a.order - b.order);
  return list.sort((a, b) => (statsState.worstFirst ? a.rate - b.rate : b.rate - a.rate) || (slice === 'student' ? byName(a.label, b.label) : sortRu(a.label, b.label)));
}

function weeklyTrend(sheets) {
  const weeks = new Map();
  eachMark(sheets, (sheet, j, _st, value) => {
    const key = weekStart(sheet.dates[j]);
    if (!weeks.has(key)) weeks.set(key, emptyCounts());
    addMark(weeks.get(key), value);
  });
  return [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([start, c]) => ({ start, c, rate: rateOf(c) }));
}

/** Прошедшие занятия, которые никто не подтвердил. */
function unconfirmedLessons(sheets) {
  const today = localToday(), list = [];
  for (const sheet of sheets) {
    if (sheet.kind === 'primarySubject') continue;
    const missing = [];
    sheet.dates.forEach((date, j) => { if (date < today && !lessonDone(sheet, j)) missing.push(j); });
    if (missing.length) list.push({ sheet, missing });
  }
  return list.sort((a, b) => b.missing.length - a.missing.length);
}

/* ---------- Отрисовка ---------- */
function bar(rate) {
  const width = Number.isFinite(rate) ? Math.max(2, Math.min(100, rate)) : 0;
  const tone = !Number.isFinite(rate) ? '' : rate < RISK.rate ? 'bad' : rate < 92 ? 'mid' : 'good';
  return `<span class="bar"><i class="${tone}" style="width:${width}%"></i></span>`;
}

function trendChart(points) {
  if (points.length < 2) return '<p class="muted small">Недостаточно данных для динамики.</p>';
  const W = 640, H = 220, pad = { l: 48, r: 24, t: 14, b: 30 };
  const rates = points.map(p => p.rate).filter(Number.isFinite);
  const min = Math.max(0, Math.floor((Math.min(...rates) - 3) / 5) * 5), max = 100;
  const x = i => pad.l + i * (W - pad.l - pad.r) / (points.length - 1);
  const y = v => pad.t + (max - v) * (H - pad.t - pad.b) / (max - min || 1);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.rate).toFixed(1)}`).join(' ');
  const area = line + ` L${x(points.length - 1).toFixed(1)},${H - pad.b} L${pad.l},${H - pad.b} Z`;
  const ticks = [min, Math.round((min + max) / 2), max];
  const labelEvery = Math.ceil(points.length / 8);
  return `<svg class="trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="Посещаемость по неделям: от ${percent(Math.min(...rates))} до ${percent(Math.max(...rates))}">
    ${ticks.map(t => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${pad.l - 8}" y="${y(t) + 4}" text-anchor="end">${t}%</text>`).join('')}
    <path d="${area}" class="area"/><path d="${line}" class="line"/>
    ${points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.rate)}" r="3.5" class="dot"><title>Неделя с ${formatDate(p.start)}: ${percent(p.rate)}</title></circle>`).join('')}
    ${points.map((p, i) => (i % labelEvery === 0 || i === points.length - 1) ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${formatDate(p.start, { day: 'numeric', month: 'short' }).replace('.', '')}</text>` : '').join('')}
  </svg>`;
}

function heatmap(sheets) {
  // Ученики × недели для одного класса/группы.
  const weeks = new Map(), students = new Map();
  eachMark(sheets, (sheet, j, student, value) => {
    const w = weekStart(sheet.dates[j]);
    weeks.set(w, true);
    if (!students.has(student.name)) students.set(student.name, { sheet, row: student.row, cells: new Map() });
    const cells = students.get(student.name).cells;
    if (!cells.has(w)) cells.set(w, emptyCounts());
    addMark(cells.get(w), value);
  });
  const cols = [...weeks.keys()].sort();
  if (!cols.length) return '';
  const names = [...students.keys()].sort(byName);
  const cell = c => {
    if (!c) return '<td><i class="heat none"></i></td>';
    const r = rateOf(c), level = r >= 99 ? 4 : r >= 90 ? 3 : r >= 75 ? 2 : r >= 50 ? 1 : 0;
    return `<td><i class="heat h${level}" title="${percent(r)} · НП ${c.np}, УП ${c.up}"></i></td>`;
  };
  return `<div class="card stats-card span-2"><div class="card-title"><h3>Карта посещаемости</h3><span class="heat-legend">ученики × недели · <i class="heat h4"></i>без пропусков <i class="heat h2"></i>есть пропуски <i class="heat h0"></i>много</span></div>
    <div class="table-scroll"><table class="heatmap"><thead><tr><th></th>${cols.map(w => `<th>${formatDate(w, { day: 'numeric', month: 'short' }).replace('.', '')}</th>`).join('')}</tr></thead>
    <tbody>${names.map(n => { const p = students.get(n); return `<tr><th scope="row"><button class="link-btn" data-card-sheet="${escapeHTML(p.sheet.id)}" data-card-row="${p.row}">${escapeHTML(displayName(n))}</button></th>${cols.map(w => cell(p.cells.get(w))).join('')}</tr>`; }).join('')}</tbody></table></div></div>`;
}

function renderStats() {
  const view = $('#stats-view');
  const sheets = statsSheets();
  const total = emptyCounts();
  eachMark(sheets, (_s, _j, _st, value) => addMark(total, value), () => { total.lessons++; });
  const risk = riskStudents(sheets);
  const trend = weeklyTrend(sheets);
  const missing = unconfirmedLessons(statsSheets());
  const [section] = SECTION_TITLES[app.kind];
  const groupLabel = app.group ? (app.kind === 'exam' ? app.group : app.group + ' класс') : app.kind === 'exam' ? 'Все группы' : 'Все классы';
  const periodLabel = statsState.period === 'year' ? 'учебный год 2026/27' : app.quarter + ' четверть';
  const slices = [['group', app.kind === 'exam' ? 'Группы' : 'Классы'], ['subject', 'Предметы'], ['student', 'Ученики'], ['weekday', 'Дни недели']]
    .filter(([key]) => !(key === 'group' && app.group));
  if (!slices.some(([key]) => key === statsState.slice)) statsState.slice = slices[0][0];
  const rows = sliceRows(statsState.slice);

  view.innerHTML = `
    <div class="page-head">
      <div class="page-title"><p class="eyebrow">Статистика · ${escapeHTML(section)} · ${periodLabel}</p><h1>${escapeHTML(groupLabel)}</h1></div>
      <div class="head-actions">
        <div class="segmented" role="group" aria-label="Период">
          <button data-period="quarter" aria-pressed="${statsState.period === 'quarter'}">${app.quarter} четверть</button>
          <button data-period="year" aria-pressed="${statsState.period === 'year'}">Учебный год</button>
        </div>
        <button class="btn" data-report><svg><use href="#i-download"/></svg>Отчёт CSV</button>
      </div>
    </div>
    <div class="kpi-grid">
      <div class="card kpi-card accent"><span>Посещаемость</span><strong>${percent(rateOf(total))}</strong>${bar(rateOf(total))}</div>
      <div class="card kpi-card"><span>Проведено занятий</span><strong>${total.lessons}</strong><small class="muted">${total.total} отметок</small></div>
      <div class="card kpi-card"><span>Неуважительные</span><strong class="t-absent">${total.np}</strong><small class="muted">${percent(total.total ? total.np / total.total * 100 : NaN)} от отметок</small></div>
      <div class="card kpi-card"><span>Уважительные</span><strong class="t-excused">${total.up}</strong><small class="muted">${percent(total.total ? total.up / total.total * 100 : NaN)} от отметок</small></div>
      <div class="card kpi-card"><span>Опоздания и замечания</span><strong class="t-note">${total.late} · ${total.notes}</strong><small class="muted">оп · все замечания</small></div>
      <div class="card kpi-card"><span>Зона риска</span><strong class="t-excused">${risk.length}</strong><small class="muted">${plural(risk.length, 'ученик', 'ученика', 'учеников')}</small></div>
    </div>
    <div class="stats-grid">
      <div class="card stats-card">
        <div class="card-title">
          <div class="segmented small" role="group" aria-label="Разрез">${slices.map(([key, label]) => `<button data-slice="${key}" aria-pressed="${statsState.slice === key}">${label}</button>`).join('')}</div>
          ${statsState.slice === 'weekday' ? '' : `<button class="text-btn" data-sort>${statsState.worstFirst ? 'Сначала худшие' : 'Сначала лучшие'}</button>`}
        </div>
        <div class="rank-list">${rows.length ? rows.slice(0, statsState.slice === 'student' ? 60 : 40).map(r => `
          <div class="rank-row">
            ${r.group !== undefined ? `<button class="link-btn" data-goto-group="${escapeHTML(r.group)}">${escapeHTML(r.label)}</button>`
              : r.sheet ? `<button class="link-btn" data-card-sheet="${escapeHTML(r.sheet.id)}" data-card-row="${r.row}">${escapeHTML(r.label)}${app.group ? '' : `<small>${escapeHTML(r.sub)}</small>`}</button>`
              : `<span class="rank-label">${escapeHTML(r.label)}</span>`}
            ${bar(r.rate)}
            <strong>${percent(r.rate)}</strong>
            <span class="rank-meta"><b class="t-absent">${r.c.np}</b> НП · <b class="t-excused">${r.c.up}</b> УП</span>
          </div>`).join('') : '<p class="muted">Нет проведённых занятий за этот период.</p>'}
        </div>
      </div>
      <div class="stack">
        <div class="card stats-card"><div class="card-title"><h3>Динамика по неделям</h3></div>${trendChart(trend)}</div>
        <div class="card stats-card">
          <div class="card-title"><h3>Зона риска</h3><span class="muted small">ниже ${RISK.rate}%, от ${RISK.np} НП или ${RISK.streak} НП подряд</span></div>
          <div class="risk-list">${risk.length ? risk.slice(0, 12).map(p => `
            <button class="risk-row" data-card-sheet="${escapeHTML(p.sheet.id)}" data-card-row="${p.row}">
              <span class="avatar warn">${escapeHTML(initials(p.name))}</span>
              <span class="risk-text"><strong>${escapeHTML(displayName(p.name))}</strong><small>${escapeHTML(p.group)} · ${escapeHTML(p.reasons.join(', '))}</small></span>
              <b class="t-absent">${percent(p.rate, 0)}</b>
            </button>`).join('') + (risk.length > 12 ? `<p class="muted small">И ещё ${risk.length - 12}. Полный список — в отчёте CSV по ученикам.</p>` : '') : '<p class="muted">Никого. Отличная посещаемость.</p>'}
          </div>
        </div>
        <div class="card stats-card">
          <div class="card-title"><h3>Контроль заполнения</h3><span class="muted small">прошедшие занятия без подтверждения</span></div>
          <div class="risk-list">${missing.length ? missing.slice(0, 10).map(m => `
            <button class="risk-row" data-goto-sheet="${escapeHTML(m.sheet.id)}" data-goto-index="${m.missing.at(-1)}">
              <span class="avatar">${escapeHTML(groupKey(m.sheet))}</span>
              <span class="risk-text"><strong>${escapeHTML(m.sheet.subject)}</strong><small>последнее: ${formatDate(m.sheet.dates[m.missing.at(-1)])}</small></span>
              <b class="t-excused">${m.missing.length} ${plural(m.missing.length, 'день', 'дня', 'дней')}</b>
            </button>`).join('') : '<p class="muted">Все прошедшие занятия подтверждены.</p>'}
          </div>
        </div>
      </div>
      ${app.group ? heatmap(sheets) : ''}
    </div>`;
}

function exportReport() {
  const rows = sliceRows(statsState.slice);
  const header = ['Разрез', 'Отметок', 'Присутствовал', 'УП', 'НП', 'Опоздания', 'Замечания', 'Посещаемость, %'];
  const lines = [header, ...rows.map(r => [r.sub ? r.label + ' (' + r.sub + ')' : r.label, r.c.total, r.c.present, r.c.up, r.c.np, r.c.late, r.c.notes, Number.isFinite(r.rate) ? r.rate.toFixed(1).replace('.', ',') : ''])];
  const csv = '﻿' + lines.map(line => line.map(v => /[;"\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v).join(';')).join('\r\n');
  const name = ['Статистика', SECTION_TITLES[app.kind][0], app.group || 'все', statsState.period === 'year' ? 'год' : app.quarter + ' четверть', localToday()].join(' — ');
  download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), name + '.csv');
}

$('#stats-view').addEventListener('click', event => {
  const b = event.target.closest('button');
  if (!b) return;
  if (b.dataset.period) { statsState.period = b.dataset.period; renderStats(); }
  else if (b.dataset.slice) { statsState.slice = b.dataset.slice; renderStats(); }
  else if (b.hasAttribute('data-sort')) { statsState.worstFirst = !statsState.worstFirst; renderStats(); }
  else if (b.hasAttribute('data-report')) exportReport();
  else if (b.dataset.gotoGroup !== undefined) { app.group = b.dataset.gotoGroup; app.journal = ''; renderAll(); }
  else if (b.dataset.gotoSheet) {
    const sheet = sheetById(b.dataset.gotoSheet);
    app.quarter = sheet.quarter; app.group = groupKey(sheet); app.journal = sheet.id;
    focusDay(sheet, Number(b.dataset.gotoIndex)); setView('journal');
  }
});
document.addEventListener('click', event => {
  const b = event.target.closest('[data-card-sheet]');
  if (b) openStudentCard(sheetById(b.dataset.cardSheet), Number(b.dataset.cardRow));
});

/* ---------- Карточка ученика ---------- */
function openStudentCard(sheet, row) {
  const student = sheet?.students.find(s => s.row === row);
  if (!student) return;
  const kind = sheet.kind === 'primarySubject' ? 'primary' : sheet.kind;
  const related = app.journals.filter(s => groupKey(s) === groupKey(sheet) && (s.kind === sheet.kind || (kind === 'primary' && (s.kind === 'primary' || s.kind === 'primarySubject'))));
  const find = s => s.students.find(p => p.name === student.name);
  const main = related.filter(s => (kind === 'primary' ? s.kind === 'primary' : true));
  const subjectSheets = related.filter(s => (kind === 'primary' ? s.kind === 'primarySubject' : true));

  const count = (sheets, quarter) => {
    const c = emptyCounts();
    for (const s of sheets) {
      if (quarter && s.quarter !== quarter) continue;
      const st = find(s); if (!st) continue;
      eachMark([{ ...s, students: [st] }], (_a, _b, _c, value) => addMark(c, value));
    }
    c.rate = rateOf(c);
    return c;
  };
  const quarterC = count(main, app.quarter), yearC = count(main);
  const bySubject = new Map();
  for (const s of subjectSheets.filter(x => x.quarter === app.quarter)) {
    const st = find(s); if (!st) continue;
    const c = bySubject.get(s.subject) || emptyCounts();
    eachMark([{ ...s, students: [st] }], (_a, _b, _c, value) => addMark(c, value));
    bySubject.set(s.subject, c);
  }
  const weeks = new Map(), events = [];
  for (const s of main.filter(x => x.quarter === app.quarter)) {
    const st = find(s); if (!st) continue;
    eachMark([{ ...s, students: [st] }], (sh, j, _c, value) => {
      const w = weekStart(sh.dates[j]);
      if (!weeks.has(w)) weeks.set(w, emptyCounts());
      addMark(weeks.get(w), value);
      if (value !== 'П') events.push({ date: sh.dates[j], value, subject: sh.subject });
    });
  }
  if (kind !== 'primary') events.sort((a, b) => b.date.localeCompare(a.date));
  else events.reverse();
  const weekList = [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-10);

  $('#student-avatar').textContent = initials(student.name);
  $('#student-name').textContent = displayName(student.name);
  $('#student-meta').textContent = (kind === 'exam' ? groupKey(sheet) : groupKey(sheet) + ' класс') + ' · ' + SECTION_TITLES[kind][0];
  $('#student-body').innerHTML = `
    <div class="card-section">
      <div class="big-rate"><span class="muted">Посещаемость · ${app.quarter} четверть</span><strong>${percent(quarterC.rate)}</strong></div>
      ${bar(quarterC.rate)}
      <p class="muted small">За учебный год: ${percent(yearC.rate)} · ${yearC.total} ${plural(yearC.total, 'отметка', 'отметки', 'отметок')}</p>
    </div>
    <div class="mini-grid">
      <div><strong class="t-excused">${quarterC.up}</strong><span>${plural(quarterC.up, 'уважительный', 'уважительных', 'уважительных')}</span></div>
      <div><strong class="t-absent">${quarterC.np}</strong><span>${plural(quarterC.np, 'неуважительный', 'неуважительных', 'неуважительных')}</span></div>
      <div><strong class="t-note">${quarterC.late}</strong><span>${plural(quarterC.late, 'опоздание', 'опоздания', 'опозданий')}</span></div>
      <div><strong>${quarterC.notes}</strong><span>${plural(quarterC.notes, 'замечание', 'замечания', 'замечаний')}</span></div>
    </div>
    ${weekList.length ? `<div class="card-section"><h4>По неделям</h4><div class="week-bars">${weekList.map(([w, c]) => { const r = rateOf(c); return `<span title="Неделя с ${formatDate(w)}: ${percent(r)}"><i class="${r < RISK.rate ? 'bad' : r < 92 ? 'mid' : 'good'}" style="height:${Math.max(6, Math.min(100, (r - 50) * 2))}%"></i><small>${formatDate(w, { day: 'numeric' })}</small></span>`; }).join('')}</div></div>` : ''}
    ${bySubject.size > 1 ? `<div class="card-section"><h4>По предметам</h4>${[...bySubject.entries()].map(([name, c]) => `<div class="rank-row compact"><span class="rank-label">${escapeHTML(name)}</span>${bar(rateOf(c))}<strong>${percent(rateOf(c), 0)}</strong></div>`).join('')}</div>` : ''}
    <div class="card-section"><h4>Последние пропуски и замечания</h4>
      ${events.length ? `<ul class="event-list">${events.slice(0, 10).map(e => `<li><span class="mark ${markKind(e.value)}">${escapeHTML(e.value)}</span><span>${formatDate(e.date, { day: 'numeric', month: 'long', weekday: 'short' })}</span>${kind === 'primary' ? '' : `<small class="muted">${escapeHTML(e.subject)}</small>`}</li>`).join('')}</ul>` : '<p class="muted">Пропусков и замечаний нет.</p>'}
    </div>`;
  $('#student-dialog').showModal();
}
$('#student-close').onclick = () => $('#student-dialog').close();
