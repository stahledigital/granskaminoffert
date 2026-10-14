// D18-R1 (Codex D18-DYNAMIC-FIELD-01 + D18-FONT-SCOPE-01): verkliga, i JS byggda formulärfält i förkontrollens bekräftelseformulär
// (select + datum + text) har MR148-fält: bakgrund #2c2d31, kant #808185, text #f4f4f2, orange fokus. Villkorssidan har Barlow.
// Syntetisk förkontrollrapport (riktig buildCheckReport/checkOutputs), bara läsande GET-mockar; inga sparningar, betalningar eller serverändringar.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { startHarness } from "../../worker/dev/compare_harness.mjs";
import { buildCheckReport, checkOutputs } from "../../worker/src/compare_check.js";
import { sanitizeOffer } from "../../worker/src/compare_extract.js";
const PW = process.env.PLAYWRIGHT_MODULE || "/opt/npm-tools/node_modules/playwright/index.mjs";
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
const { chromium } = await import(pathToFileURL(PW).href);
let browser, h;
before(async () => { browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] }); h = await startHarness(); });
after(async () => { await browser?.close(); await h?.close(); });
const ID = "o_" + "d".repeat(32), KEY = "K".repeat(32);
const FEL = { jobType: "malning", areaM2: 30, laborSumSek: 20000, materialSumSek: 4000, rotAmountSek: 10000, vatMode: "exkl", totalSumSek: 29000, totalVatBasis: "inkl", priceType: "ungefarligt", propertyType: "smahus", customerType: "privatperson", trades: [], hourlyRateSek: null, hours: null, travelSumSek: null };
const R = buildCheckReport({ order: { id: ID }, offer: sanitizeOffer({ extracted: FEL, scope: [], facts: [], readability: { level: "bra" } }), label: "Din offert", now: Date.UTC(2026, 9, 11), receipt: { orderNo: "DDDDDDDD", product: "Förkontroll av min offert", amountOre: 4900, currency: "SEK" } });
const lum = (c) => c.map((x) => x / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)).reduce((a, x, i) => a + x * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => p - q); return (y + 0.05) / (x + 0.05); };
const rgb = (s) => s.match(/[\d.]+/g).slice(0, 3).map(Number);

for (const width of [375, 1280]) test(`${width}px förkontrollformulärets alla fält (även JS-byggda select/datum) är MR148-fält`, async () => {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, locale: "sv-SE" }); const page = await ctx.newPage(); const writes = [], errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route(/\/compare\/orders\/o_d+(\/.*)?$/, async (r) => {
    const q = r.request(), sub = new URL(q.url()).pathname.replace(/^.*\/compare\/orders\/o_d+/, ""), j = (b, s = 200) => r.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
    if (q.method() !== "GET") { writes.push(q.method() + sub); return j({ ok: false }, 405); }
    if (sub === "") return j({ ok: true, order: { id: ID, kind: "check", status: "delivered", docCount: 1, progress: { extracted: 1, total: 1, synth: "skipped" } }, pollMs: 2000 });
    if (sub === "/report") return j({ ok: true, report: R });
    if (sub === "/check") return j({ ok: true, revision: 0, saves: 0, exports: 0, limits: { saves: 12, exports: 12 }, values: {}, outputs: await checkOutputs(R, null) });
    return j({ ok: false }, 404);
  });
  try {
    await page.goto(h.base + "/jamfor/"); await page.evaluate(([o, t]) => localStorage.setItem("jamfor_order", JSON.stringify({ id: o, token: t })), [ID, KEY]);
    await page.reload(); await page.waitForSelector("#rep:not(.hidden) #ckform");
    const f = await page.$$eval("#ckform select, #ckform input:not([type=checkbox]):not([type=radio]):not([type=hidden]), #ckform textarea", (els) => els.map((e) => { const c = getComputedStyle(e); return { id: e.id, tag: e.tagName, type: e.type, bg: c.backgroundColor, bc: c.borderTopColor, bw: c.borderTopWidth, color: c.color }; }));
    for (const id of ["ck-priceType", "ck-rotMode", "ck-cleaning", "ck-removal", "ck-plannedStart", "ck-plannedEnd"]) assert.ok(f.some((x) => x.id === id), "fält finns: " + id);
    for (const x of f) {
      assert.equal(x.bg, "rgb(44, 45, 49)", `${x.id} bakgrund ${x.bg}`); assert.equal(x.bc, "rgb(128, 129, 133)", `${x.id} kant ${x.bc}`);
      assert.equal(x.bw, "1px", `${x.id} kantbredd`); assert.equal(x.color, "rgb(244, 244, 242)", `${x.id} text ${x.color}`);
      assert.ok(ratio(rgb(x.bc), rgb(x.bg)) >= 3, `${x.id} kant mot fält`); assert.ok(ratio(rgb(x.bc), [35, 36, 39]) >= 3, `${x.id} kant mot kort`);
    }
    await page.focus("#ck-priceType"); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
    const fo = await page.$eval("#ck-priceType", (e) => { const c = getComputedStyle(e); return { a: document.activeElement === e, s: c.outlineStyle, w: parseFloat(c.outlineWidth), c: c.outlineColor }; });
    if (fo.a) assert.ok(fo.s !== "none" && fo.w >= 3 && fo.c === "rgb(240, 100, 59)", JSON.stringify(fo));
    assert.deepEqual(writes, []); assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("villkorssidan använder Barlow (samma typsnitt som övriga sidor), text och laddning orörda", async () => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, locale: "sv-SE" }); const page = await ctx.newPage();
  try {
    await page.goto(h.base + "/jamfor/villkor/"); await page.evaluate(() => document.fonts.ready);
    const st = await page.evaluate(() => ({ body: getComputedStyle(document.body).fontFamily, h1: getComputedStyle(document.querySelector("h1")).fontFamily, loaded: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/["']/g, "") + " " + f.weight) }));
    assert.match(st.body, /^Barlow\b/); assert.match(st.h1, /^"?Barlow Condensed"?/);
    assert.ok(st.loaded.includes("Barlow 400"), JSON.stringify(st.loaded)); assert.ok(st.loaded.includes("Barlow Condensed 700"), JSON.stringify(st.loaded));
  } finally { await ctx.close(); }
});
