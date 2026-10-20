// New profile-aware projection. V1 projections and their snapshots stay frozen.
import {roofStateBasisV2} from './materialraknaren-takresa-state-v2.mjs';
import {roofDrainagePart as legacyDrainagePart} from './materialraknaren-takresa-producenter.mjs';
import {ROOF_BASIS} from './materialraknaren-takresa-state.mjs';
const fmt=x=>x.toLocaleString('sv-SE',{maximumFractionDigits:3});
const fail=message=>({ok:false,issues:[{field:'roof-list',code:'missing-basis',message}]});
const row=(k,v,u,sub='',kind)=>({hd:'',k,v,u,sub,...(kind?{kind}:{})});
const forms={gable:'Sadeltak',mono:'Pulpettak',hip:'Valmat tak'};
const unique=items=>[...new Set(items.map(x=>typeof x==='string'?x:x.message))];
function context(s){const i=s.input;return `${forms[i.form]} · ${i.plan==='L'?'L-form':'rektangel'} · hus ${fmt(i.length)} × ${fmt(i.width)} m${i.plan==='L'?`, flygel ${fmt(i.extension)} m`:''} · ${fmt(i.pitch)}° · takfotsutsprång ${fmt(i.eaveOverhang)} m · gavelutsprång ${fmt(i.gableOverhang)} m`;}
export function roofMaterialPartV2(raw){
 const b=roofStateBasisV2(raw);if(!b.ok)return b;if(!b.material)return fail('Välj takmaterial innan du lägger till taket.');
 const s=b.state,m=b.material,rows=[row('Takyta',b.geometry.totals.areaSlope,'m²','Yta längs takfallen, inte husets planarea.','matt')],notes=unique([...m.requiredChecks,...m.warnings]);
 if(s.material.covering==='tiles'){
  const label=m.profile.name||`egna materialuppgifter (${fmt(m.density.perM2)} st/m²; ${fmt(s.material.gaugeMm)} mm)`;
  for(const item of m.items)rows.push(row(item.id==='tiles'?`Takpannor ${label}`:`Nockpannor till ${label} – kontrollera produktval`,item.quantity,item.unit,item.id==='tiles'?`Ytmängd: ${fmt(m.density.perM2)} st/m² (${m.density.sourceBased?'källtabell':'eget åtgångstal'}) · reserv ${fmt(s.material.wastePct)} %. Ingen läggningsplan.`:`Nock + valm · eget antal ${fmt(s.material.ridgePerM)} st/m · reserv ${fmt(s.material.wastePct)} % · ${item.packSize>1?`hela förpackningar à ${item.packSize}`:'antal utan förpackningsavrundning'}.`));
 }else rows.push(row('Papp och duk – materialplan återstår',1,'behov','Produkt, våder, överlapp och infästning behöver planeras.','behov'));
 if(b.underlay){const u=b.underlay;rows.push(row('Underlagspapp YAP2200, 0,67 × 15 m',u.totals.rolls,'rullar',`${u.totals.baseRolls} rullar från kapplanen + ${u.totals.reserveRolls} hela reservrullar (${fmt(s.underlay.reservePct)} %). Gäller takfallens ytvåder; anslutningar och infästning mängdas separat.`));notes.push(...u.requiredChecks.map(x=>x.message));}
 return {title:'Tak',short:`${forms[s.input.form]} · ${fmt(b.geometry.totals.areaSlope)} m²`,ctx:context(s)+(s.material.covering==='tiles'?` · reserv ${fmt(s.material.wastePct)} %`:''),notes:unique(notes),rows,settings:s.material.covering==='tiles'?{t_spill:String(s.material.wastePct)}:{}};
}
export function roofDrainagePartV2(raw){
 const b=roofStateBasisV2(raw);if(!b.ok)return b;if(!b.drainage)return fail('Planera rör och rännhögpunkter innan du sparar avvattningen.');
 const s=b.state;return legacyDrainagePart({format:s.format,version:1,id:s.id,revision:s.revision,basis:{...ROOF_BASIS},input:s.input,material:null,drainage:s.drainage});
}
