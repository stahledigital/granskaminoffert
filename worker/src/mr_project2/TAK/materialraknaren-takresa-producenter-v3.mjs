import {roofStateBasisV3} from './materialraknaren-takresa-state-v3.mjs';
import {roofMaterialPart,roofDrainagePart} from './materialraknaren-takresa-producenter.mjs';
import {roofMaterialPartV2,roofDrainagePartV2} from './materialraknaren-takresa-producenter-v2.mjs';
import {roofMaterialWithUnderlayPart} from './materialraknaren-takresa-underlag.mjs';
const fail=(code,message)=>({ok:false,issues:[{field:'roof-list',code,message}]});
const number=x=>String(x).replace('.',',');
const context=s=>`Tak ${s.id} · revision ${s.revision} · ${s.input.plan}/${s.input.form} · hus ${number(s.input.length)} × ${number(s.input.width)} m${s.input.plan==='L'?` · flygel ${number(s.input.extension)} m`:''} · ${number(s.input.pitch)}° · takfotsutsprång ${number(s.input.eaveOverhang)} m · gavelutsprång ${number(s.input.gableOverhang)} m`;
export function roofMaterialPartV3(raw){
 const b=roofStateBasisV3(raw);if(!b.ok)return b;const s=b.state;
 const p=(s.interpreterVersion===1?(b.underlay?roofMaterialWithUnderlayPart:roofMaterialPart):roofMaterialPartV2)(b.legacyState);if(p.ok===false)return p;
 return {...p,ctx:context(s)};
}
export function roofDrainagePartV3(raw){
 const b=roofStateBasisV3(raw);if(!b.ok)return b;
 const p=(b.state.interpreterVersion===1?roofDrainagePart:roofDrainagePartV2)(b.legacyState);return p.ok===false?p:{...p,ctx:context(b.state)};
}
// Escape separators so different typed article tuples cannot collapse into a
// display-key collision. Full typed identity and cut ledgers stay in state.
const keyPart=x=>String(x).replaceAll('\\','\\\\').replaceAll('·','\\·');
const articleKey=p=>[p.productId??'Egen profil',p.profileId,p.section,p.material,p.finish,p.coating??'unknown',`${p.stockLengthMm} mm`,p.widthMm===undefined?'-':`${p.widthMm} mm`].map(keyPart).join(' · ');
export function roofEavePartV3(raw){
 const b=roofStateBasisV3(raw);if(!b.ok)return b;
 if(!b.eave||!b.eave.canApplyPurchase)return fail('eave-unresolved','Takfotsplanen saknar uppgifter för ett samlat inköp. Fyll i de markerade förutsättningarna; ingen delmängd har lagts till.');
 const rows=[],notes=b.eave.requiredChecks.map(c=>c.message),o=b.state.eave;
 const profiles=[...(o.flashings||[]),...(o.strip?[o.strip]:[]),...(o.support?.kind==='continuous'?[o.support.profile]:[])];
 for(const c of b.eave.components){
  const p=profiles.find(p=>p.id===c.id);if(!p||!c.plan)return fail('eave-unresolved','Takfotsplanens fullständiga profil eller kapplan saknas.');
  const k=articleKey(p);if(k.length>160)return fail('article-length','Profilens fullständiga artikeluppgifter ryms inte på en materialrad. Ingen identitet eller text har kapats.');
  rows.push({hd:'',k,v:c.plan.purchaseCount,u:c.role==='strip-under-sheet'?'rullar':'st',sub:`${p.label} · ${c.role} · separat lager- och kapplan · ${c.plan.pieces.length} monterade bitar. Ingen global minsta-inköpsgaranti.`});
  notes.push(`${p.origin.kind==='source'?'Angiven källreferens, inte egen tillverkarverifiering':'Egen projektuppgift'}: ${p.origin.reference}`);
 }
 if(notes.length>20||notes.some(n=>n.length>1200))return fail('notes','Takfotens fullständiga förutsättningar ryms inte inom formatet. Ingen text har kapats.');
 return {title:'Takfot',short:`${rows.length} separata lager/profiler`,ctx:context(b.state),notes,rows,settings:{}};
}
