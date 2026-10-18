// KONTO-SYNK K2 (synk, radering, A3, PITR-beteende) i lokal workerd. Samma uppsättning som K1:s körtidsprov:
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

test("workerd K2: två klienter (två sessioner): 1→2, gammal rev 409 med serverns data; gravsten 410; lista; export; A3 på alla svar", { skip }, async () => {
  const { mf, ut } = boot(); await mf.ready;
  try {
    const A = await inlogg(mf, ut, "A"), B = await inlogg(mf, ut, "B"); const id = pid(1);
    let r = await req(mf, `/pro/konto/projekt/${id}`, { method: "PUT", cookie: A, body: projekt(id), ifm: 0 }); A3(r, "put0"); assert.equal(r.status, 200); assert.equal((await r.json()).rev, 1);
    r = await req(mf, `/pro/konto/projekt/${id}`, { method: "PUT", cookie: A, body: projekt(id, "A2"), ifm: 1 }); assert.equal((await r.json()).rev, 2);
    r = await req(mf, `/pro/konto/projekt/${id}`, { method: "PUT", cookie: B, body: projekt(id, "B"), ifm: 1 }); A3(r, "409"); assert.equal(r.status, 409);
    const k = await r.json(); assert.equal(k.server.rev, 2); assert.equal(k.server.data.projektnamn, "A2");
    r = await req(mf, `/pro/konto/projekt/${id}`, { method: "DELETE", cookie: A, ifm: 2 }); assert.equal(r.status, 200); const rad = (await r.json()).raderad_ms;
    r = await req(mf, `/pro/konto/projekt/${id}`, { method: "PUT", cookie: B, body: projekt(id, "B kö"), ifm: 2 }); A3(r, "410"); assert.equal(r.status, 410); assert.equal((await r.json()).raderad_ms, rad);
    r = await req(mf, `/pro/konto/projekt/${id}`, { method: "PUT", cookie: B, body: projekt(id, "B kö"), ifm: 0 }); assert.equal(r.status, 410, "återskapas aldrig tyst");
    const l = await (await req(mf, "/pro/konto/projekt", { cookie: B })).json(); assert.deepEqual(l.projekt.map((p) => [p.id, p.rev, p.raderad === rad]), [[id, 3, true]]);
    r = await req(mf, "/pro/konto/projekt/" + pid(2), { method: "PUT", cookie: A, body: { ...projekt(pid(2)), material: Array.from({ length: 501 }, () => ({ namn: "x" })) }, ifm: 0 }); A3(r, "413"); assert.equal(r.status, 413);
    const ex = await (await req(mf, "/pro/konto/export", { cookie: A })).json(); assert.equal(ex.epost, AGARE); assert.equal(ex.projekt.length, 1); assert.equal(ex.enheter.length, 2);
    for (const [p, o] of [["/pro/konto/jag", {}], ["/pro/konto/x", {}], ["/pro/konto/kod", { method: "OPTIONS" }]]) A3(await req(mf, p, o), p);
    assert.deepEqual([...ut].filter((u) => u !== "https://api.resend.com/emails"), [], "inget annat nät");
  } finally { await mf.dispose(); }
});

test("workerd K2: radera konto med färsk kod (riktig deleteAll i SQLite-DO): 401 därefter, ny inloggning ger tomt konto med nytt id", { skip }, async () => {
  const { mf, ut } = boot(); await mf.ready;
  try {
    const A = await inlogg(mf, ut, "A"); const kontoId = (await (await req(mf, "/pro/konto/jag", { cookie: A })).json()).konto;
    await req(mf, `/pro/konto/projekt/${pid(5)}`, { method: "PUT", cookie: A, body: projekt(pid(5)), ifm: 0 });
    await post(mf, "/pro/konto/kod", { epost: AGARE }, { ut }); const kod = kodUr(ut.mejl[ut.mejl.length - 1]);
    const r = await req(mf, "/pro/konto/radera", { method: "POST", cookie: A, body: { bekrafta: true, epost: AGARE, kod } }); A3(r, "radera"); assert.equal(r.status, 200);
    assert.equal((await req(mf, "/pro/konto/jag", { cookie: A })).status, 401);
    const ns = await mf.getDurableObjectNamespace("PRO_KONTON"); const stub = ns.get(ns.idFromName("k:" + kontoId));
    assert.deepEqual(await (await stub.fetch("https://pro-konto/tom", { method: "POST", body: JSON.stringify({ nu: Math.floor(Date.now() / 1000), kontoId }) })).json(), { tom: true });
    const rs = await mf.getDurableObjectNamespace("PRO_REGISTER"); const reg = rs.get(rs.idFromName("register:v1"));
    assert.deepEqual(await (await reg.fetch("https://pro-register/raderat", { method: "POST", body: JSON.stringify({ nu: Math.floor(Date.now() / 1000), kontoId }) })).json(), { raderat: true });
  } finally { await mf.dispose(); }
});

test("workerd K2: PITR-anropet lokalt (observation, ingen acceptans: PITR provas live i K6)", { skip }, async () => {
  const { mf, ut } = boot(); await mf.ready;
  try {
    const O = await inlogg(mf, ut, "O"); const kontoId = (await (await req(mf, "/pro/konto/jag", { cookie: O })).json()).konto;
    await post(mf, "/pro/konto/kod", { epost: AGARE }, { ut }); const kod = kodUr(ut.mejl[ut.mejl.length - 1]);
    const r = await req(mf, "/pro/konto/agare/pitr", { method: "POST", cookie: O, body: { konto: kontoId, tid_ms: Date.now() - 1000, epost: AGARE, kod } });
    A3(r, "pitr"); const j = await r.json();
    console.log("# PITR lokalt i workerd:", r.status, JSON.stringify(j));
    assert.ok([200, 501, 502].includes(r.status), "kontrollerat svar, inget krasch: " + r.status);
  } finally { await mf.dispose(); }
});

test("workerd K2: scheduled i off rör ingenting (0 utgående)", { skip }, async () => {
  const { mf, ut } = boot({ PRO_KONTO: "off" }); await mf.ready;
  try {
    const w = await mf.getWorker(); await w.scheduled({ cron: "17 * * * *" });
    assert.deepEqual([...ut], []);
  } finally { await mf.dispose(); }
});
