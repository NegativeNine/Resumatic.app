/** Test-only helper to reconstruct a Vault schema before incarnation fencing. */
export function removeIncarnationMigration(sql: SqlStorage): void {
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
