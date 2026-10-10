import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeOffer, SCOPE_IDS, readOffer } from "../src/compare_extract.js";
import { compareOffers, offerLabels } from "../src/compare_engine.js";
import { assembleReport, readPriority, applyPriority } from "../src/compare_report.js";
import { verifyWebhook, signForTest, evaluatePaidSession, formEncode } from "../src/compare_stripe.js";
import { fixtureResponse, makeEnv, installFetch, readyOrder, startCheckout, paidSession, webhook } from "./helpers/compare_env.mjs";

const X = (o = {}) => ({ totalBeforeRotSek: 100000, totalVatBasis: "inkl", ...o });
const ALL = { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" };
const off = (extracted = {}, scope = ALL, extra = {}) => sanitizeOffer(fixtureResponse({ extracted: X(extracted), scope, ...extra }));
const L = (n) => offerLabels([], n);

test("2 offerter, samma omfattning, samma momsbas, fast pris → rangordning visas, med förbehåll", () => {
  const c = compareOffers([off({ totalBeforeRotSek: 100000 }), off({ totalBeforeRotSek: 120000 })], L(2));
  assert.equal(c.ranking.shown, true); assert.equal(c.ranking.lowest.index, 0); assert.equal(c.ranking.lowest.diffKr, 20000);
  assert.match(c.ranking.reasons[0], /kvalitet/);
});

test("exkl. moms omräknas bara när basen är uttryckligen angiven (80 000 exkl = 100 000 inkl)", () => {
  const c = compareOffers([off({ totalBeforeRotSek: 80000, totalVatBasis: "exkl" }), off({ totalBeforeRotSek: 100000 })], L(2));
  assert.equal(c.offers[0].price.normalized.incVat, 100000);
  assert.equal(c.ranking.shown, true); assert.equal(c.ranking.lowest, undefined); // lika → ingen vinnare
  const unk = compareOffers([off({ totalVatBasis: null }), off()], L(2));
  assert.equal(unk.ranking.shown, false); assert.ok(unk.differences.some((d) => d.id === "price:momsbas"));
  assert.equal(unk.offers[0].price.normalized, null);
});

test("3 offerter med olika omfattning: ingen 'billigast vinner'; skillnad och frågor pekar ut vem som ska svara", () => {
  const c = compareOffers([
    off({ totalBeforeRotSek: 90000 }, { ...ALL, bortforsling: "ingar_inte" }),
    off({ totalBeforeRotSek: 120000 }, ALL),
    off({ totalBeforeRotSek: 100000 }, { ...ALL, rivning: "framgar_inte", bortforsling: "framgar_inte" }),
  ], L(3));
  assert.equal(c.ranking.shown, false);
  const d = c.differences.find((x) => x.id === "scope:bortforsling");
  assert.ok(d); assert.equal(d.category, "omfattning");
  const q3 = c.questions[2].questions.map((q) => q.id);
  assert.ok(q3.includes("scope:rivning")); assert.ok(q3.includes("scope:bortforsling"));
  assert.ok(c.questions[0].questions.some((q) => q.id === "scope:bortforsling")); // dyrare men "ingår inte"
  const m = c.scopeMatrix.find((x) => x.id === "bortforsling"); assert.equal(m.kind, "skiljer");
});

test("4 offerter med ROT i några, okänd pristyp och löpande räkning → blockerare, inga påhittade belopp", () => {
  const c = compareOffers([
    off({ rotAmountSek: 15000 }), off({}), off({ priceType: "lopande", totalBeforeRotSek: null, totalSumSek: 95000, totalVatBasis: null }), off({ priceType: "ungefarligt" }),
  ], L(4));
  assert.equal(c.count, 4); assert.equal(c.ranking.shown, false);
  const ids = c.differences.map((d) => d.id);
  assert.ok(ids.includes("price:rot")); assert.ok(ids.includes("price:typ")); assert.ok(ids.includes("price:rotbas"));
  assert.equal(c.offers[2].price.totalBeforeRot, null); // omärkt total används inte som "före ROT"
  assert.ok(c.questions[2].questions.length >= 1);
});

test("okänt i alla offerter är 'framgår inte', aldrig 'ingår inte'; beslutsbladet säger det", () => {
  const c = compareOffers([off({}, {}), off({}, {})], L(2));
  assert.ok(c.scopeMatrix.every((m) => m.cells.every((x) => x.status === "framgar_inte")));
  assert.equal(c.ranking.shown, false);
  assert.ok(c.decisionSheet.mustClarify.some((m) => m.id === "scope:gemensamt_oklart"));
});

test("olika jobb → 'olika'-flagga och ingen rangordning", () => {
  const c = compareOffers([off({ jobType: "badrum" }), off({ jobType: "tak" })], L(2));
  assert.notEqual(c.comparability.sameProject, "ok"); assert.equal(c.ranking.shown, false);
});

test("sanitizeOffer: uttryckligt besked utan belägg nedgraderas, okända ID och markup rensas, saknat = framgår inte", () => {
  const raw = fixtureResponse({ scope: { rivning: "ingar", garanti: "ingar_inte" } });
  raw.scope[0].ref = null; // inget belägg
  raw.scope.push({ id: "påhittat", status: "ingar", page: 1, ref: "x" });
  raw.scope[1].ref = "<b>5 år</b> http://evil.example/x";
  const c = sanitizeOffer(raw);
  assert.equal(c.scope.rivning.status, "framgar_inte"); assert.deepEqual(c.downgraded, ["rivning"]);
  assert.equal(c.scope.garanti.status, "ingar_inte"); assert.ok(!/[<>]|evil/.test(c.scope.garanti.ref));
  assert.equal(c.scope.skydd.status, "framgar_inte");
  assert.equal(Object.keys(c.scope).length, SCOPE_IDS.length);
  assert.equal(sanitizeOffer(null).readability, "osaker");
  assert.throws(() => readOffer({ stop_reason: "max_tokens", content: [] }));
  assert.throws(() => readOffer({ stop_reason: "tool_use", content: [] }));
});

test("rapport: förbjudna ord i egen text spärras; prioritet från modellen kan bara ordna slutna ID", () => {
  const c = compareOffers([off({}, { ...ALL, bortforsling: "ingar_inte" }), off({}, ALL)], L(2));
  const ids = c.differences.map((d) => d.id);
  assert.throws(() => readPriority({ stop_reason: "tool_use", content: [{ type: "tool_use", name: "submit_priority", input: { priority_ids: ["hittepå"] } }] }, c.differences));
  assert.throws(() => readPriority({ stop_reason: "tool_use", content: [{ type: "tool_use", name: "submit_priority", input: { priority_ids: [], extra: 1 } }] }, c.differences));
  const order = { id: "o_" + "a".repeat(32), docCount: 2, paidAt: 1, stripe: { paymentIntentId: "pi_test_0000000001" } };
  const rep = assembleReport({ order, labels: c.labels, compared: c, priority: [ids[ids.length - 1]] });
  assert.equal(rep.differences[0].id, ids[ids.length - 1]); assert.equal(rep.prioritySource, "ai");
  assert.equal(rep.receipt.paymentRef, "00000001");
  assert.equal(applyPriority(c.differences, null).source, "fast");
});

test("Stripe: signatur kräver exakt råkropp, rätt hemlighet och färsk tid; flera v1 godtas", async () => {
  const raw = JSON.stringify({ id: "evt_1", type: "x", data: {} });
  const sec = "whsec_abcdefgh1234";
  const h = await signForTest(raw, sec);
  assert.equal((await verifyWebhook(raw, h, sec)).ok, true);
  assert.equal((await verifyWebhook(raw + " ", h, sec)).ok, false);
  assert.equal((await verifyWebhook(raw, h, "whsec_annan12345678")).reason, "signatur");
  assert.equal((await verifyWebhook(raw, await signForTest(raw, sec, 1_000_000_000), sec)).reason, "tid");
  assert.equal((await verifyWebhook(raw, "t=abc,v1=zz", sec)).ok, false);
  assert.equal((await verifyWebhook(raw, `${h},v1=${"0".repeat(64)}`, sec)).ok, true);
  assert.equal((await verifyWebhook(raw, "", sec)).ok, false);
  assert.equal(formEncode({ a: { b: [1].length, c: "å ö" }, d: undefined }), "a[b]=1&a[c]=%C3%A5%20%C3%B6".replace(/\[/g, "%5B").replace(/\]/g, "%5D"));
});

test("evaluatePaidSession: valuta, belopp, order, session-id, status, livemode", () => {
  const order = { id: "o_" + "b".repeat(32), stripe: { sessionId: "cs_test_0000000001" } };
  const good = { object: "checkout.session", mode: "payment", livemode: false, client_reference_id: order.id, id: "cs_test_0000000001", currency: "sek", amount_total: 4900, status: "complete", payment_status: "paid", payment_intent: "pi_test_0000000001", metadata: { order_id: order.id } };
  assert.equal(evaluatePaidSession(good, order, "test").ok, true);
  for (const [k, v, r] of [["currency", "eur", "valuta"], ["amount_total", 4899, "belopp"], ["client_reference_id", "o_x", "order"], ["id", "cs_test_9", "session"], ["payment_status", "unpaid", "ej_betald"], ["livemode", true, "livemode"], ["mode", "subscription", "mode"], ["payment_intent", null, "betalning"]]) {
    assert.equal(evaluatePaidSession({ ...good, [k]: v }, order, "test").reason, r, k);
  }
  assert.equal(evaluatePaidSession(good, order, "live").ok, false);
});

test("atomisk arbetsclaim: två samtidiga alarm ger bara en körning", async () => {
  const f = installFetch();
  try {
    const env = makeEnv();
    const { orderId, token } = await readyOrder(env, [{ extracted: X() , scope: ALL }, { extracted: X({ totalBeforeRotSek: 5 }), scope: ALL }]);
    await startCheckout(env, orderId, token);
    const sess = [...f.sessions.values()][0];
    await webhook(env, "checkout.session.completed", paidSession(sess));
    const o = env.COMPARE_ORDERS.peek(orderId);
    await Promise.all([o.obj.alarm(), o.obj.alarm(), o.obj.alarm()]);
    const rec = await o.store.get("order");
    assert.equal(rec.status, "delivered");
    assert.equal(f.log.anthropic.filter((r) => r.tools[0].name === "submit_offer").length, 2);
  } finally { f.restore(); }
});

// ---- Root-QA P1-punkt 8 (rootfacit): uttryckliga omfattningsskillnader stoppar rangordning ----
test("P1-8a: lika jobType=tak, alla core ingår, 100 000/120 000 men 100 m² mot 120 m² → ingen rangordning, belopp visas, olika omfattning klarläggs", () => {
  const c = compareOffers([
    off({ jobType: "tak", areaM2: 100, totalBeforeRotSek: 100000 }),
    off({ jobType: "tak", areaM2: 120, totalBeforeRotSek: 120000 }),
  ], L(2));
  assert.equal(c.ranking.shown, false);
  assert.equal(c.ranking.lowest, undefined);
  assert.notEqual(c.comparability.sameProject, "ok");
  assert.ok(c.differences.some((d) => d.id === "proj:yta"));
  assert.match(c.ranking.reasons.join(" "), /yta|omfattning/i);
  assert.equal(c.offers[0].price.normalized.incVat, 100000); // beloppen visas fortfarande
  assert.equal(c.offers[1].price.normalized.incVat, 120000);
  assert.ok(c.comparability.reasons.join(" ").includes("klarläggas"));
});

test("P1-8b: lika 100 m²/core men skydd=ingår inte i A och ingår i B → skillnaden identifieras OCH rangordning stoppas", () => {
  const c = compareOffers([
    off({ jobType: "tak", areaM2: 100, totalBeforeRotSek: 100000 }, { ...ALL, skydd: "ingar_inte" }),
    off({ jobType: "tak", areaM2: 100, totalBeforeRotSek: 110000 }, { ...ALL, skydd: "ingar" }),
  ], L(2));
  assert.ok(c.differences.some((d) => d.id === "scope:skydd" && d.category === "omfattning"));
  assert.equal(c.ranking.shown, false); assert.equal(c.ranking.lowest, undefined);
  assert.match(c.ranking.reasons.join(" "), /skydd/i);
  assert.match(c.ranking.reasons.join(" "), /billigast/);
});

test("P1-8c: villkorsskillnad (garanti) stoppar inte rangordningen men visas separat", () => {
  const c = compareOffers([
    off({ areaM2: 100, totalBeforeRotSek: 100000 }, { ...ALL, garanti: "ingar_inte" }),
    off({ areaM2: 100, totalBeforeRotSek: 110000 }, { ...ALL, garanti: "ingar" }),
  ], L(2));
  assert.equal(c.ranking.shown, true);
  assert.ok(c.differences.some((d) => d.id === "scope:garanti" && d.category === "villkor"));
});

test("P1-8d: likvärdig kontroll – samma yta (±2 % avrundning) och lika omfattning → rangordning visas", () => {
  const c = compareOffers([off({ areaM2: 100, totalBeforeRotSek: 100000 }), off({ areaM2: 101, totalBeforeRotSek: 108000 })], L(2));
  assert.equal(c.ranking.shown, true); assert.equal(c.ranking.lowest.index, 0);
});

test("P1-8e: okänd yta i en offert blockerar inte, men olika yta i andra par gör det", () => {
  const c = compareOffers([off({ areaM2: null }), off({ areaM2: 100, totalBeforeRotSek: 105000 }), off({ areaM2: 140, totalBeforeRotSek: 150000 })], L(3));
  assert.equal(c.ranking.shown, false);
});
