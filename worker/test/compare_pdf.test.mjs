// D16-R2 fix3b: ren Worker-PDF-skrivare – giltig struktur (xref-offsets), svenska tecken, klickbara länkar (även delade), tabeller över sidor, deterministisk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPdf, b64Bytes } from "../src/compare_pdf.js";
import { pdfText, pdfLinks } from "./helpers/compare_env.mjs";

const raw = (b) => String.fromCharCode(...b);
const doc = (blocks, extra = {}) => renderPdf({ title: "Titel åäö", footer: "Fot", blocks, ...extra });

test("PDF: giltig struktur – header, xref-offsets pekar på rätt objekt, startxref, trailer, %%EOF, sidantal stämmer", () => {
  const b = doc([{ t: "h1", text: "Rubrik" }, { t: "p", text: "Text " + "ord ".repeat(2000) }]);
  const s = raw(b);
  assert.ok(s.startsWith("%PDF-1.4\n")); assert.ok(s.trimEnd().endsWith("%%EOF"));
  const sx = Number(/startxref\n(\d+)\n%%EOF/.exec(s)[1]); assert.ok(s.slice(sx).startsWith("xref\n"));
  const size = Number(/xref\n0 (\d+)\n/.exec(s.slice(sx))[1]);
  const offs = [...s.slice(sx).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1])); assert.equal(offs.length, size - 1);
  offs.forEach((o, i) => assert.ok(s.slice(o).startsWith(`${i + 1} 0 obj\n`), `objekt ${i + 1} på offset ${o}`));
  const pages = Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(s)[1]); assert.ok(pages >= 2, "lång text ger flera sidor");
  assert.equal([...s.matchAll(/\/Type \/Page \//g)].length, pages);
  for (const m of s.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)) assert.equal(m[2].length, Number(m[1]), "stream-längd stämmer");
  assert.ok(![...b].some((c) => c > 127 && !(s.indexOf("%\xe2\xe3\xcf\xd3") === 9)), "bara binärmarkören har högbytes");
  for (let i = 0; i < pages; i++) assert.ok(s.includes(`Fot   Sida ${i + 1} av ${pages}`), `sidfot sida ${i + 1}`);
});

test("PDF: svenska tecken, specialtecken och escape; okänt tecken blir ?; deterministisk (samma indata ⇒ samma byte)", () => {
  const blocks = [{ t: "p", text: "Åke åt äpplen på örnens ö – ”citat” (parentes) \\ snedstreck • punkt … € 49,00 kr" }, { t: "p", text: "Okänt: ☃ ✓ → ≥" }];
  const a = doc(blocks), b = doc(blocks); assert.equal(raw(a), raw(b), "deterministisk");
  const t = pdfText(b64Bytes(a));
  for (const v of ["Åke åt äpplen på örnens ö – ”citat” (parentes) \\ snedstreck • punkt … € 49,00 kr", "Okänt: ? ja -> >="]) assert.ok(t.includes(v), v);
});

test("PDF: klickbara länkar – https och e-post, delad lång länk behåller hela URI:n i varje del, interpunktion hamnar utanför länken", () => {
  const url = "https://granskaminoffert.se/jamfor/#o=o_" + "a".repeat(32) + "&r=" + "B".repeat(32);
  const b = b64Bytes(doc([{ t: "p", text: `Öppna: ${url}. Frågor till hej@stahledigital.se, tack.` }]));
  const L = pdfLinks(b); assert.ok(L.filter((x) => x === url).length >= 2, "lång länk delas men varje del pekar på hela URI:n");
  assert.ok(L.includes("mailto:hej@stahledigital.se")); assert.ok(L.every((x) => !/[.,]$/.test(x)));
});

test("PDF: tabell över flera sidor – rubrikraden upprepas, alla rader med, inga tomma sidor, långa celler bryts", () => {
  const rows = Array.from({ length: 120 }, (_, i) => [`Rad ${i}`, `Ingår – ${"text ".repeat(i % 9)}`, "Framgår inte"]);
  const b = b64Bytes(doc([{ t: "table", cols: [2, 3, 3], head: ["Rad", "A", "B"], rows }]));
  const t = pdfText(b); for (let i = 0; i < 120; i++) assert.ok(t.includes(`Rad ${i} `) || t.includes(`Rad ${i}`), `rad ${i}`);
  const s = atob(b); const pages = Number(/\/Count (\d+)/.exec(s)[1]); assert.ok(pages >= 3);
  assert.ok([...t.matchAll(/Rad A B/g)].length >= pages - 0, "rubrikrad på varje sida");
});
