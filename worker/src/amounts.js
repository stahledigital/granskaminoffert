// Gemensam beloppsnormalisering (paket A, GMO-REVISION-20261009-01 D03).
//
// Tidigare räknade reglerna hjälpligt med `totalSumSek` ("summan att betala")
// som om det vore bruttototal (värmepumpsschablonen) eller gissade via
// `totalBeforeRot()` om ROT skulle läggas tillbaka. Båda gav fel på giltiga
// offerter. Här finns EN plats där "vilken summa är det här och i vilken
// momsbas" avgörs, och reglerna får bara säga OK när basen är BELAGD:
//
//   belagd  = offerten/avläsningen anger explicit före ROT / att betala / momsbas,
//             eller raderna stämmer entydigt av mot exakt en tolkning av totalen
//   oklar   = minst två tolkningar återstår: reglerna svarar fraga/ej bedömbart
//             och redovisar tolkningarna. Aldrig OK för att en hypotes råkar passa.
//   saknas  = ingen total alls
//
// Moms: känd moms (inkl/exkl) normaliseras till inklusive moms med känd sats
// oavsett kundtyp. ej_angivet / blandat / okant_moms görs aldrig om till faktum.

import * as D from "./money.js";

export const VAT_RATE = 0.25; // Skatteverket: 25 % på byggtjänster till privatperson
const TOL = 0.02;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const withinPct = (a, b, tol = TOL) => {
  if (a === null || b === null) return null;
  return Math.abs(a - b) / Math.max(Math.abs(b), 1) <= tol;
};

// Faktor som gör om ett belopp i offertens momsläge till inklusive moms.
// null = okänd (ej_angivet, blandat, okant_moms).
export function vatFactor(mode) {
  if (mode === "inkl") return 1;
  if (mode === "exkl") return 1 + VAT_RATE;
  return null;
}

export function vatIsKnown(x) {
  return vatFactor(x.vatMode) !== null;
}

// Momsbas för just totalsummorna. Uttryckligt fält först, sedan äldre
// totalIncludesVat. En total i en offert där ALLA belopp anges inklusive moms
// är inklusive moms. Anges beloppen exklusive moms och totalens bas inte är
// uttryckligen märkt är den oklar (tidigare logik: "vatOpen").
export function totalBasis(x) {
  if (x.totalVatBasis === "inkl" || x.totalVatBasis === "exkl") return x.totalVatBasis;
  if (x.totalIncludesVat === true) return "inkl";
  if (x.totalIncludesVat === false) return "exkl";
  if (x.vatMode === "inkl") return "inkl";
  return null;
}

export function rowsSumStated(x) {
  const labor = num(x.laborSumSek), material = num(x.materialSumSek);
  if (labor === null || material === null) return null;
  return labor + material + (num(x.travelSumSek) || 0) + (num(x.otherSumSek) || 0);
}

// Samma summa som decimaltal (exakt, utan float-avrundning); null om en av de två obligatoriska kategorierna saknas.
export function rowsSumStatedD(x) {
  const labor = num(x.laborSumSek), material = num(x.materialSumSek);
  if (labor === null || material === null) return null;
  return D.sum([D.dec(labor), D.dec(material), D.dec(num(x.travelSumSek) || 0), D.dec(num(x.otherSumSek) || 0)]);
}

// Raderna omräknade till inklusive moms, som decimaltal; null om radernas momsläge är okänt.
export function rowsSumInclD(x) {
  const s = rowsSumStatedD(x);
  const f = vatFactor(x.vatMode);
  return s === null || f === null ? null : D.mul(s, D.dec(f));
}

// Raderna omräknade till inklusive moms; null om radernas momsläge är okänt.
export function rowsSumIncl(x) {
  const s = rowsSumStated(x);
  const f = vatFactor(x.vatMode);
  return s === null || f === null ? null : s * f;
}

// Visning av belopp i tolkningstexter. Decimaltal (money.js) visas med bevarad precision; ett beräknat JS-tal avrundas till hela kronor.
const kr0 = (n) => (n && typeof n === "object" ? D.fmtKr(n) : `${Math.round(n).toLocaleString("sv-SE")} kr`);
// Decimalsäker multiplikation av ett avläst belopp med en momsfaktor (1 eller 1,25), utan binär float-avrundning.
const dx = (v, k) => D.mul(D.dec(v), D.dec(k));
const decNum = (v) => (v === null ? null : D.dec(v));

const LABEL_BEFORE = "totalen är summan före ROT-avdrag";
const LABEL_AFTER = "totalen är summan att betala efter ROT-avdrag";

// Avgör vad totalen är. Returnerar alltid { status, ... }:
//   belagd: { beforeRotIncl, toPayIncl, source }
//   oklar:  { alternatives: [{ label, beforeRotIncl|null, basis }], reason }
//   saknas: {}
// `source`: explicit_fore_rot | explicit_att_betala | ingen_rot | rader
export function resolveTotals(x) {
  const rot = num(x.rotAmountSek);
  const hasRot = rot !== null && rot > 0;
  const before = num(x.totalBeforeRotSek);
  const pay = num(x.amountToPaySek);
  const legacy = num(x.totalSumSek);
  const tb = totalBasis(x);
  const f = vatFactor(tb);
  // Alla belopp bärs parallellt som exakta decimaltal (suffix D, money.js): ingen toFixed/float-avrundning före gränsjämförelser.
  // De numeriska fälten finns kvar för toleransbaserade heuristiker (withinPct) och för äldre konsumenter.
  const rotD = hasRot ? D.dec(rot) : D.dec(0);

  // Tolkningar i båda momsbaser när totalens momsbas är okänd.
  const bases = f === null ? [["inkl", 1], ["exkl", 1 + VAT_RATE]] : [[tb, f]];

  if (before !== null) {
    // Två uttryckliga uppgifter som inte hänger ihop (före ROT och att betala)
    // får inte låta den ena försvinna bakom den andra: konflikten redovisas.
    if (f !== null && pay !== null) {
      const expectedPay = before * f - (hasRot ? rot : 0);
      if (!withinPct(pay * f, expectedPay)) {
        const beforeD = dx(before, f), toPayD = dx(pay, f);
        return {
          status: "oklar", reason: "konflikt", conflict: true,
          alternatives: [
            { label: `summan före ROT-avdrag är ${kr0(beforeD)} (som offerten anger)`, beforeRotIncl: before * f, beforeRotInclD: beforeD, basis: tb },
            { label: `summan att betala är ${kr0(toPayD)} (som offerten anger)`, beforeRotIncl: hasRot ? pay * f + rot : pay * f, beforeRotInclD: D.add(toPayD, rotD), basis: tb },
          ],
          before: before * f, toPay: pay * f, expectedPay,
          beforeD, toPayD, expectedPayD: D.sub(beforeD, rotD),
        };
      }
    }
    if (f !== null) {
      const beforeD = dx(before, f);
      return { status: "belagd", beforeRotIncl: before * f, beforeRotInclD: beforeD, toPayIncl: hasRot ? before * f - rot : before * f, toPayInclD: D.sub(beforeD, rotD), source: "explicit_fore_rot", basis: tb };
    }
    return { status: "oklar", reason: "momsbas", alternatives: bases.map(([b, k]) => ({ label: `summan före ROT-avdrag är ${b === "inkl" ? "inklusive" : "exklusive"} moms`, beforeRotIncl: before * k, beforeRotInclD: dx(before, k), basis: b })) };
  }

  if (pay !== null) {
    if (f !== null) {
      const toPayIncl = pay * f;
      const toPayInclD = dx(pay, f);
      // Uttrycklig summa att betala utan angivet ROT-belopp: ett saknat belopp är inte ett belägg för
      // "inget avdrag". Skiljer sig raderna från nettot kan ett avdrag ha tappats i avläsningen. Nettot
      // behåller sin identitet (aldrig ometiketterat som "före ROT"); före-ROT-beloppet redovisas villkorat.
      const rowsIncl = rowsSumIncl(x);
      if (rot === null && rowsIncl !== null && !withinPct(toPayIncl, rowsIncl)) {
        const rowsInclD = rowsSumInclD(x);
        const gap = rowsIncl - toPayIncl;
        const gapD = D.sub(rowsInclD, toPayInclD);
        return {
          status: "oklar", reason: "avdrag_okant", toPayIncl, toPayInclD, basis: tb,
          alternatives: [
            { label: `inget ROT-avdrag finns och ${kr0(toPayInclD)} är hela priset`, beforeRotIncl: toPayIncl, beforeRotInclD: toPayInclD, basis: tb },
            ...(gap > 0 ? [{ label: `ett avdrag på ${kr0(gapD)} saknas i avläsningen, så att ${kr0(toPayInclD)} är summan att betala efter avdraget (före avdrag ${kr0(rowsInclD)})`, beforeRotIncl: rowsIncl, beforeRotInclD: rowsInclD, basis: tb }] : []),
          ],
        };
      }
      return { status: "belagd", beforeRotIncl: hasRot ? toPayIncl + rot : toPayIncl, beforeRotInclD: D.add(toPayInclD, rotD), toPayIncl, toPayInclD, source: hasRot ? "explicit_att_betala" : "ingen_rot", basis: tb };
    }
    return { status: "oklar", reason: "momsbas", alternatives: bases.map(([b, k]) => ({ label: `summan att betala är ${b === "inkl" ? "inklusive" : "exklusive"} moms`, beforeRotIncl: hasRot ? pay * k + rot : pay * k, beforeRotInclD: D.add(dx(pay, k), rotD), basis: b })) };
  }

  if (legacy === null) return { status: "saknas" };

  // Endast en oetiketterad total.
  if (!hasRot) {
    if (f !== null) { const v = dx(legacy, f); return { status: "belagd", beforeRotIncl: legacy * f, beforeRotInclD: v, toPayIncl: legacy * f, toPayInclD: v, source: "ingen_rot", basis: tb }; }
    return { status: "oklar", reason: "momsbas", alternatives: bases.map(([b, k]) => ({ label: `totalen är ${b === "inkl" ? "inklusive" : "exklusive"} moms`, beforeRotIncl: legacy * k, beforeRotInclD: dx(legacy, k), basis: b })) };
  }

  // ROT finns och totalen är oetiketterad: före eller efter ROT?
  const rows = rowsSumIncl(x);
  if (f !== null && rows !== null) {
    const a = withinPct(legacy * f, rows); // totalen är före ROT
    const b = withinPct(legacy * f + rot, rows); // totalen är efter ROT
    const lD = dx(legacy, f);
    if (a && !b) return { status: "belagd", beforeRotIncl: legacy * f, beforeRotInclD: lD, toPayIncl: legacy * f - rot, toPayInclD: D.sub(lD, rotD), source: "rader", basis: tb };
    if (b && !a) return { status: "belagd", beforeRotIncl: legacy * f + rot, beforeRotInclD: D.add(lD, rotD), toPayIncl: legacy * f, toPayInclD: lD, source: "rader", basis: tb };
    // Båda tolkningarna ryms i toleransen: raderna kan inte avgöra, och en
    // hypotes som råkar passa är inte en belagd bas.
    if (a && b) {
      return {
        status: "oklar", reason: "rot_tvetydig",
        alternatives: [
          { label: `${LABEL_BEFORE} (${tb === "inkl" ? "inklusive" : "exklusive"} moms)`, beforeRotIncl: legacy * f, beforeRotInclD: lD, basis: tb },
          { label: `${LABEL_AFTER} (${tb === "inkl" ? "inklusive" : "exklusive"} moms)`, beforeRotIncl: legacy * f + rot, beforeRotInclD: D.add(lD, rotD), basis: tb },
        ],
      };
    }
  }
  const alts = [];
  for (const [bb, k] of bases) {
    const bl = bb === "inkl" ? "inklusive" : "exklusive";
    const lk = dx(legacy, k);
    alts.push({ label: `${LABEL_BEFORE} (${bl} moms)`, beforeRotIncl: legacy * k, beforeRotInclD: lk, basis: bb });
    alts.push({ label: `${LABEL_AFTER} (${bl} moms)`, beforeRotIncl: legacy * k + rot, beforeRotInclD: D.add(lk, rotD), basis: bb });
  }
  return { status: "oklar", reason: f === null ? "moms_och_rot" : "rot", alternatives: alts };
}

// Alla rimliga tolkningar av totalen före ROT (inkl moms), för jämförelser.
// belagd -> en, oklar -> flera, saknas -> [].
export function totalCandidates(x) {
  const t = resolveTotals(x);
  if (t.status === "belagd") return [{ label: "", value: t.beforeRotIncl }];
  if (t.status === "oklar") return t.alternatives.map((a) => ({ label: a.label, value: a.beforeRotIncl }));
  return [];
}

// Arbetskostnaden som tolkningar i inklusive moms.
export function laborCandidates(x) {
  const labor = num(x.laborSumSek);
  if (labor === null) return [];
  const f = vatFactor(x.vatMode);
  if (f !== null) return [{ label: "", value: labor * f }];
  return [
    { label: "arbetskostnaden är angiven inklusive moms", value: labor },
    { label: "arbetskostnaden är angiven exklusive moms", value: labor * (1 + VAT_RATE) },
  ];
}
