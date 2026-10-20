/**
 * TM1: one geometric roof, independent of UI, materials and drainage systems.
 * Lengths: metres, areas: m², pitch: degrees. No rounding before consumers format.
 * This is geometry, not structural design, a purchasing plan or hydraulic capacity.
 */
export function roofGeometry(raw) {
  const issues=[];
  const issue=(field,code,message)=>issues.push({field,code,message});
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return {ok:false,issues:[{field:'model',code:'input',message:'Ange takets mått och form.'}]};
  const input={plan:raw.plan,form:raw.form,length:raw.length,width:raw.width,extension:raw.extension===undefined?0:raw.extension,pitch:raw.pitch,eaveOverhang:raw.eaveOverhang===undefined?0:raw.eaveOverhang,gableOverhang:raw.gableOverhang===undefined?0:raw.gableOverhang};
  if(!['rectangle','L'].includes(input.plan))issue('plan','unsupported','Planformen stöds inte.');
  if(!['gable','mono','hip'].includes(input.form))issue('form','unsupported','Takformen stöds inte.');
  for(const field of ['length','width','extension','pitch','eaveOverhang','gableOverhang']){
    const v=input[field];
    if(typeof v!=='number'||!Number.isFinite(v)){issue(field,'number','Ange ett ändligt tal.');continue;}
    if(field==='pitch'){if(!(v>0&&v<90))issue(field,'range','Taklutningen ska vara större än 0 och mindre än 90 grader.');}
    else if(v<(['length','width'].includes(field)?.01:0)||v>1000)issue(field,'range','Måttet ligger utanför modellens område: byggmått minst 0,01 m och alla mått högst 1 000 m.');
  }
  if(issues.length)return {ok:false,issues};
  if(input.plan==='L'&&input.form!=='gable')issue('form','unsupported','L-plan stöds här med två lika breda delar, två gavlar, ett valmhörn och en ränndal. Andra L-tak stöds inte än.');
  if(input.form==='hip'&&input.gableOverhang!==0)issue('gableOverhang','not-applicable','Valmat tak har inga gavlar. Ange endast takfotsutsprång.');
  if(input.plan==='rectangle'&&input.extension!==0)issue('extension','not-applicable','En rektangulär plan har ingen flygel.');
  const e=input.eaveOverhang,g=input.gableOverhang;
  const L=input.length+(input.form==='hip'?2*e:input.plan==='L'?g+e:2*g);
  const W=input.width+2*e;
  const E=input.extension+g-e;
  if(input.plan==='L'){
    // Subtractions near the 1 cm boundary need only floating-point tolerance,
    // not geometric clamping (input and coordinates remain unchanged).
    const belowMinimum=v=>v<.01&&.01-v>32*Number.EPSILON*Math.max(1,L,W,E);
    // Both the building footprint and its offset roof must retain a real notch.
    if(belowMinimum(input.length-input.width)||belowMinimum(L-W))issue('length','topology','L-husets huvuddel måste vara minst 0,01 m längre än bredden, även efter utsprång.');
    if(belowMinimum(input.extension)||belowMinimum(E))issue('extension','topology','Flygelns utstick måste vara minst 0,01 m, även efter utsprång.');
  }
  if(issues.length)return {ok:false,issues};
  const angle=input.pitch*Math.PI/180,cos=Math.cos(angle),tan=Math.tan(angle);
  const half=input.form==='mono'?W:Math.min(W,input.form==='hip'?L:W)/2;
  const height=half*tan;
  if(!(tan>0&&height>0))return {ok:false,issues:[{field:'pitch',code:'numeric',message:'Lutningen är för liten för att ge säker geometri i modellen.'}]};
  const faces=[];
  // Every face is planar, with the same specified slope. Its horizontal fall vector
  // identifies all geometric outgoing edges; valley routing remains a TM3 concern.
  function face(id,polygon,fallDirection){
    polygon=polygon.filter((p,i)=>!same(p,polygon[(i+polygon.length-1)%polygon.length]));
    if(signedArea(polygon)<0)polygon.reverse();
    const areaPlan=Math.abs(signedArea(polygon));
    faces.push({id,polygon,areaPlan,areaSlope:areaPlan/cos,fallDirection,edgeIds:[],outletEdgeIds:[]});
  }
  let footprint,valleyKey=null;
  const p=(x,y,z=0)=>[x,y,z];
  if(input.plan==='L'){
    const c=p(L-W/2,W/2,height),a=p(0,0),b=p(L,0),d=p(L,W+E),f=p(L-W,W+E),n=p(L-W,W),v=p(0,W),r=p(0,W/2,height),s=p(L-W/2,W+E,height);
    footprint=[a,b,d,f,n,v];
    face('main-south',[a,b,c,r],[0,-1]);
    face('main-north',[r,c,n,v],[0,1]);
    face('wing-east',[b,d,s,c],[1,0]);
    face('wing-west',[n,c,s,f],[-1,0]);
    valleyKey=key(n,c);
  }else if(input.form==='gable'){
    const a=p(0,0),b=p(L,0),c=p(L,W),d=p(0,W),r=p(0,W/2,height),s=p(L,W/2,height);
    footprint=[a,b,c,d];face('south',[a,b,s,r],[0,-1]);face('north',[r,s,c,d],[0,1]);
  }else if(input.form==='mono'){
    const a=p(0,0),b=p(L,0),c=p(L,W,height),d=p(0,W,height);
    footprint=[a,b,p(L,W),p(0,W)];face('mono',[a,b,c,d],[0,-1]);
  }else{
    // Construct along the longer axis; rotate back without changing physical input.
    const swap=W>L,A=Math.max(L,W),B=Math.min(L,W),h=B/2*tan;
    const point=(x,y,z=0)=>swap?p(y,x,z):p(x,y,z);
    const a=point(0,0),b=point(A,0),c=point(A,B),d=point(0,B),r=point(B/2,B/2,h),s=point(A-B/2,B/2,h);
    const direction=(x,y)=>swap?[y,x]:[x,y];
    footprint=swap?[a,d,c,b]:[a,b,c,d];
    face('side-1',[a,b,s,r],direction(0,-1));face('side-2',[s,c,d,r],direction(0,1));
    face('end-1',[d,a,r],direction(-1,0));face('end-2',[b,c,s],direction(1,0));
  }
  const byKey=new Map(),edges=[];
  for(const f of faces)for(let i=0;i<f.polygon.length;i++){
    const from=f.polygon[i],to=f.polygon[(i+1)%f.polygon.length],k=key(from,to);
    let edge=byKey.get(k);
    if(!edge){edge={id:`edge-${edges.length+1}`,type:'',from:[...from],to:[...to],length:Math.hypot(...to.map((n,j)=>n-from[j])),faces:[]};byKey.set(k,edge);edges.push(edge);}
    edge.faces.push(f.id);f.edgeIds.push(edge.id);
  }
  for(const [k,edge] of byKey){
    const a=edge.from,b=edge.to;
    edge.type=edge.faces.length===2?(k===valleyKey?'valley':a[2]===b[2]?'ridge':'hip'):
      a[2]===0&&b[2]===0?'eave':a[2]===b[2]?'high':'verge';
  }
  for(const f of faces)for(let i=0;i<f.polygon.length;i++){
    const edge=edges.find(e=>e.id===f.edgeIds[i]),a=f.polygon[i],b=f.polygon[(i+1)%f.polygon.length];
    const outward=(b[1]-a[1])*f.fallDirection[0]-(b[0]-a[0])*f.fallDirection[1];
    if(outward>1e-10&&['eave','valley'].includes(edge.type))f.outletEdgeIds.push(edge.id);
  }
  const total=(type)=>edges.filter(e=>e.type===type).reduce((s,e)=>s+e.length,0);
  const totals={areaPlan:faces.reduce((s,f)=>s+f.areaPlan,0),areaSlope:faces.reduce((s,f)=>s+f.areaSlope,0),ridge:total('ridge'),hip:total('hip'),valley:total('valley'),eave:total('eave'),verge:total('verge'),high:total('high'),maxFallLength:half/cos};
  if(Object.values(totals).some(v=>!Number.isFinite(v))||faces.some(f=>!(f.areaPlan>0))||edges.some(e=>!(e.length>0)||e.faces.length>2))return {ok:false,issues:[{field:'model',code:'numeric',message:'Måtten ger ingen säker takgeometri i modellen.'}]};
  return {ok:true,version:1,input,footprint,faces,edges,totals,limitations:input.plan==='L'?['L-taket förutsätter lika breda delar, samma lutning och takfotshöjd samt två gavlar.','Ränndalen samlar vatten från två takfall. Utloppskanter anger geometri, inte färdig fördelning till stuprör.']:[]};
}
function same(a,b){return a.every((v,i)=>v===b[i]);}
function key(a,b){return [JSON.stringify(a),JSON.stringify(b)].sort().join('|');}
function signedArea(p){return p.reduce((s,a,i)=>{const b=p[(i+1)%p.length];return s+a[0]*b[1]-b[0]*a[1];},0)/2;}
