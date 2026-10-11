// Rättning ovanpå 37b9c535 (root-QA ROOT_MAILER_37B9): (P1) dygnstak = atomisk spårad reservation per meddelande OCH faktiskt UTC-dygn före HTTP, även för omförsök efter midnatt;
// (P2) okänt utfall (förlorad kvittens/timeout/5xx) efter slutade försök ⇒ "avstamning", inte "failed". ENDAST HTTP-dubbel; inget verkligt HTTP/sändning/nyckel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, installFetch, readyOrder, startCheckout, paidSession, webhook, MAIL_WH_SECRET, mailEvent, flushMailEvents } from "./helpers/compare_env.mjs";

const ON = { COMPARE_MAILER_MODE: undefined, COMPARE_MAIL_HTTP: "1", COMPARE_MAIL_HTTP_VERIFIED: "1", COMPARE_MAIL_FROM: "QA <qa@example.test>", COMPARE_MAIL_DAY_CAP: "1", COMPARE_MAIL_API_KEY: "re_TESTONLY_syntheticKey0123456789", COMPARE_MAIL_WEBHOOK_SECRET: MAIL_WH_SECRET };
const SELLER = { COMPARE_SELLER_FORM: "AB", COMPARE_SELLER_NAME: "Syntetisk Säljare AB", COMPARE_SELLER_ORGNR: "556000-0001", COMPARE_SELLER_EMAIL: "kontakt@example.test", COMPARE_SELLER_ADDRESS: "Exempelgatan 1, 111 11 Teststad", COMPARE_SELLER_PHONE: "+46 8 000 00 00", COMPARE_COMPANY_INFO_URL: "https://example.test/foretagsuppgifter" };
const S = (t) => ({ extracted: { totalBeforeRotSek: t, totalVatBasis: "inkl" }, scope: { rivning: "ingar", bortforsling: "ingar", material: "ingar", arbete: "ingar", resor: "ingar" } });
const confOf = (o) => [...o.store.values()].find((x) => x && x.kind === "avtalsbekraftelse");
const clear = (o) => { for (const [k, v] of o.store) if (k.startsWith("outbox:")) o.store.set(k, { ...v, nextAt: 0, leaseUntil: null }); };
async function prepare(env, f) {
  const r = await readyOrder(env, [S(100000), S(110000)]);
  assert.equal((await startCheckout(env, r.orderId, r.token)).status, 200);
  assert.equal((await webhook(env, "checkout.session.completed", paidSession([...f.sessions.values()].at(-1)))).status, 200);
  return env.COMPARE_ORDERS.peek(r.orderId);
}
async function atClock(iso, fn) { const real = Date.now; let now = Date.parse(iso); Date.now = () => now; try { return await fn({ get: () => now, set: (t) => { now = typeof t === "string" ? Date.parse(t) : t; }, adv: (ms) => { now += ms; } }); } finally { Date.now = real; } }

test("P1 UTC-midnatt: A får 500 före midnatt; B:s första accept och A:s retry efter midnatt ⇒ cap 1 ger EN accept; nekad retry skickar inget HTTP; efter 23 h ⇒ avstämning", () =>
  atClock("2026-10-11T23:59:58Z", async (c) => {
    const f = installFetch();
    try {
      const env = makeEnv({ ...SELLER, ...ON }); const a = await prepare(env, f), b = await prepare(env, f);
      f.ctl.mailModes = ["500"]; await a.obj._drainOutbox(c.get());
      assert.equal(f.log.mailSent.length, 0); const callsBefore = f.log.mail.length; assert.equal(callsBefore, 1);
      c.adv(10_000); // nu 2026-10-12
      await b.obj._drainOutbox(c.get()); await a.obj._drainOutbox(c.get());
      assert.equal(f.log.mailSent.length, 1, "cap 1 per UTC-dygn");
      assert.equal(f.log.mail.length, callsBefore + 1, "A:s nekade retry gjorde inget HTTP-anrop");
      assert.equal(confOf(a).lastError, "mejl_dygnstak"); assert.equal(confOf(a).state, "queued"); assert.equal(confOf(b).state, "sent");
      // senare samma dygn men inom 23 h-fönstret: ny cap-kapacitet saknas (B tog den) ⇒ fortfarande nekad, inget HTTP
      c.set("2026-10-12T20:00:00Z"); clear(a); await a.obj._drainOutbox(c.get()); assert.equal(f.log.mail.length, callsBefore + 1); assert.equal(confOf(a).lastError, "mejl_dygnstak");
      // efter 23 h-fönstret: ingen ny nyckel, ingen blind sändning ⇒ avstämning
      c.set("2026-10-13T00:05:00Z"); clear(a); await a.obj._drainOutbox(c.get());
      assert.equal(f.log.mail.length, callsBefore + 1); assert.equal(confOf(a).state, "avstamning"); assert.equal(confOf(a).lastError, "idem_fonster_utgatt");
      assert.equal(new Set(f.log.mail.map((m) => m.idem)).size, 2, "bara A:s och B:s nycklar; aldrig ny nyckel");
    } finally { f.restore(); }
  }));

test("P1 samma meddelande räknas högst en gång per UTC-dygn (omförsök samma dygn) och dygnsreservation ger ingen fri sändning nästa dygn", () =>
  atClock("2026-10-12T10:00:00Z", async (c) => {
    const f = installFetch();
    try {
      const env = makeEnv({ ...SELLER, ...ON, COMPARE_MAIL_DAY_CAP: "2" }); const a = await prepare(env, f), b = await prepare(env, f), d = await prepare(env, f);
      f.ctl.mailModes = ["500", "500", "500"];
      for (let i = 0; i < 3; i++) { clear(a); await a.obj._drainOutbox(c.get()); c.adv(1000); }
      assert.equal(f.log.mail.length, 3); assert.equal(confOf(a).capDay, "2026-10-12");
      await b.obj._drainOutbox(c.get()); assert.equal(confOf(b).state, "sent", "A:s omförsök åt inte upp mer än EN reservation");
      await d.obj._drainOutbox(c.get()); assert.equal(confOf(d).state, "queued"); assert.equal(confOf(d).lastError, "mejl_dygnstak");
      // nästa dygn: A (reserverade igår) måste reservera på nytt; D först i kön tar den enda... cap 2 ⇒ båda får plats, men reservationen sker per dygn
      c.set("2026-10-13T00:00:10Z"); clear(a); clear(d);
      await a.obj._drainOutbox(c.get()); assert.equal(confOf(a).capDay, "2026-10-13"); assert.equal(confOf(a).state, "sent");
    } finally { f.restore(); }
  }));

test("P1 positiv kontroll: två order parallellt samma dygn, cap 1 ⇒ exakt 1 accept; utan kapacitetsbindning ⇒ inget HTTP", () =>
  atClock("2026-10-12T12:00:00Z", async (c) => {
    const f = installFetch();
    try {
      const env = makeEnv({ ...SELLER, ...ON }); const a = await prepare(env, f), b = await prepare(env, f);
      await Promise.all([a.obj._drainOutbox(c.get()), b.obj._drainOutbox(c.get())]);
      assert.equal(f.log.mail.length, 1); assert.equal(f.log.mailSent.length, 1);
      const e2 = makeEnv({ ...SELLER, ...ON }); const x = await prepare(e2, f); const n = f.log.mail.length; delete e2.COMPARE_BUDGET; await x.obj._drainOutbox(c.get());
      assert.equal(f.log.mail.length, n, "fail closed utan tak-räkning");
    } finally { f.restore(); }
  }));

test("P2 förlorad kvittens till försöksslut: leverantören accepterade 1 ⇒ avstamning/utfall_okant (inte failed), samma nyckel, inga fler anrop efteråt", () =>
  atClock("2026-10-12T13:00:00Z", async (c) => {
    const f = installFetch(); const fakeFetch = globalThis.fetch;
    try {
      const env = makeEnv({ ...SELLER, ...ON, COMPARE_MAIL_DAY_CAP: "5" }); const a = await prepare(env, f);
      globalThis.fetch = async (input, init) => { const r = await fakeFetch(input, init); if (String(input) === "https://api.resend.com/emails") throw Error("synthetic acknowledgement lost"); return r; };
      for (let i = 0; i < 14; i++) { clear(a); await a.obj._drainOutbox(c.get()); c.adv(1000); }
      const m = confOf(a);
      assert.equal(f.log.mailSent.length, 1); assert.equal(m.state, "avstamning"); assert.equal(m.lastError, "utfall_okant"); assert.equal(m.attempts, 12);
      assert.equal(new Set(f.log.mail.map((x) => x.idem)).size, 1, "aldrig ny nyckel");
      const n = f.log.mail.length; clear(a); await a.obj._drainOutbox(c.get()); assert.equal(f.log.mail.length, n, "avstämning är terminal för automatisk sändning");
    } finally { globalThis.fetch = fakeFetch; f.restore(); }
  }));

test("P2 verifierat terminalt avslag (422) förblir failed; rena 5xx till försöksslut är okänt utfall ⇒ avstamning", () =>
  atClock("2026-10-12T14:00:00Z", async (c) => {
    const f = installFetch();
    try {
      const env = makeEnv({ ...SELLER, ...ON, COMPARE_MAIL_DAY_CAP: "5" }); const a = await prepare(env, f);
      f.ctl.mailModes = ["422"]; await a.obj._drainOutbox(c.get()); assert.equal(confOf(a).state, "failed"); assert.equal(confOf(a).lastError, "mejl_http_422");
      const b = await prepare(env, f); f.ctl.mailModes = Array(14).fill("500");
      for (let i = 0; i < 14; i++) { clear(b); await b.obj._drainOutbox(c.get()); c.adv(1000); }
      assert.equal(confOf(b).state, "avstamning"); assert.equal(confOf(b).lastError, "utfall_okant"); assert.equal(f.log.mailSent.length, 0);
    } finally { f.restore(); }
  }));

// ---- P2b (root-QA ROOT_MAILER_28284): ett senare stopp efter tidigare OKÄNT utfall får inte ersätta det med failed ----
const injected = (f, mk) => { const real = globalThis.fetch; globalThis.fetch = async (input, init) => (String(input) === "https://api.resend.com/emails" && f.log.mailSent.length ? mk() : real(input, init)); return () => { globalThis.fetch = real; }; };
const J = (status, name) => Response.json({ statusCode: status, name }, { status });
const CASES = [
  ["422 (terminalt avslag)", (f) => injected(f, () => J(422, "validation_error")), null],
  ["401/403 (terminalt)", (f) => injected(f, () => J(401, "restricted_api_key")), null],
  ["400 ogiltig nyckel (config)", (f) => injected(f, () => J(400, "invalid_idempotency_key")), null],
  ["409 annan nyttolast (payload_conflict)", (f) => injected(f, () => J(409, "invalid_idempotent_request")), null],
  ["ändrad nyttolast (fryst hash)", () => () => {}, (a) => { for (const [k, v] of a.store) if (k.startsWith("outbox:")) a.store.set(k, { ...v, subject: v.subject + " ändrad" }); }],
  ["ogiltig mottagare", () => () => {}, (a) => { for (const [k, v] of a.store) if (k.startsWith("outbox:")) a.store.set(k, { ...v, to: "inte en adress" }); }],
];
for (const [name, install, mutate] of CASES) {
  test(`P2b okänt utfall (accept 1, kvittens förlorad) ⇒ senare ${name} ger avstamning/utfall_okant, inte failed; ingen ny nyckel, ingen fler sändning`, () =>
    atClock("2026-10-12T15:00:00Z", async (c) => {
      const f = installFetch(); const fakeFetch = globalThis.fetch; let restore = () => {};
      try {
        const env = makeEnv({ ...SELLER, ...ON, COMPARE_MAIL_DAY_CAP: "5" }); const a = await prepare(env, f);
        f.ctl.mailModes = ["timeout_after_accept"]; await a.obj._drainOutbox(c.get());
        assert.equal(f.log.mailSent.length, 1); assert.equal(confOf(a).unknownOutcome, true); assert.equal(confOf(a).state, "queued");
        restore = install(f); if (mutate) mutate(a);
        const mails = f.log.mail.length;
        for (let i = 0; i < 3; i++) { c.adv(400_000); clear(a); await a.obj._drainOutbox(c.get()); }
        const m = confOf(a);
        assert.equal(m.state, "avstamning", name); assert.equal(m.lastError, "utfall_okant"); assert.ok(m.laterStop || mutate, "senare stopp noterat");
        assert.equal(f.log.mailSent.length, 1);
        const before = f.log.mail.length; clear(a); await a.obj._drainOutbox(c.get()); assert.equal(f.log.mail.length, before, "avstämning är terminal för automatisk sändning");
        assert.equal(new Set(f.log.mail.map((x) => x.idem)).size, 1, "aldrig ny nyckel"); assert.ok(f.log.mail.length >= mails);
      } finally { restore(); globalThis.fetch = fakeFetch; f.restore(); }
    }));
}

test("P2b första säkra stopp utan tidigare osäkerhet ⇒ failed (422, ogiltig mottagare); okänt→verkligt ID-ack ⇒ sent", () =>
  atClock("2026-10-12T16:00:00Z", async (c) => {
    const f = installFetch();
    try {
      const env = makeEnv({ ...SELLER, ...ON, COMPARE_MAIL_DAY_CAP: "9" });
      const a = await prepare(env, f); f.ctl.mailModes = ["422"]; await a.obj._drainOutbox(c.get());
      assert.equal(confOf(a).state, "failed"); assert.equal(confOf(a).lastError, "mejl_http_422"); assert.equal(confOf(a).unknownOutcome, undefined);
      const b = await prepare(env, f); for (const [k, v] of b.store) if (k.startsWith("outbox:")) b.store.set(k, { ...v, to: "inte en adress" });
      await b.obj._drainOutbox(c.get()); assert.equal(confOf(b).state, "failed"); assert.equal(confOf(b).lastError, "mejl_ogiltig_mottagare");
      // okänt (accept, kvittens förlorad) → nästa försök får ID-ack ⇒ sent, samma nyckel, EN accept
      const d = await prepare(env, f); f.ctl.mailModes = ["timeout_after_accept"]; await d.obj._drainOutbox(c.get());
      assert.equal(confOf(d).state, "queued"); c.adv(400_000); clear(d); await d.obj._drainOutbox(c.get());
      assert.equal(confOf(d).state, "sent"); assert.ok(confOf(d).providerRef); assert.equal(f.log.mailSent.filter((x) => x.idem === "mail-" + confOf(d).id).length, 1);
      // 5xx först, sedan ack ⇒ sent
      const e = await prepare(env, f); f.ctl.mailModes = ["500", "ok"]; await e.obj._drainOutbox(c.get()); c.adv(400_000); clear(e); await e.obj._drainOutbox(c.get());
      assert.equal(confOf(e).state, "sent");
    } finally { f.restore(); }
  }));
