// D07 resume-UI: återupptagen obetald order visar/anger befintliga firmor och källor före betalning (390 px). Ingen ny order, inga dokument/AI, ingen checkout, ändrade källor ⇒ nytt aktivt samtycke.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { REVIEW_VARS, GOOGLE_VARS, TP_VARS } from "../../worker/test/helpers/compare_env.mjs";
import { startHarness } from "../../worker/dev/compare_harness.mjs";
const PW = process.env.PLAYWRIGHT_MODULE || "/opt/npm-tools/node_modules/playwright/index.mjs";
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
const { chromium } = await import(pathToFileURL(PW).href);
let browser;
before(async () => { browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] }); });
after(async () => { await browser?.close(); });
const ID = "o_" + "7".repeat(32), KEY = "K".repeat(32);
const firm = (i, name) => ({ id: "f_" + i, name, city: "Teststad", domain: "", offers: [i], conflict: false, origin: "dokument",
  google: { state: "vantar_foretagsval", text: "väntar på att du bekräftar rätt firma", placeId: null, confirmed: false, searchesLeft: 2 },
  trustpilot: { state: "vantar_foretagsval", text: "väntar på att du bekräftar rätt firma", placeId: null, confirmed: false, searchesLeft: 2 } });
const VIEW = { ok: true, sources: { active: true, firms: [firm(0, "Alfa Bygg AB"), firm(1, "Beta Bygg AB"), firm(2, "Gamma Bygg AB")], coverage: { active: true, firms: 3, lines: ["Källtäckning: 3 firmor, Google väntar på ditt val."], google: {}, trustpilot: {} } } };

test("D07 resume-UI: draft/ready ⇒ de 3 befintliga firmorna + Googles källor syns före betalning, rätt docCount, inget skickas; ändrade källor ⇒ nytt aktivt samtycke i stället för tyst retry", async () => {
  const h = await startHarness({ vars: { ...REVIEW_VARS, ...GOOGLE_VARS, ...TP_VARS } });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "sv-SE" }); const page = await ctx.newPage(); const errors = [], calls = []; page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await page.route(/\/compare\/orders(\/.*)?$/, (r) => { const q = r.request(), sub = new URL(q.url()).pathname.replace(/^.*\/compare\/orders/, ""); calls.push({ m: q.method(), sub, tok: q.headers()["x-order-token"], body: q.postData() });
      const j = (b, s = 200) => r.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
      if (sub === "/" + ID) return j({ ok: true, order: { id: ID, kind: "compare", status: "ready", docCount: 3, progress: { extracted: 0, total: 3, synth: "pending" } }, pollMs: 2000 });
      if (sub.startsWith("/" + ID + "/sources")) return j(VIEW);
      return j({ ok: false, error: "oväntat anrop" }, 404); });
    await page.goto(h.base + "/jamfor/"); await page.evaluate(([o, t]) => localStorage.setItem("jamfor_order", JSON.stringify({ id: o, token: t })), [ID, KEY]);
    await page.reload(); await page.waitForSelector("#srcfirms > *", { timeout: 6000 }).catch(async (e) => { console.log("DBG", JSON.stringify(calls), await page.evaluate(() => ({ off: document.getElementById("offer").className, sb: document.getElementById("statusbox").innerText, sf: document.getElementById("srcfirms").innerHTML.slice(0, 200) })), errors); throw e; });
    const t = (await page.locator("#offer").innerText()).replace(/\s+/g, " ");
    for (const n of ["Alfa Bygg AB", "Beta Bygg AB", "Gamma Bygg AB"]) assert.ok(t.includes(n), n + " saknas: " + t);
    assert.match(t, /Källtäckning: 3 firmor/); assert.ok(!/49 kr/.test(t), "ingen andra köpruta i källpanelen");
    assert.equal(await page.locator("#srcform .srcfirm").count(), 3, "3 firmor kan kompletteras (ort/webbplats)");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "ingen sidoscroll");
    assert.ok(calls.every((c) => c.m === "GET" || c.sub.includes("/sources")), JSON.stringify(calls)); assert.ok(calls.filter((c) => c.sub.includes("/sources")).every((c) => c.tok === KEY), "fullnyckel, aldrig r-token");
    assert.equal(calls.filter((c) => /checkout|\/docs\/|^\/$/.test(c.sub)).length, 0, "ingen checkout/dokument/ny order");
    // ändra källor ⇒ tyst retry avstängd, aktivt samtycke krävs
    await page.evaluate(() => { document.getElementById("srcmanual").open = true; }); await page.click("#srcgo"); await page.waitForTimeout(300);
    assert.ok(calls.some((c) => c.m === "PUT" && c.sub.endsWith("/sources/firms")), "firmor sparade via befintlig väg");
    await page.click("#statusbox button.btn.acc"); await page.waitForSelector("#email2");
    assert.match(await page.locator("#statusbox").innerText(), /ändrat källorna/); assert.equal(await page.locator("#decl2, #terms2").count() >= 1, true, "aktiv ruta att markera"); if (await page.locator("#decl2").count()) assert.equal(await page.locator("#pay2").isDisabled(), true); assert.equal(await page.locator("#decl2, #terms2, #immediate2").evaluateAll((a) => a.some((x) => x.checked)), false, "inget förbockat samtycke");
    assert.equal(calls.filter((c) => /checkout/.test(c.sub)).length, 0, "ingen checkout utan nytt aktivt samtycke");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});
