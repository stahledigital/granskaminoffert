// Materialräknaren PRO · konto, engångskod och sessioner (KONTO-SYNK K1, Donatello 2026-10-18). WORK-ID KP-2026-10-16-01.
// Spec: SAJT OCH APPAR/GRANSKNINGAR/Materialraknaren-PRO-2026-10-16/KONTO_SYNK/ETAPPSPEC_KONTO_SYNK_V1.md (sha cb18ec93…) §1 och §2 K1.
//
// - Två SQLite-DO-klasser (migration v5): ProRegister (EN instans, "register:v1") och ProKonto (en per konto, idFromName("k:"+kontoId)).
// - Grind PRO_KONTO = "off" | "inbjudna" (förval off). Off: allt under /pro/konto/* svarar 503 {status:"stangt"} med samma headers som
//   befintliga /pro/* i off, INNAN någon bindning, KV, kryptonyckel eller mejltransport rörs.
// - Inga nya hemligheter. Nyckeln härleds ur befintlig webhookhemlighet (live i första hand, annars test) med egna domänsträngar, så att
//   den inte byts när PRO_PAYMENTS byter läge. E-post lagras aldrig i klartext: registret har bara HMAC(e-post).
// - kontoId tas bara ur en verifierad session eller ur registrets svar, aldrig ur klientdata.
// - Ändrande anrop kräver Origin i PRO_ALLOWED_ORIGIN (https://stahledigital.se) OCH X-MR-Pro: 1.
// - Mejltransport: befintlig Resend-adapter (mailHttpConfig/sendViaHttp), idempotensnyckel per kod. Dagstak PRO_MAIL_DAY_CAP räknas i registret.
// - Rätt prövas vid varje anrop till /jag separat från sessionen: ägare (PRO_OWNER_EMAIL), testbevis i registret, Stripe-prenumeration
//   (befintlig aktivPren, bara när kontot har en kopplad kund och PRO_PAYMENTS inte är off: i off görs inga Stripe-anrop).
import { hmacSha256Hex, timingSafeEqual, randomToken, randomHex, sha256Hex, jsonResponse } from "./compare_util.js";
import { mailHttpConfig, buildMailRequest, sendViaHttp, validMailTo } from "./compare_mailer.js";
import { MEJL } from "./pro_texter.js";

const DAG = 86400;
export const KOD_S = 10 * 60, KOD_FORSOK = 5;
export const SESSION_S = 90 * DAG, FORLANG_S = 3600, MAX_ENHETER = 3;
export const GRANS_EPOST = 3, GRANS_EPOST_S = 15 * 60, GRANS_IP = 10, GRANS_IP_S = 3600;
export const LAS_DAGAR = 90;
export const COOKIE = "__Host-mrpro";
const KONTO_RE = /^k_[0-9a-f]{32}$/, SESS_RE = /^[A-Za-z0-9_-]{22}$/, ENHET_RE = /^e_[0-9a-f]{16}$/, KODID_RE = /^[0-9a-f]{32}$/, KOD_RE = /^\d{6}$/, CUS_RE = /^cus_[A-Za-z0-9]{6,}$/;
const REGISTER_NAMN = "register:v1";

// Systemtexter (Dons, inte S4g). Zlata ersätter i K5.
export const KONTO_TEXT = Object.freeze({
  kod_amne: "Din inloggningskod till Materialräknaren PRO",
  kod: [
    "Hej!",
    "",
    "Din kod för att logga in på Materialräknaren PRO:",
    "",
    "    {kod}",
    "",
    "Koden gäller i 10 minuter och kan bara användas en gång. Du kan också öppna länken på samma enhet:",
    "{lank}",
    "",
    "Har du inte bett om koden kan du strunta i det här mejlet. Ingen kan logga in utan den.",
    "",
    "Ståhle Digital",
  ].join("\n"),
});
const fyll = (t, v) => t.replace(/\{(\w+)\}/g, (_, k) => (k in v ? String(v[k]) : ""));

export function kontoLage(env) { return env && env.PRO_KONTO === "inbjudna" ? "inbjudna" : "off"; } // allt annat än exakt "inbjudna" = off (fail closed)
function origins(env) { return String(env.PRO_ALLOWED_ORIGIN || "https://stahledigital.se").split(",").map((s) => s.trim()).filter(Boolean); }
// Samma headers som pro_routes.cors(): ett off-svar för /pro/konto/* blir byte-likt basens /pro/*-svar i off.
function cors(origin, env) {
  const ok = origins(env).includes(origin);
  return ok ? { "access-control-allow-origin": origin, vary: "Origin", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600" } : { vary: "Origin" };
}
const normEpost = (e) => (typeof e === "string" ? e.trim().toLowerCase() : "");

// ---------- nycklar (inga nya hemligheter) ----------
async function kontoNyckel(env) {
  const s = [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_TEST_WEBHOOK_SECRET].find((v) => typeof v === "string" && v.length >= 16);
  if (!s) { const e = new Error("kontonyckel saknas"); e.status = 503; throw e; }
  return hmacSha256Hex(s, "mr-pro-konto-v1");
}
const etikett = async (env, dom, v) => hmacSha256Hex(await kontoNyckel(env), `${dom}|${v}`);
export const epostHash = (env, epost) => etikett(env, "mr-pro-epost-v1", normEpost(epost));
const kodHash = (env, kodId, kod) => etikett(env, "mr-pro-kod-v1", `${kodId}:${kod}`);
const sessSig = (env, kontoId, sid) => etikett(env, "mr-pro-session-v1", `${kontoId}.${sid}`);
const sessHash = (sid) => sha256Hex("mr-pro-sess|" + sid);
const ipHash = async (request) => (await sha256Hex("mr-pro-ip|" + (request.headers.get("CF-Connecting-IP") || "okand"))).slice(0, 32);

export function nyKod() { // 6 siffror, likformigt (förkastar 4 294 000 000 och uppåt)
  const a = new Uint32Array(1);
  for (;;) { crypto.getRandomValues(a); if (a[0] < 4294000000) return String(a[0] % 1000000).padStart(6, "0"); }
}

export async function skapaSessionsvarde(env, kontoId) {
  const sid = randomToken(16); // 22 tecken base64url
  return { sid, varde: `${kontoId}.${sid}.${await sessSig(env, kontoId, sid)}` };
}
export async function lasSessionsvarde(env, varde) { // → { kontoId, sid } eller null. Signaturen prövas före varje DO-uppslag.
  if (typeof varde !== "string" || varde.length > 200) return null;
  const d = varde.split("."); if (d.length !== 3) return null;
  const [kontoId, sid, sig] = d;
  if (!KONTO_RE.test(kontoId) || !SESS_RE.test(sid) || !/^[0-9a-f]{64}$/.test(sig)) return null;
  return timingSafeEqual(sig, await sessSig(env, kontoId, sid)) ? { kontoId, sid } : null;
}
export function lasCookie(request) {
  const c = request.headers.get("Cookie") || "";
  for (const del of c.split(";")) { const i = del.indexOf("="); if (i > 0 && del.slice(0, i).trim() === COOKIE) return del.slice(i + 1).trim(); }
  return null;
}
export const satCookie = (varde) => `${COOKIE}=${varde}; Path=/; Max-Age=${SESSION_S}; Secure; HttpOnly; SameSite=Lax`;
export const rensaCookie = () => `${COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;

// ---------- DO-hjälp ----------
// SQL-markör → rader. Fungerar både med workerds SqlStorageCursor och testskiktets dubbel.
const rader = (cur) => (cur && typeof cur.toArray === "function" ? cur.toArray() : []);
const forsta = (cur) => rader(cur)[0] || null;
async function svarJson(resp) { if (!resp || !resp.ok) { const e = new Error("do " + (resp && resp.status)); e.status = 502; throw e; } return resp.json(); }
function registerStub(env) {
  if (!env.PRO_REGISTER || typeof env.PRO_REGISTER.idFromName !== "function") { const e = new Error("register saknas"); e.status = 503; throw e; }
  return env.PRO_REGISTER.get(env.PRO_REGISTER.idFromName(REGISTER_NAMN));
}
function kontoStub(env, kontoId) {
  if (!KONTO_RE.test(String(kontoId))) { const e = new Error("ogiltigt konto"); e.status = 502; throw e; }
  if (!env.PRO_KONTON || typeof env.PRO_KONTON.idFromName !== "function") { const e = new Error("konton saknas"); e.status = 503; throw e; }
  return env.PRO_KONTON.get(env.PRO_KONTON.idFromName("k:" + kontoId));
}
export async function register(env, op, data) {
  return svarJson(await registerStub(env).fetch(`https://pro-register/${op}`, { method: "POST", body: JSON.stringify(data) }));
}
async function konto(env, kontoId, op, data) {
  return svarJson(await kontoStub(env, kontoId).fetch(`https://pro-konto/${op}`, { method: "POST", body: JSON.stringify({ ...data, kontoId }) }));
}

// Gemensam RPC-ram för båda klasserna: varje operation körs i EN transactionSync (allt eller inget), DO:n är enda skrivare.
function rpc(self, ops) {
  return async (request) => {
    const op = new URL(request.url).pathname.slice(1);
    if (request.method !== "POST" || !Object.prototype.hasOwnProperty.call(ops, op)) return Response.json({ fel: "okand_op" }, { status: 404 });
    let d; try { d = await request.json(); } catch { return Response.json({ fel: "ogiltig_kropp" }, { status: 400 }); }
    if (!d || typeof d !== "object" || !Number.isSafeInteger(d.nu) || d.nu <= 0) return Response.json({ fel: "ogiltig_kropp" }, { status: 400 });
    try { return Response.json(self.storage.transactionSync(() => ops[op](d))); }
    catch { return Response.json({ fel: "lagringsfel" }, { status: 500 }); }
  };
}

// ---------- ProRegister: kontoregister, ägare/testbevis, köpkoppling, engångskoder, skickgränser, prenumerationens login-nonce ----------
export class ProRegister {
  constructor(state, env) {
    this.state = state; this.env = env; this.storage = state.storage;
    const sql = this.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS konton (ehash TEXT PRIMARY KEY, konto_id TEXT NOT NULL UNIQUE, skapad INTEGER NOT NULL, kund TEXT)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS testbevis (ehash TEXT PRIMARY KEY, slut INTEGER NOT NULL, aterkallad INTEGER, satt INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS koder (id TEXT PRIMARY KEY, ehash TEXT NOT NULL, hash TEXT NOT NULL, skapad INTEGER NOT NULL, utgar INTEGER NOT NULL, forsok INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS koder_ehash ON koder (ehash, skapad)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS grans (nyckel TEXT PRIMARY KEY, fonster INTEGER NOT NULL, n INTEGER NOT NULL, utgar INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS nonce (n TEXT PRIMARY KEY, kund TEXT NOT NULL, utgar INTEGER NOT NULL)`);
    this.fetch = rpc(this, {
      kod: (d) => this.kod(d), prova: (d) => this.prova(d), los: (d) => this.los(d), ratt: (d) => this.ratt(d),
      testbevis: (d) => this.testbevis(d), koppla: (d) => this.koppla(d), nonce_spara: (d) => this.nonceSpara(d), nonce_los: (d) => this.nonceLos(d),
    });
  }
  get sql() { return this.storage.sql; }
  gallra(nu) { // små, avgränsade städsteg vid varje skrivande operation
    this.sql.exec(`DELETE FROM koder WHERE utgar < ?`, nu - DAG);
    this.sql.exec(`DELETE FROM nonce WHERE utgar < ?`, nu);
    this.sql.exec(`DELETE FROM grans WHERE utgar <= ?`, nu); // varje rad bär sitt eget fönsterslut
  }
  // Fast fönster: → true om gränsen redan är nådd (räknar då inte upp), annars räknas försöket.
  over(nyckel, langd, nu, max) {
    const fonster = Math.floor(nu / langd);
    const r = forsta(this.sql.exec(`SELECT fonster, n FROM grans WHERE nyckel = ?`, nyckel));
    const n = r && r.fonster === fonster ? r.n : 0;
    if (n >= max) return true;
    this.sql.exec(`INSERT INTO grans (nyckel, fonster, n, utgar) VALUES (?, ?, ?, ?) ON CONFLICT(nyckel) DO UPDATE SET fonster = excluded.fonster, n = excluded.n, utgar = excluded.utgar`, nyckel, fonster, n + 1, (fonster + 1) * langd);
    return false;
  }
  inbjuden(ehash, agare, nu) {
    if (agare) return true;
    const t = forsta(this.sql.exec(`SELECT slut, aterkallad FROM testbevis WHERE ehash = ?`, ehash));
    return !!(t && !t.aterkallad && t.slut > nu);
  }
  // Begär kod. ip-gränsen gäller alla anrop; övriga gränser bara när ett mejl faktiskt ska gå. → { skicka, orsak }
  kod({ nu, ehash, ip, agare, kodId, hash, dagstak }) {
    if (!/^[0-9a-f]{64}$/.test(String(ehash)) || !/^[0-9a-f]{32}$/.test(String(ip)) || !KODID_RE.test(String(kodId)) || !/^[0-9a-f]{64}$/.test(String(hash)) || !(Number.isSafeInteger(dagstak) && dagstak > 0)) return { skicka: false, orsak: "ogiltig" };
    this.gallra(nu);
    if (this.over(`ip:${ip}`, GRANS_IP_S, nu, GRANS_IP)) return { skicka: false, orsak: "ip" };
    if (!this.inbjuden(ehash, !!agare, nu)) return { skicka: false, orsak: "ej_inbjuden" };
    if (this.over(`e:${ehash}`, GRANS_EPOST_S, nu, GRANS_EPOST)) return { skicka: false, orsak: "epost" };
    if (this.over("dag", DAG, nu, dagstak)) return { skicka: false, orsak: "dag" };
    let k = forsta(this.sql.exec(`SELECT konto_id FROM konton WHERE ehash = ?`, ehash));
    if (!k) { k = { konto_id: "k_" + randomHex(16) }; this.sql.exec(`INSERT INTO konton (ehash, konto_id, skapad) VALUES (?, ?, ?)`, ehash, k.konto_id, nu); }
    this.sql.exec(`UPDATE koder SET status = 'ersatt' WHERE ehash = ? AND status = 'aktiv'`, ehash); // senaste koden gäller
    this.sql.exec(`INSERT INTO koder (id, ehash, hash, skapad, utgar, forsok, status) VALUES (?, ?, ?, ?, ?, 0, 'aktiv')`, kodId, ehash, hash, nu, nu + KOD_S);
    return { skicka: true };
  }
  // Hitta och pröva en kod. Fel kod räknar upp; vid KOD_FORSOK spärras koden. forbruka=true löser in atomiskt (exakt en vinnare).
  // Indata: { id } (länk) eller { ehash } (e-post + kod); kandidater = hash(kodId:kod) beräknad i workern för varje kandidat-id.
  hittaRad(d) {
    if (d.id !== undefined) return KODID_RE.test(String(d.id)) ? forsta(this.sql.exec(`SELECT * FROM koder WHERE id = ?`, d.id)) : null;
    if (/^[0-9a-f]{64}$/.test(String(d.ehash))) return forsta(this.sql.exec(`SELECT * FROM koder WHERE ehash = ? AND status = 'aktiv' ORDER BY skapad DESC LIMIT 1`, d.ehash));
    return null;
  }
  prova(d) { return this.provaEllerLos(d, false); }
  los(d) { return this.provaEllerLos(d, true); }
  provaEllerLos(d, forbruka) {
    const rad = this.hittaRad(d); if (!rad) return { ok: false };
    if (rad.status !== "aktiv" || rad.utgar <= d.nu) return { ok: false };
    if (typeof d.hash !== "string" || !d.hash) return { ok: false, id: rad.id }; // workern frågar först efter id för att kunna räkna hashen
    if (!timingSafeEqual(d.hash, rad.hash)) {
      const n = rad.forsok + 1;
      this.sql.exec(`UPDATE koder SET forsok = ?, status = ? WHERE id = ?`, n, n >= KOD_FORSOK ? "sparrad" : "aktiv", rad.id);
      return { ok: false, sparrad: n >= KOD_FORSOK };
    }
    const k = forsta(this.sql.exec(`SELECT konto_id FROM konton WHERE ehash = ?`, rad.ehash));
    if (!k) return { ok: false };
    if (forbruka) this.sql.exec(`UPDATE koder SET status = 'anvand' WHERE id = ? AND status = 'aktiv'`, rad.id);
    return { ok: true, kontoId: k.konto_id };
  }
  // Rätt för ett konto (sessionen avgör inte rätten). agareEhash = HMAC(PRO_OWNER_EMAIL), beräknad i workern.
  ratt({ nu, kontoId, agareEhash }) {
    const k = forsta(this.sql.exec(`SELECT ehash, kund FROM konton WHERE konto_id = ?`, String(kontoId)));
    if (!k) return { finns: false };
    const t = forsta(this.sql.exec(`SELECT slut, aterkallad FROM testbevis WHERE ehash = ?`, k.ehash));
    return { finns: true, agare: typeof agareEhash === "string" && agareEhash.length === 64 && timingSafeEqual(k.ehash, agareEhash),
      test: t && !t.aterkallad ? { slut: t.slut, aktiv: t.slut > nu } : null, kund: k.kund || null };
  }
  // Internt (inget publikt anrop i K1; ägarytan kommer i K5). slut=0 eller aterkalla=true återkallar.
  testbevis({ nu, ehash, slut, aterkalla }) {
    if (!/^[0-9a-f]{64}$/.test(String(ehash))) return { ok: false };
    if (aterkalla) { this.sql.exec(`UPDATE testbevis SET aterkallad = ? WHERE ehash = ?`, nu, ehash); return { ok: true }; }
    if (!(Number.isSafeInteger(slut) && slut > nu)) return { ok: false };
    this.sql.exec(`INSERT INTO testbevis (ehash, slut, aterkallad, satt) VALUES (?, ?, NULL, ?) ON CONFLICT(ehash) DO UPDATE SET slut = excluded.slut, aterkallad = NULL, satt = excluded.satt`, ehash, slut, nu);
    return { ok: true };
  }
  koppla({ kontoId, kund }) { // köpkoppling konto → Stripe-kund (internt i K1)
    if (!KONTO_RE.test(String(kontoId)) || !CUS_RE.test(String(kund))) return { ok: false };
    this.sql.exec(`UPDATE konton SET kund = ? WHERE konto_id = ?`, kund, kontoId);
    return { ok: true };
  }
  // Prenumerationens login-nonce (flyttad från KV): spara och atomisk inlösen (läs, jämför och radera i samma transaktion).
  nonceSpara({ nu, n, kund, ttl }) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(n)) || !CUS_RE.test(String(kund)) || !(Number.isSafeInteger(ttl) && ttl > 0)) return { ok: false };
    this.gallra(nu);
    this.sql.exec(`INSERT INTO nonce (n, kund, utgar) VALUES (?, ?, ?) ON CONFLICT(n) DO NOTHING`, n, kund, nu + ttl);
    return { ok: true };
  }
  nonceLos({ nu, n, kund }) {
    const r = forsta(this.sql.exec(`SELECT kund, utgar FROM nonce WHERE n = ?`, String(n)));
    if (!r || r.utgar <= nu || r.kund !== kund) return { ok: false };
    this.sql.exec(`DELETE FROM nonce WHERE n = ?`, String(n));
    return { ok: true };
  }
}

// ---------- ProKonto: enheter och sessioner (ett objekt per konto) ----------
export class ProKonto {
  constructor(state, env) {
    this.state = state; this.env = env; this.storage = state.storage;
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS enheter (id TEXT PRIMARY KEY, sess TEXT NOT NULL UNIQUE, namn TEXT NOT NULL, skapad INTEGER NOT NULL, senast INTEGER NOT NULL, utloggad INTEGER)`);
    this.fetch = rpc(this, {
      aktiva: (d) => this.aktiva(d), skapa: (d) => this.skapa(d), kolla: (d) => this.kolla(d), lista: (d) => this.lista(d), logga_ut: (d) => this.loggaUt(d),
    });
  }
  get sql() { return this.storage.sql; }
  aktivaRader(nu) { return rader(this.sql.exec(`SELECT id, namn, senast FROM enheter WHERE utloggad IS NULL AND senast > ? ORDER BY senast DESC`, nu - SESSION_S)); }
  aktiva({ nu }) { const l = this.aktivaRader(nu); return { antal: l.length, enheter: l }; }
  skapa({ nu, sess, namn }) {
    if (!/^[0-9a-f]{64}$/.test(String(sess))) return { ok: false };
    const l = this.aktivaRader(nu);
    if (l.length >= MAX_ENHETER) return { ok: false, enhetsgrans: true, enheter: l };
    const id = "e_" + randomHex(8);
    this.sql.exec(`INSERT INTO enheter (id, sess, namn, skapad, senast, utloggad) VALUES (?, ?, ?, ?, ?, NULL)`, id, sess, String(namn || "Okänd enhet").slice(0, 40), nu, nu);
    this.sql.exec(`DELETE FROM enheter WHERE (utloggad IS NOT NULL AND utloggad < ?) OR senast < ?`, nu - SESSION_S, nu - 2 * SESSION_S); // gallring
    return { ok: true, id };
  }
  // Giltig = finns, inte utloggad och senast + 90 d > nu. Förlängs vid användning, högst en skrivning per timme.
  kolla({ nu, sess }) {
    const r = forsta(this.sql.exec(`SELECT id, senast, utloggad FROM enheter WHERE sess = ?`, String(sess)));
    if (!r || r.utloggad !== null || r.senast + SESSION_S <= nu) return { ok: false };
    let forlangd = false;
    if (nu - r.senast >= FORLANG_S) { this.sql.exec(`UPDATE enheter SET senast = ? WHERE id = ?`, nu, r.id); forlangd = true; }
    return { ok: true, id: r.id, forlangd };
  }
  lista({ nu }) { return { enheter: this.aktivaRader(nu) }; }
  loggaUt({ nu, id }) {
    if (!ENHET_RE.test(String(id))) return { ok: false };
    const r = forsta(this.sql.exec(`SELECT utloggad FROM enheter WHERE id = ?`, id));
    if (!r) return { ok: false };
    if (r.utloggad === null) this.sql.exec(`UPDATE enheter SET utloggad = ? WHERE id = ?`, nu, id);
    return { ok: true };
  }
}

// ---------- rutter /pro/konto/* ----------
const lasKropp = async (request, max = 2048) => {
  const raw = await request.text(); if (new TextEncoder().encode(raw).length > max) return null;
  try { const o = JSON.parse(raw); return o && typeof o === "object" && !Array.isArray(o) ? o : null; } catch { return null; }
};
const enhetNamn = (b, request) => {
  const n = b && typeof b.namn === "string" ? b.namn.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 40) : "";
  if (n) return n;
  const ua = request.headers.get("User-Agent") || "";
  const os = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return [br, os].filter(Boolean).join(" på ") || "Okänd enhet";
};
const sajt = (env) => { const u = String(env.PRO_SITE_URL || "https://stahledigital.se"); return (/^https:\/\/[^\s"'<>]+$/.test(u) ? u : "https://stahledigital.se").replace(/\/$/, ""); };

async function skickaKod(env, { till, kodId, kod }) {
  const m = mailHttpConfig(env); if (!m.on) return { ok: false, kod: "mejl_av" };
  if (!validMailTo(till)) return { ok: false, kod: "ogiltig_mottagare" };
  const from = String(env.PRO_MAIL_FROM || "").trim() || m.from.replace(/^[^<]*</, `${MEJL.avsandare_namn} <`);
  const lank = `${sajt(env)}/verkstaden/materialraknaren/offert#pro-konto=${kodId}.${kod}`; // fragment: når aldrig någon serverlogg eller Referer
  const ut = await sendViaHttp(env, { req: buildMailRequest({ from, to: till, subject: KONTO_TEXT.kod_amne, text: fyll(KONTO_TEXT.kod, { kod, lank }) }), idemKey: `pro-konto-kod-${kodId}` });
  return ut.ok ? { ok: true } : { ok: false, kod: ut.code || ut.kind };
}
const dagstak = (env) => (/^[1-9]\d{0,4}$/.test(String(env.PRO_MAIL_DAY_CAP || "")) ? Number(env.PRO_MAIL_DAY_CAP) : 100); // samma tolkning som pro_routes

// Kod-/länkindata → { id } eller { ehash } plus kod. Länken bär "kodId.kod" (fragmentet) som klienten skickar som { lank }.
async function kodIndata(env, b) {
  if (!b) return null;
  if (typeof b.lank === "string") { const m = /^([0-9a-f]{32})\.(\d{6})$/.exec(b.lank.trim()); return m ? { sok: { id: m[1] }, kod: m[2] } : null; }
  const kod = typeof b.kod === "string" ? b.kod.replace(/\s/g, "") : "";
  if (!KOD_RE.test(kod) || !validMailTo(normEpost(b.epost))) return null;
  return { sok: { ehash: await epostHash(env, b.epost) }, kod };
}
// Pröva (och eventuellt lösa in) en kod: först id-uppslag utan hash, sedan hash(kodId:kod). Okänd adress/id ger samma svar som fel kod.
async function provaKod(env, ind, nu, forbruka) {
  const forst = await register(env, "prova", { nu, ...ind.sok });
  if (!forst || typeof forst.id !== "string") return { ok: false };
  return register(env, forbruka ? "los" : "prova", { nu, id: forst.id, hash: await kodHash(env, forst.id, ind.kod) });
}

async function aktivSession(env, request, nu) { // → { kontoId, enhet, forlangd, varde } eller null
  const varde = lasCookie(request); const s = varde && (await lasSessionsvarde(env, varde));
  if (!s) return null;
  const r = await konto(env, s.kontoId, "kolla", { nu, sess: await sessHash(s.sid) });
  return r && r.ok ? { kontoId: s.kontoId, enhet: r.id, forlangd: !!r.forlangd, varde } : null;
}

// Rätt (separat från sessionen). aktivPren injiceras från pro_routes (befintlig funktion) för att undvika cirkelberoende.
async function rattFor(env, kontoId, nu, { aktivPren, proMode, fetchImpl }) {
  const agare = validMailTo(normEpost(env.PRO_OWNER_EMAIL)) ? await epostHash(env, env.PRO_OWNER_EMAIL) : null;
  const r = await register(env, "ratt", { nu, kontoId, agareEhash: agare });
  if (!r || !r.finns) return { roll: "ingen", slut: null };
  if (r.agare) return { roll: "agare", slut: null };
  if (r.test && r.test.aktiv) return { roll: "test", slut: r.test.slut };
  if (r.kund && proMode(env) !== "off" && typeof aktivPren === "function") {
    const sub = await aktivPren(env, r.kund, fetchImpl);
    if (sub) { const p = Number.isInteger(sub.current_period_end) ? sub.current_period_end : (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end) || null; return { roll: "pren", slut: p }; }
  }
  // "projekt" (köpt projekt med synk i 30 d) kopplas i K2 när projektlagringen finns; i K1 finns ingen sådan källa.
  return { roll: "ingen", slut: r.test ? r.test.slut : null };
}

export async function handleKonto(request, env, ctx, { now = () => Date.now(), fetchImpl = fetch, aktivPren = null, proMode = () => "off" } = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/pro/konto/") && url.pathname !== "/pro/konto") return null;
  const origin = request.headers.get("Origin") || "";
  // Grind först: i off rörs varken bindningar, KV, nycklar eller mejl.
  if (kontoLage(env) === "off") return jsonResponse({ status: "stangt" }, 503, cors(origin, env));
  const nu = Math.floor(now() / 1000);
  const svar = (body, status = 200, extra = {}) => jsonResponse(body, status, { "x-robots-tag": "noindex", ...extra });
  const vag = url.pathname.slice("/pro/konto".length) || "/";
  if (request.method === "OPTIONS") return svar({ status: "fel_ursprung" }, 403); // bara samma origin (sajtens proxy, K3): ingen CORS
  if (request.method === "POST" && (!origins(env).includes(origin) || request.headers.get("X-MR-Pro") !== "1")) return svar({ status: "fel_ursprung" }, 403);
  try {
    if (vag === "/kod" && request.method === "POST") {
      const kvitt = svar({ status: "skickat_om_inbjuden" }, 202); // alltid samma svar: ingen kontoupptäckt
      try {
        const b = await lasKropp(request); const epost = normEpost(b && b.epost);
        if (!validMailTo(epost) || !mailHttpConfig(env).on) return kvitt;
        const agareEpost = normEpost(env.PRO_OWNER_EMAIL);
        const kodId = randomHex(16), kod = nyKod();
        const r = await register(env, "kod", { nu, ehash: await epostHash(env, epost), ip: await ipHash(request), agare: validMailTo(agareEpost) && epost === agareEpost,
          kodId, hash: await kodHash(env, kodId, kod), dagstak: dagstak(env) });
        if (r && r.skicka) await skickaKod(env, { till: epost, kodId, kod });
      } catch { /* även vid fel: samma svar */ }
      return kvitt;
    }
    if (vag === "/logga-in" && request.method === "POST") {
      const b = await lasKropp(request); const ind = await kodIndata(env, b);
      if (!ind) return svar({ status: "ogiltig_kod" }, 401);
      const p = await provaKod(env, ind, nu, false);
      if (!p || !p.ok || !KONTO_RE.test(String(p.kontoId))) return svar({ status: "ogiltig_kod" }, 401);
      const akt = await konto(env, p.kontoId, "aktiva", { nu });
      if (akt.antal >= MAX_ENHETER) return svar({ status: "enhetsgrans", max: MAX_ENHETER, enheter: akt.enheter }, 409); // koden förbrukas inte
      const l = await provaKod(env, ind, nu, true); // atomisk inlösen: exakt en vinnare
      if (!l || !l.ok || l.kontoId !== p.kontoId) return svar({ status: "ogiltig_kod" }, 401);
      const { sid, varde } = await skapaSessionsvarde(env, l.kontoId);
      const s = await konto(env, l.kontoId, "skapa", { nu, sess: await sessHash(sid), namn: enhetNamn(b, request) });
      if (!s.ok) return svar({ status: "enhetsgrans", max: MAX_ENHETER, enheter: s.enheter || [] }, 409); // kapplöpning: koden är förbrukad, begär en ny
      return svar({ status: "inloggad", enhet: s.id }, 200, { "set-cookie": satCookie(varde) });
    }
    // Logga ut vald enhet: med kontots session, eller (vid enhetsgränsen) med den ännu oinlösta koden som bevis.
    let m;
    if ((m = /^\/enheter\/([^/]+)\/logga-ut$/.exec(vag)) && request.method === "POST") {
      const id = m[1]; if (!ENHET_RE.test(id)) return svar({ status: "hittas_inte" }, 404);
      let kontoId = null;
      const s = await aktivSession(env, request, nu);
      if (s) kontoId = s.kontoId;
      else { const ind = await kodIndata(env, await lasKropp(request)); const p = ind && (await provaKod(env, ind, nu, false)); if (p && p.ok) kontoId = p.kontoId; }
      if (!kontoId) return svar({ status: "ej_inloggad" }, 401);
      const r = await konto(env, kontoId, "logga_ut", { nu, id }); // id söks bara i det egna kontots objekt
      if (!r.ok) return svar({ status: "hittas_inte" }, 404);
      return svar({ status: "utloggad", enhet: id, denna: !!(s && s.enhet === id) }, 200, s && s.enhet === id ? { "set-cookie": rensaCookie() } : {});
    }
    if (vag === "/logga-ut" && request.method === "POST") {
      const s = await aktivSession(env, request, nu);
      if (s) await konto(env, s.kontoId, "logga_ut", { nu, id: s.enhet });
      return svar({ status: "utloggad" }, 200, { "set-cookie": rensaCookie() });
    }
    if (vag === "/jag" && request.method === "GET") {
      const s = await aktivSession(env, request, nu);
      if (!s) return svar({ status: "ej_inloggad" }, 401);
      const [ratt, lista] = await Promise.all([rattFor(env, s.kontoId, nu, { aktivPren, proMode, fetchImpl }), konto(env, s.kontoId, "lista", { nu })]);
      const lasSlut = ratt.roll === "agare" ? null : ratt.slut ? ratt.slut + LAS_DAGAR * DAG : null;
      return svar({ status: "ok", konto: s.kontoId, enhet: s.enhet, roll: ratt.roll, ratt_slut: ratt.slut, las_slut: lasSlut,
        enheter: lista.enheter.map((e) => ({ ...e, denna: e.id === s.enhet })) }, 200, s.forlangd ? { "set-cookie": satCookie(s.varde) } : {});
    }
    return svar({ status: "okand_rutt" }, 404);
  } catch (e) {
    const st = e && e.status === 503 ? 503 : 502;
    return svar({ status: st === 503 ? "konfiguration" : "tillfalligt_fel" }, st);
  }
}
