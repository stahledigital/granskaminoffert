// D06-rättning: fullt konfigurerbar säljarinfo + fullständig (UTKAST-)villkorssnapshot i samtyckeshash, avtalspost och bekräftelsemejl.
// Syntetiska uppgifter (example.test, 556000-0001: formatgiltigt med beräknad Luhn-kontrollsiffra, ingen registerkontroll): inga riktiga privata identifierare.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sellerInfo, termsSnapshot, termsPlain, consentSnapshot, acceptingOrders } from "../src/compare_config.js";
import { sha256Hex } from "../src/compare_util.js";
import { makeEnv, installFetch, api, readyOrder, startCheckout, paidSession, webhook, consentOf, agreementText, norm } from "./helpers/compare_env.mjs";

const FULL = { COMPARE_SELLER_FORM: "AB", COMPARE_COMPANY_INFO_URL: "https://example.test/foretagsuppgifter", COMPARE_CONFIRM_SHOW_VAT: "1", COMPARE_SELLER_NAME: "Syntetisk Säljare AB", COMPARE_SELLER_ORGNR: "556000-0001", COMPARE_SELLER_EMAIL: "kontakt@example.test", COMPARE_SELLER_ADDRESS: "Exempelgatan 1, 111 11 Teststad", COMPARE_SELLER_VAT: "SE556000000101", COMPARE_SELLER_PHONE: "+46 8 000 00 00" };
const S = (t) => ({ extracted: { totalBeforeRotSek: t, totalVatBasis: "inkl" }, scope: { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" } });

test("säljarinfo (AB): platshållare utan konfiguration; komplett kräver form, namn, org.nr (Luhn), adress, e-post, telefon och https-länk", () => {
  const d = sellerInfo({}); assert.equal(d.placeholder, true); assert.ok(Object.values({ a: d.name, c: d.address, e: d.email, f: d.phone, g: d.infoUrl }).every((v) => /^\[.*fylls i/.test(v)));
  assert.deepEqual(d.missing.sort(), ["address", "email", "form", "infoUrl", "name", "orgnr", "phone"]);
  const f = sellerInfo(FULL); assert.equal(f.placeholder, false); assert.equal(f.phone, "+46 8 000 00 00"); assert.equal(f.vat, "SE556000000101"); assert.equal(f.orgnr, "556000-0001");
  assert.deepEqual(sellerInfo({ ...FULL, COMPARE_SELLER_PHONE: "" }).missing, ["phone"]);
  assert.equal(sellerInfo({ ...FULL, COMPARE_SELLER_NAME: "A\nB\tC" }).name, "A B C");
  for (const bad of [{ COMPARE_SELLER_VAT: "556000000101" }, { COMPARE_SELLER_ADDRESS: "x" }, { COMPARE_SELLER_ORGNR: "123" }, { COMPARE_SELLER_PHONE: "abc" }]) assert.equal(sellerInfo({ ...FULL, ...bad }).placeholder, true);
  // live stängt tills säljaren är komplett (och villkorstexten inte längre är utkast)
  assert.equal(acceptingOrders({ ...FULL, COMPARE_ENABLED: "1", COMPARE_PAYMENTS: "live" }, ["x"]), false);
});

test("villkorssnapshot: fullständig, serverägd, följer konfigurationen och ingår i samtyckeshashen", async () => {
  const t = termsSnapshot(FULL);
  assert.equal(t.draft, true);
  assert.deepEqual(t.sections.map((s) => s.id), ["saljare", "tjansten", "pris", "avtal", "angerratt", "aterbetalning", "personuppgifter", "kontakt"]);
  const all = termsPlain(t);
  for (const v of ["Syntetisk Säljare AB", "556000-0001", "SE556000000101", "Exempelgatan 1", "kontakt@example.test", "+46 8 000 00 00"]) assert.ok(all.includes(v), v);
  assert.match(all, /49,00 kr inklusive moms \(varav moms 9,80 kr, 25 %\)/);
  assert.match(all, /\[lagringstid för avtalspost är inte fastställd\]/, "ingen vald retentionlängd i texten");
  assert.doesNotMatch(all, /ARN|Allmänna reklamationsnämnden/, "ingen kategorisk tvistlösningsutfästelse");
  assert.equal(termsSnapshot({ ...FULL, COMPARE_LEDGER_RETENTION_DAYS: "30", COMPARE_BOOKKEEPING_RETENTION_DAYS: "90" }).sections.find((s) => s.id === "personuppgifter").text.includes("avtalspost 30 dagar"), true);
  const h = async (e) => sha256Hex(JSON.stringify(consentSnapshot(e)));
  assert.notEqual(await h(FULL), await h({ ...FULL, COMPARE_SELLER_ADDRESS: "Annan gata 2, 222 22 Teststad" }), "ändrad säljaradress ändrar hashen");
  assert.notEqual(await h({}), await h(FULL));
});

test("hela villkorstexten når den varaktiga avtalsposten och mockbekräftelsen exakt som godkänd; ändrad konfiguration efter godkännande ger ny samtyckeshash", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(FULL);
    const { orderId, token } = await readyOrder(env, [S(100000), S(110000)]);
    assert.equal((await startCheckout(env, orderId, token)).status, 200);
    const sess = [...f.sessions.values()].pop();
    assert.equal((await webhook(env, "checkout.session.completed", paidSession(sess))).status, 200);
    const st = env.COMPARE_ORDERS.peek(orderId).store;
    const ledger = st.get("ledger"); const snap = st.get("order").accept.snapshot;
    assert.deepEqual(ledger.agreement.accepted.fullTerms, snap.terms);
    assert.equal(ledger.agreement.seller.address, FULL.COMPARE_SELLER_ADDRESS); assert.equal(ledger.agreement.seller.vat, FULL.COMPARE_SELLER_VAT);
    const mail = [...st].find(([k]) => k.startsWith("outbox:"))[1];
    const pdf = norm(agreementText(ledger));
    assert.equal(mail.attachments[0].gen, "agreement"); assert.ok(mail.body.length < 400, "kort brödtext; villkoren ligger i PDF:en");
    assert.ok(pdf.includes(norm(termsPlain(snap.terms))), "bekräftelse-PDF:en innehåller exakt den godkända villkorstexten");
    for (const v of ["Organisationsnummer 556000-0001", "Momsregistreringsnummer SE556000000101", "Adress Exempelgatan 1", "Telefon +46 8 000 00 00", "Fler företagsuppgifter https://example.test/foretagsuppgifter"]) assert.ok(pdf.includes(v), v);
    assert.match(pdf, /Villkor \(version villkor-utkast-1, UTKAST\)/);
    assert.equal(ledger.agreement.accepted.hash, (await consentOf(env)).hash);
    // konfigurationsändring efter godkännande: gammal hash gäller inte längre
    const env2 = makeEnv({ ...FULL, COMPARE_SELLER_ADDRESS: "Ny adress 9, 333 33 Teststad" });
    const cfg2 = (await api(env2, "GET", "/compare/config")).json;
    assert.notEqual(cfg2.consent.hash, ledger.agreement.accepted.hash);
    assert.equal(cfg2.terms.seller.address, "Ny adress 9, 333 33 Teststad"); assert.equal(cfg2.terms.sections.length, 8);
  } finally { f.restore(); }
});
