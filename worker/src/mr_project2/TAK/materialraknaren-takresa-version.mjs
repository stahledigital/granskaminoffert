// Static version routing only. Stored data can never choose an import path.
import {validateRoofState,roofStateBasis} from './materialraknaren-takresa-state.mjs';
import {validateRoofStateV2,roofStateBasisV2} from './materialraknaren-takresa-state-v2.mjs';
const unknown=()=>({ok:false,issues:[{field:'snapshot',code:'unknown-version',message:'Takmodellen har en okänd beräkningsversion. Sparade mått och materialrader har inte ändrats.'}]});
export function validateVersionedRoofState(raw){try{return raw?.version===1?validateRoofState(raw):raw?.version===2?validateRoofStateV2(raw):unknown();}catch{return unknown();}}
export function versionedRoofStateBasis(raw){try{return raw?.version===1?roofStateBasis(raw):raw?.version===2?roofStateBasisV2(raw):unknown();}catch{return unknown();}}
