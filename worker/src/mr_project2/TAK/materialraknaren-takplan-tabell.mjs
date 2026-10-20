import {isRoofJson} from './materialraknaren-json-contract.mjs';

// Versioned, lossless transport for supported-batten output v1. Only the named
// fields below become tables/indices. No geometry, stock allocation or fixing
// solver runs on read. This is not structural approval, authentication or the
// enclosing V4 roof-state validator; those are separate consumer contracts.
const FORMAT='mr-roof-supported-table',LIMIT=32768;
const C={
 normal:['id','role','faceId','rowIndex','fromMm','toMm','fromT','toT','netLengthMm','cutLengthMm','familyId','section','supportIds'],
 counter:['id','role','faceId','fromMm','toMm','fromT','toT','netLengthMm','cutLengthMm','familyId','section','supportIds'],
 connection:['id','memberId','supportId','pointsMm'],
 stockMember:['id','familyId','netLengthMm','cutLengthMm'],
 family:['id','label','sectionMm','grade','sku','packSize','stockUsableMm','kerfMm','reservePct','allowOffcutReuse','baseStockCount','reserveStockCount','requiredStockCount','packCount','packStockCount','packSurplusStockCount','installedMm','cutMm','lossMm','remainderMm'],
 stock:['id','familyId','usableMm','usedMm','cuts','remainderMm'],
 cut:['memberId','fromMm','toMm','lengthMm','lossMm'],
 support:['id','kind','axisMm','bearingMm','fromMm','toMm','reference'],
 joint:['rowIndex','atMm','supportId','reference'],
 temporaryGroup:['sku','reference','netCount','withReserve'],
 temporaryNode:['id','supportId','pointMm','quantity','sku','reference']
};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,names)=>object(v)&&Object.keys(v).length===names.length&&names.every(k=>Object.hasOwn(v,k));
const must=(v)=>{if(!v)throw Error('schema');};
// JSON values carry a tree, not object identity. After strict descriptor/JSON
// checks, copy as that tree so a shared in-memory support cannot also rewrite
// an otherwise untouched metadata field while its reference becomes an index.
const copy=v=>JSON.parse(JSON.stringify(v));
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const text=v=>typeof v==='string'&&v.length>0;
const nullableText=v=>v===null||text(v);
const count=v=>Number.isSafeInteger(v)&&v>=0;
const nullableCount=v=>v===null||count(v);
const array=v=>{must(Array.isArray(v));return v;};
const point=v=>Array.isArray(v)&&v.length===2&&v.every(finite);
const vector=v=>Array.isArray(v)&&v.length===3&&v.every(finite);
const source=v=>exact(v,['url','sha256','pages'])&&text(v.url)&&typeof v.sha256==='string'&&/^[0-9a-f]{64}$/.test(v.sha256)&&Array.isArray(v.pages)&&v.pages.length>0&&v.pages.every(n=>count(n)&&n>0);
const stable=v=>JSON.stringify(v,(_k,x)=>object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const same=(a,b)=>stable(a)===stable(b);
const failure=(code='table')=>({ok:false,issues:[{field:'physicalPlan',code,message:code==='size'?'Takplanen är för stor för det sparade formatet. Tidigare underlag finns kvar utan att kapas.':'Takplanens sparade tabeller eller referenser kunde inte läsas. Tidigare underlag finns kvar.'}]});
function jsonInput(x){
 must(isRoofJson(x));
 // JSON has no signed zero. Do not claim an exact numerical roundtrip for it.
 const visit=v=>{if(typeof v==='number')must(!Object.is(v,-0));else if(v&&typeof v==='object')Object.values(v).forEach(visit);};visit(x);
}
function unique(records){const ids=records.map(r=>r.id);must(ids.every(text)&&new Set(ids).size===ids.length);return ids;}
function records(type,rows){return array(rows).map(row=>{const names=C[type];must(Array.isArray(row)&&(row.length===names.length||type==='connection'&&row.length===names.length+1));const fields=type==='connection'&&row.length===names.length+1?[...names,'fixingId']:names;return Object.fromEntries(fields.map((k,i)=>[k,copy(row[i])]))});}
function rows(type,items){return array(items).map(item=>{const fields=type==='connection'&&Object.hasOwn(item,'fixingId')?[...C[type],'fixingId']:C[type];must(exact(item,fields));return fields.map(k=>copy(item[k]));});}
function checkPlan(x){
 must(exact(x,['ok','format','version','assembly','specification','frame','courses','members','connections','stock','fixing','source','completePurchasePlan','requiredChecks']));
 must(x.ok===true&&x.format==='mr-roof-supported-battens'&&x.version===1&&x.completePurchasePlan===false&&['boarded','light-hanging','light-stretched'].includes(x.assembly));
 must(exact(x.specification,['measurement','underlay','planedTimber','rafterAxesMm','supports','joints','endDetail','fixingSupply']));
 must(exact(x.frame,['faceId','origin','across','up','polygonMm','geometryInput','geometryVersion','units']));
 must(vector(x.frame.origin)&&vector(x.frame.across)&&vector(x.frame.up)&&array(x.frame.polygonMm).length>=3&&x.frame.polygonMm.every(point)&&x.frame.geometryVersion===1&&exact(x.frame.units,['world','working'])&&x.frame.units.world==='m'&&x.frame.units.working==='mm');
 must(exact(x.courses,['positionsMm','intervals','gaugeMm']));
 must(array(x.courses.positionsMm).length>0&&x.courses.positionsMm.every(finite)&&count(x.courses.intervals)&&finite(x.courses.gaugeMm)&&x.courses.gaugeMm>=0);
 must(exact(x.stock,['ok','ledger','completePurchasePlan','requiredChecks'])&&x.stock.ok===true&&x.stock.completePurchasePlan===false);
 const l=x.stock.ledger;
 must(exact(l,['format','version','method','members','families','stocks'])&&l.format==='mr-roof-stock-ledger'&&l.version===1&&l.method==='explicit-stock-first-fit-decreasing');
 must(exact(x.fixing,['normal','temporary'])&&exact(x.fixing.normal,['dimension','corrosion','netCount','withReserve','packCount','sku','layoutComplete','authority']));
 must(typeof x.fixing.normal.layoutComplete==='boolean'&&exact(x.fixing.temporary,['netCount','withReserve','groups','nodes'])&&exact(x.source,['covering','normalFixing']));
 const fn=x.fixing.normal,ft=x.fixing.temporary;
 must(nullableText(fn.dimension)&&nullableText(fn.corrosion)&&nullableText(fn.sku)&&[fn.netCount,fn.withReserve,fn.packCount].every(nullableCount)&&['industry-handbook','own-project'].includes(fn.authority)&&count(ft.netCount)&&count(ft.withReserve));
 must(source(x.source.covering)&&(x.source.normalFixing===null||source(x.source.normalFixing)));
 for(const checks of [x.requiredChecks,x.stock.requiredChecks])for(const check of array(checks))must(exact(check,['code','message'])&&text(check.code)&&text(check.message));
 const members=array(x.members),supports=array(x.specification.supports),families=array(l.families),connections=array(x.connections);
 const memberIds=unique(members),supportIds=unique(supports),familyIds=unique(families);
 must(memberIds.length>0&&supportIds.length>0&&familyIds.length>0);
 const byMember=new Map(members.map(m=>[m.id,m])),byFamily=new Map(families.map(f=>[f.id,f]));
 for(const s of supports)must(exact(s,C.support)&&text(s.reference)&&['counter','rafter','rafter-with-counter'].includes(s.kind)&&[s.axisMm,s.fromMm,s.toMm].every(finite)&&point(s.bearingMm));
 for(const m of members){
  must(['normal-batten','counter-batten'].includes(m.role));must(exact(m,C[m.role==='normal-batten'?'normal':'counter']));
  must(text(m.faceId)&&m.faceId===x.frame.faceId&&[m.fromMm,m.toMm,m.fromT,m.toT,m.netLengthMm,m.cutLengthMm].every(finite)&&m.netLengthMm>0&&m.cutLengthMm>=m.netLengthMm);
  must(exact(m.section,['thicknessMm','widthMm'])&&[m.section.thicknessMm,m.section.widthMm].every(finite)&&m.section.thicknessMm>0&&m.section.widthMm>0);
  const f=byFamily.get(m.familyId);must(f&&same(f.sectionMm,[m.section.thicknessMm,m.section.widthMm]));
  must(array(m.supportIds).length>0&&new Set(m.supportIds).size===m.supportIds.length&&m.supportIds.every(id=>supportIds.includes(id)));
  if(m.role==='normal-batten')must(Number.isSafeInteger(m.rowIndex)&&m.rowIndex>=1);
 }
 unique(connections);const linked=new Set();
 for(const c of connections){
  must(exact(c,Object.hasOwn(c,'fixingId')?[...C.connection,'fixingId']:C.connection));
  const m=byMember.get(c.memberId),link=JSON.stringify([c.memberId,c.supportId]);
  must(m?.role==='normal-batten'&&m.supportIds.includes(c.supportId)&&!linked.has(link));linked.add(link);
  must(x.fixing.normal.layoutComplete?text(c.fixingId)&&array(c.pointsMm).length>0&&c.pointsMm.every(point):c.pointsMm===null&&!Object.hasOwn(c,'fixingId'));
 }
 must(linked.size===members.filter(m=>m.role==='normal-batten').reduce((n,m)=>n+m.supportIds.length,0));
 unique(l.members);must(l.members.length===members.length);
 for(const m of l.members){const p=byMember.get(m.id);must(exact(m,C.stockMember)&&p&&m.familyId===p.familyId&&m.netLengthMm===p.netLengthMm&&m.cutLengthMm===p.cutLengthMm);}
 for(const f of families){
  must(exact(f,C.family)&&text(f.label)&&nullableText(f.grade)&&nullableText(f.sku)&&point(f.sectionMm)&&f.sectionMm.every(n=>n>0)&&finite(f.stockUsableMm)&&f.stockUsableMm>0&&finite(f.kerfMm)&&f.kerfMm>=0&&finite(f.reservePct)&&f.reservePct>=0&&f.reservePct<=100&&typeof f.allowOffcutReuse==='boolean');
  must([f.packSize,f.packCount,f.packStockCount,f.packSurplusStockCount].every(nullableCount)&&[f.baseStockCount,f.reserveStockCount,f.requiredStockCount].every(count)&&[f.installedMm,f.cutMm,f.lossMm,f.remainderMm].every(n=>finite(n)&&n>=0));
 }
 unique(l.stocks);const cutIds=new Set();
 for(const s of l.stocks){
  must(exact(s,C.stock)&&familyIds.includes(s.familyId)&&[s.usableMm,s.usedMm,s.remainderMm].every(n=>finite(n)&&n>=0));
  for(const c of array(s.cuts)){const m=byMember.get(c.memberId);must(exact(c,C.cut)&&m&&m.familyId===s.familyId&&!cutIds.has(m.id)&&[c.fromMm,c.toMm,c.lengthMm,c.lossMm].every(n=>finite(n)&&n>=0));cutIds.add(m.id);}
 }
 must(cutIds.size===members.length);
 for(const j of array(x.specification.joints))must(exact(j,C.joint)&&count(j.rowIndex)&&j.rowIndex>0&&finite(j.atMm)&&supportIds.includes(j.supportId)&&text(j.reference));
 for(const g of array(x.fixing.temporary.groups))must(exact(g,C.temporaryGroup)&&text(g.reference)&&nullableText(g.sku)&&count(g.netCount)&&count(g.withReserve));
 unique(x.fixing.temporary.nodes);
 for(const n of x.fixing.temporary.nodes)must(exact(n,C.temporaryNode)&&supportIds.includes(n.supportId)&&point(n.pointMm)&&n.quantity===1&&nullableText(n.sku)&&text(n.reference));
}
function pack(x){
 checkPlan(x);
 const sections=[],references=[],mid=x.members.map(m=>m.id),sid=x.specification.supports.map(s=>s.id),fid=x.stock.ledger.families.map(f=>f.id);
 const index=(list,value)=>{const i=list.indexOf(value);must(i>=0);return i;};
 const reference=value=>{must(text(value));let i=references.indexOf(value);if(i<0){i=references.length;references.push(value)}return i;};
 const section=value=>{let i=sections.findIndex(s=>same(s,value));if(i<0){i=sections.length;sections.push(copy(value))}return i;};
 for(const m of x.members){m.familyId=index(fid,m.familyId);m.supportIds=m.supportIds.map(id=>index(sid,id));m.section=section(m.section);}
 for(const c of x.connections){c.memberId=index(mid,c.memberId);c.supportId=index(sid,c.supportId);}
 for(const m of x.stock.ledger.members){m.id=index(mid,m.id);m.familyId=index(fid,m.familyId);}
 for(const s of x.stock.ledger.stocks){s.familyId=index(fid,s.familyId);for(const c of s.cuts)c.memberId=index(mid,c.memberId);}
 for(const s of x.specification.supports)s.reference=reference(s.reference);
 for(const j of x.specification.joints){j.supportId=index(sid,j.supportId);j.reference=reference(j.reference);}
 for(const n of x.fixing.temporary.nodes){n.supportId=index(sid,n.supportId);n.reference=reference(n.reference);}
 for(const g of x.fixing.temporary.groups)g.reference=reference(g.reference);
 const normal=[],counter=[],order=[];
 for(const m of x.members){const kind=m.role==='normal-batten'?0:1,target=kind===0?normal:counter;order.push([kind,target.length]);target.push(m);}
 x.members={normal:rows('normal',normal),counter:rows('counter',counter),order};x.connections=rows('connection',x.connections);
 const l=x.stock.ledger;l.members=rows('stockMember',l.members);l.families=rows('family',l.families);
 for(const s of l.stocks)s.cuts=rows('cut',s.cuts);l.stocks=rows('stock',l.stocks);
 x.specification.supports=rows('support',x.specification.supports);x.specification.joints=rows('joint',x.specification.joints);
 x.fixing.temporary.groups=rows('temporaryGroup',x.fixing.temporary.groups);x.fixing.temporary.nodes=rows('temporaryNode',x.fixing.temporary.nodes);
 return {format:FORMAT,version:1,sections,references,data:x};
}
export function packSupportedBattenPlan(raw){
 try{
  jsonInput(raw);const packet=pack(copy(raw));if(JSON.stringify(packet).length>LIMIT)return failure('size');return {ok:true,packet};
 }catch{return failure();}
}
export function unpackSupportedBattenPlan(raw){
 try{
  jsonInput(raw);if(JSON.stringify(raw).length>LIMIT)return failure('size');
  must(exact(raw,['format','version','sections','references','data'])&&raw.format===FORMAT&&raw.version===1);
  array(raw.sections);array(raw.references);const x=copy(raw.data),table=x.members;
  must(exact(table,['normal','counter','order']));
  const types=[records('normal',table.normal),records('counter',table.counter)],seen=new Set();
  x.members=array(table.order).map(pair=>{must(Array.isArray(pair)&&pair.length===2);const [t,i]=pair;must((t===0||t===1)&&Number.isSafeInteger(i)&&i>=0&&i<types[t].length&&!seen.has(t+':'+i));seen.add(t+':'+i);return copy(types[t][i]);});
  must(x.members.length===types[0].length+types[1].length);
  x.connections=records('connection',x.connections);
  const l=x.stock.ledger;l.members=records('stockMember',l.members);l.families=records('family',l.families);l.stocks=records('stock',l.stocks);
  for(const s of l.stocks)s.cuts=records('cut',s.cuts);
  x.specification.supports=records('support',x.specification.supports);x.specification.joints=records('joint',x.specification.joints);
  x.fixing.temporary.groups=records('temporaryGroup',x.fixing.temporary.groups);x.fixing.temporary.nodes=records('temporaryNode',x.fixing.temporary.nodes);
  const mid=unique(x.members),sid=unique(x.specification.supports),fid=unique(l.families);
  const get=(list,i)=>{must(Number.isSafeInteger(i)&&i>=0&&i<list.length);return copy(list[i]);};
  for(const m of x.members){m.familyId=get(fid,m.familyId);m.supportIds=array(m.supportIds).map(i=>get(sid,i));m.section=get(raw.sections,m.section);}
  for(const c of x.connections){c.memberId=get(mid,c.memberId);c.supportId=get(sid,c.supportId);}
  for(const m of l.members){m.id=get(mid,m.id);m.familyId=get(fid,m.familyId);}
  for(const s of l.stocks){s.familyId=get(fid,s.familyId);for(const c of s.cuts)c.memberId=get(mid,c.memberId);}
  for(const s of x.specification.supports)s.reference=get(raw.references,s.reference);
  for(const j of x.specification.joints){j.supportId=get(sid,j.supportId);j.reference=get(raw.references,j.reference);}
  for(const n of x.fixing.temporary.nodes){n.supportId=get(sid,n.supportId);n.reference=get(raw.references,n.reference);}
  for(const g of x.fixing.temporary.groups)g.reference=get(raw.references,g.reference);
  jsonInput(x);checkPlan(x);
  // Enforce a unique table representation too: reject duplicate/unused tables,
  // row losses and alternate encodings rather than silently normalizing them.
  must(same(pack(copy(x)),raw));return {ok:true,plan:x};
 }catch{return failure();}
}
