// D12-rättning (root-QA P1): atomicitet mot RIKTIG workerd + SQLite-lagring. Fel injiceras inuti storage.transaction.
// Kör: MINIFLARE_DIR=/home/claude/gmo/mf/node_modules/miniflare node --test worker/test/free_gate_runtime.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

let Miniflare = null;
for (const cand of [process.env.MINIFLARE_DIR, "miniflare", "/home/claude/gmo/mf/node_modules/miniflare"].filter(Boolean)) {
  try { const spec = cand.startsWith("/") ? pathToFileURL(path.join(cand, "dist/src/index.js")).href : cand; Miniflare = (await import(spec)).Miniflare; if (Miniflare) break; } catch { /* nästa */ }
}
const skip = Miniflare ? false : "Miniflare saknas: körningen mot riktig workerd är EJ KÖRD";
const entry = fileURLToPath(new URL("./helpers/free_do_entry.mjs", import.meta.url));
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const CFG = { id: "runtime-test", capMicro: 1500, fromMs: NOW - 86400000, untilMs: NOW + 86400000, mandate: "TEST-MANDAT-OFFLINE" };
async function boot() {
  const mf = new Miniflare({ modules: true, scriptPath: entry, modulesRoot: path.resolve(path.dirname(entry), "../.."), compatibilityDate: "2026-08-01",
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }], durableObjects: { FREE_BUDGET: { className: "FaultyFreeBudget", useSQLite: true } } });
  await mf.ready; return mf;
}
const op = async (mf, p, body = {}, fault) => { const r = await mf.dispatchFetch("http://localhost" + p, { method: "POST", headers: fault ? { "x-fault": fault } : {}, body: JSON.stringify({ cfg: CFG, nowMs: NOW, ...body }) }); return { status: r.status, json: await r.json().catch(() => null) }; };
const peek = async (mf) => (await mf.dispatchFetch("http://localhost/peek", { method: "POST", body: "{}" })).json();

test("workerd/SQLite: fel på r-skrivningen i settle rullar tillbaka ALLT (m förblir reserverat värsta fall); retry räknar förbrukningen exakt en gång (root P1)", { skip }, async () => {
  const mf = await boot();
  try {
    assert.equal((await op(mf, "/reserve", { key: "root:one", micro: 1000 })).json.ok, true);
    const bad = await op(mf, "/settle", { key: "root:one", actual: 100, usageKnown: true }, "put:r:"); assert.equal(bad.status, 500);
    let s = await peek(mf); assert.equal(s.m.spent, 1000, "m oförändrat efter misslyckad settle"); assert.equal(s["r:root:one"].state, "reserved");
    assert.equal((await op(mf, "/settle", { key: "root:one", actual: 100, usageKnown: true })).json.ok, true);
    s = await peek(mf); assert.equal(s.m.spent, 100); assert.equal(s["r:root:one"].state, "settled"); assert.equal(s["r:root:one"].actual, 100);
    assert.equal((await op(mf, "/settle", { key: "root:one", actual: 100, usageKnown: true })).json.reason, "okand_reservation", "dubbel settle räknas aldrig två gånger");
    assert.equal((await op(mf, "/reserve", { key: "root:two", micro: 1500 })).json.reason, "tak", "100 känd förbrukning + 1500 > tak 1500");
    assert.equal((await peek(mf)).m.spent, 100);
  } finally { await mf.dispose(); }
});

test("workerd/SQLite: fel i reserve/release/okänd-användning-halt rullar tillbaka helt; retry ger rätt totaler", { skip }, async () => {
  const mf = await boot();
  try {
    // reserve: fel på r- respektive efter alla skrivningar ⇒ ingenting skrivet, inga halvreservationer
    for (const f of ["put:r:", "put:m", "after"]) { const r = await op(mf, "/reserve", { key: "k1", micro: 400 }, f); assert.equal(r.status, 500, f); const s = await peek(mf); assert.equal(s["r:k1"], undefined, f); assert.equal(s.m, undefined, f); }
    assert.equal((await op(mf, "/reserve", { key: "k1", micro: 400 })).json.ok, true);
    assert.equal((await op(mf, "/reserve", { key: "k1", micro: 400 })).json.idempotent, true); assert.equal((await peek(mf)).m.spent, 400, "idempotent retry dubbelreserverar inte");
    // release med fel ⇒ oförändrat; retry frigör exakt en gång
    assert.equal((await op(mf, "/release", { key: "k1" }, "put:r:")).status, 500); assert.equal((await peek(mf)).m.spent, 400); assert.equal((await peek(mf))["r:k1"].state, "reserved");
    assert.equal((await op(mf, "/release", { key: "k1" })).json.ok, true); assert.equal((await peek(mf)).m.spent, 0);
    assert.equal((await op(mf, "/release", { key: "k1" })).json.noop, true); assert.equal((await peek(mf)).m.spent, 0, "andra release räknas inte bort igen");
    // okänd användning: fel på halt-skrivningen ⇒ ingen halv avräkning (reserved + ingen halt); retry ⇒ värsta fallet kvar + halt
    assert.equal((await op(mf, "/reserve", { key: "k2", micro: 300 })).json.ok, true);
    assert.equal((await op(mf, "/settle", { key: "k2", actual: 300, usageKnown: false }, "put:halt")).status, 500);
    let s = await peek(mf); assert.equal(s.halt, undefined); assert.equal(s["r:k2"].state, "reserved"); assert.equal(s.m.spent, 300);
    assert.equal((await op(mf, "/settle", { key: "k2", actual: 300, usageKnown: false })).json.halted, true);
    s = await peek(mf); assert.ok(s.halt); assert.equal(s.m.spent, 300); assert.equal((await op(mf, "/reserve", { key: "k3", micro: 1 })).json.reason, "stopp");
  } finally { await mf.dispose(); }
});
