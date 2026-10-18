// P-A (KP-2026-10-16-01): MR PRO i GMO-workern i läge PRO_PAYMENTS="off".
// Kör hela workerns default-export (fetch + scheduled), inte bara handlePro. Inget nät: global fetch kastar och räknas.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { proSchema } from "../src/pro_routes.js";
import { ENV } from "./stripe_dubbel.mjs";

const API = "https://granskaminoffert-api.anders-316.workers.dev";
const SAJT = "https://stahledigital.se";
let anrop, kvAnrop, origFetch;
beforeEach(() => {
  anrop = []; kvAnrop = [];
  origFetch = globalThis.fetch;
  globalThis.fetch = async (u) => { anrop.push(String(u && u.url ? u.url : u)); throw new Error("nät förbjudet i provet"); };
});
afterEach(() => { globalThis.fetch = origFetch; });

function offEnv(extra = {}) {
  const e = ENV({ PRO_PAYMENTS: "off", ...extra }); // riktiga nyckelnamn finns (dubblar) — off ska ändå aldrig använda dem
  const kv = e.REVIEWS_KV;
  e.REVIEWS_KV = new Proxy(kv, { get(t, p) { const v = t[p]; return typeof v === "function" ? (...a) => { kvAnrop.push(String(p)); return v.apply(t, a); } : v; } });
  return e;
}
const ctx = () => { const v = []; return { v, waitUntil: (p) => v.push(p), passThroughOnException() {} }; };
const req = (path, { method = "GET", origin = SAJT, body, typ = "application/json" } = {}) =>
  new Request(API + path, { method, headers: { ...(origin ? { Origin: origin } : {}), ...(body !== undefined ? { "content-type": typ } : {}) }, body });

test("GET /pro/status: betalning off, inga planer, ingen ånger, CORS för sajten", async () => {
  const c = ctx(), r = await worker.fetch(req("/pro/status"), offEnv(), c);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.betalning, "off"); assert.deepEqual(j.planer, []); assert.equal(j.angra, false);
  assert.equal(r.headers.get("access-control-allow-origin"), SAJT);
  await Promise.all(c.v); assert.deepEqual(anrop, []); assert.deepEqual(kvAnrop, []);
});

test("övriga /pro/* svarar 503 stangt i off, utan nät och utan KV", async () => {
  const fall = [
    ["/pro/checkout", "POST", JSON.stringify({ plan: "projekt", projektId: "p_0123456789abcdef", forsok: "f1", samtycke: true, villkor: true })],
    ["/pro/kvitto?session_id=cs_test_x", "GET"],
    ["/pro/forny", "POST", JSON.stringify({ token: "x" })],
    ["/pro/inloggning", "POST", JSON.stringify({ epost: "a@b.se" })],
    ["/pro/inloggning/bekrafta", "POST", JSON.stringify({ id: "x" })],
    ["/pro/portal", "POST", JSON.stringify({ token: "x" })],
    ["/pro/aterhamta", "POST", JSON.stringify({ order: "PRO-AAAAAAAA", epost: "a@b.se" })],
    ["/pro/angra", "POST", JSON.stringify({ order: "PRO-AAAAAAAA", epost: "a@b.se" })],
    ["/pro/angra", "POST", JSON.stringify({ steg: 2, id: "x" })],
    ["/pro/okand", "GET"],
  ];
  for (const [p, m, b] of fall) {
    const c = ctx(), r = await worker.fetch(req(p, { method: m, body: b }), offEnv(), c);
    assert.equal(r.status, 503, p); assert.deepEqual(await r.json(), { status: "stangt" }, p);
    await Promise.all(c.v);
  }
  assert.deepEqual(anrop, []); assert.deepEqual(kvAnrop, []);
});

test("ångerformulär utan JS i off: begriplig HTML-sida 503 med noindex, inte JSON", async () => {
  const c = ctx(), r = await worker.fetch(req("/pro/angra", { method: "POST", typ: "application/x-www-form-urlencoded", body: "order=PRO-AAAAAAAA&epost=a%40b.se" }), offEnv(), c);
  assert.equal(r.status, 503);
  assert.match(r.headers.get("content-type"), /^text\/html/);
  assert.equal(r.headers.get("x-robots-tag"), "noindex");
  const h = await r.text();
  assert.match(h, /Köp av PRO är inte öppet just nu/); assert.match(h, /hej@stahledigital\.se/); assert.doesNotMatch(h, /\{"status"/);
  assert.match(h, /href="https:\/\/stahledigital\.se\/verkstaden\/materialraknaren\/angra"/);
  await Promise.all(c.v); assert.deepEqual(anrop, []); assert.deepEqual(kvAnrop, []);
});

test("scheduled (cron) i off: inga nätanrop, ingen KV, proSchema svarar av", async () => {
  const c = ctx(), env = offEnv();
  await worker.scheduled({ cron: "17 * * * *", scheduledTime: Date.now() }, env, c);
  assert.equal(c.v.length, 1); await Promise.all(c.v);
  assert.deepEqual(await proSchema(env), { ok: true, av: true });
  assert.deepEqual(anrop, []); assert.deepEqual(kvAnrop, []);
});

test("saknas PRO_PAYMENTS helt räknas det som off (fail closed)", async () => {
  const e = offEnv(); delete e.PRO_PAYMENTS;
  const r = await worker.fetch(req("/pro/checkout", { method: "POST", body: "{}" }), e, ctx());
  assert.equal(r.status, 503); assert.deepEqual(anrop, []);
});

test("CORS för stahledigital.se gäller bara /pro/*", async () => {
  const pro = await worker.fetch(req("/pro/status", { method: "OPTIONS" }), offEnv(), ctx());
  assert.equal(pro.status, 204); assert.equal(pro.headers.get("access-control-allow-origin"), SAJT);
  const fel = await worker.fetch(req("/pro/status", { method: "OPTIONS", origin: "https://ond.example" }), offEnv(), ctx());
  assert.equal(fel.status, 403); assert.equal(fel.headers.get("access-control-allow-origin"), null);
  for (const p of ["/review", "/event", "/compare/status", "/health", "/pro", "/proX"]) {
    const r = await worker.fetch(req(p, { method: "OPTIONS" }), offEnv({ ALLOWED_ORIGIN: "https://granskaminoffert.se" }), ctx());
    assert.notEqual(r.headers.get("access-control-allow-origin"), SAJT, p);
  }
});

test("/pro utan snedstreck och /proX går inte till PRO-rutterna", async () => {
  for (const p of ["/pro", "/proX/status"]) {
    const r = await worker.fetch(req(p), offEnv({ ALLOWED_ORIGIN: "https://granskaminoffert.se" }), ctx());
    assert.equal(r.status, 404, p);
  }
});

test("wrangler.toml: avgränsad TEST enligt nattmandatet, samma origin/cron och inga kampanjkoder", () => {
  const t = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.match(t, /^\[triggers\]\ncrons = \["17 \* \* \* \*"\]$/m);
  assert.match(t, /^PRO_PAYMENTS = "test"$/m); // Endast verklig Stripe-testkedja före eventuell livebetalning.
  assert.match(t, /^PRO_ALLOWED_ORIGIN = "https:\/\/stahledigital\.se"$/m);
  assert.equal((t.match(/^PRO_PAYMENTS\s*=/gm) || []).length, 1);
  assert.doesNotMatch(t, /^PRO_KAMPANJKODER\s*=/m);
  assert.doesNotMatch(t, /^PRO_PRIS_/m);
});
