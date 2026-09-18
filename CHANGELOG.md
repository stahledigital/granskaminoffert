# Granska min offert – ändringslogg

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
