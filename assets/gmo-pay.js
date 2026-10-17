/* GMO betalcontroller (D19): EN controller för jämförelse (49 kr totalt) och förkontroll (49 kr per offert).
   Order-, återupptagnings- och resultatmotorn är jamfors; förkontrollen är en liten adapter ovanpå samma motor.
   Monteras av GMO.go('compare'|'check') i #task-root. Skapar aldrig order av att monteras – bara av aktiv handling. */
(function(){
'use strict';
var G=window.GMO;
var TEMPLATE_COMPARE=`<p class="hint" id="scopenote">Tjänsten är avsedd för hantverksarbete. Material som ingår i hantverkarens offert omfattas. Materialinköp, produktköp och abonnemang stöds ännu inte.</p>

<div id="receipt" class="receipt hidden" role="status" aria-live="polite" tabindex="-1"></div>
<div id="cfgstate" class="card hidden" role="status" aria-live="polite"></div>
<div id="closed" class="card hidden" role="status"></div>
<div id="err" class="err hidden" role="alert"></div>
<div id="hoconf" class="card hidden" role="region" aria-labelledby="hoconf-h" tabindex="-1"></div>

<!-- STEG 1 -->
<section id="s1" class="hidden" aria-labelledby="h-s1">
  <section class="valuecard" id="value" aria-labelledby="value-h">
    <h2 id="value-h">Det här får du</h2>
    <p class="vprice"><b>49 kr totalt, inkl. moms</b> · engångsköp, ingen prenumeration</p>
    <ul>
      <li>Skillnader i omfattning, pris, moms och ROT sida vid sida, och frågor att ställa till varje hantverkare.</li>
      <li>Före köp ser du vad vi kunde läsa ur dina offerter – det kostar inget. Själva jämförelsen får du efter köpet.</li>
      <li>Ingen rekommendation om vem du ska välja.</li>
    </ul>
    <button type="button" class="btn ghost" id="exbtn" aria-expanded="false" aria-controls="exview">Se ett exempel</button>
    <div id="exview" class="exview hidden" role="region" aria-labelledby="ex-h"></div>
  </section>
  <ol class="steps" aria-label="Steg"><li aria-current="step">1 Offerter</li><li>2 Kontroll</li><li>3 Betala</li><li>4 Resultat</li></ol>
  <h2 id="h-s1">Hur många offerter vill du jämföra?</h2>
  <div class="seg" role="group" aria-label="Antal offerter"><button type="button" data-n="2" aria-pressed="true">2</button><button type="button" data-n="3" aria-pressed="false">3</button><button type="button" data-n="4" aria-pressed="false">4</button></div>
  <div id="carry" class="card hidden" role="region" aria-labelledby="carry-h"></div>
  <div id="slots"></div>
  <p id="slotnote" class="hint hidden" role="status"></p>
  <p class="hint" id="limits"></p>
  <p class="hint privinfo" id="privinfo"></p>
  <label class="chk"><input type="checkbox" id="samejob"><span id="t-samejob">Jag bekräftar att offerterna gäller samma jobb. Annars blir jämförelsen missvisande.</span></label>
  <button type="button" class="btn acc block" id="check">Kontrollera offerterna</button>
  <p class="hint">Kontrollen kostar ingenting. Du betalar först efter att du sett vad som kommer med.</p>
  <p class="hint" id="coverage1"></p>
</section>

<!-- STEG 2-3 -->
<section id="s2" class="hidden" aria-labelledby="h-s2">
  <ol class="steps" aria-label="Steg"><li>1 Offerter</li><li aria-current="step">2 Kontroll</li><li>3 Betala</li><li>4 Resultat</li></ol>
  <h2 id="h-s2">Kontroll</h2>
  <div id="docs" aria-live="polite"></div>
  <div id="offer" class="card acc hidden">
    <div class="price">49 kr <small>inklusive moms (varav <span id="vat">9,80</span> kr moms) · engångsköp</small></div>
    <p class="hint hidden" id="paymethods" data-methods=""></p>
    <p id="draftnote" class="warnbox hidden"><b>Utkast.</b> Villkors- och samtyckestexterna är inte slutgiltiga. Skarp betalning är avstängd tills de är fastställda.</p>
    <p id="coverage" class="hint"></p>
    <div id="gets-wrap"><h3>Det här får du</h3>
    <ul class="tight" id="copy-gets"></ul></div>
    <details id="more-how" open><summary id="more-how-s">Det här får du inte och så går det till</summary>
    <p id="more-limits" class="hint hidden"></p>
    <h3>Det här får du inte</h3>
    <ul class="tight" id="copy-getsnot"></ul>
    <h3>Så går det till</h3>
    <ul class="tight" id="copy-how"></ul>
    </details>
    <div id="srcbox" class="hidden" aria-labelledby="h-src">
      <h3 id="h-src">Omdömen om hantverkarna (valfritt)</h3>
      <p class="hint" id="srcintro">Googles och Trustpilots egna omdömen, visade separat per firma med källans eget urval. De ingår inte i jämförelsen eller rapporten och är ingen bedömning av företaget. Vi bekräftar inte att en källa finns för just din firma – täckningen visas här innan du betalar.</p>
      <div id="preid" class="hidden" aria-live="polite"></div>
      <div id="srcpropPre" aria-live="polite"></div>
      <details id="srcmanual"><summary>Lägg till företag själv (valfritt)</summary><div id="srcform"></div></details><div id="srcfirms" aria-live="polite"></div>
      <ul class="tight" id="srccov"></ul>
    </div>
    <div id="seller" class="hint" aria-label="Säljare"></div>
    <div id="psum" class="card hidden" role="group" aria-labelledby="psum-h"><h3 id="psum-h" style="margin-top:0">Det här köper du</h3><p id="psum-what"></p><p id="psum-done" class="hint"></p><p id="psum-seller" class="hint"></p></div>
    <label for="email" style="display:block;font-weight:600;margin:12px 0 4px">E-postadress för avtalsbekräftelsen</label>
    <input type="email" id="email" autocomplete="email" inputmode="email" maxlength="254" placeholder="namn@exempel.se" aria-describedby="emailhint">
    <p class="hint" id="emailhint">Bekräftelsen med din ångerlänk skickas hit. Adressen används bara för det.</p>
    <details id="terms-more" class="hidden"><summary>Köpvillkor, ångerrätt och företagsuppgifter</summary><p id="angertext"></p><p><a href="/jamfor/villkor/" target="_blank" rel="noopener">Läs de fullständiga köpvillkoren</a></p><div id="seller2" class="hint" aria-label="Företagsuppgifter"></div></details>
    <label class="chk" id="lbl-terms"><input type="checkbox" id="terms"><span id="t-terms"></span> <a href="/jamfor/villkor/" target="_blank" rel="noopener">Läs villkoren</a></label>
    <label class="chk" id="lbl-immediate"><input type="checkbox" id="immediate"><span id="t-immediate"></span></label>
    <label class="chk hidden" id="lbl-decl"><input type="checkbox" id="declaration"><span id="t-decl"></span></label>
    <button type="button" class="btn acc block" id="pay">Betala 49 kr</button>
    <p class="hint hidden" id="pterms"></p>
    <p class="hint">Betalningen sker hos Stripe. Du lämnar sidan och kommer tillbaka hit.</p>
  </div>
</section>

<!-- STEG 4: väntan -->
<section id="s3" class="hidden" aria-labelledby="h-s3">
  <ol class="steps" aria-label="Steg"><li>1 Offerter</li><li>2 Kontroll</li><li>3 Betala</li><li aria-current="step">4 Resultat</li></ol>
  <h2 id="h-s3">Din jämförelse</h2>
  <div id="statusbox" class="card" role="status" aria-live="polite"></div>
  <div id="recovery" class="card hidden">
    <h3 style="margin-top:0">Spara din länk</h3>
    <p class="hint">Med den här länken kommer du tillbaka till resultatet, även om du stänger fliken. Den fungerar i 24 timmar. Dela den inte – den ger åtkomst till din jämförelse.</p>
    <p class="mono" id="reclink"></p>
    <button type="button" class="btn ghost" id="copylink">Kopiera länk</button>
  </div>
</section>

<!-- RAPPORT -->
<section id="rep" class="hidden" aria-labelledby="h-rep"></section>

<footer><p>Jämför mina offerter är en tjänst från Ståhle Digital. Beloppen är avlästa ur dokumenten och kan innehålla avläsningsfel. Det som inte framgår av en offert är inte detsamma som att det saknas. <a href="/jamfor/angra/" id="ftbuy">Ångra ett köp</a> · <a class="fu" href="/foretagsuppgifter">Företagsuppgifter</a></p></footer>
`;
var TEMPLATE_CHECK=`<div id="receipt" class="receipt hidden" role="status" aria-live="polite" tabindex="-1"></div>
<div id="cfgstate" class="card hidden" role="status" aria-live="polite"></div>
<div id="closed" class="card hidden" role="status"></div>
<div id="err" class="err hidden" role="alert"></div>
<div id="guard" class="warnbox hidden" role="status"></div>

<section id="s1" class="hidden" aria-labelledby="h-s1">
  <section class="valuecard" id="value" aria-labelledby="value-h">
    <h2 id="value-h">Det här får du</h2>
    <p class="vprice"><b>49 kr per offert, inkl. moms</b> · engångsköp, ingen prenumeration</p>
    <ul>
      <li>Din egen offert kontrollerad före utskick: moms, ROT-underlag, pristyp, omfattning och tid, och frågor som en kund sannolikt ställer.</li>
      <li>Efter att du själv bekräftat uppgifterna: färdiga tilläggstexter och en PDF-bilaga till kunden med samma uppgifter.</li>
      <li>Inget läggs till som du inte bekräftat. Din originaloffert ändras aldrig.</li>
    </ul>
    <button type="button" class="btn ghost" id="exbtn" aria-expanded="false" aria-controls="exview">Se ett exempel</button>
    <div id="exview" class="exview hidden" role="region" aria-labelledby="ex-h"></div>
  </section>
  <ol class="steps" aria-label="Steg"><li aria-current="step">1 Din offert</li><li>2 Betala</li><li>3 Resultat</li></ol>
  <h2 id="h-s1">Ladda upp din offert</h2>
  <div class="card">
    <label class="t" for="f0" style="margin-top:0">Fil (PDF, foto eller text)</label>
    <input type="file" id="f0" accept=".pdf,image/*,.txt" aria-label="Fil med din offert">
    <p class="hint" id="fi0">Ingen fil vald.</p>
    <label class="t" for="t0">…eller klistra in offertens text</label>
    <textarea id="t0" placeholder="Klistra in texten ur din offert här"></textarea>
    <p class="hint" id="limits">Högst ett dokument. Samma regler som i jämförelsen: PDF, foto eller text.</p>
  </div>
  <p class="hint privinfo" id="privinfo"></p>
  <label class="chk"><input type="checkbox" id="samejob"><span id="t-samejob">Jag bekräftar att offerten är min egen och att jag får ladda upp den.</span></label>
  <button type="button" class="btn acc block" id="go">Fortsätt</button>
  <p class="hint">Du betalar först i nästa steg. Din originaloffert ändras aldrig och raderas hos oss efter 24 timmar.</p>
</section>

<section id="s2" class="hidden" aria-labelledby="h-s2">
  <ol class="steps" aria-label="Steg"><li>1 Din offert</li><li aria-current="step">2 Betala</li><li>3 Resultat</li></ol>
  <h2 id="h-s2">Det här köper du</h2>
  <div id="docs"></div>
  <div class="card acc">
    <div class="price" id="price">49 kr<small>inklusive moms, engångsköp, ingen prenumeration</small></div>
    <p id="what"></p>
    <h3>Det här får du</h3><ul class="tight" id="copy-gets"></ul>
    <h3>Det här får du inte</h3><ul class="tight" id="copy-getsnot"></ul>
    <details><summary>Så går det till</summary><ul class="tight" id="copy-how"></ul></details>
    <p class="hint" id="coverage"></p>
  </div>
  <div id="draftnote" class="warnbox hidden">Utkast: villkorstexterna är inte slutgiltiga.</div>
  <details class="card"><summary>Köpvillkor, ångerrätt och företagsuppgifter</summary><div id="termsbox"></div></details>
  <div id="seller" class="hint" aria-label="Säljare"></div>
  <label for="email" style="display:block;font-weight:600;margin:12px 0 4px">E-postadress för kvitto och avtalsbekräftelse</label>
  <input type="email" id="email" autocomplete="email" inputmode="email" maxlength="254" placeholder="namn@exempel.se">
  <p class="hint">Kvitto, avtal och din förkontroll skickas hit. Adressen används bara för det.</p>
  <label class="chk"><input type="checkbox" id="declaration"><span id="t-decl"></span></label>
  <button type="button" class="btn acc block" id="pay" disabled>Betala 49 kr</button>
  <p class="hint">Betalningen sker hos Stripe. Du lämnar sidan och kommer tillbaka till resultatet.</p>
  <button type="button" class="btn ghost" id="restart">Byt offert</button>
</section>

<!-- STEG 4: väntan -->
<section id="s3" class="hidden" aria-labelledby="h-s3">
  <ol class="steps" aria-label="Steg"><li>1 Offerter</li><li>2 Kontroll</li><li>3 Betala</li><li aria-current="step">4 Resultat</li></ol>
  <h2 id="h-s3">Din jämförelse</h2>
  <div id="statusbox" class="card" role="status" aria-live="polite"></div>
  <div id="recovery" class="card hidden">
    <h3 style="margin-top:0">Spara din länk</h3>
    <p class="hint">Med den här länken kommer du tillbaka till resultatet, även om du stänger fliken. Den fungerar i 24 timmar. Dela den inte – den ger åtkomst till din jämförelse.</p>
    <p class="mono" id="reclink"></p>
    <button type="button" class="btn ghost" id="copylink">Kopiera länk</button>
  </div>
</section>

<!-- RAPPORT -->
<section id="rep" class="hidden" aria-labelledby="h-rep"></section>

<footer><p>Förkontroll av min offert är en tjänst från Ståhle Digital. Beloppen är avlästa ur dokumentet och kan innehålla avläsningsfel. Den bedömer inte kvalitet eller om priset är rimligt och är inte juridisk rådgivning. <a href="/jamfor/">Jämför 2–4 offerter</a></p></footer>
`;
function mountPay(root,ctx){
  var KIND=ctx.task==='check'?'check':'compare';
  root.innerHTML=KIND==='check'?TEMPLATE_CHECK:TEMPLATE_COMPARE;
  var dead=false,cleanups=[];

var $=G.$,el=G.el,show=G.show,store=G.store,kr=G.kr,api=G.api;
var wsC=G.ws.compare;
// Arbetsytan (G.ws.compare) bär underlag, namn och antal mellan monteringar; ordern själv ligger alltid på servern/localStorage.
var state = {n:wsC.n, slots:wsC.slots, order:null, cfg:null, timer:null, busy:0};
function err(msg){var b=$('err');if(!b)return;b.textContent=msg||'';show('err',!!msg);if(msg)b.scrollIntoView({block:'nearest'})}
function busy(on,why){state.busy+=on?1:-1;if(state.busy<0)state.busy=0;G.setBusy(on,why)}
function later(fn,ms){return setTimeout(function(){if(!dead)fn()},ms)}
// Mätning (D19, worker/MATNING.md): slutna enum, aldrig innehåll/ID/URL. product följer alltid sidans uppgift.
function mEv(name,f){try{G.measure.event(name,Object.assign({product:KIND},f||{}))}catch(e){}}
function mErr(reason,stage){mEv('client_error',{stage:stage||'submit',reason:reason})}
function mbOf(n){return (Math.round(n/1e5)/10).toFixed(1).replace('.',',').replace(/,0$/,'')}
function mResult(id,mode){var k='rv_'+id;if(G.measure.seen[k])return;G.measure.seen[k]=1;mEv('result_view',{stage:'result',mode:mode||'resume'})}
function methodOfSlots(list){var h=false,f=false,t=false;list.forEach(function(s){if(!s)return;if(s.from==='free')h=true;else if(s.file)f=true;else if(s.text&&s.text.trim())t=true});return h?'handoff':f?'file':t?'text':'unknown'}
function slotReady(s){return !!(s&&((s.text&&s.text.trim())||s.file))}
// input_ready = faktisk övergång till giltig aktuell inmatning (en gång per övergång); inputs_ready = alla aktiva platser klara (en gång per övergång).
function slotErr(i,msg){var e=$('se'+i);if(!e)return;e.textContent=msg||'';e.classList.toggle('hidden',!msg)}
function noteReady(i,method){
  var s=state.slots[i];if(!s)return;slotErr(i,'');
  var r=slotReady(s);
  if(r&&!s.readyFired){s.readyFired=true;mEv('input_ready',{method:method||'unknown',stage:'input'})}
  if(!r)s.readyFired=false;
  var all=state.n>=2;for(var j=0;j<state.n;j++)if(!slotReady(state.slots[j]))all=false;
  if(all&&!wsC.allFired){wsC.allFired=true;mEv('inputs_ready',{stage:'input'})}
  if(!all)wsC.allFired=false;
}
function limitsOf(){var l=(state.cfg&&state.cfg.limits)||{};return {file:l.maxFileBytes||8000000,total:l.maxTotalBytes||20000000}}

// ---------- start ----------
// Config-service (G.config): laddar → tillfälligt fel (Försök igen, utkastet kvar) → serverbekräftat stängt → öppet. Läsande återupptagning
// och resultatlänkar väntar aldrig på att köp ska vara öppet.
async function cfgSoft(){var C=await G.config.load();if(!dead){state.cfg=C.cfg;footerInfoLink(C.cfg)}return C}
function cfgCard(kind,title,text,btn){
  var c=$('cfgstate');if(!c)return;c.textContent='';
  c.setAttribute('data-cfg',kind);c.appendChild(el('h2',{text:title}));if(text)c.appendChild(el('p',{text:text}));
  if(btn)c.appendChild(btn);
  show('cfgstate',true);
}
// ---------- märkt syntetiskt exempel (read-only): inga anrop, ingen order, rör aldrig egna inmatningar ----------
function exTable(head,rows){
  var t=el('table',{});
  t.appendChild(el('caption',{class:'srconly-cap',text:'Exempel: skillnader mellan två påhittade offerter'}));
  var th=el('tr',{});head.forEach(function(h){th.appendChild(el('th',{scope:'col',text:h}))});
  t.appendChild(el('thead',{},th));
  var tb=el('tbody',{});
  rows.forEach(function(r){var tr=el('tr',{});tr.appendChild(el('th',{scope:'row',text:r[0]}));for(var i=1;i<r.length;i++)tr.appendChild(el('td',{text:r[i]}));tb.appendChild(tr)});
  t.appendChild(tb);return t;
}
function exampleCompare(){
  var b=el('div',{});
  b.appendChild(el('span',{class:'extag',text:'Exempel'}));
  b.appendChild(el('h3',{id:'ex-h',text:'Så kan en jämförelse se ut'}));
  b.appendChild(el('p',{class:'hint',text:'Påhittade uppgifter. Ingen riktig offert, ingen order, inget AI-anrop och ingen betalning.'}));
  b.appendChild(exTable(['','Byggfirma Exempel AB','Snickeri Exempel'],[
    ['Totalpris','118 000 kr inkl. moms','96 000 kr exkl. moms'],
    ['Momsbas','Inkl. moms','Exkl. moms – jämförs först efter omräkning'],
    ['Rivning och bortforsling','Ingår','Ingår inte'],
    ['Material','Ingår','Ingår'],
    ['Resor','Ingår','Framgår inte'],
    ['Betalning','30 dagar efter slutfört arbete','50 % i förskott']]));
  b.appendChild(el('h3',{text:'Frågor att ställa'}));
  var ul=el('ul',{class:'exq'});
  ['Byggfirma Exempel AB: Vilken garanti gäller på arbetet?','Snickeri Exempel: Ingår bortforsling av rivningsmaterial, och är 96 000 kr exklusive moms?','Snickeri Exempel: Vad omfattar förskottet på 50 %, och hur skyddas det?'].forEach(function(t){ul.appendChild(el('li',{text:t}))});
  b.appendChild(ul);
  b.appendChild(el('p',{class:'exnote',text:'Lägsta belopp visas bara när offerterna går att jämföra, och säger inget om kvalitet. Ingen automatisk vinnare.'}));
  return b;
}
function exampleCheck(){
  var b=el('div',{});
  b.appendChild(el('span',{class:'extag',text:'Exempel'}));
  b.appendChild(el('h3',{id:'ex-h',text:'Så kan en förkontroll se ut'}));
  b.appendChild(el('p',{class:'hint',text:'Påhittade uppgifter. Ingen riktig offert, ingen order, inget AI-anrop och ingen betalning.'}));
  var ul=el('ul',{class:'st-rows'});
  ul.appendChild(G.stRow('stated','Moms','Priset anges inklusive moms.'));
  ul.appendChild(G.stRow('ok','ROT-underlag','ROT-avdraget 12 000 kr är 30 % av arbetskostnaden 40 000 kr inklusive moms.'));
  ul.appendChild(G.stRow('ask','Pristyp','Offerten säger inte om priset är fast, ungefärligt eller löpande. Din kund kommer att fråga.'));
  ul.appendChild(G.stRow('ask','Tid','Inget startdatum eller ungefärlig period anges.'));
  ul.appendChild(G.stRow('unknown','Garanti','Framgår inte av offerten och förblir okänt tills du själv fyller i det.'));
  b.appendChild(ul);
  b.appendChild(el('h3',{text:'Efter din bekräftelse'}));
  b.appendChild(el('p',{class:'exnote',text:'Du får färdiga tilläggstexter att klistra in i offerten och en PDF-bilaga till kunden med exakt de uppgifter du bekräftat. Inget läggs till som du inte bekräftat.'}));
  return b;
}
function wireExample(){
  var btn=$('exbtn'),box=$('exview');if(!btn||!box)return;
  function close(focus){box.classList.add('hidden');box.textContent='';btn.setAttribute('aria-expanded','false');btn.textContent='Se ett exempel';if(focus){try{btn.focus()}catch(e){}}}
  btn.addEventListener('click',function(){
    if(!box.classList.contains('hidden')){close(true);return}
    box.textContent='';box.appendChild(KIND==='check'?exampleCheck():exampleCompare());
    var a=el('div',{class:'actions'});var c=el('button',{type:'button',class:'btn ghost',id:'exclose',text:'Stäng exemplet'});c.addEventListener('click',function(){close(true)});a.appendChild(c);box.appendChild(a);
    box.classList.remove('hidden');btn.setAttribute('aria-expanded','true');btn.textContent='Dölj exemplet';
    G.measure.demoSeen=true;G.measure.event('example_view',{product:KIND});
  });
}
// Kvitto efter aktiv överföring från en annan uppgift (G.transfer): säger exakt vad som följde med, eller varför inget gjorde det.
function showReceipt(){
  if(G.ws.closedDraft===KIND&&$('receipt')){G.ws.closedDraft=null;var cb=$('receipt');cb.textContent='';cb.appendChild(el('p',{},el('b',{text:'Utkastet är avslutat. '}),'Det som laddats upp till tjänsten är raderat och inget har debiterats. Det du lagt in här ligger kvar.'));cb.setAttribute('data-kind','closed');show('receipt',true);return}
  var r=G.ws.receipt;if(!r||r.to!==KIND||!$('receipt'))return;
  G.ws.receipt=null;
  var b=$('receipt');b.textContent='';
  var where=KIND==='check'?'i fältet för din offert':'som Offert 1';
  if(r.status==='copied'){
    b.appendChild(el('p',{},el('b',{text:'Din offert följde med. '}),r.what==='text'?'Texten från gratisgranskningen ligger '+where+'. ':'Filen ”'+r.what+'” från gratisgranskningen ligger '+where+'. ','Den finns kvar i gratisgranskningen också. Inget har skickats, analyserats eller debiterats.'));
  }else if(r.status==='occupied'){
    b.appendChild(el('p',{},el('b',{text:'Din offert följde inte med. '}),r.why==='order'?'Du har en påbörjad order här, och den är orörd. ':'Det finns redan underlag här, och inget skrevs över. ','Lägg in offerten här själv om du vill ha den med. Gratisgranskningen är oförändrad.'));
  }else{
    return;
  }
  b.setAttribute('data-kind',r.status);
  show('receipt',true);
}
// En påbörjad order i målet är orörd: ett kvitto som sa att offerten följde med rättas till sanningen.
function receiptProtected(){
  var b=$('receipt');if(!b||b.getAttribute('data-kind')!=='copied')return;
  b.textContent='';b.setAttribute('data-kind','occupied');
  b.appendChild(el('p',{},el('b',{text:'Din offert följde inte med in i den påbörjade ordern. '}),'Den ligger kvar i minnet och används först om du själv börjar om här. Ordern är orörd, och gratisgranskningen är oförändrad.'));
}
async function init(){
  var rl=readResultLink(); // personlig rapportlänk (#o=…&r=…): bara läsning av rapporten, sparas aldrig
  if(rl){await cfgSoft();if(dead)return;return showResultLink(rl.id,rl.token)}
  var rec=readRecovery();
  var fromFree=/(^|[#&])fran=gratis(&|$)/.test(location.hash);
  var qo=returnOrderId();
  if(qo&&(!rec||rec.id!==qo)){await cfgSoft();if(dead)return;return showOrderMismatch(qo,rec)} // betalningens order ≠ sparad order: byt aldrig tyst, visa tydligt
  if(KIND==='check')return initCheck(rec);
  if(rec){await cfgSoft();if(dead)return;state.order=rec;show('s3',true);if(fromFree)hoConflict();return resume()}
  return openNew(fromFree);
}
// Ny jämförelse: kräver config. Nätfel/timeout/HTTP/JSON-fel ger "Försök igen" med utkastet kvar; bara ett serverbekräftat stängt läge visar "inte öppen än".
async function openNew(fromFree){
  cfgCard('loading','Laddar jämförelsen…','',null);$('cfgstate').setAttribute('aria-busy','true');
  var C=await G.config.load();
  if(dead)return;
  $('cfgstate').removeAttribute('aria-busy');
  if(C.state!=='ok'){
    var rb=el('button',{type:'button',class:'btn acc',id:'cfg-retry',text:'Försök igen'});
    mErr(C.reason==='timeout'?'timeout':C.reason==='network'?'network':'server','config');
    rb.addEventListener('click',function(){rb.disabled=true;cfgCard('loading','Försöker igen…','',null);G.config.retry().then(function(){if(!dead)openNew(fromFree)})});
    cfgCard('failed','Vi kunde inte nå tjänsten just nu','Det här betyder inte att jämförelsen är stängd. Det du har lagt in finns kvar. Inget har skickats och inget har debiterats.',rb);
    var off=G.config.subscribe(function(c){if(c.state==='ok'&&!dead&&$('cfgstate')&&$('cfgstate').getAttribute('data-cfg')==='failed'){off();openNew(fromFree)}});cleanups.push(off);
    return;
  }
  show('cfgstate',false);
  var cfg=C.cfg;state.cfg=cfg;footerInfoLink(cfg);
  if(!cfg.enabled||!cfg.accepting){
    var c=$('closed');c.textContent='';
    c.appendChild(el('h2',{text:'Jämförelsen är inte öppen än'}));
    c.appendChild(el('p',{text:'Vi bygger den fortfarande. Under tiden kan du granska en offert i taget gratis.'}));
    c.appendChild(el('a',{class:'btn acc',href:'/#gratis','data-gmo-task':'free',text:'Granska en offert gratis'}));
    show('closed',true);return;
  }
  (function(){var pm=cfg.payment||{},n=$('paymethods');if(n){n.textContent=pm.swish&&pm.swishNote?pm.swishNote:'';n.setAttribute('data-methods',(pm.methods||['card']).join(','));n.classList.toggle('hidden',!(pm.swish&&pm.swishNote))}})();
  $('vat').textContent=(Math.round(cfg.offer.priceOre*cfg.offer.vatPct/(100+cfg.offer.vatPct))/100).toFixed(2).replace('.',',');
  $('limits').textContent='Varje fil får vara högst '+Math.round(cfg.limits.maxFileBytes/1e6)+' MB (PDF, foto eller text), PDF högst ca '+cfg.limits.maxPdfPagesPerDoc+' sidor. Tillsammans högst '+Math.round(cfg.limits.maxTotalBytes/1e6)+' MB. Ta gärna bara sidorna med pris och villkor.';
  fillCopy(cfg);
  syncSeg();buildSlots();show('s1',true);
  $('samejob').checked=!!wsC.samejob;$('samejob').addEventListener('change',function(){wsC.samejob=$('samejob').checked});
  if(fromFree)hoApply();
}
function syncSeg(){document.querySelectorAll('.seg button').forEach(function(x){x.setAttribute('aria-pressed',String(Number(x.dataset.n)===state.n))})}
// Gammal order som inte finns (404) eller gått ut: den skrivs inte över, den är redan borta. Den väntande första offerten från gratissidan tas då upp explicit.
function startFreshFromGone(why){
  // En saknad sparad order får inte blockera väntande underlag: antingen en äldre sessionsöverlämning eller underlag som följt med i minnet (A2).
  var ho=hoRead().state==='ok',s0=wsC.slots[0],carriedWs=!!(s0&&(s0.file||(s0.text&&s0.text.trim())));
  if(!ho&&!carriedWs)return false;
  var cfg=state.cfg;if(!cfg||!cfg.enabled||!cfg.accepting)return false;
  clearTimeout(state.timer);store('jamfor_order',null);state.order=null;
  ['s3','hoconf','recovery'].forEach(function(id){show(id,false)});$('statusbox').textContent='';
  fillCopy(cfg);buildSlots();show('s1',true);
  if(ho)hoApply();
  if(ho){var b=$('carry');if(b&&why){var n=el('p',{class:'hint',id:'carry-why',text:why});b.insertBefore(n,b.firstChild.nextSibling)}}
  else if(why){var rc=$('receipt');if(rc){rc.textContent='';rc.setAttribute('data-kind','copied');rc.appendChild(el('p',{},el('b',{text:'Din offert följde med. '}),why,' Den ligger som Offert 1. Inget har skickats, analyserats eller debiterats.'));show('receipt',true)}}
  return true;
}
function fillList(id,items){var u=$(id);u.textContent='';(items||[]).forEach(function(t){u.appendChild(el('li',{text:t}))})}
function fillCopy(cfg){
  var c=cfg.offerCopy||{},t=(cfg.consent&&cfg.consent.texts)||{};
  fillList('copy-gets',c.gets);fillList('copy-getsnot',c.getsNot);fillList('copy-how',c.how);
  $('t-terms').textContent=t.terms||'';$('t-immediate').textContent=t.immediate||'';if(t.sameJob)$('t-samejob').textContent=t.sameJob;
  state.cfg=cfg;var P=isP(cfg);if($('emailhint'))$('emailhint').textContent=P?'Kvitto och avtalsbekräftelse skickas hit.':'Bekräftelsen med din ångerlänk skickas hit. Adressen används bara för det.';
  var secs=(cfg.terms&&Array.isArray(cfg.terms.sections))?cfg.terms.sections:[],ag=secs.filter(function(x){return x.id==='angerratt'})[0];
  $('angertext').textContent=(P&&ag&&ag.text)||'';show('terms-more',!!(P&&ag&&ag.text));
  $('t-decl').textContent=t.declaration||'';
  show('lbl-immediate',!P);show('lbl-terms',!P);show('lbl-decl',P);show('seller',!P);show('pterms',P);show('psum',P);
  var mh=$('more-how'),ms=$('more-how-s');if(mh){mh.open=!P;if(ms)ms.textContent=P?'Läs mer: vad som ingår, vad som inte ingår, begränsningar och hur det går till':'Det här får du inte och så går det till';var gw=$('gets-wrap');if(gw){if(P)mh.insertBefore(gw,$('more-limits'));else mh.parentNode.insertBefore(gw,mh)}show('coverage',!P)}
  fillPSum(cfg,t);
  ['immediate','terms','declaration'].forEach(function(id){$(id).checked=false}); // aldrig förkryssade
  $('pay').textContent=payLabel();syncPay();
  $('coverage').textContent=$('coverage1').textContent=(cfg.dataCoverage&&cfg.dataCoverage.text)||'';
  show('draftnote',!!(cfg.consent&&cfg.consent.draft));
  fillSeller(cfg);
}
// Köpsammanfattningen byggs mot ORDERNS faktiska antal dokument (state.docCount: sätts när ordern skapas och vid återupptagning), aldrig mot ett gammalt knappval.
function psumLines(cfg,t,n){
  var secs=(cfg.terms&&Array.isArray(cfg.terms.sections))?cfg.terms.sections:[],sl=secs.filter(function(x){return x.id==='saljare'})[0];
  var first=sl&&typeof sl.text==='string'?String(sl.text).split('\n')[0]:'';
  return {
    what:'Du köper en jämförelse av '+n+' hantverkarofferter för samma jobb: en rapport som visar vad som ingår, pris och villkor sida vid sida, med frågor att ställa. Pris: 49 kr inklusive moms, engångsköp, ingen prenumeration. '+((cfg.dataCoverage&&cfg.dataCoverage.text)||''),
    limits:'Begränsningar: ingen bedömning av hantverkare, kvalitet eller om priset är rimligt. Det som inte framgår av en offert är inte detsamma som att det saknas. Källtäckningen för dina firmor visas innan du betalar.',
    done:(t.fulfilmentDef||'')+' Kvitto och avtalsbekräftelse med alla villkor skickas till din e-post.',
    seller:first?first+'. Fullständiga företagsuppgifter och köpvillkor finns i köpvillkoren (länk nedan).':''
  };
}
function termsSentence(t,id){
  var pt=el('p',{class:'hint',id:id}),tt=t.terms||'',i=tt.indexOf('köpvillkoren'),a=el('a',{href:'/jamfor/villkor/',target:'_blank',rel:'noopener'});
  if(i>=0){a.textContent='köpvillkoren';pt.appendChild(document.createTextNode(tt.slice(0,i)));pt.appendChild(a);pt.appendChild(document.createTextNode(tt.slice(i+'köpvillkoren'.length)))}else{a.textContent='Köpvillkor';pt.appendChild(document.createTextNode(tt+' '));pt.appendChild(a)}
  return pt;
}
function fillPSum(cfg,t){
  if(!isP(cfg))return;
  var L=psumLines(cfg,t,state.docCount||state.n);
  $('psum-what').textContent=L.what;var ml=$('more-limits');if(ml){ml.textContent=L.limits;ml.classList.remove('hidden')}$('psum-done').textContent=L.done;$('psum-seller').textContent=L.seller;
  var old=$('pterms'),np=termsSentence(t,'pterms');np.className=old.className;old.parentNode.replaceChild(np,old);
}
function refreshPSum(){var cfg=state.cfg;if(cfg&&isP(cfg))fillPSum(cfg,(cfg.consent&&cfg.consent.texts)||{})}
// Säljaruppgifter direkt i kassan: exakt samma rader som ingår i villkorssnapshoten och bekräftelsen (serverns avsnitt "saljare"). textContent, aldrig HTML.
function safeInfoUrl(u){try{var x=new URL(String(u||''));return x.protocol==='https:'&&!x.username&&!x.password?x.href:''}catch(e){return ''}}
function fillSeller(cfg){
  var box=$('seller');if(!box)return;box.textContent='';var b2=$('seller2');if(b2)b2.textContent='';
  var secs=(cfg.terms&&Array.isArray(cfg.terms.sections))?cfg.terms.sections:[];var s=null;
  for(var i=0;i<secs.length;i++){if(secs[i]&&secs[i].id==='saljare'){s=secs[i];break}}
  if(!s||typeof s.text!=='string')return;
  box.appendChild(el('b',{text:'Du köper av'}));
  s.text.split('\n').forEach(function(l){box.appendChild(el('div',{text:l}))});
  if(b2){b2.appendChild(el('b',{text:'Du köper av'}));s.text.split('\n').forEach(function(l){b2.appendChild(el('div',{text:l}))})}
}
// Kort, sann och produktspecifik information före överföring (PRIVACY-01) + vem som driver tjänsten (IDENTITY-01), enbart ur serverns befintliga config/villkorssnapshot.
// Inga nya löften (inget om träning, maskering eller att något aldrig lagras); detaljerna ligger i villkoren och Ståhle Digitals integritetspolicy.
function fillPrivacy(cfg){
  var p=$('privinfo');if(!p||!cfg)return;
  var off=KIND==='check'?(cfg.check&&cfg.check.offer):cfg.offer,hrs=(off&&off.retentionHours)||24,sel=(cfg.terms&&cfg.terms.seller)||{};
  p.textContent='';
  if(KIND==='check')p.appendChild(document.createTextNode('När du trycker Fortsätt skickas din offert till vår tjänst och läses av AI (Anthropic Claude). Till skillnad från gratisgranskningen lagras den hos oss, så att du kan komma tillbaka till resultatet: filen, avläsningen och resultatet raderas '+hrs+' timmar efter leverans, eller direkt när du själv raderar eller avslutar utkastet. Personnummer behövs inte i en offert. Betalningen hanteras av Stripe. '));
  else p.appendChild(document.createTextNode('När du trycker Kontrollera skickas dina offerter till vår tjänst och läses av AI (Anthropic Claude). Till skillnad från gratisgranskningen lagras de hos oss, så att du kan komma tillbaka till resultatet: filer, avläsning och rapport raderas '+hrs+' timmar efter leverans (ett utkast du inte köper raderas '+hrs+' timmar efter att det skapades), eller direkt när du själv raderar eller avslutar utkastet. Personnummer behövs inte i en offert. Betalningen hanteras av Stripe. '));
  p.appendChild(el('a',{href:'/jamfor/villkor/#personuppgifter',target:'_blank',rel:'noopener',text:'Mer om dina uppgifter'}));
  // Platshållare i [hakparentes] (ej ifyllda uppgifter) visas aldrig som fakta.
  var okTxt=function(v){return typeof v==='string'&&v.trim()&&v.charAt(0)!=='['?v.trim():''};
  var nm=okTxt(sel.name),ow=okTxt(sel.owner);
  var who=nm?(nm+(sel.form==='ENSKILD'?' (enskild firma'+(ow?', ägare '+ow:'')+')':'')):'Ståhle Digital';
  var email=okTxt(sel.email)&&/^[^\s@<>]+@[^\s@<>]+$/.test(sel.email)?sel.email:'';
  p.appendChild(document.createTextNode(' Tjänsten säljs av '+who+(email?', kontakt '+email:'')+'. '));
  p.appendChild(el('a',{href:'/foretagsuppgifter/',text:'Företagsuppgifter'}));p.appendChild(document.createTextNode('.'));
}
function footerInfoLink(cfg){fillPrivacy(cfg);var fb=$('ftbuy');if(fb&&isP(cfg)){fb.href='/jamfor/kop/';fb.textContent='Köp, villkor och hjälp'} var u=cfg&&cfg.terms&&cfg.terms.seller&&safeInfoUrl(cfg.terms.seller.infoUrl);if(u){document.querySelectorAll('a.fu').forEach(function(a){a.href=u})}}
// Orderns id i betalningens returadress (?order=…). Ingen åtkomstnyckel finns där; den används bara för att upptäcka att sparad order är en annan.
function returnOrderId(){var v=new URLSearchParams(location.search).get('order');return /^o_[0-9a-f]{32}$/.test(v||'')?v:null}
function shortId(id){return String(id).slice(2,10).toUpperCase()}
function parseRecoveryInput(txt){
  var m=/[#&]?o=(o_[0-9a-f]{32})&t=([A-Za-z0-9_-]{32})/.exec(String(txt||''));
  return m?{id:m[1],token:m[2]}:null;
}
function showOrderMismatch(qo,rec){
  show('s1',false);show('s2',false);show('s3',true);clearTimeout(state.timer);
  var box=$('statusbox');box.textContent='';
  box.appendChild(el('p',{text:'Du kom tillbaka från en betalning för jämförelse '+shortId(qo)+', men '+(rec?'den här webbläsaren har en annan jämförelse sparad ('+shortId(rec.id)+')':'den här webbläsaren har ingen åtkomstnyckel sparad för den')+'. Vi byter inte jämförelse automatiskt – en jämförelse öppnas bara med sin egen återställningslänk.'}));
  box.appendChild(el('p',{class:'hint',text:'Betalningen påverkas inte. Klistra in återställningslänken för jämförelse '+shortId(qo)+' (den som slutar på #o=…&t=…) för att öppna den.'}));
  var inp=el('input',{type:'text',id:'mmlink',autocomplete:'off',spellcheck:'false','aria-label':'Återställningslänk','style':'width:100%;box-sizing:border-box'});
  var msg=el('p',{class:'hint',id:'mmmsg',role:'alert'});
  var go=el('button',{type:'button',class:'btn acc',id:'mmopen',text:'Öppna jämförelse '+shortId(qo)});
  go.addEventListener('click',function(){
    var p=parseRecoveryInput(inp.value);
    if(!p){msg.textContent='Det där är ingen återställningslänk. Den ska innehålla #o=…&t=….';return}
    if(p.id!==qo){msg.textContent='Länken hör till en annan jämförelse ('+shortId(p.id)+'), inte till '+shortId(qo)+'.';return}
    store('jamfor_order',JSON.stringify(p));history.replaceState(null,'',location.pathname+location.search);
    state.order=p;box.textContent='';show('s3',true);resume();
  });
  box.appendChild(inp);box.appendChild(go);box.appendChild(msg);
  if(rec){
    var keep=el('button',{type:'button',class:'btn ghost',id:'mmkeep',text:'Visa den sparade jämförelsen ('+shortId(rec.id)+')'});
    keep.addEventListener('click',function(){state.order=rec;box.textContent='';resume()});
    box.appendChild(keep);
  }
}
function readResultLink(){
  var p=new URLSearchParams(location.hash.replace(/^#/,''));var o=p.get('o'),r=p.get('r');
  if(p.get('t')||!/^o_[0-9a-f]{32}$/.test(o||'')||!/^[A-Za-z0-9_-]{32}$/.test(r||''))return null;
  try{history.replaceState(null,'',location.pathname+location.search)}catch(e){}
  return {id:o,token:r};
}
async function showResultLink(id,tok){
  show('s1',false);show('s2',false);show('s3',true);
  var box=$('statusbox');box.textContent='';box.appendChild(el('p',{text:'Hämtar din jämförelse…'}));
  var rr;try{rr=await api('GET','/compare/orders/'+id+'/report',{token:tok})}catch(e){box.textContent='';box.appendChild(el('p',{text:'Kunde inte nå tjänsten just nu. Ladda om sidan om en stund.'}));return}
  if(rr.status===200&&rr.json.report){show('s3',false);renderReport(rr.json.report,{id:id,readOnly:true,sourceLive:rr.json.sourceLive});return}
  box.textContent='';
  box.appendChild(el('p',{text:rr.status===409?'Jämförelsen är inte klar än. Försök igen om en stund.':rr.status===410?'Rapporten har gått ut och är raderad (den sparas i 24 timmar).':'Länken är ogiltig eller har gått ut. Rapporten sparas i 24 timmar efter leverans.'}));
}
function readRecovery(){
  var p=new URLSearchParams(location.hash.replace(/^#/,''));var o=p.get('o'),t=p.get('t');
  if(o&&t){store('jamfor_order',JSON.stringify({id:o,token:t}));history.replaceState(null,'',location.pathname+location.search)}
  try{var v=JSON.parse(store('jamfor_order')||'null');if(v&&v.id&&v.token)return v}catch(e){}
  return null;
}

// ---------- steg 1 ----------
// Antalsbyte raderar aldrig något: redan byggda offertkort (text, fil, namn) behålls och döljs bara när antalet minskar, så 2→3→2→3 tappar ingenting.
function buildSlots(){
  var host=$('slots');state.slots=state.slots||[];state.cards=state.cards||[];
  for(var i=0;i<state.n;i++){if(!state.cards[i])makeSlot(i,host)}
  for(var j=0;j<state.cards.length;j++){state.cards[j].classList.toggle('hidden',j>=state.n)}
  var hid=0;for(var k=state.n;k<state.slots.length;k++){var sk=state.slots[k];if(sk&&(sk.file||(sk.text&&sk.text.trim())||(sk.label&&sk.label.trim())))hid++}
  var hn=$('slotnote');if(hn){hn.textContent=hid?('Du har '+hid+' dold'+(hid>1?'a':'')+' offert'+(hid>1?'er':'')+' kvar med innehåll. Välj ett högre antal för att få fram '+(hid>1?'dem':'den')+' igen – ingenting har tagits bort. Dolda offerter skickas inte.'):'';show('slotnote',!!hid)}
  if(state.carried&&!state.carriedFilled){fillCarried(true)}
}
function makeSlot(i,host){
  (function(i){
    var s=state.slots[i]||(state.slots[i]={label:'',file:null,text:'',name:''}); // finns redan i arbetsytan vid återmontering: underlag och namn bevaras
    var name=el('input',{type:'text',id:'lab'+i,maxlength:'40',autocomplete:'off',placeholder:'t.ex. Byggfirma AB',value:s.label||''});
    name.addEventListener('input',function(){s.label=name.value});
    var file=el('input',{type:'file',id:'f'+i,accept:'.pdf,image/*,.txt','aria-label':'Fil för offert '+(i+1)});
    var info=el('p',{class:'hint',id:'fi'+i,text:(s.file?s.file.name+' ('+G.fileKb(s.file)+' kB)':s.text?'Inklistrad text.':'Ingen fil vald.')+(s.from==='free'&&(s.file||s.text)?' · Följde med från gratisgranskningen.':'')});
    file.addEventListener('change',function(){var nf=file.files[0];if(!nf){return} /* avbrutet filval ändrar inget */
      mEv('input_choose',{method:'file',stage:'input'});
      var L=limitsOf();
      if(nf.size>L.file){ // för stor fil nekas direkt och tidigare inmatning är orörd
        info.textContent=slotReady(s)?info.textContent:'Ingen fil vald.';
        slotErr(i,'Filen ”'+nf.name+'” är för stor ('+mbOf(nf.size)+' MB, högst '+mbOf(L.file)+' MB). Välj en mindre fil eller ta bara sidorna med pris och villkor.'+(slotReady(s)?' Det du hade lagt in här är kvar.':''));
        file.value='';mErr('size','input');return}
      if(i===0)dropCarried();s.from='';s.gen=(s.gen||0)+1;s.file=nf;s.text='';ta.value='';info.textContent=s.file.name+' ('+Math.max(1,Math.round(s.file.size/1024))+' kB)';noteReady(i,'file')});
    var ta=el('textarea',{id:'t'+i,placeholder:'…eller klistra in offertens text här','aria-label':'Text för offert '+(i+1)});ta.value=s.text||'';
    ta.addEventListener('input',function(){if(i===0&&state.carried&&ta.value!==state.carried.text)dropCarried();
      if(!s.textChosen&&ta.value){s.textChosen=true;mEv('input_choose',{method:'text',stage:'input'})}if(!ta.value)s.textChosen=false;
      s.from='';s.gen=(s.gen||0)+1;s.text=ta.value;if(ta.value){s.file=null;file.value='';info.textContent='Inklistrad text.'}noteReady(i,'text')});
    var se=el('p',{class:'err hidden',id:'se'+i,role:'alert'});
    var card=el('div',{class:'card'},el('h3',{style:'margin-top:0',text:'Offert '+(i+1)}),el('label',{class:'t','for':'lab'+i,text:'Namn på hantverkaren (valfritt)'}),name,el('label',{class:'t','for':'f'+i,text:'Fil (PDF, foto eller text)'}),file,info,se,ta);
    state.cards[i]=card;host.appendChild(card);
  })(i);
}
// ---------- offert som följt med från den gratis granskningen (lokal, kortlivad engångshandoff) ----------
// Skapas bara av ett aktivt klick på gratissidan, ligger i sessionStorage (aldrig i adressen, aldrig i händelser/loggar), förbrukas när ordern skapas och slängs när den gått ut.
// Inget anrop till modell, betalning eller källor görs av att den följer med: kunden måste själv välja Kontrollera.
var HO_KEY='sd_handoff_v1';
function hoClear(){try{sessionStorage.removeItem(HO_KEY)}catch(e){}}
function hoStripHash(){try{if(/fran=gratis/.test(location.hash))history.replaceState(null,'',location.pathname+location.search)}catch(e){}}
function hoRead(){
  var raw;try{raw=sessionStorage.getItem(HO_KEY)}catch(e){return {state:'blocked'}}
  if(!raw)return {state:'none'};
  var r;try{r=JSON.parse(raw)}catch(e){return {state:'corrupt'}}
  if(!r||r.v!==1||typeof r.exp!=='number'||!r.doc||typeof r.doc!=='object')return {state:'corrupt'};
  if(Date.now()>r.exp)return {state:'stale'};
  var d=r.doc;
  if(d.kind==='text'){if(typeof d.text!=='string'||!d.text.trim())return {state:'corrupt'}}
  else if(d.kind==='pdf'||d.kind==='image'){
    if(typeof d.dataBase64!=='string'||!/^[A-Za-z0-9+\/]+=*$/.test(d.dataBase64)||d.dataBase64.length%4===1)return {state:'corrupt'};
    if(d.kind==='image'&&!(typeof d.mediaType==='string'&&/^image\/[a-z0-9.+-]+$/i.test(d.mediaType)))return {state:'corrupt'};
    if(d.filename!==undefined&&d.filename!==null&&typeof d.filename!=='string')return {state:'corrupt'};
  }else return {state:'corrupt'};
  return {state:'ok',doc:d};
}
function hoMsg(text){
  var b=$('carry');b.textContent='';
  b.appendChild(el('h2',{id:'carry-h',tabindex:'-1',text:'Ingen offert följde med'}));
  b.appendChild(el('p',{text:text}));
  show('carry',true);try{b.scrollIntoView({block:'start'});$('carry-h').focus({preventScroll:true})}catch(e){}
}
function hoApply(){
  var r=hoRead();
  if(r.state==='ok'){state.carried=r.doc;state.carriedFilled=false;fillCarried();return}
  var t={blocked:'Webbläsaren tillåter inte tillfällig lagring, så din offert kunde inte följa med. Lägg in dina offerter här nedan.',
    corrupt:'Den medföljande offerten gick inte att läsa. Lägg in dina offerter här nedan.',
    stale:'Den medföljande offerten finns inte kvar – den sparas bara en kort stund. Lägg in dina offerter här nedan.',
    none:'Vi hittar ingen medföljande offert – den sparas bara en kort stund och bara i den flik där du klickade. Lägg in dina offerter här nedan.'}[r.state];
  if(r.state!=='none'&&r.state!=='blocked')hoClear();
  hoMsg(t);hoStripHash();
}
function b64bytes(b){var bin=atob(b),u=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u}
function fillCarried(quiet){
  var d=state.carried,s=state.slots[0];if(!d||!s)return;
  var label;state.carriedFilled=true;
  try{
    if(d.kind==='text'){s.text=d.text;s.file=null;$('t0').value=d.text;$('fi0').textContent='Inklistrad text (följde med från gratisgranskningen).';label='inklistrad text'}
    else{
      var type=d.kind==='pdf'?'application/pdf':d.mediaType;
      var nm=(d.filename&&String(d.filename).slice(0,120))||(d.kind==='pdf'?'offert.pdf':'offert');
      var f=new File([b64bytes(d.dataBase64)],nm,{type:type});
      s.file=f;s.text='';$('t0').value='';
      try{var dt=new DataTransfer();dt.items.add(f);$('f0').files=dt.files}catch(e){}
      $('fi0').textContent=nm+' ('+Math.max(1,Math.round(f.size/1024))+' kB) – följde med från gratisgranskningen.';label=nm;
    }
    s.gen=(s.gen||0)+1;noteReady(0,'handoff');
  }catch(e){state.carried=null;hoClear();hoMsg('Den medföljande offerten gick inte att läsa. Lägg in dina offerter här nedan.');hoStripHash();return}
  var b=$('carry');b.textContent='';
  b.appendChild(el('h2',{id:'carry-h',tabindex:'-1',text:'Din första offert följer med.'}));
  b.appendChild(el('p',{text:'Lägg till 1–3 offerter för samma jobb.'}));
  b.appendChild(el('p',{class:'hint',text:'Offert 1: '+label+'. Den ligger bara kvar i den här webbläsarfliken en kort stund och skickas först när du själv väljer Kontrollera.'}));
  var rm=el('button',{type:'button',class:'btn ghost',id:'carry-drop',text:'Ta bort den medföljande offerten'});
  rm.addEventListener('click',function(){dropCarried(true)});b.appendChild(rm);
  show('carry',true);
  if(!quiet){try{b.scrollIntoView({block:'start'});$('carry-h').focus({preventScroll:true})}catch(e){}}
}
function dropCarried(clearSlot){
  if(!state.carried&&!clearSlot)return;
  state.carried=null;state.carriedFilled=false;hoClear();hoStripHash();show('carry',false);$('carry').textContent='';
  if(clearSlot&&state.slots[0]){var s=state.slots[0];s.file=null;s.text='';try{$('t0').value='';$('f0').value=''}catch(e){}$('fi0').textContent='Ingen fil vald.';try{$('f0').focus()}catch(e){}}
}
// Redan en jämförelse igång: den skrivs aldrig över och inget tas betalt igen. Den väntande offerten kastas om kunden väljer det (annars förbrukas den aldrig och går ut).
function hoConflict(){
  var r=hoRead();if(r.state!=='ok'){if(r.state!=='none'&&r.state!=='blocked')hoClear();hoStripHash();return}
  var b=$('hoconf');b.textContent='';
  b.appendChild(el('h2',{id:'hoconf-h',text:'Du har redan en jämförelse igång'}));
  b.appendChild(el('p',{text:'Din offert från gratisgranskningen följde inte med in i den, och din pågående jämförelse är orörd. Ingenting har skickats eller debiterats.'}));
  b.appendChild(el('p',{class:'hint',text:'Vill du jämföra ett annat jobb? Välj Börja om längre ned när du är klar med den här.'}));
  var keep=el('button',{type:'button',class:'btn acc',id:'hoconf-keep',text:'Fortsätt med min jämförelse'});
  keep.addEventListener('click',function(){hoClear();hoStripHash();show('hoconf',false);b.textContent=''});b.appendChild(keep);
  show('hoconf',true);try{b.scrollIntoView({block:'start'});b.focus({preventScroll:true})}catch(e){}
}
if(KIND==='compare')document.querySelector('.seg').addEventListener('click',function(e){
  var b=e.target.closest('button');if(!b)return;state.n=Number(b.dataset.n);wsC.n=state.n;
  document.querySelectorAll('.seg button').forEach(function(x){x.setAttribute('aria-pressed',String(x===b))});buildSlots();
});
function readAsBase64(file){return new Promise(function(res,rej){var r=new FileReader();r.onload=function(){res(String(r.result).split(',')[1]||'')};r.onerror=rej;r.readAsDataURL(file)})}
function readAsText(file){return new Promise(function(res,rej){var r=new FileReader();r.onload=function(){res(String(r.result))};r.onerror=rej;r.readAsText(file)})}
async function slotPayload(s){
  if(s.text&&s.text.trim())return {kind:'text',text:s.text};
  if(!s.file)return null;
  var f=s.file,nm=f.name.toLowerCase();
  if(f.type==='application/pdf'||nm.endsWith('.pdf'))return {kind:'pdf',dataBase64:await readAsBase64(f)};
  if(f.type.indexOf('image/')===0)return {kind:'image',mediaType:f.type,dataBase64:await readAsBase64(f)};
  if(nm.endsWith('.txt')||f.type==='text/plain')return {kind:'text',text:await readAsText(f)};
  return {bad:true};
}

// ---------- start: lås före första await, en rad per offert med egen felrättning, "Avsluta utkastet" ----------
state.rows=[];state.docOk=[];
function setRow(k,cls,text){var r=state.rows[k];if(!r)return;r.tag.className='tag '+cls;r.tag.textContent=text}
function rowFix(k,reason){
  var r=state.rows[k];if(!r)return;r.fix.textContent='';
  var sl=state.slots[k];
  var retry=el('button',{type:'button',class:'btn ghost',id:'retry'+k,text:'Försök igen'});
  retry.addEventListener('click',function(){retryRow(k)});
  var lab=el('label',{class:'btn ghost',for:'swap'+k,text:'Byt fil'});
  var inp=el('input',{type:'file',id:'swap'+k,accept:'.pdf,image/*,.txt',class:'sr-only','aria-label':'Byt fil för offert '+(k+1)});
  inp.addEventListener('change',function(){
    var nf=inp.files[0];if(!nf)return;var L=limitsOf();
    if(nf.size>L.file){setRow(k,'bad','Filen är för stor ('+mbOf(nf.size)+' MB, högst '+mbOf(L.file)+' MB). Välj en mindre fil eller ta bara sidorna med pris och villkor.');inp.value='';mErr('size','submit');return}
    mEv('input_choose',{method:'file',stage:'input'});
    sl.gen=(sl.gen||0)+1;sl.file=nf;sl.text='';sl.from='';try{$('t'+k).value='';$('fi'+k).textContent=nf.name+' ('+G.fileKb(nf)+' kB)'}catch(e){}
    retryRow(k);
  });
  var pd=el('details',{class:'pastefix'},el('summary',{text:'Klistra in texten istället'}));
  var ta=el('textarea',{id:'pastefix'+k,'aria-label':'Text för offert '+(k+1),placeholder:'Klistra in offertens text här'});
  var use=el('button',{type:'button',class:'btn ghost',id:'usepaste'+k,text:'Använd texten'});
  use.addEventListener('click',function(){
    if(!ta.value.trim()){setRow(k,'bad','Klistra in texten först.');return}
    sl.gen=(sl.gen||0)+1;sl.text=ta.value;sl.file=null;sl.from='';try{$('t'+k).value=ta.value;$('fi'+k).textContent='Inklistrad text.'}catch(e){}
    mEv('input_choose',{method:'text',stage:'input'});retryRow(k);
  });
  pd.appendChild(ta);pd.appendChild(use);
  if(reason!=='format')r.fix.appendChild(retry);
  r.fix.appendChild(lab);r.fix.appendChild(inp);r.fix.appendChild(pd);
  r.fix.classList.remove('hidden');
}
// Laddar upp EN offert till samma plats (PUT samma idx). Svar från en äldre generation av platsen tillämpas aldrig.
async function uploadDoc(k){
  var s=state.slots[k],r=state.rows[k],g=s.gen||0;
  r.fix.classList.add('hidden');setRow(k,'','Läser in…');state.docOk[k]=false;
  var p;try{p=await slotPayload(s)}catch(e){p=null}
  if((s.gen||0)!==g)return false;
  if(!p||p.bad){setRow(k,'bad','Filtypen går inte att läsa. Byt fil eller klistra in texten.');rowFix(k,'format');mErr('format','submit');return false}
  var u;
  try{u=await api('PUT','/compare/orders/'+state.order.id+'/docs/'+k,{token:state.order.token,body:p})}
  catch(e){if((s.gen||0)!==g)return false;setRow(k,'bad','Vi nådde inte tjänsten. Din offert är kvar här – försök igen.');rowFix(k,'network');mErr('network','submit');return false}
  if((s.gen||0)!==g)return false;
  if(u.status===200&&u.json&&u.json.doc){state.docOk[k]=true;setRow(k,'ok','Klar ('+(u.json.doc.pages?u.json.doc.pages+' sidor, ':'')+Math.max(1,Math.round(u.json.doc.bytes/1024))+' kB)');return true}
  var msg=(u.json&&u.json.error)||'';
  if(u.status===413)setRow(k,'bad',msg||'Filen är för stor. Byt fil eller ta bara sidorna med pris och villkor.'),mErr('size','submit');
  else if(u.status===409)setRow(k,'bad',msg||'Ordern kan inte ta emot fler ändringar just nu. Ladda om sidan för att fortsätta med den.'),mErr('server','submit');
  else if(u.status===408||u.status===504)setRow(k,'bad',msg||'Det tog för lång tid. Försök igen.'),mErr('timeout','submit');
  else if(u.status>=500)setRow(k,'bad',msg||'Tjänsten svarade inte som den ska. Försök igen om en stund.'),mErr('server','submit');
  else setRow(k,'bad',msg||'Offerten gick inte att läsa. Byt fil eller klistra in texten.'),mErr('read','submit');
  rowFix(k,u.status===409?'conflict':'read');
  return false;
}
function docsDone(){for(var i=0;i<state.docCount;i++)if(!state.docOk[i])return false;return true}
function afterDocs(){
  var nt=$('docsnote');if(nt)nt.remove();
  var old=$('cdraft');if(old)old.remove();
  if(docsDone()){show('offer',true);srcStart(null,'offer');try{$('offer').scrollIntoView({block:'start'})}catch(e){}}
  else{
    show('offer',false);
    $('docs').parentNode.insertBefore(el('p',{class:'warnbox',id:'docsnote',role:'status'},'Någon offert gick inte att ta emot. De som redan är klara är kvar. Rätta raden som visar fel (Försök igen, Byt fil eller klistra in texten) – du behöver inte börja om.'),$('docs').nextSibling);
  }
  $('s2').appendChild(closeDraftBlock());
}
async function retryRow(k){
  if(state.uploading||state.starting||!state.order)return;
  state.uploading=true;busy(true,'upload');
  try{await uploadDoc(k)}finally{state.uploading=false;busy(false,'upload')}
  afterDocs();
}
// Avsluta utkastet: tvåstegs bekräftelse på sidan (ingen confirm()), serverkontrollerad radering. Vid vägran bevaras ordern och lokalt utkast.
function closeDraftBlock(){
  var w=el('div',{class:'cdraft',id:'cdraft'});
  var b=el('button',{type:'button',class:'btn ghost',id:'cdraft-open',text:'Avsluta utkastet'});
  var conf=el('div',{class:'warnbox hidden',id:'cdraft-conf',role:'group','aria-label':'Bekräfta att utkastet avslutas'});
  conf.appendChild(el('p',{text:'Utkastet och de offerter som laddats upp till det raderas från tjänsten. Du har inte debiterats. Det du lagt in här i fliken finns kvar.'}));
  var yes=el('button',{type:'button',class:'btn acc',id:'cdraft-yes',text:'Ja, avsluta utkastet'});
  var no=el('button',{type:'button',class:'btn ghost',id:'cdraft-no',text:'Behåll utkastet'});
  var msg=el('p',{class:'hint',id:'cdraft-msg',role:'status','aria-live':'polite'});
  b.addEventListener('click',function(){conf.classList.remove('hidden');b.classList.add('hidden');yes.focus()});
  no.addEventListener('click',function(){conf.classList.add('hidden');b.classList.remove('hidden');msg.textContent='';b.focus()});
  yes.addEventListener('click',function(){closeDraft(yes,no,msg)});
  conf.appendChild(yes);conf.appendChild(no);w.appendChild(b);w.appendChild(conf);w.appendChild(msg);
  return w;
}
async function closeDraft(yes,no,msg){
  if(state.closing||!state.order)return;
  var o=state.order;state.closing=true;yes.disabled=true;no.disabled=true;busy(true,'close');msg.textContent='Avslutar utkastet…';
  var r=null,net=false;
  try{r=await api('POST','/compare/orders/'+o.id+'/close-draft',{token:o.token})}catch(e){net=true}
  finally{state.closing=false;busy(false,'close')}
  if(dead)return;
  yes.disabled=false;no.disabled=false;
  if(net){mErr('network','submit');msg.textContent='Vi nådde inte tjänsten, så inget har avslutats. Ordern och det du lagt in är kvar. Försök igen.';return}
  if(r.status===200&&r.json.ok){
    // Först nu, när servern bekräftat raderingen, släpps den sparade ordern. Lokala offerter i arbetsytan bevaras.
    clearTimeout(state.timer);store('jamfor_order',null);state.order=null;G.ws.receipt=null;
    G.ws.closedDraft=KIND;
    restartHere(true);return;
  }
  if(r.status===404){clearTimeout(state.timer);store('jamfor_order',null);state.order=null;restartHere(true);return}
  if(r.status===409){
    mErr('server','submit');
    var why={status:'Ordern har redan gått vidare och kan inte längre avslutas som utkast.',betald:'Ordern är betald och kan inte avslutas som utkast.',avtalspost:'Ordern har ett avtal och kan inte avslutas som utkast.',kassa:'Betalningen har påbörjats, så utkastet kan inte avslutas just nu.',raderad:'Ordern är redan raderad.'}[r.json&&r.json.reason];
    msg.textContent=(why||(r.json&&r.json.error)||'Utkastet kan inte avslutas just nu.')+' Ordern är kvar – du kan fortsätta med den.';
    var rs=el('button',{type:'button',class:'btn acc',id:'cdraft-resume',text:'Fortsätt med ordern'});
    rs.addEventListener('click',function(){if(KIND==='compare'){clearTimeout(state.timer);show('s2',false);show('s3',true);resume()}else{G.go('check',{push:true,url:'/forkontroll/#betala',reason:'user',force:true})}});
    msg.appendChild(document.createTextNode(' '));msg.appendChild(rs);return;
  }
  mErr('server','submit');msg.textContent='Det gick inte att avsluta utkastet just nu. Ordern och det du lagt in är kvar. Försök igen om en stund.';
}

async function compareStart(){
  if(state.starting||state.uploading)return;
  err('');
  if(!$('samejob').checked){err('Bekräfta först att offerterna gäller samma jobb.');$('samejob').focus();return}
  for(var i=0;i<state.n;i++){var s=state.slots[i];if(!slotReady(s)){slotErr(i,'Offert '+(i+1)+' saknar fil eller text. Lägg in en fil eller klistra in texten.');try{$('f'+i).focus();$('se'+i).scrollIntoView({block:'nearest'})}catch(e){}return}}
  var L=limitsOf(),tot=0;for(var q=0;q<state.n;q++){var sq=state.slots[q];tot+=(sq.text&&sq.text.trim())?sq.text.length:(sq.file?sq.file.size:0)}
  if(tot>L.total){err('Offerterna är tillsammans för stora ('+mbOf(tot)+' MB, högst '+mbOf(L.total)+' MB). Ta bort en fil eller ta bara sidorna med pris och villkor.');mErr('size','input');return}
  // Lås FÖRE första await: ett andra klick eller tangent når aldrig hit, och navigering är spärrad medan beställningen skapas och filerna läses in.
  state.starting=true;busy(true,'start');
  var btn=$('check');btn.disabled=true;btn.textContent='Kontrollerar…';
  mEv('submit',{method:methodOfSlots(state.slots.slice(0,state.n))});
  try{
    var c;
    try{c=await api('POST','/compare/orders',{body:{docCount:state.n,labels:state.slots.slice(0,state.n).map(function(s){return s.label}),accept:{sameJob:true}}})}
    catch(e){mErr('network','submit');err('Vi nådde inte tjänsten. Inget har skickats eller debiterats och dina offerter ligger kvar. Försök igen.');return}
    if(c.status!==201){mErr(c.status>=500?'server':'config','submit');err((c.json&&c.json.error)||'Det gick inte att starta just nu. Dina offerter ligger kvar.');return}
    state.order={id:c.json.orderId,token:c.json.token};state.docCount=state.n;refreshPSum();store('jamfor_order',JSON.stringify(state.order));state.carried=null;hoClear();hoStripHash();
    show('s1',false);show('s2',true);$('docs').textContent='';state.rows=[];state.docOk=[];
    for(var k=0;k<state.n;k++){
      var tag=el('span',{class:'tag',text:'Läser in…',role:'status'}),fix=el('div',{class:'rowfix hidden'});
      var row=el('div',{class:'docrow','data-row':String(k)},el('span',{text:'Offert '+(k+1)+(state.slots[k].label?' – '+state.slots[k].label:'')}),tag,fix);$('docs').appendChild(row);
      state.rows[k]={tag:tag,fix:fix};
    }
    for(var k2=0;k2<state.n;k2++)await uploadDoc(k2);
    afterDocs();
  }catch(e){mErr('server','submit');err('Något gick fel. Försök igen.')}
  finally{state.starting=false;busy(false,'start');btn.disabled=false;btn.textContent='Kontrollera offerterna'}
}
if(KIND==='compare')$('check').addEventListener('click',compareStart);

if(KIND==='compare')$('pay').addEventListener('click',async function(){
  err('');
  if(!EMAIL_OK.test(($('email').value||'').trim())){err('Ange en giltig e-postadress för avtalsbekräftelsen.');$('email').focus();return}
  state.email=$('email').value.trim();
  if(isP(state.cfg)){if(!$('declaration').checked){err('Markera själv rutan om att jämförelsen börjar direkt och att ångerrätten upphör när tjänsten är helt utförd för att gå vidare.');$('declaration').focus();return}}
  else if(!$('terms').checked||!$('immediate').checked){err('Godkänn villkoren och att jämförelsen startar direkt för att gå vidare.');return}
  if(state.paying)return;state.paying=true;
  var b=$('pay');b.disabled=true;b.textContent='Öppnar betalning…';
  mEv('checkout_open',{stage:'checkout'});
  try{
    var r=await api('POST','/compare/orders/'+state.order.id+'/checkout',{token:state.order.token,body:{accept:acceptBody()}});
    if(r.status===200&&r.json.url){location.href=r.json.url;return}
    if(r.json&&r.json.consentChanged){try{state.cfg=(await api('GET','/compare/config')).json;fillCopy(state.cfg);$('terms').checked=false;$('declaration').checked=false;syncPay()}catch(e){}}
    err((r.json&&r.json.error)||'Betalningen kunde inte startas. Du har inte debiterats.');
  }catch(e){mErr('network','checkout');err('Betalningen kunde inte startas. Du har inte debiterats.')}
  state.paying=false;b.textContent=payLabel();syncPay();
});

function isP(cfg){return !!(cfg&&cfg.consent&&cfg.consent.policy==='P')}
function payLabel(){return 'Betala 49 kr'} // samma tydliga köpknapp i första köpet och vid retry (betalningsskyldigheten framgår av sammanfattningen och knappen)
function syncPay(){if(!isP(state.cfg)){$('pay').disabled=false;return}$('pay').disabled=!$('declaration').checked} // P: knappen är inaktiv tills den ENA deklarationen aktivt markerats
function acceptBody(){var c=(state.cfg&&state.cfg.consent)||{};var em=$('email');var base={terms:true,consentHash:c.hash,consentVersion:c.version,email:((em&&em.value)||state.email||'').trim()};if(isP(state.cfg)){base.declaration=true}else base.immediateDelivery=true;return base}
if(KIND==='compare')['terms','declaration'].forEach(function(id){$(id).addEventListener('change',syncPay)});
var EMAIL_OK=/^[^\s@,;<>()"]{1,64}@[^\s@,;<>()"]{1,190}\.[A-Za-z]{2,}$/;

// ---------- återupptagning och väntan ----------
function recoveryLink(){return location.origin+location.pathname+'#o='+encodeURIComponent(state.order.id)+'&t='+encodeURIComponent(state.order.token)}
$('copylink').addEventListener('click',function(){var t=recoveryLink();if(navigator.clipboard)navigator.clipboard.writeText(t).then(function(){$('copylink').textContent='Kopierad ✓'},function(){});});
async function resume(){
  show('s1',false);show('s2',false);
  var q=new URLSearchParams(location.search);
  tick(q.get('avbruten')==='1');
}
async function tick(cancelled){
  var r;
  try{r=await api('GET','/compare/orders/'+state.order.id,{token:state.order.token})}catch(e){if(dead)return;setStatus('Kunde inte nå tjänsten just nu. Försöker igen…');state.timer=setTimeout(tick,4000);return}
  if(dead)return;
  if(r.status===404){if(startFreshFromGone('Din tidigare jämförelse hittades inte (den kan ha gått ut eller raderats), så den är inte påverkad av detta. Du börjar en ny.'))return;store('jamfor_order',null);setStatus('Ordern hittades inte. Den kan ha gått ut (24 timmar) eller raderats.',true);return}
  var o=r.json.order;if(!o){state.timer=setTimeout(tick,4000);return}
  state.kind=o.kind;receiptProtected();
  if(o.kind==='check'){if(KIND!=='check'&&G.shell)G.shell.render('check');ckChrome();var h3=$('h-s3');if(h3)h3.textContent='Din förkontroll'}
  if(Number.isInteger(o.docCount))state.docCount=o.docCount;
  if(['draft','ready','awaiting_payment'].indexOf(o.status)<0&&$('offer'))show('offer',false); // källpanelen hör bara till obetald återupptagning
  $('reclink').textContent=recoveryLink();show('recovery',true);
  var box=$('statusbox');box.textContent='';
  var next=null;
  if(o.status==='draft'||o.status==='ready'||o.status==='awaiting_payment'){
    box.appendChild(el('p',{text:cancelled?'Betalningen avbröts. Du har inte debiterats.':'Vi väntar på bekräftelse av betalningen från Stripe. Att du kommit tillbaka hit är inte i sig en bekräftelse.'}));
    if(o.status!=='awaiting_payment'||cancelled){var b=el('button',{type:'button',class:'btn acc',text:'Gå till betalning igen'});b.addEventListener('click',retryPay);box.appendChild(b)}
    else next=(r.json.pollMs||2000)+1000;
    if(o.status==='awaiting_payment'&&!cancelled)box.appendChild(el('p',{class:'hint',text:'Betalade du nyss? Vänta några sekunder – sidan uppdateras själv.'}));
    resumeSources(o);
    if(o.status==='draft'||o.status==='ready')box.appendChild(closeDraftBlock());
  }else if(o.status==='expired'){box.appendChild(el('p',{text:'Ordern har gått ut. Du har inte debiterats. Börja om med dina offerter.'}));box.appendChild(restartBtn());}
  else if(o.status==='paid'||o.status==='running'){
    var pct=Math.round(100*(o.progress.extracted+(o.progress.synth==='done'||o.progress.synth==='skipped'?1:0))/(o.progress.total+1));
    if(o.waiting==='avtalsbekraftelse'){box.appendChild(el('p',{text:'Betalningen är bekräftad. Vi väntar på att avtalsbekräftelsen ska kunna skickas till din e-post innan jämförelsen startar. Inget arbete har påbörjats.'}));box.appendChild(el('p',{class:'hint',text:'Går det inte inom en halvtimme avbryts köpet och du får pengarna tillbaka. Du kan också ångra köpet nedan.'}))}
    else box.appendChild(el('p',{text:'Betalningen är bekräftad. Vi läser offerterna ('+o.progress.extracted+' av '+o.progress.total+' klara).'}));
    var pr=el('div',{class:'progress',role:'progressbar','aria-valuemin':'0','aria-valuemax':'100','aria-valuenow':String(pct)},el('i',{style:'width:'+pct+'%'}));box.appendChild(pr);
    box.appendChild(el('p',{class:'hint',text:'Du kan stänga fliken. Använd länken nedan för att komma tillbaka.'}));
    next=(r.json.pollMs||2000)+500;
  }else if(o.status==='delivered'){
    var rr=await api('GET','/compare/orders/'+state.order.id+'/report',{token:state.order.token});
    if(rr.status===200){show('s3',false);o.sourceLive=rr.json.sourceLive;renderReport(rr.json.report,o);return}
    if(rr.status===410){box.appendChild(el('p',{text:'Rapporten har gått ut och är raderad.'}));box.appendChild(el('p',{class:'hint',text:'Vill du jämföra nya offerter? Välj Börja om. Den gamla ordern påverkas inte.'}));box.appendChild(restartBtn());}
    else{box.appendChild(el('p',{text:'Rapporten är klar men kunde inte hämtas just nu.'}));next=4000}
  }else if(o.status==='failed'){
    var rs=o.refund&&o.refund.state;
    var rt={done:' Återbetalningen är genomförd hos betalleverantören.',pending:' Återbetalningen är begärd och väntar på att slutföras hos betalleverantören – den är inte klar än.',requested:' Återbetalningen begärs just nu.',action_required:' Återbetalningen kräver en åtgärd som vi måste ta hand om.',failed:' Återbetalningen gick inte igenom automatiskt och måste göras för hand.',needed:' Återbetalningen görs för hand.',none:''}[rs];
    if(o.error==='angrat')box.appendChild(el('div',{class:'okbox',text:'Du har ångrat köpet. Jämförelsen är stoppad och ditt innehåll raderat.'+(rt===undefined?'':rt)}));
    else if(o.error==='bekraftelse_ej_levererad')box.appendChild(el('div',{class:'err',text:'Vi kunde inte skicka avtalsbekräftelsen, så jämförelsen startades aldrig. Du ska få pengarna tillbaka.'+(rt===undefined?'':rt)}));
    else box.appendChild(el('div',{class:'err',text:'Jämförelsen kunde inte slutföras. Du ska få pengarna tillbaka.'+(rt===undefined?'':rt)}));
    box.appendChild(el('p',{text:'Ordernummer: '+o.id.slice(2,10).toUpperCase()+(rs&&rs!=='done'?'. Kontakta oss med ordernumret om pengarna inte kommit tillbaka inom några dagar.':'')}));
    if(rs==='pending'||rs==='action_required'||rs==='requested')next=15000;
  }else if(o.status==='deleted'){box.appendChild(el('p',{text:'Jämförelsen är raderad.'}));store('jamfor_order',null);box.appendChild(el('p',{class:'hint',text:'Vill du jämföra nya offerter? Välj Börja om. Den gamla ordern påverkas inte.'}));box.appendChild(restartBtn());}
  if(['paid','running','failed'].indexOf(o.status)>=0){var wb=withdrawBlock(o);if(wb)box.appendChild(wb)}
  if(next)state.timer=setTimeout(tick,next);
}
// D07: återupptagen obetald order (draft/ready/awaiting_payment) ska kunna se och ange sina befintliga firmor och källor INNAN betalning. Inga dokument/AI läses om, ingen ny order, ingen checkout. Källtäckningen hämtas färsk från servern.
// Sidans källintro ska bara utlova aktiva leverantörer (Google när Trustpilot är av osv.).
function srcIntro(){
  var c=srcCfg(),p=$('srcintro');if(!c||!p)return;var g=c.google&&c.google.state!=='ej_aktiverad',t=c.trustpilot&&c.trustpilot.state!=='ej_aktiverad';
  var who=g&&t?'Googles och Trustpilots':g?'Googles':t?'Trustpilots':'';if(!who)return;
  p.textContent=p.textContent.replace(/^Googles och Trustpilots/,who);
}
// En riktig offertetikett (inte standardnamnet "Offert N") får föreslås som företagsnamn – men sparas aldrig utan att kunden själv trycker Spara.
function realLabel(l){var t=String(l||'').trim();return t&&!/^offert\s*\d+$/i.test(t)?t:''}
function resumeRows(){
  var host=$('srcresume');if(!host||!SRC.view)return;host.textContent='';
  for(var i=0;i<state.n;i++)(function(i){
    var f=(SRC.view.firms||[]).filter(function(x){return (x.offers||[]).indexOf(i)>=0})[0]||null;
    var row=el('div',{class:'srcfirm','data-resume':String(i)});
    row.appendChild(el('b',{text:'Offert '+(i+1)+': '+(f?f.name+(f.city?', '+f.city:''):'inget företag angivet')}));
    var lbl=realLabel(state.labels&&state.labels[i]);
    var b=el('button',{type:'button',class:'btn ghost',style:'margin-left:8px',text:f?'Ändra företag':'Lägg till företag'});
    b.addEventListener('click',function(){srcEditForm(row,i,f?{name:f.name,city:f.city,domain:f.domain}:(lbl?{name:lbl}:null))});
    row.appendChild(b);host.appendChild(row);
  })(i);
}
// D07: återupptagen obetald order (draft/ready/awaiting_payment) ska kunna se och ange sina firmor och källor INNAN betalning, även när 0 firmor finns. Inga dokument/AI läses om, ingen ny order, ingen checkout. Källtäckningen hämtas färsk från servern.
async function resumeSources(o){
  if(state.resumeSrc||!srcActive())return;
  var n=Number.isInteger(o.docCount)?o.docCount:0;if(n<1)return;
  var r;try{r=await srcApi('GET','')}catch(e){return}
  if(r.status!==200||!r.json||!r.json.sources)return;
  state.resumeSrc=true;state.n=n;state.docCount=n;state.labels=Array.isArray(o.labels)?o.labels.slice(0,n):[];
  var off=$('offer'),box=$('statusbox');if(!off||!box||!box.parentNode)return;
  box.parentNode.insertBefore(off,box.nextSibling);off.classList.add('srconly');show('offer',true);show('srcbox',true);
  var man=$('srcmanual');if(man)man.classList.add('hidden');
  if(!$('srcresume')){var rr=el('div',{id:'srcresume','aria-live':'polite'});var fh=$('srcfirms');fh.parentNode.insertBefore(rr,fh)}
  srcIntro();srcRender(r.json.sources,'offer');resumeRows();preidBlock();
}
function mailText(st){return st==='sent'?'skickad':st==='avstamning'?'leveransen är oklar och kontrolleras manuellt (vi har inte kunnat bekräfta att den skickades)':st==='failed'?'kunde inte skickas (vi hanterar det manuellt)':'köad (ännu inte skickad)'}
function withdrawBlock(o){
  var box=el('div',{class:'card',id:'agreement'});
  if(!o.agreement)return null;
  box.appendChild(el('h3',{style:'margin-top:0',text:'Ditt avtal'}));
  var conf=(o.agreement.mails||[]).filter(function(m){return m.kind==='avtalsbekraftelse'})[0];
  box.appendChild(el('p',{class:'hint',text:'Avtals-ID '+o.agreement.id+'. Avtalsbekräftelse till '+o.agreement.contact+': '+(conf?mailText(conf.state):'köad')+'.'+(o.agreement.draft?' Utkast: villkoren är inte slutgiltiga.':'')}));
  var w=o.withdrawal;
  if(w&&w.requested){
    var txt=w.outcome==='angrat_fore_fullgoring'?'Köpet är ångrat. Tjänsten var inte fullt utförd, så din ångerrätt gällde; hela beloppet ska betalas tillbaka.':w.outcome==='angerratt_upphord'?'Din begäran är mottagen. Enligt de val du gjorde vid köpet upphörde ångerrätten när tjänsten var fullt utförd; någon återbetalning på grund av ångerrätt görs därför inte. Reklamation och dina övriga rättigheter påverkas inte.':w.outcome==='avbrutet_fore_leverans'?'Köpet är ångrat och jämförelsen stoppad. Hela beloppet ska betalas tillbaka.':w.outcome==='redan_avslutad'?'Din ånger är mottagen. Jämförelsen kunde redan inte slutföras; återbetalningen hanteras separat.':'Din ånger är mottagen och sparad med tidpunkten nedan. Den prövas manuellt – det här är ingen bekräftelse på att ångerrätten gäller eller inte gäller.';
    box.appendChild(el('p',{id:'wdtext',text:txt}));
    box.appendChild(el('p',{class:'hint',text:'Begäran '+w.requestId+', mottagen '+new Date(w.at).toLocaleString('sv-SE')+'. Mottagningsbevis skickas till din e-post.'}));
  }else{
    var b=el('button',{type:'button',class:'btn ghost',id:'withdraw',text:'Ångra köpet'});
    b.addEventListener('click',async function(){
      if(!confirm('Vill du ångra köpet?'))return;
      b.disabled=true;
      var r=await api('POST','/compare/orders/'+state.order.id+'/withdraw',{token:state.order.token});
      if(r.status===200&&r.json.ok){clearTimeout(state.timer);tick()}else{b.disabled=false;err((r.json&&r.json.error)||'Det gick inte att ta emot ångern just nu. Försök igen.')}
    });
    box.appendChild(b);
  }
  return box;
}
function setStatus(t,bad){var b=$('statusbox');b.textContent='';b.appendChild(el('p',{text:t}));if(bad)b.appendChild(restartBtn())}
function restartBtn(keepDraft){var b=el('button',{type:'button',class:'btn ghost',id:'restart',text:'Börja om'});b.addEventListener('click',function(){restartHere(keepDraft)});return b}
// Börja om: sparad order släpps, utkastet i arbetsytan bevaras bara om kunden ber om det (delvis fel). Ingen omladdning av sidan.
function restartHere(keepDraft){
  clearTimeout(state.timer);store('jamfor_order',null);
  if(!keepDraft){if(KIND==='compare'){G.ws.compare.n=2;G.ws.compare.slots.length=0;G.ws.compare.samejob=false}else{G.ws.check.file=null;G.ws.check.text='';G.ws.check.own=false}}
  var keep=hoRead().state==='ok';
  try{history.replaceState({gmo:1,task:ctx.task},'',G.urlOf(ctx.task)+(keep&&KIND==='compare'?'#fran=gratis':''))}catch(e){}
  G.go(ctx.task,{force:true,reason:'user',focus:true});
}
async function retryPay(){
  if(state.srcChanged)return consentAgain('Du har ändrat källorna för dina firmor sedan du senast godkände. Läs och godkänn igen innan du betalar.'); // tidigare samtycke återanvänds aldrig tyst när det köpta innehållet ändrats
  // Inget samtycke skickas i det tysta: servern återanvänder bara ett samtycke som kunden redan gett till SAMMA text (hash).
  var r=await api('POST','/compare/orders/'+state.order.id+'/checkout',{token:state.order.token});
  if(r.status===200&&r.json.url){location.href=r.json.url;return}
  if(r.json&&r.json.needAccept){return consentAgain(r.json.error)}
  err((r.json&&r.json.error)||'Betalningen kunde inte startas.');
}
async function consentAgain(msg){
  if(state.kind==='check'){G.go('check',{push:true,url:'/forkontroll/#betala',reason:'user',force:true});return} // förkontrollens egna köptexter finns på /forkontroll/
  try{state.cfg=(await api('GET','/compare/config')).json}catch(e){}
  var cfg=state.cfg||{},t=(cfg.consent&&cfg.consent.texts)||{},box=$('statusbox');box.textContent='';
  box.appendChild(el('p',{text:msg||'Läs och godkänn villkoren igen innan du betalar.'}));
  if(cfg.consent&&cfg.consent.draft)box.appendChild(el('p',{class:'warnbox',text:'Utkast: villkorstexterna är inte slutgiltiga.'}));
  function chk(id,text){var l=el('label',{class:'chk'});l.appendChild(el('input',{type:'checkbox',id:id}));l.appendChild(el('span',{text:text}));return l}
  var le=el('label',{for:'email2',style:'display:block;font-weight:600;margin:10px 0 4px',text:'E-postadress för avtalsbekräftelsen'});box.appendChild(le);
  box.appendChild(el('input',{type:'email',id:'email2',autocomplete:'email',maxlength:'254'}));
  var PP=isP(cfg);
  if(PP){
    var L=psumLines(cfg,t,state.docCount||state.n),card=el('div',{class:'card',id:'psum2',role:'group'},el('h3',{style:'margin-top:0',text:'Det här köper du'}),el('p',{text:L.what}),el('p',{class:'hint',text:L.done}),el('p',{class:'hint',text:L.seller}),el('details',{id:'more2'},el('summary',{text:'Läs mer: begränsningar'}),el('p',{class:'hint',text:L.limits})));
    box.appendChild(card);box.appendChild(chk('decl2',t.declaration||''));box.appendChild(termsSentence(t,'pterms2'));
  }else{box.appendChild(chk('terms2',t.terms||''));box.appendChild(chk('immediate2',t.immediate||''))}
  var b=el('button',{type:'button',class:'btn acc',id:'pay2',text:PP?payLabel():'Godkänn och gå till betalning'});
  function sync2(){if(PP)b.disabled=!$('decl2').checked} // P: knappen är inaktiv tills den ENA rutan aktivt markerats (policy Q oförändrad)
  b.addEventListener('click',async function(){
    err('');
    if(!EMAIL_OK.test(($('email2').value||'').trim())){err('Ange en giltig e-postadress för avtalsbekräftelsen.');return}
    state.email=$('email2').value.trim();
    if(PP?!$('decl2').checked:!($('terms2').checked&&$('immediate2').checked)){err(PP?'Markera själv rutan om att jämförelsen börjar direkt och att ångerrätten upphör när tjänsten är helt utförd för att gå vidare.':'Godkänn villkoren och att jämförelsen startar direkt för att gå vidare.');return}
    b.disabled=true;
    var r=await api('POST','/compare/orders/'+state.order.id+'/checkout',{token:state.order.token,body:{accept:acceptBody()}});
    if(r.status===200&&r.json.url){location.href=r.json.url;return}
    b.disabled=false;err((r.json&&r.json.error)||'Betalningen kunde inte startas. Du har inte debiterats.');
  });
  box.appendChild(b);
  if(PP){$('decl2').addEventListener('change',sync2);sync2()}
}

// ---------- rapport ----------
var STATUS={ingar:'Ingår',ingar_inte:'Ingår inte',framgar_inte:'Framgår inte'};
function ref(c){if(c.status==='framgar_inte')return null;return (c.page?'s. '+c.page+(c.ref?', ':''):'')+(c.ref||'')}
function money(m){return m?kr(m.value):'Framgår inte'}
// ---------- D11: offert först – kolumner per offert, jämförbara rader, sortering, fördjupning under Visa mer ----------
var SORTS=[{v:'upload',t:'Uppladdningsordning'},{v:'price',t:'Lägst jämförbara pris'},{v:'fewopen',t:'Minst antal oklarheter'},{v:'mostopen',t:'Flest oklarheter'},{v:'rating',t:'Högst Trustpilot-betyg'}];
function idStat(f){return f.status==='framgar'?{k:'ok',t:'Framgår'}:f.status==='ej_lasbar'?{k:'unk',t:'Kunde inte avläsas säkert'}:{k:'q',t:'Framgår inte'}}
// Trustpilot-sammanfattning {sig,score,count} från serveradaptern (aldrig egen uppskattning), BUNDEN till firmans aktuella identitet:
// sig = id|namn|ort|domän|Trustpilot bekräftad|bekräftelse-revision (serverns trustpilot.rev ändras vid varje ny/borttagen koppling). Ändrad sig,
// borttagen firma eller avbekräftad koppling ⇒ posten gäller inte längre (tpOf returnerar null) och rensas. Inflight-svar kontrolleras mot sig vid mottagandet.
var SRCTPD={},SRCTPTRY={};
function firmSig(f){var t=f.trustpilot||{};return [f.id,f.name||'',f.city||'',f.domain||'',t.confirmed?1:0,t.rev||0].join('|')}
function curFirm(id){var v=SRC&&SRC.view;if(!v||!v.firms)return null;var r=null;v.firms.forEach(function(x){if(!r&&x.id===id)r=x});return r}
function tpOfFirm(f){var d=f&&SRCTPD[f.id];return d&&f.trustpilot&&f.trustpilot.confirmed&&d.sig===firmSig(f)?d:null}
function tpPrune(){
  Object.keys(SRCTPD).forEach(function(id){var f=curFirm(id);if(!f||!tpOfFirm(f))delete SRCTPD[id]});
  Object.keys(SRCTPTRY).forEach(function(id){var f=curFirm(id);if(!f||SRCTPTRY[id].sig!==firmSig(f))delete SRCTPTRY[id]});
}
function firmOfOffer(k){var v=SRC&&SRC.view;if(!v||!v.firms)return null;var f=null;v.firms.forEach(function(x){if(!f&&x.offers.indexOf(k)>=0)f=x});return f}
function tpOf(k){return tpOfFirm(firmOfOffer(k))}
function ratingAvailable(n){var ids={},c=0,i,f;for(i=0;i<n;i++){f=firmOfOffer(i);if(f&&tpOfFirm(f)&&!ids[f.id]){ids[f.id]=1;c++}}return c>=2} // DISTINCTA firmor: två offerter från samma firma räknas som en
function tpText(d){return '★ '+String(d.score).replace('.',',')+' av 5 · '+d.count+' omdömen · Trustpilot'}
// Placeringar: lika värden = delad placering (konkurrensrangordning), okända/ej bedömbara får ingen placering och hamnar sist (aldrig 0/sämst).
function sortOffers(R,mode){
  var n=R.offers.length,idx=[],i;for(i=0;i<n;i++)idx.push(i);
  var val=function(){return null};
  if(mode==='price'&&R.ranking.shown){var pm={};R.ranking.values.forEach(function(v){pm[v.index]=v.incVat});val=function(k){return typeof pm[k]==='number'?pm[k]:null}}
  else if(mode==='fewopen'||mode==='mostopen'){val=function(k){var o=R.offers[k].open;return o&&o.assessable&&typeof o.count==='number'?o.count:null}}
  // Betyg: ENDAST Trustpilots totalbetyg från vår egen serveradapter (verifierad källa, samma skala för alla). Firmor utan uppgift får ingen placering och står sist – aldrig 0/sämst.
  // Google kan inte sorteras: betyget visas bara i Googles egen ruta och läses aldrig tillbaka. Inga egna poäng.
  else if(mode==='rating'){val=function(k){var d=tpOf(k);return d&&typeof d.score==='number'?d.score:null}}
  else return {order:idx,ranks:{},unknown:[]};
  var known=idx.filter(function(k){return val(k)!==null}),unk=idx.filter(function(k){return val(k)===null});
  var dir=mode==='mostopen'||mode==='rating'?-1:1;
  known.sort(function(a,b){return dir*(val(a)-val(b))||a-b}); // stabil: lika värden behåller uppladdningsordning
  var ranks={},prev=null,pos=0;
  known.forEach(function(k,j){if(prev===null||val(k)!==prev){pos=j+1;prev=val(k)}ranks[k]=pos});
  return {order:known.concat(unk),ranks:ranks,unknown:unk};
}
function cellOf(kind,c){
  var td=el('td',{});
  function put(cls,icon,text,small){var b=el('span',{class:'cv '+cls},el('span',{class:'ic','aria-hidden':'true',text:icon}),el('span',{text:' '+text}));td.appendChild(b);if(small)td.appendChild(el('small',{text:small}))}
  if(kind==='scope'){
    if(c.status==='ingar')put('ok','✓','Ingår',ref(c));else if(c.status==='ingar_inte')put('no','✕','Ingår inte',ref(c));else put('q','?','Framgår inte');
  }
  return td;
}
function buildGrid(R,mode,view){
  var n=R.offers.length,S=sortOffers(R,mode),order=S.order;
  var wrap=el('div',{class:'cmpwrap'});
  var t=el('table',{class:'cmp','data-sort':mode});
  t.appendChild(el('caption',{class:'sr',text:'Jämförelse av '+n+' offerter, rad för rad'}));
  var hr=el('tr',{});hr.appendChild(el('td',{class:'corner'}));
  order.forEach(function(k,pos){
    var of=R.offers[k],id=of.identity,th=el('th',{scope:'col','data-col':String(k),'data-pos':String(pos)});
    if(S.ranks[k]){var shared=Object.keys(S.ranks).filter(function(x){return S.ranks[x]===S.ranks[k]}).length>1;th.appendChild(el('span',{class:'rk','data-rank':String(S.ranks[k]),text:'Plats '+S.ranks[k]+(shared?' (delad)':'')}))}
    else if(S.unknown.indexOf(k)>=0&&mode!=='upload')th.appendChild(el('span',{class:'rk unk',text:'Ej bedömbart'}));
    th.appendChild(el('b',{class:'oh',text:of.label}));
    var fn=id&&id.fields.name.status==='framgar'?id.fields.name.value+(id.fields.city.status==='framgar'?' · '+id.fields.city.value:''):null;
    th.appendChild(el('span',{class:'firm'+(fn?'':' q'),'data-firm-line':String(k),text:fn||(id&&id.state==='ej_avlast'?'Företag: kunde inte avläsas säkert':'Företag framgår inte av offerten')}));
    var op=of.open;
    th.appendChild(el('span',{class:'oc'+(op&&op.assessable?'':' unk'),text:op&&op.assessable?op.count+' uppgifter att reda ut':'Går inte att bedöma säkert'+(op&&op.unreadable&&op.unreadable.length?'':'')}));
    th.appendChild(el('span',{class:'srcline','data-src-offer':String(k)}));
    if(R.ranking.shown&&R.ranking.lowest&&R.ranking.lowest.index===k)th.appendChild(el('span',{class:'lowtag',text:'Lägst jämförbart pris'}));
    var sl=state.slots&&state.slots[k];
    if(sl&&sl.file){var ob=el('button',{type:'button',class:'linkbtn',text:'Öppna originalet'});ob.addEventListener('click',function(){var u=URL.createObjectURL(sl.file);window.open(u,'_blank','noopener');setTimeout(function(){URL.revokeObjectURL(u)},60000)});th.appendChild(ob)}
    hr.appendChild(th);
  });
  var thd=el('thead',{});thd.appendChild(hr);t.appendChild(thd);
  var tb=el('tbody',{});
  function grp(title){var tr=el('tr',{class:'grp'});tr.appendChild(el('th',{scope:'colgroup',colspan:String(n+1),text:title}));tb.appendChild(tr)}
  function row(label,cellFn,flag){
    var tr=el('tr',{class:flag?'dev':''});
    tr.appendChild(el('th',{scope:'row',text:label}));
    order.forEach(function(k){var td=cellFn(R.offers[k],k);td.setAttribute('data-col',String(k));tr.appendChild(td)});
    tb.appendChild(tr);return tr;
  }
  function txt(text,cls,small){var td=el('td',{});td.appendChild(el('span',{class:'cv '+(cls||''),text:text}));if(small)td.appendChild(el('small',{text:small}));return td}
  // Pris
  grp('Pris');
  var comparable=R.ranking.shown;
  row('Pris inkl. moms (före ROT)'+(comparable?'':' – ej jämförbart'),function(of){var p=of.price;
    if(p.normalized)return txt(kr(p.normalized.incVat),'ok',p.vatBasis==='exkl'?'Offerten anger '+money(p.totalBeforeRot)+' exkl. moms (25 % antas)':'Offerten anger beloppet inkl. moms');
    if(p.totalBeforeRot)return txt(money(p.totalBeforeRot),'q','Moms inkl/exkl framgår inte');
    if(p.totalUnmarked)return txt(kr(p.totalUnmarked.value),'q','Före/efter ROT framgår inte');
    return txt('Framgår inte','q');},!comparable);
  row('ROT-avdrag / att betala',function(of){var p=of.price;return txt(p.rotAmount?'ROT '+kr(p.rotAmount.value):'ROT anges inte',p.rotAmount?'':'q',p.amountToPay?'Att betala '+kr(p.amountToPay.value):null)});
  row('Pristyp',function(of){var pt=of.price.priceType;return txt(pt==='fast'?'Fast pris':pt==='ungefarligt'?'Uppskattat pris':pt==='lopande'?'Löpande räkning':'Framgår inte',pt==='fast'?'':'q')},R.differences.some(function(d){return d.id==='price:typ'}));
  row('Arbete / material / resor',function(of){var p=of.price,a=[];if(p.labor)a.push('Arbete '+kr(p.labor.value));if(p.material)a.push('Material '+kr(p.material.value));if(p.travel)a.push('Resor '+kr(p.travel.value));return a.length?txt(a.join(' · ')):txt('Delposter framgår inte','q')});
  // Omfattning, tid och villkor (raderna ur motorns matris; poster som skiljer visas direkt)
  var byId={};R.scopeMatrix.forEach(function(m){byId[m.id]=m});
  var G1=['material','arbete','resor','bortforsling','rivning'],G2=['startdatum','tidplan'],G3=['betalningsplan','ata','garanti','forsakring','fskatt'];
  function srow(id){var m=byId[id];if(!m)return;var flag=m.kind==='skiljer'||m.kind==='oklart_for_nagon';row(m.label+(m.kind==='skiljer'?' · skiljer':m.kind==='oklart_for_nagon'?' · oklart i någon':''),function(of,k){return cellOf('scope',m.cells[k])},flag)}
  grp('Omfattning');G1.forEach(srow);
  grp('Start och tid');G2.forEach(srow);
  grp('Betalning och villkor');G3.forEach(srow);
  // Företagsuppgifter ur dokumentet (original)
  grp('Företagsuppgifter i offerten');
  [['name','Företagsnamn'],['orgnr','Organisationsnummer'],['kontakt','Adress eller telefon']].forEach(function(f){
    var anyBad=R.offers.some(function(of){return of.identity&&of.identity.essential&&of.identity.essential[f[0]]!=='framgar'});
    row(f[1],function(of){var id=of.identity;if(!id)return txt('Ingen avläsning','q');
      var st=id.essential[f[0]];var v=f[0]==='kontakt'?[id.fields.address.value,id.fields.phone.value].filter(Boolean).join(' · '):id.fields[f[0]].value;
      var td=el('td',{});var s=st==='framgar'?{k:'ok',i:'✓',t:'Framgår'}:st==='ej_lasbar'?{k:'q',i:'?',t:'Kunde inte avläsas säkert'}:{k:'q',i:'?',t:'Framgår inte'};
      td.appendChild(el('span',{class:'cv '+s.k},el('span',{class:'ic','aria-hidden':'true',text:s.i}),el('span',{text:' '+s.t})));if(v)td.appendChild(el('small',{text:v}));return td},anyBad);
  });
  t.appendChild(tb);wrap.appendChild(t);return wrap;
}
var lastOrderForLink=null;
function buyLinkNode(o){
  // Skrivskyddad resultatvy (resultatlänk #r=): ingen order i webbläsaren ⇒ bara den neutrala köp-/hjälpsidan, ingen personlig länk, ingen ångra-länk.
  if(o&&o.readOnly)return el('p',{class:'noprint',id:'buylinkp'},el('a',{id:'buylink',href:'/jamfor/kop/',text:'Ditt köp och hjälp'}),' – avtal, villkor och reklamation. Din personliga ångerlänk finns i bekräftelsemejlet.');
  var kopHref='/jamfor/kop/#o='+encodeURIComponent(state.order.id)+'&t='+encodeURIComponent(state.order.token);
  if(isP(state.cfg)){
    // Policy P: neutral köp- och hjälplänk. Finns ångerrätten faktiskt kvar (ofullständig/oklar leverans) visas en tydligt märkt, normalstor Ångra-länk – aldrig gömd under Läs mer. Full giltig leverans: ingen ångerreklam.
    var rg=o&&o.rights,rightHere=!(rg&&rg.angerratt==='upphord');
    var bp=el('p',{class:'noprint',id:'buylinkp'},el('a',{id:'buylink',href:kopHref,text:'Ditt köp och hjälp'}),' – avtal, villkor och reklamation.');
    if(rightHere){bp.appendChild(document.createTextNode(' '));bp.appendChild(el('a',{id:'angralink',class:'btn ghost',href:kopHref,text:'Ångra avtalet'}))}
    return bp;
  }
  return el('p',{class:'noprint',id:'buylinkp'},el('a',{id:'buylink',href:kopHref,text:'Ditt köp och villkor'}),' – avtal, villkor, hjälp och reklamation samt ångra köpet när ångerrätt finns.');
}
// Efter lyckad källkvittens kan rätten ha upphört: hämta ordern på nytt och bygg om länkraden (så en fullt giltig leverans aldrig lämnar en kvarvarande Ångra-länk).
function syncBuyLink(){
  if(!isP(state.cfg)||!state.order)return;
  api('GET','/compare/orders/'+state.order.id,{token:state.order.token}).then(function(r){var o=r.json&&r.json.order,old=$('buylinkp');if(!o||!old||!old.parentNode)return;lastOrderForLink=o;old.parentNode.replaceChild(buyLinkNode(o),old)},function(){});
}
// D07-rättelse: kundbekräftade OFFENTLIGA Google Maps-profiler per offert ur rapportens eget innehåll (frusen revision, ev. uppdaterad status). Inga omdömen, betyg eller antal.
function srcCardsBlock(R,o){
  var cards=R.sourceCards||[],live=o&&o.sourceLive&&Array.isArray(o.sourceLive.cards)?o.sourceLive:null;
  var use=live?live.cards:cards;
  if(!use.length||use.every(function(c){return c.state==='ej_aktiverad'}))return null;
  var box=el('div',{id:'srcprofiles',class:'card'},el('b',{text:'Företagens offentliga profiler (bekräftade av dig)'}));
  use.forEach(function(c){
    var of=R.offers.filter(function(x){return x.index===c.offerIndex})[0],lab=(of&&of.label)||('Offert '+(c.offerIndex+1));
    var row=el('div',{class:'scope','data-profile':String(c.offerIndex)});
    row.appendChild(el('b',{text:lab+': '+(c.firm?[c.firm.name,c.firm.city,c.firm.domain].filter(Boolean).join(', '):'ingen firma bekräftad')}));
    var g=c.google||{};
    if(g.profileUrl&&/^https:\/\/www\.google\.com\/maps\//.test(g.profileUrl)){
      var p=el('p',{style:'margin:4px 0'});p.appendChild(document.createTextNode('Google: kundbekräftad offentlig profil'+(g.confirmedAt?' (bekräftad '+new Date(g.confirmedAt).toLocaleString('sv-SE')+')':'')+'. '));
      p.appendChild(el('a',{href:g.profileUrl,target:'_blank',rel:'noopener noreferrer',text:'Öppna profilen hos Google Maps'}));row.appendChild(p);
    }else row.appendChild(el('p',{class:'hint',text:'Google: '+(g.text||'ingen bekräftad profil')+'.'}));
    if(c.trustpilot&&c.trustpilot.state&&c.trustpilot.state!=='ej_aktiverad')row.appendChild(el('p',{class:'hint',text:'Trustpilot: '+(c.trustpilot.text||'okänt')+'.'}));
    box.appendChild(row);
  });
  var fz=R.sourcesFrozenAt||R.createdAt;
  box.appendChild(el('p',{class:'hint',text:'Länken öppnar företagets offentliga sida hos Google. Här visas inga omdömen, betyg eller antal. PDF:en i mejlet visar läget vid leverans ('+new Date(fz).toLocaleString('sv-SE')+')'+(live&&live.changedSinceDelivery?' och har inte uppdaterats. Den här visningen är uppdaterad '+new Date(live.asOf).toLocaleString('sv-SE')+'.':'.')}));
  return box;
}
// ---------- D17: förkontroll av min offert (hantverkarens egen offert före utskick) ----------
// Allt som visas är textContent. Tilläggstexter och PDF härleds på servern ur EXAKT de värden hantverkaren bekräftat (samma revision).
var CK_STAT={ok:'Stämmer',fel:'Fel',fraga:'Oklart',flagga:'Notera',ej_bedombar:'Går inte att bedöma'};
var CK_CLS={ok:'ok',fel:'bad',fraga:'warn',flagga:'warn',ej_bedombar:'warn'};
var CK_PT={fast:'Fast pris',ungefarligt:'Ungefärligt pris',lopande:'Löpande räkning'};
function ckCopy(btn,text){
  function done(ok){var o=btn.getAttribute('data-l')||btn.textContent;btn.setAttribute('data-l',o);btn.textContent=ok?'Kopierad ✓':'Markera och kopiera själv';setTimeout(function(){btn.textContent=o},2500)}
  try{if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(function(){done(true)},function(){done(false)});return}}catch(e){}
  done(false);
}
function ckParseKr(s){var t=String(s==null?'':s).replace(/[\s ]|kr\.?$/gi,'').trim();if(!t)return null;if(!/^\d{1,8}$/.test(t))return NaN;return Number(t)}
function ckFile(b64,name){
  var bin=atob(b64),u=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);
  var url=URL.createObjectURL(new Blob([u],{type:'application/pdf'}));
  var a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(url)},4000);
}
function ckChrome(){var n=$('scopenote');if(n)n.classList.add('hidden')}
function renderCheck(R,o){
  mResult(o&&o.id||'x',o&&o.readOnly?'readonly':undefined);
  ckChrome();
  var host=$('rep');host.textContent='';show('rep',true);
  host.appendChild(el('h2',{id:'h-rep',text:'Din förkontroll'}));
  host.appendChild(el('p',{class:'hint',text:'Det här är din egen offert, kontrollerad innan du skickar den. Allt nedan bygger på vad som står i offerten. Det du inte själv bekräftar förblir okänt och hamnar aldrig i tilläggen.'}));
  var ord=R.original||{};
  // 1. Vad vi läste
  var rd=el('div',{class:'card'},el('h3',{style:'margin-top:0',text:'Så här läste vi din offert'}));
  var rows=[];
  var vb=function(m){return m==='inkl'?' inklusive moms':m==='exkl'?' exklusive moms':' (momsbas framgår inte)'};
  if(ord.priceType)rows.push(['Pristyp i offerten',CK_PT[ord.priceType]||ord.priceType]);
  if(ord.laborSumSek!=null)rows.push(['Arbete',kr(ord.laborSumSek)+vb(ord.vatMode)]);
  if(ord.materialSumSek!=null)rows.push(['Material',kr(ord.materialSumSek)+vb(ord.vatMode)]);
  if(ord.totalSumSek!=null)rows.push(['Totalsumma',kr(ord.totalSumSek)+vb(ord.totalVatBasis)]); // totalsummans EGEN momsbas, aldrig radernas
  if(ord.rotAmountSek!=null)rows.push(['ROT-avdrag i offerten',kr(ord.rotAmountSek)]);
  if(!rows.length)rows.push(['Belopp','Inga belopp kunde läsas säkert ur offerten.']);
  var dl=el('dl',{class:'ckdl'});rows.forEach(function(r){dl.appendChild(el('dt',{text:r[0]}));dl.appendChild(el('dd',{text:r[1]}))});
  rd.appendChild(dl);rd.appendChild(el('p',{class:'hint',text:'Beloppen är avlästa och kan innehålla avläsningsfel. Ditt original är oförändrat.'}));
  host.appendChild(rd);
  // 2. Kontroller
  host.appendChild(el('h3',{text:'Kontroller'}));
  (R.findings||[]).forEach(function(f){
    var c=el('div',{class:'card','data-finding':f.id},el('div',{class:'ckhead'},el('b',{text:f.title}),el('span',{class:'tag '+(CK_CLS[f.status]||'warn'),text:CK_STAT[f.status]||f.status})),el('p',{style:'margin:6px 0 0',text:f.text}));
    host.appendChild(c);
  });
  if(R.questions&&R.questions.length){
    var qc=el('div',{class:'card'},el('h3',{style:'margin-top:0',text:'Frågor din kund sannolikt ställer'}));
    var ul=el('ul',{class:'tight'});R.questions.forEach(function(q){ul.appendChild(el('li',{text:q.text}))});qc.appendChild(ul);host.appendChild(qc);
  }
  var nd=el('div',{id:'ckout'});
  if(o.readOnly){
    host.appendChild(el('div',{class:'warnbox',id:'ckro',text:'Den här länken är skrivskyddad och visar bara kontrollerna. För att bekräfta uppgifter och hämta tilläggstexter och PDF-bilaga, öppna förkontrollen med den ursprungliga länken i webbläsaren där du köpte den. Du behöver inte köpa igen.'}));
  }else{
    host.appendChild(el('h3',{text:'Bekräfta det som ska in i offerten'}));
    host.appendChild(el('p',{class:'hint',text:'Fyll bara i det du själv står för. Tomma fält blir inga påståenden. Belopp anges i hela kronor inklusive moms, utan decimaler.'}));
    var SK=['priceType','laborInclVat','materialInclVat','otherInclVat','rotMode','plannedStart','plannedEnd','includes','excludes','cleaning','removal','warranty'];
    // Formulärets proveniens bor i minnet (inte i adress/lagring) så att router fram/tillbaka inte återställer det kunden ändrat eller tömt.
    // st per fält: none | suggested (AI-förslag, obekräftat) | confirmed (sparad revision) | dirty (kunden ändrat) | cleared (kunden tömt ett förslag/en sparad uppgift).
    var FSall=G.ws.checkForm=G.ws.checkForm||{};
    var FS=FSall[o.id]=FSall[o.id]||{st:{},val:{},base:{},baseSt:{},rev:0,confirmed:null};
    var banner=el('div',{class:'warnbox hidden',id:'ckbanner',role:'status'},el('b',{text:'Avlästa förslag – inte bekräftade. '}),'Vi har läst ut några uppgifter ur din offert och lagt in dem som förslag nedan. Kontrollera dem mot ditt original och ändra det som inte stämmer. Först när du trycker på Bekräfta används uppgifterna i tillägget. Allt du lämnar tomt förblir okänt.');
    host.appendChild(banner);
    var form=el('form',{id:'ckform',class:'card',novalidate:'novalidate'});
    var TAGW={suggested:'Avläst förslag – inte bekräftat',confirmed:'Bekräftat',dirty:'Ändrat – inte bekräftat',cleared:'Tömt – inte bekräftat'};
    function fld(label,inp,id,hint,key){
      var lb=el('label',{class:'t','for':id,text:label});form.appendChild(lb);
      var tg=el('span',{class:'cktag hidden',id:'cktag-'+key,'data-st':'none'});form.appendChild(tg);
      inp.setAttribute('data-ck',key);form.appendChild(inp);
      if(hint)form.appendChild(el('p',{class:'hint',text:hint}));
      form.appendChild(el('p',{class:'hint hidden',id:'ckhelp-'+key,'data-help':key}));
    }
    function sel(id,opts){var s=el('select',{id:id,style:'width:100%;min-height:48px;font:16px Barlow,sans-serif;padding:8px;border:1px solid var(--fl);border-radius:8px;background:var(--field);color:var(--ink)'});opts.forEach(function(p){s.appendChild(el('option',{value:p[0],text:p[1]}))});return s}
    function num(id){return el('input',{type:'text',id:id,inputmode:'numeric',autocomplete:'off',maxlength:'12',placeholder:'t.ex. 25000'})}
    fld('Pristyp',sel('ck-priceType',[['','Välj…'],['fast','Fast pris'],['ungefarligt','Ungefärligt pris'],['lopande','Löpande räkning']]),'ck-priceType','','priceType');
    fld('Arbete, kr inklusive moms',num('ck-laborInclVat'),'ck-laborInclVat','','laborInclVat');
    fld('Material, kr inklusive moms',num('ck-materialInclVat'),'ck-materialInclVat','','materialInclVat');
    fld('Övrigt, kr inklusive moms (skriv 0 om inget övrigt)',num('ck-otherInclVat'),'ck-otherInclVat','En komplett total räknas först när arbete, material och övrigt är ifyllda. Tomt betyder okänt, aldrig 0.','otherInclVat');
    fld('ROT-avdrag',sel('ck-rotMode',[['','Välj…'],['villkorat','Villkorat ROT-avdrag (om kunden har rätt till det)'],['ingen','Inget ROT-avdrag']]),'ck-rotMode','','rotMode');
    fld('Planerad start',el('input',{type:'date',id:'ck-plannedStart'}),'ck-plannedStart','','plannedStart');
    fld('Planerat klart',el('input',{type:'date',id:'ck-plannedEnd'}),'ck-plannedEnd','','plannedEnd');
    fld('Det här ingår (en rad per punkt, högst 8)',el('textarea',{id:'ck-includes',maxlength:'1200'}),'ck-includes','','includes');
    fld('Det här ingår inte (en rad per punkt, högst 8)',el('textarea',{id:'ck-excludes',maxlength:'1200'}),'ck-excludes','','excludes');
    fld('Städning efter arbetet',sel('ck-cleaning',[['','Välj…'],['ingar','Ingår'],['ingar_inte','Ingår inte']]),'ck-cleaning','','cleaning');
    fld('Bortforsling av avfall',sel('ck-removal',[['','Välj…'],['ingar','Ingår'],['ingar_inte','Ingår inte']]),'ck-removal','','removal');
    fld('Garanti (bara om du lämnar en)',el('input',{type:'text',id:'ck-warranty',maxlength:'200',autocomplete:'off'}),'ck-warranty','Lämna tomt om du inte lämnar någon garanti. Vi lägger aldrig till en.','warranty');
    var msg=el('p',{class:'hint',id:'ckmsg',role:'status','aria-live':'polite'});
    var unsaved=el('p',{class:'warnbox hidden',id:'ckunsaved',role:'status'});
    var save=el('button',{type:'submit',class:'btn acc block',id:'cksave',text:'Bekräfta uppgifterna och skapa tillägg'});
    form.appendChild(save);form.appendChild(msg);host.appendChild(form);host.appendChild(unsaved);host.appendChild(nd);
    var token=state.order&&state.order.token;
    function getF(k){var e=$('ck-'+k);return e?e.value:''}
    function setF(k,v){var e=$('ck-'+k);if(e)e.value=v}
    function strOf(k,v){if(v==null)return '';if(k==='includes'||k==='excludes')return (v||[]).join('\n');return String(v)}
    // Förslag (revision 0): bara känd giltig pristyp och avlästa HELA kronor med uttryckligen inklusive-moms på RADERNA (totalens momsbas gäller inte raderna).
    // Aldrig null→0, aldrig omräkning exkl/okänd moms, aldrig decimaler, aldrig differens mellan totaler, aldrig datum/garanti/ROT/omfattning.
    var WHOLE=function(x){return typeof x==='number'&&isFinite(x)&&Math.floor(x)===x&&x>=0&&x<=10000000};
    function suggestFor(k){
      var vm=ord.vatMode;
      if(k==='priceType')return CK_PT[ord.priceType]?ord.priceType:null;
      var src={laborInclVat:ord.laborSumSek,materialInclVat:ord.materialSumSek,otherInclVat:ord.otherSumSek}[k];
      if(src===undefined)return null;
      return vm==='inkl'&&WHOLE(src)?String(src):null;
    }
    function helpFor(k){
      var src={laborInclVat:ord.laborSumSek,materialInclVat:ord.materialSumSek,otherInclVat:ord.otherSumSek}[k];
      if(src===undefined||src==null||suggestFor(k)!==null)return '';
      if(ord.vatMode==='exkl')return 'Offerten anger raderna exklusive moms. Vi räknar inte om det åt dig – fyll i beloppet inklusive moms själv om du vill bekräfta det.';
      if(ord.vatMode!=='inkl')return 'Momsbasen för raderna framgår inte säkert av offerten, så vi föreslår inget belopp. Fyll i beloppet inklusive moms själv om du vill bekräfta det.';
      return 'Beloppet i offerten är inte ett helt antal kronor, så vi föreslår inget. Fyll i hela kronor själv om du vill bekräfta det.';
    }
    function tagUpd(k){
      var tg=$('cktag-'+k);if(!tg)return;var s=FS.st[k]||'none';
      if(s==='none'){tg.classList.add('hidden');tg.textContent='';tg.setAttribute('data-st','none');return}
      tg.textContent=TAGW[s]+(s==='confirmed'&&FS.rev?' (revision '+FS.rev+')':'');tg.setAttribute('data-st',s);tg.classList.remove('hidden');
    }
    function bannerUpd(){var any=SK.some(function(k){return FS.st[k]==='suggested'});banner.classList.toggle('hidden',!(any&&!FS.rev))}
    function collect(){
      var v={},e=null;
      ['priceType','rotMode','plannedStart','plannedEnd','cleaning','removal'].forEach(function(k){var x=$('ck-'+k).value;if(x)v[k]=x});
      ['laborInclVat','materialInclVat','otherInclVat'].forEach(function(k){var n=ckParseKr($('ck-'+k).value);if(n===null)return;if(isNaN(n)){e='Belopp anges som hela kronor, bara siffror.';return}v[k]=n});
      ['includes','excludes'].forEach(function(k){var ls=$('ck-'+k).value.split(/\r?\n/).map(function(s){return s.trim()}).filter(Boolean);if(ls.length)v[k]=ls});
      var w=$('ck-warranty').value.trim();if(w)v.warranty=w;
      if(/[<>]/.test(JSON.stringify(v)))e='Texten får inte innehålla tecknen < eller >.';
      if(!e&&v.plannedStart&&v.plannedEnd&&v.plannedEnd<v.plannedStart)e='Planerat klart kan inte vara före planerad start.';
      return {values:v,error:e};
    }
    function canon(v){return JSON.stringify(Object.keys(v||{}).sort().map(function(k){return [k,v[k]]}))}
    function unsavedUpd(){
      if(!FS.rev||!FS.confirmed){unsaved.classList.add('hidden');return}
      var c=collect(),same=!c.error&&canon(c.values)===canon(FS.confirmed);
      unsaved.classList.toggle('hidden',same);
      if(!same)unsaved.textContent='Du har ändringar som inte är bekräftade. Tilläggstexterna och PDF-bilagan nedan gäller senast bekräftade revision '+FS.rev+'. Tryck på Bekräfta för att få en ny.';
    }
    form.addEventListener('input',onEdit);form.addEventListener('change',onEdit);
    function onEdit(ev){
      var t=ev.target,k=t&&t.getAttribute&&t.getAttribute('data-ck');if(!k)return;
      var cur=getF(k),base=FS.base[k]||'';
      FS.val[k]=cur;
      if(cur===base)FS.st[k]=base!==''?FS.baseSt[k]:'none';
      else FS.st[k]=(cur===''&&base!=='')?'cleared':'dirty';
      tagUpd(k);bannerUpd();unsavedUpd();
    }
    // Slår ihop serverns vy med kundens egna ändringar: ändrat/tömt fält har företräde, sparad revision har företräde framför AI-förslag,
    // och ett sent svar fyller aldrig tillbaka något kunden tagit bort. force = hela vyn ersätts (nyare revision från annan flik).
    function applyServer(d,force){
      if(!form.isConnected)return;
      var rev=d.revision||0,vals=d.values||{};
      SK.forEach(function(k){
        var keep=!force&&(FS.st[k]==='dirty'||FS.st[k]==='cleared');
        if(rev>0){var v=strOf(k,vals[k]);FS.base[k]=v;FS.baseSt[k]='confirmed';if(!keep){setF(k,v);FS.val[k]=v;FS.st[k]=v!==''?'confirmed':'none'}else{FS.st[k]=(getF(k)===v)?(v!==''?'confirmed':'none'):(getF(k)===''&&v!==''?'cleared':'dirty')}}
        else{
          var sg=suggestFor(k);
          if(sg!==null){FS.base[k]=sg;FS.baseSt[k]='suggested';if(!keep&&FS.st[k]!=='suggested'&&(FS.val[k]===undefined||FS.val[k]==='')&&getF(k)===''){setF(k,sg);FS.val[k]=sg;FS.st[k]='suggested'}else if(!keep&&FS.st[k]==='suggested'){setF(k,sg)}}
        }
        tagUpd(k);
      });
      FS.rev=rev;FS.confirmed=rev>0?JSON.parse(JSON.stringify(vals)):null;
      SK.forEach(tagUpd);bannerUpd();unsavedUpd();
    }
    // Återmontering (router fram/tillbaka): kundens egna värden och proveniens ligger kvar i minnet och återställs innan servern svarar.
    SK.forEach(function(k){if(FS.val[k]!==undefined)setF(k,FS.val[k]);tagUpd(k);var h=helpFor(k),he=$('ckhelp-'+k);if(he&&h){he.textContent=h;he.classList.remove('hidden')}});
    bannerUpd();
    function drawOut(d){
      nd.textContent='';if(!d||!d.outputs||!d.revision)return;
      var out=d.outputs;
      var head=el('div',{class:'card acc',id:'ckrev'},el('h3',{style:'margin-top:0',text:'Tillägg till din offert – senast bekräftad revision '+d.revision}),el('p',{class:'hint',text:'Revisionskod '+out.code+'. Texterna och PDF-bilagan innehåller exakt samma bekräftade uppgifter. Bekräftat '+d.saves+' av '+d.limits.saves+' gånger, PDF hämtad '+d.exports+' av '+d.limits.exports+'.'}));
      nd.appendChild(head);
      if(out.draft){var dl2=el('ul',{class:'tight'});(out.unresolved||[]).forEach(function(u){dl2.appendChild(el('li',{text:u.label}))});nd.appendChild(el('div',{class:'warnbox',id:'ckdraft',role:'status'},el('b',{text:'Utkast – tillägget är inte komplett.'}),el('p',{style:'margin:4px 0',text:'Kvarstår att bekräfta innan du skickar offerten:'}),dl2))}
      (out.sections||[]).forEach(function(s){
        var c=el('div',{class:'card','data-section':s.id},el('b',{text:s.title}),el('p',{class:'cktext',style:'margin:6px 0',text:s.text}));
        var b=el('button',{type:'button',class:'btn ghost',text:'Kopiera text'});b.addEventListener('click',function(){ckCopy(b,s.text)});c.appendChild(b);nd.appendChild(c);
      });
      if(!(out.sections||[]).length)nd.appendChild(el('p',{class:'hint',text:'Inget bekräftat än, så det finns inget att lägga till.'}));
      var row=el('div',{class:'ckacts'});
      var ba=el('button',{type:'button',class:'btn',id:'ckcopyall',text:'Kopiera alla tillägg'});ba.addEventListener('click',function(){ckCopy(ba,out.text)});row.appendChild(ba);
      var bp=el('button',{type:'button',class:'btn acc',id:'ckpdf',text:'Hämta PDF-bilaga till kunden (revision '+d.revision+')'});
      bp.addEventListener('click',async function(){
        bp.disabled=true;msg.textContent='';
        try{var r=await api('POST','/compare/orders/'+o.id+'/check/export',{token:token,body:{revision:d.revision}});
          if(r.status===409&&r.json.revisionChanged){applyServer(r.json,true);d=r.json;drawOut(d);msg.textContent='En nyare revision ('+d.revision+') fanns i en annan flik. Vyn är uppdaterad – ingen PDF hämtades. Kontrollera och hämta PDF:en igen.';bp.disabled=false;return}
          if(r.status===200&&r.json.pdfBase64){ckFile(r.json.pdfBase64,r.json.filename||'Tillagg-till-offert.pdf');if(r.json.revision!==d.revision||r.json.code!==d.outputs.code){msg.textContent='Revisionen ändrades under hämtningen. Vyn uppdateras.';var g2=await api('GET','/compare/orders/'+o.id+'/check',{token:token});if(g2.status===200){applyServer(g2.json,true);d=g2.json;drawOut(d)}bp.disabled=false;return}
            msg.textContent='PDF hämtad (revision '+r.json.revision+', kod '+r.json.code+').';d.exports=r.json.exports;drawOut(d)}
          else msg.textContent=r.status===429?'Du har hämtat PDF:en det antal gånger som ingår.':r.status===410?'Förkontrollen har gått ut och är raderad.':(r.json&&r.json.error)||'Det gick inte att hämta PDF:en just nu.';
        }catch(e){msg.textContent='Det gick inte att hämta PDF:en just nu.'}
        bp.disabled=false;
      });row.appendChild(bp);nd.appendChild(row);
      nd.appendChild(el('p',{class:'hint',text:'Lägg texterna i din offert och skicka den själv. Vi skickar ingenting till din kund.'}));
    }
    var saving=false;
    form.addEventListener('submit',async function(ev){
      ev.preventDefault();if(saving)return;msg.textContent='';var c=collect();
      if(c.error){msg.textContent=c.error;return}
      if(!Object.keys(c.values).length){msg.textContent='Fyll i minst en uppgift du vill bekräfta.';return}
      saving=true;save.disabled=true;
      try{var r=await api('PUT','/compare/orders/'+o.id+'/check',{token:token,body:{values:c.values}});
        if(r.status===200&&r.json.ok){
          msg.textContent=r.json.unchanged?'Inget ändrat sedan förra bekräftelsen (revision '+r.json.revision+').':'Bekräftat som revision '+r.json.revision+'.';
          // Efter den aktiva bekräftelsen är hela det som visas bekräftat; från nu är det serverns revision som gäller.
          SK.forEach(function(k){var v=getF(k);FS.base[k]=v;FS.baseSt[k]='confirmed';FS.val[k]=v;FS.st[k]=v!==''?'confirmed':'none'});
          FS.rev=r.json.revision;FS.confirmed=JSON.parse(JSON.stringify(c.values));
          SK.forEach(tagUpd);bannerUpd();unsavedUpd();drawOut(r.json)}
        else msg.textContent=r.status===429?'Du har bekräftat det antal gånger som ingår.':r.status===410?'Förkontrollen har gått ut och är raderad.':(r.json&&r.json.message)||(r.json&&r.json.error)||'Det gick inte att spara just nu.';
      }catch(e){msg.textContent='Det gick inte att spara just nu.'}
      saving=false;save.disabled=false;
    });
    api('GET','/compare/orders/'+o.id+'/check',{token:token}).then(function(r){if(r.status===200&&r.json.ok){applyServer(r.json,false);drawOut(r.json)}}).catch(function(){});
  }
  if(R.receipt&&R.receipt.product)host.appendChild(el('p',{class:'hint',text:'Köp: '+R.receipt.product+', '+kr(R.receipt.amountOre/100)+' inklusive moms. Kvitto och avtal finns i mejlet du fick.'}));
  var dc=el('div',{class:'card'},el('h3',{style:'margin-top:0',text:'Gott att veta'}));var du=el('ul',{class:'tight'});(R.disclaimers||[]).forEach(function(t){du.appendChild(el('li',{text:t}))});dc.appendChild(du);host.appendChild(dc);
  host.appendChild(el('p',{class:'hint',text:'Förkontrollen sparas i 24 timmar efter leverans och raderas sedan.'}));
}
function renderReport(R,o){
  mResult(o&&o.id||'x',o&&o.readOnly?'readonly':undefined);
  if(R&&R.kind==='check')return renderCheck(R,o);
  var host=$('rep');host.textContent='';show('rep',true);
  host.appendChild(el('h2',{id:'h-rep',text:'Din jämförelse'}));
  var n=R.offers.length;window.__lastN=n;
  // 1. Kort ingress: bara vad som är viktigast; resten under Visa mer.
  host.appendChild(el('p',{class:'hint',text:'Offerterna sida vid sida. ✓ = offerten säger uttryckligen att det ingår. ? = framgår inte (fråga hantverkaren). Beloppen är avlästa – kontrollera mot originalet.'}));
  var rk=R.ranking,L=R.offers.map(function(x){return x.label});
  var rb=el('div',{class:rk.shown?'okbox':'warnbox','data-ranking':rk.shown?'ja':'nej'});
  if(rk.shown)rb.appendChild(el('p',{style:'margin:0',text:rk.lowest?'Lägst angivet belopp: '+L[rk.lowest.index]+' ('+kr(rk.lowest.diffKr)+' lägre än näst lägsta, '+String(rk.lowest.diffPct).replace('.',',')+' %). Det säger inget om kvalitet eller om det som inte står i offerterna.':'Beloppen är lika på samma bas.'}));
  else rb.appendChild(el('p',{style:'margin:0',text:'Priserna går inte att ställa mot varandra rakt av – se raderna som skiljer nedan. Ingen offert pekas ut som billigast.'}));
  host.appendChild(rb);
  // 2. Sortera efter (en liten meny) + kolumner
  var srt=el('div',{class:'sortbar noprint'});
  var sl=el('label',{for:'sortby',text:'Sortera efter'});var sel=el('select',{id:'sortby'});
  SORTS.forEach(function(x){var op=el('option',{value:x.v,text:x.t});
    if(x.v==='price'&&!rk.shown){op.disabled=true;op.textContent=x.t+' (ej jämförbart)'}
    if(x.v==='rating'){op.setAttribute('data-rating','1');if(!ratingAvailable(n)){op.disabled=true;op.textContent=x.t+' (kräver Trustpilot-uppgifter för minst två firmor)'}}
    sel.appendChild(op)});
  srt.appendChild(sl);srt.appendChild(sel);
  var sn=el('p',{class:'hint',id:'sortnote',role:'status','aria-live':'polite'});
  srt.appendChild(sn);host.appendChild(srt);
  var gridHost=el('div',{id:'cmpgrid'});host.appendChild(gridHost);
  var pick=el('div',{class:'pickbar noprint',id:'pickbar'});host.appendChild(pick);
  var NOTE={upload:'',price:'Sorterat efter lägst jämförbart pris (samma moms- och ROT-bas, samma omfattning). Det är ingen rekommendation.',fewopen:'Sorterat efter minst antal uppgifter att reda ut på en fast uppsättning poster. Få oklarheter betyder inte att hantverkaren är bäst.',mostopen:'Sorterat efter flest uppgifter att reda ut. Offerter som inte går att bedöma säkert står sist.',rating:'Sorterat efter Trustpilots totalbetyg för firmorna. Antalet omdömen skiljer sig mycket mellan firmor och betyg säger inget om just det här jobbet – ingen rekommendation. Firmor utan Trustpilot-uppgift står sist. Googles betyg visas i Googles egen ruta och kan inte sorteras.'};
  var shown=[0,1];
  function draw(){
    var mode=sel.value;gridHost.textContent='';
    var g=buildGrid(R,mode);gridHost.appendChild(g);
    sn.textContent=(NOTE[mode]||'')+(mode==='fewopen'||mode==='mostopen'||mode==='rating'?' Lika värden delar placering. Offerter som inte går att bedöma säkert har ingen placering.':'');
    drawPick();applyCols();srcCompactAll();ratingSortSync();
  }
  function applyCols(){ // smal skärm: två offerter åt gången (valda i listorna), aldrig fyra krympta kolumner
    var tbl=gridHost.querySelector('table.cmp');if(!tbl)return;
    var narrow=window.matchMedia('(max-width:720px)').matches&&n>2;
    tbl.setAttribute('data-narrow',narrow?'1':'0');
    tbl.querySelectorAll('[data-col]').forEach(function(c){var k=Number(c.getAttribute('data-col'));c.classList.toggle('colhide',narrow&&shown.indexOf(k)<0)});
  }
  function drawPick(){
    pick.textContent='';if(n<=2)return;
    pick.appendChild(el('p',{class:'hint',text:'På smal skärm visas två offerter åt gången. Välj vilka du vill jämföra:'}));
    [0,1].forEach(function(slot){var s2=el('select',{'aria-label':'Offert '+(slot+1)+' att visa'});R.offers.forEach(function(of,k){var op=el('option',{value:String(k),text:of.label});if(k===shown[slot])op.selected=true;s2.appendChild(op)});
      s2.addEventListener('change',function(){var v=Number(s2.value);shown[slot]=v;if(shown[0]===shown[1])shown[1-slot]=(v+1)%n;drawPick();applyCols()});pick.appendChild(s2)});
  }
  sel.addEventListener('change',draw);
  window.addEventListener('resize',applyCols);cleanups.push(function(){window.removeEventListener('resize',applyCols)});
  draw();
  // 3. Frågor per offert (kompakt, hopfällt)
  host.appendChild(el('h3',{text:'Frågor att ställa till varje hantverkare'}));
  R.questions.forEach(function(q){
    var det=el('details',{},el('summary',{text:q.label+' ('+q.questions.length+' frågor)'}));
    var ul=el('ul',{class:'tight'});q.questions.forEach(function(x){ul.appendChild(el('li',{text:x.text}))});det.appendChild(ul);
    if(!q.questions.length)det.appendChild(el('p',{class:'hint',text:'Inga särskilda frågor utifrån jämförelsen.'}));
    host.appendChild(det);
  });
  // 4. EN sammanhållen fördjupning: jämförbarhet, skillnader, fler punkter, metod, begränsningar, källor
  var more=el('details',{id:'more',class:'morebox'},el('summary',{text:'Visa mer: jämförbarhet, skillnader, metod och omdömen'}));
  var ds=R.decisionSheet;
  more.appendChild(el('h3',{text:'Jämförbarhet'}));more.appendChild(el('p',{text:R.comparability.reasons.join(' ')}));
  if(!rk.shown){var ur=el('ul',{class:'tight'});rk.reasons.forEach(function(t){ur.appendChild(el('li',{text:t}))});more.appendChild(ur)}
  else (rk.reasons||[]).forEach(function(t){more.appendChild(el('p',{class:'hint',text:t}))});
  if(rk.shown&&rk.basis)more.appendChild(el('p',{class:'hint',text:'Pris jämförs: '+rk.basis+'.'}));
  if(ds.canCompareNow.length){more.appendChild(el('h3',{text:'Det här går att jämföra nu'}));var u=el('ul',{class:'tight'});ds.canCompareNow.forEach(function(t){u.appendChild(el('li',{text:t}))});more.appendChild(u)}
  if(ds.mustClarify.length){more.appendChild(el('h3',{text:'Det här behöver du få klarlagt innan du väljer'}));var u2=el('ul',{class:'tight'});ds.mustClarify.forEach(function(t){u2.appendChild(el('li',{text:t.text}))});more.appendChild(u2)}
  if(R.differences.length){more.appendChild(el('h3',{text:'Skillnader, viktigast först'}));var dl2=el('ul',{class:'tight'});R.differences.slice(0,12).forEach(function(d){dl2.appendChild(el('li',{text:d.text}))});more.appendChild(dl2)}
  var rest=R.scopeMatrix.filter(function(m){return ['material','arbete','resor','bortforsling','rivning','startdatum','tidplan','betalningsplan','ata','garanti','forsakring','fskatt'].indexOf(m.id)<0});
  if(rest.length){more.appendChild(el('h3',{text:'Fler punkter (övrig omfattning och villkor)'}));rest.forEach(function(m){
    var cells=el('div',{class:'cells'});m.cells.forEach(function(c,i){var cell=el('div',{class:'cell '+c.status},el('b',{text:L[i]}),el('span',{text:STATUS[c.status]}));var rf=ref(c);if(rf)cell.appendChild(el('small',{text:rf}));cells.appendChild(cell)});
    more.appendChild(el('div',{class:'scope'},el('b',{text:m.label+(m.kind==='skiljer'?'  · skiljer':m.kind==='oklart_for_nagon'?'  · oklart i någon':'')}),cells))})}
  more.appendChild(el('h3',{text:'Omdömen om företagen'}));
  SRC.ro=!!(o&&o.readOnly);SRC.roId=SRC.ro?o.id:null;
  var srcrep=el('div',{id:'srcrepwrap'},el('p',{class:'hint','data-srcmsg':'1',text:!srcOn()?'Visas inte i den här versionen. Offertjämförelsen ovan är komplett utan dem.':srcActive()?'Hämtar källstatus…':'Omdömen om företagen visas separat från rapporten, med källans eget urval, och bara i den webbläsare där du gjorde köpet (där bekräftar du rätt firma). De ingår inte i jämförelsen och är ingen bedömning av företaget. Öppna jämförelsen i den webbläsaren för att se dem.'}));more.appendChild(srcrep);
  var spb=srcCardsBlock(R,o);if(spb)more.appendChild(spb);
  more.appendChild(el('h3',{text:'Gränser och metod'}));
  var dis=el('ul',{class:'tight'});R.disclaimers.forEach(function(t){dis.appendChild(el('li',{text:t}))});more.appendChild(dis);
  host.appendChild(more);
  if(srcActive())srcStart(srcrep,'report');
  // kvitto
  var rc=R.receipt,rd=el('dl');
  [['Ordernummer',rc.orderNo],['Produkt',rc.product],['Belopp',kr(rc.amountOre/100)+' inkl. moms'],['Varav moms ('+rc.vatPct+' %)',(rc.vatOre/100).toFixed(2).replace('.',',')+' kr'],['Betald',rc.paidAt?new Date(rc.paidAt).toLocaleString('sv-SE'):'—'],['Betalningsreferens','…'+(rc.paymentRef||'')],['Säljare',rc.seller]].forEach(function(r){rd.appendChild(el('dt',{text:r[0]}));rd.appendChild(el('dd',{text:r[1]}))});
  host.appendChild(el('h3',{text:'Kvitto'}));host.appendChild(el('div',{class:'card'},rd,el('p',{class:'hint',text:rc.vatNote+' '+rc.sellerNote})));
  // förbehåll + åtgärder
  var act=el('div',{class:'noprint',style:'display:flex;gap:8px;flex-wrap:wrap;margin-top:12px'});
  var pb=el('button',{type:'button',class:'btn ghost',text:'Skriv ut / spara som PDF'});pb.addEventListener('click',function(){window.print()});
  var jb=el('button',{type:'button',class:'btn ghost',text:'Ladda ner (JSON)'});jb.addEventListener('click',function(){var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(R,null,2)],{type:'application/json'}));a.download='jamforelse-'+rc.orderNo+'.json';a.click()});
  var db=el('button',{type:'button',class:'btn ghost',text:'Radera min jämförelse'});db.addEventListener('click',async function(){
    if(!confirm('Radera jämförelsen och filerna nu? Det går inte att ångra.'))return;
    var r=await api('DELETE','/compare/orders/'+state.order.id,{token:state.order.token});
    if(r.status===200){store('jamfor_order',null);host.textContent='';host.appendChild(el('div',{class:'okbox',text:'Jämförelsen är raderad.'}));}else err('Kunde inte radera just nu.');
  });
  act.appendChild(pb);act.appendChild(jb);if(!(o&&o.readOnly))act.appendChild(db);host.appendChild(act);
  host.appendChild(el('p',{class:'hint noprint',text:'Resultatet finns kvar till '+new Date(R.expiresAt).toLocaleString('sv-SE')+'. Ladda ner om du vill spara det.'}));
  host.appendChild(buyLinkNode(o));
  host.scrollIntoView({block:'start'});
}


// ---------- D07: källor för senaste originalomdömen (Google UI Kit i webbläsaren, Trustpilot via servern) ----------
var SRC={view:null,cands:{},mounted:{},gmp:null,ver:0};
function srcCfg(){return (state.cfg&&state.cfg.sources)||null}
function srcOn(){var c=srcCfg();return !!(c&&c.active&&(c.google.state!=='ej_aktiverad'||c.trustpilot.state!=='ej_aktiverad'))}
// Orderkontext för källor: aktiv order, eller (skrivskyddad resultatvy) samma orders sparade nyckel i DEN HÄR webbläsaren. Resultatlänkens token ger ALDRIG källåtkomst.
function srcCtx(){if(state.order)return state.order;if(!SRC.roId)return null;try{var v=JSON.parse(store('jamfor_order')||'null');if(v&&v.id===SRC.roId&&v.token)return v}catch(e){}return null}
function srcActive(){return srcOn()&&!!srcCtx()}
function srcApi(method,sub,body){var cx=srcCtx();if(method!=='GET'&&state.resumeSrc)state.srcChanged=true;return api(method,'/compare/orders/'+cx.id+'/sources'+(sub||''),{token:cx.token,body:body})}
// Google: skriptet laddas FÖRST när kunden uttryckligen öppnar omdömena. __GMP_LOADER__ finns bara för offlineprov (attrapp).
// D11-P1: EN enda SDK-laddning per sida (singleflight) med Googles callback-parameter. Skriptets onload är inte beredskapen (importLibrary kan saknas då);
// beredskap = Googles callback, därefter importLibrary('places'). Timeout avbryter bara VÄNTAN, inte laddningen: ett nytt försök väntar in samma laddning och
// lägger aldrig till en andra <script> (dubbel laddning gav Loader.provide-fel). Ny <script> tillåts bara efter ett verkligt nätfel (onerror), och då först
// efter att den felande taggen tagits bort. Resultatet (ready/failed) delas av alla Search/Details-monteringar.
function gmpSdk(key){
  var S=SRC.sdk;
  if(S&&S.state!=='failed')return S.p;
  var s={state:'loading'};
  s.p=new Promise(function(res,rej){s.res=res;s.rej=rej});
  s.p.catch(function(){}); // förhindrar ohanterad avvisning när ingen väntar
  SRC.sdk=s;
  function fail(e){if(s.state==='loading'){s.state='failed';try{if(s.tag&&s.tag.parentNode)s.tag.parentNode.removeChild(s.tag)}catch(x){}try{delete window.__gmpSdkReady}catch(x){window.__gmpSdkReady=undefined}s.rej(e)}}
  function ready(){
    if(s.state!=='loading')return;
    if(!(window.google&&google.maps&&google.maps.importLibrary)){fail(new Error('saknas'));return}
    google.maps.importLibrary('places').then(function(l){if(s.state==='loading'){s.state='ready';s.res(l)}},function(e){fail(e)});
  }
  if(window.google&&google.maps&&google.maps.importLibrary){ready();return s.p}
  window.__gmpSdkReady=ready;
  var sc=document.createElement('script');
  sc.src='https://maps.googleapis.com/maps/api/js?key='+encodeURIComponent(key)+'&v=beta&loading=async&libraries=places&language=sv&region=SE&callback=__gmpSdkReady';
  sc.async=true;sc.setAttribute('data-gmp-sdk','1');
  sc.onerror=function(){fail(new Error('nät'))};
  s.tag=sc;document.head.appendChild(sc);
  return s.p;
}
// Ladda Googles SDK (delad). __GMP_LOADER__ finns bara för offlineprov (attrapp). Väntetiden är begränsad; laddningen själv fortsätter.
function gmpLoad(key){
  if(window.__GMP_LOADER__)return window.__GMP_LOADER__(key);
  var p=gmpSdk(key);
  return new Promise(function(res,rej){
    var t=setTimeout(function(){rej(new Error('timeout'))},window.__GMP_SDK_WAIT||12000);
    p.then(function(l){clearTimeout(t);res(l)},function(e){clearTimeout(t);rej(e)});
  });
}
// Googles egna UI Kit-element (beta-kanalen). Källa: developers.google.com/maps/documentation/javascript/places-ui-kit/advanced-place-details.
// <gmp-advanced-place-details> med <gmp-place-details-place-request place=...>; innehållselementen är direkta barn. Granskad: reviews med
// rank-preference="newest" (senaste först). Ingen query/filter/språk-/sentimentfiltrering och inga AI-sammanfattningar. Attribution visas.
// Senaste först: primärdocs (Advanced Place Details) dokumenterar ENDAST attributet rank-preference="newest". Root-realprov: attributet gav inte property
// rankPreference och Googles preview visade 4 år före 3 år. Därför sätts attributet OCH (om elementet har egenskapen) property FÖRE montering, och
// efterläsningen av VÅR EGEN konfiguration (inte widgetens innehåll) avgör om vi alls får påstå "senaste först". Ingen skrapning av widgeten.
function gmpSetNewest(rv){
  rv.setAttribute('rank-preference','newest');
  try{if('rankPreference' in rv)rv.rankPreference='newest'}catch(e){}
}
function gmpNewestVerified(rv){
  if(!rv||rv.getAttribute('rank-preference')!=='newest')return false;
  var p=rv.rankPreference;
  return typeof p==='string'&&p.toLowerCase()==='newest';
}
var GMP_TIMEOUT=window.__GMP_TIMEOUT||15000; // __GMP_TIMEOUT: bara för offlineprov
function gmpBuild(placeId){
  var d=document.createElement('gmp-advanced-place-details');
  var rq=document.createElement('gmp-place-details-place-request');rq.setAttribute('place',placeId);d.appendChild(rq);
  ['gmp-place-name','gmp-place-address','gmp-place-rating','gmp-place-website'].forEach(function(t){d.appendChild(document.createElement(t))});
  var rv=document.createElement('gmp-place-reviews');gmpSetNewest(rv);d.appendChild(rv);
  d.appendChild(document.createElement('gmp-place-attribution'));
  return d;
}
function gmpUnmount(id){var m=SRC.mounted[id];if(m){if(m.timer)clearTimeout(m.timer);try{if(m.el&&m.el.parentNode)m.el.parentNode.removeChild(m.el)}catch(e){}if(m.box)m.box.textContent=''}delete SRC.mounted[id]}
function gmpUnmountAll(){Object.keys(SRC.mounted).forEach(gmpUnmount)}
function gmpCur(id,ver){return SRC.mounted[id]&&SRC.mounted[id].ver===ver}
// Asynkron mount är versionsbunden: ett senare mount/unmount gör att en sen laddning/händelse ignoreras. Googles egna händelser (gmp-load/gmp-error,
// båda icke-bubblande) lyssnas på själva elementet. Tystnad = timeout = fel – aldrig "inga omdömen".
function gmpFail(id,ver,box,retry,cb,renderFirm){
  if(!gmpCur(id,ver))return;
  gmpUnmount(id);
  box.appendChild(el('p',{class:'warnbox',text:'Googles omdömen kunde inte visas just nu. Det betyder inte att omdömen saknas – försök igen om en stund.'}));
  var rb=el('button',{type:'button',class:'btn ghost',text:'Försök igen'});rb.addEventListener('click',retry);box.appendChild(rb);
  if(cb&&cb.onFail)cb.onFail();
  gmpReport(renderFirm,'fel');
}
function gmpReport(f,outcome){
  if(!f||!f.google||!f.google.confirmed||!SRC.view)return;
  srcApi('POST','/google/render',{firmId:f.id,outcome:outcome}).then(function(r){if(r&&r.status===200&&r.json&&r.json.sources){SRC.view=r.json.sources;srcCov(r.json.sources);if(outcome==='ok')srcReceipt(f.id)}},function(){});
}
// Kvittens på avtalad källvisning (policy P): skickas bara efter LYCKAD visning i rapportläget. Servern prövar sin egen källstatus – klientens påstående räknas inte; fel/tomt/delvis ger ingen kvittens.
function srcReceipt(firmId){
  if(!state.order||SRC.ro||SRC.mode!=='report')return;
  api('POST','/compare/orders/'+state.order.id+'/source-delivered',{token:state.order.token,body:{firmId:firmId,state:'visad'}}).then(function(){syncBuyLink()},function(){});
}
// Serverreservation FÖRE varje billbar Googleinstans (Search/AdvancedDetails): preview, valbyte, återöppning och retry/remount ger ny reservation.
// Varje instans får ett nytt mountId; servern ger aldrig ny tillåtelse på ett gammalt. Nekas/fel ⇒ ingen instans skapas (fail closed).
function newMountId(){var a=new Uint8Array(16);crypto.getRandomValues(a);var h='m';for(var i=0;i<a.length;i++)h+=(a[i]<16?'0':'')+a[i].toString(16);return h}
async function gmpReserve(meta){
  try{var r=await srcApi('POST','/google/mount',{firmId:meta.firmId,kind:meta.kind,mountId:newMountId()});
    if(r&&r.status===200&&r.json&&r.json.allowed===true)return{allowed:true};
    return{allowed:false,outcome:(r&&r.json&&r.json.outcome)||'fel'}}catch(e){return{allowed:false,outcome:'fel'}}
}
function gmpStopped(id,ver,box,outcome,cb,renderFirm){
  if(!gmpCur(id,ver))return;
  gmpUnmount(id);
  var msg=outcome==='gransen_for_ordern'?'Du har nått gränsen för hur många gånger Googles omdömen kan visas i den här jämförelsen. Det betyder inte att omdömen saknas.':outcome==='kostnadsstopp'?'Googles omdömen är pausade av kostnadsskäl just nu. Det betyder inte att omdömen saknas.':'Googles omdömen kunde inte visas just nu. Det betyder inte att omdömen saknas – försök igen om en stund.';
  box.appendChild(el('p',{class:'warnbox','data-gmp-stop':outcome,text:msg}));
  if(cb&&cb.onFail)cb.onFail();
  gmpReport(renderFirm,'fel');
}
async function gmpMountElement(id,box,build,cb,renderFirm,meta){
  var c=srcCfg();if(!c||!c.google.mapsKey)return;
  var ver=(SRC.ver=(SRC.ver||0)+1);
  gmpUnmount(id);SRC.mounted[id]={ver:ver,loading:true,box:box};
  box.textContent='';var ld=el('p',{class:'hint',text:'Laddar Googles omdömen…'});box.appendChild(ld);
  var retry=cb&&cb.retry?cb.retry:function(){gmpMountElement(id,box,build,cb,renderFirm,meta)};
  try{await gmpLoad(c.google.mapsKey)}catch(e){gmpFail(id,ver,box,retry,cb,renderFirm);return}
  if(!gmpCur(id,ver))return; // under tiden avbrutet (byte av firma/stängt/ny mount)
  var rs=await gmpReserve(meta||{firmId:id,kind:'details'});
  if(!gmpCur(id,ver))return; // reservationen är förbrukad men ingen instans skapas om mounten under tiden ersatts
  if(!rs.allowed){gmpStopped(id,ver,box,rs.outcome,cb,renderFirm);return}
  var d=build();
  d.addEventListener('gmp-load',function(){if(!gmpCur(id,ver))return;var m=SRC.mounted[id];if(m.timer)clearTimeout(m.timer);m.loading=false;m.ok=true;if(ld.parentNode)ld.parentNode.removeChild(ld);var rvEl=d.querySelector&&d.querySelector('gmp-place-reviews');if(rvEl){var ordOk=gmpNewestVerified(rvEl);box.setAttribute('data-gmp-order',ordOk?'newest':'okand');if(!ordOk)box.appendChild(el('p',{class:'hint','data-gmp-order-note':'1',text:'Googles omdömen visas i Googles egen ordning. Vi kunde inte bekräfta att "senaste först" tillämpas, så läs datumen i omdömena.'}))}if(cb&&cb.onLoad)cb.onLoad(d);gmpReport(renderFirm,'ok')});
  d.addEventListener('gmp-error',function(){gmpFail(id,ver,box,retry,cb,renderFirm)});
  SRC.mounted[id]={ver:ver,loading:true,box:box,el:d,timer:setTimeout(function(){var m=SRC.mounted[id];if(m&&m.ver===ver&&!m.ok)gmpFail(id,ver,box,retry,cb,renderFirm)},GMP_TIMEOUT)};
  box.appendChild(d);
}
function gmpMount(f,box,cb,renderFirm){return gmpMountElement(f.id,box,function(){return gmpBuild(f.google.placeId)},cb,renderFirm===undefined?f:renderFirm,{firmId:f.firmId||f.id,kind:'details'})}
// Native sök: Googles eget <gmp-place-search selectable> (UI Kit). Query sätts via textQuery-egenskapen (krävs för att elementet ska ladda).
// Kunden väljer själv i Googles resultat (gmp-select → event.place.id); inget väljs automatiskt.
function gmpBuildSearch(query,onSelect){
  var s=document.createElement('gmp-place-search');s.setAttribute('selectable','');
  s.appendChild(document.createElement('gmp-place-all-content'));
  var rq=document.createElement('gmp-place-text-search-request');rq.setAttribute('max-result-count','5');rq.textQuery=query;s.appendChild(rq);
  s.addEventListener('gmp-select',function(ev){var id=ev&&ev.place&&ev.place.id;if(typeof id==='string'&&/^[A-Za-z0-9_-]{20,200}$/.test(id))onSelect(id)});
  return s;
}
var SRCTP={};
function srcCompactAll(){
  var v=SRC.view,c=srcCfg();
  document.querySelectorAll('.srcline[data-src-offer]').forEach(function(nd){
    nd.textContent='';
    if(!v||!v.firms||!c)return;
    var k=Number(nd.getAttribute('data-src-offer')),f=null;
    v.firms.forEach(function(x){if(!f&&x.offers.indexOf(k)>=0)f=x});
    if(!f)return;
    var parts=[];
    if(c.google.state!=='ej_aktiverad')parts.push(f.google&&f.google.confirmed?'Google (visas i Googles ruta)':'Google: ej kopplad');
    if(c.trustpilot.state!=='ej_aktiverad'){var td=tpOfFirm(f);parts.push(td?tpText(td):f.trustpilot&&f.trustpilot.confirmed?(SRCTPTRY[f.id]&&SRCTPTRY[f.id].state===2&&SRCTPTRY[f.id].sig===firmSig(f)?'Trustpilot: betyg kunde inte hämtas just nu':'Trustpilot: hämtar betyg…'):'Trustpilot: ej kopplad')}
    if(!parts.length)return;
    var tdn=tpOfFirm(f);
    nd.appendChild(el('span',{'data-srcline':'1',text:'Omdömen: '+parts.join(' · ')+(f.origin==='dokument'?' · firman läst ur offerten':'')}));
    if(!tdn)nd.removeAttribute('aria-label');
    if(tdn)nd.setAttribute('aria-label','Trustpilots totalbetyg '+tdn.score+' av 5 från '+tdn.count+' omdömen');
    var b=el('button',{type:'button',class:'linkbtn',text:'Visa omdömen'});
    b.addEventListener('click',function(){var m=$('more');if(m)m.open=true;var card=document.querySelector('#rep .srcfirm[data-firm="'+f.id+'"]');if(card){card.scrollIntoView({block:'start'});var h=card.querySelector('h4');if(h){h.setAttribute('tabindex','-1');h.focus()}}});
    nd.appendChild(document.createTextNode(' '));nd.appendChild(b);
  });
}
function ratingSortSync(){
  var sel=$('sortby'),op=document.querySelector('#sortby option[data-rating]');if(!sel||!op||!window.__lastN)return;
  var ok=ratingAvailable(window.__lastN);op.disabled=!ok;op.textContent=ok?'Högst Trustpilot-betyg':'Högst Trustpilot-betyg (kräver Trustpilot-uppgifter för minst två firmor)';
  if(!ok&&sel.value==='rating'){sel.value='upload';sel.dispatchEvent(new Event('change'))} // inaktuellt underlag ⇒ tillbaka till neutral ordning, ingen kvarglömd betygssortering
}
// Hämtar Trustpilots sammanfattning (betyg + antal) EN gång per firma-identitet för bekräftade firmor. Svaret gäller bara om firmans sig är oförändrad när det
// kommer (annars ignoreras det och nästa omgång hämtar för den nya identiteten). Servern äger tak/kostnadsstopp; fel ⇒ ärlig text, aldrig ett påhittat betyg.
async function tpAuto(view,depth){
  var c=srcCfg();if(!c||c.trustpilot.state==='ej_aktiverad'||!view||!view.firms)return;
  var stale=false;
  for(var i=0;i<view.firms.length;i++){
    var f=view.firms[i],sig=firmSig(f);
    if(!f.trustpilot||!f.trustpilot.confirmed||tpOfFirm(f)||(SRCTPTRY[f.id]&&SRCTPTRY[f.id].sig===sig))continue;
    SRCTPTRY[f.id]={sig:sig,state:1};
    var res=null;
    try{var r=await srcApi('POST','/trustpilot/latest',{firmId:f.id});var cd=r&&r.status===200&&r.json&&r.json.card;if(cd&&cd.trustScore!==null&&cd.totalReviews!==null){res={score:cd.trustScore,count:cd.totalReviews};if(r.json.outcome==='ok')srcReceipt(f.id)}}catch(e){}
    var cur=curFirm(f.id);
    if(!cur||firmSig(cur)!==sig){stale=true;continue} // identiteten/kopplingen ändrades under tiden: sent svar kastas
    if(res)SRCTPD[f.id]={sig:sig,score:res.score,count:res.count};else SRCTPTRY[f.id]={sig:sig,state:2};
  }
  tpPrune();srcCompactAll();ratingSortSync();
  if(stale&&(depth||0)<2)tpAuto(SRC.view,(depth||0)+1);
}
function srcCov(view){var cv=$('srccov');if(cv&&view&&view.coverage){cv.textContent='';(view.coverage.lines||[]).forEach(function(l){cv.appendChild(el('li',{text:l}))})}}
function srcInter(m){return !SRC.ro&&(m==='offer'||m==='report')}
function srcFirmCard(f,mode){
  var c=srcCfg();
  var card=el('div',{class:'srcfirm','data-firm':f.id});
  card.appendChild(el('h4',{text:f.name+(f.city?' ('+f.city+')':'')}));
  // Rätt firma: visa vad OFFERTEN uppger bredvid källans träff, så kunden själv kan jämföra (organisationsnummer och adress ur offerten lämnar aldrig oss och används inte som förslag).
  var qid=[f.name,f.city,f.domain?'webbplats '+f.domain:''].filter(Boolean).join(' · ');
  card.appendChild(el('p',{class:'hint','data-quote-id':'1',text:(f.origin==='kund'?'Firma enligt dig: ':'Firma enligt offerten: ')+qid+'. Bekräfta bara en källträff som stämmer med detta.'}));
  if(f.conflict)card.appendChild(el('p',{class:'warnbox',text:'Samma namn och ort men olika webbplatser ('+(f.domain||'ingen angiven')+'). Bekräfta källorna för just den här firman.'}));
  card.appendChild(el('p',{class:'hint',text:'Gäller '+f.offers.map(function(i){return 'offert '+(i+1)}).join(' och ')+(mode==='report'&&f.origin==='dokument'?' · läst ur offerten':'')}));
  if(mode==='report'&&!SRC.ro){var chg=el('button',{type:'button',class:'linkbtn',text:'Ändra företag'});chg.addEventListener('click',function(){srcEditForm(card,f.offers[0],{name:f.name,city:f.city,domain:f.domain})});card.appendChild(chg)}
  // ---- Google ----
  if(c.google.state!=='ej_aktiverad'){
    var g=el('div',{class:'srcrow','data-src':'google'},el('b',{text:'Google'}),el('div',{class:'st',text:f.google.text}));
    if(f.google.confirmed){
      var box=el('div',{class:'gmpbox hidden','data-gmp':f.id});
      var open=el('button',{type:'button',class:'btn ghost',text:'Visa Googles omdömen'});
      open.addEventListener('click',function(){
        if(SRC.mounted[f.id]){gmpUnmount(f.id);box.classList.add('hidden');open.textContent='Visa Googles omdömen';return}
        box.classList.remove('hidden');open.textContent='Dölj Googles omdömen';gmpMount(f,box);
      });
      g.appendChild(open);
      if(srcInter(mode)){var ch=el('button',{type:'button',class:'btn ghost',style:'margin-left:8px',text:'Fel firma? Byt'});ch.addEventListener('click',async function(){gmpUnmount(f.id);var r=await srcApi('POST','/unconfirm',{firmId:f.id,provider:'google'});if(r.status===200)srcRender(r.json.sources,mode)});g.appendChild(ch)}
      g.appendChild(el('p',{class:'hint',text:'Källa: Google ('+f.name+(f.city?', '+f.city:'')+'). Visas av Google med Googles eget urval, datum och attribution – vi ändrar eller sparar inget.'}));
      g.appendChild(box);
    }else if(srcInter(mode)&&f.google.state!=='kostnadsstopp'){
      var holder=el('div',{class:'cands'});
      if(c.google.search){
        var sb=el('button',{type:'button',class:'btn ghost',text:'Sök firman hos Google'});if(f.google.searchesLeft<=0)sb.disabled=true;
        sb.addEventListener('click',async function(){
          sb.disabled=true;holder.textContent='';
          var r=await srcApi('POST','/google/search',{firmId:f.id});
          if(r.status!==200){holder.appendChild(el('p',{class:'err',text:(r.json&&r.json.error)||'Sökningen gick inte.'}));sb.disabled=false;return}
          SRC.cands[f.id+':google']=r.json.candidates||[];SRC.view=r.json.sources;srcCands(holder,f,'google',r.json.candidates||[],r.json.outcome);sb.disabled=false;
        });
        g.appendChild(sb);
      }else{
        // Native väg (standard): Googles eget sökelement. Servern räknar bara kostnadsgrinden innan sökningen får köras.
        var sbox=el('div',{class:'gmpbox hidden','data-gmp-search':f.id});var pbox=el('div',{class:'gmpbox hidden','data-gmp-picked':f.id});
        var cbn=el('button',{type:'button',class:'btn acc','data-confirm':'native',text:'Det här är rätt firma',disabled:'disabled'});var picked=null;
        var nb=el('button',{type:'button',class:'btn ghost',text:'Sök firman hos Google'});if(f.google.searchesLeft<=0)nb.disabled=true;
        nb.addEventListener('click',async function(){
          nb.disabled=true;holder.textContent='';cbn.disabled=true;picked=null;pbox.classList.add('hidden');gmpUnmount(f.id+'-pv');
          var r=await srcApi('POST','/google/search',{firmId:f.id});
          if(r.status!==200){holder.appendChild(el('p',{class:'err',text:(r.json&&r.json.error)||'Sökningen gick inte.'}));nb.disabled=false;return}
          SRC.view=r.json.sources;srcCov(r.json.sources);
          if(!r.json.allowed){holder.appendChild(el('p',{class:'warnbox',text:'Googles sökning är stoppad av kostnadsskäl just nu. Det betyder inte att firman saknas.'}));return}
          sbox.classList.remove('hidden');
          await gmpMountElement(f.id+'-sr',sbox,function(){return gmpBuildSearch([f.name,f.city].filter(Boolean).join(' '),function(id){
            picked=id;cbn.disabled=true;pbox.classList.remove('hidden');
            gmpMount({id:f.id+'-pv',firmId:f.id,google:{placeId:id}},pbox,{onLoad:function(){if(picked===id)cbn.disabled=false},onFail:function(){cbn.disabled=true}},null);
          })},{onLoad:function(sr){var pl=sr&&sr.places;if(Array.isArray(pl)&&pl.length===0)sbox.appendChild(el('p',{class:'hint',text:'Googles sökning visade ingen träff för firmans namn och ort. Det är ingen bedömning av firman.'}))},onFail:function(){},retry:function(){nb.disabled=f.google.searchesLeft-1<=0;if(!nb.disabled)nb.click()}},null,{firmId:f.id,kind:'search'});
          nb.disabled=f.google.searchesLeft-1<=0;
        });
        cbn.addEventListener('click',async function(){
          if(!picked||cbn.disabled)return;cbn.disabled=true;
          var r=await srcApi('POST','/google/confirm',{firmId:f.id,placeId:picked,via:'native',seen:true});
          if(r.status===200)srcRender(r.json.sources,mode);else{cbn.disabled=false;err((r.json&&r.json.error)||'Gick inte.')}
        });
        g.appendChild(nb);g.appendChild(sbox);g.appendChild(pbox);g.appendChild(cbn);
        // Reserv: kunden har firmans Google-ID. Bekräftelsen låses upp först när Googles riktiga profil faktiskt har laddats och visats.
        var det=el('details',{},el('summary',{text:'Jag har firmans Google-ID'}));
        var inp=el('input',{type:'text',id:'pid-'+f.id,maxlength:'200',autocomplete:'off',placeholder:'Företags-ID från Google'});
        var pv=el('button',{type:'button',class:'btn ghost',text:'Visa profilen'});
        var prev=el('div',{class:'gmpbox hidden'});var okc=el('input',{type:'checkbox',id:'seen-'+f.id,disabled:'disabled'});var cb=el('button',{type:'button',class:'btn acc',text:'Det här är rätt firma',disabled:'disabled'});
        pv.addEventListener('click',function(){var v=(inp.value||'').trim();if(!/^[A-Za-z0-9_-]{20,200}$/.test(v))return;okc.checked=false;okc.disabled=true;cb.disabled=true;prev.classList.remove('hidden');gmpMount({id:f.id+'-pv2',firmId:f.id,google:{placeId:v}},prev,{onLoad:function(){okc.disabled=false},onFail:function(){okc.disabled=true;okc.checked=false;cb.disabled=true}},null)});
        okc.addEventListener('change',function(){cb.disabled=!okc.checked});
        cb.addEventListener('click',async function(){var v=(inp.value||'').trim();gmpUnmount(f.id+'-pv2');var r=await srcApi('POST','/google/confirm',{firmId:f.id,placeId:v,via:'manual',seen:okc.checked});if(r.status===200)srcRender(r.json.sources,mode);else err((r.json&&r.json.error)||'Gick inte.')});
        det.appendChild(inp);det.appendChild(pv);det.appendChild(prev);det.appendChild(el('label',{class:'opt','for':'seen-'+f.id},okc,el('span',{text:'Profilen ovan är rätt firma och plats.'})));det.appendChild(cb);g.appendChild(det);
      }
      g.appendChild(holder);
    }
    card.appendChild(g);
  }
  // ---- Trustpilot ----
  if(c.trustpilot.state!=='ej_aktiverad'){
    var t=el('div',{class:'srcrow','data-src':'trustpilot'},el('b',{text:'Trustpilot'}),el('div',{class:'st',text:f.trustpilot.text}));
    var out=el('div',{class:'tpout'});
    if(f.trustpilot.confirmed){
      var lb=el('button',{type:'button',class:'btn ghost',text:'Visa Trustpilots senaste omdömen'});
      lb.addEventListener('click',async function(){
        lb.disabled=true;out.textContent='';out.appendChild(el('p',{class:'hint',text:'Hämtar…'}));
        var r=await srcApi('POST','/trustpilot/latest',{firmId:f.id});lb.disabled=false;out.textContent='';
        if(r.status!==200){out.appendChild(el('p',{class:'err',text:(r.json&&r.json.error)||'Gick inte.'}));return}
        srcTp(out,f,r.json);if(r.json&&r.json.outcome==='ok')srcReceipt(f.id);
      });
      t.appendChild(lb);
      if(srcInter(mode)){var ct=el('button',{type:'button',class:'btn ghost',style:'margin-left:8px',text:'Fel firma? Byt'});ct.addEventListener('click',async function(){var r=await srcApi('POST','/unconfirm',{firmId:f.id,provider:'trustpilot'});if(r.status===200)srcRender(r.json.sources,mode)});t.appendChild(ct)}
    }else if(srcInter(mode)&&f.trustpilot.state!=='kostnadsstopp'){
      if(!f.domain)t.appendChild(el('p',{class:'hint',text:'Ange firmans webbplats ovan för att söka hos Trustpilot.'}));
      else{
        var ts=el('button',{type:'button',class:'btn ghost',text:'Sök firman hos Trustpilot'});if(f.trustpilot.searchesLeft<=0)ts.disabled=true;
        ts.addEventListener('click',async function(){ts.disabled=true;out.textContent='';var r=await srcApi('POST','/trustpilot/search',{firmId:f.id});
          if(r.status!==200){out.appendChild(el('p',{class:'err',text:(r.json&&r.json.error)||'Sökningen gick inte.'}));ts.disabled=false;return}
          SRC.cands[f.id+':trustpilot']=r.json.candidates||[];srcCands(out,f,'trustpilot',r.json.candidates||[],r.json.outcome);ts.disabled=false});
        t.appendChild(ts);
      }
    }
    t.appendChild(out);card.appendChild(t);
  }
  return card;
}
function srcCands(host,f,prov,list,outcome){
  host.textContent='';
  if(!list.length){host.appendChild(el('p',{class:'hint',text:outcome==='fel'?'Källan svarade inte just nu. Det betyder inte att omdömen saknas.':outcome==='kostnadsstopp'?'Sökningen är stoppad av kostnadsskäl. Det betyder inte att omdömen saknas.':'Ingen träff hos källan.'}));return}
  host.appendChild(el('p',{class:'hint',text:'Välj rätt firma och plats. Vi väljer aldrig åt dig.'}));
  var name='cand-'+f.id+'-'+prov;var btn=el('button',{type:'button',class:'btn acc',text:'Det här är rätt firma',disabled:'disabled'});var chosen=null;
  list.forEach(function(cd,i){
    var r=el('input',{type:'radio',name:name,id:name+i});r.addEventListener('change',function(){chosen=cd.id;btn.disabled=false});
    host.appendChild(el('label',{class:'opt','for':name+i},r,el('span',{text:cd.name+(cd.address?' – '+cd.address:'')+(cd.site?' – '+cd.site:'')})));
  });
  btn.addEventListener('click',async function(){
    if(!chosen)return;btn.disabled=true;
    var r=prov==='google'?await srcApi('POST','/google/confirm',{firmId:f.id,placeId:chosen,via:'candidate'}):await srcApi('POST','/trustpilot/confirm',{firmId:f.id,buId:chosen});
    if(r.status===200)srcRender(r.json.sources,SRC.mode||'offer');else{err((r.json&&r.json.error)||'Gick inte.');btn.disabled=false}
  });
  host.appendChild(btn);
}
function stars(n){return '★★★★★'.slice(0,n)+'☆☆☆☆☆'.slice(0,5-n)}
function srcTp(out,f,j){
  if(j.outcome==='fel'){out.appendChild(el('p',{class:'warnbox',text:'Trustpilot svarade inte just nu. Det betyder inte att omdömen saknas – försök igen om en stund.'}));return}
  if(j.outcome==='kostnadsstopp'){out.appendChild(el('p',{class:'warnbox',text:'Visningen är stoppad av kostnadsskäl just nu. Det betyder inte att omdömen saknas.'}));return}
  var c=j.card;if(!c)return;
  if(c.trustScore!==null&&c.totalReviews!==null){SRCTPD[f.id]={sig:firmSig(f),score:c.trustScore,count:c.totalReviews};srcCompactAll();ratingSortSync()}
  var head='Källa: Trustpilot ('+f.name+(f.city?', '+f.city:'')+').';
  out.appendChild(el('p',{class:'hint',text:head+(c.trustScore!==null?' Trustpilots totalbetyg: '+String(c.trustScore).replace('.',',')+' av 5':'')+(c.totalReviews!==null?' ('+c.totalReviews+' omdömen).':'.')}));
  if(c.latestState==='inga_omdomen'){out.appendChild(el('p',{class:'hint',text:'Trustpilot har inga omdömen för firman. Få eller inga omdömen är tunt underlag – inte ett dåligt företag.'}))}
  else if(c.latestState==='ej_senaste_tillgangliga'){out.appendChild(el('p',{class:'hint',text:'Källan levererade inte omdömena nyast först, så vi visar inga som "senaste".'}))}
  else c.reviews.forEach(function(r){
    var d=el('div',{class:'tprev'},el('b',{text:stars(r.stars)+' '+r.stars+' av 5 · '+r.date}));
    if(r.title)d.appendChild(el('div',{text:r.title}));if(r.text)d.appendChild(el('div',{text:r.text}));
    if(r.link)d.appendChild(el('a',{href:r.link,target:'_blank',rel:'noopener noreferrer',text:'Läs på Trustpilot'}));
    out.appendChild(d);
  });
  out.appendChild(el('p',{class:'hint',text:c.note+(j.fromCache?' (Hämtat inom de senaste 24 timmarna.)':'')}));
  if(c.sourceUrl)out.appendChild(el('a',{href:c.sourceUrl,target:'_blank',rel:'noopener noreferrer',text:'Trustpilot-sidan för firman'}));
}
function srcRender(view,mode){
  SRC.view=view;SRC.mode=mode;gmpUnmountAll();
  var host=mode==='report'?$('srcrep'):$('srcfirms');if(!host)return;
  host.textContent='';
  (view.firms||[]).forEach(function(f){host.appendChild(srcFirmCard(f,mode))});
  if(mode==='report'&&!view.firms.length)host.appendChild(el('p',{class:'hint',text:'Du angav inga firmor för källvisning.'}));
  tpPrune();
  if(mode==='report'){srcCompactAll();ratingSortSync();tpAuto(view)}
  var cv=$('srccov');if(cv&&mode==='offer'){cv.textContent='';(view.coverage&&view.coverage.lines||[]).forEach(function(l){cv.appendChild(el('li',{text:l}))})}
}
function srcForm(){
  var f=$('srcform');f.textContent='';
  var rows=[];state.slots.slice(0,state.n).forEach(function(s,i){if(s.label&&s.label.trim())rows.push(i)});
  if(!rows.length){f.appendChild(el('p',{class:'hint',text:'Skriv hantverkarens namn på offerten (steg 1) för att kunna se källor.'}));return}
  rows.forEach(function(i){
    f.appendChild(el('div',{class:'srcfirm'},el('b',{text:'Offert '+(i+1)+' – '+state.slots[i].label}),
      el('label',{class:'t','for':'sc'+i,text:'Ort (gärna, för rätt filial)'}),el('input',{type:'text',id:'sc'+i,maxlength:'50',autocomplete:'off'}),
      el('label',{class:'t','for':'sd'+i,text:'Webbplats (valfritt, t.ex. foretaget.se)'}),el('input',{type:'text',id:'sd'+i,maxlength:'80',autocomplete:'off'})));
  });
  var b=el('button',{type:'button',class:'btn ghost',id:'srcgo',text:'Visa tillgängliga källor'});
  b.addEventListener('click',async function(){
    b.disabled=true;gmpUnmountAll();
    var firms=rows.map(function(i){return {offerIndex:i,name:state.slots[i].label.trim(),city:($('sc'+i).value||'').trim(),domain:($('sd'+i).value||'').trim()}});
    var r=await srcApi('PUT','/firms',{firms:firms});b.disabled=false;
    if(r.status===200)srcRender(r.json.sources,'offer');else err((r.json&&r.json.error)||'Gick inte att spara firmauppgifterna.');
  });
  f.appendChild(b);
}
// Firmor ur sourcesview -> PUT-rader (en rad per offert), så att befintliga val bevaras vid komplettering.
function srcFirmRows(view){var rows=[];(view.firms||[]).forEach(function(f){f.offers.forEach(function(i){rows.push({offerIndex:i,name:f.name,city:f.city,domain:f.domain||'',origin:f.origin||'kund'})})});return rows}
async function srcPutFirms(rows){
  var r=await srcApi('PUT','/firms',{firms:rows});
  if(r.status===200){srcRender(r.json.sources,SRC.mode==='offer'?'offer':'report');srcPanel();if(state.resumeSrc)resumeRows()}else err((r.json&&r.json.error)||'Gick inte att spara firmauppgifterna.');
  return r;
}
// Kort formulär för att ändra/lägga till företag för en offert. Kundens egna uppgifter vinner över dokumentförslag.
function srcEditForm(after,offerIndex,pre){
  var old=document.querySelector('.srcedit[data-offer="'+offerIndex+'"]');if(old){old.remove()}
  var w=el('div',{class:'srcedit','data-offer':String(offerIndex)});
  var n=el('input',{type:'text',maxlength:'80',autocomplete:'off',id:'se-n'+offerIndex,value:(pre&&pre.name)||''});
  var c=el('input',{type:'text',maxlength:'50',autocomplete:'off',id:'se-c'+offerIndex,value:(pre&&pre.city)||''});
  var d=el('input',{type:'text',maxlength:'80',autocomplete:'off',id:'se-d'+offerIndex,value:(pre&&pre.domain)||''});
  w.appendChild(el('label',{class:'t','for':'se-n'+offerIndex,text:'Företagsnamn (offert '+(offerIndex+1)+')'}));w.appendChild(n);
  w.appendChild(el('label',{class:'t','for':'se-c'+offerIndex,text:'Ort'}));w.appendChild(c);
  w.appendChild(el('label',{class:'t','for':'se-d'+offerIndex,text:'Webbplats (valfritt)'}));w.appendChild(d);
  var ok=el('button',{type:'button',class:'btn acc',text:'Spara företag'});
  ok.addEventListener('click',async function(){
    var nm=(n.value||'').trim();if(!nm){err('Skriv företagets namn.');return}
    ok.disabled=true;
    var rows=srcFirmRows(SRC.view).filter(function(x){return x.offerIndex!==offerIndex});
    rows.push({offerIndex:offerIndex,name:nm,city:(c.value||'').trim(),domain:(d.value||'').trim(),origin:'kund'});
    var r=await srcPutFirms(rows);if(r.status!==200)ok.disabled=false;
  });
  var cn=el('button',{type:'button',class:'btn ghost',style:'margin-left:8px',text:'Avbryt'});cn.addEventListener('click',function(){w.remove()});
  w.appendChild(ok);w.appendChild(cn);
  after.appendChild(w);n.focus();
}
// Förslag ur dokumentidentiteten: auto läggs in direkt, osäkra kräver ett kort "Stämmer", övriga får en kort rad.
var SRCPROP=null;
function srcPanel(){
  var host=$(SRC.mode==='offer'?'srcpropPre':'srcprop');if(!host||!SRCPROP)return;host.textContent='';
  var have={};(SRC.view&&SRC.view.firms||[]).forEach(function(f){f.offers.forEach(function(i){have[i]=true})});
  SRCPROP.forEach(function(p){
    if(have[p.offerIndex])return;
    var row=el('div',{class:'srcprop','data-offer':String(p.offerIndex)});
    var lab='Offert '+(p.offerIndex+1);
    if(p.state==='bekrafta'){
      var why={ofullstandig:'Uppgifterna i offerten är ofullständiga.',osaker_roll:'Det är oklart om det är utföraren som avses.',liknande_namn:'Namnet liknar ett annat företag i jämförelsen.',ort_saknas:'Orten framgår inte.'}[p.reason]||'';
      row.appendChild(el('p',{text:lab+': företaget verkar vara '+p.name+(p.city?' ('+p.city+')':'')+'. Stämmer det? '+why}));
      var y=el('button',{type:'button',class:'btn acc',text:'Stämmer'});
      y.addEventListener('click',async function(){y.disabled=true;var rows=srcFirmRows(SRC.view);rows.push({offerIndex:p.offerIndex,name:p.name,city:p.city||'',domain:p.domain||'',origin:'dokument'});var r=await srcPutFirms(rows);if(r.status!==200)y.disabled=false});
      var ch=el('button',{type:'button',class:'btn ghost',style:'margin-left:8px',text:'Ändra'});
      ch.addEventListener('click',function(){srcEditForm(row,p.offerIndex,{name:p.name,city:p.city,domain:p.domain})});
      row.appendChild(y);row.appendChild(ch);
    }else if(p.state==='enskild'){
      row.appendChild(el('p',{class:'hint',text:lab+': verkar vara en enskild firma. Vi söker inte omdömen om privatpersoner.'}));
    }else{
      row.appendChild(el('p',{class:'hint',text:lab+': '+(p.state==='ej_avlast'?'företaget kunde inte läsas ur offerten säkert.':'offerten anger inget företagsnamn.')}));
      var add=el('button',{type:'button',class:'linkbtn',text:'Lägg till företag'});add.addEventListener('click',function(){srcEditForm(row,p.offerIndex,null)});row.appendChild(add);
    }
    host.appendChild(row);
  });
}
// Lägger in auto-förslag direkt (origin 'dokument'); osäkra får kort "Stämmer"-rad via srcPanel. Gäller både efter köp och förköpsläsning.
async function srcApplyProposals(view,props){
  SRCPROP=props||[];
  var rows=srcFirmRows(view),have={};rows.forEach(function(x){have[x.offerIndex]=true});
  var add=SRCPROP.filter(function(p){return p.state==='auto'&&!have[p.offerIndex]});
  if(add.length){add.forEach(function(p){rows.push({offerIndex:p.offerIndex,name:p.name,city:p.city||'',domain:p.domain||'',origin:'dokument'})});await srcPutFirms(rows)}
  else srcPanel();
}
// Förköpsläsning (D11): bara när servern slagit på den. Kunden startar själv; texten före knappen kommer från servern (UTKAST). Ett anrop per offert, engångs.
function preidBlock(){
  var c=state.cfg&&state.cfg.preid,host=$('preid');if(!host)return;host.textContent='';
  if(!c||!c.on){host.classList.add('hidden');return}
  host.classList.remove('hidden');
  host.appendChild(el('p',{class:'hint',text:c.text+(c.draft?' (Utkast till text.)':'')}));
  var out=el('p',{class:'hint',role:'status','data-preid-out':'1'});
  var b=el('button',{type:'button',class:'btn ghost',id:'preidgo',text:c.button||'Läs av företagsuppgifter'});
  b.addEventListener('click',async function(){
    b.disabled=true;out.textContent='Läser företagsuppgifterna…';
    var props=null,okN=0,fail=null;
    for(var i=0;i<state.n;i++){
      var r=await api('POST','/compare/orders/'+state.order.id+'/preid',{token:state.order.token,body:{idx:i}});
      if(r.status===200&&r.json&&r.json.proposals){props=r.json.proposals;okN++}
      else{fail=(r.json&&r.json.error)||'Gick inte.';if(r.status===503||r.status===404)break}
    }
    out.textContent=okN?('Läste företagsuppgifter för '+okN+' av '+state.n+' offerter.'+(fail?' '+fail:'')):(fail||'Gick inte.');
    if(props&&SRC.view)await srcApplyProposals(SRC.view,props);
    if(okN<state.n)b.disabled=false;
  });
  host.appendChild(b);host.appendChild(out);
}
async function srcStart(host,mode){
  if(!srcActive())return;
  try{
    var r=await srcApi('GET','');
    if(r.status!==200){if(mode!=='offer'){host.textContent='';host.appendChild(el('p',{class:'hint','data-srcmsg':'1',text:'Källstatus kunde inte hämtas just nu. Det betyder inte att omdömen saknas. Ladda om sidan om en stund.'}))}return}
    if(mode==='offer'){show('srcbox',true);srcIntro();if(state.slots&&state.slots.length)srcForm();srcRender(r.json.sources,'offer');preidBlock()}
    else{host.textContent='';host.appendChild(el('p',{class:'hint',text:'Omdömen visas separat från rapporten, med källans eget urval. De ingår inte i jämförelsen och är ingen bedömning av företaget.'}));
      host.appendChild(el('div',{id:'srcprop','aria-live':'polite'}));
      var props=[];if(!SRC.ro){var ir=await srcApi('GET','/identity');props=(ir.status===200&&ir.json.proposals)||[];SRCPROP=props}
      var inner=el('div',{id:'srcrep'});host.appendChild(inner);srcRender(r.json.sources,'report');
      if(!SRC.ro)await srcApplyProposals(r.json.sources,props);
    }
  }catch(e){if(mode!=='offer'&&host){host.textContent='';host.appendChild(el('p',{class:'hint','data-srcmsg':'1',text:'Källstatus kunde inte hämtas just nu. Det betyder inte att omdömen saknas. Ladda om sidan om en stund.'}))}}
}

// ---------- förkontroll (adapter ovanpå samma motor) ----------
// Samma order-/token-/återupptagnings- och resultatmotor som jämförelsen; här finns bara det som är specifikt för EN egen offert:
// ett underlag, egna köptexter (cfg.check) och spärren mot att skriva över en annan sparad order.
var wsK=G.ws.check;
function ckFill(id,items){var u=$(id);u.textContent='';(items||[]).forEach(function(t){u.appendChild(el('li',{text:t}))})}
function ckFillOffer(){
  var C=state.cfg.check,t=(C.consent&&C.consent.texts)||{};
  ckFill('copy-gets',C.offerCopy&&C.offerCopy.gets);ckFill('copy-getsnot',C.offerCopy&&C.offerCopy.getsNot);ckFill('copy-how',C.offerCopy&&C.offerCopy.how);
  $('what').textContent='Du köper en förkontroll av EN egen offert: kontroll av moms, ROT-underlag, pristyp, omfattning och tid, frågor din kund sannolikt ställer, och efter din bekräftelse tilläggstexter och en PDF-bilaga med exakt samma uppgifter. 49 kr inklusive moms, engångsköp.';
  $('t-decl').textContent=t.declaration||'';
  $('coverage').textContent=(C.dataCoverage&&C.dataCoverage.text)||'';
  show('draftnote',!!(C.consent&&C.consent.draft));
  var box=$('termsbox');box.textContent='';var secs=(C.terms&&Array.isArray(C.terms.sections))?C.terms.sections:[];
  secs.forEach(function(s){box.appendChild(el('h3',{text:s.title}));String(s.text||'').split('\n').forEach(function(l){if(l.trim())box.appendChild(el('p',{text:l}))})});
  var sl=secs.filter(function(x){return x.id==='saljare'})[0],sb=$('seller');sb.textContent='';
  if(sl&&typeof sl.text==='string'){sb.appendChild(el('b',{text:'Du köper av'}));sl.text.split('\n').forEach(function(l){sb.appendChild(el('div',{text:l}))})}
}
function ckSync(){$('pay').disabled=!$('declaration').checked}
// Sparad order i den här webbläsaren (nyckeln delas med jämförelsen). En order av annat slag eller en redan betald/levererad förkontroll skrivs ALDRIG över.
// Fail-closed: finns en giltig sparad nyckel men ordern går inte att kontrollera skapas ingen ny order och nyckeln skrivs aldrig över.
async function guardStored(){
  var rec=null;try{rec=JSON.parse(store('jamfor_order')||'null')}catch(e){}
  if(!rec||!rec.id||!rec.token)return {ok:true};
  var r;try{r=await api('GET','/compare/orders/'+rec.id,{token:rec.token})}catch(e){return {ok:false,why:'okant',rec:rec}}
  if(r.status===404||r.status===410)return {ok:true,rec:rec};
  if(r.status===401||r.status===403)return {ok:false,why:'nyckel',rec:rec};
  if(r.status!==200||!r.json||!r.json.order)return {ok:false,why:'okant',rec:rec};
  var o=r.json.order;
  if(['expired','failed','deleted'].indexOf(o.status)>=0)return {ok:true,rec:rec};
  if(o.kind!=='check')return {ok:false,why:'annat',rec:rec,order:o};
  if(['paid','running','delivered','awaiting_payment'].indexOf(o.status)>=0&&!(o.status==='awaiting_payment'))return {ok:false,why:'pagaende',rec:rec,order:o};
  return {ok:true,rec:rec,order:o};
}
function ckShowGuard(g){
  receiptProtected();
  var b=$('guard');b.textContent='';
  var T={annat:'Den här webbläsaren har redan en annan order sparad (en jämförelse av offerter). Den påverkas inte och skrivs inte över, och ingen förkontroll kan startas ovanpå den här.',
    okant:'Vi kan just nu inte kontrollera den order som är sparad i den här webbläsaren (nätverket eller tjänsten svarar inte). Inget har skrivits över och ingen ny order har skapats. Försök igen om en stund, eller öppna den sparade ordern.',
    nyckel:'Den sparade ordern i den här webbläsaren godkänns inte längre med sin nyckel. Den skrivs inte över och ingen ny order har skapats. Öppna den sparade ordern eller använd återställningslänken du fick.'};
  b.appendChild(el('p',{style:'margin:0 0 6px',text:T[g.why]||'Du har redan en förkontroll under arbete eller levererad i den här webbläsaren. Öppna den i stället för att köpa en ny.'}));
  if(g.why==='okant'){var rb=el('button',{type:'button',class:'btn acc',text:'Försök igen'});rb.addEventListener('click',function(){restartCheckInit()});b.appendChild(rb);b.appendChild(document.createTextNode(' '))}
  b.appendChild(el('a',{class:'btn ghost',href:'/jamfor/','data-gmo-task':'compare',text:'Öppna den sparade ordern'}));
  show('guard',true);
}
function restartCheckInit(){if(dead)return;['s1','s2','guard','closed','cfgstate'].forEach(function(id){show(id,false)});initCheck(null)}
async function initCheck(rec){
  if(returnOrderId()&&rec&&returnOrderId()===rec.id){await cfgSoft();if(dead)return;state.order=rec;show('s3',true);return resume()} // retur från betalning: samma resultatmotor som jämförelsen
  cfgCard('loading','Laddar förkontrollen…','',null);$('cfgstate').setAttribute('aria-busy','true');
  var C=await G.config.load();if(dead)return;
  $('cfgstate').removeAttribute('aria-busy');
  if(C.state!=='ok'){
    var rb=el('button',{type:'button',class:'btn acc',id:'cfg-retry',text:'Försök igen'});
    rb.addEventListener('click',function(){rb.disabled=true;cfgCard('loading','Försöker igen…','',null);G.config.retry().then(function(){if(!dead)initCheck(rec)})});
    mErr(C.reason==='timeout'?'timeout':C.reason==='network'?'network':'server','config');
    cfgCard('failed','Vi kunde inte nå tjänsten just nu','Det här betyder inte att förkontrollen är stängd. Det du har lagt in finns kvar. Inget har skickats och inget har debiterats.',rb);
    var off=G.config.subscribe(function(c){if(c.state==='ok'&&!dead&&$('cfgstate')&&$('cfgstate').getAttribute('data-cfg')==='failed'){off();initCheck(rec)}});cleanups.push(off);
    return;
  }
  show('cfgstate',false);
  var cfg=C.cfg;state.cfg=cfg;footerInfoLink(cfg);
  if(!cfg.check||!cfg.check.available){
    var c=$('closed');c.textContent='';c.appendChild(el('h2',{text:'Förkontrollen är inte öppen än'}));c.appendChild(el('p',{text:'Vi bygger den fortfarande. Under tiden kan du granska en offert gratis.'}));c.appendChild(el('a',{class:'btn acc',href:'/#gratis','data-gmo-task':'free',text:'Granska en offert gratis'}));show('closed',true);return;
  }
  var t=cfg.check.consent.texts||{};if(t.sameJob)$('t-samejob').textContent=t.sameJob;
  wireCheckInputs();
  var wantPay=/(^|[#&])betala(&|$)/.test(location.hash);
  var g=await guardStored();if(dead)return;
  if(wantPay&&g.ok&&g.order&&['draft','ready','awaiting_payment'].indexOf(g.order.status)>=0&&g.order.kind==='check'){state.order=g.rec;ckToPay(true);return}
  if(!g.ok){ckShowGuard(g);$('go').setAttribute('aria-describedby','guard')}
  show('s1',true);
}
function ckToPay(resumed){
  show('s1',false);show('s2',true);ckFillOffer();$('declaration').checked=false;ckSync();
  if(resumed)$('docs').appendChild(el('p',{class:'hint',text:'Din offert är redan uppladdad. Ingenting har debiterats.'}));
  $('h-s2').scrollIntoView({block:'start'});
}
function wireCheckInputs(){
  var kinfo=function(){return wsK.file?wsK.file.name+' ('+G.fileKb(wsK.file)+' kB)'+(wsK.from==='free'?' · Följde med från gratisgranskningen.':''):wsK.text?'Inklistrad text.'+(wsK.from==='free'?' · Följde med från gratisgranskningen.':''):'Ingen fil vald.'};
  // Ett avbrutet filval (tom lista) lämnar redan valt underlag orört.
  function kReady(m){var r=slotReadyK();if(r&&!wsK.readyFired){wsK.readyFired=true;mEv('input_ready',{method:m,stage:'input'})}if(!r)wsK.readyFired=false}
  $('f0').addEventListener('change',function(){var f=$('f0').files[0];
    if(f){mEv('input_choose',{method:'file',stage:'input'});var L=limitsOf();
      if(f.size>L.file){$('fi0').textContent='Filen ”'+f.name+'” är för stor ('+mbOf(f.size)+' MB, högst '+mbOf(L.file)+' MB). Välj en mindre fil eller ta bara sidorna med pris och villkor.'+(slotReadyK()?' Det du hade lagt in här är kvar.':'');$('f0').value='';mErr('size','input');return}
      wsK.from='';wsK.file=f;wsK.text='';$('t0').value='';kReady('file')}
    $('fi0').textContent=kinfo()});
  $('t0').addEventListener('input',function(){if(!wsK.textChosen&&$('t0').value){wsK.textChosen=true;mEv('input_choose',{method:'text',stage:'input'})}if(!$('t0').value)wsK.textChosen=false;
    wsK.from='';wsK.text=$('t0').value;if($('t0').value){wsK.file=null;$('f0').value=''}kReady('text');$('fi0').textContent=kinfo()});
  $('t0').value=wsK.text||'';$('fi0').textContent=kinfo();
  $('samejob').checked=!!wsK.own;$('samejob').addEventListener('change',function(){wsK.own=$('samejob').checked});
  $('declaration').addEventListener('change',ckSync);
  $('go').addEventListener('click',ckGo);
  $('restart').addEventListener('click',function(){restartHere(false)});
  $('pay').addEventListener('click',ckPay);
}
async function ckGo(){
  if(state.starting)return;
  err('');
  if(!$('samejob').checked){err('Bekräfta först att offerten är din egen.');$('samejob').focus();return}
  if(!slotReadyK()){err('Välj en fil eller klistra in offertens text.');return}
  var L=limitsOf();
  if(wsK.file&&!(wsK.text&&wsK.text.trim())&&wsK.file.size>L.file){err('Filen är för stor ('+mbOf(wsK.file.size)+' MB, högst '+mbOf(L.file)+' MB). Välj en mindre fil eller ta bara sidorna med pris och villkor.');mErr('size','input');return}
  // Lås FÖRE första await (ett andra klick når aldrig hit); knappen och navigeringen är spärrade medan offerten läses in.
  state.starting=true;busy(true,'din offert läses in');
  var b=$('go');b.disabled=true;b.textContent='Läser in…';
  try{
    var p=await G.docPayload({file:wsK.file,text:wsK.text});if(!p){err('Välj en fil eller klistra in offertens text.');return}
    if(p.bad){err('Filtypen går inte att läsa. Använd PDF, foto eller textfil.');mErr('format','submit');return}
    var gs=await guardStored();if(gs.ok&&gs.order&&gs.order.status==='awaiting_payment')gs={ok:false,why:'pagaende'};
    if(!gs.ok){ckShowGuard(gs);err('Förkontrollen kan inte startas i den här webbläsaren just nu – se rutan ovanför formuläret.');$('guard').scrollIntoView({block:'start'});return}
    mEv('submit',{method:methodOfSlots([wsK])});
    var ord=wsK.pending; // en delvis misslyckad start återanvänder SAMMA utkast (ingen ny order, ingen dubblett)
    if(!ord){
      var c;try{c=await api('POST','/compare/orders',{body:{kind:'check',docCount:1,labels:['Din offert'],accept:{sameJob:true}}})}catch(e){mErr('network','submit');err('Vi nådde inte tjänsten. Inget har skickats eller debiterats och din offert ligger kvar. Försök igen.');return}
      if(c.status!==201){mErr(c.status>=500?'server':'config','submit');err((c.json&&c.json.error)||'Det gick inte att starta just nu. Din offert ligger kvar.');return}
      ord={id:c.json.orderId,token:c.json.token};wsK.pending=ord;
    }
    var u;try{u=await api('PUT','/compare/orders/'+ord.id+'/docs/0',{token:ord.token,body:p})}catch(e){u=null}
    if(!u||u.status!==200){
      var reason=!u?'network':u.status===413?'size':u.status===409?'server':u.status>=500?'server':'read';mErr(reason,'submit');
      err(!u?'Vi nådde inte tjänsten. Din offert är kvar här – tryck Fortsätt för att försöka igen, eller byt fil.':(u.json&&u.json.error)||'Filen gick inte att ta emot. Byt fil eller klistra in texten och tryck Fortsätt igen.');
      state.order=ord;var oc=$('cdraft');if(oc)oc.remove();$('err').parentNode.insertBefore(closeDraftBlock(),$('err').nextSibling);
      return;
    }
    wsK.pending=null;var oc2=$('cdraft');if(oc2)oc2.remove();
    state.order=ord;store('jamfor_order',JSON.stringify(ord));
    $('docs').textContent='';$('docs').appendChild(el('div',{class:'docrow'},el('span',{text:'Din offert'}),el('span',{class:'tag ok',text:'Klar ('+(u.json.doc.pages?u.json.doc.pages+' sidor, ':'')+Math.max(1,Math.round(u.json.doc.bytes/1024))+' kB)'})));
    ckToPay(false);
  }catch(e){mErr('server','submit');err('Något gick fel. Försök igen.')}
  finally{state.starting=false;busy(false);b.disabled=false;b.textContent='Fortsätt'}
}
function slotReadyK(){return !!(wsK.file||(wsK.text&&wsK.text.trim()))}
async function ckPay(){
  err('');var em=($('email').value||'').trim();
  if(!EMAIL_OK.test(em)){err('Ange en giltig e-postadress för avtalsbekräftelsen.');$('email').focus();return}
  if(!$('declaration').checked){err('Markera själv rutan om att förkontrollen börjar direkt och att ångerrätten upphör när tjänsten är helt utförd.');return}
  if(state.paying)return;state.paying=true;
  var C=state.cfg.check.consent,b=$('pay');b.disabled=true;b.textContent='Öppnar betalning…';
  mEv('checkout_open',{stage:'checkout'});
  try{
    var r=await api('POST','/compare/orders/'+state.order.id+'/checkout',{token:state.order.token,body:{accept:{terms:true,declaration:true,consentHash:C.hash,consentVersion:C.version,email:em}}});
    if(r.status===200&&r.json.url){location.href=r.json.url;return}
    if(r.json&&r.json.consentChanged){try{state.cfg=(await G.config.retry()).cfg;ckFillOffer();$('declaration').checked=false}catch(e){}}
    err((r.json&&r.json.error)||'Betalningen kunde inte startas. Du har inte debiterats.');
  }catch(e){mErr('network','checkout');err('Betalningen kunde inte startas. Du har inte debiterats.')}
  state.paying=false;b.textContent='Betala 49 kr';ckSync();
}

showReceipt();
wireExample();
init();

  return {unmount:function(){dead=true;clearTimeout(state.timer);cleanups.forEach(function(f){try{f()}catch(e){}});cleanups=[];},busy:function(){return !!state.busy}};
}
G.registerTask('compare',{mount:mountPay});
G.registerTask('check',{mount:mountPay});
})();
