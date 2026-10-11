// D14: signerar en SYNTETISK Resend/Svix-händelse för lokal provning av POST /compare/mail-events. Skickar INGET själv och anropar ingen leverantör.
// Användning:  COMPARE_MAIL_WEBHOOK_SECRET=<whsec_… från din LOKALA .dev.vars> node dev/sign_mail_event.mjs händelse.json
// Skriver tre headerrader (svix-id/-timestamp/-signature) för curl -H. Hemligheten skrivs aldrig ut. Använd aldrig en produktionshemlighet i delad terminal/logg.
import { readFileSync } from "node:fs";
import { signResendForTest, mailEventsConfig } from "../src/compare_mailer.js";
const file = process.argv[2];
const secret = process.env.COMPARE_MAIL_WEBHOOK_SECRET || "";
if (!file || !mailEventsConfig({ COMPARE_MAIL_WEBHOOK_SECRET: secret }).on) { console.error("Användning: COMPARE_MAIL_WEBHOOK_SECRET=whsec_… node dev/sign_mail_event.mjs <händelse.json>  (ogiltig/saknad hemlighet eller fil)"); process.exit(2); }
const body = readFileSync(file, "utf8");
const h = await signResendForTest(body, secret, { id: "msg_LOCAL" + Date.now().toString(36).toUpperCase() });
for (const [k, v] of Object.entries(h)) console.log(`-H '${k}: ${v}'`);
