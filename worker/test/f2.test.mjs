// F2 offline: prövar att facit-kolumnen "expectRules" stämmer mot koden givet förväntad avläsning.
// Mäter INTE AI-träffsäkerhet (det kräver betalt prov som inte är beslutat: EJ TESTAT).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPriceReport } from "../src/index.js";
import { loadF2Cases } from "../../scripts/f2_run.mjs";
// Original-facit + versionerat D19-V2-förväntanslager (facit_v2_overlay.json). Originalinputs i f2/extra.mjs är orörda.
const facit = { cases: loadF2Cases() };
// Förväntad avläsning kompletteras med de fält facit anger; resten är null.
import { EXTRA } from "./f2/extra.mjs";
for (const c of facit.cases) {
  test(`F2 offline: ${c.id}`, () => {
    const x = { ...EXTRA[c.id], ...c.expectExtracted };
    const rep = buildPriceReport(x);
    const all = [...rep.checked.map((r) => [r.id, r.status]), ...rep.compared.map((r) => [r.id, r.mode]), ...rep.cannotAssess.map((r) => [r.id || ({ Summering: "summa", Betalningsdatum: "betaldatum" })[r.title] || r.title, "ej_bedombar"])];
    const cmp = (id) => {
      const hit = all.find(([k]) => k === id);
      if (hit) return hit[1];
      // regler som avstår (saknas) syns inte alls
      return "saknas";
    };
    for (const [id, want] of Object.entries(c.expectRules)) {
      const got = id === "projekt" ? (rep.cannotAssess.some((r) => /Spannet|jämföra/.test(r.text)) ? "ej_bedombar" : cmp(id)) : cmp(id);
      assert.equal(got, want, `${c.id} ${id}`);
    }
  });
}
