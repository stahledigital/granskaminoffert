// KONTO-SYNK K6 del A (KP-2026-10-16-01, Donatello 2026-10-18): wrangler.toml i läge inbjudna med EU-jurisdiktion, ALL åtkomst till
// ProRegister och ProKonto via nr() (rutter, scheduled, efterPitr inifrån ProKonto, radering, export och PITR), fail closed 503 när
// jurisdiction() saknas eller kastar (som i lokal workerd), bara inloggningskoden går ut (Zlatas ämne), K1-gränserna och cookiens attribut.
// Workerns RIKTIGA default-export och RIKTIGA klasser i node:sqlite-dubbeln. Den STRIKTA dubbeln räknar varje idFromName/get utanför
// jurisdiction("eu") som fel och kastar. Resend är en HTTP-dubbel; inget annat nät tillåts. Tiden styrs via Date.now.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { ProRegister, ProKonto, KONTO_TEXT, GRANS_EPOST, SESSION_S, skapaSessionsvarde, COOKIE } from "../src/pro_konto.js";
import { namnrymd } from "./helpers/pro_do_dubbel.mjs";
import { ENV } from "./stripe_dubbel.mjs";

const API = "https://granskaminoffert-api.anders-316.workers.dev";
const SAJT = "https://stahledigital.se";
const AGARE = "anders@stahledigital.se", T1 = "testare.ett@example.se", OKAND = "okand.person@example.se";
let mejl, origFetch, origNow, NU;
beforeEach(() => {
  mejl = []; NU = Date.UTC(2026, 9, 18, 8, 0, 0);
  origFetch = globalThis.fetch; origNow = Date.now; Date.now = () => NU;
  globalThis.fetch = async (url, init) => {
    if (String(url) !== "https://api.resend.com/emails") throw new Error("oväntat nätanrop " + url);
    mejl.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: "re_" + mejl.length.toString().padStart(10, "0") }), { status: 200 });
  };
});
afterEach(() => { globalThis.fetch = origFetch; Date.now = origNow; });
const fram = (s) => { NU += s * 1000; };

// wrangler.toml [vars] som workern får live (bara enkla strängvärden).
const TOML = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const VARS = (() => { const v = {}, i = TOML.indexOf("\n[vars]"), j = TOML.indexOf("\n[", i + 7);
  for (const rad of TOML.slice(i + 7, j).split("\n")) { const m = rad.match(/^\s*([A-Z0-9_]+)\s*=\s*"(.*)"\s*$/); if (m) v[m[1]] = m[2]; } return v; })();

// Strikt EU-dubbel: bara jurisdiction("eu") ger en användbar namnrymd. Allt annat räknas i `fel` och kastar.
function striktEu(Klass, env) {
  const inre = namnrymd(Klass, env), fel = [];
  const eu = inre.jurisdiction("eu");
  return {
    fel, inre, inst: inre.inst, anrop: inre.anrop, jur: inre.jur,
    idFromName(n) { fel.push("idFromName utan jurisdiktion: " + n); throw new Error("idFromName utan jurisdiktion"); },
    get() { fel.push("get utan jurisdiktion"); throw new Error("get utan jurisdiktion"); },
    jurisdiction(j) { if (j !== "eu") { fel.push("jurisdiction " + j); throw new Error("fel jurisdiktion"); } return eu; },
  };
}
function kEnv({ extra = {}, ns = "eu" } = {}) {
  const e = ENV({ PRO_PAYMENTS: VARS.PRO_PAYMENTS, PRO_KONTO: VARS.PRO_KONTO, PRO_OWNER_EMAIL: VARS.PRO_OWNER_EMAIL, PRO_DO_JURISDIKTION: VARS.PRO_DO_JURISDIKTION, PRO_MAIL_DAY_CAP: "1000", ...extra });
  if (ns === "eu") { e.PRO_REGISTER = striktEu(ProRegister, e); e.PRO_KONTON = striktEu(ProKonto, e); }
  else if (ns === "utan_metod") { // som en namnrymd utan jurisdiction(): idFromName/get finns men får inte användas när "eu" är valt
    for (const [b, K] of [["PRO_REGISTER", ProRegister], ["PRO_KONTON", ProKonto]]) { const n = namnrymd(K, e); delete n.jurisdiction; n.fel = []; const g = n.get; n.get = (id) => { n.fel.push("get"); return g(id); }; e[b] = n; } }
  else if (ns === "kastar") { // som lokal workerd: metoden finns men kastar
    for (const [b, K] of [["PRO_REGISTER", ProRegister], ["PRO_KONTON", ProKonto]]) { const n = namnrymd(K, e); n.fel = []; n.jurisdiction = () => { throw new Error("Jurisdiction restrictions are not implemented in workerd."); };
      const g = n.get; n.get = (id) => { n.fel.push("get"); return g(id); }; e[b] = n; } }
  return e;
}
const ctx = () => { const v = []; return { v, waitUntil: (p) => v.push(p), passThroughOnException() {} }; };
let ipN = 0;
function req(path, { method = "GET", body, cookie, headers = {}, ip } = {}) {
  const h = { "CF-Connecting-IP": ip || `198.51.100.${(ipN++ % 200) + 1}`, Origin: SAJT, ...headers };
  if (method !== "GET") h["X-MR-Pro"] = "1";
  if (body !== undefined) h["content-type"] = "application/json";
  if (cookie) h.Cookie = cookie;
  return new Request(API + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}
const f = async (env, path, o) => { const c = ctx(); const r = await worker.fetch(req(path, o), env, c); await Promise.all(c.v); return r; };
const kodUr = (m) => /\n {4}(\d{6})\n/.exec(m.text)[1];
const cookieUr = (r) => { const s = r.headers.get("set-cookie"); return s ? s.split(";")[0] : null; };
async function begarKod(e, epost, o = {}) { if (!o.utanPaus) fram(6 * 60); const n = mejl.length; const r = await f(e, "/pro/konto/kod", { method: "POST", body: { epost }, ip: o.ip });
  assert.equal(r.status, 202); return mejl.length > n ? mejl[mejl.length - 1] : null; }
async function loggaIn(e, epost = AGARE, namn) {
  const m = await begarKod(e, epost); assert.ok(m, "kodmejl till " + epost);
  const r = await f(e, "/pro/konto/logga-in", { method: "POST", body: { epost, kod: kodUr(m), ...(namn ? { namn } : {}) } });
  assert.equal(r.status, 200, "inloggning " + epost); return { cookie: cookieUr(r), setCookie: r.headers.get("set-cookie") };
}
const stegkod = async (e) => kodUr(await begarKod(e, AGARE));
const pid = (n) => "p_" + n.toString(16).padStart(32, "0");
const projekt = (id) => ({ format: "materialraknaren-pro-projekt", version: 1, projektId: id, projektnamn: "Drill altan", moms: "25",
  material: [{ namn: "Trall 28x120", mangd: "42", enhet: "st", pris_kr: null, med: true }], arbete: [], ovrigt: [], kund: { namn: "Påhittad Kund", adress: "Drillgatan 1" } });
const put = (e, cookie, id, rev) => f(e, `/pro/konto/projekt/${id}`, { method: "PUT", cookie, body: projekt(id), headers: { "If-Match": String(rev) } });
const allaFel = (e) => [...(e.PRO_REGISTER.fel || []), ...(e.PRO_KONTON.fel || [])];

test("wrangler.toml K6: PRO_KONTO inbjudna och PRO_DO_JURISDIKTION eu; PRO_PAYMENTS off, PRO_OWNER_EMAIL oförändrad, PRO_TEST_MEJL saknas; inga nya bindningar eller migrationer", () => {
  assert.equal(VARS.PRO_KONTO, "inbjudna"); assert.equal(VARS.PRO_DO_JURISDIKTION, "eu");
  assert.equal(VARS.PRO_PAYMENTS, "off"); assert.equal(VARS.PRO_OWNER_EMAIL, "anders@stahledigital.se");
  assert.ok(!/^\s*PRO_TEST_MEJL\s*=/m.test(TOML) && !("PRO_TEST_MEJL" in VARS), "PRO_TEST_MEJL är inte satt i wrangler.toml (= av)");
  assert.equal((TOML.match(/^\[\[durable_objects\.bindings\]\]/gm) || []).length, 7, "samma 7 DO-bindningar som K5");
  assert.equal((TOML.match(/^\[\[migrations\]\]/gm) || []).length, 5, "samma 5 migrationer (v1–v5)");
  assert.deepEqual([...TOML.matchAll(/^tag = "(v\d+)"/gm)].map((m) => m[1]), ["v1", "v2", "v3", "v4", "v5"]);
});

test("EU: ägarresan (kod, inloggning, /jag, PUT, lista, hämta, export, testplats, testarens inloggning och radering, PITR med efterPitr inifrån ProKonto, scheduled) rör BARA jurisdiction(\"eu\")", async () => {
  const e = kEnv();
  const O = (await loggaIn(e, AGARE, "Mac")).cookie;
  const jag = await (await f(e, "/pro/konto/jag", { cookie: O })).json(); assert.equal(jag.roll, "agare");
  assert.equal((await put(e, O, pid(1), 0)).status, 200);
  assert.equal((await f(e, "/pro/konto/projekt", { cookie: O })).status, 200);
  assert.equal((await f(e, `/pro/konto/projekt/${pid(1)}`, { cookie: O })).status, 200);
  assert.equal((await f(e, "/pro/konto/export", { cookie: O })).status, 200);
  assert.equal((await f(e, `/pro/konto/projekt/${pid(1)}`, { method: "DELETE", cookie: O, headers: { "If-Match": "1" } })).status, 200);
  // testplats (register) och testaren (eget ProKonto), sedan radering av testkontot
  const ib = await f(e, "/pro/konto/agare/inbjud", { method: "POST", cookie: O, body: { epost: T1, kod: await stegkod(e) } }); assert.equal(ib.status, 200);
  assert.equal((await f(e, "/pro/konto/agare/testplatser", { cookie: O })).status, 200);
  const T = (await loggaIn(e, T1, "Telefon")).cookie;
  const tKonto = (await (await f(e, "/pro/konto/jag", { cookie: T })).json()).konto;
  assert.equal((await put(e, T, pid(2), 0)).status, 200);
  const tk = kodUr(await begarKod(e, T1));
  assert.equal((await f(e, "/pro/konto/radera", { method: "POST", cookie: T, body: { bekrafta: true, epost: T1, kod: tk } })).status, 200);
  // PITR av ägarens drillkonto: objektet i EU-namnrymden får bokmärket; omstart → efterPitr frågar registret inifrån ProKonto
  const ko = () => e.PRO_KONTON.inst.get("eu|k:" + jag.konto);
  assert.ok(ko(), "ägarens ProKonto ligger under eu|"); assert.ok(e.PRO_REGISTER.inst.get("eu|register:v1"), "registret ligger under eu|");
  ko().storage.getBookmarkForTime = async (t) => "bm-" + t; ko().storage.onNextSessionRestoreBookmark = async () => {};
  const pr = await f(e, "/pro/konto/agare/pitr", { method: "POST", cookie: O, body: { konto: jag.konto, tid_ms: NU - 60000, epost: AGARE, kod: await stegkod(e) } });
  assert.equal(pr.status, 200); assert.equal((await pr.json()).status, "aterstallning_planerad");
  e.PRO_KONTON.inst.set("eu|k:" + jag.konto, new ProKonto(ko().state, e));
  const fore = e.PRO_REGISTER.anrop.length;
  assert.equal((await f(e, "/pro/konto/jag", { cookie: O })).status, 401, "efterPitr: alla enheter utloggade");
  assert.ok(e.PRO_REGISTER.anrop.slice(fore).some((a) => /pitr_status/.test(a.url)) && e.PRO_REGISTER.anrop.slice(fore).some((a) => /pitr_klar/.test(a.url)), "efterPitr gick till registret (EU)");
  // scheduled: kontoSchema (efterrensning, avisering, radering) i den riktiga ingången
  const c = ctx(); await worker.scheduled({ cron: "17 * * * *" }, e, c); await Promise.all(c.v);
  assert.ok(e.PRO_REGISTER.anrop.some((a) => /orensade/.test(a.url)) && e.PRO_REGISTER.anrop.some((a) => /forfallna/.test(a.url)), "scheduled körde mot registret");
  // facit
  assert.deepEqual(allaFel(e), [], "ingen åtkomst utanför jurisdiction(\"eu\")");
  assert.ok(e.PRO_REGISTER.jur.length > 0 && e.PRO_REGISTER.jur.every((j) => j === "eu"));
  for (const n of [...e.PRO_REGISTER.inst.keys(), ...e.PRO_KONTON.inst.keys()]) assert.ok(n.startsWith("eu|"), "objekt utan eu|: " + n);
  for (const a of [...e.PRO_REGISTER.anrop, ...e.PRO_KONTON.anrop]) assert.ok(a.namn.startsWith("eu|"), "anrop utan eu|: " + a.namn);
  assert.ok(e.PRO_KONTON.inst.has("eu|k:" + tKonto), "testkontots objekt (rensat) låg också under eu|");
});

test("EU: id:n i jurisdiktionen skiljer sig från id:n utan jurisdiktion (samma namn → annat objekt)", () => {
  const n = namnrymd(ProRegister, {}); const utan = n.idFromName("register:v1"), med = n.jurisdiction("eu").idFromName("register:v1");
  assert.notEqual(String(utan), String(med));
});

for (const [lage, namn] of [["utan_metod", "jurisdiction() saknas"], ["kastar", "jurisdiction() kastar (lokal workerd)"]]) {
  test(`fail closed: ${namn} → /jag, /projekt, logga-in, export, ägar-API och PITR svarar 503 utan DO-åtkomst; /kod ger samma 202 men inget mejl; scheduled rör inget`, async () => {
    const e = kEnv({ ns: lage });
    const cookie = COOKIE + "=" + (await skapaSessionsvarde(e, "k_" + "a".repeat(32))).varde; // giltig signatur: sessionen prövas i ProKonto → nr()
    for (const [vag, o] of [["/pro/konto/jag", { cookie }], ["/pro/konto/projekt", { cookie }], ["/pro/konto/export", { cookie }], ["/pro/konto/agare/testplatser", { cookie }],
      ["/pro/konto/logga-in", { method: "POST", body: { epost: AGARE, kod: "123456" } }], ["/pro/konto/agare/pitr", { method: "POST", cookie, body: { konto: "k_" + "b".repeat(32), tid_ms: NU - 1000 } }]]) {
      const r = await f(e, vag, o); const j = await r.json().catch(() => ({}));
      assert.equal(r.status, 503, `${vag}: ${r.status} ${JSON.stringify(j)}`); assert.equal(j.status, "konfiguration", vag);
    }
    assert.equal((await f(e, "/pro/konto/logga-in", { method: "POST", body: { epost: AGARE, kod: "123456" } })).status, 503, "logga-in når registret → 503");
    assert.equal((await begarKod(e, AGARE)), null, "inget kodmejl");
    const c = ctx(); await worker.scheduled({ cron: "17 * * * *" }, e, c); await Promise.all(c.v);
    assert.deepEqual(allaFel(e), [], "ingen get() utan jurisdiktion"); assert.equal(mejl.length, 0);
  });
}

test("mejl i inbjudna: ägaren får exakt EN kod per begäran med Zlatas ämne; inbjudan utan PRO_TEST_MEJL skickar inget; okänd adress samma 202 utan mejl; K1-gränsen 3 per 15 min per adress gäller", async () => {
  const e = kEnv();
  assert.equal(KONTO_TEXT.kod_amne, "Din inloggningskod till Materialräknaren", "Zlatas login.mejl_amne ordagrant");
  const m1 = await begarKod(e, AGARE); assert.equal(mejl.length, 1); assert.equal(m1.subject, "Din inloggningskod till Materialräknaren"); assert.deepEqual([m1.to].flat(), [AGARE]);
  assert.equal((m1.text.match(/\n {4}\d{6}\n/g) || []).length, 1, "exakt en kod i mejlet");
  // inloggning och inbjudan: ingen testinbjudan går ut (PRO_TEST_MEJL saknas)
  const r = await f(e, "/pro/konto/logga-in", { method: "POST", body: { epost: AGARE, kod: kodUr(m1) } }); const O = cookieUr(r);
  const n0 = mejl.length;
  const kod = await stegkod(e); assert.equal(mejl.length, n0 + 1, "steg-koden är ett vanligt kodmejl");
  const ib = await f(e, "/pro/konto/agare/inbjud", { method: "POST", cookie: O, body: { epost: T1, kod } }); assert.equal(ib.status, 200);
  assert.equal(mejl.length, n0 + 1, "inget inbjudningsmejl");
  assert.ok(mejl.every((m) => m.subject === KONTO_TEXT.kod_amne), "bara inloggningskoder: " + mejl.map((m) => m.subject).join(" | "));
  // okänd adress: samma 202, inget mejl
  const n1 = mejl.length; assert.equal(await begarKod(e, OKAND), null); assert.equal(mejl.length, n1);
  // K1: högst GRANS_EPOST koder per adress och 15 min (samma 202 efter gränsen), därefter igen
  fram(16 * 60); const n2 = mejl.length;
  for (let i = 0; i < GRANS_EPOST + 2; i++) await begarKod(e, T1, { utanPaus: true });
  assert.equal(mejl.length - n2, GRANS_EPOST, `exakt ${GRANS_EPOST} koder inom 15 min`);
  fram(16 * 60); assert.ok(await begarKod(e, T1, { utanPaus: true }), "efter 15 min går en ny kod ut");
  assert.deepEqual(allaFel(e), []);
});

test("cookie: inloggningen sätter __Host-mrpro med exakt Path=/; Max-Age; Secure; HttpOnly; SameSite=Lax och utan Domain (host-only); utloggning rensar med samma attribut", async () => {
  const e = kEnv();
  const { setCookie, cookie } = await loggaIn(e);
  assert.match(setCookie, new RegExp(`^__Host-mrpro=k_[0-9a-f]{32}\\.[^;]+; Path=/; Max-Age=${SESSION_S}; Secure; HttpOnly; SameSite=Lax$`));
  assert.ok(!/domain=/i.test(setCookie), "ingen Domain");
  const ut = await f(e, "/pro/konto/logga-ut", { method: "POST", cookie });
  assert.equal(ut.headers.get("set-cookie"), "__Host-mrpro=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax");
});
