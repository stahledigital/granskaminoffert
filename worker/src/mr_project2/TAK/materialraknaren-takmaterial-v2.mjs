// V2 uses shared source facts without modifying the hash-bound V1 renderer.
// This module is a qualified area estimate; state/list/UI integration is separate.
import {roofMaterialBasis as legacyBasis} from './materialraknaren-takmaterial.mjs';
import {roofTileProfile,roofTileEstimate} from './materialraknaren-takprofiler.mjs';
import {roofGeometry} from './materialraknaren-takmodell.mjs';
const FIELDS=['covering','profile','gaugeMm','perM2','wastePct','ridgePerM','ridgePackSize','windExposed'];
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const fail=(field,code,message)=>({ok:false,issues:[{field,code,message}]});
export function roofMaterialBasisV2(input,options){
 if(!object(options)||Object.keys(options).some(k=>!FIELDS.includes(k)))return fail('material','material-fields','Materialvalet har okända uppgifter. Kontrollera vald beräkningsversion.');
 if(options.profile!==undefined&&!['palema','exklusiv','carisma','custom'].includes(options.profile))return fail('profile','profile','Välj en känd pannprofil eller egna uppgifter.');
 if(options.windExposed!==undefined&&typeof options.windExposed!=='boolean')return fail('windExposed','exposure','Ange om taket är vindutsatt.');
 for(const k of ['gaugeMm','perM2','wastePct','ridgePerM','ridgePackSize'])if(options[k]!==undefined){const v=options[k],max=k==='wastePct'||k==='ridgePerM'?100:1000;if(!finite(v)||(k==='wastePct'?v<0:v<=0)||v>max||(k==='ridgePackSize'&&!Number.isSafeInteger(v)))return fail(k,'material-number','Kontrollera materialets mått, antal och reserv.');}
 const g=roofGeometry(input);if(!g.ok)return g;
 if(g.totals.areaSlope>1000000)return fail('areaM2','area','Takytan får vara högst 1 000 000 m².');
 if(options.covering==='membrane'){const r=legacyBasis(input,options);return r.ok?{...r,version:2}:r;}
 if(options.covering!=='tiles')return fail('covering','covering','Välj taktäckning.');
 const custom=options.profile==='custom',own=options.perM2!==undefined;
 const p=custom?null:roofTileProfile({profile:options.profile,pitch:g.input.pitch});if(p&&!p.ok)return p;
 const gauge=options.gaugeMm===undefined?p?.maxGaugeMm:options.gaugeMm;
 if(!finite(gauge)||gauge<=0||gauge>1000)return fail('gaugeMm','gauge','Ange läktavstånd i mm.');
 if(p&&(gauge<p.minGaugeMm||gauge>p.maxGaugeMm))return fail('gaugeMm','gauge-range',`${p.name} kräver läktavstånd ${p.minGaugeMm}–${p.maxGaugeMm} mm vid ${p.pitch}°.`);
 const row=p?.coverageRows.find(x=>x.gaugeMm===gauge),perM2=own?options.perM2:row?.perM2;
 if(!finite(perM2)||perM2<=0||perM2>1000)return fail('perM2','density','Ange ditt eget åtgångstal eller välj en exakt rad i källtabellen. Ingen interpolation används.');
 // Keep the tested V1 geometry/ridge/count operations, not its Carisma assumptions.
 const r=legacyBasis(input,{...options,profile:options.profile==='carisma'?'custom':options.profile,gaugeMm:gauge,perM2});if(!r.ok)return r;
 r.version=2;r.density={perM2,sourceBased:!!p&&!own,origin:own?'user':'source-table'};
 if(p){
  if(!own){const estimate=roofTileEstimate({profile:p.profile,pitch:p.pitch,gaugeMm:gauge,areaM2:g.totals.areaSlope,wastePct:options.wastePct});if(!estimate.ok)return estimate;r.items.find(x=>x.id==='tiles').quantity=estimate.quantity;}
  const oldSource=r.profile.source;
  r.profile={id:p.profile,name:p.name,sourceVerified:true,minGaugeMm:p.minGaugeMm,maxGaugeMm:p.maxGaugeMm,gaugeMm:gauge,requirements:p.requirements,source:p.source};
  if(p.profile==='carisma'){
   r.requiredChecks=r.requiredChecks.filter(x=>x.code!=='custom-material-system');
   r.fastening={method:'not-modelled',edgeRows:null,aroundPenetrations:null,fieldFraction:null,quantityComputed:false};
   r.requiredChecks.push({code:'carisma-fastening',message:'Kontrollera Carismas infästning mot den egna monteringsanvisningen. Inga Palema-regler eller infästningsantal har använts.'},
    {code:'carisma-bond',message:'Carisma läggs i halvförband. Halvpannor, gavelavslut och kapning behöver egen rad- och kantplan.'},
    {code:'carisma-deck-underlay',message:'Carisma kräver råspont och ändamålsgodkänd underlagspapp. Benders rekommenderar YEP2500 eller likvärdig; ingen annan produkts likvärdighet är verifierad här.'},
    {code:'carisma-eave',message:'Takfotskil kräver minst22° och ventilerad takfotsläkt. Detta val räknar ingen kil eller takfotsuppbyggnad.'});
  }else if(oldSource)r.fastening.source=oldSource;
 }
 r.warnings=r.warnings.filter(x=>x.code!=='custom-density');
 if(!r.density.sourceBased)r.warnings.push({code:'custom-density',message:'Ditt eget åtgångstal används och är inte källverifierat för den valda profilen och läktavståndet.'});
 return r;
}
