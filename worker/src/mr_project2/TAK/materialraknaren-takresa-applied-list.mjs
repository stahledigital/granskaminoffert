import {isPhysicalPlanJson} from './materialraknaren-takplan-record.mjs';
import {readRoofPhysicalRecord} from './materialraknaren-takresa-record-v4.mjs';
import {validateVersionedRoofState} from './materialraknaren-takresa-version-v3.mjs';
import {roofMaterialPartV3,roofDrainagePartV3,roofEavePartV3} from './materialraknaren-takresa-producenter-v3.mjs';
import {savedRoofBattenRows} from './materialraknaren-takplan-rader.mjs';

// The carrier owns each complete applied record exactly once. Financial rows
// cannot discard it, and raw refs cannot select a different source or builder.
export const ROOF_APPLIED_LIST_BASIS=Object.freeze({model:'roof-applied-list-2',record:'3a0dd7c2c9ab18c08e430c614d77fdeb4751256ee36a31313f80b1d2cfcece71',legacyProjection:'62c52b42865c4811a101eed9b8492989d6bbc5cb65bf2609e686b7ad401c0b4a',typedProjection:'b2eacaf665ace82afa76c3b9d1ed64c0a44434d33dbe07b226f5c3aa6822acf3'});
const ROLES=['material','drainage','eave','supported-battens'],MAX=262144,encoder=new TextEncoder();
const copy=v=>JSON.parse(JSON.stringify(v)),object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const allowed=(v,keys,required)=>object(v)&&Object.keys(v).every(k=>keys.includes(k))&&required.every(k=>Object.hasOwn(v,k));
const text=(v,max)=>typeof v==='string'&&v.length<=max;
const must=(v,code='carrier')=>{if(!v)throw Error(code)};
const fail=e=>({ok:false,issues:e?.issues||[{field:'roof-list',code:e instanceof Error?e.message:'carrier',message:'Takets fullständiga underlag kan inte uppdateras. Tidigare lista, priser och sparade planer finns kvar utan ändring.'}]});
function canonical(v){if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}'}
const same=(a,b)=>canonical(a)===canonical(b),size=v=>must(encoder.encode(JSON.stringify(v)).length<=MAX,'carrier-size');
const notes=v=>Array.isArray(v)&&v.length<=20&&v.every(n=>text(n,1200));
const settings=v=>object(v)&&Object.keys(v).length<=60&&Object.entries(v).every(([k,x])=>/^(t_|pp_|avv_)[a-z0-9_]{1,30}$/.test(k)&&text(x,120));
const partId=v=>typeof v==='string'&&v.trim()&&v.length<=200||typeof v==='number'&&Number.isSafeInteger(v);
const ref=r=>({id:r.id,revision:r.revision,sha256:r.sha256});
const isV4=p=>object(p.takmodell)&&p.takmodell.version===4;
const legacyRoot=p=>object(p.takmodell)&&object(p.takmodell.state)?p.takmodell.state.id:null;
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v)}return v};
function checkProjection(p,typed){
 must(exact(p,['title','short','ctx','notes','rows','settings'])&&text(p.title,80)&&p.title.trim()&&text(p.short,300)&&text(p.ctx,5000)&&notes(p.notes)&&settings(p.settings),'projection');
 must(Array.isArray(p.rows)&&p.rows.length>=1&&p.rows.length<=200,'projection');
 if(!typed)for(const row of p.rows){
  must(allowed(row,['hd','k','v','u','sub','kind','pv','pu'],['k','v','u'])&&text(row.k,160)&&row.k.trim()&&text(row.u,24)&&typeof row.v==='number'&&Number.isFinite(row.v)&&row.v>=0,'projection');
  must((row.hd===undefined||text(row.hd,80))&&(row.sub===undefined||text(row.sub,1000))&&(row.kind===undefined||['matt','behov'].includes(row.kind)),'projection');
  must(row.pv===undefined&&row.pu===undefined||typeof row.pv==='number'&&Number.isFinite(row.pv)&&row.pv>=0&&text(row.pu,24),'projection');
 }
 return p;
}
async function projection(record,role){
 must(ROLES.includes(role),'role');let p;
 if(role==='supported-battens'){
  const r=await savedRoofBattenRows(record);if(!r.ok)throw r;
  p={title:'Läkt och infästning',short:`${r.rows.length} inköpsrader från sparad takplan`,ctx:`Tak ${record.id} · tillämpning ${record.revision}`,notes:r.requiredChecks.map(c=>c.message),rows:r.rows,settings:{}};
 }else{
  const builder={material:roofMaterialPartV3,drainage:roofDrainagePartV3,eave:roofEavePartV3}[role];
  p=builder(freeze(copy(record.roofState)));if(p?.ok===false)throw p;
  p={title:p.title,short:p.short||'',ctx:p.ctx||'',notes:p.notes||[],rows:p.rows,settings:p.settings||{}};
 }
 return checkProjection(p,role==='supported-battens');
}
function mergeNotes(original,current){
 if(original===undefined)return copy(current);must(notes(original),'legacy-notes');
 const combined=same(original,current)?copy(current):[...copy(original),...copy(current)];must(notes(combined),'legacy-notes');return combined;
}
function upgradeNotes(p){
 const original=Object.hasOwn(p,'notes')?p.notes:[],older=p.takmodell.legacyNotes;must(notes(original),'legacy-notes');
 if(older===undefined)return copy(original);
 must(p.takmodell.version===3&&notes(older),'legacy-notes');
 // R40 normally put the complete older notes at the beginning of visible
 // notes. Only that exact prefix proves they are already present, including
 // order and duplicates; otherwise preserve both complete sequences.
 const prefix=older.length<=original.length&&older.every((n,i)=>n===original[i]);
 const all=prefix?copy(original):[...copy(older),...copy(original)];must(notes(all),'legacy-notes');return all;
}
async function buildPart(record,role,id,legacyNotes){
 must(partId(id),'part-id');const p=await projection(record,role);
 return {id,title:p.title,short:p.short,ctx:p.ctx,notes:mergeNotes(legacyNotes,p.notes),rows:copy(p.rows),takmodell:{version:4,role,ref:ref(record),settings:copy(p.settings),...(legacyNotes===undefined?{}:{legacyNotes:copy(legacyNotes)})}};
}
async function read(raw){
 must(isPhysicalPlanJson(raw),'carrier-json');size(raw);const c=copy(raw);
 must(exact(c,['format','version','parts','records'])&&c.format==='mr-roof-applied-list'&&c.version===2&&Array.isArray(c.parts)&&c.parts.length<=200&&c.parts.every(object)&&Array.isArray(c.records)&&c.records.length<=200,'carrier-format');
 const byId=new Map(),used=new Set(),roles=new Set();
 for(const entry of c.records){
  must(exact(entry,['id','revision','sha256','record'])&&!byId.has(entry.id),'record-entry');
  const r=await readRoofPhysicalRecord(entry.record);if(!r.ok)throw r;
  must(same(ref(r.record),{id:entry.id,revision:entry.revision,sha256:entry.sha256}),'record-entry');byId.set(entry.id,r.record);
 }
 for(const p of c.parts){
  const m=p.takmodell;
  if(!isV4(p)){
   must(!object(m)||!Object.hasOwn(m,'version')||[1,2,3].includes(m.version),'unknown-part-version');
   must(!byId.has(legacyRoot(p)),'mixed-upgrade');continue;
  }
  must(exact(p,['id','title','short','ctx','notes','rows','takmodell'])&&allowed(m,['version','role','ref','settings','legacyNotes'],['version','role','ref','settings'])&&ROLES.includes(m.role),'part-format');
  must(c.parts.filter(other=>Object.hasOwn(other,'id')&&String(other.id)===String(p.id)).length===1,'part-id-conflict');
  must(exact(m.ref,['id','revision','sha256'])&&byId.has(m.ref.id),'missing-record');const record=byId.get(m.ref.id);
  must(same(m.ref,ref(record)),'stale-record');const key=JSON.stringify([record.id,m.role]);must(!roles.has(key),'duplicate-role');roles.add(key);used.add(record.id);
  const expected=await buildPart(record,m.role,p.id,m.legacyNotes);must(same(p,expected),'projection-mismatch');
 }
 must(used.size===byId.size,'orphan-record');return c;
}
export async function readAppliedRoofList(raw){try{return {ok:true,carrier:await read(raw),completePurchasePlan:false}}catch(e){return fail(e)}}
function legacyCarrier(raw){
 must(Array.isArray(raw)&&raw.length<=200&&raw.every(object),'legacy-list');must(raw.every(p=>!isV4(p)),'missing-record');
 return {format:'mr-roof-applied-list',version:2,parts:copy(raw),records:[]};
}
function checkUpgrade(from,record){
 const v=validateVersionedRoofState(from);must(v.ok&&same(v.state,from)&&from.id===record.id,'upgrade-state');
 const s=record.roofState;must(s.revision>=from.revision,'upgrade-stale');
 if(from.version===3)must(from.interpreterVersion===s.interpreterVersion&&same(from.interpreterBasis,s.interpreterBasis),'upgrade-source');
 else must(from.version===s.interpreterVersion&&same(from.basis,s.interpreterBasis),'upgrade-source');
 if(from.revision===s.revision){const shadow=from.version===3?s:{format:s.format,version:s.interpreterVersion,id:s.id,revision:s.revision,basis:s.interpreterBasis,input:s.input,material:s.material,drainage:s.drainage,...(s.underlay?{underlay:s.underlay}:{})};must(same(from,shadow),'upgrade-fork')}
}
export async function prepareAppliedRoofList(raw){
 try{
  must(isPhysicalPlanJson(raw)&&allowed(raw,['prior','record','addRole','upgradeFrom','legacyEaveChoice'],['prior','record']),'prepare-input');const input=copy(raw);
  must(input.addRole===undefined||ROLES.includes(input.addRole),'role');must(input.legacyEaveChoice===undefined||input.legacyEaveChoice==='keep-separate','legacy-eave');
  const c=await read(Array.isArray(input.prior)?legacyCarrier(input.prior):input.prior),r=await readRoofPhysicalRecord(input.record);if(!r.ok)throw r;const record=r.record;
  const existing=c.records.find(e=>e.id===record.id);if(existing)must(record.revision>existing.revision||same(record,existing.record),'stale-update');
  const entries=[],roles=new Set();let upgraded=false;
  for(const [index,p]of c.parts.entries()){
   const m=p.takmodell;if(isV4(p)&&m.ref.id===record.id){must(input.upgradeFrom===undefined,'upgrade-existing');entries.push({index,role:m.role,id:p.id,legacyNotes:m.legacyNotes});roles.add(m.role);}
   else if(legacyRoot(p)===record.id){
    must(input.upgradeFrom!==undefined,'explicit-upgrade');checkUpgrade(input.upgradeFrom,record);
    must(allowed(p,['id','title','short','ctx','notes','rows','takmodell'],['id','title','rows','takmodell'])&&allowed(m,['version','role','state','settings','legacyNotes'],['version','role','state','settings'])&&m.version===input.upgradeFrom.version&&same(m.state,input.upgradeFrom)&&['material','drainage','eave'].includes(m.role)&&(m.version===3||m.role!=='eave')&&!roles.has(m.role)&&settings(m.settings),'legacy-upgrade');
    entries.push({index,role:m.role,id:p.id,legacyNotes:upgradeNotes(p)});roles.add(m.role);upgraded=true;
   }
  }
  must(input.upgradeFrom===undefined||upgraded,'upgrade-missing');
  if(input.addRole&&!roles.has(input.addRole)){must(c.parts.length<200,'part-limit');entries.push({index:c.parts.length,role:input.addRole,id:record.id+':'+input.addRole});roles.add(input.addRole)}
  must(entries.length>0,'no-part');
  for(const e of entries){must(partId(e.id),'part-id');const count=c.parts.filter(p=>Object.hasOwn(p,'id')&&String(p.id)===String(e.id)).length;must(count===(e.index===c.parts.length?0:1),'part-id-conflict')}
  if(roles.has('eave')&&input.legacyEaveChoice!=='keep-separate')must(!c.parts.some(p=>!isV4(p)&&legacyRoot(p)!==record.id&&Array.isArray(p.rows)&&p.rows.some(row=>object(row)&&typeof row.k==='string'&&/fotplåt|takfotskil|fotplåtsremsa/i.test(row.k))),'ambiguous-legacy-eave');
  for(const e of entries)c.parts[e.index]=await buildPart(record,e.role,e.id,e.legacyNotes);
  const item={...ref(record),record:copy(record)},i=c.records.findIndex(e=>e.id===record.id);if(i<0)c.records.push(item);else c.records[i]=item;
  const carrier=await read(c);return {ok:true,carrier,updatedPartIds:entries.map(e=>e.id),completePurchasePlan:false};
 }catch(e){return fail(e)}
}
export async function removeAppliedRoofPart(raw){
 try{
  must(isPhysicalPlanJson(raw)&&allowed(raw,['carrier','index','removePlan'],['carrier','index']),'remove-input');const input=copy(raw);
  must(Number.isSafeInteger(input.index)&&input.index>=0&&(input.removePlan===undefined||typeof input.removePlan==='boolean'),'remove-input');
  const c=await read(input.carrier);must(input.index<c.parts.length,'remove-index');const p=c.parts[input.index];
  if(isV4(p)){
   const id=p.takmodell.ref.id,related=c.parts.filter(p=>isV4(p)&&p.takmodell.ref.id===id);
   must(related.length>1||input.removePlan===true,'last-raw-reference');
   if(input.removePlan===true){c.parts=c.parts.filter(p=>!isV4(p)||p.takmodell.ref.id!==id);c.records=c.records.filter(e=>e.id!==id)}else c.parts.splice(input.index,1);
  }else{must(input.removePlan!==true,'not-applied-plan');c.parts.splice(input.index,1)}
  return {ok:true,carrier:await read(c),completePurchasePlan:false};
 }catch(e){return fail(e)}
}
