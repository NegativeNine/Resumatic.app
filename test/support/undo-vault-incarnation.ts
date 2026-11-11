/** Test-only helper to reconstruct a Vault schema before job preferences were kept, the latest migration. */
export function removePreferencesMigration(sql: SqlStorage): void {
  sql.exec(`DROP TABLE IF EXISTS preferences`);
}

/** Test-only helper to reconstruct a Vault schema before a link could name a coach, and so before every later migration. */
export function removeCoachMigration(sql: SqlStorage): void {
  removePreferencesMigration(sql);
  sql.exec(`DROP TABLE IF EXISTS coach_clients`);
  for (const column of ["coach_joined_at", "coach_name", "coach_user_id", "coach_email"])
    sql.exec(`ALTER TABLE share_grants DROP COLUMN ${column}`);
}

/** Test-only helper to reconstruct a Vault schema before the record held parts, tags and links, and so before every later migration. */
export function removeRecordMigration(sql: SqlStorage): void {
  removeCoachMigration(sql);
  for (const trigger of ["fact_deleted", "role_deleted", "split_deleted", "part_deleted", "fact_reworded", "role_retitled", "role_changed"])
    sql.exec(`DROP TRIGGER IF EXISTS record_${trigger}`);
  for (const table of ["record_links", "record_tags", "fact_parts", "fact_splits"]) sql.exec(`DROP TABLE IF EXISTS ${table}`);
}

/** Test-only helper to reconstruct a Vault schema before copies counted their documents, and so before every later migration. */
export function removeShareDocumentMigration(sql: SqlStorage): void {
  removeRecordMigration(sql);
  sql.exec(`ALTER TABLE share_grants DROP COLUMN document_count`);
}

/** Test-only helper to reconstruct a Vault schema before share labels and read times, and so before every later migration. */
export function removeShareDetailMigration(sql: SqlStorage): void {
  removeShareDocumentMigration(sql);
  sql.exec(`ALTER TABLE share_grants DROP COLUMN label`);
  sql.exec(`ALTER TABLE share_grants DROP COLUMN last_read_at`);
}

/** Test-only helper to reconstruct a Vault schema before job details (a link, and a title the person set), and so before every later migration. */
export function removeJobDetailsMigration(sql: SqlStorage): void {
  removeShareDetailMigration(sql);
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
