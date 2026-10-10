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
    "Går något fel och du inte får ditt resultat ska du få pengarna tillbaka. Du anger ingen e-post för detta; kontakta oss med ordernumret.",
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
export const DATA_COVERAGE = Object.freeze({ reviews: false, text: "Omdömen om företagen ingår inte i den här versionen." });

// Det kunden accepterar: pris, produkt, erbjudandetext och samtyckestexter. Hashen bindes till ordern.
export function consentSnapshot() {
  return {
    consentVersion: CONSENT.version, draft: CONSENT.draft,
    offerVersion: OFFER.version, priceOre: OFFER.priceOre, currency: OFFER.currency, vatPct: OFFER.vatPct,
    copy: OFFER_COPY, texts: CONSENT.texts, dataCoverage: DATA_COVERAGE,
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

export function acceptingOrders(env, allowedOrigins) {
  const mode = compareEnabled(env) ? paymentsMode(env) : null;
  if (mode === null) return false;
  if (mode === "live" && CONSENT.draft) return false; // utkasttext: ingen skarp betalning
  return budgetConfig(env).ok && returnUrl(env, allowedOrigins) !== null;
}

// Moms ur ett belopp som redan innehåller moms (öre). Kalkylantagande, märks så i kvittot.
export function vatPart(totalOre, pct = OFFER.vatPct) {
  return Math.round((totalOre * pct) / (100 + pct));
}
