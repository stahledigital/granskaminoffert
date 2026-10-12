// D17-R2: (1) momsbasen rad vs summa, aldrig kategoriskt 6000/50 % vid blandad/okänd bas; (2) fk_tid frågar vid saknad start ELLER slut; (3) förkontrollens avtal/PDF utan omdömesvisningar,
// villkorshashen oförändrad; (4) bilagenamn Forkontroll-; (5) recheck på SAMMA betalda TEST-checkorder (admin + full nyckel, singleflight, idempotent, begränsad, inga nya ordrar/sessioner).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeOffer } from "../src/compare_extract.js";
import { buildCheckReport } from "../src/compare_check.js";
import { OFFER, CHECK_TERMS_TEXT_SHA256 } from "../src/compare_config.js";
import { reportReadyMail, REPORT_PDF_PREFIX, CHECK_PDF_PREFIX, pLines } from "../src/compare_ledger.js";
import { agreementBlocks } from "../src/compare_docs.js";
import { signForTest } from "../src/compare_stripe.js";
import { TEST_CHAIN_TO } from "../src/compare_config.js";
import { makeEnv, installFetch, api, upload, paidSession, flushMailEvents, MAIL_WH_SECRET, offerText } from "./helpers/compare_env.mjs";

const mkOffer = (vat, tvb, extra = {}) => sanitizeOffer({ extracted: { jobType: "malning", areaM2: 30, priceType: "ungefarligt", vatMode: vat, laborSumSek: 20000, materialSumSek: 4000, totalSumSek: null, totalBeforeRotSek: 29000, totalVatBasis: tvb, rotAmountSek: 10000, trades: [], hourlyRateSek: null, hours: null, travelSumSek: null, ...extra }, scope: [], facts: [], readability: { level: "bra" } });
const rep = (offer) => buildCheckReport({ order: { id: "o_" + "a".repeat(32) }, offer, label: "Din offert", now: Date.UTC(2026, 9, 12) });
const txt = (R) => JSON.stringify(R.findings.map((f) => f.text));

test("moms: arbete/material exkl + summa inkl ⇒ ROT 30 % = 7 500 och summa 30 000 (aldrig 6 000)", () => {
  const t = txt(rep(mkOffer("exkl", "inkl")));
  assert.match(t, /7 500|7 500/); assert.doesNotMatch(t, /6 000|6 000/); assert.match(t, /30 000|30 000/);
});
test("moms: blandad/okänd bas ⇒ ALDRIG kategorisk 6 000/50 %; båda tolkningarna anges", () => {
  for (const v of ["blandat", "ej_angivet"]) {
    const R = rep(mkOffer(v, "inkl")); const t = txt(R);
    assert.match(t, /7 500|7 500/, v); assert.match(t, /om beloppet är inklusive moms|offerten anger inte/i, v);
    assert.doesNotMatch(t, /50 ?%/, v + ": ingen kategorisk 50 %-rättelse");
  }
});
test("moms: genuint inkl-rader + inkl-summa ⇒ 6 000 är den enda tolkningen när 50 % uttryckligen angetts", () => {
  const t = txt(rep(mkOffer("inkl", "inkl", { rotRatePct: 50 })));
  assert.match(t, /6 000|6 000/);
});

test("fk_tid: start känd/slut okänt ⇒ frågar; slut känt/start okänt ⇒ frågar; båda kända ⇒ ingen fråga; ingen fråga ersätter inte datum", () => {
  const sc = (ids) => ids.map((id) => ({ id, status: "ingar", page: 1, ref: "rad " + id }));
  const R = (ids) => rep(sanitizeOffer({ extracted: mkOffer("exkl", "inkl").extracted, scope: sc(ids), facts: [], readability: { level: "bra" } }));
  const tid = (r) => r.findings.find((f) => f.id === "fk_tid");
  const a = tid(R(["startdatum"])); assert.ok(a && a.status === "fraga" && /Start framgår men inte planerat slut/.test(a.text), "start känd, slut okänt");
  const b = tid(R(["tidplan"])); assert.ok(b && b.status === "fraga" && /inte startdatum/.test(b.text), "slut känt, start okänt");
  assert.equal(tid(R(["startdatum", "tidplan"])), undefined, "båda kända ⇒ ingen fråga");
  const c = tid(R([])); assert.ok(c && /Varken startdatum eller tidplan/.test(c.text), "inget känt");
});

test("avtalets fullgörandepunkt: förkontroll nämner inga omdömesvisningar; jämförelse oförändrad", () => {
  const mkAg = (product) => ({ product, docCount: 1, seller: { email: "k@example.test" }, accepted: { texts: { declaration: "D", fulfilmentDef: "F", terms: "T", startNow: "a", loseRight: "b" } }, p: { fulfilmentPoint: "leverans", consents: { declaration: { at: 0, textId: "x", textHash: "h" }, terms: { at: 0, textId: "x", textHash: "h" } }, agreed: {} } });
  const chk = pLines(mkAg("Förkontroll av min offert")).join("\n"); assert.match(chk, /Inga omdömesvisningar ingår i förkontrollen/); assert.doesNotMatch(chk, /ingående omdömesvisningar/); assert.doesNotMatch(chk, /jämförelserapport/); assert.match(chk, /Förkontrollen startar/);
  const cmp = pLines(mkAg(OFFER.product)).join("\n"); assert.match(cmp, /ingående omdömesvisningar/); assert.match(cmp, /Analysen startar/);
});

test("villkorshashen för förkontrollens tjänsttext är oförändrad", () => { assert.equal(CHECK_TERMS_TEXT_SHA256, "f64282b0a0b4919b1401e895f0e96b775a2e06ee26f20d932efb5ac249529d50"); });

test("bilagenamn: förkontroll = Forkontroll-<nr>.pdf, jämförelse oförändrat Jamforelse-", () => {
  const id = "o_" + "0123456789abcdef".repeat(2);
  const ck = reportReadyMail(id, "x@example.test", "check"), cm = reportReadyMail(id, "x@example.test", "compare");
  assert.deepEqual(ck.attachments.map((x) => x.filename), ["Forkontroll-01234567.pdf", "Avtal-och-villkor.pdf"]);
  assert.deepEqual(cm.attachments.map((x) => x.filename), ["Jamforelse-01234567.pdf", "Avtal-och-villkor.pdf"]);
});

// ---------- recheck på samma betalda TEST-order ----------
const ADMIN = "a".repeat(32), TSK = "sk_test_TESTCHAINabcdefgh", TWH = "whsec_TESTCHAINsecret12345678";
const ON = { COMPARE_MAILER_MODE: undefined, COMPARE_MAIL_HTTP: "1", COMPARE_MAIL_HTTP_VERIFIED: "1", COMPARE_MAIL_FROM: "Jämför <jamfor@example.test>", COMPARE_MAIL_DAY_CAP: "20", COMPARE_MAIL_API_KEY: "re_TESTONLY_syntheticKey0123456789", COMPARE_MAIL_WEBHOOK_SECRET: MAIL_WH_SECRET };
const SELLER = { COMPARE_SELLER_FORM: "AB", COMPARE_SELLER_NAME: "Syntetisk Säljare AB", COMPARE_SELLER_ORGNR: "556000-0001", COMPARE_SELLER_EMAIL: "kontakt@example.test", COMPARE_SELLER_ADDRESS: "Exempelgatan 1, 111 11 Teststad", COMPARE_SELLER_PHONE: "+46 8 000 00 00", COMPARE_COMPANY_INFO_URL: "https://example.test/foretagsuppgifter" };
const TC = { COMPARE_TEST_CHAIN: "1", COMPARE_TEST_CHAIN_UNTIL: new Date(Date.now() + 6 * 3600_000).toISOString(), STRIPE_TEST_SECRET_KEY: TSK, STRIPE_TEST_WEBHOOK_SECRET: TWH, COMPARE_ADMIN_TOKEN: ADMIN };
const A = { authorization: "Bearer " + ADMIN };
const store = (env, id) => env.COMPARE_ORDERS.peek(id).store;
// Den verkliga testordens offert: arbete 20000 exkl / material 4000 exkl / total 29000 inkl / ROT 10000
const SPEC = { extracted: { jobType: "malning", areaM2: 30, priceType: "ungefarligt", vatMode: "exkl", laborSumSek: 20000, materialSumSek: 4000, totalBeforeRotSek: 29000, totalVatBasis: "inkl", rotAmountSek: 10000 }, scope: { material: "ingar", arbete: "ingar" } };
async function paidCheck(f, env) {
  const c = await api(env, "POST", "/compare/admin/test-order", { origin: "", headers: A, body: { kind: "check" } }); assert.equal(c.status, 201);
  const { orderId, token } = c.json;
  assert.equal((await upload(env, orderId, token, 0, SPEC)).status, 200);
  const ck = await api(env, "POST", `/compare/admin/test-order/${orderId}/checkout`, { origin: "", headers: A, body: { token } }); assert.equal(ck.status, 200);
  const sess = [...f.sessions.values()].pop();
  const raw = JSON.stringify({ id: "evt_" + orderId.slice(2, 10), type: "checkout.session.completed", data: { object: paidSession(sess) } });
  assert.equal((await api(env, "POST", "/compare/webhook-test", { raw, origin: "", headers: { "stripe-signature": await signForTest(raw, TWH), "content-type": "application/json" } })).status, 200);
  await env.COMPARE_ORDERS.runAlarms(1); await flushMailEvents(env, f).catch(() => {}); await env.COMPARE_ORDERS.runAlarms(8);
  return { orderId, token, sessions: f.sessions.size };
}
const mailsOf = (f, id) => (f.mails || []).filter((m) => JSON.stringify(m).includes(id));

test("recheck: samma betalda TEST-checkorder ⇒ ny avläsning, reviderad rapport (testRecheck), gammal bevarad, köp/avtal/ledger oförändrade, ingen ny order/session, idempotent", async () => {
  const f = installFetch(); try {
    const env = makeEnv({ COMPARE_CONSENT_POLICY: "P", ...SELLER, ...ON, ...TC });
    const { orderId, token, sessions } = await paidCheck(f, env);
    const o0 = JSON.parse(JSON.stringify(store(env, orderId).get("order"))); assert.equal(o0.status, "delivered");
    const led0 = JSON.stringify(store(env, orderId).get("ledger"));
    // Simulera rapporten som den gamla koden gav den: blandad moms ⇒ kategorisk 6 000-rättelse, och startdatum känt ⇒ fk_tid borta (fält och fynd ur den verkliga bristen)
    const rk = o0.reportKey; const R0 = JSON.parse(await env.REVIEWS_KV.get(rk));
    R0.original.vatMode = "blandat"; R0.scope = R0.scope.map((r) => (r.id === "startdatum" ? { ...r, status: "ingar", page: 1, ref: "Start november" } : r));
    R0.findings = R0.findings.filter((x) => x.id !== "fk_tid").map((x) => (x.id === "rot_belopp" ? { ...x, text: "ROT 50 % blir 6 000 kr, offerten anger 10 000 kr." } : x));
    await env.REVIEWS_KV.put(rk, JSON.stringify(R0));
    const oldRep = await env.REVIEWS_KV.get(rk);
    const call = (body, headers = A) => api(env, "POST", `/compare/admin/test-order/${orderId}/recheck`, { origin: "", headers, body });
    const aiBefore = f.log.anthropic.length; const r1 = await call({ token }); assert.equal(r1.status, 200, JSON.stringify(r1.json)); assert.equal(r1.json.ok, true); assert.equal(r1.json.revision, 1); assert.equal(r1.json.to, TEST_CHAIN_TO);
    await env.COMPARE_ORDERS.runAlarms(1); await flushMailEvents(env, f).catch(() => {}); await env.COMPARE_ORDERS.runAlarms(8);
    const o1 = store(env, orderId).get("order");
    assert.equal(o1.recheck.state, "done"); assert.equal(o1.work.deliveredAt, o0.work.deliveredAt); assert.deepEqual(o1.accept, o0.accept); assert.equal(o1.paidAt, o0.paidAt);
    assert.equal(JSON.stringify(store(env, orderId).get("ledger")), led0, "frusna köp/samtycken orörda");
    const rep = JSON.parse(await env.REVIEWS_KV.get(o0.reportKey)); assert.equal(rep.testRecheck.revision, 1); assert.equal(await env.REVIEWS_KV.get(o0.reportKey + ":r0"), oldRep, "gamla rapporten bevarad");
    assert.equal(rep.testRecheck.aiRead, false); assert.doesNotMatch(JSON.stringify(rep.findings), /ROT 50 %/); assert.match(JSON.stringify(rep.findings), /7 500|7\u00a0500/);
    assert.ok(rep.findings.some((x) => x.id === "fk_tid" && x.status === "fraga"), "fk_tid frågar när slut/tidplan saknas trots känd start");
    assert.equal(rep.receipt === null ? null : JSON.stringify(rep.receipt), R0.receipt === null ? null : JSON.stringify(R0.receipt), "kvitto oförändrat"); assert.equal(rep.createdAt, R0.createdAt); assert.equal(rep.expiresAt, R0.expiresAt);
    assert.equal(f.sessions.size, sessions, "ingen ny Stripe-session/betalning"); assert.equal(f.log.anthropic.length, aiBefore, "recheck gör inget leverantörsanrop");
    const m1 = store(env, orderId).get(`outbox:mail_rapport_r1_${orderId}`); assert.ok(m1, "reviderat rapportmejl köat"); assert.equal(m1.to, TEST_CHAIN_TO); assert.match(m1.subject, /reviderat testresultat/); assert.equal(m1.attachments[0].filename, `Forkontroll-${orderId.slice(2, 10).toUpperCase()}.pdf`);
    assert.ok(store(env, orderId).get(`outbox:mail_rapport_${orderId}`), "originalmejlet orört");
    const agTxt = JSON.stringify(agreementBlocks(store(env, orderId).get("ledger"), {}).map((b) => b.text || b.v || "")); assert.doesNotMatch(agTxt.replace("Inga omdömesvisningar ingår i förkontrollen", ""), /omdömesvisning|källans egna omdömen/i, "förkontrollens avtals-PDF utan omdömesvisningar (inkl. sidhuvud/fullgörandepunkt)");
    // idempotent: andra anropet gör ingen ny avläsning
    const aiN = f.log.anthropic.length;
    const r2 = await call({ token }); assert.equal(r2.status, 200); assert.equal(r2.json.already, true);
    assert.equal(f.log.anthropic.length, aiN, "ingen ny AI-läsning (varken 2:a anropet eller recheck)");
  } finally { f.restore(); }
});

test("recheck NEGATIV: ingen admin ⇒ 404; kort/fel nyckel ⇒ 400/404; jämförelseorder ⇒ 409; ej betald/ej levererad ⇒ 409; testkedja av ⇒ 404", async () => {
  const f = installFetch(); try {
    const env = makeEnv({ COMPARE_CONSENT_POLICY: "P", ...SELLER, ...ON, ...TC });
    const c = await api(env, "POST", "/compare/admin/test-order", { origin: "", headers: A, body: { kind: "check" } }); const { orderId, token } = c.json;
    const url = `/compare/admin/test-order/${orderId}/recheck`;
    assert.equal((await api(env, "POST", url, { origin: "", body: { token } })).status, 404, "ingen admin");
    assert.equal((await api(env, "POST", url, { origin: "", headers: A, body: { token: "kort" } })).status, 400, "kort nyckel");
    assert.equal((await api(env, "POST", url, { origin: "", headers: A, body: { token: "b".repeat(token.length) } })).status, 404, "fel nyckel");
    assert.equal((await api(env, "POST", url, { origin: "", headers: A, body: { token } })).status, 409, "obetald/ej levererad");
    const off = makeEnv({ COMPARE_CONSENT_POLICY: "P", ...SELLER, ...ON, ...TC, COMPARE_TEST_CHAIN: undefined });
    assert.equal((await api(off, "POST", url, { origin: "", headers: A, body: { token } })).status, 404, "testkedjan av");
    const cmp = await api(env, "POST", "/compare/admin/test-order", { origin: "", headers: A });
    assert.equal((await api(env, "POST", `/compare/admin/test-order/${cmp.json.orderId}/recheck`, { origin: "", headers: A, body: { token: cmp.json.token } })).status, 409, "jämförelse ⇒ 409");
    assert.equal((await api(env, "POST", `/compare/orders/${orderId}/recheck`, { token, body: {} })).status === 200, false, "ingen publik väg");
    assert.equal(f.sessions.size, 0);
  } finally { f.restore(); }
});

// ---------- steg A: strikt återinläggning av EXAKT samma text ⇒ verklig (dubblad) AI-avläsning på samma order ----------
const OLDREP = (R0) => { R0.original.vatMode = "blandat"; R0.findings = R0.findings.filter((x) => x.id !== "fk_tid").map((x) => (x.id === "rot_belopp" ? { ...x, text: "ROT 50 % blir 6 000 kr, offerten anger 10 000 kr." } : x)); return R0; };
test("reread: exakt samma text ⇒ ny AI-avläsning, revision 2, tidigare rapport bevarad (:r1), dokument+ext raderade, köp/ledger orörda, ETT mejl, idempotent, ingen ny session", async () => {
  const f = installFetch(); try {
    const env = makeEnv({ COMPARE_CONSENT_POLICY: "P", ...SELLER, ...ON, ...TC });
    const { orderId, token, sessions } = await paidCheck(f, env);
    const o0 = JSON.parse(JSON.stringify(store(env, orderId).get("order"))); const led0 = JSON.stringify(store(env, orderId).get("ledger"));
    assert.ok(o0.docs && o0.docs[0] && o0.docs[0].sha256, "dokument-digest bevarad efter leverans");
    const rk = o0.reportKey; await env.REVIEWS_KV.put(rk, JSON.stringify(OLDREP(JSON.parse(await env.REVIEWS_KV.get(rk))))); const prev = await env.REVIEWS_KV.get(rk);
    const dk = `cmpdoc:${orderId}:0:${o0.docs[0].sha256.slice(0, 40)}`; assert.equal(await env.REVIEWS_KV.get(dk), null, "originalfilen är raderad före steg A");
    const call = (body) => api(env, "POST", `/compare/admin/test-order/${orderId}/recheck`, { origin: "", headers: A, body });
    const ai0 = f.log.anthropic.length;
    const r = await call({ token, text: offerText(SPEC) }); assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.aiRead, true); assert.equal(r.json.revision, 2);
    await env.COMPARE_ORDERS.runAlarms(1); await flushMailEvents(env, f).catch(() => {}); await env.COMPARE_ORDERS.runAlarms(8);
    assert.ok(f.log.anthropic.length > ai0, "verklig AI-avläsning gjordes");
    const rep = JSON.parse(await env.REVIEWS_KV.get(rk)); assert.equal(rep.testRecheck.revision, 2); assert.equal(rep.testRecheck.aiRead, true); assert.equal(rep.testRecheck.originalDigest, o0.docs[0].sha256);
    assert.equal(await env.REVIEWS_KV.get(rk + ":r1"), prev, "tidigare rapport bevarad");
    assert.doesNotMatch(JSON.stringify(rep.findings), /ROT 50 %/); assert.match(JSON.stringify(rep.findings), /7 500|7 500/);
    assert.equal(await env.REVIEWS_KV.get(dk), null, "dokumentet raderat direkt efteråt"); assert.equal(store(env, orderId).get("ext:0"), undefined, "avläsningen raderad");
    const o1 = store(env, orderId).get("order"); assert.equal(o1.reread.state, "done"); assert.equal(o1.work.deliveredAt, o0.work.deliveredAt); assert.deepEqual(o1.accept, o0.accept); assert.equal(JSON.stringify(store(env, orderId).get("ledger")), led0);
    assert.equal(f.sessions.size, sessions, "ingen ny betalning/session");
    const m = store(env, orderId).get(`outbox:mail_rapport_r2_${orderId}`); assert.ok(m); assert.equal(m.to, TEST_CHAIN_TO); assert.match(m.subject, /R2/);
    const ai1 = f.log.anthropic.length; const r2 = await call({ token, text: offerText(SPEC) }); assert.equal(r2.status, 200); assert.equal(r2.json.already, true); assert.equal(f.log.anthropic.length, ai1, "idempotent: ingen ny läsning");
  } finally { f.restore(); }
});

test("reread NEGATIV: fel text ⇒ 409 digest, ingen AI/ingen skrivning; tom/för lång ⇒ 400; pågår ⇒ 409; 2 försök ⇒ 429; ingen admin ⇒ 404; jämförelse/ej levererad ⇒ 409", async () => {
  const f = installFetch(); try {
    const env = makeEnv({ COMPARE_CONSENT_POLICY: "P", ...SELLER, ...ON, ...TC });
    const { orderId, token } = await paidCheck(f, env);
    const url = `/compare/admin/test-order/${orderId}/recheck`; const call = (body, headers = A) => api(env, "POST", url, { origin: "", headers, body });
    const o0 = store(env, orderId).get("order"); const key = `cmpdoc:${orderId}:0:${o0.docs[0].sha256.slice(0, 40)}`;
    const ai0 = f.log.anthropic.length, rep0 = await env.REVIEWS_KV.get(o0.reportKey);
    const bad = await call({ token, text: offerText({ ...SPEC, extracted: { ...SPEC.extracted, laborSumSek: 1 } }) }); assert.equal(bad.status, 409); assert.equal(bad.json.reason, "digest_matchar_inte");
    assert.equal(await env.REVIEWS_KV.get(key), null, "ingen fil skrevs"); assert.equal(f.log.anthropic.length, ai0); assert.equal(await env.REVIEWS_KV.get(o0.reportKey), rep0, "rapporten orörd");
    assert.equal((await call({ token, text: "  " })).status, 400); assert.equal((await call({ token, text: 5 })).status, 400);
    assert.equal((await call({ token, text: "x".repeat(200000) })).status === 200, false);
    assert.equal((await api(env, "POST", url, { origin: "", body: { token, text: offerText(SPEC) } })).status, 404, "ingen admin");
    assert.equal((await call({ token: "b".repeat(token.length), text: offerText(SPEC) })).status, 404, "fel nyckel");
    const o = store(env, orderId).get("order");
    store(env, orderId).set("order", { ...o, reread: { state: "running", attempts: 1, leaseUntil: Date.now() + 60000 } }); assert.equal((await call({ token, text: offerText(SPEC) })).status, 409, "pågår");
    store(env, orderId).set("order", { ...o, reread: { state: "failed", attempts: 2, leaseUntil: 0 } }); assert.equal((await call({ token, text: offerText(SPEC) })).status, 429, "max 2 försök");
    store(env, orderId).set("order", { ...o, docs: [{ ...o.docs[0], sha256: undefined }] }); const nd = await call({ token, text: offerText(SPEC) }); assert.equal(nd.status, 409); assert.equal(nd.json.reason, "digest_saknas");
    assert.equal(f.log.anthropic.length, ai0, "inga AI-anrop i nekade fall");
    const cmp = await api(env, "POST", "/compare/admin/test-order", { origin: "", headers: A });
    assert.equal((await api(env, "POST", `/compare/admin/test-order/${cmp.json.orderId}/recheck`, { origin: "", headers: A, body: { token: cmp.json.token, text: "FIXTURE:{}" } })).status, 409);
  } finally { f.restore(); }
});
