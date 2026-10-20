import {isRoofJson} from './materialraknaren-json-contract.mjs';
import {roofGeometry} from './materialraknaren-takmodell.mjs';
import {createRoofState,validateRoofState,roofStateBasis,applyDrainageState} from './materialraknaren-takresa-state.mjs';
import {createRoofStateV2,validateRoofStateV2,roofStateBasisV2,applyDrainageStateV2} from './materialraknaren-takresa-state-v2.mjs';
import {roofEaveDetailPlan} from './materialraknaren-takfot-detalj.mjs';

// An explicit extension of a frozen interpreter, never an implicit V1→V2
// material migration. Applied snapshots contain only validated input data.
export const ROOF_BASIS_V3=Object.freeze({model:'roof-eave-1',projection:'62c52b42865c4811a101eed9b8492989d6bbc5cb65bf2609e686b7ad401c0b4a',json:'4b9ce05cc8cd5843d4cef68b0084379a28c48938d9ab02439ef67337d0dae72c',geometry:'d27f9743344287a9837c276557443b6e962b5717bf4bbed4feb5e65df48121ee',legacyState1:'e96502b12d6b402860474ed6b1ab8d27714776c036d51f74f0440051b8e8ee20',legacyState2:'b8ed4849852b407d93fa7e07f771623815936b6a665359b92736447ee22af90a',eaveAdapter:'19f36d74d2ecf64f48d707a46e1be501fe82ce8053dd9265bc5ad5b0baea2b4f'});
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x),copy=x=>structuredClone(x);
const keys=(x,allowed,required=allowed)=>object(x)&&Object.keys(x).every(k=>allowed.includes(k))&&required.every(k=>Object.hasOwn(x,k));
const stable=x=>JSON.stringify(x,(_k,v)=>object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const equal=(a,b)=>stable(a)===stable(b);
const fail=(field,code,message)=>({ok:false,issues:[{field,code,message}]});
const interpreters={1:{create:createRoofState,validate:validateRoofState,basis:roofStateBasis,drainage:applyDrainageState},2:{create:createRoofStateV2,validate:validateRoofStateV2,basis:roofStateBasisV2,drainage:applyDrainageStateV2}};
const shadow=s=>({format:s.format,version:s.interpreterVersion,id:s.id,revision:s.revision,basis:copy(s.interpreterBasis),input:s.input,material:s.material,drainage:s.drainage,...(s.underlay?{underlay:s.underlay}:{})});
const covering=s=>s.material===null?'unknown':s.material.covering==='tiles'&&['palema','exklusiv','carisma'].includes(s.material.profile)?s.material.profile:'other';
function checkEave(s){
 if(s.eave===null)return {ok:true,plan:null};
 const c=s.eave?.context;
 if(!object(c)||c.roofId!==s.id||c.revision!==s.revision)return fail('eave.context','stale-eave','Takfotsvalet hör till en annan takversion. Öppna den aktuella planen innan du använder det.');
 if(c.covering!==covering(s))return fail('eave.context.covering','different-covering','Takfotsmetoden och takets verkliga materialval stämmer inte överens.');
 if(s.underlay&&c.underlay!=='yap2200')return fail('eave.context.underlay','different-underlay','Takfotsvalet gäller ett annat underlag än takets valda YAP2200-plan.');
 const r=roofEaveDetailPlan(s.input,s.eave);return r.ok?{ok:true,plan:r}:r;
}
function fromLegacy(s,eave=null){return {format:s.format,version:3,id:s.id,revision:s.revision,basis:{...ROOF_BASIS_V3},interpreterVersion:s.version,interpreterBasis:copy(s.basis),input:copy(s.input),material:copy(s.material),drainage:copy(s.drainage),...(s.underlay?{underlay:copy(s.underlay)}:{}),eave};}
function nextRevision(s,changes){
 const next={...s,...changes,revision:s.revision+1};
 if(next.eave!==null)next.eave={...copy(next.eave),context:{...copy(next.eave.context),roofId:next.id,revision:next.revision}};
 return validateRoofStateV3(next);
}
export function validateRoofStateV3(raw){
 try{
  if(!isRoofJson(raw))return fail('snapshot','snapshot-json','Takmodellen behöver giltiga JSON-värden. Tidigare uppgifter finns kvar.');
  if(JSON.stringify(raw).length>32768)return fail('snapshot','size','Takmodellen är för stor. Tidigare uppgifter finns kvar utan att kapas.');
  const required=['format','version','id','revision','basis','interpreterVersion','interpreterBasis','input','material','drainage','eave'];
  if(!keys(raw,[...required,'underlay'],required)||raw.format!=='mr-roof-state'||raw.version!==3||![1,2].includes(raw.interpreterVersion))return fail('snapshot','snapshot','Takets sparade version eller beräkningsmodell kan inte läsas.');
  if(!keys(raw.basis,Object.keys(ROOF_BASIS_V3))||!equal(raw.basis,ROOF_BASIS_V3))return fail('basis','basis-version','Takfotsplanen hör till en annan beräkningsversion. Sparade rader är oförändrade.');
  const old=interpreters[raw.interpreterVersion].validate(shadow(raw));if(!old.ok)return old;
  const state=fromLegacy(old.state,copy(raw.eave)),e=checkEave(state);if(!e.ok)return e;
  return {ok:true,state};
 }catch{return fail('snapshot','snapshot','Takets uppgifter kunde inte läsas. Tidigare underlag finns kvar.');}
}
export function upgradeRoofStateToV3(raw){
 try{
  if(!isRoofJson(raw))return fail('snapshot','snapshot-json','Takets tidigare modell behöver giltiga JSON-värden.');
  if(raw?.version===3)return fail('snapshot','already-v3','Takmodellen använder redan den nya takfotsversionen. Öppna den utan att uppgradera.');
  if(![1,2].includes(raw?.version))return fail('snapshot','unknown-version','Takets tidigare beräkningsversion kan inte öppnas.');
  const old=interpreters[raw.version].validate(raw);if(!old.ok)return old;
  return validateRoofStateV3(fromLegacy({...old.state,revision:old.state.revision+1}));
 }catch{return fail('snapshot','snapshot','Takets tidigare uppgifter kunde inte öppnas.');}
}
export function createRoofStateV3(options={}){
 try{
  if(!isRoofJson(options)||!keys(options,['id','input','material','underlay','interpreterVersion'],['id','input','interpreterVersion'])||![1,2].includes(options.interpreterVersion))return fail('snapshot','interpreter','Välj uttryckligen vilken beräkningsmodell taket ska använda.');
  const old=interpreters[options.interpreterVersion].create({id:options.id,input:options.input,material:options.material??null,underlay:options.underlay??null});
  return old.ok?validateRoofStateV3(fromLegacy(old.state)):old;
 }catch{return fail('snapshot','snapshot','Takets nya uppgifter kunde inte läsas.');}
}
export function applyEaveStateV3(raw,options){
 const old=validateRoofStateV3(raw);if(!old.ok)return old;const s=old.state;
 try{
  if(options!==null){
   if(!isRoofJson(options)||options?.context?.roofId!==s.id||options?.context?.revision!==s.revision)return fail('eave.context','stale-eave','Takfotsvalet hör till en äldre eller annan takversion. Öppna den senaste planen.');
   const e=checkEave({...s,eave:options});if(!e.ok)return e;
  }
  if(equal(s.eave,options))return old;
  return nextRevision(s,{eave:copy(options)});
 }catch{return fail('eave','eave','Takfotsvalet kunde inte användas. Tidigare plan finns kvar.');}
}
export function changeRoofStateV3(raw,input,flags={}){
 const old=validateRoofStateV3(raw);if(!old.ok)return old;const s=old.state;
 try{
  if(!isRoofJson(input)||!isRoofJson(flags)||!keys(flags,['replaceDrainage','replaceEave'],[])||Object.values(flags).some(v=>typeof v!=='boolean'))return fail('input','input','Bekräfta vilka tidigare delplaner som ska ersättas.');
  const g=roofGeometry(input);if(!g.ok)return g;if(equal(g.input,s.input))return old;
  if(s.drainage&&!flags.replaceDrainage)return fail('input','drainage-exists','Nya takmått kräver ett uttryckligt val att ersätta den tidigare rörplanen.');
  if(s.eave&&!flags.replaceEave)return fail('input','eave-exists','Nya takmått kräver ett uttryckligt val att ersätta den tidigare takfotsplanen och uppmätta stöd.');
  return nextRevision(s,{input:g.input,drainage:null,eave:null});
 }catch{return fail('input','input','Takmåtten kunde inte ändras. Tidigare plan finns kvar.');}
}
export function applyDrainageStateV3(raw,payload){
 const old=validateRoofStateV3(raw);if(!old.ok)return old;const s=old.state;
 try{
  if(!isRoofJson(payload))return fail('drainage','drainage','Rörplanen behöver giltiga JSON-värden.');
  const r=interpreters[s.interpreterVersion].drainage(shadow(s),payload);if(!r.ok)return r;
  if(equal(r.state.drainage,s.drainage))return old;
  return nextRevision(s,{drainage:r.state.drainage});
 }catch{return fail('drainage','drainage','Rörplanen kunde inte användas. Tidigare plan finns kvar.');}
}
export function roofStateBasisV3(raw){
 const valid=validateRoofStateV3(raw);if(!valid.ok)return valid;const s=valid.state;
 const b=interpreters[s.interpreterVersion].basis(shadow(s));if(!b.ok)return b;const e=checkEave(s);if(!e.ok)return e;
 return {...b,state:s,legacyState:b.state,eave:e.plan,completePurchasePlan:false};
}
