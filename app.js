'use strict';
/* Запуск: вход, загрузка журнала и восстановление очереди несохранённых правок. */

async function start() {
  try {
    if (!await openStaffSession()) return;
    const snapshot = await callJournal('attendance_state');
    if (!DEMO_MODE && !snapshot.fingerprint) { showEmptyJournal(); return; }
    const state = { ...await (await loadAsset('journal')).json(), ...snapshot };
    app.journals = state.journals;
    app.patches = state.patches;
    app.fingerprint = state.fingerprint;
    app.importInfo = state.importInfo;
    await refreshRoster();
    if (app.importInfo?.total) {
      $('#import-summary').hidden = false;
      $('#import-summary').textContent = 'Сверено с Excel · ' + app.importInfo.sourceName + ' · ' + app.importInfo.attendance + ' отметок учеников и ' + app.importInfo.lessons + ' подтверждений и записей расписания.';
    }
    sync.revision = state.revision;
    app.source = async () => (await loadAsset('workbook')).arrayBuffer();
    if (!DEMO_MODE) {
      try {
        const saved = JSON.parse(localStorage.getItem(queueStorage()) || 'null');
        if (saved?.fingerprint === app.fingerprint) {
          sync.queue = saved.queue || [];
          Object.assign(app, saved.selection || {});
          if (saved.importId !== app.importInfo?.id) app.day = '';
          for (const op of sync.queue) if (op.deleted) delete app.patches[op.key]; else app.patches[op.key] = op.value;
        }
      } catch {}
    }
    $$('[data-staff-only]').forEach(el => { el.hidden = false; });
    document.body.classList.add('is-loaded');
    sync.ready = true;
    selectJournal();
    persistQueue();
    maybeStartTour();
    syncCuratorCases().then(() => { if (app.view === 'curators') renderCurators(); }).catch(error => console.warn('Кураторы:', error));
    flushChanges();
    setInterval(() => { if (!document.hidden) pollChanges(); }, 5000);
    window.addEventListener('online', () => { flushChanges(); pollChanges(); });
  } catch (error) {
    console.error(error);
    $('#load-title').textContent = 'Не удалось открыть журнал';
    $('#load-description').textContent = error.message;
    $('#retry-load').hidden = false;
    toast(error.message);
  }
}

$$('[data-export]').forEach(b => b.addEventListener('click', () => { $('#more-dialog').close(); exportWorkbook(); }));
$('#retry-load').onclick = () => location.reload();
window.addEventListener('beforeunload', event => {
  if (sync.queue.length && !DEMO_MODE) { event.preventDefault(); event.returnValue = ''; }
});

window.journalApp = { app, markValue, lessonDone, parseImported, exportWorkbook, sync, flushChanges, pollChanges, sheetStats, riskStudents };
start();
