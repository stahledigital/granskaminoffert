import {isRoofJson} from './materialraknaren-json-contract.mjs';
import {roofGeometry} from './materialraknaren-takmodell.mjs';
import {packSupportedBattenPlan,unpackSupportedBattenPlan} from './materialraknaren-takplan-tabell.mjs';
import {validateSavedRoofStock} from './materialraknaren-takplan-lagerkontroll.mjs';

// Saved-result reader: compare existing relations; never call a measurement,
// course, support/fixing producer or stock allocator and never repair a plan.
const EPS=1e-7,object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,n)=>object(v)&&Object.keys(v).length===n.length&&n.every(k=>Object.hasOwn(v,k));
const near=(a,b)=>typeof a==='number'&&typeof b==='number'&&Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=EPS;
const precise=v=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)*Number.EPSILON*32<=EPS;
const text=v=>typeof v==='string'&&v.trim()===v&&v.length>0&&v.length<=240;
const inside=(v,a,b)=>v>=a-EPS&&v<=b+EPS;
const must=(v,c='saved-plan')=>{if(!v)throw Error(c);};
const stable=v=>JSON.stringify(v,(_k,x)=>object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x),same=(a,b)=>stable(a)===stable(b);
const dot=(a,b)=>a.reduce((n,v,i)=>n+v*b[i],0),sub=(a,b)=>a.map((v,i)=>v-b[i]);
const vector=(a,b)=>Array.isArray(a)&&a.length===b.length&&a.every((v,i)=>near(v,b[i]));
const section=(s,t,w)=>exact(s,['thicknessMm','widthMm'])&&precise(s.thicknessMm)&&precise(s.widthMm)&&Math.abs(s.thicknessMm-t)<=2&&Math.abs(s.widthMm-w)<=2;
const source={benders:{url:'https://www.benders.se/globalassets/c4-assets/document/Monteringsanvisning-BETONG-1o2kupig--2023-07-LU-2.pdf',sha256:'cf26e03f9f967478410f943011019e2caa7cbfbb04bf6d35d0ddff2a41d1ea11',pages:[4,5,6]},carisma:{url:'https://www.benders.se/globalassets/c4-assets/document/Carisma-Laggning-2024-LU.pdf',sha256:'40f9ffde1a5e678b0ee2e4d95e0c2140120321e27098b63c6d3e4cc2e096cd01',pages:[4]},handbook:{url:'https://www.svenskttra.se/siteassets/5-publikationer/pdfer/st-lathunden-2021-med-utvik.pdf',sha256:'3a837fd02ad5c961ed87872dbd762976eb1c0310ac8c48d039e5bc6e23e7304c',pages:[92]}};
function reserve(n,p){if(n===null)return null;const [m,e='0']=String(p).split('e'),[w,f='']=m.split('.'),s=f.length-Number(e);let a=BigInt(w+f)*BigInt(n),b=100n;if(s>=0)b*=10n**BigInt(s);else a*=10n**BigInt(-s);return n+Number((a+b-1n)/b);}
function contains(poly,p){
 let within=false;
 for(let i=0,j=poly.length-1;i<poly.length;j=i++){
  const a=poly[j],b=poly[i],dx=b[0]-a[0],dy=b[1]-a[1],px=p[0]-a[0],py=p[1]-a[1];
  if(Math.abs(dx*py-dy*px)<=EPS*Math.max(1,Math.hypot(dx,dy))&&(p[0]-a[0])*(p[0]-b[0])+(p[1]-a[1])*(p[1]-b[1])<=EPS*EPS)return true;
  if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])within=!within;
 }
 return within;
}
function spanAt(poly,y){
 const xs=[];
 for(let i=0;i<poly.length;i++){
  const a=poly[i],b=poly[(i+1)%poly.length];
  if(near(a[1],y))xs.push(a[0]);if(near(b[1],y))xs.push(b[0]);
  if(y>Math.min(a[1],b[1])&&y<Math.max(a[1],b[1]))xs.push(a[0]+(y-a[1])/(b[1]-a[1])*(b[0]-a[0]));
 }
 must(xs.length>=2,'saved-band');return [Math.min(...xs),Math.max(...xs)];
}
function frameCheck(p,g,faceId){
 const f=p.frame,m=p.specification.measurement,face=g.faces.find(x=>x.id===faceId);must(face&&f.faceId===faceId&&m.faceId===faceId,'saved-face');
 must(same(f.geometryInput,g.input)&&f.geometryVersion===g.version&&f.units.world==='m'&&f.units.working==='mm','saved-geometry');
 must(Array.isArray(m.origin)&&vector(f.origin,m.origin)&&[f.origin,...face.polygon].every(v=>v.every(x=>precise(x*1000))),'saved-precision');
 const angle=g.input.pitch*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),[dx,dy]=face.fallDirection,across=[-dy,dx,0],up=[-dx*c,-dy*c,s],normal=[dx*s,dy*s,c];
 must(vector(f.across,across)&&vector(f.up,up)&&Math.abs(dot(sub(f.origin,face.polygon[0]),normal))*1000<=EPS,'saved-frame');
 must(f.polygonMm.length===face.polygon.length&&f.polygonMm.every((v,i)=>{const d=sub(face.polygon[i],f.origin);return v.every(precise)&&vector(v,[dot(d,across)*1000,dot(d,up)*1000])}),'saved-polygon');
 must(contains(f.polygonMm,[0,0]),'saved-origin');let sign=0;
 for(let i=0;i<f.polygonMm.length;i++){const a=sub(f.polygonMm[(i+1)%f.polygonMm.length],f.polygonMm[i]),b=sub(f.polygonMm[(i+2)%f.polygonMm.length],f.polygonMm[(i+1)%f.polygonMm.length]),turn=a[0]*b[1]-a[1]*b[0];if(Math.abs(turn)>EPS){must(!sign||sign===Math.sign(turn),'saved-convex');sign=Math.sign(turn);}}
}
function readFace(raw,g){
 const {profile,faceId}=raw;
 must(['palema','exklusiv','carisma'].includes(profile),'saved-profile');
 const packed=packSupportedBattenPlan(raw.plan);must(packed.ok,'saved-tables');const decoded=unpackSupportedBattenPlan(packed.packet);must(decoded.ok,'saved-tables');const p=decoded.plan,spec=p.specification,m=spec.measurement;
 must(m.profile===profile&&exact(m,['faceId','origin','profile','firstTopMm','lastTopMm','section','confirmed'])&&exact(m.confirmed,['reference','fit','openingsAbsent'])&&Object.values(m.confirmed).every(v=>v===true),'saved-measurement');
 frameCheck(p,g,faceId);
 const light=p.assembly!=='boarded',counter=p.assembly!=='light-hanging',minPitch=profile==='carisma'?18:14,maxGauge=profile==='carisma'?(g.input.pitch<22?325:350):(g.input.pitch<18?320:g.input.pitch<22?340:375);
 must(g.input.pitch>=minPitch&&g.input.pitch<90&&!(profile==='carisma'&&light),'saved-method');
 must(typeof spec.planedTimber==='boolean'&&(!light||spec.planedTimber)&&section(m.section,light?45:25,light?70:48),'saved-section');
 must(exact(spec.underlay,['approvedForPurpose','reference','sku'])&&spec.underlay.approvedForPurpose===true&&text(spec.underlay.reference)&&(spec.underlay.sku===null||text(spec.underlay.sku)),'saved-underlay');
 must(exact(spec.endDetail,['maxCantileverMm','reference'])&&precise(spec.endDetail.maxCantileverMm)&&spec.endDetail.maxCantileverMm>=0&&text(spec.endDetail.reference),'saved-end-detail');
 must(same(p.source.covering,profile==='carisma'?source.carisma:source.benders)&&same(p.source.normalFixing,p.assembly==='light-stretched'?null:source.handbook),'saved-source');
 const cs=p.courses,first=m.firstTopMm,last=m.lastTopMm,n=cs.intervals,span=last-first;
 must([first,last,first-m.section.widthMm].every(precise)&&span>0&&span<=100000&&Number.isSafeInteger(n)&&n>=1&&cs.positionsMm.length===n+1,'saved-courses');
 must(near(cs.gaugeMm,span/n)&&cs.gaugeMm>=310-EPS&&cs.gaugeMm<=maxGauge+EPS&&(n===1||span/(n-1)>maxGauge-EPS),'saved-gauge');
 must(cs.positionsMm.every((v,i)=>precise(v)&&near(v,i===n?last:first+i*span/n)),'saved-course-position');
 const supports=spec.supports,bySupport=new Map(supports.map(x=>[x.id,x])),ordered=[...supports].sort((a,b)=>a.axisMm-b.axisMm),kind={boarded:'counter','light-hanging':'rafter','light-stretched':'rafter-with-counter'}[p.assembly];
 must(supports.length>=1&&supports.length<=2000,'saved-support');
 for(const s of ordered)must(s.kind===kind&&[s.axisMm,s.fromMm,s.toMm,...s.bearingMm].every(precise)&&s.toMm>s.fromMm&&s.bearingMm[1]>s.bearingMm[0]&&inside(s.axisMm,...s.bearingMm)&&text(s.reference),'saved-support');
 must(ordered.every((s,i)=>!i||s.axisMm-ordered[i-1].axisMm>EPS&&s.axisMm-ordered[i-1].axisMm<=(light?1200:600)+EPS),'saved-support-spacing');
 if(profile==='carisma'){
  const a=spec.rafterAxesMm;must(Array.isArray(a)&&a.length>=2&&a.every((x,i)=>precise(x)&&(!i||x>a[i-1])),'saved-rafters');
  must([...a,...a.slice(1).map((x,i)=>(x+a[i])/2)].every(x=>ordered.some(s=>near(s.axisMm,x))),'saved-rafters');
 }else must(spec.rafterAxesMm===null,'saved-rafters');
 const normal=p.members.filter(x=>x.role==='normal-batten'),counters=p.members.filter(x=>x.role==='counter-batten'),used=new Set();
 must(counter?counters.length===supports.length:counters.length===0,'saved-counters');
 must(new Set(normal.map(a=>a.familyId)).size===1&&(!counter||new Set(counters.map(a=>a.familyId)).size===1&&counters.every(a=>same(a.section,counters[0].section))),'saved-role-material');
 const counterSections=new Map();
 for(const a of counters){
  must(a.supportIds.length===1,'saved-counter');const s=bySupport.get(a.supportIds[0]);must(s&&a.id==='counter:'+s.id&&!counterSections.has(s.id)&&section(a.section,25,48),'saved-counter');counterSections.set(s.id,a.section);
  must(near(a.fromMm,s.axisMm)&&near(a.toMm,s.axisMm)&&near(a.fromT,s.fromMm)&&near(a.toT,s.toMm)&&near(a.netLengthMm,s.toMm-s.fromMm),'saved-counter-length');
  must(near(s.bearingMm[0],s.axisMm-a.section.widthMm/2)&&near(s.bearingMm[1],s.axisMm+a.section.widthMm/2),'saved-counter-bearing');
  must([s.bearingMm[0],s.bearingMm[1]].every(x=>[s.fromMm,s.toMm].every(y=>contains(p.frame.polygonMm,[x,y]))),'saved-counter-footprint');
 }
 const jointsByRow=new Map();
 for(const j of spec.joints){
  const s=bySupport.get(j.supportId),top=cs.positionsMm[j.rowIndex-1];must(s&&Number.isSafeInteger(j.rowIndex)&&j.rowIndex>=1&&j.rowIndex<=cs.positionsMm.length&&precise(j.atMm)&&text(j.reference),'saved-joint');
  must(j.atMm>s.bearingMm[0]+EPS&&j.atMm<s.bearingMm[1]-EPS&&s.fromMm<=top-m.section.widthMm+EPS&&s.toMm>=top-EPS,'saved-joint-bearing');
  const js=jointsByRow.get(j.rowIndex)||[];must(!js.some(x=>near(x.atMm,j.atMm)),'saved-joint');js.push(j);jointsByRow.set(j.rowIndex,js);
 }
 for(const [i,top]of cs.positionsMm.entries()){
  const bottom=top-m.section.widthMm,low=spanAt(p.frame.polygonMm,bottom),high=spanAt(p.frame.polygonMm,top);must(vector(low,high)&&high[1]-high[0]>EPS,'saved-band');
  must(p.frame.polygonMm.every(([x,y])=>!inside(y,bottom,top)||near(x,high[0])||near(x,high[1])),'saved-square-end');
  const ms=normal.filter(a=>a.rowIndex===i+1).sort((a,b)=>a.fromMm-b.fromMm),js=(jointsByRow.get(i+1)||[]).slice().sort((a,b)=>a.atMm-b.atMm);must(ms.length===js.length+1,'saved-full-course');let cursor=high[0];
  for(const [k,a]of ms.entries()){
   const end=k<js.length?js[k].atMm:high[1];must(a.id===`${faceId}:bar:${i+1}:${k+1}`&&same(a.section,m.section)&&near(a.fromMm,cursor)&&near(a.toMm,end)&&a.toMm>a.fromMm&&near(a.fromT,bottom)&&near(a.toT,top)&&near(a.netLengthMm,a.toMm-a.fromMm),'saved-member');
   const carrying=ordered.filter(s=>Math.min(a.toMm,s.bearingMm[1])-Math.max(a.fromMm,s.bearingMm[0])>EPS&&s.fromMm<=bottom+EPS&&s.toMm>=top-EPS);must(carrying.length>=(light?3:1)&&same(a.supportIds,carrying.map(s=>s.id)),'saved-bearing');carrying.forEach(s=>used.add(s.id));
   must(Math.max(0,carrying[0].bearingMm[0]-a.fromMm,a.toMm-carrying.at(-1).bearingMm[1])<=spec.endDetail.maxCantileverMm+EPS,'saved-cantilever');cursor=a.toMm;
  }
  must(near(cursor,high[1]),'saved-full-course');
 }
 must(normal.every(a=>a.rowIndex<=cs.positionsMm.length)&&used.size===supports.length,'saved-full-course');
 must(validateSavedRoofStock(p.stock.ledger).ok,'saved-stock');
 const supply=spec.fixingSupply;must(exact(supply,['sku','packSize','reservePct','projectReference'])&&(supply.sku===null||text(supply.sku))&&(supply.packSize===null||Number.isSafeInteger(supply.packSize)&&supply.packSize>0&&supply.packSize<=1000000)&&typeof supply.reservePct==='number'&&supply.reservePct>=0&&supply.reservePct<=100&&(supply.projectReference===null||text(supply.projectReference)),'saved-fixing-supply');
 const qty=p.assembly==='boarded'?1:p.assembly==='light-hanging'?2:null,fn=p.fixing.normal,points=[],ids=new Set(),byMember=new Map(p.members.map(x=>[x.id,x]));
 must(fn.dimension===(qty===1?'2,8 × 75 mm':qty===2?'3,4 × 100 mm':null)&&fn.corrosion===(qty===null?null:'varmförzinkad trådspik')&&fn.authority===(qty===null?'own-project':'industry-handbook')&&fn.sku===supply.sku,'saved-fixing-source');
 function addPoint(point){must(Array.isArray(point)&&point.length===2&&point.every(precise)&&!points.some(x=>vector(x,point)),'saved-fixing-point');points.push(point);}
 for(const c of p.connections){
  const a=byMember.get(c.memberId),s=bySupport.get(c.supportId);must(c.id===`${a.id}:on:${s.id}`,'saved-connection');
  if(fn.layoutComplete){must(!ids.has(c.fixingId)&&text(c.fixingId)&&c.pointsMm.length>0&&c.pointsMm.length<=20&&(qty===null||c.pointsMm.length===qty),'saved-fixing-count');ids.add(c.fixingId);
   for(const point of c.pointsMm){must(inside(point[0],a.fromMm,a.toMm)&&inside(point[1],a.fromT,a.toT)&&inside(point[0],...s.bearingMm)&&inside(point[1],s.fromMm,s.toMm),'saved-fixing-position');addPoint(point);}
  }
 }
 must(!(qty===null&&fn.layoutComplete&&supply.projectReference===null),'saved-fixing-detail');
 const count=qty===null?(fn.layoutComplete?points.length:null):p.connections.length*qty,withReserve=reserve(count,supply.reservePct);must(fn.netCount===count&&fn.withReserve===withReserve&&fn.packCount===(supply.packSize===null||withReserve===null?null:Math.ceil(withReserve/supply.packSize)),'saved-fixing-total');
 const groups=new Map(),ft=p.fixing.temporary;
 for(const a of ft.nodes){
  const s=bySupport.get(a.supportId);must(counter&&s&&a.quantity===1&&!ids.has(a.id)&&text(a.id)&&text(a.reference)&&(a.sku===null||text(a.sku))&&inside(a.pointMm[0],...s.bearingMm)&&inside(a.pointMm[1],s.fromMm,s.toMm),'saved-temporary');ids.add(a.id);addPoint(a.pointMm);
  const key=JSON.stringify([a.sku,a.reference]);groups.set(key,(groups.get(key)||0)+1);
 }
 must(ft.netCount===ft.nodes.length&&ft.groups.length===groups.size,'saved-temporary-total');let total=0;
 for(const a of ft.groups){const key=JSON.stringify([a.sku,a.reference]),n=groups.get(key);must(n!==undefined&&a.netCount===n&&a.withReserve===reserve(n,supply.reservePct),'saved-temporary-total');groups.delete(key);total+=a.withReserve;}
 must(ft.withReserve===total,'saved-temporary-total');
 const expected=['capacity','own-end-joint-detail','other-roof-roles',...(!fn.layoutComplete?['fixing-layout']:[]),...(p.assembly==='light-stretched'?['stack-fixing']:[]),...(profile==='carisma'?['windboard-reference']:[])];
 must(p.completePurchasePlan===false&&same(p.requiredChecks.map(c=>c.code),expected)&&same(p.stock.requiredChecks.map(c=>c.code),['physical-members-required','availability-and-packs']),'saved-coverage');
 return p;
}
const failure=e=>({ok:false,issues:[{field:'physicalPlan',code:e instanceof Error?e.message:'saved-plan',message:'Takplanens sparade mått, stöd eller materialbalans kunde inte verifieras. Tidigare underlag finns kvar utan att räknas om.'}]});
export function readSavedBattenFace(raw){
 try{must(isRoofJson(raw)&&exact(raw,['input','profile','faceId','plan']),'saved-input');const g=roofGeometry(raw.input);must(g.ok,'saved-geometry');return {ok:true,plan:readFace(raw,g)};}catch(e){return failure(e);}
}
export function readSavedBattenRoof(raw){
 try{
  must(isRoofJson(raw)&&exact(raw,['input','profile','faces'])&&Array.isArray(raw.faces),'saved-input');const g=roofGeometry(raw.input);must(g.ok&&raw.faces.length===g.faces.length,'saved-full-roof');const ids=new Set();
  const faces=raw.faces.map(f=>{must(exact(f,['faceId','plan'])&&!ids.has(f.faceId),'saved-full-roof');ids.add(f.faceId);return {faceId:f.faceId,plan:readFace({input:raw.input,profile:raw.profile,faceId:f.faceId,plan:f.plan},g)};});
  must(g.faces.every(f=>ids.has(f.id)),'saved-full-roof');return {ok:true,faces,completePurchasePlan:false};
 }catch(e){return failure(e);}
}
