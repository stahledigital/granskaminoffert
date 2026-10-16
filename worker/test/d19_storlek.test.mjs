// D19 8/20 MB-gränsfynd (Codex 2026-10-17): base64.length × 0,75 räknade paddingtecken som data, så en korrekt 8 000 000-byte-PDF nekades (8 000 001).
// Taken 8 MB per fil / 20 MB totalt är OFÖRÄNDRADE; här provas exakt binär mätning, ogiltig base64 och totalgränsen, både betald (jämför) och gratis väg.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, createOrder, installFetch, api, ORIGIN } from "./helpers/compare_env.mjs";
import { base64ByteLength } from "../src/limits.js";
import worker from "../src/index.js";
import { gateVars } from "./helpers/free_gate.mjs";
import { fakeQuotaNamespace } from "./helpers/quota_do.mjs";

// Giltig syntetisk PDF-liknande fil (magiska bytes %PDF, en sida) med EXAKT n byte.
const pdfOf = (n, tag = "a") => {
  const head = Buffer.from("%PDF-1.4\n/Type /Page\n");
  const b = Buffer.alloc(n, tag.charCodeAt(0));
  head.copy(b, 0); b[n - 1] = 10;
  return b;
};
const b64 = (buf) => buf.toString("base64");

test("base64ByteLength: exakt för alla paddningsfall, null för ogiltigt", () => {
  for (let n = 0; n <= 40; n++) {
    const buf = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255));
    const s = buf.toString("base64");
    if (n === 0) { assert.equal(base64ByteLength(s), null, "tom sträng är inte en fil"); continue; }
    assert.equal(base64ByteLength(s), n, `padded n=${n}`);
    const unpadded = s.replace(/=+$/, "");
    if (unpadded.length % 4 !== 1) assert.equal(base64ByteLength(unpadded), n, `opaddad n=${n}`);
  }
  assert.equal(base64ByteLength("AAAA"), 3); assert.equal(base64ByteLength("AAA="), 2); assert.equal(base64ByteLength("AA=="), 1);
  for (const bad of ["A", "AAAAA", "AA=A", "A===", "=AAA", "AAAA====", "AA==AAAA", "AA A", "AAA\n", "ÅÄÖA", "AA-_", "====", null, undefined, 42, {}, []]) {
    assert.equal(base64ByteLength(bad), null, `ogiltig: ${JSON.stringify(bad)}`);
  }
  // 8 MB-gränsen i teckenlängd: 8 000 000 byte = 10 666 668 tecken (2 paddingtecken); gamla formeln gav 8 000 001
  const len = Math.ceil(8_000_000 / 3) * 4;
  assert.equal(len, 10_666_668);
  assert.equal(len * 0.75, 8_000_001);
  assert.equal(base64ByteLength(b64(pdfOf(8_000_000))), 8_000_000);
});

test("betald väg: exakt 8 000 000 byte godtas, 7 999 998 godtas, 8 000 001 och 8 000 002 nekas (413), ogiltig base64 nekas (400) – metadata bär exakta byte", async () => {
  const f = installFetch();
  try {
    const env = makeEnv();
    for (const [n, want] of [[7_999_998, 200], [8_000_000, 200], [8_000_001, 413], [8_000_002, 413], [8_000_003, 413]]) {
      const { orderId, token } = (await createOrder(env, 2)).json;
      const r = await api(env, "PUT", `/compare/orders/${orderId}/docs/0`, { token, body: { kind: "pdf", dataBase64: b64(pdfOf(n)) } });
      assert.equal(r.status, want, `${n} byte`);
      if (want === 200) assert.equal(r.json.doc.bytes, n, "manifestets byte = verkliga binära byte");
    }
    // ogiltig base64 (rätt längd, olagligt tecken / padding i mitten / längd % 4 = 1) ger 400, aldrig 200/413
    const { orderId, token } = (await createOrder(env, 2)).json;
    const good = b64(pdfOf(1000));
    for (const bad of [good.slice(0, 40) + "!" + good.slice(41), good.slice(0, 40) + "=" + good.slice(41), good + "A", "%PDF"]) {
      const r = await api(env, "PUT", `/compare/orders/${orderId}/docs/0`, { token, body: { kind: "pdf", dataBase64: bad } });
      assert.equal(r.status, 400);
    }
    // väl överstor (hundratals tusen byte över) är fortsatt 413, inte 400
    const big = await api(env, "PUT", `/compare/orders/${orderId}/docs/0`, { token, body: { kind: "pdf", dataBase64: "A".repeat(11_000_000) } });
    assert.equal(big.status, 413);
  } finally { f.restore(); }
});

test("betald väg: totalen 20 000 000 byte godtas (7 999 998 + 7 999 998 + 4 000 004), 19 999 999 godtas, 20 000 001 nekas (413)", async () => {
  const f = installFetch();
  try {
    f.ctl.countTokens = 2000;
    const env = makeEnv();
    const trio = async (a, b, c) => {
      const { orderId, token } = (await createOrder(env, 3)).json;
      const put = (i, n, tag) => api(env, "PUT", `/compare/orders/${orderId}/docs/${i}`, { token, body: { kind: "pdf", dataBase64: b64(pdfOf(n, tag)) } });
      assert.equal((await put(0, a, "a")).status, 200);
      assert.equal((await put(1, b, "b")).status, 200);
      const last = await put(2, c, "c");
      return { last, orderId, token };
    };
    const exact = await trio(7_999_998, 7_999_998, 4_000_004);
    assert.equal(exact.last.status, 200, "exakt 20 000 000 byte ryms");
    assert.equal(exact.last.json.order.status, "ready");
    const under = await trio(7_999_998, 7_999_998, 4_000_003);
    assert.equal(under.last.status, 200);
    const over = await trio(7_999_998, 7_999_998, 4_000_005);
    assert.equal(over.last.status, 413, "20 000 001 byte nekas");
  } finally { f.restore(); }
});

// ---- gratisvägen (/review): samma 8 MB-tak, ogiltig base64 nekas före allt betalt ----
const ctx = () => { const jobs = []; return { jobs, waitUntil: (p) => jobs.push(p) }; };
const kv = () => { const m = new Map(); return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); } }; };
const freeEnv = () => ({ REVIEWS_KV: kv(), QUOTA: fakeQuotaNamespace(), ...gateVars(), ALLOWED_ORIGIN: ORIGIN, ANTHROPIC_API_KEY: "test" });
const freeReq = (body, ip) => new Request("https://api.test/review", { method: "POST", headers: { "content-type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": ip }, body: JSON.stringify(body) });
function mockAnthropic() {
  const calls = { count: 0, messages: 0 }; const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/count_tokens")) { calls.count++; return new Response(JSON.stringify({ input_tokens: 5000 }), { status: 200 }); }
    calls.messages++; return new Response(JSON.stringify({ error: "mock" }), { status: 500 });
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test("gratisväg: exakt 8 000 000 byte passerar storleksvakten (mäts), 8 000 001 nekas före all mätning, ogiltig base64 nekas", async () => {
  const m = mockAnthropic();
  try {
    let n = 0;
    for (const [bytes, passes] of [[7_999_998, true], [8_000_000, true], [8_000_001, false], [8_000_002, false]]) {
      const before = m.calls.count;
      const r = await worker.fetch(freeReq({ kind: "pdf", dataBase64: b64(pdfOf(bytes)) }, `198.51.100.${++n}`), freeEnv(), ctx());
      if (passes) { assert.equal(m.calls.count, before + 1, `${bytes}: nådde tokenmätningen`); assert.notEqual(r.status, 400, `${bytes} ej nekad som för stor`); }
      else { assert.equal(r.status, 400, `${bytes}`); assert.equal(m.calls.count, before, `${bytes}: ingen mätning`); assert.match((await r.json()).error, /för stor/); }
    }
    const good = b64(pdfOf(1000));
    for (const bad of [good.slice(0, 40) + "!" + good.slice(41), good + "A"]) {
      const before = m.calls.count + m.calls.messages;
      const r = await worker.fetch(freeReq({ kind: "pdf", dataBase64: bad }, `198.51.100.${++n}`), freeEnv(), ctx());
      assert.equal(r.status, 400); assert.equal(m.calls.count + m.calls.messages, before);
    }
  } finally { m.restore(); }
});
