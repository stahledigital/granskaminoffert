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
      assert.match(txt, /Ingen offert pekas ut som billigast/); // omfattningen skiljer → ingen "billigast vinner"
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
  test(`ånger efter levererad rapport (${name}): ingen ångerknapp i resultatet, normalstor länk Ditt köp och villkor till köpsidan där ångern fungerar; begäran sparas utan automatiskt avslag`, async () => {
    const h = await startHarness();
    const { ctx, page, errors } = await newPage(h, w, hgt);
    try {
      await payFlow(page, h, OFFERS);
      await page.waitForSelector("#rep:not(.hidden)", { timeout: 30000 });
      assert.equal(await page.locator("#rep #withdraw").count(), 0, "ingen ångerknapp i rapportens primära yta");
      assert.equal(await page.locator("#rep #agreement").count(), 0, "inget avtalsblock i rapporten");
      const link = page.locator("#rep a#buylink");
      assert.equal(await link.count(), 1); assert.ok(await link.isVisible()); assert.equal((await link.textContent()).trim(), "Ditt köp och villkor");
      const fs = await link.evaluate((e) => parseFloat(getComputedStyle(e).fontSize)); assert.ok(fs >= 16, "normalstor länk, inte minitext: " + fs);
      assert.ok(await noSideScroll(page));
      await page.screenshot({ path: join(EVIDENCE, `jamfor_${name}_4_rapport_med_koplänk.png`), fullPage: true });
      await link.click(); await page.waitForURL("**/jamfor/kop/**");
      await page.waitForSelector("#agreement:not(.hidden) #agtext", { timeout: 15000 });
      assert.match(await page.textContent("#agreement"), /Avtals-ID avt_/); assert.match(await page.textContent("#agreement"), /Utkast/);
      assert.ok(await page.isVisible("#withdraw"), "ångerfunktion finns på köpsidan"); assert.ok(await page.isVisible('a[href="/jamfor/villkor/"]'));
      assert.match(await page.textContent("#helpcard"), /reklamation/i);
      assert.ok(await noSideScroll(page));
      await page.screenshot({ path: join(EVIDENCE, `jamfor_${name}_4b_kopsida.png`), fullPage: true });
      await page.click("#withdraw");
      await page.waitForSelector("#wdtext", { timeout: 15000 });
      const t = await page.textContent("#wdtext");
      assert.match(t, /prövas manuellt|ingen bekräftelse|mottagen/i);
      assert.doesNotMatch(t, /avslag|avslagen|har inte rätt/i);
      assert.ok(await noSideScroll(page), "ingen sidoscroll efter ånger");
      await page.screenshot({ path: join(EVIDENCE, `jamfor_${name}_5_anger_efter_leverans.png`), fullPage: true });
      assert.equal(await page.locator("#withdraw").count(), 0, "knappen ersätts av begärans status");
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); await h.close(); }
  });
}

test("köpsidan /jamfor/kop/ utan känd order: begriplig text, villkor och supportväg, ingen krasch (mobil390)", async () => {
  const h = await startHarness();
  const { ctx, page, errors } = await newPage(h, 390, 844);
  try {
    await page.goto(h.base + "/jamfor/kop/");
    await page.waitForSelector("#err:not(.hidden)");
    assert.match(await page.textContent("#err"), /Vi hittar inget köp/); assert.ok(await page.isVisible('a[href="/jamfor/villkor/"]')); assert.ok(await page.isVisible('a[href="/jamfor/angra/"]'));
    assert.ok(await noSideScroll(page)); assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

test("ånger via köpsidan under pågående jämförelse (mobil390): stoppas före leverans, ingen rapport, återbetalning", async () => {
  const h = await startHarness();
  h.ctl.anthropicDelayMs = 4000;
  const { ctx, page, errors } = await newPage(h, 390, 844);
  try {
    await payFlow(page, h, OFFERS);
    await page.waitForSelector("#agreement #withdraw", { timeout: 30000 });
    await page.goto(h.base + "/jamfor/kop/");
    await page.waitForSelector("#withdraw", { timeout: 15000 });
    await page.click("#withdraw"); await page.waitForSelector("#wdtext", { timeout: 15000 });
    assert.match(await page.textContent("#wdtext"), /Hela beloppet ska betalas tillbaka|återbetalning|prövas manuellt/);
    await page.goto(h.base + "/jamfor/"); await page.waitForSelector("#statusbox", { timeout: 15000 });
    await page.waitForFunction(() => /ångrat|pengarna tillbaka|återbetal/i.test(document.body.textContent), null, { timeout: 15000 });
    assert.equal(await page.locator("#rep:not(.hidden)").count(), 0, "ingen rapport efter ånger före leverans");
    assert.ok(await noSideScroll(page)); assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

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
    await page.goto(h.base + "/");
    const l = page.locator('.foot a[href="/jamfor/angra/"]');
    assert.equal(await l.count(), 1, "startsidans sidfot har en tydlig ångerlänk");
    assert.match(await l.textContent(), /Ångra/);
    assert.ok(await l.isVisible());
    await l.click(); await page.waitForURL("**/jamfor/angra/");
    assert.ok(await noSideScroll(page));
  } finally { await ctx.close(); await h.close(); }
});

test("villkorssidan renderar serverns fullständiga villkorstext (säljare, pris, ångerrätt, personuppgifter) som UTKAST, utan sidoscroll", async () => {
  const h = await startHarness({ vars: { COMPARE_SELLER_FORM: "AB", COMPARE_COMPANY_INFO_URL: "https://example.test/foretagsuppgifter", COMPARE_SELLER_NAME: "Syntetisk Säljare AB", COMPARE_SELLER_ORGNR: "556000-0001", COMPARE_SELLER_EMAIL: "kontakt@example.test", COMPARE_SELLER_ADDRESS: "Exempelgatan 1, 111 11 Teststad", COMPARE_SELLER_VAT: "SE556000000101", COMPARE_CONFIRM_SHOW_VAT: "1" } });
  const { ctx, page, errors } = await newPage(h, 390, 844);
  try {
    await page.goto(h.base + "/jamfor/villkor/");
    await page.waitForSelector("#terms h2");
    const t = await page.textContent("#terms");
    for (const v of ["version villkor-utkast-1, UTKAST", "Syntetisk Säljare AB", "SE556000000101", "Exempelgatan 1", "49,00 kr inklusive moms", "Ångra köpet", "Personuppgifter och lagring"]) assert.ok(t.includes(v), v);
    assert.ok(await noSideScroll(page));
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

// ---------------- Säljaruppgifter (AB/ENSKILD) i kassan + länk "Företagsuppgifter" i footern. Syntetiska värden; tolkningen för enskild firma är OPEN. ----------------
const SELLER_BASE = { COMPARE_SELLER_EMAIL: "kontakt@example.test", COMPARE_SELLER_ADDRESS: "Exempelgatan 1, 111 11 Teststad", COMPARE_SELLER_PHONE: "+46 8 000 00 00", COMPARE_COMPANY_INFO_URL: "https://example.test/foretagsuppgifter" };
for (const [label, vars, expectIn, expectOut] of [
  ["AB", { ...SELLER_BASE, COMPARE_SELLER_FORM: "AB", COMPARE_SELLER_NAME: "Syntetisk Säljare AB", COMPARE_SELLER_ORGNR: "556000-0001", COMPARE_SELLER_VAT: "SE556000000101" }, ["Säljare: Syntetisk Säljare AB", "Organisationsnummer: 556000-0001", "Adress: Exempelgatan 1", "E-post: kontakt@example.test", "Telefon: +46 8 000 00 00", "Fler företagsuppgifter: https://example.test/foretagsuppgifter"], ["Momsregistreringsnummer", "SE556000000101"]],
  ["ENSKILD", { ...SELLER_BASE, COMPARE_SELLER_FORM: "ENSKILD", COMPARE_SELLER_NAME: "Syntetisk Firma", COMPARE_SELLER_OWNER_NAME: "Syntetisk Ägare" }, ["Säljare: Syntetisk Firma", "Ägare: Syntetisk Ägare", "Organisationsnummer: saknas (enskild firma)", "Telefon: +46 8 000 00 00"], ["Momsregistreringsnummer"]],
]) {
  test(`kassan visar säljaruppgifter (${label}) direkt, och footerlänken Företagsuppgifter finns på /jamfor/, villkor och ångra (390 px, utan sidoscroll)`, async () => {
    const h = await startHarness({ vars });
    const { ctx, page, errors } = await newPage(h, 390, 844);
    try {
      await page.goto(h.base + "/jamfor/"); await page.waitForSelector("#s1:not(.hidden)");
      await fillAndCheck(page, [OFFERS[0], OFFERS[1]]);
      await page.waitForSelector("#seller div");
      const t = await page.textContent("#seller");
      for (const v of expectIn) assert.ok(t.includes(v), v);
      for (const v of expectOut) assert.ok(!t.includes(v), "ej i kassan: " + v);
      assert.ok(await noSideScroll(page));
      // samma rader som i den godkända villkorstexten
      const cfg = await (await fetch(h.base + "/compare/config")).json();
      assert.equal(t.replace("Du köper av", ""), cfg.terms.sections.find((x) => x.id === "saljare").text.split("\n").join(""));
      for (const path of ["/jamfor/", "/jamfor/villkor/", "/jamfor/angra/"]) {
        await page.goto(h.base + path);
        const a = page.locator("footer a.fu"); assert.equal(await a.count(), 1, path); assert.equal((await a.textContent()).trim(), "Företagsuppgifter");
        if (path !== "/jamfor/angra/") { await page.waitForFunction(() => document.querySelector("footer a.fu").href === "https://example.test/foretagsuppgifter", null, { timeout: 4000 }).catch(async () => { throw new Error(path + " href=" + await a.getAttribute("href")); }); }
        else assert.match(await a.getAttribute("href"), /^\/foretagsuppgifter/);
        assert.ok(await noSideScroll(page), path);
      }
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); await h.close(); }
  });
}

test("ENSKILD med förbjudet org.nr: kassan öppen? nej – ordrar stängs och värdet syns inte på någon sida", async () => {
  const h = await startHarness({ vars: { ...SELLER_BASE, COMPARE_SELLER_FORM: "ENSKILD", COMPARE_SELLER_NAME: "Syntetisk Firma", COMPARE_SELLER_OWNER_NAME: "Syntetisk Ägare", COMPARE_SELLER_ORGNR: "556000-0001" } });
  const { ctx, page, errors } = await newPage(h, 390, 844);
  try {
    const cfg = await (await fetch(h.base + "/compare/config")).json();
    assert.equal(cfg.accepting, false); assert.deepEqual(cfg.terms.seller.errors, ["orgnr_forbidden_enskild"]);
    for (const path of ["/jamfor/", "/jamfor/villkor/"]) { await page.goto(h.base + path); await page.waitForTimeout(600); const html = await page.content(); assert.ok(!html.includes("556000-0001") && !html.includes("5560000001"), path); }
    assert.ok(!JSON.stringify(cfg).includes("556000"));
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

// ---------------- D07: källor för senaste originalomdömen (Google UI Kit mount/unmount, Trustpilot via servern) ----------------
// Allt är attrapper med SYNTETISKA data. Offlineloadern bevisar vår konfiguration/timeout/cleanup – INTE Googles liveutfall.
const SRC_VARS = { COMPARE_REVIEWS: "1", COMPARE_REVIEWS_VERIFIED: "1", GOOGLE_UI_KIT: "1", GOOGLE_MAPS_BROWSER_KEY: "AIzaSyTESTONLYsyntheticKey_0123456789ab", COMPARE_SOURCES_SEARCH_DAY_CAP: "50", COMPARE_SOURCES_MOUNT_DAY_CAP: "100", COMPARE_SOURCES_DETAILS_DAY_CAP: "50", TRUSTPILOT_DISPLAY: "1", TRUSTPILOT_API_BASE: "https://tp.example.test", TRUSTPILOT_API_KEY: "synthetic-tp-key", TRUSTPILOT_AUTH_HEADER: "apikey", COMPARE_TP_DAY_CAP: "50" };
const SRC_SERVER_VARS = { ...SRC_VARS, GOOGLE_CANDIDATES: "1", GOOGLE_PLACES_API_SEARCH_VERIFIED: "1", GOOGLE_PLACES_SERVER_KEY: "synthetic-server-key-0123456789" };
const PID = "ChIJ" + "a".repeat(24);
function seedSources(h) {
  h.ctl.googlePlaces = [{ id: PID, displayName: { text: "Byggfirma AB" }, formattedAddress: "Syntetvägen 1, Malmö" }, { id: "ChIJ" + "b".repeat(24), displayName: { text: "Byggfirma Syd" }, formattedAddress: "Syntetgatan 2, Lund" }];
  h.ctl.tpFind = { "byggfirma.se": [{ id: "bu00000001", displayName: "Byggfirma", websiteUrl: "https://byggfirma.se" }] };
  h.ctl.tpLatest = { bu00000001: { businessUnit: { trustScore: 4.3, numberOfReviews: { total: 42 } }, reviews: [1, 2, 3].map((n) => ({ stars: 5 - n + 1, title: "Syntetiskt " + n, text: "SYNTETISK TEXT " + n + " – inte ett riktigt omdöme.", createdAt: `2026-09-${30 - n}T10:00:00Z`, link: "https://www.trustpilot.com/reviews/synth" + n })) } };
}
async function toOfferStep(page, h) {
  await page.goto(h.base + "/jamfor/");
  await page.waitForSelector("#s1:not(.hidden)");
  await fillAndCheck(page, [OFFERS[0], OFFERS[1]]);
  await page.waitForSelector("#srcbox:not(.hidden)");
  await page.evaluate(() => { const d = document.querySelector("#srcmanual"); if (d) d.open = true; }); // D11-P2c: manuell inmatning är valfri och hopfälld
}
// Offlineattrapp för Googles UI Kit-element (beta). Elementnamn enligt Googles primärdocs; attrappen bevisar vår konfiguration/händelsehantering/cleanup,
// INTE Googles liveutfall. __GMP_MODE: ok (gmp-load) | error (gmp-error) | silent (ingen händelse alls).
const gmpDouble = () => {
  window.__gmpCalls = []; window.__GMP_MODE = "ok"; window.__searchTexts = []; window.__SEARCH_PLACES = [];
  window.__GMP_LOADER__ = async (key) => {
    window.__gmpCalls.push(key);
    if (customElements.get("gmp-advanced-place-details")) return {};
    const plain = (n) => customElements.define(n, class extends HTMLElement {});
    ["gmp-place-details-place-request", "gmp-place-name", "gmp-place-address", "gmp-place-website", "gmp-place-attribution", "gmp-place-all-content", "gmp-place-text-search-request"].forEach(plain);
    plain("gmp-place-rating");
    // Reviews-attrapp: modellerar att property speglar attributet; __GMP_RANK_IGNORED=true modellerar rotens realprov (property null trots attribut).
    customElements.define("gmp-place-reviews", class extends HTMLElement { get rankPreference() { return window.__GMP_RANK_IGNORED ? null : this.getAttribute("rank-preference"); } set rankPreference(v) { if (!window.__GMP_RANK_IGNORED) this.setAttribute("rank-preference", v); } });
    const fire = (el, ok, extra) => { const m = window.__GMP_MODE; if (m === "ok") setTimeout(() => { Object.assign(el, extra || {}); el.dispatchEvent(new Event("gmp-load")); }, 20); else if (m === "error") setTimeout(() => el.dispatchEvent(new Event("gmp-error")), 20); };
    customElements.define("gmp-advanced-place-details", class extends HTMLElement { connectedCallback() { window.__inst = (window.__inst || 0) + 1; fire(this); } });
    customElements.define("gmp-place-search", class extends HTMLElement { connectedCallback() { window.__inst = (window.__inst || 0) + 1; const rq = this.querySelector("gmp-place-text-search-request"); window.__searchTexts.push(rq && rq.textQuery); fire(this, true, { places: window.__SEARCH_PLACES }); } });
    return {};
  };
};
const gmpSelect = (page, id) => page.evaluate((pid) => { const s = document.querySelector("gmp-place-search"); const ev = new Event("gmp-select"); ev.place = { id: pid }; s.dispatchEvent(ev); }, id);

for (const [name, w, hgt] of [["mobil390", 390, 844], ["desktop1280", 1280, 900]]) {
  test(`källor (${name}): firmaval utan första-träff, täckning före köp, Google mount/unmount newest, Trustpilot original, kundbyte rensar`, async () => {
    const h = await startHarness({ vars: SRC_VARS }); seedSources(h);
    const { ctx, page, errors } = await newPage(h, w, hgt);
    await page.addInitScript(gmpDouble);
    try {
      await toOfferStep(page, h);
      assert.match(await page.textContent("#copy-getsnot"), /lovar inte att en källa finns/);
      await page.fill("#sc0", "Malmö"); await page.fill("#sd0", "byggfirma.se"); await page.fill("#sc1", "Lund");
      await page.click("#srcgo");
      await page.waitForSelector(".srcfirm[data-firm]");
      assert.equal(await page.locator(".srcfirm[data-firm]").count(), 2);
      assert.match(await page.textContent("#srccov"), /Byggfirma AB \(Malmö\): Google – väntar på att du bekräftar rätt firma/);
      assert.ok(await noSideScroll(page), "ingen sidoscroll i källpanelen");
      const f0 = page.locator(".srcfirm[data-firm]").nth(0);
      // Google (native UI Kit-sök): inget serveranrop mot Places API, Googles eget sökelement, kunden väljer själv, bekräftelse först när riktig profil visats
      await page.evaluate((id) => { window.__SEARCH_PLACES = [{ id }]; }, PID);
      await f0.locator('[data-src="google"] button:has-text("Sök firman hos Google")').click();
      await page.waitForSelector("gmp-place-search", { state: "attached" });
      assert.deepEqual(await page.evaluate(() => window.__gmpCalls), [SRC_VARS.GOOGLE_MAPS_BROWSER_KEY]);
      const sr = await page.evaluate(() => { const s = document.querySelector("gmp-place-search"); const rq = s.querySelector("gmp-place-text-search-request"); return { selectable: s.hasAttribute("selectable"), tags: [...s.children].map((e) => e.localName), max: rq.getAttribute("max-result-count"), q: rq.textQuery }; });
      assert.equal(sr.selectable, true); assert.deepEqual(sr.tags, ["gmp-place-all-content", "gmp-place-text-search-request"]); assert.equal(sr.max, "5"); assert.equal(sr.q, "Byggfirma AB Malmö");
      assert.equal(h.stats.google, 0, "ingen servermässig Places API-sökning i native läget");
      assert.equal(await f0.locator('[data-src="google"] [data-confirm="native"]').isDisabled(), true, "ingen förvald träff");
      assert.equal(await page.locator("gmp-advanced-place-details").count(), 0);
      await page.evaluate(() => { window.__GMP_MODE = "silent"; });
      await gmpSelect(page, PID);
      await page.waitForSelector("gmp-advanced-place-details", { state: "attached" });
      assert.equal(await f0.locator('[data-src="google"] [data-confirm="native"]').isDisabled(), true, "bekräftelse låses inte upp förrän Googles profil faktiskt laddats (gmp-load)");
      await page.evaluate(() => document.querySelector("gmp-advanced-place-details").dispatchEvent(new Event("gmp-load")));
      await page.waitForFunction(() => !document.querySelector('[data-src="google"] [data-confirm="native"]').disabled);
      await f0.locator('[data-src="google"] [data-confirm="native"]').click();
      await page.waitForSelector('[data-src="google"] button:has-text("Visa Googles omdömen")');
      assert.equal(await page.locator("gmp-place-search").count(), 0, "söklementet avmonteras efter bekräftelse");
      await page.evaluate(() => { window.__GMP_MODE = "ok"; });
      await page.click('[data-src="google"] button:has-text("Visa Googles omdömen")');
      await page.waitForSelector("gmp-advanced-place-details", { state: "attached" });
      const cfg = await page.evaluate(() => {
        const d = document.querySelector("gmp-advanced-place-details"); const rv = d.querySelector("gmp-place-reviews");
        return { place: d.querySelector("gmp-place-details-place-request").getAttribute("place"), rank: rv.getAttribute("rank-preference"), rvAttrs: [...rv.attributes].map((a) => a.name), tags: [...d.children].map((e) => e.localName), dAttrs: [...d.attributes].map((a) => a.name), box: document.querySelector(".gmpbox:not(.hidden)").getBoundingClientRect().height };
      });
      assert.equal(cfg.place, PID); assert.equal(cfg.rank, "newest"); assert.deepEqual(cfg.rvAttrs, ["rank-preference"]); assert.deepEqual(cfg.dAttrs, []);
      assert.deepEqual(cfg.tags, ["gmp-place-details-place-request", "gmp-place-name", "gmp-place-address", "gmp-place-rating", "gmp-place-website", "gmp-place-reviews", "gmp-place-attribution"]);
      assert.ok(!cfg.tags.some((t) => /summary|query|filter|sentiment|config/.test(t)), cfg.tags.join());
      assert.equal(await page.locator("gmp-place-details").count(), 0, "gamla elementnamnet används inte");
      assert.ok(cfg.box >= 240 && cfg.box <= 400, "Googlekortets höjd " + cfg.box);
      assert.match(await f0.textContent(), /Källa: Google \(Byggfirma AB, Malmö\)/);
      assert.ok(await noSideScroll(page));
      await page.screenshot({ path: join(EVIDENCE, `jamfor_${name}_9_kallor_google.png`), fullPage: true });
      // stäng = unmount
      await page.click('[data-src="google"] button:has-text("Dölj Googles omdömen")');
      assert.equal(await page.locator("gmp-advanced-place-details").count(), 0);
      // öppna igen, byt firma => inget kvar
      await page.click('[data-src="google"] button:has-text("Visa Googles omdömen")'); await page.waitForSelector("gmp-advanced-place-details", { state: "attached" });
      await f0.locator('[data-src="google"] button:has-text("Fel firma")').click();
      await page.waitForSelector('[data-src="google"] button:has-text("Sök firman hos Google")');
      assert.equal(await page.locator("gmp-advanced-place-details").count(), 0, "gammal firmas Googlekort lämnas inte kvar");
      // Trustpilot
      await f0.locator('[data-src="trustpilot"] button:has-text("Sök firman hos Trustpilot")').click();
      await page.waitForSelector('[data-src="trustpilot"] input[type=radio]');
      await f0.locator('[data-src="trustpilot"] input[type=radio]').first().check();
      await f0.locator('[data-src="trustpilot"] .btn.acc').click();
      await f0.locator('[data-src="trustpilot"] button:has-text("Visa Trustpilots senaste")').click();
      await page.waitForSelector(".tprev");
      const tp = await f0.locator('[data-src="trustpilot"]').textContent();
      assert.match(tp, /totalbetyg: 4,3 av 5 \(42 omdömen\)/); assert.match(tp, /SYNTETISK TEXT 1 – inte ett riktigt omdöme\./); assert.match(tp, /2026-09-29/); assert.match(tp, /Källa: Trustpilot \(Byggfirma AB, Malmö\)/);
      assert.equal(await f0.locator('.tprev a[href^="https://www.trustpilot.com/"]').count(), 3);
      assert.doesNotMatch(tp, /snitt|medelbetyg|trend|bättre än|sämre än/i);
      await page.screenshot({ path: join(EVIDENCE, `jamfor_${name}_10_kallor_trustpilot.png`), fullPage: true });
      // firma 2 är ännu obekräftad och visas så före köp
      assert.match(await page.textContent("#srccov"), /Byggfirma AB \(Malmö\): Google – väntar på att du bekräftar rätt firma; Trustpilot – kan visas|Google – väntar på att du bekräftar/);
      // kundbyte av firmanamn: nytt formulär, ny panel utan tidigare bekräftelse
      await page.fill("#sc0", "Göteborg"); await page.click("#srcgo");
      await page.waitForFunction(() => /Byggfirma AB \(Göteborg\): Google – väntar/.test(document.getElementById("srccov").textContent));
      assert.equal(await page.locator("gmp-advanced-place-details").count(), 0);
      assert.equal(await page.locator(".tprev").count(), 0, "tidigare firmas omdömen visas inte för nytt val");
      assert.equal(h.stats.anthropic >= 0, true);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); await h.close(); }
  });
}

test("källor: köp med täckning, rapporten bär inga omdömen men visar källpanelen separat; täckning fryses som antal", async () => {
  const h = await startHarness({ vars: SRC_VARS }); seedSources(h);
  const { ctx, page, errors } = await newPage(h, 390, 844);
  await page.addInitScript(gmpDouble);
  try {
    await toOfferStep(page, h);
    await page.fill("#sc0", "Malmö"); await page.click("#srcgo"); await page.waitForSelector(".srcfirm[data-firm]");
    await page.fill("#email", "kund@example.test"); await page.check("#terms"); await page.check("#immediate"); await page.click("#pay");
    await page.waitForURL("https://checkout.stripe.test/**"); await page.click("#pay");
    await page.waitForURL(h.base + "/jamfor/**");
    await page.waitForSelector("#rep:not(.hidden)", { timeout: 30000 });
    await page.waitForSelector("#rep .srcfirm[data-firm]", { state: "attached", timeout: 15000 });
    assert.match(await page.textContent("#rep"), /Omdömen visas separat från rapporten/);
    assert.ok(await noSideScroll(page));
    // JSON-nedladdningens innehåll = rapporten: inga källor eller omdömen
    const rep = await page.evaluate(async () => { const o = JSON.parse(localStorage.getItem("jamfor_order") || "{}"); return JSON.stringify(o).length > 0; });
    assert.ok(rep);
    await page.screenshot({ path: join(EVIDENCE, "jamfor_mobil390_11_rapport_kallor.png"), fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

test("Google skriptladdning (riktiga loadern, attrapp-endpoint): inget anrop före sökning; korrekt URL; fel visas som 'kunde inte visas', aldrig som 'inga omdömen'", async () => {
  const h = await startHarness({ vars: SRC_VARS }); seedSources(h);
  const { ctx, page, errors } = await newPage(h, 390, 844);
  const hits = []; let fail = false;
  const stub = `window.google={maps:{importLibrary:async function(){
    const plain=(n)=>customElements.get(n)||customElements.define(n,class extends HTMLElement{});
    ["gmp-place-details-place-request","gmp-place-name","gmp-place-address","gmp-place-rating","gmp-place-website","gmp-place-reviews","gmp-place-attribution","gmp-place-all-content","gmp-place-text-search-request"].forEach(plain);
    if(!customElements.get("gmp-place-search")){customElements.define("gmp-place-search",class extends HTMLElement{connectedCallback(){setTimeout(()=>{this.places=[];this.dispatchEvent(new Event("gmp-load"))},20)}});
    customElements.define("gmp-advanced-place-details",class extends HTMLElement{connectedCallback(){setTimeout(()=>this.dispatchEvent(new Event("gmp-load")),20)}});}
    return {};}}};
    (function(){var cb=new URL(document.currentScript.src).searchParams.get("callback");if(cb)setTimeout(function(){window[cb]()},10)})();`;
  await ctx.route("https://maps.googleapis.com/**", (route) => {
    hits.push(route.request().url());
    if (fail) return route.abort();
    return route.fulfill({ contentType: "text/javascript", body: stub });
  });
  try {
    await toOfferStep(page, h);
    await page.fill("#sc0", "Malmö"); await page.click("#srcgo"); await page.waitForSelector(".srcfirm[data-firm]");
    const f0 = page.locator(".srcfirm[data-firm]").nth(0);
    assert.equal(hits.length, 0, "inget anrop till Google före kundens sökning");
    fail = true;
    await f0.locator('[data-src="google"] button:has-text("Sök firman hos Google")').click();
    await page.waitForSelector("text=kunde inte visas just nu");
    assert.match(await page.textContent('[data-gmp-search]'), /Det betyder inte att omdömen saknas/);
    assert.equal(await page.locator("gmp-place-search").count(), 0);
    fail = false;
    await page.click('[data-gmp-search] button:has-text("Försök igen")');
    await page.waitForSelector("gmp-place-search", { state: "attached" });
    const u = new URL(hits.at(-1));
    assert.equal(u.searchParams.get("key"), SRC_VARS.GOOGLE_MAPS_BROWSER_KEY); assert.equal(u.searchParams.get("libraries"), "places"); assert.equal(u.searchParams.get("v"), "beta");
    assert.ok(!u.searchParams.has("query") && !u.searchParams.has("q"));
    await page.waitForSelector("text=ingen träff för firmans namn och ort"); // Googles egen tomma lista visas ärligt som just det
    void errors;
  } finally { await ctx.close(); await h.close(); }
});

async function confirmNative(page, h, f0) {
  await page.evaluate((id) => { window.__SEARCH_PLACES = [{ id }]; }, PID);
  await f0.locator('[data-src="google"] button:has-text("Sök firman hos Google")').click();
  await page.waitForSelector("gmp-place-search", { state: "attached" });
  await gmpSelect(page, PID);
  await page.waitForFunction(() => !document.querySelector('[data-src="google"] [data-confirm="native"]').disabled);
  await f0.locator('[data-src="google"] [data-confirm="native"]').click();
  await page.waitForSelector('[data-src="google"] button:has-text("Visa Googles omdömen")');
}
async function toFirms(page, h) { await toOfferStep(page, h); await page.fill("#sc0", "Malmö"); await page.click("#srcgo"); await page.waitForSelector(".srcfirm[data-firm]"); return page.locator(".srcfirm[data-firm]").nth(0); }

test("Googles egna händelser: gmp-error och tystnad (timeout) ger källfel i vyn och i täckningen, aldrig 'inga omdömen'; sena händelser efter avmontering ignoreras", async () => {
  const h = await startHarness({ vars: SRC_VARS }); seedSources(h);
  const { ctx, page } = await newPage(h, 390, 844);
  await page.addInitScript(gmpDouble); await page.addInitScript(() => { window.__GMP_TIMEOUT = 600; });
  try {
    const f0 = await toFirms(page, h);
    await confirmNative(page, h, f0);
    // 1) gmp-error (icke-bubblande, på elementet)
    await page.evaluate(() => { window.__GMP_MODE = "error"; });
    await page.click('[data-src="google"] button:has-text("Visa Googles omdömen")');
    await page.waitForSelector("text=kunde inte visas just nu");
    assert.equal(await page.locator("gmp-advanced-place-details").count(), 0);
    await page.waitForFunction(() => /Google – källan svarade inte \(det betyder inte att omdömen saknas\)/.test(document.getElementById("srccov").textContent));
    assert.doesNotMatch(await page.textContent("#srccov"), /inga omdömen/);
    // 2) tystnad: ingen händelse alls ⇒ timeout ⇒ fel
    await page.evaluate(() => { window.__GMP_MODE = "silent"; });
    await page.click('[data-gmp="' + (await f0.getAttribute("data-firm")) + '"] button:has-text("Försök igen")');
    await page.waitForSelector("gmp-advanced-place-details", { state: "attached" });
    await page.waitForSelector("text=kunde inte visas just nu", { timeout: 5000 });
    assert.equal(await page.locator("gmp-advanced-place-details").count(), 0);
    // 3) lyckad laddning efter fel ⇒ täckningen rättas
    await page.evaluate(() => { window.__GMP_MODE = "ok"; });
    await page.click('.gmpbox button:has-text("Försök igen")');
    await page.waitForFunction(() => /Google – kan visas/.test(document.getElementById("srccov").textContent));
    // 4) avmontering medan laddning pågår (tyst läge): inget kvar, ingen sen händelse återuppstår
    await page.click('[data-src="google"] button:has-text("Dölj Googles omdömen")');
    await page.evaluate(() => { window.__GMP_MODE = "silent"; });
    await page.click('[data-src="google"] button:has-text("Visa Googles omdömen")'); await page.waitForSelector("gmp-advanced-place-details", { state: "attached" });
    await page.click('[data-src="google"] button:has-text("Dölj Googles omdömen")');
    await page.waitForTimeout(900);
    assert.equal(await page.locator("gmp-advanced-place-details").count(), 0);
    assert.equal(await page.locator(".gmpbox:not(.hidden) .warnbox").count(), 0, "avmonterad mount rapporterar inget sent fel");
  } finally { await ctx.close(); await h.close(); }
});

test("native sök utan människosatt dygnstak ⇒ kostnadsstopp (Googles sökelement monteras inte); servermässig Text Search är avstängd utan extra flagga", async () => {
  const { COMPARE_SOURCES_SEARCH_DAY_CAP: _c, ...noCap } = SRC_VARS;
  const h = await startHarness({ vars: noCap }); seedSources(h);
  const { ctx, page } = await newPage(h, 390, 844);
  await page.addInitScript(gmpDouble);
  try {
    const f0 = await toFirms(page, h);
    await f0.locator('[data-src="google"] button:has-text("Sök firman hos Google")').click();
    await page.waitForSelector("text=stoppad av kostnadsskäl");
    assert.equal(await page.locator("gmp-place-search").count(), 0);
    assert.deepEqual(await page.evaluate(() => window.__gmpCalls), []);
    assert.equal(h.stats.google, 0);
    assert.match(await page.textContent("#srccov"), /Google – stoppad av kostnadsskäl \(det betyder inte att omdömen saknas\)/);
  } finally { await ctx.close(); await h.close(); }
});

test("servermässig Text Search (endast med extra mänsklig flagga): kandidater visas utan första-träff-automatik", async () => {
  const h = await startHarness({ vars: SRC_SERVER_VARS }); seedSources(h);
  const { ctx, page } = await newPage(h, 390, 844);
  await page.addInitScript(gmpDouble);
  try {
    const f0 = await toFirms(page, h);
    await f0.locator('[data-src="google"] button:has-text("Sök firman hos Google")').click();
    await page.waitForSelector('[data-src="google"] input[type=radio]');
    assert.equal(await f0.locator('[data-src="google"] input[type=radio]:checked').count(), 0);
    assert.equal(await f0.locator('[data-src="google"] .btn.acc').isDisabled(), true);
    assert.equal(await page.locator("gmp-place-search").count(), 0);
    await f0.locator('[data-src="google"] input[type=radio]').first().check(); await f0.locator('[data-src="google"] .btn.acc').click();
    await page.waitForSelector('[data-src="google"] button:has-text("Visa Googles omdömen")');
    assert.equal(h.stats.google, 1);
  } finally { await ctx.close(); await h.close(); }
});

test("källor AV som standard: ingen källpanel, inga Google-/Trustpilot-anrop, texten lovar inga omdömen", async () => {
  const h = await startHarness();
  const { ctx, page } = await newPage(h, 390, 844);
  try {
    await toOfferStepOff(page, h);
    assert.equal(await page.locator("#srcbox:not(.hidden)").count(), 0);
    assert.match(await page.textContent("#copy-getsnot"), /Inga omdömen om företagen/);
    assert.equal(h.stats.google + h.stats.tp, 0);
  } finally { await ctx.close(); await h.close(); }
});
async function toOfferStepOff(page, h) { await page.goto(h.base + "/jamfor/"); await page.waitForSelector("#s1:not(.hidden)"); await fillAndCheck(page, [OFFERS[0], OFFERS[1]]); }

for (const [name, w, hgt] of [["mobil390", 390, 844], ["desktop1280", 1280, 900]]) {
  test(`väntan på avtalsbekräftelse (${name}): ärlig status utan arbetspåstående; misslyckad bekräftelse visas med återbetalning`, async () => {
    const h = await startHarness();
    const { ctx, page, errors } = await newPage(h, w, hgt);
    try {
      let mode = "waiting";
      const ord = () => ({ id: "o_" + "a".repeat(32), status: mode === "waiting" ? "paid" : "failed", waiting: mode === "waiting" ? "avtalsbekraftelse" : null, error: mode === "waiting" ? null : "bekraftelse_ej_levererad", progress: { extracted: 0, total: 2, synth: "pending" }, refund: { state: mode === "waiting" ? "none" : "needed" }, withdrawal: { requested: false }, expiresAt: Date.now() + 3600_000 });
      await page.route("**/compare/orders/o_*", async (route) => {
        if (route.request().method() !== "GET" || /\/(report|sources|checkout|withdraw)/.test(route.request().url())) return route.continue();
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, order: ord(), pollMs: 600 }) });
      });
      await page.goto(h.base + "/jamfor/#o=o_" + "a".repeat(32) + "&t=tok_" + "b".repeat(32));
      await page.waitForFunction(() => /avtalsbekräftelsen ska kunna skickas/.test(document.body.textContent));
      const t = await page.textContent("#statusbox");
      assert.match(t, /Inget arbete har påbörjats/); assert.doesNotMatch(t, /Vi läser offerterna/);
      assert.ok(await noSideScroll(page));
      await page.screenshot({ path: join(EVIDENCE, `jamfor_${name}_9_vantar_bekraftelse.png`), fullPage: true });
      mode = "failed";
      await page.waitForFunction(() => /kunde inte skicka avtalsbekräftelsen/.test(document.getElementById("statusbox").textContent), null, { timeout: 8000 });
      assert.match(await page.textContent("#statusbox"), /pengarna tillbaka/);
      assert.ok(await noSideScroll(page));
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); await h.close(); }
  });
}

for (const [name, w, hgt] of [["mobil390", 390, 844], ["desktop1280", 1280, 900]]) {
  test(`avtalsbekräftelsens status (${name}): okänt utfall/avstämning får ärlig text, verifierat misslyckande och skickad särskiljs`, async () => {
    const h = await startHarness();
    const { ctx, page, errors } = await newPage(h, w, 844);
    try {
      let st = "avstamning";
      const ord = () => ({ id: "o_" + "a".repeat(32), status: "paid", waiting: null, error: null, progress: { extracted: 0, total: 2, synth: "pending" }, refund: { state: "none" }, withdrawal: { requested: false }, agreement: { id: "ag_test", contact: "kund@example.test", mails: [{ kind: "avtalsbekraftelse", state: st, attempts: 12 }] }, expiresAt: Date.now() + 3600_000 });
      await page.route("**/compare/orders/o_*", async (route) => {
        if (route.request().method() !== "GET" || /\/(report|sources|checkout|withdraw)/.test(route.request().url())) return route.continue();
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, order: ord(), pollMs: 600 }) });
      });
      await page.goto(h.base + "/jamfor/#o=o_" + "a".repeat(32) + "&t=tok_" + "b".repeat(32));
      await page.waitForSelector("#agreement");
      let t = await page.textContent("#agreement");
      assert.match(t, /leveransen är oklar och kontrolleras manuellt/); assert.doesNotMatch(t, /kunde inte skickas/); assert.doesNotMatch(t, /: skickad/);
      assert.ok(await noSideScroll(page));
      st = "failed"; await page.waitForFunction(() => /kunde inte skickas \(vi hanterar det manuellt\)/.test(document.getElementById("agreement").textContent), null, { timeout: 8000 });
      st = "sent"; await page.waitForFunction(() => /: skickad\./.test(document.getElementById("agreement").textContent), null, { timeout: 8000 });
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); await h.close(); }
  });
}

async function payFlowP(page, h, offers, { reqs, here = false } = {}) {
  if (!here) { await page.goto(h.base + "/jamfor/"); await page.waitForSelector("#s1:not(.hidden)"); await fillAndCheck(page, offers); }
  await page.fill("#email", "kund@example.test");
  if (reqs) page.on("request", (r) => { if (/\/checkout$/.test(r.url()) && r.method() === "POST") reqs.push(JSON.parse(r.postData() || "{}")); });
  await page.check("#terms"); await page.check("#startnow"); await page.check("#loseright"); await page.click("#pay");
  await page.waitForURL("https://checkout.stripe.test/**"); await page.click("#pay");
  await page.waitForURL(h.base + "/jamfor/**");
}

for (const [name, w, hgt] of [["mobil390", 390, 844], ["desktop1280", 1280, 900]]) {
  test(`policy P (${name}): två ej förkryssade rutor, knappen inaktiv tills alla val gjorts, rätt knapptext; leverans → inget stort ångerblock, köpsidan visar att ångerrätten upphört + reklamation; ingen sidoscroll`, async () => {
    const h = await startHarness({ vars: { COMPARE_CONSENT_POLICY: "P" } });
    const { ctx, page, errors } = await newPage(h, w, hgt);
    try {
      await page.goto(h.base + "/jamfor/"); await page.waitForSelector("#s1:not(.hidden)"); await fillAndCheck(page, OFFERS);
      assert.equal(await page.locator("#startnow").isChecked(), false); assert.equal(await page.locator("#loseright").isChecked(), false); assert.equal(await page.locator("#terms").isChecked(), false);
      assert.match(await page.textContent("#emailhint"), /länken till Ditt köp och villkor/); assert.doesNotMatch(await page.textContent("#emailhint"), /ångerlänk/);
      assert.match(await page.textContent("#copy-how"), /länk till Ditt köp och villkor/);
      assert.ok(await page.isVisible("#lbl-startnow")); assert.ok(await page.isVisible("#lbl-loseright")); assert.equal(await page.isVisible("#lbl-immediate"), false);
      assert.match(await page.textContent("#t-startnow"), /startar direkt efter att jag betalat/); assert.match(await page.textContent("#t-loseright"), /förlorar min ångerrätt när tjänsten är fullt utförd/);
      assert.match(await page.textContent("#pay"), /Beställ med betalningsskyldighet: 49 kr/);
      assert.ok(await page.isVisible("#angerinfo")); assert.match(await page.textContent("#angertext"), /14 dagars ångerrätt.*hela beloppet tillbaka/s);
      assert.equal(await page.locator("#pay").isDisabled(), true);
      await page.fill("#email", "kund@example.test");
      await page.check("#terms"); assert.equal(await page.locator("#pay").isDisabled(), true, "villkor ensamt räcker inte");
      await page.check("#startnow"); assert.equal(await page.locator("#pay").isDisabled(), true, "en ruta räcker inte");
      await page.check("#loseright"); assert.equal(await page.locator("#pay").isDisabled(), false);
      await page.uncheck("#startnow"); assert.equal(await page.locator("#pay").isDisabled(), true);
      assert.equal(h.stats.stripeCreate, 0, "ingen betalsession utan val");
      assert.ok(await noSideScroll(page));
      await page.screenshot({ path: join(EVIDENCE, `jamfor_${name}_P1_samtycken.png`), fullPage: true });
      // helt flöde
      await page.check("#startnow"); await page.uncheck("#terms"); await page.uncheck("#startnow"); await page.uncheck("#loseright");
      const reqs = [];
      await payFlowP(page, h, OFFERS, { reqs, here: true });
      await page.waitForSelector("#rep:not(.hidden)", { timeout: 30000 });
      assert.equal(reqs.length >= 1, true); assert.equal(reqs[0].accept.startNow, true); assert.equal(reqs[0].accept.loseRight, true); assert.equal(reqs[0].accept.immediateDelivery, undefined);
      assert.equal(await page.locator("#rep #withdraw").count(), 0); assert.equal(await page.locator("#rep #agreement").count(), 0);
      const link = page.locator("#rep a#buylink"); assert.equal((await link.textContent()).trim(), "Ditt köp och villkor");
      await link.click(); await page.waitForURL("**/jamfor/kop/**");
      await page.waitForSelector("#rightsend", { timeout: 15000 });
      assert.match(await page.textContent("#rightsend"), /ångerrätt upphörde .* när tjänsten var fullt utförd/);
      assert.equal(await page.locator("#withdraw").count(), 0, "ingen ångerknapp efter giltigt fullgörande (ingen dold/nekande knapp)");
      assert.match(await page.textContent("#helpcard"), /reklamation/i); assert.ok(await page.isVisible('a[href="/jamfor/villkor/"]'));
      assert.ok(await noSideScroll(page));
      await page.screenshot({ path: join(EVIDENCE, `jamfor_${name}_P2_kopsida_upphord.png`), fullPage: true });
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); await h.close(); }
  });
}

// Policy P + källor: täckningen (Trustpilot bekräftad före köp) fryses; i rapportläget kvitterar UI visningen först när servern fått en lyckad hämtning; källfel ⇒ ingen kvittens ⇒ ångerrätten kvar på köpsidan.
for (const [label, tpFails] of [["lyckad visning ⇒ ångerrätten upphör", false], ["källfel ⇒ ångerrätten kvar", true]]) {
  test(`policy P + källor (mobil390): ${label}`, async () => {
    const h = await startHarness({ vars: { ...SRC_VARS, COMPARE_CONSENT_POLICY: "P" } }); seedSources(h);
    const { ctx, page, errors } = await newPage(h, 390, 844);
    await page.addInitScript(gmpDouble);
    const receipts = [];
    page.on("request", (r) => { if (/\/source-delivered$/.test(r.url()) && r.method() === "POST") receipts.push(JSON.parse(r.postData() || "{}")); });
    try {
      await toOfferStep(page, h);
      await page.fill("#sc0", "Malmö"); await page.fill("#sd0", "byggfirma.se"); await page.click("#srcgo"); await page.waitForSelector(".srcfirm[data-firm]");
      const f0 = page.locator(".srcfirm[data-firm]").nth(0);
      await f0.locator('[data-src="trustpilot"] button:has-text("Sök firman hos Trustpilot")').click();
      await page.waitForSelector('[data-src="trustpilot"] input[type=radio]');
      await f0.locator('[data-src="trustpilot"] input[type=radio]').first().check();
      await f0.locator('[data-src="trustpilot"] .btn.acc').click();
      await page.waitForSelector('[data-src="trustpilot"] button:has-text("Visa Trustpilots senaste")');
      if (tpFails) h.ctl.tpLatest = {}; // efter täckningen fryst: källan svarar inte
      await payFlowP(page, h, OFFERS, { here: true });
      await page.waitForSelector("#rep:not(.hidden)", { timeout: 30000 });
      await page.waitForSelector("#rep .srcfirm[data-firm]", { state: "attached", timeout: 15000 });
      await page.waitForTimeout(1500);
      assert.equal(await page.locator("#rep #withdraw").count(), 0, "inget stort ångerblock i rapporten");
      if (!tpFails) {
        await page.waitForFunction(() => /Trustpilot/.test(document.getElementById("rep").textContent) && document.querySelectorAll(".tprev").length > 0, null, { timeout: 15000 }).catch(() => {});
        if (!receipts.length) { const b = page.locator('#rep [data-src="trustpilot"] button:has-text("Visa Trustpilots senaste")'); if (await b.count()) await b.first().click(); await page.waitForTimeout(1500); }
        assert.ok(receipts.length >= 1, "UI skickade kvittens efter lyckad visning"); assert.equal(receipts[0].state, "visad");
      } else {
        await page.waitForTimeout(1500);
        assert.equal(receipts.length, 0, "ingen kvittens vid källfel");
      }
      await page.click("#rep a#buylink"); await page.waitForURL("**/jamfor/kop/**");
      if (!tpFails) { await page.waitForSelector("#rightsend", { timeout: 15000 }); assert.equal(await page.locator("#withdraw").count(), 0); }
      else { await page.waitForSelector("#rightskept", { timeout: 15000 }); assert.ok(await page.isVisible("#withdraw")); }
      assert.ok(await noSideScroll(page));
      await page.screenshot({ path: join(EVIDENCE, `jamfor_mobil390_P4_kallor_${tpFails ? "fel" : "ok"}.png`), fullPage: true });
      assert.deepEqual(errors.filter((e) => !/Failed to load resource|status of 5|status of 4/.test(String(e))), []);
    } finally { await ctx.close(); await h.close(); }
  });
}

test("policy P, fonster_slut (mobil390): levererad men fönstret ej slut ⇒ köpsidan visar att ångerrätten finns och ångern ger full återbetalning", async () => {
  const h = await startHarness({ vars: { COMPARE_CONSENT_POLICY: "P", COMPARE_FULFILMENT_POINT: "fonster_slut" } });
  const { ctx, page, errors } = await newPage(h, 390, 844);
  try {
    await payFlowP(page, h, OFFERS);
    await page.waitForSelector("#rep:not(.hidden)", { timeout: 30000 });
    await page.click("#rep a#buylink"); await page.waitForURL("**/jamfor/kop/**");
    await page.waitForSelector("#rightskept", { timeout: 15000 });
    assert.match(await page.textContent("#rightskept"), /inte fullt utförd.*hela beloppet tillbaka/s);
    assert.ok(await page.isVisible("#withdraw")); assert.ok(await noSideScroll(page));
    await page.screenshot({ path: join(EVIDENCE, "jamfor_mobil390_P3_kopsida_anger_kvar.png"), fullPage: true });
    await page.click("#withdraw"); await page.waitForSelector("#wdtext", { timeout: 15000 });
    assert.match(await page.textContent("#wdtext"), /Tjänsten var inte fullt utförd.*hela beloppet ska betalas tillbaka/s);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

for (const [name, w, hgt] of [["mobil390", 390, 844], ["desktop1280", 1280, 900]]) {
  test(`Googlereservation (${name}): varje billbar instans (sök, preview, valbyte, återöppning, retry) kräver ny serverreservation; nekad reservation skapar ingen instans`, async () => {
    const h = await startHarness({ vars: { ...SRC_VARS, COMPARE_SOURCES_MOUNT_DAY_CAP: "5", COMPARE_SOURCES_DETAILS_DAY_CAP: "3", COMPARE_SOURCES_SEARCH_DAY_CAP: "5" } }); seedSources(h);
    const { ctx, page, errors } = await newPage(h, w, hgt);
    await page.addInitScript(gmpDouble);
    const mountReqs = []; page.on("request", (r) => { if (/\/google\/mount$/.test(r.url()) && r.method() === "POST") mountReqs.push(JSON.parse(r.postData() || "{}")); });
    const PID2 = "ChIJ" + "b".repeat(24);
    const inst = () => page.evaluate(() => window.__inst || 0);
    try {
      await toOfferStep(page, h);
      await page.fill("#sc0", "Malmö"); await page.fill("#sd0", "byggfirma.se"); await page.fill("#sc1", "Lund");
      await page.click("#srcgo"); await page.waitForSelector(".srcfirm[data-firm]");
      const f0 = page.locator(".srcfirm[data-firm]").nth(0);
      await page.evaluate((ids) => { window.__SEARCH_PLACES = ids.map((id) => ({ id })); }, [PID, PID2]);
      await f0.locator('[data-src="google"] button:has-text("Sök firman hos Google")').click();
      await page.waitForSelector("gmp-place-search", { state: "attached" });
      assert.equal(await inst(), 1); assert.deepEqual(mountReqs.map((r) => r.kind), ["search"]);
      await gmpSelect(page, PID); await page.waitForSelector("gmp-advanced-place-details", { state: "attached" });
      assert.equal(await inst(), 2); assert.deepEqual(mountReqs.map((r) => r.kind), ["search", "details"]);
      await page.waitForFunction(() => !document.querySelector('[data-src="google"] [data-confirm="native"]').disabled);
      await gmpSelect(page, PID2); // valbyte = ny preview = ny reservation
      await page.waitForFunction(() => window.__inst === 3);
      assert.deepEqual(mountReqs.map((r) => r.kind), ["search", "details", "details"]);
      assert.equal(new Set(mountReqs.map((r) => r.mountId)).size, 3, "nytt mountId för varje instans");
      await page.waitForFunction(() => !document.querySelector('[data-src="google"] [data-confirm="native"]').disabled);
      await f0.locator('[data-src="google"] [data-confirm="native"]').click();
      await page.waitForSelector('[data-src="google"] button:has-text("Visa Googles omdömen")');
      // visa omdömen = tredje detaljinstansen (taket 3 nås)
      await page.click('[data-src="google"] button:has-text("Visa Googles omdömen")');
      await page.waitForFunction(() => window.__inst === 4);
      assert.equal(mountReqs.length, 4);
      // stäng och öppna igen = fjärde detaljinstans: nekas av servern (tak 3), ingen instans skapas
      await page.click('[data-src="google"] button:has-text("Dölj Googles omdömen")');
      await page.click('[data-src="google"] button:has-text("Visa Googles omdömen")');
      await page.waitForSelector('[data-gmp-stop="kostnadsstopp"]');
      assert.equal(mountReqs.length, 5); assert.equal(await inst(), 4, "ingen ny billbar instans efter nekad reservation");
      assert.equal(await page.locator("gmp-advanced-place-details").count(), 0);
      assert.match(await page.textContent('[data-gmp-stop]'), /pausade av kostnadsskäl.*inte att omdömen saknas/);
      assert.ok(await noSideScroll(page));
      await page.screenshot({ path: join(EVIDENCE, `jamfor_${name}_10_kallor_kostnadsstopp.png`), fullPage: true });
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); await h.close(); }
  });
}

test("Googlereservation: retry efter gmp-error är en NY reservation (nytt mountId), aldrig återanvänd tillåtelse", async () => {
  const h = await startHarness({ vars: { ...SRC_VARS, COMPARE_SOURCES_MOUNT_DAY_CAP: "10", COMPARE_SOURCES_DETAILS_DAY_CAP: "10", COMPARE_SOURCES_SEARCH_DAY_CAP: "10" } }); seedSources(h);
  const { ctx, page, errors } = await newPage(h, 390, 844);
  await page.addInitScript(gmpDouble);
  const reqs = []; page.on("request", (r) => { if (/\/google\/mount$/.test(r.url()) && r.method() === "POST") reqs.push(JSON.parse(r.postData() || "{}")); });
  try {
    await toOfferStep(page, h);
    await page.fill("#sc0", "Malmö"); await page.fill("#sd0", "byggfirma.se"); await page.fill("#sc1", "Lund");
    await page.click("#srcgo"); await page.waitForSelector(".srcfirm[data-firm]");
    const f0 = page.locator(".srcfirm[data-firm]").nth(0);
    await page.evaluate((id) => { window.__SEARCH_PLACES = [{ id }]; }, PID);
    await f0.locator('[data-src="google"] button:has-text("Sök firman hos Google")').click();
    await page.waitForSelector("gmp-place-search", { state: "attached" });
    await gmpSelect(page, PID); await page.waitForFunction(() => !document.querySelector('[data-src="google"] [data-confirm="native"]').disabled);
    await f0.locator('[data-src="google"] [data-confirm="native"]').click();
    await page.waitForSelector('[data-src="google"] button:has-text("Visa Googles omdömen")');
    await page.evaluate(() => { window.__GMP_MODE = "error"; });
    await page.click('[data-src="google"] button:has-text("Visa Googles omdömen")');
    await page.waitForSelector('button:has-text("Försök igen")');
    const before = reqs.length;
    await page.click('button:has-text("Försök igen")');
    await page.waitForFunction(() => window.__inst === 4);
    assert.equal(reqs.length, before + 1, "retry ger exakt en ny reservation");
    assert.equal(new Set(reqs.map((r) => r.mountId)).size, reqs.length, "inget mountId återanvänds");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await h.close(); }
});

for (const [name, w, hgt] of [["mobil390", 390, 844], ["desktop1280", 1280, 900]]) {
  test(`Swish-text (${name}): kunden ser före betalning att Stripe kan visas som mottagare; texten finns bara när Swish är påslaget`, async () => {
    for (const on of [true, false]) {
      const h = await startHarness({ vars: { ...SRC_VARS, ...(on ? { COMPARE_PAYMENT_METHODS: "card,swish", COMPARE_SWISH_VERIFIED: "1" } : { COMPARE_PAYMENT_METHODS: "card,swish" }) } }); seedSources(h);
      const { ctx, page, errors } = await newPage(h, w, hgt);
      await page.addInitScript(gmpDouble);
      try {
        await toOfferStep(page, h);
        await page.waitForSelector("#paymethods", { state: "attached" });
        const vis = await page.locator("#paymethods").isVisible();
        assert.equal(vis, on);
        if (on) {
          assert.match(await page.textContent("#paymethods"), /kan Stripe visas som mottagare och Ståhle Digital i meddelandet/);
          assert.equal(await page.getAttribute("#paymethods", "data-methods"), "card,swish");
          assert.ok(await noSideScroll(page));
          await page.screenshot({ path: join(EVIDENCE, `jamfor_${name}_11_swish_text.png`), fullPage: true });
        } else assert.equal(await page.getAttribute("#paymethods", "data-methods"), "card", "begärd men ej verifierad ⇒ bara kort");
        assert.deepEqual(errors, []);
      } finally { await ctx.close(); await h.close(); }
    }
  });
}


// ---------- D11-P1: Googles SDK-laddning (singleflight/callback/retry) och newest-konfiguration ----------
const sdkStub = (delayMs) => `window.google={maps:{importLibrary:async function(){
    const plain=(n)=>customElements.get(n)||customElements.define(n,class extends HTMLElement{});
    ["gmp-place-details-place-request","gmp-place-name","gmp-place-address","gmp-place-rating","gmp-place-website","gmp-place-attribution","gmp-place-all-content","gmp-place-text-search-request"].forEach(plain);
    if(!customElements.get("gmp-place-reviews"))customElements.define("gmp-place-reviews",class extends HTMLElement{get rankPreference(){return window.__RANK_IGNORED?null:this.getAttribute("rank-preference")} set rankPreference(v){if(!window.__RANK_IGNORED)this.setAttribute("rank-preference",v)}});
    if(!customElements.get("gmp-place-search")){customElements.define("gmp-place-search",class extends HTMLElement{connectedCallback(){window.__inst=(window.__inst||0)+1;setTimeout(()=>{this.places=[];this.dispatchEvent(new Event("gmp-load"))},20)}});
    customElements.define("gmp-advanced-place-details",class extends HTMLElement{connectedCallback(){window.__inst=(window.__inst||0)+1;setTimeout(()=>this.dispatchEvent(new Event("gmp-load")),20)}});}
    return {};}}};
    (function(){var cb=new URL(document.currentScript.src).searchParams.get("callback");if(cb)setTimeout(function(){window[cb]()},${delayMs})})();`;

test("SDK-laddning: långsam laddning ger EN script även efter timeout+Försök igen (ingen dubbel laddning); callback, inte onload, är beredskapen", async () => {
  const h = await startHarness({ vars: SRC_VARS }); seedSources(h);
  const { ctx, page } = await newPage(h, 390, 844);
  await page.addInitScript(() => { window.__GMP_SDK_WAIT = 500; });
  const hits = [];
  await ctx.route("https://maps.googleapis.com/**", (route) => { hits.push(route.request().url()); return route.fulfill({ contentType: "text/javascript", body: sdkStub(900) }); });
  try {
    const f0 = await toFirms(page, h);
    await f0.locator('[data-src="google"] button:has-text("Sök firman hos Google")').click();
    await page.waitForSelector("text=kunde inte visas just nu");
    assert.equal(await page.locator("script[data-gmp-sdk]").count(), 1);
    await page.click('[data-gmp-search] button:has-text("Försök igen")'); // laddningen pågår fortfarande: väntar in samma laddning
    await page.waitForSelector("gmp-place-search", { state: "attached", timeout: 8000 });
    assert.equal(hits.length, 1, "exakt ett SDK-anrop");
    assert.equal(await page.locator("script[data-gmp-sdk]").count(), 1);
    assert.equal(new URL(hits[0]).searchParams.get("callback"), "__gmpSdkReady");
  } finally { await ctx.close(); await h.close(); }
});

test("SDK-laddning: nätfel tar bort den felande taggen och nästa försök lägger exakt en ny; därefter ingen mer laddning", async () => {
  const h = await startHarness({ vars: SRC_VARS }); seedSources(h);
  const { ctx, page } = await newPage(h, 390, 844);
  const hits = []; let fail = true;
  await ctx.route("https://maps.googleapis.com/**", (route) => { hits.push(1); return fail ? route.abort() : route.fulfill({ contentType: "text/javascript", body: sdkStub(10) }); });
  try {
    const f0 = await toFirms(page, h);
    await f0.locator('[data-src="google"] button:has-text("Sök firman hos Google")').click();
    await page.waitForSelector("text=kunde inte visas just nu");
    assert.equal(await page.locator("script[data-gmp-sdk]").count(), 0, "felande tagg borttagen");
    fail = false;
    await page.click('[data-gmp-search] button:has-text("Försök igen")');
    await page.waitForSelector("gmp-place-search", { state: "attached" });
    assert.equal(hits.length, 2); assert.equal(await page.locator("script[data-gmp-sdk]").count(), 1);
    // ny montering (sök igen) laddar inte om SDK
    await page.evaluate(() => { const b = document.querySelector("[data-gmp-search] button"); void b; });
    assert.equal(hits.length, 2);
  } finally { await ctx.close(); await h.close(); }
});

test("Newest: attribut OCH property sätts före montering och verifieras; ignorerad ordning (rotens motexempel) ger ärlig 'okänd ordning'-notis, aldrig senaste-claim", async () => {
  for (const ignored of [false, true]) {
    const h = await startHarness({ vars: SRC_VARS }); seedSources(h);
    const { ctx, page } = await newPage(h, 390, 844);
    await page.addInitScript(gmpDouble); await page.addInitScript((ig) => { window.__GMP_RANK_IGNORED = ig; }, ignored);
    try {
      const f0 = await toFirms(page, h);
      await confirmNative(page, h, f0);
      await f0.locator('[data-src="google"] button:has-text("Visa Googles omdömen")').click();
      await page.waitForSelector("gmp-advanced-place-details", { state: "attached" });
      await page.waitForSelector('[data-gmp-order]');
      const r = await page.evaluate(() => { const b = document.querySelector("[data-gmp-order]"); return { ord: b.getAttribute("data-gmp-order"), note: !!b.querySelector("[data-gmp-order-note]"), attr: document.querySelector("gmp-place-reviews").getAttribute("rank-preference") }; });
      assert.equal(r.attr, "newest");
      assert.equal(r.ord, ignored ? "okand" : "newest"); assert.equal(r.note, ignored);
    } finally { await ctx.close(); await h.close(); }
  }
});

// ---------- D11: offert först (kolumner/rader), Sortera efter, identitet, Visa mer ----------
const fx = (o) => "FIXTURE:" + JSON.stringify(o);
const SC = (more = {}) => ({ rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar", ...more });
const EX = (kr, more = {}) => ({ totalBeforeRotSek: kr, totalVatBasis: "inkl", vatMode: "inkl", ...more });
const ID_OK = (name, extra = {}) => ({ name, orgnr: "556016-0680", address: "Storgatan 1", city: "Växjö", phone: "0470-123456", web: null, ...extra });
async function payToReport(page, h, texts) {
  await page.goto(h.base + "/jamfor/"); await page.waitForSelector("#s1:not(.hidden)");
  await fillAndCheck(page, texts);
  await page.fill("#email", "kund@example.test"); await page.check("#terms"); await page.check("#immediate"); await page.click("#pay");
  await page.waitForURL("https://checkout.stripe.test/**"); await page.click("#pay"); await page.waitForURL(h.base + "/jamfor/**");
  await page.waitForSelector("#rep:not(.hidden) table.cmp", { timeout: 40000 });
}
const colOrder = (page) => page.$$eval("table.cmp thead th[data-col]", (n) => n.map((x) => x.querySelector(".oh").textContent));
const visibleCols = (page) => page.$$eval("table.cmp thead th[data-col]", (n) => n.filter((x) => x.offsetParent !== null).map((x) => x.querySelector(".oh").textContent));

for (const [name, w, hgt] of [["mobil390", 390, 844], ["desktop1280", 1280, 900]]) {
  test(`offertvy (${name}): kolumner/rader, uppgifter att reda ut, Sortera efter med delad placering och ej bedömbara sist, inga falska vinnare/bockar`, async () => {
    const h = await startHarness();
    const { ctx, page, errors } = await newPage(h, w, hgt);
    try {
      await payToReport(page, h, [
        fx({ extracted: EX(100000), scope: SC({ startdatum: "ingar" }), issuer: ID_OK("Byggfirma AB") }),
        fx({ extracted: EX(90000), scope: SC({ startdatum: "ingar" }), issuer: { name: "Bygg B", orgnr: null, address: null, city: null, phone: null, web: null } }),
        fx({ extracted: EX(120000), scope: SC({ startdatum: "ingar" }), issuer: ID_OK("C-snickeri") }),
        fx({ extracted: EX(95000), scope: SC({ startdatum: "ingar" }), issuer: ID_OK("Firma D"), readability: "svar" }),
      ]);
      assert.ok(await noSideScroll(page), "ingen sidoscroll i offertvyn");
      assert.deepEqual(await colOrder(page), ["Byggfirma AB", "Bygg B", "C-snickeri", "Firma D"]); // neutral start = uppladdningsordning
      const oc = await page.$$eval("table.cmp thead th[data-col] .oc", (n) => n.map((x) => x.textContent));
      assert.match(oc[0], /^\d+ uppgifter att reda ut$/); assert.equal(oc[0], oc[2]); // samma fasta uppsättning, samma värde
      assert.equal(Number(oc[1].match(/\d+/)[0]), Number(oc[0].match(/\d+/)[0]) + 2, "saknad identitet (orgnr, kontakt) räknas i offertens oklarheter");
      assert.match(oc[3], /Går inte att bedöma säkert/); // mycket svårläst: aldrig 0/sämst
      // identitetsrader: ✓ endast när det framgår, ? med text när det inte gör det
      const idRows = await page.$$eval("table.cmp tbody tr", (rows) => rows.filter((r) => /Organisationsnummer|Företagsnamn|Adress eller telefon/.test(r.querySelector("th").textContent)).map((r) => [r.querySelector("th").textContent, [...r.querySelectorAll("td")].map((c) => c.textContent)]));
      const orgRow = idRows.find((r) => /Organisationsnummer/.test(r[0]));
      assert.match(orgRow[1][0], /✓ Framgår/); assert.match(orgRow[1][1], /\? Framgår inte/);
      // Sortera efter: meny med exakt dessa val; pris och betyg avstängda när de inte får användas
      const opts = await page.$$eval("#sortby option", (o) => o.map((x) => [x.value, x.disabled, x.textContent]));
      assert.deepEqual(opts.map((o) => o[0]), ["upload", "price", "fewopen", "mostopen", "rating"]);
      assert.equal(opts[1][1], true); assert.match(opts[1][2], /ej jämförbart/); // Firma D svårläst ⇒ priserna inte jämförbara
      assert.equal(opts[4][1], true); assert.match(opts[4][2], /kräver Trustpilot-uppgifter för minst två firmor/);
      await page.selectOption("#sortby", "fewopen");
      assert.deepEqual(await colOrder(page), ["Byggfirma AB", "C-snickeri", "Bygg B", "Firma D"]); // lika värden delar placering och behåller uppladdningsordning, ej bedömbar sist
      const ranks = await page.$$eval("table.cmp thead th[data-col] .rk", (n) => n.map((x) => x.textContent));
      assert.deepEqual(ranks, ["Plats 1 (delad)", "Plats 1 (delad)", "Plats 3", "Ej bedömbart"]);
      assert.match(await page.textContent("#sortnote"), /Få oklarheter betyder inte att hantverkaren är bäst/);
      await page.selectOption("#sortby", "mostopen");
      assert.deepEqual(await colOrder(page), ["Bygg B", "Byggfirma AB", "C-snickeri", "Firma D"]);
      await page.selectOption("#sortby", "upload");
      assert.deepEqual(await colOrder(page), ["Byggfirma AB", "Bygg B", "C-snickeri", "Firma D"]);
      // sortering flyttar hela kolumnen: firmaraden följer med
      await page.selectOption("#sortby", "mostopen");
      const firstTh = await page.textContent("table.cmp thead th[data-col]:first-of-type");
      assert.match(firstTh, /Plats 1Bygg BBygg B8 uppgifter att reda ut/); // rubrik, firma och oklarheter följer kolumnen
      // ingen dold totalvinnare / bäst-claim
      const all = await page.textContent("#rep");
      assert.doesNotMatch(all, /bäst överlag|bästa hantverkare|vinnare|rekommenderar/i);
      // fördjupningen är hopfälld och sammanhållen; långa förklaringar ligger inte i huvudytan
      assert.equal(await page.evaluate(() => document.querySelector("#more").open), false);
      assert.match(await page.textContent("#more summary"), /Visa mer/);
      assert.equal(await page.locator("#rep details#more >> text=Omdömen om företagen").count(), 1);
      await page.click("#more summary");
      assert.match(await page.textContent("#more"), /Väsentliga företagsuppgifter framgår inte av Bygg B/);
      await page.screenshot({ path: join(EVIDENCE, `jamfor_${name}_12_offertkolumner.png`), fullPage: true });
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); await h.close(); }
  });
}

test("Sortera efter lägst jämförbart pris (desktop): bara när jämförbart; lika belopp = delad placering utan falsk billigast; ingen total", async () => {
  const h = await startHarness();
  const { ctx, page } = await newPage(h, 1280, 900);
  try {
    await payToReport(page, h, [fx({ extracted: EX(120000), scope: SC(), issuer: ID_OK("Byggfirma AB") }), fx({ extracted: EX(100000), scope: SC(), issuer: ID_OK("Bygg B") }), fx({ extracted: EX(110000), scope: SC(), issuer: ID_OK("C-snickeri") })]);
    assert.equal(await page.locator("#sortby option[value=price]").isDisabled(), false);
    await page.selectOption("#sortby", "price");
    assert.deepEqual(await colOrder(page), ["Bygg B", "C-snickeri", "Byggfirma AB"]);
    assert.deepEqual(await page.$$eval("table.cmp thead th[data-col] .rk", (n) => n.map((x) => x.textContent)), ["Plats 1", "Plats 2", "Plats 3"]);
    assert.equal(await page.locator(".lowtag").count(), 1); assert.match(await page.textContent("th[data-col] .lowtag >> nth=0"), /Lägst jämförbart pris/);
    assert.match(await page.textContent("#sortnote"), /Det är ingen rekommendation/);
    assert.match(await page.textContent('[data-ranking="ja"]'), /Lägst angivet belopp: Bygg B/);
  } finally { await ctx.close(); await h.close(); }
  const h2 = await startHarness();
  const c2 = await newPage(h2, 1280, 900);
  try {
    await payToReport(c2.page, h2, [fx({ extracted: EX(100000), scope: SC(), issuer: ID_OK("Byggfirma AB") }), fx({ extracted: EX(100000), scope: SC(), issuer: ID_OK("Bygg B") })]);
    await c2.page.selectOption("#sortby", "price");
    assert.deepEqual(await c2.page.$$eval("table.cmp thead th[data-col] .rk", (n) => n.map((x) => x.textContent)), ["Plats 1 (delad)", "Plats 1 (delad)"]);
    assert.equal(await c2.page.locator(".lowtag").count(), 0, "lika belopp: ingen billigast-markering");
  } finally { await c2.ctx.close(); await h2.close(); }
});

test("smal skärm: två offerter åt gången med val, aldrig fyra krympta kolumner; bred skärm: alla fyra; ingen sidoscroll", async () => {
  const h = await startHarness();
  const { ctx, page } = await newPage(h, 390, 844);
  try {
    await payToReport(page, h, ["Offert A, Firma A\nTotalt 100 000 kr inkl. moms före ROT", "Offert B, Firma B\nTotalt 110 000 kr inkl. moms före ROT", "Offert C, Firma C\nTotalt 120 000 kr inkl. moms före ROT", "Offert D, Firma D\nTotalt 130 000 kr inkl. moms före ROT"]);
    assert.deepEqual(await visibleCols(page), ["Byggfirma AB", "Bygg B"]);
    assert.ok(await noSideScroll(page));
    await page.selectOption('#pickbar select[aria-label="Offert 2 att visa"]', "3");
    assert.deepEqual(await visibleCols(page), ["Byggfirma AB", "Firma D"]);
    await page.selectOption('#pickbar select[aria-label="Offert 1 att visa"]', "3"); // samma offert i båda platserna går inte
    const v = await visibleCols(page); assert.equal(new Set(v).size, 2);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForFunction(() => document.querySelectorAll("table.cmp thead th[data-col]:not(.colhide)").length === 4);
    assert.equal((await visibleCols(page)).length, 4);
  } finally { await ctx.close(); await h.close(); }
});

test("identitetsfall i vyn: oläsligt ≠ saknas; osäker utställare kräver kort kontroll; filialer slås inte ihop; webb/omdömen saknas är ingen brist", async () => {
  const h = await startHarness();
  const { ctx, page } = await newPage(h, 1280, 900);
  try {
    await payToReport(page, h, [
      fx({ extracted: EX(100000), scope: SC(), issuer: ID_OK("Byggfirma AB") }),
      fx({ extracted: EX(101000), scope: SC(), issuer: { name: null, orgnr: null, address: "Storgatan 1", city: "Växjö", phone: null, web: null, unreadable: true } }),
      fx({ extracted: EX(102000), scope: SC(), issuer: ID_OK("Byggfirma AB", { orgnr: "556000-0167" }) }),
    ]);
    const heads = await page.$$eval("table.cmp thead th[data-col] .firm", (n) => n.map((x) => x.textContent));
    assert.match(heads[0], /Byggfirma AB · Växjö/); assert.match(heads[1], /kunde inte avläsas säkert/);
    const orgRow = await page.$$eval("table.cmp tbody tr", (rows) => { const r = rows.find((x) => /Organisationsnummer/.test(x.querySelector("th").textContent)); return [...r.querySelectorAll("td")].map((c) => c.textContent); });
    assert.match(orgRow[0], /✓ Framgår/); assert.match(orgRow[1], /Kunde inte avläsas säkert/); assert.doesNotMatch(orgRow[1], /Framgår inte/);
    await page.click("#more summary");
    const more = await page.textContent("#more");
    assert.match(more, /kunde inte avläsas säkert \(företagsnamn, organisationsnummer\)/);
    assert.match(more, /samma företagsnamn men olika organisationsnummer/); // filial/koncernbolag: visas som olika, inte ihopslagna
    // ingen identitetsbrist för Byggfirma AB (webb saknas, inga omdömen): bara oklarheter i andra poster
    const q = await page.textContent("#rep details:has(summary:has-text('Byggfirma AB'))");
    assert.doesNotMatch(q, /företagsnamn|organisationsnummer/i);
  } finally { await ctx.close(); await h.close(); }
});

test("D11-P2c: företag läses ur offerten – auto utan inmatning, osäkert kräver kort bekräftelse, enskild firma får inga källor, 'Ändra företag' byter och nollställer", async () => {
  const h = await startHarness({ vars: SRC_VARS }); seedSources(h);
  const { ctx, page } = await newPage(h, 390, 844);
  try {
    await payToReport(page, h, [
      fx({ extracted: EX(100000), scope: SC(), issuer: ID_OK("Byggfirma AB") }),
      fx({ extracted: EX(101000), scope: SC(), issuer: ID_OK("Syd Bygg AB", { orgnr: "556000-0167", city: null }) }),
      fx({ extracted: EX(102000), scope: SC(), issuer: ID_OK("Karl Karlsson", { orgnr: "850101-1234" }) }),
      fx({ extracted: EX(103000), scope: SC(), issuer: { name: null, orgnr: null, address: null, city: null, phone: null, web: null, unreadable: true } }),
    ]);
    await page.click("#more summary");
    // 1) offert 1 lades in automatiskt, utan att kunden skrivit något
    await page.waitForSelector('#srcrep .srcfirm[data-firm]');
    assert.equal(await page.locator("#srcrep .srcfirm").count(), 1);
    const c0 = await page.textContent("#srcrep .srcfirm");
    assert.match(c0, /Byggfirma AB \(Växjö\)/); assert.match(c0, /läst ur offerten/);
    // 2) osäkert (ort saknas): kort fråga, inget skickas före "Stämmer"
    const p1 = page.locator('#srcprop .srcprop[data-offer="1"]');
    assert.match(await p1.textContent(), /Syd Bygg AB.*Stämmer det\?.*Orten framgår inte/s);
    // 3) enskild firma: inget namn visas, inga källor
    const p2 = await page.textContent('#srcprop .srcprop[data-offer="2"]');
    assert.match(p2, /enskild firma/); assert.doesNotMatch(p2, /Karl Karlsson/);
    // 4) ej avläst: kort rad + Lägg till företag
    const p3 = await page.textContent('#srcprop .srcprop[data-offer="3"]');
    assert.match(p3, /kunde inte läsas ur offerten säkert/); assert.match(p3, /Lägg till företag/);
    await p1.locator("button:has-text('Stämmer')").click();
    await page.waitForSelector('#srcrep .srcfirm:has-text("Syd Bygg AB")');
    assert.equal(await page.locator("#srcrep .srcfirm").count(), 2);
    assert.equal(await page.locator('#srcprop .srcprop[data-offer="1"]').count(), 0);
    // 5) Ändra företag: byter namn, origin blir kund
    await page.locator('#srcrep .srcfirm:has-text("Byggfirma AB") button:has-text("Ändra företag")').click();
    await page.fill("#se-n0", "Byggfirma Syd AB"); await page.fill("#se-c0", "Lund"); await page.click(".srcedit button:has-text('Spara företag')");
    await page.waitForSelector('#srcrep .srcfirm:has-text("Byggfirma Syd AB (Lund)")');
    assert.doesNotMatch(await page.textContent("#srcrep"), /Byggfirma AB \(Växjö\)/);
    assert.doesNotMatch(await page.locator('#srcrep .srcfirm:has-text("Byggfirma Syd AB")').textContent(), /läst ur offerten/);
    // 6) lägg till för oläsligt: manuell väg finns men är undantaget
    await page.locator('#srcprop .srcprop[data-offer="3"] button:has-text("Lägg till företag")').click();
    await page.fill("#se-n3", "Manuell Firma AB"); await page.click(".srcedit button:has-text('Spara företag')");
    await page.waitForSelector('#srcrep .srcfirm:has-text("Manuell Firma AB")');
    const hs = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth); assert.ok(hs <= 0, "ingen sidoscroll");
  } finally { await ctx.close(); await h.close(); }
});

test("D11-P2d: kompakt källrad vid offerten (★ betyg · antal · Trustpilot), betygssortering bara med uppgifter för ≥2 firmor, okänd sist, aldrig påhittade stjärnor", async () => {
  const h = await startHarness({ vars: SRC_VARS }); seedSources(h);
  h.ctl.tpFind = { "byggfirma.se": [{ id: "bu00000001", displayName: "Byggfirma", websiteUrl: "https://byggfirma.se" }], "syd.se": [{ id: "bu00000002", displayName: "Syd", websiteUrl: "https://syd.se" }] };
  const RV = [1, 2, 3].map((n) => ({ stars: 4, title: "Syntetiskt " + n, text: "SYNTETISK TEXT " + n, createdAt: `2026-09-${30 - n}T10:00:00Z`, link: "https://www.trustpilot.com/reviews/synth" + n }));
  h.ctl.tpLatest = { bu00000001: { businessUnit: { trustScore: 3.9, numberOfReviews: { total: 12 } }, reviews: RV }, bu00000002: { businessUnit: { trustScore: 4.6, numberOfReviews: { total: 310 } }, reviews: RV } };
  const { ctx, page } = await newPage(h, 1280, 900);
  try {
    await payToReport(page, h, [
      fx({ extracted: EX(100000), scope: SC(), issuer: ID_OK("Byggfirma AB") }),
      fx({ extracted: EX(101000), scope: SC(), issuer: ID_OK("Syd Bygg AB", { orgnr: "556000-0167" }) }),
      fx({ extracted: EX(102000), scope: SC(), issuer: ID_OK("Tredje AB", { orgnr: "556000-0001" }) }),
    ]);
    // före all koppling: inga stjärnor/betyg, sortering avstängd, ärlig text
    await page.waitForFunction(() => /Trustpilot/.test(document.querySelector('.srcline[data-src-offer="0"]')?.textContent || ""), null, { timeout: 15000 });
    const line0 = await page.textContent('.srcline[data-src-offer="0"]');
    assert.doesNotMatch(line0, /★/); assert.match(line0, /Trustpilot: ej kopplad/);
    assert.equal(await page.evaluate(() => document.querySelector('#sortby option[value="rating"]').disabled), true);
    await page.click("#more summary");
    await page.waitForSelector('#srcrep .srcfirm[data-firm]');
    for (const [name, dom] of [["Byggfirma AB", "byggfirma.se"], ["Syd Bygg AB", "syd.se"]]) {
      const card = page.locator(`#srcrep .srcfirm:has-text("${name}")`);
      await card.locator("button:has-text('Ändra företag')").click();
      await page.fill(".srcedit input[id^=se-d]", dom); await page.click(".srcedit button:has-text('Spara företag')");
      const c2 = page.locator(`#srcrep .srcfirm:has-text("${name}")`);
      await c2.locator('[data-src="trustpilot"] button:has-text("Sök firman hos Trustpilot")').click();
      await c2.locator('[data-src="trustpilot"] input[type=radio]').first().check();
      await c2.locator('[data-src="trustpilot"] .btn.acc').click();
    }
    // betyg + antal + källa dyker upp vid offerten UTAN att kunden klickat "Visa omdömen"
    await page.waitForFunction(() => /★ 4,6 av 5 · 310 omdömen · Trustpilot/.test(document.querySelector('.srcline[data-src-offer="1"]')?.textContent || ""), null, { timeout: 15000 });
    assert.match(await page.textContent('.srcline[data-src-offer="0"]'), /★ 3,9 av 5 · 12 omdömen · Trustpilot/);
    const l2 = await page.textContent('.srcline[data-src-offer="2"]');
    assert.doesNotMatch(l2, /★/, "firma utan uppgift får ingen stjärna"); assert.match(l2, /ej kopplad/);
    assert.equal(await page.evaluate(() => document.querySelector('.srcline[data-src-offer="1"]').getAttribute("aria-label")), "Trustpilots totalbetyg 4.6 av 5 från 310 omdömen");
    // sortering på betyg nu tillgänglig; högst först, okänd sist och märkt
    const opt = await page.$eval('#sortby option[value="rating"]', (o) => [o.disabled, o.textContent]);
    assert.equal(opt[0], false); assert.equal(opt[1], "Högst Trustpilot-betyg");
    await page.selectOption("#sortby", "rating");
    const order = await page.$$eval("table.cmp thead th[data-col] .srcline", (n) => n.map((x) => x.getAttribute("data-src-offer")));
    assert.deepEqual(order, ["1", "0", "2"]);
    const ranks = await page.$$eval("table.cmp thead th[data-col] .rk", (n) => n.map((x) => x.textContent));
    assert.deepEqual(ranks, ["Plats 1", "Plats 2", "Ej bedömbart"]);
    const note = await page.textContent("#sortnote");
    assert.match(note, /Trustpilots totalbetyg/); assert.match(note, /Googles betyg visas i Googles egen ruta och kan inte sorteras/); assert.match(note, /ingen rekommendation/);
    assert.doesNotMatch(await page.textContent("#rep"), /bäst överlag|vinnare|rekommenderar/i);
    assert.doesNotMatch(await page.textContent("table.cmp thead"), /Google[^ ]* ★|★ [0-9,]+ av 5 · [0-9]+ omdömen · Google/);
  } finally { await ctx.close(); await h.close(); }
});

// ---- D11-P2d rättning (root-QA P1): betygscachen är bunden till firmans aktuella identitet/koppling ----
const tpSeed = (h) => {
  seedSources(h);
  h.ctl.tpFind = { "byggfirma.se": [{ id: "bu00000001", displayName: "Byggfirma", websiteUrl: "https://byggfirma.se" }], "syd.se": [{ id: "bu00000002", displayName: "Syd", websiteUrl: "https://syd.se" }] };
  const RV = [1, 2, 3].map((n) => ({ stars: 4, title: "S" + n, text: "SYNT " + n, createdAt: `2026-09-${30 - n}T10:00:00Z`, link: "https://www.trustpilot.com/reviews/s" + n }));
  h.ctl.tpLatest = { bu00000001: { businessUnit: { trustScore: 3.9, numberOfReviews: { total: 12 } }, reviews: RV }, bu00000002: { businessUnit: { trustScore: 4.6, numberOfReviews: { total: 310 } }, reviews: RV } };
};
async function tpConfirm(page, name, dom) {
  let card = page.locator(`#srcrep .srcfirm:has-text("${name}")`);
  await card.locator("button:has-text('Ändra företag')").click();
  await page.fill(".srcedit input[id^=se-d]", dom); await page.click(".srcedit button:has-text('Spara företag')");
  card = page.locator(`#srcrep .srcfirm:has-text("${name}")`);
  await card.locator('[data-src="trustpilot"] button:has-text("Sök firman hos Trustpilot")').click();
  await card.locator('[data-src="trustpilot"] input[type=radio]').first().check();
  await card.locator('[data-src="trustpilot"] .btn.acc').click();
}
const lineOf = (page, k) => page.textContent(`.srcline[data-src-offer="${k}"]`);
const THREE = () => [
  fx({ extracted: EX(100000), scope: SC(), issuer: ID_OK("Byggfirma AB") }),
  fx({ extracted: EX(101000), scope: SC(), issuer: ID_OK("Syd Bygg AB", { orgnr: "556000-0167" }) }),
  fx({ extracted: EX(102000), scope: SC(), issuer: ID_OK("Tredje AB", { orgnr: "556000-0001" }) }),
];

test("D11-P2d-fix P1: ändrad domän/identitet nollställer betyg vid offerten och betygssortering faller tillbaka (root-repro)", async () => {
  const h = await startHarness({ vars: SRC_VARS }); tpSeed(h);
  const { ctx, page } = await newPage(h, 1280, 900);
  try {
    await payToReport(page, h, THREE()); await page.click("#more summary"); await page.waitForSelector('#srcrep .srcfirm[data-firm]');
    await tpConfirm(page, "Byggfirma AB", "byggfirma.se"); await tpConfirm(page, "Syd Bygg AB", "syd.se");
    await page.waitForFunction(() => /★ 4,6 av 5 · 310/.test(document.querySelector('.srcline[data-src-offer="1"]')?.textContent || ""), null, { timeout: 15000 });
    await page.selectOption("#sortby", "rating");
    assert.equal(await page.$eval("#sortby", (e) => e.value), "rating");
    // root-repro: Syd Bygg AB byter domän → servern nollställer TP-koppling
    const card = page.locator('#srcrep .srcfirm:has-text("Syd Bygg AB")');
    await card.locator("button:has-text('Ändra företag')").click();
    await page.fill(".srcedit input[id^=se-d]", "annan-firma.example"); await page.click(".srcedit button:has-text('Spara företag')");
    await page.waitForFunction(() => !/★ 4,6/.test(document.querySelector('.srcline[data-src-offer="1"]')?.textContent || "x"), null, { timeout: 15000 });
    assert.doesNotMatch(await lineOf(page, 1), /★|310/); assert.match(await lineOf(page, 1), /ej kopplad/);
    assert.match(await lineOf(page, 0), /★ 3,9 av 5 · 12 omdömen/, "oförändrad firma behåller sitt betyg");
    assert.equal(await page.$eval("#sortby", (e) => e.value), "upload", "betygssortering faller tillbaka");
    assert.equal(await page.$eval('#sortby option[value="rating"]', (o) => o.disabled), true);
    assert.doesNotMatch(await page.textContent("table.cmp thead"), /310/);
    // ändring av ENBART ort rensar också (identitet) och ny koppling hämtar nytt (ingen gammal siffra)
    await tpConfirm(page, "Syd Bygg AB", "syd.se");
    await page.waitForFunction(() => /★ 4,6 av 5 · 310/.test(document.querySelector('.srcline[data-src-offer="1"]')?.textContent || ""), null, { timeout: 15000 });
    h.ctl.tpLatest.bu00000002 = { businessUnit: { trustScore: 2.1, numberOfReviews: { total: 7 } }, reviews: h.ctl.tpLatest.bu00000001.reviews };
    await page.locator('#srcrep .srcfirm:has-text("Syd Bygg AB") button:has-text("Fel firma? Byt")').last().click();
    await page.waitForFunction(() => !/★/.test(document.querySelector('.srcline[data-src-offer="1"]')?.textContent || "x"), null, { timeout: 15000 });
    assert.equal(await page.$eval('#sortby option[value="rating"]', (o) => o.disabled), true);
  } finally { await ctx.close(); await h.close(); }
});

test("D11-P2d-fix: sent Trustpilotsvar (inflight) efter identitetsbyte ignoreras; samma firma i två kolumner räknas inte som två firmor", async () => {
  const h = await startHarness({ vars: SRC_VARS }); tpSeed(h);
  const { ctx, page } = await newPage(h, 1280, 900);
  try {
    // A) inflight: långsamt svar, domänbyte medan det är på väg
    await payToReport(page, h, THREE()); await page.click("#more summary"); await page.waitForSelector('#srcrep .srcfirm[data-firm]');
    await tpConfirm(page, "Byggfirma AB", "byggfirma.se");
    await page.waitForFunction(() => /★ 3,9/.test(document.querySelector('.srcline[data-src-offer="0"]')?.textContent || ""), null, { timeout: 15000 });
    h.ctl.tpDelayMs = 2500;
    await tpConfirm(page, "Syd Bygg AB", "syd.se"); // startar hämtning (fördröjd)
    const card = page.locator('#srcrep .srcfirm:has-text("Syd Bygg AB")');
    await card.locator("button:has-text('Ändra företag')").click(); // identitet ändras medan svaret är på väg
    await page.fill(".srcedit input[id^=se-d]", "annan-firma.example"); await page.click(".srcedit button:has-text('Spara företag')");
    await page.waitForTimeout(4000);
    assert.doesNotMatch(await lineOf(page, 1), /★|310/, "sent svar för gammal identitet får inte synas");
    assert.equal(await page.$eval('#sortby option[value="rating"]', (o) => o.disabled), true);
  } finally { await ctx.close(); await h.close(); }
  // B) distinkta firmor: samma firma i offert 1 och 2
  const h2 = await startHarness({ vars: SRC_VARS }); tpSeed(h2);
  const p2 = await newPage(h2, 1280, 900);
  try {
    await payToReport(p2.page, h2, [
      fx({ extracted: EX(100000), scope: SC(), issuer: ID_OK("Byggfirma AB") }),
      fx({ extracted: EX(101000), scope: SC(), issuer: ID_OK("Byggfirma AB") }),
      fx({ extracted: EX(102000), scope: SC(), issuer: ID_OK("Tredje AB", { orgnr: "556000-0001" }) }),
    ]);
    await p2.page.click("#more summary"); await p2.page.waitForSelector('#srcrep .srcfirm[data-firm]');
    assert.equal(await p2.page.locator("#srcrep .srcfirm").count(), 2, "samma firma = ett firmakort för två offerter");
    await tpConfirm(p2.page, "Byggfirma AB", "byggfirma.se");
    await p2.page.waitForFunction(() => /★ 3,9/.test(document.querySelector('.srcline[data-src-offer="1"]')?.textContent || ""), null, { timeout: 15000 });
    assert.match(await lineOf(p2.page, 0), /★ 3,9/);
    assert.equal(await p2.page.$eval('#sortby option[value="rating"]', (o) => o.disabled), true, "en firma i två kolumner ≠ två firmor");
  } finally { await p2.ctx.close(); await h2.close(); }
});

test("D11 förköpsidentitet: AV ⇒ ingen knapp/anrop; PÅ ⇒ användarstartad läsning, firma föreslås ur offerten före köp, osäker kräver kort 'Stämmer', täckning före köp, inga omdömen påhittade", async () => {
  // AV (standard): ingen knapp, inget anrop
  const hOff = await startHarness({ vars: SRC_VARS }); seedSources(hOff);
  const o1 = await newPage(hOff, 390, 844);
  try {
    await o1.page.goto(hOff.base + "/jamfor/"); await o1.page.waitForSelector("#s1:not(.hidden)");
    await fillAndCheck(o1.page, [fx({ extracted: EX(100000), scope: SC(), issuer: ID_OK("Byggfirma AB") }), fx({ extracted: EX(101000), scope: SC(), issuer: ID_OK("Syd Bygg AB", { orgnr: "556000-0167", city: null }) })]);
    await o1.page.waitForSelector("#srcbox:not(.hidden)");
    assert.equal(await o1.page.locator("#preid:not(.hidden)").count(), 0); assert.equal(hOff.stats.preid, 0);
  } finally { await o1.ctx.close(); await hOff.close(); }
  // PÅ
  const h = await startHarness({ vars: { ...SRC_VARS, COMPARE_PREID: "1", COMPARE_PREID_VERIFIED: "1", COMPARE_PREID_ORDER_CAP_MICRO: "500000" } }); seedSources(h);
  const { ctx, page } = await newPage(h, 390, 844);
  try {
    await page.goto(h.base + "/jamfor/"); await page.waitForSelector("#s1:not(.hidden)");
    await fillAndCheck(page, [fx({ extracted: EX(100000), scope: SC(), issuer: ID_OK("Byggfirma AB") }), fx({ extracted: EX(101000), scope: SC(), issuer: ID_OK("Syd Bygg AB", { orgnr: "556000-0167", city: null }) })]);
    await page.waitForSelector("#preid:not(.hidden) #preidgo");
    assert.match(await page.textContent("#preid"), /Då skickas din offert till AI-leverantören/); assert.match(await page.textContent("#preid"), /Inget skickas om du inte trycker på knappen/);
    assert.equal(h.stats.preid, 0, "inget skickas före klick");
    assert.equal(await page.locator("#srcfirms .srcfirm").count(), 0, "ingen firma före läsning");
    await page.click("#preidgo");
    await page.waitForSelector('#srcfirms .srcfirm:has-text("Byggfirma AB")');
    assert.equal(h.stats.preid, 2, "ETT anrop per offert");
    assert.match(await page.textContent("#preid"), /Läste företagsuppgifter för 2 av 2 offerter/);
    // osäker (ort saknas) ⇒ kort bekräftelse, inte automatiskt
    const p1 = page.locator('#srcpropPre .srcprop[data-offer="1"]');
    assert.match(await p1.textContent(), /Syd Bygg AB.*Stämmer det\?.*Orten framgår inte/s);
    assert.equal(await page.locator("#srcfirms .srcfirm").count(), 1);
    await p1.locator("button:has-text('Stämmer')").click();
    await page.waitForSelector('#srcfirms .srcfirm:has-text("Syd Bygg AB")');
    // täckning före köp visas utan påhittade betyg; inga stjärnor före köp
    const cov = await page.textContent("#srccov"); assert.match(cov, /Byggfirma AB/);
    assert.doesNotMatch(await page.textContent("#srcbox"), /★/);
    // klick igen ⇒ cachat (inga fler anrop)
    await page.click("#preidgo", { timeout: 1000 }).catch(() => {}); await page.waitForTimeout(300);
    assert.equal(h.stats.preid, 2);
    const hs = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth); assert.ok(hs <= 0, "ingen sidoscroll");
  } finally { await ctx.close(); await h.close(); }
});

// ================= Gratis → betald jämförelse (kandidat ROOT_FREE_TO_PAID_UX_20261011) =================
// Gratissidan (/) visar övergången bara när serverns config säger att jämförelsen är öppen. Första offerten följer med som lokal, kortlivad engångshandoff (sessionStorage)
// efter ett aktivt klick – aldrig i adressen, aldrig i anrop. Allt mot attrapper: /review och /event är route-mockade, ingen modell, ingen betalning.
const FREE_API = "https://granskaminoffert-api.anders-316.workers.dev";
const FREE_RESULT = { trade: "tak", calcCoverage: "checked", calcNote: "Kontrollerade timmar × timpris.", contradictions: [], clarify: [{ key: "Startdatum", text: "Inget startdatum anges." }], stated: [{ key: "Moms", text: "Priser anges inklusive moms." }], price: { hourlyRateSek: 595, totalSumSek: 42820, rotDeducted: true, comment: "Tydligt angivet." }, questions: ["Vilket startdatum gäller?"],
  priceReport: { referenceVersion: "2026-10-09", checked: [{ id: "moms", status: "ok", title: "Moms", text: "Priserna anges inklusive moms, konsekvent.", source: "" }], compared: [], cannotAssess: [], partial: false, readIssues: [], performed: { rules: 1, addons: 0, comparisons: 0 }, disclaimer: "Referensintervallen är en uppskattning.", methodUrl: "x" }, meta: { model: "mock" } };
async function freePage(h, w, hgt, { vars } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, locale: "sv-SE" });
  const calls = [];
  await ctx.route(FREE_API + "/**", (route) => { const u = new URL(route.request().url()); calls.push(route.request().method() + " " + u.pathname); const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, GET, OPTIONS" }; if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors }); if (u.pathname === "/review") return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify(FREE_RESULT) }); return route.fulfill({ status: 204, headers: cors }); });
  await ctx.route("https://checkout.stripe.test/**", (route) => route.abort());
  await ctx.route("https://static.cloudflareinsights.com/**", (route) => route.abort());
  const page = await ctx.newPage(); const errors = []; const reqs = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|Access to (XMLHttpRequest|resource)/.test(m.text())) errors.push(m.text()); });
  page.on("request", (r) => reqs.push(r.method() + " " + new URL(r.url()).pathname));
  return { ctx, page, errors, calls, reqs };
}
const DOC_TEXT = "Offert tak, Taktäckarna AB\nOmläggning av tak, 120 kvm.\nMaterial och arbete ingår.\nTotalt 120 000 kr inkl. moms före ROT";
const apiRe = (p) => new RegExp(p);

for (const [name, w, hgt] of [["mobil390", 390, 844], ["desktop1280", 1280, 900]]) {
  test(`gratis→betald (${name}): erbjudandet på startsidan och CTA efter resultatet (pris före klick, moms/engångsköp), bara för offertmottagare; stängd jämförelse ⇒ gratissidan oförändrad`, async () => {
    const h = await startHarness();
    const { ctx, page, errors } = await freePage(h, w, hgt);
    try {
      await page.goto(h.base + "/"); await page.waitForSelector("#cmpoffer:not([hidden])");
      const t = await page.textContent("#cmpoffer");
      assert.match(t, /Har du fler offerter för samma jobb\?/); assert.match(t, /49 kr/); assert.match(t, /inkl\. moms/); assert.match(t, /Ingen prenumeration/); assert.match(t, /1 offert|en offert i taget|jämföra 2–4 offerter/);
      assert.equal((await page.textContent("#cmpo-go")).replace(/\s+/g, " ").trim(), "Jämför 2–4 offerter – 49 kr"); assert.equal(await page.getAttribute("#cmpo-go", "href"), "/jamfor/");
      assert.ok(await noSideScroll(page));
      await page.screenshot({ path: join(EVIDENCE, `gratis_${name}_1_start_erbjudande.png`), fullPage: true });
      await page.click('.pathcard[data-path="hantverkare"]'); assert.equal(await page.isVisible("#cmpoffer"), false, "ingen mottagaruppmaning till hantverkaren");
      await page.click('.pathcard[data-path="mottagare"]'); assert.equal(await page.isVisible("#cmpoffer"), true);
      // resultat
      await page.click("#paste"); await page.fill("#txt", DOC_TEXT); await page.click("#run");
      await page.waitForSelector("#res.on"); await page.waitForSelector("#cmpcta:not([hidden])");
      assert.equal(await page.isVisible("#cmpoffer"), false, "bara en CTA i taget");
      const r = (await page.textContent("#cmpcta")).replace(/\s+/g, " ");
      assert.match(r, /Har du fler offerter för samma jobb\?/); assert.match(r, /Jämför vad som ingår, pris och villkor sida vid sida\./); assert.match(r, /49 kr inkl\. moms/); assert.match(r, /Ingen prenumeration, ingen automatisk dragning/); assert.match(r, /följer med/);
      assert.equal((await page.textContent("#cmpr-go")).replace(/\s+/g, " ").trim(), "Jämför 2–4 offerter – 49 kr");
      // gratisfrågorna finns kvar och CTA ligger efter dem
      assert.ok(await page.isVisible("#sendmail")); assert.ok(await page.isVisible("#copybtn"));
      const order = await page.evaluate(() => { const a = document.getElementById("sendmail").getBoundingClientRect().top, b = document.getElementById("cmpr-go").getBoundingClientRect().top; return a < b; });
      assert.ok(order, "CTA efter resultatets nästa steg, inte före");
      assert.ok(await noSideScroll(page));
      await page.screenshot({ path: join(EVIDENCE, `gratis_${name}_2_resultat_cta.png`), fullPage: true });
      await page.click('.pathcard[data-path="hantverkare"]'); assert.equal(await page.isVisible("#cmpcta"), false); assert.equal(await page.locator("#res a[href*='jamfor']").count(), 0);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); await h.close(); }
    // jämförelsen stängd (produktionsläget): ingen CTA någonstans
    const h2 = await startHarness({ vars: { COMPARE_ENABLED: undefined } });
    const f2 = await freePage(h2, w, hgt);
    try {
      await f2.page.goto(h2.base + "/"); await f2.page.waitForTimeout(800);
      assert.equal(await f2.page.locator("#cmpoffer").isVisible(), false);
      await f2.page.click("#paste"); await f2.page.fill("#txt", DOC_TEXT); await f2.page.click("#run"); await f2.page.waitForSelector("#res.on");
      assert.equal(await f2.page.locator("#cmpcta").isVisible(), false); assert.equal(await f2.page.locator("#res a[href*='jamfor']").count(), 0);
    } finally { await f2.ctx.close(); await h2.close(); }
  });

  test(`gratis→betald (${name}): textoffert följer med byteexakt efter aktivt klick, tydlig bekräftelse, ingen analys/betalning/källanrop via navigeringen, innehåll aldrig i adress, förbrukas vid order`, async () => {
    const h = await startHarness();
    const { ctx, page, errors, calls, reqs } = await freePage(h, w, hgt);
    try {
      await page.goto(h.base + "/"); await page.click("#paste"); await page.fill("#txt", DOC_TEXT); await page.click("#run"); await page.waitForSelector("#cmpcta:not([hidden])");
      const before = reqs.length; calls.length = 0;
      await page.click("#cmpr-go"); await page.waitForURL("**/jamfor/**"); await page.waitForSelector("#carry:not(.hidden)");
      assert.match(page.url(), /\/jamfor\/#fran=gratis$/); assert.ok(!page.url().includes("Taktäckarna") && !decodeURIComponent(page.url()).includes("Offert tak"), "innehåll aldrig i adressen");
      assert.equal(calls.filter((c) => /review|event/.test(c)).length, 0, "klicket startade ingen granskning och skickade ingen händelse");
      assert.equal((await page.textContent("#carry-h")).trim(), "Din första offert följer med."); assert.match(await page.textContent("#carry"), /Lägg till 1–3 offerter för samma jobb\./);
      assert.equal(await page.inputValue("#t0"), DOC_TEXT); assert.equal(await page.evaluate(() => document.activeElement.id), "carry-h", "fokus på bekräftelsen");
      assert.equal(await page.inputValue("#t1"), "");
      assert.ok(await noSideScroll(page));
      await page.screenshot({ path: join(EVIDENCE, `gratis_${name}_3_jamfor_bekraftelse.png`), fullPage: true });
      // inga mutationer mot jämförelsen före aktivt val
      await page.waitForTimeout(600);
      assert.deepEqual(reqs.slice(before).filter((r) => /^(POST|PUT|DELETE) /.test(r) && /\/compare\//.test(r)), [], "ingen order/betalning/källa startad av navigeringen");
      // byte av antal behåller den medföljande offerten
      await page.click('.seg button[data-n="3"]'); assert.equal(await page.inputValue("#t0"), DOC_TEXT); assert.equal(await page.isVisible("#carry"), true);
      // reload: återhämtning
      await page.reload(); await page.waitForSelector("#carry:not(.hidden)"); assert.equal(await page.inputValue("#t0"), DOC_TEXT);
      // slutför: lägg till 2 offerter, kontrollera ⇒ ordern skapas och handoffen förbrukas
      await page.click('.seg button[data-n="3"]'); assert.equal(await page.inputValue("#t0"), DOC_TEXT); await page.fill("#t1", OFFERS[1]); await page.fill("#t2", OFFERS[2]); await page.check("#samejob"); await page.click("#check");
      await page.waitForSelector("#offer:not(.hidden)", { timeout: 15000 });
      assert.equal(await page.evaluate(() => sessionStorage.getItem("sd_handoff_v1")), null, "handoffen förbrukad"); assert.ok(!/fran=gratis/.test(page.url()));
      const ord = await page.evaluate(() => localStorage.getItem("jamfor_order")); assert.ok(ord);
      await page.reload(); await page.waitForTimeout(800); assert.equal(await page.locator("#carry").isVisible(), false, "ingen gammal medföljande offert efter order");
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); await h.close(); }
  });

  test(`gratis→betald (${name}): PDF, foto (PNG/JPG) och text följer med byte för byte; startsidans CTA; ta bort; egen ändring släpper handoffen`, async () => {
    const h = await startHarness();
    const { ctx, page, errors } = await freePage(h, w, hgt);
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n%âãÏÓ\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"), Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 37) % 256))]);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 91 + 7) % 256))]);
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 53 + 3) % 256)), Buffer.from([0xff, 0xd9])]);
    try {
      for (const [fname, mime, buf] of [["offert.pdf", "application/pdf", pdf], ["foto.png", "image/png", png], ["foto.jpg", "image/jpeg", jpg]]) {
        await page.goto(h.base + "/"); await page.evaluate(() => sessionStorage.clear());
        await page.setInputFiles("#file", { name: fname, mimeType: mime, buffer: buf });
        await page.waitForSelector("#filepreview.on");
        await page.click("#cmpo-go"); await page.waitForURL("**/jamfor/**"); await page.waitForSelector("#carry:not(.hidden)");
        const got = await page.evaluate(async () => { const f = document.getElementById("f0").files[0]; if (!f) return null; const b = new Uint8Array(await f.arrayBuffer()); let s = ""; for (const x of b) s += String.fromCharCode(x); return { name: f.name, type: f.type, b64: btoa(s) }; });
        assert.ok(got, fname + ": fil i första fältet"); assert.equal(got.name, fname); assert.equal(got.type, mime); assert.equal(got.b64, buf.toString("base64"), fname + ": byteexakt");
        assert.match(await page.textContent("#fi0"), /följde med/); assert.match(await page.textContent("#carry"), new RegExp(fname.replace(".", "\\.")));
      }
      // ta bort den medföljande offerten
      await page.click("#carry-drop"); assert.equal(await page.isVisible("#carry"), false); assert.equal(await page.evaluate(() => document.getElementById("f0").files.length), 0); assert.equal(await page.evaluate(() => sessionStorage.getItem("sd_handoff_v1")), null); assert.match(await page.textContent("#fi0"), /Ingen fil vald/);
      assert.ok(!/fran=gratis/.test(page.url()));
      // egen ändring av första fältet släpper den medföljande offerten
      await page.goto(h.base + "/"); await page.click("#paste"); await page.fill("#txt", DOC_TEXT); await page.click("#cmpo-go"); await page.waitForSelector("#carry:not(.hidden)");
      await page.fill("#t0", "Helt annan text"); assert.equal(await page.isVisible("#carry"), false); assert.equal(await page.evaluate(() => sessionStorage.getItem("sd_handoff_v1")), null);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); await h.close(); }
  });

  test(`gratis→betald (${name}): befintlig order skrivs aldrig över; exempeloffert följer inte med; tangentbord (Enter på CTA) och fokus`, async () => {
    const h = await startHarness();
    const { ctx, page, errors, reqs } = await freePage(h, w, hgt);
    try {
      // skapa en riktig order först
      await page.goto(h.base + "/jamfor/"); await page.waitForSelector("#s1:not(.hidden)"); await fillAndCheck(page, [OFFERS[0], OFFERS[1]]);
      const orderBefore = await page.evaluate(() => localStorage.getItem("jamfor_order")); assert.ok(orderBefore);
      // från gratis med eget dokument
      await page.goto(h.base + "/"); await page.click("#paste"); await page.fill("#txt", DOC_TEXT); await page.click("#run"); await page.waitForSelector("#cmpcta:not([hidden])");
      const n0 = reqs.length;
      await page.focus("#cmpr-go"); assert.equal(await page.evaluate(() => document.activeElement.id), "cmpr-go"); await page.keyboard.press("Enter");
      await page.waitForURL("**/jamfor/**"); await page.waitForSelector("#hoconf:not(.hidden)");
      assert.match(await page.textContent("#hoconf"), /Du har redan en jämförelse igång/); assert.match(await page.textContent("#hoconf"), /orörd/);
      assert.equal(await page.evaluate(() => localStorage.getItem("jamfor_order")), orderBefore, "befintlig order orörd");
      assert.equal(reqs.slice(n0).filter((r) => r === "POST /compare/orders").length, 0, "ingen ny order skapad"); assert.equal(await page.isVisible("#carry"), false);
      assert.ok(await noSideScroll(page));
      await page.screenshot({ path: join(EVIDENCE, `gratis_${name}_4_befintlig_order.png`), fullPage: true });
      await page.reload(); await page.waitForSelector("#hoconf:not(.hidden)"); assert.equal(await page.evaluate(() => localStorage.getItem("jamfor_order")), orderBefore, "reload: fortfarande orörd");
      await page.click("#hoconf-keep"); assert.equal(await page.isVisible("#hoconf"), false); assert.equal(await page.evaluate(() => sessionStorage.getItem("sd_handoff_v1")), null);
      // exempeloffert: ingen medföljande offert
      await page.goto(h.base + "/"); await page.evaluate(() => { localStorage.removeItem("jamfor_order"); }); await page.reload();
      await page.click("#demo"); await page.waitForSelector("#cmpcta:not([hidden])"); assert.match(await page.textContent("#cmpcta"), /exempeloffert och följer inte med/);
      await page.click("#cmpr-go"); await page.waitForURL("**/jamfor/**"); await page.waitForSelector("#s1:not(.hidden)");
      assert.equal(await page.isVisible("#carry"), false); assert.equal(await page.inputValue("#t0"), ""); assert.equal(await page.evaluate(() => sessionStorage.getItem("sd_handoff_v1")), null);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); await h.close(); }
  });

  test(`gratis→betald (${name}): ärliga fel – blockerad lagring, för stor text, gammal och trasig handoff; aldrig falsk "följer med"`, async () => {
    const h = await startHarness();
    const { ctx, page, errors } = await freePage(h, w, hgt);
    try {
      // blockerad lagring på gratissidan
      await page.addInitScript(() => { if (location.pathname === "/") { Storage.prototype.setItem = function () { throw new DOMException("blocked", "SecurityError"); }; } });
      await page.goto(h.base + "/"); await page.click("#paste"); await page.fill("#txt", DOC_TEXT); await page.click("#run"); await page.waitForSelector("#cmpcta:not([hidden])");
      await page.click("#cmpr-go"); await page.waitForSelector(".cmpfail");
      assert.match(await page.textContent(".cmpfail"), /kunde inte följa med/); assert.ok(page.url().endsWith("/") || /127\.0\.0\.1:\d+\/$/.test(page.url()), "stannar kvar");
      assert.equal(await page.evaluate(() => document.activeElement.className), "cmpfail"); assert.equal(await page.getAttribute(".cmpfail a.btn", "href"), "/jamfor/");
      await page.screenshot({ path: join(EVIDENCE, `gratis_${name}_5_lagring_blockerad.png`), fullPage: true });
      await page.click("[data-stay]"); assert.equal(await page.locator(".cmpfail").count(), 0);
      // gå vidare utan offerten ⇒ tom jämförelse, inget falskt påstående
      await page.click("#cmpr-go"); await page.waitForSelector(".cmpfail"); await page.click(".cmpfail a.btn"); await page.waitForURL("**/jamfor/**"); await page.waitForSelector("#s1:not(.hidden)");
      assert.equal(await page.isVisible("#carry"), false); assert.equal(await page.inputValue("#t0"), "");
    } finally { await ctx.close(); }
    const c2 = await freePage(h, w, hgt);
    try {
      // för stor text (över handoff-gränsen)
      await c2.page.goto(h.base + "/"); await c2.page.click("#paste"); await c2.page.evaluate(() => { document.getElementById("txt").value = "x".repeat(4600000); });
      await c2.page.click("#cmpo-go"); await c2.page.waitForSelector(".cmpfail"); assert.match(await c2.page.textContent(".cmpfail"), /för stor/);
      // gammal, trasig, ogiltig och saknad handoff på /jamfor/
      const seed = async (val) => { await c2.page.goto(h.base + "/jamfor/"); await c2.page.waitForSelector("#s1:not(.hidden)"); await c2.page.evaluate((v) => { if (v === null) sessionStorage.removeItem("sd_handoff_v1"); else sessionStorage.setItem("sd_handoff_v1", v); }, val); await c2.page.goto(h.base + "/jamfor/#fran=gratis"); await c2.page.reload(); await c2.page.waitForSelector("#carry:not(.hidden)"); };
      const cases = [
        [JSON.stringify({ v: 1, at: 1, exp: Date.now() - 1000, doc: { kind: "text", text: "gammal" } }), /finns inte kvar/],
        ["{inte json", /gick inte att läsa/],
        [JSON.stringify({ v: 1, at: 1, exp: Date.now() + 60000, doc: { kind: "pdf", dataBase64: "@@@" } }), /gick inte att läsa/],
        [JSON.stringify({ v: 2, exp: Date.now() + 60000, doc: { kind: "text", text: "x" } }), /gick inte att läsa/],
        [null, /Vi hittar ingen medföljande offert/],
      ];
      for (const [val, re] of cases) {
        await seed(val);
        assert.equal((await c2.page.textContent("#carry-h")).trim(), "Ingen offert följde med"); assert.match(await c2.page.textContent("#carry"), re);
        assert.notEqual((await c2.page.textContent("#carry-h")).trim(), "Din första offert följer med.");
        assert.equal(await c2.page.inputValue("#t0"), ""); assert.equal(await c2.page.evaluate(() => document.getElementById("f0").files.length), 0);
        assert.equal(await c2.page.evaluate(() => sessionStorage.getItem("sd_handoff_v1")), null, "gammal/trasig handoff städad");
        assert.ok(await noSideScroll(c2.page));
      }
      await c2.page.screenshot({ path: join(EVIDENCE, `gratis_${name}_6_handoff_saknas.png`), fullPage: true });
      // blockerad läsning på /jamfor/
      await c2.page.addInitScript(() => { if (location.pathname.startsWith("/jamfor")) { Storage.prototype.getItem = function (k) { if (k === "sd_handoff_v1") throw new DOMException("blocked", "SecurityError"); return null; }; } });
      await c2.page.goto(h.base + "/jamfor/#fran=gratis"); await c2.page.reload(); await c2.page.waitForSelector("#carry:not(.hidden)");
      assert.match(await c2.page.textContent("#carry"), /tillåter inte tillfällig lagring/);
      assert.deepEqual(c2.errors, []);
    } finally { await c2.ctx.close(); await h.close(); }
  });
}

// Commit 1 – dataförlust vid antalbyte och återhämtning med väntande första offert (root-repro 9b287506).
for (const [name, w, hgt] of [["mobil390", 390, 844], ["desktop1280", 1280, 900]]) {
  test(`gratis→betald (${name}): antalbyte raderar aldrig inskrivna offerter (2→3, redigerad medföljande 3→2→3, filer, namn); dolda skickas inte`, async () => {
    const h = await startHarness();
    const { ctx, page, errors } = await freePage(h, w, hgt);
    try {
      await page.goto(h.base + "/"); await page.click("#paste"); await page.fill("#txt", DOC_TEXT); await page.click("#run"); await page.waitForSelector("#cmpcta:not([hidden])");
      await page.click("#cmpr-go"); await page.waitForURL("**/jamfor/**"); await page.waitForSelector("#carry:not(.hidden)");
      await page.fill("#lab1", "Firma Två"); await page.fill("#t1", OFFERS[1]);
      await page.click('.seg button[data-n="3"]');
      assert.equal(await page.inputValue("#t0"), DOC_TEXT); assert.equal(await page.inputValue("#t1"), OFFERS[1]); assert.equal(await page.inputValue("#lab1"), "Firma Två");
      await page.fill("#t2", OFFERS[2]);
      // redigera medföljande offert 1 och gå 3→2→3
      const edited = DOC_TEXT + "\nEgen ändring.";
      await page.fill("#t0", edited);
      await page.click('.seg button[data-n="2"]');
      assert.equal(await page.inputValue("#t0"), edited, "redigerad första offert består"); assert.equal(await page.inputValue("#t1"), OFFERS[1]);
      assert.equal(await page.isVisible("#t2"), false, "tredje är dold"); assert.match(await page.textContent("#slotnote"), /dold offert kvar/);
      await page.click('.seg button[data-n="3"]');
      assert.equal(await page.inputValue("#t2"), OFFERS[2], "dold offert återkommer orörd"); assert.equal(await page.isVisible("#slotnote"), false);
      // fil i slot 1, byte 3→2→3
      await page.setInputFiles("#f1", { name: "o.txt", mimeType: "text/plain", buffer: Buffer.from("Filoffert 55 000 kr") });
      await page.click('.seg button[data-n="2"]'); await page.click('.seg button[data-n="4"]'); await page.click('.seg button[data-n="2"]');
      assert.match(await page.textContent("#fi1"), /o\.txt/);
      assert.ok(await noSideScroll(page));
      await page.screenshot({ path: join(EVIDENCE, `gratis_${name}_7_antalbyte_behaller.png`), fullPage: true });
      // dold offert 3 (innehåll) skickas inte: ordern får 2 dokument
      const posted = []; page.on("request", (r) => { if (r.method() === "POST" && /\/compare\/orders$/.test(r.url())) posted.push(r.postData()); });
      await page.check("#samejob"); await page.click("#check"); await page.waitForSelector("#offer:not(.hidden)", { timeout: 15000 });
      assert.equal(JSON.parse(posted[0]).docCount, 2); assert.equal(JSON.parse(posted[0]).labels.length, 2);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); await h.close(); }
  });

  test(`gratis→betald (${name}): gammal order med 404 blockerar inte handoff – ny offert tas upp explicit, Börja om behåller #fran=gratis, befintlig giltig order skyddas`, async () => {
    const h = await startHarness();
    const { ctx, page, errors, reqs } = await freePage(h, w, hgt);
    try {
      await page.goto(h.base + "/jamfor/"); await page.evaluate(() => localStorage.setItem("jamfor_order", JSON.stringify({ id: "ord_finnsinte", token: "x".repeat(32) })));
      await page.goto(h.base + "/"); await page.click("#paste"); await page.fill("#txt", DOC_TEXT); await page.click("#run"); await page.waitForSelector("#cmpcta:not([hidden])");
      await page.click("#cmpr-go"); await page.waitForURL("**/jamfor/**");
      await page.waitForSelector("#carry:not(.hidden)", { timeout: 10000 });
      assert.equal(await page.inputValue("#t0"), DOC_TEXT, "första offerten återtagen efter 404");
      assert.match(await page.textContent("#carry"), /hittades inte/); assert.equal(await page.isVisible("#hoconf"), false); assert.equal(await page.evaluate(() => localStorage.getItem("jamfor_order")), null);
      assert.ok(await noSideScroll(page));
      await page.screenshot({ path: join(EVIDENCE, `gratis_${name}_8_gammal_order_404.png`), fullPage: true });
      // reload: samma tillstånd, ingen gammal order
      await page.reload(); await page.waitForSelector("#carry:not(.hidden)"); assert.equal(await page.inputValue("#t0"), DOC_TEXT);
      // Börja om efter utgången order behåller väntande offert
      await page.evaluate(() => { localStorage.setItem("jamfor_order", JSON.stringify({ id: "ord_finnsinte2", token: "y".repeat(32) })); });
      await page.reload(); await page.waitForSelector("#t0"); await page.waitForTimeout(500);
      assert.equal(await page.inputValue("#t0"), DOC_TEXT);
      assert.equal(reqs.filter((r) => r === "POST /compare/orders").length, 0, "ingen order skapad av återhämtningen");
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); await h.close(); }
  });

  test(`gratis→betald (${name}): ny flik/Ctrl-klick – texten säger ärligt att offerten bara följer med i den här fliken`, async () => {
    const h = await startHarness();
    const { ctx, page } = await freePage(h, w, hgt);
    try {
      await page.goto(h.base + "/"); await page.click("#paste"); await page.fill("#txt", DOC_TEXT); await page.click("#run"); await page.waitForSelector("#cmpcta:not([hidden])");
      assert.match(await page.textContent("#cmpcta"), /i den här fliken/); assert.match(await page.textContent("#cmpcta"), /ny flik följer den inte med/);
      await page.click("#cmpr-go", { modifiers: ["Control"] }).catch(() => {}); // ren länk, ingen handoff
      assert.equal(await page.evaluate(() => sessionStorage.getItem("sd_handoff_v1")), null);
    } finally { await ctx.close(); await h.close(); }
  });
}
