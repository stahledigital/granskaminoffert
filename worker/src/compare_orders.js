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

import { OFFER, LIMITS, refundMode, budgetConfig, consentSnapshot, retentionPolicy } from "./compare_config.js";
import { timingSafeEqual, sha256Hex } from "./compare_util.js";
import { stripLedger, validEmail, maskEmail, newWithdrawToken, withdrawSecretMatches, buildAgreement, newLedger, addEvent, confirmationMail, receiptMail, outboxEntry, exportRow } from "./compare_ledger.js";
import { evaluatePaidSession, refundOutcome, refundPayment, retrieveRefund } from "./compare_stripe.js";
import { runPipeline } from "./compare_run.js";
import { sourcesConfig, applyOp, emptySources, sourcesView, LIM as SRC_LIM } from "./compare_sources.js";

const MAX_EVENTS = 64;

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
    refund: { mode: o.refund.mode, state: o.refund.state, providerStatus: o.refund.providerStatus || null },
    consent: o.accept && o.accept.terms ? { accepted: true, version: o.accept.consentVersion || null, hash: o.accept.consentHash || null, draft: !!o.accept.draft } : { accepted: false },
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
        docCount, labels, docs: [], accept: accept || null, estimate: null, stripe: null, paidAt: null,
        work: { attempts: 0, lease: null, steps: { ext: {}, synth: { state: "pending", attempts: 0 } }, deliveredAt: null, error: null },
        refund: { mode: refundMode(this.env), state: "none", id: null, at: null },
        events: [], contentDeleted: false, reportKey: null, lastReconcileAt: 0, lastRefundCheckAt: 0, checkout: { attempt: 0, intent: null }, purgeKeys: [],
      };
      await this._save(o);
      return { body: { ok: true, order: publicView(o, now) } };
    }
    const o = await this._load();
    if (!o) return NOT_FOUND;
    await this._repairWithdrawal(o, now);
    if (path === "/retention-sweep") return { body: { ok: true, ...(await this._retentionSweep(o, now)) } };
    if (o.paidAt) { const sw = await this._retentionSweep(o, now); if (sw.purged) return NOT_FOUND; } // lazy: verklig rensning när posten åtkoms efter förfallotid
    // Obetalda utkast går ut efter retentionstiden.
    if (["draft", "ready", "awaiting_payment"].includes(o.status) && now > o.expiresAt) { o.status = "expired"; await this._save(o); }

    // ---- Interna (Worker→DO) ----
    if (path === "/paid") return this._paid(o, b, now);
    if (path === "/checkout-expired") {
      if (b.eventId && o.events.includes(b.eventId)) return { body: { ok: true, dup: true } };
      if (b.eventId) { o.events.push(b.eventId); o.events = o.events.slice(-MAX_EVENTS); }
      if (o.status === "awaiting_payment" && o.stripe && o.stripe.sessionId === b.sessionId) { o.status = "ready"; o.stripe = null; o.checkout.intent = null; }
      await this._save(o);
      return { body: { ok: true } };
    }
    if (path === "/internal") return { body: { ok: true, order: o } };
    if (path === "/refund-update") return this._refundUpdate(o, b, now);
    if (path === "/withdraw") return this._withdraw(o, b, now);
    if (path === "/ledger-export") { const l = await this.state.storage.get("ledger"); return l ? { body: { ok: true, row: exportRow(o, l, b.mode) } } : NOT_FOUND; }

    // ---- Publika (kräver åtkomstnyckel) ----
    if (!this._auth(o, b.tokenHash)) return NOT_FOUND;

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

    if (path === "/get") {
      const after = (o.status === "paid" || o.status === "running") ? async () => this._ensureAlarm(o, now) : undefined;
      const extras = await this._extras();
      return { body: { ok: true, order: { ...publicView(o, now), ...extras }, reconcile: this._shouldReconcile(o, now), refundCheck: this._shouldRefundCheck(o, now) ? { refundId: o.refund.id } : null }, after };
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
      if (!a || a.terms !== true || a.immediateDelivery !== true || typeof a.consentHash !== "string" || a.consentHash.length !== 64 || typeof a.consentVersion !== "string") return { status: 400, body: { ok: false, error: "ogiltig" } };
      if (!validEmail(a.contactEmail)) return { status: 400, body: { ok: false, error: "epost" } };
      // De FAKTISKT visade texterna fryses här: hashen måste stämma mot texten som sparas (inte bara en hash som senare saknar text).
      const snapshot = consentSnapshot(this.env);
      if ((await sha256Hex(JSON.stringify(snapshot))) !== a.consentHash) return { status: 409, body: { ok: false, error: "samtycke_andrat" } };
      // Vad kunden accepterade: version + hash av exakt de texter/priser som visades, när, och för hur många offerter.
      const srcState = (await this.state.storage.get("sources")) || emptySources();
      const cv = sourcesView(sourcesConfig(this.env), srcState).coverage;
      const coverage = { active: cv.active, firms: cv.firms, google: cv.google, trustpilot: cv.trustpilot }; // bara antal per läge – inga firmanamn, ingen omdömesdata
      o.accept = { ...(o.accept || {}), coverage, terms: true, immediateDelivery: true, contactEmail: a.contactEmail, snapshot, acceptedAt: now, consentVersion: a.consentVersion, consentHash: a.consentHash, draft: a.draft === true, offerVersion: a.offerVersion, priceOre: a.priceOre, currency: a.currency, docCount: o.docCount };
      await this._save(o);
      return { body: { ok: true } };
    }
    if (path === "/consent-status") {
      // Finns ett samtycke som matchar den aktuella texten (hash)? Används av "betala igen" utan ny presentation.
      const same = !!(o.accept && o.accept.terms && o.accept.immediateDelivery && o.accept.snapshot && validEmail(o.accept.contactEmail) && o.accept.consentHash === b.consentHash && o.accept.docCount === o.docCount);
      return { body: { ok: true, same } };
    }
    if (path === "/checkout-begin") {
      if (o.status === "awaiting_payment" && o.stripe && o.stripe.url && o.stripe.expiresAt > now + 60_000) return { body: { ok: true, reuse: { url: o.stripe.url }, order: publicView(o, now) } };
      if (!["ready", "awaiting_payment"].includes(o.status)) return { status: 409, body: { ok: false, error: "status", status_: o.status } };
      const a = o.accept;
      if (!a || !a.sameJob || !a.terms || !a.immediateDelivery || !a.consentHash || !o.estimate) return { status: 409, body: { ok: false, error: "ej_klar" } };
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
      o.stripe = { sessionId: s.id, url: s.url, expiresAt: s.expiresAt, paymentIntentId: null, attempt: o.checkout.intent ? o.checkout.intent.attempt : null };
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
      await this.state.storage.delete("sources");
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
    const ledger = newLedger({ agreement, agreementHash, withdrawTokenHash: wt.secretHash, env: this.env, now });
    const origin = (() => { try { return new URL(this.env.COMPARE_RETURN_URL).origin; } catch { return ""; } })();
    const mail = confirmationMail(ledger);
    const entry = await outboxEntry(mail, { to: o.accept.contactEmail, now, secrets: { ANGERLANK: `${origin}/jamfor/angra/#t=${wt.token}` } });
    await this._commit({ put: { ledger, [`outbox:${mail.id}`]: entry, order: o } }); // betald + avtalspost + bekräftelse: allt eller inget
    return { body: { ok: true, status: "paid" }, after: async () => { await this._ensureAlarm(o, now, true); await this._indexLedger(o.id, now); } };
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
    await this._tx(async () => { const cur = await this._load(); if (cur) await this._repairWithdrawal(cur, now); });
    if (this._afterTx) { const a = this._afterTx; this._afterTx = null; await a(); }
    await this._drainOutbox(now);
    // Atomär arbetsclaim: bara om betald, ej levererad och ingen annan har en giltig lease.
    const claim = await this._tx(async () => {
      const o = await this._load();
      if (!o || !["paid", "running"].includes(o.status)) return null;
      const lease = o.work.lease;
      if (lease && lease.until > now) return { wait: lease.until };
      if (o.work.attempts >= LIMITS.maxOrderAttempts) { return { exhausted: true }; } // inget nytt försök, ingen ny generation
      const owner = `${now}-${Math.random().toString(36).slice(2, 10)}`;
      o.work.attempts += 1;
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
        o.purgeKeys = [...new Set([...(o.purgeKeys || []), ...o.docs.map((d) => d.key).filter(Boolean)])];
        o.docs = o.docs.map((d) => ({ ...d, key: null }));
        await this._save(o);
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
      await this.state.storage.delete("sources");
      o.purgeKeys = [...new Set([...(o.purgeKeys || []), ...o.docs.map((d) => d.key).filter(Boolean)])];
      o.docs = o.docs.map((d) => ({ ...d, key: null }));
      refundCall = this._planRefund(o);
      await this._save(o);
      return null;
    });
    if (retryAt) { await this.state.storage.setAlarm(retryAt); return; }
    await this._runRefund(refundCall);
    // Rensa rå offertdata så fort ärendet är avslutat (levererat eller misslyckat).
    try {
      const o = await this._load();
      if (o && ["delivered", "failed"].includes(o.status)) await this._purgeDocs(o);
    } catch { /* TTL 24 h är reservvägen */ }
  }

  _planRefund(o) {
    if (o.refund.state === "none") o.refund.state = o.refund.mode === "auto" && o.stripe && o.stripe.paymentIntentId ? "requested" : "needed";
    return o.refund.state === "requested" ? { paymentIntentId: o.stripe.paymentIntentId, orderId: o.id } : null;
  }
  async _runRefund(refundCall) {
    if (!refundCall) return;
    let res = null;
    try { res = await refundPayment(this.env, { ...refundCall, fetchImpl: (u, i) => fetch(u, i) }); } catch { res = null; }
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
    return {
      agreement: { id: ledger.agreementId, hash: ledger.agreementHash, paidAt: ledger.agreement.payment.paidAt, contact: maskEmail(ledger.agreement.contact.email), draft: true, mails },
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
    if (ledger.withdrawal && ledger.withdrawal.outcome === "manuell_provning") return { ran: true, action: "hallen", reason: "manuell_provning_oppen" };
    if (purgeDue) {
      try { await this._purgeDocs(o); } catch { /* 24 h TTL är reservvägen */ }
      const keys = [...(await this.state.storage.list()).keys()];
      for (const k of keys) await this.state.storage.delete(k);
      try { const { ledgerUnindex } = await import("./compare_budget.js"); await ledgerUnindex(this.env, { orderId: o.id, at: paidAt }); } catch { /* indexposten innehåller bara order-ID; nästa svep försöker igen via adminrutten */ }
      return { ran: true, action: "raderad", purged: true };
    }
    // Avtalsklassen utgången men bokföringsklassen kvar: ta bort personuppgifts-/avtalsdelen, behåll belopp/moms/datum/Stripe-referenser.
    o.accept = o.accept ? { ...o.accept, contactEmail: null, snapshot: null } : o.accept;
    const mails = [...(await this.state.storage.list({ prefix: "outbox:" })).keys()];
    await this._commit({ put: { ledger: stripLedger(ledger, now), order: o }, del: [...mails, "sources"] });
    return { ran: true, action: "avtalsdel_rensad", stripped: true };
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
    else wd.outcome = "manuell_provning"; // levererad/raderad/utgången: ingen automatisk bedömning
    ledger.withdrawal = wd;
    addEvent(ledger, "angerbegaran", now, { via: b.via, outcome: wd.outcome, stateAtRequest: wd.stateAtRequest });
    const rm = receiptMail(ledger, ledger.withdrawal);
    const put = { ledger, order: o };
    if (!(await this.state.storage.get(`outbox:${rm.id}`))) put[`outbox:${rm.id}`] = await outboxEntry(rm, { to: ledger.agreement.contact.email, now });
    await this._commit({ put, del }); // ånger + orderstatus + kvittomejl i ETT atomiskt skrivsteg
    return {
      body: { ok: true, duplicate: false, withdrawal: view(), order: publicView(o, now) },
      after: async () => { await this._runRefund(refundCall); if (purge) await this._purgeDocs(await this._load()); await this._ensureAlarm(o, now, true); },
    };
  }

  async _queueReceipt(ledger, now) {
    const m = receiptMail(ledger, ledger.withdrawal);
    if (await this.state.storage.get(`outbox:${m.id}`)) return;
    await this.state.storage.put(`outbox:${m.id}`, await outboxEntry(m, { to: ledger.agreement.contact.email, now }));
  }

  // Lokal utkorg. Extern sändning är AV: utan env.COMPARE_MAILER ligger meddelandena kvar som "queued" (inget påstås skickat).
  // "sent" sätts bara efter transportens kvittens. Samma meddelande-ID vid omförsök (transporten ska deduplicera), så en förlorad
  // kvittens ger omsändning av SAMMA meddelande, aldrig ett nytt eller ett falskt "skickat".
  async _drainOutbox(now) {
    const mailer = this.env.COMPARE_MAILER;
    if (!mailer || typeof mailer.send !== "function") return;
    const entries = [...(await this.state.storage.list({ prefix: "outbox:" }))];
    let retryAt = null;
    for (const [key] of entries) {
      const claim = await this._tx(async () => {
        const m = await this.state.storage.get(key);
        if (!m || m.state === "sent" || m.state === "failed") return null;
        if (m.attempts >= 5) { m.state = "failed"; await this.state.storage.put(key, m); return null; }
        if (m.nextAt && m.nextAt > now) return { wait: m.nextAt };
        m.attempts += 1; m.lastAttemptAt = now; await this.state.storage.put(key, m);
        return { m: { ...m } };
      });
      if (!claim) continue;
      if (claim.wait) { retryAt = Math.min(retryAt ?? claim.wait, claim.wait); continue; }
      let ack = null;
      try {
        let text = claim.m.body;
        for (const [k, v] of Object.entries(claim.m.secrets || {})) text = text.split(`{{${k}}}`).join(v);
        ack = await mailer.send({ id: claim.m.id, to: claim.m.to, subject: claim.m.subject, body: text });
      } catch { ack = null; }
      await this._tx(async () => {
        const m = await this.state.storage.get(key);
        if (!m || m.state === "sent") return;
        if (ack && ack.ok === true) { m.state = "sent"; m.sentAt = Date.now(); m.providerRef = typeof ack.ref === "string" ? ack.ref.slice(0, 80) : null; m.secrets = null; m.lastError = null; }
        else { m.lastError = "transport"; m.nextAt = Date.now() + Math.min(60_000, 2_000 * 2 ** m.attempts); retryAt = Math.min(retryAt ?? m.nextAt, m.nextAt); }
        await this.state.storage.put(key, m);
      });
    }
    if (retryAt && this.state.storage.setAlarm) await this.state.storage.setAlarm(Math.max(retryAt, Date.now() + 10));
  }

  async _purgeDocs(o) {
    const keys = new Set([...(o.purgeKeys || []), ...o.docs.map((d) => d.key).filter(Boolean)]);
    const failed = [];
    for (const k of keys) {
      try { await this.env.REVIEWS_KV.delete(k); } catch { failed.push(k); }
    }
    const ids = (o.work && o.work.steps && Object.keys(o.work.steps.ext)) || [];
    for (const i of ids) await this.state.storage.delete(`ext:${i}`);
    await this.state.storage.delete("aux:priority");
    // Kvarvarande nycklar behålls för ny rensning; TTL 24 h är reservvägen.
    await this._tx(async () => { const cur = await this._load(); if (cur) { cur.purgeKeys = failed; await this._save(cur); } });
  }
}

export { publicView };
