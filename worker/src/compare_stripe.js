// Stripe-adapter för Jämför mina offerter (hostad Checkout, engångsköp). Inga SDK-beroenden:
// REST via fetch (injicerbar för test) och HMAC-verifiering av webhooken med Web Crypto.
//
// Stängd som standard (paymentsMode() i compare_config.js). Ingen offerttext, inget namn och
// ingen fil lämnar Workern till Stripe: bara orderns id, versionsmärkning och fast produktnamn.
//
// Betalmodell (verifierad i TESTLÄGE först): automatisk betalning + automatisk återbetalning vid
// utebliven leverans. Manuell capture är INTE implementerad (otestad, och auktoriseringsfönstret
// är begränsat); den kräver eget test innan den väljs.

import { paymentMethods, methodsKey, OFFER, CHECK_OFFER } from "./compare_config.js";
import { hmacSha256Hex, timingSafeEqual } from "./compare_util.js";

const API = "https://api.stripe.com/v1";

// Stripes formkodning: nästlade objekt som a[b][c]=v.
export function formEncode(obj, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") out.push(formEncode(v, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.filter(Boolean).join("&");
}

async function stripeFetch(env, path, { method = "GET", body, idempotencyKey, fetchImpl = fetch } = {}) {
  // Ingen fast API-version anges här: kontots standardversion gäller (att pinna en version är ett kontosteg som görs mot Stripe).
  const headers = { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` };
  if (body) headers["content-type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const resp = await fetchImpl(`${API}${path}`, { method, headers, body: body ? formEncode(body) : undefined, signal: AbortSignal.timeout(15_000) });
  let json = null;
  try { json = await resp.json(); } catch { /* ogiltigt svar */ }
  if (!resp.ok) {
    // Aldrig hela svaret (kan innehålla kunduppgifter): bara typ och kod.
    const e = new Error(`stripe ${resp.status} ${(json && json.error && json.error.code) || ""}`.trim());
    e.status = resp.status;
    throw e;
  }
  return json;
}

// Skapar hostad Checkout-session. Priset kommer från OFFER (serverkod), aldrig från anropet.
// Idempotensnyckel och kropp är bundna till ett FÖRSÖK (order.attempt) med FRUSEN utgångstid
// (order.expiresAtSec, bestäms av orderobjektet vid försökets start, inte av klockan här): samma försök
// ger alltid exakt samma parametrar, så Stripes parametermatchning aldrig slår fel. En verkligt utgången
// session får nästa försöksnummer och därmed ny nyckel.
export async function createCheckoutSession(env, order, { returnUrl, fetchImpl } = {}) {
  if (!Number.isInteger(order.attempt) || order.attempt < 1 || !Number.isInteger(order.expiresAtSec)) throw new Error("stripe: försök saknas");
  const sep = returnUrl.includes("?") ? "&" : "?";
  const pm = paymentMethods(env);
  const body = {
    mode: "payment",
    ...(pm.types ? { payment_method_types: pm.types } : {}), // dynamiskt metodval: utelämnas (Dashboard styr); annars explicit lista (kort, ev. swish – kräver SEK)
    locale: "sv",
    client_reference_id: order.id,
    success_url: `${returnUrl}${sep}order=${order.id}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${returnUrl}${sep}order=${order.id}&avbruten=1`,
    expires_at: order.expiresAtSec,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: OFFER.currency,
        unit_amount: order.kind === "check" ? CHECK_OFFER.priceOre : OFFER.priceOre,
        product_data: { name: order.kind === "check" ? CHECK_OFFER.product : `${OFFER.product} (${order.docCount} offerter)` },
      },
    }],
    metadata: { order_id: order.id, offer: order.kind === "check" ? CHECK_OFFER.version : OFFER.version, ...(order.kind === "check" ? { product: "check" } : {}) },
    payment_intent_data: { metadata: { order_id: order.id, offer: order.kind === "check" ? CHECK_OFFER.version : OFFER.version, ...(order.kind === "check" ? { product: "check" } : {}) } },
  };
  const s = await stripeFetch(env, "/checkout/sessions", { method: "POST", body, idempotencyKey: `checkout:${order.id}:${order.attempt}${pm.kind === "card" ? "" : ":" + methodsKey(pm)}`, fetchImpl });
  if (!s || typeof s.id !== "string" || typeof s.url !== "string" || !/^https:\/\//.test(s.url)) throw new Error("stripe: ogiltig session");
  return { id: s.id, url: s.url, methods: pm.types, expiresAt: Number.isFinite(s.expires_at) ? s.expires_at * 1000 : order.expiresAtSec * 1000 };
}

export async function retrieveSession(env, sessionId, { fetchImpl } = {}) {
  if (!/^cs_[A-Za-z0-9_]{8,}$/.test(String(sessionId))) throw new Error("ogiltigt session-id");
  return stripeFetch(env, `/checkout/sessions/${sessionId}`, { fetchImpl });
}

// Stripe-återbetalningens status (docs.stripe.com/api/refunds/object): pending | requires_action |
// succeeded | failed | canceled. ENDAST succeeded är slutförd. Okänd/saknad status = oklar.
export function refundOutcome(status) {
  switch (status) {
    case "succeeded": return "done";
    case "pending": return "pending";
    case "requires_action": return "action_required";
    case "failed":
    case "canceled": return "failed";
    default: return "unknown";
  }
}

export async function refundPayment(env, { paymentIntentId, orderId, fetchImpl }) {
  if (!/^pi_[A-Za-z0-9_]{8,}$/.test(String(paymentIntentId))) throw new Error("ogiltigt betalnings-id");
  const r = await stripeFetch(env, "/refunds", { method: "POST", body: { payment_intent: paymentIntentId, reason: "requested_by_customer", metadata: { order_id: orderId } }, idempotencyKey: `refund:${orderId}`, fetchImpl });
  return { id: r && typeof r.id === "string" && /^re_[A-Za-z0-9_]+$/.test(r.id) ? r.id : null, status: r && r.status };
}

export async function retrieveRefund(env, refundId, { fetchImpl } = {}) {
  if (!/^re_[A-Za-z0-9_]+$/.test(String(refundId))) throw new Error("ogiltigt återbetalnings-id");
  const r = await stripeFetch(env, `/refunds/${refundId}`, { fetchImpl });
  return { id: r && r.id, status: r && r.status };
}

// Verifierar Stripe-Signature (t=…,v1=…[,v1=…]) mot RÅ kropp. Ingen tolkning före verifiering.
export async function verifyWebhook(rawBody, header, secret, { now = Date.now(), toleranceSec = 300 } = {}) {
  if (typeof rawBody !== "string" || typeof header !== "string" || !secret) return { ok: false, reason: "saknas" };
  let t = null; const sigs = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") t = v; else if (k === "v1") sigs.push(v);
  }
  if (!t || !/^\d{9,12}$/.test(t) || !sigs.length) return { ok: false, reason: "format" };
  if (Math.abs(now / 1000 - Number(t)) > toleranceSec) return { ok: false, reason: "tid" };
  const expected = await hmacSha256Hex(secret, `${t}.${rawBody}`);
  if (!sigs.some((s) => /^[0-9a-f]{64}$/.test(s) && timingSafeEqual(s, expected))) return { ok: false, reason: "signatur" };
  let event;
  try { event = JSON.parse(rawBody); } catch { return { ok: false, reason: "json" }; }
  if (!event || typeof event !== "object" || typeof event.id !== "string" || typeof event.type !== "string") return { ok: false, reason: "form" };
  return { ok: true, event };
}

// Signerar en testhändelse (för enhetstester och lokal körning, aldrig mot Stripe).
export async function signForTest(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${rawBody}`)}`;
}

// Kontroll att en Checkout-session verkligen är betalningen för DEN HÄR ordern med rätt belopp.
// Används av både webhook och avstämning; returnsidan är aldrig bevis.
export function evaluatePaidSession(session, order, mode) {
  // Metodbindning: har ordern en frusen metodlista måste sessionens metoder ligga inom den (ingen oväntad metod låser upp).
  const fail = (reason) => ({ ok: false, reason });
  if (!session || typeof session !== "object" || session.object !== "checkout.session") return fail("form");
  if (session.mode !== "payment") return fail("mode");
  if (session.livemode !== (mode === "live")) return fail("livemode");
  if (session.client_reference_id !== order.id) return fail("order");
  if (!order.stripe || session.id !== order.stripe.sessionId) return fail("session");
  if (session.metadata && session.metadata.order_id !== undefined && session.metadata.order_id !== order.id) return fail("metadata");
  if (Array.isArray(order.stripe.methods) && Array.isArray(session.payment_method_types) && !session.payment_method_types.every((t) => order.stripe.methods.includes(t))) return fail("metod");
  // Produktbindning: felprodukt låser aldrig upp. Förkontroll kräver metadata.product=check; jämförelse får inte bära den.
  if (order.kind === "check" ? !(session.metadata && session.metadata.product === "check") : !!(session.metadata && session.metadata.product !== undefined)) return fail("produkt");
  if (session.currency !== OFFER.currency) return fail("valuta");
  if (session.amount_total !== (order.kind === "check" ? CHECK_OFFER.priceOre : OFFER.priceOre)) return fail("belopp");
  if (session.status !== "complete" || session.payment_status !== "paid") return fail("ej_betald");
  const pi = typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent && session.payment_intent.id);
  if (typeof pi !== "string" || !/^pi_[A-Za-z0-9_]{8,}$/.test(pi)) return fail("betalning");
  return { ok: true, paymentIntentId: pi, amountTotal: session.amount_total };
}
