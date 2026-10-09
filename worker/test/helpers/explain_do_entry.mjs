// Modulinträde för lokal workerd: den RIKTIGA ExplainBudget och reserveBudget/settleBudget/releaseBudget.
import { reserveBudget, settleBudget, releaseBudget, ExplainBudget } from "../../src/explain_budget.js";
export { ExplainBudget };
export default {
  async fetch(request, env) {
    const u = new URL(request.url); const q = (k) => u.searchParams.get(k);
    const base = { month: "2026-10", day: q("day") || "2026-10-10", ipKey: q("ip") || "aaaaaaaaaaaaaaaa", micro: Number(q("micro") || 0) };
    if (u.pathname === "/settle") return Response.json({ ok: await settleBudget(env, { month: base.month, micro: base.micro, actual: Number(q("actual")) }) });
    if (u.pathname === "/release") return Response.json({ ok: await releaseBudget(env, base) });
    return Response.json(await reserveBudget(env, { ...base, capMicro: Number(q("cap")), dayLimit: Number(q("dayLimit") || 100), ipLimit: Number(q("ipLimit") || 5) }));
  },
};
