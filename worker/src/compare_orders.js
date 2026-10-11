// Orderlager och tillståndsmaskin för Jämför mina offerter. EN Durable Object per order
// (SQLite-backad lagring), nyckel = order-id. Objektet är enda skrivare för ordern, så alla
// övergångar är atomära, och det kör även själva arbetet via DO-alarm (kan vara längre än en
// webbförfrågan; ingen ny Cloudflare-resurs utöver klassen/bindningen, ingen kö).
//
// Lagringen är en ADAPTER: den här klassen skriver bara mot `state.storage` (get/put/delete/
// setAlarm). Ett minnesbaserat lager används i enhetstest. Produktionsbeständighet bevisas först
// när bindningen finns i en riktig Worker (EJ gjort här) – in-memory-prov är inget driftbevis.
//
// Innehåll: offertfiler och rapport ligger i KV med 24 h TTL (för stora för DO-värden). Ordern
// själv innehåller ingen offerttext, bara metadata, status, belopp och betalningsreferenser
// (betalbokföringsunderlag, separat lagkrav).
//
// Tillstånd:
//   draft → ready → awaiting_payment → paid → running → delivered
//                                               └→ failed (→ återbetalning enligt refund)
//   draft|ready|awaiting_payment → expired | cancelled(=ready igen vid avbruten kassa)
//   delivered|failed|… → deleted (innehållet raderat på kundens begäran)

import { OFFER, LIMITS, refundMode, budgetConfig, consentSnapshot, retentionPolicy, mailerKind, FULFILMENT_POINTS, TEST_CHAIN_TO, stripeEnvFor } from "./compare_config.js";
import { mailHttpConfig, mailIdemKey, buildMailRequest, requestHash, sendViaHttp, validMailTo, IDEM_WINDOW_MS, LEASE_MS, parseMailId, applyMailEvent, deliveryOk, NEGATIVE_DELIVERY } from "./compare_mailer.js";
import { countToday, dayKey } from "./compare_budget.js";
import { timingSafeEqual, sha256Hex, newAccessToken } from "./compare_util.js";
import { agreementPdf, reportPdf, b64Bytes } from "./compare_docs.js";
import { stripLedger, validEmail, maskEmail, newWithdrawToken, withdrawSecretMatches, buildAgreement, newLedger, addEvent, confirmationMail, receiptMail, outboxEntry, exportRow, reportReadyMail } from "./compare_ledger.js";
import { evaluatePaidSession, refundOutcome, refundPayment, retrieveRefund } from "./compare_stripe.js";
import { runPipeline } from "./compare_run.js";
import { sourcesConfig, applyOp, emptySources, sourcesView, sourceCardsFor, LIM as SRC_LIM } from "./compare_sources.js";
import { PREID_MAX_ATTEMPTS } from "./compare_preid.js";

const MAX_EVENTS = 64;

// Start-/förlustsamtycke fullständigt för ordern: policy P kräver BÅDA rutorna (frusna värden med tid), policy Q den gamla rutan.
// Frusen form avgör vilka bevis som krävs: utkast-2 = EN gemensam deklaration (+ villkor via köpknappen), utkast-1 = tre separata rutor (äldre ordrar behåller sina exakta bevis).
const consentKeys = (a) => (a && a.consents && a.consents.declaration ? ["terms", "declaration"] : ["terms", "startNow", "loseRight"]);
const startAccepted = (a) => !!a && (a.policy === "P" ? a.startNow === true && a.loseRight === true && a.terms === true && (!a.consents || !a.consents.declaration || a.declaration === true) && !!(a.consents && consentKeys(a).every((k) => a.consents[k] && a.consents[k].value === true && Number.isFinite(a.consents[k].at))) : a.immediateDelivery === true);

// ---- Policy P: stark bevisprövning (servern litar aldrig på att fälten bara finns) ----
const HEX64 = /^[0-9a-f]{64}$/;
const jeq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
// Samtyckena prövas mot den frusna snapshoten (text/version/hash), orderbindning, tider och avtalsposten i ledgern. Returnerar lista med motsägelser (tom = ok).
async function consentProblems(o, ledger) {
  const a = o.accept || {};
  const bad = [];
  const snap = a.snapshot;
  if (a.policy !== "P" || !snap || typeof snap !== "object" || snap.policy !== "P") return ["policy"];
  if (!startAccepted(a)) bad.push("varde");
  if (!HEX64.test(String(a.consentHash || "")) || (await sha256Hex(JSON.stringify(snap))) !== a.consentHash) bad.push("snapshot_hash");
  if (typeof a.consentVersion !== "string" || snap.consentVersion !== a.consentVersion) bad.push("version");
  if (!FULFILMENT_POINTS.includes(a.fulfilmentPoint) || a.fulfilmentPoint !== snap.fulfilmentPoint) bad.push("fullgorandepunkt");
  const cons = a.consents || {};
  for (const k of consentKeys(a)) {
    const c = cons[k];
    if (!c || c.value !== true) { bad.push(`${k}:varde`); continue; }
    if (c.orderId !== o.id) bad.push(`${k}:order`);
    if (c.textId !== `${k}@${snap.consentVersion}`) bad.push(`${k}:textId`);
    if (typeof (snap.texts && snap.texts[k]) !== "string" || c.textHash !== (await sha256Hex(snap.texts[k]))) bad.push(`${k}:textHash`);
    if (!Number.isFinite(c.at) || c.at !== a.acceptedAt || (o.paidAt && c.at > o.paidAt)) bad.push(`${k}:tid`);
  }
  // Avtalsposten (frusen vid betalning) måste visa exakt samma val, text-hashar, punkt och avtalad prestation.
  const ag = ledger && ledger.agreement;
  if (!ag || ag.orderId !== o.id || !ag.p || ag.p.policy !== "P") bad.push("ledger");
  else {
    const pr = (c) => ({ at: c && c.at, textId: c && c.textId, textHash: c && c.textHash });
    for (const k of consentKeys(a)) if (!jeq(pr(ag.p.consents && ag.p.consents[k]), pr(cons[k]))) bad.push(`ledger:${k}`);
    if (ag.p.fulfilmentPoint !== a.fulfilmentPoint) bad.push("ledger:punkt");
    if (ag.p.agreed !== undefined && !jeq(ag.p.agreed, a.agreed)) bad.push("ledger:avtalat");
    if (ag.accepted && ag.accepted.hash !== undefined && ag.accepted.hash !== a.consentHash) bad.push("ledger:hash");
  }
  return bad;
}
// Bekräftelsen: rätt mejl-ID, transportkvittens "sent" med samma tid, före arbetsstart och före rapportens leverans.
function confirmationProblems(o, mail) {
  const a = o.accept || {}, c = a.confirmation, bad = [];
  if (!c || typeof c !== "object") return ["saknas"];
  if (c.mailId !== `mail_avtal_${o.id}`) bad.push("id");
  if (!mail || mail.state !== "sent" || mail.id !== c.mailId) bad.push("ej_sent");
  else if (!Number.isFinite(mail.sentAt) || mail.sentAt !== c.sentAt) bad.push("sentAt");
  if (!Number.isFinite(c.sentAt) || !Number.isFinite(c.at) || c.sentAt > c.at) bad.push("tid");
  // D14: HTTP-transportens "sent" är bara API-accept. Bekräftelsen räknas först när signerad leverans (till mottagarens mailserver) för SAMMA provider-ID är registrerad och ingen negativ händelse motsäger den.
  let ct = c.sentAt;
  if (mail && mail.state === "sent" && mail.transport === "http") {
    if (!deliveryOk(mail)) bad.push(mail.delivery && mail.delivery.contradiction ? "leverans_motsagd" : "ej_levererad");
    else if (mail.delivery.contradiction) bad.push("leverans_motsagd");
    else if (c.deliveredAt !== mail.delivery.at) bad.push("deliveredAt");
    else if (!Number.isFinite(c.deliveredAt) || c.deliveredAt > c.at || c.deliveredAt < c.sentAt) bad.push("tid_levererad");
    if (Number.isFinite(c.deliveredAt)) ct = c.deliveredAt;
  }
  const started = o.work && o.work.startedAt;
  const rep = o.delivery && o.delivery.report;
  if (rep && !Number.isFinite(started)) bad.push("start_saknas");
  if (Number.isFinite(started) && !(ct <= started)) bad.push("efter_start");
  if (rep && Number.isFinite(rep.at) && !(ct <= rep.at)) bad.push("efter_rapport");
  return bad;
}

function publicView(o, now) {
  const steps = (o.work && o.work.steps) || {};
  const extDone = Object.values(steps.ext || {}).filter((s) => s.state === "done").length;
  return {
    id: o.id,
    status: o.status,
    docCount: o.docCount,
    labels: o.labels,
    docs: o.docs.map((d) => ({ idx: d.idx, kind: d.kind, bytes: d.bytes, tokens: d.tokens, pages: d.pages ?? null })),
    paid: ["paid", "running", "delivered", "failed", "deleted"].includes(o.status) && !!o.paidAt,
    paidAt: o.paidAt || null,
    progress: { extracted: extDone, total: o.docCount, synth: (steps.synth && steps.synth.state) || "pending" },
    deliveredAt: o.work && o.work.deliveredAt ? o.work.deliveredAt : null,
    expiresAt: o.expiresAt,
    contentDeleted: !!o.contentDeleted,
    error: o.work && o.work.error ? o.work.error : null,
    waiting: (o.work && o.work.waiting) || null, // "avtalsbekraftelse": arbetet startar först när bekräftelsen har fått godkänd transportkvittens
    refund: { mode: o.refund.mode, state: o.refund.state, providerStatus: o.refund.providerStatus || null },
    consent: o.accept && o.accept.terms ? { accepted: true, version: o.accept.consentVersion || null, hash: o.accept.consentHash || null, draft: !!o.accept.draft, policy: o.accept.policy === "P" ? "P" : "Q" } : { accepted: false },
    price: { ore: OFFER.priceOre, currency: OFFER.currency },
    estimateOk: !!o.estimate,
    estimateMicro: o.estimate ? o.estimate.worstMicro : null,
    now,
  };
}

export class CompareOrders {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async _tx(fn) {
    return typeof this.state.blockConcurrencyWhile === "function" ? this.state.blockConcurrencyWhile(fn) : fn();
  }
  async _load() { return (await this.state.storage.get("order")) || null; }
  async _save(o) { await this.state.storage.put("order", o); }
  // Rapport-klart-mejl (idempotent, EN post per order: outbox:mail_rapport_<id>). Innehåller ingen rapport/offerttext – bara en personlig länk (resultattoken, endast hash lagras på ordern) som gäller tills rapporten raderas (24 h).
  // Mottagaren är alltid orderns frusna kontakt (testorder: bara TEST_CHAIN_TO). Returnerar put-objekt att committa ihop med ordern, eller {} (redan köad / ingen transport / ingen giltig mottagare).
  async _reportMailPut(o, now) {
    const key = `outbox:mail_rapport_${o.id}`;
    if (await this.state.storage.get(key)) return {};
    const to = o.accept && o.accept.contactEmail;
    if (!to || !validEmail(to) || !o.reportKey || mailerKind(this.env) === null) return {};
    if (o.test && to !== TEST_CHAIN_TO) return {};
    const origin = (() => { try { return new URL(this.env.COMPARE_RETURN_URL).origin; } catch { return ""; } })();
    if (!origin) return {};
    const token = newAccessToken();
    o.resultTokenHash = await sha256Hex(token);
    o.resultExpiresAt = ((o.work && o.work.deliveredAt) || now) + OFFER.retentionHours * 3600_000;
    const ledger = await this.state.storage.get("ledger");
    if (!ledger || !ledger.agreement || !ledger.agreement.seller) return {}; // avtals-PDF:en byggs ur den frusna ledgern; saknas den köas inget halvt mejl
    const mail = reportReadyMail(o.id, ledger.agreement.seller.email);
    return { [key]: await outboxEntry(mail, { to, now, secrets: { RAPPORTLANK: `${origin}/jamfor/#o=${o.id}&r=${token}`, KOPLANK: `${origin}/jamfor/kop/` } }) };
  }
  // Flernyckelskrivning som hör ihop (order + ledger + utkorg + radering) ska gå in ATOMISKT. Med lagrets explicita transaktion
  // (Cloudflare SQLite-DO: storage.transaction) rullas allt tillbaka vid fel. Saknas transaktion (äldre adapter) skrivs ordern SIST och
  // _repairWithdrawal() återställer en halvskriven ånger (se nedan), så en accepterad ånger aldrig följs av arbete.
  async _commit({ put = {}, del = [] }) {
    const st = this.state.storage;
    if (typeof st.transaction === "function") {
      await st.transaction(async (txn) => {
        for (const [k, v] of Object.entries(put)) await txn.put(k, v);
        for (const k of del) await txn.delete(k);
      });
      return;
    }
    for (const k of del) await st.delete(k);
    const keys = Object.keys(put).sort((a, b) => (a === "order") - (b === "order"));
    for (const k of keys) await st.put(k, put[k]);
  }
  // Idempotent återställning: finns en registrerad ånger men ordern står kvar som betald/pågående (avbrott mitt i skrivningen) så slutförs
  // avbrottet nu – före allt arbete. Körs vid varje åtkomst av en betald order och före arbetsclaim i alarm.
  async _repairWithdrawal(o, now) {
    if (!o || !["paid", "running"].includes(o.status)) return false;
    const ledger = await this.state.storage.get("ledger");
    if (!ledger || !ledger.withdrawal) return false;
    const refundCall = this._cancelWork(o);
    ledger.withdrawal.outcome = "avbrutet_fore_leverans";
    addEvent(ledger, "angerbegaran_reparerad", now, { reason: "order_fortfarande_betald" });
    const m = receiptMail(ledger, ledger.withdrawal);
    const put = { order: o, ledger };
    if (!(await this.state.storage.get(`outbox:${m.id}`))) put[`outbox:${m.id}`] = await outboxEntry(m, { to: ledger.agreement.contact.email, now });
    await this._commit({ put, del: ["sources"] });
    this._afterTx = async () => { await this._runRefund(refundCall); await this._purgeDocs(await this._load()); await this._ensureAlarm(o, now, true); };
    return true;
  }
  _cancelWork(o) {
    o.work.lease = null; o.work.error = "angrat"; o.status = "failed"; o.contentDeleted = true;
    o.purgeKeys = [...new Set([...(o.purgeKeys || []), ...o.docs.map((d) => d.key).filter(Boolean)])];
    o.docs = o.docs.map((d) => ({ ...d, key: null }));
    return this._planRefund(o);
  }

  _auth(o, tokenHash) {
    return !!o && typeof tokenHash === "string" && tokenHash.length === 64 && timingSafeEqual(o.tokenHash, tokenHash);
  }

  async fetch(request) {
    let b;
    try { b = await request.json(); } catch { return Response.json({ ok: false, error: "ogiltig" }, { status: 400 }); }
    const path = new URL(request.url).pathname;
    const now = Number.isFinite(b && b.now) ? b.now : Date.now();
    try {
      const out = await this._tx(() => this._handle(path, b || {}, now));
      if (out.after) await out.after();
      if (this._afterTx) { const a = this._afterTx; this._afterTx = null; await a(); }
      return Response.json(out.body, { status: out.status || 200 });
    } catch (e) {
      return Response.json({ ok: false, error: "internt" }, { status: 500 });
    }
  }

  async _handle(path, b, now) {
    const NOT_FOUND = { status: 404, body: { ok: false, error: "hittas_inte" } };
    // ---- Skapa ----
    if (path === "/create") {
      if (await this._load()) return { status: 409, body: { ok: false, error: "finns" } };
      const { id, tokenHash, labels, docCount, accept } = b;
      if (typeof id !== "string" || typeof tokenHash !== "string" || tokenHash.length !== 64) return { status: 400, body: { ok: false, error: "ogiltig" } };
      if (!Number.isInteger(docCount) || docCount < OFFER.minDocs || docCount > OFFER.maxDocs || !Array.isArray(labels) || labels.length !== docCount) return { status: 400, body: { ok: false, error: "antal" } };
      const o = {
        id, tokenHash, createdAt: now, expiresAt: now + OFFER.retentionHours * 3600_000, status: "draft",
        docCount, labels, docs: [], ...(b.test === true ? { test: true } : {}), accept: accept || null, estimate: null, stripe: null, paidAt: null,
        work: { attempts: 0, lease: null, steps: { ext: {}, synth: { state: "pending", attempts: 0 } }, deliveredAt: null, error: null },
        refund: { mode: refundMode(this.env), state: "none", id: null, at: null },
        events: [], contentDeleted: false, reportKey: null, lastReconcileAt: 0, lastRefundCheckAt: 0, checkout: { attempt: 0, intent: null }, purgeKeys: [],
      };
      await this._save(o);
      return { body: { ok: true, order: publicView(o, now) }, after: async () => { if (this.state.storage.setAlarm) await this.state.storage.setAlarm(o.expiresAt + 65 * 60_000 + 10); } }; // D15: rensningslarm för obetalda ordrar
    }
    const o = await this._load();
    if (!o) {
      // Fullpurge kan ha lämnat kvar ett beständigt städunderlag (global mr-post som inte gick att ta bort): försök igen vid nästa svep.
      if (path === "/retention-sweep" && (await this.state.storage.get("cleanup"))) return { body: { ok: true, ...(await this._retryCleanup(now)) } };
      return NOT_FOUND;
    }
    await this._repairWithdrawal(o, now);
    if (path === "/retention-close-review") return { body: await this._closeReview(o, b, now) };
    if (path === "/retention-sweep") {
      const cl = (await this.state.storage.get("cleanup")) ? await this._retryCleanup(now) : null;
      const sw = await this._retentionSweep(o, now);
      return { body: { ok: true, ...sw, ...(cl && !sw.purged ? { cleanupPending: cl.pending } : {}) } };
    }
    if (o.paidAt) { const sw = await this._retentionSweep(o, now); if (sw.purged) return NOT_FOUND; } // lazy: verklig rensning när posten åtkoms efter förfallotid
    // Obetalda utkast går ut efter retentionstiden.
    if (["draft", "ready", "awaiting_payment"].includes(o.status) && now > o.expiresAt) { o.status = "expired"; await this._save(o); }

    // ---- Interna (Worker→DO) ----
    // D16-R2: testordrar och riktiga ordrar hålls isär i båda riktningar (test betalas bara via testhooken, riktiga aldrig via den).
    if ((path === "/paid" || path === "/checkout-expired") && !!o.test !== !!b.viaTestHook) return { status: 422, body: { ok: false, error: "betalning_ogiltig", reason: "testorder" } };
    if (["/accept", "/checkout-begin", "/checkout-set"].includes(path) && !!o.test !== !!b.testAdmin) return { status: 403, body: { ok: false, error: "testorder" } };
    if (path === "/paid") return this._paid(o, b, now);
    if (path === "/checkout-expired") {
      if (b.eventId && o.events.includes(b.eventId)) return { body: { ok: true, dup: true } };
      if (b.eventId) { o.events.push(b.eventId); o.events = o.events.slice(-MAX_EVENTS); }
      if (o.status === "awaiting_payment" && o.stripe && o.stripe.sessionId === b.sessionId) { o.status = "ready"; o.stripe = null; o.checkout.intent = null; }
      await this._save(o);
      return { body: { ok: true } };
    }
    if (path === "/internal") return { body: { ok: true, order: o } };
    // D07-rättelse: aktuell källstatus per offert (offentliga, kundbekräftade profiler) för den befintliga rapportrutten. Intern (anropas först efter /report-auth i rutten),
    // ingen ny åtkomst och inget omdömesinnehåll. Efter 24 h/radering tomt.
    if (path === "/source-cards") {
      const gone = ["deleted", "expired"].includes(o.status) || o.contentDeleted || now > Math.max(o.expiresAt, ((o.work && o.work.deliveredAt) || 0) + OFFER.retentionHours * 3600_000);
      if (gone || !Array.isArray(b.offers)) return { body: { ok: true, cards: null } };
      return { body: { ok: true, cards: sourceCardsFor(sourcesConfig(this.env), (await this.state.storage.get("sources")) || emptySources(), b.offers.map((i) => ({ index: i }))), asOf: new Date(now).toISOString() } };
    }
    if (path === "/refund-update") return this._refundUpdate(o, b, now);
    if (path === "/mail-event") return this._mailEvent(o, b, now);
    if (path === "/withdraw") return this._withdraw(o, b, now);
    if (path === "/ledger-export") {
      const l = await this.state.storage.get("ledger");
      if (!l) return NOT_FOUND;
      if (!!(l.test || o.test) !== (b.testOnly === true)) return { body: { ok: true, skipped: "test" } }; // ordinarie bokföringsexport utesluter testordrar; test-only-diagnostik visar bara dem
      const row = exportRow(o, l, b.mode);
      const cm = await this.state.storage.get(`outbox:mail_avtal_${o.id}`);
      row.confirmationMail = cm ? { transport: cm.transport || null, accepted: cm.state === "sent", delivery: cm.delivery ? cm.delivery.state : "none", inboxProof: false } : null; // D14: inboxProof är alltid false – leverans till mailserver ≠ inkorg
      return { body: { ok: true, row } };
    }

    // ---- Rapportåtkomst: orderns åtkomstnyckel ELLER resultattoken (endast läsning av rapporten, giltig tills rapporten raderas) ----
    if (path === "/report-auth") {
      const ok = this._auth(o, b.tokenHash)
        || (o.status === "delivered" && typeof o.resultTokenHash === "string" && typeof b.tokenHash === "string" && b.tokenHash.length === 64 && timingSafeEqual(o.resultTokenHash, b.tokenHash) && now < (o.resultExpiresAt || 0));
      return ok ? { body: { ok: true } } : NOT_FOUND;
    }
    // Återhämtning för TESTKEDJAN (admin): köa rapport-klart-mejlet för en redan levererad testorder (idempotent; ingen ny order, ingen tokenbypass).
    if (path === "/report-mail") {
      if (!o.test || b.testAdmin !== true) return { status: 403, body: { ok: false, error: "testorder" } };
      if (o.status !== "delivered" || !o.reportKey) return { status: 409, body: { ok: false, error: "ej_levererad" } };
      if (now >= ((o.work && o.work.deliveredAt) || 0) + OFFER.retentionHours * 3600_000) return { status: 410, body: { ok: false, error: "utgangen" } };
      const rm = await this._reportMailPut(o, now);
      if (Object.keys(rm).length === 0) { const ex = await this.state.storage.get(`outbox:mail_rapport_${o.id}`); return { body: { ok: true, queued: false, state: ex ? ex.state : null } }; }
      await this._commit({ put: { order: o, ...rm } });
      return { body: { ok: true, queued: true }, after: async () => { if (this.state.storage.setAlarm) await this.state.storage.setAlarm(Date.now() + 10); } };
    }
    // ---- Publika (kräver åtkomstnyckel) ----
    if (!this._auth(o, b.tokenHash)) return NOT_FOUND;
    if (path === "/source-delivered") return this._sourceDelivered(o, b, now);

    // ---- D07 källor (omdömen): firmaidentitet, kandidat-ID och bekräftelse. Ingen omdömesdata lagras här. ----
    // Källuppgifter (firmanamn/ort/ID) följer ordervärdet: oåtkomliga och raderade efter 24 h (lazy – ingen schemalagd rensning, se COMPARE.md).
    const srcGone = ["deleted", "expired"].includes(o.status) || o.contentDeleted || now > Math.max(o.expiresAt, ((o.work && o.work.deliveredAt) || 0) + OFFER.retentionHours * 3600_000);
    if ((path === "/sources-get" || path === "/sources-op") && srcGone) await this.state.storage.delete("sources");
    if (path === "/sources-get") {
      if (srcGone) return { body: { ok: true, sources: sourcesView(sourcesConfig(this.env), emptySources()), state: emptySources() } };
      const st = (await this.state.storage.get("sources")) || emptySources();
      if (b.countView) {
        if (st.views >= SRC_LIM.viewsPerOrder) return { status: 429, body: { ok: false, error: "visningar" } };
        st.views += 1; await this.state.storage.put("sources", st);
      }
      return { body: { ok: true, sources: sourcesView(sourcesConfig(this.env), st), state: st } };
    }
    if (path === "/sources-op") {
      if (srcGone) return { status: 409, body: { ok: false, error: "raderad" } };
      const st = (await this.state.storage.get("sources")) || emptySources();
      const op = b.op;
      if (!op || typeof op !== "object") return { status: 400, body: { ok: false, error: "op" } };
      if (op.type === "record_search" && st.providerRequests >= SRC_LIM.providerRequestsPerOrder) return { status: 429, body: { ok: false, error: "gransen_for_ordern" } };
      const r = await applyOp(sourcesConfig(this.env), st, { ...op, now });
      if (r.error) return { status: 400, body: { ok: false, error: r.error } };
      await this.state.storage.put("sources", r.state);
      return { body: { ok: true, sources: sourcesView(sourcesConfig(this.env), r.state), state: r.state } };
    }

    // ---- D11 förköpsidentitet: engångsläsning av utställaren per dokument (claim → anrop → put). Lagras som resten av ordern och raderas med den. ----
    // VARJE faktisk generation får ett unikt, aldrig återanvänt claimId (monotont räknarvärde). Resultatet (put) accepteras bara för SAMMA claimId, SAMMA
    // dokumenthash och SAMMA ctx (modell/promptversion/schema). Byte av fil/ctx ersätter posten; ett sent svar för en ersatt claim avvisas (men dess kostnad
    // är redan avräknad en gång under sin egen unika budgetnyckel).
    if (path === "/preid-claim" || path === "/preid-put" || path === "/preid-get") {
      const gone = ["deleted", "expired", "failed"].includes(o.status) || o.contentDeleted || now > o.expiresAt;
      if (gone) { await this.state.storage.delete("preid"); return { status: 409, body: { ok: false, error: "raderad" } }; }
      const st = (await this.state.storage.get("preid")) || { rec: {}, total: 0, seq: 0 };
      if (!Number.isInteger(st.seq)) st.seq = 0;
      const docOf = (idx) => o.docs.find((d) => d.idx === idx && d.key) || null;
      const ctx = typeof b.ctx === "string" && b.ctx.length >= 8 && b.ctx.length <= 128 ? b.ctx : null;
      if (path === "/preid-get") {
        const out = {};
        for (const [k, r] of Object.entries(st.rec)) { const d = docOf(Number(k)); if (d && d.sha256 === r.sha && ctx && r.ctx === ctx) out[k] = { state: r.state, attempts: r.attempts, identity: r.state === "done" ? r.identity : null }; }
        return { body: { ok: true, docCount: o.docCount, status: o.status, records: out } };
      }
      if (!ctx) return { status: 400, body: { ok: false, error: "ogiltig" } };
      if (!["ready", "awaiting_payment"].includes(o.status) || o.docs.length !== o.docCount) return { status: 409, body: { ok: false, error: "status" } };
      const idx = b.idx, d = Number.isInteger(idx) ? docOf(idx) : null;
      if (!d) return { status: 400, body: { ok: false, error: "ogiltig" } };
      let r = st.rec[idx];
      if (r && (r.sha !== d.sha256 || r.ctx !== ctx)) { r = null; delete st.rec[idx]; } // annat dokument/annan modell-prompt-schema: gammal identitet gäller inte
      if (path === "/preid-claim") {
        if (r && r.state === "done") return { body: { ok: true, cached: true } };
        if (r && r.state === "claimed" && now - r.claimedAt < 150_000) return { status: 409, body: { ok: false, error: "pagar" } };
        const attempts = r ? r.attempts : 0;
        if (attempts >= PREID_MAX_ATTEMPTS || st.total >= o.docCount * PREID_MAX_ATTEMPTS * 2) return { status: 429, body: { ok: false, error: "gransen" } };
        st.seq += 1;
        const claimId = "c" + st.seq;
        st.rec[idx] = { sha: d.sha256, ctx, claimId, attempts: attempts + 1, state: "claimed", claimedAt: now, identity: null };
        st.total += 1;
        await this.state.storage.put("preid", st);
        return { body: { ok: true, claimId, attempt: attempts + 1, doc: { key: d.key, tokens: d.tokens, sha256: d.sha256 } } };
      }
      // /preid-put: samma claim, samma dokument, samma ctx, fortfarande pågående
      if (!r || r.state !== "claimed" || r.claimId !== b.claimId || r.sha !== d.sha256 || r.ctx !== ctx) { await this.state.storage.put("preid", st); return { status: 409, body: { ok: false, error: "okand_claim" } }; }
      if (b.identity && typeof b.identity === "object") { r.state = "done"; r.identity = b.identity; } else { r.state = "open"; r.identity = null; }
      await this.state.storage.put("preid", st);
      return { body: { ok: true, state: r.state } };
    }

    if (path === "/get") {
      let after = (o.status === "paid" || o.status === "running") ? async () => this._ensureAlarm(o, now) : undefined;
      // Återhämtning för redan levererade ordrar (levererade före rapportmejlet fanns): ENDAST efter lyckad FULL orderautentisering (resultattoken når aldrig hit) köas det saknade rapport-mejlet
      // idempotent (EN post, samma frusna kontakt, samma transport/dygnstak) inom retentionsfönstret. Ingen ny betalning, ingen AI, ingen ny order.
      if (o.status === "delivered" && o.reportKey && now < ((o.work && o.work.deliveredAt) || 0) + OFFER.retentionHours * 3600_000) {
        const rm = await this._reportMailPut(o, now);
        if (Object.keys(rm).length) { await this._commit({ put: { order: o, ...rm } }); after = async () => { if (this.state.storage.setAlarm) await this.state.storage.setAlarm(Date.now() + 10); }; }
      }
      const extras = await this._extras();
      return { body: { ok: true, order: { ...publicView(o, now), ...extras }, testOrder: !!o.test, reconcile: this._shouldReconcile(o, now), refundCheck: this._shouldRefundCheck(o, now) ? { refundId: o.refund.id } : null }, after };
    }
    if (path === "/doc") {
      // Manifest-commit: enda stället som avgör vilken fil som hör till ordern. Avslag returnerar `keep` =
      // nyckeln som redan gäller för platsen, så att anroparen aldrig raderar en nyckel som manifestet använder.
      const { meta } = b;
      const keepFor = (idx) => { const d = o.docs.find((x) => x.idx === idx); return d && d.key ? d.key : null; };
      const reject = (status, error, extra = {}) => ({ status, body: { ok: false, error, keep: meta && Number.isInteger(meta.idx) ? keepFor(meta.idx) : null, ...extra } });
      if (!["draft", "ready"].includes(o.status)) return reject(409, "last");
      if (!meta || !Number.isInteger(meta.idx) || meta.idx < 0 || meta.idx >= o.docCount || typeof meta.key !== "string" || !/^cmpdoc:o_[0-9a-f]{32}:[0-3]:[0-9a-f]{40}$/.test(meta.key)) return reject(400, "ogiltig");
      const clean = { idx: meta.idx, kind: meta.kind, bytes: meta.bytes, tokens: meta.tokens, pages: meta.pages ?? null, sha256: meta.sha256, key: meta.key };
      if (o.docs.some((d) => d.idx !== clean.idx && d.sha256 === clean.sha256)) return reject(409, "dubblett");
      const prev = o.docs.find((d) => d.idx === clean.idx) || null;
      const next = [...o.docs.filter((d) => d.idx !== clean.idx), clean].sort((x, y) => x.idx - y.idx);
      const totalBytes = next.reduce((a, d) => a + d.bytes, 0), totalTokens = next.reduce((a, d) => a + d.tokens, 0);
      const totalPages = next.reduce((a, d) => a + (d.pages || 0), 0);
      if (totalBytes > LIMITS.maxTotalBytes || totalTokens > LIMITS.maxTotalInputTokens || totalPages > LIMITS.maxPdfPagesTotal) return reject(413, "for_stort");
      o.docs = next;
      if (o.docs.length === o.docCount) { o.status = "ready"; o.estimate = b.estimate || null; } else { o.status = "draft"; o.estimate = null; }
      await this._save(o);
      return { body: { ok: true, order: publicView(o, now), replaced: prev && prev.key && prev.key !== clean.key ? prev.key : null } };
    }
    if (path === "/accept") {
      if (!["draft", "ready", "awaiting_payment"].includes(o.status)) return { status: 409, body: { ok: false, error: "status" } };
      const a = b.accept;
      const snapshot = consentSnapshot(this.env); // policyn (P/Q) avgörs av servern ur snapshoten, aldrig av klienten
      const P = snapshot.policy === "P";
      if (!a || a.terms !== true || (P ? a.declaration !== true : a.immediateDelivery !== true) || typeof a.consentHash !== "string" || a.consentHash.length !== 64 || typeof a.consentVersion !== "string") return { status: 400, body: { ok: false, error: "ogiltig" } };
      if (!validEmail(a.contactEmail) || (o.test && a.contactEmail !== TEST_CHAIN_TO)) return { status: 400, body: { ok: false, error: "epost" } };
      // De FAKTISKT visade texterna fryses här: hashen måste stämma mot texten som sparas (inte bara en hash som senare saknar text).
      if ((await sha256Hex(JSON.stringify(snapshot))) !== a.consentHash) return { status: 409, body: { ok: false, error: "samtycke_andrat" } };
      // Vad kunden accepterade: version + hash av exakt de texter/priser som visades, när, och för hur många offerter.
      const srcState = (await this.state.storage.get("sources")) || emptySources();
      const sv = sourcesView(sourcesConfig(this.env), srcState);
      const cv = sv.coverage;
      const coverage = { active: cv.active, firms: cv.firms, google: cv.google, trustpilot: cv.trustpilot }; // bara antal per läge – inga firmanamn, ingen omdömesdata
      const base = { ...(o.accept || {}), coverage, terms: true, contactEmail: a.contactEmail, snapshot, acceptedAt: now, consentVersion: a.consentVersion, consentHash: a.consentHash, draft: a.draft === true, offerVersion: a.offerVersion, priceOre: a.priceOre, currency: a.currency, docCount: o.docCount };
      if (!P) o.accept = { ...base, immediateDelivery: true };
      else {
        // Policy P: varje val fryses som eget värde med tid, text-ID och text-hash; avtalad prestation (rapport + täckta källfirmor) fryses i samma steg.
        const ev = async (key) => ({ value: true, at: now, textId: `${key}@${snapshot.consentVersion}`, textHash: await sha256Hex(snapshot.texts[key]), orderId: o.id });
        const coveredIds = sv.active ? sv.firms.filter((f) => f.google.state === "tillganglig" || f.trustpilot.state === "tillganglig").map((f) => f.id) : [];
        const providers = Object.fromEntries(sv.firms.filter((f) => coveredIds.includes(f.id)).map((f) => [f.id, ["google", "trustpilot"].filter((pv) => f[pv].state === "tillganglig")])); // exakt vilka källor som är avtalade per firma
        // EN faktisk handling: den ENA aktiva deklarationen (kryssruta) + köpklicket (villkoren). startNow/loseRight är HÄRLEDDA ur deklarationen, inte tre separata val.
        o.accept = { ...base, policy: "P", declaration: true, startNow: true, loseRight: true, derivedFrom: "declaration", fulfilmentPoint: snapshot.fulfilmentPoint,
          consents: { terms: { ...(await ev("terms")), via: "kopknapp" }, declaration: { ...(await ev("declaration")), covers: ["startNow", "loseRight"] } },
          agreed: { report: true, sources: { required: coveredIds.length > 0, coveredIds, providers, coverageHash: await sha256Hex(JSON.stringify(cv.lines || [])) } } };
      }
      await this._save(o);
      return { body: { ok: true } };
    }
    if (path === "/consent-status") {
      // Finns ett samtycke som matchar den aktuella texten (hash)? Används av "betala igen" utan ny presentation.
      const same = !!(o.accept && o.accept.terms && startAccepted(o.accept) && o.accept.snapshot && validEmail(o.accept.contactEmail) && o.accept.consentHash === b.consentHash && o.accept.docCount === o.docCount);
      return { body: { ok: true, same } };
    }
    if (path === "/checkout-begin") {
      if (o.status === "awaiting_payment" && o.stripe && o.stripe.url && o.stripe.expiresAt > now + 60_000) return { body: { ok: true, reuse: { url: o.stripe.url }, order: publicView(o, now) } };
      if (!["ready", "awaiting_payment"].includes(o.status)) return { status: 409, body: { ok: false, error: "status", status_: o.status } };
      const a = o.accept;
      if (!a || !a.sameJob || !a.terms || !startAccepted(a) || !a.consentHash || !o.estimate) return { status: 409, body: { ok: false, error: "ej_klar" } };
      // Samtycket måste vara givet till exakt den text/pris som gäller nu (hash) och för just detta antal offerter.
      if (a.consentHash !== b.consentHash || a.docCount !== o.docCount) return { status: 409, body: { ok: false, error: "samtycke_andrat" } };
      // Försök: parametrarna (utgångstid) fryses per försök. Samma försök → exakt samma Stripe-anrop (idempotent).
      // Nytt försök (ny nyckel) först när det frusna fönstret är för kort för Stripe (min 30 min) eller sessionen gått ut.
      const c = o.checkout;
      if (!c.intent || c.intent.expiresAtSec * 1000 <= now + 31 * 60_000) {
        c.attempt += 1;
        c.intent = { attempt: c.attempt, expiresAtSec: Math.floor((now + 60 * 60_000) / 1000) };
        await this._save(o);
      }
      return { body: { ok: true, snapshot: { id: o.id, docCount: o.docCount, attempt: c.intent.attempt, expiresAtSec: c.intent.expiresAtSec }, order: publicView(o, now) } };
    }
    if (path === "/checkout-set") {
      if (!["ready", "awaiting_payment"].includes(o.status)) return { status: 409, body: { ok: false, error: "status" } };
      const s = b.session;
      if (!s || typeof s.id !== "string" || typeof s.url !== "string") return { status: 400, body: { ok: false, error: "ogiltig" } };
      if (o.stripe && o.stripe.sessionId && o.stripe.sessionId !== s.id && o.stripe.expiresAt > now) return { body: { ok: true, url: o.stripe.url } }; // samtidig skapare: första vinner
      o.stripe = { sessionId: s.id, url: s.url, expiresAt: s.expiresAt, methods: Array.isArray(s.methods) ? s.methods.filter((x) => typeof x === "string").slice(0, 4) : null, paymentIntentId: null, attempt: o.checkout.intent ? o.checkout.intent.attempt : null };
      o.status = "awaiting_payment";
      await this._save(o);
      return { body: { ok: true, url: s.url } };
    }
    if (path === "/reconcile-mark") { o.lastReconcileAt = now; await this._save(o); return { body: { ok: true, sessionId: o.stripe && o.stripe.sessionId } }; }
    if (path === "/delete") {
      if (["paid", "running"].includes(o.status)) return { status: 409, body: { ok: false, error: "pagar" } };
      const keys = [...new Set([...o.docs.map((d) => d.key).filter(Boolean), ...(o.purgeKeys || [])])].concat(o.reportKey ? [o.reportKey] : []);
      for (const k of keys) { try { await this.env.REVIEWS_KV.delete(k); } catch { /* TTL tar resten */ } }
      for (const d of Object.keys((o.work && o.work.steps && o.work.steps.ext) || {})) await this.state.storage.delete(`ext:${d}`);
      await this.state.storage.delete("sources"); await this.state.storage.delete("preid");
      o.docs = []; o.purgeKeys = []; o.reportKey = null; o.contentDeleted = true; o.estimate = null;
      if (["draft", "ready", "awaiting_payment", "expired"].includes(o.status)) o.status = "deleted";
      await this._save(o);
      return { body: { ok: true, order: publicView(o, now) } };
    }
    return NOT_FOUND;
  }

  _shouldReconcile(o, now) {
    return o.status === "awaiting_payment" && !!o.stripe && now - (o.lastReconcileAt || 0) > LIMITS.reconcileMinMs;
  }

  // Betalning bekräftad (webhook eller serveravstämning). Samma kontroll för båda; returnsidan räknas aldrig.
  async _paid(o, b, now) {
    const mode = b.mode;
    if (b.eventId && o.events.includes(b.eventId)) return { body: { ok: true, dup: true, status: o.status } };
    const ev = evaluatePaidSession(b.session, o, mode);
    if (!ev.ok) return { status: 422, body: { ok: false, error: "betalning_ogiltig", reason: ev.reason } };
    if (b.eventId) { o.events.push(b.eventId); o.events = o.events.slice(-MAX_EVENTS); }
    if (["paid", "running", "delivered", "failed", "deleted"].includes(o.status) && o.paidAt) {
      await this._save(o); // endast händelse-ID registreras; ingen ny rätt, inget nytt jobb
      return { body: { ok: true, dup: true, status: o.status } };
    }
    o.paidAt = now;
    o.status = "paid";
    o.stripe = { ...(o.stripe || {}), paymentIntentId: ev.paymentIntentId, amountTotal: ev.amountTotal };
    // Avtalsposten fryses ur orderns snapshot och bevaras skild från dokument/rapport. Misslyckas den fryses ordern inte som betald utan avtal.
    const { agreement, agreementHash } = await buildAgreement(o, { env: this.env, now, session: { sessionId: o.stripe.sessionId, paymentIntentId: ev.paymentIntentId, amountTotal: ev.amountTotal } });
    const wt = await newWithdrawToken(o.id);
    const ledger = newLedger({ agreement, agreementHash, withdrawTokenHash: wt.secretHash, env: this.env, now, test: !!o.test });
    const origin = (() => { try { return new URL(this.env.COMPARE_RETURN_URL).origin; } catch { return ""; } })();
    const mail = confirmationMail(ledger);
    const entry = await outboxEntry(mail, { to: o.accept.contactEmail, now, secrets: { ANGERLANK: `${origin}/jamfor/angra/#t=${wt.token}`, KOPLANK: `${origin}/jamfor/kop/` } });
    await this._commit({ put: { ledger, [`outbox:${mail.id}`]: entry, order: o } }); // betald + avtalspost + bekräftelse: allt eller inget
    return { body: { ok: true, status: "paid" }, after: async () => { await this._ensureAlarm(o, now, true); await this._indexLedger(o.id, now); } };
  }

  // D15 – automatisk fysisk rensning av OBETALDA ordrar (löftet "raderas efter 24 timmar" ska inte bero på att någon råkar läsa ordern).
  // Fas 1 vid expiresAt + 65 min: filer, extraktioner, förköpsidentitet och källuppgifter raderas. Fas 2 vid expiresAt + 72 h (Stripe-sessionen kan som mest leva 24 h efter att ordern
  // skapades senast och Stripes webhookomförsök når 3 dygn): hela orderposten (inkl. e-post och villkorssnapshot) raderas om ingen betalning/avtalspost finns.
  // Betalda ordrar och ordrar med avtalspost berörs aldrig (de följer terminalrensningen och retentionsklasserna).
  async _unpaidLifecycle(now) {
    const st = this.state.storage;
    // HELA kontroll + plan + lokal radering sker i ETT serialiserat steg (samma blockConcurrencyWhile som varje fetch, inkl. /paid): ingen betalning kan hinna in mellan kontroll och städning.
    return this._tx(async () => {
      const unpaid = async (c) => !!c && !c.paidAt && !["paid", "running", "delivered", "failed"].includes(c.status) && !(await st.get("ledger"));
      const o = await this._load();
      if (!(await unpaid(o))) return false;
      const P1 = o.expiresAt + 65 * 60_000, WIPE = o.expiresAt + 72 * 3600_000; // en öppen Stripe-session lever högst 60 min efter försöksstart
      if (now < P1) { if (st.setAlarm) await st.setAlarm(P1 + 10); return true; }
      if (!o.contentDeleted) {
        const failed = [];
        for (const k of new Set([...(o.purgeKeys || []), ...o.docs.map((d) => d.key).filter(Boolean)])) { try { await this.env.REVIEWS_KV.delete(k); } catch { failed.push(k); } }
        for (const k of (await st.list({ prefix: "ext:" })).keys()) await st.delete(k);
        for (const k of ["aux:priority", "preid", "sources"]) await st.delete(k);
        o.docs = []; o.purgeKeys = failed; o.contentDeleted = true; o.estimate = null; await this._save(o); // misslyckade KV-nycklar: TTL 24 h är reservvägen
      }
      if (now < WIPE) { if (st.setAlarm) await st.setAlarm(WIPE + 10); return true; }
      // Återkontroll av AKTUELL post omedelbart före fullwipe: betald order eller avtalspost raderas aldrig av detta svep.
      if (!(await unpaid(await this._load()))) return false;
      for (const k of (await st.list()).keys()) await st.delete(k);
      return true;
    });
  }

  async _ensureAlarm(o, now, force = false) {
    if (!this.state.storage.setAlarm) return;
    const cur = this.state.storage.getAlarm ? await this.state.storage.getAlarm() : null;
    const leaseUntil = o.work && o.work.lease ? o.work.lease.until : 0;
    if (force || cur === null || cur === undefined) await this.state.storage.setAlarm(Math.max(now, leaseUntil > now ? leaseUntil : now) + 10);
  }

  // ---- Arbetet ----
  async alarm() {
    const now = Date.now();
    if (await this._unpaidLifecycle(now)) return; // D15: obetalda ordrar har inget arbete – bara rensning
    await this._tx(async () => { const cur = await this._load(); if (cur) await this._repairWithdrawal(cur, now); });
    if (this._afterTx) { const a = this._afterTx; this._afterTx = null; await a(); }
    await this._drainOutbox(now);
    // GRIND (Modesty §5e): avtalsbekräftelsen ska ges på varaktigt medium INNAN tjänsten utförs. Inget arbete, ingen räkning, ingen generation
    // förrän orderns bekräftelse har godkänd transportkvittens. Misslyckad/utebliven bekräftelse efter begränsad väntan ⇒ ordern avbryts och återbetalas.
    const gate = await this._tx(async () => {
      const o = await this._load();
      if (!o || !["paid", "running"].includes(o.status)) return { open: true };
      if (o.work.lease && o.work.lease.until > now) return { open: true };
      // Policy P: ingen start utan båda frusna samtycken (stark kontroll mot manipulerad/ofullständig orderpost) – annars avbryts ordern och återbetalas, ingen generation.
      if (o.accept && o.accept.policy === "P") {
        const cp = await consentProblems(o, await this.state.storage.get("ledger"));
        if (cp.length) return { fail: true, reason: "samtycke_saknas" };
      }
      const m = await this.state.storage.get(`outbox:mail_avtal_${o.id}`);
      // D14: HTTP-accept (sent) öppnar INTE grinden. Negativ leverans (bounce/failed/suppressed) ⇒ ingen generation + återbetalning; delayed/saknad leverans ⇒ vänta till tidsgränsen, därefter samma väg.
      if (m && m.state === "sent" && m.transport === "http" && !deliveryOk(m)) {
        if (m.delivery && NEGATIVE_DELIVERY.includes(m.delivery.state)) return { fail: true, reason: "bekraftelse_ej_levererad" };
        const deadline = (o.paidAt || now) + LIMITS.confirmWaitMs;
        if (now >= deadline) return { fail: true, reason: "bekraftelse_ej_levererad" };
        if (o.work.waiting !== "avtalsbekraftelse") { o.work.waiting = "avtalsbekraftelse"; await this._save(o); }
        return { wait: Math.min(deadline, now + 30_000) };
      }
      if (m && m.state === "sent") {
        let dirty = false;
        if (o.work.waiting) { o.work.waiting = null; dirty = true; }
        if (o.accept && o.accept.policy === "P") {
          if (!o.accept.confirmation) { o.accept.confirmation = { mailId: m.id, sentAt: m.sentAt, ...(m.transport === "http" ? { deliveredAt: m.delivery.at } : {}), at: Date.now() }; dirty = true; } // bekräftelse skickad (HTTP: levererad till mottagarens mailserver) FÖRE start
          if (confirmationProblems(o, m).length) return { fail: true, reason: "bekraftelse_motstrider" }; // motstridig bekräftelse ⇒ ingen generation, återbetalning
        }
        if (dirty) await this._save(o);
        return { open: true };
      }
      if (!m || m.state === "failed" || now >= (o.paidAt || now) + LIMITS.confirmWaitMs) return { fail: true };
      if (o.work.waiting !== "avtalsbekraftelse") { o.work.waiting = "avtalsbekraftelse"; await this._save(o); }
      return { wait: m.nextAt && m.nextAt > now ? m.nextAt : now + 5_000 };
    });
    if (gate.fail) { await this._finish(null, { state: "failed", reason: gate.reason || "bekraftelse_ej_levererad" }); return; }
    if (gate.wait) { if (this.state.storage.setAlarm) await this.state.storage.setAlarm(gate.wait + 10); return; }
    // Atomär arbetsclaim: bara om betald, ej levererad och ingen annan har en giltig lease.
    const claim = await this._tx(async () => {
      const o = await this._load();
      if (!o || !["paid", "running"].includes(o.status)) return null;
      const lease = o.work.lease;
      if (lease && lease.until > now) return { wait: lease.until };
      if (o.work.attempts >= LIMITS.maxOrderAttempts) { return { exhausted: true }; } // inget nytt försök, ingen ny generation
      const owner = `${now}-${Math.random().toString(36).slice(2, 10)}`;
      o.work.attempts += 1;
      if (!o.work.startedAt) o.work.startedAt = Date.now(); // första generationens start (bekräftelsen måste vara skickad före denna tid)
      o.work.lease = { owner, until: now + LIMITS.leaseMs };
      o.status = "running";
      await this._save(o);
      return { owner, attempt: o.work.attempts };
    });
    if (!claim) return;
    if (claim.exhausted) { await this._finish(null, { state: "failed", reason: "for_manga_forsok" }); return; }
    if (claim.wait) { await this.state.storage.setAlarm(claim.wait + 10); return; }
    const io = {
      fetch: (u, i) => fetch(u, i),
      now: () => Date.now(),
      kv: this.env.REVIEWS_KV,
    };
    const store = this._pipelineStore(claim.owner);
    let result;
    try {
      result = await runPipeline({ env: this.env, io, store });
    } catch (e) {
      result = { state: "retry", reason: "internt" };
    }
    if (result.state === "lost") return;
    await this._finish(claim.owner, result);
  }

  // Det pipeline får göra mot ordern. Allt går genom claim-ägarens lease.
  _pipelineStore(owner) {
    const self = this;
    return {
      async order() { return self._load(); },
      async heartbeat() {
        return self._tx(async () => {
          const o = await self._load();
          if (!o || !o.work.lease || o.work.lease.owner !== owner) return false;
          o.work.lease.until = Date.now() + LIMITS.leaseMs;
          await self._save(o);
          return true;
        });
      },
      async getExt(idx) { return (await self.state.storage.get(`ext:${idx}`)) || null; },
      async putExt(idx, value, stepPatch) {
        return self._tx(async () => {
          const o = await self._load();
          if (!o || !o.work.lease || o.work.lease.owner !== owner) return false;
          await self.state.storage.put(`ext:${idx}`, value);
          o.work.steps.ext[idx] = { ...(o.work.steps.ext[idx] || {}), state: "done", ...stepPatch };
          await self._save(o);
          return true;
        });
      },
      async sources() { return (await self.state.storage.get("sources")) || null; },
      async getAux(name) { return (await self.state.storage.get(`aux:${name}`)) || null; },
      async putAux(name, value) {
        return self._tx(async () => {
          const o = await self._load();
          if (!o || !o.work.lease || o.work.lease.owner !== owner) return false;
          await self.state.storage.put(`aux:${name}`, value);
          return true;
        });
      },
      async stepAttempt(kind, idx) {
        return self._tx(async () => {
          const o = await self._load();
          if (!o || !o.work.lease || o.work.lease.owner !== owner) return null;
          const s = kind === "ext" ? (o.work.steps.ext[idx] = o.work.steps.ext[idx] || { state: "pending", attempts: 0 }) : o.work.steps.synth;
          s.attempts = (s.attempts || 0) + 1;
          if (s.state !== "done") s.state = "running";
          await self._save(o);
          return s.attempts;
        });
      },
      async markSynth(state) {
        return self._tx(async () => {
          const o = await self._load();
          if (!o || !o.work.lease || o.work.lease.owner !== owner) return false;
          o.work.steps.synth.state = state;
          await self._save(o);
          return true;
        });
      },
    };
  }

  // Avslutar ordern. owner===null = ingen lease finns (uttömda försök): tillåtet bara för betald/pågående order.
  async _finish(owner, r) {
    let refundCall = null;
    let wake = false;
    const retryAt = await this._tx(async () => {
      const o = await this._load();
      if (!o) return null;
      if (owner !== null && o.work.error === "angrat" && r.reportKey) { try { await this.env.REVIEWS_KV.delete(r.reportKey); } catch { /* TTL */ } } // resultat som blev klart efter ångrande lämnas aldrig kvar
      if (owner === null) {
        if (!["paid", "running"].includes(o.status) || (o.work.lease && o.work.lease.until > Date.now())) return null;
      } else if (!o.work.lease || o.work.lease.owner !== owner) return null; // lease förlorad: nästa ägare tar över
      o.work.lease = null;
      if (r.state === "delivered") {
        o.status = "delivered";
        o.work.deliveredAt = Date.now();
        o.reportKey = r.reportKey;
        let proof = null;
        if (o.accept && o.accept.policy === "P") {
          o.delivery = { report: { at: o.work.deliveredAt, hash: r.reportHash || null, orderId: o.id }, sources: {} }; // leveranshändelse (tid + innehållshash) för fullgörandet
          proof = { orderId: o.id, at: o.work.deliveredAt, hash: r.reportHash || null }; // andra, separat sparad kopia av leveransbeviset
        }
        o.purgeKeys = [...new Set([...(o.purgeKeys || []), ...o.docs.map((d) => d.key).filter(Boolean)])];
        o.docs = o.docs.map((d) => ({ ...d, key: null }));
        const rm = await this._reportMailPut(o, Date.now()); // rapport-klart-mejl köas atomiskt med leveransen
        await this._commit({ put: { order: o, ...(proof ? { deliveryproof: proof } : {}), ...rm } });
        wake = Object.keys(rm).length > 0;
        return null;
      }
      if (r.state === "retry" && o.work.attempts < LIMITS.maxOrderAttempts) {
        o.status = "paid";
        await this._save(o);
        return Date.now() + Math.min(60_000, 5_000 * 2 ** o.work.attempts);
      }
      // Misslyckad leverans: ingen rapport, återbetalning enligt läge.
      o.status = "failed";
      o.work.error = r.state === "retry" ? "for_manga_forsok" : (r.reason || "fel");
      o.contentDeleted = true;
      await this.state.storage.delete("sources"); await this.state.storage.delete("preid");
      o.purgeKeys = [...new Set([...(o.purgeKeys || []), ...o.docs.map((d) => d.key).filter(Boolean)])];
      o.docs = o.docs.map((d) => ({ ...d, key: null }));
      refundCall = this._planRefund(o);
      await this._save(o);
      return null;
    });
    if (retryAt) { await this.state.storage.setAlarm(retryAt); return; }
    if (wake && this.state.storage.setAlarm) await this.state.storage.setAlarm(Date.now() + 10); // utkorgen (rapport-klart-mejl) töms i nästa alarm
    await this._runRefund(refundCall);
    // Rensa rå offertdata så fort ärendet är avslutat (levererat eller misslyckat).
    try {
      const o = await this._load();
      if (o && ["delivered", "failed"].includes(o.status)) await this._purgeDocs(o);
    } catch { /* TTL 24 h är reservvägen */ }
  }

  _planRefund(o) {
    if (o.refund.state === "none") o.refund.state = o.refund.mode === "auto" && o.stripe && o.stripe.paymentIntentId ? "requested" : "needed";
    return o.refund.state === "requested" ? { paymentIntentId: o.stripe.paymentIntentId, orderId: o.id, test: !!o.test } : null;
  }
  async _runRefund(refundCall) {
    if (!refundCall) return;
    let res = null;
    const E = stripeEnvFor(this.env, refundCall.test); // testorder ⇒ testnyckel; saknas den ⇒ ingen återbetalning (okänt utfall ⇒ "needed"), aldrig livenyckel
    const { test: _t, ...rc } = refundCall;
    try { res = E ? await refundPayment(E, { ...rc, fetchImpl: (u, i) => fetch(u, i) }) : null; } catch { res = null; }
    await this._tx(async () => {
      const o = await this._load();
      if (!o) return;
      this._applyRefund(o, res);
      await this._save(o);
    });
  }

  // Bara leverantörens "succeeded" är lyckad. Övriga får egna, sanningsenliga tillstånd:
  // pending (begärd, väntar), action_required (kräver åtgärd), failed (misslyckades/avbröts) → manuell avstämning.
  _applyRefund(o, res) {
    if (!res || !res.id) { o.refund.state = "needed"; o.refund.providerStatus = null; return; } // okänt utfall: aldrig "gjord"
    const oc = refundOutcome(res.status);
    o.refund.id = res.id;
    o.refund.providerStatus = typeof res.status === "string" ? res.status : null;
    o.refund.lastChangedAt = Date.now();
    if (oc === "done") { o.refund.state = "done"; o.refund.at = Date.now(); }
    else if (oc === "pending") o.refund.state = "pending";
    else if (oc === "action_required") o.refund.state = "action_required";
    else if (oc === "failed") o.refund.state = "failed";
    else o.refund.state = "needed";
  }

  _shouldRefundCheck(o, now) {
    return ["failed"].includes(o.status) && o.refund.id && ["pending", "action_required"].includes(o.refund.state) && now - (o.lastRefundCheckAt || 0) > LIMITS.reconcileMinMs;
  }

  // Intern: webhook/avstämning meddelar återbetalningens status. Måste gälla ordern och dess kända refund-id.
  async _refundUpdate(o, b, now) {
    if (b.mark) { o.lastRefundCheckAt = now; await this._save(o); return { body: { ok: true } }; }
    if (!b.refund || typeof b.refund.id !== "string" || !o.refund.id || b.refund.id !== o.refund.id) return { status: 422, body: { ok: false, error: "refund_okand" } };
    if (o.refund.state === "done") return { body: { ok: true, dup: true } }; // lyckad är slutgiltig
    this._applyRefund(o, b.refund);
    await this._save(o);
    return { body: { ok: true, state: o.refund.state } };
  }

  // ---- Ledger, ånger, mejl ----
  async _extras() {
    const ledger = await this.state.storage.get("ledger");
    if (!ledger) return { agreement: null, withdrawal: null };
    if (ledger.stripped) return { agreement: { archived: true, id: ledger.agreementId }, withdrawal: ledger.withdrawal ? { requested: true, requestId: ledger.withdrawal.requestId, at: ledger.withdrawal.at, outcome: ledger.withdrawal.outcome } : { requested: false } };
    const mails = [];
    for (const [k, v] of await this.state.storage.list({ prefix: "outbox:" })) mails.push({ kind: v.kind, state: v.state, attempts: v.attempts, sentAt: v.sentAt });
    const w = ledger.withdrawal;
    const o = await this._load();
    let rights = null;
    if (o && o.accept && o.accept.policy === "P") {
      const f = await this._fulfilment(o, Date.now());
      rights = { policy: "P", angerratt: f.fulfilled ? "upphord" : "kvar", upphordAt: f.fulfilled ? f.fulfilledAt : null, state: f.state, point: f.point };
    }
    return {
      rights,
      agreement: { id: ledger.agreementId, hash: ledger.agreementHash, paidAt: ledger.agreement.payment.paidAt, contact: maskEmail(ledger.agreement.contact.email), draft: !!ledger.agreement.draft, mails },
      withdrawal: w ? { requested: true, requestId: w.requestId, at: w.at, outcome: w.outcome, via: w.via } : { requested: false },
    };
  }

  // ---- Retention: VERKLIG rensning för policyvalda klasser (avtal/bokforing). Utan fullständig fastställd policy görs ingenting (fail closed). ----
  // Utlöses lazy vid åtkomst och av adminens POST /compare/admin/retention-sweep. Ingen schemaläggare/ny lagringsresurs är beslutad (se COMPARE.md).
  // Hålls kvar så länge ärendet är öppet: ej avslutad order, ej slutförd återbetalning, eller ångerbegäran som väntar manuell prövning.
  async _retentionSweep(o, now) {
    const pol = retentionPolicy(this.env);
    if (!pol.ok) return { ran: false, reason: "policy_saknas" };
    const ledger = await this.state.storage.get("ledger");
    if (!ledger) return { ran: false, reason: "ingen_post" };
    const paidAt = ledger.agreement && ledger.agreement.payment && ledger.agreement.payment.paidAt;
    if (!Number.isFinite(paidAt)) return { ran: false, reason: "ogiltig_post" };
    const DAY = 86400_000;
    const purgeDue = now >= paidAt + pol.bokforingDays * DAY, stripDue = !ledger.stripped && now >= paidAt + pol.avtalDays * DAY;
    if (!purgeDue && !stripDue) return { ran: true, action: "inget_forfallet" };
    if (!["delivered", "failed", "deleted", "expired"].includes(o.status)) return { ran: true, action: "hallen", reason: "arendet_oppet" };
    if (!["none", "done"].includes(o.refund.state)) return { ran: true, action: "hallen", reason: "aterbetalning_oppen" };
    if (ledger.withdrawal && ledger.withdrawal.outcome === "manuell_provning" && !(ledger.review && ledger.review.closedAt)) return { ran: true, action: "hallen", reason: "manuell_provning_oppen" };
    if (purgeDue) {
      try { await this._purgeDocs(o); } catch { /* 24 h TTL är reservvägen */ }
      const keys = [...(await this.state.storage.list()).keys()];
      const prev = await this.state.storage.get("cleanup");
      const refs = [...new Set([...keys.filter((k) => k.startsWith("mailref:")).map((k) => k.slice(8)), ...((prev && prev.mailrefs) || [])])];
      const failed = await this._unindexRefs(refs); // global provider-ID-post (bara ID:n); misslyckat ⇒ beständigt städunderlag som överlever purge
      // ORDNING: städunderlaget skrivs BESTÄNDIGT FÖRE all destruktiv radering, och det befintliga underlaget raderas aldrig förrän ett säkert ersättande finns (eller inget behövs).
      // Skrivningen kastar ⇒ ingenting är raderat (order, ledger och gammalt underlag kvar) och nästa svep försöker om. Själva raderingen är EN atomär transaktion som aldrig rör "cleanup" när städning återstår.
      // Underlaget skrivs ALLTID (även utan misslyckade mr-ID:n: det bär då bara det kvarvarande ledgerindexet) och tas bort först när allt är städat.
      try { await this.state.storage.put("cleanup", { orderId: o.id, paidAt, mailrefs: failed }); } catch { return { ran: true, action: "hallen", reason: "stadunderlag_ej_sparat" }; } // inget raderat; nästa svep försöker om
      try { await this._commit({ del: keys.filter((k) => k !== "cleanup") }); } catch { return { ran: true, action: "hallen", reason: "radering_avbruten" }; } // transaktionen rullas tillbaka; underlaget finns kvar
      const cl = await this._retryCleanup(now); // tar bort kvarvarande mr-ID:n + ledgerindex och först därefter underlaget; fel ⇒ underlaget kvar för nästa svep
      return { ran: true, action: "raderad", purged: true, ...(cl.action === "stadning_klar" ? {} : { cleanupPending: Math.max(cl.pending || 0, 1) }) };
    }
    // Avtalsklassen utgången men bokföringsklassen kvar: ta bort personuppgifts-/avtalsdelen, behåll belopp/moms/datum/Stripe-referenser.
    o.accept = o.accept ? { ...o.accept, contactEmail: null, snapshot: null } : o.accept;
    const outboxKeys = [...(await this.state.storage.list({ prefix: "outbox:" })).keys()];
    const refKeys = [...(await this.state.storage.list({ prefix: "mailref:" })).keys()];
    const prevCl = await this.state.storage.get("cleanup");
    const failed = await this._unindexRefs([...new Set([...refKeys.map((k) => k.slice(8)), ...((prevCl && prevCl.mailrefs) || [])])]); // global mr-post tas bort FÖRE lokala spår; misslyckade ID:n sparas som beständigt städunderlag
    const put = { ledger: stripLedger(ledger, now), order: o };
    const del = [...outboxKeys, ...refKeys, "sources"];
    if (failed.length) put.cleanup = { orderId: o.id, paidAt, mailrefs: failed }; else if (prevCl) del.push("cleanup");
    await this._commit({ put, del });
    return { ran: true, action: "avtalsdel_rensad", stripped: true };
  }

  // Manuell slutmarkör: en människa har avslutat den manuella ångerprövningen (utanför koden). Sätter bara ledger.review.closedAt; koden bedömer
  // inget juridiskt och väljer ingen retention. Släpper enbart spärren "manuell_provning_oppen" i svepet; återbetalning/öppet ärende hålls kvar.
  async _closeReview(o, b, now) {
    const ledger = await this.state.storage.get("ledger");
    if (!ledger) return { ok: false, error: "ingen_post" };
    if (!ledger.withdrawal || ledger.withdrawal.outcome !== "manuell_provning") return { ok: false, error: "ingen_manuell_provning" };
    if (ledger.review && ledger.review.closedAt) return { ok: true, already: true, closedAt: ledger.review.closedAt };
    const note = String((b && b.note) || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 200);
    await this._commit({ put: { ledger: { ...ledger, review: { closedAt: now, by: "admin", note: note || null } } } });
    return { ok: true, closedAt: now };
  }

  async _indexLedger(orderId, now) {
    try {
      const { ledgerIndex } = await import("./compare_budget.js");
      await ledgerIndex(this.env, { orderId, now });
    } catch { /* indexet kan återskapas; betalningen påverkas inte */ }
  }

  // Ångerbegäran. Idempotent: första begäran och dess tidpunkt ligger fast. Ingen automatisk juridisk avvisning:
  // efter leverans eller i race med resultatet sparas begäran för manuell prövning (UTKAST).
  async _withdraw(o, b, now) {
    const NF = { status: 404, body: { ok: false, error: "hittas_inte" } };
    const ledger = await this.state.storage.get("ledger");
    if (!ledger) return NF;
    if (ledger.stripped) return { status: 410, body: { ok: false, error: "arkiverad" } }; // avtalsdelen är rensad enligt fastställd retention
    const authed = b.via === "order" ? this._auth(o, b.tokenHash) : b.via === "token" ? (typeof b.secret === "string" && (await withdrawSecretMatches(ledger, b.secret))) : false;
    if (!authed) return NF;
    const view = () => ({ requested: true, requestId: ledger.withdrawal.requestId, at: ledger.withdrawal.at, outcome: ledger.withdrawal.outcome });
    if (ledger.withdrawal) {
      // Upprepad begäran: samma kvitto; mejlet köas bara om det saknas (ingen dubbel återbetalning, ingen ny tidpunkt).
      await this._queueReceipt(ledger, now);
      return { body: { ok: true, duplicate: true, withdrawal: view(), order: publicView(o, now) } };
    }
    const wd = { requestId: `begaran_${o.id.slice(2, 18)}`, at: now, via: b.via, stateAtRequest: o.status, outcome: null };
    let refundCall = null, purge = false;
    const del = [];
    if (o.status === "paid" || o.status === "running") {
      // Atomiskt: avbryt arbetsclaimen. En pågående körning förlorar sin lease och gör inga fler steg.
      refundCall = this._cancelWork(o); del.push("sources");
      wd.outcome = "avbrutet_fore_leverans"; purge = true;
    } else if (o.status === "failed") wd.outcome = "redan_avslutad";
    else if (o.accept && o.accept.policy === "P") {
      // Policy P (frusen per order): ångerrätten upphör först vid VERIFIERAT fullgörande enligt serverbevis. Allt annat (saknat/partiellt/motstridigt bevis, fönstret ej slut) ⇒ rätten kvar ⇒ stopp + full återbetalning.
      // Ingen nekan för att rapporten visats; ingen proportionell avgift. Efter giltigt fullgörande sparas begäran med utfall angerratt_upphord (ingen ångerrefund; reklamation oförändrad).
      const f = await this._fulfilment(o, now);
      wd.fulfilment = { state: f.state, missing: f.missing, fulfilledAt: f.fulfilledAt || null, point: f.point };
      if (f.fulfilled) wd.outcome = "angerratt_upphord";
      else {
        refundCall = this._cancelWork(o); del.push("sources");
        if (o.reportKey) { this._reportToDelete = o.reportKey; o.reportKey = null; }
        wd.outcome = "angrat_fore_fullgoring"; purge = true;
      }
    } else wd.outcome = "manuell_provning"; // Q: levererad/raderad/utgången: ingen automatisk bedömning
    ledger.withdrawal = wd;
    addEvent(ledger, "angerbegaran", now, { via: b.via, outcome: wd.outcome, stateAtRequest: wd.stateAtRequest });
    const rm = receiptMail(ledger, ledger.withdrawal);
    const put = { ledger, order: o };
    if (!(await this.state.storage.get(`outbox:${rm.id}`))) put[`outbox:${rm.id}`] = await outboxEntry(rm, { to: ledger.agreement.contact.email, now });
    await this._commit({ put, del }); // ånger + orderstatus + kvittomejl i ETT atomiskt skrivsteg
    return {
      body: { ok: true, duplicate: false, withdrawal: view(), order: publicView(o, now) },
      after: async () => { await this._runRefund(refundCall); if (purge) await this._purgeDocs(await this._load()); if (this._reportToDelete) { const k = this._reportToDelete; this._reportToDelete = null; try { await this.env.REVIEWS_KV.delete(k); } catch { /* TTL 24 h */ } } await this._ensureAlarm(o, now, true); },
    };
  }

  // Fullgörande enligt policy P (servern bedömer, aldrig UI). Fullgjord = alla fyra: (1) båda samtycken frusna med tid/text-hash, (2) avtalsbekräftelsen "sent" FÖRE start, (3) leveranshändelse för rapporten
  // (tid + innehållshash) och (4) för varje i köpet täckt källfirma en registrerad visning/"ingen källa"; vid fonster_slut dessutom att 24 h-fönstret för att spara rapporten gått ut.
  // Saknas något ⇒ ej fullgjord ⇒ ångerrätt kvar (fail closed). Q-ordrar utvärderas aldrig här.
  async _fulfilment(o, now) {
    const a = o.accept || {};
    if (a.policy !== "P") return { fulfilled: false, state: "q", missing: [], point: null };
    const missing = [];
    const ledger = await this.state.storage.get("ledger");
    if ((await consentProblems(o, ledger)).length) missing.push("samtycke");
    const m = await this.state.storage.get(`outbox:mail_avtal_${o.id}`);
    if (confirmationProblems(o, m).length) missing.push("bekraftelse");
    const d = o.delivery;
    const rep = d && d.report;
    if (!(await this._reportEvidenceOk(o, rep))) missing.push("rapport");
    const sg = a.agreed && a.agreed.sources;
    const ids = sg && sg.required && Array.isArray(sg.coveredIds) ? sg.coveredIds : [];
    for (const id of ids) if (!this._sourceEvidenceOk(sg, id, d, rep)) missing.push(`kalla:${id}`);
    if (sg && sg.required && !ids.length) missing.push("kalla:tom");
    const point = a.fulfilmentPoint === "fonster_slut" ? "fonster_slut" : a.fulfilmentPoint === "leverans" ? "leverans" : null;
    if (!point) missing.push("fullgorandepunkt");
    if (missing.length) return { fulfilled: false, state: "ej_fullgjord", missing, point };
    const last = Math.max(rep.at, ...ids.map((id) => d.sources[id].at));
    const fulfilledAt = point === "fonster_slut" ? Math.max(last, rep.at + OFFER.retentionHours * 3600_000) : last;
    if (now < fulfilledAt) return { fulfilled: false, state: "vantar_fonster", missing: [], point, fulfilledAt };
    return { fulfilled: true, state: "fullgjord", missing: [], point, fulfilledAt };
  }

  // Rapportens leveransbevis: orderbindning, tid = faktisk leveranstid, 64-hex innehållshash, samma värden i den separat sparade kopian, och (så länge rapporten finns kvar) hash av den FAKTISKT lagrade rapporten.
  async _reportEvidenceOk(o, rep) {
    if (!rep || rep.orderId !== o.id || !HEX64.test(String(rep.hash || "")) || !Number.isFinite(rep.at) || o.status !== "delivered" || rep.at !== (o.work && o.work.deliveredAt)) return false;
    const pr = await this.state.storage.get("deliveryproof");
    if (!pr || pr.orderId !== o.id || pr.hash !== rep.hash || pr.at !== rep.at) return false;
    if (o.reportKey) {
      let txt = null;
      try { txt = await this.env.REVIEWS_KV.get(o.reportKey); } catch { txt = null; }
      if (typeof txt === "string" && (await sha256Hex(txt)) !== rep.hash) return false; // lagrad rapport matchar inte leveransbeviset
    }
    return true;
  }

  // Källbevis per täckt firma: varje frusen (avtalad) källa ska ha verifierad visning efter rapportleverans. "ingen_kalla" räknas aldrig för en täckt firma.
  _sourceEvidenceOk(sg, id, d, rep) {
    const want = sg && sg.providers && Array.isArray(sg.providers[id]) ? sg.providers[id] : null;
    const e = d && d.sources && d.sources[id];
    if (!want || !want.length || !e || e.state !== "visad" || !Number.isFinite(e.at) || !rep || e.at < rep.at) return false;
    return want.every((pv) => e.providers && e.providers[pv] === "ok");
  }

  // Källkvittens (policy P). Klientens påstådda läge är aldrig bevis: servern prövar sin EGEN källstatus för firman mot den frusna täckningen.
  // Google: bekräftad profil + visningen i webbläsaren rapporterad "ok" (REPORTED, kvitteras bara vid lyckad visning). Trustpilot: bekräftad firma + serverns egen hämtning "ok".
  // Källfel/tomt/kostnadsstopp/ej bekräftad/delvis ⇒ ingen kvittens ⇒ rätten kvar. "ingen_kalla" för en täckt firma avvisas.
  async _sourceDelivered(o, b, now) {
    const a = o.accept || {};
    const sg = a.agreed && a.agreed.sources;
    if (a.policy !== "P" || o.status !== "delivered" || !o.delivery || !o.delivery.report) return { status: 409, body: { ok: false, error: "status" } };
    const ids = sg && sg.required && Array.isArray(sg.coveredIds) ? sg.coveredIds : [];
    const want = sg && sg.providers && Array.isArray(sg.providers[b.firmId]) ? sg.providers[b.firmId] : [];
    if (!ids.includes(b.firmId) || b.state !== "visad" || !want.length) return { status: 409, body: { ok: false, error: "ogiltig" } };
    const st = (await this.state.storage.get("sources")) || emptySources();
    const f = (st.firms || []).find((x) => x.id === b.firmId);
    if (!f) return { status: 409, body: { ok: false, error: "kalla_ej_verifierad" } };
    const res = {};
    for (const pv of want) {
      if (pv === "google") res.google = f.google && f.google.placeId && f.google.renderOutcome === "ok" ? "ok" : "ej_ok";
      else if (pv === "trustpilot") res.trustpilot = f.trustpilot && f.trustpilot.buId && f.trustpilot.lastOutcome === "ok" ? "ok" : "ej_ok";
      else res[pv] = "ej_ok";
    }
    if (!want.every((pv) => res[pv] === "ok")) return { status: 409, body: { ok: false, error: "kalla_ej_verifierad" } };
    o.delivery.sources = o.delivery.sources || {};
    if (!o.delivery.sources[b.firmId]) { o.delivery.sources[b.firmId] = { state: "visad", at: Math.max(now, o.delivery.report.at), providers: res }; await this._save(o); }
    return { body: { ok: true } };
  }

  async _queueReceipt(ledger, now) {
    const m = receiptMail(ledger, ledger.withdrawal);
    if (await this.state.storage.get(`outbox:${m.id}`)) return;
    await this.state.storage.put(`outbox:${m.id}`, await outboxEntry(m, { to: ledger.agreement.contact.email, now }));
  }

  // Lokal utkorg. Extern sändning är AV: utan konfigurerad transport ligger meddelandena kvar som "queued" (inget påstås skickat).
  // "sent" sätts bara efter transportens verifierade kvittens (för HTTP: 2xx + giltigt leverantörs-ID) och betyder ENDAST "accepterat av transporten", inte "levererat till inkorgen".
  // Samma meddelande-ID vid omförsök; för HTTP-transporten dessutom EN stabil Idempotency-Key per meddelande och en FRYST begäran (avsändare + hash) från första försöket:
  // timeout/förlorad kvittens/omstart ger omsändning med SAMMA nyckel och SAMMA nyttolast inom leverantörens 24 h-fönster (här 23 h), aldrig ny nyckel. Efter fönstret med oklart
  // utfall ⇒ state "avstamning" (manuell grind, ingen blind omsändning). 409 med annan nyttolast stoppar meddelandet ("failed"); 409 pågående hanteras med begränsade omförsök.
  // Stopp utan leverans. Har ett tidigare försök OKÄNT utfall (timeout/förlorad kvittens/5xx/409 pågår) kan leverantören redan ha accepterat det: ett senare avslag/konfig-/nyttolastfel
  // bevisar inte att det tidigare mejlet inte skickades ⇒ "avstamning"/utfall_okant (avslagskoden sparas som senare observation). Första säkra stopp utan tidigare osäkerhet ⇒ "failed".
  _stopMail(m, code) {
    if (m.unknownOutcome) { m.state = "avstamning"; m.lastError = "utfall_okant"; m.laterStop = code; } else { m.state = "failed"; m.lastError = code; }
  }

  // Bilagor med {gen} byggs HÄR (vid sändning), deterministiskt: "agreement" ur den frusna ledgern (personlig ångerlänk bara om den finns som hemlighet i mejlet), "report" ur den lagrade rapporten.
  // Saknas underlaget (raderad rapport/avtalstext) ⇒ null ⇒ mejlet stoppas utan sändning. Samma indata ger samma byte, så den frysta begäran/hashen är stabil vid omförsök.
  async _resolveAttachments(m) {
    const out = [];
    for (const a of m.attachments || []) {
      if (!a.gen) { out.push(a); continue; }
      try {
        let bytes = null;
        if (a.gen === "agreement") {
          const ledger = await this.state.storage.get("ledger");
          if (!ledger || ledger.stripped || !ledger.agreement || !ledger.agreement.accepted) return null;
          bytes = agreementPdf(ledger, { angerLink: m.secrets && m.secrets.ANGERLANK, kopLink: m.secrets && m.secrets.KOPLANK });
        } else if (a.gen === "report") {
          const o = await this._load();
          if (!o || !o.reportKey) return null;
          const txt = await this.env.REVIEWS_KV.get(o.reportKey);
          if (typeof txt !== "string") return null;
          bytes = reportPdf(JSON.parse(txt));
        } else return null;
        out.push({ filename: a.filename, contentType: a.contentType, content: b64Bytes(bytes) });
      } catch { return null; }
    }
    return out;
  }

  async _drainOutbox(now) {
    const kind = mailerKind(this.env);
    if (kind === null) return;
    const http = kind === "http" ? mailHttpConfig(this.env) : null;
    const mailer = kind === "adapter" ? this.env.COMPARE_MAILER : { send: async (msg) => ({ ok: true, ref: "mock:" + String(msg.id).slice(-12) }) }; // mock = uttryckligt testläge, ingen verklig sändning
    const entries = [...(await this.state.storage.list({ prefix: "outbox:" }))];
    let retryAt = null;
    for (const [key] of entries) {
      const claim = await this._tx(async () => {
        const m = await this.state.storage.get(key);
        if (!m || ["sent", "failed", "avstamning"].includes(m.state)) return null;
        if (m.attempts >= (m.kind === "avtalsbekraftelse" ? 12 : 5)) {
          // Slut på försök: har något försök haft OKÄNT utfall (timeout/förlorad kvittens/ogiltigt svar/5xx/409 pågår) kan leverantören ha accepterat ⇒ "avstamning" (manuell grind), inte "failed".
          if (m.unknownOutcome) { m.state = "avstamning"; m.lastError = "utfall_okant"; } else { m.state = "failed"; m.lastError = m.lastError || "for_manga_forsok"; }
          await this.state.storage.put(key, m); return null;
        }
        if (m.leaseUntil && m.leaseUntil > now) return { wait: m.leaseUntil };
        if (m.nextAt && m.nextAt > now) return { wait: m.nextAt };
        let req = null;
        if (kind === "http") {
          if (!validMailTo(m.to)) { this._stopMail(m, "mejl_ogiltig_mottagare"); m.leaseUntil = null; await this.state.storage.put(key, m); return null; }
          if (m.idem && now > m.idem.firstAt + IDEM_WINDOW_MS) {
            m.state = "avstamning"; m.lastError = "idem_fonster_utgatt"; m.leaseUntil = null; await this.state.storage.put(key, m); return null; // ingen ny nyckel, ingen blind omsändning
          }
          // Spårat dygnstak (COMPARE_MAIL_DAY_CAP): EN atomisk reservation per meddelande OCH faktiskt UTC-dygn, före varje sändningsförsök som är första för dygnet (även omförsök efter midnatt).
          // En reservation från ett tidigare dygn ger ingen fri sändning nästa dygn. Ingen räkning möjlig/nekad ⇒ ingen HTTP.
          const day = dayKey(new Date(now));
          if (m.capDay !== day) {
            const c = await countToday(this.env, { name: "mail_send", limit: http.dayCap, now: new Date(now) });
            if (!c.ok) { m.lastError = "mejl_dygnstak"; m.nextAt = now + 600_000; await this.state.storage.put(key, m); return { wait: m.nextAt }; }
            m.capDay = day;
          }
          if (!m.idem) m.idem = { key: mailIdemKey(m.id), firstAt: now };
          let text = m.body;
          for (const [k, v] of Object.entries(m.secrets || {})) text = text.split(`{{${k}}}`).join(v);
          const atts = await this._resolveAttachments(m);
          if (!atts) { this._stopMail(m, "bilaga_kunde_inte_byggas"); m.leaseUntil = null; await this.state.storage.put(key, m); return null; }
          req = buildMailRequest({ from: m.frozen ? m.frozen.from : http.from, to: m.to, subject: m.subject, text, attachments: atts, mailId: m.id });
          const h = await requestHash(req);
          if (!m.frozen) m.frozen = { from: req.from, hash: h, at: now };
          else if (m.frozen.hash !== h) { this._stopMail(m, "mejl_nyttolast_andrad"); m.leaseUntil = null; await this.state.storage.put(key, m); return null; } // fryst nyttolast får aldrig ändras under samma nyckel
        }
        m.attempts += 1; m.lastAttemptAt = now; m.leaseUntil = now + LEASE_MS; await this.state.storage.put(key, m);
        return { m: { ...m }, req };
      });
      if (!claim) continue;
      if (claim.wait) { retryAt = Math.min(retryAt ?? claim.wait, claim.wait); continue; }
      let ack = null, res = null;
      try {
        if (kind === "http") {
          res = await sendViaHttp(this.env, { req: claim.req, idemKey: claim.m.idem.key });
          ack = res.ok ? { ok: true, ref: res.ref } : null;
        } else {
          let text = claim.m.body;
          for (const [k, v] of Object.entries(claim.m.secrets || {})) text = text.split(`{{${k}}}`).join(v);
          ack = await mailer.send({ id: claim.m.id, to: claim.m.to, subject: claim.m.subject, body: text, attachments: (await this._resolveAttachments(claim.m)) || [] });
        }
      } catch { ack = null; }
      await this._tx(async () => {
        const m = await this.state.storage.get(key);
        if (!m || m.state === "sent") return;
        m.leaseUntil = null;
        if (ack && ack.ok === true) {
          m.state = "sent"; m.transport = kind; m.sentAt = Date.now(); m.providerRef = typeof ack.ref === "string" ? ack.ref.slice(0, 80) : null; m.secrets = null; m.lastError = null;
          if (kind === "http") {
            if (m.providerRef) await this.state.storage.put(`mailref:${m.providerRef}`, { mailId: m.id, at: m.sentAt }); // beständig provider-ID → mejl (order = denna DO)
            this._replayEarly(m, Date.now()); // händelser som kom FÖRE kvittensen binds nu till det kvitterade provider-ID:t (annars anomali)
          }
        }
        else if (res && (res.kind === "payload_conflict" || res.kind === "terminal" || res.kind === "config")) { this._stopMail(m, res.code); }
        else {
          m.lastError = res && res.code ? res.code : "transport";
          if (kind === "http") m.unknownOutcome = true; // ej verifierat avslag: leverantören kan ha accepterat
          const base = res && res.kind === "inprogress" ? 30_000 : 2_000 * 2 ** m.attempts;
          m.nextAt = Date.now() + Math.min(m.kind === "avtalsbekraftelse" ? 300_000 : 60_000, base); retryAt = Math.min(retryAt ?? m.nextAt, m.nextAt);
        }
        await this.state.storage.put(key, m);
      });
    }
    await this._indexMailRefs(); // global provider-ID → order/mejl (för händelser utan tagg); best effort, lokala mailref: är sanningen
    if (retryAt && this.state.storage.setAlarm) await this.state.storage.setAlarm(Math.max(retryAt, Date.now() + 10));
  }

  async _indexMailRefs() {
    if (mailerKind(this.env) !== "http") return;
    try {
      const { mailrefPut } = await import("./compare_budget.js");
      for (const [key, m] of await this.state.storage.list({ prefix: "outbox:" })) {
        if (!m || m.state !== "sent" || m.transport !== "http" || !m.providerRef || m.refIndexed) continue;
        const o = await this._load();
        const pm = parseMailId(m.id);
        if (!o || !pm) continue;
        const r = await mailrefPut(this.env, { emailId: m.providerRef, orderId: o.id, mailId: m.id });
        if (r && r.ok) await this._tx(async () => { const cur = await this.state.storage.get(key); if (cur) { cur.refIndexed = true; await this.state.storage.put(key, cur); } });
      }
    } catch { /* indexet kan återskapas vid nästa pass */ }
  }

  // Tar bort globala provider-ID-poster; returnerar de ID:n som INTE gick (kastar aldrig).
  async _unindexRefs(ids) {
    if (!ids.length) return [];
    let fn;
    try { ({ mailrefUnindex: fn } = await import("./compare_budget.js")); } catch { return [...ids]; }
    const failed = [];
    for (const r of ids) { try { const j = await fn(this.env, { emailId: r }); if (!j || j.ok !== true) failed.push(r); } catch { failed.push(r); } }
    return failed;
  }
  async _retryCleanup(now) {
    const c = await this.state.storage.get("cleanup");
    if (!c) return { action: "inget_stadunderlag", pending: 0 };
    const failed = await this._unindexRefs(c.mailrefs || []);
    if (failed.length) { try { await this.state.storage.put("cleanup", { ...c, mailrefs: failed }); } catch { /* gamla underlaget ligger kvar oförändrat */ } return { action: "stadning_kvar", pending: failed.length }; }
    const hasOrder = !!(await this.state.storage.get("order"));
    if (!hasOrder) { try { const { ledgerUnindex } = await import("./compare_budget.js"); await ledgerUnindex(this.env, { orderId: c.orderId, at: c.paidAt }); } catch { return { action: "stadning_kvar", pending: 0, ledgerIndex: true }; } }
    try { await this.state.storage.delete("cleanup"); } catch { return { action: "stadning_kvar", pending: 0 }; } // allt städat men underlaget kunde inte tas bort ⇒ idempotent omförsök
    return { action: "stadning_klar", pending: 0 };
  }

  // ---- D14: leveranshändelser från Resend (redan SIGNATURVERIFIERADE och sanerade i Workern) ----
  _anom(m, code, now) { m.anoms = [...(Array.isArray(m.anoms) ? m.anoms : []), { code, at: now }].slice(-6); }
  _replayEarly(m, now) {
    const E = m.early && typeof m.early === "object" && m.early.ids ? m.early : null;
    m.early = null;
    if (!E) return;
    if (E.overflow) m.earlyUnbound = true; // okänd bindning ⇒ FAIL CLOSED: aldrig leveransbevis för detta mejl
    for (const [id, sn] of Object.entries(E.ids)) {
      if (id !== m.providerRef) { this._anom(m, "fel_provider_id_tidig", now); continue; }
      for (const cls of Object.keys(sn.seen || {})) applyMailEvent(m, { cls, emailId: id, providerAt: sn.providerAt ?? null, bounceType: sn.bounceType ?? null }, now);
    }
    if (E.overflow) this._anom(m, "tidig_overflow", now);
  }
  // Utfall: ok/dup/ignored. Ingen händelse räknas som bevis om order, mejl-ID, mottagare eller provider-ID inte stämmer med det vi själva fryst och skickat.
  async _mailEvent(o, b, now) {
    const e = b.event, pm = parseMailId(b.mailId);
    if (!e || !pm || pm.orderId !== o.id || typeof b.eventId !== "string") return { status: 422, body: { ok: false, error: "koppling" } };
    const key = `outbox:${pm.mailId}`;
    const m = await this.state.storage.get(key);
    if (!m) return { status: 404, body: { ok: false, error: "okand_post" } };
    if (Array.isArray(m.eventIds) && m.eventIds.includes(b.eventId)) return { body: { ok: true, dup: true } };
    m.eventIds = [...(Array.isArray(m.eventIds) ? m.eventIds : []), b.eventId].slice(-40);
    const stop = async (code) => { this._anom(m, code, now); await this.state.storage.put(key, m); return { body: { ok: true, ignored: code } }; };
    if (!(m.attempts > 0)) return stop("inte_skickad");
    if (e.to.length !== 1 || e.to[0] !== String(m.to).toLowerCase()) return stop("fel_mottagare");
    if (m.state === "sent" && m.transport !== "http") return stop("inte_http");
    if (m.providerRef) {
      if (e.emailId !== m.providerRef) return stop("fel_provider_id");
      applyMailEvent(m, e, now);
    } else {
      // Före kvittens: MONOTONT bevis per provider-ID och klass (mängd, aldrig en rullande lista) ⇒ en negativ klass kan inte trängas ut av senare händelser. Fler än 8 olika ID:n ⇒ overflow ⇒ fail closed vid ack.
      const E = m.early && typeof m.early === "object" && m.early.ids ? m.early : { ids: {}, overflow: false };
      if (!E.ids[e.emailId] && Object.keys(E.ids).length >= 8) E.overflow = true;
      else {
        const sn = E.ids[e.emailId] || (E.ids[e.emailId] = { seen: {} });
        if (!Number.isFinite(sn.seen[e.cls])) sn.seen[e.cls] = now;
        if (e.cls === "delivered" && sn.providerAt === undefined) sn.providerAt = e.providerAt;
        if (e.bounceType && !sn.bounceType) sn.bounceType = e.bounceType;
      }
      m.early = E;
    }
    await this.state.storage.put(key, m);
    const after = m.kind === "avtalsbekraftelse" && ["paid", "running"].includes(o.status) ? async () => { await this._ensureAlarm(o, now, true); } : undefined;
    return { body: { ok: true, state: m.delivery ? m.delivery.state : "tidig" }, after };
  }

  async _purgeDocs(o) {
    const keys = new Set([...(o.purgeKeys || []), ...o.docs.map((d) => d.key).filter(Boolean)]);
    const failed = [];
    for (const k of keys) {
      try { await this.env.REVIEWS_KV.delete(k); } catch { failed.push(k); }
    }
    const ids = (o.work && o.work.steps && Object.keys(o.work.steps.ext)) || [];
    for (const i of ids) await this.state.storage.delete(`ext:${i}`);
    await this.state.storage.delete("aux:priority"); await this.state.storage.delete("preid");
    // Kvarvarande nycklar behålls för ny rensning; TTL 24 h är reservvägen.
    await this._tx(async () => { const cur = await this._load(); if (cur) { cur.purgeKeys = failed; await this._save(cur); } });
  }
}

export { publicView };
