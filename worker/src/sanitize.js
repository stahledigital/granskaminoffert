// Validering av modellens utdata (paket B, GMO-REVISION-20261009-01 D03).
//
// Modellen anropas med ett JSON-schema, men schemat är inte strikt (inget
// `strict: true`) och ingenting efter anropet kontrollerar att svaret faktiskt
// följer det. Allt som kommer ur modellen är därför indata som måste saneras
// innan regelkoden ser det: fel typ, okänd enum, prototypnycklar som
// "constructor", strängar där tal ska vara, orimliga storlekar.
//
// Principer:
//  - Ogiltigt värde blir null (= "saknas"), aldrig ett påhittat värde.
//  - Ogiltig eller saknad moms blir "okant_moms" och ger osäkerhet i reglerna,
//    aldrig ett OK. (Tidigare blev "brutto" till "exklusive moms, konsekvent".)
//  - Varje ogiltigt fält registreras (bara fältnamn, aldrig värdet, eftersom
//    värdet kan innehålla uppgifter ur offerten) så att resultatet kan visa
//    en markerad lucka i stället för att tyst hoppa över kontrollen.

const has = (set, v) => typeof v === "string" && set.has(v);

export const JOB_TYPES = new Set(["badrum", "altan", "fonster", "tak", "malning", "fasad", "kakel", "bergvarme", "luftvarmepump", "elcentral", "kok", "annat"]);
export const TRADES = new Set(["snickare", "elektriker", "vvs", "malare", "plattsattare", "annat"]);
export const PRICE_TYPES = new Set(["fast", "ungefarligt", "lopande"]);
export const CUSTOMER_TYPES = new Set(["privatperson", "foretag"]);
export const VAT_MODES = new Set(["inkl", "exkl", "blandat", "ej_angivet"]);
export const VAT_BASIS = new Set(["inkl", "exkl"]);
export const PROPERTY_TYPES = new Set(["smahus", "bostadsratt", "flerbostadshus", "annat"]);
export const REVIEW_TRADES = new Set(["bygg", "tak", "vvs", "el", "malning", "mark", "okand"]);

// Rimlighetsgränser. Värden utanför är inte "fel offert" utan "kan inte vara
// rätt avläst", och behandlas som saknade.
const LIMITS = {
  sek: 100_000_000,
  hours: 100_000,
  hourlyRateSek: 20_000,
  area: 100_000,
  count: 100_000,
  persons: 20,
  pct: 1000,
};

// Svenska namn för fält som kan hamna i "avläsningen"-luckan.
export const FIELD_LABELS = {
  jobType: "typ av arbete",
  trades: "yrken",
  hourlyRateSek: "timpris",
  hours: "antal timmar",
  laborSumSek: "arbetskostnad",
  materialSumSek: "materialkostnad",
  travelSumSek: "resor",
  materialMarkupPct: "materialpåslag",
  rotAmountSek: "ROT-avdrag",
  rotRatePct: "ROT-sats",
  rotPersons: "antal personer för ROT",
  rotOnMaterialOrTravel: "ROT på material eller resor",
  priceType: "pristyp",
  vatMode: "moms",
  totalSumSek: "totalsumma",
  totalBeforeRotSek: "summa före ROT-avdrag",
  amountToPaySek: "summa att betala",
  totalVatBasis: "momsbas för totalsumman",
  totalIncludesVat: "momsbas för totalsumman",
  quoteDate: "offertdatum",
  plannedPaymentDate: "betalningsdatum",
  customerType: "kundtyp",
  propertyType: "bostadstyp",
  areaM2: "yta",
  unitCount: "antal enheter",
  otherSumSek: "övriga rader",
  extracted: "avläsningen som helhet",
};

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function validDate(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return false;
  if (d.toISOString().slice(0, 10) !== v) return false; // 2026-02-31 avvisas
  const y = d.getUTCFullYear();
  return y >= 2000 && y <= 2100;
}

// Saneras `raw` (det modellen lämnade i `extracted`) till ett objekt med exakt
// de fält regelkoden känner till. Alltid ett nytt objekt: prototypen på `raw`
// påverkar aldrig resultatet.
export function sanitizeExtracted(raw) {
  const issues = [];
  const bad = (field) => { if (!issues.includes(field)) issues.push(field); };
  const src = isPlainObject(raw) ? raw : {};
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) bad("extracted");
  const get = (k) => (Object.prototype.hasOwnProperty.call(src, k) ? src[k] : undefined);

  // Tal: undefined/null = saknas (inget problem). Annat än ändligt tal inom
  // gränserna = ogiltigt (markeras).
  const numField = (k, max, { integer = false } = {}) => {
    const v = get(k);
    if (v === undefined || v === null) return null;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max || (integer && !Number.isInteger(v))) { bad(k); return null; }
    return v;
  };
  const enumField = (k, set) => {
    const v = get(k);
    if (v === undefined || v === null) return null;
    if (!has(set, v)) { bad(k); return null; }
    return v;
  };
  const boolField = (k) => {
    const v = get(k);
    if (v === undefined || v === null) return null;
    if (typeof v !== "boolean") { bad(k); return null; }
    return v;
  };
  const dateField = (k) => {
    const v = get(k);
    if (v === undefined || v === null) return null;
    if (!validDate(v)) { bad(k); return null; }
    return v;
  };
  const textField = (k, max) => {
    const v = get(k);
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") { bad(k); return null; }
    return v.slice(0, max);
  };

  // Moms: saknat eller ogiltigt är aldrig "ej_angivet" (som är ett giltigt svar
  // från modellen: "offerten säger inget"), utan "okant_moms".
  let vatMode = get("vatMode");
  if (!has(VAT_MODES, vatMode)) { bad("vatMode"); vatMode = "okant_moms"; }

  let trades = get("trades");
  if (trades === undefined || trades === null) trades = [];
  else if (!Array.isArray(trades)) { bad("trades"); trades = []; }
  else {
    const ok = [];
    for (const t of trades.slice(0, 12)) {
      if (has(TRADES, t)) { if (!ok.includes(t)) ok.push(t); } else bad("trades");
    }
    trades = ok;
  }

  const x = {
    jobType: enumField("jobType", JOB_TYPES),
    trades,
    hourlyRateSek: numField("hourlyRateSek", LIMITS.hourlyRateSek),
    hours: numField("hours", LIMITS.hours),
    laborSumSek: numField("laborSumSek", LIMITS.sek),
    materialSumSek: numField("materialSumSek", LIMITS.sek),
    travelSumSek: numField("travelSumSek", LIMITS.sek),
    materialMarkupPct: numField("materialMarkupPct", LIMITS.pct),
    rotAmountSek: numField("rotAmountSek", LIMITS.sek),
    rotRatePct: numField("rotRatePct", 100),
    rotPersons: numField("rotPersons", LIMITS.persons, { integer: true }),
    rotOnMaterialOrTravel: boolField("rotOnMaterialOrTravel"),
    priceType: enumField("priceType", PRICE_TYPES),
    vatMode,
    totalSumSek: numField("totalSumSek", LIMITS.sek),
    totalBeforeRotSek: numField("totalBeforeRotSek", LIMITS.sek),
    amountToPaySek: numField("amountToPaySek", LIMITS.sek),
    totalVatBasis: enumField("totalVatBasis", VAT_BASIS),
    totalIncludesVat: boolField("totalIncludesVat"),
    quoteDate: dateField("quoteDate"),
    plannedPaymentDate: dateField("plannedPaymentDate"),
    customerType: enumField("customerType", CUSTOMER_TYPES),
    propertyType: enumField("propertyType", PROPERTY_TYPES),
    workDescription: textField("workDescription", 300),
    county: textField("county", 60),
    areaM2: numField("areaM2", LIMITS.area),
    unitCount: numField("unitCount", LIMITS.count),
    otherSumSek: numField("otherSumSek", LIMITS.sek),
  };
  return { x, issues };
}

// Toppnivån i modellsvaret (fritextlistor som visas för användaren). Skyddar
// frontend och statistik mot fel typ: listor blir listor av {key,text}, text
// blir text.
function textList(v, maxItems, maxLen) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const it of v.slice(0, maxItems)) {
    if (!isPlainObject(it)) continue;
    const key = typeof it.key === "string" ? it.key.slice(0, 120) : "";
    const text = typeof it.text === "string" ? it.text.slice(0, maxLen) : "";
    if (key || text) out.push({ key, text });
  }
  return out;
}

export function sanitizeReview(raw) {
  const r = isPlainObject(raw) ? raw : {};
  const price = isPlainObject(r.price) ? r.price : {};
  const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= LIMITS.sek ? v : null);
  return {
    trade: has(REVIEW_TRADES, r.trade) ? r.trade : "okand",
    contradictions: textList(r.contradictions, 20, 600),
    clarify: textList(r.clarify, 30, 600),
    stated: textList(r.stated, 40, 600),
    calcCoverage: r.calcCoverage === "checked" ? "checked" : "insufficient_data",
    calcNote: typeof r.calcNote === "string" ? r.calcNote.slice(0, 800) : "",
    price: {
      hourlyRateSek: num(price.hourlyRateSek),
      totalSumSek: num(price.totalSumSek),
      rotDeducted: typeof price.rotDeducted === "boolean" ? price.rotDeducted : null,
      comment: typeof price.comment === "string" ? price.comment.slice(0, 800) : "",
    },
    questions: Array.isArray(r.questions) ? r.questions.filter((q) => typeof q === "string").slice(0, 12).map((q) => q.slice(0, 400)) : [],
    extracted: isPlainObject(r.extracted) ? r.extracted : (r.extracted === undefined || r.extracted === null ? null : "ogiltig"),
  };
}
