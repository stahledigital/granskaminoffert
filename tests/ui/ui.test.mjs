// UI-tester för Granska min offert (D03 paket C/D). Kör: node --test tests/ui/
// Kräver Playwright + Chromium (miljövariabler: PLAYWRIGHT_MODULE, CHROMIUM_PATH). /review och /event är
// route-mockade: inget nätverk, ingen AI. Testerna visar att sidans logik och tillgänglighetsbeteende
// fungerar i Chromium. De visar INTE något om riktig mobil, riktig skärmläsare eller VoiceOver (EJ TESTAT).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PW = process.env.PLAYWRIGHT_MODULE || "/opt/npm-tools/node_modules/playwright/index.mjs";
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
const EVIDENCE = process.env.UI_EVIDENCE_DIR || join(ROOT, "tests", "ui", "evidence");
mkdirSync(EVIDENCE, { recursive: true });
const { chromium } = await import(pathToFileURL(PW).href);

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
let server, base, browser;
before(async () => {
  server = createServer((req, res) => {
    let p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    let f = join(ROOT, p);
    if (!existsSync(f) || !extname(f)) f = join(f, "index.html");
    if (!existsSync(f)) { res.writeHead(404); return res.end("nej"); }
    res.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" });
    res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
});
after(async () => { await browser?.close(); server?.close(); });

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
const RESULT = {
  trade: "tak", calcCoverage: "checked", calcNote: "Kontrollerade timmar × timpris.",
  contradictions: [{ key: "Summan stämmer inte", text: "Raderna summerar till 42 820 kr men totalen är 45 000 kr." }],
  clarify: [{ key: "Startdatum", text: "Inget startdatum anges." }, { key: "Garanti", text: "Ingen garanti nämns." }],
  stated: [{ key: "Moms", text: "Priser anges inklusive moms." }],
  price: { hourlyRateSek: 595, totalSumSek: 42820, rotDeducted: true, comment: "Tydligt angivet." },
  questions: ["Vilket startdatum gäller?", "Vilken garanti ingår?"],
  priceReport: {
    referenceVersion: "2026-10-09",
    checked: [
      { id: "moms", status: "ok", title: "Moms", text: "Priserna anges inklusive moms, konsekvent.", source: "" },
      { id: "rot_belopp", status: "fel", title: "ROT-belopp", text: "ROT-avdraget 9 000 kr stämmer inte med 30 % av arbetskostnaden.", source: "Skatteverket" },
      { id: "pristyp", status: "flagga", title: "Pristyp", text: "Offerten anger inte pristyp.", source: "" },
    ],
    compared: [{ id: "tim_snickare", mode: "inom", title: "Marknad – timpris snickare", text: "Timpriset ligger inom intervallet.", source: "Byggahus" }],
    cannotAssess: [{ title: "Avläsningen", text: "Följande uppgifter kunde inte läsas säkert: moms.", source: "" }],
    partial: false, readIssues: ["moms"], performed: { rules: 3, addons: 0, comparisons: 1 }, disclaimer: "Referensintervallen är en uppskattning.", methodUrl: "x",
  },
  meta: { model: "mock" },
};
const clone = (o) => JSON.parse(JSON.stringify(o));

async function newPage(viewport = { width: 390, height: 844 }, mock = {}) {
  const context = await browser.newContext({ viewport, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const events = [], reviews = [];
  await page.route("**/review", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    reviews.push(route.request().postDataJSON());
    const m = mock.review || { status: 200, body: RESULT };
    return route.fulfill({ status: m.status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(m.body) });
  });
  await page.route("**/event", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    try { events.push(route.request().postDataJSON()); } catch { events.push({ raw: route.request().postData() }); }
    return route.fulfill({ status: 204, headers: CORS });
  });
  await page.route(/cloudflareinsights/, (r) => r.abort());
  await page.goto(base + "/", { waitUntil: "load" });
  // Playwright slår på filväljar-avlyssning asynkront: utan lyssnare + liten väntan kan det första Enter-trycket
  // komma före avlyssningen (testartefakt, påvisad i 12 körningar utan lyssnare: 6 missar; med lyssnare: 0).
  page.on("filechooser", () => {});
  await page.waitForTimeout(300);
  return { page, context, events, reviews };
}
async function runWithText(page, text = "Offert 42 820 kr") {
  await page.click("#paste");
  await page.fill("#txt", text);
  await page.click("#run");
  await page.waitForSelector("#res.on, #errbox.on");
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test("tangentbord: Välj fil och Ta foto är knappar som öppnar filväljaren med Enter och Mellanslag", async () => {
  const { page, context } = await newPage();
  for (const [sel, key] of [["#pickfile", "Enter"], ["#pickfile", "Space"], ["#pickcam", "Enter"], ["#pickcam", "Space"]]) {
    await page.focus(sel);
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.keyboard.press(key)]);
    assert.ok(chooser, `${sel} ${key}`);
    await chooser.setFiles([]);
    await page.waitForTimeout(250); // headless Chromium behöver landa förra väljaren innan nästa öppnas
  }
  // fokusordning: rollknappar -> Välj fil nås med Tab utan att passera dolda inputs
  await page.focus(".pathcard[data-path=hantverkare]");
  const order = [];
  for (let i = 0; i < 4; i++) { await page.keyboard.press("Tab"); order.push(await page.evaluate(() => document.activeElement.id || document.activeElement.className)); }
  assert.ok(order.includes("pickfile") && order.includes("pickcam"), order.join(","));
  assert.ok(!order.includes("file") && !order.includes("cam"));
  await context.close();
});

test("tangentbord: vald PDF och textfil visas och går att granska", async () => {
  const { page, context, reviews } = await newPage();
  const dir = join(EVIDENCE, "fixtures"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "offert.pdf"), "%PDF-1.4\n%mock\n");
  writeFileSync(join(dir, "offert.txt"), "Offert 10 000 kr inkl. moms");
  await page.focus("#pickfile");
  let [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.keyboard.press("Enter")]);
  await chooser.setFiles(join(dir, "offert.pdf"));
  await page.waitForSelector("#filepreview.on");
  assert.match(await page.textContent("#filepreview"), /offert\.pdf/);
  await page.focus("#run"); await page.keyboard.press("Enter");
  await page.waitForSelector("#res.on");
  assert.equal(reviews[0].kind, "pdf");
  await page.focus("#pickfile");
  [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.keyboard.press("Space")]);
  await chooser.setFiles(join(dir, "offert.txt"));
  await page.waitForFunction(() => document.getElementById("txt").value.includes("10 000"));
  await context.close();
});

test("rollval: knappar med aria-pressed som följer valet, nåbara och styrbara med tangentbord", async () => {
  const { page, context } = await newPage();
  const pressed = () => page.$$eval(".pathcard", (els) => els.map((e) => e.getAttribute("aria-pressed")));
  assert.deepEqual(await pressed(), ["true", "false"]);
  await page.focus(".pathcard[data-path=hantverkare]");
  await page.keyboard.press("Space");
  assert.deepEqual(await pressed(), ["false", "true"]);
  await page.focus(".pathcard[data-path=mottagare]");
  await page.keyboard.press("Enter");
  assert.deepEqual(await pressed(), ["true", "false"]);
  assert.equal(await page.getAttribute("#pathsel", "role"), "group");
  await context.close();
});

test("synligt fokus på knappar, rollval och sammanfattningsrubriker", async () => {
  const { page, context } = await newPage();
  for (const sel of ["#pickfile", "#pickcam", ".pathcard[data-path=hantverkare]", "#paste", "#demo"]) {
    await page.keyboard.press("Tab"); // säkerställer tangentbordsläge för :focus-visible
    await page.focus(sel);
    await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
    const st = await page.$eval(sel, (el) => { const c = getComputedStyle(el); return { w: parseFloat(c.outlineWidth), s: c.outlineStyle, active: document.activeElement === el }; });
    if (st.active) assert.ok(st.s !== "none" && st.w >= 2, `${sel} saknar synlig fokusram: ${JSON.stringify(st)}`);
  }
  await context.close();
});

test("resultat och fel annonseras: live-region, alert, fokus flyttas till rubriken", async () => {
  const ok = await newPage();
  assert.equal(await ok.page.getAttribute("#errbox", "role"), "alert");
  assert.equal(await ok.page.getAttribute("#loading", "role"), "status");
  await runWithText(ok.page);
  assert.match(await ok.page.textContent("#announce"), /Granskningen är klar\./);
  assert.equal(await ok.page.evaluate(() => document.activeElement.tagName), "H2");
  assert.match(await ok.page.evaluate(() => document.activeElement.textContent), /Så här ser offerten ut/);
  await ok.context.close();
  const err = await newPage({ width: 390, height: 844 }, { review: { status: 503, body: { error: "Tjänsten är tillfälligt stängd." } } });
  await runWithText(err.page);
  assert.match(await err.page.textContent("#errbox"), /tillfälligt stängd/);
  await err.context.close();
});

test("sammanfattning: inget grönt utan genomförd relevant kontroll", async () => {
  const summaryFor = async (mut) => {
    const r = clone(RESULT); mut(r);
    const { page, context } = await newPage({ width: 390, height: 844 }, { review: { status: 200, body: r } });
    await runWithText(page);
    const t = await page.textContent(".summarybox p");
    await context.close();
    return t;
  };
  // inga prisregler kördes, bara "går inte att bedöma"
  let t = await summaryFor((r) => { r.priceReport.checked = []; r.priceReport.compared = []; r.contradictions = []; });
  assert.doesNotMatch(t, /stämmer\b(?! inte)/);
  assert.match(t, /inte går att bedöma/);
  // helt tom prisrapport
  t = await summaryFor((r) => { r.priceReport.checked = []; r.priceReport.compared = []; r.priceReport.cannotAssess = []; r.contradictions = []; });
  assert.match(t, /ingen prisregel kunde kontrolleras/);
  assert.doesNotMatch(t, /prisreglerna stämmer/);
  // ofullständig prisgranskning
  t = await summaryFor((r) => { r.priceReport.partial = true; });
  assert.match(t, /ofullständig/);
  // räknekontroll som inte gick att göra
  t = await summaryFor((r) => { r.calcCoverage = "insufficient_data"; r.contradictions = []; });
  assert.match(t, /beräkningen gick inte att kontrollera/);
  assert.doesNotMatch(t, /inga räknefel/);
  // genomförd kontroll utan fynd får vara grön, och bara då
  t = await summaryFor((r) => { r.contradictions = []; r.priceReport.checked = [{ id: "moms", status: "ok", title: "Moms", text: "ok", source: "" }]; r.priceReport.cannotAssess = []; });
  assert.match(t, /inga räknefel upptäckta i AI-kontrollen/);
  assert.match(t, /1 prisregel kontrollerad och stämmer/);
  // fel som finns får inte döljas av grönt
  t = await summaryFor(() => {});
  assert.match(t, /1 prisregel som inte stämmer/);
  assert.doesNotMatch(t, /kontrollerad och stämmer/);
});

for (const role of ["mottagare", "hantverkare"]) {
  test(`export (${role}): räknefel, prisfel och osäkerheter från samma resultat som skärmen – i e-post, SMS-länk och Kopiera`, async () => {
    const { page, context } = await newPage({ width: 390, height: 844 });
    await page.click(`.pathcard[data-path=${role}]`);
    await runWithText(page);
    const mail = decodeURIComponent((await page.getAttribute("#sendmail", "href")).split("body=")[1]);
    await page.click("#copybtn");
    await page.waitForFunction(() => document.getElementById("copybtn").textContent === "Kopierat!");
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    for (const text of [mail, clip]) {
      assert.match(text, /Räknefel och motsägelser/);
      assert.match(text, /Summan stämmer inte/);
      assert.match(text, /Prisregler som inte stämmer/);
      assert.match(text, /ROT-belopp/);
      assert.match(text, /Prisfrågor/);
      assert.match(text, /Pristyp/);
      assert.match(text, /Går inte att bedöma/);
      assert.match(text, /Avläsningen/);
      assert.match(text, /Startdatum/);
    }
    if (role === "mottagare") assert.match(clip, /Vilket startdatum gäller\?/);
    else assert.match(clip, /Punkter att förtydliga/);
    // skärmen visar samma fynd
    const screen = await page.textContent("#res");
    for (const must of ["Summan stämmer inte", "ROT-belopp", "Pristyp", "Avläsningen"]) assert.ok(screen.includes(must), must);
    // SMS finns bara i mobilläge
    assert.equal(await page.$("#sendsms") !== null, await page.evaluate(() => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && innerWidth < 900)));
    await context.close();
  });
}

test("export: Kopiera ger hela texten, e-post och SMS förkortas tydligt när de blir för långa", async () => {
  const r = clone(RESULT);
  r.clarify = Array.from({ length: 40 }, (_, i) => ({ key: `Punkt ${i + 1}`, text: "En ganska lång beskrivning av något som saknas i offerten och behöver förtydligas." }));
  r.priceReport.cannotAssess.push({ title: "SISTA_RADEN", text: "Sista osäkerheten.", source: "" });
  const { page, context } = await newPage({ width: 390, height: 844 }, { review: { status: 200, body: r } });
  await page.click(".pathcard[data-path=hantverkare]");
  await runWithText(page);
  const mail = decodeURIComponent((await page.getAttribute("#sendmail", "href")).split("body=")[1]);
  assert.ok(encodeURIComponent(mail).length <= 1900 + 50);
  assert.match(mail, /Förkortad text/);
  assert.equal(await page.isVisible("#shortnote"), true);
  await page.click("#copybtn");
  await page.waitForFunction(() => document.getElementById("copybtn").textContent === "Kopierat!");
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.doesNotMatch(clip, /Förkortad text/);
  assert.match(clip, /Punkt 40/);
  assert.match(clip, /SISTA_RADEN/);
  assert.match(mail, /Granskat med granskaminoffert\.se/);
  await context.close();
});

test("layout: ingen sidoscroll vid 390 px och bred skärm, även med långa obrutna strängar", async () => {
  const r = clone(RESULT);
  r.clarify.push({ key: "L".repeat(120), text: "https://exempel.se/" + "a".repeat(300) });
  r.priceReport.checked[1].text = "X".repeat(400);
  for (const [name, vp] of [["390", { width: 390, height: 844 }], ["1280", { width: 1280, height: 800 }]]) {
    const { page, context } = await newPage(vp, { review: { status: 200, body: r } });
    assert.ok(await noHScroll(page), `startsida ${name}`);
    await page.click(".pathcard[data-path=hantverkare]");
    await runWithText(page);
    assert.ok(await noHScroll(page), `resultat ${name}`);
    await page.screenshot({ path: join(EVIDENCE, `resultat-${name}.png`), fullPage: true });
    await page.goto(base + "/sa-granskar-vi-priser/");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `metodsida ${name}`);
    await context.close();
  }
});

test("datainformation vid uppladdning: kort, länkad till hela texten, utan nya löften", async () => {
  const { page, context } = await newPage();
  const t = await page.textContent("#privinfo");
  assert.match(t, /Anthropic/);
  assert.match(t, /24 timmar/);
  assert.match(t, /dölj gärna personnummer, namn och adress/i);
  assert.doesNotMatch(t, /GDPR|ingen lagring|avtal|godkänd/i);
  assert.equal(await page.$eval("#om", (d) => d.open), false);
  await page.click("#privlink");
  assert.equal(await page.$eval("#om", (d) => d.open), true);
  assert.match(await page.textContent("#om"), /Anthropic behåller in- och utdata/);
  await context.close();
});

test("mätning: rapport_klar, export och kontakt-CTA skickas som räknare; exempel och fritext skickas inte", async () => {
  const { page, context, events } = await newPage();
  await page.click("#demo");
  await page.waitForSelector("#res.on");
  await page.click("#copybtn");
  assert.deepEqual(events, [], "exempeloffert ska inte skicka några händelser");
  await page.reload();
  await page.click(".pathcard[data-path=hantverkare]");
  await runWithText(page);
  await page.click("#copybtn");
  await page.click("[data-cta=hemsida]", { modifiers: [], noWaitAfter: true, trial: true }).catch(() => {});
  await page.evaluate(() => document.querySelector("[data-cta=hemsida]").addEventListener("click", (e) => e.preventDefault(), { once: true }));
  await page.click("[data-cta=hemsida]");
  await page.waitForTimeout(300);
  const kinds = events.map((e) => `${e.type}:${e.event || e.channel}`);
  assert.deepEqual(kinds, ["client:rapport_klar", "share:copy", "client:kontakt_cta"]);
  assert.ok(events.every((e) => e.role === "hantverkare"));
  assert.equal(events[2].detail, "hemsida");
  const flat = JSON.stringify(events);
  assert.doesNotMatch(flat, /Offert 42|42 820|ROT-avdraget/);
  await context.close();
});

test("testläge ?sd-test=1 märker mätningen som test", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const events = [];
  await page.route("**/review", (route) => route.request().method() === "OPTIONS" ? route.fulfill({ status: 204, headers: CORS }) : route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(RESULT) }));
  await page.route("**/event", (route) => { if (route.request().method() !== "OPTIONS") events.push(route.request().postDataJSON()); return route.fulfill({ status: 204, headers: CORS }); });
  await page.route(/cloudflareinsights/, (r) => r.abort());
  await page.goto(base + "/?sd-test=1");
  await runWithText(page);
  await page.waitForTimeout(200);
  assert.equal(events[0].test, true);
  await context.close();
});
