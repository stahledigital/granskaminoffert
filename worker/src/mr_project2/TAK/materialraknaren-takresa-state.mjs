import {roofGeometry} from './materialraknaren-takmodell.mjs';
import {roofMaterialBasis} from './materialraknaren-takmaterial.mjs';
import {roofDrainage,drainageTable} from './materialraknaren-takavvattning.mjs';
import {roofUnderlayPlan} from './materialraknaren-underlagsplan.mjs';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x),copy=x=>structuredClone(x),equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=(field,code,message)=>({ok:false,issues:[{field,code,message}]});
const keys=(o,allowed)=>object(o)&&Object.keys(o).every(k=>allowed.includes(k));
export const ROOF_BASIS=Object.freeze({geometry:'d27f9743344287a9837c276557443b6e962b5717bf4bbed4feb5e65df48121ee',material:'306f74374298297b5b007b4c4b12175dadf0b017f033307cddc3bdc9f0a3c46b',drainage:'ed4174df2ba05801fe5a0402a5678a8a6e144ff075722e9190a8b138f531b529',projection:'3acd2799e896478de745f6279ec36aad74f4ea69c410ae48dc6d56f193614fc2',conditions:'48f63cef644ec294c6dc6dc5c5354168f90d85269b2c2c2acdd58b331b3fa439'});
const MATERIAL=['covering','profile','gaugeMm','perM2','wastePct','ridgePerM','ridgePackSize','windExposed'];
const INPUT=['plan','form','length','width','extension','pitch','eaveOverhang','gableOverhang'];
export const ROOF_UNDERLAY_BASIS=Object.freeze({underlay:'e70aea3774d5d4dd7932a61b1d24c5a86e9f82b23a40384a130736541d22f9d2',underlayProjection:'9cafa52014df1079c2afa162fe1dc3ccc3d298613feae908f965dfe443b12d9a'});
// Applied snapshots contain JSON values only, including inactive covering settings.
const materialTypes=m=>Object.entries(m).every(([k,v])=>k==='covering'?['tiles','membrane'].includes(v):k==='profile'?['palema','exklusiv','custom'].includes(v):k==='windExposed'?typeof v==='boolean':typeof v==='number'&&Number.isFinite(v)&&(k==='wastePct'?v>=0&&v<=100:k==='ridgePackSize'?Number.isSafeInteger(v)&&v>=1&&v<=1000:v>0&&v<=(k==='ridgePerM'?100:1000)));
const systemValid=s=>keys(s,['profile','gutter','pipe','placement'])&&['','plastmo-plastic','plannja-2026'].includes(s.profile)&&['100','125','150','190'].includes(s.gutter)&&['75','90','100','110','120'].includes(s.pipe)&&['','A','B','C'].includes(s.placement);

/** Versioned applied inputs only: never trust stored areas, rows or table results.
 * Mutable UI drafts stay outside this saved calculation snapshot. A list part
 * carries a copy of the snapshot it was actually calculated from.
 */
export function validateRoofState(raw){
  try{
    if(!keys(raw,['format','version','id','revision','basis','input','material','drainage','underlay'])||raw.format!=='mr-roof-state'||raw.version!==1||typeof raw.id!=='string'||!/^r_[0-9a-f]{32}$/.test(raw.id)||!Number.isSafeInteger(raw.revision)||raw.revision<1||raw.revision>1e9)return fail('snapshot','snapshot','Den sparade takmodellen har ett format som inte kan öppnas. Materiallistan finns kvar.');
    const selected=raw.underlay!==undefined&&raw.underlay!==null,basis={...ROOF_BASIS,...(selected?ROOF_UNDERLAY_BASIS:{})};
    if(!keys(raw.basis,Object.keys(basis))||Object.keys(basis).some(k=>raw.basis[k]!==basis[k]))return fail('basis','basis-version','Takmodellen hör till en annan beräkningsversion. Dina sparade materialrader finns kvar och har inte räknats om.');
    if(JSON.stringify(raw).length>32768||!keys(raw.input,INPUT))return fail('snapshot','size','Takmodellen är för stor eller innehåller okända fält.');
    const geometry=roofGeometry(raw.input);if(!geometry.ok)return geometry;
    if(raw.material!==null){if(!keys(raw.material,MATERIAL)||!materialTypes(raw.material))return fail('material','material','Takets sparade materialval kan inte läsas.');const result=roofMaterialBasis(geometry.input,raw.material);if(!result.ok)return result;}
    if(selected){if(raw.material?.covering!=='tiles')return fail('underlay','underlay-covering','Underlagspapp YAP2200 används under pannor, inte som exponerad taktäckning.');const plan=roofUnderlayPlan(geometry.input,raw.underlay);if(!plan.ok)return plan;}
    if(raw.drainage!==null){const check=checkDrainage(geometry.input,raw.drainage);if(!check.ok)return check;}
    return {ok:true,state:{format:'mr-roof-state',version:1,id:raw.id,revision:raw.revision,basis,input:copy(geometry.input),material:raw.material===null?null:copy(raw.material),drainage:raw.drainage===null?null:copy(raw.drainage),...(selected?{underlay:copy(raw.underlay)}:{})}};
  }catch{return fail('snapshot','snapshot','Takmodellen kunde inte läsas. Dina sparade materialrader finns kvar.');}
}
export function createRoofState({id,input,material=null,underlay=null}={}){return validateRoofState({format:'mr-roof-state',version:1,id,revision:1,basis:{...ROOF_BASIS,...(underlay!==null?ROOF_UNDERLAY_BASIS:{})},input,material,drainage:null,...(underlay!==null?{underlay}:{})});}
export function changeRoofState(raw,input,{replaceDrainage=false}={}){
  const old=validateRoofState(raw);if(!old.ok)return old;const g=roofGeometry(input);if(!g.ok)return g;
  if(equal(g.input,old.state.input))return old;
  if(old.state.drainage&&!replaceDrainage)return fail('input','drainage-exists','Takmåtten ändras. Dina rörlägen finns kvar på det tidigare taket. Välj uttryckligen att ersätta dem innan du använder det nya taket.');
  return validateRoofState({...old.state,revision:old.state.revision+1,input:g.input,drainage:null});
}
function checkDrainage(input,raw){
  if(!keys(raw,['routing','system'])||!systemValid(raw.system)||!keys(raw.routing,['gutters','valleyRoutes']))return fail('drainage','drainage','Rörlägen och systemval behöver anges i det sparade formatet.');
  if(!Array.isArray(raw.routing.gutters)||raw.routing.gutters.some(g=>!keys(g,['edgeId','outlets','divides'])||!Array.isArray(g.outlets)||g.outlets.some(p=>!keys(p,['id','at']))))return fail('drainage','drainage','De sparade rännsträckorna kan inte läsas.');
  if(!Array.isArray(raw.routing.valleyRoutes)||raw.routing.valleyRoutes.some(v=>!keys(v,['edgeId','receiverEdgeId'])))return fail('drainage','drainage','Ränndalens mottagare kan inte läsas.');
  const result=roofDrainage(input,raw.routing);if(!result.ok)return result;
  if(!result.routingComplete)return fail('drainage','routing-incomplete','Alla avrinningsytor behöver en vald väg till stuprör.');
  const placed=[];
  for(const g of result.gutters)for(const p of g.outlets){const point=p.at===0?g.from:p.at===g.length?g.to:g.from.map((v,i)=>v+(g.to[i]-v)*p.at/g.length);const prior=placed.find(x=>x.edgeId!==g.edgeId&&equal(x.point,point));if(prior)return fail('outlets','shared-corner',`${prior.id} och ${p.id} ligger på samma hörnpunkt. Ett gemensamt hörnrör behöver separat planering.`);placed.push({id:p.id,point,edgeId:g.edgeId});}
  return result;
}
export function applyDrainageState(raw,payload){
  const old=validateRoofState(raw);if(!old.ok)return old;
  if(!keys(payload,['version','input','routing','system'])||payload.version!==undefined&&payload.version!==1)return fail('drainage','drainage','Rörlägena har ett okänt format.');
  const g=roofGeometry(payload.input);if(!g.ok)return g;if(!equal(g.input,old.state.input))return fail('input','different-roof','Rörlägena hör till andra takmått. Använd samma takmodell i båda vyerna.');
  const drainage={routing:payload.routing,system:payload.system},check=checkDrainage(g.input,drainage);if(!check.ok)return check;
  if(equal(old.state.drainage,drainage))return old;
  return validateRoofState({...old.state,revision:old.state.revision+1,drainage});
}
export function roofStateBasis(raw){
  const valid=validateRoofState(raw);if(!valid.ok)return valid;const s=valid.state,geometry=roofGeometry(s.input),material=s.material?roofMaterialBasis(s.input,s.material):null,drainage=s.drainage?checkDrainage(s.input,s.drainage):null;
  const tables=[];
  if(drainage&&s.drainage.system.profile)for(const g of drainage.gutters)for(const p of g.outlets){const system=s.drainage.system;tables.push({edgeId:g.edgeId,pipeId:p.id,result:drainageTable({profile:system.profile,gutter:Number(system.gutter),pipe:Number(system.pipe),placement:system.placement,areaSlope:p.areaSlope})});}
  const underlay=s.underlay?roofUnderlayPlan(s.input,s.underlay):null;
  return {ok:true,state:s,geometry,material,drainage,tables,underlay,completePurchasePlan:false};
}
