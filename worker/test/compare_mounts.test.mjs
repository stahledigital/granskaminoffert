// D09: atomisk serverreservation FÖRE varje billbar Googlekomponent (Search/AdvancedDetails). Offline, syntetiskt. Ingen riktig Googlekontakt, ingen budget vald:
// takens värden i testet är rena testtak. Default 0 = stängt. Utan gemensamt tak OCH tak för SKU:n nekas allt utan att något räknas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, installFetch, api, createOrder, REVIEW_VARS, GOOGLE_VARS } from "./helpers/compare_env.mjs";

const { GOOGLE_PLACES_API_SEARCH_VERIFIED: _x, GOOGLE_CANDIDATES: _y, COMPARE_SOURCES_SEARCH_DAY_CAP: _s, COMPARE_SOURCES_MOUNT_DAY_CAP: _m, COMPARE_SOURCES_DETAILS_DAY_CAP: _d, ...BASE } = GOOGLE_VARS;
const ON = { ...REVIEW_VARS, ...BASE }; // ingen server-Text Search; inga tak
const src = (env, id, token, sub = "", method = "GET", body) => api(env, method, `/compare/orders/${id}/sources${sub}`, { token, body });
let seq = 0; const mid = () => "m" + String(++seq).padStart(20, "0") + "abcdef";
async function ordr(env, name = "Nord Bygg AB") {
  const { orderId, token } = (await createOrder(env, 2)).json;
  const fid = (await src(env, orderId, token, "/firms", "PUT", { firms: [{ offerIndex: 0, name, city: "Stockholm" }] })).json.sources.firms[0].id;
  return { orderId, token, fid };
}
const reserve = (env, o, kind, id = mid()) => src(env, o.orderId, o.token, "/google/mount", "POST", { firmId: o.fid, kind, mountId: id });
const counters = (env) => Object.fromEntries([...env.COMPARE_BUDGET.peek("jamfor-budget").store.entries()].filter(([k]) => k.startsWith("c:gmount")).map(([k, v]) => [k.split(":")[1], v]));
const mounts = (env, o) => env.COMPARE_ORDERS.peek(o.orderId).store.get("sources").mounts;

test("default 0 / fail closed: utan gemensamt tak eller utan tak för SKU:n nekas utan att något räknas eller reserveras", async () => {
  const f = installFetch();
  try {
    for (const extra of [{}, { COMPARE_SOURCES_MOUNT_DAY_CAP: "10" }, { COMPARE_SOURCES_DETAILS_DAY_CAP: "10" }, { COMPARE_SOURCES_SEARCH_DAY_CAP: "10", COMPARE_SOURCES_DETAILS_DAY_CAP: "10" }]) {
      const env = makeEnv({ ...ON, ...extra }); const o = await ordr(env);
      const r = await reserve(env, o, "details");
      assert.equal(r.status, 200); assert.equal(r.json.allowed, false); assert.equal(r.json.outcome, "kostnadsstopp");
      assert.deepEqual(counters(env), {}); assert.equal(mounts(env, o).details, 0);
    }
    // sök-SKU: gemensamt tak men inget söktak ⇒ stängt för search men öppet för details
    const env = makeEnv({ ...ON, COMPARE_SOURCES_MOUNT_DAY_CAP: "10", COMPARE_SOURCES_DETAILS_DAY_CAP: "10" }); const o = await ordr(env);
    assert.equal((await reserve(env, o, "search")).json.allowed, false);
    assert.equal((await reserve(env, o, "details")).json.allowed, true);
    assert.equal(f.log.google.length, 0, "servern gör aldrig något Googleanrop i den här vägen");
  } finally { f.restore(); }
});

test("per order: högst 6 sök- och 12 detaljinstanser; sedan nekas med gransen_for_ordern och inget globalt räknas", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({ ...ON, COMPARE_SOURCES_MOUNT_DAY_CAP: "1000", COMPARE_SOURCES_SEARCH_DAY_CAP: "1000", COMPARE_SOURCES_DETAILS_DAY_CAP: "1000" }); const o = await ordr(env);
    const res = []; for (let i = 0; i < 14; i++) res.push((await reserve(env, o, "details")).json);
    assert.equal(res.filter((r) => r.allowed).length, 12); assert.equal(res[12].outcome, "gransen_for_ordern");
    for (let i = 0; i < 7; i++) res.push((await reserve(env, o, "search")).json);
    assert.equal(res.slice(14).filter((r) => r.allowed).length, 6);
    assert.deepEqual(counters(env), { gmount: 18, "gmount-details": 12, "gmount-search": 6 });
    // en annan order har egen budget per order
    const o2 = await ordr(env, "Annan AB"); assert.equal((await reserve(env, o2, "details")).json.allowed, true);
  } finally { f.restore(); }
});

test("gemensamt dygnstak och tak per SKU är atomära även vid 30 samtidiga reservationer över flera ordrar; nekad global reservation lämnar tillbaka orderplatsen", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({ ...ON, COMPARE_SOURCES_MOUNT_DAY_CAP: "7", COMPARE_SOURCES_SEARCH_DAY_CAP: "5", COMPARE_SOURCES_DETAILS_DAY_CAP: "5" });
    const os = []; for (let i = 0; i < 3; i++) os.push(await ordr(env, "Firma " + i + " AB"));
    const jobs = []; for (let i = 0; i < 30; i++) jobs.push(reserve(env, os[i % 3], i % 2 ? "search" : "details"));
    const out = (await Promise.all(jobs)).map((r) => r.json);
    const ok = out.filter((r) => r.allowed);
    assert.equal(ok.length, 7, "exakt gemensamt tak, aldrig fler");
    assert.ok(ok.filter((r) => r.kind === "details").length <= 5 && ok.filter((r) => r.kind === "search").length <= 5, "SKU-taken överskrids aldrig");
    const c = counters(env); assert.equal(c.gmount, 7); assert.equal((c["gmount-details"] || 0) + (c["gmount-search"] || 0), 7);
    // orderplatser återlämnade för nekade: summan av ordrarnas reserverade = antal tillåtna
    const held = os.reduce((n, o) => n + mounts(env, o).search + mounts(env, o).details, 0); assert.equal(held, 7);
    assert.ok(out.filter((r) => !r.allowed).every((r) => r.outcome === "kostnadsstopp"));
  } finally { f.restore(); }
});

test("idempotens: samma mountId ger aldrig ny tillåtelse (inte heller efter global nekan); varje remount/retry/preview/byte/återöppning är en ny reservation som räknas", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({ ...ON, COMPARE_SOURCES_MOUNT_DAY_CAP: "3", COMPARE_SOURCES_SEARCH_DAY_CAP: "3", COMPARE_SOURCES_DETAILS_DAY_CAP: "3" }); const o = await ordr(env);
    const id = mid();
    assert.equal((await reserve(env, o, "details", id)).json.allowed, true);
    const again = await reserve(env, o, "details", id); assert.equal(again.json.allowed, false); assert.equal(again.json.outcome, "redan_anvand");
    assert.deepEqual(counters(env), { gmount: 1, "gmount-details": 1 }, "återspelning räknas inte och släpper inte in en ny instans");
    // ändrat byte av typ med gammalt id hjälper inte
    assert.equal((await reserve(env, o, "search", id)).json.allowed, false);
    // remount/retry/preview/återöppning = nya id ⇒ nya reservationer tills taket
    assert.equal((await reserve(env, o, "details")).json.allowed, true);
    assert.equal((await reserve(env, o, "details")).json.allowed, true);
    const stop = await reserve(env, o, "details"); assert.equal(stop.json.allowed, false); assert.equal(stop.json.outcome, "kostnadsstopp");
    // id som nekades globalt är förbrukat: samma id kan inte användas när taket senare höjs/nollställs
    const burnt = mid(); await reserve(env, o, "details", burnt);
    assert.equal((await reserve(env, o, "details", burnt)).json.outcome, "redan_anvand");
    assert.equal(mounts(env, o).details, 3);
  } finally { f.restore(); }
});

test("ogiltiga anrop: okänd firma, ogiltig typ/id, omdömen avstängda, fel token; inget räknas", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({ ...ON, COMPARE_SOURCES_MOUNT_DAY_CAP: "5", COMPARE_SOURCES_SEARCH_DAY_CAP: "5", COMPARE_SOURCES_DETAILS_DAY_CAP: "5" }); const o = await ordr(env);
    assert.equal((await src(env, o.orderId, o.token, "/google/mount", "POST", { firmId: "f_000000000000", kind: "details", mountId: mid() })).status, 404);
    assert.equal((await reserve(env, o, "details", "kort")).status, 400, "ogiltigt mountId");
    assert.equal((await src(env, o.orderId, o.token, "/google/mount", "POST", { firmId: o.fid, kind: "profil", mountId: mid() })).status, 400);
    assert.equal((await src(env, o.orderId, o.token, "/google/mount", "POST", { firmId: o.fid, kind: "details" })).status, 400);
    assert.equal((await src(env, o.orderId, "tok_" + "z".repeat(40), "/google/mount", "POST", { firmId: o.fid, kind: "details", mountId: mid() })).status, 404);
    assert.deepEqual(counters(env), {});
    const off = makeEnv({ ...ON, COMPARE_REVIEWS: undefined, COMPARE_SOURCES_MOUNT_DAY_CAP: "5", COMPARE_SOURCES_DETAILS_DAY_CAP: "5" }); const o2 = await ordr(off);
    assert.equal((await reserve(off, o2, "details")).status, 503);
  } finally { f.restore(); }
});
