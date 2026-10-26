// FAQ navigation and click-to-load video checks. Synthetic iframe responses; no YouTube/AI calls.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/opt/npm-tools/node_modules/playwright/index.mjs').href);
const EVIDENCE = process.env.UI_EVIDENCE_DIR;
const VIDEOS = ['cLI3G1V0Tdg', 'eBgxqL-OWRE', '62MZbFHU_0E', 'wbjQmhaHN7Y', '6L-ko7PS4SU'];
let server, browser, base;
before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    let path = join(ROOT, decodeURIComponent(url.pathname));
    if (!extname(path)) path = join(path, 'index.html');
    if (!path.startsWith(ROOT) || !existsSync(path)) { res.writeHead(404); return res.end('Not found'); }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' });
    res.end(readFileSync(path));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });
async function context(options = {}) {
  const ctx = await browser.newContext(options); const external = [], errors = [];
  await ctx.route('**/*', async route => {
    if (route.request().url().startsWith(base)) return route.continue();
    external.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Local video test</p>' });
  });
  ctx.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  return { ctx, external, errors };
}
test('FAQ: no third party requests before play; keyboard loads each correct video once', async () => {
  const { ctx, external, errors } = await context({ viewport: { width: 390, height: 844 } });
  try {
    const page = await ctx.newPage(); await page.goto(base + '/faq/');
    await page.getByRole('heading', { name: 'Frågor, svar och filmer', exact: true }).waitFor();
    assert.equal(await page.locator('iframe').count(), 0); assert.deepEqual(external, []);
    assert.equal(await page.locator('[data-faq-video]').count(), 5);
    for (const id of VIDEOS) {
      const card = page.locator(`[data-faq-video="${id}"]`);
      await card.locator('summary').focus(); await page.keyboard.press('Enter');
      const button = card.getByRole('button', { name: /Visa filmen/ });
      await button.focus(); await page.keyboard.press('Space');
      const frame = card.locator('iframe'); await frame.waitFor();
      assert.equal(await frame.getAttribute('src'), `https://www.youtube-nocookie.com/embed/${id}?rel=0`);
      assert.ok(await frame.getAttribute('title')); assert.equal(await frame.getAttribute('referrerpolicy'), 'strict-origin-when-cross-origin');
      assert.equal(await card.locator('iframe').count(), 1);
      assert.equal(await card.locator('a[href="https://www.youtube.com/watch?v=' + id + '"]').count(), 1);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await card.locator('summary').click();
      await frame.waitFor({ state: 'detached', timeout: 2000 });
      assert.equal(await card.locator('button.faq-play').count(), 1, 'Closing the answer must unload hidden video and restore its choice');
      await card.locator('summary').click(); await button.waitFor({ state: 'visible' });
      assert.equal(await card.locator('iframe').count(), 0, 'Reopening alone must not reconnect to YouTube');
      await card.locator('summary').click();
    }
    assert.equal(external.length, 5); assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
test('FAQ: deep links open their answer, no-JS retains text and all video links, responsive layout', async () => {
  for (const width of [390, 1280]) {
    const { ctx, errors } = await context({ viewport: { width, height: 900 } });
    try {
      const page = await ctx.newPage(); await page.goto(base + '/faq/#jamfora-offerter');
      assert.equal(await page.locator('#jamfora-offerter').getAttribute('open'), '');
      assert.equal(await page.locator('iframe').count(), 0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (EVIDENCE) { mkdirSync(EVIDENCE, { recursive: true }); await page.screenshot({ path: join(EVIDENCE, `faq-${width}.png`), fullPage: true }); }
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  }
  const { ctx, external } = await context({ javaScriptEnabled: false });
  try {
    const page = await ctx.newPage(); await page.goto(base + '/faq/');
    assert.equal(await page.locator('[data-faq-video] a[href^="https://www.youtube.com/watch"]').count(), 5);
    await page.locator('#resultatet summary').click();
    assert.match(await page.locator('#resultatet').innerText(), /Anges, ej verifierat/);
    assert.equal(await page.locator('iframe').count(), 0); assert.deepEqual(external, []);
  } finally { await ctx.close(); }
});
test('App: FAQ is reachable from every entry without replacing entered offer text', async () => {
  for (const route of ['/', '/jamfor/', '/forkontroll/']) {
    const { ctx, errors } = await context({ viewport: { width: 390, height: 844 } });
    try {
      const page = await ctx.newPage(); await page.goto(base + route);
      const link = page.getByRole('navigation', { name: 'Hjälp med tjänsten' }).getByRole('link', { name: /Frågor, svar och filmer/ });
      assert.equal(await link.getAttribute('target'), '_blank');
      if (route === '/') {
        await page.getByRole('link', { name: /Granska en offert/ }).first().click();
        await page.locator('#paste').click(); await page.locator('#txt').fill('Fiktiv offert som ska vara kvar');
      }
      const [help] = await Promise.all([page.waitForEvent('popup'), link.click()]);
      await help.waitForLoadState(); assert.equal(new URL(help.url()).pathname, '/faq/');
      if (route === '/') assert.equal(await page.locator('#txt').inputValue(), 'Fiktiv offert som ska vara kvar');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  }
});
