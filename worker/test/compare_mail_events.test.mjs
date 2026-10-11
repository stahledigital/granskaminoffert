// D14 (offline): signerad Resend-eventadapter + beständig provider-ID→order/mejl-koppling. TRANSPORTACCEPT (HTTP 2xx) ≠ LEVERANS TILL MOTTAGARENS MAILSERVER ≠ INKORG.
// Allt mot HTTP-dubbel och SYNTETISKA fixturer: ingen Resend/Stripe/modell, ingen riktig hemlighet, ingen sändning. Dubbeln är inget bevis för Cloudflare-drift eller riktig leverantör.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyResendWebhook, normalizeMailEvent, signResendForTest, mailEventsConfig, parseMailId, deriveDeliveryState, MAIL_EVENT_MAX_BYTES } from "../src/compare_mailer.js";
import { makeEnv, installFetch, api, readyOrder, startCheckout, paidSession, webhook, MAIL_WH_SECRET, mailEvent, flushMailEvents } from "./helpers/compare_env.mjs";

const KEY = "re_TESTONLY_syntheticKey0123456789";
const ON = { COMPARE_MAILER_MODE: undefined, COMPARE_MAIL_HTTP: "1", COMPARE_MAIL_HTTP_VERIFIED: "1", COMPARE_MAIL_FROM: "Jämför <jamfor@example.test>", COMPARE_MAIL_DAY_CAP: "20", COMPARE_MAIL_API_KEY: KEY, COMPARE_MAIL_WEBHOOK_SECRET: MAIL_WH_SECRET };
const SELLER = { COMPARE_SELLER_FORM: "AB", COMPARE_SELLER_NAME: "Syntetisk Säljare AB", COMPARE_SELLER_ORGNR: "556000-0001", COMPARE_SELLER_EMAIL: "kontakt@example.test", COMPARE_SELLER_ADDRESS: "Exempelgatan 1, 111 11 Teststad", COMPARE_SELLER_PHONE: "+46 8 000 00 00", COMPARE_COMPANY_INFO_URL: "https://example.test/foretagsuppgifter" };
const S = (t) => ({ extracted: { totalBeforeRotSek: t, totalVatBasis: "inkl" }, scope: { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" } });
const mk = (extra = {}) => makeEnv({ ...SELLER, ...ON, ...extra });
const store = (env, id) => env.COMPARE_ORDERS.peek(id).store;
const mailOf = (env, id) => store(env, id).get(`outbox:mail_avtal_${id}`);
const ordOf = (env, id) => store(env, id).get("order");
const withClock = async (offsetMs, fn) => { const real = Date.now; Date.now = () => real() + offsetMs; try { return await fn(); } finally { Date.now = real; } };
const tagOf = (orderId) => "mail_avtal_" + orderId;
async function pay(env, f, extra = {}) {
  const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
  assert.equal((await startCheckout(env, orderId, token)).status, 200);
  assert.equal((await webhook(env, "checkout.session.completed", paidSession([...f.sessions.values()].pop()))).status, 200);
  await env.COMPARE_ORDERS.runAlarms(1);
  return { orderId, token, sent: f.log.mailSent.at(-1) };
}
const ev = (env, o, type, over = {}) => mailEvent(env, type, { emailId: o.sent.id, to: o.sent.body.to, mailId: tagOf(o.orderId), ...over });

// ---------- verifiering: rå kropp, signatur, tid ----------
test("verifyResendWebhook: giltig signatur ok; ändrad råbody, fel hemlighet, gammal/framtida tid, saknade eller felformade headers, fel version avvisas", async () => {
  const body = JSON.stringify({ type: "email.delivered", data: {} });
  const good = await signResendForTest(body, MAIL_WH_SECRET, { id: "msg_unit0001" });
  const H = (o) => new Headers(o);
  assert.equal((await verifyResendWebhook(body, H(good), MAIL_WH_SECRET)).ok, true);
  assert.equal((await verifyResendWebhook(body + " ", H(good), MAIL_WH_SECRET)).reason, "signatur", "en byte ändrad råbody");
  assert.equal((await verifyResendWebhook(JSON.stringify(JSON.parse(body)), H(good), MAIL_WH_SECRET)).ok, true, "omserialisering som blir samma bytes är samma kropp");
  assert.equal((await verifyResendWebhook(body, H(good), "whsec_" + btoa("ANNAN-syntetisk-hemlighet-0123456789abcdef"))).reason, "signatur");
  const old = await signResendForTest(body, MAIL_WH_SECRET, { id: "msg_unit0002", ts: Math.floor(Date.now() / 1000) - 301 });
  assert.equal((await verifyResendWebhook(body, H(old), MAIL_WH_SECRET)).reason, "tid");
  const fut = await signResendForTest(body, MAIL_WH_SECRET, { id: "msg_unit0003", ts: Math.floor(Date.now() / 1000) + 301 });
  assert.equal((await verifyResendWebhook(body, H(fut), MAIL_WH_SECRET)).reason, "tid");
  const edge = await signResendForTest(body, MAIL_WH_SECRET, { id: "msg_unit0004", ts: Math.floor(Date.now() / 1000) - 299 });
  assert.equal((await verifyResendWebhook(body, H(edge), MAIL_WH_SECRET)).ok, true, "inom 5 min");
  for (const drop of ["svix-id", "svix-timestamp", "svix-signature"]) { const h = { ...good }; delete h[drop]; assert.equal((await verifyResendWebhook(body, H(h), MAIL_WH_SECRET)).reason, "saknas", drop); }
  assert.equal((await verifyResendWebhook(body, H({ ...good, "svix-id": "msg med mellanslag" }), MAIL_WH_SECRET)).reason, "format");
  assert.equal((await verifyResendWebhook(body, H({ ...good, "svix-timestamp": "12ab" }), MAIL_WH_SECRET)).reason, "format");
  assert.equal((await verifyResendWebhook(body, H({ ...good, "svix-signature": good["svix-signature"].replace("v1,", "v2,") }), MAIL_WH_SECRET)).reason, "format", "bara v1 räknas");
  const sig = good["svix-signature"];
  assert.equal((await verifyResendWebhook(body, H({ ...good, "svix-signature": "v1,AAAA " + sig }), MAIL_WH_SECRET)).ok, true, "flera signaturer: en giltig räcker");
  assert.equal((await verifyResendWebhook(body, H({ ...good, "svix-signature": "v1,AAAA v1,BBBB" }), MAIL_WH_SECRET)).reason, "signatur");
  assert.equal((await verifyResendWebhook(body, H(good), "")).reason, "saknas");
  assert.equal((await verifyResendWebhook(body, H(good), "inte_whsec")).reason, "hemlighet");
  const notJson = "inte json"; const h2 = await signResendForTest(notJson, MAIL_WH_SECRET, { id: "msg_unit0005" });
  assert.equal((await verifyResendWebhook(notJson, H(h2), MAIL_WH_SECRET)).reason, "json", "giltig signatur men ingen tolkbar händelse");
  assert.equal(mailEventsConfig({ COMPARE_MAIL_WEBHOOK_SECRET: MAIL_WH_SECRET }).on, true);
  for (const bad of [undefined, "", "whsec_", "whsec_kort", "re_inte_hemlighet", "whsec_!!!!!!!!!!!!!!!!!!!!!!"]) assert.equal(mailEventsConfig({ COMPARE_MAIL_WEBHOOK_SECRET: bad }).on, false, String(bad));
});

test("normalizeMailEvent: klasser, sanering (inget ämne/avsändare/brödtext/diagnostik), okända och ointressanta typer ignoreras, felformade avvisas", () => {
  const d = (over = {}) => ({ type: "email.bounced", created_at: "2026-10-11T10:00:00.000Z", data: { email_id: "56761188-7520-42d8-8898-ff6fc54ce618", from: "X <x@example.test>", to: ["Kund@Example.test"], subject: "HEMLIGT ÄMNE", tags: { gmo_mail: "mail_avtal_o_" + "a".repeat(32) }, bounce: { type: "Permanent", message: "SECRET DIAGNOSTIK", subType: "x", diagnosticCode: ["z"] }, text: "BRÖDTEXT", ...over } });
  const n = normalizeMailEvent(d());
  assert.deepEqual(Object.keys(n).sort(), ["bounceType", "cls", "emailId", "ok", "providerAt", "tag", "to"]);
  assert.equal(n.cls, "bounced"); assert.deepEqual(n.to, ["kund@example.test"]); assert.equal(n.bounceType, "Permanent"); assert.equal(n.tag, "mail_avtal_o_" + "a".repeat(32));
  assert.doesNotMatch(JSON.stringify(n), /HEMLIGT|SECRET|BRÖDTEXT|x@example/);
  const map = { "email.sent": "accepted", "email.delivered": "delivered", "email.delivery_delayed": "delayed", "email.bounced": "bounced", "email.failed": "failed", "email.suppressed": "suppressed", "email.complained": "complained" };
  for (const [t, c] of Object.entries(map)) assert.equal(normalizeMailEvent({ ...d(), type: t }).cls, c, t);
  for (const t of ["email.opened", "email.clicked", "email.received", "email.scheduled", "email.nyhet"]) assert.equal(normalizeMailEvent({ ...d(), type: t }).ignore, "typ_ignorerad", t);
  assert.equal(normalizeMailEvent({ type: "domain.updated", data: {} }).ignore, "typ_okand");
  assert.equal(normalizeMailEvent({ ...d(), data: null }).ok, false);
  assert.equal(normalizeMailEvent(d({ email_id: "x" })).reason, "email_id");
  assert.equal(normalizeMailEvent(d({ to: [] })).reason, "to"); assert.equal(normalizeMailEvent(d({ to: "kund@example.test" })).reason, "to");
  assert.equal(normalizeMailEvent(d({ tags: [{ name: "gmo_mail", value: "mail_avtal_o_" + "b".repeat(32) }] })).tag, "mail_avtal_o_" + "b".repeat(32), "tagg som lista accepteras");
  assert.equal(normalizeMailEvent(d({ tags: { gmo_mail: "../../fel" } })).tag, null, "ogiltig tagg ⇒ ingen tagg");
  assert.equal(normalizeMailEvent(d({ bounce: { type: "Annat" } })).bounceType, null);
  assert.equal(parseMailId("mail_angrakvitto_o_" + "c".repeat(32)).kind, "angrakvitto"); assert.equal(parseMailId("mail_x_o_" + "c".repeat(32)), null);
});

test("deriveDeliveryState är ordningsoberoende: negativ gäller över delivered, delivered över delayed över accepted", () => {
  const perms = (a) => a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]));
  const run = (cls) => { const seen = {}; cls.forEach((c, i) => { if (!Number.isFinite(seen[c])) seen[c] = i + 1; }); return deriveDeliveryState(seen); };
  for (const p of perms(["accepted", "delayed", "delivered"])) assert.equal(run(p), "delivered", p.join());
  for (const p of perms(["accepted", "delayed"])) assert.equal(run(p), "delayed");
  for (const neg of ["bounced", "failed", "suppressed"]) for (const p of perms(["accepted", "delivered", neg])) assert.equal(run(p), neg, p.join());
  assert.equal(run([]), "none");
});

// ---------- rutten ----------
test("rutten: stängd utan hemlighet (503), POST krävs, för stor kropp 413, ogiltig signatur 400 utan ändring", async () => {
  const f = installFetch();
  try {
    const closed = makeEnv({ ...SELLER, COMPARE_MAILER_MODE: "mock" });
    assert.equal((await mailEvent(closed, "email.delivered", { emailId: "e".repeat(12), to: "a@b.se" })).status, 503);
    const env = mk(); const o = await pay(env, f);
    assert.equal((await api(env, "GET", "/compare/mail-events")).status, 404);
    const r1 = await ev(env, o, "email.delivered", { tamper: true }); assert.equal(r1.status, 400);
    assert.equal(mailOf(env, o.orderId).delivery, undefined, "ogiltig signatur ändrar ingenting");
    assert.equal((await ev(env, o, "email.delivered", { secret: "whsec_" + btoa("ANNAN-syntetisk-hemlighet-0123456789abcdef") })).status, 400);
    assert.equal((await ev(env, o, "email.delivered", { ts: Math.floor(Date.now() / 1000) - 400 })).status, 400);
    assert.equal((await ev(env, o, "email.delivered", { drop: ["svix-signature"] })).status, 400);
    assert.equal((await ev(env, o, "email.delivered", { rawOverride: " ".repeat(MAIL_EVENT_MAX_BYTES + 5) })).status, 413);
    assert.equal(mailOf(env, o.orderId).delivery, undefined);
    assert.equal(ordOf(env, o.orderId).status, "paid"); assert.equal(f.log.anthropic.length, 0);
  } finally { f.restore(); }
});

// ---------- grinden: accept ≠ leverans ----------
test("HTTP-accept (sent) öppnar INTE startgrinden: ingen räkning, ingen generation; först signerad delivered för samma provider-ID startar jobbet", async () => {
  const f = installFetch();
  try {
    const env = mk(); const o = await pay(env, f); const c0 = f.log.count.length;
    const m = mailOf(env, o.orderId);
    assert.equal(m.state, "sent"); assert.equal(m.transport, "http"); assert.equal(m.providerRef, o.sent.id);
    await env.COMPARE_ORDERS.runAlarms(3);
    assert.equal(f.log.anthropic.length, 0); assert.equal(f.log.count.length, c0); assert.equal(ordOf(env, o.orderId).status, "paid"); assert.equal(ordOf(env, o.orderId).work.waiting, "avtalsbekraftelse");
    const sent = await ev(env, o, "email.sent"); assert.equal(sent.status, 200);
    await env.COMPARE_ORDERS.runAlarms(2); assert.equal(f.log.anthropic.length, 0, "email.sent är bara API-accept");
    assert.equal((await ev(env, o, "email.delivery_delayed")).status, 200);
    await env.COMPARE_ORDERS.runAlarms(2); assert.equal(f.log.anthropic.length, 0, "delayed ⇒ fortsatt väntan");
    assert.equal(mailOf(env, o.orderId).delivery.state, "delayed");
    const d = await ev(env, o, "email.delivered"); assert.equal(d.status, 200); assert.equal(d.json.state, "delivered");
    await env.COMPARE_ORDERS.runAlarms(5);
    assert.ok(f.log.anthropic.length > 0, "nu startade jobbet");
    const mm = mailOf(env, o.orderId); assert.equal(mm.delivery.state, "delivered"); assert.equal(mm.delivery.emailId, o.sent.id);
    assert.ok(mm.sentAt <= mm.delivery.at, "accept före leverans");
    assert.equal(f.log.mailSent.length, 1, "inget andra mejl");
  } finally { f.restore(); }
});

test("event FÖRE HTTP-ack (förlorad kvittens): bundet via tagg, buffras, binds vid ack till samma provider-ID och startar först då; fel provider-ID i bufferten räknas aldrig", async () => {
  const g = installFetch();
  try {
    const env = mk(); g.ctl.mailModes = ["timeout_after_accept"];
    const o = await pay(env, g); // leverantören har accepterat, kvittensen är förlorad
    assert.equal(g.log.mailSent.length, 1); assert.equal(mailOf(env, o.orderId).state, "queued"); assert.equal(mailOf(env, o.orderId).providerRef, null);
    const providerId = g.log.mailSent[0].id;
    const early = await mailEvent(env, "email.delivered", { emailId: providerId, to: g.log.mailSent[0].body.to, mailId: tagOf(o.orderId) });
    assert.equal(early.status, 200); assert.equal(early.json.state, "tidig");
    assert.equal(mailOf(env, o.orderId).delivery, undefined, "ingen leverans räknas utan kvitterat provider-ID");
    await env.COMPARE_ORDERS.runAlarms(1); assert.equal(g.log.anthropic.length, 0, "event före ack öppnar inte grinden");
    const reset = () => { const st = store(env, o.orderId); const k = `outbox:mail_avtal_${o.orderId}`; st.set(k, { ...st.get(k), nextAt: 0, leaseUntil: null }); };
    reset(); await env.COMPARE_ORDERS.runAlarms(1); // omförsök med samma nyckel ⇒ ursprungligt ID ⇒ ack
    const m = mailOf(env, o.orderId);
    assert.equal(m.state, "sent"); assert.equal(m.providerRef, providerId); assert.equal(m.delivery.state, "delivered"); assert.equal(m.early, null);
    await env.COMPARE_ORDERS.runAlarms(5); assert.ok(g.log.anthropic.length > 0);
    assert.equal(g.log.mailSent.length, 1, "aldrig en andra sändning");
    assert.ok(store(env, o.orderId).get(`mailref:${providerId}`), "beständig koppling provider-ID → mejl");
  } finally { g.restore(); }
  const h = installFetch();
  try {
    const env = mk(); h.ctl.mailModes = ["timeout_after_accept"];
    const o = await pay(env, h);
    const r = await mailEvent(env, "email.delivered", { emailId: "FEL-provider-id-0001", to: h.log.mailSent[0].body.to, mailId: tagOf(o.orderId) }); assert.equal(r.status, 200);
    const reset = () => { const st = store(env, o.orderId); const k = `outbox:mail_avtal_${o.orderId}`; st.set(k, { ...st.get(k), nextAt: 0, leaseUntil: null }); };
    reset(); await env.COMPARE_ORDERS.runAlarms(2);
    const m = mailOf(env, o.orderId);
    assert.equal(m.state, "sent"); assert.notEqual(m.delivery && m.delivery.state, "delivered"); assert.ok(m.anoms.some((a) => a.code === "fel_provider_id_tidig"));
    await env.COMPARE_ORDERS.runAlarms(3); assert.equal(h.log.anthropic.length, 0, "tidig händelse för annat provider-ID bevisar inget");
  } finally { h.restore(); }
});

// ---------- negativa lägen: gen0 + återbetalning ----------
for (const [type, bounce] of [["email.bounced", { type: "Permanent", message: "x", subType: "General" }], ["email.failed"], ["email.suppressed"]]) {
  test(`${type} före start ⇒ generation 0 och orden avbryts med återbetalningsstatus 'needed' (manuellt läge) – aldrig påstådd refund`, async () => {
    const f = installFetch();
    try {
      const env = mk(); const o = await pay(env, f); const c0 = f.log.count.length;
      assert.equal((await ev(env, o, type, { bounce })).status, 200);
      await env.COMPARE_ORDERS.runAlarms(5);
      const ord = ordOf(env, o.orderId);
      assert.equal(ord.status, "failed"); assert.equal(ord.work.error, "bekraftelse_ej_levererad"); assert.equal(ord.refund.state, "needed");
      assert.equal(f.log.anthropic.length, 0); assert.equal(f.log.count.length, c0, "ingen modellräkning"); assert.equal(f.log.refunds.length, 0, "manuellt läge: inget refundanrop");
      const v = (await api(env, "GET", `/compare/orders/${o.orderId}`, { token: o.token })).json.order; assert.equal(v.error, "bekraftelse_ej_levererad"); assert.equal(v.refund.state, "needed");
    } finally { f.restore(); }
  });
}
test("automatiskt refundläge: negativ leverans ⇒ refund begärs EN gång; 'pending' från leverantören visas som pending, aldrig som genomförd", async () => {
  const f = installFetch();
  try {
    const env = mk({ COMPARE_AUTO_REFUND: "1" }); f.ctl.refundStatus = "pending"; const o = await pay(env, f);
    await ev(env, o, "email.bounced", { bounce: { type: "Permanent" } }); await env.COMPARE_ORDERS.runAlarms(5);
    const ord = ordOf(env, o.orderId); assert.equal(ord.status, "failed"); assert.equal(f.log.refunds.length, 1); assert.equal(ord.refund.state, "pending"); assert.notEqual(ord.refund.state, "done");
    assert.equal(f.log.anthropic.length, 0);
  } finally { f.restore(); }
});
test("delayed utan leverans / bara 'sent' / ingen händelse alls ⇒ väntar, och efter tidsgränsen: gen 0 + återbetalning (okänd leverans är inte bevis)", async () => {
  for (const events of [["email.delivery_delayed"], ["email.sent"], []]) {
    const f = installFetch();
    try {
      const env = mk(); const o = await pay(env, f);
      for (const t of events) await ev(env, o, t);
      await env.COMPARE_ORDERS.runAlarms(3); assert.equal(ordOf(env, o.orderId).status, "paid", events.join());
      await withClock(31 * 60_000, async () => { await env.COMPARE_ORDERS.runAlarms(3); });
      const ord = ordOf(env, o.orderId); assert.equal(ord.status, "failed", events.join()); assert.equal(ord.work.error, "bekraftelse_ej_levererad"); assert.equal(ord.refund.state, "needed");
      assert.equal(f.log.anthropic.length, 0);
    } finally { f.restore(); }
  }
});
test("leverans som kommer EFTER att ordern redan avbrutits ändrar inte orderstatus och startar ingen generation", async () => {
  const f = installFetch();
  try {
    const env = mk(); const o = await pay(env, f);
    await withClock(31 * 60_000, async () => { await env.COMPARE_ORDERS.runAlarms(3); });
    assert.equal(ordOf(env, o.orderId).status, "failed");
    assert.equal((await ev(env, o, "email.delivered")).status, 200);
    await env.COMPARE_ORDERS.runAlarms(3);
    assert.equal(ordOf(env, o.orderId).status, "failed"); assert.equal(f.log.anthropic.length, 0); assert.equal(ordOf(env, o.orderId).refund.state, "needed");
  } finally { f.restore(); }
});

// ---------- ordning, dubbletter, omstart ----------
test("omvänd/blandad ordning: delayed efter delivered, sent efter delivered ändrar inte; bounce+delivered i valfri ordning före start ⇒ motsägelse ⇒ ingen start", async () => {
  const f = installFetch();
  try {
    const env = mk(); const o = await pay(env, f);
    await ev(env, o, "email.delivered"); await ev(env, o, "email.delivery_delayed"); await ev(env, o, "email.sent");
    assert.equal(mailOf(env, o.orderId).delivery.state, "delivered");
    await env.COMPARE_ORDERS.runAlarms(5); assert.ok(f.log.anthropic.length > 0);
  } finally { f.restore(); }
  for (const order of [["email.delivered", "email.bounced"], ["email.bounced", "email.delivered"]]) {
    const g = installFetch();
    try {
      const env = mk(); const o = await pay(env, g);
      for (const t of order) await ev(env, o, t, { bounce: { type: "Permanent" } });
      const dl = mailOf(env, o.orderId).delivery; assert.equal(dl.state, "bounced"); assert.equal(dl.contradiction, true);
      await env.COMPARE_ORDERS.runAlarms(5);
      assert.equal(ordOf(env, o.orderId).status, "failed", order.join()); assert.equal(g.log.anthropic.length, 0);
    } finally { g.restore(); }
  }
});
test("deduplicering: samma svix-id två gånger, samma händelse med nytt svix-id, flera delivered; efter 'omstart' (lagringen kvar) fortsatt EN övergång", async () => {
  const f = installFetch();
  try {
    const env = mk(); const o = await pay(env, f);
    const a = await ev(env, o, "email.delivered", { id: "msg_DEDUP0000001" }); assert.equal(a.json.dup, undefined);
    const at = mailOf(env, o.orderId).delivery.at;
    const b = await ev(env, o, "email.delivered", { id: "msg_DEDUP0000001" }); assert.equal(b.status, 200); assert.equal(b.json.dup, true);
    const c = await ev(env, o, "email.delivered", { id: "msg_DEDUP0000002" }); assert.equal(c.status, 200);
    assert.equal(mailOf(env, o.orderId).delivery.at, at, "första leveranstiden ligger fast"); assert.equal(mailOf(env, o.orderId).eventIds.length, 2);
    await env.COMPARE_ORDERS.runAlarms(5); const gen = f.log.anthropic.length; assert.ok(gen > 0);
    const confirmation = structuredClone(ordOf(env, o.orderId).accept.confirmation || null);
    const d = await ev(env, o, "email.delivered", { id: "msg_DEDUP0000001" }); assert.equal(d.json.dup, true);
    await env.COMPARE_ORDERS.runAlarms(5); assert.equal(f.log.anthropic.length, gen, "ingen ny generation"); assert.deepEqual(ordOf(env, o.orderId).accept.confirmation || null, confirmation);
    assert.equal(f.log.mailSent.length, 1);
  } finally { f.restore(); }
});

// ---------- fel koppling ----------
test("fel mottagare, fel provider-ID efter ack, fel order, okänd order, ogiltig/saknad tagg, tagg≠index ⇒ ignoreras utan bevis; varje avvisning lämnar bara en anomalikod", async () => {
  const f = installFetch();
  try {
    const env = mk(); const o = await pay(env, f); const o2 = await pay(env, f);
    const m0 = () => mailOf(env, o.orderId);
    const wrongTo = await ev(env, o, "email.delivered", { to: ["annan@example.test"] }); assert.equal(wrongTo.json.ignored, "fel_mottagare");
    const multi = await ev(env, o, "email.delivered", { to: [o.sent.body.to[0], "extra@example.test"] }); assert.equal(multi.json.ignored, "fel_mottagare");
    const wrongId = await ev(env, o, "email.delivered", { emailId: "FEL-provider-id-0002" }); assert.equal(wrongId.json.ignored, "fel_provider_id");
    assert.equal(m0().delivery, undefined); assert.deepEqual(m0().anoms.map((a) => a.code), ["fel_mottagare", "fel_mottagare", "fel_provider_id"]);
    // order 2:s provider-ID med order 1:s tagg ⇒ fel provider-ID hos order 1
    const cross = await mailEvent(env, "email.delivered", { emailId: o2.sent.id, to: o2.sent.body.to, mailId: tagOf(o.orderId) }); assert.equal(cross.json.ignored, "koppling_motstrider", "indexet säger order 2, taggen order 1");
    assert.equal(m0().delivery, undefined); assert.equal(mailOf(env, o2.orderId).delivery, undefined);
    // okänd order med giltigt tagg-format
    const ghost = await mailEvent(env, "email.delivered", { emailId: "UNKNOWN-id-123456", to: "a@b.se", mailId: "mail_avtal_o_" + "9".repeat(32) }); assert.equal(ghost.status, 200); assert.equal(ghost.json.ignored, "okand_order");
    // ingen tagg och okänt ID ⇒ ingen koppling
    const none = await mailEvent(env, "email.delivered", { emailId: "UNKNOWN-id-123457", to: "a@b.se", tags: {} }); assert.equal(none.json.ignored, "ingen_koppling");
    const badTag = await mailEvent(env, "email.delivered", { emailId: "UNKNOWN-id-123458", to: "a@b.se", tags: { gmo_mail: "../x" } }); assert.equal(badTag.json.ignored, "ingen_koppling");
    // tagg för ett mejl som aldrig skickats på detta ID
    await env.COMPARE_ORDERS.runAlarms(3); assert.equal(f.log.anthropic.length, 0, "inget av detta är leveransbevis");
    // taggfri händelse med känt provider-ID når rätt mejl via det beständiga indexet
    const viaIndex = await mailEvent(env, "email.delivered", { emailId: o.sent.id, to: o.sent.body.to, tags: {} }); assert.equal(viaIndex.status, 200); assert.equal(viaIndex.json.state, "delivered");
    await env.COMPARE_ORDERS.runAlarms(5); assert.ok(f.log.anthropic.length > 0);
    assert.equal(mailOf(env, o2.orderId).delivery, undefined, "order 2 opåverkad");
  } finally { f.restore(); }
});
test("mock/adapter (uttryckliga offlineprov) oförändrade: 'sent' öppnar grinden; leveranshändelse mot ett mock-mejl ignoreras som inte_http", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({ ...SELLER, COMPARE_MAILER_MODE: "mock", COMPARE_MAIL_WEBHOOK_SECRET: MAIL_WH_SECRET });
    const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]); await startCheckout(env, orderId, token);
    await webhook(env, "checkout.session.completed", paidSession([...f.sessions.values()].pop())); await env.COMPARE_ORDERS.runAlarms(5);
    assert.equal(ordOf(env, orderId).status, "delivered"); assert.equal(mailOf(env, orderId).transport, "mock");
    const to = mailOf(env, orderId).to;
    const r = await mailEvent(env, "email.bounced", { emailId: mailOf(env, orderId).providerRef.replace(":", "-").padEnd(12, "x"), to, mailId: tagOf(orderId) });
    assert.equal(r.status, 200); assert.equal(r.json.ignored, "inte_http"); assert.equal(mailOf(env, orderId).delivery, undefined);
    assert.equal(ordOf(env, orderId).status, "delivered");
  } finally { f.restore(); }
});

// ---------- minimering och läckor ----------
test("lagring/loggar/offentliga svar exponerar varken ämne, brödtext, avsändare, bounce-diagnostik, hemligheter eller offerttext", async () => {
  const f = installFetch(); const logged = []; const orig = { ...console }; for (const k of ["log", "warn", "error", "info"]) console[k] = (...a) => logged.push(a.map(String).join(" "));
  try {
    const env = mk(); const o = await pay(env, f);
    await ev(env, o, "email.bounced", { bounce: { type: "Permanent", message: "SECRET DIAGNOSTIK för kund@example.test", diagnosticCode: ["550 5.1.1 HEMLIG"] }, extra: { text: "HEMLIG BRÖDTEXT", html: "<p>HEMLIG</p>" } });
    const dump = JSON.stringify([...store(env, o.orderId)]) + logged.join("\n") + JSON.stringify((await api(env, "GET", `/compare/orders/${o.orderId}`, { token: o.token })).json);
    for (const bad of ["SYNTETISKT ÄMNE", "SECRET DIAGNOSTIK", "HEMLIG", "EVENT-AVSÄNDARE", MAIL_WH_SECRET, KEY]) assert.ok(!dump.includes(bad), bad);
    const dl = mailOf(env, o.orderId).delivery;
    assert.deepEqual(Object.keys(dl).sort(), ["at", "bounceType", "contradiction", "emailId", "providerAt", "seen", "state"]);
  } finally { Object.assign(console, orig); f.restore(); }
});

// ---------- P: bekräftelsebeviset och sen studs ----------
test("policy P: bekräftelsen bär deliveredAt; en STUDS efter start gör att bekräftelsen inte längre räknas (ångerrätt kvar, ingen 'fullgjord'); neutral rapport kräver giltig levererad bekräftelse", async () => {
  const f = installFetch();
  try {
    const env = mk({ COMPARE_CONSENT_POLICY: "P" }); const o = await pay(env, f);
    await ev(env, o, "email.delivered"); await env.COMPARE_ORDERS.runAlarms(8);
    const ord = ordOf(env, o.orderId); assert.equal(ord.status, "delivered");
    const c = ord.accept.confirmation; assert.equal(c.mailId, tagOf(o.orderId)); assert.equal(c.deliveredAt, mailOf(env, o.orderId).delivery.at); assert.ok(c.sentAt <= c.deliveredAt && c.deliveredAt <= ord.work.startedAt);
    const rights1 = (await api(env, "GET", `/compare/orders/${o.orderId}`, { token: o.token })).json.order;
    // sen studs (event kommer efter start och leverans)
    assert.equal((await ev(env, o, "email.bounced", { bounce: { type: "Permanent" } })).status, 200);
    const m = mailOf(env, o.orderId); assert.equal(m.delivery.state, "bounced"); assert.equal(m.delivery.contradiction, true);
    const after = (await api(env, "GET", `/compare/orders/${o.orderId}`, { token: o.token })).json.order;
    assert.notEqual(after.agreement && after.agreement.rights && after.agreement.rights.angerratt, "upphord", "motsagd leverans ⇒ rätten kan inte ha upphört");
    assert.equal(ordOf(env, o.orderId).status, "delivered", "levererad rapport rivs inte upp i efterhand");
    assert.ok(rights1);
  } finally { f.restore(); }
});

// ---------- admin/avstämning ----------
test("ledgerexport visar transportaccept och leveransläge separat och säger uttryckligen inboxProof:false", async () => {
  const f = installFetch();
  try {
    const env = mk({ COMPARE_ADMIN_TOKEN: "a".repeat(32) }); const o = await pay(env, f);
    await ev(env, o, "email.delivered"); await env.COMPARE_ORDERS.runAlarms(3);
    const month = new Date().toISOString().slice(0, 7);
    const r = await api(env, "GET", `/compare/admin/ledger?month=${month}`, { headers: { authorization: "Bearer " + "a".repeat(32) }, origin: "" });
    assert.equal(r.status, 200); const row = r.json.rows.find((x) => x.orderId === o.orderId);
    assert.deepEqual(row.confirmationMail, { transport: "http", accepted: true, delivery: "delivered", inboxProof: false });
  } finally { f.restore(); }
});

// ======================= D14-fix: monotont tidigt bevis + beständigt städunderlag =======================
const resetMail = (env, id) => { const st = store(env, id); const k = `outbox:mail_avtal_${id}`; st.set(k, { ...st.get(k), nextAt: 0, leaseUntil: null }); };

test("rootens oberoende repro: förlorad ack, signerad bounced FÖRST, sedan 9 email.sent med olika svix-id, sedan delivered – allt före ack ⇒ bounce tappas inte ⇒ 0 generationer, ordern misslyckas", async () => {
  const f = installFetch();
  try {
    const env = mk(); f.ctl.mailModes = ["timeout_after_accept"];
    const o = await pay(env, f); const pid = f.log.mailSent[0].id; const to = f.log.mailSent[0].body.to;
    const post = (t, extra = {}) => mailEvent(env, t, { emailId: pid, to, mailId: tagOf(o.orderId), ...extra });
    assert.equal((await post("email.bounced", { bounce: { type: "Permanent" } })).json.state, "tidig");
    for (let i = 0; i < 9; i++) assert.equal((await post("email.sent", { id: "msg_FLOOD000" + i })).status, 200);
    assert.equal((await post("email.delivered")).status, 200);
    const early = mailOf(env, o.orderId).early;
    assert.ok(Number.isFinite(early.ids[pid].seen.bounced), "negativ klass bevarad (monoton mängd, ingen rullande lista)");
    resetMail(env, o.orderId); await env.COMPARE_ORDERS.runAlarms(3);
    const m = mailOf(env, o.orderId);
    assert.equal(m.state, "sent"); assert.equal(m.providerRef, pid); assert.equal(m.delivery.state, "bounced"); assert.equal(m.delivery.contradiction, true); assert.equal(m.delivery.bounceType, "Permanent");
    await env.COMPARE_ORDERS.runAlarms(5);
    assert.equal(f.log.anthropic.length, 0, "0 modellgenerationer"); assert.equal(ordOf(env, o.orderId).status, "failed"); assert.equal(ordOf(env, o.orderId).refund.state, "needed");
  } finally { f.restore(); }
});
test("ordningen i bufferten spelar ingen roll: delivered före bounced före ack ger också bounced; enbart delivered före ack ger fortsatt delivered", async () => {
  for (const [seq, want] of [[["email.delivered", "email.bounced"], "bounced"], [["email.bounced", "email.delivered"], "bounced"], [["email.sent", "email.delivery_delayed", "email.delivered"], "delivered"]]) {
    const f = installFetch();
    try {
      const env = mk(); f.ctl.mailModes = ["timeout_after_accept"];
      const o = await pay(env, f); const pid = f.log.mailSent[0].id;
      for (const t of seq) await mailEvent(env, t, { emailId: pid, to: f.log.mailSent[0].body.to, mailId: tagOf(o.orderId), bounce: { type: "Permanent" } });
      resetMail(env, o.orderId); await env.COMPARE_ORDERS.runAlarms(3);
      assert.equal(mailOf(env, o.orderId).delivery.state, want, seq.join());
      await env.COMPARE_ORDERS.runAlarms(5); assert.equal(f.log.anthropic.length > 0, want === "delivered");
    } finally { f.restore(); }
  }
});
test("overflow (fler än 8 olika provider-ID före ack) ⇒ okänd bindning ⇒ FAIL CLOSED: även riktig delivered för rätt ID öppnar aldrig grinden", async () => {
  const f = installFetch();
  try {
    const env = mk(); f.ctl.mailModes = ["timeout_after_accept"];
    const o = await pay(env, f); const pid = f.log.mailSent[0].id; const to = f.log.mailSent[0].body.to;
    for (let i = 0; i < 10; i++) await mailEvent(env, "email.sent", { emailId: "ANNAT-id-00000" + i, to, mailId: tagOf(o.orderId) });
    assert.equal(mailOf(env, o.orderId).early.overflow, true); assert.ok(Object.keys(mailOf(env, o.orderId).early.ids).length <= 8);
    await mailEvent(env, "email.delivered", { emailId: pid, to, mailId: tagOf(o.orderId) });
    resetMail(env, o.orderId); await env.COMPARE_ORDERS.runAlarms(3);
    const m = mailOf(env, o.orderId); assert.equal(m.state, "sent"); assert.equal(m.earlyUnbound, true); assert.ok(m.anoms.some((a) => a.code === "tidig_overflow"));
    await mailEvent(env, "email.delivered", { emailId: pid, to, mailId: tagOf(o.orderId) }); await env.COMPARE_ORDERS.runAlarms(5);
    assert.equal(f.log.anthropic.length, 0, "ingen start"); assert.equal(ordOf(env, o.orderId).status, "paid");
    await withClock(31 * 60_000, async () => { await env.COMPARE_ORDERS.runAlarms(3); });
    assert.equal(ordOf(env, o.orderId).status, "failed"); assert.equal(f.log.anthropic.length, 0);
  } finally { f.restore(); }
});

const DAY = 86400_000;
const POL = { COMPARE_LEDGER_RETENTION_DAYS: "30", COMPARE_BOOKKEEPING_RETENTION_DAYS: "90", COMPARE_ADMIN_TOKEN: "admin-token-for-tests-0123456789abcdef" };
const bud = (env) => env.COMPARE_BUDGET.peek("jamfor-budget").store;
function breakUnindex(env) {
  const real = env.COMPARE_BUDGET, flag = { fail: true };
  env.COMPARE_BUDGET = new Proxy(real, { get(t, k) { if (k === "get") return (id) => { const s = t.get(id); return { fetch: (u, i) => (flag.fail && /mailref-unindex/.test(String(u)) ? Promise.reject(new Error("budget nere")) : s.fetch(u, i)) }; }; const v = t[k]; return typeof v === "function" ? v.bind(t) : v; } });
  return flag;
}
async function deliveredHttp(env, f) {
  const o = await pay(env, f); await ev(env, o, "email.delivered"); await env.COMPARE_ORDERS.runAlarms(8);
  assert.equal(ordOf(env, o.orderId).status, "delivered"); return o;
}
const sweepAt = (env, t, month) => withClock(t - Date.now(), () => api(env, "POST", `/compare/admin/retention-sweep?month=${month}`, { headers: { authorization: "Bearer " + POL.COMPARE_ADMIN_TOKEN }, origin: "" }));

test("städ: avtalsstrip tar bort globalt mr-index FÖRE lokala spår; misslyckas det sparas beständigt underlag som överlever strip OCH fullpurge, och ett senare svep slutför (ledgerindex kvar tills klart)", async () => {
  const f = installFetch();
  try {
    const env = mk(POL); const flag = breakUnindex(env); flag.fail = false;
    const o = await deliveredHttp(env, f); const pid = o.sent.id; const key = `mr:${pid}`;
    assert.ok(bud(env).get(key), "globalt index finns efter ack"); assert.ok(store(env, o.orderId).get(`mailref:${pid}`));
    const paidAt = store(env, o.orderId).get("ledger").agreement.payment.paidAt; const month = new Date(paidAt).toISOString().slice(0, 7);
    // 1) strip med fungerande index ⇒ globalt borta, lokalt borta, inget underlag kvar
    // (egen order nedan för felvarianten)
    flag.fail = true;
    await withClock(31 * DAY, async () => { assert.equal((await api(env, "GET", `/compare/orders/${o.orderId}`, { token: o.token })).status, 200); });
    const st = store(env, o.orderId);
    assert.ok(!st.get(`mailref:${pid}`), "lokalt spår borta efter strip"); assert.ok(bud(env).get(key), "globalt kvar eftersom unindex misslyckades");
    assert.deepEqual(st.get("cleanup").mailrefs, [pid], "beständigt städunderlag sparat vid strip");
    // 2) fullpurge medan fortfarande misslyckas ⇒ underlag + ledgerindex bevaras
    await withClock(91 * DAY, async () => { await api(env, "GET", `/compare/orders/${o.orderId}`, { token: o.token }); });
    assert.ok(!st.get("order") && !st.get("ledger"), "allt annat raderat");
    assert.deepEqual(st.get("cleanup").mailrefs, [pid], "underlaget överlever fullpurge"); assert.ok(bud(env).get(key));
    assert.ok([...bud(env).keys()].some((k) => k.startsWith("x:") && k.endsWith(o.orderId)), "ledgerindex kvar så att svepet når ordern");
    // 3) fortsatt fel ⇒ svepet lämnar underlaget; sedan fungerar budgeten ⇒ svepet städar klart
    const r1 = await sweepAt(env, Date.now() + 91 * DAY, month); assert.equal(r1.status, 200); assert.ok(st.get("cleanup"));
    flag.fail = false;
    const r2 = await sweepAt(env, Date.now() + 91 * DAY, month); assert.equal(r2.status, 200);
    assert.ok(!bud(env).get(key), "globala mr-posten borttagen"); assert.equal(st.get("cleanup"), undefined);
    assert.ok(![...bud(env).keys()].some((k) => k.startsWith("x:") && k.endsWith(o.orderId)), "ledgerindex borttaget först när städningen är klar");
  } finally { f.restore(); }
});
test("städ: fungerande index ⇒ strip tar bort mr direkt och lämnar inget underlag; fullpurge likaså", async () => {
  const f = installFetch();
  try {
    const env = mk(POL); const o = await deliveredHttp(env, f); const key = `mr:${o.sent.id}`; const st = store(env, o.orderId);
    assert.ok(bud(env).get(key));
    await withClock(31 * DAY, async () => { await api(env, "GET", `/compare/orders/${o.orderId}`, { token: o.token }); });
    assert.ok(!bud(env).get(key)); assert.equal(st.get("cleanup"), undefined); assert.ok(st.get("order"), "ordern finns kvar efter strip");
    await withClock(91 * DAY, async () => { await api(env, "GET", `/compare/orders/${o.orderId}`, { token: o.token }); });
    assert.equal(st.size, 0, "fullpurge tömmer allt"); assert.ok(![...bud(env).keys()].some((k) => k.startsWith("x:") && k.endsWith(o.orderId)));
  } finally { f.restore(); }
});
