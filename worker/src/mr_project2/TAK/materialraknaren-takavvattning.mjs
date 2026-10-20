import {roofGeometry} from './materialraknaren-takmodell.mjs';

// Ideal geometric routing only. Actual gutter falls/divides are explicit design
// inputs. No assumption that water goes to the geographically nearest pipe.
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const fail=(field,code,message)=>({ok:false,issues:[{field,code,message}]});
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1];
const area=p=>Math.abs(p.reduce((sum,a,i)=>{const b=p[(i+1)%p.length];return sum+a[0]*b[1]-b[0]*a[1];},0))/2;
const samePoint=(a,b)=>a.every((v,i)=>v===b[i]);

// Clip a 3D planar polygon using a half-plane in its horizontal projection.
// Interpolation retains the source plane, including its height, for the sketch.
function clip(polygon,normal,bound,keepGreater){
  if(!polygon.length)return [];
  const out=[],sign=keepGreater?1:-1;
  for(let i=0;i<polygon.length;i++){
    const a=polygon[i],b=polygon[(i+1)%polygon.length];
    const da=sign*(dot(a,normal)-bound),db=sign*(dot(b,normal)-bound);
    if(da>=0)out.push([...a]);
    if((da<0&&db>0)||(da>0&&db<0)){
      const t=da/(da-db);out.push(a.map((v,j)=>v+t*(b[j]-v)));
    }
  }
  return out;
}
function strip(polygon,axis,low,high){return clip(clip(polygon,axis,low,true),axis,high,false);}
const axisFor=edge=>[(edge.to[0]-edge.from[0])/edge.length,(edge.to[1]-edge.from[1])/edge.length];

/** Same TM1 roof, real face catchments and explicit gutter/outlet routing. */
export function roofDrainage(roofInput,options={}){
  const geometry=roofGeometry(roofInput);if(!geometry.ok)return geometry;
  if(!object(options))return fail('drainage','input','Ange rännor och stuprörslägen.');
  const entries=options.gutters===undefined?[]:options.gutters,routes=options.valleyRoutes===undefined?[]:options.valleyRoutes;
  if(!Array.isArray(entries)||entries.length>100||!Array.isArray(routes)||routes.length>100)return fail('drainage','input','Ange rännor och ränndalens mottagare som listor.');
  const edges=new Map(geometry.edges.map(e=>[e.id,e]));
  const eaves=geometry.edges.filter(e=>e.type==='eave');
  const valleys=geometry.edges.filter(e=>e.type==='valley').map(e=>({edgeId:e.id,point:[...(e.from[2]<e.to[2]?e.from:e.to)],areaPlan:0,areaSlope:0,receiverEdgeId:null}));
  const gutters=eaves.map(e=>({edgeId:e.id,length:e.length,from:[...e.from],to:[...e.to],directAreaPlan:0,directAreaSlope:0,pointAreaPlan:0,pointAreaSlope:0,outlets:[],catchments:[]}));
  const byGutter=new Map(gutters.map(g=>[g.edgeId,g]));
  const byValley=new Map(valleys.map(v=>[v.edgeId,v]));
  const slopeFactor=1/Math.cos(geometry.input.pitch*Math.PI/180);
  const catchments=[];
  for(const face of geometry.faces){
    const across=[-face.fallDirection[1],face.fallDirection[0]];
    for(const edgeId of face.outletEdgeIds){
      const edge=edges.get(edgeId),bounds=[dot(edge.from,across),dot(edge.to,across)].sort((a,b)=>a-b);
      const polygon=strip(face.polygon,across,bounds[0],bounds[1]);
      const areaPlan=area(polygon),areaSlope=areaPlan*slopeFactor;
      if(!(areaPlan>0))continue;
      const cell={faceId:face.id,edgeId,type:edge.type,polygon,areaPlan,areaSlope};catchments.push(cell);
      if(edge.type==='valley'){const v=byValley.get(edgeId);v.areaPlan+=areaPlan;v.areaSlope+=areaSlope;}
      else{const g=byGutter.get(edgeId);g.directAreaPlan+=areaPlan;g.directAreaSlope+=areaSlope;g.catchments.push(cell);}
    }
  }
  const assignedValleys=new Set();
  for(const route of routes){
    if(!object(route)||typeof route.edgeId!=='string'||!byValley.has(route.edgeId)||assignedValleys.has(route.edgeId))return fail('valleyRoutes','valley','Välj varje ränndal högst en gång.');
    const v=byValley.get(route.edgeId),g=byGutter.get(route.receiverEdgeId);
    if(!g||!samePoint(v.point,g.from)&&!samePoint(v.point,g.to))return fail('valleyRoutes','receiver','Ränndalen måste ledas till en angiven takfot vid dalens nedre hörn.');
    assignedValleys.add(v.edgeId);v.receiverEdgeId=g.edgeId;
    g.pointAreaPlan+=v.areaPlan;g.pointAreaSlope+=v.areaSlope;
  }
  const seenGutters=new Set(),seenPipes=new Set();
  for(const entry of entries){
    if(!object(entry)||typeof entry.edgeId!=='string'||!byGutter.has(entry.edgeId)||seenGutters.has(entry.edgeId))return fail('gutters','edge','Ange varje verklig takfot högst en gång.');
    seenGutters.add(entry.edgeId);
    const g=byGutter.get(entry.edgeId),pipes=entry.outlets;
    if(!Array.isArray(pipes)||pipes.length<1||pipes.length>100)return fail('outlets','outlets','Ange minst ett stuprör på den valda takfoten.');
    const sorted=[];
    for(const p of pipes){
      if(!object(p)||typeof p.id!=='string'||!p.id.trim()||p.id.length>100||seenPipes.has(p.id))return fail('outlets','id','Varje stuprör behöver ett unikt namn.');
      if(!finite(p.at)||p.at<0||p.at>g.length)return fail('outlets','position','Stuprörets läge ska ligga längs den valda takfoten.');
      seenPipes.add(p.id);sorted.push({id:p.id,at:p.at});
    }
    sorted.sort((a,b)=>a.at-b.at);
    if(sorted.some((p,i)=>i>0&&p.at===sorted[i-1].at))return fail('outlets','position','Två stuprör kan inte ha samma läge på samma takfot.');
    const divides=entry.divides===undefined?[]:entry.divides;
    if(!Array.isArray(divides)||divides.length!==sorted.length-1||divides.some((d,i)=>!finite(d)||!(d>sorted[i].at&&d<sorted[i+1].at)))return fail('divides','divides','Ange en planerad rännhögpunkt mellan varje par av stuprör. Lägena avgör vilken del som rinner till respektive rör.');
    const axis=axisFor(edges.get(g.edgeId)),origin=dot(g.from,axis),boundaries=[0,...divides,g.length];
    g.divides=[...divides];
    g.outlets=sorted.map((p,i)=>{
      const start=boundaries[i],end=boundaries[i+1];let areaPlan=0;
      const cells=g.catchments.map(c=>{
        const polygon=strip(c.polygon,axis,origin+start,origin+end),part=area(polygon);areaPlan+=part;
        return {faceId:c.faceId,polygon,areaPlan:part,areaSlope:part*slopeFactor};
      }).filter(c=>c.areaPlan>0);
      const pointInflows=[];
      for(const v of valleys.filter(v=>v.receiverEdgeId===g.edgeId)){
        // Valleys currently reach an eave ENDPOINT. Interior divide allocation
        // would need an explicit specialist split, never an implicit half.
        const at=dot(v.point,axis)-origin;
        if(at>=start&&at<=end){areaPlan+=v.areaPlan;pointInflows.push({edgeId:v.edgeId,at,areaPlan:v.areaPlan,areaSlope:v.areaSlope});}
      }
      return {...p,start,end,areaPlan,areaSlope:areaPlan*slopeFactor,maxGutterRun:Math.max(p.at-start,end-p.at),cells,pointInflows};
    });
  }
  let assignedAreaPlan=0,unassignedAreaPlan=0;
  for(const g of gutters){
    g.areaPlan=g.directAreaPlan+g.pointAreaPlan;g.areaSlope=g.areaPlan*slopeFactor;
    if(g.outlets.length)assignedAreaPlan+=g.outlets.reduce((s,p)=>s+p.areaPlan,0);
    else unassignedAreaPlan+=g.areaPlan;
  }
  for(const v of valleys)if(v.receiverEdgeId===null)unassignedAreaPlan+=v.areaPlan;
  const totalPlan=assignedAreaPlan+unassignedAreaPlan;
  if(!Number.isFinite(totalPlan)||Math.abs(totalPlan-geometry.totals.areaPlan)>1e-8*Math.max(1,geometry.totals.areaPlan))return fail('drainage','conservation','Takets vatten kunde inte fördelas säkert. Kontrollera modellen och rännornas indelning.');
  const requiredChecks=[{code:'gutter-falls',message:'Högpunkter och fall till varje stuprör är planerade lägen. Kontrollera utförandet på byggnaden.'},{code:'system-design',message:'Kontrollera vald tillverkares ränna, tappstycke, hörn, fall, expansion och bortledning. Geometrin är ingen hydraulisk dimensionering eller komplett inköpslista.'}];
  if(valleys.length)requiredChecks.push({code:'valley-point-inflow',message:'Ränndalen ger ett koncentrerat inflöde vid innerhörnet. Kontrollera mottagande ränna, hörn och utlopp särskilt; en rakrännetabell verifierar inte detta.'});
  if(geometry.input.form==='hip')requiredChecks.push({code:'hip-gutter-network',message:'Valmtakets hörn och sammanhängande rännor måste planeras. Här räknas varje rak takfot separat, utan antagen passage runt hörn.'});
  return {ok:true,version:1,geometry,catchments,valleys,gutters,assignedAreaPlan,assignedAreaSlope:assignedAreaPlan*slopeFactor,unassignedAreaPlan,unassignedAreaSlope:unassignedAreaPlan*slopeFactor,routingComplete:unassignedAreaPlan===0,completeSystemDesign:false,requiredChecks};
}

const PLASTMO='https://www.plastmo.se/tekniska-fakta/hangrannor';
const PLANNJA='https://www.plannja.se/docs/default-source/documents-se/montering-uppdelade-2020/se-plannja-montering-takavvattning-2026-2.pdf?sfvrsn=31639255862089770000';
const PLASTMO_LIMITS={A:{gutter:[128,200,295],pipe:[180,289,530]},B:{gutter:[85,128,195],pipe:[150,235,408]},C:{gutter:[64,95,148],pipe:[126,200,365]}};

/** Literal manufacturer table comparison. Does not infer a hydraulic design. */
export function drainageTable(input){
  if(!object(input))return fail('system','input','Välj avvattningssystem och dimensioner.');
  if(!finite(input.areaSlope)||input.areaSlope<0)return fail('areaSlope','area','Ange verklig avvattningsyta i m².');
  const profiles=['plastmo-plastic','plannja-2026'];
  if(typeof input.profile!=='string'||!profiles.includes(input.profile))return fail('profile','profile','Välj ett källkontrollerat system. Ingen neutral kapacitetstabell används.');
  if(!finite(input.gutter)||!finite(input.pipe))return fail('size','size','Välj rännans och stuprörets verkliga dimensioner.');
  let gutterLimit,pipeLimit,source,compatibilityVerified=false;
  if(input.profile==='plannja-2026'){
    const gi=[100,125,150,190].indexOf(input.gutter),pi=[75,90,100,110,120].indexOf(input.pipe);
    if(gi<0||pi<0)return fail('size','size','Dimensionen finns inte i den lästa Plannja-tabellen.');
    gutterLimit=[75,125,200,250][gi];pipeLimit=[80,125,180,230,300][pi];
    source={url:PLANNJA,sha256:'135e41fb1f792e1e650b2ef03e02bf3b8b95acd7a468d4e39a06fd2085fb81b1',pdfPages:[9,10],printedPages:[10,11]};
  }else{
    if(typeof input.placement!=='string'||!['A','B','C'].includes(input.placement))return fail('placement','placement','Välj källa A, B eller C efter tillverkarens bild. B saknar ett numeriskt angivet läge.');
    const gi=[100,125,150].indexOf(input.gutter),pi=[75,90,110].indexOf(input.pipe);
    if(gi<0||pi<0||input.gutter===100&&input.pipe===110)return fail('size','compatibility','Dimensionerna kan inte kombineras enligt den lästa Plastmo-bilden.');
    const row=PLASTMO_LIMITS[input.placement];gutterLimit=row.gutter[gi];pipeLimit=row.pipe[pi];compatibilityVerified=true;
    source={url:PLASTMO,capacityImageSha256:'62962b3854ece1fac5fcb1bc3d281de53a7ec928e64484e1723b00d2acefa7e1',compatibilityImageSha256:'66ad77e0bdc7ac7f2996b3939866917974bdc8d842b1a06257ad0c7e639bebc9',gutterClass:[10,11,12][gi],nominalMapping:'official-product-filter',mappingVerified:true};
  }
  return {ok:true,profile:input.profile,gutter:input.gutter,pipe:input.pipe,placement:input.placement??null,areaBasis:'sloped',areaSlope:input.areaSlope,gutterLimit,pipeLimit,withinTable:input.areaSlope<=gutterLimit&&input.areaSlope<=pipeLimit,compatibilityVerified,quality:'table-comparison-only',completeSystemDesign:false,source,requiredChecks:['Tabelljämförelsen förutsätter tillverkarens aktuella system och rätt tillämpning av utloppets placering.','Punktinflöde från ränndal, hörn och flera rör kräver separat kontroll. Tabellen får inte multipliceras utan en underbyggd rännindelning.']};
}
