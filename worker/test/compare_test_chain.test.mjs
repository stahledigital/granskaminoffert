// D16-R2 (offline): administrativt spärrad TESTKEDJA på samma Worker/CompareOrders/pott. Allt mot HTTP-dubbel och SYNTETISKA värden – ingen leverantör, ingen riktig hemlighet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { signForTest } from "../src/compare_stripe.js";
import { testChain, TEST_CHAIN_TO } from "../src/compare_config.js";
import { makeEnv, installFetch, api, readyOrder, startCheckout, paidSession, webhook, upload, MAIL_WH_SECRET } from "./helpers/compare_env.mjs";

const ADMIN = "a".repeat(32);
const TSK = "sk_test_TESTCHAINabcdefgh", TWH = "whsec_TESTCHAINsecret12345678";
const ON = { COMPARE_MAILER_MODE: undefined, COMPARE_MAIL_HTTP: "1", COMPARE_MAIL_HTTP_VERIFIED: "1", COMPARE_MAIL_FROM: "Jämför <jamfor@example.test>", COMPARE_MAIL_DAY_CAP: "20", COMPARE_MAIL_API_KEY: "re_TESTONLY_syntheticKey0123456789", COMPARE_MAIL_WEBHOOK_SECRET: MAIL_WH_SECRET };
const SELLER = { COMPARE_SELLER_FORM: "AB", COMPARE_SELLER_NAME: "Syntetisk Säljare AB", COMPARE_SELLER_ORGNR: "556000-0001", COMPARE_SELLER_EMAIL: "kontakt@example.test", COMPARE_SELLER_ADDRESS: "Exempelgatan 1, 111 11 Teststad", COMPARE_SELLER_PHONE: "+46 8 000 00 00", COMPARE_COMPANY_INFO_URL: "https://example.test/foretagsuppgifter" };
const TC = { COMPARE_TEST_CHAIN: "1", COMPARE_TEST_CHAIN_UNTIL: new Date(Date.now() + 6 * 3600_000).toISOString(), STRIPE_TEST_SECRET_KEY: TSK, STRIPE_TEST_WEBHOOK_SECRET: TWH, COMPARE_ADMIN_TOKEN: ADMIN };
const mk = (extra = {}) => makeEnv({ ...SELLER, ...ON, ...TC, ...extra });
const S = (t) => ({ extracted: { totalBeforeRotSek: t, totalVatBasis: "inkl" }, scope: { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" } });
const A = { authorization: "Bearer " + ADMIN };
const store = (env, id) => env.COMPARE_ORDERS.peek(id).store;
async function testHook(env, type, session, secret = TWH) {
  const raw = JSON.stringify({ id: "evt_" + Math.random().toString(36).slice(2, 12), type, data: { object: session } });
  return api(env, "POST", "/compare/webhook-test", { raw, origin: "", headers: { "stripe-signature": await signForTest(raw, secret), "content-type": "application/json" } });
}
function spyKeys() { const keys = []; const inner = globalThis.fetch; globalThis.fetch = async (i, init = {}) => { const u = typeof i === "string" ? i : i.url; if (u.startsWith("https://api.stripe.com/")) keys.push((init.headers && (init.headers.authorization || init.headers.Authorization)) || ""); return inner(i, init); }; return keys; }

test("testChain: av som standard, kräver alla gater (tid ≤48 h, testnycklar, admintoken, riktig mejltransport)", () => {
  const e = mk();
  assert.equal(testChain(e).on, true);
  assert.equal(testChain({ ...e, COMPARE_TEST_CHAIN: undefined }).on, false);
  assert.equal(testChain({ ...e, COMPARE_TEST_CHAIN_UNTIL: new Date(Date.now() - 1000).toISOString() }).on, false, "utgången");
  assert.equal(testChain({ ...e, COMPARE_TEST_CHAIN_UNTIL: new Date(Date.now() + 49 * 3600_000).toISOString() }).on, false, ">48 h");
  assert.equal(testChain({ ...e, STRIPE_TEST_SECRET_KEY: "sk_live_" + "a".repeat(20) }).on, false, "livenyckel som testnyckel");
  assert.equal(testChain({ ...e, STRIPE_TEST_WEBHOOK_SECRET: "nej" }).on, false);
  assert.equal(testChain({ ...e, COMPARE_ADMIN_TOKEN: "kort" }).on, false);
  assert.equal(testChain({ ...e, COMPARE_MAIL_HTTP: undefined, COMPARE_MAILER_MODE: "mock" }).on, false, "mock-mejl räcker inte");
  assert.equal(testChain(makeEnv()).on, false);
});

test("stängd/oautentiserad: admin-rutter och testwebhook ger 404/503 utan testChain eller token", async () => {
  const f = installFetch(); try {
    const off = makeEnv({ ...SELLER, ...ON, COMPARE_ADMIN_TOKEN: ADMIN });
    assert.equal((await api(off, "POST", "/compare/admin/test-order", { origin: "", headers: A })).status, 404);
    assert.equal((await testHook(off, "checkout.session.completed", {})).status, 503);
    const env = mk();
    assert.equal((await api(env, "POST", "/compare/admin/test-order", { origin: "" })).status, 404, "ingen token");
    assert.equal((await api(env, "POST", "/compare/admin/test-order", { origin: "", headers: { authorization: "Bearer " + "b".repeat(32) } })).status, 404, "fel token");
    assert.equal((await testHook(env, "checkout.session.completed", {}, "whsec_FELHEMLIGHET123456")).status, 400);
  } finally { f.restore && f.restore(); }
});

test("hela testkedjan offline: admin skapar testorder, testnyckel används, live-webhook kan inte betala, testwebhook betalar, mejl endast till hej@, ledger märkt test, tak 2", async () => {
  const f = installFetch(); try {
    const env = mk(); const keys = spyKeys();
    const c = await api(env, "POST", "/compare/admin/test-order", { origin: "", headers: A });
    assert.equal(c.status, 201); assert.equal(c.json.to, TEST_CHAIN_TO);
    const { orderId, token } = c.json;
    assert.equal(store(env, orderId).get("order").test, true);
    for (let i = 0; i < 2; i++) assert.equal((await upload(env, orderId, token, i, S(100000 + i * 10000))).status, 200);
    // offentlig checkout får inte starta en testorder
    assert.notEqual((await startCheckout(env, orderId, token)).status, 200, "användarpublik checkout nekas för testorder");
    // admin-checkout: Stripe-anropet går med TESTnyckeln
    const co = await api(env, "POST", `/compare/admin/test-order/${orderId}/checkout`, { origin: "", headers: A, body: { token } });
    assert.equal(co.status, 200, JSON.stringify(co.json)); assert.match(co.json.url, /^https:\/\//);
    assert.ok(keys.some((k) => k.includes(TSK)), "testnyckeln användes"); assert.ok(!keys.some((k) => k.includes("sk_live_")));
    assert.equal(store(env, orderId).get("order").accept.contactEmail, TEST_CHAIN_TO);
    const sess = [...f.sessions.values()].pop();
    // live-webhooken (annan hemlighet/väg) kan inte betala testordern
    assert.equal((await webhook(env, "checkout.session.completed", paidSession(sess))).status, 400);
    assert.equal(store(env, orderId).get("order").paidAt, null);
    // testwebhooken betalar
    assert.equal((await testHook(env, "checkout.session.completed", paidSession(sess))).status, 200);
    const o = store(env, orderId).get("order");
    assert.equal(o.status, "paid"); assert.ok(o.paidAt);
    assert.equal(store(env, orderId).get("ledger").test, true);
    await env.COMPARE_ORDERS.runAlarms(1);
    assert.ok(f.log.mailSent.length >= 1);
    for (const m of f.log.mailSent) assert.deepEqual([].concat(m.body.to), [TEST_CHAIN_TO], "bara hej@stahledigital.se");
    // tak: högst 2 testordrar
    assert.equal((await api(env, "POST", "/compare/admin/test-order", { origin: "", headers: A })).status, 201);
    assert.equal((await api(env, "POST", "/compare/admin/test-order", { origin: "", headers: A })).status, 429);
  } finally { f.restore && f.restore(); }
});

test("testwebhooken kan aldrig betala en RIKTIG order (och admin-checkout nekar riktiga ordrar)", async () => {
  const f = installFetch(); try {
    const env = mk();
    const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
    assert.equal((await startCheckout(env, orderId, token)).status, 200);
    const sess = [...f.sessions.values()].pop();
    const r = await testHook(env, "checkout.session.completed", paidSession(sess));
    assert.equal(r.status, 400); assert.equal(r.json.reason, "testorder");
    assert.equal(store(env, orderId).get("order").paidAt, null);
    const a = await api(env, "POST", `/compare/admin/test-order/${orderId}/checkout`, { origin: "", headers: A, body: { token } });
    assert.notEqual(a.status, 200, "admin-checkout bara för testordrar");
  } finally { f.restore && f.restore(); }
});
