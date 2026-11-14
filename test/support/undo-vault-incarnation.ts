/** Test-only helper to reconstruct a Vault schema before saved answers and application kits were kept, and so before every later migration. The index goes before its table. */
export function removeSavedAnswerMigration(sql: SqlStorage): void {
  removeNotificationMigration(sql);
  sql.exec(`DROP INDEX IF EXISTS kit_questions_by_saved_answer`);
  sql.exec(`DROP TABLE IF EXISTS kit_questions`);
  sql.exec(`DROP TABLE IF EXISTS application_kits`);
  sql.exec(`DROP TABLE IF EXISTS saved_answers`);
}

/** Test-only helper to reconstruct a Vault schema before owner skill intervals were kept. */
export function removeSkillYearsMigration(sql: SqlStorage): void {
  for (const kind of ["fact", "role", "split", "part", "tag"])
    for (const action of ["insert", "update", "delete"]) sql.exec(`DROP TRIGGER IF EXISTS skill_identity_${kind}_${action}`);
  for (const action of ["insert", "update", "delete"]) sql.exec(`DROP TRIGGER IF EXISTS skill_identity_evidence_${action}`);
  for (const action of ["update", "delete"]) sql.exec(`DROP TRIGGER IF EXISTS skill_identity_revision_${action}`);
  sql.exec(`DROP TRIGGER IF EXISTS skill_duration_claim_immutable`);
  for (const table of ["skill_year_requests", "skill_duration_claims", "skill_use_intervals", "skill_record_identities"]) sql.exec(`DROP TABLE IF EXISTS ${table}`);
}

/** Test-only helper to reconstruct a Vault schema before email notices could be turned on. */
export function removeNotificationMigration(sql: SqlStorage): void {
  removeSkillYearsMigration(sql);
  sql.exec(`DROP TABLE IF EXISTS email_notices`);
}

/** Test-only helper to reconstruct a Vault schema before a coach could suggest wording, and so before every later migration. */
export function removeSuggestionMigration(sql: SqlStorage): void {
  removeSavedAnswerMigration(sql);
  sql.exec(`ALTER TABLE share_comments DROP COLUMN document_id`);
  sql.exec(`ALTER TABLE share_comments DROP COLUMN suggestion_state`);
}

/** Test-only helper to reconstruct a Vault schema before a shared copy could take comments, and so before every later migration. The index goes with its table. */
export function removeCommentMigration(sql: SqlStorage): void {
  removeSuggestionMigration(sql);
  sql.exec(`DROP TABLE IF EXISTS share_comments`);
}

/** Test-only helper to reconstruct a Vault schema before a fact could be marked sensitive, and so before every later migration. */
export function removeSensitiveMigration(sql: SqlStorage): void {
  removeCommentMigration(sql);
  sql.exec(`DROP INDEX IF EXISTS facts_sensitive`);
  sql.exec(`ALTER TABLE facts DROP COLUMN sensitive`);
}

/** Test-only helper to reconstruct a Vault schema before job preferences were kept, and so before every later migration. */
export function removePreferencesMigration(sql: SqlStorage): void {
  removeSensitiveMigration(sql);
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
