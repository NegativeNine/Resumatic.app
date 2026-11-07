import { BILLING_MIGRATIONS, BILLING_DEFERRED_MIGRATIONS, BILLING_DELIVERY_RETRY_MIGRATIONS, BILLING_EVENT_INCARNATION_MIGRATIONS, BILLING_ACCOUNT_STATE_MIGRATIONS } from "./billing";
import { PLACEMENT_FENCE_MIGRATIONS } from "./placement-fence";
import { INVITE_BINDING_MIGRATIONS } from "./invite-binding";
import { INVITE_INVENTORY_MIGRATIONS } from "./invite-inventory";
import { INVITE_COORDINATOR_MIGRATIONS, INVITE_COORDINATOR_TARGET_MIGRATIONS } from "./invite-coordinator";
import { SHARD_INVITE_BINDING_MIGRATIONS } from "./shard-invite-binding";
import { INVITE_TARGET_SEAL_MIGRATIONS } from "./invite-target-seal";
import { SHARD_CLAIM_REVOCATION_MIGRATIONS } from "./shard-claim-revocation";
import { INVITE_REVOCATION_MIGRATIONS, INVITE_QUARANTINE_MIGRATIONS, INVITE_GLOBAL_ORPHAN_MIGRATIONS } from "./invite-revocation";
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
  [
    `CREATE TABLE global_auth_marker (slot INTEGER PRIMARY KEY CHECK(slot=1), epoch INTEGER NOT NULL)`,
    `CREATE TRIGGER global_auth_delete_epoch AFTER UPDATE OF state ON users
     WHEN OLD.state <> 'deleting' AND NEW.state = 'deleting'
       AND EXISTS(SELECT 1 FROM meta WHERE key='global_auth_guard' AND value='1')
     BEGIN
       SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM meta WHERE key='global_auth_epoch'
         AND value = CAST(CAST(value AS INTEGER) AS TEXT)
         AND CAST(value AS INTEGER) BETWEEN 0 AND 9007199254740990)
         THEN RAISE(ABORT, 'global_auth_epoch_invalid') END;
       UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key='global_auth_epoch';
     END`,
    `CREATE TRIGGER global_auth_identity_insert BEFORE INSERT ON identities
     WHEN NEW.provider='google'
       AND EXISTS(SELECT 1 FROM meta WHERE key='global_auth_guard' AND value='1')
       AND NOT EXISTS(SELECT 1 FROM global_auth_marker WHERE slot=1 AND epoch = CAST((SELECT value FROM meta WHERE key='global_auth_epoch') AS INTEGER))
     BEGIN SELECT RAISE(ABORT, 'global_auth_required'); END`,
    `CREATE TRIGGER global_auth_identity_delete BEFORE DELETE ON identities
     WHEN OLD.provider='google'
       AND EXISTS(SELECT 1 FROM meta WHERE key='global_auth_guard' AND value='1')
     BEGIN
       SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM meta WHERE key='global_auth_epoch'
         AND value = CAST(CAST(value AS INTEGER) AS TEXT)
         AND CAST(value AS INTEGER) BETWEEN 0 AND 9007199254740990)
         THEN RAISE(ABORT, 'global_auth_epoch_invalid') END;
       UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key='global_auth_epoch';
     END`,
    `CREATE TRIGGER global_auth_home_insert BEFORE INSERT ON identity_homes
     WHEN NEW.provider='google'
       AND EXISTS(SELECT 1 FROM meta WHERE key='global_auth_guard' AND value='1')
       AND NOT EXISTS(SELECT 1 FROM global_auth_marker WHERE slot=1 AND epoch = CAST((SELECT value FROM meta WHERE key='global_auth_epoch') AS INTEGER))
     BEGIN SELECT RAISE(ABORT, 'global_auth_required'); END`,
    `CREATE TRIGGER global_auth_home_bind BEFORE UPDATE OF user_id ON identity_homes
     WHEN NEW.provider='google'
       AND EXISTS(SELECT 1 FROM meta WHERE key='global_auth_guard' AND value='1')
       AND NOT EXISTS(SELECT 1 FROM global_auth_marker WHERE slot=1 AND epoch = CAST((SELECT value FROM meta WHERE key='global_auth_epoch') AS INTEGER))
     BEGIN SELECT RAISE(ABORT, 'global_auth_required'); END`,
  ],
  [
    // A successful global release is durably acknowledged before other
    // cleanup can retry. Ambiguous replies remain pending and are retried.
    `CREATE TABLE shard_deletion_releases (user_id TEXT NOT NULL, provider TEXT NOT NULL, subject TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','acknowledged')), PRIMARY KEY(user_id,provider,subject))`,
    // These markers exist only inside the transactions making the corresponding
    // deletion. They let migrated SQLite reject legacy alarm code that would
    // otherwise bypass the versioned epoch barrier.
    `CREATE TABLE shard_identity_delete_marker (user_id TEXT PRIMARY KEY)`,
    `CREATE TABLE global_shard_home_release_marker (provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY(provider,subject,user_id))`,
    `CREATE TRIGGER guard_shard_google_identity_delete BEFORE DELETE ON identities
     WHEN OLD.provider='google' AND EXISTS(SELECT 1 FROM meta WHERE key='shard_deletion_guard' AND value='1')
       AND NOT EXISTS(SELECT 1 FROM shard_identity_delete_marker WHERE user_id=OLD.user_id)
     BEGIN SELECT RAISE(ABORT, 'shard_deletion_barrier_required'); END`,
    `CREATE TRIGGER guard_global_google_shard_home_delete BEFORE DELETE ON identity_homes
     WHEN OLD.provider='google' AND OLD.shard IS NOT NULL
       AND EXISTS(SELECT 1 FROM meta WHERE key='global_auth_guard' AND value='1')
       AND NOT EXISTS(SELECT 1 FROM global_shard_home_release_marker WHERE provider=OLD.provider AND subject=OLD.subject AND user_id=OLD.user_id)
     BEGIN SELECT RAISE(ABORT, 'shard_deletion_barrier_required'); END`,
  ],
  BILLING_DEFERRED_MIGRATIONS,
  BILLING_DELIVERY_RETRY_MIGRATIONS,
  [
    `ALTER TABLE shard_deletion_releases ADD COLUMN fence_epoch INTEGER`,
    `CREATE TABLE shard_auth_marker (slot INTEGER PRIMARY KEY CHECK(slot=1), epoch INTEGER NOT NULL)`,
    `CREATE TABLE shard_google_delete_v3_marker (user_id TEXT PRIMARY KEY)`,
    `CREATE TABLE global_google_release_v3_marker (provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY(provider,subject,user_id))`,
    `CREATE TRIGGER guard_shard_google_insert_v3 BEFORE INSERT ON identities
     WHEN NEW.provider='google' AND EXISTS(SELECT 1 FROM meta WHERE key='shard_auth_floor_guard' AND value='1')
       AND NOT EXISTS(SELECT 1 FROM shard_auth_marker WHERE slot=1 AND epoch >= CAST((SELECT value FROM meta WHERE key='shard_auth_floor') AS INTEGER))
     BEGIN SELECT RAISE(ABORT, 'shard_auth_required'); END`,
    `CREATE TRIGGER guard_shard_google_delete_v3 BEFORE DELETE ON identities
     WHEN OLD.provider='google' AND EXISTS(SELECT 1 FROM meta WHERE key='shard_auth_floor_guard' AND value='1')
       AND NOT EXISTS(SELECT 1 FROM shard_google_delete_v3_marker m JOIN shard_deletion_releases r ON r.user_id=m.user_id
         WHERE m.user_id=OLD.user_id AND r.provider=OLD.provider AND r.subject=OLD.subject AND r.state='acknowledged'
           AND r.fence_epoch IS NOT NULL AND r.fence_epoch <= CAST((SELECT value FROM meta WHERE key='shard_auth_floor') AS INTEGER))
     BEGIN SELECT RAISE(ABORT, 'shard_auth_floor_required'); END`,
    `CREATE TRIGGER guard_global_google_release_v3 BEFORE DELETE ON identity_homes
     WHEN OLD.provider='google' AND OLD.shard IS NOT NULL AND EXISTS(SELECT 1 FROM meta WHERE key='global_shard_release_v3_guard' AND value='1')
       AND NOT EXISTS(SELECT 1 FROM global_google_release_v3_marker WHERE provider=OLD.provider AND subject=OLD.subject AND user_id=OLD.user_id)
     BEGIN SELECT RAISE(ABORT, 'shard_auth_floor_required'); END`,
  ],
  [
    // The global object records a rollout barrier without retaining identity
    // data. Every shard installs it before accepting a request after upgrade.
    `CREATE TABLE shard_rollout_barrier (slot INTEGER PRIMARY KEY CHECK(slot=1), epoch INTEGER NOT NULL)`,
  ],
  [
    // A fresh sharded claim and its target identity share an opaque token.
    // Older generation-less homes are deliberately not backfilled.
    `CREATE TABLE shard_home_claim_tokens (provider TEXT NOT NULL, subject TEXT NOT NULL, token TEXT NOT NULL, PRIMARY KEY(provider,subject))`,
    `CREATE TABLE shard_identity_claim_tokens (provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, token TEXT NOT NULL, PRIMARY KEY(provider,subject))`,
    `CREATE TABLE shard_home_bind_claim_marker (provider TEXT NOT NULL, subject TEXT NOT NULL, token TEXT NOT NULL, PRIMARY KEY(provider,subject))`,
    `CREATE TRIGGER guard_shard_home_claim_bind BEFORE UPDATE OF user_id ON identity_homes
       WHEN OLD.provider='google' AND OLD.shard IS NOT NULL AND OLD.user_id IS NULL AND NEW.user_id IS NOT NULL
         AND EXISTS(SELECT 1 FROM shard_home_claim_tokens t WHERE t.provider=OLD.provider AND t.subject=OLD.subject)
         AND NOT EXISTS(SELECT 1 FROM shard_home_bind_claim_marker m JOIN shard_home_claim_tokens t ON t.provider=m.provider AND t.subject=m.subject AND t.token=m.token WHERE m.provider=OLD.provider AND m.subject=OLD.subject)
       BEGIN SELECT RAISE(ABORT, 'shard_claim_required'); END`,
    `CREATE TRIGGER remove_shard_home_claim_token AFTER DELETE ON identity_homes BEGIN DELETE FROM shard_home_claim_tokens WHERE provider=OLD.provider AND subject=OLD.subject; END`,
    `CREATE TRIGGER remove_shard_identity_claim_on_identity AFTER DELETE ON identities BEGIN DELETE FROM shard_identity_claim_tokens WHERE provider=OLD.provider AND subject=OLD.subject AND user_id=OLD.user_id; END`,
    `CREATE TRIGGER remove_shard_identity_claim_token AFTER DELETE ON users BEGIN DELETE FROM shard_identity_claim_tokens WHERE user_id=OLD.user_id; END`,
  ],
  BILLING_EVENT_INCARNATION_MIGRATIONS,
  BILLING_ACCOUNT_STATE_MIGRATIONS,
  [`ALTER TABLE retired_vaults ADD COLUMN generation TEXT`],
  [
    // The active Vault remains closed until its delayed final R2 sweep. Older
    // swept rows have no owner proof and are intentionally not backfilled.
    `CREATE TABLE account_final_sweeps (vault_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, generation TEXT NOT NULL, swept_at INTEGER NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('awaiting','destroyed')))`,
    // An older finalizer must not remove the Directory's last account link
    // for a swept Vault whose current destruction has not been acknowledged.
    `CREATE TRIGGER guard_account_finalization BEFORE DELETE ON vaults
     WHEN OLD.state='swept' AND NOT EXISTS(SELECT 1 FROM account_final_sweeps a WHERE a.vault_id=OLD.vault_id AND a.user_id=OLD.user_id AND a.swept_at=OLD.swept_at AND a.phase='destroyed')
     BEGIN SELECT RAISE(ABORT, 'account_finalization_requires_destroy'); END`,
  ],
  [
    // Existing invites receive distinct incarnations. The trigger also covers
    // older INSERT statements after this migration has been installed.
    `ALTER TABLE invites ADD COLUMN generation TEXT`,
    `UPDATE invites SET generation=lower(hex(randomblob(16))) WHERE generation IS NULL`,
    `CREATE TRIGGER assign_invite_generation AFTER INSERT ON invites WHEN NEW.generation IS NULL
     BEGIN UPDATE invites SET generation=lower(hex(randomblob(16))) WHERE email=NEW.email; END`,
    // INSERT OR IGNORE is used by older and current admin paths. A repeated
    // issuance is a new grant even while its previous row still exists.
    `CREATE TRIGGER rotate_reissued_invite BEFORE INSERT ON invites WHEN EXISTS(SELECT 1 FROM invites WHERE email=NEW.email)
     BEGIN UPDATE invites SET generation=lower(hex(randomblob(16))),created_at=NEW.created_at WHERE email=NEW.email; END`,
    `CREATE TABLE invite_delete_permits (email TEXT PRIMARY KEY)`,
    // An older alarm must not remove a reissued invite without the captured
    // generation. Current administrative revocation installs a permit too.
    `CREATE TRIGGER guard_invite_delete BEFORE DELETE ON invites
     WHEN NOT EXISTS(SELECT 1 FROM invite_delete_permits WHERE email=OLD.email)
     BEGIN SELECT RAISE(ABORT, 'invite_delete_permit_required'); END`,
    // Closed receipts keep only the random operation ID, fencing late RPCs
    // without retaining the removed account's email, user ID or vault ID.
    `CREATE TABLE invite_deletion_receipts (
       operation_id TEXT PRIMARY KEY, user_id TEXT, vault_id TEXT, email TEXT, generation TEXT,
       state TEXT NOT NULL CHECK(state IN ('captured','removed','closed'))
     )`,
    `CREATE TABLE account_invite_deletions (user_id TEXT PRIMARY KEY, vault_id TEXT NOT NULL UNIQUE, operation_id TEXT NOT NULL UNIQUE)`,
    // A legacy finalizer cannot discard the account link before the global
    // invite receipt has been closed and redacted, even when DELETE matched no invite.
    `ALTER TABLE account_final_sweeps ADD COLUMN invite_closed INTEGER NOT NULL DEFAULT 0 CHECK(invite_closed IN (0,1))`,
    `DROP TRIGGER guard_account_finalization`,
    `CREATE TRIGGER guard_account_finalization BEFORE DELETE ON vaults
     WHEN OLD.state='swept' AND NOT EXISTS(SELECT 1 FROM account_final_sweeps a WHERE a.vault_id=OLD.vault_id AND a.user_id=OLD.user_id AND a.swept_at=OLD.swept_at AND a.phase='destroyed' AND a.invite_closed=1)
     BEGIN SELECT RAISE(ABORT, 'account_finalization_requires_destroy'); END`,
  ],
  [
    // Older finalizers could create the original permit and then delete an
    // invitation captured after it was reissued. Only the current code can
    // create the additional, transaction-scoped authorization.
    `CREATE TABLE invite_delete_authorizations (email TEXT PRIMARY KEY)`,
    `CREATE TRIGGER guard_invite_delete_permit BEFORE INSERT ON invite_delete_permits
     WHEN NOT EXISTS(SELECT 1 FROM invite_delete_authorizations WHERE email=NEW.email)
     BEGIN SELECT RAISE(ABORT, 'invite_delete_authorization_required'); END`,
  ],
  INVITE_BINDING_MIGRATIONS,
  INVITE_INVENTORY_MIGRATIONS,
  INVITE_COORDINATOR_MIGRATIONS,
  SHARD_INVITE_BINDING_MIGRATIONS,
  INVITE_TARGET_SEAL_MIGRATIONS,
  INVITE_COORDINATOR_TARGET_MIGRATIONS,
  SHARD_CLAIM_REVOCATION_MIGRATIONS,
  INVITE_REVOCATION_MIGRATIONS,
  INVITE_QUARANTINE_MIGRATIONS,
  INVITE_GLOBAL_ORPHAN_MIGRATIONS,
];

export function migrateDirectory(sql: SqlStorage, transaction: <T>(fn: () => T) => T, global = false, shard = false): void {
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
      // Install the global fence together with its triggers. A crash between
      // migration and activation must not leave old writers unfenced.
      if (global && next === 8) {
        sql.exec(`INSERT INTO meta(key,value) VALUES ('global_auth_epoch','0')`);
        sql.exec(`INSERT INTO meta(key,value) VALUES ('global_auth_guard','1')`);
      }
      if (shard && next === 9)
        sql.exec(`INSERT INTO meta(key,value) VALUES ('shard_deletion_guard','1')`);
      if (next === 12 && shard) {
        sql.exec(`INSERT INTO meta(key,value) VALUES ('shard_auth_floor','0')`);
        sql.exec(`INSERT INTO meta(key,value) VALUES ('shard_auth_floor_guard','1')`);
      }
      if (next === 12 && global)
        sql.exec(`INSERT INTO meta(key,value) VALUES ('global_shard_release_v3_guard','1')`);
      if (next === 13 && global) {
        const raw = sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='global_auth_epoch'`).one().value;
        const previous = Number(raw);
        if (!/^(?:0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(previous) || previous >= Number.MAX_SAFE_INTEGER)
          throw new Error("sign-in coordinator requires review");
        const barrier = previous + 1;
        sql.exec(`UPDATE meta SET value=? WHERE key='global_auth_epoch'`, String(barrier));
        sql.exec(`INSERT INTO shard_rollout_barrier(slot,epoch) VALUES (1,?)`, barrier);
      }
      sql.exec(
        `INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        String(next),
      );
    });
    version = next;
  }
}
