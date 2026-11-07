import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { migrate, SCHEMA_VERSION } from "../../src/vault/schema";

describe("vault schema compatibility", () => {
  it.each([
    ["a future version", String(SCHEMA_VERSION + 1)],
    ["a non-numeric version", "invalid"],
    ["a zero version", "0"],
    ["a negative version", "-1"],
    ["a fractional version", "1.5"],
    ["an exponent", "1e3"],
    ["an unsafe integer", "9007199254740992"],
    ["an empty version", ""],
  ])("rejects %s without altering stored data", async (_label, version) => {
    const vault = env.VAULT.get(env.VAULT.newUniqueId());
    await vault.init("owner");
    await runInDurableObject(vault, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`UPDATE profile SET name = 'Preserved' WHERE id = 1`);
      sql.exec(`UPDATE meta SET value = ? WHERE key = 'schema_version'`, version);
      let transactions = 0;
      const tx = <T>(fn: () => T): T => {
        transactions++;
        return state.storage.transactionSync(fn);
      };
      expect(() => migrate(sql, tx)).toThrow("unsupported vault schema version");
      expect(transactions).toBe(0);
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`).one().value).toBe(version);
      expect(sql.exec<{ name: string }>(`SELECT name FROM profile WHERE id = 1`).one().name).toBe("Preserved");
    });
  });

  it("rejects a missing version on an existing vault without replaying migrations", async () => {
    const vault = env.VAULT.get(env.VAULT.newUniqueId());
    await vault.init("owner");
    await runInDurableObject(vault, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`UPDATE profile SET name = 'Preserved' WHERE id = 1`);
      sql.exec(`DELETE FROM meta WHERE key = 'schema_version'`);
      expect(() => migrate(sql, (fn) => state.storage.transactionSync(fn))).toThrow("unsupported vault schema version");
      expect(sql.exec(`SELECT value FROM meta WHERE key = 'schema_version'`).toArray()).toHaveLength(0);
      expect(sql.exec<{ name: string }>(`SELECT name FROM profile WHERE id = 1`).one().name).toBe("Preserved");
    });
  });

  it("accepts the current schema without applying a migration", async () => {
    const vault = env.VAULT.get(env.VAULT.newUniqueId());
    await vault.init("owner");
    await runInDurableObject(vault, (_instance, state) => {
      let transactions = 0;
      migrate(state.storage.sql, <T>(fn: () => T): T => {
        transactions++;
        return state.storage.transactionSync(fn);
      });
      expect(transactions).toBe(0);
      expect(state.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`).one().value).toBe(String(SCHEMA_VERSION));
    });
  });
});
