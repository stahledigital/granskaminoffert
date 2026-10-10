// Själva arbetet efter betalning: en avläsning per offert, högst ett begränsat ordningssteg och
// sammanställning av rapporten. Körs av ordern (CompareOrders.alarm) under en lease; alla
// ändringar av orderns tillstånd går genom `store`, som avvisar skrivning om leasen är förlorad.
//
// Kostnad: VARJE modellanrop föregås av en reservation (compare_budget.js) med värsta tänkbara
// kostnad och avslutas med avräkning mot uppmätt användning. Nekad reservation = inget anrop.
// Oklar användning (tidsgräns, saknad usage) behåller värsta fallet och stoppar nya generationer.
//
// Returnerar { state: "delivered", reportKey } | { state: "retry", reason } | { state: "failed", reason }
// | { state: "lost" } (leasen förlorad – någon annan äger ordern).

import { DEFAULT_MODEL, worstCaseUsd, computeCost, modelInfo, ratesFor } from "./models.js";
import { ANTHROPIC_URL, ANTHROPIC_VERSION } from "./provider.js";
import { LIMITS, OFFER, budgetConfig } from "./compare_config.js";
import { sha256Hex } from "./compare_util.js";
import { buildExtractRequest, readOffer, sanitizeOffer, EXTRACT_VERSION } from "./compare_extract.js";
import { compareOffers, offerLabels } from "./compare_engine.js";
import { buildSynthRequest, readPriority, assembleReport } from "./compare_report.js";
import * as budget from "./compare_budget.js";

const SAFETY_TOKENS = 600; // marginal för verktygsschema/system som tokenräknaren redan ska ha tagit med

class Stop extends Error {
  constructor(result) { super(result.reason || result.state); this.result = result; }
}

// Ett modellanrop med reservation → anrop → avräkning. Kastar Stop vid nekad budget/förlorad lease.
// Returnerar { json } vid ok svar eller { error, charged } när anropet misslyckades.
async function guardedCall({ env, io, key, orderId, scope, inputTokens, body, model, caps, signalMs = 90_000 }) {
  const usd = worstCaseUsd(model, inputTokens);
  if (usd === null) throw new Stop({ state: "failed", reason: "okand_modell" });
  const micro = budget.usdToMicro(usd);
  const r = await budget.reserve(env, { key, scope, orderId, micro, caps, now: new Date(io.now()) });
  if (!r.ok) throw new Stop({ state: "failed", reason: `budget:${r.reason}` });

  let resp;
  try {
    resp = await io.fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": ANTHROPIC_VERSION },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(signalMs),
    });
  } catch {
    // Nätverksfel/tidsgräns: oklart om något debiterades → värsta fallet behålls och nya generationer stoppas.
    await budget.settle(env, { key, actual: micro, usageKnown: false });
    return { error: "natverk", charged: "okand" };
  }
  let json = null;
  try { json = await resp.json(); } catch { /* ogiltigt svar */ }
  if (!resp.ok) {
    // HTTP-fel från leverantören debiteras inte (4xx/5xx) → frigör reservationen.
    await budget.release(env, { key });
    return { error: `http_${resp.status}`, charged: "nej", transient: resp.status === 429 || resp.status >= 500 };
  }
  const cost = computeCost(model, json && json.usage);
  if (cost.status === "känd") {
    await budget.settle(env, { key, actual: budget.usdToMicro(cost.usd), usageKnown: true });
  } else {
    await budget.settle(env, { key, actual: micro, usageKnown: false });
  }
  return { json, cost };
}

export async function runPipeline({ env, io, store, model: modelOverride }) {
  try {
    return await run({ env, io, store, model: modelOverride });
  } catch (e) {
    if (e instanceof Stop) return e.result;
    throw e;
  }
}

async function run({ env, io, store, model: modelOverride }) {
  const order = await store.order();
  if (!order) return { state: "lost" };
  const cfg = budgetConfig(env);
  if (!cfg.ok) return { state: "failed", reason: "ingen_budgetkonfig" };
  if (!env.ANTHROPIC_API_KEY) return { state: "failed", reason: "ingen_modellnyckel" };
  const caps = { joint: cfg.month, scope: cfg.paid, order: cfg.order };
  const model = modelOverride || env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  if (!modelInfo(model)) return { state: "failed", reason: "okand_modell" };
  const n = order.docCount;
  if (!Array.isArray(order.docs) || order.docs.length !== n) return { state: "failed", reason: "dokument_saknas" };

  // ---- 1. En avläsning per offert ----
  for (let idx = 0; idx < n; idx++) {
    const meta = order.docs.find((d) => d.idx === idx);
    if (!meta) return { state: "failed", reason: "dokument_saknas" };
    // Återanvänd avläsning bara om filens hash, modell, promptversion och schema stämmer (samma order = samma kund).
    const cacheKey = await sha256Hex(`${meta.sha256}|${model}|${EXTRACT_VERSION}`);
    const have = await store.getExt(idx);
    if (have && have.cacheKey === cacheKey) continue;

    if (!(await store.heartbeat())) return { state: "lost" };
    const stored = await io.kv.get(`cmpdoc:${order.id}:${idx}`, "json");
    if (!stored) return { state: "failed", reason: "dokument_saknas" };
    const request = buildExtractRequest({ model, doc: stored });

    let done = false;
    for (;;) {
      const attempt = await store.stepAttempt("ext", idx);
      if (attempt === null) return { state: "lost" };
      if (attempt > LIMITS.maxAttemptsPerStep) return { state: "failed", reason: "avlasning_misslyckades" };
      const res = await guardedCall({ env, io, key: `ext:${order.id}:${idx}:${attempt}`, orderId: order.id, scope: "paid", inputTokens: meta.tokens + SAFETY_TOKENS, body: request, model, caps });
      if (res.error) {
        if (res.charged === "okand") return { state: "failed", reason: "okand_anvandning" }; // generationer stoppade; ingen blind omkörning
        if (res.transient) { if (attempt >= LIMITS.maxAttemptsPerStep) return { state: "retry", reason: res.error }; continue; }
        return { state: "failed", reason: res.error };
      }
      let clean;
      try { clean = sanitizeOffer(readOffer(res.json)); } catch { clean = null; }
      if (!clean) { if (attempt >= LIMITS.maxAttemptsPerStep) return { state: "failed", reason: "avlasning_misslyckades" }; continue; }
      const ok = await store.putExt(idx, { cacheKey, offer: clean, usd: res.cost.usd }, { attempts: attempt });
      if (!ok) return { state: "lost" };
      done = true;
      break;
    }
    if (!done) return { state: "failed", reason: "avlasning_misslyckades" };
  }

  // ---- 2. Jämförelse (ren kod) ----
  const offers = [];
  for (let idx = 0; idx < n; idx++) {
    const e = await store.getExt(idx);
    if (!e || !e.offer) return { state: "failed", reason: "avlasning_saknas" };
    offers.push(e.offer);
  }
  const labels = offerLabels(order.labels, n);
  const compared = compareOffers(offers, labels);

  // ---- 3. Högst ett begränsat ordningssteg (valfritt; bortfall ger fast ordning) ----
  let priority = await store.getAux("priority");
  const synthState = order.work && order.work.steps && order.work.steps.synth ? order.work.steps.synth : { state: "pending", attempts: 0 };
  if (!priority && synthState.state === "pending" && compared.differences.length >= 2 && (synthState.attempts || 0) < 1) {
    if (!(await store.heartbeat())) return { state: "lost" };
    const attempt = await store.stepAttempt("synth", 0);
    if (attempt === null) return { state: "lost" };
    let ids = null;
    try {
      const body = buildSynthRequest({ model, differences: compared.differences });
      const approxTokens = Math.min(LIMITS.synthMaxInputTokens, Math.ceil(JSON.stringify(body).length / 2) + SAFETY_TOKENS);
      const res = await guardedCall({ env, io, key: `syn:${order.id}:${attempt}`, orderId: order.id, scope: "paid", inputTokens: approxTokens, body, model, caps, signalMs: 45_000 });
      if (!res.error) ids = readPriority(res.json, compared.differences);
    } catch (e) {
      if (e instanceof Stop && e.result.reason === "okand_modell") throw e;
      ids = null; // budget nekad eller oläsligt svar: fast ordning, kunden får ändå sin rapport
    }
    if (ids && ids.length) {
      await store.putAux("priority", ids);
      priority = ids;
      await store.markSynth("done");
    } else {
      await store.markSynth("skipped");
    }
  }

  // ---- 4. Rapport ----
  const now = io.now();
  const fresh = await store.order();
  if (!fresh) return { state: "lost" };
  const report = assembleReport({ order: fresh, labels, compared, priority: Array.isArray(priority) ? priority : null, now });
  const reportKey = `cmprep:${order.id}`;
  try {
    await io.kv.put(reportKey, JSON.stringify(report), { expirationTtl: OFFER.retentionHours * 3600 });
  } catch {
    return { state: "retry", reason: "lagring" };
  }
  return { state: "delivered", reportKey };
}

export { ratesFor }; // återexport för tester som vill räkna värsta fallet
