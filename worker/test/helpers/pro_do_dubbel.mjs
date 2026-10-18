// KONTO-SYNK K1: dubbel för SQLite-backade Durable Objects i Node (node:sqlite), så att de RIKTIGA klasserna ProRegister/ProKonto
// kan provas utan workerd. Samma yta som klasserna använder: storage.sql.exec(q, ...args) → markör med toArray(), och
// storage.transactionSync(fn) (allt eller inget). Varje objekt-id får en egen databas. Detta är inte workerd: hela kedjan provas
// dessutom i Miniflare (pro_konto_runtime.test.mjs).
import { DatabaseSync } from "node:sqlite";

export function sqlState() {
  const db = new DatabaseSync(":memory:");
  let djup = 0;
  const sql = {
    exec(q, ...args) {
      const st = db.prepare(q);
      const lasande = /^\s*(SELECT|WITH)\b/i.test(q) || /\bRETURNING\b/i.test(q);
      const rows = lasande ? st.all(...args).map((r) => ({ ...r })) : (st.run(...args), []);
      return { toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error("one: " + rows.length); return rows[0]; } };
    },
  };
  const storage = {
    sql,
    // K2: deleteAll tar bort ALL lagring (alla tabeller), som i SQLite-backade DO.
    async deleteAll() { for (const { name } of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all()) db.exec(`DROP TABLE "${name}"`); },
    transactionSync(fn) {
      if (djup > 0) return fn();
      db.exec("BEGIN"); djup++;
      try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } finally { djup--; }
    },
  };
  return { storage, db };
}

// Namnrymd som env.X: idFromName, get(id).fetch(url, init). Instanser lever per namn (som en riktig DO).
export function namnrymd(Klass, env = {}, { prefix = "", delad = null } = {}) {
  const inst = delad ? delad.inst : new Map(), anrop = delad ? delad.anrop : [], jur = delad ? delad.jur : [];
  return {
    inst, anrop, jur,
    idFromName: (n) => ({ toString: () => "id:" + prefix + n, namn: prefix + String(n) }),
    // K2 A4: jurisdiction("eu") ger en subnamnrymd med egna id:n (samma namn → annat objekt), som i Cloudflare.
    jurisdiction(j) { jur.push(j); return namnrymd(Klass, env, { prefix: j + "|", delad: { inst, anrop, jur } }); },
    get(id) {
      const n = id.namn;
      if (!inst.has(n)) inst.set(n, new Klass(sqlState(), env));
      return { fetch: async (url, init) => { anrop.push({ namn: n, url: String(url) }); return inst.get(n).fetch(new Request(url, init)); } };
    },
  };
}
