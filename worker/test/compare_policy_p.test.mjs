// Policy P (isolerad KANDIDAT bakom COMPARE_CONSENT_POLICY=P, default Q oförändrad): två separata aktivt valda rutor före betalning, frusna samtycken, bekräftelse "sent" före start,
// serverbedömt fullgörande (leverans / fonster_slut + källtäckning), ångerrätt kvar vid saknat/partiellt/motstridigt bevis, ingen retroaktiv Q→P. ENDAST attrapper: ingen Stripe/modell/mejl/Google.
// Texterna är UTKAST; klassificering och fullgörandepunkt är inte rättsligt fastställda (Modesty §12 U1–U9).
import { test } from "node:test";
import assert from "node:assert/strict";
import { consentPolicy, fulfilmentPoint, acceptingOrders, consentSnapshot } from "../src/compare_config.js";
import { sha256Hex } from "../src/compare_util.js";
import { makeEnv, installFetch, api, readyOrder, startCheckout, paidSession, webhook, consentOf, TEST_EMAIL } from "./helpers/compare_env.mjs";

const S = (total) => ({ extracted: { totalBeforeRotSek: total, totalVatBasis: "inkl" }, scope: { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" } });
const P = { COMPARE_CONSENT_POLICY: "P" };
const PE = { ...P, COMPARE_AUTO_REFUND: "1" }; // automatisk återbetalning mot Stripe-attrappen (loggas i f.log.refunds)
const st = (env, id) => env.COMPARE_ORDERS.peek(id).store;
const ledgerOf = (env, id) => st(env, id).get("ledger");
const orderOf = (env, id) => st(env, id).get("order");
const view = async (env, id, token) => (await api(env, "GET", `/compare/orders/${id}`, { token })).json.order;
const withdraw = (env, id, token) => api(env, "POST", `/compare/orders/${id}/withdraw`, { token });
const mailer = () => { const m = { sent: [], down: false }; m.send = async (msg) => { if (m.down) throw new Error("nere"); m.sent.push(msg); return { ok: true, ref: "ref_" + msg.id.slice(-8) }; }; return m; };
async function create(env, f) {
  const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
  return { orderId, token };
}
async function pay(env, f, { orderId, token }) {
  assert.equal((await startCheckout(env, orderId, token)).status, 200);
  const sess = [...f.sessions.values()].filter((s) => s.client_reference_id === orderId).pop();
  assert.equal((await webhook(env, "checkout.session.completed", paidSession(sess))).status, 200);
}
async function paidP(env, f, { run = true } = {}) { const o = await create(env, f); await pay(env, f, o); if (run) await env.COMPARE_ORDERS.runAlarms(); return o; }
const withClock = async (offsetMs, fn) => { const real = Date.now; Date.now = () => real() + offsetMs; try { return await fn(); } finally { Date.now = real; } };
const defer = () => { let r; const p = new Promise((x) => { r = x; }); return { p, r }; };

test("policy: default Q oförändrad; P kräver explicit flagga, har egen version/hash, fullgörandepunkt explicit och ogiltigt värde stänger (fail closed)", async () => {
  const q = makeEnv(), p = makeEnv(P);
  assert.equal(consentPolicy(q), "Q"); assert.equal(consentPolicy(p), "P"); assert.equal(consentPolicy(makeEnv({ COMPARE_CONSENT_POLICY: "p" })), "Q"); assert.equal(consentPolicy(makeEnv({ COMPARE_CONSENT_POLICY: "1" })), "Q");
  const cq = await consentOf(q), cp = await consentOf(p);
  assert.equal(cq.policy, "Q"); assert.ok(cq.texts.immediate); assert.equal(cq.texts.startNow, undefined);
  assert.equal(cp.policy, "P"); assert.ok(cp.texts.declaration && cp.texts.terms && cp.texts.fulfilmentDef); assert.equal(cp.texts.startNow, undefined); assert.equal(cp.texts.loseRight, undefined); assert.equal(cp.texts.immediate, undefined); assert.notEqual(cp.hash, cq.hash); assert.notEqual(cp.version, cq.version);
  assert.equal(cp.texts.declaration, "Jag vill att jämförelsen börjar direkt och godtar att ångerrätten upphör när tjänsten är helt utförd."); assert.equal(cp.texts.terms, "Genom att köpa godkänner du köpvillkoren."); assert.match(cp.texts.fulfilmentDef, /helt utförd när jag har fått min jämförelserapport/);
  assert.equal(cp.fulfilmentPoint, "leverans"); assert.equal(fulfilmentPoint(p).explicit, false);
  const w = makeEnv({ ...P, COMPARE_FULFILMENT_POINT: "fonster_slut" }); assert.equal(fulfilmentPoint(w).point, "fonster_slut"); assert.match((await consentOf(w)).texts.fulfilmentDef, /24 timmar/);
  assert.equal(consentSnapshot(w).fulfilmentPoint, "fonster_slut"); assert.notEqual((await consentOf(w)).hash, cp.hash, "fullgörandepunkten ingår i hashen");
  const bad = makeEnv({ ...P, COMPARE_FULFILMENT_POINT: "nagonannan" }); assert.equal(fulfilmentPoint(bad).ok, false); assert.equal(acceptingOrders(bad, ["https://granskaminoffert.se"]), false);
  assert.equal((await api(bad, "GET", "/compare/config")).json.accepting, false);
  assert.equal(acceptingOrders(makeEnv({ COMPARE_FULFILMENT_POINT: "nagonannan" }), ["https://granskaminoffert.se"]), true, "Q påverkas inte av fullgörandepunkten");
  // villkorstexten: P-sektioner, inga Q-sektioner
  const ids = (await api(p, "GET", "/compare/config")).json.terms.sections.map((x) => x.id);
  for (const id of ["angerratt", "efterleverans", "ofullstandig", "aterbetalning", "kontakt"]) assert.ok(ids.includes(id), id);
  const terms = JSON.stringify((await api(p, "GET", "/compare/config")).json.terms);
  assert.match(terms, /hela beloppet tillbaka/); assert.match(terms, /Analysen startar först när betalningen är genomförd, du har markerat rutan och vi har skickat din avtalsbekräftelse/); assert.match(terms, /reklamera/);
});

test("samtyckesmatris: båda rutorna + villkor krävs aktivt; saknad/felaktig/Q-stil ruta ⇒ 400, ingen betalsession, ingen start", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(PE); const c = await consentOf(env); const { orderId, token } = await create(env, f);
    const base = { terms: true, declaration: true, consentHash: c.hash, consentVersion: c.version, email: TEST_EMAIL };
    const cases = [
      ["deklaration saknas", { ...base, declaration: undefined }], ["gamla tre rutor utan deklaration", { terms: true, startNow: true, loseRight: true, consentHash: c.hash, consentVersion: c.version, email: TEST_EMAIL }],
      ["bara villkor", { terms: true, consentHash: c.hash, consentVersion: c.version, email: TEST_EMAIL }], ["terms saknas", { ...base, terms: undefined }],
      ["deklaration false", { ...base, declaration: false }], ["sträng 'true'", { ...base, declaration: "true" }], ["1", { ...base, declaration: 1 }],
      ["Q-stil (immediateDelivery) under P", { terms: true, immediateDelivery: true, consentHash: c.hash, consentVersion: c.version, email: TEST_EMAIL }],
      ["Q-stil utan deklaration", { ...base, declaration: undefined, immediateDelivery: true }],
    ];
    for (const [name, accept] of cases) { const r = await startCheckout(env, orderId, token, accept); assert.equal(r.status, 400, name); assert.equal(r.json.needAccept, true, name); }
    assert.equal(f.sessions.size, 0, "ingen betalsession skapad"); assert.equal(f.log.anthropic.length, 0); assert.equal(orderOf(env, orderId).accept.policy, undefined, "inget samtycke sparat av avvisade försök");
    assert.equal((await startCheckout(env, orderId, token, { ...base, email: "inte en adress" })).status, 400);
    assert.equal((await startCheckout(env, orderId, token, { ...base, email: "inte en adress" })).json.needEmail, true);
    // "betala igen" utan body kan inte ersätta ett saknat samtycke
    assert.equal((await startCheckout(env, orderId, token, null)).status, 400);
    // giltigt
    assert.equal((await startCheckout(env, orderId, token, base)).status, 200);
    const a = orderOf(env, orderId).accept;
    assert.equal(a.policy, "P"); assert.equal(a.declaration, true); assert.equal(a.derivedFrom, "declaration"); assert.equal(a.startNow, true); assert.equal(a.loseRight, true); assert.deepEqual(Object.keys(a.consents).sort(), ["declaration", "terms"], "EN deklaration + villkor via köpklick, inga tre loggade rutor"); assert.deepEqual(a.consents.declaration.covers, ["startNow", "loseRight"]); assert.equal(a.consents.terms.via, "kopknapp"); assert.equal(a.immediateDelivery, undefined);
    // Q: den gamla rutan; P-fält ensamma räcker inte
    const q = makeEnv(); const cq = await consentOf(q); const o2 = await create(q, f);
    const r = await startCheckout(q, o2.orderId, o2.token, { terms: true, declaration: true, consentHash: cq.hash, consentVersion: cq.version, email: TEST_EMAIL });
    assert.equal(r.status, 400); assert.equal(orderOf(q, o2.orderId).accept.policy, undefined);
  } finally { f.restore(); }
});

test("tamper/version: ändrad hash eller version ⇒ 409 consentChanged; hash av annan policy/fullgörandepunkt avvisas; frusen post kan inte ändras via klienten", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(PE); const c = await consentOf(env); const { orderId, token } = await create(env, f);
    const ok = { terms: true, declaration: true, consentHash: c.hash, consentVersion: c.version, email: TEST_EMAIL };
    assert.equal((await startCheckout(env, orderId, token, { ...ok, consentHash: "0".repeat(64) })).status, 409);
    assert.equal((await startCheckout(env, orderId, token, { ...ok, consentVersion: "samtycke-utkast-1" })).status, 409);
    const qh = await consentOf(makeEnv()); assert.equal((await startCheckout(env, orderId, token, { ...ok, consentHash: qh.hash, consentVersion: qh.version })).status, 409, "Q-hash godtas inte under P");
    const wh = await consentOf(makeEnv({ ...P, COMPARE_FULFILMENT_POINT: "fonster_slut" })); assert.equal((await startCheckout(env, orderId, token, { ...ok, consentHash: wh.hash })).status, 409, "annan fullgörandepunkt = annan hash");
    assert.equal(f.sessions.size, 0);
    assert.equal((await startCheckout(env, orderId, token, ok)).status, 200);
    // villkoren ändras (annan fullgörandepunkt) efter samtycke men före betalning: "betala igen" utan body kräver nytt samtycke
    env.COMPARE_FULFILMENT_POINT = "fonster_slut";
    const again = await startCheckout(env, orderId, token, null); assert.equal(again.status, 400); assert.equal(again.json.needAccept, true);
  } finally { f.restore(); }
});

test("frusna samtycken: två val med tid/text-ID/text-hash/order, avtalad prestation, bekräftelse sent FÖRE start (ordagrant i mejlet, normal köplänk), ingen start före bekräftelsen", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(PE); const mm = mailer(); mm.down = true; env.COMPARE_MAILER = mm;
    const o = await paidP(env, f, { run: false });
    const a = orderOf(env, o.orderId).accept;
    for (const k of ["declaration", "terms"]) { assert.equal(a.consents[k].value, true); assert.ok(a.consents[k].at > 0); assert.equal(a.consents[k].orderId, o.orderId); assert.equal(a.consents[k].textHash, await sha256Hex(a.snapshot.texts[k])); assert.match(a.consents[k].textId, new RegExp(`^${k}@samtycke-p-utkast-2$`)); }
    assert.deepEqual(a.agreed.report, true); assert.equal(a.agreed.sources.required, false); assert.equal(a.fulfilmentPoint, "leverans");
    await env.COMPARE_ORDERS.runAlarms(1);
    assert.equal(f.log.anthropic.length, 0, "ingen generation före bekräftelsen"); assert.equal((await view(env, o.orderId, o.token)).waiting, "avtalsbekraftelse"); assert.equal(orderOf(env, o.orderId).accept.confirmation, undefined);
    // transporten tillbaka: bekräftelsen skickas, sedan start
    mm.down = false; const s = st(env, o.orderId); for (const [k, v] of [...s]) if (k.startsWith("outbox:") && v.nextAt) s.set(k, { ...v, nextAt: 0, leaseUntil: null });
    await env.COMPARE_ORDERS.runAlarms();
    const conf = mm.sent.find((m) => m.id.startsWith("mail_avtal_"));
    for (const t of [a.snapshot.texts.declaration, a.snapshot.texts.terms, a.snapshot.texts.fulfilmentDef]) assert.ok(conf.body.includes(t), "ordagrant: " + t);
    for (const k of ["declaration", "terms"]) { assert.ok(conf.body.includes(a.consents[k].textHash)); assert.ok(conf.body.includes(new Date(a.consents[k].at).toISOString())); }
    assert.match(conf.body, /Analysen startar först när den här bekräftelsen har skickats/); assert.match(conf.body, /\/jamfor\/kop\//); assert.match(conf.body, /reklamation/i); assert.ok(!/\{\{/.test(conf.body), "inga kvarvarande platshållare");
    const o2 = orderOf(env, o.orderId); assert.ok(o2.accept.confirmation && o2.accept.confirmation.sentAt <= o2.work.deliveredAt); assert.equal(o2.status, "delivered");
    const ag = ledgerOf(env, o.orderId).agreement; assert.equal(ag.p.policy, "P"); assert.equal(ag.p.consents.declaration.textHash, a.consents.declaration.textHash);
    assert.equal(JSON.stringify(ag).includes("FIXTURE"), false);
  } finally { f.restore(); }
});

test("bekräftelsefel: misslyckad/utebliven bekräftelse ⇒ ingen start, ordern avbryts efter väntan och återbetalas; samtycket ensamt startar inget", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(PE); const mm = mailer(); mm.down = true; env.COMPARE_MAILER = mm;
    const o = await paidP(env, f, { run: false }); await env.COMPARE_ORDERS.runAlarms(1);
    assert.equal(f.log.anthropic.length, 0);
    await withClock(31 * 60_000, async () => { const s = st(env, o.orderId); for (const [k, v] of [...s]) if (k.startsWith("outbox:") && v.nextAt) s.set(k, { ...v, nextAt: 0, leaseUntil: null }); await env.COMPARE_ORDERS.runAlarms(3); });
    const v = orderOf(env, o.orderId); assert.equal(v.status, "failed"); assert.equal(v.work.error, "bekraftelse_ej_levererad"); assert.equal(f.log.anthropic.length, 0); assert.equal(f.log.refunds.length, 1);
    assert.equal(v.delivery, undefined);
  } finally { f.restore(); }
});

test("manipulerad orderpost: saknat frusen samtycke vid start ⇒ ingen generation, avbryts och återbetalas (samtycke_saknas)", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(PE); env.COMPARE_MAILER = mailer();
    const o = await paidP(env, f, { run: false });
    const s = st(env, o.orderId); const ord = s.get("order"); delete ord.accept.consents.declaration; s.set("order", ord);
    await env.COMPARE_ORDERS.runAlarms();
    const v = orderOf(env, o.orderId); assert.equal(v.status, "failed"); assert.equal(v.work.error, "samtycke_saknas"); assert.equal(f.log.anthropic.length, 0); assert.equal(f.log.refunds.length, 1);
  } finally { f.restore(); }
});

test("fullgörande (leverans): levererad rapport + giltiga samtycken + skickad bekräftelse ⇒ ångerrätten upphör; ånger sparas med mottagningsbevis, ingen ångerrefund, reklamation oförändrad; ingen nekan för att rapporten visats", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(PE); const mm = mailer(); env.COMPARE_MAILER = mm;
    const o = await paidP(env, f);
    let v = await view(env, o.orderId, o.token);
    assert.equal(v.status, "delivered"); assert.equal(v.consent.policy, "P"); assert.equal(v.rights.policy, "P"); assert.equal(v.rights.angerratt, "upphord"); assert.ok(v.rights.upphordAt > 0);
    const d = orderOf(env, o.orderId).delivery; assert.ok(d.report.at > 0); assert.match(d.report.hash, /^[0-9a-f]{64}$/);
    // att rapporten HÄMTAS/visas ändrar inget i sig: samma bedömning före och efter (bevisen är leveranshändelser, inte visning)
    const rep = await api(env, "GET", `/compare/orders/${o.orderId}/report`, { token: o.token }); assert.equal(rep.status, 200);
    assert.equal((await view(env, o.orderId, o.token)).rights.angerratt, "upphord");
    const r = await withdraw(env, o.orderId, o.token);
    assert.equal(r.status, 200); assert.equal(r.json.withdrawal.outcome, "angerratt_upphord");
    assert.equal(f.log.refunds.length, 0); assert.equal(orderOf(env, o.orderId).refund.state, "none"); assert.equal(orderOf(env, o.orderId).status, "delivered");
    const wd = ledgerOf(env, o.orderId).withdrawal; assert.equal(wd.fulfilment.state, "fullgjord"); assert.deepEqual(wd.fulfilment.missing, []);
    await env.COMPARE_ORDERS.runAlarms();
    const rc = mm.sent.find((m) => m.id.startsWith("mail_angrakvitto_")); assert.ok(rc, "mottagningsbevis skickas även när rätten upphört");
    assert.match(rc.body, /upphörde din ångerrätt/); assert.match(rc.body, /reklamera/); assert.match(rc.body, /Mottagen:/); assert.doesNotMatch(rc.body, /sett rapporten|har sett/);
    const dup = await withdraw(env, o.orderId, o.token); assert.equal(dup.json.duplicate, true); assert.equal(dup.json.withdrawal.requestId, r.json.withdrawal.requestId); assert.equal(f.log.refunds.length, 0);
  } finally { f.restore(); }
});

test("ånger före leverans (betald, bekräftelse ej skickad/pågår): stopp + full återbetalning, ingen rapport, ingen proportionell avgift", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(PE); env.COMPARE_MAILER = mailer();
    const o = await paidP(env, f, { run: false });
    const r = await withdraw(env, o.orderId, o.token); assert.equal(r.json.withdrawal.outcome, "avbrutet_fore_leverans");
    assert.equal(f.log.refunds.length, 1); assert.equal(f.log.refunds[0].amount === undefined || Number(f.log.refunds[0].amount) === 4900, true, "hela beloppet, ingen delavgift");
    await env.COMPARE_ORDERS.runAlarms(); assert.equal(f.log.anthropic.length, 0);
    assert.equal((await api(env, "GET", `/compare/orders/${o.orderId}/report`, { token: o.token })).status, 409);
    assert.equal((await view(env, o.orderId, o.token)).status, "failed");
  } finally { f.restore(); }
});

test("ånger under pågående körning: stoppas, resultat som blir klart efter ångern lämnas aldrig kvar, full återbetalning", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(PE); env.COMPARE_MAILER = mailer(); const h = defer(); f.ctl.holdModel = [h.p];
    const o = await paidP(env, f, { run: false });
    const run = env.COMPARE_ORDERS.runAlarms(); await new Promise((r) => setTimeout(r, 30));
    const r = await withdraw(env, o.orderId, o.token); assert.equal(r.json.withdrawal.outcome, "avbrutet_fore_leverans");
    h.r(); await run;
    assert.equal(f.log.refunds.length, 1); assert.equal((await api(env, "GET", `/compare/orders/${o.orderId}/report`, { token: o.token })).status, 409); assert.equal(orderOf(env, o.orderId).delivery, undefined);
  } finally { f.restore(); }
});

test("race ånger/leverans: samtidig ånger och leverans ger alltid ETT konsistent utfall (stoppad + full refund ELLER levererad + fullgjord + ingen refund), aldrig båda", async () => {
  for (let i = 0; i < 6; i++) {
    const f = installFetch();
    try {
      const env = makeEnv(PE); env.COMPARE_MAILER = mailer();
      const o = await paidP(env, f, { run: false });
      const delay = [0, 1, 3, 8, 15, 30][i];
      const run = env.COMPARE_ORDERS.runAlarms();
      const w = (async () => { await new Promise((r) => setTimeout(r, delay)); return withdraw(env, o.orderId, o.token); })();
      const [, wr] = await Promise.all([run, w]); await env.COMPARE_ORDERS.runAlarms();
      const out = wr.json.withdrawal.outcome, ord = orderOf(env, o.orderId), rep = (await api(env, "GET", `/compare/orders/${o.orderId}/report`, { token: o.token })).status;
      if (out === "angerratt_upphord") { assert.equal(ord.status, "delivered"); assert.equal(f.log.refunds.length, 0); assert.equal(rep, 200); }
      else { assert.ok(["avbrutet_fore_leverans", "angrat_fore_fullgoring"].includes(out), out); assert.equal(f.log.refunds.length, 1, "full refund"); assert.equal(rep, 409, "ingen rapport kvar efter ångrad order"); assert.equal(ord.status, "failed"); }
      assert.ok(!(f.log.refunds.length > 0 && out === "angerratt_upphord"));
    } finally { f.restore(); }
  }
});

test("fonster_slut: levererad men fönstret ej slut ⇒ ångerrätt kvar (stopp + full refund, rapporten raderas); efter fönstret ⇒ upphör", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({ ...PE, COMPARE_FULFILMENT_POINT: "fonster_slut" }); env.COMPARE_MAILER = mailer();
    const a = await paidP(env, f); const va = await view(env, a.orderId, a.token);
    assert.equal(va.status, "delivered"); assert.equal(va.rights.angerratt, "kvar"); assert.equal(va.rights.state, "vantar_fonster"); assert.equal(va.rights.point, "fonster_slut");
    const r = await withdraw(env, a.orderId, a.token); assert.equal(r.json.withdrawal.outcome, "angrat_fore_fullgoring");
    assert.equal(f.log.refunds.length, 1); assert.equal(orderOf(env, a.orderId).status, "failed"); assert.equal((await api(env, "GET", `/compare/orders/${a.orderId}/report`, { token: a.token })).status, 409);
    assert.equal(ledgerOf(env, a.orderId).withdrawal.fulfilment.state, "vantar_fonster");
    // ny order, ånger efter fönstret
    const b = await paidP(env, f); const dAt = orderOf(env, b.orderId).delivery.report.at;
    const rb = await withClock(25 * 3600_000, async () => withdraw(env, b.orderId, b.token));
    assert.equal(rb.json.withdrawal.outcome, "angerratt_upphord"); assert.ok(ledgerOf(env, b.orderId).withdrawal.fulfilment.fulfilledAt >= dAt + 24 * 3600_000); assert.equal(f.log.refunds.length, 1, "ingen ny refund");
  } finally { f.restore(); }
});

test("källkvittens utan täckning/före leverans avvisas; den verkliga täckningskedjan (frusna källor, serververifierad visning, partiellt/källfel) testas i compare_policy_p_evidence.test.mjs", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(PE); env.COMPARE_MAILER = mailer();
    const send = (o, body, token) => api(env, "POST", `/compare/orders/${o.orderId}/source-delivered`, { token: token ?? o.token, body });
    const a = await paidP(env, f); let v = await view(env, a.orderId, a.token);
    assert.equal(v.rights.angerratt, "upphord", "ingen avtalad källtäckning ⇒ rapporten är hela prestationen");
    assert.equal((await send(a, { firmId: "f_aaa", state: "visad" })).status, 409, "firma utanför täckningen");
    assert.equal((await send(a, { firmId: "f_aaa", state: "ingen_kalla" })).status, 409);
    assert.equal((await send(a, { firmId: "f_aaa", state: "kallfel" })).status, 400, "kallfel är ingen leverans");
    assert.equal((await send(a, { firmId: "f_aaa", state: "visad" }, "fel-token")).status, 404);
    const c = await paidP(env, f, { run: false }); assert.equal((await send(c, { firmId: "f_aaa", state: "visad" })).status, 409, "före levererad rapport");
  } finally { f.restore(); }
});

test("bevis saknas/motstridigt ⇒ fail closed: ångerrätt kvar (ingen automatisk nekan), full refund vid ånger", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(PE); env.COMPARE_MAILER = mailer();
    for (const [name, tamper, miss] of [
      ["rapportens hash saknas", (o) => { o.delivery.report.hash = null; }, "rapport"],
      ["leveranshändelse saknas", (o) => { delete o.delivery; }, "rapport"],
      ["bekräftelse ej registrerad", (o) => { delete o.accept.confirmation; }, "bekraftelse"],
      ["samtycke ofullständigt", (o) => { o.accept.consents.declaration.textHash = null; }, "samtycke"],
      ["fullgörandepunkt saknas", (o) => { o.accept.fulfilmentPoint = "okand"; }, "fullgorandepunkt"],
    ]) {
      const o = await paidP(env, f); const s = st(env, o.orderId); const ord = s.get("order"); tamper(ord); s.set("order", ord);
      const v = await view(env, o.orderId, o.token); assert.equal(v.rights.angerratt, "kvar", name);
      const n = f.log.refunds.length; const r = await withdraw(env, o.orderId, o.token);
      assert.equal(r.json.withdrawal.outcome, "angrat_fore_fullgoring", name); assert.ok(ledgerOf(env, o.orderId).withdrawal.fulfilment.missing.includes(miss), name); assert.equal(f.log.refunds.length, n + 1, name);
    }
  } finally { f.restore(); }
});

test("Q-order oförändrad: order som accepterats under Q behåller Q (manuell prövning efter leverans, inga P-fält) även om policyn senare slås på; ingen retroaktiv Q→P", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(); env.COMPARE_MAILER = mailer();
    const o = await create(env, f); await pay(env, f, o); env.COMPARE_CONSENT_POLICY = "P"; // flagga slås på EFTER samtycket
    await env.COMPARE_ORDERS.runAlarms();
    const ord = orderOf(env, o.orderId); assert.equal(ord.accept.policy, undefined); assert.equal(ord.accept.immediateDelivery, true); assert.equal(ord.delivery, undefined); assert.equal(ledgerOf(env, o.orderId).agreement.p, undefined);
    const v = await view(env, o.orderId, o.token); assert.equal(v.status, "delivered"); assert.equal(v.consent.policy, "Q"); assert.equal(v.rights, null);
    const r = await withdraw(env, o.orderId, o.token); assert.equal(r.json.withdrawal.outcome, "manuell_provning"); assert.equal(f.log.refunds.length, 0);
    // och omvänt: P-order påverkas inte av att flaggan slås av
    const env2 = makeEnv(PE); env2.COMPARE_MAILER = mailer(); const p = await paidP(env2, f); delete env2.COMPARE_CONSENT_POLICY;
    assert.equal((await view(env2, p.orderId, p.token)).rights.angerratt, "upphord"); assert.equal((await withdraw(env2, p.orderId, p.token)).json.withdrawal.outcome, "angerratt_upphord");
  } finally { f.restore(); }
});
