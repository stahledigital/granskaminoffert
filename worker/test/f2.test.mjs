// F2 offline: prövar att facit-kolumnen "expectRules" stämmer mot koden givet förväntad avläsning.
// Mäter INTE AI-träffsäkerhet (det kräver betalt prov som inte är beslutat: EJ TESTAT).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPriceReport } from "../src/index.js";
const facit = JSON.parse(readFileSync(new URL("./f2/facit.json", import.meta.url), "utf8"));
// Förväntad avläsning kompletteras med de fält facit anger; resten är null.
const EXTRA = {
  "F2-01-brutto-fore-rot": { laborSumSek: 21420, materialSumSek: 18900, otherSumSek: 2500, totalVatBasis: "inkl", areaM2: 32, jobType: "tak" },
  "F2-02-endast-att-betala": { laborSumSek: 21420, materialSumSek: 18900, otherSumSek: 2500, rotAmountSek: 6426, totalVatBasis: "inkl", priceType: "fast" },
  "F2-03-omarkt-total-med-rot": { jobType: "fonster", priceType: "fast", vatMode: "inkl", unitCount: 8 },
  "F2-04-exkl-moms": { laborSumSek: 32000, materialSumSek: 16000, rotAmountSek: 12000, hours: 50, trades: ["snickare"] },
  "F2-05-moms-saknas": { laborSumSek: 24000, materialSumSek: 4000, rotAmountSek: 7200, totalSumSek: 28000, hourlyRateSek: 600, jobType: "malning", areaM2: 60 },
  "F2-06-bergvarme-smahus": { vatMode: "inkl", rotAmountSek: 21000, quoteDate: "2026-09-01" },
  "F2-07-bergvarme-bostadsratt": { jobType: "bergvarme", priceType: "fast", vatMode: "inkl", totalBeforeRotSek: 200000, totalVatBasis: "inkl", rotAmountSek: 21000, quoteDate: "2026-09-01" },
  "F2-08-badrum-12m2": { vatMode: "inkl", priceType: "fast", totalBeforeRotSek: 200000, totalVatBasis: "inkl" },
  "F2-09-injektion": { vatMode: "inkl" },
  "F2-10-rot-pa-material": { jobType: "badrum", laborSumSek: 120000, materialSumSek: 60000, rotAmountSek: 54000, vatMode: "inkl", priceType: "fast", areaM2: 5, quoteDate: "2026-08-20" },
};
for (const c of facit.cases) {
  test(`F2 offline: ${c.id}`, () => {
    const x = { ...EXTRA[c.id], ...c.expectExtracted };
    const rep = buildPriceReport(x);
    const all = [...rep.checked.map((r) => [r.id, r.status]), ...rep.compared.map((r) => [r.id, r.mode]), ...rep.cannotAssess.map((r) => [r.id || r.title, "ej_bedombar"])];
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
