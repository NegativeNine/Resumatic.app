import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DIRECTORY_MIGRATIONS, migrateDirectory } from "../../src/directory/schema";
import { MIGRATIONS, migrate, SCHEMA_VERSION } from "../../src/vault/schema";
import { undoInviteCoordinatorMigration, undoInviteCoordinatorTargetMigration, undoInviteInventoryMigrations, undoInviteTargetSealMigration, undoShardInviteBindingMigration } from "../support/undo-invite-inventory";

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

/** Restore the schema state before the later export-cache migration. */
function removeExportCacheMigration(sql: SqlStorage): void {
  sql.exec(`DROP TRIGGER clear_source_write_link`);
  sql.exec(`DROP TABLE source_write_links`);
  sql.exec(`DROP TABLE export_cache_chunks`);
  sql.exec(`DROP TABLE export_cache`);
}

function removeInviteDeletionMigration(sql: SqlStorage): void {
  undoInviteInventoryMigrations(sql);
  sql.exec(`DROP TRIGGER guard_account_finalization`);
  sql.exec(`ALTER TABLE account_final_sweeps DROP COLUMN invite_closed`);
  for (const trigger of ["assign_invite_generation", "rotate_reissued_invite", "guard_invite_delete"])
    sql.exec(`DROP TRIGGER ${trigger}`);
  sql.exec(`DROP TRIGGER guard_invite_delete_permit`);
  sql.exec(`DROP TRIGGER guard_invite_delete_authorization_v2`);
  sql.exec(`DROP TABLE invite_delete_authorizations_v2`);
  sql.exec(`DROP TRIGGER remove_account_invite_binding`);
  sql.exec(`DROP TABLE account_invite_bindings`);
  sql.exec(`DROP TABLE invite_delete_authorizations`);
  for (const table of ["invite_delete_permits", "invite_deletion_receipts", "account_invite_deletions"])
    sql.exec(`DROP TABLE ${table}`);
  sql.exec(`ALTER TABLE invites DROP COLUMN generation`);
  sql.exec(`CREATE TRIGGER guard_account_finalization BEFORE DELETE ON vaults
    WHEN OLD.state='swept' AND NOT EXISTS(SELECT 1 FROM account_final_sweeps a WHERE a.vault_id=OLD.vault_id AND a.user_id=OLD.user_id AND a.swept_at=OLD.swept_at AND a.phase='destroyed')
    BEGIN SELECT RAISE(ABORT, 'account_finalization_requires_destroy'); END`);
}

function removeFinalSweepMigration(sql: SqlStorage): void {
  removeInviteDeletionMigration(sql);
  sql.exec(`DROP TRIGGER guard_account_finalization`);
  sql.exec(`DROP TABLE account_final_sweeps`);
}

function removeBillingAccountStateMigration(sql: SqlStorage): void {
  removeFinalSweepMigration(sql);
  sql.exec(`ALTER TABLE retired_vaults DROP COLUMN generation`);
  for (const trigger of ["billing_account_insert_token", "billing_account_update_token", "billing_account_delete_token"])
    sql.exec(`DROP TRIGGER ${trigger}`);
  sql.exec(`DROP TABLE billing_state_clock`);
  sql.exec(`ALTER TABLE billing_accounts DROP COLUMN state_token`);
}

function removeShardClaimMigration(sql: SqlStorage): void {
  removeBillingAccountStateMigration(sql);
  sql.exec(`ALTER TABLE billing_events DROP COLUMN incarnation`);
  sql.exec(`DROP TRIGGER guard_shard_home_claim_bind`);
  sql.exec(`DROP TRIGGER remove_shard_home_claim_token`);
  sql.exec(`DROP TRIGGER remove_shard_identity_claim_on_identity`);
  sql.exec(`DROP TRIGGER remove_shard_identity_claim_token`);
  sql.exec(`DROP TABLE shard_home_claim_tokens`);
  sql.exec(`DROP TABLE shard_identity_claim_tokens`);
  sql.exec(`DROP TABLE shard_home_bind_claim_marker`);
}

function removeV3Migration(sql: SqlStorage): void {
  removeShardClaimMigration(sql);
  sql.exec(`DROP TABLE shard_rollout_barrier`);
  sql.exec(`DELETE FROM meta WHERE key='shard_rollout_epoch'`);
  for (const trigger of ["guard_shard_google_insert_v3", "guard_shard_google_delete_v3", "guard_global_google_release_v3"]) sql.exec(`DROP TRIGGER ${trigger}`);
  for (const table of ["shard_auth_marker", "shard_google_delete_v3_marker", "global_google_release_v3_marker"]) sql.exec(`DROP TABLE ${table}`);
  sql.exec(`ALTER TABLE shard_deletion_releases DROP COLUMN fence_epoch`);
  sql.exec(`DELETE FROM meta WHERE key IN ('shard_auth_floor','shard_auth_floor_guard','global_shard_release_v3_guard')`);
}

function removeShardReleaseMigration(sql: SqlStorage): void {
  removeV3Migration(sql);
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
  it.each([
    { table: "shard_invite_inventory", trigger: "shard_invite_seal_insert", undo: undoInviteInventoryMigrations },
    { table: "invite_inventory_barrier", trigger: "inventory_barrier_users_insert", undo: undoInviteCoordinatorMigration },
    { table: "shard_home_invite_claims", trigger: "shard_invite_claim_immutable", undo: undoShardInviteBindingMigration },
    { table: "shard_invite_target_seals", trigger: "shard_invite_target_insert_guard", undo: undoInviteTargetSealMigration },
  ])("rolls back the $table migration and its guards together", async ({ table, trigger, undo }) => {
    const stub = env.DIRECTORY.getByName(`inventory-migration-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      undo(sql);
      const previous = DIRECTORY_MIGRATIONS.findIndex((migration) => migration.some((q) => q.includes(`CREATE TABLE ${table}`)));
      expect(previous).toBeGreaterThan(0);
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      const tx = <T>(fn: () => T): T => state.storage.transactionSync(fn);
      expect(() => migrateDirectory(failAtTrigger(sql, trigger), tx)).toThrow(/synthetic migration interruption/);
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE name=?`, table).toArray()).toHaveLength(0);
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(previous));
      migrateDirectory(sql, tx);
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE name=?`, table).toArray()).toHaveLength(1);
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE name=?`, trigger).toArray()).toHaveLength(1);
    });
  });
  it("adds target verification as unproven for old receipts and rolls it back with the version on failure", async () => {
    const stub = env.DIRECTORY.getByName(`target-receipt-migration-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      undoInviteCoordinatorTargetMigration(sql);
      const attempt = crypto.randomUUID();
      sql.exec(`INSERT INTO invite_inventory_receipts(operation_id,shard,other_users,closed) VALUES (?,3,1,0)`, attempt);
      const previous = DIRECTORY_MIGRATIONS.findIndex((migration) => migration.some((q) => q.includes("ALTER TABLE invite_inventory_receipts ADD COLUMN target_verified")));
      expect(previous).toBeGreaterThan(0);
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      const tx = <T>(fn: () => T): T => state.storage.transactionSync(fn);
      expect(() => migrateDirectory(failAtVersion(sql, previous + 1), tx)).toThrow(/synthetic version-write interruption/);
      expect(sql.exec<{ name: string }>(`PRAGMA table_info(invite_inventory_receipts)`).toArray().some((c) => c.name === "target_verified")).toBe(false);
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(previous));
      expect(sql.exec<{ other_users: number }>(`SELECT other_users FROM invite_inventory_receipts WHERE operation_id=?`, attempt).one().other_users).toBe(1);
      migrateDirectory(sql, tx);
      expect(sql.exec<{ other_users: number; target_verified: number }>(`SELECT other_users,target_verified FROM invite_inventory_receipts WHERE operation_id=?`, attempt).one()).toEqual({ other_users: 1, target_verified: 0 });
    });
  });
  it("installs invite incarnation and guards atomically while preserving legacy invites", async () => {
    const stub = env.DIRECTORY.getByName(`invite-migration-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      removeInviteDeletionMigration(sql);
      sql.exec(`INSERT INTO invites(email,created_at) VALUES ('legacy@example.test',1)`);
      const previous = DIRECTORY_MIGRATIONS.findIndex((migration) => migration.some((q) => q.includes("ALTER TABLE invites ADD COLUMN generation")));
      expect(previous).toBeGreaterThan(0);
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      const tx = <T>(fn: () => T): T => state.storage.transactionSync(fn);
      expect(() => migrateDirectory(failAtTrigger(sql, "rotate_reissued_invite"), tx)).toThrow(/synthetic migration interruption/);
      expect(sql.exec<{ name: string }>(`PRAGMA table_info(invites)`).toArray().some((c) => c.name === "generation")).toBe(false);
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(previous));
      migrateDirectory(sql, tx);
      const first = sql.exec<{generation: string}>(`SELECT generation FROM invites WHERE email='legacy@example.test'`).one().generation;
      expect(first).toMatch(/^[a-f0-9]{32}$/);
      // This is the exact INSERT used by older runtimes; a reissue rotates it.
      sql.exec(`INSERT OR IGNORE INTO invites(email,created_at) VALUES ('legacy@example.test',2)`);
      expect(sql.exec<{generation: string}>(`SELECT generation FROM invites WHERE email='legacy@example.test'`).one().generation).not.toBe(first);
      expect(() => sql.exec(`DELETE FROM invites WHERE email='legacy@example.test'`)).toThrow(/invite_delete_permit_required/);
    });
  });
  it("installs the account final-sweep table and guard atomically without inventing legacy proofs", async () => {
    const stub = env.DIRECTORY.getByName(`final-sweep-migration-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      removeFinalSweepMigration(sql);
      sql.exec(`INSERT INTO users(user_id,email,state,created_at) VALUES ('u','legacy@example.test','deleting',1)`);
      sql.exec(`INSERT INTO vaults(vault_id,user_id,hint,state,swept_at,updated_at) VALUES ('v','u','enam','swept',1,1)`);
      const previous = DIRECTORY_MIGRATIONS.findIndex((migration) => migration.some((q) => q.includes("CREATE TABLE account_final_sweeps")));
      expect(previous).toBeGreaterThan(0);
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      const tx = <T>(fn: () => T): T => state.storage.transactionSync(fn);
      expect(() => migrateDirectory(failAtTrigger(sql, "guard_account_finalization"), tx)).toThrow(/synthetic migration interruption/);
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE name IN ('account_final_sweeps','guard_account_finalization')`).toArray()).toEqual([]);
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(previous));
      migrateDirectory(sql, tx);
      expect(sql.exec(`SELECT * FROM account_final_sweeps`).toArray()).toEqual([]);
      expect(() => sql.exec(`DELETE FROM vaults WHERE vault_id='v'`)).toThrow(/account_finalization_requires_destroy/);
      expect(sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id='v'`).one().state).toBe("swept");
    });
  });
  it("rolls back retired generation migration and preserves legacy retirement rows", async () => {
    const stub = env.DIRECTORY.getByName(`retired-generation-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO retired_vaults(vault_id,user_id,state,swept_at) VALUES ('v','u','swept',123)`);
      removeFinalSweepMigration(sql);
      sql.exec(`ALTER TABLE retired_vaults DROP COLUMN generation`);
      const previous = DIRECTORY_MIGRATIONS.findIndex((migration) => migration.some((q) => q.includes("retired_vaults ADD COLUMN generation")));
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      const tx = <T>(fn: () => T): T => state.storage.transactionSync(fn);
      expect(() => migrateDirectory(failAtVersion(sql, previous + 1), tx)).toThrow(/synthetic version-write interruption/);
      expect(() => sql.exec(`SELECT generation FROM retired_vaults`).toArray()).toThrow();
      expect(sql.exec<{value:string}>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(previous));
      migrateDirectory(sql, tx);
      expect(sql.exec<{state:string;generation:string|null}>(`SELECT state,generation FROM retired_vaults WHERE vault_id='v'`).one()).toEqual({ state: "swept", generation: null });
    });
  });
  it("rolls back billing account state tokens atomically, then preserves legacy rows", async () => {
    const stub = env.DIRECTORY.getByName(`billing-state-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO billing_accounts(user_id,customer_id,entitlement,revision) VALUES ('u1','cus_legacy','{}',1)`);
      removeBillingAccountStateMigration(sql);
      const previous = DIRECTORY_MIGRATIONS.findIndex((migration) => migration.some((q) => q.includes("billing_accounts ADD COLUMN state_token")));
      expect(previous).toBeGreaterThan(0);
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      const tx = <T>(fn: () => T): T => state.storage.transactionSync(fn);
      expect(() => migrateDirectory(failAtVersion(sql, previous + 1), tx)).toThrow(/synthetic version-write interruption/);
      expect(() => sql.exec(`SELECT state_token FROM billing_accounts`).toArray()).toThrow();
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE name='billing_state_clock'`).toArray()).toHaveLength(0);
      expect(sql.exec<{value:string}>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(previous));
      migrateDirectory(sql, tx);
      expect(sql.exec<{state_token:number|null}>(`SELECT state_token FROM billing_accounts WHERE user_id='u1'`).one().state_token).toBeNull();
      sql.exec(`UPDATE billing_accounts SET customer_id=customer_id WHERE user_id='u1'`);
      expect(sql.exec<{state_token:number}>(`SELECT state_token FROM billing_accounts WHERE user_id='u1'`).one().state_token).toBeGreaterThan(0);
    });
  });
  it("rolls back billing event incarnation migration and preserves legacy rows", async () => {
    const stub = env.DIRECTORY.getByName(`billing-incarnation-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO billing_events(id,customer_id,user_id,created_at) VALUES ('evt_legacy','cus_legacy','u1',1)`);
      removeBillingAccountStateMigration(sql);
      sql.exec(`ALTER TABLE billing_events DROP COLUMN incarnation`);
      const previous = DIRECTORY_MIGRATIONS.findIndex((migration) => migration.some((q) => q.includes("billing_events ADD COLUMN incarnation")));
      expect(previous).toBeGreaterThan(0);
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      const tx = <T>(fn: () => T): T => state.storage.transactionSync(fn);
      expect(() => migrateDirectory(failAtVersion(sql, previous + 1), tx)).toThrow(/synthetic version-write interruption/);
      expect(() => sql.exec(`SELECT incarnation FROM billing_events`).toArray()).toThrow();
      expect(sql.exec<{value:string}>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(previous));
      migrateDirectory(sql, tx);
      expect(sql.exec<{id:string;incarnation:string|null}>(`SELECT id,incarnation FROM billing_events`).one())
        .toEqual({ id: "evt_legacy", incarnation: null });
      expect(sql.exec<{value:string}>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(DIRECTORY_MIGRATIONS.length));
    });
  });
  it("rolls back the shard claim tables, triggers and version together", async () => {
    const stub = env.DIRECTORY.getByName(`claim-migration-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO identity_homes(provider,subject,shard,user_id) VALUES ('test','legacy',3,'s3:legacy')`);
      removeShardClaimMigration(sql);
      const previous = DIRECTORY_MIGRATIONS.findIndex((migration) => migration.some((q) => q.includes("CREATE TABLE shard_home_claim_tokens")));
      expect(previous).toBeGreaterThan(0);
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      const tx = <T>(fn: () => T): T => state.storage.transactionSync(fn);
      expect(() => migrateDirectory(failAtTrigger(sql, "remove_shard_identity_claim_token"), tx)).toThrow(/synthetic migration interruption/);
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE name IN ('shard_home_claim_tokens','shard_identity_claim_tokens','shard_home_bind_claim_marker','guard_shard_home_claim_bind','remove_shard_home_claim_token','remove_shard_identity_claim_on_identity','remove_shard_identity_claim_token')`).toArray()).toEqual([]);
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(previous));
      expect(sql.exec<{ user_id: string }>(`SELECT user_id FROM identity_homes WHERE subject='legacy'`).one().user_id).toBe("s3:legacy");
      migrateDirectory(sql, tx);
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE name IN ('shard_home_claim_tokens','shard_identity_claim_tokens','shard_home_bind_claim_marker','guard_shard_home_claim_bind','remove_shard_home_claim_token','remove_shard_identity_claim_on_identity','remove_shard_identity_claim_token')`).toArray()).toHaveLength(7);
      expect(sql.exec(`SELECT * FROM shard_home_claim_tokens`).toArray()).toEqual([]);
    });
  });
  it("rolls back the rollout barrier and epoch together, then retries once", async () => {
    const stub = env.DIRECTORY.getByName(`rollout-migration-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      removeShardClaimMigration(sql);
      sql.exec(`DROP TABLE shard_rollout_barrier`);
      sql.exec(`INSERT INTO meta(key,value) VALUES ('global_auth_epoch','9') ON CONFLICT(key) DO UPDATE SET value='9'`);
      const previous = DIRECTORY_MIGRATIONS.findIndex((migration) => migration.some((q) => q.includes("CREATE TABLE shard_rollout_barrier")));
      expect(previous).toBeGreaterThan(0);
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      const tx = <T>(fn: () => T): T => state.storage.transactionSync(fn);
      expect(() => migrateDirectory(failAtVersion(sql, previous + 1), tx, true)).toThrow(/synthetic version-write interruption/);
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='global_auth_epoch'`).one().value).toBe("9");
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE name='shard_rollout_barrier'`).toArray()).toHaveLength(0);
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(previous));
      migrateDirectory(sql, tx, true);
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='global_auth_epoch'`).one().value).toBe("10");
      expect(sql.exec<{ epoch: number }>(`SELECT epoch FROM shard_rollout_barrier WHERE slot=1`).one().epoch).toBe(10);
      migrateDirectory(sql, tx, true);
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='global_auth_epoch'`).one().value).toBe("10");
    });
  });
  it.each(["global", "shard"] as const)("installs the %s V3 guard atomically and preserves old acknowledgements", async (mode) => {
    const stub = env.DIRECTORY.getByName(`v3-migration-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO shard_deletion_releases(user_id,provider,subject,state) VALUES ('u','google','s','acknowledged')`);
      removeV3Migration(sql);
      if (mode === "global") sql.exec(`INSERT OR IGNORE INTO meta(key,value) VALUES ('global_auth_epoch','0')`);
      const previous = DIRECTORY_MIGRATIONS.findIndex((migration) => migration.some((q) => q.includes("ADD COLUMN fence_epoch")));
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      const tx = <T>(fn: () => T): T => state.storage.transactionSync(fn);
      expect(() => migrateDirectory(failAtVersion(sql, previous + 1), tx, mode === "global", mode === "shard")).toThrow(/synthetic version-write interruption/);
      expect(() => sql.exec(`SELECT fence_epoch FROM shard_deletion_releases`).toArray()).toThrow();
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE name='shard_auth_marker'`).toArray()).toHaveLength(0);
      expect(sql.exec<{value:string}>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(previous));
      migrateDirectory(sql, tx, mode === "global", mode === "shard");
      expect(sql.exec<{state:string;fence_epoch:number|null}>(`SELECT state,fence_epoch FROM shard_deletion_releases`).one()).toEqual({ state: "acknowledged", fence_epoch: null });
      const guard = mode === "shard" ? "shard_auth_floor_guard" : "global_shard_release_v3_guard";
      expect(sql.exec<{value:string}>(`SELECT value FROM meta WHERE key=?`, guard).one().value).toBe("1");
    });
  });
  it("rolls back billing delivery retry storage and its version together", async () => {
    const stub = env.DIRECTORY.getByName(`billing-delivery-migration-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO billing_accounts(user_id,customer_id,revision,delivered_revision) VALUES ('u1','cus_1',2,1)`);
      removeV3Migration(sql);
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
      removeV3Migration(sql);
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
      removeExportCacheMigration(sql);
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
      removeExportCacheMigration(sql);
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
      removeExportCacheMigration(sql);
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
      removeExportCacheMigration(sql);
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
      removeExportCacheMigration(sql);
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
      removeExportCacheMigration(sql);
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
  it("rolls back export cache tables and the schema version together, then retries", async () => {
    const stub = env.VAULT.get(env.VAULT.newUniqueId());
    await stub.init("migration-owner");
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`UPDATE profile SET name='preserved' WHERE id=1`);
      removeExportCacheMigration(sql);
      const previous = priorVersion("CREATE TABLE export_cache (");
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      const tx = <T>(fn: () => T): T => state.storage.transactionSync(fn);
      expect(() => migrate(failAtVersion(sql, previous + 1), tx)).toThrow(/synthetic version-write interruption/);
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(previous));
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE name IN ('export_cache','export_cache_chunks')`).toArray()).toHaveLength(0);
      expect(sql.exec<{ name: string }>(`SELECT name FROM profile WHERE id=1`).one().name).toBe("preserved");
      migrate(sql, tx);
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(SCHEMA_VERSION));
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE name IN ('export_cache','export_cache_chunks')`).toArray()).toHaveLength(2);
    });
  });

  it("atomically migrates source-write links while preserving unattributed legacy markers", async () => {
    const stub = env.VAULT.get(env.VAULT.newUniqueId());
    await stub.init("migration-owner");
    const attempt = crypto.randomUUID();
    await stub.beginCacheWrite({ userId: "migration-owner", gen: 1 }, attempt, "source", "a".repeat(64));
    await runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`DROP TRIGGER clear_source_write_link`);
      sql.exec(`DROP TABLE source_write_links`);
      const previous = priorVersion("CREATE TABLE source_write_links");
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      const tx = <T>(fn: () => T): T => state.storage.transactionSync(fn);
      expect(() => migrate(failAtTrigger(sql, "clear_source_write_link"), tx)).toThrow(/synthetic migration interruption/);
      expect(sql.exec<{value:string}>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(previous));
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE name IN ('source_write_links','clear_source_write_link')`).toArray()).toEqual([]);
      expect(sql.exec<{attempt_id:string}>(`SELECT attempt_id FROM r2_cache_dispatches`).one().attempt_id).toBe(attempt);
      migrate(sql, tx);
      expect(sql.exec<{value:string}>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(SCHEMA_VERSION));
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE name IN ('source_write_links','clear_source_write_link')`).toArray()).toHaveLength(2);
      expect(sql.exec(`SELECT attempt_id FROM source_write_links`).toArray()).toHaveLength(0);
      await expect(instance.close()).rejects.toThrow("source write is unresolved");
    });
  });

  it("rolls back the job receipt table and version together, then retries", async () => {
    const stub = env.VAULT.get(env.VAULT.newUniqueId());
    await stub.init("migration-owner");
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`UPDATE profile SET name='preserved' WHERE id=1`);
      removeExportCacheMigration(sql);
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
