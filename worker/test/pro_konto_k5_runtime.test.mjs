// KONTO-SYNK K5 del A (ägar-API, steg-kod, testplats, återkallelse, ingen kunddata) i lokal workerd. Samma uppsättning som K1/K2:s körtidsprov:
// KONTO-SYNK K1 i lokal workerd (Miniflare): RIKTIG produktionsingång (esbuild som wrangler), RIKTIGA SQLite-backade ProRegister/ProKonto
// (transactionSync, sql.exec), KV, Resend som utgående attrapp. Inget riktigt nät, ingen riktig nyckel.
// Lokal workerd är inte Cloudflares produktion: produktionsbeständighet och live-cookie är EJ BEVISADE här.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { ENV } from "./stripe_dubbel.mjs";

let Miniflare = null;
for (const cand of [process.env.MINIFLARE_DIR, "miniflare", "/home/claude/gmo/mf/node_modules/miniflare"].filter(Boolean)) {
  try { Miniflare = (await import(cand.startsWith("/") ? pathToFileURL(path.join(cand, "dist/src/index.js")).href : cand)).Miniflare; if (Miniflare) break; } catch { /* */ }
}
let esbuild = null;
for (const cand of [process.env.MINIFLARE_DIR && path.join(process.env.MINIFLARE_DIR, "../esbuild/lib/main.js"), "esbuild", "/home/claude/gmo/mf/node_modules/esbuild/lib/main.js"].filter(Boolean)) {
  try { esbuild = await import(cand.startsWith("/") ? pathToFileURL(cand).href : cand); if (esbuild?.build) break; esbuild = esbuild?.default ?? null; if (esbuild?.build) break; } catch { /* */ }
}
const skip = !Miniflare ? "Miniflare saknas: EJ KÖRD" : !esbuild?.build ? "esbuild saknas: EJ KÖRD" : false;
let entry = null;
if (!skip) {
  entry = path.join(mkdtempSync(path.join(tmpdir(), "gmo-konto-")), "worker.mjs");
  await esbuild.build({ entryPoints: [fileURLToPath(new URL("../src/index.js", import.meta.url))], bundle: true, format: "esm", target: "es2022", keepNames: true, charset: "ascii", outfile: entry, logLevel: "silent" });
}
const SAJT = "https://stahledigital.se", AGARE = "anders@stahledigital.se";
// Strängvars ur testmiljön (dubbelnycklar, inga riktiga) – bara strängar, bindningar kommer från Miniflare.
const vars = (extra) => Object.fromEntries(Object.entries(ENV({ PRO_PAYMENTS: "off", PRO_KONTO: "inbjudna", PRO_OWNER_EMAIL: AGARE, PRO_MAIL_DAY_CAP: "100", ...extra })).filter(([, v]) => typeof v === "string"));
function boot(extra = {}) {
  const ut = [];
  const mf = new Miniflare({
    modules: true, scriptPath: entry, modulesRoot: path.dirname(entry), compatibilityDate: "2026-08-01",
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    durableObjects: {
      QUOTA: { className: "QuotaCounter", useSQLite: true }, FREE_BUDGET: { className: "FreeBudget", useSQLite: true },
      PRO_REGISTER: { className: "ProRegister", useSQLite: true }, PRO_KONTON: { className: "ProKonto", useSQLite: true },
    },
    kvNamespaces: ["REVIEWS_KV"],
    bindings: vars(extra),
    outboundService: async (req) => {
      ut.push(req.url);
      if (req.url !== "https://api.resend.com/emails") return new Response("blockerad", { status: 502 });
      const b = await req.json(); ut.mejl = ut.mejl || []; ut.mejl.push(b);
      return Response.json({ id: "re_" + String(ut.mejl.length).padStart(10, "0") });
    },
  });
  return { mf, ut };
}
const H = (o = {}) => ({ Origin: SAJT, "X-MR-Pro": "1", "content-type": "application/json", "CF-Connecting-IP": o.ip || "203.0.113.9", ...(o.cookie ? { Cookie: o.cookie } : {}) });
// K2 (A2): kodmejlet går i waitUntil efter svaret. Efter /kod väntar vi (högst 3 s) tills registret och mejlet hunnit köras.
const vantaMejl = async (ut, fore) => { for (let i = 0; i < 60 && (ut.mejl || []).length <= fore; i++) await new Promise((r) => setTimeout(r, 50)); };
const post = async (mf, p, body, o) => {
  const ut = o && o.ut; const fore = ut ? (ut.mejl || []).length : 0;
  const r = await mf.dispatchFetch("http://localhost" + p, { method: "POST", headers: H(o), body: JSON.stringify(body) });
  if (ut && p === "/pro/konto/kod") await vantaMejl(ut, fore);
  return r;
};
const kodUr = (m) => /\n {4}(\d{6})\n/.exec(m.text)[1];
const ck = (r) => (r.headers.get("set-cookie") || "").split(";")[0];


const pid = (n) => "p_" + n.toString(16).padStart(32, "0");
const projekt = (id, namn = "Altan") => ({ format: "materialraknaren-pro-projekt", version: 1, projektId: id, projektnamn: namn, moms: "25", material: [{ namn: "Trall", mangd: "42" }], arbete: [], ovrigt: [] });
const req = (mf, p, { method = "GET", cookie, body, ifm } = {}) => mf.dispatchFetch("http://localhost" + p, { method,
  headers: { ...(method !== "GET" ? { Origin: SAJT, "X-MR-Pro": "1", "content-type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(ifm !== undefined ? { "If-Match": String(ifm) } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function inlogg(mf, ut, namn) {
  await post(mf, "/pro/konto/kod", { epost: AGARE }, { ut }); const r = await post(mf, "/pro/konto/logga-in", { epost: AGARE, kod: kodUr(ut.mejl[ut.mejl.length - 1]), namn });
  assert.equal(r.status, 200); return ck(r);
}
const A3 = (r, namn) => { assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow", namn); assert.equal(r.headers.get("cache-control"), "no-store", namn);
  for (const [k] of r.headers) assert.ok(!k.startsWith("access-control-"), namn + " " + k); };


const agare = (mf, cookie, vag, body) => req(mf, "/pro/konto/agare/" + vag, body === undefined ? { cookie } : { method: "POST", cookie, body });
async function kodTill(mf, ut, epost) { await post(mf, "/pro/konto/kod", { epost }, { ut }); const m = ut.mejl[ut.mejl.length - 1]; return m && (m.to === epost || (Array.isArray(m.to) && m.to.includes(epost))) ? kodUr(m) : null; }
const T1 = "testare.ett@example.se";

test("workerd K5: ägare/icke-ägare/steg-kod; inbjudan → testarens kodinloggning → roll test; återkallelse vid nästa anrop; inga kunddata till ägaren; A3", { skip }, async () => {
  const { mf, ut } = boot(); await mf.ready;
  try {
    const O = await inlogg(mf, ut, "Ägare");
    let r = await agare(mf, O, "testplatser"); A3(r, "lista"); assert.equal(r.status, 200); assert.deepEqual((await r.json()).testplatser, []);
    r = await agare(mf, O, "inbjud", { epost: T1 }); A3(r, "utan kod"); assert.equal(r.status, 401); assert.deepEqual(await r.json(), { status: "stegkod" });
    r = await agare(mf, O, "inbjud", { epost: T1, kod: await kodTill(mf, ut, AGARE) }); A3(r, "inbjud"); assert.equal(r.status, 200);
    const tp = (await r.json()).testplats; assert.equal(tp.adress, "t***@e***.se"); assert.equal(tp.status, "aktiv");
    const tkod = await kodTill(mf, ut, T1); assert.ok(tkod, "inbjuden adress får kod");
    r = await post(mf, "/pro/konto/logga-in", { epost: T1, kod: tkod, namn: "Testare" }); assert.equal(r.status, 200); const T = ck(r);
    const me = await (await req(mf, "/pro/konto/jag", { cookie: T })).json(); assert.equal(me.roll, "test");
    const id = "p_" + "9".repeat(32);
    assert.equal((await req(mf, `/pro/konto/projekt/${id}`, { method: "PUT", cookie: T, body: projekt(id, "Hemlig kund Svensson"), ifm: 0 })).status, 200);
    for (const v of ["testplatser", "inbjud", "forlang", "aterkalla"]) {
      r = await agare(mf, T, v, v === "testplatser" ? undefined : { id: tp.id, epost: "x@example.se", kod: "000000" }); A3(r, "403 " + v); assert.equal(r.status, 403, v);
    }
    assert.equal((await req(mf, `/pro/konto/projekt/${id}`, { cookie: O })).status, 404, "ägaren når inte testarens jobb");
    r = await agare(mf, O, "aterkalla", { id: tp.id, kod: await kodTill(mf, ut, AGARE) }); assert.equal(r.status, 200);
    r = await req(mf, `/pro/konto/projekt/${id}`, { method: "PUT", cookie: T, body: projekt(id, "Andra"), ifm: 1 }); assert.equal(r.status, 403); assert.equal((await r.json()).status, "las_endast");
    assert.equal((await req(mf, `/pro/konto/projekt/${id}`, { cookie: T })).status, 200, "läsperiod: läsning kvar");
    const lista = await (await agare(mf, O, "testplatser")).text();
    for (const x of ["Svensson", T1, me.konto]) assert.ok(!lista.includes(x), "listan saknar " + x);
    assert.deepEqual(JSON.parse(lista).testplatser.map((p) => p.status), ["aterkallad"]);
    assert.deepEqual([...ut].filter((u) => u !== "https://api.resend.com/emails"), [], "inget annat nät");
    assert.ok(!(ut.mejl || []).some((m) => /inbjuden att testa/.test(m.subject || "")), "inget inbjudningsmejl i läge av");
  } finally { await mf.dispose(); }
});

test("workerd K5: PRO_KONTO off ger 503 på ägarrutterna utan nät", { skip }, async () => {
  const { mf, ut } = boot({ PRO_KONTO: "off" }); await mf.ready;
  try {
    for (const v of ["testplatser", "inbjud"]) { const r = await agare(mf, null, v, v === "testplatser" ? undefined : {}); assert.equal(r.status, 503); A3(r, v); }
    assert.deepEqual([...ut], []);
  } finally { await mf.dispose(); }
});
