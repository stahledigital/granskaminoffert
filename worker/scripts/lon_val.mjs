// Val av SCB-lön per yrke för update_reference.mjs (PRISUNDERLAG rev 4, 2026-09-18).
// Ren funktion utan nätverk, så att regeln går att testa (test/lon_val.test.mjs).
//
// Regler:
// - En siffra får räknas upp högst MAX_UPPRAKNING_AR år (en gammal siffra blir
//   annars en gissning som ser ut som statistik).
// - Saknas yrkets egen kod helt, eller är den för gammal, och yrket har ett
//   reservyrke med färsk nog siffra: räkna på reservyrket och märk "proxy: <namn>".
//   Plattsättare (proxy golvläggare 7122) → murare 7112.
// - Annars: stopp. Beslut tas med Moneyman, inget skrivs.

export const MAX_UPPRAKNING_AR = 1;
export const RESERV = { plattsattare: { code: "7112", name: "murare" } };

// wages: { [ssyk]: { year: "2026", monthly: 41000 } } (senaste år med värde per kod)
// senasteAr: senaste år som finns i statistiken över huvud taget
// Returnerar { ok: true, w, arBakom, proxy } eller { ok: false, reason }.
export function valjLon(trade, code, wages, senasteAr, reserv = RESERV, maxAr = MAX_UPPRAKNING_AR) {
  const alder = (w) => (w ? Math.max(0, senasteAr - Number(w.year)) : Infinity);
  const egen = wages[code];
  if (alder(egen) <= maxAr) return { ok: true, w: egen, arBakom: alder(egen), proxy: null };
  const r = reserv[trade];
  if (r && alder(wages[r.code]) <= maxAr) {
    return { ok: true, w: wages[r.code], arBakom: alder(wages[r.code]), proxy: r.name, proxyCode: r.code };
  }
  const vad = egen ? `senaste siffran för ${code} är från ${egen.year} (${alder(egen)} år gammal)` : `SCB har ingen siffra för ${code}`;
  return { ok: false, reason: `${vad}${r ? ` och reservyrket ${r.name} (${r.code}) hjälper inte` : ""}` };
}
