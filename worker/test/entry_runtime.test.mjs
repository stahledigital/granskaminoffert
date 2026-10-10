// F8c: den RIKTIGA produktionsingången (src/index.js, oförändrad) startas i lokal workerd via
// Miniflare med SQLite-backad Durable Object, KV och en attrapp för api.anthropic.com.
// Bevisar att ingången startar (inga exporterade strängar m.m.), att /health svarar och att det
// globala dygnstaket håller vid samtidiga granskningar. Inget riktigt AI-anrop, ingen nyckel.
// Saknas Miniflare hoppas testet över och rapporteras som EJ KÖRT (se quota_runtime.test.mjs).
import { gateVars } from "./helpers/free_gate.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

let Miniflare = null;
for (const cand of [process.env.MINIFLARE_DIR, "miniflare", "/home/claude/gmo/mf/node_modules/miniflare"].filter(Boolean)) {
  try {
    const spec = cand.startsWith("/") ? pathToFileURL(path.join(cand, "dist/src/index.js")).href : cand;
    Miniflare = (await import(spec)).Miniflare;
    if (Miniflare) break;
  } catch { /* nästa */ }
}
const skip = Miniflare ? false : "Miniflare saknas: produktionsingången i workerd är EJ KÖRD";
const src = fileURLToPath(new URL("../src/index.js", import.meta.url));
// Samma paketering som wrangler gör vid deploy (esbuild, en ESM-fil) – JSON och moduler paketeras in.
let esbuild = null;
for (const cand of [process.env.MINIFLARE_DIR && path.join(process.env.MINIFLARE_DIR, "../esbuild/lib/main.js"), "esbuild", "/home/claude/gmo/mf/node_modules/esbuild/lib/main.js"].filter(Boolean)) {
  try { esbuild = await import(cand.startsWith("/") ? pathToFileURL(cand).href : cand); if (esbuild?.build) break; esbuild = esbuild?.default ?? null; if (esbuild?.build) break; } catch { /* nästa */ }
}
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
const skipAll = skip || (esbuild?.build ? false : "esbuild saknas: produktionsingången i workerd är EJ KÖRD");
let entry = null;
if (!skipAll) {
  const out = path.join(mkdtempSync(path.join(tmpdir(), "gmo-entry-")), "worker.mjs");
  await esbuild.build({ entryPoints: [src], bundle: true, format: "esm", target: "es2022", keepNames: true, charset: "ascii", outfile: out, logLevel: "silent" });
  entry = out;
}
const ORIGIN = "https://granskaminoffert.se";

const gateEnv = () => { const { FREE_BUDGET, ...v } = gateVars(); return v; }; // DO-bindningen kommer från durableObjects ovan
function boot(vars = {}, calls = { messages: 0 }) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: entry,
    modulesRoot: path.dirname(entry),
    compatibilityDate: "2026-08-01",
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    durableObjects: { QUOTA: { className: "QuotaCounter", useSQLite: true }, FREE_BUDGET: { className: "FreeBudget", useSQLite: true } },
    kvNamespaces: ["REVIEWS_KV"],
    bindings: { ANTHROPIC_API_KEY: "test-nyckel-inte-riktig", ALLOWED_ORIGIN: ORIGIN, ANTHROPIC_MODEL: "claude-sonnet-5-5", ...gateEnv(), ...vars },
    outboundService: async (req) => {
      const u = new URL(req.url);
      if (u.hostname !== "api.anthropic.com") return new Response("blockerad", { status: 502 });
      if (u.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 1000 });
      calls.messages++;
      if (calls.delay) await new Promise((r) => setTimeout(r, calls.delay));
      return Response.json({
        stop_reason: "tool_use", usage: { input_tokens: 1000, output_tokens: 300 },
        content: [{ type: "tool_use", name: "submit_review", input: { trade: "annat", contradictions: [], clarify: [], stated: [], calcCoverage: "checked", calcNote: "", price: { comment: "x" }, questions: [], extracted: { trades: [] } } }],
      });
    },
    ...{},
  });
  return mf;
}
const review = (mf, ip) => mf.dispatchFetch("http://localhost/review", {
  method: "POST",
  headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": ip },
  body: JSON.stringify({ kind: "text", text: "Offert: byte av element, 3 timmar à 650 kr, material 1200 kr. Summa 3150 kr inkl moms." }),
});

test("workerd: produktionsingången startar och /health visar hård kvot via Durable Object", { skip: skipAll }, async () => {
  const mf = boot();
  await mf.ready;
  try {
    const r = await mf.dispatchFetch("http://localhost/health", { headers: { Origin: ORIGIN } });
    assert.equal(r.status, 200);
    const h = await r.json();
    assert.equal(h.ok, true);
    assert.equal(h.quotaMode, "durable_object");
    assert.equal(h.paidTrafficAllowed, true);
    assert.equal(h.hasApiKey, true);
  } finally { await mf.dispose(); }
});

test("workerd: ingång + Durable Object – 12 samtidiga granskningar från olika IP mot globalt tak 3 → exakt 3 betalda anrop", { skip: skipAll }, async () => {
  const calls = { messages: 0 };
  const mf = boot({ GLOBAL_DAILY_LIMIT: "3", RATE_LIMIT_PER_HOUR: "50" }, calls);
  await mf.ready;
  try {
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => review(mf, `203.0.113.${i + 1}`)));
    const statuses = rs.map((r) => r.status);
    assert.equal(calls.messages, 3, JSON.stringify(statuses));
    assert.equal(statuses.filter((s) => s === 200).length, 3, JSON.stringify(statuses));
    assert.ok(statuses.filter((s) => s !== 200).every((s) => s === 429 || s === 503), JSON.stringify(statuses));
  } finally { await mf.dispose(); }
});

test("workerd (D12): 12 samtidiga mot pilottak som rymmer 3 värsta fall → exakt 3 generationer; FREE_BUDGET saknas ⇒ stängt", { skip: skipAll }, async () => {
  const calls = { messages: 0, delay: 400 }; // långsamma svar: reservationerna överlappar (annars frigör tidiga avräkningar utrymme)
  const { worstMicroFor } = await import("../src/free_budget.js");
  const cap = String(worstMicroFor("claude-sonnet-5-5", 1000) * 3);
  const mf = boot({ FREE_PILOT_CAP_MICRO: cap, RATE_LIMIT_PER_HOUR: "50" }, calls);
  await mf.ready;
  try {
    const statuses = (await Promise.all(Array.from({ length: 12 }, (_, i) => review(mf, `203.0.113.${i + 1}`)))).map((r) => r.status);
    assert.equal(calls.messages, 3, JSON.stringify(statuses)); assert.equal(statuses.filter((s) => s === 200).length, 3);
    // efter avräkning mot uppmätt (lägre) kostnad finns utrymme igen – det är avsett; taket gäller värsta fall vid reservation
    const h = await (await mf.dispatchFetch("http://localhost/health")).json(); assert.equal(h.freeGate.state, "aktiv");
  } finally { await mf.dispose(); }
});

test("workerd: utan Durable Object-bindning stängs betald trafik (503) och inget anrop görs", { skip: skipAll }, async () => {
  const calls = { messages: 0 };
  const mf = boot({}, calls);
  await mf.dispose();
  const mf2 = new Miniflare({
    modules: true, scriptPath: entry, modulesRoot: path.dirname(entry), compatibilityDate: "2026-08-01",
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }], kvNamespaces: ["REVIEWS_KV"],
    bindings: { ANTHROPIC_API_KEY: "test", ALLOWED_ORIGIN: ORIGIN },
    outboundService: async () => { calls.messages++; return new Response("{}"); },
  });
  await mf2.ready;
  try {
    const h = await (await mf2.dispatchFetch("http://localhost/health", { headers: { Origin: ORIGIN } })).json();
    assert.equal(h.paidTrafficAllowed, false);
    const r = await review(mf2, "203.0.113.50");
    assert.equal(r.status, 503);
    assert.equal(calls.messages, 0);
  } finally { await mf2.dispose(); }
});
