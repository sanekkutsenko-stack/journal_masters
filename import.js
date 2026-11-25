'use strict';
/*
 * Загрузка книги Excel администратором.
 * Книга разбирается прямо в браузере: дневные листы начальной школы, предметные
 * листы началки (связаны с дневными через ссылки в расписании), классы 5–11 и
 * экзаменационные группы. Исходная книга и собранный журнал кладутся в закрытое
 * хранилище Supabase, а описание листов — в базу (для управления списками).
 */

const QUARTER_OF = name => (name.endsWith(' · III') ? 'III' : name.endsWith(' · IV') ? 'IV' : 'II');
const rowOf = ref => Number(ref.match(/\d+$/)[0]);
const colIndex = ref => { let n = 0; for (const ch of ref.match(/^[A-Z]+/)[0]) n = n * 26 + ch.charCodeAt(0) - 64; return n; };

/** Разбирает один лист журнала. Возвращает null, если это не журнал. */
async function readJournalSheet(zip, meta, name, path) {
  const doc = parseXML(await zip.file(path).async('string'));
  const nodes = all(doc, 'c'), lookup = new Map(nodes.map(c => [c.getAttribute('r'), c]));
  const value = ref => (lookup.has(ref) ? cellText(lookup.get(ref), meta.strings) : '');
  if (value('A4') !== 'ФИО / дата') return null;
  const primary = name.startsWith('Класс-');
  if (!primary && value('A3') !== 'Урок проведён?') return null;

  const dates = [];
  for (let j = 2; j < 120; j++) {
    const v = Number(value(column(j) + '4'));
    if (!v || v < 40000 || v > 60000) break;
    dates.push(new Date((v - 25569) * 86400000).toISOString().slice(0, 10));
  }
  if (!dates.length) return null;

  const hiddenRows = new Set(all(doc, 'row').filter(r => r.getAttribute('hidden') === '1').map(r => Number(r.getAttribute('r'))));
  let end;
  if (primary) {
    const marker = nodes.filter(c => /^A\d+$/.test(c.getAttribute('r'))).find(c => /^УП \/ НП/.test(cellText(c, meta.strings)));
    end = marker ? rowOf(marker.getAttribute('r')) - 1 : 0;
  } else {
    end = Number(first(doc, 'autoFilter')?.getAttribute('ref')?.match(/\d+$/)?.[0]);
  }
  if (!end) return null;
  const students = [];
  for (let row = 5; row <= end; row++) {
    const person = value('A' + row).trim();
    if (person && !hiddenRows.has(row)) students.push({ name: person, row });
  }
  if (!students.length) return null;

  const schedule = [];
  if (primary) {
    for (const link of all(doc, 'hyperlink')) {
      const ref = link.getAttribute('ref'), location = link.getAttribute('location') || '';
      if (!/^A\d+$/.test(ref) || rowOf(ref) <= students.at(-1).row) continue;
      const target = location.match(/^'([^']+)'!/);
      if (target && meta.mapping[target[1]]) schedule.push({ row: rowOf(ref), label: value(ref), target: target[1] });
    }
  }

  // В журнал берём только нужные ячейки: строку 3, строки учеников и расписания, столбцы дат.
  const keepRows = new Set([3, ...students.map(s => s.row), ...schedule.map(s => s.row)]);
  const lastCol = dates.length + 1;
  const cells = {};
  let maxRow = end;
  for (const c of nodes) {
    const ref = c.getAttribute('r'), row = rowOf(ref);
    if (row > maxRow) maxRow = row;
    const col = colIndex(ref);
    if (!keepRows.has(row) || col < 2 || col > lastCol) continue;
    const f = first(c, 'f');
    const text = cellText(c, meta.strings);
    if (f) cells[ref] = { value: null, formula: '=' + (f.textContent || 'shared'), cached: text };
    else if (text !== '') cells[ref] = { value: text };
  }

  const match = name.match(/-(\d+[А-ЯA-Z]+)(?: · (II|III|IV))?$/);
  const title = value('B1');
  const exam = name.startsWith('ОГЭ-') ? 'ОГЭ' : name.startsWith('ЕГЭ-') ? 'ЕГЭ' : '';
  return {
    id: name, title, kind: primary ? 'primary' : exam ? 'exam' : 'class', cls: match?.[1] || '', quarter: QUARTER_OF(name),
    subject: primary ? 'Общий день' : title.split(' • ')[0].split('. ')[0], exam, dates, students, cells, schedule,
    nextRow: maxRow + 5,
  };
}

/** Собирает журнал из книги. onProgress(done, total) — для полосы прогресса. */
async function buildJournalFromWorkbook(buffer, onProgress = () => {}) {
  const zip = await JSZip.loadAsync(buffer), meta = await workbookMeta(zip);
  const entries = Object.entries(meta.mapping).filter(([, info]) => info.state !== 'hidden' && info.state !== 'veryHidden');
  const parsed = new Map();
  let done = 0;
  for (const [name, { path }] of entries) {
    const sheet = await readJournalSheet(zip, meta, name, path);
    if (sheet) parsed.set(name, sheet);
    if (++done % 20 === 0) { onProgress(done, entries.length); await new Promise(r => setTimeout(r)); }
  }
  onProgress(entries.length, entries.length);

  // Предметные листы началки: на них ссылается расписание дневного листа.
  const subjectOf = new Map();
  for (const sheet of parsed.values()) {
    if (sheet.kind !== 'primary') continue;
    for (const item of sheet.schedule) subjectOf.set(item.target, { daily: sheet, item });
  }
  const journals = [];
  for (const sheet of parsed.values()) {
    const link = subjectOf.get(sheet.id);
    if (link) {
      const byName = new Map(link.daily.students.map(s => [s.name, s.row]));
      journals.push({
        ...sheet, kind: 'primarySubject', cls: link.daily.cls, quarter: link.daily.quarter, subject: link.item.label || sheet.subject,
        dailyId: link.daily.id, scheduleRow: link.item.row,
        students: sheet.students.map(s => ({ ...s, dailyRow: byName.get(s.name) })),
      });
      continue;
    }
    // Как и раньше: предметные листы 1–4 классов без связи с дневным листом не показываем.
    if (sheet.kind === 'class' && sheet.cls && Number(sheet.cls.match(/\d+/)[0]) <= 4) continue;
    journals.push(sheet);
  }
  if (!journals.length) throw new Error('В файле не найдены журналы с ФИО и датами. Проверьте, что это книга журнала Мастеров.');

  let attendance = 0, lessons = 0;
  for (const s of journals) {
    const studentRows = new Set(s.students.map(st => st.row)), scheduleRows = new Set((s.schedule || []).map(i => i.row));
    for (const [ref, cell] of Object.entries(s.cells)) {
      const row = rowOf(ref), v = String(cell.value ?? '').toLowerCase();
      if (cell.formula) continue;
      if (studentRows.has(row) && v) attendance++;
      else if ((row === 3 || scheduleRows.has(row)) && v === 'да') lessons++;
    }
  }
  return { journals, stats: { sheets: journals.length, attendance, lessons } };
}

function rosterGroupOf(sheet) {
  return sheet.kind === 'exam' ? [sheet.exam, sheet.subject, sheet.cls].filter(Boolean).join(' · ') : sheet.cls;
}

async function gzipBlob(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

/** Полная загрузка: разбор → хранилище → база. */
async function importWorkbook(file, { clearMarks = false, onStatus = () => {} } = {}) {
  if (DEMO_MODE) throw new Error('В демо-режиме книга не загружается.');
  onStatus('Читаем книгу…');
  const buffer = await file.arrayBuffer();
  const fingerprint = await digest(buffer);
  const { journals, stats } = await buildJournalFromWorkbook(buffer, (d, t) => onStatus(`Разбираем листы: ${d} из ${t}…`));
  onStatus('Сжимаем журнал…');
  const journalBlob = await gzipBlob(JSON.stringify({ journals }));
  onStatus('Загружаем в хранилище…');
  const bucket = journalCloud.storage.from('journal');
  for (const [path, blob, type] of [
    ['workbook.xlsx', file, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['journal.json.gz', journalBlob, 'application/gzip'],
  ]) {
    const { error } = await bucket.upload(path, blob, { upsert: true, contentType: type, cacheControl: '0' });
    if (error) throw new Error('Не удалось загрузить в хранилище: ' + error.message);
  }
  onStatus('Сохраняем списки учеников…');
  const sheets = journals.map(s => ({
    id: s.id, grp: rosterGroupOf(s), kind: s.kind, quarter: s.quarter, daily_id: s.dailyId || null,
    students: s.students.map(st => ({ name: st.name, row: st.row })), next_row: s.nextRow,
  }));
  const importMeta = { id: fingerprint, fingerprint, sourceName: file.name, total: stats.sheets, attendance: stats.attendance, lessons: stats.lessons, importedAt: new Date().toISOString() };
  await callJournal('journal_import', { meta: importMeta, sheets, clear_marks: clearMarks });
  return stats;
}

/* ---------- Экран загрузки ---------- */
function importPanelHTML(firstRun) {
  const info = app.importInfo;
  return `
    ${firstRun ? '' : `<p class="muted small">Сейчас загружена книга: <b>${escapeHTML(info?.sourceName || '—')}</b>${info?.importedAt ? ' · ' + new Date(info.importedAt).toLocaleString('ru-RU') : ''}.</p>`}
    <p class="muted small">Выберите файл книги журнала (.xlsx). Книга сохранится в закрытом хранилище, ученики и отметки появятся у всех сотрудников.${firstRun ? '' : ' Отметки, поставленные в приложении, сохранятся, если не отметить пункт ниже.'}</p>
    <form class="import-form" data-import-form>
      <label class="file-drop"><input type="file" name="file" accept=".xlsx" required><span data-file-label>Выбрать файл Excel</span></label>
      ${firstRun ? '' : '<label class="check"><input type="checkbox" name="clear"> Начать с чистого листа: удалить отметки, поставленные в приложении, и изменения списков</label>'}
      <button class="btn btn-primary btn-wide">Загрузить книгу</button>
      <p class="form-message" data-import-status role="status" aria-live="polite"></p>
    </form>`;
}

function bindImportForm(root) {
  const form = root.querySelector('[data-import-form]');
  if (!form) return;
  form.elements.file.addEventListener('change', () => {
    form.querySelector('[data-file-label]').textContent = form.elements.file.files[0]?.name || 'Выбрать файл Excel';
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const file = form.elements.file.files[0];
    if (!file) return;
    if (form.elements.clear?.checked && !window.confirm('Удалить все отметки, поставленные в приложении, и изменения списков? Это нельзя отменить.')) return;
    const status = form.querySelector('[data-import-status]'), button = form.querySelector('button');
    button.disabled = true;
    try {
      const stats = await importWorkbook(file, { clearMarks: !!form.elements.clear?.checked, onStatus: text => { status.textContent = text; } });
      status.textContent = `Готово: ${stats.sheets} листов, ${stats.attendance} отметок. Обновляем журнал…`;
      try { localStorage.removeItem(queueStorage()); } catch {}
      setTimeout(() => location.reload(), 1200);
    } catch (error) {
      console.error(error);
      status.textContent = error.message;
      button.disabled = false;
    }
  });
}

/** Первый запуск: журнал ещё не загружен. */
function showEmptyJournal() {
  $('#load-title').textContent = staffRole === 'admin' ? 'Загрузите книгу журнала' : 'Журнал ещё не загружен';
  $('#load-description').textContent = staffRole === 'admin'
    ? 'Это новая база. Загрузите файл Excel с журналом — после этого классы, ученики и отметки появятся у всех сотрудников.'
    : 'Администратор ещё не загрузил книгу журнала. Загляните чуть позже.';
  if (staffRole !== 'admin') return;
  const box = document.createElement('section');
  box.className = 'auth-form';
  box.innerHTML = importPanelHTML(true);
  $('#welcome').append(box);
  bindImportForm(box);
}
