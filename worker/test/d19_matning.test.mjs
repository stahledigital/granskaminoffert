// D19 – mätkontraktet: (1) klientnormalisering och fientlig payloadmatris genom RIKTIGA /event-vägen,
// (2) serverdatapunkter i riktig workerd med SQLite-backade Durable Objects (inte bara mockade payloads).
// Analytics Engine är best-effort och lokalt en fångstbindning; detta är inget bevis på Cloudflares produktion.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { normalizeClientEvent } from "../src/index.js";
import { CLIENT_EVENT_NAMES, SERVER_EVENT_NAMES, clientDatapoint, serverEvent, felOrsakServer, orderProdukt } from "../src/measure.js";
import { startHarness } from "../dev/compare_harness.mjs";
import { offerText } from "./helpers/compare_env.mjs";

const ORIGIN = "https://granskaminoffert.se";
const fakeAE = () => { const p = []; return { p, writeDataPoint: (x) => p.push(x) }; };
const ctx = () => { const jobs = []; return { jobs, waitUntil: (p) => jobs.push(p) }; };
const post = (ae, b, o = {}) => worker.fetch(new Request("https://api.test/event", {
  method: "POST", headers: { Origin: o.origin || ORIGIN, "CF-Connecting-IP": "203.0.113.1", ...(o.h || {}) }, body: typeof b === "string" ? b : JSON.stringify(b),
}), { GRANSKA_H: ae, ALLOWED_ORIGIN: ORIGIN, ...(o.env || {}) }, ctx());

// ---------------------------------------------------------------- Klientkontrakt

test("mätning: gamla händelser är bakåtkompatibla (samma form, samma blobbar)", async () => {
  assert.deepEqual(normalizeClientEvent({ type: "client", event: "rapport_klar", role: "mottagare" }), { event: "rapport_klar", detail: "", role: "mottagare", test: false });
  assert.deepEqual(normalizeClientEvent({ type: "client", event: "export", detail: "sms", role: "hantverkare", test: true }), { event: "export", detail: "sms", role: "hantverkare", test: true });
  assert.equal(normalizeClientEvent({ type: "client", event: "export" }), null);
  const ae = fakeAE();
  await post(ae, { type: "share", channel: "email", role: "mottagare" });
  assert.deepEqual(ae.p, [{ blobs: ["klient_export", "email", "mottagare"], indexes: ["skarp"] }]);
});

test("mätning: nya händelser har fast form med 13 blobbar och klient_-prefix", async () => {
  const cases = [
    [{ event: "landing", entry: "root", product: "none", mode: "new" }, ["klient_landing", "", "okand", "none", "root", "", "", "", "new", "", "", "", ""]],
    [{ event: "landing", entry: "jamfor", product: "compare", mode: "resume" }, ["klient_landing", "", "okand", "compare", "jamfor", "", "", "", "resume", "", "", "", ""]],
    [{ event: "task_change", from: "none", to: "compare" }, ["klient_task_change", "", "okand", "", "", "", "", "", "", "none", "compare", "", ""]],
    [{ event: "view_return", product: "check", reason: "history" }, ["klient_view_return", "", "okand", "check", "", "", "", "history", "", "", "", "", ""]],
    [{ event: "input_choose", product: "free", method: "camera" }, ["klient_input_choose", "", "okand", "free", "", "camera", "", "", "", "", "", "", ""]],
    [{ event: "input_ready", product: "compare", method: "handoff", demo: false }, ["klient_input_ready", "", "okand", "compare", "", "handoff", "", "", "", "", "", "eget", ""]],
    [{ event: "inputs_ready", product: "compare" }, ["klient_inputs_ready", "", "okand", "compare", "", "", "", "", "", "", "", "", ""]],
    [{ event: "example_view", product: "free" }, ["klient_example_view", "", "okand", "free", "", "", "", "", "", "", "", "", ""]],
    [{ event: "submit", product: "check", method: "text", demo: false, seen: true }, ["klient_submit", "", "okand", "check", "", "text", "", "", "", "", "", "eget", "sett_exempel"]],
    [{ event: "client_error", product: "compare", stage: "config", reason: "timeout" }, ["klient_client_error", "", "okand", "compare", "", "", "config", "timeout", "", "", "", "", ""]],
    [{ event: "result_view", product: "free", demo: true }, ["klient_result_view", "", "okand", "free", "", "", "", "", "", "", "", "demo", ""]],
    [{ event: "checkout_open", product: "check" }, ["klient_checkout_open", "", "okand", "check", "", "", "", "", "", "", "", "", ""]],
  ];
  for (const [ev, blobs] of cases) {
    const ae = fakeAE();
    const r = await post(ae, { type: "client", ...ev });
    assert.equal(r.status, 204);
    assert.deepEqual(ae.p, [{ blobs, indexes: ["skarp"] }], JSON.stringify(ev));
    assert.equal(ae.p[0].blobs.length, 13);
    assert.ok(ae.p[0].blobs[0].startsWith("klient_"));
  }
  // roll och testläge följer med
  const ae = fakeAE();
  await post(ae, { type: "client", event: "input_choose", product: "free", method: "file", role: "hantverkare", test: true });
  await post(ae, { type: "client", event: "input_choose", product: "free", method: "file" }, { h: { "X-SD-Test": "1" } });
  assert.deepEqual(ae.p.map((x) => [x.blobs[2], x.indexes[0]]), [["hantverkare", "test"], ["okand", "test"]]);
  assert.equal(CLIENT_EVENT_NAMES.includes("landing"), true);
});

test("mätning: fientlig payloadmatris lagrar ingenting och imiterar aldrig serverhändelser", async () => {
  const ae = fakeAE();
  const bad = [
    { type: "client", event: "landing", entry: "root", product: "none" },                                   // obligatoriskt mode saknas
    { type: "client", event: "landing", entry: "https://granskaminoffert.se/?fbclid=abc", product: "none", mode: "new" },
    { type: "client", event: "landing", entry: "root", product: "none", mode: "x".repeat(50) },
    { type: "client", event: "task_change", from: "compare", to: "compare" },                               // samma uppgift är inget byte
    { type: "client", event: "task_change", from: "free", to: "none" },                                     // "none" är inget val
    { type: "client", event: "input_choose", product: ["free"], method: "file" },                          // array i enum
    { type: "client", event: "input_choose", product: { toString: "free" }, method: "file" },               // objekt i enum
    { type: "client", event: "input_choose", product: "constructor", method: "file" },
    { type: "client", event: "input_choose", product: "__proto__", method: "file" },
    { type: "client", event: "input_choose", product: "free", method: "Anna Andersson 0701234567" },     // fritext/persondata
    { type: "client", event: "inputs_ready", product: "free" },                                              // endast jämförelse har "alla klara"
    { type: "client", event: "checkout_open", product: "free" },                                             // gratis har ingen kassa
    { type: "client", event: "client_error", product: "free", stage: "input", reason: "Error: boom at a.js:1" },
    { type: "client", event: "view_return", product: "free", reason: "reload" },
    // klienten kan aldrig skapa serverbekräftade händelser eller nya namn
    { type: "client", event: "betalning_verifierad", product: "compare" },
    { type: "client", event: "server_paid" },
    { type: "client", event: "granskning_klar" },
    { type: "client", event: "leverans_klar", product: "compare" },
    { type: "client", event: "klient_landing", entry: "root", product: "none", mode: "new" },              // dubbelprefix
    { type: "client", event: "constructor" },
    { type: "client", event: "__proto__" },
    { type: "client", event: "hasOwnProperty" },
    { type: "client", event: ["landing"] },
    { type: "client", event: 7 },
    { type: "server", event: "landing", entry: "root", product: "none", mode: "new" },
    { type: "share", event: "landing" },
    ["client"], null, 5, "text", "",
  ];
  for (const b of bad) assert.equal((await post(ae, b)).status, 204);
  assert.equal(await post(ae, "{ trasig json").then((r) => r.status), 204);
  assert.equal((await post(ae, { type: "client", event: "landing", entry: "root", product: "none", mode: "new" }, { origin: "https://ond.example" })).status, 403);
  assert.equal((await post(ae, { type: "client", event: "landing", entry: "root", product: "none", mode: "new" }, { origin: "null" })).status, 403);
  assert.deepEqual(ae.p, [], "inget av detta får lagras");
});

test("mätning: extra fält ignoreras och når aldrig lagringen; byte- inte teckengräns", async () => {
  const ae = fakeAE();
  await post(ae, { type: "client", event: "example_view", product: "free", url: "https://x.test/?token=abc", orderId: "o_abc", filename: "Offert Anna.pdf", amount: 85000, text: "hemligt", __proto__: { polluted: 1 } });
  assert.deepEqual(ae.p, [{ blobs: ["klient_example_view", "", "okand", "free", "", "", "", "", "", "", "", "", ""], indexes: ["skarp"] }]);
  assert.equal(({}).polluted, undefined);
  assert.equal(JSON.stringify(ae.p).includes("Anna"), false);
  // exakt på gränsen: 1024 byte tillåts, 1025 avvisas tyst. Flerbyte-tecken räknas som byte (inte tecken).
  const base = { type: "client", event: "example_view", product: "free", pad: "" };
  const withBytes = (n) => { const o = { ...base }; const len = n - JSON.stringify(o).length; o.pad = "a".repeat(Math.max(0, len)); return JSON.stringify(o); };
  const ae2 = fakeAE();
  await post(ae2, withBytes(1024)); await post(ae2, withBytes(1025));
  assert.equal(ae2.p.length, 1);
  const ae3 = fakeAE();
  const multi = JSON.stringify({ type: "client", event: "example_view", product: "free", pad: "å".repeat(600) });
  assert.ok(multi.length <= 1024 && new TextEncoder().encode(multi).length > 1024);
  await post(ae3, multi);
  assert.deepEqual(ae3.p, [], "tecken ≤ 1024 men byte > 1024 ska avvisas");
});

test("mätning: mätfel och saknad bindning blockerar aldrig sidan", async () => {
  const boom = { writeDataPoint() { throw new Error("analytics nere"); } };
  assert.equal((await post(boom, { type: "client", event: "example_view", product: "free" })).status, 204);
  assert.equal((await post(undefined, { type: "client", event: "example_view", product: "free" })).status, 204);
  const limited = fakeAE();
  const r = await post(limited, { type: "client", event: "example_view", product: "free" }, { env: { EVENT_RL: { limit: async () => ({ success: false }) } } });
  assert.equal(r.status, 204);
  assert.deepEqual(limited.p, []);
  const rlBoom = await post(limited, { type: "client", event: "example_view", product: "free" }, { env: { EVENT_RL: { limit: async () => { throw new Error("rl"); } } } });
  assert.equal(rlBoom.status, 204);
});

test("mätning: servernamn kolliderar aldrig med klientnamn och mappningen är sluten", () => {
  for (const s of SERVER_EVENT_NAMES) { assert.equal(CLIENT_EVENT_NAMES.includes(s), false, s); assert.equal(s.startsWith("klient_"), false); }
  assert.equal(felOrsakServer("samtycke_saknas"), "samtycke");
  assert.equal(felOrsakServer("bekraftelse_ej_levererad"), "bekraftelse");
  assert.equal(felOrsakServer("något helt annat med Anna 0701234567"), "annat");
  assert.equal(felOrsakServer("constructor"), "annat");
  assert.equal(felOrsakServer("avlasning_misslyckades"), "avlasning");
  assert.equal(felOrsakServer("pott:slut"), "budget");
  assert.equal(felOrsakServer("budget:manad"), "budget");
  assert.equal(felOrsakServer(undefined), "annat");
  assert.equal(orderProdukt({ kind: "check" }), "check");
  assert.equal(orderProdukt({}), "compare");
  const ae = fakeAE();
  assert.equal(serverEvent({ GRANSKA_H: ae }, "order_skapad", { test: true }), true);
  assert.equal(serverEvent({ GRANSKA_H: ae }, "klient_landing", {}), false, "okänt servernamn skrivs inte");
  assert.equal(serverEvent({ GRANSKA_H: { writeDataPoint() { throw new Error("x"); } } }, "order_skapad", {}), false);
  assert.equal(serverEvent({}, "order_skapad", {}), true);
  assert.deepEqual(ae.p, [{ blobs: ["order_skapad", "compare", ""], indexes: ["test"] }]);
  assert.deepEqual(clientDatapoint({ event: "rapport_klar", detail: "", role: "okand" }, "skarp"), { blobs: ["klient_rapport_klar", "", "okand"], indexes: ["skarp"] });
});

// ---------------------------------------------------------------- Serverkontrakt i riktig workerd/SQLite

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("tidsgräns i test"); await sleep(100); } }
const spec = (t) => ({ extracted: { totalBeforeRotSek: t, totalVatBasis: "inkl" }, scope: { rivning: "ingar", material: "ingar", arbete: "ingar", bortforsling: "ingar", resor: "ingar" } });

function api(h) {
  const call = (method, p, { token, body } = {}) => fetch(h.base + p, { method, headers: { Origin: h.base, ...(token ? { "x-order-token": token } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { call };
}
const names = (h) => h.points.map((p) => p.blobs[0]);
async function checkout(h, a, orderId, token, isCheck = false) {
  const cfgAll = await (await a.call("GET", "/compare/config")).json();
  const cfg = isCheck ? cfgAll.check.consent : cfgAll.consent;
  const accept = isCheck ? { terms: true, declaration: true } : { terms: true, immediateDelivery: true };
  const r = await a.call("POST", `/compare/orders/${orderId}/checkout`, { token, body: { accept: { ...accept, consentHash: cfg.hash, consentVersion: cfg.version, email: "kund@example.test" } } });
  return { status: r.status, json: await r.json() };
}

test("workerd: serverdatapunkter följer beständiga beslut (ingen dubbelräkning vid replay, reuse, ersättning)", async () => {
  const h = await startHarness();
  const a = api(h);
  try {
    // /event når den RIKTIGA Workern via harnessen och landar i fångstbindningen
    const ev = await fetch(h.base + "/event", { method: "POST", headers: { Origin: h.base }, body: JSON.stringify({ type: "client", event: "landing", entry: "root", product: "none", mode: "new" }) });
    assert.equal(ev.status, 204);
    await until(() => names(h).includes("klient_landing"));
    assert.equal(h.points[0].indexes[0], "skarp");

    const c = await (await a.call("POST", "/compare/orders", { body: { docCount: 2, labels: ["A", "B"], accept: { sameJob: true } } })).json();
    const { orderId, token } = c;
    await until(() => names(h).includes("order_skapad"));
    const put = (i, t) => a.call("PUT", `/compare/orders/${orderId}/docs/${i}`, { token, body: { kind: "text", text: offerText(spec(t)) } });
    assert.equal((await put(0, 100000)).status, 200);
    assert.equal((await put(0, 100000)).status, 200); // samma fil igen: ingen ny mottagning
    await until(() => names(h).filter((n) => n === "underlag_mottaget").length >= 1);
    assert.equal((await put(1, 95000)).status, 200);
    await until(() => names(h).includes("underlag_kompletta"));
    assert.equal((await put(0, 101000)).status, 200); // ersättning i fullständigt manifest: ny mottagning, inte ny fullständighet
    await until(() => names(h).filter((n) => n === "underlag_mottaget").length >= 3);
    await sleep(300);
    const server = h.points.filter((p) => !p.blobs[0].startsWith("klient_"));
    assert.deepEqual(server.map((p) => p.blobs), [
      ["order_skapad", "compare", ""],
      ["underlag_mottaget", "compare", "ny"],
      ["underlag_mottaget", "compare", "ny"],
      ["underlag_kompletta", "compare", "2"],
      ["underlag_mottaget", "compare", "ersatt"],
    ]);
    assert.ok(server.every((p) => p.indexes[0] === "skarp"));

    // checkout: återanvändning ger ingen ny händelse
    const k1 = await checkout(h, a, orderId, token);
    assert.equal(k1.status, 200, JSON.stringify(k1.json));
    const k2 = await checkout(h, a, orderId, token);
    assert.equal(k2.status, 200);
    await until(() => names(h).includes("checkout_skapad"));
    await sleep(300);
    assert.equal(names(h).filter((n) => n === "checkout_skapad").length, 1);
    assert.deepEqual(h.points.find((p) => p.blobs[0] === "checkout_skapad").blobs, ["checkout_skapad", "compare", "forsta"]);
    assert.equal(names(h).includes("betalning_verifierad"), false, "checkoutklick/redirect är inte betalning");

    // betalning: webhook med två olika event-ID + samtidig avstämning ⇒ EN betalning
    const s = [...h.sessions.values()][0];
    s.obj = { ...s.obj, status: "complete", payment_status: "paid", payment_intent: "pi_dev_" + s.obj.id.slice(-10) };
    await Promise.all([h.sendWebhook(s, "checkout.session.completed", "evt_a"), h.sendWebhook(s, "checkout.session.completed", "evt_b"), h.sendWebhook(s, "checkout.session.completed", "evt_a")]);
    const st = await until(async () => { const o = (await (await a.call("GET", `/compare/orders/${orderId}`, { token })).json()).order; return ["delivered", "failed"].includes(o.status) ? o : null; });
    assert.equal(st.status, "delivered");
    await h.sendWebhook(s, "checkout.session.completed", "evt_c"); // replay efter leverans
    for (let i = 0; i < 3; i++) await a.call("GET", `/compare/orders/${orderId}`, { token }); // polling
    await a.call("GET", `/compare/orders/${orderId}/report`, { token });                         // rapporthämtning
    await sleep(500);
    const all = h.points.filter((p) => !p.blobs[0].startsWith("klient_")).map((p) => p.blobs[0]);
    assert.equal(all.filter((n) => n === "betalning_verifierad").length, 1);
    assert.equal(all.filter((n) => n === "leverans_klar").length, 1);
    assert.equal(all.includes("order_fel"), false);
    assert.equal(all.indexOf("betalning_verifierad") < all.indexOf("leverans_klar"), true);
    // inga personuppgifter eller id:n i någon datapunkt
    const dump = JSON.stringify(h.points);
    assert.equal(dump.includes(orderId), false); assert.equal(dump.includes(token), false); assert.equal(dump.includes("kund@example.test"), false);
  } finally { await h.close(); }
});

test("workerd: förkontroll får egen produkt; terminalt fel och bekräftad återbetalning är separata, en gång vardera", async () => {
  const h = await startHarness({ vars: { COMPARE_AUTO_REFUND: "1", COMPARE_CONSENT_POLICY: "P" } });
  h.ctl.failAnthropic = 60;
  const a = api(h);
  try {
    const c = await (await a.call("POST", "/compare/orders", { body: { docCount: 1, labels: ["Offert"], accept: { sameJob: true }, kind: "check" } })).json();
    assert.ok(c.orderId, JSON.stringify(c));
    const { orderId, token } = c;
    assert.equal((await a.call("PUT", `/compare/orders/${orderId}/docs/0`, { token, body: { kind: "text", text: offerText(spec(90000)) } })).status, 200);
    const k = await checkout(h, a, orderId, token, true);
    assert.equal(k.status, 200, JSON.stringify(k.json));
    const s = [...h.sessions.values()][0];
    s.obj = { ...s.obj, status: "complete", payment_status: "paid", payment_intent: "pi_dev_" + s.obj.id.slice(-10) };
    await h.sendWebhook(s);
    const st = await until(async () => { const o = (await (await a.call("GET", `/compare/orders/${orderId}`, { token })).json()).order; return ["delivered", "failed"].includes(o.status) ? o : null; }, 90000);
    assert.equal(st.status, "failed");
    await until(() => names(h).includes("aterbetalning_bekraftad"), 20000);
    await sleep(500);
    const server = h.points.filter((p) => !p.blobs[0].startsWith("klient_")).map((p) => p.blobs);
    assert.deepEqual(server.map((b) => b[0]), ["order_skapad", "underlag_mottaget", "underlag_kompletta", "checkout_skapad", "betalning_verifierad", "order_fel", "aterbetalning_bekraftad"]);
    assert.ok(server.every((b) => b[1] === "check"));
    assert.deepEqual(server.find((b) => b[0] === "order_fel"), ["order_fel", "check", "avlasning"]);
    assert.deepEqual(server.find((b) => b[0] === "aterbetalning_bekraftad"), ["aterbetalning_bekraftad", "check", "auto"]);
    assert.equal(names(h).includes("leverans_klar"), false);
  } finally { await h.close(); }
});
