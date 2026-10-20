import {roofGeometry} from './materialraknaren-takmodell.mjs';

// Benders Palema/Exklusiv 2023-07, pp4–7, table3 (p5), visually checked.
// Source constraints concern these two profiles only, never every tile/system.
const SOURCE={url:'https://benders.se/globalassets/c4-assets/document/Monteringsanvisning-BETONG-1o2kupig--2023-07-LU-2.pdf',sha256:'cf26e03f9f967478410f943011019e2caa7cbfbb04bf6d35d0ddff2a41d1ea11',pages:[4,5,6,7]};
const GAUGES=[375,370,365,360,355,350,345,340,335,330,325,320,310];
const DENSITY={palema:[8.9,9,9.2,9.3,9.4,9.6,9.7,9.8,10,10.1,10.3,10.4,10.8],exklusiv:[10.7,10.8,11,11.1,11.3,11.5,11.6,11.8,12,12.2,12.3,12.4,12.8]};
const fail=(field,code,message)=>({ok:false,issues:[{field,code,message}]});
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const ceil=v=>{const n=Math.round(v);return n>0&&Math.abs(v-n)<=8*Number.EPSILON*Math.max(1,Math.abs(v))?n:Math.ceil(v);};
function profileAtPitch(id,pitch){
  if(!['palema','exklusiv'].includes(id))return fail('profile','profile','Välj en källkontrollerad pannprofil för läktkontrollen.');
  if(!finite(pitch)||!(pitch>=14&&pitch<90))return fail('pitch','tile-pitch','Den valda pannprofilen kräver minst 14° taklutning. Välj en annan taktäckning eller kontrollera takmåtten.');
  return {ok:true,id,sourceVerified:true,minGaugeMm:310,maxGaugeMm:pitch<18?320:pitch<22?340:375,source:{...SOURCE,pages:[...SOURCE.pages]}};
}

/** Geometric basis + explicitly qualified main-tile estimate, not a complete bill. */
export function roofMaterialBasis(roofInput,options){
  if(!object(options))return fail('material','input','Välj taktäckning och materialuppgifter.');
  const geometry=roofGeometry(roofInput);if(!geometry.ok)return geometry;
  if(!['tiles','membrane'].includes(options.covering))return fail('covering','covering','Välj taktäckning.');
  const lengths=Object.fromEntries(['ridge','hip','valley','eave','verge','high'].map(k=>[k,geometry.totals[k]]));
  const fields={t_form:{gable:'sadel',mono:'pulpet',hip:'valm'}[geometry.input.form],t_yta:geometry.totals.areaSlope,t_nock:geometry.input.form==='mono'?lengths.high:lengths.ridge,t_valm:lengths.hip,t_takfot:lengths.eave,pp_yta:geometry.totals.areaSlope};
  const result={ok:true,version:1,geometry,lengths,faces:geometry.faces.map(f=>({id:f.id,areaPlan:f.areaPlan,areaSlope:f.areaSlope})),materialFields:fields,requiresExplicitApply:true,rectangularGridAllowed:geometry.input.plan==='rectangle'&&geometry.input.form!=='hip',method:'geometry-only',items:[],warnings:[],requiredChecks:[],completePurchasePlan:false};
  const check=(code,message)=>result.requiredChecks.push({code,message});
  // These needs remain explicit even when no generic SKU or quantity is justified.
  if(lengths.valley>0)check('valley-detail','Ränndal: välj beslag, tätning, underlag och anslutning enligt valt system. Geometrisk längd är inte en färdig kap- eller inköpsplan.');
  if(lengths.hip>0)check('hip-cutting','Valm: kontrollera kapning, start-/slutdelar och infästning.');
  if(lengths.high>0)check('high-edge-detail','Pulpettakets högsida behöver rätt avslutning. Högsideslängden är separat från nockpannor.');
  if(options.covering==='membrane'){
    result.rectangularGridAllowed=false;
    check('membrane-system','Välj produkt och kontrollera minsta lutning, överlapp, skarvar och anslutningar. Här visas bara geometribasis.');
    return result;
  }
  const custom=options.profile==='custom';
  const profile=custom?{ok:true,id:'custom',sourceVerified:false}:profileAtPitch(options.profile,geometry.input.pitch);
  if(!profile.ok)return profile;
  const gauge=options.gaugeMm===undefined?profile.maxGaugeMm:options.gaugeMm;
  if(!finite(gauge)||!(gauge>0&&gauge<=1000))return fail('gaugeMm','gauge','Ange läktavstånd i mm.');
  if(!custom&&(gauge<profile.minGaugeMm||gauge>profile.maxGaugeMm))return fail('gaugeMm','tile-gauge',`Den valda pannprofilen kräver läktavstånd ${profile.minGaugeMm}–${profile.maxGaugeMm} mm vid takets lutning. Ändra ditt val.`);
  const tableIndex=GAUGES.indexOf(gauge),tableDensity=custom||tableIndex<0?undefined:DENSITY[options.profile][tableIndex];
  const perM2=options.perM2===undefined?tableDensity:options.perM2;
  if(!finite(perM2)||!(perM2>0&&perM2<=1000))return fail('perM2','density','Ange pannor per m² för ditt val. Läktavståndet har ingen exakt rad i den kontrollerade åtgångstabellen.');
  if(!finite(options.wastePct)||!(options.wastePct>=0&&options.wastePct<=100))return fail('wastePct','waste','Ange reserv/spill mellan 0 och 100 %.');
  const capsNeeded=lengths.ridge+lengths.hip>0;
  if(capsNeeded&&(!finite(options.ridgePerM)||!(options.ridgePerM>0&&options.ridgePerM<=100)))return fail('ridgePerM','density','Ange nockpannor per meter för din valda panna.');
  if(options.windExposed!==undefined&&typeof options.windExposed!=='boolean')return fail('windExposed','exposure','Ange om taket är vindutsatt; valet får inte tolkas från annan text.');
  const pack=options.ridgePackSize===undefined?1:options.ridgePackSize;
  if(!Number.isSafeInteger(pack)||!(pack>=1&&pack<=1000))return fail('ridgePackSize','pack','Ange ett helt positivt antal nockpannor per förpackning.');
  result.method='area-estimate';result.profile={...profile,gaugeMm:gauge};delete result.profile.ok;
  result.density={perM2,sourceBased:tableDensity!==undefined&&perM2===tableDensity,origin:options.perM2===undefined?'source-table':'user'};
  result.effectiveWastePct=options.wastePct;
  // Source rules are not fastener quantities: edge/penetration locations are unknown.
  const windKnown=typeof options.windExposed==='boolean',pitch=geometry.input.pitch;
  result.fastening={method:custom?'unknown':options.profile==='exklusiv'?'clips-only':'source-approved-fastener',edgeRows:custom?null:2,aroundPenetrations:custom?null:true,fieldFraction:custom?null:pitch>55||options.windExposed===true?1:!windKnown?null:pitch>45?.2:0,quantityComputed:false};
  if(!custom){
    if(!windKnown&&pitch<=55)check('wind-exposure','Ange om taket är vindutsatt. Då gäller infästning av alla pannor, även vid lägre lutning.');
    check('fastening-layout',options.profile==='exklusiv'?'Exklusiv kräver clips. Kantzoner och genomföringar måste identifieras innan infästningen kan mängdas.':'Kontrollera infästning i kantzoner och runt genomföringar mot monteringsanvisningen. Ingen infästningsmängd är beräknad här.');
    if(lengths.hip>0)check('hip-sealing','Valmens tätning måste passa lutande valm. Ventinock är enligt denna källa bara för vågrät Palema-nock och ersätter inte valmtätning.');
    if(lengths.verge>0)check('gable-termination','Välj gavelavslut och kontrollera breddindelning och gavelpannans klipp mot läktavståndet. Normalpannans radantal visar inte att gavelpannan passar.');
  }
  const factor=1+options.wastePct/100;
  const tileNet=geometry.totals.areaSlope*perM2,ridgeNet=capsNeeded?(lengths.ridge+lengths.hip)*options.ridgePerM:0;
  if(!(tileNet>0))return fail('perM2','numeric','Åtgångstalet är för litet för att ge en säker materialmängd.');
  if(capsNeeded&&!(ridgeNet>0))return fail('ridgePerM','numeric','Nockåtgången är för liten för att ge en säker materialmängd.');
  const tileCount=ceil(tileNet*factor),ridgeNeed=capsNeeded?ceil(ridgeNet*factor):0,ridgeCount=capsNeeded?ceil(ridgeNeed/pack)*pack:0;
  if(![tileCount,ridgeNeed,ridgeCount].every(Number.isSafeInteger))return fail('material','numeric','Måtten ger större antal än modellen kan räkna säkert. Kontrollera mått, lutning och åtgångstal.');
  result.items.push({id:'tiles',unit:'st',quantity:tileCount,unroundedNeed:tileNet,quality:'area-estimate'});
  if(capsNeeded)result.items.push({id:'ridge-tiles',unit:'st',quantity:ridgeCount,neededQuantity:ridgeNeed,unroundedNeed:ridgeNet,packSize:pack,packBasis:options.ridgePackSize===undefined?'unpacked-count':'user-supplied',quality:'length-estimate'});
  if(!result.density.sourceBased)result.warnings.push({code:'custom-density',message:'Ditt eget åtgångstal används. Det är inte ett kontrollerat tabellvärde för den valda profilen och läktavståndet.'});
  if(custom)check('custom-material-system','Egna materialuppgifter: kontrollera produktens lutning, läktavstånd, underlag och infästning. Ingen tillverkarkompatibilitet är verifierad här.');
  if(!custom&&geometry.input.pitch<22)check('low-pitch-underlay','Under 22° anger Benders skarvklistrad underlagspapp av godkänd kvalitet. Kontrollera valt underlag.');
  check('measured-layout','Pannantalet är en ytmängd, inte en läkt- eller läggningsplan. Mät/provpassa yttersta läktlägen och gavelavslut.');
  check('waste-and-cuts','Reserv/spill och kapning måste bedömas för det verkliga taket. 0 % reserv ger inte ett verifierat exakt inköp.');
  check('system-accessories','Kontrollera underlag, läktdimensioner, nocktätning, infästning, genomföringar och taksäkerhet. De är inte komplett mängdade i denna materialbasis.');
  return result;
}

/** Conditional count from measured first/last batten tops on a rectangular face. */
export function measuredBattenLayout(input){
  if(!object(input))return fail('layout','input','Ange de uppmätta läktmåtten.');
  if(input.confirmed!==true)return fail('confirmed','measurement','Bekräfta att avståndet är uppmätt mellan första och sista bärläktens överkanter.');
  const profile=profileAtPitch(input.profile,input.pitch);if(!profile.ok)return profile;
  const span=input.battenSpanMm;
  if(!finite(span)||!(span>0&&span<=100000))return fail('battenSpanMm','measurement','Ange uppmätt sträcka mellan första och sista bärläktens överkanter i mm.');
  if(!Number.isSafeInteger(input.tilesPerRow)||!(input.tilesPerRow>=1&&input.tilesPerRow<=10000))return fail('tilesPerRow','count','Ange heltalsantal pannor per rad efter kontroll av bredd och gavelavslut.');
  const intervals=ceil(span/profile.maxGaugeMm),gauge=span/intervals;
  if(!(gauge>=profile.minGaugeMm-1e-9&&gauge<=profile.maxGaugeMm+1e-9))return fail('battenSpanMm','layout-fit','De fixerade läktlägena kan inte delas in inom tillåtet läktavstånd. Kontrollera och justera måtten på taket; räknaren ändrar dem inte.');
  const rows=intervals+1;
  return {ok:true,version:1,method:'confirmed-rectangular-face-count',intervals,rows,gaugeMm:gauge,tilesPerRow:input.tilesPerRow,tiles:rows*input.tilesPerRow,battenSpanMm:span,profile:input.profile,pitch:input.pitch,completePurchasePlan:false,requiredChecks:['Antalet gäller uppmätta läktlägen och angivet heltalsantal pannor per rad på ett rektangulärt takfall.','Kontrollera gavel-/nockavslut, tillbehör, reserv och kapning separat. Det är ingen komplett läggnings- eller inköpsplan.'],source:{...SOURCE,pages:[...SOURCE.pages]}};
}
