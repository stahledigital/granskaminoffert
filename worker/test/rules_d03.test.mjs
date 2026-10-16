// D03 paket A1/A2 – regressionstabell T01–T04 och OK-doktrinen:
// "OK kräver BELAGD beloppsbas; en passande hypotes räcker inte."
// Alla testfall är syntetiska (inga riktiga offerter, inga personuppgifter).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runRules, compareToBands } from "../src/rules.js";
import { sanitizeExtracted } from "../src/sanitize.js";
import { resolveTotals } from "../src/amounts.js";

const REF = JSON.parse(readFileSync(new URL("../src/reference.json", import.meta.url), "utf8"));
const prep = (o) => sanitizeExtracted(o).x;
const rules = (o) => runRules(prep(o), REF);
const cmp = (o) => compareToBands(prep(o), REF);
const by = (arr, id) => arr.find((c) => c.id === id);

// ---- T01: värmepumpsschablon ----
const HP = { jobType: "bergvarme", priceType: "fast", propertyType: "smahus", vatMode: "inkl", quoteDate: "2026-09-01", rotAmountSek: 21000 };

test("T01/F8-P01: schablonen blir aldrig ok – villkorat räkneexempel; fel bara när alla villkor är uttryckliga", () => {
  const c1 = by(rules({ ...HP, totalBeforeRotSek: 200000, totalVatBasis: "inkl" }), "rot_schablon");
  assert.equal(c1.status, "fraga");
  assert.match(c1.text, /totalentreprenad/);
  assert.match(c1.text, /21\s000 kr/);
  // även med uttrycklig totalentreprenad är momsbasen hos Skatteverket inte belagd
  const c2 = by(rules({ ...HP, totalBeforeRotSek: 200000, totalVatBasis: "inkl", totalContract: "ja" }), "rot_schablon");
  assert.equal(c2.status, "fraga");
  assert.match(c2.text, /inte vilken momsbas/);
  // nettofallet: summa att betala efter ROT (179 000) → före ROT 200 000
  assert.match(by(rules({ ...HP, amountToPaySek: 179000, totalVatBasis: "inkl", totalContract: "ja" }), "rot_schablon").text, /200\s000 kr/);
  // fel avdrag med alla villkor uttryckliga = fel; annars fråga
  assert.equal(by(rules({ ...HP, rotAmountSek: 60000, totalBeforeRotSek: 200000, totalVatBasis: "inkl", totalContract: "ja" }), "rot_schablon").status, "fel");
  assert.equal(by(rules({ ...HP, rotAmountSek: 60000, totalBeforeRotSek: 200000, totalVatBasis: "inkl" }), "rot_schablon").status, "fraga");
  assert.equal(by(rules({ ...HP, totalContract: "nej", totalBeforeRotSek: 200000, totalVatBasis: "inkl" }), "rot_schablon").status, "fraga");
  // luftvärmepump: 30 % × 30 %
  const lv = rules({ ...HP, jobType: "luftvarmepump", rotAmountSek: 9000, totalBeforeRotSek: 100000, totalVatBasis: "inkl" });
  assert.equal(by(lv, "rot_schablon").status, "fraga");
  assert.doesNotMatch(by(lv, "rot_schablon").text, /35 %/);
});

test("T01: oetiketterad total med ROT blir fråga med tolkningarna utskrivna – aldrig OK för att en hypotes passar", () => {
  const r = by(rules({ ...HP, totalSumSek: 200000 }), "rot_schablon");
  assert.equal(r.status, "fraga");
  assert.match(r.text, /summan före ROT-avdrag/);
  assert.match(r.text, /summan att betala efter ROT-avdrag/);
  // tolkning "200 000 är före ROT" skulle ge exakt 21 000 – ändå får det inte bli OK
  assert.notEqual(r.status, "ok");
});

test("T01: villkor som saknas ger fråga/avstå, inte OK", () => {
  const base = { ...HP, totalBeforeRotSek: 200000, totalVatBasis: "inkl" };
  assert.equal(by(rules({ ...base, propertyType: null }), "rot_schablon").status, "fraga");
  assert.equal(by(rules({ ...base, propertyType: "bostadsratt" }), "rot_schablon").status, "fraga");
  assert.equal(by(rules({ ...base, priceType: "ungefarligt" }), "rot_schablon").status, "fraga");
  assert.equal(by(rules({ ...base, priceType: null }), "rot_schablon").status, "fraga");
  assert.equal(by(rules({ ...HP }), "rot_schablon").status, "ej_bedombar"); // ingen total alls
  const exkl = by(rules({ ...HP, vatMode: "exkl", totalBeforeRotSek: 160000, totalVatBasis: "exkl" }), "rot_schablon");
  assert.equal(exkl.status, "fraga");
  assert.match(exkl.text, /21\s000 kr/); // inkl. moms-utfall
  assert.match(exkl.text, /16\s800 kr/); // exkl. moms-utfall
  // okänd momsbas på totalen
  assert.equal(by(rules({ ...HP, vatMode: "ej_angivet", totalBeforeRotSek: 200000 }), "rot_schablon").status, "fraga");
});

test("T01: värmepumpsfallet visar inte 'uppdelning saknas' bredvid en genomförd schablonkontroll", () => {
  assert.equal(by(rules({ ...HP, totalBeforeRotSek: 200000, totalVatBasis: "inkl" }), "uppdelning"), undefined);
});

// ---- T02: momsnormalisering ----
test("T02: samma offert exklusive och inklusive moms ger samma bedömning", () => {
  const inkl = { jobType: "tak", areaM2: 30, trades: ["snickare"], vatMode: "inkl", priceType: "fast", quoteDate: "2026-09-01",
    hourlyRateSek: 800, hours: 50, laborSumSek: 40000, materialSumSek: 20000, rotAmountSek: 12000, totalBeforeRotSek: 60000, totalVatBasis: "inkl" };
  const exkl = { ...inkl, vatMode: "exkl", hourlyRateSek: 640, laborSumSek: 32000, materialSumSek: 16000, totalBeforeRotSek: 48000, totalVatBasis: "exkl" };
  const a = rules(inkl), b = rules(exkl);
  for (const id of ["moms", "rot_belopp", "arbetssumma", "summa", "pristyp"]) {
    assert.equal(by(a, id)?.status, by(b, id)?.status, `status för ${id}`);
  }
  assert.equal(by(a, "rot_belopp").status, "ok");
  const ca = cmp(inkl), cb = cmp(exkl);
  assert.equal(by(ca, "tim_snickare").mode, by(cb, "tim_snickare").mode);
  assert.equal(by(ca, "projekt").mode, by(cb, "projekt").mode);
  assert.equal(by(ca, "projekt").text.match(/\d[\d\s]* kr per m²/)[0], by(cb, "projekt").text.match(/\d[\d\s]* kr per m²/)[0]);
});

test("T02: känd moms normaliseras oavsett kundtyp (privatperson och företag)", () => {
  for (const customerType of ["privatperson", "foretag", null]) {
    const x = { jobType: "tak", areaM2: 20, trades: ["elektriker"], customerType, vatMode: "exkl", hourlyRateSek: 700, totalBeforeRotSek: 40000, totalVatBasis: "exkl" };
    assert.equal(by(cmp(x), "tim_elektriker").mode, "inom", String(customerType)); // 700 exkl ≈ 875 inkl, band 650–950
    assert.equal(by(cmp(x), "projekt").mode, "inom"); // 50 000 inkl / 20 = 2 500 kr/m²
    assert.match(by(cmp(x), "tim_elektriker").text, /exkl\. moms/);
  }
});

test("T02: ej_angivet, blandat, okant_moms och ogiltigt vatMode görs aldrig till faktum", () => {
  for (const vatMode of ["ej_angivet", "blandat", "okant_moms", "brutto", undefined]) {
    for (const customerType of ["privatperson", "foretag"]) {
      const r = rules({ jobType: "tak", customerType, vatMode, laborSumSek: 10000, materialSumSek: 5000, totalSumSek: 15000, rotAmountSek: 3000 });
      assert.notEqual(by(r, "moms").status, "ok", `${vatMode}/${customerType}`);
      assert.notEqual(by(r, "rot_belopp")?.status, "ok", `ROT ${vatMode}/${customerType}`);
      assert.notEqual(by(r, "summa")?.status, "ok", `summa ${vatMode}/${customerType}`);
    }
  }
  // blandat = fel (offerten blandar), de andra frågor
  assert.equal(by(rules({ vatMode: "blandat", laborSumSek: 1 }), "moms").status, "fel");
});

// ---- T03: projektscope ----
test("T03: badrumsspannet gäller 4–6 m²; annan eller saknad yta avstår", () => {
  const b = { jobType: "badrum", vatMode: "inkl", totalBeforeRotSek: 200000, totalVatBasis: "inkl" };
  assert.equal(by(cmp({ ...b, areaM2: 5 }), "projekt").mode, "inom");
  assert.equal(by(cmp({ ...b, areaM2: 4 }), "projekt").mode, "inom");
  assert.equal(by(cmp({ ...b, areaM2: 6 }), "projekt").mode, "inom");
  for (const a of [12, 3.9, 6.1, null, 0]) {
    const p = by(cmp({ ...b, areaM2: a }), "projekt");
    assert.equal(p.mode, "ej_bedombar", String(a));
    assert.match(p.text, /4–6 m²/);
  }
  assert.match(by(cmp({ ...b, areaM2: 12 }), "projekt").text, /12 m²/);
  // andra projekttyper påverkas inte av scopeArea
  assert.equal(by(cmp({ jobType: "elcentral", vatMode: "inkl", totalBeforeRotSek: 9000, totalVatBasis: "inkl" }), "projekt").mode, "inom");
});

// ---- T04: det fungerande nettofallet bevaras, T04a utan etikett lovas inte ----
const T04 = { jobType: "tak", trades: ["snickare"], hourlyRateSek: 595, hours: 36, laborSumSek: 21420, materialSumSek: 18900, otherSumSek: 2500,
  rotAmountSek: 6426, vatMode: "inkl", priceType: "fast", quoteDate: "2026-09-10", areaM2: 32 };

test("T04: oetiketterad netto-total som entydigt stämmer av mot raderna godkänns (belagd via rader)", () => {
  const x = { ...T04, totalSumSek: 36394 };
  assert.equal(resolveTotals(prep(x)).status, "belagd");
  assert.equal(resolveTotals(prep(x)).source, "rader");
  // D19: resor anges inte (null är inte 0) ⇒ full summering går inte att bedöma; med uttryckligt 0 för resor gäller det gamla beteendet
  assert.equal(by(rules(x), "summa").status, "ej_bedombar");
  const s = by(rules({ ...x, travelSumSek: 0 }), "summa");
  assert.equal(s.status, "ok");
  assert.match(s.text, /efter ROT-avdrag/);
  assert.match(s.text, /det stämmer/);
  assert.equal(by(cmp(x), "projekt").mode, "inom"); // 42 820 / 32 = 1 338 kr/m² före ROT
  // brutto-varianten av samma offert (totalen före ROT) ger samma före-ROT-belopp
  assert.equal(resolveTotals(prep({ ...T04, totalSumSek: 42820 })).beforeRotIncl, 42820);
});

test("T04a: oetiketterad total med ROT och utan rader lovas aldrig som exakt korrigerad eller OK", () => {
  const x = { jobType: "tak", rotAmountSek: 6426, vatMode: "inkl", totalSumSek: 36394, areaM2: 32, priceType: "fast", quoteDate: "2026-09-10" };
  assert.equal(resolveTotals(prep(x)).status, "oklar");
  assert.equal(by(rules(x), "summa"), undefined);
  const p = by(cmp(x), "projekt");
  assert.equal(p.mode, "ej_bedombar");
  assert.match(p.text, /summan före ROT-avdrag/);
  assert.match(p.text, /1\s137 kr per m²/); // tolkning "totalen är före ROT": 36 394 / 32
  assert.match(p.text, /1\s338 kr per m²/); // tolkning "totalen är efter ROT" ger (36 394 + 6 426) / 32
});

test("A1: uttryckliga fält går före gissning; stämmer inte raderna blir det fel mot rätt bas", () => {
  const T = { ...T04, travelSumSek: 0 }; // D19: alla fyra kategorier kända (uttryckligt 0 för resor)
  const ok = rules({ ...T, totalBeforeRotSek: 42820, totalVatBasis: "inkl" });
  assert.equal(by(ok, "summa").status, "ok");
  const bad = rules({ ...T, totalBeforeRotSek: 50000, totalVatBasis: "inkl" });
  assert.equal(by(bad, "summa").status, "fel");
  const pay = rules({ ...T, amountToPaySek: 36394, totalVatBasis: "inkl" });
  assert.equal(by(pay, "summa").status, "ok");
  // explicit summa utan momsbas och med exkl-rader: oklar bas -> fråga, aldrig ok
  const oklar = rules({ ...T, vatMode: "ej_angivet", totalBeforeRotSek: 42820 });
  assert.notEqual(by(oklar, "summa")?.status, "ok");
});

test("A1: sanitize tar bort omöjliga kombinationer (negativt belopp, sträng) utan att räkna med dem", () => {
  const x = prep({ ...T04, totalBeforeRotSek: -5, amountToPaySek: "36394", totalSumSek: 36394 });
  assert.equal(x.totalBeforeRotSek, null);
  assert.equal(x.amountToPaySek, null);
  assert.equal(resolveTotals(x).status, "belagd");
});

test("timpris: oklar momsbas jämförs i båda baserna – samma bedömning redovisas, annars avstår", () => {
  const same = cmp({ trades: ["snickare"], vatMode: "ej_angivet", hourlyRateSek: 600 });
  assert.equal(by(same, "tim_snickare").mode, "inom"); // 600 ligger i både 550–800 (inkl) och 440–640 (exkl)
  assert.match(by(same, "tim_snickare").text, /densamma i båda fallen/);
  const diff = cmp({ trades: ["snickare"], vatMode: "ej_angivet", hourlyRateSek: 500 });
  assert.equal(by(diff, "tim_snickare").mode, "ej_bedombar");
  const hi = cmp({ trades: ["snickare"], vatMode: "okant_moms", hourlyRateSek: 1200 });
  assert.equal(by(hi, "tim_snickare").mode, "over");
});

// ---- F8: P01–P03 och T07/T08 ----
import { checkNormalAddons } from "../src/rules.js";

test("F8/P02: båda tolkningarna ryms i toleransen → oklar, aldrig belagd", () => {
  const x = prep({ vatMode: "inkl", laborSumSek: 10000, materialSumSek: 90000, totalSumSek: 100000, rotAmountSek: 2000 });
  const t = resolveTotals(x);
  assert.equal(t.status, "oklar");
  assert.equal(t.alternatives.length, 2);
  const s = by(rules({ vatMode: "inkl", laborSumSek: 10000, materialSumSek: 90000, travelSumSek: 0, otherSumSek: 0, totalSumSek: 100000, rotAmountSek: 2000 }), "summa");
  assert.equal(s.status, "fraga");
  // entydigt avgörande rader förblir belagda (N15 och F2-04)
  assert.equal(resolveTotals(prep({ vatMode: "exkl", laborSumSek: 10000, materialSumSek: 2000, totalSumSek: 15000, rotAmountSek: 3750, totalVatBasis: "inkl" })).status, "belagd");
});

test("F8/P03: uttrycklig betalningskonflikt göms inte bakom före-ROT-fältet", () => {
  const o = { vatMode: "inkl", laborSumSek: 10000, materialSumSek: 2000, totalBeforeRotSek: 12000, amountToPaySek: 50000, totalVatBasis: "inkl", rotAmountSek: 3000 };
  const t = resolveTotals(prep(o));
  assert.equal(t.status, "oklar");
  assert.equal(t.conflict, true);
  const c = by(rules(o), "total_konflikt");
  assert.equal(c.status, "fel");
  assert.match(c.text, /12\s000 kr/);
  assert.match(c.text, /50\s000 kr/);
  assert.match(c.text, /9\s000 kr/); // 12 000 − 3 000
  // konsekventa uppgifter ger ingen konflikt
  const ok = { ...o, amountToPaySek: 9000 };
  assert.equal(resolveTotals(prep(ok)).status, "belagd");
  assert.equal(by(rules(ok), "total_konflikt"), undefined);
  // utan ROT: före och att betala ska vara lika
  assert.equal(resolveTotals(prep({ vatMode: "inkl", totalBeforeRotSek: 12000, amountToPaySek: 20000, totalVatBasis: "inkl" })).conflict, true);
});

test("F8/T07-T08: framkörningssumma för flera besök jämförs per besök, aldrig som en enda resa", () => {
  const REFX = REF;
  // reproducerat fel före rättning: 8 besök × 450 kr = 3 600 kr gav "flagga"
  const withVisits = checkNormalAddons(prep({ travelSumSek: 3600, travelVisits: 8 }), REFX);
  assert.equal(withVisits[0].status, "ok");
  assert.match(withVisits[0].text, /8 besök/);
  assert.match(withVisits[0].text, /450 kr per besök/);
  // antal besök okänt och summan över per-besöksspannet: fråga, inget prisfynd
  const unknown = checkNormalAddons(prep({ travelSumSek: 3600 }), REFX);
  assert.equal(unknown[0].status, "fraga");
  assert.match(unknown[0].text, /antal besök/);
  // verkligt avvikande per besök flaggas fortfarande
  assert.equal(checkNormalAddons(prep({ travelSumSek: 12000, travelVisits: 8 }), REFX)[0].status, "flagga");
  // F8c/T08: belopp inom spannet men okänt antal besök är fråga, inte OK på hypotesen "ett besök"
  const inSpan = checkNormalAddons(prep({ travelSumSek: 450 }), REFX);
  assert.equal(inSpan[0].status, "fraga");
  assert.match(inSpan[0].text, /antal besök/);
  // ett besök
  assert.equal(checkNormalAddons(prep({ travelSumSek: 450, travelVisits: 1 }), REFX)[0].status, "ok");
  // ogiltigt antal besök avvisas av saneringen
  assert.equal(prep({ travelSumSek: 3600, travelVisits: 0.5 }).travelVisits, null);
});

test("F8/P04: explicit netto utan angivet ROT-belopp ometiketteras inte som före ROT; avvikande rader ger fråga", () => {
  const o = { vatMode: "inkl", laborSumSek: 40000, materialSumSek: 20000, amountToPaySek: 48000, totalVatBasis: "inkl", rotAmountSek: null };
  const t = resolveTotals(prep(o));
  assert.equal(t.status, "oklar");
  assert.equal(t.reason, "avdrag_okant");
  assert.equal(t.toPayIncl, 48000);
  assert.equal(t.alternatives.length, 2);
  const s = by(rules({ ...o, travelSumSek: 0, otherSumSek: 0 }), "summa"); // D19: alla fyra kategorier kända
  assert.equal(s.status, "fraga");
  assert.doesNotMatch(s.text, /totalen anges till 48\s000 kr före ROT/);
  assert.match(s.text, /12\s000 kr/);
  // netto och rader stämmer: belagt som tidigare
  assert.equal(resolveTotals(prep({ ...o, amountToPaySek: 60000 })).status, "belagd");
  // uttryckligt noll-ROT eller utan rader ändrar inte tidigare beteende
  assert.equal(resolveTotals(prep({ ...o, rotAmountSek: 0 })).status, "belagd");
  assert.equal(resolveTotals(prep({ vatMode: "inkl", amountToPaySek: 48000, totalVatBasis: "inkl" })).status, "belagd");
  // N14 (nettot med ROT och rader) förblir belagt före 15 000
  const n14 = resolveTotals(prep({ vatMode: "exkl", laborSumSek: 10000, materialSumSek: 2000, totalVatBasis: "inkl", totalIncludesVat: true, rotAmountSek: 3750, amountToPaySek: 11250 }));
  assert.deepEqual([n14.status, n14.beforeRotIncl, n14.toPayIncl], ["belagd", 15000, 11250]);
});
