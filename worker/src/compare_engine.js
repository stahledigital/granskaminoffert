// Deterministisk jämförelse av 2–4 avlästa offerter. Ingen modell, inget nätverk, inga slumptal.
//
// Principer (spec D04):
//  - Avsaknad av text betyder "framgår inte", aldrig "ingår inte". Bara ett UTTRYCKLIGT besked med
//    dokumentreferens räknas som ingår/ingår inte (nedgraderas redan i sanitizeOffer).
//  - Belopp jämförs bara på samma moms- och ROT-bas. Momsbasen gissas aldrig.
//  - Ingen "billigast"/rangordning när omfattning, pristyp, momsbas eller projekt inte är jämförbara.
//  - Ingen bedömning av hantverkare, företag eller kvalitet. Inga ryktespoäng.
//  - All synlig text är fast text härifrån (plus användarens egen etikett och dokumenthänvisningar
//    som alltid visas som ren text).

import { SCOPE_CATALOG } from "./compare_extract.js";
import { cleanText } from "./compare_util.js";

const AREA_ROUNDING = 1.02;
const VAT = 1.25; // kalkylantagande vid omräkning mellan inkl och exkl moms; visas i rapporten
const CORE = ["rivning", "bortforsling", "material", "arbete", "resor"];
const JOB_LABEL = {
  badrum: "badrum", altan: "altan", fonster: "fönster", tak: "tak", malning: "målning", fasad: "fasad", kakel: "kakel",
  bergvarme: "bergvärme", luftvarmepump: "luftvärmepump", elcentral: "elcentral", kok: "kök", annat: "annat arbete",
};
const PRICE_TYPE_LABEL = { fast: "Fast pris", ungefarligt: "Uppskattat pris", lopande: "Löpande räkning" };
const PROP_LABEL = { smahus: "småhus", bostadsratt: "bostadsrätt", flerbostadshus: "flerbostadshus", annat: "annan bostadstyp" };
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round = (v) => Math.round(v);

export function offerLabels(rawLabels, n) {
  const used = new Set();
  const out = [];
  for (let i = 0; i < n; i++) {
    let l = cleanText(rawLabels && rawLabels[i], 40) || `Offert ${i + 1}`;
    if (used.has(l.toLowerCase())) l = `${l} (${i + 1})`;
    used.add(l.toLowerCase());
    out.push(l);
  }
  return out;
}

// Ett belopp med enhet och momsstatus. Saknad uppgift är null, aldrig 0.
const money = (value, vat = null) => (num(value) === null ? null : { value, unit: "kr", vat });

function priceOf(x) {
  const basis = x.totalVatBasis === "inkl" || x.totalVatBasis === "exkl" ? x.totalVatBasis : null;
  const before = num(x.totalBeforeRotSek);
  const unmarked = num(x.totalSumSek);
  const toPay = num(x.amountToPaySek);
  const rot = num(x.rotAmountSek);
  const parts = [x.laborSumSek, x.materialSumSek, x.travelSumSek, x.otherSumSek].map(num);
  const known = parts.filter((p) => p !== null);
  const partsSum = known.length >= 2 ? known.reduce((a, b) => a + b, 0) : null;
  // Normaliserad total före ROT på båda momsbaserna, bara när basen uttryckligen är känd.
  let incVat = null, exVat = null;
  if (before !== null && basis) {
    incVat = basis === "inkl" ? before : round(before * VAT);
    exVat = basis === "exkl" ? before : round(before / VAT);
  }
  return {
    priceType: x.priceType || null,
    vatBasis: basis,
    totalBeforeRot: money(before, basis),
    totalUnmarked: money(unmarked, basis),
    amountToPay: money(toPay, null),
    rotAmount: money(rot, null),
    labor: money(num(x.laborSumSek), x.vatMode === "inkl" || x.vatMode === "exkl" ? x.vatMode : null),
    material: money(num(x.materialSumSek), x.vatMode === "inkl" || x.vatMode === "exkl" ? x.vatMode : null),
    travel: money(num(x.travelSumSek), x.vatMode === "inkl" || x.vatMode === "exkl" ? x.vatMode : null),
    other: money(num(x.otherSumSek), x.vatMode === "inkl" || x.vatMode === "exkl" ? x.vatMode : null),
    hourlyRate: money(num(x.hourlyRateSek), x.vatMode === "inkl" || x.vatMode === "exkl" ? x.vatMode : null),
    vatMode: x.vatMode || null,
    normalized: incVat === null ? null : { incVat, exVat },
    partsSum,
    // Delposter jämförs mot totalen bara när momsläget är entydigt och samma för delposter och total.
    sumCheck: (() => {
      if (partsSum === null || before === null) return null;
      if (!(x.vatMode === "inkl" || x.vatMode === "exkl") || x.vatMode !== basis) return { state: "ej_jamforbar" };
      const diff = round(before - partsSum);
      const tol = Math.max(50, before * 0.02);
      return Math.abs(diff) <= tol ? { state: "stammer", diff } : { state: "avviker", diff, partsSum, total: before };
    })(),
  };
}

function projectOf(x) {
  return {
    jobType: x.jobType || null,
    jobLabel: x.jobType ? JOB_LABEL[x.jobType] : null,
    propertyType: x.propertyType || null,
    areaM2: num(x.areaM2),
    unitCount: num(x.unitCount),
    description: cleanText(x.workDescription || "", 120),
    county: cleanText(x.county || "", 40),
    customerType: x.customerType || null,
  };
}

export function compareOffers(rawOffers, labels) {
  const n = rawOffers.length;
  const offers = rawOffers.map((o, i) => ({
    index: i,
    label: labels[i],
    readability: o.readability,
    instructionsInDocument: o.instructionsInDocument,
    project: projectOf(o.extracted),
    price: priceOf(o.extracted),
    facts: o.facts,
    issues: o.issues,
  }));
  const diffs = [];
  const add = (d) => diffs.push(d);

  // ---- Samma projekt? ----
  const cmp = { sameProject: "ok", reasons: [] };
  const jobs = [...new Set(offers.map((o) => o.project.jobType).filter(Boolean))];
  const jobUnknown = offers.filter((o) => !o.project.jobType).map((o) => o.index);
  if (jobs.length > 1) {
    cmp.sameProject = "olika";
    const names = [...new Set(offers.map((o) => o.project.jobLabel).filter(Boolean))].join(" och ");
    cmp.reasons.push(`Offerterna verkar gälla olika typer av arbete (${names}). Då går de inte att jämföra rakt av.`);
    add({ id: "proj:typ", weight: 95, category: "projekt", offers: offers.map((o) => o.index), text: `Offerterna verkar gälla olika typer av arbete (${names}).` });
  } else if (jobUnknown.length) {
    cmp.sameProject = "oklart";
    cmp.reasons.push("Det gick inte att läsa av vilket arbete en eller flera offerter gäller.");
    add({ id: "proj:oklart", weight: 70, category: "projekt", offers: jobUnknown, text: "Det framgår inte av alla offerter vilket arbete de gäller." });
  }
  const areas = offers.map((o) => o.project.areaM2).filter((v) => v !== null && v > 0);
  // Uttryckligt olika yta är olika omfattning: ingen tolerans som döljer 100 m² mot 120 m² (bara avrundning ≤ 2 % släpps).
  if (areas.length >= 2 && Math.max(...areas) / Math.min(...areas) > AREA_ROUNDING) {
    if (cmp.sameProject === "ok") cmp.sameProject = "begransad";
    cmp.reasons.push("Offerterna anger olika ytor, så belopp per offert är inte direkt jämförbara. Olika omfattning måste klarläggas innan beloppen kan jämföras.");
    add({ id: "proj:yta", weight: 88, category: "projekt", offers: offers.map((o) => o.index), text: "Offerterna anger olika ytor." });
  }
  const units = offers.map((o) => o.project.unitCount).filter((v) => v !== null);
  if (units.length >= 2 && new Set(units).size > 1) {
    if (cmp.sameProject === "ok") cmp.sameProject = "begransad";
    cmp.reasons.push("Offerterna anger olika antal enheter.");
    add({ id: "proj:antal", weight: 86, category: "projekt", offers: offers.map((o) => o.index), text: "Offerterna anger olika antal enheter." });
  }
  const props = [...new Set(offers.map((o) => o.project.propertyType).filter(Boolean))];
  if (props.length > 1) {
    if (cmp.sameProject === "ok") cmp.sameProject = "begransad";
    cmp.reasons.push("Offerterna anger olika bostadstyp.");
    add({ id: "proj:bostad", weight: 60, category: "projekt", offers: offers.map((o) => o.index), text: "Offerterna anger olika bostadstyp." });
  }
  if (cmp.sameProject === "ok") cmp.reasons.push("Inget i det som lästes av talar emot att offerterna gäller samma arbete. Det är ändå du som avgör om de gör det.");

  // ---- Omfattning ----
  const matrix = SCOPE_CATALOG.map((c) => {
    const cells = offers.map((_, i) => ({ ...rawOffers[i].scope[c.id] }));
    const st = cells.map((x) => x.status);
    const has = (s) => st.includes(s);
    let kind;
    if (has("ingar") && has("ingar_inte")) kind = "skiljer";
    else if (has("framgar_inte") && (has("ingar") || has("ingar_inte"))) kind = "oklart_for_nagon";
    else if (has("framgar_inte")) kind = "oklart_alla";
    else kind = "lika";
    return { id: c.id, label: c.label, group: c.group, core: CORE.includes(c.id), cells, kind };
  });
  for (const m of matrix) {
    const w = m.core ? 1 : 0;
    if (m.kind === "skiljer") {
      const inc = offers.filter((_, i) => m.cells[i].status === "ingar").map((o) => o.index);
      const exc = offers.filter((_, i) => m.cells[i].status === "ingar_inte").map((o) => o.index);
      add({ id: `scope:${m.id}`, weight: m.core ? 100 : 62, category: m.group, offers: [...inc, ...exc], text: `${m.label}: ${inc.map((i) => offers[i].label).join(", ")} anger att det ingår, ${exc.map((i) => offers[i].label).join(", ")} anger att det inte ingår.` });
    } else if (m.kind === "oklart_for_nagon") {
      const unk = offers.filter((_, i) => m.cells[i].status === "framgar_inte").map((o) => o.index);
      add({ id: `scope:${m.id}`, weight: m.core ? 90 : 45 + w, category: m.group, offers: unk, text: `${m.label}: framgår inte av ${unk.map((i) => offers[i].label).join(", ")}, men anges i minst en annan offert.` });
    }
  }
  const commonUnknownCore = matrix.filter((m) => m.core && m.kind === "oklart_alla").map((m) => m.label);

  // ---- Pris ----
  const prices = offers.map((o) => o.price);
  const pt = [...new Set(prices.map((p) => p.priceType).filter(Boolean))];
  const priceTypeMix = pt.length > 1 || prices.some((p) => !p.priceType);
  if (pt.length > 1) add({ id: "price:typ", weight: 84, category: "pris", offers: offers.map((o) => o.index), text: `Offerterna har olika pristyp (${pt.map((t) => PRICE_TYPE_LABEL[t]).join(" och ")}), så beloppen är inte samma sorts uppgift.` });
  const allNorm = prices.every((p) => p.normalized !== null);
  const someBasisMissing = offers.filter((o) => o.price.totalBeforeRot !== null && !o.price.vatBasis).map((o) => o.index);
  const noTotalBefore = offers.filter((o) => o.price.totalBeforeRot === null).map((o) => o.index);
  const unmarkedOnly = offers.filter((o) => o.price.totalBeforeRot === null && o.price.totalUnmarked !== null).map((o) => o.index);
  if (someBasisMissing.length) add({ id: "price:momsbas", weight: 82, category: "pris", offers: someBasisMissing, text: `Det framgår inte om totalbeloppet är inklusive eller exklusive moms i ${someBasisMissing.map((i) => offers[i].label).join(", ")}.` });
  if (unmarkedOnly.length) add({ id: "price:rotbas", weight: 80, category: "pris", offers: unmarkedOnly, text: `Totalbeloppet i ${unmarkedOnly.map((i) => offers[i].label).join(", ")} är inte märkt som före eller efter ROT-avdrag, så det jämförs inte med de andra.` });
  const rotMix = offers.some((o) => o.price.rotAmount !== null) && offers.some((o) => o.price.rotAmount === null);
  if (rotMix) add({ id: "price:rot", weight: 66, category: "pris", offers: offers.filter((o) => o.price.rotAmount === null).map((o) => o.index), text: "ROT-avdrag anges i några offerter men inte i alla. Jämför beloppen före ROT." });
  for (const o of offers) {
    const sc = o.price.sumCheck;
    if (sc && sc.state === "avviker") add({ id: `price:summa_${o.index}`, weight: 85, category: "pris", offers: [o.index], text: `I ${o.label} summerar delposterna till ${sc.partsSum} kr medan totalen är ${sc.total} kr (skillnad ${Math.abs(sc.diff)} kr). Det kan bero på rader som inte lästes av eller avrundning.` });
    if (o.readability === "osaker" || o.readability === "svar") add({ id: `read:${o.index}`, weight: o.readability === "svar" ? 92 : 70, category: "avlasning", offers: [o.index], text: o.readability === "svar" ? `${o.label} var mycket svår att läsa av. Beloppen bör bekräftas.` : `Delar av ${o.label} var svårlästa. Kontrollera att beloppen stämmer.` });
    if (o.instructionsInDocument) add({ id: `inj:${o.index}`, weight: 30, category: "avlasning", offers: [o.index], text: `${o.label} innehåller text som försöker styra läsningen. Den har ignorerats.` });
  }

  // ---- Rangordning (bara när allt är jämförbart) ----
  const ranking = { shown: false, reasons: [] };
  const blockers = [];
  if (!allNorm) blockers.push("Alla offerter anger inte ett totalbelopp före ROT med känd momsbas.");
  if (priceTypeMix) blockers.push("Pristyp är inte densamma (eller inte angiven) i alla offerter.");
  if (cmp.sameProject !== "ok") blockers.push("Det är inte säkert att offerterna gäller samma arbete eller omfattning.");
  const coreDiff = matrix.filter((m) => m.core && (m.kind === "skiljer" || m.kind === "oklart_for_nagon"));
  // ALLA uttryckliga omfattningsskillnader (ingår mot ingår inte, i valfri omfattningspost) stoppar prisrangordning; villkorsskillnader visas separat.
  const scopeDiff = matrix.filter((m) => m.group === "omfattning" && m.kind === "skiljer" && !m.core);
  if (scopeDiff.length) blockers.push(`Omfattningen skiljer sig uttryckligen i: ${scopeDiff.map((m) => lower(m.label)).join(", ")}. Olika omfattning måste klarläggas innan beloppen kan jämföras – ingen offert pekas ut som billigast.`);
  if (coreDiff.length) blockers.push(`Omfattningen skiljer sig eller är oklar i: ${coreDiff.map((m) => lower(m.label)).join(", ")}.`);
  if (offers.some((o) => o.readability === "svar")) blockers.push("En offert var mycket svår att läsa av.");
  // Om offerterna inte säger något om de flesta kärnposterna går det inte att veta vad priset omfattar.
  if (commonUnknownCore.length >= 3) blockers.push(`Ingen av offerterna anger om följande ingår: ${commonUnknownCore.map(lower).join(", ")}. Då går det inte att veta vad priserna omfattar.`);
  if (!blockers.length) {
    const inc = offers.map((o) => ({ i: o.index, v: o.price.normalized.incVat }));
    const sorted = [...inc].sort((a, b) => a.v - b.v);
    const lowest = sorted[0], next = sorted[1];
    const tie = lowest.v === next.v;
    ranking.shown = true;
    ranking.basis = "Totalt före ROT, inklusive moms (25 % moms antas vid omräkning där offerten anger belopp exklusive moms)";
    ranking.values = inc.map((x) => ({ index: x.i, incVat: x.v }));
    if (!tie) ranking.lowest = { index: lowest.i, diffKr: next.v - lowest.v, diffPct: next.v > 0 ? Math.round(((next.v - lowest.v) / next.v) * 1000) / 10 : null };
    if (commonUnknownCore.length) ranking.reasons.push(`Observera: ingen offert anger om följande ingår: ${commonUnknownCore.map(lower).join(", ")}.`);
    ranking.reasons.push("Lägst angivet belopp på samma bas. Det säger inget om kvalitet, utförande eller om det som inte står i offerterna.");
  } else {
    ranking.reasons = blockers;
  }

  // ---- Frågor per offert ----
  const questions = offers.map((o) => {
    const qs = [];
    const i = o.index;
    const push = (id, weight, text, why) => qs.push({ id, weight, text, why, refs: [] });
    for (const m of matrix) {
      const me = m.cells[i];
      const others = m.cells.filter((_, k) => k !== i);
      const otherInc = others.some((c) => c.status === "ingar");
      const otherExc = others.some((c) => c.status === "ingar_inte");
      if (me.status === "framgar_inte" && (otherInc || otherExc)) push(`scope:${m.id}`, m.core ? 90 : 45, `${m.label}: ${otherInc ? "ingår" : "ingår inte"} det i den här offerten? Det framgår inte, men en annan offert anger uttryckligen att det ${otherInc ? "ingår" : "inte ingår"}.`, "Skillnad mellan offerterna");
      else if (me.status === "ingar_inte" && otherInc) push(`scope:${m.id}`, m.core ? 100 : 62, `${m.label}: offerten anger att det inte ingår, men en annan offert anger att det ingår. Vad kostar det att få med det?`, "Skillnad mellan offerterna");
      else if (me.status === "ingar" && otherExc) push(`scope:${m.id}`, m.core ? 60 : 40, `${m.label}: offerten anger att det ingår medan en annan offert anger att det inte ingår. Vad exakt ingår?`, "Skillnad mellan offerterna");
    }
    if (o.price.totalBeforeRot !== null && !o.price.vatBasis) push("price:momsbas", 82, "Är totalbeloppet inklusive eller exklusive moms?", "Momsbasen framgår inte");
    if (o.price.totalBeforeRot === null && o.price.totalUnmarked !== null) push("price:rotbas", 80, "Är totalbeloppet före eller efter ROT-avdrag?", "Totalen är inte märkt");
    if (o.price.totalBeforeRot === null && o.price.totalUnmarked === null && o.price.amountToPay === null) push("price:total", 78, "Vad blir totalbeloppet för hela arbetet, med angiven momsbas?", "Inget totalbelopp lästes av");
    if (o.price.priceType === "lopande" || o.price.priceType === "ungefarligt") push("price:typ", 84, `Offerten anger ${o.price.priceType === "lopande" ? "löpande räkning" : "ett uppskattat pris"}. Finns ett fast pris eller ett högsta belopp (takpris)?`, "Pristypen kan ändras under arbetet");
    const sc = o.price.sumCheck;
    if (sc && sc.state === "avviker") push("price:summa", 85, `Delposterna summerar till ${sc.partsSum} kr men totalen är ${sc.total} kr. Vad förklarar skillnaden?`, "Delposter och total stämmer inte");
    if (o.readability !== "bra") push("read", 70, "Några belopp var svåra att läsa av. Kan du få en tydligare kopia, eller bekräfta beloppen med hantverkaren?", "Osäker avläsning");
    // Allmänna kontrollfrågor fyller upp till tre när offerten själv är oklar i dessa punkter.
    const gen = [["fskatt", "Har företaget F-skatt? Det anges inte i offerten."], ["forsakring", "Vilken försäkring gäller för arbetet? Det anges inte i offerten."], ["garanti", "Vilken garanti ges på arbetet? Det anges inte i offerten."], ["ata", "Hur hanteras ändrings- och tilläggsarbeten (ÄTA) och vad kostar de? Det anges inte i offerten."], ["betalningsplan", "Hur ser betalningsplanen ut? Det anges inte i offerten."], ["startdatum", "När kan arbetet starta? Det anges inte i offerten."]];
    for (const [id, text] of gen) {
      if (qs.length >= 5) break;
      if (o.index >= 0 && rawOffers[i].scope[id].status === "framgar_inte" && !qs.some((q) => q.id === `gen:${id}`)) push(`gen:${id}`, 20, text, "Allmän kontrollfråga");
    }
    for (const q of qs) {
      const f = o.facts && o.facts.total;
      q.refs = q.id === "price:total" || q.id.startsWith("price:") ? (f ? [{ page: f.page, ref: f.ref }] : []) : [];
    }
    qs.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
    const seen = new Set();
    const uniq = qs.filter((q) => (seen.has(q.id) ? false : (seen.add(q.id), true))).slice(0, 6);
    return { offerIndex: i, label: o.label, questions: uniq.map(({ id, text, why, refs }) => ({ id, text, why, refs })) };
  });

  diffs.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));

  // ---- Beslutsblad ----
  const canNow = [];
  const allInc = matrix.filter((m) => m.cells.every((c) => c.status === "ingar")).map((m) => lower(m.label));
  if (allInc.length) canNow.push(`Det som alla offerter uttryckligen anger att det ingår: ${allInc.join(", ")}.`);
  if (allNorm) canNow.push("Totalbelopp före ROT går att ställa mot varandra på samma momsbas.");
  if (offers.every((o) => o.price.partsSum !== null)) canNow.push("Delposter (arbete, material, resor) finns i alla offerter.");
  const mustClarify = diffs.filter((d) => d.weight >= 40).slice(0, 8).map((d) => ({ id: d.id, text: d.text }));
  if (commonUnknownCore.length) mustClarify.push({ id: "scope:gemensamt_oklart", text: `Inga av offerterna anger: ${commonUnknownCore.map(lower).join(", ")}. Det går därför inte att veta om det ingår.` });

  return { offers, comparability: cmp, scopeMatrix: matrix, differences: diffs, ranking, questions, decisionSheet: { canCompareNow: canNow, mustClarify }, labels, count: n };
}

// Fast text för en rubrik per pristyp (används av gränssnittet via rapporten).
export const PRICE_TYPE_LABELS = PRICE_TYPE_LABEL;
export const PROPERTY_LABELS = PROP_LABEL;
