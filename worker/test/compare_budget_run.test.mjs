import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, installFetch, api, createOrder, upload, readyOrder, startCheckout, paidSession, webhook, docKeys } from "./helpers/compare_env.mjs";
import * as budget from "../src/compare_budget.js";

const S = (total, scope = {}) => ({ extracted: { totalBeforeRotSek: total, totalVatBasis: "inkl" }, scope });
const ALL = { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" };
const caps = { joint: 1000, scope: 800, order: 600 };
const now = new Date("2026-10-10T12:00:00Z");

async function pay(env, f, orderId, token) {
  await startCheckout(env, orderId, token);
  const sess = [...f.sessions.values()].find((s) => s.client_reference_id === orderId);
  return webhook(env, "checkout.session.completed", paidSession(sess));
}
const status = async (env, orderId, token) => (await api(env, "GET", `/compare/orders/${orderId}`, { token })).json.order;

test("budget: två samtidiga reservationer som tillsammans överskrider taket → exakt en går igenom", async () => {
  const env = makeEnv();
  const rs = await Promise.all([
    budget.reserve(env, { key: "k:a", scope: "paid", orderId: "o_a", micro: 500, caps, now }),
    budget.reserve(env, { key: "k:b", scope: "paid", orderId: "o_b", micro: 500, caps: { ...caps, order: 700 }, now }),
    budget.reserve(env, { key: "k:c", scope: "paid", orderId: "o_c", micro: 500, caps: { ...caps, order: 700 }, now }),
  ]);
  assert.equal(rs.filter((r) => r.ok).length, 1);
  assert.ok(rs.filter((r) => !r.ok).every((r) => ["gemensamt_tak", "deltak"].includes(r.reason)));
});

test("budget: idempotent nyckel, ordertak, release frigör, settle med verklig kostnad", async () => {
  const env = makeEnv();
  assert.deepEqual(await budget.reserve(env, { key: "k:1", scope: "paid", orderId: "o_x", micro: 400, caps, now }), { ok: true, idempotent: false });
  assert.equal((await budget.reserve(env, { key: "k:1", scope: "paid", orderId: "o_x", micro: 400, caps, now })).idempotent, true);
  assert.equal((await budget.reserve(env, { key: "k:2", scope: "paid", orderId: "o_x", micro: 300, caps, now })).reason, "ordertak"); // 400+300 > 600
  assert.equal((await budget.capacity(env, { caps, scope: "paid", now })).remaining, 400);
  await budget.settle(env, { key: "k:1", actual: 100, usageKnown: true });
  assert.equal((await budget.capacity(env, { caps, scope: "paid", now })).remaining, 700);
  assert.ok((await budget.reserve(env, { key: "k:3", scope: "paid", orderId: "o_y", micro: 300, caps, now })).ok);
  await budget.release(env, { key: "k:3" });
  assert.equal((await budget.capacity(env, { caps, scope: "paid", now })).remaining, 700);
});

test("budget: saknat/ogiltigt tak och saknad bindning nekas; okänd användning stoppar nya generationer", async () => {
  const env = makeEnv();
  assert.equal((await budget.reserve(env, { key: "k:1", scope: "paid", orderId: "o_x", micro: 10, caps: { joint: 0, scope: 5, order: 5 }, now })).ok, false);
  assert.equal((await budget.reserve(env, { key: "k:1", scope: "paid", orderId: "o_x", micro: 10, caps: {}, now })).ok, false);
  assert.equal((await budget.reserve({ ...env, COMPARE_BUDGET: undefined }, { key: "k:1", scope: "paid", orderId: "o_x", micro: 10, caps, now })).ok, false);
  assert.ok((await budget.reserve(env, { key: "k:ok", scope: "paid", orderId: "o_x", micro: 10, caps, now })).ok);
  await budget.settle(env, { key: "k:ok", actual: 10, usageKnown: false });
  const r = await budget.reserve(env, { key: "k:next", scope: "paid", orderId: "o_x", micro: 10, caps, now });
  assert.equal(r.ok, false); assert.equal(r.reason, "stopp_oklar_anvandning");
  assert.equal((await budget.capacity(env, { caps, scope: "paid", now })).halted, true);
});

test("pipeline: transient 529 → ett omförsök på samma steg, leverans", async () => {
  const f = installFetch({ failNext: [529] });
  try {
    const env = makeEnv();
    const { orderId, token } = await readyOrder(env, [S(1000, ALL), S(1100, ALL)]);
    await pay(env, f, orderId, token); await env.COMPARE_ORDERS.runAlarms();
    assert.equal((await status(env, orderId, token)).status, "delivered");
    assert.equal(f.log.anthropic.filter((r) => r.tools[0].name === "submit_offer").length, 3); // 2 offerter + 1 omförsök
  } finally { f.restore(); }
});

test("pipeline: ihållande fel → misslyckad leverans, återbetalning 'needed' (manuellt läge), rådata raderad", async () => {
  const f = installFetch({ failNext: [500, 500, 500, 500, 500, 500, 500, 500] });
  try {
    const env = makeEnv();
    const { orderId, token } = await readyOrder(env, [S(1000, ALL), S(1100, ALL)]);
    await pay(env, f, orderId, token); await env.COMPARE_ORDERS.runAlarms();
    const st = await status(env, orderId, token);
    assert.equal(st.status, "failed"); assert.equal(st.refund.state, "needed"); assert.equal(st.refund.mode, "manual");
    assert.equal(f.log.refunds.length, 0); // ingen riktig återbetalning i manuellt läge
    assert.deepEqual(docKeys(env, orderId), []);
    assert.equal((await api(env, "GET", `/compare/orders/${orderId}/report`, { token })).status, 409);
  } finally { f.restore(); }
});

test("pipeline: auto-återbetalning begärs bara när läget är på, och bara en gång", async () => {
  const f = installFetch({ failNext: Array(12).fill(500) });
  try {
    const env = makeEnv({ COMPARE_AUTO_REFUND: "1" });
    const { orderId, token } = await readyOrder(env, [S(1000, ALL), S(1100, ALL)]);
    await pay(env, f, orderId, token); await env.COMPARE_ORDERS.runAlarms();
    const st = await status(env, orderId, token);
    assert.equal(st.status, "failed"); assert.equal(st.refund.state, "done"); assert.equal(f.log.refunds.length, 1);
  } finally { f.restore(); }
});

test("pipeline: tidsgräns mot modellen = oklar användning → stopp, ingen blind omkörning, order misslyckas", async () => {
  const f = installFetch({ timeoutNext: 1 });
  try {
    const env = makeEnv();
    const { orderId, token } = await readyOrder(env, [S(1000, ALL), S(1100, ALL)]);
    await pay(env, f, orderId, token); await env.COMPARE_ORDERS.runAlarms();
    assert.equal((await status(env, orderId, token)).status, "failed");
    assert.equal(f.log.anthropic.length, 1);
    assert.equal((await budget.capacity(env, { caps: { joint: 20000000, scope: 10000000 }, scope: "paid" })).halted, true);
  } finally { f.restore(); }
});

test("pipeline: svar utan användningsdata behandlas som oklar användning (halt)", async () => {
  const f = installFetch({ noUsage: true });
  try {
    const env = makeEnv();
    const { orderId, token } = await readyOrder(env, [S(1000, ALL), S(1100, ALL)]);
    await pay(env, f, orderId, token); await env.COMPARE_ORDERS.runAlarms();
    assert.equal((await budget.capacity(env, { caps: { joint: 20000000, scope: 10000000 }, scope: "paid" })).halted, true);
  } finally { f.restore(); }
});

test("pipeline: tak borttaget efter betalning → inget modellanrop, misslyckas utan kostnad", async () => {
  const f = installFetch();
  try {
    const env = makeEnv();
    const { orderId, token } = await readyOrder(env, [S(1000, ALL), S(1100, ALL)]);
    await pay(env, f, orderId, token);
    delete env.COMPARE_PAID_CAP_MICRO;
    await env.COMPARE_ORDERS.runAlarms();
    const st = await status(env, orderId, token);
    assert.equal(st.status, "failed"); assert.equal(f.log.anthropic.length, 0);
  } finally { f.restore(); }
});

test("pipeline: ordertaket räcker inte för alla avläsningar → stoppas mitt i, ingen överskridning", async () => {
  const f = installFetch();
  try {
    // Värsta fall per offert (3000+600 in, 6000 ut, 2/10 USD) ≈ 67 200 µUSD. Tak 100 000 klarar en men inte två.
    const env = makeEnv({ COMPARE_ORDER_CAP_MICRO: "100000" });
    const c = await createOrder(env, 2); const { orderId, token } = c.json;
    assert.equal((await upload(env, orderId, token, 0, S(1000, ALL))).status, 200);
    const last = await upload(env, orderId, token, 1, S(1100, ALL));
    assert.equal(last.status, 503); // hela ordern ryms inte under taket: nekas före betalning
    assert.equal((await startCheckout(env, orderId, token)).status, 409);
    assert.equal(f.log.stripeCreate.length, 0);
  } finally { f.restore(); }
});

test("uppladdning: dubblettfil, fel format, för stor token-mängd, för lång text, fel antal, saknade villkor", async () => {
  const f = installFetch();
  try {
    const env = makeEnv();
    assert.equal((await api(env, "POST", "/compare/orders", { body: { docCount: 1, accept: { sameJob: true } } })).status, 400);
    assert.equal((await api(env, "POST", "/compare/orders", { body: { docCount: 5, accept: { sameJob: true } } })).status, 400);
    assert.equal((await api(env, "POST", "/compare/orders", { body: { docCount: 2, accept: { terms: true, immediateDelivery: true } } })).status, 400);
    assert.equal((await api(env, "POST", "/compare/orders", { origin: "https://evil.example", body: { docCount: 2, accept: { sameJob: true } } })).status, 403);
    const { orderId, token } = (await createOrder(env, 2)).json;
    assert.equal((await upload(env, orderId, token, 0, S(1, ALL))).status, 200);
    assert.equal((await api(env, "POST", `/compare/orders/${orderId}/checkout`, { token, body: { accept: { terms: true } } })).status, 400); // saknar samtycke till direkt leverans
    assert.equal((await upload(env, orderId, token, 1, S(1, ALL))).status, 409); // samma innehåll
    const put = (body) => api(env, "PUT", `/compare/orders/${orderId}/docs/1`, { token, body });
    assert.equal((await put({ kind: "pdf", dataBase64: btoa("inte en pdf") })).status, 400);
    assert.equal((await put({ kind: "text", text: "x".repeat(20001) })).status, 400);
    assert.equal((await put({ kind: "exe", text: "x" })).status, 400);
    f.ctl.countTokens = 70000;
    assert.equal((await put({ kind: "text", text: "hej" })).status, 400);
    f.ctl.countTokens = 3000;
    assert.equal((await api(env, "PUT", `/compare/orders/${orderId}/docs/3`, { token, body: { kind: "text", text: "hej" } })).status, 400); // index utanför antal
    const ok = await put({ kind: "pdf", dataBase64: btoa("%PDF-1.4\n/Type /Page\n/Type /Page") });
    assert.equal(ok.status, 200); assert.equal(ok.json.doc.pages, 2);
  } finally { f.restore(); }
});

test("dagsgräns för nya ordrar", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({ COMPARE_DAY_ORDERS: "2" });
    assert.equal((await createOrder(env, 2)).status, 201);
    assert.equal((await createOrder(env, 2)).status, 201);
    assert.equal((await createOrder(env, 2)).status, 429);
  } finally { f.restore(); }
});

test("radera: kundens radering tar bort rapport; pågående order kan inte raderas", async () => {
  const f = installFetch();
  try {
    const env = makeEnv();
    const { orderId, token } = await readyOrder(env, [S(1000, ALL), S(1100, ALL)]);
    await pay(env, f, orderId, token); await env.COMPARE_ORDERS.runAlarms();
    assert.equal((await api(env, "GET", `/compare/orders/${orderId}/report`, { token })).status, 200);
    const d = await api(env, "DELETE", `/compare/orders/${orderId}`, { token });
    assert.equal(d.status, 200); assert.equal(d.json.order.contentDeleted, true);
    assert.equal((await api(env, "GET", `/compare/orders/${orderId}/report`, { token })).status, 409);
    assert.equal(await env.REVIEWS_KV.get(`cmprep:${orderId}`), null);
  } finally { f.restore(); }
});

test("injektion i dokument: text som styr modellen påverkar inte betalning/rapport; flaggas", async () => {
  const f = installFetch();
  try {
    const env = makeEnv();
    const { orderId, token } = await readyOrder(env, [{ ...S(1000, ALL), inj: true }, S(1100, ALL)]);
    await pay(env, f, orderId, token); await env.COMPARE_ORDERS.runAlarms();
    const rep = (await api(env, "GET", `/compare/orders/${orderId}/report`, { token })).json.report;
    assert.ok(rep.differences.some((d) => d.id === "inj:0"));
    assert.equal(rep.receipt.amountOre, 4900);
  } finally { f.restore(); }
});
