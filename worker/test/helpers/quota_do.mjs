// Attrapp för QUOTA-bindningen i vanliga enhetstester: kör den RIKTIGA QuotaCounter-klassen
// med ett minimalt storage-gränssnitt, en förfrågan i taget (som en objektinstans gör).
// Själva atomiciteten bevisas separat mot en riktig lokal workerd-körning
// (test/quota_runtime.test.mjs); denna attrapp används bara för att testerna ska ha en bindning.
import { QuotaCounter } from "../../src/quota.js";

export function fakeQuotaNamespace() {
  const objects = new Map();
  const get = (name) => {
    if (!objects.has(name)) {
      const store = new Map();
      const state = {
        storage: { async get(k) { return store.get(k); }, async put(k, v) { store.set(k, v); } },
        async blockConcurrencyWhile(fn) { return fn(); },
      };
      objects.set(name, { obj: new QuotaCounter(state), tail: Promise.resolve(), store });
    }
    return objects.get(name);
  };
  return {
    objects,
    idFromName: (n) => n,
    get: (id) => {
      const o = get(id);
      return {
        fetch: (url, init) => {
          const run = o.tail.then(() => o.obj.fetch(new Request(url, init)));
          o.tail = run.catch(() => {});
          return run;
        },
      };
    },
  };
}
