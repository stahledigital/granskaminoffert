# Granska min offert – ändringslogg

## d07-resume-labels – företag per offert även när återupptagen order saknar firmor
- Samma Donatellos a9f21a82: åtkomlig Lägg till/Ändra företag per befintlig offert; riktiga etiketter är förslag, sparas endast aktivt; originalfullnyckel och nytt samtycke efter ändring. Källintron lovar bara aktiva leverantörer.
- Root full patch/MD review, frontend byteexact 2aa47ae6 och 2/2 riktade resumeprov PASS. Backend/auth/kostnadstak oförändrade; Googlevisning återstår i faktisk drift.

## d07-resume-ui – återupptagen obetald order visar/anger firmor och källor före betalning (ovanpå 8bb1b03 + d07-rattelse)
- `jamfor/index.html` (endast frontend): `resumeSources()` i `tick()` för draft/ready/awaiting_payment – återanvänder befintliga källpaneler (`srcForm`/`srcRender`/`preidBlock`), rätt `docCount`, firmor ur serverns sourcesview, fullnyckel (aldrig r-token). Inga dokument/AI, ingen ny order, ingen checkout.
- Ändras källorna efter återupptagning kräver betalningen nytt aktivt samtycke (`consentAgain`) i stället för tyst retry.
- Prov: `tests/ui/compare_resume_sources.test.mjs`.

## d07-rattelse – D07 recensionsdelta, rättelse ovanpå 8bb1b03 (root-review: 3 brister), auth oförändrad
- Brist 1: PDF nämner aldrig en inaktiv källa. Texten byggs ur faktisk per-offert-status; Trustpilot nämns bara om den är på.
- Brist 2: `sourceCards` kommer inte längre ur envflaggan utan ur serverns egna firma-/bekräftelsetillstånd (`sourceCardsFor`, compare_sources.js), frusna när rapporten byggs (före rapportmejlet): `ej_aktiverad` / `ej_bekraftad` / `bekraftad`, firma (namn, ort, webbplats, ursprung), Google-status, bekräftelsetid, `sourcesFrozenAt`. Okänt förblir okänt.
- Brist 3: kundbekräftad OFFENTLIG Google Maps-profil (officiell `query_place_id`-länk) i rapport, resultatsida och PDF – ingen rå recension/text/betyg/antal/widget, inget omdömesinnehåll lagras. Fungerar på annan enhet via befintlig rapportrutt.
- Efterhandsomval: `GET /report` lägger `sourceLive {cards, asOf, changedSinceDelivery, frozenAt}` bredvid den frusna revisionen (ny INTERN DO-väg `/source-cards`, anropas först efter befintlig `/report-auth`). Lagrad rapport/hash/PDF ändras aldrig; UI säger att PDF:en från mejlet inte uppdaterats. Ingen ändring av autentisering; resultattoken når fortfarande inte `/sources`.
- Tester: worker `compare_reviews_delta` 4 (nya: faktisk status/inaktiv TP/profil efter bekräftelse; efterhandsomval; r-token negativt), UI `compare_reviews_view` 6 (nya: profilvy 390 px, osäker länk blir ingen href), övriga compare_* gröna.


## 2026-10-11 – fullständig rapport som PDF och återhämtning

- fix3 (root 20:32, efter Anders Stripe-TEST-betalning): (1) checkout-retur `?order=NY` ≠ sparad order ⇒ tydlig mismatch-vy (båda ordernummer, ingen tyst adoption, ingen tokenbypass; återställningslänk `#o=&t=` för NY slås upp med NYs egen token; sparad order rörs aldrig); resultatlänk `#o=&r=` (read-only, 24 h) öppnar bara rapporten, ogiltig/utgången ⇒ tydligt besked, token tas bort ur adressen och sparas aldrig. (2) `_finish(delivered)` köar idempotent rapport-mejl (`outbox:mail_rapport_<id>`, EN per order, i samma commit som leveransen) till orderns frusna kontakt (testorder: bara hej@stahledigital.se) via befintlig Resend/mail-events/dygnstak; 24 h-resultattoken (endast hash lagras, `/report-auth` ger bara rapportläsning); adminrutt `POST /compare/admin/test-order/:id/report-mail` återhämtar en redan levererad testorder utan ny order (409/410/503 vid ej levererad/utgången/ingen transport). (3) testorder i exporten har explicit `source:"stripe_test_adminorder"` och `test:true`, aldrig `stripe_live`; ordinarie bokföringsexport utesluter dem (`?test=only` för diagnos).
- fix3b (Anders 20:36): köpmejlet är KORT ("Tack för ditt köp! / Din beställning är bekräftad. Vi förbereder din jämförelse. / Avtal och köpinformation finns i bifogad PDF. / Frågor? <säljarens e-post>"). Hela det frusna avtalet (belopp, säljare, exakt godkända texter + hashar/tider, ordernummer, fullgörande, ångerrätt, fulla villkor, ångerblankett) ligger i `Avtal-och-villkor.pdf` (klickbara länkar). Rapportmejlet är kort med HELA rapporten som `Jamforelse-<NR>.pdf` (alla delar: omfattning, priser, frågor, källkortsstatus, gränser, kvitto) + samma avtals-PDF + 24 h-resultatlänk. Nya moduler `compare_pdf.js` (ren Worker-PDF 1.4, Helvetica/Courier WinAnsi, tabeller, sidfot, URI-annoteringar; deterministisk) och `compare_docs.js`; inga beroenden/providerresurser. PDF:erna byggs VID SÄNDNING ur ledgerns frusna avtal och den lagrade rapporten (utkorgen bär bara `{gen:"agreement"|"report"}`, ingen rapporttext sparas där); saknas underlag ⇒ mejlet stoppas utan sändning (`bilaga_kunde_inte_byggas`). Startgrinden är oförändrad: signerad delivered för `mail_avtal_<id>`. Personlig ångerlänk (råtoken lagras aldrig) finns bara i bekräftelsens PDF; rapportmejlets avtals-PDF är samma dokument men hänvisar till bekräftelsen/köpsidan/blanketten. Avtals-PDF:ens ångerblankett har Konsumentverket-mallens källrad utan sha256-strängen.
- Tester (riktade): compare_report_mail 5, compare_pdf 4, ui compare_mismatch 2, ui compare 74, worker compare_* 29 filer gröna (d06/gate/mailer/mail_events/policy_p/seller/terms anpassade: korta brödtexten, texter/länkar läses ur PDF, bekräftelsemejlet skiljs från rapportmejlet).
## jamfor-v2k – D16-R2: adminspärrad Stripe-testorder + separat testwebhook på samma Worker/pott (ovanpå D16-R1, AV som standard)
- `testChain(env)` (compare_config.js): AV tills ALLA gater: `COMPARE_TEST_CHAIN=1`, `COMPARE_TEST_CHAIN_UNTIL` (ISO, framtid, ≤48 h), krypterade `STRIPE_TEST_SECRET_KEY` (sk_/rk_test_) + `STRIPE_TEST_WEBHOOK_SECRET` (whsec_), `COMPARE_ADMIN_TOKEN` (≥24), riktig HTTP-mejltransport. Live-secrets/FREE-pilot/publik checkout oförändrade.
- Nya rutter (compare_routes.js): `POST /compare/admin/test-order` (ADMIN_TOKEN, max 2 per 48 h via KV-räknare, kräver pott-kapacitet), `POST /compare/admin/test-order/:id/checkout` (testnyckel, testläge, mottagare tvingad `hej@stahledigital.se`), `POST /compare/webhook-test` (egen hemlighet; endast testordrar).
- CompareOrders: `test:true` på ordern; `/paid`+`/checkout-expired` nekas om test≠viaTestHook (live-webhook kan inte betala testorder och tvärtom); `/accept`/`/checkout-begin`/`/checkout-set` kräver testAdmin för testorder (användarpublik checkout nekas); testorder kan bara ha kontaktmejl hej@; ledger märkt `test:true`.
- Samma CompareOrders + gemensam FreeBudget-pott ⇒ riktig reservation/avräkning i TOTAL 20 USD; riktig Resend + befintlig Resend-webhook (`/compare/mail-events`) ⇒ verklig signerad delivered → startgrind.
- Tester: `test/compare_test_chain.test.mjs` (4); D14/P/unpaid/flow/atomic/retention/pot/gate/terms-sviter gröna (83 totalt körda). Allt offline med dubbel; ingen leverantör kontaktad.
- fix2 (rootdiff 19:54): testorder går ALLTID mot Stripe TEST i statusavstämning (`retrieveSession`/`retrieveRefund`/`/paid`-reconcile med `viaTestHook`) och DO-återbetalning (`_runRefund` via `stripeEnvFor`); saknad/ogiltig testnyckel ⇒ neka (inga Stripe-anrop, refund `needed`) även efter utgånget testfönster, aldrig live-fallback; intern testmarkör (`testOrder`) i DO→Worker-svar, läcker inte till klient. Ordinarie bokföringsexport (JSON/CSV) utesluter testordrar; `?test=only` = explicit testdiagnostik med `test`-flagga (exportRow har nu `test`). AI-budget oförändrat gemensam. Tester `compare_test_chain2.test.mjs` (4); 129 riktade tester gröna.


## jamfor-v2i – D15: fastställda P-villkor (villkor-p-1) + automatisk rensning av obetalda ordrar (ovanpå bb79162e)
- D15b/S2 (Anders "kör d15" 2026-10-11 18:38): `consentDraft(env)` – policy P är inte längre utkast (villkor-p-1 / samtycke-p-1, ARN-text enligt Modesty SLUTPOLICY_FORLAGA §12.5, inga [UTKAST]/[platshållare]); policy Q förblir utkast och kan inte gå live. Bekräftelsemejl, mottagningsbevis, avtalspost (`avtal-1`) och sidorna villkor/kop/angra/jamfor visar bara utkastrader när draft=true. Live-betalning kräver fortfarande alla övriga grindar (nycklar, säljare, retention, caps, mejltransport, leveransbevis). Ingen ny funktion, 49 kr/P/enruta/gratisflöde oförändrat.
- D15a: obetalda ordrar rensas automatiskt (larm vid skapande; fas 1 utgång+65 min: filer/ext/preid/sources; fas 2 +72 h: hela posten) i ett serialiserat steg med återkontroll före fullwipe; betald order/avtalspost raderas aldrig. Retention av betalda ordrar är oförändrat manuell/lazy.
- Tester: worker 429/429, ui 27/27, compare-UI 74/74.


## jamfor-v2h – D14-fix2: avbruten fullpurge förlorar aldrig städunderlaget (ovanpå 4d633e46)
- Fullpurge skriver `cleanup` BESTÄNDIGT före all radering (kastar skrivningen ⇒ inget raderas, nästa svep försöker om); själva raderingen är EN atomär transaktion som aldrig rör `cleanup`; ett befintligt underlag raderas först när allt (global mr + ledgerindex) är städat via `_retryCleanup`. Avbruten radering rullas tillbaka. `_retryCleanup` sväljer skriv-/raderingsfel och behåller underlaget. Ingen policy-, UI-, provider- eller liveändring.
- Tester: 3 nya regressioner (skrivavbrott, raderingsavbrott/rollback, återhämtning utan orderobjekt); de två första faller på 4d633e46.

## jamfor-v2g – D14-fix: monotont tidigt bevis + beständigt städunderlag (ovanpå f0b64d93)

- **Rootens repro (förlorad ack, bounced först, 9× email.sent, delivered, allt före ack):** `early` var en rullande lista (`slice(-8)`) som tappade bounce. Nu en MONOTON mängd per provider-ID och klass (`early.ids[id].seen[klass]`); negativa klasser kan inte trängas ut. Fler än 8 olika ID:n före ack ⇒ `overflow` ⇒ `earlyUnbound` ⇒ FAIL CLOSED (`deliveryOk` falskt, aldrig leveransbevis för mejlet). Resultat: 0 modellgenerationer, order `failed`, leveransläge `bounced`.
- **Städ:** avtalsstrip tar nu bort det globala `mr:`-indexet FÖRE lokala `mailref:`; misslyckade ID:n sparas i beständigt `cleanup`-underlag (orderId, paidAt, ID:n) som överlever både strip och fullpurge. Vid kvarstående underlag behålls ledgerindexet så att `/compare/admin/retention-sweep` når ordern; svepet försöker igen och tar bort ledgerindex + underlag först när städningen är klar.
- Tester: +5 i `compare_mail_events.test.mjs` (rootens repro, bufferordning, overflow, städ misslyckad→klar, städ ok). Inga UI/policy/pris/liveeffekter.

## jamfor-v2f – D14: signerad Resend-eventadapter, leveransbevis skilt från transportaccept (ovanpå 140d317f)

- `worker/src/compare_mailer.js`: Svix-verifiering (råbody + id/timestamp/signatur, ±300 s), sanering av Resend-händelser, ordningsoberoende leveransläge, `gmo_mail`-tagg i begäran, `COMPARE_MAIL_WEBHOOK_SECRET` (saknas ⇒ HTTP-sändning AV, `reasons: events`).
- `worker/src/compare_orders.js`: HTTP-`sent` öppnar inte startgrinden; krävs signerad `delivered` för samma provider-ID. Negativ leverans ⇒ generation 0 + befintlig refundgrind; delayed/okänd ⇒ väntan till 30 min. Event före ack buffras och binds vid kvittens. Beständig `mailref:`-koppling; ledgerexport visar `confirmationMail` (inboxProof:false). Policy P: `confirmation.deliveredAt`.
- `worker/src/compare_routes.js`: `POST /compare/mail-events`. `compare_budget.js`: globalt provider-ID→order/mejl-index (bara ID:n).
- Tester: `compare_mail_events.test.mjs` (19) + befintliga mailertest anpassade (webhook-hemlighet i ON, leveranshändelse efter ack). Ej bevisat: riktig Resend/inkorg/Cloudflare-drift/juridik.

## jamfor-v2e – gratis→betald: skylta företagens omdömen i erbjudandet (copy, ovanpå 5eadff47)

- `index.html`: en kompakt rad i `#cmpoffer` och i resultat-CTA (`#cmpr-rev`/`#cmpo-rev`): ”**Jämför också företagens omdömen, betyg och antal recensioner sida vid sida när källor finns.** Vilka källor som finns för just dina firmor visas innan du betalar.” Inga löften om senaste/exakt antal/alla firmor, ingen egen syntes/ryktespoäng/kreditvärdighet, inga liveprovider-påståenden (omdömen visas först där faktisk källtäckning verifierats; offline är attrapper/EXEMPEL). 49 kr inkl. moms, 2–4/en offert gratis, CTA, handoff, en-ruta och backend oförändrade. Test: gratis-UI-testen asserterar texten (båda platser, 390/1280), ingen dubblering.

## jamfor-v2d – policy P: EN kärnsammanfattning i förköpet (minimering ovanpå 4c91944e)

- **Flyttat bakom Läs mer (P):** listan ”Det här får du” (+ dubblerad täckningsrad `#coverage`), begränsningstexten, ”får inte” och ”så går det till” ligger nu i det märkta avsnittet ”Läs mer: vad som ingår, vad som inte ingår, begränsningar och hur det går till”. I retry-vyn ligger begränsningar under ”Läs mer: begränsningar”.
- **Fortsatt synligt vid Betala 49 kr:** EN ”Det här köper du” (aktuellt antal, rapportens huvudinnehåll, 49 kr inkl. moms/engångs/ingen prenumeration, faktisk källtäckning, när tjänsten är helt utförd + e-postkvitto, säljare), källpanelen, e-post, den oikryssade gemensamma deklarationen, villkorsmeningen med länk och ”Betala 49 kr”. Samma struktur i retry. Policy Q: oförändrat (listan ligger kvar synlig).
- Backend, bevis, mejl (full information + blankett) och spärrar orörda. Tester: P-testen uppdaterade (dold lista, Läs mer öppnar, retry). Ej bevisat: riktig mobil/VoiceOver, juridik.

## jamfor-v2c – policy P: köpsammanfattning mot ordern faktiska antal + komplett retry-vy (separat rättning ovanpå 39d6504a)

- **P1:** ”Det här köper du” byggdes bara vid init och sa 2 offerter även vid 3–4. Nu följer den `state.docCount` (sätts när ordern skapas och från `order.docCount` vid reload/återupptagning) och uppdateras när erbjudandet visas, vid ändrad hash och i retry. Gamla testassertioner som låste ”2” (med 3 offerter) rättade.
- **consentAgain (retry/needAccept/ändrad text):** samma kompakta sammanfattning (antal, 49 kr inkl. moms/engångs, begränsningar, när helt utfört, säljare, villkorsmening med länk) + EN ruta; `pay2` är inaktiv tills rutan markerats (disabled→enabled→disabled). Policy Q oförändrad.
- Köpknappen heter ”Betala 49 kr” i både första köpet och retry (enligt root). Inga extra rutor, inga ångerkort; ångerlogik/bevis/mejl/spärrar orörda.
- **Tester:** nytt 2/3/4-test med reload ⇒ retry (×390/1280), uppdaterade P-tester. Ej bevisat: riktig mobil/VoiceOver, juridik, riktiga leverantörer.

## jamfor-v2b – policy P: EN gemensam samtyckesdeklaration + minimal förköpsyta (separat commit ovanpå v2a; ROOT_MINIMAL_CONSENT_AND_DISCLOSURE)

- **Samtycke:** tre rutor (villkor, start direkt, förlorad ångerrätt) ersatta av EN initialt oikryssad ruta: ”Jag vill att jämförelsen börjar direkt och godtar att ångerrätten upphör när tjänsten är helt utförd.” (EU-kommissionen 2021/C525/01 avsn. 5.6.1: kan uttryckas i en gemensam aktiv handling). Villkorsgodkännandet knyts till köpknappens aktiva klick med synlig mening ”Genom att köpa godkänner du köpvillkoren.” + länk; ingen separat villkorsruta, ingen förkryssning, ingen sammanblandning med frivilliga val. Knappen är inaktiv tills rutan markerats. Knapptexten ”Beställ med betalningsskyldighet: 49 kr” är oförändrad.
- **Frysning (worker):** `CONSENT_P_VERSION` = `samtycke-p-utkast-2`; snapshotens texter: `terms`, `declaration`, `fulfilmentDef` (när tjänsten är helt utförd). `o.accept.consents` = `{terms (via köpknapp), declaration (covers startNow/loseRight)}` med värde/tid/text-ID/text-hash/order; `startNow`/`loseRight` är HÄRLEDDA (`derivedFrom: "declaration"`), ingen falsk logg om tre klick. Server kräver `accept.declaration === true` (nekar gamla tre-rutors-body). Bevisprövningen (consentProblems/startAccepted) väljer nycklar efter frusen form: äldre frusna utkast-1-ordrar behåller exakt sina tre bevis och startar/levereras som förut; blandade former och saknad text nekas (`samtycke_saknas`). Ändrad text ⇒ ny hash ⇒ `consentChanged`/`needAccept` ⇒ nytt aktivt val. Mejlbekräftelsen visar deklarationstext, definition av ”helt utförd” och villkorsmeningen med tid/ID/hash, plus ALLA villkor och standardblanketten som förut. Backendens bevis-/mejl-/atomik-/budgetspärrar orörda.
- **Förköpsyta (P):** kort köpsammanfattning vid knappen (antal offerter/samma jobb, rapportens huvudfunktioner, 49 kr inkl. moms/engångsköp/ingen prenumeration, källtäckning, begränsningar, när tjänsten är helt utförd, säljarens namn, e-post); långa texter bakom tydligt märkta Läs mer (”Läs mer: vad som inte ingår och hur det går till”, ”Köpvillkor, ångerrätt och företagsuppgifter”). Det stora ångerkortet och pnote borttagna. E-posttips: ”Kvitto och avtalsbekräftelse skickas hit.”
- **Efter köp (P):** resultatets länk heter ”Ditt köp och hjälp” utan ångersats. Full giltig leverans: ingen ångerknapp/-länk/-refund (köpsidan visar neutralt att tjänsten är fullt utförd och att ångerrätten upphört enligt bekräftelsen; ingen ”Skicka en ångerbegäran ändå”, ingen ångerkodslänk). Delvis/oklar/äldre leverans (t.ex. källfel): tydligt märkt normalstor ”Ångra avtalet” i resultatets köprad och ångerkort på köpsidan. Sidfoten säger ”Köp, villkor och hjälp” (→ /jamfor/kop/ med hjälp, villkor och ångerkod) bara med policy P; policy Q oförändrad.
- **Tester:** worker +2 (äldre utkast-1-order består; ny deklaration vs blandade former) och uppdaterade P-tester (399); compare-UI: P-testet omskrivet (en ruta, sammanfattning, Läs mer, tangentbord), +2 (ändrad text/retry, ×390/1280), +1 sidfot, källfels-/fullt-giltigt-assert. Ej bevisat (UNKNOWN): rättslig tillräcklighet (U1–U9), riktig mobil/VoiceOver (EJ TESTAT), riktiga leverantörer.

## jamfor-v2a – dataförlust vid antalbyte + återhämtning med väntande offert (separat rättning ovanpå 9b287506; root-repro P1/P2)

- **P1:** `buildSlots` raderade alla offertkort vid antalbyte (2→3 tömde offert 2, redigerad medföljande offert 1 blev blank vid 3→2). Nu byggs kort en gång och behålls; minskat antal döljer bara kort (text, fil, namn, redigeringar består, 2→3→2→3 tappar inget), en synlig notis säger att dolda offerter finns kvar och inte skickas. Order/källor använder bara de n första.
- **P2:** gammal order med 404 blockerar inte längre handoffen: den väntande första offerten tas upp explicit med ärlig notis (ordern fanns inte kvar); en giltig/levererad order skyddas som förut. "Börja om" behåller `#fran=gratis` när en giltig väntande offert finns.
- **Ny flik/Ctrl-klick:** CTA-texten säger nu att offerten bara följer med i den här fliken.
- **Tester:** `tests/ui/compare.test.mjs` +3 (×390/1280 = +6) samt en tidsrace i `ärliga fel` fixad. Inget workerbyte. Kandidat, ej canonical.

## jamfor-v1z – gratis → betald jämförelse: upptäckbar övergång + lokal engångshandoff (isolerad KANDIDAT ovanpå b4eb02a5; ROOT_FREE_TO_PAID_UX_20261011)

- **Gratissidan (`/`)**, bara för rollen "Jag har fått en offert" och bara när serverns `GET /compare/config` säger `enabled && accepting` (annars helt oförändrad, 0 jämförelselänkar): (1) diskret erbjudande på startsidan, (2) CTA efter resultatet (efter "Skicka frågorna"/"Kopiera"/alla fynd, före "Granska en till"): "Har du fler offerter för samma jobb?" / "Jämför vad som ingår, pris och villkor sida vid sida." / knapp "Jämför 2–4 offerter – 49 kr" (pris ur config), "Betalas en gång: 49 kr inkl. moms. Ingen prenumeration, ingen automatisk dragning." Hantverkarrollen får ingen mottagaruppmaning. Exempelresultatet visar CTA men låter exemplet inte följa med.
- **Handoff:** vid aktivt klick sparas första offerten (text, PDF eller foto, exakt de bytes gratissidan har) som lokal engångspost i `sessionStorage` (`sd_handoff_v1`, giltig 30 min, högst ~4,5 MB). Aldrig i adressen (`/jamfor/#fran=gratis` bär ingen data), aldrig i händelser/loggar/anrop. Klick med Ctrl/Cmd/mittenknapp är en ren länk utan offert. Misslyckas lagringen (blockerad/kvot/för stor) visas ett ärligt fel med val "Gå vidare utan offerten" eller "Stanna här" – aldrig ett falskt "följer med".
- **/jamfor/:** bekräftelsen "Din första offert följer med. Lägg till 1–3 offerter för samma jobb." (fokus flyttas dit, namn på filen/"inklistrad text", knapp "Ta bort den medföljande offerten"). Offerten fyller första fältet; inget skickas, analyseras eller betalas förrän kunden själv väljer Kontrollera. Handoffen förbrukas när ordern skapas, slängs när den gått ut, och släpps om kunden själv ändrar första fältet. Reload/back: handoffen ligger kvar tills den förbrukas eller går ut. Byte av antal offerter behåller den. Saknad/gammal/trasig/blockerad handoff ⇒ rubriken "Ingen offert följde med" med orsak, och tomt formulär.
- **Befintlig jämförelse:** finns redan en order lokalt skrivs den aldrig över, ingen ny order skapas och inget tas betalt igen; kunden ser "Du har redan en jämförelse igång" med valet "Fortsätt med min jämförelse" (kastar den väntande offerten). P-samtycken/rättigheter, mailer och worker är orörda.
- **Tester:** `tests/ui/compare.test.mjs` +10 (båda CTA-platserna 390/1280, byteexakt text/PDF/PNG/JPG, inga automatiska anrop, inget innehåll i adress, befintlig order, reload, blockerad lagring, för stor text, gammal/trasig/ogiltig/saknad handoff, tangentbord/fokus, ingen sidoscroll, stängd jämförelse ⇒ oförändrad gratissida). Egna körningar: compare-UI 63/63, gratis-UI 27/27, worker 397/397, 0 skippade.
- **Ej bevisat (UNKNOWN):** riktig mobil/VoiceOver (EJ TESTAT), riktiga produktionsflöden; sessionStorage följer inte med till en ny flik (då visas ärligt "finns inte kvar"). Gratissidan gör en extra `GET /compare/config` vid laddning (samma endpoint som jämförelsesidan använder; ingen modell/källa).

## jamfor-v1y – copyrättning policy P: köplänken beskrivs konsekvent (ovanpå 502adcfb; ingen logik)

- Policy P: förköpets "Så går det till" och e-postfältets hjälptext säger nu att bekräftelsen innehåller en länk till **Ditt köp och villkor** (avtal, hjälp och reklamation samt ånger när ångerrätt finns) i stället för "länk för att ångra köpet"/"din ångerlänk"; samma formulering i P-villkorens avsnitt Avtalsbekräftelse (frusen text, ändrar P-hashen). Policy Q oförändrad. `worker/COMPARE.md` v1w-raden aktualiserad: UI-kvittensen är inkopplad från v1x. Tester: ett copytest (worker) + P-UI-testet kontrollerar `#emailhint`/`#copy-how`.

## jamfor-v1x – policy P: stark bevisprövning + serververifierad källkvittens (bounded rättning ovanpå P 4a42c09d; offline; ROOT_P_4A42_QA_AND_BOUNDED_RETURN 07:59)

- **Orsak (rotens sex prov, REPRODUCED_OFFLINE via lagringsinjektion i minnesadaptern, inget offentligt exploit):** start-grind och `_fulfilment` kontrollerade bara att samtyckesfälten fanns (`.at`/`textHash` sanna), inte deras värde, text/version/hash, orderbindning eller mot ledgern; bekräftelse och rapporthash prövades inte mot varandra; `source-delivered` litade på klientens `state` (även `ingen_kalla` för en täckt firma).
- **Samtycke (`consentProblems`):** vid START (före varje generation, inför varje claim) och vid FULLGÖRANDE: alla tre valen `value===true`, `orderId===o.id`, `textId==="<val>@<snapshot.consentVersion>"`, `textHash===sha256(snapshot.texts[val])`, `sha256(snapshot)===consentHash`, `consentVersion`/`fulfilmentPoint` lika med snapshoten, tid = accepttid ≤ betaltid, samt korskontroll mot den frusna avtalsposten i ledgern (val, text-hashar, punkt, avtalad prestation, accepthash). Motsägelse före start ⇒ ingen generation, ordern avbryts och återbetalas fullt (`samtycke_saknas`); efter leverans ⇒ saknat `samtycke` ⇒ ångerrätten kvar.
- **Bekräftelse (`confirmationProblems`):** mejl-ID `mail_avtal_<order>`, utkorgsposten `sent` med samma ID och samma `sentAt`, `sentAt` ≤ första generationens start (`work.startedAt`, nytt) och ≤ rapportens leveranstid. Motstridig bekräftelse före start ⇒ ingen generation (`bekraftelse_motstrider`); efter leverans ⇒ saknad `bekraftelse` ⇒ rätten kvar.
- **Rapport:** leveransbeviset binds till ordern (`orderId`), tiden = faktisk leveranstid, 64-hex innehållshash, en separat sparad kopia (`deliveryproof`) måste vara identisk, och så länge rapporten finns kvar räknas sha256 om på den FAKTISKT lagrade rapporten och jämförs. Fel ⇒ saknad `rapport` ⇒ rätten kvar.
- **Källor:** den avtalade täckningen fryses nu per firma OCH källa (`agreed.sources.providers`, ingår i avtalsposten). `POST …/source-delivered` ignorerar klientens påstående: servern prövar sin EGEN källstatus – Google: bekräftad profil + visningen i webbläsaren rapporterad "ok" (REPORTED av webbläsaren, kvitteras bara vid lyckad visning), Trustpilot: bekräftad firma + serverns egen hämtning "ok". Källfel/tomt/kostnadsstopp/ej bekräftad/bara en av två avtalade källor ⇒ ingen kvittens (409). `ingen_kalla` avvisas alltid för en täckt firma. En firma räknas fullgjord först när ALLA dess avtalade källor har verifierad visning efter rapportleveransen. Äldre P-poster utan frusna källor ⇒ fail closed.
- **UI:** rapportläget skickar kvittens (`srcReceipt`) först efter lyckad Google-visning (`gmp-load`) respektive lyckad Trustpilot-hämtning; Googles lyckade visning rapporteras nu även som `ok` (tidigare bara `fel`). Normal rapportvy utan stor ångerknapp och två ej förkryssade rutor är oförändrade.
- **Testhjälpare:** `blockConcurrencyWhile` i `compare_env.mjs` serialiserar nu fetch/alarm som Cloudflare gör (återinträdande); tidigare var den en no-op, vilket gav en teoretisk lost-update i testmiljön.
- **Tester:** `compare_policy_p_evidence.test.mjs` (6): rotens prov före start (11 varianter, 0 generationer, full refund), ledger-korskontroll (5), efter leverans (15 varianter + kontroll), hel kedja med verklig täckning via Trustpilot-/Google-attrapparna, källfel/tomt/partiellt/båda källor, injicerad täckning + klient-`ingen_kalla`. Gamla partiella-täcknings-testet (som injicerade täckning) ersatt. UI: två nya P+källor-tester (lyckad visning ⇒ upphör; källfel ⇒ kvar).
- **Ej bevisat (UNKNOWN):** riktig Cloudflare/Resend/Google/Trustpilot, juridisk tillräcklighet (U1–U9), riktig mobil/VoiceOver (EJ TESTAT). Webbläsarens "ok" för Google är REPORTED, inte servermätt. Inget push/deploy/live.

## jamfor-v1w – policy P: två aktivt valda samtycken före betalning, serverbedömt fullgörande (isolerad KANDIDAT – AV; ovanpå d0e70c0a; Modesty §12; Anders direkt 07:31/07:40)
- `COMPARE_CONSENT_POLICY=P` (default Q = oförändrat; samma hash/texter/beteende): två SEPARATA ej förkryssade rutor – start direkt inom ångerfristen + godtar förlust av ångerrätten först när tjänsten är fullt utförd – utöver villkoren; knappen "Beställ med betalningsskyldighet: 49 kr" är inaktiv tills alla val gjorts. Servern avgör policy och validerar (`startNow===true && loseRight===true`); Q-stil/delvisa/falska värden ⇒ 400, ingen betalsession.
- Frysning vid /accept: per val tid, text-ID (`<ruta>@samtycke-p-utkast-1`), text-hash, order-ID; policy, `fulfilmentPoint` (`COMPARE_FULFILMENT_POINT` = leverans (default) | fonster_slut; ogiltigt ⇒ stängt), avtalad prestation (rapport + täckta källfirmor + täckningshash) och hela texten/versionen ingår i consent-hashen och avtalsposten. Policyn är frusen per order: redan skapade Q-ordrar ändras aldrig (ingen retroaktiv Q→P).
- Bekräftelsen ("sent") före start oförändrad grind + P kräver båda frusna samtycken vid start (`samtycke_saknas` ⇒ avbryts/återbetalas, ingen generation). Bekräftelsen återger valen ordagrant med tid/hash, fullgörandepunkt, vad som händer före/efter fullgörande och normal länk till Ditt köp och villkor.
- `_fulfilment`: fullgjord först när samtycken + bekräftelse sent + leveranshändelse (tid + innehållshash) + (om täckning ingår) kvittens per täckt firma [+ 24 h-fönster vid fonster_slut]. Saknat/partiellt/motstridigt bevis ⇒ ångerrätt kvar. Ånger: före fullgörande ⇒ stopp + FULL återbetalning (ingen proportionell avgift, resultat/rapport raderas); efter ⇒ begäran sparas med mottagningsbevis, utfall `angerratt_upphord`, ingen ångerrefund, reklamation/support oförändrade. Ingen nekan för att rapporten visats/hämtats.
- Ny `POST /compare/orders/:id/source-delivered` (token; bara efter levererad rapport, bara täckta firmor). UI-kvittering från källpanelen är INTE inkopplad (reviewsActive är AV) ⇒ en framtida täckningsorder förblir fail closed (ångerrätt kvar) tills den kopplas.
- UI: `jamfor/index.html` (rutor, ångerinfo, knapptext, consentAgain), `jamfor/kop/` (rights: upphörd/kvar, utfallstexter), `jamfor/angra/`. Tester: `compare_policy_p.test.mjs` (14) + 3 UI-tester (P 390/1280, fonster_slut). Ingen serverkod för Q ändrad; ingen riktig Stripe/modell/mejl/Google.
- Kvarstående (U1–U9, blockerar liveaccept, inte offlinekandidaten): klassificering tjänst/digitalt innehåll/blandat ej avgjord, fullgörandepunkt (24 h som prestation?), omdömesvisning som avtalad prestation (D07-licens UNKNOWN), 9 § 2 st knappmärkning ej omläst, extern juridisk granskning saknas, texterna är UTKAST.

## jamfor-v1v – resultatet fokuserar på jämförelsen: ingen stor "Ångra köpet"-knapp efter rapporten; ny köpsida /jamfor/kop/ (KANDIDAT – AV; ovanpå 179b22a; Anders direktorder 07:29)
- `jamfor/index.html`: `withdrawBlock` visas inte längre i rapportens primära innehåll; i stället en normalstor länk "Ditt köp och villkor" (#buylink, 16 px+, ingen inloggning, bär orderlänken i fragmentet). Statusvyn före leverans (betald/körs/misslyckad) är oförändrad.
- Ny `jamfor/kop/index.html` "Ditt köp och villkor": avtal/ID/bekräftelsestatus, fungerande Ångra köpet (samma serverroute och rättigheter), villkorslänk, reklamation/support (efter leverans också), ångerkodsidan, ärliga feltexter. `jamfor/angra/` pekar dit.
- Ingen serverändring: serverrättigheter, föreleveransstopp/återbetalning och livepolicy oförändrade; ingen automatisk nekning för att rapporten visats; ingen P-/Q-ändring (P-kandidat beredes separat).
- Tester: UI ånger efter leverans (390/1280) ersatt av länk→köpsida→ånger; köpsida utan order; ånger via köpsidan under körning.

## jamfor-v1u – mejltransport: senare stopp ersätter inte tidigare okänt utfall (root-QA ROOT_MAILER_28284; KANDIDAT – AV; ovanpå 28284f3a; ENDAST HTTP-dubbel)
- `_stopMail`: ogiltig mottagare, ändrad nyttolast, terminal/config/409-payload efter tidigare `unknownOutcome` ⇒ `avstamning`/`utfall_okant` (`laterStop` = koden); första säkra stopp utan osäkerhet ⇒ `failed`; okänt→ID-ack ⇒ `sent`. Stabil nyckel/frusen nyttolast/dygnsreservation/confirmWait oförändrade.
- Tester: `compare_mailer_fix.test.mjs` +7 (6 kombinationer röda mot 28284f3a); `compare_mailer.test.mjs` förväntan för 500→manipulerad nyttolast uppdaterad (failed→avstamning).

## jamfor-v1t – mejltransport: dygnstak per UTC-dygn + okänt utfall som avstämning (root-QA ROOT_MAILER_37B9; KANDIDAT – AV; ovanpå 37b9c535; ENDAST HTTP-dubbel)
- P1: `_drainOutbox` reserverar nu `countToday` per meddelande OCH faktiskt UTC-dygn (`capDay`) före HTTP, även för omförsök efter midnatt; samma meddelande räknas högst en gång per dygn; stabil nyckel/frusen nyttolast/lease/ack-lost-skydd oförändrade; nekad ⇒ inget HTTP.
- P2: okänt utfall till försöksslut ⇒ `avstamning`/`utfall_okant` (inte `failed`); verifierade terminala avslag förblir `failed`. `jamfor/index.html` `mailText`: ärlig text för avstämning.
- Tester: `compare_mailer_fix.test.mjs` (5; 4 röda mot 37b9c535, positiv parallellkontroll grön före/efter) + UI-test avtalsstatus (390/1280). Ingen nyckel/verkligt HTTP/utskick.

## jamfor-v1s – verklig mejltransport (HTTP, DEFAULT AV) + varaktig ångerblankett (KANDIDAT – AV; ovanpå aeec6c38; testad ENDAST med HTTP-dubbel)
- Ny `worker/src/compare_mailer.js`: HTTP-adapter (Resend-format enligt primärdocs; ej leverantörsval) bakom fem samverkande villkor (flagga, verifierad-flagga, avsändare, dygnstak>0, nyckel); en nyckel ensam aktiverar inget. Stabil `Idempotency-Key` per meddelande, frusen begäran, 23 h-fönster ⇒ `avstamning`, lease mot dubbelsändning, 409-hantering (payloadkonflikt stoppar, pågående = begränsade omförsök), ack bara vid 2xx + giltigt ID, sent = transportaccept. Spårat dygnstak via befintlig `countToday`.
- `compare_orders.js` `_drainOutbox` utökad (befintligt outbox-kontrakt och bekräftelse-före-generation-grind oförändrade; adapter/mock får även typade bilagor). `compare_ledger.js`: Konsumentverkets ångerblankett som faktisk text + typad bilaga, förifylld ur frusna avtalet (ersätter placeholdern); utkorgsposten bär bilagor + `payloadHash`.
- Tester: `worker/test/compare_mailer.test.mjs` (11) – default/config/cap/concurrency/acklost/stabil nyttolast/omstart/24 h/409/gen0/blankettprefill/configändring/refund; Resend-dubbel i `compare_env.mjs`. UI: statusen `avstamning` visas som manuell hantering.
- Ingen nyckel/credential, inget verkligt HTTP/utskick, ingen Q/P-/retention-/slutvillkorsändring.

## jamfor-v1r – neutral Google-knapp "Visa Googles omdömen" (root-fynd 23:04; KANDIDAT; ovanpå e00fe23a)
- `jamfor/index.html` rad 818/820: knappen lovade alltid "Visa Googles senaste omdömen"; konfigurationen `rank-preference="newest"` är inte faktisk levererad ordning. Nu neutral text "Visa Googles omdömen" (även när widgeten stängs). Försöket med newest och ärlig täckningsstatus är oförändrade; Trustpilot-knappen ("senaste") är kvar eftersom serverns ordning verifieras. Inget Googleprov/ingen nyckel/ingen providerkostnad. UI-testerna uppdaterade till ny knapptext.

## jamfor-v1q-fix1 – säljarinfo: no-echo även via VAT/andra fält; docs-synk footerlänk (root-QA P1; KANDIDAT – AV; ovanpå a6a98a08)
- Rotorsak (reproducerad av root): ENSKILD med förbjudet 12-siffrigt org.nr + VAT = SE+samma siffror + `COMPARE_CONFIRM_SHOW_VAT=1` ⇒ `sellerInfo` saniterade org.nr men lämnade VAT ⇒ identifieraren syntes i `terms.seller.vat` och säljarsektionen trots köpstopp.
- Nu: vid konfigfel släpps VAT-raden helt och varje fält som innehåller värdet eller dess sifferföljd redigeras till platshållare (bara fältnamn i `missing`). Giltig ENSKILD med tillåten, osammanfallande VAT fungerar oförändrat. Nytt negativt test (rött mot a6a98a08) + positivt kontrollfall.
- Docs: ångrasidans footer är bara den statiska reservlänken (hämtar inte config); COMPARE.md synkad mot verklig funktion. Ingen produkt-/budget-/juridikändring.

## jamfor-v1q – konfigurerbar säljarinfo AB/ENSKILD (Modesty §5h; teknisk OFFLINEförlaga, KANDIDAT – AV; ovanpå b9650b3f)
- `COMPARE_SELLER_FORM` (AB|ENSKILD) obligatorisk; ENSKILD kräver ägare och tomt org.nr (annars konfigfel `orgnr_forbidden_enskild`, värdet återges aldrig, ordrar stängda i alla lägen); AB kräver org.nr med Luhn + tredje siffran ≥ 2 (personnummer avvisas). Namn/adress/e-post/telefon/https-företagsuppgiftslänk krävs. VAT valfri, visas bara med `COMPARE_CONFIRM_SHOW_VAT=1` (då SE+12 krävs).
- Form/ägare/org.nr-rad/VAT-flagga/länk ingår i termsSnapshot ⇒ samtyckeshash, avtalspost, bekräftelse. Kassan visar samma säljarrader direkt; länk "Företagsuppgifter" i footer på /jamfor/, villkor, ångra. Ingen ändring av offert-/prislogik, canonical eller publik företagssida.
- Syntetisk fixtur 556000-0001 (beräknad kontrollsiffra, ingen registerkontroll); 556000-0000 bara negativt fall. Enskild-firma-tolkningen är OPEN.

## jamfor-v1p-fix3 – docs-only: förköpets kostnadsrad (root-QA; KANDIDAT – AV; ovanpå 03aa366e)
- `worker/COMPARE.md`: budgetnyckel är `pid:<order>:<claimId>` (inte `<idx>:<försök>`); ~0,27 USD vid ~3 000 tokens/4 dokument är endast ett SCENARIO, inte ett universellt minsta ordertak – reservationen beräknas efter verkligt maxindata (dokumenttokens + marginal) och försök, och människosatt tak måste täcka den; inget tak antaget. Modell (Sonnet 5.5) och gemensam 20 USD-pott borttagna ur human-beslutslistan (redan beslutade). Ingen kod/test ändrad.

## jamfor-v1p-fix2 – förköpsidentitet: unik claim per generation, hash/ctx-bindning, kontrollerat put (root-QA P1; KANDIDAT – AV; ovanpå 5a79713a)
- Rotorsak (reproducerad av root): claim återställde `attempts` vid filbyte ⇒ budgetnyckeln `pid:order:idx:attempt` återanvändes (andra reservationen skrev över första ⇒ 700 i stället för 1400 µUSD) och put kontrollerade bara attempt-numret, inte vilken claim/fil svaret hörde till ⇒ gammalt svar kunde lagras för nytt dokument.
- Nu: varje faktisk generation får ett monotont, aldrig återanvänt `claimId`; budgetnyckel `pid:<order>:<claimId>` ⇒ två generationer = två reservationer/avräkningar (även avvisat sent svar avräknas en gång). Posten binds till dokumenthash + `ctx` (modell, promptversion, prompttext, verktygsschema, sha256). Put kräver samma claimId + hash + ctx och pågående state; routen kontrollerar put-resultatet (annars 409, inga gamla uppgifter ut). `/preid-get` och GET identity returnerar bara poster med aktuell hash+ctx. Filbyte efter done ⇒ "ingen" tills ny läsning.
- Regressionstester (röda mot 5a79713a): båda svarsordningarna, filbyte efter done, parallell samma dokument + cache, ctx-bindning.

## jamfor-v1p-fix1 – förköpsidentitet: modell Sonnet 5.5, fail closed (KANDIDAT – AV; ovanpå 7ba27cf7)
- Rättelse: standardmodellen claude-haiku-5-5 stred mot Anders beslutade Sonnet 5.5 för GMO. Nu är claude-sonnet-5-5 ENDA tillåtna modell för preid; `COMPARE_PREID_MODEL` med annat värde ⇒ funktionen AV (503, inget anrop). Inga Haiku-anrop har gjorts; allt är attrapper.
- Kalkyl: värsta fall ≈ 0,066 USD/dokument (3 000 tokens in, 6 000 ut); ordertaket måste rymma ≥ ~0,27 USD för 4 dokument. Fortfarande samma gemensamma 20 USD-pott, ingen ny pott/reset, AV som standard.

## jamfor-v1p – D11 förköpsidentitet/täckning före köp (KANDIDAT – AV, ej släppt; ovanpå P2d-fix 8930b381)
- Ny modul compare_preid.js + DO-ops (preid-claim/put/get) + `POST /compare/orders/:id/preid` + UI-knapp (användarstartad, servertext UTKAST). ETT litet identitetsanrop per offert (verktyg submit_issuer), reserverat i den gemensamma potten via guardedCall (exporterad), engångs per dokument (sha256), högst 2 försök, claim mot parallellt, radering med ordern.
- AV som standard: COMPARE_PREID + COMPARE_PREID_VERIFIED + COMPARE_PREID_ORDER_CAP_MICRO krävs. Modell: claude-sonnet-5-5 (se v1p-fix1); träffsäkerhet EJ TESTAT.
- Förslag före köp med samma regler som efter köp (auto/Stämmer/enskild/saknas); GET /sources/identity ger förköpsförslag (stage "forkop") utan nytt anrop. Ingen automatisk Google-matchning.
- Tester: worker 332/332 (nya compare_preid: av/på, pott, engångs, fel/försök, halt, ordertak, behörighet), UI: förköpsflöde.

## jamfor-v1o-fix1 – D11-P2d rättning: betygscachen bunden till firmans identitet (root-QA P1; KANDIDAT – AV)
- Rotorsak: SRCTPD/SRCTPTRY var nycklade bara på firm.id; ändrad domän/namn/ort nollställde serverns Trustpilot-koppling men inte klientens betyg ⇒ ★ och betygssortering kvarstod.
- Nu: cachen bär `sig` = id|namn|ort|domän|TP bekräftad|TP-revision (serverfält `trustpilot.rev`, ändras vid varje ny/borttagen koppling; ingen BU-id exponeras). Ogiltig sig / borttagen firma / avbekräftad koppling ⇒ posten gäller inte och rensas. Inflight-svar kontrolleras mot sig vid mottagandet (sent svar kastas, ny hämtning för ny identitet). Vald betygssortering faller tillbaka till uppladdningsordning när underlaget försvinner.
- Betygssortering kräver ≥2 DISTINCTA aktuellt bekräftade firmor med uppgift (samma firma i två kolumner räknas som en).
- Regressionstester (röda mot gamla koden, gröna nu): root-repro domänbyte, byte av koppling, inflight-svar efter identitetsbyte, samma firma i två kolumner.

## jamfor-v1o – D11-P2d källrad med betyg vid offerten (KANDIDAT – AV, ej släppt; ovanpå D12-integrationen 099df5ce)
- Källraden vid varje offerts firmarubrik visar nu "★ 4,6 av 5 · 310 omdömen · Trustpilot" när firman är bekräftad och serveradaptern levererat totalbetyg + antal. Hämtas automatiskt EN gång per firma och sidvisning (servern äger tak/kostnadsstopp); fel/stopp ⇒ "betyg kunde inte hämtas just nu", aldrig påhittad stjärna. Firma utan uppgift: ingen stjärna ("ej kopplad"). Google: raden säger bara om firman är kopplad – Googles betyg kan visas enbart i Googles egen ruta (se COMPARE.md).
- Sortera efter "Högst Trustpilot-betyg": på först när minst två firmor har Trustpilot-uppgift; högst först, lika = delad placering, okända sist ("Ej bedömbart"), ingen egen poäng/total, ingen rekommendation. Google kan inte sorteras (ingen avläsning).
- Firmanamn/orgnr läses som tidigare ur offerten (P2c); manuell inmatning är undantaget. Före köp finns ingen täckning per firma (identitet läses först efter köp) – oförändrat och redovisat ärligt.

## jamfor-v1n – D12 integrerad i betalkedjan (KANDIDAT – AV, ej släppt; ovanpå D11-P2c 1552eda7 + D12 8da1c644)
- EN gemensam ändlig pott (FreeBudget, D12 exakt källa) för ALL modellförbrukning: gratis /review,/explain och betald jämförelse. Ingen separat/extra 20 USD-pott när betalgrenen kopplas in; CompareBudget-taken (månad/betald/order) är enbart extra begränsningar. Betalda generationer stoppar vid pilotens slut eller tak; ordern får `pott:<orsak>`.
- d04:s egen COST_GATE/cost_gate.js är borttagen till förmån för D12 (samma reservera→avräkna→frigör/halt-semantik, atomär transaktion). /health visar bara freeGate {open,state}.
- wrangler: FreeBudget migration v3 (live sedan gmo-api-v13) orörd; compare-migreringen (utkommenterad) numrerad v4 vid framtida släpp. Frontend b04e90ab/gmo-v21 orört.
- Test: compare_pot (betald trafik delar potten, ej aktiv/litet tak ⇒ inget anrop), compare_runtime/harness med FREE_BUDGET-DO. Offline; ingen deploy/push/riktigt modellanrop.

## jamfor-v1m – D11-P2c företag läses ur offerten (KANDIDAT – AV, ej släppt; ovanpå D11-P2b a4054d91)
- Efter köpet föreslås firman per offert ur utställaridentiteten (GET /compare/orders/:id/sources/identity, bara efter leverans): komplett identitet + utförare + bolag + ort + ingen namnkrock ⇒ läggs in automatiskt (origin "dokument"), annars kort "Stämmer det?"; enskild firma ⇒ inget namn/ort lämnar servern och inga källor; ej avläst/saknas ⇒ kort rad + "Lägg till företag". Normalt ingen manuell inmatning.
- "Ändra företag" per firma (origin "kund" vinner över dokumentförslag); ändrad identitet nollställer gammal Google-/Trustpilot-matchning. Manuell ruta före köp är valfri och hopfälld. Förslagen bär aldrig orgnr/adress/telefon.
- Google-matchningen kan inte automatiseras (nativt widget, ingen skrapning): identiteten förifyller bara firman, kunden väljer själv i Googles egna träffar.

## jamfor-v1l – D11-P2b offert först: kolumner, Sortera efter, Visa mer (KANDIDAT – AV, ej släppt; ovanpå D11-P2a ecb58fb9)
- Resultatet visar 2–4 offerter som kolumner med jämförbara rader (pris inkl. moms/ROT-bas, arbete/material, omfattning, start/tid, betalning/ÄTA, företagsuppgifter). ✓ endast vid uttryckligt "ingår", ? (text+ikon) när det inte framgår, "Kunde inte avläsas säkert" skilt från "Framgår inte". Avvikande rad märks direkt.
- En liten "Sortera efter"-meny: uppladdningsordning (start), lägst jämförbart pris (bara när jämförbart), minst/flest oklarheter (fast uppsättning, delad placering, ej bedömbart sist – aldrig 0/sämst), högst Google-/Trustpilot-betyg avstängt tills verifierad dataåtkomst/villkor. Ingen total-/bäst-poäng. Hela kolumnen flyttas.
- Smal skärm: två offerter åt gången med val. Långa förklaringar (jämförbarhet, skillnader, metod, begränsningar, omdömen) ligger under EN hopfälld "Visa mer"; kompakt källrad (Google · Trustpilot, "Visa omdömen") vid firmarubriken.

## jamfor-v1k – D11-P2a utställaridentitet (KANDIDAT – AV, ej släppt; ovanpå D11-P1 8d8a57d3)
- Avläsningen läser utställarens namn/orgnr/adress/ort/telefon/webb med belägg (EXTRACT avlasning-2); avläsningsfel skiljs från saknat; personnummerliknande orgnr ⇒ enskild firma, aldrig till recensionskällor.
- "Uppgifter att reda ut" per offert på fast uppsättning (mycket svårläst ⇒ ej bedömbart, aldrig 0/sämst); saknad väsentlig företagsuppgift är offertbrist och ingår i fullständigheten; original bevaras.

## jamfor-v1j – D11-P1 Google-laddning och newest (KANDIDAT – AV, ej släppt; separat rättning ovanpå D10 8f2ed855)
- SDK: en enda delad laddning (singleflight) med Googles callback som beredskap (inte script-onload); timeout avbryter bara väntan; Försök igen väntar in samma laddning, ny script endast efter verkligt nätfel och efter att den felande taggen tagits bort. Rättar root-realprovets onload-race och dubbel-load/Loader.provide-fel.
- Newest: rank-preference="newest" (enda dokumenterade formen, Advanced Place Details) sätts före montering, property sätts om den finns, och vår egen konfiguration läses tillbaka. Bekräftas inte ordningen visas ärlig notis (Googles egen ordning) – ingen "senaste först"-claim. Rotens motexempel (Elajo 4 år före 3 år) är UNVERIFIED-orsak; ingen widgetavläsning/skrapning.
- Ingen ny reservation, inget nytt anrop; reservationen sker fortsatt före varje instans.

## jamfor-v1i – D10 Swish via Stripe (KANDIDAT – AV, ej släppt; ovanpå D09 9530c46b)
- Konfigurerbar metodlista (kort | kort+swish | dynamiskt), Swish bara med COMPARE_SWISH_VERIFIED=1; metodbindning i serververifieringen; Swish-kundtext före betalning (ingår i samtyckeshashen). Ingen kontoaktivering, ingen riktig betalning.

## jamfor-v1h – D09 Google-mountreservation + hantverksavgränsning (KANDIDAT – AV, ej släppt; ovanpå D08b 7d6d2577)
- Atomisk serverreservation (per order + gemensamt dygnstak + tak per SKU, default 0/fail closed) före varje Search-/AdvancedDetails-instans; nytt mountId per instans.
- Jämförsidan: "Jämför 2–4 hantverkarofferter för samma arbete" + avgränsningsrad (material i hantverkarens offert omfattas; materialinköp/produkt/abonnemang stöds ännu inte).

## jamfor-v1g – D08b rättning efter root-QA 21:10 (KANDIDAT – AV, ej släppt; ovanpå D08 cbf439ff)
- P1: avtalsbekräftelsen grindar arbetet (ingen räkning/generation/claim före godkänd transportkvittens; ärlig väntstatus; retry med samma ID; begränsad uttömning ⇒ `bekraftelse_ej_levererad` + återbetalning); mock-transport endast i test.
- Säljarkrav: telefon obligatorisk för live, id-nummer ej AB-låst, ångerblankettblock i bekräftelsen (ingen blankettext).
- Retention: admin-slutmarkör `retention-close-review` och intervallsvep `from/to` inom befintlig adminrutt; ingen ny resurs/policy.

## jamfor-v1f – rättning efter root-QA 20:38 (KANDIDAT – AV, ej släppt; separat commit ovanpå D07 f96a7b0)
- D06: order+ledger+utkorg skrivs i en lagringstransaktion med idempotent reparation av delskrivning; ångerlänk på startsidan; full säljarinfo och fullständig villkorssnapshot i samtyckeshash/avtalspost/bekräftelse (villkorssidan renderar serverns text); verklig retention-svep (lazy + admin, fail closed).
- D07: Googles element rättade till `gmp-advanced-place-details`, native `gmp-place-search`-val (server Text Search AV bakom extra flagga), nativa `gmp-load`/`gmp-error` + timeout + versionsbunden mount, visningsfel i täckningen, domänkonflikt separeras, identitetsändring rensar bekräftelser, Trustpilot-schemafel ⇒ källfel. Se `worker/COMPARE.md`.

## jamfor-v1b – D04 rättning efter root-QA (KANDIDAT – AV, ej släppt; ovanpå commit 2de6569)
- Gemensam kostnadsgate (AV som standard) för `/review` och `/explain`; alarm vid uttömda försök ⇒ failed; oföränderliga dokumentnycklar + manifest (sen PUT kan inte radera låst original); återbetalning bara `done` vid Stripe `succeeded` (+ avstämning/webhook); checkout-intent frusen per försök; samtycke bundet till version/hash med tydligt UTKASTläge (live stängd); datatäckning “inga omdömen” före köp; ytskillnad utan tolerans och alla omfattningsskillnader stoppar rangordning; UI-testets väntvillkor. Se `worker/COMPARE.md`.

## jamfor-v1e – D07 senaste omdömen (KANDIDAT – AV, ej släppt; ovanpå D06)
- Källpanel per firma (identitet/dedup/filialer, kundbekräftelse), providerstatus, Google UI Kit mount/unmount (rank-preference=newest, utan filter), Trustpilot serveradapter med 24 h-cache, räknartak/kostnadsstopp, täckning före köp. Allt AV (`COMPARE_REVIEWS`+`COMPARE_REVIEWS_VERIFIED` + källflaggor); inga externa anrop gjorda. Se `worker/COMPARE.md`.

## jamfor-v1d – D06 kundkedja (KANDIDAT – AV, ej släppt; ovanpå 6afa4ec)
- Minimal avtalspost skild från 24 h-innehåll, autentiserad ångerväg (knapp + `/jamfor/angra/` med högentropisk kod, hash lagrad), idempotent mottagningsbevis, atomiskt avbrott före leverans, ingen automatisk juridisk avvisning, lokal utkorg med mocktransport (extern adapter AV), skyddad bokförings-/återbetalningsexport utan offerttext, uttryckliga retentionklasser (live stängt utan beslutad policy). E-postadress krävs vid köp. UTKAST; se `worker/COMPARE.md`.

## jamfor-v1c – D04 rättning 2 (KANDIDAT – AV, ej släppt; ovanpå 36e93df)
- Rangordning stoppas även vid asymmetrisk oklarhet i icke-kärn-omfattningsposter (villkor blockerar inte). Gate PÅ mäter alltid med count_tokens (fail closed), reserverar värsta fallet före anrop, och budgeten halterar även vid känd överskridning. Betald jämförelse mäter text som fil och synth-gränsen räknas i bytes. Default AV oförändrad.

## jamfor-v1 – Jämför mina offerter (D04 KANDIDAT – AV, ej släppt; bas = tree 0b19faef (bacbb6a))
- Ny betald tjänst bakom flagga **AV**: jämför 2–4 offerter för 49 kr inkl. moms (engångsköp). Se `worker/COMPARE.md`. `/review` och befintliga sidor är oförändrade (`index.js` har bara export/route-koppling bakom `COMPARE_ENABLED`).
- Serverpris, hostad Stripe Checkout (adapter), signerad webhook, idempotens, kontroll av belopp/valuta/order, atomisk arbetsclaim (DO + lease) och atomisk kostnadsreservation (DO, µUSD) utan standardtak (fail closed). Jämförelsemotor som aldrig rangordnar när omfattningen är okänd eller olika. Datakort finns bara som avstängd offlinemodul.
- Ny sida `jamfor/index.html` (noindex) och villkorsutkast `jamfor/villkor/`. Refaktor utan beteendeändring: `extracted_schema.js` och `user_content.js` ut ur `index.js`.
- **EJ TESTAT/EJ GJORT:** riktiga modellanrop, riktig Stripe (test/live), Google/Trustpilot, riktig mobil/VoiceOver, produktionsbeständighet, juridiska texter. Se COMPARE.md för externa steg.

## gmo-api-v13 – D12 kostnadsskydd för gratisversionen (KANDIDAT – ej släppt, ej deployad; separat gren från livebacbb6a, frontend orörd)
- Ny `worker/src/free_budget.js` (`FreeBudget`, SQLite-DO, enda skrivare): ÄNDLIG pilot med explicit period [FROM, UNTIL) och ETT totalt tak i µUSD – ingen ny pott vid månadsskifte/kalenderomslag. Saknad/ogiltig/utgången konfiguration, saknad bindning, lagringsfel, halt eller slut ⇒ ingen gratisgeneration (503). Tak/slut för samma pilot-id kan bara sänkas; ny pott kräver nytt id + spårbar mandatreferens; ingen reset-/påfyllningsrutt.
- `/review`: alla anrop mäts med count_tokens (även text), reservation av värsta fallet före dagsräknaren och anropet, avräkning mot uppmätt kostnad, release vid HTTP-fel/nekad dagsräknare, halt vid okänd användning/överskridning. Okänd modell ⇒ ingen generation. `/explain` (AV) delar samma pott. `/health` visar `freeGate:{open,state}`. Befintliga 300/dag, IP-/filgränser och REVIEW_RL består.
- Bindning `FREE_BUDGET`, migration `v3`, `FREE_PILOT_ENABLED="0"` i wrangler.toml; inga värden/secrets i repo. Se `worker/FREE_GATE.md` (config, importer, operatörssteg, rollback). 172/172 offline-tester inkl. samtidighet, exakt slut, periodslut/månadsskifte, lagringsfel och workerd-DO.
- UNKNOWN/EJ TESTAT: riktig workerd/Anthropic-usage i produktion, faktisk fakturering; inga riktiga modellanrop gjorda.
- **Rättning (root-QA P1):** `FreeBudget` utför varje operation i EN `storage.transaction`; halvskrivningar (m skriven, r-skrivning felar) rullas tillbaka och retry räknar aldrig bort förbrukning två gånger; saknad transaktion ⇒ nekat. Halt-policy, tak och period oförändrade. Fake-adaptern har riktig rollback + faultinjektion; nya facit (root-scenariot, faultmatris) och verklig workerd/SQLite-kontroll (`free_gate_runtime.test.mjs`). 177/177.

## gmo-v21 – tydlig avgränsning till hantverkaroffert (endast copy; frontend, ingen API-ändring; föregående gmo-v20)
- Rubrik "Granska din hantverkaroffert.", ingress "För bygg, renovering och installation i hemmet. Få hjälp att upptäcka oklarheter, motsägelser och uppgifter som behöver förtydligas.", uppladdning "Släpp din hantverkaroffert här", title/description/OG anpassade. Rad om avgränsning: material som ingår i hantverkarens offert omfattas; materialinköp, produktköp och abonnemang stöds ännu inte.
- Ingen logik-, API-, pris- eller betalningsändring. Mottagare/hantverkare-vägar, gratis och dataskyddstext oförändrade.

## gmo-api-v12 – S3-rättning (slutna ID, fast text) + S4 org-kontroll + kreditstopp i /explain (KANDIDAT 11 – ej släppt, bas 646ff79 (live frontend gmo-v20, alla fem frontendfiler orörda), EN squash-commit)
- **S3-rättning (Codex `S3_RATTNINGAR.md`):** modellen returnerar bara `priority_ids` (1–3, enum ur serverns giltiga åtgärder). Fri intro finns inte längre; varje annat fält i modellsvaret avvisas. ALL synlig text (intro `AI_INTRO`, etikett, åtgärder) är fast servertext, så obelagda påståenden (lösenordsläckage, betalningsanmärkningar, dataläckage) aldrig kan nå kunden. Ordlistevalideringen är borttagen. Cacheposter med gamla fria fält avvisas (`explain-v2`). Codex `explain_acceptance.mjs`: **8/8** (var 5/8), positivt ID-fall fungerar.
- **Turnstile:** används bara om `TURNSTILE_SECRET_KOLLAR` finns; då krävs success + hostname (tillåtna origins) + action `forklaring`. Utan secret ingen påhittad spärr: vägen är serverbegränsad som `/review` (riktig CF-IP, atomisk budget 20 USD/månad, dag 100, IP 5). Inga nya secrets/konton/rotationer.
- Ny `worker/src/org_probe.js`: `GET https://api.anthropic.com/v1/models?limit=1` (metadata, ingen generering, inget betalt anrop) med befintligt `ANTHROPIC_API_KEY`, fast URL, 4 s timeout; läser bara svarshuvudet `anthropic-organization-id` och jämför med krediterad organisation (konstant, kan ersättas av `EXPLAIN_CREDIT_ORG_ID`). Svarskroppen läses aldrig.
- Portar i `/explain` före Turnstile, budget och AI: org stämmer inte / huvud saknas / fel eller timeout → **fast reservväg, inget AI-anrop**. Utgången kredit → samma. Org-ID, nyckel och leverantörssvar visas aldrig.
- Kreditutgång: nya AI-anrop stoppas automatiskt från **2026-10-14 00:00 UTC** (fail-closed). Först ett nytt användarbeslut om budget kan öppna igen genom att sätta `EXPLAIN_CREDIT_UNTIL` (YYYY-MM-DD, första dagen utan kredit). Ogiltigt värde stänger.
- Rate limit/cache: högst en verklig kontroll per nyckel och 10 min (ok) respektive 2 min (misslyckande), isolatminne + delad KV. Cachenyckeln är en hash av hemlighet + förväntad org, så ett byte av hemlighet ger ny nyckel och gammalt resultat återanvänds aldrig.
- `GET /explain/org` returnerar endast `{creditOrgMatches, status, ms, creditExpired}` (`Cache-Control: no-store`). `/review` är **oförändrad** och styrs inte av org-kontrollen.
- Inga nycklar roteras, inga konton/fakturor/krediter berörs. Tester: `worker/test/org_probe.test.mjs`, `explain.test.mjs` omskriven för slutna ID och valfri Turnstile.
- **UNKNOWN/EJ TESTAT:** verklig probe mot Anthropic (inget riktigt anrop gjort), vilken organisation produktionsnyckeln faktiskt tillhör, att `anthropic-organization-id` returneras på `/v1/models` för just den nyckeltypen (dokumenterat i officiell API-översikt, ej provat här).

## gmo-api-v11 – S3 POST /explain bakom flagga AV (KANDIDAT 8 – ej släppt, bas 7bf91df)
- Nytt: `POST /explain` för Ägarkollen/Synlighetskollen. **`EXPLAIN_ENABLED = "0"`**: utan aktivering inga AI-anrop, ingen Turnstile, ingen budgetreservation; svaret är de fasta åtgärdstexterna.
- Indata = fast katalog (`src/explain_catalog.js`): app + kontroll-ID + statusenum; allt annat avvisas (400). Ingen fritext/domän/IP/kontaktuppgift når modellen.
- Modellen väljer och ordnar högst 3 giltiga åtgärds-ID + skriver en kort inledning; servern mappar fasta texter. Validering i kod (ID ur indata, inga statusord, inga siffror/domäner/priser/garantier/ranking/brådska/ägar- eller indexeringspåståenden, ingen ny teknisk term, längd) → annars fast reservväg, aldrig felruta.
- Eget CORS (`EXPLAIN_ALLOWED_ORIGIN`), eget atomärt utgiftstak i `ExplainBudget` (SQLite-DO, migration v2): 20 USD/månad, 100/dygn, 5/IP/dygn, värsta-fall-reservation i µUSD (indatabytes + 1 200 utdatatokens inkl. tänkande), settle mot uppmätt kostnad, fail-closed.
- Händelse `anrop_kostnad` med `app=agarkollen|synlighetskollen`. `/health` visar `explain`-läge.
- **EJ TESTAT:** riktigt AI-anrop (inga betalda anrop gjorda), riktig Turnstile-siteverify, verklig kostnad per förklaring (UNKNOWN), produktionssecret/org-koppling (UNKNOWN).

## gmo-v20 / gmo-api-v10 – exempelbeskedet direkt i bild
- Exempelofferten använder samma reserverade resultatposition som en riktig granskning. Beskedet kommer i bild direkt utan något API-anrop.


## gmo-v19 / gmo-api-v10 – tydligare besked efter granskning
- Ett tydligt färgbesked, verkliga antal och animerade segment med samma underlag som detaljer och export. Okänt visas separat; grön gäller enbart de kontrollerade delarna. Reducerad rörelse stöds.
- Reserverad laddningsyta ersätts på plats; ingen scroll när svaret kommer. Alla fynd och frågor ligger bakom en stängd öppning.
- Beräknade numeriska avvikelser visas i räkningens stapel även när AI-kontrollen inte rapporterat en motsägelse. En sådan kontroll räknas inte samtidigt som grön.
- Växjö borttaget från synlig topp, sidfot och exempel. Företagsuppgifternas adress finns kvar.
- Backend, modell, prisregler och kvoter är oförändrade. AI-prioritering för de andra verktygen ingår i ett separat backendsteg.


## gmo-v16 / gmo-api-v10 – rättning F8e (KANDIDAT 5 – ej släppt)
- **extracted obligatoriskt** (Codex-fynd efter riktig Haiku-körning 5/11): `extracted` ingår nu i verktygsschemats `required`, instruktionen säger att objektet alltid lämnas med alla fält, och `readReview` (Workern + F2) avvisar svar utan giltigt `extracted` som fel (F2: `saknar_extracted`, aldrig PASS). Tidigare blev saknat `extracted` ett tomt objekt (allt null, okänd moms) som såg ut som en lyckad men tom granskning – kan förklara avvikelserna i Haiku-körningen (orsak ej bevisad utan rå tool-input).
- **propertyType-instruktion**: tydlig avbildning bostadsrätt/BRF → bostadsratt, villa/småhus/egnahem → smahus, hyreshus → flerbostadshus (Sonnet 5.5 lämnade F2-07 null trots uttryckligt "bostadsrätt"; verifieras med nytt F2-prov). Facit oförändrat.
- **F2-diagnostik**: avvikande fall visar `diag` (stop_reason, utdatatokens, antal fält i extracted och hur många som inte är null) – ingen offerttext.
- **Modelltabell**: `claude-opus-5-5` ($4/$20) och `claude-fable-5-1` ($10/$50), forcerat verktyg stöds ej (auto), tänkande alltid på, max_tokens 12000. Produktionsmodell oförändrad.
- Tester: Worker 122, UI 14, Codex-prober 24/3/8/2/7/6 PASS.

## gmo-v16 / gmo-api-v10 – rättning F8c (KANDIDAT 4 – ej släppt)
Rättar Codex återtest av c90c370 och 2ff74b1 (RATTNINGAR_F8.md). Inget publicerat, ingen betald AI.
- **Worker-start i workerd**: konstanterna `ANTHROPIC_URL`/`ANTHROPIC_VERSION` och svarsläsningen ligger i egen modul `worker/src/provider.js`; huvudingången exporterar bara funktioner/klasser/handler. Hela produktionsingången (esbuild-paketerad som vid deploy) startas i Miniflare/workerd i `test/entry_runtime.test.mjs`: `/health`, 12 samtidiga granskningar mot globalt tak 3 → exakt 3 betalda anrop (mock), samt stängd betald trafik utan Durable Object.
- **max_tokens/refusal**: `readReview` delas av Workern och F2-runnern. Avkortat eller nekat svar eller saknat `submit_review` är fel i F2, aldrig PASS.
- **Haiku 5.5 nivåpris**: över 100 000 indatatokens gäller 0,50/2,50 USD per MTok för hela anropet. `computeCost` och F2:s reservation (`worstCaseUsd`) räknar med nivån; 150 000 in + 6 000 ut = 0,09 USD och blockeras av budget 0,02 före betalt anrop.
- **T08 Framkörning**: okänt antal besök ger alltid fråga, även när summan ryms i per-besöksspannet (450 kr utan besöksantal). 450 kr/1 besök → OK, 3 600/8 → OK, 12 000/8 → flagga oförändrat.
- Tester: Worker 119, UI 14, Codex-prober (semantic 24/24, travel 3/3, f2 8/8, index 6/6, worker N23/N24, kvot 7/7) PASS lokalt.

## gmo-v16 / gmo-api-v10 – rättning F8b (KANDIDAT 3 – ej släppt)
- **N18 Sammanfattning/UI** (`index.html`): moms, pristyp och betaldatum räknas som formalia och ger aldrig "prisregler kontrollerade och stämmer". Ren formalia visas som "N formaliauppgifter kontrollerade – inga priser bedömda". "Inga frågor genererades – offerten verkar besvara det vi kontrollerar" och motsvarande texter sägs bara när något sakligt bedömts och inget lämnats obedömt; annars ett neutralt besked.
- **P04 Netto utan ROT-belopp** (`amounts.js`): uttrycklig summa att betala utan angivet ROT-belopp ometiketteras inte som "före ROT". Avviker raderna från nettot blir totalen `oklar` (`avdrag_okant`) med två villkorade tolkningar (inget avdrag / avdrag som saknas i avläsningen) och summeringen blir en fråga, inte ett fel.
- Tester: Worker 111, UI 14.

## gmo-v16 / gmo-api-v10 – rättning F8 (GMO-REVISION-20261009-01 D03, KANDIDAT 2 – ej släppt)
Rättar Codex återtest av f8a18a9 (RATTNINGAR_F8.md). Inget publicerat, ingen betald AI.
- **P02/P03 Totalsummor** (`amounts.js`, `rules.js`): när både "före ROT" och "efter ROT" ryms i toleransen mot raderna är totalen `oklar` (tidigare `belagd`). Uttryckligen angivna "före ROT" och "att betala" som motsäger varandra ger felraden `total_konflikt` i stället för att den ena göms.
- **P01 Värmepump**: nytt fält `totalContract` (uttrycklig totalentreprenad). Schablonen blir aldrig "stämmer": villkorat räkneexempel (inkl/exkl moms) och en fråga; "fel" bara när småhus, fast pris och totalentreprenad är uttryckliga och ingen momsbas ger beloppet. Skatteverkets sida anger inte momsbasen (UNKNOWN).
- **Schema**: `totalBeforeRotSek` beskriver bara uttryckligt "före ROT"; ett omärkt "totalt"/"summa" är `totalSumSek`.
- **N19 Export**: räkneanteckningen som syns på skärmen följer med i Kopiera/e-post/SMS för båda roller.
- **N22 Kvot**: globala betalda dagstaket kräver atomär reservation (SQLite-backad Durable Object `QUOTA`, nu bunden i `wrangler.toml` med migration `v1`; ingen molnresurs skapas förrän deploy). Saknas bindningen svarar Workern 503 utan betalt anrop. Trasiga räknare, ogiltig konfiguration och ogiltiga Durable Object-svar nekar. Provad mot riktig lokal workerd (Miniflare): 40 samtidiga mot tak 7 → exakt 7.
- **T07/T08 Framkörning**: summa för flera besök jämförs per besök (nytt fält `travelVisits`); okänt antal besök ger fråga, inte prisfynd.
- **F2-runner** (`scripts/f2_run.mjs`): körbar, med exakta tak (USD och antal anrop), kostnadsreservation före varje anrop via gratis tokenmätning, stopp vid okänd kostnad. Samma begäranbyggare som Workern. Modellpost för `claude-haiku-5-5`.
- **Prisindex** (`worker/scripts/indexing.mjs`, `update_reference.mjs`): band räknas alltid från en versionerad basnivå; samma period två gånger ändrar inget (inte heller med `--force`); okänd basperiod eller ogiltigt index stoppar utan ändring; ny basnivå kräver separat `--rebase` med belägg. Projektband med basis total indexeras inte (50/50-vikten saknade källa). Basperioden för nuvarande band är UNKNOWN, så ingen uppräkning görs. `hourly._method` stämmer nu med den faktiska golvformeln.
- Tester: Worker 110 (inkl. 4 mot riktig workerd, 8 för F2-runnern, 7 för indexering), UI 13.

## gmo-v16 / gmo-api-v10 – 2026-10-09 (GMO-REVISION-20261009-01 D03, KANDIDAT – ej släppt)
Allt nedan är lokalt kodat och testat mot mock. Ingenting är publicerat. Verklig AI-träffsäkerhet, riktig mobil och skärmläsare är EJ TESTAT.
- **B Validering** (`worker/src/sanitize.js`): allt modellen returnerar saneras (enum, typer, tal, datum, listor, gränser, prototypnycklar). Ogiltigt blir tomt, aldrig gissat; ogiltig eller saknad moms blir `okant_moms` och ger en fråga. Ogiltiga fält redovisas som lucka ("Avläsningen"). Ett fel i ett prissteg ger en läsbar delgranskning (`partial`) i stället för ett 5xx.
- **A1/A2 Belopp** (`worker/src/amounts.js`, `rules.js`): nya fält `totalBeforeRotSek`, `amountToPaySek`, `totalVatBasis`, `propertyType`. En gemensam normalisering avgör före/efter ROT och momsbas. "Stämmer" kräver belagd bas; passar flera tolkningar blir det fråga med tolkningarna utskrivna. Känd moms normaliseras oavsett kundtyp. Värmepumpsschablonen kräver fast pris, småhus och belagd summa före ROT. Badrumsspannet gäller bara 4–6 m². Inga nya prisband (`reference.json` 2026-10-09 lägger bara till omfångsvillkor och texter).
- **E Kvot/indata** (`quota.js`, `limits.js`): kvoträknare fail-closed (fel = nej, 503). Valfri atomär Durable Object (`QuotaCounter`, ej aktiverad; planen UNKNOWN). Utan den är dagstaket `kv_best_effort` och INTE ett garanterat hårt tak. Filer kontrolleras (magiska bytes) och tokenmäts med Anthropics gratis tokenräknare före betalt anrop; över `INPUT_TOKEN_LIMIT` (60 000) startas ingen granskning. 8 MB-gränsen kvar.
- **F1 Modell** (`models.js`): en tabell med priser och anropsform per modell. `claude-sonnet-5-5` avvisar forcerat `tool_choice` och `temperature`, så den får `auto` + instruktion + `thinking: between_tools`; 4.5 behåller forcerat verktyg + temperature 0. Okänd modell = okänd kostnad. `wrangler.toml` pekar på 5.5 (4.5 är Deprecated, tentativ avveckling 2026-11-30). `/health` visar `build`, `model`, `referenceVersion`, `quotaMode`. Deploy-skriptet skickar `BUILD_ID` och jämför `/health`.
- **Mätning**: `anrop_kostnad` (modell, kostnadsstatus, tokens, USD) per lyckat anrop; klienthändelserna `klient_rapport_klar`, `klient_export`, `klient_kontakt_cta` via `/event` (fast lista, ingen fritext, test märks separat, kan inte skapa `granskning_klar`).
- **C/D Frontend**: Välj fil/Ta foto är knappar (Tab/Enter/Mellanslag); rollval med `aria-pressed`; synlig fokusram; resultat och fel annonseras (live-regioner, fokus till rubriken); sammanfattningen säger bara "stämmer" när en regel faktiskt kördes; exporten (e-post, SMS, Kopiera) innehåller räknefel, prisfel, prisfrågor och osäkerheter för båda rollerna ur samma resultat, e-post/SMS förkortas tydligt, Kopiera ger allt. Kort datainformation vid uppladdning med länk till hela texten. Metodsidan harmoniserad.
- Tester: Worker 82 (node --test test/*.test.mjs), UI 13 (Playwright/Chromium, `tests/ui`), F2 offline-facit 10 fall.

## gmo-v15 – 2026-09-28 (företagsuppgifter, SD-260928-04)
- "Org.nr 810930-2714" borttaget ur sidfoten på startsidan och metodsidan. Enskild firma har inget org.nr, och numret var Anders personnummer (Moneymans bedömning, e-handelslagen 8 §).
- Ny sida `/foretagsuppgifter/` (noindex, inte i sitemap) med namn, adress, e-post och momsregistreringsnummer. Det är enda stället numret står (Anders beslut A 28/9). Sidfoten länkar dit med "Företagsuppgifter".

## gmo-v14 – 2026-09-25 (tratten)
- Workern `gmo-api-v9` räknar tratten i Analytics Engine `granska_handelser`: `uppladdning_start`, `granskning_fel` (orsak: indata, ursprung, grans, granskning, stangd) och `granskning_klar`. Inga personuppgifter: bara händelse, orsaksgrupp och test/skarp. Granskningen själv är orörd, händelserna läses av på svarets statuskod. Moneyman, MATNING-VERKSTADEN-2026-09-25.
- Testkörningar: lägg `?sd-test=1` på adressen, så skickas headern `X-SD-Test: 1` och körningen räknas som test (index1 = test). Workern släpper igenom headern i CORS.

## gmo-v13 – 2026-09-23 (WebKit-ronden)
- Textrutan "Klistra in offerttexten" har 16 px text i stället för 15 px. iPhone zoomade in sidan när man tryckte i rutan, eftersom Safari zoomar på fält med mindre text än 16 px.
- Alla knappar (Prova med en exempeloffert, Klistra in text, Välj fil, Ta foto, Granska, Kopiera, Skicka) är minst 44 px höga, var 42 px. Lättare att träffa med tummen.

## gmo-v12 – 2026-09-19
- Favicon och hemskärmsikon: Ståhle Digitals ikon v2 (orange ring, inget grönt). RG-014.

## gmo-v11 – 2026-09-19
- Barlow självhostad i `fonts/` (OFL 1.1). Inga anrop till Googles servrar när sidan öppnas (RG-021).

## gmo-v10 – 2026-09-19
- Metodsidan: tabellen som rullar i sidled går att nå med tangentbord (axe: scrollable-region-focusable).

## gmo-v9 – 2026-09-19
- Kontrast (Anders beslut 18/9, RG-003): orange **text** använder mörkare `--acc-text:#b8431f` (5,0:1). Orange knapp och etikett får mörk text i stället för vit (3,2 → 5,7:1). Linjer och ytor behåller #f0643b.

## gmo-v8 / gmo-api-v8 – 2026-09-18 (Rainmans kodgranskning)
- Zoom tillåten igen: `maximum-scale=1` borttagen ur viewport (RG-002, WCAG 1.4.4).
- Fel filformat (t.ex. HEIC som inte konverterats) avvisas **före** kvoterna, så det kostar inte besökaren en av timmens granskningar (RG-012). Nytt test räknar KV-nycklarna.
- Ny första broms: Cloudflares egen räknare per IP (`REVIEW_RL`, 4/minut, atomär). Stoppar samtidiga anrop som kunde smita förbi KV-räknarna (RG-007). KV-gränserna (8/timme/IP, 300/dygn) ligger kvar. Tester 35 → 37.
- Metodsidan märkt gmo-v8 (var gmo-v6, RG-025).

## gmo-v7 – 2026-09-18
- Länken till Materialräknaren pekar på den nya adressen stahledigital.se/verkstaden/materialraknaren.
## gmo-api-v7 – 2026-09-18 (PRISUNDERLAG rev 4)
Moneymans rev 4, godkänd av Anders. Frontend oförändrad (gmo-v6); metodsidans rättelse och versionsmärkning kom i `388463c`.
- **Lönekostnadsraden upprepar inte längre marknadsradens intervall.** Meningen "Det ligger också under det intervall vi ser för {trade} 2026 ({range})." är struken ur `wording.belowFloor`. Texten slutar med "Fråga vad som ingår, om företaget har F-skatt och försäkring." Intervallet står redan i marknadsraden ovanför. Nytt test: ingen mening får stå två gånger i de två raderna, och lönekostnadsraden får inte nämna intervallet.
- **Uppräkningsregeln har blivit en testbar funktion** (`worker/scripts/lon_val.mjs`, sex tester):
  - En SCB-siffra får räknas upp högst ett år, för alla yrken. Tidigare räknades den upp hur många år som helst för yrken utan reserv.
  - Saknar SCB plattsättare (7122), eller är siffran för gammal, räknas det på murare (7112). Raden märks "proxy: murare" både i skriptets utskrift och i källan under lönekostnadsraden.
  - **Fel i `388463c` som nu är lagat:** saknades 7122 helt bland de två år som hämtas, vilket är just 2026-läget, blev golvet oförändrat och reservyrket prövades aldrig.
  - Går inget att använda stoppar skriptet och skriver ingenting.
- Torrkörning mot SCB 18/9: alla fem golv oförändrade. Plattsättare 2024 räknas upp 1 år, eftersom senaste statistikår är 2025.
- Tester 29 → 35 (plus 2 nya påståenden i timpris 350-testet).

## gmo-v6 / gmo-api-v6 – 2026-09-18 (PRISUNDERLAG rev 3)
Moneymans rev 3: referensgolvet var för högt räknat för alla fem yrken – på SCB:s **medellön** delat med debiteringsgraden 0,8. Medellön är ingen golvnivå (hälften tjänar mindre) och 0,8 är ett antagande om hur firman drivs, inte om vad en anställd kostar. Marknadens billigaste fjärdedel låg under det gamla golvet.
- **Nya golv** (kr/h exkl./inkl. moms, före ROT): snickare 304/380, elektriker 248/310, VVS 304/380, målare 288/360, plattsättare 360/450. Banden, taken och marknadsmitten är oförändrade. Ny regel: SCB 10:e percentilen ÷ 174 h × 1,03 × 1,55, inkl. moms nedåt till jämna 10 kr.
- **Kapningen från 2026-09-18 är borttagen.** Den fick meningen att citera SCB för ett tal som kom från bandet, och gav varje pris under bandet texten om lönekostnad. Invarianten golv < bandets undre gräns bevakas nu av ett test som stoppar bygget, och av skriptet som vägrar skriva.
- **Fyra lägen i stället för tre**, och två rader i rapporten: *Marknad* alltid (vad marknaden tar betalt), *Lönekostnad* bara när priset ligger under golvet (om priset ens täcker lönen för en anställd). Nytt läge "under intervallet men över golvet" med egen text: lågt pris, fråga vad som ingår.
- **Låst ordval ändrat** (Anders ja 2026-09-18): under-golv-texten säger nu "även med en lön bland de lägsta tio procenten i yrket" i stället för "normalt".
- **Bugg hittad och lagad i samma pass:** textmallarna fylldes med `String.replace` och en strängnyckel, som bara byter ut första förekomsten. Nya under-golv-texten innehåller `{trade}` två gånger, så andra blev kvar som `{trade}` i klartext. Nu global ersättning, plus ett test som underkänner alla texter där en platshållare läckt ut.
- **`update_reference.mjs`** hämtar 10:e percentilen (ContentsCode 000007CF), räknar utan debiteringsgrad och räknar upp ett steg per år som saknas när SCB sekretessprickar ett yrke. Torrkörning 18/9 återskapar alla fem golv exakt ur SCB:s API – en oberoende kontroll av Moneymans tabell.
- Metodsidan: nytt avsnitt "Två frågor, inte en" som skiljer intervallet (marknad) från golvet (lönekostnad), golvet beskrivet per arbetad timme, fyra lägen, nya siffror i tabellen, version 2026-09-18.
- Tester 26 → 29.

## gmo-v5 / gmo-api-v5 – 2026-09-18
Säkerhets- och robusthetsrond efter kodgranskningen (`Claude outputs/donatello/KODGRANSKNING_2026-09-18.md`).
- **`/review` kräver nu godkänd origin** (403 annars). `/event` hade kontrollen, den dyra vägen hade den inte – och workers.dev-adressen står i klartext i sidan. Test finns som fångar det om det tas bort igen.
- **Offerten behandlas som data, inte instruktioner.** Inklistrad text läggs i `<offert>…</offert>` och systemprompten säger uttryckligen att text i dokumentet aldrig får styra bedömningen; sådana försök nämns i contradictions.
- **Avkortade modellsvar avvisas** (`stop_reason: max_tokens`) i stället för att prisreglerna räknar vidare på halva fält. Takhöjden 2000 → 4000 tokens.
- **Tidsgränser:** 90 s mot modellen i workern, 120 s i sidan, med ett begripligt fel i stället för evig väntan.
- **Bildformat kontrolleras före modellanropet.** HEIC från iPhone gav tidigare ett obegripligt fel efter att besökarens kvot redan förbrukats. Sidan ritar dessutom om bilder till JPEG, max 1800 px längsta sida – HEIC blir läsbar och uppladdningen snabbare på mobil.
- **KV kan inte längre släcka tjänsten.** Alla läsningar och skrivningar är inpackade; en full eller trasig KV ger sämre statistik, inte 500. `/health` cachar räknarna 60 sekunder i stället för 13 KV-läsningar per anrop.
- **Persondata:** filnamnet sparas inte längre i felsökningsposten (bara filändelsen), `county` i prisstatistiken valideras mot Sveriges 21 län i stället för fritext, och statistikposterna har utgångsdatum (24 mån) i stället för att ligga kvar för alltid.
- **Ordspärren** använder samma mönster för att söka och tvätta (tidigare hittades "svartmålad" men tvättades inte, och "överprissatt" blev obegriplig svenska), och svaret kontrolleras en gång till efter tvätten – hittas något då skickas 502 i stället.
- **Prisregler:** okänt momsläge ger nu **fråga** i stället för "stämmer inte" på ROT-beloppet och på summeringen – skillnaden är 25 %, alltså större än toleransen. Referensgolvet kapas till bandets undre gräns när underlaget säger emot sig självt (snickare, målare och plattsättare hade golv över bandet, vilket fick timpris *inom* det intervall vi publicerar att beskrivas som under vad en anställd kostar). Underlaget rättas av Moneyman; koden kan inte längre ge motsägelsen.
- Tester: 18 → 26, alla gröna. Nya fall: origin-kontrollen, okänt bildformat, KV som kastar, län-normalisering, golvkapningen för alla yrken och båda momslägen, ordspärren efter tvätt, okänt momsläge på ROT.

## gmo-api-v4.1 – 2026-09-17 (efter fem skarpa testofferter)
- ROT 50 % med offertdatum 2025 men utan betaldatum ger nu "fråga" (betalningsdatum styr), inte "ok". Extraktionen får instruktion att tolka "faktureras i februari 2026" som 2026-02-01.

## gmo-v4 / gmo-api-v4 – 2026-09-17 (prislager, PRISUNDERLAG rev 2)
Backend (`worker/`):
- `src/reference.json` version 2026-09: timprisband per yrke (golv/normalband/tak, inkl. och exkl. moms), projektband, ROT-regler 2026, Skatteverkets undantagslista, värmepumpsschablon, arbetsgivaravgift, normala tillägg, låst ordval. Källa, URL, datum och V/U/E per post. Siffror från Moneymans PRISUNDERLAG/KALLREGISTER, inga egna.
- `src/rules.js`: regelkontroller a–i som deterministisk kod (ROT 30 % ±2 %, ROT på material/resor, 50 % med betalning 2026 + Skatteverket-citat, tak 50 000/person, undantag, värmepump, moms, timmar×timpris, summering, pristyp/15 %, fast pris utan uppdelning), normala tillägg (flaggas inte), jämförelse mot banden med låst ordval, hård strängkontroll (`findForbidden`/`scrubForbidden`) mot "för dyrt", "överpris", "svart", "oseriöst", "fusk".
- Extraktion: nytt `extracted`-objekt i verktygsschemat (jobbtyp, yrken, timpris, timmar, arbete, material, resor, övrigt, påslag, ROT-belopp/-sats/-personer, pristyp, momsläge, total, datum, betaldatum, kundtyp, yta, antal). Saknas i offerten = null, aldrig gissat.
- `priceReport` i svaret: Kontrollerat / Jämfört / Går inte att bedöma + friskrivning + referensversion + länk till metodsidan.
- Prisstatistik (lager 3) sparas bara när `stats:true` skickas (kryssruta, förvald AV): jobbtyp, län, summaband, timprisband, arbetsandel, ROT ja/nej, fallna kontroller, datum. Räknare `count:pstat`.
- `scripts/update_reference.mjs`: årlig uppdatering via SCB:s API (LoneSpridSektYrk4AN + FPIBOM2015), torrkörning som standard, `--write` skriver. Tester: `test/rules.test.mjs` (fem testofferter + ordfilter) och `test/index.test.mjs`.
Frontend:
- Sektionen "Prisbild" i resultatet med tre delar och källa per rad; sammanfattningen räknar prisregler/prisfrågor; urklippet får ett "Om priset"-avsnitt.
- Kryssruta "Bidra anonymt till prisstatistik" (förvald av) före Granska-knappen; nytt stycke i "Om tjänsten och dina uppgifter".
- Ny sida `/sa-granskar-vi-priser/` (källhierarki, intervall, vad de inte är, statistik, uppdatering, versionsdatum). Sitemap uppdaterad.

## gmo-v3 / gmo-api-v3 – 2026-09-17 (kampanjkrav)
Backend (`worker/src/index.js`):
- Globalt dagstak standard 150 → 300 granskningar/dygn (`GLOBAL_DAILY_LIMIT`, även i wrangler.toml).
- Räknare per väg (`count:path:*`) och per delningskanal (`count:share:email|sms|copy`), totalt och per dag. Allt läsbart utan kod i `/health` (`byPath`, `shares`, `dailyLimit`).
- Ny `POST /event` (`{type:"share",channel}`) – bara från vår origin, svarar alltid 204, räknar bara kanal. Ingen IP, inget innehåll.
Frontend (`index.html`):
- Klick på "Skicka via e-post", "Skicka som SMS" och "Kopiera" skickas som beacon till `/event`. Exempeloffert räknas inte.
- UTM-parametrar rörs inte av sidan (ingen URL-omskrivning) – kontrollerat.
Drift: `DEPLOY_GRANSKAMINOFFERT_WORKER.command` (dubbelklick på Macen) publicerar workern med wrangler; fyller i KV-id automatiskt.

## gmo-v2 / gmo-api-v2 – 2026-09-16
Frontend (`index.html`):
- Rad under vägvalskorten som byts med vald väg (mottagare/hantverkare). Ny undertext på hantverkarkortet.
- Efter resultatet på hantverkarvägen: ruta "Från Ståhle Digital" (hemsidor för hantverkare, knapp "Se vad vi gör") och länk till Materialräknaren. Bara hantverkarvägen.
- Sidfot: org.nr och hej@stahledigital.se.
- Byte av väg medan ett resultat visas ritar om resultatet. Vald väg skickas med i anropet (`path`), endast för statistik.
Backend (`worker/src/index.js`):
- `/health` visar `reviewsToday`, `reviewsTotal` och `version`.
- Anonym statistikpost per lyckad granskning (trade, calcCoverage, antal motsägelser, antal att förtydliga, summaband, väg). Ingen IP, inget filnamn, ingen fritext, ingen offert. Ingen TTL.
- `X-Content-Type-Options: nosniff`. Tester i `worker/test/`.

## gmo-v1 – 2026-09-14 … 2026-09-16
Se `git log`: produktionsfrontend + Worker (9f18518), säkerhetsfynd åtgärdade (7a995e3), Tydlighet v1 (a30e138), analytics och integritetstext (1c71653), frågor först och skicka via e-post/SMS (f8712df).
