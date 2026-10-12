// D17 Förkontroll av min offert (offline, syntetiskt): facit, bekräftelser, text/PDF med samma fakta+revision, 4900 öre serverfryst, betal-/authnegativa, idempotens, utgång.
import { test } from "node:test";
import assert from "node:assert/strict";
import { signForTest } from "../src/compare_stripe.js";
import { makeEnv, installFetch, api, upload, startCheckout, paidSession, webhook, pdfText, norm, flushMailEvents, consentOf } from "./helpers/compare_env.mjs";
import { buildCheckReport, validateConfirmation, deriveFacts, checkOutputs, customerAttachmentPdf, additionSections } from "../src/compare_check.js";
import { b64Bytes } from "../src/compare_pdf.js";
import { CHECK_TERMS_TEXT_SHA256, checkServiceSectionText, checkConsentSnapshot, CHECK_TERMS_VERSION, consentSnapshot } from "../src/compare_config.js";
import { createHash } from "node:crypto";
import { sanitizeOffer } from "../src/compare_extract.js";

import { MAIL_WH_SECRET } from "./helpers/compare_env.mjs";
const SELLER = { COMPARE_SELLER_FORM: "AB", COMPARE_SELLER_NAME: "Syntetisk Säljare AB", COMPARE_SELLER_ORGNR: "556000-0001", COMPARE_SELLER_EMAIL: "kontakt@example.test", COMPARE_SELLER_ADDRESS: "Exempelgatan 1, 111 11 Teststad", COMPARE_SELLER_PHONE: "08-000 00 00", COMPARE_SELLER_INFO_URL: "https://example.test/info" };
const MAIL = { COMPARE_MAILER_MODE: undefined, COMPARE_MAIL_HTTP: "1", COMPARE_MAIL_HTTP_VERIFIED: "1", COMPARE_MAIL_FROM: "Jämför <jamfor@example.test>", COMPARE_MAIL_DAY_CAP: "20", COMPARE_MAIL_API_KEY: "re_TESTONLY_syntheticKey0123456789", COMPARE_MAIL_WEBHOOK_SECRET: MAIL_WH_SECRET };
const P = { COMPARE_CONSENT_POLICY: "P", ...SELLER, ...MAIL };
const FEL = { extracted: { jobType: "malning", areaM2: 30, laborSumSek: 20000, materialSumSek: 4000, rotAmountSek: 10000, vatMode: "exkl", totalSumSek: 29000, totalVatBasis: "inkl", priceType: "ungefarligt", propertyType: "smahus", customerType: "privatperson", workDescription: "Måla vardagsrum 30 m²" }, scope: { material: "ingar", arbete: "ingar" } };
const OK = { priceType: "fast", laborInclVat: 25000, materialInclVat: 5000, otherInclVat: 0, rotMode: "villkorat", plannedStart: "2026-11-02", plannedEnd: "2026-11-06", includes: ["väggar", "enklare spackling och slipning", "två vita strykningar"], excludes: ["tak", "snickerier", "större skador"], cleaning: "ingar", removal: "ingar" };
const store = (env, id) => env.COMPARE_ORDERS.peek(id).store;

async function createCheck(env, extra = {}) { return api(env, "POST", "/compare/orders", { body: { kind: "check", accept: { sameJob: true }, ...extra } }); }
async function paidCheck(env, f, spec = FEL) {
  const c = await createCheck(env); assert.equal(c.status, 201, JSON.stringify(c.json));
  const { orderId, token } = c.json;
  assert.equal((await upload(env, orderId, token, 0, spec)).status, 200);
  const cfg = (await api(env, "GET", "/compare/config")).json.check;
  const acc = { terms: true, declaration: true, consentHash: cfg.consent.hash, consentVersion: cfg.consent.version, email: "kund@example.test" };
  const ck = await api(env, "POST", `/compare/orders/${orderId}/checkout`, { token, body: { accept: acc } });
  assert.equal(ck.status, 200, JSON.stringify(ck.json));
  const sess = [...f.sessions.values()].filter((s) => s.client_reference_id === orderId).pop();
  return { orderId, token, sess };
}
async function deliver(env, f, spec = FEL) {
  const o = await paidCheck(env, f, spec);
  assert.equal((await webhook(env, "checkout.session.completed", paidSession(o.sess))).status, 200);
  await env.COMPARE_ORDERS.runAlarms(1); await flushMailEvents(env, f).catch(() => {}); await env.COMPARE_ORDERS.runAlarms(8);
  return o;
}

test("facit: syntetisk målning – fel total 29 000/ROT 10 000 ⇒ fynd (summa, ROT-bas, pristyp, omfattning, tid); korrekt arbete 25 000 + material 5 000 ⇒ total 30 000, ROT villkorat 7 500, netto 22 500", async () => {
  const offer = sanitizeOffer({ extracted: { ...FEL.extracted, trades: [], hourlyRateSek: null, hours: null, travelSumSek: null }, scope: [], facts: [], readability: { level: "bra" } });
  const R = buildCheckReport({ order: { id: "o_" + "a".repeat(32) }, offer, label: "Din offert", now: Date.UTC(2026, 9, 11) });
  const ids = R.findings.filter((f) => f.status !== "ok").map((f) => f.id);
  for (const id of ["rot_belopp", "summa", "fk_pristyp", "fk_omfattning", "fk_tid", "fk_garanti"]) assert.ok(ids.includes(id), "fynd saknas: " + id + " i " + ids);
  assert.ok(R.needs.some((n) => n.id === "priceType") && R.needs.some((n) => n.id === "amounts") && R.needs.some((n) => n.id === "dates"));
  const v = validateConfirmation(OK); assert.ok(v.values);
  const f = deriveFacts(v.values); assert.deepEqual([f.totalInclVat, f.rot.amountKr, f.rot.netKr, f.vatKr], [30000, 7500, 22500, 6000]);
  const o = await checkOutputs(R, { revision: 1, values: v.values });
  const n = norm(o.text);
  for (const s of ["Fast pris: 30 000 kr inklusive moms", "arbete 25 000 kr, material 5 000 kr", "blir avdraget 7 500 kr", "du betalar då 22 500 kr efter avdraget", "villkorat", "väggar; enklare spackling och slipning; två vita strykningar", "Ingår inte: tak; snickerier; större skador", "Städning efter arbetet ingår", "Bortforsling av avfall ingår", "2 november 2026", "6 november 2026", "Originalofferten är oförändrad"]) assert.ok(n.includes(s), "text saknar: " + s + "\n" + n);
  assert.ok(!/garanti/i.test(o.text), "garanti okänd ⇒ ingen garanti i texten");
  // PDF bär exakt samma fakta + revision/kod
  const { pdf, out } = await customerAttachmentPdf(R, { revision: 1, values: v.values }, { orderNo: "AAAAAAAA" });
  const t = norm(pdfText(b64Bytes(pdf)));
  for (const s of ["Tillägg till offert", "30 000 kr", "7 500 kr", "22 500 kr", "25 000 kr", "5 000 kr", "Revision 1", out.code, "2 november 2026", "väggar; enklare spackling och slipning; två vita strykningar", "Originalofferten är oförändrad"]) assert.ok(t.includes(s), "PDF saknar: " + s);
  assert.ok(!/garanti/i.test(t));
  assert.ok(!/stämpel|certifikat|godkänd av/i.test(t + n), "ingen stämpel/certifiering");
});

test("okänt förblir okänt: utan bekräftad total/ROT/garanti/tid skrivs ingen total, ingen ROT, ingen garanti, ingen tid – bara det som bekräftats", async () => {
  const f1 = deriveFacts(validateConfirmation({ laborInclVat: 25000 }).values); assert.equal(f1.totalInclVat, null); assert.equal(f1.rot, null);
  const s1 = additionSections(f1); assert.deepEqual(s1.map((x) => x.id), ["pris"], "arbete ensamt ger bara ett delbelopp, varken total eller ROT"); assert.equal(s1[0].text, "Delbelopp inklusive moms: arbete 25 000 kr.");
  const f2 = deriveFacts(validateConfirmation({ laborInclVat: 25000, materialInclVat: 5000, otherInclVat: 0 }).values); assert.equal(f2.totalInclVat, 30000); assert.equal(f2.rot, null, "ROT kräver uttryckligt val");
  const f2b = deriveFacts(validateConfirmation({ laborInclVat: 25000, materialInclVat: 5000 }).values); assert.equal(f2b.totalInclVat, null, "tomt övrigt är okänt, aldrig 0: ingen komplett total"); assert.ok(f2b.totalMissing.some((x) => /övrigt/.test(x)));
  const sec = additionSections(f2).map((s) => s.id); assert.deepEqual(sec, ["pris"]);
  assert.equal(additionSections(deriveFacts({ plannedStart: "2026-11-02" }))[0].text, "Planerad start 2 november 2026.");
  const g = additionSections(deriveFacts(validateConfirmation({ warranty: "Två års garanti på utfört arbete." }).values)); assert.equal(g[0].text, "Två års garanti på utfört arbete.");
});

test("NEGATIV validering: orimliga datum, slut före start, HTML/styrtecken, negativa/stora belopp, okända fält, för många rader/långa rader avvisas", () => {
  const bad = [{ plannedStart: "2026-02-30" }, { plannedStart: "2026-11-06", plannedEnd: "2026-11-02" }, { plannedStart: "imorgon" }, { includes: ["<script>alert(1)</script>"] }, { excludes: ["a\u0000b"] }, { warranty: "<b>x</b>" },
    { laborInclVat: -1 }, { laborInclVat: 1e9 }, { laborInclVat: "25000" }, { laborInclVat: 25000.99 }, { materialInclVat: 0.5 }, { otherInclVat: 12.3 }, { priceType: "gratis" }, { rotMode: "ja" }, { isAdmin: true }, { includes: Array(9).fill("x") }, { includes: ["x".repeat(141)] }, { cleaning: "kanske" }, null, [], "x"];
  for (const b of bad) assert.ok(validateConfirmation(b).error, JSON.stringify(b));
  assert.ok(validateConfirmation({}).values && Object.keys(validateConfirmation({}).values).length === 0);
});

test("E2E: produkt, pris 4900 öre serverfryst, Stripe-session för förkontroll, leverans (check-rapport), mejl, bekräfta→text+PDF samma revision, resultattoken/fel token/jämförelseorder når inte /check", async () => {
  const f = installFetch(); try {
    const env = makeEnv(P);
    const cfg = (await api(env, "GET", "/compare/config")).json;
    assert.equal(cfg.check.available, true); assert.equal(cfg.check.offer.product, "Förkontroll av min offert"); assert.equal(cfg.check.offer.priceOre, 4900); assert.equal(cfg.check.consent.draft, true);
    assert.equal(cfg.offer.product, "Jämför mina offerter"); assert.notEqual(cfg.check.consent.hash, cfg.consent.hash);
    assert.ok(cfg.check.terms.sections.some((s) => /Förkontroll av min offert/.test(s.text)) && !/jämförelse/i.test(cfg.check.terms.sections.find((s) => s.id === "angerratt").text));
    assert.equal((await createCheck(env, { docCount: 2 })).status, 400, "förkontroll = en offert");
    const o = await paidCheck(env, f);
    const create = f.log.stripeCreate.filter((x) => x.body.includes(o.orderId)).pop(); const p = new URLSearchParams(create.body);
    assert.equal(p.get("line_items[0][price_data][unit_amount]"), "4900"); assert.equal(p.get("line_items[0][price_data][currency]"), "sek"); assert.equal(p.get("line_items[0][price_data][product_data][name]"), "Förkontroll av min offert"); assert.equal(p.get("metadata[product]"), "check");
    // obetald ⇒ ingen /check
    assert.equal((await api(env, "GET", `/compare/orders/${o.orderId}/check`, { token: o.token })).status, 409);
    assert.equal((await webhook(env, "checkout.session.completed", paidSession(o.sess))).status, 200);
    await env.COMPARE_ORDERS.runAlarms(1); await flushMailEvents(env, f); await env.COMPARE_ORDERS.runAlarms(8);
    const order = store(env, o.orderId).get("order"); assert.equal(order.status, "delivered"); assert.equal(order.kind, "check");
    const rep = (await api(env, "GET", `/compare/orders/${o.orderId}/report`, { token: o.token })).json.report;
    assert.equal(rep.kind, "check"); assert.ok(rep.findings.length > 3); assert.equal(rep.receipt.product, "Förkontroll av min offert"); assert.equal(rep.receipt.amountOre, 4900);
    const mails = f.log.mailSent.map((m) => m.body); const conf = mails.find((m) => String(m.subject).includes("avtalsbekräftelse")); const rm = mails.find((m) => String(m.subject).includes("förkontroll är klar"));
    assert.ok(conf && rm, mails.map((m) => m.subject).join("|"));
    assert.ok(/förkontroll/.test(conf.text) && !/jämförelse/.test(conf.text)); assert.match(rm.text, /Här är din förkontroll/);
    const lt = /#o=(o_[0-9a-f]{32})&r=([A-Za-z0-9_-]{32})/.exec(rm.text); assert.ok(lt); const rt = lt[2];
    assert.match(norm(pdfText(rm.attachments[0].content)), /Förkontroll/);
    // auth: resultattoken, fel token, saknad token ⇒ aldrig /check
    for (const [m, sub, b] of [["GET", "check"], ["PUT", "check", { values: OK }], ["POST", "check/export"]]) {
      assert.equal((await api(env, m, `/compare/orders/${o.orderId}/${sub}`, { token: rt, body: b })).status, 404, "resultattoken " + sub);
      assert.equal((await api(env, m, `/compare/orders/${o.orderId}/${sub}`, { token: "z".repeat(32), body: b })).status, 404, "fel token " + sub);
      assert.equal((await api(env, m, `/compare/orders/${o.orderId}/${sub}`, { body: b })).status, 404, "ingen token " + sub);
    }
    assert.equal((await api(env, "PUT", `/compare/orders/${o.orderId}/check`, { token: o.token, body: { values: OK }, origin: "https://evil.example" })).status, 403);
    // tom export ⇒ 409; ogiltigt ⇒ 400 utan revision
    assert.equal((await api(env, "POST", `/compare/orders/${o.orderId}/check/export`, { token: o.token })).status, 409);
    const bad = await api(env, "PUT", `/compare/orders/${o.orderId}/check`, { token: o.token, body: { values: { plannedStart: "2026-13-01" } } }); assert.equal(bad.status, 400);
    assert.equal((await api(env, "GET", `/compare/orders/${o.orderId}/check`, { token: o.token })).json.revision, 0);
    // bekräfta ⇒ revision 1; samma värden igen ⇒ oförändrad (ingen ny revision); ändring ⇒ revision 2
    const s1 = await api(env, "PUT", `/compare/orders/${o.orderId}/check`, { token: o.token, body: { values: OK } }); assert.equal(s1.status, 200); assert.equal(s1.json.revision, 1);
    assert.match(norm(s1.json.outputs.text), /Fast pris: 30 000 kr inklusive moms/);
    const s1b = await api(env, "PUT", `/compare/orders/${o.orderId}/check`, { token: o.token, body: { values: OK } }); assert.equal(s1b.json.revision, 1); assert.equal(s1b.json.unchanged, true);
    const ex = await api(env, "POST", `/compare/orders/${o.orderId}/check/export`, { token: o.token }); assert.equal(ex.status, 200); assert.equal(ex.json.revision, 1);
    const pt = norm(pdfText(b64Bytes(Uint8Array.from(atob(ex.json.pdfBase64), (c) => c.charCodeAt(0)))));
    assert.ok(pt.includes(ex.json.code) && pt.includes("30 000 kr") && pt.includes("22 500 kr") && ex.json.text.includes(ex.json.code), "text och PDF: samma kod/fakta");
    const s2 = await api(env, "PUT", `/compare/orders/${o.orderId}/check`, { token: o.token, body: { values: { ...OK, warranty: "Två års garanti på utfört arbete." } } }); assert.equal(s2.json.revision, 2); assert.notEqual(s2.json.outputs.code, ex.json.code);
    assert.match(s2.json.outputs.text, /Två års garanti/);
    // gränser: max antal revisioner
    for (let i = 3; i <= 12; i++) assert.equal((await api(env, "PUT", `/compare/orders/${o.orderId}/check`, { token: o.token, body: { values: { ...OK, includes: ["rad " + i] } } })).status, 200);
    assert.equal((await api(env, "PUT", `/compare/orders/${o.orderId}/check`, { token: o.token, body: { values: { ...OK, includes: ["en till"] } } })).status, 429);
    // utgång efter 24 h: 410 och bekräftelserna raderade
    const real = Date.now; Date.now = () => real() + 25 * 3600_000;
    try { assert.equal((await api(env, "GET", `/compare/orders/${o.orderId}/check`, { token: o.token })).status, 410); } finally { Date.now = real; }
    assert.equal(store(env, o.orderId).get("check"), undefined, "bekräftelser raderade vid utgång");
  } finally { f.restore(); }
});

test("NEGATIV betalning: jämförelsens samtyckeshash låser inte upp förkontroll; felprodukt/fel belopp/obetald/avbruten låser inte upp; duplicerad webhook ⇒ ett jobb; check utan policy P eller för jämförelseorder ⇒ stängt/404", async () => {
  const f = installFetch(); try {
    const env = makeEnv(P);
    // fel hash (jämförelsens) ⇒ 409
    const c = await createCheck(env); const { orderId, token } = c.json; await upload(env, orderId, token, 0, FEL);
    const cmp = (await api(env, "GET", "/compare/config")).json.consent;
    const wrong = await api(env, "POST", `/compare/orders/${orderId}/checkout`, { token, body: { accept: { terms: true, declaration: true, consentHash: cmp.hash, consentVersion: cmp.version, email: "kund@example.test" } } });
    assert.equal(wrong.status, 409); assert.equal(wrong.json.consentChanged, true);
    // rätt hash
    const o = await paidCheck(env, f);
    const bad = [paidSession(o.sess, { amount_total: 100 }), paidSession(o.sess, { metadata: { order_id: o.orderId } }), paidSession(o.sess, { metadata: { order_id: o.orderId, product: "compare" } }), { ...o.sess }, paidSession(o.sess, { status: "open" }), paidSession(o.sess, { payment_status: "unpaid" })];
    for (const s of bad) await webhook(env, "checkout.session.completed", s);
    assert.notEqual(store(env, o.orderId).get("order").status, "paid"); assert.ok(!["paid", "running", "delivered"].includes(store(env, o.orderId).get("order").status));
    assert.equal((await api(env, "GET", `/compare/orders/${o.orderId}/check`, { token: o.token })).status, 409, "obetald ⇒ ingen åtkomst");
    // äkta betalning två gånger (samma + nytt event-id) ⇒ ETT jobb
    const w1 = await webhook(env, "checkout.session.completed", paidSession(o.sess), { id: "evt_dupe_1" }); const w2 = await webhook(env, "checkout.session.completed", paidSession(o.sess), { id: "evt_dupe_2" }); const w3 = await webhook(env, "checkout.session.completed", paidSession(o.sess), { id: "evt_dupe_1" });
    assert.equal(w1.status, 200); assert.equal(w2.status, 200); assert.equal(w3.status, 200);
    await env.COMPARE_ORDERS.runAlarms(1); await flushMailEvents(env, f); await env.COMPARE_ORDERS.runAlarms(8);
    assert.equal(store(env, o.orderId).get("order").status, "delivered");
    const anthropicCalls = f.log.anthropic ? f.log.anthropic.length : null; if (anthropicCalls !== null) assert.equal(anthropicCalls, 1, "en avläsning, inget syntessteg");
    assert.equal(f.log.mailSent.filter((m) => String(m.body.subject).includes("förkontroll är klar")).length, 1, "ETT rapportmejl");
    // utan policy P: förkontroll erbjuds inte och kan inte skapas; jämförelseorder har ingen /check
    const q = makeEnv(); assert.equal((await api(q, "GET", "/compare/config")).json.check.available, false); assert.equal((await createCheck(q)).status, 503);
    const live = makeEnv({ ...P, COMPARE_PAYMENTS: "live", STRIPE_SECRET_KEY: "sk_live_abcdefgh1234" }); assert.equal((await api(live, "GET", "/compare/config")).json.check.available, false, "live kräver människoflagga COMPARE_CHECK_TERMS_VERIFIED=1");
    const live2 = makeEnv({ ...P, COMPARE_PAYMENTS: "live", STRIPE_SECRET_KEY: "sk_live_abcdefgh1234", COMPARE_CHECK_TERMS_VERIFIED: "1" }); assert.equal((await api(live2, "GET", "/compare/config")).json.check.available, false, "flaggan räcker inte utan hashen av den fastställda texten");
    const live3 = makeEnv({ ...P, COMPARE_PAYMENTS: "live", STRIPE_SECRET_KEY: "sk_live_abcdefgh1234", COMPARE_CHECK_TERMS_VERIFIED: "1", COMPARE_CHECK_TERMS_HASH: CHECK_TERMS_TEXT_SHA256 }); assert.equal((await api(live3, "GET", "/compare/config")).json.check.available, true);
    const cmpOrder = await api(env, "POST", "/compare/orders", { body: { docCount: 2, accept: { sameJob: true } } });
    assert.equal((await api(env, "GET", `/compare/orders/${cmpOrder.json.orderId}/check`, { token: cmpOrder.json.token })).status, 404, "jämförelseorder har ingen förkontroll");
    assert.equal((await api(env, "POST", "/compare/orders", { body: { kind: "annat", accept: { sameJob: true } } })).status, 400);
  } finally { f.restore(); }
});

// ---------------- D17-R1 ----------------
const reportFel = () => buildCheckReport({ order: { id: "o_" + "a".repeat(32) }, offer: sanitizeOffer({ extracted: { ...FEL.extracted, trades: [], hourlyRateSek: null, hours: null, travelSumSek: null }, scope: [], facts: [], readability: { level: "bra" } }), label: "Din offert", now: Date.UTC(2026, 9, 11) });

test("R1 punkt 3: decimaler avvisas (aldrig tyst avrundning); heltal accepteras", () => {
  for (const b of [{ laborInclVat: 25000.99 }, { materialInclVat: 0.5 }, { otherInclVat: 1.2 }, { laborInclVat: "25000" }]) assert.ok(validateConfirmation(b).error, JSON.stringify(b));
  assert.equal(validateConfirmation({ laborInclVat: 25000 }).values.laborInclVat, 25000);
});

test("R1 punkt 2: tomt övrigt är okänt – ingen komplett total; uttryckligt 0 + arbete + material ger 30 000/ROT 7 500/netto 22 500", async () => {
  const R = reportFel();
  const a = await checkOutputs(R, { revision: 1, values: validateConfirmation({ priceType: "fast", laborInclVat: 25000, materialInclVat: 5000, rotMode: "villkorat" }).values });
  assert.equal(a.facts.totalInclVat, null); assert.ok(!/30 000/.test(a.text), "ingen total utan uttryckligt övrigt"); assert.match(a.text, /Delbelopp inklusive moms: arbete 25 000 kr, material 5 000 kr/);
  assert.equal(a.facts.rot.netKr, null, "ingen nettosumma utan total");
  const b = await checkOutputs(R, { revision: 1, values: validateConfirmation(OK).values });
  assert.equal(b.facts.totalInclVat, 30000); assert.equal(b.facts.vatKr, 6000); assert.equal(b.facts.rot.amountKr, 7500); assert.equal(b.facts.rot.netKr, 22500); assert.equal(b.draft, false); assert.deepEqual(b.unresolved, []);
});

test("R1 punkt 4: endast garanti bekräftad ⇒ UTKAST + kvarstående lista i skärmdata, kopierad text och PDF; fullt facit ger inget utkast; garanti blockerar aldrig", async () => {
  const R = reportFel(); assert.ok(R.needs.length >= 3);
  const conf = { revision: 1, values: validateConfirmation({ warranty: "Två års garanti på utfört arbete." }).values };
  const o = await checkOutputs(R, conf);
  assert.equal(o.draft, true); assert.ok(["priceType", "amounts", "scope", "dates"].every((id) => o.unresolved.some((u) => u.id === id)), JSON.stringify(o.unresolved));
  assert.ok(!o.unresolved.some((u) => u.id === "warranty")); assert.match(o.text, /^Tillägg till offert[^\n]*\n\nUTKAST – tillägget är inte komplett\. Kvarstår att bekräfta:/); assert.match(o.text, /Kvarstår att bekräfta:[^\n]*\.$/);
  const { pdf, out } = await customerAttachmentPdf(R, conf, { orderNo: "AAAAAAAA" }); const pt = norm(pdfText(b64Bytes(pdf)));
  assert.equal(out.draft, true); assert.match(pt, /UTKAST/); assert.match(pt, /Kvarstår att bekräfta/); assert.ok(out.unresolved.every((u) => pt.includes(u.label.split(":")[0].split(" (")[0])), "samma lista i PDF");
  const full = await checkOutputs(R, { revision: 2, values: validateConfirmation(OK).values }); assert.equal(full.draft, false); assert.ok(!/UTKAST/.test(full.text));
  assert.ok(!/garanti/i.test(full.text), "ingen påhittad garanti");
});

test("R1 punkt 7: ROT över personårstaket ⇒ inget personligt avdrag/netto utan bekräftad fördelning; under taket oförändrat (7 500 villkorat)", async () => {
  const R = reportFel();
  const big = await checkOutputs(R, { revision: 1, values: validateConfirmation({ priceType: "fast", laborInclVat: 1000000, materialInclVat: 0, otherInclVat: 0, rotMode: "villkorat" }).values });
  const rot = big.sections.find((x) => x.id === "rot").text;
  assert.equal(big.facts.rot.overCap, true); assert.equal(big.facts.rot.amountKr, null); assert.equal(big.facts.rot.netKr, null);
  assert.match(rot, /högst 50 000 kr per person och år/); assert.match(rot, /hur många som äger bostaden/); assert.match(rot, /Något avdrag eller belopp efter avdrag anges därför inte här/);
  assert.ok(!/blir avdraget|du betalar då|700 000|300 000 kr efter/.test(rot) && !/betalar då/.test(big.text), rot);
  const small = await checkOutputs(R, { revision: 1, values: validateConfirmation(OK).values }); const r2 = small.sections.find((x) => x.id === "rot").text;
  assert.match(r2, /blir avdraget 7 500 kr/); assert.match(r2, /villkorat/); assert.match(r2, /högst 50 000 kr per person och år/);
  // exakt på taket (166 667 kr arbete → 50 000,1 ≈ 50 000) fortfarande under/lika med taket
  assert.equal((await checkOutputs(R, { revision: 1, values: { laborInclVat: 166666, materialInclVat: 0, otherInclVat: 0, rotMode: "villkorat" } })).facts.rot.overCap, false);
  assert.equal((await checkOutputs(R, { revision: 1, values: { laborInclVat: 170000, materialInclVat: 0, otherInclVat: 0, rotMode: "villkorat" } })).facts.rot.overCap, true);
});

test("R1 punkt 5: villkorstexten har fast hash; snapshot är utkast tills människogrinden (flagga + hash av EXAKT texten) är uppfylld; fel hash ⇒ fortsatt utkast; ingen egen flagga", () => {
  assert.equal(createHash("sha256").update(checkServiceSectionText()).digest("hex"), CHECK_TERMS_TEXT_SHA256, "texten ändrad utan ny hash: kräver ny mänsklig fastställelse");
  assert.match(checkServiceSectionText(), /PDF-bilaga till din kund som bara innehåller det du bekräftat/); assert.match(checkServiceSectionText(), /högst 50 000 kr per person och år/); assert.match(checkServiceSectionText(), /ingen stämpel och ingen garanti/);
  assert.equal(CHECK_TERMS_VERSION, "villkor-fk-1");
  const base = { ...P, COMPARE_PAYMENTS: "live", STRIPE_SECRET_KEY: "sk_live_abcdefgh1234" };
  const d0 = checkConsentSnapshot(makeEnv(P)); assert.equal(d0.draft, true); assert.equal(d0.terms.draft, true); assert.equal(d0.terms.version, "villkor-fk-1");
  const d1 = checkConsentSnapshot(makeEnv({ ...base, COMPARE_CHECK_TERMS_VERIFIED: "1" })); assert.equal(d1.draft, true, "flagga utan hash räcker inte");
  const d2 = checkConsentSnapshot(makeEnv({ ...base, COMPARE_CHECK_TERMS_VERIFIED: "1", COMPARE_CHECK_TERMS_HASH: "0".repeat(64) })); assert.equal(d2.draft, true, "fel hash");
  const d3 = checkConsentSnapshot(makeEnv({ ...base, COMPARE_CHECK_TERMS_VERIFIED: "1", COMPARE_CHECK_TERMS_HASH: CHECK_TERMS_TEXT_SHA256 })); assert.equal(d3.draft, false); assert.equal(d3.terms.draft, false);
});

test("R1 punkt 6: export bunden till visad revision – A visar rev 1, B sparar rev 2 ⇒ A:s export med revision 1 nekas (409 revision_andrad + aktuell vy), export med rev 2 ger samma kod/text som skärmen", async () => {
  const f = installFetch(); try {
    const env = makeEnv(P); const o = await deliver(env, f);
    const A = await api(env, "PUT", `/compare/orders/${o.orderId}/check`, { token: o.token, body: { values: OK } }); assert.equal(A.json.revision, 1);
    const B = await api(env, "PUT", `/compare/orders/${o.orderId}/check`, { token: o.token, body: { values: { ...OK, laborInclVat: 26000 } } }); assert.equal(B.json.revision, 2); assert.match(B.json.outputs.text, /31 000 kr/);
    const stale = await api(env, "POST", `/compare/orders/${o.orderId}/check/export`, { token: o.token, body: { revision: 1 } });
    assert.equal(stale.status, 409); assert.equal(stale.json.revisionChanged, true); assert.equal(stale.json.revision, 2); assert.equal(stale.json.outputs.code, B.json.outputs.code); assert.equal(stale.json.pdfBase64, undefined, "ingen PDF vid föråldrad revision");
    assert.equal((await api(env, "GET", `/compare/orders/${o.orderId}/check`, { token: o.token })).json.exports, 0, "nekad export räknas inte");
    const ok = await api(env, "POST", `/compare/orders/${o.orderId}/check/export`, { token: o.token, body: { revision: 2 } }); assert.equal(ok.status, 200); assert.equal(ok.json.revision, 2); assert.equal(ok.json.code, B.json.outputs.code); assert.equal(ok.json.text, B.json.outputs.text);
    const pt = norm(pdfText(b64Bytes(Uint8Array.from(atob(ok.json.pdfBase64), (c) => c.charCodeAt(0))))); assert.ok(pt.includes(ok.json.code) && pt.includes("31 000 kr"));
  } finally { f.restore(); }
});

test("R1-2 punkt 1: faktisk GET /compare/config – check.consent.draft följer snapshotens draft (live + flagga + matchande hash ⇒ false; annars true)", async () => {
  const live = { ...P, COMPARE_PAYMENTS: "live", STRIPE_SECRET_KEY: "sk_live_SYNTHETICONLY" };
  const ok = (await api(makeEnv({ ...live, COMPARE_CHECK_TERMS_VERIFIED: "1", COMPARE_CHECK_TERMS_HASH: CHECK_TERMS_TEXT_SHA256 }), "GET", "/compare/config")).json.check;
  assert.equal(ok.available, true); assert.equal(ok.terms.draft, false); assert.equal(ok.consent.draft, false, "samma draft som snapshoten");
  const t = (await api(makeEnv(P), "GET", "/compare/config")).json.check; assert.equal(t.available, true); assert.equal(t.terms.draft, true); assert.equal(t.consent.draft, true);
});

test("R1-2 punkt 2: förkontrollens villkor/fullgörandetext oberoende av jämförelsens omdömesflagga; jämförelsevillkoren oförändrade", async () => {
  const base = { ...P, COMPARE_PAYMENTS: "live", STRIPE_SECRET_KEY: "sk_live_SYNTHETICONLY", COMPARE_CHECK_TERMS_VERIFIED: "1", COMPARE_CHECK_TERMS_HASH: CHECK_TERMS_TEXT_SHA256 };
  const off = checkConsentSnapshot(makeEnv(base)), on = checkConsentSnapshot(makeEnv({ ...base, COMPARE_REVIEWS: "1", COMPARE_REVIEWS_VERIFIED: "1" }));
  assert.deepEqual(on.terms.sections, off.terms.sections, "check-villkoren identiska i båda flagglägen"); assert.deepEqual(on.texts, off.texts);
  const ang = on.terms.sections.find((x) => x.id === "angerratt").text; assert.ok(!/omdömesvisning|Täckning/.test(ang), ang); assert.match(ang, /levererat din förkontroll/);
  assert.equal(on.dataCoverage.reviews, false);
  const cOff = consentSnapshot(makeEnv(base)), cOn = consentSnapshot(makeEnv({ ...base, COMPARE_REVIEWS: "1", COMPARE_REVIEWS_VERIFIED: "1" }));
  assert.ok(!/omdömesvisning/.test(cOff.terms.sections.find((x) => x.id === "angerratt").text)); assert.match(cOn.terms.sections.find((x) => x.id === "angerratt").text, /omdömesvisningar som visades före köpet/);
});
