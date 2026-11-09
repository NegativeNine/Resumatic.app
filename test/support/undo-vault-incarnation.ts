/** Test-only helper to reconstruct a Vault schema before job details (a link, and a title the person set), the latest migration. */
export function removeJobDetailsMigration(sql: SqlStorage): void {
  sql.exec(`ALTER TABLE applications DROP COLUMN url`);
  sql.exec(`ALTER TABLE applications DROP COLUMN details_edited`);
}

/** Test-only helper to reconstruct a Vault schema before upload digests, and so before every later migration. */
export function removeSourceDigestMigration(sql: SqlStorage): void {
  removeJobDetailsMigration(sql);
  sql.exec(`DROP INDEX IF EXISTS sources_sha256`);
  sql.exec(`ALTER TABLE sources DROP COLUMN sha256`);
}

/** Test-only helper to reconstruct a Vault schema before incarnation fencing, and so before every later migration. */
export function removeIncarnationMigration(sql: SqlStorage): void {
  removeSourceDigestMigration(sql);
  for (const table of ["facts", "roles"])
    for (const suffix of ["capacity", "insert", "delete", "id", "update_capacity", "update"])
      sql.exec(`DROP TRIGGER IF EXISTS ${table}_incarnation_${suffix}`);
  for (const suffix of ["insert_capacity", "insert", "update_capacity", "update", "delete_capacity", "delete", "id"])
    sql.exec(`DROP TRIGGER IF EXISTS evidence_incarnation_${suffix}`);
  sql.exec(`DROP TABLE IF EXISTS entity_incarnations`);
  sql.exec(`DROP TABLE IF EXISTS entity_incarnation_guard`);
  sql.exec(`DROP TABLE IF EXISTS entity_incarnation_clock`);
  sql.exec(`ALTER TABLE generation_input_items DROP COLUMN incarnation`);
}
