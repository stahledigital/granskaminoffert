// Rapportens sista steg: ett (valfritt) begränsat modellanrop som bara ORDNAR slutna skillnads-ID,
// samt sammanställningen av den slutliga rapporten och kvittot.
//
// Synteskravet är litet med flit: modellen får inga offerttexter, inga belopp och inga namn, bara en
// lista med skillnads-ID och kategorier, och svarar bara med ID i prioritetsordning. All synlig text
// är fast text från compare_engine.js. Misslyckas steget (fel, budget) används den deterministiska
// ordningen och rapporten levereras ändå – kunden betalar inte för ett modellsteg som saknas.

import { buildAnthropicRequest } from "./models.js";
import { scrubForbidden } from "./rules.js";
import { OFFER, COMPARE_VERSION, vatPart } from "./compare_config.js";
import { EXTRACT_VERSION } from "./compare_extract.js";

export const SYNTH_VERSION = "ordning-1";
export const MAX_PRIORITY = 8;

export function synthSystemPrompt() {
  return `Du ordnar en lista med skillnads-ID från en jämförelse av hantverkaroffertar efter vad en privatperson bör få klarlagt först innan hen skriver på. Du får bara ID och kategori – inga belopp, inga namn och ingen offerttext – och du bedömer varken företag, kvalitet eller pris. Svara genom att anropa verktyget submit_priority med högst ${MAX_PRIORITY} ID i prioritetsordning (viktigast först), valda ur den givna listan. Skriv ingen annan text.`;
}

export function buildSynthRequest({ model, differences }) {
  const ids = differences.map((d) => d.id);
  const tool = {
    name: "submit_priority",
    description: "Lämna in skillnads-ID i prioritetsordning.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["priority_ids"],
      properties: { priority_ids: { type: "array", maxItems: MAX_PRIORITY, items: { type: "string", enum: ids } } },
    },
  };
  const list = differences.map((d) => `${d.id} (${d.category})`).join("\n");
  const userContent = [{ type: "text", text: `Skillnader att ordna:\n${list}` }];
  return buildAnthropicRequest({ model, system: synthSystemPrompt(), userContent, tool });
}

export function readPriority(resp, differences) {
  if (!resp || typeof resp !== "object") throw new Error("Modellsvaret saknas");
  if (resp.stop_reason === "max_tokens" || resp.stop_reason === "refusal") throw new Error("Modellsvaret kan inte användas");
  const tu = (resp.content || []).find((b) => b && b.type === "tool_use" && b.name === "submit_priority");
  if (!tu || !tu.input || typeof tu.input !== "object") throw new Error("Inget submit_priority-anrop");
  const keys = Object.keys(tu.input);
  if (keys.length !== 1 || keys[0] !== "priority_ids" || !Array.isArray(tu.input.priority_ids)) throw new Error("Oväntat svar");
  const valid = new Set(differences.map((d) => d.id));
  const out = [];
  for (const id of tu.input.priority_ids) {
    if (typeof id !== "string" || !valid.has(id)) throw new Error("Okänt ID");
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > MAX_PRIORITY) throw new Error("För många ID");
  return out;
}

// Ordnar skillnaderna: modellens ID först (i given ordning), därefter resten i fast ordning.
export function applyPriority(differences, ids) {
  if (!ids || !ids.length) return { list: differences, source: "fast" };
  const byId = new Map(differences.map((d) => [d.id, d]));
  const first = ids.map((id) => byId.get(id)).filter(Boolean);
  const rest = differences.filter((d) => !ids.includes(d.id));
  return { list: [...first, ...rest], source: "ai" };
}

// Kvitto-underlag. Moms enligt kalkylantagande (25 %). Stripes eget kvitto skickas separat av Stripe
// om e-post lämnats och kvitton är påslagna i Stripe-kontot (kontosteg, inte verifierat här).
export function buildReceipt(order) {
  return {
    orderNo: order.id.slice(2, 10).toUpperCase(),
    product: `${OFFER.product} (${order.docCount} offerter)`,
    amountOre: OFFER.priceOre,
    currency: OFFER.currency,
    vatOre: vatPart(OFFER.priceOre),
    vatPct: OFFER.vatPct,
    vatNote: "Momsen är räknad som 25 % ur beloppet inklusive moms.",
    paidAt: order.paidAt ? new Date(order.paidAt).toISOString() : null,
    paymentRef: order.stripe && order.stripe.paymentIntentId ? order.stripe.paymentIntentId.slice(-8) : null,
    seller: "Ståhle Digital",
    sellerNote: "Organisationsnummer och momsregistreringsnummer anges av kommersiella spåret före skarp start.",
  };
}

export const DISCLAIMERS = Object.freeze([
  "Jämförelsen gäller bara vad som står i dokumenten du laddade upp. Den säger inget om hur arbetet utförs, om kvaliteten eller om hantverkaren.",
  "Det som inte framgår av en offert är inte detsamma som att det saknas. Fråga hantverkaren.",
  "Beloppen är avlästa ur dokumenten och kan innehålla avläsningsfel, särskilt i foton. Kontrollera mot originalet.",
  "Detta är inte juridisk rådgivning.",
]);

export function assembleReport({ order, labels, compared, priority, now = Date.now() }) {
  const pr = applyPriority(compared.differences, priority);
  const report = {
    version: COMPARE_VERSION,
    extractVersion: EXTRACT_VERSION,
    synthVersion: priority && priority.length ? SYNTH_VERSION : null,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + OFFER.retentionHours * 3600_000).toISOString(),
    count: compared.count,
    offers: compared.offers.map((o) => ({ index: o.index, label: o.label, readability: o.readability, instructionsInDocument: o.instructionsInDocument, project: o.project, price: o.price, facts: o.facts, issues: o.issues })),
    comparability: compared.comparability,
    ranking: compared.ranking,
    scopeMatrix: compared.scopeMatrix,
    differences: pr.list,
    prioritySource: pr.source,
    decisionSheet: {
      canCompareNow: compared.decisionSheet.canCompareNow,
      mustClarify: (() => {
        const order = pr.list.map((d) => d.id);
        return [...compared.decisionSheet.mustClarify].sort((a, b) => {
          const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
          return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
        });
      })(),
    },
    questions: compared.questions,
    sourceCards: compared.offers.map((o) => ({ offerIndex: o.index, state: "ej_aktiverad" })),
    receipt: buildReceipt(order),
    disclaimers: DISCLAIMERS,
  };
  // Hårda ordspärren gäller allt vi själva skriver, inte dokumentreferenserna (som är citat).
  report.differences = scrubForbidden(report.differences);
  report.decisionSheet = scrubForbidden(report.decisionSheet);
  report.questions = scrubForbidden(report.questions);
  report.ranking = scrubForbidden(report.ranking);
  report.comparability = scrubForbidden(report.comparability);
  report.offers = report.offers.map((o) => ({ ...o, label: scrubForbidden(o.label) }));
  return report;
}
