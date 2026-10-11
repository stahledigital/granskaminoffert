// D06-rättning: ledger + order + utkorg skrivs i EN lagringstransaktion; utan transaktions-API repareras delskrivning idempotent.
// Offline (minnesadapter med transaktions-rollback). Inget bevis för verklig Cloudflare-persistens eller verkligt krasch-beteende.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, installFetch, api, readyOrder, startCheckout, paidSession, webhook } from "./helpers/compare_env.mjs";

const S = (total) => ({ extracted: { totalBeforeRotSek: total, totalVatBasis: "inkl" }, scope: { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" } });
const store = (env, id) => env.COMPARE_ORDERS.peek(id);
async function paid(env, f) {
  const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
  assert.equal((await startCheckout(env, orderId, token)).status, 200);
  const sess = [...f.sessions.values()].pop();
  return { orderId, token, sess };
}
const failOrderPut = (env, id, pred) => {
  const st = store(env, id).obj.state.storage; const put = st.put.bind(st); let n = 0;
  st.put = async (k, v) => { if (k === "order" && pred(v) && !n++) throw new Error("injicerat skrivfel"); return put(k, v); };
  return () => n;
};
const outboxKeys = (env, id) => [...store(env, id).store.keys()].filter((k) => k.startsWith("outbox:"));

for (const mode of ["transaktion", "utan transaktions-API"]) {
  test(`ångerbegäran: skrivfel på order efter ledger (${mode}) ger konsistent läge, ingen modellkörning, högst en återbetalning`, async () => {
    const f = installFetch();
    try {
      const env = makeEnv({ COMPARE_AUTO_REFUND: "1" }); if (mode !== "transaktion") env.__noTxn = true;
      const { orderId, token, sess } = await paid(env, f);
      await webhook(env, "checkout.session.completed", paidSession(sess));
      const hits = failOrderPut(env, orderId, (v) => v.work?.error === "angrat");
      const first = await api(env, "POST", `/compare/orders/${orderId}/withdraw`, { token });
      assert.equal(hits(), 1); assert.equal(first.status, 503);
      if (mode === "transaktion") { // inget delvis skrivet: ledger saknar ännu ångerbegäran
        assert.ok(!store(env, orderId).store.get("ledger").withdrawal);
      }
      const retry = await api(env, "POST", `/compare/orders/${orderId}/withdraw`, { token });
      assert.equal(retry.status, 200);
      await env.COMPARE_ORDERS.runAlarms();
      const st = (await api(env, "GET", `/compare/orders/${orderId}`, { token })).json.order;
      assert.equal(st.withdrawal?.outcome, "avbrutet_fore_leverans");
      assert.equal(st.status, "failed");
      assert.equal(f.log.anthropic.length, 0, "ingen modellgeneration efter ångrad beställning");
      assert.equal(f.log.refunds.length, 1, "exakt en återbetalning");
      const l = store(env, orderId).store.get("ledger");
      assert.equal(l.withdrawal.outcome, "avbrutet_fore_leverans");
      assert.ok(outboxKeys(env, orderId).length >= 2, "bekräftelse + kvitto köade");
    } finally { f.restore(); }
  });

  test(`ångerbegäran: delskrivet läge (ledger skrivet, order ej) repareras av alarm utan att kunden gör om (${mode})`, async () => {
    const f = installFetch();
    try {
      const env = makeEnv({ COMPARE_AUTO_REFUND: "1" }); if (mode !== "transaktion") env.__noTxn = true;
      const { orderId, token, sess } = await paid(env, f);
      await webhook(env, "checkout.session.completed", paidSession(sess));
      failOrderPut(env, orderId, (v) => v.work?.error === "angrat");
      await api(env, "POST", `/compare/orders/${orderId}/withdraw`, { token });
      await env.COMPARE_ORDERS.runAlarms();
      const st = (await api(env, "GET", `/compare/orders/${orderId}`, { token })).json.order;
      const l = store(env, orderId).store.get("ledger");
      if (mode === "transaktion") { // allt eller inget: kunden fick 503 och ordern är orörd (ingen halv ångerbegäran)
        assert.ok(!l.withdrawal); assert.ok(!st.withdrawal || st.withdrawal.requested === false);
      } else { // delskrivet läge repareras av alarm: ångerbegäran gäller, inget arbete körs
        assert.equal(f.log.anthropic.length, 0);
        assert.equal(l.withdrawal.outcome, "avbrutet_fore_leverans"); assert.equal(st.status, "failed");
        assert.ok(f.log.refunds.length <= 1);
      }
    } finally { f.restore(); }
  });

  test(`betalning: skrivfel på order efter ledger/utkorg (${mode}) ger inte dubbla bekräftelser eller förlorad betalning`, async () => {
    const f = installFetch();
    try {
      const env = makeEnv(); if (mode !== "transaktion") env.__noTxn = true;
      const { orderId, token, sess } = await paid(env, f);
      const hits = failOrderPut(env, orderId, (v) => v.status === "paid");
      const w1 = await webhook(env, "checkout.session.completed", paidSession(sess));
      assert.equal(hits(), 1); assert.ok(w1.status >= 500, "webhooken svarar fel så att Stripe skickar om");
      const w2 = await webhook(env, "checkout.session.completed", paidSession(sess));
      assert.equal(w2.status, 200);
      await env.COMPARE_ORDERS.runAlarms();
      const st = (await api(env, "GET", `/compare/orders/${orderId}`, { token })).json.order;
      assert.ok(["paid", "running", "delivered"].includes(st.status), "status " + st.status);
      const conf = [...store(env, orderId).store].filter(([k, v]) => k.startsWith("outbox:") && /bekr/i.test(JSON.stringify(v.kind || v.type || "")));
      assert.ok(conf.length <= 1, "högst en bekräftelsepost");
    } finally { f.restore(); }
  });
}
