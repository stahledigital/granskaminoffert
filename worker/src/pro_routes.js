// Materialräknaren PRO – köp, rätt att använda, bekräftelse och ångerfunktion (stödkandidat P3 v2, Claude, 2026-10-17). WORK-ID KP-2026-10-16-01.
// Avsedd för den befintliga GMO-workern `granskaminoffert-api` (Stripe live/test, Resend och KV finns redan bundna):
// INGA nya hemligheter, konton eller domäner. Don integrerar enligt README (index.js-rutt, valfri webhookkrok, cron för proSchema).
//
// Principer:
// - Ingen kunddata från offerten når servern. Hit kommer plan, projektId, försöks-id, samtyckesversion, session_id, e-post (inloggning/ånger) och token.
// - Ingen egen kunddatabas. Stripe är facit för betalning och prenumeration. KV används för nonce, hastighetsgräns, mejlflaggor, spärrlista och ångerregister.
// - Returen från Checkout är aldrig bevis: /pro/kvitto hämtar sessionen från Stripe och prövar status, livemode och metadata.
// - Brytare PRO_PAYMENTS = off | test | live. off = stängt (503) utom /pro/status.
// - Priser ägs av servern (R1, Claude-beslut 2026-10-17 ur Modesty S2e) och är inklusive 25 % moms. En miljövariabel kan ändra dem bara inom
//   Anders ramar 10:07–10:13 (vakt i priser()). Stripe-pris och momssats skapas av workern själv vid första behov (lookup_key / metadata), så
//   test och live konfigureras likadant och inget behöver klickas fram i Dashboard.
// - Token = base64url(JSON) + "." + HMAC-SHA256, nyckel härledd ur befintlig webhookhemlighet för läget (etikett "mr-pro-token-v1").
// - Stripe-Version är låst (STRIPE_VERSION) så att fältformer inte ändras med kontots standardversion.
// - v3 (2026-10-17 eftermiddag) efter oberoende granskning: spärr per order och KV-nycklar per läge, lagkrävda mejl utanför dagstaket och
//   omförsök av mottagningsbevis, återbetalning markeras klar först när fakturan är känd, räknare som inte kan fälla ett anrop, schema per
//   ärende med paginering, ångerns steg 2 förbrukar inte bekräftelsen före registreringen, mottagningsbevis alltid till köpets e-post,
//   inloggning svarar alltid 202 och hittar e-post med versaler, /pro/aterhamta för projektköp i en annan webbläsare, gränser per IP.
import { hmacSha256Hex, timingSafeEqual, b64url, randomToken, sha256Hex, jsonResponse } from "./compare_util.js";
import { mailHttpConfig, buildMailRequest, sendViaHttp, validMailTo } from "./compare_mailer.js";
import { sellerInfo, sellerLines } from "./compare_config.js";
import { SAMTYCKE_VERSION, VILLKOR_VERSION, SAMTYCKE_TEXT, MEJL, fyll, planNamn, mejlTexter } from "./pro_texter.js";
import { register, epostHash } from "./pro_konto.js";

const API = "https://api.stripe.com/v1";
export const STRIPE_VERSION = "2024-06-20";
export const PRO_VERSION = "pro-v1";
const PLANER = Object.freeze({
  projekt: { mode: "payment", produkt: "Materialräknaren PRO – ett projekt (30 dagar)" },
  manad: { mode: "subscription", interval: "month", produkt: "Materialräknaren PRO – månad" },
  ar: { mode: "subscription", interval: "year", produkt: "Materialräknaren PRO – år" },
});
export const PRIS_STANDARD = Object.freeze({ projekt: 14900, manad: 24900, ar: 224100 }); // öre inkl moms, R1
export const MOMS_PCT = 25;
const MOMS_NYCKEL = "se-25-inkl-v1";
export const PROJEKT_DAGAR = 30;
const ANGER_DAGAR = 14, ANGER_MARGINAL_DAGAR = 1; // fristen räknas generöst från sessionens skapande (+1 dygn)
const PROJEKT_RE = /^p_[0-9a-f]{32}$/, FORSOK_RE = /^[A-Za-z0-9_-]{16,64}$/, SESSION_RE = /^cs_(test|live)_[A-Za-z0-9]{8,}$/, ORDER_RE = /^PRO-[A-HJ-NP-Z2-9]{8}$/;
const AKTIV = new Set(["active", "trialing", "past_due"]); // past_due: Stripe försöker dra igen; PRO stängs först när prenumerationen avslutas
const TOKEN_MAX = 2048, PREN_MAX_S = 7 * 24 * 3600, LOGIN_S = 15 * 60, DAG = 86400;
const ANGER_REGISTER_TTL = 8 * 365 * DAG; // bevis om tidpunkt och innehåll (AK-A10); bokföringslagens sju år + marginal

export function proMode(env) { const m = env && env.PRO_PAYMENTS; return m === "live" || m === "test" ? m : "off"; }
const K = (env, rest) => `pro:${proMode(env)}:${rest}`; // order, ånger och spärr hålls isär per läge: test kan aldrig påverka live
function stripeKey(env) { return proMode(env) === "live" ? env.STRIPE_SECRET_KEY : env.STRIPE_TEST_SECRET_KEY; }
function baseSecret(env) { return proMode(env) === "live" ? env.STRIPE_WEBHOOK_SECRET : env.STRIPE_TEST_WEBHOOK_SECRET; }
function origins(env) { return String(env.PRO_ALLOWED_ORIGIN || "https://stahledigital.se").split(",").map((s) => s.trim()).filter(Boolean); }
function cors(origin, env) {
  const ok = origins(env).includes(origin);
  return ok ? { "access-control-allow-origin": origin, vary: "Origin", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600" } : { vary: "Origin" };
}
const httpsUrl = (v, def) => { const u = String(v || def); return /^https:\/\/[^\s"'<>]+$/.test(u) ? u : null; };
const sajt = (env) => httpsUrl(env.PRO_SITE_URL, "https://stahledigital.se").replace(/\/$/, "");
function returUrl(env) { return httpsUrl(env.PRO_RETURN_URL, sajt(env) + "/verkstaden/materialraknaren/offert"); }
const angraUrl = (env) => sajt(env) + "/verkstaden/materialraknaren/angra";
const villkorUrl = (env) => sajt(env) + "/verkstaden/materialraknaren/villkor";

// ---------- priser (servern äger dem; vakt = Anders ramar) ----------
const rhuExkl = (inkl) => Math.floor((8 * inkl + 5) / 10); // RHU(inkl / 1,25) för 25 % moms, heltal öre
export function priser(env) {
  const fel = [], p = {};
  for (const plan of Object.keys(PLANER)) {
    const raw = env && env[`PRO_PRIS_${plan.toUpperCase()}_ORE`];
    const inkl = raw === undefined || raw === "" ? PRIS_STANDARD[plan] : /^[1-9]\d{2,6}$/.test(String(raw)) ? Number(raw) : NaN;
    if (!Number.isInteger(inkl)) { fel.push(plan + ":format"); continue; }
    const exkl = rhuExkl(inkl);
    p[plan] = { inkl_ore: inkl, exkl_ore: exkl, moms_ore: inkl - exkl, intervall: PLANER[plan].interval || null, ...(plan === "projekt" ? { dagar: PROJEKT_DAGAR } : {}) };
  }
  if (fel.length) return { ok: false, fel, planer: {} };
  // Anders 10:07–10:13: engångsköp 49–249 kr exkl moms, månad 199–299 kr exkl moms, år cirka 25 % under 12 månader (vakt 20–30 %).
  if (p.projekt.exkl_ore < 4900 || p.projekt.exkl_ore > 24900) fel.push("projekt:utanfor_ram");
  if (p.manad.exkl_ore < 19900 || p.manad.exkl_ore > 29900) fel.push("manad:utanfor_ram");
  const rabatt = 1 - p.ar.inkl_ore / (12 * p.manad.inkl_ore);
  if (!(rabatt >= 0.2 && rabatt <= 0.3)) fel.push("ar:utanfor_ram");
  p.ar.per_manad_ore = Math.floor((p.ar.inkl_ore * 2 + 12) / 24);
  p.ar.rabatt_pct = Math.round(rabatt * 10000) / 100;
  return fel.length ? { ok: false, fel, planer: {} } : { ok: true, fel: [], planer: p };
}

// ---------- Stripe ----------
function formEncode(obj, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => out.push(typeof x === "object" ? formEncode(x, `${key}[${i}]`) : `${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(x))}`));
    else if (typeof v === "object") out.push(formEncode(v, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.filter(Boolean).join("&");
}
class StripeFel extends Error { constructor(status, code) { super(`stripe ${status} ${code || ""}`.trim()); this.status = status >= 500 ? 502 : 502; this.http = status; this.code = code || ""; } }
async function stripe(env, path, { method = "GET", body, idem, fetchImpl = fetch } = {}) {
  const key = stripeKey(env);
  if (typeof key !== "string" || !key) { const e = new Error("stripe-nyckel saknas"); e.status = 503; throw e; }
  const headers = { authorization: `Bearer ${key}`, "stripe-version": STRIPE_VERSION };
  if (body) headers["content-type"] = "application/x-www-form-urlencoded";
  if (idem) headers["idempotency-key"] = idem;
  const r = await fetchImpl(API + path, { method, headers, body: body ? formEncode(body) : undefined, signal: AbortSignal.timeout(15000) });
  let j = null; try { j = await r.json(); } catch { /* ogiltigt */ }
  if (!r.ok) throw new StripeFel(r.status, j && j.error && j.error.code);
  return j;
}
const minne = new Map(); // per isolat; KV är den delade cachen
export function _rensaMinne() { minne.clear(); }
async function kvGet(env, k) { try { return env.REVIEWS_KV ? await env.REVIEWS_KV.get(k) : null; } catch { return null; } }
async function kvPut(env, k, v, ttl) { try { if (env.REVIEWS_KV) await env.REVIEWS_KV.put(k, v, ttl ? { expirationTtl: ttl } : undefined); return true; } catch { return false; } }
async function kvDel(env, k) { try { if (env.REVIEWS_KV) await env.REVIEWS_KV.delete(k); } catch { /* ok */ } }
async function sakra(env, nyckel, giltig, hitta, skapa) {
  const k = `pro:obj:${proMode(env)}:${nyckel}`;
  if (minne.has(k)) return minne.get(k);
  let id = await kvGet(env, k);
  if (!giltig(id)) { id = await hitta(); if (!giltig(id)) id = await skapa(); if (!giltig(id)) throw new StripeFel(502, "ogiltigt_objekt"); await kvPut(env, k, id, DAG); }
  minne.set(k, id); return id;
}
async function sakraMoms(env, fetchImpl) {
  return sakra(env, `moms:${MOMS_NYCKEL}`, (id) => /^txr_[A-Za-z0-9]{6,}$/.test(String(id)),
    async () => { const l = await stripe(env, "/tax_rates?active=true&inclusive=true&limit=100", { fetchImpl });
      const f = (l && l.data || []).find((t) => t && t.active && t.inclusive === true && Number(t.percentage) === MOMS_PCT && t.metadata && t.metadata.pro_moms === MOMS_NYCKEL); return f ? f.id : null; },
    async () => (await stripe(env, "/tax_rates", { method: "POST", idem: `pro-moms-${MOMS_NYCKEL}-${proMode(env)}`, fetchImpl,
      body: { display_name: "Moms", description: "Moms 25 % Materialräknaren PRO", percentage: String(MOMS_PCT), inclusive: "true", country: "SE", tax_type: "vat", metadata: { pro_moms: MOMS_NYCKEL } } })).id);
}
async function sakraPris(env, plan, inkl, fetchImpl) {
  const lk = `mrpro_${plan}_${inkl}_v1`, intervall = PLANER[plan].interval || null;
  const passar = (p) => p && p.active && p.unit_amount === inkl && p.currency === "sek" && ((p.recurring && p.recurring.interval) || null) === intervall;
  return sakra(env, `pris:${lk}`, (id) => /^price_[A-Za-z0-9]{8,}$/.test(String(id)),
    async () => { const l = await stripe(env, `/prices?active=true&limit=1&lookup_keys%5B%5D=${encodeURIComponent(lk)}`, { fetchImpl }); const f = (l && l.data || []).find(passar); return f ? f.id : null; },
    async () => (await stripe(env, "/prices", { method: "POST", idem: `pro-pris-${lk}-${proMode(env)}`, fetchImpl,
      body: { currency: "sek", unit_amount: String(inkl), lookup_key: lk, product_data: { name: PLANER[plan].produkt, metadata: { pro: PRO_VERSION, plan } }, metadata: { pro: PRO_VERSION, plan },
        ...(intervall ? { recurring: { interval: intervall } } : {}) } })).id);
}
async function sakraPortal(env, fetchImpl) {
  return sakra(env, "portal:v1", (id) => /^bpc_[A-Za-z0-9]{6,}$/.test(String(id)),
    async () => { const l = await stripe(env, "/billing_portal/configurations?active=true&limit=100", { fetchImpl }); const f = (l && l.data || []).find((c) => c && c.active && c.metadata && c.metadata.pro === "portal-v1"); return f ? f.id : null; },
    async () => (await stripe(env, "/billing_portal/configurations", { method: "POST", idem: `pro-portal-v1-${proMode(env)}`, fetchImpl,
      body: { business_profile: { headline: "Materialräknaren PRO: hantera din prenumeration", terms_of_service_url: villkorUrl(env), privacy_policy_url: httpsUrl(env.PRO_INTEGRITET_URL, sajt(env) + "/integritet") },
        default_return_url: returUrl(env), metadata: { pro: "portal-v1" },
        features: { invoice_history: { enabled: "true" }, payment_method_update: { enabled: "true" }, customer_update: { enabled: "false" },
          subscription_cancel: { enabled: "true", mode: "at_period_end", proration_behavior: "none" } } } })).id);
}

// ---------- token ----------
const enc = new TextEncoder();
function b64urlDecode(s) { const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)); return new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0))); }
async function tokenKey(env) { const s = baseSecret(env); if (typeof s !== "string" || s.length < 16) { const e = new Error("tokennyckel saknas"); e.status = 503; throw e; } return hmacSha256Hex(s, "mr-pro-token-v1"); }
export async function signToken(env, payload) {
  const p = b64url(enc.encode(JSON.stringify({ ...payload, v: 1, m: proMode(env) })));
  return `${p}.${await hmacSha256Hex(await tokenKey(env), p)}`;
}
export async function verifyToken(env, token, nowS) {
  if (typeof token !== "string" || token.length > TOKEN_MAX) return null;
  const i = token.indexOf("."); if (i < 1) return null;
  const p = token.slice(0, i), sig = token.slice(i + 1);
  if (!/^[0-9a-f]{64}$/.test(sig) || !timingSafeEqual(sig, await hmacSha256Hex(await tokenKey(env), p))) return null;
  let o; try { o = JSON.parse(b64urlDecode(p)); } catch { return null; }
  if (!o || o.v !== 1 || o.m !== proMode(env)) return null;
  if (!(Number.isInteger(o.exp) && o.exp > nowS)) return null; // alla tokentyper har utgångstid
  return o;
}

// ---------- hjälp ----------
async function lasKropp(request, max = 2048) {
  const raw = await request.text(); if (enc.encode(raw).length > max) return null;
  const typ = (request.headers.get("content-type") || "").toLowerCase();
  if (typ.startsWith("application/x-www-form-urlencoded")) { const o = {}; for (const [k, v] of new URLSearchParams(raw)) if (!(k in o)) o[k] = v; return o; }
  try { const o = JSON.parse(raw); return o && typeof o === "object" && !Array.isArray(o) ? o : null; } catch { return null; }
}
function periodSlut(sub) {
  const top = sub && Number.isInteger(sub.current_period_end) ? sub.current_period_end : null;
  const item = sub && sub.items && Array.isArray(sub.items.data) && sub.items.data[0] && Number.isInteger(sub.items.data[0].current_period_end) ? sub.items.data[0].current_period_end : null;
  return top ?? item;
}
const arPro = (o) => !!(o && o.metadata && o.metadata.pro === PRO_VERSION);
async function prenToken(env, kund, sub, nowS) {
  const slut = periodSlut(sub) ?? nowS + DAG, exp = Math.min(slut, nowS + PREN_MAX_S);
  return { token: await signToken(env, { t: "pren", c: kund, exp }), plan: "pren", exp };
}
export async function aktivPren(env, kund, fetchImpl, tillatnaId = null) {
  if (!/^cus_[A-Za-z0-9]{6,}$/.test(String(kund))) return null;
  const l = await stripe(env, `/subscriptions?customer=${encodeURIComponent(kund)}&status=all&limit=20`, { fetchImpl });
  for (const sub of (l && Array.isArray(l.data) ? l.data : [])) {
    if (!AKTIV.has(sub.status) || !arPro(sub) || (tillatnaId && !tillatnaId.includes(sub.id))) continue;
    const sparr=await register(env,"pren_faktura_sparr",{nu:Math.floor(Date.now()/1000),mode:proMode(env),prenId:sub.id});
    if (sparr.fakturor?.length) {
      const inv=await stripe(env,`/invoices?subscription=${encodeURIComponent(sub.id)}&status=paid&limit=10`,{fetchImpl});
      const betald=(inv?.data || []).filter(i=>i.status === "paid").sort((a,b)=>b.created-a.created)[0];
      if (!betald || sparr.fakturor.includes(betald.id)) continue;
    }
    return sub;
  }
  return null;
}
// Ungefärlig räknare (KV är inte atomärt och tål ungefär en skrivning per sekund och nyckel). Ett KV-fel får aldrig fälla anropet: då släpps det igenom.
async function raknare(env, key, max, ttl) {
  const kv = env.REVIEWS_KV; if (!kv) return false;
  try { const n = Number((await kv.get(key)) || 0); if (n >= max) return true; await kv.put(key, String(n + 1), { expirationTtl: ttl }); } catch { /* fail open */ }
  return false;
}
const ipNyckel = async (request) => (await sha256Hex(request.headers.get("CF-Connecting-IP") || "okand")).slice(0, 24);
const ALFA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export async function orderRef(sid) { const h = await sha256Hex(String(sid)); let s = ""; for (let i = 0; i < 8; i++) s += ALFA[parseInt(h.slice(i * 2, i * 2 + 2), 16) % 32]; return "PRO-" + s; }
export function projektKod(projektId) { let n = parseInt(String(projektId).slice(2, 12), 16), s = ""; for (let i = 0; i < 4; i++) { s += ALFA[n % 32]; n = Math.floor(n / 32); } return s; } // samma som P4 kod()
export function krText(ore) { const neg = ore < 0, v = Math.abs(ore), kr = Math.floor(v / 100), o = v % 100; return (neg ? "-" : "") + String(kr).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + (o ? "," + String(o).padStart(2, "0") : ""); }
const fmtTid = (s, opt) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", ...opt }).format(new Date(s * 1000));
export const tidSv = (s) => fmtTid(s, { dateStyle: "long", timeStyle: "short" });
export const datumSv = (s) => fmtTid(s, { dateStyle: "long" });
const projektSlut = (s) => s.created + PROJEKT_DAGAR * DAG;

// En köpares kontorätt registreras endast efter serverhämtad/signerad, betald PRO-session.
export async function registreraKop(env, s, {nowS = Math.floor(Date.now()/1000)} = {}) {
  const md = s && s.metadata || {}, mode = proMode(env);
  if (mode === "off" || !s || s.object !== "checkout.session" || !SESSION_RE.test(String(s.id)) || s.id.startsWith("cs_live_") !== (mode === "live") || s.livemode !== (mode === "live") || !arPro(s) || !Object.hasOwn(PLANER,md.plan) || s.mode !== PLANER[md.plan].mode || s.status !== "complete" || !["paid","no_payment_required"].includes(s.payment_status)) return {ok:false,ej_betald:true};
  const epost = String(s.customer_details?.email || "").trim().toLowerCase(), kund = typeof s.customer === "string" ? s.customer : s.customer?.id;
  if (!validMailTo(epost) || !kund || !env.REVIEWS_KV) throw new StripeFel(503,"kopuppgifter_saknas");
  const order = await orderRef(s.id);
  // Kvittogrinden får inte tolka ett KV-läsfel som ett köp utan ånger. DO-spärren är beständig även vid senare återspelning.
  const ra = await env.REVIEWS_KV.get(K(env,`angra:reg:${order}`)), reg = ra ? JSON.parse(ra) : null;
  const r = await register(env,"kop_registrera",{nu:nowS,mode,session:s.id,order,ehash:/^[0-9a-f]{64}$/.test(String(md.konto_ehash)) ? md.konto_ehash : await epostHash(env,epost),kund,plan:md.plan,projektId:md.plan === "projekt" ? md.projekt : null,prenId:md.plan === "projekt" ? null : typeof s.subscription === "string" ? s.subscription : s.subscription?.id,betalningId:typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id,skapad:s.created,slut:md.plan === "projekt" ? projektSlut(s) : null});
  if (!r?.ok) throw new StripeFel(502,"kopkoppling");
  if (reg && reg.utfall !== "manuell_provning") { await aterkallaKop(env,{session:s.id,nowS}); return {...r,aterkallad:true}; }
  if (r.aterkallad && !(await kvPut(env,K(env,`sparr:${order}`),"1",(PROJEKT_DAGAR+30)*DAG))) throw new StripeFel(502,"kopaterkallelse_kv");
  return r;
}
async function aterkallaKop(env,{session,betalningId,nowS = Math.floor(Date.now()/1000)}) {
  const r = await register(env,"kop_aterkalla",{nu:nowS,mode:proMode(env),session,betalningId});
  if (!r?.ok) throw new StripeFel(502,"kopaterkallelse");
  for (const order of r.order || []) if (!(await kvPut(env,K(env,`sparr:${order}`),"1",(PROJEKT_DAGAR+30)*DAG))) throw new StripeFel(502,"kopaterkallelse_kv");
  return r;
}

// ---------- mejl ----------
// tak=true bara för mejl som vem som helst kan utlösa (inloggning, hämta köp). Bekräftelse, kvitto, påminnelse och mottagningsbevis är
// lagkrävda eller följer av ett köp och stoppas aldrig av dagstaket. Permanent avvisade mejl flaggas och försöks inte igen.
async function skickaMejl(env, { till, amne, text, nyckel, tak = false }) {
  const m = mailHttpConfig(env); if (!m.on) return { ok: false, kod: "mejl_av" };
  if (!validMailTo(till)) return { ok: false, kod: "ogiltig_mottagare", kind: "terminal" };
  const flagga = `pro:mejl:${nyckel}`, fanns = await kvGet(env, flagga);
  if (fanns) { let f = null; try { f = JSON.parse(fanns); } catch { /* ok */ } return f && f.fel ? { ok: false, kod: f.fel, kind: "terminal", tidigare: true } : { ok: true, dubblett: true }; }
  if (tak) {
    const cap = /^[1-9]\d{0,4}$/.test(String(env.PRO_MAIL_DAY_CAP || "")) ? Number(env.PRO_MAIL_DAY_CAP) : 100;
    if (await raknare(env, `pro:mejl:dag:${new Date().toISOString().slice(0, 10)}`, cap, 2 * DAG)) return { ok: false, kod: "dagstak", kind: "retry" };
  }
  const from = String(env.PRO_MAIL_FROM || "").trim() || m.from.replace(/^[^<]*</, `${MEJL.avsandare_namn} <`);
  const ut = await sendViaHttp(env, { req: buildMailRequest({ from, to: till, subject: amne, text }), idemKey: `pro-${nyckel}`.slice(0, 200) });
  if (ut.ok) await kvPut(env, flagga, JSON.stringify({ ref: ut.ref, t: Date.now() }), 400 * DAG);
  else if (ut.kind === "terminal" || ut.kind === "payload_conflict") await kvPut(env, flagga, JSON.stringify({ fel: ut.code || ut.kind, t: Date.now() }), 30 * DAG);
  return ut.ok ? { ok: true, ref: ut.ref } : { ok: false, kod: ut.code || ut.kind, kind: ut.kind };
}
const saljarText = (env) => sellerLines(sellerInfo(env)).join("\n");
function belopp(s) { const inkl = Number(s.amount_total) || 0, moms = Number(s.total_details && s.total_details.amount_tax) || 0; return { inkl: krText(inkl), moms: krText(moms), exkl: krText(inkl - moms) }; }

export async function bekraftelse(env, s, { fetchImpl = fetch } = {}) {
  if (!arPro(s) || s.status !== "complete" || !["paid", "no_payment_required"].includes(s.payment_status)) return { ok: false, kod: "ej_betald" };
  const till = s.customer_details && s.customer_details.email; const md = s.metadata, order = await orderRef(s.id);
  await kvPut(env, K(env, `order:${order}`), s.id, 400 * DAG); // gör ångerfunktionen oberoende av hur e-posten skrivs (AK-A9)
  let sub = s.subscription && typeof s.subscription === "object" ? s.subscription : null;
  if (!sub && md.plan !== "projekt" && typeof s.subscription === "string") sub = await stripe(env, `/subscriptions/${s.subscription}`, { fetchImpl });
  const nasta = sub ? periodSlut(sub) : null, uppsagning = fyll(MEJL.uppsagningsrad, { pro_lank: returUrl(env) });
  const text = fyll(mejlTexter(env).bekr, { order, plan: planNamn(md.plan), tid: tidSv(s.created), ...belopp(s),
    projektrad: md.plan === "projekt" ? fyll(MEJL.projektrad, { kod: projektKod(md.projekt), slut: datumSv(projektSlut(s)) }) : "",
    periodrad: md.plan === "manad" && nasta ? fyll(MEJL.periodrad_manad, { nasta: datumSv(nasta) }) : md.plan === "ar" && nasta ? fyll(MEJL.periodrad_ar, { nasta: datumSv(nasta) }) : "",
    samtycke_tid: md.samtycke_tid ? tidSv(Math.floor(Date.parse(md.samtycke_tid) / 1000)) : tidSv(s.created), samtycke_start: SAMTYCKE_TEXT.start, samtycke_villkor: SAMTYCKE_TEXT.villkor,
    angra_lank: `${angraUrl(env)}?order=${order}`, uppsagningsrad: md.plan === "projekt" ? "" : uppsagning, villkor_lank: villkorUrl(env), saljare: saljarText(env) });
  return skickaMejl(env, { till, amne: fyll(MEJL.bekr_amne, { order }), text, nyckel: `bekr-${s.id}` });
}

// ---------- ångerfunktionen (2 kap. 10 a § DAL; Modesty S2e AK-A1–A13) ----------
// Ordernummer -> session sparas när bekräftelsen skickas (KV, 400 dygn). E-post jämförs utan skiftlägeskänslighet.
// Saknas posten söker vi hos Stripe på e-post (som skriven och med gemener, eftersom Stripe jämför exakt).
const sammaEpost = (s, e) => !!(s && s.customer_details && typeof s.customer_details.email === "string" && s.customer_details.email.toLowerCase() === e.toLowerCase());
async function hittaKop(env, epostRa, order, fetchImpl) {
  const kand = await kvGet(env, K(env, `order:${order}`));
  if (kand && SESSION_RE.test(kand)) {
    const s = await stripe(env, `/checkout/sessions/${kand}`, { fetchImpl });
    if (arPro(s) && s.status === "complete" && sammaEpost(s, epostRa) && (await orderRef(s.id)) === order) return s;
  }
  for (const epost of [...new Set([epostRa, epostRa.toLowerCase()])]) {
    const l = await stripe(env, `/checkout/sessions?status=complete&limit=100&customer_details%5Bemail%5D=${encodeURIComponent(epost)}`, { fetchImpl });
    for (const s of (l && Array.isArray(l.data) ? l.data : [])) if (arPro(s) && sammaEpost(s, epostRa) && (await orderRef(s.id)) === order) return s;
  }
  return null;
}
export async function registreraAnger(env, sid, { epost, kvittoTill, nowS, fetchImpl = fetch }) {
  const s = await stripe(env, `/checkout/sessions/${sid}?expand%5B%5D=subscription&expand%5B%5D=invoice`, { fetchImpl });
  if (!arPro(s)) return { ok: false, status: "hittas_inte" };
  const order = await orderRef(s.id), regK = K(env, `angra:reg:${order}`);
  const fanns = await kvGet(env, regK);
  if (fanns) { const r = JSON.parse(fanns); return { ok: true, dubblett: true, order, tid: r.tid, utfall: r.utfall }; }
  const md = s.metadata, plan = md.plan, inom = nowS <= s.created + (ANGER_DAGAR + ANGER_MARGINAL_DAGAR) * DAG;
  const utfall = !inom ? "manuell_provning" : plan === "projekt" ? "aterbetalas" : "avslutas_och_aterbetalas";
  // epost har prövats mot köpets e-post (hittaKop), så beviset går alltid till köparen (AK-A10). En annan angiven adress (AK-A5) får det dessutom.
  const extra = kvittoTill && kvittoTill.toLowerCase() !== String(epost).toLowerCase() ? kvittoTill : null;
  const reg = { order, sid: s.id, plan, tid: nowS, mottaget: new Date(nowS * 1000).toISOString(), epost, kvittoTill: extra, utfall, steg: {} };
  if (!(await kvPut(env, regK, JSON.stringify(reg), ANGER_REGISTER_TTL))) { const e = new Error("register kunde inte skrivas"); e.status = 502; throw e; } // inget mottagningsbevis utan sparat bevis
  await kvPut(env, K(env, `angra:logg:${reg.mottaget.slice(0, 10)}:${order}`), order, ANGER_REGISTER_TTL);
  await kvPut(env, K(env, `angra:oppen:${order}`), s.id, 40 * DAG); // öppen tills mottagningsbevis, åtgärd och internt mejl är klara
  await slutforAnger(env, s, reg, { fetchImpl });
  return { ok: true, dubblett: false, order, tid: nowS, utfall };
}
const mejlKlart = (v) => v === "skickat" || (typeof v === "string" && v.startsWith("terminal:"));
const mejlStatus = (r) => (r.ok ? "skickat" : (r.kind === "terminal" ? "terminal:" : "fel:") + r.kod);
// Körs vid registreringen och sedan av proSchema tills allt är klart. Varje steg är idempotent (mejlflaggor och idempotensnycklar).
async function slutforAnger(env, s, reg, { fetchImpl }) {
  const order = reg.order, regK = K(env, `angra:reg:${order}`), inom = reg.utfall !== "manuell_provning";
  if (inom) await aterkallaKop(env,{session:s.id,nowS:reg.tid});
  const amne = fyll(MEJL.angra_kvitto_amne, { order });
  const text = fyll(MEJL.angra_kvitto, { order, plan: planNamn(reg.plan), tid: tidSv(reg.tid), kontakt: sellerInfo(env).email, saljare: saljarText(env),
    utfall: reg.utfall === "aterbetalas" ? mejlTexter(env).utfall_aterbetalas : reg.utfall === "avslutas_och_aterbetalas" ? mejlTexter(env).utfall_avslutas : MEJL.utfall_manuell });
  if (!mejlKlart(reg.steg.kvitto)) reg.steg.kvitto = mejlStatus(await skickaMejl(env, { till: reg.epost, nyckel: `angrakvitto-${order}`, amne, text }));
  if (reg.kvittoTill && !mejlKlart(reg.steg.kvitto2)) reg.steg.kvitto2 = mejlStatus(await skickaMejl(env, { till: reg.kvittoTill, nyckel: `angrakvitto-${order}-2`, amne, text }));
  await kvPut(env, regK, JSON.stringify(reg), ANGER_REGISTER_TTL);
  if (inom && !reg.steg.klar && reg.steg.aterbetalning !== "manuell") { await utforAnger(env, s, reg, { fetchImpl }); await kvPut(env, regK, JSON.stringify(reg), ANGER_REGISTER_TTL); }
  if (!mejlKlart(reg.steg.intern)) {
    reg.steg.intern = mejlStatus(await skickaMejl(env, { till: sellerInfo(env).email, nyckel: `angra-intern-${order}`, amne: fyll(MEJL.intern_amne, { order, utfall: reg.utfall }),
      text: fyll(MEJL.intern, { order, plan: reg.plan, tid: tidSv(reg.tid), sid: reg.sid, utfall: reg.utfall, steg: JSON.stringify(reg.steg), kvitto: reg.steg.kvitto }) }));
  }
  const atgard = !inom || reg.steg.klar || reg.steg.aterbetalning === "manuell";
  if (mejlKlart(reg.steg.kvitto) && (!reg.kvittoTill || mejlKlart(reg.steg.kvitto2)) && mejlKlart(reg.steg.intern) && atgard) { reg.steg.avslutad = true; await kvDel(env, K(env, `angra:oppen:${order}`)); }
  await kvPut(env, regK, JSON.stringify(reg), ANGER_REGISTER_TTL);
}
// Idempotent: varje steg har egen idempotensnyckel och hoppas över när det redan är klart. "manuell" = betalt men inget att återbetala mot
// (säljaren tar det; det står i det interna mejlet). Okänd faktura är ett fel som tas om, aldrig ett klart steg.
async function utforAnger(env, s, reg, { fetchImpl }) {
  const md = s.metadata, order = reg.order, meta = { angra_order: order, angra_tid: reg.mottaget, angra_utfall: reg.utfall };
  const piAv = (o) => o && (typeof o.payment_intent === "string" ? o.payment_intent : o.payment_intent && o.payment_intent.id);
  const aterbetala = async (belopp, pi) => {
    if (belopp === 0) return "klar"; // 100 %-kod: inget att betala tillbaka
    if (!(belopp > 0) || !pi) return "manuell";
    await stripe(env, "/refunds", { method: "POST", idem: `pro-angra-refund-${order}`, fetchImpl, body: { payment_intent: pi, reason: "requested_by_customer", metadata: meta } }); return "klar";
  };
  try {
    if (md.plan === "projekt") {
      if (reg.steg.sparr !== "klar") { if (!(await kvPut(env, K(env, `sparr:${order}`), "1", (PROJEKT_DAGAR + 30) * DAG))) throw new StripeFel(502, "sparr_kv"); reg.steg.sparr = "klar"; }
      if (reg.steg.aterbetalning !== "klar") reg.steg.aterbetalning = await aterbetala(Number(s.amount_total), piAv(s));
    } else {
      const sub = s.subscription && typeof s.subscription === "object" ? s.subscription : null, subId = sub ? sub.id : s.subscription;
      if (reg.steg.avslut !== "klar") {
        if (sub && sub.status === "canceled") reg.steg.avslut = "klar";
        else { await stripe(env, `/subscriptions/${subId}`, { method: "POST", idem: `pro-angra-meta-${order}`, fetchImpl, body: { metadata: meta } });
          await stripe(env, `/subscriptions/${subId}`, { method: "DELETE", idem: `pro-angra-avslut-${order}`, fetchImpl }); reg.steg.avslut = "klar"; }
      }
      if (reg.steg.aterbetalning !== "klar") {
        let inv = s.invoice && typeof s.invoice === "object" ? s.invoice : s.invoice ? await stripe(env, `/invoices/${s.invoice}`, { fetchImpl }) : null;
        if (!inv && sub && sub.latest_invoice) inv = typeof sub.latest_invoice === "object" ? sub.latest_invoice : await stripe(env, `/invoices/${sub.latest_invoice}`, { fetchImpl });
        if (!inv && subId) { const l = await stripe(env, `/invoices?subscription=${encodeURIComponent(subId)}&limit=10`, { fetchImpl }); const d = (l && l.data) || [];
          inv = d.find((i) => i && i.billing_reason === "subscription_create") || null; }
        if (!inv) throw new StripeFel(502, "faktura_saknas");
        reg.steg.aterbetalning = await aterbetala(Number(inv.amount_paid), piAv(inv));
      }
    }
  } catch (e) { reg.steg.senaste_fel = (e && e.code) || (e && e.message) || "fel"; }
  if (reg.steg.aterbetalning === "klar" && (md.plan === "projekt" ? reg.steg.sparr === "klar" : reg.steg.avslut === "klar")) { reg.steg.klar = true; delete reg.steg.senaste_fel; }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function htmlSvar(env, titel, rader, form, status = 200) {
  const f = form ? `<form method="post" action="${esc(form.action)}">${Object.entries(form.dolda).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("")}<button type="submit">${esc(form.knapp)}</button></form>` : "";
  const html = `<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(titel)}</title>
<style>body{font:17px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 16px;color:#1a1a1a;background:#fff}button{font:inherit;padding:.6rem 1.1rem;border-radius:.4rem;border:1px solid #1a1a1a;background:#1a1a1a;color:#fff;cursor:pointer}a{color:#0b57d0}</style></head>
<body><h1>${esc(titel)}</h1>${rader.map((r) => `<p>${esc(r)}</p>`).join("")}${f}<p><a href="${esc(angraUrl(env))}">Tillbaka till ångersidan</a></p></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

// ---------- rutter ----------
export async function handlePro(request, env, ctx, { fetchImpl = fetch, now = () => Date.now(), kontoEhash = null } = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/pro/")) return null;
  const origin = request.headers.get("Origin") || "", h = cors(origin, env), nowS = Math.floor(now() / 1000);
  const svar = (body, status = 200) => jsonResponse(body, status, h);
  if (request.method === "OPTIONS") return new Response(null, { status: origins(env).includes(origin) ? 204 : 403, headers: h });
  if (url.pathname === "/pro/status" && request.method === "GET") {
    const pr = priser(env), mode = proMode(env);
    return svar({ version: PRO_VERSION, betalning: mode, planer: mode !== "off" && pr.ok ? Object.keys(PLANER) : [], priser: pr.ok ? pr.planer : {}, moms_pct: MOMS_PCT,
      samtycke: SAMTYCKE_VERSION, villkor: VILLKOR_VERSION, samtycke_text: SAMTYCKE_TEXT, angra: mode !== "off" });
  }
  if (proMode(env) === "off") { // P-A: formuläret utan JS ska få en begriplig sida även när köpet är stängt, aldrig rå JSON
    if (url.pathname === "/pro/angra" && request.method === "POST" && (request.headers.get("content-type") || "").toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      const kontakt = sellerInfo(env).email;
      return htmlSvar(env, "Köp av PRO är inte öppet just nu", ["Det finns därför inget PRO-köp att ångra här än.", ...(validMailTo(kontakt) ? [`Har du frågor kan du mejla ${kontakt}.`] : [])], null, 503);
    }
    return svar({ status: "stangt" }, 503);
  }
  const egenAngra = url.pathname === "/pro/angra" && origin === url.origin; // steg 2 utan JS postas från workerns egen kvittosida
  if (request.method === "POST" && !origins(env).includes(origin) && !egenAngra) return svar({ status: "fel_ursprung" }, 403);
  const bakom = (p) => (ctx && typeof ctx.waitUntil === "function" ? ctx.waitUntil(p.catch(() => {})) : p.catch(() => {}));
  const angraForm = url.pathname === "/pro/angra" && (request.headers.get("content-type") || "").toLowerCase().startsWith("application/x-www-form-urlencoded");
  const tim = Math.floor(nowS / 3600);
  try {
    if (url.pathname === "/pro/checkout" && request.method === "POST") {
      const b = await lasKropp(request); if (!b) return svar({ status: "ogiltig_kropp" }, 400);
      const plan = b.plan, def = Object.prototype.hasOwnProperty.call(PLANER, plan) ? PLANER[plan] : null;
      if (!def) return svar({ status: "ogiltig_plan" }, 400);
      if (plan === "projekt" && !PROJEKT_RE.test(String(b.projektId))) return svar({ status: "ogiltigt_projekt" }, 400);
      if (!FORSOK_RE.test(String(b.forsok))) return svar({ status: "ogiltigt_forsok" }, 400);
      if (b.samtycke !== SAMTYCKE_VERSION || b.villkor !== VILLKOR_VERSION) return svar({ status: "samtycke_saknas" }, 400);
      const pr = priser(env), ret = returUrl(env); if (!pr.ok || !ret) return svar({ status: "konfiguration" }, 503);
      // Fail closed: utan fungerande mejl kan bekräftelsen (samtycke, ångerlänk) inte lämnas, och live kräver fullständiga säljaruppgifter.
      if (!mailHttpConfig(env).on || (proMode(env) === "live" && sellerInfo(env).placeholder)) return svar({ status: "konfiguration" }, 503);
      if (await raknare(env, `pro:rl:co:ip:${await ipNyckel(request)}:${tim}`, 20, 4000) || await raknare(env, `pro:rl:co:${tim}`, 600, 4000)) return svar({ status: "for_manga" }, 429);
      const fk = `pro:forsok:${b.forsok}`; let tid = await kvGet(env, fk);
      if (!tid) { tid = new Date(nowS * 1000).toISOString(); await kvPut(env, fk, tid, DAG); } // samma försök = samma kropp = samma idempotens
      const [txr, pris] = await Promise.all([sakraMoms(env, fetchImpl), sakraPris(env, plan, pr.planer[plan].inkl_ore, fetchImpl)]);
      const sep = ret.includes("?") ? "&" : "?", p = pr.planer[plan];
      const meta = { ...(kontoEhash ? {konto_ehash:kontoEhash} : {}), pro: PRO_VERSION, plan, projekt: plan === "projekt" ? b.projektId : "", samtycke: SAMTYCKE_VERSION, villkor: VILLKOR_VERSION, samtycke_tid: tid };
      const period = plan === "manad" ? " per månad tills du säger upp" : plan === "ar" ? " per år tills du säger upp" : "";
      const body = { mode: def.mode, locale: "sv", payment_method_types: ["card"], line_items: [{ price: pris, quantity: 1, tax_rates: [txr] }],
        ...(env.PRO_KAMPANJKODER === "on" ? { allow_promotion_codes: "true" } : {}), // av som standard: kontots övriga kampanjkoder (GMO) ska inte gälla PRO
        client_reference_id: plan === "projekt" ? b.projektId : `pren_${plan}`, metadata: meta,
        success_url: `${ret}${sep}pro=ok&session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${ret}${sep}pro=avbrutet`,
        custom_text: { submit: { message: `När du betalar förbinder du dig att betala ${krText(p.inkl_ore)} kr inklusive moms${period}. Du kan ångra köpet inom 14 dagar och få tillbaka hela beloppet via Ångra avtalet här på ${angraUrl(env)}` } },
        ...(def.mode === "payment" ? { customer_creation: "always", payment_intent_data: { metadata: meta, description: def.produkt } } : { subscription_data: { metadata: meta, description: def.produkt }, payment_method_collection: "if_required" }) };
      const s = await stripe(env, "/checkout/sessions", { method: "POST", body, idem: `pro-checkout:${plan}:${meta.projekt || "-"}:${b.forsok}`, fetchImpl });
      if (!s || typeof s.url !== "string" || !/^https:\/\/checkout\.stripe\.com\//.test(s.url)) return svar({ status: "stripe_svar" }, 502);
      return svar({ url: s.url });
    }
    if (url.pathname === "/pro/kvitto" && request.method === "GET") {
      const sid = url.searchParams.get("session_id") || "";
      if (!SESSION_RE.test(sid) || (sid.startsWith("cs_live_") !== (proMode(env) === "live"))) return svar({ status: "ogiltig_session" }, 400);
      if (await raknare(env, `pro:rl:kv:${await ipNyckel(request)}:${tim}`, 60, 4000)) return svar({ status: "for_manga" }, 429); // skyddar kontots Stripe-gräns (delas med GMO)
      const s = await stripe(env, `/checkout/sessions/${sid}?expand%5B%5D=subscription`, { fetchImpl });
      const md = (s && s.metadata) || {};
      if (!s || s.object !== "checkout.session" || s.livemode !== (proMode(env) === "live") || !arPro(s) || !Object.prototype.hasOwnProperty.call(PLANER, md.plan)) return svar({ status: "ej_pro_session" }, 400);
      if (s.status !== "complete" || !["paid", "no_payment_required"].includes(s.payment_status)) return svar({ status: "ej_betald" }, 402);
      const kop = await registreraKop(env,s,{nowS});
      if (kop.raderat || kop.aterkallad) return svar({status:"angrad"},402);
      const order = await orderRef(s.id);
      const regRa = await kvGet(env, K(env, `angra:reg:${order}`)); let reg = null; try { reg = regRa && JSON.parse(regRa); } catch { reg = { utfall: "okant" }; }
      if (reg && reg.utfall !== "manuell_provning") return svar({ status: "angrad", order }, 402); // efter fristen gäller köpet tills ärendet prövats
      if (md.plan === "projekt") {
        if (!PROJEKT_RE.test(String(md.projekt)) || s.mode !== "payment") return svar({ status: "ej_pro_session" }, 400);
        const exp = projektSlut(s); if (exp <= nowS) return svar({ status: "projekt_utgatt", order }, 402);
        bakom(bekraftelse(env, s, { fetchImpl }));
        return svar({ token: await signToken(env, { t: "projekt", p: md.projekt, exp, o: order }), plan: "projekt", projektId: md.projekt, exp, order });
      }
      const sub = s.subscription && typeof s.subscription === "object" ? s.subscription : null;
      if (s.mode !== "subscription" || !sub || !AKTIV.has(sub.status)) return svar({ status: "pren_ej_aktiv" }, 402);
      bakom(bekraftelse(env, s, { fetchImpl }));
      return svar({ ...(await prenToken(env, String(s.customer || sub.customer), sub, nowS)), order, intervall: md.plan });
    }
    if (url.pathname === "/pro/forny" && request.method === "POST") {
      const b = await lasKropp(request, TOKEN_MAX + 64); if (!b) return svar({ status: "ogiltig_token" }, 401);
      const t0 = await verifyToken(env, b.token, 0); // signatur och läge först; utgångstid prövas per typ nedan
      if (!t0) return svar({ status: "ogiltig_token" }, 401);
      if (t0.t === "projekt") {
        if (!(t0.exp > nowS)) return svar({ status: "projekt_utgatt" }, 402);
        if (!ORDER_RE.test(String(t0.o)) || !PROJEKT_RE.test(String(t0.p))) return svar({ status: "ogiltig_token" }, 401);
        if (await kvGet(env, K(env, `sparr:${t0.o}`))) return svar({ status: "sparrad" }, 402); // spärren gäller köpet, inte projektet: ett nytt köp av samma projekt fungerar
        return svar({ token: b.token, plan: "projekt", projektId: t0.p, exp: t0.exp, order: t0.o });
      }
      if (t0.t !== "pren" || !(t0.exp > nowS - PREN_MAX_S)) return svar({ status: "ogiltig_token" }, 401); // utgången upp till 7 d kan förnyas
      const sub = await aktivPren(env, t0.c, fetchImpl); if (!sub) return svar({ status: "pren_ej_aktiv" }, 402);
      return svar(await prenToken(env, t0.c, sub, nowS));
    }
    if (url.pathname === "/pro/inloggning" && request.method === "POST") {
      const b = await lasKropp(request); const epostRa = b && typeof b.epost === "string" ? b.epost.trim() : "", epost = epostRa.toLowerCase();
      const kvitt = svar({ status: "skickat_om_aktiv" }, 202); // samma svar oavsett utfall: ingen kontoupptäckt
      if (!validMailTo(epost)) return svar({ status: "ogiltig_epost" }, 400);
      if (!mailHttpConfig(env).on) return svar({ status: "inloggning_stangd" }, 503); // konfiguration, säger inget om adressen
      const eh = (await sha256Hex(epost)).slice(0, 24);
      if (await raknare(env, `pro:rl:e:${eh}:${tim}`, 3, 4000) || await raknare(env, `pro:rl:li:${await ipNyckel(request)}:${tim}`, 10, 4000) || await raknare(env, `pro:rl:g:${tim}`, 200, 4000)) return kvitt;
      let kund = null; const sedda = new Set();
      for (const e of [...new Set([epostRa, epost])]) { // Stripes e-postfilter är skiftlägeskänsligt
        const kunder = await stripe(env, `/customers?email=${encodeURIComponent(e)}&limit=20`, { fetchImpl });
        for (const c of (kunder && Array.isArray(kunder.data) ? kunder.data : [])) { if (sedda.has(c.id)) continue; sedda.add(c.id); if (await aktivPren(env, c.id, fetchImpl)) { kund = c.id; break; } }
        if (kund) break;
      }
      if (!kund) return kvitt;
      const nonce = randomToken(18);
      const sp = await register(env, "nonce_spara", { nu: nowS, n: nonce, kund, ttl: LOGIN_S + 60 }); // K1: atomiskt i ProRegister (tidigare KV)
      if (!sp || !sp.ok) throw Object.assign(new Error("nonce kunde inte sparas"), { status: 502 });
      const t = await signToken(env, { t: "login", c: kund, n: nonce, exp: nowS + LOGIN_S });
      const ret = returUrl(env), sep = ret.includes("?") ? "&" : "?";
      await skickaMejl(env, { till: epostRa, nyckel: `login-${nonce}`, tak: true, amne: MEJL.login_amne, text: fyll(MEJL.login, { lank: `${ret}${sep}pro=login&t=${encodeURIComponent(t)}` }) });
      return kvitt; // även vid mejlfel: ett annat svar skulle avslöja att adressen har aktiv PRO
    }
    // Projektköp kan inte loggas in (inget konto). Med ordernummer och e-post skickas en länk till köpets e-post som hämtar köpet igen (/pro/kvitto).
    if (url.pathname === "/pro/aterhamta" && request.method === "POST") {
      const b = await lasKropp(request); const order = String((b && b.order) || "").trim().toUpperCase(), epostRa = String((b && b.epost) || "").trim(), epost = epostRa.toLowerCase();
      const kvitt = svar({ status: "skickat_om_finns" }, 202);
      if (!ORDER_RE.test(order) || !validMailTo(epost)) return svar({ status: "ogiltiga_uppgifter" }, 400);
      if (!mailHttpConfig(env).on) return svar({ status: "stangd" }, 503);
      const eh = (await sha256Hex(epost)).slice(0, 24);
      if (await raknare(env, `pro:rl:h:ip:${await ipNyckel(request)}:${tim}`, 10, 4000) || await raknare(env, `pro:rl:h:e:${eh}:${tim}`, 3, 4000)) return kvitt;
      const s = await hittaKop(env, epostRa, order, fetchImpl);
      if (!s || !["paid", "no_payment_required"].includes(s.payment_status)) return kvitt;
      const regRa = await kvGet(env, K(env, `angra:reg:${order}`)); let reg = null; try { reg = regRa && JSON.parse(regRa); } catch { reg = { utfall: "okant" }; }
      if (reg && reg.utfall !== "manuell_provning") return kvitt;
      if (s.metadata.plan === "projekt" && projektSlut(s) <= nowS) return kvitt;
      const ret = returUrl(env), sep = ret.includes("?") ? "&" : "?";
      await skickaMejl(env, { till: s.customer_details.email, nyckel: `aterhamta-${order}-${tim}`, tak: true, amne: fyll(MEJL.aterhamta_amne, { order }),
        text: fyll(MEJL.aterhamta, { order, lank: `${ret}${sep}pro=ok&session_id=${s.id}` }) }); // bara till köpets egen adress
      return kvitt;
    }
    if (url.pathname === "/pro/inloggning/bekrafta" && request.method === "POST") {
      const b = await lasKropp(request, TOKEN_MAX + 64); const t = b && (await verifyToken(env, b.t, nowS));
      if (!t || t.t !== "login" || typeof t.n !== "string") return svar({ status: "ogiltig_lank" }, 401);
      const los = await register(env, "nonce_los", { nu: nowS, n: t.n, kund: t.c }); // K1: läs, jämför och radera i EN transaktion (exakt en vinnare)
      if (!los || !los.ok) return svar({ status: "lank_anvand_eller_utgangen" }, 401);
      const sub = await aktivPren(env, t.c, fetchImpl); if (!sub) return svar({ status: "pren_ej_aktiv" }, 402);
      return svar(await prenToken(env, t.c, sub, nowS));
    }
    if (url.pathname === "/pro/portal" && request.method === "POST") {
      const b = await lasKropp(request, TOKEN_MAX + 64); const t = b && (await verifyToken(env, b.token, nowS));
      if (!t || t.t !== "pren") return svar({ status: "ogiltig_token" }, 401);
      const conf = await sakraPortal(env, fetchImpl);
      const p = await stripe(env, "/billing_portal/sessions", { method: "POST", body: { customer: t.c, return_url: returUrl(env), locale: "sv", configuration: conf }, fetchImpl });
      if (!p || typeof p.url !== "string" || !/^https:\/\/billing\.stripe\.com\//.test(p.url)) return svar({ status: "stripe_svar" }, 502);
      return svar({ url: p.url });
    }
    if (url.pathname === "/pro/angra" && request.method === "POST") {
      const form = (request.headers.get("content-type") || "").toLowerCase().startsWith("application/x-www-form-urlencoded");
      const self = new URL("/pro/angra", url).href;
      const ut = (status, json, titel, rader, formular) => (form ? htmlSvar(env, titel, rader, formular, status) : svar(json, status));
      const b = await lasKropp(request);
      if (!b) return ut(400, { status: "ogiltig_kropp" }, "Något gick fel", ["Formuläret kunde inte läsas. Försök igen."]);
      if (String(b.steg || "1") === "2") {
        const id = String(b.id || ""); if (!/^[A-Za-z0-9_-]{24,64}$/.test(id)) return ut(400, { status: "ogiltigt_id" }, "Försök igen", ["Bekräftelsen har gått ut. Börja om på ångersidan."]);
        const vk = K(env, `angra:vantar:${id}`), raw = await kvGet(env, vk); if (!raw) return ut(410, { status: "utgangen" }, "Försök igen", ["Bekräftelsen har gått ut. Börja om på ångersidan."]);
        const v = JSON.parse(raw);
        const r = await registreraAnger(env, v.sid, { epost: v.epost, kvittoTill: v.kvittoTill, nowS, fetchImpl }); // kastar vid fel: id:t finns kvar och kunden kan försöka igen
        await kvDel(env, vk);
        if (!r.ok) return ut(404, { status: "hittas_inte" }, "Vi hittade inget köp", ["Kontrollera ordernumret och e-postadressen."]);
        const text = r.utfall === "aterbetalas" ? mejlTexter(env).utfall_aterbetalas : r.utfall === "avslutas_och_aterbetalas" ? mejlTexter(env).utfall_avslutas : MEJL.utfall_manuell;
        return ut(200, { status: "registrerad", order: r.order, tid: r.tid, tid_text: tidSv(r.tid), utfall: r.utfall, dubblett: r.dubblett },
          "Vi har tagit emot ditt meddelande", [`Vi har tagit emot ditt meddelande ${tidSv(r.tid)}. Ett mottagningsbevis skickas till din e-postadress.`, `Ordernummer: ${r.order}`, text]); // S4g angra.skickad
      }
      const order = String(b.order || "").trim().toUpperCase(), epostRa = String(b.epost || "").trim(), epost = epostRa.toLowerCase(), kt = String(b.kvitto_epost || "").trim();
      if (!ORDER_RE.test(order) || !validMailTo(epost) || (kt && !validMailTo(kt))) return ut(400, { status: "ogiltiga_uppgifter" }, "Kontrollera uppgifterna", ["Skriv ordernumret (till exempel PRO-ABCD2345) och e-postadressen du använde vid köpet."]);
      const ip = await ipNyckel(request), eh = (await sha256Hex(epost)).slice(0, 24);
      if (await raknare(env, `pro:rl:a:ip:${ip}:${tim}`, 20, 4000) || await raknare(env, `pro:rl:a:e:${eh}:${tim}`, 8, 4000)) return ut(429, { status: "for_manga" }, "Vänta en stund", ["För många försök. Vänta en stund och försök igen."]);
      const s = await hittaKop(env, epostRa, order, fetchImpl);
      if (!s) return ut(404, { status: "hittas_inte" }, "Vi hittade inget köp", ["Kontrollera ordernumret och e-postadressen. Ordernumret står i kvittot som skickades till din e-post."]);
      const id = randomToken(24);
      await kvPut(env, K(env, `angra:vantar:${id}`), JSON.stringify({ sid: s.id, epost, kvittoTill: kt || null }), 30 * 60);
      return ut(200, { status: "bekrafta", id, order, plan: s.metadata.plan, kopt: datumSv(s.created) }, "Kontrollera uppgifterna", // S4g angra.bekrafta_*
        [`Du är på väg att ångra köpet ${order} (${planNamn(s.metadata.plan)}, ${datumSv(s.created)}). Tryck på knappen för att skicka ditt meddelande.`,
          kt && kt.toLowerCase() !== epost ? `Mottagningsbeviset skickas till ${epost} och till ${kt}.` : `Mottagningsbeviset skickas till ${epost}.`],
        { action: self, dolda: { steg: "2", id }, knapp: "Bekräfta ångra" });
    }
    return svar({ status: "okand_rutt" }, 404);
  } catch (e) {
    const st = e && e.status === 503 ? 503 : 502;
    if (angraForm) { const kontakt = sellerInfo(env).email; // formuläret utan JS ska få en sida, inte JSON
      return htmlSvar(env, "Något gick fel", ["Vi kunde inte ta emot ditt meddelande just nu. Försök igen om en stund.", ...(validMailTo(kontakt) ? [`Fungerar det inte kan du mejla ditt ångermeddelande till ${kontakt}.`] : [])], null, st); }
    return svar({ status: st === 503 ? "konfiguration" : "tillfalligt_fel" }, st);
  }
}

export function kontoCheckout(request,env,ctx,{fetchImpl,now,kontoEhash}) {
  if(!/^[0-9a-f]{64}$/.test(String(kontoEhash))) throw new StripeFel(503,"konto_saknas");
  const u=new URL(request.url); u.pathname="/pro/checkout";
  return handlePro(new Request(u,request),env,ctx,{fetchImpl,now,kontoEhash});
}
export async function kontoAbonnemang(env,kontoId,{order,fetchImpl=fetch,nowS=Math.floor(Date.now()/1000)} = {}) {
  const mode=proMode(env); if(mode === "off") throw new StripeFel(503,"stangt");
  const r=await register(env,"ratt",{nu:nowS,kontoId,mode});
  const kop=(r.kop || []).filter(p=>p.plan !== "projekt" && !p.aterkallad);
  if (!order) return {abonnemang:kop.map(p=>({order:p.order_ref,plan:p.plan}))};
  const p=kop.find(p=>p.order_ref === order); if(!p) return null;
  const conf=await sakraPortal(env,fetchImpl);
  const portal=await stripe(env,"/billing_portal/sessions",{method:"POST",body:{customer:p.kund,return_url:returUrl(env)+"#mitt-konto",locale:"sv",configuration:conf},fetchImpl});
  if(!/^https:\/\/billing\.stripe\.com\//.test(portal?.url || "")) throw new StripeFel(502,"stripe_svar");
  return {url:portal.url};
}

// ---------- valfri webhookkrok (Don: i compare_routes före ORDER_ID-kontrollen) ----------
export async function proWebhook(env, ev, { fetchImpl = fetch } = {}) {
  let s = ev?.data?.object;
  const mode = proMode(env);
  if (mode === "off") return {ok:false,stangt:true};
  // Endpointens event-version är fristående från vår låsta GET-version. Läs aktuella
  // serverobjekt innan konto/återbetalning ändras; snapshoten är bara en signerad signal.
  if (["checkout.session.completed","checkout.session.async_payment_succeeded"].includes(ev.type) && arPro(s) && s.livemode === (mode === "live")) {
    if (!SESSION_RE.test(String(s.id))) throw new StripeFel(502,"session_form");
    const aktuell = await stripe(env,`/checkout/sessions/${s.id}?expand%5B%5D=subscription&expand%5B%5D=invoice`,{fetchImpl});
    if (aktuell?.id !== s.id || aktuell.object !== "checkout.session" || aktuell.livemode !== s.livemode) throw new StripeFel(502,"session_identitet");
    s = aktuell;
  }
  // Charge.invoice försvann i Basil. Versionerade event normaliseras med vår
  // GET-version, som fortfarande har den verifierbara faktura→prenumeration-kedjan.
  if (ev.type === "charge.refunded" && s?.object === "charge" && s.livemode === (mode === "live") && ev.api_version) {
    if (!/^ch_[A-Za-z0-9_]+$/.test(String(s.id))) throw new StripeFel(502,"charge_form");
    const aktuell = await stripe(env,`/charges/${s.id}`,{fetchImpl});
    if (aktuell?.id !== s.id || aktuell.object !== "charge" || aktuell.livemode !== s.livemode || aktuell.payment_intent !== s.payment_intent) throw new StripeFel(502,"charge_identitet");
    s = aktuell;
  }
  if (ev.type === "charge.refunded" && s?.object === "charge" && s.livemode === (mode === "live") && s.refunded === true && s.payment_intent) {
    let fakturaSpärr=0;
    if (s.invoice) {
      const inv=await stripe(env,`/invoices/${typeof s.invoice === "string" ? s.invoice : s.invoice.id}`,{fetchImpl});
      const pi=typeof inv?.payment_intent === "string" ? inv.payment_intent : inv?.payment_intent?.id;
      const sub=typeof inv?.subscription === "object" ? inv.subscription : inv?.subscription ? await stripe(env,`/subscriptions/${inv.subscription}`,{fetchImpl}) : null;
      if (pi === s.payment_intent && arPro(sub)) {
        await register(env,"pren_faktura_sparr",{nu:Math.floor(Date.now()/1000),mode,prenId:sub.id,faktura:inv.id}); fakturaSpärr=1;
      }
    }
    const finns=(await register(env,"kop_betalning",{nu:Math.floor(Date.now()/1000),mode,betalningId:s.payment_intent})).finns;
    if (!arPro(s) && !finns && !fakturaSpärr) return {ok:true,ignored:"ej_pro"};
    return {ok:true,aterkallade:(arPro(s) || finns ? (await aterkallaKop(env,{betalningId:s.payment_intent})).antal : 0)+fakturaSpärr};
  }
  if (!arPro(s) || s.livemode !== (mode === "live")) return {ok:true,ignored:"ej_pro"};
  if (["checkout.session.completed","checkout.session.async_payment_succeeded"].includes(ev.type)) {
    const kop = await registreraKop(env,s);
    if (!kop.ok) return {ok:true,ignored:"ej_betald"};
    const r = await bekraftelse(env,s,{fetchImpl}); return {ok:true,konto:true,bekraftelse:r.ok ? "skickad" : r.kod};
  }
  return {ok:true,ignored:"typ"};
}

// ---------- schemalagt (Don: scheduled-hanterare, varje timme) ----------
// 1) bekräftelser som inte gått ut ännu, 2) kvitto vid förnyelse, 3) årspåminnelse (lag 2014:1449), 4) ofullständiga ångerärenden.
// Listor hämtas sida för sida (has_more/next_page, med tak) och ett trasigt objekt stoppar aldrig resten.
const SIDOR_MAX = 20;
async function allaSidor(env, bas, { fetchImpl }) { // Stripes list-API: starting_after
  const ut = []; let efter = null;
  for (let i = 0; i < SIDOR_MAX; i++) {
    const l = await stripe(env, bas + (efter ? `&starting_after=${encodeURIComponent(efter)}` : ""), { fetchImpl }); const d = (l && Array.isArray(l.data) ? l.data : []);
    ut.push(...d); if (!(l && l.has_more) || !d.length) break; efter = d[d.length - 1].id;
  }
  return ut;
}
export async function proSchema(env, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  if (proMode(env) === "off") return { ok: true, av: true };
  const nowS = Math.floor(now() / 1000), rapport = { bekraftelser: 0, fornyelser: 0, paminnelser: 0, anger: 0, fel: [] };
  const felNamn = (e) => (e && e.code) || (e && e.message) || "fel";
  const steg = async (namn, f) => { try { await f(); } catch (e) { rapport.fel.push(namn + ":" + felNamn(e)); } };
  const per = async (namn, f) => { try { await f(); } catch (e) { rapport.fel.push(namn + ":" + felNamn(e)); } }; // per objekt
  await steg("bekr", async () => {
    for (const s of await allaSidor(env, `/checkout/sessions?status=complete&limit=100&created%5Bgte%5D=${nowS - 3 * DAG}`, { fetchImpl }))
      await per("bekr", async () => { if (arPro(s) && s.livemode === (proMode(env) === "live")) { await registreraKop(env,s,{nowS}); if (!(await kvGet(env, `pro:mejl:bekr-${s.id}`))) { const r = await bekraftelse(env,s,{fetchImpl}); if (r.ok && !r.dubblett) rapport.bekraftelser++; } } });
  });
  await steg("fornyelse", async () => {
    for (const inv of await allaSidor(env, `/invoices?status=paid&limit=100&created%5Bgte%5D=${nowS - 3 * DAG}&expand%5B%5D=data.subscription`, { fetchImpl }))
      await per("fornyelse", async () => {
        const sub = inv && typeof inv.subscription === "object" ? inv.subscription : null;
        if (!inv || inv.billing_reason !== "subscription_cycle" || !arPro(sub) || await kvGet(env, `pro:mejl:fornyelse-${inv.id}`)) return;
        const nasta = periodSlut(sub), order = await orderRef(inv.id);
        const r = await skickaMejl(env, { till: inv.customer_email, nyckel: `fornyelse-${inv.id}`, amne: fyll(MEJL.fornyelse_amne, { order }),
          text: fyll(MEJL.fornyelse, { order, plan: planNamn(sub.metadata.plan), tid: tidSv(inv.created), inkl: krText(inv.amount_paid), moms: krText(Number(inv.tax) || 0),
            nasta: nasta ? datumSv(nasta) : "enligt kundportalen", uppsagningsrad: fyll(MEJL.uppsagningsrad, { pro_lank: returUrl(env) }), saljare: saljarText(env) }) });
        if (r.ok && !r.dubblett) rapport.fornyelser++;
      });
  });
  await steg("paminnelse", async () => {
    const q = encodeURIComponent(`status:'active' AND metadata['pro']:'${PRO_VERSION}' AND metadata['plan']:'ar'`), pr = priser(env), subs = [];
    let sida = null;
    for (let i = 0; i < SIDOR_MAX; i++) { // sök-API:t: next_page
      const l = await stripe(env, `/subscriptions/search?limit=100&query=${q}&expand%5B%5D=data.customer${sida ? `&page=${encodeURIComponent(sida)}` : ""}`, { fetchImpl });
      subs.push(...((l && l.data) || [])); if (!(l && l.has_more && l.next_page)) break; sida = l.next_page;
    }
    for (const sub of subs) await per("paminnelse", async () => {
      const slut = periodSlut(sub); if (!slut || sub.cancel_at_period_end) return;
      const kvar = slut - nowS; if (kvar < 33 * DAG || kvar > 46 * DAG) return; // skickas 33–46 dygn före förnyelse: alltid minst en månad före sista uppsägningsdag
      const kund = sub.customer && typeof sub.customer === "object" ? sub.customer : null; if (!kund || !kund.email) return;
      const item = sub.items && sub.items.data && sub.items.data[0], inkl = item && item.price && item.price.unit_amount ? item.price.unit_amount : pr.ok ? pr.planer.ar.inkl_ore : null;
      const r = await skickaMejl(env, { till: kund.email, nyckel: `pamin-${sub.id}-${slut}`, amne: fyll(MEJL.paminnelse_amne, { fornyelse_datum: datumSv(slut) }),
        text: fyll(MEJL.paminnelse, { fornyelse_datum: datumSv(slut), sista_dag: datumSv(slut - DAG), inkl: inkl ? krText(inkl) : "samma som i år",
          uppsagningsrad: fyll(MEJL.uppsagningsrad, { pro_lank: returUrl(env) }), saljare: saljarText(env) }) });
      if (r.ok && !r.dubblett) rapport.paminnelser++;
    });
  });
  await steg("anger", async () => {
    if (!env.REVIEWS_KV || typeof env.REVIEWS_KV.list !== "function") return;
    const prefix = K(env, "angra:oppen:"); let cursor;
    for (let i = 0; i < SIDOR_MAX; i++) {
      const l = await env.REVIEWS_KV.list({ prefix, limit: 100, ...(cursor ? { cursor } : {}) });
      for (const k of (l && l.keys) || []) await per("anger", async () => {
        const order = k.name.slice(prefix.length), raw = await kvGet(env, K(env, `angra:reg:${order}`)); if (!raw) { await kvDel(env, k.name); return; }
        const reg = JSON.parse(raw); if (reg.steg && reg.steg.avslutad) { await kvDel(env, k.name); return; }
        const s = await stripe(env, `/checkout/sessions/${reg.sid}?expand%5B%5D=subscription&expand%5B%5D=invoice`, { fetchImpl });
        await slutforAnger(env, s, reg, { fetchImpl });
        if (reg.steg.avslutad) rapport.anger++;
      });
      if (!l || l.list_complete !== false || !l.cursor) break; cursor = l.cursor;
    }
  });
  return { ok: rapport.fel.length === 0, ...rapport };
}
