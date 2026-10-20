import {roofStateBasis} from './materialraknaren-takresa-state.mjs';
import {drainageConditions} from './materialraknaren-avvattningsvillkor.mjs';
const fmt=x=>x.toLocaleString('sv-SE',{maximumFractionDigits:3});
const fail=message=>({ok:false,issues:[{field:'roof-list',code:'missing-basis',message}]});
const row=(k,v,u,sub='',kind)=>({hd:'',k,v,u,sub,...(kind?{kind}:{})});
const forms={gable:'Sadeltak',mono:'Pulpettak',hip:'Valmat tak'};
function context(s){const i=s.input;return `${forms[i.form]} · ${i.plan==='L'?'L-form':'rektangel'} · hus ${fmt(i.length)} × ${fmt(i.width)} m${i.plan==='L'?`, flygel ${fmt(i.extension)} m`:''} · ${fmt(i.pitch)}° · takfotsutsprång ${fmt(i.eaveOverhang)} m · gavelutsprång ${fmt(i.gableOverhang)} m`;}
const needs=items=>[...new Set(items.map(x=>typeof x==='string'?x:x.message))];
/** Only source-supported TM2 items. Geometry is an information row; unmet
 * accessory/layout requirements are notes, never guessed priced quantities. */
export function roofMaterialPart(raw){
 const b=roofStateBasis(raw);if(!b.ok)return b;if(!b.material)return fail('Välj takmaterial innan du lägger till taket.');
 const s=b.state,m=b.material,rows=[row('Takyta',b.geometry.totals.areaSlope,'m²','Yta längs takfallen, inte husets planarea.','matt')],labels={palema:'2-kupig betong',exklusiv:'1-kupig betong',custom:'egna materialuppgifter'},label=labels[s.material.profile];
 for(const item of m.items)rows.push(row(item.id==='tiles'?`Takpannor ${label}`:`Nockpannor ${label}`,item.quantity,item.unit,item.id==='tiles'?`Ytmängd: ${fmt(m.density.perM2)} st/m² · reserv ${fmt(s.material.wastePct)} %. Ingen läggningsplan.`:`Nock + valm · ${fmt(s.material.ridgePerM)} st/m · reserv ${fmt(s.material.wastePct)} % · ${item.packSize>1?`hela förpackningar à ${item.packSize}`:'antal utan förpackningsavrundning'}.`));
 const notes=needs([...m.requiredChecks,...m.warnings]);
 if(s.material.covering==='membrane')rows.push(row('Papp och duk – materialplan återstår',1,'behov','Produkt, våder, överlapp och infästning behöver planeras.','behov'));
 return {title:'Tak',short:`${forms[s.input.form]} · ${fmt(b.geometry.totals.areaSlope)} m²`,ctx:context(s)+(s.material.covering==='tiles'?` · reserv ${fmt(s.material.wastePct)} %`:''),notes,rows,settings:s.material.covering==='tiles'?{t_spill:String(s.material.wastePct)}:{}};
}
/** A saved drainage plan, not a SKU/pipe-length purchasing adapter. Keep every
 * real catchment, source limit and unverified corner in the same snapshot. */
export function roofDrainagePart(raw){
 const b=roofStateBasis(raw);if(!b.ok)return b;if(!b.drainage)return fail('Planera rör och rännhögpunkter innan du sparar avvattningen.');
 const s=b.state,system=s.drainage.system,label=system.profile==='plannja-2026'?'Plannja':system.profile==='plastmo-plastic'?'Plastmo plast':'ej valt system',rows=[];
 for(const g of b.drainage.gutters){rows.push(row(`Takfot ${g.edgeId}`,g.length,'m','Geometrisk nettolängd, inte hela rännor att köpa.','matt'));for(const p of g.outlets)rows.push(row(`Avrinningsyta ${p.id}`,p.areaSlope,'m²',`${g.edgeId} · rör vid ${fmt(p.at)} m · längsta planerade rinnväg ${fmt(p.maxGutterRun)} m.`,'matt'));}
 rows.push(row('Takavvattning – inköpsplan återstår',1,'behov','Rännor, rör, krokar, hörn, expansion, anslutningar och bortledning behöver mängdas för valt system.','behov'));
 const notes=needs(b.drainage.requiredChecks);
 notes.push(`${label}: ${system.gutter}/${system.pipe} mm. Kapacitetstabell är inte en komplett inköps- eller montageplan.`);
 if(!system.profile)notes.push('Välj ett källkontrollerat system för att jämföra kapacitet.');
 for(const t of b.tables){const r=t.result;if(!r.ok)notes.push(...r.issues.map(x=>x.message));else{notes.push(`${t.pipeId}: ${label} ${r.withinTable?'inom':'överskrider'} tabellvärdena för denna yta (${fmt(r.areaSlope)} m²; ränna ${r.gutterLimit} m², rör ${r.pipeLimit} m²).`);if(!r.compatibilityVerified)notes.push(`${label}: vald ränn-/rörkombinations kompatibilitet är inte verifierad här.`);}}
 for(const c of drainageConditions(b.drainage,system))notes.push(`${c.pipeId} (${c.edgeId}): ${c.message}`);
 return {title:'Takavvattning',short:`${label} · ${b.drainage.gutters.reduce((n,g)=>n+g.outlets.length,0)} planerade stuprör`,ctx:context(s),notes:needs(notes),rows,settings:{}};
}
