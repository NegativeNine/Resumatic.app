/** Restore an older Directory schema for migration-interruption tests. */
export function undoInviteCoordinatorMigration(sql: SqlStorage): void {
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
