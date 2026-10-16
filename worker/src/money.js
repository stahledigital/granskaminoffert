// Decimalsäker aritmetik för belopp (D19_NUMERIK_PRECISION_V2).
//
// Avlästa belopp är JSON-tal. För gränsjämförelser (ROT-andel, summor) får ingen binär float-epsilon avgöra om ett belopp
// är "inom" eller "över": 30000.01 > 30000 ska alltid vara sant och 100000.10 × 0.30 ska vara exakt 30000.03.
// Ett värde är ett exakt decimaltal { n: BigInt, e: heltal ≥ 0 } = n / 10^e, byggt ur talets kortaste exakta decimalutskrift.
// Ingen avrundning sker någonstans här. Visning (fmt) bevarar den decimalprecision som faktiskt finns.

const NBSP = " ";

function norm(n, e) {
  while (e > 0 && n % 10n === 0n) { n /= 10n; e -= 1; }
  return { n, e };
}

// number | decimalsträng -> exakt decimaltal; null för allt som inte är ett ändligt tal.
export function dec(v) {
  if (v && typeof v === "object" && typeof v.n === "bigint" && Number.isInteger(v.e)) return v;
  let s;
  if (typeof v === "number") { if (!Number.isFinite(v)) return null; s = String(v); }
  else if (typeof v === "string") s = v.trim().replace(",", ".");
  else return null;
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m) return null;
  const frac = m[3] || "";
  let e = frac.length - (m[4] ? parseInt(m[4], 10) : 0);
  let n = BigInt(m[2] + frac);
  if (m[1]) n = -n;
  if (e < 0) { n *= 10n ** BigInt(-e); e = 0; }
  return norm(n, e);
}

const scaleTo = (a, e) => a.n * 10n ** BigInt(e - a.e);

export function add(a, b) { const e = Math.max(a.e, b.e); return norm(scaleTo(a, e) + scaleTo(b, e), e); }
export function sub(a, b) { const e = Math.max(a.e, b.e); return norm(scaleTo(a, e) - scaleTo(b, e), e); }
export function mul(a, b) { return norm(a.n * b.n, a.e + b.e); }
export function cmp(a, b) { const e = Math.max(a.e, b.e); const x = scaleTo(a, e), y = scaleTo(b, e); return x < y ? -1 : x > y ? 1 : 0; }
export const eq = (a, b) => cmp(a, b) === 0;
export const lt = (a, b) => cmp(a, b) < 0;
export const gt = (a, b) => cmp(a, b) > 0;
export const isZero = (a) => a.n === 0n;
export const max = (list) => list.reduce((m, v) => (gt(v, m) ? v : m));
export const min = (list) => list.reduce((m, v) => (lt(v, m) ? v : m));
export const sum = (list) => list.reduce((s, v) => add(s, v), dec(0));
export const abs = (a) => (a.n < 0n ? { n: -a.n, e: a.e } : a);

// Närmast liggande JS-tal (bara för visning/loggning, aldrig för jämförelser).
export function toNumber(a) { return Number(a.n) / 10 ** a.e; }

// Heltalsdelen med tusentalsavgränsare (hårt mellanslag) och bevarade decimaler ("30 000,01"). Minst två decimaler när decimaler finns.
export function fmtNumber(a) {
  const neg = a.n < 0n;
  const digits = (neg ? -a.n : a.n).toString().padStart(a.e + 1, "0");
  const intPart = a.e > 0 ? digits.slice(0, digits.length - a.e) : digits;
  let frac = a.e > 0 ? digits.slice(digits.length - a.e) : "";
  if (frac.length === 1) frac += "0";
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return `${neg ? "−" : ""}${grouped}${frac ? "," + frac : ""}`;
}
export const fmtKr = (a) => `${fmtNumber(a)} kr`;
