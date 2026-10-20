export const ROOF_EAVE_DETAIL_BASIS=Object.freeze({"adapter": "eave-detail-v1", "geometry": "d27f9743344287a9837c276557443b6e962b5717bf4bbed4feb5e65df48121ee", "core": "d1804c86abdc23a3478a5b9db09bdcde94ccc20359fec97d8e4c851ae2b1cc86", "carisma-2024": "40f9ffde1a5e678b0ee2e4d95e0c2140120321e27098b63c6d3e4cc2e096cd01", "fotplatsremsa-ma": "156ea7a101cf527bdcd4f9526fff32eba0aac151984765677a9ac969b7bb7fe9", "fotplatsremsa-pb": "6ed45f01e882709cdc90676837dd2df0d91f1e6ec475ef2db36297e91448227f", "haloten-pro-2026-09-29": "b85d11fd58f75fc129754b2c384f065fdf5e431c7070f601251b4fa890c7933b", "palema-exklusiv-2023": "cf26e03f9f967478410f943011019e2caa7cbfbb04bf6d35d0ddff2a41d1ea11"});
import {isRoofJson} from './materialraknaren-json-contract.mjs';
import {roofGeometry} from './materialraknaren-takmodell.mjs';
import {roofEavePlan} from './materialraknaren-takfot-plan.mjs';

// Physical dimensions and source prerequisites are separate. This adapter never
// certifies an assembly, derives support locations or changes the cutting core.
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(v,a)=>object(v)&&Object.keys(v).every(k=>a.includes(k));
const text=(v,n=160)=>typeof v==='string'&&v.trim().length>0&&v.length<=n;
const int=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const fail=(field,code,message)=>({ok:false,issues:[{field,code,message}]});
const sameBasis=v=>keys(v,Object.keys(ROOF_EAVE_DETAIL_BASIS))&&Object.entries(ROOF_EAVE_DETAIL_BASIS).every(([k,x])=>v[k]===x);
const PROFILE=['id','label','role','profileId','section','material','finish','coating','origin','stockLengthMm','endLapMm','cutLossMm','startExtraMm','endExtraMm','joinPolicy','joinSource','minPieceMm'];
const identity=p=>text(p.id,80)&&/^[a-zA-Z0-9_-]+$/.test(p.id)&&text(p.label)&&text(p.profileId,80)&&text(p.section)&&text(p.material,80)&&text(p.finish,80)&&keys(p.origin,['kind','reference'])&&['source','user-measured'].includes(p.origin.kind)&&text(p.origin.reference,1000);
const article=p=>JSON.stringify([p.productId??null,p.profileId,p.section,p.material,p.finish,p.coating??'unknown',p.stockLengthMm??null,p.widthMm??null]);
const physical=p=>JSON.stringify([p.role,article(p)]);
const coreProfile=p=>Object.fromEntries(['id','label','stockLengthMm','endLapMm','cutLossMm','startExtraMm','endExtraMm',...(p.widthMm===undefined?[]:['widthMm'])].map(k=>[k,p[k]]));
const namedDetails=['carisma-wedge','carisma-batten-alternative','palema-exklusiv-eave','haloten-pro-suspended','user-measured'];

export function roofEaveDetailPlan(input,options){
 try{
  if(!isRoofJson(input)||!isRoofJson(options))return fail('detail','json','Använd giltiga JSON-värden för takets utförande.');
  if(!keys(options,['version','basis','context','detail','flashings','strip','support'])||options.version!==1||!sameBasis(options.basis)||JSON.stringify(options).length>32768)return fail('detail','basis','Takfotens sparade version kan inte användas. Tidigare underlag finns kvar.');
  const c=options.context;
  if(!keys(c,['roofId','revision','covering','underlay','mount','substrate','ventilation','eaveBatten','underlayApproval','underlayEvidence','rafterSpacingMm'])||!/^r_[0-9a-f]{32}$/.test(c.roofId)||!int(c.revision,1,1e9)||!['carisma','palema','exklusiv','other','unknown'].includes(c.covering)||!text(c.underlay,80)||!['solid','suspended','unknown'].includes(c.mount)||!['raw-board','other','unknown'].includes(c.substrate)||!['yes','no','unknown'].includes(c.ventilation)||!['ordinary','ventilated','ventilated-birdcomb','unknown'].includes(c.eaveBatten)||!['documented','unsuitable','unknown'].includes(c.underlayApproval)||!(c.underlayEvidence===null||text(c.underlayEvidence,1000))||!(c.rafterSpacingMm===null||int(c.rafterSpacingMm,1,10000))||!namedDetails.includes(options.detail))return fail('context','context','Välj tak, version och faktiska förutsättningar för takfoten.');
  if(c.underlayApproval==='documented'&&!text(c.underlayEvidence,1000))return fail('context.underlayEvidence','source-evidence','Ange underlaget för uppgiften om godkänd underlagstäckning.');
  const g=roofGeometry(input);if(!g.ok)return g;
  const eaves=g.edges.filter(e=>e.type==='eave'),checks=[{code:'assembly-not-verified',message:'Kap- och mängdplanen godkänner inte montage eller konstruktion. Kontrollera avslut, hörn, anslutningar och infästning.'}];
  let unresolved=false,detailUnresolved=options.detail==='user-measured';
  const check=(code,message,unknown=false)=>{checks.push({code,message});if(unknown){unresolved=true;detailUnresolved=true;}};
  const d=options.detail,pitch=g.input.pitch;
  if(d.startsWith('carisma-')){
   if(c.covering!=='carisma'||pitch<18||c.mount==='suspended'||c.substrate==='other'||c.underlayApproval==='unsuitable'||c.ventilation==='no')return fail('detail','carisma-prerequisites','Carisma kräver minst 18 grader, råspont och för ändamålet godkänd papp.');
   if(c.substrate==='unknown'||c.mount==='unknown'||c.ventilation==='unknown')check('carisma-substrate-unknown','Bekräfta verklig råspont och underlagets utförande mot källan.',true);
   if(c.underlayApproval!=='documented')check('carisma-underlay-unknown','Underlagets lämplighet är inte belagd. YEP2500 eller likvärdig rekommenderas; likvärdighet antas inte.',true);
   check('carisma-underlay','All läggning enligt Carisma 2024 ska ske på råspont och för ändamålet godkänd papp. YEP2500 eller likvärdig rekommenderas; angivet underlag är inte automatiskt tillverkarverifierat.');
   if(d==='carisma-wedge'){
    if(pitch<22||['ordinary','ventilated-birdcomb'].includes(c.eaveBatten))return fail('detail','carisma-wedge','Carismas killösning kräver minst 22 grader och ventilerad takfotsläkt.');
    if(c.eaveBatten==='unknown')check('carisma-batten-unknown','Välj verklig ventilerad takfotsläkt innan killösningen används.',true);
    check('carisma-wedge-section','Cirka 55 mm kil och 25 mm ventilerad läkt är principmått, inte en vald lagerprofil eller godkänd sektion.');
   }else check('carisma-double-batten','Alternativet med dubbel läkt innebär inte två fotplåtar. Eventuell täckplåt och gavelns avrinningsplåt har andra roller.');
  }
  if(d==='palema-exklusiv-eave'){
   if(!['palema','exklusiv'].includes(c.covering)||pitch<14)return fail('detail','palema-prerequisites','Palema och Exklusiv kräver minst 14 graders lutning i denna källa.');
   if(c.eaveBatten==='ventilated-birdcomb')check('palema-birdcomb-exception','Ventilerat fågelband är undantaget från rådet om cirka 20 mm högre takfotsläkt. Provpassa mot panna, ränna och lutning.');
   else check('palema-raise-20','Takfotsläkten är cirka 20 mm högre än vanlig bärläkt enligt anvisningen. Provpassa mot panna, ränna och lutning; detta väljer ingen kilprofil.',c.eaveBatten==='unknown');
  }
  if(d==='haloten-pro-suspended'){
   if(c.underlay!=='haloten-pro'||c.mount!=='suspended'||c.covering==='carisma'||pitch<14||(c.rafterSpacingMm!==null&&c.rafterSpacingMm>1200)||c.ventilation==='no')return fail('detail','haloten-prerequisites','Frihängande Haloten PRO kräver minst 14 grader, högst 1 200 mm takstolsavstånd och ventilation. Det uppfyller inte Carismas råspontkrav.');
   if(c.rafterSpacingMm===null||c.ventilation==='unknown')check('haloten-context-unknown','Ange verkligt takstolsavstånd och ventilationsutförande.',true);
   check('haloten-fasteners','Haloten PRO 2026-09-29: fotbräda av K-plywood eller råspont på platsmåttsatta stöd, med vindskydd och ventilation. Anvisningen visar c/c 300 för remsa och c/c 150 för plåt; komplett infästnings- eller klisterinköp är inte mängdat.');
  }
  if(Object.hasOwn(options,'flashings')&&(!Array.isArray(options.flashings)||options.flashings.length>2))return fail('flashings','components','Välj högst två verkliga fotplåtar.');
  const selected=(options.flashings||[]).map(p=>({kind:'flashing',p}));
  if(Object.hasOwn(options,'strip'))selected.push({kind:'strip',p:options.strip});
  if(Object.hasOwn(options,'support')){
   if(!keys(options.support,['kind','profile','id','label','role','profileId','section','material','finish','coating','origin','onePerPosition','runs'])||!['continuous','discrete'].includes(options.support.kind))return fail('support','support','Välj sammanhängande kil eller verkliga diskreta stöd.');
   if(options.support.kind==='continuous'){
    if(Object.keys(options.support).some(k=>!['kind','profile'].includes(k))||d==='haloten-pro-suspended')return fail('support','support-method','Frihängande fotbräda på diskreta stöd är inte en sammanhängande kil.');
    selected.push({kind:'wedge',p:options.support.profile});
   }
  }
  const ids=new Set(),roles=new Set(),components=[];
  for(const {kind,p}of selected){
   const extra=kind==='strip'?['productId','widthMm','crossSection']:[];
   if(!keys(p,[...PROFILE,...extra])||!identity(p)||ids.has(p.id)||roles.has(p.role)||!(kind==='flashing'?['eave-sheet-primary','eave-sheet-secondary'].includes(p.role):kind==='strip'?p.role==='strip-under-sheet':p.role==='continuous-wedge'))return fail(kind,'physical-identity','Varje lager behöver egen roll, profil, sektion, material, ytskikt och måttens ursprung.');
   ids.add(p.id);roles.add(p.role);
   if(!int(p.stockLengthMm,1,100000)||!int(p.endLapMm,0,p.stockLengthMm-1)||!int(p.cutLossMm,0,p.stockLengthMm-1)||p.endLapMm+p.cutLossMm>=p.stockLengthMm||!int(p.startExtraMm,0,100000)||!int(p.endExtraMm,0,100000)||!['none','source','user-supplied'].includes(p.joinPolicy)||!(p.minPieceMm===null||int(p.minPieceMm,1,p.stockLengthMm))||(p.joinPolicy==='none'&&p.endLapMm!==0)||(p.joinPolicy==='source'&&!text(p.joinSource,1000))||Object.hasOwn(p,'joinSource')&&!text(p.joinSource,1000))return fail(kind,'dimensions','Ange lagerlängd, skarvmetod, kapförlust, ändtillägg och känt minsta bitmått eller uttryckligen okänt, i hela mm.');
   if(Object.hasOwn(p,'coating')&&!['pvc','non-pvc','unknown'].includes(p.coating))return fail(kind,'coating','Ange uttryckligen PVC, annan beläggning eller okänd beläggning.');
   if(d==='haloten-pro-suspended'&&kind==='flashing'){
    if(p.coating==='pvc')return fail(kind,'haloten-pvc','PVC-belagd fotplåt får inte användas i denna Haloten PRO-anvisning.');
    if(p.coating===undefined||p.coating==='unknown')check('haloten-coating-unknown','Fotplåtens beläggning behöver vara känd. Ett produktnamn bevisar inte om beläggningen innehåller PVC.',true);
   }
   const out={id:p.id,label:p.label,role:p.role,physicalIdentity:physical(p),articleIdentity:article(p),sourceOrigin:structuredClone(p.origin),scope:{roofId:c.roofId,revision:c.revision,edgeIds:eaves.map(e=>e.id)},quantityStatus:'geometry-only',unresolvedChecks:[]};
   const unknown=(code,message)=>{out.quantityStatus='unresolved';out.unresolvedChecks.push({code,message});unresolved=true;};
   if(kind==='strip'){
    if(!['5039501','user-measured'].includes(p.productId)||!int(p.widthMm,1,10000)||p.productId==='5039501'&&(p.widthMm!==330||p.stockLengthMm!==25000))return fail('strip','strip-product','Fotplåtsremsa 5039501 är 330 mm bred och 25 m lång. Annan uppmätt remsa ska ha egen identitet.');
    if(p.crossSection===null)unknown('strip-section-unknown','Mät remsans verkliga utvecklade tvärsnitt och anslutningar. Bredden i sig bevisar inte passning.');
    else if(!keys(p.crossSection,['abovePlateMm','belowEdgeMm','developedPathMm'])||!int(p.crossSection.abovePlateMm,1,10000)||!int(p.crossSection.belowEdgeMm,1,10000)||!int(p.crossSection.developedPathMm,1,p.widthMm)||p.crossSection.developedPathMm<p.crossSection.abovePlateMm+p.crossSection.belowEdgeMm||(p.productId==='5039501'||d==='haloten-pro-suspended')&&(p.crossSection.abovePlateMm<150||p.crossSection.belowEdgeMm<50))return fail('strip.crossSection','strip-fit','Kontrollera utvecklad väg och veck: källans remsa ska nå minst 150 mm ovanför plåten och 50 mm nedanför takkanten och rymmas i 330 mm.');
    check('strip-mount','Remsa, plåt, underlagsduk, trekantslist och anslutningar ska följa rätt anvisning. Ingen ändskarv, minbit eller klisterförpackning antas från produktmåtten.');
   }
   const joined=eaves.some(e=>Math.ceil(e.length*1000)+p.startExtraMm+p.endExtraMm>p.stockLengthMm);
   if(joined&&(p.joinPolicy==='none'||p.minPieceMm===null))unknown('joint-unknown','Sträckan kräver skarv eller restbit utan användbart underlag. Ange belagd eller uttryckligt egen skarv och minsta bit, eller välj annan verklig lösning.');
   if(out.quantityStatus!=='unresolved'){
    const coreOptions=kind==='flashing'?{flashings:[coreProfile(p)]}:kind==='strip'?{strip:coreProfile(p)}:{wedge:coreProfile(p)};
    const result=roofEavePlan(g.input,coreOptions);if(!result.ok)return result;const plan=result.components[0];
    if(p.joinPolicy==='none'&&plan.runs.some(r=>r.pieces!==1)||p.minPieceMm!==null&&plan.pieces.some(x=>x.lengthMm<p.minPieceMm))return fail(kind,'piece-fit','Kapplanen behöver en förbjuden skarv eller en bit som är kortare än ditt angivna minsta mått. Välj en annan plan.');
    const seen=new Set();for(const stock of plan.stock){let used=0;for(const id of stock.pieceIds){const piece=plan.pieces.find(x=>x.id===id);if(!piece||seen.has(id)||piece.stockId!==stock.id)return fail(kind,'balance','Kapplanens bitar kan inte användas säkert.');seen.add(id);used+=piece.lengthMm+piece.cutLossMm;}if(used!==stock.usedMm||used+stock.remainderMm!==p.stockLengthMm||stock.remainderMm<0)return fail(kind,'balance','Kapplanens lagerbalans stämmer inte.');}
    if(seen.size!==plan.pieces.length)return fail(kind,'balance','En kapbit saknas i lagerplanen.');
    out.plan=plan;
   }
   components.push(out);
   if(kind==='wedge')check('support-not-batten-replacement','Sammanhängande kil är ett separat uppmätt behov. Ingen takfotsläkt har ersatts eller räknats bort.');
  }
  if(options.support?.kind==='discrete'){
   const s=options.support;
   if(Object.hasOwn(s,'coating')&&!['pvc','non-pvc','unknown'].includes(s.coating))return fail('support','coating','Ange uttryckligen PVC, annan beläggning eller okänd beläggning.');
   if(Object.hasOwn(s,'profile')||!identity(s)||s.role!=='discrete-support'||ids.has(s.id)||s.onePerPosition!==true||!Array.isArray(s.runs)||s.runs.length!==eaves.length)return fail('support','positions','Ange uppmätta stöd, ett per faktiskt valt läge på varje takfot, med egen profil och mått.');
   const used=new Set();let count=0;
   for(const r of s.runs){const edge=eaves.find(e=>e.id===r.edgeId);if(!keys(r,['edgeId','positionsMm'])||!edge||used.has(edge.id)||!Array.isArray(r.positionsMm)||!r.positionsMm.length)return fail('support.runs','positions','Stödens lägen måste höra till rätt takfötter.');used.add(edge.id);let prev=-1;for(const x of r.positionsMm){if(!int(x,0,Math.ceil(edge.length*1000))||x<=prev)return fail('support.runs','positions','Ange unika stödpositioner i stigande hela mm inom takfotens längd.');prev=x;count++;}}
   components.push({id:s.id,label:s.label,role:s.role,physicalIdentity:physical(s),articleIdentity:article(s),sourceOrigin:structuredClone(s.origin),scope:{roofId:c.roofId,revision:c.revision,edgeIds:eaves.map(e=>e.id)},quantityStatus:'unresolved',supportCount:count,unresolvedChecks:[{code:'support-stock-unknown',message:'Antalet uppmätta stöd är ett behov i styck. Stockkapning, stödform, fotbräda och infästning är inte mängdade.'}]});unresolved=true;
  }
  if(d==='haloten-pro-suspended'&&!options.support)check('haloten-support-unknown','Ange fotbräda och verkliga stödpositioner. Takstolsavstånd är inte en universell regel för kilarnas placering.',true);
  const quantityStatus=unresolved?'unresolved':'geometry-only';
  return {ok:true,version:1,basis:{...ROOF_EAVE_DETAIL_BASIS},roof:{id:c.roofId,revision:c.revision,geometryBasis:ROOF_EAVE_DETAIL_BASIS.geometry,input:structuredClone(g.input)},detail:d,detailStatus:detailUnresolved?'unresolved':'prerequisites-met',assemblyApproval:'not-verified',quantityStatus,canApplyPurchase:!unresolved&&components.length>0,components,requiredChecks:checks,completeAssembly:false};
 }catch{return fail('detail','input','Takfotens uppgifter kunde inte läsas. Tidigare underlag finns kvar.');}
}
