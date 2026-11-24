'use strict';
const $=selector=>document.querySelector(selector);

const queueStorage=()=> 'masters-journal-queue:'+staffId;
const NS='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const codes=[['П','Присутствовал'],['УП','Уважительный пропуск'],['НП','Неуважительный пропуск'],['оп','Опоздал'],['вк','Камера выключена'],['пвк','Выключал камеру'],['У','Ушёл с урока'],['тел','С телефона'],['молчит','Не отвечал']];
const app={kind:'primary',quarter:'II',group:'',journal:'',week:0,day:'',patches:{},journals:[],active:null,source:null,dirty:false,storageOkay:true};
const sync={queue:[],revision:0,sending:false,polling:false,ready:false,timer:null};
const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function column(n){let value='';while(n){n--;value=String.fromCharCode(65+n%26)+value;n=Math.floor(n/26);}return value;}
function isoDate(d){return new Date(d+'T12:00:00Z');}
function formatDate(value,options={day:'numeric',month:'long'}){return isoDate(value).toLocaleDateString('ru-RU',{...options,timeZone:'UTC'});}
function localToday(){const date=new Date();return [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');}
function key(sheet,ref){return sheet+'!'+ref;}
function raw(sheet,ref){const id=key(sheet.id,ref);if(Object.hasOwn(app.patches,id))return {value:app.patches[id],manual:true};return sheet.cells[ref]||{value:null};}
function lessonDone(sheet,j){
  if(sheet.kind==='primarySubject'){
    const parent=app.journals.find(s=>s.id===sheet.dailyId);
    const value=raw(parent,column(j+2)+sheet.scheduleRow).value;
    return String(value||'').toLowerCase()==='да';
  }
  const top=raw(sheet,column(j+2)+'3').value;
  if(String(top||'').trim().toLowerCase()==='да')return true;
  if(sheet.kind==='primary'&&String(top||'').trim().toLowerCase()!=='нет')return sheet.schedule.some(item=>String(raw(sheet,column(j+2)+item.row).value||'').toLowerCase()==='да');
  return false;
}
function markValue(sheet,student,j){
  const entry=raw(sheet,column(j+2)+student.row);
  if(entry.formula || (student.added && !entry.manual)){
    if(!lessonDone(sheet,j))return '';
    if(sheet.kind==='primarySubject'&&student.dailyRow){
      const parent=app.journals.find(s=>s.id===sheet.dailyId);
      const dailyStudent=parent?.students.find(p=>p.row===student.dailyRow);
      const daily=dailyStudent?markValue(parent,dailyStudent,j):'';
      return daily&&daily!=='см. урок'?daily:'П';
    }
    return 'П';
  }
  return String(entry.value??'');
}
function cellStyle(value){if(value==='П')return 'present';if(value==='УП')return 'excused';if(value==='НП')return 'absent';if(value)return 'note';return '';}
let toastTimer;
function toast(message){$('#toast').textContent=message;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3500);}
function save(){
  app.dirty=true;
  try{localStorage.setItem(queueStorage(),JSON.stringify({queue:sync.queue,fingerprint:app.fingerprint,importId:app.importInfo?.id,selection:{kind:app.kind,quarter:app.quarter,group:app.group,journal:app.journal,day:app.day}}));app.storageOkay=true;}
  catch{app.storageOkay=false;}
  syncStatus();
}
function syncStatus(message){
  $('#save-status').textContent=message||(sync.queue.length?'Сохраняем изменения…':'Сохранено на сервере');
  $('#save-detail').textContent=sync.queue.length?sync.queue.length+' изменений ожидают отправки':'Доступно с ваших устройств';
}
function queueChange(cellKey,value,deleted=false){
  const operation={id:crypto.randomUUID(),key:cellKey,value,deleted};
  sync.queue.push(operation);
  if(deleted)delete app.patches[cellKey];else app.patches[cellKey]=value;
  save();
  clearTimeout(sync.timer);
  sync.timer=setTimeout(flushChanges,200);
}
function patch(sheet,ref,value){
  if(sheet.kind==='primarySubject'&&ref.endsWith('3')){
    const parent=app.journals.find(s=>s.id===sheet.dailyId);
    const letters=ref.match(/^[A-Z]+/)[0];
    queueChange(key(parent.id,letters+sheet.scheduleRow),value);
  }else queueChange(key(sheet.id,ref),value);
}
async function flushChanges(){
  if(sync.sending||!sync.ready||!sync.queue.length)return;
  sync.sending=true;
  const operations=sync.queue.filter(op=>!archivedOperation(op)).slice(0,100);
  if(!operations.length){sync.sending=false;syncStatus('Есть правки для архивного ученика');return;}
  try{
    const result=await callJournal('attendance_save', {operations});
    const accepted=new Set(result.accepted);
    sync.queue=sync.queue.filter(operation=>!accepted.has(operation.id));
    save();
    await pollChanges();
  }catch(error){
    syncStatus('Ожидаем соединение');
    $('#save-detail').textContent=error.message;
  }finally{
    sync.sending=false;
    if(sync.queue.some(op=>!archivedOperation(op))){clearTimeout(sync.timer);sync.timer=setTimeout(flushChanges,2000);}
  }
}
async function pollChanges(){
  if(sync.polling||!sync.ready)return;
  sync.polling=true;
  try{
    const [result,rosterChanged]=await Promise.all([callJournal('attendance_changes', {since_id:sync.revision}),refreshRoster()]);
    const pending=new Set(sync.queue.map(operation=>operation.key));
    for(const event of result.events){
      if(pending.has(event.cell_key))continue;
      if(event.is_deleted)delete app.patches[event.cell_key];else app.patches[event.cell_key]=event.cell_value;
    }
    sync.revision=result.revision;
    if(result.events.length||rosterChanged)render();
    if(rosterChanged && adminEl('admin-panel').open && activePanel==='roster')loadRosterPanel().catch(e=>note(e.message));
    if(!sync.queue.length)syncStatus();
  }catch(error){if(!sync.queue.length)syncStatus('Соединение прервано');}
  finally{sync.polling=false;}
}
function current(){return app.journals.find(s=>s.id===app.journal);}
function available(){return app.journals.filter(s=>(s.kind===app.kind||(app.kind==='primary'&&s.kind==='primarySubject'))&&s.quarter===app.quarter);}
function groupKey(sheet){return app.kind==='exam'?sheet.exam:sheet.cls;}
function lastFilledIndex(sheet){
  let result=-1;
  for(let j=0;j<sheet.dates.length;j++){
    if(sheet.dates[j]>localToday())continue;
    const values=[raw(sheet,column(j+2)+'3'),...sheet.students.map(p=>raw(sheet,column(j+2)+p.row)),
      ...sheet.schedule.map(subject=>raw(sheet,column(j+2)+subject.row))];
    if(values.some(cell=>!cell.formula&&cell.value!==null&&cell.value!==undefined&&cell.value!==''))result=j;
  }
  return result;
}
function selectJournal(resetWeek=true){
  const items=available();
  const groups=[...new Set(items.map(groupKey))].sort((a,b)=>a.localeCompare(b,'ru',{numeric:true}));
  if(!groups.includes(app.group))app.group=groups[0]||'';
  const choices=items.filter(s=>groupKey(s)===app.group);
  if(!choices.some(s=>s.id===app.journal))app.journal=choices[0]?.id||'';
  const s=current();
  if(s&&resetWeek){
    let index=s.dates.indexOf(app.day);
    if(index<0)index=lastFilledIndex(s);
    if(index<0)index=s.dates.findIndex(date=>date>=localToday());
    if(index<0)index=s.dates.length-1;
    app.week=Math.floor(index/5);
    app.day=s.dates[index];
  }
  render();
  if(sync.ready)save();
}
function render(){
  $('#welcome').hidden=app.journals.length>0;
  $('#export-btn').disabled=app.journals.length===0;
  document.querySelectorAll('[data-kind]').forEach(button=>button.classList.toggle('active',button.dataset.kind===app.kind));
  document.querySelectorAll('[data-quarter]').forEach(button=>button.classList.toggle('selected',button.dataset.quarter===app.quarter));
  const titles={primary:['Начальная школа','Одна отметка на ученика за день'],class:['Классы 5–11','Посещаемость и замечания по предметам'],exam:['ОГЭ и ЕГЭ','Подготовка к экзаменам · списки по предметам']};
  $('#page-title').textContent=titles[app.kind][0];$('#page-description').textContent=titles[app.kind][1];
  $('#group-caption').textContent=app.kind==='exam'?'ЭКЗАМЕНЫ':'КЛАССЫ';
  const groups=[...new Set(available().map(groupKey))].sort((a,b)=>a.localeCompare(b,'ru',{numeric:true}));
  $('#groups').innerHTML=groups.map(group=>`<button class="group-chip ${group===app.group?'active':''}" data-group="${escapeHTML(group)}">${escapeHTML(group)}</button>`).join('');
  $('#groups').querySelectorAll('button').forEach(button=>button.onclick=()=>{app.group=button.dataset.group;app.journal='';selectJournal();});
  const choices=available().filter(s=>groupKey(s)===app.group);
  $('#journal-select').innerHTML=choices.map(s=>`<option value="${escapeHTML(s.id)}">${escapeHTML(s.subject)}</option>`).join('');
  $('#journal-select').value=app.journal;
  $('#journal-select').hidden=false;
  const s=current();
  $('#empty-state').hidden=!!s||app.journals.length===0;
  $('.journal-card').hidden=!s;$('.summary-strip').hidden=!s;
  if(!s){$('#schedule-card').hidden=true;return;}
  $('#journal-title').textContent=app.kind==='primary'?`Класс ${s.cls}`:app.kind==='exam'?`${s.exam} · ${s.subject}`:`${s.cls} класс · ${s.subject}`;
  $('#roster-size').textContent=s.students.length+' '+(s.students.length%10===1&&s.students.length%100!==11?'ученик':s.students.length%10>=2&&s.students.length%10<=4&&!(s.students.length%100>=12&&s.students.length%100<=14)?'учеников':'учеников');
  const start=app.week*5,days=s.dates.slice(start,start+5);
  if(!days.includes(app.day))app.day=days[0];
  $('#week-label').textContent=formatDate(days[0],{day:'numeric',month:'short'}).replace('.','')+' — '+formatDate(days.at(-1),{day:'numeric',month:'short'}).replace('.','');
  $('#prev-week').disabled=app.week===0;$('#next-week').disabled=start+5>=s.dates.length;
  const query=$('#student-search').value.toLowerCase().trim();
  const students=s.students.filter(student=>student.name.toLowerCase().includes(query));
  const headers=days.map((date,i)=>{
    const j=start+i,done=lessonDone(s,j);
    return `<th class="${date===app.day?'selected-day':''}"><button class="date-button ${date===app.day?'focused':''}" data-day="${date}">${formatDate(date,{day:'numeric',month:'short'})}<small>${formatDate(date,{weekday:'long'})}</small></button><button class="confirm ${done?'on':''}" data-confirm="${j}" aria-label="${done?'Отменить подтверждение':'Подтвердить занятие'} ${formatDate(date)}">${done?'✓ Проведён':'Подтвердить'}</button></th>`;
  }).join('');
  const rows=students.map((student,index)=>`<tr><td><div class="student-name"><span class="student-number">${String(index+1).padStart(2,'0')}</span><span class="name-text">${escapeHTML(student.name)}</span></div></td>${days.map((date,i)=>{
    const j=start+i,value=markValue(s,student,j);
    return `<td class="${!lessonDone(s,j)?'unconfirmed':''}"><button class="mark ${cellStyle(value)}" data-row="${student.row}" data-index="${j}" title="${escapeHTML(value||'Изменить отметку')}" aria-label="${escapeHTML(student.name)}, ${formatDate(date)}, ${escapeHTML(value||'нет отметки')}">${escapeHTML(value||'—')}</button></td>`;
  }).join('')}</tr>`).join('');
  $('#attendance-table').innerHTML=`<thead><tr><th>УЧЕНИК <span style="color:#b0b8ac">· ${students.length}</span></th>${headers}</tr></thead><tbody>${rows||`<tr><td colspan="${days.length+1}">По вашему запросу учеников нет</td></tr>`}</tbody>`;
  document.querySelectorAll('[data-day]').forEach(button=>button.onclick=()=>{app.day=button.dataset.day;render();});
  document.querySelectorAll('[data-confirm]').forEach(button=>button.onclick=()=>{
    const j=Number(button.dataset.confirm);app.day=s.dates[j];
    const wasDone=lessonDone(s,j);
    patch(s,column(j+2)+'3',wasDone?'Нет':'Да');
    if(wasDone&&s.kind==='primary')for(const item of s.schedule)patch(s,column(j+2)+item.row,'Нет');
    render();
    toast(wasDone?'Подтверждение занятия отменено':'Занятие подтверждено. Отметьте пропуски и замечания.');
  });
  document.querySelectorAll('[data-row]').forEach(button=>button.onclick=()=>openMark(Number(button.dataset.row),Number(button.dataset.index)));
  const dayIndex=s.dates.indexOf(app.day),done=lessonDone(s,dayIndex);
  const values=s.students.map(student=>markValue(s,student,dayIndex));
  $('#count-present').textContent=done?values.filter(value=>value&&!['НП','УП'].includes(value)).length:'—';
  $('#count-absent').textContent=done?values.filter(value=>['НП','УП'].includes(value)).length:'—';
  $('#count-notes').textContent=done?values.filter(value=>value&&!['П','НП','УП'].includes(value)).length:'—';
  $('#schedule-card').hidden=s.kind!=='primary';
  if(s.kind==='primary'){
    $('#schedule-items').innerHTML=s.schedule.map((item,i)=>{
      const active=String(raw(s,column(dayIndex+2)+item.row).value||'').toLowerCase()==='да';
      return `<button class="schedule-item ${active?'active':''}" data-schedule="${i}" aria-pressed="${active}">${active?'✓ ':''}${escapeHTML(item.label)}</button>`;
    }).join('');
    $('#schedule-items').querySelectorAll('button').forEach(button=>button.onclick=()=>{
      const item=s.schedule[Number(button.dataset.schedule)],ref=column(dayIndex+2)+item.row;
      const active=String(raw(s,ref).value||'').toLowerCase()==='да';
      patch(s,ref,active?'Нет':'Да');render();
    });
  }
}
function openMark(row,index){
  const s=current(),student=s.students.find(p=>p.row===row);
  app.active={sheet:s,row,index,student};
  app.day=s.dates[index];
  $('#mark-name').textContent=student.name;
  $('#mark-date').textContent=formatDate(app.day)+' · '+s.subject;
  $('#custom-mark').value=markValue(s,student,index);
  $('#mark-options').innerHTML=codes.map(([code,label])=>`<button type="button" class="option" data-code="${code}"><strong>${code}</strong><small>${label}</small></button>`).join('');
  $('#mark-options').querySelectorAll('button').forEach(button=>button.onclick=()=>setMark(button.dataset.code));
  $('#mark-dialog').showModal();
}
function setMark(value){
  const {sheet,row,index}=app.active;
  patch(sheet,column(index+2)+row,value);
  $('#mark-dialog').close();render();
  if(!lessonDone(sheet,index))toast('Отметка сохранена. Подтвердите проведённое занятие над датой.');
}
$('#apply-mark').onclick=()=>setMark($('#custom-mark').value.trim());
$('#reset-mark').onclick=()=>{const {sheet,row,index}=app.active;queueChange(key(sheet.id,column(index+2)+row),null,true);$('#mark-dialog').close();render();};
$('#student-search').oninput=render;
$('#journal-select').onchange=event=>{app.journal=event.target.value;selectJournal();};
document.querySelectorAll('[data-kind]').forEach(button=>button.onclick=()=>{app.kind=button.dataset.kind;app.group='';app.journal='';$('#student-search').value='';selectJournal();});
document.querySelectorAll('[data-quarter]').forEach(button=>button.onclick=()=>{app.quarter=button.dataset.quarter;app.day='';app.journal='';selectJournal();});
$('#prev-week').onclick=()=>{app.week--;render();};
$('#next-week').onclick=()=>{app.week++;render();};
$('#today-btn').onclick=()=>{app.day=localToday();selectJournal();};
$('#last-filled-btn').onclick=()=>{
  const sheet=current(),index=sheet?lastFilledIndex(sheet):-1;
  if(index<0){toast('В выбранном журнале пока нет заполненных дат.');return;}
  app.day=sheet.dates[index];app.week=Math.floor(index/5);render();save();
};
$('#help-open').onclick=$('#help-footer').onclick=()=>$('#help-dialog').showModal();

function parseXML(text){const doc=new DOMParser().parseFromString(text,'application/xml');if(doc.querySelector('parsererror'))throw new Error('Невозможно прочитать структуру Excel');return doc;}
function all(node,tag){return [...node.getElementsByTagNameNS('*',tag)];}
function first(node,tag){return all(node,tag)[0];}
function cellText(node,strings){const type=node.getAttribute('t');if(type==='s')return strings[Number(first(node,'v')?.textContent)];if(type==='inlineStr')return all(node,'t').map(n=>n.textContent).join('');return first(node,'v')?.textContent??'';}
async function workbookMeta(zip){
  const book=parseXML(await zip.file('xl/workbook.xml').async('string'));
  const rels=parseXML(await zip.file('xl/_rels/workbook.xml.rels').async('string'));
  const targets=Object.fromEntries(all(rels,'Relationship').map(r=>[r.getAttribute('Id'),r.getAttribute('Target')]));
  const mapping={};
  for(const sheet of all(book,'sheet')){
    const target=targets[sheet.getAttributeNS(REL,'id')];
    mapping[sheet.getAttribute('name')]={path:target.startsWith('/')?target.slice(1):'xl/'+target,state:sheet.getAttribute('state')};
  }
  let strings=[];
  if(zip.file('xl/sharedStrings.xml'))strings=all(parseXML(await zip.file('xl/sharedStrings.xml').async('string')),'si').map(si=>all(si,'t').map(t=>t.textContent).join(''));
  return {book,rels,mapping,strings};
}
function ensureCell(doc,ref){
  let cell=all(doc,'c').find(c=>c.getAttribute('r')===ref);if(cell)return cell;
  const rowNumber=ref.match(/\d+$/)[0],data=first(doc,'sheetData');
  let row=all(data,'row').find(r=>r.getAttribute('r')===rowNumber);
  if(!row){row=doc.createElementNS(NS,'row');row.setAttribute('r',rowNumber);const next=all(data,'row').find(r=>Number(r.getAttribute('r'))>Number(rowNumber));data.insertBefore(row,next||null);}
  cell=doc.createElementNS(NS,'c');cell.setAttribute('r',ref);
  const rank=x=>{let n=0;for(const char of x.match(/^[A-Z]+/)[0])n=n*26+char.charCodeAt(0)-64;return n;};
  const next=[...row.children].find(c=>rank(c.getAttribute('r'))>rank(ref));
  row.insertBefore(cell,next||null);return cell;
}
function writeValue(doc,ref,value){
  const cell=ensureCell(doc,ref);
  for(const child of [...cell.children])if(['f','v','is'].includes(child.localName))cell.removeChild(child);
  cell.removeAttribute('t');
  if(value!==null&&value!==''){cell.setAttribute('t','inlineStr');const inline=doc.createElementNS(NS,'is'),text=doc.createElementNS(NS,'t');text.textContent=value;inline.appendChild(text);cell.appendChild(inline);}
}
function prepareRosterExport(grouped){
  const sheets=new Map(app.journals.map(sheet=>[sheet.id,sheet]));
  for(const item of rosterState.rows){
    if(!grouped[item.sheet])grouped[item.sheet]={};
    if(!item.added)continue;
    const sheet=sheets.get(item.sheet), edits=grouped[item.sheet], student=sheet.students.find(s=>s.row===item.row);
    edits['A'+item.row]=item.name;
    if(!student)continue;
    for(let i=0;i<sheet.dates.length;i++){
      const ref=column(i+2)+item.row;
      if(!Object.hasOwn(edits,ref))edits[ref]=markValue(sheet,student,i);
    }
  }
}
function applyExcelRoster(doc,sheetName){
  const rows=rosterState.rows.filter(row=>row.sheet===sheetName);
  if(!rows.length)return;
  const byRow=new Map(all(first(doc,'sheetData'),'row').map(r=>[Number(r.getAttribute('r')),r]));
  let last=0;
  for(const item of rows){
    const node=byRow.get(item.row);
    if(node&&!item.active)node.setAttribute('hidden','1');
    if(item.added)last=Math.max(last,item.row);
  }
  if(last){
    for(const tag of ['dimension','autoFilter']){
      const el=first(doc,tag),ref=el?.getAttribute('ref'), m=ref?.match(/^([A-Z]+\d+):([A-Z]+)(\d+)$/);
      if(m&&Number(m[3])<last)el.setAttribute('ref',m[1]+':'+m[2]+last);
    }
  }
}
function archivedOperation(op){
  if(!rosterState.rows.length)return false;
  const i=op.key.lastIndexOf('!'),sheet=op.key.slice(0,i),row=Number(op.key.slice(i+1).match(/\d+$/)?.[0]);
  return rosterState.rows.some(item=>!item.active&&item.sheet===sheet&&item.row===row);
}

async function exportWorkbook(){
  const button=$('#export-btn');button.disabled=true;button.textContent='Готовим Excel…';
  try{
    await flushChanges();
    await pollChanges();
    const original=await app.source();
    const zip=await JSZip.loadAsync(original),meta=await workbookMeta(zip);
    const grouped={};
    for(const [key,value] of Object.entries(app.patches)){
      const split=key.lastIndexOf('!'),sheet=key.slice(0,split),ref=key.slice(split+1);
      (grouped[sheet]??={})[ref]=value;
    }
    prepareRosterExport(grouped);
    for(const [name,changes] of Object.entries(grouped)){
      const path=meta.mapping[name]?.path;if(!path)throw new Error('Лист отсутствует в исходном Excel');
      const doc=parseXML(await zip.file(path).async('string'));
      // Shared formulas must be expanded before replacing the anchor cell.
      const formulaCells=all(doc,'c').filter(c=>first(c,'f')?.getAttribute('t')==='shared');
      const anchors=new Map(formulaCells.filter(c=>first(c,'f').textContent).map(c=>[first(c,'f').getAttribute('si'),c]));
      for(const c of formulaCells){
        const f=first(c,'f'),anchor=anchors.get(f.getAttribute('si'));
        if(!anchor)continue;
        const baseRef=anchor.getAttribute('r'),ref=c.getAttribute('r');
        const number=letters=>{let n=0;for(const ch of letters)n=n*26+ch.charCodeAt(0)-64;return n;};
        const dc=number(ref.match(/^[A-Z]+/)[0])-number(baseRef.match(/^[A-Z]+/)[0]),dr=Number(ref.match(/\d+$/)[0])-Number(baseRef.match(/\d+$/)[0]);
        const formula=first(anchor,'f').textContent.replace(/(\$?)([A-Z]{1,3})(\$?)(\d+)/g,(whole,ac,letters,ar,row)=>ac+column(number(letters)+(ac?0:dc))+ar+(Number(row)+(ar?0:dr)));
        f.textContent=formula;f.removeAttribute('t');f.removeAttribute('si');f.removeAttribute('ref');
      }
      for(const [ref,value] of Object.entries(changes))writeValue(doc,ref,value);
      applyExcelRoster(doc,name);
      zip.file(path,new XMLSerializer().serializeToString(doc));
    }
    let calc=first(meta.book,'calcPr');
    if(!calc){calc=meta.book.createElementNS(NS,'calcPr');meta.book.documentElement.appendChild(calc);}
    calc.setAttribute('calcMode','auto');calc.setAttribute('fullCalcOnLoad','1');calc.setAttribute('forceFullCalc','1');
    zip.file('xl/workbook.xml',new XMLSerializer().serializeToString(meta.book));
    for(const rel of all(meta.rels,'Relationship'))if(rel.getAttribute('Type').endsWith('/calcChain'))rel.remove();
    zip.file('xl/_rels/workbook.xml.rels',new XMLSerializer().serializeToString(meta.rels));
    zip.remove('xl/calcChain.xml');
    const types=parseXML(await zip.file('[Content_Types].xml').async('string'));
    for(const node of all(types,'Override'))if(node.getAttribute('PartName')==='/xl/calcChain.xml')node.remove();
    zip.file('[Content_Types].xml',new XMLSerializer().serializeToString(types));
    const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE'});
    download(blob,'Посещаемость — '+localToday()+'.xlsx');
    app.dirty=false;toast('Excel с вашими изменениями скачан');
  }catch(error){console.error(error);toast('Не удалось выгрузить Excel. '+error.message);}
  finally{button.disabled=false;button.textContent='↓ Скачать Excel';}
}
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
async function digest(buffer){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))].map(x=>x.toString(16).padStart(2,'0')).join('');}
async function parseImported(buffer){
  const zip=await JSZip.loadAsync(buffer),meta=await workbookMeta(zip);
  const sheets=[],byName=meta.mapping;
  for(const [name,{path,state}] of Object.entries(byName)){
    if(state==='hidden'||state==='veryHidden')continue;
    const doc=parseXML(await zip.file(path).async('string')),nodes=all(doc,'c'),lookup=new Map(nodes.map(c=>[c.getAttribute('r'),c]));
    const value=ref=>lookup.has(ref)?cellText(lookup.get(ref),meta.strings):'';
    if(value('A4')!=='ФИО / дата')continue;
    const primary=name.startsWith('Класс-');
    if(!primary&&value('A3')!=='Урок проведён?')continue;
    const match=name.match(/-(\d+[А-Я]+)(?: · (II|III|IV))?$/),cls=match?.[1]||'';
    if(!primary&&cls&&Number(cls.match(/\d+/)[0])<=4)continue;
    const dates=[];
    for(let j=2;j<80;j++){
      const v=Number(value(column(j)+'4'));if(!v||v<40000||v>60000)break;
      dates.push(new Date((v-25569)*86400000).toISOString().slice(0,10));
    }
    if(!dates.length)continue;
    const students=[];
    const filter=first(doc,'autoFilter')?.getAttribute('ref');
    const end=primary?all(doc,'c').filter(c=>/^A\d+$/.test(c.getAttribute('r'))).find(c=>/^УП \/ НП/.test(cellText(c,meta.strings)))?.getAttribute('r').slice(1)-1:Number(filter?.match(/\d+$/)?.[0]);
    if(!end)continue;
    for(let row=5;row<=end;row++){
      const person=value('A'+row);if(!person)continue;
      const rowNode=all(doc,'row').find(r=>r.getAttribute('r')===String(row));
      if(rowNode?.getAttribute('hidden')!=='1')students.push({name:person,row});
    }
    if(!students.length)continue;
    const cells={};
    for(const c of nodes){const f=first(c,'f');cells[c.getAttribute('r')]={value:f?null:cellText(c,meta.strings),formula:f?'='+f.textContent:null,cached:f?cellText(c,meta.strings):null};}
    const schedule=[];
    if(primary)for(const link of all(doc,'hyperlink')){
      const ref=link.getAttribute('ref'),location=link.getAttribute('location')||'';
      if(!/^A\d+$/.test(ref)||Number(ref.slice(1))<=students.at(-1).row)continue;
      const target=location.match(/^'([^']+)'!/);
      if(target&&byName[target[1]])schedule.push({row:Number(ref.slice(1)),label:value(ref),target:target[1]});
    }
    const exam=name.startsWith('ОГЭ-')?'ОГЭ':name.startsWith('ЕГЭ-')?'ЕГЭ':'';
    sheets.push({id:name,title:value('B1'),kind:primary?'primary':exam?'exam':'class',cls,quarter:name.endsWith(' · III')?'III':name.endsWith(' · IV')?'IV':'II',subject:primary?'Общий день':value('B1').split(' • ')[0].split('. ')[0],exam,dates,students,cells,schedule});
  }
  if(!sheets.length)throw new Error('В файле не найдены журналы с ФИО и датами');
  return sheets;
}
$('#export-btn').onclick=exportWorkbook;
$('#retry-load').onclick=()=>location.reload();
async function start(){
  try{
    if (!await openStaffSession()) return;
    const snapshot = await callJournal('attendance_state');
    const state = { ...await (await loadAsset('journal')).json(), ...snapshot };
    app.journals=state.journals;app.patches=state.patches;app.fingerprint=state.fingerprint;
    app.importInfo=state.importInfo;
    await refreshRoster();
    if(app.importInfo?.total){
      $('#import-summary').hidden=false;
      $('#import-summary').textContent='Сверено с Excel · '+app.importInfo.sourceName+' · '+app.importInfo.attendance+' отметок учеников и '+app.importInfo.lessons+' подтверждений и записей расписания.';
    }
    sync.revision=state.revision;
    app.source=async()=> (await loadAsset('workbook')).arrayBuffer();
    try{
      const saved=JSON.parse(localStorage.getItem(queueStorage())||'null');
      if(saved?.fingerprint===app.fingerprint){
        sync.queue=saved.queue||[];Object.assign(app,saved.selection||{});
        if(saved.importId!==app.importInfo?.id)app.day='';
        for(const operation of sync.queue)if(operation.deleted)delete app.patches[operation.key];else app.patches[operation.key]=operation.value;
      }

    }catch{}
    sync.ready=true;
    selectJournal();
    save();flushChanges();
    setInterval(()=>{if(!document.hidden)pollChanges();},5000);
    window.addEventListener('online',()=>{flushChanges();pollChanges();});
  }catch(error){
    $('#load-title').textContent='Не удалось открыть журнал';
    $('#load-description').textContent=error.message;
    $('#retry-load').hidden=false;
    toast(error.message);
  }
}
window.journalApp={app,markValue,lessonDone,parseImported,exportWorkbook,sync,flushChanges,pollChanges};
start();
