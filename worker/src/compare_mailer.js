// Verklig mejltransport för avtalsbekräftelsen – ISOLERAD och DEFAULT AV (fail closed). Byggstöd för HTTP-adaptern är INTE ett leverantörsval,
// ingen aktivering och inget bevis för plan/domän/åtkomst: Resend är bara en äldre INFERRED kontokandidat (ABONNEMANG). Testas ENDAST med HTTP-dubbel.
// Primärkällor (läst 2026-10-11, inga anrop): https://resend.com/docs/api-reference/emails/send-email  och  https://resend.com/docs/dashboard/emails/idempotency-keys
//   POST https://api.resend.com/emails, Authorization: Bearer <nyckel>, JSON {from,to,subject,text,attachments:[{filename,content(base64),content_type}]}, svar {id}.
//   Idempotency-Key (header, 1–256 tecken) gäller 24 h: samma nyckel + samma nyttolast ⇒ samma svar utan ny sändning; annan nyttolast ⇒ 409
//   invalid_idempotent_request; pågående ⇒ 409 concurrent_idempotent_requests; ogiltig nyckel ⇒ 400 invalid_idempotency_key.
// "Sent" betyder ENDAST att transporten accepterat meddelandet (HTTP 2xx + giltigt leverantörs-ID) – inte att det nått mottagarens inkorg.
// Nyckeln läses bara här, i anropsögonblicket: den lagras, loggas eller återges aldrig (varken i utkorg, fel, svar eller telemetri).
import { sha256Hex, toHex, timingSafeEqual } from "./compare_util.js";

export const MAIL_PROVIDER = "resend";
export const MAIL_ENDPOINT = "https://api.resend.com/emails";
export const MAIL_TIMEOUT_MS = 15_000;
export const IDEM_WINDOW_MS = 23 * 3600_000; // leverantörens fönster är 24 h; 1 h marginal. Efter fönstret: ingen ny nyckel, ingen blind omsändning – avstämning.
export const LEASE_MS = 60_000; // pågående sändning (skyddar mot parallell/omstartad dubbelsändning; samma nyckel används alltid)
const KEY_RE = /^re_[A-Za-z0-9_]{16,200}$/;
const FROM_RE = /^(?:[^<>@\r\n"]{1,80} <[^\s<>@,;]{1,64}@[^\s<>@,;]{1,200}\.[^\s<>@,;]{2,}>|[^\s<>@,;"\r\n]{1,64}@[^\s<>@,;]{1,200}\.[^\s<>@,;]{2,})$/;
const TO_RE = /^[^\s@,;<>"]{1,64}@[^\s@,;<>"]{1,200}\.[^\s@,;<>"]{2,}$/;
const ID_RE = /^[A-Za-z0-9_-]{8,100}$/;

// Alla fyra måste vara satta av människa, annars AV: COMPARE_MAIL_HTTP=1, COMPARE_MAIL_HTTP_VERIFIED=1 (plan/domän/avsändare/villkor verifierade),
// giltig COMPARE_MAIL_FROM och COMPARE_MAIL_DAY_CAP (heltal > 0 = högsta antal NYA meddelanden per dygn; 0/saknas ⇒ AV) samt hemligheten COMPARE_MAIL_API_KEY.
// En nyckel ensam aktiverar ingenting, och ingen annan befintlig adapter eller mock påverkas av den.
export function mailHttpConfig(env) {
  const e = env || {};
  const dayCap = /^[1-9][0-9]{0,5}$/.test(String(e.COMPARE_MAIL_DAY_CAP || "")) ? Number(e.COMPARE_MAIL_DAY_CAP) : 0;
  const from = typeof e.COMPARE_MAIL_FROM === "string" && FROM_RE.test(e.COMPARE_MAIL_FROM.trim()) ? e.COMPARE_MAIL_FROM.trim() : null;
  const reasons = [];
  if (e.COMPARE_MAIL_HTTP !== "1") reasons.push("flag");
  if (e.COMPARE_MAIL_HTTP_VERIFIED !== "1") reasons.push("verified");
  if (!from) reasons.push("from");
  if (!dayCap) reasons.push("cap");
  if (typeof e.COMPARE_MAIL_API_KEY !== "string" || !KEY_RE.test(e.COMPARE_MAIL_API_KEY)) reasons.push("key");
  if (!mailEventsConfig(e).on) reasons.push("events"); // D14: utan signerad händelsekanal kan leverans aldrig bevisas ⇒ ingen sändning (fail closed)
  return { on: reasons.length === 0, reasons, dayCap, from };
}
// D14: leveranshändelser (Resend-webhook, Svix-signerad). Hemligheten COMPARE_MAIL_WEBHOOK_SECRET (whsec_ + base64) matas in av människa; här bara formkontroll.
// Utan den: HTTP-sändningen är AV (se ovan) och rutten /compare/mail-events är stängd. Testfixturer är syntetiska.
const WHSEC_RE = /^whsec_[A-Za-z0-9+/]{16,200}={0,2}$/;
export function mailEventsConfig(env) {
  const sec = env && typeof env.COMPARE_MAIL_WEBHOOK_SECRET === "string" ? env.COMPARE_MAIL_WEBHOOK_SECRET.trim() : "";
  return { on: WHSEC_RE.test(sec) && b64ToBytes(sec.slice(6)) !== null, secret: sec };
}
export const mailIdemKey = (mailId) => `mail-${String(mailId).slice(0, 200)}`;

export function b64Utf8(text) {
  const bytes = new TextEncoder().encode(String(text));
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Typad begäran (aldrig regexparsad ur brödtext). Bara avtals-/bekräftelsetext och ångerblankett – aldrig offert-, rapport- eller recensionstext.
// D14: tagg gmo_mail=<mejl-ID> (ASCII, inget personuppgifts- eller offertinnehåll) låter en leveranshändelse som kommer FÖRE vår HTTP-kvittens ändå föras till rätt order/mejl.
export const MAIL_TAG = "gmo_mail";
const MAILID_RE = /^mail_(avtal|angrakvitto)_(o_[0-9a-f]{32})$/;
export function parseMailId(id) { const m = MAILID_RE.exec(String(id)); return m ? { mailId: String(id), kind: m[1], orderId: m[2] } : null; }
export function buildMailRequest({ from, to, subject, text, attachments, mailId }) {
  const req = { from, to: [to], subject, text };
  if (mailId && MAILID_RE.test(String(mailId))) req.tags = [{ name: MAIL_TAG, value: String(mailId) }];
  if (Array.isArray(attachments) && attachments.length) req.attachments = attachments.map((a) => ({ filename: a.filename, content: a.content, content_type: a.contentType }));
  return req;
}
export async function requestHash(req) { return "rq1:" + (await sha256Hex(JSON.stringify(req))).slice(0, 40); }
export const validMailTo = (t) => typeof t === "string" && TO_RE.test(t);

// Utfall: {ok:true, ref} | {ok:false, kind, code}. kind: retry (samma nyckel) | inprogress | terminal (inget mer försök) | payload_conflict (stoppa) | config.
export async function sendViaHttp(env, { req, idemKey }) {
  let res;
  try {
    const init = { method: "POST", headers: { authorization: `Bearer ${env.COMPARE_MAIL_API_KEY}`, "content-type": "application/json", "idempotency-key": idemKey }, body: JSON.stringify(req) };
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") init.signal = AbortSignal.timeout(MAIL_TIMEOUT_MS);
    res = await fetch(MAIL_ENDPOINT, init);
  } catch { return { ok: false, kind: "retry", code: "natverk_eller_tidsgrans" }; } // kvittens kan ha gått förlorad: samma nyckel används igen
  let j = null;
  try { j = JSON.parse((await res.text()).slice(0, 4000)); } catch { j = null; }
  const name = j && typeof j.name === "string" ? j.name : "";
  if (res.status >= 200 && res.status < 300) {
    if (j && typeof j.id === "string" && ID_RE.test(j.id)) return { ok: true, ref: j.id };
    return { ok: false, kind: "retry", code: "svar_utan_giltigt_id" }; // ingen ack utan verifierat leverantörs-ID
  }
  if (res.status === 409 && name === "invalid_idempotent_request") return { ok: false, kind: "payload_conflict", code: "mejl_409_annan_nyttolast" };
  if (res.status === 409 && name === "concurrent_idempotent_requests") return { ok: false, kind: "inprogress", code: "mejl_409_pagar" };
  if (res.status === 409) return { ok: false, kind: "retry", code: "mejl_409_okand" };
  if (res.status === 400 && name === "invalid_idempotency_key") return { ok: false, kind: "config", code: "mejl_ogiltig_nyckel" };
  if (res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500) return { ok: false, kind: "retry", code: "mejl_http_" + res.status };
  return { ok: false, kind: "terminal", code: "mejl_http_" + res.status }; // 400/401/403/422…: inga upprepade försök
}


// ======================= D14: leveranshändelser =======================
// Skillnad som aldrig får suddas ut:
//   m.state === "sent"         = TRANSPORTEN (Resends API) har accepterat meddelandet (HTTP 2xx + giltigt ID). Inte levererat, inte inkorg.
//   m.delivery.state "delivered" = Resend rapporterar att meddelandet lämnats till MOTTAGARENS MAILSERVER (email.delivered). Fortfarande INTE bevis för inkorg/läsning.
// För HTTP-transporten räcker därför aldrig "sent" för att öppna startgrinden; det krävs signerat "delivered" för rätt provider-ID. Mock/adapter (uttryckliga offlineprov) oförändrade.
export function b64ToBytes(b64) {
  try { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.length >= 16 ? u : null; } catch { return null; }
}
async function hmacB64(keyBytes, message) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  let s = ""; for (const b of sig) s += String.fromCharCode(b);
  return btoa(s);
}
const SVIX_ID_RE = /^[A-Za-z0-9_-]{8,100}$/;
export const MAIL_EVENT_MAX_BYTES = 64_000;
// Svix: signerad sträng = `${svix-id}.${svix-timestamp}.${RÅ kropp}`, HMAC-SHA256 med base64-avkodad hemlighet (efter "whsec_"), header "v1,<b64> v1,<b64>…". Ingen tolkning före verifiering.
export async function verifyResendWebhook(rawBody, headers, secret, { now = Date.now(), toleranceSec = 300 } = {}) {
  const h = (n) => (headers && typeof headers.get === "function" ? headers.get(n) : null) || "";
  const id = h("svix-id"), ts = h("svix-timestamp"), sigH = h("svix-signature");
  if (typeof rawBody !== "string" || !secret || !id || !ts || !sigH) return { ok: false, reason: "saknas" };
  if (!SVIX_ID_RE.test(id) || !/^\d{9,12}$/.test(ts)) return { ok: false, reason: "format" };
  if (Math.abs(now / 1000 - Number(ts)) > toleranceSec) return { ok: false, reason: "tid" };
  const keyBytes = typeof secret === "string" && secret.startsWith("whsec_") ? b64ToBytes(secret.slice(6)) : null;
  if (!keyBytes) return { ok: false, reason: "hemlighet" };
  const sigs = sigH.split(" ").filter((x) => x.startsWith("v1,")).map((x) => x.slice(3)).slice(0, 8);
  if (!sigs.length) return { ok: false, reason: "format" };
  const expected = await hmacB64(keyBytes, `${id}.${ts}.${rawBody}`);
  if (!sigs.some((x) => timingSafeEqual(x, expected))) return { ok: false, reason: "signatur" };
  let event;
  try { event = JSON.parse(rawBody); } catch { return { ok: false, reason: "json" }; }
  if (!event || typeof event !== "object" || typeof event.type !== "string") return { ok: false, reason: "form" };
  return { ok: true, eventId: id, event };
}
export async function signResendForTest(rawBody, secret, { id = "msg_TESTONLY0001", ts = Math.floor(Date.now() / 1000) } = {}) {
  return { "svix-id": id, "svix-timestamp": String(ts), "svix-signature": "v1," + (await hmacB64(b64ToBytes(secret.slice(6)), `${id}.${ts}.${rawBody}`)) };
}

const CLASS = { "email.sent": "accepted", "email.delivered": "delivered", "email.delivery_delayed": "delayed", "email.bounced": "bounced", "email.failed": "failed", "email.suppressed": "suppressed", "email.complained": "complained" };
const EMAILID_RE = /^[A-Za-z0-9_-]{8,100}$/;
// Sanerad händelse: bara klass, provider-ID, mottagare (för matchning), tagg-ID och tider. Ämne, avsändare, brödtext och bounce-diagnostik lämnas aldrig vidare.
export function normalizeMailEvent(ev) {
  const cls = CLASS[ev && ev.type];
  if (!cls) return { ok: true, ignore: typeof (ev && ev.type) === "string" && ev.type.startsWith("email.") ? "typ_ignorerad" : "typ_okand" }; // opened/clicked/received/scheduled/okänt: inget bevis för något
  const d = ev.data;
  if (!d || typeof d !== "object" || Array.isArray(d)) return { ok: false, reason: "form" };
  if (typeof d.email_id !== "string" || !EMAILID_RE.test(d.email_id)) return { ok: false, reason: "email_id" };
  if (!Array.isArray(d.to) || d.to.length < 1 || d.to.length > 10 || !d.to.every((x) => typeof x === "string" && x.length <= 254)) return { ok: false, reason: "to" };
  let tag = null;
  const t = d.tags;
  if (Array.isArray(t)) { const f = t.find((x) => x && x.name === MAIL_TAG); tag = f && typeof f.value === "string" ? f.value : null; }
  else if (t && typeof t === "object") tag = typeof t[MAIL_TAG] === "string" ? t[MAIL_TAG] : null;
  const pa = Date.parse(ev.created_at);
  const bt = d.bounce && typeof d.bounce === "object" && ["Permanent", "Transient", "Undetermined"].includes(d.bounce.type) ? d.bounce.type : null;
  return { ok: true, cls, emailId: d.email_id, to: d.to.map((x) => x.trim().toLowerCase()), tag: tag && MAILID_RE.test(tag) ? tag : null, providerAt: Number.isFinite(pa) ? pa : null, bounceType: bt };
}

const NEG = ["bounced", "suppressed", "failed"];
// Ren, ordningsoberoende härledning: händelserna är en MÄNGD (först sedda tid per klass). Omvänd ordning, dubbletter och sena delayed/sent ändrar aldrig slutläget.
export function deriveDeliveryState(seen) {
  const has = (c) => Number.isFinite(seen[c]);
  for (const c of NEG) if (has(c)) return c;
  if (has("delivered")) return "delivered";
  if (has("delayed")) return "delayed";
  if (has("accepted")) return "accepted";
  return "none";
}
export function applyMailEvent(m, e, now) {
  const dl = m.delivery && typeof m.delivery === "object" ? m.delivery : { emailId: e.emailId, seen: {}, state: "none", at: null, providerAt: null, bounceType: null };
  if (e.cls !== "complained" || !dl.seen.complained) { if (!Number.isFinite(dl.seen[e.cls])) dl.seen[e.cls] = now; }
  if (e.cls === "bounced" && e.bounceType && !dl.bounceType) dl.bounceType = e.bounceType;
  if (e.cls === "delivered" && !Number.isFinite(dl.at)) { dl.at = now; dl.providerAt = e.providerAt; }
  dl.state = deriveDeliveryState(dl.seen);
  dl.contradiction = Number.isFinite(dl.seen.delivered) && NEG.some((c) => Number.isFinite(dl.seen[c]));
  m.delivery = dl;
  return dl;
}
// Bevis för att avtalsbekräftelsen får öppna startgrinden. HTTP: transportaccept OCH signerad leverans för SAMMA provider-ID, utan motstridig negativ händelse.
export function deliveryOk(m) {
  return !!(m && m.transport === "http" && m.state === "sent" && !m.earlyUnbound && typeof m.providerRef === "string" && m.delivery && m.delivery.state === "delivered" && m.delivery.emailId === m.providerRef && Number.isFinite(m.delivery.at));
}
export function mailAccepted(m) { return !!(m && m.state === "sent" && (m.transport !== "http" || deliveryOk(m))); }
export const NEGATIVE_DELIVERY = NEG;
