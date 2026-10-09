// S4: bunden kontroll av att produktionsnyckeln hör till den krediterade Anthropic-organisationen,
// samt automatiskt stopp för NYA AI-anrop i /explain när krediten gått ut.
// Inga nycklar skapas eller roteras, ingen faktura eller kredit rörs. Inget betalt anrop: bara
// GET /v1/models?limit=1 (metadata, ingen modellgenerering) och svarshuvudet anthropic-organization-id.
// Organisations-ID:t är inte hemligt men visas aldrig i något svar; utåt går bara en bool + status + tid.
import { ANTHROPIC_VERSION } from "./provider.js";

export const PROBE_URL = "https://api.anthropic.com/v1/models?limit=1";
export const PROBE_TIMEOUT_MS = 4000;
// Krediterad organisation enligt Console (REPORTED av Anders/Codex 2026-10-10). Kan sänkas/ersättas via EXPLAIN_CREDIT_ORG_ID.
export const CREDIT_ORG_ID = "6f039be3-05e8-4f78-bc04-5f107df8ff7f";
// Krediten går ut 14 okt 2026. Fail-closed: nya AI-anrop stoppas från 2026-10-14 00:00 UTC tills
// ett nytt användarbeslut sätter EXPLAIN_CREDIT_UNTIL (YYYY-MM-DD, första dagen utan kredit).
export const CREDIT_EXPIRES_DEFAULT = "2026-10-14";
const TTL_OK_MS = 10 * 60 * 1000;
const TTL_FAIL_MS = 2 * 60 * 1000; // även misslyckanden cachas: högst en verklig kontroll per nyckel och två minuter
const ORG_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const mem = new Map(); // nyckelhash -> { at, res }

async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function creditExpired(env, now = new Date()) {
  const raw = env.EXPLAIN_CREDIT_UNTIL === undefined ? CREDIT_EXPIRES_DEFAULT : String(env.EXPLAIN_CREDIT_UNTIL);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return true; // ogiltigt värde stänger
  const t = Date.parse(raw + "T00:00:00Z");
  if (!Number.isFinite(t)) return true;
  return now.getTime() >= t;
}

// Nyckelhash = hash av hemligheten + förväntat org-ID. Byts hemligheten (eller förväntat org) får cachen en ny nyckel
// och ett gammalt resultat kan aldrig återanvändas. Själva hemligheten lämnar aldrig denna funktion.
async function cacheKey(env, expected) {
  return (await sha256Hex(`orgprobe-v1|${env.ANTHROPIC_API_KEY}|${expected}`)).slice(0, 24);
}

function expectedOrg(env) {
  const e = env.EXPLAIN_CREDIT_ORG_ID === undefined ? CREDIT_ORG_ID : String(env.EXPLAIN_CREDIT_ORG_ID).toLowerCase();
  return ORG_RE.test(e) ? e : null;
}

function out(status, ms) { return { creditOrgMatches: status === "ok", status, ms }; }

export async function probeCreditOrg(env, { fetchImpl = fetch, now = Date.now(), force = false } = {}) {
  if (!env.ANTHROPIC_API_KEY) return out("nyckel_saknas", 0);
  const expected = expectedOrg(env);
  if (!expected) return out("konfig", 0);
  const key = await cacheKey(env, expected);
  const hit = mem.get(key);
  if (hit && !force && now - hit.at < hit.ttl) return hit.res;
  // Delad cache mellan isolat (KV) med samma nyckelhash: ett byte av hemlighet ger ny nyckel.
  const kvKey = "orgprobe:" + key;
  if (!force && env.REVIEWS_KV) {
    try {
      const raw = await env.REVIEWS_KV.get(kvKey);
      if (raw) {
        const v = JSON.parse(raw);
        if (v && typeof v.status === "string" && Number.isFinite(v.at) && now - v.at < (v.status === "ok" ? TTL_OK_MS : TTL_FAIL_MS)) {
          const res = out(v.status, v.ms | 0);
          mem.set(key, { at: v.at, ttl: v.status === "ok" ? TTL_OK_MS : TTL_FAIL_MS, res });
          return res;
        }
      }
    } catch { /* trasig cache ignoreras */ }
  }
  const t0 = Date.now();
  let status;
  try {
    const resp = await fetchImpl(PROBE_URL, {
      method: "GET",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": ANTHROPIC_VERSION },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const org = (resp.headers && resp.headers.get("anthropic-organization-id")) || "";
    try { await resp.body?.cancel?.(); } catch { /* svarskroppen läses aldrig */ }
    if (!resp.ok) status = "fel";
    else if (!org) status = "huvud_saknas";
    else status = org.toLowerCase() === expected ? "ok" : "annan_org";
  } catch {
    status = "fel";
  }
  const res = out(status, Math.min(Date.now() - t0, 99999));
  const ttl = status === "ok" ? TTL_OK_MS : TTL_FAIL_MS;
  mem.set(key, { at: now, ttl, res });
  if (env.REVIEWS_KV) {
    try { await env.REVIEWS_KV.put(kvKey, JSON.stringify({ status, ms: res.ms, at: now }), { expirationTtl: Math.ceil(ttl / 1000) < 60 ? 60 : Math.ceil(ttl / 1000) }); } catch { /* bara en bonus */ }
  }
  return res;
}

// Port före nya AI-anrop i /explain. ok:false ger alltid den fasta reservvägen.
export async function aiGate(env, { fetchImpl = fetch, now = new Date() } = {}) {
  if (creditExpired(env, now)) return { ok: false, reason: "kredit_utgangen" };
  const p = await probeCreditOrg(env, { fetchImpl, now: now.getTime() });
  if (p.creditOrgMatches) return { ok: true };
  return { ok: false, reason: p.status === "annan_org" ? "org_annan" : p.status === "huvud_saknas" ? "org_huvud_saknas" : "org_okand" };
}

export function _resetProbeCacheForTests() { mem.clear(); }
