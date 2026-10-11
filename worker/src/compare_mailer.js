// Verklig mejltransport för avtalsbekräftelsen – ISOLERAD och DEFAULT AV (fail closed). Byggstöd för HTTP-adaptern är INTE ett leverantörsval,
// ingen aktivering och inget bevis för plan/domän/åtkomst: Resend är bara en äldre INFERRED kontokandidat (ABONNEMANG). Testas ENDAST med HTTP-dubbel.
// Primärkällor (läst 2026-10-11, inga anrop): https://resend.com/docs/api-reference/emails/send-email  och  https://resend.com/docs/dashboard/emails/idempotency-keys
//   POST https://api.resend.com/emails, Authorization: Bearer <nyckel>, JSON {from,to,subject,text,attachments:[{filename,content(base64),content_type}]}, svar {id}.
//   Idempotency-Key (header, 1–256 tecken) gäller 24 h: samma nyckel + samma nyttolast ⇒ samma svar utan ny sändning; annan nyttolast ⇒ 409
//   invalid_idempotent_request; pågående ⇒ 409 concurrent_idempotent_requests; ogiltig nyckel ⇒ 400 invalid_idempotency_key.
// "Sent" betyder ENDAST att transporten accepterat meddelandet (HTTP 2xx + giltigt leverantörs-ID) – inte att det nått mottagarens inkorg.
// Nyckeln läses bara här, i anropsögonblicket: den lagras, loggas eller återges aldrig (varken i utkorg, fel, svar eller telemetri).
import { sha256Hex } from "./compare_util.js";

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
  return { on: reasons.length === 0, reasons, dayCap, from };
}
export const mailIdemKey = (mailId) => `mail-${String(mailId).slice(0, 200)}`;

export function b64Utf8(text) {
  const bytes = new TextEncoder().encode(String(text));
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Typad begäran (aldrig regexparsad ur brödtext). Bara avtals-/bekräftelsetext och ångerblankett – aldrig offert-, rapport- eller recensionstext.
export function buildMailRequest({ from, to, subject, text, attachments }) {
  const req = { from, to: [to], subject, text };
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
