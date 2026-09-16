# Granska min offert – granskaminoffert.se

Ladda upp, fota eller klistra in en hantverkaroffert och få en begriplig genomgång: vad som är otydligt, om siffrorna går ihop och vilka frågor som är värda att ställa innan man skriver på. Gratis, inget konto. Två vägar: "Jag har fått en offert" och "Jag ska skicka en offert".

- **Frontend:** `index.html` – en fil, GitHub Pages, CNAME granskaminoffert.se. Versionsmarkör `<meta name="app-version" content="gmo-vNN">`.
- **Backend:** `worker/` – Cloudflare Worker `granskaminoffert-api` (se `worker/README.md`). `API_BASE` i `index.html` pekar på den.
- **Prototyp:** `prototyp/` (noindex, publiceras inte – se `_config.yml`).
- **Kickoff och vision:** `KICKOFF.md` (publiceras inte).

## Släppa
Frontend: committa på `main`, dubbelklicka `PUSH_GRANSKAMINOFFERT.command` (eller `PUSH_ALLT.command`) i projektroten. Pages bygger på någon minut; verifiera att `app-version` på live matchar.
Backend: se `worker/README.md` (Quick Edit i Cloudflare med md5-kontroll, eller `wrangler deploy`).

## Test
`node --test worker/test/index.test.mjs` – workern utan nätverk. Frontend verifieras headless på 375 och 1280 px (inga konsolfel, ingen sidoscroll, exempelflödet renderar).

## Ändringslogg
Se `CHANGELOG.md`.
