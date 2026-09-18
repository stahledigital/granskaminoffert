// PRISUNDERLAG rev 4: högst ett års uppräkning, plattsättare → murare när 7122 saknas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { valjLon } from "../scripts/lon_val.mjs";

const w = (year, monthly) => ({ year: String(year), monthly });

test("eget yrke med årets siffra används som det är", () => {
  const r = valjLon("plattsattare", "7122", { "7122": w(2026, 40000), "7112": w(2026, 41000) }, 2026);
  assert.deepEqual([r.ok, r.w.monthly, r.arBakom, r.proxy], [true, 40000, 0, null]);
});

test("ett år gammal siffra räknas upp ett år, ingen proxy", () => {
  const r = valjLon("plattsattare", "7122", { "7122": w(2025, 40000), "7112": w(2026, 41000) }, 2026);
  assert.deepEqual([r.ok, r.w.monthly, r.arBakom, r.proxy], [true, 40000, 1, null]);
});

test("7122 saknas i 2026 års statistik (senaste 2024) → murare 7112, märkt proxy", () => {
  const r = valjLon("plattsattare", "7122", { "7122": w(2024, 38000), "7112": w(2026, 41000), "7111": w(2026, 40000) }, 2026);
  assert.deepEqual([r.ok, r.w.monthly, r.arBakom, r.proxy, r.proxyCode], [true, 41000, 0, "murare", "7112"]);
});

test("7122 saknas helt i hämtade år → murare, inte 'golvet oförändrat'", () => {
  const r = valjLon("plattsattare", "7122", { "7112": w(2026, 41000) }, 2026);
  assert.equal(r.ok, true);
  assert.equal(r.proxy, "murare");
});

test("både 7122 och murare för gamla → stopp", () => {
  const r = valjLon("plattsattare", "7122", { "7122": w(2023, 38000), "7112": w(2024, 39000) }, 2026);
  assert.equal(r.ok, false);
  assert.match(r.reason, /murare/);
});

test("yrke utan reserv: två år gammal siffra räknas inte upp två år → stopp", () => {
  const r = valjLon("snickare", "7111", { "7111": w(2024, 40000) }, 2026);
  assert.equal(r.ok, false);
  assert.match(r.reason, /2 år gammal/);
});
