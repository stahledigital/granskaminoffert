// F2 – AI-prov mot facit, med hård budgetspärr. KÖRS INTE utan ett konkret budgetbeslut från Anders.
//
// Användning (först efter beslut, nyckeln läses ur miljön och skrivs aldrig ut):
//   F2_BUDGET_APPROVED=yes F2_BUDGET_USD=<högsta belopp i USD> F2_MAX_CALLS=<högsta antal betalda anrop> \
//   ANTHROPIC_API_KEY=... node scripts/f2_run.mjs [modell]
//
// Vad körningen gör:
//  - Bygger varje begäran med SAMMA byggare som Workern (buildReviewRequest) på de syntetiska
//    texterna i worker/test/f2/facit.json. Inga riktiga offerter, inga personuppgifter.
//  - FÖRE varje betalt anrop mäts indata exakt med Anthropics kostnadsfria tokenräknare och
//    värsta tänkbara kostnad reserveras: indata × indatapris + max_tokens × utdatapris, med
//    modellens nivåpris (Haiku 5.5 kostar mer för hela begäran över 100 000 indatatokens).
//    Överstiger spenderat + reservation budgeten startas anropet inte. Kan kostnaden inte
//    bestämmas (okänd modell, tokenräknaren svarar fel, användning saknas i svaret) stoppar
//    hela körningen. Efter anropet bokförs faktisk kostnad (aldrig lägre än den uppmätta).
//  - Exakta tak: högst F2_MAX_CALLS betalda anrop och högst F2_BUDGET_USD i reserverad+bokförd
//    kostnad. Båda måste anges; saknas eller är de ogiltiga körs inget.
//  - Utskriften innehåller bara fall-id, avvikelser och summering. Nyckel, rubriker och
//    begäran skrivs aldrig ut.
//
// Exitkoder: 0 klar utan avvikelser · 1 klar med avvikelser · 2 ej godkänd/ogiltig konfiguration ·
//            3 avbruten (budget, anropstak, okänd kostnad eller fel) innan alla fall kördes.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { buildReviewRequest, buildPriceReport } from "../worker/src/index.js";
import { ANTHROPIC_URL, ANTHROPIC_VERSION, readReview } from "../worker/src/provider.js";
import { sanitizeExtracted } from "../worker/src/sanitize.js";
import { modelInfo, computeCost, worstCaseUsd, DEFAULT_MODEL } from "../worker/src/models.js";
import { countInputTokens } from "../worker/src/limits.js";

const FACIT_URL = new URL("../worker/test/f2/facit.json", import.meta.url);

const posNumber = (v) => {
  if (typeof v !== "string" || !/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(v.trim())) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const posInt = (v) => {
  if (typeof v !== "string" || !/^[1-9][0-9]{0,5}$/.test(v.trim())) return null;
  return Number(v);
};

// Delmängdsjämförelse mellan förväntad och faktisk avläsning.
function diffExtracted(expect, got) {
  const out = [];
  for (const [k, want] of Object.entries(expect || {})) {
    const have = got[k] === undefined ? null : got[k];
    if (have !== want) out.push({ field: k, want, got: have });
  }
  return out;
}

function ruleStatuses(rep) {
  const m = new Map();
  for (const r of rep.checked || []) m.set(r.id, r.status);
  for (const r of rep.compared || []) m.set(r.id, r.mode);
  for (const r of rep.cannotAssess || []) m.set(r.id || r.title, "ej_bedombar");
  return m;
}

function diffRules(expect, rep) {
  const have = ruleStatuses(rep);
  const out = [];
  for (const [id, want] of Object.entries(expect || {})) {
    let got = have.get(id) ?? "saknas";
    if (id === "projekt" && (rep.cannotAssess || []).some((r) => /Spannet|jämföra/.test(r.text))) got = "ej_bedombar";
    if (got !== want) out.push({ rule: id, want, got });
  }
  return out;
}

// Körningen är fristående från processmiljön så att den kan provas helt offline.
//   opts: { env, argv, fetchImpl, cases, write }
// Returnerar { exitCode, summary, results }.
export async function runF2({ env = {}, argv = [], fetchImpl = fetch, cases, write = (s) => process.stdout.write(s + "\n") } = {}) {
  const log = (s) => write(String(s));
  if (env.F2_BUDGET_APPROVED !== "yes") {
    log("Avbryter: ingen betald AI-testbudget är beslutad (F2_BUDGET_APPROVED=yes saknas).");
    return { exitCode: 2, summary: { reason: "ej_godkand", calls: 0, spentUsd: 0 }, results: [] };
  }
  const budget = posNumber(env.F2_BUDGET_USD);
  const maxCalls = posInt(env.F2_MAX_CALLS);
  if (budget === null || maxCalls === null) {
    log("Avbryter: F2_BUDGET_USD (positivt belopp i USD) och F2_MAX_CALLS (heltal) måste båda anges exakt.");
    return { exitCode: 2, summary: { reason: "ogiltiga_tak", calls: 0, spentUsd: 0 }, results: [] };
  }
  if (typeof env.ANTHROPIC_API_KEY !== "string" || env.ANTHROPIC_API_KEY.length < 8) {
    log("Avbryter: ANTHROPIC_API_KEY saknas i miljön.");
    return { exitCode: 2, summary: { reason: "nyckel_saknas", calls: 0, spentUsd: 0 }, results: [] };
  }
  const model = argv[0] || env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const info = modelInfo(model);
  if (!info) {
    log(`Avbryter: modellen ${JSON.stringify(String(model).slice(0, 80))} finns inte i prismodellen, så kostnaden kan inte begränsas.`);
    return { exitCode: 2, summary: { reason: "okand_modell", calls: 0, spentUsd: 0 }, results: [] };
  }
  const list = cases || JSON.parse(readFileSync(FACIT_URL, "utf8")).cases;

  let calls = 0;
  let spent = 0; // bokförd (faktisk eller konservativt reserverad) kostnad i USD
  const results = [];
  let stop = null;

  log(`F2-körning: modell ${model}, tak ${budget} USD och ${maxCalls} betalda anrop, ${list.length} syntetiska fall.`);

  for (const c of list) {
    if (calls >= maxCalls) { stop = "anropstak"; break; }
    const body = buildReviewRequest({ model, kind: "text", text: c.text });

    // 1. Exakt indatamätning (gratis). Kan den inte göras: okänd kostnad → stopp.
    let inTok;
    try {
      inTok = await countInputTokens({ ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY }, body, fetchImpl);
    } catch {
      stop = "okand_kostnad_tokenmatning";
      break;
    }
    // 2. Reservera värsta tänkbara kostnad innan anropet.
    const reserve = worstCaseUsd(model, inTok); // nivåmedveten (Haiku över 100 000 indatatokens)
    if (reserve === null) { stop = "okand_kostnad_reservation"; break; }
    if (spent + reserve > budget) { stop = "budget"; break; }

    // 3. Det betalda anropet.
    calls += 1;
    let respJson = null, status = null;
    try {
      const resp = await fetchImpl(ANTHROPIC_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": ANTHROPIC_VERSION },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90000),
      });
      status = resp.status;
      respJson = await resp.json();
    } catch {
      // Anropet kan ha debiterats: bokför reservationen och stoppa.
      spent += reserve;
      results.push({ id: c.id, error: "nätverksfel_eller_ogiltigt_svar", status });
      stop = "fel_efter_anrop";
      break;
    }
    const cost = computeCost(model, respJson && respJson.usage);
    if (cost.status !== "känd") {
      spent += reserve; // okänd faktisk kostnad: anta värsta fallet och stoppa
      results.push({ id: c.id, error: "kostnad_okand", status });
      stop = "okand_kostnad";
      break;
    }
    spent += cost.usd; // faktisk kostnad ur svarets användning
    if (cost.usd > reserve + 1e-9) { // reservationen höll inte: mätningen stämde inte med debiteringen
      results.push({ id: c.id, error: "kostnad_over_reservation", costUsd: cost.usd });
      stop = "kostnad_over_reservation";
      break;
    }
    if (!(status >= 200 && status < 300)) {
      results.push({ id: c.id, error: "http_" + status });
      continue;
    }
    let extracted;
    try {
      extracted = sanitizeExtracted(readReview(respJson).extracted || {}).x;
    } catch (e) {
      // samma avvisningar som Workern: max_tokens, refusal, saknat verktygsanrop är fel, aldrig PASS
      const why = /max_tokens/.test(String(e.message)) ? "max_tokens" : /refusal/.test(String(e.message)) ? "refusal" : "saknar_submit_review";
      results.push({ id: c.id, error: why, costUsd: cost.usd });
      continue;
    }
    const rep = buildPriceReport(extracted, []);
    results.push({ id: c.id, extractDiff: diffExtracted(c.expectExtracted, extracted), ruleDiff: diffRules(c.expectRules, rep), costUsd: cost.usd });
  }

  const mism = results.filter((r) => r.error || r.extractDiff.length || r.ruleDiff.length);
  for (const r of results) {
    if (r.error) log(`${r.id}: FEL ${r.error}`);
    else if (!r.extractDiff.length && !r.ruleDiff.length) log(`${r.id}: PASS`);
    else log(`${r.id}: AVVIKER ${JSON.stringify({ extract: r.extractDiff, rules: r.ruleDiff })}`);
  }
  const summary = {
    model, calls, maxCalls, spentUsd: Number(spent.toFixed(6)), budgetUsd: budget,
    casesRun: results.length, casesPlanned: list.length, stopped: stop,
    pass: results.filter((r) => !r.error && !r.extractDiff.length && !r.ruleDiff.length).length,
    note: "Kostnad är bokförd ur svarets användning och prismodellen i models.js; leverantörens faktiska faktura är UNKNOWN.",
  };
  log(`Summering: ${JSON.stringify(summary)}`);
  const exitCode = stop ? 3 : mism.length ? 1 : 0;
  return { exitCode, summary, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { exitCode } = await runF2({ env: process.env, argv: process.argv.slice(2) });
  process.exit(exitCode);
}
