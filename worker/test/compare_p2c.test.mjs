// D11-P2c: företagsförslag ur dokumentidentiteten (auto/bekräfta/enskild/saknas), origin-märkning, identitetsbyte nollställer gammal källmatch.
// Offline, syntetiska data. Inga riktiga Google-/Trustpilot-anrop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeOffer } from "../src/compare_extract.js";
import { identityProposals } from "../src/compare_sources.js";
import { fixtureResponse, makeEnv, installFetch, api, readyOrder, startCheckout, paidSession, webhook, REVIEW_VARS, GOOGLE_VARS, TP_VARS, placeId } from "./helpers/compare_env.mjs";

const ALL = { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" };
const S = (total, issuer) => ({ extracted: { totalBeforeRotSek: total, totalVatBasis: "inkl" }, scope: ALL, ...(issuer !== undefined ? { issuer } : {}) });
const ON = { ...REVIEW_VARS, ...GOOGLE_VARS, ...TP_VARS };
const src = (env, id, token, sub = "", method = "GET", body) => api(env, method, `/compare/orders/${id}/sources${sub}`, { token, body });
const F = (value) => ({ status: value ? "framgar" : "framgar_inte", value: value || null });
const ident = (o = {}) => ({ state: "komplett", personal: false, legalForm: "bolag", role: "utforare", fields: { name: F("Nord Bygg AB"), city: F("Malmö"), web: F("nordbygg.se"), orgnr: F("556016-0680") }, ...o });
const rep = (ids, conflicts = []) => ({ offers: ids.map((identity) => ({ identity })), identityGroups: { conflicts } });

test("identityProposals: auto bara vid komplett identitet, utförare, bolag, ort och ingen namnkrock; övrigt bekräfta/enskild/saknas, aldrig gissning", () => {
  const p = identityProposals(rep([
    ident(),
    ident({ role: "kund" }),
    ident({ state: "saknas" }),
    ident({ fields: { name: F("Nord Bygg AB"), city: F(null), web: F(null) } }),
    ident({ personal: true }),
    ident({ legalForm: "enskild" }),
    ident({ state: "ej_avlast", fields: { name: F(null) } }),
    ident({ state: "saknas", fields: { name: F(null) } }),
    null,
  ], [{ offers: [0, 1] }]));
  assert.equal(p[0].state, "bekrafta"); assert.equal(p[0].reason, "liknande_namn"); // namnkrock med offert 1
  assert.equal(p[1].state, "bekrafta"); // roll != utförare hamnar i konflikt-set också, men reason följer ordningen: osäker roll först
  assert.equal(p[1].reason, "osaker_roll");
  assert.equal(p[2].reason, "ofullstandig");
  assert.equal(p[3].reason, "ort_saknas");
  assert.equal(p[4].state, "enskild"); assert.equal(p[5].state, "enskild");
  assert.ok(!("name" in p[4]) && !("city" in p[4]) && !("domain" in p[4]), "enskild firma: inget namn/ort ut");
  assert.equal(p[6].state, "ej_avlast"); assert.equal(p[7].state, "saknas"); assert.equal(p[8].state, "ingen");
  const q = identityProposals(rep([ident(), ident({ fields: { name: F("Annat AB"), city: F(null), web: F(null) } })]));
  assert.equal(q[0].state, "auto"); assert.deepEqual([q[0].name, q[0].city, q[0].domain], ["Nord Bygg AB", "Malmö", "nordbygg.se"]);
  assert.equal(q[1].state, "bekrafta"); assert.equal(q[1].reason, "ort_saknas");
  for (const x of p.concat(q)) assert.ok(!/orgnr|556016|phone|address|0470/.test(JSON.stringify(x)), "inga orgnr/telefon/adress i förslag");
});

test("rutt /sources/identity: 409 före leverans, token krävs, förslag efter leverans utan orgnr/adress/telefon; origin lagras och kundens uppgifter vinner", async () => {
  const env = makeEnv(ON); const f = installFetch();
  try {
    const { orderId, token } = await readyOrder(env, [S(100000), S(110000, { name: "Andra Bygg AB", orgnr: "556677-8899", city: null })]);
    assert.equal((await src(env, orderId, token, "/identity")).status, 409);
    assert.ok([401, 403, 404].includes((await src(env, orderId, "fel-token", "/identity")).status));
    assert.equal((await startCheckout(env, orderId, token)).status, 200);
    await webhook(env, "checkout.session.completed", paidSession([...f.sessions.values()].pop()));
    for (let i = 0; i < 40; i++) { const o = (await api(env, "GET", `/compare/orders/${orderId}`, { token })).json.order; if (o.status === "delivered") break; await env.COMPARE_ORDERS.runAlarms(); }
    const r = await src(env, orderId, token, "/identity");
    assert.equal(r.status, 200); assert.equal(r.json.proposals.length, 2);
    assert.equal(r.json.proposals[0].state, "auto"); assert.equal(r.json.proposals[0].name, "Testbygg AB"); assert.equal(r.json.proposals[0].city, "Växjö");
    assert.equal(r.json.proposals[1].state, "bekrafta"); assert.equal(r.json.proposals[1].reason, "ort_saknas");
    assert.ok(!/556016|0470|Storgatan/.test(JSON.stringify(r.json)), "inga orgnr/adress/telefon i svaret");
    // origin: dokument lagras; kundens egen rad ersätter
    const put = await src(env, orderId, token, "/firms", "PUT", { firms: [{ offerIndex: 0, name: "Testbygg AB", city: "Växjö", domain: "testbygg.example.se", origin: "dokument" }, { offerIndex: 1, name: "Egen Firma", city: "Lund", origin: "något-konstigt" }] });
    assert.equal(put.status, 200);
    const o = Object.fromEntries(put.json.sources.firms.map((x) => [x.name, x.origin]));
    assert.equal(o["Testbygg AB"], "dokument"); assert.equal(o["Egen Firma"], "kund", "okänt origin blir kund");
  } finally { f.restore(); }
});

test("identitetsbyte (Ändra företag) nollställer gammal källmatch; oförändrad identitet behåller den", async () => {
  const env = makeEnv(ON); const f = installFetch();
  f.ctl.googlePlaces = [{ id: placeId("a"), displayName: { text: "Testbygg AB" }, formattedAddress: "Syntetvägen 1, Växjö" }];
  try {
    const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
    const firm = { offerIndex: 0, name: "Testbygg AB", city: "Växjö", domain: "testbygg.example.se", origin: "dokument" };
    const fid = (await src(env, orderId, token, "/firms", "PUT", { firms: [firm] })).json.sources.firms[0].id;
    await src(env, orderId, token, "/google/search", "POST", { firmId: fid });
    assert.equal((await src(env, orderId, token, "/google/confirm", "POST", { firmId: fid, placeId: placeId("a"), via: "candidate" })).status, 200);
    const same = (await src(env, orderId, token, "/firms", "PUT", { firms: [firm] })).json.sources.firms[0];
    assert.equal(same.google.confirmed, true, "samma identitet behåller bekräftad källa");
    const changed = (await src(env, orderId, token, "/firms", "PUT", { firms: [{ ...firm, name: "Helt Annan Bygg AB", origin: "kund" }] })).json.sources.firms[0];
    assert.equal(changed.google.confirmed, false, "ändrad identitet nollställer gammal match"); assert.equal(changed.origin, "kund");
  } finally { f.restore(); }
});

test("personnummerliknande orgnr som inte klarar kontrollsiffran behandlas ändå försiktigt som enskild firma (aldrig namnförslag)", () => {
  const o = sanitizeOffer(fixtureResponse({ extracted: { totalBeforeRotSek: 100000, totalVatBasis: "inkl" }, scope: ALL, issuer: { name: "Karl Karlsson", orgnr: "850101-1234" } }));
  assert.equal(o.identity.personal, true); assert.equal(o.identity.legalForm, "enskild"); assert.equal(o.identity.sendable, false);
  assert.deepEqual(identityProposals({ offers: [o], identityGroups: { conflicts: [] } }), [{ offerIndex: 0, state: "enskild" }]);
});
