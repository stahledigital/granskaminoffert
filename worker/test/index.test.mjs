// Kör: node --test worker/test/  (Node 20+). Ingen nätverksåtkomst, ingen nyckel.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { sumBand, normalizePath } from "../src/index.js";
import { findForbidden } from "../src/rules.js";

// Minimal KV-attrapp med samma yta som Cloudflares (get/put).
function fakeKV() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
  };
}
const ORIGIN = "https://granskaminoffert.se";
function env(over = {}) {
  return { REVIEWS_KV: fakeKV(), ALLOWED_ORIGIN: ORIGIN, ANTHROPIC_API_KEY: "test", ...over };
}
function ctx() { const jobs = []; return { jobs, waitUntil: (p) => jobs.push(p) }; }
const fakeReview = {
  trade: "tak", contradictions: [], clarify: [{ key: "A", text: "b" }, { key: "C", text: "d" }],
  stated: [], calcCoverage: "checked", calcNote: "ok",
  price: { hourlyRateSek: 595, totalSumSek: 42820, rotDeducted: true, comment: "x" }, questions: ["q"],
};

test("summaband", () => {
  assert.equal(sumBand(null), "okand");
  assert.equal(sumBand(0), "okand");
  assert.equal(sumBand(24999), "<25k");
  assert.equal(sumBand(42820), "25-100k");
  assert.equal(sumBand(100000), "25-100k");
  assert.equal(sumBand(150000), "100-300k");
  assert.equal(sumBand(300001), ">300k");
});

test("väg normaliseras", () => {
  assert.equal(normalizePath("hantverkare"), "hantverkare");
  assert.equal(normalizePath("<script>"), "okand");
  assert.equal(normalizePath(undefined), "okand");
});

test("/health utan granskningar", async () => {
  const r = await worker.fetch(new Request("https://x/health"), env(), ctx());
  const j = await r.json();
  assert.equal(j.ok, true); assert.equal(j.hasApiKey, true);
  assert.equal(j.reviewsToday, 0); assert.equal(j.reviewsTotal, 0);
  assert.equal(j.version, "gmo-api-v5");
  assert.equal(j.dailyLimit, 300);
  assert.deepEqual(j.shares.email, { total: 0, today: 0 });
  assert.deepEqual(j.byPath.hantverkare, { total: 0, today: 0 });
  assert.equal(r.headers.get("Cache-Control"), "no-store");
  assert.equal(r.headers.get("X-Robots-Tag"), "noindex, nofollow, nosnippet");
});

test("CORS: främmande origin får bara den tillåtna", async () => {
  const r = await worker.fetch(new Request("https://x/review", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }), env(), ctx());
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), ORIGIN);
});

test("tom förfrågan ger 400", async () => {
  const r = await worker.fetch(new Request("https://x/review", { method: "POST", body: "{}", headers: { "Content-Type": "application/json", Origin: ORIGIN } }), env(), ctx());
  assert.equal(r.status, 400);
});

test("lyckad granskning: räknare och anonym statistikpost, inga personuppgifter", async () => {
  const e = env();
  const c = ctx();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    content: [{ type: "tool_use", name: "submit_review", input: fakeReview }],
    usage: { input_tokens: 1000, output_tokens: 500 },
  }), { status: 200 });
  try {
    const req = new Request("https://x/review", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.9" },
      body: JSON.stringify({ kind: "text", text: "Offert 42 820 kr, Anna Andersson, Storgatan 12", path: "hantverkare", filename: "hemlig.pdf" }),
    });
    const r = await worker.fetch(req, e, c);
    assert.equal(r.status, 200);
    await Promise.all(c.jobs);
  } finally { globalThis.fetch = realFetch; }

  const h = await (await worker.fetch(new Request("https://x/health"), e, ctx())).json();
  assert.equal(h.reviewsToday, 1);
  assert.equal(h.reviewsTotal, 1);

  const statKeys = [...e.REVIEWS_KV.m.keys()].filter((k) => k.startsWith("stat:"));
  assert.equal(statKeys.length, 1);
  const stat = JSON.parse(e.REVIEWS_KV.m.get(statKeys[0]));
  assert.deepEqual(Object.keys(stat).sort(), ["calcCoverage", "clarify", "contradictions", "path", "sumBand", "trade", "ts"]);
  assert.equal(stat.trade, "tak");
  assert.equal(stat.clarify, 2);
  assert.equal(stat.contradictions, 0);
  assert.equal(stat.sumBand, "25-100k");
  assert.equal(stat.path, "hantverkare");
  const raw = e.REVIEWS_KV.m.get(statKeys[0]);
  for (const forbidden of ["203.0.113.9", "hemlig.pdf", "Anna", "Storgatan", "42820", "42 820"]) {
    assert.ok(!raw.includes(forbidden), `statistikposten får inte innehålla ${forbidden}`);
  }
});

test("delningsklick räknas per kanal, bara från vår origin", async () => {
  const e = env(); const c = ctx();
  const mk = (origin, body) => new Request("https://x/event", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body });
  assert.equal((await worker.fetch(mk("https://evil.example", JSON.stringify({ type: "share", channel: "email" })), e, c)).status, 403);
  assert.equal((await worker.fetch(mk(ORIGIN, JSON.stringify({ type: "share", channel: "email" })), e, c)).status, 204);
  assert.equal((await worker.fetch(mk(ORIGIN, JSON.stringify({ type: "share", channel: "sms" })), e, c)).status, 204);
  assert.equal((await worker.fetch(mk(ORIGIN, JSON.stringify({ type: "share", channel: "<x>" })), e, c)).status, 204);
  assert.equal((await worker.fetch(mk(ORIGIN, "trasig"), e, c)).status, 204);
  await Promise.all(c.jobs);
  const j = await (await worker.fetch(new Request("https://x/health"), e, c)).json();
  assert.deepEqual(j.shares.email, { total: 1, today: 1 });
  assert.deepEqual(j.shares.sms, { total: 1, today: 1 });
  assert.deepEqual(j.shares.copy, { total: 0, today: 0 });
});

test("granskning räknas per väg", async () => {
  const e = env(); const c = ctx();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ content: [{ type: "tool_use", name: "submit_review", input: fakeReview }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 });
  try {
    const r = await worker.fetch(new Request("https://x/review", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.9" }, body: JSON.stringify({ kind: "text", text: "Offert 42 820 kr", path: "mottagare" }) }), e, c);
    assert.equal(r.status, 200);
  } finally { globalThis.fetch = realFetch; }
  await Promise.all(c.jobs);
  const j = await (await worker.fetch(new Request("https://x/health"), e, c)).json();
  assert.deepEqual(j.byPath.mottagare, { total: 1, today: 1 });
  assert.deepEqual(j.byPath.hantverkare, { total: 0, today: 0 });
});

test("prislager i svaret, förbjudna ord tvättas, prisstatistik bara vid opt-in", async () => {
  const extracted = { jobType: "tak", trades: ["snickare"], hourlyRateSek: 595, hours: 36, laborSumSek: 21420, materialSumSek: 18900,
    travelSumSek: null, otherSumSek: 2500, materialMarkupPct: null, rotAmountSek: 6426, rotRatePct: null, rotPersons: null, rotOnMaterialOrTravel: null,
    priceType: null, vatMode: "inkl", totalSumSek: 36394, totalIncludesVat: true, quoteDate: "2026-09-10", plannedPaymentDate: null,
    customerType: "privatperson", workDescription: "Byte av takpannor", county: "Kronoberg", areaM2: 32, unitCount: null };
  const dirty = { ...fakeReview, calcNote: "Detta verkar vara ett överpris, kanske svart.", extracted };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ content: [{ type: "tool_use", name: "submit_review", input: dirty }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 });
  const call = async (e, c, stats) => {
    const r = await worker.fetch(new Request("https://x/review", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.9" }, body: JSON.stringify({ kind: "text", text: "Offert", path: "mottagare", stats }) }), e, c);
    assert.equal(r.status, 200);
    return r.json();
  };
  try {
    const e1 = env(); const c1 = ctx();
    const j = await call(e1, c1, false);
    await Promise.all(c1.jobs);
    assert.equal(j.priceReport.referenceVersion, "2026-09");
    assert.ok(j.priceReport.checked.some((c) => c.id === "rot_belopp" && c.status === "ok"));
    assert.ok(j.priceReport.compared.some((c) => c.id === "tim_snickare" && c.mode === "inom"));
    assert.ok(j.priceReport.checked.some((c) => c.id === "summa" && c.status === "ok"));
    assert.equal(findForbidden(j).length, 0);
    assert.ok(!/överpris|svart/i.test(j.calcNote));
    assert.equal([...e1.REVIEWS_KV.m.keys()].filter((k) => k.startsWith("pstat:")).length, 0);

    const e2 = env(); const c2 = ctx();
    await call(e2, c2, true);
    await Promise.all(c2.jobs);
    const pk = [...e2.REVIEWS_KV.m.keys()].filter((k) => k.startsWith("pstat:"));
    assert.equal(pk.length, 1);
    const p = JSON.parse(e2.REVIEWS_KV.m.get(pk[0]));
    assert.deepEqual(Object.keys(p).sort(), ["county", "failedChecks", "jobType", "laborSharePct", "rateBand", "rot", "sumBand", "ts"]);
    assert.equal(p.rateBand, "400-599");
    assert.equal(p.sumBand, "25-100k");
    assert.ok(!JSON.stringify(p).includes("595") && !JSON.stringify(p).includes("36394") && !JSON.stringify(p).includes("takpannor"));
  } finally { globalThis.fetch = realFetch; }
});


// ---- Tillagt efter kodgranskningen 2026-09-18 ----

test("/review utan origin avvisas – CORS skyddar inte mot curl", async () => {
  const r = await worker.fetch(
    new Request("https://x/review", { method: "POST", body: JSON.stringify({ kind: "text", text: "x" }), headers: { "Content-Type": "application/json" } }),
    env(), ctx());
  assert.equal(r.status, 403);
});

test("/review från främmande origin avvisas", async () => {
  const r = await worker.fetch(
    new Request("https://x/review", { method: "POST", body: JSON.stringify({ kind: "text", text: "x" }), headers: { "Content-Type": "application/json", Origin: "https://evil.example" } }),
    env(), ctx());
  assert.equal(r.status, 403);
});

test("okänt bildformat avvisas innan modellen anropas", async () => {
  const realFetch = globalThis.fetch;
  let anropad = false;
  globalThis.fetch = async () => { anropad = true; return new Response("{}", { status: 200 }); };
  try {
    const r = await worker.fetch(
      new Request("https://x/review", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({ kind: "image", dataBase64: "AAAA", mediaType: "image/heic" }) }),
      env(), ctx());
    assert.equal(r.status, 400);
    assert.equal(anropad, false, "modellen anropades trots okänt format");
  } finally { globalThis.fetch = realFetch; }
});

test("län normaliseras till en fast lista", async () => {
  const { normalizeCounty } = await import("../src/index.js");
  assert.equal(normalizeCounty("Kronobergs län"), "kronoberg");
  assert.equal(normalizeCounty("VÄSTRA GÖTALAND"), "västra götaland");
  assert.equal(normalizeCounty("Storgatan 12, Växjö"), "okand");
  assert.equal(normalizeCounty(null), "okand");
});

test("KV som kastar släcker inte tjänsten", async () => {
  const trasigKV = { async get() { throw new Error("kv nere"); }, async put() { throw new Error("kv nere"); } };
  const r = await worker.fetch(new Request("https://x/health"), env({ REVIEWS_KV: trasigKV }), ctx());
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
});
