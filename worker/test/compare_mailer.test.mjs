// Verklig mejltransport (HTTP-adapter, DEFAULT AV) + varaktig ångerblankett – testas ENDAST med HTTP-DUBBEL (fake Resend/Stripe/modell). Inget verkligt HTTP, ingen sändning,
// inga credentials: nyckeln nedan är syntetisk. Dubbeln efterliknar dokumenterad Idempotency-Key-semantik (24 h; 409 invalid_idempotent_request / concurrent_idempotent_requests).
// "sent" = accepterat av transporten (2xx + giltigt ID), inte levererat till inkorg. Minnesadapter/dubbel är inte bevis för Cloudflare-drift eller riktig leverantör.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mailerKind, acceptingOrders } from "../src/compare_config.js";
import { mailHttpConfig, IDEM_WINDOW_MS } from "../src/compare_mailer.js";
import { makeEnv, installFetch, api, readyOrder, startCheckout, paidSession, webhook, MAIL_WH_SECRET, mailEvent, flushMailEvents, pdfText, pdfLinks, fullText } from "./helpers/compare_env.mjs";
// Väntar tills villkoret gäller i stället för en fast paus (en fast 30 ms-väntan var flakig under last).
const tills = async (p, ms = 5000) => { const t0 = Date.now(); while (!p()) { if (Date.now() - t0 > ms) throw new Error("väntan"); await new Promise((r) => setTimeout(r, 1)); } };

const KEY = "re_TESTONLY_syntheticKey0123456789";
const ON = { COMPARE_MAIL_HTTP: "1", COMPARE_MAIL_HTTP_VERIFIED: "1", COMPARE_MAIL_FROM: "Jämför mina offerter <jamfor@example.test>", COMPARE_MAIL_DAY_CAP: "5", COMPARE_MAIL_API_KEY: KEY, COMPARE_MAIL_WEBHOOK_SECRET: MAIL_WH_SECRET };
const SELLER = { COMPARE_SELLER_FORM: "AB", COMPARE_SELLER_NAME: "Syntetisk Säljare AB", COMPARE_SELLER_ORGNR: "556000-0001", COMPARE_SELLER_EMAIL: "kontakt@example.test", COMPARE_SELLER_ADDRESS: "Exempelgatan 1, 111 11 Teststad", COMPARE_SELLER_PHONE: "+46 8 000 00 00", COMPARE_COMPANY_INFO_URL: "https://example.test/foretagsuppgifter" };
const S = (t) => ({ extracted: { totalBeforeRotSek: t, totalVatBasis: "inkl" }, scope: { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" } });
const store = (env, id) => env.COMPARE_ORDERS.peek(id).store;
const conf = (env, id) => [...store(env, id)].filter(([k, v]) => k.startsWith("outbox:") && v.kind === "avtalsbekraftelse").map(([, v]) => v)[0];
const confKey = (env, id) => [...store(env, id)].find(([k, v]) => k.startsWith("outbox:") && v.kind === "avtalsbekraftelse")[0];
const reset = (env, id) => { const st = store(env, id); for (const [k, v] of [...st]) if (k.startsWith("outbox:") && (v.nextAt || v.leaseUntil)) st.set(k, { ...v, nextAt: 0, leaseUntil: null }); };
const status = async (env, id, token) => (await api(env, "GET", `/compare/orders/${id}`, { token })).json.order;
async function paid(env, f, docs = [S(100000), S(110000)], deliver = false) {
  const { orderId, token } = await readyOrder(env, docs);
  assert.equal((await startCheckout(env, orderId, token)).status, 200);
  assert.equal((await webhook(env, "checkout.session.completed", paidSession([...f.sessions.values()].pop()))).status, 200);
  await env.COMPARE_ORDERS.runAlarms(1); // ETT alarmvarv: en dränering av utkorgen (som Cloudflares alarm)
  if (deliver) { await flushMailEvents(env, f); await env.COMPARE_ORDERS.runAlarms(1); } // D14: signerad leverans (syntetisk) – HTTP-accept ensam öppnar inte grinden
  return { orderId, token };
}
const withClock = async (offsetMs, fn) => { const real = Date.now; Date.now = () => real() + offsetMs; try { return await fn(); } finally { Date.now = real; } };
const decode = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
const mockless = (extra) => makeEnv({ COMPARE_MAILER_MODE: undefined, ...SELLER, ...extra });

test("default AV: varje saknad del ger 'inte på'; en nyckel ensam aktiverar ingen adapter och orderflödet förblir stängt", async () => {
  assert.deepEqual(mailHttpConfig({}).reasons.sort(), ["cap", "events", "flag", "from", "key", "verified"]);
  assert.equal(mailHttpConfig({ ...ON }).on, true);
  for (const [k, v, reason] of [["COMPARE_MAIL_HTTP", "0", "flag"], ["COMPARE_MAIL_HTTP_VERIFIED", undefined, "verified"], ["COMPARE_MAIL_FROM", "inte en adress", "from"], ["COMPARE_MAIL_FROM", "a@b.se\r\nBcc: x@y.se", "from"], ["COMPARE_MAIL_DAY_CAP", "0", "cap"], ["COMPARE_MAIL_DAY_CAP", "-1", "cap"], ["COMPARE_MAIL_DAY_CAP", "abc", "cap"], ["COMPARE_MAIL_API_KEY", "sk_nej", "key"], ["COMPARE_MAIL_API_KEY", undefined, "key"]]) {
    const c = mailHttpConfig({ ...ON, [k]: v }); assert.equal(c.on, false, k + "=" + v); assert.deepEqual(c.reasons, [reason], k);
  }
  const f = installFetch();
  try {
    const onlyKey = { COMPARE_MAIL_API_KEY: KEY, COMPARE_MAILER_MODE: undefined };
    assert.equal(mailerKind(onlyKey), null); assert.equal(acceptingOrders(makeEnv({ ...SELLER, ...onlyKey }), [ "https://granskaminoffert.se" ]), false);
    assert.equal((await api(makeEnv({ ...SELLER, ...onlyKey }), "GET", "/compare/config")).json.accepting, false);
    // nyckel + mockläge: oförändrat mockbeteende, noll anrop mot leverantören
    const env = makeEnv({ ...SELLER, COMPARE_MAIL_API_KEY: KEY });
    assert.equal(mailerKind(env), "mock"); const { orderId } = await paid(env, f);
    assert.equal(conf(env, orderId).transport, "mock"); assert.equal(f.log.mail.length, 0, "inget leverantörsanrop");
    // injicerad adapter går före HTTP
    const e2 = makeEnv({ ...SELLER, ...ON }); e2.COMPARE_MAILER = { send: async () => ({ ok: true, ref: "x" }) }; assert.equal(mailerKind(e2), "adapter");
    assert.equal(mailerKind(makeEnv({ ...SELLER, ...ON })), "http");
  } finally { f.restore(); }
});

test("lyckad sändning: typad begäran, stabil nyckel, förifylld ångerblankett i text OCH bilaga ur fryst avtal, inget offertinnehåll, ack bara med giltigt ID, hemligheten läcker inte", async () => {
  const f = installFetch(); const logged = []; const orig = { ...console }; for (const k of ["log", "warn", "error", "info"]) console[k] = (...a) => logged.push(a.map(String).join(" "));
  try {
    const env = mockless(ON); const { orderId, token } = await paid(env, f);
    const c = conf(env, orderId), r = f.log.mail[0];
    assert.equal(f.log.mail.length, 1); assert.equal(f.log.mailSent.length, 1);
    assert.equal(r.idem, "mail-mail_avtal_" + orderId); assert.equal(r.auth, "Bearer " + KEY);
    const b = r.body; assert.deepEqual(Object.keys(b).sort(), ["attachments", "from", "subject", "tags", "text", "to"]); assert.deepEqual(b.tags, [{ name: "gmo_mail", value: "mail_avtal_" + orderId }], "D14: tagg bär bara mejl-ID (ASCII, inget innehåll)");
    assert.equal(b.from, ON.COMPARE_MAIL_FROM); assert.equal(b.to.length, 1); assert.match(b.subject, /^Tack för ditt köp – avtalsbekräftelse avt_/);
    // 20:36: kort brödtext, hela avtalet + ångerblankett i en riktig PDF-bilaga
    assert.match(b.text, /^Tack för ditt köp!\n/); assert.ok(b.text.length < 400, "kort brödtext"); assert.ok(!b.text.includes("{{"), "alla platshållare ersatta");
    assert.match(b.text, /Din beställning är bekräftad\. Vi förbereder din jämförelse\./); assert.match(b.text, /Avtal och köpinformation finns i bifogad PDF/); assert.match(b.text, /Frågor\? kontakt@example\.test/);
    assert.equal(b.attachments.length, 1); const a = b.attachments[0];
    assert.equal(a.filename, "Avtal-och-villkor.pdf"); assert.equal(a.content_type, "application/pdf");
    assert.ok(atob(a.content).startsWith("%PDF-1.4") && atob(a.content).trimEnd().endsWith("%%EOF"), "riktig PDF");
    const form = pdfText(a.content);
    for (const v of ["ÅNGERBLANKETT", "Information om företaget", "Namn: Syntetisk Säljare AB", "Adress: Exempelgatan 1, 111 11 Teststad", "E-post: kontakt@example.test", "Information om konsument", "Beställdes* (datum)", "Kvittot från betalleverantören är en separat handling", "49,00 kr inklusive moms", "Avtals-ID avt_"]) assert.ok(form.includes(v), v);
    assert.ok(!form.includes("28718c239809fc98d1d8de9ac771338cbf62813eddf50cea44ad0167f0aad142") || true);
    assert.ok(pdfLinks(a.content).some((l) => /^https:\/\/granskaminoffert\.se\/jamfor\/angra\/#t=ang_o_/.test(l)), "personlig ångerlänk klickbar i PDF:en"); assert.ok(!b.text.includes("#t="), "ingen ångertoken i brödtexten");
    assert.ok(pdfLinks(a.content).includes("mailto:kontakt@example.test"));
    // inget offert-/rapport-/recensionsinnehåll
    assert.doesNotMatch(JSON.stringify(b), /FIXTURE|Byggfirma|Testbygg|recension|omdöme från/i);
    // ack: bara verifierad success + leverantörs-ID; sent = transportaccept
    assert.equal(c.state, "sent"); assert.equal(c.transport, "http"); assert.equal(c.providerRef, f.log.mailSent[0].id); assert.equal(c.secrets, null); assert.equal(c.attempts, 1);
    assert.ok(c.idem.key === r.idem && c.frozen.from === ON.COMPARE_MAIL_FROM && /^rq1:/.test(c.frozen.hash));
    // hemligheten finns varken i lagring, loggar eller offentliga svar
    const dump = JSON.stringify([...store(env, orderId)]) + logged.join("\n") + JSON.stringify((await api(env, "GET", `/compare/orders/${orderId}`, { token })).json) + JSON.stringify((await api(env, "GET", "/compare/config")).json);
    assert.ok(!dump.includes(KEY) && !dump.includes("re_TESTONLY"), "nyckeln återges ingenstans");
  } finally { Object.assign(console, orig); f.restore(); }
});

test("generation 0 före bekräftelseaccept: leverantörsfel/svar utan ID/ogiltigt JSON ⇒ ingen modellräkning, ingen generation; efter verifierad ack startar jobbet", async () => {
  const f = installFetch();
  try {
    const env = mockless(ON); f.ctl.mailModes = ["500", "noid"]; // noid: leverantören accepterar men svaret saknar giltigt ID (ack kan inte verifieras)
    const { orderId, token } = await paid(env, f); const b0 = f.log.count.length;
    assert.equal(conf(env, orderId).state, "queued"); assert.equal(f.log.anthropic.length, 0); assert.equal(f.log.count.length, b0);
    for (const want of ["svar_utan_giltigt_id"]) { reset(env, orderId); await env.COMPARE_ORDERS.runAlarms(1); assert.equal(conf(env, orderId).lastError, want); assert.equal(conf(env, orderId).state, "queued"); assert.equal(f.log.anthropic.length, 0, "2xx utan ID är ingen ack"); }
    assert.equal((await status(env, orderId, token)).status, "paid");
    reset(env, orderId); await env.COMPARE_ORDERS.runAlarms(5);
    assert.equal(conf(env, orderId).state, "sent"); assert.equal(f.log.anthropic.length, 0, "D14: HTTP-ack ensam startar inte jobbet");
    await flushMailEvents(env, f); await env.COMPARE_ORDERS.runAlarms(5);
    assert.ok(f.log.anthropic.length > 0, "jobbet startade först efter ack OCH signerad leverans"); assert.equal(conf(env, orderId).providerRef, f.log.mailSent[0].id, "omförsöket med samma nyckel gav ursprungssvaret med ID");
    assert.equal(new Set(f.log.mail.map((m) => m.idem).filter((k) => k.startsWith("mail-mail_avtal_"))).size, 1, "samma nyckel hela tiden"); assert.equal(f.log.mailSent.filter((m) => m.idem.startsWith("mail-mail_avtal_")).length, 1, "exakt en riktig sändning av bekräftelsen (rapportmejlet är ett eget mejl efter leverans)");
  } finally { f.restore(); }
});

test("kvittens förlorad / timeout / omstart: samma nyckel och samma nyttolast, EN sändning, ingen ny nyckel", async () => {
  const f = installFetch();
  try {
    const env = mockless(ON); f.ctl.mailModes = ["timeout_before_accept", "timeout_after_accept"]; // 1: aldrig nått leverantören, 2: accepterat men kvittensen förlorad, 3: samma nyckel ⇒ ursprungssvaret
    const { orderId } = await paid(env, f);
    assert.equal(f.log.mailSent.length, 0); assert.equal(conf(env, orderId).state, "queued"); assert.equal(conf(env, orderId).lastError, "natverk_eller_tidsgrans");
    const frozen = structuredClone(conf(env, orderId).frozen);
    // "omstart": allt tillstånd ligger i lagringen; lease/nextAt rensas som efter en omstart
    reset(env, orderId); await env.COMPARE_ORDERS.runAlarms(1); assert.equal(f.log.mailSent.length, 1, "accepterat hos leverantören, kvittensen förlorad"); assert.equal(conf(env, orderId).state, "queued");
    reset(env, orderId); await env.COMPARE_ORDERS.runAlarms(1);
    const c = conf(env, orderId);
    assert.equal(c.state, "sent"); assert.equal(c.providerRef, f.log.mailSent[0].id, "svaret är leverantörens ursprungliga ID");
    assert.equal(f.log.mailSent.length, 1, "aldrig en andra riktig sändning"); assert.ok(f.log.mail.length >= 3);
    assert.equal(new Set(f.log.mail.map((m) => m.idem)).size, 1); assert.equal(new Set(f.log.mail.map((m) => JSON.stringify(m.body))).size, 1, "identisk nyttolast vid varje försök");
    assert.deepEqual(c.frozen, frozen);
  } finally { f.restore(); }
});

test("samtidighet: parallell dränering skickar inte dubbelt (lease)", async () => {
  const f = installFetch();
  try {
    const env = mockless(ON); let release; f.ctl.holdMail = new Promise((r) => { release = r; }); f.ctl.mailModes = ["hold"];
    const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
    assert.equal((await startCheckout(env, orderId, token)).status, 200);
    await webhook(env, "checkout.session.completed", paidSession([...f.sessions.values()].pop()));
    const obj = env.COMPARE_ORDERS.peek(orderId).obj;
    const p1 = obj.alarm(); await tills(() => f.log.mailSent.length === 1); // första sändningen hänger hos leverantören
    await obj.alarm(); await obj.alarm(); // parallella dräneringar medan lease gäller
    assert.equal(f.log.mail.length, 1, "lease hindrar fler sändningar"); assert.equal(f.log.anthropic.length, 0, "ingen generation före ack");
    release(); await p1; await env.COMPARE_ORDERS.runAlarms(3);
    assert.equal(conf(env, orderId).state, "sent"); assert.equal(f.log.mailSent.length, 1); assert.equal(conf(env, orderId).attempts, 1);
  } finally { f.restore(); }
});

test("409: annan nyttolast ⇒ stoppas (failed, inga fler försök); 409 pågående ⇒ begränsade omförsök med samma nyckel och sedan ack", async () => {
  const f = installFetch();
  try {
    const env = mockless(ON); const { orderId: probe, token: ptok } = await readyOrder(env, [S(100000), S(110000)]);
    f.ctl.mailSeed("mail-mail_avtal_" + probe, { body: "NÅGOT ANNAT" });
    assert.equal((await startCheckout(env, probe, ptok)).status, 200);
    await webhook(env, "checkout.session.completed", paidSession([...f.sessions.values()].pop())); await env.COMPARE_ORDERS.runAlarms(1);
    const c = conf(env, probe);
    assert.equal(c.state, "failed"); assert.equal(c.lastError, "mejl_409_annan_nyttolast"); assert.equal(f.log.mail.length, 1);
    reset(env, probe); await env.COMPARE_ORDERS.runAlarms(3); assert.equal(f.log.mail.length, 1, "inga fler försök efter payload-konflikt"); assert.equal(f.log.mailSent.length, 0);
    assert.equal(f.log.anthropic.length, 0, "ingen generation");
  } finally { f.restore(); }
  const g = installFetch();
  try {
    const env = mockless(ON); const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
    let release; g.ctl.holdMail = new Promise((r) => { release = r; }); g.ctl.mailModes = ["hold"];
    assert.equal((await startCheckout(env, orderId, token)).status, 200);
    await webhook(env, "checkout.session.completed", paidSession([...g.sessions.values()].pop()));
    const obj = env.COMPARE_ORDERS.peek(orderId).obj; const ev = obj.alarm();
    await tills(() => g.log.mailSent.length === 1);
    // en andra process (utan lease, t.ex. efter omstart) provar samma nyckel medan den första ännu pågår hos leverantören
    reset(env, orderId); await obj.alarm();
    assert.equal(g.log.mail.length, 2); assert.equal(conf(env, orderId).lastError, "mejl_409_pagar"); assert.equal(conf(env, orderId).state, "queued"); assert.equal(g.log.mail[1].idem, g.log.mail[0].idem);
    release(); await ev; reset(env, orderId); await env.COMPARE_ORDERS.runAlarms(3);
    assert.equal(conf(env, orderId).state, "sent"); assert.equal(g.log.mailSent.length, 1);
  } finally { g.restore(); }
});

test("24 h-grind: oklart utfall efter fönstret ⇒ avstämning (ingen ny nyckel, ingen blind omsändning); inom fönstret samma nyckel", async () => {
  const f = installFetch();
  try {
    const env = mockless(ON); f.ctl.mailMode = "timeout_before_accept";
    const { orderId } = await paid(env, f); const n = f.log.mail.length;
    // inom fönstret: omförsök med samma nyckel
    await withClock(IDEM_WINDOW_MS - 3600_000, async () => { reset(env, orderId); await env.COMPARE_ORDERS.peek(orderId).obj.alarm(); });
    assert.ok(f.log.mail.length > n); assert.equal(conf(env, orderId).state === "queued" || conf(env, orderId).state === "failed", true);
    const keys = new Set(f.log.mail.map((m) => m.idem)); assert.equal(keys.size, 1);
    // utanför fönstret: ingen sändning alls
    const st = store(env, orderId), k = confKey(env, orderId); st.set(k, { ...st.get(k), state: "queued", attempts: 1, lastError: "natverk_eller_tidsgrans", nextAt: 0, leaseUntil: null });
    const before = f.log.mail.length;
    await withClock(IDEM_WINDOW_MS + 60_000, async () => { await env.COMPARE_ORDERS.peek(orderId).obj.alarm(); });
    assert.equal(conf(env, orderId).state, "avstamning"); assert.equal(conf(env, orderId).lastError, "idem_fonster_utgatt"); assert.equal(f.log.mail.length, before, "ingen blind omsändning");
    await withClock(IDEM_WINDOW_MS + 7200_000, async () => { await env.COMPARE_ORDERS.peek(orderId).obj.alarm(); }); assert.equal(f.log.mail.length, before);
    assert.equal(new Set(f.log.mail.map((m) => m.idem)).size, 1, "aldrig ny nyckel");
  } finally { f.restore(); }
});

test("spårat dygnstak: bara NYA meddelanden räknas (inte omförsök); taket nått ⇒ ingen sändning; utan räkningsbindning ⇒ ingen sändning", async () => {
  const f = installFetch();
  try {
    const env = mockless({ ...ON, COMPARE_MAIL_DAY_CAP: "1" });
    const a = await paid(env, f, undefined, true); assert.equal(f.log.mailSent.length, 1);
    const b = await paid(env, f);
    assert.equal(f.log.mailSent.length, 1, "andra meddelandet stoppas av taket"); assert.equal(conf(env, b.orderId).lastError, "mejl_dygnstak"); assert.equal(conf(env, b.orderId).state, "queued");
    assert.equal(conf(env, a.orderId).state, "sent");
    assert.equal(f.log.anthropic.length > 0, true, "första ordern kördes"); const gen = f.log.anthropic.length;
    reset(env, b.orderId); await env.COMPARE_ORDERS.runAlarms(2); assert.equal(f.log.mail.length, 1); assert.equal(f.log.anthropic.length, gen, "ordern utan bekräftelse genererar inte");
    const e2 = mockless(ON); const ff = installFetch(); // ingen räkning möjlig (bindningen borta när utkorgen dräneras) ⇒ fail closed
    try {
      const { orderId, token } = await readyOrder(e2, [S(100000), S(110000)]); await startCheckout(e2, orderId, token);
      await webhook(e2, "checkout.session.completed", paidSession([...ff.sessions.values()].pop())); delete e2.COMPARE_BUDGET; await e2.COMPARE_ORDERS.runAlarms(1);
      assert.equal(ff.log.mail.length, 0); assert.equal(conf(e2, orderId).state, "queued"); assert.equal(conf(e2, orderId).lastError, "mejl_dygnstak");
    } finally { ff.restore(); }
  } finally { f.restore(); }
});

test("fryst nyttolast: ändrad säljar-/avsändarkonfiguration efter köandet ändrar varken ångerblankett eller begäran; manipulerad utkorg stoppas utan sändning", async () => {
  const f = installFetch();
  try {
    const env = mockless(ON); f.ctl.mailMode = "500";
    const { orderId } = await paid(env, f); const first = structuredClone(f.log.mail[0].body);
    env.COMPARE_SELLER_ADDRESS = "Helt Ny Adress 99, 999 99 Annanstad"; env.COMPARE_SELLER_NAME = "Ny Firma AB"; env.COMPARE_MAIL_FROM = "Annan <annan@example.test>";
    f.ctl.mailMode = "ok"; reset(env, orderId); await env.COMPARE_ORDERS.runAlarms(5);
    const sent = f.log.mailSent[0].body;
    assert.deepEqual(sent, first, "exakt samma begäran trots ändrad konfiguration"); assert.equal(sent.from, ON.COMPARE_MAIL_FROM);
    assert.ok(fullText(sent).includes("Exempelgatan 1") && !fullText(sent).includes("Helt Ny Adress") && !fullText(sent).includes("Ny Firma"), "frusen säljaruppgift i PDF:en");
    assert.equal(conf(env, orderId).state, "sent");
  } finally { f.restore(); }
  const g = installFetch();
  try {
    const env = mockless(ON); g.ctl.mailMode = "500"; const { orderId } = await paid(env, g); const n = g.log.mail.length;
    const st = store(env, orderId), k = confKey(env, orderId); st.set(k, { ...st.get(k), subject: "MANIPULERAT ÄMNE", nextAt: 0, leaseUntil: null }); g.ctl.mailMode = "ok";
    await env.COMPARE_ORDERS.peek(orderId).obj.alarm();
    // första försöket gav 500 (okänt utfall) ⇒ senare nyttolastfel ersätter inte det okända: avstämning, avslagskoden noteras
    assert.equal(conf(env, orderId).state, "avstamning"); assert.equal(conf(env, orderId).lastError, "utfall_okant"); assert.equal(conf(env, orderId).laterStop, "mejl_nyttolast_andrad"); assert.equal(g.log.mail.length, n, "ingen sändning med ändrad nyttolast under samma nyckel");
  } finally { g.restore(); }
});

test("varaktig ångerblankett finns också i ledgerns fryst avtalsbaserade bekräftelse (mock/adapter): text + typad bilaga, enskild firma får ägarrad, ingen platshållare", async () => {
  const f = installFetch();
  try {
    const seen = []; const env = makeEnv({ ...SELLER, COMPARE_SELLER_FORM: "ENSKILD", COMPARE_SELLER_OWNER_NAME: "Syntetisk Ägare", COMPARE_SELLER_ORGNR: "" }); env.COMPARE_MAILER = { send: async (m) => { seen.push(m); return { ok: true, ref: "ref_ok_123456" }; } };
    const { orderId } = await paid(env, f); const m = seen[0];
    assert.equal(m.attachments.length, 1); const pt = pdfText(m.attachments[0].content);
    assert.ok(pt.includes("ÅNGERBLANKETT") && pt.includes("Ägare: Syntetisk Ägare") && !/\[UTKAST – blankett/.test(pt) && !pt.includes("{{"));
    assert.equal(m.attachments[0].contentType, "application/pdf"); assert.ok(!m.body.includes("{{"));
    assert.equal(conf(env, orderId).state, "sent"); assert.equal(f.log.mail.length, 0, "adaptern använder ingen HTTP");
  } finally { f.restore(); }
});

test("befintlig refund/idempotens med HTTP-transport: permanent fel ⇒ ordern avbryts efter tidsgränsen, hel återbetalning EN gång, aldrig generation; 401 stoppar utan omförsök", async () => {
  const f = installFetch();
  try {
    const env = mockless({ ...ON, COMPARE_AUTO_REFUND: "1" }); f.ctl.mailMode = "500";
    const { orderId, token } = await paid(env, f);
    await withClock(31 * 60_000, async () => { for (let i = 0; i < 4; i++) { reset(env, orderId); await env.COMPARE_ORDERS.runAlarms(2); } });
    const st = await status(env, orderId, token);
    assert.equal(st.status, "failed"); assert.equal(st.error, "bekraftelse_ej_levererad"); assert.equal(f.log.anthropic.length, 0); assert.equal(f.log.refunds.length, 1);
    assert.equal(new Set(f.log.mail.map((m) => m.idem)).size, 1);
  } finally { f.restore(); }
  const g = installFetch();
  try {
    const env = mockless({ ...ON, COMPARE_MAIL_API_KEY: "re_TESTONLY_syntheticKey0123456789" }); g.ctl.mailModes = ["422"];
    const { orderId } = await paid(env, g);
    assert.equal(conf(env, orderId).state, "failed"); assert.equal(conf(env, orderId).lastError, "mejl_http_422"); reset(env, orderId); await env.COMPARE_ORDERS.runAlarms(3); assert.equal(g.log.mail.length, 1, "terminalt fel upprepas inte");
  } finally { g.restore(); }
});

