// F7 S7a: GET /pro/referens – publik referensdata till förkontrollen i MR PRO, och larmet REGLER_SHA256.
// Kör hela workerns default-export. Inget nät: global fetch kastar och räknas. Syntetiska förfrågningar.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import worker from "../src/index.js";
import REFERENCE from "../src/reference.json" with { type: "json" };
import { REGLER_SHA256, REGLER_FILER } from "../src/regler_version.js";
import { ENV } from "./stripe_dubbel.mjs";

const API = "https://granskaminoffert-api.anders-316.workers.dev";
let natAnrop, origFetch;
beforeEach(() => {
  natAnrop = [];
  origFetch = globalThis.fetch;
  globalThis.fetch = async (u) => { natAnrop.push(String(u && u.url ? u.url : u)); throw new Error("nät förbjudet i provet"); };
});
afterEach(() => { globalThis.fetch = origFetch; });

const ctx = () => { const v = []; return { v, waitUntil: (p) => v.push(p), passThroughOnException() {} }; };

/** Env där varje läsning av en bindning eller variabel spelas in. Vägen ska inte läsa env alls. */
function spionEnv(bas) {
  const last = [];
  return { last, env: new Proxy(bas, { get(t, p) { if (typeof p === "string") last.push(p); return t[p]; } }) };
}
/** Riktiga dubblar (KV, DO) med räknare på varje KV-metod. */
function kvEnv(extra) {
  const kvAnrop = [];
  const e = ENV(extra);
  const kv = e.REVIEWS_KV;
  e.REVIEWS_KV = new Proxy(kv, { get(t, p) { const v = t[p]; return typeof v === "function" ? (...a) => { kvAnrop.push(String(p)); return v.apply(t, a); } : v; } });
  return { env: e, kvAnrop };
}

const LAGEN = [
  { PRO_PAYMENTS: "off", PRO_KONTO: "off" },
  { PRO_PAYMENTS: "test", PRO_KONTO: "inbjudna" },
  { PRO_PAYMENTS: "live", PRO_KONTO: "off" },
  {},
];

test("GET /pro/referens: 200, {schema:1, referenceVersion, reglerSha256, reference}, innehållet djupt lika med REFERENCE och reference.json", async () => {
  const c = ctx();
  const r = await worker.fetch(new Request(API + "/pro/referens"), ENV({ PRO_PAYMENTS: "off", PRO_KONTO: "off" }), c);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(Object.keys(j), ["schema", "referenceVersion", "reglerSha256", "reference"]);
  assert.equal(j.schema, 1);
  assert.equal(j.referenceVersion, REFERENCE.version);
  assert.equal(j.reglerSha256, REGLER_SHA256);
  assert.deepEqual(j.reference, REFERENCE);
  const fil = JSON.parse(readFileSync(new URL("../src/reference.json", import.meta.url), "utf8"));
  assert.deepEqual(j.reference, fil);
  // Nycklarna som MR:s förkontroll kräver (F7 4.5) finns.
  for (const k of ["rot", "hourly", "projects", "wording", "sources", "addons", "consumer"]) assert.ok(k in j.reference, k);
  await Promise.all(c.v);
  assert.equal(c.v.length, 0, "inget waitUntil");
  assert.deepEqual(natAnrop, []);
});

test("GET /pro/referens: headers enligt 4.3 – public max-age=3600, ETag, noindex, nosniff, ingen Set-Cookie, ingen CORS", async () => {
  const r = await worker.fetch(new Request(API + "/pro/referens"), ENV({ PRO_PAYMENTS: "off", PRO_KONTO: "off" }), ctx());
  assert.equal(r.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(r.headers.get("cache-control"), "public, max-age=3600");
  assert.equal(r.headers.get("etag"), `"${REFERENCE.version}-${REGLER_SHA256.slice(0, 12)}"`);
  assert.match(r.headers.get("etag"), /^"\d{4}-\d{2}-\d{2}-[0-9a-f]{12}"$/);
  assert.equal(r.headers.get("x-robots-tag"), "noindex");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("set-cookie"), null);
  assert.deepEqual(r.headers.getSetCookie(), []);
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  assert.equal(r.headers.get("vary"), null);
});

test("GET /pro/referens: samma svar i alla lägen av PRO_PAYMENTS och PRO_KONTO, utan KV-anrop, utan nät", async () => {
  let forsta = null;
  for (const lage of LAGEN) {
    const { env, kvAnrop } = kvEnv(lage);
    const c = ctx();
    const r = await worker.fetch(new Request(API + "/pro/referens"), env, c);
    assert.equal(r.status, 200, JSON.stringify(lage));
    const text = await r.text();
    if (forsta === null) forsta = text; else assert.equal(text, forsta, JSON.stringify(lage));
    await Promise.all(c.v);
    assert.deepEqual(kvAnrop, [], "KV-dubbeln räknar till 0 " + JSON.stringify(lage));
  }
  assert.deepEqual(natAnrop, []);
});

test("GET /pro/referens läser inte env alls (ingen bindning, ingen variabel) och struntar i cookie, kropp och Origin", async () => {
  const { last, env } = spionEnv(ENV({ PRO_PAYMENTS: "off", PRO_KONTO: "off" }));
  const r = await worker.fetch(new Request(API + "/pro/referens?x=1", {
    headers: { Cookie: "__Host-mrpro=hemlig; annan=1", Origin: "https://evil.example", Authorization: "Bearer x", "CF-Connecting-IP": "203.0.113.7" },
  }), env, ctx());
  assert.equal(r.status, 200);
  assert.deepEqual(r.headers.getSetCookie(), []);
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  // Envs nycklar som läses före vägen (ALLOWED_ORIGIN för CORS-listan) är de enda; inga bindningar.
  assert.deepEqual(last.filter((k) => k !== "ALLOWED_ORIGIN"), []);
  const j = await r.json();
  assert.deepEqual(j.reference, REFERENCE);
});

test("/pro/referens: POST, PUT, DELETE, PATCH, OPTIONS och HEAD ger 405 med Allow: GET, utan att röra env", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"]) {
    const { last, env } = spionEnv(ENV({ PRO_PAYMENTS: "off", PRO_KONTO: "off" }));
    const init = { method, headers: { Origin: "https://stahledigital.se" } };
    if (method !== "OPTIONS" && method !== "HEAD") { init.body = JSON.stringify({ belopp: 123456 }); init.headers["content-type"] = "application/json"; }
    const r = await worker.fetch(new Request(API + "/pro/referens", init), env, ctx());
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.get("allow"), "GET", method);
    assert.equal(r.headers.get("cache-control"), "no-store", method);
    assert.equal(r.headers.get("x-robots-tag"), "noindex", method);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff", method);
    assert.deepEqual(r.headers.getSetCookie(), [], method);
    assert.deepEqual(last.filter((k) => k !== "ALLOWED_ORIGIN"), [], method);
  }
  assert.deepEqual(natAnrop, []);
});

test("bara exakt /pro/referens: närliggande vägar går till /pro/-blocket som förut (off → 503 stangt)", async () => {
  for (const p of ["/pro/referens/", "/pro/referensx", "/pro/referens/x", "/pro/Referens"]) {
    const r = await worker.fetch(new Request(API + p), ENV({ PRO_PAYMENTS: "off", PRO_KONTO: "off" }), ctx());
    assert.notEqual(r.headers.get("etag"), `"${REFERENCE.version}-${REGLER_SHA256.slice(0, 12)}"`, p);
    assert.equal(r.status, 503, p);
  }
});

test("REGLER_SHA256 är sha256 av rules.js, amounts.js och money.js i den ordningen – LARM: ändrade regler kräver ny konstant och ny kopia i MR", () => {
  assert.deepEqual(REGLER_FILER, ["rules.js", "amounts.js", "money.js"]);
  const h = createHash("sha256");
  for (const f of REGLER_FILER) h.update(readFileSync(new URL("../src/" + f, import.meta.url)));
  const faktisk = h.digest("hex");
  assert.match(REGLER_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(faktisk, REGLER_SHA256,
    "Regelkoden (rules.js, amounts.js, money.js) har ändrats. Uppdatera REGLER_SHA256 i src/regler_version.js till " + faktisk +
    " och synka MR:s kopia (source/GMO_REGLER/synka.mjs) i samma släpp, annars visar PRO:s förkontroll fotnoten om äldre regler.");
});

test("regelkodens beroenden stannar inom de tre hashade filerna", () => {
  // Om rules.js/amounts.js/money.js börjar importera en fjärde fil täcker REGLER_SHA256 inte längre all regelkod.
  for (const f of REGLER_FILER) {
    const src = readFileSync(new URL("../src/" + f, import.meta.url), "utf8");
    for (const m of src.matchAll(/^\s*import\b[^;]*?from\s+["']([^"']+)["']/gm)) {
      assert.ok(["./amounts.js", "./money.js"].includes(m[1]), `${f} importerar ${m[1]}`);
    }
  }
});
