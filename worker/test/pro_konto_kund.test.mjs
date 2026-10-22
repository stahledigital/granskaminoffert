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


async function paidAccount(e, id) {
 await ge(e, TEST_A, nuS()+86400); const a=await loggaIn(e,TEST_A,'A'),b=await loggaIn(e,TEST_A,'B');
 const j=await jag(e,a); assert.equal((await register(e,'koppla_projekt',{nu:nuS(),kontoId:j.konto,projektId:id,slut:nuS()+30*86400})).ok,true);
 await register(e,'testbevis',{nu:nuS(),ehash:await epostHash(e,TEST_A),aterkalla:true});
 assert.equal((await jag(e,a)).roll,'projekt'); return {a,b};
}
test('Engångsköp: samma kund över två kontoenheter; priser/rabatter/revisioner bevaras',async()=>{
 const e=kEnv(),id=pid(710),{a,b}=await paidAccount(e,id);
 const p=projekt(id,{kund:{namn:'Testkund A'},material:[{namn:'Test',mangd:'10',enhet:'st',pris_kr:'100',rabatt_pct:'25',med:true}],orderrabatt:{pct:'12'}});
 assert.equal((await put(e,a,id,0,p)).status,200);
 assert.equal((await jag(e,b)).kundlas[id],undefined,'autosparning får inte låsa ett halvskrivet namn');
 assert.equal((await f(e,'/pro/konto/projekt/'+id+'/dokument',{cookie:a,method:'POST',body:{rev:1}})).status,200);assert.equal((await jag(e,b)).kundlas[id],'Testkund A');
 const q=structuredClone(p);q.kund.namn='Testkund B';
 const r=await put(e,b,id,1,q);assert.equal(r.status,409);assert.equal((await r.json()).server.data.kund.namn,'Testkund A');
 p.material[0].pris_kr='200';assert.equal((await put(e,b,id,1,p)).status,200);
 const saved=await(await f(e,'/pro/konto/projekt/'+id,{cookie:a})).json();
 assert.equal(saved.projekt.data.material[0].rabatt_pct,'25');assert.deepEqual(saved.projekt.data.orderrabatt,{pct:'12'});
 assert.equal(saved.projekt.data.material[0].pris_kr,'200');
 assert.equal((await put(e,b,pid(711),0,projekt(pid(711)))).status,403,'serverns projektscope får inte breddas');
});
test('Tom kund låses först när den anges; full test/ägarroll får ändra utan falskt projektlås',async()=>{
 const e=kEnv(),id=pid(712),{a,b}=await paidAccount(e,id),p=projekt(id,{kund:{namn:''}});
 assert.equal((await put(e,a,id,0,p)).status,200);assert.equal((await jag(e,b)).kundlas[id],undefined);
 p.kund.namn='Första kund';assert.equal((await put(e,b,id,1,p)).status,200);assert.equal((await f(e,'/pro/konto/projekt/'+id+'/dokument',{cookie:b,method:'POST',body:{rev:2}})).status,200);assert.equal((await jag(e,a)).kundlas[id],'Första kund');
 await ge(e,TEST_A,nuS()+86400);p.kund.namn='Andra kund';assert.equal((await put(e,b,id,2,p)).status,200);
 assert.deepEqual((await jag(e,b)).kundlas,{},'full kontorätt ska inte få ett begränsat kundlås');
 await register(e,'testbevis',{nu:nuS(),ehash:await epostHash(e,TEST_A),aterkalla:true});
 assert.equal((await jag(e,a)).kundlas[id],'Andra kund');assert.equal((await put(e,b,id,3,p)).status,200);
 assert.equal((await del(e,b,id,4)).status,200);assert.deepEqual((await jag(e,b)).kundlas,{});
});
// Å22 (Claude Code 2026-10-22): internt underlag och rättsprovet vid kvittot binder inget kundnamn; kundofferten och äldre klienter
// (utan typ) binder som förut; ett befintligt lås gäller för alla typer; okänd typ avvisas.
test('Å22: bara kundoffert (eller anrop utan typ) binder kundnamnet; intern och kontroll prövar rätt utan att binda',async()=>{
 const e=kEnv(),id=pid(720),{a,b}=await paidAccount(e,id),p=projekt(id,{kund:{namn:'Felstavat namn'}});
 assert.equal((await put(e,a,id,0,p)).status,200);
 for(const typ of ['intern','kontroll']){const r=await f(e,'/pro/konto/projekt/'+id+'/dokument',{cookie:a,method:'POST',body:{rev:1,typ}});assert.equal(r.status,200,typ);assert.equal((await r.json()).kund,null,typ);}
 assert.equal((await jag(e,b)).kundlas[id],undefined,'internt underlag låser inte');
 p.kund.namn='Rätt namn';assert.equal((await put(e,b,id,1,p)).status,200,'namnet går att rätta efter internt underlag');
 assert.equal((await f(e,'/pro/konto/projekt/'+id+'/dokument',{cookie:a,method:'POST',body:{rev:2,typ:'okand'}})).status,400);
 const k=await f(e,'/pro/konto/projekt/'+id+'/dokument',{cookie:a,method:'POST',body:{rev:2,typ:'kund'}});assert.equal(k.status,200);assert.equal((await k.json()).kund,'Rätt namn');
 assert.equal((await jag(e,b)).kundlas[id],'Rätt namn');
 const i=await f(e,'/pro/konto/projekt/'+id+'/dokument',{cookie:b,method:'POST',body:{rev:2,typ:'intern'}});assert.equal(i.status,200);assert.equal((await i.json()).kund,'Rätt namn','befintligt lås rapporteras även för intern');
 const q=structuredClone(p);q.kund.namn='Annan kund';assert.equal((await put(e,b,id,2,q)).status,409,'låset gäller fortfarande vid sparning');
});
test('Å22: äldre klient utan typ binder vid första PDF som förut',async()=>{
 const e=kEnv(),id=pid(721),{a,b}=await paidAccount(e,id);
 assert.equal((await put(e,a,id,0,projekt(id,{kund:{namn:'Kund Utan Typ'}}))).status,200);
 assert.equal((await f(e,'/pro/konto/projekt/'+id+'/dokument',{cookie:a,method:'POST',body:{rev:1}})).status,200);
 assert.equal((await jag(e,b)).kundlas[id],'Kund Utan Typ');
});
// Anders beslut 2026-10-22: kundoffert vid projektköp kräver ifyllt kundnamn; internt underlag och kontroll påverkas inte.
test('Kundnamn krävs: kundoffert med tomt namn ger 422 och binder inget; intern går; ifyllt namn binder',async()=>{
 const e=kEnv(),id=pid(730),{a,b}=await paidAccount(e,id),p=projekt(id,{kund:{namn:'   '}});
 assert.equal((await put(e,a,id,0,p)).status,200);
 for(const body of [{rev:1,typ:'kund'},{rev:1}]){const r=await f(e,'/pro/konto/projekt/'+id+'/dokument',{cookie:a,method:'POST',body});assert.equal(r.status,422);assert.equal((await r.json()).status,'kundnamn_saknas');}
 assert.equal((await f(e,'/pro/konto/projekt/'+id+'/dokument',{cookie:a,method:'POST',body:{rev:1,typ:'intern'}})).status,200);
 assert.equal((await jag(e,b)).kundlas[id],undefined);
 p.kund.namn='Kund Ifylld';assert.equal((await put(e,a,id,1,p)).status,200);
 assert.equal((await f(e,'/pro/konto/projekt/'+id+'/dokument',{cookie:a,method:'POST',body:{rev:2,typ:'kund'}})).status,200);
 assert.equal((await jag(e,b)).kundlas[id],'Kund Ifylld');
});
test('Kundnamn krävs: osynliga tecken räcker inte, kontroll går med tomt namn, låst namn går före',async()=>{
 const e=kEnv(),id=pid(731),{a,b}=await paidAccount(e,id),p=projekt(id,{kund:{namn:'\u200b\u00a0'}});
 assert.equal((await put(e,a,id,0,p)).status,200);
 assert.equal((await f(e,'/pro/konto/projekt/'+id+'/dokument',{cookie:a,method:'POST',body:{rev:1,typ:'kund'}})).status,422);
 assert.equal((await f(e,'/pro/konto/projekt/'+id+'/dokument',{cookie:a,method:'POST',body:{rev:1,typ:'kontroll'}})).status,200);
 assert.equal((await f(e,'/pro/konto/projekt/'+id+'/dokument',{cookie:a,method:'POST',body:{rev:1,typ:null}})).status,400);
 p.kund.namn='Låst Kund';assert.equal((await put(e,a,id,1,p)).status,200);
 assert.equal((await f(e,'/pro/konto/projekt/'+id+'/dokument',{cookie:a,method:'POST',body:{rev:2,typ:'kund'}})).status,200);
 const q=structuredClone(p);q.kund.namn='';const r=await put(e,b,id,2,q);assert.equal(r.status,409,'låset gäller vid sparning');
});
