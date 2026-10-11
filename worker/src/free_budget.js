// D12: separat kostnadsskydd för GRATISVERSIONEN (/review och /explain). Minimalt och fristående: inga jämförelse-, betal-,
// Google-, kortbetalnings- eller mejlberoenden. Enda importen är models.js (pris/värsta fall).
//
// ENDLIG PILOT, inget kalenderomslag: tillåten förbrukning gäller en enda pilotperiod [FROM, UNTIL) och ett enda tak i µUSD (TOTALT,
// inte per månad). Vid månadsskifte börjar INGEN ny pott. Efter UNTIL, före FROM, vid saknad/ogiltig konfiguration, saknad
// bindning, lagringsfel, halt eller slut på taket NEKAS generationen (fail closed) – aldrig "0 hittills".
//
// Pott = pilot-id. En Durable Object-instans per pilot-id (SQLite, enda skrivare) bär taket. För ett befintligt pilot-id kan taket och
// slutdatumet bara SÄNKAS av konfigurationen; en höjning/förlängning nekas ("konfig_hojd"). Ny pott kräver nytt pilot-id och en
// spårbar mandatreferens (FREE_PILOT_MANDATE, lagras i instansen). Det finns ingen admin-rutt som nollställer, fyller på eller
// avblockerar: halt (okänd användning/överskridning) hävs bara av ett nytt pilot-id med nytt mänskligt mandat.
//
// Allt räknas i heltal mikro-USD. Reservation före varje generation (värsta fall: uppmätta indatatoken + allt tillåtet utdata),
// byte mot uppmätt kostnad efter anropet. Okänd användning (nät-/tidsfel, saknat usage-fält) behåller värsta fallet och sätter halt.

import { computeCost, worstCaseUsd } from "./models.js";

const MAX_MICRO = 1e12;
const MAX_PILOT_DAYS = 92;
const okInt = (v) => Number.isSafeInteger(v) && v >= 0 && v <= MAX_MICRO;
const okPos = (v) => okInt(v) && v > 0;
const okKey = (v) => typeof v === "string" && /^[A-Za-z0-9:_.-]{1,96}$/.test(v);
const okId = (v) => typeof v === "string" && /^[a-z0-9][a-z0-9-]{2,40}$/.test(v);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/;

export const usdToMicro = (usd) => Math.ceil(usd * 1e6 - 1e-9);

// ---------- konfiguration (rena funktioner) ----------
const posInt = (v) => {
  if (v === undefined || v === null || v === "") return NaN;
  const s = typeof v === "number" ? String(v) : v;
  return typeof s === "string" && /^[1-9][0-9]{0,15}$/.test(s) ? Number(s) : NaN;
};
const parseInstant = (v) => { if (typeof v !== "string" || !ISO.test(v)) return NaN; const t = Date.parse(v); return Number.isFinite(t) ? t : NaN; };

// → { ok:true, cfg } | { ok:false, reason }. Inga standardvärden: allt måste vara satt av en människa.
export function pilotConfig(env) {
  if (!env || env.FREE_PILOT_ENABLED !== "1") return { ok: false, reason: "ej_aktiverad" };
  const id = env.FREE_PILOT_ID, capMicro = posInt(env.FREE_PILOT_CAP_MICRO), fromMs = parseInstant(env.FREE_PILOT_FROM), untilMs = parseInstant(env.FREE_PILOT_UNTIL);
  const mandate = env.FREE_PILOT_MANDATE;
  if (!okId(id) || !okPos(capMicro) || !Number.isFinite(fromMs) || !Number.isFinite(untilMs)) return { ok: false, reason: "konfig" };
  if (typeof mandate !== "string" || mandate.trim().length < 8 || mandate.length > 120 || /[\u0000-\u001f]/.test(mandate)) return { ok: false, reason: "konfig" };
  if (untilMs <= fromMs || untilMs - fromMs > MAX_PILOT_DAYS * 86400000) return { ok: false, reason: "konfig" };
  return { ok: true, cfg: { id, capMicro, fromMs, untilMs, mandate: mandate.trim() } };
}

export const budgetBinding = (env) => Boolean(env && env.FREE_BUDGET && typeof env.FREE_BUDGET.idFromName === "function" && typeof env.FREE_BUDGET.get === "function");

// ---------- Durable Object ----------
function rec(v, fields) {
  if (v === undefined || v === null) return Object.fromEntries(fields.map((f) => [f, 0]));
  if (typeof v !== "object") throw new Error("ogiltig räknare");
  for (const f of fields) if (!okInt(v[f])) throw new Error("ogiltig räknare");
  return v;
}
const cfgOk = (c) => c && okId(c.id) && okPos(c.capMicro) && Number.isFinite(c.fromMs) && Number.isFinite(c.untilMs) && c.untilMs > c.fromMs && typeof c.mandate === "string" && c.mandate.length >= 8 && c.mandate.length <= 120;

export class FreeBudget {
  constructor(state) { this.state = state; }
  async fetch(request) {
    let b;
    try { b = await request.json(); } catch { return Response.json({ error: "ogiltig förfrågan" }, { status: 400 }); }
    const path = new URL(request.url).pathname;
    // Aktiv pilotpost: första giltiga konfigurationen aktiverar; därefter kan konfigurationen bara sänka taket/slutet.
    const loadPilot = async (s, cfg) => {
      const stored = await s.get("pilot");
      if (!stored) { await s.put("pilot", { id: cfg.id, capMicro: cfg.capMicro, fromMs: cfg.fromMs, untilMs: cfg.untilMs, mandate: cfg.mandate, activatedAt: b.nowMs }); return { pilot: await s.get("pilot") }; }
      if (stored.id !== cfg.id) return { deny: "konfig" };
      if (cfg.capMicro > stored.capMicro || cfg.untilMs > stored.untilMs || cfg.fromMs !== stored.fromMs) return { deny: "konfig_hojd" };
      if (cfg.capMicro < stored.capMicro || cfg.untilMs < stored.untilMs) { const t = { ...stored, capMicro: cfg.capMicro, untilMs: cfg.untilMs }; await s.put("pilot", t); return { pilot: t }; }
      return { pilot: stored };
    };
    const run = async (s) => {
      if (!b || typeof b !== "object" || !Number.isFinite(b.nowMs) || !cfgOk(b.cfg)) return { status: 400 };
      const m = rec(await s.get("m"), ["spent"]);
      const halt = await s.get("halt");
      if (path === "/status") {
        const st = await s.get("pilot");
        let state = "aktiv";
        if (halt) state = "stopp"; else if (!st) state = b.nowMs < b.cfg.fromMs ? "vantar" : b.nowMs >= b.cfg.untilMs ? "utgangen" : "aktiv";
        else if (b.cfg.capMicro > st.capMicro || b.cfg.untilMs > st.untilMs || b.cfg.fromMs !== st.fromMs) state = "konfig_hojd";
        else if (b.nowMs < st.fromMs) state = "vantar"; else if (b.nowMs >= st.untilMs) state = "utgangen"; else if (m.spent >= st.capMicro) state = "slut";
        return { body: { ok: true, state, spentMicro: m.spent, capMicro: st ? st.capMicro : b.cfg.capMicro } };
      }
      if (path === "/reserve") {
        const { key, micro } = b;
        if (!okKey(key) || !okPos(micro)) return { status: 400 };
        if (halt) return { body: { ok: false, reason: "stopp" } };
        const lp = await loadPilot(s, b.cfg); if (lp.deny) return { body: { ok: false, reason: lp.deny } };
        const p = lp.pilot;
        if (b.nowMs < p.fromMs) return { body: { ok: false, reason: "inte_borjat" } };
        if (b.nowMs >= p.untilMs) return { body: { ok: false, reason: "utgangen" } };
        const prev = await s.get(`r:${key}`);
        if (prev && (prev.state === "reserved" || prev.state === "settled")) return { body: { ok: true, idempotent: true } };
        if (m.spent + micro > p.capMicro) return { body: { ok: false, reason: "tak" } };
        await s.put("m", { spent: m.spent + micro });
        await s.put(`r:${key}`, { state: "reserved", micro, at: b.nowMs });
        return { body: { ok: true, spent: m.spent + micro } };
      }
      if (path === "/settle") {
        const { key, actual, usageKnown } = b;
        if (!okKey(key) || !okInt(actual) || typeof usageKnown !== "boolean") return { status: 400 };
        const r = await s.get(`r:${key}`);
        if (!r || r.state !== "reserved") return { body: { ok: false, reason: "okand_reservation" } };
        const final = usageKnown ? actual : r.micro; // okänd användning: värsta fallet ligger kvar
        const spent = Math.max(0, m.spent + (final - r.micro));
        await s.put("m", { spent });
        await s.put(`r:${key}`, { ...r, state: "settled", actual: final });
        const overrun = usageKnown && actual > r.micro;
        const st = await s.get("pilot");
        if (!usageKnown) await s.put("halt", { reason: "okand_anvandning", key });
        else if (overrun) await s.put("halt", { reason: "overskridning", key, reserved: r.micro, actual });
        else if (st && spent > st.capMicro) await s.put("halt", { reason: "over_tak", key });
        return { body: { ok: true, overrun, halted: !usageKnown || overrun } };
      }
      if (path === "/release") {
        const { key } = b;
        if (!okKey(key)) return { status: 400 };
        const r = await s.get(`r:${key}`);
        if (!r || r.state !== "reserved") return { body: { ok: true, noop: true } };
        await s.put("m", { spent: Math.max(0, m.spent - r.micro) });
        await s.put(`r:${key}`, { ...r, state: "released" });
        return { body: { ok: true } };
      }
      return { status: 404 };
    };
    // ATOMICITET: all läsning och skrivning för en operation sker i EN storage.transaction. Kastar något (injicerat fel, lagringsfel) rullas
    // ALLA skrivningar tillbaka (pilot/m/r/halt), så en retry aldrig ser en halv skrivning och aldrig räknar bort förbrukning två gånger.
    // Saknas transaktionsstöd i lagringen nekas operationen (fail closed) – aldrig en icke-atomisk reserv-väg.
    const atomic = async () => {
      const st = this.state.storage;
      if (!st || typeof st.transaction !== "function") throw new Error("ingen transaktion");
      return st.transaction((txn) => run(txn));
    };
    try {
      const out = typeof this.state.blockConcurrencyWhile === "function" ? await this.state.blockConcurrencyWhile(atomic) : await atomic();
      if (out.status) return Response.json({ error: "ogiltig förfrågan" }, { status: out.status });
      return Response.json(out.body);
    } catch {
      return Response.json({ error: "räknarfel" }, { status: 500 });
    }
  }
}

// ---------- klient (Workern) ----------
async function call(env, cfg, path, payload, now) {
  const stub = env.FREE_BUDGET.get(env.FREE_BUDGET.idFromName(`pilot:${cfg.id}`));
  const resp = await stub.fetch(`https://free-budget${path}`, { method: "POST", body: JSON.stringify({ ...payload, cfg, nowMs: now.getTime() }) });
  if (!resp || !resp.ok) throw new Error("budget " + (resp && resp.status));
  return resp.json();
}

// Läsning utan reservation (tidig stängning före tokenmätning). Allt annat än state "aktiv" är stängt.
export async function freeGateStatus(env, now = new Date()) {
  const c = pilotConfig(env);
  if (!c.ok) return { open: false, state: c.reason };
  if (!budgetBinding(env)) return { open: false, state: "ingen_budget" };
  try {
    const j = await call(env, c.cfg, "/status", {}, now);
    return j && j.ok === true && typeof j.state === "string" ? { open: j.state === "aktiv", state: j.state } : { open: false, state: "fel" };
  } catch { return { open: false, state: "fel" }; }
}

// → { ok:true } | { ok:false, reason }. Allt som inte är ett tydligt ok:true är nekat.
export async function freeReserve(env, { key, micro, now = new Date() }) {
  const c = pilotConfig(env);
  if (!c.ok) return { ok: false, reason: c.reason };
  if (!budgetBinding(env)) return { ok: false, reason: "ingen_budget" };
  if (!okKey(key) || !okPos(micro)) return { ok: false, reason: "konfig" };
  try {
    const j = await call(env, c.cfg, "/reserve", { key, micro }, now);
    return j && j.ok === true ? { ok: true } : { ok: false, reason: (j && typeof j.reason === "string" && j.reason) || "fel" };
  } catch { return { ok: false, reason: "fel" }; }
}

// Avräkning mot uppmätt användning; okänd användning behåller värsta fallet och stoppar nya generationer.
export async function freeSettle(env, { key, model, usage, worstMicro, now = new Date() }) {
  const c = pilotConfig(env); if (!c.ok || !budgetBinding(env)) return false;
  const cost = computeCost(model, usage);
  const known = cost.status === "känd" && cost.usd !== null;
  try { await call(env, c.cfg, "/settle", { key, actual: known ? usdToMicro(cost.usd) : worstMicro, usageKnown: known }, now); return true; } catch { return false; }
}
// Nät-/tidsfel: oklart om något debiterades.
export const freeUnknown = (env, { key, worstMicro, now }) => freeSettle(env, { key, model: null, usage: null, worstMicro, now });
export async function freeRelease(env, { key, now = new Date() }) {
  const c = pilotConfig(env); if (!c.ok || !budgetBinding(env)) return false;
  try { await call(env, c.cfg, "/release", { key }, now); return true; } catch { return false; }
}

// Värsta fall i µUSD för en uppmätt begäran. null = okänd modell/mätning ⇒ ingen generation.
export const INPUT_MARGIN_TOKENS = 1000;
export function worstMicroFor(model, inputTokens) {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) return null;
  const w = worstCaseUsd(model, inputTokens + INPUT_MARGIN_TOKENS);
  return w === null ? null : Math.max(1, usdToMicro(w));
}
