/** Restore an older Directory schema for migration-interruption tests. */
export function undoInviteRevocationMigration(sql: SqlStorage): void {
  // The revocation migration replaces these earlier release guards. Restore
  // their prior definitions before dropping the tables the replacements use.
  const oldGuards = [
    ["guard_global_google_shard_home_delete", `CREATE TRIGGER guard_global_google_shard_home_delete BEFORE DELETE ON identity_homes
     WHEN OLD.provider='google' AND OLD.shard IS NOT NULL
       AND EXISTS(SELECT 1 FROM meta WHERE key='global_auth_guard' AND value='1')
       AND NOT EXISTS(SELECT 1 FROM global_shard_home_release_marker WHERE provider=OLD.provider AND subject=OLD.subject AND user_id=OLD.user_id)
     BEGIN SELECT RAISE(ABORT, 'shard_deletion_barrier_required'); END`],
    ["guard_global_google_release_v3", `CREATE TRIGGER guard_global_google_release_v3 BEFORE DELETE ON identity_homes
     WHEN OLD.provider='google' AND OLD.shard IS NOT NULL AND EXISTS(SELECT 1 FROM meta WHERE key='global_shard_release_v3_guard' AND value='1')
       AND NOT EXISTS(SELECT 1 FROM global_google_release_v3_marker WHERE provider=OLD.provider AND subject=OLD.subject AND user_id=OLD.user_id)
     BEGIN SELECT RAISE(ABORT, 'shard_auth_floor_required'); END`],
  ] as const;
  for (const [name, definition] of oldGuards) {
    if (sql.exec(`SELECT name FROM sqlite_master WHERE type='trigger' AND name=?`, name).toArray().length) {
      sql.exec(`DROP TRIGGER ${name}`);
      sql.exec(definition);
    }
  }
  for (const trigger of [
    "guard_invite_delete_authorization_v4", "invite_revocation_inventory_guard",
    "invite_revocation_registration_guard", "invite_revocation_home_insert",
    ...["invites", "claim", "token"].flatMap((table) => ["insert", "update", "delete"].map((action) => `invite_revocation_${table}_${action}`)),
    "invite_revocation_user_insert", "invite_revocation_user_email",
    "invite_revocation_home_update", "invite_revocation_home_delete",
  ]) sql.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  for (const table of [
    "invite_revocation_barrier", "invite_revocation_claims", "invite_revocation_receipts",
    "invite_revocation_mutation_marker", "invite_registration_marker", "invite_delete_authorizations_v4",
  ]) sql.exec(`DROP TABLE IF EXISTS ${table}`);
}

export function undoShardClaimRevocationMigration(sql: SqlStorage): void {
  undoInviteRevocationMigration(sql);
  for (const trigger of [
    "shard_revoked_invite_claim_delete", "shard_revoked_invite_claim_update",
    "shard_invite_create_marker_open", "shard_revoked_token_insert", "shard_revocation_identity_insert",
  ]) sql.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  // These indexes belong to older tables and do not disappear with the new tables.
  for (const index of ["shard_invite_account_bindings_token", "shard_identity_claim_tokens_token"])
    sql.exec(`DROP INDEX IF EXISTS ${index}`);
  sql.exec(`DROP TABLE IF EXISTS shard_invite_create_marker`);
  sql.exec(`DROP TABLE IF EXISTS shard_revoked_invite_claims`);
  sql.exec(`DELETE FROM meta WHERE key='shard_invite_revocation_guard'`);
}

export function undoInviteCoordinatorTargetMigration(sql: SqlStorage): void {
  undoShardClaimRevocationMigration(sql);
  const table = sql.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='invite_inventory_receipts'`).toArray();
  if (table.length && sql.exec<{ name: string }>(`PRAGMA table_info(invite_inventory_receipts)`).toArray().some((row) => row.name === 'target_verified'))
    sql.exec(`ALTER TABLE invite_inventory_receipts DROP COLUMN target_verified`);
}

export function undoInviteTargetSealMigration(sql: SqlStorage): void {
  undoInviteCoordinatorTargetMigration(sql);
  for (const trigger of [
    'shard_invite_target_insert_guard', 'shard_invite_target_update_guard', 'shard_invite_target_delete_guard',
    'shard_invite_target_inventory_update', 'shard_invite_target_inventory_delete',
  ]) sql.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  for (const table of [
    'vaults', 'vault_initializations', 'account_final_sweeps', 'account_invite_deletions',
    'retired_vaults', 'vault_replacements', 'identities', 'shard_identity_claim_tokens',
    'shard_invite_account_bindings', 'shard_deletion_releases', 'placement_identities', 'placement_finalizations',
  ]) for (const action of ['insert', 'update', 'delete'])
    sql.exec(`DROP TRIGGER IF EXISTS shard_invite_target_${table}_${action}`);
  sql.exec(`DROP TABLE IF EXISTS shard_invite_target_seals`);
  sql.exec(`DROP TABLE IF EXISTS shard_invite_target_close_marker`);
}

export function undoShardInviteBindingMigration(sql: SqlStorage): void {
  undoInviteTargetSealMigration(sql);
  for (const trigger of [
    'shard_invite_claim_immutable', 'shard_invite_claim_user_bind', 'shard_invite_account_immutable',
    'shard_invite_claim_home_bind', 'remove_shard_home_invite_claim', 'remove_shard_invite_account_binding',
    'shard_invite_claim_barrier_insert', 'shard_invite_claim_barrier_update', 'shard_invite_claim_barrier_delete',
  ]) sql.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  for (const table of ['shard_home_invite_claims', 'shard_invite_account_bindings', 'shard_invite_bind_marker'])
    sql.exec(`DROP TABLE IF EXISTS ${table}`);
}

export function undoInviteCoordinatorMigration(sql: SqlStorage): void {
  undoShardInviteBindingMigration(sql);
  sql.exec(`DROP TRIGGER IF EXISTS guard_invite_delete_authorization_v3`);
  sql.exec(`DROP TABLE IF EXISTS invite_delete_authorizations_v3`);
  for (const table of ["users", "identity_homes"])
    for (const action of ["insert", "update", "delete"])
      sql.exec(`DROP TRIGGER IF EXISTS inventory_barrier_${table}_${action}`);
  for (const table of ["users", "identity_homes"])
    sql.exec(`DROP TRIGGER IF EXISTS inventory_epoch_${table}_insert`);
  sql.exec(`DROP TRIGGER IF EXISTS inventory_epoch_identity_homes_bind`);
  sql.exec(`DROP TABLE IF EXISTS invite_inventory_receipts`);
  sql.exec(`DROP TABLE IF EXISTS invite_inventory_barrier`);
  sql.exec(`DELETE FROM meta WHERE key='invite_inventory_epoch_guard'`);
}

export function undoInviteInventoryMigrations(sql: SqlStorage): void {
  undoInviteCoordinatorMigration(sql);
  for (const trigger of ["shard_invite_seal_insert", "shard_invite_seal_update", "shard_invite_seal_delete", "shard_invite_epoch_insert"])
    sql.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  sql.exec(`DROP TABLE IF EXISTS shard_invite_inventory`);
  sql.exec(`DELETE FROM meta WHERE key='shard_invite_epoch_guard'`);
}
