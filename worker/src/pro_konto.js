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
//
// KONTO-SYNK K2 (Donatello 2026-10-18, bas K1 1c04f32): synk-API i ProKonto (projekt med rev och gravstenar, export, radering,
// ägarens PITR), läsperiod och köpt projekt, avisering och radering via befintlig scheduled(), plus K1-härdning:
//   A1 tak per adress och dygn (10 koder, 15 felförsök över alla koder → spärr 24 h; kod svarar alltid samma 202),
//   A2 kodmejlet (och hela registerarbetet) i ctx.waitUntil, så att svarstiden inte skiljer inbjuden från okänd adress,
//   A3 ALLA svar under /pro/konto/* (även off-503, fel, 401/403/409) har X-Robots-Tag: noindex, nofollow och Cache-Control: no-store,
//      och ingen Access-Control-*-header,
//   A4 EU-jurisdiktion för DO-id:n bakom var PRO_DO_JURISDIKTION="eu": lokal workerd svarar "Jurisdiction restrictions are not
//      implemented in workerd" (provat 2026-10-18), så den provas i node-dubbeln och live. K6 slår på den i wrangler.toml (se nr()).
import { hmacSha256Hex, timingSafeEqual, randomToken, randomHex, sha256Hex, jsonResponse } from "./compare_util.js";
import { mailHttpConfig, buildMailRequest, sendViaHttp, validMailTo } from "./compare_mailer.js";
import { MEJL } from "./pro_texter.js";
import { sellerInfo, sellerLines } from "./compare_config.js";
import { readRoofProject } from "./mr_project2/P4_PROJEKT/pro-projekt-v2.mjs";
import { INTEGRATION_METODER, integrationRoute } from "./pro_integration.js"; // D7.2 (MR-FORTNOX-SPIRIS-20261023-01)

const DAG = 86400;
export const KOD_S = 10 * 60, KOD_FORSOK = 5;
export const SESSION_S = 90 * DAG, FORLANG_S = 3600, MAX_ENHETER = 3;
const INT_STATE_S = 600; // D7.2: OAuth-state lever högst 10 min (pro_integration.js STATE_S)
export const GRANS_EPOST = 3, GRANS_EPOST_S = 15 * 60, GRANS_IP = 10, GRANS_IP_S = 3600;
export const LAS_DAGAR = 90;
// K2
export const KODER_DAG = 10, FEL_DAG = 15, SPARR_S = DAG;                      // A1
// PRO-PRIS-01 (Claude Code 2026-10-21): ett dokument per konto med byggarens egna artikelpriser (exkl. moms), rev/If-Match som projekt.
export const AP_FORMAT = "materialraknaren-pro-artikelpriser", AP_MAX_BYTE = 256 * 1024, AP_MAX_POSTER = 1000;
export const PROJ_MAX_BYTE = 256 * 1024, PROJ_MAX_RADER = 500, PROJ_MAX_ANTAL = 50; // samma gränser som P4 (pro-projekt.mjs MAX_BYTE/MAX_RADER/MAX_PROJEKT)
export const GRAV_S = 90 * DAG, AVISERA_S = LAS_DAGAR * DAG, RADERA_EFTER_AVISERING_S = 14 * DAG, KOP_PROJEKT_S = 30 * DAG;
export const SCHEMA_MAX = 25; // högst så många konton per steg och cron-körning
// K5: testplatser. Anders 2026-10-20: en fjärde pilotplats; 2026-10-23 (gmo-api-v17): en femte. Samma 30/90 dagar utan kort.
export const MAX_TESTPLATSER = 5, TEST_STD_S = 30 * DAG, TEST_MAX_S = 90 * DAG;
const PROJ_RE = /^p_[0-9a-f]{32}$/, P4_FORMAT = "materialraknaren-pro-projekt";
function projektVersion(data, id) {
  try { const p = JSON.parse(data); return p && p.format === P4_FORMAT && p.projektId === id && [1, 2].includes(p.version) ? p.version : null; }
  catch { return null; }
}
export const COOKIE = "__Host-mrpro";
const KONTO_RE = /^k_[0-9a-f]{32}$/, SESS_RE = /^[A-Za-z0-9_-]{22}$/, ENHET_RE = /^e_[0-9a-f]{16}$/, KODID_RE = /^[0-9a-f]{32}$/, KOD_RE = /^\d{6}$/, CUS_RE = /^cus_[A-Za-z0-9]{6,}$/;
const REGISTER_NAMN = "register:v1";

// Systemtexter (Dons, inte S4g). Zlata ersätter i K5.
// K6: kodmejlets ämne är Zlatas login.mejl_amne ordagrant (STOD/KONTO_TEXTER/strings.sv.json 49f3ef4e…). Brödtexten är oförändrad.
export const KONTO_TEXT = Object.freeze({
  kod_amne: "Din inloggningskod till Materialräknaren",
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
  // K2: avisering 90 d efter att rätten upphört (Dons systemtext, Zlata ersätter i K5).
  avisering_amne: "Ditt konto på Materialräknaren PRO raderas om 14 dagar",
  avisering: [
    "Hej!",
    "",
    "Din rätt till Materialräknaren PRO upphörde för mer än 90 dagar sedan. Ditt konto och dina sparade projekt raderas därför om 14 dagar, {datum}.",
    "",
    "Vill du spara projekten kan du logga in och exportera dem före dess:",
    "{lank}",
    "",
    "Förnyar du PRO före {datum} raderas ingenting.",
    "",
    "Ståhle Digital",
  ].join("\n"),
  // K5: testinbjudan, ordagrant Zlatas test.mejl_amne och test.mejl ur STOD/KONTO_TEXTER/strings.sv.json (sha 49f3ef4e…).
  // Gate test_adresser_anders: skickas bara när PRO_TEST_MEJL="på" (förval av). Gaten kunddata_grind står i själva texten.
  test_amne: "Du är inbjuden att testa Materialräknaren PRO i {dagar} dagar",
  test: "Hej,\n\ndu är inbjuden att testa Materialräknaren PRO i {dagar} dagar, till och med {slutdatum}.\n\nTestplatsen kräver inget kort och ingen betalning dras när den tar slut.\n\nSå här kommer du igång:\n1. Öppna {lank}\n2. Skriv den här e-postadressen och be om en kod.\n3. Skriv koden eller öppna länken i mejlet. Du loggas in utan lösenord.\n\nDu kan vara inloggad på högst 3 enheter. Jobben du sparar ligger i ditt konto och följer med mellan enheterna.\n\nAnvänd påhittade kunduppgifter under testet. Riktiga kunduppgifter ska in först när våra villkor och vår integritetstext är publicerade.\n\nFrågor: {kontakt}\n\n{saljare}",
});
const fyll = (t, v) => t.replace(/\{(\w+)\}/g, (_, k) => (k in v ? String(v[k]) : ""));

export function kontoLage(env) { return env && env.PRO_KONTO === "inbjudna" ? "inbjudna" : "off"; } // allt annat än exakt "inbjudna" = off (fail closed)
function origins(env) { return String(env.PRO_ALLOWED_ORIGIN || "https://stahledigital.se").split(",").map((s) => s.trim()).filter(Boolean); }
// Samma headers som pro_routes.cors(): ett off-svar för /pro/konto/* blir byte-likt basens /pro/*-svar i off.
function cors(origin, env) {
  const ok = origins(env).includes(origin);
  return ok ? { "access-control-allow-origin": origin, vary: "Origin", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600" } : { vary: "Origin" };
}
// A3: varje svar under /pro/konto/* (även off, fel, 401/403/409 och oväntade undantag) får dessa headers och ingen CORS.
const BORT = ["access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers", "access-control-allow-credentials", "access-control-expose-headers", "access-control-max-age", "vary"];
export function harda(resp) {
  const h = new Headers(resp.headers);
  for (const k of BORT) h.delete(k);
  h.set("x-robots-tag", "noindex, nofollow"); h.set("cache-control", "no-store");
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
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
// A4 (K2 förberedd, K6 påslagen i wrangler.toml): PRO_DO_JURISDIKTION="eu" ger subnamnrymd jurisdiction("eu"). Saknas eller kastar metoden
// → 503 (fail closed), aldrig tyst utan EU. ALL åtkomst till PRO_REGISTER och PRO_KONTON går hit (provat i pro_konto_k6.test.mjs).
// OBS: samma namn ger ANDRA id:n med jurisdiktion, så valet ska göras innan första objektet skapas live (K6). Inga data finns i off.
function nr(env, ns, namn) {
  if (!ns || typeof ns.idFromName !== "function") { const e = new Error(namn + " saknas"); e.status = 503; throw e; }
  const j = env.PRO_DO_JURISDIKTION;
  if (j === undefined || j === null || j === "") return ns;
  if (j !== "eu" || typeof ns.jurisdiction !== "function") { const e = new Error("jurisdiktion stöds inte"); e.status = 503; throw e; }
  // K6: lokal workerd har metoden men kastar ("Jurisdiction restrictions are not implemented in workerd"). Också det är 503, aldrig 502
  // och aldrig en tyst återgång till id:n utan jurisdiktion.
  let eu; try { eu = ns.jurisdiction("eu"); } catch { eu = null; }
  if (!eu || typeof eu.idFromName !== "function" || typeof eu.get !== "function") { const e = new Error("jurisdiktion stöds inte"); e.status = 503; throw e; }
  return eu;
}
function registerStub(env) {
  const ns = nr(env, env.PRO_REGISTER, "register");
  return ns.get(ns.idFromName(REGISTER_NAMN));
}
function kontoStub(env, kontoId) {
  if (!KONTO_RE.test(String(kontoId))) { const e = new Error("ogiltigt konto"); e.status = 502; throw e; }
  const ns = nr(env, env.PRO_KONTON, "konton");
  return ns.get(ns.idFromName("k:" + kontoId));
}
export async function register(env, op, data) {
  return svarJson(await registerStub(env).fetch(`https://pro-register/${op}`, { method: "POST", body: JSON.stringify(data) }));
}
async function konto(env, kontoId, op, data) {
  return svarJson(await kontoStub(env, kontoId).fetch(`https://pro-konto/${op}`, { method: "POST", body: JSON.stringify({ ...data, kontoId }) }));
}

// Gemensam RPC-ram för båda klasserna: varje operation körs i EN transactionSync (allt eller inget), DO:n är enda skrivare.
// K2: asynkrona operationer (deleteAll, PITR) ligger i `asyncOps` och körs utanför transactionSync.
// K5: `fore` (bara ProKonto) körs före VARJE operation: kontrollen efter PITR (alla enheter loggas ut i ett återställt objekt).
// Kastar den svarar objektet 500 och ingen operation körs (fail closed).
function rpc(self, ops, asyncOps = {}, fore = null) {
  return async (request) => {
    const op = new URL(request.url).pathname.slice(1);
    if (request.method === "POST" && Object.prototype.hasOwnProperty.call(asyncOps, op)) {
      let d; try { d = await request.json(); } catch { return Response.json({ fel: "ogiltig_kropp" }, { status: 400 }); }
      if (!d || typeof d !== "object" || !Number.isSafeInteger(d.nu) || d.nu <= 0) return Response.json({ fel: "ogiltig_kropp" }, { status: 400 });
      try { if (fore) await fore(d); return Response.json(await asyncOps[op](d)); } catch (e) { return Response.json({ fel: "lagringsfel", orsak: String((e && e.message) || e).slice(0, 120) }, { status: 500 }); }
    }
    if (request.method !== "POST" || !Object.prototype.hasOwnProperty.call(ops, op)) return Response.json({ fel: "okand_op" }, { status: 404 });
    let d; try { d = await request.json(); } catch { return Response.json({ fel: "ogiltig_kropp" }, { status: 400 }); }
    if (!d || typeof d !== "object" || !Number.isSafeInteger(d.nu) || d.nu <= 0) return Response.json({ fel: "ogiltig_kropp" }, { status: 400 });
    try { if (fore) await fore(d); } catch { return Response.json({ fel: "lagringsfel" }, { status: 500 }); }
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
    // K2 (nya tabeller i stället för ALTER, så att K1-schemat aldrig behöver ändras)
    sql.exec(`CREATE TABLE IF NOT EXISTS adress (ehash TEXT PRIMARY KEY, fel INTEGER NOT NULL, fel_start INTEGER NOT NULL, sparr_till INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS konto_status (konto_id TEXT PRIMARY KEY, ratt_slut INTEGER, aviserad INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS kop_projekt (konto_id TEXT NOT NULL, projekt_id TEXT NOT NULL, slut INTEGER NOT NULL, PRIMARY KEY (konto_id, projekt_id))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS raderade (konto_id TEXT PRIMARY KEY, tid INTEGER NOT NULL, rensad INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS agarlogg (id INTEGER PRIMARY KEY AUTOINCREMENT, tid INTEGER NOT NULL, handling TEXT NOT NULL, konto_id TEXT, detalj TEXT)`);
    // K5: ägarens testplatser (etikett och MASKAD adress för listan; e-posten finns bara som ehash) och PITR-markering (K2-fynd 2).
    sql.exec(`CREATE TABLE IF NOT EXISTS testplatser (id TEXT PRIMARY KEY, ehash TEXT NOT NULL UNIQUE, etikett TEXT NOT NULL, maskad TEXT NOT NULL, skapad INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS pitr_utlogg (konto_id TEXT PRIMARY KEY, tid INTEGER NOT NULL, klar INTEGER)`);
    // Orderbaserad köpkoppling. Nya tabeller, ingen ändring av DO-migrationsgränsen v5.
    sql.exec(`CREATE TABLE IF NOT EXISTS pro_kop (mode TEXT NOT NULL, session TEXT NOT NULL, order_ref TEXT NOT NULL, konto_id TEXT, kund TEXT, plan TEXT NOT NULL, projekt_id TEXT, pren_id TEXT, betalning_id TEXT, skapad INTEGER NOT NULL, slut INTEGER, aterkallad INTEGER, borttagen INTEGER, PRIMARY KEY(mode, session), UNIQUE(mode, order_ref))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS pro_kop_sparr (mode TEXT NOT NULL, typ TEXT NOT NULL, id TEXT NOT NULL, tid INTEGER NOT NULL, PRIMARY KEY(mode,typ,id))`);
    sql.exec(`CREATE INDEX IF NOT EXISTS pro_kop_konto ON pro_kop(konto_id, mode)`);
    this.fetch = rpc(this, {
      pren_faktura_sparr: (d) => { if (d.faktura) this.sql.exec(`INSERT INTO pro_kop_sparr(mode,typ,id,tid) VALUES(?,?,?,?) ON CONFLICT(mode,typ,id) DO NOTHING`,d.mode,"faktura:"+d.prenId,d.faktura,d.nu); return {fakturor:rader(this.sql.exec(`SELECT id FROM pro_kop_sparr WHERE mode=? AND typ=?`,d.mode,"faktura:"+d.prenId)).map(r=>r.id)}; },
      kop_betalning: (d) => ({finns:!!forsta(this.sql.exec(`SELECT 1 AS x FROM pro_kop WHERE mode = ? AND betalning_id = ? LIMIT 1`,d.mode || "",d.betalningId || ""))}), kop_registrera: (d) => this.kopRegistrera(d), kop_aterkalla: (d) => this.kopAterkalla(d),
      tp_lista: (d) => this.tpLista(d), tp_inbjud: (d) => this.tpInbjud(d), tp_forlang: (d) => this.tpForlang(d), tp_aterkalla: (d) => this.tpAterkalla(d),
      pitr_planera: (d) => this.pitrPlanera(d), pitr_status: (d) => this.pitrStatus(d), pitr_klar: (d) => this.pitrKlar(d),
      kod: (d) => this.kod(d), prova: (d) => this.prova(d), los: (d) => this.los(d), ratt: (d) => this.ratt(d),
      testbevis: (d) => this.testbevis(d), koppla: (d) => this.koppla(d), nonce_spara: (d) => this.nonceSpara(d), nonce_los: (d) => this.nonceLos(d),
      notera_pren: (d) => this.noteraPren(d), koppla_projekt: (d) => this.kopplaProjekt(d), forfallna: (d) => this.forfallna(d),
      markera_aviserad: (d) => this.markeraAviserad(d), radera: (d) => this.radera(d), orensade: (d) => this.orensade(d),
      markera_rensad: (d) => this.markeraRensad(d), raderat: (d) => this.raderat(d), pitr_kontroll: (d) => this.pitrKontroll(d), logg: (d) => this.logg(d),
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
    return !!(t && !t.aterkallad && t.slut > nu) || !!forsta(this.sql.exec(`SELECT 1 AS x FROM konton k JOIN pro_kop p ON p.konto_id = k.konto_id WHERE k.ehash = ? AND p.borttagen IS NULL LIMIT 1`, ehash));
  }
  // Begär kod. ip-gränsen gäller alla anrop; övriga gränser bara när ett mejl faktiskt ska gå. → { skicka, orsak }
  kod({ nu, ehash, ip, agare, kodId, hash, dagstak }) {
    if (!/^[0-9a-f]{64}$/.test(String(ehash)) || !/^[0-9a-f]{32}$/.test(String(ip)) || !KODID_RE.test(String(kodId)) || !/^[0-9a-f]{64}$/.test(String(hash)) || !(Number.isSafeInteger(dagstak) && dagstak > 0)) return { skicka: false, orsak: "ogiltig" };
    this.gallra(nu);
    if (this.over(`ip:${ip}`, GRANS_IP_S, nu, GRANS_IP)) return { skicka: false, orsak: "ip" };
    if (!this.inbjuden(ehash, !!agare, nu)) return { skicka: false, orsak: "ej_inbjuden" };
    if (this.sparrad(ehash, nu)) return { skicka: false, orsak: "sparr" }; // A1: 15 fel/dygn → 24 h spärr
    if (forsta(this.sql.exec(`SELECT COUNT(*) AS n FROM koder WHERE ehash = ? AND skapad > ?`, ehash, nu - DAG)).n >= KODER_DAG) return { skicka: false, orsak: "epost_dag" }; // A1: glidande 24 h
    if (this.over(`e:${ehash}`, GRANS_EPOST_S, nu, GRANS_EPOST)) return { skicka: false, orsak: "epost" };
    if (this.over("dag", DAG, nu, dagstak)) return { skicka: false, orsak: "dag" };
    let k = forsta(this.sql.exec(`SELECT konto_id FROM konton WHERE ehash = ?`, ehash));
    if (!k) { k = { konto_id: "k_" + randomHex(16) }; this.sql.exec(`INSERT INTO konton (ehash, konto_id, skapad) VALUES (?, ?, ?)`, ehash, k.konto_id, nu); }
    this.sql.exec(`UPDATE koder SET status = 'ersatt' WHERE ehash = ? AND status = 'aktiv'`, ehash); // senaste koden gäller
    this.sql.exec(`INSERT INTO koder (id, ehash, hash, skapad, utgar, forsok, status) VALUES (?, ?, ?, ?, ?, 0, 'aktiv')`, kodId, ehash, hash, nu, nu + KOD_S);
    return { skicka: true, kontoId: k.konto_id }; // kontoId stannar i workern (e-posten sparas i kontots objekt för avisering), når aldrig klienten
  }
  sparrad(ehash, nu) { const a = forsta(this.sql.exec(`SELECT sparr_till FROM adress WHERE ehash = ?`, ehash)); return !!(a && a.sparr_till && a.sparr_till > nu); }
  // A1: felförsök per adress över ALLA koder, glidande 24 h från första felet i fönstret. Vid FEL_DAG: spärr i SPARR_S.
  raknaFel(ehash, nu) {
    const a = forsta(this.sql.exec(`SELECT fel, fel_start FROM adress WHERE ehash = ?`, ehash));
    const ny = !a || nu - a.fel_start >= DAG;
    const fel = (ny ? 0 : a.fel) + 1, start = ny ? nu : a.fel_start;
    const sparr = fel >= FEL_DAG ? nu + SPARR_S : null;
    this.sql.exec(`INSERT INTO adress (ehash, fel, fel_start, sparr_till) VALUES (?, ?, ?, ?) ON CONFLICT(ehash) DO UPDATE SET fel = excluded.fel, fel_start = excluded.fel_start, sparr_till = COALESCE(excluded.sparr_till, adress.sparr_till)`, ehash, sparr ? 0 : fel, sparr ? nu : start, sparr);
    return !!sparr;
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
    if (this.sparrad(rad.ehash, d.nu)) return { ok: false, sparrad: true }; // A1: adressen spärrad, även rätt kod nekas
    if (typeof d.hash !== "string" || !d.hash) return { ok: false, id: rad.id }; // workern frågar först efter id för att kunna räkna hashen
    if (!timingSafeEqual(d.hash, rad.hash)) {
      const n = rad.forsok + 1;
      this.sql.exec(`UPDATE koder SET forsok = ?, status = ? WHERE id = ?`, n, n >= KOD_FORSOK ? "sparrad" : "aktiv", rad.id);
      const adressSparr = this.raknaFel(rad.ehash, d.nu);
      return { ok: false, sparrad: n >= KOD_FORSOK || adressSparr };
    }
    const k = forsta(this.sql.exec(`SELECT konto_id FROM konton WHERE ehash = ?`, rad.ehash));
    if (!k) return { ok: false };
    if (forbruka) this.sql.exec(`UPDATE koder SET status = 'anvand' WHERE id = ? AND status = 'aktiv'`, rad.id);
    return { ok: true, kontoId: k.konto_id };
  }
  // Rätt för ett konto (sessionen avgör inte rätten). agareEhash = HMAC(PRO_OWNER_EMAIL), beräknad i workern.
  // K2: även köpta projekt, senast kända slut på rätt (för läsperioden) och avisering. En aktiv rätt nollställer en avisering.
  ratt({ nu, kontoId, agareEhash, mode }) {
    const k = forsta(this.sql.exec(`SELECT ehash, kund, skapad FROM konton WHERE konto_id = ?`, String(kontoId)));
    if (!k) return { finns: false };
    const t = forsta(this.sql.exec(`SELECT slut, aterkallad FROM testbevis WHERE ehash = ?`, k.ehash));
    const agare = typeof agareEhash === "string" && agareEhash.length === 64 && timingSafeEqual(k.ehash, agareEhash);
    const kop = rader(this.sql.exec(`SELECT order_ref, kund, plan, projekt_id, pren_id, skapad, slut, aterkallad FROM pro_kop WHERE konto_id = ? AND mode = ? AND borttagen IS NULL ORDER BY skapad DESC`, kontoId, mode || "off"));
    const kp = [...rader(this.sql.exec(`SELECT projekt_id, slut FROM kop_projekt WHERE konto_id = ? ORDER BY slut DESC`, kontoId)), ...kop.filter(p => p.plan === "projekt").map(p => ({projekt_id:p.projekt_id, slut:p.aterkallad ? Math.min(p.slut,p.aterkallad) : p.slut, aktiv:!p.aterkallad}))].sort((a,b) => b.slut-a.slut);
    const st = forsta(this.sql.exec(`SELECT ratt_slut, aviserad FROM konto_status WHERE konto_id = ?`, kontoId)) || { ratt_slut: null, aviserad: null };
    const test = t && !t.aterkallad ? { slut: t.slut, aktiv: t.slut > nu } : null;
    const projekt = { aktiva: kp.filter((r) => r.slut > nu && r.aktiv !== false).map((r) => r.projekt_id), slut: kp.length ? kp[0].slut : null };
    const senast = this.senastSlut(k, t, kp, st);
    if ((agare || (test && test.aktiv) || projekt.aktiva.length) && st.aviserad) this.sql.exec(`UPDATE konto_status SET aviserad = NULL WHERE konto_id = ?`, kontoId);
    return { finns: true, agare, test, kund: k.kund || null, kop, projekt, senast_slut: senast, aviserad: st.aviserad || null };
  }
  // Endast workerns Stripeverifierade anrop når dessa interna RPC:er. Retur/webhook/cron gör samma atomiska operation.
  kopRegistrera(d) {
    const {nu,mode,session,order,ehash,kund,plan,projektId,prenId,betalningId,skapad,slut} = d;
    if (!["test","live"].includes(mode) || !new RegExp("^cs_"+mode+"_[A-Za-z0-9]{8,}$").test(String(session)) || !/^PRO-[A-HJ-NP-Z2-9]{8}$/.test(String(order)) || !/^[0-9a-f]{64}$/.test(String(ehash)) || !CUS_RE.test(String(kund)) || !["projekt","manad","ar"].includes(plan) || !Number.isSafeInteger(skapad) || skapad <= 0 || skapad > nu || (plan === "projekt" ? !PROJ_RE.test(String(projektId)) || slut !== skapad + KOP_PROJEKT_S : !/^sub_[A-Za-z0-9]{6,}$/.test(String(prenId)))) return {ok:false};
    const fore = forsta(this.sql.exec(`SELECT * FROM pro_kop WHERE mode = ? AND session = ?`,mode,session));
    if (fore) {
      if (fore.borttagen) return {ok:true,raderat:true}; // Återspelad gammal betalning återställer aldrig ett raderat konto.
      const k = forsta(this.sql.exec(`SELECT ehash FROM konton WHERE konto_id = ?`,fore.konto_id));
      return {ok:!!k && k.ehash === ehash && fore.kund === kund && fore.plan === plan && fore.order_ref === order && fore.projekt_id === (projektId || null) && fore.pren_id === (prenId || null) && fore.skapad === skapad, kontoId:fore.konto_id,aterkallad:!!fore.aterkallad};
    }
    let k = forsta(this.sql.exec(`SELECT konto_id FROM konton WHERE ehash = ?`,ehash));
    if (!k) { k = {konto_id:"k_"+randomHex(16)}; this.sql.exec(`INSERT INTO konton(ehash,konto_id,skapad) VALUES(?,?,?)`,ehash,k.konto_id,nu); }
    this.sql.exec(`INSERT INTO pro_kop(mode,session,order_ref,konto_id,kund,plan,projekt_id,pren_id,betalning_id,skapad,slut) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,mode,session,order,k.konto_id,kund,plan,projektId || null,prenId || null,betalningId || null,skapad,slut || null);
    const sparr = forsta(this.sql.exec(`SELECT MIN(tid) AS tid FROM pro_kop_sparr WHERE mode = ? AND ((typ='session' AND id=?) OR (typ='order' AND id=?) OR (typ='betalning' AND id=?))`,mode,session,order,betalningId || ""));
    if (sparr?.tid) this.sql.exec(`UPDATE pro_kop SET aterkallad=? WHERE mode=? AND session=?`,sparr.tid,mode,session);
    return {ok:true,kontoId:k.konto_id,aterkallad:!!sparr?.tid};
  }
  kopAterkalla({nu,mode,session,order,betalningId}) {
    if (!["test","live"].includes(mode) || !(session || order || betalningId)) return {ok:false};
    for (const [typ,id] of [["session",session],["order",order],["betalning",betalningId]]) if (id) this.sql.exec(`INSERT INTO pro_kop_sparr(mode,typ,id,tid) VALUES(?,?,?,?) ON CONFLICT(mode,typ,id) DO NOTHING`,mode,typ,id,nu);
    const fore = rader(this.sql.exec(`SELECT session,order_ref FROM pro_kop WHERE mode = ? AND (session = ? OR order_ref = ? OR betalning_id = ?)`,mode,session || "",order || "",betalningId || ""));
    for (const p of fore) this.sql.exec(`UPDATE pro_kop SET aterkallad = COALESCE(aterkallad,?) WHERE mode = ? AND session = ?`,nu,mode,p.session);
    return {ok:true,antal:fore.length,order:fore.map(p=>p.order_ref)};
  }
  // Senast kända tidpunkt då kontot hade rätt: lagrat pren-slut, testbevis (återkallat räknas till återkallelsen), köpta projekt, annars skapad.
  senastSlut(k, t, kp, st) {
    const c = [st && st.ratt_slut, t ? (t.aterkallad ? Math.min(t.slut, t.aterkallad) : t.slut) : null, kp.length ? kp[0].slut : null].filter((v) => Number.isSafeInteger(v));
    return c.length ? Math.max(...c) : k.skapad;
  }
  noteraPren({ nu, kontoId, slut }) { // aktiv prenumeration sedd: spara periodslut (för läsperioden) och nollställ avisering
    if (!KONTO_RE.test(String(kontoId))) return { ok: false };
    const s = Number.isSafeInteger(slut) && slut > 0 ? slut : nu;
    this.sql.exec(`INSERT INTO konto_status (konto_id, ratt_slut, aviserad) VALUES (?, ?, NULL) ON CONFLICT(konto_id) DO UPDATE SET ratt_slut = MAX(COALESCE(konto_status.ratt_slut, 0), excluded.ratt_slut), aviserad = NULL`, kontoId, s);
    return { ok: true };
  }
  // Köpt projekt: synk för just det projekt-id:t i 30 d. Internt (stub i off; kopplas till köpet när P-C/P-D öppnas).
  kopplaProjekt({ nu, kontoId, projektId, slut }) {
    if (!KONTO_RE.test(String(kontoId)) || !PROJ_RE.test(String(projektId))) return { ok: false };
    if (!forsta(this.sql.exec(`SELECT 1 AS x FROM konton WHERE konto_id = ?`, kontoId))) return { ok: false };
    const s = Number.isSafeInteger(slut) && slut > nu ? slut : nu + KOP_PROJEKT_S;
    this.sql.exec(`INSERT INTO kop_projekt (konto_id, projekt_id, slut) VALUES (?, ?, ?) ON CONFLICT(konto_id, projekt_id) DO UPDATE SET slut = MAX(kop_projekt.slut, excluded.slut)`, kontoId, projektId, s);
    return { ok: true, slut: s };
  }
  // Cron: konton att avisera (senast_slut + 90 d passerat, ingen aktiv rätt, ej aviserade) och att radera (aviserade för minst 14 d sedan).
  // Ägaren hoppas alltid över. Konton med kopplad Stripe-kund hoppas över när betalning är off (rätten kan inte prövas utan Stripe).
  forfallna({ nu, agareEhash, betalning, mode }) {
    const avisera = [], radera = [];
    for (const k of rader(this.sql.exec(`SELECT k.konto_id, k.ehash, k.kund, k.skapad, s.ratt_slut, s.aviserad FROM konton k LEFT JOIN konto_status s ON s.konto_id = k.konto_id`))) {
      if (typeof agareEhash === "string" && agareEhash.length === 64 && timingSafeEqual(k.ehash, agareEhash)) continue;
      if (!betalning && (k.kund || forsta(this.sql.exec(`SELECT 1 AS x FROM pro_kop WHERE konto_id = ? AND borttagen IS NULL AND plan != 'projekt' LIMIT 1`,k.konto_id)))) continue;
      const t = forsta(this.sql.exec(`SELECT slut, aterkallad FROM testbevis WHERE ehash = ?`, k.ehash));
      if (t && !t.aterkallad && t.slut > nu) continue;
      const kp = [...rader(this.sql.exec(`SELECT projekt_id, slut FROM kop_projekt WHERE konto_id = ? ORDER BY slut DESC`, k.konto_id)), ...rader(this.sql.exec(`SELECT projekt_id, CASE WHEN aterkallad IS NULL THEN slut ELSE MIN(slut, aterkallad) END AS slut FROM pro_kop WHERE konto_id = ? AND plan = 'projekt' AND borttagen IS NULL ORDER BY slut DESC`,k.konto_id))].sort((a,b)=>b.slut-a.slut);
      if (kp.some((r) => r.slut > nu)) continue;
      const senast = this.senastSlut(k, t, kp, { ratt_slut: k.ratt_slut });
      if (k.aviserad) { if (k.aviserad + RADERA_EFTER_AVISERING_S <= nu && radera.length < SCHEMA_MAX) radera.push({ kontoId: k.konto_id, kund: k.kund || null }); }
      else if (senast + AVISERA_S <= nu && avisera.length < SCHEMA_MAX) avisera.push({ kontoId: k.konto_id, kund: k.kund || null, senast_slut: senast });
    }
    return { avisera, radera };
  }
  markeraAviserad({ nu, kontoId }) {
    if (!KONTO_RE.test(String(kontoId))) return { ok: false };
    this.sql.exec(`INSERT INTO konto_status (konto_id, ratt_slut, aviserad) VALUES (?, NULL, ?) ON CONFLICT(konto_id) DO UPDATE SET aviserad = COALESCE(konto_status.aviserad, excluded.aviserad)`, kontoId, nu);
    return { ok: true };
  }
  // Radering av ett konto i registret (begärd eller efter avisering). Minimal markering (konto-id och tid) BEHÅLLS i `raderade`, så att
  // PITR aldrig kan återställa kontot (Modesty §4.9). Allt annat om kontot tas bort i samma transaktion. Kontots objekt rensas av workern
  // direkt efteråt; misslyckas det tar cron (`orensade`) det.
  radera({ nu, kontoId }) {
    if (!KONTO_RE.test(String(kontoId))) return { ok: false };
    this.sql.exec(`INSERT INTO raderade (konto_id, tid, rensad) VALUES (?, ?, NULL) ON CONFLICT(konto_id) DO UPDATE SET rensad = NULL`, kontoId, nu);
    const k = forsta(this.sql.exec(`SELECT ehash FROM konton WHERE konto_id = ?`, kontoId));
    if (k) {
      for (const t of ["testbevis", "koder", "adress", "testplatser"]) this.sql.exec(`DELETE FROM ${t} WHERE ehash = ?`, k.ehash);
      this.sql.exec(`DELETE FROM konton WHERE konto_id = ?`, kontoId);
    }
    this.sql.exec(`DELETE FROM konto_status WHERE konto_id = ?`, kontoId);
    this.sql.exec(`DELETE FROM pitr_utlogg WHERE konto_id = ?`, kontoId);
    this.sql.exec(`DELETE FROM kop_projekt WHERE konto_id = ?`, kontoId);
    this.sql.exec(`UPDATE pro_kop SET konto_id=NULL,kund=NULL,projekt_id=NULL,pren_id=NULL,betalning_id=NULL,slut=NULL,borttagen=? WHERE konto_id = ?`,nu,kontoId);
    return { ok: true, fanns: !!k };
  }
  orensade() { return { konton: rader(this.sql.exec(`SELECT konto_id FROM raderade WHERE rensad IS NULL ORDER BY tid LIMIT ?`, SCHEMA_MAX)).map((r) => r.konto_id) }; }
  markeraRensad({ nu, kontoId }) { this.sql.exec(`UPDATE raderade SET rensad = ? WHERE konto_id = ?`, nu, String(kontoId)); return { ok: true }; }
  raderat({ kontoId }) { return { raderat: !!forsta(this.sql.exec(`SELECT 1 AS x FROM raderade WHERE konto_id = ?`, String(kontoId))) }; }
  // PITR-kontroll och loggning i EN transaktion: ett raderat konto vägras alltid; ett okänt konto ger saknas.
  pitrKontroll({ nu, kontoId, mal, enhet }) {
    if (!KONTO_RE.test(String(kontoId))) return { ok: false, orsak: "ogiltigt" };
    const det = JSON.stringify({ mal, enhet: String(enhet || "").slice(0, 24) });
    if (forsta(this.sql.exec(`SELECT 1 AS x FROM raderade WHERE konto_id = ?`, kontoId))) {
      this.sql.exec(`INSERT INTO agarlogg (tid, handling, konto_id, detalj) VALUES (?, 'pitr_vagrad_raderat', ?, ?)`, nu, kontoId, det);
      return { ok: false, orsak: "raderat" };
    }
    if (!forsta(this.sql.exec(`SELECT 1 AS x FROM konton WHERE konto_id = ?`, kontoId))) return { ok: false, orsak: "saknas" };
    this.sql.exec(`INSERT INTO agarlogg (tid, handling, konto_id, detalj) VALUES (?, 'pitr_begard', ?, ?)`, nu, kontoId, det);
    return { ok: true };
  }
  logg({ nu, handling, kontoId, detalj }) {
    if (!/^[a-z_]{1,40}$/.test(String(handling))) return { ok: false };
    this.sql.exec(`INSERT INTO agarlogg (tid, handling, konto_id, detalj) VALUES (?, ?, ?, ?)`, nu, handling, KONTO_RE.test(String(kontoId)) ? kontoId : null, String(detalj || "").slice(0, 400));
    return { ok: true };
  }
  // Internt (inget publikt anrop i K1; ägarytan kommer i K5). slut=0 eller aterkalla=true återkallar.
  testbevis({ nu, ehash, slut, aterkalla }) {
    if (!/^[0-9a-f]{64}$/.test(String(ehash))) return { ok: false };
    if (aterkalla) { this.sql.exec(`UPDATE testbevis SET aterkallad = ? WHERE ehash = ?`, nu, ehash); return { ok: true }; }
    if (!(Number.isSafeInteger(slut) && slut > nu)) return { ok: false };
    this.sql.exec(`INSERT INTO testbevis (ehash, slut, aterkallad, satt) VALUES (?, ?, NULL, ?) ON CONFLICT(ehash) DO UPDATE SET slut = excluded.slut, aterkallad = NULL, satt = excluded.satt`, ehash, slut, nu);
    return { ok: true };
  }
  // ---------- K5: ägarens testplatser ----------
  // Status ur testbevis: aktiv (inte återkallad, slut > nu), utgangen (slut passerat) eller aterkallad. Högst MAX_TESTPLATSER aktiva
  // (räknat över ALLA testbevis, så att ett internt satt bevis också räknas). Svaren bär bara id, etikett, maskad adress, status och tider:
  // aldrig ehash, konto-id eller något ur kontots objekt (ingen ägaråtkomst till kunders jobb).
  tpRad(r, nu) {
    const status = r.aterkallad ? "aterkallad" : r.slut > nu ? "aktiv" : "utgangen";
    return { id: r.id, etikett: r.etikett, adress: r.maskad, status, slut: r.slut, skapad: r.skapad, aterkallad: r.aterkallad || null };
  }
  aktivaTest(nu, utom) {
    return forsta(this.sql.exec(`SELECT COUNT(*) AS n FROM testbevis WHERE aterkallad IS NULL AND slut > ? AND ehash <> ?`, nu, String(utom || ""))).n;
  }
  tpLista({ nu }) {
    const l = rader(this.sql.exec(`SELECT t.id, t.etikett, t.maskad, t.skapad, b.slut, b.aterkallad FROM testplatser t JOIN testbevis b ON b.ehash = t.ehash ORDER BY t.skapad, t.id`));
    return { testplatser: l.map((r) => this.tpRad(r, nu)), aktiva: this.aktivaTest(nu, null), max: MAX_TESTPLATSER };
  }
  tpHamta(id, nu) {
    const r = forsta(this.sql.exec(`SELECT t.id, t.ehash, t.etikett, t.maskad, t.skapad, b.slut, b.aterkallad FROM testplatser t JOIN testbevis b ON b.ehash = t.ehash WHERE t.id = ?`, String(id)));
    return r ? { r, ut: this.tpRad(r, nu) } : null;
  }
  tpLogg(nu, handling, detalj) { this.sql.exec(`INSERT INTO agarlogg (tid, handling, konto_id, detalj) VALUES (?, ?, NULL, ?)`, nu, handling, detalj); }
  // Bjud in (eller återaktivera samma adress). provning=true gör alla kontroller utan att skriva (före kodinlösen).
  tpInbjud({ nu, ehash, maskad, etikett, slut, agareEhash, provning }) {
    if (!/^[0-9a-f]{64}$/.test(String(ehash)) || typeof maskad !== "string" || !maskad || maskad.length > 80) return { fel: "ogiltig" };
    if (!(Number.isSafeInteger(slut) && slut > nu && slut <= nu + TEST_MAX_S)) return { fel: "ogiltigt_slut" };
    if (typeof agareEhash === "string" && agareEhash.length === 64 && timingSafeEqual(ehash, agareEhash)) return { fel: "agaradress" };
    const finns = forsta(this.sql.exec(`SELECT t.id, b.slut, b.aterkallad FROM testplatser t JOIN testbevis b ON b.ehash = t.ehash WHERE t.ehash = ?`, ehash));
    if (finns && !finns.aterkallad && finns.slut > nu) return { fel: "finns_redan", id: finns.id };
    if (this.aktivaTest(nu, ehash) >= MAX_TESTPLATSER) return { fel: "fullt", max: MAX_TESTPLATSER };
    const anvanda = new Set(rader(this.sql.exec(`SELECT etikett FROM testplatser`)).map((r) => r.etikett));
    let et = typeof etikett === "string" ? etikett.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 40) : "";
    if (!et) { for (let i = 1; i <= 99; i++) if (!anvanda.has("Test " + i)) { et = "Test " + i; break; } }
    if (provning) return { ok: true, provning: true };
    const id = finns ? finns.id : "t_" + randomHex(8);
    this.sql.exec(`INSERT INTO testbevis (ehash, slut, aterkallad, satt) VALUES (?, ?, NULL, ?) ON CONFLICT(ehash) DO UPDATE SET slut = excluded.slut, aterkallad = NULL, satt = excluded.satt`, ehash, slut, nu);
    this.sql.exec(`INSERT INTO testplatser (id, ehash, etikett, maskad, skapad) VALUES (?, ?, ?, ?, ?) ON CONFLICT(ehash) DO UPDATE SET etikett = excluded.etikett, maskad = excluded.maskad`, id, ehash, et, maskad, nu);
    this.tpLogg(nu, finns ? "testplats_ateraktiverad" : "testplats_inbjuden", JSON.stringify({ id, slut }));
    return { ok: true, testplats: this.tpHamta(id, nu).ut, ateraktiverad: !!finns };
  }
  // Förläng: nytt slut senare än nuvarande, högst TEST_MAX_S fram. Återkallad plats förlängs inte (bjud in igen). En utgången plats
  // som blir aktiv räknas mot taket.
  tpForlang({ nu, id, slut, provning }) {
    const h = this.tpHamta(id, nu); if (!h) return { fel: "hittas_inte" };
    if (h.r.aterkallad) return { fel: "aterkallad" };
    if (!(Number.isSafeInteger(slut) && slut > nu && slut > h.r.slut && slut <= nu + TEST_MAX_S)) return { fel: "ogiltigt_slut" };
    if (h.r.slut <= nu && this.aktivaTest(nu, h.r.ehash) >= MAX_TESTPLATSER) return { fel: "fullt", max: MAX_TESTPLATSER };
    if (provning) return { ok: true, provning: true };
    this.sql.exec(`UPDATE testbevis SET slut = ?, satt = ? WHERE ehash = ?`, slut, nu, h.r.ehash);
    this.tpLogg(nu, "testplats_forlangd", JSON.stringify({ id, slut }));
    return { ok: true, testplats: this.tpHamta(id, nu).ut };
  }
  // Återkalla: rätten upphör vid nästa anrop (ratt läser testbeviset varje gång); läsperioden räknas från återkallelsen (K2 senastSlut).
  tpAterkalla({ nu, id, provning }) {
    const h = this.tpHamta(id, nu); if (!h) return { fel: "hittas_inte" };
    if (h.r.aterkallad) return { ok: true, redan: true, testplats: h.ut };
    if (provning) return { ok: true, provning: true };
    this.sql.exec(`UPDATE testbevis SET aterkallad = ? WHERE ehash = ?`, nu, h.r.ehash);
    this.tpLogg(nu, "testplats_aterkallad", JSON.stringify({ id }));
    return { ok: true, testplats: this.tpHamta(id, nu).ut };
  }
  // ---------- K5: PITR loggar ut alla enheter (K2-fynd 2) ----------
  // Markeringen sätts av kontots objekt efter att bokmärket hämtats men FÖRE onNextSessionRestoreBookmark. Ett objekt som startar
  // därefter är det återställda och loggar ut alla enheter innan något annat anrop körs (ProKonto.efterPitr), sedan pitr_klar.
  pitrPlanera({ nu, kontoId }) {
    if (!KONTO_RE.test(String(kontoId))) return { ok: false };
    this.sql.exec(`INSERT INTO pitr_utlogg (konto_id, tid, klar) VALUES (?, ?, NULL) ON CONFLICT(konto_id) DO UPDATE SET tid = excluded.tid, klar = NULL`, kontoId, nu);
    return { ok: true };
  }
  pitrStatus({ kontoId }) { const r = forsta(this.sql.exec(`SELECT tid, klar FROM pitr_utlogg WHERE konto_id = ?`, String(kontoId))); return { vantar: !!(r && !r.klar), tid: r ? r.tid : null }; }
  pitrKlar({ nu, kontoId, tid, antal }) {
    const r = forsta(this.sql.exec(`SELECT tid FROM pitr_utlogg WHERE konto_id = ? AND klar IS NULL`, String(kontoId)));
    if (!r || r.tid !== tid) return { ok: true, andrad: false }; // ny markering under tiden: den hanteras vid nästa start
    this.sql.exec(`UPDATE pitr_utlogg SET klar = ? WHERE konto_id = ?`, nu, String(kontoId));
    this.sql.exec(`INSERT INTO agarlogg (tid, handling, konto_id, detalj) VALUES (?, 'pitr_enheter_utloggade', ?, ?)`, nu, kontoId, JSON.stringify({ antal: Number.isSafeInteger(antal) ? antal : null }));
    return { ok: true, andrad: true };
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
    this.schema();
    this.fetch = rpc(this, {
      aktiva: (d) => this.aktiva(d), skapa: (d) => this.skapa(d), kolla: (d) => this.kolla(d), lista: (d) => this.lista(d), logga_ut: (d) => this.loggaUt(d),
      epost_satt: (d) => this.epostSatt(d), epost_las: () => this.epostLas(),
      p_lista: (d) => this.pLista(d), p_hamta: (d) => this.pHamta(d), p_put: (d) => this.pPut(d), p_del: (d) => this.pDel(d), p_kundlas: (d) => this.pKundlas(d), p_dokument: (d) => this.pDokument(d),
      int_lista: () => this.intLista(), int_hamta: (d) => this.intHamta(d), int_state_ny: (d) => this.intStateNy(d), int_state_los: (d) => this.intStateLos(d), int_spara: (d) => this.intSpara(d), int_ta_bort: (d) => this.intTaBort(d), int_kvitton: (d) => this.intKvitton(d), int_reservera: (d) => this.intReservera(d), // D7.2
      export: (d) => this.exportera(d), tom: () => this.tom(), ap_hamta: () => this.apHamta(), ap_put: (d) => this.apPut(d),
    }, { radera: (d) => this.raderaAllt(d), pitr: (d) => this.pitr(d) }, (d) => this.efterPitr(d));
  }
  // K5 (K2-fynd 2): en gång per objektstart frågas registret om en PITR-markering väntar för kontot. Gör den det är detta objekt det
  // återställda (markeringen sätts först efter bokmärket och före onNextSessionRestoreBookmark, och objektet startas om): ALLA enheter
  // loggas ut innan någon operation körs, så att enheter som loggats ut eller återkallats efter bokmärket inte blir aktiva igen.
  // Registerfel kastar (fail closed, operationen körs inte). Saknas registerbindningen helt (bara i enhetsdubbeln) hoppas kontrollen över.
  async efterPitr(d) {
    if (this.pitrKollad) return;
    const ns = this.env && this.env.PRO_REGISTER;
    if (!ns || typeof ns.idFromName !== "function" || !KONTO_RE.test(String(d && d.kontoId))) { this.pitrKollad = true; return; }
    const st = await register(this.env, "pitr_status", { nu: d.nu, kontoId: d.kontoId });
    if (st && st.vantar) {
      const antal = this.storage.transactionSync(() => {
        const n = forsta(this.sql.exec(`SELECT COUNT(*) AS n FROM enheter WHERE utloggad IS NULL`)).n;
        this.sql.exec(`UPDATE enheter SET utloggad = ? WHERE utloggad IS NULL`, d.nu);
        return n;
      });
      await register(this.env, "pitr_klar", { nu: d.nu, kontoId: d.kontoId, tid: st.tid, antal });
    }
    this.pitrKollad = true;
  }
  schema() {
    const sql = this.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS enheter (id TEXT PRIMARY KEY, sess TEXT NOT NULL UNIQUE, namn TEXT NOT NULL, skapad INTEGER NOT NULL, senast INTEGER NOT NULL, utloggad INTEGER)`);
    // K2: projekt med rev och gravstenar (data NULL = gravsten), kontots egen e-post (bara för avisering), händelselogg (export, PITR).
    sql.exec(`CREATE TABLE IF NOT EXISTS projekt (id TEXT PRIMARY KEY, rev INTEGER NOT NULL, namn TEXT NOT NULL, data TEXT, storlek INTEGER NOT NULL, andrad_ms INTEGER NOT NULL, raderad_ms INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS logg (id INTEGER PRIMARY KEY AUTOINCREMENT, tid INTEGER NOT NULL, typ TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS artikelpriser (id INTEGER PRIMARY KEY CHECK (id = 1), rev INTEGER NOT NULL, data TEXT NOT NULL, storlek INTEGER NOT NULL, andrad_ms INTEGER NOT NULL)`);
    // D7.2: en koppling per leverantör (token bara som AES-GCM-chiffer), OAuth-state med 10 min livslängd. Raderas med kontot (deleteAll).
    sql.exec(`CREATE TABLE IF NOT EXISTS integration (provider TEXT PRIMARY KEY, tenant TEXT NOT NULL, tenant_namn TEXT NOT NULL, iv TEXT NOT NULL, chiffer TEXT NOT NULL, skapad INTEGER NOT NULL, uppdaterad INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS int_state (state TEXT PRIMARY KEY, provider TEXT NOT NULL, verifier TEXT NOT NULL, skapad INTEGER NOT NULL)`);
    // D7.2 kvittologg utan offertinnehåll: nyckeln provider + bolag + offert-ID + version (C10 LocalTransferKey); status prepared/unknown/exported/rejected.
    sql.exec(`CREATE TABLE IF NOT EXISTS int_kvitto (provider TEXT NOT NULL, tenant TEXT NOT NULL, offer_id TEXT NOT NULL, version INTEGER NOT NULL, sha256 TEXT NOT NULL, status TEXT NOT NULL, remote_id TEXT, skapad INTEGER NOT NULL, andrad INTEGER NOT NULL, PRIMARY KEY (provider, tenant, offer_id, version))`);
  }
  get sql() { return this.storage.sql; }
  aktivaRader(nu) { return rader(this.sql.exec(`SELECT id, namn, senast FROM enheter WHERE utloggad IS NULL AND senast > ? ORDER BY senast DESC`, nu - SESSION_S)); }
  aktiva({ nu }) { const l = this.aktivaRader(nu); return { antal: l.length, enheter: l }; }
  skapa({ nu, sess, namn, epost }) {
    if (!/^[0-9a-f]{64}$/.test(String(sess))) return { ok: false };
    const l = this.aktivaRader(nu);
    if (l.length >= MAX_ENHETER) return { ok: false, enhetsgrans: true, enheter: l };
    const id = "e_" + randomHex(8);
    this.sql.exec(`INSERT INTO enheter (id, sess, namn, skapad, senast, utloggad) VALUES (?, ?, ?, ?, ?, NULL)`, id, sess, String(namn || "Okänd enhet").slice(0, 40), nu, nu);
    // K5 (K2-fynd 3): vid lyckad inloggning med e-post och kod sparas och uppdateras adressen i samma transaktion som enheten,
    // så att ett konto med data alltid har en adress för aviseringen. Länkinloggning bär ingen adress (den sparades när koden skickades).
    if (epost !== undefined && validMailTo(epost)) this.sql.exec(`INSERT INTO meta (k, v) VALUES ('epost', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, epost);
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
  // ---------- D7.2 integration (MR-FORTNOX-SPIRIS-20261023-01) ----------
  intLista() { return { kopplingar: rader(this.sql.exec(`SELECT provider, tenant_namn, skapad FROM integration ORDER BY provider`)) }; }
  intHamta({ provider }) { const r = forsta(this.sql.exec(`SELECT tenant, iv, chiffer FROM integration WHERE provider = ?`, String(provider))); return r ? { ok: true, ...r } : { ok: false }; }
  intStateNy({ nu, provider, state, verifier }) {
    this.sql.exec(`DELETE FROM int_state WHERE skapad <= ?`, nu - INT_STATE_S);
    if (forsta(this.sql.exec(`SELECT COUNT(*) AS n FROM int_state WHERE provider = ?`, String(provider))).n >= 5) return { ok: false };
    this.sql.exec(`INSERT INTO int_state (state, provider, verifier, skapad) VALUES (?, ?, ?, ?)`, String(state), String(provider), String(verifier), nu);
    return { ok: true };
  }
  // Förbrukas alltid (även fel leverantör eller utgången), så att samma state aldrig kan lösas in två gånger (I02).
  intStateLos({ nu, state, provider }) {
    const r = forsta(this.sql.exec(`SELECT provider, verifier, skapad FROM int_state WHERE state = ?`, String(state)));
    if (!r) return { ok: false };
    this.sql.exec(`DELETE FROM int_state WHERE state = ?`, String(state));
    return r.provider === provider && r.skapad > nu - INT_STATE_S ? { ok: true, verifier: r.verifier } : { ok: false };
  }
  intSpara({ nu, provider, tenant, tenant_namn, iv, chiffer }) {
    if (![tenant, tenant_namn, iv, chiffer].every((v) => typeof v === "string" && v.length > 0 && v.length <= 8192)) return { ok: false };
    this.sql.exec(`INSERT INTO integration (provider, tenant, tenant_namn, iv, chiffer, skapad, uppdaterad) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET tenant = excluded.tenant, tenant_namn = excluded.tenant_namn, iv = excluded.iv, chiffer = excluded.chiffer, uppdaterad = excluded.uppdaterad`, String(provider), tenant, tenant_namn, iv, chiffer, nu, nu);
    return { ok: true };
  }
  intKvitton({ provider, tenant }) {
    return { kvitton: rader(this.sql.exec(`SELECT provider, tenant AS tenantId, offer_id AS offerId, version AS offerVersion, sha256, status, remote_id AS remoteId FROM int_kvitto WHERE provider = ? AND tenant = ? ORDER BY version`, String(provider), String(tenant))) };
  }
  // Atomisk reservation (DO:n är enda skrivare, en transaktion): finns nyckeln redan skapas ingen ny – den som kom först vinner (I12).
  intReservera({ nu, provider, tenant, offerId, offerVersion, sha256 }) {
    if (!/^[a-f0-9]{64}$/.test(String(sha256)) || !Number.isSafeInteger(offerVersion) || typeof offerId !== "string" || !offerId) return { ok: false };
    if (forsta(this.sql.exec(`SELECT 1 AS x FROM int_kvitto WHERE provider = ? AND tenant = ? AND offer_id = ? AND version = ?`, String(provider), String(tenant), offerId, offerVersion))) return { ok: false };
    this.sql.exec(`INSERT INTO int_kvitto (provider, tenant, offer_id, version, sha256, status, remote_id, skapad, andrad) VALUES (?, ?, ?, ?, ?, 'prepared', NULL, ?, ?)`, String(provider), String(tenant), offerId, offerVersion, sha256, nu, nu);
    return { ok: true };
  }
  intTaBort({ provider }) { const fanns = !!forsta(this.sql.exec(`SELECT 1 AS x FROM integration WHERE provider = ?`, String(provider))); this.sql.exec(`DELETE FROM integration WHERE provider = ?`, String(provider)); return { ok: true, fanns }; }
  // ---------- K2 ----------
  epostSatt({ epost }) { if (!validMailTo(epost)) return { ok: false }; this.sql.exec(`INSERT INTO meta (k, v) VALUES ('epost', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, epost); return { ok: true }; }
  epostLas() { const r = forsta(this.sql.exec(`SELECT v FROM meta WHERE k = 'epost'`)); return { epost: r ? r.v : null }; }
  gallraGravar(ms) { this.sql.exec(`DELETE FROM projekt WHERE raderad_ms IS NOT NULL AND raderad_ms <= ?`, ms - GRAV_S * 1000); }
  meta(r) { return { id: r.id, rev: r.rev, namn: r.namn, andrad: r.andrad_ms, raderad: r.raderad_ms ?? null, storlek: r.storlek }; }
  pLista({ ms }) { // gravstenar äldre än 90 d visas inte (och tas bort vid nästa skrivning)
    return { projekt: rader(this.sql.exec(`SELECT id, rev, namn, storlek, andrad_ms, raderad_ms FROM projekt WHERE raderad_ms IS NULL OR raderad_ms > ? ORDER BY andrad_ms DESC`, ms - GRAV_S * 1000)).map((r) => this.meta(r)) };
  }
  rad(id, ms) { const r = forsta(this.sql.exec(`SELECT * FROM projekt WHERE id = ?`, String(id))); return r && r.raderad_ms !== null && r.raderad_ms <= ms - GRAV_S * 1000 ? null : r; }
  full(r) { return { ...this.meta(r), data: r.data === null ? null : JSON.parse(r.data) }; }
  pHamta({ ms, id }) {
    if (!PROJ_RE.test(String(id))) return { kod: 404 };
    const r = this.rad(id, ms); if (!r) return { kod: 404 };
    if (r.raderad_ms !== null) return { kod: 410, id: r.id, rev: r.rev, raderad_ms: r.raderad_ms };
    return { kod: 200, projekt: this.full(r) };
  }
  // PUT med If-Match: 0 = skapa. Rätt rev → rev+1. Fel rev → 409 med serverns version. Gravsten → 410 (återskapas aldrig tyst).
  // Samma kundbindning på alla kontoenheter. Namnet finns redan i projektet;
  // meta tillhör samma EU-konto och rensas med kontot. Full PRO-roll är undantagen.
  kundNamn(data) { try { const n = JSON.parse(data)?.kund?.namn; return typeof n === "string" ? n.normalize("NFC").trim().slice(0, 200) : ""; } catch { return ""; } }
  bindKund(id, data) {
    const k = "kund:" + id, fore = forsta(this.sql.exec(`SELECT v FROM meta WHERE k = ?`, k));
    if (fore) return fore.v;
    const namn = this.kundNamn(data);
    if (namn) this.sql.exec(`INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO NOTHING`, k, namn);
    return namn;
  }
  pKundlas({ ms, ids }) {
    const kundlas = {};
    for (const id of Array.isArray(ids) ? ids : []) {
      if (!PROJ_RE.test(id)) continue;
      const r = this.rad(id, ms);
      if (!r || r.raderad_ms !== null) continue;
      const fore = forsta(this.sql.exec(`SELECT v FROM meta WHERE k = ?`, "kund:" + id)); if (fore?.v) kundlas[id] = fore.v;
    }
    return { kundlas };
  }
  // Första kundoffert-PDF, aldrig autosparning, binder kundnamnet. Revisionen måste vara
  // den som klienten nyss sparade; namn tas enbart från serverns projektdata.
  // Å22 (Claude Code 2026-10-22): typ "intern" (internt underlag) och "kontroll" (rättsprov vid kvittot) prövar rätt och ett befintligt
  // lås men binder inget nytt namn. Utan typ (äldre klienter) och med "kund" binds som förut.
  pDokument({ms,id,rev,typ="kund"}) {
    if (!PROJ_RE.test(String(id)) || !Number.isSafeInteger(rev) || rev < 1) return {kod:400};
    const r=this.rad(id,ms); if (!r || r.raderad_ms !== null) return {kod:404};
    if (r.rev !== rev) return {kod:409,server:this.full(r)};
    // Anders beslut 2026-10-22: en kundoffert vid projektköp kräver ett ifyllt kundnamn med minst en bokstav eller siffra (annars binds
    // inget och köpet gäller i praktiken alla kunder). Ett redan bundet namn går före; intern och kontroll berörs inte.
    const las=forsta(this.sql.exec(`SELECT v FROM meta WHERE k = ?`, "kund:" + id))?.v || "";
    if (typ === "kund" && !las && !/[\p{L}\p{N}]/u.test(this.kundNamn(r.data))) return {kod:422};
    const kund=typ === "kund" ? this.bindKund(id,r.data) : las;
    if (kund && kund !== this.kundNamn(r.data)) return {kod:409,server:this.full(r)};
    return {kod:200,kund:kund || null};
  }
  pPut({ ms, id, rev, data, namn, storlek, kundBunden = false }) {
    if (!PROJ_RE.test(String(id)) || !Number.isSafeInteger(rev) || rev < 0 || typeof data !== "string") return { kod: 400 };
    this.gallraGravar(ms);
    const r = this.rad(id, ms);
    if (r && r.raderad_ms !== null) return { kod: 410, id: r.id, rev: r.rev, raderad_ms: r.raderad_ms };
    if (r && rev !== r.rev) return { kod: 409, server: this.full(r) };
    // The stored body, not a caller header, owns its version. An old client
    // must not overwrite a complete V2 record with a metadata-stripped V1 body.
    const incomingVersion = projektVersion(data, id);
    if (incomingVersion === null) return { kod: 400 };
    if (r) {
      const storedVersion = projektVersion(r.data, id);
      if (storedVersion === null || incomingVersion < storedVersion)
        return { kod: 426, status: "projektversion_stods_inte", krav_version: storedVersion };
    }
    if (kundBunden && r) {
      const last = forsta(this.sql.exec(`SELECT v FROM meta WHERE k = ?`, "kund:" + id))?.v;
      if (last && last !== this.kundNamn(data)) return { kod: 409, server: this.full(r) };
    }
    if (!r) {
      if (rev !== 0) return { kod: 404 };
      if (forsta(this.sql.exec(`SELECT COUNT(*) AS n FROM projekt WHERE raderad_ms IS NULL`)).n >= PROJ_MAX_ANTAL) return { kod: 413, status: "for_manga_projekt", max: PROJ_MAX_ANTAL };
      this.sql.exec(`INSERT INTO projekt (id, rev, namn, data, storlek, andrad_ms, raderad_ms) VALUES (?, 1, ?, ?, ?, ?, NULL)`, id, String(namn).slice(0, 200), data, storlek, ms);
      return { kod: 200, id, rev: 1, andrad: ms };
    }
    if (rev !== r.rev) return { kod: 409, server: this.full(r) };
    this.sql.exec(`UPDATE projekt SET rev = ?, namn = ?, data = ?, storlek = ?, andrad_ms = ? WHERE id = ?`, r.rev + 1, String(namn).slice(0, 200), data, storlek, ms, id);
    if (!kundBunden) { const kund = this.kundNamn(data); if (kund) this.sql.exec(`UPDATE meta SET v = ? WHERE k = ?`, kund, "kund:" + id); else this.sql.exec(`DELETE FROM meta WHERE k = ?`, "kund:" + id); }
    return { kod: 200, id, rev: r.rev + 1, andrad: ms };
  }
  // DELETE med If-Match → gravsten: rev+1, data och namn bort, bara id, rev och tid kvar.
  pDel({ ms, id, rev }) {
    if (!PROJ_RE.test(String(id)) || !Number.isSafeInteger(rev) || rev < 0) return { kod: 400 };
    this.gallraGravar(ms);
    const r = this.rad(id, ms); if (!r) return { kod: 404 };
    if (r.raderad_ms !== null) return { kod: 410, id: r.id, rev: r.rev, raderad_ms: r.raderad_ms };
    if (rev !== r.rev) return { kod: 409, server: this.full(r) };
    this.sql.exec(`UPDATE projekt SET rev = ?, namn = '', data = NULL, storlek = 0, andrad_ms = ?, raderad_ms = ? WHERE id = ?`, r.rev + 1, ms, ms, id);
    this.sql.exec(`DELETE FROM meta WHERE k = ?`, "kund:" + id);
    return { kod: 200, id, rev: r.rev + 1, raderad_ms: ms };
  }
  apHamta() {
    const r = forsta(this.sql.exec(`SELECT rev, data, andrad_ms FROM artikelpriser WHERE id = 1`));
    return r ? { rev: r.rev, andrad: r.andrad_ms, data: JSON.parse(r.data) } : { rev: 0, andrad: null, data: { format: AP_FORMAT, version: 1, poster: [] } };
  }
  // If-Match 0 skapar; rätt rev → rev+1; annars 409 med hela serverns dokument. Ingen tyst sammanslagning på servern.
  apPut({ ms, rev, data, storlek }) {
    if (!Number.isSafeInteger(rev) || rev < 0 || typeof data !== "string") return { kod: 400 };
    const r = forsta(this.sql.exec(`SELECT rev FROM artikelpriser WHERE id = 1`));
    if ((r ? r.rev : 0) !== rev) return { kod: 409, server: this.apHamta() };
    if (r) this.sql.exec(`UPDATE artikelpriser SET rev = ?, data = ?, storlek = ?, andrad_ms = ? WHERE id = 1`, rev + 1, data, storlek, ms);
    else this.sql.exec(`INSERT INTO artikelpriser (id, rev, data, storlek, andrad_ms) VALUES (1, 1, ?, ?, ?)`, data, storlek, ms);
    return { kod: 200, rev: rev + 1, andrad: ms };
  }
  // Export: ALLT kontots objekt innehåller (enheter utan sessionshash, projekt inkl. gravstenar, e-post, logg). Exporten loggas.
  exportera({ nu, ms }) {
    this.gallraGravar(ms);
    this.sql.exec(`INSERT INTO logg (tid, typ) VALUES (?, 'export')`, nu);
    this.sql.exec(`DELETE FROM logg WHERE id NOT IN (SELECT id FROM logg ORDER BY id DESC LIMIT 200)`);
    return {
      enheter: rader(this.sql.exec(`SELECT id, namn, skapad, senast, utloggad FROM enheter ORDER BY skapad`)),
      projekt: rader(this.sql.exec(`SELECT * FROM projekt ORDER BY andrad_ms`)).map((r) => this.full(r)),
      kundlas: Object.fromEntries(rader(this.sql.exec(`SELECT k,v FROM meta WHERE k LIKE 'kund:%'`)).map(r => [r.k.slice(5), r.v])),
      epost: this.epostLas().epost,
      logg: rader(this.sql.exec(`SELECT tid, typ FROM logg ORDER BY id`)),
      artikelpriser: this.apHamta(),
    };
  }
  tom() { // för efterkontroll: finns något kvar i objektet?
    const n = (t) => forsta(this.sql.exec(`SELECT COUNT(*) AS n FROM ${t}`)).n;
    return { tom: n("enheter") + n("projekt") + n("meta") + n("logg") + n("artikelpriser") === 0 };
  }
  // Radera ALL lagring i kontots objekt (deleteAll tar även SQLite-databasen), återskapa sedan tomt schema i samma instans.
  async raderaAllt() {
    await this.storage.deleteAll();
    this.schema();
    return { ok: true };
  }
  // PITR (ägarkommando; kontrollen och loggningen görs i registret före anropet). Stöds bara i Cloudflares produktion: provas live i K6.
  async pitr({ nu, mal, kontoId }) {
    if (!Number.isSafeInteger(mal) || mal <= 0 || mal >= nu * 1000) return { ok: false, orsak: "ogiltig_tid" };
    if (typeof this.storage.getBookmarkForTime !== "function" || typeof this.storage.onNextSessionRestoreBookmark !== "function") return { ok: false, orsak: "stods_inte" };
    let bm;
    try { bm = await this.storage.getBookmarkForTime(mal); } catch (e) { return { ok: false, orsak: "bokmarke", fel: String((e && e.message) || e).slice(0, 120) }; }
    // K5 (K2-fynd 2): markera i registret FÖRE återställningen att alla enheter ska loggas ut när objektet startat om. Misslyckas
    // markeringen görs ingen återställning (fail closed).
    try { const m = await register(this.env, "pitr_planera", { nu, kontoId }); if (!m || !m.ok) return { ok: false, orsak: "markering" }; }
    catch { return { ok: false, orsak: "markering" }; }
    await this.storage.onNextSessionRestoreBookmark(bm);
    // Ingen logg här: återställningen tar bort allt efter bokmärket. Loggen finns i registret (agarlogg). abort() efter svaret startar om
    // objektet så att bokmärket tillämpas (Cloudflares mönster); kastar den gör det inget, nästa session tillämpar det ändå.
    if (this.state && typeof this.state.abort === "function") setTimeout(() => { try { this.state.abort("pitr"); } catch { /* */ } }, 0);
    return { ok: true, bokmarke: String(bm).slice(0, 80) };
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
// K2: roll agare > test > pren > projekt > ingen. `slut` = senast kända slut på rätt (läsperioden räknas därifrån).
// skriv: "alla" | [projekt-id] | null. lasSlut = slut + 90 d (null för ägaren).
async function rattFor(env, kontoId, nu, { aktivPren, proMode, fetchImpl }) {
  const agare = validMailTo(normEpost(env.PRO_OWNER_EMAIL)) ? await epostHash(env, env.PRO_OWNER_EMAIL) : null;
  const r = await register(env, "ratt", { nu, kontoId, agareEhash: agare, mode:proMode(env) });
  if (!r || !r.finns) return { roll: "ingen", slut: null, skriv: null, lasSlut: null };
  if (r.agare) return { roll: "agare", slut: null, skriv: "alla", lasSlut: null };
  if (r.test && r.test.aktiv) return { roll: "test", slut: r.test.slut, skriv: "alla", lasSlut: r.test.slut + LAS_DAGAR * DAG };
  const kunder = [...new Set([...(r.kop || []).filter(p => p.plan !== "projekt" && !p.aterkallad).map(p => p.kund), r.kund].filter(Boolean))];
  if (proMode(env) !== "off" && typeof aktivPren === "function") for (const kund of kunder) {
    const ids = (r.kop || []).filter(p => p.kund === kund && p.plan !== "projekt" && !p.aterkallad).map(p => p.pren_id);
    const sub = await aktivPren(env, kund, fetchImpl, r.kund === kund ? null : ids);
    if (sub) {
      const p = Number.isInteger(sub.current_period_end) ? sub.current_period_end : (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end) || null;
      await register(env, "notera_pren", { nu, kontoId, slut: p || nu });
      return { roll: "pren", slut: p, skriv: "alla", lasSlut: p ? p + LAS_DAGAR * DAG : null };
    }
  }
  if (r.projekt && r.projekt.aktiva.length) return { roll: "projekt", slut: r.projekt.slut, skriv: r.projekt.aktiva, lasSlut: r.projekt.slut + LAS_DAGAR * DAG };
  const slut = Number.isSafeInteger(r.senast_slut) ? r.senast_slut : null;
  return { roll: "ingen", slut, skriv: null, lasSlut: slut ? slut + LAS_DAGAR * DAG : null };
}

// ---------- K2: projektkropp (samma gränser som P4: 256 KB, 500 rader) ----------
async function lasProjekt(request, id) {
  const raw = await request.text();
  const storlek = new TextEncoder().encode(raw).length;
  if (storlek > PROJ_MAX_BYTE) return { kod: 413, status: "for_stort", max_byte: PROJ_MAX_BYTE };
  let p; try { p = JSON.parse(raw); } catch { return { kod: 400, status: "ogiltig_kropp" }; }
  if (!p || typeof p !== "object" || Array.isArray(p)) return { kod: 400, status: "ogiltig_kropp" };
  const n = ["material", "arbete", "ovrigt"].reduce((a, k) => a + (Array.isArray(p[k]) ? p[k].length : 0), 0);
  if (n > PROJ_MAX_RADER) return { kod: 413, status: "for_manga_rader", max_rader: PROJ_MAX_RADER };
  if (p.format !== P4_FORMAT || ![1, 2].includes(p.version) || p.projektId !== id || (p.projektnamn !== undefined && (typeof p.projektnamn !== "string" || p.projektnamn.length > 200)))
    return { kod: 400, status: "ogiltigt_projekt" };
  for (const k of ["material", "arbete", "ovrigt"]) if (p[k] !== undefined && !Array.isArray(p[k])) return { kod: 400, status: "ogiltigt_projekt" };
  if (p.version === 2 && !(await readRoofProject(p)).ok) return { kod: 400, status: "ogiltigt_takunderlag" };
  return { kod: 0, data: raw, namn: typeof p.projektnamn === "string" ? p.projektnamn : "", storlek };
}
// PRO-PRIS-01: exakta nycklar, unik (nyckel, namn, enhet), pris som P4:s KR-sträng där "0" är ett pris; borttag är en gravsten.
// Samma styrteckenmängd som P4 (pro-projekt.mjs STYR): C0/C1, nollbredd, radavskiljare och bidi-tecken; ensamma surrogater nekas också.
const AP_KR = /^\d{1,9}(?:\.\d{1,2})?$/, AP_DAG = /^(\d{4})-(\d{2})-(\d{2})$/, AP_STYR = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/, AP_SKEW_MS = 5 * 60 * 1000;
const apDag = (v) => { const m = typeof v === "string" && AP_DAG.exec(v); if (!m) return false; const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]; };
const apText = (v, max, min = 1) => typeof v === "string" && v.length >= min && v.length <= max && !AP_STYR.test(v) && v.isWellFormed() && v === v.normalize("NFC");
const apMs = (v) => Number.isSafeInteger(v) && v > 0;
export function giltigaArtikelpriser(o, ms) {
  if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).sort().join() !== "format,poster,version" || o.format !== AP_FORMAT || o.version !== 1 || !Array.isArray(o.poster)) return false;
  const sedda = new Set(); let aktiva = 0, gravar = 0;
  for (const p of o.poster) {
    if (!p || typeof p !== "object" || Array.isArray(p)) return false;
    const k = Object.keys(p).sort().join(), grav = k === "enhet,namn,nyckel,raderad_ms";
    if (!grav && k !== "andrad_ms,enhet,namn,nyckel,pris_kr,sparad") return false;
    // P4 bildar k:/m:-nycklar av namn (≤200, kan växa vid gemener) + "|" + enhet (≤20): rymmer upp till 240 tecken.
    if (!apText(p.nyckel, 240) || !/^(n:|k:|m:)/.test(p.nyckel) || !(p.namn === null || apText(p.namn, 200)) || !apText(p.enhet, 20)) return false;
    if (grav ? !(apMs(p.raderad_ms) && p.raderad_ms <= ms + AP_SKEW_MS) : !(typeof p.pris_kr === "string" && AP_KR.test(p.pris_kr) && apDag(p.sparad) && apMs(p.andrad_ms) && p.andrad_ms <= ms + AP_SKEW_MS)) return false;
    const id = JSON.stringify([p.nyckel, p.namn, p.enhet]); if (sedda.has(id)) return false; sedda.add(id);
    if (grav) gravar++; else aktiva++;
  }
  return aktiva <= AP_MAX_POSTER && gravar <= AP_MAX_POSTER ? true : "for_manga_poster";
}
async function lasArtikelpriser(request, ms) {
  const cl = Number(request.headers.get("content-length"));
  if (Number.isFinite(cl) && cl > AP_MAX_BYTE) return { kod: 413, status: "for_stort", max_byte: AP_MAX_BYTE };
  const raw = await request.text();
  const storlek = new TextEncoder().encode(raw).length;
  if (storlek > AP_MAX_BYTE) return { kod: 413, status: "for_stort", max_byte: AP_MAX_BYTE };
  let o; try { o = JSON.parse(raw); } catch { return { kod: 400, status: "ogiltig_kropp" }; }
  // Gravstenar äldre än 90 d (som jobbens) gallras här, före räkningen, så att namn inte ligger kvar och taket inte låser synken.
  if (o && Array.isArray(o.poster)) o.poster = o.poster.filter((p) => !(p && typeof p === "object" && "raderad_ms" in p && apMs(p.raderad_ms) && p.raderad_ms <= ms - GRAV_S * 1000));
  const g = giltigaArtikelpriser(o, ms);
  if (g === "for_manga_poster") return { kod: 413, status: "for_manga_poster", max: AP_MAX_POSTER };
  if (g !== true) return { kod: 400, status: "ogiltig_kropp" };
  return { kod: 0, data: JSON.stringify(o), storlek };
}
const ifMatch = (request) => { const m = /^\s*(?:W\/)?"?(\d{1,12})"?\s*$/.exec(request.headers.get("If-Match") || ""); return m ? Number(m[1]) : null; };

// Färsk kod (≤10 min, engångs) som måste höra till sessionens eget konto. Prövas först utan att förbrukas, så att en kod till ett annat
// konto aldrig förbrukas här. → true/false
async function farskKod(env, b, nu, kontoId) {
  const ind = await kodIndata(env, b); if (!ind) return false;
  const p = await provaKod(env, ind, nu, false);
  if (!p || !p.ok || p.kontoId !== kontoId) return false;
  const l = await provaKod(env, ind, nu, true);
  return !!(l && l.ok && l.kontoId === kontoId);
}

// Radera ett konto helt: registret först (markering behålls, PITR vägras därefter), sedan kontots objekt. Efterkontroll i cron.
async function raderaKonto(env, kontoId, nu) {
  const r = await register(env, "radera", { nu, kontoId });
  if (!r || !r.ok) { const e = new Error("register radera"); e.status = 502; throw e; }
  const k = await konto(env, kontoId, "radera", { nu });
  if (k && k.ok) await register(env, "markera_rensad", { nu, kontoId });
  return { ok: true };
}

export async function handleKonto(request, env, ctx, deps = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/pro/konto/") && url.pathname !== "/pro/konto") return null;
  try { return harda(await kontoInre(request, env, ctx, deps, url)); }
  catch { return harda(jsonResponse({ status: "tillfalligt_fel" }, 502)); } // A3 gäller även oväntade undantag
}

async function kontoInre(request, env, ctx, { now = () => Date.now(), fetchImpl = fetch, aktivPren = null, proMode = () => "off", kontoAbonnemang = null, kontoCheckout = null } = {}, url) {
  // Grind först: i off rörs varken bindningar, KV, nycklar eller mejl.
  if (kontoLage(env) === "off") return jsonResponse({ status: "stangt" }, 503);
  const origin = request.headers.get("Origin") || "";
  const ms = now(), nu = Math.floor(ms / 1000);
  const svar = (body, status = 200, extra = {}) => jsonResponse(body, status, extra);
  const vag = url.pathname.slice("/pro/konto".length) || "/";
  const m0 = request.method;
  if (m0 === "OPTIONS") return svar({ status: "fel_ursprung" }, 403); // bara samma origin (sajtens proxy, K3): ingen CORS
  if (m0 !== "GET" && m0 !== "HEAD" && (!origins(env).includes(origin) || request.headers.get("X-MR-Pro") !== "1")) return svar({ status: "fel_ursprung" }, 403);
  try {
    if (vag === "/kod" && m0 === "POST") {
      const kvitt = svar({ status: "skickat_om_inbjuden" }, 202); // alltid samma svar: ingen kontoupptäckt
      let b = null; try { b = await lasKropp(request); } catch { /* */ }
      const ip = await ipHash(request);
      // A2: allt arbete (register, e-post till kontots objekt, mejl) efter svaret, så att svarstiden är densamma för alla adresser.
      const jobb = (async () => {
        const epost = normEpost(b && b.epost);
        if (!validMailTo(epost) || !mailHttpConfig(env).on) return;
        const agareEpost = normEpost(env.PRO_OWNER_EMAIL);
        const kodId = randomHex(16), kod = nyKod();
        const r = await register(env, "kod", { nu, ehash: await epostHash(env, epost), ip, agare: validMailTo(agareEpost) && epost === agareEpost,
          kodId, hash: await kodHash(env, kodId, kod), dagstak: dagstak(env) });
        if (!r || !r.skicka) return;
        if (KONTO_RE.test(String(r.kontoId))) { try { await konto(env, r.kontoId, "epost_satt", { nu, epost }); } catch { /* avisering saknar då adress */ } }
        await skickaKod(env, { till: epost, kodId, kod });
      })().catch(() => {});
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(jobb); else await jobb;
      return kvitt;
    }
    if (vag === "/logga-in" && m0 === "POST") {
      const b = await lasKropp(request); const ind = await kodIndata(env, b);
      if (!ind) return svar({ status: "ogiltig_kod" }, 401);
      const p = await provaKod(env, ind, nu, false);
      if (!p || !p.ok || !KONTO_RE.test(String(p.kontoId))) return svar({ status: "ogiltig_kod" }, 401);
      const akt = await konto(env, p.kontoId, "aktiva", { nu });
      if (akt.antal >= MAX_ENHETER) return svar({ status: "enhetsgrans", max: MAX_ENHETER, enheter: akt.enheter }, 409); // koden förbrukas inte
      const l = await provaKod(env, ind, nu, true); // atomisk inlösen: exakt en vinnare
      if (!l || !l.ok || l.kontoId !== p.kontoId) return svar({ status: "ogiltig_kod" }, 401);
      const { sid, varde } = await skapaSessionsvarde(env, l.kontoId);
      const s = await konto(env, l.kontoId, "skapa", { nu, sess: await sessHash(sid), namn: enhetNamn(b, request), ...(typeof b.lank === "string" ? {} : { epost: normEpost(b.epost) }) });
      if (!s.ok) return svar({ status: "enhetsgrans", max: MAX_ENHETER, enheter: s.enheter || [] }, 409); // kapplöpning: koden är förbrukad, begär en ny
      return svar({ status: "inloggad", enhet: s.id }, 200, { "set-cookie": satCookie(varde) });
    }
    // Logga ut vald enhet: med kontots session, eller (vid enhetsgränsen) med den ännu oinlösta koden som bevis.
    let m;
    if ((m = /^\/enheter\/([^/]+)\/logga-ut$/.exec(vag)) && m0 === "POST") {
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
    if (vag === "/logga-ut" && m0 === "POST") {
      const s = await aktivSession(env, request, nu);
      if (s) await konto(env, s.kontoId, "logga_ut", { nu, id: s.enhet });
      return svar({ status: "utloggad" }, 200, { "set-cookie": rensaCookie() });
    }
    // Allt nedan kräver en giltig session. kontoId kommer BARA ur sessionen; konto-id i URL eller kropp används aldrig.
    const s = await aktivSession(env, request, nu);
    const fornya = s && s.forlangd ? { "set-cookie": satCookie(s.varde) } : {};
    const METODER = { "/jag": ["GET"], "/kop": ["POST"], "/abonnemang": ["GET","POST"], "/projekt": ["GET"], "/artikelpriser": ["GET", "PUT"], "/export": ["GET"], "/radera": ["POST"], "/agare/pitr": ["POST"],
      "/agare/testplatser": ["GET"], "/agare/inbjud": ["POST"], "/agare/forlang": ["POST"], "/agare/aterkalla": ["POST"], ...INTEGRATION_METODER }; // K5; D7.2 integration
    const tillatna = METODER[vag] || (/^\/projekt\/p_[0-9a-f]{32}\/dokument$/.test(vag) ? ["POST"] : /^\/projekt\/[^/]+$/.test(vag) ? ["GET", "PUT", "DELETE"] : null);
    if (!tillatna || !tillatna.includes(m0)) return svar({ status: "okand_rutt" }, 404); // okänd rutt eller fel metod: 404 före sessionen (som K1)
    if (!s) return svar({ status: "ej_inloggad" }, 401);
    const deps = { aktivPren, proMode, fetchImpl };
    // D7.2 steg 1–2: bara ägaren (PRO_OWNER_EMAIL, prövad på servern) tills leverantörsflödet är verifierat i sandlåda/licens. Andra konton får 404,
    // så att en Spiris-knapp aldrig leder till en oregistrerad callback. Öppnas med en kodändring, ingen ny Worker-variabel (62/64).
    if (vag.startsWith("/integration/") && (await rattFor(env, s.kontoId, nu, deps)).roll !== "agare") return svar({ status: "okand_rutt" }, 404);
    if (vag.startsWith("/integration/")) { let kropp = null; if (m0 === "POST") { try { kropp = await lasKropp(request); } catch { kropp = null; } } return integrationRoute(vag, m0, url, env, s, { konto, nu, fetchImpl, svar, kropp }); } // D7.2: kontoId bara ur sessionen

    if (vag === "/kop") {
      if (!kontoCheckout || proMode(env) === "off") return svar({status:"stangt"},503);
      const {epost}=await konto(env,s.kontoId,"epost_las",{nu});
      if (!validMailTo(epost)) return svar({status:"tillfalligt_fel"},502);
      return kontoCheckout(request,env,ctx,{fetchImpl,now,kontoEhash:await epostHash(env,epost)});
    }
    if (vag === "/abonnemang") {
      if (!kontoAbonnemang || proMode(env) === "off") return svar({status:"stangt"},503);
      const b=m0 === "POST" ? await lasKropp(request) : null;
      if (m0 === "POST" && !/^PRO-[A-HJ-NP-Z2-9]{8}$/.test(String(b?.order))) return svar({status:"hittas_inte"},404);
      const r=await kontoAbonnemang(env,s.kontoId,{order:b?.order,fetchImpl,nowS:nu});
      return r ? svar(r) : svar({status:"hittas_inte"},404);
    }
    if (vag === "/jag" && m0 === "GET") {
      const [ratt, lista] = await Promise.all([rattFor(env, s.kontoId, nu, deps), konto(env, s.kontoId, "lista", { nu })]);
      const bindning = ratt.roll === "projekt" ? await konto(env, s.kontoId, "p_kundlas", { nu, ms, ids: ratt.skriv }) : { kundlas: {} };
      return svar({ status: "ok", konto: s.kontoId, enhet: s.enhet, roll: ratt.roll, ratt_slut: ratt.slut, las_slut: ratt.lasSlut,
        kundlas: bindning.kundlas,
        skrivbara: Array.isArray(ratt.skriv) ? ratt.skriv : undefined,
        enheter: lista.enheter.map((e) => ({ ...e, denna: e.id === s.enhet })) }, 200, fornya);
    }
    if (vag === "/projekt" && m0 === "GET") return svar({ status: "ok", ...(await konto(env, s.kontoId, "p_lista", { nu, ms })) }, 200, fornya);
    if (vag === "/artikelpriser") {
      // Läsning av egna priser tillåts med varje giltig session (även läsperiod); skrivning kräver full skrivrätt.
      if (m0 === "GET") return svar({ status: "ok", ...(await konto(env, s.kontoId, "ap_hamta", { nu })) }, 200, fornya);
      const rev = ifMatch(request);
      if (rev === null) return svar({ status: "if_match_kravs" }, 428, fornya);
      const body = await lasArtikelpriser(request, ms);
      if (body.kod) { const { kod, ...rest } = body; return svar(rest, kod, fornya); }
      const ratt = await rattFor(env, s.kontoId, nu, deps);
      if (ratt.skriv !== "alla") {
        // Ett projektköp ger inte egna standardpriser. Utan skrivrätt får man ändå ta bort egna priser (radering av egna uppgifter, som jobb).
        if (Array.isArray(ratt.skriv)) return svar({ status: "kraver_full_pro" }, 403, fornya);
        const nu0 = await konto(env, s.kontoId, "ap_hamta", { nu }); const fore = new Map(nu0.data.poster.filter((p) => !("raderad_ms" in p)).map((p) => [JSON.stringify([p.nyckel, p.namn, p.enhet]), p.pris_kr]));
        const baraBorttag = rev === nu0.rev && JSON.parse(body.data).poster.filter((p) => !("raderad_ms" in p)).every((p) => fore.get(JSON.stringify([p.nyckel, p.namn, p.enhet])) === p.pris_kr);
        if (!baraBorttag) return svar(ratt.lasSlut && nu < ratt.lasSlut ? { status: "las_endast", las_slut: ratt.lasSlut } : { status: "ingen_ratt" }, 403, fornya);
      }
      const r = await konto(env, s.kontoId, "ap_put", { nu, ms, rev, data: body.data, storlek: body.storlek });
      if (r.kod === 200) return svar({ status: "sparat", rev: r.rev, andrad: r.andrad }, 200, fornya);
      if (r.kod === 409) return svar({ status: "konflikt", server: r.server }, 409, fornya);
      return svar({ status: "ogiltig_kropp" }, 400, fornya);
    }
    if (vag === "/export" && m0 === "GET") {
      const [ratt, ko] = await Promise.all([rattFor(env, s.kontoId, nu, deps), konto(env, s.kontoId, "export", { nu, ms })]);
      return svar({ status: "ok", format: "materialraknaren-pro-konto-export", version: 1, exporterad_ms: ms, konto: s.kontoId,
        ratt: { roll: ratt.roll, ratt_slut: ratt.slut, las_slut: ratt.lasSlut, skrivbara: Array.isArray(ratt.skriv) ? ratt.skriv : null }, ...ko }, 200,
        { ...fornya, "content-disposition": `attachment; filename="materialraknaren-pro-export-${new Date(ms).toISOString().slice(0, 10)}.json"` });
    }
    if ((m = /^\/projekt\/(p_[0-9a-f]{32})\/dokument$/.exec(vag)) && m0 === "POST") {
      const id=m[1],ratt=await rattFor(env,s.kontoId,nu,deps);
      if (ratt.roll !== "projekt" || !Array.isArray(ratt.skriv) || !ratt.skriv.includes(id)) return svar({status:"ingen_ratt"},403,fornya);
      const b=await lasKropp(request);
      if (!b || !Number.isSafeInteger(b.rev) || b.rev<1 || (b.typ !== undefined && !["kund","intern","kontroll"].includes(b.typ))) return svar({status:"ogiltig_kropp"},400,fornya);
      const r=await konto(env,s.kontoId,"p_dokument",{nu,ms,id,rev:b.rev,typ:b.typ ?? "kund"});
      return r.kod === 200 ? svar({status:"ok",kund:r.kund},200,fornya) : svar({status:r.kod === 409 ? "konflikt" : r.kod === 422 ? "kundnamn_saknas" : "hittas_inte",...(r.server ? {server:r.server} : {})},r.kod,fornya);
    }
    if ((m = /^\/projekt\/([^/]+)$/.exec(vag))) {
      const id = m[1];
      if (!PROJ_RE.test(id)) return svar({ status: "hittas_inte" }, 404);
      if (m0 === "GET") {
        const r = await konto(env, s.kontoId, "p_hamta", { nu, ms, id });
        if (r.kod === 200) return svar({ status: "ok", projekt: r.projekt }, 200, fornya);
        if (r.kod === 410) return svar({ status: "raderad", id: r.id, rev: r.rev, raderad_ms: r.raderad_ms }, 410, fornya);
        return svar({ status: "hittas_inte" }, 404, fornya);
      }
      if (m0 === "PUT" || m0 === "DELETE") {
        const rev = ifMatch(request);
        if (rev === null) return svar({ status: "if_match_kravs" }, 428, fornya);
        let body = null;
        if (m0 === "PUT") { body = await lasProjekt(request, id); if (body.kod) { const { kod, ...rest } = body; return svar(rest, kod, fornya); } }
        // Rätt prövas på servern vid varje skrivning. DELETE av eget projekt tillåts även i läsperioden (radering av egna uppgifter).
        let kundBunden = false;
        if (m0 === "PUT") {
          const ratt = await rattFor(env, s.kontoId, nu, deps);
          kundBunden = ratt.roll === "projekt";
          const ok = ratt.skriv === "alla" || (Array.isArray(ratt.skriv) && ratt.skriv.includes(id));
          if (!ok) {
            const inomLas = ratt.lasSlut && nu < ratt.lasSlut;
            return svar(inomLas || Array.isArray(ratt.skriv) ? { status: "las_endast", las_slut: ratt.lasSlut, skrivbara: Array.isArray(ratt.skriv) ? ratt.skriv : [] } : { status: "ingen_ratt" }, 403, fornya);
          }
        }
        const r = m0 === "PUT" ? await konto(env, s.kontoId, "p_put", { nu, ms, id, rev, data: body.data, namn: body.namn, storlek: body.storlek, kundBunden })
          : await konto(env, s.kontoId, "p_del", { nu, ms, id, rev });
        if (r.kod === 200) return svar(m0 === "PUT" ? { status: "sparat", id: r.id, rev: r.rev, andrad: r.andrad } : { status: "raderad", id: r.id, rev: r.rev, raderad_ms: r.raderad_ms }, 200, fornya);
        if (r.kod === 409) return svar({ status: "konflikt", server: r.server }, 409, fornya);
        if (r.kod === 410) return svar({ status: "raderad", id: r.id, rev: r.rev, raderad_ms: r.raderad_ms }, 410, fornya);
        if (r.kod === 413) return svar({ status: r.status, max: r.max }, 413, fornya);
        if (r.kod === 426) return svar({ status: r.status, krav_version: r.krav_version }, 426, fornya);
        if (r.kod === 400) return svar({ status: "ogiltig_kropp" }, 400, fornya);
        return svar({ status: "hittas_inte" }, 404, fornya);
      }
      return svar({ status: "okand_rutt" }, 404, fornya);
    }
    if (vag === "/radera" && m0 === "POST") {
      const b = await lasKropp(request);
      if (!(b && b.bekrafta === true)) return svar({ status: "bekraftelse_kravs" }, 400, fornya);
      if (!(await farskKod(env, b, nu, s.kontoId))) return svar({ status: "farsk_kod_kravs" }, 401, fornya);
      await raderaKonto(env, s.kontoId, nu);
      return svar({ status: "kontot_raderat" }, 200, { "set-cookie": rensaCookie() });
    }
    if (vag === "/agare/pitr" && m0 === "POST") {
      const ratt = await rattFor(env, s.kontoId, nu, deps);
      if (ratt.roll !== "agare") return svar({ status: "ej_agare" }, 403, fornya);
      const b = await lasKropp(request);
      const mal = b && Number.isSafeInteger(b.tid_ms) ? b.tid_ms : null;
      if (!b || !KONTO_RE.test(String(b.konto)) || !mal || mal >= ms || mal < ms - 30 * DAG * 1000) return svar({ status: "ogiltig_begaran" }, 400, fornya);
      if (!(await farskKod(env, b, nu, s.kontoId))) return svar({ status: "farsk_kod_kravs" }, 401, fornya);
      const k = await register(env, "pitr_kontroll", { nu, kontoId: b.konto, mal, enhet: s.enhet });
      if (!k.ok) return svar({ status: k.orsak === "raderat" ? "raderat_konto" : "hittas_inte" }, k.orsak === "raderat" ? 409 : 404, fornya);
      let r; try { r = await konto(env, b.konto, "pitr", { nu, mal }); } catch { r = { ok: false, orsak: "osaker" }; }
      // Efterkontroll: raderades kontot under tiden rensas objektet igen, så att en återställning aldrig återskapar raderade uppgifter.
      const efter = await register(env, "raderat", { nu, kontoId: b.konto });
      if (efter.raderat) { await konto(env, b.konto, "radera", { nu }); await register(env, "logg", { nu, handling: "pitr_rensad_efter_radering", kontoId: b.konto }); return svar({ status: "raderat_konto" }, 409, fornya); }
      await register(env, "logg", { nu, handling: r.ok ? "pitr_planerad" : "pitr_misslyckad", kontoId: b.konto, detalj: r.ok ? r.bokmarke : r.orsak });
      return r.ok ? svar({ status: "aterstallning_planerad", konto: b.konto, tid_ms: mal }, 200, fornya) : svar({ status: "pitr_misslyckades", orsak: r.orsak }, r.orsak === "stods_inte" ? 501 : 502, fornya);
    }
    if (vag.startsWith("/agare/")) return agareRutt(env, request, { vag, m0, nu, s, deps, svar, fornya });
    return svar({ status: "okand_rutt" }, 404, fornya);
  } catch (e) {
    const st = e && e.status === 503 ? 503 : 502;
    return svar({ status: st === 503 ? "konfiguration" : "tillfalligt_fel" }, st);
  }
}

// ---------- K5: ägarytans API /pro/konto/agare/* ----------
// Bara roll "agare" (PRO_OWNER_EMAIL, prövad på servern vid varje anrop), annars 403 ej_agare. Varje ÄNDRING kräver dessutom en färsk
// egen kod (≤10 min, engångs) till ägarens adress, samma mekanism som radera och PITR i K2: { kod } eller { lank } i kroppen,
// annars 401 stegkod. Indata och tillstånd prövas FÖRE kodinlösen (en provning i registret), så att en kod inte förbrukas på ett
// anrop som ändå nekas. Ingen rutt här läser, listar eller exporterar något ur ett kontos objekt (ingen åtkomst till kunders jobb):
// svaren bär bara testplatsens id, etikett, maskerad adress, status och tider.
export function maskera(epost) { // "anna.svensson@exempel.se" → "a***@e***.se"
  const e = normEpost(epost), at = e.lastIndexOf("@"); if (at < 1) return "***";
  const dom = e.slice(at + 1), punkt = dom.lastIndexOf(".");
  return e[0] + "***@" + (dom[0] || "") + "***" + (punkt > 0 ? dom.slice(punkt) : "");
}
const datumSv = (s) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", dateStyle: "long" }).format(new Date(s * 1000));
const AGARE_FEL = { ogiltig: [400, "ogiltig_begaran"], ogiltigt_slut: [400, "ogiltigt_slut"], agaradress: [400, "agarens_adress"], hittas_inte: [404, "hittas_inte"],
  finns_redan: [409, "finns_redan"], fullt: [409, "fullt"], aterkallad: [409, "aterkallad"] };
export const testMejlPa = (env) => !!env && env.PRO_TEST_MEJL === "på"; // gate test_adresser_anders: allt annat än exakt "på" = av

async function skickaTestMejl(env, { till, id, slut, nu }) {
  if (!testMejlPa(env)) return "av";
  const m = mailHttpConfig(env); if (!m.on) return "mejl_av";
  if (!validMailTo(till)) return "ogiltig_mottagare";
  const from = String(env.PRO_MAIL_FROM || "").trim() || m.from.replace(/^[^<]*</, `${MEJL.avsandare_namn} <`);
  const sel = sellerInfo(env), dagar = Math.max(1, Math.round((slut - nu) / DAG));
  const text = fyll(KONTO_TEXT.test, { dagar, slutdatum: datumSv(slut), lank: `${sajt(env)}/verkstaden/materialraknaren/offert`, kontakt: sel.email || "", saljare: sellerLines(sel).join("\n") });
  const ut = await sendViaHttp(env, { req: buildMailRequest({ from, to: till, subject: fyll(KONTO_TEXT.test_amne, { dagar }), text }), idemKey: `pro-konto-test-${id}-${slut}` });
  return ut.ok ? "skickat" : "fel";
}

async function agareRutt(env, request, { vag, m0, nu, s, deps, svar, fornya }) {
  const ratt = await rattFor(env, s.kontoId, nu, deps);
  if (ratt.roll !== "agare") return svar({ status: "ej_agare" }, 403, fornya);
  const fel = (r) => { const [k, st] = AGARE_FEL[r.fel] || [400, "ogiltig_begaran"]; return svar({ status: st, ...(r.max ? { max: r.max } : {}), ...(r.id ? { id: r.id } : {}) }, k, fornya); };
  if (vag === "/agare/testplatser" && m0 === "GET") return svar({ status: "ok", ...(await register(env, "tp_lista", { nu })) }, 200, fornya);
  const b = await lasKropp(request);
  if (!b) return svar({ status: "ogiltig_begaran" }, 400, fornya);
  const agareEpost = normEpost(env.PRO_OWNER_EMAIL);
  const stegkod = typeof b.lank === "string" ? { lank: b.lank } : { epost: agareEpost, kod: b.kod };
  let op, data, mottagare = null;
  if (vag === "/agare/inbjud") {
    const epost = normEpost(b.epost);
    if (!validMailTo(epost)) return svar({ status: "ogiltig_adress" }, 400, fornya);
    const slut = b.slut === undefined || b.slut === null ? nu + TEST_STD_S : b.slut;
    op = "tp_inbjud"; mottagare = epost;
    data = { nu, ehash: await epostHash(env, epost), maskad: maskera(epost), etikett: b.etikett, slut, agareEhash: validMailTo(agareEpost) ? await epostHash(env, agareEpost) : null };
  } else if (vag === "/agare/forlang") {
    if (!/^t_[0-9a-f]{16}$/.test(String(b.id))) return svar({ status: "hittas_inte" }, 404, fornya);
    op = "tp_forlang"; data = { nu, id: b.id, slut: b.slut };
  } else if (vag === "/agare/aterkalla") {
    if (!/^t_[0-9a-f]{16}$/.test(String(b.id))) return svar({ status: "hittas_inte" }, 404, fornya);
    op = "tp_aterkalla"; data = { nu, id: b.id };
  } else return svar({ status: "okand_rutt" }, 404, fornya);
  const prov = await register(env, op, { ...data, provning: true });
  if (!prov || prov.fel) return fel(prov || {});
  if (!(await farskKod(env, stegkod, nu, s.kontoId))) return svar({ status: "stegkod" }, 401, fornya);
  const r = await register(env, op, data);
  if (!r || r.fel) return fel(r || {});
  if (op === "tp_inbjud") {
    const mejl = await skickaTestMejl(env, { till: mottagare, id: r.testplats.id, slut: r.testplats.slut, nu }).catch(() => "fel");
    return svar({ status: "inbjuden", testplats: r.testplats, ateraktiverad: r.ateraktiverad, mejl }, 200, fornya);
  }
  return svar({ status: op === "tp_forlang" ? "forlangd" : r.redan ? "redan_aterkallad" : "aterkallad", testplats: r.testplats }, 200, fornya);
}

// ---------- K2: cron i befintlig scheduled() ----------
// Off: returnerar direkt, inga bindningar, mejl eller nät. Inbjudna: (1) efterrensning av raderade konton, (2) avisering 90 d efter att
// rätten upphört (mejl till kontots egen adress), (3) radering 14 d efter avisering. Högst SCHEMA_MAX konton per steg och körning.
export async function kontoSchema(env, { now = () => Date.now(), fetchImpl = fetch, aktivPren = null, proMode = () => "off" } = {}) {
  if (kontoLage(env) === "off") return { ok: true, av: true };
  const nu = Math.floor(now() / 1000), rapport = { rensade: 0, aviserade: 0, raderade: 0, fel: [] };
  const per = async (namn, f) => { try { await f(); } catch (e) { rapport.fel.push(namn + ":" + ((e && e.message) || "fel")); } };
  await per("rensa", async () => {
    for (const kontoId of (await register(env, "orensade", { nu })).konton) await per("rensa1", async () => {
      const k = await konto(env, kontoId, "radera", { nu }); if (k && k.ok) { await register(env, "markera_rensad", { nu, kontoId }); rapport.rensade++; }
    });
  });
  const agare = validMailTo(normEpost(env.PRO_OWNER_EMAIL)) ? await epostHash(env, env.PRO_OWNER_EMAIL) : null;
  const betalning = proMode(env) !== "off";
  const f = await register(env, "forfallna", { nu, agareEhash: agare, betalning });
  const harPren = async (x) => betalning && (await rattFor(env,x.kontoId,nu,{aktivPren,proMode,fetchImpl})).roll === "pren";
  for (const x of f.avisera) await per("avisera", async () => {
    if (await harPren(x)) return;
    const { epost } = await konto(env, x.kontoId, "epost_las", { nu });
    if (epost) {
      const m = mailHttpConfig(env); if (!m.on) throw new Error("mejl_av"); // ingen markering: försök igen nästa körning
      const from = String(env.PRO_MAIL_FROM || "").trim() || m.from.replace(/^[^<]*</, `${MEJL.avsandare_namn} <`);
      const datum = new Date((nu + RADERA_EFTER_AVISERING_S) * 1000).toISOString().slice(0, 10);
      const ut = await sendViaHttp(env, { req: buildMailRequest({ from, to: epost, subject: KONTO_TEXT.avisering_amne,
        text: fyll(KONTO_TEXT.avisering, { datum, lank: `${sajt(env)}/verkstaden/materialraknaren/offert` }) }), idemKey: `pro-konto-avisering-${x.kontoId}-${x.senast_slut}` });
      if (!ut.ok) throw new Error("mejl:" + (ut.code || ut.kind));
    }
    await register(env, "markera_aviserad", { nu, kontoId: x.kontoId }); rapport.aviserade++;
  });
  for (const x of f.radera) await per("radera", async () => {
    if (await harPren(x)) return;
    await raderaKonto(env, x.kontoId, nu); rapport.raderade++;
  });
  return { ok: rapport.fel.length === 0, ...rapport };
}
