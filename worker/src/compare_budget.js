// Atomär kostnadsreservation för modellgenerationer (GMO-LANSERING-20261010-01 D04).
//
// En SQLite-backad Durable Object är enda skrivare. Allt räknas i heltal mikro-USD (µUSD).
// Reservationen görs FÖRE varje betald generation med värsta tänkbara kostnad och byts efter
// anropet mot uppmätt kostnad (settle) eller frigörs (release). Gemensamt månadstak, separata
// deltak per scope ("paid" betald jämförelse, "free" gratisgranskning) och ett tak per order.
//
// FAIL CLOSED: saknas ett tak, är något tak ogiltigt, är räknaren trasig eller har en tidigare
// generation saknat användningsdata (halt) NEKAS reservationen. Det finns inget standardtak;
// siffrorna kommer från konfiguration som en människa satt (compare_config.js).
//
// Reservationer är idempotenta per nyckel: samma (order, steg, försök) reserverar aldrig två gånger.

const MAX_MICRO = 1e12;
const okInt = (v) => Number.isSafeInteger(v) && v >= 0 && v <= MAX_MICRO;
const okPos = (v) => okInt(v) && v > 0;
const okKey = (v) => typeof v === "string" && /^[A-Za-z0-9:_.-]{1,96}$/.test(v);
const okMonth = (v) => typeof v === "string" && /^\d{4}-\d{2}$/.test(v);
const okDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const SCOPES = new Set(["paid", "free"]);

function rec(v, fields) {
  if (v === undefined || v === null) return Object.fromEntries(fields.map((f) => [f, 0]));
  if (typeof v !== "object") throw new Error("ogiltig räknare");
  for (const f of fields) if (!okInt(v[f])) throw new Error("ogiltig räknare");
  return v;
}

export class CompareBudget {
  constructor(state) { this.state = state; }
  async fetch(request) {
    let b;
    try { b = await request.json(); } catch { return Response.json({ error: "ogiltig förfrågan" }, { status: 400 }); }
    const path = new URL(request.url).pathname;
    const s = this.state.storage;
    const run = async () => {
      if (!b || typeof b !== "object") return { status: 400 };
      if (path === "/reserve") {
        const { key, scope, orderId, micro, month, caps } = b;
        if (!okKey(key) || !SCOPES.has(scope) || !okMonth(month) || !okPos(micro) || !caps || typeof caps !== "object") return { status: 400 };
        if (scope === "paid" && !okKey(orderId)) return { status: 400 };
        if (!okPos(caps.joint) || !okPos(caps.scope)) return { body: { ok: false, reason: "konfig" } };
        if (scope === "paid" && !okPos(caps.order)) return { body: { ok: false, reason: "konfig" } };
        if (await s.get("halt")) return { body: { ok: false, reason: "stopp_oklar_anvandning" } };
        const prev = await s.get(`r:${key}`);
        if (prev && (prev.state === "reserved" || prev.state === "settled")) return { body: { ok: true, idempotent: true } };
        const m = rec(await s.get(`m:${month}`), ["total", "paid", "free"]);
        const o = scope === "paid" ? rec(await s.get(`o:${orderId}`), ["total"]) : null;
        if (m.total + micro > caps.joint) return { body: { ok: false, reason: "gemensamt_tak" } };
        if (m[scope] + micro > caps.scope) return { body: { ok: false, reason: "deltak" } };
        if (o && o.total + micro > caps.order) return { body: { ok: false, reason: "ordertak" } };
        await s.put(`m:${month}`, { ...m, total: m.total + micro, [scope]: m[scope] + micro });
        if (o) await s.put(`o:${orderId}`, { total: o.total + micro });
        await s.put(`r:${key}`, { state: "reserved", micro, scope, orderId: orderId || null, month });
        return { body: { ok: true, month: m.total + micro } };
      }
      if (path === "/settle") {
        const { key, actual, usageKnown } = b;
        if (!okKey(key) || !okInt(actual) || typeof usageKnown !== "boolean") return { status: 400 };
        const r = await s.get(`r:${key}`);
        if (!r || r.state !== "reserved") return { body: { ok: false, reason: "okand_reservation" } };
        // Okänd användning: behåll värsta fallet och stoppa nya generationer tills en människa nollar stoppet.
        const final = usageKnown ? actual : r.micro;
        const m = rec(await s.get(`m:${r.month}`), ["total", "paid", "free"]);
        const delta = final - r.micro;
        await s.put(`m:${r.month}`, { ...m, total: Math.max(0, m.total + delta), [r.scope]: Math.max(0, m[r.scope] + delta) });
        if (r.orderId) { const o = rec(await s.get(`o:${r.orderId}`), ["total"]); await s.put(`o:${r.orderId}`, { total: Math.max(0, o.total + delta) }); }
        await s.put(`r:${key}`, { ...r, state: "settled", actual: final, overrun: usageKnown && actual > r.micro });
        if (!usageKnown) await s.put("halt", { reason: "okand_anvandning", key });
        return { body: { ok: true, overrun: usageKnown && actual > r.micro, halted: !usageKnown } };
      }
      if (path === "/release") {
        const { key } = b;
        if (!okKey(key)) return { status: 400 };
        const r = await s.get(`r:${key}`);
        if (!r || r.state !== "reserved") return { body: { ok: true, noop: true } };
        const m = rec(await s.get(`m:${r.month}`), ["total", "paid", "free"]);
        await s.put(`m:${r.month}`, { ...m, total: Math.max(0, m.total - r.micro), [r.scope]: Math.max(0, m[r.scope] - r.micro) });
        if (r.orderId) { const o = rec(await s.get(`o:${r.orderId}`), ["total"]); await s.put(`o:${r.orderId}`, { total: Math.max(0, o.total - r.micro) }); }
        await s.put(`r:${key}`, { ...r, state: "released" });
        return { body: { ok: true } };
      }
      if (path === "/capacity") {
        const { month, caps } = b;
        if (!okMonth(month) || !caps || !okPos(caps.joint) || !okPos(caps.scope)) return { body: { ok: false, reason: "konfig" } };
        const scope = SCOPES.has(b.scope) ? b.scope : "paid";
        const m = rec(await s.get(`m:${month}`), ["total", "paid", "free"]);
        const halted = !!(await s.get("halt"));
        return { body: { ok: true, halted, remaining: Math.max(0, Math.min(caps.joint - m.total, caps.scope - m[scope])) } };
      }
      if (path === "/count") {
        // Dygnsräknare för nya ordrar (skydd mot lagrings-/missbruk, inget kostnadstak).
        const { day, limit, name } = b;
        if (!okDay(day) || !okPos(limit) || !okKey(name)) return { status: 400 };
        const k = `c:${name}:${day}`;
        const n = (await s.get(k)) || 0;
        if (!okInt(n)) throw new Error("ogiltig räknare");
        if (n >= limit) return { body: { ok: false, reason: "dygn", n } };
        await s.put(k, n + 1);
        return { body: { ok: true, n: n + 1 } };
      }
      if (path === "/stats") {
        // Skrivskyddad läsning för test/drift: aldrig hemligheter eller orderinnehåll.
        const { month } = b;
        if (!okMonth(month)) return { status: 400 };
        return { body: { ok: true, month: rec(await s.get(`m:${month}`), ["total", "paid", "free"]), halted: !!(await s.get("halt")) } };
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
  const stub = env.COMPARE_BUDGET.get(env.COMPARE_BUDGET.idFromName("jamfor-budget"));
  const resp = await stub.fetch(`https://compare-budget${path}`, { method: "POST", body: JSON.stringify(payload) });
  if (!resp || !resp.ok) throw new Error("budget " + (resp && resp.status));
  return resp.json();
}

export const budgetBindingAvailable = (env) => Boolean(env && env.COMPARE_BUDGET && typeof env.COMPARE_BUDGET.idFromName === "function" && typeof env.COMPARE_BUDGET.get === "function");

export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
export const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

// Allt som inte är ett tydligt ok:true är nekat.
export async function reserve(env, { key, scope, orderId, micro, caps, now = new Date() }) {
  if (!budgetBindingAvailable(env)) return { ok: false, reason: "ingen_budget" };
  try {
    const j = await call(env, "/reserve", { key, scope, orderId, micro, caps, month: monthKey(now) });
    return j && j.ok === true ? { ok: true, idempotent: !!j.idempotent } : { ok: false, reason: (j && typeof j.reason === "string" && j.reason) || "fel" };
  } catch { return { ok: false, reason: "fel" }; }
}
export async function settle(env, { key, actual, usageKnown }) {
  try { const j = await call(env, "/settle", { key, actual, usageKnown }); return !!(j && j.ok); } catch { return false; }
}
export async function release(env, { key }) {
  try { const j = await call(env, "/release", { key }); return !!(j && j.ok); } catch { return false; }
}
export async function capacity(env, { caps, scope = "paid", now = new Date() }) {
  if (!budgetBindingAvailable(env)) return { ok: false, remaining: 0, halted: false };
  try {
    const j = await call(env, "/capacity", { caps, scope, month: monthKey(now) });
    return j && j.ok ? { ok: true, remaining: j.remaining, halted: !!j.halted } : { ok: false, remaining: 0, halted: false };
  } catch { return { ok: false, remaining: 0, halted: false }; }
}
export async function countToday(env, { name, limit, now = new Date() }) {
  if (!budgetBindingAvailable(env)) return { ok: false };
  try { const j = await call(env, "/count", { name, limit, day: dayKey(now) }); return { ok: !!(j && j.ok) }; } catch { return { ok: false }; }
}
export async function stats(env, { now = new Date() } = {}) {
  const j = await call(env, "/stats", { month: monthKey(now) });
  return j;
}

// µUSD ur USD (avrundat uppåt – reservation får aldrig underskatta).
export const usdToMicro = (usd) => Math.ceil(usd * 1e6 - 1e-9);
