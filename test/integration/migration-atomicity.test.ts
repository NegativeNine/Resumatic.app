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

function removeShardReleaseMigration(sql: SqlStorage): void {
  sql.exec(`DROP TABLE billing_delivery_retries`);
  sql.exec(`DROP INDEX billing_pending_by_time`);
  sql.exec(`ALTER TABLE billing_events DROP COLUMN next_attempt_at`);
  for (const trigger of ["guard_shard_google_identity_delete", "guard_global_google_shard_home_delete"]) sql.exec(`DROP TRIGGER ${trigger}`);
  for (const table of ["shard_deletion_releases", "shard_identity_delete_marker", "global_shard_home_release_marker"]) sql.exec(`DROP TABLE ${table}`);
  sql.exec(`DELETE FROM meta WHERE key='shard_deletion_guard'`);
}

function removeGlobalAuthMigration(sql: SqlStorage): void {
  removeShardReleaseMigration(sql);
  for (const trigger of ["global_auth_delete_epoch", "global_auth_identity_insert", "global_auth_identity_delete", "global_auth_home_insert", "global_auth_home_bind"]) sql.exec(`DROP TRIGGER ${trigger}`);
  sql.exec(`DROP TABLE global_auth_marker`);
}

describe("atomic schema migrations", () => {
  it("rolls back billing delivery retry storage and its version together", async () => {
    const stub = env.DIRECTORY.getByName(`billing-delivery-migration-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO billing_accounts(user_id,customer_id,revision,delivered_revision) VALUES ('u1','cus_1',2,1)`);
      sql.exec(`DROP TABLE billing_delivery_retries`);
      const previous = DIRECTORY_MIGRATIONS.findIndex((migration) => migration.some((q) => q.includes("CREATE TABLE billing_delivery_retries")));
      expect(previous).toBeGreaterThan(0);
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      const tx = <T>(fn: () => T): T => state.storage.transactionSync(fn);
      expect(() => migrateDirectory(failAtVersion(sql, previous + 1), tx)).toThrow(/synthetic version-write interruption/);
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE name='billing_delivery_retries'`).toArray()).toHaveLength(0);
      expect(sql.exec<{value:string}>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(previous));
      expect(sql.exec<{revision:number}>(`SELECT revision FROM billing_accounts WHERE user_id='u1'`).one().revision).toBe(2);
      migrateDirectory(sql, tx);
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE name='billing_delivery_retries'`).toArray()).toHaveLength(1);
      expect(sql.exec<{value:string}>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(DIRECTORY_MIGRATIONS.length));
    });
  });
  it("rolls back the deferred billing column, index and version together, then preserves queued events on retry", async () => {
    const stub = env.DIRECTORY.getByName(`billing-migration-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO billing_events(id,customer_id,state,created_at) VALUES ('evt_legacy','cus_legacy','pending',123)`);
      sql.exec(`DROP TABLE billing_delivery_retries`);
      sql.exec(`DROP INDEX billing_pending_by_time`);
      sql.exec(`ALTER TABLE billing_events DROP COLUMN next_attempt_at`);
      const previous = DIRECTORY_MIGRATIONS.findIndex((migration) => migration.some((q) => q.includes("ALTER TABLE billing_events ADD COLUMN next_attempt_at")));
      expect(previous).toBeGreaterThan(0);
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      const tx = <T>(fn: () => T): T => state.storage.transactionSync(fn);
      expect(() => migrateDirectory(failAtVersion(sql, previous + 1), tx)).toThrow(/synthetic version-write interruption/);
      expect(sql.exec<{value:string}>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(previous));
      expect(() => sql.exec(`SELECT next_attempt_at FROM billing_events`).toArray()).toThrow();
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE type='index' AND name='billing_pending_by_time'`).toArray()).toHaveLength(0);
      expect(sql.exec<{id:string}>(`SELECT id FROM billing_events`).one().id).toBe("evt_legacy");
      migrateDirectory(sql, tx);
      expect(sql.exec<{value:string}>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(DIRECTORY_MIGRATIONS.length));
      expect(sql.exec<{id:string;next_attempt_at:number}>(`SELECT id,next_attempt_at FROM billing_events`).one()).toEqual({ id: "evt_legacy", next_attempt_at: 0 });
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE type='index' AND name='billing_pending_by_time'`).toArray()).toHaveLength(1);
    });
  });
  it.each(["global", "shard"] as const)("installs the %s shard-release guard atomically with its version", async (mode) => {
    const stub = env.DIRECTORY.getByName(`release-migration-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      removeShardReleaseMigration(sql);
      if (mode === "global") {
        sql.exec(`INSERT INTO meta(key,value) VALUES ('global_auth_guard','1')`);
        sql.exec(`INSERT INTO meta(key,value) VALUES ('global_auth_epoch','0')`);
      }
      const previous = DIRECTORY_MIGRATIONS.findIndex((migration) => migration.some((q) => q.includes("CREATE TABLE shard_deletion_releases")));
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      const tx = <T>(fn: () => T): T => state.storage.transactionSync(fn);
      expect(() => migrateDirectory(failAtVersion(sql, previous + 1), tx, mode === "global", mode === "shard")).toThrow(/synthetic version-write interruption/);
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE name='shard_deletion_releases'`).toArray()).toHaveLength(0);
      expect(sql.exec(`SELECT key FROM meta WHERE key='shard_deletion_guard'`).toArray()).toHaveLength(0);
      migrateDirectory(sql, tx, mode === "global", mode === "shard");
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE name='guard_global_google_shard_home_delete'`).toArray()).toHaveLength(1);
      expect(sql.exec(`SELECT key FROM meta WHERE key='shard_deletion_guard'`).toArray()).toHaveLength(mode === "shard" ? 1 : 0);
      expect(sql.exec<{value:string}>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(DIRECTORY_MIGRATIONS.length));
    });
  });
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
      sql.exec(`DROP TABLE application_create_requests`);
      sql.exec(`DROP TABLE role_create_requests`);
      sql.exec(`DROP TABLE fact_create_requests`);
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
      sql.exec(`DROP TABLE application_create_requests`);
      sql.exec(`DROP TABLE role_create_requests`);
      sql.exec(`DROP TABLE fact_create_requests`);
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
      sql.exec(`DROP TABLE application_create_requests`);
      sql.exec(`DROP TABLE role_create_requests`);
      sql.exec(`DROP TABLE fact_create_requests`);
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
      sql.exec(`DROP TABLE application_create_requests`);
      sql.exec(`DROP TABLE role_create_requests`);
      sql.exec(`DROP TABLE fact_create_requests`);
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

  it("rolls back the manual fact receipt table and version together, then retries", async () => {
    const stub = env.VAULT.get(env.VAULT.newUniqueId());
    await stub.init("migration-owner");
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`UPDATE profile SET name='preserved' WHERE id=1`);
      sql.exec(`DROP TABLE application_create_requests`);
      sql.exec(`DROP TABLE role_create_requests`);
      sql.exec(`DROP TABLE fact_create_requests`);
      const previous = priorVersion("CREATE TABLE fact_create_requests");
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      const tx = <T>(fn: () => T): T => state.storage.transactionSync(fn);
      expect(() => migrate(failAtVersion(sql, previous + 1), tx)).toThrow(/synthetic version-write interruption/);
      expect(sql.exec<{value: string}>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(previous));
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='fact_create_requests'`).toArray()).toHaveLength(0);
      expect(sql.exec<{name: string}>(`SELECT name FROM profile WHERE id=1`).one().name).toBe("preserved");
      migrate(sql, tx);
      expect(sql.exec<{value: string}>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(SCHEMA_VERSION));
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='fact_create_requests'`).toArray()).toHaveLength(1);
    });
  });

  it("rolls back the manual role receipt table and version together, then retries", async () => {
    const stub = env.VAULT.get(env.VAULT.newUniqueId());
    await stub.init("migration-owner");
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`UPDATE profile SET name='preserved' WHERE id=1`);
      sql.exec(`DROP TABLE application_create_requests`);
      sql.exec(`DROP TABLE role_create_requests`);
      const previous = priorVersion("CREATE TABLE role_create_requests");
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      const tx = <T>(fn: () => T): T => state.storage.transactionSync(fn);
      expect(() => migrate(failAtVersion(sql, previous + 1), tx)).toThrow(/synthetic version-write interruption/);
      expect(sql.exec<{value: string}>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(previous));
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='role_create_requests'`).toArray()).toHaveLength(0);
      expect(sql.exec<{name: string}>(`SELECT name FROM profile WHERE id=1`).one().name).toBe("preserved");
      migrate(sql, tx);
      expect(sql.exec<{value: string}>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(SCHEMA_VERSION));
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='role_create_requests'`).toArray()).toHaveLength(1);
    });
  });
  it("rolls back the job receipt table and version together, then retries", async () => {
    const stub = env.VAULT.get(env.VAULT.newUniqueId());
    await stub.init("migration-owner");
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`UPDATE profile SET name='preserved' WHERE id=1`);
      sql.exec(`DROP TABLE application_create_requests`);
      const previous = priorVersion("CREATE TABLE application_create_requests");
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      const tx = <T>(fn: () => T): T => state.storage.transactionSync(fn);
      expect(() => migrate(failAtVersion(sql, previous + 1), tx)).toThrow(/synthetic version-write interruption/);
      expect(sql.exec<{value: string}>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(previous));
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='application_create_requests'`).toArray()).toHaveLength(0);
      expect(sql.exec<{name: string}>(`SELECT name FROM profile WHERE id=1`).one().name).toBe("preserved");
      migrate(sql, tx);
      expect(sql.exec<{value: string}>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(SCHEMA_VERSION));
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='application_create_requests'`).toArray()).toHaveLength(1);
    });
  });
});
