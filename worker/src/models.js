// Modelltabell och anropsbyggare (paket F1, GMO-REVISION-20261009-01 D03).
//
// Källa (primärdokumentation Anthropic, läst 2026-10-09):
//  - platform.claude.com/docs/en/models/overview: claude-sonnet-5-5 $2 / $10 per MTok,
//    1M kontext.
//  - .../about-claude/model-deprecations: claude-sonnet-4-5-20250929 "Deprecated"
//    2026-09-30, "Tentative retirement date" 2026-11-30, rekommenderad ersättare
//    claude-sonnet-5-5. "Requests to models past the retirement date will fail."
//  - .../models/sonnet-5-5/migration-guide: (1) tool_choice "any"/"tool" ger 400
//    ("tool_choice: type "tool" and "any" are not supported for this model."), ersätt
//    med "auto" och instruktion i prompten; (2) temperature/top_p/top_k med
//    icke-standardvärde ger 400; (3) thinking körs som standard, `disabled` ger 400,
//    `{"type":"between_tools"}` är lägsta nivån; (4) ny tokenizer, ~30 % fler tokens
//    för samma text och upp till 4 784 bildtokens per bild.
//  - .../build-with-claude/structured-outputs: strikta verktyg tillåter högst 16
//    parametrar med unionstyper (type-arrays/anyOf) totalt. Vårt extracted-schema
//    har fler än så, så `strict: true` används INTE; svaret valideras i stället
//    i kod (sanitize.js), vilket migrationsguiden anger som alternativ.
//
// Vad detta INTE bevisar: att modellens avläsning av riktiga offerter är lika
// bra på claude-sonnet-5-5 som på 4.5. Anropsformen är testad mot mock; träffsäkerhet
// är EJ TESTAT tills ett F2-prov med riktigt AI-anrop godkänts (se F2_FACIT).

export const DEFAULT_MODEL = "claude-sonnet-5-5";

export const MODELS = {
  "claude-sonnet-4-5-20250929": {
    inputUsdPerMTok: 3.0,
    outputUsdPerMTok: 15.0,
    forcedTool: true,
    sampling: true,
    thinking: null,
    maxTokens: 4000,
    lifecycle: "deprecated 2026-09-30, tentative retirement 2026-11-30",
  },
  "claude-sonnet-5-5": {
    inputUsdPerMTok: 2.0,
    outputUsdPerMTok: 10.0,
    forcedTool: false,
    sampling: false,
    thinking: { type: "between_tools" },
    maxTokens: 6000, // tänkande räknas som utdata; 4 000 räckte inte på äldre modell med lång offert
    lifecycle: "current",
  },
};

const own = (o, k) => typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);

export function modelInfo(id) {
  return own(MODELS, id) ? MODELS[id] : null;
}

// Okänd modell får ett försiktigt anrop (inga samplingparametrar, tool_choice auto,
// ingen thinking-parameter) och kostnadsstatus "okand".
const GENERIC = { forcedTool: false, sampling: false, thinking: null, maxTokens: 6000 };

export function buildAnthropicRequest({ model, system, userContent, tool }) {
  const m = modelInfo(model) || GENERIC;
  const body = {
    model,
    max_tokens: m.maxTokens,
    system: m.forcedTool ? system : `${system}\n\nAnropa verktyget ${tool.name} med din granskning. Svara inte med brödtext.`,
    messages: [{ role: "user", content: userContent }],
    tools: [tool],
    tool_choice: m.forcedTool ? { type: "tool", name: tool.name } : { type: "auto" },
  };
  // temperature 0: samma offert ska ge samma bedömning (VERIFIED 2026-09 på 4.5:
  // utan den gav samma testoffert 62/62/58). Nyare modeller avvisar parametern.
  if (m.sampling) body.temperature = 0;
  if (m.thinking) body.thinking = { ...m.thinking };
  return body;
}

// Kostnad ur faktisk användning. Okänd modell eller saknad användning ger
// status "okand" och usd null – aldrig ett påhittat belopp.
export function computeCost(model, usage) {
  const m = modelInfo(model);
  const inTok = usage && Number.isFinite(usage.input_tokens) ? usage.input_tokens : null;
  const outTok = usage && Number.isFinite(usage.output_tokens) ? usage.output_tokens : null;
  if (!m || inTok === null || outTok === null) {
    return { status: "okand", inputTokens: inTok, outputTokens: outTok, usd: null };
  }
  const usd = (inTok / 1e6) * m.inputUsdPerMTok + (outTok / 1e6) * m.outputUsdPerMTok;
  return { status: "känd", inputTokens: inTok, outputTokens: outTok, usd: Number(usd.toFixed(6)) };
}
