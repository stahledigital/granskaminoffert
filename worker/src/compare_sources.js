// D07 – källor för "senaste originalomdömen" (Google Places UI Kit i webbläsaren, Trustpilot Data Solutions via server).
// ALLT här är avstängt som standard och gör inga externa anrop utan konfiguration, åtkomst och räknarbudget.
//
// Principer (spec D07):
//  * Företagsidentitet byggs ENBART av firmans namn/ort/webbdomän som kunden själv anger – aldrig kundens adress, namn,
//    offerttext eller e-post. Inget lämnar servern mot en källa utom firmans namn+ort (Google-sökning) respektive domän/ID.
//  * Ingen första-träff-automatik: kandidater visas, kunden bekräftar rätt firma/plats. Samma firma i flera offerter = en panel;
//    olika orter/filialer och liknamnade firmor hålls isär.
//  * Providerstatus är separat och ärlig: källfel/ingen åtkomst är ALDRIG "inga omdömen".
//  * Google: inget omdömesinnehåll passerar eller lagras hos oss (Googles egna element renderar i webbläsaren). Vi lagrar bara
//    PlaceID (får lagras) + kundens bekräftelse. Trustpilot: serveradapter, cache högst 24 h, original oförändrat.
//  * Ingen egen poäng/snitt/trend/AI/sammanslagning; omdömestext går aldrig till modell, rapport, mejl, ledger eller export.
//  * Kostnad: inga anrop utan människosatta dygnstak (annars "kostnadsstopp"); per-order-gränser; dedup per firma.
//    En domän-/API-nyckelrestriktion hos Google är INTE ett hårt USD-tak (se COMPARE.md).

import { sha256Hex, cleanText } from "./compare_util.js";
import { reviewsActive } from "./compare_config.js";
import { countToday } from "./compare_budget.js";

export const STATUS = Object.freeze({
  OFF: "ej_aktiverad", WAIT: "vantar_foretagsval", AMBIG: "tvetydig", LOADING: "laddar",
  OK: "tillganglig", EMPTY: "verifierat_tomt", ERROR: "kallfel", COST: "kostnadsstopp",
});
export const LIM = Object.freeze({ maxFirms: 4, searchesPerFirm: 2, providerRequestsPerOrder: 8, viewsPerOrder: 120, maxCandidates: 5, tpCacheMs: 24 * 3600_000, fetchTimeoutMs: 8000 });
export const SOURCE_NAMES = Object.freeze({ google: "Google", trustpilot: "Trustpilot" });

// ---------- konfiguration ----------
const dayCap = (v) => { const n = Number(v); return typeof v === "string" && /^[1-9][0-9]{0,6}$/.test(v) && n >= 1 ? n : null; };
const httpsBase = (v) => { try { const u = new URL(String(v || "")); return u.protocol === "https:" && !u.search && !u.hash ? u.origin + u.pathname.replace(/\/$/, "") : null; } catch { return null; } };
export const MAPS_KEY_RE = /^[A-Za-z0-9_-]{30,60}$/;
export function sourcesConfig(env) {
  const active = reviewsActive(env);
  const gKey = env && typeof env.GOOGLE_MAPS_BROWSER_KEY === "string" && MAPS_KEY_RE.test(env.GOOGLE_MAPS_BROWSER_KEY) ? env.GOOGLE_MAPS_BROWSER_KEY : null;
  const googleOn = active && env.GOOGLE_UI_KIT === "1" && !!gKey;
  const searchOn = googleOn && env.GOOGLE_CANDIDATES === "1" && typeof env.GOOGLE_PLACES_SERVER_KEY === "string" && env.GOOGLE_PLACES_SERVER_KEY.length >= 20;
  const tpBase = httpsBase(env && env.TRUSTPILOT_API_BASE);
  const tpOn = active && env.TRUSTPILOT_DISPLAY === "1" && !!tpBase && typeof env.TRUSTPILOT_API_KEY === "string" && env.TRUSTPILOT_API_KEY.length >= 8 && typeof env.TRUSTPILOT_AUTH_HEADER === "string" && /^[A-Za-z][A-Za-z0-9-]{1,40}$/.test(env.TRUSTPILOT_AUTH_HEADER);
  return {
    active,
    google: { on: googleOn, mapsKey: googleOn ? gKey : null, search: searchOn, searchDayCap: dayCap(env && env.COMPARE_SOURCES_SEARCH_DAY_CAP) },
    trustpilot: { on: tpOn, base: tpBase, fetchDayCap: dayCap(env && env.COMPARE_TP_DAY_CAP), cacheMs: Math.min(LIM.tpCacheMs, dayCap(env && env.COMPARE_TP_CACHE_MIN) ? dayCap(env.COMPARE_TP_CACHE_MIN) * 60_000 : LIM.tpCacheMs) },
  };
}
export function publicSourcesConfig(env) {
  const c = sourcesConfig(env);
  return {
    active: c.active,
    google: { state: c.google.on ? "paslagen" : STATUS.OFF, mapsKey: c.google.mapsKey, search: c.google.search },
    trustpilot: { state: c.trustpilot.on ? "paslagen" : STATUS.OFF },
  };
}

// ---------- firmaidentitet ----------
const LEGAL = /\b(aktiebolag|aktiebolaget|handelsbolag|kommanditbolag|enskild firma|ab|hb|kb|ef|ltd|oy|as|i sverige)\b/g;
const strip = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
export function normName(s) { return strip(s).replace(/&/g, " och ").replace(/[^a-z0-9 ]+/g, " ").replace(LEGAL, " ").replace(/\s+/g, " ").trim(); }
export function normCity(s) { return strip(s).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim(); }
export function normDomain(s) {
  let v = String(s || "").trim().toLowerCase();
  if (!v) return "";
  v = v.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0].replace(/:\d+$/, "");
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,24}$/.test(v) && v.length <= 80 ? v : null;
}
export async function firmIdentity(f) {
  const name = cleanText(f && f.name, 80), city = cleanText(f && f.city, 50);
  const dom = f && f.domain ? normDomain(f.domain) : "";
  if (!name || normName(name).length < 2) return null;
  if (dom === null) return { error: "domain" };
  const key = normName(name) + "|" + normCity(city);
  return { id: "f_" + (await sha256Hex(key)).slice(0, 12), name, city, domain: dom, key };
}
// Per offert (index) → paneler: samma firma i flera offerter ger EN panel; filialer/liknamnade hålls isär.
export async function buildFirms(inputs) {
  const list = Array.isArray(inputs) ? inputs.slice(0, 8) : [];
  const byId = new Map();
  for (const f of list) {
    const idx = Number.isInteger(f && f.offerIndex) && f.offerIndex >= 0 && f.offerIndex <= 3 ? f.offerIndex : null;
    if (idx === null) return { error: "index" };
    const id = await firmIdentity(f);
    if (!id) continue; // namnlös offert: ingen källpanel (inget gissas)
    if (id.error) return { error: id.error };
    const cur = byId.get(id.id);
    if (cur) { if (!cur.offers.includes(idx)) cur.offers.push(idx); if (!cur.domain && id.domain) cur.domain = id.domain; }
    else byId.set(id.id, { ...id, offers: [idx] });
  }
  if (byId.size > LIM.maxFirms) return { error: "for_manga" };
  return { firms: [...byId.values()] };
}
const freshFirm = (f) => ({ id: f.id, name: f.name, city: f.city, domain: f.domain, offers: f.offers, google: { candidateIds: [], searches: 0, searchOutcome: null, placeId: null, confirmedAt: null, via: null }, trustpilot: { candidateIds: [], searches: 0, searchOutcome: null, buId: null, confirmedAt: null } });
export const emptySources = () => ({ firms: [], providerRequests: 0, views: 0 });

// ---------- tillståndsmaskin per firma/källa ----------
export function providerState(cfg, firm, provider) {
  if (!cfg.active) return STATUS.OFF;
  const p = firm[provider];
  if (provider === "google") {
    if (!cfg.google.on) return STATUS.OFF;
    if (p.placeId) return STATUS.OK;
    if (p.searchOutcome === "kostnadsstopp") return STATUS.COST;
    if (p.searchOutcome === "fel") return STATUS.ERROR;
    if (p.searchOutcome === "tomt") return STATUS.EMPTY;
    if (p.searchOutcome === "flera") return STATUS.AMBIG;
    return STATUS.WAIT;
  }
  if (!cfg.trustpilot.on) return STATUS.OFF;
  if (p.buId) return p.lastOutcome === "tomt" ? STATUS.EMPTY : p.lastOutcome === "fel" ? STATUS.ERROR : p.lastOutcome === "kostnadsstopp" ? STATUS.COST : STATUS.OK;
  if (p.searchOutcome === "kostnadsstopp") return STATUS.COST;
  if (p.searchOutcome === "fel") return STATUS.ERROR;
  if (p.searchOutcome === "tomt") return STATUS.EMPTY;
  if (p.searchOutcome === "flera") return STATUS.AMBIG;
  return STATUS.WAIT;
}
const STATE_TEXT = {
  ej_aktiverad: "visas inte i den här versionen", vantar_foretagsval: "väntar på att du bekräftar rätt firma",
  tvetydig: "flera träffar – välj rätt firma", laddar: "laddar", tillganglig: "kan visas",
  verifierat_tomt: "ingen träff / inga omdömen hos källan", kallfel: "källan svarade inte (det betyder inte att omdömen saknas)", kostnadsstopp: "stoppad av kostnadsskäl (det betyder inte att omdömen saknas)",
};
export const stateText = (s) => STATE_TEXT[s] || "okänt";

export function sourcesView(cfg, st) {
  const firms = (st.firms || []).map((f) => ({
    id: f.id, name: f.name, city: f.city, domain: f.domain, offers: f.offers,
    google: { state: providerState(cfg, f, "google"), text: stateText(providerState(cfg, f, "google")), placeId: f.google.placeId || null, confirmed: !!f.google.placeId, searchesLeft: Math.max(0, LIM.searchesPerFirm - f.google.searches) },
    trustpilot: { state: providerState(cfg, f, "trustpilot"), text: stateText(providerState(cfg, f, "trustpilot")), confirmed: !!f.trustpilot.buId, searchesLeft: Math.max(0, LIM.searchesPerFirm - f.trustpilot.searches) },
  }));
  return { active: cfg.active, firms, coverage: coverageSummary(cfg, firms) };
}
// Täckning före köp: vilka firmor/källor som faktiskt kan visas. Ingen omdömesdata, bara lägen.
export function coverageSummary(cfg, viewFirms) {
  const firms = viewFirms || [];
  const count = (prov, st) => firms.filter((f) => f[prov].state === st).length;
  const lines = [];
  if (!cfg.active) return { active: false, firms: firms.length, lines: ["Omdömen visas inte i den här versionen."], google: {}, trustpilot: {} };
  for (const f of firms) {
    const where = f.city ? `${f.name} (${f.city})` : f.name;
    lines.push(`${where}: Google – ${f.google.text}; Trustpilot – ${f.trustpilot.text}.`);
  }
  if (!firms.length) lines.push("Ange firmans namn (och gärna ort och webbplats) för att se vilka källor som kan visas.");
  const tally = (prov) => Object.fromEntries(Object.values(STATUS).map((s) => [s, count(prov, s)]).filter(([, n]) => n > 0));
  return { active: true, firms: firms.length, lines, google: tally("google"), trustpilot: tally("trustpilot") };
}

// ---------- tillståndsändringar (rena; DO sparar) ----------
export async function applyOp(cfg, st, op) {
  const s = { ...emptySources(), ...st, firms: (st.firms || []).map((f) => JSON.parse(JSON.stringify(f))) };
  if (op.type === "set_firms") {
    const r = await buildFirms(op.firms);
    if (r.error) return { error: r.error };
    const keep = new Map(s.firms.map((f) => [f.id, f]));
    s.firms = r.firms.map((f) => { const old = keep.get(f.id); return old ? { ...old, name: f.name, city: f.city, domain: f.domain || old.domain, offers: f.offers } : freshFirm(f); });
    return { state: s };
  }
  const f = s.firms.find((x) => x.id === op.firmId);
  if (!f) return { error: "firma" };
  if (op.type === "record_search") {
    const p = f[op.provider];
    if (!p) return { error: "källa" };
    p.searches += 1; p.searchOutcome = op.outcome; p.candidateIds = (op.candidateIds || []).slice(0, LIM.maxCandidates);
    s.providerRequests += 1;
    return { state: s };
  }
  if (op.type === "confirm_google") {
    const g = f.google;
    if (op.via === "candidate") { if (!g.candidateIds.includes(op.placeId)) return { error: "okand_traff" }; }
    else if (op.via === "manual") { if (op.seen !== true) return { error: "bekrafta_profil" }; }
    else return { error: "via" };
    g.placeId = op.placeId; g.via = op.via; g.confirmedAt = op.now; g.searchOutcome = "bekraftad";
    return { state: s };
  }
  if (op.type === "confirm_trustpilot") {
    const t = f.trustpilot;
    if (!t.candidateIds.includes(op.buId)) return { error: "okand_traff" };
    t.buId = op.buId; t.confirmedAt = op.now; t.searchOutcome = "bekraftad"; t.lastOutcome = null;
    return { state: s };
  }
  if (op.type === "tp_outcome") { f.trustpilot.lastOutcome = op.outcome; return { state: s }; }
  if (op.type === "unconfirm") { if (f[op.provider]) { const p = f[op.provider]; p.searchOutcome = null; p.candidateIds = []; if (op.provider === "google") { p.placeId = null; p.via = null; } else { p.buId = null; p.lastOutcome = null; } p.confirmedAt = null; } return { state: s }; }
  return { error: "op" };
}

// ---------- Google: kandidatsökning (server) ----------
export const PLACE_ID_RE = /^[A-Za-z0-9_-]{20,200}$/;
export async function googleCandidates(env, cfg, firm, { orderId, now = new Date() } = {}) {
  if (!cfg.google.search) return { outcome: "fel", candidates: [] };
  if (!cfg.google.searchDayCap) return { outcome: "kostnadsstopp", candidates: [] };
  const c = await countToday(env, { name: "gsearch", limit: cfg.google.searchDayCap, now });
  if (!c.ok) return { outcome: "kostnadsstopp", candidates: [] };
  // Enda uppgifterna som lämnar oss: firmans namn och ort (som kunden angav). Aldrig offerttext, adress, kundnamn eller e-post.
  const textQuery = [firm.name, firm.city].filter(Boolean).join(" ");
  try {
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), LIM.fetchTimeoutMs);
    let r;
    try {
      r = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST", signal: ac.signal,
        headers: { "content-type": "application/json", "x-goog-api-key": env.GOOGLE_PLACES_SERVER_KEY, "x-goog-fieldmask": "places.id,places.displayName,places.formattedAddress" },
        body: JSON.stringify({ textQuery, languageCode: "sv", regionCode: "SE", pageSize: LIM.maxCandidates }),
      });
    } finally { clearTimeout(to); }
    if (!r.ok) return { outcome: "fel", candidates: [] };
    const j = await r.json();
    const list = (Array.isArray(j && j.places) ? j.places : []).filter((p) => p && PLACE_ID_RE.test(String(p.id || ""))).slice(0, LIM.maxCandidates)
      .map((p) => ({ id: p.id, name: cleanText(p.displayName && p.displayName.text, 100), address: cleanText(p.formattedAddress, 140) })).filter((p) => p.name);
    return { outcome: list.length === 0 ? "tomt" : "flera", candidates: list }; // även 1 träff kräver kundens bekräftelse
  } catch { return { outcome: "fel", candidates: [] }; }
}

// ---------- Trustpilot ----------
const TP_ID_RE = /^[A-Za-z0-9]{8,40}$/;
const tpFetch = async (env, cfg, path) => {
  const ac = new AbortController(); const to = setTimeout(() => ac.abort(), LIM.fetchTimeoutMs);
  try {
    return await fetch(cfg.trustpilot.base + path, { method: "GET", signal: ac.signal, headers: { accept: "application/json", [env.TRUSTPILOT_AUTH_HEADER.toLowerCase()]: env.TRUSTPILOT_API_KEY } });
  } finally { clearTimeout(to); }
};
// Leverantörens exakta endpoint/fältnamn för företagssökning är UNKNOWN tills åtkomst finns: parsern är tolerant och provas bara mot syntetiska fixturer.
export async function tpCandidates(env, cfg, firm, { now = new Date() } = {}) {
  if (!cfg.trustpilot.on) return { outcome: "fel", candidates: [] };
  if (!firm.domain) return { outcome: "tomt", candidates: [], needDomain: true };
  if (!cfg.trustpilot.fetchDayCap) return { outcome: "kostnadsstopp", candidates: [] };
  const c = await countToday(env, { name: "tpfind", limit: cfg.trustpilot.fetchDayCap, now });
  if (!c.ok) return { outcome: "kostnadsstopp", candidates: [] };
  try {
    const r = await tpFetch(env, cfg, `/v1/business-units/find?name=${encodeURIComponent(firm.domain)}`);
    if (r.status === 404) return { outcome: "tomt", candidates: [] };
    if (!r.ok) return { outcome: "fel", candidates: [] };
    const j = await r.json();
    const arr = Array.isArray(j && j.businessUnits) ? j.businessUnits : j && j.id ? [j] : [];
    const list = arr.filter((b) => b && TP_ID_RE.test(String(b.id || ""))).slice(0, LIM.maxCandidates)
      .map((b) => ({ id: b.id, name: cleanText((b.displayName || (b.name && (b.name.identifying || b.name)) || ""), 100), site: normDomain(b.websiteUrl || b.domain || "") || null })).filter((b) => b.name);
    return { outcome: list.length === 0 ? "tomt" : "flera", candidates: list };
  } catch { return { outcome: "fel", candidates: [] }; }
}
const httpsTpLink = (u) => { try { const x = new URL(String(u)); return x.protocol === "https:" && /(^|\.)trustpilot\.com$/.test(x.hostname) ? x.href.slice(0, 300) : null; } catch { return null; } };
const isoDate = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v)) ? v.slice(0, 10) : null);
// Normaliserar svaret oförändrat i innehållet (text/stjärnor/datum/källänk). Ingen omsortering, inget eget betyg, ingen sammanfattning.
export function normalizeTrustpilot(json, { domain } = {}) {
  const arr = Array.isArray(json && json.reviews) ? json.reviews : Array.isArray(json && json.items) ? json.items : [];
  const reviews = [];
  for (const r of arr.slice(0, 5)) {
    const stars = r && (r.stars ?? r.rating), date = r && isoDate(r.createdAt || r.publishedAt || r.createdDateTime);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5 || !date) continue;
    reviews.push({ stars, date, title: cleanText(r.title, 140), text: cleanText(r.text, 1200), link: httpsTpLink(r.link || r.url) || null });
  }
  const dates = reviews.map((r) => r.date);
  const newestFirst = dates.every((d, i) => i === 0 || d <= dates[i - 1]); // källan ska leverera nyast först; vi sorterar aldrig om
  const bu = (json && (json.businessUnit || json)) || {};
  const score = bu.trustScore ?? (bu.score && bu.score.trustScore);
  const total = bu.numberOfReviews && typeof bu.numberOfReviews === "object" ? bu.numberOfReviews.total : bu.numberOfReviews ?? bu.reviewCount;
  return {
    source: "trustpilot", sourceName: "Trustpilot",
    trustScore: typeof score === "number" && score >= 1 && score <= 5 ? Math.round(score * 10) / 10 : null,
    totalReviews: Number.isInteger(total) && total >= 0 ? total : null,
    reviews, latestState: reviews.length === 0 ? "inga_omdomen" : newestFirst ? "visas" : "ej_senaste_tillgangliga",
    sourceUrl: domain ? `https://www.trustpilot.com/review/${domain}` : null,
    note: "Visas som Trustpilot levererar dem (nyast först, högst fem). Antalet kan vara färre. Datumet är omdömets publiceringsdatum. Vi räknar inga egna betyg och bedömer inte företaget.",
  };
}
const inflight = new Map();
// Hämtar senaste 1–5 för bekräftad BusinessUnit. Cache i KV högst 24 h; sidladdning hämtar aldrig själv om cachen är färsk.
export async function tpLatest(env, cfg, { buId, domain }, { now = Date.now() } = {}) {
  if (!cfg.trustpilot.on) return { outcome: "fel" };
  if (!TP_ID_RE.test(String(buId || ""))) return { outcome: "fel" };
  const key = `cmptp:${buId}`;
  try {
    const hit = env.REVIEWS_KV ? await env.REVIEWS_KV.get(key, "json") : null;
    if (hit && typeof hit.fetchedAt === "number" && now - hit.fetchedAt >= 0 && now - hit.fetchedAt < cfg.trustpilot.cacheMs && hit.card) return { outcome: hit.card.reviews.length === 0 && hit.card.totalReviews === 0 ? "tomt" : "ok", card: hit.card, fetchedAt: hit.fetchedAt, fromCache: true };
  } catch { /* cache otillgänglig: fortsätt till hämtning om budget finns */ }
  if (!cfg.trustpilot.fetchDayCap) return { outcome: "kostnadsstopp" };
  if (inflight.has(key)) return inflight.get(key); // dubblettladdning i samma isolat delar EN hämtning
  const p = (async () => {
    const c = await countToday(env, { name: "tpfetch", limit: cfg.trustpilot.fetchDayCap, now: new Date(now) });
    if (!c.ok) return { outcome: "kostnadsstopp" };
    try {
      const r = await tpFetch(env, cfg, `/v1/business-units/${encodeURIComponent(buId)}/reviews/latest?limit=5`);
      if (!r.ok) return { outcome: "fel" };
      const card = normalizeTrustpilot(await r.json(), { domain });
      try { await env.REVIEWS_KV.put(key, JSON.stringify({ fetchedAt: now, card }), { expirationTtl: Math.ceil(LIM.tpCacheMs / 1000) }); } catch { /* ingen cache: nästa visning hämtar igen inom budget */ }
      return { outcome: card.reviews.length === 0 && card.totalReviews === 0 ? "tomt" : "ok", card, fetchedAt: now, fromCache: false };
    } catch { return { outcome: "fel" }; }
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
export async function tpDeleteCache(env, buId) { try { await env.REVIEWS_KV.delete(`cmptp:${buId}`); } catch { /* TTL 24 h */ } }

// Ingen omdömestext får någonsin följa med in i rapport, export, ledger eller mejl. Fältet "sources" finns bara i /sources-vyerna.
export const REVIEW_TEXT_FIELDS = Object.freeze(["text", "title"]);
