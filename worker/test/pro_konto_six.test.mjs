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
const AGARE = "anders@stahledigital.se", T1 = "testare.ett@example.se", T2 = "testare.tva@example.se", T3 = "testare.tre@example.se", T4 = "testare.fyra@example.se", T5 = "testare.fem@example.se", T6 = "testare.sex@example.se";
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

// Anders 2026-10-25: sixth additional free PRO seat; existing five stay intact.
const T7='testare.sju@example.se';
test('six seats: real owner handler admits sixth, preserves five, rejects seventh before step-up consumption',async()=>{
 const e=kEnv(),O=await loggaIn(e),old=[];
 for(const ep of[T1,T2,T3,T4,T5]){const x=await bjudIn(e,O,ep);assert.equal(x.r.status,200);old.push(x.j.testplats);}
 const six=await bjudIn(e,O,T6);assert.equal(six.r.status,200,'sixth actual invite');assert.equal(six.j.testplats.slut,nuS()+30*DAG);assert.equal(six.j.mejl,'av');A3(six.r,'sixth');
 const l=await agare(e,O,'testplatser'),j=await l.json();assert.equal(l.status,200);assert.equal(j.max,6);assert.equal(j.aktiva,6);assert.equal(j.testplatser.length,6);assert.equal(MAX_TESTPLATSER,6);
 for(const p of old)assert.deepEqual(j.testplatser.find(x=>x.id===p.id),p,'original seat bytes');
 const sixthSession=await loggaIn(e,T6);
 const code=await stegkod(e),seven=await agare(e,O,'inbjud',{epost:T7,kod:code});assert.equal(seven.status,409);assert.deepEqual(await seven.json(),{status:'fullt',max:6});A3(seven,'seventh');
 assert.deepEqual((await(await agare(e,O,'testplatser')).json()).testplatser,j.testplatser,'rejection leaves all seats intact');
 assert.equal((await agare(e,O,'aterkalla',{id:six.j.testplats.id,kod:code})).status,200,'full response did not consume code');
 for(const ep of[T1,T2,T3,T4,T5])assert.equal((await jag(e,await loggaIn(e,ep))).roll,'test','old test right');
 assert.equal((await jag(e,sixthSession)).roll,'ingen','revoked sixth');assert.deepEqual(natAnrop.filter(u=>u!=='https://api.resend.com/emails'),[]);
});
test('sixth needs actual owner step-up; non-owner and expired code cannot take additional seat',async()=>{
 const e=kEnv(),O=await loggaIn(e);for(const ep of[T1,T2,T3,T4,T5])assert.equal((await bjudIn(e,O,ep)).r.status,200);
 const before=await(await agare(e,O,'testplatser')).json();assert.equal((await agare(e,O,'inbjud',{epost:T6})).status,401);
 const T=await loggaIn(e,T1);assert.equal((await agare(e,T,'inbjud',{epost:T6,kod:'123456'})).status,403);
 const stale=await stegkod(e);fram(11*60);assert.equal((await agare(e,O,'inbjud',{epost:T6,kod:stale})).status,401);
 const after=await(await agare(e,O,'testplatser')).json();assert.deepEqual(after.testplatser,before.testplatser);assert.equal(after.aktiva,5);assert.equal((await bjudIn(e,O,T6)).r.status,200);
});
test('expired seat extension shares six-capacity boundary and rejection code can free one seat',async()=>{
 const e=kEnv(),O=await loggaIn(e),expired=await bjudIn(e,O,T7,{slut:nuS()+DAG});assert.equal(expired.r.status,200);fram(2*DAG);
 for(const ep of[T1,T2,T3,T4,T5,T6])assert.equal((await bjudIn(e,O,ep)).r.status,200);
 const list=await(await agare(e,O,'testplatser')).json();assert.equal(list.aktiva,6);assert.equal(list.testplatser.find(x=>x.id===expired.j.testplats.id).status,'utgangen');
 const code=await stegkod(e),r=await agare(e,O,'forlang',{id:expired.j.testplats.id,slut:nuS()+30*DAG,kod:code});assert.equal(r.status,409);assert.deepEqual(await r.json(),{status:'fullt',max:6});
 const sixth=list.testplatser.find(x=>x.id!==expired.j.testplats.id&&x.status==='aktiv');assert.equal((await agare(e,O,'aterkalla',{id:sixth.id,kod:code})).status,200);
 assert.equal((await agare(e,O,'forlang',{id:expired.j.testplats.id,slut:nuS()+30*DAG,kod:await stegkod(e)})).status,200);
 const after=await(await agare(e,O,'testplatser')).json();assert.equal(after.aktiva,6);assert.equal(after.max,6);
});
