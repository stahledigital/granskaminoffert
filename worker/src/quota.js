// Kvot och dagstak (paket E, GMO-REVISION-20261009-01 D03).
//
// Tidigare: läs-öka-skriv mot KV, och ett KV-fel räknades som "0 anrop hittills"
// (fail-open). Då fanns i praktiken inget tak när KV svarade fel.
//
// Nu:
//  1. FAIL-CLOSED. Går räknaren inte att läsa eller skriva nekas anropet (503),
//     det släpps aldrig igenom.
//  2. ATOMÄR RESERVATION när en Durable Object-bindning (`QUOTA`) finns: en och
//     samma objektinstans räknar och är enda skrivare (läge "durable_object").
//  3. Utan bindning: KV med lås per nyckel INOM ett isolat (läge "kv_best_effort").
//     KV är eventuellt konsistent och isolat är separata, så två samtidiga anrop
//     i olika isolat/platser kan fortfarande båda få plats på sista platsen.
//     Det är därför INTE ett garanterat hårt kostnadstak. Det enda hårda taket
//     utan Durable Object är en utgiftsgräns hos Anthropic (status: UNKNOWN,
//     ej kontrollerad i detta steg) och ingen marginal här ska beskrivas som garanti.

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
  return env && env.QUOTA && typeof env.QUOTA.idFromName === "function" ? "durable_object" : "kv_best_effort";
}

// KV-läsning som kastar vid fel (till skillnad från kvGet i index.js som sväljer).
async function strictGet(env, key) {
  const v = await env.REVIEWS_KV.get(key);
  const n = parseInt(v || "0", 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Reserverar en plats. Returnerar { ok, reason, mode, used }.
//   reason: "limit" (taket nått) | "fel" (räknaren kunde inte avgöras: nekat)
export async function reserve(env, { scope, key, limit, ttl, useDurableObject = false }) {
  const mode = useDurableObject ? quotaMode(env) : "kv_best_effort";
  if (!Number.isFinite(limit) || limit < 0) return { ok: false, reason: "fel", mode };
  try {
    if (mode === "durable_object") {
      const stub = env.QUOTA.get(env.QUOTA.idFromName(scope));
      const resp = await stub.fetch("https://quota/reserve", { method: "POST", body: JSON.stringify({ key, limit }) });
      if (!resp.ok) return { ok: false, reason: "fel", mode };
      const j = await resp.json();
      return { ok: Boolean(j.ok), reason: j.ok ? undefined : "limit", mode, used: j.used };
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

// Durable Object: en instans per scope, enda skrivare av räknaren. Aktiveras
// bara om wrangler.toml får bindning + migration (se kommentaren där).
export class QuotaCounter {
  constructor(state) { this.state = state; }
  async fetch(request) {
    const { key, limit } = await request.json();
    const rec = (await this.state.storage.get(key)) || { n: 0 };
    if (rec.n >= limit) return Response.json({ ok: false, used: rec.n });
    rec.n += 1;
    await this.state.storage.put(key, rec);
    return Response.json({ ok: true, used: rec.n });
  }
}
