// D11 förköpsidentitet (offline): användarstartad AI-läsning av utställaren, reserverad i den gemensamma potten, engångs per dokument.
// Anthropic är en attrapp; inga riktiga anrop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, installFetch, api, readyOrder, ORIGIN } from "./helpers/compare_env.mjs";
import { gateVars } from "./helpers/free_gate.mjs";
import { preidConfig, preidProposals, buildPreidRequest, sanitizePreid } from "../src/compare_preid.js";
import { issuerFixture } from "./helpers/compare_env.mjs";

const ALL = { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" };
const S = (total, issuer) => ({ extracted: { totalBeforeRotSek: total, totalVatBasis: "inkl" }, scope: ALL, issuer });
const ON = { COMPARE_PREID: "1", COMPARE_PREID_VERIFIED: "1", COMPARE_PREID_ORDER_CAP_MICRO: "500000" };
const pot = (env) => [...env.FREE_BUDGET.objects.values()][0];
const preid = (env, orderId, token, idx, over = {}) => api(env, "POST", `/compare/orders/${orderId}/preid`, { token, body: { idx }, ...over });

test("AV som standard: kräver COMPARE_PREID + VERIFIED + människosatt ordertak; annars 503 och inget anrop", async () => {
  const f = installFetch();
  try {
    for (const extra of [{}, { COMPARE_PREID: "1" }, { COMPARE_PREID: "1", COMPARE_PREID_VERIFIED: "1" }, { ...ON, COMPARE_PREID_ORDER_CAP_MICRO: "0" }]) {
      const env = makeEnv(extra); assert.equal(preidConfig(env).on, false);
      const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
      assert.equal((await preid(env, orderId, token, 0)).status, 503);
    }
    assert.equal(f.log.anthropic.length, 0);
    const cfg = (await api(makeEnv(), "GET", "/compare/config")).json; assert.equal(cfg.preid.on, false); assert.equal(cfg.preid.text, undefined);
    const on = (await api(makeEnv(ON), "GET", "/compare/config")).json; assert.equal(on.preid.on, true); assert.equal(on.preid.draft, true); assert.match(on.preid.text, /Då skickas din offert till AI-leverantören/);
  } finally { f.restore(); }
});

test("modell: bara claude-sonnet-5-5 (Anders beslut); annat modellval ⇒ AV (fail closed), inget Haikuanrop kan skapas", async () => {
  assert.equal(preidConfig(makeEnv(ON)).model, "claude-sonnet-5-5");
  assert.equal(preidConfig(makeEnv({ ...ON, COMPARE_PREID_MODEL: "claude-sonnet-5-5" })).on, true);
  for (const m of ["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-4-5-20250929", "x"]) assert.equal(preidConfig(makeEnv({ ...ON, COMPARE_PREID_MODEL: m })).on, false, m);
  const f = installFetch();
  try {
    const env = makeEnv({ ...ON, COMPARE_PREID_MODEL: "claude-haiku-5-5", ANTHROPIC_MODEL: "claude-haiku-5-5" });
    const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
    assert.equal((await preid(env, orderId, token, 0)).status, 503); assert.equal(f.log.anthropic.length, 0);
    assert.equal(JSON.stringify((await api(env, "GET", "/compare/config")).json.preid), '{"on":false}');
  } finally { f.restore(); }
});

test("kalkyl för Sonnet 5.5: värsta fall per dokument ≈ indata×2 USD/MTok + 6000 utdata×10 USD/MTok; reservationen ryms många gånger i 20 USD-potten och i ordertaket", async () => {
  const { worstCaseUsd } = await import("../src/models.js");
  const w = worstCaseUsd("claude-sonnet-5-5", 3600); // 3000 tokens dokument + 600 marginal
  assert.ok(Math.abs(w - (3600 / 1e6 * 2 + 6000 / 1e6 * 10)) < 1e-9); assert.ok(w < 0.07, String(w));
  assert.ok(4 * w * 1e6 < 500000, "fyra dokument ryms i ordertaket 0,50 USD");
});

test("läser utställaren per offert: små anrop, ett per dokument, spårad reservation i EN gemensam pott, förslag auto/bekräfta/enskild", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(ON);
    const { orderId, token } = await readyOrder(env, [S(100000, { name: "Byggfirma AB" }), S(101000, { name: "Syd Bygg AB", orgnr: "556000-0167", city: null }), S(102000, { name: "Karl Karlsson", orgnr: "850101-1234" })]);
    const r0 = await preid(env, orderId, token, 0); assert.equal(r0.status, 200, JSON.stringify(r0.json));
    await preid(env, orderId, token, 1); const r2 = await preid(env, orderId, token, 2);
    assert.equal(f.log.anthropic.length, 3);
    for (const req of f.log.anthropic) { assert.equal(req.tools[0].name, "submit_issuer"); assert.equal(req.model, "claude-sonnet-5-5"); assert.doesNotMatch(JSON.stringify(req.tools), /totalSum|scope/); }
    const pr = r2.json.proposals;
    assert.equal(pr[0].state, "auto"); assert.equal(pr[0].name, "Byggfirma AB");
    assert.equal(pr[1].state, "bekrafta"); assert.equal(pr[1].reason, "ort_saknas");
    assert.equal(pr[2].state, "enskild"); assert.equal(JSON.stringify(pr[2]).includes("Karl"), false, "enskild firma: inget namn lämnar servern");
    assert.equal(JSON.stringify(pr).includes("556016"), false, "förslagen bär aldrig orgnr");
    // EN pott, reservationer avräknade
    assert.equal(env.FREE_BUDGET.objects.size, 1); const m = pot(env).store.get("m"); assert.ok(m.spent > 0 && m.spent < 100000, "små belopp: " + m.spent); assert.equal(Object.keys(m.res || {}).length, 0);
    // förköps-GET ger samma förslag utan nytt anrop
    const g = await api(env, "GET", `/compare/orders/${orderId}/sources/identity`, { token }); assert.equal(g.status, 200); assert.equal(g.json.stage, "forkop"); assert.equal(g.json.read, 3); assert.deepEqual(g.json.proposals, pr);
    assert.equal(f.log.anthropic.length, 3);
  } finally { f.restore(); }
});

test("engångs per dokument: upprepad förfrågan ger cachat svar utan nytt anrop; fel ger högst två försök och frigör potten", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(ON);
    const { orderId, token } = await readyOrder(env, [S(100000, { name: "A AB" }), S(110000, { name: "B AB", orgnr: "556000-0167" })]);
    await preid(env, orderId, token, 0); await preid(env, orderId, token, 0); await preid(env, orderId, token, 0);
    assert.equal(f.log.anthropic.length, 1, "cachat");
    f.ctl.failNext.push(500, 500); // nästa dokument: två HTTP-fel
    assert.equal((await preid(env, orderId, token, 1)).status, 502); assert.equal((await preid(env, orderId, token, 1)).status, 502);
    assert.equal((await preid(env, orderId, token, 1)).status, 429, "tredje försöket nekas");
    assert.equal(f.log.anthropic.length, 3);
    const m = pot(env).store.get("m"); assert.equal(Object.keys(m.res || {}).length, 0, "HTTP-fel frigör reservationen");
  } finally { f.restore(); }
});

test("pott ej aktiv / tak slut / okänd användning ⇒ inget (nytt) anrop; hård halt består", async () => {
  const f = installFetch();
  try {
    let env = makeEnv({ ...ON, FREE_PILOT_ENABLED: "0" });
    let o = await readyOrder(env, [S(100000), S(110000)]);
    assert.equal((await preid(env, o.orderId, o.token, 0)).status, 503); assert.equal(f.log.anthropic.length, 0);
    env = makeEnv({ ...ON, ...gateVars({ FREE_PILOT_CAP_MICRO: "1000" }) });
    o = await readyOrder(env, [S(100000), S(110000)]);
    assert.equal((await preid(env, o.orderId, o.token, 0)).status, 503); assert.equal(f.log.anthropic.length, 0);
    // okänd användning: halt, nästa dokument nekas
    env = makeEnv(ON); o = await readyOrder(env, [S(100000, { name: "A AB" }), S(110000, { name: "B AB", orgnr: "556000-0167" })]);
    f.ctl.noUsage = true; assert.equal((await preid(env, o.orderId, o.token, 0)).status, 200);
    const before = f.log.anthropic.length; assert.equal((await preid(env, o.orderId, o.token, 1)).status, 503); assert.equal(f.log.anthropic.length, before);
  } finally { f.restore(); }
});

test("ordertaket (extra, människosatt) och behörighet: fel token/origin nekas; litet ordertak ⇒ inget anrop", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({ ...ON, COMPARE_PREID_ORDER_CAP_MICRO: "10" });
    const o = await readyOrder(env, [S(100000), S(110000)]);
    assert.equal((await preid(env, o.orderId, o.token, 0)).status, 503); assert.equal(f.log.anthropic.length, 0);
    const env2 = makeEnv(ON); const o2 = await readyOrder(env2, [S(100000), S(110000)]);
    assert.equal((await preid(env2, o2.orderId, "x".repeat(40), 0)).status, 404);
    assert.equal((await preid(env2, o2.orderId, o2.token, 0, { origin: "https://evil.example" })).status, 403);
    assert.equal((await preid(env2, o2.orderId, o2.token, 7)).status, 400);
    assert.equal(f.log.anthropic.length, 0);
  } finally { f.restore(); }
});

test("enhetsnivå: begäran innehåller bara identitetsverktyget; sanering som efter köp; oläsligt svar ⇒ inget påstående", () => {
  const body = buildPreidRequest({ model: "claude-sonnet-5-5", doc: { kind: "text", text: "Offert, X AB" } });
  assert.equal(body.tools.length, 1); assert.equal(body.tools[0].name, "submit_issuer"); assert.equal(body.max_tokens, 6000, "ingen nedklämning");
  assert.equal(sanitizePreid({ issuer: null }), null);
  const ok = sanitizePreid({ issuer: issuerFixture({}), readability: { level: "bra" } }); assert.equal(ok.state, "komplett"); assert.equal(ok.sendable, true);
  assert.equal(preidProposals(2, {})[0].state, "ingen");
});

// ---- Race/identitetsbindning (root-QA P1): unik claim per generation, hash/ctx-bindning, put kontrolleras, kostnad avräknas en gång per generation ----
import { upload } from "./helpers/compare_env.mjs";
const until = async (fn) => { for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 5)); } throw new Error("tidsgräns i test"); };
const defer = () => { let go; const p = new Promise((r) => { go = r; }); return { p, go }; };
const EACH = 14000; // µUSD per mockgeneration: 3000 in × 2 + 800 ut × 10 USD/MTok

async function raceCase(order) { // order: "gammal-forst" | "ny-forst"
  const f = installFetch();
  try {
    const env = makeEnv(ON);
    const { orderId, token } = await readyOrder(env, [S(100000, { name: "Gammal firma AB" }), S(110000, { name: "B AB", orgnr: "556000-0167" })]);
    const h1 = defer(), h2 = defer(); f.ctl.holdIssuer = [h1.p, h2.p];
    const p1 = preid(env, orderId, token, 0); await until(() => f.log.anthropic.length === 1);
    const up = await upload(env, orderId, token, 0, S(100500, { name: "Ny firma AB", orgnr: "556016-0680" })); assert.equal(up.status, 200);
    const p2 = preid(env, orderId, token, 0); await until(() => f.log.anthropic.length === 2);
    if (order === "gammal-forst") { h1.go(); await new Promise((r) => setTimeout(r, 30)); h2.go(); } else { h2.go(); await new Promise((r) => setTimeout(r, 30)); h1.go(); }
    const [r1, r2] = [await p1, await p2];
    assert.equal(r2.status, 200, JSON.stringify(r2.json)); assert.equal(r2.json.proposals[0].name, "Ny firma AB");
    assert.equal(r1.status, 409, "sent/ersatt svar för gammalt dokument används aldrig"); assert.equal(JSON.stringify(r1.json).includes("Gammal"), false);
    const g = await api(env, "GET", `/compare/orders/${orderId}/sources/identity`, { token });
    assert.equal(g.json.proposals[0].name, "Ny firma AB"); assert.equal(JSON.stringify(g.json).includes("Gammal"), false);
    const m = pot(env).store.get("m");
    assert.equal(m.spent, 2 * EACH, "två generationer ⇒ två avräkningar (inget återanvänt idem-id)"); assert.equal(Object.keys(m.res || {}).length, 0);
    assert.equal(f.log.anthropic.length, 2);
  } finally { f.restore(); }
}
test("race: gammalt modellsvar släpps FÖRE det nya – nytt dokument får aldrig gammal identitet; två reservationer/avräkningar", () => raceCase("gammal-forst"));
test("race: gammalt modellsvar släpps EFTER det nya – kan inte ersätta state=done; kostnaden avräknad en gång per generation", () => raceCase("ny-forst"));

test("filbyte EFTER done: gammal identitet blir aldrig auto för nytt dokument; ny läsning krävs (ej cachad)", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(ON);
    const { orderId, token } = await readyOrder(env, [S(100000, { name: "Gammal firma AB" }), S(110000, { name: "B AB", orgnr: "556000-0167" })]);
    const r0 = await preid(env, orderId, token, 0); assert.equal(r0.json.proposals[0].name, "Gammal firma AB");
    await upload(env, orderId, token, 0, S(100500, { name: "Ny firma AB", orgnr: "556016-0680" }));
    const g = await api(env, "GET", `/compare/orders/${orderId}/sources/identity`, { token });
    assert.equal(g.json.proposals[0].state, "ingen"); assert.equal(JSON.stringify(g.json).includes("Gammal"), false);
    const r1 = await preid(env, orderId, token, 0); assert.equal(r1.status, 200); assert.equal(r1.json.proposals[0].name, "Ny firma AB");
    assert.equal(f.log.anthropic.length, 2, "ny hash ⇒ ny generation, inte cachad");
    assert.equal(pot(env).store.get("m").spent, 2 * EACH);
  } finally { f.restore(); }
});

test("parallella anrop för SAMMA dokument: ett modellanrop (andra får 409 pågår); därefter cache utan nytt anrop", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(ON);
    const { orderId, token } = await readyOrder(env, [S(100000, { name: "A AB" }), S(110000, { name: "B AB", orgnr: "556000-0167" })]);
    const h = defer(); f.ctl.holdIssuer = [h.p];
    const p1 = preid(env, orderId, token, 0); await until(() => f.log.anthropic.length === 1);
    const p2 = await preid(env, orderId, token, 0); assert.equal(p2.status, 409);
    h.go(); assert.equal((await p1).status, 200);
    assert.equal((await preid(env, orderId, token, 0)).status, 200);
    assert.equal(f.log.anthropic.length, 1); assert.equal(pot(env).store.get("m").spent, EACH);
  } finally { f.restore(); }
});

test("ctx-bindning: ändrad modell/prompt/schema gör gamla identiteter ogiltiga (ingen auto ur gammal produktion)", async () => {
  const { preidCtx } = await import("../src/compare_preid.js");
  const a = await preidCtx("claude-sonnet-5-5"), b = await preidCtx("claude-opus-5-5");
  assert.notEqual(a, b); assert.match(a, /^pc1:[0-9a-f]{40}$/);
  const f = installFetch();
  try {
    const env = makeEnv(ON);
    const { orderId, token } = await readyOrder(env, [S(100000, { name: "A AB" }), S(110000, { name: "B AB", orgnr: "556000-0167" })]);
    await preid(env, orderId, token, 0);
    const stub = env.COMPARE_ORDERS.peek(orderId); const st = await stub.store.get("preid"); st.rec[0].ctx = "pc1:" + "0".repeat(40); stub.store.set("preid", st); // som om den lästes med annan prompt/schema
    const g = await api(env, "GET", `/compare/orders/${orderId}/sources/identity`, { token }); assert.equal(g.json.proposals[0].state, "ingen");
  } finally { f.restore(); }
});
