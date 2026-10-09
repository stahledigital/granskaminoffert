// Tester för prisreglerna (PRISUNDERLAG lager 1–2). Körs med: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runRules, checkNormalAddons, compareToBands, findForbidden, scrubForbidden, FORBIDDEN_WORDS } from "../src/rules.js";
import { buildPriceReport, rateBand } from "../src/index.js";

const REF = JSON.parse(readFileSync(new URL("../src/reference.json", import.meta.url), "utf8"));

const base = {
  jobType: null, trades: [], hourlyRateSek: null, hours: null, laborSumSek: null, materialSumSek: null,
  travelSumSek: null, materialMarkupPct: null, rotAmountSek: null, rotRatePct: null, rotPersons: null,
  rotOnMaterialOrTravel: null, priceType: null, vatMode: "ej_angivet", totalSumSek: null, totalIncludesVat: null,
  quoteDate: null, plannedPaymentDate: null, customerType: "privatperson", workDescription: null, county: null,
  areaM2: null, unitCount: null, otherSumSek: null,
};
const byId = (arr, id) => arr.find((c) => c.id === id);

// Fem testofferter enligt Moneymans krav.
export const FIXTURES = {
  korrekt: { ...base, jobType: "altan", trades: ["snickare"], hourlyRateSek: 650, hours: 60, laborSumSek: 39000, materialSumSek: 28000,
    travelSumSek: 600, rotAmountSek: 11700, rotRatePct: 30, priceType: "fast", vatMode: "inkl", totalSumSek: 55900, totalIncludesVat: true,
    quoteDate: "2026-09-10", plannedPaymentDate: "2026-10-15", workDescription: "Altan 20 m² tryckimpregnerat trä på plintar", county: "Kronoberg", areaM2: 20 },
  rotPaMaterial: { ...base, jobType: "badrum", trades: ["plattsattare", "vvs"], hourlyRateSek: 750, laborSumSek: 120000, materialSumSek: 60000,
    rotAmountSek: 54000, rotOnMaterialOrTravel: true, priceType: "fast", vatMode: "inkl", totalSumSek: 126000, totalIncludesVat: true,
    quoteDate: "2026-08-20", workDescription: "Totalrenovering badrum 5 m²", areaM2: 5 },
  offert2025Femtio: { ...base, jobType: "malning", trades: ["malare"], hourlyRateSek: 600, hours: 40, laborSumSek: 24000, materialSumSek: 4000,
    rotAmountSek: 12000, rotRatePct: 50, priceType: "ungefarligt", vatMode: "inkl", totalSumSek: 16000, totalIncludesVat: true,
    quoteDate: "2025-11-20", plannedPaymentDate: "2026-02-01", workDescription: "Målning av väggar och tak i vardagsrum", areaM2: 60 },
  fastUtanUppdelning: { ...base, jobType: "fonster", trades: [], priceType: "fast", vatMode: "inkl", totalSumSek: 84000, totalIncludesVat: true,
    rotAmountSek: 9000, quoteDate: "2026-09-01", workDescription: "Byte av 8 fönster inkl. montering", unitCount: 8 },
  timpris350: { ...base, jobType: "annat", trades: ["snickare"], hourlyRateSek: 350, hours: 30, laborSumSek: 10500, materialSumSek: 3000,
    rotAmountSek: 3150, priceType: "lopande", vatMode: "ej_angivet", totalSumSek: 10350, quoteDate: "2026-09-12", workDescription: "Byte av panel på garage" },
};

test("korrekt offert: alla regler ok, timpris inom, altan inom", () => {
  const r = runRules(FIXTURES.korrekt, REF);
  assert.equal(byId(r, "moms").status, "ok");
  assert.equal(byId(r, "rot_belopp").status, "ok");
  assert.equal(byId(r, "arbetssumma").status, "ok");
  assert.equal(byId(r, "summa").status, "ok");
  assert.equal(byId(r, "pristyp").status, "ok");
  assert.ok(!byId(r, "rot_material"));
  const a = checkNormalAddons(FIXTURES.korrekt, REF);
  assert.equal(byId(a, "framkorning").status, "ok");
  const c = compareToBands(FIXTURES.korrekt, REF);
  assert.equal(byId(c, "tim_snickare").mode, "inom");
  assert.match(byId(c, "tim_snickare").text, /inom det intervall vi ser för snickare 2026 \(550–800\skr per timme inkl\. moms; Byggahus\.se mars 2026/);
  assert.equal(byId(c, "projekt").mode, "inom"); // (55 900 + 11 700) / 20 = 3 380 kr/m² före rot
});

test("ROT på material: fel med Skatteverket som källa", () => {
  const r = runRules(FIXTURES.rotPaMaterial, REF);
  assert.equal(byId(r, "rot_material").status, "fel");
  assert.match(byId(r, "rot_material").source, /Skatteverket/);
  assert.equal(byId(r, "rot_belopp").status, "fel"); // 30 % av 120 000 = 36 000, inte 54 000
  assert.equal(byId(r, "rot_tak").status, "fraga"); // 54 000 > 50 000 utan antal personer
});

test("2025-offert med 50 % som betalas 2026: fel med Skatteverket-citat", () => {
  const r = runRules(FIXTURES.offert2025Femtio, REF);
  const rot = byId(r, "rot_belopp");
  assert.equal(rot.status, "fel");
  assert.match(rot.text, /50 %/);
  assert.match(rot.text, /30 procent av arbetskostnaden/);
  assert.match(rot.text, /7\s200 kr/);
  // Samma offert betald i december 2025: ok
  const r2 = runRules({ ...FIXTURES.offert2025Femtio, plannedPaymentDate: "2025-12-15" }, REF);
  assert.equal(byId(r2, "rot_belopp").status, "ok");
  // Offertdatum 2025 men inget betaldatum: fråga, inte ok
  const r3 = runRules({ ...FIXTURES.offert2025Femtio, plannedPaymentDate: null }, REF);
  assert.equal(byId(r3, "rot_belopp").status, "fraga");
  assert.match(byId(r3, "rot_belopp").text, /anger inte när betalningen sker/);
  const c = compareToBands(FIXTURES.offert2025Femtio, REF);
  assert.equal(byId(c, "tim_malare").mode, "inom");
  assert.equal(byId(c, "projekt").mode, "inom"); // arbete 24 000 / 60 m² = 400 kr/m²
});

test("fast pris utan uppdelning: går inte att kontrollera, be om uppdelning", () => {
  const r = runRules(FIXTURES.fastUtanUppdelning, REF);
  const u = byId(r, "uppdelning");
  assert.equal(u.status, "ej_bedombar");
  assert.match(u.text, /be om uppdelningen/);
  assert.ok(!byId(r, "rot_belopp"));
  const rep = buildPriceReport(FIXTURES.fastUtanUppdelning);
  assert.ok(rep.cannotAssess.some((c) => /uppdelning/.test(c.text)));
  // ANPASSAD D03 (GMO-REVISION-20261009-01): fixturen har en OETIKETTERAD total
  // (84 000) och ett ROT-belopp. Totalen kan då vara före eller efter ROT-avdraget
  // (84 000 respektive 93 000 före ROT) och inga rader finns att stämma av mot.
  // Tidigare lade koden tyst tillbaka ROT och sa "inom"; nu avstår jämförelsen
  // och redovisar båda tolkningarna. Det ursprungliga "inom" finns kvar nedan,
  // men bara när offerten uttryckligen anger summan att betala / före ROT.
  const c = compareToBands(FIXTURES.fastUtanUppdelning, REF);
  assert.equal(byId(c, "projekt").mode, "ej_bedombar");
  assert.match(byId(c, "projekt").text, /summan före ROT-avdrag/);
  assert.match(byId(c, "projekt").text, /summan att betala efter ROT-avdrag/);
  const betala = compareToBands({ ...FIXTURES.fastUtanUppdelning, totalSumSek: null, amountToPaySek: 84000, totalVatBasis: "inkl" }, REF);
  assert.equal(byId(betala, "projekt").mode, "inom"); // 84 000 + 9 000 = 93 000 före ROT / 8 = 11 625 kr per fönster
  const fore = compareToBands({ ...FIXTURES.fastUtanUppdelning, totalSumSek: null, totalBeforeRotSek: 84000, totalVatBasis: "inkl" }, REF);
  assert.equal(byId(fore, "projekt").mode, "inom"); // 84 000 / 8 = 10 500 kr per fönster
});

// ANPASSAD D03: fixturen timpris350 har vatMode "ej_angivet". Det tidigare testet
// förutsatte att momsen "antas inkl." och gav ROT-beloppet ok och en lönekostnadsrad
// med golv inkl. moms. Antagandet är borttaget (ej_angivet blir aldrig ett faktum):
// ROT-beloppet stämmer bara om priset är inklusive moms och blir därför en fråga,
// och 350 kr/h ligger över golvet om priset är exklusive moms (golv 304) så ingen
// lönekostnadsrad kan sägas. De ursprungliga påståendena om golvtexten kvarstår
// nedan för samma fixtur med uttryckligt vatMode "inkl".
test("timpris 350 utan momsuppgift: fråga på ROT, ingen lönekostnadsrad, marknadsbedömning bara när den är densamma", () => {
  const r = runRules(FIXTURES.timpris350, REF);
  assert.equal(byId(r, "moms").status, "flagga");
  assert.equal(byId(r, "rot_belopp").status, "fraga");
  assert.match(byId(r, "rot_belopp").text, /exklusive moms/);
  assert.equal(byId(r, "pristyp").status, "flagga");
  const c = compareToBands(FIXTURES.timpris350, REF);
  assert.equal(byId(c, "tim_snickare").mode, "under_band"); // 350 < 440 (exkl) och < 550 (inkl)
  assert.match(byId(c, "tim_snickare").text, /inklusive eller exklusive moms/);
  assert.equal(byId(c, "lonekostnad_snickare"), undefined); // 350 > golv exkl 304
  const lag = compareToBands({ ...FIXTURES.timpris350, hourlyRateSek: 290 }, REF);
  assert.ok(byId(lag, "lonekostnad_snickare"), "under golvet i båda momsbaser ska ge lönekostnadsrad");
  const mellan = compareToBands({ ...FIXTURES.timpris350, hourlyRateSek: 500 }, REF); // inom inkl-bandet 550–800? nej: under; inom exkl 440–640
  assert.equal(byId(mellan, "tim_snickare").mode, "ej_bedombar");
  assert.match(byId(mellan, "tim_snickare").text, /550–800/);
  assert.match(byId(mellan, "tim_snickare").text, /440–640/);
});

test("timpris 350 med uttryckligt inkl. moms: under referensgolvet med låst ordval", () => {
  const fx = { ...FIXTURES.timpris350, vatMode: "inkl", totalIncludesVat: true };
  const r = runRules(fx, REF);
  assert.equal(byId(r, "moms").status, "ok");
  assert.equal(byId(r, "rot_belopp").status, "ok");
  assert.equal(byId(r, "pristyp").status, "flagga");
  const c = compareToBands(fx, REF);
  // Rev 3: två rader. Marknad alltid, lönekostnad bara när priset ligger under golvet.
  const marknad = byId(c, "tim_snickare");
  assert.equal(marknad.mode, "under_band");
  assert.match(marknad.title, /^Marknad – timpris snickare$/);
  const lon = byId(c, "lonekostnad_snickare");
  assert.ok(lon, "saknar lönekostnadsrad för 350 kr/h");
  assert.equal(lon.mode, "under");
  assert.match(lon.text, /även med en lön bland de lägsta tio procenten i yrket/);
  assert.match(lon.text, /referensgolv ~380 kr per timme inkl\. moms/);
  assert.match(lon.text, /F-skatt och försäkring/);
  assert.match(lon.source, /10:e percentilen/);
  // Rev 4: lönekostnadsraden upprepar inte marknadsradens intervall, och ingen
  // mening står två gånger i de två raderna tillsammans (ny mening = versal efter punkt,
  // så att "inkl. moms" inte räknas som meningsslut).
  assert.match(lon.text, /F-skatt och försäkring\.$/);
  assert.doesNotMatch(lon.text, /intervall/);
  const meningar = [marknad.text, lon.text].flatMap((s) => s.split(/(?<=[.!?])\s+(?=[A-ZÅÄÖ])/)).map((m) => m.trim()).filter(Boolean);
  assert.equal(new Set(meningar).size, meningar.length, "samma mening står två gånger: " + meningar.join(" | "));
  const proj = byId(c, "projekt");
  assert.equal(proj, undefined); // jobType "annat" har inget band
});

test("över intervallet, mellan golv och band, kök utan referens, värmepumpsschablon", () => {
  const over = compareToBands({ ...base, trades: ["elektriker"], hourlyRateSek: 1150, vatMode: "inkl" }, REF);
  assert.equal(byId(over, "tim_elektriker").mode, "over");
  assert.match(byId(over, "tim_elektriker").text, /Be om motivering/);
  const mid = compareToBands({ ...base, trades: ["elektriker"], hourlyRateSek: 600, vatMode: "inkl" }, REF);
  assert.equal(byId(mid, "tim_elektriker").mode, "under_band");
  const kok = compareToBands({ ...base, jobType: "kok", totalSumSek: 150000 }, REF);
  assert.match(byId(kok, "projekt").text, /referens saknas/);
  const exkl = compareToBands({ ...base, trades: ["vvs"], hourlyRateSek: 700, vatMode: "exkl" }, REF);
  assert.equal(byId(exkl, "tim_vvs").mode, "inom");
  assert.match(byId(exkl, "tim_vvs").text, /exkl\. moms/);
  // ANPASSAD D03: schablonen kräver fast pris, småhus och en BELAGD summa före ROT
  // med känd momsbas. Fixturen hade bara en oetiketterad total; nu anges allt.
  const hpBase = { ...base, jobType: "bergvarme", priceType: "fast", propertyType: "smahus", totalBeforeRotSek: 200000, totalVatBasis: "inkl", vatMode: "inkl", quoteDate: "2026-09-01" };
  const hp = runRules({ ...hpBase, rotAmountSek: 21000 }, REF);
  // F8/P01: fast pris + småhus bevisar varken totalentreprenad eller Skatteverkets momsbas
  // → villkorat räkneexempel (200 000 × 0,35 × 0,30 = 21 000), aldrig "ok".
  assert.equal(byId(hp, "rot_schablon").status, "fraga");
  assert.match(byId(hp, "rot_schablon").text, /21\s000 kr/);
  const hpBad = runRules({ ...hpBase, rotAmountSek: 60000 }, REF);
  assert.equal(byId(hpBad, "rot_schablon").status, "fraga");
  const hpBadAll = runRules({ ...hpBase, rotAmountSek: 60000, totalContract: "ja" }, REF);
  assert.equal(byId(hpBadAll, "rot_schablon").status, "fel");
  const und = runRules({ ...base, rotAmountSek: 5000, laborSumSek: 16667, vatMode: "inkl", workDescription: "Bygga pool och pooldäck", quoteDate: "2026-06-01" }, REF);
  assert.equal(byId(und, "rot_undantag").status, "flagga");
  const tak = runRules({ ...base, rotAmountSek: 90000, laborSumSek: 300000, rotPersons: 1, vatMode: "inkl", quoteDate: "2026-06-01" }, REF);
  assert.equal(byId(tak, "rot_tak").status, "fel");
});

test("förbjudna ord finns inte i någon regel-, jämförelse- eller referenstext", () => {
  const all = [];
  for (const f of Object.values(FIXTURES)) all.push(buildPriceReport(f));
  all.push(buildPriceReport({ ...base, trades: ["snickare", "elektriker", "vvs", "malare", "plattsattare"], hourlyRateSek: 100, vatMode: "inkl", jobType: "kok" }));
  all.push(REF);
  assert.deepEqual(findForbidden(all), []);
});

test("scrubForbidden tar bort förbjudna ord ur modelltext", () => {
  const dirty = { a: "Det här är för dyrt och ser oseriöst ut, kanske svart arbete eller fusk.", b: ["Överpris!"] };
  assert.ok(findForbidden(dirty).length >= 2);
  const clean = scrubForbidden(dirty);
  assert.deepEqual(findForbidden(clean), []);
  for (const w of FORBIDDEN_WORDS) assert.ok(!JSON.stringify(clean).toLowerCase().includes(w));
});

test("timprisband för statistik", () => {
  assert.equal(rateBand(350), "<400");
  assert.equal(rateBand(650), "600-799");
  assert.equal(rateBand(null), "okand");
});


// ---- Tillagt efter kodgranskningen 2026-09-18 ----

test("golvet ligger under bandets undre gräns för varje yrke och båda momslägen", () => {
  // Byggstopp. Ligger golvet över bandet blir läget "under bandet men över
  // golvet" omöjligt att nå, och ett timpris inom det intervall vi publicerar
  // beskrivs som under vad en anställd kostar. PRISUNDERLAG rev 3.
  for (const [trade, band] of Object.entries(REF.hourly)) {
    if (trade.startsWith("_") || !band || !band.inclVat) continue;
    for (const mode of ["inclVat", "exclVat"]) {
      const b = band[mode];
      if (!b) continue;
      assert.ok(b.floor < b.normal[0], `${trade} ${mode}: golv ${b.floor} ligger inte under bandets undre gräns ${b.normal[0]}`);
    }
    assert.ok(band.floorSource, `${trade}: saknar floorSource`);
  }
});

test("okänt momsläge ger fråga, inte fel, på ROT-beloppet", () => {
  // Arbetssumma 40 000 angiven utan momsläge. 30 % av 40 000 * 1,25 = 15 000.
  const out = runRules({
    ...base, vatMode: "ej_angivet", laborSumSek: 40000, rotAmountSek: 15000,
    totalSumSek: 60000, priceType: "loptid",
  }, REF);
  const rot = out.find((c) => c.id === "rot_belopp");
  assert.ok(rot, "ingen ROT-kontroll");
  assert.equal(rot.status, "fraga");
  assert.match(rot.text, /exklusive moms/);
});

test("ordspärren tvättar allt den hittar", () => {
  const svar = { a: "svartmålad fasad", b: "helt överprissatt", c: "det här är fusk", d: "för dyrt", e: "oseriöst" };
  const hits = findForbidden(svar);
  assert.ok(hits.length > 0, "hittade inget att tvätta");
  const rent = scrubForbidden(svar);
  assert.equal(findForbidden(rent).length, 0, "ord kvar efter tvätt: " + JSON.stringify(rent));
});

test("mellan golv och band: lågt pris, men ingen rad om lönekostnad", () => {
  // Snickare, golv 380, band 550–800 inkl. moms. 500 kr/h ligger däremellan.
  const c = compareToBands({ ...base, hourlyRateSek: 500, trades: ["snickare"], vatMode: "inkl" }, REF);
  const marknad = byId(c, "tim_snickare");
  assert.equal(marknad.mode, "under_band");
  assert.match(marknad.text, /Lågt pris kan bero på en liten firma med låga omkostnader/);
  assert.match(marknad.text, /framkörning, material och bortforsling/);
  assert.equal(byId(c, "lonekostnad_snickare"), undefined, "lönekostnadsraden ska inte visas över golvet");
  assert.ok(!/anställd/.test(marknad.text), "marknadsraden ska inte påstå något om lönekostnad");
});

test("de fyra lägena i rak ordning för snickare", () => {
  const lage = (rate) => {
    const c = compareToBands({ ...base, hourlyRateSek: rate, trades: ["snickare"], vatMode: "inkl" }, REF);
    return byId(c, "lonekostnad_snickare") ? "under_golv" : byId(c, "tim_snickare").mode;
  };
  assert.equal(lage(300), "under_golv");   // under golvet 380
  assert.equal(lage(500), "under_band");   // över golvet, under bandet 550
  assert.equal(lage(700), "inom");         // i bandet 550–800
  assert.equal(lage(900), "over");         // över bandet
});

test("inga platshållare läcker ut i någon text", () => {
  const fall = [
    { ...base, hourlyRateSek: 300, trades: ["snickare"], vatMode: "inkl" },
    { ...base, hourlyRateSek: 500, trades: ["snickare"], vatMode: "exkl" },
    { ...base, hourlyRateSek: 700, trades: ["malare", "vvs"], vatMode: "inkl" },
    { ...base, hourlyRateSek: 2000, trades: ["plattsattare"], vatMode: "inkl" },
    { ...base, hourlyRateSek: null, trades: ["elektriker"], vatMode: "inkl" },
    { ...base, jobType: "tak", totalSumSek: 150000, areaM2: 100, vatMode: "inkl" },
  ];
  for (const x of fall) {
    for (const rad of compareToBands(x, REF)) {
      assert.ok(!/\{[a-zA-Z]+\}/.test(rad.text), `platshållare kvar i "${rad.title}": ${rad.text}`);
    }
    for (const rad of runRules(x, REF)) {
      assert.ok(!/\{[a-zA-Z]+\}/.test(rad.text), `platshållare kvar i "${rad.title}": ${rad.text}`);
    }
  }
});
