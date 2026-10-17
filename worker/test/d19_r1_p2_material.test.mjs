// D19-R1-P2 (Claude QA 1792189484 / 1792198687): ett beloppsfel är inget belägg för att avdraget räknats på material eller resor.
// Fyra QA-fall + sex provpar ur SAMRAD/D19_CP4_MATERIAL_CAUSAL_ADVICE.md. Förväntningar är handskrivna literaler, inte återberäknade.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runRules } from "../src/rules.js";
import { sanitizeExtracted } from "../src/sanitize.js";

const REF = JSON.parse(readFileSync(new URL("../src/reference.json", import.meta.url), "utf8"));
const BASE = { vatMode: "inkl", totalVatBasis: "inkl", priceType: "fast", customerType: "privatperson", quoteDate: "2026-10-16",
  plannedPaymentDate: "2026-10-16", laborSumSek: 100000, materialSumSek: 0, travelSumSek: 0, otherSumSek: 0, rotPersons: 1 };
const run = (o) => runRules(sanitizeExtracted({ ...BASE, ...o }).x, REF);
const st = (r, id) => { const c = r.find((c) => c.id === id); return c ? c.status : undefined; };
const rm = (o) => st(run(o), "rot_material");
const rb = (o) => st(run(o), "rot_belopp");
const FORBIDDEN = /räknar avdrag på annat än arbete|motsvarar avdrag på hela summan/;

test("QA-fall 1: material 0 utan flagga, ROT 30 000,01 ⇒ bara beloppsfelet", () => {
  const o = { rotAmountSek: 30000.01 };
  assert.equal(rb(o), "fel"); assert.equal(rm(o), undefined);
  assert.match(run(o).find((c) => c.id === "rot_belopp").text.replace(/ /g, " "), /0,01 kr över/);
});
test("QA-fall 2: material 1 000, ROT 30 000,01 ⇒ beloppsfel + högst neutral fråga, aldrig säkert materialfel", () => {
  const r = run({ materialSumSek: 1000, rotAmountSek: 30000.01 });
  assert.equal(st(r, "rot_belopp"), "fel"); assert.equal(st(r, "rot_material"), "fraga");
  const c = r.find((c) => c.id === "rot_material");
  assert.doesNotMatch(c.text, FORBIDDEN); assert.match(c.text, /Fråga hur ROT-underlaget och procentsatsen har räknats/);
});
test("QA-fall 3: explicit true ⇒ säkert materialfel kvar", () => {
  assert.equal(rb({ rotAmountSek: 30000.01, rotOnMaterialOrTravel: true }), "fel");
  assert.equal(rm({ rotAmountSek: 30000.01, rotOnMaterialOrTravel: true }), "fel");
});
test("QA-fall 4: explicit false ⇒ ingen säker motsatt slutsats (inget materialfel), beloppsfelet kvar", () => {
  assert.equal(rb({ rotAmountSek: 30000.01, rotOnMaterialOrTravel: false }), "fel");
  assert.equal(rm({ rotAmountSek: 30000.01, rotOnMaterialOrTravel: false }), undefined);
  assert.equal(rm({ materialSumSek: 20000, rotAmountSek: 36000, rotOnMaterialOrTravel: false }), undefined);
});

test("Par 1: betalning 2026, material 0, ROT 30 000 resp. 30 000,01 ⇒ ok resp. fel 0,01 över; inget materialfel", () => {
  assert.equal(rb({ rotAmountSek: 30000 }), "ok"); assert.equal(rm({ rotAmountSek: 30000 }), undefined);
  assert.equal(rb({ rotAmountSek: 30000.01 }), "fel"); assert.equal(rm({ rotAmountSek: 30000.01 }), undefined);
});
test("Par 2: ROT 30 000,01, material 0 resp. 1 000 ⇒ samma beloppsfel; positiv post aktiverar inget hårdfel", () => {
  for (const m of [0, 1000]) { assert.equal(rb({ materialSumSek: m, rotAmountSek: 30000.01 }), "fel"); assert.notEqual(rm({ materialSumSek: m, rotAmountSek: 30000.01 }), "fel"); }
});
test("Par 3: material 20 000, ROT 36 000, flagga saknas resp. true ⇒ beloppsfel 6 000 i båda; säker orsak bara vid true", () => {
  const a = run({ materialSumSek: 20000, rotAmountSek: 36000 }), b = run({ materialSumSek: 20000, rotAmountSek: 36000, rotOnMaterialOrTravel: true });
  for (const r of [a, b]) { assert.equal(st(r, "rot_belopp"), "fel"); assert.match(r.find((c) => c.id === "rot_belopp").text.replace(/ /g, " "), /6 000 kr över/); }
  assert.equal(st(a, "rot_material"), "fraga"); assert.equal(st(b, "rot_material"), "fel");
});
test("Par 4: material 20 000, ROT 36 000, betalning okänd resp. 2025-12-15 ⇒ fråga resp. ok; inget materialfel", () => {
  const u = { materialSumSek: 20000, rotAmountSek: 36000, plannedPaymentDate: null };
  assert.equal(rb(u), "fraga"); assert.equal(rm(u), undefined);
  const w = { ...u, plannedPaymentDate: "2025-12-15" };
  assert.equal(rb(w), "ok"); assert.equal(rm(w), undefined);
});
test("Par 5: material 20 000, ROT 36 000, explicit false resp. true ⇒ false aldrig materialfel, true kvar", () => {
  assert.equal(rm({ materialSumSek: 20000, rotAmountSek: 36000, rotOnMaterialOrTravel: false }), undefined);
  assert.equal(rm({ materialSumSek: 20000, rotAmountSek: 36000, rotOnMaterialOrTravel: true }), "fel");
  assert.equal(rb({ materialSumSek: 20000, rotAmountSek: 36000, rotOnMaterialOrTravel: false }), "fel");
});
test("Par 6: betalning okänd, material 100 000, ROT 60 000 ⇒ säkert beloppsfel; orsak säker bara vid true; persontak separat", () => {
  const o = { materialSumSek: 100000, rotAmountSek: 60000, plannedPaymentDate: null };
  const a = run(o), b = run({ ...o, rotOnMaterialOrTravel: true });
  assert.equal(st(a, "rot_belopp"), "fel"); assert.equal(st(b, "rot_belopp"), "fel");
  assert.equal(st(a, "rot_material"), "fraga"); assert.equal(st(b, "rot_material"), "fel");
  assert.equal(st(a, "rot_tak"), "fel"); assert.equal(st(b, "rot_tak"), "fel");   // 1 person, 60 000 > 50 000 – oberoende av materialfrågan
});
test("Ingen härledd rot_material-rad bär längre den gamla säkra orsakstexten", () => {
  for (const o of [{ rotAmountSek: 30000.01 }, { materialSumSek: 1000, rotAmountSek: 30000.01 }, { materialSumSek: 20000, rotAmountSek: 36000 },
    { materialSumSek: 100000, rotAmountSek: 60000, plannedPaymentDate: null }, { materialSumSek: 66666.67, rotAmountSek: 50000 }]) {
    const c = run(o).find((c) => c.id === "rot_material");
    if (c) { assert.notEqual(c.status, "fel"); assert.doesNotMatch(c.text, FORBIDDEN); }
  }
});
