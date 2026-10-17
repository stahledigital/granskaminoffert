// D19 gratisresultat: STATUS-01/02/03, RESULT-01/02, SHARE-01/02/03 (syntetiska fall S01–S08 ur Codex referens; inga nätverk/AI-anrop).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { startHarness } from "../../worker/dev/compare_harness.mjs";

const PW = process.env.PLAYWRIGHT_MODULE || "/opt/npm-tools/node_modules/playwright/index.mjs";
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
const { chromium } = await import(pathToFileURL(PW).href);
const FX = JSON.parse(readFileSync(new URL("./fixtures/status_cases.json", import.meta.url), "utf8"));
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
let browser, h;
before(async () => { browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] }); h = await startHarness({ vars: {} }); });
after(async () => { await browser?.close(); await h?.close(); });
import { normalizeClientEvent } from "../../worker/src/measure.js";
const clone = (o) => JSON.parse(JSON.stringify(o));
const norm = (t) => t.replace(/[\s·]+/g, "").toLowerCase();

async function open(result, { role = "mottagare", width = 390, mobile = false, reducedMotion, media } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, permissions: ["clipboard-read", "clipboard-write"], ...(mobile ? { userAgent: MOBILE_UA, isMobile: true, hasTouch: true } : {}), ...(reducedMotion ? { reducedMotion } : {}) });
  const page = await ctx.newPage(); const events = [], reviews = [];
  await page.route("**/review", (r) => { if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: CORS }); reviews.push(1); return r.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(result) }); });
  await page.route("**/event", (r) => { if (r.request().method() !== "OPTIONS") { try { events.push(r.request().postDataJSON()); } catch {} } return r.fulfill({ status: 204, headers: CORS }); });
  await page.route(/cloudflareinsights/, (r) => r.abort());
  await page.goto(h.base + "/#gratis"); await page.waitForSelector("#pathsel", { state: "attached" }); await page.waitForTimeout(250);
  if (role === "hantverkare") await page.click(".pathcard[data-path=hantverkare]");
  await page.click("#paste"); await page.fill("#txt", "Offert 42 820 kr"); await page.click("#run");
  await page.waitForSelector(".gmo-card");
  if (media) await page.emulateMedia({ media });
  return { page, ctx, events, reviews };
}
const rowsOf = (page) => page.$$eval(".gmo-rows .st-row", (rs) => rs.map((r) => ({ st: r.dataset.st, label: r.querySelector(".st-label").textContent, text: r.querySelector(".st-text")?.textContent || "" })));
const countsOf = (page) => page.$eval(".gmo-counts", (el) => Object.fromEntries([...el.querySelectorAll("[data-c]")].map((e) => [e.dataset.c, Number(e.querySelector("strong")?.textContent ?? 0)])));
const copyFull = async (page) => { await page.click("#copybtn"); await page.waitForFunction(() => document.getElementById("copybtn").textContent === "Kopierat!"); return page.evaluate(() => navigator.clipboard.readText()); };

for (const c of FX.cases) {
  test(`STATUS-01 ${c.id}: statusrader och globala räknare enligt referens, utan staplar`, async () => {
    const { page, ctx } = await open(clone(c.input));
    const rows = await rowsOf(page);
    assert.equal(rows.length, 4);
    for (let i = 0; i < 4; i++) { assert.equal(rows[i].label, c.rows[i].label); assert.ok(norm(rows[i].text).startsWith(norm(c.rows[i].text)), `${c.id} rad ${rows[i].label}: «${rows[i].text}» ≠ «${c.rows[i].text}»`); }
    const lc = c.legacyCounters, cnt = await countsOf(page);
    assert.equal(cnt.green ?? 0, lc.ok); assert.equal(cnt.red ?? 0, lc.bad); assert.equal(cnt.amber ?? 0, lc.attention); assert.equal(cnt.grey ?? 0, lc.unknown);
    assert.equal(await page.$$eval(".gmo-track,.gmo-fill,.gmo-bars,[role=progressbar]", (e) => e.length), 0);
    // grönt (✓/ok) bara kontrollerat; angivet ej verifierat och ej bedömt har olika ord och symbol
    for (const r of rows) assert.ok(["ok", "ask", "bad", "stated", "unknown"].includes(r.st));
    const marks = await page.$$eval(".gmo-rows .st-row", (rs) => Object.fromEntries(rs.map((r) => [r.dataset.st, [r.querySelector(".st-mark").textContent, r.querySelector(".st-word").textContent]])));
    if (marks.stated && marks.unknown) { assert.notEqual(marks.stated[0], marks.unknown[0]); assert.notEqual(marks.stated[1], marks.unknown[1]); }
    if (marks.stated) assert.notEqual(marks.stated[0], "✓");
    await ctx.close();
  });
}

for (const role of ["mottagare", "hantverkare"]) {
  for (const id of ["S01", "S03", "S05"]) {
    test(`STATUS-03 ${id} (${role}): export enligt målfacit – neutral rubrik/förbehåll, ej_bedombar en gång i unsure`, async () => {
      const c = FX.cases.find((x) => x.id.startsWith(id)); const tg = FX.exportTarget[c.id];
      const { page, ctx } = await open(clone(c.input), { role });
      const clip = await copyFull(page);
      for (const m of tg.mustContain) assert.ok(clip.includes(m), `${c.id} ${role}: saknar «${m}»`);
      for (const hd of tg.mustNotContainHeading) assert.ok(!new RegExp(`^${hd}:?$`, "m").test(clip), `${c.id}: rubriken «${hd}» ska inte finnas`);
      if (tg.itemOccurrence) assert.equal(clip.split(tg.itemOccurrence.text).length - 1, tg.itemOccurrence.count);
      if (id === "S05") { assert.ok(!/^Prisfrågor:/m.test(clip)); assert.ok(/^Går inte att bedöma:\n– Projektpris/m.test(clip)); }
      if (id === "S01") { assert.ok(/Prisregler som inte stämmer:\n– ROT-belopp/.test(clip)); assert.equal(clip.split("Raderna summerar till 42 820 kr men totalen är 45 000 kr.").length - 1, 1); }
      // förbehållet står direkt före fynden
      if (id !== "S05") assert.ok(/Sifferuppgifter att kontrollera mot originalet:\nAI-avläsningen visar möjliga avvikelser\. Jämför uppgifterna med originalofferten; detta är inte konstaterade fel\.\n– /.test(clip));
      await ctx.close();
    });
  }
}

test("SHARE-01: tom modellfrågelista men ROT-fel och AI-osäkerhet ger säkra mallfrågor; samma fråga från två källor slås ihop bara i meddelandet", async () => {
  const c = clone(FX.cases[0].input); c.questions = ["Vilken garanti ingår?"]; c.clarify = [{ key: "Garanti", text: "Ingen garanti nämns." }, { key: "Startdatum", text: "Inget startdatum anges." }];
  const { page, ctx } = await open(c);
  const items = await page.$$eval("#msgblock li", (l) => l.map((x) => x.textContent));
  assert.ok(items.some((t) => /ROT-belopp: ROT-avdraget 9 000 kr stämmer inte med 30 % av arbetskostnaden\. Kan du förklara eller rätta det\?/.test(t)));
  assert.ok(items.some((t) => /Några siffror i offerten verkar inte gå ihop vid en automatisk avläsning\. Det är inte konstaterade fel/.test(t)));
  assert.equal(items.filter((t) => /garanti/i.test(t)).length, 1, "garantifrågan finns en gång i meddelandet");
  assert.ok(items.some((t) => /Kan du förtydliga: Startdatum\?/.test(t)));
  for (const t of items) assert.doesNotMatch(t, /fusk|bluff|vilseled|felaktig/i, "ingen anklagelse/påhittad orsak");
  const clip = await copyFull(page);   // fullrapportens fynd är kvar oförminskade
  assert.equal(clip.split("Ingen garanti nämns.").length - 1, 1); assert.ok(clip.includes("Vilken garanti ingår?"));
  const cnt = await countsOf(page); assert.equal(cnt.red, 1);   // global räkning oförändrad (ej dubblad av mallfrågorna)
  await ctx.close();
  // modellens frågelista tom men beräknat fel: knappen finns ändå
  const e = clone(FX.cases[0].input); e.questions = []; e.clarify = [];
  const o2 = await open(e); assert.ok(await o2.page.$("#sendmail")); await o2.ctx.close();
});

test("SHARE-02: fullt lugn rapport utan relevanta frågor – ingen tom Skicka-knapp, ingen hälsning, ingen falsk godkännandeförklaring", async () => {
  const c = clone(FX.cases.find((x) => x.id.startsWith("S02")).input); c.questions = []; c.clarify = [];
  for (const role of ["mottagare", "hantverkare"]) {
    const { page, ctx } = await open(clone(c), { role, mobile: true });
    assert.equal(await page.$("#sendmail"), null); assert.equal(await page.$("#sendsms"), null); assert.equal(await page.$("#copymsg"), null);
    const t = await page.textContent("#msgempty");
    assert.match(t, /Vi hittade (inga frågor att ställa|inget att åtgärda) i det vi kontrollerade/);
    assert.doesNotMatch(await page.textContent("#res"), /Hej! Jag har några frågor/);
    assert.match(t, /Det säger inget om hantverkarens kvalitet|Det är inget besked om att offerten är komplett/); assert.doesNotMatch(t, /bra hantverkare|kvalitet är god|offerten är godkänd/i);
    assert.ok(await page.$("#copybtn"), "hela granskningen går att kopiera");
    await ctx.close();
  }
});

test("SHARE-03: SMS-kortversion visas före öppning, är exakt det som öppnas, och hela meddelandet går att kopiera", async () => {
  const c = clone(FX.cases[0].input); c.clarify = Array.from({ length: 30 }, (_, i) => ({ key: `Punkt ${i + 1}`, text: "En ganska lång beskrivning av något som saknas i offerten." })); c.questions = [];
  const { page, ctx, events } = await open(c, { mobile: true });
  const sms = decodeURIComponent((await page.getAttribute("#sendsms", "href")).split("body=")[1]);
  assert.ok(encodeURIComponent(sms).length <= 1250);
  assert.match(sms, /\(Kortversion: \d+ av \d+ frågor ingår\.\)/);
  const shown = await page.$$eval("#shortnote pre", (p) => p.map((x) => x.textContent));
  assert.ok(shown.some((t) => sms.startsWith(t.split("\n\nGranskat med")[0])), "visad kortversion = öppnad text");
  assert.equal(await page.isVisible("#shortnote"), true);
  // inget skickas automatiskt: länkarna är rena href, inga skickhändelser före klick
  assert.equal(events.filter((e) => e.type === "share").length, 0);
  await page.click("#copymsg"); await page.waitForFunction(() => document.getElementById("copymsg").textContent === "Kopierat!");
  const full = await page.evaluate(() => navigator.clipboard.readText());
  assert.doesNotMatch(full, /Kortversion/); assert.match(full, /Punkt 30/);
  // osäkerhetsförbehållet följer med så länge AI-sifferfyndet ingår i den korta texten
  assert.ok(/Det är inte konstaterade fel/.test(sms) || !/Några siffror/.test(sms));
  await ctx.close();
});

test("RESULT-01/02: prisgrund + frågor före delning; saknat referensintervall/okänd moms ger ingen fabricerad jämförelse eller grön prisgaranti", async () => {
  const c = clone(FX.cases.find((x) => x.id.startsWith("S07")).input);
  c.priceReport.checked = [{ id: "moms", status: "fraga", title: "Moms", text: "Momsläget i offerten gick inte att läsa ut på ett tillförlitligt sätt.", source: "" }];
  c.priceReport.compared = []; c.priceReport.cannotAssess = [{ title: "Projektpris", text: "Ingen säker jämförelse.", source: "" }];
  c.price = { hourlyRateSek: null, totalSumSek: 50000, rotDeducted: null, comment: "" };
  const { page, ctx } = await open(c, { width: 375 });
  const order = await page.$$eval("#res > *", (els) => els.map((e) => e.id || e.className.split(" ")[0]));
  assert.ok(order.indexOf("pbasis") > order.indexOf("gmo-card") && order.indexOf("msgblock") > order.indexOf("pbasis"), "kort → prisgrund → fråge-/meddelandeblock: " + order);
  const pb = await page.textContent("#pbasis");
  assert.match(pb, /totalsumma 50\s000 kr/); assert.match(pb, /Momsläget i offerten gick inte att läsa ut/); assert.match(pb, /Ingen jämförelse mot referensintervall ingick, så ingen prisbedömning görs/); assert.match(pb, /Projektpris/);
  assert.doesNotMatch(pb, /inom referensintervall|rimligt pris\b(?!\.)/);
  const rows = await rowsOf(page);
  assert.equal(rows.find((r) => r.label === "Jämförelse med referens").st, "unknown");
  assert.notEqual(rows.find((r) => r.label === "Prisregler").st, "ok");
  assert.equal(await page.$$eval(".gmo-rows .st-row[data-st=ok]", (e) => e.length), 0 + rows.filter((r) => r.st === "ok").length);
  assert.ok(await page.$eval("#msgblock", (m) => m.getBoundingClientRect().top) < 3000);
  await ctx.close();
});

for (const w of [320, 375, 390, 1280]) {
  test(`STATUS-02/LAYOUT-01: resultatkort ${w} px – ingen sidoscroll eller kapning, markörer läsbara`, async () => {
    const r = clone(FX.cases[0].input); r.clarify.push({ key: "L".repeat(80), text: "https://exempel.se/" + "a".repeat(200) });
    const { page, ctx } = await open(r, { width: w });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "ingen sidoscroll");
    const clipped = await page.$$eval(".st-main,.msgblock,.pbasis,.gmo-card", (els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
    assert.equal(clipped, 0);
    const small = await page.$$eval(".st-row", (rs) => rs.filter((r) => parseFloat(getComputedStyle(r.querySelector(".st-text") || r).fontSize) < 14).length);
    assert.equal(small, 0);
    await ctx.close();
  });
}

test("STATUS-02: svartvit utskrift – ord och symbol bär betydelsen, ljus palett, inga staplar", async () => {
  const { page, ctx } = await open(clone(FX.cases[0].input), { media: "print" });
  const rows = await page.$$eval(".gmo-rows .st-row", (rs) => rs.map((r) => ({ mark: r.querySelector(".st-mark").textContent, word: r.querySelector(".st-word").textContent, c: getComputedStyle(r.querySelector(".st-text")).color, bg: getComputedStyle(document.body).backgroundColor })));
  assert.ok(rows.every((r) => r.mark.trim() && r.word.trim()));
  const lum = (s) => { const m = s.match(/\d+/g).slice(0, 3).map(Number); return (m[0] * 299 + m[1] * 587 + m[2] * 114) / 1000; };
  for (const r of rows) assert.ok(Math.abs(lum(r.c) - lum(r.bg)) > 100, `kontrast i utskrift ${r.c} mot ${r.bg}`);
  await ctx.close();
});

test("STATUS-02: 200 % textstorlek ger ingen sidoscroll i statusrader, prisgrund och meddelandeblock", async () => {
  const { page, ctx } = await open(clone(FX.cases[0].input), { width: 390 });
  await page.addStyleTag({ content: "html{font-size:32px!important}" });
  await page.waitForTimeout(150);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await ctx.close();
});

test("MEASURE-01 (gratis): alla klienthändelser i gratisflödet accepteras av serverns riktiga normalisering – inga innehåll", async () => {
  const { page, ctx, events } = await open(clone(FX.cases[0].input)); await page.waitForTimeout(300);
  try {
    assert.ok(events.length >= 3, "landing/input/submit/result_view finns");
    for (const e of events) { if (e.type !== "client") continue; assert.ok(normalizeClientEvent(e), "servern accepterar: " + JSON.stringify(e)); assert.ok(JSON.stringify(e).length <= 1024); }
    assert.ok(!/Offert 42 820|42 820/.test(JSON.stringify(events)), "inget innehåll i mätningen");
    for (const n of ["landing", "input_ready", "submit", "result_view"]) assert.ok(events.some((e) => e.event === n), n);
  } finally { await ctx.close(); }
});
