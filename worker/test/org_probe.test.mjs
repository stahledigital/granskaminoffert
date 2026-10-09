// S4: org-kontroll + kreditstopp. Inga riktiga anrop: Anthropic/Turnstile är attrapper.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { ExplainBudget } from "../src/explain_budget.js";
import { probeCreditOrg, aiGate, creditExpired, _resetProbeCacheForTests, CREDIT_ORG_ID, PROBE_URL } from "../src/org_probe.js";
import { fakeQuotaNamespace } from "./helpers/quota_do.mjs";

const ORIGIN = "https://stahledigital.se";
function fakeKV() { const m = new Map(); return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); } }; }
function budgetNs() {
  const store = new Map();
  const state = { storage: { async get(k) { return store.get(k); }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); }, async list({ prefix }) { return new Map([...store].filter(([k]) => k.startsWith(prefix))); } }, async blockConcurrencyWhile(f) { return f(); } };
  const obj = new ExplainBudget(state);
  let tail = Promise.resolve();
  return { idFromName: (n) => n, get: () => ({ fetch: (url, init) => { const run = tail.then(() => obj.fetch(new Request(url, init))); tail = run.catch(() => {}); return run; } }) };
}
const CHECKS = [{ id: "spf", status: "titta" }, { id: "dmarc", status: "titta" }];
const GOOD = { priority_ids: ["agarkollen/spf/atgarda", "agarkollen/dmarc/atgarda"] };
function env(over = {}) {
  return { REVIEWS_KV: fakeKV(), QUOTA: fakeQuotaNamespace(), EXPLAIN_BUDGET: budgetNs(), ALLOWED_ORIGIN: "https://granskaminoffert.se", ANTHROPIC_API_KEY: "sk-test-A", TURNSTILE_SECRET_KOLLAR: "ts", EXPLAIN_ENABLED: "1", EXPLAIN_CREDIT_UNTIL: "2099-01-01", GRANSKA_H: { writeDataPoint() {} }, ...over };
}
let calls, org, modelsStatus, modelsThrow, seenKeys;
const realFetch = globalThis.fetch;
function mock() {
  calls = { models: 0, anthropic: 0, turnstile: 0 }; seenKeys = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u === PROBE_URL) {
      calls.models++; seenKeys.push(init.headers["x-api-key"]);
      assert.equal(init.method, "GET");
      if (modelsThrow) throw new Error("nät");
      return new Response("{\"data\":[]}", { status: modelsStatus, headers: org ? { "anthropic-organization-id": org } : {} });
    }
    if (u.includes("turnstile")) { calls.turnstile++; return new Response(JSON.stringify({ success: true, hostname: "stahledigital.se", action: "forklaring" }), { status: 200 }); }
    if (u.includes("/v1/messages")) { calls.anthropic++; return new Response(JSON.stringify({ stop_reason: "tool_use", usage: { input_tokens: 800, output_tokens: 200 }, content: [{ type: "tool_use", name: "submit_explanation", input: GOOD }] }), { status: 200 }); }
    throw new Error("oväntat anrop " + u);
  };
}
test.beforeEach(() => { org = CREDIT_ORG_ID; modelsStatus = 200; modelsThrow = false; _resetProbeCacheForTests(); mock(); });
test.afterEach(() => { globalThis.fetch = realFetch; });

const explain = (e, body = { app: "agarkollen", checks: CHECKS, turnstileToken: "t" }) => worker.fetch(new Request("https://api/explain", { method: "POST", headers: { Origin: ORIGIN, "content-type": "application/json", "CF-Connecting-IP": "9.9.9.9" }, body: JSON.stringify(body) }), e, { waitUntil() {} });
const orgRoute = (e) => worker.fetch(new Request("https://api/explain/org"), e, { waitUntil() {} });

test("org stämmer: probe går mot fast URL med nyckeln, ett AI-anrop görs", async () => {
  const e = env();
  const r = await (await explain(e)).json();
  assert.equal(r.mode, "ai"); assert.equal(calls.models, 1); assert.equal(calls.anthropic, 1);
  assert.deepEqual(seenKeys, ["sk-test-A"]);
});

for (const [namn, setup, status] of [
  ["annan organisation", () => { org = "11111111-2222-3333-4444-555555555555"; }, "annan_org"],
  ["huvudet saknas", () => { org = ""; }, "huvud_saknas"],
  ["providern svarar 401", () => { modelsStatus = 401; }, "fel"],
  ["nätfel/timeout", () => { modelsThrow = true; }, "fel"],
]) {
  test(`${namn}: inget AI-anrop, ingen Turnstile, ingen budget – fast reservväg`, async () => {
    setup();
    const e = env();
    const res = await explain(e);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.mode, "fallback"); assert.equal(j.ai, false);
    assert.equal(calls.anthropic, 0); assert.equal(calls.turnstile, 0);
    const p = await (await orgRoute(e)).json();
    assert.equal(p.creditOrgMatches, false); assert.equal(p.status, status);
  });
}

test("/explain/org returnerar bara bool + status + tid + creditExpired; aldrig org-ID, nyckel eller råsvar", async () => {
  const e = env();
  const res = await orgRoute(e);
  const txt = await res.text();
  assert.deepEqual(Object.keys(JSON.parse(txt)).sort(), ["creditExpired", "creditOrgMatches", "ms", "status"]);
  assert.ok(!txt.includes(CREDIT_ORG_ID)); assert.ok(!txt.includes("sk-test")); assert.ok(!txt.includes("data"));
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("cache: upprepade anrop ger en verklig kontroll; även misslyckanden cachas (ratebegränsning)", async () => {
  const e = env();
  for (let i = 0; i < 5; i++) await probeCreditOrg(e);
  assert.equal(calls.models, 1);
  _resetProbeCacheForTests(); org = ""; calls.models = 0;
  const e2 = env({ ANTHROPIC_API_KEY: "sk-test-B" });
  for (let i = 0; i < 5; i++) await probeCreditOrg(e2);
  assert.equal(calls.models, 1);
});

test("cache överlever inte byte av hemlighet (varken minne eller delad KV)", async () => {
  const kv = fakeKV();
  const a = env({ REVIEWS_KV: kv });
  assert.equal((await probeCreditOrg(a)).creditOrgMatches, true);
  assert.equal(calls.models, 1);
  // ny hemlighet, ny isolat-cache, samma KV: gammalt "ok" får inte återanvändas
  _resetProbeCacheForTests(); org = "11111111-2222-3333-4444-555555555555";
  const b = env({ REVIEWS_KV: kv, ANTHROPIC_API_KEY: "sk-test-NY" });
  const r = await probeCreditOrg(b);
  assert.equal(calls.models, 2); assert.equal(r.creditOrgMatches, false); assert.equal(r.status, "annan_org");
  // samma isolat utan reset: också ny nyckel → ny kontroll
  const c = env({ REVIEWS_KV: kv, ANTHROPIC_API_KEY: "sk-test-NY2" });
  await probeCreditOrg(c);
  assert.equal(calls.models, 3);
  // ingen råhemlighet i KV-nycklar eller värden
  for (const [k, v] of kv.m) { assert.ok(!k.includes("sk-test") && !v.includes("sk-test")); }
});

test("cache går ut: ok efter 10 min, fel efter 2 min", async () => {
  const e = env({ REVIEWS_KV: undefined });
  const t = Date.now();
  await probeCreditOrg(e, { now: t });
  await probeCreditOrg(e, { now: t + 9 * 60_000 });
  assert.equal(calls.models, 1);
  await probeCreditOrg(e, { now: t + 10 * 60_000 + 1 });
  assert.equal(calls.models, 2);
  _resetProbeCacheForTests(); org = ""; calls.models = 0;
  await probeCreditOrg(e, { now: t });
  await probeCreditOrg(e, { now: t + 119_000 });
  assert.equal(calls.models, 1);
  await probeCreditOrg(e, { now: t + 121_000 });
  assert.equal(calls.models, 2);
});

test("kreditutgång: standard stoppar från 2026-10-14 00:00 UTC, före inte; inget nätanrop vid stopp", async () => {
  const e = env({ EXPLAIN_CREDIT_UNTIL: undefined });
  assert.equal(creditExpired(e, new Date("2026-10-13T23:59:59Z")), false);
  assert.equal(creditExpired(e, new Date("2026-10-14T00:00:00Z")), true);
  const g = await aiGate(e, { now: new Date("2026-10-14T08:00:00Z") });
  assert.deepEqual(g, { ok: false, reason: "kredit_utgangen" });
  assert.equal(calls.models, 0);
  const g2 = await aiGate(e, { now: new Date("2026-10-13T12:00:00Z") });
  assert.equal(g2.ok, true);
});

test("efter utgång: /explain ger fast reservväg utan AI, Turnstile eller org-anrop; nytt beslut (EXPLAIN_CREDIT_UNTIL) öppnar igen", async () => {
  const e = env({ EXPLAIN_CREDIT_UNTIL: "2000-01-01" });
  const j = await (await explain(e)).json();
  assert.equal(j.mode, "fallback");
  assert.equal(calls.anthropic + calls.turnstile + calls.models, 0);
  const e2 = env({ EXPLAIN_CREDIT_UNTIL: "2099-01-01" });
  assert.equal((await (await explain(e2)).json()).mode, "ai");
});

test("ogiltigt EXPLAIN_CREDIT_UNTIL eller org-konfig stänger (fail-closed)", async () => {
  for (const v of ["", "imorgon", "2026-13-45", "2026-10-14T00:00:00Z"]) assert.equal(creditExpired(env({ EXPLAIN_CREDIT_UNTIL: v })), true, v);
  const r = await probeCreditOrg(env({ EXPLAIN_CREDIT_ORG_ID: "inte-ett-id" }));
  assert.equal(r.creditOrgMatches, false); assert.equal(r.status, "konfig");
  assert.equal(calls.models, 0);
});

test("ingen nyckel: ingen probe", async () => {
  const r = await probeCreditOrg(env({ ANTHROPIC_API_KEY: undefined }));
  assert.equal(r.status, "nyckel_saknas"); assert.equal(calls.models, 0);
});

test("flagga AV: ingen probe heller (inget nätanrop alls)", async () => {
  const e = env({ EXPLAIN_ENABLED: "0" });
  await explain(e);
  assert.equal(calls.models + calls.anthropic + calls.turnstile, 0);
});
