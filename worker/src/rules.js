// Prisregler för Granska min offert — deterministisk kod, inte LLM.
// Underlag: PRISUNDERLAG_GRANSKAMINOFFERT.md (Moneyman, 2026-09) lager 1 a–i,
// siffror och källor i reference.json. Inga egna siffror här.
//
// Inmatning: `x` = strukturerade fält som modellen extraherat (null = saknas,
// aldrig gissat). Utmatning: lista av kontroller med status
//   ok | fel | fraga | flagga | ej_bedombar
// och text på svenska med källa och datum där en regel bygger på en källa.

export const FORBIDDEN_WORDS = ["för dyrt", "överpris", "svart", "oseriöst", "oseriös", "fusk"];

import { vatFactor, resolveTotals, rowsSumStated, rowsSumIncl, totalCandidates, laborCandidates, VAT_RATE, discountInfo, discountPctCheck, totalBasis } from "./amounts.js";
import * as D from "./money.js";

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
  // GMO-RABATT: uträknade belopp i rabatttexter visas i hela kronor (jämförelserna är exakta, bara visningen avrundas).
  const fmtC = (v) => D.fmtKr(D.dec(Math.round(D.toNumber(v))));
  const Wk = (v) => D.dec(Math.round(D.toNumber(v)));
  // Avrundning halvt uppåt till hela ören (exakt, BigInt). Används bara för ROT-gränser som räknats på arbetskostnad minus rabatt,
  // där gränsen kan få bråkdelar av ett öre (17 990,625 kr); offerten kan då inte ange mer exakt än 17 990,63 kr.
  const roundOre = (v) => { if (v.e <= 2) return v; const k = 10n ** BigInt(v.e - 2); let q = v.n / k; const r = v.n % k; if (2n * (r < 0n ? -r : r) >= k) q += v.n < 0n ? -1n : 1n; return D.dec({ n: q, e: 2 }); };

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

  // --- a) ROT: HÖGST 30 % (50 % för betalning inom oldRateWindow) av arbetskostnaden inklusive moms ---
  // D19: kontrollen bedömer ÖVRE tillåtna beloppsgränser, inte likhet. Ett lägre belopp eller uttryckligt 0 är aldrig fel för att det
  // understiger maxgränsen. Antal personer begränsar totalen (rot_tak) men höjer aldrig procenttaket. Jämförelsen är ren matematik på
  // avlästa belopp: 0 tolerans, decimalsäker (money.js, D19_NUMERIK_PRECISION_V2). Det är inget besked om någons personliga rätt.
  // Betalningsdatum styr satsen och okänd moms/okänt datum ger villkorade gränser, aldrig ett tvärsäkert belopp eller ett grönt besked.
  // EN gemensam ROT-period för alla ROT-grenar (arbetsbelopp, värmepumpsschablon, materialinferens): ENDAST ett uttryckligt betalningsdatum avgör
  // satsen. Offertdatum är tidskontext, aldrig belägg för betalningsdatum (frysta ROTNUM-03: "Betalningsdatum styr; offertdatum/körklocka bevisar
  // inte betaldatum"): ett senare offertdatum utesluter varken en tidigare delbetalning eller att beloppen följer en annan datering. Utan
  // betalningsdatum är båda satserna möjliga (okänt datum) och inget avgörs i förväg – även när offertdatumet ligger efter 2025-fönstret.
  function rotPeriod() {
    const win = rot.oldRateWindow;
    if (x.plannedPaymentDate) {
      return { rates: [inRange(x.plannedPaymentDate, win.from, win.to) ? rot.oldRate : rot.rate], dateKnown: true, dateWhy: "betalning" };
    }
    return { rates: [rot.rate, rot.oldRate], dateKnown: false, dateWhy: x.quoteDate ? "offert" : "inget" };
  }
  const period = rotPeriod();
  const pcOf = (r) => `${Math.round(r * 100)} %`;
  const windowText = () => `${Math.round(rot.oldRate * 100)} % gällde bara för betalningar ${rot.oldRateWindow.from} – ${rot.oldRateWindow.to}`;
  const dateReason = () => (period.dateWhy === "offert"
    ? `Offerten anger bara offertdatum ${x.quoteDate} och inte när betalningen sker (${windowText()}). Ett offertdatum visar inte betalningsdatum.`
    : `Offerten anger varken betalningsdatum eller offertdatum, och ROT-satsen styrs av när betalningen sker (${windowText()}).`);

  function rotUpperBound(opt = {}) {
    const title = "ROT-belopp";
    const source = src(ref, "skatteverket_rot");
    const claim = D.dec(rotAmt);
    const laborD = opt.laborD || D.dec(labor);
    const ak = `arbetskostnaden${opt.note || ""}`; // GMO-RABATT: " efter rabatten" när rabatten sänker arbetskostnaden
    const { rates, dateKnown, dateWhy } = period;
    const vatCands = f !== null
      ? [{ factor: f, vatTxt: f === 1 ? "inklusive" : "exklusive" }]
      : [{ factor: 1, vatTxt: "inklusive" }, { factor: 1 + VAT_RATE, vatTxt: "exklusive" }];
    const cands = [];
    for (const v of vatCands) for (const r of rates) {
      const laborIncl = D.mul(laborD, D.dec(v.factor));
      const ceiling = D.mul(laborIncl, D.dec(r));
      cands.push({ ...v, rate: r, laborIncl, ceiling: opt.roundCeil ? roundOre(ceiling) : ceiling });
    }
    const top = D.max(cands.map((c) => c.ceiling)), bottom = D.min(cands.map((c) => c.ceiling));
    // GMO-RABATT (R3): på rabattvägen (opt.whole) visas belopp i hela kronor, utom när avdraget ligger inom 3 kr från gränsen – då i ören,
    // så att en skillnad som avgör aldrig visas som "0 kr" eller "1 kr". Utan opt: exakt som förut.
    const FX = !opt.whole ? D.fmtKr : D.lt(D.abs(D.sub(claim, top)), D.dec(3)) ? (v) => { const r = roundOre(v); return D.isZero(r) && !D.isZero(v) ? D.fmtKr(v) : D.fmtKr(r); } : fmtC;
    const FL = opt.whole ? FX : opt.laborD ? (v) => D.fmtKr(roundOre(v)) : D.fmtKr; // arbetskostnad efter rabatt: hela ören
    const pc = pcOf;
    const laborTxt = (c) => (c.factor === 1 ? `${FL(laborD)} inklusive moms` : `${FL(laborD)} exklusive moms (${FL(c.laborIncl)} inklusive moms)`);
    const vatKnownHere = vatCands.length === 1;
    const describeRate = (r) => `${pc(r)}: ${cands.filter((c) => c.rate === r).map((c) => `${FX(c.ceiling)}${vatKnownHere ? "" : ` om ${ak} ${FL(laborD)} är ${c.vatTxt} moms${c.factor !== 1 ? ` (${FL(c.laborIncl)} inklusive moms)` : ""}`}`).join(" eller ")}`;
    const describe = (c) => `${pc(c.rate)} av ${ak} ${FL(laborD)}${vatKnownHere ? "" : ` om den är ${c.vatTxt} moms`}${c.factor !== 1 ? ` (${FL(c.laborIncl)} inklusive moms)` : ""} = ${FX(c.ceiling)}`;
    const limitsTxt = () => (vatKnownHere ? cands.map(describe).join("; ") : [...new Set(cands.map((c) => c.rate))].map(describeRate).join("; "));
    const windowTxt = windowText();
    const disclaimer = "Det här är en kontroll av beräkningen på offertens siffror – inte av ditt personliga avdragsutrymme (tidigare ROT och RUT under året och skatteutrymme).";
    const claimTxt = FX(claim);
    const rateTxt = rotRate !== null ? ` (${pc(rotRate)})` : "";

    if (D.gt(claim, top)) {
      const excess = FX(D.sub(claim, top));
      const single = cands.length === 1 ? cands[0] : null;
      const implied = rotRate !== null ? rotRate : Number(D.toNumber(claim)) / Math.max(D.toNumber(single ? single.laborIncl : D.max(cands.map((c) => c.laborIncl))), 1);
      if (single && single.rate === rot.rate && Math.abs(implied - rot.oldRate) < 0.02 && x.plannedPaymentDate) {
        add("rot_belopp", "fel", "ROT-sats",
          `ROT-avdraget är räknat med ${Math.round(rot.oldRate * 100)} %. ${rot.quote} För betalning ${x.plannedPaymentDate.slice(0, 4)} är avdraget högst ${pc(rot.rate)}, alltså ${FX(single.ceiling)} i stället för ${claimTxt} (${excess} över).`, source);
      } else if (single) {
        add("rot_belopp", "fel", title,
          `ROT-avdraget är högst ${pc(single.rate)} av ${ak} ${laborTxt(single)}, alltså högst ${FX(single.ceiling)}. Offerten anger ${claimTxt}${rateTxt}, vilket är ${excess} över den gränsen. Avdraget får vara lägre än gränsen men inte högre.`, source);
      } else {
        add("rot_belopp", "fel", title,
          `ROT-avdraget ${claimTxt}${rateTxt} är högre än den högsta möjliga gränsen under varje tolkning av moms och betalningsdatum: ${limitsTxt()}. Det är ${excess} över den högsta gränsen. Avdraget får vara lägre än gränsen men inte högre.`, source);
      }
      return;
    }

    const certain = vatKnownHere && dateKnown;
    const maxRate = Math.max(...rates);
    if (certain) {
      const c = cands[0];
      if (rotRate !== null && D.gt(D.dec(rotRate), D.dec(maxRate))) {
        add("rot_belopp", "fraga", "ROT-sats",
          `Offerten anger ROT-sats ${pc(rotRate)}, men högsta sats för den betalning som offerten anger är ${pc(maxRate)}. Beloppet ${claimTxt} ryms under gränsen (${FX(c.ceiling)}), men den angivna satsen stämmer inte med regeln – fråga hur avdraget är räknat. ${disclaimer}`, source);
        return;
      }
      add("rot_belopp", "ok", title,
        `ROT-avdraget ${claimTxt} ligger inom gränsen: högst ${pc(c.rate)} av ${ak} ${laborTxt(c)}, alltså högst ${FX(c.ceiling)}.${c.rate === rot.oldRate ? ` ${windowTxt}, och betalningsdatumet i offerten ligger i det fönstret.` : ""} Ett lägre avdrag än gränsen är inte fel. ${disclaimer}`, source);
      return;
    }
    const reasons = [];
    if (!vatKnownHere) reasons.push("Offerten anger inte om arbetskostnaden är inklusive eller exklusive moms.");
    if (!dateKnown) reasons.push(dateReason());
    const fits = D.gt(claim, bottom) ? `Beloppet ${claimTxt} ryms under den högsta men inte under den lägsta gränsen.` : `Beloppet ${claimTxt} ligger under alla gränserna, men det räcker inte för att bekräfta det.`;
    const asks = [!vatKnownHere ? "momsangivelse" : null, !dateKnown ? "betalningsdatum" : null].filter(Boolean).join(" och ");
    add("rot_belopp", "fraga", title,
      `ROT-avdraget går inte att kontrollera mot högsta tillåtna belopp. ${reasons.join(" ")} Högsta möjliga avdrag, ${limitsTxt()}. ${fits} Fråga efter ${asks}. ${disclaimer}`, source);
  }

  // GMO-RABATT (R1/R2): ROT-avdraget räknas på arbetskostnaden efter rabatt, oavsett om rabatten står före eller efter ROT-raden.
  // En rabatt som kan röra arbetet (allt utom en rabatt bara på material) får därför aldrig lämna ROT-beloppet grönt på en gissning:
  //  - fastställd rabatt bara på arbetet (belopp i kr, steg, momsbas, underlag): exakt gräns på arbetet minus rabatten (kan bli fel);
  //  - annars: ok bara om avdraget ryms även när hela (den största tolkningen av) rabatten dras från arbetet; över gränsen utan rabatt
  //    är fel som förut; allt däremellan, och varje rabatt vars belopp inte går att räkna ut, är en fråga.
  function rotWithDiscount() {
    const disc = discountInfo(x);
    const touches = disc && disc.base !== "material" && f !== null;   // även ett belopp lika stort som ROT: oklart → aldrig grönt
    if (!touches) return rotUpperBound();
    const laborD0 = D.dec(labor), ZERO = D.dec(0);
    const toRows = D.dec(f === 1 ? 1 : 0.8);                       // inklusive moms → radernas momsbas (1 / 1,25 = 0,8 exakt)
    const cands = disc.rotEcho ? [] : [...disc.preRot, ...disc.afterRot];
    const dRows = cands.map((c) => D.mul(c.inclD, toRows));
    const clamp = (v) => (D.lt(v, ZERO) ? ZERO : v);
    const onlyLabor = disc.base === "arbete";
    if (onlyLabor && disc.rotResolved && dRows.length === 1) return rotUpperBound({ laborD: clamp(D.sub(laborD0, dRows[0])), note: " efter rabatten", roundCeil: true, whole: true });
    const claim = D.dec(rotAmt);
    const ceil = (lab, r) => roundOre(D.mul(D.mul(lab, D.dec(f)), D.dec(r)));
    const lowLabor = dRows.length ? clamp(D.sub(laborD0, D.max(dRows))) : null; // hela (största tolkningen av) rabatten dras från arbetet
    if (lowLabor && !D.gt(claim, D.min(period.rates.map((r) => ceil(lowLabor, r))))) {
      return rotUpperBound({ laborD: lowLabor, note: onlyLabor ? " efter rabatten" : " med hela rabatten avdragen,", roundCeil: true, whole: true });
    }
    const n0 = out.length;
    rotUpperBound({ whole: true });
    const res = out.length > n0 ? out[out.length - 1] : null;
    if (!res || res.status === "fel") return;
    const maxRate = Math.max(...period.rates);
    const pcm = `${Math.round(maxRate * 100)} %`;
    const c0 = cands.length === 1 ? cands[0] : null;
    // Rabatt efter ROT med totaler exklusive moms: momsbasen är en tolkning (totalernas), aldrig ett påstående.
    const amt = !c0 ? "" : c0.factor === 1 ? ` ${fmtC(c0.inclD)}${f !== 1 ? " inklusive moms" : ""}`
      : disc.afterRot.includes(c0) ? ` ${fmtC(c0.statedD)} (${fmtC(c0.inclD)} inklusive moms om beloppet, som totalerna, är exklusive moms)`
      : ` ${fmtC(c0.statedD)} exklusive moms (${fmtC(c0.inclD)} inklusive moms)`;
    const open = disc.missing.length ? ` (${disc.missing.join("; ")})` : "";
    let why;
    if (onlyLabor) {
      why = `Rabatten på arbetet${amt} sänker arbetskostnaden, men den går inte att fastställa helt${open}.${lowLabor ? ` Med hela rabatten avdragen från arbetet är gränsen ${fmtC(ceil(lowLabor, maxRate))} (${pcm}).` : ""}`;
    } else if (!lowLabor) {
      why = `Rabatten${disc.baseLabel ? ` på ${disc.baseLabel}` : ""}${disc.pct !== null ? ` på ${String(disc.pct).replace(".", ",")} %` : ""} kan också sänka arbetskostnaden, men rabattens belopp går inte att räkna ut${open}.`;
    } else {
      const l = num(x.laborSumSek), m = num(x.materialSumSek);
      const baseSum = disc.base === "material_och_arbete" ? (l || 0) + (m || 0) : [x.laborSumSek, x.materialSumSek, x.travelSumSek, x.otherSumSek].map(num).filter((v) => v !== null).reduce((a, b) => a + b, 0);
      const propCeil = baseSum > 0 ? (l - D.toNumber(D.max(dRows)) * l / baseSum) * f * maxRate : null;
      why = `Rabatten${disc.baseLabel ? ` på ${disc.baseLabel}` : ""}${amt} sänker också arbetskostnaden, och offerten visar inte hur den fördelas mellan arbete och annat. Med ${pcm} är gränsen ${fmtC(ceil(laborD0, maxRate))} utan rabatt på arbetet och ${fmtC(ceil(lowLabor, maxRate))} om hela rabatten dras från arbetet${propCeil === null ? "" : `; fördelas rabatten i proportion blir den ${kr(propCeil)}`}. Offerten anger ${fmtC(claim)}${propCeil === null ? "" : D.toNumber(claim) <= propCeil + 0.5 ? ", vilket ryms under den proportionella gränsen" : ", vilket är högre än den proportionella gränsen"}.`;
    }
    const ask = onlyLabor
      ? "Fråga vilken arbetskostnad avdraget är räknat på – ROT-avdraget räknas på arbetskostnaden efter rabatt."
      : "Fråga hur rabatten fördelas mellan arbete och material och vilken arbetskostnad avdraget är räknat på – ROT-avdraget räknas på arbetskostnaden efter rabatt.";
    if (res.status === "ok") {
      res.status = "fraga";
      res.text = `ROT-avdraget går inte att bekräfta mot gränsen på arbetskostnaden efter rabatt. ${why} ${ask} Det här är en kontroll av beräkningen på offertens siffror – inte av ditt personliga avdragsutrymme (tidigare ROT och RUT under året och skatteutrymme).`;
    } else {
      res.text = `${res.text} ${why} ${ask}`;
    }
  }

  if (rotAmt !== null) {
    if (rotAmt === 0) {
      add("rot_belopp", "ok", "ROT-avdrag", "Offerten yrkar inget ROT-avdrag (0 kr). Det är inte ett fel: ROT-avdraget är en möjlighet, ingen skyldighet att utnyttja högsta möjliga belopp.", src(ref, "skatteverket_rot"));
    } else if (isHeatPump) {
      heatPumpRule();
    } else if (labor !== null) {
      rotWithDiscount();
    } else if (x.priceType !== "fast") {
      add("rot_belopp", "ej_bedombar", "ROT-belopp", "Arbetskostnaden anges inte separat, så ROT-beloppet går inte att räkna efter.", src(ref, "skatteverket_rot"));
    }
  }
  if (rotAmt !== null && rotAmt > 0) {
    // b) ROT på material eller resor
    if (x.rotOnMaterialOrTravel === true) {
      add("rot_material", "fel", "ROT på material eller resor", "ROT-avdrag får bara göras på arbetskostnaden, inte på material, resor eller servicebil. Offerten räknar avdrag på annat än arbete.", src(ref, "skatteverket_rot"));
    } else if (labor !== null && material !== null && !isHeatPump && f !== null) {
      // Samma ROT-period som arbetsbeloppskontrollen. Ett belopp som ryms under den högsta möjliga arbetsgränsen kan vara ett legitimt LÄGRE
      // avdrag (ROT är en övre gräns, ingen likhet): likhet med en procentsats på hela summan räcker därför aldrig som belägg. "Fel" bara om
      // beloppet motsvarar avdrag på hela summan under någon tillåten sats OCH överstiger arbetsgränsen under varje tillåten sats (decimalsäkert,
      // 0 tolerans). Uttryckligt rotOnMaterialOrTravel === true hanteras ovan och oförändrat.
      const laborCeilingMax = D.max(period.rates.map((r) => D.mul(D.mul(D.dec(labor), D.dec(f)), D.dec(r))));
      const onAll = period.rates.some((r) => withinTol(rotAmt, (laborInclVat + material * f + (travel === null ? 0 : travel * f)) * r, rot.tolerance));
      const onLabor = !D.gt(D.dec(rotAmt), laborCeilingMax);
      // D19-R1-P2: en talrelation (2 % eller exakt) är inget belägg för vad avdraget faktiskt räknats på. Den ger aldrig ett säkert
      // rot_material-fel, bara en neutral underlagsfråga – och bara när det finns material eller resor som frågan kan gälla. Beloppsfelet
      // (rot_belopp) bedöms separat och exakt. Uttryckligt rotOnMaterialOrTravel === false övertrumfas inte; true hanteras ovan.
      const nonLabor = material + (travel === null ? 0 : travel);
      if (onAll && !onLabor && x.rotOnMaterialOrTravel !== false && nonLabor > 0) {
        add("rot_material", "fraga", "ROT-underlag",
          "ROT-beloppet är högre än gränsen på arbetskostnaden och ligger nära en procentsats av arbete och material tillsammans. Offerten visar inte vad avdraget har räknats på. Fråga hur ROT-underlaget och procentsatsen har räknats – material, resor och servicebil får inte ingå.",
          src(ref, "skatteverket_rot"));
      }
    }

    // d) Tak per person. Personantalet begränsar totalbeloppet; det höjer aldrig procenttaket på arbetskostnaden.
    // Decimalsäkert utan avrundning: 50 000,01 kr är över 50 000 kr och visas så (ingen ny avrundningstolerans).
    const rotD = D.dec(rotAmt), capD = D.dec(rot.maxPerPerson);
    if (D.gt(rotD, capD)) {
      let need = Math.max(1, Math.ceil(D.toNumber(rotD) / rot.maxPerPerson));
      while (D.lt(D.mul(D.dec(need), capD), rotD)) need += 1;
      while (need > 1 && !D.lt(D.mul(D.dec(need - 1), capD), rotD)) need -= 1;
      if (persons === null) {
        add("rot_tak", "fraga", "ROT-tak per person",
          `ROT-avdraget ${D.fmtKr(rotD)} är mer än ${D.fmtKr(capD)}, som är taket per person och år (${D.fmtKr(D.sub(rotD, capD))} över ett persontak). Det kräver minst ${need} personer med avdragsutrymme – offerten anger inte hur många som ska dela på avdraget.`,
          src(ref, "skatteverket_rot"));
      } else if (D.lt(D.mul(D.dec(persons), capD), rotD)) {
        const capAll = D.mul(D.dec(persons), capD);
        add("rot_tak", "fel", "ROT-tak per person", `${persons} ${persons === 1 ? "person" : "personer"} ger högst ${D.fmtKr(capAll)} i ROT-avdrag per år. Offerten räknar med ${D.fmtKr(rotD)}, vilket är ${D.fmtKr(D.sub(rotD, capAll))} över taket.`, src(ref, "skatteverket_rot"));
      } else {
        add("rot_tak", "flagga", "ROT-tak per person", `ROT-avdraget ${D.fmtKr(rotD)} fördelas på ${persons} personer. Taket är ${D.fmtKr(capD)} per person och år, och ROT och RUT tillsammans högst ${kr(rot.maxRotRut)} – tidigare avdrag under året minskar utrymmet. Gränserna är tak, ingen personlig tilldelning.`, src(ref, "skatteverket_rot"));
      }
    }

    // e) Undantag och arbetets sammanhang (D19). Bred ordträff får inte klassa reparation som nybyggnad; saknat sammanhang blir en
    // konkret fråga, aldrig en uppfunnen klassificering eller ett grönt rättighetsbesked.
    rotContextRule();
  }

  // --- Totalsummor som motsäger varandra ---
  {
    const t0 = resolveTotals(x);
    // GMO-RABATT (R2): en rabatt som inte är fastställd och som skulle kunna ligga mellan summan före ROT och summan att betala ger en
    // fråga – bara om den faktiskt kan förklara skillnaden (ett belopp som stämmer på kronan under någon momstolkning, eller en
    // procentsats som räcker till skillnaden). En fastställd rabatt, eller en som inte kan förklara skillnaden, ändrar inget: fel som förut.
    const disc0 = t0.conflict ? discountInfo(x) : null;
    const gap0 = t0.conflict ? D.sub(t0.expectedPayD, t0.toPayD) : null;
    const mayExplain = (() => {
      // Ett belopp lika stort som ROT (rotEcho) är ofastställt: är det ett felläst ROT-avdrag eller en rabatt förklarar det skillnaden lika.
      if (!disc0 || disc0.sumResolved || !D.gt(gap0, D.dec(0))) return false;
      if (disc0.amountSek !== null) return [D.dec(disc0.amountSek), ...[...disc0.preRot, ...disc0.afterRot].map((c) => c.inclD)].some((c) => !D.gt(D.abs(D.sub(gap0, c)), D.dec(1)));
      if (disc0.pct === null || disc0.stage === "fore_moms" || disc0.stage === "efter_moms") return false;
      const rowsI = rowsSumIncl(x);
      const top = Math.max(D.toNumber(t0.beforeD), rowsI === null ? 0 : rowsI);
      return D.toNumber(gap0) <= top * disc0.pct / 100 + 1;
    })();
    if (mayExplain) {
      const what = disc0.amountSek !== null ? `på ${fmtC(D.dec(disc0.amountSek))}` : `på ${String(disc0.pct).replace(".", ",")} %`;
      add("total_konflikt", "fraga", "Summa före ROT och summa att betala",
        `Offerten anger både summa före ROT-avdrag (${fmtC(t0.beforeD)}) och summa att betala (${fmtC(t0.toPayD)}). ${rotAmt ? `Efter ROT-avdraget ${fmtC(D.dec(rotAmt))} blir det ${D.fmtKr(D.sub(Wk(t0.beforeD), Wk(D.dec(rotAmt))))}` : `Utan ROT-avdrag är det ${fmtC(t0.beforeD)}`}, en skillnad på ${D.fmtKr(D.sub(D.sub(Wk(t0.beforeD), Wk(D.dec(rotAmt || 0))), Wk(t0.toPayD)))}. Offerten anger också en rabatt ${what} som inte går att fastställa helt (${disc0.missing.join("; ")}); dras den efter ROT-avdraget kan den förklara skillnaden. Fråga om rabatten dras efter ROT-avdraget och vilket belopp som gäller.`, "");
    } else if (t0.conflict) {
      add("total_konflikt", "fel", "Summa före ROT och summa att betala",
        `Offerten anger både summa före ROT-avdrag (${D.fmtKr(t0.beforeD)}) och summa att betala (${D.fmtKr(t0.toPayD)}). ${rotAmt ? `Efter ROT-avdraget ${D.fmtKr(D.dec(rotAmt))} borde summan att betala vara ${D.fmtKr(t0.expectedPayD)}` : `Utan ROT-avdrag borde summan att betala vara ${D.fmtKr(t0.expectedPayD)}`}. Uppgifterna stämmer inte med varandra – be om en rättad offert.`, "");
    }
  }

  // --- e) ROT: undantag och arbetets sammanhang ---
  // Källa: Skatteverket (reference.json exceptions). Nybyggnad av en helt ny bostad ger aldrig ROT, men reparation och underhåll av en
  // befintlig byggnad (även i ett nybyggt hus) kan göra det; särskilda regler finns för om- och tillbyggnad av bostad yngre än fem år.
  // Garage/förråd som hör till småhuset är inte generellt uteslutna, och bostadsrätt + fönster/tak räcker inte ensamt som beslut: det
  // beror på om arbetet gäller lägenhetens insida eller föreningens utsida/gemensamma delar. Därför ger sammanhang som saknas en FRÅGA.
  function rotContextRule() {
    const source = src(ref, "skatteverket_rot_undantag");
    const text = `${x.jobType || ""} ${x.workDescription || ""}`.toLowerCase();
    const exc = rot.exceptions || [];
    const byKeyword = (kw) => exc.find((e) => (e.keywords || []).includes(kw));
    const E_NEW = byKeyword("nybygg"), E_AGE = byKeyword("nyproducerad"), E_SMALL = byKeyword("friggebod"), E_BRF = byKeyword("trapphus");
    const nature = x.workNature || null, loc = x.workLocation || null;
    const repairish = ["reparation", "underhall", "ombyggnad", "tillbyggnad"].includes(nature);

    // 1) Övriga undantag på ordlista (pool, staket, skadedjur, energideklaration, gemensamma ytor) – oförändrat flaggade.
    const generic = exc.filter((e) => e !== E_NEW && e !== E_AGE && e !== E_SMALL);
    const hit = generic.find((e) => (e.keywords || []).some((k) => text.includes(k)));
    if (hit) {
      add("rot_undantag", "flagga", "ROT-berättigat arbete", `${hit.label} ger normalt inte rätt till ROT-avdrag enligt Skatteverkets lista. Offerten räknar med ROT – det behöver stämmas av.`, source);
      return;
    }

    const NEW_NOUN = /nybygg(?![dt])|nyproduktion|ny bostad|nytt hus|bygga hus/;   // nybyggnad som substantiv; "nybyggd/nybyggt" är en ålder, inte en arbetsart
    const SMALL_RE = /friggebod|attefallshus|komplementbyggnad/;
    const AGE_RE = /nyproducerad|yngre än (fem|5) år|nybygg[dt]/;
    const isNewWork = nature === "nybyggnad" || (!repairish && NEW_NOUN.test(text));
    const smallBuilding = SMALL_RE.test(text) || /garage|carport|förråd/.test(text);

    // 2) Nybyggnad (uttrycklig eller på ordträff utan motsägande sammanhang): fråga, aldrig en tyst klassificering.
    if (isNewWork || (!repairish && SMALL_RE.test(text))) {
      if (smallBuilding) {
        add("rot_undantag", "fraga", "ROT för nybyggd byggnad",
          `Arbetet beskrivs som nybyggnad av en byggnad på tomten (till exempel garage eller friggebod). ${E_SMALL && E_SMALL.quote ? E_SMALL.quote + " " : ""}Reparation eller underhåll av en befintlig byggnad är något annat än att bygga en ny. Offerten räknar med ROT-avdrag – fråga hur entreprenören bedömt att avdrag får göras för just det här arbetet. Beräkningen av beloppet är en sak, om arbetet ger rätt till avdrag en annan.`, source);
      } else {
        add("rot_undantag", "fraga", "ROT för nybyggnad",
          `Arbetet beskrivs som nybyggnad. ${E_NEW && E_NEW.quote ? E_NEW.quote + " " : ""}Reparation, underhåll, ombyggnad och tillbyggnad av en befintlig bostad kan däremot ge rätt till avdrag. Offerten räknar med ROT-avdrag – fråga vad arbetet avser och hur avdraget bedömts. Beräkningen av beloppet är en sak, om arbetet ger rätt till avdrag en annan.`, source);
      }
      return;
    }

    // 3) Ålder ("nybyggd villa") utan arbetsart som utesluter regeln: reparation och underhåll kan ge ROT oavsett husets ålder.
    if (AGE_RE.test(text) && nature !== "reparation" && nature !== "underhall") {
      add("rot_undantag", "fraga", "ROT i nybyggd bostad",
        `Beskrivningen nämner en nybyggd eller nyproducerad bostad. Skatteverket skiljer nybyggnad och färdigställande, som inte ger ROT, från reparation och underhåll, som kan ge avdrag oavsett husets ålder; särskilda begränsningar gäller för om- och tillbyggnad av bostad yngre än fem år. Offerten anger inte om arbetet är en reparation eller något annat – fråga vad arbetet avser (till exempel reparation av en skada) och bostadens ålder.`, source);
      return;
    }

    // 4) Bostadsrätt + arbete som kan gälla föreningens utsida: avgörs av insida/utsida och underhållsansvar, inte av jobbtypen.
    if (x.propertyType === "bostadsratt" && ["tak", "fasad", "fonster"].includes(x.jobType) && loc !== "invandigt") {
      add("rot_undantag", "fraga", "ROT i bostadsrätt",
        `${E_BRF && E_BRF.quote ? E_BRF.quote + " " : ""}Arbete inne i lägenheten som ingår i innehavarens underhållsansvar kan däremot ge rätt till avdrag. Offerten anger inte om arbetet gäller lägenhetens insida eller föreningens utsida och gemensamma delar, eller vem som ansvarar för underhållet – fråga det innan ni räknar med avdraget.`, source);
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
    const sharePct = Math.round(share * 100);
    const rates = period.rates;                       // samma ROT-period som övriga ROT-grenar (betalningsdatum styr 30 %/50 %)
    const ratePhrase = rates.length === 1 ? `avdraget är ${pcOf(rates[0])} av det` : `avdraget är ${rates.map(pcOf).join(" eller ")} av det beroende på betalningsdatum`;
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
    // Schablonen är en ÖVRE gräns som ROT-underlag: ett lägre avdrag än schablonen är inte fel (0 tolerans, decimalsäkert, ingen
    // avrundning av avlästa belopp). Per sats och per momsbas för schablonen: pris inklusive moms eller exklusive moms (1 / 1,25 = 0,8 exakt).
    const shareD = D.dec(String(share));
    const outcomesFor = (beforeD) => rates.map((r) => {
      const factor = D.mul(shareD, D.dec(String(r)));
      return { rate: r, inclD: D.mul(beforeD, factor), exklD: D.mul(D.mul(beforeD, D.dec("0.8")), factor) };
    });
    const outcomeTxt = (beforeD) => {
      const os = outcomesFor(beforeD);
      if (os.length === 1) return `${D.fmtKr(os[0].inclD)} om schablonen räknas på pris inklusive moms, ${D.fmtKr(os[0].exklD)} om den räknas exklusive moms`;
      return os.map((o) => `${pcOf(o.rate)}: ${D.fmtKr(o.inclD)} om schablonen räknas på pris inklusive moms, ${D.fmtKr(o.exklD)} om den räknas exklusive moms`).join("; ");
    };
    const sourceBasisTxt = "Skatteverkets sida anger inte vilken momsbas schablonen använder";
    const dateTxt = period.dateKnown ? "" : ` ${dateReason()}`;
    if (t.status === "oklar") {
      // Två osäkerheter hålls öppna samtidigt och ingen av dem försvinner bakom den andra: (1) vilken summa/momsbas offertens total har,
      // (2) vilken momsbas Skatteverkets schablon själv använder. Varje belopp gäller därför bara under en tolkning av båda leden.
      const alts = t.alternatives.map((a) => `om ${a.label} är det ${outcomeTxt(a.beforeRotInclD)}`).join("; ");
      add("rot_schablon", "fraga", title,
        `Schablonen räknas på totalpriset före ROT-avdrag (${sharePct} % av det räknas som arbete, och ${ratePhrase}). Offerten anger inte tydligt vilken summa som är före ROT-avdrag och vilket momsläge den har${t.conflict ? " (uppgifterna om summa före ROT och summa att betala stämmer inte med varandra)" : ""}. ${sourceBasisTxt}. Ingen enskild schablon går därför att utpeka, utan varje belopp gäller bara under en tolkning av båda leden: ${alts}. Offerten anger ${D.fmtKr(D.dec(rotAmt))}.${dateTxt} Be om summa före ROT-avdrag, summa att betala och momsläge${period.dateKnown ? "" : " samt betalningsdatum"}, och fråga hur avdraget är räknat.`, source);
      return;
    }
    // Belagd summa före ROT. Skatteverkets sida anger inte om totalpriset är inklusive eller exklusive moms (UNKNOWN), och fast pris +
    // småhus bevisar inte totalentreprenad. Regeln visar därför ett villkorat räkneexempel och en fråga, aldrig "regeln stämmer" – och
    // "fel" bara när alla villkor är uttryckligen angivna och ingen momsbas (eller tillåten sats) ger det angivna avdraget.
    const beforeD = t.beforeRotInclD;
    const claimD = D.dec(rotAmt);
    const outs = outcomesFor(beforeD);
    const allVals = outs.flatMap((o) => [o.inclD, o.exklD]);
    const matchIncl = outs.some((o) => D.eq(claimD, o.inclD)), matchExkl = outs.some((o) => D.eq(claimD, o.exklD));
    const overAll = D.gt(claimD, D.max(allVals));
    const missing = [];
    if (x.propertyType !== "smahus") {
      missing.push(x.propertyType ? "offerten gäller en annan bostadstyp än småhus, och schablonen kan inte användas för bostadsrätt" : "offerten anger inte bostadstyp (schablonen gäller småhus, inte bostadsrätt)");
    }
    if (x.totalContract !== "ja") {
      missing.push(x.totalContract === "nej" ? "offerten anger att arbetet inte är en totalentreprenad" : "offerten anger inte att företaget utför totalentreprenad (värmepump och installation i ett fast pris)");
    }
    const relation = matchIncl ? ", vilket stämmer med räkningen inklusive moms"
      : matchExkl ? ", vilket stämmer med räkningen exklusive moms"
      : overAll ? ", vilket är högre än alla räkningarna"
      : D.lt(claimD, D.min(allVals)) ? ", vilket ligger under alla räkningarna (ett lägre avdrag än schablonen är inte fel)"
      : ", vilket ryms under någon räkning men inte alla";
    const upTo = rates.length === 1 ? `avdraget är högst ${pcOf(rates[0])} av det` : `${ratePhrase}`;
    const example = `Av totalpriset ${D.fmtKr(beforeD)} före ROT (${t.basis === "exkl" ? "angivet exklusive moms, omräknat med 25 % moms" : "inklusive moms"}) räknas ${sharePct} % som arbete och ${upTo}: ${outcomeTxt(beforeD)}. Offerten anger ${D.fmtKr(claimD)}${relation}. ${sourceBasisTxt}, så beloppet går inte att bekräfta – fråga hur avdraget är räknat.${dateTxt}`;
    if (!missing.length && overAll) {
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
  summaRule();
  rabattRules();

  // GMO-RABATT (2026-10-23): rabattens procentsats mot beloppet, och rabatt som dras efter ROT-avdraget. Båda är frågor, aldrig fel:
  // procentens underlag kan vara ett annat än det avlästa, och hur avdraget fördelats mellan arbete och material syns inte i offerten.
  function rabattRules() {
    const disc = discountInfo(x);
    if (!disc) return;
    const pctTxt = disc.pct !== null ? `${String(disc.pct).replace(".", ",")} %` : "";
    if (disc.rotEcho) {
      add("rabatt", "fraga", "Rabatt",
        `Offerten anger en rabatt på ${fmtC(D.dec(disc.amountSek))}, ${rotAmt !== null && rotAmt > 0 ? "lika mycket som ROT-avdraget" : "exakt lika mycket som ett ROT-avdrag på arbetskostnaden skulle vara, men inget ROT-avdrag har lästs ut"}. Det kan vara ROT-avdraget som har lästs som en rabatt, så rabatten har inte räknats med i kontrollerna. Fråga om det finns en rabatt utöver ROT-avdraget.`, "");
      return;
    }
    if (disc.pctSuspicious) {
      add("rabatt", "fraga", "Rabatt",
        `Rabattens procentsats lästes som ${String(disc.pctRaw).replace(".", ",")} %, vilket ser ut som en andel snarare än en procentsats (${String(Math.round(disc.pctRaw * 10000) / 100).replace(".", ",")} %?). Den har inte använts i kontrollerna. Fråga vilken procentsats som gäller.`, "");
    }
    const pc = discountPctCheck(x);
    if (pc && !pc.ok) {
      const seen = new Set();
      const calcTxt = pc.calc.filter((c) => { const k = c.label + "|" + c.k; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 3)
        .map((c) => `${pctTxt} av ${c.label} (${fmtC(D.mul(c.valueD, D.dec(c.k)))}${c.k !== 1 ? " inklusive moms" : ""}) är ${fmtC(c.pctD)}`).join(", ");
      add("rabatt", "fraga", "Rabatt",
        `Offerten anger rabatten både som ${pctTxt} och som ${fmtC(pc.amountD)}, men de hänger inte ihop: ${calcTxt}. Fråga vilken rabatt som gäller – procentsatsen eller beloppet – och vad den räknas på.`, "");
    }
    const t = resolveTotals(x);
    if (rotAmt !== null && rotAmt > 0 && t.afterRotDiscountD && disc.base !== "material") {
      add("rabatt_rot", "fraga", "ROT och rabatt",
        `Rabatten ${fmtC(disc.amountSek !== null ? D.dec(disc.amountSek) : t.afterRotDiscountD)} dras av efter ROT-avdraget. ROT-avdraget räknas på den arbetskostnad som faktiskt betalas, så en rabatt som också sänker priset på arbetet kan minska avdraget. Fråga om ROT-avdraget är räknat på arbetskostnaden före eller efter rabatten.`,
        src(ref, "skatteverket_rot"));
    }
  }

  // Summering: raderna mot totalen. D19: null betyder okänt, inte 0 – full exakt summakontroll kräver att alla fyra kategorier
  // (arbete, material, resor, övrigt) är kända (uttryckligt 0 räknas som känd post) och att totalens bas är belagd. Är en kategori okänd
  // visas en delsumma med tydlig täckning och summan blir ej fullt bedömd; överstiger delsumman redan totalen visas en konkret
  // differensfråga (okänd rabatt, kredit eller justering kan förklara den), aldrig ett säkert räknefel eller en påhittad rättad total.
  // GMO-RABATT (2026-10-23): en avläst rabatt (discountSek/discountPct, amounts.js discountInfo) dras från raderna före jämförelsen.
  // Okänd momsbas för rabatten ger flera tolkningar; "fel" bara när rabattbeloppet står i kr och ingen tolkning stämmer. Raderna utan
  // rabatt = totalen ger en fråga (rabatten syns inte i totalen eller ingår redan i raderna), aldrig ok eller fel.
  function summaRule() {
    const cats = [["arbete", x.laborSumSek], ["material", x.materialSumSek], ["resor", x.travelSumSek], ["övrigt", x.otherSumSek]]
      .map(([label, v]) => ({ label, v: num(v) }));
    const known = cats.filter((c) => c.v !== null), unknown = cats.filter((c) => c.v === null);
    if (!known.length) return;                       // ingen uppdelning alls: redovisas av "uppdelning"
    const t = resolveTotals(x);
    if (t.status === "saknas") return;
    if (t.conflict) return;                          // redovisas av total_konflikt
    const ONE = D.dec(1);
    const disc = discountInfo(x);
    const K = disc ? fmtC : D.fmtKr;                    // utan rabatt: exakt samma visning som förut
    const stated = D.sum(known.map((c) => D.dec(c.v)));
    const fD = f === null ? null : D.dec(f);
    const statedIncl = fD ? D.mul(stated, fD) : null;
    const rowsTxt = known.map((c) => `${c.label} ${K(D.dec(c.v))}`).join(" + ");
    const hasRot = rotAmt !== null && rotAmt > 0;
    const rotD = D.dec(hasRot ? rotAmt : 0);
    // Exakta decimaltal rakt från avlästa fält (amounts.js): ingen toFixed/float-avrundning före jämförelsen.
    const alts = t.status === "belagd"
      ? [{ label: "", incl: t.beforeRotInclD }]
      : t.alternatives.map((a) => ({ label: a.label, incl: a.beforeRotInclD }));
    const near = (a, b) => !D.gt(D.abs(D.sub(a, b)), ONE); // 1 kr: öresavrundning av momsrader, inga procenttoleranser
    const unknownTxt = unknown.map((c) => c.label).join(" och ");
    const vatNote = f === null ? " Radernas momsläge anges inte." : "";
    const inclWord = f !== 1 ? " inklusive moms" : "";

    // --- Rabatt ---
    const ar = t.afterRotDiscountD || null;           // rabatt efter ROT som totalerna redan stämts av mot
    const pre = disc && !ar ? disc.preRot : [];        // samma rabatt dras aldrig två gånger
    const arD = ar || D.dec(0);
    const pctTxt = disc && disc.pct !== null ? `${String(disc.pct).replace(".", ",")} %` : "";
    const inclTxt = (c) => `${K(c.inclD)}${f !== 1 && f !== null ? " inklusive moms" : ""}`;
    const amtParen = (c) => (c.factor === 1 ? inclTxt(c) : `${K(c.statedD)} exklusive moms, ${K(c.inclD)} inklusive moms`);
    const amtTxt = (c) => (c.factor === 1 ? inclTxt(c) : `${K(c.statedD)} exklusive moms (${K(c.inclD)} inklusive moms)`);
    const onTxt = disc && disc.baseLabel ? ` på ${disc.baseLabel}` : "";
    // "rabatten 10 % på materialet (3 000 kr exklusive moms, 3 750 kr inklusive moms)", "rabatten 5 000 kr", "rabatten 10 % av arbetet (…)"
    const discLabel = (c) => (c.fromPct ? (disc.base ? `rabatten ${pctTxt} av ${c.baseLabel} (${amtParen(c)})` : `rabatten ${pctTxt} (om den gäller hela beloppet: ${amtParen(c)})`)
      : pctTxt ? `rabatten ${pctTxt}${onTxt} (${amtParen(c)})` : `rabatten${onTxt} ${amtTxt(c)}`);
    // GMO-RABATT (R2): en rabatt som inte är fastställd för summeringen (belopp i kr, en momstolkning, känt steg) ger aldrig fel –
    // bara en fråga med det som saknas. Utan rabatt: exakt som förut.
    const sumOpen = !!disc && !disc.sumResolved;
    const capTxt = sumOpen ? ` Rabatten går inte att fastställa helt (${disc.missing.join("; ")}), så det här är en fråga och inget säkert fel. Fråga hur rabatten är räknad och vilket belopp som gäller.` : "";
    // R3: ett belopp som kan vara ett felläst ROT-avdrag har inte dragits av – summeringen kan då aldrig vara ok.
    const echoTxt = disc && disc.rotEcho ? ` Offerten anger också en rabatt på ${fmtC(D.dec(disc.amountSek))} som inte har räknats med här, eftersom ${disc.missing.find((m) => /ROT/.test(m))}. Fråga om det är en rabatt utöver ROT-avdraget och om den är avdragen.` : "";
    const onlyUnmarked = num(x.totalBeforeRotSek) === null && num(x.amountToPaySek) === null && num(x.totalSumSek) !== null;
    const twinTxt = disc && disc.rotTwin && onlyUnmarked ? " Rabatten är lika stor som ROT-avdraget, och offerten märker inte sin total, så det går inte att avgöra om totalen är summan före ROT-avdrag efter rabatten eller summan att betala efter ROT-avdraget. Fråga vilken summa totalen är." : "";
    const addSumma = (status, text) => {
      if (sumOpen && status === "fel") { add("summa", "fraga", "Summering", text + capTxt, ""); return; }
      if (echoTxt && status === "ok") { add("summa", "fraga", "Summering", text + echoTxt, ""); return; }
      if (twinTxt && status === "ok") { add("summa", "fraga", "Summering", text + twinTxt, ""); return; }
      add("summa", status, "Summering", text, "");
    };
    // En summa före ROT som offerten inte själv anger (räknad ur summa att betala och ROT-avdrag) beskrivs aldrig som angiven.
    const tbK = vatFactor(totalBasis(x));
    const beforeStated = (v) => tbK !== null && [x.totalBeforeRotSek, x.totalSumSek, hasRot || ar ? null : x.amountToPaySek].map(num).some((s0) => s0 !== null && near(D.mul(D.dec(s0), D.dec(tbK)), v));
    const totalIs = (v, shown = K(v)) => (disc && !beforeStated(v) ? `summan före ROT-avdrag, räknad ur offertens övriga belopp, är ${shown}` : `totalen anges till ${shown} före ROT-avdrag`);
    // R3: visade belopp räknas ur avrundade delar så att det som visas går ihop; är skillnaden under 3 kr visas den i ören.
    const W = (v) => D.dec(Math.round(D.toNumber(v)));
    const FO = (v) => D.fmtKr(roundOre(v));
    const fineD = (a, b) => D.lt(D.abs(D.sub(a, b)), D.dec(3));
    // Vilken av offertens summor ett belopp är: den angivna totalen, den angivna summan att betala (utan ROT) eller en uträknad summa.
    const payIsTotal = (v) => tbK !== null && num(x.totalBeforeRotSek) === null && num(x.totalSumSek) === null && !hasRot && !ar && num(x.amountToPaySek) !== null && near(D.mul(D.dec(x.amountToPaySek), D.dec(tbK)), v);
    const totalRef = (v) => (payIsTotal(v) ? "summan att betala" : beforeStated(v) ? "totalen" : "summan före ROT-avdrag som följer av offertens summa att betala");
    // R3 P1: med rabatt måste en uttryckligen angiven summa att betala stämma på kronan för att summeringen ska vara ok.
    const payCheck = (net) => {
      const p0 = num(x.amountToPaySek);
      if (!disc || p0 === null || tbK === null) return null;
      const exp = D.sub(D.sub(net, rotD), arD), pD = D.mul(D.dec(p0), D.dec(tbK));
      return near(pD, exp) ? null : { exp, pD };
    };
    const payMismatchTxt = (pc) => {
      const fine = fineD(pc.exp, pc.pD), F = fine ? FO : K;
      const diff = fine ? FO(D.abs(D.sub(pc.exp, pc.pD))) : D.fmtKr(D.abs(D.sub(W(pc.exp), W(pc.pD))));
      return ` ${hasRot || ar ? `Efter ${[hasRot ? `ROT-avdrag ${K(rotD)}` : "", ar ? `rabatten ${K(ar)}` : ""].filter(Boolean).join(" och ")} borde` : "Då borde"} summan att betala vara ${F(pc.exp)}, men offerten anger ${F(pc.pD)} – en skillnad på ${diff}. Summeringen kan därför inte bekräftas. Fråga vilken summa att betala som gäller.`;
    };
    const andDisc = disc && disc.amountSek !== null ? " och rabatten" : "";
    const rotTail = (net) => { const n = W(net), r = W(rotD), a = W(arD);
      return ar ? `Efter ROT-avdrag ${D.fmtKr(r)} och rabatten ${D.fmtKr(a)} blir det ${D.fmtKr(D.sub(D.sub(n, r), a))} att betala` : `efter ROT-avdrag ${D.fmtKr(r)} blir det ${D.fmtKr(D.sub(n, r))} att betala`; };
    // Summan att betala bekräftas bara när den är härledd ur offertens uppgifter (rader eller uttrycklig summa att betala), eller när en
    // rabatt efter ROT har stämts av mot den.
    // Med rabatt bekräftas summan att betala bara när offerten själv anger den (som summa att betala eller som omärkt total).
    const payStated = () => tbK !== null && !!t.toPayInclD && [x.amountToPaySek, x.totalSumSek].map(num).some((v) => v !== null && near(D.mul(D.dec(v), D.dec(tbK)), t.toPayInclD));
    const toPayOk = (net) => hasRot && !!t.toPayInclD && (t.source === "rader" || t.source === "explicit_att_betala" || (!!ar && num(x.amountToPaySek) !== null)) && near(D.sub(D.sub(net, rotD), arD), t.toPayInclD) && (!disc || payStated());

    if (!unknown.length) {
      // Alla fyra kategorier kända.
      const rowCands = statedIncl ? [statedIncl] : [stated, D.mul(stated, D.dec(1 + VAT_RATE))];
      if (pre.length) {
        const combos = rowCands.flatMap((r) => pre.map((c) => ({ r, c, net: D.sub(r, c.inclD) })));
        const anyPct = pre.some((c) => c.fromPct);
        if (t.status === "belagd" && statedIncl) {
          const total = alts[0].incl;
          const hit = combos.find((k) => near(k.net, total));
          if (hit && pre.length > 1) {
            // Rabattens momsbas framgår inte och bara en tolkning stämmer: aldrig ok på en tolkning som råkar passa.
            addSumma("fraga",
              `Raderna (${rowsTxt}) summerar till ${K(statedIncl)}${inclWord}. Offerten anger inte om rabatten ${K(pre[0].statedD)} är inklusive eller exklusive moms: ${pre.map((c) => `är den ${c.factor === 1 ? "inklusive" : "exklusive"} moms blir det ${K(D.sub(statedIncl, c.inclD))}`).join(", ")}. Totalen ${K(total)} stämmer bara med en av tolkningarna, så summeringen kan inte bekräftas. Fråga om rabatten är inklusive eller exklusive moms.`);
          } else if (hit && hit.c.fromPct && !disc.base) {
            // Procentsats utan angivet underlag: att "hela beloppet" stämmer är en tolkning, inte en uppgift i offerten.
            addSumma("fraga",
              `Raderna (${rowsTxt}) summerar till ${K(statedIncl)}${inclWord}. Räknas rabatten ${pctTxt} på hela beloppet (${amtParen(hit.c)}) blir det ${K(hit.net)}, vilket stämmer med totalen, men offerten anger inte vad rabatten gäller. Fråga vad rabatten räknas på.`);
          } else if (hit) {
            const Nd = D.sub(W(statedIncl), W(hit.c.inclD));   // visas ur avrundade delar
            const pc = payCheck(hit.net);
            if (t.grossBeforeD && !pc) {
              addSumma("ok",
                `Raderna (${rowsTxt}) summerar till ${K(statedIncl)}${inclWord}, samma som offertens summa före rabatten. Efter ${discLabel(hit.c)} blir det ${D.fmtKr(Nd)}${hasRot ? `, och ${rotTail(Nd)}` : ", vilket är summan att betala"} – det stämmer.`);
            } else if (pc) {
              addSumma("fraga",
                `Raderna (${rowsTxt}) summerar till ${K(statedIncl)}${inclWord}. Efter ${discLabel(hit.c)} blir det ${D.fmtKr(Nd)}, vilket stämmer med ${totalRef(total)}.${payMismatchTxt(pc)}`);
            } else {
              addSumma("ok",
                `Raderna (${rowsTxt}) summerar till ${K(statedIncl)}${inclWord}. Efter ${discLabel(hit.c)} blir det ${D.fmtKr(Nd)}, vilket stämmer med ${totalRef(total)}${toPayOk(hit.net) ? `, och ${rotTail(Nd)} – det stämmer` : ""}.`);
            }
          } else if (near(statedIncl, total)) {
            addSumma("fraga",
              `Raderna (${rowsTxt}) summerar till totalen ${K(total)}${inclWord} utan att ${pre.length === 1 ? discLabel(pre[0]) : "rabatten"} dras av. Antingen syns rabatten inte i totalen, eller så ingår den redan i radbeloppen. Fråga om rabatten är avdragen och vilket belopp som gäller.`);
          } else if (pre.length === 1) {
            const c = pre[0], net = D.sub(statedIncl, c.inclD);
            const fine = fineD(net, total);
            const Nd = fine ? net : D.sub(W(statedIncl), W(c.inclD)), Td = fine ? total : W(total);
            const F = fine ? FO : D.fmtKr;
            addSumma("fel",
              `Raderna (${rowsTxt}) summerar till ${F(fine ? statedIncl : W(statedIncl))}${inclWord}, och efter ${discLabel(c)} blir det ${F(Nd)}${hasRot ? ` (${F(fine ? D.sub(D.sub(net, rotD), arD) : D.sub(D.sub(Nd, W(rotD)), W(arD)))} efter ROT)` : ""}, men ${totalIs(total, F(Td))} – en skillnad på ${F(D.abs(D.sub(Nd, Td)))}. Alla fyra posterna (arbete, material, resor och övrigt)${andDisc} anges i offerten.`);
          } else {
            addSumma("fel",
              `Raderna (${rowsTxt}) summerar till ${K(statedIncl)}${inclWord}. Efter rabatten blir det ${pre.map((c) => `${K(D.sub(statedIncl, c.inclD))} om rabatten ${K(c.statedD)} är ${c.factor === 1 ? "inklusive" : "exklusive"} moms`).join(" eller ")}, men ${totalIs(total)}, vilket inte stämmer under någon av tolkningarna. Alla fyra posterna (arbete, material, resor och övrigt)${andDisc} anges i offerten.`);
          }
          return;
        }
        const matched = alts.filter((a) => combos.some((k) => near(k.net, a.incl)));
        const grossMatched = alts.filter((a) => rowCands.some((r) => near(r, a.incl)));
        if (!matched.length && !grossMatched.length) {
          addSumma("fel",
            `Raderna (${rowsTxt}) summerar till ${K(rowCands[0])}${rowCands.length > 1 ? ` (${K(rowCands[1])} om raderna är exklusive moms)` : ""}. Med rabatten avdragen stämmer det inte med totalen under någon tolkning av om den är före eller efter ROT-avdrag, vilket momsläge den har eller vilken momsbas rabatten har.${anyPct ? ` Offerten anger rabatten bara i procent (${pctTxt})${disc.base ? "" : ", här räknad som om den gäller hela beloppet"}.` : ""}`);
          return;
        }
        const m = matched.length ? matched : grossMatched;
        add("summa", "fraga", "Summering",
          `Raderna (${rowsTxt}) stämmer med totalen ${matched.length ? "när rabatten dras av" : "utan att rabatten dras av"}, ${m.map((a) => a.label ? `om ${a.label}` : `${K(a.incl)}`).join(" respektive ")}. Offerten anger inte tydligt ${f === null ? "radernas momsläge" : "vilken summa som är före ROT-avdrag och vilket momsläge den har"}, så summeringen kan inte bekräftas – be om ${f === null ? "momsangivelse för raderna" : "summa före ROT-avdrag, summa att betala och momsläge"}, och fråga om rabatten är avdragen.`, "");
        return;
      }
      const matched = alts.filter((a) => rowCands.some((r) => near(r, a.incl)));
      if (t.status === "belagd" && statedIncl) {
        const total = alts[0].incl;
        if (near(statedIncl, total)) {
          const afterOk = toPayOk(statedIncl);
          const pc = payCheck(statedIncl);
          // Med rabatt: en uträknad summa före ROT kallas aldrig "totalen" (utan rabatt: exakt som förut).
          const sumTo = disc && payIsTotal(total) ? `summerar till summan att betala ${K(total)}${inclWord}`
            : disc && !beforeStated(total) ? `summerar till ${K(total)}${inclWord}, vilket är summan före ROT-avdrag som följer av offertens summa att betala` : `summerar till totalen ${K(total)}${inclWord}`;
          if (pc) {
            addSumma("fraga", `Raderna (${rowsTxt}) ${sumTo}.${payMismatchTxt(pc)}`);
          } else if (ar && !hasRot) {
            // Rabatt efter (ett ROT som inte finns): raderna, rabatten och summan att betala/totalen redovisas ur avrundade delar.
            addSumma("ok", `Raderna (${rowsTxt}) summerar till ${K(statedIncl)}${inclWord}${beforeStated(total) ? ", samma som totalen före rabatten" : ""}. Efter rabatten ${K(ar)} blir det ${D.fmtKr(D.sub(W(statedIncl), W(ar)))}, vilket stämmer med ${num(x.amountToPaySek) !== null ? "summan att betala" : "offertens total"}.`);
          } else addSumma("ok",
            afterOk
              ? (ar
                ? `Raderna (${rowsTxt}) ${disc && !beforeStated(total) ? sumTo : `summerar till totalen ${K(total)}${inclWord} före ROT-avdrag`}. ${rotTail(statedIncl)} – det stämmer.`
                : `Raderna summerar till ${K(statedIncl)}, och efter ROT-avdrag ${K(D.dec(rotAmt))} blir det ${K(t.toPayInclD)} att betala – det stämmer.`)
              : `Raderna (${rowsTxt}) ${sumTo}.`);
        } else {
          // Med rabatt visas beloppen ur avrundade delar (ören när skillnaden är under 3 kr); utan rabatt exakt som förut.
          const fine = !disc || fineD(statedIncl, total), F = !disc ? K : fine ? FO : D.fmtKr;
          const Ad = fine ? statedIncl : W(statedIncl), Td = fine ? total : W(total);
          addSumma("fel",
            `Raderna (${rowsTxt}) summerar till ${F(Ad)}${inclWord}${hasRot ? ` (${F(fine ? D.sub(statedIncl, D.dec(rotAmt)) : D.sub(Ad, W(D.dec(rotAmt))))} efter ROT)` : ""}, men ${totalIs(total, F(Td))} – en skillnad på ${F(D.abs(D.sub(Ad, Td)))}. Alla fyra posterna (arbete, material, resor och övrigt) anges i offerten.`);
        }
        return;
      }
      if (!matched.length) {
        addSumma("fel",
          `Raderna (${rowsTxt}) summerar till ${K(rowCands[0])}${rowCands.length > 1 ? ` (${K(rowCands[1])} om raderna är exklusive moms)` : ""}, vilket inte stämmer med totalen under någon tolkning av om den är före eller efter ROT-avdrag eller vilket momsläge den har.`);
      } else {
        const rowTxt2 = f === null
          ? `summerar till ${rowCands.map((r) => K(r)).join(" om raderna är inklusive moms och ")} om de är exklusive moms (25 % moms)`
          : `stämmer med totalen om ${matched.map((m) => m.label || "momsläget är det som antagits").join(" respektive om ")}`;
        add("summa", "fraga", "Summering",
          `Raderna (${rowsTxt}) ${rowTxt2}. Offerten anger inte tydligt ${f === null ? "radernas momsläge" : "vilket"}${t.status === "belagd" ? ` och totalen före ROT-avdrag är ${K(alts[0].incl)}` : ""}, så summeringen kan inte bekräftas – be om ${f === null ? "momsangivelse för raderna" : "summa före ROT-avdrag, summa att betala och momsläge"}.`, "");
      }
      return;
    }

    // Minst en kategori är okänd: full summering går inte att göra.
    // GMO-RABATT: delsumman jämförs efter den största tolkningen av rabatten (den mest återhållsamma differensen).
    const discMax = pre.length ? D.max(pre.map((c) => c.inclD)) : null;
    const lowerBound = discMax ? D.sub(statedIncl || stated, discMax) : (statedIncl || stated); // med okänd radmoms är "inklusive"-delsumman minst den angivna
    const discPart = discMax ? `; efter ${pre.length === 1 ? discLabel(pre[0]) : `rabatten (högst ${K(discMax)} inklusive moms)`} blir det ${D.fmtKr(D.sub(W(statedIncl || stated), W(discMax)))}` : "";
    const totalTop = D.max(alts.map((a) => a.incl));
    const totalsTxt = alts.length === 1 ? K(alts[0].incl) : alts.map((a) => K(a.incl)).join(" eller ");
    if (D.gt(D.sub(lowerBound, totalTop), ONE)) {
      const excess = D.sub(lowerBound, totalTop);
      add("summa", "fraga", "Summering",
        `De poster som anges (${rowsTxt}) summerar till ${K(stated)}${statedIncl && f !== 1 ? ` (${K(statedIncl)} inklusive moms)` : ""}${discPart}, vilket är minst ${K(excess)} mer än totalen ${totalsTxt} före ROT-avdrag. ${unknownTxt[0].toUpperCase()}${unknownTxt.slice(1)} anges inte, så en full summering går inte att göra, och skillnaden kan bero på något som inte avlästs – till exempel ${discMax ? "ytterligare en rabatt" : disc ? "en kredit eller justering, eller rabatten som anges men inte går att räkna med här" : "en rabatt"}${disc && !discMax ? "" : ", kredit eller justering"} – eller på en felläst rad.${vatNote} Fråga hur totalen är uppbyggd och vad skillnaden på minst ${K(excess)} beror på.`, "");
      return;
    }
    // En differens används bara som förklaring när radernas och totalens momsbas är jämförbara (belagd radmoms). Med okänd radmoms
    // finns ingen säker differens: raderna och totalen redovisas var för sig med sin momsbas och momsfrågan, utan påstående om
    // saknade poster (rad-råsumman kan redan vara exklusive moms och därmed motsvara totalen inklusive moms).
    const comparable = f !== null;
    const rel = !comparable
      ? ""
      : near(lowerBound, totalTop) && alts.length === 1
      ? " Det är lika med totalen, men det visar inte att inga andra poster finns."
      : alts.length === 1 && D.lt(lowerBound, totalTop)
      ? ` Totalen är ${K(D.sub(totalTop, lowerBound))} högre, vilket kan vara de poster som inte anges.`
      : "";
    const neutral = comparable ? "" : ` Radernas momsläge anges inte, så raderna och totalen går inte att jämföra: är raderna inklusive moms är de ${K(stated)}, är de exklusive moms motsvarar de ${K(D.mul(stated, D.dec(1 + VAT_RATE)))} inklusive moms (25 % moms). Någon säker skillnad mellan raderna och totalen går därför inte att räkna ut, och det går inte heller att säga att poster saknas. Fråga om radernas momsläge.`;
    const totBasis = comparable || t.status !== "belagd" ? "" : ` (${t.basis === "exkl" ? "angiven exklusive moms, omräknad med 25 % moms" : "inklusive moms"})`;
    add("summa", "ej_bedombar", "Summering",
      `Summan går inte att kontrollera fullt ut: ${unknownTxt} anges inte i offerten (en saknad uppgift räknas inte som 0 kr). De poster som anges (${rowsTxt}) summerar till ${K(stated)}${statedIncl && f !== 1 ? ` (${K(statedIncl)} inklusive moms)` : ""}${discPart}, och totalen före ROT-avdrag är ${totalsTxt}${totBasis}.${rel}${comparable ? vatNote : neutral} Be om en uppdelning som visar alla fyra posterna – arbete, material, resor och övrigt – så går summan att kontrollera.`, "");
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

  // --- Betalning före utfört arbete (D19) ---
  // Bara när offerten UTTRYCKLIGEN kräver det (advancePayment === true). false/null ger ingen regel; en saknad uppgift är aldrig false.
  // Konsumentverket rekommenderar att inte betala i förskott; konsumenttjänstlagen (1985:716) §§ 41 och 45: huvudregeln är betalning
  // efter utfört arbete om inget annat avtalats, och § 52 ger småhusentreprenad särskilt skydd mot betalning för ännu inte utfört arbete.
  // Regeln gissar aldrig att ett uppdrag är småhusentreprenad och stämplar inget som olagligt.
  if (x.advancePayment === true) {
    add("forskott", "fraga", "Betalning före utfört arbete",
      "Offerten kräver betalning innan arbetet är utfört. Konsumentverket rekommenderar att inte betala i förskott och att avtala tydligt om betalningen. Enligt konsumenttjänstlagen är huvudregeln att betala efter utfört arbete om inget annat avtalats (§§ 41 och 45), och vid småhusentreprenad (§ 52) finns ett särskilt skydd mot att behöva betala för arbete som ännu inte är utfört. Offerten säger inte vilken typ av uppdrag det är, och det bedömer vi inte här. Fråga hur stor del av priset som ska betalas i förskott, vad som ska vara utfört före varje betalning och vilket skydd du har om arbetet inte blir av.",
      "");
  }

  if (!payDate && rotAmt !== null) {
    add("betaldatum", "ej_bedombar", "Betalningsdatum", "Varken offertdatum eller planerad betalning anges. ROT-satsen styrs av när betalningen sker, så ROT-beloppet går inte att kontrollera mot ett säkert högsta belopp förrän betalningsdatum framgår.", src(ref, "skatteverket_rot"));
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
