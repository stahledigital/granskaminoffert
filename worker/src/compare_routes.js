// HTTP-ytan för Jämför mina offerter. Allt under /compare. Funktionen är AVSTÄNGD tills
// COMPARE_ENABLED="1", betalningsläge, människokonfigurerade kostnadstak och returadress finns
// (compare_config.js). Webbläsaren skickar aldrig pris eller belopp; priset är serverkod.
//
// Åtkomst: varje order har en slumpad åtkomstnyckel (24 byte) som returneras EN gång vid skapandet
// och bara lagras som SHA-256-hash. Nyckeln skickas i headern X-Order-Token, aldrig i URL/query.
// Betalningsbevis kommer bara från signerad webhook eller serveravstämning mot Stripe – returadressen
// (success_url) bevisar ingenting.

import { OFFER, LIMITS, compareEnabled, paymentsMode, budgetConfig, returnUrl, acceptingOrders } from "./compare_config.js";
import { ORDER_ID_RE, TOKEN_RE, newOrderId, newAccessToken, sha256Hex, jsonResponse } from "./compare_util.js";
import { sniffFile, countInputTokens } from "./limits.js";
import { DEFAULT_MODEL, worstCaseUsd, modelInfo } from "./models.js";
import { buildExtractRequest } from "./compare_extract.js";
import { offerLabels } from "./compare_engine.js";
import { createCheckoutSession, retrieveSession, verifyWebhook } from "./compare_stripe.js";
import * as budget from "./compare_budget.js";

const MAX_BODY_CHARS = 11_600_000; // 8 MB binärt ≈ 10,7 MB base64
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const SAFETY_TOKENS = 600;
const SYNTH_RESERVE_TOKENS = LIMITS.synthMaxInputTokens;

function cors(origin, allowedOrigins) {
  return {
    "Access-Control-Allow-Origin": allowedOrigins.includes(origin) ? origin : allowedOrigins[0],
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Order-Token",
    "Vary": "Origin",
    "X-Robots-Tag": "noindex, nofollow, nosnippet",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
}

const bindingsOk = (env) => Boolean(env.COMPARE_ORDERS && typeof env.COMPARE_ORDERS.get === "function" && env.REVIEWS_KV && budget.budgetBindingAvailable(env));

async function orderCall(env, id, path, body) {
  const stub = env.COMPARE_ORDERS.get(env.COMPARE_ORDERS.idFromName(id));
  const r = await stub.fetch(`https://compare-orders${path}`, { method: "POST", body: JSON.stringify(body) });
  let json = null;
  try { json = await r.json(); } catch { /* ogiltigt */ }
  return { status: r.status, json: json || { ok: false } };
}

// Värsta tänkbara kostnad (µUSD) för hela ordern: en avläsning per offert plus ett ordningssteg.
export function estimateWorstMicro(model, tokensPerDoc) {
  let usd = 0;
  for (const t of tokensPerDoc) {
    const w = worstCaseUsd(model, t + SAFETY_TOKENS);
    if (w === null) return null;
    usd += w;
  }
  const s = worstCaseUsd(model, SYNTH_RESERVE_TOKENS);
  if (s === null) return null;
  usd += s;
  return budget.usdToMicro(usd);
}

function pdfPagesEstimate(base64) {
  try {
    const bin = atob(base64);
    const m = bin.match(/\/Type\s*\/Page(?![A-Za-z])/g);
    return m ? m.length : null;
  } catch { return null; }
}

async function readJson(request, maxChars) {
  const raw = await request.text();
  if (raw.length > maxChars) return { tooLarge: true };
  try { return { value: JSON.parse(raw) }; } catch { return { bad: true }; }
}

function publicConfig(env, allowedOrigins) {
  const enabled = compareEnabled(env);
  return {
    enabled,
    accepting: enabled && bindingsOk(env) && acceptingOrders(env, allowedOrigins),
    mode: enabled ? paymentsMode(env) : null,
    offer: { product: OFFER.product, priceOre: OFFER.priceOre, currency: OFFER.currency, vatPct: OFFER.vatPct, minDocs: OFFER.minDocs, maxDocs: OFFER.maxDocs, retentionHours: OFFER.retentionHours },
    limits: {
      maxFileBytes: LIMITS.maxFileBytes, maxTotalBytes: LIMITS.maxTotalBytes, maxTextChars: LIMITS.maxTextChars,
      maxPdfPagesPerDoc: LIMITS.maxPdfPagesPerDoc, maxPdfPagesTotal: LIMITS.maxPdfPagesTotal,
    },
    dataCards: false, // datakort är avstängda tills åtkomst, villkor och budget är verifierade
    refund: env.COMPARE_AUTO_REFUND === "1" ? "auto" : "manual",
  };
}

export async function handleCompare(request, env, ctx, { allowedOrigins }) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!(path === "/compare" || path.startsWith("/compare/"))) return null;
  const origin = request.headers.get("Origin") || "";
  const headers = cors(origin, allowedOrigins);
  const reply = (body, status = 200) => jsonResponse(body, status, headers);
  const closed = () => reply({ error: "Jämförelsen är inte öppen än." }, 503);
  const originOk = allowedOrigins.includes(origin);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

  // ---- Stripe-webhook: ingen Origin, men obligatorisk signatur ----
  if (path === "/compare/webhook") {
    if (request.method !== "POST") return reply({ error: "Not found" }, 404);
    const mode = compareEnabled(env) ? paymentsMode(env) : null;
    if (!mode || !bindingsOk(env)) return reply({ error: "stängd" }, 503);
    const raw = await request.text();
    if (raw.length > 512_000) return reply({ error: "för stor" }, 413);
    const v = await verifyWebhook(raw, request.headers.get("stripe-signature") || "", env.STRIPE_WEBHOOK_SECRET);
    if (!v.ok) return reply({ error: "ogiltig signatur" }, 400);
    const ev = v.event;
    const obj = ev.data && ev.data.object;
    const orderId = obj && typeof obj.client_reference_id === "string" ? obj.client_reference_id : "";
    if (!ORDER_ID_RE.test(orderId)) return reply({ ok: true, ignored: "ingen_order" });
    try {
      if (ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") {
        const r = await orderCall(env, orderId, "/paid", { session: obj, eventId: ev.id, mode, now: Date.now() });
        if (r.status === 404) return reply({ ok: true, ignored: "okand_order" });
        if (r.status === 422) {
          // Betalningen stämmer inte med ordern (belopp/valuta/order). Aldrig leverans. 4xx = Stripe försöker inte i oändlighet.
          return reply({ ok: false, error: "betalning_ogiltig", reason: r.json.reason }, 400);
        }
        if (r.status >= 500) return reply({ ok: false }, 500);
        return reply({ ok: true, dup: !!r.json.dup });
      }
      if (ev.type === "checkout.session.expired" || ev.type === "checkout.session.async_payment_failed") {
        const r = await orderCall(env, orderId, "/checkout-expired", { sessionId: obj.id, eventId: ev.id, now: Date.now() });
        if (r.status >= 500) return reply({ ok: false }, 500);
        return reply({ ok: true });
      }
    } catch { return reply({ ok: false }, 500); }
    return reply({ ok: true, ignored: "typ" });
  }

  // ---- Config (öppen, ingen hemlighet) ----
  if (path === "/compare/config" && request.method === "GET") return reply(publicConfig(env, allowedOrigins));

  if (!compareEnabled(env) || !bindingsOk(env)) return closed();

  // ---- Skapa order ----
  if (path === "/compare/orders" && request.method === "POST") {
    if (!originOk) return reply({ error: "Det här kan bara startas från granskaminoffert.se." }, 403);
    if (!acceptingOrders(env, allowedOrigins)) return closed();
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const rlb = env.COMPARE_RL || env.REVIEW_RL;
    if (rlb) { try { const { success } = await rlb.limit({ key: ip }); if (!success) return reply({ error: "För många försök just nu. Vänta en stund." }, 429); } catch { /* bindning nere */ } }
    const body = await readJson(request, 20_000);
    if (!body.value) return reply({ error: "Ogiltig förfrågan." }, 400);
    const b = body.value;
    const docCount = b.docCount;
    if (!Number.isInteger(docCount) || docCount < OFFER.minDocs || docCount > OFFER.maxDocs) return reply({ error: `Välj ${OFFER.minDocs}–${OFFER.maxDocs} offerter.` }, 400);
    const a = b.accept || {};
    if (a.sameJob !== true) return reply({ error: "Du behöver bekräfta att offerterna gäller samma jobb.", needAccept: true }, 400);
    const cfg = budgetConfig(env);
    const cap = await budget.capacity(env, { caps: { joint: cfg.month, scope: cfg.paid }, scope: "paid" });
    if (!cap.ok || cap.halted || cap.remaining <= 0) return reply({ error: "Jämförelsen är tillfälligt full. Försök igen senare." }, 503);
    const c = await budget.countToday(env, { name: "orders", limit: cfg.dayOrders });
    if (!c.ok) return reply({ error: "Dagens platser är slut. Försök igen i morgon." }, 429);
    const id = newOrderId();
    const token = newAccessToken();
    const labels = offerLabels(Array.isArray(b.labels) ? b.labels : [], docCount);
    const r = await orderCall(env, id, "/create", { id, tokenHash: await sha256Hex(token), labels, docCount, accept: { sameJob: true, at: Date.now(), offer: OFFER.version }, now: Date.now() });
    if (r.status !== 200 || !r.json.ok) return reply({ error: "Det gick inte att starta just nu." }, 503);
    return reply({ ok: true, orderId: id, token, order: r.json.order }, 201);
  }

  // ---- Per order ----
  const m = path.match(/^\/compare\/orders\/(o_[0-9a-f]{32})(?:\/(docs\/([0-3])|checkout|report))?$/);
  if (!m) return reply({ error: "Not found" }, 404);
  const id = m[1];
  const sub = m[2] || "";
  const token = request.headers.get("x-order-token") || "";
  if (!ORDER_ID_RE.test(id) || !TOKEN_RE.test(token)) return reply({ error: "Ordern hittades inte." }, 404);
  const tokenHash = await sha256Hex(token);
  const mutating = request.method !== "GET";
  if (mutating && !originOk) return reply({ error: "Otillåten källa." }, 403);

  // Status (+ serveravstämning mot Stripe när betalning väntas)
  if (!sub && request.method === "GET") {
    const g = await orderCall(env, id, "/get", { tokenHash, now: Date.now() });
    if (g.status === 404) return reply({ error: "Ordern hittades inte." }, 404);
    if (g.status !== 200) return reply({ error: "Tillfälligt fel." }, 503);
    let order = g.json.order;
    const mode = paymentsMode(env);
    if (g.json.reconcile && mode) {
      const mk = await orderCall(env, id, "/reconcile-mark", { tokenHash, now: Date.now() });
      const sessionId = mk.json && mk.json.sessionId;
      if (sessionId) {
        try {
          const s = await retrieveSession(env, sessionId);
          if (s && s.status === "complete" && s.payment_status === "paid") {
            await orderCall(env, id, "/paid", { session: s, eventId: `recon:${sessionId}`, mode, now: Date.now() });
          } else if (s && s.status === "expired") {
            await orderCall(env, id, "/checkout-expired", { sessionId, eventId: `recon-exp:${sessionId}`, now: Date.now() });
          }
        } catch { /* nästa avläsning försöker igen */ }
        const g2 = await orderCall(env, id, "/get", { tokenHash, now: Date.now() });
        if (g2.status === 200) order = g2.json.order;
      }
    }
    return reply({ ok: true, order, pollMs: LIMITS.statusPollMinMs });
  }

  if (!sub && request.method === "DELETE") {
    const r = await orderCall(env, id, "/delete", { tokenHash, now: Date.now() });
    if (r.status === 404) return reply({ error: "Ordern hittades inte." }, 404);
    if (r.status === 409) return reply({ error: "Jämförelsen pågår. Vänta tills den är klar." }, 409);
    return reply({ ok: r.json.ok === true, order: r.json.order });
  }

  if (sub === "report" && request.method === "GET") {
    const g = await orderCall(env, id, "/internal", { now: Date.now() });
    if (g.status !== 200 || !g.json.order) return reply({ error: "Ordern hittades inte." }, 404);
    const o = g.json.order;
    const auth = await orderCall(env, id, "/get", { tokenHash, now: Date.now() });
    if (auth.status !== 200) return reply({ error: "Ordern hittades inte." }, 404);
    if (o.status !== "delivered" || !o.reportKey) return reply({ error: "Rapporten är inte klar.", status: o.status }, 409);
    const rep = await env.REVIEWS_KV.get(o.reportKey, "json");
    if (!rep) return reply({ error: "Rapporten har gått ut och är raderad.", expired: true }, 410);
    return reply({ ok: true, report: rep });
  }

  if (sub === "checkout" && request.method === "POST") {
    const mode = paymentsMode(env);
    if (!mode || !acceptingOrders(env, allowedOrigins)) return closed();
    // Villkor och uttryckligt samtycke till direkt leverans lämnas vid köpet, inte vid kontrollen.
    const bodyIn = await readJson(request, 2_000);
    const acc = (bodyIn.value && bodyIn.value.accept) || {};
    if (acc.terms !== true || acc.immediateDelivery !== true) return reply({ error: "Du behöver godkänna villkoren och att leveransen startar direkt.", needAccept: true }, 400);
    const ac = await orderCall(env, id, "/accept", { tokenHash, accept: { terms: true, immediateDelivery: true }, now: Date.now() });
    if (ac.status === 404) return reply({ error: "Ordern hittades inte." }, 404);
    if (ac.status !== 200) return reply({ error: "Ordern kan inte betalas i det här läget." }, 409);
    const begin = await orderCall(env, id, "/checkout-begin", { tokenHash, now: Date.now() });
    if (begin.status === 404) return reply({ error: "Ordern hittades inte." }, 404);
    if (begin.status === 409) return reply({ error: "Ordern kan inte betalas i det här läget.", reason: begin.json.error }, 409);
    if (begin.status !== 200) return reply({ error: "Tillfälligt fel." }, 503);
    if (begin.json.reuse) return reply({ ok: true, url: begin.json.reuse.url });
    const cfg = budgetConfig(env);
    const cap = await budget.capacity(env, { caps: { joint: cfg.month, scope: cfg.paid }, scope: "paid" });
    const need = begin.json.order && begin.json.order.estimateMicro;
    if (!cap.ok || cap.halted || cap.remaining <= 0 || (Number.isFinite(need) && cap.remaining < need)) return reply({ error: "Jämförelsen är tillfälligt full. Du har inte debiterats." }, 503);
    const ru = returnUrl(env, allowedOrigins);
    let sess;
    try { sess = await createCheckoutSession(env, begin.json.snapshot, { returnUrl: ru }); } catch { return reply({ error: "Betalningen kunde inte startas. Du har inte debiterats." }, 502); }
    const set = await orderCall(env, id, "/checkout-set", { tokenHash, session: sess, now: Date.now() });
    if (set.status !== 200 || !set.json.ok) return reply({ error: "Betalningen kunde inte startas. Du har inte debiterats." }, 502);
    return reply({ ok: true, url: set.json.url });
  }

  if (m[3] !== undefined && request.method === "PUT") {
    const idx = Number(m[3]);
    const model = env.ANTHROPIC_MODEL || DEFAULT_MODEL;
    if (!modelInfo(model)) return closed();
    const cur = await orderCall(env, id, "/get", { tokenHash, now: Date.now() });
    if (cur.status === 404) return reply({ error: "Ordern hittades inte." }, 404);
    if (cur.status !== 200) return reply({ error: "Tillfälligt fel." }, 503);
    const order = cur.json.order;
    if (!["draft", "ready"].includes(order.status)) return reply({ error: "Ordern är låst." }, 409);
    if (idx >= order.docCount) return reply({ error: "Fel offertnummer." }, 400);
    const body = await readJson(request, MAX_BODY_CHARS);
    if (body.tooLarge) return reply({ error: "Filen är för stor (max 8 MB)." }, 413);
    if (!body.value) return reply({ error: "Ogiltig förfrågan." }, 400);
    const { kind, text, dataBase64, mediaType } = body.value;
    if (kind !== "text" && kind !== "pdf" && kind !== "image") return reply({ error: "Okänt filformat." }, 400);
    if (kind === "text" && (typeof text !== "string" || !text.trim())) return reply({ error: "Ingen offert att läsa." }, 400);
    if (kind === "text" && text.length > LIMITS.maxTextChars) return reply({ error: `Texten är för lång (max ${LIMITS.maxTextChars.toLocaleString("sv-SE")} tecken).` }, 400);
    if (kind !== "text" && (typeof dataBase64 !== "string" || !dataBase64)) return reply({ error: "Ingen offert att läsa." }, 400);
    if (kind !== "text" && dataBase64.length * 0.75 > LIMITS.maxFileBytes) return reply({ error: "Filen är för stor (max 8 MB)." }, 413);
    let doc = { kind, text: kind === "text" ? text : undefined, mediaType: undefined, dataBase64: kind === "text" ? undefined : dataBase64 };
    let pages = null;
    if (kind !== "text") {
      const sn = sniffFile(kind, mediaType, dataBase64);
      if (!sn.ok) return reply({ error: kind === "pdf" ? "Filen ser inte ut som en PDF." : "Filen ser inte ut som en bild som går att läsa. Spara den som JPEG eller PNG." }, 400);
      if (kind === "image") {
        const mt = sn.mediaType || String(mediaType || "").toLowerCase();
        if (!IMAGE_TYPES.includes(mt)) return reply({ error: "Bildformatet går inte att läsa. Spara bilden som JPEG eller PNG." }, 400);
        doc.mediaType = mt;
      } else {
        doc.mediaType = "application/pdf";
        pages = pdfPagesEstimate(dataBase64);
        if (pages !== null && pages > LIMITS.maxPdfPagesPerDoc) return reply({ error: `PDF-filen verkar ha fler än ${LIMITS.maxPdfPagesPerDoc} sidor. Dela upp den eller ta bara sidorna med pris och villkor.` }, 400);
      }
    }
    // Mät indatan med den gratis tokenräknaren. Kan en fil inte mätas nekas den (fail closed).
    const req = buildExtractRequest({ model, doc });
    let tokens;
    try { tokens = await countInputTokens(env, req); } catch {
      if (kind !== "text") return reply({ error: "Det gick inte att kontrollera filens storlek just nu. Försök igen om en stund." }, 503);
      tokens = Math.ceil(text.length / 2) + 3000; // text är redan begränsad; försiktig uppskattning
    }
    if (tokens > LIMITS.maxInputTokensPerDoc) return reply({ error: "Dokumentet är för omfattande. Dela upp det eller ta bara sidorna med pris och villkor.", tokens, limit: LIMITS.maxInputTokensPerDoc }, 400);
    const bytes = kind === "text" ? new TextEncoder().encode(text).length : Math.floor(dataBase64.length * 0.75);
    const sha = await sha256Hex(kind === "text" ? text : dataBase64);
    // Förväntad kostnad för hela ordern med detta dokument inräknat (alla dokument kända först då ordern är komplett).
    const others = order.docs.filter((d) => d.idx !== idx).map((d) => d.tokens);
    const complete = others.length + 1 === order.docCount;
    const estimateMicro = complete ? estimateWorstMicro(model, [...others, tokens]) : null;
    if (complete) {
      const cfg = budgetConfig(env);
      const cap = await budget.capacity(env, { caps: { joint: cfg.month, scope: cfg.paid }, scope: "paid" });
      if (estimateMicro === null || !cap.ok || cap.halted || cap.remaining < estimateMicro || estimateMicro > cfg.order) {
        return reply({ error: "Jämförelsen kan inte genomföras just nu. Försök igen senare." }, 503);
      }
    }
    const key = `cmpdoc:${id}:${idx}`;
    try { await env.REVIEWS_KV.put(key, JSON.stringify(doc), { expirationTtl: LIMITS.orderTtlSec }); } catch { return reply({ error: "Det gick inte att spara filen just nu." }, 503); }
    const r = await orderCall(env, id, "/doc", { tokenHash, meta: { idx, kind, bytes, tokens, pages, sha256: sha, key }, estimate: complete ? { worstMicro: estimateMicro } : null, now: Date.now() });
    if (r.status !== 200 || !r.json.ok) {
      try { await env.REVIEWS_KV.delete(key); } catch { /* TTL */ }
      if (r.status === 409 && r.json.error === "dubblett") return reply({ error: "Du har lagt in samma fil två gånger." }, 409);
      if (r.status === 413) return reply({ error: "Filerna är tillsammans för stora. Ta bara sidorna med pris och villkor." }, 413);
      if (r.status === 409) return reply({ error: "Ordern är låst." }, 409);
      return reply({ error: "Det gick inte att ta emot filen." }, r.status === 404 ? 404 : 503);
    }
    return reply({ ok: true, order: r.json.order, doc: { idx, kind, bytes, tokens, pages } });
  }

  return reply({ error: "Not found" }, 404);
}

