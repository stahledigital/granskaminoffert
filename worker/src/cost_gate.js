// Gemensam kostnadsgate för ALLA modellgenerationer (D04 root-QA punkt 1).
//
// AV som standard: utan COST_GATE="1" gör denna modul ingenting och live-beteendet är oförändrat.
// PÅ: varje generation i /review och /explain måste först reservera värsta fallet i samma atomära
// CompareBudget-DO (scope "free") som betalda jämförelser (scope "paid") använder, mot ett GEMENSAMT
// månadstak och ett eget tak för gratis (COMPARE_MONTH_CAP_MICRO / COMPARE_FREE_CAP_MICRO, µUSD,
// satta av en människa). Saknat/ogiltigt tak, saknad bindning, uttömt tak, stopp (oklar användning)
// eller fel → NEKAS utan anrop. Inga standardsummor. Okänd användning behåller värsta fallet och stoppar
// nya generationer (fri och betald).

import * as budget from "./compare_budget.js";
import { computeCost } from "./models.js";

export const gateEnabled = (env) => !!env && env.COST_GATE === "1";

const posInt = (v) => {
  if (v === undefined || v === null || v === "") return NaN;
  const s = typeof v === "number" ? String(v) : v;
  return typeof s === "string" && /^[1-9][0-9]{0,15}$/.test(s) ? Number(s) : NaN;
};

export function gateCaps(env) {
  const joint = posInt(env && env.COMPARE_MONTH_CAP_MICRO), scope = posInt(env && env.COMPARE_FREE_CAP_MICRO);
  const ok = Number.isSafeInteger(joint) && Number.isSafeInteger(scope) && scope <= joint;
  return { ok, caps: ok ? { joint, scope } : null };
}

// → { ok:true, off?:true } | { ok:false, reason }
export async function gateReserve(env, { key, micro, now = new Date() }) {
  if (!gateEnabled(env)) return { ok: true, off: true };
  const c = gateCaps(env);
  if (!c.ok) return { ok: false, reason: "konfig" };
  if (!Number.isSafeInteger(micro) || micro <= 0) return { ok: false, reason: "konfig" };
  return budget.reserve(env, { key, scope: "free", orderId: null, micro, caps: c.caps, now });
}

// Avräkning mot uppmätt användning; saknas användning behålls värsta fallet och nya generationer stoppas.
export async function gateSettle(env, { key, model, usage, worstMicro }) {
  if (!gateEnabled(env)) return;
  const cost = computeCost(model, usage);
  if (cost.status === "känd" && cost.usd !== null) await budget.settle(env, { key, actual: budget.usdToMicro(cost.usd), usageKnown: true });
  else await budget.settle(env, { key, actual: worstMicro, usageKnown: false });
}
// Tidsgräns/nätverksfel: oklart om något debiterades.
export async function gateUnknown(env, { key, worstMicro }) {
  if (!gateEnabled(env)) return;
  await budget.settle(env, { key, actual: worstMicro, usageKnown: false });
}
export async function gateRelease(env, { key }) {
  if (!gateEnabled(env)) return;
  await budget.release(env, { key });
}
