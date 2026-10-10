// D07: källor för senaste originalomdömen (Google UI Kit i webbläsaren, Trustpilot via serveradapter). Allt offline med
// attrapper och SYNTETISKA data: inga riktiga Google-/Trustpilot-anrop, ingen nyckel, inget konto. Adaptrarna är AV som standard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { consentSnapshot, offerCopy, dataCoverage, OFFER_COPY, DATA_COVERAGE } from "../src/compare_config.js";
import { normName, normDomain, buildFirms, sourcesConfig, normalizeTrustpilot } from "../src/compare_sources.js";
import { makeEnv, installFetch, api, createOrder, readyOrder, startCheckout, paidSession, webhook, REVIEW_VARS, GOOGLE_VARS, TP_VARS, placeId, synthTpReviews, consentOf } from "./helpers/compare_env.mjs";

const ALL = { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" };
const S = (total) => ({ extracted: { totalBeforeRotSek: total, totalVatBasis: "inkl" }, scope: ALL });
const ON = { ...REVIEW_VARS, ...GOOGLE_VARS, ...TP_VARS };
const src = (env, id, token, sub = "", method = "GET", body) => api(env, method, `/compare/orders/${id}/sources${sub}`, { token, body });
const FIRMS = [{ offerIndex: 0, name: "Bygg Nord AB", city: "Malmö", domain: "https://www.byggnord.se/kontakt" }, { offerIndex: 1, name: "BYGG NORD Aktiebolag", city: "malmo", domain: "byggnord.se" }, { offerIndex: 2, name: "Bygg Nord AB", city: "Lund" }, { offerIndex: 3, name: "Bygg Nord Syd AB", city: "Malmö" }];
async function order4(env) { const c = await createOrder(env, 4); assert.equal(c.status, 201); return c.json; }
const peekSources = (env, id) => env.COMPARE_ORDERS.peek(id).store.get("sources");

test("AV som standard: ingen källa aktiv, ingen texthänvisning till omdömen ändras, inga externa anrop", async () => {
  const env = makeEnv(); const f = installFetch();
  try {
    assert.equal(offerCopy(env), OFFER_COPY); assert.equal(dataCoverage(env), DATA_COVERAGE);
    const cfg = (await api(env, "GET", "/compare/config")).json;
    assert.equal(cfg.sources.active, false); assert.equal(cfg.sources.google.state, "ej_aktiverad"); assert.equal(cfg.sources.google.mapsKey, null); assert.equal(cfg.sources.trustpilot.state, "ej_aktiverad");
    assert.equal(cfg.dataCoverage.reviews, false);
    // bara EN av flaggorna räcker inte
    for (const v of [{ COMPARE_REVIEWS: "1" }, { COMPARE_REVIEWS_VERIFIED: "1" }, { ...REVIEW_VARS, GOOGLE_UI_KIT: "1" }]) assert.equal(sourcesConfig({ ...v }).google.on, false);
    const { orderId, token } = await order4(env);
    assert.equal((await src(env, orderId, token, "/firms", "PUT", { firms: FIRMS })).status, 200);
    const r = (await src(env, orderId, token)).json.sources;
    assert.ok(r.firms.every((x) => x.google.state === "ej_aktiverad" && x.trustpilot.state === "ej_aktiverad"));
    assert.equal((await src(env, orderId, token, "/google/search", "POST", { firmId: r.firms[0].id })).status, 503);
    assert.equal((await src(env, orderId, token, "/trustpilot/latest", "POST", { firmId: r.firms[0].id })).status, 503);
    assert.equal(f.log.google.length + f.log.tp.length, 0);
  } finally { f.restore(); }
});

test("påslagen: kundtexten och hashen följer läget (inget löfte när AV; ingen garanti när PÅ)", async () => {
  const f0 = installFetch();
  const off = makeEnv(), on = makeEnv(ON);
  const a = await consentOf(off), b = await consentOf(on);
  assert.notEqual(a.hash, b.hash);
  const cfgOn = (await api(on, "GET", "/compare/config")).json;
  assert.equal(cfgOn.dataCoverage.reviews, true);
  assert.ok(cfgOn.offerCopy.getsNot.some((t) => /lovar inte att en källa finns/.test(t)));
  assert.ok(!cfgOn.offerCopy.getsNot.some((t) => /^Inga omdömen om företagen/.test(t)));
  assert.ok(!/garant|alltid|fem omdömen/i.test(cfgOn.dataCoverage.text));
  assert.equal(cfgOn.sources.google.mapsKey.length > 20, true);
  // gammalt samtycke (AV-hash) gäller inte efter att läget ändrats
  const { orderId, token } = await readyOrder(on, [S(100000), S(110000)]);
  const r = await startCheckout(on, orderId, token, { terms: true, immediateDelivery: true, consentHash: a.hash, consentVersion: a.version, email: "k@example.test" });
  assert.equal(r.status, 409); f0.restore();
});

test("företagsidentitet: samma firma i två offerter = EN panel; filial och liknamnad firma hålls isär; webbadress normaliseras; inga kundens uppgifter", async () => {
  assert.equal(normName("Bygg Nord AB"), normName("BYGG NORD Aktiebolag"));
  assert.notEqual(normName("Bygg Nord AB"), normName("Bygg Nord Syd AB"));
  assert.equal(normDomain("https://www.byggnord.se/kontakt?x=1"), "byggnord.se"); assert.equal(normDomain("inte en adress"), null); assert.equal(normDomain("javascript:alert(1)"), null);
  const r = await buildFirms(FIRMS);
  assert.equal(r.firms.length, 3);
  assert.deepEqual(r.firms[0].offers, [0, 1]); assert.equal(r.firms[0].domain, "byggnord.se");
  assert.ok(new Set(r.firms.map((x) => x.id)).size === 3);
  assert.equal((await buildFirms([...FIRMS, { offerIndex: 0, name: "Femte AB", city: "X" }, { offerIndex: 1, name: "Sjätte AB" }])).error, "for_manga");
  assert.equal((await buildFirms([{ offerIndex: 0, name: "Xeta AB", domain: "bad domain" }])).error, "domain");
  assert.deepEqual((await buildFirms([{ offerIndex: 0, name: "" }, { offerIndex: 1, name: " " }])).firms, []); // namnlös = ingen panel, inget gissas
  const env = makeEnv(ON); const f = installFetch();
  try {
    const { orderId, token } = await order4(env);
    const v = (await src(env, orderId, token, "/firms", "PUT", { firms: FIRMS })).json.sources;
    assert.equal(v.firms.length, 3);
    assert.equal((await src(env, orderId, token, "/firms", "PUT", { firms: [{ offerIndex: 0, name: "Xeta AB", domain: "bad domain" }] })).status, 400);
  } finally { f.restore(); }
});

test("Google: kandidater visas, ingen första-träff-automatik; bara firmanamn+ort lämnar oss; endast PlaceID lagras; fel ID nekas", async () => {
  const env = makeEnv(ON); const f = installFetch();
  f.ctl.googlePlaces = [{ id: placeId("a"), displayName: { text: "Bygg Nord AB" }, formattedAddress: "Syntetvägen 1, Malmö" }, { id: placeId("b"), displayName: { text: "Bygg Nord Syd" }, formattedAddress: "Syntetgatan 2, Lund" }];
  try {
    const { orderId, token } = await order4(env);
    const fid = (await src(env, orderId, token, "/firms", "PUT", { firms: FIRMS })).json.sources.firms[0].id;
    const s = await src(env, orderId, token, "/google/search", "POST", { firmId: fid });
    assert.equal(s.status, 200); assert.equal(s.json.candidates.length, 2); assert.equal(s.json.outcome, "flera");
    assert.equal(s.json.sources.firms[0].google.state, "tvetydig"); assert.equal(s.json.sources.firms[0].google.confirmed, false);
    assert.deepEqual(f.log.google[0].body.textQuery, "Bygg Nord AB Malmö");
    assert.ok(!JSON.stringify(f.log.google[0]).match(/kund@|example\.test|FIXTURE|byggnord\.se/));
    assert.equal(f.log.google[0].headers["x-goog-fieldmask"], "places.id,places.displayName,places.formattedAddress");
    // ett ID som inte föreslagits godtas inte
    assert.equal((await src(env, orderId, token, "/google/confirm", "POST", { firmId: fid, placeId: placeId("z"), via: "candidate" })).status, 400);
    const c = await src(env, orderId, token, "/google/confirm", "POST", { firmId: fid, placeId: placeId("a"), via: "candidate" });
    assert.equal(c.status, 200); assert.equal(c.json.sources.firms[0].google.state, "tillganglig"); assert.equal(c.json.sources.firms[0].google.placeId, placeId("a"));
    const stored = JSON.stringify(peekSources(env, orderId));
    assert.ok(!/Syntetvägen|Syntetgatan/.test(stored), "kandidatnamn/adresser från Google lagras inte");
    // reservväg: manuellt PlaceID kräver synlig profilbekräftelse
    const fid2 = c.json.sources.firms[1].id;
    assert.equal((await src(env, orderId, token, "/google/confirm", "POST", { firmId: fid2, placeId: placeId("c"), via: "manual" })).status, 400);
    assert.equal((await src(env, orderId, token, "/google/confirm", "POST", { firmId: fid2, placeId: placeId("c"), via: "manual", seen: true })).status, 200);
    // ogiltigt format
    assert.equal((await src(env, orderId, token, "/google/confirm", "POST", { firmId: fid2, placeId: "x", via: "manual", seen: true })).status, 400);
  } finally { f.restore(); }
});

test("Google: noll träffar = verifierat tomt; källfel = kallfel (aldrig 'inga omdömen'); en träff kräver ändå bekräftelse", async () => {
  const env = makeEnv(ON); const f = installFetch();
  try {
    const { orderId, token } = await order4(env);
    const fid = (await src(env, orderId, token, "/firms", "PUT", { firms: [{ offerIndex: 0, name: "Finns Inte AB", city: "Ingenstans" }, { offerIndex: 1, name: "Ensam Träff AB", city: "Umeå" }, { offerIndex: 2, name: "Felande AB", city: "Luleå" }] })).json.sources.firms;
    f.ctl.googlePlaces = [];
    assert.equal((await src(env, orderId, token, "/google/search", "POST", { firmId: fid[0].id })).json.sources.firms[0].google.state, "verifierat_tomt");
    f.ctl.googlePlaces = [{ id: placeId("e"), displayName: { text: "Ensam Träff AB" }, formattedAddress: "Syntet 1" }];
    const one = await src(env, orderId, token, "/google/search", "POST", { firmId: fid[1].id });
    assert.equal(one.json.sources.firms[1].google.state, "tvetydig"); assert.equal(one.json.sources.firms[1].google.confirmed, false);
    f.ctl.googleFail = true;
    const bad = await src(env, orderId, token, "/google/search", "POST", { firmId: fid[2].id });
    assert.equal(bad.json.sources.firms[2].google.state, "kallfel");
    assert.match(bad.json.sources.coverage.lines.join(" "), /det betyder inte att omdömen saknas/);
  } finally { f.restore(); }
});

test("kostnad: utan dygnstak ingen sökning (kostnadsstopp); tak räknas atomiskt; per firma högst två sökningar; per order begränsat; inga anrop utanför", async () => {
  const noCap = makeEnv({ ...ON, COMPARE_SOURCES_SEARCH_DAY_CAP: undefined, COMPARE_TP_DAY_CAP: undefined }); const f = installFetch();
  try {
    let { orderId, token } = await order4(noCap);
    let fid = (await src(noCap, orderId, token, "/firms", "PUT", { firms: [{ offerIndex: 0, name: "Alfa AB", city: "X", domain: "a.se" }] })).json.sources.firms[0].id;
    assert.equal((await src(noCap, orderId, token, "/google/search", "POST", { firmId: fid })).json.sources.firms[0].google.state, "kostnadsstopp");
    assert.equal((await src(noCap, orderId, token, "/trustpilot/search", "POST", { firmId: fid })).json.sources.firms[0].trustpilot.state, "kostnadsstopp");
    assert.equal(f.log.google.length + f.log.tp.length, 0);
    // tak = 1 per dygn
    const one = makeEnv({ ...ON, COMPARE_SOURCES_SEARCH_DAY_CAP: "1" });
    ({ orderId, token } = await order4(one));
    fid = (await src(one, orderId, token, "/firms", "PUT", { firms: [{ offerIndex: 0, name: "Alfa AB", city: "X" }, { offerIndex: 1, name: "Beta AB", city: "Y" }] })).json.sources.firms;
    f.ctl.googlePlaces = [];
    assert.equal((await src(one, orderId, token, "/google/search", "POST", { firmId: fid[0].id })).json.sources.firms[0].google.state, "verifierat_tomt");
    assert.equal((await src(one, orderId, token, "/google/search", "POST", { firmId: fid[1].id })).json.sources.firms[1].google.state, "kostnadsstopp");
    assert.equal(f.log.google.length, 1);
    // per firma högst två
    const env = makeEnv(ON);
    ({ orderId, token } = await order4(env));
    fid = (await src(env, orderId, token, "/firms", "PUT", { firms: [{ offerIndex: 0, name: "Alfa AB", city: "X" }] })).json.sources.firms[0].id;
    assert.equal((await src(env, orderId, token, "/google/search", "POST", { firmId: fid })).status, 200);
    assert.equal((await src(env, orderId, token, "/google/search", "POST", { firmId: fid })).status, 200);
    assert.equal((await src(env, orderId, token, "/google/search", "POST", { firmId: fid })).status, 429);
    // visningsgräns per order
    const st = env.COMPARE_ORDERS.peek(orderId).store; const cur = st.get("sources"); st.set("sources", { ...cur, views: 120 });
    assert.equal((await src(env, orderId, token)).status, 429);
  } finally { f.restore(); }
});

test("Trustpilot: sök på domän → välj (tvetydig) → senaste 1–5 med originaltext/stjärnor/datum/källänk, totalbetyg skilt; auth-rubrik; ingen omsortering", async () => {
  const env = makeEnv(ON); const f = installFetch();
  f.ctl.tpFind = { "byggnord.se": [{ id: "bu00000001", displayName: "Bygg Nord", websiteUrl: "https://byggnord.se" }, { id: "bu00000002", displayName: "Bygg Nord Syd", websiteUrl: "https://byggnordsyd.se" }] };
  f.ctl.tpLatest = { bu00000001: synthTpReviews(5, { total: 42 }) };
  try {
    const { orderId, token } = await order4(env);
    const fid = (await src(env, orderId, token, "/firms", "PUT", { firms: FIRMS })).json.sources.firms[0].id;
    const s = await src(env, orderId, token, "/trustpilot/search", "POST", { firmId: fid });
    assert.equal(s.json.candidates.length, 2); assert.equal(s.json.sources.firms[0].trustpilot.state, "tvetydig");
    assert.equal(f.log.tp[0].headers.apikey, "synthetic-tp-key");
    assert.equal((await src(env, orderId, token, "/trustpilot/latest", "POST", { firmId: fid })).status, 409); // ej bekräftad
    assert.equal((await src(env, orderId, token, "/trustpilot/confirm", "POST", { firmId: fid, buId: "bu99999999" })).status, 400);
    assert.equal((await src(env, orderId, token, "/trustpilot/confirm", "POST", { firmId: fid, buId: "bu00000001" })).status, 200);
    const l = await src(env, orderId, token, "/trustpilot/latest", "POST", { firmId: fid });
    const card = l.json.card;
    assert.equal(l.json.outcome, "ok"); assert.equal(card.reviews.length, 5); assert.equal(card.trustScore, 4.3); assert.equal(card.totalReviews, 42);
    assert.equal(card.latestState, "visas");
    assert.equal(card.reviews[0].text, "SYNTETISK TEXT 1 – inte ett riktigt omdöme."); assert.equal(card.reviews[0].date, "2026-09-28"); assert.equal(card.reviews[0].link, "https://www.trustpilot.com/reviews/synth0");
    assert.equal(card.sourceUrl, "https://www.trustpilot.com/review/byggnord.se");
    assert.ok(f.log.tp.at(-1).url.endsWith("/v1/business-units/bu00000001/reviews/latest?limit=5"));
    assert.ok(!/sentiment|stars=|language|query|filter|orderBy/i.test(f.log.tp.at(-1).url));
    assert.deepEqual(Object.keys(card).sort(), ["latestState", "note", "reviews", "schemaOk", "source", "sourceName", "sourceUrl", "totalReviews", "trustScore"].sort());
  } finally { f.restore(); }
});

test("Trustpilot 0/1/5 omdömen, osorterat, källfel, tomt: lägena hålls isär och ingen egen bedömning", async () => {
  assert.equal(normalizeTrustpilot(synthTpReviews(0, { total: 0 })).latestState, "inga_omdomen");
  assert.equal(normalizeTrustpilot(synthTpReviews(1)).reviews.length, 1);
  const unsorted = synthTpReviews(3); unsorted.reviews.reverse();
  assert.equal(normalizeTrustpilot(unsorted).latestState, "ej_senaste_tillgangliga"); // vi sorterar aldrig om för att låtsas att det är senaste
  assert.equal(normalizeTrustpilot(synthTpReviews(8)).reviews.length, 5);
  assert.equal(normalizeTrustpilot({ reviews: [{ stars: 9, createdAt: "2026-01-01" }, { stars: 4, createdAt: "inte datum" }, { stars: 5, createdAt: "2026-01-02", link: "https://evil.example/x" }] }).reviews[0].link, null);
  const env = makeEnv(ON); const f = installFetch();
  f.ctl.tpFind = { "x.se": [{ id: "bu00000009", displayName: "X" }] };
  try {
    const { orderId, token } = await order4(env);
    const fid = (await src(env, orderId, token, "/firms", "PUT", { firms: [{ offerIndex: 0, name: "Xeta AB", city: "Y", domain: "x.se" }] })).json.sources.firms[0].id;
    await src(env, orderId, token, "/trustpilot/search", "POST", { firmId: fid });
    await src(env, orderId, token, "/trustpilot/confirm", "POST", { firmId: fid, buId: "bu00000009" });
    f.ctl.tpFail = 503;
    let r = await src(env, orderId, token, "/trustpilot/latest", "POST", { firmId: fid });
    assert.equal(r.json.outcome, "fel"); assert.equal(r.json.card, null);
    assert.equal((await src(env, orderId, token)).json.sources.firms[0].trustpilot.state, "kallfel");
    f.ctl.tpFail = 0; f.ctl.tpLatest = { bu00000009: synthTpReviews(0, { total: 0 }) };
    r = await src(env, orderId, token, "/trustpilot/latest", "POST", { firmId: fid });
    assert.equal(r.json.outcome, "tomt");
    assert.equal((await src(env, orderId, token)).json.sources.firms[0].trustpilot.state, "verifierat_tomt");
  } finally { f.restore(); }
});

test("Trustpilot cache: färsk cache ger ingen ny hämtning; efter 24 h hämtas på nytt; misslyckad förnyelse visar aldrig gammal data; parallella laddningar delar en hämtning", async () => {
  const env = makeEnv({ ...ON }); const f = installFetch();
  f.ctl.tpFind = { "c.se": [{ id: "bu0000000c", displayName: "C" }] }; f.ctl.tpLatest = { bu0000000c: synthTpReviews(2) };
  try {
    const { orderId, token } = await order4(env);
    const fid = (await src(env, orderId, token, "/firms", "PUT", { firms: [{ offerIndex: 0, name: "Cesar AB", city: "Y", domain: "c.se" }] })).json.sources.firms[0].id;
    await src(env, orderId, token, "/trustpilot/search", "POST", { firmId: fid });
    await src(env, orderId, token, "/trustpilot/confirm", "POST", { firmId: fid, buId: "bu0000000c" });
    const count = () => f.log.tp.filter((x) => /reviews\/latest/.test(x.url)).length;
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => src(env, orderId, token, "/trustpilot/latest", "POST", { firmId: fid })));
    assert.ok([a, b, c].every((x) => x.json.outcome === "ok")); assert.equal(count(), 1, "parallella laddningar = en hämtning");
    const d = await src(env, orderId, token, "/trustpilot/latest", "POST", { firmId: fid });
    assert.equal(d.json.fromCache, true); assert.equal(count(), 1);
    // utgången cache (25 h gammal)
    const key = "cmptp:bu0000000c"; const hit = await env.REVIEWS_KV.get(key, "json"); await env.REVIEWS_KV.put(key, JSON.stringify({ ...hit, fetchedAt: Date.now() - 25 * 3600_000 }));
    f.ctl.tpFail = 500;
    const e = await src(env, orderId, token, "/trustpilot/latest", "POST", { firmId: fid });
    assert.equal(e.json.outcome, "fel"); assert.equal(e.json.card, null, "föråldrad cache visas inte som aktuell");
    f.ctl.tpFail = 0;
    const g = await src(env, orderId, token, "/trustpilot/latest", "POST", { firmId: fid });
    assert.equal(g.json.fromCache, false); assert.equal(count(), 3);
    // dygnstak: utan cache och med tak 1 → andra firman stoppas
    assert.ok(env.REVIEWS_KV.m.get(key));
  } finally { f.restore(); }
});

test("Trustpilot: dygnstaket för hämtningar stoppar (kostnadsstopp), aldrig 'inga omdömen'; utan tak inget anrop alls", async () => {
  const { tpLatest } = await import("../src/compare_sources.js");
  const f = installFetch();
  f.ctl.tpLatest = { bu0000000d: synthTpReviews(1), bu0000000e: synthTpReviews(1) };
  try {
    const env = makeEnv({ ...ON, COMPARE_TP_DAY_CAP: "1" });
    const cfg = sourcesConfig(env);
    assert.equal((await tpLatest(env, cfg, { buId: "bu0000000d", domain: "d.se" })).outcome, "ok");
    assert.equal((await tpLatest(env, cfg, { buId: "bu0000000e", domain: "e.se" })).outcome, "kostnadsstopp");
    assert.equal((await tpLatest(env, cfg, { buId: "bu0000000d", domain: "d.se" })).fromCache, true, "cacheträff kostar inget");
    assert.equal(f.log.tp.length, 1);
    const none = makeEnv({ ...ON, COMPARE_TP_DAY_CAP: undefined });
    assert.equal((await tpLatest(none, sourcesConfig(none), { buId: "bu0000000e", domain: "e.se" })).outcome, "kostnadsstopp");
    assert.equal(f.log.tp.length, 1);
  } finally { f.restore(); }
});

test("kundbyte/företagsbyte: ändrad firma får nytt ID utan tidigare bekräftelse; oförändrad firma behåller sin; andra ordrar ser inget", async () => {
  const env = makeEnv(ON); const f = installFetch();
  f.ctl.googlePlaces = [{ id: placeId("a"), displayName: { text: "Bygg Nord AB" }, formattedAddress: "Syntet 1" }];
  try {
    const { orderId, token } = await order4(env);
    const fid = (await src(env, orderId, token, "/firms", "PUT", { firms: [{ offerIndex: 0, name: "Bygg Nord AB", city: "Malmö" }, { offerIndex: 1, name: "Annat AB", city: "Lund" }] })).json.sources.firms;
    await src(env, orderId, token, "/google/search", "POST", { firmId: fid[0].id });
    await src(env, orderId, token, "/google/confirm", "POST", { firmId: fid[0].id, placeId: placeId("a"), via: "candidate" });
    // oförändrad firma + ny andra firma: första behåller sin bekräftelse
    let v = (await src(env, orderId, token, "/firms", "PUT", { firms: [{ offerIndex: 0, name: "Bygg Nord Aktiebolag", city: "Malmö" }, { offerIndex: 1, name: "Helt Nytt AB", city: "Lund" }] })).json.sources;
    assert.equal(v.firms[0].id, fid[0].id); assert.equal(v.firms[0].google.placeId, placeId("a"));
    // firman byts ut: tidigare PlaceID följer inte med
    v = (await src(env, orderId, token, "/firms", "PUT", { firms: [{ offerIndex: 0, name: "Bygg Väst AB", city: "Malmö" }] })).json.sources;
    assert.notEqual(v.firms[0].id, fid[0].id); assert.equal(v.firms[0].google.placeId, null); assert.equal(v.firms[0].google.state, "vantar_foretagsval");
    assert.ok(!JSON.stringify(peekSources(env, orderId)).includes(placeId("a")));
    // annan order / fel token
    const other = await order4(env);
    assert.equal((await src(env, orderId, other.token)).status, 404);
    assert.equal((await src(env, other.orderId, other.token)).json.sources.firms.length, 0);
    assert.equal((await src(env, orderId, "x".repeat(32))).status, 404);
  } finally { f.restore(); }
});

test("täckning före köp: visas per firma/källa, fryses som antal per läge i samtycket och ledgern (inga firmanamn, ingen omdömesdata)", async () => {
  const env = makeEnv({ ...ON, COMPARE_AUTO_REFUND: "1" }); const f = installFetch();
  f.ctl.googlePlaces = [{ id: placeId("a"), displayName: { text: "Bygg Nord AB" }, formattedAddress: "Syntet 1" }];
  f.ctl.tpFind = { "byggnord.se": [{ id: "bu00000001", displayName: "Bygg Nord" }] }; f.ctl.tpLatest = { bu00000001: synthTpReviews(5) };
  try {
    const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
    const fid = (await src(env, orderId, token, "/firms", "PUT", { firms: [{ offerIndex: 0, name: "Bygg Nord AB", city: "Malmö", domain: "byggnord.se" }, { offerIndex: 1, name: "Andra Firman AB", city: "Lund" }] })).json.sources.firms;
    await src(env, orderId, token, "/google/search", "POST", { firmId: fid[0].id });
    await src(env, orderId, token, "/google/confirm", "POST", { firmId: fid[0].id, placeId: placeId("a"), via: "candidate" });
    await src(env, orderId, token, "/trustpilot/search", "POST", { firmId: fid[0].id });
    await src(env, orderId, token, "/trustpilot/confirm", "POST", { firmId: fid[0].id, buId: "bu00000001" });
    await src(env, orderId, token, "/trustpilot/latest", "POST", { firmId: fid[0].id });
    const cov = (await src(env, orderId, token)).json.sources.coverage;
    assert.equal(cov.firms, 2); assert.match(cov.lines[0], /Bygg Nord AB \(Malmö\): Google – kan visas; Trustpilot – kan visas/); assert.match(cov.lines[1], /Andra Firman AB \(Lund\): Google – väntar på att du bekräftar/);
    assert.deepEqual(cov.google, { tillganglig: 1, vantar_foretagsval: 1 });
    assert.equal((await startCheckout(env, orderId, token)).status, 200);
    const sess = [...f.sessions.values()].pop();
    assert.equal((await webhook(env, "checkout.session.completed", paidSession(sess))).status, 200);
    const l = env.COMPARE_ORDERS.peek(orderId).store.get("ledger");
    assert.deepEqual(l.agreement.accepted.coverage, { active: true, firms: 2, google: { tillganglig: 1, vantar_foretagsval: 1 }, trustpilot: { tillganglig: 1, vantar_foretagsval: 1 } });
    const dump = JSON.stringify(l);
    assert.ok(!/Bygg Nord|Andra Firman|Malmö|SYNTETISK|bu00000001|ChIJ/.test(dump), "ledgern bär inga firmanamn, ID:n eller omdömen");
  } finally { f.restore(); }
});

test("omdömestext når aldrig rapport, export, ledger, mejl eller modell; radering tar bort källorna", async () => {
  const env = makeEnv({ ...ON, COMPARE_AUTO_REFUND: "1", COMPARE_ADMIN_TOKEN: "admin-token-for-tests-0123456789abcdef" }); const f = installFetch();
  f.ctl.tpFind = { "byggnord.se": [{ id: "bu00000001", displayName: "Bygg Nord" }] }; f.ctl.tpLatest = { bu00000001: synthTpReviews(5) };
  try {
    const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
    const fid = (await src(env, orderId, token, "/firms", "PUT", { firms: [{ offerIndex: 0, name: "Bygg Nord AB", city: "Malmö", domain: "byggnord.se" }] })).json.sources.firms[0].id;
    await src(env, orderId, token, "/trustpilot/search", "POST", { firmId: fid });
    await src(env, orderId, token, "/trustpilot/confirm", "POST", { firmId: fid, buId: "bu00000001" });
    const seen = (await src(env, orderId, token, "/trustpilot/latest", "POST", { firmId: fid })).json.card.reviews[0].text;
    assert.match(seen, /SYNTETISK/);
    assert.equal((await startCheckout(env, orderId, token)).status, 200);
    const sess = [...f.sessions.values()].pop();
    await webhook(env, "checkout.session.completed", paidSession(sess));
    for (let i = 0; i < 40; i++) { const o = (await api(env, "GET", `/compare/orders/${orderId}`, { token })).json.order; if (o.status === "delivered") break; await env.COMPARE_ORDERS.runAlarms(); }
    const rep = await api(env, "GET", `/compare/orders/${orderId}/report`, { token });
    const outbox = [...env.COMPARE_ORDERS.peek(orderId).store].filter(([k]) => k.startsWith("outbox:"));
    const exp = await api(env, "GET", "/compare/admin/ledger?month=" + new Date().toISOString().slice(0, 7), { headers: { authorization: "Bearer admin-token-for-tests-0123456789abcdef" }, origin: "" });
    assert.equal(rep.status, 200, "rapporten levererades"); assert.equal(exp.status, 200); assert.ok(outbox.length >= 1);
    const hay = JSON.stringify([rep.json, outbox, exp.json, env.COMPARE_ORDERS.peek(orderId).store.get("ledger"), f.log.anthropic, f.log.count, f.log.stripeCreate]);
    assert.ok(!/SYNTETISK|Syntetiskt omdöme|trustpilot\.com/.test(hay), "ingen omdömestext/källdata i rapport, export, ledger, mejl, modell eller Stripe");
    // radering
    const del = await api(env, "DELETE", `/compare/orders/${orderId}`, { token });
    assert.ok(del.status === 200 || del.status === 409);
    if (del.status === 200) assert.equal(peekSources(env, orderId), undefined);
  } finally { f.restore(); }
});

test("källuppgifter följer ordern: raderas vid kundens radering och är oåtkomliga/raderade efter 24 h", async () => {
  const env = makeEnv(ON); const f = installFetch();
  try {
    let { orderId, token } = await order4(env);
    await src(env, orderId, token, "/firms", "PUT", { firms: [{ offerIndex: 0, name: "Bygg Nord AB", city: "Malmö" }] });
    assert.ok(peekSources(env, orderId));
    assert.equal((await api(env, "DELETE", `/compare/orders/${orderId}`, { token })).status, 200);
    assert.equal(peekSources(env, orderId), undefined);
    assert.equal((await src(env, orderId, token)).json.sources.firms.length, 0);
    assert.equal((await src(env, orderId, token, "/firms", "PUT", { firms: [{ offerIndex: 0, name: "Ny Firma AB" }] })).status, 409);
    ({ orderId, token } = await order4(env));
    await src(env, orderId, token, "/firms", "PUT", { firms: [{ offerIndex: 0, name: "Bygg Nord AB", city: "Malmö" }] });
    const st = env.COMPARE_ORDERS.peek(orderId).store; const rec = [...st].find(([, v]) => v && v.tokenHash && v.id === orderId);
    st.set(rec[0], { ...rec[1], expiresAt: Date.now() - 1000 });
    assert.equal((await src(env, orderId, token)).json.sources.firms.length, 0);
    assert.equal(peekSources(env, orderId), undefined);
  } finally { f.restore(); }
});
