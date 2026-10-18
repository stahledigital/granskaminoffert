// Prov för P3 v2 /pro/* med en tillståndsbärande Stripe-dubbel, Resend-dubbel och KV-dubbel. Inga nätanrop. node --test pro_routes.test.mjs
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handlePro, proSchema, proWebhook, signToken, verifyToken, priser, orderRef, projektKod, krText, _rensaMinne, STRIPE_VERSION, PROJEKT_DAGAR } from "../src/pro_routes.js";
import { SAMTYCKE_TEXT, SAMTYCKE_VERSION, VILLKOR_VERSION } from "../src/pro_texter.js";
import { kv, ENV, fakeStripe as skapaFakeStripe } from "./stripe_dubbel.mjs";

const DAG = 86400;
let NU = Date.UTC(2026, 9, 17, 10, 0, 0);
const nu = () => NU, nuS = () => Math.floor(NU / 1000);
const ORIGIN = "https://stahledigital.se", WORKER = "https://granskaminoffert-api.example.workers.dev", PID = "p_" + "a".repeat(32);
let forsokN = 0; const nyttForsok = () => "f_" + String(++forsokN).padStart(20, "0");
const req = (path, { method = "GET", body, origin = ORIGIN, form = false, ip = "203.0.113.9" } = {}) => new Request(WORKER + path, { method,
  headers: { Origin: origin, "content-type": form ? "application/x-www-form-urlencoded" : "application/json", "CF-Connecting-IP": ip },
  body: body ? (form ? new URLSearchParams(body).toString() : JSON.stringify(body)) : undefined });
const KOP = (plan, extra = {}) => ({ plan, ...(plan === "projekt" ? { projektId: PID } : {}), forsok: nyttForsok(), samtycke: SAMTYCKE_VERSION, villkor: VILLKOR_VERSION, ...extra });
function ctxSamlar() { const p = []; return { waitUntil: (x) => p.push(x), klart: () => Promise.all(p) }; }

// ---------- Resend-dubbel (sendViaHttp använder global fetch) ----------
const mejl = []; let mejlFel = false;
globalThis.fetch = async (url, init) => {
  if (String(url) !== "https://api.resend.com/emails") throw new Error("oväntat nätanrop: " + url);
  if (mejlFel) return new Response(JSON.stringify({ name: "internal_server_error" }), { status: 500 });
  const b = JSON.parse(init.body); mejl.push({ ...b, idem: init.headers["idempotency-key"] });
  return new Response(JSON.stringify({ id: "re_mail_" + String(mejl.length).padStart(4, "0") }), { status: 200 });
};

const fakeStripe = () => skapaFakeStripe({ nuS });

beforeEach(() => { _rensaMinne(); mejl.length = 0; mejlFel = false; NU = Date.UTC(2026, 9, 17, 10, 0, 0); });
async function kop(env, fs, plan, { email = "kund@example.se", kupong100 = false } = {}) {
  const r = await handlePro(req("/pro/checkout", { method: "POST", body: KOP(plan) }), env, {}, { fetchImpl: fs, now: nu });
  assert.equal(r.status, 200, "checkout " + plan); const sid = new URL((await r.json()).url).pathname.split("/").pop();
  fs.betala(sid, { email, kupong100 }); return sid;
}
async function kvitto(env, fs, sid) { const c = ctxSamlar(); const r = await handlePro(req("/pro/kvitto?session_id=" + sid), env, c, { fetchImpl: fs, now: nu }); await c.klart(); return r; }

test("status: R1-priser inkl moms, samtyckestexter, inga hemligheter; off stänger allt utom status", async () => {
  const r = await handlePro(req("/pro/status"), ENV(), {}, { now: nu }); const j = await r.json();
  assert.deepEqual(j.planer, ["projekt", "manad", "ar"]);
  assert.deepEqual(j.priser.projekt, { inkl_ore: 14900, exkl_ore: 11920, moms_ore: 2980, intervall: null, dagar: PROJEKT_DAGAR });
  assert.deepEqual([j.priser.manad.inkl_ore, j.priser.manad.exkl_ore, j.priser.ar.inkl_ore, j.priser.ar.exkl_ore, j.priser.ar.per_manad_ore, j.priser.ar.rabatt_pct], [24900, 19920, 224100, 179280, 18675, 25]);
  assert.deepEqual(j.samtycke_text, SAMTYCKE_TEXT); assert.equal(j.samtycke, SAMTYCKE_VERSION);
  assert.ok(!/sk_|whsec|re_TEST/.test(JSON.stringify(j)));
  const off = ENV({ PRO_PAYMENTS: "off" });
  assert.deepEqual((await (await handlePro(req("/pro/status"), off, {}, { now: nu })).json()).planer, []);
  assert.equal((await handlePro(req("/pro/checkout", { method: "POST", body: KOP("projekt") }), off, {}, { now: nu })).status, 503);
  assert.equal(await handlePro(req("/compare/x"), ENV()), null);
});

test("prisvakt: bara inom Anders ramar (49–249 / 199–299 exkl, år 20–30 % under 12 mån); annars ingen plan och checkout 503", async () => {
  assert.equal(priser({}).ok, true);
  assert.equal(priser({ PRO_PRIS_PROJEKT_ORE: "18900", PRO_PRIS_MANAD_ORE: "29900", PRO_PRIS_AR_ORE: "269000" }).ok, true, "R2 ryms");
  for (const [env, fel] of [[{ PRO_PRIS_PROJEKT_ORE: "1490" }, "projekt:utanfor_ram"], [{ PRO_PRIS_PROJEKT_ORE: "31200" }, "projekt:utanfor_ram"],
    [{ PRO_PRIS_MANAD_ORE: "24800", PRO_PRIS_AR_ORE: "223200" }, "manad:utanfor_ram"], [{ PRO_PRIS_AR_ORE: "298800" }, "ar:utanfor_ram"], [{ PRO_PRIS_AR_ORE: "149" }, "ar:utanfor_ram"], [{ PRO_PRIS_MANAD_ORE: "24900kr" }, "manad:format"]]) {
    const p = priser(env); assert.equal(p.ok, false, JSON.stringify(env)); assert.ok(p.fel.includes(fel), p.fel.join());
  }
  const env = ENV({ PRO_PRIS_PROJEKT_ORE: "40000" }), fs = fakeStripe();
  assert.deepEqual((await (await handlePro(req("/pro/status"), env, {}, { now: nu })).json()).planer, []);
  assert.equal((await handlePro(req("/pro/checkout", { method: "POST", body: KOP("projekt") }), env, {}, { fetchImpl: fs, now: nu })).status, 503);
  assert.equal(fs.st.anrop.length, 0, "inget Stripe-anrop med pris utanför ram");
});

test("checkout: samtycke och villkor krävs, fel ursprung nekas, mejl av eller ofullständig säljare i live ger 503", async () => {
  const fs = fakeStripe();
  for (const [body, status, kod] of [[KOP("projekt", { samtycke: "x" }), 400, "samtycke_saknas"], [KOP("projekt", { villkor: undefined }), 400, "samtycke_saknas"],
    [KOP("projekt", { projektId: "p_123" }), 400, "ogiltigt_projekt"], [KOP("gratis"), 400, "ogiltig_plan"], [KOP("__proto__"), 400, "ogiltig_plan"], [KOP("projekt", { forsok: "kort" }), 400, "ogiltigt_forsok"]]) {
    const r = await handlePro(req("/pro/checkout", { method: "POST", body }), ENV(), {}, { fetchImpl: fs, now: nu });
    assert.equal(r.status, status); assert.equal((await r.json()).status, kod);
  }
  assert.equal((await handlePro(req("/pro/checkout", { method: "POST", body: KOP("projekt"), origin: "https://evil.example" }), ENV(), {}, { fetchImpl: fs, now: nu })).status, 403);
  assert.equal((await handlePro(req("/pro/checkout", { method: "POST", body: KOP("projekt") }), ENV({ COMPARE_MAIL_HTTP: "0" }), {}, { fetchImpl: fs, now: nu })).status, 503);
  assert.equal((await handlePro(req("/pro/checkout", { method: "POST", body: KOP("projekt") }), ENV({ PRO_PAYMENTS: "live", COMPARE_SELLER_PHONE: "" }), {}, { fetchImpl: fs, now: nu })).status, 503);
  assert.equal(fs.st.anrop.length, 0);
});

test("checkout: workern skapar momssats och pris själv en gång; kroppen bär moms, belopp, samtyckestid och inga kunddata", async () => {
  const env = ENV(), fs = fakeStripe();
  const b1 = KOP("projekt", { kund: "Åsa Andersson", pris: 1 });
  let r = await handlePro(req("/pro/checkout", { method: "POST", body: b1 }), env, {}, { fetchImpl: fs, now: nu }); assert.equal(r.status, 200);
  assert.equal(fs.st.taxRates.length, 1); const txr = fs.st.taxRates[0];
  assert.deepEqual([txr.inclusive, txr.percentage, txr.country, txr.tax_type], [true, 25, "SE", "vat"]);
  assert.equal(fs.st.prices.length, 1); assert.deepEqual([fs.st.prices[0].unit_amount, fs.st.prices[0].currency, fs.st.prices[0].recurring, fs.st.prices[0].lookup_key], [14900, "sek", null, "mrpro_projekt_14900_v1"]);
  const co = fs.st.anrop.find((a) => a.path === "/checkout/sessions" && a.m === "POST");
  assert.equal(co.b["line_items[0][tax_rates][0]"], txr.id); assert.equal(co.b.mode, "payment"); assert.equal(co.b["payment_method_types[0]"], "card"); assert.equal(co.b["payment_method_types[1]"], undefined); assert.equal(co.b.customer_creation, "always");
  assert.equal(co.b["metadata[samtycke]"], SAMTYCKE_VERSION); assert.equal(co.b["metadata[villkor]"], VILLKOR_VERSION); assert.equal(co.b["metadata[samtycke_tid]"], new Date(NU).toISOString());
  assert.match(co.b["custom_text[submit][message]"], /149 kr inklusive moms.*ångra köpet inom 14 dagar/);
  assert.ok(!JSON.stringify(co.b).includes("Åsa") && !("pris" in co.b), "kunddata och klientpris når aldrig Stripe");
  assert.ok(fs.st.anrop.every((a) => a.h["stripe-version"] === STRIPE_VERSION));
  // samma försök igen (t.ex. omsändning) = samma kropp = samma session; ny tidpunkt får inte ändra kroppen
  NU += 5000; const fore = fs.st.sessions.size;
  r = await handlePro(req("/pro/checkout", { method: "POST", body: b1 }), env, {}, { fetchImpl: fs, now: nu }); assert.equal(r.status, 200); assert.equal(fs.st.sessions.size, fore);
  // ny isolat (tomt minne) använder KV-cachen; nytt isolat utan KV hittar via Stripe – aldrig dubbla objekt
  _rensaMinne(); await handlePro(req("/pro/checkout", { method: "POST", body: KOP("projekt") }), env, {}, { fetchImpl: fs, now: nu });
  _rensaMinne(); await handlePro(req("/pro/checkout", { method: "POST", body: KOP("projekt") }), ENV(), {}, { fetchImpl: fs, now: nu });
  assert.equal(fs.st.taxRates.length, 1); assert.equal(fs.st.prices.length, 1);
  r = await handlePro(req("/pro/checkout", { method: "POST", body: KOP("ar") }), env, {}, { fetchImpl: fs, now: nu }); assert.equal(r.status, 200);
  const ar = fs.st.anrop.filter((a) => a.path === "/checkout/sessions" && a.m === "POST").at(-1).b;
  assert.equal(ar.mode, "subscription"); assert.equal(ar.payment_method_collection, "if_required"); assert.equal(ar["subscription_data[metadata][plan]"], "ar");
  assert.deepEqual(fs.st.prices.find((p) => p.lookup_key === "mrpro_ar_224100_v1").recurring, { interval: "year" });
});

test("kvitto projekt: obetald nekas, betald ger token i 30 dagar och exakt en bekräftelse med alla fält", async () => {
  const env = ENV(), fs = fakeStripe();
  const r0 = await handlePro(req("/pro/checkout", { method: "POST", body: KOP("projekt") }), env, {}, { fetchImpl: fs, now: nu });
  const sid = new URL((await r0.json()).url).pathname.split("/").pop();
  assert.equal((await kvitto(env, fs, sid)).status, 402);
  fs.betala(sid, { email: "Kund@Example.se" });
  let r = await kvitto(env, fs, sid); assert.equal(r.status, 200); const j = await r.json();
  const order = await orderRef(sid); assert.match(order, /^PRO-[A-HJ-NP-Z2-9]{8}$/); assert.equal(j.order, order);
  assert.equal(j.exp, fs.st.sessions.get(sid).created + 30 * DAG);
  const t = await verifyToken(env, j.token, nuS()); assert.deepEqual([t.t, t.p, t.o], ["projekt", PID, order]);
  assert.equal(mejl.length, 1); const m = mejl[0];
  assert.deepEqual(m.to, ["Kund@Example.se"]); assert.equal(m.from, "Ståhle Digital <hej@stahledigital.se>");
  for (const s of [order, "149 kr", "29,80 kr", "119,20 kr", SAMTYCKE_TEXT.start, SAMTYCKE_TEXT.villkor, "Ångra avtalet här: https://stahledigital.se/verkstaden/materialraknaren/angra?order=" + order,
    "Projektkod: " + projektKod(PID), "Säljare: Ståhle Digital", "hej@stahledigital.se", "inom 14 dagar", "/verkstaden/materialraknaren/villkor"]) assert.ok(m.text.includes(s), "saknar: " + s);
  assert.ok(!/\n\n\n/.test(m.text) && !m.text.includes("{"), "inga tomma block eller ofyllda platshållare");
  r = await kvitto(env, fs, sid); assert.equal(r.status, 200); assert.equal(mejl.length, 1, "ingen dubbel bekräftelse");
  const live = await handlePro(req("/pro/kvitto?session_id=cs_live_ABCDEFGH12"), env, {}, { fetchImpl: fs, now: nu }); assert.equal(live.status, 400);
  fs.st.sessions.get(sid).livemode = true; // session från fel läge (id ser ut som test) nekas ändå
  assert.equal((await kvitto(env, fs, sid)).status, 400); fs.st.sessions.get(sid).livemode = false;
  NU += 31 * DAG * 1000; assert.equal((await kvitto(env, fs, sid)).status, 402, "utgånget projekt ger ingen ny token");
});

test("kvitto prenumeration: token högst 7 dagar, bekräftelsen anger nästa dragning och uppsägning; 100 %-kod fungerar", async () => {
  const env = ENV(), fs = fakeStripe();
  const sid = await kop(env, fs, "manad");
  const j = await (await kvitto(env, fs, sid)).json();
  assert.equal(j.plan, "pren"); assert.ok(j.exp <= nuS() + 7 * DAG);
  assert.match(mejl[0].text, /förnyas automatiskt varje månad\. Nästa dragning: \d+ \w+ 2026/); assert.match(mejl[0].text, /Hantera prenumerationen/);
  assert.ok(mejl[0].text.includes("249 kr") && mejl[0].text.includes("49,80 kr"));
  const sid2 = await kop(env, fs, "ar", { kupong100: true, email: "test@example.se" });
  const r2 = await kvitto(env, fs, sid2); assert.equal(r2.status, 200); assert.match(mejl[1].text, /varje år/); assert.ok(mejl[1].text.includes("Pris inklusive moms: 0 kr"));
});

test("förnya: projekt gäller till utgång om inte spärrat; prenumeration följer Stripe; manipulerad token nekas", async () => {
  const env = ENV(), fs = fakeStripe();
  const sp = await kop(env, fs, "projekt"); const kj = await (await kvitto(env, fs, sp)).json(), tp = kj.token;
  let r = await handlePro(req("/pro/forny", { method: "POST", body: { token: tp } }), env, {}, { fetchImpl: fs, now: nu }); assert.equal(r.status, 200);
  await env.REVIEWS_KV.put(`pro:test:sparr:${kj.order}`, "1"); // spärren gäller köpet (ordern), och nyckeln bär läget
  r = await handlePro(req("/pro/forny", { method: "POST", body: { token: tp } }), env, {}, { fetchImpl: fs, now: nu }); assert.equal(r.status, 402); assert.equal((await r.json()).status, "sparrad");
  const sm = await kop(env, fs, "manad"); const tm = (await (await kvitto(env, fs, sm)).json()).token;
  r = await handlePro(req("/pro/forny", { method: "POST", body: { token: tm } }), env, {}, { fetchImpl: fs, now: nu }); assert.equal(r.status, 200);
  fs.st.subs.get(fs.st.sessions.get(sm).subscription).status = "canceled";
  r = await handlePro(req("/pro/forny", { method: "POST", body: { token: tm } }), env, {}, { fetchImpl: fs, now: nu }); assert.equal(r.status, 402);
  const fel = tm.slice(0, -2) + (tm.endsWith("aa") ? "bb" : "aa");
  assert.equal((await handlePro(req("/pro/forny", { method: "POST", body: { token: fel } }), env, {}, { fetchImpl: fs, now: nu })).status, 401);
  const liveTok = await signToken(ENV({ PRO_PAYMENTS: "live" }), { t: "projekt", p: PID, exp: nuS() + 100 });
  assert.equal((await handlePro(req("/pro/forny", { method: "POST", body: { token: liveTok } }), env, {}, { fetchImpl: fs, now: nu })).status, 401, "livetoken gäller aldrig i test");
  const login = await signToken(env, { t: "login", c: "cus_X", n: "n", exp: nuS() + 100 });
  assert.equal((await handlePro(req("/pro/forny", { method: "POST", body: { token: login } }), env, {}, { fetchImpl: fs, now: nu })).status, 401);
});

test("ånger projekt inom fristen: två steg, mottagningsbevis med tid, full återbetalning, spärr, idempotent", async () => {
  const env = ENV(), fs = fakeStripe();
  const sid = await kop(env, fs, "projekt", { email: "Kund@Example.se" }); const tok = (await (await kvitto(env, fs, sid)).json()).token; const order = await orderRef(sid);
  NU += 3 * DAG * 1000; mejl.length = 0;
  let r = await handlePro(req("/pro/angra", { method: "POST", body: { order, epost: "fel@example.se" } }), env, {}, { fetchImpl: fs, now: nu }); assert.equal(r.status, 404);
  r = await handlePro(req("/pro/angra", { method: "POST", body: { order: "PRO-1234", epost: "kund@example.se" } }), env, {}, { fetchImpl: fs, now: nu }); assert.equal(r.status, 400);
  r = await handlePro(req("/pro/angra", { method: "POST", body: { order: order.toLowerCase(), epost: "kund@example.se" } }), env, {}, { fetchImpl: fs, now: nu });
  let j = await r.json(); assert.equal(r.status, 200); assert.equal(j.status, "bekrafta"); assert.equal(fs.st.refunds.length, 0, "inget händer före bekräftelsen");
  r = await handlePro(req("/pro/angra", { method: "POST", body: { steg: "2", id: j.id } }), env, {}, { fetchImpl: fs, now: nu }); j = await r.json();
  assert.equal(r.status, 200); assert.deepEqual([j.status, j.order, j.tid, j.utfall], ["registrerad", order, nuS(), "aterbetalas"]);
  assert.equal(fs.st.refunds.length, 1); assert.equal(fs.st.refunds[0].amount, 14900); assert.equal(fs.st.refunds[0].reason, "requested_by_customer");
  const kvittoMejl = mejl.find((x) => x.subject.startsWith("Mottagningsbevis")); assert.ok(kvittoMejl); assert.deepEqual(kvittoMejl.to, ["kund@example.se"], "till adressen kunden angav i ångerformuläret");
  assert.ok(kvittoMejl.text.includes(order) && kvittoMejl.text.includes("Meddelandet mottogs: ") && kvittoMejl.text.includes("hela beloppet"));
  assert.ok(mejl.some((x) => x.subject.startsWith("PRO: ångermeddelande") && x.to[0] === "hej@stahledigital.se"));
  const reg = JSON.parse(await env.REVIEWS_KV.get(`pro:test:angra:reg:${order}`)); assert.equal(reg.steg.klar, true); assert.equal(reg.mottaget, new Date(NU).toISOString());
  assert.equal((await handlePro(req("/pro/forny", { method: "POST", body: { token: tok } }), env, {}, { fetchImpl: fs, now: nu })).status, 402);
  assert.equal((await kvitto(env, fs, sid)).status, 402, "ångrat köp ger aldrig ny token");
  // samma ånger igen: samma tid, ingen ny återbetalning
  NU += 3600 * 1000;
  j = await (await handlePro(req("/pro/angra", { method: "POST", body: { order, epost: "Kund@Example.se" } }), env, {}, { fetchImpl: fs, now: nu })).json();
  j = await (await handlePro(req("/pro/angra", { method: "POST", body: { steg: "2", id: j.id } }), env, {}, { fetchImpl: fs, now: nu })).json();
  assert.equal(j.dubblett, true); assert.equal(j.tid, reg.tid); assert.equal(fs.st.refunds.length, 1);
  assert.equal((await handlePro(req("/pro/angra", { method: "POST", body: { steg: "2", id: j.id || "x".repeat(32) } }), env, {}, { fetchImpl: fs, now: nu })).status, 410, "bekräftelsen kan bara användas en gång");
});

test("ånger prenumeration inom fristen: metadata, avslut direkt och återbetalning av första fakturan", async () => {
  const env = ENV(), fs = fakeStripe();
  const sid = await kop(env, fs, "ar"); await kvitto(env, fs, sid); const order = await orderRef(sid);
  NU += 10 * DAG * 1000;
  let j = await (await handlePro(req("/pro/angra", { method: "POST", body: { order, epost: "kund@example.se", kvitto_epost: "annan@example.se" } }), env, {}, { fetchImpl: fs, now: nu })).json();
  j = await (await handlePro(req("/pro/angra", { method: "POST", body: { steg: "2", id: j.id } }), env, {}, { fetchImpl: fs, now: nu })).json();
  assert.equal(j.utfall, "avslutas_och_aterbetalas");
  const sub = fs.st.subs.get(fs.st.sessions.get(sid).subscription); assert.equal(sub.status, "canceled"); assert.equal(sub.metadata.angra_order, order);
  assert.equal(fs.st.refunds.length, 1); assert.equal(fs.st.refunds[0].amount, 224100);
  const bevis = mejl.filter((x) => x.subject.startsWith("Mottagningsbevis")).map((x) => x.to[0]).sort();
  assert.deepEqual(bevis, ["annan@example.se", "kund@example.se"], "kunden kan välja en adress till (AK-A5), men köpets adress får alltid beviset (granskning F7)");
});

test("ånger efter fristen: registreras och kvitteras men ingen automatisk återbetalning eller avslut", async () => {
  const env = ENV(), fs = fakeStripe();
  const sid = await kop(env, fs, "manad"); const order = await orderRef(sid);
  NU += 16 * DAG * 1000;
  let j = await (await handlePro(req("/pro/angra", { method: "POST", body: { order, epost: "kund@example.se" } }), env, {}, { fetchImpl: fs, now: nu })).json();
  j = await (await handlePro(req("/pro/angra", { method: "POST", body: { steg: "2", id: j.id } }), env, {}, { fetchImpl: fs, now: nu })).json();
  assert.equal(j.utfall, "manuell_provning"); assert.equal(fs.st.refunds.length, 0); assert.equal(fs.st.subs.get(fs.st.sessions.get(sid).subscription).status, "active");
  assert.ok(mejl.some((x) => x.subject.startsWith("Mottagningsbevis") && x.text.includes("går igenom")));
});

test("ånger utan JavaScript: formulär ger HTML-steg och HTML-kvitto, steg 2 från workerns egen sida godtas", async () => {
  const env = ENV(), fs = fakeStripe();
  const sid = await kop(env, fs, "projekt"); const order = await orderRef(sid);
  let r = await handlePro(req("/pro/angra", { method: "POST", form: true, body: { order, epost: "kund@example.se" } }), env, {}, { fetchImpl: fs, now: nu });
  assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /text\/html/); let html = await r.text();
  assert.match(html, /Kontrollera uppgifterna/); assert.match(html, /Bekräfta ångra/); const id = /name="id" value="([^"]+)"/.exec(html)[1];
  assert.match(html, new RegExp(`action="${WORKER}/pro/angra"`));
  r = await handlePro(req("/pro/angra", { method: "POST", form: true, origin: WORKER, body: { steg: "2", id } }), env, {}, { fetchImpl: fs, now: nu });
  html = await r.text(); assert.equal(r.status, 200); assert.match(html, /Vi har tagit emot ditt meddelande/); assert.ok(html.includes(order)); assert.equal(fs.st.refunds.length, 1);
  r = await handlePro(req("/pro/angra", { method: "POST", form: true, body: { order: "<script>", epost: "x" } }), env, {}, { fetchImpl: fs, now: nu });
  assert.equal(r.status, 400); assert.ok(!(await r.text()).includes("<script>"));
  assert.equal((await handlePro(req("/pro/checkout", { method: "POST", origin: WORKER, body: KOP("projekt") }), env, {}, { fetchImpl: fs, now: nu })).status, 403, "egen origin gäller bara ångersteget");
});

test("ånger: hastighetsgräns per IP och e-post", async () => {
  const env = ENV(), fs = fakeStripe(); let sista;
  for (let i = 0; i < 9; i++) sista = await handlePro(req("/pro/angra", { method: "POST", body: { order: "PRO-ABCDEFGH", epost: "a@example.se" } }), env, {}, { fetchImpl: fs, now: nu });
  assert.equal(sista.status, 429);
});

test("ånger: Stripe-fel vid återbetalning registreras ändå; schemat slutför senare utan dubbel återbetalning", async () => {
  const env = ENV(), fs = fakeStripe();
  const sid = await kop(env, fs, "projekt"); const order = await orderRef(sid);
  fs.st.felPa = (m, p) => m === "POST" && p === "/refunds";
  let j = await (await handlePro(req("/pro/angra", { method: "POST", body: { order, epost: "kund@example.se" } }), env, {}, { fetchImpl: fs, now: nu })).json();
  j = await (await handlePro(req("/pro/angra", { method: "POST", body: { steg: "2", id: j.id } }), env, {}, { fetchImpl: fs, now: nu })).json();
  assert.equal(j.status, "registrerad"); assert.equal(fs.st.refunds.length, 0);
  let reg = JSON.parse(await env.REVIEWS_KV.get(`pro:test:angra:reg:${order}`)); assert.equal(reg.steg.sparr, "klar"); assert.ok(reg.steg.senaste_fel); assert.ok(await env.REVIEWS_KV.get(`pro:test:angra:oppen:${order}`));
  fs.st.felPa = null; NU += 3600 * 1000;
  const s1 = await proSchema(env, { fetchImpl: fs, now: nu }); assert.equal(s1.anger, 1); assert.equal(fs.st.refunds.length, 1);
  reg = JSON.parse(await env.REVIEWS_KV.get(`pro:test:angra:reg:${order}`)); assert.equal(reg.steg.klar, true); assert.equal(await env.REVIEWS_KV.get(`pro:test:angra:oppen:${order}`), null);
  await proSchema(env, { fetchImpl: fs, now: nu }); assert.equal(fs.st.refunds.length, 1);
});

test("schema: bekräftelse när kunden aldrig kom tillbaka, kvitto vid förnyelse, årspåminnelse 33–46 dygn före; idempotent", async () => {
  const env = ENV(), fs = fakeStripe();
  const sid = await kop(env, fs, "projekt", { email: "aterkom@example.se" }); // ingen /pro/kvitto
  const sidAr = await kop(env, fs, "ar", { email: "ar@example.se" }); await kvitto(env, fs, sidAr);
  const sidM = await kop(env, fs, "manad", { email: "man@example.se" }); await kvitto(env, fs, sidM);
  const sidAr2 = await kop(env, fs, "ar", { email: "uppsagd@example.se" }); fs.st.subs.get(fs.st.sessions.get(sidAr2).subscription).cancel_at_period_end = true; await kvitto(env, fs, sidAr2);
  mejl.length = 0;
  let s = await proSchema(env, { fetchImpl: fs, now: nu });
  assert.equal(s.ok, true, s.fel.join()); assert.equal(s.bekraftelser, 1); assert.ok(mejl.some((m) => m.to[0] === "aterkom@example.se" && m.subject.startsWith("Kvitto och bekräftelse")));
  assert.equal(s.paminnelser, 0, "inte 365 dygn före");
  // förnyelse av månadsplanen
  NU += 31 * DAG * 1000; const subM = fs.st.subs.get(fs.st.sessions.get(sidM).subscription);
  subM.items.data[0].current_period_end = nuS() + 30 * DAG;
  fs.st.invoices.set("in_cykel0001", { id: "in_cykel0001", status: "paid", created: nuS(), billing_reason: "subscription_cycle", subscription: subM.id, amount_paid: 24900, tax: 4980, customer_email: "man@example.se", payment_intent: "pi_c1" });
  s = await proSchema(env, { fetchImpl: fs, now: nu }); assert.equal(s.fornyelser, 1);
  const fm = mejl.find((m) => m.subject.startsWith("Kvitto: Materialräknaren PRO har förnyats")); assert.ok(fm.text.includes("Nästa dragning sker automatiskt") && fm.text.includes("49,80 kr"));
  // årsplanen: 40 dygn före förnyelse
  const subA = fs.st.subs.get(fs.st.sessions.get(sidAr).subscription); NU = (subA.items.data[0].current_period_end - 40 * DAG) * 1000;
  s = await proSchema(env, { fetchImpl: fs, now: nu }); assert.equal(s.paminnelser, 1); assert.ok(!mejl.some((m) => m.to[0] === "uppsagd@example.se" && m.subject.startsWith("Påminnelse")), "uppsagd prenumeration påminns inte");
  const pm = mejl.find((m) => m.subject.startsWith("Påminnelse")); assert.deepEqual(pm.to, ["ar@example.se"]); assert.ok(pm.text.includes("2 241 kr") && pm.text.includes("Sista dag att säga upp"));
  const antal = mejl.length; s = await proSchema(env, { fetchImpl: fs, now: nu }); assert.equal(mejl.length, antal, "ingen dubbel påminnelse");
  subA.cancel_at_period_end = true; NU += DAG * 1000; await proSchema(env, { fetchImpl: fs, now: nu }); assert.equal(mejl.length, antal);
});

test("inloggning: alltid 202, länk bara vid aktiv PRO-prenumeration, engångslänk, gräns per e-post", async () => {
  const env = ENV(), fs = fakeStripe();
  const sid = await kop(env, fs, "manad", { email: "pren@example.se" }); mejl.length = 0;
  let r = await handlePro(req("/pro/inloggning", { method: "POST", body: { epost: "ingen@example.se" } }), env, {}, { fetchImpl: fs, now: nu }); assert.equal(r.status, 202); assert.equal(mejl.length, 0);
  r = await handlePro(req("/pro/inloggning", { method: "POST", body: { epost: "pren@example.se" } }), env, {}, { fetchImpl: fs, now: nu }); assert.equal(r.status, 202); assert.equal(mejl.length, 1);
  const t = decodeURIComponent(/[?&]t=([^\s&]+)/.exec(mejl[0].text)[1]);
  r = await handlePro(req("/pro/inloggning/bekrafta", { method: "POST", body: { t } }), env, {}, { fetchImpl: fs, now: nu }); assert.equal(r.status, 200); assert.equal((await r.json()).plan, "pren");
  assert.equal((await handlePro(req("/pro/inloggning/bekrafta", { method: "POST", body: { t } }), env, {}, { fetchImpl: fs, now: nu })).status, 401);
  // en annan (icke-PRO) prenumeration hos samma kund ger ingen åtkomst
  const sub = fs.st.subs.get(fs.st.sessions.get(sid).subscription); sub.metadata.pro = "annan-produkt";
  r = await handlePro(req("/pro/inloggning", { method: "POST", body: { epost: "pren@example.se" } }), env, {}, { fetchImpl: fs, now: nu }); assert.equal(mejl.length, 1);
  for (let i = 0; i < 4; i++) r = await handlePro(req("/pro/inloggning", { method: "POST", body: { epost: "x@example.se" } }), env, {}, { fetchImpl: fs, now: nu });
  assert.equal(r.status, 202);
});

test("kundportal: workern skapar konfiguration (uppsägning vid periodens slut) en gång och använder den", async () => {
  const env = ENV(), fs = fakeStripe();
  const sid = await kop(env, fs, "manad"); const tok = (await (await kvitto(env, fs, sid)).json()).token;
  let r = await handlePro(req("/pro/portal", { method: "POST", body: { token: tok } }), env, {}, { fetchImpl: fs, now: nu }); assert.equal(r.status, 200);
  assert.equal(fs.st.portals.length, 1); const b = fs.st.portals[0].b;
  assert.equal(b["features[subscription_cancel][mode]"], "at_period_end"); assert.equal(b["features[subscription_cancel][enabled]"], "true");
  _rensaMinne(); r = await handlePro(req("/pro/portal", { method: "POST", body: { token: tok } }), ENV(), {}, { fetchImpl: fs, now: nu }); assert.equal(r.status, 200); assert.equal(fs.st.portals.length, 1);
});

test("webhookkrok: bekräftelse för PRO-session, annat ignoreras", async () => {
  const env = ENV(), fs = fakeStripe();
  const sid = await kop(env, fs, "projekt");
  const s = fs.st.sessions.get(sid);
  assert.deepEqual(await proWebhook(env, { type: "checkout.session.completed", data: { object: { ...s, metadata: {} } } }, { fetchImpl: fs }), { ok: true, ignored: "ej_pro" });
  const r = await proWebhook(env, { type: "checkout.session.completed", data: { object: s } }, { fetchImpl: fs }); assert.equal(r.bekraftelse, "skickad"); assert.equal(mejl.length, 1);
  await kvitto(env, fs, sid); assert.equal(mejl.length, 1, "kvittot skickar inte igen");
});

test("Stripe-fel läcker aldrig: 502 med neutral kod", async () => {
  const env = ENV(), fs = fakeStripe(); fs.st.felPa = () => true;
  const r = await handlePro(req("/pro/checkout", { method: "POST", body: KOP("projekt") }), env, {}, { fetchImpl: fs, now: nu });
  assert.equal(r.status, 502); const t = await r.text(); assert.ok(!t.includes("sk_live") && !t.includes("LÄCKA")); assert.equal(JSON.parse(t).status, "tillfalligt_fel");
});

test("hjälpfunktioner: belopp och projektkod som P2/P4", () => {
  assert.deepEqual([krText(14900), krText(11920), krText(224100), krText(-2980)], ["149", "119,20", "2 241", "-29,80"]);
  assert.match(projektKod(PID), /^[A-HJ-NP-Z2-9]{4}$/);
});
