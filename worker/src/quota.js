// Kvot och dagstak (paket E, GMO-REVISION-20261009-01 D03).
//
// Tidigare: läs-öka-skriv mot KV, och ett KV-fel räknades som "0 anrop hittills"
// (fail-open). Då fanns i praktiken inget tak när KV svarade fel.
//
// Nu:
//  1. FAIL-CLOSED. Går räknaren inte att läsa eller skriva nekas anropet (503),
//     det släpps aldrig igenom.
//  2. ATOMÄR RESERVATION via Durable Object (`QUOTA`, SQLite-backad): en och
//     samma objektinstans räknar och är enda skrivare (läge "durable_object").
//     Det globala betalda dagstaket KRÄVER detta läge (`requireAtomic`). Saknas
//     bindningen görs ingen reservation och inget betalt anrop (safe-stop).
//  3. KV med lås per nyckel INOM ett isolat (läge "kv_best_effort") används bara
//     för det per-IP-snåla golvet. KV är eventuellt konsistent och isolat är
//     separata, så det är INTE ett hårt tak och aldrig standardväg för betald
//     trafik. Det enda andra hårda taket är en utgiftsgräns hos Anthropic
//     (status: UNKNOWN, ej kontrollerad) – ingen marginal här är en garanti.
//  4. Trasiga räknare (ej heltal, negativa, text) och ogiltig konfiguration
//     (limit) nekar anropet; de räknas aldrig som 0.

const chains = new Map();

// Seriell körning per nyckel inom isolatet.
export function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return next;
}

export function quotaMode(env) {
  return env && env.QUOTA && typeof env.QUOTA.idFromName === "function" && typeof env.QUOTA.get === "function" ? "durable_object" : "kv_best_effort";
}

// Räknare i KV: en saknad nyckel är 0, men allt annat än ett ickenegativt heltal
// (trasigt, negativt, decimaltal, text) är ett fel som nekar anropet. Tidigare
// räknades ett trasigt värde som 0 (fail-open).
export function parseCounter(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(v)) throw new Error("ogiltigt räknarvärde");
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error("ogiltigt räknarvärde");
  return n;
}

// Konfigurerat tak: heltal >= 0 som sträng/tal. Allt annat är ett konfigurationsfel (nekar).
export function parseLimit(v, fallback) {
  const raw = v === undefined || v === null || v === "" ? fallback : v;
  const s = typeof raw === "number" ? String(raw) : raw;
  if (typeof s !== "string" || !/^(0|[1-9][0-9]{0,9})$/.test(s)) return NaN;
  return Number(s);
}

// KV-läsning som kastar vid fel (till skillnad från kvGet i index.js som sväljer).
async function strictGet(env, key) {
  return parseCounter(await env.REVIEWS_KV.get(key));
}

// Reserverar en plats. Returnerar { ok, reason, mode, used }.
//   reason: "limit"  taket nått
//           "fel"    räknaren/konfigurationen kunde inte avgöras: nekat
//           "ingen_atomar_kvot"  atomär reservation krävs men bindning saknas: nekat
// `requireAtomic` (globalt betaltak): utan fungerande Durable Object-bindning görs
// ingen reservation alls och anropet nekas (safe-stop), aldrig kv_best_effort.
export async function reserve(env, { scope, key, limit, ttl, requireAtomic = false, useDurableObject = false }) {
  const atomic = requireAtomic || useDurableObject;
  const mode = atomic ? quotaMode(env) : "kv_best_effort";
  if (!Number.isSafeInteger(limit) || limit < 0) return { ok: false, reason: "fel", mode };
  if (atomic && mode !== "durable_object") return { ok: false, reason: "ingen_atomar_kvot", mode };
  try {
    if (mode === "durable_object") {
      const stub = env.QUOTA.get(env.QUOTA.idFromName(scope));
      const resp = await stub.fetch("https://quota/reserve", { method: "POST", body: JSON.stringify({ key, limit }) });
      if (!resp || !resp.ok) return { ok: false, reason: "fel", mode };
      const j = await resp.json();
      // Svaret valideras: utan ett giltigt format är reservationen inte styrkt.
      if (!j || typeof j.ok !== "boolean" || !Number.isSafeInteger(j.used) || j.used < 0) return { ok: false, reason: "fel", mode };
      if (j.ok) {
        if (j.used < 1 || j.used > limit) return { ok: false, reason: "fel", mode };
        return { ok: true, mode, used: j.used };
      }
      if (j.used < limit) return { ok: false, reason: "fel", mode };
      return { ok: false, reason: "limit", mode, used: j.used };
    }
    return await withLock(`${scope}:${key}`, async () => {
      const current = await strictGet(env, key);
      if (current >= limit) return { ok: false, reason: "limit", mode, used: current };
      await env.REVIEWS_KV.put(key, String(current + 1), { expirationTtl: ttl });
      return { ok: true, mode, used: current + 1 };
    });
  } catch (e) {
    console.log(JSON.stringify({ warn: "quota_fail_closed", scope, error: String(e && e.message || e) }));
    return { ok: false, reason: "fel", mode };
  }
}

// Durable Object (SQLite-backad, se wrangler.toml): en instans per scope, enda
// skrivare av räknaren. Läs-och-skriv sker i en och samma förfrågan utan
// await mellan get och put som ger plats åt annan förfrågan: Cloudflares input
// gate håller andra händelser tills lagringsanropen är klara, och
// blockConcurrencyWhile gör avläsning + skrivning till en odelbar enhet.
export class QuotaCounter {
  constructor(state) { this.state = state; }
  async fetch(request) {
    let body;
    try { body = await request.json(); } catch { return Response.json({ error: "ogiltig förfrågan" }, { status: 400 }); }
    const { key, limit } = body || {};
    if (typeof key !== "string" || !key || key.length > 200 || !Number.isSafeInteger(limit) || limit < 0) {
      return Response.json({ error: "ogiltig förfrågan" }, { status: 400 });
    }
    const run = async () => {
      const rec = await this.state.storage.get(key);
      let n = 0;
      if (rec !== undefined && rec !== null) {
        if (typeof rec !== "object" || !Number.isSafeInteger(rec.n) || rec.n < 0) throw new Error("ogiltig räknare");
        n = rec.n;
      }
      if (n >= limit) return { ok: false, used: n };
      await this.state.storage.put(key, { n: n + 1 });
      return { ok: true, used: n + 1 };
    };
    try {
      const out = typeof this.state.blockConcurrencyWhile === "function" ? await this.state.blockConcurrencyWhile(run) : await run();
      return Response.json(out);
    } catch (e) {
      return Response.json({ error: "räknarfel" }, { status: 500 });
    }
  }
}
