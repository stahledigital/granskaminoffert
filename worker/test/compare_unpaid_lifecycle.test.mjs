// D15 (förslag): obetalda ordrar rensas fysiskt automatiskt (fas 1 fil/extraktion/källor, fas 2 hela orderposten). Betalda ordrar berörs inte.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, readyOrder, startCheckout, paidSession, webhook, installFetch } from "./helpers/compare_env.mjs";

const S = (t) => ({ extracted: { totalBeforeRotSek: t, totalVatBasis: "inkl" }, scope: { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" } });
const withClock = async (off, fn) => { const real = Date.now; Date.now = () => real() + off; try { return await fn(); } finally { Date.now = real; } };
const H = 3600_000;

test("obetald order: alarm vid utgång+65 min raderar filer/innehåll, hela posten efter 72 h; larm sätts redan vid skapande", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({}); const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
    const peek = env.COMPARE_ORDERS.peek(orderId), st = peek.store;
    assert.ok(peek.alarm !== null, "larm satt vid skapande"); assert.ok(st.get("order").docs.length === 2);
    const kvBefore = [...env.REVIEWS_KV._m ? env.REVIEWS_KV._m.keys() : []].length;
    await withClock(26 * H, async () => { peek.clearAlarm(); await peek.obj.alarm(); });
    assert.equal(st.get("order").docs.length, 0, "innehållsreferenser borta efter fas 1"); assert.equal(st.get("order").contentDeleted, true); assert.ok(peek.alarm !== null, "fas 2 schemalagd");
    await withClock(97 * H, async () => { peek.clearAlarm(); await peek.obj.alarm(); });
    assert.equal(st.size, 0, "hela orderposten (inkl. e-post/snapshot) raderad efter 72 h");
    void kvBefore;
  } finally { f.restore(); }
});
test("betald order berörs aldrig av obetald-rensningen", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({}); const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
    assert.equal((await startCheckout(env, orderId, token)).status, 200);
    assert.equal((await webhook(env, "checkout.session.completed", paidSession([...f.sessions.values()].pop()))).status, 200);
    const st = env.COMPARE_ORDERS.peek(orderId).store;
    await withClock(97 * H, async () => { await env.COMPARE_ORDERS.runAlarms(8); });
    assert.ok(st.get("order") && st.get("ledger"), "betald order och avtalspost finns kvar");
  } finally { f.restore(); }
});

test("avtalspost/betalning som uppstår före fullwipe stoppar rensningen: order och ledger raderas aldrig", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({}); const { orderId } = await readyOrder(env, [S(100000), S(110000)]);
    const peek = env.COMPARE_ORDERS.peek(orderId), st = peek.store;
    await withClock(26 * H, async () => { peek.clearAlarm(); await peek.obj.alarm(); }); // fas 1
    st.set("ledger", { agreement: { payment: { paidAt: Date.now() } } }); // betalning hann in efter fas 1
    await withClock(97 * H, async () => { peek.clearAlarm(); await peek.obj.alarm(); });
    assert.ok(st.get("order") && st.get("ledger"), "inget raderades");
    const o = st.get("order"); o.paidAt = Date.now(); st.delete("ledger"); st.set("order", o); // paidAt utan ledger
    await withClock(97 * H, async () => { peek.clearAlarm(); await peek.obj.alarm(); });
    assert.ok(st.get("order"), "betald order raderas aldrig");
  } finally { f.restore(); }
});
