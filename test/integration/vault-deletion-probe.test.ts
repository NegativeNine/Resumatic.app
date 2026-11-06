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

it("refuses to close or destroy an uninitialized vault with an unidentified table", async () => {
  const stub = env.VAULT.get(env.VAULT.newUniqueId());
  await runInDurableObject(stub, async (instance, state) => {
    const sql = state.storage.sql;
    // An empty residual table can still signal an interrupted schema or a lost
    // Workflow inventory, so a zero row count cannot authorize destruction.
    sql.exec('CREATE TABLE "workflow_dispatches" (run_id TEXT PRIMARY KEY)');
    expect(await instance.deletionProbe()).toEqual({ rows: 0 });
    await expect(instance.close()).rejects.toThrow(/vault schema is incomplete/);
    await expect(instance.destroy()).rejects.toThrow(/vault schema is incomplete/);
    sql.exec('INSERT INTO "workflow_dispatches" VALUES (?)', "unresolved");
    expect(await instance.deletionProbe()).toEqual({ rows: 1 });
    await expect(instance.close()).rejects.toThrow(/vault schema is incomplete/);
    await expect(instance.destroy()).rejects.toThrow(/vault schema is incomplete/);
    expect(sql.exec('SELECT run_id FROM "workflow_dispatches"').toArray()).toEqual([{ run_id: "unresolved" }]);
  });
});

it("still permits closing and destroying a genuinely empty uninitialized vault", async () => {
  const stub = env.VAULT.get(env.VAULT.newUniqueId());
  await runInDurableObject(stub, async (instance) => {
    expect(await instance.close()).toEqual({ distill: [], tailor: [] });
    await expect(instance.destroy()).resolves.toBeUndefined();
    expect(await instance.deletionProbe()).toEqual({ rows: 0 });
  });
});
