// F8: F2-körningens budgetspärr och körväg, helt offline. Inget riktigt AI-anrop, ingen nyckel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runF2 } from "../../scripts/f2_run.mjs";
import { buildReviewRequest } from "../src/index.js";
import { EXTRA } from "./f2/extra.mjs";

const facit = JSON.parse(readFileSync(new URL("./f2/facit.json", import.meta.url), "utf8"));
const KEY = "sk-ant-TESTNYCKEL-SKA-ALDRIG-SKRIVAS-UT";
const MODEL = "claude-sonnet-5-5";
const ENV = { F2_BUDGET_APPROVED: "yes", F2_BUDGET_USD: "5", F2_MAX_CALLS: "20", ANTHROPIC_API_KEY: KEY, ANTHROPIC_MODEL: MODEL };

// Mock av Anthropic: räknar anrop, ger fast tokenmätning och ett submit_review per fall.
function mockApi({ inputTokens = 2000, usage = { input_tokens: 2000, output_tokens: 1000 }, extractedFor = (c) => ({ ...EXTRA[c.id], ...c.expectExtracted }), countFails = false, status = 200, failAfter = Infinity, stopReason = "tool_use" } = {}) {
  const calls = { count: 0, messages: 0, bodies: [], headers: [] };
  const byText = new Map(facit.cases.map((c) => [c.text, c]));
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.headers.push(init.headers);
    if (String(url).endsWith("/count_tokens")) {
      calls.count++;
      if (countFails) return new Response("nere", { status: 500 });
      return Response.json({ input_tokens: inputTokens });
    }
    assert.equal(String(url), "https://api.anthropic.com/v1/messages");
    calls.messages++;
    calls.bodies.push(body);
    if (calls.messages > failAfter) throw new Error("nät nere");
    const text = body.messages[0].content[0].text;
    const c = [...byText.values()].find((x) => text.includes(x.text.slice(0, 40)));
    const extracted = { trades: [], ...(c ? extractedFor(c) : {}) };
    return Response.json({ stop_reason: stopReason, usage, content: [{ type: "tool_use", name: "submit_review", input: { trade: "annat", contradictions: [], clarify: [], stated: [], calcCoverage: "checked", calcNote: "", price: { comment: "x" }, questions: [], extracted } }] }, { status });
  };
  return { fetchImpl, calls };
}
const run = (env, api, extra = {}) => {
  const out = [];
  return runF2({ env, argv: [], fetchImpl: api.fetchImpl, write: (s) => out.push(s), ...extra }).then((r) => ({ ...r, out: out.join("\n") }));
};

test("F2-runner: utan godkännande eller exakta tak körs inget och inget anrop görs", async () => {
  const api = mockApi();
  for (const env of [{ ...ENV, F2_BUDGET_APPROVED: undefined }, { ...ENV, F2_BUDGET_USD: undefined }, { ...ENV, F2_MAX_CALLS: undefined }, { ...ENV, F2_BUDGET_USD: "0" }, { ...ENV, F2_BUDGET_USD: "-1" }, { ...ENV, F2_BUDGET_USD: "abc" }, { ...ENV, F2_MAX_CALLS: "1.5" }, { ...ENV, F2_MAX_CALLS: "0" }, { ...ENV, ANTHROPIC_API_KEY: undefined }, { ...ENV, ANTHROPIC_MODEL: "okänd-modell" }]) {
    const r = await run(env, api);
    assert.equal(r.exitCode, 2, JSON.stringify(Object.keys(env).filter((k) => env[k] === undefined)));
  }
  assert.equal(api.calls.count + api.calls.messages, 0);
});

test("F2-runner: körväg – samma begäran som Workern, alla fall mot facit, summering och exit 0", async () => {
  const api = mockApi();
  const r = await run(ENV, api);
  assert.equal(r.exitCode, 0, r.out);
  assert.equal(api.calls.messages, facit.cases.length);
  assert.equal(r.summary.calls, facit.cases.length);
  assert.equal(r.summary.casesRun, facit.cases.length);
  assert.equal(r.summary.stopped, null);
  // begäran är byte för byte Workerns byggare
  facit.cases.forEach((c, i) => assert.deepEqual(api.calls.bodies[i], buildReviewRequest({ model: MODEL, kind: "text", text: c.text })));
  // 5.5: ingen temperature och inget tvingat verktyg, thinking between_tools
  assert.equal("temperature" in api.calls.bodies[0], false);
  assert.deepEqual(api.calls.bodies[0].tool_choice, { type: "auto" });
  // kostnad: 10 × (2000 × 2/1e6 + 1000 × 10/1e6) = 0.14 USD
  assert.equal(r.summary.spentUsd, Number((facit.cases.length * 0.014).toFixed(6)));
});

test("F2-runner: avvikelser mot facit rapporteras och ger exit 1", async () => {
  const api = mockApi({ extractedFor: (c) => ({ ...EXTRA[c.id], ...c.expectExtracted, totalSumSek: 1 }) });
  const r = await run(ENV, api);
  assert.equal(r.exitCode, 1);
  assert.match(r.out, /AVVIKER/);
});

test("F2-runner: budgeten reserveras före varje anrop – stoppar före anropet som inte ryms", async () => {
  // Värsta fall per anrop: 2 000 × 2/1e6 + 6 000 × 10/1e6 = 0.064 USD. Faktisk kostnad i mocken är 0.014.
  // Tak 0.125: efter fyra anrop är 0.056 bokfört och 0.056 + 0.064 = 0.12 ryms → femte anropet görs;
  // efter fem är 0.07 + 0.064 = 0.134 > 0.125 → stopp före sjätte anropet.
  const api = mockApi();
  const r = await run({ ...ENV, F2_BUDGET_USD: "0.125" }, api);
  assert.equal(r.exitCode, 3);
  assert.equal(r.summary.stopped, "budget");
  assert.equal(api.calls.messages, 5);
  assert.equal(r.summary.calls, 5);
  assert.equal(r.summary.spentUsd, 0.07);
  assert.equal(api.calls.count, 6); // den sjätte tokenmätningen (gratis) gjordes, inget betalt anrop
});

test("F2-runner: ett tak som inte ens rymmer första reservationen ger inga betalda anrop", async () => {
  const api = mockApi();
  const r = await run({ ...ENV, F2_BUDGET_USD: "0.01" }, api);
  assert.equal(r.exitCode, 3);
  assert.equal(api.calls.messages, 0);
  assert.equal(r.summary.stopped, "budget");
});

test("F2-runner: anropstaket är exakt", async () => {
  const api = mockApi();
  const r = await run({ ...ENV, F2_MAX_CALLS: "4" }, api);
  assert.equal(api.calls.messages, 4);
  assert.equal(r.summary.stopped, "anropstak");
  assert.equal(r.exitCode, 3);
});

test("F2-runner: okänd kostnad stoppar – tokenmätning nere, användning saknas, kostnad över reservation", async () => {
  let api = mockApi({ countFails: true });
  let r = await run(ENV, api);
  assert.equal(r.exitCode, 3);
  assert.equal(r.summary.stopped, "okand_kostnad_tokenmatning");
  assert.equal(api.calls.messages, 0);

  api = mockApi({ usage: null });
  r = await run(ENV, api);
  assert.equal(r.summary.stopped, "okand_kostnad");
  assert.equal(api.calls.messages, 1);
  assert.ok(r.summary.spentUsd >= 0.064 - 1e-9, "okänd kostnad bokförs som värsta fall");

  api = mockApi({ usage: { input_tokens: 2000, output_tokens: 99999 } });
  r = await run(ENV, api);
  assert.equal(r.summary.stopped, "kostnad_over_reservation");
  assert.equal(api.calls.messages, 1);

  api = mockApi({ failAfter: 2 });
  r = await run(ENV, api);
  assert.equal(r.summary.stopped, "fel_efter_anrop");
  assert.equal(api.calls.messages, 3);
});

test("F2-runner: nyckel och rubriker skrivs aldrig ut", async () => {
  for (const api of [mockApi(), mockApi({ countFails: true }), mockApi({ usage: null })]) {
    const r = await run(ENV, api);
    const all = r.out + JSON.stringify(r.summary) + JSON.stringify(r.results);
    assert.ok(!all.includes(KEY));
    assert.ok(!/x-api-key/i.test(all));
  }
});

test("F2-runner: Haiku 5.5 – dokumenterad anropsform och prissatt kostnad, utan temperature och utan thinking-parameter", async () => {
  const api = mockApi();
  const env = { ...ENV, ANTHROPIC_MODEL: "claude-haiku-5-5", F2_BUDGET_USD: "0.25", F2_MAX_CALLS: "11" };
  const r = await run(env, api);
  assert.equal(r.exitCode, 0, r.out);
  assert.equal(api.calls.messages, facit.cases.length);
  const b = api.calls.bodies[0];
  assert.equal(b.model, "claude-haiku-5-5");
  assert.equal("temperature" in b, false);
  assert.equal("thinking" in b, false);
  assert.deepEqual(b.tool_choice, { type: "auto" });
  // 2 000 in × 0,10 + 1 000 ut × 0,50 per MTok = 0,0007 USD per anrop
  assert.equal(r.summary.spentUsd, Number((facit.cases.length * 0.0007).toFixed(6)));
  // värsta fall per anrop 2 000 × 0,1/1e6 + 6 000 × 0,5/1e6 = 0,0032 USD: hela provet ryms med stor marginal i taket 0,25
  assert.ok(facit.cases.length * 0.0032 < 0.25);
});

test("F8c: avkortat (max_tokens) eller nekat svar är fel i F2, aldrig PASS – samma regel som Workern", async () => {
  for (const [stopReason, label] of [["max_tokens", "max_tokens"], ["refusal", "refusal"]]) {
    const api = mockApi({ stopReason });
    const r = await run(ENV, api);
    assert.notEqual(r.exitCode, 0, stopReason);
    assert.equal(r.summary.pass, 0);
    assert.ok(r.results.every((x) => x.error === label), stopReason);
    assert.match(r.out, new RegExp(`FEL ${label}`));
  }
});

test("F8c: nivåpris – över 100 000 indatatokens reserveras Haikus högre pris och budgeten stoppar före betalt anrop", async () => {
  // 150 000 in + 6 000 max ut = 0,09 USD värsta fall; budget 0,02 ryms inte
  let api = mockApi({ inputTokens: 150000 });
  let r = await run({ ...ENV, ANTHROPIC_MODEL: "claude-haiku-5-5", F2_BUDGET_USD: "0.02" }, api);
  assert.equal(api.calls.messages, 0);
  assert.equal(r.summary.stopped, "budget");
  // med tillräcklig budget släpps anropet och den faktiska kostnaden prissätts på högre nivå
  api = mockApi({ inputTokens: 150000, usage: { input_tokens: 150000, output_tokens: 6000 } });
  r = await run({ ...ENV, ANTHROPIC_MODEL: "claude-haiku-5-5", F2_BUDGET_USD: "0.10", F2_MAX_CALLS: "1" }, api, { cases: [facit.cases[0]] });
  assert.equal(api.calls.messages, 1);
  assert.equal(r.summary.spentUsd, 0.09);
});
