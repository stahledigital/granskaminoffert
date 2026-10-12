// D17 Förkontroll av min offert (GMO-LANSERING-20261010-01): EN egen offert före utskick → fynd (ROT/moms/pristyp/omfattning/tid) och kundfrågor
// → hantverkaren BEKRÄFTAR uppgifter → konkreta tilläggstexter att klistra in + PDF-kundbilaga med exakt samma fakta och revision.
// Ren kod utan nätverk: återanvänder regelmotorn (rules.js), avläsningen (compare_extract) och PDF-skrivaren (compare_pdf). Inget skrivs av AI i
// tilläggen: varje mening byggs ur hantverkarens bekräftade värden. Okänt eller obekräftat (inkl. garanti) förblir okänt. Originalofferten ändras aldrig.

import REFERENCE from "./reference.json" with { type: "json" };
import { runRules, scrubForbidden } from "./rules.js";
import { SCOPE_CATALOG } from "./compare_extract.js";
import { OFFER, vatPart } from "./compare_config.js";
import { sha256Hex } from "./compare_util.js";
import { renderPdf } from "./compare_pdf.js";

export const CHECK_VERSION = "forkontroll-1";
export const CHECK_PRODUCT = "Förkontroll av min offert";
export const CHECK_LIMITS = Object.freeze({ maxSaves: 12, maxExports: 12, maxLines: 8, lineMax: 140, warrantyMax: 200, amountMax: 10_000_000 });

const SCOPE_LABEL = Object.fromEntries(SCOPE_CATALOG.map((c) => [c.id, c.label]));
const STATUS_ORDER = { fel: 0, fraga: 1, flagga: 2, ej_bedombar: 3, ok: 4 };
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const kr = (n) => `${Math.round(n).toLocaleString("sv-SE").replace(/[\u00a0\u202f]/g, " ")} kr`;
const MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
export function sv_date(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "")); return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : ""; }
const validDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s)); if (!m) return false; const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] && +m[1] >= 2024 && +m[1] <= 2100; };

// ---------- rapport (efter avläsning) ----------
export function buildCheckReport({ order, offer, label, now = Date.now(), receipt }) {
  const x = offer.extracted || {};
  const rules = scrubForbidden(runRules(x, REFERENCE)).map((r) => ({ id: r.id, status: r.status, title: r.title, text: r.text, source: r.source || "" }));
  const own = [];
  const addOwn = (id, status, title, text) => own.push({ id, status, title, text, source: "" });
  const sc = offer.scope || {};
  const unknownScope = SCOPE_CATALOG.filter((c) => c.group === "omfattning" && (sc[c.id] || {}).status !== "ingar" && (sc[c.id] || {}).status !== "ingar_inte");
  if (!x.priceType) addOwn("fk_pristyp", "fraga", "Pristyp", "Offerten anger inte tydligt om priset är fast, ungefärligt eller löpande. Det måste stå, annars kan kunden läsa det på annat sätt än du menar.");
  else if (x.priceType === "ungefarligt") addOwn("fk_pristyp", "fraga", "Pristyp", "Offerten anger ett ungefärligt pris. Är priset egentligen fast? Skriv i så fall det uttryckligen. Ett ”fast cirka-pris” är motsägelsefullt och tolkas olika.");
  else if (x.priceType === "lopande") addOwn("fk_pristyp", "flagga", "Pristyp", "Offerten anger löpande räkning. Ange gärna en timkostnad och en övre gräns om du kan.");
  if (unknownScope.length) addOwn("fk_omfattning", "fraga", "Omfattning", `Offerten anger inte om följande ingår: ${unknownScope.map((c) => SCOPE_LABEL[c.id].toLowerCase()).join(", ")}. Det du inte skriver kan kunden anta ingår.`);
  const lacks = (id) => (sc[id] || {}).status !== "ingar" && (sc[id] || {}).status !== "ingar_inte";
  if (lacks("startdatum") && lacks("tidplan")) addOwn("fk_tid", "fraga", "Tid", "Varken startdatum eller tidplan framgår. Ange planerad start och planerat slut, eller att de är preliminära.");
  if (lacks("garanti")) addOwn("fk_garanti", "flagga", "Garanti", "Garanti framgår inte. Skriv bara en garanti du faktiskt lämnar. Anger du ingen förblir den okänd och ingen garanti läggs till här.");
  const findings = [...own, ...rules].sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9));
  const needs = [];
  const want = (id, why) => { if (!needs.some((n) => n.id === id)) needs.push({ id, why }); };
  if (!x.priceType || x.priceType !== "fast") want("priceType", "Pristypen är inte tydligt fast.");
  if (rules.some((r) => ["summa", "rot_belopp", "moms", "total_konflikt", "rot_material", "rot_tak"].includes(r.id) && ["fel", "fraga", "ej_bedombar", "flagga"].includes(r.status)) || x.vatMode !== "inkl" || x.laborSumSek == null) want("amounts", "Summa, moms eller ROT-bas går inte att kontrollera eller stämmer inte.");
  if (unknownScope.length || SCOPE_CATALOG.some((c) => ["stadning", "bortforsling"].includes(c.id) && lacks(c.id))) want("scope", "Omfattning eller avgränsning framgår inte.");
  if (lacks("startdatum") || lacks("tidplan")) want("dates", "Tid framgår inte.");
  if (lacks("garanti")) want("warranty", "Garanti framgår inte (valfritt).");
  const original = {
    priceType: x.priceType || null, vatMode: x.vatMode || "ej_angivet", totalSumSek: num(x.totalSumSek), totalBeforeRotSek: num(x.totalBeforeRotSek), amountToPaySek: num(x.amountToPaySek),
    totalVatBasis: x.totalVatBasis || null, laborSumSek: num(x.laborSumSek), materialSumSek: num(x.materialSumSek), otherSumSek: num(x.otherSumSek), rotAmountSek: num(x.rotAmountSek),
    areaM2: num(x.areaM2), workDescription: x.workDescription || null, quoteDate: x.quoteDate || null,
  };
  const scopeRows = SCOPE_CATALOG.map((c) => ({ id: c.id, label: c.label, group: c.group, status: (sc[c.id] || {}).status || "framgar_inte", page: (sc[c.id] || {}).page || null, ref: (sc[c.id] || {}).ref || "" }));
  return {
    kind: "check", version: CHECK_VERSION, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + OFFER.retentionHours * 3600_000).toISOString(),
    label: label || "Din offert", readability: offer.readability, instructionsInDocument: !!offer.instructionsInDocument,
    original, findings, scope: scopeRows, needs,
    questions: customerQuestions(findings, scopeRows),
    rot: { rate: REFERENCE.rot && REFERENCE.rot.rate, note: "ROT-avdrag är villkorat: det gäller bara om kunden har rätt till avdraget och utrymme kvar. Beräknas på arbetskostnaden inklusive moms." },
    receipt: receipt || null,
    disclaimers: [
      "Förkontrollen bygger bara på vad som står i offerten du laddade upp. Den bedömer inte kvalitet, om priset är rimligt eller om kunden får ROT-avdrag.",
      "Det som inte framgår av offerten är inte detsamma som att det saknas. Tilläggen innehåller bara uppgifter DU har bekräftat; allt annat förblir okänt.",
      "Beloppen är avlästa ur dokumentet och kan innehålla avläsningsfel. Kontrollera mot ditt original, som förblir oförändrat.",
      "Detta är inte juridisk rådgivning.",
    ],
  };
}

// Frågor kunden sannolikt ställer, utan att hitta på något: bara om det inte står i offerten.
function customerQuestions(findings, scopeRows) {
  const q = [];
  const has = (id) => findings.some((f) => f.id === id && f.status !== "ok");
  if (has("fk_pristyp")) q.push({ id: "pris", text: "Är priset fast, eller kan det bli dyrare?" });
  if (findings.some((f) => ["moms", "summa", "total_konflikt"].includes(f.id) && f.status !== "ok")) q.push({ id: "moms", text: "Är priset med eller utan moms, och vad blir totalen?" });
  q.push({ id: "rot", text: "Hur mycket får jag i ROT-avdrag, och vad betalar jag efter avdraget?" });
  for (const id of ["stadning", "bortforsling", "material", "skydd"]) { const s = scopeRows.find((r) => r.id === id); if (s && s.status === "framgar_inte") q.push({ id: "scope:" + id, text: `${s.label}: ingår det?` }); }
  if (has("fk_tid")) q.push({ id: "tid", text: "När börjar ni och när är ni klara?" });
  if (has("fk_garanti")) q.push({ id: "garanti", text: "Vilken garanti ger ni på arbetet?" });
  return q.slice(0, 8);
}

// ---------- bekräftelser (hantverkaren) ----------
const PRICE_TYPES = ["fast", "ungefarligt", "lopande"];
const textOk = (s) => typeof s === "string" && !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);
const cleanLine = (s) => String(s).replace(/\s+/g, " ").trim();
const amount = (v) => (Number.isInteger(v) && v >= 0 && v <= CHECK_LIMITS.amountMax ? v : undefined); // hela kronor: decimaler/strängar avvisas, aldrig tyst avrundning
// Validerar och normaliserar hantverkarens värden. Okänt/utelämnat förblir utelämnat (ingen standard, ingen gissning). Returnerar { values } eller { error }.
export function validateConfirmation(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "Ogiltig begäran." };
  const v = {};
  const bad = (m) => ({ error: m });
  if (input.priceType !== undefined && input.priceType !== null) { if (!PRICE_TYPES.includes(input.priceType)) return bad("Ogiltig pristyp."); v.priceType = input.priceType; }
  for (const k of ["laborInclVat", "materialInclVat", "otherInclVat"]) {
    if (input[k] === undefined || input[k] === null || input[k] === "") continue;
    const a = amount(input[k]); if (a === undefined) return bad("Beloppen måste vara hela kronor mellan 0 och 10 000 000, inklusive moms.");
    v[k] = a;
  }
  if (input.rotMode !== undefined && input.rotMode !== null) { if (!["villkorat", "ingen"].includes(input.rotMode)) return bad("Ogiltigt ROT-val."); v.rotMode = input.rotMode; }
  for (const k of ["plannedStart", "plannedEnd"]) {
    if (input[k] === undefined || input[k] === null || input[k] === "") continue;
    if (!validDate(input[k])) return bad("Datum måste vara riktiga datum, ÅÅÅÅ-MM-DD.");
    v[k] = input[k];
  }
  if (v.plannedStart && v.plannedEnd && v.plannedEnd < v.plannedStart) return bad("Slutdatum kan inte vara före startdatum.");
  for (const k of ["includes", "excludes"]) {
    if (input[k] === undefined || input[k] === null) continue;
    if (!Array.isArray(input[k]) || input[k].length > CHECK_LIMITS.maxLines) return bad(`Högst ${CHECK_LIMITS.maxLines} rader.`);
    const out = [];
    for (const s of input[k]) { if (typeof s !== "string") return bad("Ogiltig text."); const t = cleanLine(s); if (!t) continue; if (!textOk(t)) return bad("Texten får inte innehålla tecknen < eller >, eller styrtecken."); if (t.length > CHECK_LIMITS.lineMax) return bad(`Högst ${CHECK_LIMITS.lineMax} tecken per rad.`); out.push(t); }
    if (out.length) v[k] = out;
  }
  for (const k of ["cleaning", "removal"]) { if (input[k] === undefined || input[k] === null) continue; if (!["ingar", "ingar_inte"].includes(input[k])) return bad("Ogiltigt val."); v[k] = input[k]; }
  if (input.warranty !== undefined && input.warranty !== null && input.warranty !== "") {
    if (typeof input.warranty !== "string") return bad("Ogiltig text."); const t = cleanLine(input.warranty);
    if (!textOk(t)) return bad("Texten får inte innehålla tecknen < eller >, eller styrtecken."); if (t.length > CHECK_LIMITS.warrantyMax) return bad(`Högst ${CHECK_LIMITS.warrantyMax} tecken.`); if (t) v.warranty = t;
  }
  const known = new Set(["priceType", "laborInclVat", "materialInclVat", "otherInclVat", "rotMode", "plannedStart", "plannedEnd", "includes", "excludes", "cleaning", "removal", "warranty"]);
  for (const k of Object.keys(input)) if (!known.has(k)) return bad("Okänt fält.");
  return { values: v };
}

// Härledda fakta ur bekräftade värden. EN källa för både text och PDF.
export function deriveFacts(values) {
  const v = values || {};
  const f = { lines: [] };
  const parts = [["arbete", v.laborInclVat], ["material", v.materialInclVat], ["övrigt", v.otherInclVat]].filter(([, a]) => a !== undefined);
  const labor = v.laborInclVat, material = v.materialInclVat;
  f.priceType = v.priceType || null;
  f.parts = parts.map(([name, amountKr]) => ({ name, amountKr }));
  // Total bara när arbete, material OCH övrigt är uttryckligen bekräftade (övrigt får vara 0, men aldrig tomt = 0). Okänd kostnad blir aldrig noll.
  const other = v.otherInclVat;
  f.totalInclVat = labor !== undefined && material !== undefined && other !== undefined ? labor + material + other : null;
  f.totalMissing = [labor === undefined ? "arbete" : null, material === undefined ? "material" : null, other === undefined ? "övrigt (skriv 0 om inget övrigt)" : null].filter(Boolean);
  f.vatKr = f.totalInclVat === null ? null : Math.round(f.totalInclVat - f.totalInclVat / (1 + OFFER.vatPct / 100));
  const rate = REFERENCE.rot && REFERENCE.rot.rate, cap = REFERENCE.rot && REFERENCE.rot.maxPerPerson;
  f.rot = null;
  if (v.rotMode === "villkorat" && labor !== undefined && typeof rate === "number" && typeof cap === "number") {
    // Procentunderlaget (30 % av arbetskostnaden) är inte detsamma som ett personligt avdrag: taket är per person och år, flera ägare kan dela och
    // utrymme/skatt avgör. Över taket utan bekräftad fördelning anges inget personligt avdrag eller nettobelopp.
    const base = Math.round(labor * rate), over = base > cap;
    f.rot = { ratePct: Math.round(rate * 100), baseKr: labor, capKr: cap, underlagKr: base, overCap: over, amountKr: over ? null : base, netKr: over || f.totalInclVat === null ? null : f.totalInclVat - base };
  } else if (v.rotMode === "ingen") f.rot = { none: true };
  f.start = v.plannedStart || null; f.end = v.plannedEnd || null;
  f.includes = v.includes || []; f.excludes = v.excludes || [];
  f.cleaning = v.cleaning || null; f.removal = v.removal || null;
  f.warranty = v.warranty || null;
  return f;
}

// Tilläggstexter (klistra in i offerten). Varje sektion byggs ur bekräftade värden; saknas värdet saknas sektionen.
export function additionSections(facts) {
  const s = [];
  const f = facts;
  if (f.priceType || f.totalInclVat !== null || f.parts.length) {
    const t = [];
    if (f.totalInclVat !== null) {
      const brk = f.parts.map((p) => `${p.name} ${kr(p.amountKr)}`).join(", ");
      t.push(`${f.priceType === "fast" ? "Fast pris" : f.priceType === "ungefarligt" ? "Ungefärligt pris" : f.priceType === "lopande" ? "Pris enligt löpande räkning, uppskattat" : "Pris"}: ${kr(f.totalInclVat)} inklusive moms (varav moms ${kr(f.vatKr)}). Fördelning inklusive moms: ${brk}.`);
    } else if (f.priceType) t.push(f.priceType === "fast" ? "Priset är ett fast pris." : f.priceType === "ungefarligt" ? "Priset är ungefärligt." : "Arbetet utförs på löpande räkning.");
    if (f.totalInclVat === null && f.parts.length) t.push(`Delbelopp inklusive moms: ${f.parts.map((p) => `${p.name} ${kr(p.amountKr)}`).join(", ")}.`);
    s.push({ id: "pris", title: "Pris och moms", text: t.join(" ") });
  }
  if (f.rot && f.rot.none) s.push({ id: "rot", title: "ROT-avdrag", text: "Offerten avser arbete utan ROT-avdrag." });
  else if (f.rot && f.rot.overCap) s.push({ id: "rot", title: "ROT-avdrag", text: `Arbetskostnaden är ${kr(f.rot.baseKr)} inklusive moms. ${f.rot.ratePct} % av arbetskostnaden skulle motsvara ${kr(f.rot.underlagKr)}, men ROT-avdraget är högst ${kr(f.rot.capKr)} per person och år. Hur mycket varje kund kan dra av beror på hur många som äger bostaden och delar avdraget, på kvarvarande utrymme och på skatten (kontrollera hos Skatteverket). Något avdrag eller belopp efter avdrag anges därför inte här.` });
  else if (f.rot) s.push({ id: "rot", title: "ROT-avdrag", text: `Arbetskostnaden är ${kr(f.rot.baseKr)} inklusive moms. Om du som kund har rätt till ROT-avdrag (${f.rot.ratePct} % av arbetskostnaden, högst ${kr(f.rot.capKr)} per person och år) blir avdraget ${kr(f.rot.amountKr)}${f.rot.netKr !== null ? `, och du betalar då ${kr(f.rot.netKr)} efter avdraget` : ""}. Avdraget är villkorat: det förutsätter att du har rätt till ROT-avdrag och utrymme kvar för året. Avdraget görs på arbetskostnaden, inte på material.` });
  if (f.includes.length || f.excludes.length || f.cleaning || f.removal) {
    const t = [];
    if (f.includes.length) t.push(`I priset ingår: ${f.includes.join("; ")}.`);
    if (f.cleaning) t.push(f.cleaning === "ingar" ? "Städning efter arbetet ingår." : "Städning efter arbetet ingår inte.");
    if (f.removal) t.push(f.removal === "ingar" ? "Bortforsling av avfall ingår." : "Bortforsling av avfall ingår inte.");
    if (f.excludes.length) t.push(`Ingår inte: ${f.excludes.join("; ")}.`);
    s.push({ id: "omfattning", title: "Omfattning", text: t.join(" ") });
  }
  if (f.start || f.end) s.push({ id: "tid", title: "Planerad tid", text: f.start && f.end ? `Planerad start ${sv_date(f.start)} och planerat klart ${sv_date(f.end)}.` : f.start ? `Planerad start ${sv_date(f.start)}.` : `Planerat klart ${sv_date(f.end)}.` });
  if (f.warranty) s.push({ id: "garanti", title: "Garanti", text: f.warranty.endsWith(".") ? f.warranty : f.warranty + "." });
  return s;
}

export async function revisionCode(reportCreatedAt, values, revision) {
  return (await sha256Hex(JSON.stringify({ r: CHECK_VERSION, c: reportCreatedAt, n: revision, v: values }))).slice(0, 10).toUpperCase();
}

// Kvarstående kritiska oklarheter: det rapporten sa behövdes (needs) men hantverkaren ännu inte bekräftat. Garanti är alltid valfri och blockerar aldrig.
const NEED_LABEL = { priceType: "Pristyp (fast, ungefärligt eller löpande)", amounts: "Belopp: arbete, material och övrigt inklusive moms (0 om inget) samt ROT-val", scope: "Omfattning: vad som ingår och inte ingår, städning och bortforsling", dates: "Planerad start och planerat slut" };
export function unresolvedNeeds(report, values) {
  const v = values || {};
  const done = {
    priceType: () => !!v.priceType,
    amounts: () => v.laborInclVat !== undefined && v.materialInclVat !== undefined && v.otherInclVat !== undefined && !!v.rotMode,
    scope: () => ((v.includes || []).length > 0 || (v.excludes || []).length > 0) && !!v.cleaning && !!v.removal,
    dates: () => !!v.plannedStart && !!v.plannedEnd,
  };
  return ((report && report.needs) || []).filter((n) => done[n.id] && !done[n.id]()).map((n) => ({ id: n.id, label: NEED_LABEL[n.id] }));
}
const draftLine = (un) => `UTKAST – tillägget är inte komplett. Kvarstår att bekräfta: ${un.map((u) => u.label).join("; ")}.`;

// Allt som visas/exporteras för en revision (text + PDF härleds ur exakt detta objekt).
export async function checkOutputs(report, conf) {
  const values = (conf && conf.values) || {};
  const facts = deriveFacts(values);
  const sections = additionSections(facts);
  const rev = conf ? conf.revision : 0;
  const code = await revisionCode(report.createdAt, values, rev);
  const head = `Tillägg till offert – förkontroll rev ${rev} (${code})`;
  const unresolved = conf && conf.revision ? unresolvedNeeds(report, values) : [];
  const draft = unresolved.length > 0;
  const text = sections.length ? [head, ...(draft ? [draftLine(unresolved)] : []), ...sections.map((x) => `${x.title}\n${x.text}`)].join("\n\n") + "\n\nOriginalofferten är oförändrad. Uppgifter som inte står här är inte bekräftade." + (draft ? `\n${draftLine(unresolved)}` : "") : "";
  return { revision: rev, code, facts, sections, unresolved, draft, text };
}

export async function customerAttachmentPdf(report, conf, extra = {}) {
  const out = await checkOutputs(report, conf);
  const B = [{ t: "h1", text: "Tillägg till offert" }, { t: "p", text: `Offert: ${report.label}${report.original.quoteDate ? `, daterad ${report.original.quoteDate}` : ""}. Revision ${out.revision}, kod ${out.code}.` },
    { t: "small", text: "Det här tillägget innehåller bara uppgifter som hantverkaren bekräftat. Originalofferten är oförändrad. Det som inte står här är inte bekräftat." }];
  const f = out.facts;
  if (out.draft) B.push({ t: "p", text: draftLine(out.unresolved) });
  if (f.totalInclVat !== null) {
    B.push({ t: "h2", text: "Pris" });
    B.push({ t: "table", cols: [3, 2], head: ["Post", "Belopp inkl. moms"], rows: [...f.parts.map((p) => [p.name[0].toUpperCase() + p.name.slice(1), kr(p.amountKr)]), ["Totalt", kr(f.totalInclVat)], ["Varav moms (25 %)", kr(f.vatKr)]] });
  }
  for (const s of out.sections) { if (s.id === "pris" && f.totalInclVat !== null) { B.push({ t: "p", text: s.text }); continue; } B.push({ t: "h2", text: s.title }); B.push({ t: "p", text: s.text }); }
  if (!out.sections.length) B.push({ t: "p", text: "Inga uppgifter är bekräftade ännu." });
  B.push({ t: "hr" }, { t: "small", text: `Revision ${out.revision}${out.draft ? " · utkast" : ""} · kod ${out.code}${extra.orderNo ? ` · förkontroll ${extra.orderNo}` : ""}` });
  return { pdf: renderPdf({ title: `Tillägg till offert (rev ${out.revision}${out.draft ? ", utkast" : ""})`, subject: "Tillägg till offert", author: "Hantverkaren", footer: `Tillägg · rev ${out.revision}${out.draft ? " · UTKAST" : ""} · ${out.code}`, blocks: B }), out };
}

// Hantverkarens egen rapport som PDF (fynd, frågor, nuläge) – privat för hantverkaren, inte kundbilagan.
export function checkReportBlocks(R) {
  const L = { fel: "Fel", fraga: "Fråga", flagga: "Observera", ej_bedombar: "Kan inte bedömas", ok: "Stämmer" };
  const B = [{ t: "h1", text: `Förkontroll ${R.receipt ? R.receipt.orderNo : ""}`.trim() }, { t: "p", text: `${R.label}. Skapad ${R.createdAt.slice(0, 10)}.` }, { t: "h2", text: "Fynd" }];
  for (const f of R.findings) B.push({ t: "li", text: `${L[f.status] || f.status}: ${f.title}. ${f.text}` });
  B.push({ t: "h2", text: "Frågor kunden sannolikt ställer" });
  for (const q of R.questions) B.push({ t: "li", text: q.text });
  B.push({ t: "h2", text: "Gränser" });
  for (const t of R.disclaimers) B.push({ t: "li", text: t });
  return B;
}
export const checkReportPdf = (R) => renderPdf({ title: "Förkontroll av min offert", subject: "Förkontroll", author: "Ståhle Digital", footer: "Förkontroll", blocks: checkReportBlocks(R) });
void vatPart;
