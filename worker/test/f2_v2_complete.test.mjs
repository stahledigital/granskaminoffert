// D19-V2: fullständiga, uttryckligen ÄNDRADE F2-inputs som egna namngivna fall. De ersätter aldrig originalfallen (f2/facit.json, f2/extra.mjs):
// originaltexterna anger inga resor/övrigt/datum, och null är inte 0 – därför är originalens V2-utfall fråga/ej fullt bedömd (se facit_v2_overlay.json).
// Här är texten uttryckligen kompletterad med de uppgifter som V1-facit antog, och förväntan är den ursprungliga V1-förväntan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPriceReport } from "../src/index.js";
import { EXTRA } from "./f2/extra.mjs";

const facit = JSON.parse(readFileSync(new URL("./f2/facit.json", import.meta.url), "utf8"));
const byId = Object.fromEntries(facit.cases.map((c) => [c.id, c]));

const COMPLETE = [
  {
    id: "F2-01-komplett",
    base: "F2-01-brutto-fore-rot",
    amendedText: byId["F2-01-brutto-fore-rot"].text + " Resor 0 kr, övrigt anges i containern. Offertdatum 2026-09-10.",
    add: { travelSumSek: 0, quoteDate: "2026-09-10" },
    expect: { summa: "ok", rot_belopp: "ok" },
  },
  {
    id: "F2-02-komplett",
    base: "F2-02-endast-att-betala",
    amendedText: byId["F2-02-endast-att-betala"].text + " Resor 0 kr.",
    add: { travelSumSek: 0 },
    expect: { summa: "ok" },
  },
  {
    id: "F2-04-komplett",
    base: "F2-04-exkl-moms",
    amendedText: byId["F2-04-exkl-moms"].text + " Resor 0 kr, övrigt 0 kr. Offertdatum 2026-09-10.",
    add: { travelSumSek: 0, otherSumSek: 0, quoteDate: "2026-09-10" },
    expect: { moms: "ok", rot_belopp: "ok", summa: "ok" },
  },
];

const statuses = (rep) => {
  const m = new Map();
  for (const r of rep.checked) m.set(r.id, r.status);
  for (const r of rep.cannotAssess) m.set(r.id || ({ Summering: "summa" })[r.title] || r.title, "ej_bedombar");
  return m;
};

test("F2-integritet: originalinputs i f2/extra.mjs är inte berikade med påhittade 0/datum", () => {
  for (const id of ["F2-01-brutto-fore-rot", "F2-02-endast-att-betala", "F2-04-exkl-moms"]) {
    assert.equal("travelSumSek" in EXTRA[id], false, `${id}: travelSumSek får inte läggas till i originalet`);
    assert.equal("quoteDate" in EXTRA[id], false, `${id}: quoteDate får inte läggas till i originalet`);
  }
  assert.equal("otherSumSek" in EXTRA["F2-04-exkl-moms"], false);
});

test("F2-original F2-01/F2-04 ger ROT-fråga och ej fullt bedömd summering (V2), original F2-02 ej fullt bedömd summering", () => {
  for (const [id, want] of [["F2-01-brutto-fore-rot", { rot_belopp: "fraga", summa: "ej_bedombar" }], ["F2-04-exkl-moms", { rot_belopp: "fraga", summa: "ej_bedombar" }], ["F2-02-endast-att-betala", { summa: "ej_bedombar" }]]) {
    const m = statuses(buildPriceReport({ ...EXTRA[id], ...byId[id].expectExtracted }));
    for (const [k, v] of Object.entries(want)) assert.equal(m.get(k), v, `${id} ${k}`);
  }
});

for (const c of COMPLETE) {
  test(`F2 komplett (ändrad text, eget fall): ${c.id}`, () => {
    assert.notEqual(c.amendedText, byId[c.base].text, "ändrad text ska vara uttryckligen annorlunda än originalet");
    const m = statuses(buildPriceReport({ ...EXTRA[c.base], ...c.add, ...byId[c.base].expectExtracted }));
    for (const [k, v] of Object.entries(c.expect)) assert.equal(m.get(k), v, `${c.id} ${k}`);
  });
}
