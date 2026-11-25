'use strict';
/*
 * Демо-режим: открывается по адресу ?demo. Работает без сервера и входа,
 * на вымышленных классах и учениках. Изменения живут только в этой вкладке.
 */
const DEMO_MODE = new URLSearchParams(location.search).has('demo');

const demoBackend = DEMO_MODE ? (() => {
  // Детерминированный генератор, чтобы данные демо не менялись между перезагрузками.
  let seed = 20261125;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

  const firstNames = ['Алиса', 'Богдан', 'Вера', 'Глеб', 'Дарья', 'Егор', 'Злата', 'Илья', 'Ксения', 'Лев', 'Мирон', 'Ника', 'Олег', 'Полина', 'Роман', 'София', 'Тимур', 'Ульяна', 'Фёдор', 'Яна', 'Семён', 'Алёна'];
  const lastNames = ['Воронцов', 'Ермаков', 'Лебедев', 'Никитин', 'Орлов', 'Соколов', 'Тихонов', 'Фролов', 'Белов', 'Марков', 'Сафонов', 'Зуев', 'Громов', 'Ковалёв', 'Морозов', 'Панов', 'Руденко', 'Чернов', 'Шилов', 'Яшин', 'Котов', 'Федосеев'];
  const female = new Set(['Алиса', 'Вера', 'Дарья', 'Злата', 'Ксения', 'Ника', 'Полина', 'София', 'Ульяна', 'Яна', 'Алёна']);
  function makeNames(count) {
    const used = new Set(), list = [];
    while (list.length < count) {
      const first = firstNames[Math.floor(random() * firstNames.length)];
      let last = lastNames[Math.floor(random() * lastNames.length)];
      if (female.has(first) && !last.endsWith('о')) last += 'а';
      const name = first + ' ' + last;
      if (!used.has(name)) { used.add(name); list.push(name); }
    }
    return list.sort((a, b) => a.split(' ')[1].localeCompare(b.split(' ')[1], 'ru'));
  }

  function weekdays(from, to, skip = []) {
    const dates = [], d = isoDate(from), end = isoDate(to);
    while (d <= end) {
      const iso = d.toISOString().slice(0, 10), day = d.getUTCDay();
      if (day >= 1 && day <= 5 && !skip.includes(iso)) dates.push(iso);
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return dates;
  }
  const quarterDates = {
    II: weekdays('2026-11-05', '2026-12-25', []),
    III: weekdays('2027-01-11', '2027-03-19', ['2027-02-23', '2027-03-08']),
    IV: weekdays('2027-03-30', '2027-05-22', ['2027-05-01', '2027-05-11']),
  };
  const today = localToday();

  const journals = [], patches = {};
  // Профиль ученика: склонность к пропускам, чтобы в статистике была «зона риска».
  const studentRisk = new Map();
  function riskOf(name) {
    if (!studentRisk.has(name)) {
      const r = random();
      studentRisk.set(name, r < 0.1 ? 0.22 : r < 0.25 ? 0.1 : 0.03);
    }
    return studentRisk.get(name);
  }
  function rollMark(name) {
    const risk = riskOf(name), r = random();
    if (r < risk * 0.55) return 'НП';
    if (r < risk) return 'УП';
    if (r < risk + 0.03) return 'оп';
    if (r < risk + 0.045) return 'вк';
    if (r < risk + 0.05) return 'тел';
    return null;
  }

  function addSheet(sheet, fill) {
    const cells = {};
    sheet.students.forEach(student => {
      sheet.dates.forEach((_, j) => { cells[column(j + 2) + student.row] = { value: null, formula: '=IF(B3="Да","П","")' }; });
    });
    sheet.cells = cells;
    journals.push(sheet);
    if (fill) fill(sheet);
  }

  // Начальная школа: дневной лист + предметные листы.
  const primarySubjects = ['Русский язык', 'Математика', 'Окружающий мир', 'Литературное чтение'];
  for (const cls of ['1А', '1Б', '2А', '3А', '4А']) {
    const names = makeNames(10 + Math.floor(random() * 6));
    for (const [quarter, dates] of Object.entries(quarterDates)) {
      const id = 'Класс-' + cls + ' · ' + quarter;
      const students = names.map((name, i) => ({ name, row: 5 + i }));
      const scheduleStart = 5 + names.length + 3;
      const schedule = primarySubjects.map((label, i) => ({ label, row: scheduleStart + i, target: label + '-' + cls + ' · ' + quarter }));
      addSheet({ id, title: 'Класс ' + cls, kind: 'primary', cls, quarter, subject: 'Общий день', exam: '', dates, students, schedule }, sheet => {
        sheet.dates.forEach((date, j) => {
          if (date > today || quarter !== 'II') return;
          const col = column(j + 2);
          const done = !(date === today) && random() > 0.04;
          if (done) {
            patches[id + '!' + col + '3'] = 'Да';
            schedule.forEach(item => { if (random() > 0.25) patches[id + '!' + col + item.row] = 'Да'; });
            students.forEach(student => {
              const mark = rollMark(student.name);
              if (mark) patches[id + '!' + col + student.row] = mark;
            });
          }
        });
      });
      schedule.forEach(item => {
        addSheet({
          id: item.target, title: item.label + ' • ' + cls, kind: 'primarySubject', cls, quarter, subject: item.label, exam: '',
          dates, students: names.map((name, i) => ({ name, row: 5 + i, dailyRow: 5 + i })), schedule: [], dailyId: id, scheduleRow: item.row,
        });
      });
    }
  }

  // Классы 5–11 по предметам.
  const subjects = ['Алгебра', 'Русский язык', 'История', 'Физика', 'Английский язык'];
  for (const cls of ['5А', '6А', '7Б', '8А', '9А', '10А', '11А']) {
    const names = makeNames(12 + Math.floor(random() * 8));
    const picked = subjects.filter(() => random() > 0.25).slice(0, 4);
    for (const subject of picked.length ? picked : subjects.slice(0, 2)) {
      for (const [quarter, all] of Object.entries(quarterDates)) {
        const dates = all.filter((_, i) => i % 5 !== 2 && i % 5 !== 4); // три урока в неделю
        const id = subject + '-' + cls + ' · ' + quarter;
        addSheet({ id, title: subject + '. ' + cls, kind: 'class', cls, quarter, subject, exam: '', dates, students: names.map((name, i) => ({ name, row: 5 + i })), schedule: [] }, sheet => {
          sheet.dates.forEach((date, j) => {
            if (date >= today || quarter !== 'II' || random() < 0.05) return;
            const col = column(j + 2);
            patches[id + '!' + col + '3'] = 'Да';
            sheet.students.forEach(student => { const mark = rollMark(student.name); if (mark) patches[id + '!' + col + student.row] = mark; });
          });
        });
      }
    }
  }

  // Подготовка к экзаменам.
  for (const [exam, subject] of [['ОГЭ', 'Математика'], ['ОГЭ', 'Русский язык'], ['ЕГЭ', 'Профильная математика'], ['ЕГЭ', 'Обществознание']]) {
    const names = makeNames(8 + Math.floor(random() * 6));
    for (const [quarter, all] of Object.entries(quarterDates)) {
      const dates = all.filter((_, i) => i % 5 === 1 || i % 5 === 3);
      const id = exam + '-' + subject + ' · ' + quarter;
      addSheet({ id, title: subject, kind: 'exam', cls: '', quarter, subject, exam, dates, students: names.map((name, i) => ({ name, row: 5 + i })), schedule: [] }, sheet => {
        sheet.dates.forEach((date, j) => {
          if (date >= today || quarter !== 'II') return;
          const col = column(j + 2);
          patches[id + '!' + col + '3'] = 'Да';
          sheet.students.forEach(student => { const mark = rollMark(student.name); if (mark) patches[id + '!' + col + student.row] = mark; });
        });
      });
    }
  }

  // Ростер в формате masters_roster_delta: изменения относительно исходной книги.
  const roster = { version: 1, rows: [] };
  const events = [];
  let revision = 0;

  function groupName(sheet) { return sheet.kind === 'exam' ? [sheet.exam, sheet.subject].join(' · ') : sheet.cls; }
  function sheetsOfGroup(group) { return journals.filter(sheet => groupName(sheet) === group); }

  const curatorCases = [];
  const demoNotes = [
    ['Звонок', 'Мама в курсе, ребёнок болел. Справку принесут в понедельник.'],
    ['Сообщение', 'Написали в мессенджер, отец обещал проследить за подключением к урокам.'],
    ['Встреча', 'Поговорили на родительском собрании, договорились созвониться через неделю.'],
  ];
  const handlers = {
    curator_cases_list: ({ since }) => curatorCases.filter(c => !since || c.week_start >= since).map(c => ({ ...c })),
    curator_cases_add: ({ cases }) => {
      const lastWeek = (() => { const d = isoDate(weekStart(today)); d.setUTCDate(d.getUTCDate() - 7); return d.toISOString().slice(0, 10); })();
      const added = [];
      for (const c of cases) {
        if (curatorCases.some(x => x.week_start === c.week_start && x.kind === c.kind && x.group_name === c.group_name && x.student_name === c.student_name)) continue;
        const row = { ...c, id: curatorCases.length + 1, status: 'new', contact_method: '', note: '', updated_at: null, updated_by: '' };
        if (c.week_start < lastWeek) {
          const [method, note] = demoNotes[Math.floor(random() * demoNotes.length)];
          Object.assign(row, { status: random() > 0.3 ? 'resolved' : 'contacted', contact_method: method, note, updated_at: isoDate(c.week_start).toISOString(), updated_by: 'curator@sotvorchestvo.example' });
        }
        curatorCases.push(row);
        added.push({ ...row });
      }
      return added;
    },
    curator_case_update: ({ case_id, status, contact_method, note }) => {
      const row = curatorCases.find(c => c.id === case_id);
      if (!row) throw new Error('Запись не найдена.');
      Object.assign(row, { status, contact_method, note, updated_at: new Date().toISOString(), updated_by: 'demo@sotvorchestvo.example' });
      return { ...row };
    },
    masters_session_info: () => ({ status: 'active', role: 'admin' }),
    attendance_state: () => ({ patches: { ...patches }, fingerprint: 'demo-1', importInfo: null, revision }),
    attendance_save: ({ operations }) => {
      for (const op of operations) {
        revision++;
        events.push({ id: revision, cell_key: op.key, cell_value: op.value, is_deleted: op.deleted });
      }
      return { accepted: operations.map(op => op.id) };
    },
    attendance_changes: ({ since_id }) => ({ events: events.filter(e => e.id > since_id), revision }),
    masters_roster_delta: ({ known_version }) => (known_version === roster.version ? { version: roster.version } : { ...roster, rows: roster.rows.map(r => ({ ...r })) }),
    masters_roster_list: ({ group_name }) => {
      const groups = [...new Set(journals.map(groupName))];
      const group = group_name || null;
      if (!group) return { groups, students: [] };
      const sheet = sheetsOfGroup(group)[0];
      const archived = roster.rows.filter(r => r.sheet === sheet.id && !r.active).map(r => r.name);
      const base = rosterOriginalNames(sheet);
      const added = roster.rows.filter(r => r.sheet === sheet.id && r.added && r.active).map(r => r.name);
      const students = [...base.filter(n => !archived.includes(n)), ...added].map(name => ({ name, active: true }))
        .concat(archived.map(name => ({ name, active: false })));
      return { groups, students };
    },
    masters_roster_edit: ({ group_name, student_name, task }) => {
      const sheets = sheetsOfGroup(group_name);
      for (const sheet of sheets) {
        const existing = roster.rows.find(r => r.sheet === sheet.id && r.name === student_name);
        if (task === 'add') {
          if (existing) { existing.active = true; continue; }
          const base = rosterState.originals.get(sheet.id) || sheet.students;
          const maxRow = Math.max(...base.map(s => s.row), ...roster.rows.filter(r => r.sheet === sheet.id).map(r => r.row));
          roster.rows.push({ sheet: sheet.id, row: maxRow + 1, name: student_name, active: true, added: true });
        } else {
          const original = (rosterState.originals.get(sheet.id) || sheet.students).find(s => s.name === student_name);
          if (existing) existing.active = task === 'restore';
          else if (original) roster.rows.push({ sheet: sheet.id, row: original.row, name: student_name, active: task === 'restore', added: false });
        }
      }
      roster.version++;
      return sheets.length;
    },
    masters_account_list: () => ([
      { user_id: 'demo', email: 'demo@sotvorchestvo.example', status: 'active', role: 'admin', requested_role: 'admin' },
      { user_id: 'u2', email: 'teacher@sotvorchestvo.example', status: 'active', role: 'user', requested_role: 'user' },
      { user_id: 'u3', email: 'new.master@sotvorchestvo.example', status: 'pending', role: 'user', requested_role: 'user' },
    ]),
    masters_account_edit: () => true,
    masters_audit_page: () => ([
      { id: 3, action: 'mark', occurred_at: new Date().toISOString(), actor: 'demo@sotvorchestvo.example', detail: 'Демо: изменения в этом режиме не сохраняются.' },
      { id: 2, action: 'add', occurred_at: new Date(Date.now() - 864e5).toISOString(), actor: 'demo@sotvorchestvo.example', detail: 'Добавлен ученик в 3А' },
    ]),
  };
  function rosterOriginalNames(sheet) {
    return (rosterState.originals.get(sheet.id) || sheet.students).map(s => s.name);
  }

  return {
    async call(procedure, args = {}) {
      await new Promise(resolve => setTimeout(resolve, 60));
      const handler = handlers[procedure];
      if (!handler) throw new Error('В демо-режиме это действие недоступно.');
      return handler(args);
    },
    asset(name) {
      if (name === 'journal') return new Response(JSON.stringify({ journals }));
      throw new Error('В демо-режиме исходной книги Excel нет. Выгрузите отчёт из раздела «Статистика».');
    },
  };
})() : null;
