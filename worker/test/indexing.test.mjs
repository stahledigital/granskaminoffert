// F8 (PRISUTBYTE I01–I06): indexering från fast basnivå, idempotens och säkra stopp. Offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planIndex, rebase, floorInclVat, snapshotBands, isPeriod } from "../scripts/indexing.mjs";

const REF0 = JSON.parse(readFileSync(new URL("../src/reference.json", import.meta.url), "utf8"));
const EVID = "Syntetiskt belägg för test: banden avser BKI-nivån 2026M08.";
const based = (period = "2026M08") => rebase(REF0, { period, evidence: EVID }).ref;
const series = (target, tl, bl = 100, bp = "2026M08") => ({ basePeriod: bp, baseLabor: bl, targetPeriod: target, targetLabor: tl });
const sn = (r) => r.hourly.snickare.inclVat.normal;

test("I04/okänd basperiod: den levererade filen indexeras inte alls", () => {
  assert.equal(REF0.indexing.basePeriod, null);
  const r = planIndex(REF0, series("2026M09", 102.7));
  assert.deepEqual([r.ok, r.reason], [false, "okand_basperiod"]);
});

test("I02: varje period räknas från samma basnivå (550 → 560 → 580), aldrig ovanpå förra", () => {
  const b = based();
  assert.deepEqual(sn(b), [550, 800]);
  const a1 = planIndex(b, series("2026M09", 102.7));
  assert.equal(a1.ok, true);
  assert.equal(sn(a1.ref)[0], 560); // 550 × 1,027 = 564,85 → 560
  const a2 = planIndex(a1.ref, series("2026M10", 105.4));
  assert.equal(sn(a2.ref)[0], 580); // 550 × 1,054 = 579,7 → 580 (inte 560 × 1,054 = 590)
  // hoppar man direkt till senaste perioden blir resultatet detsamma
  assert.deepEqual(sn(planIndex(b, series("2026M10", 105.4)).ref), sn(a2.ref));
  // exkl.-bandet följer inkl.
  assert.equal(a2.ref.hourly.snickare.exclVat.normal[0], Math.round(580 / 1.25 / 10) * 10);
});

test("I01/I03: samma period igen ändrar ingenting – inte heller med force", () => {
  const b = based();
  const a1 = planIndex(b, series("2026M09", 102.7)).ref;
  for (const force of [false, true]) {
    const again = planIndex(a1, series("2026M09", 102.7), { force });
    assert.equal(again.ok, true);
    assert.equal(again.noop, true);
    assert.deepEqual(again.ref, a1);
  }
  // en körning i nästa kalendermånad med samma indexperiod (BKI ej uppdaterat) ändrar inte heller
  assert.equal(planIndex(a1, series("2026M09", 102.7), { force: true }).noop, true);
});

test("I04: saknat, noll, icke-ändligt index och bakåtgående/felaktig period stoppar utan ändring", () => {
  const b = based();
  const snap = JSON.stringify(b);
  for (const bad of [series("2026M09", 0), series("2026M09", NaN), series("2026M09", Infinity), series("2026M09", undefined), series("2026M09", -3), series("2026M09", 102, 0), series("2026-09", 102), series("2026M09", 102, 100, "2025M08")]) {
    const r = planIndex(b, bad, { force: true });
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
  const a1 = planIndex(b, series("2026M09", 102.7)).ref;
  assert.equal(planIndex(a1, series("2026M08", 101), { force: true }).reason, "index_bakat");
  assert.equal(JSON.stringify(b), snap, "indata muterades");
});

test("I05: projektband med basis total indexeras inte (vikten saknar källa) och markeras; arbetsband indexeras", () => {
  const b = based();
  const r = planIndex(b, series("2026M09", 110)).ref;
  assert.deepEqual(r.projects.badrum.normal, REF0.projects.badrum.normal);
  assert.match(r.projects.badrum.indexNote, /UNVERIFIED/);
  assert.notDeepEqual(r.projects.malning.normal, REF0.projects.malning.normal); // basis arbete
  assert.equal(r.projects.malning.indexNote, undefined);
});

test("Rebase kräver belägg och period, och är en separat åtgärd som inte rör banden", () => {
  assert.equal(rebase(REF0, { period: "2026M08", evidence: "kort" }).reason, "belagg_saknas");
  assert.equal(rebase(REF0, { period: "2026-08", evidence: EVID }).reason, "ogiltig_period");
  const b = rebase(REF0, { period: "2026M08", evidence: EVID });
  assert.equal(b.ok, true);
  assert.deepEqual(b.ref.hourly, REF0.hourly);
  assert.deepEqual(b.ref.projects, REF0.projects);
  assert.equal(rebase(b.ref, { period: "2026M09", evidence: EVID }).reason, "samma_belagg");
  assert.ok(isPeriod("2026M08") && !isPeriod("2026M13") && !isPeriod("202608"));
});

test("I06: golvformeln och metodtexten stämmer med varandra (P10/174 × tillväxt × 1,55 × 1,25, nedåt till 10 kr)", () => {
  assert.equal(floorInclVat(30000, 0), Math.floor((30000 / 174) * 1.03 * 1.55 * 1.25 / 10) * 10);
  assert.equal(floorInclVat(30000, 1), Math.floor((30000 / 174) * 1.03 * 1.03 * 1.55 * 1.25 / 10) * 10);
  const m = REF0.hourly._method;
  assert.match(m, /10:e percentil/);
  assert.match(m, /174/);
  assert.match(m, /1,55/);
  assert.match(m, /nedåt/);
  assert.doesNotMatch(m, /0,8 debiteringsgrad\)/); // den gamla formeln "/ 0,8"
  assert.doesNotMatch(m, /\/ 0,8/);
});
