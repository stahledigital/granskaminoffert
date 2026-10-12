// Jämför mina offerter (GMO-LANSERING-20261010-01 D04): produktkonstanter och konfiguration.
//
// PRIS OCH PRODUKT ÄR SERVERÄGDA. Priset står här som kod (4900 öre SEK inklusive moms),
// aldrig som indata från webbläsaren eller som miljövariabel som en kund kan påverka.
// Funktionen är AVSTÄNGD tills COMPARE_ENABLED = "1" OCH betalningsadaptern är uttryckligen
// konfigurerad. Ingen kostnad kan uppstå utan ett av en människa konfigurerat hårt tak.

import { mailHttpConfig } from "./compare_mailer.js";

export const COMPARE_VERSION = "jamfor-v1";
export const OFFER = Object.freeze({
  version: "erbjudande-1",
  product: "Jämför mina offerter",
  priceOre: 4900, // 49,00 kr inklusive moms – EN källa
  currency: "sek",
  vatPct: 25, // kalkylantagande; verklig momsbehandling verifieras i kommersiella spåret
  minDocs: 2,
  maxDocs: 4,
  retentionHours: 24,
});

// Erbjudandetext och samtycke ägs av servern så att det kunden SER är exakt det som bindes till ordern
// (versions- och hashbindning). Slutlig juridisk text väntar kommersiella spåret: tills dess är
// CONSENT.draft = true, vilket stänger LIVE-betalning (bara testläge tillåts) och märks i gränssnittet.
export const OFFER_COPY = Object.freeze({
  gets: [
    "Jämförelse av dina offerter: omfattning, pris, moms och ROT, med hänvisning till var i dokumentet uppgiften står.",
    "Tydligt markerat det som inte framgår – det betyder inte att det saknas.",
    "Frågor att ställa till varje hantverkare, och ett kvitto.",
  ],
  getsNot: [
    "Ingen bedömning av hantverkare, kvalitet eller om priset är rimligt.",
    "Ingen rekommendation om vem du ska välja. Lägst belopp visas bara när offerterna går att jämföra, och säger inget om kvalitet.",
    "Inga omdömen om företagen. Varken Google, Trustpilot eller andra källor ingår i den här versionen, och tjänsten visar inga senaste omdömen.",
    "Inte juridisk rådgivning.",
  ],
  how: [
    "Efter betalning startar jämförelsen direkt och tar oftast några minuter. Du kan stänga fliken – du får tillbaka resultatet via en länk som visas här.",
    "Offerterna skickas till Anthropic (Claude) för avläsning. Inga namn eller offerttexter går till betalleverantören.",
    "Dina filer och resultatet raderas efter 24 timmar, eller direkt när du själv raderar.",
    "Du anger en e-postadress. Vi skickar en avtalsbekräftelse dit, med en länk för att ångra köpet. Adressen används bara för det.",
    "Går något fel och du inte får ditt resultat ska du få pengarna tillbaka.",
  ],
});
export const CONSENT = Object.freeze({
  version: "samtycke-utkast-1",
  draft: true,
  texts: Object.freeze({
    sameJob: "Jag bekräftar att offerterna gäller samma jobb. Annars blir jämförelsen missvisande.",
    terms: "Jag har läst och godkänner villkoren och integritetsinformationen (utkast – slutlig text är inte fastställd).",
    immediate: "Jag vill att jämförelsen startar direkt efter betalning och förstår att ångerrätten därmed kan gå förlorad när tjänsten är levererad.",
  }),
});
// ---- Policy P (isolerad KANDIDAT, Modesty §12; default AV = policy Q oförändrad) ----
// COMPARE_CONSENT_POLICY=P: två SEPARATA, aktivt valda (ej förkryssade) rutor före betalning – (1) start direkt inom ångerfristen, (2) godtar att ångerrätten upphör först när tjänsten är fullt utförd.
// Policyn fryses per order vid /accept; redan skapade Q-ordrar ändras aldrig (ingen retroaktiv Q→P). Ingen live-aktivering: CONSENT.draft stänger live fortfarande.
export const consentPolicy = (env) => (env && env.COMPARE_CONSENT_POLICY === "P" ? "P" : "Q");
// D15 (Anders bekräftelse 2026-10-11 18:38): P-villkoren (villkor-p-1) är fastställda utan platshållare; policy Q förblir utkast och kan inte gå live.
export const consentDraft = (env) => (consentPolicy(env) === "P" ? false : CONSENT.draft);
export const FULFILMENT_POINTS = Object.freeze(["leverans", "fonster_slut"]);
// FULFILMENT_POINT: explicit konfigurerbar. leverans = rapport (och avtalad källtäckning) levererad; fonster_slut = dessutom 24 h-fönstret för att spara rapporten slut.
// Vilken som gäller i live är en rättslig bedömning (U2), inte en kundpreferens. Ogiltigt värde ⇒ P stänger beställning (fail closed).
export function fulfilmentPoint(env) {
  const v = env ? env.COMPARE_FULFILMENT_POINT : undefined;
  if (v === undefined || v === "") return { ok: true, point: "leverans", explicit: false };
  return FULFILMENT_POINTS.includes(v) ? { ok: true, point: v, explicit: true } : { ok: false, point: null, explicit: true };
}
export const CONSENT_P_VERSION = "samtycke-p-1"; // utkast-1 (tre rutor) lever kvar i redan frusna ordrar; ny text = ny hash = nytt aktivt val
export function consentTexts(env) {
  if (consentPolicy(env) !== "P") return CONSENT.texts;
  const rev = reviewsActive(env), win = fulfilmentPoint(env).point === "fonster_slut";
  const what = "jag har fått min jämförelserapport" + (rev ? " och de omdömesvisningar som ingår i min order" : "") + (win ? ", och tiden på 24 timmar för att spara rapporten har gått ut" : "");
  return Object.freeze({
    sameJob: CONSENT.texts.sameJob,
    // Policy P: EN gemensam, aktiv deklaration (startbegäran + godtagande att ångerrätten upphör, Kommissionen 2021/C525/01 avsn. 5.6.1) och villkorsgodkännandet som knyts till köpknappen.
    terms: "Genom att köpa godkänner du köpvillkoren.",
    declaration: "Jag vill att jämförelsen börjar direkt och godtar att ångerrätten upphör när tjänsten är helt utförd.",
    fulfilmentDef: `Tjänsten är helt utförd när ${what}.`,
  });
}
export const consentVersion = (env) => (consentPolicy(env) === "P" ? CONSENT_P_VERSION : CONSENT.version);

// Retentionklasser (explicita). Innehåll = offertfiler/rapport (24 h, kod). Avtalspost/ledger och bokföringsunderlag
// har INGEN förvald tid: längderna sätts av en människa efter slutlig GDPR-/bokföringsbedömning (live fail closed utan dem).
export const RETENTION_CLASSES = Object.freeze({
  innehall: { hours: 24, note: "Offertfiler, avläsning och rapport. Raderas efter 24 h eller direkt vid kundens radering." },
  avtal: { note: "Minimal order-/betal-/samtyckespost och ångerbegäran (ingen offerttext). Längd väntar fastställd policy." },
  bokforing: { note: "Belopp, moms, datum och Stripe-referenser för bokföring/återbetalning (ingen offerttext). Längd väntar fastställd policy." },
});
const dayCount = (v) => { const n = Number(v); return typeof v === "string" && /^[1-9][0-9]{0,4}$/.test(v) && n <= 36500 ? n : null; };
export function retentionPolicy(env) {
  const avtal = dayCount(env && env.COMPARE_LEDGER_RETENTION_DAYS), bokforing = dayCount(env && env.COMPARE_BOOKKEEPING_RETENTION_DAYS);
  return { ok: avtal !== null && bokforing !== null, avtalDays: avtal, bokforingDays: bokforing };
}
// Säljaruppgifter till avtalsbekräftelsen/villkoren. ALLT kommer från konfiguration (miljövariabler) – inga riktiga identifierare finns i koden.
// TEKNISK OFFLINEFÖRLAGA enligt Modesty §5h (fältmatris WEBB/FÖREKÖP/BEKRÄFTELSE) – inte juridisk slutaccept. Tolkningen för enskild firma är OPEN (se COMPARE.md).
// COMPARE_SELLER_FORM = AB | ENSKILD (obligatorisk). Alltid krav för live: namn, adress, e-post, telefon, COMPARE_COMPANY_INFO_URL (https).
// AB: org.nr krävs (10 siffror, Luhn, tredje siffran >= 2 ⇒ personnummer godkänns aldrig). ENSKILD: ägarens namn krävs och org.nr MÅSTE VARA TOMT –
// ett angivet värde ger konfigfel `orgnr_forbidden_enskild` och värdet återges/loggas aldrig (varken i vyer, snapshot, mejl eller fel).
// Momsreg.nr: valfritt. Visas i bekräftelsen bara med COMPARE_CONFIRM_SHOW_VAT=1 (standard 0) och är då obligatoriskt (SE+12 siffror). Webbens eget momskrav
// ligger på den statiska företagsuppgiftssidan, inte här. Erbjudandet är 49 kr INKLUSIVE moms; är säljaren inte momsregistrerad krävs ett mänskligt T4-beslut om pris-/momstext.
const clip = (v, n) => String((v == null ? "" : v)).replace(/[\r\n\t]+/g, " ").trim().slice(0, n);
export const SELLER_FORMS = Object.freeze(["AB", "ENSKILD"]);
// Organisationsnummer för juridisk person: 10 siffror (valfritt bindestreck efter sex), tredje siffran >= 2, Luhn-kontrollsiffra. Returnerar NNNNNN-NNNN eller null.
export function normalizeOrgNrAB(v) {
  const m = /^(\d{6})-?(\d{4})$/.exec(String(v == null ? "" : v));
  if (!m) return null;
  const d = (m[1] + m[2]).split("").map(Number);
  if (d[2] < 2) return null;
  let sum = 0;
  for (let i = 0; i < 10; i++) { let x = d[i] * (i % 2 === 0 ? 2 : 1); if (x > 9) x -= 9; sum += x; }
  return sum % 10 === 0 ? `${m[1]}-${m[2]}` : null;
}
// Publik https-länk utan inloggningsuppgifter, söksträng eller fragment, med värdnamn som innehåller punkt. Returnerar normaliserad href eller null.
export function httpsInfoUrl(v) {
  const raw = String(v == null ? "" : v).trim();
  if (!raw || raw.length > 200 || /[\s<>"'\\]/.test(raw)) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.port) return null;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(u.hostname)) return null;
    return u.href;
  } catch { return null; }
}
export function sellerInfo(env) {
  const g = (k, n) => clip(env && env[k], n);
  const form = g("COMPARE_SELLER_FORM", 10);
  const name = g("COMPARE_SELLER_NAME", 120), owner = g("COMPARE_SELLER_OWNER_NAME", 120);
  const orgRaw = g("COMPARE_SELLER_ORGNR", 20), vatRaw = g("COMPARE_SELLER_VAT", 20).replace(/\s+/g, "");
  const email = g("COMPARE_SELLER_EMAIL", 120), address = g("COMPARE_SELLER_ADDRESS", 200), phone = g("COMPARE_SELLER_PHONE", 30);
  const infoUrl = httpsInfoUrl(env && env.COMPARE_COMPANY_INFO_URL);
  const showVat = !!env && env.COMPARE_CONFIRM_SHOW_VAT === "1";
  const formOk = SELLER_FORMS.includes(form);
  const orgAB = form === "AB" ? normalizeOrgNrAB(orgRaw) : null;
  const ok = {
    form: formOk, name: !!name, owner: form !== "ENSKILD" || !!owner,
    orgnr: form === "AB" ? orgAB !== null : form === "ENSKILD" ? orgRaw === "" : false,
    vat: !showVat || /^SE\d{12}$/.test(vatRaw),
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), address: address.length >= 8, phone: /^[+0-9][0-9 ()-]{5,29}$/.test(phone),
    infoUrl: infoUrl !== null,
  };
  const missing = Object.entries(ok).filter(([, v]) => !v).map(([k]) => k);
  // Konfigfel rapporteras som kod, aldrig med värdet.
  const errors = form === "ENSKILD" && orgRaw !== "" ? ["orgnr_forbidden_enskild"] : [];
  const ph = (v, label) => v || `[${label} – fylls i före skarp drift]`;
  // Robust default-redaktion vid förbjudet ENSKILD-org.nr: identifieraren får inte kunna återges via NÅGOT annat fält (t.ex. VAT = SE + samma siffror,
  // namn, adress, telefon, länk). Ett fält som innehåller hela strängen eller hela sifferföljden ersätts av platshållare och räknas som saknat (bara fältnamnet rapporteras);
  // VAT-raden släpps helt så länge konfigfelet finns. Ingen del av det förbjudna värdet lämnar funktionen.
  const bad = new Set();
  const digits = errors.length ? orgRaw.replace(/\D/g, "") : "";
  const clean = (key, v) => {
    if (!errors.length || !v) return v;
    if ((orgRaw && v.includes(orgRaw)) || (digits.length >= 4 && v.replace(/\D/g, "").includes(digits))) { bad.add(key); return ""; }
    return v;
  };
  const out = {
    form: formOk ? form : "",
    name: ph(clean("name", name), "Säljare"), owner: form === "ENSKILD" ? ph(clean("owner", owner), "ägarens namn") : "",
    orgnr: form === "AB" ? ph(orgAB, "org.nr") : "", // ENSKILD: aldrig något nummer; ogiltigt/förbjudet värde återges aldrig
    email: ph(clean("email", email), "kontakt-e-post"), address: ph(clean("address", address), "adress"), phone: ph(clean("phone", phone), "telefon"),
    infoUrl: ph(clean("infoUrl", infoUrl || ""), "länk till företagsuppgifter"),
    showVat: showVat && !errors.length, vat: showVat && !errors.length ? ph(ok.vat ? vatRaw : "", "momsreg.nr") : "",
  };
  const missingOut = [...new Set([...missing, ...bad])];
  return { ...out, placeholder: missingOut.length > 0 || errors.length > 0, missing: missingOut, errors };
}
export function sellerLines(sel) {
  const orgLine = sel.form === "ENSKILD" ? "Organisationsnummer: saknas (enskild firma)" : `Organisationsnummer: ${sel.orgnr || "[org.nr – fylls i före skarp drift]"}`;
  return [
    `Säljare: ${sel.name}`,
    ...(sel.form === "ENSKILD" ? [`Ägare: ${sel.owner}`] : []),
    orgLine,
    ...(sel.showVat ? [`Momsregistreringsnummer: ${sel.vat}`] : []),
    `Adress: ${sel.address}`, `E-post: ${sel.email}`, `Telefon: ${sel.phone}`,
    `Fler företagsuppgifter: ${sel.infoUrl}`,
  ];
}
const krText = (ore) => `${(ore / 100).toFixed(2).replace(".", ",")} kr`;
// Fullständig villkors-/avtalstext (UTKAST) ägd av servern. Den som kunden ser, godkänner (hash) och får i bekräftelsen är EXAKT denna snapshot.
// Ingen slutlig juridisk text: öppna beslut står som [hakparentes]-platshållare och live är stängt (CONSENT.draft) tills människa fastställt dem.
export const SWISH_NOTE = "Du kan betala med kort eller Swish. Betalar du med Swish går betalningen via Stripe: i Swish kan Stripe visas som mottagare och Ståhle Digital i meddelandet. Du köper av Ståhle Digital. Beloppet är samma 49 kr inklusive moms.";
export const TERMS_VERSION = "villkor-utkast-1";
export const TERMS_P_VERSION = "villkor-p-1";
export function termsSnapshot(env) {
  if (consentPolicy(env) === "P") return termsSnapshotP(env);
  const seller = sellerInfo(env), pol = retentionPolicy(env), copy = offerCopy(env);
  const vatOre = vatPart(OFFER.priceOre, OFFER.vatPct);
  const days = (d, what) => (d === null ? `[lagringstid för ${what} är inte fastställd]` : `${d} dagar`);
  const sections = [
    { id: "saljare", title: "Säljare", text: sellerLines(seller).join("\n") },
    { id: "tjansten", title: "Tjänsten", text: [`${OFFER.product} jämför innehåll i ${OFFER.minDocs}–${OFFER.maxDocs} offerter som du själv laddar upp.`, "Det här ingår:", ...copy.gets.map((t) => `- ${t}`), "Det här ingår inte:", ...copy.getsNot.map((t) => `- ${t}`), "Så går det till:", ...copy.how.map((t) => `- ${t}`)].join("\n") },
    { id: "pris", title: "Pris och betalning", text: `Pris: ${krText(OFFER.priceOre)} inklusive moms (varav moms ${krText(vatOre)}, ${OFFER.vatPct} %). Engångsköp. Betalningen sker hos betalleverantören Stripe; kvittot därifrån är en separat handling.${paymentMethods(env).swish ? ` ${SWISH_NOTE}` : ""}` },
    { id: "avtal", title: "Avtalsbekräftelse", text: "När betalningen är genomförd skickas en avtalsbekräftelse med de här villkoren, det du godkände och en länk för att ångra köpet till den e-postadress du angav." },
    { id: "angerratt", title: "Ångra köpet och start direkt", text: "[UTKAST – hur ångerrätt och start direkt bedöms är inte slutligt fastställt.] Du kan begära att ångra köpet via länken i bekräftelsen, från sidan med ditt resultat eller på /jamfor/angra/. Begäran sparas med tidpunkt. Har jämförelsen inte levererats stoppas den och hela beloppet ska betalas tillbaka. Är rapporten redan levererad prövas begäran manuellt; mottagningsbeviset avgör inte om ångerrätt finns eller inte." },
    { id: "aterbetalning", title: "Om något går fel", text: "Går något fel och du inte får ditt resultat ska du få pengarna tillbaka." },
    { id: "personuppgifter", title: "Personuppgifter och lagring", text: `Offerterna skickas till Anthropic för avläsning. Filer, avläsning och rapport raderas efter ${OFFER.retentionHours} timmar eller direkt när du raderar. Order-, betal- och samtyckespost sparas utan offerttext: avtalspost ${days(pol.avtalDays, "avtalspost")}, bokföringsunderlag ${days(pol.bokforingDays, "bokföringsunderlag")}. Betaluppgifter hanteras av Stripe och lagras inte av oss.` },
    { id: "kontakt", title: "Kontakt och klagomål", text: `Kontakta ${seller.email} om du har frågor, klagomål eller vill ha hjälp med återbetalning. [Information om tvistlösning fastställs av det kommersiella spåret.]` },
  ];
  return { version: TERMS_VERSION, draft: true, seller, sections };
}
function termsSnapshotP(env, opts) {
  const seller = sellerInfo(env), pol = retentionPolicy(env), copy = offerCopy(env), rev = !(opts && opts.reviews === false) && reviewsActive(env), fp = fulfilmentPoint(env).point;
  const vatOre = vatPart(OFFER.priceOre, OFFER.vatPct);
  const days = (d, what) => (d === null ? `[lagringstid för ${what} är inte fastställd]` : `${d} dagar`);
  const done = "när vi har levererat din jämförelserapport" + (rev ? " och de omdömesvisningar som visades före köpet (se Täckning)" : "") + (fp === "fonster_slut" ? " och tiden på 24 timmar för att spara rapporten har gått ut" : "");
  const sections = [
    { id: "saljare", title: "Säljare", text: sellerLines(seller).join("\n") },
    { id: "tjansten", title: "Vad som ingår", text: [`${OFFER.product} jämför innehåll i ${OFFER.minDocs}–${OFFER.maxDocs} offerter som du själv laddar upp.`, "Det här ingår:", ...copy.gets.map((t) => `- ${t}`), ...(rev ? ["- Källans egna omdömen visas separat bara för de företag där täckning visas före köp. Vi lovar inte omdömen för företag som inte står i täckningen."] : []), "Det här ingår inte:", ...copy.getsNot.map((t) => `- ${t}`), "Så går det till:", ...copy.how.map((t) => `- ${t}`)].join("\n") },
    { id: "pris", title: "Pris och betalning", text: `Pris: ${krText(OFFER.priceOre)} inklusive moms (varav moms ${krText(vatOre)}, ${OFFER.vatPct} %). Engångsköp. Betalningen sker hos betalleverantören Stripe; kvittot därifrån är en separat handling.${paymentMethods(env).swish ? ` ${SWISH_NOTE}` : ""}` },
    { id: "avtal", title: "Avtalsbekräftelse", text: "När betalningen är genomförd skickas en avtalsbekräftelse med de här villkoren, dina val och en länk till Ditt köp och villkor (avtal, hjälp och reklamation samt ånger när ångerrätt finns) till den e-postadress du angav. Analysen startar först när bekräftelsen har skickats." },
    { id: "angerratt", title: "Ångerrätt", text: `Du har som utgångspunkt 14 dagars ångerrätt från den dag du beställer. Om du väljer att analysen ska starta direkt och godtar att ångerrätten upphör när tjänsten är fullt utförd, har du ingen ångerrätt efter det. Tjänsten är fullt utförd ${done}. Ångrar du dig innan dess får du hela beloppet tillbaka och du betalar ingenting för det som hunnit utföras. Ångra avtalet på sidan Ditt köp och villkor (/jamfor/kop/) eller på /jamfor/angra/. Standardformulär för ångerrätt bifogas avtalsbekräftelsen.` },
    { id: "efterleverans", title: "Efter fullständig leverans", text: "Du har inte längre ångerrätt, men din rätt att reklamera, rätt till rättelse vid fel och övriga rättigheter enligt lag gäller som vanligt, och du kan alltid kontakta oss." },
    { id: "ofullstandig", title: "Om leveransen är ofullständig eller fel", text: "Om något som ingår i din order inte levereras, eller rapporten har ett fel, behåller du dina rättigheter. Vi åtgärdar felet eller återbetalar enligt lag." },
    { id: "aterbetalning", title: "Återbetalning", text: "Om du ångrar dig innan tjänsten är fullt utförd, om något som ingår i din order inte levereras, eller om du har rätt till återbetalning enligt lag på grund av fel, återbetalas beloppet via samma betalsätt utan onödigt dröjsmål och senast inom 14 dagar från att vi tog emot din begäran. Efter fullständig leverans enligt ditt samtycke ges ingen återbetalning på grund av ångerrätt; reklamation och övriga lagstadgade rättigheter påverkas inte." },
    { id: "personuppgifter", title: "Personuppgifter och lagring", text: `Offerterna skickas till Anthropic för avläsning. Filer, avläsning och rapport raderas efter ${OFFER.retentionHours} timmar eller direkt när du raderar. Order-, betal- och samtyckespost sparas utan offerttext: avtalspost ${days(pol.avtalDays, "avtalspost")}, bokföringsunderlag ${days(pol.bokforingDays, "bokföringsunderlag")}. Betaluppgifter hanteras av Stripe och lagras inte av oss.` },
    { id: "kontakt", title: "Kontakt, reklamation och klagomål", text: `Kontakta ${seller.email} om du har frågor, reklamation, klagomål eller vill ha hjälp med återbetalning. Det gäller även efter att tjänsten är fullt utförd. Tvistlösning: Allmänna reklamationsnämnden (ARN) har som regel en lägsta värdegräns (750 kr för många områden) och en tvist om 49 kr ligger under den. ARN får ändå pröva en tvist under gränsen om den är av principiellt intresse eller det finns andra särskilda skäl; det avgör ARN.` },
  ];
  return { version: TERMS_P_VERSION, draft: false, seller, sections };
}
export function termsPlain(t) { return t.sections.map((x) => `${x.title}\n${x.text}`).join("\n\n"); }
export const DATA_COVERAGE = Object.freeze({ reviews: false, text: "Omdömen om företagen ingår inte i den här versionen." });
// D07: källvisning av omdömen (Google/Trustpilot) är en SEPARAT, avstängd funktion. Aktiv bara när en människa satt BÅDA flaggorna
// (COMPARE_REVIEWS=1 och COMPARE_REVIEWS_VERIFIED=1 = villkor/licens/kostnad verifierade). Texten som kunden godkänner följer läget,
// så kunden aldrig lovas något som inte är påslaget. Aldrig i rapport, export, mejl eller modell.
export const reviewsActive = (env) => !!env && env.COMPARE_REVIEWS === "1" && env.COMPARE_REVIEWS_VERIFIED === "1";
const REVIEWS_ON_GETSNOT = "Omdömen om företagen räknas inte in i jämförelsen och står inte i rapporten eller mejlen. Där en källa är tillgänglig för just din firma visas Googles och Trustpilots egna omdömen separat, med källans eget urval och datum. Vi ger inget eget betyg, ingen rangordning och ingen bedömning av företaget, och vi lovar inte att en källa finns eller har omdömen för varje firma (se täckningen innan du betalar).";
const HOW_P_START = "Analysen startar först när betalningen är genomförd, du har markerat rutan och vi har skickat din avtalsbekräftelse. Det tar oftast några minuter. Du kan stänga fliken – du får tillbaka resultatet via en länk som visas här.";
const HOW_P_EMAIL = "Du anger en e-postadress. Kvitto och avtalsbekräftelse med alla villkor skickas dit, med en länk till Ditt köp och hjälp. Adressen används bara för det.";
export function offerCopy(env) {
  let c = OFFER_COPY;
  if (reviewsActive(env)) c = { ...c, getsNot: c.getsNot.map((t) => (/^Inga omdömen om företagen/.test(t) ? REVIEWS_ON_GETSNOT : t)) };
  if (consentPolicy(env) === "P") c = { ...c, how: c.how.map((t, i) => (i === 0 ? HOW_P_START : /^Du anger en e-postadress/.test(t) ? HOW_P_EMAIL : t)) };
  return c === OFFER_COPY ? c : Object.freeze(c);
}
export function dataCoverage(env) {
  if (!reviewsActive(env)) return DATA_COVERAGE;
  return Object.freeze({ reviews: true, text: "Omdömen visas separat per firma när källan är tillgänglig för firman. Täckningen för dina firmor visas innan du betalar. Omdömen ingår inte i jämförelsen, rapporten eller mejl." });
}

// Det kunden accepterar: pris, produkt, erbjudandetext och samtyckestexter. Hashen bindes till ordern.
export function consentSnapshot(env, kind) {
  if (kind === "check") return checkConsentSnapshot(env);
  const base = {
    consentVersion: consentVersion(env), draft: consentDraft(env),
    offerVersion: OFFER.version, priceOre: OFFER.priceOre, currency: OFFER.currency, vatPct: OFFER.vatPct,
    copy: offerCopy(env), texts: consentTexts(env), dataCoverage: dataCoverage(env), terms: termsSnapshot(env),
  };
  // Policy Q: exakt som förut (samma nycklar ⇒ samma hash). Policy P lägger till policy + fullgörandepunkt (ingår i hashen kunden binds till).
  return consentPolicy(env) === "P" ? { ...base, policy: "P", fulfilmentPoint: fulfilmentPoint(env).point } : base;
}

// Tekniska gränser (INTE ett budgetbeslut). Före betalning tydliga för kunden.
export const LIMITS = Object.freeze({
  maxFileBytes: 8_000_000, // som /review
  maxTotalBytes: 20_000_000,
  maxTextChars: 20_000,
  maxInputTokensPerDoc: 60_000, // övre kodram per offert, inte genomsnitt
  maxTotalInputTokens: 200_000,
  maxPdfPagesPerDoc: 30,
  maxPdfPagesTotal: 80,
  extractMaxTokens: 6_000, // som models.js för Sonnet 5.5
  synthMaxInputTokens: 24_000,
  synthMaxOutputTokens: 6_000,
  maxAttemptsPerStep: 2, // ett omförsök, bara om återstående budget räcker
  maxOrderAttempts: 3,
  confirmWaitMs: 30 * 60_000, // längsta väntan på godkänd transportkvittens för avtalsbekräftelsen innan ordern avbryts och återbetalas
  leaseMs: 5 * 60_000,
  statusPollMinMs: 2_000,
  reconcileMinMs: 10_000,
  orderTtlSec: 86_400,
});

const intOrNaN = (v) => {
  if (v === undefined || v === null || v === "") return NaN;
  const s = typeof v === "number" ? String(v) : v;
  return typeof s === "string" && /^(0|[1-9][0-9]{0,15})$/.test(s) ? Number(s) : NaN;
};

export function compareEnabled(env) {
  return !!env && env.COMPARE_ENABLED === "1";
}

// Betalningsläge: bara "test" eller "live" öppnar adaptern. Nyckelprefix måste stämma med läget.
export function paymentsMode(env) {
  if (!env) return null;
  const m = env.COMPARE_PAYMENTS;
  if (m !== "test" && m !== "live") return null;
  const key = String(env.STRIPE_SECRET_KEY || "");
  const wh = String(env.STRIPE_WEBHOOK_SECRET || "");
  const okKey = m === "test" ? /^(sk|rk)_test_[A-Za-z0-9]{8,}$/.test(key) : /^(sk|rk)_live_[A-Za-z0-9]{8,}$/.test(key);
  if (!okKey || !/^whsec_[A-Za-z0-9]{8,}$/.test(wh)) return null;
  return m;
}

// Betalmetoder i Stripe Checkout (samma Checkout/orderledger, 49 kr inkl. moms, engångsköp, SEK). Standard = bara kort. Swish (kort+swish eller dynamiskt metodval)
// öppnas ENDAST när en människa satt COMPARE_SWISH_VERIFIED=1 (= kontoåtkomst/villkor verifierade); annars faller allt tillbaka till kort. Koden ändrar aldrig kontots metoder.
//   COMPARE_PAYMENT_METHODS: "card" (standard) | "card,swish" | "dynamic" (utelämnar payment_method_types; Stripes dynamiska metodval styrs av Dashboard)
export function paymentMethods(env) {
  const raw = String((env && env.COMPARE_PAYMENT_METHODS) || "card").trim().toLowerCase();
  const verified = !!env && env.COMPARE_SWISH_VERIFIED === "1";
  const set = new Set(raw.split(",").map((x) => x.trim()).filter(Boolean));
  const wantsSwish = (set.size === 2 && set.has("card") && set.has("swish")) || raw === "dynamic";
  if (wantsSwish && verified) return raw === "dynamic" ? { kind: "dynamic", types: null, swish: true } : { kind: "card_swish", types: ["card", "swish"], swish: true };
  return { kind: "card", types: ["card"], swish: false, swishBlocked: wantsSwish && !verified };
}
export const methodsKey = (m) => (m.kind === "dynamic" ? "dyn" : m.types.join("+"));

// Hårda tak (µUSD) måste sättas av en människa. Saknas något returneras ok:false och INGEN
// generation görs. Det finns ingen standardsumma.
export function budgetConfig(env) {
  const month = intOrNaN(env && env.COMPARE_MONTH_CAP_MICRO);
  const paid = intOrNaN(env && env.COMPARE_PAID_CAP_MICRO);
  const free = intOrNaN(env && env.COMPARE_FREE_CAP_MICRO); // äldre fält, oanvänt av D12-potten (ingen separat gratispott); bevaras för kompatibilitet
  const order = intOrNaN(env && env.COMPARE_ORDER_CAP_MICRO);
  const dayOrders = intOrNaN(env && env.COMPARE_DAY_ORDERS);
  const ok = [month, paid, order, dayOrders].every((v) => Number.isSafeInteger(v) && v > 0) && paid <= month;
  return { ok, month, paid, free: Number.isSafeInteger(free) ? free : null, order, dayOrders };
}

export function returnUrl(env, allowedOrigins) {
  const u = String((env && env.COMPARE_RETURN_URL) || "");
  try {
    const p = new URL(u);
    if (p.protocol !== "https:" && !(p.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(p.hostname))) return null;
    if (p.search || p.hash) return null;
    if (allowedOrigins && !allowedOrigins.includes(p.origin)) return null;
    return p.toString();
  } catch { return null; }
}

export function refundMode(env) {
  return env && env.COMPARE_AUTO_REFUND === "1" ? "auto" : "manual";
}

// Mejltransport för avtalsbekräftelsen. "adapter" = env.COMPARE_MAILER.send (extern, AV tills människa kopplar). "mock" = uttryckligt TESTLÄGE
// (COMPARE_MAILER_MODE=mock, aldrig i live): kvittensen är en attrapp och märks så. Utan någon av dem kan bekräftelsen inte ges ⇒ inga ordrar tas emot.
// "http" = verklig HTTP-adapter (compare_mailer.js): kräver ALLA av COMPARE_MAIL_HTTP=1, COMPARE_MAIL_HTTP_VERIFIED=1, COMPARE_MAIL_FROM, COMPARE_MAIL_DAY_CAP>0 och COMPARE_MAIL_API_KEY – default AV.
export function mailerKind(env) {
  if (env && env.COMPARE_MAILER && typeof env.COMPARE_MAILER.send === "function") return "adapter";
  if (mailHttpConfig(env).on) return "http";
  if (env && env.COMPARE_MAILER_MODE === "mock" && env.COMPARE_PAYMENTS !== "live") return "mock";
  return null;
}
// D16-R2: administrativt spärrad TESTKEDJA på samma Worker. Av som standard. Kräver ALLA av: COMPARE_TEST_CHAIN=1, COMPARE_TEST_CHAIN_UNTIL (ISO, i framtiden, högst 48 h framåt),
// två krypterade testsecrets (STRIPE_TEST_SECRET_KEY sk_/rk_test_, STRIPE_TEST_WEBHOOK_SECRET whsec_), COMPARE_ADMIN_TOKEN (>=24) och riktig HTTP-mejltransport.
// Testordrar skapas ENDAST via admin-rutten, betalas ENDAST via testadaptern (aldrig användarpublik checkout) och mejlas ENDAST till TEST_CHAIN_TO. Live-secrets/FREE-pilot rörs inte.
export const TEST_CHAIN_TO = "hej@stahledigital.se";
export function testChain(env, now = Date.now()) {
  if (!env || env.COMPARE_TEST_CHAIN !== "1") return { on: false };
  const until = Date.parse(String(env.COMPARE_TEST_CHAIN_UNTIL || ""));
  const ok = Number.isFinite(until) && until > now && until <= now + 48 * 3600_000
    && /^(sk|rk)_test_[A-Za-z0-9]{8,}$/.test(String(env.STRIPE_TEST_SECRET_KEY || "")) && /^whsec_[A-Za-z0-9]{8,}$/.test(String(env.STRIPE_TEST_WEBHOOK_SECRET || ""))
    && String(env.COMPARE_ADMIN_TOKEN || "").length >= 24 && mailerKind(env) === "http";
  return { on: ok, until: ok ? until : null };
}
// Stripe-anrop för testordrar går med testnyckeln i TESTLÄGE (livemode=false); live-nyckeln används aldrig här.
export const testStripeEnv = (env) => ({ ...env, STRIPE_SECRET_KEY: env.STRIPE_TEST_SECRET_KEY, COMPARE_PAYMENTS: "test" });
export const testKeyOk = (env) => /^(sk|rk)_test_[A-Za-z0-9]{8,}$/.test(String((env && env.STRIPE_TEST_SECRET_KEY) || ""));
// Stripe-miljö per order: testorder ⇒ ALLTID testnyckel/testläge (checkout, statusavstämning, återbetalning, avläsning); saknas giltig testnyckel ⇒ null = NEKA (även efter att testfönstret gått ut). Aldrig fallback till live.
export const stripeEnvFor = (env, isTest) => (isTest ? (testKeyOk(env) ? testStripeEnv(env) : null) : env);

export function acceptingOrders(env, allowedOrigins) {
  const mode = compareEnabled(env) ? paymentsMode(env) : null;
  if (mode === null) return false;
  if (mode === "live" && consentDraft(env)) return false; // utkasttext (policy Q): ingen skarp betalning
  if (sellerInfo(env).errors.length > 0) return false; // konfigfel i säljaruppgifter (t.ex. förbjudet org.nr för enskild firma) stänger i ALLA lägen
  if (mode === "live" && (!retentionPolicy(env).ok || sellerInfo(env).placeholder)) return false; // retention och säljare måste vara satta
  if (consentPolicy(env) === "P" && !fulfilmentPoint(env).ok) return false; // ogiltig fullgörandepunkt: fail closed
  if (mailerKind(env) === null) return false; // utan transport kan avtalsbekräftelsen (som måste ges före tjänsten) inte levereras
  return budgetConfig(env).ok && returnUrl(env, allowedOrigins) !== null;
}

// Moms ur ett belopp som redan innehåller moms (öre). Kalkylantagande, märks så i kvittot.
export function vatPart(totalOre, pct = OFFER.vatPct) {
  return Math.round((totalOre * pct) / (100 + pct));
}

// ---- D17 Förkontroll av min offert: EN egen offert före utskick. Egen produkt/text/hash men samma pris (4900 öre inkl. moms, serverfryst), samma Stripe/ledger/mejl/24 h. ----
// Policy P krävs (en aktiv deklaration). Produktspecifik villkorstext är härledd ur de fastställda P-villkoren (villkor-p-1) med produktnamn ersatta och ett eget
// tjänstestycke: den är UTKAST tills en människa fastställt den. Live kräver därför COMPARE_CHECK_TERMS_VERIFIED=1 (människoflagga, inte en credential); testläge behöver den inte.
export const CHECK_OFFER = Object.freeze({ version: "erbjudande-fk-1", product: "Förkontroll av min offert", priceOre: 4900, currency: "sek", vatPct: 25, minDocs: 1, maxDocs: 1, retentionHours: 24 });
export const CHECK_TERMS_VERSION = "villkor-fk-1";
// Produktspecifik tjänstetext (slutlig formulering, väntar på mänsklig fastställelse). Människogrinden är EXAKT denna text: COMPARE_CHECK_TERMS_VERIFIED=1 gäller bara
// om COMPARE_CHECK_TERMS_HASH == CHECK_TERMS_TEXT_SHA256 (hash av texten nedan). Ändras texten måste hashen fastställas på nytt; annars förblir villkoren utkast.
export const CHECK_SERVICE_TEXT = [
  "Förkontroll av min offert läser av EN offert som du själv laddar upp (PDF, foto eller text) och visar fynd om pristyp, moms, ROT-underlag, omfattning och tid samt frågor som din kund sannolikt ställer.",
  "I tjänsten ingår också att du själv bekräftar uppgifter, får tilläggstexter att kopiera in i din offert och en PDF-bilaga till din kund som bara innehåller det du bekräftat, med revisionskod och samma uppgifter som texterna. Under 24 timmar efter leverans kan du bekräfta högst 12 gånger och hämta PDF-bilagan högst 12 gånger.",
  "Pris: 49 kr inklusive moms, engångsköp, ingen prenumeration.",
  "Tjänsten bedömer inte kvalitet, om priset är rimligt eller om din kund har rätt till ROT-avdrag. ROT-avdraget är högst 50 000 kr per person och år enligt Skatteverket; fördelning mellan flera kunder, kvarvarande utrymme och skatt kontrolleras inte och inget personligt avdrag anges över taket.",
  "Inga uppgifter läggs till som du inte själv har bekräftat; det som är okänt förblir okänt. Tjänsten ger inget certifikat, ingen stämpel och ingen garanti för offertens innehåll och är inte juridisk rådgivning. Din originaloffert ändras aldrig. Filer och resultat raderas efter 24 timmar.",
].join("\n");
export const CHECK_TERMS_TEXT_SHA256 = "f64282b0a0b4919b1401e895f0e96b775a2e06ee26f20d932efb5ac249529d50"; // sha256 av checkServiceSectionText() (testet i compare_check.test.mjs)
export const checkServiceSectionText = () => [CHECK_SERVICE_TEXT, "Det här ingår:", ...CHECK_COPY.gets.map((t) => `- ${t}`), "Det här ingår inte:", ...CHECK_COPY.getsNot.map((t) => `- ${t}`), "Så går det till:", ...CHECK_COPY.how.map((t) => `- ${t}`)].join("\n");
export const checkTermsVerified = (env) => !!env && env.COMPARE_CHECK_TERMS_VERIFIED === "1" && env.COMPARE_CHECK_TERMS_HASH === CHECK_TERMS_TEXT_SHA256;
export const CHECK_COPY = Object.freeze({
  gets: [
    "Kontroll av EN egen offert före utskick: moms, ROT-underlag, pristyp, omfattning och tid, med hänvisning till var i offerten uppgiften står.",
    "Tydligt markerat det som inte framgår – det betyder inte att det saknas.",
    "Frågor som en kund sannolikt ställer.",
    "När du själv bekräftat uppgifter: färdiga tilläggstexter att klistra in i offerten och en PDF-bilaga till kunden med exakt samma uppgifter.",
    "Begränsad bekräftelse, redigering och export under 24 timmar.",
  ],
  getsNot: [
    "Ingen bedömning av kvalitet, om priset är rimligt eller om din kund får ROT-avdrag.",
    "Inga uppgifter läggs till som du inte bekräftat. Det som är okänt förblir okänt, även garanti.",
    "Ingen prenumeration, inget certifikat och ingen stämpel. Din originaloffert ändras aldrig.",
    "Inte juridisk rådgivning.",
  ],
  how: [
    "Efter betalning startar kontrollen direkt och tar oftast några minuter. Du kan stänga fliken – du får tillbaka resultatet via en länk som visas här.",
    "Offerten skickas till Anthropic (Claude) för avläsning. Inga namn eller offerttexter går till betalleverantören.",
    "Dina filer och resultatet raderas efter 24 timmar, eller direkt när du själv raderar.",
    "Du anger en e-postadress. Kvitto och avtalsbekräftelse med alla villkor skickas dit, med en länk till Ditt köp och hjälp. Adressen används bara för det.",
    "Går något fel och du inte får ditt resultat ska du få pengarna tillbaka.",
  ],
});
export function checkAvailable(env) {
  if (!env || consentPolicy(env) !== "P") return false;
  const m = paymentsMode(env);
  return m === "test" || (m === "live" && checkTermsVerified(env));
}
export function checkConsentTexts(env) {
  const t = consentTexts(env);
  return Object.freeze({ ...t, sameJob: "Jag bekräftar att offerten är min egen och att jag får ladda upp den.", declaration: "Jag vill att förkontrollen börjar direkt och godtar att ångerrätten upphör när tjänsten är helt utförd.", fulfilmentDef: `Tjänsten är helt utförd när jag har fått min förkontroll${fulfilmentPoint(env).point === "fonster_slut" ? ", och tiden på 24 timmar för att spara resultatet har gått ut" : ""}.` });
}
const fkWords = (t) => String(t).replaceAll("din jämförelserapport", "din förkontroll").replaceAll("jämförelserapport", "förkontroll").replaceAll("Jämförelsen", "Förkontrollen").replaceAll("jämförelsen", "förkontrollen").replaceAll("jämförelse", "förkontroll").replaceAll("/jamfor/angra/", "/jamfor/angra/");
export function checkTermsSnapshot(env) {
  const b = termsSnapshotP(env, { reviews: false }); // förkontrollen har aldrig omdömesvisningar: fullgörandetexten får inte bero på jämförelsens omdömesflagga
  const sections = b.sections.map((x) => (x.id === "tjansten"
    ? { id: x.id, title: x.title, text: checkServiceSectionText() }
    : { id: x.id, title: x.title, text: fkWords(x.text) }));
  return { version: CHECK_TERMS_VERSION, draft: !checkTermsVerified(env), seller: b.seller, sections };
}
export function checkConsentSnapshot(env) {
  return {
    consentVersion: consentVersion(env), draft: !checkTermsVerified(env), product: CHECK_OFFER.product,
    offerVersion: CHECK_OFFER.version, priceOre: CHECK_OFFER.priceOre, currency: CHECK_OFFER.currency, vatPct: CHECK_OFFER.vatPct,
    copy: CHECK_COPY, texts: checkConsentTexts(env), dataCoverage: Object.freeze({ reviews: false, text: "Omdömen om företagen ingår inte i förkontrollen." }), terms: checkTermsSnapshot(env),
    policy: "P", fulfilmentPoint: fulfilmentPoint(env).point,
  };
}
