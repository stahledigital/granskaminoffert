import {isRoofJson} from './materialraknaren-json-contract.mjs';

// Validate an already saved allocation. No allocator is imported or run, no
// stock is reordered or replaced, and no optimality/structural claim is made.
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,names)=>object(v)&&Object.keys(v).length===names.length&&names.every(k=>Object.hasOwn(v,k));
const int=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const text=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max&&v.trim()===v;
const id=v=>text(v,80)&&/^[a-zA-Z0-9_:-]+$/.test(v);
const must=v=>{if(!v)throw Error('saved-stock');};
const outward=v=>{const n=Math.round(v);return n>0&&Math.abs(v-n)<=8*Number.EPSILON*Math.max(1,Math.abs(v))?n:Math.ceil(v);};
const FAMILY=['id','label','sectionMm','grade','sku','packSize','stockUsableMm','kerfMm','reservePct','allowOffcutReuse','baseStockCount','reserveStockCount','requiredStockCount','packCount','packStockCount','packSurplusStockCount','installedMm','cutMm','lossMm','remainderMm'];
function noSignedZero(v){if(typeof v==='number')must(!Object.is(v,-0));else if(v&&typeof v==='object')for(const x of Object.values(v))noSignedZero(x);}
function reserve(n,p){
 const [m,e='0']=String(p).split('e'),[w,f='']=m.split('.'),s=f.length-Number(e);let a=BigInt(w+f)*BigInt(n),b=100n;
 if(s>=0)b*=10n**BigInt(s);else a*=10n**BigInt(-s);
 return Number((a+b-1n)/b);
}
export function validateSavedRoofStock(raw){
 try{
  must(isRoofJson(raw));noSignedZero(raw);
  must(exact(raw,['format','version','method','members','families','stocks'])&&raw.format==='mr-roof-stock-ledger'&&raw.version===1&&raw.method==='explicit-stock-first-fit-decreasing');
  must(Array.isArray(raw.members)&&int(raw.members.length,1,10000)&&Array.isArray(raw.families)&&int(raw.families.length,1,100)&&Array.isArray(raw.stocks)&&raw.stocks.length<=raw.members.length);
  const families=new Map(),members=new Map(),stocks=new Set(),cutMembers=new Set();
  for(const f of raw.families){
   must(exact(f,FAMILY)&&id(f.id)&&!families.has(f.id)&&text(f.label,160)&&text(f.grade,80));
   must(Array.isArray(f.sectionMm)&&f.sectionMm.length===2&&f.sectionMm.every(v=>typeof v==='number'&&v>0&&v<=1000));
   must(f.sku===null||text(f.sku,160));must(f.packSize===null||int(f.packSize,1,1000000));
   must(int(f.stockUsableMm,1,100000)&&int(f.kerfMm,0,f.stockUsableMm-1)&&typeof f.reservePct==='number'&&f.reservePct>=0&&f.reservePct<=100&&typeof f.allowOffcutReuse==='boolean');
   must(['baseStockCount','reserveStockCount','requiredStockCount'].every(k=>int(f[k],0,20000)));
   families.set(f.id,f);
  }
  for(const m of raw.members){
   must(exact(m,['id','familyId','netLengthMm','cutLengthMm'])&&id(m.id)&&!members.has(m.id));
   const f=families.get(m.familyId);must(f&&typeof m.netLengthMm==='number'&&m.netLengthMm>0&&int(m.cutLengthMm,1,100000)&&m.cutLengthMm===outward(m.netLengthMm)&&m.cutLengthMm<=f.stockUsableMm);
   members.set(m.id,m);
  }
  for(const s of raw.stocks){
   must(exact(s,['id','familyId','usableMm','usedMm','cuts','remainderMm'])&&id(s.id)&&!stocks.has(s.id));stocks.add(s.id);
   const f=families.get(s.familyId);must(f&&s.usableMm===f.stockUsableMm&&int(s.usedMm,0,s.usableMm)&&int(s.remainderMm,0,s.usableMm));
   must(Array.isArray(s.cuts)&&s.cuts.length>0&&s.cuts.length<=raw.members.length&&(f.allowOffcutReuse||s.cuts.length===1));let cursor=0;
   for(const c of s.cuts){
    must(exact(c,['memberId','fromMm','toMm','lengthMm','lossMm']));const m=members.get(c.memberId);
    must(m&&m.familyId===s.familyId&&!cutMembers.has(m.id)&&c.fromMm===cursor&&c.lengthMm===m.cutLengthMm&&c.toMm===cursor+c.lengthMm&&c.toMm<=s.usableMm);
    must(c.lossMm===Math.min(f.kerfMm,s.usableMm-c.toMm));cursor=c.toMm+c.lossMm;cutMembers.add(m.id);
   }
   must(s.usedMm===cursor&&s.remainderMm===s.usableMm-cursor);
  }
  must(cutMembers.size===members.size);
  for(const f of raw.families){
   const ms=raw.members.filter(m=>m.familyId===f.id),ss=raw.stocks.filter(s=>s.familyId===f.id),base=ss.length,extra=reserve(base,f.reservePct),required=base+extra,pack=f.packSize===null?null:Math.ceil(required/f.packSize),packed=pack===null?null:pack*f.packSize;
   must(f.baseStockCount===base&&f.reserveStockCount===extra&&f.requiredStockCount===required&&f.packCount===pack&&f.packStockCount===packed&&f.packSurplusStockCount===(packed===null?null:packed-required));
   must(f.installedMm===ms.reduce((n,m)=>n+m.netLengthMm,0)&&f.cutMm===ms.reduce((n,m)=>n+m.cutLengthMm,0)&&f.lossMm===ss.reduce((n,s)=>n+s.cuts.reduce((a,c)=>a+c.lossMm,0),0)&&f.remainderMm===ss.reduce((n,s)=>n+s.remainderMm,0));
  }
  return {ok:true,ledger:JSON.parse(JSON.stringify(raw))};
 }catch{return {ok:false,issues:[{field:'physicalPlan.stock',code:'saved-stock-balance',message:'Takplanens sparade kap- och lagerbalans stämmer inte. Tidigare underlag finns kvar utan att räknas om.'}]};}
}
