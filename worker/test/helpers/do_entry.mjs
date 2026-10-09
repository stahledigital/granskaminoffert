// Modulinträde för körning i lokal workerd (Miniflare): exporterar den RIKTIGA
// QuotaCounter-klassen och går via den RIKTIGA reserve()-funktionen.
import { reserve, QuotaCounter } from "../../src/quota.js";
export { QuotaCounter };
export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    const limit = Number(u.searchParams.get("limit"));
    const res = await reserve(env, { scope: u.searchParams.get("scope") || "global", key: u.searchParams.get("key") || "global:t", limit, ttl: 60, requireAtomic: true });
    return Response.json(res);
  },
};
