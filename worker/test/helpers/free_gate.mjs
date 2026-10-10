// D12: attrapp för FREE_BUDGET (kör den RIKTIGA FreeBudget-klassen, en förfrågan i taget) + giltig pilotkonfiguration för enhetstester.
import { FreeBudget } from "../../src/free_budget.js";

export function fakeFreeBudgetNamespace() {
  const objects = new Map();
  const get = (name) => {
    if (!objects.has(name)) {
      const store = new Map();
      const o = { faults: null, writes: 0 }; // faults: { put?: (key, value, txnWriteIndex) => bool, commit?: () => bool, get?: (key) => bool }
      // Riktig rollback-semantik som Cloudflares storage.transaction: skrivningar buffras och appliceras först vid commit;
      // kastar callbacken (eller commit) kastas allt bort. Fel kan injiceras per put/commit/get via o.faults.
      const state = {
        storage: {
          async get(k) { return store.get(k); },
          async put(k, v) { store.set(k, structuredClone(v)); },
          async delete(k) { store.delete(k); },
          async transaction(fn) {
            const overlay = new Map(); let idx = 0;
            const txn = {
              async get(k) { if (o.faults?.get?.(k)) throw new Error("injicerat läsfel"); return overlay.has(k) ? overlay.get(k) : store.get(k); },
              async put(k, v) { if (o.faults?.put?.(k, v, idx++)) throw new Error("injicerat skrivfel " + k); overlay.set(k, structuredClone(v)); },
              async delete(k) { overlay.set(k, undefined); },
            };
            const out = await fn(txn);
            if (o.faults?.commit?.()) throw new Error("injicerat commitfel");
            for (const [k, v] of overlay) { if (v === undefined) store.delete(k); else store.set(k, v); o.writes++; }
            return out;
          },
        },
        async blockConcurrencyWhile(fn) { return fn(); },
      };
      Object.assign(o, { obj: new FreeBudget(state), tail: Promise.resolve(), store, state }); objects.set(name, o);
    }
    return objects.get(name);
  };
  return {
    objects, idFromName: (n) => n,
    get: (id) => { const o = get(id); return { fetch: (url, init) => { const run = o.tail.then(() => o.obj.fetch(new Request(url, init))); o.tail = run.catch(() => {}); return run; } }; },
  };
}

// Giltig pilot som omfattar "nu": från igår till om 30 dygn, tak 20 USD, nytt id per anrop av gateVars() så tester inte delar pott.
let n = 0;
export function gateVars(over = {}) {
  const now = Date.now();
  return {
    FREE_BUDGET: fakeFreeBudgetNamespace(),
    FREE_PILOT_ENABLED: "1", FREE_PILOT_ID: `test-pilot-${++n}`, FREE_PILOT_CAP_MICRO: "20000000",
    FREE_PILOT_FROM: new Date(now - 86400000).toISOString().replace(/\.\d{3}Z$/, "Z"), FREE_PILOT_UNTIL: new Date(now + 30 * 86400000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    FREE_PILOT_MANDATE: "TEST-MANDAT-ENDAST-OFFLINE", ...over,
  };
}
