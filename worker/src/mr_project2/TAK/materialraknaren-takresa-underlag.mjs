import {roofStateBasis} from './materialraknaren-takresa-state.mjs';
import {roofMaterialPart} from './materialraknaren-takresa-producenter.mjs';
// Preserve the frozen TM5 projection and its five source hashes for old jobs.
// Only explicitly selected, source-pinned TM6 snapshots gain this material row.
export function roofMaterialWithUnderlayPart(raw){
 const part=roofMaterialPart(raw);if(part.ok===false)return part;
 const b=roofStateBasis(raw);if(!b.ok)return b;if(!b.underlay)return part;
 const u=b.underlay;
 return {...part,rows:[...part.rows,{hd:'',k:'Underlagspapp YAP2200, 0,67 × 15 m',v:u.totals.rolls,u:'rullar',sub:`${u.totals.baseRolls} rullar från kapplanen + ${u.totals.reserveRolls} hela reservrullar (${b.state.underlay.reservePct.toLocaleString('sv-SE')} %). Gäller takfallens ytvåder; anslutningar och infästning mängdas separat.`}],notes:[...new Set([...part.notes,...u.requiredChecks.map(x=>x.message)])]};
}
