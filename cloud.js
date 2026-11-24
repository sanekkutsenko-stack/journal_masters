'use strict';
const journalCloud = supabase.createClient('https://wyckiwszpyvqdgfndshx.supabase.co', 'sb_publishable_v37PxTCAGa-f0I3kFshCFw_dQQry0am', {
  auth: { storage: sessionStorage, storageKey: 'masters-journal-auth' }
});
let staffId = null;

async function callJournal(procedure, args = {}) {
  const { data, error } = await journalCloud.rpc(procedure, args);
  if (error) throw new Error(error.message || 'Не удалось связаться с журналом.');
  if (data === null) throw new Error('У этой учётной записи пока нет доступа к журналу.');
  return data;
}

async function loadAsset(name) {
  const encoded = await callJournal('attendance_asset', { asset_name: name });
  const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream);
}

async function openStaffSession() {
  const { data, error } = await journalCloud.auth.getSession();
  if (error) throw error;
  if (!data.session) {
    document.querySelector('#load-title').textContent = 'Вход в журнал Мастеров';
    document.querySelector('#load-description').textContent = 'Введите рабочую почту и пароль сотрудника.';
    document.querySelector('#staff-login').hidden = false;
    return false;
  }
  staffId = data.session.user.id;
  document.querySelector('#staff-exit').hidden = false;
  return true;
}

document.querySelector('#staff-login').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const result = await journalCloud.auth.signInWithPassword({
      email: form.elements.email.value.trim(), password: form.elements.password.value
    });
    if (result.error) throw result.error;
    location.reload();
  } catch (error) {
    document.querySelector('#load-description').textContent = error.message === 'Invalid login credentials'
      ? 'Проверьте почту и пароль сотрудника.' : 'Не удалось войти. Проверьте соединение и данные для входа.';
  } finally { button.disabled = false; }
});

document.querySelector('#staff-exit').addEventListener('click', async () => {
  if (window.journalApp?.sync.queue.length) {
    await window.journalApp.flushChanges();
    if (window.journalApp.sync.queue.length) {
      document.querySelector('#save-detail').textContent = 'Перед выходом дождитесь отправки отметок.';
      return;
    }
  }
  const { error } = await journalCloud.auth.signOut({scope:'local'});
  if (!error) location.reload();
});
