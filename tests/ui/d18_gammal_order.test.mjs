// D18 (Codex OWN_CHROME 2026-10-14): en återupptagen gammal order på /jamfor/ ska alltid ge kunden ett tydligt nästa steg.
// Syntetiska ordrar via route-mock mot riktiga paketerade Workern (harness). Inga riktiga ordrar, tokens, betalningar eller serverändringar.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { startHarness } from "../../worker/dev/compare_harness.mjs";
const PW = process.env.PLAYWRIGHT_MODULE || "/opt/npm-tools/node_modules/playwright/index.mjs";
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
const { chromium } = await import(pathToFileURL(PW).href);
let browser, h;
before(async () => { browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] }); h = await startHarness(); });
after(async () => { await browser?.close(); await h?.close(); });
const ID = "o_d18gammal0000000000", TOK = "t".repeat(43);
async function scenario(status, reportStatus, width) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, locale: "sv-SE" }); const page = await ctx.newPage();
  const errors = [], writes = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.route(/\/compare\/orders\/o_d18gammal/, (r) => {
    const q = r.request(); if (q.method() !== "GET") { writes.push(q.method() + " " + q.url()); return r.fulfill({ status: 405, body: "{}" }); }
    if (/\/report$/.test(q.url())) return r.fulfill({ status: reportStatus, contentType: "application/json", body: JSON.stringify({ ok: false, error: "borta" }) });
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, order: { id: ID, status, kind: "compare", docCount: 2 } }) });
  });
  await page.goto(h.base + "/jamfor/");
  await page.evaluate(([o, t]) => localStorage.setItem("jamfor_order", JSON.stringify({ id: o, token: t })), [ID, TOK]);
  await page.reload(); await page.waitForSelector("#statusbox p");
  return { ctx, page, errors, writes };
}
for (const width of [375, 1280]) {
  for (const [status, rs, text] of [["delivered", 410, /Rapporten har gått ut och är raderad\./], ["deleted", 200, /Jämförelsen är raderad\./], ["expired", 200, /Ordern har gått ut/]]) {
    test(`${width}px gammal order ${status}${status === "delivered" ? "/" + rs : ""}: samma besked + synlig Börja om som leder till nya uppladdningen`, async () => {
      const { ctx, page, errors, writes } = await scenario(status, rs, width);
      try {
        assert.match(await page.textContent("#statusbox"), text);
        const btn = page.locator("#statusbox button", { hasText: "Börja om" }); assert.equal(await btn.count(), 1); assert.ok(await btn.isVisible());
        await btn.click(); await page.waitForSelector("#s1:not(.hidden)");
        assert.equal(await page.evaluate(() => localStorage.getItem("jamfor_order")), null);
        assert.ok(await page.locator("#f0").isVisible(), "uppladdningsfältet syns");
        assert.deepEqual(writes, [], "inga skrivande anrop mot den gamla ordern"); assert.deepEqual(errors, []);
      } finally { await ctx.close(); }
    });
  }
}
