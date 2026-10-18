// KONTO-SYNK K1 (KP-2026-10-16-01): /pro/konto/* via workerns RIKTIGA default-export, riktiga klasser ProRegister/ProKonto i
// node:sqlite-dubbel (test/helpers/pro_do_dubbel.mjs). Resend är en HTTP-dubbel; inget annat nät tillåts. Tiden styrs via Date.now.
// Hela kedjan i workerd provas separat i pro_konto_runtime.test.mjs.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { ProRegister, ProKonto, epostHash, register, KOD_FORSOK, SESSION_S, COOKIE } from "../src/pro_konto.js";
import { namnrymd } from "./helpers/pro_do_dubbel.mjs";
import { ENV, kv } from "./stripe_dubbel.mjs";

const API = "https://granskaminoffert-api.anders-316.workers.dev";
const SAJT = "https://stahledigital.se";
const AGARE = "anders@stahledigital.se";
let mejl, natAnrop, origFetch, origNow, NU;
beforeEach(() => {
  mejl = []; natAnrop = []; NU = Date.UTC(2026, 9, 18, 8, 0, 0);
  origFetch = globalThis.fetch; origNow = Date.now; Date.now = () => NU;
  globalThis.fetch = async (url, init) => {
    natAnrop.push(String(url && url.url ? url.url : url));
    if (String(url) !== "https://api.resend.com/emails") throw new Error("oväntat nätanrop " + url);
    const b = JSON.parse(init.body); mejl.push({ ...b, idem: init.headers["idempotency-key"] });
    return new Response(JSON.stringify({ id: "re_" + mejl.length.toString().padStart(10, "0") }), { status: 200 });
  };
});
afterEach(() => { globalThis.fetch = origFetch; Date.now = origNow; });

function kEnv(extra = {}) {
  const e = ENV({ PRO_PAYMENTS: "off", PRO_KONTO: "inbjudna", PRO_OWNER_EMAIL: AGARE, PRO_MAIL_DAY_CAP: "100", ...extra });
  e.PRO_REGISTER = namnrymd(ProRegister); e.PRO_KONTON = namnrymd(ProKonto);
  return e;
}
const ctx = () => { const v = []; return { v, waitUntil: (p) => v.push(p), passThroughOnException() {} }; };
let ipN = 0;
function req(path, { method = "GET", origin = SAJT, xmr = true, body, cookie, ip } = {}) {
  const h = { "CF-Connecting-IP": ip || `203.0.113.${(ipN++ % 200) + 1}` };
  if (origin) h.Origin = origin;
  if (xmr && method !== "GET") h["X-MR-Pro"] = "1";
  if (body !== undefined) h["content-type"] = "application/json";
  if (cookie) h.Cookie = cookie;
  return new Request(API + path, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
}
const f = (env, path, o) => worker.fetch(req(path, o), env, ctx());
const kodUr = (m) => /\n {4}(\d{6})\n/.exec(m.text)[1];
const lankUr = (m) => /#pro-konto=([0-9a-f]{32}\.\d{6})/.exec(m.text)[1];
const cookieUr = (r) => { const s = r.headers.get("set-cookie"); return s ? s.split(";")[0] : null; };
async function loggaIn(env, epost = AGARE, namn) {
  mejl.length = 0;
  assert.equal((await f(env, "/pro/konto/kod", { method: "POST", body: { epost } })).status, 202);
  assert.equal(mejl.length, 1, "kodmejl");
  const r = await f(env, "/pro/konto/logga-in", { method: "POST", body: { epost, kod: kodUr(mejl[0]), ...(namn ? { namn } : {}) } });
  return r;
}

// ---------- grinden ----------
test("PRO_KONTO off (och saknad/okänd): allt under /pro/konto/* ger 503 stangt, 0 mejl, 0 DO-, KV- och nätanrop", async () => {
  for (const lage of ["off", undefined, "", "on", "INBJUDNA"]) {
    const e = kEnv({ PRO_KONTO: lage }); if (lage === undefined) delete e.PRO_KONTO;
    const kvA = []; const k0 = e.REVIEWS_KV; e.REVIEWS_KV = new Proxy(k0, { get(t, p) { const v = t[p]; return typeof v === "function" ? (...a) => { kvA.push(p); return v.apply(t, a); } : v; } });
    for (const [p, m, b] of [["/pro/konto/kod", "POST", { epost: AGARE }], ["/pro/konto/logga-in", "POST", { epost: AGARE, kod: "123456" }], ["/pro/konto/jag", "GET"],
      ["/pro/konto/logga-ut", "POST", {}], ["/pro/konto/enheter/e_0123456789abcdef/logga-ut", "POST", {}], ["/pro/konto/x", "GET"], ["/pro/konto/kod", "OPTIONS"]]) {
      for (const o of [{}, { origin: null, xmr: false }, { origin: "https://ond.example" }]) {
        const r = await f(e, p, { method: m, body: b, ...o });
        assert.equal(r.status, 503, `${lage} ${m} ${p}`); assert.deepEqual(await r.json(), { status: "stangt" });
        assert.equal(r.headers.get("set-cookie"), null);
      }
    }
    assert.deepEqual(e.PRO_REGISTER.anrop, []); assert.deepEqual(e.PRO_KONTON.anrop, []); assert.deepEqual(kvA, []);
  }
  assert.equal(mejl.length, 0); assert.deepEqual(natAnrop, []);
});

test("off-svaret för /pro/konto/* har samma headers som basens /pro/* i off (CORS för sajten, vary)", async () => {
  const e = kEnv({ PRO_KONTO: "off" });
  const a = await f(e, "/pro/konto/kod", { method: "POST", body: {} }), b = await f(e, "/pro/checkout", { method: "POST", body: {} });
  assert.deepEqual([...a.headers], [...b.headers]); assert.equal(await a.text(), await b.text());
});

test("wrangler.toml: PRO_KONTO off, ägaradress, PRO_PAYMENTS off, två nya SQLite-klasser i migration v5", () => {
  const t = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.match(t, /^PRO_KONTO = "off"$/m); assert.match(t, /^PRO_OWNER_EMAIL = "anders@stahledigital\.se"$/m); assert.match(t, /^PRO_PAYMENTS = "off"$/m);
  assert.match(t, /name = "PRO_REGISTER"\nclass_name = "ProRegister"/); assert.match(t, /name = "PRO_KONTON"\nclass_name = "ProKonto"/);
  assert.match(t, /tag = "v5"\nnew_sqlite_classes = \["ProRegister", "ProKonto"\]/);
  assert.equal((t.match(/^\[\[migrations\]\]$/gm) || []).length, 5);
});

// ---------- ursprung ----------
test("ändrande anrop utan Origin, med fel Origin eller utan X-MR-Pro: 403, inget mejl, ingen DO-åtkomst", async () => {
  const e = kEnv();
  for (const p of ["/pro/konto/kod", "/pro/konto/logga-in", "/pro/konto/logga-ut", "/pro/konto/enheter/e_0123456789abcdef/logga-ut"])
    for (const o of [{ origin: null }, { origin: "https://ond.example" }, { xmr: false }, { origin: "https://stahledigital.se.ond.example" }]) {
      const r = await f(e, p, { method: "POST", body: { epost: AGARE }, ...o });
      assert.equal(r.status, 403, p + JSON.stringify(o)); assert.equal((await r.json()).status, "fel_ursprung");
    }
  assert.equal(mejl.length, 0); assert.deepEqual(e.PRO_REGISTER.anrop, []); assert.deepEqual(e.PRO_KONTON.anrop, []);
  // X-MR-Pro måste vara exakt "1"
  const r = await worker.fetch(new Request(API + "/pro/konto/kod", { method: "POST", headers: { Origin: SAJT, "X-MR-Pro": "true", "content-type": "application/json" }, body: "{}" }), e, ctx());
  assert.equal(r.status, 403);
});

// ---------- kod ----------
test("ägaren får kod + länk med samma engångsvärde; okänd adress får samma 202 och inget mejl; ingen CORS", async () => {
  const e = kEnv();
  const r1 = await f(e, "/pro/konto/kod", { method: "POST", body: { epost: " Anders@StahleDigital.se " } });
  assert.equal(r1.status, 202); const j1 = await r1.text();
  assert.equal(mejl.length, 1); assert.deepEqual([mejl[0].to].flat(), [AGARE]);
  const kod = kodUr(mejl[0]), lank = lankUr(mejl[0]);
  assert.match(kod, /^\d{6}$/); assert.equal(lank.split(".")[1], kod, "länken bär samma kod");
  assert.match(mejl[0].text, /https:\/\/stahledigital\.se\/verkstaden\/materialraknaren\/offert#pro-konto=/);
  assert.equal(mejl[0].idem, "pro-konto-kod-" + lank.split(".")[0]);
  const r2 = await f(e, "/pro/konto/kod", { method: "POST", body: { epost: "okand@example.se" } });
  assert.equal(r2.status, 202); assert.equal(await r2.text(), j1, "samma kropp"); assert.equal(mejl.length, 1);
  for (const b of [{ epost: "inte-en-adress" }, {}, "x".repeat(5000)]) { const r = await f(e, "/pro/konto/kod", { method: "POST", body: b }); assert.equal(r.status, 202); }
  assert.equal(mejl.length, 1);
  assert.equal(r1.headers.get("access-control-allow-origin"), null); assert.equal(r1.headers.get("x-robots-tag"), "noindex");
  // registret har aldrig e-posten i klartext
  const db = [...e.PRO_REGISTER.inst.values()][0].storage.sql;
  const dump = JSON.stringify(["konton", "koder", "grans", "testbevis"].map((t) => db.exec(`SELECT * FROM ${t}`).toArray()));
  assert.doesNotMatch(dump, /anders|stahledigital|okand@/i); assert.doesNotMatch(dump, new RegExp(kod));
});

test("koden lagras bara som hash, gäller 10 min, utgången nekas", async () => {
  const e = kEnv();
  await f(e, "/pro/konto/kod", { method: "POST", body: { epost: AGARE } });
  const kod = kodUr(mejl[0]);
  const rad = [...e.PRO_REGISTER.inst.values()][0].storage.sql.exec("SELECT * FROM koder").toArray()[0];
  assert.match(rad.hash, /^[0-9a-f]{64}$/); assert.equal(rad.utgar - rad.skapad, 600);
  NU += 600 * 1000;
  const r = await f(e, "/pro/konto/logga-in", { method: "POST", body: { epost: AGARE, kod } });
  assert.equal(r.status, 401); assert.equal(r.headers.get("set-cookie"), null);
  NU -= 1000; // en sekund före utgång: fortfarande giltig? nej – raden är oförändrad, så samma kod fungerar vid 599 s
  const r2 = await f(e, "/pro/konto/logga-in", { method: "POST", body: { epost: AGARE, kod } });
  assert.equal(r2.status, 200);
});

test("5 felförsök spärrar koden, även för rätt kod därefter; okänd adress och fel id ger samma 401", async () => {
  const e = kEnv();
  await f(e, "/pro/konto/kod", { method: "POST", body: { epost: AGARE } });
  const kod = kodUr(mejl[0]), fel = kod === "000000" ? "111111" : "000000";
  for (let i = 0; i < KOD_FORSOK; i++) { const r = await f(e, "/pro/konto/logga-in", { method: "POST", body: { epost: AGARE, kod: fel } }); assert.equal(r.status, 401); assert.deepEqual(await r.json(), { status: "ogiltig_kod" }); }
  const r = await f(e, "/pro/konto/logga-in", { method: "POST", body: { epost: AGARE, kod } });
  assert.equal(r.status, 401); assert.deepEqual(await r.json(), { status: "ogiltig_kod" });
  const r2 = await f(e, "/pro/konto/logga-in", { method: "POST", body: { lank: lankUr(mejl[0]) } });
  assert.equal(r2.status, 401, "länken till en spärrad kod");
  for (const b of [{ epost: "okand@example.se", kod }, { lank: "0".repeat(32) + "." + kod }, { lank: "x" }, {}]) assert.equal((await f(e, "/pro/konto/logga-in", { method: "POST", body: b })).status, 401);
});

test("4 fel + rätt fungerar; länken fungerar en gång; ny kod ersätter den gamla", async () => {
  const e = kEnv();
  await f(e, "/pro/konto/kod", { method: "POST", body: { epost: AGARE } });
  const kod = kodUr(mejl[0]), fel = kod === "000000" ? "111111" : "000000";
  for (let i = 0; i < KOD_FORSOK - 1; i++) await f(e, "/pro/konto/logga-in", { method: "POST", body: { epost: AGARE, kod: fel } });
  assert.equal((await f(e, "/pro/konto/logga-in", { method: "POST", body: { epost: AGARE, kod } })).status, 200);
  await f(e, "/pro/konto/kod", { method: "POST", body: { epost: AGARE } }); const l1 = lankUr(mejl[1]);
  await f(e, "/pro/konto/kod", { method: "POST", body: { epost: AGARE } }); const l2 = lankUr(mejl[2]);
  assert.equal((await f(e, "/pro/konto/logga-in", { method: "POST", body: { lank: l1 } })).status, 401, "ersatt kod");
  assert.equal((await f(e, "/pro/konto/logga-in", { method: "POST", body: { lank: l2 } })).status, 200);
  assert.equal((await f(e, "/pro/konto/logga-in", { method: "POST", body: { lank: l2 } })).status, 401, "engångs");
});

test("två samtidiga inlösen av samma kod: exakt en lyckad (även blandat länk/kod)", async () => {
  for (let varv = 0; varv < 10; varv++) {
    const e = kEnv(); mejl.length = 0;
    await f(e, "/pro/konto/kod", { method: "POST", body: { epost: AGARE } });
    const kod = kodUr(mejl[0]), lank = lankUr(mejl[0]);
    const kroppar = varv % 2 ? [{ epost: AGARE, kod }, { lank }] : [{ epost: AGARE, kod }, { epost: AGARE, kod }, { lank }];
    const svar = await Promise.all(kroppar.map((body) => f(e, "/pro/konto/logga-in", { method: "POST", body })));
    assert.deepEqual(svar.map((r) => r.status).sort(), [200, ...Array(kroppar.length - 1).fill(401)], "varv " + varv);
    assert.equal(svar.filter((r) => r.headers.get("set-cookie")).length, 1);
  }
});

test("skickgränser: 3 per e-post och 15 min, 10 per IP och timme, dagstaket PRO_MAIL_DAY_CAP – alltid 202", async () => {
  let e = kEnv();
  for (let i = 0; i < 5; i++) assert.equal((await f(e, "/pro/konto/kod", { method: "POST", body: { epost: AGARE } })).status, 202);
  assert.equal(mejl.length, 3);
  NU += 15 * 60 * 1000; await f(e, "/pro/konto/kod", { method: "POST", body: { epost: AGARE } }); assert.equal(mejl.length, 4, "nytt 15-minutersfönster");
  e = kEnv(); mejl.length = 0; NU = Date.UTC(2026, 9, 18, 9, 0, 0);
  for (let i = 0; i < 12; i++) assert.equal((await f(e, "/pro/konto/kod", { method: "POST", ip: "198.51.100.7", body: { epost: i < 9 ? "okand" + i + "@example.se" : AGARE } })).status, 202);
  assert.equal(mejl.length, 1, "ip-gränsen räknar alla försök: 10:e når ägaren, 11–12 stoppas");
  e = kEnv({ PRO_MAIL_DAY_CAP: "2" }); mejl.length = 0;
  const T = "t@example.se"; const nu = Math.floor(NU / 1000);
  await register(e, "testbevis", { nu, ehash: await epostHash(e, T), slut: nu + 30 * 86400 });
  await f(e, "/pro/konto/kod", { method: "POST", body: { epost: AGARE } }); await f(e, "/pro/konto/kod", { method: "POST", body: { epost: T } });
  await f(e, "/pro/konto/kod", { method: "POST", body: { epost: AGARE } });
  assert.equal(mejl.length, 2, "dagstaket");
});

test("testbevis: aktivt får kod och roll test; återkallat eller utgånget får 202 utan mejl", async () => {
  const e = kEnv(), T = "Testare@Example.se", nu = Math.floor(NU / 1000), eh = await epostHash(e, T);
  await f(e, "/pro/konto/kod", { method: "POST", body: { epost: T } }); assert.equal(mejl.length, 0, "ej inbjuden");
  await register(e, "testbevis", { nu, ehash: eh, slut: nu + 30 * 86400 });
  const r = await loggaIn(e, T); assert.equal(r.status, 200);
  const j = await (await f(e, "/pro/konto/jag", { cookie: cookieUr(r) })).json();
  assert.equal(j.roll, "test"); assert.equal(j.ratt_slut, nu + 30 * 86400); assert.equal(j.las_slut, nu + 120 * 86400);
  await register(e, "testbevis", { nu, ehash: eh, aterkalla: true });
  const j2 = await (await f(e, "/pro/konto/jag", { cookie: cookieUr(r) })).json();
  assert.equal(j2.roll, "ingen", "återkallad förlorar rätten vid nästa anrop; sessionen är separat");
  mejl.length = 0; NU += 16 * 60 * 1000; await f(e, "/pro/konto/kod", { method: "POST", body: { epost: T } }); assert.equal(mejl.length, 0);
});

// ---------- session ----------
test("logga-in sätter __Host-mrpro exakt: Secure, HttpOnly, SameSite=Lax, Path=/, ingen Domain, 90 d", async () => {
  const e = kEnv(); const r = await loggaIn(e);
  assert.equal(r.status, 200);
  const sc = r.headers.get("set-cookie");
  const delar = sc.split(";").map((s) => s.trim());
  assert.match(delar[0], new RegExp(`^${COOKIE}=k_[0-9a-f]{32}\\.[A-Za-z0-9_-]{22}\\.[0-9a-f]{64}$`));
  assert.deepEqual(delar.slice(1).sort(), ["HttpOnly", "Max-Age=7776000", "Path=/", "SameSite=Lax", "Secure"].sort());
  assert.doesNotMatch(sc, /domain/i);
  const j = await (await f(e, "/pro/konto/jag", { cookie: cookieUr(r) })).json();
  assert.equal(j.status, "ok"); assert.equal(j.roll, "agare"); assert.equal(j.ratt_slut, null); assert.equal(j.las_slut, null);
  assert.equal(j.enheter.length, 1); assert.equal(j.enheter[0].denna, true); assert.match(j.konto, /^k_[0-9a-f]{32}$/);
});

test("manipulerad eller främmande cookie: 401 utan DO-uppslag", async () => {
  const e = kEnv(); const r = await loggaIn(e); const c = cookieUr(r);
  const fore = e.PRO_KONTON.anrop.length;
  for (const bad of [c.slice(0, -1) + (c.endsWith("0") ? "1" : "0"), c.replace(/k_[0-9a-f]{4}/, "k_ffff"), `${COOKIE}=x`, `${COOKIE}=`, "annan=1"]) {
    const s = await f(e, "/pro/konto/jag", { cookie: bad }); assert.equal(s.status, 401, bad);
  }
  assert.equal(e.PRO_KONTON.anrop.length, fore, "signaturen nekar före DO");
  assert.equal((await f(e, "/pro/konto/jag")).status, 401);
  // samma cookie mot en env med annan nyckel (annat webhookhemlighetspar) nekas
  const e2 = kEnv({ STRIPE_WEBHOOK_SECRET: "whsec_ANNANNYCKEL0123456789" }); e2.PRO_REGISTER = e.PRO_REGISTER; e2.PRO_KONTON = e.PRO_KONTON;
  assert.equal((await f(e2, "/pro/konto/jag", { cookie: c })).status, 401);
});

test("3 enheter: den fjärde får 409 enhetsgrans med lista (koden förbrukas inte); vald utloggning; utloggad cookie får 401", async () => {
  const e = kEnv(); const c = [];
  for (const n of ["Mobil", "Dator", "Platta"]) { const r = await loggaIn(e, AGARE, n); assert.equal(r.status, 200); c.push(cookieUr(r)); NU += 16 * 60 * 1000; }
  mejl.length = 0; await f(e, "/pro/konto/kod", { method: "POST", body: { epost: AGARE } }); const kod = kodUr(mejl[0]);
  const r4 = await f(e, "/pro/konto/logga-in", { method: "POST", body: { epost: AGARE, kod, namn: "Fjärde" } });
  assert.equal(r4.status, 409); const j4 = await r4.json();
  assert.equal(j4.status, "enhetsgrans"); assert.equal(j4.max, 3); assert.equal(r4.headers.get("set-cookie"), null);
  assert.deepEqual(j4.enheter.map((x) => x.namn).sort(), ["Dator", "Mobil", "Platta"]);
  for (const x of j4.enheter) { assert.match(x.id, /^e_[0-9a-f]{16}$/); assert.ok(Number.isInteger(x.senast)); assert.deepEqual(Object.keys(x).sort(), ["id", "namn", "senast"]); }
  const mobil = j4.enheter.find((x) => x.namn === "Mobil").id;
  // fel kod räcker inte för att logga ut någon annans enhet
  assert.equal((await f(e, `/pro/konto/enheter/${mobil}/logga-ut`, { method: "POST", body: { epost: AGARE, kod: kod === "000000" ? "111111" : "000000" } })).status, 401);
  const u = await f(e, `/pro/konto/enheter/${mobil}/logga-ut`, { method: "POST", body: { epost: AGARE, kod } });
  assert.equal(u.status, 200); assert.equal((await u.json()).status, "utloggad");
  const r5 = await f(e, "/pro/konto/logga-in", { method: "POST", body: { epost: AGARE, kod, namn: "Fjärde" } });
  assert.equal(r5.status, 200, "klienten försöker igen med samma kod");
  assert.equal((await f(e, "/pro/konto/jag", { cookie: c[0] })).status, 401, "mobilen är utloggad");
  assert.equal((await f(e, "/pro/konto/jag", { cookie: c[1] })).status, 200);
  // utloggning med session (återkallelse av en enskild enhet) och av denna enhet
  const lista = (await (await f(e, "/pro/konto/jag", { cookie: c[1] })).json()).enheter;
  const platta = lista.find((x) => x.namn === "Platta").id;
  assert.equal((await f(e, `/pro/konto/enheter/${platta}/logga-ut`, { method: "POST", body: {}, cookie: c[1] })).status, 200);
  assert.equal((await f(e, "/pro/konto/jag", { cookie: c[2] })).status, 401);
  const ut = await f(e, "/pro/konto/logga-ut", { method: "POST", body: {}, cookie: c[1] });
  assert.equal(ut.status, 200); assert.match(ut.headers.get("set-cookie"), /^__Host-mrpro=; Path=\/; Max-Age=0; Secure; HttpOnly; SameSite=Lax$/);
  assert.equal((await f(e, "/pro/konto/jag", { cookie: c[1] })).status, 401);
});

test("enhets-id från ett annat konto kan inte loggas ut (404), kontoId tas aldrig ur klientdata", async () => {
  const e = kEnv(), T = "t2@example.se", nu = Math.floor(NU / 1000);
  await register(e, "testbevis", { nu, ehash: await epostHash(e, T), slut: nu + 86400 * 30 });
  const a = cookieUr(await loggaIn(e)); NU += 16 * 60 * 1000; const b = cookieUr(await loggaIn(e, T));
  const bId = (await (await f(e, "/pro/konto/jag", { cookie: b })).json()).enheter[0].id;
  const aKonto = (await (await f(e, "/pro/konto/jag", { cookie: a })).json()).konto;
  const r = await f(e, `/pro/konto/enheter/${bId}/logga-ut`, { method: "POST", body: { kontoId: aKonto }, cookie: a });
  assert.equal(r.status, 404); assert.equal((await f(e, "/pro/konto/jag", { cookie: b })).status, 200);
});

test("90 d utan aktivitet nekas; aktivitet förlänger (högst en skrivning per timme, ny Set-Cookie då)", async () => {
  const e = kEnv(); const c = cookieUr(await loggaIn(e));
  const kontoDb = () => [...e.PRO_KONTON.inst.values()][0].storage.sql.exec("SELECT senast FROM enheter").toArray()[0].senast;
  const t0 = kontoDb();
  NU += 30 * 60 * 1000; let r = await f(e, "/pro/konto/jag", { cookie: c }); assert.equal(r.status, 200); assert.equal(kontoDb(), t0, "ingen skrivning inom timmen"); assert.equal(r.headers.get("set-cookie"), null);
  NU += 31 * 60 * 1000; r = await f(e, "/pro/konto/jag", { cookie: c }); assert.equal(r.status, 200); assert.equal(kontoDb(), Math.floor(NU / 1000)); assert.match(r.headers.get("set-cookie"), /Max-Age=7776000/);
  NU += (SESSION_S - 10) * 1000; assert.equal((await f(e, "/pro/konto/jag", { cookie: c })).status, 200, "aktivitet förlängde");
  NU += SESSION_S * 1000; assert.equal((await f(e, "/pro/konto/jag", { cookie: c })).status, 401, "90 d inaktivitet");
  // en inaktiv enhet räknas inte mot gränsen
  const r2 = await loggaIn(e); assert.equal(r2.status, 200);
});

test("rätt: ägare via PRO_OWNER_EMAIL; utan ägaradress ingen ägarroll; i PRO_PAYMENTS off görs inga Stripe-anrop", async () => {
  const e = kEnv(); const c = cookieUr(await loggaIn(e));
  const kontoId = (await (await f(e, "/pro/konto/jag", { cookie: c })).json()).konto;
  await register(e, "koppla", { nu: 1, kontoId, kund: "cus_TEST123456" });
  e.PRO_OWNER_EMAIL = "";
  const j = await (await f(e, "/pro/konto/jag", { cookie: c })).json();
  assert.equal(j.roll, "ingen"); assert.ok(natAnrop.every((u) => u === "https://api.resend.com/emails"), "inga Stripe-anrop i off");
});

test("rätt: kopplad kund med aktiv PRO-prenumeration ger roll pren när PRO_PAYMENTS inte är off", async () => {
  const e = kEnv({ PRO_OWNER_EMAIL: "annan@stahledigital.se" }), T = "p@example.se", nu = Math.floor(NU / 1000);
  await register(e, "testbevis", { nu, ehash: await epostHash(e, T), slut: nu + 60 });
  const c = cookieUr(await loggaIn(e, T)); NU += 120 * 1000;
  const kontoId = (await (await f(e, "/pro/konto/jag", { cookie: c })).json()).konto;
  await register(e, "koppla", { nu, kontoId, kund: "cus_TEST123456" });
  e.PRO_PAYMENTS = "test";
  globalThis.fetch = async (url) => { natAnrop.push(String(url)); if (String(url).startsWith("https://api.stripe.com/v1/subscriptions?customer=cus_TEST123456")) return new Response(JSON.stringify({ data: [{ id: "sub_1", status: "active", metadata: { pro: "pro-v1" }, current_period_end: nu + 999 }] })); throw new Error("nät " + url); };
  const j = await (await f(e, "/pro/konto/jag", { cookie: c })).json();
  assert.equal(j.roll, "pren"); assert.equal(j.ratt_slut, nu + 999);
});

test("fel i registret/bindning saknas: kod svarar ändå 202; logga-in 503 konfiguration; inget läcker", async () => {
  const e = kEnv(); delete e.PRO_REGISTER;
  assert.equal((await f(e, "/pro/konto/kod", { method: "POST", body: { epost: AGARE } })).status, 202); assert.equal(mejl.length, 0);
  const r = await f(e, "/pro/konto/logga-in", { method: "POST", body: { epost: AGARE, kod: "123456" } });
  assert.equal(r.status, 503); assert.deepEqual(await r.json(), { status: "konfiguration" });
  const e2 = kEnv({ STRIPE_WEBHOOK_SECRET: "", STRIPE_TEST_WEBHOOK_SECRET: "" });
  assert.equal((await f(e2, "/pro/konto/kod", { method: "POST", body: { epost: AGARE } })).status, 202); assert.equal(mejl.length, 0);
});

// ---------- registrets egna invarianter ----------
test("ProRegister: en operation är atomisk (fel mitt i rullar tillbaka allt)", async () => {
  const e = kEnv(); const stub = e.PRO_REGISTER.get(e.PRO_REGISTER.idFromName("register:v1"));
  const inst = e.PRO_REGISTER.inst.get("register:v1"); const orig = inst.inbjuden.bind(inst);
  inst.inbjuden = () => { throw new Error("injicerat"); };
  const nu = Math.floor(NU / 1000), ehash = "a".repeat(64), ip = "b".repeat(32);
  const r = await stub.fetch("https://pro-register/kod", { method: "POST", body: JSON.stringify({ nu, ehash, ip, agare: true, kodId: "c".repeat(32), hash: "d".repeat(64), dagstak: 5 }) });
  assert.equal(r.status, 500);
  assert.deepEqual(inst.storage.sql.exec("SELECT * FROM grans").toArray(), [], "ip-räknaren rullades tillbaka");
  inst.inbjuden = orig;
  const r2 = await (await stub.fetch("https://pro-register/kod", { method: "POST", body: JSON.stringify({ nu, ehash, ip, agare: true, kodId: "c".repeat(32), hash: "d".repeat(64), dagstak: 5 }) })).json();
  assert.equal(r2.skicka, true);
  for (const bad of [{}, { nu: -1 }, { nu: 1.5 }]) assert.equal((await stub.fetch("https://pro-register/kod", { method: "POST", body: JSON.stringify(bad) })).status, 400);
  assert.equal((await stub.fetch("https://pro-register/okand", { method: "POST", body: "{}" })).status, 404);
});

test("prenumerationens login-nonce ligger i registret: atomisk inlösen, exakt en vinnare, utgång, fel kund", async () => {
  const e = kEnv(), nu = Math.floor(NU / 1000), n = "N".repeat(24);
  assert.deepEqual(await register(e, "nonce_spara", { nu, n, kund: "cus_AAAAAAAA", ttl: 960 }), { ok: true });
  assert.deepEqual(await register(e, "nonce_los", { nu, n, kund: "cus_BBBBBBBB" }), { ok: false }, "fel kund");
  const par = await Promise.all([1, 2, 3].map(() => register(e, "nonce_los", { nu, n, kund: "cus_AAAAAAAA" })));
  assert.equal(par.filter((x) => x.ok).length, 1);
  await register(e, "nonce_spara", { nu, n: "M".repeat(24), kund: "cus_AAAAAAAA", ttl: 960 });
  assert.deepEqual(await register(e, "nonce_los", { nu: nu + 960, n: "M".repeat(24), kund: "cus_AAAAAAAA" }), { ok: false }, "utgången");
  assert.deepEqual(e.REVIEWS_KV.m.size, 0);
});

test("okänd rutt och fel metod under /pro/konto i inbjudna: 404; OPTIONS 403 (ingen CORS)", async () => {
  const e = kEnv();
  assert.equal((await f(e, "/pro/konto/x")).status, 404);
  assert.equal((await f(e, "/pro/konto/jag", { method: "POST", body: {} })).status, 404);
  assert.equal((await f(e, "/pro/konto/kod", { method: "OPTIONS" })).status, 403);
});
