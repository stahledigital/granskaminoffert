// Versioned source facts, not a structural approval or a complete roofing bill.
// Visually read Benders Palema/Exklusiv 2023-07 table3 and Carisma 2024 table2.
const SOURCES={
 concrete:{url:'https://benders.se/globalassets/c4-assets/document/Monteringsanvisning-BETONG-1o2kupig--2023-07-LU-2.pdf',sha256:'cf26e03f9f967478410f943011019e2caa7cbfbb04bf6d35d0ddff2a41d1ea11',pages:[4,5]},
 carisma:{url:'https://www.benders.se/globalassets/c4-assets/document/Carisma-Laggning-2024-LU.pdf',sha256:'40f9ffde1a5e678b0ee2e4d95e0c2140120321e27098b63c6d3e4cc2e096cd01',pages:[4,5,6,10]}
};
const TABLES={
 palema:[[375,8.9],[370,9],[365,9.2],[360,9.3],[355,9.4],[350,9.6],[345,9.7],[340,9.8],[335,10],[330,10.1],[325,10.3],[320,10.4],[310,10.8]],
 exklusiv:[[375,10.7],[370,10.8],[365,11],[360,11.1],[355,11.3],[350,11.5],[345,11.6],[340,11.8],[335,12],[330,12.2],[325,12.3],[320,12.4],[310,12.8]],
 carisma:[[350,11.5],[345,11.6],[340,11.8],[335,12],[330,12.2],[325,12.3],[320,12.4],[310,12.8]]
};
const NAMES={palema:'Benders Palema',exklusiv:'Benders Exklusiv',carisma:'Benders Carisma'};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const fail=(field,code,message)=>({ok:false,issues:[{field,code,message}]});
// Tolerance removes only floating-point noise at an integer, never a real part.
const ceil=v=>{const n=Math.round(v);return n>0&&Math.abs(v-n)<=8*Number.EPSILON*Math.max(1,Math.abs(v))?n:Math.ceil(v);};

export function roofTileProfile(input){
 if(!object(input))return fail('profile','input','Välj pannprofil och ange taklutning.');
 const {profile,pitch}=input;
 if(!['palema','exklusiv','carisma'].includes(profile))return fail('profile','profile','Välj en kontrollerad pannprofil.');
 const carisma=profile==='carisma',minimum=carisma?18:14;
 if(!finite(pitch)||pitch<minimum||pitch>=90)return fail('pitch','tile-pitch',`${NAMES[profile]} kräver minst ${minimum}° taklutning. Kontrollera måttet eller välj annan taktäckning.`);
 const max=carisma?(pitch<22?325:350):(pitch<18?320:pitch<22?340:375);
 const source=SOURCES[carisma?'carisma':'concrete'];
 return {ok:true,version:1,profile,pitch,name:NAMES[profile],minPitchDeg:minimum,minGaugeMm:310,maxGaugeMm:max,
  coverageRows:TABLES[profile].filter(([gauge])=>gauge<=max).map(([gaugeMm,perM2])=>({gaugeMm,perM2})),
  requirements:{bond:carisma?'half-bond':'profile-specific',deck:carisma?'raw-boarding':'system-dependent',
   underlay:{approvedForPurpose:true,recommendedClass:carisma?'YEP2500':null,equivalentAllowed:true,equivalenceVerified:false,bondedSeams:!carisma&&pitch<22},
   eaveWedge:carisma?{minPitchDeg:22,ventilatedEaveBatten:true}:null,
   layoutChecks:carisma?['Mät och provpassa första och sista bärläkt.','Halvförband krävs. Halvpannor och gavelavslut behöver egen rad-/kantlayout.']:['Mät och provpassa första och sista bärläkt.','Kontrollera breddindelning och gavel-/nockavslut.']},
  source:{...source,pages:[...source.pages]}};
}

export function roofTileEstimate(input){
 const p=roofTileProfile(input);if(!p.ok)return p;
 const {gaugeMm,areaM2,wastePct}=input;
 if(!finite(gaugeMm)||gaugeMm<p.minGaugeMm||gaugeMm>p.maxGaugeMm)return fail('gaugeMm','gauge-range',`${p.name} kräver läktavstånd ${p.minGaugeMm}–${p.maxGaugeMm} mm vid ${p.pitch}°.`);
 const row=p.coverageRows.find(r=>r.gaugeMm===gaugeMm);
 if(!row)return fail('gaugeMm','coverage-unlisted','Läktavståndet saknar exakt rad i källtabellen. Ingen interpolerad åtgång används.');
 if(!finite(areaM2)||areaM2<=0||areaM2>1000000)return fail('areaM2','area','Ange takyta större än 0 och högst 1 000 000 m².');
 if(!finite(wastePct)||wastePct<0||wastePct>100)return fail('wastePct','waste','Ange reserv mellan 0 och 100 %.');
 const netNeed=areaM2*row.perM2,quantity=ceil(netNeed*(1+wastePct/100));
 if(!(netNeed>0)||!Number.isSafeInteger(quantity))return fail('areaM2','numeric','Mängden kan inte räknas säkert med dessa mått.');
 return {ok:true,version:1,method:'source-table-area-estimate',profile:p.profile,pitch:p.pitch,gaugeMm,areaM2,wastePct,perM2:row.perM2,netNeed,quantity,unit:'st',completePurchasePlan:false,source:p.source,
  requiredChecks:['Ytmängd enligt tillverkarens avrundade tabell. Inte en rad-/läggningsplan.','Specialpannor, halvpannor, infästning, reserv och kapning måste kontrolleras för det verkliga taket.']};
}

/** Endpoints are fixed, measured TOP-of-batten to TOP-of-batten, never assumed offsets. */
export function roofBattenLayout(input){
 if(!object(input))return fail('spanMm','input','Ange uppmätt läktsträcka.');
 if(input.confirmed!==true)return fail('confirmed','measurement-confirmation','Bekräfta att sträckan är uppmätt mellan första och sista bärläktens överkanter.');
 const p=roofTileProfile(input);if(!p.ok)return p;
 const {spanMm}=input;
 if(!finite(spanMm)||spanMm<=0||spanMm>100000)return fail('spanMm','measurement','Ange uppmätt sträcka större än 0 och högst 100 000 mm.');
 const intervals=ceil(spanMm/p.maxGaugeMm),gaugeMm=spanMm/intervals;
 if(gaugeMm<p.minGaugeMm-1e-9||gaugeMm>p.maxGaugeMm+1e-9)return fail('spanMm','layout-fit','De fasta läktlägena kan inte delas jämnt inom profilens läktavstånd. Kontrollera eller justera lägena på taket.');
 const positionsMm=Array.from({length:intervals+1},(_,i)=>i===intervals?spanMm:i*spanMm/intervals);
 return {ok:true,version:1,method:'measured-between-batten-tops',profile:p.profile,pitch:p.pitch,spanMm,intervals,positionCount:positionsMm.length,gaugeMm,positionsMm,completePurchasePlan:false,source:p.source,
  requiredChecks:['Läktintervall och läktlägen redovisas separat. Antalet är inte ett verifierat antal pannrader.','Kontrollera mått, underlag, läktdimension, första/sista panna och gavel-/nockavslut på plats.']};
}
