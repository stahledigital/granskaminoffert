// Eget atomärt utgiftstak för AI-förklaringar i Ägarkollen/Synlighetskollen (S3).
// SEPARAT från Granska min offerts kvot (QuotaCounter): en instans, enda skrivare.
//
// Allt räknas i heltal mikro-USD. Reservationen görs FÖRE det betalda anropet med värsta tänkbara
// kostnad (indata i UTF-8-byte, ett token per byte som övre gräns, plus allt tillåtet utdata
// inklusive tänkande). Efter anropet byts reservationen mot uppmätt kostnad (settle); misslyckas
// anropet utan att något kan ha debiterats frigörs den (release). Är räknaren trasig eller
// oläsbar NEKAS anropet (fail-closed), den räknas aldrig som 0.
//
// Lagring: m:<månad> {micro}, d:<dag> {n}, i:<dag>:<hash> {n}. IP-nyckeln är en trunkerad
// SHA-256 av IP+dag och raderas när dagen byts; ingen IP lagras i klartext.

const MAX_MICRO = 1e12;

function readInt(rec, field) {
  if (rec === undefined || rec === null) return 0;
  if (typeof rec !== "object" || !Number.isSafeInteger(rec[field]) || rec[field] < 0 || rec[field] > MAX_MICRO) throw new Error("ogiltig räknare");
  return rec[field];
}

export class ExplainBudget {
  constructor(state) { this.state = state; }
  async fetch(request) {
    let b;
    try { b = await request.json(); } catch { return Response.json({ error: "ogiltig förfrågan" }, { status: 400 }); }
    const path = new URL(request.url).pathname;
    const okInt = (v) => Number.isSafeInteger(v) && v >= 0 && v <= MAX_MICRO;
    const okKey = (v) => typeof v === "string" && /^[0-9a-f]{8,64}$/.test(v);
    const okMonth = (v) => typeof v === "string" && /^\d{4}-\d{2}$/.test(v);
    const okDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
    if (!b || !okMonth(b.month) || !okInt(b.micro)) return Response.json({ error: "ogiltig förfrågan" }, { status: 400 });
    const s = this.state.storage;
    const run = async () => {
      if (path === "/reserve") {
        if (!okDay(b.day) || !okKey(b.ipKey) || !okInt(b.capMicro) || !okInt(b.dayLimit) || !okInt(b.ipLimit)) return { status: 400 };
        const mKey = `m:${b.month}`, dKey = `d:${b.day}`, iKey = `i:${b.day}:${b.ipKey}`;
        const month = readInt(await s.get(mKey), "micro");
        const day = readInt(await s.get(dKey), "n");
        const ip = readInt(await s.get(iKey), "n");
        if (month + b.micro > b.capMicro) return { body: { ok: false, reason: "manad", month } };
        if (day >= b.dayLimit) return { body: { ok: false, reason: "dygn", day } };
        if (ip >= b.ipLimit) return { body: { ok: false, reason: "ip", ip } };
        await s.put(mKey, { micro: month + b.micro });
        await s.put(dKey, { n: day + 1 });
        await s.put(iKey, { n: ip + 1 });
        // Gamla IP-nycklar raderas (bara dagens behålls).
        try {
          const old = await s.list({ prefix: "i:" });
          for (const k of old.keys()) if (!k.startsWith(`i:${b.day}:`)) await s.delete(k);
        } catch { /* städning får inte stoppa reservationen */ }
        return { body: { ok: true, month: month + b.micro, day: day + 1, ip: ip + 1 } };
      }
      if (path === "/settle") {
        // Byter reservationen (micro) mot faktisk kostnad (actual). Aldrig under 0.
        if (!okInt(b.actual)) return { status: 400 };
        const mKey = `m:${b.month}`;
        const month = readInt(await s.get(mKey), "micro");
        await s.put(mKey, { micro: Math.max(0, month - b.micro + b.actual) });
        return { body: { ok: true } };
      }
      if (path === "/release") {
        if (!okDay(b.day) || !okKey(b.ipKey)) return { status: 400 };
        const mKey = `m:${b.month}`, dKey = `d:${b.day}`, iKey = `i:${b.day}:${b.ipKey}`;
        const month = readInt(await s.get(mKey), "micro");
        const day = readInt(await s.get(dKey), "n");
        const ip = readInt(await s.get(iKey), "n");
        await s.put(mKey, { micro: Math.max(0, month - b.micro) });
        await s.put(dKey, { n: Math.max(0, day - 1) });
        await s.put(iKey, { n: Math.max(0, ip - 1) });
        return { body: { ok: true } };
      }
      return { status: 404 };
    };
    try {
      const out = typeof this.state.blockConcurrencyWhile === "function" ? await this.state.blockConcurrencyWhile(run) : await run();
      if (out.status) return Response.json({ error: "ogiltig förfrågan" }, { status: out.status });
      return Response.json(out.body);
    } catch {
      return Response.json({ error: "räknarfel" }, { status: 500 });
    }
  }
}

async function call(env, path, payload) {
  const stub = env.EXPLAIN_BUDGET.get(env.EXPLAIN_BUDGET.idFromName("kollar-explain"));
  const resp = await stub.fetch(`https://explain-budget${path}`, { method: "POST", body: JSON.stringify(payload) });
  if (!resp || !resp.ok) throw new Error("budget " + (resp && resp.status));
  return resp.json();
}

export const budgetAvailable = (env) => Boolean(env && env.EXPLAIN_BUDGET && typeof env.EXPLAIN_BUDGET.idFromName === "function" && typeof env.EXPLAIN_BUDGET.get === "function");

// Reserverar. Returnerar { ok, reason }. Allt som inte är ett tydligt "ok: true" är nekat.
export async function reserveBudget(env, { month, day, ipKey, micro, capMicro, dayLimit, ipLimit }) {
  if (!budgetAvailable(env)) return { ok: false, reason: "ingen_budget" };
  if (![micro, capMicro, dayLimit, ipLimit].every((v) => Number.isSafeInteger(v) && v >= 0)) return { ok: false, reason: "konfig" };
  try {
    const j = await call(env, "/reserve", { month, day, ipKey, micro, capMicro, dayLimit, ipLimit });
    if (!j || typeof j.ok !== "boolean") return { ok: false, reason: "fel" };
    if (j.ok) return Number.isSafeInteger(j.month) && j.month <= capMicro ? { ok: true } : { ok: false, reason: "fel" };
    return ["manad", "dygn", "ip"].includes(j.reason) ? { ok: false, reason: j.reason } : { ok: false, reason: "fel" };
  } catch { return { ok: false, reason: "fel" }; }
}
export async function settleBudget(env, { month, micro, actual }) {
  try { await call(env, "/settle", { month, micro, actual }); return true; } catch { return false; }
}
export async function releaseBudget(env, { month, day, ipKey, micro }) {
  try { await call(env, "/release", { month, day, ipKey, micro }); return true; } catch { return false; }
}
