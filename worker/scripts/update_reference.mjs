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
// Banden (normal/tak) indexeras med BKI arbetslön senaste 12 mån och avrundas
// till närmaste 10 kr. Marknadsmitt rörs inte här – den läses om kvartalsvis.
// Ingen automatisk deploy: skriptet ändrar bara filen, resten är commit + deploy.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { valjLon, RESERV, MAX_UPPRAKNING_AR } from "./lon_val.mjs";

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
const HOURS_PER_MONTH = 174, WAGE_GROWTH = 1.03, COST_FACTOR = 1.55, VAT = 1.25;

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

async function fetchBki() {
  const meta = await (await fetch(SCB_BKI)).json();
  const months = meta.variables.find((v) => v.code === "Tid").values;
  const last = months[months.length - 1];
  const yearAgo = `${Number(last.slice(0, 4)) - 1}${last.slice(4)}`;
  const data = await px(SCB_BKI, [
    { code: "Hustyp", selection: { filter: "item", values: ["GRUPPSMÅ"] } },
    { code: "Kostnadsslag", selection: { filter: "item", values: ["ARBL", "MATERIAL"] } },
    { code: "Tid", selection: { filter: "item", values: [yearAgo, last] } },
  ]);
  const idx = {};
  for (const row of data.data) {
    const [, slag, month] = row.key;
    idx[`${slag}:${month}`] = Number(row.values[0]);
  }
  return {
    period: `${yearAgo}→${last}`,
    labor: idx[`ARBL:${last}`] / idx[`ARBL:${yearAgo}`],
    material: idx[`MATERIAL:${last}`] / idx[`MATERIAL:${yearAgo}`],
  };
}

const r10 = (n) => Math.round(n / 10) * 10;
const rBand = (n) => (n >= 10000 ? Math.round(n / 1000) * 1000 : n >= 1000 ? Math.round(n / 100) * 100 : r10(n));

async function main() {
  const ref = JSON.parse(readFileSync(REF_PATH, "utf8"));
const before = { version: ref.version, updated: ref.updated };
  const wages = await fetchWages();
  const bki = await fetchBki();
  console.log(`BKI ${bki.period}: arbetslön ${((bki.labor - 1) * 100).toFixed(1)} %, material ${((bki.material - 1) * 100).toFixed(1)} %`);

  const notes = [];

  let bad = false;

  const senasteAr = Math.max(...Object.values(wages).map((w) => Number(w.year)));
  for (const [trade, code] of Object.entries(SSYK)) {
    const h = ref.hourly[trade];
    const val = valjLon(trade, code, wages, senasteAr);
    if (!val.ok) {
      notes.push(`  STOPP ${trade}: ${val.reason}. Högst ${MAX_UPPRAKNING_AR} års uppräkning är tillåten. Ta beslut med Moneyman.`);
      bad = true;
      continue;
    }
    const { w, arBakom } = val;
    const proxyNot = val.proxy ? ` [proxy: ${val.proxy}, SSYK ${val.proxyCode}]` : "";
    if (val.proxy) {
      // Märk raden även i det användaren ser (källan under lönekostnadsraden).
      h.floorSource = `SCB lönestrukturstatistik ${w.year}, proxy: ${val.proxy} (SSYK ${val.proxyCode}; ${code} sekretessbelagd), 10:e percentilen` +
        `${arBakom ? `, uppräknad ${arBakom} år` : ""}, /174 h × 1,03 × 1,55 (arbetsgivaravgift 31,42 %, semesterlön, avtalsförsäkring); ` +
        `Skatteverket ${new Date().getFullYear()}; ${new Date().toISOString().slice(0, 10)}`;
    }
    const uppräkning = WAGE_GROWTH ** (1 + arBakom);
    const floorIncl = Math.floor(((w.monthly / HOURS_PER_MONTH) * uppräkning * COST_FACTOR * VAT) / 10) * 10;
    const floorExcl = Math.round(floorIncl / VAT);
    const before = `${h.inclVat.floor}`;
    h.exclVat.floor = floorExcl; h.inclVat.floor = floorIncl;
    h.inclVat.normal = h.inclVat.normal.map((v) => r10(v * bki.labor));
    h.inclVat.ceiling = r10(h.inclVat.ceiling * bki.labor);
    h.exclVat.normal = h.inclVat.normal.map((v) => r10(v / VAT));
    h.exclVat.ceiling = r10(h.inclVat.ceiling / VAT);
    h.source = h.source.replace(/SCB lönestatistik \d{4}(\/\d{4})?/, `SCB lönestatistik ${w.year}`);
    notes.push(`${trade}: SCB ${w.year} P10 månadslön ${w.monthly}${arBakom ? ` (uppräknad ${arBakom} år)` : ""}${proxyNot} → golv ${floorIncl} kr/h inkl. (var ${before}); band ${h.inclVat.normal.join("–")}, tak ${h.inclVat.ceiling}`);
    if (!(h.inclVat.floor < h.inclVat.normal[0] && h.exclVat.floor < h.exclVat.normal[0])) {
      notes.push(`  STOPP ${trade}: golvet hamnade PÅ eller ÖVER bandets undre gräns. Kapa aldrig golvet – kontrollera underlaget med Moneyman.`);
      bad = true;
    }
  }
  for (const [k, p] of Object.entries(ref.projects)) {
    if (k.startsWith("_") || p.noReference || !p.normal) continue;
    const f = p.basis === "arbete" ? bki.labor : (bki.labor + bki.material) / 2;
    p.normal = p.normal.map((v) => rBand(v * f));
    notes.push(`${k}: band ${p.normal.join("–")} (indexerat ${((f - 1) * 100).toFixed(1)} %)`);
  }
  if (bad) {
    console.error(notes.join("\n"));
    console.error("\nAvbryter: invarianten golv < bandets undre gräns håller inte. Inget skrivet.");
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);
  ref.version = today.slice(0, 7);
  ref.updated = today;
  ref.sources.scb_lon.date = `år ${Object.values(wages)[0]?.year ?? "?"}`;
  ref.sources.scb_bki.date = bki.period.split("→")[1];

  console.log(notes.join("\n"));
  console.log("\nKontrollera manuellt före commit: ROT-reglerna mot Skatteverket, marknadsmitt mot Byggahus/Hantverkskollen, och att sidan /sa-granskar-vi-priser visar samma siffror.");
  if (WRITE) {
    // Banden indexeras multiplikativt mot filen som redan ligger där. Körs
    // skriptet två gånger med --write blir uppräkningen dubbel, utan varning.
    // (Kodgranskning 2026-09-18.)
    if (FORCE !== true && String(before.updated || "").slice(0, 7) === ref.version) {
      console.error(
        `STOPP: reference.json är redan uppdaterad ${before.updated} (version ${ref.version}).\n` +
        "En ny körning med --write skulle indexera banden en gång till, ovanpå den förra.\n" +
        "Är det verkligen meningen: kör om med --force."
      );
      process.exit(1);
    }
    writeFileSync(REF_PATH, JSON.stringify(ref, null, 2) + "\n");
    console.log(`Skrev ${REF_PATH} (version ${ref.version}).`);
  } else {
    console.log("Torrkörning – lägg till --write för att skriva reference.json.");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
