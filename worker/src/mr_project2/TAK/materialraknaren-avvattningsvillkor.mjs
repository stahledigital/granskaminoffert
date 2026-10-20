/** Source-specific placement conditions shared by the visible planner and saved
 * list. These are requirements, never additional hydraulic capacity or SKUs.
 * Same checked Plastmo diagram / Plannja 2026 pp10–11 as TM3/TM4.
 */
export function drainageConditions(result,system){
 const issues=[],longest=Math.max(...result.gutters.map(g=>g.length));
 for(const g of result.gutters)for(const p of g.outlets){
  const add=(code,message)=>issues.push({edgeId:g.edgeId,pipeId:p.id,code,message});
  if(system.profile==='plastmo-plastic'){
   const middle=Math.abs(p.at-g.length/2)<1e-7,end=p.at===0||p.at===g.length;
   if(system.placement==='A'&&(!middle||g.outlets.length!==1)||system.placement==='C'&&!end)add('placement-mismatch','Vald tabellplacering stämmer inte med rörläget.');
   if(system.placement==='B')add('placement-unknown','Mellanläget saknar exakta mått i källan; kontrollera tillämpningen.');
  }else if(system.profile==='plannja-2026'){
   if(g.length>10&&g.outlets.length<2)add('eave-two-outlets','Över 10 m kräver två fall och stuprör enligt Plannja.');
   if(p.maxGutterRun>10)add('gutter-run','Mer än 10 m till stupröret behöver ändrad indelning.');
   if(result.geometry.input.form==='hip'&&Math.abs(g.length-longest)<1e-7&&(g.outlets.length<2||Number(system.gutter)<125))add('hip-long-side','Plannjas valmtaksregel: två stuprör per långsida och minst 125 mm ränna.');
  }
  if(p.pointInflows.length)add('point-inflow','Punktinflödet från ränndalen behöver separat kontroll.');
 }
 return issues;
}
