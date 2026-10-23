import {validera,tillKalkyl} from '../P4_PROJEKT/pro-projekt.mjs';
import {readRoofProject} from '../P4_PROJEKT/pro-projekt-v2.mjs';
import {isRoofJson} from '../P4_PROJEKT/pro-json.mjs';
import {offert} from '../P1_KALKYLKARNA/pro-kalkyl.mjs';

const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const must=(x,code)=>{if(!x)throw Error(code);};
const text=(x,max=160)=>typeof x==='string'&&x.trim()===x&&x.length>0&&x.length<=max;
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const revision=x=>Number.isSafeInteger(x)&&x>=1&&x<=1e9;
const provider=x=>['fortnox','spiris'].includes(x);
const canonical=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(canonical).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
const fail=e=>({ok:false,code:e instanceof Error?e.message:'EXPORT'});
const bytes=x=>new TextEncoder().encode(x).length;
function snapshot(raw){
 must(isRoofJson(raw),'JSON_SHAPE');
 const json=JSON.stringify(raw,(_,value)=>{must(!Object.is(value,-0),'JSON_SHAPE');return value;});
 must(bytes(json)<=1048576,'EXPORT_SIZE');return JSON.parse(json);
}
const same=(a,b)=>canonical(a)===canonical(b);
async function sha256(x){return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(x))))].map(x=>x.toString(16).padStart(2,'0')).join('');}
function frozen(x){if(x&&typeof x==='object'){for(const v of Object.values(x))frozen(v);Object.freeze(x);}return x;}
function date(x){return typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(x+'T12:00:00Z'))&&new Date(x+'T12:00:00Z').toISOString().slice(0,10)===x;}
function monetarySafety(value){
 if(!value||typeof value!=='object')return;
 for(const [key,v]of Object.entries(value)){
  if(key.endsWith('_ore')&&v!==null)must(Number.isSafeInteger(v),'UNSAFE_ORE');
  else if(v&&typeof v==='object')monetarySafety(v);
 }
}
async function validatedProject(p){
 must(object(p)&&Array.isArray(p.material)&&Array.isArray(p.arbete)&&Array.isArray(p.ovrigt),'PROJECT');
 must(/^p_[a-f0-9]{32}$/.test(p.projektId)&&revision(p.revision),'IDENTITY');
 must(date(p.datum)&&date(p.giltig_till)&&p.giltig_till>=p.datum,'DATE');
 must(object(p.kund)&&text(p.kund.namn,200)&&object(p.foretag)&&text(p.foretag.namn,200),'CUSTOMER_SUPPLIER');
 if(p.version===2){const r=await readRoofProject(p);must(r.ok,'PROJECT');return r.project;}
 must(p.version===1&&validera(p).ok,'PROJECT');
 // V1's permissive old validator cannot validate newer typed roof identities.
 must(p.material.every(m=>!Object.hasOwn(m,'takartikel')&&!String(m.nyckel).startsWith('n:roof:'))&&(p.raknarlista==null||Array.isArray(p.raknarlista)),'PROJECT_VERSION');
 return p;
}
/** A separate, internal export snapshot. No saved project/quote schema changes,
 * storage, clock, network, generated IDs or provider payload fields. */
export async function freezeOfferExport(raw){
 try{
  const captured=snapshot(raw),p=await validatedProject(captured),input=JSON.parse(JSON.stringify(tillKalkyl(p))),result=offert(input);
  must(result.total_status==='COMPLETE'&&result.rows.length>0,'NOT_COMPLETE');
  monetarySafety(result);
  must(Object.values(result.totals).every(v=>typeof v!=='number'||Number.isSafeInteger(v)&&v>=0),'UNSAFE_ORE');
  const body={format:'mr-offer-export',version:1,audience:'internal-transfer',identity:{offerId:p.projektId,offerVersion:p.revision},currency:'SEK',source:{project:p,input,result}};
  const sha=await sha256(body);return {ok:true,offer:frozen({...body,sha256:sha})};
 }catch(e){return fail(e);}
}
/** Revalidate original saved source and actual P1 result, not just a supplied hash.
 * A digest is integrity/provenance, never an account permission or signature. */
export async function readFrozenOffer(raw){
 try{
  const p=snapshot(raw);
  must(exact(p,['format','version','audience','identity','currency','source','sha256'])&&p.format==='mr-offer-export'&&p.version===1&&p.audience==='internal-transfer'&&p.currency==='SEK'&&digest(p.sha256),'FROZEN_SHAPE');
  must(exact(p.source,['project','input','result']),'FROZEN_SHAPE');
  const expected=await freezeOfferExport(p.source.project);must(expected.ok,'FROZEN_SOURCE');
  must(same(p,expected.offer),'FROZEN_MISMATCH');return {ok:true,offer:expected.offer};
 }catch(e){return fail(e);}
}
function checkedOptions(raw){
 const p=snapshot(raw);
 must(exact(p,['provider','tenantId','receipts','allowNewVersion'])&&provider(p.provider)&&text(p.tenantId)&&typeof p.allowNewVersion==='boolean'&&Array.isArray(p.receipts)&&p.receipts.length<=1000,'TRANSFER_OPTIONS');
 const seen=new Set();
 for(const r of p.receipts){
  must(exact(r,['provider','tenantId','offerId','offerVersion','sha256','status','remoteId'])&&provider(r.provider)&&text(r.tenantId)&&/^p_[a-f0-9]{32}$/.test(r.offerId)&&revision(r.offerVersion)&&digest(r.sha256)&&['prepared','unknown','exported','rejected'].includes(r.status),'RECEIPT');
  must(r.status==='exported'?text(r.remoteId,200):r.remoteId===null,'RECEIPT');
  const key=JSON.stringify([r.provider,r.tenantId,r.offerId,r.offerVersion]);must(!seen.has(key),'DUPLICATE_RECEIPT');seen.add(key);
 }
 return p;
}
/** Pure local planning only. Integrator must atomically reserve the key in the
 * correct authenticated company before any real creation. An ambiguous timeout
 * must reconcile; this function makes no remote exactly-once guarantee. */
export async function planOfferTransfer(raw,options){
 try{
  const captured=snapshot(raw),p=checkedOptions(options),r=await readFrozenOffer(captured);must(r.ok,'FROZEN_SOURCE');
  const offer=r.offer,{offerId,offerVersion}=offer.identity;
  const key=JSON.stringify([p.provider,p.tenantId,offerId,offerVersion]);
  const prior=p.receipts.filter(x=>x.provider===p.provider&&x.tenantId===p.tenantId&&x.offerId===offerId),current=prior.find(x=>x.offerVersion===offerVersion);
  const result=(status,remoteId=null)=>frozen({ok:true,status,canCreate:status==='READY_TO_PREPARE',localTransferKey:key,snapshotSha256:offer.sha256,remoteId,requiresAtomicReservation:status==='READY_TO_PREPARE',remoteIdempotencyGuaranteed:false});
  if(current){
   if(current.sha256!==offer.sha256)return result('CONFLICT');
   if(current.status==='exported')return result('ALREADY_EXPORTED',current.remoteId);
   if(current.status==='prepared'||current.status==='unknown')return result('RECONCILE');
  }
  if(prior.some(x=>x.offerVersion>offerVersion))return result('CONFLICT');
  if(prior.some(x=>['prepared','unknown'].includes(x.status)))return result('RECONCILE');
  if(prior.some(x=>x.offerVersion<offerVersion&&x.status==='exported')&&!p.allowNewVersion)return result('NEW_VERSION_REQUIRES_CONFIRMATION');
  return result('READY_TO_PREPARE');
 }catch(e){return fail(e);}
}
