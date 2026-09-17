// Prisregler för Granska min offert — deterministisk kod, inte LLM.
// Underlag: PRISUNDERLAG_GRANSKAMINOFFERT.md (Moneyman, 2026-09) lager 1 a–i,
// siffror och källor i reference.json. Inga egna siffror här.
//
// Inmatning: `x` = strukturerade fält som modellen extraherat (null = saknas,
// aldrig gissat). Utmatning: lista av kontroller med status
//   ok | fel | fraga | flagga | ej_bedombar
// och text på svenska med källa och datum där en regel bygger på en källa.

export const FORBIDDEN_WORDS = ["för dyrt", "överpris", "svart", "oseriöst", "oseriös", "fusk"];

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pct = (v) => (num(v) === null ? null : v > 1 ? v / 100 : v);
const kr = (n) => `${Math.round(n).toLocaleString("sv-SE")} kr`;
const krRange = (a, b) => `${Math.round(a).toLocaleString("sv-SE")}–${Math.round(b).toLocaleString("sv-SE")} kr`;

function src(ref, key) {
  const s = ref && ref.sources && ref.sources[key];
  return s ? `${s.name}, ${s.date}` : "";
}

function withinTol(a, b, tol) {
  if (a === null || b === null) return null;
  const base = Math.max(Math.abs(b), 1);
  return Math.abs(a - b) / base <= tol;
}

// Betalningsdatum styr ROT-satsen. Om inget planerat betaldatum finns används
// offertdatum; saknas båda antas "nu" (ej_bedombar-not läggs till).
function paymentDate(x) {
  return x.plannedPaymentDate || x.quoteDate || null;
}

function inRange(dateStr, from, to) {
  return dateStr >= from && dateStr <= to;
}

export function runRules(x, ref) {
  const out = [];
  const rot = ref.rot;
  const add = (id, status, title, text, source) => out.push({ id, status, title, text, source: source || "" });

  const labor = num(x.laborSumSek);
  const material = num(x.materialSumSek);
  const travel = num(x.travelSumSek);
  const other = num(x.otherSumSek) || 0;
  const rotAmt = num(x.rotAmountSek);
  const rotRate = pct(x.rotRatePct);
  const persons = num(x.rotPersons);
  const total = num(x.totalSumSek);
  const rate = num(x.hourlyRateSek);
  const hours = num(x.hours);
  const vat = x.vatMode || "ej_angivet";
  const consumer = x.customerType !== "foretag";
  const payDate = paymentDate(x);
  const isHeatPump = x.jobType === "bergvarme" || x.jobType === "luftvarmepump" || x.jobType === "varmepump";

  // --- f) Moms: konsekvent, konsument utan angivelse = inkl. moms ---
  if (vat === "ej_angivet") {
    add("moms", consumer ? "flagga" : "fraga", "Moms",
      consumer
        ? "Offerten anger inte om priserna är inklusive eller exklusive moms. Mot privatperson räknas ett pris utan angivelse som inklusive moms, och kontrollerna nedan utgår från det."
        : "Offerten anger inte om priserna är inklusive eller exklusive moms. Det behöver framgå.",
      src(ref, "konsumentverket_pris"));
  } else if (vat === "blandat") {
    add("moms", "fel", "Moms", "Offerten blandar priser inklusive och exklusive moms. Alla belopp behöver anges på samma sätt.", "");
  } else {
    add("moms", "ok", "Moms", `Priserna anges ${vat === "inkl" ? "inklusive" : "exklusive"} moms, konsekvent.`, "");
  }

  // Räkna om arbetskostnad till inkl. moms för ROT-kontrollen.
  const laborInclVat = labor === null ? null : vat === "exkl" ? labor * 1.25 : labor;

  // --- i) Fast pris utan uppdelning ---
  if (x.priceType === "fast" && labor === null && rotAmt !== null) {
    add("uppdelning", "ej_bedombar", "Arbete och material",
      "Fast pris utan uppdelning i arbete och material. ROT-avdraget går då inte att kontrollera – be om uppdelningen, eftersom avdraget bara får räknas på arbetskostnaden.",
      src(ref, "skatteverket_rot"));
  } else if (x.priceType === "fast" && labor === null) {
    add("uppdelning", "ej_bedombar", "Arbete och material",
      "Fast pris utan uppdelning i arbete och material. Priset går då inte att kontrollera mot timpris eller referensintervall – be om uppdelningen.",
      "");
  }

  // --- a) ROT = 30 % av arbetskostnaden inkl. moms (tolerans 2 %) ---
  if (rotAmt !== null) {
    if (isHeatPump) {
      // h) Värmepumpsschablon: arbete = andel av totalpriset.
      const share = x.jobType === "bergvarme" ? rot.heatPumpShare.bergvarme : rot.heatPumpShare.other;
      const base = total !== null ? total : null;
      if (base !== null) {
        const expected = base * share * rot.rate;
        const ok = withinTol(rotAmt, expected, rot.tolerance);
        add("rot_schablon", ok ? "ok" : "fel", "ROT vid värmepump",
          ok
            ? `ROT-avdraget ${kr(rotAmt)} stämmer med schablonen: ${Math.round(share * 100)} % av totalpriset räknas som arbete, och avdraget är ${Math.round(rot.rate * 100)} % av det.`
            : `Vid ${x.jobType === "bergvarme" ? "bergvärme" : "värmepump"} räknas ${Math.round(share * 100)} % av totalpriset som arbetskostnad. ${Math.round(rot.rate * 100)} % av det blir ${kr(expected)}, offerten anger ${kr(rotAmt)}.`,
          src(ref, "skatteverket_rot_varmepump"));
      } else {
        add("rot_schablon", "ej_bedombar", "ROT vid värmepump", "Totalpris saknas, så schablonen för värmepump går inte att räkna.", src(ref, "skatteverket_rot_varmepump"));
      }
    } else if (laborInclVat !== null) {
      const expected = laborInclVat * rot.rate;
      const ok = withinTol(rotAmt, expected, rot.tolerance);
      const usedRate = rotRate !== null ? rotRate : rotAmt / laborInclVat;
      if (ok) {
        add("rot_belopp", "ok", "ROT-belopp", `ROT-avdraget ${kr(rotAmt)} är ${Math.round(rot.rate * 100)} % av arbetskostnaden ${kr(laborInclVat)} inklusive moms.`, src(ref, "skatteverket_rot"));
      } else if (Math.abs(usedRate - rot.oldRate) < 0.02) {
        // c) 50 % med betalning 2026
        const pay2025 = payDate && inRange(payDate, rot.oldRateWindow.from, rot.oldRateWindow.to);
        add("rot_belopp", pay2025 ? "ok" : "fel", "ROT-sats",
          pay2025
            ? `ROT-avdraget är räknat med ${Math.round(rot.oldRate * 100)} %, vilket gällde för betalningar ${rot.oldRateWindow.from} – ${rot.oldRateWindow.to}. Betalningsdatumet i offerten ligger i det fönstret.`
            : `ROT-avdraget är räknat med ${Math.round(rot.oldRate * 100)} %. ${rot.quote} För betalning 2026 är avdraget ${Math.round(rot.rate * 100)} %, alltså ${kr(expected)} i stället för ${kr(rotAmt)}.`,
          src(ref, "skatteverket_rot"));
      } else {
        add("rot_belopp", "fel", "ROT-belopp",
          `${Math.round(rot.rate * 100)} % av arbetskostnaden ${kr(laborInclVat)} inklusive moms är ${kr(expected)}. Offerten anger ${kr(rotAmt)}${rotRate !== null ? ` (${Math.round(rotRate * 100)} %)` : ""}.`,
          src(ref, "skatteverket_rot"));
      }
    } else if (x.priceType !== "fast") {
      add("rot_belopp", "ej_bedombar", "ROT-belopp", "Arbetskostnaden anges inte separat, så ROT-beloppet går inte att räkna efter.", src(ref, "skatteverket_rot"));
    }

    // b) ROT på material eller resor
    if (x.rotOnMaterialOrTravel === true) {
      add("rot_material", "fel", "ROT på material eller resor", "ROT-avdrag får bara göras på arbetskostnaden, inte på material, resor eller servicebil. Offerten räknar avdrag på annat än arbete.", src(ref, "skatteverket_rot"));
    } else if (labor !== null && material !== null && !isHeatPump) {
      const onAll = withinTol(rotAmt, (laborInclVat + (vat === "exkl" ? material * 1.25 : material) + (travel === null ? 0 : vat === "exkl" ? travel * 1.25 : travel)) * rot.rate, rot.tolerance);
      const onLabor = withinTol(rotAmt, laborInclVat * rot.rate, rot.tolerance);
      if (onAll && !onLabor) {
        add("rot_material", "fel", "ROT på material eller resor", "ROT-beloppet motsvarar avdrag på hela summan, inklusive material. Avdraget får bara räknas på arbetskostnaden.", src(ref, "skatteverket_rot"));
      }
    }

    // d) Tak per person
    if (rotAmt > rot.maxPerPerson) {
      const need = Math.ceil(rotAmt / rot.maxPerPerson);
      if (persons === null) {
        add("rot_tak", "fraga", "ROT-tak per person",
          `ROT-avdraget ${kr(rotAmt)} är mer än ${kr(rot.maxPerPerson)}, som är taket per person och år. Det kräver minst ${need} personer med avdragsutrymme – offerten anger inte hur många som ska dela på avdraget.`,
          src(ref, "skatteverket_rot"));
      } else if (persons * rot.maxPerPerson < rotAmt) {
        add("rot_tak", "fel", "ROT-tak per person", `${persons} ${persons === 1 ? "person" : "personer"} ger högst ${kr(persons * rot.maxPerPerson)} i ROT-avdrag per år. Offerten räknar med ${kr(rotAmt)}.`, src(ref, "skatteverket_rot"));
      } else {
        add("rot_tak", "flagga", "ROT-tak per person", `ROT-avdraget ${kr(rotAmt)} fördelas på ${persons} personer. Taket är ${kr(rot.maxPerPerson)} per person och år, och ROT och RUT tillsammans högst ${kr(rot.maxRotRut)} – tidigare avdrag under året minskar utrymmet.`, src(ref, "skatteverket_rot"));
      }
    }

    // e) Undantagslista
    const text = `${x.jobType || ""} ${x.workDescription || ""}`.toLowerCase();
    const hit = (rot.exceptions || []).find((e) => e.keywords.some((k) => text.includes(k)));
    if (hit) {
      add("rot_undantag", "flagga", "ROT-berättigat arbete", `${hit.label} ger normalt inte rätt till ROT-avdrag enligt Skatteverkets lista. Offerten räknar med ROT – det behöver stämmas av.`, src(ref, "skatteverket_rot_undantag"));
    }
  }

  // --- g) Timmar × timpris = arbetssumma; rader = total ---
  if (rate !== null && hours !== null && labor !== null) {
    const ok = withinTol(rate * hours, labor, 0.02);
    add("arbetssumma", ok ? "ok" : "fel", "Timmar × timpris",
      ok ? `${hours} timmar × ${kr(rate)} = ${kr(rate * hours)}, vilket stämmer med arbetssumman.` : `${hours} timmar × ${kr(rate)} = ${kr(rate * hours)}, men arbetssumman anges till ${kr(labor)}.`, "");
  }
  if (total !== null && labor !== null && material !== null) {
    const rows = labor + material + (travel || 0) + other;
    const rowsWithVat = vat === "exkl" && x.totalIncludesVat ? rows * 1.25 : rows;
    const okBefore = withinTol(rowsWithVat, total, 0.02);
    const okAfter = rotAmt !== null && withinTol(rowsWithVat - rotAmt, total, 0.02);
    add("summa", okBefore || okAfter ? "ok" : "fel", "Summering",
      okBefore ? `Raderna (arbete ${kr(labor)} + material ${kr(material)}${travel ? ` + resor ${kr(travel)}` : ""}${other ? ` + övrigt ${kr(other)}` : ""}) summerar till totalen ${kr(total)}.`
        : okAfter ? `Raderna summerar till ${kr(rowsWithVat)}, och efter ROT-avdrag ${kr(rotAmt)} blir det ${kr(total)} att betala – det stämmer.`
        : `Raderna summerar till ${kr(rowsWithVat)}${rotAmt !== null ? ` (${kr(rowsWithVat - rotAmt)} efter ROT)` : ""}, men totalen anges till ${kr(total)}.`, "");
  }

  // --- h2) Pristyp saknas ---
  if (!x.priceType) {
    add("pristyp", "flagga", "Pristyp", `Offerten anger inte om priset är fast, ungefärligt eller löpande. Ett ungefärligt pris får överskridas med högst ${Math.round(ref.consumer.approxOverrunMax * 100)} %; ett löpande pris har inget tak.`, src(ref, "konsumentverket_pris"));
  } else if (x.priceType === "ungefarligt") {
    add("pristyp", "ok", "Pristyp", `Ungefärligt pris. Det får överskridas med högst ${Math.round(ref.consumer.approxOverrunMax * 100)} % om inget annat avtalats.`, src(ref, "konsumentverket_pris"));
  } else if (x.priceType === "lopande") {
    add("pristyp", "flagga", "Pristyp", "Löpande räkning utan angivet tak. Ett takpris eller en uppskattning i offerten ger något att hålla slutfakturan mot.", src(ref, "konsumentverket_pris"));
  } else {
    add("pristyp", "ok", "Pristyp", "Fast pris anges.", "");
  }

  if (!payDate && rotAmt !== null) {
    add("betaldatum", "ej_bedombar", "Betalningsdatum", "Varken offertdatum eller planerad betalning anges. ROT-satsen styrs av när betalningen sker, så kontrollen ovan utgår från betalning i år.", src(ref, "skatteverket_rot"));
  }

  return out;
}

// Normala tillägg flaggas inte (framkörning, materialpåslag) — men de
// redovisas i "Kontrollerat" så att läsaren ser att de granskats.
export function checkNormalAddons(x, ref) {
  const out = [];
  const travel = num(x.travelSumSek);
  const markup = pct(x.materialMarkupPct);
  const a = ref.addons;
  if (travel !== null) {
    const inside = travel >= a.travel.min && travel <= a.travel.max;
    out.push({ id: "framkorning", status: inside ? "ok" : "flagga", title: "Framkörning / servicebil",
      text: inside ? `Framkörning ${kr(travel)} ligger inom det vanliga spannet ${krRange(a.travel.min, a.travel.max)}.`
        : `Framkörning ${kr(travel)}. Vanligt spann är ${krRange(a.travel.min, a.travel.max)} – en fråga att ställa om vad som ingår.`,
      source: src(ref, a.travel.source) });
  }
  if (markup !== null) {
    const inside = markup >= a.materialMarkup.min && markup <= a.materialMarkup.max;
    out.push({ id: "paslag", status: inside ? "ok" : "flagga", title: "Materialpåslag",
      text: inside ? `Materialpåslag ${Math.round(markup * 100)} % ligger inom det vanliga spannet ${Math.round(a.materialMarkup.min * 100)}–${Math.round(a.materialMarkup.max * 100)} %.`
        : `Materialpåslag ${Math.round(markup * 100)} %. Vanligt spann är ${Math.round(a.materialMarkup.min * 100)}–${Math.round(a.materialMarkup.max * 100)} % – en fråga att ställa.`,
      source: src(ref, a.materialMarkup.source) });
  }
  return out;
}

// ---- Prisjämförelse mot band (lager 2). Ordval LÅST enligt PRISUNDERLAG
// "Ordval — låst"; texterna hämtas ur reference.json (wording) så att koden
// aldrig formulerar egna omdömen. Lägen: under (golv), under_band, inom, over.
// Banden gäller före ROT. totalSumSek är summan att betala (efter ROT om
// ROT dragits av). Är raderna kända och summerar till totalen är totalen
// redan före ROT; annars läggs ROT tillbaka.
export function totalBeforeRot(x) {
  const total = num(x.totalSumSek);
  const rotAmt = num(x.rotAmountSek);
  if (total === null) return null;
  if (rotAmt === null || rotAmt <= 0) return total;
  const labor = num(x.laborSumSek), material = num(x.materialSumSek), travel = num(x.travelSumSek) || 0, other = num(x.otherSumSek) || 0;
  if (labor !== null && material !== null && withinTol(labor + material + travel + other, total, 0.02)) return total;
  return total + rotAmt;
}

export function compareToBands(x, ref) {
  const out = [];
  const W = ref.wording;
  const vat = x.vatMode || "ej_angivet";
  const rate = num(x.hourlyRateSek);
  const useIncl = vat !== "exkl";
  const unit = useIncl ? "inkl. moms" : "exkl. moms";
  const trades = Array.isArray(x.trades) ? x.trades : [];

  for (const t of trades) {
    const band = ref.hourly[t];
    if (!band || t.startsWith("_")) continue;
    if (rate === null) {
      out.push({ id: `tim_${t}`, mode: "ej_bedombar", title: `Timpris ${band.label}`,
        text: W.noRate.replace("{q}", W.questions.askRate), source: band.source });
      continue;
    }
    const b = useIncl ? band.inclVat : band.exclVat;
    const range = `${krRange(b.normal[0], b.normal[1])} per timme ${unit}`;
    const fill = (s) => s.replace("{rate}", kr(rate) + " per timme " + unit).replace("{range}", range)
      .replace("{floor}", kr(b.floor)).replace("{unit}", unit).replace("{trade}", band.label).replace("{source}", band.source);
    let mode, text;
    if (rate < b.floor) { mode = "under"; text = fill(W.belowFloor); }
    else if (rate > b.normal[1]) { mode = "over"; text = fill(W.aboveNormal); }
    else if (rate < b.normal[0]) { mode = "under_band"; text = fill(W.belowNormal); }
    else { mode = "inom"; text = fill(W.withinNormal); }
    out.push({ id: `tim_${t}`, mode, title: `Timpris ${band.label}`, text, source: band.source });
  }

  const p = x.jobType && ref.projects[x.jobType];
  if (p && !String(x.jobType).startsWith("_")) {
    const title = `${p.basis === "arbete" ? "Arbetskostnad" : "Totalpris"} ${p.label}`;
    if (p.noReference) {
      out.push({ id: "projekt", mode: "ej_bedombar", title, text: W.noProjectReference.replace("{Job}", p.label.charAt(0).toUpperCase() + p.label.slice(1)).replace("{job}", p.label), source: "" });
      return out;
    }
    const labor = num(x.laborSumSek);
    const total = totalBeforeRot(x);
    const base = p.basis === "arbete" ? labor : total;
    if (p.basis === "arbete" && labor === null) {
      out.push({ id: "projekt", mode: "ej_bedombar", title, text: W.noLabor.replace("{job}", p.label), source: p.source });
      return out;
    }
    if (base === null) {
      out.push({ id: "projekt", mode: "ej_bedombar", title, text: W.noTotal, source: "" });
      return out;
    }
    let value = base, perTxt = "";
    if (p.per === "m2" || p.per === "st") {
      const q = p.per === "m2" ? num(x.areaM2) : num(x.unitCount);
      if (q === null || q <= 0) {
        out.push({ id: "projekt", mode: "ej_bedombar", title,
          text: W.noQuantity.replace("{job}", p.label).replace("{perUnit}", p.per === "m2" ? "per m²" : "per styck").replace("{quantity}", p.per === "m2" ? "yta i m²" : "mängd i antal"),
          source: p.source });
        return out;
      }
      value = base / q;
      perTxt = p.per === "m2" ? " per m²" : " per styck";
    }
    const range = `${krRange(p.normal[0], p.normal[1])}${perTxt}${p.scope ? ", " + p.scope : ""}`;
    const fill = (s) => s.replace("{total}", kr(value) + perTxt).replace("{range}", range).replace("{job}", p.label).replace("{source}", p.source);
    const lab = p.basis === "arbete";
    let mode, text;
    if (value < p.normal[0]) { mode = "under"; text = fill(lab ? W.projectLaborBelow : W.projectBelow); }
    else if (value > p.normal[1]) { mode = "over"; text = fill(lab ? W.projectLaborAbove : W.projectAbove); }
    else { mode = "inom"; text = fill(lab ? W.projectLaborWithin : W.projectWithin); }
    out.push({ id: "projekt", mode, title, text, source: p.source });
  }
  return out;
}

// ---- Hård strängkontroll: förbjudna ord får inte förekomma någonstans ----
const FORBIDDEN_RE = new RegExp(`(${FORBIDDEN_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "giu");

export function findForbidden(value, path = "", acc = []) {
  if (typeof value === "string") {
    const m = value.match(FORBIDDEN_RE);
    if (m) acc.push({ path, words: [...new Set(m.map((s) => s.toLowerCase()))] });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => findForbidden(v, `${path}[${i}]`, acc));
  } else if (value && typeof value === "object") {
    for (const k of Object.keys(value)) findForbidden(value[k], path ? `${path}.${k}` : k, acc);
  }
  return acc;
}

// Ersätter förbjudna ord med neutral formulering. Används som sista spärr på
// modellens fritext; regel- och jämförelsetexterna är hårdkodade utan orden.
const REPLACEMENTS = [
  [/för dyrt/giu, "över referensintervallet"],
  [/överpris(er|et|at|ad)?/giu, "pris över referensintervallet"],
  [/oseriös(t|a)?/giu, "otydlig"],
  [/fusk(et|ar|a)?/giu, "avvikelse"],
  [/\bsvart(a|jobb|arbete|arbeten)?\b/giu, "ej redovisat"],
];
export function scrubForbidden(value) {
  if (typeof value === "string") {
    let s = value;
    for (const [re, rep] of REPLACEMENTS) s = s.replace(re, rep);
    return s;
  }
  if (Array.isArray(value)) return value.map(scrubForbidden);
  if (value && typeof value === "object") {
    const o = {};
    for (const k of Object.keys(value)) o[k] = scrubForbidden(value[k]);
    return o;
  }
  return value;
}
