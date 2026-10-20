import {isRoofJson} from './materialraknaren-json-contract.mjs';
import {validateRoofStateV3} from './materialraknaren-takresa-state-v3.mjs';
import {readSavedBattenRoof} from './materialraknaren-takplan-lasning.mjs';
import {packSupportedBattenPlan,unpackSupportedBattenPlan} from './materialraknaren-takplan-tabell.mjs';

// Immutable physical-result snapshot; V4 stores/project2 consumers are separate.
// A checksum binds saved values to the accepted base. It authenticates neither
// site measurements nor structural capacity and never replaces semantic checks.
export const ROOF_PHYSICAL_BASIS=Object.freeze({model:'roof-physical-1',reader:'b0fba95e21a539907d662e2c1e639ec36a18ffd450d939c92953d2dedd4ac469',transport:'e1a1631284f23c86400c07a763564f985427298c7fd5a0fb454fa0619a92fa8a',stock:'24895a135309ebc9a1b7633bf586e67d77da28361e65ef4c6e1c0b020657f10f',json:'4b9ce05cc8cd5843d4cef68b0084379a28c48938d9ab02439ef67337d0dae72c',geometry:'d27f9743344287a9837c276557443b6e962b5717bf4bbed4feb5e65df48121ee',baseState:'013193e9446c0a00dca56994a8857561e5e584422549730ab3fdb17af6bcaaa6'});
const MAX=131072,encoder=new TextEncoder(),object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,n)=>object(v)&&Object.keys(v).length===n.length&&n.every(k=>Object.hasOwn(v,k));
const must=(v,code='saved-physical')=>{if(!v)throw Error(code)},copy=v=>JSON.parse(JSON.stringify(v));
const fail=e=>({ok:false,issues:[{field:'physicalPlan',code:e instanceof Error?e.message:'saved-physical',message:'Den sparade takplanens version, grundmått eller kontrollsumma stämmer inte. Tidigare underlag finns kvar utan omräkning.'}]});
export function isPhysicalPlanJson(raw){
 // Check before any JSONcopy: stringify would otherwise silently turn -0 to0.
 // This guard has the JSON tree limits, not the persisted-packet byte cap;
 // unpacked valid producer arguments can be larger than their saved packet.
 if(!isRoofJson(raw))return false;
 const visit=v=>typeof v==='number'?!Object.is(v,-0):v===null||typeof v!=='object'||Object.values(v).every(visit);
 return visit(raw);
}
function canonical(raw){
 must(isPhysicalPlanJson(raw),'physical-json');
 const walk=v=>{
  if(typeof v==='number'){must(!Object.is(v,-0),'physical-json');return JSON.stringify(v)}
  if(v===null||typeof v!=='object')return JSON.stringify(v);
  if(Array.isArray(v))return '['+v.map(walk).join(',')+']';
  // Serialize pairs directly: JSON.stringify(object) would reorder integer-like
  // property keys numerically even after inserting them in UTF16 sort order.
  return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+walk(v[k])).join(',')+'}';
 };
 const json=walk(raw);must(encoder.encode(json).length<=MAX,'physical-size');return json;
}
export function canonicalRoofJson(raw){try{return {ok:true,json:canonical(raw)}}catch(e){return fail(e)}}
async function sha(raw){
 must(globalThis.crypto?.subtle,'physical-crypto');
 const result=await globalThis.crypto.subtle.digest('SHA-256',encoder.encode(raw));return [...new Uint8Array(result)].map(n=>n.toString(16).padStart(2,'0')).join('');
}
const domains={state:'mr-roof-state\n3\n',physical:'mr-roof-physical\n1\n'};
async function digest(raw,kind){must(typeof kind==='string'&&Object.hasOwn(domains,kind),'physical-domain');const json=canonical(raw);return sha(domains[kind]+json)}
export async function roofPhysicalDigest(raw,kind){try{return {ok:true,sha256:await digest(raw,kind)}}catch(e){return fail(e)}}
export async function roofRawLegacyDigest(raw){
 try{
  must(typeof raw==='string','physical-legacy');
  // TextEncoder replaces lone UTF16 surrogates with U+FFFD. Reject those raw
  // slots rather than claim different original strings have exact UTF8 hashes.
  // The caller keeps the original slot; JSON.stringify values use escapes.
  for(let i=0;i<raw.length;i++){
   const n=raw.charCodeAt(i);
   if(n>=0xD800&&n<=0xDBFF){const next=raw.charCodeAt(++i);must(next>=0xDC00&&next<=0xDFFF,'physical-legacy-unicode')}
   else must(n<0xDC00||n>0xDFFF,'physical-legacy-unicode');
  }
  must(encoder.encode(raw).length<=MAX,'physical-legacy');return {ok:true,sha256:await sha(raw)};
 }catch(e){return fail(e)}
}
function base(raw){
 must(isPhysicalPlanJson(raw),'physical-json');const r=validateRoofStateV3(raw);must(r.ok,'physical-base');
 must(canonical(raw)===canonical(r.state),'physical-base');
 const s=copy(raw);must(s.material?.covering==='tiles'&&['palema','exklusiv','carisma'].includes(s.material.profile),'physical-profile');return s;
}
function structure(record,s){
 must(exact(record,['format','version','basis','context','faces','sha256'])&&record.format==='mr-roof-physical'&&record.version===1,'physical-format');
 must(canonical(record.basis)===canonical(ROOF_PHYSICAL_BASIS),'physical-basis');
 const c=record.context;must(exact(c,['roofId','revision','baseSha256','profile'])&&c.roofId===s.id&&c.revision===s.revision&&c.profile===s.material.profile&&typeof c.baseSha256==='string'&&/^[0-9a-f]{64}$/.test(c.baseSha256),'physical-context');
 must(typeof record.sha256==='string'&&/^[0-9a-f]{64}$/.test(record.sha256)&&Array.isArray(record.faces),'physical-digest');
 must(encoder.encode(JSON.stringify(record)).length<=MAX,'physical-size');
 const faces=record.faces.map(f=>{
  must(exact(f,['faceId','packet']),'physical-face');const r=unpackSupportedBattenPlan(f.packet);must(r.ok,'physical-table');return {faceId:f.faceId,plan:r.plan};
 });
 const read=readSavedBattenRoof({input:s.input,profile:s.material.profile,faces});must(read.ok,'physical-relations');return read.faces;
}
export async function prepareSavedPhysicalPlan(raw){
 try{
  must(isPhysicalPlanJson(raw)&&exact(raw,['acceptedRoofState','faces']),'physical-input');
  // Snapshot before the first asynchronous hash. Later caller edits cannot
  // alter a record in preparation; store-generation guards still belong to
  // the eventual caller immediately before its actual write.
  const saved=copy(raw),s=base(saved.acceptedRoofState);must(Array.isArray(saved.faces),'physical-face');
  const r=readSavedBattenRoof({input:s.input,profile:s.material.profile,faces:saved.faces});must(r.ok,'physical-relations');
  const faces=r.faces.map(f=>{const p=packSupportedBattenPlan(f.plan);must(p.ok,'physical-table');return {faceId:f.faceId,packet:p.packet}});
  const payload={format:'mr-roof-physical',version:1,basis:{...ROOF_PHYSICAL_BASIS},context:{roofId:s.id,revision:s.revision,baseSha256:await digest(s,'state'),profile:s.material.profile},faces};
  const record={...payload,sha256:await digest(payload,'physical')};must(encoder.encode(JSON.stringify(record)).length<=MAX,'physical-size');return {ok:true,record};
 }catch(e){return fail(e)}
}
export async function readSavedPhysicalPlan(raw){
 try{
  must(isPhysicalPlanJson(raw)&&exact(raw,['acceptedRoofState','record']),'physical-input');
  const saved=copy(raw),s=base(saved.acceptedRoofState),record=saved.record,faces=structure(record,s);
  must(record.context.baseSha256===await digest(s,'state'),'physical-base-digest');
  const {sha256,...payload}=record;must(sha256===await digest(payload,'physical'),'physical-digest');
  return {ok:true,record,faces,completePurchasePlan:false};
 }catch(e){return fail(e)}
}
