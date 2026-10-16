// D19 "Avsluta utkastet": serverkontrollerad, atomisk draft-only-semantik. Bredda inte befintlig DELETE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, createOrder, upload, readyOrder, startCheckout, paidSession, webhook, installFetch, api, docKeys } from "./helpers/compare_env.mjs";
import { startHarness } from "../dev/compare_harness.mjs";
import { offerText } from "./helpers/compare_env.mjs";

const S = (t) => ({ extracted: { totalBeforeRotSek: t, totalVatBasis: "inkl" }, scope: { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" } });
const closeDraft = (env, id, token, o = {}) => api(env, "POST", `/compare/orders/${id}/close-draft`, { token, ...o });
const stored = (env, id) => env.COMPARE_ORDERS.peek(id).store;

test("ofullständigt utkast och färdigt utkast kan avslutas: innehållet raderas, ordern blir deleted", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({});
    const c = await createOrder(env, 2); const { orderId, token } = c.json;
    assert.equal((await upload(env, orderId, token, 0, S(100000))).status, 200);
    assert.equal(docKeys(env, orderId).length, 1);
    const r = await closeDraft(env, orderId, token);
    assert.equal(r.status, 200); assert.equal(r.json.closed, true); assert.equal(r.json.order.status, "deleted"); assert.equal(r.json.order.docs.length, 0);
    assert.equal(docKeys(env, orderId).length, 0, "filer raderade ur KV");
    assert.equal(stored(env, orderId).get("order").contentDeleted, true);
    assert.equal((await upload(env, orderId, token, 1, S(95000))).status, 409, "avslutat utkast tar inte emot fler filer");

    const { orderId: o2, token: t2 } = await readyOrder(env, [S(100000), S(110000)]);
    assert.equal(stored(env, o2).get("order").status, "ready");
    const r2 = await closeDraft(env, o2, t2);
    assert.equal(r2.status, 200); assert.equal(r2.json.order.status, "deleted"); assert.equal(docKeys(env, o2).length, 0);
  } finally { f.restore(); }
});

test("åtkomst: fel nyckel, fel metod och främmande Origin rör aldrig ordern", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({}); const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
    assert.equal((await closeDraft(env, orderId, "A".repeat(43))).status, 404);
    assert.equal((await closeDraft(env, orderId, "kort")).status, 404);
    assert.equal((await api(env, "GET", `/compare/orders/${orderId}/close-draft`, { token })).status, 404);
    assert.equal((await api(env, "DELETE", `/compare/orders/${orderId}/close-draft`, { token })).status, 404);
    assert.equal((await closeDraft(env, orderId, token, { origin: "https://ond.example" })).status, 403);
    assert.equal((await closeDraft(env, orderId, token, { origin: null })).status, 403);
    assert.equal(stored(env, orderId).get("order").status, "ready");
    assert.equal(docKeys(env, orderId).length, 2);
  } finally { f.restore(); }
});

test("aktiv kassa, betalning, avtalspost och påbörjad checkout bevarar ordern helt (409, kept)", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({}); const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
    const st = stored(env, orderId);
    const base = JSON.stringify(st.get("order"));

    // påbörjad checkout (intent) men session ännu inte knuten: ordern står kvar som ready
    const o1 = st.get("order"); o1.checkout.intent = { attempt: 1, expiresAtSec: Math.floor(Date.now() / 1000) + 3600 }; st.set("order", o1);
    let r = await closeDraft(env, orderId, token);
    assert.equal(r.status, 409); assert.equal(r.json.kept, true); assert.equal(r.json.reason, "kassa"); assert.equal(r.json.order.status, "ready");
    // knuten Stripe-session men status ready (t.ex. efter återställning)
    const o2 = st.get("order"); o2.checkout.intent = null; o2.stripe = { sessionId: "cs_test_x", url: "https://checkout.stripe.test/c/cs_test_x", expiresAt: Date.now() + 1e6 }; st.set("order", o2);
    r = await closeDraft(env, orderId, token); assert.equal(r.status, 409); assert.equal(r.json.reason, "kassa");
    // paidAt satt men status ännu ready (inkonsekvent tillstånd får aldrig raderas)
    const o3 = st.get("order"); o3.stripe = null; o3.paidAt = Date.now(); st.set("order", o3);
    r = await closeDraft(env, orderId, token); assert.equal(r.status, 409); assert.equal(r.json.reason, "betald");
    // avtalspost finns
    const o4 = st.get("order"); o4.paidAt = null; st.set("order", o4); st.set("ledger", { agreement: { payment: { paidAt: Date.now() } } });
    r = await closeDraft(env, orderId, token); assert.equal(r.status, 409); assert.equal(r.json.reason, "avtalspost");
    st.delete("ledger");
    assert.equal(JSON.stringify(st.get("order")).includes('"status":"ready"'), true);
    assert.equal(docKeys(env, orderId).length, 2, "inga filer raderades av något avslag");
    void base;

    // aktiv kassa på riktigt: awaiting_payment
    const { orderId: o5, token: t5 } = await readyOrder(env, [S(100000), S(110000)]);
    assert.equal((await startCheckout(env, o5, t5)).status, 200);
    r = await closeDraft(env, o5, t5);
    assert.equal(r.status, 409); assert.equal(r.json.reason, "status"); assert.equal(r.json.order.status, "awaiting_payment");
    // betald och levererad order kan aldrig avslutas som utkast
    assert.equal((await webhook(env, "checkout.session.completed", paidSession([...f.sessions.values()].pop()))).status, 200);
    r = await closeDraft(env, o5, t5); assert.equal(r.status, 409); assert.notEqual(r.json.order.status, "deleted");
    assert.ok(stored(env, o5).get("ledger"), "avtalsposten finns kvar");
  } finally { f.restore(); }
});

test("race: avslut och checkout samtidigt ger aldrig både raderad order och knuten kassa", async () => {
  const f = installFetch();
  try {
    for (let i = 0; i < 12; i++) {
      const env = makeEnv({}); const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
      const [co, cl] = i % 2 ? await Promise.all([startCheckout(env, orderId, token), closeDraft(env, orderId, token)]).then(([a, b]) => [a, b]) : await Promise.all([closeDraft(env, orderId, token), startCheckout(env, orderId, token)]).then(([b, a]) => [a, b]);
      const o = stored(env, orderId).get("order");
      if (cl.status === 200) {
        assert.notEqual(co.status, 200, "kassa får inte skapas på ett avslutat utkast");
        assert.equal(o.status, "deleted"); assert.equal(o.stripe, null); assert.equal(docKeys(env, orderId).length, 0);
      } else {
        assert.equal(cl.status, 409);
        assert.equal(co.status, 200); assert.equal(o.status, "awaiting_payment"); assert.ok(o.stripe && o.stripe.sessionId);
        assert.equal(docKeys(env, orderId).length, 2, "ordern är helt kvar");
      }
    }
  } finally { f.restore(); }
});

test("befintlig DELETE är oförändrad och bredd-skyddad: pågående nekas, övriga tillstånd som förut", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({}); const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
    assert.equal((await startCheckout(env, orderId, token)).status, 200);
    const st = stored(env, orderId);
    const run = st.get("order"); run.status = "running"; st.set("order", run);
    const d1 = await api(env, "DELETE", `/compare/orders/${orderId}`, { token });
    assert.equal(d1.status, 409);
    const aw = st.get("order"); aw.status = "awaiting_payment"; st.set("order", aw);
    const d2 = await api(env, "DELETE", `/compare/orders/${orderId}`, { token });
    assert.equal(d2.status, 200); assert.equal(d2.json.order.status, "deleted"); assert.equal(docKeys(env, orderId).length, 0);
  } finally { f.restore(); }
});

test("workerd/SQLite: avslut av utkast via riktiga vägen; senare PUT och kassa nekas", async () => {
  const h = await startHarness();
  const call = (method, p, { token, body } = {}) => fetch(h.base + p, { method, headers: { Origin: h.base, ...(token ? { "x-order-token": token } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  try {
    const c = await (await call("POST", "/compare/orders", { body: { docCount: 2, labels: ["A", "B"], accept: { sameJob: true } } })).json();
    const { orderId, token } = c;
    assert.equal((await call("PUT", `/compare/orders/${orderId}/docs/0`, { token, body: { kind: "text", text: offerText(S(100000)) } })).status, 200);
    const r = await call("POST", `/compare/orders/${orderId}/close-draft`, { token });
    assert.equal(r.status, 200); const j = await r.json(); assert.equal(j.closed, true); assert.equal(j.order.status, "deleted");
    const g = await (await call("GET", `/compare/orders/${orderId}`, { token })).json();
    assert.equal(g.order.status, "deleted"); assert.equal(g.order.docs.length, 0);
    assert.equal((await call("PUT", `/compare/orders/${orderId}/docs/1`, { token, body: { kind: "text", text: offerText(S(95000)) } })).status, 409);
    const again = await call("POST", `/compare/orders/${orderId}/close-draft`, { token });
    assert.equal(again.status, 409, "redan avslutad: ingen ny radering, ingen krasch");
    assert.equal((await again.json()).reason, "status");
  } finally { await h.close(); }
});
