// POST /explain – AI-förklaring med högst tre åtgärder (S3, KOLLAR-RATTNING-20261009-01).
// Egen väg, eget CORS (stahledigital.se), eget budgettak. Rör inte /review. Flagga AV som standard.
//
// Modellen väljer och ordnar bara slutna åtgärds-ID (1–3). ALL synlig text (intro, etikett, åtgärder) är fast servertext;
// modellen kan aldrig skriva något som når kunden (Codex S3-rättning 2026-10-10).
// Ordning (varje steg kan bara leda till den fasta reservvägen, aldrig till felruta):
//  flagga → indatavalidering → cache → nyckel → org/kredit-port (S4) → Turnstile (om secret finns, med hostname/action)
//  → budgetreservation → ett AI-anrop → validering i kod → cache + kostnadshändelse.
import { APPS, validActions, deterministicActions, parseExplainInput } from "./explain_catalog.js";
import { MODELS, buildAnthropicRequest, computeCost, modelInfo } from "./models.js";
import { ANTHROPIC_URL, ANTHROPIC_VERSION } from "./provider.js";
import { aiGate } from "./org_probe.js";
import { reserveBudget, settleBudget, releaseBudget, budgetAvailable } from "./explain_budget.js";
import { gateEnabled, gateReserve, gateSettle, gateUnknown, gateRelease } from "./cost_gate.js";

export const EXPLAIN_VERSION = "explain-v2";
export const EXPLAIN_MODEL = "claude-sonnet-5-5";
const MAX_BODY_BYTES = 4096;
const MAX_INPUT_BYTES = 6000;      // övre gräns i tokens: ett token är aldrig mindre än en byte
const MAX_OUTPUT_TOKENS = 1200;    // inklusive tänkande
const MONTH_CAP_MICRO = 20_000_000; // 20 USD
const DAY_LIMIT = 100;
const IP_LIMIT = 5;
const TURNSTILE_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export const AI_LABEL = "Ordningen på förslagen är vald av en AI utifrån kontrollresultaten ovan. Själva texterna är fasta och skrivna av oss.";
export const INTEGRITY_LINE = "Färger, status och antal kommer från kontrollerna, inte från AI:n. Åtgärderna är fasta förslag.";
export const AI_INTRO = "Så här kan du gå vidare utifrån kontrollerna ovan, i den ordning som passar dem bäst.";
const FALLBACK_INTRO = "Så här kan du gå vidare utifrån kontrollerna ovan.";

const SYSTEM = `Du hjälper en liten företagare att välja i vilken ordning de ska ta fasta åtgärder efter en teknisk självkontroll. Du får bara en lista med kontroll-ID och status och en lista "giltiga åtgärder". Du ser ingen text från företagets sajt.
Uppgift: välj och ordna högst tre åtgärds-ID ur listan, viktigast först. Du skriver ingen text alls; bara ID.
Svara genom att anropa verktyget submit_explanation.`;

function toolFor(validIds) {
  return {
    name: "submit_explanation",
    description: "Skicka valda åtgärds-ID i prioritetsordning. Ingen text.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["priority_ids"],
      properties: {
        priority_ids: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", enum: validIds } },
      },
    },
  };
}

// ---- Validering av modellens utdata i kod ----
// Bara { priority_ids } accepteras. Varje annat fält (t.ex. en fri intro) avvisas: en ordlista kan aldrig
// verifiera alla påståenden, så ingen modelltext får nå kunden. Texten byggs alltid av servern.
export function validateModelOutput(out, app, checks) {
  const valid = validActions(app, checks);
  if (!out || typeof out !== "object" || Array.isArray(out)) return { ok: false, reason: "form" };
  for (const k of Object.keys(out)) if (k !== "priority_ids") return { ok: false, reason: "okant_falt" };
  const ids = out.priority_ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 3) return { ok: false, reason: "antal" };
  const seen = new Set();
  for (const id of ids) {
    if (typeof id !== "string" || !valid.has(id) || seen.has(id)) return { ok: false, reason: "id" };
    seen.add(id);
  }
  return { ok: true, intro: AI_INTRO, actions: ids.map((id) => ({ id, text: valid.get(id).text })) };
}

// ---- Hjälpare ----
async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const bytes = (s) => new TextEncoder().encode(s).length;

export function explainCors(origin, allowed) {
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
    "X-Robots-Tag": "noindex, nofollow, nosnippet",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
}
export const explainOrigins = (env) => String(env.EXPLAIN_ALLOWED_ORIGIN || "https://stahledigital.se").split(",").map((s) => s.trim()).filter(Boolean);

const json = (obj, status, headers) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });

function fallbackBody(app, checks, reason) {
  return { mode: "fallback", reason, ai: false, intro: FALLBACK_INTRO, actions: deterministicActions(app, checks).map((a) => ({ id: a.id, text: a.text })), version: EXPLAIN_VERSION };
}
function aiBody(v, cached) {
  return { mode: "ai", ai: true, cached: Boolean(cached), label: AI_LABEL, integrity: INTEGRITY_LINE, intro: v.intro, actions: v.actions, version: EXPLAIN_VERSION };
}

// Turnstile används bara om en riktig secret finns (ingen ny secret beställs). Då krävs success OCH att hostname hör till
// tillåtna origins och att action är "forklaring" (samma som klienten). Utan secret skyddas vägen av serverbegränsningarna
// (riktig CF-IP, atomisk budget 20 USD/månad, dag 100, IP 5), på samma sätt som publika /review.
const TURNSTILE_ACTION = "forklaring";
async function verifyTurnstile(env, token, ip, fetchImpl) {
  if (!token || token.length > 2048) return false;
  try {
    const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KOLLAR, response: token });
    if (ip && ip !== "unknown") form.set("remoteip", ip);
    const r = await fetchImpl(TURNSTILE_URL, { method: "POST", body: form, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return false;
    const j = await r.json();
    if (!j || j.success !== true) return false;
    const hosts = explainOrigins(env).map((o) => { try { return new URL(o).hostname; } catch { return ""; } }).filter(Boolean);
    if (typeof j.hostname !== "string" || !hosts.includes(j.hostname)) return false;
    return j.action === TURNSTILE_ACTION;
  } catch { return false; }
}

// Kostnadshändelse: samma blob-layout som GMO (blob1 "anrop_kostnad", blob2 modell, blob3 känd/okand), blob4 = app=<app>.
function logCost(env, request, tratt, model, cost, app, inputBytes) {
  try { tratt(env, request, "anrop_kostnad", [model, cost.status, `app=${app}`], [cost.inputTokens ?? 0, cost.outputTokens ?? 0, cost.usd ?? 0, inputBytes]); } catch { /* aldrig störa */ }
}

export async function handleExplain(request, env, ctx, { tratt = () => {}, fetchImpl = fetch } = {}) {
  const origins = explainOrigins(env);
  const origin = request.headers.get("Origin") || "";
  const headers = explainCors(origin, origins);
  if (!origins.includes(origin)) return json({ error: "Förklaringen kan bara begäras från stahledigital.se." }, 403, headers);

  let raw;
  try { raw = await request.text(); } catch { return json({ error: "Ogiltig förfrågan." }, 400, headers); }
  if (bytes(raw) > MAX_BODY_BYTES) return json({ error: "Ogiltig förfrågan." }, 400, headers);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: "Ogiltig förfrågan." }, 400, headers); }
  const parsed = parseExplainInput(body);
  if (!parsed.ok) return json({ error: "Ogiltig förfrågan.", reason: parsed.reason }, 400, headers);
  const { app, checks, turnstileToken } = parsed;
  const fb = (reason) => json(fallbackBody(app, checks, reason), 200, headers);

  // Flagga AV (standard): ingen cache, ingen Turnstile, ingen budget, inget AI-anrop.
  if (env.EXPLAIN_ENABLED !== "1") return fb("av");

  const valid = validActions(app, checks);
  if (valid.size === 0) return fb("inget_att_forklara"); // inget behöver åtgärdas: ingen AI-förklaring

  const cacheKey = "ex:" + (await sha256Hex(`${EXPLAIN_VERSION}|${app}|${checks.map((c) => `${c.id}=${c.status}`).join(",")}`));
  try {
    const hit = env.REVIEWS_KV ? await env.REVIEWS_KV.get(cacheKey) : null;
    if (hit) {
      const v = validateModelOutput(JSON.parse(hit), app, checks); // gamla cacheposter med fria fält avvisas
      if (v.ok) return json(aiBody(v, true), 200, headers);
    }
  } catch { /* trasig cache ignoreras */ }

  if (!env.ANTHROPIC_API_KEY) return fb("nyckel_saknas");
  // S4: kreditutgång och org-kontroll före Turnstile/budget/AI. Misslyckad kontroll = fast reservväg, aldrig AI.
  const gate = await aiGate(env, { fetchImpl });
  if (!gate.ok) return fb(gate.reason);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (env.TURNSTILE_SECRET_KOLLAR && !(await verifyTurnstile(env, turnstileToken, ip, fetchImpl))) return fb("turnstile");

  const model = env.EXPLAIN_MODEL || EXPLAIN_MODEL;
  if (!modelInfo(model)) return fb("modell_okand"); // okänd modell = okänt pris: inget betalt anrop
  const ids = [...valid.keys()];
  const userText = JSON.stringify({ app, kontroller: checks, giltiga_atgarder: ids });
  const req = buildAnthropicRequest({ model, system: SYSTEM, userContent: userText, tool: toolFor(ids) });
  req.max_tokens = Math.min(req.max_tokens, MAX_OUTPUT_TOKENS);
  const reqText = JSON.stringify(req);
  const inputBytes = bytes(reqText);
  if (inputBytes > MAX_INPUT_BYTES) return fb("for_stor_indata");

  const m = MODELS[model];
  // Värsta tänkbara kostnad: ett token per indatabyte + allt tillåtet utdata. Heltal mikro-USD, avrundat uppåt.
  const worstMicro = Math.ceil(inputBytes * m.inputUsdPerMTok + req.max_tokens * m.outputUsdPerMTok);
  const now = new Date();
  const day = now.toISOString().slice(0, 10), month = day.slice(0, 7);
  const ipKey = (await sha256Hex(`${ip}|${day}`)).slice(0, 16);
  const dayLimit = env.EXPLAIN_DAY_LIMIT === undefined ? DAY_LIMIT : Number(env.EXPLAIN_DAY_LIMIT);
  const capMicro = env.EXPLAIN_MONTH_CAP_MICRO === undefined ? MONTH_CAP_MICRO : Number(env.EXPLAIN_MONTH_CAP_MICRO);
  // Konfigurerade värden får bara SÄNKA taken; allt över standard eller ogiltigt nekar.
  if (!Number.isSafeInteger(dayLimit) || dayLimit < 0 || dayLimit > DAY_LIMIT || !Number.isSafeInteger(capMicro) || capMicro < 0 || capMicro > MONTH_CAP_MICRO) return fb("konfig");
  if (!budgetAvailable(env)) return fb("ingen_budget");
  // Gemensam kostnadsgate (AV som standard, COST_GATE="1"): samma atomära tak som /review och betalda jämförelser.
  let gateKey = null, gateMicro = 0;
  if (gateEnabled(env)) {
    gateMicro = Math.ceil(worstMicro);
    gateKey = `exp:${crypto.randomUUID()}`;
    const g = await gateReserve(env, { key: gateKey, micro: gateMicro });
    if (!g.ok) return fb(`gate_${g.reason}`);
  }
  const res = await reserveBudget(env, { month, day, ipKey, micro: worstMicro, capMicro, dayLimit, ipLimit: IP_LIMIT });
  if (!res.ok) { if (gateKey) await gateRelease(env, { key: gateKey }); return fb(`budget_${res.reason}`); }

  let respJson;
  try {
    const resp = await fetchImpl(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": ANTHROPIC_VERSION },
      body: reqText,
      signal: AbortSignal.timeout(25000),
    });
    if (!resp.ok) {
      // Ett svar utan 2xx har inte debiterats: reservationen frigörs.
      await releaseBudget(env, { month, day, ipKey, micro: worstMicro });
      if (gateKey) await gateRelease(env, { key: gateKey });
      return fb("ai_fel");
    }
    respJson = await resp.json();
  } catch {
    // Okänt om anropet nådde fram och debiterades: reservationen (värsta fallet) får ligga kvar.
    if (gateKey) await gateUnknown(env, { key: gateKey, worstMicro: gateMicro });
    return fb("ai_oklart");
  }

  const cost = computeCost(model, respJson && respJson.usage);
  if (gateKey) await gateSettle(env, { key: gateKey, model, usage: respJson && respJson.usage, worstMicro: gateMicro });
  // Uppmätt kostnad ersätter reservationen. Okänd kostnad: värsta fallet ligger kvar.
  if (cost.status === "känd" && cost.usd !== null) {
    await settleBudget(env, { month, micro: worstMicro, actual: Math.ceil(cost.usd * 1e6) });
  }
  logCost(env, request, tratt, model, cost, app, inputBytes);

  if (!respJson || respJson.stop_reason === "max_tokens" || respJson.stop_reason === "refusal") return fb("ai_avkortat");
  const tu = (respJson.content || []).find((b) => b && b.type === "tool_use" && b.name === "submit_explanation");
  const v = validateModelOutput(tu && tu.input, app, checks);
  if (!v.ok) return fb(`validering_${v.reason}`);
  try { if (env.REVIEWS_KV) await env.REVIEWS_KV.put(cacheKey, JSON.stringify({ priority_ids: v.actions.map((a) => a.id) }), { expirationTtl: 86400 }); } catch { /* cache är bara en bonus */ }
  return json(aiBody(v, false), 200, headers);
}

export { APPS };
