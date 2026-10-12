// Minimal order-/betal-/samtyckespost (ledger) och ångerväg för Jämför mina offerter (D06).
//
// Ledgern är SEPARAT från offertinnehåll: den innehåller aldrig offerttext, filer, rapport eller
// etiketter, bara det som behövs för avtal, ånger, återbetalning och bokföring. Den raderas inte med de
// 24 h-lagrade dokumenten eller när kunden raderar sitt innehåll. Den frusna avtalsposten (säljare, pris,
// moms, omfattning, de FAKTISKT accepterade texterna + version + hash, identifiering, betalreferenser) är
// skrivskyddad efter att den skapats; ändringar sker bara som tillagda händelser.
//
// Inget här är slutlig juridisk text, slutlig klassning eller beslutad retention (UTKAST). Extern mejlsändning
// är AV; bara ett gränssnitt (env.COMPARE_MAILER) som tester ersätter med en attrapp.

import { OFFER, OFFER_COPY, CONSENT, RETENTION_CLASSES, sellerInfo, sellerLines, termsPlain, retentionPolicy, vatPart } from "./compare_config.js";
import { sha256Hex, randomToken, timingSafeEqual } from "./compare_util.js";
import { b64Utf8 } from "./compare_mailer.js";

export const WITHDRAW_PREFIX = "ang_";
const MAX_EVENTS = 100;
const EMAIL_RE = /^[^\s@,;<>()"]{1,64}@[^\s@,;<>()"]{1,190}\.[A-Za-z]{2,}$/;

export function validEmail(v) { return typeof v === "string" && v.length <= 254 && EMAIL_RE.test(v) && !/[\r\n]/.test(v); }
export function maskEmail(e) { const [l, d] = String(e).split("@"); return l ? `${l.slice(0, 1)}***@${d}` : "***"; }

// Ångertoken: ang_<orderId>.<hemlighet>. Bara hashen av hemligheten lagras.
export async function newWithdrawToken(orderId) {
  const secret = randomToken(24);
  return { token: `${WITHDRAW_PREFIX}${orderId}.${secret}`, secretHash: await sha256Hex(secret) };
}
export function parseWithdrawToken(token) {
  const m = /^ang_(o_[0-9a-f]{32})\.([A-Za-z0-9_-]{32})$/.exec(String(token || ""));
  return m ? { orderId: m[1], secret: m[2] } : null;
}
export async function withdrawSecretMatches(ledger, secret) {
  if (!ledger || typeof ledger.withdrawTokenHash !== "string") return false;
  return timingSafeEqual(ledger.withdrawTokenHash, await sha256Hex(secret));
}

// Frusen avtalspost ur orderns snapshot (accepterade texter ligger kvar som de visades).
export async function buildAgreement(order, { env, now, session }) {
  const a = order.accept || {};
  const snap = a.snapshot;
  if (!snap || typeof snap !== "object") throw new Error("ledger: accepterad text saknas");
  const price = { ore: snap.priceOre, currency: snap.currency, vatPct: snap.vatPct, vatOre: vatPart(snap.priceOre, snap.vatPct) };
  const agreement = {
    version: a.draft ? "avtal-utkast-1" : "avtal-1", draft: !!a.draft,
    orderId: order.id,
    seller: (snap.terms && snap.terms.seller) || sellerInfo(env), // säljaren som kunden accepterade (frusen), inte dagens konfiguration
    price,
    product: snap.product || OFFER.product,
    docCount: order.docCount,
    scope: { gets: snap.copy.gets, getsNot: snap.copy.getsNot, how: snap.copy.how },
    accepted: { at: a.acceptedAt, version: a.consentVersion, hash: a.consentHash, draft: !!a.draft, texts: snap.texts, fullTerms: snap.terms || null, dataCoverage: snap.dataCoverage, coverage: a.coverage || null, offerVersion: snap.offerVersion },
    contact: { email: a.contactEmail },
    payment: { sessionId: session.sessionId || null, paymentIntentId: session.paymentIntentId || null, amountTotal: session.amountTotal ?? null, currency: snap.currency, paidAt: now },
  };
  // Policy P: de frusna valen (tid, text-ID, text-hash), fullgörandepunkten och den avtalade prestationen ingår i den frusna avtalsposten. Q-avtal får inga nya nycklar (samma hash som förut).
  if (a.policy === "P") agreement.p = { policy: "P", consents: a.consents, fulfilmentPoint: a.fulfilmentPoint, agreed: a.agreed };
  return { agreement, agreementHash: await sha256Hex(JSON.stringify(agreement)) };
}

export function newLedger({ agreement, agreementHash, withdrawTokenHash, env, now, test }) {
  const pol = retentionPolicy(env);
  return {
    v: 1, ...(test ? { test: true } : {}), orderId: agreement.orderId, agreementId: `avt_${agreement.orderId.slice(2, 18)}`, createdAt: now,
    agreement, agreementHash, withdrawTokenHash, withdrawal: null,
    retention: { class: "avtal", policyDays: pol.avtalDays, bookkeepingClass: "bokforing", bookkeepingDays: pol.bokforingDays, classes: Object.keys(RETENTION_CLASSES) },
    events: [{ at: now, type: "avtal_skapat" }],
  };
}
// Avtalsklassens utgång: behåll bara det bokföringsklassen behöver (belopp, moms, tider, Stripe-referenser, ångerbegäran som tid/utfall). Inga uppgifter om kund,
// e-post, villkorstext, samtyckestexter eller token-hash finns kvar.
export function stripLedger(ledger, now) {
  const ag = ledger.agreement, w = ledger.withdrawal;
  return {
    v: 1, orderId: ledger.orderId, agreementId: ledger.agreementId, createdAt: ledger.createdAt, stripped: true, strippedAt: now,
    agreement: { orderId: ag.orderId, product: ag.product, price: ag.price, payment: ag.payment, ...(ag.p ? { p: { policy: "P", fulfilmentPoint: ag.p.fulfilmentPoint, consents: Object.fromEntries(Object.entries(ag.p.consents || {}).map(([k, v]) => [k, { at: v.at, textId: v.textId, textHash: v.textHash }])) } } : {}) },
    agreementHash: null, withdrawTokenHash: null,
    withdrawal: w ? { requestId: w.requestId, at: w.at, outcome: w.outcome } : null,
    retention: ledger.retention, events: [{ at: now, type: "avtalsdel_rensad" }],
  };
}
export function addEvent(ledger, type, now, extra = {}) {
  ledger.events = [...ledger.events, { at: now, type, ...extra }].slice(-MAX_EVENTS);
}

export const ANGER_FILE = "angerblankett.txt";
export const kr = (ore) => `${(ore / 100).toFixed(2).replace(".", ",")} kr`;
export const iso = (t) => new Date(t).toISOString();

// ---- Standardformulär för ångerrätt (Konsumentverkets ångerblankett) som FAKTISK varaktig text ----
// Källa: Konsumentverket, "Ångerblankett" (PDF, skapad 2025-12-11, ändrad 2026-02-11; baserad på bilaga 1 i direktiv 2011/83/EU; "Företaget kan använda den här mallen").
// Primärfilen är läst (GMO-implementation, CODEX_ATERTEST/angerblankett-Konsumentverket-2025.pdf, sha256 nedan). Fälten följer mallen; uppgifterna om företaget
// och köpet förifylls ur det FRYSTA avtalet (ledger.agreement) – aldrig ur dagens konfiguration – och konsumentfälten lämnas tomma. Ingen fjärrlänk, ingen platshållare.
export const ANGERBLANKETT_SOURCE = Object.freeze({ publisher: "Konsumentverket", title: "Ångerblankett", sha256: "28718c239809fc98d1d8de9ac771338cbf62813eddf50cea44ad0167f0aad142", created: "2025-12-11", modified: "2026-02-11" });
export function withdrawalFormText(ledger) {
  const ag = ledger.agreement, sel = ag.seller || {};
  const day = new Date(ag.payment.paidAt).toISOString().slice(0, 10);
  const L = "______________________________";
  return [
    "ÅNGERBLANKETT",
    `Mall: ${ANGERBLANKETT_SOURCE.publisher}, "${ANGERBLANKETT_SOURCE.title}" (PDF ${ANGERBLANKETT_SOURCE.created}, ändrad ${ANGERBLANKETT_SOURCE.modified}, sha256 ${ANGERBLANKETT_SOURCE.sha256}). Baserad på bilaga 1 i direktiv 2011/83/EU.`,
    "",
    "Information om företaget",
    ` Namn: ${sel.name}`,
    ...(sel.form === "ENSKILD" ? [` Ägare: ${sel.owner}`] : []),
    ` Adress: ${sel.address}`,
    ` E-post: ${sel.email}`,
    "",
    "Information om konsument",
    ` Namn (kan vara fler än en person): ${L}`,
    ` Adress: ${L}`,
    ` E-post eller telefonnummer (frivilligt): ${L}`,
    "",
    `Jag/Vi* meddelar härmed att jag/vi* frånträder mitt/vårt* köpeavtal avseende följande varor*/tjänster*: ${ag.product} (avtals-ID ${ledger.agreementId}, ordernummer ${ag.orderId})`,
    "",
    `Beställdes* (datum): ${day}      Mottogs* (datum): ${L}`,
    "* Stryk det som inte gäller",
    "",
    `Underskrift (gäller endast pappersblankett): ${L}      Underskrift 2 (om ni är fler som gjort köpet): ${L}`,
    `Datum: ${L}`,
  ].join("\n");
}

// ---- Mejl (oföränderliga mallar; hemligheter ersätts först vid sändning) ----
export function pLines(ag) {
  const c = ag.p.consents, t = ag.accepted.texts, f = (k) => `[${iso(c[k].at)}; text-ID ${c[k].textId}; text-hash ${c[k].textHash}]`;
  const cov = ag.p.agreed && ag.p.agreed.sources && ag.p.agreed.sources.required;
  return [
    ``,
    `Vad du köpt: ${ag.product === OFFER.product ? `jämförelserapport för ${ag.docCount} offerter` : `${ag.product} (kontroll av din offert, tilläggstexter och PDF-bilaga som du själv bekräftar)`}${cov ? `, samt källans egna omdömesvisning för de ${ag.p.agreed.sources.coveredIds.length} företag där täckning visades före köpet (täckningskontrollsumma ${ag.p.agreed.sources.coverageHash})` : ""}.`,
    ...(c.declaration ? [
      `Din bekräftelse (en enda markering som du själv gjorde, ej förkryssad; texten ordagrant):`,
      `- ${t.declaration} ${f("declaration")}`,
      `${t.fulfilmentDef}`,
      `Villkoren godkände du genom köpklicket: ${t.terms} ${f("terms")}`,
    ] : [
      `Dina val (var och en vald av dig, ej förkryssad; texterna ordagrant):`,
      `1. ${t.startNow} ${f("startNow")}`,
      `2. ${t.loseRight} ${f("loseRight")}`,
    ]),
    `${ag.product === OFFER.product ? "Analysen" : "Förkontrollen"} startar först när den här bekräftelsen har skickats. Fullgörandepunkt: ${ag.product === OFFER.product ? (ag.p.fulfilmentPoint === "fonster_slut" ? "leveransen plus att 24 h-fönstret för att spara rapporten gått ut" : "när rapporten (och ingående omdömesvisningar) har levererats") : (ag.p.fulfilmentPoint === "fonster_slut" ? "leveransen av förkontrollen plus att 24 h-fönstret för att spara resultatet gått ut" : "när förkontrollen (rapporten och de tilläggstexter och den PDF-bilaga du själv bekräftar) har levererats") + ". Inga omdömesvisningar ingår i förkontrollen"}.`,
    `Innan tjänsten är fullt utförd kan du ångra avtalet och få hela beloppet tillbaka. När den är fullt utförd upphör ångerrätten, men reklamation och övriga rättigheter gäller. Du kan alltid kontakta oss: ${ag.seller.email}.`,
  ];
}
// D16-R2 fix3b (Anders 20:36): köpmejlet är KORT. Hela det frusna avtalet (belopp, säljare, exakt godkända texter, ordernummer, fullgörande, ångerrätt och ångerblankett) ligger i den bifogade
// PDF:en (Avtal-och-villkor.pdf), som byggs vid sändning ur ledgern (compare_docs.agreementPdf). Ingen villkorstext, ingen länk-hemlighet och inga belopp i brödtexten.
export const AGREEMENT_PDF = "Avtal-och-villkor.pdf";
export function confirmationMail(ledger) {
  const ag = ledger.agreement;
  const body = [
    `Tack för ditt köp!`,
    ``,
    `Din beställning är bekräftad. Vi förbereder ${ag.product === OFFER.product ? "din jämförelse" : "din förkontroll"}.`,
    `Avtal och köpinformation finns i bifogad PDF (${AGREEMENT_PDF}).`,
    ``,
    `Frågor? ${ag.seller.email}`,
  ].join("\n");
  return { id: `mail_avtal_${ag.orderId}`, kind: "avtalsbekraftelse", subject: `Tack för ditt köp – avtalsbekräftelse ${ledger.agreementId}`, body, attachments: [{ filename: AGREEMENT_PDF, contentType: "application/pdf", gen: "agreement" }] };
}
export function receiptMail(ledger, wd) {
  const ag = ledger.agreement;
  const body = [
    `Mottagningsbevis – ångerbegäran`,
    ...(ag.draft ? [`Utkast: hanteringen är inte slutgiltigt fastställd.`] : []),
    ``,
    `Vi har tagit emot din begäran att ångra köpet.`,
    `Begäran-ID: ${wd.requestId}   Avtals-ID: ${ledger.agreementId}   Ordernummer: ${ag.orderId}`,
    `Mottagen: ${iso(wd.at)}`,
    `Köpt: ${iso(ag.payment.paidAt)} · ${kr(ag.price.ore)}`,
    ``,
    wd.outcome === "avbrutet_fore_leverans"
      ? `Jämförelsen hade inte levererats. Vi har stoppat den och hela beloppet ska betalas tillbaka.`
      : wd.outcome === "redan_avslutad"
        ? `Jämförelsen kunde redan inte slutföras; återbetalningen hanteras separat.`
        : wd.outcome === "angrat_fore_fullgoring"
          ? `Tjänsten var inte fullt utförd enligt ditt avtal, så din ångerrätt gällde. Vi har stoppat tjänsten och hela beloppet ska betalas tillbaka utan onödigt dröjsmål och senast inom 14 dagar. Du betalar inget för det som hunnit utföras.`
          : wd.outcome === "angerratt_upphord"
            ? `Vi har tagit emot din begäran. Enligt de val du gjorde vid köpet upphörde din ångerrätt ${iso(wd.fulfilment && wd.fulfilment.fulfilledAt)} när tjänsten var fullt utförd. Någon återbetalning på grund av ångerrätt görs därför inte. Din rätt att reklamera och dina övriga rättigheter påverkas inte: kontakta oss på ${ag.seller.email} om något inte levererats eller är fel.`
            : `Din begäran är sparad med tidpunkten ovan och prövas manuellt. Det här mottagningsbeviset är ingen bekräftelse på att ångerrätten gäller eller inte gäller.`,
  ].join("\n");
  return { id: `mail_angrakvitto_${ag.orderId}`, kind: "angermottagning", subject: `Mottagningsbevis ${wd.requestId}`, body };
}
// Rapport-mejl (kort): fullständig rapport som PDF + samma avtals-PDF + personlig 24 h-länk ({{RAPPORTLANK}} fylls i vid sändning och töms efteråt). Ingen rapport-/offerttext i brödtexten.
export const REPORT_PDF_PREFIX = "Jamforelse-";
export const CHECK_PDF_PREFIX = "Forkontroll-";
export function reportReadyMail(orderId, sellerEmail, kind, rev = 0) {
  const no = orderId.slice(2, 10).toUpperCase();
  const chk = kind === "check";
  const body = [
    `Tack för ditt köp!`,
    ``,
    ...(rev ? [`Reviderat testresultat (R${rev}): ny avläsning av samma testorder efter rättning. Köp och samtycken är oförändrade.`, ``] : []),
    chk ? `Här är din förkontroll – rapporten finns bifogad som PDF.` : `Här är din jämförelse – rapporten finns bifogad som PDF.`,
    chk ? `Du kan öppna den online som skrivskyddad vy (länken gäller i 24 timmar): {{RAPPORTLANK}}\nFör att bekräfta uppgifter och få tilläggstexter och PDF-bilaga till din kund, öppna förkontrollen i webbläsaren där du köpte den.` : `Du kan också öppna den online (länken gäller i 24 timmar): {{RAPPORTLANK}}`,
    ``,
    `Avtal och köpinformation finns i den andra bilagan.`,
    ``,
    `Frågor? ${sellerEmail}`,
  ].join("\n");
  return { id: `mail_rapport${rev ? `_r${rev}` : ""}_${orderId}`, kind: "rapport", subject: (chk ? `Din förkontroll är klar – ordernummer ${no}` : `Din jämförelse är klar – ordernummer ${no}`) + (rev ? ` (reviderat testresultat R${rev})` : ""), body, attachments: [{ filename: `${chk ? CHECK_PDF_PREFIX : REPORT_PDF_PREFIX}${no}.pdf`, contentType: "application/pdf", gen: "report" }, { filename: AGREEMENT_PDF, contentType: "application/pdf", gen: "agreement" }] };
}
// Utkorgsposten fryser meddelandet (ämne, brödtext med platshållare, typade bilagor) vid köandet. Bilagor lagras som base64 (typad nyttolast, inte parsad ur brödtext).
export async function outboxEntry(mail, { to, now, secrets = null }) {
  // Typad bilaga: antingen text (base64 vid köandet) eller en PDF-beskrivning {gen:"agreement"|"report"} som byggs deterministiskt vid sändning (ingen rapporttext lagras i utkorgen).
  const attachments = (mail.attachments || []).map((a) => (a.gen ? { filename: a.filename, contentType: a.contentType, gen: a.gen } : { filename: a.filename, contentType: a.contentType, content: b64Utf8(a.text) }));
  const payloadHash = await sha256Hex(JSON.stringify({ to, subject: mail.subject, body: mail.body, attachments: attachments.map((a) => [a.filename, a.contentType, a.gen || a.content]) }));
  return { id: mail.id, kind: mail.kind, to, subject: mail.subject, body: mail.body, attachments, bodyHash: await sha256Hex(`${mail.subject}\n${mail.body}`), payloadHash, secrets, state: "queued", attempts: 0, createdAt: now, sentAt: null, lastError: null, providerRef: null };
}

// ---- Export (bokföring/återbetalning, aldrig offertinnehåll eller e-post) ----
export function exportRow(order, ledger, mode) {
  const ag = ledger.agreement;
  return {
    orderId: ledger.orderId, agreementId: ledger.agreementId, test: !!(ledger.test || order.test), paidAt: iso(ag.payment.paidAt),
    amountOre: ag.price.ore, currency: ag.price.currency, vatPct: ag.price.vatPct, vatOre: ag.price.vatOre,
    stripeSessionId: ag.payment.sessionId, stripePaymentIntentId: ag.payment.paymentIntentId,
    orderStatus: order.status, refundState: order.refund.state, refundId: order.refund.id || null, refundProviderStatus: order.refund.providerStatus || null,
    withdrawalAt: ledger.withdrawal ? iso(ledger.withdrawal.at) : null, withdrawalOutcome: ledger.withdrawal ? ledger.withdrawal.outcome : null,
    source: (ledger.test || order.test) ? "stripe_test_adminorder" : mode === "live" ? "stripe_live" : "stripe_test_eller_mock", // testorder har alltid explicit testkälla, aldrig stripe_live
    settlement: { status: "ej_avstamt", bankDeposit: null }, // ingen utbetalning/insättning är bekräftad här
    retentionClass: "bokforing",
  };
}
