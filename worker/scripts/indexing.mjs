// Indexering av referensbanden (F8, PRISUTBYTE-20261009-01). Ren logik utan nätverk eller filer,
// så att den går att pröva offline.
//
// Princip: banden räknas ALLTID från en fast basnivå (indexing.baseBands vid indexing.basePeriod),
// aldrig ovanpå redan uppräknade band. Ny band = avrundad(basband × index(målperiod) / index(basperiod)).
//  - Samma målperiod som redan är tillämpad = ingen ändring, även med --force.
//  - Okänd/ogiltig basperiod, saknad basnivå, nollställt/ickefinit index eller bakåtgående period
//    = stopp utan någon ändring.
//  - Ny basnivå (rebase) är en separat åtgärd som kräver belägg i text och aldrig sker som biprodukt.
//  - Projektband med basis "total" indexeras inte: viktningen arbete/material har ingen källa
//    (UNVERIFIED), och en tyst 50/50-vikt får inte se belagd ut. Bandet behålls och markeras.

export const VAT = 1.25;
const PERIOD = /^\d{4}M(0[1-9]|1[0-2])$/; // SCB:s månadsformat, t.ex. 2026M08
export const isPeriod = (p) => typeof p === "string" && PERIOD.test(p);
export const validIndex = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
export const r10 = (n) => Math.round(n / 10) * 10;
export const rBand = (n) => (n >= 10000 ? Math.round(n / 1000) * 1000 : n >= 1000 ? Math.round(n / 100) * 100 : r10(n));

const clone = (o) => JSON.parse(JSON.stringify(o));

export function snapshotBands(ref) {
  const hourly = {}, projects = {};
  for (const [t, h] of Object.entries(ref.hourly)) {
    if (t.startsWith("_") || !h.inclVat) continue;
    hourly[t] = { normal: [...h.inclVat.normal], ceiling: h.inclVat.ceiling };
  }
  for (const [k, p] of Object.entries(ref.projects)) {
    if (k.startsWith("_") || p.noReference || !p.normal) continue;
    projects[k] = { basis: p.basis, normal: [...p.normal] };
  }
  return { hourly, projects };
}

// Ny basnivå: nuvarande band deklareras motsvara indexnivån för `period`. Kräver belägg.
export function rebase(ref, { period, evidence }) {
  if (!isPeriod(period)) return { ok: false, reason: "ogiltig_period" };
  if (typeof evidence !== "string" || evidence.trim().length < 20) return { ok: false, reason: "belagg_saknas" };
  if (ref.indexing && ref.indexing.baseEvidence === evidence.trim()) return { ok: false, reason: "samma_belagg" };
  const out = clone(ref);
  out.indexing = {
    schema: 1, basePeriod: period, baseEvidence: evidence.trim(), appliedPeriod: period,
    appliedFactor: 1, baseBands: snapshotBands(out),
  };
  return { ok: true, ref: out };
}

// series: { basePeriod, baseLabor, targetPeriod, targetLabor }
export function planIndex(ref, series, { force = false } = {}) {
  void force; // --force kan aldrig kringgå någon av spärrarna nedan
  const ix = ref.indexing;
  if (!ix || ix.schema !== 1 || !isPeriod(ix.basePeriod) || !ix.baseBands || !isPeriod(ix.appliedPeriod)) {
    return { ok: false, reason: "okand_basperiod" };
  }
  if (!series || series.basePeriod !== ix.basePeriod || !isPeriod(series.targetPeriod)) return { ok: false, reason: "fel_period" };
  if (!validIndex(series.baseLabor) || !validIndex(series.targetLabor)) return { ok: false, reason: "ogiltigt_index" };
  if (series.targetPeriod < ix.appliedPeriod) return { ok: false, reason: "index_bakat" };
  if (series.targetPeriod === ix.appliedPeriod) return { ok: true, noop: true, ref };

  const f = series.targetLabor / series.baseLabor;
  const out = clone(ref);
  for (const [t, b] of Object.entries(ix.baseBands.hourly)) {
    const h = out.hourly[t];
    if (!h) return { ok: false, reason: "basband_utan_yrke:" + t };
    h.inclVat.normal = b.normal.map((v) => r10(v * f));
    h.inclVat.ceiling = r10(b.ceiling * f);
    h.exclVat.normal = h.inclVat.normal.map((v) => r10(v / VAT));
    h.exclVat.ceiling = r10(h.inclVat.ceiling / VAT);
  }
  for (const [k, b] of Object.entries(ix.baseBands.projects)) {
    const p = out.projects[k];
    if (!p) return { ok: false, reason: "basband_utan_projekt:" + k };
    if (b.basis === "arbete") {
      p.normal = b.normal.map((v) => rBand(v * f));
      delete p.indexNote;
    } else {
      p.normal = [...b.normal]; // behålls på basnivå
      p.indexNote = "Ej indexerat: viktningen mellan arbete och material har ingen källa (UNVERIFIED).";
    }
  }
  out.indexing.appliedPeriod = series.targetPeriod;
  out.indexing.appliedFactor = Number(f.toFixed(6));
  return { ok: true, noop: false, ref: out, factor: f };
}

// Golvet beror inte på BKI utan räknas absolut ur SCB-lön; samma formel som metodtexten.
export const FLOOR = { hoursPerMonth: 174, wageGrowth: 1.03, costFactor: 1.55 };
export function floorInclVat(monthly, yearsBehind = 0) {
  const g = FLOOR.wageGrowth ** (1 + yearsBehind);
  return Math.floor(((monthly / FLOOR.hoursPerMonth) * g * FLOOR.costFactor * VAT) / 10) * 10;
}
