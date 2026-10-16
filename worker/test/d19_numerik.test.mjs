// D19: decimalsäker ROT-övregräns, ROT som övre gräns (inte likhet), summering med okända kategorier, sammanhangsfält och förskott.
// Förväntade värden är handskrivna literaler (speglar de frysta numerik-/kontextfallen), aldrig återberäknade ur produktkoden.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runRules, checkNormalAddons, compareToBands } from "../src/rules.js";
import { sanitizeExtracted } from "../src/sanitize.js";
import { EXTRACTED_SCHEMA } from "../src/extracted_schema.js";
import * as D from "../src/money.js";

const REF = JSON.parse(readFileSync(new URL("../src/reference.json", import.meta.url), "utf8"));
const BASE = { vatMode: "inkl", totalVatBasis: "inkl", priceType: "fast", customerType: "privatperson", plannedPaymentDate: "2026-10-16" };
const run = (o) => runRules(sanitizeExtracted({ ...BASE, ...o }).x, REF);
const get = (r, id) => r.find((c) => c.id === id);
const st = (o, id) => get(run(o), id)?.status ?? "SAKNAS";

test("money: decimalsäker aritmetik utan float-rester", () => {
  assert.equal(D.fmtKr(D.mul(D.dec(100000.1), D.dec(0.3))), "30 000,03 kr");
  assert.ok(D.gt(D.dec(30000.01), D.dec(30000)));
  assert.ok(D.eq(D.add(D.dec(0.1), D.dec(0.2)), D.dec(0.3)));
  assert.equal(D.fmtKr(D.dec(30500)), "30 500 kr");
  assert.equal(D.dec(NaN), null); assert.equal(D.dec("abc"), null);
  assert.equal(D.fmtNumber(D.dec(0.1)), "0,10");
});

test("ROT: övre gräns — lägre och 0 är aldrig fel; över gränsen är fel utan 2 %-tolerans; exakta öresfall", () => {
  const L = { laborSumSek: 100000, rotPersons: 1 };
  assert.equal(st({ ...L, rotAmountSek: 30000 }, "rot_belopp"), "ok");
  assert.equal(st({ ...L, rotAmountSek: 20000 }, "rot_belopp"), "ok");        // R03
  assert.equal(st({ ...L, rotAmountSek: 0 }, "rot_belopp"), "ok");            // R09: inget yrkat är inte fel
  assert.equal(st({ ...L, rotAmountSek: null }, "rot_belopp"), "SAKNAS");     // R10: null är inte 0
  assert.equal(st({ ...L, rotAmountSek: 30500 }, "rot_belopp"), "fel");       // R05: 500 över, ingen 2 %-tolerans
  assert.equal(st({ ...L, rotAmountSek: 31000 }, "rot_belopp"), "fel");
  const over = get(run({ ...L, rotAmountSek: 30000.01 }), "rot_belopp");      // PREC02
  assert.equal(over.status, "fel");
  assert.match(over.text, /30 000,01 kr/);
  assert.match(over.text, /0,01 kr över/);
  const prec4 = get(run({ laborSumSek: 100000.1, rotAmountSek: 30000.03, rotPersons: 1 }), "rot_belopp"); // PREC04
  assert.equal(prec4.status, "ok");
  assert.match(prec4.text, /30 000,03 kr/);
  assert.equal(st({ laborSumSek: 100000.1, rotAmountSek: 30000.04, rotPersons: 1 }, "rot_belopp"), "fel");
});

test("ROT: personantal begränsar totalen men höjer aldrig procenttaket", () => {
  assert.equal(st({ laborSumSek: 200000, rotAmountSek: 50000, rotPersons: 1 }, "rot_belopp"), "ok");   // R02
  assert.equal(st({ laborSumSek: 200000, rotAmountSek: 50000, rotPersons: 1 }, "rot_tak"), "SAKNAS");
  assert.equal(st({ laborSumSek: 400000, rotAmountSek: 100000, rotPersons: 2 }, "rot_belopp"), "ok");  // R08
  assert.equal(st({ laborSumSek: 300000, rotAmountSek: 90000, rotPersons: 1 }, "rot_tak"), "fel");     // R06
  assert.equal(st({ laborSumSek: 300000, rotAmountSek: 90000, rotPersons: null }, "rot_tak"), "fraga"); // R11
  // 45 000 på 150 000 med två personer: exakt 30 %, inom nominellt tak — aritmetiskt ok, inget personligt besked
  const r = get(run({ laborSumSek: 150000, rotAmountSek: 45000, rotPersons: 2 }), "rot_belopp");
  assert.equal(r.status, "ok");
  assert.match(r.text, /inte av ditt personliga avdragsutrymme/);
  // två personer kan inte rädda ett belopp över procenttaket
  assert.equal(st({ laborSumSek: 100000, rotAmountSek: 40000, rotPersons: 2 }, "rot_belopp"), "fel");
});

test("ROT: okänd moms och okänt betalningsdatum ger villkorade gränser, aldrig grönt", () => {
  const E = { laborSumSek: 24000, rotPersons: 1 };
  assert.equal(st({ ...E, vatMode: "exkl", rotAmountSek: 9000 }, "rot_belopp"), "ok");                 // RV01: 24 000 exkl = 30 000 inkl ⇒ 9 000
  const rv2 = get(run({ ...E, vatMode: "exkl", rotAmountSek: 9500 }), "rot_belopp");                    // RV02
  assert.equal(rv2.status, "fel"); assert.match(rv2.text, /500 kr över/);
  for (const amt of [9000, 6000]) {                                                                      // RV03/RV04
    const r = get(run({ ...E, vatMode: "ej_angivet", rotAmountSek: amt }), "rot_belopp");
    assert.equal(r.status, "fraga");
    assert.match(r.text, /7 200 kr/); assert.match(r.text, /9 000 kr/);
  }
  assert.equal(st({ ...E, vatMode: "ej_angivet", rotAmountSek: 9500 }, "rot_belopp"), "fel");          // över båda tolkningarna
  const L = { laborSumSek: 100000, rotPersons: 1 };
  assert.equal(st({ ...L, plannedPaymentDate: null, quoteDate: null, rotAmountSek: 30000 }, "rot_belopp"), "fraga");              // RD01
  assert.equal(st({ ...L, plannedPaymentDate: null, quoteDate: "2025-11-20", rotAmountSek: 50000 }, "rot_belopp"), "fraga");      // RD02
  assert.equal(st({ ...L, plannedPaymentDate: "2025-12-15", quoteDate: "2025-11-20", rotAmountSek: 50000 }, "rot_belopp"), "ok"); // RD03
  const rd4 = get(run({ ...L, plannedPaymentDate: "2026-02-01", quoteDate: "2025-11-20", rotAmountSek: 50000 }), "rot_belopp");   // RD04
  assert.equal(rd4.status, "fel"); assert.match(rd4.text, /30 000 kr/);
  assert.equal(st({ ...L, plannedPaymentDate: "2025-12-15", quoteDate: "2025-11-20", rotAmountSek: 40000 }, "rot_belopp"), "ok"); // RD05
  assert.equal(st({ ...L, plannedPaymentDate: null, quoteDate: "2026-03-01", rotAmountSek: 30000 }, "rot_belopp"), "ok");       // offert 2026 ⇒ betalning 2026
  assert.equal(st({ ...L, plannedPaymentDate: null, quoteDate: null, rotAmountSek: 55000 }, "rot_belopp"), "fel");               // över även 50 %-gränsen
});

test("värmepumpsschablon: ett lägre avdrag än schablonen är inte fel; över båda räkningarna med belagda villkor är fel", () => {
  const HP = { jobType: "bergvarme", propertyType: "smahus", totalContract: "ja", totalBeforeRotSek: 200000 };
  assert.equal(st({ ...HP, rotAmountSek: 21000 }, "rot_schablon"), "fraga");
  assert.equal(st({ ...HP, rotAmountSek: 10000 }, "rot_schablon"), "fraga");   // lägre än båda
  assert.equal(st({ ...HP, rotAmountSek: 60000 }, "rot_schablon"), "fel");     // HP04
  assert.equal(st({ ...HP, totalContract: null, rotAmountSek: 60000 }, "rot_schablon"), "fraga"); // HP05: villkor ej belagda
  assert.equal(get(run({ ...HP, rotAmountSek: 21000 }), "rot_belopp"), undefined);
});

test("summering: null är inte 0 — okänd kategori ger ej bedömd; delsumma över total ger differensfråga, aldrig säkert fel", () => {
  const S = (o) => get(run(o), "summa");
  assert.equal(S({ laborSumSek: 30000, materialSumSek: null, otherSumSek: 4000, totalBeforeRotSek: 44000 }).status, "ej_bedombar"); // S01
  assert.equal(S({ laborSumSek: 30000, materialSumSek: 0, otherSumSek: 4000, totalBeforeRotSek: 34000 }).status, "ej_bedombar");    // S03: resor saknas
  assert.equal(S({ laborSumSek: 0, materialSumSek: 9000, totalBeforeRotSek: 9000 }).status, "ej_bedombar");                           // S04
  const s10 = S({ laborSumSek: 30000, materialSumSek: null, otherSumSek: 4000, totalBeforeRotSek: 20000 });                          // S10
  assert.equal(s10.status, "fraga"); assert.match(s10.text, /minst 14 000 kr/); assert.doesNotMatch(s10.text, /borde vara/);
  assert.equal(S({ laborSumSek: 24000, materialSumSek: 0, otherSumSek: 3200, totalBeforeRotSek: 44000, vatMode: "exkl" }).status, "ej_bedombar"); // S08
  assert.equal(S({ laborSumSek: 30000, materialSumSek: 10000, travelSumSek: 1000, otherSumSek: 4000, totalBeforeRotSek: 45000 }).status, "ok"); // S05
  assert.equal(S({ laborSumSek: 30000, materialSumSek: 10000, travelSumSek: 1000, otherSumSek: null, totalBeforeRotSek: 45000 }).status, "ej_bedombar"); // S06
  assert.equal(S({ laborSumSek: 30000, materialSumSek: 0, travelSumSek: 0, otherSumSek: 4000, totalBeforeRotSek: 44000 }).status, "fel");      // Z01
  assert.equal(S({ laborSumSek: 0, materialSumSek: 0, travelSumSek: 0, otherSumSek: 0, totalBeforeRotSek: 0 }).status, "ok");                  // Z08
  assert.equal(S({ vatMode: "exkl", laborSumSek: 24000, materialSumSek: 0, travelSumSek: 0, otherSumSek: 3200, totalBeforeRotSek: 34000 }).status, "ok"); // Z04
  assert.equal(S({ vatMode: "exkl", laborSumSek: 24000, materialSumSek: 0, travelSumSek: 0, otherSumSek: 3200, totalBeforeRotSek: 44000 }).status, "fel"); // Z05
  assert.equal(S({ vatMode: "ej_angivet", laborSumSek: 30000, materialSumSek: 0, travelSumSek: 0, otherSumSek: 4000, totalBeforeRotSek: 42500 }).status, "fraga"); // Z06
  assert.equal(S({ laborSumSek: null, materialSumSek: null, totalBeforeRotSek: 20000 }), undefined); // ingen uppdelning alls: "uppdelning" redovisar
  // exakt: 1 kr avrundning ryms, 2 kr gör det inte
  assert.equal(S({ laborSumSek: 30000, materialSumSek: 0, travelSumSek: 0, otherSumSek: 0, totalBeforeRotSek: 30001 }).status, "ok");
  assert.equal(S({ laborSumSek: 30000, materialSumSek: 0, travelSumSek: 0, otherSumSek: 0, totalBeforeRotSek: 30002 }).status, "fel");
});

test("framkörning och badrum: oförändrade spärrar (inget antaget besök, ingen extrapolation)", () => {
  const a = (o) => checkNormalAddons(sanitizeExtracted({ ...BASE, ...o }).x, REF).find((c) => c.id === "framkorning");
  assert.equal(a({ travelSumSek: 500, travelVisits: null }).status, "fraga");
  assert.equal(a({ travelSumSek: 500, travelVisits: 1 }).status, "ok");
  assert.equal(a({ travelSumSek: 500, travelVisits: 2 }).status, "flagga");
  assert.equal(a({ travelSumSek: 3600, travelVisits: 8 }).status, "ok");
  const b = (area) => compareToBands(sanitizeExtracted({ ...BASE, jobType: "badrum", areaM2: area, totalBeforeRotSek: 200000 }).x, REF).find((c) => c.id === "projekt").mode;
  assert.equal(b(3.8), "ej_bedombar"); assert.equal(b(4), "inom"); assert.equal(b(6), "inom"); assert.equal(b(6.5), "ej_bedombar");
});

test("sammanhang: reparation i nybyggd villa ger kontextfråga, aldrig 'bygga en helt ny bostad'", () => {
  const O = { propertyType: "smahus", jobType: "tak", laborSumSek: 10000, rotAmountSek: 3000, rotPersons: 1 };
  const l4 = get(run({ ...O, workDescription: "Reparera läcka i nybyggd villa" }), "rot_undantag");   // L04
  assert.equal(l4.status, "fraga");
  assert.doesNotMatch(run({ ...O, workDescription: "Reparera läcka i nybyggd villa" }).map((r) => r.text).join("\n"), /bygga en helt ny bostad/i);
  // uttrycklig arbetsart reparation/underhåll: ingen undantagsfråga alls för en nybyggd villa
  assert.equal(st({ ...O, workDescription: "Reparera läcka i nybyggd villa", workNature: "reparation" }, "rot_undantag"), "SAKNAS");
  // äkta nybyggnad: källstödd FRÅGA (inte flagga), skild från beloppsmatematiken
  const nb = get(run({ ...O, jobType: "annat", workDescription: "Nybyggnad av fristående garage", workNature: "nybyggnad", workLocation: "utvandigt" }), "rot_undantag");
  assert.equal(nb.status, "fraga"); assert.match(nb.text, /Beräkningen av beloppet är en sak/);
  // ordträff utan arbetsart: fråga, inte tyst klassning
  assert.equal(st({ ...O, jobType: "annat", workDescription: "Nybyggnation av villa" }, "rot_undantag"), "fraga");
  // befintligt garage (komplement) är inte generellt uteslutet
  assert.equal(st({ ...O, workDescription: "Byte av takpannor på fristående garage", workNature: "reparation" }, "rot_undantag"), "SAKNAS");
  assert.equal(st({ ...O, workDescription: "Byte av takpannor på fristående garage" }, "rot_undantag"), "SAKNAS"); // L01
  // övriga undantag oförändrade
  assert.equal(st({ ...O, jobType: "annat", workDescription: "Nytt staket runt tomten" }, "rot_undantag"), "flagga");
  // ROT 0 kr: inga undantagsfrågor
  assert.equal(st({ ...O, rotAmountSek: 0, workDescription: "Nybyggnation av villa" }, "rot_undantag"), "SAKNAS");
});

test("sammanhang: bostadsrätt + tak/fönster/fasad avgörs av insida/utsida, inte av jobbtypen", () => {
  const B = { propertyType: "bostadsratt", laborSumSek: 10000, rotAmountSek: 3000, rotPersons: 1 };
  assert.equal(st({ ...B, jobType: "fonster", workDescription: "Byte av hela fönster" }, "rot_undantag"), "fraga");                 // L02
  assert.equal(st({ ...B, jobType: "fonster", workLocation: "utvandigt" }, "rot_undantag"), "fraga");
  assert.equal(st({ ...B, jobType: "fonster", workNature: "underhall", workLocation: "invandigt" }, "rot_undantag"), "SAKNAS");     // CONTEXT-02
  assert.equal(st({ ...B, jobType: "fonster", workDescription: "Föreningens fönster" }, "rot_undantag"), "flagga");                  // L03: ordlista oförändrad
  assert.equal(st({ ...B, jobType: "badrum" }, "rot_undantag"), "SAKNAS");
  assert.equal(st({ ...B, propertyType: "smahus", jobType: "fonster" }, "rot_undantag"), "SAKNAS");
});

test("förskott: bara uttryckligt true ger fråga; false och null ger ingen regel; ingen olaglighetsstämpel", () => {
  assert.equal(st({ advancePayment: true, laborSumSek: 10000 }, "forskott"), "fraga");
  assert.equal(st({ advancePayment: false, laborSumSek: 10000 }, "forskott"), "SAKNAS");
  assert.equal(st({ advancePayment: null, laborSumSek: 10000 }, "forskott"), "SAKNAS");
  assert.equal(st({ laborSumSek: 10000 }, "forskott"), "SAKNAS");
  const t = get(run({ advancePayment: true }), "forskott").text;
  assert.match(t, /§§ 41 och 45/); assert.match(t, /småhusentreprenad \(§ 52\)/);
  assert.match(t, /bedömer vi inte/);
  assert.doesNotMatch(t, /olaglig|förbjud/i);
});

test("schema + sanerare: tre nullable kontextfält; gamla svar utan fält blir null; ogiltigt blir null och markeras", () => {
  for (const k of ["workNature", "workLocation", "advancePayment"]) {
    assert.ok(EXTRACTED_SCHEMA.properties[k], k);
    assert.ok(EXTRACTED_SCHEMA.required.includes(k), k);
    assert.ok(JSON.stringify(EXTRACTED_SCHEMA.properties[k].type).includes("null"), k);
  }
  assert.deepEqual(EXTRACTED_SCHEMA.properties.workNature.enum, ["nybyggnad", "reparation", "underhall", "ombyggnad", "tillbyggnad", null]);
  assert.deepEqual(EXTRACTED_SCHEMA.properties.workLocation.enum, ["invandigt", "utvandigt", "blandat", null]);
  const old = sanitizeExtracted({ jobType: "tak", vatMode: "inkl" });
  assert.equal(old.x.workNature, null); assert.equal(old.x.workLocation, null); assert.equal(old.x.advancePayment, null);
  assert.equal(old.issues.length, 0, "gamla svar utan fälten är inget fel");
  const bad = sanitizeExtracted({ vatMode: "inkl", workNature: "bygga", workLocation: 5, advancePayment: "ja" });
  assert.equal(bad.x.workNature, null); assert.equal(bad.x.workLocation, null); assert.equal(bad.x.advancePayment, null);
  assert.deepEqual(bad.issues.sort(), ["advancePayment", "workLocation", "workNature"]);
  assert.equal(sanitizeExtracted({ vatMode: "inkl", advancePayment: false }).x.advancePayment, false);
});

// De tre frysta syntetiska sammanhangstexterna: förväntade avlästa fält (satta före kod) går genom sanerare + regler.
test("extraktionsfacit CONTEXT-01..03: avlästa fält → rätt regelutfall (deterministiskt, inte bevis för verklig AI-läsning)", () => {
  const c1 = { ...BASE, propertyType: "smahus", jobType: "tak", workNature: "reparation", workLocation: "utvandigt", advancePayment: false,
    workDescription: "Byte av takpannor på befintligt fristående garage", laborSumSek: 100000, materialSumSek: 0, travelSumSek: 0, otherSumSek: 0,
    totalBeforeRotSek: 100000, rotAmountSek: 30000, rotPersons: 1, plannedPaymentDate: "2026-11-20" };
  const r1 = run(c1);
  assert.equal(get(r1, "rot_belopp").status, "ok");
  assert.equal(get(r1, "rot_undantag"), undefined);
  assert.equal(get(r1, "forskott"), undefined);
  assert.equal(get(r1, "summa").status, "ok");
  const c2 = { ...BASE, propertyType: "bostadsratt", jobType: "fonster", workNature: "underhall", workLocation: "invandigt", advancePayment: null,
    workDescription: "Byte av tätningslister på insidan", laborSumSek: 10000, materialSumSek: 0, travelSumSek: 0, otherSumSek: 0, totalBeforeRotSek: 10000,
    rotAmountSek: 3000, rotPersons: 1, plannedPaymentDate: null, quoteDate: "2026-10-16" };
  const r2 = run(c2);
  assert.equal(get(r2, "rot_undantag"), undefined);
  assert.equal(get(r2, "forskott"), undefined);
  assert.equal(get(r2, "rot_belopp").status, "ok");
  const c3 = { ...BASE, propertyType: "smahus", jobType: "annat", workNature: "nybyggnad", workLocation: "utvandigt", advancePayment: true,
    workDescription: "Nybyggnad av fristående garage", laborSumSek: 100000, materialSumSek: 30000, travelSumSek: 0, otherSumSek: 0, totalBeforeRotSek: 130000,
    rotAmountSek: 30000, rotPersons: 1, plannedPaymentDate: "2026-12-15" };
  const r3 = run(c3);
  assert.equal(get(r3, "rot_undantag").status, "fraga");
  assert.equal(get(r3, "forskott").status, "fraga");
  assert.equal(get(r3, "rot_belopp").status, "ok");
});
