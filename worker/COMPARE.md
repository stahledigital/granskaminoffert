# Jämför mina offerter – teknisk beskrivning (D04, KANDIDAT – AV, ej släppt)

WORK-ID GMO-LANSERING-20261010-01, D04. Lokal kandidat byggd av Donatello. **Allt är avstängt**: utan `COMPARE_ENABLED="1"`, betalningsläge, människokonfigurerade kostnadstak och returadress svarar `/compare/*` 503 och inget modell- eller betalanrop kan ske. `/review` är oförändrad.

## Produkt (serverägd)
- 49 kr inklusive moms (4900 öre SEK), engångsköp, 2–4 offerter. Pris och produkt står i `src/compare_config.js` (`OFFER`), aldrig som indata från webbläsaren. Momsdelen (9,80 kr) är ett kalkylantagande (25 %), verklig momsbehandling/kvitto är kommersiellt spår.
- Kundflöde: `jamfor/index.html` – 2–4 filer → kontroll (gratis) → erbjudande 49 kr → hostad Stripe Checkout → verifierad betalning → leverans/återhämtning/kvitto. Den gratis enoffertsgranskningen (`/review`) är orörd.

## Arkitektur
| Del | Fil | Ansvar |
|---|---|---|
| Rutter | `src/compare_routes.js` | `/compare/config`, `POST /compare/orders`, `PUT …/docs/:idx`, `POST …/checkout`, `GET …/` (status + serveravstämning), `GET …/report`, `DELETE …/`, `POST /compare/webhook` |
| Order | `src/compare_orders.js` (DO `CompareOrders`) | tillståndsmaskin, atomisk arbetsclaim med lease (5 min), alarmdriven pipeline, retry/failed, återbetalningsstatus, rensning |
| Budget | `src/compare_budget.js` (DO `CompareBudget`) | atomisk kostnadsreservation i µUSD före varje generation, gemensamt tak + deltak + ordertak, settle mot uppmätt användning, stopp vid oklar användning, dygnsräknare för nya ordrar |
| Betalning | `src/compare_stripe.js` | Checkout-session (REST, ingen SDK), signerad webhook (HMAC-SHA256, 300 s tolerans), `evaluatePaidSession` (order, belopp, valuta, session, status, livemode), återbetalning |
| Avläsning | `src/compare_extract.js` | ett verktyg `submit_offer`: strukturerade fält + stängd lista om 18 omfattningsposter (ingår / ingår inte / framgår inte, med hänvisning). Allt som kommer ur modellen sanerar och “uttryckligt” utan belägg nedgraderas till “framgår inte” |
| Jämförelse | `src/compare_engine.js` | ren kod: samma-jobb-kontroll, momsnormalisering bara vid uttrycklig bas, summakontroll, omfattningsmatris, skillnader, frågor per offert, rangordning bara när allt är jämförbart (annars listas blockerare) |
| Rapport | `src/compare_report.js` | högst ett begränsat ordningssteg (modellen ordnar slutna ID, ingen offerttext/belopp), rapport, kvitto, förbehåll |
| Pipeline | `src/compare_run.js` | reservation → anrop → avräkning per steg; återanvändning av avläsning bara vid samma filhash + modell + promptversion (inom samma order/kund) |
| Datakort | `src/datacard.js` | OFFLINE-normalisering för omdömeskort, avstängd (se nedan) |

Högst en avläsning per offert plus ett begränsat ordningssteg. Omförsök: högst ett per steg och bara om budgeten räcker (reservationen nekas annars). Okänd användning (tidsgräns, saknad `usage`) behåller värsta fallet och **stoppar nya generationer** tills en människa nollar stoppet.

## Order och betalning
Tillstånd: `draft → ready → awaiting_payment → paid → running → delivered | failed`, samt `expired`/`deleted`. Returadressen (`success_url`) är inget betalbevis. Betalbevis = signerad webhook **eller** serveravstämning mot Stripe (status pollas från kundens sida, begränsad). Båda går genom samma kontroll. Dubbletter/omspelning/ur ordning ger ingen ny generation eller leverans (händelse-ID + status). Dubbelklick på “Betala” ger en session (idempotensnyckel + första-vinner). Rådata raderas när ordern avslutas (levererad/misslyckad) och har 24 h TTL i KV.
Misslyckad leverans → status `failed`, återbetalning `needed` (manuellt läge, standard) eller automatiskt via Stripe när `COMPARE_AUTO_REFUND="1"` (ej provat mot riktiga Stripe).

## Konfiguration (alla människosatta; inga standardvärden för pengar)
Secrets: `STRIPE_SECRET_KEY` (sk_/rk_ test eller live), `STRIPE_WEBHOOK_SECRET` (whsec_), `ANTHROPIC_API_KEY` (finns redan).
Vars: `COMPARE_ENABLED="1"`, `COMPARE_PAYMENTS="test"|"live"` (nyckelprefix måste stämma), `COMPARE_RETURN_URL` (https, ingen query; origin måste finnas i `ALLOWED_ORIGIN`), **hårda tak i µUSD**: `COMPARE_MONTH_CAP_MICRO` (gemensamt), `COMPARE_PAID_CAP_MICRO` (betald jämförelse, ≤ gemensamt), `COMPARE_ORDER_CAP_MICRO` (per order), `COMPARE_DAY_ORDERS` (nya ordrar/dygn), valfritt `COMPARE_FREE_CAP_MICRO`, `COMPARE_AUTO_REFUND`, `COMPARE_DATACARDS`+`COMPARE_DATACARDS_VERIFIED` (båda krävs; ingen leverantörsadapter finns).
Bindningar (kommenterade i `wrangler.toml`, **ej aktiverade**, ingen resurs skapad): `COMPARE_ORDERS` (DO `CompareOrders`), `COMPARE_BUDGET` (DO `CompareBudget`), migration `v3`. Valfritt `COMPARE_RL` (rate limit).

## Test
`MINIFLARE_DIR=… node --test worker/test/*.test.mjs` (231) och `tests/ui/*.test.mjs` (33, varav 6 Jämför-flöden i Chromium 390/1280). `worker/test/compare_runtime.test.mjs` kör den riktiga paketerade ingången med riktiga SQLite-DO och alarm i lokal workerd. Dev-harness: `worker/dev/compare_harness.mjs` (modell- och Stripe-attrapper, signerad testwebhook). **In-memory/lokal workerd är inget bevis för produktionsbeständighet.**

## Rättningsrunda root-QA 2026-10-10 (punkt 1–8)
1. **Gemensam kostnadsgate** (`src/cost_gate.js`), AV som standard (`COST_GATE` ≠ `"1"` ⇒ livebeteende oförändrat). PÅ: `/review` och `/explain` reserverar värsta fallet i samma atomära `CompareBudget` (scope `free`) mot gemensamt tak `COMPARE_MONTH_CAP_MICRO` och eget `COMPARE_FREE_CAP_MICRO` (båda människosatta, inga standardsummor). Saknat/ogiltigt tak, saknad bindning, uttömt tak, halt (oklar användning) ⇒ **inget anrop**. HTTP-fel frigör, nätverks-/tidsfel behåller värsta fallet och stoppar alla nya generationer (fri + betald).
2. **Uttömda försök:** alarm med `attempts ≥ 3` och ingen lease ⇒ atomiskt `failed` (`for_manga_forsok`), återbetalning enligt läge, rådata rensad, ingen generation.
3. **Oföränderliga dokumentnycklar** `cmpdoc:<order>:<idx>:<sha256[0..40]>`; ordern (DO `/doc`) är ensam manifest. En sen PUT kan aldrig skriva över en låst fil, och raderar bara sin egen nya nyckel (aldrig `keep`). Ersatt version raderas först efter lyckad commit.
4. **Återbetalning:** bara Stripe `succeeded` ⇒ `done`. `pending`, `requires_action`, `failed`/`canceled`, saknat id ⇒ `pending`/`action_required`/`failed`/`needed`. Avstämning via statusläsning (`GET /refunds/<id>`) och signerad webhook (`refund.updated`, `refund.failed`, `charge.refund.updated`); refund-id måste matcha ordern; `done` är slutgiltig.
5. **Checkout per försök:** idempotensnyckel `checkout:<order>:<försök>`, utgångstid fryst i orderns intent. Samma försök ⇒ exakt samma parametrar (Stripes parametermatch); nytt försök först när sessionen verkligen gått ut eller fönstret är för kort. Attrappen nekar samma nyckel med andra parametrar.
6. **Samtycke bundet till version + hash** av servertexter, pris och produkt (`consentSnapshot`). Ordern lagrar version, hash, tid, pris och antal offerter. Texterna är **UTKAST** (`CONSENT.draft`): live-betalning är avstängd tills slutlig text finns. “Betala igen” utan body återanvänder bara samtycke med samma hash; annars visar sidan texterna igen och kräver nya kryss.
7. **Datatäckning:** erbjudandet och steg 1 säger före köp att omdömen om företagen inte ingår; rapport/annons får inte lova senaste omdömen. Licens/åtkomst/kostnad för datakort är fortsatt UNKNOWN; ingen scraping eller extern effekt.
8. **Jämförbarhet:** uttryckligt olika yta (> 2 % avrundning, tidigare 25 %) och *alla* uttryckliga omfattningsskillnader (grupp omfattning, inte bara fem kärnposter) stoppar rangordning; belopp visas med uppmaning att klarlägga omfattningen, ingen “billigast”. Villkorsskillnader visas separat och stoppar inte.
9. **Asymmetrisk omfattningsoklarhet (root-QA punkt 9):** "framgår inte" i en offert men angivet i en annan, i *valfri* omfattningspost (inte bara kärnposter), stoppar rangordning ("okänt betyder inte att det saknas" – men omfattningen måste klarläggas). Beloppen visas, ingen billigast. Villkorsposter (t.ex. garanti) blockerar inte; "framgår inte" i alla offerter utanför kärnan blockerar inte.
10. **Gaten mäter alltid (root-QA punkt 10):** med `COST_GATE="1"` mäts även `/review`-text med `count_tokens` (ingen teckenheuristik); kan det inte mätas ⇒ 503, inget anrop. Reservationen är värsta fallet för uppmätt indata + max utdata; överstiger den taket nekas anropet före generation. Betald jämförelse mäter all text/fil likadant (fail closed) och synth-steget använder en övre gräns i bytes (hoppar över om taket överskrids, klampar aldrig). `CompareBudget.settle` halterar nu även vid **känd** överskridning av reservationen (som vid okänd användning) för alla fortsatta generationer. `/explain`: indata är en sluten katalog och reserveras i bytes (≥ tokens); överskridning halterar via samma settle.

## Datakort (omdömen) – avstängda
`src/datacard.js` normaliserar per källa: totalbetyg + antal skilt från de senaste originalomdömena (högst 5, endast om källan själv levererat dem nyast först; annars visas inga “senaste”). Fyra olika lägen: ej aktiverad, bekräfta företag/oklar identitet, fel, noll omdömen. Få omdömen märks. Inga egna betyg, ingen AI-syntes, ingen trend, ingen export, omdömestext går aldrig till modell eller PDF. Ingen leverantörsadapter är byggd. Kärnan fungerar utan datakort; rapporten visar “Visas inte i den här versionen”.

## Återstående externa steg före skarp drift (EJ gjorda)
1. Rätt krediterad Anthropic-organisation och nästa grant bekräftas; Anders sätter **hårda USD-tak** (variablerna ovan) – inget tak finns som standard.
2. Verklig åtkomst, kostnad och villkor för Google (UI Kit/Places) respektive Trustpilot Data Solutions innan datakort aktiveras (separata spår).
3. Konsumenträttslig klassificering (omedelbar leverans/ångerrätt), köp-/återbetalnings-/integritetstexter (`jamfor/villkor/` är ett markerat UTKAST), kontaktväg för support.
4. Secrets i Cloudflare, bindningar och migration `v3` (`wrangler deploy` – separat release-GO), beständig order-/kölagring bevisad i riktig Worker, Stripe-konto: test → live, webhook-endpoint, moms och kvitto, utbetalningsplan och första avstämda utbetalning.
5. Riktig modellkörning (F2-liknande facit för jämförelsen med Sonnet 5.5), riktig mobil/VoiceOver (EJ TESTAT), oberoende QA och rollback.
