// Fast katalog för POST /explain (S3, KOLLAR-RATTNING-20261009-01).
//
// Indata till AI-förklaringen är UTAN undantag ID:n och uppräknade statusvärden ur den här
// katalogen. Ingen fritext, ingen domän, inget företagsnamn, ingen IP, ingen kontaktuppgift,
// ingenting som kommer från den kontrollerade sajten (TXT-poster, robots.txt, meta-taggar osv.).
// Därför kan text på en kontrollerad sajt aldrig nå modellen (prompt injection stängs
// genom konstruktion, och provas i test/explain.test.mjs).
//
// AI:n får bara VÄLJA och PRIORITERA högst tre åtgärds-ID:n som är giltiga för indata. Texterna
// nedan är fasta och är det besökaren ser; modellen skriver aldrig om en status.

export const APPS = {
  agarkollen: {
    // Status = samma ord som RadStatus i Ägarkollen.
    statuses: ["bra", "titta", "info", "okand"],
    checks: ["svarar", "namnservrar", "epost", "spf", "dmarc", "dkim", "dnssec", "certifikat", "innehavare"],
    needsAction: ["titta"],
    unknown: ["okand"],
  },
  synlighetskollen: {
    // Status = samma ord som CheckStatus i Synlighetskollen.
    statuses: ["godkand", "saknas", "ej_kontrollerad", "info"],
    checks: [
      "sajt-svarar", "https", "mobil", "titel", "ort-och-tjanst", "beskrivning", "rubrik", "text-utan-js",
      "telefon", "foretagsdata", "laddtid", "ai-robotar", "hittas-pa-namn", "hittas-pa-tjanst", "google-profil",
      "ai-sokrobotar", "noindex", "ai-huvudtext", "foretagsdata-falt", "sameas-svarar", "sitemap", "llms-txt",
    ],
    needsAction: ["saknas"],
    unknown: ["ej_kontrollerad"],
  },
};

// Fasta åtgärdstexter. Nyckel = kontroll-ID. Gäller när kontrollen behöver åtgärd.
const FIX = {
  agarkollen: {
    svarar: "Be den som sköter domänen kontrollera att namnservrarna svarar och att domänen inte har gått ut.",
    namnservrar: "Kontrollera hos din domänregistrator att domänen pekar på rätt namnservrar.",
    epost: "Be den som sköter e-posten kontrollera att domänen har en e-postserver (MX) inställd om ni tar emot e-post på den.",
    spf: "Be den som sköter e-posten rätta SPF-posten så att den följer standarden och slutar med ~all eller -all.",
    dmarc: "Be den som sköter e-posten lägga in eller se över DMARC-posten, och ange en adress för rapporter om ni vill läsa dem.",
    dkim: "Be den som sköter e-posten kontrollera att e-postleverantörens DKIM-nyckel är aktiv och inte återkallad.",
    dnssec: "Fråga din domänregistrator om DNSSEC kan slås på för domänen.",
    certifikat: "Kontrollera hos den som sköter hemsidan att certifikatet är installerat och förnyas automatiskt.",
    innehavare: "Ta reda på hos din registrator eller webbyrå vem domänen är registrerad på och att du själv kommer åt kontot.",
  },
  synlighetskollen: {
    "sajt-svarar": "Kontrollera med den som sköter hemsidan att startsidan svarar utan fel.",
    https: "Be den som sköter hemsidan slå på säker anslutning (https) och skicka besökare dit automatiskt.",
    mobil: "Be den som sköter hemsidan lägga till mobilinställningen så att sidan passar små skärmar.",
    titel: "Skriv en tydlig sidtitel på 15–65 tecken som säger vad ni gör.",
    "ort-och-tjanst": "Låt titeln eller huvudrubriken nämna både tjänsten och orten där ni verkar.",
    beskrivning: "Skriv en kort beskrivning av sidan på 50–170 tecken.",
    rubrik: "Se till att startsidan har en tydlig huvudrubrik.",
    "text-utan-js": "Be den som sköter hemsidan se till att huvudtexten finns i sidan även utan skript.",
    telefon: "Lägg telefonnumret som vanlig text på startsidan.",
    foretagsdata: "Be den som sköter hemsidan lägga in företagsuppgifter som maskiner kan läsa.",
    laddtid: "Mät startsidans laddtid igen och be den som sköter hemsidan se över om den är långsam.",
    "ai-robotar": "Se över robots.txt så att sökrobotar du vill ska nå sidan inte stängs ute av misstag.",
    "hittas-pa-namn": "Se till att företagsnamnet står tydligt på startsidan och i era profiler.",
    "hittas-pa-tjanst": "Låt tjänst och ort stå i texten på startsidan så att sidan matchar vad kunder söker.",
    "google-profil": "Skapa eller bekräfta er företagsprofil hos Google och kontrollera att uppgifterna stämmer.",
    "ai-sokrobotar": "Se över robots.txt så att AI-tjänsternas sökrobotar inte stängs ute om ni vill synas där.",
    noindex: "Be den som sköter hemsidan ta bort noindex om startsidan ska kunna visas i sökresultat.",
    "ai-huvudtext": "Be den som sköter hemsidan se till att huvudtexten finns utan JavaScript.",
    "foretagsdata-falt": "Komplettera företagsuppgifterna på startsidan så att namn, ort och kontakt står i texten.",
    "sameas-svarar": "Kontrollera att länkarna till era profiler fungerar och rätta dem som inte svarar.",
    sitemap: "Överväg en sitemap och lägg en rad om den i robots.txt, särskilt om sajten är större eller ny.",
    "llms-txt": "Ingen åtgärd krävs; llms.txt har ingen belagd effekt.",
  },
};

const RECHECK = {
  agarkollen: "Kör kontrollen igen om en stund; kontrollen kunde inte avgöras den här gången.",
  synlighetskollen: "Kör kontrollen igen om en stund; kontrollen kunde inte avgöras den här gången.",
};

// Åtgärds-ID: "<app>/<kontroll>/atgarda" eller "<app>/<kontroll>/kontrollera".
export function actionId(app, check, kind) { return `${app}/${check}/${kind}`; }

// Alla giltiga åtgärder för en validerad indata (checks: [{id,status}]).
export function validActions(app, checks) {
  const a = APPS[app];
  const out = new Map();
  for (const c of checks) {
    // Manuell ägarkontroll (AK-01/02) är alltid relevant: vi ser aldrig vem som äger domänen.
    if (app === "agarkollen" && c.id === "innehavare") {
      out.set(actionId(app, c.id, "atgarda"), { id: actionId(app, c.id, "atgarda"), check: c.id, kind: "atgarda", text: FIX[app][c.id] });
      continue;
    }
    if (a.needsAction.includes(c.status)) {
      out.set(actionId(app, c.id, "atgarda"), { id: actionId(app, c.id, "atgarda"), check: c.id, kind: "atgarda", text: FIX[app][c.id] });
    } else if (a.unknown.includes(c.status)) {
      out.set(actionId(app, c.id, "kontrollera"), { id: actionId(app, c.id, "kontrollera"), check: c.id, kind: "kontrollera", text: RECHECK[app] });
    }
  }
  return out;
}

// Prioritetsordning utan AI (reservväg): åtgärd före omkontroll, sedan katalogordning.
export function deterministicActions(app, checks, max = 3) {
  const all = [...validActions(app, checks).values()];
  const order = APPS[app].checks;
  all.sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "atgarda" ? -1 : 1) || order.indexOf(x.check) - order.indexOf(y.check));
  return all.slice(0, max);
}

// Strikt validering av indata. Allt utöver app + checks[{id,status}] avvisas (additionalProperties = false),
// så att inget fritextfält kan smyga med. Returnerar { ok, app, checks } eller { ok:false, reason }.
export function parseExplainInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "form" };
  const allowedTop = new Set(["app", "checks", "turnstileToken"]);
  for (const k of Object.keys(body)) if (!allowedTop.has(k)) return { ok: false, reason: "okant_falt" };
  const app = body.app;
  if (typeof app !== "string" || !Object.prototype.hasOwnProperty.call(APPS, app)) return { ok: false, reason: "app" };
  const a = APPS[app];
  if (!Array.isArray(body.checks) || body.checks.length < 1 || body.checks.length > a.checks.length) return { ok: false, reason: "checks" };
  const seen = new Set();
  const checks = [];
  for (const c of body.checks) {
    if (!c || typeof c !== "object" || Array.isArray(c)) return { ok: false, reason: "check" };
    for (const k of Object.keys(c)) if (k !== "id" && k !== "status") return { ok: false, reason: "okant_falt" };
    if (typeof c.id !== "string" || !a.checks.includes(c.id) || seen.has(c.id)) return { ok: false, reason: "id" };
    if (typeof c.status !== "string" || !a.statuses.includes(c.status)) return { ok: false, reason: "status" };
    seen.add(c.id);
    checks.push({ id: c.id, status: c.status });
  }
  // Kanonisk ordning ger samma cache-nyckel oavsett ordning i anropet.
  checks.sort((x, y) => a.checks.indexOf(x.id) - a.checks.indexOf(y.id));
  return { ok: true, app, checks, turnstileToken: typeof body.turnstileToken === "string" ? body.turnstileToken : "" };
}
