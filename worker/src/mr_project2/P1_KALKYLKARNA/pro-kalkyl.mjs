// Materialräknaren PRO – kalkylkärna (stödkandidat, Claude, 2026-10-17). WORK-ID KP-2026-10-16-01 / MR-OPTIMERING-20261008-01.
// Ren funktion utan DOM, nät eller lagring. Exakt aritmetik med BigInt-bråk: inga flyttal någonstans i beloppskedjan.
// Regler: Modestys S2 (R1–R5, statusar) och S2d (D1, D2, A1, F1, T1–T4). Facit: S2 FACIT_KALKYL.json (38 fall) och S2d FACIT_S2D.json (35 fall).
// Indata är strängar med decimalpunkt ("12.34") eller null; belopp ut är heltal i öre; timmar och procent som strängar med 2 decimaler.
// ROT-procent och tak är KONFIGURATION i indata (T4), aldrig konstanter här. Allt ROT är preliminärt.

// ---------- exakt bråk ----------
const abs = (a) => (a < 0n ? -a : a);
const gcd = (a, b) => { a = abs(a); b = abs(b); while (b) [a, b] = [b, a % b]; return a || 1n; };
function Q(n, d = 1n) { if (d === 0n) throw new Error("division med noll"); if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d); return { n: n / g, d: d / g }; }
function tal(s) { // "12.34" | "-1" | "0.111" → bråk; avvisar allt annat
  if (s === null || s === undefined) throw new Error("tal saknas");
  const t = String(s).trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) throw new Error("ogiltigt tal: " + t);
  const dec = m[3] || "";
  const n = BigInt(m[2] + dec) * (m[1] ? -1n : 1n);
  return Q(n, 10n ** BigInt(dec.length));
}
const add = (a, b) => Q(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a, b) => Q(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a, b) => Q(a.n * b.n, a.d * b.d);
const div = (a, b) => Q(a.n * b.d, a.d * b.n);
const heltal = (i) => Q(BigInt(i));
const cmp = (a, b) => { const x = a.n * b.d - b.n * a.d; return x < 0n ? -1 : x > 0n ? 1 : 0; };
const ar0 = (a) => a.n === 0n;
const NOLL = Q(0n), HUNDRA = Q(100n);
function rhu(a) { // hela, halva bort från noll (Pythons ROUND_HALF_UP) → Number (öre ryms säkert)
  const s = a.n < 0n ? -1n : 1n, n = abs(a.n);
  return Number(s * ((2n * n + a.d) / (2n * a.d)));
}
function golv(a) { // ROUND_FLOOR
  const q = a.n / a.d; return Number(a.n < 0n && q * a.d !== a.n ? q - 1n : q);
}
function r2(a) { return Q(BigInt(rhu(mul(a, HUNDRA))), 100n); } // två decimaler, halva uppåt
function fmt2(a) { // bråk med högst 2 decimaler → "x.yy"
  const c = rhu(mul(a, HUNDRA)), s = c < 0 ? "-" : "", v = Math.abs(c);
  return s + Math.floor(v / 100) + "." + String(v % 100).padStart(2, "0");
}
function ore(kr) { const v = mul(tal(kr), HUNDRA); if (v.d !== 1n) throw new Error("mer än 2 decimaler: " + kr); return Number(v.n); }
const ö = (i) => heltal(i);
function pct2(num, den) { return den === 0 ? null : fmt2(div(mul(ö(num), HUNDRA), ö(den))); }
function andel(belopp, procentStr) { return rhu(div(mul(ö(belopp), tal(procentStr)), HUNDRA)); }

// ---------- timmar ----------
function timmar(persons, days, hpd, manual) {
  const calc = r2(mul(mul(tal(persons), tal(days)), tal(hpd)));
  const used = manual !== null && manual !== undefined ? r2(tal(manual)) : calc;
  return { calc, used, avviker: cmp(used, calc) !== 0 };
}

// Documented hours are independent of whether a selling price is finished.
export function laborHours(rows) {
  return fmt2(rows.reduce((sum, r) => add(sum, timmar(r.persons, r.days, r.hours_per_day, r.manual_hours).used), NOLL));
}

// ---------- S2: offert (material + arbete på försäljningstimpris) ----------
export function offertS2(c) {
  const rows = []; const unpriced = []; let blocked = false;
  let mc = 0, mm = 0, ms = 0, ls = 0, hrs = NOLL;
  for (const r of c.rows) {
    const o = { id: r.id, kind: r.kind };
    if (r.kind === "material") {
      if (r.price_kr === null) { o.status = "ANGE_KR"; unpriced.push(r.id); rows.push(o); continue; }
      if (cmp(tal(r.markup_pct), NOLL) < 0) { o.status = "SPARRAD_NEGATIVT_PASLAG"; blocked = true; rows.push(o); continue; }
      const gross = rhu(mul(tal(r.qty), ö(ore(r.price_kr))));
      const disc = andel(gross, r.discount_pct); const cost = gross - disc; const mk = andel(cost, r.markup_pct);
      Object.assign(o, { status: "OK", gross_ore: gross, discount_ore: disc, cost_ore: cost, markup_ore: mk, sell_ore: cost + mk });
      mc += cost; mm += mk; ms += cost + mk;
    } else {
      if (r.rate_kr === null) { o.status = "ANGE_KR"; unpriced.push(r.id); rows.push(o); continue; }
      const t = timmar(r.persons, r.days, r.hours_per_day, r.manual_hours);
      const sell = rhu(mul(t.used, ö(ore(r.rate_kr))));
      Object.assign(o, { status: "OK", person_hours_calc: fmt2(t.calc), person_hours_used: fmt2(t.used), manual_deviates: t.avviker, elapsed_workdays: fmt2(tal(r.days)), sell_ore: sell });
      ls += sell; hrs = add(hrs, t.used);
    }
    rows.push(o);
  }
  const res = { rows, unpriced_ids: unpriced };
  if (blocked) return Object.assign(res, { total_status: "BLOCKED", totals: null });
  const sellEx = ms + ls; const priced = rows.length - unpriced.length;
  const vat = andel(sellEx, c.vat_pct);
  return Object.assign(res, {
    total_status: unpriced.length === 0 ? "COMPLETE" : priced > 0 ? "PARTIAL" : "NOT_OFFER_READY",
    totals: { material_cost_ore: mc, material_markup_ore: mm, material_sell_ore: ms, labor_sell_ore: ls, sell_ex_ore: sellEx, vat_ore: vat,
      total_inc_ore: sellEx + vat, person_hours_total: fmt2(hrs), material_margin_pct_of_sell: pct2(mm, ms) },
  });
}

export function timfall(c) {
  const t = timmar(c.persons, c.days, c.hours_per_day, c.manual_hours);
  return { person_hours_calc: fmt2(t.calc), person_hours_used: fmt2(t.used), manual_deviates: t.avviker, elapsed_workdays: fmt2(tal(c.days)),
    elapsed_hours_per_person: fmt2(r2(mul(tal(c.days), tal(c.hours_per_day)))), labor_sell_ore: rhu(mul(t.used, ö(ore(c.rate_kr)))) };
}

export function marginal(c) {
  const cost = ore(c.cost_kr); let sell;
  if ("target_margin_pct" in c) {
    const m = tal(c.target_margin_pct);
    if (cmp(m, NOLL) < 0 || cmp(m, HUNDRA) >= 0) return { status: "SPARRAD_OGILTIG_MARGINAL" };
    sell = rhu(div(ö(cost), sub(Q(1n), div(m, HUNDRA))));
  } else {
    const p = tal(c.markup_pct);
    if (cmp(p, NOLL) < 0) return { status: "SPARRAD_NEGATIVT_PASLAG" };
    sell = cost + andel(cost, c.markup_pct);
  }
  const mk = sell - cost;
  return { status: "OK", cost_ore: cost, markup_ore: mk, sell_ore: sell, margin_pct_of_sell: pct2(mk, sell), markup_pct_of_cost: pct2(mk, cost) };
}

export function normtid(c) {
  const roller = new Map();
  for (const m of c.moments) { if (!roller.has(m.scope)) roller.set(m.scope, new Set()); roller.get(m.scope).add(m.role); }
  const dbl = [...roller].filter(([, r]) => r.size > 1).map(([s]) => s).sort();
  const rows = []; let tot = NOLL, manual = 0, pris = 0, blocked = false;
  for (const m of c.moments) {
    const o = { id: m.id, scope: m.scope, role: m.role };
    if (m.qty_unit !== m.norm_unit) { o.status = "FEL_ENHET"; blocked = true; rows.push(o); continue; }
    if (m.norm_ph_per_unit === null) { o.status = "MANUELLT_SAKNAD_NORM"; manual++; rows.push(o); continue; }
    const lag = tal(m.layers ?? "1"), et = tal(m.etablering_ph ?? "0"), q = tal(m.qty);
    const h = (n) => r2(add(et, mul(mul(q, tal(n)), lag)));
    const typ = h(m.norm_ph_per_unit);
    Object.assign(o, { status: "OK", hours_typ: fmt2(typ), wait_h_not_work: fmt2(tal(m.wait_h ?? "0")) });
    if (m.norm_low !== null && m.norm_low !== undefined) { o.hours_low = fmt2(h(m.norm_low)); o.hours_high = fmt2(h(m.norm_high)); }
    o.price_ore = rhu(mul(typ, ö(ore(c.rate_kr)))); tot = add(tot, typ); pris += o.price_ore; rows.push(o);
  }
  if (dbl.length) blocked = true;
  return { moments: rows, double_count_scopes: dbl, manual_count: manual, status: blocked ? "BLOCKED" : manual ? "PARTIAL_MANUAL" : "COMPLETE",
    totals: blocked ? null : { person_hours: fmt2(tot), price_ore: pris } };
}

// ---------- S2d: offert med radrabatt i kr, orderrabatt, arbete på kostnad + påslag, frakt/resa och preliminärt ROT ----------
function radS2d(r) {
  const o = { id: r.id, kind: r.kind };
  if (r.kind === "freight" || r.kind === "travel") {
    if (r.price_kr === null) { o.status = "ANGE_KR"; return o; }
    return Object.assign(o, { status: "OK", sell_ore: ore(r.price_kr) });
  }
  if (r.kind === "material") {
    if (r.price_kr === null) { o.status = "ANGE_KR"; return o; }
    if (cmp(tal(r.markup_pct ?? "0"), NOLL) < 0) { o.status = "SPARRAD_NEGATIVT_PASLAG"; return o; }
    const gross = rhu(mul(tal(r.qty), ö(ore(r.price_kr))));
    const dp = andel(gross, r.discount_pct ?? "0"), df = ore(r.discount_fixed_kr || "0");
    if (dp + df > gross) { o.status = "SPARRAD_RABATT_OVER_BRUTTO"; return o; }
    const cost = gross - dp - df, mk = andel(cost, r.markup_pct ?? "0");
    return Object.assign(o, { status: "OK", gross_ore: gross, discount_pct_ore: dp, discount_fixed_ore: df, cost_ore: cost, markup_ore: mk, sell_ore: cost + mk });
  }
  const t = timmar(r.persons, r.days, r.hours_per_day, r.manual_hours);
  let cost = null, mk = null, before;
  if (r.cost_rate_kr !== null && r.cost_rate_kr !== undefined) {
    if (r.markup_pct === null || r.markup_pct === undefined) { o.status = "ANGE_PASLAG"; return o; }
    if (cmp(tal(r.markup_pct), NOLL) < 0) { o.status = "SPARRAD_NEGATIVT_PASLAG"; return o; }
    cost = rhu(mul(t.used, ö(ore(r.cost_rate_kr)))); mk = andel(cost, r.markup_pct); before = cost + mk;
  } else {
    if (r.rate_kr === null || r.rate_kr === undefined) { o.status = "ANGE_KR"; return o; }
    before = rhu(mul(t.used, ö(ore(r.rate_kr))));
  }
  const dp = andel(before, r.discount_pct ?? "0"), df = ore(r.discount_fixed_kr || "0");
  if (dp + df > before) { o.status = "SPARRAD_RABATT_OVER_BRUTTO"; return o; }
  const sell = before - dp - df;
  return Object.assign(o, { status: "OK", person_hours_calc: fmt2(t.calc), person_hours_used: fmt2(t.used), manual_deviates: t.avviker,
    cost_ore: cost, markup_ore: mk, sell_before_discount_ore: before, discount_pct_ore: dp, discount_fixed_ore: df, sell_ore: sell,
    margin_ore: cost === null ? null : sell - cost, margin_pct_of_sell: cost === null ? null : pct2(sell - cost, sell) });
}

export function offert(c) {
  const rows = c.rows.map(radS2d);
  const blockerad = (w) => ({ rows, total_status: "BLOCKED", totals: null, warnings: w, rot: null });
  if (rows.some((x) => x.status.startsWith("SPARRAD"))) return blockerad([]);
  const unpriced = rows.filter((x) => x.status === "ANGE_KR" || x.status === "ANGE_PASLAG").map((x) => x.id);
  const arbeteOprissatt = rows.some((x, i) => c.rows[i].kind === "labor" && x.status !== "OK");
  const ok = rows.map((x, i) => [x, c.rows[i]]).filter(([x]) => x.status === "OK");
  const summa = (f) => ok.filter(([, r]) => f(r.kind)).reduce((s, [x]) => s + x.sell_ore, 0);
  const mat = summa((k) => k === "material"), lab = summa((k) => k === "labor"), oth = summa((k) => k === "freight" || k === "travel");
  const hrs = ok.filter(([, r]) => r.kind === "labor").reduce((s, [x]) => add(s, tal(x.person_hours_used)), NOLL);
  const bas = mat + lab; let od = 0, odL = 0, odM = 0;
  const odc = c.order_discount;
  if (odc) {
    od = "pct" in odc ? andel(bas, odc.pct) : ore(odc.fixed_kr);
    if (od > bas) return blockerad(["SPARRAD_ORDERRABATT_OVER_BAS"]);
    odL = bas > 0 ? rhu(div(mul(ö(od), ö(lab)), ö(bas))) : 0; odM = od - odL;
  }
  const labAfter = lab - odL, sellEx = mat + lab + oth - od;
  const vat = andel(sellEx, c.vat_pct), labVat = andel(labAfter, c.vat_pct), labInc = labAfter + labVat;
  const priced = rows.length - unpriced.length;
  const totals = { material_sell_ore: mat, labor_sell_ore: lab, other_ore: oth, order_discount_ore: od, order_discount_labor_ore: odL,
    order_discount_material_ore: odM, sell_ex_ore: sellEx, vat_ore: vat, total_inc_ore: sellEx + vat, labor_after_discount_ex_ore: labAfter,
    labor_vat_ore: labVat, labor_inc_ore: labInc, person_hours_total: fmt2(hrs) };
  const w = c.work || {}; const warnings = [];
  if (w.travel_needed && !ok.some(([x, r]) => r.kind === "travel" && x.sell_ore > 0)) warnings.push("RESA_EJ_DEBITERAD");
  if (lab > 0 && w.hours_documented === false) warnings.push("TIMMAR_EJ_DOKUMENTERADE");
  return { rows, total_status: unpriced.length === 0 ? "COMPLETE" : priced > 0 ? "PARTIAL" : "NOT_OFFER_READY", totals, warnings,
    unpriced_ids: unpriced, rot: rot(c, (() => {
      // Allocate the already established labor share of the order discount once.
      // Missing flags retain the original core contract; P4 always supplies explicit choices.
      const eligible = ok.filter(([, r]) => r.kind === "labor" && r.rot_eligible !== false).reduce((s, [x]) => s + x.sell_ore, 0);
      const discounted = eligible - (lab > 0 ? rhu(div(mul(ö(odL), ö(eligible)), ö(lab))) : 0);
      return discounted + andel(discounted, c.vat_pct);
    })(), totals.total_inc_ore, arbeteOprissatt) };
}

function rot(c, labInc, totalInc, partial) {
  const w = c.work || {}, cfg = c.rot;
  const nej = (status, total = 0) => ({ status, display: "EJ_VISA", base_ore: labInc, nominal_ore: null, buyers: [], rot_total_ore: total,
    customer_pays_ore: total === null ? null : totalInc - total });
  if (w.eligibility_confirmed === false) return nej("KONTROLLERA_ROT_VILLKOR", null);
  if (w.buyer_owner === false) return nej("EJ_BERATTIGAD_EJ_AGARE");
  if (w.kind === "nybyggnad") return nej("EJ_BERATTIGAD_NYBYGGNAD");
  if (w.kind === "ombyggnad_tillbyggnad") {
    if (w.small_house_within_5y === "ja") return nej("EJ_BERATTIGAD_SMAHUS_FEMAR");
    if (w.small_house_within_5y === "okant") return nej("KONTROLLERA_SMAHUS_FEMAR", null);
  }
  if (labInc === 0) return nej("INGEN_ARBETSKOSTNAD");
  const andelar = c.buyers.reduce((s, b) => add(s, tal(b.share_pct)), NOLL);
  if (cmp(andelar, HUNDRA) !== 0) return { status: "SPARRAD_ANDELAR", display: "EJ_VISA", base_ore: labInc, nominal_ore: null, buyers: [], rot_total_ore: null, customer_pays_ore: null };
  const nom = golv(div(mul(ö(labInc), tal(cfg.pct)), HUNDRA)), capR = ore(cfg.cap_rot_kr), capT = ore(cfg.cap_total_kr);
  let anyCap = false, anyUnknown = false;
  const buyers = c.buyers.map((b) => {
    const alloc = golv(div(mul(ö(nom), tal(b.share_pct)), HUNDRA));
    let rem, ded;
    if (b.rot_used_kr === null || b.rot_used_kr === undefined || b.rut_used_kr === null || b.rut_used_kr === undefined) { rem = null; anyUnknown = true; ded = Math.min(alloc, capR); }
    else { const ru = ore(b.rot_used_kr), tu = ore(b.rut_used_kr); rem = Math.max(0, Math.min(capR - ru, capT - ru - tu)); ded = Math.min(alloc, rem); }
    const capped = ded < alloc; anyCap = anyCap || capped;
    return { id: b.id, share_pct: fmt2(r2(tal(b.share_pct))), alloc_ore: alloc, remaining_ore: rem, rot_ore: ded, capped };
  });
  const tot = buyers.reduce((s, x) => s + x.rot_ore, 0);
  const status = partial ? "PRELIMINAR_DELSUMMA_EJ_PRISSATT" : anyUnknown ? "PRELIMINAR_UTRYMME_EJ_KONTROLLERAT" : anyCap ? "PRELIMINAR_BEGRANSAD_AV_TAK" : "PRELIMINAR_UTRYMME_ANGETT";
  return { status, display: partial ? "EJ_VISA" : "PRELIMINAR", base_ore: labInc, nominal_ore: nom, buyers, rot_total_ore: tot, customer_pays_ore: totalInc - tot };
}

// ---------- gemensam ingång ----------
export function berakna(c) {
  switch (c.type) {
    case "quote": return offertS2(c);
    case "quote_rot": return offert(c);
    case "hours": return timfall(c);
    case "margin": return marginal(c);
    case "norm": return normtid(c);
    default: throw new Error("okänd kalkyltyp: " + c.type);
  }
}
export const compute = berakna; // adaptergränssnitt för Modestys körare (s2d_facit.test.mjs --adapter)
