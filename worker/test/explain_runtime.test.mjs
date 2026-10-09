// S3: ExplainBudget mot en RIKTIG lokal workerd (Miniflare) med verkligt samtidiga anrop.
// Kör: MINIFLARE_DIR=/home/claude/gmo/mf/node_modules/miniflare node --test worker/test/explain_runtime.test.mjs
// Saknas Miniflare rapporteras testet som EJ KÖRT (inte godkänt).
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
const entry = fileURLToPath(new URL("./helpers/explain_do_entry.mjs", import.meta.url));
async function boot() {
  const mf = new Miniflare({ modules: true, scriptPath: entry, modulesRoot: path.resolve(path.dirname(entry), "../.."), compatibilityDate: "2026-08-01",
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }], durableObjects: { EXPLAIN_BUDGET: { className: "ExplainBudget", useSQLite: true } } });
  await mf.ready; return mf;
}
const call = (mf, p, qs) => mf.dispatchFetch(`http://localhost${p}?${qs}`).then((r) => r.json());

test("workerd: 60 samtidiga reservationer à 400 000 µUSD mot tak 20 000 000 → exakt 50 ok, aldrig över taket", { skip }, async () => {
  const mf = await boot();
  try {
    const rs = await Promise.all(Array.from({ length: 60 }, (_, i) => call(mf, "/", `micro=400000&cap=20000000&dayLimit=1000&ipLimit=1000&ip=${(i % 10).toString(16).repeat(16)}`)));
    assert.equal(rs.filter((r) => r.ok).length, 50);
    assert.ok(rs.filter((r) => !r.ok).every((r) => r.reason === "manad"));
  } finally { await mf.dispose(); }
});

test("workerd: IP-tak 5 och dygnstak 100 håller under samtidighet", { skip }, async () => {
  const mf = await boot();
  try {
    const a = await Promise.all(Array.from({ length: 20 }, () => call(mf, "/", "micro=1&cap=1000000&dayLimit=1000&ipLimit=5&ip=bbbbbbbbbbbbbbbb")));
    assert.equal(a.filter((r) => r.ok).length, 5); assert.ok(a.filter((r) => !r.ok).every((r) => r.reason === "ip"));
    const mf2 = await boot();
    try {
      const b = await Promise.all(Array.from({ length: 130 }, (_, i) => call(mf2, "/", `micro=1&cap=1000000&dayLimit=100&ipLimit=1000&ip=${i.toString(16).padStart(16, "0")}`)));
      assert.equal(b.filter((r) => r.ok).length, 100); assert.ok(b.filter((r) => !r.ok).every((r) => r.reason === "dygn"));
    } finally { await mf2.dispose(); }
  } finally { await mf.dispose(); }
});

test("workerd: settle ersätter reservationen, release frigör, nytt dygn nollar dygns- och IP-räknare men inte månaden", { skip }, async () => {
  const mf = await boot();
  try {
    assert.equal((await call(mf, "/", "micro=1000&cap=1500&ip=cccccccccccccccc")).ok, true);
    assert.equal((await call(mf, "/", "micro=1000&cap=1500&ip=dddddddddddddddd")).reason, "manad");
    assert.equal((await call(mf, "/settle", "micro=1000&actual=100")).ok, true);   // månaden = 100
    assert.equal((await call(mf, "/", "micro=1000&cap=1500&ip=dddddddddddddddd")).ok, true); // 1100 ≤ 1500
    assert.equal((await call(mf, "/release", "micro=1000&ip=dddddddddddddddd")).ok, true);   // 100
    assert.equal((await call(mf, "/", "micro=1400&cap=1500&ip=eeeeeeeeeeeeeeee&day=2026-10-11")).ok, true); // månad 1500 efter nytt dygn
    assert.equal((await call(mf, "/", "micro=1&cap=1500&ip=ffffffffffffffff&day=2026-10-11")).reason, "manad");
  } finally { await mf.dispose(); }
});
