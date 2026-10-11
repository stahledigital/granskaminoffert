// Säljaruppgifter (AB/ENSKILD) – Modesty §5h, teknisk OFFLINEförlaga (inte juridisk slutaccept; tolkningen för enskild firma är OPEN).
// ALLA värden är SYNTETISKA. Org.nr-fixturen 556000-0001 är formatgiltig med BERÄKNAD Luhn-kontrollsiffra (ingen verklig företagsidentitet, ingen registerkontroll).
// 556000-0000 (samma nio första siffror, fel kontrollsiffra) används ENDAST som separat negativt fall.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sellerInfo, sellerLines, termsSnapshot, termsPlain, consentSnapshot, acceptingOrders, normalizeOrgNrAB, httpsInfoUrl } from "../src/compare_config.js";
import { sha256Hex } from "../src/compare_util.js";
import { makeEnv, installFetch, api, readyOrder, startCheckout, paidSession, webhook, agreementText, norm } from "./helpers/compare_env.mjs";

// Oberoende Luhn-beräkning i testet (inte importerad ur koden): kontrollsiffran för de nio första siffrorna.
const checkDigit = (nine) => { let sum = 0; nine.split("").forEach((c, i) => { let x = Number(c) * (i % 2 === 0 ? 2 : 1); if (x > 9) x -= 9; sum += x; }); return (10 - (sum % 10)) % 10; };
const GOOD = "556000-0001", BAD = "556000-0000";
const BASE = { COMPARE_SELLER_NAME: "Syntetisk Firma", COMPARE_SELLER_EMAIL: "kontakt@example.test", COMPARE_SELLER_ADDRESS: "Exempelgatan 1, 111 11 Teststad", COMPARE_SELLER_PHONE: "+46 8 000 00 00", COMPARE_COMPANY_INFO_URL: "https://example.test/foretagsuppgifter" };
const AB = { ...BASE, COMPARE_SELLER_FORM: "AB", COMPARE_SELLER_NAME: "Syntetisk Säljare AB", COMPARE_SELLER_ORGNR: GOOD, COMPARE_SELLER_VAT: "SE556000000101" };
const ENS = { ...BASE, COMPARE_SELLER_FORM: "ENSKILD", COMPARE_SELLER_OWNER_NAME: "Syntetisk Ägare" };
const S = (t) => ({ extracted: { totalBeforeRotSek: t, totalVatBasis: "inkl" }, scope: { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" } });

test("fixturen: kontrollsiffran är beräknad oberoende; 556000-0001 giltig, 556000-0000 ogiltig (separat negativt fall)", () => {
  assert.equal(checkDigit("556000000"), 1); assert.equal(GOOD, "556000-000" + checkDigit("556000000"));
  assert.equal(normalizeOrgNrAB(GOOD), GOOD); assert.equal(normalizeOrgNrAB("5560000001"), GOOD, "bindestreck valfritt");
  assert.equal(normalizeOrgNrAB(BAD), null);
});

test("fall 1/1b: AB med giltigt org.nr ⇒ komplett, org.nr-rad, ingen momsrad (SHOW_VAT=0); fel kontrollsiffra ⇒ placeholder", () => {
  const s = sellerInfo(AB); assert.equal(s.placeholder, false); assert.deepEqual(s.missing, []); assert.deepEqual(s.errors, []);
  const L = sellerLines(s).join("\n");
  assert.match(L, /Organisationsnummer: 556000-0001/); assert.doesNotMatch(L, /Momsregistreringsnummer|SE5560/); assert.match(L, /Fler företagsuppgifter: https:\/\/example\.test\/foretagsuppgifter/);
  assert.equal(s.vat, "", "VAT hålls utanför snapshot när flaggan är av");
  const b = sellerInfo({ ...AB, COMPARE_SELLER_ORGNR: BAD }); assert.equal(b.placeholder, true); assert.deepEqual(b.missing, ["orgnr"]);
  assert.doesNotMatch(sellerLines(b).join("\n"), /556000-0000/, "ogiltigt värde återges inte");
});

test("fall 2: SHOW_VAT=1 kräver giltigt VAT (SE+12 siffror); med giltigt visas momsraden", () => {
  assert.ok(sellerInfo({ ...AB, COMPARE_CONFIRM_SHOW_VAT: "1", COMPARE_SELLER_VAT: "" }).missing.includes("vat"));
  assert.ok(sellerInfo({ ...AB, COMPARE_CONFIRM_SHOW_VAT: "1", COMPARE_SELLER_VAT: "SE55600000" }).missing.includes("vat"));
  const ok = sellerInfo({ ...AB, COMPARE_CONFIRM_SHOW_VAT: "1" }); assert.equal(ok.placeholder, false);
  assert.match(sellerLines(ok).join("\n"), /Momsregistreringsnummer: SE556000000101/);
  assert.equal(sellerInfo({ ...AB, COMPARE_SELLER_VAT: "" }).placeholder, false, "VAT är valfri när flaggan är av");
});

test("fall 3: ENSKILD med ägare och tomt org.nr ⇒ komplett; 'saknas (enskild firma)'; inga 10/12-siffrorsmönster, ingen momsrad", () => {
  const s = sellerInfo(ENS); assert.equal(s.placeholder, false);
  const L = sellerLines(s).join("\n");
  assert.match(L, /Ägare: Syntetisk Ägare/); assert.match(L, /Organisationsnummer: saknas \(enskild firma\)/); assert.doesNotMatch(L, /Momsregistreringsnummer/);
  assert.doesNotMatch(L, /\b\d{6}-?\d{4}\b/); assert.doesNotMatch(L, /\b(19|20)\d{6}-?\d{4}\b/);
  assert.ok(sellerInfo({ ...ENS, COMPARE_SELLER_OWNER_NAME: "" }).missing.includes("owner"), "ägare krävs");
});

test("fall 4: ENSKILD med org.nr ⇒ konfigfel orgnr_forbidden_enskild, stängt i alla lägen, värdet återges aldrig någonstans", async () => {
  for (const forbidden of [GOOD, "19800101-0000", "198001010000", "12345"]) {
    const env = { ...ENS, COMPARE_SELLER_ORGNR: forbidden, COMPARE_ENABLED: "1", COMPARE_PAYMENTS: "test", COMPARE_MAILER_MODE: "mock" };
    const s = sellerInfo(env); assert.deepEqual(s.errors, ["orgnr_forbidden_enskild"]); assert.equal(s.placeholder, true); assert.ok(s.missing.includes("orgnr"));
    assert.equal(acceptingOrders({ ...makeEnv(ENS), ...env }, ["https://example.test"]), false, "stängt även i testläge");
    const digits = forbidden.replace(/\D/g, "");
    const dump = JSON.stringify({ s, lines: sellerLines(s), t: termsSnapshot(env), c: consentSnapshot(env), plain: termsPlain(termsSnapshot(env)) });
    assert.ok(!dump.includes(forbidden) && !dump.includes(digits), "värdet i snapshot/vy");
    for (let i = 0; i + 4 <= digits.length; i++) assert.ok(!dump.includes(digits.slice(i, i + 4)), "delsträng på fyra siffror: " + digits.slice(i, i + 4));
    const e2 = makeEnv({ ...ENS, COMPARE_SELLER_ORGNR: forbidden });
    const r = await api(e2, "GET", "/compare/config"); const body = JSON.stringify(r.json);
    assert.ok(!body.includes(forbidden) && !body.includes(digits), "publik config"); assert.equal(r.json.accepting, false);
    assert.deepEqual(r.json.terms.seller.errors, ["orgnr_forbidden_enskild"]);
  }
});

test("P1 (root): ENSKILD + förbjudet 12-siffrigt org.nr + VAT = SE + samma siffror + SHOW_VAT=1 ⇒ identifieraren återges ingenstans (VAT, snapshot, publik config, sellerLines; ordrar/mejl kan inte uppstå när konfigfel stänger)", async () => {
  const RAW = "199001019999", DIG = RAW;
  const E = { ...ENS, COMPARE_SELLER_ORGNR: RAW, COMPARE_SELLER_VAT: "SE" + DIG, COMPARE_CONFIRM_SHOW_VAT: "1" };
  const s = sellerInfo(E);
  assert.deepEqual(s.errors, ["orgnr_forbidden_enskild"]); assert.equal(s.placeholder, true); assert.equal(s.vat, ""); assert.equal(s.showVat, false);
  const env = { ...E, COMPARE_ENABLED: "1", COMPARE_PAYMENTS: "test", COMPARE_MAILER_MODE: "mock" };
  const dump = JSON.stringify({ s, lines: sellerLines(s), t: termsSnapshot(env), c: consentSnapshot(env), p: termsPlain(termsSnapshot(env)) });
  for (let i = 0; i + 4 <= DIG.length; i++) assert.ok(!dump.includes(DIG.slice(i, i + 4)), "delsträng " + DIG.slice(i, i + 4));
  assert.ok(!dump.includes("SE" + DIG));
  const r = await api(makeEnv(E), "GET", "/compare/config"); const body = JSON.stringify(r.json);
  assert.equal(r.status, 200); assert.equal(r.json.accepting, false); assert.deepEqual(r.json.terms.seller.errors, ["orgnr_forbidden_enskild"]);
  for (let i = 0; i + 4 <= DIG.length; i++) assert.ok(!body.includes(DIG.slice(i, i + 4)), "publik config " + DIG.slice(i, i + 4));
  assert.ok(!body.includes("SE" + DIG));
  // sammanfallande värde i andra fält (namn/adress/telefon/länk) redigeras också, bara fältnamnet rapporteras
  const e2 = sellerInfo({ ...ENS, COMPARE_SELLER_ORGNR: RAW, COMPARE_SELLER_NAME: "Firma " + RAW, COMPARE_SELLER_ADDRESS: "Gatan " + RAW.slice(0, 6) + "-" + RAW.slice(6) + ", Ort", COMPARE_COMPANY_INFO_URL: "https://example.test/" + RAW });
  const d2 = JSON.stringify({ e2, l: sellerLines(e2) });
  assert.ok(!d2.includes(RAW) && !d2.includes(RAW.slice(0, 6)), "inga fält återger värdet");
  for (const k of ["name", "infoUrl"]) assert.ok(e2.missing.includes(k), k);
});

test("P1-kontroll: giltig ENSKILD med SHOW_VAT=1 och egen (osammanfallande) VAT fungerar och visar momsraden; utan fel ingen redaktion", async () => {
  const E = { ...ENS, COMPARE_CONFIRM_SHOW_VAT: "1", COMPARE_SELLER_VAT: "SE556000000101" };
  const s = sellerInfo(E); assert.equal(s.placeholder, false); assert.deepEqual(s.errors, []); assert.equal(s.showVat, true);
  assert.match(sellerLines(s).join("\n"), /Momsregistreringsnummer: SE556000000101/);
  assert.equal((await api(makeEnv(E), "GET", "/compare/config")).json.accepting, true);
  assert.equal(sellerInfo({ ...E, COMPARE_SELLER_VAT: "" }).placeholder, true, "SHOW_VAT=1 kräver VAT");
});

test("kontroll: samma testmiljö med giltig ENSKILD-konfiguration tar emot ordrar (så stängningen i fall 4 beror på konfigfelet)", async () => {
  const r = await api(makeEnv(ENS), "GET", "/compare/config"); assert.equal(r.json.accepting, true);
  const r2 = await api(makeEnv({ ...ENS, COMPARE_SELLER_ORGNR: GOOD }), "GET", "/compare/config"); assert.equal(r2.json.accepting, false);
});

test("fall 4b: ingen logg/telemetri innehåller org.nr/VAT/adress/telefon vid konfigfel", async () => {
  const lines = []; const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.map(String).join(" "));
  try {
    const env = makeEnv({ ...ENS, COMPARE_SELLER_ORGNR: GOOD, COMPARE_SELLER_VAT: "SE556000000101" });
    await api(env, "GET", "/compare/config"); await api(env, "POST", "/compare/orders", {}); await api(env, "POST", "/compare/orders/x/checkout", {});
  } finally { Object.assign(console, orig); }
  const all = lines.join("\n");
  for (const v of ["556000", "5560000001", "SE5560", "Exempelgatan", "+46 8 000"]) assert.ok(!all.includes(v), v);
});

test("fall 5: AB med personnummerformat ⇒ ogiltigt (aldrig accepterat)", () => {
  for (const id of ["19800101-0000", "198001010000", "800101-0000", "800101-1239", "123"]) { const s = sellerInfo({ ...AB, COMPARE_SELLER_ORGNR: id }); assert.equal(s.placeholder, true, id); assert.deepEqual(s.missing, ["orgnr"], id); assert.ok(!sellerLines(s).join("\n").includes(id.replace(/\D/g, "")), "ej återgivet " + id); }
  assert.equal(normalizeOrgNrAB("800101-1239"), null, "tredje siffran 0 ⇒ avvisas även med giltig Luhn");
});

test("fall 6/7: form saknas/okänd och länk saknas/ej https ⇒ missing; live stängt", () => {
  for (const f of ["", undefined, "HB", "ab", "Enskild"]) { const s = sellerInfo({ ...AB, COMPARE_SELLER_FORM: f }); assert.ok(s.missing.includes("form"), String(f)); assert.equal(s.placeholder, true); }
  for (const u of ["", "http://example.test/x", "javascript:alert(1)", "https://u:p@example.test/", "https://example.test/x?a=1", "https://example.test/#x", "https://localhost/x", "https://exa mple.test", "https://example.test:8443/x", "ftp://example.test"]) assert.ok(sellerInfo({ ...AB, COMPARE_COMPANY_INFO_URL: u }).missing.includes("infoUrl"), u);
  assert.equal(httpsInfoUrl("https://example.test/foretagsuppgifter"), "https://example.test/foretagsuppgifter");
  assert.equal(acceptingOrders({ ...makeEnv({}), ...AB, COMPARE_COMPANY_INFO_URL: "", COMPARE_PAYMENTS: "live" }, ["x"]), false);
});

test("fall 8: ändrad adress/telefon/FORM/OWNER/VAT-flagga/länk ändrar samtyckeshashen", async () => {
  const h = async (e) => sha256Hex(JSON.stringify(consentSnapshot(e)));
  const base = await h(AB);
  const variants = [{ COMPARE_SELLER_ADDRESS: "Annan gata 2, 222 22 Teststad" }, { COMPARE_SELLER_PHONE: "+46 8 111 11 11" }, { COMPARE_CONFIRM_SHOW_VAT: "1" }, { COMPARE_COMPANY_INFO_URL: "https://example.test/annan" }, { COMPARE_SELLER_ORGNR: "556000-0019" }];
  for (const v of variants) assert.notEqual(await h({ ...AB, ...v }), base, JSON.stringify(v));
  const ens = await h(ENS);
  assert.notEqual(ens, base, "FORM/org.nr-rad skiljer");
  assert.notEqual(await h({ ...ENS, COMPARE_SELLER_OWNER_NAME: "Annan Ägare" }), ens, "OWNER ingår");
  assert.notEqual(await h({ ...AB, COMPARE_SELLER_FORM: "ENSKILD", COMPARE_SELLER_ORGNR: "", COMPARE_SELLER_OWNER_NAME: "Syntetisk Ägare" }), base);
});

test("fall 9: ENSKILD – hela sellerLines når termsSnapshot, avtalsposten och mockbekräftelsen exakt; avtalsposten bär inget nummer", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(ENS);
    const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
    assert.equal((await startCheckout(env, orderId, token)).status, 200);
    assert.equal((await webhook(env, "checkout.session.completed", paidSession([...f.sessions.values()].pop()))).status, 200);
    const st = env.COMPARE_ORDERS.peek(orderId).store; const ledger = st.get("ledger"); const snap = st.get("order").accept.snapshot;
    const lines = sellerLines(snap.terms.seller);
    assert.ok(snap.terms.sections.find((x) => x.id === "saljare").text === lines.join("\n"));
    const mail = [...st].find(([k]) => k.startsWith("outbox:"))[1];
    // avtalet ligger i den bifogade PDF:en (byggd ur ledgerns frusna avtal); varje säljarrad står som "Rubrik värde"
    const pdf = norm(agreementText(ledger)); assert.equal(mail.attachments[0].gen, "agreement");
    for (const l of lines) assert.ok(pdf.includes(norm(l.replace(": ", " "))), l);
    assert.deepEqual(sellerLines(ledger.agreement.seller), lines);
    assert.ok(pdf.includes("Ägare Syntetisk Ägare") && pdf.includes("Organisationsnummer saknas (enskild firma)"));
    assert.doesNotMatch(JSON.stringify(ledger) + mail.body + pdf, /\b\d{6}-?\d{4}\b/, "inget 10-siffrigt nummer i avtalspost, mejl eller PDF");
  } finally { f.restore(); }
});

test("fall 11: ENSKILD med ägare ändrar inget annat i offert-/prislogik (priset i snapshot är oförändrat)", () => {
  const a = consentSnapshot(AB), e = consentSnapshot(ENS);
  for (const k of ["priceOre", "currency", "vatPct", "offerVersion"]) assert.equal(a[k], e[k]);
});
