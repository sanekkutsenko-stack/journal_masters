'use strict';
const adminEl = id => document.getElementById(id);
const actionNames = {registration:'Регистрация',access:'Изменение доступа',mark:'Отметка',legacy:'До переноса',add:'Добавление ученика',archive:'Архивирование',restore:'Восстановление'};
let activePanel = 'roster', studentsForGroup = [], historyCursor = null, viewTicket = 0;
const rosterState = {version:-1,rows:[],originals:new Map(),ticket:0};

function applyRoster(changes) {
  if (!changes.rows || changes.version < rosterState.version) return false;
  rosterState.rows = changes.rows;
  const bySheet = new Map();
  for (const row of changes.rows) {
    if (!bySheet.has(row.sheet)) bySheet.set(row.sheet,[]);
    bySheet.get(row.sheet).push(row);
  }
  for (const sheet of app.journals) {
    if (!rosterState.originals.has(sheet.id)) rosterState.originals.set(sheet.id,sheet.students);
    const base = rosterState.originals.get(sheet.id), edits = bySheet.get(sheet.id) || [];
    const inactive = new Set(edits.filter(row=>!row.active).map(row=>row.row));
    sheet.students = base.filter(student=>!inactive.has(student.row)).concat(edits.filter(row=>row.added && row.active).map(row=>({name:row.name,row:row.row,dailyRow:row.dailyRow,added:true}))).sort((a,b)=>a.row-b.row);
  }
  rosterState.version = changes.version;
  if (app.active && !app.active.sheet.students.some(student=>student.row===app.active.row)) {
    if (adminEl('mark-dialog').open) adminEl('mark-dialog').close();
    app.active=null;
  }
  return true;
}
async function refreshRoster() {
  const result = await callJournal('masters_roster_delta',{known_version:rosterState.version});
  return applyRoster(result);
}
function element(tag,value,css) {
  const node=document.createElement(tag);
  if (value!==undefined) node.textContent=value;
  if (css) node.className=css;
  return node;
}
function actionButton(label,callback){
  const b=element('button',label,'button');b.type='button';b.onclick=()=>perform(b,callback);return b;
}
function line(title,detail) {
  const row=element('div',undefined,'manage-row'), body=element('div');
  body.append(element('strong',title));if(detail)body.append(element('small',detail));row.append(body);return row;
}
function note(s) { adminEl('admin-message').textContent=s; }
async function perform(button,operation) {
  button.disabled=true;note('');
  try {await operation();}catch(error){note(error.message);}finally{button.disabled=false;}
}
function option(value,label){return new Option(label,value);}
function groupValue(){return adminEl('manage-group').value;}
function renderStudents(){
  const list=adminEl('manage-students'), needle=adminEl('roster-filter').value.trim().toLocaleLowerCase('ru');
  const active=adminEl('roster-mode').value==='active';list.replaceChildren();
  for(const student of studentsForGroup.filter(x=>x.active===active && x.name.toLocaleLowerCase('ru').includes(needle))){
    const row=line(student.name);
    row.append(actionButton(active?'В архив':'Восстановить',async()=>{
      const group=groupValue(), task=active?'archive':'restore';
      if(active && !window.confirm('Переместить в архив: '+student.name+' · '+group+'? Прежние отметки сохранятся.'))return;
      await editRoster(group,student.name,task);
    }));list.append(row);
  }
  if(!list.childElementCount)list.append(element('p',active?'В списке нет подходящих учеников.':'Архив пуст или совпадений нет.'));
}
async function loadRosterPanel(){
  const ticket=++viewTicket;
  const group=groupValue(), data=await callJournal('masters_roster_list',{group_name:group||null});
  if(ticket!==viewTicket)return;
  const select=adminEl('manage-group');
  if(!select.options.length){
    for(const name of data.groups.sort((a,b)=>a.localeCompare(b,'ru',{numeric:true})))select.add(option(name,name));
    const s=current();if(s){const wanted=s.kind==='exam'?[s.exam,s.subject,s.cls].filter(Boolean).join(' · '):s.cls;if(data.groups.includes(wanted))select.value=wanted;}
    if(select.value)return loadRosterPanel();
  }
  studentsForGroup=data.students;renderStudents();
}
async function editRoster(group,name,task){
  const affected=await callJournal('masters_roster_edit',{group_name:group,student_name:name,task});
  await refreshRoster();render();await loadRosterPanel();note('Обновлено листов: '+affected+'.');
}
async function loadAccounts(){
  const ticket=++viewTicket, profiles=await callJournal('masters_account_list');
  if(ticket!==viewTicket)return;
  const list=adminEl('manage-accounts');list.replaceChildren();
  for(const profile of profiles){
    const status={pending:'Ожидает решения',active:'Доступ открыт',blocked:'Доступ закрыт'}[profile.status];
    const roleName=r=>r==='admin'?'Администратор':'Пользователь';
    const row=line(profile.email,status+' · '+(profile.status==='pending'?'Запрос: '+roleName(profile.requested_role):roleName(profile.role)));
    if(profile.user_id!==staffId){
      const controls=element('div',undefined,'manage-actions'),role=element('select');
      role.setAttribute('aria-label','Роль для '+profile.email);role.add(option('user','Пользователь'));role.add(option('admin','Администратор'));
      role.value=profile.status==='pending'?profile.requested_role:profile.role;
      const update=async status=>{
        if((status==='blocked'||role.value==='admin') && !window.confirm(profile.email+' · '+(status==='blocked'?'закрыть доступ':'предоставить права администратора')+'?'))return;
        await callJournal('masters_account_edit',{target_user:profile.user_id,new_status:status,new_role:role.value});await loadAccounts();note('Доступ обновлён.');
      };
      controls.append(role,actionButton(profile.status==='active'?'Сохранить роль':'Открыть доступ',()=>update('active')));
      if(profile.status!=='blocked')controls.append(actionButton('Закрыть доступ',()=>update('blocked')));row.append(controls);
    }
    list.append(row);
  }
}
async function loadHistory(append=false){
  const ticket=++viewTicket,list=adminEl('manage-history');
  const entries=await callJournal('masters_audit_page',{before_id:append?historyCursor:null,filter_action:adminEl('action-filter').value||null,filter_actor:adminEl('actor-filter').value.trim()||null});
  if(ticket!==viewTicket)return;
  if(!append)list.replaceChildren();
  for(const e of entries){
    const row=line(actionNames[e.action]||e.action,new Date(e.occurred_at).toLocaleString('ru-RU')+' · '+e.actor);row.firstChild.append(element('p',e.detail));list.append(row);
  }
  if(!list.childElementCount)list.append(element('p','Записей по этим условиям нет.'));
  historyCursor=entries.at(-1)?.id??null;adminEl('history-next').hidden=entries.length<50;
}
async function showPanel(name) {
  activePanel=name;note('');
  document.querySelectorAll('[data-view]').forEach(el=>el.hidden=el.dataset.view!==name);
  document.querySelectorAll('[data-panel]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.panel===name)));
  if(name==='roster')await loadRosterPanel();else if(name==='accounts')await loadAccounts();else await loadHistory();
}
adminEl('manage-open').onclick=()=>{adminEl('admin-panel').showModal();showPanel(activePanel).catch(e=>note(e.message));};
adminEl('admin-close').onclick=()=>adminEl('admin-panel').close();
document.querySelectorAll('[data-panel]').forEach(b=>b.onclick=()=>showPanel(b.dataset.panel).catch(e=>note(e.message)));
adminEl('manage-group').onchange=()=>loadRosterPanel().catch(e=>note(e.message));
adminEl('roster-filter').oninput=adminEl('roster-mode').onchange=renderStudents;
adminEl('student-add').onsubmit=event=>{event.preventDefault();const form=event.currentTarget;perform(form.querySelector('button'),async()=>{await editRoster(groupValue(),form.elements.name.value,'add');form.reset();});};
adminEl('history-filter').onsubmit=event=>{event.preventDefault();loadHistory().catch(e=>note(e.message));};
adminEl('history-next').onclick=event=>perform(event.currentTarget,()=>loadHistory(true));
