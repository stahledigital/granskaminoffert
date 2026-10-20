import {roofGeometry} from './materialraknaren-takmodell.mjs';
const MANUAL='https://mataki.se/storage/7E9861A811C771503386D34BA981FD8B98949343EEBF972E9147486C0CD97572/dae391813ed84c908850ea7566bf94ab/pdf/media/ed350a0883e24bebbbf76b3aba121264/Mataki%20YAM_YAP_YEP_MA.pdf';
const PRODUCT='https://mataki.se/underlagstackning/underlagspapp/5035001-underlagspapp-yap-2200-mataki-15x0-67-m';
const fail=(field,code,message)=>({ok:false,issues:[{field,code,message}]});
const finite=v=>typeof v==='number'&&Number.isFinite(v),object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const ceil=x=>{const n=Math.round(x);return n>0&&Math.abs(n-x)<=16*Number.EPSILON*Math.max(1,Math.abs(x))?n:Math.ceil(x);};
const mm=x=>ceil(x*1000),MAX_COURSES=4096,MAX_PIECES=10000;
const widthMm=670,rollMm=15000,sideOverlapMm=80;
// MA4B: diagonal trim300 + remaining minimum overlap150.450 is the
// conservative rectangular blank allowance, NOT a quoted450mm overlap rule.
const diagonalTrimMm=300,endOverlapMm=150,jointAllowanceMm=diagonalTrimMm+endOverlapMm;
function clip(poly,bound,above){
 const out=[];for(let i=0;i<poly.length;i++){const a=poly[i],b=poly[(i+1)%poly.length],ia=above?a[1]>=bound:a[1]<=bound,ib=above?b[1]>=bound:b[1]<=bound;if(ia)out.push(a);if(ia!==ib){const t=(bound-a[1])/(b[1]-a[1]);out.push([a[0]+t*(b[0]-a[0]),bound]);}}return out;
}
const area=p=>Math.abs(p.reduce((sum,a,i)=>{const b=p[(i+1)%p.length];return sum+a[0]*b[1]-b[0]*a[1];},0))/2;
/** Whole-width rectangular blanks enclosing the actual face bands. No layout,
 * source count or old project is changed by this pure optional consumer.
 * Flashings, folded edges, penetrations, ridge/valley strips and fastening are
 * deliberately separate needs; this result is NOT a complete roof purchase.
 */
export function roofUnderlayPlan(input,options){
 if(!object(options)||Object.keys(options).some(k=>!['product','reservePct'].includes(k))||options.product!=='mataki-yap2200'||!finite(options.reservePct)||options.reservePct<0||options.reservePct>100)return fail('underlay','product','Välj källkontrollerad underlagspapp och ange reserv mellan0 och100%.');
 const g=roofGeometry(input);if(!g.ok)return g;
 if(g.input.pitch<14)return fail('pitch','underlay-pitch','Mataki YAP2200 kräver minst14° taklutning. Kontrollera både underlag och taktäckning.');
 const faces=[],pieces=[],cos=Math.cos(g.input.pitch*Math.PI/180);let courseCount=0,clippedArea=0,joints=0;
 for(const face of g.faces){
  const [dx,dy]=face.fallDirection,projected=face.polygon.map(p=>[-dy*p[0]+dx*p[1],-(dx*p[0]+dy*p[1])/cos]);
  const t0=Math.min(...projected.map(p=>p[1])),t1=Math.max(...projected.map(p=>p[1])),height=t1-t0;
  const n=Math.max(1,ceil((height*1000-sideOverlapMm)/(widthMm-sideOverlapMm)));
  if(!Number.isSafeInteger(n)||courseCount+n>MAX_COURSES)return fail('underlay','plan-limit','Takmåtten ger för många våder för en säker kapplan. Dela upp arbetet.');
  const courses=[];
  for(let i=0;i<n;i++){
   const lo=t0+i*(widthMm-sideOverlapMm)/1000,hi=lo+widthMm/1000,polygon=clip(clip(projected,lo,true),hi,false);
   if(polygon.length<3||!(area(polygon)>0))return fail('underlay','numeric','Takfallet ger ingen säker våd. Kontrollera måtten.');
   const from=Math.min(...polygon.map(p=>p[0])),to=Math.max(...polygon.map(p=>p[0])),blankLengthMm=mm(to-from);
   const count=Math.max(1,ceil((blankLengthMm-jointAllowanceMm)/(rollMm-jointAllowanceMm)));
   if(!Number.isSafeInteger(count)||pieces.length+count>MAX_PIECES)return fail('underlay','plan-limit','Takmåtten ger för många kapbitar för en säker rullplan. Dela upp arbetet.');
   const id=face.id+':'+(i+1),course={id,index:i+1,fromT:lo,toT:Math.min(hi,t1),fromS:from,toS:to,blankLengthMm,bandAreaM2:area(polygon),pieces:[]};
   for(let j=0;j<count;j++){
    const lengthMm=j<count-1?rollMm:blankLengthMm-(count-1)*(rollMm-jointAllowanceMm),fromMm=j*(rollMm-jointAllowanceMm);
    if(!(lengthMm>0&&lengthMm<=rollMm))return fail('underlay','numeric','Våden ger osäkra kapmått. Kontrollera måtten.');
    const piece={id:id+':'+(j+1),index:j+1,lengthMm,fromMm,toMm:fromMm+lengthMm,allowanceBeforeMm:j?jointAllowanceMm:0};course.pieces.push(piece);pieces.push(piece);
   }
   joints+=count-1;clippedArea+=course.bandAreaM2;courses.push(course);
  }
  courseCount+=n;faces.push({id:face.id,areaM2:face.areaSlope,courses});
 }
 // Best-fit decreasing reuses each physical remainder at most once. Full rolls
 // needed for long courses remain full; no extra seams are added to save stock.
 const rolls=[];
 for(const piece of [...pieces].sort((a,b)=>b.lengthMm-a.lengthMm||a.id.localeCompare(b.id))){
  let chosen=null;for(const r of rolls)if(r.remainderMm>=piece.lengthMm&&(!chosen||r.remainderMm<chosen.remainderMm))chosen=r;
  if(!chosen){chosen={id:'roll-'+(rolls.length+1),reserve:false,cuts:[],remainderMm:rollMm};rolls.push(chosen);}
  const startMm=rollMm-chosen.remainderMm;chosen.cuts.push({id:piece.id,lengthMm:piece.lengthMm,startMm,endMm:startMm+piece.lengthMm});chosen.remainderMm-=piece.lengthMm;piece.rollId=chosen.id;piece.rollStartMm=startMm;
 }
 const baseRolls=rolls.length,reserveRolls=options.reservePct>0?Math.max(1,ceil(baseRolls*options.reservePct/100)):0;
 for(let i=0;i<reserveRolls;i++)rolls.push({id:'roll-'+(rolls.length+1),reserve:true,cuts:[],remainderMm:rollMm});
 const usedLengthM=pieces.reduce((s,p)=>s+p.lengthMm,0)/1000,blankLengthM=faces.reduce((s,f)=>s+f.courses.reduce((n,c)=>n+c.blankLengthMm,0),0)/1000,usedAreaM2=usedLengthM*widthMm/1000,purchasedAreaM2=rolls.length*rollMm*widthMm/1e6;
 const requiredChecks=[{code:'system-choice',message:'Kontrollera att underlaget passar taktäckning, väderläge och träunderlag. YAP2200 är ångtätt; utrymmet bakom ska ventileras.'},{code:'eave-detail',message:'Takfot: särskild fotplåtsremsa och fotplåt mängdas separat. Remsans bredd beror på vald fotplåt.'},{code:'penetrations',message:'Genomföringar, uppvik, stosar, tätningsremsor och klister mängdas separat.'},{code:'fastening',message:'Infästning räknas efter vådernas skarvar, kanter och valt montage. Ingen full spikmängd beräknas här.'}];
 if(g.totals.ridge>0)requiredChecks.push({code:'ridge-detail',message:'Nock: välj ventilerad eller oventilerad lösning. Eventuell nockvåd och dess överlapp ingår inte i takfallens rullar.'});
 if(g.totals.hip>0)requiredChecks.push({code:'hip-detail',message:'Valm: kontrollera anslutningar och extra tätning. Takfallens formkap ingår, valmdetaljer mängdas separat.'});
 if(g.totals.valley>0)requiredChecks.push({code:'valley-detail',message:'Ränndal: underbeslag och särskilda våder före och över beslaget mängdas separat, inklusive150mm överlapp mot takfallen.'});
 if(g.totals.verge>0)requiredChecks.push({code:'verge-detail',message:'Gavel: tillkommande material för trekantlist, uppdragning och nedvik ingår inte i takfallens ytvåder.'});
 if(g.totals.high>0)requiredChecks.push({code:'high-detail',message:'Högsida: välj avslut/anslutning och mängda uppvik och beslag separat.'});
 if(g.input.pitch<18)requiredChecks.push({code:'low-pitch-glue',message:'Under18° läggs våderna tvärs taklutningen och samtliga längs- och tvärskarvar klistras enligt Mataki.'});
 if(joints)requiredChecks.push({code:'diagonal-joint',message:'Tvärskarv:300mm snedskärning och minst150mm kvarvarande överlapp. Kapplanen reserverar450mm omslutande rålängd per skarv; diagonalavkap återanvänds inte.'});
 return {ok:true,version:1,method:'whole-width-face-courses',completePurchasePlan:false,input:g.input,product:{id:'mataki-yap2200',name:'Underlagspapp YAP2200 ·0,67×15m',widthMm,rollMm,sideOverlapMm,endOverlapMm,diagonalTrimMm,jointAllowanceMm},source:{manual:{url:MANUAL,sha256:'169434a3149bed60b1e107ae2f097e74a236049d3105b5cbd55b48bf712d8370',edition:'2026-09-09v3',pages:[1,2,4,6]},product:{url:PRODUCT},jointAllowanceOrigin:'Conservative rectangular-blank inference from300mm diagonal trim plus150mm remaining overlap; not a450mm manufacturer overlap quote'},faces,rolls,totals:{courses:courseCount,pieces:pieces.length,joints,baseRolls,reserveRolls,rolls:rolls.length,faceAreaM2:g.totals.areaSlope,usedLengthM,usedAreaM2,purchasedAreaM2,offcutAreaM2:purchasedAreaM2-usedAreaM2,sideOverlapAreaM2:Math.max(0,clippedArea-g.totals.areaSlope),shapeCutAreaM2:Math.max(0,blankLengthM*widthMm/1000-clippedArea),jointAllowanceLengthM:joints*jointAllowanceMm/1000},requiredChecks};
}
