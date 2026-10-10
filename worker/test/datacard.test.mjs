import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSourceCard, datacardsEnabled, stripReviewText, MAX_LATEST } from "../src/datacard.js";

const rv = (n) => Array.from({ length: n }, (_, i) => ({ createdAt: `2026-09-${String(20 - i).padStart(2, "0")}T10:00:00Z`, rating: (i % 5) + 1, text: `Omdöme ${i} <b>x</b> https://x.example` }));

test("avstängd som standard; kräver både flagga och verifiering", () => {
  assert.equal(buildSourceCard({ source: "google", status: "ok" }).state, "ej_aktiverad");
  assert.equal(datacardsEnabled({ COMPARE_DATACARDS: "1" }), false);
  assert.equal(datacardsEnabled({ COMPARE_DATACARDS: "1", COMPARE_DATACARDS_VERIFIED: "1" }), true);
});
test("laddat kort: total och antal skilt från senaste; max 5; ingen omsortering; text rensas", () => {
  const c = buildSourceCard({ source: "google", status: "ok", ratingTotal: 4.66, ratingCount: 120, orderedBy: "newest", reviews: rv(8) }, { enabled: true });
  assert.equal(c.state, "laddad"); assert.equal(c.ratingTotal, 4.7); assert.equal(c.ratingCount, 120);
  assert.equal(c.latest.length, MAX_LATEST); assert.equal(c.latest[0].date, "2026-09-20"); assert.equal(c.latest[4].date, "2026-09-16");
  assert.ok(!/[<>]|example/.test(c.latest[0].text)); assert.equal(c.lowN, false);
});
test("levererat i annan ordning än nyast → inga 'senaste' påstås", () => {
  const c = buildSourceCard({ source: "google", status: "ok", ratingTotal: 4.5, ratingCount: 50, orderedBy: "annat", reviews: rv(5) }, { enabled: true });
  assert.equal(c.latestState, "ej_senaste_tillgangliga"); assert.deepEqual(c.latest, []);
});
test("noll omdömen, få omdömen, fel och oklar identitet är fyra olika tillstånd", () => {
  const e = { enabled: true };
  assert.equal(buildSourceCard({ source: "trustpilot", status: "ok", ratingCount: 0, reviews: [] }, e).latestState, "inga_omdomen");
  assert.equal(buildSourceCard({ source: "trustpilot", status: "ok", ratingTotal: 5, ratingCount: 3, orderedBy: "newest", reviews: rv(3) }, e).lowN, true);
  assert.equal(buildSourceCard({ source: "trustpilot", status: "fel" }, e).state, "fel");
  assert.equal(buildSourceCard({ source: "trustpilot", status: "oklar" }, e).state, "oklar_identitet");
  const k = buildSourceCard({ source: "google", status: "kandidater", candidates: [{ name: "Bygg AB", place: "Växjö" }, { name: "Bygg AB", place: "Alvesta" }] }, e);
  assert.equal(k.state, "bekrafta_foretag"); assert.equal(k.candidates.length, 2);
  assert.equal(buildSourceCard({ source: "google", status: "kandidater", candidates: [] }, e).state, "oklar_identitet");
});
test("ogiltiga omdömen (datum/betyg) filtreras; text lämnar aldrig servern mot modell/PDF", () => {
  const c = buildSourceCard({ source: "google", status: "ok", ratingTotal: 4, ratingCount: 9, orderedBy: "newest", reviews: [{ createdAt: "igår", rating: 5, text: "a" }, { createdAt: "2026-09-01", rating: 9, text: "b" }, { createdAt: "2026-09-01", rating: 4, text: "hemlig text" }] }, { enabled: true });
  assert.equal(c.latest.length, 1);
  assert.ok(!JSON.stringify(stripReviewText({ sourceCards: [{ sources: [c] }] })).includes("hemlig text"));
});
