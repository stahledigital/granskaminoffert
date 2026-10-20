import {validateRoofStateV3} from './materialraknaren-takresa-state-v3.mjs';
import {isPhysicalPlanJson,canonicalRoofJson,roofRawLegacyDigest,readSavedPhysicalPlan} from './materialraknaren-takplan-record.mjs';

export const ROOF_RECORD_V4_BASIS=Object.freeze({model:'roof-physical-record-1',physical:'8b6930853aa31f28a678fce95dc618c2f769d39213a67b7264dc8f00d2444fc0'});
const MAX=131072,encoder=new TextEncoder(),object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v),copy=v=>JSON.parse(JSON.stringify(v));
const exact=(v,n)=>object(v)&&Object.keys(v).length===n.length&&n.every(k=>Object.hasOwn(v,k));
const must=(v,code='INVALID')=>{if(!v)throw Error(code)};
const failure=e=>({ok:false,code:e instanceof Error?e.message:'INVALID',issues:[{field:'physicalPlan',code:e instanceof Error?e.message:'INVALID',message:'Takplanen kunde inte sparas eller verifieras. Tidigare underlag finns kvar utan att ersättas.'}]});
const size=v=>must(encoder.encode(JSON.stringify(v)).length<=MAX,'SIZE');
const hashShape=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
function canonical(v){const r=canonicalRoofJson(v);must(r.ok,r.issues?.[0]?.code==='physical-size'?'SIZE':'INVALID');return r.json}
async function digest(v){
 const json=canonical(v);must(globalThis.crypto?.subtle,'CRYPTO');
 const hash=await globalThis.crypto.subtle.digest('SHA-256',encoder.encode('mr-roof-record\n4\n'+json));return [...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
function state(raw){const r=validateRoofStateV3(raw);must(r.ok&&canonical(r.state)===canonical(raw),'BASE');return copy(raw)}
async function legacyWrap(raw){
 must(exact(raw,['v1','v2','v3']),'LEGACY');const legacy={};
 for(const v of ['v1','v2','v3']){
  const text=raw[v];if(text===null){legacy[v]=null;continue}
  must(typeof text==='string','LEGACY');const h=await roofRawLegacyDigest(text);must(h.ok,'LEGACY');legacy[v]={raw:text,sha256:h.sha256};
 }
 return legacy;
}
export async function prepareRoofPhysicalRecord(raw){
 try{
  must(isPhysicalPlanJson(raw)&&exact(raw,['roofState','physical','legacy','revision']),'INVALID');const input=copy(raw),s=state(input.roofState);
  must(Number.isSafeInteger(input.revision)&&input.revision>=1&&input.revision<=1000000000,'REVISION');
  if(input.physical!==null)must((await readSavedPhysicalPlan({acceptedRoofState:s,record:input.physical})).ok,'PHYSICAL');
  const payload={format:'mr-roof-physical-record',version:4,basis:{...ROOF_RECORD_V4_BASIS},id:s.id,revision:input.revision,roofState:s,legacy:await legacyWrap(input.legacy),physical:input.physical,editor:null};
  size(payload);const record={...payload,sha256:await digest(payload)};size(record);return {ok:true,record};
 }catch(e){return failure(e)}
}
export async function readRoofPhysicalRecord(raw){
 try{
  must(isPhysicalPlanJson(raw),'INVALID');size(raw);const r=copy(raw);
  must(exact(r,['format','version','basis','id','revision','roofState','legacy','physical','editor','sha256'])&&r.format==='mr-roof-physical-record'&&r.version===4&&r.editor===null,'VERSION');
  must(canonical(r.basis)===canonical(ROOF_RECORD_V4_BASIS),'BASIS');const s=state(r.roofState);
  must(r.id===s.id&&Number.isSafeInteger(r.revision)&&r.revision>=1&&r.revision<=1000000000,'REVISION');must(exact(r.legacy,['v1','v2','v3']),'LEGACY');
  for(const v of ['v1','v2','v3']){const old=r.legacy[v];if(old===null)continue;must(exact(old,['raw','sha256'])&&hashShape(old.sha256),'LEGACY');const h=await roofRawLegacyDigest(old.raw);must(h.ok&&h.sha256===old.sha256,'LEGACY');}
  if(r.physical!==null)must((await readSavedPhysicalPlan({acceptedRoofState:s,record:r.physical})).ok,'PHYSICAL');
  must(hashShape(r.sha256),'DIGEST');const {sha256,...payload}=r;must(sha256===await digest(payload),'DIGEST');return {ok:true,record:r};
 }catch(e){return failure(e)}
}
const validScope=s=>typeof s==='string'&&(s==='mr-lista'||/^mr-pro-rakna:(anon|k_[0-9a-f]{32}):p_[0-9a-f]{32}$/.test(s));
function options(raw){
 try{
  if(!object(raw)||![Object.prototype,null].includes(Object.getPrototypeOf(raw)))return null;const out={};
  for(const k of Reflect.ownKeys(raw)){const d=Object.getOwnPropertyDescriptor(raw,k);if(!['storage','scope','isCurrent'].includes(k)||!d?.enumerable||!Object.hasOwn(d,'value'))return null;out[k]=d.value;}
  if(out.isCurrent!==undefined&&typeof out.isCurrent!=='function')return null;return out;
 }catch{return null}
}
function rawSlots(storage,scope){
 const result={};for(const v of ['v1','v2','v3','v4']){const raw=storage.getItem(scope+':takresa-'+v);must(raw===null||typeof raw==='string','READ_ERROR');result[v]=raw}return result;
}
const equalSlots=(a,b)=>['v1','v2','v3','v4'].every(v=>a[v]===b[v]);
const legacyMatches=(r,slots)=>['v1','v2','v3'].every(v=>(r.legacy[v]?.raw??null)===slots[v]);
export async function createRoofPhysicalStore(raw){
 const o=options(raw),storage=o?.storage,scope=o?.scope,current=o?.isCurrent||(()=>true);let saved={status:o?'ABSENT':'INVALID_OPTIONS',record:null},seen=null,generation=0,invalidated=false;
 if(o&&!validScope(scope))saved.status='BLOCKED_SCOPE';
 else if(o){
  try{
   seen=rawSlots(storage,scope);
   if(seen.v4!==null){let record;try{if(encoder.encode(seen.v4).length<=MAX)record=JSON.parse(seen.v4)}catch{}const r=await readRoofPhysicalRecord(record);saved=r.ok?{status:legacyMatches(r.record,seen)?'VALID':'LEGACY_CHANGED',record:r.record}:{status:'INVALID',record:null};}
   if(current(scope)!==true||!equalSlots(seen,rawSlots(storage,scope)))saved.status='STALE_READ';
  }catch{saved={status:'READ_ERROR',record:null}}
 }
 return {
  snapshot(){return copy(saved)},
  invalidate(){invalidated=true;generation++},
  async commit(rawInput){
   // Latest start wins, including when the latest attempt itself is invalid.
   const ticket=++generation;
   try{
    must(!invalidated,'STALE');must(['ABSENT','VALID'].includes(saved.status),saved.status);must(current(scope)===true,'STALE');
    // Compare to this controller's last successful read/save. Capturing fresh
    // bytes here would silently authorize overwriting another controller.
    must(equalSlots(seen,rawSlots(storage,scope)),'STALE_READ');
    must(isPhysicalPlanJson(rawInput)&&exact(rawInput,['roofState','physical']),'INVALID');const input=copy(rawInput);
    if(saved.record)must(input.roofState?.id===saved.record.id,'ROOF_ID');
    const revision=saved.record?saved.record.revision+1:1;
    const r=await prepareRoofPhysicalRecord({...input,legacy:{v1:seen.v1,v2:seen.v2,v3:seen.v3},revision});must(r.ok,r.code);
    must(!invalidated&&ticket===generation,'STALE');must(current(scope)===true,'STALE');
    // A synchronous callback can itself invalidate or start a newer commit.
    must(!invalidated&&ticket===generation,'STALE');
    // No callbacks or await between the final source read and the single set.
    must(equalSlots(seen,rawSlots(storage,scope)),'STALE_READ');const text=JSON.stringify(r.record);
    try{storage.setItem(scope+':takresa-v4',text)}catch{throw Error('STORAGE')}
    seen={...seen,v4:text};saved={status:'VALID',record:r.record};return {ok:true,snapshot:copy(saved)};
   }catch(e){return failure(e)}
  }
 };
}
