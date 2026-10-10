// D06-rättning: retention som FAKTISK mekanism (lazy + admin-svep) för policyvalda klasser. Utan fullständig fastställd policy raderas inget (fail closed).
// Tidsstyrning via fejkad Date.now. Offline, minnesadapter. Ingen schemaläggare/ny lagringsresurs är beslutad eller antagen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, installFetch, api, readyOrder, startCheckout, paidSession, webhook } from "./helpers/compare_env.mjs";

const DAY = 86400_000;
const ADMIN = "admin-token-for-tests-0123456789abcdef";
const S = (t) => ({ extracted: { totalBeforeRotSek: t, totalVatBasis: "inkl" }, scope: { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" } });
const POL = { COMPARE_LEDGER_RETENTION_DAYS: "30", COMPARE_BOOKKEEPING_RETENTION_DAYS: "90", COMPARE_ADMIN_TOKEN: ADMIN };
async function delivered(env, f) {
  const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
  await startCheckout(env, orderId, token);
  const sess = [...f.sessions.values()].pop();
  await webhook(env, "checkout.session.completed", paidSession(sess));
  await env.COMPARE_ORDERS.runAlarms();
  const st = (await api(env, "GET", `/compare/orders/${orderId}`, { token })).json.order;
  assert.equal(st.status, "delivered");
  return { orderId, token };
}
const keys = (env, id) => [...env.COMPARE_ORDERS.peek(id).store.keys()];
const sweep = (env, month, auth = ADMIN) => api(env, "POST", `/compare/admin/retention-sweep?month=${month}`, { headers: { authorization: "Bearer " + auth } });
const monthOf = (t) => new Date(t).toISOString().slice(0, 7);
function withClock(t, fn) { const real = Date.now; Date.now = () => t; return Promise.resolve().then(fn).finally(() => { Date.now = real; }); }

test("utan fullständig policy raderas ingenting, varken lazy eller via admin (fail closed)", async () => {
  const f = installFetch();
  try {
    for (const vars of [{ COMPARE_ADMIN_TOKEN: ADMIN }, { COMPARE_ADMIN_TOKEN: ADMIN, COMPARE_LEDGER_RETENTION_DAYS: "30" }, { COMPARE_ADMIN_TOKEN: ADMIN, COMPARE_BOOKKEEPING_RETENTION_DAYS: "90" }]) {
      const env = makeEnv(vars);
      const { orderId, token } = await delivered(env, f);
      const before = keys(env, orderId).sort();
      const far = Date.now() + 3650 * DAY;
      await withClock(far, async () => {
        assert.equal((await api(env, "GET", `/compare/orders/${orderId}`, { token })).status, 200);
        const r = await sweep(env, monthOf(Date.now() - 3650 * DAY));
        assert.equal(r.status, 200); assert.equal(r.json.ran, false); assert.equal(r.json.reason, "policy_saknas");
      });
      assert.deepEqual(keys(env, orderId).sort(), before);
      assert.ok(env.COMPARE_ORDERS.peek(orderId).store.get("ledger").agreement.contact.email);
    }
  } finally { f.restore(); }
});

test("avtalsklassen utgången: personuppgifts-/avtalsdelen rensas lazy, bokföringsdelen finns kvar och exporteras; ångra svarar 410", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(POL);
    const { orderId, token } = await delivered(env, f);
    const ledger0 = env.COMPARE_ORDERS.peek(orderId).store.get("ledger"); const paidAt = ledger0.agreement.payment.paidAt;
    // före avtalsdagarna: allt kvar
    await withClock(paidAt + 29 * DAY, async () => { assert.equal((await api(env, "GET", `/compare/orders/${orderId}`, { token })).status, 200); });
    assert.ok(env.COMPARE_ORDERS.peek(orderId).store.get("ledger").agreement.contact);
    // efter 30 dagar, före 90: lazy rensning vid åtkomst
    await withClock(paidAt + 31 * DAY, async () => {
      const r = await api(env, "GET", `/compare/orders/${orderId}`, { token }); assert.equal(r.status, 200);
      assert.equal(r.json.order.agreement.archived, true);
    });
    const l = env.COMPARE_ORDERS.peek(orderId).store.get("ledger");
    assert.equal(l.stripped, true);
    const dump = JSON.stringify([...env.COMPARE_ORDERS.peek(orderId).store]);
    assert.doesNotMatch(dump, /kund@example|contactEmail":"|villkor-utkast|ang_o_|withdrawTokenHash":"[0-9a-f]{64}/, "inga kund-/avtalsuppgifter kvar");
    assert.equal(keys(env, orderId).filter((k) => k.startsWith("outbox:")).length, 0);
    assert.equal(l.agreement.price.ore, 4900); assert.ok(l.agreement.payment.sessionId);
    // bokföringsexporten fungerar fortfarande på den rensade posten
    await withClock(paidAt + 32 * DAY, async () => {
      const ex = await api(env, "GET", `/compare/admin/ledger?month=${monthOf(paidAt)}`, { headers: { authorization: "Bearer " + ADMIN } });
      assert.equal(ex.json.count, 1); assert.equal(ex.json.rows[0].amountOre, 4900); assert.equal(ex.json.rows[0].retentionClass, "bokforing");
      const w = await api(env, "POST", `/compare/orders/${orderId}/withdraw`, { token }); assert.equal(w.status, 410);
    });
  } finally { f.restore(); }
});

test("bokföringsklassen utgången: admin-svepet raderar hela posten och indexraden; därefter 404 och tom export; öppna ärenden hålls kvar", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({ ...POL, COMPARE_AUTO_REFUND: "1" });
    const a = await delivered(env, f), b = await delivered(env, f);
    const paidAt = env.COMPARE_ORDERS.peek(a.orderId).store.get("ledger").agreement.payment.paidAt;
    // b har en ångerbegäran som väntar manuell prövning ⇒ hålls kvar även efter förfallotid
    assert.equal((await api(env, "POST", `/compare/orders/${b.orderId}/withdraw`, { token: b.token })).json.withdrawal.outcome, "manuell_provning");
    const month = monthOf(paidAt);
    await withClock(paidAt + 89 * DAY, async () => { const r = await sweep(env, month); assert.equal(r.json.purged, 0); });
    assert.ok(keys(env, a.orderId).includes("ledger"));
    await withClock(paidAt + 91 * DAY, async () => {
      const r = await sweep(env, month);
      assert.equal(r.status, 200); assert.equal(r.json.checked, 2); assert.equal(r.json.purged, 1); assert.deepEqual(r.json.held, { manuell_provning_oppen: 1 });
      assert.equal((await api(env, "GET", `/compare/orders/${a.orderId}`, { token: a.token })).status, 404);
      const ex = await api(env, "GET", `/compare/admin/ledger?month=${month}`, { headers: { authorization: "Bearer " + ADMIN } });
      assert.equal(ex.json.count, 1, "bara den hållna posten finns kvar i exporten");
    });
    assert.deepEqual(keys(env, a.orderId), [], "alla lagringsnycklar borta");
    assert.ok(keys(env, b.orderId).includes("ledger"));
    const idx = [...env.COMPARE_BUDGET.peek("jamfor-budget").store.keys()].filter((k) => k.startsWith("x:"));
    assert.equal(idx.length, 1); assert.ok(idx[0].endsWith(b.orderId));
    // admin kräver token
    assert.equal((await sweep(env, month, "fel-token-fel-token-fel-token-xx")).status, 404);
    assert.equal((await api(env, "POST", `/compare/admin/retention-sweep?month=${month}`)).status, 404);
  } finally { f.restore(); }
});

test("pågående order eller öppen återbetalning raderas aldrig av svepet", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(POL);
    const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
    await startCheckout(env, orderId, token);
    await webhook(env, "checkout.session.completed", paidSession([...f.sessions.values()].pop()));
    const st = env.COMPARE_ORDERS.peek(orderId).store; const paidAt = st.get("ledger").agreement.payment.paidAt;
    await withClock(paidAt + 400 * DAY, async () => {
      const r = await sweep(env, monthOf(paidAt)); assert.equal(r.json.purged + r.json.stripped, 0); assert.deepEqual(r.json.held, { arendet_oppet: 1 });
    });
    assert.ok(st.get("ledger"));
    await env.COMPARE_ORDERS.runAlarms();
    const o = st.get("order"); o.refund.state = "needed"; st.set("order", o);
    await withClock(paidAt + 400 * DAY, async () => { const r = await sweep(env, monthOf(paidAt)); assert.deepEqual(r.json.held, { aterbetalning_oppen: 1 }); });
    assert.ok(st.get("ledger") && st.get("order"));
  } finally { f.restore(); }
});
