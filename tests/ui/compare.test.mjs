// UI-test för Jämför mina offerter (D04): spelar HELA kundflödet i Chromium mot den riktiga paketerade
// Workern i lokal workerd (riktiga SQLite-DO + alarm) via worker/dev/compare_harness.mjs.
// Modell och Stripe är attrapper (ingen riktig modell, inga riktiga betalningar).
// Visar sidans logik/layout i Chromium vid 390 och 1280 px. Visar INTE något om riktig mobil, riktig
// skärmläsare eller VoiceOver (EJ TESTAT). Kör: MINIFLARE_DIR=… node --test tests/ui/compare.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startHarness, fakeCheckoutHtml } from "../../worker/dev/compare_harness.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PW = process.env.PLAYWRIGHT_MODULE || "/opt/npm-tools/node_modules/playwright/index.mjs";
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
const EVIDENCE = process.env.UI_EVIDENCE_DIR || join(ROOT, "tests", "ui", "evidence");
mkdirSync(EVIDENCE, { recursive: true });
const { chromium } = await import(pathToFileURL(PW).href);

let browser;
before(async () => { browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] }); });
after(async () => { await browser?.close(); });

const OFFERS = [
  "Offert badrum, Byggfirma AB\nRivning och bortforsling ingår.\nMaterial och arbete ingår.\nResor ingår.\nTotalt 100 000 kr inkl. moms före ROT",
  "Offert badrum, Bygg B\nRivning ingår. Material och arbete ingår. Resor ingår.\nBortforsling av avfall ingår inte.\nTotalt 90 000 kr exkl. moms före ROT",
  "Offert badrum, C-snickeri\nMaterial och arbete ingår. Resor ingår.\nSumma 110 000 kr inkl. moms före ROT",
];

async function newPage(h, width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: "sv-SE" });
  await ctx.route("https://checkout.stripe.test/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: fakeCheckoutHtml(h.base, new URL(route.request().url()).pathname.split("/").pop()) }));
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return { ctx, page, errors };
}
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function fillAndCheck(page, texts) {
  const n = texts.length;
  await page.click(`.seg button[data-n="${n}"]`);
  for (let i = 0; i < n; i++) { await page.fill(`#lab${i}`, ["Byggfirma AB", "Bygg B", "C-snickeri", "Firma D"][i]); await page.fill(`#t${i}`, texts[i]); }
  await page.check("#samejob");
  await page.click("#check");
  await page.waitForSelector("#offer:not(.hidden)", { timeout: 15000 });
}

for (const [name, w, hgt] of [["mobil390", 390, 844], ["desktop1280", 1280, 900]]) {
  test(`hela flödet (${name}): kontroll → erbjudande → betalning → resultat`, async () => {
    const h = await startHarness();
    const { ctx, page, errors } = await newPage(h, w, hgt);
    try {
      await page.goto(h.base + "/jamfor/");
      await page.waitForSelector("#s1:not(.hidden)");
      assert.ok(await noSideScroll(page), "ingen sidoscroll i steg 1");
      await page.screenshot({ path: join(EVIDENCE, `jamfor_${name}_1_start.png`), fullPage: true });
      // kontroll kräver bekräftelse av samma jobb
      await page.fill("#t0", OFFERS[0]);
      await page.click("#check");
      assert.match(await page.textContent("#err"), /samma jobb/);
      await fillAndCheck(page, OFFERS);
      assert.ok(await noSideScroll(page), "ingen sidoscroll i steg 2");
      assert.equal(await page.locator("#docs .tag.ok").count(), 3);
      assert.match(await page.textContent("#offer"), /49 kr/);
      assert.match(await page.textContent("#offer"), /9,80/);
      await page.screenshot({ path: join(EVIDENCE, `jamfor_${name}_2_erbjudande.png`), fullPage: true });
      // betalning kräver båda samtycken
      await page.click("#pay");
      assert.match(await page.textContent("#err"), /e-post/i);
      await page.fill("#email", "kund@example.test");
      await page.click("#pay");
      assert.match(await page.textContent("#err"), /villkoren/);
      assert.equal(h.stats.stripeCreate, 0);
      await page.fill("#email", "kund@example.test"); await page.check("#terms"); await page.check("#immediate");
      await page.click("#pay");
      await page.waitForURL("https://checkout.stripe.test/**");
      await page.click("#pay");
      await page.waitForURL(h.base + "/jamfor/**");
      await page.waitForSelector("#rep:not(.hidden)", { timeout: 30000 });
      assert.ok(await noSideScroll(page), "ingen sidoscroll i rapporten");
      const txt = await page.textContent("#rep");
      assert.match(txt, /Vi rangordnar inte/); // omfattningen skiljer → ingen "billigast vinner"
      assert.match(txt, /Framgår inte/);
      assert.match(txt, /Ingår inte/);
      assert.match(txt, /Kvitto/); assert.match(txt, /9,80 kr/);
      assert.match(txt, /Visas inte i den här versionen/);
      assert.ok(h.stats.anthropic >= 3 && h.stats.anthropic <= 4, "antal modellanrop " + h.stats.anthropic);
      await page.screenshot({ path: join(EVIDENCE, `jamfor_${name}_3_rapport.png`), fullPage: true });
      // radera
      await page.click("text=Radera min jämförelse");
      await page.waitForSelector("text=Jämförelsen är raderad.");
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); await h.close(); }
  });
}

test("avbruten betalning, dröjande webhook, återupptagning via länk och 2 offerter utan datakort", async () => {
  const h = await startHarness();
  const { ctx, page, errors } = await newPage(h, 390, 844);
  try {
    await page.goto(h.base + "/jamfor/");
    await page.waitForSelector("#s1:not(.hidden)");
    await fillAndCheck(page, [OFFERS[0], "Offert badrum\nRivning och bortforsling ingår. Material och arbete ingår. Resor ingår.\nTotalt 120 000 kr inkl. moms före ROT"]);
    await page.fill("#email", "kund@example.test"); await page.check("#terms"); await page.check("#immediate"); await page.click("#pay");
    await page.waitForURL("https://checkout.stripe.test/**");
    await page.click("#cancel");
    await page.waitForURL(h.base + "/jamfor/**");
    await page.waitForSelector("text=Betalningen avbröts");
    assert.equal(h.stats.anthropic, 0, "ingen generation utan betalning");
    await page.screenshot({ path: join(EVIDENCE, "jamfor_mobil390_avbruten.png"), fullPage: true });
    // betala igen, webhook dröjer: sidan får ändå reda på betalningen via serveravstämning
    await page.click("text=Gå till betalning igen");
    await page.waitForURL("https://checkout.stripe.test/**");
    await page.click("#paylate");
    await page.waitForURL(h.base + "/jamfor/**");
    // stäng fliken-scenario: ny sida utan lagrad order, bara återställningslänken.
    // Vänta på den faktiska länken (tick fyller #reclink asynkront efter navigeringen), inga sleeps.
    await page.waitForSelector("#recovery:not(.hidden)");
    await page.waitForFunction(() => /#o=o_[0-9a-f]{32}&t=/.test((document.querySelector("#reclink") || {}).textContent || ""));
    const link = await page.textContent("#reclink");
    assert.match(link, /#o=o_[0-9a-f]{32}&t=/);
    const p2 = await ctx.newPage();
    await p2.goto(link.replace(/^https?:\/\/[^/]+/, h.base));
    await p2.waitForSelector("#rep:not(.hidden)", { timeout: 40000 });
    const txt = await p2.textContent("#rep");
    assert.match(txt, /Lägst angivet belopp: Byggfirma AB/); // lika omfattning, samma bas → rangordning med förbehåll
    assert.match(txt, /säger inget om kvalitet/);
    assert.ok(await noSideScroll(p2));
    await p2.screenshot({ path: join(EVIDENCE, "jamfor_mobil390_2offerter.png"), fullPage: true });
    assert.equal(h.stats.anthropic >= 2, true);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

test("före köp: datatäckning (inga omdömen) och utkastmärkning syns; texterna kommer från servern; 'betala igen' återger inte tyst samtycke som kunden inte sett", async () => {
  const h = await startHarness({});
  const { ctx, page, errors } = await newPage(h, 390, 844);
  try {
    await page.goto(h.base + "/jamfor/");
    await page.waitForSelector("#s1:not(.hidden)");
    assert.match(await page.textContent("#coverage1"), /Omdömen om företagen ingår inte/);
    await fillAndCheck(page, [OFFERS[0], "Offert badrum\nRivning och bortforsling ingår. Material och arbete ingår. Resor ingår.\nTotalt 120 000 kr inkl. moms före ROT"]);
    const offer = await page.textContent("#offer");
    assert.match(offer, /Inga omdömen om företagen/);
    assert.match(offer, /tjänsten visar inga senaste omdömen/);
    assert.ok(await page.isVisible("#draftnote"), "utkastmärkning");
    assert.match(await page.textContent("#t-terms"), /utkast/i);
    assert.ok(await noSideScroll(page));
    await page.screenshot({ path: join(EVIDENCE, "jamfor_mobil390_erbjudande_utkast.png"), fullPage: true });
    await page.fill("#email", "kund@example.test"); await page.check("#terms"); await page.check("#immediate"); await page.click("#pay");
    await page.waitForURL("https://checkout.stripe.test/**");
    await page.click("#cancel");
    await page.waitForURL(h.base + "/jamfor/**");
    await page.waitForSelector("text=Betalningen avbröts");
    // Servern säger att samtycket inte längre gäller (texten har ändrats): sidan visar texterna igen och kräver nya kryss.
    let calls = 0;
    await page.route("**/compare/orders/*/checkout", async (route) => {
      const req = route.request();
      if (!req.postData() && calls++ === 0) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Läs och godkänn villkoren igen innan du betalar.", needAccept: true }) });
      return route.continue();
    });
    await page.click("text=Gå till betalning igen");
    await page.waitForSelector("#terms2");
    assert.match(await page.textContent("#statusbox"), /Läs och godkänn villkoren igen/);
    assert.equal(await page.isChecked("#terms2"), false); assert.equal(await page.isChecked("#immediate2"), false);
    await page.fill("#email2", "kund@example.test"); await page.click("#pay2");
    assert.match(await page.textContent("#err"), /Godkänn villkoren/);
    await page.fill("#email2", "kund@example.test"); await page.check("#terms2"); await page.check("#immediate2"); await page.click("#pay2");
    await page.waitForURL("https://checkout.stripe.test/**");
    assert.ok(h.stats.stripeCreate >= 1);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

test("stängd: utan COMPARE_ENABLED visar sidan att jämförelsen inte är öppen och länkar till gratisgranskningen", async () => {
  const h = await startHarness({ vars: { COMPARE_ENABLED: undefined } });
  const { ctx, page } = await newPage(h, 390, 844);
  try {
    await page.goto(h.base + "/jamfor/");
    await page.waitForSelector("#closed:not(.hidden)");
    assert.match(await page.textContent("#closed"), /inte öppen/);
    assert.equal(await page.locator("#s1:not(.hidden)").count(), 0);
    await page.screenshot({ path: join(EVIDENCE, "jamfor_mobil390_stangd.png"), fullPage: true });
  } finally { await ctx.close(); await h.close(); }
});

test("misslyckad leverans visas ärligt med återbetalningsbesked", async () => {
  const h = await startHarness();
  h.ctl.failAnthropic = 30;
  const { ctx, page } = await newPage(h, 390, 844);
  try {
    await page.goto(h.base + "/jamfor/");
    await page.waitForSelector("#s1:not(.hidden)");
    await fillAndCheck(page, [OFFERS[0], OFFERS[1]]);
    await page.fill("#email", "kund@example.test"); await page.check("#terms"); await page.check("#immediate"); await page.click("#pay");
    await page.waitForURL("https://checkout.stripe.test/**"); await page.click("#pay");
    await page.waitForURL(h.base + "/jamfor/**");
    await page.waitForSelector("text=kunde inte slutföras", { timeout: 60000 });
    assert.match(await page.textContent("#statusbox"), /pengarna tillbaka/);
    await page.screenshot({ path: join(EVIDENCE, "jamfor_mobil390_misslyckad.png"), fullPage: true });
  } finally { await ctx.close(); await h.close(); }
});

async function payFlow(page, h, offers) {
  await page.goto(h.base + "/jamfor/");
  await page.waitForSelector("#s1:not(.hidden)");
  await fillAndCheck(page, offers);
  await page.fill("#email", "kund@example.test"); await page.check("#terms"); await page.check("#immediate"); await page.click("#pay");
  await page.waitForURL("https://checkout.stripe.test/**"); await page.click("#pay");
  await page.waitForURL(h.base + "/jamfor/**");
}

for (const [name, w, hgt] of [["mobil390", 390, 844], ["desktop1280", 1280, 900]]) {
  test(`ånger efter levererad rapport (${name}): knapp i rapporten, begäran sparas utan automatiskt avslag`, async () => {
    const h = await startHarness();
    const { ctx, page, errors } = await newPage(h, w, hgt);
    try {
      await payFlow(page, h, OFFERS);
      await page.waitForSelector("#rep:not(.hidden)", { timeout: 30000 });
      assert.ok(await page.isVisible("#rep #withdraw"), "ångerknapp i rapporten");
      assert.match(await page.textContent("#agreement"), /Avtals-ID avt_/);
      assert.match(await page.textContent("#agreement"), /Utkast/);
      await page.screenshot({ path: join(EVIDENCE, `jamfor_${name}_4_rapport_med_anger.png`), fullPage: true });
      await page.click("#rep #withdraw");
      await page.waitForSelector("#wdtext", { timeout: 15000 });
      const t = await page.textContent("#wdtext");
      assert.match(t, /prövas manuellt|ingen bekräftelse|mottagen/i);
      assert.doesNotMatch(t, /avslag|avslagen|har inte rätt/i);
      assert.ok(await noSideScroll(page), "ingen sidoscroll efter ånger");
      await page.screenshot({ path: join(EVIDENCE, `jamfor_${name}_5_anger_efter_leverans.png`), fullPage: true });
      assert.equal(await page.locator("#rep #withdraw").count(), 0, "knappen ersätts av begärans status");
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); await h.close(); }
  });
}

test("ånger under pågående jämförelse (mobil390): stoppas före leverans, ingen rapport, hela beloppet ska tillbaka", async () => {
  const h = await startHarness();
  h.ctl.anthropicDelayMs = 4000;
  const { ctx, page, errors } = await newPage(h, 390, 844);
  try {
    await payFlow(page, h, OFFERS);
    await page.waitForSelector("#agreement #withdraw", { timeout: 30000 });
    await page.click("#agreement #withdraw");
    await page.waitForSelector("#wdtext", { timeout: 15000 });
    const t = await page.textContent("#wdtext");
    assert.match(t, /Hela beloppet ska betalas tillbaka|återbetalning|prövas manuellt/);
    assert.equal(await page.locator("#rep:not(.hidden)").count(), 0, "ingen rapport efter ånger före leverans");
    assert.ok(await noSideScroll(page));
    await page.screenshot({ path: join(EVIDENCE, "jamfor_mobil390_6_anger_under_korning.png"), fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

for (const [name, w, hgt] of [["mobil390", 390, 844], ["desktop1280", 1280, 900]]) {
  test(`ångersidan /jamfor/angra/ (${name}): kod från länken, felaktig kod, 404, lyckad och upprepad ånger`, async () => {
    const h = await startHarness();
    const { ctx, page, errors } = await newPage(h, w, hgt);
    const GOOD = "ang_o_" + "a".repeat(32) + "." + "B".repeat(32);
    const UNKNOWN = "ang_o_" + "c".repeat(32) + "." + "B".repeat(32);
    try {
      let calls = 0, okCalls = 0, lastBody = null;
      await page.route("**/compare/withdraw", async (route) => {
        calls++; lastBody = JSON.parse(route.request().postData() || "{}");
        if (lastBody.token === UNKNOWN) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "okänd" }) });
        const dup = okCalls++ > 0;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, duplicate: dup, withdrawal: { requestId: "ang_test1", at: Date.now(), outcome: "manuell_prövning" } }) });
      });
      await page.goto(h.base + "/jamfor/angra/");
      await page.waitForSelector("#tok");
      assert.ok(await noSideScroll(page));
      await page.screenshot({ path: join(EVIDENCE, `jamfor_${name}_7_angra_sida.png`), fullPage: true });
      await page.fill("#tok", "fel");
      await page.click("#go");
      assert.match(await page.textContent("#err"), /ser inte rätt ut/);
      assert.equal(calls, 0, "ogiltigt format skickas aldrig till servern");
      await page.fill("#tok", UNKNOWN);
      await page.click("#go");
      await page.waitForFunction(() => /stämmer inte/.test(document.getElementById("err").textContent));
      // koden i länkens fragment fylls i och tas bort ur adressfältet
      await page.goto("about:blank"); await page.goto(h.base + "/jamfor/angra/#t=" + GOOD);
      await page.waitForSelector("#tok");
      assert.equal(await page.inputValue("#tok"), GOOD);
      assert.ok(!page.url().includes("ang_o_"), "koden ligger inte kvar i adressen");
      await page.click("#go");
      await page.waitForSelector("#done:not(.hidden)");
      assert.match(await page.textContent("#done"), /Din ånger är mottagen/);
      assert.match(await page.textContent("#done"), /ingen bekräftelse på att ångerrätten/);
      assert.equal(lastBody.token, GOOD);
      assert.ok(await noSideScroll(page));
      await page.screenshot({ path: join(EVIDENCE, `jamfor_${name}_8_angra_mottagen.png`), fullPage: true });
      await page.goto("about:blank"); await page.goto(h.base + "/jamfor/angra/#t=" + GOOD);
      await page.click("#go");
      await page.waitForSelector("#done:not(.hidden)");
      assert.match(await page.textContent("#done"), /redan tagit emot/);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); await h.close(); }
  });
}

test("startsidans och jämförsidans sidfot länkar till ångersidan", async () => {
  const h = await startHarness();
  const { ctx, page } = await newPage(h, 390, 844);
  try {
    await page.goto(h.base + "/jamfor/");
    await page.waitForSelector("#s1:not(.hidden)");
    assert.ok(await page.locator('footer a[href="/jamfor/angra/"]').count() >= 1);
  } finally { await ctx.close(); await h.close(); }
});
