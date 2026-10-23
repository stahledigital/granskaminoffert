import {source,lines,formatted,object,text,uuid,must,copy,failure,marker,decimal,decimalEqual,responseMoneyOre,receiptCandidate} from './format-common.mjs';
const endpoint='https://eaccountingapi.vismaonline.com/v2/quotes';
function bindings(context,rows,vatPct){
 must(uuid(context.customerId)&&context.priceMode==='net'&&context.customerCountry==='SE'&&context.customerCurrency==='SEK'&&context.companyCurrency==='SEK','DOMESTIC_NET_CONTEXT');
 must(Array.isArray(context.rowBindings)&&context.rowBindings.length===rows.length,'ARTICLE_BINDINGS');const map=new Map();
 for(const b of context.rowBindings){
  must(object(b)&&text(b.rowId)&&text(b.sourceUnit,20)&&uuid(b.articleId)&&uuid(b.unitId)&&text(b.unitCode,20)&&!map.has(b.rowId),'ARTICLE_BINDING');
  const v=decimal(b.vatRateFraction,4);must(v.n*100n===BigInt(vatPct)*v.d,'ARTICLE_VAT');map.set(b.rowId,b);
 }
 for(const row of rows)must(map.has(row.id)&&map.get(row.id).sourceUnit===row.sourceUnit,'ARTICLE_UNIT');return map;
}
function discountFraction(percent){
 // Percentage points are stored by P1; Spiris writes a 0..1 fraction with four
 // decimals. Construct that decimal exactly, never divide binary floats.
 must(percent.n*100n%percent.d===0n,'DISCOUNT_SCALE');const scaled=percent.n*100n/percent.d;must(scaled<=10000n,'DISCOUNT_RANGE');
 return Number(String(scaled/10000n)+'.'+String(scaled%10000n).padStart(4,'0'));
}
/** The explicit net/domestic/article context is supplied by the integrator.
 * It is not inferred from the contradictory IncludesVat checkbox description.
 * This formatter has no network/client/account or production acceptance. */
export async function formatSpirisOffer(raw,options){
 try{
  const {offer,context}=await source(raw,options),r=lines(offer,{fixedDiscountToPercent:true});if(r.status==='NEEDS')return r;
  const map=bindings(context,r.lines,r.vatPct),p=offer.source.project;
  const Rows=r.lines.map(row=>{must(decimalEqual(row.quantity.value,row.quantity.text),'QUANTITY_PRECISION');return {ArticleId:map.get(row.id).articleId,Text:row.label,Quantity:row.quantity.value,UnitPrice:row.price,DiscountPercentage:discountFraction(row.discount)};});
  must(Rows.every(row=>text(row.Text,2000)),'ROW_DESCRIPTION');
  const payload={CustomerId:context.customerId,QuoteDate:p.datum,DueDate:p.giltig_till,CustomerReference:marker(offer),Rows};
  return {...formatted('spiris',endpoint,offer,payload),priceModeFromCaller:true,articleVatUnitFromCaller:true,readOnlyFieldsNotWritten:true,quoteRowVatRateUnitNotInferred:true,discountConversions:r.discountConversions};
 }catch(e){return failure(e);}
}
/** Synthetically testable money/identity response contract. IncludesVat must be
 * false and whole quote VAT/net-row amounts must match. The undocumented unit
 * of QuoteRow.VatRate is deliberately not guessed from its numeric value. */
export async function checkSpirisOfferResponse(raw,options,response){
 try{
  const captured=copy(raw),context=copy(options),o=copy(response),prepared=await formatSpirisOffer(captured,context);must(prepared.status==='FORMATTED_OFFLINE','FORMAT_NEEDS');
  const {offer}=await source(captured,context),expected=prepared.payload,r=lines(offer,{fixedDiscountToPercent:true}),map=bindings(context,r.lines,r.vatPct);
  must(object(o)&&uuid(o.Id)&&Number.isSafeInteger(o.Number)&&o.Number>0,'RESPONSE_ID');
  for(const key of ['CustomerId','QuoteDate','DueDate','CustomerReference'])must(o[key]===expected[key],'RESPONSE_CONTEXT');
  must(o.CurrencyCode==='SEK'&&o.IncludesVat===false,'RESPONSE_PRICE_MODE');
  must(Array.isArray(o.Rows)&&o.Rows.length===expected.Rows.length,'RESPONSE_ROWS');
  o.Rows.forEach((row,i)=>{
   const wanted=expected.Rows[i],line=r.lines[i],b=map.get(line.id);
   must(object(row)&&row.ArticleId===wanted.ArticleId&&row.UnitId===b.unitId&&row.Text===wanted.Text&&typeof row.Quantity==='number'&&typeof row.DiscountPercentage==='number','RESPONSE_ARTICLE_UNIT');
   must(decimalEqual(row.Quantity,wanted.Quantity)&&responseMoneyOre(row.UnitPrice)===responseMoneyOre(wanted.UnitPrice)&&decimalEqual(row.DiscountPercentage,wanted.DiscountPercentage)&&responseMoneyOre(row.Amount)===line.netOre,'RESPONSE_ROW_AMOUNT');
   if(r.vatPct>0)must(row.IsVatFree===false,'RESPONSE_VAT_EXEMPTION');
  });
  const t=prepared.expected;must(responseMoneyOre(o.TotalAmount)===t.grossOre&&responseMoneyOre(o.VatAmount)===t.vatOre&&responseMoneyOre(o.RoundingsAmount)===0,'RESPONSE_TOTAL');
  return {ok:true,matched:true,scope:'caller-supplied-money-and-identity-contract',authenticatedResponseRequired:true,requiresBoundAtomicReservation:true,receiptCandidate:receiptCandidate('spiris',context.tenantId,offer,o.Id),providerSandboxVerified:false,quoteRowVatRateUnitNotInferred:true,discountConversions:r.discountConversions};
 }catch(e){return {ok:true,matched:false,status:'RECONCILE',code:e instanceof Error?e.message:'RESPONSE',retryCreateAllowed:false};}
}
