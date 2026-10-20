// Applied roof snapshots and producer payloads must survive JSON unchanged.
// No accessors, custom serializers, sparse arrays or special JS containers.
export function isRoofJson(value){
 let nodes=0;
 function visit(v,depth){
  if(++nodes>100000||depth>128)return false;
  if(v===null||typeof v==='string'||typeof v==='boolean')return true;
  if(typeof v==='number')return Number.isFinite(v);
  if(typeof v!=='object')return false;
  const array=Array.isArray(v),proto=Object.getPrototypeOf(v);
  if(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)return false;
  const names=Reflect.ownKeys(v);
  if(array&&(names.length!==v.length+1||!Object.hasOwn(v,'length')))return false;
  for(const name of names){
   if(array&&name==='length')continue;
   if(typeof name!=='string'||array&&!/^(0|[1-9][0-9]*)$/.test(name))return false;
   const d=Object.getOwnPropertyDescriptor(v,name);
   if(!d||!d.enumerable||!Object.hasOwn(d,'value')||!visit(d.value,depth+1))return false;
  }
  return true;
 }
 try{return visit(value,0);}catch{return false;}
}
