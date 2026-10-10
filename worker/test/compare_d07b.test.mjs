// D07-rättning efter root-QA 20:38: domänkonflikt, identitetsändring, Trustpilot-schemafel, native Googleväg + server-Text Search bakom extra flagga.
// Offline med syntetiska data. Inga riktiga källanrop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFirms, applyOp, emptySources, sourcesConfig, normalizeTrustpilot, publicSourcesConfig } from "../src/compare_sources.js";
import { makeEnv, installFetch, api, createOrder, REVIEW_VARS, GOOGLE_VARS, TP_VARS, placeId, synthTpReviews } from "./helpers/compare_env.mjs";

const ON = { ...REVIEW_VARS, ...GOOGLE_VARS, ...TP_VARS };
const cfg = sourcesConfig(ON);
const src = (env, id, token, sub = "", method = "GET", body) => api(env, method, `/compare/orders/${id}/sources${sub}`, { token, body });

test("samma namn+ort men olika webbplatser slås inte ihop tyst: varje webbplats blir egen firma markerad som konflikt", async () => {
  const first = { offerIndex: 0, name: "Nord Bygg AB", city: "Stockholm", domain: "nord-one.se" };
  const r = await buildFirms([first, { offerIndex: 1, name: "Nord Bygg AB", city: "Stockholm", domain: "nord-two.se" }]);
  assert.equal(r.firms.length, 2);
  assert.deepEqual(r.firms.map((f) => [f.domain, f.offers, f.conflict]), [["nord-one.se", [0], true], ["nord-two.se", [1], true]]);
  assert.notEqual(r.firms[0].id, r.firms[1].id);
  // offert utan webbplats i en konfliktgrupp blir egen post (okänt vilken firma den avser)
  const r3 = await buildFirms([first, { offerIndex: 1, name: "Nord Bygg AB", city: "Stockholm", domain: "nord-two.se" }, { offerIndex: 2, name: "Nord Bygg", city: "Stockholm" }]);
  assert.equal(r3.firms.length, 3);
  // ingen konflikt när bara en webbplats finns (offert utan webbplats ansluts) eller samma webbplats upprepas
  const ok = await buildFirms([first, { offerIndex: 1, name: "Nord Bygg Aktiebolag", city: "stockholm" }, { offerIndex: 2, name: "Nord Bygg AB", city: "Stockholm", domain: "https://www.nord-one.se/x" }]);
  assert.equal(ok.firms.length, 1); assert.deepEqual(ok.firms[0].offers, [0, 1, 2]); assert.equal(ok.firms[0].conflict, false);
  // gränsen 4 firmor gäller även efter separation
  const many = await buildFirms(["a", "b", "c", "d", "e"].map((d, i) => ({ offerIndex: i % 4, name: "Samma AB", city: "X", domain: d + ".se" })));
  assert.equal(many.error, "for_manga");
});

test("ändrad identitetsgrund (webbplats) rensar tidigare Google-/Trustpilot-bekräftelse; oförändrad grund behåller; tillagd webbplats behåller Googleprofil", async () => {
  const first = { offerIndex: 0, name: "Nord Bygg AB", city: "Stockholm", domain: "nord-one.se" };
  let a = await applyOp(cfg, emptySources(), { type: "set_firms", firms: [first] });
  const fid = a.state.firms[0].id;
  a = await applyOp(cfg, a.state, { type: "confirm_google", firmId: fid, placeId: placeId("a"), via: "manual", seen: true, now: 1 });
  a = await applyOp(cfg, a.state, { type: "record_search", firmId: fid, provider: "trustpilot", candidateIds: ["123456789"], outcome: "flera" });
  a = await applyOp(cfg, a.state, { type: "confirm_trustpilot", firmId: fid, buId: "123456789", now: 1 });
  const same = await applyOp(cfg, a.state, { type: "set_firms", firms: [{ ...first, domain: "https://www.nord-one.se/" }] });
  assert.equal(same.state.firms[0].google.placeId, placeId("a")); assert.equal(same.state.firms[0].trustpilot.buId, "123456789");
  const ch = await applyOp(cfg, a.state, { type: "set_firms", firms: [{ ...first, domain: "nord-two.se" }] });
  assert.equal(ch.state.firms[0].domain, "nord-two.se"); assert.equal(ch.state.firms[0].google.placeId, null); assert.equal(ch.state.firms[0].trustpilot.buId, null);
  assert.equal(ch.state.firms[0].google.confirmedAt, null);
  const cleared = await applyOp(cfg, a.state, { type: "set_firms", firms: [{ ...first, domain: "" }] });
  assert.equal(cleared.state.firms[0].domain, ""); assert.equal(cleared.state.firms[0].google.placeId, null); // webbplatsen togs bort: ingen gammal grund kvar
  let b = await applyOp(cfg, emptySources(), { type: "set_firms", firms: [{ ...first, domain: "" }] });
  b = await applyOp(cfg, b.state, { type: "confirm_google", firmId: b.state.firms[0].id, placeId: placeId("b"), via: "manual", seen: true, now: 1 });
  const added = await applyOp(cfg, b.state, { type: "set_firms", firms: [first] });
  assert.equal(added.state.firms[0].google.placeId, placeId("b"));
});

test("Trustpilot: okänt schema eller ogiltig post är aldrig 'inga omdömen'; bara giltig tom lista är verifierat tomt", async () => {
  assert.equal(normalizeTrustpilot({ unexpected: "schema mismatch" }).schemaOk, false);
  assert.equal(normalizeTrustpilot({ unexpected: "schema mismatch" }).latestState, "okant_schema");
  assert.equal(normalizeTrustpilot(null).schemaOk, false);
  assert.equal(normalizeTrustpilot({ reviews: [{ stars: 9, createdAt: "2026-01-01" }] }).schemaOk, false);
  const mixed = synthTpReviews(2); mixed.reviews.push({ stars: "x" });
  assert.equal(normalizeTrustpilot(mixed).schemaOk, false);
  assert.equal(normalizeTrustpilot({ reviews: [], businessUnit: { numberOfReviews: { total: 12 } } }).schemaOk, false); // tomt men källan uppger omdömen
  assert.equal(normalizeTrustpilot({ reviews: [] }).schemaOk, true);
  assert.equal(normalizeTrustpilot(synthTpReviews(3)).schemaOk, true);
  const env = makeEnv(ON); const f = installFetch();
  f.ctl.tpFind = { "x.se": [{ id: "bu00000009", displayName: "X" }] };
  try {
    const { orderId, token } = (await createOrder(env, 2)).json;
    const fid = (await src(env, orderId, token, "/firms", "PUT", { firms: [{ offerIndex: 0, name: "Xeta AB", city: "Y", domain: "x.se" }] })).json.sources.firms[0].id;
    await src(env, orderId, token, "/trustpilot/search", "POST", { firmId: fid });
    await src(env, orderId, token, "/trustpilot/confirm", "POST", { firmId: fid, buId: "bu00000009" });
    f.ctl.tpLatest = { bu00000009: { unexpected: "schema mismatch" } };
    let r = await src(env, orderId, token, "/trustpilot/latest", "POST", { firmId: fid });
    assert.equal(r.json.outcome, "fel"); assert.equal(r.json.card, null);
    assert.equal((await src(env, orderId, token)).json.sources.firms[0].trustpilot.state, "kallfel");
    assert.equal(await env.REVIEWS_KV.get("cmptp:bu00000009"), null, "felaktigt svar cachas inte");
    f.ctl.tpLatest = { bu00000009: { reviews: [] } };
    r = await src(env, orderId, token, "/trustpilot/latest", "POST", { firmId: fid });
    assert.equal(r.json.outcome, "tomt");
    assert.equal((await src(env, orderId, token)).json.sources.firms[0].trustpilot.state, "verifierat_tomt");
  } finally { f.restore(); }
});

test("Google: native UI Kit-sök är standardväg; servermässig Text Search kräver EXTRA mänsklig flagga och är annars helt avstängd (inga anrop)", async () => {
  const { GOOGLE_PLACES_API_SEARCH_VERIFIED: _x, ...noExtra } = GOOGLE_VARS;
  const c1 = sourcesConfig({ ...REVIEW_VARS, ...noExtra, ...TP_VARS });
  assert.equal(c1.google.on, true); assert.equal(c1.google.search, false); assert.equal(c1.google.select, "native");
  assert.equal(publicSourcesConfig({ ...REVIEW_VARS, ...noExtra }).google.select, "native");
  const c2 = sourcesConfig(ON); assert.equal(c2.google.search, true); assert.equal(c2.google.select, "server");
  assert.equal(sourcesConfig({ ...REVIEW_VARS, ...noExtra, GOOGLE_PLACES_API_SEARCH_VERIFIED: "0" }).google.search, false);
  const env = makeEnv({ ...REVIEW_VARS, ...noExtra, ...TP_VARS }); const f = installFetch();
  try {
    const { orderId, token } = (await createOrder(env, 2)).json;
    const fid = (await src(env, orderId, token, "/firms", "PUT", { firms: [{ offerIndex: 0, name: "Nord Bygg AB", city: "Stockholm" }] })).json.sources.firms[0].id;
    const s = await src(env, orderId, token, "/google/search", "POST", { firmId: fid });
    assert.equal(s.json.native, true); assert.equal(s.json.allowed, true); assert.equal(f.log.google.length, 0, "ingen Places API-sökning utan extra flagga (servern räknar bara budget)");
    assert.equal(s.json.sources.firms[0].google.searchesLeft, 1);
    // native val utan att en (budgetgrindad) sökning startats nekas
    const fid2 = (await src(env, orderId, token, "/firms", "PUT", { firms: [{ offerIndex: 0, name: "Nord Bygg AB", city: "Stockholm" }, { offerIndex: 1, name: "Annan Firma AB", city: "Lund" }] })).json.sources.firms[1].id;
    assert.equal((await src(env, orderId, token, "/google/confirm", "POST", { firmId: fid2, placeId: placeId("m"), via: "native", seen: true })).status, 400);
    // valet i Googles egna sökelement: kräver att kunden sett valet (seen) – annars nekas
    assert.equal((await src(env, orderId, token, "/google/confirm", "POST", { firmId: fid, placeId: placeId("n"), via: "native" })).status, 400);
    const ok = await src(env, orderId, token, "/google/confirm", "POST", { firmId: fid, placeId: placeId("n"), via: "native", seen: true });
    assert.equal(ok.status, 200); assert.equal(ok.json.sources.firms[0].google.placeId, placeId("n"));
    assert.equal(peek(env, orderId).firms[0].google.via, "native");
  } finally { f.restore(); }
});
const peek = (env, id) => env.COMPARE_ORDERS.peek(id).store.get("sources");

test("native sök utan människosatt dygnstak ⇒ kostnadsstopp (allowed:false); med tak räknas varje sökning mot taket", async () => {
  const { GOOGLE_PLACES_API_SEARCH_VERIFIED: _x, COMPARE_SOURCES_SEARCH_DAY_CAP: _c, ...base } = GOOGLE_VARS;
  const run = async (extra) => {
    const env = makeEnv({ ...REVIEW_VARS, ...base, ...extra }); const f = installFetch();
    try {
      const res = [];
      for (let i = 0; i < 3; i++) {
        const { orderId, token } = (await createOrder(env, 2)).json;
        const fid = (await src(env, orderId, token, "/firms", "PUT", { firms: [{ offerIndex: 0, name: "Nord Bygg AB", city: "Stockholm" }] })).json.sources.firms[0].id;
        const s = await src(env, orderId, token, "/google/search", "POST", { firmId: fid });
        res.push([s.json.outcome, s.json.allowed, s.json.sources.firms[0].google.state]);
      }
      assert.equal(f.log.google.length, 0);
      return res;
    } finally { f.restore(); }
  };
  assert.deepEqual(await run({}), Array(3).fill(["kostnadsstopp", false, "kostnadsstopp"]));
  assert.deepEqual((await run({ COMPARE_SOURCES_SEARCH_DAY_CAP: "2" })).map((r) => r[1]), [true, true, true], "grinden räknar inte längre själv; varje billbar instans reserveras via /google/mount (compare_mounts.test.mjs)");
  assert.deepEqual((await run({ COMPARE_SOURCES_MOUNT_DAY_CAP: undefined })).map((r) => r[0]), Array(3).fill("kostnadsstopp"), "utan gemensamt tak är vägen stängd");
});
