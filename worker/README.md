# Granska min offert — backend (Cloudflare Worker `granskaminoffert-api`)

Live: `https://granskaminoffert-api.anders-316.workers.dev` (kontots gratis workers.dev, ingen egen domän, ingen DNS).
Deployad och E2E-verifierad 2026-09-14. Version i koden: `WORKER_VERSION` (`/health` visar den).

## Vad den gör
- `GET /health` → `{"ok":true,"hasApiKey":true,"reviewsToday":n,"reviewsTotal":n,"version":"gmo-api-vN"}`.
  Kostar inget. `reviewsToday`/`reviewsTotal` räknar lyckade granskningar (UTC-dygn).
- `POST /review` → tar `{kind:"text"|"image"|"pdf", text|dataBase64, mediaType, filename, path}` och svarar med det
  strukturerade granskningsresultatet plus `meta` (modell, latens, kostnad i USD och grov SEK).
  `path` är vald väg i frontend (`mottagare`/`hantverkare`) och används bara för statistik.
- `OPTIONS` besvaras för CORS. Allt annat → 404.

## Skydd
- CORS låst till `ALLOWED_ORIGIN` (kommaseparerad lista tillåten). Observera: CORS stoppar andra webbplatser, inte curl.
- Rate limit `RATE_LIMIT_PER_HOUR` per IP (KV, TTL 1 h) och globalt dagstak `GLOBAL_DAILY_LIMIT` (standard 150).
  Räknarna är läs-öka-skriv i KV och inte atomära; taket är ett kostnadsskydd, inte en exakt spärr.
- Max text 20 000 tecken, max fil `MAX_UPLOAD_BYTES` (8 MB). Svar: `Cache-Control: no-store`, `X-Robots-Tag: noindex`, `X-Content-Type-Options: nosniff`.

## Lagring i KV `REVIEWS_KV`
| Nyckel | Innehåll | TTL |
|---|---|---|
| `rl:<ip>:<timme>` | räknare för rate limit | 1 h |
| `global:<dag>` | räknare för dagstaket (alla försök) | 48 h |
| `debug:<uuid>` | felsökningspost: tid, IP, kind, filnamn, modell, latens, usage, kostnad, AI-svaret (vid fel: felet). Ingen offert. | 24 h (Anders beslut 2026-09-14) |
| `count:total`, `count:day:<dag>` | antal lyckade granskningar | ingen |
| `stat:<tid>:<uuid>` | anonym statistikpost: `ts, trade, calcCoverage, contradictions (antal), clarify (antal), sumBand (<25k / 25-100k / 100-300k / >300k / okand), path`. Ingen IP, inget filnamn, ingen fritext, ingen offert. (Moneyman/Anders beslut 2026-09-16) | ingen |

## Vars (wrangler.toml `[vars]`) och secrets
`ALLOWED_ORIGIN`, `ANTHROPIC_MODEL`, `MAX_UPLOAD_BYTES`, `RATE_LIMIT_PER_HOUR`, valfritt `GLOBAL_DAILY_LIMIT`.
Secret: `ANTHROPIC_API_KEY` — sätts av Anders i Cloudflare (dashboard eller `wrangler secret put`). Aldrig i repo eller chatt.
KV-id:t i `wrangler.toml` fylls i av deploy-skriptet första gången (platshållare i repot tills dess).

## Deploy
Nuvarande väg (2026-09-17): dubbelklicka `DEPLOY_GRANSKAMINOFFERT_WORKER.command` i repo-roten (kör `npx wrangler deploy`, fyller i KV-id i wrangler.toml första gången, visar `/health`). Reservväg: klistra in `src/index.js` i Cloudflare → Workers & Pages → granskaminoffert-api → Edit code (Quick Edit) → Deploy.
Den som levererar koden ska ange md5 för `src/index.js` så att rätt version klistras in:
```
md5 worker/src/index.js          # på Macen
```
Alternativ med CLI, från `worker/`: `npx wrangler deploy` (kräver inloggning och ifyllt KV-id i wrangler.toml).

Verifiera efter deploy, utan kostnad:
```
curl https://granskaminoffert-api.anders-316.workers.dev/health
```
`version` ska visa den nya `WORKER_VERSION`.

## Test
```
node --test worker/test/index.test.mjs
```
Kör utan nätverk och utan nyckel: summaband, vägnormalisering, /health, CORS, 400 på tom förfrågan, och en mockad lyckad
granskning som kontrollerar att räknarna ökar och att statistikposten inte innehåller IP, filnamn, namn, adress eller belopp.

## Kostnad
Workers och KV på gratisnivå. Anthropic-anropen kostar per användning: `meta.costUsd` i varje svar är den mätta siffran
(prislista per modell i `MODEL_PRICING_USD_PER_MTOK` — uppdatera vid modellbyte). Modellbyte görs bara med mätning före/efter.

## Prislager (gmo-api-v4, 2026-09-17)
- `src/reference.json`: referensdata version 2026-09. Ändras bara via Moneymans PRISUNDERLAG eller `scripts/update_reference.mjs` (SCB). Varje band har källa, datum och V/U/E.
- `src/rules.js`: `runRules` (regler a–i), `checkNormalAddons`, `compareToBands` (låst ordval ur reference.json), `findForbidden`/`scrubForbidden` (orden "för dyrt", "överpris", "svart", "oseriöst", "fusk" får aldrig lämna workern – testet `test/rules.test.mjs` kontrollerar alla regeltexter och referensdata).
- Svaret får `priceReport` = `{ referenceVersion, checked[], compared[], cannotAssess[], disclaimer, methodUrl }`.
- Prisstatistik (`pstat:*` i KV) sparas bara när anropet har `stats: true` (kryssruta, förvald av). Innehåll: jobbtyp, län, summaband, timprisband, arbetsandel (avrundad 10 %), ROT ja/nej, fallna kontroller, datum. Läs ut med `npx wrangler kv key list --binding REVIEWS_KV --prefix pstat:`.
- Årlig uppdatering: `node scripts/update_reference.mjs` (torrkörning) → granska → `--write` → uppdatera tabellen på `/sa-granskar-vi-priser/` → commit → deploy.
