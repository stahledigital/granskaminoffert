// UI-tester för Granska min offert (D03 paket C/D). Kör: node --test tests/ui/
// Kräver Playwright + Chromium (miljövariabler: PLAYWRIGHT_MODULE, CHROMIUM_PATH). /review och /event är
// route-mockade: inget nätverk, ingen AI. Testerna visar att sidans logik och tillgänglighetsbeteende
// fungerar i Chromium. De visar INTE något om riktig mobil, riktig skärmläsare eller VoiceOver (EJ TESTAT).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { pageSource } from "./_src.mjs";
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
  const events = [], reviews = [], landings = [];
  await page.route("**/review", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    reviews.push(route.request().postDataJSON());
    const m = mock.review || { status: 200, body: RESULT };
    if (m.delay) await new Promise((r) => setTimeout(r, m.delay));
    return route.fulfill({ status: m.status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(m.body) });
  });
  await page.route("**/event", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    try { const b = route.request().postDataJSON(); const legacy = b && (b.type === "share" || (b.type === "client" && ["rapport_klar", "kontakt_cta"].includes(b.event))); if (b && !legacy) landings.push(b); else events.push(b); } catch { events.push({ raw: route.request().postData() }); }
    return route.fulfill({ status: 204, headers: CORS });
  });
  await page.route(/cloudflareinsights/, (r) => r.abort());
  await page.goto(base + "/#gratis", { waitUntil: "load" });
  // Playwright slår på filväljar-avlyssning asynkront: utan lyssnare + liten väntan kan det första Enter-trycket
  // komma före avlyssningen (testartefakt, påvisad i 12 körningar utan lyssnare: 6 missar; med lyssnare: 0).
  page.on("filechooser", () => {});
  await page.waitForSelector("#pathsel", { state: "attached" });
  await page.waitForTimeout(300);
  return { page, context, events, reviews, landings };
}
async function runWithText(page, text = "Offert 42 820 kr") {
  await page.click("#paste");
  await page.fill("#txt", text);
  await page.click("#run");
  await page.waitForSelector("#res .gmo-card, #errbox.on");
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
  await page.waitForSelector(".gmo-card");
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
  assert.match(await ok.page.evaluate(() => document.activeElement.textContent), /Avvikelse som behöver förklaras/);
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
  t = await summaryFor((r) => { r.contradictions = []; r.priceReport.checked = [{ id: "rot_belopp", status: "ok", title: "ROT-belopp", text: "ok", source: "" }]; r.priceReport.cannotAssess = []; });
  assert.match(t, /inga räknefel upptäckta i AI-kontrollen/);
  assert.match(t, /1 prisregel kontrollerad och stämmer/);
  // F8/N18: bara formalia (moms/pristyp) är inte "prisregler som stämmer"
  t = await summaryFor((r) => { r.contradictions = []; r.priceReport.checked = [{ id: "moms", status: "ok", title: "Moms", text: "ok", source: "" }, { id: "pristyp", status: "ok", title: "Pristyp", text: "Fast pris anges.", source: "" }]; r.priceReport.cannotAssess = [{ title: "Belopp", text: "Inga belopp kan bedömas.", source: "" }]; });
  assert.doesNotMatch(t, /prisreg(el|ler)[^,]*stämmer/);
  assert.match(t, /2 formaliauppgifter kontrollerade – inga priser bedömda/);
  // fel som finns får inte döljas av grönt
  t = await summaryFor(() => {});
  assert.match(t, /1 prisregel som inte stämmer/);
  assert.doesNotMatch(t, /kontrollerad och stämmer/);
});

for (const role of ["mottagare", "hantverkare"]) {
  test(`export (${role}): full kopia bär alla fynd med neutral sifferrubrik; meddelandet är det som visas och skickas`, async () => {
    const { page, context } = await newPage({ width: 390, height: 844 });
    await page.click(`.pathcard[data-path=${role}]`);
    await runWithText(page);
    const mail = decodeURIComponent((await page.getAttribute("#sendmail", "href")).split("body=")[1]);
    await page.click("#copybtn");
    await page.waitForFunction(() => document.getElementById("copybtn").textContent === "Kopierat!");
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    // Full kopia: alla fynd, med AI-sifferfynd under neutral rubrik + förbehåll direkt före fynden (STATUS-03)
    assert.doesNotMatch(clip, /Räknefel och motsägelser/);
    assert.match(clip, /Sifferuppgifter att kontrollera mot originalet:\nAI-avläsningen visar möjliga avvikelser\. Jämför uppgifterna med originalofferten; detta är inte konstaterade fel\.\n– Summan stämmer inte: Raderna summerar till 42 820 kr men totalen är 45 000 kr\./);
    for (const m of [/Prisregler som inte stämmer:\n– ROT-belopp: ROT-avdraget 9 000 kr/, /Prisfrågor:\n– Pristyp/, /Går inte att bedöma:\n– Avläsningen/, /Startdatum/, /Räknekontrollens anteckning: Kontrollerade timmar × timpris\./]) assert.match(clip, m);
    if (role === "mottagare") assert.match(clip, /Vilket startdatum gäller\?/); else assert.match(clip, /Punkter att förtydliga/);
    // Meddelandet: samma text som förhandsvisas i blocket; hälsning bara till mottagaren, aldrig till en själv
    const items = await page.$$eval("#msgblock li", (l) => l.map((x) => x.textContent));
    assert.ok(items.length >= 3);
    for (const t of items) assert.ok(mail.includes(t), "förhandsvisad rad följer med: " + t);
    assert.match(mail, /ROT-belopp: ROT-avdraget 9 000 kr stämmer inte/);
    assert.match(mail, /inte konstaterade fel/);
    assert.doesNotMatch(mail, /Räknefel och motsägelser/);
    if (role === "mottagare") { assert.match(mail, /^Hej! Jag har några frågor om offerten innan jag skriver på:/); assert.match(mail, /Vilket startdatum gäller\?/); assert.equal((await page.textContent("#sendmail")).trim(), "Skicka frågorna"); }
    else { assert.match(mail, /^Punkter att åtgärda innan offerten skickas:/); assert.doesNotMatch(mail, /Hej!/); assert.match(mail, /Startdatum: Inget startdatum anges\./); assert.equal((await page.textContent("#copymsg")).trim(), "Kopiera punkterna"); }
    // skärmen visar samma fynd
    const screen = await page.textContent("#res");
    for (const must of ["Summan stämmer inte", "ROT-belopp", "Pristyp", "Avläsningen"]) assert.ok(screen.includes(must), must);
    // SMS finns bara i mobilläge
    assert.equal(await page.$("#sendsms") !== null, await page.evaluate(() => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && innerWidth < 900)));
    await context.close();
  });
}

test("F8/N18: bara formalia kontrollerat → inget positivt 'offerten verkar besvara'-besked, varken i listor eller sammanfattning", async () => {
  const r = clone(RESULT);
  r.contradictions = []; r.clarify = []; r.questions = []; r.calcCoverage = "insufficient_data";
  r.priceReport.checked = [{ id: "moms", status: "ok", title: "Moms", text: "ok", source: "" }, { id: "pristyp", status: "ok", title: "Pristyp", text: "Fast pris anges.", source: "" }];
  r.priceReport.compared = []; r.priceReport.cannotAssess = [{ title: "Belopp", text: "Inga belopp kan bedömas.", source: "" }];
  const { page, context } = await newPage({ width: 390, height: 844 }, { review: { status: 200, body: r } });
  await runWithText(page);
  const screen = await page.textContent("#res");
  assert.doesNotMatch(screen, /prisreg(el|ler)[^.]*stämmer/);
  assert.doesNotMatch(screen, /verkar besvara det vi kontrollerar/);
  assert.match(screen, /inget besked om att offerten är komplett/);
  assert.match(screen, /2 formaliauppgifter kontrollerade/);
  await context.close();
});

test("export: Kopiera ger hela texten; e-post förkortas uttryckligen med synlig kortversion och förbehåll följer kvarvarande osäkra fynd", async () => {
  const r = clone(RESULT);
  r.clarify = Array.from({ length: 40 }, (_, i) => ({ key: `Punkt ${i + 1}`, text: "En ganska lång beskrivning av något som saknas i offerten och behöver förtydligas." }));
  r.priceReport.cannotAssess.push({ title: "SISTA_RADEN", text: "Sista osäkerheten.", source: "" });
  const { page, context } = await newPage({ width: 390, height: 844 }, { review: { status: 200, body: r } });
  await page.click(".pathcard[data-path=hantverkare]");
  await runWithText(page);
  const n = (await page.$$eval("#msgblock ol li", (l) => l.length));
  assert.ok(n > 40);
  assert.match(await page.textContent("#msgcount"), new RegExp(`Alla ${n} punkter följer med`));
  const mail = decodeURIComponent((await page.getAttribute("#sendmail", "href")).split("body=")[1]);
  assert.ok(encodeURIComponent(mail).length <= 1900 + 50);
  const m = mail.match(/\(Kortversion: (\d+) av (\d+) punkter ingår\.\)/);
  assert.ok(m, "förkortningen står i texten");
  assert.equal(Number(m[2]), n);
  assert.equal(await page.isVisible("#shortnote"), true);
  const shown = await page.textContent("#shortnote pre");
  assert.ok(shown.includes(mail.split("\n\nGranskat med")[0]), "kortversionen som visas är exakt den som öppnas");
  assert.match(await page.textContent("#shortnote"), /bara de första \d+ av \d+ punkter följer med/);
  // fullt meddelande och hel rapport går alltid att kopiera
  await page.click("#copymsg");
  await page.waitForFunction(() => document.getElementById("copymsg").textContent === "Kopierat!");
  const full = await page.evaluate(() => navigator.clipboard.readText());
  assert.doesNotMatch(full, /Kortversion/); assert.match(full, /Punkt 40/);
  await page.click("#copybtn");
  await page.waitForFunction(() => document.getElementById("copybtn").textContent === "Kopierat!");
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.doesNotMatch(clip, /Kortversion/);
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
  await page.goto(base + "/?sd-test=1#gratis");
  await runWithText(page);
  await page.waitForTimeout(200);
  assert.equal(events[0].test, true);
  await context.close();
});

// ---- S2: Resultatkort ----
async function cardFor(mut, vp = { width: 390, height: 844 }, path = "mottagare") {
  const r = clone(RESULT); mut(r);
  const { page, context } = await newPage(vp, { review: { status: 200, body: r } });
  if (path !== "mottagare") await page.click(`.pathcard[data-path=${path}]`);
  await runWithText(page);
  await page.waitForTimeout(900);
  const card = await page.$eval(".gmo-card", (el) => ({
    tone: el.dataset.tone, h2: el.querySelector("h2").textContent, short: el.querySelector(".gmo-short").textContent,
    counts: Object.fromEntries([...el.querySelectorAll(".gmo-counts [data-c]")].map((e) => [e.dataset.c, Number(e.querySelector("strong")?.textContent ?? 0)])),
    countText: el.querySelector(".gmo-counts").textContent,
    next: el.querySelector(".gmo-next p").textContent, gap: !!el.querySelector(".gmo-gap"), scope: el.querySelector(".gmo-scope")?.textContent || "",
    rows: [...el.querySelectorAll(".gmo-rows .st-row")].map((r) => ({ st: r.dataset.st, label: r.querySelector(".st-label").textContent, word: r.querySelector(".st-word").textContent.replace(/^·\s*/, ""), mark: r.querySelector(".st-mark").textContent, t: r.querySelector(".st-text")?.textContent || "" })),
    bars: el.querySelectorAll(".gmo-track,.gmo-fill,.gmo-bars").length,
  }));
  return { page, context, card };
}
const okRule = [{ id: "rot_belopp", status: "ok", title: "ROT-belopp", text: "ok", source: "" }, { id: "tim_x", status: "ok", title: "Timpris", text: "ok", source: "" }];
const clearMut = (r) => { r.contradictions = []; r.clarify = []; r.questions = []; r.priceReport.checked = clone(okRule); r.priceReport.cannotAssess = []; r.priceReport.partial = false; };

test("resultatkort: röd bara vid beräknad prisregel som föll ut som fel; antal per färg, bara >0", async () => {
  const { context, card } = await cardFor(() => {});
  assert.equal(card.tone, "red");
  assert.deepEqual(card.counts, { green: 1, red: 1, amber: 4, grey: 1 }); // 1 stämmer, 1 ROT fel, (1 fråga+2 förtydliganden+1 AI-avläst siffra), 1 ej bedömd
  assert.match(card.h2, /Avvikelse/);
  assert.match(card.short, /Kontrollera mot originalet/);
  assert.equal(card.bars, 0, "inga staplar/progress: bara statusrader");
  assert.equal(card.rows.length, 4);
  assert.deepEqual(card.rows.map((r) => r.st), ["bad", "bad", "ok", "ask"]);
  assert.deepEqual(card.rows.map((r) => r.label), ["Räkningen", "Prisregler", "Jämförelse med referens", "Tydlighet i offerten"]);
  assert.match(card.rows[0].t, /1 beräknad avvikelse · 1 möjlig avvikelse att kontrollera mot originalet/);
  assert.match(card.rows[1].t, /0 av 3 stämmer · 1 avvikelse · 1 fråga · 1 ej bedömd/);
  assert.match(card.rows[2].t, /1 av 1 inom referensintervall; ingen garanti om rimligt pris/);
  assert.match(card.rows[3].t, /1 anges i offerten \(inte verifierat\) · 2 att förtydliga/);
  assert.ok(card.rows.every((r) => r.word && r.mark), "ord och symbol på varje rad");
  await context.close();
});

test("resultatkort: AI-avläst motsägelse ensam är gul 'Kontrollera siffrorna i originalet', aldrig säkert rött", async () => {
  const { context, card } = await cardFor((r) => { clearMut(r); r.contradictions = [{ key: "Räknefel", text: "Modellen tror att beloppen skiljer." }]; });
  assert.equal(card.tone, "amber");
  assert.match(card.h2, /Kontrollera siffrorna i originalet/);
  assert.equal(card.counts.red, undefined);
  assert.equal(card.counts.amber, 1);
  assert.equal(card.rows[0].st, "ask");
  assert.match(card.rows[0].t, /1 möjlig avvikelse att jämföra med originalet; inget konstaterat fel/);
  assert.ok(card.rows.every((r) => r.st !== "bad"), "AI-avläsning ensam är aldrig röd");
  await context.close();
});

test("resultatkort: gul när något ska förtydligas, aldrig grön med frågor kvar; inga nollräknare", async () => {
  const { context, card } = await cardFor((r) => { clearMut(r); r.clarify = [{ key: "Start", text: "saknas" }]; });
  assert.equal(card.tone, "amber");
  assert.equal(card.counts.red, undefined); assert.equal(card.counts.grey, undefined);
  assert.equal(card.counts.amber, 1);
  assert.doesNotMatch(card.countText, /\b0\b/);
  await context.close();
});

test("resultatkort: grön bara när allt bedömt stämmer och inget centralt är obedömt; avgränsning synlig", async () => {
  const { context, card } = await cardFor(clearMut);
  assert.equal(card.tone, "green");
  assert.deepEqual(card.counts, { green: 4 });
  assert.match(card.short, /4 av 4 kontroller stämmer/);
  assert.match(card.scope, /Kontrollerat: räkningen, 2 prisregler, 1 jämförelse med referens/);
  assert.doesNotMatch(card.h2 + card.short, /offerten är bra|bra offert|poäng/i);
  assert.deepEqual(card.rows.map((r) => r.st), ["ok", "ok", "ok", "stated"]);
  assert.equal(card.rows[3].word, "Anges, ej verifierat", "angivet i offerten är inte verifierat och inte grönt");
  assert.notEqual(card.rows[3].mark, card.rows[0].mark);
  await context.close();
});

test("resultatkort: grå när räkningen inte kunde kontrolleras eller prisdelen är ofullständig – aldrig grön; Ej bedömd har eget ord och symbol", async () => {
  for (const mut of [(r) => { clearMut(r); r.calcCoverage = "insufficient_data"; }, (r) => { clearMut(r); r.priceReport.partial = true; }, (r) => { clearMut(r); r.priceReport.cannotAssess = [{ title: "Belopp", text: "x", source: "" }]; }, (r) => { clearMut(r); delete r.priceReport; }]) {
    const { context, card } = await cardFor(mut);
    assert.equal(card.tone, "grey", JSON.stringify(card));
    assert.ok(card.counts.grey >= 1);
    assert.equal(card.gap, true);
    assert.doesNotMatch(card.h2 + card.short, /Kontrollerade delar stämmer/);
    await context.close();
  }
  const { context, card } = await cardFor((r) => { clearMut(r); r.calcCoverage = "insufficient_data"; });
  const calc = card.rows[0];
  assert.equal(calc.st, "unknown"); assert.equal(calc.word, "Ej bedömt"); assert.equal(calc.mark, "–"); assert.match(calc.t, /Ej bedömd/);
  await context.close();
});

test("resultatkort: en jämförelse som inte kunde genomföras (ej_bedombar) är okänd, inte en prisfråga", async () => {
  const { context, card } = await cardFor((r) => { clearMut(r); r.priceReport.compared = [{ id: "projekt", mode: "ej_bedombar", title: "Projektpris", text: "Ingen säker jämförelse.", source: "" }]; });
  assert.equal(card.tone, "grey");
  assert.equal(card.counts.amber, undefined);
  assert.ok(card.counts.grey >= 1);
  assert.equal(card.rows[2].st, "unknown");
  assert.match(card.rows[2].t, /1 jämförelse ej bedömd; ingen prisfråga eller avvikelse/);
  await context.close();
});

test("resultatkort: grå när ingenting kunde bedömas; ofullständigt men med fynd visar ändå 'ej bedömt' synligt", async () => {
  const { context, card } = await cardFor((r) => { r.contradictions = []; r.clarify = []; r.priceReport.checked = []; r.priceReport.compared = []; r.priceReport.cannotAssess = [{ title: "x", text: "y", source: "" }]; r.calcCoverage = "insufficient_data"; });
  assert.equal(card.tone, "grey");
  assert.match(card.h2, /Underlag saknas/);
  await context.close();
  const m = await cardFor((r) => { clearMut(r); r.clarify = [{ key: "A", text: "b" }]; r.priceReport.cannotAssess = [{ title: "x", text: "y", source: "" }]; });
  assert.equal(m.card.tone, "amber");
  assert.equal(m.card.gap, true);
  await m.context.close();
});

test("resultatkort: formalia ensamt ger inte grönt", async () => {
  const { context, card } = await cardFor((r) => { clearMut(r); r.priceReport.checked = [{ id: "moms", status: "ok", title: "Moms", text: "ok", source: "" }]; });
  assert.equal(card.tone, "grey");
  assert.equal(card.gap, true);
  await context.close();
});

test("resultatkort: statusrader utan staplar, procent eller rörelse; höjden ändras inte efter rendering", async () => {
  const r = clone(RESULT);
  const { page, context } = await newPage({ width: 390, height: 844 }, { review: { status: 200, body: r } });
  await runWithText(page);
  const h0 = await page.$eval(".gmo-card", (e) => Math.round(e.getBoundingClientRect().height));
  await page.waitForTimeout(1000);
  const h1 = await page.$eval(".gmo-card", (e) => Math.round(e.getBoundingClientRect().height));
  assert.equal(h0, h1);
  assert.equal(await page.$$eval(".gmo-track,.gmo-fill,.gmo-bars,[role=progressbar],progress,meter", (e) => e.length), 0);
  assert.doesNotMatch(await page.textContent(".gmo-rows"), /\d\s?%/, "ingen procent/poäng i raderna");
  assert.ok(await noHScroll(page));
  await context.close();
});

test("resultat: ALLA fynd, frågor och prisrutor ligger bakom EN riktig öppning; stängd = dolda, exporten oförändrad", async () => {
  const { page, context } = await newPage({ width: 390, height: 844 }, { review: { status: 200, body: clone(RESULT) } });
  await runWithText(page);
  assert.equal(await page.$$eval("#res details", (d) => d.length), 1);
  assert.equal(await page.$eval("#res details.gmo-all", (d) => d.open), false);
  for (const h of ["Sifferuppgifter att kontrollera mot originalet", "Prisbild"]) assert.equal(await page.getByRole("heading", { name: h }).isVisible(), false, h + " ska vara dolt tills öppning");
  assert.equal(await page.locator(".gmo-all summary").isVisible(), true);
  await page.click(".gmo-all summary");
  for (const h of ["Sifferuppgifter att kontrollera mot originalet", "Prisbild"]) assert.equal(await page.getByRole("heading", { name: h }).isVisible(), true, h);
  assert.ok(await noHScroll(page));
  // Tangentbord: Enter på summary öppnar/stänger
  await page.focus(".gmo-all summary"); await page.keyboard.press("Enter");
  assert.equal(await page.$eval("#res details.gmo-all", (d) => d.open), false);
  await context.close();
});

test("övergång: skelett före anropet, resultatet byter innehåll på plats – ingen slutscroll, ankaret rör sig inte", async () => {
  const { page, context } = await newPage({ width: 390, height: 844 }, { review: { status: 200, body: clone(RESULT), delay: 1200 } });
  const src = pageSource("index.html");
  assert.doesNotMatch(src, /behavior:\s*'smooth'/);
  await page.click("#paste"); await page.fill("#txt", "x".repeat(60));
  await page.click("#run");
  await page.waitForSelector(".gmo-skel", { state: "visible" });
  await page.waitForTimeout(400);
  const before = await page.evaluate(() => ({ y: scrollY, top: Math.round(document.getElementById("res").getBoundingClientRect().top + scrollY) }));
  assert.equal(await page.getAttribute("#res", "aria-busy"), "true");
  await page.waitForSelector(".gmo-card", { state: "visible" });
  await page.waitForTimeout(1000);
  const after = await page.evaluate(() => ({ y: scrollY, top: Math.round(document.getElementById("res").getBoundingClientRect().top + scrollY) }));
  assert.deepEqual(after, before, "ingen scroll och ingen flytt av resultatankaret när resultatet kommer");
  assert.equal(await page.$(".gmo-skel"), null);
  await context.close();
});

test("resultatkort: prefers-reduced-motion – ingen rörelse och inga staplar", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.route("**/review", (route) => route.request().method() === "OPTIONS" ? route.fulfill({ status: 204, headers: CORS }) : route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(RESULT) }));
  await page.route("**/event", (route) => route.fulfill({ status: 204, headers: CORS }));
  await page.route(/cloudflareinsights/, (r) => r.abort());
  await page.goto(base + "/#gratis");
  await runWithText(page);
  const mov = await page.$$eval(".gmo-card, .gmo-card *", (els) => els.filter((e) => { const c = getComputedStyle(e); return c.animationName !== "none" || /[1-9]/.test(c.transitionDuration.replace(/0s|0ms|,/g, "")); }).length);
  assert.equal(mov, 0, "ingen rörelse i resultatkortet");
  assert.equal(await page.$$eval(".gmo-fill,.gmo-track", (e) => e.length), 0);
  await context.close();
});

test("Växjö: borta ur rubrik, sidfot, exempel och CTA; platsen finns kvar i Företagsuppgifter", async () => {
  const { page, context } = await newPage({ width: 390, height: 844 });
  const head = await page.textContent("header"); const foot = await page.textContent(".foot");
  assert.doesNotMatch(head + foot, /Växjö/);
  await page.click("#demo");
  await page.waitForSelector("#res.on");
  await page.goto(base + "/#gratis");
  await page.click(".pathcard[data-path=hantverkare]");
  await runWithText(page);
  assert.doesNotMatch(await page.textContent("#res"), /Växjö/);
  assert.doesNotMatch(await page.evaluate(() => document.getElementById("txt").value + document.body.innerHTML.match(/Kund: [^\n]*/)?.[0]), /Växjö/);
  await page.goto(base + "/sa-granskar-vi-priser/");
  assert.doesNotMatch(await page.textContent("header") + await page.textContent(".foot"), /Växjö/);
  await page.goto(base + "/foretagsuppgifter/");
  assert.match(await page.textContent("body"), /Växjö/);
  await context.close();
});
