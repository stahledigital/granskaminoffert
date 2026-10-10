# D12 – kostnadsskydd för gratisversionen (gmo-api-v13, KANDIDAT – deploy ej gjord)

Branch `d12-free`, bas = tree av livebacbb6a (worker) med frontend orörd (canonical b04e90ab/gmo-v21). Inga jämförelse-, betal-, Google-, Stripe- eller mejlrutter.

## Vad som ändras
- `src/free_budget.js` (NY): `FreeBudget` (SQLite Durable Object, enda skrivare) + klient (`freeGateStatus/Reserve/Settle/Unknown/Release`, `pilotConfig`, `worstMicroFor`). Enda import: `./models.js`.
- `src/index.js`: `export { FreeBudget }`; `/review`: tidig statuskoll (stängd ⇒ 503 före tokenmätning/kvot), tokenmätning av ALLA anrop (även text), reservation av värsta fallet före dagsräknaren och före anropet, avräkning mot uppmätt kostnad, release vid HTTP-fel och vid nekad dagsräknare, halt vid okänd användning; `/health` visar `freeGate:{open,state}` (aldrig belopp/mandat). Okänd modell ⇒ ingen generation (503). Version `gmo-api-v13`.
- `src/explain.js`: samma gemensamma pott före ExplainBudget (AV som standard, EXPLAIN_ENABLED=0 oförändrat).
- `wrangler.toml`: binding `FREE_BUDGET` → `FreeBudget`, migration `v3` (`new_sqlite_classes = ["FreeBudget"]`), `FREE_PILOT_ENABLED = "0"`. Inga andra värden i repo.
- OBS migrationstaggar: betalkandidaten (d04) har sin kommenterade migration som `v3` – den måste numreras om till `v4` (efter denna) om båda någonsin släpps.

## Semantik (fail closed)
- ÄNDLIG pilot [FROM, UNTIL): ett TOTALT tak i µUSD, ingen ny pott vid månadsskifte/kalenderomslag. Före FROM, från UNTIL (exklusivt), saknad/ogiltig konfiguration, saknad bindning, lagringsfel/korrupt räknare, halt eller slut på taket ⇒ ingen gratisgeneration.
- Pott = pilot-id (en DO-instans `pilot:<id>`). Samma id: tak/slut kan bara SÄNKAS av konfigurationen (höjning/förlängning/ändrad start ⇒ `konfig_hojd`). Ny pott kräver nytt id + `FREE_PILOT_MANDATE` (spåras i instansen). Ingen reset-/påfyllnings-/avblockeringsrutt finns.
- Halt (okänd användning: nät-/tidsfel, saknat usage; överskridning mot reservationen; över tak) hävs inte automatiskt; kräver nytt pilot-id med nytt mänskligt mandat.
- Befintliga 300/dag (`GLOBAL_DAILY_LIMIT`), IP-/KV-gränser, REVIEW_RL, filsniff och 60 000-tokensgräns består.

## Godkänd pilot (Anders 2026-10-10T23:36:49+02:00, ur PILOT_SPEC)
Operatören sätter vid aktivering (inget av detta ligger i repot):
```
FREE_PILOT_ENABLED   = "1"
FREE_PILOT_ID        = "gmo-pilot-2026-10"            (eller annat unikt id)
FREE_PILOT_CAP_MICRO = "20000000"                       (20 USD TOTALT, inkl. kredit)
FREE_PILOT_FROM      = "<verklig aktiveringstid, ISO med tidszon>"   (t.ex. 2026-10-11T08:00:00+02:00)
FREE_PILOT_UNTIL     = "2026-11-01T00:00:00+01:00"      (exklusivt; 31 okt är CET)
FREE_PILOT_MANDATE   = "ANDERS-2026-10-10T23:36:49+02:00 kor-pa-det"   (referens, inga hemligheter)
```
Sätts med `wrangler deploy --var NAMN:värde` (eller dashboard) – aldrig som secrets. FROM får inte ligga längre fram än UNTIL−92 dygn.

## Importer / bindningar / migration (exakt)
Nya/ändrade moduler: `free_budget.js` (ny, importerar `models.js`), `index.js` (importerar `free_budget.js`), `explain.js` (importerar `free_budget.js`). Nytt DO-klassnamn `FreeBudget` exporteras från `src/index.js`. Bindning `FREE_BUDGET`; migration `v3` skapar klassen vid `wrangler deploy` (ingen resurs skapas före deploy). Inga nya secrets, KV, queues, domäner eller konton.

## Operatörssteg (root, separat release-GO redan givet för gratisbasen)
1. Verifiera diff mot bacbb6a (endast worker/src/{free_budget,index,explain}.js, wrangler.toml, tester, dokument, CHANGELOG).
2. `node --test worker/test/*.test.mjs` (MINIFLARE_DIR satt) ⇒ alla gröna; `wrangler deploy --dry-run` mot tom konfig.
3. Deploy med `--var` enligt ovan (FROM = faktisk tid). Direkt efter: `GET /health` ⇒ `freeGate.state:"aktiv"`, `build` = commit.
4. Kontrollera att tjänsten svarar normalt med EN verklig granskning (root), läs DO-status via /health (state), logga starttid/counter.
5. Närhelst: `FREE_PILOT_ENABLED=0` (eller tom konfig) ⇒ all gratisgenerering stängs direkt.

## Rollback
- Snabb stopp utan kodbyte: sätt `FREE_PILOT_ENABLED="0"` ⇒ 503 på /review och reservväg i /explain.
- Full rollback: deploya föregående worker (bacbb6a / gmo-api-v12). Den nya DO-klassen lämnas kvar orörd (migration v3 ska inte raderas); gammal kod ignorerar `FREE_BUDGET` men saknar då USD-skyddet – gör bara detta med medveten acceptans.
- Pott och förbrukning ligger kvar i DO `pilot:<id>`; ett nytt id startar ny pott och kräver nytt mänskligt mandat.

## Kända gränser (UNKNOWN/EJ TESTAT)
- Riktig workerd-körning i produktion, riktig count_tokens/usage-form och Anthropics faktiska fakturering är inte verifierade (inga riktiga anrop). Reservation = värsta fall (uppmätta tokens + 1000 marginal + `max_tokens`), vilket överskattar normalt; verklig kostnad avräknas.
- En enda okänd användning (t.ex. timeout) sätter halt för hela piloten – avsiktligt konservativt; hävs bara via nytt pilot-id + mandat.
- Providerorg/kreditgiltighet och driftpolicy verifieras av root (inte kod).
