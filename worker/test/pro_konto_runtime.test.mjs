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
const post = (mf, p, body, o) => mf.dispatchFetch("http://localhost" + p, { method: "POST", headers: H(o), body: JSON.stringify(body) });
const kodUr = (m) => /\n {4}(\d{6})\n/.exec(m.text)[1];
const ck = (r) => (r.headers.get("set-cookie") || "").split(";")[0];

test("workerd: PRO_KONTO off – allt under /pro/konto/* 503 stangt, 0 utgående anrop", { skip }, async () => {
  const { mf, ut } = boot({ PRO_KONTO: "off" }); await mf.ready;
  try {
    for (const [p, m] of [["/pro/konto/kod", "POST"], ["/pro/konto/logga-in", "POST"], ["/pro/konto/jag", "GET"], ["/pro/konto/logga-ut", "POST"]]) {
      const r = await mf.dispatchFetch("http://localhost" + p, { method: m, headers: H(), ...(m === "POST" ? { body: JSON.stringify({ epost: AGARE }) } : {}) });
      assert.equal(r.status, 503); assert.deepEqual(await r.json(), { status: "stangt" });
    }
    assert.deepEqual([...ut], []);
  } finally { await mf.dispose(); }
});

test("workerd: ägaren loggar in med kod, cookie exakt, jag = ägare; 6 parallella inlösen → exakt en vinnare", { skip }, async () => {
  const { mf, ut } = boot(); await mf.ready;
  try {
    let r = await post(mf, "/pro/konto/kod", { epost: AGARE }); assert.equal(r.status, 202);
    assert.equal(ut.mejl.length, 1); const kod = kodUr(ut.mejl[0]);
    const svar = await Promise.all(Array.from({ length: 6 }, () => post(mf, "/pro/konto/logga-in", { epost: AGARE, kod })));
    const st = svar.map((x) => x.status).sort(); assert.deepEqual(st, [200, 401, 401, 401, 401, 401]);
    const vinnare = svar.find((x) => x.status === 200);
    const sc = vinnare.headers.get("set-cookie");
    assert.match(sc, /^__Host-mrpro=k_[0-9a-f]{32}\.[A-Za-z0-9_-]{22}\.[0-9a-f]{64}; Path=\/; Max-Age=7776000; Secure; HttpOnly; SameSite=Lax$/);
    r = await mf.dispatchFetch("http://localhost/pro/konto/jag", { headers: { Cookie: ck(vinnare) } });
    assert.equal(r.status, 200); const j = await r.json(); assert.equal(j.roll, "agare"); assert.equal(j.enheter.length, 1);
    assert.ok([...ut].every((u) => u === "https://api.resend.com/emails"));
  } finally { await mf.dispose(); }
});

test("workerd: 5 fel spärrar koden; 403 utan Origin eller X-MR-Pro", { skip }, async () => {
  const { mf, ut } = boot(); await mf.ready;
  try {
    await post(mf, "/pro/konto/kod", { epost: AGARE }); const kod0 = kodUr(ut.mejl[0]); const fel = kod0 === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) assert.equal((await post(mf, "/pro/konto/logga-in", { epost: AGARE, kod: fel })).status, 401);
    assert.equal((await post(mf, "/pro/konto/logga-in", { epost: AGARE, kod: kod0 })).status, 401, "spärrad");
    assert.equal((await mf.dispatchFetch("http://localhost/pro/konto/logga-in", { method: "POST", headers: { Origin: SAJT, "content-type": "application/json" }, body: "{}" })).status, 403);
    assert.equal((await mf.dispatchFetch("http://localhost/pro/konto/kod", { method: "POST", headers: { "X-MR-Pro": "1", "content-type": "application/json" }, body: JSON.stringify({ epost: AGARE }) })).status, 403);
    assert.equal(ut.mejl.length, 1);
  } finally { await mf.dispose(); }
});

test("workerd: fjärde enheten 409 med lista (koden förbrukas inte); utloggning med koden; nytt försök lyckas; utloggad cookie 401", { skip }, async () => {
  const { mf, ut } = boot(); await mf.ready;
  try {
    await post(mf, "/pro/konto/kod", { epost: AGARE });
    const a = await post(mf, "/pro/konto/logga-in", { epost: AGARE, kod: kodUr(ut.mejl[0]), namn: "A" }); assert.equal(a.status, 200);
    const kontoId = (await (await mf.dispatchFetch("http://localhost/pro/konto/jag", { headers: { Cookie: ck(a) } })).json()).konto;
    // fyll kontot till 3 enheter direkt i den riktiga ProKonto-instansen (samma operation som logga-in använder), i stället för att vänta ut e-postgränsen
    const ns = await mf.getDurableObjectNamespace("PRO_KONTON"); const stub = ns.get(ns.idFromName("k:" + kontoId));
    for (const [i, n] of [["1", "B"], ["2", "C"]]) {
      const r = await (await stub.fetch("https://pro-konto/skapa", { method: "POST", body: JSON.stringify({ nu: Math.floor(Date.now() / 1000), kontoId, sess: i.repeat(64), namn: n }) })).json();
      assert.equal(r.ok, true);
    }
    await post(mf, "/pro/konto/kod", { epost: AGARE }); const kod = kodUr(ut.mejl[1]);
    const r4 = await post(mf, "/pro/konto/logga-in", { epost: AGARE, kod, namn: "D" });
    assert.equal(r4.status, 409); const j = await r4.json(); assert.equal(j.status, "enhetsgrans"); assert.deepEqual(j.enheter.map((x) => x.namn).sort(), ["A", "B", "C"]);
    const idA = j.enheter.find((x) => x.namn === "A").id;
    assert.equal((await post(mf, `/pro/konto/enheter/${idA}/logga-ut`, { epost: AGARE, kod })).status, 200);
    const r5 = await post(mf, "/pro/konto/logga-in", { epost: AGARE, kod, namn: "D" }); assert.equal(r5.status, 200);
    assert.equal((await mf.dispatchFetch("http://localhost/pro/konto/jag", { headers: { Cookie: ck(a) } })).status, 401, "A utloggad");
    assert.equal((await mf.dispatchFetch("http://localhost/pro/konto/jag", { headers: { Cookie: ck(r5) } })).status, 200);
  } finally { await mf.dispose(); }
});

test("workerd: /pro/status och /health oförändrade bredvid kontorutterna", { skip }, async () => {
  const { mf, ut } = boot(); await mf.ready;
  try {
    const r = await mf.dispatchFetch("http://localhost/pro/status", { headers: { Origin: SAJT } }); assert.equal(r.status, 200); assert.equal((await r.json()).betalning, "off");
    assert.equal((await mf.dispatchFetch("http://localhost/health")).status, 200);
    assert.deepEqual([...ut], []);
  } finally { await mf.dispose(); }
});
