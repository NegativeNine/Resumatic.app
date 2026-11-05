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
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** True once init() has created the schema. */
export function hasSchema(sql: SqlStorage): boolean {
  return sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).toArray().length > 0;
}

/** Applies any migrations newer than the vault's recorded version. */
export function migrate(sql: SqlStorage): void {
  const row = sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`).toArray()[0];
  let version = row ? Number(row.value) : 0;
  while (version < MIGRATIONS.length) {
    for (const statement of MIGRATIONS[version] ?? []) sql.exec(statement);
    version += 1;
    sql.exec(
      `INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      String(version),
    );
  }
}

/** Creates the first version of the schema, for init(). */
export function createSchema(sql: SqlStorage): void {
  for (const statement of MIGRATIONS[0] ?? []) sql.exec(statement);
  sql.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')`);
  migrate(sql);
}
