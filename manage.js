'use strict';
/* Управление журналом (для администраторов): ученики, сотрудники, история действий. */

const adminEl = id => document.getElementById(id);
const actionNames = {
  registration: 'Регистрация', access: 'Изменение доступа', mark: 'Отметка', legacy: 'До переноса',
  invite: 'Приглашение', add: 'Добавление ученика', archive: 'Архивирование', restore: 'Восстановление',
};
let activePanel = 'roster', studentsForGroup = [], historyCursor = null, viewTicket = 0;
const rosterState = { version: -1, rows: [], originals: new Map(), ticket: 0 };

/** Применяет изменения состава классов (добавленные и архивные ученики) к листам журнала. */
function applyRoster(changes) {
  if (!changes.rows || changes.version < rosterState.version) return false;
  rosterState.rows = changes.rows;
  const bySheet = new Map();
  for (const row of changes.rows) {
    if (!bySheet.has(row.sheet)) bySheet.set(row.sheet, []);
    bySheet.get(row.sheet).push(row);
  }
  for (const sheet of app.journals) {
    if (!rosterState.originals.has(sheet.id)) rosterState.originals.set(sheet.id, sheet.students);
    const base = rosterState.originals.get(sheet.id), edits = bySheet.get(sheet.id) || [];
    const inactive = new Set(edits.filter(row => !row.active).map(row => row.row));
    sheet.students = base.filter(student => !inactive.has(student.row))
      .concat(edits.filter(row => row.added && row.active).map(row => ({ name: row.name, row: row.row, dailyRow: row.dailyRow, added: true })))
      .sort((a, b) => a.row - b.row);
  }
  rosterState.version = changes.version;
  if (app.active && !app.active.sheet.students.some(student => student.row === app.active.row)) {
    if (adminEl('mark-dialog').open) adminEl('mark-dialog').close();
    app.active = null;
  }
  return true;
}
async function refreshRoster() {
  const result = await callJournal('masters_roster_delta', { known_version: rosterState.version });
  return applyRoster(result);
}

function element(tag, value, css) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (css) node.className = css;
  return node;
}
function actionButton(label, callback, css = 'btn') {
  const b = element('button', label, css);
  b.type = 'button';
  b.onclick = () => perform(b, callback);
  return b;
}
function line(title, detail) {
  const row = element('div', undefined, 'manage-row'), body = element('div', undefined, 'manage-text');
  body.append(element('strong', title));
  if (detail) body.append(element('small', detail));
  row.append(body);
  return row;
}
function note(text) { adminEl('admin-message').textContent = text; }
async function perform(button, operation) {
  button.disabled = true; note('');
  try { await operation(); } catch (error) { note(error.message); } finally { button.disabled = false; }
}
const groupValue = () => adminEl('manage-group').value;

function renderStudents() {
  const list = adminEl('manage-students'), needle = normalizeText(adminEl('roster-filter').value);
  const active = adminEl('roster-mode').value === 'active';
  list.replaceChildren();
  const matches = studentsForGroup.filter(x => x.active === active && (normalizeText(x.name).includes(needle) || personName(x.name).key.includes(needle)))
    .sort((a, b) => byName(a.name, b.name));
  for (const student of matches) {
    const row = line(displayName(student.name));
    row.append(actionButton(active ? 'В архив' : 'Восстановить', async () => {
      const group = groupValue(), task = active ? 'archive' : 'restore';
      if (active && !window.confirm('Переместить в архив: ' + displayName(student.name) + ' · ' + group + '? Прежние отметки сохранятся.')) return;
      await editRoster(group, student.name, task);
    }));
    list.append(row);
  }
  if (!list.childElementCount) list.append(element('p', active ? 'В списке нет подходящих учеников.' : 'Архив пуст или совпадений нет.', 'muted'));
}

async function loadRosterPanel() {
  const ticket = ++viewTicket;
  const data = await callJournal('masters_roster_list', { group_name: groupValue() || null });
  if (ticket !== viewTicket) return;
  const select = adminEl('manage-group');
  if (!select.options.length) {
    for (const name of data.groups.sort(sortRu)) select.add(new Option(name, name));
    const s = currentSheet();
    if (s) {
      const wanted = s.kind === 'exam' ? [s.exam, s.subject, s.cls].filter(Boolean).join(' · ') : s.cls;
      if (data.groups.includes(wanted)) select.value = wanted;
    }
    if (select.value) return loadRosterPanel();
  }
  studentsForGroup = data.students;
  renderStudents();
}

async function editRoster(group, name, task) {
  const affected = await callJournal('masters_roster_edit', { group_name: group, student_name: name, task });
  await refreshRoster();
  renderAll();
  await loadRosterPanel();
  note('Обновлено листов: ' + affected + '.');
}

async function loadAccounts() {
  const ticket = ++viewTicket, profiles = await callJournal('masters_account_list');
  if (ticket !== viewTicket) return;
  const list = adminEl('manage-accounts');
  list.replaceChildren();
  const roleName = r => (r === 'admin' ? 'Администратор' : 'Пользователь');
  for (const profile of profiles) {
    const status = { pending: 'Ожидает решения', active: 'Доступ открыт', blocked: 'Доступ закрыт' }[profile.status];
    const row = line(profile.email, status + ' · ' + (profile.status === 'pending' ? 'Запрос: ' + roleName(profile.requested_role) : roleName(profile.role)));
    if (profile.user_id !== staffId) {
      const controls = element('div', undefined, 'manage-actions'), role = element('select');
      role.setAttribute('aria-label', 'Роль для ' + profile.email);
      role.add(new Option('Пользователь', 'user'));
      role.add(new Option('Администратор', 'admin'));
      role.value = profile.status === 'pending' ? profile.requested_role : profile.role;
      const update = async status => {
        if ((status === 'blocked' || role.value === 'admin') && !window.confirm(profile.email + ' · ' + (status === 'blocked' ? 'закрыть доступ' : 'предоставить права администратора') + '?')) return;
        await callJournal('masters_account_edit', { target_user: profile.user_id, new_status: status, new_role: role.value });
        await loadAccounts();
        note('Доступ обновлён.');
      };
      controls.append(role, actionButton(profile.status === 'active' ? 'Сохранить роль' : 'Открыть доступ', () => update('active'), 'btn btn-primary'));
      if (profile.status !== 'blocked') controls.append(actionButton('Закрыть доступ', () => update('blocked')));
      row.append(controls);
    }
    list.append(row);
  }
}

async function loadHistory(append = false) {
  const ticket = ++viewTicket, list = adminEl('manage-history');
  const entries = await callJournal('masters_audit_page', {
    before_id: append ? historyCursor : null,
    filter_action: adminEl('action-filter').value || null,
    filter_actor: adminEl('actor-filter').value.trim() || null,
  });
  if (ticket !== viewTicket) return;
  if (!append) list.replaceChildren();
  for (const e of entries) {
    const row = line(actionNames[e.action] || e.action, new Date(e.occurred_at).toLocaleString('ru-RU') + ' · ' + e.actor);
    row.firstChild.append(element('p', e.detail));
    list.append(row);
  }
  if (!list.childElementCount) list.append(element('p', 'Записей по этим условиям нет.', 'muted'));
  historyCursor = entries.at(-1)?.id ?? null;
  adminEl('history-next').hidden = entries.length < 50;
}

async function showPanel(name) {
  activePanel = name; note('');
  $$('#admin-panel [data-view]').forEach(el => { el.hidden = el.dataset.view !== name; });
  $$('[data-panel]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.panel === name)));
  if (name === 'roster') await loadRosterPanel();
  else if (name === 'accounts') await loadAccounts();
  else if (name === 'import') { const box = adminEl('import-panel'); box.innerHTML = importPanelHTML(false); bindImportForm(box); }
  else await loadHistory();
}

$$('[data-open-manage]').forEach(b => b.addEventListener('click', () => {
  adminEl('more-dialog').close();
  adminEl('admin-panel').showModal();
  showPanel(activePanel).catch(e => note(e.message));
}));
adminEl('admin-close').onclick = () => adminEl('admin-panel').close();
$$('[data-panel]').forEach(b => { b.onclick = () => showPanel(b.dataset.panel).catch(e => note(e.message)); });
adminEl('manage-group').onchange = () => loadRosterPanel().catch(e => note(e.message));
adminEl('roster-filter').oninput = adminEl('roster-mode').onchange = renderStudents;
adminEl('student-add').onsubmit = event => {
  event.preventDefault();
  const form = event.currentTarget;
  perform(form.querySelector('button'), async () => { await editRoster(groupValue(), form.elements.name.value.trim(), 'add'); form.reset(); });
};
adminEl('history-filter').onsubmit = event => { event.preventDefault(); loadHistory().catch(e => note(e.message)); };
adminEl('history-next').onclick = event => perform(event.currentTarget, () => loadHistory(true));

adminEl('issue-invite').onsubmit = event => {
  event.preventDefault();
  const form = event.currentTarget;
  adminEl('issued-invite').hidden = true;
  adminEl('invite-url').value = '';
  perform(form.querySelector('button'), async () => {
    if (DEMO_MODE) throw new Error('В демо-режиме приглашения не отправляются.');
    const email = form.elements.email.value.trim();
    const { data, error } = await journalCloud.functions.invoke('masters-invite', { body: { email } });
    if (error) {
      let detail;
      try { detail = (await error.context.json()).error; } catch {}
      throw new Error(detail || 'Не удалось создать ссылку. Попробуйте снова.');
    }
    adminEl('invite-url').value = data.link;
    adminEl('issued-invite').hidden = false;
    note('Ссылка создана для ' + email + '. Передайте её лично сотруднику. После первого входа одобрите заявку.');
  });
};
adminEl('invite-copy').onclick = () => perform(adminEl('invite-copy'), async () => {
  const input = adminEl('invite-url');
  input.select();
  try { await navigator.clipboard.writeText(input.value); note('Ссылка скопирована.'); } catch { note('Ссылка выделена. Скопируйте её вручную.'); }
});
if (!INVITES_ENABLED && !DEMO_MODE) adminEl('issue-invite').hidden = true;
adminEl('admin-panel').addEventListener('close', () => { adminEl('invite-url').value = ''; adminEl('issued-invite').hidden = true; });
