// Testmiljö för Jämför mina offerter: RIKTIGA klasserna CompareOrders/CompareBudget bakom
// minnesbaserad lagring (en förfrågan i taget per objekt), minnes-KV och en fetch-attrapp som
// ersätter Anthropic och Stripe. Ingen riktig modell, inga riktiga betalningar. In-memory-prov är
// INTE bevis på produktionsbeständighet.
import { CompareOrders } from "../../src/compare_orders.js";
import { CompareBudget } from "../../src/compare_budget.js";
import { signForTest } from "../../src/compare_stripe.js";
import { sha256Hex } from "../../src/compare_util.js";
import worker from "../../src/index.js";
import { gateVars } from "./free_gate.mjs";
import { AsyncLocalStorage } from "node:async_hooks";

const cbwLock = new AsyncLocalStorage();

export function memoryKv() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); if (v === undefined) return null; return type === "json" ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
  };
}

function fakeNs(Cls, env) {
  const objs = new Map();
  const get = (name) => {
    if (!objs.has(name)) {
      const store = new Map();
      let alarm = null;
      let cbwTail = Promise.resolve();
      const state = {
        storage: {
          async get(k) { const v = store.get(k); return v === undefined ? undefined : structuredClone(v); },
          async put(k, v) { store.set(k, structuredClone(v)); },
          async delete(k) { store.delete(k); },
          async list({ prefix = "" } = {}) { return new Map([...store].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])); },
          // Som SQLite-lagret: en explicit transaktion som rullas tillbaka helt om callbacken kastar.
          // txn.put/delete går via storage.put/delete (så att tester kan injicera skrivfel).
          async transaction(fn) {
            const snap = new Map([...store].map(([k, v]) => [k, structuredClone(v)]));
            const st = state.storage;
            try { return await fn({ get: (k) => st.get(k), put: (k, v) => st.put(k, v), delete: (k) => st.delete(k) }); }
            catch (e) { store.clear(); for (const [k, v] of snap) store.set(k, v); throw e; }
          },
          async setAlarm(t) { alarm = t; },
          async getAlarm() { return alarm; },
        },
        // Som Cloudflare: blockConcurrencyWhile släpper inte in andra händelser (fetch/alarm) förrän återanropet är klart (här återinträdande, så inbäddade anrop i samma kedja inte låser sig).
        async blockConcurrencyWhile(fn) {
          if (cbwLock.getStore() === name) return fn();
          const prev = cbwTail; let release; cbwTail = new Promise((r) => { release = r; });
          await prev;
          try { return await cbwLock.run(name, fn); } finally { release(); }
        },
      };
      if (env.__noTxn) delete state.storage.transaction;
      const o = { obj: new Cls(state, env), tail: Promise.resolve(), store, get alarm() { return alarm; }, clearAlarm() { alarm = null; } };
      objs.set(name, o);
    }
    return objs.get(name);
  };
  return {
    objs,
    idFromName: (n) => n,
    get: (id) => {
      const o = get(id);
      return { fetch: (url, init) => { const run = o.tail.then(() => o.obj.fetch(new Request(url, init))); o.tail = run.catch(() => {}); return run; } };
    },
    // Kör väntande alarm tills inget återstår (som Cloudflare skulle göra).
    async runAlarms(max = 20) {
      let n = 0;
      for (let i = 0; i < max; i++) {
        const due = [...objs.values()].filter((o) => o.alarm !== null);
        if (!due.length) break;
        for (const o of due) { o.clearAlarm(); await o.tail.then(() => o.obj.alarm()); n++; }
      }
      return n;
    },
    peek: (name) => get(name),
  };
}

export const WH_SECRET = "whsec_testsecret1234";
export const ORIGIN = "https://granskaminoffert.se";

export function baseVars(extra = {}) {
  return {
    COMPARE_ENABLED: "1", COMPARE_PAYMENTS: "test", COMPARE_MAILER_MODE: "mock", STRIPE_SECRET_KEY: "sk_test_abcdefgh1234", STRIPE_WEBHOOK_SECRET: WH_SECRET,
    COMPARE_MONTH_CAP_MICRO: "20000000", COMPARE_PAID_CAP_MICRO: "10000000", COMPARE_ORDER_CAP_MICRO: "2000000", COMPARE_DAY_ORDERS: "50",
    COMPARE_RETURN_URL: "https://granskaminoffert.se/jamfor/", ANTHROPIC_API_KEY: "sk-ant-test", ALLOWED_ORIGIN: ORIGIN, ...extra,
  };
}

export function makeEnv(extra = {}) {
  const env = { ...gateVars(), ...baseVars(extra), REVIEWS_KV: memoryKv() };
  env.COMPARE_ORDERS = fakeNs(CompareOrders, env);
  env.COMPARE_BUDGET = fakeNs(CompareBudget, env);
  return env;
}

// ---- Fixtur: offerten är en text som bär modellens "svar" som JSON ----
export function offerText(spec = {}) { return "FIXTURE:" + JSON.stringify(spec); }
const EXTRACT_DEFAULT = { jobType: "badrum", trades: [], hourlyRateSek: null, hours: null, laborSumSek: null, materialSumSek: null, travelSumSek: null, travelVisits: null, materialMarkupPct: null, rotAmountSek: null, rotRatePct: null, rotPersons: null, rotOnMaterialOrTravel: null, priceType: "fast", vatMode: "inkl", totalSumSek: null, totalIncludesVat: null, totalBeforeRotSek: null, amountToPaySek: null, totalVatBasis: null, propertyType: "smahus", totalContract: null, quoteDate: null, plannedPaymentDate: null, customerType: "privatperson", workDescription: "Badrumsrenovering", county: null, areaM2: 6, unitCount: null, otherSumSek: null };
const FLD = (value, ref = "sidfot") => (value === undefined || value === null ? { status: "framgar_inte", value: null, page: null, ref: null } : value === "?" ? { status: "ej_lasbar", value: null, page: null, ref: null } : { status: "framgar", value, page: 1, ref });
// Standard: komplett utställare. spec.issuer: false = ingen identitet alls i svaret; {name:null,...} åsidosätter enskilda fält ("?" = ej läsbart).
export function issuerFixture(o) {
  if (o === false) return undefined;
  const d = { name: "Testbygg AB", orgnr: "556016-0680", address: "Storgatan 1, 352 30 Växjö", city: "Växjö", phone: "0470-123456", web: "testbygg.example.se", role: "utforare", legalForm: "bolag", ...(o || {}) };
  return { name: FLD(d.name), orgnr: FLD(d.orgnr), address: FLD(d.address), city: FLD(d.city), phone: FLD(d.phone), web: FLD(d.web), role: d.role, legalForm: d.legalForm };
}
export function fixtureResponse(spec) {
  const scope = Object.entries(spec.scope || {}).map(([id, status]) => ({ id, status, page: status === "framgar_inte" ? null : 1, ref: status === "framgar_inte" ? null : "rad " + id }));
  return {
    extracted: { ...EXTRACT_DEFAULT, ...(spec.extracted || {}) }, scope,
    issuer: issuerFixture(spec.issuer),
    facts: spec.facts || [{ id: "total", page: 1, ref: "Summa" }],
    readability: { level: spec.readability || "bra" }, instructionsInDocument: !!spec.inj,
  };
}

// ---- fetch-attrapp (Anthropic + Stripe) ----
export function installFetch(opts = {}) {
  const log = { mail: [], mailSent: [], google: [], tp: [], anthropic: [], count: [], stripeCreate: [], stripeGet: [], refunds: [], refundGets: [] };
  const refundsByIdem = new Map();
  const sessions = new Map(); // id -> session-objekt som Stripe skulle returnera
  const byIdem = new Map();
  const ctl = { failNext: [], timeoutNext: 0, countTokens: 3000, usage: { input_tokens: 3000, output_tokens: 800 }, noUsage: false, synthIds: null, refundStatus: "succeeded", refundObj: null, ...opts };
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const body = init.body ? (typeof init.body === "string" ? init.body : String(init.body)) : "";
    if (url === "https://places.googleapis.com/v1/places:searchText") {
      log.google.push({ headers: init.headers, body: JSON.parse(body) });
      if (ctl.googleFail) return Response.json({}, { status: 500 });
      return Response.json({ places: typeof ctl.googlePlaces === "function" ? ctl.googlePlaces(JSON.parse(body)) : ctl.googlePlaces || [] });
    }
    if (url.startsWith("https://tp.example.test/")) {
      log.tp.push({ url, headers: init.headers });
      if (ctl.tpFail) return Response.json({}, { status: ctl.tpFail });
      const f = url.match(/\/v1\/business-units\/find\?name=(.+)$/);
      if (f) return Response.json({ businessUnits: (ctl.tpFind || {})[decodeURIComponent(f[1])] || [] });
      const l = url.match(/\/v1\/business-units\/([A-Za-z0-9]+)\/reviews\/latest\?limit=5$/);
      if (l) { const d = (ctl.tpLatest || {})[l[1]]; return d ? Response.json(d) : Response.json({}, { status: 404 }); }
    }
    if (url.endsWith("/v1/messages/count_tokens")) { log.count.push(JSON.parse(body)); if (ctl.countFail) return Response.json({}, { status: 500 }); return Response.json({ input_tokens: ctl.countTokens }); }
    if (url === "https://api.anthropic.com/v1/messages") {
      const req = JSON.parse(body);
      log.anthropic.push(req);
      if (ctl.holdModel && ctl.holdModel.length) { const hh = ctl.holdModel.shift(); if (hh) await hh; } // test: pausa valfritt modellanrop (t.ex. ånger under pågående körning)
      if (ctl.timeoutNext > 0) { ctl.timeoutNext--; throw new Error("timeout"); }
      if (ctl.failNext.length) { const st = ctl.failNext.shift(); return Response.json({ error: { type: "overloaded_error" } }, { status: st }); }
      const tool = req.tools[0].name;
      const usage = ctl.noUsage ? undefined : ctl.usage;
      if (tool === "submit_priority") {
        const ids = ctl.synthIds || req.tools[0].input_schema.properties.priority_ids.items.enum.slice().reverse().slice(0, 3);
        return Response.json({ stop_reason: "tool_use", usage, content: [{ type: "tool_use", id: "t1", name: "submit_priority", input: { priority_ids: ids } }] });
      }
      if (tool === "submit_issuer") { // D11 förköpsidentitet
        if (ctl.holdIssuer && ctl.holdIssuer.length) { const hh = ctl.holdIssuer.shift(); if (hh) await hh; } // test: pausa modellsvaret
        const t0 = req.messages[0].content.map((b) => b.text || "").join(""); const i0 = t0.indexOf("FIXTURE:"), j0 = t0.indexOf("\n</offert>");
        const sp = i0 >= 0 ? JSON.parse(t0.slice(i0 + 8, j0)) : {};
        return Response.json({ stop_reason: "tool_use", usage, content: [{ type: "tool_use", id: "ti", name: "submit_issuer", input: { issuer: issuerFixture(sp.issuer) || issuerFixture({ name: null, orgnr: null, address: null, city: null, phone: null, web: null }), readability: { level: sp.readability || "bra" } } }] });
      }
      const t = req.messages[0].content.map((b) => b.text || "").join("");
      const i = t.indexOf("FIXTURE:"), j = t.indexOf("\n</offert>");
      const spec = i >= 0 ? JSON.parse(t.slice(i + 8, j)) : {};
      return Response.json({ stop_reason: "tool_use", usage, content: [{ type: "tool_use", id: "t0", name: "submit_offer", input: fixtureResponse(spec) }] });
    }
    if (url === "https://api.stripe.com/v1/checkout/sessions" && init.method === "POST") {
      const idem = init.headers && init.headers["idempotency-key"];
      log.stripeCreate.push({ body, idem });
      if (idem && byIdem.has(idem)) {
        const prev = byIdem.get(idem);
        // Stripe: samma nyckel med ANDRA parametrar nekas (docs.stripe.com/api/idempotent_requests).
        if (prev.body !== body) return Response.json({ error: { type: "idempotency_error", code: "idempotency_key_in_use" } }, { status: 400 });
        return Response.json(prev.session);
      }
      const id = "cs_test_" + String(++n).padStart(10, "0");
      const p = new URLSearchParams(body);
      const s = { id, object: "checkout.session", url: `https://checkout.stripe.test/c/${id}`, expires_at: Number(p.get("expires_at")), mode: "payment", livemode: false, client_reference_id: p.get("client_reference_id"), currency: "sek", amount_total: Number(p.get("line_items[0][price_data][unit_amount]")), status: "open", payment_status: "unpaid", payment_intent: null, payment_method_types: [...p.keys()].filter((k) => /^payment_method_types\[\d\]$/.test(k)).map((k) => p.get(k)).concat([]).length ? [...p.keys()].filter((k) => /^payment_method_types\[\d\]$/.test(k)).map((k) => p.get(k)) : ["card"], metadata: { order_id: p.get("metadata[order_id]") } };
      sessions.set(id, s); if (idem) byIdem.set(idem, { body, session: s });
      return Response.json(s);
    }
    const g = url.match(/^https:\/\/api\.stripe\.com\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/);
    if (g) { log.stripeGet.push(g[1]); const s = sessions.get(g[1]); return s ? Response.json(s) : Response.json({ error: { code: "resource_missing" } }, { status: 404 }); }
    if (url === "https://api.stripe.com/v1/refunds" && init.method === "POST") {
      log.refunds.push(body);
      if (ctl.refundFail) return Response.json({ error: { code: "x" } }, { status: 500 });
      const idem = init.headers && init.headers["idempotency-key"];
      if (idem && refundsByIdem.has(idem)) return Response.json(refundsByIdem.get(idem));
      const r = { id: ctl.refundNoId ? undefined : "re_test_0001", object: "refund", status: ctl.refundStatus, metadata: { order_id: new URLSearchParams(body).get("metadata[order_id]") } };
      if (idem) refundsByIdem.set(idem, r);
      ctl.refundObj = r;
      return Response.json(r);
    }
    const rg = url.match(/^https:\/\/api\.stripe\.com\/v1\/refunds\/(re_[A-Za-z0-9_]+)$/);
    if (rg) { log.refundGets.push(rg[1]); return ctl.refundObj ? Response.json(ctl.refundObj) : Response.json({ error: { code: "resource_missing" } }, { status: 404 }); }
    if (url === "https://api.resend.com/emails" && init.method === "POST") return fakeResend(init, body);
    throw new Error("oväntat externt anrop: " + url);
  };
  // ---- Resend-DUBBEL (ingen riktig leverantör): efterliknar dokumenterad Idempotency-Key-semantik (24 h, samma svar, 409 vid annan nyttolast / pågående). ----
  const mailIdem = new Map();
  ctl.mailSeed = (idem, rec) => mailIdem.set(idem, { at: Date.now(), body: "", id: "seed", inprogress: false, ...rec });
  ctl.mailClear = (idem) => mailIdem.delete(idem);
  async function fakeResend(init, body) {
    const hd = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const idem = hd["idempotency-key"], auth = hd.authorization;
    log.mail.push({ idem, auth, body: JSON.parse(body), at: Date.now() });
    if (!/^Bearer re_/.test(auth || "")) return Response.json({ statusCode: 401, name: "missing_api_key" }, { status: 401 });
    if (!idem || idem.length > 256) return Response.json({ statusCode: 400, name: "invalid_idempotency_key" }, { status: 400 });
    const prev = mailIdem.get(idem);
    if (prev && Date.now() - prev.at <= 24 * 3600_000) {
      if (prev.body !== body) return Response.json({ statusCode: 409, name: "invalid_idempotent_request" }, { status: 409 });
      if (prev.inprogress) return Response.json({ statusCode: 409, name: "concurrent_idempotent_requests" }, { status: 409 });
      return Response.json({ id: prev.id });
    }
    const mode = ctl.mailModes && ctl.mailModes.length ? ctl.mailModes.shift() : ctl.mailMode || "ok";
    if (mode === "500") return Response.json({ statusCode: 500, name: "internal_server_error" }, { status: 500 });
    if (mode === "422") return Response.json({ statusCode: 422, name: "validation_error" }, { status: 422 });
    if (mode === "timeout_before_accept") throw new Error("timeout");
    const rec = { at: Date.now(), body, id: "49a3999c-0ce1-4ea6-ab68-" + String(log.mailSent.length + 1).padStart(12, "0"), inprogress: false };
    mailIdem.set(idem, rec); log.mailSent.push({ idem, body: JSON.parse(body), id: rec.id });
    if (mode === "hold" && ctl.holdMail) { rec.inprogress = true; await ctl.holdMail; rec.inprogress = false; }
    if (mode === "timeout_after_accept") throw new Error("timeout");
    if (mode === "noid") return Response.json({});
    if (mode === "badjson") return new Response("<html>ok</html>", { status: 200 });
    return Response.json({ id: rec.id });
  }
  return { log, ctl, sessions, restore: () => { globalThis.fetch = real; } };
}

// ---- Anrop mot Workern ----
export async function api(env, method, path, { body, token, origin = ORIGIN, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (origin) h.origin = origin;
  if (token) h["x-order-token"] = token;
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await worker.fetch(new Request("https://api.test" + path, { method, headers: h, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined }), env, { waitUntil() {} });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, json };
}

export async function createOrder(env, n, extra = {}) {
  const r = await api(env, "POST", "/compare/orders", { body: { docCount: n, labels: Array.from({ length: n }, (_, i) => ["Byggfirma A", "Bygg B", "C-snickeri", "Firma D"][i]), accept: { sameJob: true }, ...extra } });
  return r;
}
export async function upload(env, orderId, token, idx, spec) {
  return api(env, "PUT", `/compare/orders/${orderId}/docs/${idx}`, { token, body: { kind: "text", text: offerText(spec) } });
}
export async function readyOrder(env, specs) {
  const c = await createOrder(env, specs.length);
  if (c.status !== 201) throw new Error("create " + c.status + JSON.stringify(c.json));
  const { orderId, token } = c.json;
  for (let i = 0; i < specs.length; i++) { const u = await upload(env, orderId, token, i, specs[i]); if (u.status !== 200) throw new Error("upload " + u.status + JSON.stringify(u.json)); }
  return { orderId, token };
}
export async function consentOf(env) { const c = await api(env, "GET", "/compare/config"); return c.json.consent; }
// accept: undefined = kunden kryssar nuvarande texter (hash från servern); null = ingen body ("betala igen"); objekt = som angivet.
export const TEST_EMAIL = "kund@example.test";
export async function startCheckout(env, orderId, token, accept) {
  if (accept === null) return api(env, "POST", `/compare/orders/${orderId}/checkout`, { token });
  if (accept === undefined) { const c = await consentOf(env); accept = c.policy === "P" ? { terms: true, declaration: true, consentHash: c.hash, consentVersion: c.version, email: TEST_EMAIL } : { terms: true, immediateDelivery: true, consentHash: c.hash, consentVersion: c.version, email: TEST_EMAIL }; }
  return api(env, "POST", `/compare/orders/${orderId}/checkout`, { token, body: { accept } });
}

export function paidSession(sess, over = {}) {
  return { ...sess, status: "complete", payment_status: "paid", payment_intent: "pi_test_0000000001", ...over };
}
export async function webhook(env, type, session, { id = "evt_" + Math.random().toString(36).slice(2, 12), t, secret = WH_SECRET, tamper } = {}) {
  let raw = JSON.stringify({ id, type, data: { object: session } });
  const sig = await signForTest(raw, secret, t);
  if (tamper) raw = raw.replace("4900", "100");
  return api(env, "POST", "/compare/webhook", { raw, origin: "", headers: { "stripe-signature": sig, "content-type": "application/json" } });
}
export const sha = sha256Hex;
export const docKeys = (env, orderId) => [...env.REVIEWS_KV.m.keys()].filter((k) => k.startsWith(`cmpdoc:${orderId}:`));

// ---- D07: källor (alla externa anrop är attrapper med SYNTETISKA data) ----
export const REVIEW_VARS = { COMPARE_REVIEWS: "1", COMPARE_REVIEWS_VERIFIED: "1" };
export const MAPS_KEY = "AIzaSyTESTONLYsyntheticKey_0123456789ab"; // syntetisk, ingen riktig nyckel
export const GOOGLE_VARS = { GOOGLE_UI_KIT: "1", GOOGLE_MAPS_BROWSER_KEY: MAPS_KEY, GOOGLE_CANDIDATES: "1", GOOGLE_PLACES_API_SEARCH_VERIFIED: "1", GOOGLE_PLACES_SERVER_KEY: "synthetic-server-key-0123456789", COMPARE_SOURCES_SEARCH_DAY_CAP: "50", COMPARE_SOURCES_MOUNT_DAY_CAP: "100", COMPARE_SOURCES_DETAILS_DAY_CAP: "50" };
export const TP_VARS = { TRUSTPILOT_DISPLAY: "1", TRUSTPILOT_API_BASE: "https://tp.example.test", TRUSTPILOT_API_KEY: "synthetic-tp-key", TRUSTPILOT_AUTH_HEADER: "apikey", COMPARE_TP_DAY_CAP: "50" };
export const placeId = (c) => "ChIJ" + String(c).repeat(24);
export const synthTpReviews = (n, over = {}) => ({ businessUnit: { trustScore: 4.3, numberOfReviews: { total: over.total ?? n } }, reviews: Array.from({ length: n }, (_, i) => ({ stars: 1 + (i % 5), title: "Syntetiskt omdöme " + (i + 1), text: "SYNTETISK TEXT " + (i + 1) + " – inte ett riktigt omdöme.", createdAt: `2026-09-${String(28 - i).padStart(2, "0")}T10:00:00Z`, link: `https://www.trustpilot.com/reviews/synth${i}` })) });


// ---- D14: Resend-leveranshändelser (SYNTETISKA fixturer; hemligheten är påhittad och används aldrig mot någon leverantör) ----
export const MAIL_WH_SECRET = "whsec_" + btoa("TESTONLY-synthetic-resend-wh-secret-0123456789");
export async function mailEvent(env, type, { emailId, to, mailId, id = "msg_" + Math.random().toString(36).slice(2, 14), ts, secret = MAIL_WH_SECRET, tamper, tags, createdAt, extra, rawOverride, drop = [], bounce } = {}) {
  const { signResendForTest } = await import("../../src/compare_mailer.js");
  const t = ts ?? Math.floor(Date.now() / 1000);
  const data = { email_id: emailId, from: "EVENT-AVSÄNDARE <ev@example.test>", to: Array.isArray(to) ? to : [to], subject: "SYNTETISKT ÄMNE", created_at: new Date().toISOString(), tags: tags === undefined ? (mailId ? { gmo_mail: mailId } : {}) : tags, ...(bounce ? { bounce } : {}), ...(extra || {}) };
  const body = rawOverride !== undefined ? rawOverride : JSON.stringify({ type, created_at: createdAt || new Date().toISOString(), data });
  const hd = await signResendForTest(body, secret, { id, ts: t });
  for (const k of drop) delete hd[k];
  const send = tamper ? body.replace('"email_id"', '"email_id" ') : body;
  const res = await worker.fetch(new Request("https://api.test/compare/mail-events", { method: "POST", headers: { "content-type": "application/json", ...hd }, body: send }), env, { waitUntil() {} });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, json, id };
}
// Skickar `type` för varje (ännu ej hanterad per typ) mejl som Resend-dubbeln faktiskt accepterat. Returnerar antal händelser.
export async function flushMailEvents(env, f, type = "email.delivered") {
  f.ctl.eventsDone = f.ctl.eventsDone || new Set();
  let n = 0;
  for (const m of f.log.mailSent) {
    const k = type + m.id; if (f.ctl.eventsDone.has(k)) continue;
    const r = await mailEvent(env, type, { emailId: m.id, to: m.body.to, mailId: (m.body.tags && m.body.tags[0] && m.body.tags[0].value) || undefined });
    if (r.status !== 200) throw new Error("mailEvent " + r.status + JSON.stringify(r.json));
    f.ctl.eventsDone.add(k); n++;
  }
  return n;
}
