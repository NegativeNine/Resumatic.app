import { INTERVIEW_MIGRATIONS } from "./interview";
import { FEEDBACK_MIGRATIONS } from "./extraction-feedback";
import { UPLOAD_MIGRATIONS } from "./uploads";
import { OPERATION_MIGRATIONS } from "./operations";
import { MCP_MIGRATIONS } from "./mcp-grants";
import { RUN_MIGRATIONS } from "./runs";
import { SHARE_MIGRATIONS } from "./shares";
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
  let version = row ? Number(row.value) : 0;
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
