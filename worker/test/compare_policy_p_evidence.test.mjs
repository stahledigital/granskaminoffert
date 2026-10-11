// Policy P, bounded fix 2: STARK bevisprövning + serververifierad källkvittens. Allt offline mot attrapper (ingen Stripe/modell/mejl/Google/Trustpilot på riktigt).
// Rotens sex prov (lagringsinjektion i minnesadaptern, inget offentligt exploit) som regressionstester + hela kundkedjan med verklig lokal källstatus.
import { test } from "node:test";
import assert from "node:assert/strict";
import { offerCopy, OFFER_COPY, consentSnapshot } from "../src/compare_config.js";
import { makeEnv, installFetch, api, readyOrder, startCheckout, paidSession, webhook, consentOf, REVIEW_VARS, GOOGLE_VARS, TP_VARS, placeId, synthTpReviews } from "./helpers/compare_env.mjs";

const S = (total) => ({ extracted: { totalBeforeRotSek: total, totalVatBasis: "inkl" }, scope: { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" } });
const PE = { COMPARE_CONSENT_POLICY: "P", COMPARE_AUTO_REFUND: "1" };
const ON = { ...REVIEW_VARS, ...GOOGLE_VARS, ...TP_VARS };
const st = (env, id) => env.COMPARE_ORDERS.peek(id).store;
const orderOf = (env, id) => st(env, id).get("order");
const view = async (env, id, token) => (await api(env, "GET", `/compare/orders/${id}`, { token })).json.order;
const withdraw = (env, id, token) => api(env, "POST", `/compare/orders/${id}/withdraw`, { token });
const mailer = () => { const m = { sent: [] }; m.send = async (msg) => { m.sent.push(msg); return { ok: true, ref: "ref_" + msg.id.slice(-8) }; }; return m; };
const src = (env, o, sub = "", method = "GET", body) => api(env, method, `/compare/orders/${o.orderId}/sources${sub}`, { token: o.token, body });
const receipt = (env, o, body, token) => api(env, "POST", `/compare/orders/${o.orderId}/source-delivered`, { token: token ?? o.token, body });

async function payOrder(env, f, o) {
  assert.equal((await startCheckout(env, o.orderId, o.token)).status, 200);
  const sess = [...f.sessions.values()].filter((s) => s.client_reference_id === o.orderId).pop();
  assert.equal((await webhook(env, "checkout.session.completed", paidSession(sess))).status, 200);
}
async function plain(env, f, { run = true } = {}) { const o = await readyOrder(env, [S(100000), S(110000)]); await payOrder(env, f, o); if (run) await env.COMPARE_ORDERS.runAlarms(); return o; }
// Verklig täckning via de befintliga källadaptrarna/attrapperna: firma A = Trustpilot (sök + bekräfta), firma B = Google (bekräftad profil).
async function covered(env, f, { google = true, tp = true } = {}) {
  f.ctl.tpFind = { "byggnord.se": [{ id: "bu00000001", displayName: "Bygg Nord", websiteUrl: "https://byggnord.se" }] };
  f.ctl.tpLatest = { bu00000001: synthTpReviews(3, { total: 12 }) };
  const o = await readyOrder(env, [S(100000), S(110000)]);
  const firms = (await src(env, o, "/firms", "PUT", { firms: [{ offerIndex: 0, name: "Bygg Nord AB", city: "Malmö", domain: "byggnord.se" }, { offerIndex: 1, name: "Hus Syd AB", city: "Lund" }] })).json.sources.firms;
  o.A = firms[0].id; o.B = firms[1].id;
  if (tp) { assert.equal((await src(env, o, "/trustpilot/search", "POST", { firmId: o.A })).status, 200); assert.equal((await src(env, o, "/trustpilot/confirm", "POST", { firmId: o.A, buId: "bu00000001" })).status, 200); }
  if (google) assert.equal((await src(env, o, "/google/confirm", "POST", { firmId: o.B, placeId: placeId("b"), via: "manual", seen: true })).status, 200);
  await payOrder(env, f, o); await env.COMPARE_ORDERS.runAlarms();
  return o;
}

// ---- rotens prov som regressionstester ----
const PRE = [
  ["declaration.value=false före start", (o) => { o.accept.consents.declaration.value = false; }],
  ["terms.value=false före start", (o) => { o.accept.consents.terms.value = false; }],
  ["terms.value=false före start", (o) => { o.accept.consents.terms.value = false; }],
  ["fel textHash", (o) => { o.accept.consents.declaration.textHash = "0".repeat(64); }],
  ["fel orderID i samtycke", (o) => { o.accept.consents.declaration.orderId = "o_" + "1".repeat(32); }],
  ["fel text-ID/version", (o) => { o.accept.consents.declaration.textId = "declaration@samtycke-p-utkast-0"; }],
  ["ändrad frusen text (snapshot ≠ consentHash)", (o) => { o.accept.snapshot.texts.declaration += " (ändrad)"; }],
  ["ändrad version", (o) => { o.accept.consentVersion = "samtycke-p-utkast-0"; }],
  ["fullgörandepunkt ≠ snapshot", (o) => { o.accept.fulfilmentPoint = "fonster_slut"; }],
  ["samtyckestid ≠ accepttid", (o) => { o.accept.consents.declaration.at += 5; }],
  ["motstridig förhandsbekräftelse (fel mejl-ID)", (o) => { o.accept.confirmation = { mailId: "mail_avtal_fel", sentAt: 1, at: 2 }; }],
];
test("rotens prov före start: falskt/motstridigt samtycke ⇒ INGEN generation, ordern avbryts och återbetalas fullt (varje variant)", async () => {
  for (const [name, mut] of PRE) {
    const f = installFetch();
    try {
      const env = makeEnv(PE); env.COMPARE_MAILER = mailer();
      const o = await plain(env, f, { run: false });
      const s = st(env, o.orderId); const ord = s.get("order"); mut(ord); s.set("order", ord);
      await env.COMPARE_ORDERS.runAlarms();
      const v = orderOf(env, o.orderId);
      assert.equal(f.log.anthropic.length, 0, `${name}: ingen generation`);
      assert.equal(v.status, "failed", name); assert.ok(["samtycke_saknas", "bekraftelse_motstrider"].includes(v.work.error), `${name}: ${v.work.error}`);
      assert.equal(f.log.refunds.length, 1, `${name}: full återbetalning`); assert.equal(v.work.startedAt, undefined, `${name}: arbetet aldrig startat`);
    } finally { f.restore(); }
  }
});

test("ledger-korskontroll före start: saknad/ändrad avtalspost ⇒ ingen generation", async () => {
  for (const [name, mut] of [
    ["ledger saknas", (s) => s.delete("ledger")],
    ["ledger-samtycke annan textHash", (s) => { const l = s.get("ledger"); l.agreement.p.consents.declaration.textHash = "f".repeat(64); s.set("ledger", l); }],
    ["ledger annan fullgörandepunkt", (s) => { const l = s.get("ledger"); l.agreement.p.fulfilmentPoint = "fonster_slut"; s.set("ledger", l); }],
    ["ledger annan avtalad prestation", (s) => { const l = s.get("ledger"); l.agreement.p.agreed.sources.required = true; s.set("ledger", l); }],
    ["ledger annan order", (s) => { const l = s.get("ledger"); l.agreement.orderId = "o_" + "2".repeat(32); s.set("ledger", l); }],
  ]) {
    const f = installFetch();
    try {
      const env = makeEnv(PE); env.COMPARE_MAILER = mailer();
      const o = await plain(env, f, { run: false }); mut(st(env, o.orderId));
      await env.COMPARE_ORDERS.runAlarms();
      assert.equal(f.log.anthropic.length, 0, name); assert.equal(orderOf(env, o.orderId).status, "failed", name); assert.equal(f.log.refunds.length, 1, name);
    } finally { f.restore(); }
  }
});

const POST = [
  ["declaration.value=false efter leverans", (o) => { o.accept.consents.declaration.value = false; }],
  ["fel textHash efter leverans", (o) => { o.accept.consents.declaration.textHash = "0".repeat(64); }],
  ["fel orderID efter leverans", (o) => { o.accept.consents.terms.orderId = "o_" + "3".repeat(32); }],
  ["bekräftelsen senare än rapporten", (o, s) => { const t = o.delivery.report.at + 5000; o.accept.confirmation.sentAt = t; o.accept.confirmation.at = t; const m = s.get(`outbox:mail_avtal_${o.id}`); m.sentAt = t; s.set(`outbox:mail_avtal_${o.id}`, m); }],
  ["bekräftelsen senare än arbetsstart", (o) => { o.work.startedAt = o.accept.confirmation.sentAt - 1; }],
  ["arbetsstart saknas", (o) => { delete o.work.startedAt; }],
  ["fel mejl-ID i bekräftelsen", (o) => { o.accept.confirmation.mailId = "mail_avtal_fel"; }],
  ["mejlets sentAt ≠ bekräftelsens", (o, s) => { const m = s.get(`outbox:mail_avtal_${o.id}`); m.sentAt += 1; s.set(`outbox:mail_avtal_${o.id}`, m); }],
  ["fel rapporthash", (o) => { o.delivery.report.hash = "a".repeat(64); }],
  ["fel orderID i rapportbeviset", (o) => { o.delivery.report.orderId = "o_" + "4".repeat(32); }],
  ["rapportens hash saknas", (o) => { o.delivery.report.hash = null; }],
  ["separat leveransbevis saknas", (o, s) => { s.delete("deliveryproof"); }],
  ["separat leveransbevis annan hash", (o, s) => { const p = s.get("deliveryproof"); p.hash = "b".repeat(64); s.set("deliveryproof", p); }],
  ["lagrad rapport ändrad efter leverans", (o, s, env) => { env.REVIEWS_KV.m.set(o.reportKey, JSON.stringify({ andrad: true })); }],
  ["leveranstid ≠ faktisk leveranstid", (o) => { o.delivery.report.at += 1; }],
];
test("rotens prov efter leverans: motstridigt bevis ⇒ ångerrätten KVAR (aldrig upphord), ånger ⇒ full återbetalning, ingen rapport kvar; opåverkad kontroll ⇒ upphord", async () => {
  { // kontroll
    const f = installFetch();
    try {
      const env = makeEnv(PE); env.COMPARE_MAILER = mailer();
      const o = await plain(env, f); const v = await view(env, o.orderId, o.token);
      assert.equal(v.rights.angerratt, "upphord"); assert.equal(v.rights.state, "fullgjord");
      assert.ok(f.log.anthropic.length >= 2, "korrekt leverans genererar (extraktion + syntes)");
      const w = await withdraw(env, o.orderId, o.token); assert.equal(w.json.withdrawal.outcome, "angerratt_upphord"); assert.equal(f.log.refunds.length, 0);
    } finally { f.restore(); }
  }
  for (const [name, mut] of POST) {
    const f = installFetch();
    try {
      const env = makeEnv(PE); env.COMPARE_MAILER = mailer();
      const o = await plain(env, f); const s = st(env, o.orderId); const ord = s.get("order"); mut(ord, s, env); s.set("order", ord);
      const v = await view(env, o.orderId, o.token);
      assert.equal(v.rights.angerratt, "kvar", `${name}: rätten kvar`); assert.notEqual(v.rights.state, "fullgjord", name);
      const w = await withdraw(env, o.orderId, o.token);
      assert.equal(w.json.withdrawal.outcome, "angrat_fore_fullgoring", `${name}: ${w.json.withdrawal.outcome}`); assert.equal(f.log.refunds.length, 1, `${name}: full refund`);
      assert.equal((await api(env, "GET", `/compare/orders/${o.orderId}/report`, { token: o.token })).status, 409, `${name}: rapport raderad`);
    } finally { f.restore(); }
  }
});

// ---- källkvittens: servern prövar sin egen källstatus mot den frusna täckningen ----
test("hel kedja: verklig täckning (Trustpilot + Google via befintliga adaptrar) fryses per firma/källa; kvittens bara efter lyckad visning; klientens ingen_kalla/state räknas aldrig", async () => {
  const f = installFetch();
  try {
    const env = makeEnv({ ...PE, ...ON }); env.COMPARE_MAILER = mailer();
    const o = await covered(env, f);
    const ord = orderOf(env, o.orderId);
    assert.deepEqual(ord.accept.agreed.sources.coveredIds.sort(), [o.A, o.B].sort()); assert.equal(ord.accept.agreed.sources.required, true);
    assert.deepEqual(ord.accept.agreed.sources.providers, { [o.A]: ["trustpilot"], [o.B]: ["google"] });
    let v = await view(env, o.orderId, o.token);
    assert.equal(v.status, "delivered"); assert.equal(v.rights.angerratt, "kvar"); assert.equal(v.rights.state, "ej_fullgjord");
    // klientpåstående räknas inte: ingen_kalla för täckt firma, okänd firma, fel token, felaktigt state
    assert.equal((await receipt(env, o, { firmId: o.A, state: "ingen_kalla" })).status, 409);
    assert.equal((await receipt(env, o, { firmId: o.B, state: "ingen_kalla" })).status, 409);
    assert.equal((await receipt(env, o, { firmId: "f_zzz", state: "visad" })).status, 409);
    assert.equal((await receipt(env, o, { firmId: o.A, state: "kallfel" })).status, 400);
    assert.equal((await receipt(env, o, { firmId: o.A, state: "visad" }, "fel-token")).status, 404);
    // kvittens utan faktisk lyckad visning ⇒ avvisas (servern ser ingen lyckad Trustpilot-hämtning / Google-visning)
    assert.equal((await receipt(env, o, { firmId: o.A, state: "visad" })).status, 409);
    assert.equal((await receipt(env, o, { firmId: o.B, state: "visad" })).status, 409);
    assert.equal((await view(env, o.orderId, o.token)).rights.angerratt, "kvar");
    // Trustpilot: serverns egen hämtning ok ⇒ kvittens A godtas
    const l = await src(env, o, "/trustpilot/latest", "POST", { firmId: o.A }); assert.equal(l.json.outcome, "ok");
    assert.equal((await receipt(env, o, { firmId: o.A, state: "visad" })).status, 200);
    v = await view(env, o.orderId, o.token); assert.equal(v.rights.angerratt, "kvar", "A av två räcker inte");
    // Google: visningsfel ⇒ ingen kvittens; lyckad visning ⇒ kvittens
    assert.equal((await src(env, o, "/google/render", "POST", { firmId: o.B, outcome: "fel" })).status, 200);
    assert.equal((await receipt(env, o, { firmId: o.B, state: "visad" })).status, 409, "källfel ⇒ ingen kvittens");
    assert.equal((await view(env, o.orderId, o.token)).rights.angerratt, "kvar");
    assert.equal((await src(env, o, "/google/render", "POST", { firmId: o.B, outcome: "ok" })).status, 200);
    assert.equal((await receipt(env, o, { firmId: o.B, state: "visad" })).status, 200);
    v = await view(env, o.orderId, o.token); assert.equal(v.rights.angerratt, "upphord"); assert.equal(v.rights.state, "fullgjord");
    const d = orderOf(env, o.orderId).delivery.sources; assert.deepEqual(d[o.A].providers, { trustpilot: "ok" }); assert.deepEqual(d[o.B].providers, { google: "ok" });
    // ingen omdömestext i ordern/leveransbeviset
    assert.ok(!/SYNTETISK TEXT/.test(JSON.stringify(orderOf(env, o.orderId))));
    assert.equal((await withdraw(env, o.orderId, o.token)).json.withdrawal.outcome, "angerratt_upphord"); assert.equal(f.log.refunds.length, 0);
  } finally { f.restore(); }
});

test("källfel / tomt / partiellt / bara ena källan ⇒ ångerrätten kvar, ånger ⇒ full återbetalning", async () => {
  // (1) inga kvittenser alls
  { const f = installFetch();
    try {
      const env = makeEnv({ ...PE, ...ON }); env.COMPARE_MAILER = mailer();
      const o = await covered(env, f);
      const w = await withdraw(env, o.orderId, o.token); assert.equal(w.json.withdrawal.outcome, "angrat_fore_fullgoring");
      assert.deepEqual(st(env, o.orderId).get("ledger").withdrawal.fulfilment.missing.sort(), [`kalla:${o.A}`, `kalla:${o.B}`].sort()); assert.equal(f.log.refunds.length, 1);
    } finally { f.restore(); } }
  // (2) Trustpilot svarar "inga omdömen" (tomt) efter att firman var täckt ⇒ ingen kvittens (ändrat läge, rätten kvar)
  { const f = installFetch();
    try {
      const env = makeEnv({ ...PE, ...ON }); env.COMPARE_MAILER = mailer();
      const o = await covered(env, f); f.ctl.tpLatest = { bu00000001: synthTpReviews(0, { total: 0 }) };
      assert.equal((await src(env, o, "/trustpilot/latest", "POST", { firmId: o.A })).json.outcome, "tomt");
      assert.equal((await receipt(env, o, { firmId: o.A, state: "visad" })).status, 409); assert.equal((await receipt(env, o, { firmId: o.A, state: "ingen_kalla" })).status, 409);
      assert.equal((await view(env, o.orderId, o.token)).rights.angerratt, "kvar");
    } finally { f.restore(); } }
  // (3) bara Google-firman kvitterad ⇒ partiellt ⇒ kvar
  { const f = installFetch();
    try {
      const env = makeEnv({ ...PE, ...ON }); env.COMPARE_MAILER = mailer();
      const o = await covered(env, f);
      await src(env, o, "/google/render", "POST", { firmId: o.B, outcome: "ok" }); assert.equal((await receipt(env, o, { firmId: o.B, state: "visad" })).status, 200);
      const v = await view(env, o.orderId, o.token); assert.equal(v.rights.angerratt, "kvar");
      const w = await withdraw(env, o.orderId, o.token); assert.equal(w.json.withdrawal.outcome, "angrat_fore_fullgoring"); assert.deepEqual(st(env, o.orderId).get("ledger").withdrawal.fulfilment.missing, [`kalla:${o.A}`]); assert.equal(f.log.refunds.length, 1);
    } finally { f.restore(); } }
  // (4) firma med BÅDA källorna: bara en visad ⇒ kvar; båda ⇒ upphör
  { const f = installFetch();
    try {
      const env = makeEnv({ ...PE, ...ON }); env.COMPARE_MAILER = mailer();
      f.ctl.tpFind = { "byggnord.se": [{ id: "bu00000001", displayName: "Bygg Nord", websiteUrl: "https://byggnord.se" }] }; f.ctl.tpLatest = { bu00000001: synthTpReviews(2, { total: 7 }) };
      const o = await readyOrder(env, [S(100000), S(110000)]);
      const fid = (await src(env, o, "/firms", "PUT", { firms: [{ offerIndex: 0, name: "Bygg Nord AB", city: "Malmö", domain: "byggnord.se" }, { offerIndex: 1, name: "Bygg Nord AB", city: "Malmö", domain: "byggnord.se" }] })).json.sources.firms[0].id;
      await src(env, o, "/trustpilot/search", "POST", { firmId: fid }); await src(env, o, "/trustpilot/confirm", "POST", { firmId: fid, buId: "bu00000001" });
      await src(env, o, "/google/confirm", "POST", { firmId: fid, placeId: placeId("c"), via: "manual", seen: true });
      await payOrder(env, f, o); await env.COMPARE_ORDERS.runAlarms();
      assert.deepEqual(orderOf(env, o.orderId).accept.agreed.sources.providers[fid], ["google", "trustpilot"]);
      await src(env, o, "/google/render", "POST", { firmId: fid, outcome: "ok" });
      assert.equal((await receipt(env, o, { firmId: fid, state: "visad" })).status, 409, "Trustpilot ännu ej visad");
      await src(env, o, "/trustpilot/latest", "POST", { firmId: fid });
      assert.equal((await receipt(env, o, { firmId: fid, state: "visad" })).status, 200);
      assert.equal((await view(env, o.orderId, o.token)).rights.angerratt, "upphord");
    } finally { f.restore(); } }
});

test("injicerad täckning + klientens ingen_kalla (rotens prov 6) kan inte ta bort rätten; kvittens för firma utanför täckningen / utan källor avvisas; äldre P-order utan frusna källor ⇒ fail closed", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(PE); env.COMPARE_MAILER = mailer();
    const o = await plain(env, f, { run: false }); const s = st(env, o.orderId); const ord = s.get("order");
    ord.accept.agreed.sources = { required: true, coveredIds: ["f_aaa"], coverageHash: "x" }; s.set("order", ord); // utan frusna providers och utan ledgerns motsvarighet
    await env.COMPARE_ORDERS.runAlarms();
    // ledgern har inte samma avtalade prestation ⇒ samtyckesbeviset motstridigt ⇒ ingen start
    assert.equal(orderOf(env, o.orderId).status, "failed"); assert.equal(f.log.anthropic.length, 0);
    const g = await plain(env, f); // vanlig P-order utan täckning
    assert.equal((await receipt(env, g, { firmId: "f_aaa", state: "ingen_kalla" })).status, 409);
    assert.equal((await receipt(env, g, { firmId: "f_aaa", state: "visad" })).status, 409);
    assert.equal((await view(env, g.orderId, g.token)).rights.angerratt, "upphord");
    // injicerad täckning EFTER fryst ledger, båda ändrade lika: ingen providers-lista ⇒ kalla saknas ⇒ rätt kvar
    const h = await plain(env, f); const hs = st(env, h.orderId); const ho = hs.get("order"); const hl = hs.get("ledger");
    ho.accept.agreed.sources = { required: true, coveredIds: ["f_aaa"], coverageHash: "x" }; hl.agreement.p.agreed.sources = ho.accept.agreed.sources; hs.set("order", ho); hs.set("ledger", hl);
    assert.equal((await receipt(env, h, { firmId: "f_aaa", state: "ingen_kalla" })).status, 409);
    const v = await view(env, h.orderId, h.token); assert.equal(v.rights.angerratt, "kvar");
    assert.equal((await withdraw(env, h.orderId, h.token)).json.withdrawal.outcome, "angrat_fore_fullgoring");
  } finally { f.restore(); }
});

test("copy: P beskriver den faktiska köplänken (Ditt köp och hjälp, neutral) i förköpets 'så går det till' och villkoren; Q oförändrad", () => {
  const p = makeEnv({ COMPARE_CONSENT_POLICY: "P" }), q = makeEnv();
  const pc = offerCopy(p).how.join(" ");
  assert.match(pc, /Kvitto och avtalsbekräftelse med alla villkor skickas dit, med en länk till Ditt köp och hjälp/); assert.doesNotMatch(pc, /ånger/); assert.doesNotMatch(pc, /länk för att ångra köpet/);
  assert.equal(offerCopy(q), OFFER_COPY); assert.match(offerCopy(q).how.join(" "), /länk för att ångra köpet/);
  const terms = JSON.stringify(consentSnapshot(p).terms); assert.match(terms, /Ditt köp och villkor/); assert.doesNotMatch(terms, /länk för att ångra avtalet/);
});

// ---- Policy P, EN gemensam deklaration (utkast-2) vs äldre frusna tre-rutors ordrar (utkast-1) ----
const sha = async (t) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join("");
test("äldre frusen P-order (utkast-1, tre rutor) består oförändrad: samma bevis, startar, levereras och bekräftelsen visar sina tre val", async () => {
  const f = installFetch();
  try {
    const env = makeEnv(PE); const mm = mailer(); env.COMPARE_MAILER = mm;
    const o = await plain(env, f, { run: false });
    const s = st(env, o.orderId); const ord = s.get("order"), led = s.get("ledger"), ver = "samtycke-p-utkast-1", at = ord.accept.acceptedAt;
    const T = { startNow: "Jag vill att analysen startar direkt efter att jag betalat, innan ångerfristen på 14 dagar har gått ut.", loseRight: "Jag förstår och godtar att jag förlorar min ångerrätt när tjänsten är fullt utförd, det vill säga när jag har fått min jämförelserapport.", terms: ord.accept.snapshot.texts.terms };
    const texts = { sameJob: ord.accept.snapshot.texts.sameJob, terms: T.terms, startNow: T.startNow, loseRight: T.loseRight };
    ord.accept.snapshot = { ...ord.accept.snapshot, consentVersion: ver, texts };
    ord.accept.consentVersion = ver; ord.accept.consentHash = await sha(JSON.stringify(ord.accept.snapshot));
    delete ord.accept.declaration; delete ord.accept.derivedFrom;
    const ev = async (k) => ({ value: true, at, textId: `${k}@${ver}`, textHash: await sha(T[k]), orderId: o.orderId });
    ord.accept.consents = { terms: await ev("terms"), startNow: await ev("startNow"), loseRight: await ev("loseRight") };
    led.agreement.p.consents = ord.accept.consents; led.agreement.accepted = { ...led.agreement.accepted, texts, version: ver, hash: ord.accept.consentHash };
    s.set("order", ord); s.set("ledger", led);
    await env.COMPARE_ORDERS.runAlarms();
    const v = orderOf(env, o.orderId);
    assert.equal(v.status, "delivered", v.work && v.work.error); assert.ok(f.log.anthropic.length > 0); assert.equal(f.log.refunds.length, 0);
    assert.ok(!v.work.error);
  } finally { f.restore(); }
});
test("ny deklaration: gamla tre-rutors bevis under ny (utkast-2) snapshot, eller deklaration utan egen text i snapshoten, godtas inte; accept utan deklaration nekas", async () => {
  for (const [name, mut] of [
    ["tre rutor-bevis under utkast-2-snapshot", (o) => { const c = o.accept.consents; o.accept.consents = { terms: c.terms, startNow: { ...c.declaration, textId: "startNow@samtycke-p-utkast-2" }, loseRight: { ...c.declaration, textId: "loseRight@samtycke-p-utkast-2" } }; }],
    ["deklaration utan text i snapshoten", (o) => { delete o.accept.snapshot.texts.declaration; }],
    ["deklaration=false (härledda flaggor true)", (o) => { o.accept.declaration = false; }],
    ["härledda flaggor saknas", (o) => { o.accept.startNow = false; }],
  ]) {
    const f = installFetch();
    try {
      const env = makeEnv(PE); env.COMPARE_MAILER = mailer();
      const o = await plain(env, f, { run: false });
      const s = st(env, o.orderId); const ord = s.get("order"); mut(ord); s.set("order", ord);
      await env.COMPARE_ORDERS.runAlarms();
      const v = orderOf(env, o.orderId);
      assert.equal(f.log.anthropic.length, 0, `${name}: ingen generation`); assert.equal(v.status, "failed", name); assert.equal(v.work.error, "samtycke_saknas", name); assert.equal(f.log.refunds.length, 1, name);
    } finally { f.restore(); }
  }
  const f = installFetch();
  try { const env = makeEnv(PE); const o = await readyOrder(env, [S(100000), S(110000)]); const c = await consentOf(env);
    const r = await startCheckout(env, o.orderId, o.token, { terms: true, startNow: true, loseRight: true, consentHash: c.hash, consentVersion: c.version, email: "kund@example.test" });
    assert.equal(r.status, 400); assert.equal(f.sessions.size, 0, "ingen betalsession utan deklaration");
  } finally { f.restore(); }
});
