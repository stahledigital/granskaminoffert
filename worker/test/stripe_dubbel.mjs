// Delade testdubblar för P3 (Stripe med tillstånd, KV) – används av pro_routes.test.mjs och e2e. Inga nätanrop.
import { STRIPE_VERSION } from "../src/pro_routes.js";
import { ProRegister, ProKonto } from "../src/pro_konto.js";
import { namnrymd } from "./helpers/pro_do_dubbel.mjs";
const DAG = 86400;
export function kv() {
  const m = new Map();
  return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); }, delete: async (k) => { m.delete(k); },
    list: async ({ prefix = "", limit = 1000, cursor } = {}) => { // som Workers KV: lexikografisk ordning, cursor och list_complete
      const alla = [...m.keys()].filter((k) => k.startsWith(prefix)).sort(), fran = cursor ? Number(cursor) : 0, sida = alla.slice(fran, fran + limit), klar = fran + limit >= alla.length;
      return { keys: sida.map((name) => ({ name })), list_complete: klar, ...(klar ? {} : { cursor: String(fran + limit) }) }; } };
}
export const SALJARE = { COMPARE_SELLER_FORM: "ENSKILD", COMPARE_SELLER_NAME: "Ståhle Digital", COMPARE_SELLER_OWNER_NAME: "Testägare", COMPARE_SELLER_EMAIL: "hej@stahledigital.se",
  COMPARE_SELLER_ADDRESS: "Testgatan 1, 111 11 Teststad", COMPARE_SELLER_PHONE: "+46700000000", COMPARE_COMPANY_INFO_URL: "https://stahledigital.se/foretagsuppgifter/" };
export const ENV = (extra = {}) => ({ PRO_PAYMENTS: "test", STRIPE_TEST_SECRET_KEY: "sk_test_DUBBEL", STRIPE_TEST_WEBHOOK_SECRET: "whsec_TESTDUBBEL0123456789",
  STRIPE_SECRET_KEY: "sk_live_DUBBEL", STRIPE_WEBHOOK_SECRET: "whsec_LIVEDUBBEL0123456789", PRO_ALLOWED_ORIGIN: "https://stahledigital.se",
  COMPARE_MAIL_HTTP: "1", COMPARE_MAIL_HTTP_VERIFIED: "1", COMPARE_MAIL_FROM: "Granska min offert <hej@stahledigital.se>", COMPARE_MAIL_DAY_CAP: "50",
  COMPARE_MAIL_API_KEY: "re_TESTDUBBEL0123456789", COMPARE_MAIL_WEBHOOK_SECRET: "whsec_" + "A".repeat(32), REVIEWS_KV: kv(),
  PRO_REGISTER: namnrymd(ProRegister), PRO_KONTON: namnrymd(ProKonto), ...SALJARE, ...extra }); // K1: login-noncen ligger i ProRegister
// ---------- Stripe-dubbel med tillstånd ----------
export function fakeStripe({ nuS = () => Math.floor(Date.now() / 1000) } = {}) {
  const st = { taxRates: [], prices: [], sessions: new Map(), subs: new Map(), invoices: new Map(), customers: new Map(), refunds: [], portals: [], idem: new Map(), anrop: [], n: 0, felPa: null };
  const id = (p) => `${p}_${String(++st.n).padStart(10, "0")}`;
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
  const fel = (status, code) => json({ error: { code, message: "hemligt internt fel sk_live_LÄCKA" } }, status);
  const parse = (body) => { const o = {}; for (const [k, v] of new URLSearchParams(body || "")) o[k] = v; return o; };
  const f = async (url, init = {}) => {
    const u = new URL(url), path = u.pathname.replace(/^\/v1/, ""), m = init.method || "GET", b = parse(init.body), h = init.headers || {};
    st.anrop.push({ m, path, q: u.search, b, h });
    if (h["stripe-version"] !== STRIPE_VERSION) return fel(400, "saknar_version");
    if (st.felPa && st.felPa(m, path)) return fel(500, "api_error");
    const ik = h["idempotency-key"];
    if (ik && st.idem.has(ik)) { const prev = st.idem.get(ik); if (prev.body !== init.body) return fel(400, "idempotency_key_in_use"); return json(prev.svar); }
    const svar = hantera(m, path, u.searchParams, b);
    if (svar instanceof Response) return svar;
    if (ik) st.idem.set(ik, { body: init.body, svar });
    return json(svar);
  };
  function expand(s, q) {
    const ex = q.getAll("expand[]"), o = structuredClone(s);
    if (ex.includes("subscription") && o.subscription) o.subscription = structuredClone(st.subs.get(o.subscription));
    if (ex.includes("invoice") && o.invoice) o.invoice = structuredClone(st.invoices.get(o.invoice));
    return o;
  }
  function hantera(m, path, q, b) {
    if (m === "GET" && path === "/tax_rates") return { data: st.taxRates.filter((t) => t.active && String(t.inclusive) === q.get("inclusive")) };
    if (m === "POST" && path === "/tax_rates") { const t = { id: id("txr"), active: true, inclusive: b.inclusive === "true", percentage: Number(b.percentage), country: b.country, tax_type: b.tax_type, metadata: { pro_moms: b["metadata[pro_moms]"] } }; st.taxRates.push(t); return t; }
    if (m === "GET" && path === "/prices") { const lk = q.get("lookup_keys[]"); return { data: st.prices.filter((p) => p.active && p.lookup_key === lk) }; }
    if (m === "POST" && path === "/prices") {
      if (st.prices.some((p) => p.lookup_key === b.lookup_key)) return fel(400, "lookup_key_exists");
      const p = { id: id("price"), active: true, currency: b.currency, unit_amount: Number(b.unit_amount), lookup_key: b.lookup_key, recurring: b["recurring[interval]"] ? { interval: b["recurring[interval]"] } : null, product_name: b["product_data[name]"] }; st.prices.push(p); return p;
    }
    if (m === "POST" && path === "/checkout/sessions") {
      const pris = st.prices.find((p) => p.id === b["line_items[0][price]"]); if (!pris) return fel(400, "resource_missing");
      const meta = {}; for (const [k, v] of Object.entries(b)) { const mm = /^metadata\[(\w+)\]$/.exec(k); if (mm) meta[mm[1]] = v; }
      const s = { id: id("cs_test"), object: "checkout.session", livemode: false, mode: b.mode, status: "open", payment_status: "unpaid", metadata: meta, created: nuS(), url: "https://checkout.stripe.com/c/pay/x", _pris: pris, _body: b,
        amount_total: null, total_details: { amount_tax: 0 }, customer_details: null, customer: null, payment_intent: null, subscription: null, invoice: null };
      st.sessions.set(s.id, s); return { ...s, url: "https://checkout.stripe.com/c/pay/" + s.id };
    }
    let mm;
    if (m === "GET" && (mm = /^\/checkout\/sessions\/(cs_\w+)$/.exec(path))) { const s = st.sessions.get(mm[1]); return s ? expand(s, q) : fel(404, "resource_missing"); }
    if (m === "GET" && path === "/checkout/sessions") {
      const e = q.get("customer_details[email]"), gte = q.get("created[gte]");
      return { data: [...st.sessions.values()].filter((s) => (!q.get("status") || s.status === q.get("status")) && (!e || (s.customer_details && s.customer_details.email === e)) && (!gte || s.created >= Number(gte))) };
    }
    if (m === "GET" && path === "/subscriptions") return { data: [...st.subs.values()].filter((s) => s.customer === q.get("customer")) };
    if (m === "GET" && path === "/subscriptions/search") {
      const qq = q.get("query"); return { data: [...st.subs.values()].filter((s) => s.status === "active" && qq.includes(`metadata['plan']:'${s.metadata.plan}'`) && s.metadata.pro === "pro-v1").map((s) => ({ ...structuredClone(s), customer: st.customers.get(s.customer) })) };
    }
    if ((mm = /^\/subscriptions\/(sub_\w+)$/.exec(path))) {
      const s = st.subs.get(mm[1]); if (!s) return fel(404, "resource_missing");
      if (m === "GET") return s;
      if (m === "POST") { if (s.status === "canceled") return fel(400, "subscription_canceled"); for (const [k, v] of Object.entries(b)) { const x = /^metadata\[(\w+)\]$/.exec(k); if (x) s.metadata[x[1]] = v; } return s; }
      if (m === "DELETE") { if (s.status === "canceled") return fel(400, "subscription_canceled"); s.status = "canceled"; return s; }
    }
    if (m === "GET" && (mm = /^\/invoices\/(in_\w+)$/.exec(path))) return st.invoices.get(mm[1]) || fel(404, "resource_missing");
    if (m === "GET" && path === "/invoices" && q.get("subscription")) return { data: [...st.invoices.values()].filter((i) => i.subscription === q.get("subscription")).map((i) => structuredClone(i)), has_more: false };
    if (m === "GET" && path === "/invoices") { const gte = Number(q.get("created[gte]")); return { data: [...st.invoices.values()].filter((i) => i.status === "paid" && i.created >= gte).map((i) => ({ ...structuredClone(i), subscription: structuredClone(st.subs.get(i.subscription)) })) }; }
    if (m === "POST" && path === "/refunds") {
      const pi = b.payment_intent, belopp = st.refunds.filter((r) => r.payment_intent === pi).reduce((a, r) => a + r.amount, 0), betalt = st._betalt.get(pi) || 0;
      if (belopp >= betalt) return fel(400, "charge_already_refunded");
      const r = { id: id("re"), payment_intent: pi, amount: betalt - belopp, reason: b.reason, metadata: { angra_order: b["metadata[angra_order]"] } }; st.refunds.push(r); return r;
    }
    if (m === "GET" && path === "/customers") return { data: [...st.customers.values()].filter((c) => c.email === q.get("email")) };
    if (m === "GET" && path === "/billing_portal/configurations") return { data: st.portals.filter((p) => p.active) };
    if (m === "POST" && path === "/billing_portal/configurations") { const p = { id: id("bpc"), active: true, metadata: { pro: b["metadata[pro]"] }, b }; st.portals.push(p); return p; }
    if (m === "POST" && path === "/billing_portal/sessions") return b.configuration && st.portals.some((p) => p.id === b.configuration) ? { url: "https://billing.stripe.com/p/session/x" } : fel(400, "no_configuration");
    return fel(404, "okand_" + m + path);
  }
  st._betalt = new Map();
  // Kunden betalar i Checkout (simulerat): sessionen blir complete och Stripe skapar kund, betalning och vid prenumeration abonnemang och faktura.
  f.betala = (sid, { email = "kund@example.se", kupong100 = false } = {}) => {
    const s = st.sessions.get(sid), pris = s._pris, belopp = kupong100 ? 0 : pris.unit_amount;
    const cus = id("cus"); st.customers.set(cus, { id: cus, email });
    Object.assign(s, { status: "complete", payment_status: kupong100 ? "no_payment_required" : "paid", amount_total: belopp, total_details: { amount_tax: Math.round((belopp * 25) / 125) }, customer_details: { email }, customer: cus });
    if (s.mode === "payment") { s.payment_intent = kupong100 ? null : id("pi"); if (s.payment_intent) st._betalt.set(s.payment_intent, belopp); }
    else {
      const sub = { id: id("sub"), object: "subscription", status: "active", customer: cus, cancel_at_period_end: false, metadata: { ...s.metadata },
        items: { data: [{ current_period_end: nuS() + (pris.recurring.interval === "year" ? 365 : 30) * DAG, price: { unit_amount: pris.unit_amount } }] } };
      st.subs.set(sub.id, sub); s.subscription = sub.id;
      const inv = { id: id("in"), status: "paid", created: nuS(), billing_reason: "subscription_create", subscription: sub.id, amount_paid: belopp, tax: Math.round((belopp * 25) / 125), customer_email: email, payment_intent: kupong100 ? null : id("pi") };
      if (inv.payment_intent) st._betalt.set(inv.payment_intent, belopp);
      st.invoices.set(inv.id, inv); s.invoice = inv.id;
    }
    return s;
  };
  f.st = st; return f;
}

