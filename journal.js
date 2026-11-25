'use strict';
/* Экран журнала: выбор раздела/класса, неделя (компьютер), день (телефон), отметки. */

const SECTION_TITLES = {
  primary: ['Начальная школа', 'Одна отметка на ученика за день'],
  class: ['Классы 5–11', 'Посещаемость и замечания по предметам'],
  exam: ['ОГЭ и ЕГЭ', 'Подготовка к экзаменам · списки по предметам'],
};

const currentSheet = () => sheetById(app.journal);
/** Листы выбранного раздела и четверти. Предметы началки показываются вместе с дневным листом. */
function availableSheets(kind = app.kind, quarter = app.quarter) {
  return app.journals.filter(s => (s.kind === kind || (kind === 'primary' && s.kind === 'primarySubject')) && s.quarter === quarter);
}
const groupKey = sheet => (sheet.kind === 'exam' ? sheet.exam : sheet.cls);
const sortRu = (a, b) => a.localeCompare(b, 'ru', { numeric: true });
const groupsOf = sheets => [...new Set(sheets.map(groupKey))].sort(sortRu);

function lastFilledIndex(sheet) {
  let result = -1;
  const today = localToday();
  for (let j = 0; j < sheet.dates.length; j++) {
    if (sheet.dates[j] > today) continue;
    const col = column(j + 2);
    const values = [raw(sheet, col + '3'), ...sheet.students.map(p => raw(sheet, col + p.row)), ...(sheet.schedule || []).map(item => raw(sheet, col + item.row))];
    if (values.some(cell => !cell.formula && cell.value !== null && cell.value !== undefined && cell.value !== '')) result = j;
  }
  return result;
}

function weekIndexOf(sheet, dayIndex) {
  return Math.max(0, calendarWeeks(sheet.dates).findIndex(week => week.indexes.includes(dayIndex)));
}
function focusDay(sheet, index) {
  app.day = sheet.dates[index];
  app.week = weekIndexOf(sheet, index);
}

function selectJournal(resetWeek = true) {
  const items = availableSheets();
  const groups = groupsOf(items);
  if (!groups.includes(app.group)) app.group = groups[0] || '';
  const choices = items.filter(s => groupKey(s) === app.group);
  if (!choices.some(s => s.id === app.journal)) app.journal = choices[0]?.id || '';
  const s = currentSheet();
  if (s && resetWeek) {
    let index = s.dates.indexOf(app.day);
    if (index < 0) index = lastFilledIndex(s);
    if (index < 0) index = nearestDateIndex(s.dates, localToday());
    focusDay(s, index);
  }
  renderAll();
  if (sync.ready) persistQueue();
}

function setView(view) {
  app.view = view;
  renderAll();
  window.scrollTo({ top: 0 });
}

function renderAll() {
  const loaded = app.journals.length > 0;
  $('#welcome').hidden = loaded;
  $$('[data-export]').forEach(b => { b.disabled = !loaded; });
  $$('[data-kind]').forEach(b => {
    const on = b.dataset.kind === app.kind;
    b.classList.toggle('active', on && (app.view === 'journal' || !b.classList.contains('nav-item')));
    b.setAttribute('aria-pressed', String(on));
  });
  $$('[data-view-btn]').forEach(b => b.classList.toggle('active', b.dataset.viewBtn === app.view));
  $$('[data-quarter]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.quarter === app.quarter)));
  renderGroups();
  $('#journal-view').hidden = !loaded || app.view !== 'journal';
  $('#stats-view').hidden = !loaded || app.view !== 'stats';
  $('#curators-view').hidden = !loaded || app.view !== 'curators';
  $('.topbar .groups').hidden = app.view === 'curators';
  if (!loaded) return;
  if (app.view === 'stats') { $('#empty-state').hidden = true; renderStats(); return; }
  if (app.view === 'curators') { $('#empty-state').hidden = true; renderCurators(); return; }
  renderJournal();
}

function renderGroups() {
  const box = $('#groups');
  if (!app.journals.length) { box.replaceChildren(); return; }
  const groups = groupsOf(availableSheets());
  box.innerHTML = (app.view === 'stats' ? `<button class="chip ${app.group === '' ? 'active' : ''}" data-group="">Все</button>` : '')
    + groups.map(g => `<button class="chip ${g === app.group ? 'active' : ''}" data-group="${escapeHTML(g)}">${escapeHTML(g)}</button>`).join('');
  box.querySelectorAll('button').forEach(button => {
    button.onclick = () => {
      app.group = button.dataset.group;
      app.journal = '';
      if (app.view === 'stats') { renderAll(); return; }
      selectJournal();
    };
  });
}

function renderJournal() {
  const items = availableSheets(), picked = currentSheet();
  if (items.length && (!picked || !items.includes(picked) || groupKey(picked) !== app.group)) { selectJournal(); return; }
  const s = currentSheet();
  $('#empty-state').hidden = !!s;
  $('#journal-view').hidden = !s;
  if (!s) return;
  const [section, description] = SECTION_TITLES[app.kind];

  $('#page-eyebrow').textContent = section + ' · ' + app.quarter + ' четверть';
  $('#journal-title').textContent = app.kind === 'primary' ? 'Класс ' + s.cls : app.kind === 'exam' ? s.exam : s.cls + ' класс';
  const choices = availableSheets().filter(x => groupKey(x) === app.group);
  const select = $('#journal-select');
  select.innerHTML = choices.map(x => `<option value="${escapeHTML(x.id)}">${escapeHTML(x.subject)}</option>`).join('');
  select.value = app.journal;
  $('#subject-field').hidden = choices.length < 2 && app.kind !== 'class';
  select.setAttribute('aria-label', description);

  const weeks = calendarWeeks(s.dates);
  app.week = Math.min(Math.max(app.week, 0), weeks.length - 1);
  const week = weeks[app.week], indexes = week.indexes;
  if (!indexes.some(i => s.dates[i] === app.day)) app.day = s.dates[indexes[0]];
  const first = s.dates[indexes[0]], last = s.dates[indexes.at(-1)];
  $('#week-label').textContent = weekLabel(first, last);
  $('#prev-week').disabled = app.week === 0;
  $('#next-week').disabled = app.week >= weeks.length - 1;

  const query = normalizeText($('#student-search').value);
  const students = s.students.filter(student => normalizeText(student.name).includes(query) || personName(student.name).key.includes(query))
    .sort((a, b) => byName(a.name, b.name));

  renderKpis(s);
  renderWeekTable(s, indexes, students);
  renderDayMode(s, indexes, students);
  renderSchedule(s);
}

function weekLabel(first, last) {
  const short = d => formatDate(d, { day: 'numeric', month: 'short' }).replace('.', '');
  if (first === last) return formatDate(first);
  if (first.slice(0, 7) === last.slice(0, 7)) return isoDate(first).getUTCDate() + '–' + formatDate(last);
  return short(first) + ' — ' + short(last);
}

function renderKpis(s) {
  const st = sheetStats(s);
  const risk = riskStudents([s]).length;
  $('#journal-kpis').innerHTML = `
    <div class="kpi"><strong>${percent(st.rate)}</strong><span>посещаемость за четверть</span></div>
    <div class="kpi"><strong class="t-absent">${st.np}</strong><span>${plural(st.np, 'пропуск НП', 'пропуска НП', 'пропусков НП')}</span></div>
    <div class="kpi"><strong class="t-excused">${risk}</strong><span>в зоне риска</span></div>`;
}

function confirmButton(s, j) {
  const done = lessonDone(s, j), date = s.dates[j];
  return `<button class="confirm ${done ? 'on' : ''}" data-confirm="${j}" aria-label="${done ? 'Отменить подтверждение' : 'Подтвердить занятие'} ${formatDate(date)}">${done ? '<svg><use href="#i-check"/></svg>Проведён' : 'Подтвердить'}</button>`;
}
function markButton(s, student, j, extraClass = '') {
  const value = markValue(s, student, j);
  return `<button class="mark ${markKind(value)} ${extraClass}" data-row="${student.row}" data-index="${j}" title="${escapeHTML(value || 'Поставить отметку')}" aria-label="${escapeHTML(displayName(student.name))}, ${formatDate(s.dates[j])}, ${escapeHTML(value || 'нет отметки')}">${escapeHTML(value || '—')}</button>`;
}

function renderWeekTable(s, indexes, students) {
  const today = localToday();
  const head = indexes.map(j => {
    const date = s.dates[j];
    return `<th class="${date === app.day ? 'selected' : ''} ${date === today ? 'today' : ''}">
      <button class="date-btn" data-day="${date}"><strong>${formatDate(date, { day: 'numeric', month: 'short' }).replace('.', '')}</strong><small>${formatDate(date, { weekday: 'short' })}</small></button>
      ${confirmButton(s, j)}</th>`;
  }).join('');
  const rows = students.map((student, n) => `<tr><th scope="row">
      <button class="student-btn" data-student="${student.row}"><span class="avatar">${escapeHTML(initials(student.name))}</span><span class="num">${String(n + 1).padStart(2, '0')}</span><span class="name">${escapeHTML(displayName(student.name))}</span></button></th>
      ${indexes.map(j => `<td class="${s.dates[j] === app.day ? 'selected' : ''} ${lessonDone(s, j) ? '' : 'unconfirmed'}">${markButton(s, student, j)}</td>`).join('')}</tr>`).join('');
  $('#attendance-table').innerHTML = `<thead><tr><th class="corner">Ученик <span class="muted">· ${students.length}</span></th>${head}</tr></thead>
    <tbody>${rows || `<tr><td colspan="${indexes.length + 1}" class="empty-row">По вашему запросу учеников нет</td></tr>`}</tbody>`;
}

function renderDayMode(s, indexes, students) {
  const j = s.dates.indexOf(app.day);
  $('#day-strip').innerHTML = indexes.map(i => {
    const date = s.dates[i], done = lessonDone(s, i);
    return `<button data-day="${date}" class="${date === app.day ? 'active' : ''}" aria-pressed="${date === app.day}">
      <small>${formatDate(date, { weekday: 'short' })}</small><strong>${formatDate(date, { day: 'numeric' })}</strong><i class="${done ? 'on' : ''}"></i></button>`;
  }).join('');
  const values = s.students.map(st => markValue(s, st, j)), done = lessonDone(s, j);
  const present = values.filter(v => v && !isAbsence(v)).length, absent = values.filter(isAbsence).length;
  const notes = values.filter(v => v && !['П', 'УП', 'НП'].includes(v)).length;
  $('#day-summary').innerHTML = `<div><strong>${formatDate(app.day, { weekday: 'long', day: 'numeric', month: 'long' })}</strong>
      <span class="muted">${done ? `${present} из ${s.students.length} · ${absent} ${plural(absent, 'пропуск', 'пропуска', 'пропусков')} · ${notes} ${plural(notes, 'замечание', 'замечания', 'замечаний')}` : 'Занятие ещё не подтверждено'}</span></div>
    ${confirmButton(s, j)}`;
  $('#day-list').innerHTML = students.map(student => {
    const value = markValue(s, student, j);
    const quick = ['П', 'УП', 'НП'].map(code => `<button class="quick ${value === code ? markKind(code) + ' on' : ''}" data-quick="${code}" data-row="${student.row}" aria-label="${escapeHTML(displayName(student.name))}: ${code}" aria-pressed="${value === code}">${code}</button>`).join('');
    const other = value && !['П', 'УП', 'НП'].includes(value);
    return `<div class="day-row">
      <button class="student-btn" data-student="${student.row}"><span class="avatar">${escapeHTML(initials(student.name))}</span><span class="name">${escapeHTML(displayName(student.name))}</span></button>
      <div class="quick-set">${quick}<button class="quick more ${other ? 'note on' : ''}" data-row="${student.row}" data-index="${j}" aria-label="${escapeHTML(displayName(student.name))}: другая отметка">${other ? escapeHTML(value) : 'Ещё'}</button></div>
    </div>`;
  }).join('') || '<p class="empty-row">По вашему запросу учеников нет</p>';
}

function renderSchedule(s) {
  const card = $('#schedule-card');
  card.hidden = s.kind !== 'primary';
  if (s.kind !== 'primary') return;
  const j = s.dates.indexOf(app.day);
  $('#schedule-items').innerHTML = s.schedule.map((item, i) => {
    const active = String(raw(s, column(j + 2) + item.row).value || '').toLowerCase() === 'да';
    return `<button class="chip ${active ? 'active' : ''}" data-schedule="${i}" aria-pressed="${active}">${active ? '<svg><use href="#i-check"/></svg>' : ''}${escapeHTML(item.label)}</button>`;
  }).join('');
}

/* ---------- Отметки ---------- */
function toggleConfirm(s, j) {
  focusDay(s, j);
  const wasDone = lessonDone(s, j);
  const snapshots = [snapshotCell(s, column(j + 2) + '3')];
  if (wasDone && s.kind === 'primary') s.schedule.forEach(item => snapshots.push(snapshotCell(s, column(j + 2) + item.row)));
  patch(s, column(j + 2) + '3', wasDone ? 'Нет' : 'Да');
  if (wasDone && s.kind === 'primary') for (const item of s.schedule) patch(s, column(j + 2) + item.row, 'Нет');
  renderAll();
  toast(wasDone ? 'Подтверждение занятия снято' : 'Занятие подтверждено. Отметьте пропуски и замечания.', {
    label: 'Отменить', run: () => { snapshots.reverse().forEach(restoreCell); renderAll(); },
  });
}

function openMark(row, index) {
  const s = currentSheet(), student = s.students.find(p => p.row === row);
  if (!student) return;
  app.active = { sheet: s, row, index, student };
  app.day = s.dates[index];
  $('#mark-name').textContent = displayName(student.name);
  $('#mark-date').textContent = formatDate(app.day, { weekday: 'long', day: 'numeric', month: 'long' }) + ' · ' + s.subject;
  const value = markValue(s, student, index);
  $('#custom-mark').value = value;
  $('#mark-options').innerHTML = MARK_CODES.map(([code, label]) => `<button type="button" class="option ${markKind(code)} ${value === code ? 'on' : ''}" data-code="${code}"><strong>${code}</strong><small>${label}</small></button>`).join('');
  $('#mark-dialog').showModal();
}

function setMark(value, target = app.active) {
  const { sheet, row, index, student } = target;
  const ref = column(index + 2) + row;
  const before = snapshotCell(sheet, ref), previous = markValue(sheet, student, index);
  patch(sheet, ref, value);
  if ($('#mark-dialog').open) $('#mark-dialog').close();
  renderAll();
  const hint = lessonDone(sheet, index) ? '' : ' Подтвердите занятие над датой.';
  toast(`${displayName(student.name)}: ${previous || '—'} → ${value || '—'}.${hint}`, {
    label: 'Отменить', run: () => { restoreCell(before); renderAll(); },
  });
}

/* ---------- События ---------- */
document.addEventListener('click', event => {
  const target = event.target.closest('button');
  if (!target || !app.journals.length) return;
  const s = currentSheet();
  if (target.dataset.day && s) { focusDay(s, s.dates.indexOf(target.dataset.day)); renderAll(); return; }
  if (target.dataset.confirm && s) { toggleConfirm(s, Number(target.dataset.confirm)); return; }
  if (target.dataset.quick && s) {
    const row = Number(target.dataset.row), student = s.students.find(p => p.row === row), j = s.dates.indexOf(app.day);
    if (markValue(s, student, j) === target.dataset.quick) return;
    setMark(target.dataset.quick, { sheet: s, row, index: j, student });
    return;
  }
  if (target.dataset.row && target.dataset.index && s) { openMark(Number(target.dataset.row), Number(target.dataset.index)); return; }
  if (target.dataset.student && s) { openStudentCard(s, Number(target.dataset.student)); return; }
  if (target.dataset.schedule && s) {
    const item = s.schedule[Number(target.dataset.schedule)], ref = column(s.dates.indexOf(app.day) + 2) + item.row;
    const active = String(raw(s, ref).value || '').toLowerCase() === 'да';
    patch(s, ref, active ? 'Нет' : 'Да');
    renderAll();
  }
});

$('#mark-options').addEventListener('click', event => {
  const option = event.target.closest('[data-code]');
  if (option) setMark(option.dataset.code);
});
$('#apply-mark').onclick = () => setMark($('#custom-mark').value.trim());
$('#reset-mark').onclick = () => {
  const { sheet, row, index } = app.active, ref = column(index + 2) + row, before = snapshotCell(sheet, ref);
  queueChange(cellKey(sheet.id, ref), null, true);
  $('#mark-dialog').close();
  renderAll();
  toast('Возвращена исходная отметка', { label: 'Отменить', run: () => { restoreCell(before); renderAll(); } });
};

$('#student-search').oninput = () => renderAll();
$('#journal-select').onchange = event => { app.journal = event.target.value; selectJournal(); };
$$('[data-kind]').forEach(button => button.addEventListener('click', () => {
  app.kind = button.dataset.kind; app.group = ''; app.journal = ''; $('#student-search').value = '';
  if (app.view === 'curators') app.view = 'journal';
  selectJournal();
}));
$$('[data-quarter]').forEach(button => button.addEventListener('click', () => {
  app.quarter = button.dataset.quarter; app.day = ''; app.journal = '';
  selectJournal();
}));
$$('[data-view-btn]').forEach(button => button.addEventListener('click', () => setView(button.dataset.viewBtn)));
$('#prev-week').onclick = () => { app.week--; renderAll(); };
$('#next-week').onclick = () => { app.week++; renderAll(); };
$('#today-btn').onclick = () => {
  const s = currentSheet(); if (!s) return;
  const today = localToday(), index = nearestDateIndex(s.dates, today);
  focusDay(s, index);
  renderAll();
  if (s.dates[index] !== today) toast('Сегодня занятий нет — открыт ближайший учебный день.');
};
$('#last-filled-btn').onclick = () => {
  const s = currentSheet(), index = s ? lastFilledIndex(s) : -1;
  if (index < 0) { toast('В выбранном журнале пока нет заполненных дат.'); return; }
  focusDay(s, index); renderAll(); persistQueue();
};
$$('[data-open-help]').forEach(b => b.addEventListener('click', () => { $('#more-dialog').close(); $('#help-dialog').showModal(); }));
$$('[data-open-picker]').forEach(b => b.addEventListener('click', () => $('#picker-dialog').showModal()));
$$('[data-open-more]').forEach(b => b.addEventListener('click', () => { $('#more-role').textContent = $('#staff-role').textContent; $('#more-dialog').showModal(); }));
$('#picker-dialog').addEventListener('click', event => { if (event.target.closest('[data-kind]')) $('#picker-dialog').close(); });

/* Закрытие диалогов по клику на фон. */
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => {
  if (event.target === dialog) dialog.close();
}));
