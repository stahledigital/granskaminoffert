// D03 (GMO-REVISION-20261009-01): paket B (validering), E (kvot/indatagräns), F1 (modell/hälsa),
// mätning. Allt mot mock: INGET anrop till Anthropic, ingen nyckel, inget nätverk.
// Mock-körningar bevisar kodvägarna, aldrig AI:ns träffsäkerhet (EJ TESTAT).
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { buildPriceReport, degradedPriceReport, normalizeClientEvent, tratt } from "../src/index.js";
import { sanitizeExtracted, sanitizeReview } from "../src/sanitize.js";
import { buildAnthropicRequest, computeCost, modelInfo, DEFAULT_MODEL } from "../src/models.js";
import { reserve, quotaMode, QuotaCounter } from "../src/quota.js";
import { sniffFile } from "../src/limits.js";
import { fakeQuotaNamespace } from "./helpers/quota_do.mjs";

const ORIGIN = "https://granskaminoffert.se";
function fakeKV({ delay = 0, failGet = false, failPut = false } = {}) {
  const m = new Map();
  const wait = () => (delay ? new Promise((r) => setTimeout(r, delay)) : Promise.resolve());
  return {
    m,
    async get(k) { await wait(); if (failGet) throw new Error("kv get nere"); return m.has(k) ? m.get(k) : null; },
    async put(k, v) { await wait(); if (failPut) throw new Error("kv put nere"); m.set(k, v); },
  };
}
const env = (over = {}) => ({ REVIEWS_KV: fakeKV(), QUOTA: fakeQuotaNamespace(), ALLOWED_ORIGIN: ORIGIN, ANTHROPIC_API_KEY: "test", ...over });
const ctx = () => { const jobs = []; return { jobs, waitUntil: (p) => jobs.push(p) }; };
const fakeAE = () => { const p = []; return { p, writeDataPoint: (x) => p.push(x) }; };
const req = (body, extra = {}) => new Request("https://api.test/review", {
  method: "POST",
  headers: { "content-type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.7", ...extra },
  body: JSON.stringify(body),
});
const GOOD = {
  trade: "tak", contradictions: [], clarify: [], stated: [], calcCoverage: "checked", calcNote: "ok",
  price: { hourlyRateSek: 595, totalSumSek: 42820, rotDeducted: true, comment: "x" }, questions: ["q"],
  extracted: { jobType: "tak", trades: ["snickare"], hourlyRateSek: 595, vatMode: "inkl", totalBeforeRotSek: 42820, totalVatBasis: "inkl", rotAmountSek: 6426, laborSumSek: 21420, materialSumSek: 18900, otherSumSek: 2500, areaM2: 32, quoteDate: "2026-09-10" },
};
// Mock av Anthropic: räknar anrop per endpoint och sparar sista förfrågan.
function mockAnthropic({ output = GOOD, usage = { input_tokens: 1000, output_tokens: 500 }, countTokens = 5000, countFails = false, messagesStatus = 200 } = {}) {
  const calls = { messages: 0, count: 0, lastBody: null, lastCountBody: null };
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    if (String(url).endsWith("/count_tokens")) {
      calls.count++; calls.lastCountBody = body;
      if (countFails) return new Response("{}", { status: 500 });
      return new Response(JSON.stringify({ input_tokens: countTokens }), { status: 200 });
    }
    calls.messages++; calls.lastBody = body;
    if (messagesStatus !== 200) return new Response(JSON.stringify({ error: "x" }), { status: messagesStatus });
    return new Response(JSON.stringify({ stop_reason: "tool_use", usage, content: [{ type: "tool_use", name: "submit_review", input: output }] }), { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
const PDF_B64 = Buffer.from("%PDF-1.4\n1 0 obj\n").toString("base64");
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");

// ---------------- B: validering ----------------
test("B: prototypnycklar och ogiltiga enum/typer kraschar inte och ger markerade luckor", () => {
  const raw = JSON.parse('{"__proto__":{"vatMode":"inkl"},"constructor":"x","toString":"y","jobType":"constructor","trades":["constructor","__proto__","snickare","snickare"],"vatMode":"constructor","hourlyRateSek":"500","hours":-3,"laborSumSek":1e999,"rotPersons":2.5,"quoteDate":"2026-02-31","priceType":"hasOwnProperty","rotOnMaterialOrTravel":"ja"}');
  const { x, issues } = sanitizeExtracted(raw);
  assert.equal(x.jobType, null);
  assert.deepEqual(x.trades, ["snickare"]);
  assert.equal(x.vatMode, "okant_moms");
  for (const k of ["hourlyRateSek", "hours", "laborSumSek", "rotPersons", "quoteDate", "priceType", "rotOnMaterialOrTravel", "jobType", "trades", "vatMode"]) {
    assert.ok(issues.includes(k), `saknar issue för ${k}`);
  }
  assert.equal(x.hourlyRateSek, null);
  // issues innehåller bara fältnamn, aldrig värden
  assert.equal(JSON.stringify(issues).includes("500"), false);
  assert.equal(Object.getPrototypeOf(x), Object.prototype);
});

test("B: hela prisrapporten överlever skräp och markerar vad som inte kunnat läsas", () => {
  for (const raw of [null, undefined, "text", 42, [], [1, 2], { constructor: { prototype: 1 } }, JSON.parse('{"vatMode":{"a":1},"trades":"snickare","jobType":["tak"]}')]) {
    const rep = buildPriceReport(raw);
    assert.ok(Array.isArray(rep.checked) && Array.isArray(rep.cannotAssess));
    assert.equal(rep.partial, false);
    const moms = rep.checked.find((c) => c.id === "moms");
    assert.ok(moms && moms.status === "fraga", "ogiltig/saknad moms ger fråga, aldrig ok");
    assert.ok(!rep.checked.some((c) => c.status === "ok"), "inget grönt när avläsningen är ogiltig");
  }
  const rep = buildPriceReport({ vatMode: "brutto", hourlyRateSek: "abc" });
  assert.match(rep.cannotAssess.map((c) => c.text).join(" "), /moms/);
  assert.match(rep.cannotAssess.map((c) => c.text).join(" "), /timpris/);
});

test("B: ogiltigt vatMode ger osäkerhet även för privatkund (aldrig 'exklusive, konsekvent')", () => {
  const rep = buildPriceReport({ vatMode: "brutto", customerType: "privatperson", laborSumSek: 10000, materialSumSek: 5000, totalSumSek: 15000, hourlyRateSek: 500, trades: ["snickare"], jobType: "tak" });
  assert.equal(rep.checked.find((c) => c.id === "moms").status, "fraga");
  // 500 kr/h är "inom" om priset är exklusive moms (440–640) men "under" om det är inklusive (550–800):
  // utan känd momsbas avstår jämförelsen i stället för att välja.
  assert.ok(!rep.compared.some((c) => c.id === "tim_snickare"));
  assert.ok(rep.cannotAssess.some((c) => /inklusive eller exklusive moms/.test(c.text)));
});

test("B: ett fel i ett prissteg ger delgranskning med markerad lucka, inte undantag", () => {
  const boom = () => { throw new Error("regelbugg"); };
  const rep = buildPriceReport(GOOD.extracted, [], { runRules: boom, checkNormalAddons: () => [], compareToBands: () => [] });
  assert.equal(rep.partial, true);
  assert.ok(rep.cannotAssess.some((c) => /prisreglerna/.test(c.text) && /ofullständig/.test(c.text)));
  const rep2 = buildPriceReport(GOOD.extracted, [], { runRules: () => [], checkNormalAddons: () => [], compareToBands: boom });
  assert.equal(rep2.partial, true);
  assert.equal(degradedPriceReport().partial, true);
});

test("B: hela Worker-flödet med fientligt modellsvar ger 200 med läsbar delgranskning", async () => {
  const hostile = { trade: "constructor", contradictions: "ett räknefel", clarify: [null, 5, { key: 1, text: { a: 1 } }, { key: "A", text: "b" }], stated: {}, calcCoverage: "skip", calcNote: 7,
    price: [], questions: [1, "fråga?"], extracted: JSON.parse('{"__proto__":{"x":1},"jobType":"constructor","vatMode":"constructor","trades":"snickare","hourlyRateSek":"9999999"}') };
  const m = mockAnthropic({ output: hostile });
  try {
    const e = env(); const c = ctx();
    const r = await worker.fetch(req({ kind: "text", text: "Offert" }), e, c);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.trade, "okand");
    assert.deepEqual(j.contradictions, []);
    assert.deepEqual(j.clarify, [{ key: "A", text: "b" }]);
    assert.equal(j.calcCoverage, "insufficient_data");
    assert.deepEqual(j.questions, ["fråga?"]);
    assert.ok(j.priceReport.readIssues.length > 0);
    assert.ok(j.priceReport.cannotAssess.some((x) => x.title === "Avläsningen"));
    assert.ok(!j.priceReport.checked.some((x) => x.status === "ok"));
    await Promise.all(c.jobs);
  } finally { m.restore(); }
  // extracted helt av fel typ
  for (const bad of ["text", 5, [1], null]) {
    const m2 = mockAnthropic({ output: { ...GOOD, extracted: bad } });
    try {
      const r = await worker.fetch(req({ kind: "text", text: "Offert" }, { "CF-Connecting-IP": "203.0.113." + (bad === null ? 80 : 81 + String(bad).length) }), env(), ctx());
      assert.equal(r.status, 200, "extracted=" + JSON.stringify(bad));
      const j = await r.json();
      assert.ok(j.priceReport.cannotAssess.length > 0);
    } finally { m2.restore(); }
  }
});

// ---------------- F1: modell ----------------
test("F1: anropsform per modell (4.5 forcerat verktyg + temperature 0; 5.5 auto + thinking, ingen temperature)", () => {
  const tool = { name: "submit_review" };
  const old = buildAnthropicRequest({ model: "claude-sonnet-4-5-20250929", system: "S", userContent: [], tool });
  assert.deepEqual(old.tool_choice, { type: "tool", name: "submit_review" });
  assert.equal(old.temperature, 0);
  assert.equal(old.thinking, undefined);
  assert.equal(old.max_tokens, 4000);
  const nw = buildAnthropicRequest({ model: "claude-sonnet-5-5", system: "S", userContent: [], tool });
  assert.deepEqual(nw.tool_choice, { type: "auto" });
  assert.equal("temperature" in nw, false);
  assert.deepEqual(nw.thinking, { type: "between_tools" });
  assert.match(nw.system, /Anropa verktyget submit_review/);
  assert.equal(nw.tools[0].strict, undefined, "strict:true används inte (union-typer > 16)");
  const unk = buildAnthropicRequest({ model: "claude-framtid-9", system: "S", userContent: [], tool });
  assert.deepEqual(unk.tool_choice, { type: "auto" });
  assert.equal("temperature" in unk, false);
  assert.equal(unk.thinking, undefined);
  assert.equal(DEFAULT_MODEL, "claude-sonnet-5-5");
  assert.equal(modelInfo("constructor"), null);
});

test("F1: kostnad ur faktisk användning, okänd modell = okänd kostnad (inte noll)", () => {
  assert.deepEqual(computeCost("claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 1_000_000 }), { status: "känd", inputTokens: 1e6, outputTokens: 1e6, usd: 12 });
  assert.equal(computeCost("claude-sonnet-4-5-20250929", { input_tokens: 1_000_000, output_tokens: 1_000_000 }).usd, 18);
  assert.equal(computeCost("okänd-modell", { input_tokens: 5, output_tokens: 5 }).status, "okand");
  assert.equal(computeCost("okänd-modell", { input_tokens: 5, output_tokens: 5 }).usd, null);
  assert.equal(computeCost("claude-sonnet-5-5", undefined).usd, null);
});

test("F1: Worker använder rätt anropsform och loggar modell + kostnadsstatus; okänd modell loggas som okänd", async () => {
  for (const [model, tc, temp, status] of [["claude-sonnet-4-5-20250929", "tool", 0, "känd"], ["claude-sonnet-5-5", "auto", undefined, "känd"], ["claude-framtid-9", "auto", undefined, "okand"]]) {
    const m = mockAnthropic();
    const ae = fakeAE();
    try {
      const r = await worker.fetch(req({ kind: "text", text: "Offert" }, { "CF-Connecting-IP": "198.51.100." + model.length }), env({ ANTHROPIC_MODEL: model, GRANSKA_H: ae }), ctx());
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.equal(m.calls.lastBody.tool_choice.type, tc);
      assert.equal(m.calls.lastBody.temperature, temp);
      assert.equal(j.meta.costStatus, status);
      assert.equal(j.meta.costUsd === null, status === "okand");
      const u = ae.p.find((x) => x.blobs[0] === "anrop_kostnad");
      assert.deepEqual(u.blobs, ["anrop_kostnad", model, status, "text"]);
      assert.equal(u.doubles[2] === 0, status === "okand");
    } finally { m.restore(); }
  }
});

test("F1: /health visar modell, referensversion, bygge och kvotläge", async () => {
  const r = await worker.fetch(new Request("https://x/health"), env({ BUILD_ID: "abc1234", ANTHROPIC_MODEL: "claude-sonnet-5-5", QUOTA: undefined }), ctx());
  const j = await r.json();
  assert.equal(j.build, "abc1234");
  assert.equal(j.model, "claude-sonnet-5-5");
  assert.equal(j.modelInTable, true);
  assert.equal(j.referenceVersion, "2026-10-09");
  assert.equal(j.quotaMode, "kv_best_effort");
  assert.equal(j.quotaHardCap, false);
  assert.equal(j.paidTrafficAllowed, false); // utan atomär bindning: inget betalt anrop
  const j2 = await (await worker.fetch(new Request("https://x/health"), env({ QUOTA: { idFromName: () => 1, get: () => ({}) } }), ctx())).json();
  assert.equal(j2.quotaMode, "durable_object");
  assert.equal(j2.paidTrafficAllowed, true);
  assert.equal((await (await worker.fetch(new Request("https://x/health"), env(), ctx())).json()).build, "okand");
});

// ---------------- E: kvot och indatagräns ----------------
test("E: KV-fel nekar anropet (fail-closed) och Anthropic anropas inte", async () => {
  for (const kv of [fakeKV({ failGet: true }), fakeKV({ failPut: true })]) {
    const m = mockAnthropic();
    try {
      const r = await worker.fetch(req({ kind: "text", text: "Offert" }), env({ REVIEWS_KV: kv }), ctx());
      assert.equal(r.status, 503);
      assert.equal(m.calls.messages, 0);
    } finally { m.restore(); }
  }
});

test("E: globalt dagstak stoppar med 429, och ett fel i taksräknaren stoppar med 503", async () => {
  const m = mockAnthropic();
  try {
    const e = env({ GLOBAL_DAILY_LIMIT: "2", RATE_LIMIT_PER_HOUR: "50" });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await worker.fetch(req({ kind: "text", text: "Offert" }), e, ctx())).status);
    assert.deepEqual(codes, [200, 200, 429]);
    assert.equal(m.calls.messages, 2);
    // taksräknaren (Durable Object) går sönder men IP-räknaren fungerar
    const before = m.calls.messages;
    const brokenDO = { idFromName: (n) => n, get: () => ({ fetch: async () => { throw new Error("do nere"); } }) };
    const r = await worker.fetch(req({ kind: "text", text: "Offert" }, { "CF-Connecting-IP": "198.51.100.200" }), env({ QUOTA: brokenDO }), ctx());
    assert.equal(r.status, 503);
    assert.equal(m.calls.messages, before);
  } finally { m.restore(); }
});

test("E: samtidiga reservationer i samma isolat överskrider aldrig taket (KV med fördröjning)", async () => {
  const e = env({ REVIEWS_KV: fakeKV({ delay: 2 }) });
  const results = await Promise.all(Array.from({ length: 40 }, () => reserve(e, { scope: "global", key: "global:test", limit: 10, ttl: 60 })));
  assert.equal(results.filter((x) => x.ok).length, 10);
  assert.equal(results.filter((x) => x.reason === "limit").length, 30);
  assert.ok(results.every((x) => x.mode === "kv_best_effort"));
});

test("E: Durable Object-läget är atomärt och fail-closed", async () => {
  const store = new Map();
  const state = { storage: { async get(k) { return store.get(k); }, async put(k, v) { store.set(k, v); } } };
  const obj = new QuotaCounter(state);
  // Ett riktigt Durable Object kör en förfrågan i taget per instans (input gates); attrappen gör detsamma.
  let tail = Promise.resolve();
  const ns = {
    idFromName: (n) => n,
    get: () => ({ fetch: (url, init) => { const run = tail.then(() => obj.fetch(new Request(url, init))); tail = run.catch(() => {}); return run; } }),
  };
  const e = { REVIEWS_KV: fakeKV(), QUOTA: ns };
  assert.equal(quotaMode(e), "durable_object");
  const res = await Promise.all(Array.from({ length: 25 }, () => reserve(e, { scope: "global", key: "global:d", limit: 7, ttl: 60, useDurableObject: true })));
  assert.equal(res.filter((x) => x.ok).length, 7);
  assert.ok(res.every((x) => x.mode === "durable_object"));
  const broken = { REVIEWS_KV: fakeKV(), QUOTA: { idFromName: () => 1, get: () => ({ fetch: async () => { throw new Error("do nere"); } }) } };
  assert.deepEqual(await reserve(broken, { scope: "global", key: "k", limit: 5, ttl: 60, useDurableObject: true }), { ok: false, reason: "fel", mode: "durable_object" });
});

test("E: filkontroll före betalt anrop – fel filtyp, för många tokens, tokenräknaren nere", async () => {
  // fel magiska bytes
  let m = mockAnthropic();
  try {
    const bad = await worker.fetch(req({ kind: "pdf", dataBase64: Buffer.from("inte en pdf").toString("base64") }), env(), ctx());
    assert.equal(bad.status, 400);
    assert.equal(m.calls.count + m.calls.messages, 0);
  } finally { m.restore(); }
  // för stort (efter tokenmätning): inget betalt anrop
  m = mockAnthropic({ countTokens: 200000 });
  try {
    const big = await worker.fetch(req({ kind: "pdf", dataBase64: PDF_B64 }), env(), ctx());
    assert.equal(big.status, 400);
    const j = await big.json();
    assert.match(j.error, /för omfattande/);
    assert.equal(m.calls.count, 1);
    assert.equal(m.calls.messages, 0);
  } finally { m.restore(); }
  // tokenräknaren nere: fil nekas (fail-closed)
  m = mockAnthropic({ countFails: true });
  try {
    const r = await worker.fetch(req({ kind: "pdf", dataBase64: PDF_B64 }, { "CF-Connecting-IP": "198.51.100.9" }), env(), ctx());
    assert.equal(r.status, 503);
    assert.equal(m.calls.messages, 0);
  } finally { m.restore(); }
  // inom gränsen: går igenom, mätningen sparas i användningsloggen
  m = mockAnthropic({ countTokens: 30000 });
  const ae = fakeAE();
  try {
    const r = await worker.fetch(req({ kind: "image", mediaType: "image/png", dataBase64: PNG_B64 }, { "CF-Connecting-IP": "198.51.100.10" }), env({ GRANSKA_H: ae }), ctx());
    assert.equal(r.status, 200);
    assert.equal(m.calls.messages, 1);
    assert.equal(ae.p.find((x) => x.blobs[0] === "anrop_kostnad").doubles[3], 30000);
    // tokenräknarens anrop får inte innehålla max_tokens/temperature
    assert.equal("max_tokens" in m.calls.lastCountBody, false);
    assert.equal("temperature" in m.calls.lastCountBody, false);
  } finally { m.restore(); }
  // gränsen är konfigurerbar
  m = mockAnthropic({ countTokens: 30000 });
  try {
    const r = await worker.fetch(req({ kind: "pdf", dataBase64: PDF_B64 }, { "CF-Connecting-IP": "198.51.100.11" }), env({ INPUT_TOKEN_LIMIT: "20000" }), ctx());
    assert.equal(r.status, 400);
  } finally { m.restore(); }
  // 8 MB-gränsen kvar
  m = mockAnthropic();
  try {
    const r = await worker.fetch(req({ kind: "pdf", dataBase64: "A".repeat(11_000_000) }, { "CF-Connecting-IP": "198.51.100.12" }), env(), ctx());
    assert.equal(r.status, 400);
    assert.equal(m.calls.count + m.calls.messages, 0);
  } finally { m.restore(); }
  assert.equal(sniffFile("image", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]).toString("base64")).ok, true);
  assert.equal(sniffFile("text", null, "x").ok, true);
});

// ---------------- Mätning ----------------
test("mätning: klienthändelser valideras, får andra namn än serverbekräftade och tar inga fria fält", async () => {
  assert.deepEqual(normalizeClientEvent({ type: "client", event: "rapport_klar", role: "mottagare" }), { event: "rapport_klar", detail: "", role: "mottagare", test: false });
  assert.deepEqual(normalizeClientEvent({ type: "client", event: "export", detail: "email", role: "hantverkare", test: true }), { event: "export", detail: "email", role: "hantverkare", test: true });
  assert.equal(normalizeClientEvent({ type: "client", event: "export", detail: "fritext Anna 0701234567" }), null);
  assert.equal(normalizeClientEvent({ type: "client", event: "granskning_klar" }), null);
  assert.equal(normalizeClientEvent({ type: "client", event: "constructor" }), null);
  assert.equal(normalizeClientEvent({ type: "share", event: "export" }), null);
  const ae = fakeAE();
  const post = (b, o = {}) => worker.fetch(new Request("https://api.test/event", { method: "POST", headers: { Origin: o.origin || ORIGIN, "CF-Connecting-IP": "203.0.113.1", ...(o.h || {}) }, body: typeof b === "string" ? b : JSON.stringify(b) }), env({ GRANSKA_H: ae }), ctx());
  assert.equal((await post({ type: "client", event: "kontakt_cta", detail: "hemsida", role: "okand" })).status, 204);
  assert.equal((await post({ type: "client", event: "rapport_klar", role: "mottagare", test: true })).status, 204);
  assert.equal((await post({ type: "client", event: "export", detail: "sms", role: "x" }, { h: { "X-SD-Test": "1" } })).status, 204);
  assert.equal((await post({ type: "client", event: "export", detail: "Anna Andersson" })).status, 204);
  assert.equal((await post("x".repeat(3000))).status, 204);
  assert.equal((await post({ type: "client", event: "rapport_klar" }, { origin: "https://ond.example" })).status, 403);
  assert.deepEqual(ae.p, [
    { blobs: ["klient_kontakt_cta", "hemsida", "okand"], indexes: ["skarp"] },
    { blobs: ["klient_rapport_klar", "", "mottagare"], indexes: ["test"] },
    { blobs: ["klient_export", "sms", "okand"], indexes: ["test"] },
  ]);
  assert.ok(!ae.p.some((x) => x.blobs[0] === "granskning_klar"), "klienten kan inte skapa serverbekräftade granskningar");
});

test("mätning: delningsklick räknas även som export i mätningen (en beacon), demo och fritext släpps inte igenom", async () => {
  const ae = fakeAE();
  const e = env({ GRANSKA_H: ae });
  const post = (b) => worker.fetch(new Request("https://api.test/event", { method: "POST", headers: { Origin: ORIGIN }, body: JSON.stringify(b) }), e, ctx());
  await post({ type: "share", channel: "email", role: "hantverkare" });
  await post({ type: "share", channel: "sms", role: "mottagare", test: true });
  await post({ type: "share", channel: "fax" });
  const kv = [...e.REVIEWS_KV.m.keys()];
  assert.ok(kv.includes("count:share:email"));
  assert.deepEqual(ae.p, [
    { blobs: ["klient_export", "email", "hantverkare"], indexes: ["skarp"] },
    { blobs: ["klient_export", "sms", "mottagare"], indexes: ["test"] },
  ]);
});

test("mätning: klienthändelser begränsas av EVENT_RL när bindningen finns", async () => {
  const ae = fakeAE();
  const e = env({ GRANSKA_H: ae, EVENT_RL: { limit: async () => ({ success: false }) } });
  await worker.fetch(new Request("https://api.test/event", { method: "POST", headers: { Origin: ORIGIN }, body: JSON.stringify({ type: "client", event: "rapport_klar" }) }), e, ctx());
  assert.equal(ae.p.length, 0);
});

test("mätning: tratt skriver inga personfält och kan bära tal", () => {
  const ae = fakeAE();
  tratt({ GRANSKA_H: ae }, new Request("https://x", { headers: { "X-SD-Test": "1" } }), "anrop_kostnad", ["m", "känd", "text"], [1, 2, 3, 4]);
  assert.deepEqual(ae.p[0], { blobs: ["anrop_kostnad", "m", "känd", "text"], indexes: ["test"], doubles: [1, 2, 3, 4] });
});

// ---------------- F8/N22: global atomär reservation eller safe-stop ----------------
test("F8/N22: ingen atomär bindning → 503 och inget betalt anrop, även vid ledig kvot", async () => {
  const m = mockAnthropic();
  try {
    const r = await worker.fetch(req({ kind: "text", text: "Offert" }), env({ QUOTA: undefined }), ctx());
    assert.equal(r.status, 503);
    assert.equal(m.calls.messages, 0);
    const e = env({ QUOTA: undefined });
    const res = await reserve(e, { scope: "global", key: "global:x", limit: 3, ttl: 60, requireAtomic: true });
    assert.deepEqual(res, { ok: false, reason: "ingen_atomar_kvot", mode: "kv_best_effort" });
    assert.equal(e.REVIEWS_KV.m.size, 0, "ingen KV-reservation görs när atomär kvot krävs");
  } finally { m.restore(); }
});

test("F8/N22: 12 samtidiga anrop från olika IP mot globalt tak 3 → exakt 3 betalda anrop", async () => {
  const m = mockAnthropic();
  try {
    const e = env({ GLOBAL_DAILY_LIMIT: "3", RATE_LIMIT_PER_HOUR: "50" });
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => worker.fetch(req({ kind: "text", text: "Offert" }, { "CF-Connecting-IP": `198.51.100.${i + 1}` }), e, ctx())));
    assert.equal(rs.filter((r) => r.status === 200).length, 3);
    assert.equal(rs.filter((r) => r.status === 429).length, 9);
    assert.equal(m.calls.messages, 3);
  } finally { m.restore(); }
});

test("F8/N22: trasig räknare och ogiltig konfiguration nekar (räknas aldrig som 0)", async () => {
  const kvWith = (v) => ({ async get() { return v; }, async put() { throw new Error("ska inte skriva"); } });
  for (const bad of ["broken", "-1", "1.5", "NaN", "", " 3", "1e3", "007", "99999999999999999999"]) {
    const res = await reserve({ REVIEWS_KV: kvWith(bad) }, { scope: "rl", key: "rl:a", limit: 3, ttl: 60 });
    assert.deepEqual([res.ok, res.reason], [false, "fel"], `värde ${JSON.stringify(bad)}`);
  }
  assert.equal((await reserve({ REVIEWS_KV: { async get() { return null; }, async put() {} } }, { scope: "rl", key: "rl:b", limit: 3, ttl: 60 })).ok, true); // saknad nyckel = 0
  for (const lim of [NaN, -1, 1.5, Infinity, undefined]) {
    assert.equal((await reserve(env(), { scope: "global", key: "global:l", limit: lim, ttl: 60, requireAtomic: true })).reason, "fel");
  }
  const { parseLimit } = await import("../src/quota.js");
  assert.equal(parseLimit("300", "8"), 300);
  assert.equal(parseLimit(undefined, "8"), 8);
  for (const bad of ["abc", "-3", "2.5", "1e2", "0x10", " 5"]) assert.ok(Number.isNaN(parseLimit(bad, "8")), bad);
  // ogiltig konfiguration → 503 utan betalt anrop
  const m = mockAnthropic();
  try {
    for (const over of [{ GLOBAL_DAILY_LIMIT: "abc" }, { RATE_LIMIT_PER_HOUR: "-2" }]) {
      const r = await worker.fetch(req({ kind: "text", text: "Offert" }), env(over), ctx());
      assert.equal(r.status, 503);
    }
    assert.equal(m.calls.messages, 0);
  } finally { m.restore(); }
});

test("F8/N22: Durable Object-svar valideras – ingen falsk ok utan giltig reservation", async () => {
  const ns = (payload, status = 200) => ({ idFromName: (n) => n, get: () => ({ fetch: async () => new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status }) }) });
  const run = (n) => reserve({ REVIEWS_KV: fakeKV(), QUOTA: n }, { scope: "global", key: "global:v", limit: 3, ttl: 60, requireAtomic: true });
  assert.equal((await run(ns({ ok: true, used: 1 }))).ok, true);
  for (const bad of [{}, { ok: "true", used: 1 }, { ok: true }, { ok: true, used: -1 }, { ok: true, used: 0 }, { ok: true, used: 4 }, { ok: true, used: 1.5 }, { ok: false, used: 1 }, { ok: false }, "<html>", null]) {
    const res = await run(ns(bad));
    assert.equal(res.ok, false, JSON.stringify(bad));
    assert.equal(res.reason, "fel", JSON.stringify(bad));
  }
  assert.equal((await run(ns({ ok: true, used: 1 }, 500))).reason, "fel");
  assert.equal((await run(ns({ ok: false, used: 3 }))).reason, "limit");
});
