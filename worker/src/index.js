// Granska min offert — granskningsmotor (Cloudflare Worker)
//
// EVIDENSNOT: Byggd 2026-09-14, ej ännu E2E-testad mot skarpt Anthropic API
// (ANTHROPIC_API_KEY saknas i den här sessionen). Markera VERIFIED först efter
// en riktig körning med uppmätt latens/kostnad — se worker/README.md.
//
// Dataminimering (Anders beslut 2026-09-14): ingen permanent lagring. Varje
// förfrågan + svar sparas i REVIEWS_KV med expirationTtl 24h enbart för
// felsökning, och raderas automatiskt av Cloudflare — ingen manuell radering
// krävs. Inget annat lager (ingen databas, inga externa loggtjänster).

const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// USD-priser per miljon tokens. Källa: Anthropic prislista, uppdatera vid
// modellbyte. SEK-omräkning är en grov, deklarerad uppskattning — kostnaden
// i USD är den exakta, mätta siffran.
const MODEL_PRICING_USD_PER_MTOK = {
  "claude-sonnet-4-5-20250929": { input: 3.0, output: 15.0 },
};
const USD_TO_SEK_APPROX = 10.5; // grov uppskattning, inte en live-kurs

const REFERENCE_HOURLY_RATES_SEK = {
  bygg: { label: "Snickeri / bygg", low: 450, high: 750 },
  tak: { label: "Tak", low: 500, high: 800 },
  vvs: { label: "VVS", low: 550, high: 900 },
  el: { label: "El", low: 550, high: 900 },
  malning: { label: "Måleri", low: 400, high: 650 },
  mark: { label: "Mark / anläggning", low: 450, high: 750 },
  okand: { label: "Hantverkarjobb (okänd yrkeskategori)", low: 450, high: 800 },
};

const SUBMIT_REVIEW_TOOL = {
  name: "submit_review",
  description:
    "Lämna in den strukturerade granskningen av hantverkaroffert på svenska.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "score",
      "verdict",
      "title",
      "subtitle",
      "checklist",
      "price",
      "questions",
    ],
    properties: {
      score: { type: "integer", minimum: 0, maximum: 100 },
      verdict: { type: "string", enum: ["bra", "fragor", "ny_offert"] },
      title: { type: "string" },
      subtitle: { type: "string" },
      trade: {
        type: "string",
        enum: ["bygg", "tak", "vvs", "el", "malning", "mark", "okand"],
      },
      checklist: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["key", "status", "text"],
          properties: {
            key: { type: "string" },
            status: { type: "string", enum: ["ok", "warn", "bad"] },
            text: { type: "string" },
          },
        },
      },
      price: {
        type: "object",
        additionalProperties: false,
        required: ["comment"],
        properties: {
          hourlyRateSek: { type: ["number", "null"] },
          hourlyRangeLowSek: { type: ["number", "null"] },
          hourlyRangeHighSek: { type: ["number", "null"] },
          totalSumSek: { type: ["number", "null"] },
          rotDeducted: { type: ["boolean", "null"] },
          comment: { type: "string" },
        },
      },
      questions: { type: "array", items: { type: "string" } },
    },
  },
};

function systemPrompt() {
  const rateLines = Object.entries(REFERENCE_HOURLY_RATES_SEK)
    .map(([k, v]) => `- ${v.label} (${k}): ${v.low}–${v.high} kr/h inkl. moms`)
    .join("\n");

  return `Du är en noggrann, källkritisk granskare av offerter från svenska hantverkare
(bygg, tak, VVS, el, måleri, mark/anläggning) åt en privatperson i Sverige 2026.
Du är INTE jurist och ger inget juridiskt bindande utlåtande — säg aldrig att
offerten är "godkänd" i juridisk mening.

Du får antingen inklistrad text, ett foto eller en PDF av offerten. Läs/tolka
innehållet noggrant, inklusive eventuell bild.

Bedöm i tre lager:

1) FORMALIA (deterministiskt, leta efter faktiska uppgifter i texten):
   F-skattsedel, organisationsnummer, moms (inkl./exkl. tydligt angivet),
   ROT-avdrag redovisat på arbetskostnaden, arbete och material specificerade
   var för sig, omfattning i mått/antal, tidplan/startdatum, betalningsvillkor,
   giltighetstid, hantering av ÄTA (ändrings- och tilläggsarbeten),
   försäkring/garanti.

2) INNEHÅLL: är omfattningen tydlig och rimlig för jobbet? Är beskrivningen
   tillräckligt konkret för att undvika tvist om vad som ingår?

3) PRISBILD: jämför angivet timpris (om det finns) mot dessa referensspann för
   svenska hantverkare 2026 (grova, ungefärliga branschvärden — INTE en exakt
   källa, säg alltid att det är en uppskattning och att en andra offert är det
   säkraste sättet att kontrollera pris):
${rateLines}
   Om inget timpris anges men en totalsumma finns: notera det, gissa inte fram
   ett timpris. Ange alltid vilken yrkeskategori du bedömer jobbet tillhöra
   ("trade"-fältet); välj "okand" om det är oklart.

Sätt score 0–100 (dra ifrån för varje "bad", mindre för varje "warn"). Sätt
verdict: "bra" (≥80), "fragor" (55–79), "ny_offert" (<55).

Skriv på naturlig, rak svenska. Var koncis i varje textfält (max ~2 meningar).
Ge 3–6 konkreta frågor att ställa hantverkaren innan kunden skriver på —
prioritera det som faktiskt saknas eller är otydligt i just den här offerten.

Du MÅSTE svara genom att anropa verktyget submit_review med ett komplett,
schema-giltigt resultat. Skriv inget annat brödtextsvar.`;
}

function corsHeaders(origin, allowedOrigins) {
  const allowOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function jsonResponse(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

async function rateLimit(env, ip) {
  const limit = parseInt(env.RATE_LIMIT_PER_HOUR || "8", 10);
  const bucket = Math.floor(Date.now() / 3600000); // timme-bucket
  const key = `rl:${ip}:${bucket}`;
  const current = parseInt((await env.REVIEWS_KV.get(key)) || "0", 10);
  if (current >= limit) return false;
  await env.REVIEWS_KV.put(key, String(current + 1), { expirationTtl: 3600 });
  return true;
}

function extractReview(anthropicJson) {
  const toolUse = (anthropicJson.content || []).find(
    (b) => b.type === "tool_use" && b.name === "submit_review"
  );
  if (!toolUse) throw new Error("Modellen returnerade inget submit_review-anrop");
  return toolUse.input;
}

function computeCostUsd(model, usage) {
  const pricing = MODEL_PRICING_USD_PER_MTOK[model];
  if (!pricing || !usage) return null;
  const inputUsd = (usage.input_tokens / 1e6) * pricing.input;
  const outputUsd = (usage.output_tokens / 1e6) * pricing.output;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    usd: Number((inputUsd + outputUsd).toFixed(6)),
  };
}

async function handleReview(request, env, ctx, allowedOrigins) {
  const origin = request.headers.get("Origin") || "";
  const headers = corsHeaders(origin, allowedOrigins);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const debugId = crypto.randomUUID();
  const startedAt = Date.now();

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Ogiltig förfrågan (JSON)." }, 400, headers);
  }

  const { kind, text, dataBase64, mediaType, filename } = body || {};
  const maxBytes = parseInt(env.MAX_UPLOAD_BYTES || "8000000", 10);

  if (!kind || (kind === "text" && !text) || (kind !== "text" && !dataBase64)) {
    return jsonResponse({ error: "Ingen offert att granska." }, 400, headers);
  }
  if (kind === "text" && text.length > 20000) {
    return jsonResponse({ error: "Texten är för lång (max 20 000 tecken)." }, 400, headers);
  }
  if (kind !== "text" && dataBase64.length * 0.75 > maxBytes) {
    return jsonResponse({ error: "Filen är för stor (max ~8 MB)." }, 400, headers);
  }

  const allowed = await rateLimit(env, ip);
  if (!allowed) {
    return jsonResponse(
      { error: "För många granskningar just nu. Försök igen om en stund." },
      429,
      headers
    );
  }

  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse(
      { error: "Tjänsten är inte klar än (saknar API-nyckel). Försök igen senare." },
      503,
      headers
    );
  }

  const userContent = [];
  if (kind === "text") {
    userContent.push({ type: "text", text: `Här är offerten (inklistrad text):\n\n${text}` });
  } else if (kind === "image") {
    userContent.push({ type: "text", text: "Här är ett foto av offerten:" });
    userContent.push({
      type: "image",
      source: { type: "base64", media_type: mediaType || "image/jpeg", data: dataBase64 },
    });
  } else if (kind === "pdf") {
    userContent.push({ type: "text", text: "Här är offerten som PDF:" });
    userContent.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: dataBase64 },
    });
  } else {
    return jsonResponse({ error: "Okänt filformat." }, 400, headers);
  }

  const model = env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";
  const anthropicBody = {
    model,
    max_tokens: 2000,
    system: systemPrompt(),
    messages: [{ role: "user", content: userContent }],
    tools: [SUBMIT_REVIEW_TOOL],
    tool_choice: { type: "tool", name: "submit_review" },
  };

  let review, usage, rawStatus, errorDetail;
  try {
    const resp = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(anthropicBody),
    });
    rawStatus = resp.status;
    const respJson = await resp.json();
    if (!resp.ok) {
      errorDetail = respJson;
      throw new Error(`Anthropic API ${resp.status}: ${JSON.stringify(respJson).slice(0, 500)}`);
    }
    review = extractReview(respJson);
    usage = respJson.usage;
  } catch (e) {
    ctx.waitUntil(
      env.REVIEWS_KV.put(
        `debug:${debugId}`,
        JSON.stringify({
          ts: new Date().toISOString(),
          ip,
          kind,
          filename: filename || null,
          error: String(e),
          errorDetail: errorDetail || null,
          rawStatus: rawStatus || null,
        }),
        { expirationTtl: 86400 }
      )
    );
    return jsonResponse(
      { error: "Granskningen misslyckades just nu. Försök igen om en stund.", debugId },
      502,
      headers
    );
  }

  const latencyMs = Date.now() - startedAt;
  const cost = computeCostUsd(model, usage);

  ctx.waitUntil(
    env.REVIEWS_KV.put(
      `debug:${debugId}`,
      JSON.stringify({
        ts: new Date().toISOString(),
        ip,
        kind,
        filename: filename || null,
        model,
        latencyMs,
        usage,
        costUsd: cost ? cost.usd : null,
        review,
      }),
      { expirationTtl: 86400 }
    )
  );

  return jsonResponse(
    {
      ...review,
      meta: {
        model,
        latencyMs,
        costUsd: cost ? cost.usd : null,
        costSekApprox: cost ? Number((cost.usd * USD_TO_SEK_APPROX).toFixed(2)) : null,
      },
    },
    200,
    headers
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const allowedOrigins = (env.ALLOWED_ORIGIN || "https://granskaminoffert.se")
      .split(",")
      .map((s) => s.trim());
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin, allowedOrigins) });
    }

    if (url.pathname === "/health") {
      return jsonResponse(
        { ok: true, hasApiKey: Boolean(env.ANTHROPIC_API_KEY) },
        200,
        corsHeaders(origin, allowedOrigins)
      );
    }

    if (url.pathname === "/review" && request.method === "POST") {
      return handleReview(request, env, ctx, allowedOrigins);
    }

    return jsonResponse({ error: "Not found" }, 404, corsHeaders(origin, allowedOrigins));
  },
};
