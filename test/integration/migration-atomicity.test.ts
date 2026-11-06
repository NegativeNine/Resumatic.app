import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DIRECTORY_MIGRATIONS, migrateDirectory } from "../../src/directory/schema";
import { MIGRATIONS, migrate, SCHEMA_VERSION } from "../../src/vault/schema";

/** Interrupt a migration after its first DDL statement has executed. */
function failAtTrigger(sql: SqlStorage, trigger: string): SqlStorage {
  return new Proxy(sql, {
    get(target, key) {
      if (key === "exec")
        return (query: string, ...bindings: SqlStorageValue[]) => {
          if (query.includes(`CREATE TRIGGER ${trigger}`))
            throw new Error("synthetic migration interruption");
          return target.exec(query, ...bindings);
        };
      return Reflect.get(target, key, target);
    },
  });
}

/** Interrupt after a migration's DDL but before its version is persisted. */
function failAtVersion(sql: SqlStorage, version: number): SqlStorage {
  return new Proxy(sql, {
    get(target, key) {
      if (key === "exec") return (query: string, ...bindings: SqlStorageValue[]) => {
        if (query.includes("INSERT INTO meta (key, value)") && bindings[0] === String(version))
          throw new Error("synthetic version-write interruption");
        return target.exec(query, ...bindings);
      };
      return Reflect.get(target, key, target);
    },
  });
}

function priorVersion(fragment: string): number {
  const index = MIGRATIONS.findIndex((migration) => migration.some((statement) => statement.includes(fragment)));
  if (index < 1) throw new Error(`missing migration: ${fragment}`);
  return index;
}

function removeGlobalAuthMigration(sql: SqlStorage): void {
  for (const trigger of ["global_auth_delete_epoch", "global_auth_identity_insert", "global_auth_identity_delete", "global_auth_home_insert", "global_auth_home_bind"]) sql.exec(`DROP TRIGGER ${trigger}`);
  sql.exec(`DROP TABLE global_auth_marker`);
}

describe("atomic schema migrations", () => {
  it("atomically installs the global authentication guard with its schema version", async () => {
    const stub = env.DIRECTORY.getByName(`auth-migration-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      removeGlobalAuthMigration(sql);
      const previous = DIRECTORY_MIGRATIONS.findIndex((migration) => migration.some((sql) => sql.includes("CREATE TABLE global_auth_marker")));
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      const tx = <T>(fn: () => T): T => state.storage.transactionSync(fn);
      expect(() => migrateDirectory(failAtVersion(sql, previous + 1), tx, true)).toThrow(/synthetic version-write interruption/);
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE name='global_auth_marker'`).toArray()).toHaveLength(0);
      expect(sql.exec(`SELECT key FROM meta WHERE key IN ('global_auth_guard','global_auth_epoch')`).toArray()).toHaveLength(0);
      migrateDirectory(sql, tx, true);
      expect(sql.exec(`SELECT key FROM meta WHERE key IN ('global_auth_guard','global_auth_epoch')`).toArray()).toHaveLength(2);
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE name='global_auth_marker'`).toArray()).toHaveLength(1);
    });
  });


  it("rolls back the Directory column and version together, then retries", async () => {
    const stub = env.DIRECTORY.getByName(`migration-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      removeGlobalAuthMigration(sql);
      for (const table of ["placement_attempts", "placement_receipts", "placement_identities", "placement_finalizations", "placement_releases"]) sql.exec(`DROP TABLE ${table}`);
      sql.exec(`ALTER TABLE identity_homes DROP COLUMN generation`);
      sql.exec(`ALTER TABLE identity_homes DROP COLUMN placement_state`);
      sql.exec(`DROP TRIGGER guard_sticky_vault_initializations`);
      sql.exec(`ALTER TABLE vault_initializations DROP COLUMN sticky`);
      sql.exec(`ALTER TABLE vaults DROP COLUMN stripe_checkout_sessions`);
      const previous = DIRECTORY_MIGRATIONS.findIndex((migration) => migration.some((statement) => statement.includes("ALTER TABLE vault_initializations ADD COLUMN sticky")));
      expect(previous).toBeGreaterThan(0);
      sql.exec(`UPDATE meta SET value = ? WHERE key = 'schema_version'`, String(previous));
      const tx = <T>(fn: () => T): T => state.storage.transactionSync(fn);
      expect(() => migrateDirectory(failAtTrigger(sql, "guard_sticky_vault_initializations"), tx)).toThrow(/synthetic migration interruption/);
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`).one().value).toBe(String(previous));
      expect(() => sql.exec(`SELECT sticky FROM vault_initializations`).toArray()).toThrow();
      migrateDirectory(sql, tx);
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`).one().value).toBe(String(DIRECTORY_MIGRATIONS.length));
      expect(() => sql.exec(`SELECT sticky FROM vault_initializations`).toArray()).not.toThrow();
    });
  });

  it("rolls back placement tables and version together while preserving existing homes", async () => {
    const stub = env.DIRECTORY.getByName(`placement-migration-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      removeGlobalAuthMigration(sql);
      sql.exec(`INSERT INTO identity_homes(provider,subject,shard,user_id) VALUES ('test','legacy',NULL,'legacy-user')`);
      for (const table of ["placement_attempts", "placement_receipts", "placement_identities", "placement_finalizations", "placement_releases"]) sql.exec(`DROP TABLE ${table}`);
      sql.exec(`ALTER TABLE identity_homes DROP COLUMN generation`);
      sql.exec(`ALTER TABLE identity_homes DROP COLUMN placement_state`);
      const previous = DIRECTORY_MIGRATIONS.findIndex((migration) => migration.some((statement) => statement.includes("CREATE TABLE placement_attempts")));
      expect(previous).toBeGreaterThan(0);
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      const tx = <T>(fn: () => T): T => state.storage.transactionSync(fn);
      expect(() => migrateDirectory(failAtVersion(sql, previous + 1), tx)).toThrow(/synthetic version-write interruption/);
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='placement_attempts'`).toArray()).toHaveLength(0);
      expect(sql.exec<{ user_id: string }>(`SELECT user_id FROM identity_homes WHERE subject='legacy'`).one().user_id).toBe("legacy-user");
      migrateDirectory(sql, tx);
      expect(sql.exec<{ generation: string | null }>(`SELECT generation FROM identity_homes WHERE subject='legacy'`).one().generation).toBeNull();
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='placement_attempts'`).toArray()).toHaveLength(1);
    });
  });

  it("rolls back the Vault table and version together, then retries", async () => {
    const stub = env.VAULT.get(env.VAULT.newUniqueId());
    await stub.init("migration-owner");
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`DROP TABLE r2_cache_dispatches`);
      sql.exec(`DROP TRIGGER keep_uncertain_dispatch`);
      sql.exec(`DROP TABLE workflow_redispatches`);
      sql.exec(`DROP TRIGGER clear_unknown_end_start`);
      sql.exec(`ALTER TABLE roles DROP COLUMN unknown_end_start_date`);
      sql.exec(`ALTER TABLE facts DROP COLUMN level_revision`);
      const previous = priorVersion("CREATE TABLE workflow_redispatches");
      sql.exec(`UPDATE meta SET value = ? WHERE key = 'schema_version'`, String(previous));
      const tx = <T>(fn: () => T): T => state.storage.transactionSync(fn);
      expect(() => migrate(failAtTrigger(sql, "keep_uncertain_dispatch"), tx)).toThrow(/synthetic migration interruption/);
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`).one().value).toBe(String(previous));
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_redispatches'`).toArray()).toHaveLength(0);
      migrate(sql, tx);
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`).one().value).toBe(String(SCHEMA_VERSION));
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_redispatches'`).toArray()).toHaveLength(1);
    });
  });

  it("rolls back the unknown-end role date column and version together, then retries", async () => {
    const stub = env.VAULT.get(env.VAULT.newUniqueId());
    await stub.init("migration-owner");
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`DROP TABLE r2_cache_dispatches`);
      sql.exec(`DROP TRIGGER clear_unknown_end_start`);
      sql.exec(`ALTER TABLE roles DROP COLUMN unknown_end_start_date`);
      sql.exec(`ALTER TABLE facts DROP COLUMN level_revision`);
      const previous = priorVersion("ALTER TABLE roles ADD COLUMN unknown_end_start_date");
      sql.exec(`UPDATE meta SET value = ? WHERE key = 'schema_version'`, String(previous));
      const tx = <T>(fn: () => T): T => state.storage.transactionSync(fn);
      expect(() => migrate(failAtTrigger(sql, "clear_unknown_end_start"), tx)).toThrow(/synthetic migration interruption/);
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`).one().value).toBe(String(previous));
      expect(() => sql.exec(`SELECT unknown_end_start_date FROM roles`).toArray()).toThrow();
      migrate(sql, tx);
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`).one().value).toBe(String(SCHEMA_VERSION));
      expect(() => sql.exec(`SELECT unknown_end_start_date FROM roles`).toArray()).not.toThrow();
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'clear_unknown_end_start'`).toArray()).toHaveLength(1);
    });
  });

  it("rolls back the cache fence table if recording its migration version fails", async () => {
    const stub = env.VAULT.get(env.VAULT.newUniqueId());
    await stub.init("migration-owner");
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`UPDATE profile SET name='preserved' WHERE id=1`);
      sql.exec(`DROP TABLE r2_cache_dispatches`);
      const previous = priorVersion("CREATE TABLE r2_cache_dispatches");
      sql.exec(`UPDATE meta SET value = ? WHERE key = 'schema_version'`, String(previous));
      const tx = <T>(fn: () => T): T => state.storage.transactionSync(fn);
      expect(() => migrate(failAtVersion(sql, previous + 1), tx)).toThrow(/synthetic version-write interruption/);
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`).one().value).toBe(String(previous));
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='r2_cache_dispatches'`).toArray()).toHaveLength(0);
      expect(sql.exec<{ name: string }>(`SELECT name FROM profile WHERE id=1`).one().name).toBe("preserved");
      migrate(sql, tx);
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`).one().value).toBe(String(SCHEMA_VERSION));
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='r2_cache_dispatches'`).toArray()).toHaveLength(1);
      expect(sql.exec<{ name: string }>(`SELECT name FROM profile WHERE id=1`).one().name).toBe("preserved");
    });
  });

  it("keeps legacy unresolved cache markers when adding correlation digests", async () => {
    const stub = env.VAULT.get(env.VAULT.newUniqueId());
    await stub.init("migration-owner");
    const attemptId = crypto.randomUUID();
    await stub.beginCacheWrite({ userId: "migration-owner", gen: 1 }, attemptId, "pdf");
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`ALTER TABLE r2_cache_dispatches DROP COLUMN key_digest`);
      const previous = priorVersion("ALTER TABLE r2_cache_dispatches ADD COLUMN key_digest");
      sql.exec(`UPDATE meta SET value = ? WHERE key = 'schema_version'`, String(previous));
      migrate(sql, <T>(fn: () => T) => state.storage.transactionSync(fn));
      expect(sql.exec<{ attempt_id: string; key_digest: string | null }>(`SELECT attempt_id,key_digest FROM r2_cache_dispatches`).one()).toEqual({ attempt_id: attemptId, key_digest: null });
    });
    expect(await stub.cacheWriteFences()).toMatchObject({ status: "available", total: 1, attempts: [{ id: attemptId, keyDigest: null }] });
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.close()).rejects.toThrow("export cache write is unresolved");
    });
  });
});
