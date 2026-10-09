# Granska min offert – granskaminoffert.se

Ladda upp, fota eller klistra in en hantverkaroffert och få en begriplig genomgång: vad som är otydligt, om siffrorna går ihop och vilka frågor som är värda att ställa innan man skriver på. Gratis, inget konto. Två vägar: "Jag har fått en offert" och "Jag ska skicka en offert".

- **Frontend:** `index.html` – en fil, GitHub Pages, CNAME granskaminoffert.se. Versionsmarkör `<meta name="app-version" content="gmo-vNN">`.
- **Backend:** `worker/` – Cloudflare Worker `granskaminoffert-api` (se `worker/README.md`). `API_BASE` i `index.html` pekar på den.
- **Prislager:** `worker/src/reference.json` (referensdata, versionerad), `worker/src/rules.js` (regler och jämförelse, deterministiskt), `worker/scripts/update_reference.mjs` (årlig SCB-uppdatering). Metodsida: `sa-granskar-vi-priser/index.html`. Underlag: Moneymans PRISUNDERLAG_GRANSKAMINOFFERT.md och KALLREGISTER_PRISER_GRANSKAMINOFFERT.md.
- **Prototyp:** `prototyp/` (noindex, publiceras inte – se `_config.yml`).
- **Kickoff och vision:** `KICKOFF.md` (publiceras inte).

## Släppa
Frontend: committa på `main`, dubbelklicka `Kommandon/PUSH_GRANSKAMINOFFERT.command` (eller `Kommandon/PUSH_ALLT.command`) i Ståhle Digital. Pages bygger på någon minut; verifiera att `app-version` på live matchar.
Backend: dubbelklicka `DEPLOY_GRANSKAMINOFFERT_WORKER.command` (wrangler deploy + /health-kontroll). Reserv: Quick Edit i Cloudflare, se `worker/README.md`. Ordning vid prisändringar: frontend/metodsida först, sedan workern – prisjämförelsen får inte vara live utan `/sa-granskar-vi-priser/`.

## Test
`cd worker && node --test test/*.test.mjs` – workern utan nätverk, inkl. fem testofferter för prisreglerna och kontroll av förbjudna ord. Frontend verifieras headless på 375 och 1280 px (inga konsolfel, ingen sidoscroll, exempelflödet renderar).

## Ändringslogg
Se `CHANGELOG.md`.

## D03-kandidat (2026-10-09)
- Worker-tester: `cd worker && node --test test/*.test.mjs` (inget nätverk, ingen nyckel).
- UI-tester: `node --test tests/ui/ui.test.mjs` (kräver Playwright + Chromium; `PLAYWRIGHT_MODULE`, `CHROMIUM_PATH`).
- F2 (verkligt AI-prov): facit i `worker/test/f2/facit.json`. `scripts/f2_run.mjs` kör inget utan ett beslutat provbudget. Offline-delen (`f2.test.mjs`) prövar bara regelkoden.
- Aktivering av atomärt dagstak: se kommentarsblocket i `worker/wrangler.toml` (kräver separat kontroll av plan).
- Rollback: kandidatens bas är commit `78703f4`; live-identiteten före släpp läses från `/health` (`version`, `build`, `model`).
