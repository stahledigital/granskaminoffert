// Materialräknaren PRO – projektdata lokalt (stödkandidat P4, Claude, 2026-10-17). WORK-ID KP-2026-10-16-01.
// Lagring i webbläsaren (localStorage `mr-pro-v1`, inloggad: `mr-pro-v1:<kontoId>` via kontots lagringsadapter, K4) och JSON-fil.
// K4: när kontot är på skickar synkmotorn (P7_ARBETSYTA/konto.js) projektet till kontot; P4 självt pratar aldrig med en server.
// Mängder kommer alltid ur räknarens lista (sammanstall-artiklar); PRO ändrar dem aldrig (samma princip som D59).
// Användarens egna priser, val och extra rader bevaras när listan ändras. Strikt validering före lagring och import.

export const LAGRING_NYCKEL = "mr-pro-v1";
export const FORMAT = "materialraknaren-pro-projekt";
export const VERSION = 1;
const MAX_BYTE = 256 * 1024, MAX_RADER = 500, MAX_TEXT = 200, MAX_PROJEKT = 50;
const byteLength = s => new TextEncoder().encode(s).length;
const KR_RE = /^\d{1,9}(?:\.\d{1,2})?$/, PCT_RE = /^\d{1,3}(?:\.\d{1,4})?$/, TAL_RE = /^\d{1,7}(?:\.\d{1,4})?$/, ID_RE = /^p_[0-9a-f]{32}$/;
// ROT-konfiguration (T4): procentsats och tak är konfiguration, inte kod. Källa: Modesty S2d KALLOR_S2D.md (Skatteverket, läst 2026-10-17).
// R12: procent/tak återkontrollerade hos Skatteverket 2026-10-19; betaldagen och kundens egna villkor avgör slutlig rätt.
export const ROT_KONFIG = Object.freeze({ pct: "30", cap_rot_kr: "50000", cap_total_kr: "75000", kalla: "Skatteverket, Så fungerar rotavdraget, 2026-10-19" });

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
export function nyttProjektId(cryptoImpl = globalThis.crypto) { const a = new Uint8Array(16); cryptoImpl.getRandomValues(a); return "p_" + hex(a); }
export function kod(projektId) { // kort kod för sidfoten: 4 tecken ur id:t, utan förväxlingsbara tecken
  const alfa = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let n = parseInt(String(projektId).slice(2, 12), 16), s = "";
  for (let i = 0; i < 4; i++) { s += alfa[n % 32]; n = Math.floor(n / 32); } return s;
}
const STYR = new RegExp("[" + [[0x0, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069]].map(([a, b]) => String.fromCharCode(92) + "u" + a.toString(16).padStart(4, "0") + "-" + String.fromCharCode(92) + "u" + b.toString(16).padStart(4, "0")).join("") + "]", "g");
const ren = (v, max = MAX_TEXT) => (typeof v === "string" ? v.normalize("NFC").replace(STYR, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const talStr = (n) => { const x = Number(n); return Number.isFinite(x) && x >= 0 ? String(Math.round(x * 10000) / 10000) : "0"; };

// Offerten gäller 30 dagar om användaren inte ändrar giltighetsdatumet.
const plusDagar = (d, n) => { const t = Date.parse(String(d) + "T12:00:00Z"); return Number.isFinite(t) ? new Date(t + n * 86400000).toISOString().slice(0, 10) : ""; };
export function nyttProjekt({ idag, cryptoImpl } = {}) {
  const id = nyttProjektId(cryptoImpl);
  return { format: FORMAT, version: VERSION, projektId: id, kod: kod(id), revision: 1, skapad: idag, andrad: idag,
    projektnamn: "", datum: idag, giltig_till: plusDagar(idag, 30), foretag: { namn: "", orgnr: "", adress: "", epost: "", telefon: "" }, kund: { namn: "" },
    val: { datum: true, kund: true, projekt: true, arbete: true, rot: false, avgransning: false, ursprung: false, material_specifikation: false },
    moms: "25", material: [], varningar: [], arbete: [], ovrigt: [], orderrabatt: null,
    rot: { bekraftat: false, arbete: "reparation_underhall", smahus_5ar: "ej_smahus", agare: true, timmar_dokumenterade: true, resa_behovs: false, kopare: [{ id: "k1", andel: "100", rot_anvant: null, rut_anvant: null }] } };
}

// Slår ihop räknarens artiklar (sammanstall().artiklar) med projektets material. Nyckel = prisnyckel eller namn.
// Mängd och enhet kommer ALLTID från listan. Egna priser, rabatter, påslag och "med i offerten" bevaras. Rader som inte längre finns
// i listan markeras borta (visas för användaren, ingår inte i kalkylen) i stället för att raderas tyst.
const nyckelAv = (a) => (a.nyckel ? "n:" + a.nyckel : "k:" + ren(a.namn)) + "|" + ren(a.enhet, 20);
// Hur väl en ny lista passar ett befintligt projekt (0–1): andel gemensamma rader räknat på den mindre av de två mängderna.
// Tomt projekt eller tom lista = 1. Arbetsytan lägger en lista som inte passar (< 0,5) i ett nytt projekt (granskningsfynd A1).
export function listansAndel(projekt, artiklar) {
  const har = new Set((projekt && projekt.material || []).filter((m) => !m.egen && !m.borta).map((m) => m.nyckel));
  const nya = new Set((artiklar || []).filter((a) => a && Number(a.antal) > 0).map(nyckelAv));
  if (!har.size || !nya.size) return 1;
  let gem = 0; for (const k of nya) if (har.has(k)) gem++;
  return gem / Math.min(har.size, nya.size);
}
// Egen materialrad (Anders beslut materialval steg 1, 2026-10-17): material som räknaren inte räknar fram. Byggaren anger namn, mängd och
// enhet själv; raden får ett lokalt id (m: + namn + enhet), märks egen och ej beräknad, och ligger kvar när listan ändras. Ingen mängd antas.
export function egenRad({ namn, mangd, enhet } = {}) {
  const n = ren(namn), e = ren(enhet, 20), q = String(mangd ?? "").trim().replace(/\s/g, "").replace(",", ".");
  if (!n || !e || !TAL_RE.test(q) || !(Number(q) > 0)) return null;
  return { nyckel: "m:" + n.toLowerCase() + "|" + e.toLowerCase(), namn: n, mangd: talStr(q), enhet: e, med: true, pris_kr: null, rabatt_pct: "0", rabatt_kr: null, paslag_pct: "0",
    riktpris_kr: null, borta: false, egen: true, ursprung: "egen" };
}
export function slaIhopMedLista(projekt, artiklar, { varningar } = {}) {
  // A price key may cover several physical lengths. Match the named article within that group;
  // a group price key is not enough to identify a physical size. Keep unmatched rows as borta.
  const fore = new Map();
  for (const m of projekt.material.filter((m) => !m.egen)) { if (!fore.has(m.nyckel)) fore.set(m.nyckel, []); fore.get(m.nyckel).push(m); }
  const nya = [];
  for (const a of artiklar || []) {
    if (!(Number(a.antal) > 0)) continue;
    const k = nyckelAv(a), grupp = fore.get(k) || [];
    const index = grupp.findIndex((m) => ren(m.namn) === ren(a.namn));
    const f = index >= 0 ? grupp.splice(index, 1)[0] : null;
    nya.push({ nyckel: k, namn: ren(a.namn), mangd: talStr(a.antal), enhet: ren(a.enhet, 20), med: f ? f.med : a.alt !== "B", // alternativ B (t.ex. torrbetong i stället för beställd betong) är inte med från början: annars räknas samma sak två gånger
      pris_kr: f ? f.pris_kr : Number(a.summaMedian) > 0 ? (Math.round(Number(a.summaMedian) / Number(a.antal)) / 100).toFixed(2) : null, pris_ursprung: f ? f.pris_ursprung || "egen" : Number(a.summaMedian) > 0 ? "riktpris" : "egen", rabatt_pct: f ? f.rabatt_pct : "0", rabatt_kr: f ? f.rabatt_kr : null, paslag_pct: f ? f.paslag_pct : "0",
      riktpris_kr: Number(a.summaMedian) > 0 && Number(a.antal) > 0 ? (Math.round(Number(a.summaMedian) / Number(a.antal)) / 100).toFixed(2) : f ? f.riktpris_kr : null, borta: false });
    if (!grupp.length) fore.delete(k);
  }
  for (const grupp of fore.values()) for (const f of grupp) nya.push({ ...f, borta: true });
  return { ...projekt, ...(Array.isArray(varningar) ? { varningar: varningar.filter((v) => typeof v === "string").map((v) => ren(v, 1000)).slice(0, 10) } : {}), material: [...nya, ...projekt.material.filter((m) => m.egen)] };
}

export function validera(p) {
  const fel = []; const f = (c, t) => { if (!c) fel.push(t); };
  f(p && typeof p === "object", "inte ett objekt"); if (fel.length) return { ok: false, fel };
  if (p.varningar !== undefined) f(Array.isArray(p.varningar) && p.varningar.length <= 10 && p.varningar.every((v) => typeof v === "string" && v.length <= 1000), "ogiltiga beräkningsvarningar");
  f(p.format === FORMAT, "fel format"); f(p.version === VERSION, "fel version"); f(ID_RE.test(String(p.projektId)), "ogiltigt projektId");
  f(PCT_RE.test(String(p.moms)), "ogiltig moms");
  const arbetsplan=p.val&&Object.getOwnPropertyDescriptor(p.val,"intern_arbetsplan");
  f(!arbetsplan||Object.hasOwn(arbetsplan,"value")&&typeof arbetsplan.value==="boolean", "internt underlag: arbetsplan måste vara ett ja/nej-val");
  for (const [n, m] of (p.material || []).entries()) {
    f(typeof m.namn === "string" && m.namn.length <= MAX_TEXT, `material ${n}: namn`); f(TAL_RE.test(String(m.mangd)), `material ${n}: mängd`);
    f(m.pris_kr === null || KR_RE.test(String(m.pris_kr)), `material ${n}: pris (högst 2 decimaler)`);
    f(m.rabatt_kr === null || m.rabatt_kr === undefined || KR_RE.test(String(m.rabatt_kr)), `material ${n}: rabatt kr`);
    f(PCT_RE.test(String(m.rabatt_pct ?? "0")) && Number(m.rabatt_pct ?? 0) <= 100, `material ${n}: rabatt %`); f(PCT_RE.test(String(m.paslag_pct ?? "0")), `material ${n}: påslag %`);
  }
  for (const [n, a] of (p.arbete || []).entries()) {
    f(typeof a.namn === "string" && a.namn.length <= MAX_TEXT, `arbete ${n}: namn`);
    f(a.rot_berattigad === undefined || typeof a.rot_berattigad === "boolean", `arbete ${n}: ROT-val`);
    for (const k of ["personer", "dagar", "timmar_per_dag"]) f(TAL_RE.test(String(a[k])), `arbete ${n}: ${k}`);
    f(a.timpris_kr === null || KR_RE.test(String(a.timpris_kr)), `arbete ${n}: timpris`); f(a.kostnad_kr === null || a.kostnad_kr === undefined || KR_RE.test(String(a.kostnad_kr)), `arbete ${n}: kostnad`);
  }
  for (const [n, o] of (p.ovrigt || []).entries()) { f(["freight", "travel"].includes(o.typ), `övrigt ${n}: typ`); f(o.pris_kr === null || KR_RE.test(String(o.pris_kr)), `övrigt ${n}: pris`); }
  f((p.material || []).length + (p.arbete || []).length + (p.ovrigt || []).length <= MAX_RADER, "för många rader");
  if (p.orderrabatt) f(("pct" in p.orderrabatt && PCT_RE.test(String(p.orderrabatt.pct))) || ("kr" in p.orderrabatt && KR_RE.test(String(p.orderrabatt.kr))), "ogiltig orderrabatt");
  f(p.val?.rot !== true || ["reparation_underhall", "ombyggnad_tillbyggnad", "nybyggnad"].includes(p.rot?.arbete), "ROT: arbetstyp");
  f(p.val?.rot !== true || ["ja", "nej", "okant", "ej_smahus"].includes(p.rot?.smahus_5ar), "ROT: femårsregel");
  f(p.rot?.bekraftat === undefined || typeof p.rot.bekraftat === "boolean", "ROT: villkor");
  const ko = (p.rot && p.rot.kopare) || []; f(ko.length >= 1 && ko.length <= 4, "1–4 köpare");
  for (const k of ko) f(PCT_RE.test(String(k.andel)) && (k.rot_anvant === null || KR_RE.test(String(k.rot_anvant))) && (k.rut_anvant === null || KR_RE.test(String(k.rut_anvant))), "köpare: andel/använt");
  for (const k of ["projektnamn"]) f(typeof p[k] === "string" && p[k].length <= MAX_TEXT, k);
  return { ok: fel.length === 0, fel };
}

// Projekt → kalkylindata för P1 offert() (typ quote_rot).
export function tillKalkyl(p, rotKonfig = ROT_KONFIG) {
  const rows = [];
  p.material.filter((m) => m.med && !m.borta).forEach((m, i) => rows.push({ id: "m" + (i + 1), kind: "material", label: m.namn, qty: m.mangd, unit: m.enhet,
    price_kr: m.pris_kr, discount_pct: m.rabatt_pct || "0", discount_fixed_kr: m.rabatt_kr || null, markup_pct: m.paslag_pct || "0", ...(m.egen ? { egen: true } : {}) }));
  p.arbete.forEach((a, i) => rows.push({ id: "a" + (i + 1), kind: "labor", label: a.namn, persons: a.personer, days: a.dagar, hours_per_day: a.timmar_per_dag,
    manual_hours: a.manuella_timmar ?? null, ...(a.kostnad_kr ? { rate_kr: null, cost_rate_kr: a.kostnad_kr, markup_pct: a.paslag_pct ?? null } : { rate_kr: a.timpris_kr }),
    rot_eligible: a.rot_berattigad === true, discount_pct: a.rabatt_pct || "0", discount_fixed_kr: a.rabatt_kr || null }));
  p.ovrigt.forEach((o, i) => rows.push({ id: "f" + (i + 1), kind: o.typ, label: o.namn, price_kr: o.pris_kr }));
  const r = p.rot;
  return { type: "quote_rot", vat_pct: p.moms, rows, rot: { pct: rotKonfig.pct, cap_rot_kr: rotKonfig.cap_rot_kr, cap_total_kr: rotKonfig.cap_total_kr },
    work: { eligibility_confirmed: p.val.rot ? r.bekraftat === true : undefined, kind: r.arbete, small_house_within_5y: r.smahus_5ar, buyer_owner: r.agare === true, hours_documented: r.timmar_dokumenterade, travel_needed: r.resa_behovs },
    buyers: r.kopare.map((k) => ({ id: k.id, share_pct: k.andel, rot_used_kr: k.rot_anvant, rut_used_kr: k.rut_anvant })),
    ...(p.orderrabatt ? { order_discount: "pct" in p.orderrabatt ? { pct: p.orderrabatt.pct } : { fixed_kr: p.orderrabatt.kr } } : {}) };
}

export function exportera(p) {
  const v = validera(p); if (!v.ok) throw new Error("ogiltigt projekt: " + v.fel.join("; "));
  // Whitespace is optional JSON syntax; preserve old small exports byte for byte.
  // A file we return must fit the same UTF-8 limit as our own importer.
  const compact = JSON.stringify(p);
  if (byteLength(compact) > MAX_BYTE) throw new Error("filen är för stor eller inte text");
  const pretty = JSON.stringify(p, null, 1);
  return byteLength(pretty) > MAX_BYTE ? compact : pretty;
}
export function importera(text) {
  if (typeof text !== "string" || byteLength(text) > MAX_BYTE) return { ok: false, fel: ["filen är för stor eller inte text"] };
  let p; try { p = JSON.parse(text); } catch { return { ok: false, fel: ["filen är inte ett giltigt projekt"] }; }
  const v = validera(p); return v.ok ? { ok: true, projekt: p } : { ok: false, fel: v.fel };
}

// Lagring: alla projekt i en post. Läs- och skrivfel (privat läge, full lagring) ger tydligt fel, aldrig tyst förlust.
export function laddaAlla(storage) {
  try { const raw = storage.getItem(LAGRING_NYCKEL); if (!raw) return { ok: true, projekt: [] };
    const o = JSON.parse(raw); const lista = Array.isArray(o && o.projekt) ? o.projekt : [];
    const giltiga = lista.filter((p) => validera(p).ok); return { ok: true, projekt: giltiga, kasserade: lista.length - giltiga.length };
  } catch (e) { return { ok: false, fel: "lagringen kunde inte läsas", projekt: [] }; }
}
export function taBort(storage, projektId) {
  const alla = laddaAlla(storage); if (!alla.ok) return { ok: false, fel: [alla.fel] };
  const ovr = alla.projekt.filter((x) => x.projektId !== projektId); if (ovr.length === alla.projekt.length) return { ok: true, borttaget: false };
  try { storage.setItem(LAGRING_NYCKEL, JSON.stringify({ format: FORMAT, version: VERSION, projekt: ovr })); return { ok: true, borttaget: true }; } catch { return { ok: false, fel: ["webbläsaren tillåter inte lagring här"] }; }
}
// K4 (KONTO-SYNK, Donatello 2026-10-18): spara() räknar upp `revision` när innehållet ändrats och sätter `andrad` till ISO-tid.
// Synkmotorn jämför revisionen med serverns kvitto; oförändrat innehåll ger ingen ny revision (inga onödiga skickningar).
const utanMeta = (x) => { const { revision, andrad, ...rest } = x || {}; return JSON.stringify(rest); };
export function spara(storage, p, idag, { nuIso = () => new Date().toISOString(), behallRevision = false } = {}) {
  const v = validera(p); if (!v.ok) return { ok: false, fel: v.fel };
  const alla = laddaAlla(storage); if (!alla.ok) return { ok: false, fel: [alla.fel] };
  const fore = alla.projekt.find((x) => x.projektId === p.projektId);
  const rev0 = Number.isSafeInteger(p.revision) && p.revision > 0 ? p.revision : 1;
  const andrats = !fore || utanMeta(fore) !== utanMeta(p);
  const revision = behallRevision ? rev0 : !fore ? rev0 : andrats ? Math.max(rev0, Number(fore.revision) || 0) + 1 : Math.max(rev0, Number(fore.revision) || 0);
  const ny = { ...p, revision, andrad: behallRevision ? (p.andrad || nuIso()) : andrats || !fore ? nuIso() : (fore.andrad || nuIso()) }; void idag;
  const ovr = alla.projekt.filter((x) => x.projektId !== p.projektId);
  if (ovr.length >= MAX_PROJEKT) return { ok: false, fel: ["högst " + MAX_PROJEKT + " projekt sparas; exportera och ta bort äldre"] };
  const raw = JSON.stringify({ format: FORMAT, version: VERSION, projekt: [ny, ...ovr] });
  if (byteLength(raw) > 4 * MAX_BYTE) return { ok: false, fel: ["lagringen är full; exportera och ta bort äldre projekt"] };
  try { storage.setItem(LAGRING_NYCKEL, raw); return { ok: true, projekt: ny }; } catch { return { ok: false, fel: ["webbläsaren tillåter inte lagring här (privat läge eller full lagring)"] }; }
}

// R17: legacy quotes have no raw calculation list. Keep their original material as an explicit base;
// subsequent calculation passes replace only the new contribution, never append it twice.
export function projektArtiklar(p, artiklar) {
  const bas = p.raknarbas || (!Array.isArray(p.raknarlista) ? p.material.filter(m => !m.egen && !m.borta) : []);
  const all = bas.map(m => ({namn:m.namn,enhet:m.enhet,antal:Number(m.mangd),nyckel:typeof m.nyckel === "string" && m.nyckel.startsWith("n:") ? m.nyckel.slice(2,-(m.enhet.length+1)) : null,alt:m.med ? null : "B"}));
  for(const a of artiklar) { const old=all.find(x=>x.namn===a.namn && x.enhet===a.enhet); if(old){old.antal+=a.antal;if(Number(a.summaMedian)>0)old.summaMedian=Number(a.summaMedian)/a.antal*old.antal;}else all.push({...a}); }
  return {bas,artiklar:all};
}
