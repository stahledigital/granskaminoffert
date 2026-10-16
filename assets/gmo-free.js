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
  <a class="btn" id="fko-go" href="/forkontroll/">Förkontrollera min offert – 49 kr</a>
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
<p>Offerten (foto, PDF eller text) skickas till Anthropic för att kunna analyseras. Anthropic behåller in- och utdata i upp till 30 dagar enligt sin egen policy, längre om innehållet flaggats av deras säkerhetssystem, och använder det inte för att träna AI-modeller utan uttryckligt tillstånd — se <a href="https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data">Anthropics policy för dataretention</a>.</p>
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

let pendingFile=null; // {kind,dataBase64,mediaType,filename} eller null om text används
let fkOpen=false;
let chosenPath='mottagare'; // 'mottagare' | 'hantverkare' — styr bara etikett/kopiera-knapp, inte själva granskningen
let lastResult=null;
let lastIsDemo=false;
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
  let head;
  if(items.length){
    head=note;
  }else if(result.calcCoverage==='insufficient_data'){
    head=note||'Underlaget räcker inte för att kontrollera beräkningen.';
  }else{
    head='Inga räknefel upptäckta.'+(note?' '+note:'');
  }
  const list=findingsList(items,'bad','✕');
  return `<p class="calcnote">${head}</p>${list}<p class="caveat">AI-utförd kontroll utifrån det som går att läsa i dokumentet — inte en garanterad matematisk verifiering.</p>`;
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
function ctaLabel(){
  return chosenPath==='hantverkare' ? 'Kopiera punkter att förtydliga' : 'Kopiera frågor till hantverkaren';
}

const SIGN='\n\nGranskat med granskaminoffert.se – gratis granskning av hantverkarofferter';
// EN källa för både skärm och export: samma resultatobjekt, samma urval. Roll styr bara inledning och
// huvudlista; räknefel, prisfel/prisfrågor och osäkerheter exporteras för båda rollerna.
function exportModel(result){
  const pr=result.priceReport;
  const checked=(pr&&pr.checked)||[],cmp=(pr&&pr.compared)||[],cannot=(pr&&pr.cannotAssess)||[];
  const t=c=>({title:c.title,text:c.text});
  const unsure=[];
  if(result.calcCoverage==='insufficient_data')unsure.push({title:'Räknekontroll',text:result.calcNote||'Underlaget räckte inte för att kontrollera beräkningen.'});
  cannot.forEach(c=>unsure.push(t(c)));
  if(!pr)unsure.push({title:'Prisgranskning',text:'Prisgranskningen saknas i det här svaret.'});
  return {
    calc:(result.contradictions||[]).map(i=>({title:i.key,text:i.text})),
    calcChecked:result.calcCoverage==='checked',
    calcNote:result.calcCoverage==='insufficient_data'?'':String(result.calcNote||'').trim(),
    priceBad:checked.filter(c=>c.status==='fel').map(t),
    priceAsk:[...checked.filter(c=>c.status==='fraga'||c.status==='flagga'),...cmp.filter(c=>c.mode!=='inom')].map(t),
    unsure,
    clarify:(result.clarify||[]).map(i=>({title:i.key,text:i.text})),
    questions:result.questions||[]
  };
}
const lines=(arr)=>arr.map(i=>`– ${i.title}: ${i.text}`).join('\n');
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
  if(m.calc.length)sec.push('Räknefel och motsägelser:\n'+lines(m.calc)+(m.calcNote?'\nRäknekontrollens anteckning: '+m.calcNote:''));
  else if(m.calcChecked)sec.push('Räknekontroll: inga räknefel hittades i AI-kontrollen.'+(m.calcNote?' '+m.calcNote:''));
  else if(m.calcNote)sec.push('Räknekontrollens anteckning: '+m.calcNote);
  if(m.priceBad.length)sec.push('Prisregler som inte stämmer:\n'+lines(m.priceBad));
  if(m.priceAsk.length)sec.push('Prisfrågor:\n'+lines(m.priceAsk));
  if(m.unsure.length)sec.push('Går inte att bedöma:\n'+lines(m.unsure));
  return sec.join('\n\n');
}
// Hela texten går alltid att Kopiera. E-post och SMS förkortas rad för rad om länken annars blir för lång,
// och förkortningen anges i texten och på sidan.
const SHORT_NOTE='\n\n[Förkortad text – hela listan finns under Kopiera på granskaminoffert.se-sidan.]';
function fitText(body,maxEncoded){
  const enc=t=>encodeURIComponent(t).length;
  if(enc(body+SIGN)<=maxEncoded)return {text:body+SIGN,cut:false};
  const out=[];
  for(const ln of body.split('\n')){
    if(enc(out.concat(ln).join('\n')+SHORT_NOTE+SIGN)>maxEncoded)break;
    out.push(ln);
  }
  return {text:out.join('\n').replace(/\s+$/,'')+SHORT_NOTE+SIGN,cut:true};
}
function buildClipboardText(result,path){return exportBody(result,path)+SIGN;}
function isMobile(){return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)||(navigator.maxTouchPoints>1&&innerWidth<900);}
function renderActionList(result,path){
  if(path==='hantverkare'){
    const items=result.clarify||[];
    const body=items.length?`<ol class="qs">${items.map(i=>`<li><b>${escapeHtml(i.key)}</b><small>${escapeHtml(i.text)}</small></li>`).join('')}</ol>`:(fullyAssessed(result)?'<p>Vi hittade inget som behöver förtydligas i det vi kontrollerar.</p>':'<p>Vi hittade inget att förtydliga, men delar av offerten gick inte att bedöma (se nedan), så det är inget besked om att allt är komplett.</p>');
    return `<h3>Punkter att förtydliga innan du skickar</h3>${body}`;
  }
  const qs=result.questions||[];
  const body=qs.length?`<ol class="qs">${qs.map(q=>`<li>${escapeHtml(q)}</li>`).join('')}</ol>`:(fullyAssessed(result)?'<p>Inga frågor genererades – offerten verkar besvara det vi kontrollerar.</p>':'<p>Inga frågor genererades, men delar av offerten gick inte att bedöma (se nedan). Det är inget besked om att offerten är komplett.</p>');
  return `<h3>Frågor att ställa innan du skriver på</h3>${body}`;
}
function sendLabel(){return chosenPath==='hantverkare'?'Skicka punkterna till dig själv':'Skicka frågorna till hantverkaren';}


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
  // Staplar: verkliga segment (grön/gul/röd/grå) med gemensam nämnare per rad. total 0 = "Ej bedömd" (tom, streckad).
  const mk=(label,text,g,a,r,n)=>({label,text,segs:g+a+r===0?[]:[['green',g],['amber',a],['red',r],['grey',n]].filter(x=>x[1]>0).map(x=>({c:x[0],n:x[1]})),total:g+a+r===0?0:g+a+r+n});
  const bars=[];
  bars.push(numericBad?mk('Räkningen',`${numericBad} ${numericBad===1?'beräknad avvikelse':'beräknade avvikelser'} – kontrollera originalet`,0,calcN,numericBad,0):calcUnknown?mk('Räkningen','Ej bedömd – kunde inte kontrolleras',0,0,0,0):mk('Räkningen',calcN?`${calcN} ${calcN===1?'möjlig avvikelse':'möjliga avvikelser'} att jämföra med originalet`:'Inga avvikelser hittades',calcOk,calcN,0,0));
  {const t=rOk+rBad+rAsk,g=cannot.length;bars.push(mk('Prisregler',t||g?`${rOk} av ${t+g} stämmer${rBad?` · ${rBad} stämmer inte`:''}${rAsk?` · ${rAsk} ${rAsk===1?'fråga':'frågor'}`:''}${g?` · ${g} ej bedömda`:''}`:'Ej bedömd – ingen regel kunde kontrolleras',rOk,rAsk,rBad,g));}
  bars.push(mk('Jämförelse med referens',cmp.length?`${cOk} av ${cmp.length} inom intervall${cAsk?` · ${cAsk} ${cAsk===1?'fråga':'frågor'}`:''}${cUnk?` · ${cUnk} ej bedömd${cUnk===1?'':'a'}`:''}`:'Ej bedömd – ingen jämförelse ingick',cOk,cAsk,0,cUnk));
  bars.push(mk('Tydlighet i offerten',statedN+clarifyN?`${statedN} anges i offerten (inte verifierat) · ${clarifyN} att förtydliga`:'Ej bedömd – inget att bedöma',statedN,clarifyN,0,0));
  const scope=[];
  if(!calcUnknown)scope.push('räkningen');
  if(rOk+rBad+rAsk)scope.push(`${rOk+rBad+rAsk} ${rOk+rBad+rAsk===1?'prisregel':'prisregler'}`);
  if(cmp.length-cUnk)scope.push(`${cmp.length-cUnk} ${cmp.length-cUnk===1?'jämförelse':'jämförelser'} med referens`);
  return {tone,mark,title,short,next,ok,bad,attention,unknown,assessed,unknownParts,bars,scope};
}
function renderVerdictCard(result,isDemo,summary){
  const v=verdictModel(result,chosenPath);
  const bars=v.bars.map(b=>{
    const track=b.total?`<div class="gmo-track" aria-hidden="true">${b.segs.map(g=>`<span class="gmo-fill" data-c="${g.c}" data-w="${(100*g.n/b.total).toFixed(2)}"></span>`).join('')}</div>`:`<div class="gmo-track gmo-empty" aria-hidden="true"></div>`;
    return `<div class="gmo-control"><div><span>${escapeHtml(b.label)}</span><strong>${escapeHtml(b.text)}</strong></div>${track}</div>`;
  }).join('');
  const gap=v.unknown>0?`<p class="gmo-gap"><b>Ej bedömt:</b> ${escapeHtml(v.unknownParts.join(', '))} gick inte att bedöma.</p>`:'';
  const scope=`<p class="gmo-scope"><b>Kontrollerat:</b> ${v.scope.length?escapeHtml(v.scope.join(', ')):'ingenting'}.</p>`;
  const tonename={green:'kontrollerat',amber:'förtydliga',red:'avvikelse',grey:'ej bedömt'}[v.tone];
  const cnt=(n,c,glyph,word)=>n>0?`<span data-c="${c}"><i aria-hidden="true">${glyph}</i><strong>${n}</strong>${word}</span>`:'';
  const counts=[cnt(v.ok,'green','✓','stämmer'),cnt(v.bad,'red','×',v.bad===1?'avvikelse':'avvikelser'),cnt(v.attention,'amber','!','att följa upp'),cnt(v.unknown,'grey','–','ej bedömt')].join('');
  return `<section class="gmo-card" data-tone="${v.tone}" aria-label="Resultat: ${tonename}">
  <div class="gmo-verdict"><div class="gmo-mark" aria-hidden="true">${v.mark}</div><div><div class="gmo-eyebrow">Ditt besked${isDemo?' · <span class="tag">Exempel</span>':''}</div><h2>${escapeHtml(v.title)}</h2><p class="gmo-short">${escapeHtml(v.short)}</p></div></div>
  <p class="gmo-counts">${counts||'<span data-c="grey"><i aria-hidden="true">–</i>Inget kunde räknas</span>'}</p>
  ${scope}${gap}
  <div class="gmo-bars" role="group" aria-label="Utfall per kontroll">${bars}</div>
  <div class="gmo-next"><span>NÄSTA STEG</span><p>${escapeHtml(v.next)}</p></div>
  <p class="gmo-foot">Avser det vi kunde kontrollera i offerten. Granskningen bedömer inte hantverkarens arbete och är inget juridiskt utlåtande.</p>
</section>`;
}
function animateBars(){
  const fills=$('res').querySelectorAll('.gmo-fill');
  const go=()=>fills.forEach(f=>{f.style.width=f.dataset.w+'%';});
  if(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches){go();return;}
  requestAnimationFrame(()=>requestAnimationFrame(go));
}

// ---- Övergång gratis → betald jämförelse (kandidat). Visas bara när jämförelsen är öppen enligt serverns config (annars oförändrad gratissida).
// Första offerten följer med efter ett AKTIVT klick som lokal, kortlivad engångshandoff i sessionStorage (aldrig i adressen, aldrig i händelser/loggar). Ingen analys, betalning eller källanrop startas av navigeringen.
const HANDOFF_KEY='sd_handoff_v1',HANDOFF_TTL=30*60*1000,HANDOFF_MAX=4500000;
let cmpOpen=false,cmpPrice='49 kr';
function handoffSweep(){try{const raw=sessionStorage.getItem(HANDOFF_KEY);if(!raw)return;let r=null;try{r=JSON.parse(raw)}catch(e){}if(!r||typeof r.exp!=='number'||Date.now()>r.exp)sessionStorage.removeItem(HANDOFF_KEY);}catch(e){}}
function currentDoc(){
  if(lastIsDemo&&lastResult&&$('res').classList.contains('on'))return null;
  if(pendingFile)return{kind:pendingFile.kind,mediaType:pendingFile.mediaType,dataBase64:pendingFile.dataBase64,filename:pendingFile.filename};
  const t=($('txt').value||'').trim();
  if(!t||t===demoText.trim())return null;
  return{kind:'text',text:t};
}
function putHandoff(doc){
  try{
    const s=JSON.stringify({v:1,at:Date.now(),exp:Date.now()+HANDOFF_TTL,doc});
    if(s.length>HANDOFF_MAX)return false;
    sessionStorage.setItem(HANDOFF_KEY,s);
    if(sessionStorage.getItem(HANDOFF_KEY)!==s){sessionStorage.removeItem(HANDOFF_KEY);return false;}
    return true;
  }catch(e){try{sessionStorage.removeItem(HANDOFF_KEY)}catch(_){}return false;}
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
    <a class="btn acc" id="fkr-go" href="/forkontroll/">Förkontrollera min offert – 49 kr</a>
  </aside>`;
}
function cmpFail(host){
  const old=host.parentNode.querySelector('.cmpfail');if(old)old.remove();
  const b=document.createElement('div');b.className='cmpfail';b.setAttribute('role','alert');b.tabIndex=-1;
  b.innerHTML='<p style="margin:0">Din offert kunde inte följa med till jämförelsen. Webbläsaren tillåter inte tillfällig lagring, eller så är offerten för stor. Du kan gå vidare och lägga in den där igen, eller stanna här.</p><div class="alt"><a class="btn acc" href="/jamfor/">Gå vidare utan offerten</a><button type="button" class="btn ghost" data-stay>Stanna här</button></div>';
  host.parentNode.insertBefore(b,host.nextSibling);
  b.querySelector('[data-stay]').addEventListener('click',()=>{b.remove();host.focus();});
  b.focus();
}
function goCompare(ev){
  const a=ev.currentTarget;
  if(ev.metaKey||ev.ctrlKey||ev.shiftKey||ev.button===1)return; // öppna i ny flik = ren länk utan offert
  ev.preventDefault();
  const doc=currentDoc();
  if(!doc){location.assign('/jamfor/');return;}
  if(putHandoff(doc))location.assign('/jamfor/#fran=gratis');else cmpFail(a);
}
function bindCmp(){document.querySelectorAll('[data-cmp]').forEach(a=>{if(!a.dataset.bound){a.dataset.bound='1';a.addEventListener('click',goCompare);}});}
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

function render(result,isDemo){
  lastResult=result;lastIsDemo=!!isDemo;
  const clarifyN=(result.clarify||[]).length;
  const statedN=(result.stated||[]).length;
  const clarifyWord=clarifyN===1?'sak att förtydliga':'saker att förtydliga';
  const pc=priceCounts(result);
  const priceFrag=priceSummaryFragment(result);
  const summary=`${clarifyN} ${clarifyWord}, ${calcSummaryFragment(result)}${priceFrag}, ${statedN} ${statedN===1?'uppgift som framgår':'uppgifter som framgår'} tydligt.`;

  $('res').innerHTML=`${renderVerdictCard(result,isDemo,summary)}
  <div class="send">
    <a class="btn acc" id="sendmail" href="#">${sendLabel()}</a>
    ${isMobile()?'<a class="btn" id="sendsms" href="#">Skicka som SMS</a>':''}
    <button type="button" class="btn ghost" id="copybtn">Kopiera</button>
  </div>
  <p class="caveat" id="shortnote" hidden>E-post- och SMS-texten är förkortad. Hela listan finns under Kopiera.</p>
  <details class="gmo-all"><summary>Se alla fynd och frågor</summary>
  <div class="summarybox"><p>${escapeHtml(summary)}</p></div>
  ${renderActionList(result,chosenPath)}
  <h3>Motsägelser och räknefel</h3>${renderCalcSection(result)}
  ${chosenPath==='hantverkare'?'':`<h3>Behöver förtydligas</h3>${result.clarify&&result.clarify.length?findingsList(result.clarify,'warn','!'):(fullyAssessed(result)?'<p>Vi hittade inget som sticker ut som otydligt i det vi kontrollerar.</p>':'<p>Inget otydligt hittades i det som kontrollerades, men delar gick inte att bedöma (se nedan).</p>')}`}
  <h3>Prisbild</h3>${renderPriceReport(result)}
  <h3>Uppgifter som framgår (${statedN})</h3>${result.stated&&result.stated.length?findingsList(result.stated,'ok','✓'):'<p>Inga tydliga uppgifter av den här typen hittades i dokumentet.</p>'}
  </details>
  ${chosenPath==='hantverkare'||!cmpOpen?'':cmpCtaHtml(isDemo)}
  ${chosenPath==='hantverkare'&&fkOpen?fkCtaHtml():''}
  <div class="alt">
    <button class="btn ghost" onclick="location.reload()">Granska en till</button>
  </div>
  ${chosenPath==='hantverkare'?`<aside class="fromsd"><p class="fromsd-tag">Från Ståhle Digital</p>
    <p>Har firman ingen hemsida, eller en som inte ger jobb? Vi bygger hemsidor för hantverkare, i hela Sverige.</p>
    <a class="btn" href="https://stahledigital.se" rel="noopener" data-cta="hemsida">Se vad vi gör</a>
    <p class="sub">Ska du räkna material till jobbet? <a href="https://stahledigital.se/verkstaden/materialraknaren" rel="noopener" data-cta="materialraknaren">Materialräknaren är gratis.</a></p>
  </aside>`:''}`;
  const body=exportBody(result,chosenPath);
  const subj=chosenPath==='hantverkare'?'Punkter att förtydliga i offerten':'Frågor om offerten';
  const mail=fitText(body,1900),sms=fitText(body,1200);
  $('sendmail').href='mailto:?subject='+encodeURIComponent(subj)+'&body='+encodeURIComponent(mail.text);
  $('sendmail').addEventListener('click',()=>trackShare('email'));
  if($('sendsms')){$('sendsms').href='sms:?&body='+encodeURIComponent(sms.text);$('sendsms').addEventListener('click',()=>trackShare('sms'));}
  if(mail.cut||($('sendsms')&&sms.cut))$('shortnote').hidden=false;
  $('res').querySelectorAll('[data-cta]').forEach(a=>a.addEventListener('click',()=>sendEvent({type:'client',event:'kontakt_cta',detail:a.dataset.cta})));
  $('res').removeAttribute('aria-busy');
  $('res').classList.add('on');
  $('announce').textContent=(isDemo?'Exempel. ':'Granskningen är klar. ')+summary;
  const h=$('res').querySelector('h2');if(h){h.tabIndex=-1;h.focus({preventScroll:true});}
  animateBars();
  bindCmp();syncCmp();
  if(!isDemo)sendEvent({type:'client',event:'rapport_klar'});

  const copyBtn=$('copybtn');
  copyBtn.onclick=async()=>{
    const text=buildClipboardText(lastResult,chosenPath);
    try{
      await navigator.clipboard.writeText(text);
      trackShare('copy');
      copyBtn.textContent='Kopierat!';
      $('announce').textContent='Texten är kopierad.';
      setTimeout(()=>{copyBtn.textContent='Kopiera';},1800);
    }catch(e){
      showError('Kunde inte kopiera automatiskt — markera och kopiera texten manuellt.');
    }
  };
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

async function runReview(){
  clearError();
  if(!API_BASE){
    showError('Granskningstjänsten är inte påkopplad än (API_BASE saknas i koden). Testa "Prova med en exempeloffert" under tiden.');
    return;
  }
  let payload;
  if(pendingFile){
    payload=pendingFile;
  } else {
    const t=($('txt').value||'').trim();
    if(!t){showError('Klistra in offerttext eller välj en fil först.');return;}
    payload={kind:'text',text:t};
  }
  payload.path=chosenPath;
  payload.stats=!!($('statsopt')&&$('statsopt').checked);
  setLoading(true);
  showSkeleton();
  const avbryt=new AbortController();
  const tidsgrans=setTimeout(()=>avbryt.abort(),120000); // hellre ett ärligt fel än evig väntan
  try{
    const resp=await fetch(API_BASE.replace(/\/$/,'')+'/review',{
      method:'POST',headers:SD_TEST?{'Content-Type':'application/json','X-SD-Test':'1'}:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:avbryt.signal
    });
    const data=await resp.json();
    if(!resp.ok){showError(data.error||'Något gick fel. Försök igen.');return;}
    render(data,false);
  }catch(e){
    if(e&&e.name==='AbortError')showError('Granskningen tog för lång tid. Försök igen, eller klistra in offerttexten i stället för att skicka en bild.');
    else showError('Kunde inte nå granskningstjänsten. Kontrollera din uppkoppling och försök igen.');
  }finally{
    clearTimeout(tidsgrans);
    hideSkeleton();
    setLoading(false);
  }
}

document.querySelectorAll('.pathcard').forEach(el=>{
  el.addEventListener('click',()=>{
    chosenPath=el.dataset.path;
    document.querySelectorAll('.pathcard').forEach(c=>{c.classList.toggle('sel',c===el);c.setAttribute('aria-pressed',c===el?'true':'false');});
    $('pathnote').textContent=PATHNOTE[chosenPath];
    if(lastResult&&$('res').classList.contains('on'))render(lastResult,lastIsDemo);
    syncCmp();
  });
});

$('demo').onclick=()=>{
  pendingFile=null;
  $('txt').value=demoText;$('txt').classList.add('on');$('runwrap').style.display='flex';
  clearError();showSkeleton();
  render(demoResult,true);
};
$('paste').onclick=()=>{pendingFile=null;$('filepreview').classList.remove('on');$('txt').classList.add('on');$('runwrap').style.display='flex';$('txt').focus();};
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

function handleFile(f){
  if(!f)return;
  clearError();
  if(f.type&&f.type.startsWith('image/')){
    forbered(f).then(g=>{
      if(g.size>MAX_BYTES){showError('Bilden är för stor (max 8 MB). Fota med lägre upplösning eller klistra in texten.');return;}
      laddaFil(g);
    });
    return;
  }
  laddaFil(f);
}

function laddaFil(f){
  if(f.size>MAX_BYTES){showError('Filen är för stor (max 8 MB).');return;}
  if(f.type.startsWith('text')||/\.txt$/i.test(f.name)){
    f.text().then(t=>{
      pendingFile=null;
      $('txt').value=t;$('txt').classList.add('on');$('runwrap').style.display='flex';
      $('filepreview').textContent=`Vald fil: ${f.name} (${Math.max(1,Math.round(f.size/1024))} kB). Texten visas nedan – tryck Granska för att starta.`;
      $('filepreview').classList.add('on');
    });
    return;
  }
  const reader=new FileReader();
  reader.onload=()=>{
    const dataUrl=reader.result; // "data:<mime>;base64,XXXX"
    const base64=dataUrl.split(',')[1];
    const kind=f.type==='application/pdf'?'pdf':'image';
    pendingFile={kind,dataBase64:base64,mediaType:f.type,filename:f.name};
    $('txt').classList.remove('on');
    $('filepreview').textContent=`Vald fil: ${f.name} (${Math.round(f.size/1024)} kB). Tryck Granska för att starta.`;
    $('filepreview').classList.add('on');
    $('runwrap').style.display='flex';
  };
  reader.readAsDataURL(f);
}
drop.addEventListener('drop',ev=>handleFile(ev.dataTransfer.files[0]));
$('file').addEventListener('change',ev=>handleFile(ev.target.files[0]));
$('cam').addEventListener('change',ev=>handleFile(ev.target.files[0]));

    return {unmount:function(){dead=true;}};
  }
});
})();
