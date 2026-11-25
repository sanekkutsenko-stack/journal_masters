'use strict';
/*
 * Данные журнала и синхронизация с сервером.
 * Отметки — это правки ячеек исходной книги Excel: ключ «Лист!B7» → значение.
 * Изменения копятся в очереди (и в localStorage), отправляются пачками и
 * переживают потерю связи. Формат данных и вызовы сервера не менялись.
 */

const app = {
  kind: 'primary', quarter: 'II', group: '', journal: '', week: 0, day: '',
  view: 'journal', patches: {}, journals: [], active: null, source: null,
  dirty: false, storageOkay: true, fingerprint: null, importInfo: null,
};
const sync = { queue: [], revision: 0, sending: false, polling: false, ready: false, timer: null };

const queueStorage = () => 'masters-journal-queue:' + staffId;
const cellKey = (sheet, ref) => sheet + '!' + ref;
const sheetById = id => app.journals.find(s => s.id === id);

function raw(sheet, ref) {
  const id = cellKey(sheet.id, ref);
  if (Object.hasOwn(app.patches, id)) return { value: app.patches[id], manual: true };
  return sheet.cells[ref] || { value: null };
}

/** Проведён ли урок в столбце j (строка 3 «Урок проведён?» или расписание начальной школы). */
function lessonDone(sheet, j) {
  if (sheet.kind === 'primarySubject') {
    const parent = sheetById(sheet.dailyId);
    return String(raw(parent, column(j + 2) + sheet.scheduleRow).value || '').toLowerCase() === 'да';
  }
  const top = String(raw(sheet, column(j + 2) + '3').value || '').trim().toLowerCase();
  if (top === 'да') return true;
  if (sheet.kind === 'primary' && top !== 'нет') {
    return (sheet.schedule || []).some(item => String(raw(sheet, column(j + 2) + item.row).value || '').toLowerCase() === 'да');
  }
  return false;
}

/** Итоговая отметка ученика за урок j с учётом формул книги и дневной отметки началки. */
function markValue(sheet, student, j) {
  const entry = raw(sheet, column(j + 2) + student.row);
  if (entry.formula || (student.added && !entry.manual)) {
    if (!lessonDone(sheet, j)) return '';
    if (sheet.kind === 'primarySubject' && student.dailyRow) {
      const parent = sheetById(sheet.dailyId);
      const dailyStudent = parent?.students.find(p => p.row === student.dailyRow);
      const daily = dailyStudent ? markValue(parent, dailyStudent, j) : '';
      return daily && daily !== 'см. урок' ? daily : 'П';
    }
    return 'П';
  }
  return String(entry.value ?? '');
}

function persistQueue() {
  app.dirty = true;
  if (DEMO_MODE) { syncStatus(); return; }
  try {
    localStorage.setItem(queueStorage(), JSON.stringify({
      queue: sync.queue, fingerprint: app.fingerprint, importId: app.importInfo?.id,
      selection: { kind: app.kind, quarter: app.quarter, group: app.group, journal: app.journal, day: app.day },
    }));
    app.storageOkay = true;
  } catch {
    app.storageOkay = false;
  }
  syncStatus();
}

function syncStatus(message, detail) {
  const pending = sync.queue.length;
  const state = message ? 'warn' : pending ? 'busy' : 'ok';
  const text = message || (pending ? 'Сохраняем…' : DEMO_MODE ? 'Демо: без сервера' : 'Сохранено');
  const hint = detail || (pending
    ? pending + ' ' + plural(pending, 'изменение ожидает', 'изменения ожидают', 'изменений ожидают') + ' отправки'
    : DEMO_MODE ? 'Изменения видны только в этой вкладке' : 'Доступно с ваших устройств');
  $$('[data-sync]').forEach(el => {
    el.dataset.state = state;
    el.querySelector('[data-sync-text]').textContent = text;
    el.title = hint;
  });
}

function queueChange(key, value, deleted = false) {
  sync.queue.push({ id: crypto.randomUUID(), key, value, deleted });
  if (deleted) delete app.patches[key]; else app.patches[key] = value;
  persistQueue();
  clearTimeout(sync.timer);
  sync.timer = setTimeout(flushChanges, 200);
}

/** Ключ ячейки, в которую на самом деле пишется правка (подтверждение предмета началки — в дневной лист). */
function patchTarget(sheet, ref) {
  if (sheet.kind === 'primarySubject' && /^[A-Z]+3$/.test(ref)) {
    const parent = sheetById(sheet.dailyId);
    return cellKey(parent.id, ref.match(/^[A-Z]+/)[0] + sheet.scheduleRow);
  }
  return cellKey(sheet.id, ref);
}
function patch(sheet, ref, value) {
  queueChange(patchTarget(sheet, ref), value);
}
/** Снимок ячейки, чтобы можно было отменить правку. */
function snapshotCell(sheet, ref) {
  const key = patchTarget(sheet, ref);
  return { key, had: Object.hasOwn(app.patches, key), value: app.patches[key] };
}
function restoreCell(snapshot) {
  if (snapshot.had) queueChange(snapshot.key, snapshot.value);
  else queueChange(snapshot.key, null, true);
}

async function flushChanges() {
  if (sync.sending || !sync.ready || !sync.queue.length) return;
  sync.sending = true;
  const operations = sync.queue.filter(op => !archivedOperation(op)).slice(0, 100);
  if (!operations.length) { sync.sending = false; syncStatus('Есть правки архивного ученика'); return; }
  try {
    const result = await callJournal('attendance_save', { operations });
    const accepted = new Set(result.accepted);
    sync.queue = sync.queue.filter(op => !accepted.has(op.id));
    persistQueue();
    await pollChanges();
  } catch (error) {
    syncStatus('Ждём соединения', error.message);
  } finally {
    sync.sending = false;
    if (sync.queue.some(op => !archivedOperation(op))) { clearTimeout(sync.timer); sync.timer = setTimeout(flushChanges, 2000); }
  }
}

async function pollChanges() {
  if (sync.polling || !sync.ready) return;
  sync.polling = true;
  try {
    const [result, rosterChanged] = await Promise.all([
      callJournal('attendance_changes', { since_id: sync.revision }),
      refreshRoster(),
    ]);
    const pending = new Set(sync.queue.map(op => op.key));
    for (const event of result.events) {
      if (pending.has(event.cell_key)) continue;
      if (event.is_deleted) delete app.patches[event.cell_key]; else app.patches[event.cell_key] = event.cell_value;
    }
    sync.revision = result.revision;
    if (result.events.length || rosterChanged) renderAll();
    if (rosterChanged && adminEl('admin-panel').open && activePanel === 'roster') loadRosterPanel().catch(e => note(e.message));
    if (!sync.queue.length) syncStatus();
  } catch {
    if (!sync.queue.length) syncStatus('Соединение прервано');
  } finally {
    sync.polling = false;
  }
}

/** Правка относится к ученику в архиве — такие не отправляем. */
function archivedOperation(op) {
  if (!rosterState.rows.length) return false;
  const i = op.key.lastIndexOf('!'), sheet = op.key.slice(0, i), row = Number(op.key.slice(i + 1).match(/\d+$/)?.[0]);
  return rosterState.rows.some(item => !item.active && item.sheet === sheet && item.row === row);
}
