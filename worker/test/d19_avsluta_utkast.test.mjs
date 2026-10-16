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

// ---- P1 (Codex 2026-10-16): beständigt beslut FÖRE destruktiv städning; faultprov på sista save och efterföljande resume/checkout ----
const failOrderPut = (env, id, { times = 1, skip = 0 } = {}) => {
  const storage = env.COMPARE_ORDERS.peek(id).obj.state.storage; const real = storage.put.bind(storage);
  let left = times, toSkip = skip;
  storage.put = async (k, v) => { if (k === "order" && left > 0) { if (toSkip > 0) { toSkip--; } else { left--; throw new Error("injicerat skrivfel"); } } return real(k, v); };
  return () => { storage.put = real; };
};

test("P1: fel på sista order-save raderar ingenting; ordern är kvar, återupptagbar och betalbar MED dokumentbytes", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({}); const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
    const bytesBefore = docKeys(env, orderId).map((k) => [k, env.REVIEWS_KV.m.get(k)]);
    assert.equal(bytesBefore.length, 2);
    const restore = failOrderPut(env, orderId);
    const r = await closeDraft(env, orderId, token);
    assert.equal(r.status, 503, "ärligt fel");
    assert.match(String(r.json.error), /Ordern är kvar/);
    restore();
    const o = stored(env, orderId).get("order");
    assert.equal(o.status, "ready"); assert.equal(o.docs.length, 2); assert.notEqual(o.contentDeleted, true);
    assert.deepEqual(docKeys(env, orderId).map((k) => [k, env.REVIEWS_KV.m.get(k)]), bytesBefore, "KV-dokumenten är oförändrade (byte för byte)");
    // Återupptagning: ordern kan läsas och gå till kassa; kassan får aldrig sluta på en order utan underlag
    const g = await api(env, "GET", `/compare/orders/${orderId}`, { token });
    assert.equal(g.json.order.status, "ready"); assert.equal(g.json.order.docs.length, 2);
    const co = await startCheckout(env, orderId, token);
    assert.equal(co.status, 200);
    const o2 = stored(env, orderId).get("order");
    assert.equal(o2.status, "awaiting_payment"); assert.equal(o2.docs.length, 2);
    assert.equal(docKeys(env, orderId).length, 2, "underlagen finns kvar när kassan öppnats");
    // Och ett senare, lyckat avslut är fortfarande nekat av kassaguarden
    assert.equal((await closeDraft(env, orderId, token)).status, 409);
  } finally { f.restore(); }
});

test("P1: samma fel följt av nytt försök lyckas fullständigt (idempotent återhämtning)", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({}); const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
    const restore = failOrderPut(env, orderId, { times: 1 });
    assert.equal((await closeDraft(env, orderId, token)).status, 503);
    restore();
    const r = await closeDraft(env, orderId, token);
    assert.equal(r.status, 200); assert.equal(r.json.order.status, "deleted");
    assert.equal(docKeys(env, orderId).length, 0);
    assert.equal((await startCheckout(env, orderId, token)).status === 200, false, "avslutad order går aldrig till kassa");
  } finally { f.restore(); }
});

test("P1: fel på uppföljande sparning eller på KV-radering efter lyckat beslut: ordern är ändå beständigt avslutad, aldrig återupptagbar", async () => {
  const f = installFetch();
  try {
    // (a) andra sparningen (purgeKeys-rensning) misslyckas
    let env = makeEnv({}); let { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
    let restore = failOrderPut(env, orderId, { times: 1, skip: 1 });
    let r = await closeDraft(env, orderId, token); restore();
    assert.equal(r.status, 200); assert.equal(r.json.order.status, "deleted");
    let o = stored(env, orderId).get("order");
    assert.equal(o.status, "deleted"); assert.equal(o.contentDeleted, true); assert.equal(o.docs.length, 0);
    assert.equal(docKeys(env, orderId).length, 0);
    assert.notEqual((await startCheckout(env, orderId, token)).status, 200);
    // (b) KV-radering av ett dokument kastar: beslutet står, nyckeln ligger i purgeKeys (TTL är reservvägen)
    env = makeEnv({}); ({ orderId, token } = await readyOrder(env, [S(100000), S(110000)]));
    const keys = docKeys(env, orderId); const realDel = env.REVIEWS_KV.delete.bind(env.REVIEWS_KV);
    env.REVIEWS_KV.delete = async (k) => { if (k === keys[1]) throw new Error("kv nere"); return realDel(k); };
    r = await closeDraft(env, orderId, token);
    assert.equal(r.status, 200); assert.equal(r.json.closed, true);
    o = stored(env, orderId).get("order");
    assert.equal(o.status, "deleted"); assert.equal(o.contentDeleted, true); assert.deepEqual(o.docs, []);
    assert.deepEqual(o.purgeKeys, [keys[1]], "bara den misslyckade nyckeln återstår för TTL-reserven");
    assert.equal((await upload(env, orderId, token, 0, S(100000))).status, 409);
    assert.notEqual((await startCheckout(env, orderId, token)).status, 200);
    assert.equal(stored(env, orderId).get("order").status, "deleted");
  } finally { f.restore(); }
});

test("P1: befintliga /delete har samma säkra ordning men oförändrad policy och åtkomst", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({}); const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
    assert.equal((await startCheckout(env, orderId, token)).status, 200); // awaiting_payment: /delete får fortfarande radera (oförändrad policy)
    const restore = failOrderPut(env, orderId);
    const bad = await api(env, "DELETE", `/compare/orders/${orderId}`, { token });
    assert.notEqual(bad.json.ok, true, "befintlig route svarar ok:false (oförändrat svarsformat)"); restore();
    assert.equal(stored(env, orderId).get("order").status, "awaiting_payment"); assert.equal(docKeys(env, orderId).length, 2);
    assert.equal((await api(env, "DELETE", `/compare/orders/${orderId}`, { token: "A".repeat(43) })).status, 404, "fel nyckel oförändrat");
    const ok = await api(env, "DELETE", `/compare/orders/${orderId}`, { token });
    assert.equal(ok.status, 200); assert.equal(ok.json.order.status, "deleted"); assert.equal(docKeys(env, orderId).length, 0);
  } finally { f.restore(); }
});

// ---- CP2-QA 1 (Codex 2026-10-16 23:39): lokal aux-städning (ext:*, sources, preid, check) måste faktiskt ske, inte sväljas ----
const AUX = ["ext:0", "ext:1", "sources", "preid", "check"];
const seedAux = (env, id) => { const st = stored(env, id); for (const k of AUX) st.set(k, { seed: k }); };
const auxLeft = (env, id) => AUX.filter((k) => stored(env, id).has(k));
const failDelete = (env, id, names) => {
  const storage = env.COMPARE_ORDERS.peek(id).obj.state.storage; const real = storage.delete.bind(storage);
  storage.delete = async (k) => { if (names.includes(k)) throw new Error("injicerat raderingsfel " + k); return real(k); };
  return () => { storage.delete = real; };
};

test("CP2-1: aux-raderingsfel i avslutet rullar tillbaka ALLT (ordern kvar, KV och aux orörda) – och när felet är borta städas allt fysiskt", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({}); const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
    seedAux(env, orderId);
    const kv0 = docKeys(env, orderId).map((k) => [k, env.REVIEWS_KV.m.get(k)]);
    assert.equal(kv0.length, 2);
    const restore = failDelete(env, orderId, ["sources"]);
    const r = await closeDraft(env, orderId, token);
    assert.equal(r.status, 503, "ärligt fel: ordern är kvar");
    restore();
    const o = stored(env, orderId).get("order");
    assert.equal(o.status, "ready"); assert.equal(o.docs.length, 2); assert.notEqual(o.contentDeleted, true);
    assert.deepEqual(auxLeft(env, orderId), AUX, "lokal rollback: ingen aux-nyckel raderades");
    assert.deepEqual(docKeys(env, orderId).map((k) => [k, env.REVIEWS_KV.m.get(k)]), kv0, "KV orört");
    // felet borta: nytt försök lyckas och ALLT är fysiskt borta
    const ok = await closeDraft(env, orderId, token);
    assert.equal(ok.status, 200); assert.equal(ok.json.order.status, "deleted");
    assert.deepEqual(auxLeft(env, orderId), [], "ext:*, sources, preid och check är fysiskt raderade");
    assert.equal(docKeys(env, orderId).length, 0);
    const o2 = stored(env, orderId).get("order"); assert.equal(o2.contentDeleted, true); assert.deepEqual(o2.docs, []); assert.deepEqual(o2.purgeKeys, []);
  } finally { f.restore(); }
});

test("CP2-1: samma garanti för befintlig DELETE (policy och auktorisering oförändrade): fel ⇒ allt kvar, felet borta ⇒ allt fysiskt städat", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({}); const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
    assert.equal((await startCheckout(env, orderId, token)).status, 200);
    seedAux(env, orderId);
    const restore = failDelete(env, orderId, ["ext:1", "check"]);
    const bad = await api(env, "DELETE", `/compare/orders/${orderId}`, { token });
    assert.notEqual(bad.json.ok, true); restore();
    assert.equal(stored(env, orderId).get("order").status, "awaiting_payment"); assert.deepEqual(auxLeft(env, orderId), AUX); assert.equal(docKeys(env, orderId).length, 2);
    assert.equal((await api(env, "DELETE", `/compare/orders/${orderId}`, { token: "A".repeat(43) })).status, 404, "fel nyckel oförändrat");
    const ok = await api(env, "DELETE", `/compare/orders/${orderId}`, { token });
    assert.equal(ok.status, 200); assert.equal(ok.json.order.status, "deleted");
    assert.deepEqual(auxLeft(env, orderId), []); assert.equal(docKeys(env, orderId).length, 0);
  } finally { f.restore(); }
});

test("CP2-1: ext:* som inte står i work.steps (föräldralösa) städas också; KV-fel ger purgeKeys som den befintliga livscykeln försöker igen vid utgång", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({}); const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
    seedAux(env, orderId); stored(env, orderId).set("ext:99", { seed: "orphan" });
    const keys = docKeys(env, orderId); const realDel = env.REVIEWS_KV.delete.bind(env.REVIEWS_KV);
    let kvDown = true;
    env.REVIEWS_KV.delete = async (k) => { if (kvDown && k === keys[1]) throw new Error("kv nere"); return realDel(k); };
    const r = await closeDraft(env, orderId, token);
    assert.equal(r.status, 200);
    assert.deepEqual(auxLeft(env, orderId), []); assert.equal(stored(env, orderId).has("ext:99"), false, "även föräldralös ext:* är borta");
    assert.deepEqual(stored(env, orderId).get("order").purgeKeys, [keys[1]]);
    assert.equal(env.REVIEWS_KV.m.has(keys[1]), true, "den icke raderbara nyckeln ligger kvar tills nästa försök");
    // utgång: ordern passerar P1 (expiresAt + 65 min) – livscykelalarmet försöker radera purgeKeys igen
    kvDown = false;
    const peek = env.COMPARE_ORDERS.peek(orderId); const o = peek.store.get("order"); o.expiresAt = Date.now() - 70 * 60_000; peek.store.set("order", o);
    await peek.obj.alarm();
    assert.equal(env.REVIEWS_KV.m.has(keys[1]), false, "KV-dokumentet raderades vid omförsöket");
    assert.deepEqual(stored(env, orderId).get("order").purgeKeys, []);
    assert.equal(stored(env, orderId).get("order").status, "deleted");
  } finally { f.restore(); }
});
