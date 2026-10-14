// D18-GMO-MORK-UI (2026-10-14): GMO har samma mörka utseende som Materialräknaren mr-v148.
// Statisk kontroll utan webbläsare: variabler, meta, ljus utskrift, fokusram, inga kvarglömda ljusa ytor, kontrast (WCAG 2.x).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PAGES = ["index.html", "jamfor/index.html", "forkontroll/index.html", "jamfor/kop/index.html", "jamfor/angra/index.html", "foretagsuppgifter/index.html", "sa-granskar-vi-priser/index.html"];
const MR148 = { bg: "#17181a", paper: "#232427", ink: "#f4f4f2", ink2: "#c9c9c5", line: "#f4f4f226", acc: "#f0643b", "acc-text": "#f0643b", "acc-ink": "#161616", "acc-soft": "#28292c", field: "#2c2d31", fl: "#808185", gul: "#e2a93b" };
const read = (f) => readFileSync(ROOT + f, "utf8");
const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort(); return (y + 0.05) / (x + 0.05); };

for (const f of PAGES) test(`${f}: MR148-variabler, mörk meta, ljus utskrift, fokusram`, () => {
  const s = read(f);
  const root = s.match(/:root\{--bg:#17181a[^}]*\}/); assert.ok(root, "mörk :root saknas");
  for (const [k, v] of Object.entries(MR148)) assert.ok(root[0].includes(`--${k}:${v};`), `--${k}`);
  assert.match(root[0], /color-scheme:dark/);
  assert.ok(!/:root\{--bg:#f6f5f1/.test(s), "ljus :root kvar");
  assert.match(s, /<meta name="color-scheme" content="dark"><meta name="theme-color" content="#17181a">/);
  assert.match(s, /@media print\{:root\{--bg:#fff;--paper:#fff;--ink:#161616;/);
  assert.match(s, /:focus-visible\{outline:3px solid var\(--acc\);outline-offset:2px\}/);
  for (const ljus of ["#fff4ee", "#fffcf8", "#fafaf7", "#f1f0ec", "background:#fff;", "background:#fff}", "#1a56c4", "#1a5fd0", "#16161640"]) {
    const utanPrint = s.replace(/@media print\{[^@]*?\}\}/g, "");
    assert.ok(!utanPrint.includes(ljus), `ljus färg kvar: ${ljus}`);
  }
});
test("villkorssidan mörk med ljus utskrift", () => {
  const s = read("jamfor/villkor/index.html");
  assert.match(s, /background:#17181a;color:#f4f4f2;color-scheme:dark/); assert.match(s, /@media print\{body\{background:#fff;color:#161616/);
});
test("kontrast: text ≥ 4,5:1 och fältkanter ≥ 3:1 mot sina ytor", () => {
  const T = [["#f4f4f2", "#232427"], ["#c9c9c5", "#232427"], ["#c9c9c5", "#17181a"], ["#f0643b", "#232427"], ["#f0643b", "#17181a"], ["#f0643b", "#28292c"], ["#161616", "#f0643b"],
    ["#ef6b68", "#2f2223"], ["#5fbf86", "#1f2b24"], ["#e2a93b", "#2d281b"], ["#c9c9c5", "#2c2d31"], ["#161616", "#5fbf86"], ["#161616", "#ef6b68"], ["#161616", "#e2a93b"], ["#17181a", "#f4f4f2"]];
  for (const [a, b] of T) assert.ok(ratio(a, b) >= 4.5, `${a} på ${b}: ${ratio(a, b).toFixed(2)}`);
  for (const b of ["#2c2d31", "#232427", "#17181a"]) assert.ok(ratio("#808185", b) >= 3, `kant mot ${b}`);
});
test("startsidan: tydlig inlämning (dra-hit bara för mus, Granska och fel direkt efter vald fil, textfil visas som vald)", () => {
  const s = read("index.html");
  assert.match(s, /<span class="dragtip">…eller dra filen hit<\/span>/); assert.match(s, /@media \(hover:hover\) and \(pointer:fine\)\{\.drop \.dragtip\{display:block\}\}/);
  const i = (id) => s.indexOf(`id="${id}"`);
  assert.ok(i("drop") < i("filepreview") && i("filepreview") < i("txt") && i("txt") < i("runwrap") && i("runwrap") < i("errbox") && i("errbox") < i("demo") && i("demo") < i("res"), "ordning");
  assert.match(s, /Texten visas nedan – tryck Granska för att starta\./);
  assert.match(s, /content="gmo-v22"/);
});
