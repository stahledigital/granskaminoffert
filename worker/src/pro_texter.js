// Materialräknaren PRO – servertexter (mejl, samtycken, ångerkvitto). Stödkandidat P3 v2, Claude, 2026-10-17. WORK-ID KP-2026-10-16-01.
// Zlata äger texten. MEJL kommer ur S4g (sha i P3 README); platshållarna i {klamrar} är oförändrade. Ej juristgranskat.
// Underlag: Modesty S2e KOP_VILLKOR_UNDERLAG_S2E.md §3.3, §3.4, §4 (AK-A1–A13), §5.6, §8. Beslut Claude 2026-10-17 (PRO_BESLUT_S2E.md):
// ånger inom 14 dagar ger alltid full återbetalning och ingen proportionell avgift (samma linje som GMO policy P), därför påstår
// samtyckesrutan varken förlorad ångerrätt eller betalning för använd tid.

export const SAMTYCKE_VERSION = "pro-samtycke-v1";
export const VILLKOR_VERSION = "pro-villkor-v1";
export const SAMTYCKE_TEXT = Object.freeze({
  start: "Jag vill att PRO startar direkt, innan ångerfristen på 14 dagar har gått ut.",
  villkor: "Jag har läst köpvillkoren och förstår att jag förbinder mig att betala.",
});

const PLAN_NAMN = { projekt: "PRO för ett projekt i 30 dagar", manad: "PRO månad, alla projekt", ar: "PRO år, alla projekt" };
export const planNamn = (plan) => PLAN_NAMN[plan] || "PRO";

export const MEJL = Object.freeze({ // texter: Zlata S4g (S4g_pro_texter.json, 2026-10-17 12:42); avsandare_namn, intern_amne och intern är Claudes (ingen kundtext); aterhamta* är Claude-utkast
  avsandare_namn: "Ståhle Digital",
  bekr_amne: "Kvitto och bekräftelse: Materialräknaren PRO ({order})",
  bekr: [
    "Tack för ditt köp av Materialräknaren PRO.",
    "",
    "Ordernummer: {order}",
    "Du har köpt: {plan}",
    "{projektrad}",
    "Datum och tid: {tid}",
    "Pris inklusive moms: {inkl} kr",
    "Varav moms (25 procent): {moms} kr",
    "Pris exklusive moms: {exkl} kr",
    "Betalning: via Stripe",
    "{periodrad}",
    "",
    "Det här godkände du vid köpet (lämnat {samtycke_tid}):",
    "- {samtycke_start}",
    "- {samtycke_villkor}",
    "",
    "Du kan ångra köpet inom 14 dagar från köpet och få hela beloppet återbetalt.",
    "Ångra avtalet här: {angra_lank}",
    "",
    "{uppsagningsrad}",
    "Köpvillkor: {villkor_lank}",
    "Dina projekt och offerter sparas bara i den webbläsare du använder. Kunduppgifterna i dina offerter skickas inte till oss.",
    "",
    "{saljare}",
  ],
  projektrad: "PRO gäller på projektet till och med {slut}. Du kan ladda ner nya versioner så många gånger du vill. Projektkod: {kod}.",
  periodrad_manad: "Prenumerationen förnyas automatiskt varje månad. Nästa dragning: {nasta}.",
  periodrad_ar: "Prenumerationen förnyas automatiskt varje år. Nästa dragning: {nasta}. Du får en påminnelse minst en månad innan.",
  uppsagningsrad: "Säga upp: gå till PRO-sidan ({pro_lank}), logga in med din e-postadress och välj Hantera prenumerationen. Uppsägningen gäller från slutet av perioden du har betalat för.",
  fornyelse_amne: "Kvitto: Materialräknaren PRO har förnyats ({order})",
  fornyelse: [
    "Din prenumeration på Materialräknaren PRO har förnyats.",
    "",
    "Ordernummer: {order}",
    "Plan: {plan}",
    "Datum: {tid}",
    "Pris inklusive moms: {inkl} kr, varav moms (25 procent): {moms} kr",
    "Nästa dragning sker automatiskt: {nasta}.",
    "",
    "{uppsagningsrad}",
    "",
    "{saljare}",
  ],
  paminnelse_amne: "Påminnelse: din årsprenumeration på PRO förnyas {fornyelse_datum}",
  paminnelse: [
    "Din årsprenumeration på Materialräknaren PRO förnyas automatiskt med ett år den {fornyelse_datum}, om du inte säger upp den före sista uppsägningsdag.",
    "Priset för det nya året är {inkl} kr inklusive moms.",
    "Sista dag att säga upp så att prenumerationen inte förnyas: {sista_dag}.",
    "",
    "{uppsagningsrad}",
    "",
    "{saljare}",
  ],
  angra_kvitto_amne: "Mottagningsbevis: du har ångrat köp {order}",
  angra_kvitto: [
    "Vi har tagit emot ditt meddelande om att du ångrar ditt köp av Materialräknaren PRO.",
    "",
    "Ordernummer: {order}",
    "Köpt: {plan}",
    "Meddelandet mottogs: {tid}",
    "",
    "{utfall}",
    "",
    "Frågor: {kontakt}",
    "",
    "{saljare}",
  ],
  utfall_aterbetalas: "Köpet är ångrat. PRO stängs för det här köpet och hela beloppet betalas tillbaka till samma betalsätt inom 14 dagar. Räknaren och materiallistan fungerar som förut, och dina sparade projekt ligger kvar i webbläsaren.",
  utfall_avslutas: "Köpet är ångrat. Prenumerationen avslutas direkt och hela beloppet betalas tillbaka till samma betalsätt inom 14 dagar. Räknaren och materiallistan fungerar som förut, och dina sparade projekt ligger kvar i webbläsaren.",
  utfall_manuell: "Ditt meddelande är registrerat och daterat. Vi går igenom ärendet och svarar dig via e-post.",
  intern_amne: "PRO: ångermeddelande {order} ({utfall})",
  intern: [
    "Ångermeddelande registrerat {tid}.",
    "Ordernummer: {order}",
    "Plan: {plan}",
    "Stripe-session: {sid}",
    "Utfall: {utfall}",
    "Steg: {steg}",
    "Kvitto skickat till angiven adress: {kvitto}",
  ],
  login_amne: "Din inloggningslänk till PRO",
  login: [
    "Hej! Du bad om en inloggningslänk till Materialräknaren PRO.",
    "Öppna länken för att logga in: {lank}",
    "Länken gäller i 15 minuter och kan användas en gång.",
    "Bad du inte om den? Då kan du bortse från mejlet. Inget händer om du inte öppnar länken.",
  ],
  // Claude-utkast 2026-10-17 (granskningsfynd A2: projektköp ska gå att hämta i en annan webbläsare). Ingår inte i S4g; Zlata äger texten.
  aterhamta_amne: "Hämta ditt PRO-köp {order}",
  aterhamta: [
    "Hej! Du bad om att få hämta ditt köp av Materialräknaren PRO ({order}) i en webbläsare.",
    "Öppna länken i den webbläsare där du vill använda PRO: {lank}",
    "Projekt som du sparat i en annan webbläsare följer inte med. Spara en projektfil där och öppna den här.",
    "Bad du inte om den? Då kan du bortse från mejlet. Inget händer om du inte öppnar länken.",
  ],
});

// Fyller en mall. En rad som bara består av en platshållare med tomt värde tas bort helt (ingen tom rad mitt i ett block).
export function fyll(mall, v) {
  const rader = Array.isArray(mall) ? mall : String(mall).split("\n");
  const ut = [];
  for (const rad of rader) {
    const ensam = /^\{(\w+)\}$/.exec(rad);
    if (ensam && ensam[1] in v && String(v[ensam[1]]) === "") continue;
    ut.push(rad.replace(/\{(\w+)\}/g, (_, k) => { if (!(k in v)) throw new Error("platshållare saknas: " + k); return String(v[k]); }));
  }
  return ut.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
}
