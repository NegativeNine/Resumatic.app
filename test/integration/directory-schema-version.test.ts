import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DIRECTORY_MIGRATIONS, migrateDirectory } from "../../src/directory/schema";

describe("Directory schema version compatibility", () => {
  it("refuses future and malformed persisted versions without changing stored state", async () => {
    const stub = env.DIRECTORY.getByName("global");
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      const original = sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`).one().value;
      const count = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'`).one().n;
      try {
        for (const version of [String(DIRECTORY_MIGRATIONS.length + 1), "-1", "01", "1e2", "NaN", "3.5", "9007199254740992"]) {
          sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, version);
          expect(() => migrateDirectory(sql, (fn) => state.storage.transactionSync(fn), true, false), version)
            .toThrow("directory schema requires a compatible version");
          expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(version);
          expect(sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'`).one().n).toBe(count);
        }
      } finally {
        sql.exec(`INSERT INTO meta(key,value) VALUES ('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, original);
      }
    });
  });
});
