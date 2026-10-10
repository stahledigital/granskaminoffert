// Jämför mina offerter (GMO-LANSERING-20261010-01 D04): produktkonstanter och konfiguration.
//
// PRIS OCH PRODUKT ÄR SERVERÄGDA. Priset står här som kod (4900 öre SEK inklusive moms),
// aldrig som indata från webbläsaren eller som miljövariabel som en kund kan påverka.
// Funktionen är AVSTÄNGD tills COMPARE_ENABLED = "1" OCH betalningsadaptern är uttryckligen
// konfigurerad. Ingen kostnad kan uppstå utan ett av en människa konfigurerat hårt tak.

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
// Saknas fält i testläge används tydligt märkta platshållare; live kräver namn, id-nummer, adress, e-post, TELEFON (informationskrav) och momsreg.nr.
// Id-numret är en ren formatkontroll (organisationsnummer ELLER personnummer-format för enskild firma, 10 eller 12 siffror); AB antas inte.
// Momsreg.nr: SE + 10 siffror + 01 (SE + 12 siffror) gäller både AB och enskild firma. Erbjudandet är 49 kr INKLUSIVE moms; är säljaren inte momsregistrerad
// måste pris-/momstexten beslutas av människa (T4) innan live – koden hittar inte på en momsfri variant.
const clip = (v, n) => String((v == null ? "" : v)).replace(/[\r\n\t]+/g, " ").trim().slice(0, n);
export function sellerInfo(env) {
  const g = (k, n) => clip(env && env[k], n);
  const name = g("COMPARE_SELLER_NAME", 120), orgnr = g("COMPARE_SELLER_ORGNR", 20), email = g("COMPARE_SELLER_EMAIL", 120);
  const address = g("COMPARE_SELLER_ADDRESS", 200), phone = g("COMPARE_SELLER_PHONE", 30), vat = g("COMPARE_SELLER_VAT", 20).replace(/\s+/g, "");
  const ok = {
    name: !!name, orgnr: /^(\d{6}|(19|20)\d{6})-?\d{4}$/.test(orgnr), email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    address: address.length >= 8, vat: /^SE\d{12}$/.test(vat), phone: /^[+0-9][0-9 ()-]{5,29}$/.test(phone),
  };
  const complete = Object.values(ok).every(Boolean);
  const ph = (v, label) => v || `[${label} – fylls i före skarp drift]`;
  return {
    name: ph(name, "Säljare"), orgnr: ph(orgnr, "org.nr"), email: ph(email, "kontakt-e-post"), address: ph(address, "adress"), vat: ph(vat, "momsreg.nr"), phone: ph(phone, "telefon"),
    placeholder: !complete, missing: Object.entries(ok).filter(([, v]) => !v).map(([k]) => k),
  };
}
export function sellerLines(sel) {
  return [`Säljare: ${sel.name}`, `Organisationsnummer: ${sel.orgnr}`, `Momsregistreringsnummer: ${sel.vat}`, `Adress: ${sel.address}`, `E-post: ${sel.email}`, `Telefon: ${sel.phone}`];
}
const krText = (ore) => `${(ore / 100).toFixed(2).replace(".", ",")} kr`;
// Fullständig villkors-/avtalstext (UTKAST) ägd av servern. Den som kunden ser, godkänner (hash) och får i bekräftelsen är EXAKT denna snapshot.
// Ingen slutlig juridisk text: öppna beslut står som [hakparentes]-platshållare och live är stängt (CONSENT.draft) tills människa fastställt dem.
export const TERMS_VERSION = "villkor-utkast-1";
export function termsSnapshot(env) {
  const seller = sellerInfo(env), pol = retentionPolicy(env), copy = offerCopy(env);
  const vatOre = vatPart(OFFER.priceOre, OFFER.vatPct);
  const days = (d, what) => (d === null ? `[lagringstid för ${what} är inte fastställd]` : `${d} dagar`);
  const sections = [
    { id: "saljare", title: "Säljare", text: sellerLines(seller).join("\n") },
    { id: "tjansten", title: "Tjänsten", text: [`${OFFER.product} jämför innehåll i ${OFFER.minDocs}–${OFFER.maxDocs} offerter som du själv laddar upp.`, "Det här ingår:", ...copy.gets.map((t) => `- ${t}`), "Det här ingår inte:", ...copy.getsNot.map((t) => `- ${t}`), "Så går det till:", ...copy.how.map((t) => `- ${t}`)].join("\n") },
    { id: "pris", title: "Pris och betalning", text: `Pris: ${krText(OFFER.priceOre)} inklusive moms (varav moms ${krText(vatOre)}, ${OFFER.vatPct} %). Engångsköp. Betalningen sker hos betalleverantören Stripe; kvittot därifrån är en separat handling.` },
    { id: "avtal", title: "Avtalsbekräftelse", text: "När betalningen är genomförd skickas en avtalsbekräftelse med de här villkoren, det du godkände och en länk för att ångra köpet till den e-postadress du angav." },
    { id: "angerratt", title: "Ångra köpet och start direkt", text: "[UTKAST – hur ångerrätt och start direkt bedöms är inte slutligt fastställt.] Du kan begära att ångra köpet via länken i bekräftelsen, från sidan med ditt resultat eller på /jamfor/angra/. Begäran sparas med tidpunkt. Har jämförelsen inte levererats stoppas den och hela beloppet ska betalas tillbaka. Är rapporten redan levererad prövas begäran manuellt; mottagningsbeviset avgör inte om ångerrätt finns eller inte." },
    { id: "aterbetalning", title: "Om något går fel", text: "Går något fel och du inte får ditt resultat ska du få pengarna tillbaka." },
    { id: "personuppgifter", title: "Personuppgifter och lagring", text: `Offerterna skickas till Anthropic för avläsning. Filer, avläsning och rapport raderas efter ${OFFER.retentionHours} timmar eller direkt när du raderar. Order-, betal- och samtyckespost sparas utan offerttext: avtalspost ${days(pol.avtalDays, "avtalspost")}, bokföringsunderlag ${days(pol.bokforingDays, "bokföringsunderlag")}. Betaluppgifter hanteras av Stripe och lagras inte av oss.` },
    { id: "kontakt", title: "Kontakt och klagomål", text: `Kontakta ${seller.email} om du har frågor, klagomål eller vill ha hjälp med återbetalning. [Information om tvistlösning fastställs av det kommersiella spåret.]` },
  ];
  return { version: TERMS_VERSION, draft: true, seller, sections };
}
export function termsPlain(t) { return t.sections.map((x) => `${x.title}\n${x.text}`).join("\n\n"); }
export const DATA_COVERAGE = Object.freeze({ reviews: false, text: "Omdömen om företagen ingår inte i den här versionen." });
// D07: källvisning av omdömen (Google/Trustpilot) är en SEPARAT, avstängd funktion. Aktiv bara när en människa satt BÅDA flaggorna
// (COMPARE_REVIEWS=1 och COMPARE_REVIEWS_VERIFIED=1 = villkor/licens/kostnad verifierade). Texten som kunden godkänner följer läget,
// så kunden aldrig lovas något som inte är påslaget. Aldrig i rapport, export, mejl eller modell.
export const reviewsActive = (env) => !!env && env.COMPARE_REVIEWS === "1" && env.COMPARE_REVIEWS_VERIFIED === "1";
const REVIEWS_ON_GETSNOT = "Omdömen om företagen räknas inte in i jämförelsen och står inte i rapporten eller mejlen. Där en källa är tillgänglig för just din firma visas Googles och Trustpilots egna omdömen separat, med källans eget urval och datum. Vi ger inget eget betyg, ingen rangordning och ingen bedömning av företaget, och vi lovar inte att en källa finns eller har omdömen för varje firma (se täckningen innan du betalar).";
export function offerCopy(env) {
  if (!reviewsActive(env)) return OFFER_COPY;
  return Object.freeze({ ...OFFER_COPY, getsNot: OFFER_COPY.getsNot.map((t) => (/^Inga omdömen om företagen/.test(t) ? REVIEWS_ON_GETSNOT : t)) });
}
export function dataCoverage(env) {
  if (!reviewsActive(env)) return DATA_COVERAGE;
  return Object.freeze({ reviews: true, text: "Omdömen visas separat per firma när källan är tillgänglig för firman. Täckningen för dina firmor visas innan du betalar. Omdömen ingår inte i jämförelsen, rapporten eller mejl." });
}

// Det kunden accepterar: pris, produkt, erbjudandetext och samtyckestexter. Hashen bindes till ordern.
export function consentSnapshot(env) {
  return {
    consentVersion: CONSENT.version, draft: CONSENT.draft,
    offerVersion: OFFER.version, priceOre: OFFER.priceOre, currency: OFFER.currency, vatPct: OFFER.vatPct,
    copy: offerCopy(env), texts: CONSENT.texts, dataCoverage: dataCoverage(env), terms: termsSnapshot(env),
  };
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

// Hårda tak (µUSD) måste sättas av en människa. Saknas något returneras ok:false och INGEN
// generation görs. Det finns ingen standardsumma.
export function budgetConfig(env) {
  const month = intOrNaN(env && env.COMPARE_MONTH_CAP_MICRO);
  const paid = intOrNaN(env && env.COMPARE_PAID_CAP_MICRO);
  const free = intOrNaN(env && env.COMPARE_FREE_CAP_MICRO);
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
export function mailerKind(env) {
  if (env && env.COMPARE_MAILER && typeof env.COMPARE_MAILER.send === "function") return "adapter";
  if (env && env.COMPARE_MAILER_MODE === "mock" && env.COMPARE_PAYMENTS !== "live") return "mock";
  return null;
}
export function acceptingOrders(env, allowedOrigins) {
  const mode = compareEnabled(env) ? paymentsMode(env) : null;
  if (mode === null) return false;
  if (mode === "live" && CONSENT.draft) return false; // utkasttext: ingen skarp betalning
  if (mode === "live" && (!retentionPolicy(env).ok || sellerInfo(env).placeholder)) return false; // retention och säljare måste vara satta
  if (mailerKind(env) === null) return false; // utan transport kan avtalsbekräftelsen (som måste ges före tjänsten) inte levereras
  return budgetConfig(env).ok && returnUrl(env, allowedOrigins) !== null;
}

// Moms ur ett belopp som redan innehåller moms (öre). Kalkylantagande, märks så i kvittot.
export function vatPart(totalOre, pct = OFFER.vatPct) {
  return Math.round((totalOre * pct) / (100 + pct));
}
