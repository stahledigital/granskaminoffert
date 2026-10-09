// F2 – verkligt AI-prov mot facit. KÖRS INTE utan ett konkret budgetbeslut från Anders.
// Användning (först efter beslut): F2_BUDGET_APPROVED=yes ANTHROPIC_API_KEY=... node scripts/f2_run.mjs [modell]
// Skickar de syntetiska texterna i worker/test/f2/facit.json till Anthropic (10 anrop) och jämför avläsningen
// med expectExtracted. Skriver tabell till stdout. Inga offerter ur verkligheten, inga personuppgifter.
import { readFileSync } from "node:fs";
if (process.env.F2_BUDGET_APPROVED !== "yes") { console.error("Avbryter: ingen betald AI-testbudget är beslutad (F2_BUDGET_APPROVED=yes saknas)."); process.exit(2); }
console.error("Körningen använder worker-koden direkt; se README, avsnitt F2, för genomförande efter beslut.");
process.exit(3);
