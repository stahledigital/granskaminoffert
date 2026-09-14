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

// REFERENCE_HOURLY_RATES_SEK borttagen 2026-09-14 (Tydlighet v1): tabellen
// hade ingen verifierad källa eller datum. Anders beslut: dölj branschjämförelsen
// helt tills ett riktigt, källbelagt underlag finns, i stället för att visa en
// ospecificerad grön/röd-indikator mot en ograndad tabell. Se
// GRANSKAMINOFFERT_FORSLAG_TYDLIGHET_2026-09-14.md.

const FINDING_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["key", "text"],
  properties: {
    key: {
      type: "string",
      description:
        "Kort svensk rubrik som visas direkt för slutanvändaren, t.ex. " +
        "\"Försäkring / garanti\" eller \"ÄTA (ändringar och tillägg)\". " +
        "ALDRIG en teknisk slug, kod eller engelskt fältnamn (t.ex. inte " +
        "\"f_skatt\" eller \"forsakring_garanti\") — detta är en rubrik, inte " +
        "en identifierare. Max ca 4 ord.",
    },
    text: { type: "string" },
  },
};

const SUBMIT_REVIEW_TOOL = {
  name: "submit_review",
  description:
    "Lämna in den strukturerade granskningen av hantverkaroffert på svenska.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "trade",
      "contradictions",
      "clarify",
      "stated",
      "calcCoverage",
      "calcNote",
      "price",
      "questions",
    ],
    properties: {
      trade: {
        type: "string",
        enum: ["bygg", "tak", "vvs", "el", "malning", "mark", "okand"],
      },
      contradictions: {
        type: "array",
        description:
          "Faktiska motsägelser eller räknefel som HITTATS i dokumentet " +
          "(t.ex. summor som inte stämmer, uppgifter som motsäger " +
          "varandra). Tom lista om inga hittades — se calcCoverage/" +
          "calcNote för om en räknekontroll ens var möjlig att göra.",
        items: FINDING_ITEM_SCHEMA,
      },
      clarify: {
        type: "array",
        description:
          "Sådant som SAKNAS eller är otydligt i dokumentet. Skriv varje " +
          "post som en neutral beskrivning av vad som saknas/är oklart " +
          "(t.ex. \"Inget startdatum anges.\") — ALDRIG som en fråga eller " +
          "uppmaning riktad till någon (inte \"Vilket datum gäller?\" eller " +
          "\"Bestäm det nu\").",
        items: FINDING_ITEM_SCHEMA,
      },
      stated: {
        type: "array",
        description:
          "Uppgifter som TYDLIGT FRAMGÅR av dokumentet. Skriv alltid att " +
          "uppgiften \"anges\"/\"framgår\" — ALDRIG att den är \"kontrollerad\", " +
          "\"verifierad\" eller \"stämmer\" mot en extern källa. Du har bara " +
          "läst vad dokumentet påstår.",
        items: FINDING_ITEM_SCHEMA,
      },
      calcCoverage: {
        type: "string",
        enum: ["checked", "insufficient_data"],
        description:
          "'checked' bara om dokumentet innehåller tillräckliga siffror " +
          "(delbelopp, antal×timpris, ROT-belopp) för att du faktiskt ska " +
          "kunna räkna efter att de stämmer. 'insufficient_data' om " +
          "underlaget inte räcker för en meningsfull kontroll.",
      },
      calcNote: {
        type: "string",
        description:
          "En kort mening på svenska om vad du faktiskt kunde kontrollera " +
          "och vad du kom fram till. Visas alltid, oavsett calcCoverage. " +
          "Detta är en AI-utförd rimlighetskontroll, inte en garanterad " +
          "matematisk verifiering — överdriv aldrig säkerheten.",
      },
      price: {
        type: "object",
        additionalProperties: false,
        required: ["comment"],
        properties: {
          hourlyRateSek: { type: ["number", "null"] },
          totalSumSek: { type: ["number", "null"] },
          rotDeducted: { type: ["boolean", "null"] },
          comment: {
            type: "string",
            description:
              "Kommentar om hur TYDLIGT/FULLSTÄNDIGT priset är angivet i " +
              "dokumentet. Jämför INTE mot någon bransch- eller " +
              "marknadsprisdatabas — ingen sådan källa är kopplad till " +
              "tjänsten just nu.",
          },
        },
      },
      questions: {
        type: "array",
        items: { type: "string" },
        description:
          "3–6 konkreta frågor en MOTTAGARE av offerten kan ställa till " +
          "hantverkaren innan hen skriver på. Alltid frågeformulerat.",
      },
    },
  },
};

function systemPrompt() {
  return `Du är en noggrann, källkritisk läsare av offerter från svenska hantverkare
(bygg, tak, VVS, el, måleri, mark/anläggning), skrivna i Sverige 2026. Du vet
inte om den som läser resultatet är privatpersonen som fått offerten eller
hantverkaren som ska skicka den — skriv därför alltid neutralt, aldrig som en
fråga eller uppmaning riktad till en specifik part.

Du är INTE jurist och uttalar dig aldrig om vad som är juridiskt bindande
eller "godkänt". Du gör ingen bedömning av hantverkaren, företaget eller
arbetets kvalitet — bara av vad som faktiskt går att läsa i dokumentet.

Du får antingen inklistrad text, ett foto eller en PDF av offerten. Läs/tolka
innehållet noggrant, inklusive eventuell bild.

Dela upp granskningen i tre kategorier (motsvarande schemats contradictions/
clarify/stated):

1) contradictions — FAKTISKA motsägelser eller räknefel du HITTAT: belopp som
   inte stämmer när du räknar efter, eller uppgifter som motsäger varandra i
   dokumentet. Bara verkliga fynd. Se räknekontrollen nedan för själva
   uträkningen.

2) clarify — sådant som SAKNAS eller är otydligt: F-skattsedel,
   organisationsnummer, moms (inkl./exkl. tydligt angivet), arbete och
   material specificerade var för sig, omfattning i mått/antal,
   tidplan/startdatum, betalningsvillkor, giltighetstid, hantering av ÄTA
   (ändrings- och tilläggsarbeten), försäkring/garanti. Skriv varje post som
   en neutral beskrivning av vad som saknas eller är oklart (t.ex. "Inget
   startdatum anges."). Undantag ROT-avdrag: flagga bara avsaknad av
   ROT-avdrag här OM kunden verkar vara en privatperson OCH arbetet är av den
   typ som normalt är ROT-berättigad (renovering, reparation, ombyggnad i
   egen bostad). Flagga INTE vid företagskund, nybyggnation eller om det är
   oklart — nämn då inget om ROT alls.

3) stated — det som TYDLIGT FRAMGÅR av dokumentet. Skriv alltid "anges"/
   "framgår". Skriv ALDRIG att något är "kontrollerat", "verifierat" eller
   "stämmer" mot en extern källa (t.ex. Skatteverkets register) — du har bara
   läst vad dokumentet påstår.

Räknekontroll (calcCoverage + calcNote, separat från kategorierna ovan): om
dokumentet innehåller tillräckliga siffror (delbelopp, antal×timpris,
ROT-belopp/procent) för att du faktiskt ska kunna räkna efter, gör det.
- Stämmer det: calcCoverage="checked", calcNote beskriver kort vilken
  uträkning du kontrollerade och att den stämde.
- Stämmer det INTE: calcCoverage="checked", calcNote beskriver avvikelsen,
  och samma sak läggs även till i contradictions.
- Räcker inte siffrorna för en meningsfull kontroll (t.ex. bara en
  totalsumma utan delbelopp): calcCoverage="insufficient_data", calcNote
  beskriver vad som saknas för att kunna kontrollera.
Detta är en AI-utförd rimlighetskontroll, inte en garanterad matematisk
verifiering — var ärlig om osäkerhet i calcNote, överdriv aldrig säkerheten.

PRISBILD: notera timpris (om angivet) och totalsumma i price-fältet. Gissa
aldrig fram ett timpris om det inte anges — notera bara att ingen finns.
Jämför INTE mot något branschgenomsnitt eller någon marknadsprisdatabas; det
finns ingen sådan källa kopplad till tjänsten just nu. comment-fältet
kommenterar bara hur tydligt/fullständigt prisuppgifterna är angivna, aldrig
om priset är rimligt.

Ange alltid yrkeskategori (trade-fältet); välj "okand" om det är oklart.

Skriv på naturlig, rak svenska. Var koncis i varje textfält (max ~2
meningar). Ge 3–6 konkreta frågor (questions-fältet) som en MOTTAGARE av
offerten kan ställa till hantverkaren innan hen skriver på — prioritera det
som faktiskt saknas eller är otydligt i just den här offerten. Detta fält är
alltid frågeformulerat, oavsett vem som i praktiken läser resultatet.

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
    "X-Robots-Tag": "noindex, nofollow, nosnippet",
    "Cache-Control": "no-store",
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

// Andra kostnadsspärr, oberoende av per-IP: per-IP-gränsen går att kringgå
// helt genom att byta IP (VPN, mobildata etc). Detta är ett globalt tak för
// ALLA användare tillsammans per dygn (UTC), som håller värsta möjliga
// dagskostnad förutsägbar oavsett hur ratelimit-gränsen kringgås.
// Standard 150/dygn * ~0.03 USD/anrop ≈ max 4-5 USD/dygn i värsta fall.
async function globalDailyLimitOk(env) {
  const limit = parseInt(env.GLOBAL_DAILY_LIMIT || "150", 10);
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const key = `global:${day}`;
  const current = parseInt((await env.REVIEWS_KV.get(key)) || "0", 10);
  if (current >= limit) return false;
  await env.REVIEWS_KV.put(key, String(current + 1), { expirationTtl: 172800 });
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

  const globalOk = await globalDailyLimitOk(env);
  if (!globalOk) {
    return jsonResponse(
      { error: "Tjänsten har nått sitt dagliga tak för granskningar. Försök igen imorgon." },
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
    temperature: 0, // konsekvens: samma offert ska ge samma bedömning. VERIFIED
    // utan denna gav samma testoffert 62/62/58 vid tre körningar i rad.
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
