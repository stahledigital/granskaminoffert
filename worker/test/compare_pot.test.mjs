// D12-integration: betald jämförelse drar ur SAMMA ändliga pott som gratisgrenen (ingen separat/extra 20 USD-pott).
// Inga riktiga modellanrop/betalningar; Anthropic/Stripe är attrapper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, installFetch, api, readyOrder, startCheckout, paidSession, webhook } from "./helpers/compare_env.mjs";
import { gateVars } from "./helpers/free_gate.mjs";

const ALL = { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" };
const S = (total) => ({ extracted: { totalBeforeRotSek: total, totalVatBasis: "inkl" }, scope: ALL });
const status = async (env, id, token) => (await api(env, "GET", `/compare/orders/${id}`, { token })).json.order;
async function pay(env, f, orderId, token) {
  const co = await startCheckout(env, orderId, token); assert.equal(co.status, 200);
  const sess = [...f.sessions.values()].filter((s) => s.client_reference_id === orderId).pop();
  assert.equal((await webhook(env, "checkout.session.completed", paidSession(sess))).status, 200);
}
const pot = (env) => [...env.FREE_BUDGET.objects.values()][0];

test("betald körning: pott ej aktiverad ⇒ inget modellanrop, orderns fel pott:ej_aktiverad", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({ FREE_PILOT_ENABLED: "0" });
    const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
    await pay(env, f, orderId, token);
    await env.COMPARE_ORDERS.runAlarms();
    const st = await status(env, orderId, token);
    assert.equal(st.status, "failed"); assert.match(st.error, /^pott:/);
    assert.equal(f.log.anthropic.length, 0);
  } finally { f.restore(); }
});

test("betald körning: aktiv pott ⇒ levereras och potten belastas (samma pott som /review), inga hängande reservationer", async () => {
  const f = installFetch();
  try {
    const env = makeEnv();
    const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
    await pay(env, f, orderId, token);
    await env.COMPARE_ORDERS.runAlarms();
    assert.equal((await status(env, orderId, token)).status, "delivered");
    assert.ok(f.log.anthropic.length >= 2);
    const o = pot(env); assert.ok(o, "FreeBudget-objekt används av betald trafik");
    const m = o.store.get("m"); assert.ok(m && m.spent > 0, JSON.stringify(m));
    assert.equal(Object.keys(m.res || {}).length, 0, "alla reservationer avräknade");
    assert.equal(env.FREE_BUDGET.objects.size, 1, "endast EN pott, ingen extra");
  } finally { f.restore(); }
});

test("betald körning: för litet tak i potten ⇒ nekas före anrop (ingen separat 20 USD-pott för betald trafik)", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({ ...gateVars({ FREE_PILOT_CAP_MICRO: "1000" }) });
    const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
    await pay(env, f, orderId, token);
    await env.COMPARE_ORDERS.runAlarms();
    const st = await status(env, orderId, token);
    assert.equal(st.status, "failed"); assert.match(st.error, /^pott:/);
    assert.equal(f.log.anthropic.length, 0);
  } finally { f.restore(); }
});
