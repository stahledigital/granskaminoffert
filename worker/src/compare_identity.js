// D11: utställarens (hantverkarföretagets) identitet ur offertdokumentet, separat från pris-/arbetsfält.
//
// Principer (spec D11):
//  * Bara det dokumentet UTTRYCKLIGEN anger för företaget som ger offerten (utförare) – inte kunden, underleverantörer eller
//    betalningsförmedlare. Varje uppgift har status: framgar | framgar_inte | ej_lasbar. Saknat = null. Belägg (sida/rad) krävs
//    för "framgar"; annars nedgraderas till framgar_inte.
//  * Avläsningsfel (ej_lasbar) är något annat än verifierat saknad uppgift och räknas aldrig som "saknas".
//  * Organisationsnummer: kontrollsiffran (Luhn) visar bara att numret är formellt giltigt – inte att företaget är registrerat eller äkta.
//    Nummer vars tredje siffra är 0/1 är personnummerliknande (enskild firma) = personidentifierande: lagras bara i rapporten till
//    kunden och går ALDRIG vidare till recensionskällor.
//  * Avsaknad av webbplats, Googleprofil eller omdömen är INTE en saknad väsentlig offertuppgift. Väsentligt = företagsnamn,
//    organisationsnummer och kontakt-/adressuppgift (adress eller telefon).
//  * Ingen bedömning av rykte, kreditvärdighet eller bedrägeri. Markeringen gäller bara dokumentets identifierbarhet.
//  * Originaluppgiften (identity.original) ändras aldrig av senare komplettering (kundens bekräftelse eller extern källa visas separat).

import { cleanText } from "./compare_util.js";
import { normName, normDomain } from "./compare_sources.js";

export const ID_FIELDS = Object.freeze(["name", "orgnr", "address", "city", "phone", "web"]);
export const ID_STATUS = Object.freeze(["framgar", "framgar_inte", "ej_lasbar"]);
export const ESSENTIAL = Object.freeze([
  { id: "name", label: "Företagsnamn" },
  { id: "orgnr", label: "Organisationsnummer" },
  { id: "kontakt", label: "Adress eller telefon" },
]);

const FIELD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "value", "page", "ref"],
  properties: {
    status: { type: "string", enum: ID_STATUS, description: "framgar = uppgiften står uttryckligen för utställaren; framgar_inte = står inte i dokumentet; ej_lasbar = uppgiften verkar finnas men går inte att läsa säkert (dålig bild/skadad text)." },
    value: { type: ["string", "null"], description: "Uppgiften exakt som skriven. null om den inte framgår eller inte går att läsa." },
    page: { type: ["integer", "null"] },
    ref: { type: ["string", "null"], description: "Var i dokumentet (t.ex. 'sidfot', 'brevhuvud rad 2'). Krävs när status är framgar." },
  },
};
export const ISSUER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "orgnr", "address", "city", "phone", "web", "role", "legalForm"],
  description: "Uppgifter om FÖRETAGET SOM GER OFFERTEN (den som ska utföra arbetet). Inte kundens uppgifter, inte underleverantörer och inte betalningsförmedlare (bank, Swish, faktureringsbolag).",
  properties: {
    name: FIELD_SCHEMA, orgnr: FIELD_SCHEMA, address: FIELD_SCHEMA, city: FIELD_SCHEMA, phone: FIELD_SCHEMA, web: FIELD_SCHEMA,
    role: { type: "string", enum: ["utforare", "osaker"], description: "utforare = dokumentet visar tydligt att namnet är företaget som ger offerten; osaker = oklart om namnet är utföraren, kunden, en underleverantör eller en betalningsförmedlare." },
    legalForm: { type: "string", enum: ["bolag", "enskild", "okand"], description: "bolag = aktiebolag/handelsbolag/kommanditbolag/ekonomisk förening; enskild = enskild firma; okand = framgår inte." },
  },
};

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const pageOf = (v) => (Number.isInteger(v) && v >= 1 && v <= 500 ? v : null);

// Luhn över de tio siffrorna (samma kontrollsiffra som för personnummer och organisationsnummer).
export function luhnOk(ten) {
  if (!/^\d{10}$/.test(ten)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) { let d = Number(ten[i]); if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; } sum += d; }
  return sum % 10 === 0;
}
export function orgnrDigits(v) {
  const s = String(v || "").replace(/[\s ]/g, "");
  const m = s.match(/^(?:(?:16)?)(\d{6})[-–]?(\d{4})$/);
  return m ? m[1] + m[2] : null;
}
// Personnummerliknande: organisationsnummer för juridiska personer har tredje siffran >= 2.
export const isPersonalOrgnr = (ten) => /^\d{10}$/.test(ten) && Number(ten[2]) < 2;

function cleanField(raw, kind) {
  const r = isObj(raw) ? raw : {};
  let status = ID_STATUS.includes(r.status) ? r.status : "ej_lasbar"; // ett oläsligt/oväntat svar är "kunde inte avläsas", inte "saknas"
  const page = pageOf(r.page), ref = cleanText(typeof r.ref === "string" ? r.ref : "", 80);
  let value = null, note = null, checkDigitOk = null;
  if (status === "framgar") {
    const rawV = typeof r.value === "string" ? r.value : "";
    if (kind === "orgnr") {
      const t = orgnrDigits(rawV);
      if (!t) { status = "ej_lasbar"; note = "format"; } else { value = t.slice(0, 6) + "-" + t.slice(6); checkDigitOk = luhnOk(t); if (!checkDigitOk) { status = "ej_lasbar"; note = "kontrollsiffra"; } }
    } else if (kind === "web") {
      const d = normDomain(rawV);
      if (!d) { status = "ej_lasbar"; note = "format"; } else value = d;
    } else if (kind === "phone") {
      const digits = rawV.replace(/\D/g, "");
      if (digits.length < 7 || digits.length > 15) { status = "ej_lasbar"; note = "format"; } else value = cleanText(rawV, 30);
    } else {
      value = cleanText(rawV, kind === "address" ? 120 : 80);
      if (!value) status = "framgar_inte";
    }
    if (status === "framgar" && !ref && page === null) { status = "framgar_inte"; value = null; note = "utan_belagg"; } // uttryckligt besked kräver belägg
  }
  const ok = status === "framgar";
  return { status, value: ok ? value : null, page: ok ? page : null, ref: ok ? ref : "", ...(checkDigitOk === null ? {} : { checkDigitOk }), ...(note ? { note } : {}) };
}

// Hela identiteten. `readability` används bara för att skilja "kunde inte avläsas" från "saknas": en mycket svårläst fil kan inte visa att något saknas.
export function sanitizeIssuer(raw, readability) {
  if (!isObj(raw)) return null; // äldre/avvikande avläsning: ingen identitetsuppgift (inget påstående)
  const fields = {};
  for (const id of ID_FIELDS) fields[id] = cleanField(raw[id], id);
  const od = fields.orgnr.status === "framgar" ? orgnrDigits(fields.orgnr.value) : null;
  const personal = !!od && isPersonalOrgnr(od);
  let legalForm = ["bolag", "enskild", "okand"].includes(raw.legalForm) ? raw.legalForm : "okand";
  if (personal) legalForm = "enskild";
  const role = raw.role === "utforare" ? "utforare" : "osaker";
  // Väsentliga uppgifter: namn, organisationsnummer, adress/telefon.
  const kontakt = (() => {
    const a = fields.address, p = fields.phone;
    if (a.status === "framgar" || p.status === "framgar") return "framgar";
    if (a.status === "ej_lasbar" || p.status === "ej_lasbar") return "ej_lasbar";
    return "framgar_inte";
  })();
  const ess = { name: fields.name.status, orgnr: fields.orgnr.status, kontakt };
  const missing = ESSENTIAL.filter((e) => ess[e.id] === "framgar_inte").map((e) => e.id);
  const unreadable = ESSENTIAL.filter((e) => ess[e.id] === "ej_lasbar").map((e) => e.id);
  let state;
  if (unreadable.length || (readability === "svar" && missing.length)) state = "ej_avlast"; // kunde inte avläsas säkert: inte verifierat saknad
  else if (missing.length) state = "saknas";
  else state = "komplett";
  const original = { ...fields };
  return {
    original, fields, essential: ess, missing, unreadable, state, role, legalForm, personal,
    sendable: state === "komplett" && role === "utforare" && !personal && legalForm !== "enskild" && fields.name.status === "framgar", // får bli automatiskt källförslag (kund kan alltid ändra/bekräfta)
    matchKey: fields.orgnr.status === "framgar" ? "o:" + fields.orgnr.value : (fields.name.status === "framgar" ? "n:" + normName(fields.name.value) : null),
  };
}

// Samma juridiska person = samma organisationsnummer. Samma namn med olika nummer (filial/koncernbolag/liknamn) slås ALDRIG ihop.
export function identityGroups(identities) {
  const groups = new Map(), conflicts = [];
  identities.forEach((id, i) => {
    if (!id || !id.matchKey) return;
    if (!groups.has(id.matchKey)) groups.set(id.matchKey, []);
    groups.get(id.matchKey).push(i);
  });
  const links = [...groups.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => ({ offers: v, basis: k.startsWith("o:") ? "orgnr" : "namn" }));
  for (let i = 0; i < identities.length; i++) for (let j = i + 1; j < identities.length; j++) {
    const a = identities[i], b = identities[j];
    if (!a || !b || a.fields.name.status !== "framgar" || b.fields.name.status !== "framgar") continue;
    const sameName = normName(a.fields.name.value) === normName(b.fields.name.value);
    const bothNr = a.fields.orgnr.status === "framgar" && b.fields.orgnr.status === "framgar";
    if (sameName && bothNr && a.fields.orgnr.value !== b.fields.orgnr.value) conflicts.push({ offers: [i, j], reason: "samma_namn_olika_orgnr" });
    else if (!sameName && bothNr && a.fields.orgnr.value === b.fields.orgnr.value) conflicts.push({ offers: [i, j], reason: "samma_orgnr_olika_namn" });
  }
  return { links, conflicts };
}

// Fast jämförelseuppsättning för "uppgifter att reda ut": samma för alla offerter i jämförelsen. Poster som beror på jobbtyp (rivning,
// skydd, städning, tillstånd, giltighet, ROT-hantering) ingår inte (det går inte att avgöra tillämplighet säkert) och räknas därför aldrig som saknade.
export const OPEN_SCOPE_IDS = Object.freeze(["material", "arbete", "resor", "bortforsling", "startdatum", "tidplan", "betalningsplan", "ata", "garanti", "forsakring", "fskatt"]);
export function openItems(offer, scopeLabels) {
  const items = [], unreadable = [];
  const readable = offer.readability !== "svar";
  for (const id of OPEN_SCOPE_IDS) if (offer.scope[id] && offer.scope[id].status === "framgar_inte") items.push({ id: "scope:" + id, label: scopeLabels[id] || id, kind: "omfattning" });
  const p = offer.price;
  if (p.totalBeforeRot === null && p.totalUnmarked === null && p.amountToPay === null) items.push({ id: "price:total", label: "Totalbelopp", kind: "pris" });
  if (p.totalBeforeRot !== null && !p.vatBasis) items.push({ id: "price:momsbas", label: "Moms inkl/exkl", kind: "pris" });
  if (p.totalBeforeRot === null && p.totalUnmarked !== null) items.push({ id: "price:rotbas", label: "Före eller efter ROT", kind: "pris" });
  if (!p.priceType) items.push({ id: "price:typ", label: "Pristyp", kind: "pris" });
  const idn = offer.identity;
  if (idn) {
    for (const e of ESSENTIAL) {
      if (idn.missing.includes(e.id)) items.push({ id: "ident:" + e.id, label: e.label, kind: "foretag" });
      else if (idn.unreadable.includes(e.id)) unreadable.push({ id: "ident:" + e.id, label: e.label, kind: "foretag" });
    }
  }
  // Mycket svårläst fil kan inte visa vad som saknas: antalet är då inte bedömbart (aldrig 0 eller sämst).
  return { assessable: readable, count: readable ? items.length : null, items: readable ? items : [], unreadable, partlyUncertain: offer.readability === "osaker" };
}
