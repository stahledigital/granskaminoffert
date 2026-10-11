// D16-R2 fix3 (UI): betalningens ?order=ID ≠ sparad order ⇒ tydlig mismatch-vy (ingen tyst ombyte, ingen tokenbypass); rapportlänk #o=&r= med ogiltig token ⇒ tydligt besked.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { makeEnv, installFetch, readyOrder, startCheckout, paidSession, webhook, flushMailEvents, MAIL_WH_SECRET } from "../../worker/test/helpers/compare_env.mjs";
import { startHarness } from "../../worker/dev/compare_harness.mjs";

const PW = process.env.PLAYWRIGHT_MODULE || "/opt/npm-tools/node_modules/playwright/index.mjs";
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
const { chromium } = await import(pathToFileURL(PW).href);
let browser;
before(async () => { browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] }); });
after(async () => { await browser?.close(); });

const OLD = "o_" + "a".repeat(32), NEW = "o_" + "b".repeat(32), TOK = "T".repeat(32);

test("mismatch: ?order=NY ≠ sparad GAMMAL ⇒ förklarande vy, fel länk avvisas, rätt länk öppnar NY, sparad kan visas; ingen automatisk adoption", async () => {
  const h = await startHarness();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "sv-SE" });
  const page = await ctx.newPage(); const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await page.goto(h.base + "/jamfor/");
    await page.evaluate(([o, t]) => localStorage.setItem("jamfor_order", JSON.stringify({ id: o, token: t })), [OLD, TOK]);
    await page.goto(h.base + "/jamfor/?order=" + NEW + "&session_id=cs_test_x");
    await page.waitForSelector("#mmlink");
    const t = await page.textContent("#statusbox");
    assert.match(t, new RegExp(NEW.slice(2, 10).toUpperCase())); assert.match(t, new RegExp(OLD.slice(2, 10).toUpperCase()));
    assert.match(t, /byter inte jämförelse automatiskt/);
    assert.ok(!/Vi väntar på bekräftelse av betalningen/.test(await page.evaluate(() => document.body.innerText)), "visar inte vilseledande 'väntar på betalning' för fel order");
    assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem("jamfor_order"))), { id: OLD, token: TOK }, "sparad order orörd");
    // länk till fel order avvisas
    await page.fill("#mmlink", `https://x.test/jamfor/#o=${OLD}&t=${TOK}`); await page.click("#mmopen");
    assert.match(await page.textContent("#mmmsg"), /annan jämförelse/);
    await page.fill("#mmlink", "skräp"); await page.click("#mmopen");
    assert.match(await page.textContent("#mmmsg"), /ingen återställningslänk/);
    // rätt länk: sparas och ordern slås upp med SIN token (404 i tomt harness ⇒ tydligt besked, inte vilseledande)
    await page.fill("#mmlink", `https://x.test/jamfor/#o=${NEW}&t=${TOK}`); await page.click("#mmopen");
    await page.waitForFunction(() => /hittades inte/.test(document.getElementById("statusbox").textContent));
    assert.equal(h.stats.anthropic, 0);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

test("rapportlänk #o=&r= med ogiltig token ⇒ ogiltig/utgången länk, inget sparas; ingen sidoscroll", async () => {
  const h = await startHarness();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "sv-SE" });
  const page = await ctx.newPage();
  try {
    await page.goto(h.base + `/jamfor/#o=${NEW}&r=${TOK}`);
    await page.waitForFunction(() => /ogiltig eller har gått ut/.test(document.getElementById("statusbox").textContent));
    assert.equal(await page.evaluate(() => localStorage.getItem("jamfor_order")), null, "resultattoken sparas aldrig");
    assert.ok(await page.evaluate(() => !/#r=|&r=/.test(location.hash)), "token borttagen ur adressen");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  } finally { await ctx.close(); await h.close(); }
});

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
test("POSITIV resultatlänk: giltig r + verklig rapport ⇒ komplett jämförelse, inga pageerrors, ingen Radera/ångra-tokenlänk, gammal order i localStorage orörd", async () => {
  const R = await realReport();
  const h = await startHarness();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "sv-SE" });
  const page = await ctx.newPage(); const errors = [];
  page.on("pageerror", (e) => errors.push(String(e))); page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  try {
    await page.route(`**/compare/orders/${NEW}/report`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, report: R }) }));
    await page.goto(h.base + "/jamfor/");
    await page.evaluate(([o, t]) => localStorage.setItem("jamfor_order", JSON.stringify({ id: o, token: t })), [OLD, TOK]);
    await page.goto(h.base + `/jamfor/#o=${NEW}&r=${TOK}`); await page.reload(); // hash-navigering ensam kör inte om init()
    await page.waitForSelector("#rep:not(.hidden) table.cmp");
    const txt = (await page.evaluate(() => document.getElementById("rep").innerText)).replace(/\s+/g, " ");
    for (const v of ["Din jämförelse", "Byggfirma A", "Bygg B", "100 000 kr", "110 000 kr", "Frågor att ställa till varje hantverkare", "Kvitto", "Skriv ut / spara som PDF", "Ladda ner (JSON)"]) assert.ok(txt.includes(v), "saknas: " + v);
    assert.ok(!/Radera min jämförelse/.test(txt), "ingen Radera i skrivskyddad vy");
    const hrefs = await page.$$eval("#rep a", (as) => as.map((a) => a.getAttribute("href")));
    assert.ok(hrefs.includes("/jamfor/kop/") && hrefs.every((x) => !/[#&]t=|angra|#o=/.test(String(x))), "bara neutral köplänk: " + JSON.stringify(hrefs));
    assert.equal(await page.locator("#angralink").count(), 0);
    assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem("jamfor_order"))), { id: OLD, token: TOK }, "gammal order orörd");
    assert.ok(await page.evaluate(() => !/#r=|&r=/.test(location.hash)), "token borttagen ur adressen");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "ingen sidoscroll");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});
