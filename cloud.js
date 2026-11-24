'use strict';
const journalCloud = supabase.createClient('https://wyckiwszpyvqdgfndshx.supabase.co', 'sb_publishable_v37PxTCAGa-f0I3kFshCFw_dQQry0am', {
  auth: { storage: sessionStorage, storageKey: 'masters-journal-auth' }
});
let staffId = null;

async function callJournal(procedure, args = {}) {
  const { data, error } = await journalCloud.rpc(procedure, args);
  if (error) throw new Error(error.message || 'Не удалось связаться с журналом.');
  if (data === null && procedure==='attendance_changes' && staffId) location.reload();
  if (data === null) throw new Error('У этой учётной записи пока нет доступа к журналу.');
  return data;
}

async function loadAsset(name) {
  const encoded = await callJournal('attendance_asset', { asset_name: name });
  const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream);
}

const authEl = id => document.getElementById(id);
let staffRole = null;
function authTab(register) {
  authEl('staff-login').hidden = register;
  authEl('staff-register').hidden = !register;
  authEl('tab-login').setAttribute('aria-pressed', String(!register));
  authEl('tab-register').setAttribute('aria-pressed', String(register));
  authEl('load-title').textContent = register ? 'Регистрация сотрудника' : 'Вход в журнал Мастеров';
  authEl('load-description').textContent = register ? 'Подтвердите почту, затем войдите, чтобы отправить заявку администратору.' : 'Введите рабочую почту и пароль сотрудника.';
  authEl('auth-message').textContent = '';
}
authEl('tab-login').onclick = () => authTab(false);
authEl('tab-register').onclick = () => authTab(true);

async function openStaffSession() {
  const { data, error } = await journalCloud.auth.getSession();
  if (error) throw error;
  if (!data.session) {
    authEl('auth-panel').hidden = false;
    authTab(false);
    return false;
  }
  staffId = data.session.user.id;
  authEl('staff-exit').hidden = false;
  const profile = await callJournal('masters_session_info');
  if (profile.status !== 'active') {
    authEl('load-title').textContent = profile.status === 'blocked' ? 'Доступ закрыт' : 'Заявка передана администратору';
    authEl('load-description').textContent = profile.status === 'blocked' ? 'Обратитесь к администратору журнала.' : 'Когда администратор одобрит заявку, журнал откроется автоматически.';
    if (profile.status === 'pending') {
      const timer = setInterval(async () => {
        if (document.hidden) return;
        try { if ((await callJournal('masters_session_info')).status !== 'pending') { clearInterval(timer); location.reload(); } } catch {}
      }, 7000);
    }
    return false;
  }
  staffRole = profile.role;
  authEl('manage-open').hidden = staffRole !== 'admin';
  document.querySelector('.cloud-label').textContent = staffRole === 'admin' ? 'Администратор' : 'Пользователь';
  return true;
}

function authError(error) {
  const messages = {invalid_credentials:'Проверьте почту и пароль.',email_not_confirmed:'Сначала подтвердите почту по ссылке из письма.',over_email_send_rate_limit:'Лимит писем исчерпан. Проверьте входящие и спам или повторите позже.',over_request_rate_limit:'Слишком много попыток. Повторите позже.',weak_password:'Выберите более надёжный пароль.',signup_disabled:'Регистрация временно закрыта.',email_address_invalid:'Проверьте написание почты.',email_address_not_authorized:'Почтовая служба проекта пока не отправляет письма на этот адрес. Обратитесь к администратору.'};
  return messages[error.code] || 'Запрос не выполнен. Проверьте соединение и повторите попытку.';
}
for (const mode of ['login','register']) {
  authEl('staff-'+mode).onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget, fields = form.elements, button = form.querySelector('button');
    const email = fields.email.value.trim(), password = fields.password.value;
    if (mode === 'register' && password !== fields.repeat.value) {
      authEl('auth-message').textContent = 'Пароли должны совпадать.'; fields.repeat.focus(); return;
    }
    button.disabled = true;
    try {
      const result = mode === 'login' ? await journalCloud.auth.signInWithPassword({email,password}) :
        await journalCloud.auth.signUp({email,password, options:{data:{requested_role:fields.role.value},emailRedirectTo:location.origin+location.pathname}});
      if (result.error) throw result.error;
      if (result.data.session) { location.reload(); return; }
      authTab(false);
      authEl('staff-login').elements.email.value = email;
      form.reset();
      authEl('auth-message').textContent = 'Для нового адреса отправлено письмо. Подтвердите почту, затем вернитесь сюда и войдите. Если вы уже зарегистрированы, используйте свой пароль.';
    } catch (error) { authEl('auth-message').textContent = authError(error); }
    finally { button.disabled = false; }
  };
}
document.querySelector('#staff-exit').addEventListener('click', async () => {
  if (window.journalApp?.sync.queue.length) {
    await window.journalApp.flushChanges();
    if (window.journalApp.sync.queue.some(op=>!archivedOperation(op))) {
      document.querySelector('#save-detail').textContent = 'Перед выходом дождитесь отправки отметок.';
      return;
    }
  }
  const { error } = await journalCloud.auth.signOut({scope:'local'});
  if (!error) location.reload();
  else document.querySelector('#save-detail').textContent='Не удалось выйти. Проверьте соединение.';
});
