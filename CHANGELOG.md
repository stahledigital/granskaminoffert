# Granska min offert – ändringslogg

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
