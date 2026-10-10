// Datakort för omdömen per offert (OFFLINE-modul, AVSTÄNGD i produktion).
//
// Kortet visar per källa: (1) totalbetyg och antal omdömen enligt källan och (2) de senaste
// originalomdömena, åtskilda. Vi räknar inga egna betyg, sorterar inte om, sammanfattar inte med AI,
// visar ingen trend och exporterar inget omdömesinnehåll. Omdömestext går ALDRIG till modell eller PDF.
//
// Aktiveras först när faktisk åtkomst, villkor och budget är verifierade (D04: Google UI Kit/Places
// respektive Trustpilot Data Solutions är separata spår; villkor och kostnad är EJ verifierade här).
// Modulen är ren normalisering + tillståndsmaskin, så gränssnittet kan byggas och provas offline.
//
// Tillstånd: ej_aktiverad | bekrafta_foretag | oklar_identitet | fel | laddad
// (laddad kan ha antal 0 = "inga omdömen", skilt från fel och oklar identitet.)

import { cleanText } from "./compare_util.js";

export const SOURCES = Object.freeze({ google: "Google", trustpilot: "Trustpilot" });
export const MAX_LATEST = 5;
export const LOW_N = 10;
export const NEVER_TO_MODEL = true; // dokumenterad invariant, provas i test

export function datacardsEnabled(env) {
  return !!env && env.COMPARE_DATACARDS === "1" && env.COMPARE_DATACARDS_VERIFIED === "1"; // båda krävs; ingen automatik
}

const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(Date.parse(s));
const star = (v) => (Number.isInteger(v) && v >= 1 && v <= 5 ? v : null);

// `input` är redan hämtat av en (framtida) leverantörsadapter:
//  { source, status: "ok"|"fel"|"oklar"|"kandidater", candidates?: [{ name, place }], match?: {name, place},
//    ratingTotal, ratingCount, orderedBy: "newest"|"annat", reviews: [{ createdAt, rating, text }] }
export function buildSourceCard(input, { enabled = false } = {}) {
  const source = input && SOURCES[input.source] ? input.source : null;
  const base = { source, sourceName: source ? SOURCES[source] : null };
  if (!enabled || !source) return { ...base, state: "ej_aktiverad" };
  if (input.status === "kandidater") {
    const cands = (Array.isArray(input.candidates) ? input.candidates : []).slice(0, 5).map((c) => ({ name: cleanText(c && c.name, 80), place: cleanText(c && c.place, 80) })).filter((c) => c.name);
    return { ...base, state: cands.length ? "bekrafta_foretag" : "oklar_identitet", candidates: cands };
  }
  if (input.status === "oklar") return { ...base, state: "oklar_identitet" };
  if (input.status !== "ok") return { ...base, state: "fel" };
  const count = Number.isInteger(input.ratingCount) && input.ratingCount >= 0 ? input.ratingCount : null;
  const total = typeof input.ratingTotal === "number" && input.ratingTotal >= 1 && input.ratingTotal <= 5 ? Math.round(input.ratingTotal * 10) / 10 : null;
  const card = { ...base, state: "laddad", match: input.match ? { name: cleanText(input.match.name, 80), place: cleanText(input.match.place, 80) } : null, ratingTotal: total, ratingCount: count, latest: [], latestState: "inga", lowN: count !== null && count < LOW_N };
  const rv = Array.isArray(input.reviews) ? input.reviews : [];
  if (count === 0 || (count === null && rv.length === 0)) return { ...card, latestState: "inga_omdomen" };
  // "Senaste" visas bara när källan själv levererat dem sorterade efter nyast. Lokal omsortering av ett
  // urval ger inte de senaste, så annars visas inga "senaste".
  if (input.orderedBy !== "newest") return { ...card, latestState: "ej_senaste_tillgangliga" };
  const clean = rv.filter((r) => r && isDate(r.createdAt) && star(r.rating) !== null).slice(0, MAX_LATEST);
  card.latest = clean.map((r) => ({ date: r.createdAt.slice(0, 10), rating: r.rating, text: cleanText(r.text, 600) }));
  card.latestState = card.latest.length ? "visas" : "inga";
  card.latestNote = "Visas som källan levererar dem (nyast först). Antalet kan vara färre än fem. Datumet är omdömets publiceringsdatum, inte när arbetet utfördes.";
  return card;
}

export function attachSourceCards(report, cardsByOffer) {
  return { ...report, sourceCards: report.offers.map((o) => ({ offerIndex: o.index, state: "ej_aktiverad", ...(cardsByOffer && cardsByOffer[o.index] ? { sources: cardsByOffer[o.index] } : {}) })) };
}

// Källtext som får lämna servern mot modell/PDF: aldrig omdömestext.
export function stripReviewText(report) {
  return JSON.parse(JSON.stringify(report, (k, v) => (k === "latest" && Array.isArray(v) ? v.map(({ date, rating }) => ({ date, rating })) : v)));
}
