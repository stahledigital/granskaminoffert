// D16-R2 fix2 (offline): testordrar går ALLTID mot Stripe TEST (statusavstämning, retrieveSession/Refund, /paid-reconcile, DO-återbetalning) – aldrig livenyckel, ingen fallback,
// även när testfönstret gått ut; saknad testnyckel ⇒ neka. Testordrar utesluts ur ordinarie bokföringsexport (explicit test-only-diagnostik). Syntetiska värden, ingen leverantör.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, installFetch, api, readyOrder, startCheckout, paidSession, webhook, upload } from "./helpers/compare_env.mjs";

const ADMIN = "a".repeat(32), TSK = "sk_test_TESTCHAINabcdefgh", TWH = "whsec_TESTCHAINsecret12345678", GLOBAL = "sk_test_GLOBALPRIMARYkey1234";
const MAIL_WH = "whsec_" + btoa("TESTONLY-synthetic-resend-wh-secret-0123456789");
const ON = { COMPARE_MAILER_MODE: undefined, COMPARE_MAIL_HTTP: "1", COMPARE_MAIL_HTTP_VERIFIED: "1", COMPARE_MAIL_FROM: "Jämför <jamfor@example.test>", COMPARE_MAIL_DAY_CAP: "20", COMPARE_MAIL_API_KEY: "re_TESTONLY_syntheticKey0123456789", COMPARE_MAIL_WEBHOOK_SECRET: MAIL_WH };
const SELLER = { COMPARE_SELLER_FORM: "AB", COMPARE_SELLER_NAME: "Syntetisk Säljare AB", COMPARE_SELLER_ORGNR: "556000-0001", COMPARE_SELLER_EMAIL: "kontakt@example.test", COMPARE_SELLER_ADDRESS: "Exempelgatan 1, 111 11 Teststad", COMPARE_SELLER_PHONE: "+46 8 000 00 00", COMPARE_COMPANY_INFO_URL: "https://example.test/foretagsuppgifter" };
const TC = { COMPARE_TEST_CHAIN: "1", COMPARE_TEST_CHAIN_UNTIL: new Date(Date.now() + 6 * 3600_000).toISOString(), STRIPE_TEST_SECRET_KEY: TSK, STRIPE_TEST_WEBHOOK_SECRET: TWH, COMPARE_ADMIN_TOKEN: ADMIN, STRIPE_SECRET_KEY: GLOBAL };
const mk = () => makeEnv({ ...SELLER, ...ON, ...TC });
const S = (t) => ({ extracted: { totalBeforeRotSek: t, totalVatBasis: "inkl" }, scope: { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" } });
const A = { authorization: "Bearer " + ADMIN };
const store = (env, id) => env.COMPARE_ORDERS.peek(id).store;
function spy() { const calls = []; const inner = globalThis.fetch; globalThis.fetch = async (i, init = {}) => { const u = typeof i === "string" ? i : i.url; if (u.startsWith("https://api.stripe.com/")) calls.push({ u, m: (init.method || "GET"), k: String((init.headers && (init.headers.authorization || init.headers.Authorization)) || "") }); return inner(i, init); }; return calls; }
async function testOrder(env) {
  const c = await api(env, "POST", "/compare/admin/test-order", { origin: "", headers: A }); assert.equal(c.status, 201);
  const { orderId, token } = c.json;
  for (let i = 0; i < 2; i++) assert.equal((await upload(env, orderId, token, i, S(100000 + i * 10000))).status, 200);
  const co = await api(env, "POST", `/compare/admin/test-order/${orderId}/checkout`, { origin: "", headers: A, body: { token } }); assert.equal(co.status, 200, JSON.stringify(co.json));
  return { orderId, token, sess: [...global.__f.sessions.values()].pop() };
}
const status = (env, id, token) => api(env, "GET", `/compare/orders/${id}`, { token });
const mkF = () => { const f = installFetch(); global.__f = f; return f; };

test("statusavstämning av testorder: retrieveSession med TESTnyckel, /paid kräver viaTestHook ⇒ betald; global nyckel används aldrig", async () => {
  const f = mkF(); try {
    const env = mk(); const calls = spy();
    const { orderId, token, sess } = await testOrder(env);
    Object.assign(sess, { status: "complete", payment_status: "paid", payment_intent: "pi_test_0000000001" });
    const r = await status(env, orderId, token); assert.equal(r.status, 200);
    assert.equal(r.json.order.status, "paid", "testordern betald via avstämning");
    assert.ok(calls.length >= 2 && calls.every((c) => c.k.includes(TSK) && !c.k.includes("GLOBALPRIMARY")), "alla Stripe-anrop (checkout + avstämning) med testnyckeln");
    assert.equal(r.json.testOrder, undefined, "intern testmarkör läcker inte till klienten");
  } finally { f.restore(); }
});

test("även efter att testfönstret gått ut används testnyckeln; saknas den nekas avstämningen helt (inget Stripe-anrop, aldrig live)", async () => {
  const f = mkF(); try {
    const env = mk(); const calls = spy();
    const { orderId, token, sess } = await testOrder(env);
    Object.assign(sess, { status: "complete", payment_status: "paid", payment_intent: "pi_test_0000000001" });
    env.COMPARE_TEST_CHAIN_UNTIL = new Date(Date.now() - 1000).toISOString(); // fönstret slut
    const n0 = calls.length;
    delete env.STRIPE_TEST_SECRET_KEY;
    const r = await status(env, orderId, token);
    assert.equal(r.json.order.status, "awaiting_payment", "ingen avstämning utan testnyckel");
    assert.equal(calls.length, n0, "inget Stripe-anrop alls (varken test eller live)");
    env.STRIPE_TEST_SECRET_KEY = TSK; // nyckeln finns kvar men gaten är utgången ⇒ avläsning fortsatt med TESTnyckel
    const r2 = await status(env, orderId, token);
    assert.equal(r2.json.order.status, "paid");
    assert.ok(calls.slice(n0).every((c) => c.k.includes(TSK)), "efter utgång: fortsatt testnyckel, aldrig global");
  } finally { f.restore(); }
});

test("återbetalning av testorder: testnyckel; utan testnyckel ingen återbetalning och aldrig livenyckel (state needed)", async () => {
  const f = mkF(); try {
    const env = mk(); const calls = spy();
    const { orderId, sess } = await testOrder(env);
    assert.equal((await api(env, "POST", "/compare/webhook-test", { origin: "", ...(await (async () => { const raw = JSON.stringify({ id: "evt_t1", type: "checkout.session.completed", data: { object: paidSession(sess) } }); const { signForTest } = await import("../src/compare_stripe.js"); return { raw, headers: { "stripe-signature": await signForTest(raw, TWH), "content-type": "application/json" } }; })()) })).status, 200);
    const obj = env.COMPARE_ORDERS.peek(orderId).obj;
    const rc = { paymentIntentId: "pi_test_0000000001", orderId, test: true };
    const n0 = calls.length;
    await obj._runRefund(rc);
    const rf = calls.slice(n0).filter((c) => c.u.includes("/refunds"));
    assert.equal(rf.length, 1); assert.ok(rf[0].k.includes(TSK) && !rf[0].k.includes("GLOBALPRIMARY"));
    delete env.STRIPE_TEST_SECRET_KEY; const n1 = calls.length;
    await obj._runRefund(rc);
    assert.equal(calls.length, n1, "ingen Stripe-anrop utan testnyckel");
    assert.equal(store(env, orderId).get("order").refund.state, "needed", "okänt utfall ⇒ needed, aldrig live-fallback");
    assert.ok(calls.every((c) => !c.k.includes("GLOBALPRIMARY")));
  } finally { f.restore(); }
});

test("bokföringsexport: testorder utesluts som standard, visas bara i ?test=only med testflagga; riktiga ordrar oförändrade", async () => {
  const f = mkF(); try {
    const env = mk();
    const real = await readyOrder(env, [S(100000), S(110000)]);
    assert.equal((await startCheckout(env, real.orderId, real.token)).status, 200);
    const rs = [...f.sessions.values()].pop();
    assert.equal((await webhook(env, "checkout.session.completed", paidSession(rs))).status, 200);
    const t = await testOrder(env);
    const { signForTest } = await import("../src/compare_stripe.js");
    const raw = JSON.stringify({ id: "evt_t2", type: "checkout.session.completed", data: { object: paidSession(t.sess, { payment_intent: "pi_test_0000000002" }) } });
    assert.equal((await api(env, "POST", "/compare/webhook-test", { raw, origin: "", headers: { "stripe-signature": await signForTest(raw, TWH), "content-type": "application/json" } })).status, 200);
    const month = new Date().toISOString().slice(0, 7);
    const std = await api(env, "GET", `/compare/admin/ledger?month=${month}`, { origin: "", headers: A });
    assert.deepEqual(std.json.rows.map((r) => r.orderId), [real.orderId], "ordinarie export: bara riktiga ordrar");
    assert.equal(std.json.rows[0].test, false);
    const only = await api(env, "GET", `/compare/admin/ledger?month=${month}&test=only`, { origin: "", headers: A });
    assert.deepEqual(only.json.rows.map((r) => r.orderId), [t.orderId]); assert.equal(only.json.rows[0].test, true);
  } finally { f.restore(); }
});
