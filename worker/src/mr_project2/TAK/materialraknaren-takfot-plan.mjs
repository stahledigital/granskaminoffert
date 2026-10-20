import {roofGeometry} from './materialraknaren-takmodell.mjs';

const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const fail=(field,message)=>({ok:false,issues:[{field,code:'eave-plan',message}]});
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;

/** Optional eave procurement arithmetic, using explicit supplied dimensions.
 * This does not choose or approve an assembly/manufacturer profile. No defaults
 * for overlaps, stock, cut loss or extra ends; no price or batten substitution.
 * Separate eaves have separate joints. Only physically fitting offcuts of the
 * same component share stock. First-fit decreasing is not a minimum guarantee.
 */
export function roofEavePlan(input,options){
 const geometry=roofGeometry(input);if(!geometry.ok)return geometry;
 if(!object(options)||Object.keys(options).some(k=>!['flashings','strip','wedge'].includes(k)))return fail('eave','Välj uttryckliga takfotstillval.');
 if(options.flashings!==undefined&&(!Array.isArray(options.flashings)||options.flashings.length>2))return fail('flashings','Välj högst två separata fotplåtar.');
 const selected=(options.flashings||[]).map(p=>({kind:'flashing',profile:p}));
 for(const kind of ['strip','wedge'])if(options[kind]!==undefined)selected.push({kind,profile:options[kind]});
 const ids=new Set(),components=[];
 for(const {kind,profile:p} of selected){
  if(!object(p)||typeof p.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(p.id)||ids.has(p.id)||typeof p.label!=='string'||!p.label.trim()||p.label.length>160)return fail(kind,'Varje komponent behöver en egen identitet och benämning.');
  ids.add(p.id);
  if(!integer(p.stockLengthMm,1,100000)||!integer(p.endLapMm,0,p.stockLengthMm-1)||!integer(p.cutLossMm,0,p.stockLengthMm-1)||p.endLapMm+p.cutLossMm>=p.stockLengthMm||!integer(p.startExtraMm,0,100000)||!integer(p.endExtraMm,0,100000))return fail(kind,'Ange lagerlängd, skarvöverlapp, kapförlust och ändtillägg i hela mm.');
  if(kind==='strip'&&!integer(p.widthMm,1,10000))return fail('strip.widthMm','Ange remsans bredd i mm.');
  const runs=[],pieces=[],stock=[];
  for(const edge of geometry.edges.filter(e=>e.type==='eave')){
   // Round each physical edge outward once; do not round the total or discard
   // a positive fraction that would make the selected pieces too short.
   const netLengthMm=Math.ceil(edge.length*1000),target=netLengthMm+p.startExtraMm+p.endExtraMm;
   let remaining=target,index=0;
   while(remaining>0){
    const needed=remaining+(index?p.endLapMm:0);
    const lengthMm=Math.min(needed,p.stockLengthMm);
    pieces.push({id:`${p.id}:${edge.id}:${++index}`,edgeId:edge.id,lengthMm});
    remaining-=lengthMm-(index>1?p.endLapMm:0);
    if(pieces.length>10000)return fail(kind,'Kapplanen blir för stor. Kontrollera mått och lagerlängd.');
   }
   runs.push({edgeId:edge.id,netLengthMm,coveredLengthMm:target,pieces:index});
  }
  for(const piece of [...pieces].sort((a,b)=>b.lengthMm-a.lengthMm||a.id.localeCompare(b.id))){
   let bin=stock.find(s=>p.stockLengthMm-s.usedMm>=piece.lengthMm);
   if(!bin){bin={id:`${p.id}:stock:${stock.length+1}`,usedMm:0,cutLossMm:0,pieceIds:[]};stock.push(bin);}
   // Saw loss is real remaining stock, not an extra length after the stock end.
   // A last piece may use the exact remainder; a short tail is consumed only once.
   const cutLossMm=Math.min(p.cutLossMm,p.stockLengthMm-bin.usedMm-piece.lengthMm);
   piece.stockId=bin.id;piece.cutLossMm=cutLossMm;
   bin.usedMm+=piece.lengthMm+cutLossMm;bin.cutLossMm+=cutLossMm;bin.pieceIds.push(piece.id);
  }
  for(const bin of stock)bin.remainderMm=p.stockLengthMm-bin.usedMm;
  components.push({id:p.id,label:p.label.trim(),kind,stockLengthMm:p.stockLengthMm,endLapMm:p.endLapMm,cutLossMm:p.cutLossMm,...(kind==='strip'?{widthMm:p.widthMm}:{}),netLengthMm:runs.reduce((s,r)=>s+r.netLengthMm,0),runs,pieces,stock,purchaseCount:stock.length,method:'explicit-profile-first-fit-decreasing',profileStatus:'supplied-not-system-verified'});
 }
 const requiredChecks=components.length?[{code:'assembly-profile',message:'Kontrollera valda komponenter, mått, skarvar och montage mot valt taksystem. Planen godkänner inte konstruktionen.'},{code:'ends-and-corners',message:'Ändtillägg gäller varje separat takfotssträcka. Kontrollera hörn och anslutningar; de är inte automatiskt mängdade.'}]:[];
 if(options.wedge!==undefined)requiredChecks.push({code:'wedge-batten-relationship',message:'Kontrollera takfotskilens funktion mot takfotsläkt och övrig uppbyggnad. Ingen befintlig läktrad har tagits bort eller ersatts.'});
 return {ok:true,version:1,components,completeAssembly:false,requiredChecks};
}
