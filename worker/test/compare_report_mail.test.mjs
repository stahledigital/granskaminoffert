// D16-R2 fix3 (offline): idempotent rapport-klart-mejl (ingen rapporttext, 24 h resultatlänk via outbox/Resend/mail-events), resultattoken ger bara rapportläsning, adminåterhämtning för testorder, explicit testkälla i exporten.
import { test } from "node:test";
import assert from "node:assert/strict";
import { signForTest } from "../src/compare_stripe.js";
import { TEST_CHAIN_TO } from "../src/compare_config.js";
import { makeEnv, installFetch, api, readyOrder, startCheckout, paidSession, webhook, upload, flushMailEvents, MAIL_WH_SECRET, pdfText, pdfLinks, norm } from "./helpers/compare_env.mjs";

const ADMIN = "a".repeat(32), TSK = "sk_test_TESTCHAINabcdefgh", TWH = "whsec_TESTCHAINsecret12345678";
const ON = { COMPARE_MAILER_MODE: undefined, COMPARE_MAIL_HTTP: "1", COMPARE_MAIL_HTTP_VERIFIED: "1", COMPARE_MAIL_FROM: "Jämför <jamfor@example.test>", COMPARE_MAIL_DAY_CAP: "20", COMPARE_MAIL_API_KEY: "re_TESTONLY_syntheticKey0123456789", COMPARE_MAIL_WEBHOOK_SECRET: MAIL_WH_SECRET };
const SELLER = { COMPARE_SELLER_FORM: "AB", COMPARE_SELLER_NAME: "Syntetisk Säljare AB", COMPARE_SELLER_ORGNR: "556000-0001", COMPARE_SELLER_EMAIL: "kontakt@example.test", COMPARE_SELLER_ADDRESS: "Exempelgatan 1, 111 11 Teststad", COMPARE_SELLER_PHONE: "+46 8 000 00 00", COMPARE_COMPANY_INFO_URL: "https://example.test/foretagsuppgifter" };
const TC = { COMPARE_TEST_CHAIN: "1", COMPARE_TEST_CHAIN_UNTIL: new Date(Date.now() + 6 * 3600_000).toISOString(), STRIPE_TEST_SECRET_KEY: TSK, STRIPE_TEST_WEBHOOK_SECRET: TWH, COMPARE_ADMIN_TOKEN: ADMIN };
const mk = () => makeEnv({ ...SELLER, ...ON, ...TC });
const S = (t) => ({ extracted: { totalBeforeRotSek: t, totalVatBasis: "inkl" }, scope: { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" } });
const A = { authorization: "Bearer " + ADMIN };
const store = (env, id) => env.COMPARE_ORDERS.peek(id).store;
const LINK = /#o=(o_[0-9a-f]{32})&r=([A-Za-z0-9_-]{32})/;

async function testHook(env, session, id) {
  const raw = JSON.stringify({ id: "evt_" + id, type: "checkout.session.completed", data: { object: session } });
  return api(env, "POST", "/compare/webhook-test", { raw, origin: "", headers: { "stripe-signature": await signForTest(raw, TWH), "content-type": "application/json" } });
}
async function deliverTestOrder(env, f, { noReportMail = false } = {}) {
  const c = await api(env, "POST", "/compare/admin/test-order", { origin: "", headers: A }); assert.equal(c.status, 201);
  const { orderId, token } = c.json;
  for (let i = 0; i < 2; i++) assert.equal((await upload(env, orderId, token, i, S(100000 + i * 10000))).status, 200);
  assert.equal((await api(env, "POST", `/compare/admin/test-order/${orderId}/checkout`, { origin: "", headers: A, body: { token } })).status, 200);
  const sess = [...f.sessions.values()].pop();
  assert.equal((await testHook(env, paidSession(sess), orderId.slice(2, 10))).status, 200);
  await env.COMPARE_ORDERS.runAlarms(1);              // skickar avtalsbekräftelsen
  assert.ok((await flushMailEvents(env, f)) >= 1);      // signerad delivered öppnar startgrinden
  const ru = env.COMPARE_RETURN_URL; if (noReportMail) delete env.COMPARE_RETURN_URL; // simulerar leverans före fixen (ingen länkbas ⇒ inget rapportmejl köas)
  await env.COMPARE_ORDERS.runAlarms(5);
  env.COMPARE_RETURN_URL = ru;                // pipeline → delivered → rapport-klart-mejl köas → skickas
  return { orderId, token };
}
const reportMails = (f) => f.log.mailSent.filter((m) => String(m.body.subject || "").includes("jämförelse är klar") || (m.body.tags || []).some((t) => String(t.value).startsWith("mail_rapport_")));

test("testorder: levererad ⇒ EXAKT ETT rapport-klart-mejl till hej@, länk i mejlet, ingen rapporttext/belopp, idempotent vid upprepning", async () => {
  const f = installFetch(); try {
    const env = mk(); const { orderId, token } = await deliverTestOrder(env, f);
    assert.equal(store(env, orderId).get("order").status, "delivered");
    const rm = reportMails(f); assert.equal(rm.length, 1, "ett rapportmejl");
    assert.deepEqual([].concat(rm[0].body.to), [TEST_CHAIN_TO]);
    const text = String(rm[0].body.text || rm[0].body.html || "");
    const m = LINK.exec(text); assert.ok(m, "personlig länk finns"); assert.equal(m[1], orderId);
    // 20:36: kort text + HELA rapporten som PDF + samma avtals-PDF
    assert.ok(text.startsWith("Tack för ditt köp!\n\nHär är din jämförelse – rapporten finns bifogad som PDF.\nDu kan också öppna den online"), "överenskommen korttext"); assert.ok(text.length < 420);
    assert.match(text, /Avtal och köpinformation finns i den andra bilagan\./);
    const at = rm[0].body.attachments; assert.deepEqual(at.map((a) => [a.filename, a.content_type]), [[`Jamforelse-${orderId.slice(2, 10).toUpperCase()}.pdf`, "application/pdf"], ["Avtal-och-villkor.pdf", "application/pdf"]]);
    for (const a of at) assert.ok(atob(a.content).startsWith("%PDF-1.4") && atob(a.content).trimEnd().endsWith("%%EOF"));
    const rp = norm(pdfText(at[0].content)), ap = norm(pdfText(at[1].content));
    for (const v of ["Din jämförelse", "Offerterna sida vid sida", "Testbygg Ett", "Testbygg Två", "100 000 kr", "110 000 kr", "Rivning och demontering", "Bortforsling av avfall", "Startdatum", "Betalningsplan", "Garanti", "Försäkring", "F-skatt anges", "Frågor att ställa till varje hantverkare", "Hur hanteras ändrings- och tilläggsarbeten (ÄTA)", "Jämförbarhet", "Det här går att jämföra nu", "Omdömen om företagen", "Gränser och metod", "Detta är inte juridisk rådgivning.", "Kvitto", "Betalningsreferens", "Jämför mina offerter (2 offerter)"]) assert.ok(rp.includes(v), "rapport-PDF saknar: " + v);
    for (const v of ["Avtal och köpinformation", "Pris 49,00 kr inklusive moms", "Säljare Syntetisk Säljare AB", "Det du godkände", "Villkor (version", "ÅNGERBLANKETT", "Information om konsument", "Beställdes* (datum)", "Skicka annars den ifyllda blanketten"]) assert.ok(ap.includes(v), "avtals-PDF saknar: " + v);
    const apl = pdfLinks(at[1].content); assert.ok(apl.includes("https://granskaminoffert.se/jamfor/kop/") || apl.some((l) => /\/jamfor\/kop\/$/.test(l)), "köpsidan klickbar"); assert.ok(!apl.some((l) => /angra\/#t=/.test(l)), "ingen personlig ångertoken i rapportmejlets PDF (råtoken lagras aldrig)");
    assert.ok(!/kr\b|ingår|Testbygg|85\s?000|100\s?000/i.test(text), "ingen rapport-/belopptext i brödtexten");
    const ob = store(env, orderId).get(`outbox:mail_rapport_${orderId}`);
    assert.equal(ob.state, "sent"); assert.equal(ob.secrets, null, "länktoken rensas ur utkorgen efter sändning");
    assert.ok(!JSON.stringify([...store(env, orderId)]).includes(m[2]), "råtoken lagras aldrig (bara hash)");
    // resultattoken: bara rapportläsning
    const R = await api(env, "GET", `/compare/orders/${orderId}/report`, { token: m[2] }); assert.equal(R.status, 200); assert.ok(R.json.report);
    assert.equal((await api(env, "GET", `/compare/orders/${orderId}/report`, { token: "x".repeat(32) })).status, 404);
    assert.equal((await api(env, "GET", `/compare/orders/${orderId}`, { token: m[2] })).status, 404, "resultattoken öppnar inte orderstatus");
    assert.equal((await api(env, "DELETE", `/compare/orders/${orderId}`, { token: m[2] })).status, 404, "…och kan inte radera");
    assert.equal((await api(env, "GET", `/compare/orders/${orderId}/report`, { token })).status, 200, "orderns egen token fungerar fortsatt");
    // idempotent: admin-återhämtning köar inget nytt
    const again = await api(env, "POST", `/compare/admin/test-order/${orderId}/report-mail`, { origin: "", headers: A });
    assert.equal(again.status, 200); assert.equal(again.json.queued, false);
    await env.COMPARE_ORDERS.runAlarms(2); assert.equal(reportMails(f).length, 1, "inget andra mejl");
    // utgång: efter 24 h fungerar länken inte
    const real = Date.now; Date.now = () => real() + 25 * 3600_000;
    try { assert.equal((await api(env, "GET", `/compare/orders/${orderId}/report`, { token: m[2] })).status, 404); } finally { Date.now = real; }
  } finally { f.restore(); }
});

test("admin-återhämtning: redan levererad testorder utan rapportmejl får det EN gång (ingen ny order); kräver admin+testChain, nekar riktiga ordrar", async () => {
  const f = installFetch(); try {
    const env = mk(); const { orderId } = await deliverTestOrder(env, f, { noReportMail: true });
    assert.equal(store(env, orderId).get("order").status, "delivered");
    assert.equal(store(env, orderId).get(`outbox:mail_rapport_${orderId}`), undefined);
    const n0 = reportMails(f).length; assert.equal(n0, 0);
    assert.equal((await api(env, "POST", `/compare/admin/test-order/${orderId}/report-mail`, { origin: "" })).status, 404, "kräver admin");
    const r = await api(env, "POST", `/compare/admin/test-order/${orderId}/report-mail`, { origin: "", headers: A });
    assert.equal(r.status, 200); assert.equal(r.json.queued, true); assert.equal(r.json.to, TEST_CHAIN_TO);
    await env.COMPARE_ORDERS.runAlarms(3);
    assert.equal(reportMails(f).length, n0 + 1);
    assert.equal((await api(env, "POST", `/compare/admin/test-order/${orderId}/report-mail`, { origin: "", headers: A })).json.queued, false);
    // riktig order: nekas av admin-rutten
    const real = await readyOrder(env, [S(100000), S(110000)]);
    assert.equal((await startCheckout(env, real.orderId, real.token)).status, 200);
    const rr = await api(env, "POST", `/compare/admin/test-order/${real.orderId}/report-mail`, { origin: "", headers: A });
    assert.notEqual(rr.status, 200);
  } finally { f.restore(); }
});

test("riktig order får också rapport-klart-mejl till frusen kontakt; export: testorder har explicit testkälla, aldrig stripe_live", async () => {
  const f = installFetch(); try {
    const env = mk();
    const real = await readyOrder(env, [S(100000), S(110000)]);
    assert.equal((await startCheckout(env, real.orderId, real.token)).status, 200);
    assert.equal((await webhook(env, "checkout.session.completed", paidSession([...f.sessions.values()].pop()))).status, 200);
    await env.COMPARE_ORDERS.runAlarms(1); await flushMailEvents(env, f); await env.COMPARE_ORDERS.runAlarms(5);
    assert.equal(store(env, real.orderId).get("order").status, "delivered");
    const rm = reportMails(f); assert.equal(rm.length, 1); assert.equal([].concat(rm[0].body.to)[0], "kund@example.test");
    const t = await deliverTestOrder(env, f);
    const month = new Date().toISOString().slice(0, 7);
    const only = await api(env, "GET", `/compare/admin/ledger?month=${month}&test=only`, { origin: "", headers: A });
    assert.deepEqual(only.json.rows.map((r) => r.orderId), [t.orderId]);
    assert.equal(only.json.rows[0].source, "stripe_test_adminorder"); assert.equal(only.json.rows[0].test, true);
    const std = await api(env, "GET", `/compare/admin/ledger?month=${month}`, { origin: "", headers: A });
    assert.ok(std.json.rows.every((r) => r.source !== "stripe_test_adminorder" && r.test === false));
  } finally { f.restore(); }
});

test("byggfel: raderad rapport vid sändning ⇒ ingen sändning, mejlet stoppas (bilaga_kunde_inte_byggas); omförsök med 500 ger EXAKT samma payload/nyckel (deterministisk PDF)", async () => {
  const f = installFetch(); try {
    // (a) omförsök: första svaret 500 (okänt utfall), sedan ok – samma begäran byte för byte
    const env = mk(); f.ctl.mailMode = "ok";
    const c = await api(env, "POST", "/compare/admin/test-order", { origin: "", headers: A }); const { orderId, token } = c.json;
    for (let i = 0; i < 2; i++) await upload(env, orderId, token, i, S(100000 + i * 10000));
    await api(env, "POST", `/compare/admin/test-order/${orderId}/checkout`, { origin: "", headers: A, body: { token } });
    await testHook(env, paidSession([...f.sessions.values()].pop()), orderId.slice(2, 10));
    await env.COMPARE_ORDERS.runAlarms(1); await flushMailEvents(env, f);
    f.ctl.mailMode = "500"; await env.COMPARE_ORDERS.runAlarms(5);
    assert.equal(store(env, orderId).get("order").status, "delivered"); assert.equal(reportMails(f).length, 0, "500 ⇒ inget accepterat");
    const tries1 = f.log.mail.filter((m) => m.idem === `mail-mail_rapport_${orderId}`); assert.ok(tries1.length >= 1);
    f.ctl.mailMode = "ok"; const k = `outbox:mail_rapport_${orderId}`; const st = store(env, orderId); st.set(k, { ...st.get(k), nextAt: 0, leaseUntil: null });
    await env.COMPARE_ORDERS.runAlarms(5);
    const all = f.log.mail.filter((m) => m.idem === `mail-mail_rapport_${orderId}`); assert.ok(all.length >= 2);
    for (const x of all) assert.deepEqual(x.body, all[0].body, "samma begäran inkl. PDF-bilagor vid omförsök");
    assert.equal(reportMails(f).length, 1);
  } finally { f.restore(); }
});

test("byggfel: rapporten raderad före sändning ⇒ ingen HTTP-sändning, mejlet stoppas utan sändning", async () => {
  const g = installFetch(); try {
    const env2 = mk(); const t2 = await deliverTestOrder(env2, g, { noReportMail: true });
    const o2 = store(env2, t2.orderId).get("order"); await env2.REVIEWS_KV.delete(o2.reportKey);
    const q = await api(env2, "POST", `/compare/admin/test-order/${t2.orderId}/report-mail`, { origin: "", headers: A });
    const n0 = g.log.mail.length; await env2.COMPARE_ORDERS.runAlarms(5);
    assert.equal(g.log.mail.length, n0, "ingen HTTP-sändning utan rapportunderlag"); assert.equal(reportMails(g).length, 0);
    const ob = store(env2, t2.orderId).get(`outbox:mail_rapport_${t2.orderId}`);
    assert.ok(q.status !== 200 || (ob && ["failed", "avstamning"].includes(ob.state) && ob.lastError === "bilaga_kunde_inte_byggas"), JSON.stringify([q.status, ob && ob.state, ob && ob.lastError]));
  } finally { g.restore(); }
});

test("backfill: gammal levererad order utan rapportmejl + giltig FULL ordertoken på status-GET ⇒ EN mejlpost; fel token/resultattoken/oautentiserad ⇒ ingen; upprepat ⇒ ingen dubblett", async () => {
  const f = installFetch(); try {
    const env = mk(); const { orderId, token } = await deliverTestOrder(env, f, { noReportMail: true });
    const key = `outbox:mail_rapport_${orderId}`; assert.equal(store(env, orderId).get("order").status, "delivered"); assert.equal(store(env, orderId).get(key), undefined);
    // fel/oautentiserad token ⇒ ingen backfill
    assert.equal((await api(env, "GET", `/compare/orders/${orderId}`, { token: "x".repeat(32) })).status, 404);
    assert.equal((await api(env, "GET", `/compare/orders/${orderId}`, {})).status, 404);
    assert.equal(store(env, orderId).get(key), undefined, "ingen backfill utan giltig token");
    // full token ⇒ EN post
    assert.equal((await api(env, "GET", `/compare/orders/${orderId}`, { token })).status, 200);
    const ob = store(env, orderId).get(key); assert.ok(ob && ob.state === "queued"); assert.equal(ob.to, TEST_CHAIN_TO);
    // resultattoken ur den köade posten får inte kunna trigga något (och gäller bara rapportläsning)
    const rt = LINK.exec(ob.secrets.RAPPORTLANK)[2];
    assert.equal((await api(env, "GET", `/compare/orders/${orderId}`, { token: rt })).status, 404);
    // upprepad läsning ⇒ ingen dubblett
    for (let i = 0; i < 3; i++) assert.equal((await api(env, "GET", `/compare/orders/${orderId}`, { token })).status, 200);
    await env.COMPARE_ORDERS.runAlarms(5);
    assert.equal(reportMails(f).length, 1, "exakt ett rapportmejl"); assert.deepEqual([].concat(reportMails(f)[0].body.to), [TEST_CHAIN_TO]);
    assert.equal((await api(env, "GET", `/compare/orders/${orderId}`, { token })).status, 200); await env.COMPARE_ORDERS.runAlarms(2);
    assert.equal(reportMails(f).length, 1, "fortsatt ett");
    // efter retention: ingen backfill
    const g = await deliverTestOrder(env, f, { noReportMail: true });
    const real = Date.now; Date.now = () => real() + 25 * 3600_000;
    try { await api(env, "GET", `/compare/orders/${g.orderId}`, { token: g.token }); assert.equal(store(env, g.orderId).get(`outbox:mail_rapport_${g.orderId}`), undefined, "utgången ⇒ ingen backfill"); } finally { Date.now = real; }
  } finally { f.restore(); }
});
