'use strict';
/*
 * Работа с Excel: выгрузка исходной книги с текущими отметками и разбор книги при импорте.
 * Логика перенесена из прежнего app.js без изменений поведения.
 */
const NS='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL='http://schemas.openxmlformats.org/officeDocument/2006/relationships';

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
async function exportWorkbook(){
  const buttons=$$('[data-export]');buttons.forEach(b=>{b.disabled=true;});toast('Готовим Excel…');
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
  finally{buttons.forEach(b=>{b.disabled=false;});}
}
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
