// D10: Swish som betalmetod via SAMMA Stripe Checkout/orderledger (49 kr inkl. moms, SEK, engångsköp). Lokal betalproviderdubbel – ingen riktig Stripe/Swish,
// ingen charge/refund/nyckel. Bara en signerad, serververifierad betald session (belopp 4900, SEK, orderbindning, tillåten metod) låser upp; redirect/QR/
// returnURL/pending/avbruten/misslyckad låser aldrig upp. Swish öppnas först när en människa satt COMPARE_SWISH_VERIFIED=1 (kontoåtkomst verifierad).
import { test } from "node:test";
import assert from "node:assert/strict";
import { paymentMethods, termsSnapshot, consentSnapshot } from "../src/compare_config.js";
import { makeEnv, installFetch, api, readyOrder, startCheckout, paidSession, webhook, consentOf } from "./helpers/compare_env.mjs";

const S = (t) => ({ extracted: { totalBeforeRotSek: t, totalVatBasis: "inkl" }, scope: { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" } });
const SW = { COMPARE_PAYMENT_METHODS: "card,swish", COMPARE_SWISH_VERIFIED: "1" };
const store = (env, id) => env.COMPARE_ORDERS.peek(id).store;
const status = async (env, id, token) => (await api(env, "GET", `/compare/orders/${id}`, { token })).json.order;
const form = (body) => new URLSearchParams(body);
async function begin(env, f) {
  const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
  assert.equal((await startCheckout(env, orderId, token)).status, 200);
  return { orderId, token, sess: [...f.sessions.values()].pop() };
}
// Lokal Swish-/Stripe-dubbel för sessionen: tillstånd som en riktig leverantör kan visa. Ingen av dem låser upp utom "betald" via signerad webhook.
const swishApproved = (sess, over = {}) => paidSession({ ...sess, payment_method_types: ["swish"] }, over);

test("metodkonfiguration: standard = bara kort; Swish kräver BÅDE metodval och mänsklig verifiering; ogiltigt faller tillbaka till kort; dynamiskt utelämnar listan", () => {
  assert.deepEqual(paymentMethods({}).types, ["card"]);
  assert.equal(paymentMethods({ COMPARE_PAYMENT_METHODS: "card,swish" }).swish, false);
  assert.equal(paymentMethods({ COMPARE_PAYMENT_METHODS: "card,swish" }).swishBlocked, true, "begärd men ej verifierad ⇒ stängd");
  assert.equal(paymentMethods({ COMPARE_SWISH_VERIFIED: "1" }).swish, false, "verifiering utan metodval öppnar inget");
  assert.deepEqual(paymentMethods(SW).types, ["card", "swish"]);
  assert.deepEqual(paymentMethods({ COMPARE_PAYMENT_METHODS: "swish,card", COMPARE_SWISH_VERIFIED: "1" }).types, ["card", "swish"]);
  assert.equal(paymentMethods({ COMPARE_PAYMENT_METHODS: "dynamic", COMPARE_SWISH_VERIFIED: "1" }).types, null);
  assert.equal(paymentMethods({ COMPARE_PAYMENT_METHODS: "dynamic" }).swish, false);
  for (const bad of ["swish", "klarna", "card,klarna", "card,swish,klarna", "1", "{}"]) assert.deepEqual(paymentMethods({ COMPARE_PAYMENT_METHODS: bad, COMPARE_SWISH_VERIFIED: "1" }).types, ["card"], bad);
});

test("kundtext och samtycke: Swish-texten (Stripe kan visas som mottagare, Ståhle Digital i meddelandet) finns bara när Swish är på och ingår då i samtyckeshashen", async () => {
  const off = makeEnv(), on = makeEnv(SW), blocked = makeEnv({ COMPARE_PAYMENT_METHODS: "card,swish" });
  const cOff = (await api(off, "GET", "/compare/config")).json, cOn = (await api(on, "GET", "/compare/config")).json, cBl = (await api(blocked, "GET", "/compare/config")).json;
  assert.deepEqual(cOff.payment, { methods: ["card"], swish: false, swishNote: null }); assert.deepEqual(cBl.payment, cOff.payment);
  assert.deepEqual(cOn.payment.methods, ["card", "swish"]); assert.match(cOn.payment.swishNote, /kan Stripe visas som mottagare och Ståhle Digital i meddelandet/);
  assert.doesNotMatch(cOn.payment.swishNote, /Nordea|direkt hos Nordea/);
  assert.match(JSON.stringify(cOn.terms), /Swish/); assert.doesNotMatch(JSON.stringify(cOff.terms), /Swish/);
  assert.notEqual(cOn.consent.hash, cOff.consent.hash, "kunden godkänner exakt den text som gäller");
  assert.equal(cOn.offer.priceOre, 4900); assert.equal(cOn.offer.currency, "sek");
});

test("Checkout-parametrar: kort+swish i explicit lista, SEK 4900, samma orderledger; kort-läget har ingen swish; dynamiskt utelämnar listan; kortläget behåller gamla idempotensnyckeln", async () => {
  for (const [vars, want, idemRe] of [[{}, ["card"], /^checkout:o_[0-9a-f]{32}:1$/], [SW, ["card", "swish"], /^checkout:o_[0-9a-f]{32}:1:card\+swish$/], [{ COMPARE_PAYMENT_METHODS: "dynamic", COMPARE_SWISH_VERIFIED: "1" }, null, /:1:dyn$/]]) {
    const f = installFetch();
    try {
      const env = makeEnv(vars); const { orderId, sess } = await begin(env, f);
      const c = f.log.stripeCreate[0], p = form(c.body);
      assert.deepEqual([...p.keys()].filter((k) => k.startsWith("payment_method_types")).map((k) => p.get(k)), want || []);
      assert.equal(p.get("line_items[0][price_data][currency]"), "sek"); assert.equal(p.get("line_items[0][price_data][unit_amount]"), "4900"); assert.equal(p.get("mode"), "payment");
      assert.match(c.idem, idemRe);
      assert.deepEqual(store(env, orderId).get("order").stripe.methods, want);
      assert.equal(sess.amount_total, 4900);
    } finally { f.restore(); }
  }
});

test("Swish-flöde mot lokal dubbel: redirect/QR/returnURL/pending/avbruten/misslyckad låser ALDRIG upp; bara signerad betald session gör det, en gång", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(SW); const { orderId, token, sess } = await begin(env, f);
    const stat = async () => (await status(env, orderId, token)).status;
    // redirect/QR visas hos leverantören + kunden kommer tillbaka via returnURL utan att ha betalat: sessionen är öppen/obetald hos Stripe
    assert.equal(await stat(), "awaiting_payment");
    assert.equal(await stat(), "awaiting_payment", "avstämning mot Stripe (serverside) ser obetald session ⇒ ingen upplåsning");
    assert.ok(f.log.stripeGet.length >= 1, "returnsidan avgör inte: servern frågar Stripe");
    // pending = betalmetoden väntar på godkännande (obetald): signerad händelse completed/unpaid ger ingen leverans
    assert.equal((await webhook(env, "checkout.session.completed", { ...sess, payment_method_types: ["swish"], status: "complete", payment_status: "unpaid" })).status, 400);
    assert.equal(await stat(), "awaiting_payment");
    // avbruten/misslyckad i Swish: PaymentIntent tillbaka till requires_payment_method – ingen paid-händelse, bara ignorerad typ
    assert.equal((await webhook(env, "payment_intent.payment_failed", { id: "pi_x", object: "payment_intent", client_reference_id: sess.client_reference_id, status: "requires_payment_method" })).status, 200);
    assert.equal(await stat(), "awaiting_payment");
    // osignerad / fel signatur
    assert.equal((await webhook(env, "checkout.session.completed", swishApproved(sess), { secret: "whsec_FEL_FEL_FEL_FEL" })).status, 400);
    assert.equal(await stat(), "awaiting_payment");
    assert.equal(store(env, orderId).get("ledger"), undefined);
    // godkänd i Swish: signerad serververifierad betald session
    const evt = "evt_swish_ok_0001";
    assert.equal((await webhook(env, "checkout.session.completed", swishApproved(sess), { id: evt })).status, 200);
    assert.equal(await stat(), "paid");
    const L = store(env, orderId).get("ledger"); assert.equal(L.agreement.payment.amountTotal ?? L.agreement.price.ore, 4900);
    // duplicerad händelse och ny händelse för samma session: idempotent, ingen andra post/andra jobb
    const mails = () => [...store(env, orderId).keys()].filter((k) => k.startsWith("outbox:")).length;
    const before = [mails(), store(env, orderId).get("ledger").agreementId];
    assert.equal((await webhook(env, "checkout.session.completed", swishApproved(sess), { id: evt })).status, 200);
    assert.equal((await webhook(env, "checkout.session.async_payment_succeeded", swishApproved(sess), { id: "evt_swish_ok_0002" })).status, 200);
    assert.deepEqual([mails(), store(env, orderId).get("ledger").agreementId], before);
    assert.equal(await stat(), "paid");
  } finally { f.restore(); }
});

test("async_payment_failed efter Swish öppnar ordern för nytt försök utan upplåsning; ny session får ny nyckel och rätt metodlista", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(SW); const { orderId, token, sess } = await begin(env, f);
    assert.equal((await webhook(env, "checkout.session.async_payment_failed", { ...sess, payment_method_types: ["swish"] })).status, 200);
    assert.equal((await status(env, orderId, token)).status, "ready");
    assert.equal(store(env, orderId).get("ledger"), undefined);
    assert.equal((await startCheckout(env, orderId, token, null)).status, 200);
    assert.equal(f.log.stripeCreate.length, 2);
  } finally { f.restore(); }
});

test("serververifiering: fel belopp/valuta/order/session/livemode och OTILLÅTEN metod nekas även med giltig signatur; Swish på kortorder nekas", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(SW); const { orderId, token, sess } = await begin(env, f);
    const bad = [
      ["belopp", { amount_total: 100 }], ["valuta", { currency: "eur" }], ["order", { client_reference_id: "o_" + "0".repeat(32) }],
      ["session", { id: "cs_test_9999999999" }], ["livemode", { livemode: true }], ["metod", { payment_method_types: ["klarna"] }], ["metod2", { payment_method_types: ["swish", "klarna"] }],
    ];
    for (const [name, over] of bad) { const r = await webhook(env, "checkout.session.completed", swishApproved(sess, over)); assert.ok([400, 200].includes(r.status), name); assert.equal((await status(env, orderId, token)).status, "awaiting_payment", name + " får inte låsa upp"); }
    // order startad i kortläge (frusen metodlista ["card"]) kan inte betalas med swish-session
    const f2 = installFetch(); const env2 = makeEnv(); const o2 = await begin(env2, f2);
    assert.equal((await webhook(env2, "checkout.session.completed", swishApproved(o2.sess))).status, 400);
    assert.equal((await status(env2, o2.orderId, o2.token)).status, "awaiting_payment");
    f2.restore();
    assert.equal((await webhook(env, "checkout.session.completed", swishApproved(sess))).status, 200);
    assert.equal((await status(env, orderId, token)).status, "paid");
  } finally { f.restore(); }
});

test("asynkron återbetalning efter Swish: pending ≠ klar; klar först vid succeeded; failed/ okänd status visas inte som klar", async () => {
  const f = installFetch({ refundStatus: "pending" });
  try {
    const env = makeEnv({ ...SW, COMPARE_AUTO_REFUND: "1", COMPARE_MAILER_MODE: "mock" }); const { orderId, token, sess } = await begin(env, f);
    // betald med Swish, men avtalsbekräftelsen kan inte levereras ⇒ ordern avbryts och återbetalas (auto)
    env.COMPARE_MAILER = { send: async () => { throw new Error("transport nere"); } };
    assert.equal((await webhook(env, "checkout.session.completed", swishApproved(sess))).status, 200);
    for (let i = 0; i < 40 && (await status(env, orderId, token)).status !== "failed"; i++) { const st = store(env, orderId); for (const [k, v] of [...st]) if (k.startsWith("outbox:") && v.nextAt) st.set(k, { ...v, nextAt: 0 }); await env.COMPARE_ORDERS.runAlarms(2); }
    let st = await status(env, orderId, token);
    assert.equal(st.status, "failed"); assert.equal(f.log.refunds.length, 1);
    assert.equal(st.refund.state, "pending", "leverantören har inte slutfört återbetalningen");
    assert.notEqual(st.refund.state, "done");
    assert.doesNotMatch(JSON.stringify(st.refund), /klar|genomförd|återbetald/i);
    // slutförd först när leverantören säger succeeded (signerad händelse)
    assert.equal((await webhook(env, "refund.updated", { id: "re_test_0001", object: "refund", status: "succeeded", metadata: { order_id: orderId } })).status, 200);
    assert.equal((await status(env, orderId, token)).refund.state, "done");
    // senare failed/pending ändrar inte en redan slutförd återbetalning till något annat
    await webhook(env, "refund.updated", { id: "re_test_0001", object: "refund", status: "pending", metadata: { order_id: orderId } });
    assert.equal((await status(env, orderId, token)).refund.state, "done");
  } finally { f.restore(); }
});
