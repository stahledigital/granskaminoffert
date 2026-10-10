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
  const h = await startHarness({ vars: { COMPARE_SELLER_NAME: "Syntetisk Säljare AB", COMPARE_SELLER_ORGNR: "556000-0000", COMPARE_SELLER_EMAIL: "kontakt@example.test", COMPARE_SELLER_ADDRESS: "Exempelgatan 1, 111 11 Teststad", COMPARE_SELLER_VAT: "SE556000000001" } });
  const { ctx, page, errors } = await newPage(h, 390, 844);
  try {
    await page.goto(h.base + "/jamfor/villkor/");
    await page.waitForSelector("#terms h2");
    const t = await page.textContent("#terms");
    for (const v of ["version villkor-utkast-1, UTKAST", "Syntetisk Säljare AB", "SE556000000001", "Exempelgatan 1", "49,00 kr inklusive moms", "Ångra köpet", "Personuppgifter och lagring"]) assert.ok(t.includes(v), v);
    assert.ok(await noSideScroll(page));
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
}
// Offlineattrapp för Googles UI Kit-element (beta). Elementnamn enligt Googles primärdocs; attrappen bevisar vår konfiguration/händelsehantering/cleanup,
// INTE Googles liveutfall. __GMP_MODE: ok (gmp-load) | error (gmp-error) | silent (ingen händelse alls).
const gmpDouble = () => {
  window.__gmpCalls = []; window.__GMP_MODE = "ok"; window.__searchTexts = []; window.__SEARCH_PLACES = [];
  window.__GMP_LOADER__ = async (key) => {
    window.__gmpCalls.push(key);
    if (customElements.get("gmp-advanced-place-details")) return {};
    const plain = (n) => customElements.define(n, class extends HTMLElement {});
    ["gmp-place-details-place-request", "gmp-place-name", "gmp-place-address", "gmp-place-rating", "gmp-place-website", "gmp-place-reviews", "gmp-place-attribution", "gmp-place-all-content", "gmp-place-text-search-request"].forEach(plain);
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
      await page.waitForSelector('[data-src="google"] button:has-text("Visa Googles senaste omdömen")');
      assert.equal(await page.locator("gmp-place-search").count(), 0, "söklementet avmonteras efter bekräftelse");
      await page.evaluate(() => { window.__GMP_MODE = "ok"; });
      await page.click('[data-src="google"] button:has-text("Visa Googles senaste omdömen")');
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
      await page.click('[data-src="google"] button:has-text("Visa Googles senaste omdömen")'); await page.waitForSelector("gmp-advanced-place-details", { state: "attached" });
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
    await page.waitForSelector("#rep .srcfirm[data-firm]", { timeout: 15000 });
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
    return {};}}};`;
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
  await page.waitForSelector('[data-src="google"] button:has-text("Visa Googles senaste omdömen")');
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
    await page.click('[data-src="google"] button:has-text("Visa Googles senaste omdömen")');
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
    await page.click('[data-src="google"] button:has-text("Visa Googles senaste omdömen")'); await page.waitForSelector("gmp-advanced-place-details", { state: "attached" });
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
    await page.waitForSelector('[data-src="google"] button:has-text("Visa Googles senaste omdömen")');
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
      await page.waitForSelector('[data-src="google"] button:has-text("Visa Googles senaste omdömen")');
      // visa omdömen = tredje detaljinstansen (taket 3 nås)
      await page.click('[data-src="google"] button:has-text("Visa Googles senaste omdömen")');
      await page.waitForFunction(() => window.__inst === 4);
      assert.equal(mountReqs.length, 4);
      // stäng och öppna igen = fjärde detaljinstans: nekas av servern (tak 3), ingen instans skapas
      await page.click('[data-src="google"] button:has-text("Dölj Googles omdömen")');
      await page.click('[data-src="google"] button:has-text("Visa Googles senaste omdömen")');
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
    await page.waitForSelector('[data-src="google"] button:has-text("Visa Googles senaste omdömen")');
    await page.evaluate(() => { window.__GMP_MODE = "error"; });
    await page.click('[data-src="google"] button:has-text("Visa Googles senaste omdömen")');
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
