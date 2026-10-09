#!/usr/bin/env node
// Årlig uppdatering av referensdata (PRISUNDERLAG punkt 8).
// Hämtar SCB-lön per yrke (LoneSpridSektYrk4AN) och byggkostnadsindex
// arbetslön (FPIBOM2015), räknar om referensgolven och indexerar banden.
//
// Körs manuellt:   node scripts/update_reference.mjs            (visar förslag, skriver inget)
//                  node scripts/update_reference.mjs --write    (skriver src/reference.json)
// Golvformel (PRISUNDERLAG rev 3, 2026-09-18, E): timlön = månadslön för
// 10:e PERCENTILEN / 174 × 1,03 (löneökning nästa år); kostnad = timlön × 1,55
// (avgift 31,42 % + semester ~13 % + avtalsförsäkring ~6 %). Inkl. moms rundas
// NEDÅT till jämna 10 kr, exkl. = inkl. / 1,25.
// Ändrat i rev 3: medellön → 10:e percentilen, och delningen med debiterings-
// graden 0,8 är borttagen. Medellön är ingen golvnivå (hälften tjänar mindre),
// och 0,8 är ett antagande om hur firman drivs, inte om vad en anställd kostar.
// Golvet är kostnad per ARBETAD timme och jämförs mot en DEBITERAD timme –
// försiktigt åt hantverkarens håll, vilket är avsikten.
// Banden (normal/tak) räknas ALLTID från en versionerad basnivå (reference.json → indexing):
// band = avrundat(basband × BKI arbetslön[målmånad] / BKI arbetslön[basmånad]). Samma målmånad
// som redan är tillämpad ändrar ingenting (inte heller med --force); okänd basperiod, ogiltigt
// index eller bakåtgående period stoppar utan ändring. Se scripts/indexing.mjs.
// Ny basnivå sätts bara med en separat åtgärd: --rebase=YYYYMmm --evidence="belägg i text".
// Projektband med basis "total" indexeras inte (viktningen arbete/material saknar källa).
// Marknadsmitt rörs inte här – den läses om kvartalsvis.
// Ingen automatisk deploy: skriptet ändrar bara filen, resten är commit + deploy.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { valjLon, RESERV, MAX_UPPRAKNING_AR } from "./lon_val.mjs";
import { planIndex, rebase, floorInclVat, isPeriod, validIndex } from "./indexing.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REF_PATH = join(HERE, "..", "src", "reference.json");
const WRITE = process.argv.includes("--write");
const FORCE = process.argv.includes("--force");

const SCB_LON = "https://api.scb.se/OV0104/v1/doris/sv/ssd/START/AM/AM0110/AM0110A/LoneSpridSektYrk4AN";
const SCB_BKI = "https://api.scb.se/OV0104/v1/doris/sv/ssd/START/PR/PR0502/PR0502A/FPIBOM2015";

// SSYK per yrke i reference.json. Plattsättare saknar egen kod hos SCB:
// proxy golvläggare 7122 (PRISUNDERLAG). Saknas årets värde ("..") används
// senaste tillgängliga år, och det noteras.
const SSYK = { snickare: "7111", elektriker: "7411", vvs: "7125", malare: "7131", plattsattare: "7122" };
// Reservyrke och uppräkningsgräns: se lon_val.mjs (PRISUNDERLAG rev 4). 7122 saknas
// för 2025 och fylls inte i efterhand; saknas den i 2026 års statistik räknas
// plattsättare på murare 7112 (2025 P10 39 100 → 449 kr/h inkl.).

async function px(url, query) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, response: { format: "json" } }) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

async function fetchWages() {
  const meta = await (await fetch(SCB_LON)).json();
  const years = meta.variables.find((v) => v.code === "Tid").values;
  const data = await px(SCB_LON, [
    { code: "Sektor", selection: { filter: "item", values: ["0"] } },
    { code: "Yrke2012", selection: { filter: "item", values: [...new Set([...Object.values(SSYK), ...Object.values(RESERV).map((r) => r.code)])] } },
    { code: "Kon", selection: { filter: "item", values: ["1+2"] } },
    // 000007CF = 10:e percentilen (rev 3). 000007CD var medellön.
    { code: "ContentsCode", selection: { filter: "item", values: ["000007CF"] } },
    { code: "Tid", selection: { filter: "item", values: years.slice(-2) } },
  ]);
  const out = {};
  for (const row of data.data) {
    const [sektor, yrke, kon, year] = row.key;
    const v = Number(row.values[0]);
    if (!Number.isFinite(v)) continue;
    if (!out[yrke] || year > out[yrke].year) out[yrke] = { year, monthly: v };
  }
  return out;
}

// BKI arbetslön för basmånaden och senaste månaden (indexnivåer, inte ett 12-månaderstal).
async function fetchBkiSeries(basePeriod) {
  const meta = await (await fetch(SCB_BKI)).json();
  const months = meta.variables.find((v) => v.code === "Tid").values;
  const last = months[months.length - 1];
  const data = await px(SCB_BKI, [
    { code: "Hustyp", selection: { filter: "item", values: ["GRUPPSMÅ"] } },
    { code: "Kostnadsslag", selection: { filter: "item", values: ["ARBL"] } },
    { code: "Tid", selection: { filter: "item", values: [...new Set([basePeriod, last])] } },
  ]);
  const idx = {};
  for (const row of data.data) idx[row.key[2]] = Number(row.values[0]);
  return { basePeriod, baseLabor: idx[basePeriod], targetPeriod: last, targetLabor: idx[last] };
}


const argVal = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };

async function main() {
  let ref = JSON.parse(readFileSync(REF_PATH, "utf8"));

  // Separat åtgärd: ny basnivå. Rör inga band, bara metadata, och kräver belägg.
  const rb = argVal("rebase");
  if (rb !== null) {
    const r = rebase(ref, { period: rb, evidence: argVal("evidence") });
    if (!r.ok) { console.error(`STOPP rebase: ${r.reason}. Kräver --rebase=YYYYMmm och --evidence="<belägg, minst 20 tecken>" som skiljer sig från tidigare belägg.`); process.exit(1); }
    if (WRITE) { writeFileSync(REF_PATH, JSON.stringify(r.ref, null, 2) + "\n"); console.log(`Ny basnivå satt för ${rb}. Inga band ändrades.`); }
    else console.log(`Torrkörning: ny basnivå skulle sättas för ${rb}. Lägg till --write.`);
    return;
  }

  const basePeriod = ref.indexing && ref.indexing.basePeriod;
  if (!isPeriod(basePeriod)) {
    console.error("STOPP: bandens basperiod är okänd (reference.json → indexing.basePeriod saknas). Inget ändrat.\nSätt den med --rebase=YYYYMmm --evidence=\"<belägg>\" först när det går att styrka vilken indexnivå banden avser.");
    process.exit(1);
  }
  const wages = await fetchWages();
  const series = await fetchBkiSeries(basePeriod);
  if (!validIndex(series.baseLabor) || !validIndex(series.targetLabor)) {
    console.error(`STOPP: ogiltigt BKI-värde (${series.baseLabor}, ${series.targetLabor}). Inget ändrat.`);
    process.exit(1);
  }
  console.log(`BKI arbetslön ${series.basePeriod} → ${series.targetPeriod}: ${((series.targetLabor / series.baseLabor - 1) * 100).toFixed(1)} % över basnivån`);
  const plan = planIndex(ref, series, { force: FORCE });
  if (!plan.ok) { console.error(`STOPP: ${plan.reason}. Inget ändrat.`); process.exit(1); }
  if (plan.noop) { console.log(`Perioden ${series.targetPeriod} är redan tillämpad. Ingen ändring (gäller även --force).`); return; }
  ref = plan.ref;

  const notes = [];
  let bad = false;
  const senasteAr = Math.max(...Object.values(wages).map((w) => Number(w.year)));
  for (const [trade, code] of Object.entries(SSYK)) {
    const h = ref.hourly[trade];
    const val = valjLon(trade, code, wages, senasteAr);
    if (!val.ok) {
      notes.push(`  STOPP ${trade}: ${val.reason}. Högst ${MAX_UPPRAKNING_AR} års uppräkning är tillåten.`);
      bad = true;
      continue;
    }
    const { w, arBakom } = val;
    if (val.proxy) {
      h.floorSource = `SCB lönestrukturstatistik ${w.year}, proxy: ${val.proxy} (SSYK ${val.proxyCode}; ${code} sekretessbelagd), 10:e percentilen` +
        `${arBakom ? `, uppräknad ${arBakom} år` : ""}, /174 h × 1,03 × 1,55 (arbetsgivaravgift 31,42 %, semesterlön, avtalsförsäkring); ` +
        `Skatteverket ${new Date().getFullYear()}; ${new Date().toISOString().slice(0, 10)}`;
    }
    const floorIncl = floorInclVat(w.monthly, arBakom);
    h.exclVat.floor = Math.round(floorIncl / 1.25); h.inclVat.floor = floorIncl;
    h.source = h.source.replace(/SCB lönestatistik \d{4}(\/\d{4})?/, `SCB lönestatistik ${w.year}`);
    notes.push(`${trade}: golv ${floorIncl} kr/h inkl.; band ${h.inclVat.normal.join("–")}, tak ${h.inclVat.ceiling}`);
    if (!(h.inclVat.floor < h.inclVat.normal[0] && h.exclVat.floor < h.exclVat.normal[0])) {
      notes.push(`  STOPP ${trade}: golvet hamnade PÅ eller ÖVER bandets undre gräns. Kapa aldrig golvet.`);
      bad = true;
    }
  }
  for (const [k, p] of Object.entries(ref.projects)) {
    if (k.startsWith("_") || p.noReference || !p.normal) continue;
    notes.push(`${k}: band ${p.normal.join("–")}${p.indexNote ? " (ej indexerat, vikt saknar källa)" : ` (indexerat från basnivå ${ref.indexing.baseBands.projects[k].normal.join("–")})`}`);
  }
  if (bad) {
    console.error(notes.join("\n"));
    console.error("\nAvbryter: en spärr höll inte. Inget skrivet.");
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);
  ref.version = today.slice(0, 7);
  ref.updated = today;
  ref.sources.scb_lon.date = `år ${Object.values(wages)[0]?.year ?? "?"}`;
  ref.sources.scb_bki.date = series.targetPeriod;

  console.log(notes.join("\n"));
  console.log("\nKontrollera manuellt före commit: ROT-reglerna mot Skatteverket, marknadsmitt mot Byggahus/Hantverkskollen, och att sidan /sa-granskar-vi-priser visar samma siffror.");
  if (WRITE) {
    writeFileSync(REF_PATH, JSON.stringify(ref, null, 2) + "\n");
    console.log(`Skrev ${REF_PATH} (version ${ref.version}).`);
  } else {
    console.log("Torrkörning – lägg till --write för att skriva reference.json.");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
