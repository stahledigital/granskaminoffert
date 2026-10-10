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
    version: "avtal-utkast-1", draft: true,
    orderId: order.id,
    seller: (snap.terms && snap.terms.seller) || sellerInfo(env), // säljaren som kunden accepterade (frusen), inte dagens konfiguration
    price,
    product: OFFER.product,
    docCount: order.docCount,
    scope: { gets: snap.copy.gets, getsNot: snap.copy.getsNot, how: snap.copy.how },
    accepted: { at: a.acceptedAt, version: a.consentVersion, hash: a.consentHash, draft: !!a.draft, texts: snap.texts, fullTerms: snap.terms || null, dataCoverage: snap.dataCoverage, coverage: a.coverage || null, offerVersion: snap.offerVersion },
    contact: { email: a.contactEmail },
    payment: { sessionId: session.sessionId || null, paymentIntentId: session.paymentIntentId || null, amountTotal: session.amountTotal ?? null, currency: snap.currency, paidAt: now },
  };
  return { agreement, agreementHash: await sha256Hex(JSON.stringify(agreement)) };
}

export function newLedger({ agreement, agreementHash, withdrawTokenHash, env, now }) {
  const pol = retentionPolicy(env);
  return {
    v: 1, orderId: agreement.orderId, agreementId: `avt_${agreement.orderId.slice(2, 18)}`, createdAt: now,
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
    agreement: { orderId: ag.orderId, product: ag.product, price: ag.price, payment: ag.payment },
    agreementHash: null, withdrawTokenHash: null,
    withdrawal: w ? { requestId: w.requestId, at: w.at, outcome: w.outcome } : null,
    retention: ledger.retention, events: [{ at: now, type: "avtalsdel_rensad" }],
  };
}
export function addEvent(ledger, type, now, extra = {}) {
  ledger.events = [...ledger.events, { at: now, type, ...extra }].slice(-MAX_EVENTS);
}

const kr = (ore) => `${(ore / 100).toFixed(2).replace(".", ",")} kr`;
const iso = (t) => new Date(t).toISOString();

// ---- Mejl (oföränderliga mallar; hemligheter ersätts först vid sändning) ----
export function confirmationMail(ledger) {
  const ag = ledger.agreement;
  const body = [
    `Avtalsbekräftelse – ${ag.product}`,
    `Utkast: villkoren är inte slutgiltiga.`,
    ``,
    ...sellerLines(ag.seller),
    `Avtals-ID: ${ledger.agreementId}   Ordernummer: ${ag.orderId}`,
    `Köpt: ${iso(ag.payment.paidAt)}`,
    `Antal offerter: ${ag.docCount}`,
    `Pris: ${kr(ag.price.ore)} inklusive moms (varav moms ${kr(ag.price.vatOre)}, ${ag.price.vatPct} %). Engångsköp.`,
    ``,
    `Det här ingår:`, ...ag.scope.gets.map((t) => `- ${t}`),
    `Det här ingår inte:`, ...ag.scope.getsNot.map((t) => `- ${t}`),
    `Så går det till:`, ...ag.scope.how.map((t) => `- ${t}`),
    ``,
    `Du godkände (version ${ag.accepted.version}, kontrollsumma ${ag.accepted.hash}, ${iso(ag.accepted.at)}):`,
    `- ${ag.accepted.texts.sameJob}`, `- ${ag.accepted.texts.terms}`, `- ${ag.accepted.texts.immediate}`,
    ``,
    `Villkor (version ${ag.accepted.fullTerms ? ag.accepted.fullTerms.version : "saknas"}${ag.accepted.fullTerms && ag.accepted.fullTerms.draft ? ", UTKAST" : ""}) – exakt den text du godkände:`,
    ag.accepted.fullTerms ? termsPlain(ag.accepted.fullTerms) : "(villkorstexten saknas i snapshoten)",
    ``,
    `Kvittot från betalleverantören är en separat handling.`,
    ``,
    `Vill du ångra köpet? Använd den här länken: {{ANGERLANK}}`,
    `Du kan också ångra från sidan med ditt resultat.`,
  ].join("\n");
  return { id: `mail_avtal_${ag.orderId}`, kind: "avtalsbekraftelse", subject: `Avtalsbekräftelse ${ledger.agreementId}`, body };
}
export function receiptMail(ledger, wd) {
  const ag = ledger.agreement;
  const body = [
    `Mottagningsbevis – ångerbegäran`,
    `Utkast: hanteringen är inte slutgiltigt fastställd.`,
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
        : `Din begäran är sparad med tidpunkten ovan och prövas manuellt. Det här mottagningsbeviset är ingen bekräftelse på att ångerrätten gäller eller inte gäller.`,
  ].join("\n");
  return { id: `mail_angrakvitto_${ag.orderId}`, kind: "angermottagning", subject: `Mottagningsbevis ${wd.requestId}`, body };
}
export async function outboxEntry(mail, { to, now, secrets = null }) {
  return { id: mail.id, kind: mail.kind, to, subject: mail.subject, body: mail.body, bodyHash: await sha256Hex(`${mail.subject}\n${mail.body}`), secrets, state: "queued", attempts: 0, createdAt: now, sentAt: null, lastError: null, providerRef: null };
}

// ---- Export (bokföring/återbetalning, aldrig offertinnehåll eller e-post) ----
export function exportRow(order, ledger, mode) {
  const ag = ledger.agreement;
  return {
    orderId: ledger.orderId, agreementId: ledger.agreementId, paidAt: iso(ag.payment.paidAt),
    amountOre: ag.price.ore, currency: ag.price.currency, vatPct: ag.price.vatPct, vatOre: ag.price.vatOre,
    stripeSessionId: ag.payment.sessionId, stripePaymentIntentId: ag.payment.paymentIntentId,
    orderStatus: order.status, refundState: order.refund.state, refundId: order.refund.id || null, refundProviderStatus: order.refund.providerStatus || null,
    withdrawalAt: ledger.withdrawal ? iso(ledger.withdrawal.at) : null, withdrawalOutcome: ledger.withdrawal ? ledger.withdrawal.outcome : null,
    source: mode === "live" ? "stripe_live" : "stripe_test_eller_mock",
    settlement: { status: "ej_avstamt", bankDeposit: null }, // ingen utbetalning/insättning är bekräftad här
    retentionClass: "bokforing",
  };
}
