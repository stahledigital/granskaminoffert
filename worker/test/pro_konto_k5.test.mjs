// KONTO-SYNK K5 del A (KP-2026-10-16-01, Donatello 2026-10-18): ägarens API för testplatser (/pro/konto/agare/*), steg-kod,
// testinbjudan bakom PRO_TEST_MEJL, K2-fynd 2 (PITR loggar ut alla enheter), K2-fynd 3 (e-post sparas vid inloggning) och
// mejltexterna ur KONTO_DELTA. Workerns RIKTIGA default-export och RIKTIGA klasser ProRegister/ProKonto i node:sqlite-dubbeln.
// Resend är en HTTP-dubbel; inget annat nät tillåts. Tiden styrs via Date.now.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { ProRegister, ProKonto, epostHash, register, maskera, MAX_TESTPLATSER, KONTO_TEXT } from "../src/pro_konto.js";
import { MEJL, MEJL_KONTO, mejlTexter } from "../src/pro_texter.js";
import { namnrymd } from "./helpers/pro_do_dubbel.mjs";
import { ENV } from "./stripe_dubbel.mjs";

const API = "https://granskaminoffert-api.anders-316.workers.dev";
const SAJT = "https://stahledigital.se";
const AGARE = "anders@stahledigital.se", T1 = "testare.ett@example.se", T2 = "testare.tva@example.se", T3 = "testare.tre@example.se", T4 = "testare.fyra@example.se", T5 = "testare.fem@example.se", T6 = "testare.sex@example.se", T7 = "testare.sju@example.se", T8 = "testare.atta@example.se", T9 = "testare.nio@example.se";
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
  e.PRO_REGISTER = namnrymd(ProRegister); e.PRO_KONTON = namnrymd(ProKonto, e);
  return e;
}
const ctx = () => { const v = []; return { v, waitUntil: (p) => v.push(p), passThroughOnException() {} }; };
let ipN = 0;
function req(path, { method = "GET", origin = SAJT, xmr = true, body, cookie, headers = {} } = {}) {
  const h = { "CF-Connecting-IP": `198.51.100.${(ipN++ % 200) + 1}`, ...headers };
  if (origin) h.Origin = origin;
  if (xmr && method !== "GET") h["X-MR-Pro"] = "1";
  if (body !== undefined) h["content-type"] = "application/json";
  if (cookie) h.Cookie = cookie;
  return new Request(API + path, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
}
const f = async (env, path, o) => { const c = ctx(); const r = await worker.fetch(req(path, o), env, c); await Promise.all(c.v); return r; };
const kodUr = (m) => /\n {4}(\d{6})\n/.exec(m.text)[1];
const lankUr = (m) => /#pro-konto=([0-9a-f]{32}\.\d{6})/.exec(m.text)[1];
const cookieUr = (r) => { const s = r.headers.get("set-cookie"); return s ? s.split(";")[0] : null; };
// Koden till ägaren: 3 per 15 min per adress (K1) – varje steg-kod flyttar därför fram klockan 6 min.
async function begarKod(e, epost) { fram(6 * 60); const n = mejl.length; assert.equal((await f(e, "/pro/konto/kod", { method: "POST", body: { epost } })).status, 202); return mejl.length > n ? mejl[mejl.length - 1] : null; }
async function loggaIn(e, epost = AGARE, namn) {
  const m = await begarKod(e, epost); assert.ok(m, "kodmejl till " + epost);
  const r = await f(e, "/pro/konto/logga-in", { method: "POST", body: { epost, kod: kodUr(m), ...(namn ? { namn } : {}) } });
  assert.equal(r.status, 200, "inloggning " + epost); return cookieUr(r);
}
const jag = async (e, cookie) => (await f(e, "/pro/konto/jag", { cookie })).json();
const stegkod = async (e) => kodUr(await begarKod(e, AGARE));
const agare = (e, cookie, vag, body) => f(e, "/pro/konto/agare/" + vag, body === undefined ? { cookie } : { method: "POST", cookie, body });
const A3 = (r, namn) => { assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow", namn); assert.equal(r.headers.get("cache-control"), "no-store", namn);
  for (const [k] of r.headers) assert.ok(!k.startsWith("access-control-") && k !== "vary", namn + " " + k); };
const pid = (n) => "p_" + n.toString(16).padStart(32, "0");
const projekt = (id, namn = "Kund Kalle Altan") => ({ format: "materialraknaren-pro-projekt", version: 1, projektId: id, projektnamn: namn, moms: "25",
  material: [{ namn: "Trall 28x120", mangd: "42", enhet: "st", pris_kr: null, med: true }], arbete: [], ovrigt: [], kund: { namn: "Kalle Kund", adress: "Storgatan 1" } });
const put = (e, cookie, id, rev, body) => f(e, `/pro/konto/projekt/${id}`, { method: "PUT", cookie, body: body === undefined ? projekt(id) : body, headers: { "If-Match": String(rev) } });
const regObj = (e) => e.PRO_REGISTER.inst.get("register:v1");
const regRader = (e, q, ...a) => regObj(e).storage.sql.exec(q, ...a).toArray();
async function bjudIn(e, O, epost, extra = {}) {
  const r = await agare(e, O, "inbjud", { epost, kod: await stegkod(e), ...extra }); return { r, j: await r.json() };
}

// ---------------- behörighet ----------------
test("ägar-API: off 503; utan session 401; inloggad testare (icke-ägare) 403 på lista och alla ändringar; A3 på alla svar", async () => {
  const off = kEnv({ PRO_KONTO: "off" });
  for (const v of ["testplatser", "inbjud", "forlang", "aterkalla"]) { const r = await agare(off, null, v, v === "testplatser" ? undefined : {}); assert.equal(r.status, 503, v); A3(r, "off " + v); }
  const e = kEnv(); const O = await loggaIn(e);
  const { j } = await bjudIn(e, O, T1); assert.equal(j.status, "inbjuden");
  const T = await loggaIn(e, T1);
  assert.equal((await jag(e, T)).roll, "test");
  for (const v of ["testplatser", "inbjud", "forlang", "aterkalla"]) {
    const anon = await agare(e, null, v, v === "testplatser" ? undefined : { epost: T2 }); assert.equal(anon.status, 401, "anonym " + v); A3(anon, "anon " + v);
    const r = await agare(e, T, v, v === "testplatser" ? undefined : { epost: T2, id: j.testplats.id, slut: nuS() + 40 * DAG, kod: "000000" });
    assert.equal(r.status, 403, "testare " + v); assert.deepEqual(await r.json(), { status: "ej_agare" }); A3(r, "403 " + v);
  }
  // fel metod och okända ägarrutter: 404 före sessionen (ingen rutt för kunders jobb eller konton)
  for (const [v, m] of [["testplatser", "POST"], ["inbjud", "GET"], ["projekt", "GET"], ["konton", "GET"], ["export", "GET"], ["konto/" + "k_" + "0".repeat(32), "GET"]]) {
    const r = await f(e, "/pro/konto/agare/" + v, { method: m, cookie: O, body: m === "POST" ? {} : undefined }); assert.equal(r.status, 404, v + " " + m); A3(r, v);
  }
});

// ---------------- steg-kod ----------------
test("steg-kod: varje ändring kräver en färsk egen kod (≤10 min, engångs) till ägarens adress; utan, fel, gammal eller återanvänd kod ger 401 stegkod och ingen ändring", async () => {
  const e = kEnv(); const O = await loggaIn(e);
  let r = await agare(e, O, "inbjud", { epost: T1 }); assert.equal(r.status, 401); assert.deepEqual(await r.json(), { status: "stegkod" }); A3(r, "utan kod");
  r = await agare(e, O, "inbjud", { epost: T1, kod: "12345" }); assert.equal(r.status, 401, "fel format");
  const kod = await stegkod(e);
  r = await agare(e, O, "inbjud", { epost: T1, kod: String((Number(kod) + 1) % 1000000).padStart(6, "0") }); assert.equal(r.status, 401, "fel kod");
  assert.equal(regRader(e, "SELECT COUNT(*) AS n FROM testplatser")[0].n, 0, "ingen ändring utan rätt kod");
  r = await agare(e, O, "inbjud", { epost: T1, kod }); assert.equal(r.status, 200, "rätt kod");
  r = await agare(e, O, "inbjud", { epost: T2, kod }); assert.equal(r.status, 401, "återanvänd kod");
  const gammal = await stegkod(e); fram(11 * 60);
  r = await agare(e, O, "inbjud", { epost: T2, kod: gammal }); assert.equal(r.status, 401, "kod äldre än 10 min");
  // länken ur samma mejl duger som steg-kod
  const m = await begarKod(e, AGARE); r = await agare(e, O, "inbjud", { epost: T2, lank: lankUr(m) }); assert.equal(r.status, 200, "länk");
  // en testares egen kod duger inte som ägarens steg-kod (och förbrukas inte)
  const T = await loggaIn(e, T1); const tm = await begarKod(e, T1);
  r = await agare(e, O, "inbjud", { epost: T3, lank: lankUr(tm) }); assert.equal(r.status, 401, "annans kod");
  assert.equal((await f(e, "/pro/konto/logga-in", { method: "POST", body: { lank: lankUr(tm) } })).status, 200, "testarens kod förbrukades inte");
  assert.ok(T);
});

test("indata och tillstånd prövas FÖRE kodinlösen: 400/409 förbrukar inte koden", async () => {
  const e = kEnv(); const O = await loggaIn(e);
  const kod = await stegkod(e);
  for (const [b, st, kodS] of [[{ epost: "inte-en-adress" }, "ogiltig_adress", 400], [{ epost: AGARE }, "agarens_adress", 400], [{ epost: T1, slut: nuS() - 1 }, "ogiltigt_slut", 400],
    [{ epost: T1, slut: nuS() + 91 * DAG }, "ogiltigt_slut", 400], [{ epost: T1, slut: "2026-12-01" }, "ogiltigt_slut", 400]]) {
    const r = await agare(e, O, "inbjud", { ...b, kod }); assert.equal(r.status, kodS, st); assert.equal((await r.json()).status, st);
  }
  for (const v of ["forlang", "aterkalla"]) assert.equal((await agare(e, O, v, { id: "t_" + "0".repeat(16), slut: nuS() + DAG, kod })).status, 404, v + " okänt id");
  assert.equal((await agare(e, O, "aterkalla", { id: "../x", kod })).status, 404);
  const r = await agare(e, O, "inbjud", { epost: T1, kod }); assert.equal(r.status, 200, "koden fungerar fortfarande");
});

// ---------------- inbjudan, lista, tak ----------------
test("inbjudan: förval +30 d, etikett Test 1–8, maskerad adress; högst 8 aktiva (den nionde 409 fullt); aktiv dubblett 409; lista visar bara id/etikett/adress/status/tider", async () => {
  const e = kEnv(); const O = await loggaIn(e);
  const a = await bjudIn(e, O, T1); assert.equal(a.r.status, 200); A3(a.r, "inbjud");
  assert.deepEqual(Object.keys(a.j.testplats).sort(), ["adress", "aterkallad", "etikett", "id", "skapad", "slut", "status"]);
  assert.equal(a.j.testplats.slut, nuS() + 30 * DAG); assert.equal(a.j.testplats.etikett, "Test 1"); assert.equal(a.j.testplats.adress, "t***@e***.se"); assert.equal(a.j.testplats.status, "aktiv");
  assert.equal(a.j.mejl, "av", "PRO_TEST_MEJL saknas = av");
  assert.match(a.j.testplats.id, /^t_[0-9a-f]{16}$/);
  const s10 = nuS() + 10 * DAG + 3600; // klockan går 6 min per steg-kod: slutet ska vara exakt det angivna
  const b = await bjudIn(e, O, T2, { etikett: "Snickare <Bo>", slut: s10 }); assert.equal(b.j.testplats.etikett, "Snickare Bo"); assert.equal(b.j.testplats.slut, s10);
  const dub = await bjudIn(e, O, T1); assert.equal(dub.r.status, 409); assert.equal(dub.j.status, "finns_redan"); assert.equal(dub.j.id, a.j.testplats.id);
  const c = await bjudIn(e, O, T3); assert.equal(c.j.testplats.etikett, "Test 2", "första lediga Test-nummer");
  const fourth = await bjudIn(e,O,T4); assert.equal(fourth.r.status,200); assert.equal(fourth.j.testplats.etikett,"Test 3");
  const fifth = await bjudIn(e, O, T5); assert.equal(fifth.r.status, 200, "femte platsen (v17)"); assert.equal(fifth.j.testplats.etikett, "Test 4");
  const sixth = await bjudIn(e, O, T6); assert.equal(sixth.r.status, 200, "sjätte platsen"); assert.equal(sixth.j.testplats.etikett, "Test 5");
  fram(DAG); // Existing ten-codes-per-address rolling day applies to owner step-up too.
  const seventh = await bjudIn(e, O, T7); assert.equal(seventh.r.status, 200); assert.equal(seventh.j.testplats.etikett, "Test 6");
  const eighth = await bjudIn(e, O, T8); assert.equal(eighth.r.status, 200); assert.equal(eighth.j.testplats.etikett, "Test 7");
  assert.equal(MAX_TESTPLATSER, 8);
  const d = await bjudIn(e, O, T9); assert.equal(d.r.status, 409); assert.deepEqual(d.j, { status: "fullt", max: 8 });
  const l = await agare(e, O, "testplatser"); assert.equal(l.status, 200); A3(l, "lista");
  const lj = await l.json();
  assert.equal(lj.aktiva, 8); assert.equal(lj.max, 8); assert.equal(lj.testplatser.length, 8);
  const text = JSON.stringify(lj);
  for (const x of [T1, T2, T3, T4, T5, T6, T7, T8, T9, "testare", "example", "k_", "ehash"]) assert.ok(!text.includes(x), "listan innehåller inte " + x);
  for (const p of lj.testplatser) assert.deepEqual(Object.keys(p).sort(), ["adress", "aterkallad", "etikett", "id", "skapad", "slut", "status"]);
  // registret har ingen klartextadress
  assert.ok(!JSON.stringify(regRader(e, "SELECT * FROM testplatser")).includes("testare"));
  assert.ok(regRader(e, "SELECT handling FROM agarlogg").every((x) => /^testplats_/.test(x.handling)));
  // en utgången plats räknas inte: den nionde går in när T2:s 10 dagar gått
  fram(10 * DAG + 7200); const d2 = await bjudIn(e, O, T9); assert.equal(d2.r.status, 200, "plats ledig när en gått ut");
  const lj2 = await (await agare(e, O, "testplatser")).json();
  assert.deepEqual(lj2.testplatser.map((p) => p.status), ["aktiv", "utgangen", "aktiv", "aktiv", "aktiv", "aktiv", "aktiv", "aktiv", "aktiv"]);
});

test("inbjudan → testaren loggar in med kod till sin adress → roll test (PRO utan kort, ingen betalning); i läge av skickas inget inbjudningsmejl", async () => {
  const e = kEnv(); const O = await loggaIn(e);
  const n0 = mejl.length; const { j } = await bjudIn(e, O, T1); assert.equal(j.mejl, "av");
  assert.equal(mejl.length, n0 + 1, "bara ägarens steg-kod, inget inbjudningsmejl");
  assert.ok(!mejl.some((m) => m.to === T1 || (Array.isArray(m.to) && m.to.includes(T1))), "inget mejl till testaren i av");
  // utan inbjudan får adressen ingen kod (K1), med inbjudan får den det
  assert.equal(await begarKod(e, T2), null, "ej inbjuden: neutral 202 utan mejl");
  const T = await loggaIn(e, T1); const me = await jag(e, T);
  assert.equal(me.roll, "test"); assert.equal(me.ratt_slut, j.testplats.slut);
  assert.equal((await put(e, T, pid(1), 0)).status, 200, "testplatsen ger skrivrätt");
  assert.equal(e.PRO_PAYMENTS, "off"); assert.deepEqual(natAnrop.filter((u) => u !== "https://api.resend.com/emails"), [], "inga Stripe- eller andra anrop");
});

test("PRO_TEST_MEJL=\"på\": inbjudningsmejlet byggs ur Zlatas test.* och skickas till den inbjudna adressen, en gång per plats och slut", async () => {
  const e = kEnv({ PRO_TEST_MEJL: "på" }); const O = await loggaIn(e);
  const { j } = await bjudIn(e, O, T1, { slut: nuS() + 30 * DAG });
  assert.equal(j.mejl, "skickat");
  const m = mejl.filter((x) => x.to === T1 || (Array.isArray(x.to) && x.to.includes(T1)));
  assert.equal(m.length, 1);
  assert.equal(m[0].subject, "Du är inbjuden att testa Materialräknaren PRO i 30 dagar");
  assert.match(m[0].text, /^Hej,\n\ndu är inbjuden att testa Materialräknaren PRO i 30 dagar, till och med \d{1,2} [a-zé]+ 2026\./);
  assert.ok(m[0].text.includes("1. Öppna https://stahledigital.se/verkstaden/materialraknaren/offert\n"));
  assert.ok(m[0].text.includes("Använd påhittade kunduppgifter under testet."));
  assert.ok(!/\{\w+\}/.test(m[0].text), "inga ofyllda platshållare");
  assert.equal(m[0].idem, `pro-konto-test-${j.testplats.id}-${j.testplats.slut}`);
  for (const v of ["pa", "PÅ", "1", "true", ""]) { const e2 = kEnv({ PRO_TEST_MEJL: v }); const O2 = await loggaIn(e2); assert.equal((await bjudIn(e2, O2, T2)).j.mejl, "av", JSON.stringify(v)); }
  assert.equal(KONTO_TEXT.test_amne, "Du är inbjuden att testa Materialräknaren PRO i {dagar} dagar");
});

// ---------------- förläng och återkalla ----------------
test("förläng: senare slut (högst 90 d fram) gäller direkt för testarens rätt; kortare, äldre eller för långt slut 400; återkallad 409", async () => {
  const e = kEnv(); const O = await loggaIn(e);
  const { j } = await bjudIn(e, O, T1, { slut: nuS() + 5 * DAG }); const id = j.testplats.id;
  const T = await loggaIn(e, T1);
  const s0 = j.testplats.slut;
  for (const slut of [s0 - DAG, s0, nuS() + 92 * DAG, null]) {
    const r = await agare(e, O, "forlang", { id, slut, kod: await stegkod(e) }); assert.equal(r.status, 400, String(slut)); assert.equal((await r.json()).status, "ogiltigt_slut");
  }
  const ny = nuS() + 60 * DAG;
  const r = await agare(e, O, "forlang", { id, slut: ny, kod: await stegkod(e) }); assert.equal(r.status, 200); A3(r, "forlang");
  const rj = await r.json(); assert.equal(rj.status, "forlangd"); assert.equal(rj.testplats.slut, ny);
  assert.equal((await jag(e, T)).ratt_slut, ny, "testarens rätt följer förlängningen");
  // en utgången plats kan förlängas och blir aktiv igen
  fram(61 * DAG); assert.equal((await jag(e, T)).roll, "ingen");
  const r2 = await agare(e, O, "forlang", { id, slut: nuS() + 30 * DAG, kod: await stegkod(e) }); assert.equal(r2.status, 200);
  assert.equal((await jag(e, T)).roll, "test");
  await agare(e, O, "aterkalla", { id, kod: await stegkod(e) });
  const r3 = await agare(e, O, "forlang", { id, slut: nuS() + 40 * DAG, kod: await stegkod(e) }); assert.equal(r3.status, 409); assert.equal((await r3.json()).status, "aterkallad");
});

test("återkalla: testaren förlorar skrivrätten vid NÄSTA anrop (PUT 403 las_endast, läsperiod 90 d från återkallelsen); läsning och export fungerar; ny inbjudan återaktiverar", async () => {
  const e = kEnv(); const O = await loggaIn(e);
  const { j } = await bjudIn(e, O, T1); const id = j.testplats.id;
  const T = await loggaIn(e, T1); assert.equal((await put(e, T, pid(7), 0)).status, 200);
  fram(60);
  const r = await agare(e, O, "aterkalla", { id, kod: await stegkod(e) }); assert.equal(r.status, 200); A3(r, "aterkalla");
  const rj = await r.json(); assert.equal(rj.status, "aterkallad"); assert.equal(rj.testplats.status, "aterkallad"); const aterkallad = rj.testplats.aterkallad;
  const p = await put(e, T, pid(7), 1); assert.equal(p.status, 403, "nästa anrop nekas");
  assert.deepEqual(await p.json(), { status: "las_endast", las_slut: aterkallad + 90 * DAG, skrivbara: [] });
  assert.equal((await f(e, `/pro/konto/projekt/${pid(7)}`, { cookie: T })).status, 200, "läsning tillåts");
  assert.equal((await f(e, "/pro/konto/export", { cookie: T })).status, 200, "export tillåts");
  assert.equal((await jag(e, T)).roll, "ingen");
  const igen = await agare(e, O, "aterkalla", { id, kod: await stegkod(e) }); assert.equal((await igen.json()).status, "redan_aterkallad");
  const nyIn = await bjudIn(e, O, T1); assert.equal(nyIn.r.status, 200); assert.equal(nyIn.j.ateraktiverad, true); assert.equal(nyIn.j.testplats.id, id, "samma plats-id");
  assert.equal((await put(e, T, pid(7), 1)).status, 200, "skrivrätt igen");
  assert.deepEqual(regRader(e, "SELECT handling FROM agarlogg ORDER BY id").map((x) => x.handling), ["testplats_inbjuden", "testplats_aterkallad", "testplats_ateraktiverad"]);
});

// ---------------- ingen kunddata till ägaren ----------------
test("ingen ägar-endpoint exponerar kunddata: ägarens session når inte testarens projekt (404), och inga ägarsvar innehåller projektnamn, kunduppgifter eller konto-id", async () => {
  const e = kEnv(); const O = await loggaIn(e);
  const { j } = await bjudIn(e, O, T1); const T = await loggaIn(e, T1);
  assert.equal((await put(e, T, pid(9), 0, projekt(pid(9), "Hemlig kund Svensson"))).status, 200);
  const tKonto = (await jag(e, T)).konto;
  assert.equal((await f(e, `/pro/konto/projekt/${pid(9)}`, { cookie: O })).status, 404, "ägarens session: annat kontos projekt-id ger 404");
  assert.deepEqual((await (await f(e, "/pro/konto/projekt", { cookie: O })).json()).projekt, [], "ägarens lista är bara ägarens egna");
  const svar = [];
  svar.push(await (await agare(e, O, "testplatser")).text());
  svar.push(await (await agare(e, O, "forlang", { id: j.testplats.id, slut: nuS() + 40 * DAG, kod: await stegkod(e) })).text());
  svar.push(await (await agare(e, O, "aterkalla", { id: j.testplats.id, kod: await stegkod(e) })).text());
  svar.push(await (await agare(e, O, "inbjud", { epost: T2, kod: await stegkod(e) })).text());
  for (const s of svar) for (const x of ["Svensson", "Kalle", "Storgatan", "Trall", tKonto, "p_", T1, T2]) assert.ok(!s.includes(x), `svaret innehåller inte ${x}: ${s.slice(0, 80)}`);
  // ägarloggen bär bara plats-id och slut
  assert.ok(!JSON.stringify(regRader(e, "SELECT * FROM agarlogg")).includes("Svensson"));
});

// ---------------- K2-fynd 2: PITR loggar ut alla enheter ----------------
test("K2-fynd 2: efter genomförd PITR loggas ALLA enheter i det återställda kontot ut, även en enhet som återkallats efter bokmärket och blivit aktiv igen", async () => {
  const e = kEnv(); const O = await loggaIn(e);
  await bjudIn(e, O, T1); const T_a = await loggaIn(e, T1, "Telefon"), T_b = await loggaIn(e, T1, "Dator");
  const me = await jag(e, T_a); const kontoId = me.konto; const bId = me.enheter.find((x) => x.namn === "Dator").id;
  const mal = NU - 60 * 1000;
  // Dator loggas ut EFTER bokmärket (stulen enhet), från telefonen
  assert.equal((await f(e, `/pro/konto/enheter/${bId}/logga-ut`, { method: "POST", cookie: T_a })).status, 200);
  assert.equal((await f(e, "/pro/konto/jag", { cookie: T_b })).status, 401, "datorn är utloggad");
  const ko = () => e.PRO_KONTON.inst.get("k:" + kontoId);
  const gammal = ko();
  gammal.storage.getBookmarkForTime = async (t) => "bm-" + t;
  // återställningen till bokmärket: datorn var aktiv då (simuleras när objektet "startar om")
  let aterstalld = false;
  gammal.storage.onNextSessionRestoreBookmark = async () => { aterstalld = true; };
  const kod = await stegkod(e);
  const r = await f(e, "/pro/konto/agare/pitr", { method: "POST", cookie: O, body: { konto: kontoId, tid_ms: mal, epost: AGARE, kod } });
  assert.equal(r.status, 200); assert.equal((await r.json()).status, "aterstallning_planerad"); assert.ok(aterstalld);
  assert.deepEqual(regRader(e, "SELECT klar FROM pitr_utlogg WHERE konto_id = ?", kontoId), [{ klar: null }], "markering före återställningen");
  // Omstart: objektet startar med det återställda läget (datorn aktiv igen, som vid bokmärket)
  gammal.storage.sql.exec("UPDATE enheter SET utloggad = NULL");
  e.PRO_KONTON.inst.set("k:" + kontoId, new ProKonto(gammal.state, e));
  assert.equal((await f(e, "/pro/konto/jag", { cookie: T_b })).status, 401, "den återkallade datorn väcks inte till liv");
  assert.equal((await f(e, "/pro/konto/jag", { cookie: T_a })).status, 401, "alla enheter måste logga in igen");
  assert.ok(regRader(e, "SELECT klar FROM pitr_utlogg WHERE konto_id = ?", kontoId)[0].klar > 0, "markeringen kvitterad");
  const lg = regRader(e, "SELECT handling, detalj FROM agarlogg WHERE konto_id = ? ORDER BY id", kontoId).map((x) => x.handling);
  assert.deepEqual(lg.slice(-3), ["pitr_begard", "pitr_planerad", "pitr_enheter_utloggade"]);
  // ny inloggning fungerar, och en senare omstart loggar inte ut igen (markeringen är klar)
  const T_c = await loggaIn(e, T1, "Ny");
  e.PRO_KONTON.inst.set("k:" + kontoId, new ProKonto(e.PRO_KONTON.inst.get("k:" + kontoId).state, e));
  assert.equal((await f(e, "/pro/konto/jag", { cookie: T_c })).status, 200, "ingen ny utloggning efter klar markering");
  // andra konton (ägaren) påverkas inte
  assert.equal((await f(e, "/pro/konto/jag", { cookie: O })).status, 200);
});

test("K2-fynd 2: misslyckad markering ger ingen återställning (502); registerfel i kontrollen efter omstart stoppar operationen (fail closed)", async () => {
  const e = kEnv(); const O = await loggaIn(e); await bjudIn(e, O, T1); const T = await loggaIn(e, T1);
  const kontoId = (await jag(e, T)).konto; const o = e.PRO_KONTON.inst.get("k:" + kontoId);
  let restore = 0; o.storage.getBookmarkForTime = async () => "bm"; o.storage.onNextSessionRestoreBookmark = async () => { restore++; };
  const orig = regObj(e).fetch; regObj(e).fetch = async (rq) => (new URL(rq.url).pathname === "/pitr_planera" ? Response.json({ fel: "x" }, { status: 500 }) : orig(rq));
  const r = await f(e, "/pro/konto/agare/pitr", { method: "POST", cookie: O, body: { konto: kontoId, tid_ms: NU - 1000, epost: AGARE, kod: await stegkod(e) } });
  assert.equal(r.status, 502); assert.deepEqual(await r.json(), { status: "pitr_misslyckades", orsak: "markering" }); assert.equal(restore, 0, "ingen återställning utan markering");
  regObj(e).fetch = async (rq) => (new URL(rq.url).pathname === "/pitr_status" ? Response.json({ fel: "x" }, { status: 500 }) : orig(rq));
  e.PRO_KONTON.inst.set("k:" + kontoId, new ProKonto(o.state, e));
  const j = await f(e, "/pro/konto/jag", { cookie: T }); assert.equal(j.status, 502, "kontrollen kunde inte göras: ingen operation"); A3(j, "502");
  regObj(e).fetch = orig;
  assert.equal((await f(e, "/pro/konto/jag", { cookie: T })).status, 200, "nästa anrop när registret svarar");
});

// ---------------- K2-fynd 3: e-post vid inloggning ----------------
test("K2-fynd 3: e-postadressen sparas och uppdateras vid lyckad inloggning med e-post och kod (även om den saknades); länkinloggning ändrar den inte", async () => {
  const e = kEnv(); const O = await loggaIn(e); await bjudIn(e, O, T1); const T = await loggaIn(e, T1);
  const kontoId = (await jag(e, T)).konto; const ko = () => e.PRO_KONTON.inst.get("k:" + kontoId).storage.sql;
  ko().exec("DELETE FROM meta");
  // koden begärs (adressen sätts då, K2) – töm igen så att bara inloggningen kan sätta den
  const m = await begarKod(e, T1); ko().exec("DELETE FROM meta");
  assert.equal((await f(e, "/pro/konto/logga-in", { method: "POST", body: { epost: "  Testare.Ett@Example.se ", kod: kodUr(m) } })).status, 200);
  assert.deepEqual(ko().exec("SELECT k, v FROM meta").toArray(), [{ k: "epost", v: T1 }], "sparad normaliserad vid inloggning");
  const m2 = await begarKod(e, T1); ko().exec("UPDATE meta SET v = 'gammal@example.se'");
  assert.equal((await f(e, "/pro/konto/logga-in", { method: "POST", body: { lank: lankUr(m2) } })).status, 200);
  assert.deepEqual(ko().exec("SELECT v FROM meta").toArray(), [{ v: "gammal@example.se" }], "länken bär ingen adress");
});

// ---------------- mejltexter ur KONTO_DELTA ----------------
test("KONTO_DELTA: MEJL.bekr, utfall_aterbetalas och utfall_avslutas byts bara när PRO_KONTO=\"inbjudna\"; i off är alla mejltexter oförändrade", () => {
  assert.equal(mejlTexter({ PRO_KONTO: "off" }), MEJL); assert.equal(mejlTexter({}), MEJL); assert.equal(mejlTexter({ PRO_KONTO: "Inbjudna" }), MEJL);
  assert.equal(mejlTexter({ PRO_KONTO: "inbjudna" }), MEJL_KONTO);
  const skiljer = Object.keys(MEJL).filter((k) => JSON.stringify(MEJL[k]) !== JSON.stringify(MEJL_KONTO[k]));
  assert.deepEqual(skiljer.sort(), ["bekr", "utfall_aterbetalas", "utfall_avslutas"]);
  const rad = MEJL_KONTO.bekr.filter((r, i) => r !== MEJL.bekr[i]);
  assert.deepEqual(rad, ["Dina projekt och offerter sparas på enheten. Loggar du in sparas de också i ditt konto."]);
  assert.equal(MEJL_KONTO.bekr.length, MEJL.bekr.length); assert.equal(MEJL_KONTO.bekr[MEJL_KONTO.bekr.length - 1], "{saljare}");
  for (const k of ["utfall_aterbetalas", "utfall_avslutas"]) {
    assert.ok(MEJL_KONTO[k].endsWith("Räknaren och materiallistan fungerar som förut. Hur du hämtar dina sparade projekt står i villkoren."), k);
    assert.ok(!MEJL_KONTO[k].includes("webbläsaren"), k);
    assert.equal(MEJL_KONTO[k].split(". ").slice(0, 2).join(". "), MEJL[k].split(". ").slice(0, 2).join(". "), k + ": bara sista meningen ändrad");
  }
});

test("maskera: första tecken i namn och domän, toppdomänen kvar", () => {
  assert.equal(maskera("anna.svensson@exempel.se"), "a***@e***.se");
  assert.equal(maskera("B@sub.foretag.com"), "b***@s***.com");
  assert.equal(maskera("x"), "***");
});

// Anders 2026-10-28 requests two additional pilots; existing six keep their rights.
test("eighth seat can be invited without changing previous seats; ninth remains blocked before OTP consumption", async () => {
  const e = kEnv(), O = await loggaIn(e); const old = [];
  for (const ep of [T1, T2, T3, T4, T5, T6, T7]) { const x = await bjudIn(e, O, ep); assert.equal(x.r.status, 200); old.push(x.j.testplats); }
  const d = await bjudIn(e, O, T8); assert.equal(d.r.status, 200, "eighth seat must be admitted");
  const list = await (await agare(e, O, "testplatser")).json();
  assert.equal(list.max, 8); assert.equal(list.aktiva, 8);
  for (const p of old) assert.deepEqual(list.testplatser.find((x) => x.id === p.id), p, "existing seats unchanged");
  const code = await stegkod(e);
  const full = await agare(e, O, "inbjud", { epost: T9, kod: code });
  assert.equal(full.status, 409); assert.deepEqual(await full.json(), { status: "fullt", max: 8 });
  const revoke = await agare(e, O, "aterkalla", { id: d.j.testplats.id, kod: code });
  assert.equal(revoke.status, 200, "capacity rejection must not consume owner code");
  assert.equal((await jag(e, await loggaIn(e, T1))).roll, "test");
});
