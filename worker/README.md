# Granska min offert — backend (Cloudflare Worker)

Status 2026-09-14: kod skriven och syntaxkontrollerad lokalt. **Inte ännu
deployad eller E2E-testad mot skarpt Anthropic API** — det kräver din
medverkan enligt nedan (T4-gräns: pengar/credentials, se
`AI_ARBETSDOKTRIN.md` §7).

Ingen DNS rörs. Ingen ny Cloudflare-domän behövs — vi använder kontots
gratis `*.workers.dev`-subdomän.

## Vad du behöver ha/göra (en gång)

1. **Cloudflare-konto** — ni har redan ett (utan domäner). Logga in på
   https://dash.cloudflare.com.
2. **Anthropic API-nyckel** — om du inte redan har en: skapa på
   https://console.anthropic.com/settings/keys. Spara den ingenstans i
   projektmappen, chatten eller Git.
3. **wrangler** (Cloudflares CLI) — installeras med `npm install -g wrangler`
   eller körs via `npx wrangler`.

## Deploy — steg för steg

Kör i Terminal (eller ge mig tillfällig åtkomst så kör jag detta åt dig, se
nedan — nyckeln skrivs då aldrig i chatten, bara direkt i Cloudflares
dashboard/CLI-prompt):

```bash
cd "Ståhle Digital/granskaminoffert/worker"
npx wrangler login                       # öppnar webbläsaren, logga in
npx wrangler kv namespace create REVIEWS_KV
# klistra in det id som skrivs ut i wrangler.toml (fältet "id")
npx wrangler secret put ANTHROPIC_API_KEY
# klistra in din Anthropic-nyckel när den frågar — syns aldrig i historik/repo
npx wrangler deploy
```

Efter `deploy` skriver wrangler ut en URL i stil med
`https://granskaminoffert-api.<ditt-konto>.workers.dev`. Den URL:en ska in i
`index.html` (`const API_BASE = "..."`) — säg till mig så uppdaterar jag
frontend och committar, eller ändra raden själv.

Testa att det fungerar utan att det kostar någon token:

```bash
curl https://granskaminoffert-api.<ditt-konto>.workers.dev/health
# ska svara {"ok":true,"hasApiKey":true}
```

## Om du hellre ger mig tillfällig åtkomst

Du svarade att du vill ge mig tillfällig åtkomst i stället för att göra hela
deployen själv. Enklast: öppna Cloudflare-dashboarden i din vanliga Chrome
(inloggad), säg till, så navigerar jag dit via Claude in Chrome och gör
stegen ovan i dashboardens UI (Workers & Pages → Create → klistra in kod →
Settings → Variables → lägg till secret). När vi når secret-fältet skriver
**du** in nyckeln själv i webbläsaren — jag klickar bara fram till fältet,
värdet går aldrig genom mig eller chatten. Återkalla sedan min
Chrome-åtkomst när det är klart.

## Kostnad

Ingen prenumeration krävs för MVP: Workers free-nivå (100 000 anrop/dag) och
KV free-nivå räcker gott för lanseringsvolym. Anthropic-anropen kostar per
faktisk användning — se `meta.costUsd` i varje svar; jag rapporterar
uppmätt (inte uppskattad) kostnad per granskning så fort vi kört på riktigt.

## Dataminimering (ditt beslut 2026-09-14)

Varje förfrågan (offertinnehåll + AI-svar) sparas i KV-namnet `REVIEWS_KV`
med `expirationTtl: 86400` — raderas automatiskt av Cloudflare efter 24
timmar, ingen manuell åtgärd krävs. Inget annat lager (ingen databas, ingen
extern loggtjänst). Detta behöver läggas till i
`Administration/Strategi/LEGAL_COMPLIANCE.md`, avsnitt
"Persondata- och webbregister" — se separat TODO i huvudrapporten.
