/** Restore an older Directory schema for migration-interruption tests. */
export function undoInviteCoordinatorTargetMigration(sql: SqlStorage): void {
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
