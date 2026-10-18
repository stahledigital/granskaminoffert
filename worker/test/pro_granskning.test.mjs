// Regressionsprov för den oberoende granskningen 2026-10-17 (RAPPORT.md, fynd F1–F9 och B). Varje prov visade felet i v2 och visar rättningen i v3.
// node --test pro_granskning.test.mjs   (inga nätanrop: Stripe, Resend och KV är dubblar)
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handlePro, proSchema, signToken, verifyToken, orderRef, _rensaMinne } from "../src/pro_routes.js";
import { SAMTYCKE_VERSION, VILLKOR_VERSION } from "../src/pro_texter.js";
import { ENV, fakeStripe } from "./stripe_dubbel.mjs";

const DAG = 86400;
let NU = Date.UTC(2026, 9, 17, 10, 0, 0);
const nu = () => NU, nuS = () => Math.floor(NU / 1000);
const ORIGIN = "https://stahledigital.se", WORKER = "https://granskaminoffert-api.example.workers.dev", PID = "p_" + "b".repeat(32);
let n = 0; const forsok = () => "f_" + String(++n).padStart(20, "0");
const req = (path, { method = "GET", body, origin = ORIGIN, form = false, ip = "203.0.113.9" } = {}) => new Request(WORKER + path, { method,
  headers: { Origin: origin, "content-type": form ? "application/x-www-form-urlencoded" : "application/json", "CF-Connecting-IP": ip },
  body: body ? (form ? new URLSearchParams(body).toString() : JSON.stringify(body)) : undefined });
const mejl = []; let resendStatus = 200;
globalThis.fetch = async (url, init) => {
  if (String(url) !== "https://api.resend.com/emails") throw new Error("oväntat nätanrop " + url);
  if (resendStatus !== 200) return new Response(JSON.stringify({ name: "validation_error" }), { status: resendStatus });
  mejl.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: "re_mail_" + String(mejl.length).padStart(4, "0") }), { status: 200 });
};
beforeEach(() => { _rensaMinne(); mejl.length = 0; resendStatus = 200; NU = Date.UTC(2026, 9, 17, 10, 0, 0); });
const fs0 = () => fakeStripe({ nuS });
const h = (env, fs, r, ctx = {}) => handlePro(r, env, ctx, { fetchImpl: fs, now: nu });
async function kop(env, fs, plan, { email = "kund@example.se", pid = PID, kupong100 = false } = {}) {
  const r = await h(env, fs, req("/pro/checkout", { method: "POST", body: { plan, ...(plan === "projekt" ? { projektId: pid } : {}), forsok: forsok(), samtycke: SAMTYCKE_VERSION, villkor: VILLKOR_VERSION } }));
  assert.equal(r.status, 200); const sid = new URL((await r.json()).url).pathname.split("/").pop(); fs.betala(sid, { email, kupong100 }); return sid;
}
async function kvitto(env, fs, sid, ip) { const p = []; const r = await h(env, fs, req("/pro/kvitto?session_id=" + sid, { ip }), { waitUntil: (x) => p.push(x) }); await Promise.all(p); return r; }
async function angra(env, fs, order, epost = "kund@example.se", extra = {}) {
  const j = await (await h(env, fs, req("/pro/angra", { method: "POST", body: { order, epost, ...extra } }))).json();
  const r = await h(env, fs, req("/pro/angra", { method: "POST", body: { steg: "2", id: j.id } }));
  return { status: r.status, j: await r.json(), id: j.id };
}
const reg = async (env, order) => JSON.parse(await env.REVIEWS_KV.get(`pro:test:angra:reg:${order}`));
const forny = async (env, fs, token) => h(env, fs, req("/pro/forny", { method: "POST", body: { token } }));

test("F1: spärren gäller köpet, inte projektet – ett nytt betalt köp av samma projekt fungerar efter ånger", async () => {
  const env = ENV(), fs = fs0();
  const s1 = await kop(env, fs, "projekt"); const t1 = (await (await kvitto(env, fs, s1)).json()).token;
  NU += 2 * DAG * 1000; assert.equal((await angra(env, fs, await orderRef(s1))).j.utfall, "aterbetalas");
  assert.equal((await (await forny(env, fs, t1)).json()).status, "sparrad", "det ångrade köpet är spärrat");
  NU += DAG * 1000; const s2 = await kop(env, fs, "projekt"); const t2 = (await (await kvitto(env, fs, s2)).json()).token;
  const f = await forny(env, fs, t2); assert.equal(f.status, 200, "det nya köpet av samma projekt gäller");
});

test("F1b: test och live har egna nycklar – en ånger i test påverkar aldrig live", async () => {
  const env = ENV(), fs = fs0();
  const s1 = await kop(env, fs, "projekt"); await angra(env, fs, await orderRef(s1));
  assert.ok([...env.REVIEWS_KV.m.keys()].filter((k) => /^pro:(angra|sparr|order)/.test(k)).length === 0, "inga nycklar utan läge");
  const live = ENV({ PRO_PAYMENTS: "live", REVIEWS_KV: env.REVIEWS_KV });
  const liveTok = await signToken(live, { t: "projekt", p: PID, exp: nuS() + 20 * DAG, o: await orderRef(s1) }); // till och med samma ordernummer
  assert.equal((await forny(live, fs, liveTok)).status, 200);
});

test("F2: prenumerationsånger utan känd faktura markeras inte klar; fakturan hittas via prenumerationen och återbetalas", async () => {
  const env = ENV(), fs = fs0();
  const sid = await kop(env, fs, "manad"); await kvitto(env, fs, sid); const order = await orderRef(sid);
  fs.st.sessions.get(sid).invoice = null;
  const lista = fs.st.anrop.length; const orig = fs.st.felPa;
  fs.st.felPa = (m, p) => m === "GET" && p === "/invoices"; // fakturan kan inte bestämmas just nu
  const r = await angra(env, fs, order); assert.equal(r.j.utfall, "avslutas_och_aterbetalas");
  let g = await reg(env, order); assert.notEqual(g.steg.klar, true); assert.notEqual(g.steg.aterbetalning, "klar"); assert.equal(fs.st.refunds.length, 0);
  assert.ok(await env.REVIEWS_KV.get(`pro:test:angra:oppen:${order}`), "ärendet är öppet");
  fs.st.felPa = orig; NU += 3600 * 1000; await proSchema(env, { fetchImpl: fs, now: nu });
  g = await reg(env, order); assert.equal(g.steg.klar, true); assert.equal(fs.st.refunds.length, 1); assert.equal(fs.st.refunds[0].amount, 24900); assert.ok(fs.st.anrop.length > lista);
  assert.equal(await env.REVIEWS_KV.get(`pro:test:angra:oppen:${order}`), null);
});

test("F2c: hittas ingen faktura alls blir återbetalningen aldrig klar – ärendet förblir öppet för schemat", async () => {
  const env = ENV(), fs = fs0();
  const sid = await kop(env, fs, "ar"); const order = await orderRef(sid); const inv = fs.st.sessions.get(sid).invoice;
  fs.st.sessions.get(sid).invoice = null; fs.st.invoices.delete(inv);
  await angra(env, fs, order); let g = await reg(env, order);
  assert.notEqual(g.steg.aterbetalning, "klar"); assert.notEqual(g.steg.klar, true); assert.equal(g.steg.senaste_fel, "faktura_saknas");
  NU += 3600 * 1000; await proSchema(env, { fetchImpl: fs, now: nu }); g = await reg(env, order);
  assert.notEqual(g.steg.klar, true); assert.ok(await env.REVIEWS_KV.get(`pro:test:angra:oppen:${order}`));
});

test("F2b: 100 %-kod (0 kr betalt) är klar utan återbetalning; betalt utan betalning att återbetala mot blir manuell, aldrig klar", async () => {
  const env = ENV(), fs = fs0();
  const a = await kop(env, fs, "ar", { kupong100: true }); const oa = await orderRef(a);
  await angra(env, fs, oa); let g = await reg(env, oa); assert.equal(g.steg.aterbetalning, "klar"); assert.equal(g.steg.klar, true); assert.equal(fs.st.refunds.length, 0);
  const b = await kop(env, fs, "projekt", { pid: "p_" + "c".repeat(32) }); fs.st.sessions.get(b).payment_intent = null; const ob = await orderRef(b);
  await angra(env, fs, ob); g = await reg(env, ob); assert.equal(g.steg.aterbetalning, "manuell"); assert.notEqual(g.steg.klar, true);
  assert.ok(mejl.some((m) => m.subject.startsWith("PRO: ångermeddelande " + ob) && m.text.includes('"aterbetalning":"manuell"')), "säljaren ser det i det interna mejlet");
});

test("F3: dagstaket stoppar aldrig mottagningsbevis, internt mejl eller bekräftelse", async () => {
  const env = ENV({ PRO_MAIL_DAY_CAP: "1" }), fs = fs0();
  await kop(env, fs, "manad", { email: "pren@example.se" });
  await h(env, fs, req("/pro/inloggning", { method: "POST", body: { epost: "pren@example.se" } })); // inloggningen tar dagens kvot
  const sid = await kop(env, fs, "projekt"); await kvitto(env, fs, sid); const order = await orderRef(sid);
  assert.ok(mejl.some((m) => m.to[0] === "kund@example.se" && m.subject.includes(order)), "bekräftelsen gick ut trots nått tak");
  await angra(env, fs, order); const g = await reg(env, order);
  assert.equal(g.steg.kvitto, "skickat"); assert.equal(g.steg.intern, "skickat"); assert.equal(g.steg.avslutad, true);
});

test("F3b: inloggning svarar alltid 202 – även när mejlet inte går iväg – och tar inte taket för köpmejl", async () => {
  const env = ENV({ PRO_MAIL_DAY_CAP: "2" }), fs = fs0();
  await kop(env, fs, "manad", { email: "pren@example.se" }); mejl.length = 0;
  for (let i = 0; i < 6; i++) { const r = await h(env, fs, req("/pro/inloggning", { method: "POST", body: { epost: "pren@example.se" } })); assert.equal(r.status, 202); if (i % 3 === 2) NU += 3600 * 1000; }
  assert.equal(mejl.length, 2, "taket gäller inloggningsmejlen");
  resendStatus = 500; const r = await h(env, fs, req("/pro/inloggning", { method: "POST", body: { epost: "pren@example.se" } })); assert.equal(r.status, 202, "mejlfel avslöjar inget");
  resendStatus = 200; const sid = await kop(env, fs, "projekt", { email: "ny@example.se" }); await kvitto(env, fs, sid);
  assert.ok(mejl.some((m) => m.to[0] === "ny@example.se"), "en ny köpares bekräftelse går ut");
});

test("F4: permanent avvisat mejl försöks inte igen och räknas inte mot taket", async () => {
  const env = ENV(), fs = fs0();
  await kop(env, fs, "projekt", { email: "studs@example.se" }); resendStatus = 422;
  for (let i = 0; i < 5; i++) { await proSchema(env, { fetchImpl: fs, now: nu }); NU += 3600 * 1000; }
  const dag = new Date().toISOString().slice(0, 10);
  assert.equal(await env.REVIEWS_KV.get(`pro:mejl:dag:${dag}`), null, "bekräftelser räknas inte mot taket");
  const flagga = [...env.REVIEWS_KV.m.entries()].find(([k]) => k.startsWith("pro:mejl:bekr-")); assert.ok(flagga && JSON.parse(flagga[1]).fel, "terminal flagga");
});

test("F5: ett trasigt ångerärende stoppar inte de andra; KV-listan läses sida för sida", async () => {
  const env = ENV(), fs = fs0();
  const sid = await kop(env, fs, "projekt"); const order = await orderRef(sid);
  fs.st.felPa = (m, p) => m === "POST" && p === "/refunds"; await angra(env, fs, order); fs.st.felPa = null;
  await env.REVIEWS_KV.put("pro:test:angra:oppen:PRO-22222222", "cs_test_finnsinte");
  await env.REVIEWS_KV.put("pro:test:angra:reg:PRO-22222222", JSON.stringify({ order: "PRO-22222222", sid: "cs_test_finnsinte00", utfall: "aterbetalas", steg: {} }));
  for (let i = 0; i < 150; i++) await env.REVIEWS_KV.put(`pro:test:angra:oppen:PRO-3${String(i).padStart(7, "0").replace(/[01]/g, "A")}`, "x"); // utan register: städas bort
  const s = await proSchema(env, { fetchImpl: fs, now: nu });
  assert.ok(s.fel.some((f) => f.startsWith("anger:")), "felet rapporteras"); assert.equal(fs.st.refunds.length, 1, "det riktiga ärendet slutförs ändå");
  assert.equal([...env.REVIEWS_KV.m.keys()].filter((k) => k.startsWith("pro:test:angra:oppen:PRO-3")).length, 0, "alla sidor lästes");
});

test("F6: KV-fel i en räknare fäller inte ångern; mottagningsbeviset går ut", async () => {
  const env = ENV(), fs = fs0(); const sid = await kop(env, fs, "projekt"); const order = await orderRef(sid);
  const put = env.REVIEWS_KV.put; env.REVIEWS_KV.put = async (k, v, o) => { if (k.startsWith("pro:rl:")) throw new Error("KV PUT failed: 429"); return put(k, v, o); };
  const r = await angra(env, fs, order); assert.equal(r.status, 200); assert.equal(r.j.status, "registrerad");
  assert.ok(mejl.some((m) => m.subject.startsWith("Mottagningsbevis"))); assert.equal(fs.st.refunds.length, 1);
});

test("F6b: om ångerregistret inte kan skrivas får kunden ett fel och kan försöka igen – inget bevis utan sparat register", async () => {
  const env = ENV(), fs = fs0(); const sid = await kop(env, fs, "projekt"); const order = await orderRef(sid);
  const j = await (await h(env, fs, req("/pro/angra", { method: "POST", body: { order, epost: "kund@example.se" } }))).json();
  const put = env.REVIEWS_KV.put; env.REVIEWS_KV.put = async (k, v, o) => { if (k.includes(":angra:reg:")) throw new Error("KV nere"); return put(k, v, o); };
  let r = await h(env, fs, req("/pro/angra", { method: "POST", body: { steg: "2", id: j.id } })); assert.equal(r.status, 502);
  assert.ok(!mejl.some((m) => m.subject.startsWith("Mottagningsbevis")));
  env.REVIEWS_KV.put = put; r = await h(env, fs, req("/pro/angra", { method: "POST", body: { steg: "2", id: j.id } })); assert.equal(r.status, 200, "samma bekräftelse fungerar igen");
});

test("F7: köparen får alltid mottagningsbeviset, även när en annan adress anges", async () => {
  const env = ENV(), fs = fs0(); const sid = await kop(env, fs, "ar", { email: "agare@example.se" }); await kvitto(env, fs, sid); mejl.length = 0;
  const r = await angra(env, fs, await orderRef(sid), "agare@example.se", { kvitto_epost: "annan@example.net" });
  assert.equal(r.j.utfall, "avslutas_och_aterbetalas");
  const till = mejl.filter((m) => m.subject.startsWith("Mottagningsbevis")).map((m) => m.to[0]).sort(); assert.deepEqual(till, ["agare@example.se", "annan@example.net"]);
});

test("F8: steg 2 förbrukar inte bekräftelsen före registreringen; formuläret utan JS får HTML även vid fel", async () => {
  const env = ENV(), fs = fs0(); const sid = await kop(env, fs, "projekt"); const order = await orderRef(sid);
  const j = await (await h(env, fs, req("/pro/angra", { method: "POST", body: { order, epost: "kund@example.se" } }))).json();
  fs.st.felPa = (m, p) => m === "GET" && p.startsWith("/checkout/sessions/");
  let r = await h(env, fs, req("/pro/angra", { method: "POST", body: { steg: "2", id: j.id } })); assert.equal(r.status, 502);
  fs.st.felPa = null; r = await h(env, fs, req("/pro/angra", { method: "POST", body: { steg: "2", id: j.id } })); assert.equal(r.status, 200, "andra försöket lyckas");
  assert.equal((await r.json()).status, "registrerad");
  r = await h(env, fs, req("/pro/angra", { method: "POST", body: { steg: "2", id: j.id } })); assert.equal(r.status, 410, "därefter förbrukad");
  fs.st.felPa = () => true;
  r = await h(env, fs, req("/pro/angra", { method: "POST", form: true, body: { order, epost: "kund@example.se" } }));
  assert.equal(r.status, 502); assert.match(r.headers.get("content-type"), /text\/html/); const t = await r.text(); assert.ok(t.includes("Försök igen om en stund") && t.includes("hej@stahledigital.se"));
});

test("F9: inloggning hittar kund vars e-post sparats med versaler", async () => {
  const env = ENV(), fs = fs0(); await kop(env, fs, "manad", { email: "Kund@Example.se" }); mejl.length = 0;
  await h(env, fs, req("/pro/inloggning", { method: "POST", body: { epost: "Kund@Example.se" } }));
  assert.equal(mejl.length, 1); assert.equal(mejl[0].subject, "Din inloggningslänk till PRO");
});

test("A2: /pro/aterhamta skickar en hämtlänk bara till köpets adress, och bara för ett giltigt, ej ångrat köp", async () => {
  const env = ENV(), fs = fs0(); const sid = await kop(env, fs, "projekt", { email: "kund@example.se" }); const order = await orderRef(sid);
  let r = await h(env, fs, req("/pro/aterhamta", { method: "POST", body: { order, epost: "KUND@example.se" } })); assert.equal(r.status, 202);
  assert.equal(mejl.length, 1); assert.deepEqual(mejl[0].to, ["kund@example.se"]); assert.ok(mejl[0].text.includes(`pro=ok&session_id=${sid}`) && mejl[0].subject.includes(order));
  r = await h(env, fs, req("/pro/aterhamta", { method: "POST", body: { order, epost: "annan@example.se" } })); assert.equal(r.status, 202); assert.equal(mejl.length, 1, "fel e-post: inget mejl, samma svar");
  r = await h(env, fs, req("/pro/aterhamta", { method: "POST", body: { order: "PRO-1", epost: "kund@example.se" } })); assert.equal(r.status, 400);
  NU += 3600 * 1000; await angra(env, fs, order); mejl.length = 0; NU += 3600 * 1000;
  r = await h(env, fs, req("/pro/aterhamta", { method: "POST", body: { order, epost: "kund@example.se" } })); assert.equal(r.status, 202); assert.equal(mejl.length, 0, "ångrat köp hämtas inte");
  // länken fungerar: kvittot ger token i en ny webbläsare
  _rensaMinne(); const env2 = ENV(), fs2 = fs0(); const s2 = await kop(env2, fs2, "projekt"); const k = await kvitto(env2, fs2, s2); assert.equal(k.status, 200); // ny Stripe-dubbel: töm isolatets objektcache
});

test("B: gränser per IP på kvitto och checkout; kampanjkoder av som standard", async () => {
  const env = ENV(), fs = fs0(); const sid = await kop(env, fs, "projekt");
  for (let i = 0; i < 60; i++) assert.equal((await kvitto(env, fs, sid, "198.51.100.1")).status, 200);
  assert.equal((await kvitto(env, fs, sid, "198.51.100.1")).status, 429); assert.equal((await kvitto(env, fs, sid, "198.51.100.2")).status, 200, "andra IP påverkas inte");
  const body = fs.st.sessions.get(sid)._body; assert.equal(body.allow_promotion_codes, undefined);
  _rensaMinne(); const env2 = ENV({ PRO_KAMPANJKODER: "on" }), fs2 = fs0(); const s2 = await kop(env2, fs2, "projekt"); assert.equal(fs2.st.sessions.get(s2)._body.allow_promotion_codes, "true"); _rensaMinne();
  let sista; for (let i = 0; i < 21; i++) sista = await h(env, fs, req("/pro/checkout", { method: "POST", ip: "192.0.2.7", body: { plan: "manad", forsok: forsok(), samtycke: SAMTYCKE_VERSION, villkor: VILLKOR_VERSION } }));
  assert.equal(sista.status, 429);
});

test("B: token utan utgångstid godtas aldrig; ånger efter fristen låter köpet gälla tills det prövats; past_due räknas som aktiv", async () => {
  const env = ENV(), fs = fs0();
  const utan = await signToken(env, { t: "projekt", p: PID, o: "PRO-ABCDEFGH" }); assert.equal(await verifyToken(env, utan, 0), null);
  assert.equal((await forny(env, fs, utan)).status, 401);
  const utanOrder = await signToken(env, { t: "projekt", p: PID, exp: nuS() + DAG }); assert.equal((await forny(env, fs, utanOrder)).status, 401, "projekttoken måste bära ordernummer");
  const sid = await kop(env, fs, "projekt"); const order = await orderRef(sid);
  NU += 16 * DAG * 1000; NU -= 0; // efter fristen men inom 30 dagar
  assert.equal((await angra(env, fs, order)).j.utfall, "manuell_provning");
  const k = await kvitto(env, fs, sid); assert.equal(k.status, 200, "kvittot och förnyelsen säger samma sak vid manuell prövning");
  const sm = await kop(env, fs, "manad"); const tm = (await (await kvitto(env, fs, sm)).json()).token;
  fs.st.subs.get(fs.st.sessions.get(sm).subscription).status = "past_due"; assert.equal((await forny(env, fs, tm)).status, 200);
});
