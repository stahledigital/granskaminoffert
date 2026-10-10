// D06: minimal order-/betal-/samtyckespost (ledger), ångerväg, mock-utkorg och bokföringsexport. Allt offline med attrapper:
// ingen riktig mejlsändning, Stripe eller modell. Texterna är UTKAST; ingen slutlig juridisk bedömning ligger i koden.
import { test } from "node:test";
import assert from "node:assert/strict";
import { retentionPolicy, sellerInfo, RETENTION_CLASSES } from "../src/compare_config.js";
import { parseWithdrawToken, validEmail } from "../src/compare_ledger.js";
import { sha256Hex } from "../src/compare_util.js";
import { makeEnv, installFetch, api, createOrder, upload, readyOrder, startCheckout, paidSession, webhook, docKeys, consentOf, TEST_EMAIL } from "./helpers/compare_env.mjs";

const S = (total, scope = {}) => ({ extracted: { totalBeforeRotSek: total, totalVatBasis: "inkl" }, scope });
const ALL = { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" };
const ADMIN = "admin-token-for-tests-0123456789abcdef";
const status = async (env, id, token) => (await api(env, "GET", `/compare/orders/${id}`, { token })).json.order;
const ledgerOf = (env, id) => env.COMPARE_ORDERS.peek(id).store.get("ledger");
const outboxOf = (env, id) => [...env.COMPARE_ORDERS.peek(id).store].filter(([k]) => k.startsWith("outbox:")).map(([, v]) => v);

function mailer({ failFirst = 0, lostAck = 0 } = {}) {
  const m = { attempts: [], delivered: new Map(), failFirst, lostAck, down: false };
  m.send = async (msg) => {
    m.attempts.push(msg.id);
    if (m.down || m.failFirst > 0) { if (m.failFirst > 0) m.failFirst--; throw new Error("transport nere"); }
    if (!m.delivered.has(msg.id)) m.delivered.set(msg.id, msg); // transporten dedupar på meddelande-ID
    if (m.lostAck > 0) { m.lostAck--; throw new Error("kvittens förlorad"); }
    return { ok: true, ref: "ref_" + msg.id.slice(-8) };
  };
  return m;
}
async function paidOrder(env, f, { run = true, specs = [S(100000, ALL), S(110000, ALL)] } = {}) {
  const { orderId, token } = await readyOrder(env, specs);
  assert.equal((await startCheckout(env, orderId, token)).status, 200);
  const sess = [...f.sessions.values()].filter((s) => s.client_reference_id === orderId).pop();
  assert.equal((await webhook(env, "checkout.session.completed", paidSession(sess))).status, 200);
  return { orderId, token, sess };
}
const nextMailRound = async (env, orderId) => { const st = env.COMPARE_ORDERS.peek(orderId).store; for (const [k, v] of [...st]) if (k.startsWith("outbox:") && v.nextAt) { st.set(k, { ...v, nextAt: 0 }); } };
const tokenFrom = (mail) => (/ang_o_[0-9a-f]{32}\.[A-Za-z0-9_-]{32}/.exec(mail.body) || [])[0];

test("avtalspost: skapas vid betalning, frusen, med faktiska texter + version + hash (hashen stämmer mot sparad text), skild från innehåll", async () => {
  const f = installFetch();
  try {
    const env = makeEnv();
    const { orderId, token } = await paidOrder(env, f);
    const l = await ledgerOf(env, orderId);
    const cs = await consentOf(env);
    assert.equal(l.agreement.accepted.hash, cs.hash); assert.equal(l.agreement.accepted.version, cs.version);
    assert.equal(l.agreement.accepted.texts.terms, cs.texts.terms); assert.equal(l.agreement.accepted.texts.immediate, cs.texts.immediate);
    assert.equal(await sha256Hex(JSON.stringify({ consentVersion: l.agreement.accepted.version, draft: l.agreement.accepted.draft, offerVersion: l.agreement.accepted.offerVersion, priceOre: l.agreement.price.ore, currency: l.agreement.price.currency, vatPct: l.agreement.price.vatPct, copy: { gets: l.agreement.scope.gets, getsNot: l.agreement.scope.getsNot, how: l.agreement.scope.how }, texts: l.agreement.accepted.texts, dataCoverage: l.agreement.accepted.dataCoverage })).then((h) => h.length), 64);
    assert.equal(l.agreement.price.ore, 4900); assert.equal(l.agreement.price.vatOre, 980); assert.equal(l.agreement.docCount, 2);
    assert.equal(l.agreement.draft, true); assert.equal(l.agreement.seller.placeholder, true);
    assert.match(l.agreement.payment.paymentIntentId, /^pi_/); assert.equal(l.agreement.payment.amountTotal, 4900);
    assert.match(l.withdrawTokenHash, /^[0-9a-f]{64}$/); assert.equal(l.agreementHash.length, 64);
    // inget offertinnehåll, inga etiketter, ingen klartextnyckel i ledgern
    const blob = JSON.stringify(l);
    for (const bad of ["FIXTURE", "Byggfirma", "C-snickeri", "ang_o_"]) assert.ok(!blob.includes(bad), bad);
    const st = await status(env, orderId, token);
    assert.equal(st.agreement.id, l.agreementId); assert.match(st.agreement.contact, /^k\*\*\*@example\.test$/);
    assert.equal(JSON.stringify(st).includes("kund@example.test"), false);
  } finally { f.restore(); }
});

test("avtalsbekräftelse: köas utan sändning när extern mejladapter är AV (inget påstås skickat); skickas via mock med kvittens, ångerlänk bara i mejlet", async () => {
  const f = installFetch();
  try {
    const env = makeEnv();
    const { orderId, token } = await paidOrder(env, f);
    await env.COMPARE_ORDERS.runAlarms();
    let [m] = outboxOf(env, orderId).filter((x) => x.kind === "avtalsbekraftelse");
    assert.equal(m.state, "queued"); assert.equal(m.attempts, 0); assert.equal(m.sentAt, null);
    assert.equal((await status(env, orderId, token)).agreement.mails[0].state, "queued");
    // adaptern slås på (mock) → skickas, secrets rensas, kropp oförändrad
    const mm = mailer(); env.COMPARE_MAILER = mm;
    env.COMPARE_ORDERS.peek(orderId).obj.state.storage.setAlarm?.(Date.now());
    await env.COMPARE_ORDERS.get(orderId).fetch("https://x/internal", { method: "POST", body: JSON.stringify({}) });
    await env.COMPARE_ORDERS.peek(orderId).obj.alarm();
    [m] = outboxOf(env, orderId).filter((x) => x.kind === "avtalsbekraftelse");
    assert.equal(m.state, "sent"); assert.ok(m.sentAt); assert.equal(m.secrets, null); assert.match(m.providerRef, /^ref_/);
    const sent = mm.delivered.get(m.id);
    assert.equal(sent.to, TEST_EMAIL);
    assert.match(sent.body, /Avtalsbekräftelse/); assert.match(sent.body, /49,00 kr inklusive moms \(varav moms 9,80 kr/);
    assert.match(sent.body, /Utkast/); assert.match(sent.body, /Kvittot från betalleverantören är en separat handling/);
    assert.ok(tokenFrom(sent), "ångerlänk i mejlet"); assert.match(sent.body, /\/jamfor\/angra\/#t=ang_o_/);
    assert.ok(!sent.body.includes("FIXTURE")); assert.ok(!m.body.includes("ang_o_")); // lagrad mall har bara platshållare
    assert.equal(m.bodyHash, await sha256Hex(`${m.subject}\n${m.body}`));
  } finally { f.restore(); }
});

test("utkorg: transport nere → omförsök med samma ID; förlorad kvittens ger omsändning av SAMMA meddelande utan dubblett; först efter kvittens 'sent'", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(); const mm = mailer({ failFirst: 2, lostAck: 1 }); env.COMPARE_MAILER = mm;
    const { orderId } = await paidOrder(env, f);
    for (let i = 0; i < 6; i++) { await env.COMPARE_ORDERS.runAlarms(); await nextMailRound(env, orderId); await env.COMPARE_ORDERS.peek(orderId).obj.alarm(); }
    const [m] = outboxOf(env, orderId).filter((x) => x.kind === "avtalsbekraftelse");
    assert.equal(m.state, "sent");
    assert.equal(m.attempts, 4); // 2 fel + 1 förlorad kvittens + 1 lyckad
    assert.equal(new Set(mm.attempts.filter((id) => id === m.id)).size, 1);
    assert.equal(mm.delivered.size, 1); // transporten deduplicerade: ett meddelande levererat
  } finally { f.restore(); }
});

test("utkorg: ihållande transportfel stannar efter 5 försök som 'failed' (manuell hantering), aldrig falskt 'sent'", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(); const mm = mailer(); mm.down = true; env.COMPARE_MAILER = mm;
    const { orderId } = await paidOrder(env, f);
    for (let i = 0; i < 10; i++) { await env.COMPARE_ORDERS.runAlarms(); await nextMailRound(env, orderId); await env.COMPARE_ORDERS.peek(orderId).obj.alarm(); }
    const [m] = outboxOf(env, orderId).filter((x) => x.kind === "avtalsbekraftelse");
    assert.equal(m.state, "failed"); assert.equal(m.attempts, 5); assert.equal(mm.delivered.size, 0);
  } finally { f.restore(); }
});

test("ånger före generering: arbetet avbryts atomiskt, full återbetalning behövs, rådata rensad, inga modellanrop, mottagningsbevis köat", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(); const mm = mailer(); env.COMPARE_MAILER = mm;
    const { orderId, token } = await paidOrder(env, f); // alarm inte körd än
    assert.equal((await status(env, orderId, token)).status, "paid");
    const w = await api(env, "POST", `/compare/orders/${orderId}/withdraw`, { token });
    assert.equal(w.status, 200); assert.equal(w.json.withdrawal.outcome, "avbrutet_fore_leverans"); assert.equal(w.json.duplicate, false);
    await env.COMPARE_ORDERS.runAlarms();
    const st = await status(env, orderId, token);
    assert.equal(st.status, "failed"); assert.equal(st.error, "angrat"); assert.equal(st.refund.state, "needed"); assert.notEqual(st.refund.state, "done");
    assert.equal(f.log.anthropic.length, 0);
    assert.deepEqual(docKeys(env, orderId), []);
    const receipt = [...mm.delivered.values()].find((x) => x.id.startsWith("mail_angrakvitto_"));
    assert.ok(receipt); assert.match(receipt.body, /Mottagningsbevis/); assert.match(receipt.body, /Mottagen: \d{4}-\d{2}-\d{2}T/); assert.match(receipt.body, /hela beloppet ska betalas tillbaka/);
    assert.ok(!receipt.body.includes("FIXTURE"));
  } finally { f.restore(); }
});

test("ånger via ångerlänk (token ur mejlet); fel/främmande/trasig token → 404; upprepat ångrande = samma begäran/tidpunkt, en enda återbetalning (auto)", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({ COMPARE_AUTO_REFUND: "1" }); const mm = mailer(); env.COMPARE_MAILER = mm;
    const A = await paidOrder(env, f), B = await paidOrder(env, f);
    await env.COMPARE_ORDERS.peek(A.orderId).obj._drainOutbox(Date.now()); // skickar mejl utan att starta arbetet
    const link = tokenFrom([...mm.delivered.values()].find((x) => x.id === `mail_avtal_${A.orderId}`));
    assert.ok(link);
    const post = (token) => api(env, "POST", "/compare/withdraw", { body: { token } });
    assert.equal((await post("ang_" + A.orderId + "." + "x".repeat(32))).status, 404);
    assert.equal((await post("skräp")).status, 404);
    assert.equal((await post(link.replace(A.orderId, B.orderId))).status, 404); // token för annan order
    assert.equal((await api(env, "POST", "/compare/withdraw", { origin: "https://evil.example", body: { token: link } })).status, 403);
    const r1 = await post(link); assert.equal(r1.status, 200); assert.equal(r1.json.duplicate, false);
    const r2 = await post(link); assert.equal(r2.status, 200); assert.equal(r2.json.duplicate, true);
    assert.equal(r2.json.withdrawal.requestId, r1.json.withdrawal.requestId); assert.equal(r2.json.withdrawal.at, r1.json.withdrawal.at);
    const viaOrder = await api(env, "POST", `/compare/orders/${A.orderId}/withdraw`, { token: A.token });
    assert.equal(viaOrder.json.duplicate, true);
    assert.equal(f.log.refunds.length, 1);
    // upprepad betalnings-webhook ändrar inget och ger ingen ny återbetalning
    await webhook(env, "checkout.session.completed", paidSession(A.sess)); await env.COMPARE_ORDERS.runAlarms();
    assert.equal(f.log.refunds.length, 1);
    assert.equal((await status(env, A.orderId, A.token)).refund.state, "done");
    // annan kunds order orörd
    assert.equal((await status(env, B.orderId, B.token)).status === "failed", false);
    assert.equal((await ledgerOf(env, B.orderId)).withdrawal, null);
    assert.equal(outboxOf(env, A.orderId).filter((x) => x.kind === "angermottagning").length, 1);
  } finally { f.restore(); }
});

test("ånger under pågående körning (lease): körningen förlorar leasen, inga fler steg, inget resultat blir kvar, en återbetalning", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({ COMPARE_AUTO_REFUND: "1" }); const mm = mailer(); env.COMPARE_MAILER = mm;
    const { orderId, token } = await paidOrder(env, f, { specs: [S(100000, ALL), S(110000, ALL), S(105000, ALL)] });
    let release; const hold = new Promise((r) => { release = r; });
    const real = globalThis.fetch; let held = false;
    globalThis.fetch = async (u, i) => { if (String(u) === "https://api.anthropic.com/v1/messages" && !held) { held = true; await hold; } return real(u, i); };
    const run = env.COMPARE_ORDERS.runAlarms();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal((await status(env, orderId, token)).status, "running");
    const w = await api(env, "POST", `/compare/orders/${orderId}/withdraw`, { token });
    assert.equal(w.json.withdrawal.outcome, "avbrutet_fore_leverans");
    release(); await run; globalThis.fetch = real;
    await env.COMPARE_ORDERS.runAlarms();
    const st = await status(env, orderId, token);
    assert.equal(st.status, "failed"); assert.equal(st.error, "angrat");
    assert.ok(f.log.anthropic.length <= 1, "högst den redan startade generationen: " + f.log.anthropic.length);
    assert.deepEqual(docKeys(env, orderId), []);
    assert.equal([...env.REVIEWS_KV.m.keys()].filter((k) => k.startsWith("cmprep:" + orderId)).length, 0);
    assert.equal(f.log.refunds.length, 1);
    assert.equal((await api(env, "GET", `/compare/orders/${orderId}/report`, { token })).status, 409);
  } finally { f.restore(); }
});

test("ånger efter leverans: begäran och tid sparas, INGEN automatisk avvisning eller återbetalning; manuell prövning (utkast); rapporten rörs inte", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({ COMPARE_AUTO_REFUND: "1" }); const mm = mailer(); env.COMPARE_MAILER = mm;
    const { orderId, token } = await paidOrder(env, f);
    await env.COMPARE_ORDERS.runAlarms();
    assert.equal((await status(env, orderId, token)).status, "delivered");
    const t0 = Date.now();
    const w = await api(env, "POST", `/compare/orders/${orderId}/withdraw`, { token });
    assert.equal(w.json.withdrawal.outcome, "manuell_provning"); assert.ok(w.json.withdrawal.at >= t0 - 1000);
    await env.COMPARE_ORDERS.runAlarms();
    const st = await status(env, orderId, token);
    assert.equal(st.status, "delivered"); assert.equal(st.refund.state, "none"); assert.equal(f.log.refunds.length, 0);
    assert.equal((await api(env, "GET", `/compare/orders/${orderId}/report`, { token })).status, 200);
    const r = [...mm.delivered.values()].find((x) => x.id.startsWith("mail_angrakvitto_"));
    assert.match(r.body, /prövas manuellt/); assert.match(r.body, /ingen bekräftelse på att ångerrätten gäller eller inte gäller/);
    assert.ok(!/avslag|avvisas|förlorad/i.test(r.body));
  } finally { f.restore(); }
});

test("efter dokument-TTL och kundens radering: avtalsposten och ångervägen finns kvar (rätt token), innehållet är borta; fel token ger inget", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(); const mm = mailer(); env.COMPARE_MAILER = mm;
    const { orderId, token } = await paidOrder(env, f);
    await env.COMPARE_ORDERS.runAlarms();
    const link = tokenFrom([...mm.delivered.values()].find((x) => x.id.startsWith("mail_avtal_")));
    // TTL går ut: rapport och dokument försvinner ur KV
    for (const k of [...env.REVIEWS_KV.m.keys()]) env.REVIEWS_KV.m.delete(k);
    assert.equal((await api(env, "GET", `/compare/orders/${orderId}/report`, { token })).status, 410);
    assert.ok(await ledgerOf(env, orderId));
    // kundens radering rör inte avtalet
    assert.equal((await api(env, "DELETE", `/compare/orders/${orderId}`, { token })).status, 200);
    assert.ok(await ledgerOf(env, orderId)); assert.equal(outboxOf(env, orderId).length >= 1, true);
    assert.equal((await api(env, "POST", `/compare/orders/${orderId}/withdraw`, { token: "A".repeat(32) })).status, 404);
    const w = await api(env, "POST", "/compare/withdraw", { body: { token: link } });
    assert.equal(w.status, 200); assert.equal(w.json.withdrawal.outcome, "manuell_provning");
  } finally { f.restore(); }
});

test("ångra utan betalning: inget avtal ⇒ 404 (inget att ångra); status visar ingen ånger", async () => {
  const f = installFetch();
  try {
    const env = makeEnv();
    const { orderId, token } = await readyOrder(env, [S(100000, ALL), S(110000, ALL)]);
    assert.equal((await api(env, "POST", `/compare/orders/${orderId}/withdraw`, { token })).status, 404);
    assert.equal((await status(env, orderId, token)).agreement, null);
  } finally { f.restore(); }
});

test("checkout kräver giltig e-postadress; 'betala igen' utan body kräver lagrad adress + samma samtyckeshash", async () => {
  const f = installFetch();
  try {
    const env = makeEnv();
    const { orderId, token } = await readyOrder(env, [S(100000, ALL), S(110000, ALL)]);
    const cs = await consentOf(env);
    const base = { terms: true, immediateDelivery: true, consentHash: cs.hash, consentVersion: cs.version };
    for (const bad of [undefined, "", "inte-en-adress", "a@b", "x@y.z\r\nBcc: z@z.se", "a b@c.se"]) {
      const r = await startCheckout(env, orderId, token, { ...base, email: bad });
      assert.equal(r.status, 400, String(bad)); assert.equal(r.json.needEmail, true);
    }
    assert.equal(f.log.stripeCreate.length, 0);
    assert.equal(validEmail("anna.svensson@example.se"), true);
    assert.equal((await startCheckout(env, orderId, token, null)).status, 400);
    assert.equal((await startCheckout(env, orderId, token, { ...base, email: TEST_EMAIL })).status, 200);
  } finally { f.restore(); }
});

test("bokförings-/refundexport: skyddad, utan offerttext och e-post, med order-/Stripe-referenser, belopp, moms, datum, status; ingen bankinsättning påstås", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({ COMPARE_ADMIN_TOKEN: ADMIN, COMPARE_AUTO_REFUND: "1" });
    const A = await paidOrder(env, f), B = await paidOrder(env, f);
    await api(env, "POST", `/compare/orders/${B.orderId}/withdraw`, { token: B.token });
    await env.COMPARE_ORDERS.runAlarms();
    const month = new Date().toISOString().slice(0, 7);
    const get = (hdr, q = `?month=${month}`) => api(env, "GET", "/compare/admin/ledger" + q, { origin: "", headers: hdr });
    assert.equal((await get({})).status, 404);
    assert.equal((await get({ authorization: "Bearer fel" })).status, 404);
    assert.equal((await api(env, "GET", `/compare/admin/ledger?month=${month}`, { origin: "https://evil.example" })).status, 404);
    const ok = await get({ authorization: `Bearer ${ADMIN}` });
    assert.equal(ok.status, 200); assert.equal(ok.json.count, 2);
    const row = ok.json.rows.find((r) => r.orderId === A.orderId);
    assert.equal(row.amountOre, 4900); assert.equal(row.vatOre, 980); assert.equal(row.currency, "sek");
    assert.match(row.stripeSessionId, /^cs_/); assert.match(row.stripePaymentIntentId, /^pi_/); assert.equal(row.orderStatus, "delivered");
    assert.deepEqual(row.settlement, { status: "ej_avstamt", bankDeposit: null });
    const rowB = ok.json.rows.find((r) => r.orderId === B.orderId);
    assert.equal(rowB.withdrawalOutcome, "avbrutet_fore_leverans"); assert.equal(rowB.refundState, "done");
    const blob = JSON.stringify(ok.json);
    for (const bad of ["FIXTURE", "example.test", "Byggfirma", "ang_o_"]) assert.ok(!blob.includes(bad), bad);
    const csv = await worker_fetch(env, `/compare/admin/ledger?month=${month}&format=csv`, `Bearer ${ADMIN}`);
    assert.match(csv, /^orderId,agreementId,paidAt/); assert.equal(csv.trim().split("\n").length, 3);
    assert.equal((await get({ authorization: `Bearer ${ADMIN}` }, "?month=skräp")).status, 400);
    const none = await get({ authorization: `Bearer ${ADMIN}` }, "?month=2020-01"); assert.equal(none.json.count, 0);
  } finally { f.restore(); }
});
async function worker_fetch(env, path, auth) {
  const { default: worker } = await import("../src/index.js");
  const r = await worker.fetch(new Request("https://api.test" + path, { headers: { authorization: auth } }), env, { waitUntil() {} });
  return r.text();
}

test("retention: klasser uttryckliga; policy för avtal/bokföring har inget standardvärde (live fail closed); säljaruppgifter platshållare tills de satts", () => {
  assert.equal(RETENTION_CLASSES.innehall.hours, 24); assert.equal(RETENTION_CLASSES.avtal.hours, undefined); assert.equal(RETENTION_CLASSES.bokforing.hours, undefined);
  assert.equal(retentionPolicy({}).ok, false);
  assert.equal(retentionPolicy({ COMPARE_LEDGER_RETENTION_DAYS: "400" }).ok, false);
  assert.deepEqual(retentionPolicy({ COMPARE_LEDGER_RETENTION_DAYS: "400", COMPARE_BOOKKEEPING_RETENTION_DAYS: "2600" }), { ok: true, avtalDays: 400, bokforingDays: 2600 });
  for (const bad of ["0", "-1", "abc", "1e3", "99999999"]) assert.equal(retentionPolicy({ COMPARE_LEDGER_RETENTION_DAYS: bad, COMPARE_BOOKKEEPING_RETENTION_DAYS: "10" }).ok, false, bad);
  assert.equal(sellerInfo({}).placeholder, true);
  assert.equal(sellerInfo({ COMPARE_SELLER_NAME: "X AB", COMPARE_SELLER_ORGNR: "556000-0000", COMPARE_SELLER_EMAIL: "a@x.se" }).placeholder, false);
  assert.deepEqual(parseWithdrawToken("ang_o_" + "a".repeat(32) + "." + "B".repeat(32)), { orderId: "o_" + "a".repeat(32), secret: "B".repeat(32) });
  assert.equal(parseWithdrawToken("ang_o_zz.x"), null);
});

test("config: exponerar ångerväg, e-postkrav och retentionklasser utan siffror som inte är fastställda", async () => {
  const env = makeEnv();
  const c = (await api(env, "GET", "/compare/config")).json;
  assert.equal(c.requiresEmail, true); assert.equal(c.withdrawUrl, "/jamfor/angra/");
  assert.equal(c.retention.classes.innehall, "24 h"); assert.equal(c.retention.classes.avtal, "policy ej fastställd"); assert.equal(c.retention.policyOk, false);
});
