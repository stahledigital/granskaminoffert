// D7.2 (Claude Code, MR-FORTNOX-SPIRIS-20261023-01, KP-2026-10-16-01): koppling mellan PRO-kontot och användarens eget Fortnox- eller Spiris-bolag.
// Steg 1: OAuth (state + PKCE S256), krypterade token (AES-GCM, nyckeln INTEGRATION_TOKEN_KEY) och status/koppla från. Allt lagras i kontots
// ProKonto-objekt (jurisdiktion "eu"); inget i KV, webbläsaren eller loggar. Leverantörsadresser och scopes ur INTEGRATION_FORTNOX_SPIRIS.md
// (källor 2026-10-23) – de verifieras mot sandlåda/licens i steg 2 innan något påstås fungera. Inga anrop görs utan konfigurerade nycklar (I01).
import { freezeOfferExport, planOfferTransfer } from "./mr_project2/EXPORTER/offert-export.mjs"; // C10 f960812 (kopia, hashlåst i test)
import { proSite, proPublicUrl } from "./pro_public_url.js";
export const LEV = Object.freeze({
  fortnox: Object.freeze({ namn: "Fortnox", id: "FORTNOX_CLIENT_ID", secret: "FORTNOX_CLIENT_SECRET",
    auth: "https://apps.fortnox.se/oauth-v1/auth", token: "https://apps.fortnox.se/oauth-v1/token", revoke: null,
    scope: "companyinformation customer article offer", extra: { access_type: "offline" },
    bolag: "https://api.fortnox.se/3/companyinformation", bolagLas: (j) => j && j.CompanyInformation && { tenant: String(j.CompanyInformation.OrganizationNumber || ""), namn: String(j.CompanyInformation.CompanyName || "") } }),
  spiris: Object.freeze({ namn: "Spiris", id: "SPIRIS_CLIENT_ID", secret: "SPIRIS_CLIENT_SECRET",
    auth: "https://identity.vismaonline.com/connect/authorize", token: "https://identity.vismaonline.com/connect/token", revoke: "https://identity.vismaonline.com/connect/revocation",
    scope: "ea:api ea:sales offline_access", extra: { prompt: "select_account" },
    bolag: "https://eaccountingapi.vismaonline.com/v2/companysettings", bolagLas: (j) => j && { tenant: String(j.CorporateIdentityNumber || ""), namn: String(j.Name || "") } }),
});
export const STATE_S = 600, ORIGIN = "https://stahledigital.se";
const ENC = new TextEncoder(), DEC = new TextDecoder();
const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fran64 = (s) => Uint8Array.from(atob(String(s)), (c) => c.charCodeAt(0));
const slump = (n) => crypto.getRandomValues(new Uint8Array(n));
// Spiris har registrerat nya domänen. Fortnox behåller sin adress tills dess
// separata portalregistrering är verifierad; inga nya runtime-inställningar behövs.
const nySpirisSajt = (p, env) => p === "spiris" && proSite(env) === "https://materialraknaren.se";
export const callbackUrl = (p, env) => `${nySpirisSajt(p, env) ? "https://materialraknaren.se" : ORIGIN}/api/pro/konto/integration/${p}/callback`;
export const ledig = (p) => Object.prototype.hasOwnProperty.call(LEV, p);

// Konfigurerad = båda klientnycklarna och krypteringsnyckeln finns. Värdena läses aldrig ut eller loggas; saknas något görs inga anrop (I01).
export function konfigurerad(env, p) {
  const L = LEV[p]; if (!L || !env) return false;
  const ok = (v) => typeof v === "string" && v.length > 0;
  return ok(env[L.id]) && ok(env[L.secret]) && ok(env.INTEGRATION_TOKEN_KEY);
}

// AES-GCM 256: nyckeln är 32 byte base64 (LAGG_IN_FORTNOX_SPIRIS.command). AAD binder chiffret till konto och leverantör, så att ett
// chiffer aldrig kan flyttas till ett annat konto eller en annan leverantör. Unik IV per lagring.
async function nyckel(env) {
  const r = fran64(env.INTEGRATION_TOKEN_KEY);
  if (r.length !== 32) { const e = new Error("krypteringsnyckel"); e.status = 503; throw e; }
  return crypto.subtle.importKey("raw", r, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function kryptera(env, kontoId, p, obj) {
  const iv = slump(12), c = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ENC.encode(`${kontoId}|${p}`) }, await nyckel(env), ENC.encode(JSON.stringify(obj)));
  return { iv: b64u(iv), chiffer: b64u(new Uint8Array(c)) };
}
export async function dekryptera(env, kontoId, p, { iv, chiffer }) {
  const f = (s) => fran64(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4));
  const t = await crypto.subtle.decrypt({ name: "AES-GCM", iv: f(iv), additionalData: ENC.encode(`${kontoId}|${p}`) }, await nyckel(env), f(chiffer));
  return JSON.parse(DEC.decode(t));
}

// OAuth-start: state (32 byte) och PKCE-verifierare sparas i kontots objekt med 10 min livslängd; adressen byggs med exakt registrerad callback.
export async function startUrl(env, p, { state, verifier }) {
  const L = LEV[p], ch = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", ENC.encode(verifier))));
  const q = new URLSearchParams({ client_id: env[L.id], redirect_uri: callbackUrl(p, env), response_type: "code", scope: L.scope, state, code_challenge: ch, code_challenge_method: "S256", ...L.extra });
  return `${L.auth}?${q}`;
}
export const nyState = () => ({ state: b64u(slump(32)), verifier: b64u(slump(48)) });

// Tokenväxling och -förnyelse med klientautentisering (Basic) mot leverantörens tokenadress. Svarar null vid fel; aldrig token i logg eller svar.
async function tokenAnrop(env, p, form, fetchImpl) {
  const L = LEV[p], basic = btoa(`${env[L.id]}:${env[L.secret]}`);
  let r; try { r = await fetchImpl(L.token, { method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams(form).toString() }); }
  catch { return null; }
  if (!r || !r.ok) return null;
  let j; try { j = await r.json(); } catch { return null; }
  if (!j || typeof j.access_token !== "string" || typeof j.refresh_token !== "string") return null;
  const exp = Number(j.expires_in);
  return { access: j.access_token, refresh: j.refresh_token, utgar: Number.isFinite(exp) && exp > 0 ? exp : 3600 };
}
export const vaxlaKod = (env, p, { kod, verifier }, fetchImpl) => tokenAnrop(env, p, { grant_type: "authorization_code", code: kod, redirect_uri: callbackUrl(p, env), code_verifier: verifier }, fetchImpl);
export const fornya = (env, p, refresh, fetchImpl) => tokenAnrop(env, p, { grant_type: "refresh_token", refresh_token: refresh }, fetchImpl);

// Bolaget som användaren valde hos leverantören (visas i PRO; I04). Saknas ett identifierande bolag sparas ingen koppling.
export async function lasBolag(p, access, fetchImpl) {
  const L = LEV[p];
  let r; try { r = await fetchImpl(L.bolag, { headers: { Authorization: `Bearer ${access}`, Accept: "application/json" } }); } catch { return null; }
  if (!r || !r.ok) return null;
  let j; try { j = await r.json(); } catch { return null; }
  const b = L.bolagLas(j);
  return b && b.tenant && b.namn ? { tenant: b.tenant.slice(0, 40), namn: b.namn.normalize("NFC").trim().slice(0, 120) } : null;
}

// Koppla från: återkallning hos leverantören bara där den är dokumenterad (Spiris); lokal radering sker alltid (I17).
export async function aterkalla(env, p, refresh, fetchImpl) {
  const L = LEV[p]; if (!L.revoke || !refresh) return "ej_dokumenterad";
  try { const r = await fetchImpl(L.revoke, { method: "POST", headers: { Authorization: `Basic ${btoa(`${env[L.id]}:${env[L.secret]}`)}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: refresh, token_type_hint: "refresh_token" }).toString() }); return r && r.ok ? "aterkallad" : "fel"; }
  catch { return "fel"; }
}

// Routes under /pro/konto/integration/* (anropas från kontoInre med giltig session; kontoId bara ur sessionen).
export const INTEGRATION_METODER = { "/integration/status": ["GET"],
  ...Object.fromEntries(Object.keys(LEV).flatMap((p) => [[`/integration/${p}/start`, ["POST"]], [`/integration/${p}/callback`, ["GET"]], [`/integration/${p}/koppla-fran`, ["POST"]], [`/integration/${p}/forbered`, ["POST"]]])) };
// Steg 1–2: tillbaka till ägarsidan, där panelen finns så länge integrationen bara är ägarens (se spärren i pro_konto.js).
const tillbaka = (env, p, resultat) => {
  const path = nySpirisSajt(p, env) ? proPublicUrl(env, "/konto/agare") : "/verkstaden/materialraknaren/konto/agare";
  return new Response(null, { status: 303, headers: { Location: `${path}?integration=${p}&resultat=${resultat}#integration`, "Cache-Control": "no-store" } });
};

export async function integrationRoute(vag, m0, url, env, s, { konto, nu, fetchImpl, svar, kropp = null }) {
  if (vag === "/integration/status") {
    const l = await konto(env, s.kontoId, "int_lista", { nu });
    const kopplad = Object.fromEntries((l.kopplingar || []).map((k) => [k.provider, { bolag: k.tenant_namn, sedan: k.skapad }]));
    return svar({ status: "ok", leverantorer: Object.fromEntries(Object.keys(LEV).map((p) => [p, { namn: LEV[p].namn, konfigurerad: konfigurerad(env, p), kopplad: kopplad[p] || null }])) });
  }
  const m = /^\/integration\/([a-z]+)\/(start|callback|koppla-fran|forbered)$/.exec(vag), p = m && m[1];
  if (!m || !ledig(p)) return svar({ status: "okand_rutt" }, 404);
  if (m[2] === "forbered") return forbered(env, s, p, kropp, { konto, nu, svar });
  if (m[2] === "koppla-fran") {
    const h = konfigurerad(env, p) ? await konto(env, s.kontoId, "int_hamta", { nu, provider: p }) : null;
    let aterkallning = "ej_kopplad";
    if (h && h.ok) { try { const t = await dekryptera(env, s.kontoId, p, h); aterkallning = await aterkalla(env, p, t.refresh, fetchImpl); } catch { aterkallning = "fel"; } }
    const r = await konto(env, s.kontoId, "int_ta_bort", { nu, provider: p });
    return svar({ status: "frankopplad", fanns: !!(r && r.fanns), aterkallning });
  }
  if (!konfigurerad(env, p)) return m[2] === "callback" ? tillbaka(env, p, "ej_konfigurerad") : svar({ status: "ej_konfigurerad", provider: p }, 503);
  if (m[2] === "start") {
    const st = nyState();
    const r = await konto(env, s.kontoId, "int_state_ny", { nu, provider: p, state: st.state, verifier: st.verifier });
    if (!r || !r.ok) return svar({ status: "for_manga_forsok" }, 429);
    return svar({ status: "ok", url: await startUrl(env, p, st) });
  }
  // callback: state förbrukas atomiskt (en gång, rätt leverantör, inom 10 min); fel/avbrott sparar ingenting (I02).
  const state = url.searchParams.get("state") || "", kod = url.searchParams.get("code") || "";
  if (url.searchParams.get("error") || !/^[A-Za-z0-9_-]{43}$/.test(state) || !kod || kod.length > 2048) {
    if (/^[A-Za-z0-9_-]{43}$/.test(state)) await konto(env, s.kontoId, "int_state_los", { nu, state, provider: p });
    return tillbaka(env, p, "avbruten");
  }
  const l = await konto(env, s.kontoId, "int_state_los", { nu, state, provider: p });
  if (!l || !l.ok) return tillbaka(env, p, "ogiltig");
  const t = await vaxlaKod(env, p, { kod, verifier: l.verifier }, fetchImpl);
  if (!t) return tillbaka(env, p, "fel");
  const b = await lasBolag(p, t.access, fetchImpl);
  if (!b) return tillbaka(env, p, "fel");
  const c = await kryptera(env, s.kontoId, p, { access: t.access, refresh: t.refresh, utgar: nu + t.utgar });
  const r = await konto(env, s.kontoId, "int_spara", { nu, provider: p, tenant: b.tenant, tenant_namn: b.namn, ...c });
  return tillbaka(env, p, r && r.ok ? "kopplad" : "fel");
}

// Steg 1 ”export och kvitto”: det SPARADE projektet (aldrig klientens belopp) fryses på servern med C10, planeras mot kontots kvittologg för
// leverantör + bolag och reserveras atomiskt (en reservation per offert-ID och version; I12). Inget skapas hos leverantören här – det är steg 2,
// som också kräver bolagets kund-, artikel- och momsuppslag (I06). En gammal oklar reservation kringgås aldrig (RECONCILE).
async function forbered(env, s, p, kropp, { konto, nu, svar }) {
  const id = kropp && kropp.projektId;
  if (!/^p_[0-9a-f]{32}$/.test(String(id))) return svar({ status: "hittas_inte" }, 404);
  const k = await konto(env, s.kontoId, "int_hamta", { nu, provider: p });
  if (!k || !k.ok) return svar({ status: "ej_kopplad", provider: p }, 409);
  const ph = await konto(env, s.kontoId, "p_hamta", { nu, ms: nu * 1000, id });
  if (!ph || ph.kod !== 200 || !ph.projekt || ph.projekt.data === null) return svar({ status: "hittas_inte" }, 404);
  const fr = await freezeOfferExport(ph.projekt.data);
  if (!fr.ok) return svar({ status: "ej_klar", kod: fr.code }, 422);
  const { offerId, offerVersion } = fr.offer.identity, sha256 = fr.offer.sha256;
  const kv = await konto(env, s.kontoId, "int_kvitton", { nu, provider: p, tenant: k.tenant });
  const plan = await planOfferTransfer(fr.offer, { provider: p, tenantId: k.tenant, receipts: kv.kvitton || [], allowNewVersion: !!(kropp && kropp.nyVersion === true) });
  if (!plan.ok) return svar({ status: "ej_klar", kod: plan.code }, 422);
  const ut = { offerId, offerVersion, sha256 };
  if (plan.status !== "READY_TO_PREPARE") return svar({ status: plan.status.toLowerCase(), ...ut, remoteId: plan.remoteId || null }, plan.status === "ALREADY_EXPORTED" ? 200 : 409);
  const r = await konto(env, s.kontoId, "int_reservera", { nu, provider: p, tenant: k.tenant, offerId, offerVersion, sha256 });
  return r && r.ok ? svar({ status: "forberedd", ...ut }) : svar({ status: "reconcile", ...ut }, 409); // kapplöpning: en annan enhet hann först
}

