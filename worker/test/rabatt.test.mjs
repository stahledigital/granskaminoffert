// GMO-RABATT (2026-10-23): rabatt som egen avdragsrad. Före rättningen saknade avläsningen ett rabattfält och en korrekt offert med
// rabatt fick "Summering: fel" (rött besked "Avvikelse som behöver förklaras"). Alla offerter här är syntetiska. Förväntade belopp är
// handräknade literaler, aldrig återberäknade ur produktkoden.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runRules, findForbidden } from "../src/rules.js";
import { sanitizeExtracted } from "../src/sanitize.js";
import { EXTRACTED_SCHEMA } from "../src/extracted_schema.js";
import { buildPriceReport } from "../src/index.js";
import { compareOffers, offerLabels } from "../src/compare_engine.js";
import { sanitizeOffer } from "../src/compare_extract.js";
import { fixtureResponse } from "./helpers/compare_env.mjs";

const REF = JSON.parse(readFileSync(new URL("../src/reference.json", import.meta.url), "utf8"));
const NB = /[  ]/g;
// Radbelopp exklusive moms, total inklusive moms (vanligast i svenska offerter). Betalningsdatum 2026 → ROT 30 %.
const BASE = { jobType: "annat", vatMode: "exkl", totalVatBasis: "inkl", priceType: "fast", customerType: "privatperson",
  propertyType: "smahus", quoteDate: "2026-10-01", plannedPaymentDate: "2026-11-30", workNature: "ombyggnad", workLocation: "invandigt" };
const run = (o) => runRules(sanitizeExtracted({ ...BASE, ...o }).x, REF);
const get = (r, id) => r.find((c) => c.id === id);
const txt = (c) => (c ? c.text.replace(NB, " ") : "");
const statuses = (r) => r.map((c) => `${c.id}:${c.status}`);

// A: arbete 40 000 + material 25 000 + framkörning 2 000 + container 3 000 = 70 000 exkl; "Rabatt 10 %" −7 000; 63 000 exkl; moms 15 750; totalt 78 750 inkl.
const A = { laborSumSek: 40000, materialSumSek: 25000, travelSumSek: 2000, otherSumSek: 3000, totalSumSek: 78750 };
const A_DISC = { discountSek: 7000, discountPct: 10, discountBase: "hela", discountStage: "fore_moms" };

test("före rättningen (ingen rabatt avläst) är A fortfarande fel – beteendet utan rabattfält är oförändrat", () => {
  const s = get(run(A), "summa");
  assert.equal(s.status, "fel");
  assert.match(txt(s), /87 500 kr inklusive moms, men totalen anges till 78 750 kr före ROT-avdrag – en skillnad på 8 750 kr/);
});

test("rabatt 10 % på hela offerten före moms: summeringen stämmer", () => {
  const r = run({ ...A, ...A_DISC });
  const s = get(r, "summa");
  assert.equal(s.status, "ok", txt(s));
  assert.match(txt(s), /summerar till 87 500 kr inklusive moms\. Efter rabatten 10 % på hela beloppet \(7 000 kr exklusive moms, 8 750 kr inklusive moms\) blir det 78 750 kr, vilket stämmer med totalen\./);
  assert.ok(!r.some((c) => c.status === "fel"), statuses(r).join(" "));
  assert.equal(get(r, "rabatt"), undefined, "10 % av 70 000 är 7 000: ingen fråga om procentsatsen");
});

test("rabatt −5 000 kr (fast belopp) i en offert med alla belopp inklusive moms: summeringen stämmer", () => {
  const r = run({ vatMode: "inkl", laborSumSek: 50000, materialSumSek: 30000, travelSumSek: 1000, otherSumSek: 0, totalSumSek: 76000, discountSek: 5000 });
  const s = get(r, "summa");
  assert.equal(s.status, "ok", txt(s));
  assert.match(txt(s), /summerar till 81 000 kr\. Efter rabatten 5 000 kr blir det 76 000 kr, vilket stämmer med totalen\./);
});

test("avläst minustecken ('Rabatt −5 000 kr' → -5000) läses som rabattbeloppet, utan avläsningslucka", () => {
  const { x, issues } = sanitizeExtracted({ ...BASE, discountSek: -5000, discountPct: -10 });
  assert.equal(x.discountSek, 5000);
  assert.equal(x.discountPct, 10);
  assert.deepEqual(issues, []);
});

test("rabatt efter ROT: summering ok, ingen falsk totalkonflikt, men en fråga om ROT-underlaget", () => {
  // Rader inkl: 40 000 + 20 000 + 1 000 + 0 = 61 000 före ROT; ROT 30 % av 40 000 = 12 000; 49 000; rabatt −2 000; att betala 47 000.
  const o = { vatMode: "inkl", laborSumSek: 40000, materialSumSek: 20000, travelSumSek: 1000, otherSumSek: 0, totalBeforeRotSek: 61000,
    rotAmountSek: 12000, rotRatePct: 30, amountToPaySek: 47000, discountSek: 2000, discountStage: "efter_rot" };
  const r = run(o);
  assert.equal(get(r, "total_konflikt"), undefined, statuses(r).join(" "));
  const s = get(r, "summa");
  assert.equal(s.status, "ok", txt(s));
  assert.match(txt(s), /Efter ROT-avdrag 12 000 kr och rabatten 2 000 kr blir det 47 000 kr att betala – det stämmer\./);
  const q = get(r, "rabatt_rot");
  assert.equal(q.status, "fraga");
  assert.match(txt(q), /Rabatten 2 000 kr dras av efter ROT-avdraget/);
  // Utan avläst steg (null) förklarar rabatten också skillnaden mellan de två uttryckliga summorna.
  const r2 = run({ ...o, discountStage: null });
  assert.equal(get(r2, "total_konflikt"), undefined);
  assert.equal(get(r2, "summa").status, "ok");
  assert.equal(get(r2, "rabatt_rot").status, "fraga");
});

test("fel summa att betala trots rabatt efter ROT är fortfarande en totalkonflikt", () => {
  const r = run({ vatMode: "inkl", laborSumSek: 40000, materialSumSek: 20000, travelSumSek: 1000, otherSumSek: 0, totalBeforeRotSek: 61000,
    rotAmountSek: 12000, amountToPaySek: 44000, discountSek: 2000, discountStage: "efter_rot" });
  assert.equal(get(r, "total_konflikt").status, "fel");
});

test("rabatt bara på material: summering ok, ingen ROT-fråga", () => {
  // Material 30 000 − 10 % = −3 000; arbete 40 000; resor 1 500; övrigt 2 500 → 71 000 exkl; 88 750 inkl.
  const r = run({ laborSumSek: 40000, materialSumSek: 30000, travelSumSek: 1500, otherSumSek: 2500, totalSumSek: 88750,
    rotAmountSek: 12000, discountSek: 3000, discountPct: 10, discountBase: "material", discountStage: "fore_moms" });
  const s = get(r, "summa");
  assert.equal(s.status, "ok", txt(s));
  assert.match(txt(s), /Efter rabatten 10 % på materialet \(3 000 kr exklusive moms, 3 750 kr inklusive moms\) blir det 88 750 kr/);
  assert.equal(get(r, "rabatt_rot"), undefined);
  assert.equal(get(r, "rabatt"), undefined);
});

// Materialräknaren PRO kundoffert: "Material: 48 000 kr exklusive moms", "Arbetskostnad: 36 000 kr exklusive moms", Frakt 1 500 kr, Resa 900 kr,
// "Rabatt: -4 200 kr" (kundrabatt 5 % på material och arbete), "Summa: 82 200 kr exklusive moms", "Moms 25 procent: 20 550 kr",
// "Summa inklusive moms: 102 750 kr", "Preliminärt ROT-avdrag, 30 procent: 12 825 kr" (30 % av (36 000 − 1 800) × 1,25),
// "Preliminärt belopp att betala efter avdrag: 89 925 kr". Procentsatsen står inte i kund-PDF:en.
const MR = { laborSumSek: 36000, materialSumSek: 48000, travelSumSek: 900, otherSumSek: 1500, totalSumSek: 102750,
  rotAmountSek: 12825, rotRatePct: 30, amountToPaySek: 89925, discountSek: -4200 };

test("Materialräknaren PRO kundoffert ('Rabatt: -4 200 kr' före Summa exklusive moms): summering och summa att betala stämmer", () => {
  for (const stage of ["fore_moms", null]) {
    const r = run({ ...MR, discountStage: stage });
    const s = get(r, "summa");
    assert.equal(s.status, "ok", `${stage}: ${txt(s)}`);
    assert.match(txt(s), /Efter rabatten 4 200 kr exklusive moms \(5 250 kr inklusive moms\) blir det 102 750 kr, vilket stämmer med totalen, och efter ROT-avdrag 12 825 kr blir det 89 925 kr att betala – det stämmer\./);
    assert.equal(get(r, "rot_belopp").status, "ok");
    assert.ok(!r.some((c) => c.status === "fel"), statuses(r).join(" "));
  }
});

test("Materialräknaren PRO utan övrigt-rad: delsumman efter rabatten redovisas, aldrig fel och aldrig differensfråga", () => {
  const { otherSumSek, ...rest } = MR;
  const s = get(run({ ...rest, travelSumSek: 2400, discountStage: "fore_moms" }), "summa");
  assert.equal(s.status, "ej_bedombar", txt(s));
  assert.match(txt(s), /efter rabatten 4 200 kr exklusive moms \(5 250 kr inklusive moms\) blir det 102 750 kr, och totalen före ROT-avdrag är 102 750 kr/);
  // Utan rabattfältet blev samma offert en differensfråga ("minst 5 250 kr mer än totalen").
  const before = get(run({ ...rest, travelSumSek: 2400, discountSek: null }), "summa");
  assert.equal(before.status, "fraga");
});

test("REGRESSION: fel total trots rabatt flaggas fortfarande som fel, med rätt skillnad", () => {
  const r = run({ ...A, ...A_DISC, totalSumSek: 79750 });
  const s = get(r, "summa");
  assert.equal(s.status, "fel");
  assert.match(txt(s), /efter rabatten 10 % på hela beloppet \(7 000 kr exklusive moms, 8 750 kr inklusive moms\) blir det 78 750 kr, men totalen anges till 79 750 kr före ROT-avdrag – en skillnad på 1 000 kr\. Alla fyra posterna \(arbete, material, resor och övrigt\) och rabatten anges i offerten\./);
  // Även när rabattens momsbas är okänd (steg saknas) är ingen tolkning rätt: fel.
  const s2 = get(run({ ...A, discountSek: 7000, totalSumSek: 79750 }), "summa");
  assert.equal(s2.status, "fel", txt(s2));
  assert.match(txt(s2), /vilket inte stämmer under någon av tolkningarna/);
});

test("REGRESSION: fel total med rabatt när totalen är tydligt märkt före ROT", () => {
  const r = run({ vatMode: "inkl", laborSumSek: 50000, materialSumSek: 30000, travelSumSek: 1000, otherSumSek: 0, totalBeforeRotSek: 78000,
    discountSek: 5000, discountStage: "efter_moms" });
  const s = get(r, "summa");
  assert.equal(s.status, "fel");
  assert.match(txt(s), /blir det 76 000 kr, men totalen anges till 78 000 kr före ROT-avdrag – en skillnad på 2 000 kr/);
});

test("rabatten syns inte i totalen (raderna = totalen före rabatt): fråga, varken ok eller fel", () => {
  const s = get(run({ ...A, ...A_DISC, totalSumSek: 87500 }), "summa");
  assert.equal(s.status, "fraga", txt(s));
  assert.match(txt(s), /summerar till totalen 87 500 kr inklusive moms utan att rabatten 10 % på hela beloppet .* dras av\. Antingen syns rabatten inte i totalen, eller så ingår den redan i radbeloppen\./);
});

test("rabattbelopp som inte motsvarar angiven procentsats: summering ok men en fråga om rabatten", () => {
  const r = run({ ...A, totalSumSek: 76250, discountSek: 9000, discountPct: 10, discountBase: "hela", discountStage: "fore_moms" });
  assert.equal(get(r, "summa").status, "ok");
  const q = get(r, "rabatt");
  assert.equal(q.status, "fraga");
  assert.match(txt(q), /både som 10 % och som 9 000 kr, men de hänger inte ihop: 10 % av hela beloppet \(70 000 kr\) är 7 000 kr\./);
});

test("bara procentsats (inget belopp): stämmer den mot raderna är summeringen ok; stämmer den inte är det en fråga, aldrig fel", () => {
  const ok = get(run({ ...A, discountPct: 10, discountBase: "hela" }), "summa");
  assert.equal(ok.status, "ok", txt(ok));
  assert.match(txt(ok), /Efter rabatten 10 % av hela beloppet \(7 000 kr exklusive moms, 8 750 kr inklusive moms\) blir det 78 750 kr/);
  const q = get(run({ ...A, totalSumSek: 79750, discountPct: 10, discountBase: "hela" }), "summa");
  assert.equal(q.status, "fraga", txt(q));
  assert.match(txt(q), /anger rabatten bara i procent \(10 %\)/);
  // Procentsats på ett underlag som inte går att räkna (material saknas): aldrig ett säkert fel.
  const u = get(run({ laborSumSek: 40000, travelSumSek: 2000, otherSumSek: 3000, totalSumSek: 50000, discountPct: 10, discountBase: "material" }), "summa");
  assert.notEqual(u?.status, "fel");
});

test("bara 'att betala' utan ROT: rader minus rabatt = nettot är inget tappat avdrag", () => {
  const r = run({ ...A, totalSumSek: null, amountToPaySek: 78750, ...A_DISC });
  const s = get(r, "summa");
  assert.equal(s.status, "ok", txt(s));
  // Utan rabattfältet tolkades skillnaden som ett möjligt tappat avdrag (två tolkningar, ingen ok).
  assert.notEqual(get(run({ ...A, totalSumSek: null, amountToPaySek: 78750 }), "summa").status, "ok");
});

test("rabatt 0 kr eller 0 % är ingen rabatt: samma utfall som utan fält", () => {
  assert.equal(get(run({ ...A, discountSek: 0, discountPct: 0 }), "summa").status, "fel");
  assert.equal(get(run({ ...A, totalSumSek: 87500, discountSek: 0 }), "summa").status, "ok");
});

test("konsumentens prisrapport: korrekt offert med rabatt har inga fel; fel total med rabatt har ett fel; inga förbjudna ord", () => {
  const good = buildPriceReport({ ...BASE, ...A, ...A_DISC }, []);
  assert.deepEqual(good.checked.filter((c) => c.status === "fel"), []);
  assert.deepEqual(good.readIssues, []);
  const bad = buildPriceReport({ ...BASE, ...A, ...A_DISC, totalSumSek: 79750 }, []);
  assert.deepEqual(bad.checked.filter((c) => c.status === "fel").map((c) => c.title), ["Summering"]);
  for (const rep of [good, bad, buildPriceReport({ ...BASE, ...MR, discountStage: "efter_rot" }, [])]) assert.deepEqual(findForbidden(rep), []);
});

test("schema och sanering: fyra nullbara rabattfält, ogiltiga värden blir null med markerad lucka", () => {
  for (const k of ["discountSek", "discountPct", "discountBase", "discountStage"]) {
    assert.ok(EXTRACTED_SCHEMA.properties[k], k);
    assert.ok(EXTRACTED_SCHEMA.required.includes(k), k);
    assert.ok(JSON.stringify(EXTRACTED_SCHEMA.properties[k].type).includes("null"), k);
  }
  assert.deepEqual(EXTRACTED_SCHEMA.properties.discountBase.enum, ["hela", "material", "arbete", "material_och_arbete", null]);
  assert.deepEqual(EXTRACTED_SCHEMA.properties.discountStage.enum, ["fore_moms", "efter_moms", "efter_rot", null]);
  const { x, issues } = sanitizeExtracted({ vatMode: "inkl", discountSek: "5000", discountPct: 150, discountBase: "allt", discountStage: "senare" });
  assert.deepEqual([x.discountSek, x.discountPct, x.discountBase, x.discountStage], [null, null, null, null]);
  assert.deepEqual(issues.sort(), ["discountBase", "discountPct", "discountSek", "discountStage"]);
  const old = sanitizeExtracted({ vatMode: "inkl" }).x; // äldre sparade svar saknar fälten
  assert.deepEqual([old.discountSek, old.discountPct, old.discountBase, old.discountStage], [null, null, null, null]);
});

test("båda avläsningsprompterna beskriver rabattfälten", () => {
  for (const f of ["index.js", "compare_extract.js"]) {
    const src = readFileSync(new URL("../src/" + f, import.meta.url), "utf8");
    assert.match(src, /skrivs i discountSek som positivt belopp/, f);
    assert.match(src, /rabatten läggs aldrig i otherSumSek/, f);
  }
});

test("jämförelsen: delposter minus rabatt mot totalen före ROT ger ingen falsk summaavvikelse", () => {
  const ALL = { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" };
  const offer = (extra) => sanitizeOffer(fixtureResponse({ extracted: { vatMode: "exkl", totalVatBasis: "exkl", priceType: "fast", laborSumSek: 40000, materialSumSek: 25000, totalBeforeRotSek: 58500, ...extra }, scope: ALL }));
  const res = compareOffers([offer({ discountSek: 6500, discountStage: "fore_moms" }), offer({ discountSek: 6500, discountStage: "fore_moms", totalBeforeRotSek: 61000 })], offerLabels([], 2));
  const all = JSON.stringify(res);
  assert.ok(!all.includes("medan totalen är 58500 kr"), "A (65 000 − 6 500 = 58 500) stämmer efter rabatten");
  assert.match(all, /summerar delposterna efter rabatten till 58500 kr medan totalen är 61000 kr/);
  // Utan rabattfältet avviker även A (65 000 mot 58 500).
  const old = JSON.stringify(compareOffers([offer({}), offer({ totalBeforeRotSek: 61000 })], offerLabels([], 2)));
  assert.match(old, /summerar delposterna till 65000 kr medan totalen är 58500 kr/);
});
