// Leverantörsgemensamt för Workern och F2-körningen (F8c). Ligger i en egen modul eftersom
// Cloudflare-runtimen inte tillåter att huvudmodulen exporterar andra värden än funktioner och
// hanterare: namngivna strängexporter från src/index.js gav ERR_RUNTIME_FAILURE vid start.
export const ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// Plockar ut granskningen ur ett Messages-svar. Samma regler för Workern och F2-provet:
// ett avkortat (max_tokens) eller nekat (refusal) svar, eller ett svar utan verktygsanrop,
// är ett fel – aldrig ett godkänt svar, även om verktygsinmatningen råkar se komplett ut.
export function readReview(respJson) {
  if (!respJson || typeof respJson !== "object") throw new Error("Modellsvaret saknas");
  if (respJson.stop_reason === "max_tokens") {
    // Avkortat svar ger halva extracted-fält, och prisreglerna skulle räkna
    // vidare på dem som om de vore avlästa ur offerten. Hellre inget svar.
    throw new Error("Modellsvaret kapades (max_tokens) – offerten är för lång för en säker avläsning");
  }
  if (respJson.stop_reason === "refusal") throw new Error("Modellen avstod från att svara (refusal)");
  const toolUse = (respJson.content || []).find((b) => b.type === "tool_use" && b.name === "submit_review");
  if (!toolUse) throw new Error("Modellen returnerade inget submit_review-anrop");
  const input = toolUse.input;
  // extracted är obligatoriskt: utan det skulle sanering ge ett tomt objekt (allt null/okänd moms) som
  // ser ut som en lyckad men tom avläsning. Hellre fel än en tyst tom granskning (Codex 2026-10-09).
  if (!input || typeof input !== "object" || !input.extracted || typeof input.extracted !== "object" || Array.isArray(input.extracted)) {
    throw new Error("Modellsvaret saknar avläsningen (extracted)");
  }
  return input;
}
