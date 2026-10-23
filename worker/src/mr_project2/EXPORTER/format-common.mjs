import {offert} from '../P1_KALKYLKARNA/pro-kalkyl.mjs';
import {isRoofJson} from '../P4_PROJEKT/pro-json.mjs';
import {readFrozenOffer} from './offert-export.mjs';
export const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
export const text=(x,max=160)=>typeof x==='string'&&x.length>0&&x.length<=max&&x.trim()===x;
export const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(x);
export const must=(x,code)=>{if(!x)throw Error(code);};
export function copy(raw){must(isRoofJson(raw),'JSON_SHAPE');return JSON.parse(JSON.stringify(raw,(_,x)=>{must(!Object.is(x,-0),'JSON_SHAPE');return x;}));}
export const failure=e=>({ok:false,code:e instanceof Error?e.message:'FORMAT'});
export const need=code=>({ok:true,status:'NEEDS',code,payload:null,canSend:false});
export function decimal(value,scale=4){
 must(typeof value==='string'||typeof value==='number','DECIMAL');const s=String(value);must(/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s)&&s.length<=24,'DECIMAL');
 const [a,b='']=s.split('.');must(b.length<=scale,'DECIMAL_SCALE');const n=BigInt(a+b),d=10n**BigInt(b.length);must(n<=BigInt(Number.MAX_SAFE_INTEGER),'UNSAFE_DECIMAL');return {n,d,value:Number(s),text:s};
}
export function moneyOre(value){const x=decimal(value,2);must((x.n*100n)%x.d===0n,'DECIMAL_SCALE');const n=x.n*100n/x.d;must(n<=BigInt(Number.MAX_SAFE_INTEGER),'UNSAFE_ORE');return Number(n);}
export const decimalEqual=(a,b,scale=4)=>{const x=decimal(a,scale),y=decimal(b,scale);return x.n*y.d===y.n*x.d;};
export function responseMoneyOre(value){must(typeof value==='number'&&Number.isFinite(value),'RESPONSE_NUMBER');return moneyOre(value);}
export function moneyNumber(raw){const ore=moneyOre(raw),n=Number(raw);must(moneyOre(n)===ore,'DECIMAL_LOSS');return n;}
export function marker(offer){return `PRO:${offer.identity.offerId}:v${offer.identity.offerVersion}`;}
export async function source(raw,options){
 const captured=copy(raw),ctx=copy(options),r=await readFrozenOffer(captured);must(r.ok,'FROZEN_SOURCE');must(object(ctx)&&text(ctx.tenantId),'TARGET_CONTEXT');return {offer:r.offer,context:ctx};
}
export function lines(offer,{fixedDiscountToPercent=false}={}){
 const {project,input,result}=offer.source;
 if(project.val.rot===true)return need('ROT_MAPPING_REQUIRED');
 if(result.totals.order_discount_ore!==0)return need('ORDER_DISCOUNT_MAPPING_REQUIRED');
 if(!['0','6','12','25'].some(p=>decimalEqual(p,input.vat_pct)))return need('VAT_MAPPING_REQUIRED');
 const output=[],discountConversions=[],candidate=copy(input);
 for(let i=0;i<input.rows.length;i++){
  const r=input.rows[i],amount=result.rows[i];
  if(!['material','labor'].includes(r.kind))return need('ADDITIONAL_CHARGE_MAPPING_REQUIRED');
  if(decimal(r.markup_pct??'0').n!==0n)return need('ROW_ADJUSTMENT_MAPPING_REQUIRED');
  const fixed=moneyOre(r.discount_fixed_kr??'0');let discount=decimal(r.discount_pct??'0');
  if(fixed){
   if(!fixedDiscountToPercent)return need('ROW_ADJUSTMENT_MAPPING_REQUIRED');
   const base=r.kind==='material'?amount.gross_ore:amount.sell_before_discount_ore;
   must(Number.isSafeInteger(base)&&base>0,'DISCOUNT_BASE');
   const reduction=BigInt(amount.discount_pct_ore)+BigInt(fixed),den=BigInt(base);
   // Nearest four-decimal fraction, half up. This rounds representation only;
   // actual P1 below determines all resulting whole-ore monetary differences.
   const scaled=(2n*reduction*10000n+den)/(2n*den);
   const pct=String(scaled/100n)+'.'+String(scaled%100n).padStart(2,'0');discount=decimal(pct,2);
   candidate.rows[i]={...r,discount_pct:pct,discount_fixed_kr:null};
   discountConversions.push({rowId:r.id,sourceDiscountPct:String(r.discount_pct??'0'),sourceFixedOre:fixed,proposedDiscountPct:pct,originalNetOre:amount.sell_ore,rowIndex:i});
  }
  const quantity=r.kind==='material'?r.qty:amount.person_hours_used;
  if(decimal(quantity).n===0n)return need('ZERO_QUANTITY_MAPPING_REQUIRED');
  const price=r.kind==='material'?r.price_kr:r.rate_kr??r.cost_rate_kr;
  output.push({id:r.id,label:r.label,quantity:decimal(quantity),sourceUnit:r.kind==='material'?r.unit:'person-hour',price:moneyNumber(price),discount,netOre:amount.sell_ore});
 }
 if(discountConversions.length){
  const proposed=offert(candidate);must(proposed.total_status==='COMPLETE','DISCOUNT_PROJECTION');
  const safe=v=>{for(const [k,x]of Object.entries(v)){if(k.endsWith('_ore')&&x!==null)must(Number.isSafeInteger(x),'UNSAFE_ORE');else if(x&&typeof x==='object')safe(x);}};safe(proposed);
  for(const c of discountConversions){c.proposedNetOre=proposed.rows[c.rowIndex].sell_ore;c.netDeltaOre=c.proposedNetOre-c.originalNetOre;delete c.rowIndex;must(Number.isSafeInteger(c.proposedNetOre)&&Number.isSafeInteger(c.netDeltaOre),'UNSAFE_ORE');}
  const delta={netOre:proposed.totals.sell_ex_ore-result.totals.sell_ex_ore,vatOre:proposed.totals.vat_ore-result.totals.vat_ore,grossOre:proposed.totals.total_inc_ore-result.totals.total_inc_ore};
  must(Object.values(delta).every(Number.isSafeInteger),'UNSAFE_ORE');
  const changed=discountConversions.some(c=>c.netDeltaOre!==0)||Object.values(delta).some(n=>n!==0);
  // Beslut23:03: provider rounding is not proven by an equal P1 result.
  return {...need(changed?'FIXED_DISCOUNT_REQUIRES_CONFIRMATION':'FIXED_DISCOUNT_PROVIDER_RULE_REQUIRED'),proposal:{discountConversions,delta,proposedTotals:proposed.totals,requiresNewFrozenOffer:changed,providerRoundingVerified:false}};
 }
 return {ok:true,lines:output,vatPct:decimal(input.vat_pct).value,discountConversions};
}
export function formatted(provider,endpoint,offer,payload){return {ok:true,status:'FORMATTED_OFFLINE',provider,method:'POST',endpoint,identity:copy(offer.identity),snapshotSha256:offer.sha256,payload,expected:{netOre:offer.source.result.totals.sell_ex_ore,vatOre:offer.source.result.totals.vat_ore,grossOre:offer.source.result.totals.total_inc_ore},referenceIsNotIdempotency:true,canSend:false,requiredChecks:['authenticated-company-and-customer-context','atomic-local-reservation-before-creation','remote-row-and-total-comparison-before-receipt'],providerRoundingVerified:false};}
export function receiptCandidate(provider,tenantId,offer,remoteId){return {provider,tenantId,offerId:offer.identity.offerId,offerVersion:offer.identity.offerVersion,sha256:offer.sha256,status:'exported',remoteId};}
