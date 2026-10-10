// Lokal provmiljö för Jämför mina offerter (ENDAST utveckling/test, aldrig i produktion):
//  • en HTTP-server som serverar sajten (repo-roten) och proxar /compare och /health till den RIKTIGA
//    paketerade Workern i lokal workerd (Miniflare) med riktiga SQLite-Durable Objects och alarm,
//  • en attrapp för api.anthropic.com som läser offerttexten och lämnar en deterministisk avläsning
//    (ingen riktig modell, inga kostnader),
//  • en attrapp för Stripe: skapar "sessioner", en testkassa-sida och en signerad webhook med testhemlighet.
// Inga riktiga nycklar, inga riktiga betalningar.
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { signForTest } from "../src/compare_stripe.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
export const WH_SECRET = "whsec_devsecret123456";

async function load(cands, sub) {
  for (const c of cands.filter(Boolean)) { try { return await import(c.startsWith("/") ? pathToFileURL(path.join(c, sub)).href : c); } catch { /* nästa */ } }
  return null;
}

// Tolkar en offerttext deterministiskt (ersätter modellen i provmiljön).
const SCOPE_WORDS = { rivning: /rivning|demontering/i, bortforsling: /bortforsling|bortforsling|avfall|container/i, material: /material/i, arbete: /arbete|montage|utförande/i, resor: /resa|resor|framkörning|servicebil/i, skydd: /skydd|täck/i, stadning: /städ/i, tillstand: /bygglov|tillstånd|anmälan/i, garanti: /garanti/i, forsakring: /försäkring/i, fskatt: /f-skatt/i, rot: /\brot\b/i };
export function fakeRead(text) {
  const t = String(text);
  const spec = {};
  const fx = t.indexOf("FIXTURE:");
  if (fx >= 0) return JSON.parse(t.slice(fx + 8, t.indexOf("\n</offert>", fx)));
  const lines = t.split(/\n/);
  spec.scope = {};
  for (const [id, re] of Object.entries(SCOPE_WORDS)) {
    const line = lines.find((l) => re.test(l));
    spec.scope[id] = !line ? "framgar_inte" : /ingår (inte|ej)|exkl\.? (rivning|bortforsling|material|städ)|ingår ej/i.test(line) ? "ingar_inte" : "ingar";
  }
  const m = t.match(/(?:totalt|summa|totalpris)[^\d\n]{0,40}([\d][\d  .]*)\s*kr([^\n]*)/i);
  const num = m ? Number(m[1].replace(/[  .]/g, "")) : null;
  const rest = m ? m[2] : "";
  const rot = /före rot/i.test(t) || /före rot/i.test(rest);
  spec.extracted = { totalBeforeRotSek: num && rot ? num : null, totalSumSek: num && !rot ? num : null, totalVatBasis: /exkl/i.test(rest) ? "exkl" : /inkl/i.test(rest) ? "inkl" : null, vatMode: /exkl/i.test(rest) ? "exkl" : /inkl/i.test(rest) ? "inkl" : "ej_angivet", priceType: /löpande/i.test(t) ? "lopande" : /ca\.?|ungefär/i.test(t) ? "ungefarligt" : "fast", jobType: /badrum/i.test(t) ? "badrum" : /tak/i.test(t) ? "tak" : "annat" };
  if (num && !rot && /inkl|exkl/i.test(rest)) { spec.extracted.totalSumSek = num; }
  return spec;
}
const EXTRACT_DEFAULT = { jobType: "badrum", trades: [], hourlyRateSek: null, hours: null, laborSumSek: null, materialSumSek: null, travelSumSek: null, travelVisits: null, materialMarkupPct: null, rotAmountSek: null, rotRatePct: null, rotPersons: null, rotOnMaterialOrTravel: null, priceType: "fast", vatMode: "ej_angivet", totalSumSek: null, totalIncludesVat: null, totalBeforeRotSek: null, amountToPaySek: null, totalVatBasis: null, propertyType: "smahus", totalContract: null, quoteDate: null, plannedPaymentDate: null, customerType: "privatperson", workDescription: "Renovering", county: null, areaM2: null, unitCount: null, otherSumSek: null };
function offerInput(spec) {
  return {
    extracted: { ...EXTRACT_DEFAULT, ...(spec.extracted || {}) },
    scope: Object.entries(spec.scope || {}).map(([id, status]) => ({ id, status, page: status === "framgar_inte" ? null : 1, ref: status === "framgar_inte" ? null : "rad om " + id })),
    facts: [{ id: "total", page: 1, ref: "Summa" }], readability: { level: spec.readability || "bra" }, instructionsInDocument: !!spec.inj,
  };
}

export async function startHarness({ vars = {}, anthropicDelayMs = 0 } = {}) {
  const miniflareMod = await load([process.env.MINIFLARE_DIR, "miniflare", "/home/claude/gmo/mf/node_modules/miniflare"], "dist/src/index.js");
  const esbuild = await load([process.env.MINIFLARE_DIR && path.join(process.env.MINIFLARE_DIR, "../esbuild/lib/main.js"), "esbuild", "/home/claude/gmo/mf/node_modules/esbuild/lib/main.js"], "");
  const E = esbuild && (esbuild.build ? esbuild : esbuild.default);
  if (!miniflareMod || !E?.build) throw new Error("Miniflare/esbuild saknas");
  const out = join(mkdtempSync(join(tmpdir(), "gmo-harness-")), "worker.mjs");
  await E.build({ entryPoints: [fileURLToPath(new URL("../src/index.js", import.meta.url))], bundle: true, format: "esm", target: "es2022", keepNames: true, charset: "ascii", outfile: out, logLevel: "silent" });

  const sessions = new Map(); // id -> session + urls
  const idemSeen = new Map();
  const stats = { anthropic: 0, stripeCreate: 0, webhooks: 0, refunds: 0 };
  const ctl = { anthropicDelayMs, failAnthropic: 0 };
  let port = 0;
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    try {
      if (u.pathname.startsWith("/dev/stripe/")) return await stripeDev(u, res);
      if (u.pathname.startsWith("/compare/") || u.pathname === "/health") {
        const chunks = []; for await (const c of req) chunks.push(c);
        const r = await mf.dispatchFetch("http://localhost" + u.pathname + u.search, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !["host", "connection", "content-length"].includes(k))), body: ["GET", "HEAD", "OPTIONS"].includes(req.method) ? undefined : Buffer.concat(chunks) });
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(r.status, Object.fromEntries(r.headers)); return res.end(buf);
      }
      let p = normalize(decodeURIComponent(u.pathname)).replace(/^(\.\.[/\\])+/, "");
      let f = join(ROOT, p);
      if (!existsSync(f) || !extname(f)) f = join(f, "index.html");
      if (!existsSync(f)) { res.writeHead(404); return res.end("nej"); }
      res.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" }); res.end(readFileSync(f));
    } catch (e) { res.writeHead(500); res.end(String(e && e.message)); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function sendWebhook(s, type = "checkout.session.completed", id = "evt_" + Math.random().toString(36).slice(2, 12)) {
    const raw = JSON.stringify({ id, type, data: { object: s.obj } });
    stats.webhooks++;
    return mf.dispatchFetch("http://localhost/compare/webhook", { method: "POST", headers: { "stripe-signature": await signForTest(raw, WH_SECRET), "content-type": "application/json" }, body: raw });
  }
  async function stripeDev(u, res) {
    const s = sessions.get(u.searchParams.get("sid"));
    if (!s) { res.writeHead(404); return res.end("okänd session"); }
    const act = u.pathname.split("/").pop();
    if (act === "pay") {
      s.obj = { ...s.obj, status: "complete", payment_status: "paid", payment_intent: "pi_dev_" + s.obj.id.slice(-10) };
      if (u.searchParams.get("webhook") !== "0") await sendWebhook(s);
      res.writeHead(302, { location: s.success }); return res.end();
    }
    if (act === "cancel") { res.writeHead(302, { location: s.cancel }); return res.end(); }
    if (act === "declined") { res.writeHead(302, { location: s.cancel }); return res.end(); }
    if (act === "webhook") { const r = await sendWebhook(s, u.searchParams.get("type") || "checkout.session.completed", u.searchParams.get("evt") || undefined); res.writeHead(200); return res.end(String(r.status)); }
    if (act === "expire") { s.obj = { ...s.obj, status: "expired" }; res.writeHead(200); return res.end("ok"); }
    res.writeHead(404); res.end();
  }

  const bindings = {
    COMPARE_ENABLED: "1", COMPARE_PAYMENTS: "test", STRIPE_SECRET_KEY: "sk_test_devdevdev1234", STRIPE_WEBHOOK_SECRET: WH_SECRET,
    COMPARE_MONTH_CAP_MICRO: "20000000", COMPARE_PAID_CAP_MICRO: "10000000", COMPARE_ORDER_CAP_MICRO: "2000000", COMPARE_DAY_ORDERS: "200",
    COMPARE_RETURN_URL: base + "/jamfor/", ANTHROPIC_API_KEY: "sk-ant-dev-inte-riktig", ALLOWED_ORIGIN: base, ANTHROPIC_MODEL: "claude-sonnet-5-5", ...vars,
  };
  const mf = new miniflareMod.Miniflare({
    modules: true, scriptPath: out, modulesRoot: path.dirname(out), compatibilityDate: "2026-08-01",
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    durableObjects: { COMPARE_ORDERS: { className: "CompareOrders", useSQLite: true }, COMPARE_BUDGET: { className: "CompareBudget", useSQLite: true }, QUOTA: { className: "QuotaCounter", useSQLite: true } },
    kvNamespaces: ["REVIEWS_KV"],
    bindings: Object.fromEntries(Object.entries(bindings).filter(([, v]) => v !== undefined)),
    outboundService: async (req) => {
      const u = new URL(req.url);
      const body = req.method === "POST" ? await req.text() : "";
      if (u.hostname === "api.anthropic.com") {
        if (u.pathname.endsWith("/count_tokens")) { const j = JSON.parse(body); return Response.json({ input_tokens: Math.min(50000, 1200 + Math.ceil(JSON.stringify(j.messages).length / 3)) }); }
        stats.anthropic++;
        if (ctl.anthropicDelayMs) await new Promise((r) => setTimeout(r, ctl.anthropicDelayMs));
        if (ctl.failAnthropic > 0) { ctl.failAnthropic--; return Response.json({ error: { type: "overloaded_error" } }, { status: 529 }); }
        const j = JSON.parse(body);
        if (j.tools[0].name === "submit_priority") return Response.json({ stop_reason: "tool_use", usage: { input_tokens: 500, output_tokens: 40 }, content: [{ type: "tool_use", id: "p", name: "submit_priority", input: { priority_ids: [] } }] });
        const text = j.messages[0].content.map((b) => b.text || "").join("");
        const doc = j.messages[0].content.find((b) => b.type === "document" || b.type === "image");
        const spec = doc ? { extracted: { totalBeforeRotSek: 85000, totalVatBasis: "inkl", vatMode: "inkl" }, scope: { rivning: "ingar", material: "ingar", arbete: "ingar" }, readability: "osaker" } : fakeRead(text);
        return Response.json({ stop_reason: "tool_use", usage: { input_tokens: 2400, output_tokens: 650 }, content: [{ type: "tool_use", id: "t", name: "submit_offer", input: offerInput(spec) }] });
      }
      if (u.hostname === "api.stripe.com" && u.pathname === "/v1/checkout/sessions" && req.method === "POST") {
        stats.stripeCreate++;
        const p = new URLSearchParams(body);
        // Som Stripe: samma idempotensnyckel med andra parametrar nekas; samma parametrar ger samma session.
        const idem = req.headers.get("idempotency-key");
        if (idem && idemSeen.has(idem)) {
          const prev = idemSeen.get(idem);
          if (prev.body !== body) return Response.json({ error: { type: "idempotency_error", code: "idempotency_key_in_use" } }, { status: 400 });
          return Response.json(prev.obj);
        }
        const id = "cs_test_dev" + String(sessions.size + 1).padStart(7, "0");
        const obj = { id, object: "checkout.session", url: `https://checkout.stripe.test/c/${id}`, expires_at: Number(p.get("expires_at")), mode: "payment", livemode: false, client_reference_id: p.get("client_reference_id"), currency: "sek", amount_total: Number(p.get("line_items[0][price_data][unit_amount]")), status: "open", payment_status: "unpaid", payment_intent: null, metadata: { order_id: p.get("metadata[order_id]") } };
        if (idem) idemSeen.set(idem, { body, obj });
        sessions.set(id, { obj, success: p.get("success_url").replace("{CHECKOUT_SESSION_ID}", id), cancel: p.get("cancel_url") });
        return Response.json(obj);
      }
      const g = u.hostname === "api.stripe.com" && u.pathname.match(/^\/v1\/checkout\/sessions\/(cs_\w+)$/);
      if (g) { const s = sessions.get(g[1]); return s ? Response.json(s.obj) : Response.json({ error: { code: "resource_missing" } }, { status: 404 }); }
      if (u.hostname === "api.stripe.com" && u.pathname === "/v1/refunds") { stats.refunds++; return Response.json({ id: "re_dev_1", object: "refund", status: "succeeded" }); }
      return new Response("blockerad", { status: 502 });
    },
  });
  await mf.ready;
  return { base, port, mf, sessions, stats, ctl, sendWebhook, close: async () => { server.close(); await mf.dispose(); } };
}

// Testkassan som visas på https://checkout.stripe.test/c/<id> (Playwright routar den hit).
export function fakeCheckoutHtml(base, sid) {
  return `<!doctype html><html lang="sv"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stripe testkassa (attrapp)</title><body style="font-family:system-ui;padding:24px;max-width:420px;margin:auto"><h1>Testkassa</h1><p>Attrapp för Stripe Checkout (testläge). Ingen riktig betalning.</p><p>Jämför mina offerter – 49,00 kr</p>
<p><a id="pay" href="${base}/dev/stripe/pay?sid=${sid}" style="display:block;padding:14px;background:#635bff;color:#fff;border-radius:8px;text-align:center;text-decoration:none">Betala 49,00 kr (test)</a></p>
<p><a id="paylate" href="${base}/dev/stripe/pay?sid=${sid}&webhook=0" style="display:block;padding:14px;border:1px solid #999;border-radius:8px;text-align:center;text-decoration:none">Betala – webhook dröjer</a></p>
<p><a id="cancel" href="${base}/dev/stripe/cancel?sid=${sid}">← Avbryt</a></p></body></html>`;
}
