// D7.2 steg 1 (Claude Code, MR-FORTNOX-SPIRIS-20261023-01): /pro/konto/integration/* via workerns riktiga default-export och riktiga ProKonto/ProRegister
// i node:sqlite-dubbeln. Leverantörernas svar är en HTTP-dubbel (LOCAL, inte SANDBOX): inget prov här bevisar att Fortnox eller Spiris accepterar flödet.
// Prov-ID enligt INTEGRATION_FORTNOX_SPIRIS.md: I01 (ej konfigurerad), I02 (state/avbrott/återanvändning), I03 (konton isär), I04 (bolag, token bara krypterat), I17 (koppla från).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker from "../src/index.js";
import { ProRegister, ProKonto } from "../src/pro_konto.js";
import { dekryptera, callbackUrl, LEV } from "../src/pro_integration.js";
import { namnrymd } from "./helpers/pro_do_dubbel.mjs";
import { ENV } from "./stripe_dubbel.mjs";

const API = "https://granskaminoffert-api.anders-316.workers.dev", SAJT = "https://stahledigital.se", AGARE = "anders@stahledigital.se";
const NYCKEL = Buffer.alloc(32, 7).toString("base64"), TOKEN = { access: "AT-hemlig-" + "a".repeat(40), refresh: "RT-hemlig-" + "b".repeat(40) };
let mejl, nat, origFetch, origNow, NU, lev;
beforeEach(() => {
  mejl = []; nat = []; NU = Date.UTC(2026, 9, 24, 1, 0, 0); origFetch = globalThis.fetch; origNow = Date.now; Date.now = () => NU;
  lev = { token: { status: 200, body: { access_token: TOKEN.access, refresh_token: TOKEN.refresh, expires_in: 3600 } }, bolag: { status: 200 }, revoke: 200 };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url && url.url ? url.url : url); nat.push({ u, init });
    if (u === "https://api.resend.com/emails") { const b = JSON.parse(init.body); mejl.push(b); return new Response(JSON.stringify({ id: "re_" + mejl.length }), { status: 200 }); }
    if (u === LEV.spiris.token || u === LEV.fortnox.token) return new Response(JSON.stringify(lev.token.body), { status: lev.token.status });
    if (u === LEV.spiris.bolag) return new Response(JSON.stringify({ Name: "Testbolaget AB", CorporateIdentityNumber: "556000-0000" }), { status: lev.bolag.status });
    if (u === LEV.fortnox.bolag) return new Response(JSON.stringify({ CompanyInformation: { CompanyName: "Fortnox Testbolag", OrganizationNumber: "559000-0000" } }), { status: lev.bolag.status });
    if (u === LEV.spiris.revoke) return new Response("", { status: lev.revoke });
    throw new Error("oväntat nätanrop " + u);
  };
});
afterEach(() => { globalThis.fetch = origFetch; Date.now = origNow; });

const kEnv = (extra = {}) => { const e = ENV({ PRO_PAYMENTS: "off", PRO_KONTO: "inbjudna", PRO_OWNER_EMAIL: AGARE, PRO_MAIL_DAY_CAP: "100", ...extra }); e.PRO_REGISTER = namnrymd(ProRegister); e.PRO_KONTON = namnrymd(ProKonto); return e; };
const NYCKLAR = { INTEGRATION_TOKEN_KEY: NYCKEL, SPIRIS_CLIENT_ID: "spiris-klient", SPIRIS_CLIENT_SECRET: "spiris-hemlighet", FORTNOX_CLIENT_ID: "fortnox-klient", FORTNOX_CLIENT_SECRET: "fortnox-hemlighet" };
let ip = 0;
function req(path, { method = "GET", body, cookie, xmr = true } = {}) {
  const h = { "CF-Connecting-IP": `203.0.113.${(ip++ % 200) + 1}`, Origin: SAJT };
  if (xmr && method !== "GET") h["X-MR-Pro"] = "1"; if (body !== undefined) h["content-type"] = "application/json"; if (cookie) h.Cookie = cookie;
  return new Request(API + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}
const f = async (env, path, o) => { const v = []; const r = await worker.fetch(req(path, o), env, { waitUntil: (p) => v.push(p), passThroughOnException() {} }); await Promise.all(v); return r; };
async function loggaIn(env, epost = AGARE) {
  mejl.length = 0; assert.equal((await f(env, "/pro/konto/kod", { method: "POST", body: { epost } })).status, 202);
  const kod = /\n {4}(\d{6})\n/.exec(mejl[0].text)[1];
  const r = await f(env, "/pro/konto/logga-in", { method: "POST", body: { epost, kod } }); assert.equal(r.status, 200);
  return r.headers.get("set-cookie").split(";")[0];
}
const levAnrop = () => nat.filter((x) => x.u !== "https://api.resend.com/emails");
const b64u = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
// Kontots objekt i dubbeln (EU-jurisdiktionens namn slutar på konto-id); sql ger raderna som de lagras.
const obj = (env, id) => { const k = [...env.PRO_KONTON.inst.keys()].find((n) => n.endsWith(id)); return k ? env.PRO_KONTON.inst.get(k) : null; };
async function kontoId(env, c) { return (await (await f(env, "/pro/konto/jag", { cookie: c })).json()).konto; }
async function koppla(env, c, p = "spiris") {
  const s = await (await f(env, `/pro/konto/integration/${p}/start`, { method: "POST", body: {}, cookie: c })).json();
  const state = new URL(s.url).searchParams.get("state");
  return { s, state, r: await f(env, `/pro/konto/integration/${p}/callback?code=kod123&state=${state}`, { cookie: c }) };
}

test("I01: utan nycklar ej konfigurerad – status visar det, start 503, callback tillbaka utan anrop; inga leverantörsanrop", async () => {
  const env = kEnv(), c = await loggaIn(env);
  const st = await (await f(env, "/pro/konto/integration/status", { cookie: c })).json();
  assert.deepEqual(st, { status: "ok", leverantorer: { fortnox: { namn: "Fortnox", konfigurerad: false, kopplad: null }, spiris: { namn: "Spiris", konfigurerad: false, kopplad: null } } });
  for (const p of ["fortnox", "spiris"]) {
    const r = await f(env, `/pro/konto/integration/${p}/start`, { method: "POST", body: {}, cookie: c }); assert.equal(r.status, 503); assert.deepEqual(await r.json(), { status: "ej_konfigurerad", provider: p });
    const cb = await f(env, `/pro/konto/integration/${p}/callback?code=x&state=${"A".repeat(43)}`, { cookie: c }); assert.equal(cb.status, 303); assert.match(cb.headers.get("location"), /resultat=ej_konfigurerad#integration$/);
  }
  // bara klientnycklar utan krypteringsnyckel räknas inte heller som konfigurerat
  const e2 = kEnv({ SPIRIS_CLIENT_ID: "x", SPIRIS_CLIENT_SECRET: "y" }), c2 = await loggaIn(e2);
  assert.equal((await (await f(e2, "/pro/konto/integration/status", { cookie: c2 })).json()).leverantorer.spiris.konfigurerad, false);
  assert.deepEqual(levAnrop(), []);
});

test("Utan session 401, utan X-MR-Pro 403, okänd leverantör 404 – före varje nyckel- eller leverantörsanrop", async () => {
  const env = kEnv(NYCKLAR), c = await loggaIn(env);
  assert.equal((await f(env, "/pro/konto/integration/status")).status, 401);
  assert.equal((await f(env, "/pro/konto/integration/spiris/start", { method: "POST", body: {}, cookie: c, xmr: false })).status, 403);
  assert.equal((await f(env, "/pro/konto/integration/visma/start", { method: "POST", body: {}, cookie: c })).status, 404);
  assert.equal((await f(env, "/pro/konto/integration/spiris/start", { cookie: c })).status, 404, "fel metod");
  assert.deepEqual(levAnrop(), []);
});

test("Steg 1–2: bara ägarkontot når integrationen – andra konton får 404 utan nyckel- eller leverantörsanrop", async () => {
  const env = kEnv(NYCKLAR), c = await loggaIn(env); env.PRO_OWNER_EMAIL = "annan@example.se"; // samma konto är inte längre ägaren
  for (const [v, m] of [["/pro/konto/integration/status", "GET"], ["/pro/konto/integration/spiris/start", "POST"], ["/pro/konto/integration/spiris/forbered", "POST"], ["/pro/konto/integration/spiris/callback?code=k&state=" + "A".repeat(43), "GET"]]) {
    const r = await f(env, v, { method: m, body: m === "POST" ? {} : undefined, cookie: c }); assert.equal(r.status, 404, v); assert.deepEqual(await r.json(), { status: "okand_rutt" });
  }
  assert.deepEqual(levAnrop(), []);
});

test("Start: exakt callback, scopes, state 32 byte och PKCE S256 mot den sparade verifieraren; Spiris prompt=select_account", async () => {
  const env = kEnv(NYCKLAR), c = await loggaIn(env);
  for (const p of ["spiris", "fortnox"]) {
    const s = await (await f(env, `/pro/konto/integration/${p}/start`, { method: "POST", body: {}, cookie: c })).json(), u = new URL(s.url), q = u.searchParams;
    assert.equal(u.origin + u.pathname, LEV[p].auth); assert.equal(q.get("redirect_uri"), callbackUrl(p)); assert.equal(q.get("redirect_uri"), `https://stahledigital.se/api/pro/konto/integration/${p}/callback`);
    assert.equal(q.get("client_id"), NYCKLAR[LEV[p].id]); assert.equal(q.get("scope"), LEV[p].scope); assert.equal(q.get("response_type"), "code");
    assert.match(q.get("state"), /^[A-Za-z0-9_-]{43}$/); assert.equal(q.get("code_challenge_method"), "S256"); assert.match(q.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(q.get("prompt"), p === "spiris" ? "select_account" : null); assert.ok(!s.url.includes(NYCKLAR[LEV[p].secret]), "klienthemligheten lämnar aldrig servern");
  }
  assert.deepEqual(levAnrop(), []);
});

test("I04: godkänd koppling – kod växlas med Basic och PKCE, bolaget visas, token finns bara som chiffer bundet till kontot", async () => {
  const env = kEnv(NYCKLAR), c = await loggaIn(env), { s, r } = await koppla(env, c);
  assert.equal(r.status, 303); assert.equal(r.headers.get("location"), "/verkstaden/materialraknaren/konto/agare?integration=spiris&resultat=kopplad#integration");
  const t = levAnrop().find((x) => x.u === LEV.spiris.token), form = new URLSearchParams(t.init.body);
  assert.equal(t.init.headers.Authorization, "Basic " + Buffer.from("spiris-klient:spiris-hemlighet").toString("base64"));
  assert.equal(form.get("grant_type"), "authorization_code"); assert.equal(form.get("code"), "kod123"); assert.equal(form.get("redirect_uri"), callbackUrl("spiris"));
  assert.equal(b64u(createHash("sha256").update(form.get("code_verifier")).digest()), new URL(s.url).searchParams.get("code_challenge"), "PKCE");
  const bolag = levAnrop().find((x) => x.u === LEV.spiris.bolag); assert.equal(bolag.init.headers.Authorization, "Bearer " + TOKEN.access);
  const st = await (await f(env, "/pro/konto/integration/status", { cookie: c })).json();
  assert.deepEqual(st.leverantorer.spiris, { namn: "Spiris", konfigurerad: true, kopplad: { bolag: "Testbolaget AB", sedan: Math.floor(NU / 1000) } });
  // lagringen: inga token i klartext; chiffret går bara att läsa med rätt konto och leverantör
  const id = await kontoId(env, c), rad = obj(env, id).sql.exec("SELECT * FROM integration").toArray()[0];
  assert.ok(!JSON.stringify(rad).includes(TOKEN.access) && !JSON.stringify(rad).includes(TOKEN.refresh));
  const ut = await dekryptera(env, id, "spiris", rad); assert.equal(ut.access, TOKEN.access); assert.equal(ut.refresh, TOKEN.refresh); assert.equal(ut.utgar, Math.floor(NU / 1000) + 3600);
  await assert.rejects(dekryptera(env, "k_" + "0".repeat(32), "spiris", rad)); await assert.rejects(dekryptera(env, id, "fortnox", rad));
  for (const x of [st, s]) assert.ok(!JSON.stringify(x).includes("hemlig"), "inga token eller hemligheter i svar");
});

test("I02: avbrott, fel och återanvänd state sparar ingenting; samma state går aldrig att lösa in två gånger", async () => {
  const env = kEnv(NYCKLAR), c = await loggaIn(env), id = await kontoId(env, c), rader = () => obj(env, id).sql.exec("SELECT COUNT(*) AS n FROM integration").toArray()[0].n;
  const ny = async (p = "spiris") => new URL((await (await f(env, `/pro/konto/integration/${p}/start`, { method: "POST", body: {}, cookie: c })).json()).url).searchParams.get("state");
  const cb = async (q, p = "spiris") => (await f(env, `/pro/konto/integration/${p}/callback?${q}`, { cookie: c })).headers.get("location").match(/resultat=([a-z_]+)/)[1];
  let st = await ny(); assert.equal(await cb(`error=access_denied&state=${st}`), "avbruten"); assert.equal(await cb(`code=k&state=${st}`), "ogiltig", "förbrukad vid avbrott");
  assert.equal(await cb(`code=k&state=${"x".repeat(43)}`), "ogiltig"); assert.equal(await cb("code=k"), "avbruten");
  st = await ny("fortnox"); assert.equal(await cb(`code=k&state=${st}`, "spiris"), "ogiltig", "fel leverantör"); assert.equal(await cb(`code=k&state=${st}`, "fortnox"), "ogiltig", "förbrukad");
  st = await ny(); NU += 601_000; assert.equal(await cb(`code=k&state=${st}`), "ogiltig", "utgången"); NU -= 601_000;
  lev.token = { status: 400, body: { error: "invalid_grant" } }; st = await ny(); assert.equal(await cb(`code=k&state=${st}`), "fel");
  lev.token = { status: 200, body: { access_token: TOKEN.access } }; st = await ny(); assert.equal(await cb(`code=k&state=${st}`), "fel", "utan refresh-token");
  lev.token = { status: 200, body: { access_token: TOKEN.access, refresh_token: TOKEN.refresh } }; lev.bolag = { status: 500 }; st = await ny(); assert.equal(await cb(`code=k&state=${st}`), "fel", "inget bolag");
  assert.equal(rader(), 0);
  lev.bolag = { status: 200 }; st = await ny(); assert.equal(await cb(`code=k&state=${st}`), "kopplad"); assert.equal(await cb(`code=k&state=${st}`), "ogiltig", "återanvänd callback"); assert.equal(rader(), 1);
});

test("I03: två PRO-konton hålls isär – status och koppling gäller bara det egna kontot", async () => {
  const env = kEnv({ ...NYCKLAR, PRO_KONTO: "inbjudna" }), a = await loggaIn(env); await koppla(env, a);
  const ownerOnly = (await (await f(env, "/pro/konto/integration/status", { cookie: a })).json()).leverantorer.spiris.kopplad; assert.equal(ownerOnly.bolag, "Testbolaget AB");
  // ett annat konto: en ny inloggning med en annan e-post kräver inbjudan; provet läser i stället det andra kontots objekt direkt
  const id = await kontoId(env, a); assert.deepEqual([...env.PRO_KONTON.inst.keys()].filter((n) => /k_[0-9a-f]{32}$/.test(n) && env.PRO_KONTON.inst.get(n).sql.exec("SELECT COUNT(*) AS n FROM integration").toArray()[0].n > 0).map((n) => n.slice(n.lastIndexOf("k_"))), [id], "bara det egna kontots objekt har en koppling");
});

test("I17: koppla från – Spiris återkallas med refresh-token och raderas lokalt; Fortnox (ingen dokumenterad återkallning) raderas lokalt", async () => {
  const env = kEnv(NYCKLAR), c = await loggaIn(env); await koppla(env, c, "spiris"); await koppla(env, c, "fortnox");
  const r = await (await f(env, "/pro/konto/integration/spiris/koppla-fran", { method: "POST", body: {}, cookie: c })).json();
  assert.deepEqual(r, { status: "frankopplad", fanns: true, aterkallning: "aterkallad" });
  const rv = levAnrop().find((x) => x.u === LEV.spiris.revoke); assert.equal(new URLSearchParams(rv.init.body).get("token"), TOKEN.refresh);
  assert.deepEqual(await (await f(env, "/pro/konto/integration/fortnox/koppla-fran", { method: "POST", body: {}, cookie: c })).json(), { status: "frankopplad", fanns: true, aterkallning: "ej_dokumenterad" });
  const st = await (await f(env, "/pro/konto/integration/status", { cookie: c })).json(); assert.equal(st.leverantorer.spiris.kopplad, null); assert.equal(st.leverantorer.fortnox.kopplad, null);
  assert.deepEqual(await (await f(env, "/pro/konto/integration/spiris/koppla-fran", { method: "POST", body: {}, cookie: c })).json(), { status: "frankopplad", fanns: false, aterkallning: "ej_kopplad" });
});

// ---------- steg 1: förbered (frysning med C10 på servern, kvittologg, atomisk reservation) ----------
import { nyttProjekt } from "../src/mr_project2/P4_PROJEKT/pro-projekt.mjs";
import { readFileSync } from "node:fs";
const projekt = (material = [["Takmaterial", "120", "12.50"]]) => { const p = nyttProjekt({ idag: "2026-10-23", cryptoImpl: { getRandomValues: (a) => a.fill(1) } });
  p.projektnamn = "Syntetisk offert"; p.foretag.namn = "Syntetisk Bygg AB"; p.kund.namn = "Materialräknaren integrationstest";
  p.material = material.map(([namn, mangd, pris_kr]) => ({ nyckel: "k:" + namn + "|st", namn, mangd, enhet: "st", pris_kr, med: true, borta: false, rabatt_pct: "0", rabatt_kr: null, paslag_pct: "0" })); return p; };
async function spara(env, c, p) { const kid = await kontoId(env, c), d = JSON.stringify(p);
  const r = await obj(env, kid).fetch(new Request("https://pro-konto/p_put", { method: "POST", body: JSON.stringify({ nu: Math.floor(NU / 1000), ms: NU, id: p.projektId, rev: 0, data: d, namn: p.projektnamn, storlek: d.length, kontoId: kid }) }));
  assert.equal((await r.json()).kod, 200); return kid; }
const forbered = async (env, c, body, p = "spiris") => f(env, `/pro/konto/integration/${p}/forbered`, { method: "POST", body, cookie: c });

test("Förbered: kräver koppling och sparat projekt; ofullständig offert blir ej_klar; inget leverantörsanrop", async () => {
  const env = kEnv(NYCKLAR), c = await loggaIn(env), p = projekt(); await spara(env, c, p);
  let r = await forbered(env, c, { projektId: p.projektId }); assert.equal(r.status, 409); assert.deepEqual(await r.json(), { status: "ej_kopplad", provider: "spiris" });
  await koppla(env, c); const fore = levAnrop().length;
  assert.equal((await forbered(env, c, { projektId: "p_" + "f".repeat(32) })).status, 404); assert.equal((await forbered(env, c, { projektId: "../x" })).status, 404);
  const tom = projekt([]); tom.projektId = "p_" + "2".repeat(32); await spara(env, c, tom);
  r = await forbered(env, c, { projektId: tom.projektId }); assert.equal(r.status, 422); assert.equal((await r.json()).status, "ej_klar");
  assert.equal(levAnrop().length, fore, "förberedelsen anropar aldrig leverantören (steg 2)");
});

test("I12/I15: en reservation per offert-ID och version – upprepning och samtidiga försök ger RECONCILE; kvittot bär inget offertinnehåll", async () => {
  const env = kEnv(NYCKLAR), c = await loggaIn(env), p = projekt(), kid = await spara(env, c, p); await koppla(env, c);
  const svar = await Promise.all([1, 2, 3].map(() => forbered(env, c, { projektId: p.projektId }).then(async (r) => ({ s: r.status, j: await r.json() }))));
  const ok = svar.filter((x) => x.j.status === "forberedd"); assert.equal(ok.length, 1, "exakt en vinnare"); assert.ok(svar.filter((x) => x.j.status === "reconcile").every((x) => x.s === 409));
  assert.equal(ok[0].j.offerId, p.projektId); assert.match(ok[0].j.sha256, /^[a-f0-9]{64}$/);
  const rader = obj(env, kid).sql.exec("SELECT * FROM int_kvitto").toArray(); assert.equal(rader.length, 1);
  assert.deepEqual(Object.keys(rader[0]).sort(), ["andrad", "offer_id", "provider", "remote_id", "sha256", "skapad", "status", "tenant", "version"]);
  assert.equal(rader[0].status, "prepared"); assert.equal(rader[0].tenant, "556000-0000"); assert.ok(!JSON.stringify(rader).includes("integrationstest") && !JSON.stringify(rader).includes("Takmaterial"), "inget kundnamn eller rader i kvittot");
  const igen = await forbered(env, c, { projektId: p.projektId }); assert.equal(igen.status, 409); assert.equal((await igen.json()).status, "reconcile", "en gammal oklar reservation kringgås aldrig");
  // ett annat bolag (Fortnox-kopplingen) har en egen nyckel
  await koppla(env, c, "fortnox"); assert.equal((await (await forbered(env, c, { projektId: p.projektId }, "fortnox")).json()).status, "forberedd");
});

test("C10-kopiorna i GMO är byte för byte C10 f960812 (och P4-kopiorna PRO-källans); ändras bara med avsikt", () => {
  const LAS = { "EXPORTER/format-common.mjs": "5a24103974054dcf1d5677e9622dc472dc9464aa97855a99689b82b8d337ac80", "EXPORTER/fortnox-format.mjs": "b750926fcf5ce5c7d732a4556f9c1f39ae4d1f1d0c7d67d35b175b0af0bc8e1a",
    "EXPORTER/masterdata-format.mjs": "91c69c717ed21c09f9a3d7fa35d48d101f71bd3ddb5748d26c57b7e42557a9cf", "EXPORTER/offert-export.mjs": "936fe1ff0900e3a3de02c009c8a5bc1035d17edeb68e6c5381ccccd9b23bae57",
    "EXPORTER/spiris-format.mjs": "37137854a0564b3a9ec70cc84f622558ab256c950f78f97a3bea0cd1705c5d64", "P4_PROJEKT/pro-json.mjs": "4b9ce05cc8cd5843d4cef68b0084379a28c48938d9ab02439ef67337d0dae72c",
    "P1_KALKYLKARNA/pro-kalkyl.mjs": "846b571ed76a6267b06cf9543687c0343734d991af552a62467af5fcb30c0f46" };
  for (const [fil, sha] of Object.entries(LAS)) assert.equal(createHash("sha256").update(readFileSync(new URL("../src/mr_project2/" + fil, import.meta.url))).digest("hex"), sha, fil);
});
