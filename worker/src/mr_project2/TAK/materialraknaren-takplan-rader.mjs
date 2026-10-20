import {roofSavedBattenPurchases} from './materialraknaren-takplan-inkop.mjs';
import {isPhysicalPlanJson} from './materialraknaren-takplan-record.mjs';

// Typed rows for the new applied carrier. Never pass these through legacy
// label/regex list normalizers. The complete record belongs to that carrier,
// not to a financial row; quantity and display are not product identity.
export const ROOF_BATTEN_ROW_BASIS=Object.freeze({model:'saved-batten-rows-1',purchase:'584f31c66cf972ffac57251ab1486afa249381d817541f83944148c4ee7deecb',identity:'mr-roof-article-1'});
const encoder=new TextEncoder(),copy=v=>JSON.parse(JSON.stringify(v));
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,names)=>object(v)&&Object.keys(v).length===names.length&&names.every(k=>Object.hasOwn(v,k));
const must=v=>{if(!v)throw Error('roof-typed-row')};
const fail=()=>({ok:false,issues:[{field:'physicalPlan',code:'roof-typed-row',message:'Takets sparade artikelunderlag stämmer inte. Tidigare lista, priser och kapplan finns kvar utan ändring.'}]});
const text=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max&&v.trim()===v;
const nullable=(v,max)=>v===null||text(v,max);
const int=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
function canonical(v){
 if(v===null||typeof v!=='object')return JSON.stringify(v);
 if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
 return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
}
const fields={timber:['sectionMm','grade','sku','stockUsableMm','packSize'],'normal-fixing':['sku','dimension','corrosion','packSize','projectReference'],'temporary-fixing':['sku','reference','packSize']};
function identity(raw){
 must(isPhysicalPlanJson(raw)&&exact(raw,['kind','profile','article']));
 must(typeof raw.kind==='string'&&Object.hasOwn(fields,raw.kind)&&['palema','exklusiv','carisma'].includes(raw.profile));
 const a=raw.article;must(exact(a,fields[raw.kind]));
 must(a.packSize===null||int(a.packSize,1,1000000));
 if(raw.kind==='timber'){
  must(Array.isArray(a.sectionMm)&&a.sectionMm.length===2&&a.sectionMm.every(x=>typeof x==='number'&&x>0&&x<=1000));
  must(nullable(a.grade,80)&&nullable(a.sku,160)&&int(a.stockUsableMm,1,100000));
 }else if(raw.kind==='normal-fixing')must(nullable(a.sku,240)&&nullable(a.dimension,240)&&nullable(a.corrosion,240)&&nullable(a.projectReference,240));
 else must(a.packSize===null&&nullable(a.sku,240)&&text(a.reference,240));
 return copy(raw);
}
export async function roofArticlePriceKey(raw){
 try{
  const value=identity(raw),json=canonical(value);must(globalThis.crypto?.subtle);
  const digest=await globalThis.crypto.subtle.digest('SHA-256',encoder.encode('mr-roof-article\n1\n'+json));
  return {ok:true,priceKey:[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join(''),canonical:json};
 }catch{return fail()}
}
function groupedChecks(entries){
 const groups=new Map();
 for(const e of entries){
  must(exact(e,Object.hasOwn(e,'rowId')?['faceId','rowId','code','message']:['faceId','code','message']));
  must(text(e.faceId,80)&&text(e.code,160)&&text(e.message,1200)&&(e.rowId===undefined||text(e.rowId,1000)));
  const key=JSON.stringify([e.code,e.message]);
  if(!groups.has(key))groups.set(key,{code:e.code,message:e.message,associations:[]});
  const g=groups.get(key),association={faceId:e.faceId,rowId:e.rowId??null};
  if(!g.associations.some(a=>a.faceId===association.faceId&&a.rowId===association.rowId))g.associations.push(association);
 }
 must(groups.size<=20);return [...groups.values()];
}
export async function savedRoofBattenRows(raw){
 try{
  // The approved reader detaches and checks the entire record synchronously
  // before its first await; nothing below reads caller-owned data afterward.
  const p=await roofSavedBattenPurchases(raw);must(p.ok&&p.canApplyPurchase&&p.unresolved.length===0&&p.rows.length<=200);
  const rows=[];
  for(const row of p.rows){
   must(int(row.quantity,0,Number.MAX_SAFE_INTEGER));
   const article=copy(row.article),keyArticle=copy(article);
   if(row.kind==='timber'){must(text(article.label,160));delete keyArticle.label;}
   const key=await roofArticlePriceKey({kind:row.kind,profile:p.profile,article:keyArticle});must(key.ok);
   const unit=row.kind==='temporary-fixing'||article.packSize===null?'st':'förp';must(row.unit===unit);
   const k=row.kind==='timber'?article.label:row.kind==='normal-fixing'?'Infästning för bärläkt':'Tillfällig infästning för ströläkt';
   rows.push({k,v:row.quantity,u:unit,sub:'Köpantal från sparad takplan. Kontrollera artikel och projektförutsättningar.',roofArticle:{version:1,kind:row.kind,profile:p.profile,article},priceKey:key.priceKey,physicalRef:{rowId:row.id,faceId:row.faceId,recordRef:copy(p.recordRef)}});
  }
  const result={ok:true,format:'mr-roof-batten-rows',version:1,basis:{...ROOF_BATTEN_ROW_BASIS},recordRef:copy(p.recordRef),rows,requiredChecks:groupedChecks(p.requiredChecks),canApplyPurchase:true,completePurchasePlan:false};
  must(encoder.encode(JSON.stringify(result)).length<=262144);return result;
 }catch{return fail()}
}
export async function readSavedRoofBattenRows(raw){
 try{
  must(isPhysicalPlanJson(raw)&&exact(raw,['record','projection']));
  // Capture both sides before validation awaits. A self-hashed SKU or amount
  // cannot substitute for the approved saved-record projection.
  const {record,projection}=copy(raw);must(encoder.encode(JSON.stringify(projection)).length<=262144);
  const actual=await savedRoofBattenRows(record);must(actual.ok&&canonical(actual)===canonical(projection));
  return {ok:true,projection:actual};
 }catch{return fail()}
}
