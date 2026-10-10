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
`MINIFLARE_DIR=… node --test worker/test/*.test.mjs` (197) och `tests/ui/*.test.mjs` (32, varav 5 nya Jämför-flöden i Chromium 390/1280). `worker/test/compare_runtime.test.mjs` kör den riktiga paketerade ingången med riktiga SQLite-DO och alarm i lokal workerd. Dev-harness: `worker/dev/compare_harness.mjs` (modell- och Stripe-attrapper, signerad testwebhook). **In-memory/lokal workerd är inget bevis för produktionsbeständighet.**

## Datakort (omdömen) – avstängda
`src/datacard.js` normaliserar per källa: totalbetyg + antal skilt från de senaste originalomdömena (högst 5, endast om källan själv levererat dem nyast först; annars visas inga “senaste”). Fyra olika lägen: ej aktiverad, bekräfta företag/oklar identitet, fel, noll omdömen. Få omdömen märks. Inga egna betyg, ingen AI-syntes, ingen trend, ingen export, omdömestext går aldrig till modell eller PDF. Ingen leverantörsadapter är byggd. Kärnan fungerar utan datakort; rapporten visar “Visas inte i den här versionen”.

## Återstående externa steg före skarp drift (EJ gjorda)
1. Rätt krediterad Anthropic-organisation och nästa grant bekräftas; Anders sätter **hårda USD-tak** (variablerna ovan) – inget tak finns som standard.
2. Verklig åtkomst, kostnad och villkor för Google (UI Kit/Places) respektive Trustpilot Data Solutions innan datakort aktiveras (separata spår).
3. Konsumenträttslig klassificering (omedelbar leverans/ångerrätt), köp-/återbetalnings-/integritetstexter (`jamfor/villkor/` är ett markerat UTKAST), kontaktväg för support.
4. Secrets i Cloudflare, bindningar och migration `v3` (`wrangler deploy` – separat release-GO), beständig order-/kölagring bevisad i riktig Worker, Stripe-konto: test → live, webhook-endpoint, moms och kvitto, utbetalningsplan och första avstämda utbetalning.
5. Riktig modellkörning (F2-liknande facit för jämförelsen med Sonnet 5.5), riktig mobil/VoiceOver (EJ TESTAT), oberoende QA och rollback.
