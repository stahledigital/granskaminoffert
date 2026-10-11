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
    assert.equal(await page.locator("#srcresume [data-resume]").count(), 3, "3 offerter kan ändras via Ändra företag");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "ingen sidoscroll");
    assert.ok(calls.every((c) => c.m === "GET" || c.sub.includes("/sources")), JSON.stringify(calls)); assert.ok(calls.filter((c) => c.sub.includes("/sources")).every((c) => c.tok === KEY), "fullnyckel, aldrig r-token");
    assert.equal(calls.filter((c) => /checkout|\/docs\/|^\/$/.test(c.sub)).length, 0, "ingen checkout/dokument/ny order");
    // ändra källor ⇒ tyst retry avstängd, aktivt samtycke krävs
    await page.click('#srcresume [data-resume="1"] button'); await page.fill("#se-n1", "Beta Bygg Ny AB"); await page.click(".srcedit .btn.acc"); await page.waitForTimeout(300);
    assert.ok(calls.some((c) => c.m === "PUT" && c.sub.endsWith("/sources/firms")), "firmor sparade via befintlig väg");
    await page.click("#statusbox button.btn.acc"); await page.waitForSelector("#email2");
    assert.match(await page.locator("#statusbox").innerText(), /ändrat källorna/); assert.equal(await page.locator("#decl2, #terms2").count() >= 1, true, "aktiv ruta att markera"); if (await page.locator("#decl2").count()) assert.equal(await page.locator("#pay2").isDisabled(), true); assert.equal(await page.locator("#decl2, #terms2, #immediate2").evaluateAll((a) => a.some((x) => x.checked)), false, "inget förbockat samtycke");
    assert.equal(calls.filter((c) => /checkout/.test(c.sub)).length, 0, "ingen checkout utan nytt aktivt samtycke");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

test("D07 resume-UI (0 firmor / 2 dokument): riktiga etiketter föreslås men sparas aldrig tyst, standardnamn föreslås inte, kunden anger/ändrar per offert via fullnyckel, täckning uppdateras, nytt aktivt samtycke; intro lovar bara aktiva leverantörer", async () => {
  const h = await startHarness({ vars: { ...REVIEW_VARS, ...GOOGLE_VARS } });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "sv-SE" }); const page = await ctx.newPage(); const errors = [], calls = []; page.on("pageerror", (e) => errors.push(String(e)));
  try {
    let view = { ok: true, sources: { active: true, firms: [], coverage: { active: true, firms: 0, lines: ["Inga firmor angivna än."], google: {}, trustpilot: {} } } };
    await page.route(/\/compare\/orders(\/.*)?$/, (r) => { const q = r.request(), sub = new URL(q.url()).pathname.replace(/^.*\/compare\/orders/, ""); calls.push({ m: q.method(), sub, tok: q.headers()["x-order-token"], body: q.postData() ? JSON.parse(q.postData()) : null });
      const j = (b, s = 200) => r.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
      if (sub === "/" + ID) return j({ ok: true, order: { id: ID, kind: "compare", status: "ready", docCount: 2, labels: ["Offert 1", "Riktig Bygg AB"], progress: { extracted: 0, total: 2, synth: "pending" } }, pollMs: 2000 });
      if (sub === "/" + ID + "/sources/firms" && q.method() === "PUT") { const rows = JSON.parse(q.postData()).firms; view = { ok: true, sources: { active: true, firms: rows.map((x, i) => ({ ...firm(x.offerIndex, x.name), city: x.city, domain: x.domain })), coverage: { active: true, firms: rows.length, lines: ["Källtäckning: " + rows.length + " firma."], google: {}, trustpilot: {} } } }; return j(view); }
      if (sub.startsWith("/" + ID + "/sources")) return j(view);
      return j({ ok: false }, 404); });
    await page.goto(h.base + "/jamfor/"); await page.evaluate(([o, t]) => localStorage.setItem("jamfor_order", JSON.stringify({ id: o, token: t })), [ID, KEY]);
    await page.reload(); await page.waitForSelector("#srcresume [data-resume]");
    assert.equal(await page.locator("#srcresume [data-resume]").count(), 2); assert.match(await page.locator("#srcresume").innerText(), /Offert 1: inget företag angivet[\s\S]*Offert 2: inget företag angivet/);
    const intro = await page.locator("#srcintro").innerText(); assert.match(intro, /^Googles egna omdömen/); assert.ok(!/Trustpilot/.test(intro), "bara aktiva leverantörer: " + intro);
    await page.click('#srcresume [data-resume="0"] button'); assert.equal(await page.inputValue("#se-n0"), "", "standardnamnet 'Offert 1' föreslås inte som företag");
    await page.click('#srcresume [data-resume="1"] button'); assert.equal(await page.inputValue("#se-n1"), "Riktig Bygg AB", "riktig etikett föreslås");
    assert.equal(calls.filter((c) => c.m === "PUT").length, 0, "inget sparas tyst");
    await page.fill("#se-c1", "Växjö"); await page.click('.srcedit[data-offer="1"] .btn.acc'); await page.waitForFunction(() => /Offert 2: Riktig Bygg AB, Växjö/.test(document.getElementById("srcresume").innerText));
    const put = calls.filter((c) => c.m === "PUT"); assert.equal(put.length, 1); assert.equal(put[0].tok, KEY, "originalfullnyckel"); assert.deepEqual(put[0].body.firms.map((f) => [f.offerIndex, f.name, f.city, f.origin]), [[1, "Riktig Bygg AB", "Växjö", "kund"]]);
    assert.match(await page.locator("#srccov").innerText(), /Källtäckning: 1 firma/); assert.match(await page.locator('#srcresume [data-resume="1"] button').innerText(), /Ändra företag/);
    await page.click("#statusbox button.btn.acc"); await page.waitForSelector("#email2"); assert.equal(calls.filter((c) => /checkout/.test(c.sub)).length, 0); assert.equal(calls.filter((c) => c.m === "POST").length, 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)); assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

test("D07 resume-UI visningskontroll: source-only döljer även label[for=email] (inline display), srcbox synlig; normala köpflödets e-postfält/label synliga", async () => {
  const h = await startHarness({ vars: { ...REVIEW_VARS, ...GOOGLE_VARS } });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "sv-SE" }); const page = await ctx.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await page.route(/\/compare\/orders(\/.*)?$/, (r) => { const sub = new URL(r.request().url()).pathname.replace(/^.*\/compare\/orders/, ""); const j = (b, s = 200) => r.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
      if (sub === "/" + ID) return j({ ok: true, order: { id: ID, kind: "compare", status: "ready", docCount: 2, labels: ["Offert 1", "Offert 2"], progress: { extracted: 0, total: 2, synth: "pending" } }, pollMs: 2000 });
      if (sub.startsWith("/" + ID + "/sources")) return j({ ok: true, sources: { active: true, firms: [], coverage: { active: true, firms: 0, lines: [], google: {}, trustpilot: {} } } }); return j({ ok: false }, 404); });
    await page.goto(h.base + "/jamfor/"); await page.evaluate(([o, t]) => localStorage.setItem("jamfor_order", JSON.stringify({ id: o, token: t })), [ID, KEY]);
    await page.reload(); await page.waitForSelector("#srcresume [data-resume]");
    assert.equal(await page.locator('label[for="email"]').isVisible(), false, "label[for=email] dold i source-only"); assert.equal(await page.locator("#email").isVisible(), false); assert.equal(await page.locator("#pay").isVisible(), false);
    assert.equal(await page.locator("#srcbox").isVisible(), true, "srcbox synlig");
    // normala köpflödet: fältet/labeln synliga när srconly inte är satt
    await page.evaluate(() => { const o = document.getElementById("offer"); o.classList.remove("srconly"); });
    assert.equal(await page.locator('label[for="email"]').isVisible(), true); assert.equal(await page.locator("#email").isVisible(), true);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});
