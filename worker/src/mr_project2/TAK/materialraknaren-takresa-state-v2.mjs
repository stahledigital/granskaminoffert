import {isRoofJson} from './materialraknaren-json-contract.mjs';
// Explicit V2 input snapshot. Frozen V1 modules remain the interpreter of V1.
import {roofGeometry} from './materialraknaren-takmodell.mjs';
import {roofMaterialBasisV2} from './materialraknaren-takmaterial-v2.mjs';
import {validateRoofState as validateV1,applyDrainageState as applyV1,roofStateBasis as basisV1,ROOF_BASIS,ROOF_UNDERLAY_BASIS} from './materialraknaren-takresa-state.mjs';
import {roofUnderlayPlan} from './materialraknaren-underlagsplan.mjs';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x),copy=x=>structuredClone(x);
const keys=(o,allowed)=>object(o)&&Object.keys(o).every(k=>allowed.includes(k));
const fail=(field,code,message)=>({ok:false,issues:[{field,code,message}]});
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const ROOF_BASIS_V2=Object.freeze({"projection":"33837d6fc3714eae2f4cbd6f5f83ab3a62d1105584073983563cfe7ed04a20ec","projectionV1":"3acd2799e896478de745f6279ec36aad74f4ea69c410ae48dc6d56f193614fc2","json":"4b9ce05cc8cd5843d4cef68b0084379a28c48938d9ab02439ef67337d0dae72c","geometry":"d27f9743344287a9837c276557443b6e962b5717bf4bbed4feb5e65df48121ee","material":"5253ba0d4fd199c87ab8f67f005965f0a71c70c1bb1105fb329f8ae05084ee99","materialV1":"306f74374298297b5b007b4c4b12175dadf0b017f033307cddc3bdc9f0a3c46b","profiles":"0ce1d935b15d31a8b4b000e737cd167b1dc2a40035c5fe926eb0d5053d7d3e56","drainage":"ed4174df2ba05801fe5a0402a5678a8a6e144ff075722e9190a8b138f531b529","conditions":"48f63cef644ec294c6dc6dc5c5354168f90d85269b2c2c2acdd58b331b3fa439","legacyState":"e96502b12d6b402860474ed6b1ab8d27714776c036d51f74f0440051b8e8ee20"});
const INPUT=['plan','form','length','width','extension','pitch','eaveOverhang','gableOverhang'];
// Used only to retain the tested geometric/drainage validation. No V2 material
// is interpreted by the old engine, and no legacy snapshot is written/migrated.
const shadow=s=>({format:'mr-roof-state',version:1,id:s.id,revision:s.revision,basis:{...ROOF_BASIS},input:s.input,material:null,drainage:s.drainage});
export function validateRoofStateV2(raw){
 try{
  if(!isRoofJson(raw))return fail('snapshot','snapshot-json','Takmodellen behöver giltiga JSON-värden. Tidigare uppgifter finns kvar.');
  if(!keys(raw,['format','version','id','revision','basis','input','material','drainage','underlay'])||raw.format!=='mr-roof-state'||raw.version!==2||typeof raw.id!=='string'||!/^r_[0-9a-f]{32}$/.test(raw.id)||!Number.isSafeInteger(raw.revision)||raw.revision<1||raw.revision>1e9)return fail('snapshot','snapshot','Den sparade takmodellen har ett okänt format. Materialraderna finns kvar.');
  const selected=raw.underlay!==undefined&&raw.underlay!==null,basis={...ROOF_BASIS_V2,...(selected?ROOF_UNDERLAY_BASIS:{})};
  if(!keys(raw.basis,Object.keys(basis))||Object.keys(basis).some(k=>raw.basis[k]!==basis[k]))return fail('basis','basis-version','Takmodellen hör till en annan beräkningsversion. Sparade rader har inte räknats om.');
  if(JSON.stringify(raw).length>32768||!keys(raw.input,INPUT))return fail('snapshot','size','Takmodellen är för stor eller innehåller okända uppgifter.');
  const g=roofGeometry(raw.input);if(!g.ok)return g;
  if(raw.material!==null){
   if(!object(raw.material)||Object.values(raw.material).some(v=>v===undefined))return fail('material','material-json','Takets sparade materialval måste ha giltiga JSON-värden.');
   const material=roofMaterialBasisV2(g.input,raw.material);if(!material.ok)return material;
  }
  if(selected){
   if(raw.material?.covering!=='tiles')return fail('underlay','underlay-covering','Underlagspapp används under pannor, inte som exponerad taktäckning.');
   if(raw.material.profile==='carisma')return fail('underlay','underlay-compatibility','Det valda underlagets likvärdighet med Carismas rekommenderade YEP2500 är inte verifierad. Behåll tidigare underlag eller välj att planera underlaget separat.');
   const plan=roofUnderlayPlan(g.input,raw.underlay);if(!plan.ok)return plan;
  }
  const old=validateV1(shadow({...raw,input:g.input}));if(!old.ok)return old;
  return {ok:true,state:{format:'mr-roof-state',version:2,id:raw.id,revision:raw.revision,basis,input:copy(g.input),material:raw.material===null?null:copy(raw.material),drainage:old.state.drainage,...(selected?{underlay:copy(raw.underlay)}:{})}};
 }catch{return fail('snapshot','snapshot','Takmodellen kunde inte läsas. Sparade rader finns kvar.');}
}
export function createRoofStateV2({id,input,material=null,underlay=null}={}){return validateRoofStateV2({format:'mr-roof-state',version:2,id,revision:1,basis:{...ROOF_BASIS_V2,...(underlay!==null?ROOF_UNDERLAY_BASIS:{})},input,material,drainage:null,...(underlay!==null?{underlay}:{})});}
export function changeRoofStateV2(raw,input,{replaceDrainage=false}={}){
 const old=validateRoofStateV2(raw);if(!old.ok)return old;const g=roofGeometry(input);if(!g.ok)return g;if(equal(g.input,old.state.input))return old;
 if(old.state.drainage&&!replaceDrainage)return fail('input','drainage-exists','Nya takmått kräver ett uttryckligt val att ersätta den tidigare rörplanen. Tidigare mått finns kvar.');
 return validateRoofStateV2({...old.state,revision:old.state.revision+1,input:g.input,drainage:null});
}
export function applyDrainageStateV2(raw,payload){
 const old=validateRoofStateV2(raw);if(!old.ok)return old;const r=applyV1(shadow(old.state),payload);if(!r.ok)return r;
 return validateRoofStateV2({...old.state,revision:r.state.revision,drainage:r.state.drainage});
}
export function roofStateBasisV2(raw){
 const valid=validateRoofStateV2(raw);if(!valid.ok)return valid;const s=valid.state,b=basisV1(shadow(s));if(!b.ok)return b;
 return {...b,state:s,material:s.material?roofMaterialBasisV2(s.input,s.material):null,underlay:s.underlay?roofUnderlayPlan(s.input,s.underlay):null,completePurchasePlan:false};
}
