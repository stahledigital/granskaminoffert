import {readRoofPhysicalRecord} from './materialraknaren-takresa-record-v4.mjs';
import {unpackSupportedBattenPlan} from './materialraknaren-takplan-tabell.mjs';

// Purchase projection of an already verified, saved result. No reallocation,
// cross-face pack pooling, invented products or new fixing/geometry solver.
// This typed DTO is not a legacy material-list row and is never a whole-roof
// purchase/capacity certificate. The carrier adapter is a separate consumer.
export const ROOF_BATTEN_PURCHASE_BASIS=Object.freeze({model:'saved-batten-purchases-1',record:'3a0dd7c2c9ab18c08e430c614d77fdeb4751256ee36a31313f80b1d2cfcece71',transport:'e1a1631284f23c86400c07a763564f985427298c7fd5a0fb454fa0619a92fa8a'});
const copy=v=>JSON.parse(JSON.stringify(v));
const fail=code=>({ok:false,issues:[{field:'physicalPlan',code,message:'Takets sparade inköpsunderlag kan inte användas. Tidigare lista och kapplan finns kvar utan omräkning.'}]});
export async function roofSavedBattenPurchases(raw){
 try{
  // The reader checks descriptors/-0 and captures a full detached snapshot
  // synchronously before its first await, including every source/hash check.
  const read=await readRoofPhysicalRecord(raw);if(!read.ok)return fail('purchase-record');
  const record=read.record;if(record.physical===null)return fail('purchase-physical');
  const rows=[],requiredChecks=[],unresolved=[];
  for(const {faceId,packet} of record.physical.faces){
   const decoded=unpackSupportedBattenPlan(packet);if(!decoded.ok)return fail('purchase-table');const p=decoded.plan;
   for(const check of [...p.requiredChecks,...p.stock.requiredChecks])requiredChecks.push({faceId,...copy(check)});
   const id=(...parts)=>JSON.stringify([record.id,faceId,...parts]);
   for(const f of p.stock.ledger.families){
    const row={id:id('timber',f.id),kind:'timber',faceId,familyId:f.id,roles:['normal-batten','counter-batten'].filter(role=>p.members.some(m=>m.familyId===f.id&&m.role===role)),article:{label:f.label,sectionMm:copy(f.sectionMm),grade:f.grade,sku:f.sku,stockUsableMm:f.stockUsableMm,packSize:f.packSize},quantity:f.packSize===null?f.requiredStockCount:f.packCount,unit:f.packSize===null?'st':'förp',stockCount:f.packSize===null?f.requiredStockCount:f.packStockCount,balance:copy(f),source:{...copy(p.source),assembly:p.assembly,underlay:copy(p.specification.underlay),endDetail:copy(p.specification.endDetail)}};
    rows.push(row);
    if(f.sku===null)requiredChecks.push({faceId,rowId:row.id,code:'article-identity',message:'Kontrollera virkets material, kvalitet och tillgängliga lagerlängd mot projektet. Ingen produktspecifik artikel är angiven.'});
   }
   const n=p.fixing.normal,s=p.specification.fixingSupply;
   const normal={id:id('normal-fixing'),kind:'normal-fixing',faceId,article:{sku:n.sku,dimension:n.dimension,corrosion:n.corrosion,packSize:s.packSize,projectReference:s.projectReference},quantity:s.packSize===null?n.withReserve:n.packCount,unit:s.packSize===null?'st':'förp',netCount:n.netCount,count:n.withReserve,reservePct:s.reservePct,layoutComplete:n.layoutComplete,source:{...copy(p.source),assembly:p.assembly,authority:n.authority}};
   rows.push(normal);
   if(normal.quantity===null)unresolved.push({id:normal.id,faceId,code:'fixing-count',message:'Infästningens mängd eller placering är inte fastställd. Ange projektets verifierade infästningsplan innan detta moment läggs till.'});
   if(n.sku===null)requiredChecks.push({faceId,rowId:normal.id,code:'article-identity',message:'Välj infästning för angiven dimension, miljö och projektförutsättning. Mängdunderlaget är inte ett produktgodkännande.'});
   for(const g of p.fixing.temporary.groups){
    // Temporary fixings have their OWN reference/SKU and no declared packSize.
    // The normal fixing supply cannot authorize a package conversion here.
    const row={id:id('temporary-fixing',g.sku,g.reference),kind:'temporary-fixing',faceId,article:{sku:g.sku,reference:g.reference,packSize:null},quantity:g.withReserve,unit:'st',netCount:g.netCount,count:g.withReserve,reservePct:s.reservePct,source:{authority:'own-project',reference:g.reference}};
    rows.push(row);
    requiredChecks.push({faceId,rowId:row.id,code:'temporary-fixing-product',message:'Tillfällig infästning följer den egna projektreferensen. Kontrollera produkt och förpackning separat från bärläktens normala infästning.'});
   }
  }
  return {ok:true,format:'mr-roof-batten-purchases',version:1,basis:{...ROOF_BATTEN_PURCHASE_BASIS},profile:record.roofState.material.profile,recordRef:{id:record.id,revision:record.revision,sha256:record.sha256},rows,requiredChecks,unresolved,canApplyPurchase:unresolved.length===0,completePurchasePlan:false};
 }catch{return fail('purchase-record')}
}
