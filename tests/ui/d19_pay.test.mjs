// D19 WP-D (betalvägen): mätevents, delvis-felrättning via PUT samma idx, "Avsluta utkastet", submit-lås, 8/20 MB, korta sanna integritets-/företagsuppgifter
// och förkontrollens revision-0-förslag med en enda aktiv bekräftelse + proveniens (CHECK-01..04). Attrapper för modell/Stripe; ingen produktion.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { startHarness } from "../../worker/dev/compare_harness.mjs";
import { buildCheckReport, validateConfirmation, checkOutputs, customerAttachmentPdf } from "../../worker/src/compare_check.js";
import { sanitizeOffer } from "../../worker/src/compare_extract.js";
import { b64Bytes } from "../../worker/src/compare_pdf.js";
import { normalizeClientEvent } from "../../worker/src/measure.js";

const PW = process.env.PLAYWRIGHT_MODULE || "/opt/npm-tools/node_modules/playwright/index.mjs";
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
const { chromium } = await import(pathToFileURL(PW).href);
let browser;
before(async () => { browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] }); });
after(async () => { await browser?.close(); });
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };

const ID = "o_" + "c".repeat(32), KEY = "K".repeat(32), TOK = "R".repeat(32);
const FEL0 = { jobType: "malning", areaM2: 30, laborSumSek: 20000, materialSumSek: 4000, rotAmountSek: 10000, vatMode: "exkl", totalSumSek: 29000, totalVatBasis: "inkl", priceType: "ungefarligt", propertyType: "smahus", customerType: "privatperson", trades: [], hourlyRateSek: null, hours: null, travelSumSek: null };
function report(fel = FEL0) {
  const offer = sanitizeOffer({ extracted: fel, scope: [], facts: [], readability: { level: "bra" } });
  const R = buildCheckReport({ order: { id: ID }, offer, label: "Din offert", now: Date.UTC(2026, 9, 11), receipt: { orderNo: "CCCCCCCC", product: "Förkontroll av min offert", amountOre: 4900, currency: "SEK" } });
  return R;
}

// Servertestdubbel som kör den RIKTIGA valideringen/utdata-/PDF-koden; token avgör behörighet precis som Workern (resultatlänkens r-token får bara läsa rapporten).
async function mount(page, R, log, { maxSaves = 12, getDelay = null } = {}) {
  const st = { revision: 0, values: {}, saves: 0, exports: 0 };
  const view = async () => ({ ok: true, revision: st.revision, saves: st.saves, exports: st.exports, limits: { saves: maxSaves, exports: 12 }, values: st.values, outputs: await checkOutputs(R, st.revision ? st : null) });
  await page.route(/\/compare\/orders\/o_c+(\/.*)?$/, async (route) => {
    const q = route.request(), u = new URL(q.url()), sub = u.pathname.replace(/^.*\/compare\/orders\/o_c+/, ""), tok = q.headers()["x-order-token"], j = (b, s = 200) => route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
    log.push({ m: q.method(), sub, tok });
    if (sub === "") return j({ ok: true, order: { id: ID, kind: "check", status: "delivered", docCount: 1, progress: { extracted: 1, total: 1, synth: "skipped" } }, pollMs: 2000 });
    if (sub === "/report") return j({ ok: true, report: R });
    if (tok !== KEY) return j({ ok: false, error: "Ordern hittades inte." }, 404);
    if (sub === "/check" && q.method() === "GET") { if (getDelay && getDelay.p) await getDelay.p; return j(await view()); }
    if (sub === "/check" && q.method() === "PUT") {
      const v = validateConfirmation(JSON.parse(q.postData()).values); if (v.error) return j({ ok: false, error: "ogiltig", message: v.error }, 400);
      if (JSON.stringify(v.values) === JSON.stringify(st.values) && st.revision) return j({ ...(await view()), unchanged: true });
      if (st.saves >= maxSaves) return j({ ok: false, error: "gransen" }, 429);
      st.values = v.values; st.revision++; st.saves++; return j(await view());
    }
    if (sub === "/check/export") { const rb = JSON.parse(q.postData() || "{}").revision; if (Number.isInteger(rb) && rb !== st.revision) return j({ ok: false, error: "En nyare revision finns.", revisionChanged: true, ...(await view()) }, 409); st.exports++; const { pdf, out } = await customerAttachmentPdf(R, st, { orderNo: "CCCCCCCC" }); return j({ ok: true, revision: out.revision, code: out.code, text: out.text, filename: `Tillagg-till-offert-rev${out.revision}.pdf`, pdfBase64: Buffer.from(pdf).toString("base64"), exports: st.exports }); }
    return j({ ok: false }, 404);
  });
  return st;
}
async function open(h, { stored, hash }) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "sv-SE", acceptDownloads: true }); const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(h.base + "/jamfor/");
  if (stored) await page.evaluate(([o, t]) => localStorage.setItem("jamfor_order", JSON.stringify({ id: o, token: t })), [ID, KEY]);
  return { ctx, page, errors };
}

const FEL_INKL = { ...FEL0, vatMode: "inkl", laborSumSek: 20000, materialSumSek: 4000, otherSumSek: null, totalSumSek: 24000, totalVatBasis: "inkl" };
const events = async (page) => { const ev = []; await page.route("**/event", (r) => { if (r.request().method() !== "OPTIONS") { try { ev.push(r.request().postDataJSON()); } catch {} } return r.fulfill({ status: 204, headers: CORS }); }); return ev; };
const form = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#ckform [data-ck]")].map((e) => [e.getAttribute("data-ck"), e.value])));
const tags = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#ckform .cktag")].map((e) => [e.id.replace("cktag-", ""), e.classList.contains("hidden") ? "" : e.getAttribute("data-st")])));
const booted = async (fel, opts = {}) => {
  const h = await startHarness({ vars: {} }); const R = report(fel), log = []; const o = await open(h, { stored: true });
  const st = await mount(o.page, R, log, opts); return { h, R, log, st, ...o };
};

test("CHECK-01/02: revision 0 – bara giltig pristyp och hela inkl-belopp föreslås, obekräftat, en banner, EN aktiv bekräftelse, ingen PUT före den", async () => {
  const { h, log, ctx, page, errors } = await booted(FEL_INKL);
  try {
    await page.reload(); await page.waitForSelector("#ckform");
    await page.waitForFunction(() => document.getElementById("ck-laborInclVat").value === "20000");
    const f = await form(page), t = await tags(page);
    assert.equal(f.priceType, "ungefarligt"); assert.equal(f.laborInclVat, "20000"); assert.equal(f.materialInclVat, "4000");
    assert.equal(f.otherInclVat, "", "null blir aldrig 0"); assert.equal(f.rotMode, ""); assert.equal(f.plannedStart, ""); assert.equal(f.warranty, ""); assert.equal(f.includes, ""); assert.equal(f.cleaning, "");
    assert.equal(t.laborInclVat, "suggested"); assert.equal(t.priceType, "suggested"); assert.equal(t.otherInclVat, "");
    assert.ok(await page.locator("#ckbanner:not(.hidden)").count() === 1, "kort banner");
    assert.match((await page.locator("#ckbanner").innerText()).replace(/\s+/g, " "), /inte bekräftade/);
    assert.equal(await page.locator("#ckform input[type=checkbox]").count(), 0, "inga rutor att kryssa");
    assert.equal(await page.locator("#cksave").innerText(), "Bekräfta uppgifterna och skapa tillägg");
    assert.equal(log.filter((l) => l.m === "PUT" || l.sub === "/check/export").length, 0, "ingen PUT/revision/PDF före bekräftelse");
    assert.equal(await page.locator("#ckrev, [data-section]").count(), 0);
    await page.click("#cksave"); await page.waitForSelector("#ckrev");
    assert.equal(log.filter((l) => l.m === "PUT").length, 1);
    const t2 = await tags(page); assert.equal(t2.laborInclVat, "confirmed"); assert.ok(await page.locator("#ckbanner.hidden").count() === 1);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

test("CHECK-02: exkl/okänd radmoms, decimal, null och totalens egen momsbas ger inga gissade belopp; kort lokal hjälp", async () => {
  for (const [fel, why] of [[FEL0, /exklusive moms/], [{ ...FEL_INKL, vatMode: "okand" }, /momsbasen/i], [{ ...FEL_INKL, laborSumSek: 20000.5 }, /helt antal kronor/]]) {
    const { h, ctx, page } = await booted(fel);
    try {
      await page.reload(); await page.waitForSelector("#ckform"); await page.waitForTimeout(300);
      const f = await form(page);
      if (fel.vatMode !== "inkl") { assert.equal(f.laborInclVat, ""); assert.equal(f.materialInclVat, ""); }
      else { assert.equal(f.laborInclVat, "", "decimal föreslås inte"); assert.equal(f.materialInclVat, "4000"); }
      assert.equal(f.otherInclVat, ""); assert.equal(f.plannedStart, ""); assert.equal(f.plannedEnd, ""); assert.equal(f.warranty, ""); assert.equal(f.rotMode, "");
      const help = (await page.locator('[data-help="laborInclVat"]').innerText()).replace(/\s+/g, " "); assert.match(help, why);
    } finally { await ctx.close(); await h.close(); }
  }
});

test("CHECK-03: eget ändrat/tömt fält överlever sent GET och route fram/tillbaka; sparad revision går före AI; osparade ändringar märks", async () => {
  let release; const getDelay = { p: null };
  const h = await startHarness({ vars: {} }); const R = report(FEL_INKL), log = []; const { ctx, page, errors } = await open(h, { stored: true });
  try {
    const st = await mount(page, R, log, { getDelay });
    await page.reload(); await page.waitForSelector("#ckform"); await page.waitForFunction(() => document.getElementById("ck-materialInclVat").value === "4000");
    getDelay.p = new Promise((r) => { release = r; });
    // ny montering (router) – GET dröjer; kunden ändrar och tömmer förslag INNAN det svarar
    await page.evaluate(() => GMO.go("free", { push: true, reason: "user", force: true })); await page.waitForTimeout(200);
    await page.goBack(); await page.waitForSelector("#ckform");
    await page.fill("#ck-laborInclVat", "26000"); await page.fill("#ck-materialInclVat", "");
    release(); await page.waitForTimeout(500); getDelay.p = null;
    let f = await form(page), t = await tags(page);
    assert.equal(f.laborInclVat, "26000"); assert.equal(f.materialInclVat, "", "tömt fält fylls aldrig tillbaka"); assert.equal(f.priceType, "ungefarligt", "orört förslag fylls fortfarande i");
    assert.equal(t.laborInclVat, "dirty"); assert.equal(t.materialInclVat, "cleared");
    // route bort och tillbaka
    await page.evaluate(() => GMO.go("free", { push: true, reason: "user", force: true })); await page.waitForTimeout(200);
    await page.goBack(); await page.waitForSelector("#ckform");
    f = await form(page); t = await tags(page);
    assert.equal(f.laborInclVat, "26000"); assert.equal(f.materialInclVat, ""); assert.equal(t.laborInclVat, "dirty"); assert.equal(t.materialInclVat, "cleared");
    assert.equal(log.filter((l) => l.m === "PUT").length, 0, "ingen automatisk revision");
    // aktiv bekräftelse ⇒ revision 1 med kundens värden
    await page.click("#cksave"); await page.waitForSelector("#ckrev");
    assert.equal(st.revision, 1); assert.equal(st.values.laborInclVat, 26000); assert.equal(st.values.materialInclVat, undefined);
    // åter upp: sparad revision går före AI-förslaget (20000)
    await page.reload(); await page.waitForSelector("#ckform"); await page.waitForSelector("#ckrev");
    f = await form(page); t = await tags(page);
    assert.equal(f.laborInclVat, "26000"); assert.equal(t.laborInclVat, "confirmed"); assert.equal(f.materialInclVat, "", "tömt i den sparade revisionen förblir tomt – AI-förslaget återinförs inte");
    assert.match(await page.locator("#ckrev").innerText(), /senast bekräftad revision 1/);
    // osparad ändring efter revision märks och PDF:en är den bekräftade
    await page.fill("#ck-laborInclVat", "27000");
    assert.ok(await page.locator("#ckunsaved:not(.hidden)").count() === 1);
    assert.match((await page.locator("#ckunsaved").innerText()).replace(/\s+/g, " "), /revision 1/);
    assert.match(await page.locator("#ckpdf").innerText(), /revision 1/);
    assert.equal(st.revision, 1, "ingen ny revision utan aktiv bekräftelse");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

test("CHECK-04: skrivskyddad rapport har inget formulär, ingen PUT och en legitim ägarväg utan nytt köp", async () => {
  const h = await startHarness({ vars: {} }); const R = report(FEL_INKL), log = []; const { ctx, page, errors } = await open(h, { stored: false });
  try {
    await mount(page, R, log); const ev = await events(page);
    await page.goto(h.base + `/jamfor/#o=${ID}&r=${TOK}`); await page.reload(); await page.waitForSelector("#rep:not(.hidden) #ckro"); await page.waitForTimeout(300);
    const rv = ev.filter((e) => e.event === "result_view"); assert.equal(rv.length, 1); assert.equal(rv[0].mode, "readonly"); assert.equal(rv[0].stage, "result"); for (const e of ev) assert.ok(normalizeClientEvent(e), JSON.stringify(e));
    assert.equal(await page.locator("#ckform").count(), 0); const t = (await page.locator("#ckro").innerText()).replace(/\s+/g, " ");
    assert.match(t, /Du behöver inte köpa igen/); assert.match(t, /ursprungliga länken/);
    assert.equal(log.filter((l) => l.m === "PUT").length, 0); assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

// ---------- jämförelse: start, delvis fel, Avsluta utkastet, storlek, mätning, integritet ----------
const TXT = ["Offert badrum, Byggfirma AB\nRivning och bortforsling ingår.\nTotalt 100 000 kr inkl. moms före ROT", "Offert badrum, Bygg B\nRivning ingår.\nTotalt 90 000 kr exkl. moms före ROT"];
async function cmpPage(h) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "sv-SE" }); const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e))); page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const ev = await events(page); const calls = []; page.on("request", (r) => { const u = new URL(r.url()); if (/\/compare\//.test(u.pathname)) calls.push(r.method() + " " + u.pathname.replace(/o_[0-9a-f]{32}/, "o_X")); });
  await page.goto(h.base + "/jamfor/"); await page.waitForSelector("#s1:not(.hidden)");
  return { ctx, page, errors, ev, calls };
}
async function fillTwo(page) { await page.fill("#t0", TXT[0]); await page.fill("#t1", TXT[1]); await page.check("#samejob"); }
const count = (calls, re) => calls.filter((c) => re.test(c)).length;

test("COUNT-01/ERROR-01/INPUT-02: delvis fel ⇒ per-rad Försök igen via PUT samma idx, samma order, inget omstart; dubbelklick ger en start; mätning utan innehåll", async () => {
  const h = await startHarness(); const { ctx, page, errors, ev, calls } = await cmpPage(h);
  try {
    let fails = 1;
    await page.route(/\/compare\/orders\/o_[0-9a-f]+\/docs\/1$/, (route) => { if (route.request().method() === "PUT" && fails-- > 0) return route.fulfill({ status: 503, headers: CORS, contentType: "application/json", body: JSON.stringify({ error: "Tillfälligt fel hos tjänsten." }) }); return route.fallback(); });
    await fillTwo(page);
    // inputs_ready kommer en gång när båda platserna är klara
    assert.equal(ev.filter((e) => e.event === "inputs_ready").length, 1); assert.equal(ev.filter((e) => e.event === "input_ready").length, 2);
    await page.evaluate(() => { const b = document.getElementById("check"); b.click(); b.click(); b.click(); });
    await page.waitForSelector("#retry1"); 
    assert.equal(count(calls, /^POST \/compare\/orders$/), 1, "dubbelklick ⇒ exakt en order");
    assert.equal(ev.filter((e) => e.event === "submit").length, 1, "blockerat dubbelklick ger ingen extra submit");
    assert.match((await page.locator('[data-row="0"] .tag').innerText()), /Klar/); assert.match(await page.locator('[data-row="1"] .tag').innerText(), /Tillfälligt fel/);
    assert.ok(await page.locator("#offer.hidden").count() === 1, "ingen betalning/erbjudande förrän alla offerter är mottagna");
    assert.ok(await page.locator("#docsnote").count() === 1 && await page.locator("#cdraft-open").count() === 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "ingen sidoscroll med felrad");
    await page.click("#retry1"); await page.waitForSelector("#offer:not(.hidden)");
    assert.equal(count(calls, /^POST \/compare\/orders$/), 1, "retry skapar ingen ny order"); assert.equal(count(calls, /^PUT \/compare\/orders\/o_X\/docs\/1$/), 2); assert.equal(count(calls, /^PUT \/compare\/orders\/o_X\/docs\/0$/), 1, "klar offert laddas inte upp igen");
    const err = ev.filter((e) => e.event === "client_error"); assert.equal(err.length, 1); assert.equal(err[0].reason, "server"); assert.equal(err[0].stage, "submit"); assert.equal(err[0].product, "compare");
    const all = JSON.stringify(ev); assert.ok(!/Byggfirma|Bygg B|100 000|o_[0-9a-f]{32}|token/i.test(all), "inga innehåll/ID i mätningen");
    for (const e of ev) { assert.ok(JSON.stringify(e).length <= 1024); assert.ok(normalizeClientEvent(e), "servern accepterar: " + JSON.stringify(e)); }
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

test("ERROR-01: 413, nätverksfel och omöjlig fil ger begripliga rader; Byt fil ersätter samma idx och kör om utan ny order", async () => {
  const h = await startHarness(); const { ctx, page, errors, ev, calls } = await cmpPage(h);
  try {
    let mode = "413";
    await page.route(/\/compare\/orders\/o_[0-9a-f]+\/docs\/0$/, (route) => { if (route.request().method() !== "PUT") return route.fallback(); if (mode === "413") return route.fulfill({ status: 413, headers: CORS, contentType: "application/json", body: JSON.stringify({ error: "Filen är för stor (max 8 MB)." }) }); if (mode === "net") return route.abort("connectionreset"); return route.fallback(); });
    await fillTwo(page); await page.click("#check"); await page.waitForSelector("#retry0");
    assert.match(await page.locator('[data-row="0"] .tag').innerText(), /för stor/); assert.ok(ev.some((e) => e.event === "client_error" && e.reason === "size"));
    mode = "net"; await page.click("#retry0"); await page.waitForFunction(() => /nådde inte tjänsten/.test(document.querySelector('[data-row="0"] .tag').textContent));
    await page.waitForTimeout(300); assert.ok(ev.some((e) => e.event === "client_error" && e.reason === "network"));
    mode = "ok"; await page.setInputFiles("#swap0", { name: "offert.txt", mimeType: "text/plain", buffer: Buffer.from(TXT[0]) });
    await page.waitForSelector("#offer:not(.hidden)");
    assert.equal(count(calls, /^POST \/compare\/orders$/), 1); for (const e of ev) assert.ok(normalizeClientEvent(e), "servern accepterar: " + JSON.stringify(e)); assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

test("COUNT-01: Avsluta utkastet – tvåstegs bekräftelse, close-draft (aldrig GET-sedan-DELETE), lokalt utkast bevaras; 409 bevarar ordern och erbjuder återupptagning", async () => {
  const h = await startHarness(); const { ctx, page, errors, ev, calls } = await cmpPage(h);
  try {
    await page.route(/\/compare\/orders\/o_[0-9a-f]+\/docs\/1$/, (route) => route.request().method() === "PUT" ? route.fulfill({ status: 503, headers: CORS, contentType: "application/json", body: JSON.stringify({ error: "Tillfälligt fel hos tjänsten." }) }) : route.fallback());
    await fillTwo(page); await page.click("#check"); await page.waitForSelector("#cdraft-open");
    await page.click("#cdraft-open"); assert.ok(await page.locator("#cdraft-conf:not(.hidden)").count() === 1); assert.equal(count(calls, /close-draft|DELETE/), 0, "ingen radering före andra steget");
    await page.click("#cdraft-no"); assert.ok(await page.locator("#cdraft-conf.hidden").count() === 1);
    // vägrad: servern säger kassa ⇒ ordern bevaras
    await page.route(/close-draft$/, (route) => route.fulfill({ status: 409, headers: CORS, contentType: "application/json", body: JSON.stringify({ error: "x", kept: true, reason: "kassa" }) }), { times: 1 });
    await page.click("#cdraft-open"); await page.click("#cdraft-yes"); await page.waitForSelector("#cdraft-resume");
    assert.ok(await page.evaluate(() => !!JSON.parse(localStorage.getItem("jamfor_order") || "null")), "sparad order orörd vid vägran"); assert.match(await page.locator("#cdraft-msg").innerText(), /Betalningen har påbörjats/);
    // godkänd: servern raderar ⇒ sparad order släpps, lokala offerter kvar
    await page.click("#cdraft-no").catch(() => {}); await page.click("#cdraft-open").catch(() => {});
    await page.click("#cdraft-yes"); await page.waitForSelector("#s1:not(.hidden)");
    assert.equal(count(calls, /^POST \/compare\/orders\/o_X\/close-draft$/), 2); assert.equal(count(calls, /^DELETE /), 0, "aldrig GET-sedan-DELETE");
    assert.equal(await page.evaluate(() => localStorage.getItem("jamfor_order")), null);
    assert.equal(await page.inputValue("#t0"), TXT[0], "lokalt utkast bevaras"); assert.match(await page.locator("#receipt").innerText(), /Utkastet är avslutat/);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

test("LIMITS-01: 8 MB per fil och 20 MB totalt nekas direkt med begripligt besked utan anrop; tidigare inmatning orörd", async () => {
  const h = await startHarness(); const { ctx, page, errors, ev, calls } = await cmpPage(h);
  try {
    await page.fill("#t0", TXT[0]);
    await page.setInputFiles("#f0", { name: "stor.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(9_000_000, 1) });
    assert.match(await page.locator("#se0").innerText(), /för stor \(9 MB, högst 8 MB\)/); assert.equal(await page.inputValue("#t0"), TXT[0], "texten kvar");
    assert.ok(ev.some((e) => e.event === "client_error" && e.reason === "size" && e.stage === "input"));
    await page.click('.seg button[data-n="3"]');
    for (const i of [0, 1, 2]) await page.setInputFiles("#f" + i, { name: "o" + i + ".pdf", mimeType: "application/pdf", buffer: Buffer.alloc(7_500_000, 1) });
    await page.check("#samejob"); await page.click("#check");
    assert.match(await page.locator("#err").innerText(), /tillsammans för stora/); assert.equal(count(calls, /^POST \/compare\/orders$/), 0, "inget anrop när totalen är för stor");
    for (const e of ev) assert.ok(normalizeClientEvent(e), "servern accepterar: " + JSON.stringify(e));
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

test("PRIVACY-01/IDENTITY-01: kort sann AI-/lagringsinfo och företagsuppgift före överföring i jämförelse och förkontroll – utan garantier", async () => {
  const h = await startHarness({ vars: { CHECK_ENABLED: "1" } });
  try {
    for (const [path, sel] of [["/jamfor/", "#s1:not(.hidden)"]]) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const page = await ctx.newPage(); await page.goto(h.base + path); await page.waitForSelector(sel);
      const t = (await page.locator("#privinfo").innerText()).replace(/\s+/g, " ");
      assert.match(t, /Anthropic/); assert.match(t, /lagras de hos oss/); assert.match(t, /raderas 24 timmar efter leverans/); assert.match(t, /Betalningen hanteras av Stripe/);
      assert.doesNotMatch(t, /aldrig lagr|tränas|träning|garanti|måste (dölja|maskera)/i);
      assert.equal(await page.locator('#privinfo a[href="/jamfor/villkor/#personuppgifter"]').count(), 1, "detaljer nåbara");
      const seller = await page.evaluate(() => fetch((window.GMO.API_BASE || "") + "/compare/config").then((r) => r.json()).then((c) => c.terms && c.terms.seller).catch(() => null));
      if (seller && seller.name && !seller.name.startsWith("[")) assert.ok(t.includes(seller.name) && (!seller.email || t.includes(seller.email)), "företagsform/kontakt ur befintliga uppgifter");
      else assert.ok(!/\[/.test(t) && /Ståhle Digital/.test(t), "ifylld platshållare visas aldrig som fakta");
      await ctx.close();
    }
  } finally { await h.close(); }
});

test("PRIVACY-01 (förkontroll): kort sann info och länk före uppladdning; 8 MB nekas lokalt; delvis misslyckad start återanvänder samma utkast och kan avslutas", async () => {
  const h = await startHarness({ vars: {} });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "sv-SE" }); const page = await ctx.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  const ev = await events(page); const calls = []; page.on("request", (r) => { const u = new URL(r.url()); if (/\/compare\//.test(u.pathname)) calls.push(r.method() + " " + u.pathname.replace(/o_[0-9a-f]{32}/, "o_X")); });
  try {
    const CFG = { ok: true, enabled: true, accepting: true, limits: { maxFileBytes: 8000000, maxTotalBytes: 20000000 }, check: { available: true, offer: { product: "Förkontroll av min offert", priceOre: 4900, currency: "SEK", vatPct: 25, retentionHours: 24 },
      offerCopy: { gets: ["Kontroll av EN egen offert"], getsNot: ["Ingen stämpel"], how: ["Ladda upp"] },
      consent: { version: "samtycke-x", draft: true, hash: "H".repeat(64), policy: "P", texts: { sameJob: "Offerten är min egen.", declaration: "Jag vill att förkontrollen börjar direkt." } }, terms: { sections: [] } }, terms: { seller: { name: "[Säljare – fylls i]", email: "[x]" }, sections: [] }, consent: { policy: "P" } };
    await page.route("**/compare/config", (r) => r.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify(CFG) }));
    await page.goto(h.base + "/forkontroll/"); await page.waitForSelector("#s1:not(.hidden)");
    const t = (await page.locator("#privinfo").innerText()).replace(/\s+/g, " ");
    assert.match(t, /Anthropic/); assert.match(t, /lagras de hos oss|lagras den hos oss/); assert.match(t, /24 timmar efter leverans/); assert.doesNotMatch(t, /aldrig lagr|träning|tränas|garanti/i); assert.ok(!/\[/.test(t));
    assert.equal(await page.locator('#privinfo a[href="/jamfor/villkor/#personuppgifter"]').count(), 1);
    await page.setInputFiles("#f0", { name: "stor.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(9_000_000, 1) });
    assert.match(await page.locator("#fi0").innerText(), /för stor/); await page.waitForTimeout(250); assert.ok(ev.some((e) => e.event === "client_error" && e.reason === "size" && e.product === "check"));
    // lås: dubbelklick ger en order; PUT misslyckas ⇒ samma utkast återanvänds vid nästa Fortsätt
    let fail = 1; await page.route(/\/compare\/orders\/o_[0-9a-f]+\/docs\/0$/, (route) => { if (route.request().method() === "PUT" && fail-- > 0) return route.fulfill({ status: 503, headers: CORS, contentType: "application/json", body: JSON.stringify({ error: "Tillfälligt fel hos tjänsten." }) }); return route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ ok: true, doc: { pages: 1, bytes: 2048 } }) }); });
    await page.route(/\/compare\/orders$/, (route) => route.request().method() === "POST" ? route.fulfill({ status: 201, headers: CORS, contentType: "application/json", body: JSON.stringify({ orderId: ID, token: KEY }) }) : route.fallback());
    await page.route(/\/compare\/orders\/o_c+$/, (route) => route.request().method() === "GET" ? route.fulfill({ status: 404, headers: CORS, contentType: "application/json", body: "{}" }) : route.fallback());
    await page.fill("#t0", "Offert 25 000 kr inkl. moms"); await page.check("#samejob");
    await page.evaluate(() => { const b = document.getElementById("go"); b.click(); b.click(); });
    await page.waitForSelector("#cdraft-open"); assert.equal(count(calls, /^POST \/compare\/orders$/), 1); assert.equal(ev.filter((e) => e.event === "submit").length, 1);
    assert.match(await page.locator("#err").innerText(), /Tillfälligt fel/);
    await page.click("#go"); await page.waitForSelector("#s2:not(.hidden)");
    assert.equal(count(calls, /^POST \/compare\/orders$/), 1, "samma utkast återanvänds – ingen andra order"); assert.equal(count(calls, /^PUT \/compare\/orders\/o_X\/docs\/0$/), 2);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

test("COUNT-01: 2→4→2→4 bevarar underlag, bara aktiva 2–4 skickas och steg­fel visas vid rätt offert", async () => {
  const h = await startHarness(); const { ctx, page, errors, calls } = await cmpPage(h);
  try {
    await page.click('.seg button[data-n="4"]');
    for (let i = 0; i < 4; i++) { await page.fill("#lab" + i, "Firma " + i); await page.fill("#t" + i, "Offert " + i + " 1 000 kr inkl. moms"); }
    await page.click('.seg button[data-n="2"]'); assert.equal(await page.locator("#slots .card:not(.hidden)").count(), 2);
    await page.click('.seg button[data-n="4"]'); assert.equal(await page.inputValue("#t3"), "Offert 3 1 000 kr inkl. moms"); assert.equal(await page.inputValue("#lab2"), "Firma 2");
    await page.click('.seg button[data-n="2"]'); await page.check("#samejob"); await page.fill("#t1", "");
    await page.click("#check"); await page.waitForSelector("#se1:not(.hidden)");
    assert.match(await page.locator("#se1").innerText(), /Offert 2 saknar fil eller text/); assert.equal(count(calls, /^POST \/compare\/orders$/), 0);
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "f1", "fokus nära rätt offert");
    await page.fill("#t1", "Offert 1 2 000 kr inkl. moms"); await page.click("#check"); await page.waitForSelector("#offer:not(.hidden)");
    assert.equal(count(calls, /^PUT \/compare\/orders\/o_X\/docs\/[23]$/), 0, "dolda offerter skickas inte"); assert.equal(count(calls, /^PUT \/compare\/orders\/o_X\/docs\/[01]$/), 2);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

test("LAYOUT-01: 375/390/1280 och ~200 % zoom utan sidoscroll genom start, felrad och förkontroll; fokus synligt med tangentbord", async () => {
  const h = await startHarness();
  try {
    for (const [w, hh] of [[375, 812], [390, 844], [1280, 900], [640, 450], [320, 568]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: hh }, locale: "sv-SE" }); const page = await ctx.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(h.base + "/jamfor/"); await page.waitForSelector("#s1:not(.hidden)");
      const ok = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
      assert.ok(await ok(), "start " + w); await page.click('.seg button[data-n="4"]'); assert.ok(await ok(), "fyra platser " + w);
      await page.route(/\/docs\/1$/, (r) => r.request().method() === "PUT" ? r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Tillfälligt fel hos tjänsten." }) }) : r.fallback());
      await page.click('.seg button[data-n="2"]'); await fillTwo(page);
      // tangentbord: fokusera knappen och tryck Enter
      await page.focus("#check"); await page.keyboard.press("Enter"); await page.waitForSelector("#retry1");
      assert.ok(await ok(), "felrad " + w);
      await page.focus("#retry1"); const outline = await page.evaluate(() => { const c = getComputedStyle(document.activeElement); return c.outlineStyle !== "none" && parseFloat(c.outlineWidth) >= 2; });
      assert.ok(outline, "synligt fokus på Försök igen " + w);
      await page.keyboard.press("Tab"); const lab = await page.evaluate(() => { const l = document.querySelector('label[for="swap1"]'); return !!l && getComputedStyle(l).display !== "none"; });
      assert.ok(lab, "Byt fil nåbar");
      const bad = await page.evaluate(() => { const bg = getComputedStyle(document.body).backgroundColor; return bg; });
      assert.ok(bad && bad !== "rgba(0, 0, 0, 0)", "bakgrund satt");
      assert.deepEqual(errors, []); await ctx.close();
    }
  } finally { await h.close(); }
});
