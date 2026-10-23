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

// ---- Rabatt som egen avdragsrad (GMO-RABATT, 2026-10-23; rättad efter granskning R1) ----
// Avläsningen har radsummorna FÖRE rabatten och rabatten som eget belopp (discountSek) eller bara procentsats (discountPct).
// Här avgörs på ETT ställe vilket belopp som dras och i vilken momsbas. Ingen rabatt avläst (eller 0) → null, och alla regler
// räknar exakt som tidigare.
//   preRot:   [{ inclD, statedD, factor, fromPct, baseLabel }] – rabatt (inklusive moms) som dras FÖRE ROT-avdraget. Mer än en
//             kandidat = rabattens momsbas framgår inte; reglerna får då aldrig svara ok på en av dem (bara fråga eller, om ingen
//             tolkning stämmer, fel).
//   afterRot: [{ inclD, statedD, factor }] – rabatt som dras EFTER ROT-avdraget. Bara när offerten uttryckligen visar det steget.
//   rotEcho:  rabattbeloppet är lika med ROT-avdraget – troligen samma avdrag avläst två gånger. Rabatten används då inte.
//   pctSuspicious: procentsatsen ligger mellan 0 och 1 (t.ex. 0,1 för 10 %) – troligen en felläst andel. Den används då inte.
// Procentsats utan angivet underlag gäller hela beloppet, aldrig "det underlag som råkar stämma".
const BASE_LABEL = { hela: "hela beloppet", material: "materialet", arbete: "arbetet", material_och_arbete: "material och arbete" };

function pctBase(x, base) {
  const l = num(x.laborSumSek), m = num(x.materialSumSek), t = num(x.travelSumSek), o = num(x.otherSumSek);
  const key = base || "hela";
  const valueD = key === "hela" ? (l !== null && m !== null && t !== null && o !== null ? D.sum([l, m, t, o].map((v) => D.dec(v))) : null)
    : key === "material" ? (m === null ? null : D.dec(m))
    : key === "arbete" ? (l === null ? null : D.dec(l))
    : (l === null || m === null ? null : D.add(D.dec(l), D.dec(m)));
  return valueD === null ? null : { key, label: BASE_LABEL[key], valueD };
}

export const pctOfD = (valueD, p) => D.mul(D.mul(valueD, D.dec(p)), D.dec("0.01"));
const within1 = (a, b) => !D.gt(D.abs(D.sub(a, b)), D.dec(1));

function uniqByValue(list) {
  const out = [];
  for (const c of list) if (!out.some((o) => D.eq(o.inclD, c.inclD))) out.push(c);
  return out;
}

export function discountInfo(x) {
  const d = num(x.discountSek), p0 = num(x.discountPct);
  const hasD = d !== null && d > 0, pctSuspicious = p0 !== null && p0 > 0 && p0 < 1;
  const hasP = p0 !== null && p0 >= 1 && p0 <= 100;
  if (!hasD && !hasP && !pctSuspicious) return null;
  const p = hasP ? p0 : null;
  const stage = ["fore_moms", "efter_moms", "efter_rot"].includes(x.discountStage) ? x.discountStage : null;
  const base = Object.prototype.hasOwnProperty.call(BASE_LABEL, x.discountBase) ? x.discountBase : null;
  const fRows = vatFactor(x.vatMode);
  // ROT-avdraget avläst som rabatt: samma belopp som ROT-fältet, eller (ROT-fältet tomt) exakt 30 % eller 50 % av arbetet inkl. moms.
  const rot = num(x.rotAmountSek), labor = num(x.laborSumSek);
  const rotEcho = hasD && (rot !== null && rot > 0 ? d === rot
    : rot === null && labor !== null && fRows !== null && [0.3, 0.5].some((r) => within1(D.mul(D.mul(D.dec(labor), D.dec(fRows)), D.dec(r)), D.dec(d))));
  const both = [1, 1 + VAT_RATE];
  const factorsFor = (f) => (f === null ? both : [f]);
  const mk = (statedD, factor, extra = {}) => ({ statedD, factor, inclD: D.mul(statedD, D.dec(factor)), ...extra });
  let preRot = [], afterRot = [];
  if (hasD && !rotEcho) {
    const statedD = D.dec(d);
    // Momsbasen följer var beloppet dras: före momsen = radernas bas; efter momsen dras det från en summa inklusive moms och är
    // alltså inklusive moms (faktor 1), oavsett hur totalerna i övrigt är angivna; efter ROT dras det från summan att betala och har
    // totalernas momsbas (okänd → två tolkningar).
    // Okänt steg: varje steg är en tolkning – före momsen (radernas bas), efter momsen (1) eller efter ROT (totalernas bas).
    let preFactors = stage === "fore_moms" ? factorsFor(fRows) : stage === "efter_moms" ? [1] : [...new Set([...factorsFor(fRows), 1, ...factorsFor(vatFactor(totalBasis(x)))])];
    // Okänt steg men angiven procentsats: är beloppet exakt procentsatsen av raderna i deras egen momsbas (eller inklusive moms)
    // är beloppets momsbas belagd av offertens egna siffror.
    if (preFactors.length > 1 && p !== null && fRows !== null) {
      const b = pctBase(x, base);
      if (b && within1(pctOfD(b.valueD, p), statedD)) preFactors = [fRows];
      else if (b && within1(pctOfD(D.mul(b.valueD, D.dec(fRows)), p), statedD)) preFactors = [1];
    }
    if (stage !== "efter_rot") preRot = uniqByValue(preFactors.map((k) => mk(statedD, k)));
    // Efter ROT: summan att betala är normalt inklusive moms (faktor 1); med totaler exklusive moms är även den tolkningen möjlig –
    // två tolkningar, aldrig ett påstående om momsbasen.
    else afterRot = uniqByValue([...factorsFor(vatFactor(totalBasis(x))), 1].map((k) => mk(statedD, k)));
  } else if (!hasD && p !== null && stage !== "efter_rot") {
    // Bara procentsats: beloppet räknas på radernas egna belopp (samma momsbas som raderna). Underlaget är det angivna eller – som
    // antagande, aldrig som faktum – hela beloppet; går det inte att räkna blir det inga kandidater.
    const b = pctBase(x, base);
    if (b) preRot = uniqByValue(factorsFor(fRows).map((k) => mk(pctOfD(b.valueD, p), k, { fromPct: true, baseLabel: b.label })));
  }
  // Fastställd för summeringen: beloppet i kr, en enda momstolkning och känt steg. För ROT-gränsen dessutom känt underlag.
  // Det som inte är fastställt får aldrig ge fel på ett belopp som rabatten kan påverka (bara fråga), och aldrig ok på en gissning.
  const amounts = [...preRot, ...afterRot];
  const sumResolved = hasD && !rotEcho && stage !== null && amounts.length === 1;
  const missing = [
    !hasD ? "beloppet i kronor anges inte" : null,
    rotEcho ? (rot !== null && rot > 0 ? "beloppet är lika stort som ROT-avdraget" : "beloppet är exakt så stort som ett ROT-avdrag på arbetskostnaden skulle vara, och inget ROT-avdrag har lästs ut") : null,
    hasD && !rotEcho && amounts.length > 1 ? "det framgår inte om beloppet är inklusive eller exklusive moms" : null,
    stage === null ? "det framgår inte i vilket steg den dras" : null,
  ].filter(Boolean);
  // ROT-tvilling: rabatten är (i någon tolkning) lika stor som ROT-avdraget. Med bara en omärkt total går det då inte att avgöra om
  // totalen är summan före ROT efter rabatten eller summan att betala efter ROT-avdraget utan rabatt.
  const rotTwin = !rotEcho && rot !== null && rot > 0 && amounts.some((c) => within1(c.inclD, D.dec(rot)));
  return { amountSek: hasD ? d : null, pct: p, pctRaw: p0, pctSuspicious, base, baseLabel: base ? BASE_LABEL[base] : null, stage, rotEcho, rotTwin,
    preRot, afterRot, sumResolved, rotResolved: sumResolved && base !== null, missing };
}

// Rabattens belopp mot procentsatsen när båda anges. null = går inte att jämföra (inget underlag), annars { ok, calc }.
export function discountPctCheck(x) {
  const info = discountInfo(x);
  if (!info || info.rotEcho || info.amountSek === null || info.pct === null) return null;
  const b = pctBase(x, info.base);
  if (!b) return null;
  const amountD = D.dec(info.amountSek);
  // Procenten räknas på radernas belopp; dras rabatten från en summa inklusive moms jämförs även med raderna inklusive moms.
  const ks = info.stage === "fore_moms" ? [1] : [...new Set([1, ...(vatFactor(x.vatMode) === null ? [1 + VAT_RATE] : [vatFactor(x.vatMode)])])];
  const calc = ks.map((k) => ({ ...b, k, pctD: pctOfD(D.mul(b.valueD, D.dec(k)), info.pct) }));
  return { ok: calc.some((c) => within1(c.pctD, amountD)), amountD, pct: info.pct, calc };
}

// Radsumman inklusive moms minus en rabatt före ROT, som tal (för toleransheuristiken withinPct). Utan rabatt: [radsumman].
export function rowsNetInclCandidates(x) {
  const rows = rowsSumIncl(x);
  if (rows === null) return [];
  const info = discountInfo(x);
  if (!info || !info.preRot.length) return [rows];
  return info.preRot.map((c) => rows - D.toNumber(c.inclD));
}

// Visning av belopp i tolkningstexter. Decimaltal (money.js) visas med bevarad precision; ett beräknat JS-tal avrundas till hela kronor.
const kr0 = (n) => (n && typeof n === "object" ? D.fmtKr(n) : `${Math.round(n).toLocaleString("sv-SE")} kr`);
// Decimalsäker multiplikation av ett avläst belopp med en momsfaktor (1 eller 1,25), utan binär float-avrundning.
const dx = (v, k) => D.mul(D.dec(v), D.dec(k));
const decNum = (v) => (v === null ? null : D.dec(v));

// Rabatttexter: hela kronor (beloppen jämförs exakt, bara visningen avrundas).
const krW = (v) => D.fmtKr(D.dec(Math.round(D.toNumber(v))));
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

  const disc = discountInfo(x);
  if (before !== null) {
    // Två uttryckliga uppgifter som inte hänger ihop (före ROT och att betala)
    // får inte låta den ena försvinna bakom den andra: konflikten redovisas.
    if (f !== null && pay !== null) {
      const expectedPay = before * f - (hasRot ? rot : 0);
      // GMO-RABATT: en rabatt som offerten uttryckligen drar EFTER ROT förklarar skillnaden mellan de två summorna – bara när den
      // stämmer på kronan (1 kr, öresavrundning). Okänt steg förklarar aldrig en skillnad.
      const tailHit = disc && disc.sumResolved && !withinPct(pay * f, expectedPay) ? disc.afterRot.find((c) => within1(dx(pay, f), D.sub(D.sub(dx(before, f), rotD), c.inclD))) : null;
      if (tailHit) {
        const beforeD = dx(before, f);
        return { status: "belagd", beforeRotIncl: before * f, beforeRotInclD: beforeD, toPayIncl: pay * f, toPayInclD: dx(pay, f), source: "explicit_fore_rot", basis: tb, afterRotDiscountD: tailHit.inclD };
      }
      // GMO-RABATT (R3): en fastställd rabatt före ROT (före eller efter momsen) som står MELLAN offertens bruttosumma och ROT-raden.
      // Avläsningen har då bruttosumman som "före ROT"; summan som ROT-avdraget dras från är bruttosumman minus rabatten. Bara exakt (1 kr).
      const midHit = disc && disc.sumResolved && (disc.stage === "fore_moms" || disc.stage === "efter_moms") && !withinPct(pay * f, expectedPay)
        ? disc.preRot.find((c) => within1(dx(pay, f), D.sub(D.sub(dx(before, f), c.inclD), rotD))) : null;
      if (midHit) {
        const grossD = dx(before, f), beforeD = D.sub(grossD, midHit.inclD);
        return { status: "belagd", beforeRotIncl: D.toNumber(beforeD), beforeRotInclD: beforeD, toPayIncl: pay * f, toPayInclD: dx(pay, f), source: "explicit_att_betala", basis: tb, grossBeforeD: grossD };
      }
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
      const ar = disc && disc.afterRot.length === 1 ? disc.afterRot[0].inclD : null; // uttrycklig rabatt efter ROT med känd momsbas
      if (ar && pay === null) {
        const toPayD = D.sub(D.sub(beforeD, rotD), ar);
        return { status: "belagd", beforeRotIncl: before * f, beforeRotInclD: beforeD, toPayIncl: D.toNumber(toPayD), toPayInclD: toPayD, source: "explicit_fore_rot", basis: tb, afterRotDiscountD: ar };
      }
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
      // GMO-RABATT: en uttrycklig rabatt efter ROT (känd momsbas) ligger mellan summan före ROT och summan att betala.
      const ar = disc && disc.afterRot.length === 1 ? disc.afterRot[0].inclD : null;
      // Bara när ROT-fältet finns: saknas ROT-beloppet kan ett avdrag ha tappats, och då räknas ingen summa före ROT fram här.
      if (ar && rot !== null) {
        const beforeD = D.add(D.add(toPayInclD, rotD), ar);
        return { status: "belagd", beforeRotIncl: D.toNumber(beforeD), beforeRotInclD: beforeD, toPayIncl, toPayInclD, source: hasRot ? "explicit_att_betala" : "ingen_rot", basis: tb, afterRotDiscountD: ar };
      }
      // Rader minus en rabatt före ROT som stämmer med nettot är inget tappat avdrag.
      const netCands = rowsNetInclCandidates(x);
      const payTarget = ar ? toPayIncl + D.toNumber(ar) : toPayIncl; // rabatt efter (ett eventuellt) ROT ligger mellan raderna och nettot
      // Bara exakt (1 kr): en toleransträff får aldrig bli en uträknad summa före ROT som sedan jämförs exakt.
      if (ar && rot === null && rowsIncl !== null && netCands.some((r) => Math.abs(r - payTarget) <= 1)) {
        const beforeD = D.add(toPayInclD, ar);
        return { status: "belagd", beforeRotIncl: D.toNumber(beforeD), beforeRotInclD: beforeD, toPayIncl, toPayInclD, source: "ingen_rot", basis: tb, afterRotDiscountD: ar };
      }
      if (rot === null && rowsIncl !== null && (ar || !netCands.some((r) => withinPct(toPayIncl, r)))) {
        const rowsInclD = rowsSumInclD(x);
        const gap = rowsIncl - toPayIncl;
        const gapD = D.sub(rowsInclD, toPayInclD);
        const k0 = disc ? (v) => D.fmtKr(D.dec(Math.round(D.toNumber(v)))) : kr0; // med rabatt: hela kronor i texten
        return {
          status: "oklar", reason: "avdrag_okant", toPayIncl, toPayInclD, basis: tb,
          alternatives: [
            { label: `inget ROT-avdrag finns och ${k0(toPayInclD)} är hela priset`, beforeRotIncl: toPayIncl, beforeRotInclD: toPayInclD, basis: tb },
            ...(gap > 0 ? [{ label: `ett avdrag på ${k0(gapD)} saknas i avläsningen, så att ${k0(toPayInclD)} är summan att betala efter avdraget (före avdrag ${k0(rowsInclD)})`, beforeRotIncl: rowsIncl, beforeRotInclD: rowsInclD, basis: tb }] : []),
          ],
        };
      }
      if (ar && rot === null) {
        // Rabatt efter ROT men inget ROT-belopp och rader som inte kan avgöra: två tolkningar, ingen uträknad summa som faktum.
        const plusD = D.add(toPayInclD, ar);
        return { status: "oklar", reason: "rabatt_efter_rot", basis: tb, alternatives: [
          { label: `summan att betala ${krW(toPayInclD)} är efter rabatten ${krW(ar)} (före rabatten ${krW(D.add(D.dec(Math.round(D.toNumber(toPayInclD))), D.dec(Math.round(D.toNumber(ar)))))})`, beforeRotIncl: D.toNumber(plusD), beforeRotInclD: plusD, basis: tb },
          { label: `${krW(toPayInclD)} är hela priset och rabatten ingår redan`, beforeRotIncl: toPayIncl, beforeRotInclD: toPayInclD, basis: tb },
        ] };
      }
      return { status: "belagd", beforeRotIncl: hasRot ? toPayIncl + rot : toPayIncl, beforeRotInclD: D.add(toPayInclD, rotD), toPayIncl, toPayInclD, source: hasRot ? "explicit_att_betala" : "ingen_rot", basis: tb };
    }
    return { status: "oklar", reason: "momsbas", alternatives: bases.map(([b, k]) => ({ label: `summan att betala är ${b === "inkl" ? "inklusive" : "exklusive"} moms`, beforeRotIncl: hasRot ? pay * k + rot : pay * k, beforeRotInclD: D.add(dx(pay, k), rotD), basis: b })) };
  }

  if (legacy === null) return { status: "saknas" };

  // Endast en oetiketterad total.
  if (!hasRot) {
    // GMO-RABATT (R3 #6): utan ROT och med en uttrycklig rabatt efter ROT kan den omärkta totalen vara summan att betala (efter rabatten).
    // Bara när raderna stämmer exakt med totalen plus rabatten och inte med totalen ensam; annars som förut.
    const arL = f !== null && disc && disc.afterRot.length === 1 ? disc.afterRot[0].inclD : null;
    const rowsL = arL ? rowsSumInclD(x) : null;
    if (arL && rowsL && within1(rowsL, D.add(dx(legacy, f), arL)) && !within1(rowsL, dx(legacy, f))) {
      const v = dx(legacy, f), bD = D.add(v, arL);
      return { status: "belagd", beforeRotIncl: D.toNumber(bD), beforeRotInclD: bD, toPayIncl: legacy * f, toPayInclD: v, source: "ingen_rot", basis: tb, afterRotDiscountD: arL };
    }
    if (arL && !rowsL) {
      const v = dx(legacy, f), bD = D.add(v, arL);
      return { status: "oklar", reason: "rabatt_efter_rot", basis: tb, alternatives: [
        { label: `totalen ${krW(v)} är efter rabatten ${krW(arL)} (före rabatten ${krW(D.add(D.dec(Math.round(D.toNumber(v))), D.dec(Math.round(D.toNumber(arL)))))})`, beforeRotIncl: D.toNumber(bD), beforeRotInclD: bD, basis: tb },
        { label: `totalen ${krW(v)} är före rabatten`, beforeRotIncl: legacy * f, beforeRotInclD: v, basis: tb },
      ] };
    }
    if (f !== null) { const v = dx(legacy, f); return { status: "belagd", beforeRotIncl: legacy * f, beforeRotInclD: v, toPayIncl: legacy * f, toPayInclD: v, source: "ingen_rot", basis: tb }; }
    return { status: "oklar", reason: "momsbas", alternatives: bases.map(([b, k]) => ({ label: `totalen är ${b === "inkl" ? "inklusive" : "exklusive"} moms`, beforeRotIncl: legacy * k, beforeRotInclD: dx(legacy, k), basis: b })) };
  }

  // ROT finns och totalen är oetiketterad: före eller efter ROT?
  const rows = rowsSumIncl(x);
  if (f !== null && rows !== null) {
    // GMO-RABATT: raderna jämförs efter en rabatt före ROT (varje tolkning av rabattens momsbas). Utan rabatt: exakt som förut.
    const nets = rowsNetInclCandidates(x);
    const ar = disc && disc.afterRot.length === 1 ? D.toNumber(disc.afterRot[0].inclD) : 0;
    const a = nets.some((r) => withinPct(legacy * f, r)); // totalen är före ROT
    const b = nets.some((r) => withinPct(legacy * f + rot + ar, r)); // totalen är efter ROT (och efter en rabatt efter ROT)
    const lD = dx(legacy, f);
    if (a && !b) {
      if (ar) { const arD = disc.afterRot[0].inclD, pD = D.sub(D.sub(lD, rotD), arD); return { status: "belagd", beforeRotIncl: legacy * f, beforeRotInclD: lD, toPayIncl: D.toNumber(pD), toPayInclD: pD, source: "rader", basis: tb, afterRotDiscountD: arD }; }
      return { status: "belagd", beforeRotIncl: legacy * f, beforeRotInclD: lD, toPayIncl: legacy * f - rot, toPayInclD: D.sub(lD, rotD), source: "rader", basis: tb };
    }
    if (b && !a) {
      if (ar) { const arD = disc.afterRot[0].inclD, bD = D.add(D.add(lD, rotD), arD); return { status: "belagd", beforeRotIncl: D.toNumber(bD), beforeRotInclD: bD, toPayIncl: legacy * f, toPayInclD: lD, source: "rader", basis: tb, afterRotDiscountD: arD }; }
      return { status: "belagd", beforeRotIncl: legacy * f + rot, beforeRotInclD: D.add(lD, rotD), toPayIncl: legacy * f, toPayInclD: lD, source: "rader", basis: tb };
    }
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
    const arA = disc && disc.afterRot.length === 1 ? disc.afterRot[0].inclD : null; // rabatt efter ROT ligger mellan totalen och summan före ROT
    alts.push({ label: `${LABEL_AFTER}${arA ? ` och rabatten ${krW(arA)}` : ""} (${bl} moms)`, beforeRotIncl: legacy * k + rot + (arA ? D.toNumber(arA) : 0), beforeRotInclD: arA ? D.add(D.add(lk, rotD), arA) : D.add(lk, rotD), basis: bb });
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
