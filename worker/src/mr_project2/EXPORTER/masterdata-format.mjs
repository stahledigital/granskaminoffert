import {readFrozenOffer} from './offert-export.mjs';
import {isRoofJson} from '../P4_PROJEKT/pro-json.mjs';
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=(v,max=160)=>typeof v==='string'&&v.length>0&&v.length<=max&&v.trim()===v;
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
// Capture source and transient context before the first await. No accessors,
// prototype data, holes, aliases or non-JSON values can become provider fields.
function copy(raw){if(!isRoofJson(raw))throw Error('JSON_SHAPE');return JSON.parse(JSON.stringify(raw,(_,v)=>{if(Object.is(v,-0))throw Error('JSON_SHAPE');return v;}));}
const fail=e=>({ok:false,code:e instanceof Error?e.message:'MASTERDATA_FORMAT',payload:null,canSend:false});
function result(offer,context,provider,kind,payload,sourceRow=null,code=null){
 const key=kind==='customer'?context.localCustomerKey:context.localArticleKey;
 return {ok:true,status:code?'NEEDS':'FORMATTED_OFFLINE',...(code?{code}:{}),provider,method:'POST',endpoint:provider==='fortnox'?`https://api.fortnox.se/3/${kind==='customer'?'customers':'articles-v2'}`:`https://eaccountingapi.vismaonline.com/v2/${kind==='customer'?'customers':'articles'}`,payload:code?null:payload,identity:copy(offer.identity),snapshotSha256:offer.sha256,localObjectKey:text(context.tenantId)&&text(key)?JSON.stringify([provider,context.tenantId,kind,key]):null,sourceRow,canSend:false,requiresAtomicReservation:true,requiresReconciliation:true,remoteIdempotencyGuaranteed:false,providerSandboxVerified:false,requiredChecks:['authenticated-target-tenant','reconcile-existing-object-before-creation','atomic-local-object-reservation-before-creation','compare-created-object-with-frozen-source-before-receipt']};
}
async function prepare(raw,options,provider,kind){
 const captured=copy(raw),context=copy(options),r=await readFrozenOffer(captured);if(!r.ok)throw Error('FROZEN_SOURCE');
 const offer=r.offer,ctx=object(context)?context:{};
 const need=code=>result(offer,ctx,provider,kind,null,null,code);
 if(!object(context)||!text(ctx.tenantId)||!text(kind==='customer'?ctx.localCustomerKey:ctx.localArticleKey))return {need:need('TARGET_LOCAL_IDENTITY_REQUIRED')};
 return {offer,context:ctx,need};
}
async function customer(raw,options,provider){
 try{const p=await prepare(raw,options,provider,'customer');if(p.need&&typeof p.need!=='function')return p.need;const{offer,context,need}=p,name=offer.source.project.kund.namn,c=context.customer===undefined?{}:context.customer;
  if(!object(c))return need('CUSTOMER_CONTEXT_REQUIRED');
  if(provider==='fortnox'){
   if(!text(name,1024))return need('CUSTOMER_NAME_LENGTH');
   if(Object.keys(c).some(k=>k!=='CustomerNumber'))return need('CUSTOMER_FIELDS_UNSUPPORTED');
   if(Object.hasOwn(c,'CustomerNumber')&&!text(c.CustomerNumber,1024))return need('CUSTOMER_NUMBER_REQUIRED');
   return result(offer,context,provider,'customer',{Customer:{Name:name,...(Object.hasOwn(c,'CustomerNumber')?{CustomerNumber:c.CustomerNumber}:{})}});
  }
  if(!text(name,50))return need('CUSTOMER_NAME_LENGTH');
  const allowed=['InvoiceCity','InvoicePostalCode','IsActive','IsPrivatePerson','TermsOfPaymentId'];if(Object.keys(c).some(k=>!allowed.includes(k)))return need('CUSTOMER_FIELDS_UNSUPPORTED');
  for(const[k,max]of[['InvoiceCity',50],['InvoicePostalCode',10]])if(!text(c[k],max))return need(k.toUpperCase()+'_REQUIRED');
  for(const k of['IsActive','IsPrivatePerson'])if(typeof c[k]!=='boolean')return need(k.toUpperCase()+'_REQUIRED');
  if(!uuid(c.TermsOfPaymentId))return need('TERMS_OF_PAYMENT_ID_REQUIRED');
  return result(offer,context,provider,'customer',{Name:name,InvoiceCity:c.InvoiceCity,InvoicePostalCode:c.InvoicePostalCode,IsActive:c.IsActive,IsPrivatePerson:c.IsPrivatePerson,TermsOfPaymentId:c.TermsOfPaymentId});
 }catch(e){return fail(e);}
}
async function article(raw,options,provider){
 try{const p=await prepare(raw,options,provider,'article');if(p.need&&typeof p.need!=='function')return p.need;const{offer,context:c,need}=p;
  if(!text(c.rowId))return need('ROW_ID_REQUIRED');const rows=offer.source.input.rows.filter(x=>x.id===c.rowId),amounts=offer.source.result.rows.filter(x=>x.id===c.rowId);if(rows.length!==1||amounts.length!==1)return need('FROZEN_ROW_REQUIRED');
  const row=rows[0];if(!text(row.label,provider==='fortnox'?200:50))return need('ARTICLE_LABEL_LENGTH');
  if(!text(row.unit)||row.qty===undefined)return need('FROZEN_ROW_UNIT_QUANTITY_REQUIRED');
  if(!text(c.articleNumber,provider==='fortnox'?50:40))return need('ARTICLE_NUMBER_REQUIRED');
  if(c.unitConfirmed!==true||c.sourceUnit!==row.unit||c.unit!==row.unit)return need('EXACT_UNIT_BINDING_REQUIRED');
  const vat=Number(offer.source.input.vat_pct);if(![0,6,12,25].includes(vat)||c.vatConfirmed!==true||typeof c.vatFraction!=='number'||c.vatFraction!==vat/100)return need('EXACT_VAT_BINDING_REQUIRED');
  const sourceRow={rowId:row.id,label:row.label,quantity:row.qty,unit:row.unit,vatFraction:c.vatFraction};
  if(provider==='fortnox')return result(offer,c,provider,'article',{Article:{ArticleNumber:c.articleNumber,Description:row.label,Unit:row.unit,VAT:vat}},sourceRow);
  if(!uuid(c.unitId))return need('UNIT_ID_REQUIRED');if(!uuid(c.codingId))return need('CODING_ID_REQUIRED');if(typeof c.isActive!=='boolean')return need('ARTICLE_IS_ACTIVE_REQUIRED');
  return result(offer,c,provider,'article',{Number:c.articleNumber,Name:row.label,UnitId:c.unitId,CodingId:c.codingId,IsActive:c.isActive,SendToWebshop:false},sourceRow);
 }catch(e){return fail(e);}
}
/** Offline masterdata only; local stable keys are not provider uniqueness. */
export const formatFortnoxCustomer=(frozen,context={})=>customer(frozen,context,'fortnox');
export const formatFortnoxArticle=(frozen,context={})=>article(frozen,context,'fortnox');
export const formatSpirisCustomer=(frozen,context={})=>customer(frozen,context,'spiris');
export const formatSpirisArticle=(frozen,context={})=>article(frozen,context,'spiris');
