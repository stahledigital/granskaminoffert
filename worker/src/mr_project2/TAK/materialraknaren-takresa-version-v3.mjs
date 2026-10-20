// Explicit static extension. Old saved snapshots keep their original engines;
// data cannot select an import path, a newer engine, or a migration operation.
import {isRoofJson} from './materialraknaren-json-contract.mjs';
import * as legacy from './materialraknaren-takresa-version.mjs';
import {validateRoofStateV3,roofStateBasisV3} from './materialraknaren-takresa-state-v3.mjs';
const unknown=()=>({ok:false,issues:[{field:'snapshot',code:'unknown-version',message:'Takmodellen kan inte öppnas i den här versionen. Sparade mått och materialrader har inte ändrats.'}]});
function route(raw,old,newV3){
 try{
  if(!isRoofJson(raw)||raw===null||typeof raw!=='object')return unknown();
  return raw.version===3?newV3(raw):[1,2].includes(raw.version)?old(raw):unknown();
 }catch{return unknown();}
}
export const validateVersionedRoofState=raw=>route(raw,legacy.validateVersionedRoofState,validateRoofStateV3);
export const versionedRoofStateBasis=raw=>route(raw,legacy.versionedRoofStateBasis,roofStateBasisV3);
