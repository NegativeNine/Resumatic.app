import { INTERVIEW_MIGRATIONS } from "./interview";
import { FEEDBACK_MIGRATIONS } from "./extraction-feedback";
import { UPLOAD_MIGRATIONS } from "./uploads";
import { OPERATION_MIGRATIONS } from "./operations";
import { MCP_MIGRATIONS } from "./mcp-grants";
import { RUN_MIGRATIONS } from "./runs";
import { COACH_CLIENT_MIGRATIONS } from "./coach-clients";
import { SHARE_COACH_MIGRATIONS, SHARE_DETAIL_MIGRATIONS, SHARE_DOCUMENT_MIGRATIONS, SHARE_MIGRATIONS } from "./shares";
import { SHARE_COMMENT_MIGRATIONS } from "./share-comments";
import { SHARE_SUGGESTION_MIGRATIONS } from "./share-suggestions";
import { EXPORT_CACHE_MIGRATIONS } from "./export-cache";
import { RECORD_MIGRATIONS } from "./record";
import { PREFERENCES_MIGRATIONS } from "./preferences";
import { SENSITIVE_MIGRATIONS } from "./sensitive";
import { SAVED_ANSWER_MIGRATIONS } from "./application-kit";
// Vault tables. Migrations run in order; schema_version in meta records how far a vault has got.
// Only init() creates the schema, so a destroyed vault stays empty when it wakes.

export const MIGRATIONS: readonly string[][] = [
  [
    `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '', links TEXT NOT NULL DEFAULT '[]'
    )`,
    `CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY, filename TEXT NOT NULL, r2_key TEXT NOT NULL,
      markdown TEXT, state TEXT NOT NULL, error TEXT, run_id TEXT, created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources (id), quote TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, org TEXT NOT NULL, title TEXT,
      start_date TEXT, end_date TEXT, evidence_id TEXT REFERENCES evidence (id),
      source_id TEXT, state TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY, role_id TEXT REFERENCES roles (id), kind TEXT NOT NULL, text TEXT NOT NULL,
      level TEXT, evidence_id TEXT REFERENCES evidence (id), source_id TEXT, origin TEXT NOT NULL,
      state TEXT NOT NULL, vector BLOB, updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY, company TEXT, title TEXT, jd_text TEXT NOT NULL,
      requirements TEXT, created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS resumes (
      id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications (id),
      state TEXT NOT NULL, step TEXT, error TEXT,
      selection TEXT, draft TEXT, verified TEXT, body TEXT, report TEXT,
      version INTEGER NOT NULL DEFAULT 1, quota_month TEXT, run_id TEXT, created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS facts_by_source ON facts (source_id)`,
    `CREATE INDEX IF NOT EXISTS facts_by_state ON facts (state)`,
    `CREATE INDEX IF NOT EXISTS resumes_by_application ON resumes (application_id)`,
  ],
  [
    `ALTER TABLE profile ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE roles ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE facts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE resumes ADD COLUMN run_analysis TEXT`,
    `ALTER TABLE applications ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE applications ADD COLUMN status TEXT NOT NULL DEFAULT 'saved'`,
    `ALTER TABLE applications ADD COLUMN applied_at TEXT`,
    `ALTER TABLE applications ADD COLUMN notes TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE evidence ADD COLUMN start INTEGER`,
    `ALTER TABLE evidence ADD COLUMN end INTEGER`,
    `ALTER TABLE evidence ADD COLUMN source_revision_id TEXT`,
    `CREATE TABLE source_revisions (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, markdown TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE extraction_commits (source_id TEXT PRIMARY KEY, roles INTEGER NOT NULL, facts INTEGER NOT NULL)`,
    `CREATE TABLE generation_inputs (run_id TEXT PRIMARY KEY, metadata TEXT NOT NULL)`,
    `CREATE TABLE generation_input_items (run_id TEXT NOT NULL, kind TEXT NOT NULL, item_id TEXT NOT NULL, data TEXT NOT NULL, vector BLOB, PRIMARY KEY(run_id, kind, item_id))`,
    `CREATE TABLE resume_versions (resume_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(resume_id, version))`,
  ],
  [...RUN_MIGRATIONS],
  [...SHARE_MIGRATIONS],
  [
    `CREATE TABLE document_requests (run_id TEXT PRIMARY KEY, application_id TEXT NOT NULL, kind TEXT NOT NULL, options TEXT NOT NULL, plan TEXT, draft TEXT, result TEXT)`,
    `CREATE TABLE documents (id TEXT PRIMARY KEY, application_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, result TEXT, error TEXT, created_at INTEGER NOT NULL)`,
    `CREATE TABLE document_versions (document_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(document_id, version))`,
  ],
  [...MCP_MIGRATIONS],
  [
    `ALTER TABLE sources ADD COLUMN origin TEXT NOT NULL DEFAULT 'upload'`,
    `ALTER TABLE sources ADD COLUMN parent_source_id TEXT`,
    `ALTER TABLE sources ADD COLUMN extractor TEXT`,
    `ALTER TABLE facts ADD COLUMN confidence REAL`,
    `ALTER TABLE facts ADD COLUMN review_reasons TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE extraction_commits ADD COLUMN dropped INTEGER NOT NULL DEFAULT 0`,
  ],
  [...OPERATION_MIGRATIONS],
  [...UPLOAD_MIGRATIONS],
  [...FEEDBACK_MIGRATIONS],
  [...INTERVIEW_MIGRATIONS],
  [
    `CREATE TABLE refine_cache (cache_key TEXT PRIMARY KEY, draft TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  ],
  [
    `ALTER TABLE sources ADD COLUMN ocr_image_count INTEGER CHECK (ocr_image_count IS NULL OR ocr_image_count BETWEEN 1 AND 4)`,
  ],
  [
    `CREATE TABLE workflow_dispatches (run_id TEXT PRIMARY KEY)`,
    // A run can reach a terminal state before its create acknowledgement is
    // delivered. Upgrades cannot infer quiescence from the run state alone.
    `INSERT INTO workflow_dispatches (run_id) SELECT id FROM runs WHERE kind != 'embed'`,
    `INSERT OR IGNORE INTO workflow_dispatches (run_id) SELECT run_id FROM sources WHERE run_id IS NOT NULL`,
    `INSERT OR IGNORE INTO workflow_dispatches (run_id) SELECT run_id FROM resumes WHERE run_id IS NOT NULL`,
  ],
  [
    // Once redispatch is attempted, no acknowledgement can prove that an
    // earlier uncertain request will not arrive later. Keep this fence.
    `CREATE TABLE workflow_redispatches (run_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL)`,
    // Also protect the original marker from older code that deletes it on ACK.
    `CREATE TRIGGER keep_uncertain_dispatch BEFORE DELETE ON workflow_dispatches
       WHEN EXISTS (SELECT 1 FROM workflow_redispatches WHERE run_id = OLD.run_id)
       BEGIN SELECT RAISE(IGNORE); END`,
  ],
  [
    // A separate value keeps the legacy start/end pair empty, so an old reader
    // cannot interpret an unknown end as ongoing employment.
    `ALTER TABLE roles ADD COLUMN unknown_end_start_date TEXT`,
    // Legacy writers know only start_date/end_date. A deliberate legacy date
    // update supersedes the extra value and must not leave contradictory data.
    `CREATE TRIGGER clear_unknown_end_start AFTER UPDATE OF start_date, end_date ON roles
       WHEN NEW.start_date IS NOT NULL OR NEW.end_date IS NOT NULL
       BEGIN UPDATE roles SET unknown_end_start_date = NULL WHERE id = NEW.id; END`,
  ],
  [
    `ALTER TABLE facts ADD COLUMN level_revision INTEGER`,
    // All pre-migration user levels need reaffirmation. Older schema versions
    // introduced revisions with a default of 1, so revision=1 does not prove
    // that the wording was never changed. Keep original values for review.
  ],
  [
    // One marker per dispatched export-cache put. A missing acknowledgement
    // cannot establish that a request will not arrive after deletion.
    `CREATE TABLE r2_cache_dispatches (attempt_id TEXT PRIMARY KEY, kind TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  ],
  [
    // Older unresolved markers remain valid but cannot be matched by key digest.
    `ALTER TABLE r2_cache_dispatches ADD COLUMN key_digest TEXT`,
  ],
  [
    // Stable result for a retried manual fact submission; no fact text is
    // duplicated in the request ledger.
    `CREATE TABLE fact_create_requests (request_key TEXT PRIMARY KEY, input_digest TEXT NOT NULL, fact_id TEXT NOT NULL REFERENCES facts(id))`,
  ],
  [
    // Preserve the result of a manual role submission after a lost response.
    `CREATE TABLE role_create_requests (request_key TEXT PRIMARY KEY, input_digest TEXT NOT NULL, role_id TEXT NOT NULL REFERENCES roles(id))`,
  ],
  [
    // Preserve the result of a job submission after a lost response.
    `CREATE TABLE application_create_requests (request_key TEXT PRIMARY KEY, input_digest TEXT NOT NULL, application_id TEXT NOT NULL REFERENCES applications(id))`,
  ],
  [...EXPORT_CACHE_MIGRATIONS],
  [
    // New source puts bind their opaque attempt to the Vault's own reservation.
    // Markers created by older code have no link and remain globally blocking.
    `CREATE TABLE source_write_links (attempt_id TEXT PRIMARY KEY, source_id TEXT NOT NULL)`,
    `CREATE TRIGGER clear_source_write_link AFTER DELETE ON r2_cache_dispatches
       BEGIN DELETE FROM source_write_links WHERE attempt_id = OLD.attempt_id; END`,
  ],
  [
    // A revision can repeat after a record is deleted and recreated. Bind new
    // generation snapshots to a separate, monotonically assigned incarnation.
    // Existing rows receive zero; old snapshots have no captured incarnation
    // and cannot publish after this migration.
    `CREATE TABLE entity_incarnation_clock (slot INTEGER PRIMARY KEY CHECK(slot=1), value INTEGER NOT NULL CHECK(typeof(value)='integer' AND value BETWEEN 0 AND 9007199254740991))`,
    `INSERT INTO entity_incarnation_clock(slot,value) VALUES (1,0)`,
    `CREATE TRIGGER incarnation_clock_no_replace BEFORE INSERT ON entity_incarnation_clock WHEN EXISTS(SELECT 1 FROM entity_incarnation_clock WHERE slot=1) BEGIN SELECT RAISE(ABORT, 'incarnation_clock_required'); END`,
    `CREATE TRIGGER incarnation_clock_no_delete BEFORE DELETE ON entity_incarnation_clock BEGIN SELECT RAISE(ABORT, 'incarnation_clock_required'); END`,
    `CREATE TRIGGER incarnation_clock_monotone BEFORE UPDATE ON entity_incarnation_clock WHEN NEW.slot<>OLD.slot OR NEW.value<>OLD.value+1 BEGIN SELECT RAISE(ABORT, 'incarnation_clock_invalid'); END`,
    `CREATE TABLE entity_incarnation_guard (slot INTEGER PRIMARY KEY CHECK(slot=1))`,
    `CREATE TABLE entity_incarnations (kind TEXT NOT NULL CHECK(kind IN ('fact','role')), item_id TEXT NOT NULL, value INTEGER NOT NULL CHECK(typeof(value)='integer' AND value>=0), PRIMARY KEY(kind,item_id))`,
    `INSERT INTO entity_incarnations(kind,item_id,value) SELECT 'fact',id,0 FROM facts`,
    `INSERT INTO entity_incarnations(kind,item_id,value) SELECT 'role',id,0 FROM roles`,
    ...["INSERT", "UPDATE", "DELETE"].map((action) =>
      `CREATE TRIGGER entity_incarnations_guard_${action.toLowerCase()} BEFORE ${action} ON entity_incarnations WHEN NOT EXISTS(SELECT 1 FROM entity_incarnation_guard WHERE slot=1) BEGIN SELECT RAISE(ABORT, 'incarnation_guard_required'); END`),
    ...([
      ["facts", "fact", ["role_id", "kind", "text", "level", "level_revision", "evidence_id", "source_id", "origin", "state", "revision"]],
      ["roles", "role", ["kind", "org", "title", "start_date", "end_date", "unknown_end_start_date", "evidence_id", "source_id", "state", "revision"]],
    ] as const).flatMap(([table, kind, fields]) => [
      `CREATE TRIGGER ${table}_incarnation_capacity BEFORE INSERT ON ${table} WHEN NOT EXISTS(SELECT 1 FROM entity_incarnation_clock WHERE slot=1 AND typeof(value)='integer' AND value<9007199254740991) BEGIN SELECT RAISE(ABORT, 'incarnation_clock_exhausted'); END`,
      `CREATE TRIGGER ${table}_incarnation_insert AFTER INSERT ON ${table} BEGIN
         INSERT INTO entity_incarnation_guard(slot) VALUES(1);
         UPDATE entity_incarnation_clock SET value=value+1 WHERE slot=1;
         INSERT INTO entity_incarnations(kind,item_id,value) SELECT '${kind}',NEW.id,value FROM entity_incarnation_clock WHERE slot=1 ON CONFLICT(kind,item_id) DO UPDATE SET value=excluded.value;
         DELETE FROM entity_incarnation_guard WHERE slot=1;
       END`,
      `CREATE TRIGGER ${table}_incarnation_delete AFTER DELETE ON ${table} BEGIN
         INSERT INTO entity_incarnation_guard(slot) VALUES(1);
         DELETE FROM entity_incarnations WHERE kind='${kind}' AND item_id=OLD.id;
         DELETE FROM entity_incarnation_guard WHERE slot=1;
       END`,
      `CREATE TRIGGER ${table}_incarnation_id BEFORE UPDATE OF id ON ${table} WHEN NEW.id IS NOT OLD.id BEGIN SELECT RAISE(ABORT, 'record_id_immutable'); END`,
      `CREATE TRIGGER ${table}_incarnation_update_capacity BEFORE UPDATE OF ${fields.join(",")} ON ${table}
       WHEN (${fields.map((field) => `NEW.${field} IS NOT OLD.${field}`).join(" OR ")}) AND
         (NOT EXISTS(SELECT 1 FROM entity_incarnation_clock WHERE slot=1 AND typeof(value)='integer' AND value<9007199254740991)
          OR NOT EXISTS(SELECT 1 FROM entity_incarnations WHERE kind='${kind}' AND item_id=OLD.id))
       BEGIN SELECT RAISE(ABORT, 'incarnation_update_invalid'); END`,
      `CREATE TRIGGER ${table}_incarnation_update AFTER UPDATE OF ${fields.join(",")} ON ${table}
       WHEN ${fields.map((field) => `NEW.${field} IS NOT OLD.${field}`).join(" OR ")}
       BEGIN
         INSERT INTO entity_incarnation_guard(slot) VALUES(1);
         UPDATE entity_incarnation_clock SET value=value+1 WHERE slot=1;
         UPDATE entity_incarnations SET value=(SELECT value FROM entity_incarnation_clock WHERE slot=1) WHERE kind='${kind}' AND item_id=NEW.id;
         DELETE FROM entity_incarnation_guard WHERE slot=1;
       END`,
    ]),
    // Evidence can change independently of its fact or role. Rotate the
    // referenced tokens when evidence is edited, deleted or replaced, even
    // if its original contents are later restored.
    ...(["INSERT", "UPDATE", "DELETE"] as const).flatMap((action) => {
      const row = action === "DELETE" ? "OLD" : "NEW";
      const changed = action === "UPDATE"
        ? "(NEW.quote IS NOT OLD.quote OR NEW.source_id IS NOT OLD.source_id OR NEW.source_revision_id IS NOT OLD.source_revision_id OR NEW.start IS NOT OLD.start OR NEW.end IS NOT OLD.end) AND "
        : "";
      const referenced = `(EXISTS(SELECT 1 FROM facts WHERE evidence_id=${row}.id) OR EXISTS(SELECT 1 FROM roles WHERE evidence_id=${row}.id))`;
      const missing = `(EXISTS(SELECT 1 FROM facts f LEFT JOIN entity_incarnations i ON i.kind='fact' AND i.item_id=f.id WHERE f.evidence_id=${row}.id AND i.item_id IS NULL)
        OR EXISTS(SELECT 1 FROM roles r LEFT JOIN entity_incarnations i ON i.kind='role' AND i.item_id=r.id WHERE r.evidence_id=${row}.id AND i.item_id IS NULL))`;
      return [
        `CREATE TRIGGER evidence_incarnation_${action.toLowerCase()}_capacity BEFORE ${action} ON evidence WHEN ${changed}${referenced} AND
          (${missing} OR NOT EXISTS(SELECT 1 FROM entity_incarnation_clock WHERE slot=1 AND typeof(value)='integer' AND value<9007199254740991))
          BEGIN SELECT RAISE(ABORT, 'incarnation_update_invalid'); END`,
        `CREATE TRIGGER evidence_incarnation_${action.toLowerCase()} AFTER ${action} ON evidence WHEN ${changed}${referenced} BEGIN
          INSERT INTO entity_incarnation_guard(slot) VALUES(1);
          UPDATE entity_incarnation_clock SET value=value+1 WHERE slot=1;
          UPDATE entity_incarnations SET value=(SELECT value FROM entity_incarnation_clock WHERE slot=1)
            WHERE (kind='fact' AND item_id IN (SELECT id FROM facts WHERE evidence_id=${row}.id))
               OR (kind='role' AND item_id IN (SELECT id FROM roles WHERE evidence_id=${row}.id));
          DELETE FROM entity_incarnation_guard WHERE slot=1;
        END`,
      ];
    }),
    `CREATE TRIGGER evidence_incarnation_id BEFORE UPDATE OF id ON evidence WHEN NEW.id IS NOT OLD.id BEGIN SELECT RAISE(ABORT, 'record_id_immutable'); END`,
    `ALTER TABLE generation_input_items ADD COLUMN incarnation INTEGER`,
  ],
  [
    // SHA-256 of an uploaded file's bytes, so a second copy of the same file can be refused.
    // Sources uploaded before this have none, so they never block a new upload.
    `ALTER TABLE sources ADD COLUMN sha256 TEXT`,
    `CREATE INDEX sources_sha256 ON sources (sha256)`,
  ],
  [
    // A link to the original posting, and whether the person named the job themselves. Once
    // they have, reading the posting never replaces their title or company.
    `ALTER TABLE applications ADD COLUMN url TEXT`,
    `ALTER TABLE applications ADD COLUMN details_edited INTEGER NOT NULL DEFAULT 0`,
  ],
  [...SHARE_DETAIL_MIGRATIONS],
  [...SHARE_DOCUMENT_MIGRATIONS],
  [...RECORD_MIGRATIONS],
  [...SHARE_COACH_MIGRATIONS, ...COACH_CLIENT_MIGRATIONS],
  [...PREFERENCES_MIGRATIONS],
  [...SENSITIVE_MIGRATIONS],
  [...SHARE_COMMENT_MIGRATIONS],
  [...SHARE_SUGGESTION_MIGRATIONS],
  [...SAVED_ANSWER_MIGRATIONS],
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** True once init() has created the schema. */
export function hasSchema(sql: SqlStorage): boolean {
  return (
    sql
      .exec(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'`,
      )
      .toArray().length > 0
  );
}

/** Applies any migrations newer than the vault's recorded version. */
export function migrate(sql: SqlStorage, transaction: <T>(fn: () => T) => T): void {
  const row = sql
    .exec<{ value: string }>(
      `SELECT value FROM meta WHERE key = 'schema_version'`,
    )
    .toArray()[0];
  let version = row ? Number(row.value) : NaN;
  // A worker that predates a schema migration cannot safely interpret its
  // data or uphold the newer schema's invariants. Refuse such a rollback,
  // and refuse malformed version markers instead of silently skipping all
  // migrations (for example, because Number("invalid") is NaN).
  if (!row || !/^[1-9][0-9]*$/.test(row.value) ||
      !Number.isSafeInteger(version) || version > SCHEMA_VERSION)
    throw new Error("unsupported vault schema version");
  while (version < MIGRATIONS.length) {
    const next = version + 1;
    transaction(() => {
      for (const statement of MIGRATIONS[version] ?? []) sql.exec(statement);
      sql.exec(
        `INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        String(next),
      );
    });
    version = next;
  }
}

/** Creates the first version of the schema, for init(). */
export function createSchema(sql: SqlStorage, transaction: <T>(fn: () => T) => T): void {
  transaction(() => {
    for (const statement of MIGRATIONS[0] ?? []) sql.exec(statement);
    sql.exec(
      `INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')`,
    );
  });
  migrate(sql, transaction);
}
