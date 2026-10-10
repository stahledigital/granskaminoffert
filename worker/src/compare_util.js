// Små säkra hjälpare för jämförelsepaketet (Web Crypto, inga beroenden).

const enc = new TextEncoder();

export function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return toHex(a);
}
export function b64url(bytes) {
  const a = new Uint8Array(bytes);
  let s = "";
  for (const b of a) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function randomToken(bytes = 24) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return b64url(a);
}
export async function sha256Hex(data) {
  const buf = typeof data === "string" ? enc.encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", buf));
}
// Jämförelse i konstant tid för lika långa strängar.
export function timingSafeEqual(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
export async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

export const ORDER_ID_RE = /^o_[0-9a-f]{32}$/;
export const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
export function newOrderId() { return "o_" + randomHex(16); }
export function newAccessToken() { return randomToken(24); } // 24 byte -> 32 tecken base64url

// Ren text för allt som kommer ur ett dokument/modell innan det visas: inga kontrolltecken,
// ingen markup, inga länkar, begränsad längd. Visas alltid som textContent i gränssnittet.
export function cleanText(v, max = 120) {
  if (typeof v !== "string") return "";
  let s = v.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, " ");
  s = s.replace(/<[^>]*>/g, " ").replace(/[<>]/g, " ");
  s = s.replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[länk borttagen]");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}
