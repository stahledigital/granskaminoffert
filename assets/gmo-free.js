/* GMO gratisuppgiften (D19): "Granska en offert gratis". Monteras av GMO.go('free') i #task-root; gör inget på egen hand vid laddning. */
(function(){
'use strict';
var G=window.GMO;
var TEMPLATE=`<div class="pathsel" id="pathsel" role="group" aria-label="Välj din roll">
  <button type="button" class="pathcard sel" data-path="mottagare" aria-pressed="true"><b>Jag har fått en offert</b><span>Förstå vad som står i den och vad du bör fråga om innan du skriver på.</span></button>
  <button type="button" class="pathcard" data-path="hantverkare" aria-pressed="false"><b>Jag ska skicka en offert</b><span>Se vad kunden kommer att fråga om – innan du skickar.</span></button>
</div>
<p class="pathnote" id="pathnote" aria-live="polite">Du får en lista med det som är otydligt – och frågor att skicka till hantverkaren.</p>
<!-- UX 2026-10-13 (Fable, Anders förslag): det betalda alternativet för vald väg ligger som knapp direkt under vägvalet; detaljtext bakom "Vad ingår?". Pris/villkorstext oförändrade. -->
<aside class="cmpoffer" id="cmpoffer" hidden aria-labelledby="cmpo-h">
  <p class="cmph" id="cmpo-h" role="heading" aria-level="2">Har du fler offerter för samma jobb?</p>
  <a class="btn" id="cmpo-go" href="/jamfor/" data-cmp="start">Jämför 2–4 offerter – <span data-cmp-price>49 kr</span></a>
  <p class="cmpmeta">Betalas en gång: <span data-cmp-price>49 kr</span> inkl. moms. Ingen prenumeration, ingen automatisk dragning.</p>
  <details class="more"><summary>Vad ingår?</summary>
    <p>Här granskas en offert i taget, gratis. Jämför mina offerter ställer 2–4 offerter för samma jobb sida vid sida – vad som ingår, pris och villkor.</p>
    <p class="cmpreviews" id="cmpo-rev"><b>Jämför också företagens omdömen, betyg och antal recensioner sida vid sida när källor finns.</b> Vilka källor som finns för just dina firmor visas innan du betalar.</p>
  </details>
</aside>
<aside class="cmpoffer" id="fkoffer" hidden aria-labelledby="fko-h">
  <p class="cmph" id="fko-h" role="heading" aria-level="2">Ska du skicka en offert?</p>
  <a class="btn" id="fko-go" href="/forkontroll/" data-fk="start">Förkontrollera min offert – 49 kr</a>
  <p class="cmpmeta">Betalas en gång: 49 kr inkl. moms. Ingen prenumeration, ingen automatisk dragning.</p>
  <details class="more"><summary>Vad ingår?</summary>
    <p>Kontroll av din egen offert innan du skickar den: moms, ROT-underlag, pristyp, omfattning och tid. Du får frågor din kund sannolikt ställer och, efter din bekräftelse, färdiga tilläggstexter och en PDF-bilaga till kunden.</p>
  </details>
</aside>

<div class="drop" id="drop"><span class="freetag">Gratis · inget konto</span><b>Ladda upp din offert</b><span>PDF, foto eller text</span>
  <div class="alt" style="justify-content:center;margin-top:16px">
    <button type="button" class="btn acc" id="pickfile">Välj fil</button>
    <button type="button" class="btn" id="pickcam">Ta foto</button>
  </div>
  <span class="dragtip">…eller dra filen hit</span>
  <input type="file" id="file" accept=".pdf,image/*,.txt" tabindex="-1" aria-label="Offertfil">
  <input type="file" id="cam" accept="image/*" capture="environment" tabindex="-1" aria-label="Foto av offert">
</div>
<div class="filepreview" id="filepreview" role="status"></div>
<p class="privinfo" id="privinfo">AI (Anthropic Claude) läser offerten; svaret sparas hos oss högst 24 timmar för felsökning. Dölj gärna personnummer, namn och adress – de behövs inte. <a href="#om" id="privlink">Mer om dina uppgifter</a>.</p>
<textarea id="txt" placeholder="Klistra in offerttexten här…"></textarea>
<div id="runwrap" style="display:none">
  <label class="optin"><input type="checkbox" id="statsopt"> <span>Bidra anonymt till prisstatistik. Sparar bara jobbtyp, län, prisband och vilka kontroller som föll ut – aldrig text, namn, företag eller belopp. <a href="/sa-granskar-vi-priser/">Läs vad som sparas</a>.</span></label>
  <div class="alt"><button class="btn" id="run">Granska</button></div>
</div>

<div class="loading" id="loading" role="status" aria-live="polite">Granskningen kan ta en stund.</div>
<div class="errbox" id="errbox" role="alert"></div>
<div class="sr" id="announce" role="status" aria-live="polite"></div>
<div class="alt">
  <button class="btn ghost" id="demo">Prova med en exempeloffert</button>
  <button class="btn ghost" id="paste">Klistra in text i stället</button>
</div>
<div class="res" id="res" data-nosnippet tabindex="-1" aria-label="Granskningsresultat"></div>

<details id="om">
<summary>Om tjänsten och dina uppgifter</summary>
<div class="body">
<p>Tjänsten är avsedd för hantverksarbete. Material som ingår i hantverkarens offert omfattas. Materialinköp, produktköp och abonnemang stöds ännu inte.</p>
<p>Granska min offert läser offerten med hjälp av AI (Anthropic Claude) och ger en uppskattning av vad som står i dokumentet — inte ett juridiskt utlåtande och ingen kontroll mot externa register (t.ex. Skatteverket).</p>
<p>Offerten (foto, PDF eller text) skickas till Anthropic för att kunna analyseras. Anthropic behåller in- och utdata i upp till 30 dagar enligt sin egen policy, längre om innehållet flaggats av deras säkerhetssystem — se <a href="https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data">Anthropics policy för dataretention</a>.</p>
<p>Vi sparar inte själva offertfilen eller den inklistrade texten i vår egen infrastruktur. Vi behåller AI:ts svar (som kan innehålla uppgifter hämtade ur offerten, t.ex. belopp eller adress) samt teknisk information inklusive din IP-adress i högst 24 timmar, enbart för att kunna felsöka fel — därefter raderas det automatiskt.</p>
<p>Vi använder Cloudflare Web Analytics för kakfri besöks- och prestandastatistik. Offerttext, filer och granskningsresultat skickas inte till besöksmätningen.</p>
<p>Prisbilden i resultatet räknas av vår egen kod mot referensintervall från offentliga källor (SCB, Skatteverket, Konsumentverket och namngivna prisguider) – se <a href="/sa-granskar-vi-priser/">Så granskar vi priser</a>. Om du kryssar i "Bidra anonymt till prisstatistik" sparar vi, utan koppling till dig eller offerten, ett fåtal grova uppgifter: jobbtyp, län, summaband, timprisband, ungefärlig andel arbete/material, om ROT förekom, vilka kontroller som föll ut och datum. Aldrig fritext, företagsnamn, organisationsnummer, personnamn, adress, IP-adress eller filnamn. Rutan är avbockad som standard. Uppgifterna används för att på sikt visa egna referensintervall per län.</p>
<p>Vi räknar också hur många granskningar som blev klara, hur ofta Kopiera, e-post eller SMS används och hur ofta länkarna till Ståhle Digital klickas. Det är bara räknare med händelsens namn och vald roll – ingen offerttext, inga belopp, ingen IP-adress och inga filnamn.</p>
<p>Läs mer i <a href="https://stahledigital.se/integritet">Ståhle Digitals integritetspolicy</a>.</p>
</div>
</details>

<p class="foot">Ett verktyg från <a href="https://stahledigital.se/verkstaden">Ståhle Digital</a> · <a href="/foretagsuppgifter/">Företagsuppgifter</a> · <a href="/jamfor/angra/" id="ftbuy">Ångra ett köp</a> · <a href="mailto:hej@stahledigital.se" data-cta="epost">hej@stahledigital.se</a></p>
`;
G.registerTask('free',{
  template:TEMPLATE,
  mount:function(root,ctx){
    root.innerHTML=TEMPLATE;
    var dead=false;

const $=GMO.$;

// Befintlig produktionsendpoint; offertinnehåll skickas enbart i POST-body.
const API_BASE="https://granskaminoffert-api.anders-316.workers.dev"; // gratisgranskningen anropar alltid produktions-API:t (som före D19); config/betalning går via GMO.API_BASE
/* Testkörningar: ?sd-test=1 i adressen märker granskningen som test i tratten (header X-SD-Test: 1). 2026-09-25 */
const SD_TEST=GMO.SD_TEST;

const demoText=`OFFERT nr 2026-118
Byggfirma Exempel AB, Org.nr 556XXX-XXXX, Innehar F-skattsedel
Kund: Anna Andersson, Storgatan 12, Exempelstad

Arbete: Byte av 32 m² takpannor inkl. läkt och underlagspapp, garage.
Material: Benders Palema betongpannor, bärläkt 25x48, underlagspapp YAP 2200.
Arbetstid: 2 man, 3 dagar. Timpris 595 kr/h inkl. moms.
Arbete 36 h x 595 kr = 21 420 kr
Material 18 900 kr
Bortforsling och container 2 500 kr
Summa inkl. moms 42 820 kr
ROT-avdrag på arbetskostnad: -6 426 kr
Att betala efter ROT: 36 394 kr
Betalning 30 dagar efter slutfört arbete. Offerten gäller 30 dagar.`;

// Exempelresultat byggt på riktiga svar från live-workern för exakt denna
// offerttext (testat 2026-09-14, se GRANSKAMINOFFERT_FORSLAG_TYDLIGHET_2026-09-14.md
// och PROJEKTOVERSIKT.md) — inte påhittat, och förberäknat lokalt så
// exempelknappen inte kostar ett riktigt AI-anrop varje gång någon klickar.
const demoResult={
  trade:"tak",
  contradictions:[],
  calcCoverage:"checked",
  calcNote:"Kontrollerade 36 h × 595 kr = 21 420 kr och att delposterna (21 420 + 18 900 + 2 500 kr) adderar till totalsumman 42 820 kr, samt att ROT-avdraget (6 426 kr) motsvarar 30 % av arbetskostnaden — allt stämmer.",
  clarify:[
    {key:"Tidplan / startdatum",text:"Arbetstid (2 man, 3 dagar) anges men inget faktiskt startdatum eller ungefärlig period nämns."},
    {key:"ÄTA (ändringar och tillägg)",text:"Inget om hur tillkommande arbete eller ändringar prissätts."},
    {key:"Försäkring / garanti",text:"Varken ansvarsförsäkring, garantitid eller garanti på material/arbete nämns."}
  ],
  stated:[
    {key:"F-skatt & org.nr",text:"Organisationsnummer och F-skattsedel anges."},
    {key:"Moms",text:"Priser anges inklusive moms."},
    {key:"ROT-avdrag",text:"ROT-avdrag på arbetskostnaden anges, med slutsumma efter avdrag."},
    {key:"Arbete och material separerat",text:"Arbete, material och bortforsling är specificerade var för sig."},
    {key:"Omfattning",text:"32 m² takpannor, läkt och underlagspapp anges tydligt."},
    {key:"Betalningsvillkor",text:"30 dagar efter slutfört arbete anges."},
    {key:"Giltighetstid",text:"Offerten gäller 30 dagar, vilket anges."}
  ],
  price:{hourlyRateSek:595,totalSumSek:42820,rotDeducted:true,
    comment:"Timpris och totalsumma anges tydligt, inklusive moms och ROT-avdrag."},
  questions:[
    "Vilket startdatum gäller – kan ni bekräfta det skriftligt?",
    "Hur prissätts tillkommande arbete (ÄTA) om något oväntat upptäcks under rivningen?",
    "Har ni ansvarsförsäkring och vilken garanti gäller på arbetet?",
    "Ingår bortforsling av allt rivningsmaterial, eller bara det som nämns?"
  ],
  priceReport:Object.assign({"checked":[{"id":"moms","status":"ok","title":"Moms","text":"Priserna anges inklusive moms, konsekvent.","source":""},{"id":"rot_belopp","status":"ok","title":"ROT-belopp","text":"ROT-avdraget 6 426 kr är 30 % av arbetskostnaden 21 420 kr inklusive moms.","source":"Skatteverket, Rot och rut, sidan ändrad 2026-03-03"},{"id":"arbetssumma","status":"ok","title":"Timmar × timpris","text":"36 timmar × 595 kr = 21 420 kr, vilket stämmer med arbetssumman.","source":""},{"id":"summa","status":"ok","title":"Summering","text":"Raderna summerar till 42 820 kr, och efter ROT-avdrag 6 426 kr blir det 36 394 kr att betala – det stämmer.","source":""},{"id":"pristyp","status":"flagga","title":"Pristyp","text":"Offerten anger inte om priset är fast, ungefärligt eller löpande. Ett ungefärligt pris får överskridas med högst 15 %; ett löpande pris har inget tak.","source":"Konsumentverket, Anlita hantverkare, 2026"}],"compared":[{"id":"tim_snickare","mode":"inom","title":"Marknad – timpris snickare","text":"Timpriset 595 kr per timme inkl. moms ligger inom det intervall vi ser för snickare 2026 (550–800 kr per timme inkl. moms; Byggahus.se mars 2026, SCB lönestatistik 2025).","source":"Byggahus.se mars 2026, SCB lönestatistik 2025"},{"id":"projekt","mode":"inom","title":"Totalpris takomläggning","text":"Totalpriset 1 338 kr per m² ligger inom det spann publika prisguider anger för takomläggning 2026 (1 200–3 000 kr per m², typiskt ~1 500 kr/m²; Byggstart 2026). Guiderna redovisar inte metod – se det som en grov referens.","source":"Byggstart 2026"}],"cannotAssess":[{"title":"Betalningsdatum","text":"Varken offertdatum eller planerad betalning anges. ROT-satsen styrs av när betalningen sker, så kontrollen ovan utgår från betalning i år.","source":"Skatteverket, Rot och rut, sidan ändrad 2026-03-03"}]},{referenceVersion:"2026-10-09",disclaimer:"Referensintervallen bygger på offentliga källor och är en uppskattning, inte facit. Ett pris utanför intervallet är en fråga att ställa, inte ett fel."}),
  meta:{demo:true}
};

// Arbetsytan (G.ws.free) bär originalfilen/texten/rollen/resultatet mellan uppgiftsbyten i samma dokument (aldrig lagring, aldrig nätverk).
// pendingFile = den förberedda (ev. krympta) filen som gratisgranskningen skickar; originalet i wsF.file ändras aldrig och är det som följer med till betalvägen.
const wsF=G.ws.free;
let pendingFile=null; // File (förberedd) eller null om text används
let fkOpen=false;
let chosenPath=wsF.path||'mottagare'; // 'mottagare' | 'hantverkare' — styr bara etikett/kopiera-knapp, inte själva granskningen
let lastResult=null;
let lastIsDemo=false;
let ownResult=null; // eget (icke-demo) resultat som exemplet tillfälligt skymmer
let inputGen=0;     // generation för användarens senaste inmatningsavsikt; sena läs-/bildsvar med äldre generation tillämpas aldrig
let skipSave=false,attemptGen=0,running=false,runCtl=null; // submit-lås (före första await) och pågående försök
let methodNow='unknown',readyFired=false;
const PATHNOTE={mottagare:'Du får en lista med det som är otydligt – och frågor att skicka till hantverkaren.',hantverkare:'Du får en punktlista att fixa innan offerten går iväg.'};

// Reserverad resultatyta: skelettet tar platsen före anropet och ersätts på plats av resultatet.
// Sidan scrollas högst EN gång, till resultatets topp vid start. Ingen slutscroll när resultatet kommer.
function showSkeleton(){
  const r=$('res');
  r.innerHTML='<section class="gmo-skel" aria-hidden="true"><p>Granskar offerten…</p><span></span><span></span><span></span><span></span></section>';
  r.setAttribute('aria-busy','true');r.classList.add('on');
  r.scrollIntoView({behavior:'auto',block:'start'});
}
function hideSkeleton(){const r=$('res');r.removeAttribute('aria-busy');if(r.querySelector('.gmo-skel')){r.classList.remove('on');r.innerHTML='';}}
function setLoading(on){$('loading').classList.toggle('on',on);$('run').disabled=on;}
function showError(msg){$('errbox').textContent=msg;$('errbox').classList.add('on');}
function clearError(){$('errbox').classList.remove('on');$('errbox').textContent='';}

// AI-genererad text (nyckelord/beskrivningar/frågor/priskommentar) får ALDRIG
// gå orenad in i innerHTML — den kan i teorin manipuleras via indirekt
// prompt-injection i det inklistrade offertinnehållet. Escapa allt.
function escapeHtml(s){
  return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function findingsList(items,statusClass,icon){
  if(!items||!items.length)return '';
  return `<ul class="chk">${items.map(i=>`<li class="${statusClass}"><i>${icon}</i><div><b>${escapeHtml(i.key)}</b><small>${escapeHtml(i.text)}</small></div></li>`).join('')}</ul>`;
}

function calcSummaryFragment(result){
  if(result.calcCoverage==='insufficient_data')return 'beräkningen gick inte att kontrollera';
  const n=(result.contradictions||[]).length;
  if(n===0)return 'inga räknefel upptäckta i AI-kontrollen';
  return n===1?'1 avvikelse hittad':`${n} avvikelser hittade`;
}

function renderCalcSection(result){
  const items=result.contradictions||[];
  const note=escapeHtml(result.calcNote||'');
  if(items.length){
    // AI-avläst: aldrig ett säkert fel. Rubrik och förbehåll står direkt vid fynden.
    return `<h3>${AI_QUAL_HEAD}</h3><p class="calcnote aiqual">${AI_QUAL}</p>${note?`<p class="calcnote">${note}</p>`:''}${findingsList(items,'warn','!')}<p class="caveat">AI-utförd kontroll utifrån det som går att läsa i dokumentet – inte en garanterad matematisk verifiering.</p>`;
  }
  let head;
  if(result.calcCoverage==='insufficient_data')head=note||'Underlaget räcker inte för att kontrollera beräkningen.';
  else head='Inga räknefel upptäckta.'+(note?' '+note:'');
  return `<h3>Räknekontroll</h3><p class="calcnote">${head}</p><p class="caveat">AI-utförd kontroll utifrån det som går att läsa i dokumentet – inte en garanterad matematisk verifiering.</p>`;
}

function renderPrice(result){
  const p=result.price||{};
  const rows=[];
  if(p.hourlyRateSek)rows.push(`<div>Timpris i offerten</div><div class="v">${Number(p.hourlyRateSek).toLocaleString('sv-SE')} kr/h</div>`);
  if(p.totalSumSek)rows.push(`<div>Totalsumma i offerten</div><div class="v">${Number(p.totalSumSek).toLocaleString('sv-SE')} kr</div>`);
  if(rows.length){
    return `<div class="price">${rows.join('')}<div style="grid-column:1/-1;font-size:14px;color:var(--ink2)">${escapeHtml(p.comment||'')}</div>${p.rotDeducted?'<div style="grid-column:1/-1;font-size:13px;color:var(--ink2)">ROT-avdrag redovisat.</div>':''}</div>`;
  }
  return `<div class="price"><div style="font-size:14px;color:var(--ink2)">${escapeHtml(p.comment||'Inget pris hittades i offerten.')}</div></div>`;
}

const PB_ICON={ok:['ok','✓'],fel:['bad','✕'],fraga:['warn','?'],flagga:['warn','!']};
function pbList(items,iconFn){
  return `<ul class="chk">${items.map(i=>{const [cls,ic]=iconFn(i);return `<li class="${cls}"><i>${ic}</i><div><b>${escapeHtml(i.title)}</b><small>${escapeHtml(i.text)}${i.source?`<span class="src">Källa: ${escapeHtml(i.source)}</span>`:''}</small></div></li>`;}).join('')}</ul>`;
}
function renderPriceReport(result){
  const pr=result.priceReport;
  if(!pr)return renderPrice(result);
  const checked=pr.checked||[],cmp=pr.compared||[],cannot=pr.cannotAssess||[];
  let out='<div class="pb">';
  out+=renderPrice(result);
  out+=`<h4>Kontrollerat</h4>${checked.length?pbList(checked,i=>PB_ICON[i.status]||['warn','!']):'<p>Underlaget räcker inte för någon regelkontroll.</p>'}`;
  out+=`<h4>Jämfört</h4>${cmp.length?pbList(cmp,i=>i.mode==='inom'?['ok','✓']:['warn','?']):'<p>Inget timpris eller totalpris att jämföra mot referensintervallen.</p>'}`;
  if(cannot.length)out+=`<h4>Går inte att bedöma</h4>${pbList(cannot,()=>['warn','–'])}`;
  out+=`<p class="disc">${escapeHtml(pr.disclaimer||'')} <a href="/sa-granskar-vi-priser/">Så granskar vi priser</a> · referensdata version ${escapeHtml(pr.referenceVersion||'')}.</p></div>`;
  return out;
}
function priceCounts(result){
  const pr=result.priceReport;if(!pr)return null;
  const checked=pr.checked||[],cmp=pr.compared||[],cannot=pr.cannotAssess||[];
  const bad=checked.filter(c=>c.status==='fel').length;
  // Formalia (moms, pristyp, betaldatum) säger inget om priserna: de räknas inte som "prisregler som stämmer".
  const FORMAL=['moms','pristyp','betaldatum'];
  const isOk=c=>c.status==='ok';
  const okN=checked.filter(c=>isOk(c)&&!FORMAL.includes(c.id)).length;
  const formalOk=checked.filter(c=>isOk(c)&&FORMAL.includes(c.id)).length;
  const cmpUnk=cmp.filter(c=>c.mode==='ej_bedombar').length;
  const ask=checked.filter(c=>c.status==='fraga'||c.status==='flagga').length+cmp.filter(c=>c.mode!=='inom'&&c.mode!=='ej_bedombar').length;
  const cannotN=cannot.length+cmpUnk;
  return {bad,okN,formalOk,ask,cannotN,partial:!!pr.partial};
}
// Sammanfattningens prisdel. "Stämmer" sägs bara om minst en prisregel faktiskt kördes och föll ut som OK;
// ingenting grönt sägs om kontroller som inte gick att göra (de redovisas som "går inte att bedöma").
function priceSummaryFragment(result){
  const pc=priceCounts(result);
  if(!pc)return '';
  const parts=[];
  if(pc.bad)parts.push(`${pc.bad} ${pc.bad===1?'prisregel som inte stämmer':'prisregler som inte stämmer'}`);
  if(pc.okN&&!pc.bad&&!pc.ask)parts.push(`${pc.okN} ${pc.okN===1?'prisregel kontrollerad och stämmer':'prisregler kontrollerade och stämmer'}`);
  else if(pc.okN&&!pc.bad)parts.push(`${pc.okN} ${pc.okN===1?'prisregel stämmer':'prisregler stämmer'}`);
  if(pc.formalOk)parts.push(`${pc.formalOk} ${pc.formalOk===1?'formaliauppgift kontrollerad':'formaliauppgifter kontrollerade'}${pc.okN?'':' – inga priser bedömda'}`);
  if(pc.ask)parts.push(`${pc.ask} ${pc.ask===1?'prisfråga att ställa':'prisfrågor att ställa'}`);
  if(pc.cannotN)parts.push(`${pc.cannotN} ${pc.cannotN===1?'prisuppgift som inte går att bedöma':'prisuppgifter som inte går att bedöma'}`);
  if(!parts.length)parts.push('ingen prisregel kunde kontrolleras');
  if(pc.partial)parts.push('prisgranskningen är ofullständig');
  return ', '+parts.join(', ');
}
// Ett positivt "inget att fråga"-besked ges bara när något sakligt faktiskt bedömts och inget lämnats obedömt.
function fullyAssessed(result){
  const pc=priceCounts(result);
  if(result.calcCoverage==='insufficient_data')return false;
  if(!pc)return false;
  return pc.okN>0&&pc.cannotN===0&&!pc.partial;
}

const SIGN='\n\nGranskat med granskaminoffert.se – gratis granskning av hantverkarofferter';
// AI-avlästa sifferfynd är avläsningar att kontrollera mot originalet, inte konstaterade fel (D19). Rubrik och förbehåll följer fynden i alla utdata.
const AI_QUAL_HEAD='Sifferuppgifter att kontrollera mot originalet';
const AI_QUAL='AI-avläsningen visar möjliga avvikelser. Jämför uppgifterna med originalofferten; detta är inte konstaterade fel.';
// EN källa för både skärm och export: samma resultatobjekt, samma urval. Roll styr bara inledning och
// huvudlista; AI-sifferfynd, beräknade prisfel/prisfrågor och osäkerheter exporteras för båda rollerna.
function exportModel(result){
  const pr=result.priceReport;
  const checked=(pr&&pr.checked)||[],cmp=(pr&&pr.compared)||[],cannot=(pr&&pr.cannotAssess)||[];
  const t=c=>({title:c.title,text:c.text});
  const unsure=[];
  if(result.calcCoverage==='insufficient_data')unsure.push({title:'Räknekontroll',text:result.calcNote||'Underlaget räckte inte för att kontrollera beräkningen.'});
  cannot.forEach(c=>unsure.push(t(c)));
  // En referensjämförelse som inte kunde göras är okänd, aldrig en prisfråga: den redovisas exakt en gång under "Går inte att bedöma".
  cmp.filter(c=>c.mode==='ej_bedombar').forEach(c=>unsure.push(t(c)));
  if(!pr)unsure.push({title:'Prisgranskning',text:'Prisgranskningen saknas i det här svaret.'});
  return {
    calc:(result.contradictions||[]).map(i=>({title:i.key,text:i.text})),
    calcChecked:result.calcCoverage==='checked',
    calcNote:result.calcCoverage==='insufficient_data'?'':String(result.calcNote||'').trim(),
    priceBad:checked.filter(c=>c.status==='fel').map(t),
    priceAsk:[...checked.filter(c=>c.status==='fraga'||c.status==='flagga'),...cmp.filter(c=>c.mode!=='inom'&&c.mode!=='ej_bedombar')].map(t),
    unsure,
    clarify:(result.clarify||[]).map(i=>({title:i.key,text:i.text})),
    questions:result.questions||[]
  };
}
const lines=(arr)=>arr.map(i=>`– ${i.title}: ${i.text}`).join('\n');
// Hela granskningen (Kopiera hela granskningen): full sakrapport. Aldrig kanalkapad.
function exportBody(result,path){
  const m=exportModel(result);
  const sec=[];
  if(path==='hantverkare'){
    sec.push('Punkter att förtydliga innan offerten skickas:'+(m.clarify.length?'\n'+lines(m.clarify):'\n– Inget hittades som behöver förtydligas i det som kontrollerades.'));
  }else{
    sec.push('Hej! Jag har några frågor om offerten innan jag skriver på:'+(m.questions.length?'\n'+m.questions.map(q=>`– ${q}`).join('\n'):'\n– (Inga frågor genererades.)'));
    if(m.clarify.length)sec.push('Det som är otydligt i offerten:\n'+lines(m.clarify));
  }
  // Samma räkneanteckning som visas på skärmen följer med i exporten (F8/N19).
  if(m.calc.length)sec.push(AI_QUAL_HEAD+':\n'+AI_QUAL+'\n'+lines(m.calc)+(m.calcNote?'\nRäknekontrollens anteckning: '+m.calcNote:''));
  else if(m.calcChecked)sec.push('Räknekontroll: inga räknefel hittades i AI-kontrollen.'+(m.calcNote?' '+m.calcNote:''));
  else if(m.calcNote)sec.push('Räknekontrollens anteckning: '+m.calcNote);
  if(m.priceBad.length)sec.push('Prisregler som inte stämmer:\n'+lines(m.priceBad));
  if(m.priceAsk.length)sec.push('Prisfrågor:\n'+lines(m.priceAsk));
  if(m.unsure.length)sec.push('Går inte att bedöma:\n'+lines(m.unsure));
  return sec.join('\n\n');
}
function buildClipboardText(result,path){return exportBody(result,path)+SIGN;}

// ---- Meddelandet (D19): ett enda synligt block är både läsnytta och det som skickas. Slutna sakliga mallar per kontrollfynd, ingen ny AI;
// dubbletter sammanförs bara här (fullrapportens fynd och globala antal rörs aldrig). Ordning: beräknade fynd, AI-sifferfynd, frågor, prisfrågor, förtydliganden.
const MSG_AI_RECIP='Några siffror i offerten verkar inte gå ihop vid en automatisk avläsning. Det är inte konstaterade fel och avläsningen kan vara fel – kan du kontrollera dem mot originalet?';
const MSG_AI_OWN='Jämför siffrorna med din offert: en automatisk avläsning visade belopp som kan skilja sig åt. Det är inte konstaterade fel och avläsningen kan vara fel.';
const normTxt=s=>String(s||'').toLowerCase().replace(/[^a-zåäö0-9]+/g,' ').trim();
const withAsk=(t,q)=>/\?\s*$/.test(t)?t:t+' '+q;
function messageItems(result,path){
  const m=exportModel(result),hant=path==='hantverkare',out=[],seen=new Set(),topics=new Set();
  const add=(text,kind,topic,uncertain)=>{
    const t=String(text||'').replace(/\s+/g,' ').trim();if(!t)return;
    const k=normTxt(t);if(seen.has(k))return;seen.add(k);
    if(topic)topics.add(normTxt(topic));
    out.push({text:t,kind,uncertain:!!uncertain});
  };
  m.priceBad.forEach(i=>add(hant?`${i.title}: ${i.text}`:withAsk(`${i.title}: ${i.text}`,'Kan du förklara eller rätta det?'),'price',i.title));
  if(m.calc.length)add(hant?MSG_AI_OWN:MSG_AI_RECIP,'calc','',true);
  if(!hant)m.questions.forEach(q=>add(q,'question',''));
  m.priceAsk.forEach(i=>add(hant?`${i.title}: ${i.text}`:withAsk(`${i.title}: ${i.text}`,'Kan du förtydliga?'),'price',i.title));
  m.clarify.forEach(i=>{
    const k=normTxt(i.title);if(!k||topics.has(k))return;
    if(!hant){if(out.some(o=>normTxt(o.text).includes(k)))return;add(`Kan du förtydliga: ${i.title}?`,'clarify',i.title);}
    else add(`${i.title}: ${i.text}`,'clarify',i.title);
  });
  return out;
}
const msgNoun=path=>path==='hantverkare'?['punkt','punkter']:['fråga','frågor'];
function messageIntro(path){return path==='hantverkare'?'Punkter att åtgärda innan offerten skickas:':'Hej! Jag har några frågor om offerten innan jag skriver på:';}
function messageText(items,path,k){
  const n=msgNoun(path)[1];
  let t=messageIntro(path)+'\n'+items.slice(0,k).map(i=>'– '+i.text).join('\n');
  if(k<items.length)t+=`\n(Kortversion: ${k} av ${items.length} ${n} ingår.)`;
  return t+SIGN;
}
// Uttrycklig förkortning: hela frågor, aldrig rad- eller teckenkapning, och förkortningen står i texten.
function fitMessage(items,path,maxEncoded){
  const enc=t=>encodeURIComponent(t).length;
  const full=messageText(items,path,items.length);
  if(enc(full)<=maxEncoded)return {k:items.length,text:full,cut:false};
  let k=items.length;while(k>0&&enc(messageText(items,path,k))>maxEncoded)k--;
  return {k,text:k?messageText(items,path,k):'',cut:true};
}
function isMobile(){return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)||(navigator.maxTouchPoints>1&&innerWidth<900);}
const SHOWN_Q=5;
function emptyMessageHtml(result,path){
  const hant=path==='hantverkare';
  const full=fullyAssessed(result);
  const t=hant
    ?(full?'Vi hittade inget att åtgärda i det vi kontrollerade. Det är inget besked om att offerten är komplett eller godkänd.':'Inga punkter att skicka, men delar av offerten gick inte att bedöma (se Ej bedömt ovan). Det är inget besked om att offerten är komplett.')
    :(full?'Vi hittade inga frågor att ställa i det vi kontrollerade. Det säger inget om hantverkarens kvalitet eller om du har rätt till ROT-avdrag.':'Inga frågor att skicka, men delar av offerten gick inte att bedöma (se Ej bedömt ovan). Det är inget besked om att offerten är komplett.');
  return `<section class="msgblock" id="msgblock" data-empty="1" aria-labelledby="msg-h"><h3 id="msg-h">${hant?'Punkter att åtgärda':'Frågor att ställa'}</h3><p id="msgempty">${t}</p></section>`;
}
function renderMessageBlock(result,path,items){
  const hant=path==='hantverkare',n=items.length,[sg,pl]=msgNoun(path);
  if(!n)return emptyMessageHtml(result,path);
  const li=i=>`<li${i.uncertain?' data-uncertain="1"':''}>${escapeHtml(i.text)}</li>`;
  const head=items.slice(0,SHOWN_Q).map(li).join('');
  const rest=items.slice(SHOWN_Q).map(li).join('');
  const list=`<ol class="qs" id="msglist">${head}</ol>`+(rest?`<details class="msgmore"><summary>Visa alla ${n} ${pl}</summary><ol class="qs" start="${SHOWN_Q+1}">${rest}</ol></details>`:'');
  const h=hant?'Punkter att åtgärda innan du skickar':'Frågor att ställa';
  const buttons=hant
    ?`<button type="button" class="btn acc" id="copymsg">Kopiera punkterna</button><a class="btn" id="sendmail" href="#">Mejla punkterna till mig</a>${isMobile()?'<a class="btn" id="sendsms" href="#">Skicka som SMS till mig</a>':''}`
    :`<a class="btn acc" id="sendmail" href="#">Skicka frågorna</a>${isMobile()?'<a class="btn" id="sendsms" href="#">Skicka som SMS</a>':''}<button type="button" class="btn ghost" id="copymsg">Kopiera frågorna</button>`;
  return `<section class="msgblock" id="msgblock" aria-labelledby="msg-h">
    <h3 id="msg-h">${h} <span class="msgn">(${n})</span></h3>
    <p class="hint" id="msgcount">${n===1?`1 ${sg} följer med i meddelandet.`:`Alla ${n} ${pl} följer med i meddelandet.`}</p>
    <p class="msgintro">${messageIntro(path)}</p>
    ${list}
    <p class="msgsign">${SIGN.trim()}</p>
    <div class="send">${buttons}</div>
    <div id="shortnote" class="shortbox" hidden></div>
  </section>`;
}


// Resultatkortet. EN modell (verdictModel) ger färg, antal, staplar och nästa steg från samma resultatobjekt som listorna
// och exporten. Regler: röd = belagd avvikelse; grå = inget kunde bedömas; gul = något att förtydliga/följa upp;
// grön bara när allt som bedömts stämmer, något faktiskt bedömts och inget centralt lämnats obedömt. Inga poäng.
function verdictModel(result,path){
  const pr=result.priceReport,pc=priceCounts(result);
  const checked=(pr&&pr.checked)||[],cmp=(pr&&pr.compared)||[],cannot=(pr&&pr.cannotAssess)||[];
  const FORMAL=['moms','pristyp','betaldatum'];
  const rules=checked.filter(c=>!FORMAL.includes(c.id)||c.status==='fraga'||c.status==='flagga'||c.status==='fel');
  const rOk=rules.filter(c=>c.status==='ok').length;
  const rBad=rules.filter(c=>c.status==='fel').length;
  const rAsk=rules.filter(c=>c.status==='fraga'||c.status==='flagga').length;
  // En jämförelse som inte kunde genomföras (ej_bedombar) är OKÄND, aldrig en prisfråga.
  const cOk=cmp.filter(c=>c.mode==='inom').length,cUnk=cmp.filter(c=>c.mode==='ej_bedombar').length,cAsk=cmp.length-cOk-cUnk;
  // Motsägelser/räknefel kommer från modellens avläsning (ingen avläsningssäkerhet, ingen koppling till originalets position).
  // De är därför "kontrollera siffrorna i originalet" (gul), aldrig ett säkert rött besked. Röd kräver en beräknad prisregel som föll ut som fel.
  const calcN=(result.contradictions||[]).length;
  const calcUnknown=result.calcCoverage==='insufficient_data'&&calcN===0;
  const numericBad=rules.filter(c=>c.status==='fel'&&['summa','arbetssumma','total_konflikt','rot_belopp','rot_material','rot_schablon'].includes(c.id)).length;
  const calcOk=!calcUnknown&&calcN===0&&numericBad===0?1:0;
  const clarifyN=(result.clarify||[]).length,statedN=(result.stated||[]).length;
  const ok=calcOk+rOk+cOk,bad=rBad,ctrlAsk=rAsk+cAsk;
  const attention=ctrlAsk+clarifyN+calcN;
  const unknownParts=[];
  if(calcUnknown)unknownParts.push('AI-kontrollen av räkningen');
  if(!pr)unknownParts.push('prisgranskningen');
  if(cannot.length)unknownParts.push(cannot.length===1?'1 prisuppgift':cannot.length+' prisuppgifter');
  if(cUnk)unknownParts.push(cUnk===1?'1 jämförelse med referens':cUnk+' jämförelser med referens');
  if(pc&&pc.partial)unknownParts.push('delar av prisgranskningen');
  const noRules=!!pr&&rOk+rBad+rAsk===0;
  if(noRules)unknownParts.push('prisreglerna');
  const unknown=(calcUnknown?1:0)+(pr?0:1)+cannot.length+cUnk+((pc&&pc.partial)?1:0)+(noRules?1:0);
  const assessed=ok+bad+ctrlAsk+calcN;
  const hant=path==='hantverkare';
  let tone,mark,title,short,next;
  if(bad>0){
    tone='red';mark='×';
    title=hant?'Avvikelse att rätta innan du skickar':'Avvikelse som behöver förklaras';
    short=`${bad} ${bad===1?'kontroll stämmer inte':'kontroller stämmer inte'}${assessed?` – ${ok} av ${assessed} kontroller stämmer`:''}. Kontrollera mot originalet.`;
    next=hant?'Rätta det som inte stämmer i offerten och läs frågorna nedan innan du skickar den.':'Be hantverkaren förklara eller rätta det som inte stämmer innan du skriver på.';
  }else if(assessed===0){
    tone='grey';mark='–';
    title='Underlag saknas för ett besked';
    short='Ingen kontroll kunde göras med det som gick att läsa. Det är inget besked om att offerten är bra eller dålig.';
    next=hant?'Gör offerten tydligare (belopp, timpris, villkor) och granska igen.':'Be om en tydligare offert eller ladda upp en bättre bild, och granska igen.';
  }else if(calcN>0&&attention===calcN){
    tone='amber';mark='!';
    title=hant?'Kontrollera siffrorna innan du skickar':'Kontrollera siffrorna i originalet';
    short=`${calcN} ${calcN===1?'möjlig avvikelse i siffrorna':'möjliga avvikelser i siffrorna'}. Det är en avläsning ur offerten som behöver jämföras med originalet – inte ett konstaterat fel.`;
    next=hant?'Jämför siffrorna nedan med din offert och rätta det som inte stämmer innan du skickar den.':'Jämför siffrorna nedan med originalet och fråga hantverkaren om något inte stämmer.';
  }else if(attention>0){
    tone='amber';mark='!';
    title=hant?'Förtydliga innan du skickar':'Förtydliga innan du bestämmer dig';
    short=`${ok} av ${assessed} kontroller stämmer. ${attention} ${attention===1?'sak':'saker'} att följa upp.`;
    next=hant?'Gå igenom punkterna nedan och komplettera offerten innan du skickar den.':'Skicka frågorna nedan till hantverkaren och be om svar innan du skriver på.';
  }else if(unknown>0){
    tone='grey';mark='–';
    title='Delar gick inte att bedöma';
    short=`${ok} av ${assessed} kontroller stämmer, men inte allt gick att bedöma. Det är inget besked om att offerten är komplett.`;
    next=hant?'Komplettera det som inte gick att läsa och granska igen.':'Fråga hantverkaren om det som inte gick att bedöma innan du skriver på.';
  }else{
    tone='green';mark='✓';
    title='Kontrollerade delar stämmer';
    short=`${ok} av ${assessed} kontroller stämmer och inget att följa upp hittades. Avser bara det vi kunde kontrollera (se nedan).`;
    next=hant?'Inget att rätta i det vi kontrollerade. Läs ändå igenom offerten en gång till innan du skickar.':'Inget att följa upp i det vi kontrollerade. Läs ändå igenom offerten själv innan du skriver på.';
  }
  // Statusrader (inga staplar): en rad per kontroll med symbol + ord + exakt antal. Per rad gäller samma nämnare som tidigare; ingen total, ingen poäng.
  // Allvarligast vinner raden: avvikelse > fråga/kontrollera > ej (helt) bedömt > stämmer. Grönt (✓) betyder bara kontrollerat och stämmer.
  const pl2=(n,a,b)=>n===1?a:b;
  const rows=[];
  if(numericBad&&calcN)rows.push({st:'bad',label:'Räkningen',text:`${numericBad} ${pl2(numericBad,'beräknad avvikelse','beräknade avvikelser')} · ${calcN} ${pl2(calcN,'möjlig avvikelse','möjliga avvikelser')} att kontrollera mot originalet`});
  else if(numericBad)rows.push({st:'bad',label:'Räkningen',text:`${numericBad} ${pl2(numericBad,'beräknad avvikelse','beräknade avvikelser')} – kontrollera mot originalet`});
  else if(calcUnknown)rows.push({st:'unknown',label:'Räkningen',text:'Ej bedömd – kunde inte kontrolleras'});
  else if(calcN)rows.push({st:'ask',word:'Kontrollera',label:'Räkningen',text:`${calcN} ${pl2(calcN,'möjlig avvikelse','möjliga avvikelser')} att jämföra med originalet; inget konstaterat fel`});
  else rows.push({st:'ok',label:'Räkningen',text:'Inga avvikelser hittades i den utförda kontrollen'});
  {
    const t=rOk+rBad+rAsk,g=cannot.length;
    if(!pr)rows.push({st:'unknown',label:'Prisregler',text:'Ej bedömd – prisgranskningen saknas i det här svaret'});
    else if(!t)rows.push({st:'unknown',label:'Prisregler',text:'Ej bedömd – ingen prisregel kunde kontrolleras'});
    else{
      const txt=(!rBad&&!rAsk&&!g)?`${rOk} av ${t} kontrollerade prisregler stämmer`:`${rOk} av ${t+g} stämmer${rBad?` · ${rBad} ${pl2(rBad,'avvikelse','avvikelser')}`:''}${rAsk?` · ${rAsk} ${pl2(rAsk,'fråga','frågor')}`:''}${g?` · ${g} ej ${pl2(g,'bedömd','bedömda')}`:''}`;
      rows.push(rBad?{st:'bad',label:'Prisregler',text:txt}:rAsk?{st:'ask',label:'Prisregler',text:txt}:g?{st:'unknown',word:'Delvis bedömt',label:'Prisregler',text:txt}:{st:'ok',label:'Prisregler',text:txt});
    }
  }
  if(!cmp.length)rows.push({st:'unknown',label:'Jämförelse med referens',text:'Ingen jämförelse ingick'});
  else if(cUnk===cmp.length)rows.push({st:'unknown',label:'Jämförelse med referens',text:`${cUnk} ${pl2(cUnk,'jämförelse','jämförelser')} ej ${pl2(cUnk,'bedömd','bedömda')}; ingen prisfråga eller avvikelse`});
  else{
    const txt=`${cOk} av ${cmp.length} inom referensintervall${cAsk?` · ${cAsk} ${pl2(cAsk,'fråga','frågor')}`:''}${cUnk?` · ${cUnk} ej ${pl2(cUnk,'bedömd','bedömda')}`:''}${cOk&&!cAsk&&!cUnk?'; ingen garanti om rimligt pris':''}`;
    rows.push(cAsk?{st:'ask',label:'Jämförelse med referens',text:txt}:cUnk?{st:'unknown',word:'Delvis bedömt',label:'Jämförelse med referens',text:txt}:{st:'ok',word:'Inom referens',label:'Jämförelse med referens',text:txt});
  }
  // Uppgift som står i offerten är inte kontrollerad som sann: egen symbol/ord (anges, ej verifierat), aldrig grönt.
  if(statedN+clarifyN)rows.push({st:clarifyN?'ask':'stated',label:'Tydlighet i offerten',text:`${statedN} anges i offerten (inte verifierat) · ${clarifyN} att förtydliga`});
  else rows.push({st:'unknown',label:'Tydlighet i offerten',text:'Ej bedömd – inget att bedöma'});
  const scope=[];
  if(!calcUnknown)scope.push('räkningen');
  if(rOk+rBad+rAsk)scope.push(`${rOk+rBad+rAsk} ${rOk+rBad+rAsk===1?'prisregel':'prisregler'}`);
  if(cmp.length-cUnk)scope.push(`${cmp.length-cUnk} ${cmp.length-cUnk===1?'jämförelse':'jämförelser'} med referens`);
  return {tone,mark,title,short,next,ok,bad,attention,unknown,assessed,unknownParts,rows,scope};
}
function renderVerdictCard(result,isDemo,summary){
  const v=verdictModel(result,chosenPath);
  const rows=v.rows.map(r=>G.stRowHtml(r.st,r.label,r.text,r.word)).join('');
  const gap=v.unknown>0?`<p class="gmo-gap"><b>Ej bedömt:</b> ${escapeHtml(v.unknownParts.join(', '))} gick inte att bedöma.</p>`:'';
  const scope=`<p class="gmo-scope"><b>Kontrollerat:</b> ${v.scope.length?escapeHtml(v.scope.join(', ')):'ingenting'}.</p>`;
  const tonename={green:'kontrollerat',amber:'förtydliga',red:'avvikelse',grey:'ej bedömt'}[v.tone];
  const cnt=(n,c,glyph,word)=>n>0?`<span data-c="${c}"><i aria-hidden="true">${glyph}</i><strong>${n}</strong>${word}</span>`:'';
  const counts=[cnt(v.ok,'green','✓','stämmer'),cnt(v.bad,'red','×',v.bad===1?'avvikelse':'avvikelser'),cnt(v.attention,'amber','!','att följa upp'),cnt(v.unknown,'grey','–','ej bedömt')].join('');
  return `<section class="gmo-card" data-tone="${v.tone}" aria-label="Resultat: ${tonename}">
  <div class="gmo-verdict"><div class="gmo-mark" aria-hidden="true">${v.mark}</div><div><div class="gmo-eyebrow">Ditt besked${isDemo?' · <span class="tag">Exempel</span>':''}</div><h2>${escapeHtml(v.title)}</h2><p class="gmo-short">${escapeHtml(v.short)}</p></div></div>
  <p class="gmo-counts">${counts||'<span data-c="grey"><i aria-hidden="true">–</i>Inget kunde räknas</span>'}</p>
  ${scope}${gap}
  <ul class="st-rows gmo-rows" aria-label="Utfall per kontroll">${rows}</ul>
  <div class="gmo-next"><span>NÄSTA STEG</span><p>${escapeHtml(v.next)}</p></div>
  <p class="gmo-foot">Avser det vi kunde kontrollera i offerten. Granskningen bedömer inte hantverkarens arbete och är inget juridiskt utlåtande.</p>
</section>`;
}
// Prisgrund (litet neutralt faktablock): vad som lästs ur offerten, momsbasen och vad referensen faktiskt kunde bedöma.
// Okänd moms eller saknat referensintervall blir aldrig ett siffervärde eller en prisgaranti.
function priceBasisHtml(result){
  const p=result.price||{},pr=result.priceReport;
  const fmt=x=>Number(x).toLocaleString('sv-SE');
  const bits=[];
  if(p.totalSumSek)bits.push(`totalsumma ${fmt(p.totalSumSek)} kr`);
  if(p.hourlyRateSek)bits.push(`timpris ${fmt(p.hourlyRateSek)} kr/h`);
  if(p.rotDeducted===true)bits.push('ROT-avdrag redovisat');
  const rows=[['Avläst i offerten',bits.length?bits.join(' · '):'Inget pris kunde läsas ut.']];
  const checked=(pr&&pr.checked)||[],cmp=(pr&&pr.compared)||[],cannot=(pr&&pr.cannotAssess)||[];
  const mo=checked.find(c=>c.id==='moms');
  rows.push(['Moms',mo?mo.text:(pr?'Momsbasen framgår inte av avläsningen – belopp som beror på moms kan inte bedömas.':'Prisgranskningen saknas i det här svaret.')]);
  const cOk=cmp.filter(c=>c.mode==='inom').length,cUnk=cmp.filter(c=>c.mode==='ej_bedombar').length;
  rows.push(['Referens',!cmp.length?'Ingen jämförelse mot referensintervall ingick, så ingen prisbedömning görs.':`${cOk} av ${cmp.length} ${cmp.length===1?'jämförelse':'jämförelser'} inom referensintervall${cUnk?` · ${cUnk} ej bedömd${cUnk===1?'':'a'}`:''}. Referensintervall är en uppskattning och ingen garanti om rimligt pris.`]);
  const un=[...cannot.map(c=>c.title),...cmp.filter(c=>c.mode==='ej_bedombar').map(c=>c.title)].filter(Boolean);
  if(un.length)rows.push(['Går inte att bedöma',un.join(', ')]);
  return `<section class="pbasis" id="pbasis" aria-labelledby="pb-h"><h3 id="pb-h">Prisgrund</h3><dl>${rows.map(r=>`<div><dt>${escapeHtml(r[0])}</dt><dd>${escapeHtml(r[1])}</dd></div>`).join('')}</dl></section>`;
}

// ---- Övergång gratis → betald jämförelse/förkontroll (A2). Visas bara när respektive produkt är öppen enligt serverns config (annars oförändrad gratissida).
// Ett AKTIVT klick för med det egna underlaget (originalfilen eller texten, aldrig exemplet) till TOMT mål i samma dokument. Inget skrivs i lagring eller adress,
// ingen analys, betalning eller källanrop startas av överföringen, och ett mål som redan innehåller arbete eller en order skrivs aldrig över (kvitto förklarar).
const HANDOFF_KEY='sd_handoff_v1';
let cmpOpen=false,cmpPrice='49 kr';
function handoffSweep(){try{const raw=sessionStorage.getItem(HANDOFF_KEY);if(!raw)return;let r=null;try{r=JSON.parse(raw)}catch(e){}if(!r||typeof r.exp!=='number'||Date.now()>r.exp)sessionStorage.removeItem(HANDOFF_KEY);}catch(e){}}
function currentDoc(){
  if(wsF.file)return{file:wsF.file};
  const t=$('txt').value||'';
  if(!t.trim())return null;
  return{text:t};
}
function moveTo(target,ev){
  if(ev&&(ev.metaKey||ev.ctrlKey||ev.shiftKey||ev.button===1))return; // ny flik/Ctrl-klick = ren länk utan underlag (minnet följer inte med en ny flik)
  if(ev)ev.preventDefault();
  saveDraft();
  const doc=currentDoc();
  G.ws.receipt=G.transfer(target,doc,{from:'free'});
  G.go(target,{push:true,reason:'user'});
}
function cmpCtaHtml(isDemo){
  return `<aside class="cmpcta" id="cmpcta" aria-labelledby="cmpr-h">
    <p class="cmph" id="cmpr-h" role="heading" aria-level="2">Har du fler offerter för samma jobb?</p>
    <p>Jämför vad som ingår, pris och villkor sida vid sida.</p>
    <p class="cmpreviews" id="cmpr-rev"><b>Jämför också företagens omdömen, betyg och antal recensioner sida vid sida när källor finns.</b> Vilka källor som finns för just dina firmor visas innan du betalar.</p>
    <p class="cmpmeta">Betalas en gång: <span data-cmp-price>${cmpPrice}</span> inkl. moms. Ingen prenumeration, ingen automatisk dragning. ${isDemo?'Det här är en exempeloffert och följer inte med.':'Din offert här följer med när du klickar i den här fliken – du behöver inte ladda upp den igen. Öppnar du länken i en ny flik följer den inte med.'}</p>
    <a class="btn acc" id="cmpr-go" href="/jamfor/" data-cmp="result">Jämför 2–4 offerter – <span data-cmp-price>${cmpPrice}</span></a>
  </aside>`;
}
// UX 2026-10-12 (Fable): hantverkaren som fått gratislistan erbjuds förkontrollen (samma produkt/pris som kortet på startsidan).
function fkCtaHtml(){
  return `<aside class="cmpcta" id="fkcta" aria-labelledby="fkr-h">
    <p class="cmph" id="fkr-h" role="heading" aria-level="2">Ska du skicka den här offerten?</p>
    <p>Förkontrollen går igenom moms, ROT-underlag, pristyp, omfattning och tid. När du bekräftat uppgifterna får du färdiga tilläggstexter och en PDF-bilaga till kunden.</p>
    <p class="cmpmeta">Betalas en gång: 49 kr inkl. moms. Ingen prenumeration, ingen automatisk dragning.</p>
    <a class="btn acc" id="fkr-go" href="/forkontroll/" data-fk="result">Förkontrollera min offert – 49 kr</a>
  </aside>`;
}
function bindCmp(){
  document.querySelectorAll('[data-cmp]').forEach(a=>{if(!a.dataset.bound){a.dataset.bound='1';a.addEventListener('click',ev=>moveTo('compare',ev));}});
  document.querySelectorAll('[data-fk]').forEach(a=>{if(!a.dataset.bound){a.dataset.bound='1';a.addEventListener('click',ev=>moveTo('check',ev));}});
}
function syncCmp(){
  document.querySelectorAll('[data-cmp-price]').forEach(n=>{n.textContent=cmpPrice;});
  const mott=chosenPath==='mottagare',shown=$('res').classList.contains('on');
  const o=$('cmpoffer');if(o)o.hidden=!(cmpOpen&&mott&&!shown);
  const fk=$('fkoffer');if(fk)fk.hidden=!(fkOpen&&chosenPath==='hantverkare');
  // UX 2026-10-13 (Fable): #cmpoffer/#fkoffer ligger direkt under vägvalet (ovan); ingen separat textlänk.
  const c=$('cmpcta');if(c)c.hidden=!(cmpOpen&&mott);
  if(cmpOpen&&mott&&shown&&!c){const alt=$('res').querySelector(':scope > .alt');if(alt){alt.insertAdjacentHTML('beforebegin',cmpCtaHtml(lastIsDemo));bindCmp();const n=$('cmpcta');if(n)n.hidden=false;}}
}
(function(){
  handoffSweep();bindCmp();
  function apply(C){
    const c=C.cfg;if(dead||!c)return;
    if(c.enabled===true&&c.accepting===true&&c.offer&&Number.isFinite(c.offer.priceOre)){cmpOpen=true;cmpPrice=Math.round(c.offer.priceOre/100)+' kr';syncCmp();bindCmp();}
    if(c.check&&c.check.available===true){fkOpen=true;syncCmp();}
    if(c.consent&&c.consent.policy==='P'){const fb=document.getElementById('ftbuy');if(fb){fb.href='/jamfor/kop/';fb.textContent='Köp, villkor och hjälp';}}
  }
  // Erbjudandena är tillägg: nätfel ger oförändrad gratisuppgift (ingen produkt utlovas utan serverbesked).
  G.config.load().then(apply,()=>{});
})();

function render(result,isDemo,opts){
  opts=opts||{};
  lastResult=result;lastIsDemo=!!isDemo;
  const clarifyN=(result.clarify||[]).length;
  const statedN=(result.stated||[]).length;
  const clarifyWord=clarifyN===1?'sak att förtydliga':'saker att förtydliga';
  const priceFrag=priceSummaryFragment(result);
  const summary=`${clarifyN} ${clarifyWord}, ${calcSummaryFragment(result)}${priceFrag}, ${statedN} ${statedN===1?'uppgift som framgår':'uppgifter som framgår'} tydligt.`;
  const items=messageItems(result,chosenPath);

  // Ordning (D19): kompakta statusrader + nästa steg → prisgrund → ETT fråge-/meddelandeblock med en primär handling → fullkopia → tekniska detaljer (stängda).
  $('res').innerHTML=`${renderVerdictCard(result,isDemo,summary)}
  ${priceBasisHtml(result)}
  ${renderMessageBlock(result,chosenPath,items)}
  <div class="fullcopy"><button type="button" class="btn ghost" id="copybtn">Kopiera hela granskningen</button><span class="hint">Alla fynd, räknekontroll och prisregler som text att spara eller dela.</span></div>
  <details class="gmo-all"><summary>Se alla fynd och kontrollmetod</summary>
  <div class="summarybox"><p>${escapeHtml(summary)}</p></div>
  ${renderCalcSection(result)}
  <h3>Behöver förtydligas</h3>${result.clarify&&result.clarify.length?findingsList(result.clarify,'warn','!'):(fullyAssessed(result)?'<p>Vi hittade inget som sticker ut som otydligt i det vi kontrollerar.</p>':'<p>Inget otydligt hittades i det som kontrollerades, men delar gick inte att bedöma (se Ej bedömt ovan).</p>')}
  <h3>Prisbild</h3>${renderPriceReport(result)}
  <h3>Uppgifter som anges i offerten (${statedN}, inte verifierade)</h3>${result.stated&&result.stated.length?findingsList(result.stated,'stated','○'):'<p>Inga tydliga uppgifter av den här typen hittades i dokumentet.</p>'}
  </details>
  ${chosenPath==='hantverkare'||!cmpOpen?'':cmpCtaHtml(isDemo)}
  ${chosenPath==='hantverkare'&&fkOpen?fkCtaHtml():''}
  <div class="alt">
    ${isDemo?'<button class="btn acc" type="button" id="demoback">Tillbaka till min offert</button>':'<button class="btn ghost" type="button" id="again">Granska en till</button>'}
  </div>
  ${chosenPath==='hantverkare'?`<aside class="fromsd"><p class="fromsd-tag">Från Ståhle Digital</p>
    <p>Har firman ingen hemsida, eller en som inte ger jobb? Vi bygger hemsidor för hantverkare, i hela Sverige.</p>
    <a class="btn" href="https://stahledigital.se" rel="noopener" data-cta="hemsida">Se vad vi gör</a>
    <p class="sub">Ska du räkna material till jobbet? <a href="https://stahledigital.se/verkstaden/materialraknaren" rel="noopener" data-cta="materialraknaren">Materialräknaren är gratis.</a></p>
  </aside>`:''}`;
  wireMessage(items);
  $('res').querySelectorAll('[data-cta]').forEach(a=>a.addEventListener('click',()=>sendEvent({type:'client',event:'kontakt_cta',detail:a.dataset.cta})));
  $('res').removeAttribute('aria-busy');
  $('res').classList.add('on');
  if(!opts.restore){
    $('announce').textContent=(isDemo?'Exempel. ':'Granskningen är klar. ')+summary;
    const h=$('res').querySelector('h2');if(h){h.tabIndex=-1;h.focus({preventScroll:true});}
  }
  bindCmp();syncCmp();
  const db=$('demoback');if(db)db.addEventListener('click',leaveDemo);
  const ag=$('again');if(ag)ag.addEventListener('click',resetFree);
  // En ny leverans mäts bara när den faktiskt kom från servern: omritning (rollbyte), återställning efter uppgiftsbyte och exempel ger ingen ny händelse.
  if(!isDemo&&!opts.restore&&!opts.rerender){sendEvent({type:'client',event:'rapport_klar'});G.measure.event('result_view',{product:'free'});}

  const copyBtn=$('copybtn');
  copyBtn.onclick=()=>copyOut(buildClipboardText(lastResult,chosenPath),copyBtn,'Kopiera hela granskningen','Hela granskningen är kopierad.');
}
async function copyOut(text,btn,label,doneMsg){
  try{
    await navigator.clipboard.writeText(text);
    trackShare('copy');
    btn.textContent='Kopierat!';
    $('announce').textContent=doneMsg;
    setTimeout(()=>{btn.textContent=label;},1800);
  }catch(e){
    showError('Kunde inte kopiera automatiskt — markera och kopiera texten manuellt.');
  }
}
// Kanalerna använder exakt det förhandsvisade meddelandet. Får det inte plats i en länk visas den faktiska kortversionen i blocket (aldrig tyst kapning),
// och hela meddelandet går alltid att kopiera. Inget skickas automatiskt.
function wireMessage(items){
  if(!items.length)return;
  const hant=chosenPath==='hantverkare',[sg,pl]=msgNoun(chosenPath),n=items.length;
  const subj=hant?'Punkter att åtgärda i offerten':'Frågor om offerten';
  const mail=fitMessage(items,chosenPath,1900),sms=fitMessage(items,chosenPath,1200);
  const mailA=$('sendmail'),smsA=$('sendsms');
  const link=(a,url,fit,ch)=>{
    if(!a)return;
    if(!fit.k){a.hidden=true;a.removeAttribute('href');return;}
    a.href=url(fit.text);a.addEventListener('click',()=>trackShare(ch));
  };
  link(mailA,t=>'mailto:?subject='+encodeURIComponent(subj)+'&body='+encodeURIComponent(t),mail,'email');
  link(smsA,t=>'sms:?&body='+encodeURIComponent(t),sms,'sms');
  const shorts=[];
  if(mail.cut)shorts.push(['E-post',mail]);
  if(smsA&&sms.cut&&!(mail.cut&&mail.text===sms.text))shorts.push(['SMS',sms]);
  const box=$('shortnote');
  if(box&&shorts.length){
    box.innerHTML=shorts.map(([ch,f])=>f.k
      ?`<p><b>${ch}: kortversion.</b> Meddelandet är för långt för en länk, så bara de första ${f.k} av ${n} ${pl} följer med. Det här är texten som öppnas:</p><pre>${escapeHtml(f.text)}</pre>`
      :`<p><b>${ch}:</b> Meddelandet är för långt för en länk. Kopiera hela meddelandet i stället.</p>`).join('')+`<p>Hela meddelandet med alla ${n} ${pl}: välj ${hant?'Kopiera punkterna':'Kopiera frågorna'}.</p>`;
    box.hidden=false;
  }
  const cm=$('copymsg');
  if(cm){const label=cm.textContent;cm.onclick=()=>copyOut(messageText(items,chosenPath,n),cm,label,'Meddelandet är kopierat.');}
}

// Mätning: bara räknare, aldrig innehåll. Exempeloffert och testkörningar skickar inget i skarpt läge.
// Roll skickas som etikett; händelsen "rapport_klar" är klientens egen och ersätter inte serverns granskning_klar.
function sendEvent(ev){
  try{
    if(!API_BASE||lastIsDemo)return;
    const url=API_BASE.replace(/\/$/,'')+'/event';
    const body=JSON.stringify(Object.assign({role:chosenPath,test:SD_TEST},ev));
    if(navigator.sendBeacon){navigator.sendBeacon(url,new Blob([body],{type:'application/json'}));}
    else{fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body,keepalive:true}).catch(()=>{});}
  }catch(e){}
}
function trackShare(channel){
  if(!lastResult)return;
  sendEvent({type:'share',channel});
}

function mError(reason,stage){G.measure.event('client_error',{product:'free',stage:stage||'submit',reason});}

async function runReview(){
  if(running||dead)return;            // lås före första await: ett dubbeltryck ger ett försök och en mätpunkt
  running=true;
  const my=++attemptGen,inGen=inputGen;
  clearError();
  if(!API_BASE){running=false;showError('Granskningstjänsten är inte påkopplad än (API_BASE saknas i koden). Testa "Prova med en exempeloffert" under tiden.');return;}
  // Oföränderlig försökskontext: det som skickas är det som gällde när kunden tryckte, aldrig något som ändrats därefter.
  const ctx={file:pendingFile,text:($('txt').value||'').trim(),path:chosenPath,stats:!!($('statsopt')&&$('statsopt').checked),method:methodNow};
  if(!ctx.file&&!ctx.text){running=false;showError('Klistra in offerttext eller välj en fil först.');mError('empty','input');return;}
  setLoading(true);
  showSkeleton();
  G.measure.event('submit',{product:'free',method:ctx.file?(ctx.method==='camera'?'camera':'file'):'text'});
  runCtl=new AbortController();
  const avbryt=runCtl;
  let tidsgrans=setTimeout(()=>avbryt.abort(),120000); // hellre ett ärligt fel än evig väntan
  const stale=()=>dead||my!==attemptGen||inGen!==inputGen; // kundens senaste avsikt vinner: ändrad inmatning eller ny start gör svaret inaktuellt
  try{
    let payload;
    if(ctx.file){
      let b64;
      try{b64=await G.readAsBase64(ctx.file);}catch(e){if(!stale()){showError('Filen gick inte att läsa. Välj den igen eller klistra in texten.');mError('read');}return;}
      if(stale())return;
      payload={kind:ctx.file.type==='application/pdf'?'pdf':'image',dataBase64:b64,mediaType:ctx.file.type,filename:ctx.file.name};
    }else payload={kind:'text',text:ctx.text};
    payload.path=ctx.path;payload.stats=ctx.stats;
    const resp=await fetch(API_BASE.replace(/\/$/,'')+'/review',{
      method:'POST',headers:SD_TEST?{'Content-Type':'application/json','X-SD-Test':'1'}:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:avbryt.signal
    });
    let data=null;try{data=await resp.json();}catch(e){}
    if(stale())return;
    if(!resp.ok||!data){showError((data&&data.error)||'Något gick fel. Försök igen.');mError('server');return;}
    wsF.result=data;
    render(data,false);
  }catch(e){
    if(stale())return;
    if(e&&e.name==='AbortError'){showError('Granskningen tog för lång tid. Försök igen, eller klistra in offerttexten i stället för att skicka en bild.');mError('timeout');}
    else{showError('Kunde inte nå granskningstjänsten. Kontrollera din uppkoppling och försök igen.');mError('network');}
  }finally{
    clearTimeout(tidsgrans);
    if(my===attemptGen){running=false;runCtl=null;if(!dead){hideSkeleton();setLoading(false);}}
  }
}
// Ny inmatning avbryter ett pågående försök (kundens senaste avsikt vinner); svaret kastas och påverkar aldrig annan inmatning.
function inputChanged(){
  inputGen++;
  if(running){attemptGen++;running=false;try{runCtl&&runCtl.abort();}catch(e){}runCtl=null;hideSkeleton();setLoading(false);}
}

document.querySelectorAll('.pathcard').forEach(el=>{
  el.addEventListener('click',()=>{
    chosenPath=el.dataset.path;wsF.path=chosenPath;
    document.querySelectorAll('.pathcard').forEach(c=>{c.classList.toggle('sel',c===el);c.setAttribute('aria-pressed',c===el?'true':'false');});
    $('pathnote').textContent=PATHNOTE[chosenPath];
    if(lastResult&&$('res').classList.contains('on'))render(lastResult,lastIsDemo,{rerender:true}); // rollbyte ritar om utan ny leverans/händelse
    syncCmp();
  });
});

// Exemplet är ett separat läsläge: det rör aldrig eget underlag, eget resultat eller payload och startar varken AI, order eller kassa.
$('demo').onclick=()=>{
  if(!lastIsDemo&&lastResult)ownResult=lastResult;
  wsF.demoActive=true;G.measure.demoSeen=true;
  clearError();
  render(demoResult,true);
  G.measure.event('example_view',{product:'free'});
};
// "Granska en till": nollställer gratisutkastet i appen (ingen omladdning) och monterar om uppgiften.
function resetFree(){
  wsF.file=null;wsF.text='';wsF.result=null;wsF.demoActive=false;
  G.measure.demoSeen=false;
  skipSave=true;
  G.go('free',{force:true,reason:'reset'});
}
function leaveDemo(){
  wsF.demoActive=false;
  if(ownResult){const r=ownResult;ownResult=null;render(r,false,{restore:true});}
  else{lastResult=null;lastIsDemo=false;$('res').classList.remove('on');$('res').innerHTML='';const t=$('txt').classList.contains('on')?$('txt'):$('drop');try{t.focus({preventScroll:true});}catch(e){}}
}
$('paste').onclick=()=>{
  inputChanged();methodNow='text';readyFired=false;
  pendingFile=null;wsF.file=null;$('filepreview').classList.remove('on');$('file').value='';
  $('txt').classList.add('on');$('runwrap').style.display='flex';$('txt').focus();
  G.measure.event('input_choose',{product:'free',method:'text'});
};
$('txt').addEventListener('input',()=>{
  inputChanged();
  if(wsF.file||pendingFile){wsF.file=null;pendingFile=null;$('filepreview').classList.remove('on');$('file').value='';}
  wsF.text=$('txt').value;
  if(methodNow!=='text'){methodNow='text';readyFired=false;G.measure.event('input_choose',{product:'free',method:'text'});}
  if($('txt').value.trim()&&!readyFired){readyFired=true;G.measure.event('input_ready',{product:'free',method:'text'});}
  if(!$('txt').value.trim())readyFired=false;
});
$('run').onclick=runReview;

// Riktiga knappar öppnar filväljaren, så Tab, Enter och Mellanslag fungerar utan mus.
$('pickfile').addEventListener('click',()=>$('file').click());
$('pickcam').addEventListener('click',()=>$('cam').click());
$('privlink').addEventListener('click',()=>{const d=$('om');d.open=true;});
document.querySelectorAll('.foot [data-cta]').forEach(a=>a.addEventListener('click',()=>sendEvent({type:'client',event:'kontakt_cta',detail:a.dataset.cta})));

const drop=$('drop');
['dragenter','dragover'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.add('over');}));
['dragleave','drop'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.remove('over');}));

const MAX_BYTES=8000000;
const MAX_KANT=1800;      // längsta sida i pixlar – mer än så tillför inget för läsbarheten
const KRYMP_OVER=1200000; // bilder över ~1,2 MB krymps innan de skickas

// Bilden ritas om till JPEG i webbläsaren. Två vinster: en HEIC från iPhone
// blir läsbar (Safari avkodar den åt oss), och uppladdningen går snabbare på
// mobil. Går något fel skickas originalet – då tar workern felet i stället.
// Originalet (wsF.file) ersätts aldrig av den förberedda bilden: bara gratisvägen skickar den krympta kopian.
function forbered(f){
  const bild=f.type&&f.type.startsWith('image/');
  if(!bild||(f.size<KRYMP_OVER&&f.type!=='image/heic'&&f.type!=='image/heif'))return Promise.resolve(f);
  return new Promise(klar=>{
    const url=URL.createObjectURL(f);
    const img=new Image();
    img.onload=()=>{
      try{
        const skala=Math.min(1,MAX_KANT/Math.max(img.naturalWidth,img.naturalHeight));
        const c=document.createElement('canvas');
        c.width=Math.round(img.naturalWidth*skala);c.height=Math.round(img.naturalHeight*skala);
        c.getContext('2d').drawImage(img,0,0,c.width,c.height);
        c.toBlob(b=>{
          URL.revokeObjectURL(url);
          if(!b||b.size>=f.size&&f.type==='image/jpeg')return klar(f);
          klar(new File([b],(f.name||'offert').replace(/\.[^.]+$/,'')+'.jpg',{type:'image/jpeg'}));
        },'image/jpeg',0.82);
      }catch(e){URL.revokeObjectURL(url);klar(f);}
    };
    img.onerror=()=>{URL.revokeObjectURL(url);klar(f);};
    img.src=url;
  });
}

// Aktivt val av fil/foto. Ett avbrutet filval (inga filer) ändrar ingenting. Generationen gör att ett långsamt svar för ett tidigare val aldrig
// skriver över ett senare (fil→text→fil, byte av fil, nollställning).
function handleFile(f,kind){
  if(!f)return;
  inputChanged();
  const gen=inputGen;
  clearError();
  G.measure.event('input_choose',{product:'free',method:kind==='camera'?'camera':'file'});
  const fresh=()=>!dead&&gen===inputGen;
  if(f.type&&f.type.startsWith('image/')){
    forbered(f).then(g=>{
      if(!fresh())return;
      if(g.size>MAX_BYTES){showError('Bilden är för stor (max 8 MB). Fota med lägre upplösning eller klistra in texten.');mError('size','input');return;}
      laddaFil(f,g,kind,gen);
    });
    return;
  }
  laddaFil(f,f,kind,gen);
}

function laddaFil(orig,f,kind,gen){
  const fresh=()=>!dead&&gen===inputGen;
  if(f.size>MAX_BYTES){showError('Filen är för stor (max 8 MB).');mError('size','input');return;}
  if(f.type.startsWith('text')||/\.txt$/i.test(f.name)){
    G.readAsText(f).then(t=>{
      if(!fresh())return;
      pendingFile=null;wsF.file=null;methodNow=kind==='camera'?'camera':'file';
      $('txt').value=t;wsF.text=t;$('txt').classList.add('on');$('runwrap').style.display='flex';
      $('filepreview').textContent=`Vald fil: ${f.name} (${Math.max(1,Math.round(f.size/1024))} kB). Texten visas nedan – tryck Granska för att starta.`;
      $('filepreview').classList.add('on');
      readyFired=true;G.measure.event('input_ready',{product:'free',method:'file'});
    },()=>{if(fresh()){showError('Filen gick inte att läsa. Välj den igen eller klistra in texten.');mError('read','input');}});
    return;
  }
  // PDF/bild: originalet behålls i minnet för betalvägen; payload (base64) byggs först när Granska trycks.
  pendingFile=f;wsF.file=orig;wsF.text='';methodNow=kind==='camera'?'camera':'file';
  $('txt').value='';$('txt').classList.remove('on');
  $('filepreview').textContent=`Vald fil: ${f.name} (${Math.round(f.size/1024)} kB). Tryck Granska för att starta.`;
  $('filepreview').classList.add('on');
  $('runwrap').style.display='flex';
  readyFired=true;G.measure.event('input_ready',{product:'free',method:kind==='camera'?'camera':'file'});
}
drop.addEventListener('drop',ev=>handleFile(ev.dataTransfer.files[0],'file'));
$('file').addEventListener('change',ev=>{handleFile(ev.target.files[0],'file');});
$('cam').addEventListener('change',ev=>{handleFile(ev.target.files[0],'camera');});

// Utkastet (text/fil/roll/resultat) ligger kvar i arbetsytan när kunden byter uppgift och kommer tillbaka.
function saveDraft(){wsF.text=$('txt').value;wsF.path=chosenPath;wsF.result=ownResult||(lastIsDemo?wsF.result:lastResult)||null;wsF.demoActive=false;}
function restoreDraft(){
  // Rollkort/pathnote följer arbetsytans roll
  document.querySelectorAll('.pathcard').forEach(c=>{const on=c.dataset.path===chosenPath;c.classList.toggle('sel',on);c.setAttribute('aria-pressed',on?'true':'false');});
  $('pathnote').textContent=PATHNOTE[chosenPath];
  if(wsF.file){
    const gen=inputGen,f=wsF.file;
    methodNow='file';
    $('filepreview').textContent=`Vald fil: ${f.name} (${Math.round(f.size/1024)} kB). Tryck Granska för att starta.`;
    $('filepreview').classList.add('on');$('runwrap').style.display='flex';readyFired=true;
    forbered(f).then(g=>{if(!dead&&gen===inputGen&&wsF.file===f)pendingFile=g;});
    pendingFile=f; // tills förberedelsen är klar skickas originalet om kunden hinner trycka (workern tar ev. bildfel)
  }else if(wsF.text){
    $('txt').value=wsF.text;$('txt').classList.add('on');$('runwrap').style.display='flex';methodNow='text';readyFired=!!wsF.text.trim();
  }
  if(wsF.result){render(wsF.result,false,{restore:true});}
}
restoreDraft();

    return {unmount:function(){
      if(!skipSave)saveDraft();dead=true;
      try{runCtl&&runCtl.abort();}catch(e){}
      running=false;
      attemptGen++;inputGen++;
    }};
  }
});
})();
