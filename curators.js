'use strict';
/*
 * Работа кураторов с родителями.
 * Раз в неделю (по итогам прошедшей недели) в отдельный журнал попадают ученики
 * с низкой посещаемостью или частыми замечаниями. Куратор отмечает, связался ли
 * он с родителями, каким способом и о чём договорились.
 *
 * Сервер: функции curator_cases_list / curator_cases_add / curator_case_update
 * (см. supabase/curator_cases.sql). Пока их нет, список виден, но не сохраняется.
 */

const CURATOR_RULES = { rate: 75, minLessons: 3, np: 3, notes: 3, weeksBack: 1 };
const CASE_STATUSES = [
  ['new', 'Новый'],
  ['contacted', 'Связались'],
  ['no_answer', 'Не дозвонились'],
  ['resolved', 'Решено'],
];
const CONTACT_METHODS = ['Звонок', 'Сообщение', 'Встреча', 'Письмо'];
const curators = { cases: [], ready: false, serverMissing: false, week: '', status: 'open', group: '', open: null };

const statusLabel = code => (CASE_STATUSES.find(([c]) => c === code) || [, code])[1];
const caseKey = c => [c.week_start, c.kind, c.group_name, c.student_name].join('|');

/** Ученики, которых нужно взять в работу по итогам каждой завершённой недели. */
function weeklyCandidates(weeksBack = CURATOR_RULES.weeksBack) {
  const thisWeek = weekStart(localToday());
  const oldest = (() => { const d = isoDate(thisWeek); d.setUTCDate(d.getUTCDate() - 7 * weeksBack); return d.toISOString().slice(0, 10); })();
  const people = new Map();
  const sheets = app.journals.filter(s => s.kind !== 'primarySubject');
  eachMark(sheets, (sheet, j, student, value) => {
    const week = weekStart(sheet.dates[j]);
    if (week >= thisWeek || week < oldest) return;
    const key = [week, sheet.kind, groupKey(sheet), student.name].join('|');
    if (!people.has(key)) people.set(key, { week_start: week, kind: sheet.kind, group_name: groupKey(sheet), student_name: student.name, c: emptyCounts(), subjects: new Set() });
    const p = people.get(key);
    addMark(p.c, value);
    if (value !== 'П' && sheet.kind !== 'primary') p.subjects.add(sheet.subject);
  });
  const result = [];
  for (const p of people.values()) {
    const rate = rateOf(p.c), reasons = [];
    if (p.c.total >= CURATOR_RULES.minLessons && rate < CURATOR_RULES.rate) reasons.push('посещаемость ' + percent(rate, 0));
    if (p.c.np >= CURATOR_RULES.np) reasons.push(p.c.np + ' НП');
    if (p.c.notes >= CURATOR_RULES.notes) reasons.push(p.c.notes + ' ' + plural(p.c.notes, 'замечание', 'замечания', 'замечаний'));
    if (!reasons.length) continue;
    const subjects = [...p.subjects].slice(0, 3);
    result.push({
      week_start: p.week_start, kind: p.kind, group_name: p.group_name, student_name: p.student_name,
      reason: reasons.join(' · ') + (subjects.length ? ' · ' + subjects.join(', ') : ''),
      stats: { total: p.c.total, up: p.c.up, np: p.c.np, notes: p.c.notes, rate: Number.isFinite(rate) ? Math.round(rate * 10) / 10 : null },
    });
  }
  return result;
}

function isMissingFunction(error) {
  return /could not find the function|does not exist|PGRST202/i.test(String(error?.message || error));
}

/** Загружает журнал кураторов и добавляет новых учеников за прошедшую неделю. */
function syncCuratorCases() {
  curators.syncing ??= loadCuratorCases().finally(() => { curators.syncing = null; });
  return curators.syncing;
}
async function loadCuratorCases() {
  const candidates = weeklyCandidates(DEMO_MODE ? 3 : CURATOR_RULES.weeksBack);
  try {
    const since = (() => { const d = isoDate(weekStart(localToday())); d.setUTCDate(d.getUTCDate() - 7 * 12); return d.toISOString().slice(0, 10); })();
    const known = await callJournal('curator_cases_list', { since });
    const have = new Set(known.map(caseKey));
    const fresh = candidates.filter(c => !have.has(caseKey(c)));
    const added = fresh.length ? await callJournal('curator_cases_add', { cases: fresh }) : [];
    curators.cases = known.concat(added);
    curators.serverMissing = false;
  } catch (error) {
    if (!isMissingFunction(error)) throw error;
    // На сервере ещё нет таблицы кураторов: показываем расчёт без сохранения.
    curators.serverMissing = true;
    curators.cases = candidates.map((c, i) => ({ ...c, id: 'local-' + i, status: 'new', contact_method: '', note: '', updated_at: null, updated_by: '' }));
  }
  curators.ready = true;
  updateCuratorBadge();
}

function updateCuratorBadge() {
  const count = curators.cases.filter(c => c.status === 'new').length;
  $$('[data-curator-badge]').forEach(el => { el.textContent = count > 99 ? '99+' : String(count); el.hidden = !count; });
}

function findStudentSheet(c) {
  const sheets = app.journals.filter(s => s.kind === c.kind && groupKey(s) === c.group_name);
  const ordered = [...sheets.filter(s => s.quarter === app.quarter), ...sheets];
  for (const sheet of ordered) {
    const st = sheet.students.find(p => p.name === c.student_name);
    if (st) return { sheet, row: st.row };
  }
  return null;
}

function renderCurators() {
  const view = $('#curators-view');
  if (!curators.ready) {
    view.innerHTML = '<p class="muted">Собираем список учеников за прошлую неделю…</p>';
    syncCuratorCases().then(renderCurators).catch(error => { view.innerHTML = `<p class="form-message">${escapeHTML(error.message)}</p>`; });
    return;
  }
  const weeks = [...new Set(curators.cases.map(c => c.week_start))].sort().reverse();
  if (!weeks.includes(curators.week)) curators.week = weeks[0] || '';
  const inWeek = curators.cases.filter(c => c.week_start === curators.week);
  const groups = [...new Set(inWeek.map(c => c.group_name))].sort(sortRu);
  if (!groups.includes(curators.group)) curators.group = '';
  const filters = [
    ['open', 'В работе', c => c.status !== 'resolved'],
    ['new', 'Новые', c => c.status === 'new'],
    ['resolved', 'Решено', c => c.status === 'resolved'],
    ['all', 'Все', () => true],
  ];
  const test = filters.find(([k]) => k === curators.status)[2];
  const list = inWeek.filter(c => test(c) && (!curators.group || c.group_name === curators.group))
    .sort((a, b) => (a.status === 'new' ? 0 : 1) - (b.status === 'new' ? 0 : 1) || sortRu(a.group_name, b.group_name) || byName(a.student_name, b.student_name));
  const weekIndex = weeks.indexOf(curators.week);
  const weekEnd = curators.week ? (() => { const d = isoDate(curators.week); d.setUTCDate(d.getUTCDate() + 4); return d.toISOString().slice(0, 10); })() : '';
  const counts = Object.fromEntries(filters.map(([k, , f]) => [k, inWeek.filter(f).length]));

  view.innerHTML = `
    <div class="page-head">
      <div class="page-title">
        <p class="eyebrow">Кураторам · работа с родителями</p>
        <h1>${curators.week ? escapeHTML(weekLabel(curators.week, weekEnd)) : 'Список пуст'}</h1>
        <p class="muted lead">Каждую неделю сюда автоматически попадают ученики с посещаемостью ниже ${CURATOR_RULES.rate}%, от ${CURATOR_RULES.np} пропусков НП или от ${CURATOR_RULES.notes} замечаний за неделю.</p>
      </div>
      <div class="head-actions">
        <button class="btn" data-cweek="${weekIndex + 1}" ${weekIndex >= weeks.length - 1 ? 'disabled' : ''}><svg><use href="#i-left"/></svg>Прошлая неделя</button>
        <button class="btn" data-cweek="${weekIndex - 1}" ${weekIndex <= 0 ? 'disabled' : ''}>Следующая<svg><use href="#i-right"/></svg></button>
      </div>
    </div>
    ${curators.serverMissing ? `<div class="notice"><svg><use href="#i-alert"/></svg><div><strong>Список рассчитан, но пока не сохраняется.</strong><span>Чтобы отметки кураторов сохранялись и были видны всем, администратору нужно один раз выполнить файл <b>supabase/curator_cases.sql</b> в Supabase.</span></div></div>` : ''}
    <div class="filter-row">
      <div class="segmented" role="group" aria-label="Статус">${filters.map(([k, label]) => `<button data-cstatus="${k}" aria-pressed="${curators.status === k}">${label} <span class="count">${counts[k]}</span></button>`).join('')}</div>
      <label class="field inline">Класс<select id="curator-group"><option value="">Все классы и группы</option>${groups.map(g => `<option ${g === curators.group ? 'selected' : ''}>${escapeHTML(g)}</option>`).join('')}</select></label>
    </div>
    <div class="case-list">${list.length ? list.map(caseCard).join('') : `<div class="card empty-card"><svg><use href="#i-check"/></svg><p>${inWeek.length ? 'По этому фильтру никого нет.' : 'На этой неделе никто не попал в список. Отлично!'}</p></div>`}</div>`;
}

function caseCard(c) {
  const open = curators.open === String(c.id);
  const kindName = SECTION_TITLES[c.kind]?.[0] || '';
  const updated = c.updated_at ? new Date(c.updated_at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) + (c.updated_by ? ' · ' + c.updated_by : '') : '';
  return `<article class="card case-card status-${escapeHTML(c.status)}">
    <div class="case-main">
      <button class="student-btn" data-case-student="${escapeHTML(c.id)}"><span class="avatar warn">${escapeHTML(initials(c.student_name))}</span>
        <span><span class="name">${escapeHTML(displayName(c.student_name))}</span><small class="muted">${escapeHTML(c.kind === 'exam' ? c.group_name : c.group_name + ' класс')} · ${escapeHTML(kindName)}</small></span></button>
      <span class="status-pill ${escapeHTML(c.status)}">${escapeHTML(statusLabel(c.status))}</span>
    </div>
    <p class="case-reason"><svg><use href="#i-alert"/></svg>${escapeHTML(c.reason)}</p>
    ${c.note || c.contact_method ? `<p class="case-note">${c.contact_method ? `<b>${escapeHTML(c.contact_method)}.</b> ` : ''}${escapeHTML(c.note || '')}</p>` : ''}
    ${updated ? `<p class="muted small">Обновлено ${escapeHTML(updated)}</p>` : ''}
    ${open ? `<form class="case-form" data-case-form="${escapeHTML(c.id)}">
        <div class="segmented wide" role="group" aria-label="Результат">${CASE_STATUSES.map(([k, label]) => `<button type="button" data-set-status="${k}" aria-pressed="${c.status === k}">${label}</button>`).join('')}</div>
        <div class="control-row">
          <label class="field">Как связались<select name="method"><option value="">—</option>${CONTACT_METHODS.map(m => `<option ${m === c.contact_method ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
        </div>
        <label class="field">О чём договорились<textarea name="note" rows="3" maxlength="1000" placeholder="Например: мама знает о пропусках, обещала контролировать подключение к урокам">${escapeHTML(c.note || '')}</textarea></label>
        <input type="hidden" name="status" value="${escapeHTML(c.status)}">
        <div class="sheet-actions"><button type="button" class="btn" data-case-close>Отмена</button><button class="btn btn-primary">Сохранить</button></div>
      </form>` : `<div class="case-actions"><button class="btn ${c.status === 'new' ? 'btn-accent' : ''}" data-case-open="${escapeHTML(c.id)}">${c.status === 'new' ? 'Отметить разговор с родителями' : 'Изменить'}</button></div>`}
  </article>`;
}

async function saveCase(id, form) {
  const c = curators.cases.find(x => String(x.id) === id);
  const payload = { case_id: c.id, status: form.elements.status.value, contact_method: form.elements.method.value, note: form.elements.note.value.trim() };
  if (curators.serverMissing) {
    toast('Не сохранено: журнал кураторов ещё не подключён на сервере.');
    return;
  }
  const button = form.querySelector('.btn-primary');
  button.disabled = true;
  try {
    const updated = await callJournal('curator_case_update', payload);
    Object.assign(c, updated);
    curators.open = null;
    updateCuratorBadge();
    renderCurators();
    toast('Сохранено: ' + displayName(c.student_name) + ' — ' + statusLabel(c.status).toLowerCase());
  } catch (error) {
    toast('Не удалось сохранить. ' + error.message);
  } finally {
    button.disabled = false;
  }
}

$('#curators-view').addEventListener('click', event => {
  const b = event.target.closest('button');
  if (!b) return;
  if (b.dataset.cweek !== undefined) {
    const weeks = [...new Set(curators.cases.map(c => c.week_start))].sort().reverse();
    curators.week = weeks[Number(b.dataset.cweek)] || curators.week; curators.open = null; renderCurators();
  } else if (b.dataset.cstatus) { curators.status = b.dataset.cstatus; renderCurators(); }
  else if (b.dataset.caseOpen) { curators.open = b.dataset.caseOpen; renderCurators(); }
  else if (b.hasAttribute('data-case-close')) { curators.open = null; renderCurators(); }
  else if (b.dataset.setStatus) {
    const form = b.closest('form');
    form.elements.status.value = b.dataset.setStatus;
    form.querySelectorAll('[data-set-status]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  } else if (b.dataset.caseStudent) {
    const c = curators.cases.find(x => String(x.id) === b.dataset.caseStudent), found = c && findStudentSheet(c);
    if (found) openStudentCard(found.sheet, found.row);
  }
});
$('#curators-view').addEventListener('submit', event => {
  const form = event.target.closest('[data-case-form]');
  if (!form) return;
  event.preventDefault();
  saveCase(form.dataset.caseForm, form);
});
$('#curators-view').addEventListener('change', event => {
  if (event.target.id === 'curator-group') { curators.group = event.target.value; renderCurators(); }
});
