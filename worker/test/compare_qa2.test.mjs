// Regressionstester för D04 root-QA (2026-10-10, punkt 1–8): rootprober återgivna som egna tester.
// Inga riktiga modellanrop, ingen riktig betalning; Anthropic/Stripe är attrapper.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import * as budget from "../src/compare_budget.js";
import { gateEnabled, gateCaps } from "../src/cost_gate.js";
import { CONSENT, consentSnapshot } from "../src/compare_config.js";
import { fakeQuotaNamespace } from "./helpers/quota_do.mjs";
import { makeEnv, installFetch, api, createOrder, upload, readyOrder, startCheckout, paidSession, webhook, docKeys, consentOf, ORIGIN, offerText, TEST_EMAIL } from "./helpers/compare_env.mjs";

const S = (total, scope = {}) => ({ extracted: { totalBeforeRotSek: total, totalVatBasis: "inkl" }, scope });
const ALL = { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" };
const status = async (env, orderId, token) => (await api(env, "GET", `/compare/orders/${orderId}`, { token })).json.order;
async function pay(env, f, orderId, token) {
  const co = await startCheckout(env, orderId, token);
  assert.equal(co.status, 200, JSON.stringify(co.json));
  const sess = [...f.sessions.values()].filter((s) => s.client_reference_id === orderId).pop();
  const w = await webhook(env, "checkout.session.completed", paidSession(sess));
  assert.equal(w.status, 200);
  return sess;
}

// ===================== 1. Gemensam kostnadsgate (/review, /explain) =====================
const fakeReview = {
  trade: "tak", contradictions: [], clarify: [{ key: "A", text: "b" }, { key: "C", text: "d" }],
  stated: [], calcCoverage: "checked", calcNote: "ok",
  price: { hourlyRateSek: 595, totalSumSek: 42820, rotDeducted: true, comment: "x" }, questions: ["q"], extracted: { trades: [] },
};
function gateEnv(over = {}) {
  const e = makeEnv({ ALLOWED_ORIGIN: ORIGIN, ...over });
  e.QUOTA = fakeQuotaNamespace();
  return e;
}
const jobs = () => { const j = []; return { j, waitUntil: (p) => j.push(p) }; };
function reviewReq(i = 0) {
  return new Request("https://x/review", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": `203.0.113.${10 + i}` }, body: JSON.stringify({ kind: "text", text: "Offert " + (42820 + i) + " kr", path: "mottagare" }) });
}
function aiFetch(env, { hold = null, usage = { input_tokens: 10, output_tokens: 5 }, status = 200, throwNet = false } = {}) {
  const real = globalThis.fetch;
  const seen = { calls: 0, reservedMicro: null };
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("count_tokens")) return Response.json({ input_tokens: 500 });
    if (String(url).includes("anthropic")) {
      seen.calls++;
      if (seen.reservedMicro === null && env.COMPARE_FREE_CAP_MICRO) {
        const cap = await budget.capacity(env, { caps: { joint: Number(env.COMPARE_MONTH_CAP_MICRO), scope: Number(env.COMPARE_FREE_CAP_MICRO) }, scope: "free" });
        seen.reservedMicro = Number(env.COMPARE_FREE_CAP_MICRO) - cap.remaining;
      }
      if (hold) await hold;
      if (throwNet) throw new Error("nät");
      return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "submit_review", input: fakeReview }], usage }), { status });
    }
    throw new Error("oväntat anrop " + url);
  };
  return { seen, restore: () => { globalThis.fetch = real; } };
}
const GATE = { COST_GATE: "1", COMPARE_MONTH_CAP_MICRO: "50000000", COMPARE_FREE_CAP_MICRO: "40000000" };

test("gate AV (standard): /review fungerar som förut och rör inte budgeten", async () => {
  const env = gateEnv(); const a = aiFetch(env);
  try {
    assert.equal(gateEnabled(env), false);
    const r = await worker.fetch(reviewReq(), env, jobs());
    assert.equal(r.status, 200); assert.equal(a.seen.calls, 1);
    const st = await budget.stats(env);
    assert.ok(!st || !st.free);
  } finally { a.restore(); }
});

test("gate PÅ: lyckad /review reserverar värsta fallet, avräknar mot uppmätt användning (gratis-scope)", async () => {
  const env = gateEnv(GATE); const a = aiFetch(env);
  try {
    const r = await worker.fetch(reviewReq(), env, jobs());
    assert.equal(r.status, 200); assert.equal(a.seen.calls, 1);
    assert.ok(a.seen.reservedMicro > 0, "reservation fanns när anropet gjordes");
    const cap = await budget.capacity(env, { caps: { joint: 50_000_000, scope: 40_000_000 }, scope: "free" });
    assert.ok(40_000_000 - cap.remaining < a.seen.reservedMicro, "avräknad kostnad < reserverat värsta fall");
  } finally { a.restore(); }
});

test("gate PÅ: saknat/ogiltigt tak, saknad bindning → inget anrop", async () => {
  for (const over of [{ COMPARE_FREE_CAP_MICRO: undefined }, { COMPARE_MONTH_CAP_MICRO: undefined }, { COMPARE_FREE_CAP_MICRO: "0" }, { COMPARE_FREE_CAP_MICRO: "60000000" }, { COMPARE_FREE_CAP_MICRO: "abc" }]) {
    const env = gateEnv({ ...GATE, ...over }); for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const a = aiFetch(env);
    try { const r = await worker.fetch(reviewReq(), env, jobs()); assert.ok(r.status >= 400, JSON.stringify(over)); assert.equal(a.seen.calls, 0, JSON.stringify(over)); } finally { a.restore(); }
  }
  const env = gateEnv(GATE); delete env.COMPARE_BUDGET; const a = aiFetch(env);
  try { const r = await worker.fetch(reviewReq(), env, jobs()); assert.ok(r.status >= 400); assert.equal(a.seen.calls, 0); } finally { a.restore(); }
  assert.equal(gateCaps({ COMPARE_MONTH_CAP_MICRO: "10", COMPARE_FREE_CAP_MICRO: "20" }).ok, false);
});

test("gate PÅ: uttömt gemensamt tak (betalda reservationer) stoppar gratis /review utan anrop", async () => {
  const env = gateEnv({ ...GATE, COMPARE_MONTH_CAP_MICRO: "1000", COMPARE_FREE_CAP_MICRO: "1000" }); const a = aiFetch(env);
  try {
    const r = await worker.fetch(reviewReq(), env, jobs());
    assert.ok(r.status >= 400); assert.equal(a.seen.calls, 0);
  } finally { a.restore(); }
  // betald reservation äter det gemensamma taket
  const env2 = gateEnv(GATE);
  const a2 = aiFetch(env2);
  try {
    await worker.fetch(reviewReq(), env2, jobs()); // mäter W
    const W = a2.seen.reservedMicro;
    const env3 = gateEnv({ ...GATE, COMPARE_MONTH_CAP_MICRO: String(W * 2), COMPARE_FREE_CAP_MICRO: String(W * 2) });
    const a3 = aiFetch(env3);
    try {
      const rp = await budget.reserve(env3, { key: "ext:o_" + "a".repeat(32) + ":0:1", scope: "paid", orderId: "o_" + "a".repeat(32), micro: W + Math.floor(W / 2), caps: { joint: W * 2, scope: W * 2, order: W * 2 } });
      assert.ok(rp.ok);
      const r = await worker.fetch(reviewReq(), env3, jobs());
      assert.ok(r.status >= 400); assert.equal(a3.seen.calls, 0);
    } finally { a3.restore(); }
  } finally { a2.restore(); }
});

test("gate PÅ: fem samtidiga /review mot tak för en → exakt ett anrop (atomär gemensam reservation)", async () => {
  const probe = gateEnv(GATE); const ap = aiFetch(probe);
  let W;
  try { await worker.fetch(reviewReq(), probe, jobs()); W = ap.seen.reservedMicro; } finally { ap.restore(); }
  assert.ok(W > 0);
  const env = gateEnv({ ...GATE, COMPARE_MONTH_CAP_MICRO: String(Math.floor(W * 1.5)), COMPARE_FREE_CAP_MICRO: String(Math.floor(W * 1.5)) });
  let release; const hold = new Promise((r) => { release = r; });
  const a = aiFetch(env, { hold });
  try {
    const ps = [0, 1, 2, 3, 4].map((i) => worker.fetch(reviewReq(i), env, jobs()));
    await new Promise((r) => setTimeout(r, 50));
    release();
    const rs = await Promise.all(ps);
    assert.equal(a.seen.calls, 1);
    assert.equal(rs.filter((r) => r.status === 200).length, 1);
  } finally { a.restore(); }
});

test("gate PÅ: oklar användning (nätverksfel) → stopp; nästa /review nekas utan anrop", async () => {
  const env = gateEnv(GATE); const a = aiFetch(env, { throwNet: true });
  try {
    await worker.fetch(reviewReq(), env, jobs());
    assert.equal(a.seen.calls, 1);
    const r2 = await worker.fetch(reviewReq(1), env, jobs());
    assert.ok(r2.status >= 400); assert.equal(a.seen.calls, 1);
    // även betalda generationer stoppas av samma halt
    const cap = await budget.capacity(env, { caps: { joint: 50_000_000, scope: 40_000_000 }, scope: "paid" });
    assert.equal(cap.halted, true);
  } finally { a.restore(); }
});

test("gate PÅ: HTTP-fel från leverantören frigör reservationen", async () => {
  const env = gateEnv(GATE); const a = aiFetch(env, { status: 529 });
  try {
    await worker.fetch(reviewReq(), env, jobs());
    const cap = await budget.capacity(env, { caps: { joint: 50_000_000, scope: 40_000_000 }, scope: "free" });
    assert.equal(cap.remaining, 40_000_000);
  } finally { a.restore(); }
});

// ===================== 2. Uttömda försök (alarm exhausted) =====================
test("exhausted: betald order running, attempts=3, lease null → alarm → failed, återbetalning behövs, rådata rensad, inget modellanrop", async () => {
  const f = installFetch();
  try {
    const env = makeEnv();
    const { orderId, token } = await readyOrder(env, [S(100000, ALL), S(110000, ALL)]);
    await pay(env, f, orderId, token);
    // Versionera in ett tillstånd: pipelinen har aldrig körts, men ordern står som running med 3 försök och ingen lease.
    const stub = env.COMPARE_ORDERS.peek(orderId);
    const o = await stub.store.get("order");
    o.status = "running"; o.work.attempts = 3; o.work.lease = null;
    stub.store.set("order", o);
    const keysBefore = docKeys(env, orderId).length; assert.ok(keysBefore >= 2);
    await env.COMPARE_ORDERS.runAlarms();
    const st = await status(env, orderId, token);
    assert.equal(st.status, "failed"); assert.equal(st.error, "for_manga_forsok");
    assert.equal(st.refund.state, "needed"); // manuellt läge i testmiljön
    assert.deepEqual(docKeys(env, orderId), []);
    assert.equal(f.log.anthropic.length, 0);
    // ytterligare alarm gör inget
    stub.store.set("order", { ...(await stub.store.get("order")) });
    await env.COMPARE_ORDERS.runAlarms();
    assert.equal((await status(env, orderId, token)).status, "failed");
  } finally { f.restore(); }
});

test("exhausted: auto-återbetalning begärs en gång och spåras (pending → inte 'done')", async () => {
  const f = installFetch({ refundStatus: "pending" });
  try {
    const env = makeEnv({ COMPARE_AUTO_REFUND: "1" });
    const { orderId, token } = await readyOrder(env, [S(100000, ALL), S(110000, ALL)]);
    await pay(env, f, orderId, token);
    const stub = env.COMPARE_ORDERS.peek(orderId);
    const o = await stub.store.get("order"); o.status = "running"; o.work.attempts = 3; o.work.lease = null; stub.store.set("order", o);
    await env.COMPARE_ORDERS.runAlarms();
    const st = await status(env, orderId, token);
    assert.equal(st.status, "failed"); assert.equal(st.refund.state, "pending"); assert.equal(st.refund.providerStatus, "pending");
    assert.equal(f.log.refunds.length, 1); assert.equal(f.log.anthropic.length, 0);
  } finally { f.restore(); }
});

// ===================== 3. Sen PUT mot låst original =====================
test("sen PUT: läser ready → checkout låser → PUT skriver samma plats → originalet består och används", async () => {
  const f = installFetch();
  try {
    const env = makeEnv();
    const { orderId, token } = await readyOrder(env, [S(100000, ALL), S(110000, ALL)]);
    // PUT 0 med ANNAT innehåll startar, pausas vid count_tokens, medan kassan låser ordern.
    let release; const hold = new Promise((r) => { release = r; });
    const realFetch = globalThis.fetch;
    let paused = false;
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith("/v1/messages/count_tokens") && !paused) { paused = true; await hold; }
      return realFetch(url, init);
    };
    const latePut = upload(env, orderId, token, 0, S(1, ALL));
    await new Promise((r) => setTimeout(r, 30));
    const keysLocked = docKeys(env, orderId).sort();
    const co = await startCheckout(env, orderId, token);
    assert.equal(co.status, 200);
    release();
    const late = await latePut;
    globalThis.fetch = realFetch;
    assert.equal(late.status, 409);
    assert.deepEqual(docKeys(env, orderId).sort(), keysLocked); // originalen finns kvar, inget extra kvar
    const sess = [...f.sessions.values()].pop();
    await webhook(env, "checkout.session.completed", paidSession(sess));
    await env.COMPARE_ORDERS.runAlarms();
    const st = await status(env, orderId, token);
    assert.equal(st.status, "delivered"); // pipelinen hittade originalen
  } finally { f.restore(); }
});

test("PUT samma innehåll igen / utbyte före låsning: manifestet avgör, gammal version rensas, inga läckor", async () => {
  const f = installFetch();
  try {
    const env = makeEnv();
    const { orderId, token } = await readyOrder(env, [S(100000, ALL), S(110000, ALL)]);
    const k0 = docKeys(env, orderId).sort();
    assert.equal((await upload(env, orderId, token, 0, S(100000, ALL))).status, 200); // samma innehåll: samma nyckel
    assert.deepEqual(docKeys(env, orderId).sort(), k0);
    assert.equal((await upload(env, orderId, token, 0, S(105000, ALL))).status, 200); // utbyte
    assert.equal(docKeys(env, orderId).length, 2);
    assert.ok(docKeys(env, orderId).some((k) => !k0.includes(k)));
    assert.equal((await upload(env, orderId, token, 1, S(105000, ALL))).status, 409); // dubblett av idx 0
    assert.equal(docKeys(env, orderId).length, 2);
  } finally { f.restore(); }
});

// ===================== 4. Återbetalningens status =====================
async function failedOrder(env, f) {
  const { orderId, token } = await readyOrder(env, [S(100000, ALL), S(110000, ALL)]);
  await pay(env, f, orderId, token);
  f.ctl.timeoutNext = 99; // modellen svarar aldrig → oklar användning → misslyckad leverans
  await env.COMPARE_ORDERS.runAlarms();
  return { orderId, token };
}
const refundWebhook = (env, type, refund) => webhook(env, type, refund);

test("återbetalning: provider 'succeeded' → done; övriga statusar blir aldrig 'done'", async () => {
  const cases = [["succeeded", "done"], ["pending", "pending"], ["requires_action", "action_required"], ["failed", "failed"], ["canceled", "failed"], ["konstig", "needed"]];
  for (const [prov, expect] of cases) {
    const f = installFetch({ refundStatus: prov });
    try {
      const env = makeEnv({ COMPARE_AUTO_REFUND: "1" });
      const { orderId, token } = await failedOrder(env, f);
      const st = await status(env, orderId, token);
      assert.equal(st.status, "failed"); assert.equal(st.refund.state, expect, prov);
      assert.equal(f.log.refunds.length, 1);
    } finally { f.restore(); }
  }
});

test("återbetalning utan id i svaret → 'needed', aldrig 'done'", async () => {
  const f = installFetch({ refundNoId: true });
  try {
    const env = makeEnv({ COMPARE_AUTO_REFUND: "1" });
    const { orderId, token } = await failedOrder(env, f);
    assert.equal((await status(env, orderId, token)).refund.state, "needed");
  } finally { f.restore(); }
});

test("återbetalning pending → avstämning via statusläsning och via signerad webhook ger done; fel refund-id avvisas", async () => {
  const f = installFetch({ refundStatus: "pending" });
  try {
    const env = makeEnv({ COMPARE_AUTO_REFUND: "1" });
    const { orderId, token } = await failedOrder(env, f);
    assert.equal((await status(env, orderId, token)).refund.state, "pending");
    // 1) webhook med främmande refund-id ändrar inget
    const bad = await webhook(env, "refund.updated", { id: "re_ANNAN_0002", object: "refund", status: "succeeded", metadata: { order_id: orderId } });
    assert.equal(bad.status, 200);
    assert.equal((await status(env, orderId, token)).refund.state, "pending");
    // 2) Stripe-statusläsning (serveravstämning) – fortfarande pending
    const stub = env.COMPARE_ORDERS.peek(orderId);
    const o = await stub.store.get("order"); o.lastRefundCheckAt = 0; stub.store.set("order", o);
    assert.equal((await status(env, orderId, token)).refund.state, "pending");
    assert.ok(f.log.refundGets.length >= 1);
    // 3) Stripe säger succeeded
    f.ctl.refundObj = { ...f.ctl.refundObj, status: "succeeded" };
    const o2 = await stub.store.get("order"); o2.lastRefundCheckAt = 0; stub.store.set("order", o2);
    assert.equal((await status(env, orderId, token)).refund.state, "done");
  } finally { f.restore(); }
  const f2 = installFetch({ refundStatus: "pending" });
  try {
    const env = makeEnv({ COMPARE_AUTO_REFUND: "1" });
    const { orderId, token } = await failedOrder(env, f2);
    const w = await webhook(env, "refund.updated", { id: "re_test_0001", object: "refund", status: "failed", metadata: { order_id: orderId } });
    assert.equal(w.status, 200);
    assert.equal((await status(env, orderId, token)).refund.state, "failed");
    // lyckad är slutgiltig – en senare gammal händelse backar den inte
    const f3 = installFetch({ refundStatus: "succeeded" });
    f3.restore();
  } finally { f2.restore(); }
});

// ===================== 5. Checkout: frusen snapshot per försök =====================
test("checkout: två anrop 5 s isär ger samma nyckel och exakt samma body (frusen utgångstid)", async () => {
  const f = installFetch();
  try {
    const env = makeEnv();
    const { orderId, token } = await readyOrder(env, [S(100000, ALL), S(110000, ALL)]);
    const realNow = Date.now; let t = realNow();
    Date.now = () => t;
    try {
      const a = await startCheckout(env, orderId, token); assert.equal(a.status, 200);
      // sessionen finns inte sparad (simulera att svaret gick förlorat) → nästa anrop ska återanvända exakt samma försök
      const stub = env.COMPARE_ORDERS.peek(orderId);
      const o = await stub.store.get("order"); const savedStripe = o.stripe; o.stripe = null; o.status = "ready"; stub.store.set("order", o);
      t += 5000;
      const b = await startCheckout(env, orderId, token); assert.equal(b.status, 200, JSON.stringify(b.json));
      assert.equal(f.log.stripeCreate.length, 2);
      assert.equal(f.log.stripeCreate[0].idem, f.log.stripeCreate[1].idem);
      assert.equal(f.log.stripeCreate[0].body, f.log.stripeCreate[1].body);
      assert.equal(a.json.url, b.json.url); // Stripe returnerade samma session (idempotent), inget mismatch
      assert.ok(savedStripe);
    } finally { Date.now = realNow; }
  } finally { f.restore(); }
});

test("checkout: verkligt utgången session → nytt försök med ny nyckel och ny frusen utgångstid", async () => {
  const f = installFetch();
  try {
    const env = makeEnv();
    const { orderId, token } = await readyOrder(env, [S(100000, ALL), S(110000, ALL)]);
    const realNow = Date.now; let t = realNow();
    Date.now = () => t;
    try {
      const a = await startCheckout(env, orderId, token); assert.equal(a.status, 200);
      const sess = [...f.sessions.values()].pop();
      const ex = await webhook(env, "checkout.session.expired", sess, { t: Math.floor(t / 1000) });
      assert.equal(ex.status, 200);
      t += 70 * 60_000;
      const b = await startCheckout(env, orderId, token, null);
      // utan ny presentation: samtycket för samma hash återanvänds
      assert.equal(b.status, 200, JSON.stringify(b.json));
      assert.equal(f.log.stripeCreate.length, 2);
      assert.notEqual(f.log.stripeCreate[0].idem, f.log.stripeCreate[1].idem);
      assert.match(f.log.stripeCreate[1].idem, /^checkout:o_[0-9a-f]{32}:2$/);
      assert.notEqual(a.json.url, b.json.url);
    } finally { Date.now = realNow; }
  } finally { f.restore(); }
});

test("Stripe-attrappen nekar samma nyckel med andra parametrar (parametermatch)", async () => {
  const f = installFetch();
  try {
    const mk = (exp) => fetch("https://api.stripe.com/v1/checkout/sessions", { method: "POST", headers: { "idempotency-key": "k1" }, body: `client_reference_id=o_x&expires_at=${exp}&line_items[0][price_data][unit_amount]=4900&metadata[order_id]=o_x` });
    assert.equal((await mk(100)).status, 200);
    assert.equal((await mk(100)).status, 200);
    assert.equal((await mk(105)).status, 400);
  } finally { f.restore(); }
});

// ===================== 6. Samtycke: version + hash, draft-läge =====================
test("samtycke: config ger texter, version, hash och draft; hashen ändras när texten ändras", async () => {
  const env = makeEnv();
  const c = (await api(env, "GET", "/compare/config")).json;
  assert.equal(c.draft, true); assert.equal(c.consent.draft, true);
  assert.match(c.consent.hash, /^[0-9a-f]{64}$/); assert.equal(c.consent.version, CONSENT.version);
  assert.ok(c.consent.texts.terms && c.consent.texts.immediate && c.consent.texts.sameJob);
  assert.ok(c.offerCopy.getsNot.some((t) => /omdömen/i.test(t)));
  assert.equal(c.dataCoverage.reviews, false);
});

test("samtycke: LIVE-betalning är stängd så länge texten är utkast", async () => {
  const env = makeEnv({ COMPARE_PAYMENTS: "live", STRIPE_SECRET_KEY: "sk_live_abcdefgh1234" });
  const c = (await api(env, "GET", "/compare/config")).json;
  assert.equal(c.accepting, false);
});

test("samtycke: checkout utan hash/version, fel hash eller ändrad text nekas; order lagrar version+hash+antal", async () => {
  const f = installFetch();
  try {
    const env = makeEnv();
    const { orderId, token } = await readyOrder(env, [S(100000, ALL), S(110000, ALL)]);
    const cs = await consentOf(env);
    const base = { terms: true, immediateDelivery: true, email: TEST_EMAIL };
    assert.equal((await startCheckout(env, orderId, token, { ...base })).status, 400);
    assert.equal((await startCheckout(env, orderId, token, { ...base, consentHash: "0".repeat(64), consentVersion: cs.version })).status, 409);
    assert.equal((await startCheckout(env, orderId, token, { ...base, consentHash: cs.hash, consentVersion: "gammal" })).status, 409);
    assert.equal((await startCheckout(env, orderId, token, null)).status, 400); // inget samtycke givet ännu → "betala igen" får inte hitta på ett
    assert.equal(f.log.stripeCreate.length, 0);
    const ok = await startCheckout(env, orderId, token, { ...base, consentHash: cs.hash, consentVersion: cs.version });
    assert.equal(ok.status, 200);
    const st = await status(env, orderId, token);
    assert.equal(st.consent.accepted, true); assert.equal(st.consent.hash, cs.hash); assert.equal(st.consent.version, cs.version); assert.equal(st.consent.draft, true);
    const o = await env.COMPARE_ORDERS.peek(orderId).store.get("order");
    assert.equal(o.accept.docCount, 2); assert.equal(o.accept.priceOre, 4900); assert.equal(o.accept.currency, "sek");
  } finally { f.restore(); }
});

test("samtycke: 'betala igen' utan body återanvänder bara samtycke med SAMMA hash; ändrad hash kräver ny presentation", async () => {
  const f = installFetch();
  try {
    const env = makeEnv();
    const { orderId, token } = await readyOrder(env, [S(100000, ALL), S(110000, ALL)]);
    assert.equal((await startCheckout(env, orderId, token)).status, 200);
    const sess = [...f.sessions.values()].pop();
    await webhook(env, "checkout.session.expired", sess);
    // samma text: går utan ny kryssning
    assert.equal((await startCheckout(env, orderId, token, null)).status, 200);
    // simulera att kunden samtyckt till en äldre text
    const stub = env.COMPARE_ORDERS.peek(orderId);
    const o = await stub.store.get("order"); o.accept.consentHash = "f".repeat(64); o.status = "ready"; o.stripe = null; o.checkout.intent = null; stub.store.set("order", o);
    const r = await startCheckout(env, orderId, token, null);
    assert.equal(r.status, 400); assert.equal(r.json.needAccept, true);
  } finally { f.restore(); }
});

// ===================== 7. Datatäckning: omdömen ingår inte =====================
test("datatäckning: före köp säger config/erbjudande att omdömen inte ingår; rapporten lovar inga senaste omdömen", async () => {
  const f = installFetch();
  try {
    const env = makeEnv();
    const c = (await api(env, "GET", "/compare/config")).json;
    assert.match(c.dataCoverage.text, /Omdömen om företagen ingår inte/);
    assert.equal(c.dataCards, false);
    const { orderId, token } = await readyOrder(env, [S(100000, ALL), S(110000, ALL)]);
    await pay(env, f, orderId, token);
    await env.COMPARE_ORDERS.runAlarms();
    const rep = (await api(env, "GET", `/compare/orders/${orderId}/report`, { token })).json.report;
    const txt = JSON.stringify(rep);
    assert.doesNotMatch(txt, /senaste omdömen|fem Google|Google-omdömen|recensioner/i);
    assert.equal(f.log.stripeCreate.length >= 1, true);
  } finally { f.restore(); }
});

// ===================== Root-QA punkt 10 (B): gate mäter alltid, halt även vid känd överskridning =====================
test("P1-B: rootprob – gate PÅ, tak 100 000 µUSD, uppmätt 60 000 tokens → NEKAS före anrop (ingen generation, ingen överskridning)", async () => {
  const env = gateEnv({ COST_GATE: "1", COMPARE_MONTH_CAP_MICRO: "100000", COMPARE_FREE_CAP_MICRO: "100000" });
  const real = globalThis.fetch; const seen = { count: 0, gen: 0 };
  globalThis.fetch = async (u) => {
    if (String(u).includes("count_tokens")) { seen.count++; return Response.json({ input_tokens: 60000 }); }
    if (String(u).includes("anthropic")) { seen.gen++; return Response.json({ usage: { input_tokens: 60000, output_tokens: 6000 }, content: [{ type: "tool_use", name: "submit_review", input: fakeReview }] }); }
    throw new Error("oväntat " + u);
  };
  try {
    const r = await worker.fetch(new Request("https://x/review", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.88" }, body: JSON.stringify({ kind: "text", text: "Offert " + "界".repeat(18000), path: "mottagare" }) }), env, jobs());
    assert.ok(r.status >= 400);
    assert.equal(seen.count, 1, "texten mättes med count_tokens");
    assert.equal(seen.gen, 0);
    const st = await budget.stats(env);
    assert.equal((st.month && st.month.total) || 0, 0);
  } finally { globalThis.fetch = real; }
});

test("P1-B: gate PÅ + count_tokens misslyckas för text → fail closed, inget anrop; gate AV beter sig som förut (ingen mätning av text)", async () => {
  const env = gateEnv(GATE);
  const real = globalThis.fetch; const seen = { gen: 0, count: 0 };
  globalThis.fetch = async (u) => {
    if (String(u).includes("count_tokens")) { seen.count++; return new Response("{}", { status: 500 }); }
    if (String(u).includes("anthropic")) { seen.gen++; return Response.json({ usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "tool_use", name: "submit_review", input: fakeReview }] }); }
    throw new Error("oväntat");
  };
  try {
    const r = await worker.fetch(reviewReq(), env, jobs());
    assert.equal(r.status, 503); assert.equal(seen.gen, 0);
    const env2 = gateEnv(); // gate AV
    const r2 = await worker.fetch(reviewReq(1), env2, jobs());
    assert.equal(r2.status, 200); assert.equal(seen.count, 1); assert.equal(seen.gen, 1); // ingen ny mätning med gate AV
  } finally { globalThis.fetch = real; }
});

test("P1-B: känd men oväntad överskridning av reservationen → halt för ALLA fortsatta generationer (fri och betald)", async () => {
  const env = gateEnv(GATE);
  const real = globalThis.fetch; let gen = 0;
  globalThis.fetch = async (u) => {
    if (String(u).includes("count_tokens")) return Response.json({ input_tokens: 500 });
    if (String(u).includes("anthropic")) { gen++; return Response.json({ usage: { input_tokens: 50_000_000, output_tokens: 10 }, content: [{ type: "tool_use", name: "submit_review", input: fakeReview }] }); }
    throw new Error("oväntat");
  };
  try {
    await worker.fetch(reviewReq(), env, jobs());
    assert.equal(gen, 1);
    const cap = await budget.capacity(env, { caps: { joint: 50_000_000, scope: 40_000_000 }, scope: "free" });
    assert.equal(cap.halted, true);
    const r2 = await worker.fetch(reviewReq(1), env, jobs());
    assert.ok(r2.status >= 400); assert.equal(gen, 1);
    const paid = await budget.reserve(env, { key: "ext:o_" + "b".repeat(32) + ":0:1", scope: "paid", orderId: "o_" + "b".repeat(32), micro: 10, caps: { joint: 50_000_000, scope: 40_000_000, order: 1000 } });
    assert.equal(paid.ok, false); assert.equal(paid.reason, "stopp_oklar_anvandning");
  } finally { globalThis.fetch = real; }
});

test("P1-B: budget – settle med känd användning ≤ reservation halterar inte; > reservation halterar", async () => {
  const env = makeEnv(); const caps = { joint: 1000, scope: 1000 };
  assert.ok((await budget.reserve(env, { key: "g:1", scope: "free", orderId: null, micro: 100, caps })).ok);
  await budget.settle(env, { key: "g:1", actual: 90, usageKnown: true });
  assert.equal((await budget.capacity(env, { caps, scope: "free" })).halted, false);
  assert.ok((await budget.reserve(env, { key: "g:2", scope: "free", orderId: null, micro: 100, caps })).ok);
  await budget.settle(env, { key: "g:2", actual: 150, usageKnown: true });
  assert.equal((await budget.capacity(env, { caps, scope: "free" })).halted, true);
});

test("P1-B: betald jämförelse – text som inte kan mätas (count_tokens fel) nekas, ingen uppskattning", async () => {
  const f = installFetch();
  try {
    const env = makeEnv();
    const c = await createOrder(env, 2); const { orderId, token } = c.json;
    f.ctl.countFail = true;
    const u = await upload(env, orderId, token, 0, S(100000, ALL));
    assert.equal(u.status, 503);
    assert.deepEqual(docKeys(env, orderId), []);
    f.ctl.countFail = false;
    assert.equal((await upload(env, orderId, token, 0, S(100000, ALL))).status, 200);
  } finally { f.restore(); }
});
