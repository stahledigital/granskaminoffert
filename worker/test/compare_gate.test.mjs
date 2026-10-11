// D08-rättning: avtalsbekräftelsen ska ha godkänd transportkvittens INNAN något arbete/någon räkning/generation startar (Modesty §5e).
// Offline med mock-/felattrapper för transporten. Ingen verklig mejlsändning, inget konto.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mailerKind, acceptingOrders } from "../src/compare_config.js";
import { makeEnv, installFetch, api, createOrder, readyOrder, startCheckout, paidSession, webhook } from "./helpers/compare_env.mjs";

const S = (t) => ({ extracted: { totalBeforeRotSek: t, totalVatBasis: "inkl" }, scope: { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" } });
const store = (env, id) => env.COMPARE_ORDERS.peek(id).store;
const conf = (env, id) => [...store(env, id)].filter(([k, v]) => k.startsWith("outbox:") && v.kind === "avtalsbekraftelse").map(([, v]) => v)[0];
const reset = (env, id) => { const st = store(env, id); for (const [k, v] of [...st]) if (k.startsWith("outbox:") && v.nextAt) st.set(k, { ...v, nextAt: 0 }); };
const status = async (env, id, token) => (await api(env, "GET", `/compare/orders/${id}`, { token })).json.order;
async function paid(env, f) {
  const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
  assert.equal((await startCheckout(env, orderId, token)).status, 200);
  assert.equal((await webhook(env, "checkout.session.completed", paidSession([...f.sessions.values()].pop()))).status, 200);
  return { orderId, token };
}
function transport({ down = false, lostAck = 0 } = {}) {
  const t = { tries: 0, down, lostAck, sentAt: null, delivered: new Map() };
  t.send = async (m) => {
    t.tries++;
    if (t.down) throw new Error("synthetic transport unavailable");
    if (!t.delivered.has(m.id)) { t.delivered.set(m.id, m); t.seq = t.seq ?? globalThis.__seq?.n; }
    if (t.lostAck > 0) { t.lostAck--; throw new Error("kvittens förlorad"); }
    return { ok: true, ref: "ref_" + m.id.slice(-8) };
  };
  return t;
}

test("rootprobens fall: transporten kastar ⇒ ett försök, kvar som queued, ordern väntar, 0 generationer och ingen räkning", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(); const t = transport({ down: true }); env.COMPARE_MAILER = t;
    const { orderId, token } = await paid(env, f); const b = f.log.count.length;
    await env.COMPARE_ORDERS.runAlarms(1);
    const st = await status(env, orderId, token);
    assert.equal(t.tries, 1); assert.equal(conf(env, orderId).state, "queued");
    assert.equal(st.status, "paid"); assert.equal(st.waiting, "avtalsbekraftelse"); assert.equal(st.progress.extracted, 0);
    assert.equal(f.log.anthropic.length, 0, "inga modellgenerationer"); assert.equal(f.log.count.length, b, "ingen token-räkning före bekräftelsen");
    assert.equal(st.error, null); assert.equal(st.refund.state, "none");
  } finally { f.restore(); }
});

test("återhämtning: efter kvittens startar arbetet; bekräftelsen är skickad FÖRE första modellanropet; omförsök använder samma meddelande-ID", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(); const t = transport({ down: true }); env.COMPARE_MAILER = t;
    const { orderId, token } = await paid(env, f); const b = f.log.count.length;
    await env.COMPARE_ORDERS.runAlarms(1);
    assert.equal(f.log.anthropic.length + f.log.count.length, b);
    t.down = false; reset(env, orderId);
    const realFetch = globalThis.fetch; let mailAckedBeforeModel = null;
    globalThis.fetch = async (...a) => { if (mailAckedBeforeModel === null) mailAckedBeforeModel = conf(env, orderId).state === "sent"; return realFetch(...a); };
    try { await env.COMPARE_ORDERS.runAlarms(); } finally { globalThis.fetch = realFetch; }
    assert.equal(mailAckedBeforeModel, true, "första externa modell-/räkneanropet kom efter lagrad kvittens");
    assert.equal(conf(env, orderId).state, "sent"); assert.equal(conf(env, orderId).attempts, 2);
    assert.equal([...t.delivered.keys()].filter((k) => k.startsWith("mail_avtal_")).length, 1);
    const st = await status(env, orderId, token); assert.equal(st.status, "delivered"); assert.equal(st.waiting, null);
    assert.equal(f.log.anthropic.length, 2);
  } finally { f.restore(); }
});

test("förlorad kvittens räknas inte som godkänd: arbetet väntar tills en kvittens faktiskt kommit; ingen dubblett", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(); const t = transport({ lostAck: 1 }); env.COMPARE_MAILER = t;
    const { orderId, token } = await paid(env, f); const b = f.log.count.length;
    await env.COMPARE_ORDERS.runAlarms(1);
    assert.equal([...t.delivered.keys()].filter((k) => k.startsWith("mail_avtal_")).length, 1); assert.equal(conf(env, orderId).state, "queued"); assert.equal(f.log.anthropic.length, 0); assert.equal((await status(env, orderId, token)).status, "paid");
    reset(env, orderId); await env.COMPARE_ORDERS.runAlarms();
    assert.equal(conf(env, orderId).state, "sent"); assert.equal([...t.delivered.keys()].filter((k) => k.startsWith("mail_avtal_")).length, 1, "samma meddelande-ID, transporten deduplicerar");
    assert.equal((await status(env, orderId, token)).status, "delivered");
  } finally { f.restore(); }
});

test("uttömning: ihållande transportfel ⇒ efter begränsat antal försök avbryts ordern ('bekraftelse_ej_levererad'), ingen generation, återbetalning enligt läge, innehåll raderat", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({ COMPARE_AUTO_REFUND: "1" }); const t = transport({ down: true }); env.COMPARE_MAILER = t;
    const { orderId, token } = await paid(env, f); const b = f.log.count.length;
    for (let i = 0; i < 30 && (await status(env, orderId, token)).status === "paid"; i++) { reset(env, orderId); await env.COMPARE_ORDERS.runAlarms(2); }
    const st = await status(env, orderId, token);
    assert.equal(conf(env, orderId).state, "failed"); assert.equal(conf(env, orderId).attempts, 12); assert.equal(t.tries, 12);
    assert.equal(st.status, "failed"); assert.equal(st.error, "bekraftelse_ej_levererad"); assert.equal(f.log.anthropic.length, 0); assert.equal(f.log.count.length, b);
    assert.equal(f.log.refunds.length, 1, "hel återbetalning begärd (auto), aldrig dubbel");
    assert.deepEqual([...store(env, orderId).keys()].filter((k) => k.startsWith("ext:")), []);
  } finally { f.restore(); }
});

test("tidsgräns: utan kvittens inom 30 min avbryts ordern och återbetalas (manuell återbetalning markeras 'needed')", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(); const t = transport({ down: true }); env.COMPARE_MAILER = t;
    const { orderId, token } = await paid(env, f); const b = f.log.count.length;
    await env.COMPARE_ORDERS.runAlarms(1);
    assert.equal((await status(env, orderId, token)).status, "paid");
    const real = Date.now; Date.now = () => real() + 31 * 60_000;
    try { reset(env, orderId); await env.COMPARE_ORDERS.runAlarms(2); } finally { Date.now = real; }
    const st = await status(env, orderId, token);
    assert.equal(st.status, "failed"); assert.equal(st.error, "bekraftelse_ej_levererad"); assert.equal(st.refund.state, "needed"); assert.equal(f.log.anthropic.length, 0);
  } finally { f.restore(); }
});

test("ånger medan ordern väntar på bekräftelsen: avbryts utan arbete, ingen generation", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(); env.COMPARE_MAILER = transport({ down: true });
    const { orderId, token } = await paid(env, f); const b = f.log.count.length;
    await env.COMPARE_ORDERS.runAlarms(1);
    const w = await api(env, "POST", `/compare/orders/${orderId}/withdraw`, { token });
    assert.equal(w.json.withdrawal.outcome, "avbrutet_fore_leverans");
    await env.COMPARE_ORDERS.runAlarms();
    assert.equal(f.log.anthropic.length, 0); assert.equal((await status(env, orderId, token)).error, "angrat");
  } finally { f.restore(); }
});

test("utan någon transport (varken adapter eller uttryckligt testläge) tas inga ordrar emot; mocktransport är förbjuden i live; mocken märks i utkorgen", async () => {
  const env = makeEnv({ COMPARE_MAILER_MODE: undefined });
  assert.equal(mailerKind(env), null); assert.equal(acceptingOrders(env, ["https://granskaminoffert.se"]), false);
  assert.equal((await api(env, "POST", "/compare/orders", { body: { docCount: 2, labels: ["a", "b"] } })).status, 503);
  assert.equal(mailerKind({ COMPARE_MAILER_MODE: "mock", COMPARE_PAYMENTS: "live" }), null);
  assert.equal(mailerKind({ COMPARE_MAILER_MODE: "mock", COMPARE_PAYMENTS: "test" }), "mock");
  assert.equal(mailerKind({ COMPARE_MAILER: { send() {} }, COMPARE_PAYMENTS: "live" }), "adapter");
  const f = installFetch();
  try {
    const e2 = makeEnv(); const { orderId } = await paid(e2, f);
    await e2.COMPARE_ORDERS.runAlarms();
    assert.equal(conf(e2, orderId).transport, "mock"); assert.match(conf(e2, orderId).providerRef, /^mock:/);
  } finally { f.restore(); }
});
