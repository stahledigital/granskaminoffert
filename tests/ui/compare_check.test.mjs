// D17 Förkontroll (UI, 390 px): rapportvy med fynd + bekräftelseformulär (riktig serverlogik via importerade funktioner), tillägg/PDF med samma fakta+revision,
// ogiltiga datum/HTML avvisas före anrop, skrivskyddad länk utan formulär, köpsidan /forkontroll/ (kassa, produkt/belopp-bindning, ingen förkryssad ruta).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import { startHarness } from "../../worker/dev/compare_harness.mjs";
import { buildCheckReport, validateConfirmation, checkOutputs, customerAttachmentPdf } from "../../worker/src/compare_check.js";
import { sanitizeOffer } from "../../worker/src/compare_extract.js";
import { b64Bytes } from "../../worker/src/compare_pdf.js";

const PW = process.env.PLAYWRIGHT_MODULE || "/opt/npm-tools/node_modules/playwright/index.mjs";
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
const OUT = process.env.D17_EVIDENCE_DIR || "";
const { chromium } = await import(pathToFileURL(PW).href);
let browser;
before(async () => { browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] }); });
after(async () => { await browser?.close(); });

const ID = "o_" + "c".repeat(32), KEY = "K".repeat(32), TOK = "R".repeat(32);
const FEL = { jobType: "malning", areaM2: 30, laborSumSek: 20000, materialSumSek: 4000, rotAmountSek: 10000, vatMode: "exkl", totalSumSek: 29000, totalVatBasis: "inkl", priceType: "ungefarligt", propertyType: "smahus", customerType: "privatperson", trades: [], hourlyRateSek: null, hours: null, travelSumSek: null };
function report() {
  const offer = sanitizeOffer({ extracted: FEL, scope: [], facts: [], readability: { level: "bra" } });
  const R = buildCheckReport({ order: { id: ID }, offer, label: "Din offert", now: Date.UTC(2026, 9, 11), receipt: { orderNo: "CCCCCCCC", product: "Förkontroll av min offert", amountOre: 4900, currency: "SEK" } });
  return R;
}

// Servertestdubbel som kör den RIKTIGA valideringen/utdata-/PDF-koden; token avgör behörighet precis som Workern (resultatlänkens r-token får bara läsa rapporten).
async function mount(page, R, log, { maxSaves = 12 } = {}) {
  const st = { revision: 0, values: {}, saves: 0, exports: 0 };
  const view = async () => ({ ok: true, revision: st.revision, saves: st.saves, exports: st.exports, limits: { saves: maxSaves, exports: 12 }, values: st.values, outputs: await checkOutputs(R, st.revision ? st : null) });
  await page.route(/\/compare\/orders\/o_c+(\/.*)?$/, async (route) => {
    const q = route.request(), u = new URL(q.url()), sub = u.pathname.replace(/^.*\/compare\/orders\/o_c+/, ""), tok = q.headers()["x-order-token"], j = (b, s = 200) => route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
    log.push({ m: q.method(), sub, tok });
    if (sub === "") return j({ ok: true, order: { id: ID, kind: "check", status: "delivered", docCount: 1, progress: { extracted: 1, total: 1, synth: "skipped" } }, pollMs: 2000 });
    if (sub === "/report") return j({ ok: true, report: R });
    if (tok !== KEY) return j({ ok: false, error: "Ordern hittades inte." }, 404);
    if (sub === "/check" && q.method() === "GET") return j(await view());
    if (sub === "/check" && q.method() === "PUT") {
      const v = validateConfirmation(JSON.parse(q.postData()).values); if (v.error) return j({ ok: false, error: "ogiltig", message: v.error }, 400);
      if (JSON.stringify(v.values) === JSON.stringify(st.values) && st.revision) return j({ ...(await view()), unchanged: true });
      if (st.saves >= maxSaves) return j({ ok: false, error: "gransen" }, 429);
      st.values = v.values; st.revision++; st.saves++; return j(await view());
    }
    if (sub === "/check/export") { const rb = JSON.parse(q.postData() || "{}").revision; if (Number.isInteger(rb) && rb !== st.revision) return j({ ok: false, error: "En nyare revision finns.", revisionChanged: true, ...(await view()) }, 409); st.exports++; const { pdf, out } = await customerAttachmentPdf(R, st, { orderNo: "CCCCCCCC" }); return j({ ok: true, revision: out.revision, code: out.code, text: out.text, filename: `Tillagg-till-offert-rev${out.revision}.pdf`, pdfBase64: Buffer.from(pdf).toString("base64"), exports: st.exports }); }
    return j({ ok: false }, 404);
  });
}
async function open(h, { stored, hash }) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "sv-SE", acceptDownloads: true }); const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(h.base + "/jamfor/");
  if (stored) await page.evaluate(([o, t]) => localStorage.setItem("jamfor_order", JSON.stringify({ id: o, token: t })), [ID, KEY]);
  return { ctx, page, errors };
}
const noSide = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test("förkontroll 390 px: fynd + formulär; facit ⇒ tillägg 30 000/ROT 7 500/netto 22 500 med revision; PDF-hämtning med samma fakta; ingen sidoscroll", async () => {
  const h = await startHarness({ vars: {} }); const R = report(), log = []; const { ctx, page, errors } = await open(h, { stored: true });
  try {
    await mount(page, R, log);
    await page.reload(); await page.waitForSelector("#rep:not(.hidden) #ckform");
    const txt0 = (await page.evaluate(() => document.getElementById("rep").innerText)).replace(/\s+/g, " ");
    assert.match(txt0, /Din förkontroll/); assert.match(txt0, /Pristyp/); assert.match(txt0, /Totalsumma 29 000 kr inklusive moms/, "totalsummans EGEN momsbas (inkl), inte radernas (exkl)"); assert.match(txt0, /Arbete 20 000 kr exklusive moms/); assert.match(txt0, /Frågor din kund sannolikt ställer/);
    assert.ok(await page.locator('[data-finding="fk_pristyp"]').count() === 1, "pristypsfynd");
    assert.ok(await noSide(page), "ingen sidoscroll före bekräftelse");
    assert.equal(await page.locator("#ckrev").count(), 0, "inga tillägg före bekräftelse");
    await page.selectOption("#ck-priceType", "fast"); await page.fill("#ck-laborInclVat", "25 000"); await page.fill("#ck-materialInclVat", "5000"); await page.fill("#ck-otherInclVat", "0");
    await page.selectOption("#ck-rotMode", "villkorat"); await page.fill("#ck-plannedStart", "2026-11-02"); await page.fill("#ck-plannedEnd", "2026-11-06");
    await page.fill("#ck-includes", "väggar\nenklare spackling och slipning\ntvå vita strykningar"); await page.fill("#ck-excludes", "tak\nsnickeriarbeten\nstörre skador");
    await page.selectOption("#ck-cleaning", "ingar"); await page.selectOption("#ck-removal", "ingar");
    await page.click("#cksave"); await page.waitForSelector("#ckrev");
    const t1 = (await page.evaluate(() => document.getElementById("ckout").innerText)).replace(/\s+/g, " ");
    assert.match(t1, /revision 1/); assert.match(t1, /30 000 kr/); assert.match(t1, /7 500 kr/); assert.match(t1, /22 500 kr/); assert.match(t1, /Fast pris/);
    assert.match(t1, /2 november 2026/); assert.match(t1, /6 november 2026/); assert.ok(!/garanti/i.test(t1.replace(/Vi lägger aldrig[^.]*\./, "")) || !/Garanti\b.*lämnar/.test(t1), "ingen påhittad garanti");
    assert.equal(await page.locator("[data-section]").count() >= 4, true); assert.ok(await page.locator("#ckcopyall").count() === 1);
    assert.ok(await noSide(page), "ingen sidoscroll efter bekräftelse");
    if (OUT) { mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: `${OUT}/forkontroll-390-full.png`, fullPage: true }); }
    // samma värden igen ⇒ ingen ny revision
    await page.click("#cksave"); await page.waitForFunction(() => /Inget ändrat/.test(document.getElementById("ckmsg").textContent));
    assert.match(await page.locator("#ckrev").innerText(), /revision 1/);
    // PDF
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#ckpdf")]);
    assert.match(dl.suggestedFilename(), /^Tillagg-till-offert-rev1\.pdf$/);
    const p = await dl.path(); const { readFileSync } = await import("node:fs"); const bytes = readFileSync(p); assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
    if (OUT) writeFileSync(`${OUT}/tillagg-rev1.pdf`, bytes);
    const exp = log.filter((l) => l.sub === "/check/export"); assert.equal(exp.length, 1); assert.equal(exp[0].tok, KEY);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

test("förkontroll: ogiltiga värden avvisas (HTML, slut före start, bokstäver i belopp) och tomt formulär sparar inget", async () => {
  const h = await startHarness({ vars: {} }); const R = report(), log = []; const { ctx, page, errors } = await open(h, { stored: true });
  try {
    await mount(page, R, log); await page.reload(); await page.waitForSelector("#ckform");
    const puts = () => log.filter((l) => l.sub === "/check" && l.m === "PUT").length;
    await page.click("#cksave"); assert.match(await page.locator("#ckmsg").innerText(), /minst en uppgift/); assert.equal(puts(), 0);
    await page.fill("#ck-includes", "<script>alert(1)</script>"); await page.click("#cksave"); assert.match(await page.locator("#ckmsg").innerText(), /< eller >/); assert.equal(puts(), 0);
    await page.fill("#ck-includes", ""); await page.fill("#ck-plannedStart", "2026-11-06"); await page.fill("#ck-plannedEnd", "2026-11-02"); await page.click("#cksave");
    assert.match(await page.locator("#ckmsg").innerText(), /före planerad start/); assert.equal(puts(), 0);
    await page.fill("#ck-plannedStart", ""); await page.fill("#ck-plannedEnd", ""); await page.fill("#ck-laborInclVat", "tjugo"); await page.click("#cksave");
    assert.match(await page.locator("#ckmsg").innerText(), /hela kronor/); assert.equal(puts(), 0);
    // servern avvisar också (om klienten kringgås): HTML från servern visas som text, aldrig som markup
    await page.fill("#ck-laborInclVat", "100"); await page.fill("#ck-warranty", "5 år"); await page.click("#cksave"); await page.waitForSelector("#ckrev");
    assert.equal(await page.locator("#ckout script, #ckout img, #ckout iframe").count(), 0);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

test("förkontroll: skrivskyddad resultatlänk (#o=&r=) visar bara fynd, inget formulär, inga check-anrop med r-token", async () => {
  const h = await startHarness({ vars: {} }); const R = report(), log = []; const { ctx, page, errors } = await open(h, { stored: false });
  try {
    await mount(page, R, log);
    await page.goto(h.base + `/jamfor/#o=${ID}&r=${TOK}`); await page.reload(); await page.waitForSelector("#rep:not(.hidden) #ckro");
    assert.equal(await page.locator("#ckform").count(), 0); assert.match(await page.locator("#ckro").innerText(), /skrivskyddad/);
    assert.equal(log.filter((l) => l.sub.startsWith("/check")).length, 0, "ingen check-läsning/-skrivning med r-token");
    assert.ok(await noSide(page)); assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

test("köpsidan /forkontroll/: stängd när ej tillgänglig; öppen ⇒ kind check, 1 dokument, ingen förkryssad ruta, knapp av tills deklaration, kassa binder hash+version, 390 px utan sidoscroll", async () => {
  const h = await startHarness({ vars: {} });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "sv-SE" }); const page = await ctx.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await page.goto(h.base + "/forkontroll/"); await page.waitForSelector("#closed:not(.hidden)"); assert.match(await page.locator("#closed").innerText(), /inte öppen/); assert.ok(await noSide(page));
    const CFG = { ok: true, enabled: true, accepting: true, check: { available: true, offer: { product: "Förkontroll av min offert", priceOre: 4900, currency: "SEK", vatPct: 25, retentionHours: 24 },
      offerCopy: { gets: ["Kontroll av EN egen offert"], getsNot: ["Ingen stämpel"], how: ["Ladda upp"] },
      consent: { version: "samtycke-x", draft: true, hash: "H".repeat(64), policy: "P", texts: { sameJob: "Offerten är min egen.", declaration: "Jag vill att förkontrollen börjar direkt." } },
      terms: { sections: [{ id: "saljare", title: "Säljare", text: "Syntetisk Säljare AB" }, { id: "tjansten", title: "Tjänsten", text: "EN offert." }] }, dataCoverage: { text: "Täckning." } } };
    const calls = [];
    await page.route("**/compare/config", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CFG) }));
    await page.route(/\/compare\/orders(\/.*)?$/, (r) => { const q = r.request(), sub = new URL(q.url()).pathname.replace(/^.*\/compare\/orders/, ""); calls.push({ m: q.method(), sub, body: q.postData() ? JSON.parse(q.postData()) : null });
      const j = (b, s = 200) => r.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
      if (q.method() === "POST" && sub === "") return j({ ok: true, orderId: ID, token: KEY }, 201);
      if (sub.endsWith("/docs/0")) return j({ ok: true, doc: { pages: 1, bytes: 2048 } });
      if (sub.endsWith("/checkout")) return j({ ok: true, url: h.base + "/forkontroll/?stripe=mock" });
      return j({ ok: false }, 404); });
    await page.goto(h.base + "/forkontroll/"); await page.waitForSelector("#s1:not(.hidden)");
    assert.equal(await page.locator("#samejob").isChecked(), false); assert.ok(await noSide(page));
    await page.click("#go"); assert.match(await page.locator("#err").innerText(), /Bekräfta först/);
    await page.check("#samejob"); await page.click("#go"); assert.match(await page.locator("#err").innerText(), /Välj en fil/);
    await page.fill("#t0", "Målning vardagsrum 30 m2, arbete 20000 kr, material 4000 kr."); await page.click("#go"); await page.waitForSelector("#s2:not(.hidden)");
    const cr = calls.find((c) => c.m === "POST" && c.sub === ""); assert.equal(cr.body.kind, "check"); assert.equal(cr.body.docCount, 1); assert.deepEqual(cr.body.accept, { sameJob: true });
    assert.equal(await page.locator("#declaration").isChecked(), false); assert.equal(await page.locator("#pay").isDisabled(), true);
    const t = (await page.evaluate(() => document.getElementById("s2").innerText)).replace(/\s+/g, " ");
    assert.match(t, /49 kr/); assert.match(t, /engångsköp/); assert.match(t, /Ingen stämpel/); assert.match(t, /Utkast/); assert.ok(!/prenumeration\s+(ingår|månad)/i.test(t));
    assert.ok(await noSide(page));
    await page.click("#pay", { force: true }); assert.equal(calls.filter((c) => c.sub.endsWith("/checkout")).length, 0, "ingen betalning utan deklaration");
    await page.check("#declaration"); await page.click("#pay"); assert.match(await page.locator("#err").innerText(), /giltig e-post/);
    await page.fill("#email", "kund@example.test"); await page.click("#pay"); await page.waitForURL(/stripe=mock/);
    const co = calls.find((c) => c.sub.endsWith("/checkout")); assert.deepEqual(co.body, { accept: { terms: true, declaration: true, consentHash: "H".repeat(64), consentVersion: "samtycke-x", email: "kund@example.test" } });
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

const fillAll = async (page, over = {}) => {
  const V = { "#ck-laborInclVat": "25000", "#ck-materialInclVat": "5000", "#ck-otherInclVat": "0", "#ck-includes": "väggar\ntvå vita strykningar", "#ck-excludes": "tak", "#ck-plannedStart": "2026-11-02", "#ck-plannedEnd": "2026-11-06", ...over };
  await page.selectOption("#ck-priceType", "fast"); await page.selectOption("#ck-rotMode", "villkorat"); await page.selectOption("#ck-cleaning", "ingar"); await page.selectOption("#ck-removal", "ingar");
  for (const [k, v] of Object.entries(V)) await page.fill(k, v);
};
test("R1 punkt 2+4 (UI): tomt övrigt ⇒ ingen komplett total och utkastbanner med kvarstående lista; övrigt 0 ⇒ 30 000 utan utkast; bara garanti ⇒ utkast", async () => {
  const h = await startHarness({ vars: {} }); const R = report(), log = []; const { ctx, page, errors } = await open(h, { stored: true });
  try {
    await mount(page, R, log); await page.reload(); await page.waitForSelector("#ckform");
    await fillAll(page, { "#ck-otherInclVat": "" }); await page.click("#cksave"); await page.waitForSelector("#ckrev");
    let t = (await page.evaluate(() => document.getElementById("ckout").innerText)).replace(/\s+/g, " ");
    assert.ok(!/30 000 kr/.test(t), "ingen total när övrigt är tomt"); assert.match(t, /Delbelopp inklusive moms: arbete 25 000 kr, material 5 000 kr/); assert.ok(await page.locator("#ckdraft").count() === 1); assert.match(t, /Utkast – tillägget är inte komplett/); assert.match(t, /Belopp: arbete, material och övrigt/);
    await page.fill("#ck-otherInclVat", "0"); await page.click("#cksave"); await page.waitForFunction(() => /revision 2/.test(document.getElementById("ckrev").innerText));
    t = (await page.evaluate(() => document.getElementById("ckout").innerText)).replace(/\s+/g, " "); assert.match(t, /30 000 kr/); assert.equal(await page.locator("#ckdraft").count(), 0, "inget utkast när allt kritiskt är bekräftat");
    await page.fill("#ck-laborInclVat", "25000.99"); await page.click("#cksave"); assert.match(await page.locator("#ckmsg").innerText(), /hela kronor/);
    await page.reload(); await page.waitForSelector("#ckform"); await page.fill("#ck-warranty", "Två års garanti på utfört arbete."); await page.evaluate(() => { for (const id of ["ck-laborInclVat", "ck-materialInclVat", "ck-otherInclVat", "ck-includes", "ck-excludes", "ck-plannedStart", "ck-plannedEnd"]) document.getElementById(id).value = ""; for (const id of ["ck-priceType", "ck-rotMode", "ck-cleaning", "ck-removal"]) document.getElementById(id).value = ""; });
    await page.click("#cksave"); await page.waitForFunction(() => /revision 3/.test(document.getElementById("ckrev").innerText)); assert.equal(await page.locator("#ckdraft").count(), 1, "endast garanti ⇒ utkast"); assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

test("R1 punkt 6 (UI, två flikar): flik A visar rev 1, flik B sparar rev 2, A:s PDF-hämtning nekas och A uppdateras till rev 2; nästa hämtning ger rev 2 med samma kod/text som skärmen", async () => {
  const h = await startHarness({ vars: {} }); const R = report(), log = []; const { ctx, page: A, errors } = await open(h, { stored: true });
  try {
    await mount(ctx, R, log); await A.reload(); await A.waitForSelector("#ckform"); await fillAll(A); await A.click("#cksave"); await A.waitForSelector("#ckrev");
    assert.match(await A.locator("#ckrev").innerText(), /revision 1/);
    const B = await ctx.newPage(); B.on("pageerror", (e) => errors.push(String(e))); await B.goto(h.base + "/jamfor/"); await B.waitForSelector("#ckform"); await B.waitForSelector("#ckrev");
    await B.fill("#ck-laborInclVat", "26000"); await B.click("#cksave"); await B.waitForFunction(() => /revision 2/.test(document.getElementById("ckrev").innerText));
    let dl = false; A.on("download", () => { dl = true; });
    await A.click("#ckpdf"); await A.waitForFunction(() => /nyare revision/.test(document.getElementById("ckmsg").textContent)); await A.waitForTimeout(300);
    assert.equal(dl, false, "ingen PDF för föråldrad revision");
    const t = (await A.evaluate(() => document.getElementById("ckout").innerText)).replace(/\s+/g, " "); assert.match(t, /revision 2/); assert.match(t, /31 000 kr/); assert.equal(await A.inputValue("#ck-laborInclVat"), "26000");
    const code = (t.match(/Revisionskod ([0-9A-F]{10})/) || [])[1]; assert.ok(code);
    const [d2] = await Promise.all([A.waitForEvent("download"), A.click("#ckpdf")]); assert.match(d2.suggestedFilename(), /rev2\.pdf$/);
    const { readFileSync } = await import("node:fs"); const bytes = readFileSync(await d2.path()); assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
    await A.waitForFunction(() => /PDF hämtad \(revision 2, kod/.test(document.getElementById("ckmsg").textContent)); assert.match(await A.locator("#ckmsg").innerText(), new RegExp("kod " + code)); assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

const CFG2 = (hash) => { const check = { available: true, offer: { product: "Förkontroll av min offert", priceOre: 4900, currency: "SEK", vatPct: 25, retentionHours: 24 },
  offerCopy: { gets: ["Kontroll"], getsNot: ["Ingen stämpel"], how: ["Ladda upp"] }, consent: { version: "v-" + hash[0], draft: true, hash, policy: "P", texts: { sameJob: "Min egen offert.", declaration: "Börja direkt." } }, terms: { sections: [{ id: "saljare", title: "Säljare", text: "Syntetisk AB" }] }, dataCoverage: { text: "T" } }; return { ok: true, enabled: true, accepting: true, check, ...check, limits: { maxFiles: 3 }, payment: {} }; };
test("R1 punkt 9 (UI): consentChanged ⇒ rätt check-order bevaras, ny aktiv ruta, ingen ny order/dubbelbetalning; felproduktsnyckel (jämförelseorder) avvisas och skrivs aldrig över", async () => {
  const h = await startHarness({ vars: {} });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "sv-SE" }); const page = await ctx.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  try {
    let hash = "A".repeat(64); const calls = []; let kind = "check", status = "ready";
    await page.route("**/compare/config", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CFG2(hash)) }));
    await page.route(/\/compare\/orders(\/.*)?$/, (r) => { const q = r.request(), sub = new URL(q.url()).pathname.replace(/^.*\/compare\/orders/, ""); calls.push({ m: q.method(), sub, body: q.postData() ? JSON.parse(q.postData()) : null });
      const j = (b, s = 200) => r.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
      if (q.method() === "POST" && sub === "") return j({ ok: true, orderId: "o_" + "d".repeat(32), token: "N".repeat(32) }, 201);
      if (sub === "/" + ID || sub === "/" + ID + "") return j({ ok: true, order: { id: ID, kind, status, docCount: 1, progress: { extracted: 0, total: 1, synth: "pending" } }, pollMs: 2000 });
      if (sub === `/${ID}/checkout`) { const b = JSON.parse(q.postData() || "null"); if (!b || !b.accept) return j({ ok: false, error: "Läs och godkänn villkoren igen innan du betalar.", needAccept: true }, 400); if (b.accept.consentHash !== hash) return j({ ok: false, error: "Villkoren har ändrats. Läs och godkänn igen.", needAccept: true, consentChanged: true }, 409); return j({ ok: true, url: h.base + "/forkontroll/?stripe=mock" }); }
      return j({ ok: false }, 404); });
    await page.goto(h.base + "/jamfor/"); await page.evaluate(([o, t]) => localStorage.setItem("jamfor_order", JSON.stringify({ id: o, token: t })), [ID, KEY]);
    await page.goto(h.base + "/jamfor/"); await page.waitForSelector("#statusbox button");
    await page.click("#statusbox button"); await page.waitForURL(/\/forkontroll\/#betala/); await page.waitForSelector("#s2:not(.hidden)");
    assert.equal(await page.locator("#declaration").isChecked(), false, "ny aktiv ruta"); assert.equal(await page.locator("#pay").isDisabled(), true);
    assert.equal(calls.filter((c) => c.m === "POST" && c.sub === "").length, 0, "ingen ny order"); assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem("jamfor_order"))).id, ID, "samma order bevarad");
    // villkoren ändras medan sidan är öppen ⇒ consentChanged ⇒ färsk config, rutan avmarkerad, SAMMA order, ny betalning först efter ny aktiv ruta
    await page.fill("#email", "kund@example.test"); await page.check("#declaration"); hash = "B".repeat(64); await page.click("#pay");
    await page.waitForFunction(() => document.getElementById("declaration").checked === false); assert.match(await page.locator("#err").innerText(), /ändrats/);
    assert.equal(calls.filter((c) => c.sub.endsWith("/checkout") && c.body && c.body.accept).length, 1); assert.equal(calls.filter((c) => c.m === "POST" && c.sub === "").length, 0);
    await page.click("#pay", { force: true }); assert.equal(calls.filter((c) => c.sub.endsWith("/checkout") && c.body && c.body.accept).length, 1, "ingen betalning utan ny ruta");
    await page.check("#declaration"); await page.click("#pay"); await page.waitForURL(/stripe=mock/);
    const co = calls.filter((c) => c.sub.endsWith("/checkout") && c.body && c.body.accept); assert.equal(co.length, 2); assert.equal(co[1].body.accept.consentHash, "B".repeat(64)); assert.equal(co.filter((c) => c.sub.includes(ID)).length, 2); assert.equal(calls.filter((c) => c.m === "POST" && c.sub === "").length, 0, "aldrig ny order");
    // felprodukt i storage (jämförelseorder): avvisas, skrivs inte över, ingen order skapas
    kind = "compare"; calls.length = 0;
    await page.goto(h.base + "/forkontroll/#betala"); await page.reload(); await page.waitForSelector("#guard:not(.hidden)");
    assert.match(await page.locator("#guard").innerText(), /annan order sparad/); assert.equal(await page.locator("#s2").isVisible(), false);
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem("jamfor_order"))).id, ID, "felproduktsnyckeln orörd");
    await page.check("#samejob"); await page.fill("#t0", "Offert text"); await page.click("#go"); await page.waitForTimeout(300);
    assert.equal(calls.filter((c) => c.m === "POST" && c.sub === "").length, 0, "ingen förkontroll startas ovanpå en jämförelseorder"); assert.equal(await page.locator("#s2").isVisible(), false);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

test("R1 punkt 8 (UI): startsidan visar kort förkontrollserbjudande 49 kr bara för hantverkare-spåret när tjänsten är öppen; länk till /forkontroll/; ingen Premiumbranding", async () => {
  const h = await startHarness({ vars: {} });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "sv-SE" }); const page = await ctx.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await page.route("**/compare/config", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CFG2("C".repeat(64))) }));
    await page.goto(h.base + "/"); await page.waitForTimeout(500);
    assert.equal(await page.locator("#fkoffer").isVisible(), false, "dolt för mottagare-spåret");
    await page.click('[data-path="hantverkare"]'); await page.waitForSelector("#fkoffer:not([hidden])");
    const t = (await page.locator("#fkoffer").innerText()).replace(/\s+/g, " "); assert.match(t, /49 kr inkl\. moms/); assert.match(t, /Ingen prenumeration/); assert.ok(!/premium|pro\b/i.test(t));
    assert.equal(await page.locator("#fko-go").getAttribute("href"), "/forkontroll/"); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await page.unroute("**/compare/config"); await page.route("**/compare/config", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, enabled: false, accepting: false, check: { available: false } }) }));
    await page.reload(); await page.waitForTimeout(400); await page.click('[data-path="hantverkare"]'); assert.equal(await page.locator("#fkoffer").isVisible(), false, "stängd tjänst ⇒ inget erbjudande");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

test("R1 retry-pay (UI): misslyckad betalstart ⇒ ingen debitering, knappen kan försöka igen på SAMMA order; återupptagning awaiting_payment via #betala; ingen ny order", async () => {
  const h = await startHarness({ vars: {} });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "sv-SE" }); const page = await ctx.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  try {
    const hash = "A".repeat(64); const calls = []; let fail = 1;
    await page.route("**/compare/config", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CFG2(hash)) }));
    await page.route(/\/compare\/orders(\/.*)?$/, (r) => { const q = r.request(), sub = new URL(q.url()).pathname.replace(/^.*\/compare\/orders/, ""); calls.push({ m: q.method(), sub, body: q.postData() ? JSON.parse(q.postData()) : null });
      const j = (b, s = 200) => r.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
      if (q.method() === "POST" && sub === "") return j({ ok: true, orderId: "o_" + "d".repeat(32), token: "N".repeat(32) }, 201);
      if (sub === "/" + ID) return j({ ok: true, order: { id: ID, kind: "check", status: "awaiting_payment", docCount: 1, progress: { extracted: 0, total: 1, synth: "pending" } }, pollMs: 2000 });
      if (sub === `/${ID}/checkout`) { if (fail-- > 0) return j({ ok: false, error: "Betalningen kunde inte startas. Du har inte debiterats." }, 502); return j({ ok: true, url: "/forkontroll/?stripe=mock" }); }
      return j({ ok: false }, 404); });
    await page.goto(h.base + "/jamfor/"); await page.evaluate(([o, t]) => localStorage.setItem("jamfor_order", JSON.stringify({ id: o, token: t })), [ID, KEY]);
    await page.goto(h.base + "/forkontroll/#betala"); await page.reload(); await page.waitForSelector("#s2:not(.hidden)");
    await page.fill("#email", "kund@example.test"); await page.check("#declaration"); await page.click("#pay");
    await page.waitForFunction(() => /inte debiterats/.test(document.getElementById("err").textContent));
    assert.equal(await page.locator("#pay").innerText(), "Betala 49 kr"); assert.equal(await page.locator("#pay").isDisabled(), false, "kan försöka igen");
    await page.click("#pay"); await page.waitForURL(/stripe=mock/);
    const co = calls.filter((c) => c.sub.endsWith("/checkout")); assert.equal(co.length, 2); assert.ok(co.every((c) => c.sub.includes(ID)), "samma order");
    assert.equal(calls.filter((c) => c.m === "POST" && c.sub === "").length, 0, "aldrig ny order");
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem("jamfor_order"))).id, ID);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

test("R1 guard fail-closed (UI): giltig sparad nyckel + nätfel / 503 / 401 / felprodukt ⇒ ingen ny order, nyckeln orörd, begripligt besked; 404-gone ⇒ ny förkontroll tillåten", async () => {
  const h = await startHarness({ vars: {} });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "sv-SE" }); const page = await ctx.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  try {
    const hash = "A".repeat(64); const calls = []; let mode = "net";
    await page.route("**/compare/config", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CFG2(hash)) }));
    await page.route(/\/compare\/orders(\/.*)?$/, (r) => { const q = r.request(), sub = new URL(q.url()).pathname.replace(/^.*\/compare\/orders/, ""); calls.push({ m: q.method(), sub });
      const j = (b, s = 200) => r.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
      if (q.method() === "POST" && sub === "") return j({ ok: true, orderId: "o_" + "d".repeat(32), token: "N".repeat(32) }, 201);
      if (sub === "/" + ID) { if (mode === "net") return r.abort("failed"); if (mode === "503") return j({ ok: false }, 503); if (mode === "401") return j({ ok: false }, 401); if (mode === "404") return j({ ok: false }, 404); if (mode === "compare") return j({ ok: true, order: { id: ID, kind: "compare", status: "ready", docCount: 2 } }); }
      return j({ ok: false }, 404); });
    await page.goto(h.base + "/jamfor/"); await page.evaluate(([o, t]) => localStorage.setItem("jamfor_order", JSON.stringify({ id: o, token: t })), [ID, KEY]);
    const tryGo = async () => { calls.length = 0; await page.goto(h.base + "/forkontroll/"); await page.reload(); await page.waitForSelector("#s1:not(.hidden)"); await page.check("#samejob"); await page.fill("#t0", "Offert text"); await page.click("#go"); await page.waitForTimeout(350); };
    const stored = async () => JSON.parse(await page.evaluate(() => localStorage.getItem("jamfor_order")));
    for (const [m, re] of [["net", /inte kontrollera/], ["503", /inte kontrollera/], ["401", /godkänns inte längre/], ["compare", /annan order sparad/]]) {
      mode = m; await tryGo();
      assert.equal(calls.filter((c) => c.m === "POST" && c.sub === "").length, 0, m + ": ingen ny order"); assert.equal((await stored()).id, ID, m + ": nyckeln orörd"); assert.equal(await page.locator("#s2").isVisible(), false, m);
      assert.match(await page.locator("#guard").innerText(), re, m); if (m === "net" || m === "503") assert.equal(await page.locator("#guard button").innerText(), "Försök igen");
    }
    mode = "404"; await tryGo(); assert.equal(await page.locator("#guard").isVisible(), false, "404 gone ⇒ ingen spärr"); assert.equal(calls.filter((c) => c.m === "POST" && c.sub === "").length, 1, "gone ⇒ ny förkontroll får skapas");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});
