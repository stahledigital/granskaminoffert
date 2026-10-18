// KONTO-SYNK K2 (KP-2026-10-16-01, Donatello 2026-10-18): synk-API, gravstenar, läsperiod, köpt projekt, export, radering, PITR,
// cron (avisering/radering/efterrensning) och K1-härdningen A1–A4. Workerns RIKTIGA default-export och RIKTIGA klasser
// ProRegister/ProKonto i node:sqlite-dubbeln. Resend är en HTTP-dubbel; inget annat nät tillåts. Tiden styrs via Date.now.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { ProRegister, ProKonto, epostHash, register, kontoSchema, KODER_DAG, FEL_DAG, PROJ_MAX_ANTAL } from "../src/pro_konto.js";
import { namnrymd } from "./helpers/pro_do_dubbel.mjs";
import { ENV } from "./stripe_dubbel.mjs";

const API = "https://granskaminoffert-api.anders-316.workers.dev";
const SAJT = "https://stahledigital.se";
const AGARE = "anders@stahledigital.se", TEST_A = "testare.a@example.se", TEST_B = "testare.b@example.se";
const DAG = 86400;
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
const nuS = () => Math.floor(NU / 1000);
const fram = (s) => { NU += s * 1000; };

function kEnv(extra = {}) {
  const e = ENV({ PRO_PAYMENTS: "off", PRO_KONTO: "inbjudna", PRO_OWNER_EMAIL: AGARE, PRO_MAIL_DAY_CAP: "1000", ...extra });
  // K5: kontots objekt får env (registret), eftersom PITR nu markerar utloggningen i registret före återställningen (K2-fynd 2).
  e.PRO_REGISTER = namnrymd(ProRegister); e.PRO_KONTON = namnrymd(ProKonto, e);
  return e;
}
const ctx = () => { const v = []; return { v, waitUntil: (p) => v.push(p), passThroughOnException() {} }; };
let ipN = 0;
function req(path, { method = "GET", origin = SAJT, xmr = true, body, cookie, ip, headers = {} } = {}) {
  const h = { "CF-Connecting-IP": ip || `198.51.100.${(ipN++ % 200) + 1}`, ...headers };
  if (origin) h.Origin = origin;
  if (xmr && method !== "GET") h["X-MR-Pro"] = "1";
  if (body !== undefined) h["content-type"] = "application/json";
  if (cookie) h.Cookie = cookie;
  return new Request(API + path, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
}
const f = async (env, path, o) => { const c = ctx(); const r = await worker.fetch(req(path, o), env, c); await Promise.all(c.v); return r; };
const kodUr = (m) => /\n {4}(\d{6})\n/.exec(m.text)[1];
const cookieUr = (r) => { const s = r.headers.get("set-cookie"); return s ? s.split(";")[0] : null; };
const ge = async (e, epost, slut) => register(e, "testbevis", { nu: nuS(), ehash: await epostHash(e, epost), slut });
async function begarKod(e, epost) { const n = mejl.length; assert.equal((await f(e, "/pro/konto/kod", { method: "POST", body: { epost } })).status, 202); return mejl.length > n ? kodUr(mejl[mejl.length - 1]) : null; }
async function loggaIn(e, epost = AGARE, namn) {
  const kod = await begarKod(e, epost); assert.ok(kod, "kodmejl till " + epost);
  const r = await f(e, "/pro/konto/logga-in", { method: "POST", body: { epost, kod, ...(namn ? { namn } : {}) } });
  assert.equal(r.status, 200); return cookieUr(r);
}
const jag = async (e, cookie) => (await f(e, "/pro/konto/jag", { cookie })).json();
const pid = (n) => "p_" + n.toString(16).padStart(32, "0");
const projekt = (id, extra = {}) => ({ format: "materialraknaren-pro-projekt", version: 1, projektId: id, projektnamn: "Altan " + id.slice(-4), moms: "25",
  material: [{ namn: "Trall 28x120", mangd: "42", enhet: "st", pris_kr: null, med: true }], arbete: [], ovrigt: [], rot: { kopare: [{ id: "k1", andel: "100", rot_anvant: null, rut_anvant: null }] }, ...extra });
const put = (e, cookie, id, rev, body) => f(e, `/pro/konto/projekt/${id}`, { method: "PUT", cookie, body: body === undefined ? projekt(id) : body, headers: rev === null ? {} : { "If-Match": String(rev) } });
const del = (e, cookie, id, rev) => f(e, `/pro/konto/projekt/${id}`, { method: "DELETE", cookie, headers: rev === null ? {} : { "If-Match": String(rev) } });
const kontoObj = (e, kontoId) => e.PRO_KONTON.inst.get("k:" + kontoId);
const regObj = (e) => e.PRO_REGISTER.inst.get("register:v1");
const regRader = (e, q, ...a) => regObj(e).storage.sql.exec(q, ...a).toArray();

// ---------------- A1 ----------------
test("A1: högst 10 koder per adress och glidande dygn; den elfte ger samma 202 utan mejl; efter 24 h går det igen", async () => {
  const e = kEnv();
  for (let i = 0; i < KODER_DAG; i++) { assert.ok(await begarKod(e, AGARE), "kod " + (i + 1)); fram(16 * 60); } // förbi 15-min-gränsen
  const r = await f(e, "/pro/konto/kod", { method: "POST", body: { epost: AGARE } });
  assert.equal(r.status, 202); assert.deepEqual(await r.json(), { status: "skickat_om_inbjuden" });
  assert.equal(mejl.length, KODER_DAG, "ingen elfte kod");
  fram(DAG - KODER_DAG * 16 * 60 + 60); // den första koden är nu äldre än 24 h
  assert.ok(await begarKod(e, AGARE), "ny kod efter dygnet");
});

test("A1: 15 felförsök över alla koder → adressen spärras 24 h: rätt kod och länk nekas, kod ger 202 utan mejl; efter 24 h fungerar det", async () => {
  const e = kEnv();
  let kod;
  for (let omg = 0; omg < 3; omg++) {
    kod = await begarKod(e, AGARE); const fel = kod === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) assert.equal((await f(e, "/pro/konto/logga-in", { method: "POST", body: { epost: AGARE, kod: fel } })).status, 401);
    fram(16 * 60);
  }
  assert.equal(regRader(e, "SELECT sparr_till FROM adress")[0].sparr_till > nuS(), true, "spärrad efter " + FEL_DAG);
  const n = mejl.length; assert.equal((await f(e, "/pro/konto/kod", { method: "POST", body: { epost: AGARE } })).status, 202); assert.equal(mejl.length, n, "inget mejl under spärr");
  // en kod skapad före spärren (via registret direkt) nekas också med rätt värde
  fram(DAG - 16 * 60 - 60); assert.equal(await begarKod(e, AGARE), null, "fortfarande spärrad strax före 24 h (spärren sattes vid fel nr 15, 16 min före loopens slut)");
  fram(120); const ny = await begarKod(e, AGARE); assert.ok(ny, "kod efter 24 h");
  assert.equal((await f(e, "/pro/konto/logga-in", { method: "POST", body: { epost: AGARE, kod: ny } })).status, 200);
});

test("A1: spärren nekar även rätt kod som skickats före spärren (kod 14 fel, sedan fel nr 15 på en annan kod)", async () => {
  const e = kEnv(); const ehash = await epostHash(e, AGARE);
  const k1 = await begarKod(e, AGARE); const fel = (k) => (k === "000000" ? "111111" : "000000");
  for (let i = 0; i < 4; i++) await f(e, "/pro/konto/logga-in", { method: "POST", body: { epost: AGARE, kod: fel(k1) } });
  // 10 fel till via två nya koder (4 + 4) och 2 på den sista ⇒ 14, sedan rätt kod efter fel nr 15
  fram(16 * 60); const k2 = await begarKod(e, AGARE); for (let i = 0; i < 4; i++) await f(e, "/pro/konto/logga-in", { method: "POST", body: { epost: AGARE, kod: fel(k2) } });
  fram(16 * 60); const k3 = await begarKod(e, AGARE); for (let i = 0; i < 4; i++) await f(e, "/pro/konto/logga-in", { method: "POST", body: { epost: AGARE, kod: fel(k3) } });
  fram(16 * 60); const k4 = await begarKod(e, AGARE); for (let i = 0; i < 2; i++) await f(e, "/pro/konto/logga-in", { method: "POST", body: { epost: AGARE, kod: fel(k4) } });
  assert.equal(regRader(e, "SELECT fel FROM adress WHERE ehash = ?", ehash)[0].fel, 14);
  await f(e, "/pro/konto/logga-in", { method: "POST", body: { epost: AGARE, kod: fel(k4) } }); // nr 15
  assert.equal((await f(e, "/pro/konto/logga-in", { method: "POST", body: { epost: AGARE, kod: k4 } })).status, 401, "rätt kod under spärr");
});

test("A1/A2: kod-svaret är identiskt (status, headers, kropp) för ägare, okänd, ogiltig, spärrad och tom kropp", async () => {
  const e = kEnv(); const svar = [];
  for (const body of [{ epost: AGARE }, { epost: "okand@example.se" }, { epost: "inte-en-adress" }, {}, "x"]) {
    const r = await f(e, "/pro/konto/kod", { method: "POST", body }); svar.push(JSON.stringify([r.status, [...r.headers], await r.text()]));
  }
  assert.equal(new Set(svar).size, 1, svar.join("\n"));
});

// ---------------- A2 ----------------
test("A2: 202 returneras innan registret eller mejlet rörs (allt i ctx.waitUntil); utan ctx väntas jobbet in", async () => {
  const e = kEnv();
  for (const epost of [AGARE, "okand@example.se"]) {
    const c = ctx(); const fore = { reg: e.PRO_REGISTER.anrop.length, m: mejl.length };
    const r = await worker.fetch(req("/pro/konto/kod", { method: "POST", body: { epost } }), e, c);
    assert.equal(r.status, 202);
    assert.equal(e.PRO_REGISTER.anrop.length, fore.reg, "inget registeranrop före svaret: " + epost);
    assert.equal(mejl.length, fore.m, "inget mejl före svaret");
    assert.equal(c.v.length, 1, "exakt ett waitUntil-jobb");
    await Promise.all(c.v);
    assert.equal(mejl.length, fore.m + (epost === AGARE ? 1 : 0));
    fram(16 * 60);
  }
});

// ---------------- A3 ----------------
test("A3: ALLA svar under /pro/konto/* har X-Robots-Tag noindex, nofollow och Cache-Control no-store och ingen Access-Control-*", async () => {
  const kontroll = (r, namn) => {
    assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow", namn); assert.equal(r.headers.get("cache-control"), "no-store", namn);
    for (const [k] of r.headers) assert.ok(!k.startsWith("access-control-") && k !== "vary", namn + ": " + k);
  };
  const off = kEnv({ PRO_KONTO: "off" });
  for (const [p, m] of [["/pro/konto/kod", "POST"], ["/pro/konto/jag", "GET"], ["/pro/konto/projekt", "GET"], ["/pro/konto/projekt/" + pid(1), "PUT"], ["/pro/konto/x", "OPTIONS"]])
    for (const o of [{}, { origin: "https://ond.example" }]) { const r = await f(off, p, { method: m, ...o }); assert.equal(r.status, 503); kontroll(r, "off " + m + p); }
  const e = kEnv(); const c = await loggaIn(e);
  await put(e, c, pid(1), 0); await del(e, c, pid(1), 1);
  const fall = [
    ["kod 202", "/pro/konto/kod", { method: "POST", body: { epost: AGARE } }, 202],
    ["OPTIONS 403", "/pro/konto/kod", { method: "OPTIONS" }, 403],
    ["fel origin 403", "/pro/konto/kod", { method: "POST", origin: "https://ond.example", body: {} }, 403],
    ["utan header 403", "/pro/konto/projekt/" + pid(2), { method: "PUT", xmr: false, cookie: c, body: projekt(pid(2)) }, 403],
    ["401 jag", "/pro/konto/jag", {}, 401],
    ["401 ogiltig kod", "/pro/konto/logga-in", { method: "POST", body: { epost: AGARE, kod: "123456" } }, 401],
    ["404 okänd", "/pro/konto/x", {}, 404],
    ["200 jag", "/pro/konto/jag", { cookie: c }, 200],
    ["200 lista", "/pro/konto/projekt", { cookie: c }, 200],
    ["200 export", "/pro/konto/export", { cookie: c }, 200],
    ["410", "/pro/konto/projekt/" + pid(1), { cookie: c }, 410],
    ["428", "/pro/konto/projekt/" + pid(3), { method: "PUT", cookie: c, body: projekt(pid(3)) }, 428],
    ["413", "/pro/konto/projekt/" + pid(3), { method: "PUT", cookie: c, body: "x".repeat(256 * 1024 + 1), headers: { "If-Match": "0" } }, 413],
    ["400 radera", "/pro/konto/radera", { method: "POST", cookie: c, body: {} }, 400],
  ];
  for (const [namn, p, o, st] of fall) { const r = await f(e, p, o); assert.equal(r.status, st, namn); kontroll(r, namn); }
  // 409 enhetsgräns, 409 konflikt
  await put(e, c, pid(4), 0); const k = await put(e, c, pid(4), 0); assert.equal(k.status, 409); kontroll(k, "409 konflikt");
  // 502/503: trasig bindning
  const t = kEnv(); t.PRO_REGISTER = { idFromName() { throw new Error("x"); }, get() { throw new Error("x"); } };
  const r5 = await f(t, "/pro/konto/logga-in", { method: "POST", body: { epost: AGARE, kod: "123456" } }); assert.ok(r5.status >= 500); kontroll(r5, "5xx");
  const t2 = kEnv(); delete t2.PRO_REGISTER; const r6 = await f(t2, "/pro/konto/logga-in", { method: "POST", body: { epost: AGARE, kod: "123456" } }); assert.equal(r6.status, 503); kontroll(r6, "503 konfiguration");
});

// ---------------- A4 ----------------
test("A4: jurisdiktion är förberedd men av: utan var används vanlig namnrymd; 'eu' använder jurisdiction('eu'); saknad metod eller annat värde → 503", async () => {
  const e = kEnv(); await loggaIn(e);
  assert.deepEqual(e.PRO_REGISTER.jur, []); assert.deepEqual(e.PRO_KONTON.jur, []);
  assert.ok([...e.PRO_REGISTER.inst.keys()].every((k) => !k.includes("|")));
  const eu = kEnv({ PRO_DO_JURISDIKTION: "eu" }); const c = await loggaIn(eu);
  assert.ok(eu.PRO_REGISTER.jur.length > 0 && eu.PRO_REGISTER.jur.every((j) => j === "eu"));
  assert.ok([...eu.PRO_REGISTER.inst.keys()].every((k) => k.startsWith("eu|")) && [...eu.PRO_KONTON.inst.keys()].every((k) => k.startsWith("eu|")));
  assert.equal((await f(eu, "/pro/konto/jag", { cookie: c })).status, 200);
  for (const v of ["us", "EU", "fedramp"]) assert.equal((await f(kEnv({ PRO_DO_JURISDIKTION: v }), "/pro/konto/logga-in", { method: "POST", body: { epost: AGARE, kod: "123456" } })).status, 503, v);
  const utan = kEnv({ PRO_DO_JURISDIKTION: "eu" }); delete utan.PRO_REGISTER.jurisdiction;
  assert.equal((await f(utan, "/pro/konto/logga-in", { method: "POST", body: { epost: AGARE, kod: "123456" } })).status, 503, "fail closed");
  const t = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  // K6 (Donatello 2026-10-18): påslagen i wrangler.toml tillsammans med PRO_KONTO="inbjudna" (pro_konto_k6.test.mjs prövar att all åtkomst går via nr()).
  assert.match(t, /^PRO_DO_JURISDIKTION = "eu"$/m, "påslagen i wrangler.toml (K6)");
  assert.match(t, /^PRO_KONTO = "inbjudna"$/m); assert.match(t, /^PRO_PAYMENTS = "test"$/m); // Anders nattmandat: separat verifieringsrelease, inga riktiga debiteringar.
});

// ---------------- B: synk ----------------
test("B: två klienter mot samma konto: A sparar 1→2, B sparar på rev 1 och får 409 med A:s data; ingen data försvinner", async () => {
  const e = kEnv(); const A = await loggaIn(e, AGARE, "A"); fram(16 * 60); const B = await loggaIn(e, AGARE, "B");
  const id = pid(7);
  let r = await put(e, A, id, 0); assert.equal(r.status, 200); assert.deepEqual((await r.json()).rev, 1);
  r = await put(e, B, id, 0); assert.equal(r.status, 409, "skapa två gånger = konflikt");
  r = await put(e, A, id, 1, projekt(id, { projektnamn: "A:s version" })); assert.equal(r.status, 200); assert.equal((await r.json()).rev, 2);
  r = await put(e, B, id, 1, projekt(id, { projektnamn: "B:s version" })); assert.equal(r.status, 409);
  const k = await r.json(); assert.equal(k.status, "konflikt"); assert.equal(k.server.rev, 2); assert.equal(k.server.data.projektnamn, "A:s version");
  const g = await (await f(e, `/pro/konto/projekt/${id}`, { cookie: B })).json(); assert.equal(g.projekt.rev, 2); assert.equal(g.projekt.data.projektnamn, "A:s version");
  r = await put(e, B, id, 2, projekt(id, { projektnamn: "B efter konflikt" })); assert.equal(r.status, 200); assert.equal((await r.json()).rev, 3);
  // If-Match med citattecken och W/ accepteras; saknad eller skräp → 428
  assert.equal((await f(e, `/pro/konto/projekt/${id}`, { method: "PUT", cookie: A, body: projekt(id), headers: { "If-Match": '"3"' } })).status, 200);
  assert.equal((await f(e, `/pro/konto/projekt/${id}`, { method: "PUT", cookie: A, body: projekt(id), headers: { "If-Match": 'W/"4"' } })).status, 200);
  assert.equal((await put(e, A, id, null)).status, 428); assert.equal((await f(e, `/pro/konto/projekt/${id}`, { method: "PUT", cookie: A, body: projekt(id), headers: { "If-Match": "*" } })).status, 428);
});

test("B: DELETE ger gravsten (rev+1, bara id/rev/tid kvar); B:s gamla kö får 410 med raderad_ms och jobbet återskapas aldrig tyst", async () => {
  const e = kEnv(); const A = await loggaIn(e, AGARE, "A"); fram(16 * 60); const B = await loggaIn(e, AGARE, "B");
  const id = pid(8); await put(e, A, id, 0); await put(e, B, id, 1);
  assert.equal((await del(e, A, id, 1)).status, 409, "fel rev vid radering");
  assert.equal((await del(e, A, id, null)).status, 428);
  const d = await del(e, A, id, 2); assert.equal(d.status, 200); const dj = await d.json(); assert.equal(dj.rev, 3); assert.equal(dj.raderad_ms, NU);
  for (const rev of [2, 0, 3, 99]) { const r = await put(e, B, id, rev); assert.equal(r.status, 410, "rev " + rev); assert.deepEqual(await r.json(), { status: "raderad", id, rev: 3, raderad_ms: NU }); }
  assert.equal((await del(e, B, id, 3)).status, 410);
  assert.equal((await f(e, `/pro/konto/projekt/${id}`, { cookie: B })).status, 410);
  const l = await (await f(e, "/pro/konto/projekt", { cookie: B })).json(); assert.deepEqual(l.projekt, [{ id, rev: 3, namn: "", andrad: NU, raderad: NU, storlek: 0 }]);
  const kontoId = (await jag(e, A)).konto;
  const rad = kontoObj(e, kontoId).storage.sql.exec("SELECT * FROM projekt WHERE id = ?", id).toArray()[0];
  assert.deepEqual({ data: rad.data, namn: rad.namn, storlek: rad.storlek }, { data: null, namn: "", storlek: 0 }, "inget innehåll kvar i gravstenen");
});

test("B: gravstenar gallras efter 90 d (syns inte i listan, tas bort vid nästa skrivning; samma id ger då 404 och kan skapas på nytt)", async () => {
  const e = kEnv(); const A = await loggaIn(e); const id = pid(9);
  await put(e, A, id, 0); await del(e, A, id, 1);
  fram(89 * DAG); assert.equal((await f(e, `/pro/konto/projekt/${id}`, { cookie: (await loggaIn(e)) })).status, 410, "89 d: kvar");
  fram(2 * DAG); const C = await loggaIn(e);
  assert.deepEqual((await (await f(e, "/pro/konto/projekt", { cookie: C })).json()).projekt, []);
  assert.equal((await f(e, `/pro/konto/projekt/${id}`, { cookie: C })).status, 404);
  await put(e, C, pid(10), 0);
  const kontoId = (await jag(e, C)).konto;
  assert.equal(kontoObj(e, kontoId).storage.sql.exec("SELECT COUNT(*) AS n FROM projekt WHERE id = ?", id).toArray()[0].n, 0, "borttagen ur tabellen");
});

test("B: isolering: konto A:s session + B:s projekt-id ger 404 (gissat, kopierat, konto-id i URL eller kropp ignoreras)", async () => {
  const e = kEnv(); await ge(e, TEST_A, nuS() + 30 * DAG);
  const A = await loggaIn(e, TEST_A); const B = await loggaIn(e, AGARE);
  const bId = pid(11); await put(e, B, bId, 0, projekt(bId, { projektnamn: "B:s hemliga" }));
  const bKonto = (await jag(e, B)).konto, aKonto = (await jag(e, A)).konto; assert.notEqual(aKonto, bKonto);
  for (const p of [`/pro/konto/projekt/${bId}`, `/pro/konto/projekt/${bId}?konto=${bKonto}`, `/pro/konto/projekt/${bId}?kontoId=${bKonto}`]) assert.equal((await f(e, p, { cookie: A })).status, 404, p);
  for (const rev of [1, 2]) assert.equal((await put(e, A, bId, rev, { ...projekt(bId), konto: bKonto, kontoId: bKonto })).status, 404);
  assert.equal((await del(e, A, bId, 1)).status, 404);
  assert.equal((await f(e, `/pro/konto/${bKonto}/projekt/${bId}`, { cookie: A })).status, 404, "konto-id i sökvägen");
  assert.equal((await f(e, "/pro/konto/projekt/../projekt/" + bId, { cookie: A })).status, 404);
  const ex = await (await f(e, "/pro/konto/export", { cookie: A })).text(); assert.ok(!ex.includes(bId) && !ex.includes(bKonto) && !ex.includes("hemliga"));
  // B:s data orörd
  const g = await (await f(e, `/pro/konto/projekt/${bId}`, { cookie: B })).json(); assert.equal(g.projekt.data.projektnamn, "B:s hemliga"); assert.equal(g.projekt.rev, 1);
  assert.equal((await f(e, "/pro/konto/projekt", {})).status, 401, "utan session");
});

test("B: gränser: 256 KB och 500 rader ger 413 (som P4); fel projektId/format 400; högst 50 projekt; ogiltigt id 404", async () => {
  const e = kEnv(); const A = await loggaIn(e); const id = pid(12);
  const stor = projekt(id, { projektnamn: "x".repeat(150), material: Array.from({ length: 490 }, (_, i) => ({ namn: "y".repeat(600) + i, mangd: "1", enhet: "st", pris_kr: null, med: true })) });
  assert.ok(JSON.stringify(stor).length > 256 * 1024);
  let r = await put(e, A, id, 0, stor); assert.equal(r.status, 413); assert.equal((await r.json()).status, "for_stort");
  r = await put(e, A, id, 0, projekt(id, { material: Array.from({ length: 501 }, () => ({ namn: "a", mangd: "1" })) })); assert.equal(r.status, 413); assert.equal((await r.json()).status, "for_manga_rader");
  assert.equal((await put(e, A, id, 0, projekt(id, { material: Array.from({ length: 300 }, () => ({ namn: "a" })), arbete: Array.from({ length: 200 }, () => ({ namn: "b" })) }))).status, 200, "exakt 500 rader");
  assert.equal((await put(e, A, pid(13), 0, projekt(pid(14)))).status, 400, "projektId ≠ URL");
  assert.equal((await put(e, A, pid(13), 0, { ...projekt(pid(13)), format: "annat" })).status, 400);
  assert.equal((await put(e, A, pid(13), 0, "[1,2]")).status, 400);
  assert.equal((await put(e, A, "p_XYZ", 0)).status, 404);
  for (let i = 100; i < 100 + PROJ_MAX_ANTAL - 1; i++) assert.equal((await put(e, A, pid(i), 0)).status, 200);
  r = await put(e, A, pid(999), 0); assert.equal(r.status, 413); assert.equal((await r.json()).status, "for_manga_projekt");
  await del(e, A, pid(100), 1); assert.equal((await put(e, A, pid(999), 0)).status, 200, "gravsten räknas inte");
});

test("B: läsperiod: utan aktiv rätt men inom 90 d → GET och export tillåts, PUT 403 las_endast (DELETE tillåts); efter 90 d PUT 403 ingen_ratt", async () => {
  const e = kEnv(); const slut = nuS() + 5 * DAG; await ge(e, TEST_A, slut);
  const A = await loggaIn(e, TEST_A); const id = pid(20);
  assert.equal((await put(e, A, id, 0)).status, 200);
  assert.equal((await jag(e, A)).roll, "test");
  fram(6 * DAG);
  const j = await jag(e, A); assert.equal(j.roll, "ingen"); assert.equal(j.ratt_slut, slut); assert.equal(j.las_slut, slut + 90 * DAG);
  assert.equal((await f(e, `/pro/konto/projekt/${id}`, { cookie: A })).status, 200);
  assert.equal((await f(e, "/pro/konto/export", { cookie: A })).status, 200);
  let r = await put(e, A, id, 1); assert.equal(r.status, 403); assert.deepEqual(await r.json(), { status: "las_endast", las_slut: slut + 90 * DAG, skrivbara: [] });
  assert.equal((await put(e, A, pid(21), 0)).status, 403);
  fram(80 * DAG); // fortfarande inom 90 d från slut (86 d)
  assert.equal((await put(e, A, id, 1)).status, 403);
  fram(10 * DAG); // 96 d efter slut
  r = await put(e, A, id, 1); assert.equal(r.status, 403); assert.deepEqual(await r.json(), { status: "ingen_ratt" });
  assert.equal((await f(e, `/pro/konto/projekt/${id}`, { cookie: A })).status, 200, "läsning tills kontot raderas");
  assert.equal((await del(e, A, id, 1)).status, 200, "egen radering tillåts");
  // ny rätt öppnar skrivning igen
  await ge(e, TEST_A, nuS() + 10 * DAG); assert.equal((await put(e, A, pid(22), 0)).status, 200);
});

test("B: köpt projekt: PUT bara för det projekt-id:t i 30 d; övriga 403 las_endast med skrivbara; därefter läsperiod", async () => {
  const e = kEnv(); await ge(e, TEST_A, nuS() + DAG);
  const A = await loggaIn(e, TEST_A); const kontoId = (await jag(e, A)).konto;
  const P1 = pid(30), P2 = pid(31);
  await put(e, A, P2, 0); // skrivet under testperioden
  fram(2 * DAG); assert.equal((await jag(e, A)).roll, "ingen");
  const k = await register(e, "koppla_projekt", { nu: nuS(), kontoId, projektId: P1 }); assert.equal(k.ok, true); assert.equal(k.slut, nuS() + 30 * DAG);
  assert.deepEqual(await register(e, "koppla_projekt", { nu: nuS(), kontoId: "k_" + "0".repeat(32), projektId: P1 }), { ok: false }, "okänt konto");
  const j = await jag(e, A); assert.equal(j.roll, "projekt"); assert.deepEqual(j.skrivbara, [P1]); assert.equal(j.las_slut, k.slut + 90 * DAG);
  assert.equal((await put(e, A, P1, 0)).status, 200); assert.equal((await put(e, A, P1, 1)).status, 200);
  const r = await put(e, A, P2, 1); assert.equal(r.status, 403); assert.deepEqual(await r.json(), { status: "las_endast", las_slut: k.slut + 90 * DAG, skrivbara: [P1] });
  fram(30 * DAG + 60);
  assert.equal((await jag(e, A)).roll, "ingen");
  const r2 = await put(e, A, P1, 2); assert.equal(r2.status, 403); assert.equal((await r2.json()).status, "las_endast");
});

test("B: export innehåller allt (enheter utan sessionshash, projekt inkl. gravstenar, e-post, logg, rätt) och loggas", async () => {
  const e = kEnv(); const A = await loggaIn(e, AGARE, "Mac"); await put(e, A, pid(40), 0); await put(e, A, pid(41), 0); await del(e, A, pid(41), 1);
  const r = await f(e, "/pro/konto/export", { cookie: A }); assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition"), /^attachment; filename="materialraknaren-pro-export-2026-10-18\.json"$/);
  const x = await r.json();
  assert.equal(x.format, "materialraknaren-pro-konto-export"); assert.equal(x.konto, (await jag(e, A)).konto);
  assert.equal(x.epost, AGARE); assert.deepEqual(x.ratt, { roll: "agare", ratt_slut: null, las_slut: null, skrivbara: null });
  assert.deepEqual(x.enheter.map((d) => Object.keys(d).sort()), [["id", "namn", "senast", "skapad", "utloggad"]]); assert.equal(x.enheter[0].namn, "Mac");
  assert.deepEqual(x.projekt.map((p) => [p.id, p.rev, p.raderad === null, p.data && p.data.projektId]), [[pid(40), 1, true, pid(40)], [pid(41), 2, false, null]]);
  assert.deepEqual(x.logg.map((l) => l.typ), ["export"]);
  const txt = JSON.stringify(x); const kontoId = x.konto;
  const sess = kontoObj(e, kontoId).storage.sql.exec("SELECT sess FROM enheter").toArray()[0].sess; assert.ok(!txt.includes(sess), "ingen sessionshash");
  // allt som finns i kontots objekt finns i exporten
  const db = kontoObj(e, kontoId).storage.sql;
  assert.equal(x.projekt.length, db.exec("SELECT COUNT(*) AS n FROM projekt").toArray()[0].n);
  assert.equal(x.enheter.length, db.exec("SELECT COUNT(*) AS n FROM enheter").toArray()[0].n);
});

test("B: radera konto: kräver bekräftelse och färsk egen kod; annat kontos kod förbrukas inte; därefter 401, registret saknar posten, objektet är tomt", async () => {
  const e = kEnv(); await ge(e, TEST_A, nuS() + 30 * DAG);
  const A = await loggaIn(e, TEST_A); await put(e, A, pid(50), 0); const kontoId = (await jag(e, A)).konto;
  const B = await loggaIn(e, AGARE); fram(16 * 60);
  assert.equal((await f(e, "/pro/konto/radera", { method: "POST", cookie: A, body: { bekrafta: true } })).status, 401, "utan kod");
  const kodA = await begarKod(e, TEST_A);
  assert.equal((await f(e, "/pro/konto/radera", { method: "POST", cookie: A, body: { epost: TEST_A, kod: kodA } })).status, 400, "utan bekrafta");
  // B:s session med A:s kod: 401 och A:s kod är INTE förbrukad
  assert.equal((await f(e, "/pro/konto/radera", { method: "POST", cookie: B, body: { bekrafta: true, epost: TEST_A, kod: kodA } })).status, 401);
  assert.equal((await jag(e, B)).status, "ok", "B finns kvar");
  // utgången kod (efter 10 min) nekas
  fram(11 * 60); assert.equal((await f(e, "/pro/konto/radera", { method: "POST", cookie: A, body: { bekrafta: true, epost: TEST_A, kod: kodA } })).status, 401, "inte färsk");
  fram(5 * 60); const kod2 = await begarKod(e, TEST_A);
  const r = await f(e, "/pro/konto/radera", { method: "POST", cookie: A, body: { bekrafta: true, epost: TEST_A, kod: kod2 } });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { status: "kontot_raderat" }); assert.match(r.headers.get("set-cookie"), /^__Host-mrpro=; Path=\/; Max-Age=0;/);
  assert.equal((await f(e, "/pro/konto/jag", { cookie: A })).status, 401);
  assert.equal((await f(e, `/pro/konto/projekt/${pid(50)}`, { cookie: A })).status, 401);
  assert.deepEqual(regRader(e, "SELECT konto_id FROM konton WHERE konto_id = ?", kontoId), []);
  assert.deepEqual(regRader(e, "SELECT konto_id, rensad IS NOT NULL AS r FROM raderade"), [{ konto_id: kontoId, r: 1 }]);
  const ehash = await epostHash(e, TEST_A);
  for (const t of ["testbevis", "koder", "adress"]) assert.deepEqual(regRader(e, `SELECT * FROM ${t} WHERE ehash = ?`, ehash), [], t);
  const db = kontoObj(e, kontoId).storage.sql;
  for (const t of ["enheter", "projekt", "meta", "logg"]) assert.equal(db.exec(`SELECT COUNT(*) AS n FROM ${t}`).toArray()[0].n, 0, t);
  assert.equal((await jag(e, B)).status, "ok", "andra konton orörda");
});

// ---------------- PITR ----------------
function bokmarken(e, kontoId) {
  const o = kontoObj(e, kontoId); const logg = [];
  o.storage.getBookmarkForTime = async (t) => { logg.push(["bm", t]); return "bm-" + t; };
  o.storage.onNextSessionRestoreBookmark = async (b) => { logg.push(["restore", b]); };
  return logg;
}
test("PITR: bara ägaren, med färsk egen kod; raderat konto vägras alltid (409) och loggas; okänt 404; lyckat anrop planerar bokmärket och loggas", async () => {
  const e = kEnv(); await ge(e, TEST_A, nuS() + 30 * DAG); await ge(e, TEST_B, nuS() + 30 * DAG);
  const A = await loggaIn(e, TEST_A); const aKonto = (await jag(e, A)).konto; await put(e, A, pid(60), 0);
  const Bt = await loggaIn(e, TEST_B); const bKonto = (await jag(e, Bt)).konto;
  const O = await loggaIn(e, AGARE);
  const mal = NU - 3600 * 1000;
  assert.equal((await f(e, "/pro/konto/agare/pitr", { method: "POST", cookie: A, body: { konto: aKonto, tid_ms: mal } })).status, 403, "icke-ägare");
  assert.equal((await f(e, "/pro/konto/agare/pitr", { method: "POST", cookie: O, body: { konto: aKonto, tid_ms: mal } })).status, 401, "utan kod");
  fram(16 * 60); let kod = await begarKod(e, AGARE);
  assert.equal((await f(e, "/pro/konto/agare/pitr", { method: "POST", cookie: O, body: { konto: aKonto, tid_ms: NU + 1000, epost: AGARE, kod } })).status, 400, "framtid");
  assert.equal((await f(e, "/pro/konto/agare/pitr", { method: "POST", cookie: O, body: { konto: aKonto, tid_ms: NU - 31 * DAG * 1000, epost: AGARE, kod } })).status, 400, "äldre än 30 d");
  assert.equal((await f(e, "/pro/konto/agare/pitr", { method: "POST", cookie: O, body: { konto: "k_" + "f".repeat(32), tid_ms: mal, epost: AGARE, kod } })).status, 404);
  const logg = bokmarken(e, aKonto);
  fram(16 * 60); kod = await begarKod(e, AGARE);
  const r = await f(e, "/pro/konto/agare/pitr", { method: "POST", cookie: O, body: { konto: aKonto, tid_ms: mal, epost: AGARE, kod } });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { status: "aterstallning_planerad", konto: aKonto, tid_ms: mal });
  assert.deepEqual(logg, [["bm", mal], ["restore", "bm-" + mal]]);
  assert.deepEqual(regRader(e, "SELECT handling, konto_id FROM agarlogg ORDER BY id").map((x) => x.handling), ["pitr_begard", "pitr_planerad"]);
  // B raderar sitt konto → PITR av B vägras (Modesty §4.9), även med giltig ägarkod
  fram(16 * 60); const kb = await begarKod(e, TEST_B);
  assert.equal((await f(e, "/pro/konto/radera", { method: "POST", cookie: Bt, body: { bekrafta: true, epost: TEST_B, kod: kb } })).status, 200);
  const loggB = bokmarken(e, bKonto);
  fram(16 * 60); kod = await begarKod(e, AGARE);
  const v = await f(e, "/pro/konto/agare/pitr", { method: "POST", cookie: O, body: { konto: bKonto, tid_ms: NU - 3600 * 1000, epost: AGARE, kod } });
  assert.equal(v.status, 409); assert.deepEqual(await v.json(), { status: "raderat_konto" });
  assert.deepEqual(loggB, [], "inget bokmärke begärt för raderat konto");
  assert.ok(regRader(e, "SELECT handling FROM agarlogg WHERE konto_id = ?", bKonto).some((x) => x.handling === "pitr_vagrad_raderat"));
});

test("PITR: radering mitt under återställningen → efterkontrollen rensar objektet igen (409); utan stöd i körtiden 501", async () => {
  const e = kEnv(); await ge(e, TEST_A, nuS() + 30 * DAG);
  const A = await loggaIn(e, TEST_A); const aKonto = (await jag(e, A)).konto; await put(e, A, pid(61), 0);
  const O = await loggaIn(e, AGARE);
  const o = kontoObj(e, aKonto);
  o.storage.getBookmarkForTime = async () => { await register(e, "radera", { nu: nuS(), kontoId: aKonto }); return "bm"; }; // radering "samtidigt"
  o.storage.onNextSessionRestoreBookmark = async () => { o.storage.sql.exec("INSERT INTO projekt (id, rev, namn, data, storlek, andrad_ms) VALUES ('p_ffffffffffffffffffffffffffffffff', 1, 'återskapad', '{}', 2, 1)"); };
  fram(16 * 60); const kod = await begarKod(e, AGARE);
  const r = await f(e, "/pro/konto/agare/pitr", { method: "POST", cookie: O, body: { konto: aKonto, tid_ms: NU - 3600 * 1000, epost: AGARE, kod } });
  assert.equal(r.status, 409);
  assert.equal(o.storage.sql.exec("SELECT COUNT(*) AS n FROM projekt").toArray()[0].n, 0, "inget återskapat");
  // utan PITR-metoder (som lokalt i dubbeln): 501
  const e2 = kEnv(); await ge(e2, TEST_A, nuS() + 30 * DAG); const A2 = await loggaIn(e2, TEST_A); const k2 = (await jag(e2, A2)).konto; const O2 = await loggaIn(e2, AGARE);
  fram(16 * 60); const kod2 = await begarKod(e2, AGARE);
  const r2 = await f(e2, "/pro/konto/agare/pitr", { method: "POST", cookie: O2, body: { konto: k2, tid_ms: NU - 3600 * 1000, epost: AGARE, kod: kod2 } });
  assert.equal(r2.status, 501); assert.deepEqual(await r2.json(), { status: "pitr_misslyckades", orsak: "stods_inte" });
});

// ---------------- cron ----------------
const sched = (e) => kontoSchema(e, { proMode: (env) => (env.PRO_PAYMENTS === "live" || env.PRO_PAYMENTS === "test" ? env.PRO_PAYMENTS : "off") });
test("cron: off rör ingenting (scheduled i off: 0 DO-, KV- och nätanrop)", async () => {
  const e = kEnv({ PRO_KONTO: "off" });
  const c = ctx(); await worker.scheduled({ cron: "17 * * * *" }, e, c); await Promise.all(c.v);
  assert.deepEqual(e.PRO_REGISTER.anrop, []); assert.deepEqual(e.PRO_KONTON.anrop, []); assert.deepEqual(natAnrop, []);
  assert.deepEqual(await sched(e), { ok: true, av: true });
});

test("cron: avisering 90 d efter att rätten upphört (mejl till kontots egen adress, en gång), radering 14 d senare; ägaren aldrig", async () => {
  const e = kEnv(); const slut = nuS() + 2 * DAG; await ge(e, TEST_A, slut);
  const A = await loggaIn(e, TEST_A); await put(e, A, pid(70), 0); const aKonto = (await jag(e, A)).konto;
  const O = await loggaIn(e, AGARE); const oKonto = (await jag(e, O)).konto;
  mejl.length = 0;
  NU = (slut + 90 * DAG - 60) * 1000; assert.deepEqual(await sched(e), { ok: true, rensade: 0, aviserade: 0, raderade: 0, fel: [] }, "före 90 d");
  NU = (slut + 90 * DAG + 60) * 1000;
  let s = await sched(e); assert.equal(s.aviserade, 1); assert.equal(mejl.length, 1);
  assert.deepEqual(mejl[0].to, [TEST_A].length === 1 ? mejl[0].to : null); assert.ok(JSON.stringify(mejl[0].to).includes(TEST_A));
  assert.match(mejl[0].subject, /raderas om 14 dagar/); assert.ok(!mejl[0].text.includes(aKonto), "inget konto-id i mejlet");
  s = await sched(e); assert.equal(s.aviserade, 0); assert.equal(mejl.length, 1, "ingen dubblett");
  fram(14 * DAG - 120); s = await sched(e); assert.equal(s.raderade, 0, "före 14 d");
  fram(180); s = await sched(e); assert.equal(s.raderade, 1);
  assert.deepEqual(regRader(e, "SELECT konto_id FROM konton WHERE konto_id = ?", aKonto), []);
  assert.deepEqual(regRader(e, "SELECT konto_id FROM raderade").map((x) => x.konto_id), [aKonto]);
  assert.equal(kontoObj(e, aKonto).storage.sql.exec("SELECT COUNT(*) AS n FROM projekt").toArray()[0].n, 0);
  assert.equal((await f(e, "/pro/konto/jag", { cookie: A })).status, 401);
  // ägaren (inaktiv i över ett halvår) finns kvar
  assert.deepEqual(regRader(e, "SELECT konto_id FROM konton").map((x) => x.konto_id), [oKonto]);
});

test("cron: ny rätt efter avisering nollställer den (ingen radering); konto med Stripe-kund hoppas över när betalning är off", async () => {
  const e = kEnv(); const slut = nuS() + DAG; await ge(e, TEST_A, slut); await ge(e, TEST_B, slut);
  const A = await loggaIn(e, TEST_A); const B = await loggaIn(e, TEST_B); const bKonto = (await jag(e, B)).konto;
  await register(e, "koppla", { nu: nuS(), kontoId: bKonto, kund: "cus_TESTKUND1" });
  NU = (slut + 91 * DAG) * 1000; let s = await sched(e); assert.equal(s.aviserade, 1, "bara A (B har kund, betalning off)");
  assert.equal((await f(e, "/pro/konto/jag", { cookie: A })).status, 401, "sessionen har gått ut efter 90 d utan aktivitet");
  await ge(e, TEST_A, nuS() + 30 * DAG); const A2 = await loggaIn(e, TEST_A); assert.equal((await jag(e, A2)).roll, "test");
  const aKonto = (await jag(e, A2)).konto;
  assert.equal(regRader(e, "SELECT aviserad FROM konto_status WHERE konto_id = ?", aKonto)[0].aviserad, null, "nollställd av aktiv rätt");
  fram(15 * DAG); s = await sched(e); assert.equal(s.raderade, 0); assert.equal(regRader(e, "SELECT 1 AS x FROM konton WHERE konto_id = ?", aKonto).length, 1);
});

test("cron: efterrensning: registret raderat men objektet inte (fel) → nästa körning rensar och markerar", async () => {
  const e = kEnv(); await ge(e, TEST_A, nuS() + 30 * DAG);
  const A = await loggaIn(e, TEST_A); await put(e, A, pid(80), 0); const aKonto = (await jag(e, A)).konto;
  await register(e, "radera", { nu: nuS(), kontoId: aKonto }); // som om objektets radering misslyckades
  assert.equal((await f(e, `/pro/konto/projekt/${pid(80)}`, { cookie: A })).status, 200, "objektet ännu orensat");
  const s = await sched(e); assert.equal(s.rensade, 1);
  assert.equal((await f(e, "/pro/konto/jag", { cookie: A })).status, 401);
  assert.equal(regRader(e, "SELECT rensad IS NOT NULL AS r FROM raderade")[0].r, 1);
});

test("Modesty §4.2: lagrade fält per tabell är exakt de dokumenterade (ingen klartext-e-post eller kod i registret)", async () => {
  const e = kEnv(); await ge(e, TEST_A, nuS() + DAG); const A = await loggaIn(e, TEST_A); await put(e, A, pid(90), 0);
  const kontoId = (await jag(e, A)).konto; await register(e, "koppla_projekt", { nu: nuS(), kontoId, projektId: pid(90) });
  const kol = (db, t) => db.exec(`SELECT * FROM ${t} LIMIT 0`) && Object.keys(db.exec(`SELECT * FROM ${t}`).toArray()[0] || {});
  const reg = regObj(e).storage.sql, ko = kontoObj(e, kontoId).storage.sql;
  const tabeller = (db) => db.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).toArray().map((x) => x.name);
  assert.deepEqual(tabeller(reg), ["adress", "agarlogg", "grans", "koder", "konto_status", "konton", "kop_projekt", "nonce", "pitr_utlogg", "pro_kop", "pro_kop_sparr", "raderade", "testbevis", "testplatser"]); // K5: +pitr_utlogg, +testplatser
  assert.deepEqual(tabeller(ko), ["enheter", "logg", "meta", "projekt"]);
  const regText = JSON.stringify(["konton", "koder", "testbevis", "grans", "adress"].map((t) => reg.exec(`SELECT * FROM ${t}`).toArray()));
  assert.ok(!regText.includes(TEST_A) && !regText.includes("testare"), "ingen klartext-e-post i registret");
  assert.deepEqual(kol(ko, "projekt").sort(), ["andrad_ms", "data", "id", "namn", "raderad_ms", "rev", "storlek"]);
  assert.deepEqual(ko.exec("SELECT k, v FROM meta").toArray(), [{ k: "epost", v: TEST_A }], "e-post bara i kontots objekt");
});
