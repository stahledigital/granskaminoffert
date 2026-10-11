// Recensionsdelta (offline): idempotent rapport-klart-mejl (ingen rapporttext, 24 h resultatlänk via outbox/Resend/mail-events), resultattoken ger bara rapportläsning, adminåterhämtning för testorder, explicit testkälla i exporten.
import { test } from "node:test";
import assert from "node:assert/strict";
import { signForTest } from "../src/compare_stripe.js";
import { TEST_CHAIN_TO } from "../src/compare_config.js";
import { makeEnv, installFetch, api, readyOrder, startCheckout, paidSession, webhook, upload, flushMailEvents, MAIL_WH_SECRET, pdfText, pdfLinks, norm } from "./helpers/compare_env.mjs";

const ADMIN = "a".repeat(32), TSK = "sk_test_TESTCHAINabcdefgh", TWH = "whsec_TESTCHAINsecret12345678";
const ON = { COMPARE_MAILER_MODE: undefined, COMPARE_MAIL_HTTP: "1", COMPARE_MAIL_HTTP_VERIFIED: "1", COMPARE_MAIL_FROM: "Jämför <jamfor@example.test>", COMPARE_MAIL_DAY_CAP: "20", COMPARE_MAIL_API_KEY: "re_TESTONLY_syntheticKey0123456789", COMPARE_MAIL_WEBHOOK_SECRET: MAIL_WH_SECRET };
const SELLER = { COMPARE_SELLER_FORM: "AB", COMPARE_SELLER_NAME: "Syntetisk Säljare AB", COMPARE_SELLER_ORGNR: "556000-0001", COMPARE_SELLER_EMAIL: "kontakt@example.test", COMPARE_SELLER_ADDRESS: "Exempelgatan 1, 111 11 Teststad", COMPARE_SELLER_PHONE: "+46 8 000 00 00", COMPARE_COMPANY_INFO_URL: "https://example.test/foretagsuppgifter" };
const TC = { COMPARE_TEST_CHAIN: "1", COMPARE_TEST_CHAIN_UNTIL: new Date(Date.now() + 6 * 3600_000).toISOString(), STRIPE_TEST_SECRET_KEY: TSK, STRIPE_TEST_WEBHOOK_SECRET: TWH, COMPARE_ADMIN_TOKEN: ADMIN };
const mk = () => makeEnv({ ...SELLER, ...ON, ...TC });
const S = (t) => ({ extracted: { totalBeforeRotSek: t, totalVatBasis: "inkl" }, scope: { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" } });
const A = { authorization: "Bearer " + ADMIN };
const store = (env, id) => env.COMPARE_ORDERS.peek(id).store;
const LINK = /#o=(o_[0-9a-f]{32})&r=([A-Za-z0-9_-]{32})/;

async function testHook(env, session, id) {
  const raw = JSON.stringify({ id: "evt_" + id, type: "checkout.session.completed", data: { object: session } });
  return api(env, "POST", "/compare/webhook-test", { raw, origin: "", headers: { "stripe-signature": await signForTest(raw, TWH), "content-type": "application/json" } });
}
async function deliverTestOrder(env, f, { noReportMail = false, seed = null } = {}) {
  const c = await api(env, "POST", "/compare/admin/test-order", { origin: "", headers: A }); assert.equal(c.status, 201);
  const { orderId, token } = c.json;
  for (let i = 0; i < 2; i++) assert.equal((await upload(env, orderId, token, i, S(100000 + i * 10000))).status, 200);
  if (seed) await seed(env, orderId);
  assert.equal((await api(env, "POST", `/compare/admin/test-order/${orderId}/checkout`, { origin: "", headers: A, body: { token } })).status, 200);
  const sess = [...f.sessions.values()].pop();
  assert.equal((await testHook(env, paidSession(sess), orderId.slice(2, 10))).status, 200);
  await env.COMPARE_ORDERS.runAlarms(1);              // skickar avtalsbekräftelsen
  assert.ok((await flushMailEvents(env, f)) >= 1);      // signerad delivered öppnar startgrinden
  const ru = env.COMPARE_RETURN_URL; if (noReportMail) delete env.COMPARE_RETURN_URL; // simulerar leverans före fixen (ingen länkbas ⇒ inget rapportmejl köas)
  await env.COMPARE_ORDERS.runAlarms(5);
  env.COMPARE_RETURN_URL = ru;                // pipeline → delivered → rapport-klart-mejl köas → skickas
  return { orderId, token };
}
const reportMails = (f) => f.log.mailSent.filter((m) => String(m.body.subject || "").includes("jämförelse är klar") || (m.body.tags || []).some((t) => String(t.value).startsWith("mail_rapport_")));


import { REVIEW_VARS, GOOGLE_VARS, TP_VARS } from "./helpers/compare_env.mjs";
import { identityProposals, googleCandidates, sourcesConfig } from "../src/compare_sources.js";
const RV = { ...REVIEW_VARS, ...GOOGLE_VARS, ...TP_VARS };
const reportOf = (env, id) => JSON.parse(env.REVIEWS_KV.m.get(store(env, id).get("order").reportKey));

import { applyOp, emptySources } from "../src/compare_sources.js";
const PID = "ChIJ" + "x".repeat(24);
// Frö: firma för offert 0 (och valfritt kundens Google-bekräftelse), exakt som /sources-op skulle ha sparat dem före köpet.
const seedFirm = (confirm) => async (env, id) => {
  let st = emptySources();
  st = (await applyOp({}, st, { type: "set_firms", firms: [{ offerIndex: 0, name: "Byggfirma A", city: "Teststad", domain: "bygg-a.example.test", origin: "bekraftad" }] })).state;
  if (confirm) st = (await applyOp({}, st, { type: "confirm_google", firmId: st.firms[0].id, placeId: PID, via: "manual", seen: true, now: Date.UTC(2026, 9, 11, 19, 30) })).state;
  await store(env, id).set("sources", st);
};

test("D07-rättelse: sourceCards och PDF följer FAKTISK källstatus per offert (envflagga räcker inte); inaktiv Trustpilot nämns aldrig; offentlig profil bara efter kundbekräftelse; inga omdömen/betyg/widget", async () => {
  const cases = [
    { name: "av", vars: {}, seed: null, states: ["ej_aktiverad", "ej_aktiverad"] },
    { name: "på utan bekräftad firma", vars: { ...REVIEW_VARS, ...GOOGLE_VARS }, seed: null, states: ["ej_bekraftad", "ej_bekraftad"] },
    { name: "Google på, TP av, firma ej bekräftad", vars: { ...REVIEW_VARS, ...GOOGLE_VARS }, seed: seedFirm(false), states: ["ej_bekraftad", "ej_bekraftad"] },
    { name: "Google på, TP av, bekräftad profil offert 1", vars: { ...REVIEW_VARS, ...GOOGLE_VARS }, seed: seedFirm(true), states: ["bekraftad", "ej_bekraftad"] },
    { name: "Google+TP på, bekräftad profil", vars: RV, seed: seedFirm(true), states: ["bekraftad", "ej_bekraftad"] },
  ];
  for (const c of cases) {
    const f = installFetch(); try {
      const env = makeEnv({ ...SELLER, ...ON, ...TC, ...c.vars }); const { orderId } = await deliverTestOrder(env, f, { seed: c.seed });
      const rep = reportOf(env, orderId);
      assert.deepEqual(rep.sourceCards.map((x) => x.state), c.states, c.name);
      assert.ok(rep.sourcesFrozenAt, "frysningstid");
      const rm = reportMails(f); assert.equal(rm.length, 1);
      const t = norm(pdfText(rm[0].body.attachments[0].content));
      const conf = rep.sourceCards[0].google.profileUrl;
      if (c.states[0] === "bekraftad") {
        assert.ok(conf && conf.startsWith("https://www.google.com/maps/search/?api=1&query=") && conf.includes("query_place_id=" + PID), "officiell place_id-länk");
        assert.match(t, /Byggfirma A, Teststad, bygg-a\.example\.test/); assert.match(t, /Google: kundbekräftad offentlig profil \(bekräftad 2026-10-11 19:30 UTC\)/);
        assert.ok(t.replace(/\s+/g, "").includes("query_place_id=" + PID), "profillänk i PDF");
        assert.match(t, /Google: ingen firma bekräftad för den här offerten/);
        assert.match(t, /inte i den här PDF:en|inte i den här PDF/);
      } else if (c.name === "av") assert.match(t, /visas inte i den här versionen/);
      else assert.match(t, /Google: ingen firma bekräftad för den här offerten|Google: väntar på att du bekräftar rätt firma/);
      if (!c.vars.TRUSTPILOT_DISPLAY) assert.ok(!/trustpilot/i.test(t), `${c.name}: inaktiv Trustpilot får inte nämnas i PDF`);
      assert.ok(!/trustscore|stjärn|\d,\d av 5|SYNTETISK TEXT/i.test(t), "inget källinnehåll i PDF");
      assert.ok(!JSON.stringify(rep).match(/SYNTETISK TEXT|trustScore|rating|reviewCount/i), "ingen omdömesdata i rapportdata");
      assert.ok(!(c.states[0] !== "bekraftad" && /query_place_id/.test(JSON.stringify(rep))), "ingen profillänk utan kundbekräftelse");
    } finally { f.restore(); }
  }
});

test("D07-rättelse: efterhandsomval visas som aktuell status (sourceLive, ändrad sedan leverans) via befintliga rapportrutten – även med resultattoken – medan frusen rapport/PDF är oförändrad; ingen /sources-åtkomst för r-token", async () => {
  const f = installFetch(); try {
    const env = makeEnv({ ...SELLER, ...ON, ...TC, ...REVIEW_VARS, ...GOOGLE_VARS }); const { orderId, token } = await deliverTestOrder(env, f, { seed: seedFirm(false) });
    const rt = LINK.exec(String(reportMails(f)[0].body.text || ""))[2];
    const before = JSON.stringify(reportOf(env, orderId));
    for (const tk of [token, rt]) { const r = await api(env, "GET", `/compare/orders/${orderId}/report`, { token: tk }); assert.equal(r.status, 200); assert.equal(r.json.sourceLive.changedSinceDelivery, false); assert.equal(r.json.sourceLive.cards[0].state, "ej_bekraftad"); }
    // kunden bekräftar profilen EFTER leverans (fulltoken-operationen finns redan: ordervärdet skrivs, ingen auth ändras)
    const st = store(env, orderId).get("sources"); const id0 = st.firms[0].id;
    const op = await api(env, "POST", `/compare/orders/${orderId}/sources/google/confirm`, { token, body: { firmId: id0, placeId: PID, via: "manual", seen: true } });
    assert.ok([200, 409, 400].includes(op.status), "bekräftelse via befintlig väg (eller avslag av befintlig regel): " + op.status);
    if (op.status !== 200) await store(env, orderId).set("sources", (await applyOp({}, store(env, orderId).get("sources"), { type: "confirm_google", firmId: id0, placeId: PID, via: "manual", seen: true, now: Date.now() })).state);
    for (const tk of [token, rt]) {
      const r = await api(env, "GET", `/compare/orders/${orderId}/report`, { token: tk }); assert.equal(r.status, 200);
      assert.equal(r.json.sourceLive.changedSinceDelivery, true, "ändrad efter leverans"); assert.equal(r.json.sourceLive.cards[0].state, "bekraftad"); assert.ok(r.json.sourceLive.cards[0].google.profileUrl.includes(PID));
      assert.equal(r.json.report.sourceCards[0].state, "ej_bekraftad", "frusen revision oförändrad"); assert.equal(r.json.report.sourcesFrozenAt, JSON.parse(before).sourcesFrozenAt);
    }
    assert.equal(JSON.stringify(reportOf(env, orderId)), before, "lagrad rapport (och därmed PDF/hash) ändras aldrig");
    assert.equal((await api(env, "GET", `/compare/orders/${orderId}/sources`, { token: rt })).status, 404, "r-token når fortfarande inte /sources");
  } finally { f.restore(); }
});

test("recensionsdelta NEGATIV: resultattoken (rapportlänken) och fel/saknad token når aldrig /sources – ingen läsning, mount, sök eller bekräftelse", async () => {
  const f = installFetch(); try {
    const env = makeEnv({ ...SELLER, ...ON, ...TC, ...RV }); const { orderId, token } = await deliverTestOrder(env, f);
    const r = LINK.exec(String(reportMails(f)[0].body.text || "")); assert.ok(r); const rt = r[2];
    const ok = await api(env, "GET", `/compare/orders/${orderId}/sources`, { token }); assert.equal(ok.status, 200);
    for (const [m, sub, b] of [["GET", "", undefined], ["POST", "/google/mount", { firmId: "x", kind: "details", mountId: "m" + "a".repeat(20) }], ["POST", "/google/search", { firmId: "x" }], ["POST", "/google/confirm", { firmId: "x", placeId: "ChIJ" + "a".repeat(24), via: "manual", seen: true }], ["POST", "/trustpilot/latest", { firmId: "x" }], ["POST", "/unconfirm", { firmId: "x", provider: "google" }]]) {
      const x = await api(env, m, `/compare/orders/${orderId}/sources${sub}`, { token: rt, body: b }); assert.equal(x.status, 404, `${m} ${sub} med resultattoken`);
      const y = await api(env, m, `/compare/orders/${orderId}/sources${sub}`, { token: "z".repeat(32), body: b }); assert.equal(y.status, 404, `${m} ${sub} fel token`);
    }
    assert.equal((await api(env, "GET", `/compare/orders/${orderId}/report`, { token: rt })).status, 200, "resultattoken läser fortfarande rapporten");
  } finally { f.restore(); }
});

test("recensionsdelta: firmaförslag bär aldrig orgnr/adress (D11-invariant), källsökningen skickar aldrig orgnr/adress/telefon – bara namn + ort; ingen tyst första kandidat", async () => {
  const fld = (v) => ({ status: "framgar", value: v });
  const rep = { offers: [{ identity: { state: "komplett", role: "utforare", legalForm: "ab", fields: { name: fld("Bygg Exempel AB"), city: fld("Teststad"), web: fld("bygg-exempel.example.test"), orgnr: fld("556000-0001"), address: fld("Gatan 1, 111 11 Teststad"), phone: fld("08-123 45 67") } } }] };
  const p = identityProposals(rep)[0]; assert.equal(p.state, "auto"); assert.ok(!("orgnr" in p) && !("address" in p) && !("phone" in p), "förslagen bär aldrig orgnr/adress/telefon (D11-invariant)");
  const env = makeEnv(RV); const cfg = sourcesConfig(env); const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (u, init) => { calls.push({ u: String(u), body: init && init.body }); return new Response(JSON.stringify({ places: [{ id: "ChIJ" + "b".repeat(24), displayName: { text: "Bygg Exempel AB" }, formattedAddress: "Gatan 1, Teststad" }] }), { status: 200 }); };
  try {
    const r = await googleCandidates(env, cfg, { name: p.name, city: p.city, domain: p.domain });
    assert.equal(r.outcome, "flera", "även en enda träff kräver kundens bekräftelse (aldrig tyst val)"); assert.equal(r.candidates.length, 1);
    assert.equal(calls.length, 1); const sent = String(calls[0].body); assert.equal(JSON.parse(sent).textQuery, "Bygg Exempel AB Teststad");
    assert.ok(!/556000|Gatan|08-123/.test(sent), "orgnr/adress/telefon lämnar aldrig oss");
  } finally { globalThis.fetch = orig; }
});
