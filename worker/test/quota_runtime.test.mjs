// F8/N22: Durable Object-kvoten körs mot en RIKTIG lokal Cloudflare-runtime (workerd via
// Miniflare), inte mot en attrapp. Förfrågningarna är verkligt samtidiga HTTP-anrop mot
// Workern, som anropar SQLite-backade Durable Objects med Cloudflares input/output gates.
//
// Miniflare är ett utvecklingsverktyg som inte checkas in. Installera lokalt utanför repot:
//   mkdir /tmp/mf && cd /tmp/mf && npm i miniflare@4
//   MINIFLARE_DIR=/tmp/mf/node_modules/miniflare node --test worker/test/quota_runtime.test.mjs
// Saknas Miniflare hoppas testet över och rapporteras som EJ KÖRT (inte som godkänt).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

let Miniflare = null;
for (const cand of [process.env.MINIFLARE_DIR, "miniflare", "/home/claude/gmo/mf/node_modules/miniflare"].filter(Boolean)) {
  try {
    const spec = cand.startsWith("/") ? pathToFileURL(path.join(cand, "dist/src/index.js")).href : cand;
    Miniflare = (await import(spec)).Miniflare;
    if (Miniflare) break;
  } catch { /* nästa */ }
}
const skip = Miniflare ? false : "Miniflare saknas: körningen mot riktig workerd är EJ KÖRD";
const entry = fileURLToPath(new URL("./helpers/do_entry.mjs", import.meta.url));

async function boot(extra = {}) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: entry,
    modulesRoot: path.resolve(path.dirname(entry), "../.."),
    compatibilityDate: "2026-08-01",
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    durableObjects: { QUOTA: { className: "QuotaCounter", useSQLite: true } },
    kvNamespaces: ["REVIEWS_KV"],
    ...extra,
  });
  await mf.ready;
  return mf;
}
const call = (mf, qs) => mf.dispatchFetch(`http://localhost/?${qs}`).then((r) => r.json());

test("workerd: 40 samtidiga reservationer mot tak 7 → exakt 7 ok (riktiga input/output gates)", { skip }, async () => {
  const mf = await boot();
  try {
    const rs = await Promise.all(Array.from({ length: 40 }, () => call(mf, "limit=7&key=global:2026-10-09")));
    assert.equal(rs.filter((r) => r.ok).length, 7);
    assert.equal(rs.filter((r) => r.reason === "limit").length, 33);
    assert.ok(rs.every((r) => r.mode === "durable_object"));
    assert.deepEqual(rs.filter((r) => r.ok).map((r) => r.used).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
    // ytterligare omgång efter taket
    const more = await Promise.all(Array.from({ length: 10 }, () => call(mf, "limit=7&key=global:2026-10-09")));
    assert.equal(more.filter((r) => r.ok).length, 0);
  } finally { await mf.dispose(); }
});

test("workerd: N22 – 12 samtidiga mot globalt tak 3 → exakt 3, och oberoende nycklar räknas separat", { skip }, async () => {
  const mf = await boot();
  try {
    const rs = await Promise.all(Array.from({ length: 12 }, () => call(mf, "limit=3&key=global:A")));
    assert.equal(rs.filter((r) => r.ok).length, 3);
    const other = await call(mf, "limit=3&key=global:B");
    assert.equal(other.ok, true);
    assert.equal(other.used, 1);
  } finally { await mf.dispose(); }
});

test("workerd: räknaren överlever att objektet återanvänds (lagrat tillstånd) och ogiltig förfrågan nekas", { skip }, async () => {
  const mf = await boot();
  try {
    assert.equal((await call(mf, "limit=2&key=k1")).used, 1);
    assert.equal((await call(mf, "limit=2&key=k1")).used, 2);
    assert.equal((await call(mf, "limit=2&key=k1")).reason, "limit");
    // limit -1 → reserve nekar redan i klienten (fel), inget skrivs
    assert.equal((await call(mf, "limit=-1&key=k2")).reason, "fel");
    const ns = await mf.getDurableObjectNamespace("QUOTA");
    const stub = ns.get(ns.idFromName("global"));
    const bad = await stub.fetch("https://quota/reserve", { method: "POST", body: "inte json" });
    assert.equal(bad.status, 400);
    const bad2 = await stub.fetch("https://quota/reserve", { method: "POST", body: JSON.stringify({ key: "x", limit: 1.5 }) });
    assert.equal(bad2.status, 400);
  } finally { await mf.dispose(); }
});

test("workerd: utan Durable Object-bindning nekas reservationen (safe-stop)", { skip }, async () => {
  const mf = new Miniflare({
    modules: true, scriptPath: entry, modulesRoot: path.resolve(path.dirname(entry), "../.."), compatibilityDate: "2026-08-01", modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    // QuotaCounter exporteras men ingen bindning skapas
    kvNamespaces: ["REVIEWS_KV"],
  });
  await mf.ready;
  try {
    const rs = await Promise.all(Array.from({ length: 5 }, () => call(mf, "limit=3&key=global:Z")));
    assert.ok(rs.every((r) => r.ok === false && r.reason === "ingen_atomar_kvot"));
  } finally { await mf.dispose(); }
});
