// D12: gratis-kostnadsskyddet – ändlig pilot, atomärt tak, fail closed. Offline: inga riktiga modellanrop, ingen nyckel, inga resurser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { pilotConfig, freeReserve, freeSettle, freeUnknown, freeRelease, freeGateStatus, worstMicroFor, usdToMicro } from "../src/free_budget.js";
import { fakeQuotaNamespace } from "./helpers/quota_do.mjs";
import { fakeFreeBudgetNamespace, gateVars } from "./helpers/free_gate.mjs";

const ORIGIN = "https://granskaminoffert.se";
const MODEL = "claude-sonnet-5-5";
function fakeKV() { const m = new Map(); return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); } }; }
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
const ctx = () => { const jobs = []; return { jobs, waitUntil: (p) => jobs.push(p) }; };
const GOODREVIEW = { trade: "annat", contradictions: [], clarify: [], stated: [], calcCoverage: "checked", calcNote: "", price: { comment: "x" }, questions: [], extracted: { trades: [] } };
function env(over = {}) { return { REVIEWS_KV: fakeKV(), QUOTA: fakeQuotaNamespace(), ALLOWED_ORIGIN: ORIGIN, ANTHROPIC_API_KEY: "test", ANTHROPIC_MODEL: MODEL, ...gateVars(), ...over }; }
function mock({ tokens = 1000, usage = { input_tokens: 1000, output_tokens: 500 }, status = 200, throwMsg = false, noUsage = false, delay = 0 } = {}) {
  const calls = { messages: 0, count: 0 }; const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/count_tokens")) { calls.count++; return Response.json({ input_tokens: tokens }); }
    calls.messages++;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    if (throwMsg) throw new Error("nät");
    if (status !== 200) return Response.json({ error: "x" }, { status });
    return Response.json({ stop_reason: "tool_use", ...(noUsage ? {} : { usage }), content: [{ type: "tool_use", name: "submit_review", input: GOODREVIEW }] });
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
let ipn = 0;
const rev = (e, text = "Offert: 3 timmar à 650 kr, material 1200 kr. Summa 3150 kr inkl moms.", kind = "text") => worker.fetch(new Request("https://x/review", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": `203.0.113.${(++ipn % 250) + 1}` }, body: JSON.stringify(kind === "text" ? { kind, text } : { kind, dataBase64: Buffer.from("%PDF-1.4\nabc").toString("base64") }) }), e, ctx());
const stateOf = (e) => [...e.FREE_BUDGET.objects.values()][0];
const WORST = worstMicroFor(MODEL, 1000); // värsta fall för en begäran med 1000 uppmätta tokens

test("konfiguration: allt måste vara satt av en människa; saknat/ogiltigt/för långt/utan mandat är stängt, inga standardvärden", () => {
  const g = gateVars(); assert.equal(pilotConfig(g).ok, true);
  const bad = [{ FREE_PILOT_ENABLED: undefined }, { FREE_PILOT_ENABLED: "0" }, { FREE_PILOT_ENABLED: "true" }, { FREE_PILOT_ID: undefined }, { FREE_PILOT_ID: "Ab" }, { FREE_PILOT_ID: "UPPER-case" },
    { FREE_PILOT_CAP_MICRO: undefined }, { FREE_PILOT_CAP_MICRO: "0" }, { FREE_PILOT_CAP_MICRO: "-5" }, { FREE_PILOT_CAP_MICRO: "20.5" }, { FREE_PILOT_CAP_MICRO: "20 USD" },
    { FREE_PILOT_FROM: undefined }, { FREE_PILOT_UNTIL: "2026-10-31" }, { FREE_PILOT_UNTIL: "2026-10-31T23:59:59" }, { FREE_PILOT_UNTIL: "inte-ett-datum" },
    { FREE_PILOT_UNTIL: g.FREE_PILOT_FROM }, { FREE_PILOT_UNTIL: iso(Date.parse(g.FREE_PILOT_FROM) + 93 * 86400000) },
    { FREE_PILOT_MANDATE: undefined }, { FREE_PILOT_MANDATE: "kort" }, { FREE_PILOT_MANDATE: "x".repeat(121) }];
  for (const o of bad) assert.equal(pilotConfig({ ...g, ...o }).ok, false, JSON.stringify(o));
  assert.equal(pilotConfig({}).reason, "ej_aktiverad");
  assert.equal(pilotConfig({ ...g, FREE_PILOT_UNTIL: "2026-10-31T23:59:59+01:00", FREE_PILOT_FROM: "2026-10-10T23:50:00+02:00" }).ok, true); // explicit tidszon
  assert.equal(pilotConfig({ ...g, FREE_PILOT_UNTIL: "2026-10-31T23:59:59+01:00", FREE_PILOT_FROM: "2026-10-10T23:50:00+02:00" }).cfg.untilMs, Date.UTC(2026, 9, 31, 22, 59, 59));
});

test("normal gratisbegäran: mäts (även text), reserveras före anropet, avräknas mot uppmätt kostnad; resultatet oförändrat", async () => {
  const m = mock(); const e = env();
  try {
    const r = await rev(e); assert.equal(r.status, 200); const j = await r.json(); assert.equal(j.meta.costStatus, "känd");
    assert.equal(m.calls.count, 1, "text mäts också"); assert.equal(m.calls.messages, 1);
    const spent = stateOf(e).store.get("m").spent; assert.equal(spent, usdToMicro(j.meta.costUsd)); assert.ok(spent < WORST);
    const keys = [...stateOf(e).store.keys()].filter((k) => k.startsWith("r:")); assert.equal(keys.length, 1); assert.equal(stateOf(e).store.get(keys[0]).state, "settled");
  } finally { m.restore(); }
});

test("standard stängt: utan pilotkonfiguration/bindning inget count_tokens-anrop, ingen kvot, inget generationsanrop (503)", async () => {
  for (const over of [{ FREE_PILOT_ENABLED: undefined }, { FREE_PILOT_ENABLED: "0" }, { FREE_BUDGET: undefined }, { FREE_PILOT_CAP_MICRO: "abc" }]) {
    const m = mock(); const e = env(over);
    try { const r = await rev(e); assert.equal(r.status, 503); assert.equal(m.calls.count, 0); assert.equal(m.calls.messages, 0); assert.equal(e.REVIEWS_KV.m.size, 0, "inga räknare rörda"); } finally { m.restore(); }
  }
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.match(toml, /FREE_PILOT_ENABLED = "0"/); assert.doesNotMatch(toml, /FREE_PILOT_(ID|CAP_MICRO|FROM|UNTIL|MANDATE)\s*=/);
  assert.match(toml, /name = "FREE_BUDGET"\nclass_name = "FreeBudget"/); assert.match(toml, /tag = "v3"\nnew_sqlite_classes = \["FreeBudget"\]/);
});

test("överstor text/PDF: över token-gränsen ⇒ 400 utan reservation eller generation; ogiltig mätning ⇒ 503; reservation över kvarvarande tak ⇒ 503 utan anrop", async () => {
  let m = mock({ tokens: 90000 }); let e = env();
  try { assert.equal((await rev(e)).status, 400); assert.equal((await rev(e, "", "pdf")).status, 400); assert.equal(m.calls.messages, 0); assert.equal(stateOf(e)?.store.has("m") || false, false); } finally { m.restore(); }
  // tak under värsta fallet för EN begäran
  m = mock(); e = env({ FREE_PILOT_CAP_MICRO: String(WORST - 1) });
  try { assert.equal((await rev(e)).status, 503); assert.equal(m.calls.messages, 0); } finally { m.restore(); }
});

test("två samtidiga över kvarvarande tak: exakt en får generera; samtidighet delar EN räknare", async () => {
  const m = mock({ delay: 30 }); const e = env({ FREE_PILOT_CAP_MICRO: String(WORST + Math.floor(WORST / 2)) });
  try {
    const rs = await Promise.all([rev(e), rev(e)]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 503]); assert.equal(m.calls.messages, 1);
    const many = env({ FREE_PILOT_CAP_MICRO: String(WORST * 3) }); m.calls.messages = 0;
    const rs2 = await Promise.all(Array.from({ length: 10 }, () => rev(many)));
    assert.equal(rs2.filter((r) => r.status === 200).length, 3, "exakt tre ryms i taket (värsta fall)"); assert.equal(m.calls.messages, 3);
    assert.ok(stateOf(many).store.get("m").spent <= WORST * 3);
  } finally { m.restore(); }
});

test("exakt slut på budget: spent+micro == tak tillåts, +1 nekas; settle med lägre verklig kostnad frigör utrymme; tak över/under nås aldrig tyst", async () => {
  const e = env({ FREE_PILOT_CAP_MICRO: "1000" }); const now = new Date();
  assert.equal((await freeReserve(e, { key: "a", micro: 1000, now })).ok, true);
  assert.equal((await freeReserve(e, { key: "b", micro: 1, now })).reason, "tak");
  assert.equal((await freeSettle(e, { key: "a", model: MODEL, usage: { input_tokens: 10, output_tokens: 10 }, worstMicro: 1000, now })), true);
  const left = 1000 - stateOf(e).store.get("m").spent; assert.ok(left > 0 && left < 1000);
  assert.equal((await freeReserve(e, { key: "b", micro: left + 1, now })).reason, "tak");
  assert.equal((await freeReserve(e, { key: "b", micro: left, now })).ok, true, "frigjort utrymme efter lägre verklig kostnad, exakt till taket");
  assert.equal((await freeReserve(e, { key: "b", micro: left, now })).ok, true, "samma nyckel är idempotent");
  assert.equal((await freeReserve(e, { key: "c", micro: 1, now })).reason, "tak");
  assert.equal(await freeRelease(e, { key: "b", now }), true); assert.equal((await freeReserve(e, { key: "c", micro: left, now })).ok, true);
  assert.equal((await freeReserve(e, { key: "bad key!", micro: 5, now })).ok, false); assert.equal((await freeReserve(e, { key: "z", micro: 0, now })).ok, false);
});

test("okänd användning (nätfel, saknat usage, ogiltigt svar) ⇒ värsta fallet ligger kvar och HALT: inga nya generationer; överskridning ⇒ halt; HTTP-fel frigör", async () => {
  for (const o of [{ throwMsg: true }, { noUsage: true }]) {
    const m = mock(o); const e = env();
    try {
      const r1 = await rev(e); assert.ok([200, 502].includes(r1.status));
      assert.equal(stateOf(e).store.get("m").spent, WORST, "värsta fallet kvar"); assert.ok(stateOf(e).store.get("halt"));
      m.calls.messages = 0; assert.equal((await rev(e)).status, 503); assert.equal(m.calls.messages, 0); assert.equal(m.calls.count, 1, "stängd före tokenmätning");
      assert.equal((await (await worker.fetch(new Request("https://x/health"), e, ctx())).json()).freeGate.state, "stopp");
    } finally { m.restore(); }
  }
  const m = mock({ status: 500 }); const e = env();
  try { assert.equal((await rev(e)).status, 502); assert.equal(stateOf(e).store.get("m").spent, 0, "HTTP-fel debiteras inte: frigjort"); assert.equal(stateOf(e).store.get("halt"), undefined); } finally { m.restore(); }
  const e2 = env(); const now = new Date();
  await freeReserve(e2, { key: "o", micro: 100, now }); await freeSettle(e2, { key: "o", model: MODEL, usage: { input_tokens: 1e7, output_tokens: 1e6 }, worstMicro: 100, now });
  assert.ok(stateOf(e2).store.get("halt")); assert.equal((await freeReserve(e2, { key: "p", micro: 1, now })).reason, "stopp");
});

test("lagringsfel/korrupt räknare/saknad bindning ⇒ nekat (503), aldrig 0 hittills", async () => {
  const m = mock();
  try {
    const broken = env({ FREE_BUDGET: { idFromName: (n) => n, get: () => ({ fetch: async () => { throw new Error("lagring nere"); } }) } });
    assert.equal((await rev(broken)).status, 503); assert.equal(m.calls.messages, 0);
    const bad500 = env({ FREE_BUDGET: { idFromName: (n) => n, get: () => ({ fetch: async () => new Response("x", { status: 500 }) }) } });
    assert.equal((await rev(bad500)).status, 503);
    const garbage = env({ FREE_BUDGET: { idFromName: (n) => n, get: () => ({ fetch: async () => Response.json({ ok: "ja" }) }) } });
    assert.equal((await rev(garbage)).status, 503);
    const corrupt = env(); const now = new Date(); await freeReserve(corrupt, { key: "k", micro: 5, now });
    stateOf(corrupt).store.set("m", { spent: -3 }); assert.equal((await rev(corrupt)).status, 503);
    stateOf(corrupt).store.set("m", "skräp"); assert.equal((await rev(corrupt)).status, 503); assert.equal(m.calls.messages, 0);
    assert.equal((await freeReserve({ ...env(), FREE_BUDGET: undefined }, { key: "q", micro: 5 })).reason, "ingen_budget");
  } finally { m.restore(); }
});

test("period: före FROM och från UNTIL nekas; exakt UNTIL-1 ms tillåts; månadsskifte ger INGEN ny pott; utgången pilot ⇒ inga generationer", async () => {
  const from = Date.parse("2026-10-10T21:50:00Z"), until = Date.parse("2026-10-31T22:59:59+00:00"); // 31 okt 23:59:59 CET (sommartiden slutade 25 okt)
  const e = env({ FREE_PILOT_FROM: iso(from), FREE_PILOT_UNTIL: iso(until), FREE_PILOT_CAP_MICRO: "5000" });
  const at = (t) => new Date(t);
  assert.equal((await freeReserve(e, { key: "pre", micro: 1, now: at(from - 1) })).reason, "inte_borjat");
  assert.equal((await freeReserve(e, { key: "a1", micro: 4000, now: at(from) })).ok, true);
  // månadsskifte okt→nov: samma pott, tak 5000 med 4000 redan förbrukat
  assert.equal((await freeReserve(e, { key: "a2", micro: 2000, now: at(Date.parse("2026-10-31T22:00:00Z")) })).reason, "tak");
  assert.equal((await freeReserve(e, { key: "a3", micro: 1000, now: at(Date.parse("2026-10-31T22:30:00Z")) })).ok, true);
  assert.equal((await freeReserve(e, { key: "a4", micro: 1, now: at(Date.parse("2026-10-31T22:59:58Z")) })).reason, "tak", "fortfarande inom perioden men potten är slut");
  const e2 = env({ FREE_PILOT_FROM: iso(from), FREE_PILOT_UNTIL: iso(until), FREE_PILOT_CAP_MICRO: "5000" });
  assert.equal((await freeReserve(e2, { key: "b1", micro: 10, now: at(until - 1000) })).ok, true);
  assert.equal((await freeReserve(e2, { key: "b2", micro: 10, now: at(until) })).reason, "utgangen");
  assert.equal((await freeReserve(e2, { key: "b3", micro: 10, now: at(Date.parse("2026-11-01T00:00:00Z")) })).reason, "utgangen", "kalenderomslag fyller inte på");
  assert.equal((await freeReserve(e2, { key: "b4", micro: 10, now: at(Date.parse("2026-12-01T00:00:00Z")) })).reason, "utgangen");
  assert.equal((await freeGateStatus(e2, at(until))).state, "utgangen");
  // utgången pilot via Workern
  const m = mock(); const ex = env({ FREE_PILOT_FROM: iso(Date.now() - 10 * 86400000), FREE_PILOT_UNTIL: iso(Date.now() - 1000) });
  try { assert.equal((await rev(ex)).status, 503); assert.equal(m.calls.count + m.calls.messages, 0); assert.equal((await (await worker.fetch(new Request("https://x/health"), ex, ctx())).json()).freeGate.state, "utgangen"); } finally { m.restore(); }
});

test("ingen tyst påfyllning: samma pilot-id kan inte få högre tak/senare slut/annat start; sänkning tillåts; ny pott kräver nytt id med mandat", async () => {
  const now = new Date(); const g = gateVars({ FREE_PILOT_CAP_MICRO: "10000" }); const e = { ...g };
  assert.equal((await freeReserve(e, { key: "a", micro: 9000, now })).ok, true);
  assert.equal((await freeReserve({ ...e, FREE_PILOT_CAP_MICRO: "1000000" }, { key: "b", micro: 100, now })).reason, "konfig_hojd");
  assert.equal((await freeReserve({ ...e, FREE_PILOT_UNTIL: iso(Date.parse(g.FREE_PILOT_UNTIL) + 86400000) }, { key: "b", micro: 100, now })).reason, "konfig_hojd");
  assert.equal((await freeGateStatus({ ...e, FREE_PILOT_CAP_MICRO: "1000000" }, now)).state, "konfig_hojd");
  assert.equal((await freeReserve({ ...e, FREE_PILOT_CAP_MICRO: "9500" }, { key: "b", micro: 600, now })).reason, "tak", "sänkt tak gäller");
  assert.equal((await freeReserve({ ...e, FREE_PILOT_CAP_MICRO: "10000" }, { key: "b", micro: 100, now })).reason, "konfig_hojd", "sänkningen är bestående (kan inte höjas tillbaka)");
  const obj = [...e.FREE_BUDGET.objects.values()][0]; assert.equal(obj.store.get("pilot").mandate, "TEST-MANDAT-ENDAST-OFFLINE", "mandatreferensen är spårbar i instansen");
  const fresh = { ...e, FREE_PILOT_ID: "test-pilot-ny", FREE_PILOT_MANDATE: "NYTT-MANDAT-REF-1234" };
  assert.equal((await freeReserve(fresh, { key: "c", micro: 9000, now })).ok, true, "nytt pilot-id + mandat = ny, spårbar pott");
  assert.equal(e.FREE_BUDGET.objects.size, 2);
  assert.equal((await freeReserve({ ...fresh, FREE_PILOT_MANDATE: undefined }, { key: "d", micro: 1, now })).reason, "konfig");
  // ingen admin-/nollställningsrutt: DO:n svarar 404 på allt utom status/reserve/settle/release
  for (const p of ["/reset", "/refill", "/halt-clear", "/admin"]) { const r = await e.FREE_BUDGET.get("pilot:" + g.FREE_PILOT_ID).fetch("https://x" + p, { method: "POST", body: JSON.stringify({ cfg: pilotConfig(e).cfg, nowMs: Date.now() }) }); assert.equal(r.status, 404); }
});

test("dagsräknaren nekar ⇒ pilotreservationen frigörs; /health visar bara läge, aldrig belopp/mandat; 300/dag + IP-spärr består", async () => {
  const m = mock(); const e = env({ GLOBAL_DAILY_LIMIT: "1" });
  try {
    assert.equal((await rev(e)).status, 200); const spent1 = stateOf(e).store.get("m").spent;
    assert.equal((await rev(e)).status, 429); assert.equal(stateOf(e).store.get("m").spent, spent1, "andra begäran lämnade ingen kvarvarande reservation");
    const h = await (await worker.fetch(new Request("https://x/health"), e, ctx())).json(); assert.deepEqual(Object.keys(h.freeGate).sort(), ["open", "state"]);
    assert.doesNotMatch(JSON.stringify(h), /TEST-MANDAT|20000000|test-pilot/);
    const rl = env({ REVIEW_RL: { limit: async () => ({ success: false }) } }); assert.equal((await rev(rl)).status, 429); assert.equal(stateOf(rl)?.store.has("m") || false, false);
  } finally { m.restore(); }
  assert.match(readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8"), /GLOBAL_DAILY_LIMIT = "300"/);
});

test("importer: free_budget.js beror bara på models.js; ingen jämförelse-/betal-/Google-/Stripe-/mejlkod i grenen", () => {
  const src = readFileSync(new URL("../src/free_budget.js", import.meta.url), "utf8");
  assert.deepEqual([...src.matchAll(/^import .* from "(.+)";/gm)].map((x) => x[1]), ["./models.js"]);
  const all = ["index.js", "explain.js", "free_budget.js"].map((f) => readFileSync(new URL("../src/" + f, import.meta.url), "utf8")).join("\n");
  assert.doesNotMatch(all, /compare_|stripe|CompareOrders|CompareBudget|places\.googleapis|trustpilot|mailer/i);
});

test("godkänd pilot (Anders 2026-10-10 23:36): 20 000 000 µUSD TOTALT, slut exklusivt 2026-11-01T00:00:00+01:00; tak/utgång vid exakta gränser", async () => {
  const until = "2026-11-01T00:00:00+01:00";
  const g = gateVars({ FREE_PILOT_CAP_MICRO: "20000000", FREE_PILOT_FROM: "2026-10-11T00:00:00+02:00", FREE_PILOT_UNTIL: until });
  const c = pilotConfig(g); assert.equal(c.ok, true); assert.equal(c.cfg.capMicro, 20_000_000); assert.equal(c.cfg.untilMs, Date.UTC(2026, 9, 31, 23, 0, 0));
  assert.equal((await freeReserve(g, { key: "x1", micro: 20_000_000, now: new Date("2026-10-31T22:59:59.999Z") })).ok, true, "sista millisekunden före 1 nov 00:00 CET");
  assert.equal((await freeReserve(g, { key: "x2", micro: 1, now: new Date("2026-10-31T22:59:59.999Z") })).reason, "tak", "20 USD är totalt, inte per dygn/månad");
  const g2 = gateVars({ FREE_PILOT_CAP_MICRO: "20000000", FREE_PILOT_FROM: "2026-10-11T00:00:00+02:00", FREE_PILOT_UNTIL: until });
  assert.equal((await freeReserve(g2, { key: "y1", micro: 1, now: new Date("2026-10-31T23:00:00.000Z") })).reason, "utgangen", "exakt 00:00 CET är utanför (exklusivt)");
  assert.equal((await freeReserve(g2, { key: "y2", micro: 1, now: new Date("2026-11-01T00:00:00Z") })).reason, "utgangen");
});
