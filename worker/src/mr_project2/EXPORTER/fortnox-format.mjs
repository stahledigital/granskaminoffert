import {source,lines,formatted,need,object,text,must,copy,failure,marker,decimalEqual,responseMoneyOre,receiptCandidate} from './format-common.mjs';
const endpoint='https://api.fortnox.se/3/offers-v2';
function bindings(context,rows){
 must(text(context.customerNumber)&&Array.isArray(context.rowBindings)&&context.rowBindings.length===rows.length,'CUSTOMER_UNIT_BINDINGS');const map=new Map();
 for(const b of context.rowBindings){must(object(b)&&text(b.rowId)&&text(b.sourceUnit,20)&&text(b.unit,20)&&!map.has(b.rowId),'UNIT_BINDING');map.set(b.rowId,b);}
 for(const row of rows)must(map.has(row.id)&&map.get(row.id).sourceUnit===row.sourceUnit,'UNIT_BINDING');return map;
}
/** Offline writable-fields format only. Neither a network request nor a claim
 * that Fortnox has accepted the company context or its monetary rounding. */
export async function formatFortnoxOffer(raw,options){
 try{
  const {offer,context}=await source(raw,options),r=lines(offer);if(r.status==='NEEDS')return r;
  const map=bindings(context,r.lines),p=offer.source.project;
  const OfferRows=r.lines.map(row=>({Description:row.label,Quantity:row.quantity.text,Unit:map.get(row.id).unit,Price:row.price,Discount:row.discount.value,DiscountType:'PERCENT',VAT:r.vatPct}));
  must(OfferRows.every(x=>text(x.Description,255)),'ROW_DESCRIPTION');
  const payload={Offer:{CustomerNumber:context.customerNumber,CustomerName:p.kund.namn,OfferDate:p.datum,ExpireDate:p.giltig_till,Currency:'SEK',VATIncluded:false,Comments:marker(offer),OfferRows}};
  return formatted('fortnox',endpoint,offer,payload);
 }catch(e){return failure(e);}
}
/** Compare a caller-supplied response with the exact prepared snapshot. The
 * integrator must authenticate its origin/company and bind the reservation. */
export async function checkFortnoxOfferResponse(raw,options,response){
 try{
  const captured=copy(raw),context=copy(options),body=copy(response),prepared=await formatFortnoxOffer(captured,context);must(prepared.status==='FORMATTED_OFFLINE','FORMAT_NEEDS');
  const {offer}=await source(captured,context),expected=prepared.payload.Offer,o=body.Offer;
  must(object(o)&&text(o.DocumentNumber,200),'RESPONSE');
  for(const key of ['CustomerNumber','Currency','VATIncluded','Comments','OfferDate','ExpireDate'])must(o[key]===expected[key],'RESPONSE_CONTEXT');
  must(Array.isArray(o.OfferRows)&&o.OfferRows.length===expected.OfferRows.length,'RESPONSE_ROWS');
  o.OfferRows.forEach((row,i)=>{const wanted=expected.OfferRows[i];must(object(row)&&row.Description===wanted.Description&&row.Unit===wanted.Unit&&row.DiscountType==='PERCENT'&&row.VAT===wanted.VAT&&typeof row.Quantity==='string'&&typeof row.Discount==='number','RESPONSE_ROW');must(decimalEqual(row.Quantity,wanted.Quantity)&&responseMoneyOre(row.Price)===responseMoneyOre(wanted.Price)&&decimalEqual(row.Discount,wanted.Discount),'RESPONSE_ROW_AMOUNT');});
  const actualRows=offer.source.result.rows;o.OfferRows.forEach((row,i)=>must(responseMoneyOre(row.Total)===actualRows[i].sell_ore,'RESPONSE_ROW_TOTAL'));
  must(o.TaxReductionType==='none','RESPONSE_ROT');
  const t=prepared.expected;must(responseMoneyOre(o.Net)===t.netOre&&responseMoneyOre(o.TotalVAT)===t.vatOre&&responseMoneyOre(o.Total)===t.grossOre&&responseMoneyOre(o.TotalToPay)===t.grossOre&&responseMoneyOre(o.RoundOff)===0&&responseMoneyOre(o.TaxReduction)===0,'RESPONSE_TOTAL');
  return {ok:true,matched:true,scope:'caller-supplied-response-contract',authenticatedResponseRequired:true,requiresBoundAtomicReservation:true,receiptCandidate:receiptCandidate('fortnox',context.tenantId,offer,o.DocumentNumber),providerSandboxVerified:false};
 }catch(e){return {ok:true,matched:false,status:'RECONCILE',code:e instanceof Error?e.message:'RESPONSE',retryCreateAllowed:false};}
}
