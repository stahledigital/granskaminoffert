// D19 CP2-QA-rättelser (Codex 2026-10-16 23:39): precision utan toFixed, gemensam ROT-period, S09 och HP07.
// Förväntade värden är handskrivna literaler (exakta decimaltal), aldrig återberäknade ur produktkoden.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runRules } from "../src/rules.js";
import { sanitizeExtracted } from "../src/sanitize.js";

const REF = JSON.parse(readFileSync(new URL("../src/reference.json", import.meta.url), "utf8"));
const BASE = { vatMode: "inkl", totalVatBasis: "inkl", priceType: "fast", customerType: "privatperson", plannedPaymentDate: "2026-10-16" };
const run = (o, base = BASE) => runRules(sanitizeExtracted({ ...base, ...o }).x, REF);
const norm = (c) => (c ? { ...c, text: c.text.replace(/\u00a0/g, " ") } : c);   // hårda mellanslag (tusentalsavgränsare) normaliseras bara för mönstren
const get = (r, id) => norm(r.find((c) => c.id === id));
const HP = { jobType: "bergvarme", propertyType: "smahus", totalContract: "ja" };

test("CP2-2 HP: total 200000,054 och yrkat 21000,0055 är inte fel (exakt tak 21000,00567) – ingen toFixed(2)-rundning", () => {
  const r = get(run({ ...HP, totalBeforeRotSek: 200000.054, rotAmountSek: 21000.0055 }), "rot_schablon");
  assert.notEqual(r.status, "fel");
  assert.equal(r.status, "fraga");
  assert.match(r.text, /200 000,054 kr/);
  assert.match(r.text, /21 000,00567 kr/);        // 200000,054 × 0,35 × 0,3 exakt
  assert.match(r.text, /ryms under någon räkning men inte alla/);
});

test("CP2-2 HP: yrkat strax över exakt tak är fel även vid många decimaler (ingen avrundning som döljer det)", () => {
  const r = get(run({ ...HP, totalBeforeRotSek: 200000.054, rotAmountSek: 21000.0057 }), "rot_schablon");
  assert.equal(r.status, "fel");
  assert.match(r.text, /21 000,0057 kr/);
});

test("CP2-2 summering: 30000 mot 30001,004 är aldrig OK (skillnaden 1,004 kr är över 1 kr)", () => {
  const r = get(run({ laborSumSek: 30000, materialSumSek: 0, travelSumSek: 0, otherSumSek: 0, totalBeforeRotSek: 30001.004 }), "summa");
  assert.notEqual(r.status, "ok");
  assert.equal(r.status, "fel");
  assert.match(r.text, /30 001,004 kr/);
  assert.match(r.text, /1,004 kr/);
});

test("CP2-2 summering: exakt 1 kr skillnad är fortfarande öresavrundning av momsrader, 1,001 kr är det inte", () => {
  const z = { laborSumSek: 30000, materialSumSek: 0, travelSumSek: 0, otherSumSek: 0 };
  assert.equal(get(run({ ...z, totalBeforeRotSek: 30001 }), "summa").status, "ok");
  assert.equal(get(run({ ...z, totalBeforeRotSek: 30001.001 }), "summa").status, "fel");
});

test("CP2-2 ROT-tak: 50000,01 visas som 50 000,01 kr, 0,01 kr över – både med en person och utan personantal", () => {
  const one = get(run({ laborSumSek: 200000, rotAmountSek: 50000.01, rotPersons: 1 }), "rot_tak");
  assert.equal(one.status, "fel");
  assert.match(one.text, /50 000 kr/);
  assert.match(one.text, /50 000,01 kr/);
  assert.match(one.text, /0,01 kr över/);
  const none = get(run({ laborSumSek: 200000, rotAmountSek: 50000.01 }), "rot_tak");
  assert.equal(none.status, "fraga");
  assert.match(none.text, /50 000,01 kr/);
  assert.match(none.text, /minst 2 personer/);
  // exakt taket är inte över taket; två personer rymmer 50000,01
  assert.equal(get(run({ laborSumSek: 200000, rotAmountSek: 50000 }), "rot_tak"), undefined);
  assert.equal(get(run({ laborSumSek: 200000, rotAmountSek: 50000.01, rotPersons: 2 }), "rot_tak").status, "flagga");
  assert.equal(get(run({ laborSumSek: 300000, rotAmountSek: 100000.01, rotPersons: 2 }), "rot_tak").status, "fel");
});

test("CP2-2 momsnormalisering med flera decimaler: exkl 100000,003 → 125000,00375 inkl → tak 37500,001125", () => {
  const X = { vatMode: "exkl", totalVatBasis: "exkl", rotPersons: 1 };
  const ok = get(run({ ...X, laborSumSek: 100000.003, rotAmountSek: 37500.001 }), "rot_belopp");
  assert.equal(ok.status, "ok");
  assert.match(ok.text, /37 500,001125 kr/);
  assert.equal(get(run({ ...X, laborSumSek: 100000.003, rotAmountSek: 37500.0012 }), "rot_belopp").status, "fel");
});

test("CP2-2 HP med total angiven exkl moms: omräkning med flera decimaler sker decimalsäkert", () => {
  // 160000,04 exkl → 200000,05 inkl; schablon inkl 200000,05 × 0,105 = 21000,00525
  const r = get(run({ ...HP, vatMode: "exkl", totalVatBasis: "exkl", totalBeforeRotSek: 160000.04, rotAmountSek: 21000.00525 }), "rot_schablon");
  assert.equal(r.status, "fraga");
  assert.match(r.text, /200 000,05 kr/);
  assert.match(r.text, /vilket stämmer med räkningen inklusive moms/);
});

test("CP2-3 gemensam ROT-period: HP bergvärme 2025-12-15, 200000 före ROT, yrkat 35000 (50 % × 35 %) är inte fel", () => {
  const r = get(run({ ...HP, plannedPaymentDate: "2025-12-15", totalBeforeRotSek: 200000, rotAmountSek: 35000 }), "rot_schablon");
  assert.equal(r.status, "fraga");                       // villkorad momsbasfråga kvar, aldrig fel
  assert.match(r.text, /35 000 kr/);
  assert.match(r.text, /50 %/);
  assert.match(r.text, /Skatteverkets sida anger inte vilken momsbas schablonen använder/);
  assert.doesNotMatch(r.text, /30 %/);
});

test("CP2-3 HP efter fönstret: 35000 är över taket 30 % × 35 % × 200000 = 21000 → fel när alla villkor är angivna", () => {
  const r = get(run({ ...HP, plannedPaymentDate: "2026-10-16", totalBeforeRotSek: 200000, rotAmountSek: 35000 }), "rot_schablon");
  assert.equal(r.status, "fel");
});

test("CP2-3 HP utan datum: båda satserna redovisas, 35000 är inte fel men inte heller bekräftat; fråga efter betalningsdatum", () => {
  const r = get(run({ ...HP, plannedPaymentDate: null, quoteDate: null, totalBeforeRotSek: 200000, rotAmountSek: 35000 }), "rot_schablon");
  assert.equal(r.status, "fraga");
  assert.match(r.text, /30 %/); assert.match(r.text, /50 %/);
  assert.match(r.text, /betalningsdatum/);
});

test("CP2-3 materialinferens: arbete 100000 + material 66666,67 + ROT 50000 vid betalning 2025-12-15 (50 %) är inget rot_material-fel", () => {
  const o = { plannedPaymentDate: "2025-12-15", laborSumSek: 100000, materialSumSek: 66666.67, travelSumSek: 0, otherSumSek: 0, rotAmountSek: 50000, rotPersons: 1 };
  assert.equal(get(run(o), "rot_material"), undefined);
  assert.equal(get(run(o), "rot_belopp").status, "ok");
  // utan datum: båda satserna möjliga, arbetskostnaden under 50 % förklarar yrkat belopp ⇒ inget säkert fel
  assert.equal(get(run({ ...o, plannedPaymentDate: null, quoteDate: null }), "rot_material"), undefined);
});

test("CP2-3 materialinferens: efter fönstret (30 %) är beloppet säkert fel; talrelationen ger bara en neutral underlagsfråga (D19-R1-P2); uttryckligt rotOnMaterialOrTravel oförändrat", () => {
  const o = { plannedPaymentDate: "2026-10-16", laborSumSek: 100000, materialSumSek: 66666.67, travelSumSek: 0, otherSumSek: 0, rotAmountSek: 50000, rotPersons: 1 };
  assert.equal(get(run(o), "rot_belopp").status, "fel");
  assert.equal(get(run(o), "rot_material").status, "fraga");   // D19-R1-P2: var "fel" t.o.m. ecfd5fc – en talrelation är inget belägg
  assert.equal(get(run({ ...o, rotAmountSek: 30000, rotOnMaterialOrTravel: true }), "rot_material").status, "fel");
});

test("CP2-5 S09: okänd radmoms ger ingen säker differens och inget påstående om saknade poster", () => {
  const r = get(run({ vatMode: "okant_moms", totalVatBasis: "inkl", laborSumSek: 30000, materialSumSek: 0, otherSumSek: 4000, travelSumSek: null, totalBeforeRotSek: 42500 }), "summa") || norm(run({ vatMode: "okant_moms", totalVatBasis: "inkl", laborSumSek: 30000, materialSumSek: 0, otherSumSek: 4000, travelSumSek: null, totalBeforeRotSek: 42500 }).find((c) => c.title === "Summering"));
  assert.ok(r, "summeringsraden finns");
  assert.doesNotMatch(r.text, /8 500/);
  assert.doesNotMatch(r.text, /vilket kan vara de poster som inte anges/);
  assert.match(r.text, /34 000 kr/);
  assert.match(r.text, /42 500 kr/);
  assert.match(r.text, /Radernas momsläge anges inte/);
  assert.match(r.text, /42 500 kr inklusive moms \(25 % moms\)/);   // exkl-rader 34000 × 1,25 = 42500
  assert.match(r.text, /Fråga om radernas momsläge/);
});

test("CP2-5 S09: belagd radmoms behåller differensförklaringen (oförändrat)", () => {
  const r = norm(run({ laborSumSek: 30000, materialSumSek: 0, otherSumSek: 4000, travelSumSek: null, totalBeforeRotSek: 42500 }).find((c) => c.title === "Summering"));
  assert.match(r.text, /Totalen är 8 500 kr högre/);
});

test("CP2-6 HP07: okänd totalmoms behåller BÅDA osäkerheterna (200000/250000 och källans momsbas) utan falsk maxgaranti", () => {
  const r = get(run({ ...HP, vatMode: "ej_angivet", totalVatBasis: null, totalBeforeRotSek: 200000, rotAmountSek: 21000 }), "rot_schablon");
  assert.equal(r.status, "fraga");
  assert.match(r.text, /summan före ROT-avdrag är inklusive moms/);
  assert.match(r.text, /summan före ROT-avdrag är exklusive moms/);
  assert.match(r.text, /21 000 kr om schablonen räknas på pris inklusive moms/);
  assert.match(r.text, /16 800 kr om den räknas exklusive moms/);          // 200000 × 0,8 × 0,105
  assert.match(r.text, /26 250 kr om schablonen räknas på pris inklusive moms/);
  assert.match(r.text, /21 000 kr om den räknas exklusive moms/);          // 250000 × 0,8 × 0,105
  assert.match(r.text, /Skatteverkets sida anger inte vilken momsbas schablonen använder/);
  assert.doesNotMatch(r.text, /högst 21 000 kr|garanterat/);
});

test("CP2-3b offertdatum är kontext, inte betalningsdatum: HP och materialinferens med offert 2026 utan betalningsdatum förblir villkorliga", () => {
  const hp = get(run({ ...HP, plannedPaymentDate: null, quoteDate: "2026-10-16", totalBeforeRotSek: 200000, rotAmountSek: 35000 }), "rot_schablon");
  assert.equal(hp.status, "fraga");                    // inte säkert fel (30 %-taket 21000) – 50 %-räkningen 35000 är möjlig
  assert.match(hp.text, /Ett offertdatum visar inte betalningsdatum/);
  const o = { quoteDate: "2026-10-16", plannedPaymentDate: null, laborSumSek: 100000, materialSumSek: 66666.67, travelSumSek: 0, otherSumSek: 0, rotAmountSek: 50000, rotPersons: 1 };
  assert.equal(get(run(o), "rot_material"), undefined);
  assert.equal(get(run(o), "rot_belopp").status, "fraga");
  // explicit betalning efter fönstret styr fortfarande: samma belopp är då säkert fel
  assert.equal(get(run({ ...o, plannedPaymentDate: "2026-10-20" }), "rot_belopp").status, "fel");
  assert.equal(get(run({ ...o, plannedPaymentDate: "2025-12-15", quoteDate: "2026-10-16" }), "rot_belopp").status, "ok");   // QD04: explicit betalning styr
});

test("CP3-P2 materialinferens: ett lägre avdrag som ryms under möjlig arbetsgräns anklagar aldrig material (likhet med procent av hela summan räcker inte)", () => {
  const o = { laborSumSek: 100000, materialSumSek: 20000, travelSumSek: 0, otherSumSek: 0, rotAmountSek: 36000, rotPersons: 1, plannedPaymentDate: null, quoteDate: "2026-10-16" };
  const r = run(o, { vatMode: "inkl", priceType: "fast" });
  assert.equal(get(r, "rot_belopp").status, "fraga");                         // 30 000/50 000 möjliga, 36 000 ryms under den högsta
  assert.equal(get(r, "rot_material"), undefined, "36 000 kan vara ett legitimt lägre avdrag under 50 %-gränsen 50 000");
  // samma belopp med uttryckligt betalningsdatum i 50 %-fönstret: ok, inget materialfel
  const w = run({ ...o, plannedPaymentDate: "2025-12-15" }, { vatMode: "inkl", priceType: "fast" });
  assert.equal(get(w, "rot_belopp").status, "ok"); assert.equal(get(w, "rot_material"), undefined);
  // uttryckligt betalningsdatum efter fönstret: 36 000 är över max 30 000 ⇒ beloppsfelet består; likheten med 30 % av hela summan ger bara en underlagsfråga (D19-R1-P2)
  const e = run({ ...o, plannedPaymentDate: "2026-10-20" }, { vatMode: "inkl", priceType: "fast" });
  assert.equal(get(e, "rot_belopp").status, "fel"); assert.equal(get(e, "rot_material").status, "fraga");   // D19-R1-P2: var "fel"
  // uttryckligt belagt material/resa = true upptäcks fortfarande, även under maxgränsen och med okänt datum
  const x = run({ ...o, rotOnMaterialOrTravel: true }, { vatMode: "inkl", priceType: "fast" });
  assert.equal(get(x, "rot_material").status, "fel");
  // verkligt över även den högsta möjliga arbetsgränsen: beloppsfel kvarstår vid okänt datum; materialorsak säker bara med uttryckligt belägg (D19-R1-P2)
  const ov = run({ ...o, rotAmountSek: 60000, laborSumSek: 100000, materialSumSek: 100000 }, { vatMode: "inkl", priceType: "fast" });   // 30 % av 200 000 = 60 000 > 50 000
  assert.equal(get(ov, "rot_belopp").status, "fel"); assert.equal(get(ov, "rot_material").status, "fraga");   // D19-R1-P2: var "fel"
  assert.equal(get(run({ ...o, rotAmountSek: 60000, laborSumSek: 100000, materialSumSek: 100000, rotOnMaterialOrTravel: true }, { vatMode: "inkl", priceType: "fast" }), "rot_material").status, "fel");
});
