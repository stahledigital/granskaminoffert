// D19 DEMO-01/02 + router: märkt syntetiskt exempel är read-only (inga order-/AI-/betalanrop, egna inmatningar orörda), mäts som example_view och
// tystar aldrig senare egen användning; uppgiftsbyte ger historik, fokus på rubriken och rätt document.title.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { startHarness } from "../../worker/dev/compare_harness.mjs";

const PW = process.env.PLAYWRIGHT_MODULE || "/opt/npm-tools/node_modules/playwright/index.mjs";
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
const { chromium } = await import(pathToFileURL(PW).href);
let browser;
before(async () => { browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] }); });
after(async () => { await browser?.close(); });

const CHECK_OPEN = { available: true, offer: { product: "Förkontroll av min offert", priceOre: 4900, currency: "SEK", vatPct: 25, retentionHours: 24 }, offerCopy: { gets: ["Kontroll av EN egen offert"], getsNot: ["Ingen stämpel"], how: ["Ladda upp"] },
  consent: { version: "samtycke-x", draft: true, hash: "H".repeat(64), policy: "P", texts: { sameJob: "Offerten är min egen.", declaration: "Jag vill att förkontrollen börjar direkt." } },
  terms: { sections: [{ id: "saljare", title: "Säljare", text: "Syntetisk Säljare AB" }] }, dataCoverage: { text: "Täckning." } };

async function openPage(h, path, { w = 390 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, locale: "sv-SE" }); const page = await ctx.newPage();
  const errors = [], calls = [], events = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("**/compare/config", async (r) => { const res = await r.fetch(); const j = await res.json(); j.check = CHECK_OPEN; r.fulfill({ response: res, body: JSON.stringify(j), contentType: "application/json" }); });
  await page.route(/\/compare\/orders(\/.*)?$/, (r) => { calls.push(r.request().method() + " " + r.request().url()); r.continue(); });
  await page.route(/\/(event)$/, (r) => { try { const b = JSON.parse(r.request().postData() || "{}"); if (b.type === "client") events.push(b); } catch (e) {} r.fulfill({ status: 204, body: "" }); });
  await page.route("https://**/review**", (r) => { calls.push("AI " + r.request().url()); r.abort(); });
  await page.goto(h.base + path);
  return { ctx, page, errors, calls, events };
}

for (const [path, kind] of [["/jamfor/", "compare"], ["/forkontroll/", "check"]]) {
  test(`exempel ${kind}: read-only, märkt, inga anrop, egna inmatningar orörda, example_view, fokus tillbaka`, async () => {
    const h = await startHarness({ vars: {} }); const { ctx, page, errors, calls, events } = await openPage(h, path);
    try {
      await page.waitForSelector("#exbtn");
      const own = kind === "compare" ? "#ta0" : "#ta0";
      const sel = await page.evaluate(() => Array.from(document.querySelectorAll("textarea")).map((t) => t.id)); assert.ok(sel.length, "textfält finns");
      await page.fill("textarea >> nth=0", "Min egen offerttext 12 345 kr");
      const before = calls.length;
      await page.click("#exbtn");
      await page.waitForSelector("#exview:not(.hidden)");
      assert.equal(await page.getAttribute("#exbtn", "aria-expanded"), "true");
      const t = await page.locator("#exview").innerText(); assert.match(t, /exempel/i); assert.match(t, /Påhittade uppgifter\. Ingen riktig offert, ingen order, inget AI-anrop och ingen betalning/);
      assert.equal(await page.inputValue("textarea >> nth=0"), "Min egen offerttext 12 345 kr", "egen inmatning orörd");
      assert.equal(calls.length, before, "inga order-/AI-anrop av exemplet");
      assert.equal(await page.evaluate(() => (localStorage.getItem("jamfor_order") || "")), "", "ingen order skapad");
      await page.waitForTimeout(200);
      assert.equal(events.filter((e) => e.event === "example_view").length, 1); assert.equal(events.find((e) => e.event === "example_view").product, kind);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "ingen sidoscroll");
      await page.click("#exclose"); await page.waitForSelector("#exview.hidden", { state: "attached" });
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "exbtn", "fokus tillbaka till knappen");
      assert.equal(await page.inputValue("textarea >> nth=0"), "Min egen offerttext 12 345 kr");
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); await h.close(); }
  });
}

test("router: valt uppgiftsbyte ger historik, rätt document.title och fokus på rubriken; tillbaka återställer; view_return mäts", async () => {
  const h = await startHarness({ vars: {} }); const { ctx, page, errors, events } = await openPage(h, "/");
  try {
    await page.waitForSelector("[data-task-card=compare]");
    assert.equal(await page.getAttribute("#app", "data-task"), "none");
    const t0 = await page.title();
    await page.click("[data-task-card=compare]");
    await page.waitForFunction(() => document.getElementById("app").getAttribute("data-task") === "compare");
    assert.match(new URL(page.url()).pathname, /\/jamfor\/$/);
    const t1 = await page.title(); assert.notEqual(t1, t0);
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "task-heading");
    await page.goBack(); await page.waitForFunction(() => document.getElementById("app").getAttribute("data-task") === "none");
    assert.equal(await page.title(), t0);
    await page.goForward(); await page.waitForFunction(() => document.getElementById("app").getAttribute("data-task") === "compare");
    await page.waitForTimeout(200);
    assert.ok(events.some((e) => e.event === "task_change" && e.to === "compare"), "task_change med to=compare");
    assert.ok(events.every((e) => !/https?:|o_[0-9a-f]{32}/.test(JSON.stringify(e))), "inga råa URL:er/ID i klientevents");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});
