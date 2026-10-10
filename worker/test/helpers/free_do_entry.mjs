// Modulinträde för lokal workerd: RIKTIG FreeBudget på RIKTIG SQLite-lagring, med en testsubklass som kan fälla skrivningar INUTI
// storage.transaction (header x-fault: "put:<nyckelprefix>" kastar vid den skrivningen; "after" kastar efter sista skrivningen).
// Används bara av free_gate_runtime.test.mjs; ingår aldrig i produktionsingången.
import { FreeBudget } from "../../src/free_budget.js";

export class FaultyFreeBudget extends FreeBudget {
  constructor(state) {
    const holder = { fault: null };
    const wrapped = {
      blockConcurrencyWhile: (fn) => state.blockConcurrencyWhile(fn),
      get storage() {
        const real = state.storage;
        return {
          transaction: (fn) => real.transaction(async (txn) => {
            const t = {
              get: (k) => txn.get(k), delete: (k) => txn.delete(k),
              put: async (k, v) => { if (holder.fault && holder.fault.startsWith("put:") && String(k).startsWith(holder.fault.slice(4))) throw new Error("injicerat fel"); return txn.put(k, v); },
            };
            const out = await fn(t);
            if (holder.fault === "after") throw new Error("injicerat fel efter skrivningar");
            return out;
          }),
        };
      },
    };
    super(wrapped);
    this.holder = holder; this.realState = state;
  }
  async fetch(request) {
    if (new URL(request.url).pathname === "/peek") return Response.json(Object.fromEntries(await this.realState.storage.list()));
    this.holder.fault = request.headers.get("x-fault");
    return super.fetch(request);
  }
}
export default {
  async fetch(request, env) {
    const stub = env.FREE_BUDGET.get(env.FREE_BUDGET.idFromName("pilot:runtime-test"));
    return stub.fetch(new Request(request.url.replace("http://localhost", "https://free-budget"), request));
  },
};
