import {FORMAT,validera as validateV1,slaIhopMedLista} from './pro-projekt.mjs';
import {isPhysicalPlanJson} from '../TAK/materialraknaren-takplan-record.mjs';
import {readAppliedRoofList} from '../TAK/materialraknaren-takresa-applied-list.mjs';
import {roofArticlePriceKey} from '../TAK/materialraknaren-takplan-rader.mjs';

export const ROOF_PROJECT_VERSION=2;
const MAX=262144,encoder=new TextEncoder(),copy=x=>JSON.parse(JSON.stringify(x));
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const must=(x,code='PROJECT')=>{if(!x)throw Error(code)};
const exact=(x,keys)=>object(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const canonical=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(canonical).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
const same=(a,b)=>canonical(a)===canonical(b);
const bytes=x=>encoder.encode(typeof x==='string'?x:JSON.stringify(x)).length;
const failure=e=>({ok:false,code:e instanceof Error?e.message:'PROJECT',fel:['Projektets fullständiga takunderlag eller priser kunde inte uppdateras. Tidigare sparade uppgifter finns kvar.']});
const rowKey=(priceKey,unit)=>'n:roof:'+priceKey+'|'+unit;
const text=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max&&v.trim()===v;
const partId=v=>text(v,200)||typeof v==='number'&&Number.isSafeInteger(v);
function physicalReference(ref,kind,article){
 must(exact(ref,['rowId','faceId','recordRef'])&&text(ref.faceId,80)&&text(ref.rowId,1000),'ROOF_PHYSICAL_REF');
 const r=ref.recordRef;must(exact(r,['id','revision','sha256'])&&typeof r.id==='string'&&/^r_[a-f0-9]{32}$/.test(r.id)&&Number.isSafeInteger(r.revision)&&r.revision>=1&&r.revision<=1000000000&&typeof r.sha256==='string'&&/^[a-f0-9]{64}$/.test(r.sha256),'ROOF_PHYSICAL_REF');
 const tuple=JSON.parse(ref.rowId);must(Array.isArray(tuple)&&JSON.stringify(tuple)===ref.rowId&&tuple[0]===r.id&&tuple[1]===ref.faceId&&tuple[2]===kind,'ROOF_PHYSICAL_REF');
 must(kind==='timber'?tuple.length===4&&text(tuple[3],160):kind==='normal-fixing'?tuple.length===3:tuple.length===5&&tuple[3]===article.sku&&tuple[4]===article.reference,'ROOF_PHYSICAL_REF');
}
async function groupsFor(carrier){
 const result=await readAppliedRoofList(carrier);must(result.ok,'ROOF_SOURCE');const groups=new Map();
 for(const p of result.carrier.parts)if(p.takmodell?.version===4&&p.takmodell.role==='supported-battens')for(const r of p.rows){
  const key=rowKey(r.priceKey,r.u),contribution={partId:p.id,physicalRef:copy(r.physicalRef),quantity:r.v,unit:r.u};let group=groups.get(key);
  if(!group){group={nyckel:key,namn:r.k,mangd:0,enhet:r.u,takartikel:{version:1,priceKey:r.priceKey,roofArticle:copy(r.roofArticle),contributions:[]}};groups.set(key,group)}
  group.mangd+=r.v;must(Number.isSafeInteger(group.mangd)&&group.mangd>=0,'ROOF_QUANTITY');group.takartikel.contributions.push(contribution);
 }
 for(const g of groups.values())g.mangd=String(g.mangd);return {carrier:result.carrier,groups};
}
async function articleIdentity(m){
 const t=m.takartikel;must(exact(t,['version','priceKey','roofArticle','contributions'])&&t.version===1&&exact(t.roofArticle,['version','kind','profile','article'])&&t.roofArticle.version===1,'ROOF_ARTICLE');
 const a=copy(t.roofArticle.article);if(t.roofArticle.kind==='timber'){must(text(a.label,160),'ROOF_ARTICLE');delete a.label;}
 const r=await roofArticlePriceKey({kind:t.roofArticle.kind,profile:t.roofArticle.profile,article:a});must(r.ok&&r.priceKey===t.priceKey&&m.nyckel===rowKey(r.priceKey,m.enhet),'ROOF_PRICE_KEY');
 must(Array.isArray(t.contributions)&&t.contributions.length>=1&&t.contributions.length<=200,'ROOF_CONTRIBUTIONS');
 const unit=t.roofArticle.kind==='temporary-fixing'||a.packSize===null?'st':'förp';must(m.enhet===unit,'ROOF_UNIT');let quantity=0;const seen=new Set();
 for(const c of t.contributions){
  must(exact(c,['partId','physicalRef','quantity','unit'])&&partId(c.partId)&&c.unit===unit&&Number.isSafeInteger(c.quantity)&&c.quantity>=0,'ROOF_CONTRIBUTIONS');physicalReference(c.physicalRef,t.roofArticle.kind,a);
  const key=canonical(c.physicalRef);must(!seen.has(key),'ROOF_CONTRIBUTIONS');seen.add(key);quantity+=c.quantity;must(Number.isSafeInteger(quantity),'ROOF_QUANTITY');
 }
 must(String(m.mangd)===String(quantity),'ROOF_QUANTITY');must(typeof m.med==='boolean'&&typeof m.borta==='boolean'&&m.egen!==true,'ROOF_FINANCIAL');
}
async function readProject(raw){
 must(isPhysicalPlanJson(raw),'PROJECT_JSON');must(bytes(raw)<=MAX,'PROJECT_SIZE');const p=copy(raw);
 must(p.format===FORMAT&&p.version===2&&Array.isArray(p.material)&&Array.isArray(p.arbete)&&Array.isArray(p.ovrigt),'PROJECT_VERSION');
 const v=validateV1({...p,version:1});must(v.ok,'PROJECT_FIELDS');const source=await groupsFor(p.raknarlista),seen=new Set();
 for(const m of p.material){
  if(!Object.hasOwn(m,'takartikel')){must(!String(m.nyckel).startsWith('n:roof:'),'ROOF_METADATA');continue}
  await articleIdentity(m);must(!seen.has(m.nyckel),'ROOF_PRICE_CONFLICT');seen.add(m.nyckel);
  if(!m.borta){const g=source.groups.get(m.nyckel);must(g&&String(m.mangd)===g.mangd&&m.enhet===g.enhet&&same(m.takartikel,g.takartikel),'ROOF_FINANCIAL_SOURCE')}
 }
 return p;
}
export async function readRoofProject(raw){try{return {ok:true,project:await readProject(raw)}}catch(e){return failure(e)}}
export async function roofProjectArticles(carrier){try{must(isPhysicalPlanJson(carrier),'PROJECT_JSON');const r=await groupsFor(copy(carrier));return {ok:true,articles:copy([...r.groups.values()])}}catch(e){return failure(e)}}
export async function prepareRoofProject(raw){
 try{
  must(isPhysicalPlanJson(raw)&&exact(raw,['project','carrier','legacyArticles']),'PREPARE_INPUT');const input=copy(raw);let prior=input.project;
  if(prior?.version===2)prior=await readProject(prior);
  else{
   must(prior?.version===1&&validateV1(prior).ok&&Array.isArray(prior.material)&&Array.isArray(prior.arbete)&&Array.isArray(prior.ovrigt),'PROJECT_VERSION');
   // Old validators ignore unknown fields. A V1 wrapper therefore cannot
   // authorize new typed identity or price inheritance merely by claiming it.
   must(prior.material.every(m=>!Object.hasOwn(m,'takartikel')&&!String(m.nyckel).startsWith('n:roof:'))&&(prior.raknarlista===undefined||prior.raknarlista===null||Array.isArray(prior.raknarlista)),'LEGACY_TYPED_METADATA');
  }
  must(Array.isArray(input.legacyArticles)&&input.legacyArticles.every(a=>object(a)&&!Object.hasOwn(a,'takartikel')&&!Object.hasOwn(a,'roofArticle')&&!Object.hasOwn(a,'priceKey')&&!String(a.nyckel).startsWith('roof:')),'LEGACY_ARTICLES');
  const source=await groupsFor(input.carrier),old=new Map();
  for(const m of prior.material.filter(m=>Object.hasOwn(m,'takartikel'))){must(!old.has(m.nyckel),'ROOF_PRICE_CONFLICT');old.set(m.nyckel,m)}
  // Legacy price-bank aggregation stays on its existing, separate path. Typed
  // stock/pack rows never pass through legacy name matching or repacking.
  const legacy=slaIhopMedLista({...prior,material:prior.material.filter(m=>!Object.hasOwn(m,'takartikel'))},input.legacyArticles).material;
  const typed=[];
  for(const g of source.groups.values()){
   const previous=old.get(g.nyckel);old.delete(g.nyckel);
   typed.push({...copy(previous||{}),...copy(g),med:previous?previous.med:true,pris_kr:previous?previous.pris_kr:null,pris_ursprung:previous?.pris_ursprung||'egen',rabatt_pct:previous?.rabatt_pct??'0',rabatt_kr:previous?.rabatt_kr??null,paslag_pct:previous?.paslag_pct??'0',riktpris_kr:previous?.riktpris_kr??null,borta:false});
  }
  for(const m of old.values())typed.push({...copy(m),borta:true});
  const p={...prior,version:2,raknarlista:source.carrier,material:[...legacy,...typed]};
  return {ok:true,project:await readProject(p)};
 }catch(e){return failure(e)}
}
export async function exportRoofProject(raw){
 const p=await readProject(raw),compact=JSON.stringify(p),pretty=JSON.stringify(p,null,1);return bytes(pretty)<=MAX?pretty:compact;
}
export async function importRoofProject(text){try{must(typeof text==='string'&&bytes(text)<=MAX,'PROJECT_SIZE');return {ok:true,project:await readProject(JSON.parse(text))}}catch(e){return failure(e)}}
