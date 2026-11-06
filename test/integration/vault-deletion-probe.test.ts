import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

it("counts residual rows even without an initialized vault or known table names", async () => {
  const stub = env.VAULT.get(env.VAULT.newUniqueId());
  await runInDurableObject(stub, async (instance, state) => {
    const sql = state.storage.sql;
    expect(await instance.deletionProbe()).toEqual({ rows: 0 });
    // Model a partial initialization, interrupted erasure, or future migration.
    sql.exec('CREATE TABLE "residual_2" (value TEXT)');
    sql.exec('CREATE TABLE "odd""name" (value TEXT)');
    sql.exec('CREATE TABLE "sqlite1audit" (value TEXT)');
    sql.exec('INSERT INTO "residual_2" VALUES (?)', "sensitive");
    sql.exec('INSERT INTO "odd""name" VALUES (?)', "sensitive");
    sql.exec('INSERT INTO "sqlite1audit" VALUES (?)', "sensitive");
    expect(await instance.deletionProbe()).toEqual({ rows: 3 });
    sql.exec('DELETE FROM "residual_2"');
    sql.exec('DELETE FROM "odd""name"');
    sql.exec('DELETE FROM "sqlite1audit"');
    expect(await instance.deletionProbe()).toEqual({ rows: 0 });
  });
});
