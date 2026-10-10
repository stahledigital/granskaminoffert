# Granska min offert – ändringslogg

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
