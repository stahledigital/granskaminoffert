// Indatagränser före betalt anrop (paket E, GMO-REVISION-20261009-01 D03).
//
// Gränsen är ett TEKNISKT skydd mot orimligt stora anrop, inte ett budgetbeslut.
// Storleken mäts med Anthropics tokenräknare (`/v1/messages/count_tokens`, gratis
// men med egen anropsgräns) FÖRE det betalda anropet. Kan den inte mäta nekas
// fil-anrop (fail-closed). Text är redan begränsad till 20 000 tecken.

export const DEFAULT_INPUT_TOKEN_LIMIT = 60000;
const COUNT_URL = "https://api.anthropic.com/v1/messages/count_tokens";

// Första byten i filen måste stämma med vad besökaren säger att det är.
export function sniffFile(kind, mediaType, base64) {
  if (kind !== "pdf" && kind !== "image") return { ok: true };
  let head;
  try { head = atob(String(base64).slice(0, 24)); } catch { return { ok: false }; }
  const b = (i) => head.charCodeAt(i);
  const isPdf = head.startsWith("%PDF");
  const isJpeg = b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff;
  const isPng = b(0) === 0x89 && head.slice(1, 4) === "PNG";
  const isGif = head.startsWith("GIF8");
  const isWebp = head.startsWith("RIFF") && head.slice(8, 12) === "WEBP";
  if (kind === "pdf") return { ok: isPdf };
  if (kind === "image") {
    const found = isJpeg ? "image/jpeg" : isPng ? "image/png" : isGif ? "image/gif" : isWebp ? "image/webp" : null;
    return { ok: found !== null, mediaType: found };
  }
  return { ok: true };
}

export async function countInputTokens(env, requestBody, fetchImpl = fetch) {
  // count_tokens tar emot samma fält som messages, men inte max_tokens/temperature.
  const { model, system, messages, tools, tool_choice, thinking } = requestBody;
  const payload = { model, system, messages, tools, tool_choice };
  if (thinking) payload.thinking = thinking;
  const resp = await fetchImpl(COUNT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`count_tokens ${resp.status}`);
  const j = await resp.json();
  if (!Number.isFinite(j.input_tokens)) throw new Error("count_tokens utan input_tokens");
  return j.input_tokens;
}
