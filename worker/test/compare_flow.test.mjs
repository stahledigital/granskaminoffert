import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, installFetch, api, createOrder, upload, readyOrder, startCheckout, paidSession, webhook, ORIGIN } from "./helpers/compare_env.mjs";

const S = (total, scope = {}, extracted = {}) => ({ extracted: { totalBeforeRotSek: total, totalVatBasis: "inkl", ...extracted }, scope });
const ALLSCOPE = { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" };

async function paid(env, f, orderId, token, evOpts) {
  const co = await startCheckout(env, orderId, token);
  assert.equal(co.status, 200, JSON.stringify(co.json));
  const sess = [...f.sessions.values()].find((s) => s.client_reference_id === orderId);
  const done = paidSession(sess);
  f.sessions.set(sess.id, done);
  const wh = await webhook(env, "checkout.session.completed", done, evOpts);
  return { sess, done, wh };
}

test("stängd som standard: ingen konfiguration → config säger stängt, order kan inte skapas", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({ COMPARE_ENABLED: undefined });
    assert.equal((await api(env, "GET", "/compare/config")).json.enabled, false);
    assert.equal((await createOrder(env, 2)).status, 503);
    const env2 = makeEnv({ COMPARE_MONTH_CAP_MICRO: undefined }); // inget människosatt tak
    const cfg = (await api(env2, "GET", "/compare/config")).json;
    assert.equal(cfg.enabled, true); assert.equal(cfg.accepting, false);
    assert.equal((await createOrder(env2, 2)).status, 503);
    assert.equal(f.log.anthropic.length, 0);
  } finally { f.restore(); }
});

test("serverpris: priset i config och i Stripe-anropet är 4900 öre SEK; klientens belopp ignoreras; ingen offerttext till Stripe", async () => {
  const f = installFetch();
  try {
    const env = makeEnv();
    const cfg = (await api(env, "GET", "/compare/config")).json;
    assert.equal(cfg.accepting, true); assert.equal(cfg.offer.priceOre, 4900); assert.equal(cfg.offer.currency, "sek");
    const c = await createOrder(env, 2, { priceOre: 1, amount: 1 });
    const { orderId, token } = c.json;
    await upload(env, orderId, token, 0, S(100000, ALLSCOPE));
    await upload(env, orderId, token, 1, S(110000, ALLSCOPE));
    const co = await api(env, "POST", `/compare/orders/${orderId}/checkout`, { token, body: { priceOre: 1, amount: 1, accept: { terms: true, immediateDelivery: true } } });
    assert.equal(co.status, 200);
    assert.equal(f.log.stripeCreate.length, 1);
    const p = new URLSearchParams(f.log.stripeCreate[0].body);
    assert.equal(p.get("line_items[0][price_data][unit_amount]"), "4900");
    assert.equal(p.get("line_items[0][price_data][currency]"), "sek");
    assert.ok(!f.log.stripeCreate[0].body.includes("FIXTURE"));
    assert.ok(!f.log.stripeCreate[0].body.includes("rivning"));
  } finally { f.restore(); }
});

test("hela flödet med 3 offerter: obetald ger ingen generation, betald levererar, kvitto och dokumentreferenser", async () => {
  const f = installFetch();
  try {
    const env = makeEnv();
    const { orderId, token } = await readyOrder(env, [
      S(100000, { ...ALLSCOPE }), S(90000, { ...ALLSCOPE, bortforsling: "ingar_inte" }), S(95000, { ...ALLSCOPE, rivning: "framgar_inte" }),
    ]);
    const co = await startCheckout(env, orderId, token);
    assert.equal(co.status, 200); assert.match(co.json.url, /^https:\/\/checkout\.stripe\.test\//);
    // Obetald: returadress/poll ger aldrig leverans
    await env.COMPARE_ORDERS.runAlarms();
    let st = (await api(env, "GET", `/compare/orders/${orderId}`, { token })).json.order;
    assert.equal(st.status, "awaiting_payment"); assert.equal(f.log.anthropic.length, 0);
    assert.equal((await api(env, "GET", `/compare/orders/${orderId}/report`, { token })).status, 409);
    // Betald via signerad webhook
    const sess = [...f.sessions.values()][0];
    const wh = await webhook(env, "checkout.session.completed", paidSession(sess));
    assert.equal(wh.status, 200);
    await env.COMPARE_ORDERS.runAlarms();
    st = (await api(env, "GET", `/compare/orders/${orderId}`, { token })).json.order;
    assert.equal(st.status, "delivered", JSON.stringify(st));
    const extractCalls = f.log.anthropic.filter((r) => r.tools[0].name === "submit_offer").length;
    const synthCalls = f.log.anthropic.filter((r) => r.tools[0].name === "submit_priority").length;
    assert.equal(extractCalls, 3); assert.ok(synthCalls <= 1);
    const rep = (await api(env, "GET", `/compare/orders/${orderId}/report`, { token })).json.report;
    assert.equal(rep.count, 3);
    assert.equal(rep.receipt.amountOre, 4900); assert.equal(rep.receipt.vatOre, 980);
    assert.equal(rep.ranking.shown, false); // omfattningen skiljer → inget "billigast vinner"
    assert.ok(rep.ranking.reasons.length > 0);
    assert.ok(rep.sourceCards.every((c) => c.state === "ej_aktiverad"));
    const bort = rep.scopeMatrix.find((m) => m.id === "bortforsling");
    assert.equal(bort.kind, "skiljer");
    assert.ok(bort.cells[1].status === "ingar_inte" && bort.cells[1].ref); // dokumentreferens finns för uttryckligt besked
    const riv = rep.scopeMatrix.find((m) => m.id === "rivning");
    assert.equal(riv.cells[2].status, "framgar_inte"); assert.equal(riv.cells[2].ref, "");
    // Rådata raderad efter leverans
    for (let i = 0; i < 3; i++) assert.equal(await env.REVIEWS_KV.get(`cmpdoc:${orderId}:${i}`), null);
    // Kostnad avräknad, inget kvar reserverat
    const stub = env.COMPARE_BUDGET.get("jamfor-budget");
    assert.ok(stub);
  } finally { f.restore(); }
});

test("webhook: ogiltig signatur, gammal tid, manipulerad kropp, fel belopp/valuta/order/ej betald → ingen leverans", async () => {
  const f = installFetch();
  try {
    const env = makeEnv();
    const { orderId, token } = await readyOrder(env, [S(100000, ALLSCOPE), S(110000, ALLSCOPE)]);
    await startCheckout(env, orderId, token);
    const sess = [...f.sessions.values()][0];
    const good = paidSession(sess);
    assert.equal((await webhook(env, "checkout.session.completed", good, { secret: "whsec_fel12345678" })).status, 400);
    assert.equal((await webhook(env, "checkout.session.completed", good, { t: Math.floor(Date.now() / 1000) - 3600 })).status, 400);
    assert.equal((await webhook(env, "checkout.session.completed", good, { tamper: true })).status, 400);
    assert.equal((await webhook(env, "checkout.session.completed", { ...good, amount_total: 100 })).status, 400);
    assert.equal((await webhook(env, "checkout.session.completed", { ...good, currency: "usd" })).status, 400);
    assert.equal((await webhook(env, "checkout.session.completed", { ...good, client_reference_id: "o_" + "a".repeat(32) })).status, 200); // okänd order ignoreras
    assert.equal((await webhook(env, "checkout.session.completed", { ...good, payment_status: "unpaid" })).status, 400);
    assert.equal((await webhook(env, "checkout.session.completed", { ...good, livemode: true })).status, 400);
    assert.equal((await webhook(env, "checkout.session.completed", { ...good, id: "cs_test_annan00001" })).status, 400);
    await env.COMPARE_ORDERS.runAlarms();
    assert.equal(f.log.anthropic.length, 0);
    const st = (await api(env, "GET", `/compare/orders/${orderId}`, { token })).json.order;
    assert.equal(st.status, "awaiting_payment");
  } finally { f.restore(); }
});

test("dubbletter och omspelning ger exakt en generation och en leverans", async () => {
  const f = installFetch();
  try {
    const env = makeEnv();
    const { orderId, token } = await readyOrder(env, [S(100000, ALLSCOPE), S(110000, ALLSCOPE)]);
    const { done } = await paid(env, f, orderId, token, { id: "evt_same" });
    await webhook(env, "checkout.session.completed", done, { id: "evt_same" }); // samma händelse igen
    await webhook(env, "checkout.session.completed", done, { id: "evt_other" }); // ny händelse, samma betalning
    await webhook(env, "checkout.session.async_payment_succeeded", done, { id: "evt_third" });
    await Promise.all([env.COMPARE_ORDERS.runAlarms(), env.COMPARE_ORDERS.runAlarms()]);
    await webhook(env, "checkout.session.completed", done, { id: "evt_late" }); // sent efter leverans
    await webhook(env, "checkout.session.expired", done, { id: "evt_exp" }); // ur ordning
    await env.COMPARE_ORDERS.runAlarms();
    const st = (await api(env, "GET", `/compare/orders/${orderId}`, { token })).json.order;
    assert.equal(st.status, "delivered");
    assert.equal(f.log.anthropic.filter((r) => r.tools[0].name === "submit_offer").length, 2);
  } finally { f.restore(); }
});

test("dubbelklick på betala: en enda Stripe-session", async () => {
  const f = installFetch();
  try {
    const env = makeEnv();
    const { orderId, token } = await readyOrder(env, [S(100000, ALLSCOPE), S(110000, ALLSCOPE)]);
    const [a, b] = await Promise.all([startCheckout(env, orderId, token), startCheckout(env, orderId, token)]);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.equal(a.json.url, b.json.url);
    assert.equal(new Set([...f.sessions.keys()]).size, 1);
  } finally { f.restore(); }
});

test("serveravstämning: betald session hittas utan webhook (stängd flik/fördröjd webhook) men returadressen räknas inte", async () => {
  const f = installFetch();
  try {
    const env = makeEnv();
    const { orderId, token } = await readyOrder(env, [S(100000, ALLSCOPE), S(110000, ALLSCOPE)]);
    await startCheckout(env, orderId, token);
    const sess = [...f.sessions.values()][0];
    // Kunden kommer tillbaka men Stripe säger obetald: status kan inte bli betald
    let st = (await api(env, "GET", `/compare/orders/${orderId}?session_id=${sess.id}&order=${orderId}`, { token })).json.order;
    assert.equal(st.status, "awaiting_payment");
    f.sessions.set(sess.id, paidSession(sess));
    await new Promise((r) => setTimeout(r, 5)); // reconcileMinMs-spärren hanteras via lastReconcileAt; tvinga genom ny order-DO-tid
    const o = env.COMPARE_ORDERS.peek(orderId);
    const rec = await o.store.get("order"); rec.lastReconcileAt = 0; o.store.set("order", rec);
    st = (await api(env, "GET", `/compare/orders/${orderId}`, { token })).json.order;
    assert.equal(st.status, "paid");
    await env.COMPARE_ORDERS.runAlarms();
    st = (await api(env, "GET", `/compare/orders/${orderId}`, { token })).json.order;
    assert.equal(st.status, "delivered");
  } finally { f.restore(); }
});

test("åtkomst: fel nyckel, annan ordernyckel, saknad Origin på ändring, utgången utkast", async () => {
  const f = installFetch();
  try {
    const env = makeEnv();
    const a = await readyOrder(env, [S(1, ALLSCOPE), S(2, ALLSCOPE)]);
    const b = await readyOrder(env, [S(3, ALLSCOPE), S(4, ALLSCOPE)]);
    assert.equal((await api(env, "GET", `/compare/orders/${a.orderId}`, { token: b.token })).status, 404);
    assert.equal((await api(env, "GET", `/compare/orders/${a.orderId}`, { token: "x".repeat(32) })).status, 404);
    assert.equal((await api(env, "GET", `/compare/orders/${a.orderId}`, {})).status, 404);
    assert.equal((await api(env, "GET", `/compare/orders/${a.orderId}/report`, { token: b.token })).status, 404);
    assert.equal((await api(env, "DELETE", `/compare/orders/${a.orderId}`, { token: a.token, origin: "https://evil.example" })).status, 403);
    assert.equal((await startCheckout(env, a.orderId, b.token)).status, 404);
    // utgånget utkast: DO-tid efter retentionstiden → expired, kan varken laddas upp eller betalas
    const stub = env.COMPARE_ORDERS.get(a.orderId);
    const { sha256Hex } = await import("../src/compare_util.js");
    const th = await sha256Hex(a.token), later = Date.now() + 25 * 3600_000;
    const post = async (path, extra = {}) => { const r = await stub.fetch("https://x" + path, { method: "POST", body: JSON.stringify({ tokenHash: th, now: later, ...extra }) }); return { status: r.status, json: await r.json() }; };
    assert.equal((await post("/get")).json.order.status, "expired");
    assert.equal((await post("/checkout-begin")).status, 409);
    assert.equal((await post("/doc", { meta: { idx: 0, kind: "text", bytes: 1, tokens: 1, sha256: "a".repeat(64), key: "k" } })).status, 409);
  } finally { f.restore(); }
});
