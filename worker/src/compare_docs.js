// PDF-dokument för mejlen (D16-R2 fix3b). Byggs vid sändning, deterministiskt, ur (a) det FRUSNA avtalet i ledgern och (b) den faktiskt lagrade rapporten. Inga nya beroenden.
//  - agreementPdf: hela det frusna avtalet i varaktig läsbar form (köpbelopp, säljare, exakt godkända texter, ordernummer, fullgörande, ångerrätt, villkor, ångerblankett) med klickbara länkar.
//  - reportPdf: HELA rapporten (omfattning, priser, frågor, källkortens status, gränser, kvitto) – inte en sammanfattning.
import { renderPdf, b64Bytes } from "./compare_pdf.js";
import { sellerLines } from "./compare_config.js";
import { pLines, kr as krOre, iso, withdrawalFormText, ANGERBLANKETT_SOURCE } from "./compare_ledger.js";

export { b64Bytes };
const kv = (line) => { const i = line.indexOf(": "); return i > 0 ? { t: "kv", k: line.slice(0, i), v: line.slice(i + 2) } : { t: "p", text: line }; };
const paras = (text, t = "p") => String(text).split("\n").map((x) => ({ t, text: x.length ? x : " " }));

// opts.angerLink: personlig ångerlänk (finns bara i bekräftelsen – råa token lagras aldrig); opts.kopLink: sidan "Ditt köp och villkor".
export function agreementBlocks(ledger, opts = {}) {
  const ag = ledger.agreement, ft = ag.accepted && ag.accepted.fullTerms;
  const B = [];
  B.push({ t: "h1", text: "Avtal och köpinformation" });
  if (ag.draft) B.push({ t: "b", text: "Utkast: villkoren är inte slutgiltiga." });
  B.push({ t: "p", text: `Det här är din avtalsbekräftelse för ${ag.product}. Den innehåller hela avtalet så som det frystes när du köpte, och sparas av oss tillsammans med din order.` });
  B.push({ t: "h2", text: "Köpet" });
  B.push(kv(`Avtals-ID: ${ledger.agreementId}`), kv(`Ordernummer: ${ag.orderId}`), kv(`Köpt: ${iso(ag.payment.paidAt)}`), kv(`Produkt: ${ag.product}`), kv(`Antal offerter: ${ag.docCount}`));
  B.push(kv(`Pris: ${krOre(ag.price.ore)} inklusive moms (varav moms ${krOre(ag.price.vatOre)}, ${ag.price.vatPct} %). Engångsköp.`));
  B.push({ t: "h2", text: "Säljare" });
  for (const l of sellerLines(ag.seller)) B.push(kv(l));
  B.push({ t: "h2", text: "Det här ingår" }); for (const t of ag.scope.gets) B.push({ t: "li", text: t });
  B.push({ t: "h3", text: "Det här ingår inte" }); for (const t of ag.scope.getsNot) B.push({ t: "li", text: t });
  B.push({ t: "h3", text: "Så går det till" }); for (const t of ag.scope.how) B.push({ t: "li", text: t });
  B.push({ t: "h2", text: "Det du godkände" });
  B.push({ t: "p", text: `Version ${ag.accepted.version}, kontrollsumma ${ag.accepted.hash}, ${iso(ag.accepted.at)}. Texterna står här ordagrant.` });
  B.push({ t: "li", text: ag.accepted.texts.sameJob }, { t: "li", text: ag.accepted.texts.terms });
  if (!ag.p) B.push({ t: "li", text: ag.accepted.texts.immediate });
  if (ag.p) for (const l of pLines(ag)) if (l) B.push({ t: /^\d\. |^- /.test(l) ? "li" : "p", text: l.replace(/^- /, "") });
  B.push({ t: "h2", text: "Ångerrätt och hur du ångrar" });
  B.push({ t: "p", text: "Innan tjänsten är fullt utförd kan du ångra köpet och få hela beloppet tillbaka. När tjänsten är fullt utförd enligt det du godkände upphör ångerrätten; din rätt att reklamera och dina övriga rättigheter påverkas inte." });
  if (opts.angerLink) B.push({ t: "p", text: `Ångra med din personliga länk: ${opts.angerLink}` });
  else B.push({ t: "p", text: "Din personliga ångerlänk finns i bekräftelsemejlet (PDF:en som skickades när du köpte). Du kan också ångra på sidan nedan, eller med blanketten längst bak." });
  if (opts.kopLink) B.push({ t: "p", text: `Ditt köp och villkor (ångra avtalet här när ångerrätt finns, reklamation och support): ${opts.kopLink}` });
  B.push({ t: "p", text: `Skicka annars den ifyllda blanketten (sista sidan) till ${ag.seller.email}.` });
  B.push({ t: "h2", text: `Villkor (version ${ft ? ft.version : "saknas"}${ft && ft.draft ? ", UTKAST" : ""}) – exakt den text du godkände` });
  if (ft) for (const x of ft.sections) { B.push({ t: "h3", text: x.title }); B.push(...paras(x.text)); } else B.push({ t: "p", text: "(villkorstexten saknas i snapshoten)" });
  B.push({ t: "p", text: "Kvittot från betalleverantören är en separat handling." });
  B.push({ t: "pagebreak" });
  const lines = withdrawalFormText(ledger).split("\n");
  B.push({ t: "h1", text: lines[0] });
  B.push({ t: "small", text: lines[1].replace(/, sha256 [0-9a-f]{64}/, "") });
  for (const l of lines.slice(2)) { if (l === "") B.push({ t: "space", h: 6 }); else if (/^Information om /.test(l)) B.push({ t: "h3", text: l }); else B.push({ t: "p", text: l.replace(/^ /, "") }); }
  void ANGERBLANKETT_SOURCE;
  return B;
}
export function agreementPdf(ledger, opts = {}) {
  const ag = ledger.agreement;
  return renderPdf({ title: `Avtal och köpinformation ${ledger.agreementId}`, subject: "Avtalsbekräftelse, villkor och ångerblankett", author: ag.seller.name, footer: `Avtals-ID ${ledger.agreementId} · ordernummer ${ag.orderId.slice(2, 10).toUpperCase()}`, blocks: agreementBlocks(ledger, opts) });
}

// ---------- rapport ----------
const grp = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const kr = (v) => `${grp(v)} kr`;
const money = (m) => (m ? kr(m.value) : "Framgår inte");
const STATUS = { ingar: "Ingår", ingar_inte: "Ingår inte", framgar_inte: "Framgår inte" };
const refOf = (c) => (c.status === "framgar_inte" ? "" : `${c.page ? `s. ${c.page}${c.ref ? ", " : ""}` : ""}${c.ref || ""}`);
const idLine = (f) => (f && f.status === "framgar" ? f.value : null);
function priceCell(of) {
  const p = of.price;
  if (p.normalized) return `${kr(p.normalized.incVat)} – ${p.vatBasis === "exkl" ? `offerten anger ${money(p.totalBeforeRot)} exkl. moms (25 % antas)` : "offerten anger beloppet inkl. moms"}`;
  if (p.totalBeforeRot) return `${money(p.totalBeforeRot)} – moms inkl/exkl framgår inte`;
  if (p.totalUnmarked) return `${kr(p.totalUnmarked.value)} – före/efter ROT framgår inte`;
  return "Framgår inte";
}
export function reportBlocks(R) {
  const n = R.offers.length, L = R.offers.map((x) => x.label), rc = R.receipt;
  const cols = [1.35, ...R.offers.map(() => 1.6)];
  const head = ["", ...L];
  const B = [];
  B.push({ t: "h1", text: "Din jämförelse" });
  B.push({ t: "p", text: `Ordernummer ${rc.orderNo} · skapad ${R.createdAt} · finns online till ${R.expiresAt}.` });
  B.push({ t: "p", text: "Offerterna sida vid sida. Ingår = offerten säger uttryckligen att det ingår. Framgår inte = det står inte i offerten (fråga hantverkaren). Beloppen är avlästa – kontrollera mot originalet." });
  const rk = R.ranking;
  if (rk.shown) B.push({ t: "b", text: rk.lowest ? `Lägst angivet belopp: ${L[rk.lowest.index]} (${kr(rk.lowest.diffKr)} lägre än näst lägsta, ${String(rk.lowest.diffPct).replace(".", ",")} %). Det säger inget om kvalitet eller om det som inte står i offerterna.` : "Beloppen är lika på samma bas." });
  else B.push({ t: "b", text: "Priserna går inte att ställa mot varandra rakt av – se raderna som skiljer nedan. Ingen offert pekas ut som billigast." });
  B.push({ t: "h2", text: "Offerterna sida vid sida" });
  const rows = [];
  rows.push(["Företag", ...R.offers.map((of) => { const id = of.identity; const nm = id && idLine(id.fields.name); return nm ? nm + (idLine(id.fields.city) ? ` · ${id.fields.city.value}` : "") : id && id.state === "ej_avlast" ? "Kunde inte avläsas säkert" : "Framgår inte av offerten"; })]);
  rows.push(["Uppgifter att reda ut", ...R.offers.map((of) => (of.open && of.open.assessable ? `${of.open.count} uppgifter` : "Går inte att bedöma säkert"))]);
  rows.push([`Pris inkl. moms (före ROT)${rk.shown ? "" : " – ej jämförbart"}`, ...R.offers.map(priceCell)]);
  rows.push(["ROT-avdrag / att betala", ...R.offers.map((of) => { const p = of.price; return `${p.rotAmount ? `ROT ${kr(p.rotAmount.value)}` : "ROT anges inte"}${p.amountToPay ? ` · Att betala ${kr(p.amountToPay.value)}` : ""}`; })]);
  rows.push(["Pristyp", ...R.offers.map((of) => ({ fast: "Fast pris", ungefarligt: "Uppskattat pris", lopande: "Löpande räkning" }[of.price.priceType] || "Framgår inte"))]);
  rows.push(["Arbete / material / resor", ...R.offers.map((of) => { const p = of.price, a = []; if (p.labor) a.push(`Arbete ${kr(p.labor.value)}`); if (p.material) a.push(`Material ${kr(p.material.value)}`); if (p.travel) a.push(`Resor ${kr(p.travel.value)}`); return a.length ? a.join(" · ") : "Delposter framgår inte"; })]);
  for (const m of R.scopeMatrix) rows.push([m.label + (m.kind === "skiljer" ? " (skiljer)" : m.kind === "oklart_for_nagon" ? " (oklart i någon)" : ""), ...m.cells.map((c) => `${STATUS[c.status] || c.status}${refOf(c) ? ` (${refOf(c)})` : ""}`)]);
  for (const [k, lab] of [["name", "Företagsnamn"], ["orgnr", "Organisationsnummer"], ["kontakt", "Adress eller telefon"]]) {
    rows.push([`${lab} i offerten`, ...R.offers.map((of) => { const id = of.identity; if (!id) return "Ingen avläsning"; const st = id.essential[k]; const v = k === "kontakt" ? [id.fields.address.value, id.fields.phone.value].filter(Boolean).join(" · ") : id.fields[k].value; return `${st === "framgar" ? "Framgår" : st === "ej_lasbar" ? "Kunde inte avläsas säkert" : "Framgår inte"}${v ? ` – ${v}` : ""}`; })]);
  }
  B.push({ t: "table", cols, head, rows });
  B.push({ t: "h2", text: "Frågor att ställa till varje hantverkare" });
  for (const q of R.questions) {
    B.push({ t: "h3", text: `${q.label} (${q.questions.length} frågor)` });
    if (!q.questions.length) B.push({ t: "p", text: "Inga särskilda frågor utifrån jämförelsen." });
    for (const x of q.questions) B.push({ t: "li", text: x.text });
  }
  B.push({ t: "h2", text: "Jämförbarhet" });
  B.push({ t: "p", text: R.comparability.reasons.join(" ") });
  for (const t of rk.reasons || []) B.push({ t: "li", text: t });
  if (rk.shown && rk.basis) B.push({ t: "p", text: `Pris jämförs: ${rk.basis}.` });
  const ds = R.decisionSheet;
  if (ds.canCompareNow.length) { B.push({ t: "h3", text: "Det här går att jämföra nu" }); for (const t of ds.canCompareNow) B.push({ t: "li", text: t }); }
  if (ds.mustClarify.length) { B.push({ t: "h3", text: "Det här behöver du få klarlagt innan du väljer" }); for (const t of ds.mustClarify) B.push({ t: "li", text: t.text }); }
  if (R.differences.length) { B.push({ t: "h3", text: "Skillnader, viktigast först" }); for (const d of R.differences) B.push({ t: "li", text: d.text }); }
  const open = R.offers.filter((of) => of.open && of.open.items && of.open.items.length);
  if (open.length) { B.push({ t: "h3", text: "Uppgifter att reda ut per offert" }); for (const of of open) B.push({ t: "li", text: `${of.label}: ${of.open.items.map((i) => i.label).join(", ")}` }); }
  B.push({ t: "h2", text: "Företagens offentliga profiler" });
  const srcs = R.sourceCards || [];
  const stamp = (iso) => (iso ? String(iso).slice(0, 16).replace("T", " ") + " UTC" : "okänd tid");
  if (!srcs.length || srcs.every((c) => c.state === "ej_aktiverad")) B.push({ t: "p", text: "Företagsprofiler och omdömen visas inte i den här versionen. Offertjämförelsen ovan är komplett utan dem." });
  else {
    // Bara faktisk, kundbekräftad källstatus per offert och offentliga profillänkar. Aldrig omdömestext, betyg, antal eller Googles visning (licens/villkor).
    for (const c of srcs) {
      const of = (R.offers || []).find((x) => x.index === c.offerIndex), lab = (of && of.label) || `Offert ${c.offerIndex + 1}`;
      const f = c.firm ? [c.firm.name, c.firm.city, c.firm.domain].filter(Boolean).join(", ") : "ingen firma bekräftad";
      B.push({ t: "h3", text: `${lab}: ${f}` });
      const g = c.google || {};
      if (g.profileUrl) { B.push({ t: "li", text: `Google: kundbekräftad offentlig profil (bekräftad ${stamp(g.confirmedAt ? new Date(g.confirmedAt).toISOString() : null)}).` }); B.push({ t: "small", text: g.profileUrl }); }
      else B.push({ t: "li", text: `Google: ${g.text || "ingen bekräftad profil"}.` });
      if (c.trustpilot && c.trustpilot.state && c.trustpilot.state !== "ej_aktiverad") B.push({ t: "li", text: `Trustpilot: ${c.trustpilot.text || "okänt"}.` });
    }
    B.push({ t: "p", text: `Profillänken öppnar företagets offentliga sida hos Google. Den här PDF:en innehåller inga omdömen, betyg eller antal. Uppgifterna är kundens egen bekräftelse och gäller ${stamp(R.sourcesFrozenAt || R.createdAt)}; om du ändrar något efteråt visas det på resultatsidan, inte i den här PDF:en. Det är ingen bedömning av företaget.` });
  }
  B.push({ t: "h2", text: "Gränser och metod" });
  for (const t of R.disclaimers) B.push({ t: "li", text: t });
  B.push({ t: "h2", text: "Kvitto" });
  B.push(kv(`Ordernummer: ${rc.orderNo}`), kv(`Produkt: ${rc.product}`), kv(`Belopp: ${kr(rc.amountOre / 100)} inkl. moms`), kv(`Varav moms (${rc.vatPct} %): ${(rc.vatOre / 100).toFixed(2).replace(".", ",")} kr`), kv(`Betald: ${rc.paidAt || "—"}`), kv(`Betalningsreferens: …${rc.paymentRef || ""}`), kv(`Säljare: ${rc.seller}`));
  B.push({ t: "small", text: `${rc.vatNote} ${rc.sellerNote}` });
  void n;
  return B;
}
export function reportPdf(R) {
  return renderPdf({ title: `Din jämförelse ${R.receipt.orderNo}`, subject: "Jämförelse av offerter", author: R.receipt.seller, footer: `Jämförelse · ordernummer ${R.receipt.orderNo}`, blocks: reportBlocks(R) });
}
