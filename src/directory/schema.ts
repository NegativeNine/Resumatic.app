import { BILLING_MIGRATIONS } from "./billing";
import { PLACEMENT_FENCE_MIGRATIONS } from "./placement-fence";
// Directory tables. Holds identities and the vault directory; never career data.

export const DIRECTORY_MIGRATIONS: readonly string[][] = [
  [
    `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY, email TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS identities (
      provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users (user_id),
      PRIMARY KEY (provider, subject)
    )`,
    `CREATE TABLE IF NOT EXISTS vaults (
      vault_id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users (user_id),
      hint TEXT NOT NULL, state TEXT NOT NULL, swept_at INTEGER, updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS invites (email TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS vaults_by_state ON vaults (state)`,
  ],
  BILLING_MIGRATIONS,
  [
    `ALTER TABLE vaults ADD COLUMN stripe_customer TEXT`,
    `CREATE TABLE identity_homes (provider TEXT NOT NULL,subject TEXT NOT NULL,shard INTEGER,user_id TEXT,PRIMARY KEY(provider,subject))`,
    `CREATE TABLE vault_replacements (operation_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, user_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'preparing')`,
    `CREATE TABLE retired_vaults (vault_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'deleting',swept_at INTEGER)`,
  ],
  [
    `CREATE TABLE vault_initializations (vault_id TEXT PRIMARY KEY)`,
    // Older sign-in and replacement attempts may still be in flight even if
    // another concurrent request already marked the same object active.
    `INSERT OR IGNORE INTO vault_initializations (vault_id) SELECT vault_id FROM vaults`,
    `INSERT OR IGNORE INTO vault_initializations (vault_id) SELECT target_id FROM vault_replacements`,
    `INSERT OR IGNORE INTO vault_initializations (vault_id) SELECT vault_id FROM retired_vaults`,
  ],
  [
    // Existing markers represent unknown outcomes. A retry must never erase
    // them merely because its own acknowledgement arrived.
    `ALTER TABLE vault_initializations ADD COLUMN sticky INTEGER NOT NULL DEFAULT 1 CHECK (sticky IN (0, 1))`,
    // Older implementations used an unconditional DELETE after init. Protect
    // sticky rows at the database boundary as well as in current code.
    `CREATE TRIGGER guard_sticky_vault_initializations BEFORE DELETE ON vault_initializations WHEN OLD.sticky = 1 BEGIN SELECT RAISE(IGNORE); END`,
  ],
  [`ALTER TABLE vaults ADD COLUMN stripe_checkout_sessions TEXT NOT NULL DEFAULT '[]'`],
  [...PLACEMENT_FENCE_MIGRATIONS],
];

export function migrateDirectory(sql: SqlStorage, transaction: <T>(fn: () => T) => T): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  );
  const row = sql
    .exec<{ value: string }>(
      `SELECT value FROM meta WHERE key = 'schema_version'`,
    )
    .toArray()[0];
  let version = row ? Number(row.value) : 0;
  while (version < DIRECTORY_MIGRATIONS.length) {
    const next = version + 1;
    transaction(() => {
      for (const statement of DIRECTORY_MIGRATIONS[version] ?? [])
        sql.exec(statement);
      sql.exec(
        `INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        String(next),
      );
    });
    version = next;
  }
}
