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
  // R2: okänt steg – rabatten kan förklara skillnaden men är inte fastställd: fråga (aldrig ok, aldrig fel på en gissning).
  const r2 = run({ ...o, discountStage: null });
  assert.equal(get(r2, "total_konflikt").status, "fraga");
  assert.match(txt(get(r2, "total_konflikt")), /en skillnad på 2 000 kr\. Offerten anger också en rabatt på 2 000 kr som inte går att fastställa helt \(det framgår inte i vilket steg den dras\)/);
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

test("Materialräknaren PRO kundoffert ('Rabatt: -4 200 kr' före Summa exklusive moms): summering och summa att betala stämmer; ROT-gränsen efter rabatt är en fråga", () => {
  const r = run({ ...MR, discountStage: "fore_moms" });
  const s = get(r, "summa");
  assert.equal(s.status, "ok", txt(s));
  assert.match(txt(s), /Efter rabatten 4 200 kr exklusive moms \(5 250 kr inklusive moms\) blir det 102 750 kr, vilket stämmer med totalen, och efter ROT-avdrag 12 825 kr blir det 89 925 kr att betala – det stämmer\./);
  // Kund-PDF:en visar inte hur rabatten fördelas mellan arbete och material: ROT-gränsen efter rabatt kan inte bekräftas (R1 P1-3).
  const rb = get(r, "rot_belopp");
  assert.equal(rb.status, "fraga", txt(rb));
  // Kund-PDF:en anger inte rabattens underlag, så proportionen räknas på alla rader (86 400): 12 844 kr. (MR fördelar på material och arbete: 12 825.)
  assert.match(txt(rb), /Rabatten 4 200 kr exklusive moms \(5 250 kr inklusive moms\) sänker också arbetskostnaden/);
  assert.match(txt(rb), /13 500 kr utan rabatt på arbetet och 11 925 kr om hela rabatten dras från arbetet; fördelas rabatten i proportion blir den 12 844 kr\. Offerten anger 12 825 kr, vilket ryms under den proportionella gränsen\./);
  assert.ok(!r.some((c) => c.status === "fel"), statuses(r).join(" "));
  // Steget oläst: rabattens momsbas framgår inte (exkl. eller inkl.), så summeringen är en fråga – aldrig ok, aldrig ett påstått momsläge.
  const s2 = get(run({ ...MR, discountStage: null }), "summa");
  assert.equal(s2.status, "fraga", txt(s2));
  assert.match(txt(s2), /anger inte om rabatten 4 200 kr är inklusive eller exklusive moms/);
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
  // R2: steg saknas → rabatten är inte fastställd → fråga med det som saknas, aldrig fel.
  const s2 = get(run({ ...A, discountSek: 7000, totalSumSek: 79750 }), "summa");
  assert.equal(s2.status, "fraga", txt(s2));
  assert.match(txt(s2), /vilket inte stämmer under någon av tolkningarna\. .*Rabatten går inte att fastställa helt \(det framgår inte om beloppet är inklusive eller exklusive moms; det framgår inte i vilket steg den dras\)/);
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

test("bara procentsats (inget belopp): stämmer den mot raderna är summeringen ok; stämmer den inte är det en fråga (R2: aldrig fel utan belopp i kr)", () => {
  const ok = get(run({ ...A, discountPct: 10, discountBase: "hela" }), "summa");
  assert.equal(ok.status, "ok", txt(ok));
  assert.match(txt(ok), /Efter rabatten 10 % av hela beloppet \(7 000 kr exklusive moms, 8 750 kr inklusive moms\) blir det 78 750 kr/);
  const q = get(run({ ...A, totalSumSek: 79750, discountPct: 10, discountBase: "hela" }), "summa");
  assert.equal(q.status, "fraga", txt(q));
  assert.match(txt(q), /blir det 78 750 kr, men totalen anges till 79 750 kr före ROT-avdrag – en skillnad på 1 000 kr\..*beloppet i kronor anges inte/);
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

// ---- Granskning R1 (oberoende, 2026-10-23): varje motexempel som regressionstest. Basofferten: arbete 40 000, material 25 000,
// resor 2 000, övrigt 3 000 exklusive moms; total inklusive moms. Main gav fel på alla P1-fallen; grenen får aldrig ge grönt.
const R = { laborSumSek: 40000, materialSumSek: 25000, travelSumSek: 2000, otherSumSek: 3000 };
const noFelButNotOk = (r, id) => { const c = get(r, id); assert.ok(c && c.status !== "ok", `${id}: ${c && c.status} ${txt(c)}`); return c; };

test("R1 P1-1 / R2 P2-2: procentsats utan underlag räknas bara på hela beloppet, och utan belopp i kr blir en avvikelse en fråga, aldrig ok", () => {
  for (const total of [82500, 84375]) {
    const s = get(run({ ...R, totalSumSek: total, discountPct: 10 }), "summa");
    assert.equal(s.status, "fraga", `${total}: ${txt(s)}`);
    assert.match(txt(s), /rabatten 10 % \(om den gäller hela beloppet: 7 000 kr exklusive moms, 8 750 kr inklusive moms\) blir det 78 750 kr/);
  }
});

test("R1 P1-1: belopp 2 500 kr med 10 % och inget underlag ger en fråga om rabatten (10 % av hela beloppet är 7 000 kr)", () => {
  const r = run({ ...R, totalSumSek: 84375, discountSek: 2500, discountPct: 10, discountStage: "fore_moms" });
  const q = get(r, "rabatt");
  assert.equal(q.status, "fraga");
  assert.match(txt(q), /både som 10 % och som 2 500 kr, men de hänger inte ihop: 10 % av hela beloppet \(70 000 kr\) är 7 000 kr\./);
});

test("R1 P1-2: rabattbelopp utan steg med två momstolkningar ger aldrig ok och påstår aldrig en momsbas", () => {
  // 7 000 (exkl.) dragen från summan inkl. moms: 87 500 − 7 000 = 80 500. Rätt vore 78 750.
  const s = noFelButNotOk(run({ ...R, totalSumSek: 80500, discountSek: 7000 }), "summa");
  assert.equal(s.status, "fraga");
  assert.doesNotMatch(txt(s), /7 000 kr inklusive moms/);
  assert.match(txt(s), /anger inte om rabatten 7 000 kr är inklusive eller exklusive moms: är den exklusive moms blir det 78 750 kr, är den inklusive moms blir det 80 500 kr/);
  // Med 10 % på hela beloppet är 7 000 kr exakt 10 % av raderna exklusive moms (momsbasen belagd), men steget saknas: fråga (R2).
  const s2 = get(run({ ...R, totalSumSek: 80500, discountSek: 7000, discountPct: 10, discountBase: "hela" }), "summa");
  assert.equal(s2.status, "fraga", txt(s2));
  assert.match(txt(s2), /blir det 78 750 kr, men totalen anges till 80 500 kr före ROT-avdrag – en skillnad på 1 750 kr\..*\(det framgår inte i vilket steg den dras\)/);
  // Med steget angivet är rabatten fastställd: fel.
  assert.equal(get(run({ ...R, totalSumSek: 80500, discountSek: 7000, discountPct: 10, discountBase: "hela", discountStage: "fore_moms" }), "summa").status, "fel");
});

test("R1 P1-3: ROT räknat på arbetskostnaden före rabatt blir aldrig ok", () => {
  // Materialräknarens layout, rabatt 5 % på material och arbete, ROT 13 500 = 30 % av orabatterat arbete. Rätt (proportionellt) 12 825.
  const base = { laborSumSek: 36000, materialSumSek: 48000, travelSumSek: 900, otherSumSek: 1500, totalSumSek: 102750, rotRatePct: 30 };
  const r = run({ ...base, rotAmountSek: 13500, amountToPaySek: 89250, discountSek: 4200, discountPct: 5, discountBase: "material_och_arbete", discountStage: "fore_moms" });
  const rb = get(r, "rot_belopp");
  assert.equal(rb.status, "fraga", txt(rb));
  assert.match(txt(rb), /fördelas rabatten i proportion blir den 12 825 kr\. Offerten anger 13 500 kr, vilket är högre än den proportionella gränsen\./);
  // Rabatt bara på arbetet (10 % = 3 600): gränsen är exakt 30 % av (36 000 − 3 600) × 1,25 = 12 150 → 13 500 är fel.
  const r2 = run({ ...base, totalSumSek: 103500, rotAmountSek: 13500, amountToPaySek: 90000, discountSek: 3600, discountPct: 10, discountBase: "arbete", discountStage: "fore_moms" });
  const rb2 = get(r2, "rot_belopp");
  assert.equal(rb2.status, "fel", txt(rb2));
  assert.match(txt(rb2), /högst 30 % av arbetskostnaden efter rabatten 32 400 kr exklusive moms \(40 500 kr inklusive moms\), alltså högst 12 150 kr\. Offerten anger 13 500 kr/);
  // Rätt räknat på rabatterat arbete (12 150) är ok.
  const r3 = run({ ...base, totalSumSek: 103500, rotAmountSek: 12150, amountToPaySek: 91350, discountSek: 3600, discountPct: 10, discountBase: "arbete", discountStage: "fore_moms" });
  assert.equal(get(r3, "rot_belopp").status, "ok", txt(get(r3, "rot_belopp")));
  // Rabatt bara på materialet påverkar inte ROT-gränsen.
  const r4 = run({ ...R, materialSumSek: 30000, travelSumSek: 1500, otherSumSek: 2500, totalBeforeRotSek: 88750, amountToPaySek: 73750, rotAmountSek: 15000, discountSek: 3000, discountBase: "material", discountStage: "fore_moms" });
  assert.equal(get(r4, "rot_belopp").status, "ok");
});

test("R1 P2(1) / R2: okänt steg ger aldrig ok på en totalkonflikt; kan rabatten förklara den är det en fråga, annars fel", () => {
  for (const extra of [{ materialSumSek: null }, { materialSumSek: 45000, travelSumSek: 0, otherSumSek: 0 }]) {
    const base = { vatMode: "inkl", laborSumSek: 60000, totalBeforeRotSek: 100000, rotAmountSek: 18000, discountSek: 5000, ...extra };
    assert.equal(get(run({ ...base, amountToPaySek: 77000 }), "total_konflikt").status, "fraga"); // skillnaden 5 000 = rabatten
    assert.equal(get(run({ ...base, amountToPaySek: 75000 }), "total_konflikt").status, "fel");   // 7 000 kan inte förklaras av 5 000
  }
  // Även med uttryckligt steg efter ROT måste rabatten stämma på kronan: 78 400 mot 77 000 är en konflikt.
  const r2 = run({ vatMode: "inkl", laborSumSek: 60000, materialSumSek: 40000, travelSumSek: 0, otherSumSek: 0, totalBeforeRotSek: 100000, rotAmountSek: 18000, amountToPaySek: 78400, discountSek: 5000, discountStage: "efter_rot" });
  assert.equal(get(r2, "total_konflikt").status, "fel");
});

test("R1 P2(2): en uträknad summa att betala visas aldrig som 'det stämmer' när offerten inte anger någon", () => {
  const s = get(run({ vatMode: "inkl", laborSumSek: 40000, materialSumSek: 20000, travelSumSek: 1000, otherSumSek: 0, totalBeforeRotSek: 61000, rotAmountSek: 12000, discountSek: 2000, discountStage: "efter_rot" }), "summa");
  assert.equal(s.status, "ok");
  assert.doesNotMatch(txt(s), /att betala|det stämmer/);
});

test("R1 P2(3) / R3: rabatt lika stor som ROT-avdraget räknas inte med, och summeringen blir då en fråga (aldrig ok); schemat nämner inte 'Avdrag rabatt'", () => {
  const r = run({ vatMode: "inkl", laborSumSek: 40000, materialSumSek: 20000, travelSumSek: 1000, otherSumSek: 0, totalSumSek: 49000, rotAmountSek: 12000, discountSek: 12000 });
  const q = get(r, "rabatt");
  assert.equal(q.status, "fraga");
  assert.match(txt(q), /lika mycket som ROT-avdraget/);
  // R3: raderna 61 000 − ROT 12 000 = 49 000 stämmer, men beloppet som kan vara en egen rabatt är inte avdraget → fråga, inte ok.
  assert.equal(get(r, "summa").status, "fraga");
  assert.match(txt(get(r, "summa")), /som inte har räknats med här, eftersom beloppet är lika stort som ROT-avdraget/);
  assert.doesNotMatch(EXTRACTED_SCHEMA.properties.discountSek.description, /Avdrag rabatt/);
});

test("R1 P2(4): procentrabatt efter ROT utan belopp ger en fråga, inte en totalkonflikt", () => {
  const r = run({ vatMode: "inkl", laborSumSek: 40000, materialSumSek: 20000, travelSumSek: 1000, otherSumSek: 0, totalBeforeRotSek: 61000, rotAmountSek: 12000, amountToPaySek: 44100, discountPct: 10, discountStage: "efter_rot" });
  const k = get(r, "total_konflikt");
  assert.equal(k.status, "fraga");
  assert.match(txt(k), /en skillnad på 4 900 kr\. Offerten anger också en rabatt på 10 % som inte går att fastställa helt \(beloppet i kronor anges inte\)/);
});

test("R1 P3: procentsats som ser ut som en andel (0,1) används inte och ger en fråga", () => {
  const r = run({ ...R, totalSumSek: 78750, discountSek: 7000, discountPct: 0.1, discountBase: "hela", discountStage: "fore_moms" });
  assert.equal(get(r, "summa").status, "ok");
  const q = get(r, "rabatt");
  assert.equal(q.status, "fraga");
  assert.match(txt(q), /lästes som 0,1 %, vilket ser ut som en andel snarare än en procentsats \(10 %\?\)/);
});

test("R1 övriga motexempel: rabatt som inte syns i totalen, en av två rabattrader avläst, rabatt redan i raderna", () => {
  assert.equal(get(run({ ...R, totalSumSek: 87500, discountSek: 7000, discountStage: "fore_moms" }), "summa").status, "fraga");
  assert.equal(get(run({ ...R, totalSumSek: 78750, discountSek: 4000, discountStage: "fore_moms" }), "summa").status, "fel");
  assert.equal(get(run({ ...R, laborSumSek: 36000, totalSumSek: 82500, discountSek: 4000, discountStage: "fore_moms" }), "summa").status, "fraga");
  assert.equal(get(run({ ...R, totalSumSek: 78750, discountSek: 7000, discountStage: "fore_moms" }), "summa").status, "ok"); // två rader summerade
});

// ---- Granskning R2 (andra oberoende granskningen, 2026-10-23). Princip: fel på en rabatterad offert bara när rabatten är fastställd
// för den kontrollerade siffran och ingen tolkning stämmer; allt ofastställt som kan påverka siffran ger fråga; ok bara när exakt en
// helt bestämd tolkning stämmer; ett uträknat belopp beskrivs aldrig som angivet.
const BI = { vatMode: "inkl", totalVatBasis: "inkl" };

test("R2 P1-1a: rabatt på arbetet efter ROT sänker ROT-gränsen exakt (30 % × 30 000 = 9 000)", () => {
  const r = run({ ...BI, laborSumSek: 40000, materialSumSek: 20000, travelSumSek: 0, otherSumSek: 0, discountSek: 10000, discountBase: "arbete",
    discountStage: "efter_rot", rotAmountSek: 12000, totalBeforeRotSek: 60000, amountToPaySek: 38000 });
  const rb = get(r, "rot_belopp");
  assert.equal(rb.status, "fel", txt(rb));
  assert.match(txt(rb), /högst 30 % av arbetskostnaden efter rabatten 30 000 kr inklusive moms, alltså högst 9 000 kr\. Offerten anger 12 000 kr/);
});

test("R2 P1-1b: procentrabatt som inte går att räkna ut (en rad saknas) lämnar aldrig ROT-beloppet grönt", () => {
  const rb = get(run({ ...BI, laborSumSek: 50000, materialSumSek: 30000, travelSumSek: 0, otherSumSek: null, discountPct: 20, discountBase: "hela",
    rotAmountSek: 15000, totalBeforeRotSek: 64000 }), "rot_belopp");
  assert.equal(rb.status, "fraga", txt(rb));
  assert.match(txt(rb), /Rabatten på hela beloppet på 20 % kan också sänka arbetskostnaden, men rabattens belopp går inte att räkna ut/);
});

test("R2 P2-1: rabatt efter moms är inklusive moms även när totalerna anges exklusive moms", () => {
  const o = { vatMode: "exkl", totalVatBasis: "exkl", laborSumSek: 40000, materialSumSek: 20000, travelSumSek: 0, otherSumSek: 0, discountSek: 5000, discountStage: "efter_moms" };
  assert.equal(get(run({ ...o, totalSumSek: 56000 }), "summa").status, "ok");  // 75 000 − 5 000 = 70 000 inkl = 56 000 exkl
  assert.equal(get(run({ ...o, totalSumSek: 55000 }), "summa").status, "fel");
});

test("R2 P2-2: procentsats utan belopp ger aldrig fel på ett antagande", () => {
  const e3 = get(run({ ...BI, laborSumSek: 63000, materialSumSek: 46000, travelSumSek: 0, otherSumSek: 3000, discountPct: 12.5, discountStage: "efter_moms", amountToPaySek: 98375 }), "summa");
  assert.equal(e3.status, "fraga", txt(e3));
  // 10 % efter ROT, omärkt total = att betala 43 200 (korrekt: (60 000 − 12 000) × 0,9).
  const f1 = get(run({ ...BI, laborSumSek: 40000, materialSumSek: 20000, travelSumSek: 0, otherSumSek: 0, rotAmountSek: 12000, discountPct: 10, discountStage: "efter_rot", totalSumSek: 43200 }), "summa");
  assert.equal(f1.status, "fraga", txt(f1));
});

test("R2 P2-3: rabatt efter ROT med tomt ROT-fält räknar inte fram en summa före ROT som om den vore angiven", () => {
  const s = get(run({ ...BI, laborSumSek: 40000, materialSumSek: 20000, travelSumSek: 1000, otherSumSek: 0, discountSek: 2000, discountStage: "efter_rot", amountToPaySek: 47000 }), "summa");
  assert.equal(s.status, "fraga", txt(s));
  assert.doesNotMatch(txt(s), /totalen anges till 49 000 kr/);
  // Utan ROT i offerten och rader − rabatt = att betala: ok.
  assert.equal(get(run({ ...BI, laborSumSek: 40000, materialSumSek: 20000, travelSumSek: 1000, otherSumSek: 0, discountSek: 2000, discountStage: "efter_rot", amountToPaySek: 59000 }), "summa").status, "ok");
});

test("R2 P3: ROT läst som rabatt med tomt ROT-fält, och en äkta rabatt lika stor som ROT, ger fråga (varken ok eller fel)", () => {
  const h2 = run({ ...BI, laborSumSek: 40000, materialSumSek: 20000, travelSumSek: 1000, otherSumSek: 0, discountSek: 12000, amountToPaySek: 49000 });
  assert.equal(get(h2, "summa").status, "fraga");
  assert.equal(get(h2, "rabatt").status, "fraga");
  assert.match(txt(get(h2, "rabatt")), /inget ROT-avdrag har lästs ut/);
  const h1 = get(run({ ...BI, laborSumSek: 50000, materialSumSek: 20000, travelSumSek: 0, otherSumSek: 0, discountSek: 12000, discountBase: "material", discountStage: "efter_moms", rotAmountSek: 12000, totalBeforeRotSek: 58000, amountToPaySek: 46000 }), "summa");
  assert.equal(h1.status, "fraga", txt(h1));
  assert.match(txt(h1), /beloppet är lika stort som ROT-avdraget/);
});

test("R2 P3: procentrabatt efter ROT som inte kan förklara skillnaden (to-pay 30 000) är fel", () => {
  const k = get(run({ ...BI, laborSumSek: 40000, materialSumSek: 20000, travelSumSek: 0, otherSumSek: 0, discountPct: 10, discountStage: "efter_rot", rotAmountSek: 12000, totalBeforeRotSek: 60000, amountToPaySek: 30000 }), "total_konflikt");
  assert.equal(k.status, "fel");
});

test("R2 jämförelsen: rabatt lika stor som ROT används inte, och delposter efter rabatt visas i hela kronor och aldrig negativa", () => {
  const ALL = { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" };
  const offer = (e) => sanitizeOffer(fixtureResponse({ extracted: { vatMode: "inkl", totalVatBasis: "inkl", priceType: "fast", laborSumSek: 40000, materialSumSek: 20000, travelSumSek: 0, otherSumSek: 0, rotAmountSek: 12000, totalBeforeRotSek: 48000, ...e }, scope: ALL }));
  const a = JSON.stringify(compareOffers([offer({}), offer({})], offerLabels([], 2)));
  const b = JSON.stringify(compareOffers([offer({ discountSek: 12000 }), offer({})], offerLabels([], 2)));
  assert.equal((b.match(/summerar delposterna till 60000 kr medan totalen är 48000 kr/g) || []).length, (a.match(/summerar delposterna till 60000 kr medan totalen är 48000 kr/g) || []).length);
  const c = JSON.stringify(compareOffers([offer({ laborSumSek: 1000.5, materialSumSek: 2000.25, discountSek: 15345.928, totalBeforeRotSek: 1000 }), offer({})], offerLabels([], 2)));
  assert.doesNotMatch(c, /till -\d/);
  const d = JSON.stringify(compareOffers([offer({ laborSumSek: 40000.4, materialSumSek: 20000.4, discountSek: 2000.25, discountStage: "fore_moms", totalBeforeRotSek: 50000 }), offer({})], offerLabels([], 2)));
  assert.match(d, /efter rabatten till 58001 kr/);
});

test("R2 ordval: kända momsbaser påstås inte okända, inga decimalsvansar, 'om den gäller hela beloppet', ingen 'och rabatten' utan belopp", () => {
  // Q1: rabatt 5 000 på arbetet efter moms (fastställd), betalningsdatum saknas → exakt gräns men fråga om datum; ingen falsk momsfråga.
  const q1 = get(run({ ...BI, plannedPaymentDate: null, laborSumSek: 40000, materialSumSek: 20000, travelSumSek: 0, otherSumSek: 0, discountSek: 5000, discountBase: "arbete", discountStage: "efter_moms", rotAmountSek: 16000, totalBeforeRotSek: 55000 }), "rot_belopp");
  assert.doesNotMatch(txt(q1), /anger inte rabattens momsbas|mellan 17 500 kr och 17 500 kr|fördelas mellan arbete och/);
  assert.match(txt(q1), /arbetskostnaden efter rabatten 35 000 kr/);
  // Q2: hela-rabatt med ok: tydlig formulering.
  const q2 = get(run({ ...BI, laborSumSek: 50000, materialSumSek: 30000, travelSumSek: 0, otherSumSek: 0, discountSek: 16000, discountStage: "efter_moms", rotAmountSek: 10000, totalBeforeRotSek: 64000 }), "rot_belopp");
  assert.equal(q2.status, "ok");
  assert.match(txt(q2), /av arbetskostnaden med hela rabatten avdragen, 34 000 kr inklusive moms/);
  // Decimaler: procent av belopp med decimaler visas i hela kronor.
  const dec = run({ vatMode: "exkl", totalVatBasis: "inkl", laborSumSek: 40000.99, materialSumSek: 25000, travelSumSek: 2000, otherSumSek: 3000, discountPct: 12.5, discountBase: "hela", totalSumSek: 70000 });
  for (const c of dec) assert.doesNotMatch(txt(c), /\d,\d{3,} kr/, c.id);
  // Bara procentsats: ingen "och rabatten anges i offerten".
  const p = get(run({ ...R, totalSumSek: 82500, discountPct: 10, discountBase: "hela", discountStage: "fore_moms" }), "summa");
  assert.doesNotMatch(txt(p), /och rabatten anges/);
});

test("R2 adv: procentsats utan underlag ger aldrig ok – 'hela beloppet' är en tolkning", () => {
  const s = get(run({ ...R, totalSumSek: 78750, discountPct: 10 }), "summa");
  assert.equal(s.status, "fraga", txt(s));
  assert.match(txt(s), /Räknas rabatten 10 % på hela beloppet \(7 000 kr exklusive moms, 8 750 kr inklusive moms\) blir det 78 750 kr, vilket stämmer med totalen, men offerten anger inte vad rabatten gäller/);
  assert.equal(get(run({ ...R, totalSumSek: 78750, discountPct: 10, discountBase: "hela" }), "summa").status, "ok");
});

test("R2 adv: ROT-gräns på rabatterat arbete avrundas halvt uppåt till hela ören (17 990,625 → 17 990,63 är inte över)", () => {
  const o = { vatMode: "exkl", totalVatBasis: "exkl", laborSumSek: 50500, materialSumSek: 52000, travelSumSek: 500, otherSumSek: 0, totalBeforeRotSek: 100475,
    discountSek: 2525, discountPct: 5, discountBase: "arbete", discountStage: "fore_moms" };
  assert.equal(get(run({ ...o, rotAmountSek: 17990.63 }), "rot_belopp").status, "ok");
  assert.equal(get(run({ ...o, rotAmountSek: 17990.64 }), "rot_belopp").status, "fel");
});

test("R2 adv: rabatt lika stor som ROT-avdraget lämnar aldrig ROT-beloppet grönt när den kan röra arbetet", () => {
  const rb = get(run({ ...BI, laborSumSek: 21500, materialSumSek: 21500, travelSumSek: 500, otherSumSek: 0, rotAmountSek: 5000, totalBeforeRotSek: 38500, amountToPaySek: 33500, discountSek: 5000, discountBase: "arbete" }), "rot_belopp");
  assert.equal(rb.status, "fraga", txt(rb));
  // Bara på material: ROT-gränsen påverkas inte.
  assert.equal(get(run({ ...BI, laborSumSek: 21500, materialSumSek: 21500, travelSumSek: 500, otherSumSek: 0, rotAmountSek: 5000, totalBeforeRotSek: 38500, amountToPaySek: 33500, discountSek: 5000, discountBase: "material" }), "rot_belopp").status, "ok");
});

test("R2 adv: belopp som kan vara ett felläst ROT-avdrag och som exakt förklarar skillnaden mellan summorna ger fråga, inte fel", () => {
  const k = get(run({ vatMode: "exkl", totalVatBasis: "inkl", laborSumSek: 26000, materialSumSek: 49000, travelSumSek: 0, otherSumSek: 3000, totalBeforeRotSek: 97500, amountToPaySek: 87750, discountSek: 9750, discountPct: 10, discountBase: "material" }), "total_konflikt");
  assert.equal(k.status, "fraga", txt(k));
});

test("R2 L1: omärkt total före ROT med rabatt – en uträknad summa att betala sägs aldrig 'stämma'", () => {
  const s = get(run({ ...R, totalSumSek: 78750, discountSek: 7000, discountPct: 10, discountStage: "fore_moms", rotAmountSek: 15000 }), "summa");
  assert.equal(s.status, "ok");
  assert.doesNotMatch(txt(s), /att betala/);
  // Anger offerten summan att betala stämmer den av som förut.
  assert.match(txt(get(run({ ...R, totalSumSek: 78750, amountToPaySek: 63750, discountSek: 7000, discountPct: 10, discountStage: "fore_moms", rotAmountSek: 15000 }), "summa")), /blir det 63 750 kr att betala – det stämmer/);
});

// ---- Granskning R3 (fjärde oberoende granskningen, 2026-10-23). Basofferten: inklusive moms, resor 0, övrigt 0.
const B4 = { ...BI, travelSumSek: 0, otherSumSek: 0 };

test("R3 P1: med rabatt måste en angiven summa att betala stämma på kronan – 1 400 kr fel (under 2 %) ger fråga, inte ok", () => {
  const s = get(run({ ...B4, laborSumSek: 50000, materialSumSek: 50000, discountSek: 10000, discountStage: "efter_moms", discountBase: "material", rotAmountSek: 15000, totalBeforeRotSek: 90000, amountToPaySek: 76400 }), "summa");
  assert.equal(s.status, "fraga", txt(s));
  assert.match(txt(s), /Efter ROT-avdrag 15 000 kr borde summan att betala vara 75 000 kr, men offerten anger 76 400 kr – en skillnad på 1 400 kr\./);
  // Rätt summa att betala: ok.
  assert.equal(get(run({ ...B4, laborSumSek: 50000, materialSumSek: 50000, discountSek: 10000, discountStage: "efter_moms", discountBase: "material", rotAmountSek: 15000, totalBeforeRotSek: 90000, amountToPaySek: 75000 }), "summa").status, "ok");
  // Utan rabatt: oförändrat mot main (2 %-toleransen för summa att betala är en känd, separat uppföljning).
  assert.equal(get(run({ ...B4, laborSumSek: 50000, materialSumSek: 40000, rotAmountSek: 12000, totalBeforeRotSek: 90000, amountToPaySek: 79400 }), "summa").status, "ok");
});

test("R3 P2-2: jämförelsen ger inget summafynd när rabattens steg är okänt (som rules.js)", () => {
  const ALL = { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" };
  const o = (e) => sanitizeOffer(fixtureResponse({ extracted: { vatMode: "inkl", totalVatBasis: "inkl", priceType: "fast", laborSumSek: 40000, materialSumSek: 60000, travelSumSek: 0, otherSumSek: 0, rotAmountSek: 12000, totalBeforeRotSek: 100000, ...e }, scope: ALL }));
  const res = JSON.stringify(compareOffers([o({ amountToPaySek: 83000, discountSek: 5000 }), o({})], offerLabels([], 2)));
  assert.doesNotMatch(res, /summerar delposterna|Delposterna/);
  // Rabatt efter momsen på rader exklusive moms: beloppet är inklusive moms (25 000 inkl = 20 000 exkl) → ingen avvikelse.
  const ex = JSON.stringify(compareOffers([o({ vatMode: "exkl", totalVatBasis: "exkl", laborSumSek: 100000, materialSumSek: 100000, totalBeforeRotSek: 180000, discountSek: 25000, discountStage: "efter_moms" }), o({})], offerLabels([], 2)));
  assert.doesNotMatch(ex, /summerar delposterna/);
});

test("R3 P2-3: rabatt före ROT mellan offertens bruttosumma och ROT-raden är ingen totalkonflikt", () => {
  const r = run({ ...B4, laborSumSek: 50000, materialSumSek: 50000, discountSek: 5000, discountStage: "efter_moms", discountBase: "hela", rotAmountSek: 14250, totalBeforeRotSek: 100000, amountToPaySek: 80750 });
  assert.equal(get(r, "total_konflikt"), undefined);
  const s = get(r, "summa");
  assert.equal(s.status, "ok", txt(s));
  assert.match(txt(s), /summerar till 100 000 kr, samma som offertens summa före rabatten\. Efter rabatten på hela beloppet 5 000 kr blir det 95 000 kr, och efter ROT-avdrag 14 250 kr blir det 80 750 kr att betala – det stämmer\./);
  // Okänt steg: fråga (inte fel, inte ok).
  assert.equal(get(run({ ...B4, laborSumSek: 50000, materialSumSek: 50000, discountSek: 5000, discountBase: "hela", rotAmountSek: 14250, totalBeforeRotSek: 100000, amountToPaySek: 80750 }), "total_konflikt").status, "fraga");
  // Fel summa att betala trots rabatten mellan: fortfarande totalkonflikt.
  assert.equal(get(run({ ...B4, laborSumSek: 50000, materialSumSek: 50000, discountSek: 5000, discountStage: "efter_moms", discountBase: "hela", rotAmountSek: 14250, totalBeforeRotSek: 100000, amountToPaySek: 78000 }), "total_konflikt").status, "fel");
  for (const f of ["../src/index.js", "../src/compare_extract.js"]) assert.match(readFileSync(new URL(f, import.meta.url), "utf8"), /När en rabattrad står mellan en summa och ROT-raden är totalBeforeRotSek summan EFTER rabatten/, f);
});

test("R3 P2-4: ROT-eko ger aldrig ok, och 'lika stort som ROT-avdraget' sägs bara när ett ROT-belopp finns", () => {
  // Rabatt = ROT, totalen = raderna (rabatten inte avdragen).
  assert.equal(get(run({ ...B4, laborSumSek: 50000, materialSumSek: 50000, discountSek: 15000, discountStage: "efter_moms", rotAmountSek: 15000, totalBeforeRotSek: 100000, amountToPaySek: 85000 }), "summa").status, "fraga");
  // Tomt ROT, rabatt = 30 % av arbetet: rabatten räknas inte med → fråga.
  const r = run({ ...B4, laborSumSek: 40000, materialSumSek: 60000, discountSek: 12000, discountPct: 30, discountBase: "arbete", discountStage: "efter_moms", totalSumSek: 88000 });
  assert.equal(get(r, "summa").status, "fraga");
  for (const c of r) assert.doesNotMatch(txt(c), /lika (stort|mycket) som ROT-avdraget/, c.id);
  assert.match(txt(get(r, "summa")), /exakt så stort som ett ROT-avdrag på arbetskostnaden skulle vara, och inget ROT-avdrag har lästs ut/);
});

test("R3 #6: omärkt total = summa att betala efter en rabatt efter ROT, utan ROT, är ok (inte falskt fel)", () => {
  const s = get(run({ ...B4, laborSumSek: 40000, materialSumSek: 60000, discountSek: 5000, discountStage: "efter_rot", totalSumSek: 95000 }), "summa");
  assert.equal(s.status, "ok", txt(s));
  assert.match(txt(s), /Efter rabatten 5 000 kr blir det 95 000 kr, vilket stämmer med offertens total\./);
});

test("R3 P3 ordval: hela kronor, summor som går ihop, ören bara när skillnaden är under 3 kr, ingen uträknad 'totalen'", () => {
  // ROT-text på rabattvägen: hela kronor (ingen "13 984,62 kr").
  const rb = get(run({ ...B4, laborSumSek: 46615.4, materialSumSek: 30000, discountSek: 3333, discountStage: "efter_moms", rotAmountSek: 13000, totalBeforeRotSek: 73282.4 }), "rot_belopp");
  assert.doesNotMatch(txt(rb), /\d,\d\d kr/, txt(rb));
  // Visade belopp går ihop: A − rabatt = N.
  const s = get(run({ vatMode: "exkl", totalVatBasis: "inkl", laborSumSek: 40000.4, materialSumSek: 25000.4, travelSumSek: 0, otherSumSek: 0, discountSek: 3333.33, discountStage: "fore_moms", totalSumSek: 77084.34 }), "summa");
  const m = /summerar till ([\d ]+) kr inklusive moms\. Efter rabatten [\d ]+ kr exklusive moms \(([\d ]+) kr inklusive moms\) blir det ([\d ]+) kr/.exec(txt(s));
  assert.ok(m, txt(s));
  const n = (v) => Number(v.replace(/ /g, ""));
  assert.equal(n(m[1]) - n(m[2]), n(m[3]));
  // Skillnad under 3 kr visas i ören och aldrig som "1 kr".
  const d = get(run({ ...B4, laborSumSek: 50000.4, materialSumSek: 50000, discountSek: 10000, discountStage: "efter_moms", totalBeforeRotSek: 89999, rotAmountSek: 1000 }), "summa");
  assert.match(txt(d), /en skillnad på 1,40 kr/);
  // Bara summa att betala: en uträknad summa före ROT kallas inte "totalen".
  const p = get(run({ ...B4, laborSumSek: 50000, materialSumSek: 50000, discountSek: 5000, discountStage: "efter_rot", discountBase: "material", rotAmountSek: 15000, amountToPaySek: 80000 }), "summa");
  assert.doesNotMatch(txt(p), /summerar till totalen|stämmer med totalen/);
  // Rabatt efter ROT med totaler exklusive moms: momsbasen påstås inte.
  const k = run({ vatMode: "exkl", totalVatBasis: "exkl", laborSumSek: 40000, materialSumSek: 40000, travelSumSek: 0, otherSumSek: 0, discountSek: 5000, discountStage: "efter_rot", totalBeforeRotSek: 80000, rotAmountSek: 15000, amountToPaySek: 64000 });
  assert.equal(get(k, "total_konflikt").status, "fraga");
  for (const c of k) assert.doesNotMatch(txt(c), /5 000 kr exklusive moms/, c.id);
  // total_konflikt-fråga i hela kronor.
  assert.doesNotMatch(txt(get(run({ ...B4, laborSumSek: 50000, materialSumSek: 50000.5, discountSek: 5000, rotAmountSek: 14250, totalBeforeRotSek: 100000.5, amountToPaySek: 80750.5 }), "total_konflikt")), /\d,\d+ kr/);
  // Lästs en rabatt sägs inte "något som inte avlästs – till exempel en rabatt".
  const q = get(run({ ...B4, travelSumSek: null, laborSumSek: 50000, materialSumSek: 50000, discountPct: 10, discountStage: "efter_rot", totalBeforeRotSek: 80000 }), "summa");
  assert.doesNotMatch(txt(q), /till exempel en rabatt,/);
});

test("R3 driftsättning: EXTRACT_VERSION avlasning-5 och förkontrollens original behåller rabatten", async () => {
  const { EXTRACT_VERSION } = await import("../src/compare_extract.js");
  assert.equal(EXTRACT_VERSION, "avlasning-5");
  const { buildCheckReport } = await import("../src/compare_check.js");
  const offer = sanitizeOffer(fixtureResponse({ extracted: { vatMode: "inkl", totalVatBasis: "inkl", priceType: "fast", laborSumSek: 40000, materialSumSek: 60000, travelSumSek: 0, otherSumSek: 0, totalBeforeRotSek: 95000, discountSek: 5000, discountStage: "efter_moms", discountBase: "hela" }, scope: { rivning: "ingar" } }));
  const rep = buildCheckReport({ order: { id: "o" }, offer, label: "X", now: 1e12, receipt: null });
  assert.deepEqual([rep.original.discountSek, rep.original.discountStage, rep.original.discountBase], [5000, "efter_moms", "hela"]);
  assert.equal(rep.findings.find((f) => f.id === "summa").status, "ok");
});

test("R3 adv: rabatt lika stor som ROT-avdraget (i någon momstolkning) med bara en omärkt total ger fråga, inte ok", () => {
  // 50 % rabatt på arbetet (19 675 kr) = ROT 19 675 kr: totalen 46 675 kan vara före ROT efter rabatten eller att betala efter ROT.
  const s = get(run({ ...B4, laborSumSek: 39350, materialSumSek: 27000, rotAmountSek: 19675, totalSumSek: 46675, discountPct: 50, discountBase: "arbete" }), "summa");
  assert.equal(s.status, "fraga", txt(s));
  assert.match(txt(s), /Rabatten är lika stor som ROT-avdraget, och offerten märker inte sin total/);
});

test("R3 adv: bara summa att betala utan ROT – texten säger 'summan att betala', inte 'totalen'", () => {
  const s = get(run({ ...B4, laborSumSek: 62000, materialSumSek: 51500, travelSumSek: 1500, discountSek: 9300, discountPct: 15, amountToPaySek: 105700 }), "summa");
  assert.equal(s.status, "ok", txt(s));
  assert.match(txt(s), /vilket stämmer med summan att betala\./);
});

test("R3 adv: rabatt efter ROT utan ROT-belopp och med okänd radmoms – rabatten tappas inte (inget falskt fel)", () => {
  // Rader 46 371 (moms okänd), rabatt 6 956 efter ROT, inget ROT; summa att betala 39 415 = 46 371 − 6 956.
  const o = { vatMode: "ej_angivet", totalVatBasis: "inkl", laborSumSek: 20174, materialSumSek: 23697, travelSumSek: 0, otherSumSek: 2500, discountSek: 6956, discountStage: "efter_rot" };
  for (const k of [{ amountToPaySek: 39415 }, { totalSumSek: 39415 }]) {
    const s = get(run({ ...o, ...k }), "summa");
    assert.notEqual(s.status, "fel", `${JSON.stringify(k)}: ${txt(s)}`);
  }
});
