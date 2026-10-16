// D19 – mätkontrakt (EN källa för klienthändelser via /event och serverdatapunkter från ordermotorn).
//
// Principer (D19_BESLUT_OCH_ACCEPTANS(_V2).md + CODEX_DON_MEASUREMENT_RECONCILIATION.md):
//  * Fasta, slutna enum. Ingen fritext, ingen URL/query/hash/referrer/UTM, inga id:n, dokument, belopp, filnamn eller persondata.
//  * Klienthändelser får ALLTID prefixet "klient_" och kan därför aldrig förväxlas med serverbekräftade händelser.
//  * Gamla händelser (rapport_klar, export, kontakt_cta) är bakåtkompatibla: samma namn, samma detaljer, samma blobordning.
//  * Serverdatapunkter skrivs först EFTER att respektive beständiga beslut lyckats. Analytics Engine är best-effort:
//    ingen exakt-en-gång-garanti, ingen outbox, ingen ny resurs. Ledger/Stripe är facit för köp och återbetalning.
//  * Ingen ny entry-/mätmetadata lagras på ordern eller i ledgern. Produkt härleds ur orderns befintliga `kind`,
//    test ur orderns befintliga betrodda serverklassning (o.test). Publik klient-QA ger aldrig ett Stripe-testmandat.
//  * Mätfel får aldrig störa kundflödet: allt här sväljer fel.

// ---------------------------------------------------------------- Klientkontrakt

export const PRODUCTS = ["free", "compare", "check"];            // fria granskningen, jämförelsen, förkontrollen
const PRODUCTS_OR_NONE = ["none", ...PRODUCTS];                   // "none" = rotsidan före uppgiftsval (inte gratisavsikt)
const PAID_PRODUCTS = ["compare", "check"];
const ENTRIES = ["root", "jamfor", "forkontroll"];                // vilken sida dokumentet landade på (anonym volym, ingen join)
const METHODS = ["file", "camera", "text", "handoff", "unknown"];
const STAGES = ["input", "config", "submit", "checkout", "result"];
const REASONS_ERR = ["empty", "format", "size", "read", "network", "timeout", "server", "config"];
const MODES = ["new", "resume", "readonly"];

// Fält per ny händelse: [fältnamn, tillåtna värden, obligatoriskt]. Allt som inte står här ignoreras och lagras aldrig.
const V2 = {
  landing:       { entry: [ENTRIES, true], product: [PRODUCTS_OR_NONE, true], mode: [MODES, true] },
  task_change:   { from: [PRODUCTS_OR_NONE, true], to: [PRODUCTS, true] },
  view_return:   { product: [PRODUCTS, true], reason: [["history"], true] },
  input_choose:  { product: [PRODUCTS, true], method: [METHODS, true] },
  input_ready:   { product: [PRODUCTS, true], method: [METHODS, true], demo: ["bool"] },
  inputs_ready:  { product: [["compare"], true] },                // alla 2–4 aktiva underlag klara (dolda tredje/fjärde ingår inte)
  example_view:  { product: [PRODUCTS, true] },
  submit:        { product: [PRODUCTS, true], method: [METHODS, true], demo: ["bool"], seen: ["bool"] },
  client_error:  { product: [PRODUCTS, true], stage: [STAGES, true], reason: [REASONS_ERR, true] },
  result_view:   { product: [PRODUCTS, true], demo: ["bool"], seen: ["bool"] },
  checkout_open: { product: [PAID_PRODUCTS, true] },
};

// Gamla klienthändelser (oförändrade): kort valfri detalj ur fast lista + rollen.
const LEGACY = {
  rapport_klar: [],
  export: ["email", "sms", "copy"],
  kontakt_cta: ["hemsida", "materialraknaren", "epost"],
};

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const role = (p) => (p === "mottagare" || p === "hantverkare" ? p : "okand");

export const CLIENT_EVENT_NAMES = [...Object.keys(LEGACY), ...Object.keys(V2)];

// Blobordning för NYA händelser (alltid 13 positioner; "" där fältet inte hör till händelsen).
// Gamla händelser behåller sina tre blobbar [namn, detalj, roll] oförändrade.
export const CLIENT_V2_BLOBS = ["event", "detail", "role", "product", "entry", "method", "stage", "reason", "mode", "from", "to", "demo", "seen"];

export function normalizeClientEvent(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || body.type !== "client") return null;
  const name = typeof body.event === "string" ? body.event : null;
  if (!name) return null;
  const test = body.test === true;
  if (has(LEGACY, name)) {
    const allowed = LEGACY[name];
    const detail = typeof body.detail === "string" && allowed.includes(body.detail) ? body.detail : "";
    if (allowed.length && !detail) return null;
    return { event: name, detail, role: role(body.role), test };
  }
  if (!has(V2, name)) return null;
  const schema = V2[name];
  const fields = {};
  for (const [key, spec] of Object.entries(schema)) {
    const v = body[key];
    if (spec[0] === "bool") { fields[key] = v === true; continue; }       // saknad/ogiltig flagga = false, aldrig fel
    if (typeof v === "string" && spec[0].includes(v)) fields[key] = v;
    else if (spec[1]) return null;                                       // obligatoriskt enumfält saknas/ogiltigt ⇒ hela händelsen avvisas
    else fields[key] = "";
  }
  if (name === "task_change" && fields.from === fields.to) return null;  // samma uppgift är inget aktivt byte
  return { event: name, detail: "", role: role(body.role), test, fields };
}

// Datapunkt för en normaliserad klienthändelse.
export function clientDatapoint(c, lage) {
  const name = "klient_" + c.event;
  if (!c.fields) return { blobs: [name, c.detail, c.role], indexes: [lage] };
  const f = c.fields;
  return {
    blobs: [name, "", c.role, f.product || "", f.entry || "", f.method || "", f.stage || "", f.reason || "", f.mode || "", f.from || "", f.to || "",
      has(f, "demo") ? (f.demo ? "demo" : "eget") : "", has(f, "seen") ? (f.seen ? "sett_exempel" : "") : ""],
    indexes: [lage],
  };
}

// ---------------------------------------------------------------- Serverkontrakt

// Serverhändelser (utan klientprefix). Produkt härleds ur orderns befintliga kind. Blobs: [namn, produkt, detalj].
export const SERVER_EVENT_NAMES = [
  "order_skapad",            // första lyckade beständiga create (befintlig order återupptas utan ny händelse)
  "underlag_mottaget",       // godkänd manifest-commit i /doc (detalj: ny | ersatt)
  "underlag_kompletta",      // manifestet gick från ofullständigt till fullständigt (detalj: antal underlag)
  "checkout_skapad",         // ny beständigt knuten Stripe-session (detalj: forsta | ny); återanvändning ger ingen händelse
  "betalning_verifierad",    // första verifierade betalningsbeslut, efter atomisk commit av order + ledger (dup/replay ger ingen)
  "leverans_klar",           // första commit som fryser leveransen (inte polling/rapporthämtning/återmontering)
  "order_fel",               // terminalt orderfel (detalj: grov orsak); retry är inget terminalt fel
  "aterbetalning_bekraftad", // återbetalning bekräftad av leverantören (begärd/pending räknas inte)
];

// Grov, sluten felorsak (aldrig rå orsakstext, leverantörsfel eller undantagsmeddelande).
const FEL_ORSAKER = {
  samtycke_saknas: "samtycke", bekraftelse_ej_levererad: "bekraftelse", bekraftelse_motstrider: "bekraftelse",
  for_manga_forsok: "for_manga_forsok", internt: "internt",
  avlasning_misslyckades: "avlasning", avlasning_saknas: "avlasning", okand_anvandning: "avlasning",
  dokument_saknas: "underlag", ingen_budgetkonfig: "konfiguration", ingen_modellnyckel: "konfiguration", okand_modell: "konfiguration",
};
export function felOrsakServer(reason) {
  if (typeof reason !== "string") return "annat";
  if (has(FEL_ORSAKER, reason)) return FEL_ORSAKER[reason];
  if (reason.startsWith("pott:") || reason.startsWith("budget:")) return "budget";
  return "annat";
}

export function orderProdukt(o) {
  return o && o.kind === "check" ? "check" : "compare";
}

// Skriver en serverdatapunkt. Får aldrig kasta eller blockera: mätningen är best-effort.
export function serverEvent(env, name, o, detail = "") {
  try {
    if (!SERVER_EVENT_NAMES.includes(name)) return false;
    const lage = o && o.test ? "test" : "skarp";
    env && env.GRANSKA_H && env.GRANSKA_H.writeDataPoint({ blobs: [name, orderProdukt(o), String(detail || "")], indexes: [lage] });
    return true;
  } catch (e) { return false; }
}
