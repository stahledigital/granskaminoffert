// Hela kedjan i lokal workerd (Miniflare): RIKTIG produktionsingång, riktiga SQLite-backade
// Durable Objects (CompareOrders + CompareBudget), riktiga alarm, KV. Anthropic och Stripe är
// utgående attrapper; signerad webhook byggs med testhemlighet. Inget riktigt anrop, ingen nyckel.
// Detta är lokal workerd, inte Cloudflares produktion: produktionsbeständighet är EJ BEVISAD.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { signForTest } from "../src/compare_stripe.js";
import { fixtureResponse, offerText, baseVars, WH_SECRET, ORIGIN } from "./helpers/compare_env.mjs";

let Miniflare = null;
for (const cand of [process.env.MINIFLARE_DIR, "miniflare", "/home/claude/gmo/mf/node_modules/miniflare"].filter(Boolean)) {
  try { Miniflare = (await import(cand.startsWith("/") ? pathToFileURL(path.join(cand, "dist/src/index.js")).href : cand)).Miniflare; if (Miniflare) break; } catch { /* */ }
}
let esbuild = null;
for (const cand of [process.env.MINIFLARE_DIR && path.join(process.env.MINIFLARE_DIR, "../esbuild/lib/main.js"), "esbuild", "/home/claude/gmo/mf/node_modules/esbuild/lib/main.js"].filter(Boolean)) {
  try { esbuild = await import(cand.startsWith("/") ? pathToFileURL(cand).href : cand); if (esbuild?.build) break; esbuild = esbuild?.default ?? null; if (esbuild?.build) break; } catch { /* */ }
}
const skip = !Miniflare ? "Miniflare saknas: EJ KÖRD" : !esbuild?.build ? "esbuild saknas: EJ KÖRD" : false;
let entry = null;
if (!skip) {
  entry = path.join(mkdtempSync(path.join(tmpdir(), "gmo-cmp-")), "worker.mjs");
  await esbuild.build({ entryPoints: [fileURLToPath(new URL("../src/index.js", import.meta.url))], bundle: true, format: "esm", target: "es2022", keepNames: true, charset: "ascii", outfile: entry, logLevel: "silent" });
}

function boot(vars = {}, calls) {
  const sessions = new Map();
  return {
    sessions,
    mf: new Miniflare({
      modules: true, scriptPath: entry, modulesRoot: path.dirname(entry), compatibilityDate: "2026-08-01",
      modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
      durableObjects: { COMPARE_ORDERS: { className: "CompareOrders", useSQLite: true }, COMPARE_BUDGET: { className: "CompareBudget", useSQLite: true }, QUOTA: { className: "QuotaCounter", useSQLite: true } },
      kvNamespaces: ["REVIEWS_KV"],
      bindings: Object.fromEntries(Object.entries({ ...baseVars(), ...vars }).filter(([, v]) => v !== undefined)),
      outboundService: async (req) => {
        const u = new URL(req.url);
        const body = req.method === "POST" ? await req.text() : "";
        if (u.hostname === "api.anthropic.com") {
          if (u.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 2500 });
          calls.messages++;
          const j = JSON.parse(body);
          const t = j.messages[0].content.map((b) => b.text || "").join("");
          const spec = JSON.parse(t.slice(t.indexOf("FIXTURE:") + 8, t.indexOf("\n</offert>")));
          if (j.tools[0].name === "submit_priority") return Response.json({ stop_reason: "tool_use", usage: { input_tokens: 400, output_tokens: 50 }, content: [{ type: "tool_use", id: "p", name: "submit_priority", input: { priority_ids: [] } }] });
          return Response.json({ stop_reason: "tool_use", usage: { input_tokens: 2500, output_tokens: 700 }, content: [{ type: "tool_use", id: "t", name: "submit_offer", input: fixtureResponse(spec) }] });
        }
        if (u.hostname === "api.stripe.com" && u.pathname === "/v1/checkout/sessions" && req.method === "POST") {
          const p = new URLSearchParams(body);
          const id = "cs_test_rt00000001";
          const s = { id, object: "checkout.session", url: "https://checkout.stripe.test/c/" + id, expires_at: Math.floor(Date.now() / 1000) + 3600, mode: "payment", livemode: false, client_reference_id: p.get("client_reference_id"), currency: "sek", amount_total: Number(p.get("line_items[0][price_data][unit_amount]")), status: "open", payment_status: "unpaid", payment_intent: null };
          sessions.set(id, s); return Response.json(s);
        }
        return new Response("blockerad", { status: 502 });
      },
    }),
  };
}

const call = (mf, method, p, { token, body, raw, headers = {} } = {}) => mf.dispatchFetch("http://localhost" + p, { method, headers: { Origin: ORIGIN, ...(token ? { "x-order-token": token } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });

test("workerd: stängd som standard (inga COMPARE-variabler)", { skip }, async () => {
  const calls = { messages: 0 };
  const { mf } = boot({ COMPARE_ENABLED: undefined }, calls);
  await mf.ready;
  try {
    const r = await call(mf, "GET", "/compare/config");
    assert.equal((await r.json()).enabled, false);
    assert.equal((await call(mf, "POST", "/compare/orders", { body: { docCount: 2 } })).status, 503);
    const h = await (await call(mf, "GET", "/health")).json();
    assert.equal(h.compare.enabled, false);
  } finally { await mf.dispose(); }
});

test("workerd: betalning → riktigt DO-alarm → leverans; dubbel webhook ger inga extra anrop", { skip }, async () => {
  const calls = { messages: 0 };
  const { mf, sessions } = boot({}, calls);
  await mf.ready;
  try {
    const c = await (await call(mf, "POST", "/compare/orders", { body: { docCount: 3, labels: ["A", "B", "C"], accept: { sameJob: true } } })).json();
    const { orderId, token } = c;
    const spec = (t, s = {}) => ({ extracted: { totalBeforeRotSek: t, totalVatBasis: "inkl" }, scope: { rivning: "ingar", material: "ingar", arbete: "ingar", bortforsling: "ingar", resor: "ingar", ...s } });
    const specs = [spec(100000), spec(95000, { bortforsling: "ingar_inte" }), spec(110000)];
    for (let i = 0; i < 3; i++) {
      const u = await call(mf, "PUT", `/compare/orders/${orderId}/docs/${i}`, { token, body: { kind: "text", text: offerText(specs[i]) } });
      assert.equal(u.status, 200, await u.clone().text());
    }
    const cfg = (await (await call(mf, "GET", "/compare/config")).json()).consent;
    const co = await (await call(mf, "POST", `/compare/orders/${orderId}/checkout`, { token, body: { accept: { terms: true, immediateDelivery: true, consentHash: cfg.hash, consentVersion: cfg.version } } })).json();
    assert.match(co.url, /checkout\.stripe\.test/);
    const done = { ...[...sessions.values()][0], status: "complete", payment_status: "paid", payment_intent: "pi_test_0000000001" };
    const raw = JSON.stringify({ id: "evt_rt1", type: "checkout.session.completed", data: { object: done } });
    const hdr = { "stripe-signature": await signForTest(raw, WH_SECRET), "content-type": "application/json" };
    const send = () => mf.dispatchFetch("http://localhost/compare/webhook", { method: "POST", headers: hdr, body: raw });
    const [w1, w2] = await Promise.all([send(), send()]);
    assert.equal(w1.status, 200); assert.equal(w2.status, 200);
    let st;
    for (let i = 0; i < 60; i++) {
      st = (await (await call(mf, "GET", `/compare/orders/${orderId}`, { token })).json()).order;
      if (["delivered", "failed"].includes(st.status)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(st.status, "delivered", JSON.stringify(st));
    assert.equal(calls.messages <= 4, true); assert.ok(calls.messages >= 3);
    const rep = (await (await call(mf, "GET", `/compare/orders/${orderId}/report`, { token })).json()).report;
    assert.equal(rep.count, 3); assert.equal(rep.ranking.shown, false);
    assert.equal((await call(mf, "GET", `/compare/orders/${orderId}`, { token: "A".repeat(32) })).status, 404);
  } finally { await mf.dispose(); }
});
