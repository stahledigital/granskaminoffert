// Prisregler för Granska min offert — deterministisk kod, inte LLM.
// Underlag: PRISUNDERLAG_GRANSKAMINOFFERT.md (Moneyman, 2026-09) lager 1 a–i,
// siffror och källor i reference.json. Inga egna siffror här.
//
// Inmatning: `x` = strukturerade fält som modellen extraherat (null = saknas,
// aldrig gissat). Utmatning: lista av kontroller med status
//   ok | fel | fraga | flagga | ej_bedombar
// och text på svenska med källa och datum där en regel bygger på en källa.

export const FORBIDDEN_WORDS = ["för dyrt", "överpris", "svart", "oseriöst", "oseriös", "fusk"];

import { vatFactor, resolveTotals, rowsSumStated, rowsSumIncl, totalCandidates, laborCandidates, VAT_RATE } from "./amounts.js";

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
  const rotAmt = num(x.rotAmountSek);
  const rotRate = pct(x.rotRatePct);
  const persons = num(x.rotPersons);
  const rate = num(x.hourlyRateSek);
  const hours = num(x.hours);
  // Saknat eller ogiltigt momsläge är "okant_moms", aldrig ett antagande.
  const vat = x.vatMode || "okant_moms";
  const f = vatFactor(vat); // null = okänd moms (ej_angivet, blandat, okant_moms)
  const vatUnknown = f === null;
  const consumer = x.customerType !== "foretag";
  const payDate = paymentDate(x);
  const isHeatPump = x.jobType === "bergvarme" || x.jobType === "luftvarmepump" || x.jobType === "varmepump";

  // --- f) Moms ---
  // Känd moms (inkl/exkl) normaliseras till inklusive moms med känd sats oavsett
  // kundtyp. Okänd moms görs aldrig om till ett faktum: de kontroller som
  // beror på moms visar då fråga i stället för ok/fel.
  if (vat === "ej_angivet") {
    add("moms", consumer ? "flagga" : "fraga", "Moms",
      consumer
        ? "Offerten anger inte om priserna är inklusive eller exklusive moms. Mot privatperson är utgångspunkten att ett pris utan angivelse är inklusive moms, men eftersom offerten inte säger det går belopp som beror på moms inte att kontrollera med säkerhet och visas som frågor."
        : "Offerten anger inte om priserna är inklusive eller exklusive moms. Det behöver framgå, och belopp som beror på moms går inte att kontrollera med säkerhet.",
      src(ref, "konsumentverket_pris"));
  } else if (vat === "blandat") {
    add("moms", "fel", "Moms", "Offerten blandar priser inklusive och exklusive moms. Alla belopp behöver anges på samma sätt.", "");
  } else if (vat === "okant_moms") {
    add("moms", "fraga", "Moms", "Momsläget i offerten gick inte att läsa ut på ett tillförlitligt sätt. Belopp som beror på moms går därför inte att kontrollera och visas som frågor.", "");
  } else {
    add("moms", "ok", "Moms", `Priserna anges ${vat === "inkl" ? "inklusive" : "exklusive"} moms, konsekvent.`, "");
  }

  // Arbetskostnad inklusive moms (null om momsläget är okänt).
  const laborInclVat = labor === null || f === null ? null : labor * f;

  // --- i) Fast pris utan uppdelning ---
  // Värmepump: schablonen (rot_schablon) ersätter uppdelningskravet, så den raden
  // visas inte; annars stod "går inte att kontrollera" bredvid en genomförd kontroll.
  if (x.priceType === "fast" && labor === null && rotAmt !== null && isHeatPump) {
    // ingen uppdelningsrad
  } else if (x.priceType === "fast" && labor === null && rotAmt !== null) {
    add("uppdelning", "ej_bedombar", "Arbete och material",
      "Fast pris utan uppdelning i arbete och material. ROT-avdraget går då inte att kontrollera – be om uppdelningen, eftersom avdraget bara får räknas på arbetskostnaden.",
      src(ref, "skatteverket_rot"));
  } else if (x.priceType === "fast" && labor === null) {
    add("uppdelning", "ej_bedombar", "Arbete och material",
      "Fast pris utan uppdelning i arbete och material. Priset går då inte att kontrollera mot timpris eller referensintervall – be om uppdelningen.",
      "");
  }

  // Ett datum för ROT-satsen: 50 % gällde bara betalning inom fönstret.
  const oldRateText = (usedRate, expectedAmt) => {
    const hasPay = Boolean(x.plannedPaymentDate);
    const pay2025 = hasPay && inRange(x.plannedPaymentDate, rot.oldRateWindow.from, rot.oldRateWindow.to);
    const quote2025 = !hasPay && x.quoteDate && inRange(x.quoteDate, rot.oldRateWindow.from, rot.oldRateWindow.to);
    const status = pay2025 ? (vatUnknown ? "fraga" : "ok") : quote2025 ? "fraga" : "fel";
    const text = pay2025
      ? `ROT-avdraget är räknat med ${Math.round(rot.oldRate * 100)} %, vilket gällde för betalningar ${rot.oldRateWindow.from} – ${rot.oldRateWindow.to}. Betalningsdatumet i offerten ligger i det fönstret.${vatUnknown ? " Momsläget anges inte, så beloppet går inte att räkna efter." : ""}`
      : quote2025
      ? `ROT-avdraget är räknat med ${Math.round(rot.oldRate * 100)} %. Det gällde bara arbete som betalades ${rot.oldRateWindow.from} – ${rot.oldRateWindow.to}, och offerten anger inte när betalningen sker. Betalas arbetet 2026 är avdraget ${Math.round(rot.rate * 100)} %, alltså ${kr(expectedAmt)} i stället för ${kr(rotAmt)}.`
      : `ROT-avdraget är räknat med ${Math.round(rot.oldRate * 100)} %. ${rot.quote} För betalning 2026 är avdraget ${Math.round(rot.rate * 100)} %, alltså ${kr(expectedAmt)} i stället för ${kr(rotAmt)}.`;
    return { status, text };
  };

  // --- a) ROT = 30 % av arbetskostnaden inkl. moms (tolerans 2 %) ---
  if (rotAmt !== null) {
    if (isHeatPump) {
      heatPumpRule();
    } else if (labor !== null && f !== null) {
      const expected = laborInclVat * rot.rate;
      const ok = withinTol(rotAmt, expected, rot.tolerance);
      const usedRate = rotRate !== null ? rotRate : rotAmt / laborInclVat;
      if (ok) {
        add("rot_belopp", "ok", "ROT-belopp", `ROT-avdraget ${kr(rotAmt)} är ${Math.round(rot.rate * 100)} % av arbetskostnaden ${kr(laborInclVat)} inklusive moms.`, src(ref, "skatteverket_rot"));
      } else if (Math.abs(usedRate - rot.oldRate) < 0.02) {
        const r = oldRateText(usedRate, expected);
        add("rot_belopp", r.status, "ROT-sats", r.text, src(ref, "skatteverket_rot"));
      } else {
        add("rot_belopp", "fel", "ROT-belopp",
          `${Math.round(rot.rate * 100)} % av arbetskostnaden ${kr(laborInclVat)} inklusive moms är ${kr(expected)}. Offerten anger ${kr(rotAmt)}${rotRate !== null ? ` (${Math.round(rotRate * 100)} %)` : ""}.`,
          src(ref, "skatteverket_rot"));
      }
    } else if (labor !== null) {
      // Okänd moms: beloppet kan stämma under den ena tolkningen. Det är en
      // fråga, aldrig ett ok. Stämmer det under ingen tolkning är det ett fel.
      const inclHit = withinTol(rotAmt, labor * rot.rate, rot.tolerance);
      const exklHit = withinTol(rotAmt, labor * (1 + VAT_RATE) * rot.rate, rot.tolerance);
      const usedRate = rotRate !== null ? rotRate : rotAmt / labor;
      if (exklHit && !inclHit) {
        add("rot_belopp", "fraga", "ROT-belopp",
          `ROT-avdraget ${kr(rotAmt)} stämmer om arbetskostnaden ${kr(labor)} är angiven exklusive moms, men inte om den är inklusive moms. Offerten anger inte vilket – fråga efter det, så går beloppet att kontrollera.`,
          src(ref, "skatteverket_rot"));
      } else if (inclHit && !exklHit) {
        add("rot_belopp", "fraga", "ROT-belopp",
          `ROT-avdraget ${kr(rotAmt)} stämmer om arbetskostnaden ${kr(labor)} är angiven inklusive moms, men inte om den är exklusive moms. Offerten anger inte vilket – fråga efter det, så går beloppet att kontrollera.`,
          src(ref, "skatteverket_rot"));
      } else if (Math.abs(usedRate - rot.oldRate) < 0.02) {
        const r = oldRateText(usedRate, labor * rot.rate);
        add("rot_belopp", r.status, "ROT-sats", r.text, src(ref, "skatteverket_rot"));
      } else {
        add("rot_belopp", "fel", "ROT-belopp",
          `${Math.round(rot.rate * 100)} % av arbetskostnaden ${kr(labor)} blir ${kr(labor * rot.rate)} om beloppet är inklusive moms och ${kr(labor * (1 + VAT_RATE) * rot.rate)} om det är exklusive moms. Offerten anger ${kr(rotAmt)}, vilket inte stämmer med någon av tolkningarna.`,
          src(ref, "skatteverket_rot"));
      }
    } else if (x.priceType !== "fast") {
      add("rot_belopp", "ej_bedombar", "ROT-belopp", "Arbetskostnaden anges inte separat, så ROT-beloppet går inte att räkna efter.", src(ref, "skatteverket_rot"));
    }

    // b) ROT på material eller resor
    if (x.rotOnMaterialOrTravel === true) {
      add("rot_material", "fel", "ROT på material eller resor", "ROT-avdrag får bara göras på arbetskostnaden, inte på material, resor eller servicebil. Offerten räknar avdrag på annat än arbete.", src(ref, "skatteverket_rot"));
    } else if (labor !== null && material !== null && !isHeatPump && f !== null) {
      const onAll = withinTol(rotAmt, (laborInclVat + material * f + (travel === null ? 0 : travel * f)) * rot.rate, rot.tolerance);
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

  // --- Totalsummor som motsäger varandra ---
  {
    const t0 = resolveTotals(x);
    if (t0.conflict) {
      add("total_konflikt", "fel", "Summa före ROT och summa att betala",
        `Offerten anger både summa före ROT-avdrag (${kr(t0.before)}) och summa att betala (${kr(t0.toPay)}). ${rotAmt ? `Efter ROT-avdraget ${kr(rotAmt)} borde summan att betala vara ${kr(t0.expectedPay)}` : `Utan ROT-avdrag borde summan att betala vara ${kr(t0.expectedPay)}`}. Uppgifterna stämmer inte med varandra – be om en rättad offert.`, "");
    }
  }

  // --- h) Värmepumpsschablon ---
  // Skatteverket (sidan "Ger arbetet rätt till rotavdrag", avsnittet om
  // värmesystem): andel av TOTALPRISET räknas som arbete (35 % vätska–vatten,
  // 30 % luftvärmepumpar) och schablonen gäller totalentreprenad till fast
  // pris i småhus. Sidan anger inte uttryckligen om totalpriset är inklusive
  // moms; vi bedömer därför bara när totalen uttryckligen är inklusive moms
  // (INFERRED: arbetskostnad för ROT räknas inklusive moms) och visar annars
  // båda utfallen som fråga. Saknas fast pris eller bostadstyp blir resultatet
  // en fråga, aldrig ok. Regeln använder summan FÖRE ROT, aldrig summan att
  // betala.
  function heatPumpRule() {
    const title = "ROT vid värmepump";
    const source = src(ref, "skatteverket_rot_varmepump");
    const share = x.jobType === "bergvarme" ? rot.heatPumpShare.bergvarme : rot.heatPumpShare.other;
    const sharePct = Math.round(share * 100), ratePct = Math.round(rot.rate * 100);
    const priceTypeTxt = { fast: "fast pris", ungefarligt: "ungefärligt pris", lopande: "löpande räkning" }[x.priceType];
    if (x.priceType !== "fast") {
      add("rot_schablon", "fraga", title,
        `Schablonen för värmepump gäller när företaget utför totalentreprenad till fast pris. ${priceTypeTxt ? `Offerten anger ${priceTypeTxt}.` : "Offerten anger inte pristyp."} ROT-beloppet går därför inte att kontrollera mot schablonen. Fråga om priset är fast.`, source);
      return;
    }
    const t = resolveTotals(x);
    if (t.status === "saknas") {
      add("rot_schablon", "ej_bedombar", title, "Totalpris saknas, så schablonen för värmepump går inte att räkna.", source);
      return;
    }
    const calc = (beforeRotIncl) => beforeRotIncl * share * rot.rate;
    if (t.status === "oklar") {
      const alts = t.alternatives.map((a) => `om ${a.label} är schablonen ${kr(calc(a.beforeRotIncl))}`).join("; ");
      add("rot_schablon", "fraga", title,
        `Schablonen räknas på totalpriset före ROT-avdrag (${sharePct} % av det räknas som arbete, och avdraget är ${ratePct} % av det). Offerten anger inte tydligt vilken summa som är före ROT-avdrag och vilket momsläge den har${t.conflict ? " (uppgifterna om summa före ROT och summa att betala stämmer inte med varandra)" : ""}: ${alts}. Offerten anger ${kr(rotAmt)}. Be om summa före ROT-avdrag, summa att betala och momsläge.`, source);
      return;
    }
    // Belagd summa före ROT. Skatteverkets sida anger inte om totalpriset är
    // inklusive eller exklusive moms (UNKNOWN), och fast pris + småhus bevisar
    // inte totalentreprenad. Regeln visar därför ett villkorat räkneexempel och
    // en fråga, aldrig "regeln stämmer" – och "fel" bara när alla villkor är
    // uttryckligen angivna och ingen momsbas ger det angivna avdraget.
    const inclExpected = calc(t.beforeRotIncl);
    const exklExpected = calc(t.beforeRotIncl / (1 + VAT_RATE));
    const matchIncl = withinTol(rotAmt, inclExpected, rot.tolerance);
    const matchExkl = withinTol(rotAmt, exklExpected, rot.tolerance);
    const missing = [];
    if (x.propertyType !== "smahus") {
      missing.push(x.propertyType ? "offerten gäller en annan bostadstyp än småhus, och schablonen kan inte användas för bostadsrätt" : "offerten anger inte bostadstyp (schablonen gäller småhus, inte bostadsrätt)");
    }
    if (x.totalContract !== "ja") {
      missing.push(x.totalContract === "nej" ? "offerten anger att arbetet inte är en totalentreprenad" : "offerten anger inte att företaget utför totalentreprenad (värmepump och installation i ett fast pris)");
    }
    const example = `Av totalpriset ${kr(t.beforeRotIncl)} före ROT (${t.basis === "exkl" ? "angivet exklusive moms, omräknat med 25 % moms" : "inklusive moms"}) räknas ${sharePct} % som arbete och avdraget är ${ratePct} % av det: ${kr(inclExpected)} om schablonen räknas på pris inklusive moms, ${kr(exklExpected)} om den räknas exklusive moms. Offerten anger ${kr(rotAmt)}${matchIncl ? ", vilket stämmer med räkningen inklusive moms" : matchExkl ? ", vilket stämmer med räkningen exklusive moms" : ", vilket inte stämmer med någon av räkningarna"}. Skatteverkets sida anger inte vilken momsbas schablonen använder, så beloppet går inte att bekräfta – fråga hur avdraget är räknat.`;
    if (!missing.length && !matchIncl && !matchExkl) {
      add("rot_schablon", "fel", title, example, source);
      return;
    }
    add("rot_schablon", "fraga", title, `${missing.length ? `Villkor som inte är belagda: ${missing.join("; ")}. ` : ""}${example}`, source);
  }

  // --- g) Timmar × timpris = arbetssumma; rader = total ---
  if (rate !== null && hours !== null && labor !== null) {
    const ok = withinTol(rate * hours, labor, 0.02);
    add("arbetssumma", ok ? "ok" : "fel", "Timmar × timpris",
      ok ? `${hours} timmar × ${kr(rate)} = ${kr(rate * hours)}, vilket stämmer med arbetssumman.` : `${hours} timmar × ${kr(rate)} = ${kr(rate * hours)}, men arbetssumman anges till ${kr(labor)}.`, "");
  }
  if (labor !== null && material !== null) summaRule();

  // Summering: raderna mot totalen. OK kräver belagd bas (explicit före ROT /
  // att betala / momsbas, eller att raderna stämmer av mot exakt en tolkning).
  function summaRule() {
    const t = resolveTotals(x);
    if (t.status === "saknas") return;
    if (t.conflict) return; // redovisas av total_konflikt
    const rowsStated = rowsSumStated(x);
    const rowsIncl = rowsSumIncl(x);
    const rowsTxt = `arbete ${kr(labor)} + material ${kr(material)}${travel ? ` + resor ${kr(travel)}` : ""}${num(x.otherSumSek) ? ` + övrigt ${kr(num(x.otherSumSek))}` : ""}`;
    const hasRot = rotAmt !== null && rotAmt > 0;
    if (t.status === "belagd" && rowsIncl !== null) {
      const ok = withinTol(rowsIncl, t.beforeRotIncl, 0.02);
      const after = hasRot && (t.source === "rader" || t.source === "explicit_att_betala") && withinTol(rowsIncl - rotAmt, t.toPayIncl, 0.02);
      if (ok) {
        add("summa", "ok", "Summering",
          after
            ? `Raderna summerar till ${kr(rowsIncl)}, och efter ROT-avdrag ${kr(rotAmt)} blir det ${kr(t.toPayIncl)} att betala – det stämmer.`
            : `Raderna (${rowsTxt}) summerar till totalen ${kr(t.beforeRotIncl)}${f !== 1 ? " inklusive moms" : ""}.`, "");
      } else {
        add("summa", "fel", "Summering",
          `Raderna summerar till ${kr(rowsIncl)}${hasRot ? ` (${kr(rowsIncl - rotAmt)} efter ROT)` : ""}, men totalen anges till ${kr(t.beforeRotIncl)} före ROT-avdrag.`, "");
      }
      return;
    }
    // Obelagd bas (radernas eller totalens moms, eller före/efter ROT, oklart).
    const rowCands = rowsIncl !== null ? [rowsIncl] : [rowsStated, rowsStated * (1 + VAT_RATE)];
    const alts = t.status === "belagd" ? [{ label: "", beforeRotIncl: t.beforeRotIncl }] : t.alternatives;
    const matched = alts.filter((a) => rowCands.some((r) => withinTol(r, a.beforeRotIncl, 0.02)));
    if (!matched.length) {
      add("summa", "fel", "Summering",
        `Raderna (${rowsTxt}) summerar till ${kr(rowCands[0])}${rowCands.length > 1 ? ` (${kr(rowCands[1])} om raderna är exklusive moms)` : ""}, vilket inte stämmer med totalen under någon tolkning av om den är före eller efter ROT-avdrag eller vilket momsläge den har.`, "");
    } else {
      add("summa", "fraga", "Summering",
        `Raderna (${rowsTxt}) stämmer med totalen om ${matched.map((m) => m.label || "momsläget är det som antagits").join(" respektive om ")}. Offerten anger inte tydligt vilket, så summeringen kan inte bekräftas – be om summa före ROT-avdrag, summa att betala och momsläge.`, "");
    }
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
    // Spannet gäller kr PER BESÖK; offerten anger oftast en summa för alla besök
    // (T07/T08). Utan antal besök går summan inte att jämföra mot ett per-besöksspann.
    const visits = num(x.travelVisits);
    const perVisit = visits !== null && visits >= 1 ? travel / visits : null;
    const range = krRange(a.travel.min, a.travel.max);
    if (perVisit !== null) {
      const inside = perVisit >= a.travel.min && perVisit <= a.travel.max;
      const calcTxt = visits === 1 ? kr(travel) : `${kr(travel)} för ${visits} besök, ${kr(perVisit)} per besök`;
      out.push({ id: "framkorning", status: inside ? "ok" : "flagga", title: "Framkörning / servicebil",
        text: inside ? `Framkörning ${calcTxt} ligger inom det vanliga spannet ${range} per besök.`
          : `Framkörning ${calcTxt}. Vanligt spann är ${range} per besök – en fråga att ställa om vad som ingår.`,
        source: src(ref, a.travel.source) });
    } else {
      // Antal besök saknas: ett belopp inom per-besöksspannet är bara ett OK om det gäller ett besök, vilket
      // offerten inte säger. Därför alltid fråga, aldrig OK på hypotesen "ett besök" (T08).
      const inside = travel >= a.travel.min && travel <= a.travel.max;
      out.push({ id: "framkorning", status: "fraga", title: "Framkörning / servicebil",
        text: inside ? `Framkörning ${kr(travel)}. Spannet ${range} gäller per besök, och offerten anger inte antal besök: summan ryms om den gäller ett besök, men är den summan för flera besök blir priset per besök lägre. Fråga hur många besök den gäller.`
          : `Framkörning ${kr(travel)} totalt. Vanligt spann är ${range} per besök och offerten anger inte antal besök, så summan går inte att jämföra. Fråga hur många besök den gäller och vad som ingår.`,
        source: src(ref, a.travel.source) });
    }
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
// Banden gäller inklusive moms och före ROT. Vilken summa offerten anger och i
// vilken momsbas avgörs på ETT ställe (amounts.js). Är beloppsbasen oklar
// jämförs inte ett "troligt" värde: priset redovisas som ej bedömbart med
// varje tolkning utskriven. Referenser med `scopeArea` (badrum 4–6 m²) jämförs
// bara när offertens yta ligger inom omfånget.
const own = (o, k) => typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);

export function compareToBands(x, ref) {
  const out = [];
  const W = ref.wording;
  const rate = num(x.hourlyRateSek);
  const vatKnown = x.vatMode === "inkl" || x.vatMode === "exkl";
  const trades = Array.isArray(x.trades) ? x.trades : [];
  const put = (s, key, value) => s.split(key).join(value);

  for (const t of trades) {
    if (!own(ref.hourly, t) || t.startsWith("_")) continue;
    const band = ref.hourly[t];
    if (rate === null) {
      out.push({ id: `tim_${t}`, mode: "ej_bedombar", title: `Timpris ${band.label}`,
        text: W.noRate.replace("{q}", W.questions.askRate), source: band.source });
      continue;
    }
    const classify = (b) => (rate > b.normal[1] ? "over" : rate < b.normal[0] ? "under_band" : "inom");
    const fillFor = (b, unit) => (s) => [["{rate}", kr(rate) + " per timme " + unit], ["{range}", `${krRange(b.normal[0], b.normal[1])} per timme ${unit}`],
      ["{floor}", kr(b.floor)], ["{unit}", unit], ["{trade}", band.label], ["{source}", band.source]].reduce((acc, [k, v]) => put(acc, k, v), s);
    const textFor = (mode, fill) => fill(mode === "over" ? W.aboveNormal : mode === "under_band" ? W.belowNormal : W.withinNormal);

    if (vatKnown) {
      const b = x.vatMode === "inkl" ? band.inclVat : band.exclVat;
      const unit = x.vatMode === "inkl" ? "inkl. moms" : "exkl. moms";
      const fill = fillFor(b, unit);
      const mode = classify(b);
      out.push({ id: `tim_${t}`, mode, title: `Marknad – timpris ${band.label}`, text: textFor(mode, fill), source: band.source });
      if (rate < b.floor) out.push({ id: `lonekostnad_${t}`, mode: "under", title: `Lönekostnad – timpris ${band.label}`, text: fill(W.belowFloor), source: band.floorSource || band.source });
      continue;
    }

    // Okänd momsbas: priset kan vara inklusive eller exklusive moms. Båda
    // jämförs; bara om de ger samma bedömning redovisas den, annars avstår vi.
    const mi = classify(band.inclVat), me = classify(band.exclVat);
    if (mi === me) {
      const fill = fillFor(band.inclVat, "inkl. moms");
      const text = textFor(mi, fill) + " " + W.hourlyVatUnknownSame;
      out.push({ id: `tim_${t}`, mode: mi, title: `Marknad – timpris ${band.label}`, text, source: band.source });
    } else {
      const text = put(put(put(put(W.hourlyVatUnknownDiffer, "{rate}", kr(rate) + " per timme"), "{trade}", band.label),
        "{rangeIncl}", krRange(band.inclVat.normal[0], band.inclVat.normal[1])), "{rangeExcl}", krRange(band.exclVat.normal[0], band.exclVat.normal[1]));
      out.push({ id: `tim_${t}`, mode: "ej_bedombar", title: `Marknad – timpris ${band.label}`, text: put(text, "{source}", band.source), source: band.source });
    }
    // Under golvet i båda momsbaser (golvet exkl moms är det lägre).
    if (rate < band.exclVat.floor) {
      const fill = fillFor(band.exclVat, "exkl. moms");
      out.push({ id: `lonekostnad_${t}`, mode: "under", title: `Lönekostnad – timpris ${band.label}`, text: fill(W.belowFloor), source: band.floorSource || band.source });
    }
  }

  if (!own(ref.projects, x.jobType) || String(x.jobType).startsWith("_")) return out;
  const p = ref.projects[x.jobType];
  const lab = p.basis === "arbete";
  const title = `${lab ? "Arbetskostnad" : "Totalpris"} ${p.label}`;
  const abstain = (text, source = p.source) => { out.push({ id: "projekt", mode: "ej_bedombar", title, text, source }); return out; };
  if (p.noReference) return abstain(W.noProjectReference.replace("{Job}", p.label.charAt(0).toUpperCase() + p.label.slice(1)).replace("{job}", p.label), "");

  // Omfång: en referens som gäller en viss yta jämförs bara mot den ytan.
  if (Array.isArray(p.scopeArea)) {
    const a = num(x.areaM2);
    const [lo, hi] = p.scopeArea;
    if (a === null || a <= 0) return abstain(put(put(put(W.scopeAreaMissing, "{job}", p.label), "{scopeArea}", `${lo}–${hi} m²`), "{source}", p.source));
    if (a < lo || a > hi) return abstain(put(put(put(put(W.scopeAreaMismatch, "{job}", p.label), "{scopeArea}", `${lo}–${hi} m²`), "{area}", `${Math.round(a * 10) / 10} m²`), "{source}", p.source));
  }

  const cands = lab ? laborCandidates(x) : totalCandidates(x);
  if (cands.length === 0) return abstain(lab ? W.noLabor.replace("{job}", p.label) : W.noTotal, lab ? p.source : "");

  let q = null, perTxt = "";
  if (p.per === "m2" || p.per === "st") {
    q = p.per === "m2" ? num(x.areaM2) : num(x.unitCount);
    if (q === null || q <= 0) {
      return abstain(W.noQuantity.replace("{job}", p.label).replace("{perUnit}", p.per === "m2" ? "per m²" : "per styck").replace("{quantity}", p.per === "m2" ? "yta i m²" : "mängd i antal"));
    }
    perTxt = p.per === "m2" ? " per m²" : " per styck";
  }
  const range = `${krRange(p.normal[0], p.normal[1])}${perTxt}${p.scope ? ", " + p.scope : ""}`;
  const valueOf = (c) => (q === null ? c.value : c.value / q);
  const modeOf = (v) => (v < p.normal[0] ? "under" : v > p.normal[1] ? "over" : "inom");
  const fillP = (v) => (s) => [["{total}", kr(v) + perTxt], ["{range}", range], ["{job}", p.label], ["{source}", p.source]].reduce((acc, [k, val]) => put(acc, k, val), s);
  const wordingFor = (mode) => (lab ? (mode === "under" ? W.projectLaborBelow : mode === "over" ? W.projectLaborAbove : W.projectLaborWithin)
    : (mode === "under" ? W.projectBelow : mode === "over" ? W.projectAbove : W.projectWithin));

  if (cands.length === 1) {
    const v = valueOf(cands[0]);
    const mode = modeOf(v);
    out.push({ id: "projekt", mode, title, text: fillP(v)(wordingFor(mode)), source: p.source });
    return out;
  }
  // Flera tolkningar av beloppet: ingen bedömning, tolkningarna redovisas.
  const listed = cands.slice(0, 4).map((c) => `${c.label}: ${kr(valueOf(c))}${perTxt}`).join("; ");
  const text = put(put(put(put(put(W.projectBasisUnclear, "{alts}", listed), "{job}", p.label), "{range}", range), "{source}", p.source), "{what}", lab ? "arbetskostnaden" : "totalpriset");
  return abstain(text);
}

// ---- Hård strängkontroll: förbjudna ord får inte förekomma någonstans ----
// Ersätter förbjudna ord med neutral formulering. Samma mönster används för
// att SÖKA och för att TVÄTTA, så att inget kan hittas utan att också bytas ut.
const REPLACEMENTS = [
  [/för dyrt/giu, "över referensintervallet"],
  [/överpris(satt|satt|er|et|at|ad|ade)?/giu, "pris över referensintervallet"],
  [/oseriös(t|a)?/giu, "otydlig"],
  [/fusk(et|ar|a|ande)?/giu, "avvikelse"],
  [/svart(a|jobb|arbete|arbeten|jobbet)?/giu, "ej redovisat"],
];
const FORBIDDEN_RE = new RegExp(`(${REPLACEMENTS.map(([re]) => re.source).join("|")})`, "giu");

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
