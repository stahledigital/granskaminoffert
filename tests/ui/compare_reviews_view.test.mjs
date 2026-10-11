// Recensionsdelta (UI): (kopierad hjälpare) betalningens ?order=ID ≠ sparad order ⇒ tydlig mismatch-vy (ingen tyst ombyte, ingen tokenbypass); rapportlänk #o=&r= med ogiltig token ⇒ tydligt besked.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { makeEnv, installFetch, readyOrder, startCheckout, paidSession, webhook, flushMailEvents, MAIL_WH_SECRET, REVIEW_VARS, GOOGLE_VARS, TP_VARS } from "../../worker/test/helpers/compare_env.mjs";
import { startHarness } from "../../worker/dev/compare_harness.mjs";

const PW = process.env.PLAYWRIGHT_MODULE || "/opt/npm-tools/node_modules/playwright/index.mjs";
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
const { chromium } = await import(pathToFileURL(PW).href);
let browser;
before(async () => { browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] }); });
after(async () => { await browser?.close(); });

const OLD = "o_" + "a".repeat(32), NEW = "o_" + "b".repeat(32), TOK = "T".repeat(32);

// Verklig rapport ur den riktiga pipelinen (Worker-testdubbel), serverad som svar på resultatlänkens läsning.
async function realReport() {
  const f = installFetch();
  try {
    const S = (t) => ({ extracted: { totalBeforeRotSek: t, totalVatBasis: "inkl" }, scope: { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" } });
    const env = makeEnv({ COMPARE_MAILER_MODE: undefined, COMPARE_MAIL_HTTP: "1", COMPARE_MAIL_HTTP_VERIFIED: "1", COMPARE_MAIL_FROM: "J <j@example.test>", COMPARE_MAIL_DAY_CAP: "20", COMPARE_MAIL_API_KEY: "re_TESTONLY_syntheticKey0123456789", COMPARE_MAIL_WEBHOOK_SECRET: MAIL_WH_SECRET });
    const r = await readyOrder(env, [S(100000), S(110000)]);
    await startCheckout(env, r.orderId, r.token);
    await webhook(env, "checkout.session.completed", paidSession([...f.sessions.values()].pop()));
    await env.COMPARE_ORDERS.runAlarms(1); await flushMailEvents(env, f); await env.COMPARE_ORDERS.runAlarms(5);
    const o = env.COMPARE_ORDERS.peek(r.orderId).store.get("order");
    return JSON.parse(await env.REVIEWS_KV.get(o.reportKey));
  } finally { f.restore(); }
}

const RV = { ...REVIEW_VARS, ...GOOGLE_VARS, ...TP_VARS };
const KEY = "K".repeat(32);
const VIEW = { ok: true, sources: { active: true, firms: [{ id: "f_abc", name: "Byggfirma A", city: "Teststad", domain: "bygg-a.example.test", offers: [0], conflict: false, origin: "dokument",
  google: { state: "vantar_foretagsval", text: "väntar på att du bekräftar rätt firma", placeId: null, confirmed: false, searchesLeft: 2 }, trustpilot: { state: "vantar_foretagsval", text: "väntar på att du bekräftar rätt firma", confirmed: false, rev: 0, searchesLeft: 2 } }],
  coverage: { active: true, firms: 1, lines: [], google: {}, trustpilot: {} } } };
async function run({ vars, stored, sources, cards, live }) {
  const R = await realReport(); if (cards) { R.sourceCards = cards; R.sourcesFrozenAt = "2026-10-11T19:40:00.000Z"; } const h = await startHarness({ vars });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "sv-SE" }); const page = await ctx.newPage();
  const errors = [], reqs = []; page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await page.route(`**/compare/orders/${NEW}/report`, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, report: R, ...(live ? { sourceLive: live } : {}) }) }));
    await page.route(`**/compare/orders/${NEW}/sources**`, (r) => { const q = r.request(); reqs.push({ m: q.method(), u: new URL(q.url()).pathname, t: q.headers()["x-order-token"] }); if (sources === 503) return r.fulfill({ status: 503, contentType: "application/json", body: "{}" }); return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(VIEW) }); });
    await page.goto(h.base + "/jamfor/");
    if (stored) await page.evaluate(([o, t]) => localStorage.setItem("jamfor_order", JSON.stringify({ id: o, token: t })), [NEW, KEY]);
    await page.goto(h.base + `/jamfor/#o=${NEW}&r=${TOK}`); await page.reload();
    await page.waitForSelector("#rep:not(.hidden) table.cmp"); await page.waitForTimeout(400);
    await page.evaluate(() => { var m = document.getElementById("more"); if (m) m.open = true; });
    const txt = (await page.evaluate(() => document.getElementById("rep").innerText)).replace(/\s+/g, " ");
    return { txt, reqs, errors, page, close: async () => { await ctx.close(); await h.close(); } };
  } catch (e) { await ctx.close(); await h.close(); throw e; }
}
test("recensionsvy: källor AV ⇒ 'Visas inte i den här versionen', inga källanrop", async () => {
  const x = await run({ vars: {}, stored: true }); try {
    assert.match(x.txt, /Visas inte i den här versionen/); assert.deepEqual(x.reqs, []); assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
test("recensionsvy: källor PÅ men ingen ordernyckel i den här webbläsaren ⇒ ärlig förklaring, inget källanrop, ingen osann 'visas inte'", async () => {
  const x = await run({ vars: RV, stored: false }); try {
    assert.match(x.txt, /bara i den webbläsare där du gjorde köpet/); assert.ok(!/Visas inte i den här versionen/.test(x.txt));
    assert.deepEqual(x.reqs, [], "resultatlänkens token används aldrig mot /sources"); assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
test("recensionsvy: källor PÅ + sparad ordernyckel ⇒ skrivskyddat källkort med offertens firmauppgifter, ordernyckeln (aldrig r-token) i anropet, inga sök-/byt-/ändra-knappar, ingen /identity", async () => {
  const x = await run({ vars: RV, stored: true }); try {
    assert.match(x.txt, /Firma enligt offerten: Byggfirma A · Teststad · webbplats bygg-a\.example\.test/);
    assert.match(x.txt, /Google väntar på att du bekräftar rätt firma/); assert.match(x.txt, /Trustpilot väntar på att du bekräftar rätt firma/);
    assert.ok(x.reqs.length >= 1 && x.reqs.every((q) => q.m === "GET" && q.u.endsWith("/sources") && q.t === KEY && q.t !== TOK), JSON.stringify(x.reqs));
    assert.ok(!/Fel firma\? Byt|Sök firman|Ändra företag|Radera min jämförelse/.test(x.txt), "inga interaktiva/destruktiva kontroller i läsvyn");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
test("recensionsvy NEGATIV: källtjänsten svarar 503 ⇒ 'kunde inte hämtas – betyder inte att omdömen saknas' (aldrig 'inga omdömen'/'visas inte')", async () => {
  const x = await run({ vars: RV, stored: true, sources: 503 }); try {
    assert.match(x.txt, /Källstatus kunde inte hämtas just nu\. Det betyder inte att omdömen saknas/); assert.ok(!/Visas inte i den här versionen|Inga omdömen/.test(x.txt)); assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

const PURL = "https://www.google.com/maps/search/?api=1&query=Byggfirma%20A%20Teststad&query_place_id=ChIJxxxxxxxxxxxxxxxxxxxxxxxx";
const CARDS = [
  { offerIndex: 0, state: "bekraftad", firm: { name: "Byggfirma A", city: "Teststad", domain: "bygg-a.example.test", origin: "bekraftad" }, google: { state: "bekraftad_profil", text: "kundbekräftad offentlig profil", profileUrl: PURL, confirmedAt: Date.UTC(2026, 9, 11, 19, 30), via: "manual" }, trustpilot: { state: "ej_aktiverad", text: "visas inte i den här versionen" } },
  { offerIndex: 1, state: "ej_bekraftad", firm: null, google: { state: "vantar_foretagsval", text: "ingen firma bekräftad för den här offerten", profileUrl: null, confirmedAt: null, via: null }, trustpilot: { state: "ej_aktiverad", text: "visas inte i den här versionen" } },
];
test("D07-rättelse (UI): annan enhet/resultatlänk visar kundbekräftad offentlig Google-profil per offert (firma, tid, länk), ärlig status för offert utan bekräftad firma, ingen Trustpilot när av, inga omdömen/betyg; inga källanrop med r-token", async () => {
  const x = await run({ vars: RV, stored: false, cards: CARDS }); try {
    assert.match(x.txt, /Företagens offentliga profiler/); assert.match(x.txt, /Byggfirma A, Teststad, bygg-a\.example\.test/);
    assert.match(x.txt, /Google: kundbekräftad offentlig profil \(bekräftad/); assert.match(x.txt, /Google: ingen firma bekräftad för den här offerten/);
    assert.ok(!/Trustpilot:/.test(x.txt), "inaktiv Trustpilot nämns inte");
    assert.match(x.txt, /PDF:en i mejlet visar läget vid leverans/); assert.ok(!/ stjärnor|betyg \d|av 5/i.test(x.txt));
    const a = await x.page.locator('#srcprofiles a'); assert.equal(await a.count(), 1);
    assert.equal(await a.getAttribute("href"), PURL); assert.match(await a.getAttribute("rel"), /noopener/); assert.equal(await a.getAttribute("target"), "_blank");
    assert.deepEqual(x.reqs, [], "ingen /sources med r-token"); assert.deepEqual(x.errors, []);
    assert.ok(await x.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "ingen sidoscroll 390 px");
  } finally { await x.close(); }
});
test("D07-rättelse (UI): efterhandsomval ⇒ uppdaterad status visas med tid och tydlig not att PDF:en från mejlet inte uppdaterats; osäker länk (ej google.com/maps) blir aldrig href", async () => {
  const live = { cards: [{ ...CARDS[0], google: { ...CARDS[0].google, profileUrl: "https://evil.example/x" } }, CARDS[1]], asOf: "2026-10-11T20:05:00.000Z", changedSinceDelivery: true, frozenAt: "2026-10-11T19:40:00.000Z" };
  const x = await run({ vars: RV, stored: false, cards: [CARDS[1], CARDS[1]].map((c, i) => ({ ...c, offerIndex: i })), live }); try {
    assert.match(x.txt, /har inte uppdaterats/); assert.match(x.txt, /Den här visningen är uppdaterad/);
    assert.equal(await x.page.locator('#srcprofiles a').count(), 0, "otillåten länkdomän blir ingen länk"); assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
