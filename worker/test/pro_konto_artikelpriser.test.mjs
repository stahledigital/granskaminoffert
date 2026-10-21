// PRO-PRIS-01 (KP-2026-10-16-01, Claude Code 2026-10-21): Mina artikelpriser som ett dokument per konto. Samma harness som K2
// (riktig default-export och riktiga ProRegister/ProKonto i node:sqlite-dubbeln). Ursprunglig K2-rubrik:
// KONTO-SYNK K2 (KP-2026-10-16-01, Donatello 2026-10-18): synk-API, gravstenar, läsperiod, köpt projekt, export, radering, PITR,
// cron (avisering/radering/efterrensning) och K1-härdningen A1–A4. Workerns RIKTIGA default-export och RIKTIGA klasser
// ProRegister/ProKonto i node:sqlite-dubbeln. Resend är en HTTP-dubbel; inget annat nät tillåts. Tiden styrs via Date.now.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { ProRegister, ProKonto, epostHash, register, kontoSchema, KODER_DAG, FEL_DAG, PROJ_MAX_ANTAL, AP_FORMAT, AP_MAX_BYTE, AP_MAX_POSTER } from "../src/pro_konto.js";
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
const kontoObj = (e, kontoId) => e.PRO_KONTON.inst.get("k:" + kontoId);
const post = (n, pris = "123.45", extra = {}) => ({ nyckel: "n:grp-trall-28x120|st", namn: "Trall 28 × 120 nr " + n, enhet: "st", pris_kr: pris, sparad: "2026-10-21", andrad_ms: 1_790_000_000_000 + n, ...extra });
const dok = (poster) => ({ format: AP_FORMAT, version: 1, poster });
const ap = (e, cookie) => f(e, "/pro/konto/artikelpriser", { cookie });
const apPut = (e, cookie, rev, body) => f(e, "/pro/konto/artikelpriser", { method: "PUT", cookie, body, headers: rev === null ? {} : { "If-Match": String(rev) } });

test("PRO-PRIS-01: tomt konto ger rev 0; If-Match 0→1→2; gammal rev ger 409 med hela serverdokumentet; If-Match saknas 428", async () => {
  const e = kEnv(); const A = await loggaIn(e);
  let r = await ap(e, A); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { status: "ok", rev: 0, andrad: null, data: dok([]) });
  r = await apPut(e, A, 0, dok([post(1)])); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { status: "sparat", rev: 1, andrad: NU });
  r = await apPut(e, A, 1, dok([post(1, "0"), post(2)])); assert.equal((await r.json()).rev, 2);
  r = await apPut(e, A, 1, dok([post(3)])); assert.equal(r.status, 409);
  const k = await r.json(); assert.equal(k.status, "konflikt"); assert.equal(k.server.rev, 2); assert.deepEqual(k.server.data, dok([post(1, "0"), post(2)]));
  r = await apPut(e, A, 0, dok([post(3)])); assert.equal(r.status, 409, "0 skapar bara när inget finns");
  assert.equal((await apPut(e, A, null, dok([]))).status, 428);
  r = await ap(e, A); const x = await r.json(); assert.equal(x.rev, 2); assert.equal(x.data.poster[0].pris_kr, "0", "uttryckligt 0 bevaras som 0");
});

test("PRO-PRIS-01: validering – exakta nycklar, unik (nyckel, namn, enhet), pris som KR-sträng där 0 är ett pris; gravsten för borttag", async () => {
  const e = kEnv(); const A = await loggaIn(e);
  const fel = [null, [], "x", { format: AP_FORMAT, version: 2, poster: [] }, { format: AP_FORMAT, version: 1, poster: [], extra: 1 },
    dok([post(1, null)]), dok([post(1, "")]), dok([post(1, "-1")]), dok([post(1, "1.234")]), dok([post(1, 5)]), dok([post(1, "1", { extra: true })]),
    dok([post(1), post(1)]), dok([post(1, "1", { nyckel: "x:annat|st" })]), dok([post(1, "1", { enhet: "" })]), dok([post(1, "1", { namn: "a\u0007b" })]),
    dok([post(1, "1", { sparad: "21/10" })]), dok([post(1, "1", { andrad_ms: 0 })]), dok([{ nyckel: "m:skruv|st", namn: null, enhet: "st", raderad_ms: 0 }]),
    dok([post(1, "1", { namn: "Å" })])];
  for (const b of fel) assert.equal((await apPut(e, A, 0, b)).status, 400, JSON.stringify(b).slice(0, 80));
  assert.equal((await apPut(e, A, 0, "{inte json")).status, 400);
  const ok = dok([post(1, "0"), { nyckel: "m:egen skruv|st", namn: null, enhet: "st", pris_kr: "2.5", sparad: "2026-10-21", andrad_ms: 5 },
    { nyckel: "n:roof:" + "a".repeat(64) + "|förp", namn: null, enhet: "förp", raderad_ms: NU - 1000 }]);
  assert.equal((await apPut(e, A, 0, ok)).status, 200);
  assert.deepEqual((await (await ap(e, A)).json()).data, ok);
});

test("PRO-PRIS-01: gränser 256 KiB och 1 000 aktiva poster (som projektens storlek); 1 001 ger 413", async () => {
  const e = kEnv(); const A = await loggaIn(e);
  const tusen = dok(Array.from({ length: AP_MAX_POSTER }, (_, i) => post(i)));
  assert.equal((await apPut(e, A, 0, tusen)).status, 200);
  let r = await apPut(e, A, 1, dok(Array.from({ length: AP_MAX_POSTER + 1 }, (_, i) => post(i)))); assert.equal(r.status, 413); assert.deepEqual(await r.json(), { status: "for_manga_poster", max: AP_MAX_POSTER });
  const stor = JSON.stringify(dok([post(1, "1", { namn: "x".repeat(200) })])); const fyll = " ".repeat(AP_MAX_BYTE - Buffer.byteLength(stor));
  assert.equal((await apPut(e, A, 1, stor + fyll)).status, 200, "exakt 256 KiB");
  r = await apPut(e, A, 2, stor + fyll + " "); assert.equal(r.status, 413); assert.deepEqual(await r.json(), { status: "for_stort", max_byte: AP_MAX_BYTE });
});

test("PRO-PRIS-01: läsperiod ger GET 200 men PUT 403 las_endast; utan session 401; okänd metod 404; skrivande anrop kräver Origin och X-MR-Pro", async () => {
  const e = kEnv(); const slut = nuS() + 5 * DAG; await ge(e, TEST_A, slut); const A = await loggaIn(e, TEST_A);
  assert.equal((await apPut(e, A, 0, dok([post(1)]))).status, 200);
  fram(6 * DAG);
  assert.equal((await ap(e, A)).status, 200);
  let r = await apPut(e, A, 1, dok([post(1, "50")])); assert.equal(r.status, 403, "ändring i läsperiod"); assert.deepEqual(await r.json(), { status: "las_endast", las_slut: slut + 90 * DAG });
  assert.equal((await apPut(e, A, 1, dok([post(2)]))).status, 403, "nytt pris i läsperiod");
  fram(80 * DAG); assert.equal((await ap(e, A)).status, 200); fram(10 * DAG); // 96 d efter slut, sessionen förnyad
  r = await apPut(e, A, 1, dok([post(5)])); assert.deepEqual(await r.json(), { status: "ingen_ratt" });
  r = await apPut(e, A, 1, dok([{ nyckel: post(1).nyckel, namn: post(1).namn, enhet: "st", raderad_ms: NU }])); assert.equal(r.status, 200, "egna priser kan alltid tas bort");
  assert.equal((await ap(e, undefined)).status, 401);
  assert.equal((await f(e, "/pro/konto/artikelpriser", { method: "DELETE", cookie: A })).status, 404);
  assert.equal((await f(e, "/pro/konto/artikelpriser", { method: "PUT", cookie: A, xmr: false, body: dok([]), headers: { "If-Match": "1" } })).status, 403);
  assert.equal((await f(e, "/pro/konto/artikelpriser", { method: "PUT", cookie: A, origin: "https://exempel.se", body: dok([]), headers: { "If-Match": "1" } })).status, 403);
});

test("PRO-PRIS-01: konton är isolerade; export innehåller priserna; radering lämnar objektet tomt", async () => {
  const e = kEnv(); await ge(e, TEST_A, nuS() + 30 * DAG); await ge(e, TEST_B, nuS() + 30 * DAG);
  const A = await loggaIn(e, TEST_A), B = await loggaIn(e, TEST_B);
  assert.equal((await apPut(e, A, 0, dok([post(1, "99")]))).status, 200);
  assert.deepEqual((await (await ap(e, B)).json()).data, dok([]), "B ser inte A:s priser");
  const x = await (await f(e, "/pro/konto/export", { cookie: A })).json();
  assert.deepEqual(x.artikelpriser.data, dok([post(1, "99")])); assert.equal(x.artikelpriser.rev, 1);
  const kontoId = (await jag(e, A)).konto;
  const kod = await begarKod(e, TEST_A);
  assert.equal((await f(e, "/pro/konto/radera", { method: "POST", cookie: A, body: { bekrafta: true, epost: TEST_A, kod } })).status, 200);
  const db = kontoObj(e, kontoId).storage.sql;
  for (const t of ["artikelpriser", "enheter", "projekt", "meta", "logg"]) assert.equal(db.exec(`SELECT COUNT(*) AS n FROM ${t}`).toArray()[0].n, 0, t);
});

test("PRO-PRIS-01 granskning: nycklar upp till 240 tecken (P4 k:/m: + enhet), gamla gravstenar gallras före räkning, framtida tid och ogiltigt datum nekas, bidi/nollbredd nekas", async () => {
  const e = kEnv(); const A = await loggaIn(e);
  const lang = { nyckel: "m:" + "x".repeat(200) + "|förpackning", namn: null, enhet: "förpackning", pris_kr: "1", sparad: "2026-10-21", andrad_ms: 5 };
  assert.ok(lang.nyckel.length > 200); assert.equal((await apPut(e, A, 0, dok([lang]))).status, 200);
  const gammal = (i) => ({ nyckel: "m:skruv " + i + "|st", namn: null, enhet: "st", raderad_ms: NU - 91 * DAG * 1000 });
  let r = await apPut(e, A, 1, dok([lang, ...Array.from({ length: AP_MAX_POSTER + 5 }, (_, i) => gammal(i))])); assert.equal(r.status, 200, "gravstenar över 90 d räknas inte och sparas inte");
  assert.deepEqual((await (await ap(e, A)).json()).data, dok([lang]));
  for (const b of [dok([{ ...gammal(1), raderad_ms: NU + 3600 * 1000 }]), dok([post(1, "1", { andrad_ms: NU + 3600 * 1000 })]), dok([post(1, "1", { sparad: "2026-02-30" })]),
    dok([post(1, "1", { namn: "Trall\u202e" })]), dok([post(1, "1", { namn: "Tra\u200bll" })]), dok([post(1, "1", { namn: "\ud800" })])])
    assert.equal((await apPut(e, A, 2, b)).status, 400, JSON.stringify(b).slice(0, 90));
});

test("PRO-PRIS-01 granskning: projektköpare får kraver_full_pro, inte las_endast", async () => {
  const e = kEnv(); await ge(e, TEST_A, nuS() + DAG); const A = await loggaIn(e, TEST_A); const kontoId = (await jag(e, A)).konto;
  fram(2 * DAG); assert.equal((await register(e, "koppla_projekt", { nu: nuS(), kontoId, projektId: "p_" + "1".repeat(32) })).ok, true);
  assert.equal((await jag(e, A)).roll, "projekt");
  const r = await apPut(e, A, 0, dok([post(1)])); assert.equal(r.status, 403); assert.deepEqual(await r.json(), { status: "kraver_full_pro" });
});
