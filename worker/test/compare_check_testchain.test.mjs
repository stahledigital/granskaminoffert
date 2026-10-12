// D17 testkedja: adminskyddade testvägen stöder kind:"check" (EN syntetisk offert), korrekt checksnapshot/hash/Stripeprodukt, oförändrad auth/tak/mottagare; jämförelsens beteende oförändrat; fel produkt/live nekas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { signForTest } from "../src/compare_stripe.js";
import { TEST_CHAIN_TO, CHECK_OFFER } from "../src/compare_config.js";
import { makeEnv, installFetch, api, upload, paidSession, flushMailEvents, MAIL_WH_SECRET, consentOf } from "./helpers/compare_env.mjs";
const ADMIN = "a".repeat(32), TSK = "sk_test_TESTCHAINabcdefgh", TWH = "whsec_TESTCHAINsecret12345678";
const ON = { COMPARE_MAILER_MODE: undefined, COMPARE_MAIL_HTTP: "1", COMPARE_MAIL_HTTP_VERIFIED: "1", COMPARE_MAIL_FROM: "Jämför <jamfor@example.test>", COMPARE_MAIL_DAY_CAP: "20", COMPARE_MAIL_API_KEY: "re_TESTONLY_syntheticKey0123456789", COMPARE_MAIL_WEBHOOK_SECRET: MAIL_WH_SECRET };
const SELLER = { COMPARE_SELLER_FORM: "AB", COMPARE_SELLER_NAME: "Syntetisk Säljare AB", COMPARE_SELLER_ORGNR: "556000-0001", COMPARE_SELLER_EMAIL: "kontakt@example.test", COMPARE_SELLER_ADDRESS: "Exempelgatan 1, 111 11 Teststad", COMPARE_SELLER_PHONE: "+46 8 000 00 00", COMPARE_COMPANY_INFO_URL: "https://example.test/foretagsuppgifter" };
const TC = { COMPARE_TEST_CHAIN: "1", COMPARE_TEST_CHAIN_UNTIL: new Date(Date.now() + 6 * 3600_000).toISOString(), STRIPE_TEST_SECRET_KEY: TSK, STRIPE_TEST_WEBHOOK_SECRET: TWH, COMPARE_ADMIN_TOKEN: ADMIN };
const mk = (x = {}) => makeEnv({ COMPARE_CONSENT_POLICY: "P", ...SELLER, ...ON, ...TC, ...x });
const A = { authorization: "Bearer " + ADMIN };
const SPEC = { extracted: { jobType: "malning", areaM2: 30, laborSumSek: 20000, materialSumSek: 4000, totalBeforeRotSek: 29000, totalVatBasis: "inkl", rotAmountSek: 10000 }, scope: { material: "ingar", arbete: "ingar" } };
async function testHook(env, session, id) {
  const raw = JSON.stringify({ id: "evt_" + id, type: "checkout.session.completed", data: { object: session } });
  return api(env, "POST", "/compare/webhook-test", { raw, origin: "", headers: { "stripe-signature": await signForTest(raw, TWH), "content-type": "application/json" } });
}
const store = (env, id) => env.COMPARE_ORDERS.peek(id).store;

test("testkedja kind:check: admin skapar EN syntetisk förkontrollsorder, Stripe TEST-session för rätt produkt/pris, betald ⇒ levererad förkontroll med checksnapshot; mottagare fast", async () => {
  const f = installFetch(); try {
    const env = mk();
    const c = await api(env, "POST", "/compare/admin/test-order", { origin: "", headers: A, body: { kind: "check" } }); assert.equal(c.status, 201, JSON.stringify(c.json));
    const { orderId, token } = c.json; assert.equal(c.json.to, TEST_CHAIN_TO); assert.equal(c.json.test, true);
    const o0 = store(env, orderId).get("order"); assert.equal(o0.kind, "check"); assert.equal(o0.docCount, 1);
    assert.equal((await upload(env, orderId, token, 0, SPEC)).status, 200); assert.equal((await upload(env, orderId, token, 1, SPEC)).status === 200, false, "bara EN offert");
    const ck = await api(env, "POST", `/compare/admin/test-order/${orderId}/checkout`, { origin: "", headers: A, body: { token } }); assert.equal(ck.status, 200, JSON.stringify(ck.json)); assert.equal(ck.json.test, true);
    const sess = [...f.sessions.values()].pop(); const s = JSON.stringify(sess);
    assert.equal(sess.metadata.product, "check"); assert.equal(sess.amount_total, CHECK_OFFER.priceOre); assert.equal(sess.livemode, false, "Stripe TEST, aldrig live"); assert.ok(s.includes(orderId));
    assert.equal((await testHook(env, paidSession(sess), orderId.slice(2, 10))).status, 200);
    await env.COMPARE_ORDERS.runAlarms(1); await flushMailEvents(env, f).catch(() => {}); await env.COMPARE_ORDERS.runAlarms(8);
    const o = store(env, orderId).get("order"); assert.equal(o.status, "delivered", JSON.stringify(o.error)); assert.equal(o.kind, "check");
    const r = await api(env, "GET", `/compare/orders/${orderId}/report`, { token }); assert.equal(r.status, 200); assert.equal(r.json.report.kind, "check");
    const ag = JSON.stringify([...store(env, orderId)]); assert.ok(ag.includes("villkor-fk-1"), "checkens villkorsversion i avtalet"); assert.ok(ag.includes(TEST_CHAIN_TO));
  } finally { f.restore(); }
});

test("testkedja NEGATIV: ogiltig kind, ingen auth, testkedja av ⇒ nekas; jämförelsetestorder oförändrad (2 offerter, ej check); fel produkts samtycke (jämförelsens hash på check-order) nekas; taket gäller samma", async () => {
  const f = installFetch(); try {
    const env = mk();
    assert.equal((await api(env, "POST", "/compare/admin/test-order", { origin: "", headers: A, body: { kind: "foo" } })).status, 400);
    assert.equal((await api(env, "POST", "/compare/admin/test-order", { origin: "", body: { kind: "check" } })).status, 404, "ingen admin ⇒ 404");
    const off = mk({ COMPARE_TEST_CHAIN: undefined }); assert.equal((await api(off, "POST", "/compare/admin/test-order", { origin: "", headers: A, body: { kind: "check" } })).status, 404, "testkedjan av ⇒ 404");
    const live = makeEnv({ COMPARE_CONSENT_POLICY: "P", ...SELLER, COMPARE_PAYMENTS: "live", STRIPE_SECRET_KEY: "sk_live_SYNTHETICONLY", COMPARE_ADMIN_TOKEN: ADMIN }); assert.equal((await api(live, "POST", "/compare/admin/test-order", { origin: "", headers: A, body: { kind: "check" } })).status, 404, "live utan testkedja ⇒ 404");
    const cmp = await api(env, "POST", "/compare/admin/test-order", { origin: "", headers: A }); assert.equal(cmp.status, 201); const oc = store(env, cmp.json.orderId).get("order"); assert.equal(oc.docCount, 2); assert.notEqual(oc.kind, "check");
    const ch = await api(env, "POST", "/compare/admin/test-order", { origin: "", headers: A, body: { kind: "check" } }); assert.equal(ch.status, 201);
    assert.equal((await api(env, "POST", "/compare/admin/test-order", { origin: "", headers: A, body: { kind: "check" } })).status, 429, "samma tak 2 per 48 h");
    const cc = (await api(env, "GET", "/compare/config")).json; const wrong = cc.consent;
    const bad = await api(env, "POST", `/compare/orders/${ch.json.orderId}/checkout`, { token: ch.json.token, body: { accept: { terms: true, declaration: true, consentHash: wrong.hash, consentVersion: wrong.version, email: "kund@example.test" } } });
    assert.equal(bad.status, 409); assert.equal(bad.json.consentChanged, true);
    assert.equal(f.sessions.size, 0, "ingen Stripe-session skapad");
  } finally { f.restore(); }
});
