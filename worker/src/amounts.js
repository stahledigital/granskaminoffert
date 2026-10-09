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

// Raderna omräknade till inklusive moms; null om radernas momsläge är okänt.
export function rowsSumIncl(x) {
  const s = rowsSumStated(x);
  const f = vatFactor(x.vatMode);
  return s === null || f === null ? null : s * f;
}

const kr0 = (n) => `${Math.round(n).toLocaleString("sv-SE")} kr`;
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

  // Tolkningar i båda momsbaser när totalens momsbas är okänd.
  const bases = f === null ? [["inkl", 1], ["exkl", 1 + VAT_RATE]] : [[tb, f]];

  if (before !== null) {
    // Två uttryckliga uppgifter som inte hänger ihop (före ROT och att betala)
    // får inte låta den ena försvinna bakom den andra: konflikten redovisas.
    if (f !== null && pay !== null) {
      const expectedPay = before * f - (hasRot ? rot : 0);
      if (!withinPct(pay * f, expectedPay)) {
        return {
          status: "oklar", reason: "konflikt", conflict: true,
          alternatives: [
            { label: `summan före ROT-avdrag är ${kr0(before * f)} (som offerten anger)`, beforeRotIncl: before * f, basis: tb },
            { label: `summan att betala är ${kr0(pay * f)} (som offerten anger)`, beforeRotIncl: hasRot ? pay * f + rot : pay * f, basis: tb },
          ],
          before: before * f, toPay: pay * f, expectedPay,
        };
      }
    }
    if (f !== null) return { status: "belagd", beforeRotIncl: before * f, toPayIncl: hasRot ? before * f - rot : before * f, source: "explicit_fore_rot", basis: tb };
    return { status: "oklar", reason: "momsbas", alternatives: bases.map(([b, k]) => ({ label: `summan före ROT-avdrag är ${b === "inkl" ? "inklusive" : "exklusive"} moms`, beforeRotIncl: before * k, basis: b })) };
  }

  if (pay !== null) {
    if (f !== null) {
      const toPayIncl = pay * f;
      return { status: "belagd", beforeRotIncl: hasRot ? toPayIncl + rot : toPayIncl, toPayIncl, source: hasRot ? "explicit_att_betala" : "ingen_rot", basis: tb };
    }
    return { status: "oklar", reason: "momsbas", alternatives: bases.map(([b, k]) => ({ label: `summan att betala är ${b === "inkl" ? "inklusive" : "exklusive"} moms`, beforeRotIncl: hasRot ? pay * k + rot : pay * k, basis: b })) };
  }

  if (legacy === null) return { status: "saknas" };

  // Endast en oetiketterad total.
  if (!hasRot) {
    if (f !== null) return { status: "belagd", beforeRotIncl: legacy * f, toPayIncl: legacy * f, source: "ingen_rot", basis: tb };
    return { status: "oklar", reason: "momsbas", alternatives: bases.map(([b, k]) => ({ label: `totalen är ${b === "inkl" ? "inklusive" : "exklusive"} moms`, beforeRotIncl: legacy * k, basis: b })) };
  }

  // ROT finns och totalen är oetiketterad: före eller efter ROT?
  const rows = rowsSumIncl(x);
  if (f !== null && rows !== null) {
    const a = withinPct(legacy * f, rows); // totalen är före ROT
    const b = withinPct(legacy * f + rot, rows); // totalen är efter ROT
    if (a && !b) return { status: "belagd", beforeRotIncl: legacy * f, toPayIncl: legacy * f - rot, source: "rader", basis: tb };
    if (b && !a) return { status: "belagd", beforeRotIncl: legacy * f + rot, toPayIncl: legacy * f, source: "rader", basis: tb };
    // Båda tolkningarna ryms i toleransen: raderna kan inte avgöra, och en
    // hypotes som råkar passa är inte en belagd bas.
    if (a && b) {
      return {
        status: "oklar", reason: "rot_tvetydig",
        alternatives: [
          { label: `${LABEL_BEFORE} (${tb === "inkl" ? "inklusive" : "exklusive"} moms)`, beforeRotIncl: legacy * f, basis: tb },
          { label: `${LABEL_AFTER} (${tb === "inkl" ? "inklusive" : "exklusive"} moms)`, beforeRotIncl: legacy * f + rot, basis: tb },
        ],
      };
    }
  }
  const alts = [];
  for (const [bb, k] of bases) {
    const bl = bb === "inkl" ? "inklusive" : "exklusive";
    alts.push({ label: `${LABEL_BEFORE} (${bl} moms)`, beforeRotIncl: legacy * k, basis: bb });
    alts.push({ label: `${LABEL_AFTER} (${bl} moms)`, beforeRotIncl: legacy * k + rot, basis: bb });
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
