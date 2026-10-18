// HTTP-ytan för Jämför mina offerter. Allt under /compare. Funktionen är AVSTÄNGD tills
// COMPARE_ENABLED="1", betalningsläge, människokonfigurerade kostnadstak och returadress finns
// (compare_config.js). Webbläsaren skickar aldrig pris eller belopp; priset är serverkod.
//
// Åtkomst: varje order har en slumpad åtkomstnyckel (24 byte) som returneras EN gång vid skapandet
// och bara lagras som SHA-256-hash. Nyckeln skickas i headern X-Order-Token, aldrig i URL/query.
// Betalningsbevis kommer bara från signerad webhook eller serveravstämning mot Stripe – returadressen
// (success_url) bevisar ingenting.

import { OFFER, CHECK_OFFER, CHECK_COPY, checkAvailable, LIMITS, testChain, TEST_CHAIN_TO, testStripeEnv, stripeEnvFor, compareEnabled, termsSnapshot, paymentsMode, budgetConfig, returnUrl, acceptingOrders, consentSnapshot, checkConsentSnapshot, CONSENT, consentDraft, consentPolicy, consentTexts, consentVersion, fulfilmentPoint, offerCopy, dataCoverage, RETENTION_CLASSES, retentionPolicy, paymentMethods, SWISH_NOTE } from "./compare_config.js";
import { ORDER_ID_RE, TOKEN_RE, newOrderId, newAccessToken, sha256Hex, jsonResponse } from "./compare_util.js";
import { base64ByteLength, sniffFile, countInputTokens } from "./limits.js";
import { DEFAULT_MODEL, worstCaseUsd, modelInfo } from "./models.js";
import { buildExtractRequest } from "./compare_extract.js";
import { offerLabels } from "./compare_engine.js";
import { validEmail, parseWithdrawToken } from "./compare_ledger.js";
import { timingSafeEqual } from "./compare_util.js";
import { createCheckoutSession, retrieveSession, retrieveRefund, verifyWebhook } from "./compare_stripe.js";
import { preidConfig, preidCtx, buildPreidRequest, readPreid, sanitizePreid, preidProposals, PREID_NOTICE } from "./compare_preid.js";
import { guardedCall, Stop } from "./compare_run.js";
import { identityProposals, sourcesConfig, publicSourcesConfig, googleCandidates, nativeSearchGate, reserveMount, tpCandidates, tpLatest, PLACE_ID_RE, LIM as SRC_LIM } from "./compare_sources.js";
import * as budget from "./compare_budget.js";
import { proWebhook, proMode } from "./pro_routes.js";
import { mailEventsConfig, verifyResendWebhook, normalizeMailEvent, parseMailId, MAIL_EVENT_MAX_BYTES } from "./compare_mailer.js";

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

async function consentHash(env, kind) { return sha256Hex(JSON.stringify(consentSnapshot(env, kind))); }

async function publicConfig(env, allowedOrigins) {
  const enabled = compareEnabled(env);
  const pm = paymentMethods(env);
  return {
    enabled,
    accepting: enabled && bindingsOk(env) && acceptingOrders(env, allowedOrigins),
    mode: enabled ? paymentsMode(env) : null,
    offer: { product: OFFER.product, priceOre: OFFER.priceOre, currency: OFFER.currency, vatPct: OFFER.vatPct, minDocs: OFFER.minDocs, maxDocs: OFFER.maxDocs, retentionHours: OFFER.retentionHours },
    limits: {
      maxFileBytes: LIMITS.maxFileBytes, maxTotalBytes: LIMITS.maxTotalBytes, maxTextChars: LIMITS.maxTextChars,
      maxPdfPagesPerDoc: LIMITS.maxPdfPagesPerDoc, maxPdfPagesTotal: LIMITS.maxPdfPagesTotal,
    },
    // Det kunden ska se och godkänna kommer från servern; hashen bindes till ordern vid köp.
    offerCopy: offerCopy(env),
    consent: { version: consentVersion(env), draft: consentDraft(env), hash: await consentHash(env), texts: consentTexts(env), policy: consentPolicy(env), ...(consentPolicy(env) === "P" ? { fulfilmentPoint: fulfilmentPoint(env).point } : {}) },
    dataCoverage: dataCoverage(env),
    terms: termsSnapshot(env), // fullständig villkorstext (UTKAST) som ingår i samtyckeshashen och i bekräftelsen
    draft: consentDraft(env),
    check: checkAvailable(env) ? { available: true, offer: { product: CHECK_OFFER.product, priceOre: CHECK_OFFER.priceOre, currency: CHECK_OFFER.currency, vatPct: CHECK_OFFER.vatPct, retentionHours: CHECK_OFFER.retentionHours }, offerCopy: CHECK_COPY, consent: { version: consentVersion(env), draft: checkConsentSnapshot(env).draft, hash: await consentHash(env, "check"), texts: consentSnapshot(env, "check").texts, policy: "P", fulfilmentPoint: fulfilmentPoint(env).point }, terms: consentSnapshot(env, "check").terms, dataCoverage: consentSnapshot(env, "check").dataCoverage } : { available: false },
    requiresEmail: true,
    withdrawUrl: "/jamfor/angra/",
    retention: { classes: Object.fromEntries(Object.entries(RETENTION_CLASSES).map(([k, v]) => [k, v.hours ? `${v.hours} h` : "policy ej fastställd"])), policyOk: retentionPolicy(env).ok },
    dataCards: false, // gamla datakortsmodulen (datacard.js) är oanvänd; källor styrs av `sources`
    sources: publicSourcesConfig(env),
    preid: preidConfig(env).on ? { on: true, ...PREID_NOTICE } : { on: false },
    refund: env.COMPARE_AUTO_REFUND === "1" ? "auto" : "manual",
    payment: { methods: pm.swish ? ["card", "swish"] : ["card"], swish: pm.swish, swishNote: pm.swish ? SWISH_NOTE : null },
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

  // PRO delar leveransadresser med GMO, men har egen lägesgrind och signatur.
  // Klona kroppen: vanlig GMO-routing ska få läsa originalet oförändrat.
  if (path === "/compare/webhook" || path === "/compare/webhook-test") {
    if (request.method !== "POST") return reply({ error: "Not found" }, 404);
    const raw = await request.clone().text();
    if (raw.length > 512_000) return reply({ error: "för stor" }, 413);
    let kandidat; try { kandidat = JSON.parse(raw); } catch { return reply({error:"ogiltig signatur"},400); }
    const obj0 = kandidat?.data?.object;
    const pro = obj0?.metadata?.pro === "pro-v1";
    const proRefund = kandidat?.type === "charge.refunded" && obj0?.object === "charge";
    if (pro || proRefund) {
      const pm = proMode(env), tillatet = pm !== "off" && (path !== "/compare/webhook-test" || pm === "test");
      if (pro && !tillatet) return reply({error:"stängd"},503);
      const pv = !tillatet ? {ok:false} : await verifyWebhook(raw,request.headers.get("stripe-signature") || "",pm === "live" ? env.STRIPE_WEBHOOK_SECRET : env.STRIPE_TEST_WEBHOOK_SECRET);
      if (!pv.ok && pro) return reply({error:"ogiltig signatur"},400);
      if (pv.ok) { try { const r = await proWebhook(env,pv.event); return reply(r,r.ok ? 200 : 503); } catch { return reply({ok:false},502); } }
    }
  }

  // ---- Stripe-webhook: vanlig GMO behåller sin ursprungliga grind/signatur ----
  if (path === "/compare/webhook") {
    const raw = await request.text();
    const mode = compareEnabled(env) ? paymentsMode(env) : null;
    if (!mode || !bindingsOk(env)) return reply({ error: "stängd" }, 503);
    const v = await verifyWebhook(raw, request.headers.get("stripe-signature") || "", env.STRIPE_WEBHOOK_SECRET);
    if (!v.ok) return reply({ error: "ogiltig signatur" }, 400);
    const ev = v.event;
    const obj = ev.data && ev.data.object;
    if (ev.type === "refund.updated" || ev.type === "refund.failed" || ev.type === "charge.refund.updated") {
      const rid = obj && obj.metadata && typeof obj.metadata.order_id === "string" ? obj.metadata.order_id : "";
      if (!ORDER_ID_RE.test(rid) || !obj || obj.object !== "refund") return reply({ ok: true, ignored: "ingen_order" });
      try {
        const r = await orderCall(env, rid, "/refund-update", { refund: { id: obj.id, status: obj.status }, now: Date.now() });
        if (r.status >= 500) return reply({ ok: false }, 500);
        return reply({ ok: true });
      } catch { return reply({ ok: false }, 500); }
    }
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

  // ---- D16-R2: Stripe TEST-webhook (separat hemlighet). Hanterar ENDAST testordrar (DO nekar annat); live-webhooken kan aldrig betala en testorder. STÄNGD utan testChain. ----
  if (path === "/compare/webhook-test") {
    if (request.method !== "POST") return reply({ error: "Not found" }, 404);
    if (!compareEnabled(env) || !bindingsOk(env) || !testChain(env).on) return reply({ error: "stängd" }, 503);
    const raw = await request.text();
    if (raw.length > 512_000) return reply({ error: "för stor" }, 413);
    const v = await verifyWebhook(raw, request.headers.get("stripe-signature") || "", env.STRIPE_TEST_WEBHOOK_SECRET);
    if (!v.ok) return reply({ error: "ogiltig signatur" }, 400);
    const ev = v.event, obj = ev.data && ev.data.object;
    const orderId = obj && typeof obj.client_reference_id === "string" ? obj.client_reference_id : "";
    if (!ORDER_ID_RE.test(orderId)) return reply({ ok: true, ignored: "ingen_order" });
    try {
      if (ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") {
        const r = await orderCall(env, orderId, "/paid", { session: obj, eventId: ev.id, mode: "test", viaTestHook: true, now: Date.now() });
        if (r.status === 404) return reply({ ok: true, ignored: "okand_order" });
        if (r.status === 422) return reply({ ok: false, error: "betalning_ogiltig", reason: r.json.reason }, 400);
        if (r.status >= 500) return reply({ ok: false }, 500);
        return reply({ ok: true, dup: !!r.json.dup });
      }
      if (ev.type === "checkout.session.expired" || ev.type === "checkout.session.async_payment_failed") {
        const r = await orderCall(env, orderId, "/checkout-expired", { sessionId: obj.id, eventId: ev.id, viaTestHook: true, now: Date.now() });
        if (r.status >= 500) return reply({ ok: false }, 500);
        return reply({ ok: true });
      }
    } catch { return reply({ ok: false }, 500); }
    return reply({ ok: true, ignored: "typ" });
  }

  // ---- D14: Resend-leveranshändelser (server→server, Svix-signerad, ingen Origin). STÄNGD utan COMPARE_MAIL_WEBHOOK_SECRET. ----
  // Svaret 2xx betyder bara "mottagen/bearbetad"; leveransbevis ligger i orderns utkorg. Tillfälliga fel ⇒ 5xx så att Resend återför; permanenta ⇒ 4xx/200 utan ändring.
  if (path === "/compare/mail-events") {
    if (request.method !== "POST") return reply({ error: "Not found" }, 404);
    const cfg = mailEventsConfig(env);
    if (!compareEnabled(env) || !bindingsOk(env) || !cfg.on) return reply({ error: "stängd" }, 503);
    const raw = await request.text();
    if (raw.length > MAIL_EVENT_MAX_BYTES) return reply({ error: "för stor" }, 413);
    const v = await verifyResendWebhook(raw, request.headers, cfg.secret);
    if (!v.ok) return reply({ error: "ogiltig signatur" }, 400);
    const e = normalizeMailEvent(v.event);
    if (!e.ok) return reply({ ok: false, error: "form" }, 400);
    if (e.ignore) return reply({ ok: true, ignored: e.ignore });
    const tagInfo = e.tag ? parseMailId(e.tag) : null;
    let idx;
    try { idx = await budget.mailrefGet(env, { emailId: e.emailId }); } catch { idx = undefined; } // undefined = tillfälligt fel; null = okänt ID
    if (tagInfo && idx && (idx.orderId !== tagInfo.orderId || idx.mailId !== tagInfo.mailId)) return reply({ ok: true, ignored: "koppling_motstrider" });
    const target = tagInfo || (idx ? { orderId: idx.orderId, mailId: idx.mailId } : null);
    if (!target) return idx === undefined ? reply({ ok: false }, 503) : reply({ ok: true, ignored: "ingen_koppling" });
    if (!ORDER_ID_RE.test(target.orderId)) return reply({ ok: true, ignored: "koppling_motstrider" });
    try {
      const r = await orderCall(env, target.orderId, "/mail-event", { event: e, eventId: v.eventId, mailId: target.mailId, now: Date.now() });
      if (r.status === 404) return reply({ ok: true, ignored: "okand_order" });
      if (r.status === 422) return reply({ ok: true, ignored: "koppling" });
      if (r.status >= 500) return reply({ ok: false }, 500);
      return reply({ ok: true, ...(r.json && r.json.dup ? { dup: true } : {}), ...(r.json && r.json.ignored ? { ignored: r.json.ignored } : {}), ...(r.json && r.json.state ? { state: r.json.state } : {}) });
    } catch { return reply({ ok: false }, 500); }
  }

  // ---- Bokförings-/refundexport (skyddad; aldrig offertinnehåll eller e-post) ----
  if (path === "/compare/admin/ledger" && request.method === "GET") {
    const tok = String(env.COMPARE_ADMIN_TOKEN || "");
    const given = (request.headers.get("authorization") || "").replace(/^Bearer /, "");
    if (tok.length < 24 || !compareEnabled(env) || !bindingsOk(env) || !timingSafeEqual(tok, given)) return reply({ error: "Not found" }, 404);
    const month = url.searchParams.get("month") || "";
    if (!/^\d{4}-\d{2}$/.test(month)) return reply({ error: "month=YYYY-MM krävs" }, 400);
    let ids = [];
    try { ids = await budget.ledgerList(env, { month }); } catch { return reply({ error: "Tillfälligt fel." }, 503); }
    const rows = [];
    const mode = paymentsMode(env);
    const testOnly = url.searchParams.get("test") === "only"; // ordinarie export utesluter testordrar; ?test=only = explicit test-diagnostik
    for (const oid of ids) {
      if (!ORDER_ID_RE.test(oid)) continue;
      const r = await orderCall(env, oid, "/ledger-export", { mode, testOnly, now: Date.now() });
      if (r.status === 200 && r.json.row) rows.push(r.json.row);
    }
    if (url.searchParams.get("format") === "csv") {
      const cols = [...(testOnly ? ["test"] : []),"orderId", "agreementId", "paidAt", "amountOre", "currency", "vatPct", "vatOre", "stripeSessionId", "stripePaymentIntentId", "orderStatus", "refundState", "refundId", "refundProviderStatus", "withdrawalAt", "withdrawalOutcome", "source", "retentionClass"];
      const esc = (v) => { const t = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
      const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
      return new Response(csv, { status: 200, headers: { ...headers, "content-type": "text/csv; charset=utf-8" } });
    }
    return reply({ ok: true, month, count: rows.length, rows, note: "Ingen utbetalning/bankinsättning är avstämd här (settlement.status = ej_avstamt)." });
  }

  // ---- Retention-svep (skyddad): kör den verkliga rensningen för en månads (eller ett begränsat månadsintervalls) poster. Utan fullständig policy görs ingenting. ----
  // Detta ÄR schemaläggningen inom befintliga bindningar: en människa/befintlig rutin anropar rutten (+ lazy rensning vid åtkomst). Ingen cron/ny resurs.
  const adminOk = () => { const tok = String(env.COMPARE_ADMIN_TOKEN || ""); const given = (request.headers.get("authorization") || "").replace(/^Bearer /, ""); return !(tok.length < 24 || !compareEnabled(env) || !bindingsOk(env) || !timingSafeEqual(tok, given)); };
  // ---- D16-R2: admin-testorder (samma DO/pott som skarp trafik; ADMIN_TOKEN + testChain krävs; högst 2 per 48 h). Betalning enbart via Stripe TEST-adaptern. ----
  if (path === "/compare/admin/test-order" && request.method === "POST") {
    if (!adminOk() || !testChain(env).on) return reply({ error: "Not found" }, 404);
    const cfg = budgetConfig(env);
    const cap = await budget.capacity(env, { caps: { joint: cfg.month, scope: cfg.paid }, scope: "paid" });
    if (!cap.ok || cap.halted || cap.remaining <= 0) return reply({ error: "Potten är full." }, 503);
    // D17 testkedja: samma adminskyddade väg, valfritt {kind:"check"} ⇒ EN syntetisk förkontrollsorder. Oförändrat tak (2 per 48 h), fast mottagare, ingen ny auth.
    const tb = await readJson(request, 500); const tkind = tb.value && typeof tb.value === "object" ? tb.value.kind : undefined;
    if (tb.tooLarge || (tkind !== undefined && tkind !== "check")) return reply({ error: "Ogiltig begäran." }, 400);
    const tCheck = tkind === "check"; if (tCheck && consentPolicy(env) !== "P") return reply({ error: "Förkontrollen kräver policy P." }, 503);
    const ck = "cmptest:count"; const n = Number(await env.REVIEWS_KV.get(ck)) || 0;
    if (n >= 2) return reply({ error: "Testtaket (2 per 48 h) är nått." }, 429);
    await env.REVIEWS_KV.put(ck, String(n + 1), { expirationTtl: 172800 });
    const id = newOrderId(), token = newAccessToken();
    const r = await orderCall(env, id, "/create", { id, tokenHash: await sha256Hex(token), labels: offerLabels(tCheck ? ["Testbygg Förkontroll"] : ["Testbygg Ett", "Testbygg Två"], tCheck ? 1 : 2), docCount: tCheck ? 1 : 2, ...(tCheck ? { kind: "check" } : {}), test: true, accept: { sameJob: true, at: Date.now(), offer: OFFER.version }, now: Date.now() });
    if (r.status !== 200 || !r.json.ok) return reply({ error: "Kunde inte skapa testorder." }, 503);
    return reply({ ok: true, orderId: id, token, test: true, to: TEST_CHAIN_TO }, 201);
  }
  const trm = path.match(/^\/compare\/admin\/test-order\/([^/]+)\/report-mail$/);
  if (trm && request.method === "POST") {
    if (!adminOk() || !testChain(env).on || !ORDER_ID_RE.test(trm[1])) return reply({ error: "Not found" }, 404);
    const r = await orderCall(env, trm[1], "/report-mail", { testAdmin: true, now: Date.now() });
    if (r.status === 404) return reply({ error: "Not found" }, 404);
    if (r.status === 409) return reply({ error: "Testordern är inte levererad." }, 409);
    if (r.status === 410) return reply({ error: "Rapporten har gått ut." }, 410);
    if (r.status !== 200 || !r.json.ok) return reply({ error: "Kunde inte köa mejlet." }, 503);
    return reply({ ok: true, queued: !!r.json.queued, state: r.json.state || null, to: TEST_CHAIN_TO });
  }
  // ---- D17-R2: ny avläsning på SAMMA redan betalda TEST-förkontrollorder (ADMIN + fullständig orderkey). Ingen ny order/betalning/capreset. ----
  const trc = path.match(/^\/compare\/admin\/test-order\/([^/]+)\/recheck$/);
  if (trc && request.method === "POST") {
    if (!adminOk() || !testChain(env).on || !ORDER_ID_RE.test(trc[1])) return reply({ error: "Not found" }, 404);
    const rb = await readJson(request, LIMITS.maxTextChars + 2_000);
    const rtok = rb.value && rb.value.token;
    if (rb.tooLarge || typeof rtok !== "string" || !TOKEN_RE.test(rtok)) return reply({ error: "Ogiltig begäran." }, 400);
    // text (valfri): strikt återinläggning av EXAKT samma ursprungstext för en ny AI-avläsning; DO jämför mot orderns bevarade digest (ingen annan fil släpps in).
    const rtext = rb.value.text;
    if (rtext !== undefined && (typeof rtext !== "string" || !rtext.trim() || rtext.length > LIMITS.maxTextChars)) return reply({ error: "Ogiltig begäran." }, 400);
    const rcfg = budgetConfig(env);
    const rcap = await budget.capacity(env, { caps: { joint: rcfg.month, scope: rcfg.paid }, scope: "paid" });
    if (!rcfg.ok || !rcap.ok || rcap.halted || rcap.remaining <= 0) return reply({ error: "Potten räcker inte." }, 503);
    const rr = await orderCall(env, trc[1], "/recheck", { tokenHash: await sha256Hex(rtok), testAdmin: true, ...(rtext !== undefined ? { text: rtext } : {}), now: Date.now() });
    if (rr.status === 404) return reply({ error: "Not found" }, 404);
    if (rr.status === 403) return reply({ error: "Bara testorder." }, 403);
    if (rr.status === 409) return reply({ error: rr.json && rr.json.error === "pagar" ? "Ny avläsning pågår redan." : rr.json && /^digest/.test(rr.json.error || "") ? "Texten är inte exakt den ursprungliga (digest)." : "Testordern är inte en levererad förkontroll.", reason: rr.json && rr.json.error }, 409);
    if (rr.status === 410) return reply({ error: "Rapporten har gått ut." }, 410);
    if (rr.status === 429) return reply({ error: "Gränsen för ny avläsning är nådd." }, 429);
    if (rr.status === 503) return reply({ error: "Ny avläsning är inte tillgänglig." }, 503);
    if (rr.status !== 200 || !rr.json.ok) return reply({ error: "Kunde inte starta ny avläsning." }, 502);
    return reply({ ok: true, already: !!rr.json.already, revision: rr.json.revision || 1, aiRead: !!rr.json.aiRead, queued: !!rr.json.queued, mail: rr.json.mail || null, to: TEST_CHAIN_TO, test: true });
  }
  const tcm = path.match(/^\/compare\/admin\/test-order\/([^/]+)\/checkout$/);
  if (tcm && request.method === "POST") {
    if (!adminOk() || !testChain(env).on || !ORDER_ID_RE.test(tcm[1])) return reply({ error: "Not found" }, 404);
    const id = tcm[1];
    const body = await readJson(request, 2_000);
    const token = body.value && body.value.token;
    if (typeof token !== "string" || token.length < 16) return reply({ error: "Ogiltig begäran." }, 400);
    const tokenHash = await sha256Hex(token);
    const kr = await orderCall(env, id, "/internal", { now: Date.now() }); // produktslag styr text/hash/produkt (som i den publika kassan)
    const tk = kr.status === 200 && kr.json.order && kr.json.order.kind === "check" ? "check" : undefined;
    const snap = consentSnapshot(env, tk), hash = await consentHash(env, tk);
    const acc = snap.policy === "P" ? { terms: true, declaration: true } : { terms: true, immediateDelivery: true };
    const ac = await orderCall(env, id, "/accept", { tokenHash, testAdmin: true, accept: { ...acc, consentHash: hash, consentVersion: snap.consentVersion, contactEmail: TEST_CHAIN_TO, draft: snap.draft, offerVersion: snap.offerVersion, priceOre: snap.priceOre, currency: snap.currency }, now: Date.now() });
    if (ac.status !== 200) return reply({ error: "Testordern kan inte betalas i det här läget.", reason: ac.json && ac.json.error }, ac.status === 404 ? 404 : 409);
    const begin = await orderCall(env, id, "/checkout-begin", { tokenHash, consentHash: hash, testAdmin: true, now: Date.now() });
    if (begin.status !== 200) return reply({ error: "Testordern kan inte betalas i det här läget.", reason: begin.json && begin.json.error }, 409);
    if (begin.json.reuse) return reply({ ok: true, url: begin.json.reuse.url, test: true });
    const cfg = budgetConfig(env);
    const cap = await budget.capacity(env, { caps: { joint: cfg.month, scope: cfg.paid }, scope: "paid" });
    const need = begin.json.order && begin.json.order.estimateMicro;
    if (!cap.ok || cap.halted || cap.remaining <= 0 || (Number.isFinite(need) && cap.remaining < need)) return reply({ error: "Potten räcker inte." }, 503);
    let sess; try { sess = await createCheckoutSession(testStripeEnv(env), begin.json.snapshot, { returnUrl: returnUrl(env, allowedOrigins) }); } catch { return reply({ error: "Teststripe kunde inte starta." }, 502); }
    const set = await orderCall(env, id, "/checkout-set", { tokenHash, testAdmin: true, session: sess, now: Date.now() });
    if (set.status !== 200 || !set.json.ok) return reply({ error: "Teststripe kunde inte sparas." }, 502);
    return reply({ ok: true, url: set.json.url, test: true });
  }
  if (path === "/compare/admin/retention-sweep" && request.method === "POST") {
    if (!adminOk()) return reply({ error: "Not found" }, 404);
    if (!retentionPolicy(env).ok) return reply({ ok: true, ran: false, reason: "policy_saknas", note: "Retention-längder för avtal och bokföring är inte fastställda; inget raderas." });
    const MR = /^(\d{4})-(\d{2})$/;
    const one = url.searchParams.get("month"), from = url.searchParams.get("from") || one, to = url.searchParams.get("to") || one;
    const fm = MR.exec(from || ""), tm = MR.exec(to || "");
    if (!fm || !tm) return reply({ error: "month=YYYY-MM eller from=YYYY-MM&to=YYYY-MM krävs" }, 400);
    const months = []; { let y = +fm[1], m = +fm[2]; const ey = +tm[1], em = +tm[2]; while ((y < ey || (y === ey && m <= em)) && months.length <= 24) { months.push(`${y}-${String(m).padStart(2, "0")}`); m++; if (m > 12) { m = 1; y++; } } }
    if (months.length === 0 || months.length > 24) return reply({ error: "Intervallet måste vara 1–24 månader." }, 400);
    const out = { ok: true, ran: true, months, checked: 0, purged: 0, stripped: 0, held: {}, errors: 0 };
    if (months.length === 1) out.month = months[0];
    for (const month of months) {
      let ids = [];
      try { ids = await budget.ledgerList(env, { month }); } catch { return reply({ error: "Tillfälligt fel." }, 503); }
      for (const oid of ids) {
        if (!ORDER_ID_RE.test(oid)) continue;
        const r = await orderCall(env, oid, "/retention-sweep", { now: Date.now() });
        out.checked++;
        if (r.status !== 200 || !r.json.ok) { if (r.status !== 404) out.errors++; continue; }
        if (r.json.purged) out.purged++; else if (r.json.stripped) out.stripped++; else if (r.json.action === "hallen") out.held[r.json.reason] = (out.held[r.json.reason] || 0) + 1;
      }
    }
    return reply(out);
  }
  // Manuell slutmarkör: människan har avslutat den manuella ångerprövningen. Sätter bara markören (ingen bedömning, ingen retention-policy).
  if (path === "/compare/admin/retention-close-review" && request.method === "POST") {
    if (!adminOk()) return reply({ error: "Not found" }, 404);
    const body = await readJson(request, 2_000);
    const oid = body.value && body.value.orderId;
    if (typeof oid !== "string" || !ORDER_ID_RE.test(oid)) return reply({ error: "orderId krävs" }, 400);
    const r = await orderCall(env, oid, "/retention-close-review", { now: Date.now(), note: body.value.note });
    if (r.status === 404) return reply({ error: "Not found" }, 404);
    if (r.status !== 200) return reply({ error: "Tillfälligt fel." }, 503);
    return reply(r.json, r.json.ok ? 200 : 409);
  }

  // ---- Config (öppen, ingen hemlighet) ----
  if (path === "/compare/config" && request.method === "GET") return reply(await publicConfig(env, allowedOrigins));

  if (!compareEnabled(env) || !bindingsOk(env)) return closed();

  // ---- Ångra via ångerlänk (token ur avtalsbekräftelsen) ----
  if (path === "/compare/withdraw" && request.method === "POST") {
    if (!originOk) return reply({ error: "Otillåten källa." }, 403);
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const rlb = env.COMPARE_RL || env.REVIEW_RL;
    if (rlb) { try { const { success } = await rlb.limit({ key: "w:" + ip }); if (!success) return reply({ error: "För många försök just nu. Vänta en stund." }, 429); } catch { /* bindning nere */ } }
    const body = await readJson(request, 2_000);
    const pt = body.value && parseWithdrawToken(body.value.token);
    if (!pt) return reply({ error: "Ångerlänken stämmer inte." }, 404);
    const r = await orderCall(env, pt.orderId, "/withdraw", { via: "token", secret: pt.secret, now: Date.now() });
    if (r.status === 404) return reply({ error: "Ångerlänken stämmer inte." }, 404);
    if (r.status === 410) return reply({ error: "Avtalet är arkiverat och kan inte ångras här. Kontakta säljaren." }, 410);
    if (r.status !== 200 || !r.json.ok) return reply({ error: "Tillfälligt fel. Försök igen." }, 503);
    return reply({ ok: true, duplicate: !!r.json.duplicate, withdrawal: r.json.withdrawal });
  }

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
    const isCheck = b.kind === "check"; // D17 Förkontroll av min offert: EN egen offert, samma pris, egen produkt
    if (b.kind !== undefined && !isCheck) return reply({ error: "Ogiltig förfrågan." }, 400);
    if (isCheck && !checkAvailable(env)) return closed();
    const docCount = isCheck ? 1 : b.docCount;
    if (isCheck ? b.docCount !== undefined && b.docCount !== 1 : (!Number.isInteger(docCount) || docCount < OFFER.minDocs || docCount > OFFER.maxDocs)) return reply({ error: isCheck ? "Förkontrollen gäller en offert." : `Välj ${OFFER.minDocs}–${OFFER.maxDocs} offerter.` }, 400);
    const a = b.accept || {};
    if (a.sameJob !== true) return reply({ error: isCheck ? "Du behöver bekräfta att offerten är din egen." : "Du behöver bekräfta att offerterna gäller samma jobb.", needAccept: true }, 400);
    const cfg = budgetConfig(env);
    const cap = await budget.capacity(env, { caps: { joint: cfg.month, scope: cfg.paid }, scope: "paid" });
    if (!cap.ok || cap.halted || cap.remaining <= 0) return reply({ error: "Jämförelsen är tillfälligt full. Försök igen senare." }, 503);
    const c = await budget.countToday(env, { name: "orders", limit: cfg.dayOrders });
    if (!c.ok) return reply({ error: "Dagens platser är slut. Försök igen i morgon." }, 429);
    const id = newOrderId();
    const token = newAccessToken();
    const labels = offerLabels(isCheck ? ["Din offert"] : Array.isArray(b.labels) ? b.labels : [], docCount);
    const r = await orderCall(env, id, "/create", { id, tokenHash: await sha256Hex(token), labels, docCount, ...(isCheck ? { kind: "check" } : {}), accept: { sameJob: true, at: Date.now(), offer: OFFER.version }, now: Date.now() });
    if (r.status !== 200 || !r.json.ok) return reply({ error: "Det gick inte att starta just nu." }, 503);
    return reply({ ok: true, orderId: id, token, order: r.json.order }, 201);
  }

  // ---- D11 förköpsidentitet: POST /compare/orders/:id/preid {idx} – EN AI-läsning av utställaren per offert, användarstartad, reserverad i gemensamma potten ----
  const pidm = path.match(/^\/compare\/orders\/(o_[0-9a-f]{32})\/preid$/);
  if (pidm && request.method === "POST") {
    const oid = pidm[1];
    const tok = request.headers.get("x-order-token") || "";
    if (!TOKEN_RE.test(tok)) return reply({ error: "Ordern hittades inte." }, 404);
    if (!originOk) return reply({ error: "Otillåten källa." }, 403);
    if (!bindingsOk(env)) return closed();
    const pc = preidConfig(env);
    if (!pc.on) return reply({ error: "Förköpsläsningen är inte öppen." }, 503);
    const th = await sha256Hex(tok);
    const body = await readJson(request, 500);
    const idx = body.value && body.value.idx;
    if (body.tooLarge || body.bad || !Number.isInteger(idx) || idx < 0 || idx > 3) return reply({ error: "Ogiltig förfrågan." }, 400);
    const bc = budgetConfig(env);
    if (!bc.ok || !env.ANTHROPIC_API_KEY) return reply({ error: "Läsningen är inte tillgänglig just nu." }, 503);
    const ctx = await preidCtx(pc.model);
    const proposalsOf = async () => {
      const g = await orderCall(env, oid, "/preid-get", { tokenHash: th, ctx, now: Date.now() });
      if (g.status !== 200 || !g.json.ok) return null;
      return preidProposals(g.json.docCount, g.json.records);
    };
    const cl = await orderCall(env, oid, "/preid-claim", { tokenHash: th, idx, ctx, now: Date.now() });
    if (cl.status === 404) return reply({ error: "Ordern hittades inte." }, 404);
    if (cl.status === 409) return reply({ error: cl.json && cl.json.error === "pagar" ? "Läsningen pågår redan." : "Ordern kan inte läsas av just nu." }, 409);
    if (cl.status === 429) return reply({ error: "Gränsen för förköpsläsning är nådd för den här offerten." }, 429);
    if (cl.status !== 200 || !cl.json.ok) return reply({ error: "Ogiltig förfrågan." }, cl.status === 400 ? 400 : 502);
    if (cl.json.cached) return reply({ ok: true, proposals: await proposalsOf() });
    const { claimId } = cl.json;
    const put = (identity) => orderCall(env, oid, "/preid-put", { tokenHash: th, idx, claimId, ctx, identity, now: Date.now() });
    const putOk = (r) => r.status === 200 && r.json && r.json.ok === true;
    const doc = await env.REVIEWS_KV.get(cl.json.doc.key, "json");
    if (!doc) { await put(null); return reply({ error: "Offerten finns inte kvar. Ladda upp den igen." }, 410); }
    const model = pc.model;
    const request2 = buildPreidRequest({ model, doc });
    let res;
    try {
      // Budgetnyckeln bär det unika claimId: varje faktisk generation reserveras/avräknas under egen nyckel, aldrig återanvänd (även vid filbyte/omförsök).
      res = await guardedCall({ env, io: { fetch: (u, i) => fetch(u, i), now: () => Date.now() }, key: `pid:${oid}:${claimId}`, orderId: oid, scope: "paid", inputTokens: cl.json.doc.tokens + 600, body: request2, model, caps: { joint: bc.month, scope: bc.paid, order: Math.min(bc.order, pc.capMicro) }, signalMs: 45_000 });
    } catch (e) {
      await put(null);
      if (e instanceof Stop) return reply({ error: "Läsningen är pausad just nu (kostnadsgräns). Det påverkar inte din jämförelse." }, 503);
      throw e;
    }
    if (res.error) { await put(null); return reply({ error: "Läsningen misslyckades just nu. Försök igen om en stund." }, 502); }
    let identity = null;
    try { identity = sanitizePreid(readPreid(res.json)); } catch { identity = null; }
    const pr = await put(identity);
    if (!putOk(pr)) return reply({ error: "Offerten ändrades under läsningen. Läs av igen." }, 409); // ersatt claim/fil: det sena resultatet används aldrig (kostnaden är ändå avräknad)
    if (!identity) return reply({ error: "Företagsuppgifterna kunde inte läsas ur offerten." }, 502);
    return reply({ ok: true, proposals: await proposalsOf() });
  }

  // ---- D07: källor för senaste omdömen (avstängda om inte COMPARE_REVIEWS + COMPARE_REVIEWS_VERIFIED) ----
  const sm = path.match(/^\/compare\/orders\/(o_[0-9a-f]{32})\/sources(?:\/(firms|google\/search|google\/mount|google\/confirm|google\/render|trustpilot\/search|trustpilot\/confirm|trustpilot\/latest|unconfirm|identity))?$/);
  if (sm) {
    const oid = sm[1], ssub = sm[2] || "";
    const tok = request.headers.get("x-order-token") || "";
    if (!TOKEN_RE.test(tok)) return reply({ error: "Ordern hittades inte." }, 404);
    const th = await sha256Hex(tok);
    const mut = request.method !== "GET";
    if (mut && !originOk) return reply({ error: "Otillåten källa." }, 403);
    if (!bindingsOk(env)) return closed();
    const cfgS = sourcesConfig(env);
    const body = mut ? await readJson(request, 4_000) : { value: {} };
    if (body.tooLarge || body.bad) return reply({ error: "Ogiltig förfrågan." }, 400);
    const bv = body.value || {};
    const op = async (o) => orderCall(env, oid, "/sources-op", { tokenHash: th, op: o, now: Date.now() });
    const out = (r) => (r.status === 404 ? reply({ error: "Ordern hittades inte." }, 404) : r.status === 429 ? reply({ error: "Gränsen för källsökningar för den här ordern är nådd." }, 429) : r.status === 409 ? reply({ error: "Ordern är raderad." }, 409) : r.status !== 200 || !r.json.ok ? reply({ error: r.json && r.json.error === "okand_traff" ? "Den träffen finns inte bland förslagen. Sök igen." : r.json && r.json.error === "sok_forst" ? "Sök först firman hos Google." : r.json && r.json.error === "bekrafta_profil" ? "Bekräfta först att profilen som visas är rätt firma." : "Ogiltig förfrågan." }, 400) : null);
    if (!ssub && request.method === "GET") {
      const r = await orderCall(env, oid, "/sources-get", { tokenHash: th, countView: true, now: Date.now() });
      const e = out(r); if (e) return e;
      return reply({ ok: true, sources: r.json.sources });
    }
    if (ssub === "identity" && request.method === "GET") {
      const auth = await orderCall(env, oid, "/sources-get", { tokenHash: th, now: Date.now() });
      const ea = out(auth); if (ea) return ea;
      const gi = await orderCall(env, oid, "/internal", { now: Date.now() });
      const oo = gi.status === 200 && gi.json.order;
      if (oo && ["ready", "awaiting_payment"].includes(oo.status) && preidConfig(env).on) { // förköp: förslag ur redan lästa utställaruppgifter (inget nytt anrop)
        const g = await orderCall(env, oid, "/preid-get", { tokenHash: th, ctx: await preidCtx(preidConfig(env).model), now: Date.now() });
        if (g.status === 200 && g.json.ok) return reply({ ok: true, proposals: preidProposals(g.json.docCount, g.json.records), stage: "forkop", read: Object.values(g.json.records).filter((r) => r.state === "done").length });
      }
      if (!oo || oo.status !== "delivered" || !oo.reportKey) return reply({ error: "Rapporten är inte klar.", status: oo ? oo.status : null }, 409);
      const rep = await env.REVIEWS_KV.get(oo.reportKey, "json");
      if (!rep) return reply({ error: "Rapporten har gått ut och är raderad.", expired: true }, 410);
      return reply({ ok: true, proposals: identityProposals(rep) });
    }
    if (ssub === "firms" && request.method === "PUT") {
      const r = await op({ type: "set_firms", firms: Array.isArray(bv.firms) ? bv.firms.map((f) => ({ offerIndex: f && f.offerIndex, name: f && f.name, city: f && f.city, domain: f && f.domain, origin: f && f.origin })) : [] });
      if (r.status === 400 && r.json && r.json.error === "domain") return reply({ error: "Webbadressen ser inte rätt ut. Skriv bara t.ex. foretaget.se." }, 400);
      if (r.status === 400 && r.json && r.json.error === "for_manga") return reply({ error: "Högst fyra firmor." }, 400);
      const e = out(r); if (e) return e;
      return reply({ ok: true, sources: r.json.sources });
    }
    if (!cfgS.active && ssub) return reply({ error: "Omdömen visas inte i den här versionen." }, 503);
    const g = await orderCall(env, oid, "/sources-get", { tokenHash: th, now: Date.now() });
    const ge = out(g); if (ge) return ge;
    const firm = (g.json.state.firms || []).find((f) => f.id === bv.firmId);
    if (!firm && ssub !== "firms") return reply({ error: "Firman hittades inte. Ladda om sidan." }, 404);
    if (ssub === "google/search" && request.method === "POST") {
      if (!cfgS.google.on) return reply({ error: "Googles omdömen visas inte i den här versionen." }, 503);
      if (firm.google.searches >= SRC_LIM.searchesPerFirm) return reply({ error: "Du har sökt så många gånger du kan för den här firman." }, 429);
      if (!cfgS.google.search) { // native UI Kit-sök i webbläsaren: servern räknar bara budget/gränser innan kunden får köra Googles eget sökelement
        const gate = await nativeSearchGate(env, cfgS);
        const rec = await op({ type: "record_search", firmId: firm.id, provider: "google", outcome: gate.outcome, candidateIds: [] });
        const e = out(rec); if (e) return e;
        return reply({ ok: true, native: true, outcome: gate.outcome, allowed: gate.outcome === "nativ", candidates: [], sources: rec.json.sources });
      }
      const r = await googleCandidates(env, cfgS, firm, { orderId: oid });
      const rec = await op({ type: "record_search", firmId: firm.id, provider: "google", outcome: r.outcome, candidateIds: r.candidates.map((c) => c.id) });
      const e = out(rec); if (e) return e;
      return reply({ ok: true, outcome: r.outcome, candidates: r.candidates, sources: rec.json.sources });
    }
    if (ssub === "google/mount" && request.method === "POST") {
      if (!cfgS.google.on) return reply({ error: "Googles omdömen visas inte i den här versionen." }, 503);
      const kind = bv.kind === "search" || bv.kind === "details" ? bv.kind : null;
      if (!kind || typeof bv.mountId !== "string") return reply({ error: "Ogiltig förfrågan." }, 400);
      const res = await reserveMount(env, cfgS, { kind, mountId: bv.mountId, firmId: firm.id, op });
      if (res.httpStatus === 404) return reply({ error: "Ordern hittades inte." }, 404);
      if (res.outcome === "ogiltig") return reply({ error: "Ogiltig förfrågan." }, 400);
      if (res.outcome === "fel") return reply({ error: "Tillfälligt fel." }, 503);
      return reply({ ok: true, allowed: res.allowed, outcome: res.outcome, kind });
    }
    if (ssub === "google/render" && request.method === "POST") {
      if (!cfgS.google.on) return reply({ error: "Googles omdömen visas inte i den här versionen." }, 503);
      const r = await op({ type: "google_render", firmId: firm.id, outcome: bv.outcome === "ok" ? "ok" : bv.outcome === "fel" ? "fel" : "" });
      const e = out(r); if (e) return e;
      return reply({ ok: true, sources: r.json.sources });
    }
    if (ssub === "google/confirm" && request.method === "POST") {
      if (!cfgS.google.on) return reply({ error: "Googles omdömen visas inte i den här versionen." }, 503);
      if (typeof bv.placeId !== "string" || !PLACE_ID_RE.test(bv.placeId)) return reply({ error: "Ogiltigt företags-ID." }, 400);
      const r = await op({ type: "confirm_google", firmId: firm.id, placeId: bv.placeId, via: bv.via, seen: bv.seen === true });
      const e = out(r); if (e) return e;
      return reply({ ok: true, sources: r.json.sources });
    }
    if (ssub === "trustpilot/search" && request.method === "POST") {
      if (!cfgS.trustpilot.on) return reply({ error: "Trustpilot visas inte i den här versionen." }, 503);
      if (firm.trustpilot.searches >= SRC_LIM.searchesPerFirm) return reply({ error: "Du har sökt så många gånger du kan för den här firman." }, 429);
      const r = await tpCandidates(env, cfgS, firm, {});
      if (r.needDomain) return reply({ ok: true, outcome: "tomt", needDomain: true, candidates: [], sources: g.json.sources });
      const rec = await op({ type: "record_search", firmId: firm.id, provider: "trustpilot", outcome: r.outcome, candidateIds: r.candidates.map((c) => c.id) });
      const e = out(rec); if (e) return e;
      return reply({ ok: true, outcome: r.outcome, candidates: r.candidates, sources: rec.json.sources });
    }
    if (ssub === "trustpilot/confirm" && request.method === "POST") {
      if (!cfgS.trustpilot.on) return reply({ error: "Trustpilot visas inte i den här versionen." }, 503);
      const r = await op({ type: "confirm_trustpilot", firmId: firm.id, buId: String(bv.buId || "") });
      const e = out(r); if (e) return e;
      return reply({ ok: true, sources: r.json.sources });
    }
    if (ssub === "trustpilot/latest" && request.method === "POST") {
      if (!cfgS.trustpilot.on) return reply({ error: "Trustpilot visas inte i den här versionen." }, 503);
      if (!firm.trustpilot.buId) return reply({ error: "Bekräfta först rätt firma hos Trustpilot." }, 409);
      const r = await tpLatest(env, cfgS, { buId: firm.trustpilot.buId, domain: firm.domain });
      await op({ type: "tp_outcome", firmId: firm.id, outcome: r.outcome === "ok" ? "ok" : r.outcome });
      if (r.outcome === "ok" || r.outcome === "tomt") return reply({ ok: true, outcome: r.outcome, card: r.card, fetchedAt: r.fetchedAt, fromCache: !!r.fromCache });
      return reply({ ok: true, outcome: r.outcome, card: null }); // kallfel/kostnadsstopp: aldrig "inga omdömen"
    }
    if (ssub === "unconfirm" && request.method === "POST") {
      if (bv.provider !== "google" && bv.provider !== "trustpilot") return reply({ error: "Ogiltig förfrågan." }, 400);
      const r = await op({ type: "unconfirm", firmId: firm.id, provider: bv.provider });
      const e = out(r); if (e) return e;
      return reply({ ok: true, sources: r.json.sources });
    }
    return reply({ error: "Not found" }, 404);
  }

  // ---- Per order ----
  const m = path.match(/^\/compare\/orders\/(o_[0-9a-f]{32})(?:\/(docs\/([0-3])|checkout|report|withdraw|source-delivered|check|check\/export|close-draft))?$/);
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
    // D16-R2: testorder avstäms/återbetalas ALLTID mot Stripe TEST (testnyckel, testläge); saknas testnyckeln nekas läsningen – aldrig fallback till live.
    const isTest = g.json.testOrder === true;
    const SE = stripeEnvFor(env, isTest);
    const mode = isTest ? (SE ? "test" : null) : paymentsMode(env);
    if (g.json.reconcile && mode) {
      const mk = await orderCall(env, id, "/reconcile-mark", { tokenHash, now: Date.now() });
      const sessionId = mk.json && mk.json.sessionId;
      if (sessionId) {
        try {
          const s = await retrieveSession(SE, sessionId);
          if (s && s.status === "complete" && s.payment_status === "paid") {
            await orderCall(env, id, "/paid", { session: s, eventId: `recon:${sessionId}`, mode, ...(isTest ? { viaTestHook: true } : {}), now: Date.now() });
          } else if (s && s.status === "expired") {
            await orderCall(env, id, "/checkout-expired", { sessionId, eventId: `recon-exp:${sessionId}`, ...(isTest ? { viaTestHook: true } : {}), now: Date.now() });
          }
        } catch { /* nästa avläsning försöker igen */ }
        const g2 = await orderCall(env, id, "/get", { tokenHash, now: Date.now() });
        if (g2.status === 200) order = g2.json.order;
      }
    }
    if (g.json.refundCheck && g.json.refundCheck.refundId && mode) {
      await orderCall(env, id, "/refund-update", { mark: true, now: Date.now() });
      try {
        const rf = await retrieveRefund(SE, g.json.refundCheck.refundId);
        await orderCall(env, id, "/refund-update", { refund: rf, now: Date.now() });
      } catch { /* nästa avläsning försöker igen */ }
      const g3 = await orderCall(env, id, "/get", { tokenHash, now: Date.now() });
      if (g3.status === 200) order = g3.json.order;
    }
    return reply({ ok: true, order, pollMs: LIMITS.statusPollMinMs });
  }

  if (!sub && request.method === "DELETE") {
    const r = await orderCall(env, id, "/delete", { tokenHash, now: Date.now() });
    if (r.status === 404) return reply({ error: "Ordern hittades inte." }, 404);
    if (r.status === 409) return reply({ error: "Jämförelsen pågår. Vänta tills den är klar." }, 409);
    return reply({ ok: r.json.ok === true, order: r.json.order });
  }

  // D19 Avsluta utkastet: serverkontrollerad draft-only-radering. Vid race/aktiv kassa/betalning bevaras ordern (409) och kunden återupptar den.
  if (sub === "close-draft") {
    if (request.method !== "POST") return reply({ error: "Not found" }, 404);
    const r = await orderCall(env, id, "/close-draft", { tokenHash, now: Date.now() });
    if (r.status === 404) return reply({ error: "Ordern hittades inte." }, 404);
    if (r.status === 409) return reply({ error: "Utkastet kan inte avslutas just nu. Ordern är kvar och du kan fortsätta med den.", kept: true, reason: r.json.reason, order: r.json.order }, 409);
    if (r.status !== 200 || !r.json.ok) return reply({ error: "Tillfälligt fel. Ordern är kvar." }, 503);
    return reply({ ok: true, closed: true, order: r.json.order });
  }

  // D17 Förkontroll: bekräftelser (revisioner), tilläggstexter och PDF-bilaga. Kräver orderns FULLA åtkomstnyckel (resultatlänkens token räcker aldrig).
  if (sub === "check" || sub === "check/export") {
    if (!bindingsOk(env)) return closed();
    const call = (p, extra = {}) => orderCall(env, id, p, { tokenHash, now: Date.now(), ...extra });
    let r;
    if (sub === "check" && request.method === "GET") r = await call("/check-get");
    else if (sub === "check" && request.method === "PUT") { const bi = await readJson(request, 6_000); if (!bi.value || typeof bi.value !== "object") return reply({ error: "Ogiltig begäran." }, 400); r = await call("/check-save", { values: bi.value.values }); }
    else if (sub === "check/export" && request.method === "POST") { const bi = await readJson(request, 500); r = await call("/check-export", { revision: bi.value && Number.isInteger(bi.value.revision) ? bi.value.revision : null }); }
    else return reply({ error: "Not found" }, 404);
    if (r.status === 404) return reply({ error: "Ordern hittades inte." }, 404);
    if (r.status === 409 && r.json.error === "revision_andrad") { const { ok: _o, error: _e, ...view } = r.json; return reply({ error: "En nyare revision finns. Visningen uppdateras – hämta PDF:en igen.", revisionChanged: true, ...view }, 409); }
    if (r.status === 409) return reply({ error: r.json.error === "inget_bekraftat" ? "Bekräfta minst en uppgift först." : "Förkontrollen är inte klar än." }, 409);
    if (r.status === 410) return reply({ error: "Förkontrollen har gått ut och är raderad (den sparas i 24 timmar)." }, 410);
    if (r.status === 429) return reply({ error: "Gränsen för bekräftelser eller exporter för den här förkontrollen är nådd." }, 429);
    if (r.status === 400) return reply({ error: r.json.message || "Ogiltig begäran." }, 400);
    if (r.status !== 200 || !r.json.ok) return reply({ error: "Tillfälligt fel. Försök igen." }, 503);
    const { ok, ...rest } = r.json; return reply({ ok: true, ...rest });
  }

  if (sub === "withdraw" && request.method === "POST") {
    const r = await orderCall(env, id, "/withdraw", { via: "order", tokenHash, now: Date.now() });
    if (r.status === 404) return reply({ error: "Det finns inget köp att ångra för den här ordern." }, 404);
    if (r.status === 410) return reply({ error: "Avtalet är arkiverat och kan inte ångras här. Kontakta säljaren." }, 410);
    if (r.status !== 200 || !r.json.ok) return reply({ error: "Tillfälligt fel. Försök igen." }, 503);
    return reply({ ok: true, duplicate: !!r.json.duplicate, withdrawal: r.json.withdrawal, order: r.json.order });
  }

  // Kvittens på att avtalad källvisning för en täckt firma faktiskt gjorts tillgänglig (policy P). Registreras bara för firmor i den frusna täckningen och bara efter levererad rapport.
  if (sub === "source-delivered" && request.method === "POST") {
    const bi = await readJson(request, 500);
    const v = bi.value || {};
    if (typeof v.firmId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v.firmId) || !["visad", "ingen_kalla"].includes(v.state)) return reply({ error: "Ogiltig begäran." }, 400);
    const r = await orderCall(env, id, "/source-delivered", { tokenHash, firmId: v.firmId, state: v.state, now: Date.now() });
    if (r.status === 404) return reply({ error: "Ordern hittades inte." }, 404);
    if (r.status !== 200 || !r.json.ok) return reply({ error: "Kan inte registreras i det här läget." }, 409);
    return reply({ ok: true });
  }

  if (sub === "report" && request.method === "GET") {
    const g = await orderCall(env, id, "/internal", { now: Date.now() });
    if (g.status !== 200 || !g.json.order) return reply({ error: "Ordern hittades inte." }, 404);
    const o = g.json.order;
    const auth = await orderCall(env, id, "/report-auth", { tokenHash, now: Date.now() }); // orderns åtkomstnyckel ELLER resultattoken från rapport-klart-mejlet (bara denna rutt)
    if (auth.status !== 200) return reply({ error: "Ordern hittades inte." }, 404);
    if (o.status !== "delivered" || !o.reportKey) return reply({ error: "Rapporten är inte klar.", status: o.status }, 409);
    const rep = await env.REVIEWS_KV.get(o.reportKey, "json");
    if (!rep) return reply({ error: "Rapporten har gått ut och är raderad.", expired: true }, 410);
    // Aktuell källstatus (offentliga kundbekräftade profiler) bredvid den frusna: samma rapportrutt, ingen ny åtkomst. PDF/mejl visar alltid den frusna revisionen.
    let live = null;
    try { const sc = await orderCall(env, id, "/source-cards", { offers: (rep.offers || []).map((x) => x.index), now: Date.now() }); if (sc.status === 200 && Array.isArray(sc.json.cards)) live = sc.json; } catch { /* frusna kortet gäller */ }
    const key = (cards) => JSON.stringify((cards || []).map((c) => [c.offerIndex, c.state, c.google && c.google.state, c.google && c.google.profileUrl, c.google && c.google.confirmedAt, c.firm && c.firm.name]));
    const changed = !!live && key(live.cards) !== key(rep.sourceCards);
    return reply({ ok: true, report: rep, ...(live ? { sourceLive: { cards: live.cards, asOf: live.asOf, changedSinceDelivery: changed, frozenAt: rep.sourcesFrozenAt || rep.createdAt } } : {}) });
  }

  if (sub === "checkout" && request.method === "POST") {
    const mode = paymentsMode(env);
    if (!mode || !acceptingOrders(env, allowedOrigins)) return closed();
    // Samtycke är bundet till version + hash av exakt de texter/priser servern visar. Med body: kunden har just sett
    // och kryssat texterna. Utan body ("betala igen"): bara ett redan givet samtycke med SAMMA hash återanvänds –
    // annars ber vi kunden läsa och godkänna igen.
    const kindR = await orderCall(env, id, "/internal", { now: Date.now() }); // produktslag (check/jämförelse) styr vilken text och hash som gäller; DO:n avgör åtkomsten
    const oKind = kindR.status === 200 && kindR.json.order && kindR.json.order.kind === "check" ? "check" : undefined;
    const snap = consentSnapshot(env, oKind);
    if (oKind === "check" && mode === "live" && snap.draft) return closed(); // förkontrollens villkor är utkast tills mänsklig fastställelse (hash-grind): ingen skarp betalning
    const hash = await consentHash(env, oKind);
    const bodyIn = await readJson(request, 2_000);
    const acc = bodyIn.value && bodyIn.value.accept;
    if (acc) {
      // Policy P: EN gemensam, aktivt vald deklaration (start direkt + ångerrätten upphör) och villkoren via köpklicket; policy Q: den gamla "start direkt"-rutan. Servern avgör policy (ur snapshoten), aldrig klienten.
      const P = snap.policy === "P";
      if (acc.terms !== true || (P ? acc.declaration !== true : acc.immediateDelivery !== true) || typeof acc.consentHash !== "string") return reply({ error: P ? "Du behöver själv markera rutan att jämförelsen börjar direkt och att ångerrätten upphör när tjänsten är helt utförd." : "Du behöver godkänna villkoren och att leveransen startar direkt.", needAccept: true }, 400);
      if (acc.consentHash !== hash || acc.consentVersion !== snap.consentVersion) return reply({ error: "Villkoren eller erbjudandet har ändrats sedan du läste dem. Läs och godkänn igen.", needAccept: true, consentChanged: true }, 409);
      if (!validEmail(acc.email)) return reply({ error: "Ange en giltig e-postadress för avtalsbekräftelsen.", needAccept: true, needEmail: true }, 400);
      const ac = await orderCall(env, id, "/accept", { tokenHash, accept: { terms: true, ...(snap.policy === "P" ? { declaration: true } : { immediateDelivery: true }), consentHash: hash, consentVersion: snap.consentVersion, contactEmail: acc.email, draft: snap.draft, offerVersion: snap.offerVersion, priceOre: snap.priceOre, currency: snap.currency }, now: Date.now() });
      if (ac.status === 404) return reply({ error: "Ordern hittades inte." }, 404);
      if (ac.status !== 200) return reply({ error: "Ordern kan inte betalas i det här läget." }, 409);
    } else {
      const st = await orderCall(env, id, "/consent-status", { tokenHash, consentHash: hash, now: Date.now() });
      if (st.status === 404) return reply({ error: "Ordern hittades inte." }, 404);
      if (!st.json.same) return reply({ error: "Läs och godkänn villkoren igen innan du betalar.", needAccept: true }, 400);
    }
    const begin = await orderCall(env, id, "/checkout-begin", { tokenHash, consentHash: hash, now: Date.now() });
    if (begin.status === 404) return reply({ error: "Ordern hittades inte." }, 404);
    if (begin.status === 409 && begin.json.error === "samtycke_andrat") return reply({ error: "Läs och godkänn villkoren igen innan du betalar.", needAccept: true }, 409);
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
    // D19: exakt binär storlek för validerad base64 (padding är inte data); taket 8 MB är oförändrat. Ogiltig base64 nekas.
    const exactBytes = kind === "text" ? null : base64ByteLength(dataBase64);
    if (kind !== "text" && exactBytes === null) return reply({ error: "Filen kunde inte läsas. Försök igen." }, 400);
    if (kind !== "text" && exactBytes > LIMITS.maxFileBytes) return reply({ error: "Filen är för stor (max 8 MB)." }, 413);
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
    // Alltid uppmätt (fail closed): ingen teckenheuristik för text, eftersom tecken/token varierar kraftigt (t.ex. CJK).
    try { tokens = await countInputTokens(env, req); } catch { return reply({ error: "Det gick inte att kontrollera filens storlek just nu. Försök igen om en stund." }, 503); }
    if (tokens > LIMITS.maxInputTokensPerDoc) return reply({ error: "Dokumentet är för omfattande. Dela upp det eller ta bara sidorna med pris och villkor.", tokens, limit: LIMITS.maxInputTokensPerDoc }, 400);
    const bytes = kind === "text" ? new TextEncoder().encode(text).length : exactBytes;
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
    // Oföränderlig nyckel (innehållets hash): en sen uppladdning kan aldrig skriva över eller radera en låst originalfil.
    // Vilken nyckel som gäller avgörs enbart av orderns manifest (DO /doc).
    const key = `cmpdoc:${id}:${idx}:${sha.slice(0, 40)}`;
    try { await env.REVIEWS_KV.put(key, JSON.stringify(doc), { expirationTtl: LIMITS.orderTtlSec }); } catch { return reply({ error: "Det gick inte att spara filen just nu." }, 503); }
    const r = await orderCall(env, id, "/doc", { tokenHash, meta: { idx, kind, bytes, tokens, pages, sha256: sha, key }, estimate: complete ? { worstMicro: estimateMicro } : null, now: Date.now() });
    if (r.status !== 200 || !r.json.ok) {
      // Radera bara den egna nya nyckeln, och aldrig en nyckel som manifestet använder (keep).
      if (r.json && r.json.keep !== key && r.status !== 500 && r.status !== 503) { try { await env.REVIEWS_KV.delete(key); } catch { /* TTL */ } }
      else if (r.status === 500 || r.status === 503) { /* oklart utfall: lämna nyckeln, TTL städar */ }
      if (r.status === 409 && r.json.error === "dubblett") return reply({ error: "Du har lagt in samma fil två gånger." }, 409);
      if (r.status === 413) return reply({ error: "Filerna är tillsammans för stora. Ta bara sidorna med pris och villkor." }, 413);
      if (r.status === 409) return reply({ error: "Ordern är låst." }, 409);
      return reply({ error: "Det gick inte att ta emot filen." }, r.status === 404 ? 404 : 503);
    }
    if (r.json.replaced && r.json.replaced !== key) { try { await env.REVIEWS_KV.delete(r.json.replaced); } catch { /* TTL */ } }
    return reply({ ok: true, order: r.json.order, doc: { idx, kind, bytes, tokens, pages } });
  }

  return reply({ error: "Not found" }, 404);
}

