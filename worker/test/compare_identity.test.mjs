// D11: utställaridentitet ur dokumentet – facit för saknat/avläsningsfel/roll/personnummerliknande/filial/original, samt "uppgifter att reda ut".
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeOffer, SUBMIT_OFFER_TOOL, extractSystemPrompt, EXTRACT_VERSION } from "../src/compare_extract.js";
import { luhnOk, identityGroups, OPEN_SCOPE_IDS } from "../src/compare_identity.js";
import { compareOffers, offerLabels } from "../src/compare_engine.js";
import { fixtureResponse } from "./helpers/compare_env.mjs";

const ALL = { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" };
const off = (issuer, extra = {}) => sanitizeOffer(fixtureResponse({ extracted: { totalBeforeRotSek: 100000, totalVatBasis: "inkl" }, scope: ALL, issuer, ...extra }));
const L = (n) => offerLabels([], n);

test("schema och prompt: issuer är obligatoriskt, strikt och skiljer utförare från kund/underleverantör/betalningsförmedlare; version höjd", () => {
  const s = SUBMIT_OFFER_TOOL.input_schema;
  assert.ok(s.required.includes("issuer")); assert.equal(s.properties.issuer.additionalProperties, false);
  for (const f of ["name", "orgnr", "address", "city", "phone", "web"]) assert.deepEqual(s.properties.issuer.properties[f].properties.status.enum, ["framgar", "framgar_inte", "ej_lasbar"]);
  const p = extractSystemPrompt();
  assert.match(p, /FÖRETAGET SOM GER OFFERTEN/); assert.match(p, /betalningsförmedlare/); assert.match(p, /kundens namn/);
  assert.equal(EXTRACT_VERSION, "avlasning-3");
});

test("komplett identitet (även när uppgifterna står i sidfot på sista sidan): komplett, belagd, ingen saknad; webb/omdömen saknas ≠ saknad uppgift", () => {
  const o = off({ web: null }); // ingen webbplats
  assert.equal(o.identity.state, "komplett"); assert.deepEqual(o.identity.missing, []);
  assert.equal(o.identity.fields.orgnr.value, "556016-0680"); assert.equal(o.identity.fields.orgnr.checkDigitOk, true);
  assert.equal(o.identity.fields.name.ref, "sidfot");
  const c = compareOffers([o, off({})], L(2));
  assert.ok(!c.differences.some((d) => d.category === "foretag"));
  assert.equal(c.offers[0].open.items.filter((i) => i.kind === "foretag").length, 0);
});

test("saknat namn/orgnr: väsentlig företagsuppgift saknas – offertbrist med fråga, räknas i uppgifter att reda ut", () => {
  const a = off({ name: null, orgnr: null }), b = off({});
  assert.equal(a.identity.state, "saknas"); assert.deepEqual(a.identity.missing, ["name", "orgnr"]);
  const c = compareOffers([a, b], L(2));
  const d = c.differences.find((x) => x.id === "ident:0");
  assert.ok(d); assert.equal(d.category, "foretag"); assert.match(d.text, /företagsnamn, organisationsnummer/);
  assert.ok(c.questions[0].questions.some((q) => q.id === "ident:name") && c.questions[0].questions.some((q) => q.id === "ident:orgnr"));
  assert.equal(c.offers[0].open.items.filter((i) => i.kind === "foretag").length, 2);
  assert.equal(c.offers[1].open.items.filter((i) => i.kind === "foretag").length, 0);
  assert.ok(!/dålig|oseriös|bedräg|kredit/i.test(d.text), "ingen ryktes-/kreditformulering");
});

test("kontakt = adress ELLER telefon: bara en av dem räcker; ingen av dem = saknas", () => {
  assert.equal(off({ address: null, city: null }).identity.state, "komplett");
  assert.equal(off({ phone: null }).identity.state, "komplett");
  const none = off({ address: null, city: null, phone: null });
  assert.equal(none.identity.state, "saknas"); assert.deepEqual(none.identity.missing, ["kontakt"]);
});

test("avläsningsfel ≠ saknas: oläsligt orgnr och svårläst fil ger 'kunde inte avläsas säkert', räknas inte som saknat och fil som inte går att läsa är inte 'bedömbar'", () => {
  const u = off({ orgnr: "?" });
  assert.equal(u.identity.state, "ej_avlast"); assert.deepEqual(u.identity.missing, []); assert.deepEqual(u.identity.unreadable, ["orgnr"]);
  const c = compareOffers([u, off({})], L(2));
  const d = c.differences.find((x) => x.id === "ident:0"); assert.match(d.text, /kunde inte avläsas säkert/); assert.match(d.text, /inte samma sak som att de saknas/);
  assert.equal(c.offers[0].open.items.filter((i) => i.kind === "foretag").length, 0);
  assert.equal(c.offers[0].open.unreadable.length, 1);
  // mycket svårläst fil + saknade fält: kan inte visa att något saknas
  const bad = off({ name: null, orgnr: null }, { readability: "svar" });
  assert.equal(bad.identity.state, "ej_avlast");
  const c2 = compareOffers([bad, off({})], L(2));
  assert.equal(c2.offers[0].open.assessable, false); assert.equal(c2.offers[0].open.count, null); // aldrig 0 eller sämst
});

test("orgnr: kontrollsiffra visar bara formell giltighet; fel kontrollsiffra/format ⇒ ej läsbart; personnummerliknande ⇒ enskild firma, aldrig automatiskt källförslag", () => {
  assert.equal(luhnOk("5560160680"), true); assert.equal(luhnOk("5560160681"), false);
  const bad = off({ orgnr: "556016-0681" });
  assert.equal(bad.identity.fields.orgnr.status, "ej_lasbar"); assert.equal(bad.identity.fields.orgnr.note, "kontrollsiffra"); assert.equal(bad.identity.fields.orgnr.value, null);
  assert.equal(bad.identity.state, "ej_avlast");
  const pers = off({ orgnr: "811228-9874", legalForm: "bolag", name: "Anna Svensson Bygg" });
  assert.equal(pers.identity.personal, true); assert.equal(pers.identity.legalForm, "enskild"); assert.equal(pers.identity.sendable, false);
  const co = off({});
  assert.equal(co.identity.personal, false); assert.equal(co.identity.sendable, true);
});

test("roll: osäkert om namnet är utföraren (kund/underleverantör/betalningsförmedlare) ⇒ bekräftelse krävs, inget automatiskt källförslag", () => {
  const o = off({ role: "osaker" });
  assert.equal(o.identity.sendable, false);
  const c = compareOffers([o, off({})], L(2));
  assert.ok(c.differences.some((d) => d.id === "ident_roll:0" && /kund, underleverantör eller betalningsförmedlare/.test(d.text)));
});

test("belägg krävs: uppgift utan sida/rad nedgraderas till framgår inte; ogiltig webb/telefon ⇒ ej läsbar; www-adress normaliseras till domän", () => {
  const raw = fixtureResponse({ extracted: { totalBeforeRotSek: 1 }, scope: ALL });
  raw.issuer.name = { status: "framgar", value: "Utan Belägg AB", page: null, ref: null };
  raw.issuer.web = { status: "framgar", value: "https://www.Bygg-Test.se/kontakt", page: 1, ref: "brevhuvud" };
  raw.issuer.phone = { status: "framgar", value: "12", page: 1, ref: "x" };
  const o = sanitizeOffer(raw);
  assert.equal(o.identity.fields.name.status, "framgar_inte"); assert.equal(o.identity.fields.name.note, "utan_belagg");
  assert.equal(o.identity.fields.web.value, "bygg-test.se");
  assert.equal(o.identity.fields.phone.status, "ej_lasbar");
});

test("filialer/koncernbolag slås inte ihop: samma orgnr = samma juridiska person; samma namn med olika orgnr = konflikt (visas, ingen sammanslagning)", () => {
  const a = off({}), b = off({ name: "Testbygg Öst AB" }), c3 = off({ orgnr: "556000-0167" });
  const grp = identityGroups([a.identity, b.identity, c3.identity].filter(Boolean));
  assert.ok(grp.links.some((l) => l.basis === "orgnr" && l.offers.length === 2));
  const x = off({ name: "Testbygg AB", orgnr: "556000-0167" });
  assert.equal(x.identity.fields.orgnr.status, "framgar");
  const g2 = identityGroups([a.identity, x.identity]);
  assert.equal(g2.conflicts[0].reason, "samma_namn_olika_orgnr"); assert.equal(g2.links.length, 0);
  const cc = compareOffers([a, x], L(2));
  assert.ok(cc.differences.some((d) => d.id.startsWith("ident_konflikt") && /olika organisationsnummer/.test(d.text)));
});

test("fast uppsättning för 'uppgifter att reda ut': samma poster för alla, jobbberoende poster (rivning, skydd, städning m.fl.) räknas aldrig som saknade", () => {
  assert.ok(!OPEN_SCOPE_IDS.includes("rivning") && !OPEN_SCOPE_IDS.includes("stadning") && !OPEN_SCOPE_IDS.includes("skydd") && !OPEN_SCOPE_IDS.includes("tillstand"));
  const a = sanitizeOffer(fixtureResponse({ extracted: { totalBeforeRotSek: 1, totalVatBasis: "inkl", priceType: "fast" }, scope: {} }));
  const c = compareOffers([a, a], L(2));
  const ids = c.offers[0].open.items.map((i) => i.id);
  assert.equal(c.offers[0].open.count, OPEN_SCOPE_IDS.length); // inget scope angivet: alla fasta omfattningsposter är oklara, pris klart, identitet komplett
  assert.ok(!ids.includes("scope:rivning")); assert.deepEqual(c.offers[0].open.items.map((i) => i.id), c.offers[1].open.items.map((i) => i.id));
});

test("äldre/avvikande avläsning utan issuer: ingen identitet, inget påstående, inga identitetsskillnader", () => {
  const o = off(false);
  assert.equal(o.identity, null);
  const c = compareOffers([o, off({})], L(2));
  assert.ok(!c.differences.some((d) => d.category === "foretag"));
});

test("originaluppgiften bevaras oförändrad bredvid fälten (komplettering visas separat och ändrar den aldrig)", () => {
  const o = off({ orgnr: null });
  assert.equal(o.identity.original.orgnr.status, "framgar_inte"); assert.deepEqual(o.identity.original, o.identity.fields);
});
