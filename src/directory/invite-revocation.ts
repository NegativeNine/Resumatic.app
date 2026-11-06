import { AppError } from "../shared/errors";
import { directoryNameForUser } from "../shared/operations";
import { validShardInviteClaim } from "./shard-invite-binding";
import type { RevokedShardClaim, ShardClaimSeal } from "./shard-claim-revocation";

/**
 * An in-flight revocation is scoped to one normalized email. The marker is
 * transaction-local in normal use: old code cannot create a new shard home
 * while a revocation is running without identifying its authorized email.
 */
export const INVITE_REVOCATION_MIGRATIONS: string[] = [
  `CREATE TABLE invite_revocation_barrier (
    slot INTEGER PRIMARY KEY CHECK(slot=1), operation_id TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL, email_fingerprint TEXT NOT NULL, generation TEXT, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE invite_revocation_claims (
    operation_id TEXT NOT NULL, token TEXT NOT NULL, provider TEXT NOT NULL, subject TEXT NOT NULL,
    shard INTEGER NOT NULL, email TEXT NOT NULL, generation TEXT,
    state TEXT NOT NULL CHECK(state IN ('pending','absent','created','closed')),
    user_id TEXT, vault_id TEXT, PRIMARY KEY(operation_id,token)
  )`,
  // A completed operation retains only its opaque ID. Replaying it can never
  // revoke a later invitation, even if a response was lost.
  `CREATE TABLE invite_revocation_receipts (operation_id TEXT PRIMARY KEY, email_fingerprint TEXT NOT NULL)`,
  `CREATE TABLE invite_revocation_mutation_marker (slot INTEGER PRIMARY KEY CHECK(slot=1), operation_id TEXT NOT NULL)`,
  `CREATE TABLE invite_registration_marker (slot INTEGER PRIMARY KEY CHECK(slot=1), email TEXT NOT NULL)`,
  `CREATE TABLE invite_delete_authorizations_v4 (email TEXT PRIMARY KEY)`,
  // Only a sealed, durably closed unbound claim may release its placement.
  // Bound accounts still require the original owner-checked deletion markers.
  `DROP TRIGGER guard_global_google_shard_home_delete`,
  `CREATE TRIGGER guard_global_google_shard_home_delete BEFORE DELETE ON identity_homes
   WHEN OLD.provider='google' AND OLD.shard IS NOT NULL
    AND EXISTS(SELECT 1 FROM meta WHERE key='global_auth_guard' AND value='1')
    AND NOT EXISTS(SELECT 1 FROM global_shard_home_release_marker WHERE provider=OLD.provider AND subject=OLD.subject AND user_id=OLD.user_id)
    AND NOT (OLD.user_id IS NULL AND EXISTS(SELECT 1 FROM invite_revocation_mutation_marker m
      JOIN invite_revocation_barrier b ON b.operation_id=m.operation_id
      JOIN invite_revocation_claims r ON r.operation_id=b.operation_id AND r.provider=OLD.provider AND r.subject=OLD.subject AND r.shard=OLD.shard AND r.email=b.email AND r.state='closed'
      JOIN shard_home_invite_claims c ON c.provider=r.provider AND c.subject=r.subject AND c.token=r.token AND c.user_id IS NULL))
   BEGIN SELECT RAISE(ABORT, 'shard_deletion_barrier_required'); END`,
  `DROP TRIGGER guard_global_google_release_v3`,
  `CREATE TRIGGER guard_global_google_release_v3 BEFORE DELETE ON identity_homes
   WHEN OLD.provider='google' AND OLD.shard IS NOT NULL
    AND EXISTS(SELECT 1 FROM meta WHERE key='global_shard_release_v3_guard' AND value='1')
    AND NOT EXISTS(SELECT 1 FROM global_google_release_v3_marker WHERE provider=OLD.provider AND subject=OLD.subject AND user_id=OLD.user_id)
    AND NOT (OLD.user_id IS NULL AND EXISTS(SELECT 1 FROM invite_revocation_mutation_marker m
      JOIN invite_revocation_barrier b ON b.operation_id=m.operation_id
      JOIN invite_revocation_claims r ON r.operation_id=b.operation_id AND r.provider=OLD.provider AND r.subject=OLD.subject AND r.shard=OLD.shard AND r.email=b.email AND r.state='closed'
      JOIN shard_home_invite_claims c ON c.provider=r.provider AND c.subject=r.subject AND c.token=r.token AND c.user_id IS NULL))
   BEGIN SELECT RAISE(ABORT, 'shard_auth_floor_required'); END`,
  `CREATE TRIGGER guard_invite_delete_authorization_v4 BEFORE INSERT ON invite_delete_authorizations_v3
   WHEN NOT EXISTS(SELECT 1 FROM invite_delete_authorizations_v4 WHERE email=NEW.email)
   BEGIN SELECT RAISE(ABORT, 'invite_delete_authorization_v4_required'); END`,
  `CREATE TRIGGER invite_revocation_inventory_guard BEFORE INSERT ON invite_inventory_barrier
   WHEN EXISTS(SELECT 1 FROM invite_revocation_barrier)
   BEGIN SELECT RAISE(ABORT, 'invite_revocation_active'); END`,
  `CREATE TRIGGER invite_revocation_registration_guard BEFORE INSERT ON invite_registration_marker
   WHEN EXISTS(SELECT 1 FROM invite_revocation_barrier WHERE email=NEW.email)
   BEGIN SELECT RAISE(ABORT, 'invite_revocation_active'); END`,
  `CREATE TRIGGER invite_revocation_home_insert BEFORE INSERT ON identity_homes
   WHEN EXISTS(SELECT 1 FROM invite_revocation_barrier)
    AND NOT EXISTS(SELECT 1 FROM invite_registration_marker r JOIN invite_revocation_barrier b ON r.email<>b.email)
   BEGIN SELECT RAISE(ABORT, 'invite_registration_required'); END`,
  ...["INSERT", "UPDATE", "DELETE"].map((action) => {
    const changed = action === "INSERT" ? "NEW.email" : action === "DELETE" ? "OLD.email" : "OLD.email OR email=NEW.email";
    return `CREATE TRIGGER invite_revocation_invites_${action.toLowerCase()} BEFORE ${action} ON invites
      WHEN EXISTS(SELECT 1 FROM invite_revocation_barrier WHERE email=${changed})
       AND NOT EXISTS(SELECT 1 FROM invite_revocation_mutation_marker m JOIN invite_revocation_barrier b ON b.operation_id=m.operation_id)
      BEGIN SELECT RAISE(ABORT, 'invite_revocation_active'); END`;
  }),
  ...["INSERT", "UPDATE", "DELETE"].map((action) => {
    const changed = action === "INSERT" ? "NEW.email" : action === "DELETE" ? "OLD.email" : "OLD.email OR email=NEW.email";
    return `CREATE TRIGGER invite_revocation_claim_${action.toLowerCase()} BEFORE ${action} ON shard_home_invite_claims
      WHEN EXISTS(SELECT 1 FROM invite_revocation_barrier WHERE email=${changed})
       AND NOT EXISTS(SELECT 1 FROM invite_revocation_mutation_marker m JOIN invite_revocation_barrier b ON b.operation_id=m.operation_id)
      BEGIN SELECT RAISE(ABORT, 'invite_revocation_active'); END`;
  }),
  `CREATE TRIGGER invite_revocation_user_insert BEFORE INSERT ON users
   WHEN EXISTS(SELECT 1 FROM invite_revocation_barrier WHERE email=NEW.email)
   BEGIN SELECT RAISE(ABORT, 'invite_revocation_active'); END`,
  `CREATE TRIGGER invite_revocation_user_email BEFORE UPDATE OF email ON users
   WHEN EXISTS(SELECT 1 FROM invite_revocation_barrier WHERE email=OLD.email OR email=NEW.email)
   BEGIN SELECT RAISE(ABORT, 'invite_revocation_active'); END`,
  `CREATE TRIGGER invite_revocation_home_update BEFORE UPDATE ON identity_homes
   WHEN EXISTS(SELECT 1 FROM invite_revocation_barrier b WHERE
      EXISTS(SELECT 1 FROM shard_home_invite_claims c WHERE c.provider=OLD.provider AND c.subject=OLD.subject AND c.email=b.email)
      OR NEW.provider IS NOT OLD.provider OR NEW.subject IS NOT OLD.subject
      OR ((OLD.user_id IS NULL OR NEW.user_id IS NULL) AND NOT EXISTS(SELECT 1 FROM shard_home_invite_claims c WHERE c.provider=OLD.provider AND c.subject=OLD.subject)))
    AND NOT EXISTS(SELECT 1 FROM invite_revocation_mutation_marker m JOIN invite_revocation_barrier b ON b.operation_id=m.operation_id)
   BEGIN SELECT RAISE(ABORT, 'invite_revocation_active'); END`,
  `CREATE TRIGGER invite_revocation_home_delete BEFORE DELETE ON identity_homes
   WHEN EXISTS(SELECT 1 FROM invite_revocation_barrier b WHERE
      EXISTS(SELECT 1 FROM shard_home_invite_claims c WHERE c.provider=OLD.provider AND c.subject=OLD.subject AND c.email=b.email)
      OR (OLD.user_id IS NULL AND NOT EXISTS(SELECT 1 FROM shard_home_invite_claims c WHERE c.provider=OLD.provider AND c.subject=OLD.subject)))
    AND NOT EXISTS(SELECT 1 FROM invite_revocation_mutation_marker m JOIN invite_revocation_barrier b ON b.operation_id=m.operation_id)
   BEGIN SELECT RAISE(ABORT, 'invite_revocation_active'); END`,
  ...["INSERT", "UPDATE", "DELETE"].map((action) => {
    const ids = action === "INSERT" ? ["NEW"] : action === "DELETE" ? ["OLD"] : ["OLD", "NEW"];
    const affected = ids.map((id) => `(EXISTS(SELECT 1 FROM shard_home_invite_claims c
      WHERE c.provider=${id}.provider AND c.subject=${id}.subject AND c.email=b.email)
      OR EXISTS(SELECT 1 FROM identity_homes h WHERE h.provider=${id}.provider AND h.subject=${id}.subject AND h.user_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM shard_home_invite_claims c WHERE c.provider=h.provider AND c.subject=h.subject)))`).join(" OR ");
    return `CREATE TRIGGER invite_revocation_token_${action.toLowerCase()} BEFORE ${action} ON shard_home_claim_tokens
     WHEN EXISTS(SELECT 1 FROM invite_revocation_barrier b WHERE ${affected})
      AND NOT EXISTS(SELECT 1 FROM invite_revocation_mutation_marker m JOIN invite_revocation_barrier b ON b.operation_id=m.operation_id)
      AND NOT EXISTS(SELECT 1 FROM invite_registration_marker r JOIN invite_revocation_barrier b ON r.email<>b.email)
     BEGIN SELECT RAISE(ABORT, 'invite_revocation_active'); END`;
  }),
];

/** Detached, immutable per-email fences let unrelated operations make progress. */
export const INVITE_QUARANTINE_MIGRATIONS: string[] = [
  `CREATE TABLE invite_revocation_quarantines (
    operation_id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, email_fingerprint TEXT NOT NULL,
    generation TEXT, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE invite_quarantine_marker (slot INTEGER PRIMARY KEY CHECK(slot=1), operation_id TEXT NOT NULL)`,
  ...["INSERT", "UPDATE", "DELETE"].map((action) => {
    const id = action === "INSERT" ? "NEW" : "OLD";
    const guard = action === "UPDATE" ? "1" : action === "INSERT"
      ? `NOT EXISTS(SELECT 1 FROM invite_quarantine_marker m JOIN invite_revocation_barrier b ON b.operation_id=m.operation_id
          WHERE b.operation_id=NEW.operation_id AND b.email=NEW.email AND b.email_fingerprint=NEW.email_fingerprint
            AND b.generation IS NEW.generation AND b.created_at=NEW.created_at)`
      : `NOT EXISTS(SELECT 1 FROM invite_quarantine_marker WHERE operation_id=${id}.operation_id)`;
    return `CREATE TRIGGER invite_quarantine_${action.toLowerCase()} BEFORE ${action} ON invite_revocation_quarantines
      WHEN ${guard} BEGIN SELECT RAISE(ABORT, 'invite_quarantine_marker_required'); END`;
  }),
  `CREATE VIEW invite_revocation_fences AS
    SELECT operation_id,email,email_fingerprint,generation,created_at FROM invite_revocation_barrier
    UNION ALL SELECT operation_id,email,email_fingerprint,generation,created_at FROM invite_revocation_quarantines`,
  ...["inventory_guard", "registration_guard", "home_insert", ...["invites", "claim", "token"].flatMap((t) => ["insert", "update", "delete"].map((a) => `${t}_${a}`)), "user_insert", "user_email", "home_update", "home_delete"]
    .map((name) => `DROP TRIGGER invite_revocation_${name}`),
  // An inventory is globally exclusive with active sealing, but detached
  // quarantines only block inventories for their own email.
  `CREATE TRIGGER invite_revocation_inventory_guard BEFORE INSERT ON invite_inventory_barrier
   WHEN EXISTS(SELECT 1 FROM invite_revocation_barrier) OR EXISTS(SELECT 1 FROM invite_revocation_quarantines WHERE email=NEW.email)
   BEGIN SELECT RAISE(ABORT, 'invite_revocation_active'); END`,
  `CREATE TRIGGER invite_revocation_registration_guard BEFORE INSERT ON invite_registration_marker
   WHEN EXISTS(SELECT 1 FROM invite_revocation_fences WHERE email=NEW.email)
   BEGIN SELECT RAISE(ABORT, 'invite_revocation_active'); END`,
  `CREATE TRIGGER invite_revocation_home_insert BEFORE INSERT ON identity_homes
   WHEN EXISTS(SELECT 1 FROM invite_revocation_fences)
     AND NOT EXISTS(SELECT 1 FROM invite_registration_marker r WHERE NOT EXISTS(SELECT 1 FROM invite_revocation_fences b WHERE b.email=r.email))
   BEGIN SELECT RAISE(ABORT, 'invite_registration_required'); END`,
  ...["invites", "shard_home_invite_claims"].flatMap((table) => ["INSERT", "UPDATE", "DELETE"].map((action) => {
    const changed = action === "INSERT" ? "b.email=NEW.email" : action === "DELETE" ? "b.email=OLD.email" : "(b.email=OLD.email OR b.email=NEW.email)";
    const name = table === "invites" ? "invites" : "claim";
    return `CREATE TRIGGER invite_revocation_${name}_${action.toLowerCase()} BEFORE ${action} ON ${table}
      WHEN EXISTS(SELECT 1 FROM invite_revocation_fences b WHERE ${changed}
        AND NOT EXISTS(SELECT 1 FROM invite_revocation_mutation_marker m WHERE m.operation_id=b.operation_id))
      BEGIN SELECT RAISE(ABORT, 'invite_revocation_active'); END`;
  })),
  `CREATE TRIGGER invite_revocation_user_insert BEFORE INSERT ON users
   WHEN EXISTS(SELECT 1 FROM invite_revocation_fences WHERE email=NEW.email)
   BEGIN SELECT RAISE(ABORT, 'invite_revocation_active'); END`,
  `CREATE TRIGGER invite_revocation_user_email BEFORE UPDATE OF email ON users
   WHEN EXISTS(SELECT 1 FROM invite_revocation_fences WHERE email=OLD.email OR email=NEW.email)
   BEGIN SELECT RAISE(ABORT, 'invite_revocation_active'); END`,
  ...["UPDATE", "DELETE"].map((action) => {
    const identityChanged = action === "UPDATE" ? "OR NEW.provider IS NOT OLD.provider OR NEW.subject IS NOT OLD.subject" : "";
    const unbound = action === "UPDATE" ? "(OLD.user_id IS NULL OR NEW.user_id IS NULL)" : "OLD.user_id IS NULL";
    return `CREATE TRIGGER invite_revocation_home_${action.toLowerCase()} BEFORE ${action} ON identity_homes
      WHEN EXISTS(SELECT 1 FROM invite_revocation_fences b WHERE (
        EXISTS(SELECT 1 FROM shard_home_invite_claims c WHERE c.provider=OLD.provider AND c.subject=OLD.subject AND c.email=b.email)
        ${identityChanged}
        OR (${unbound} AND NOT EXISTS(SELECT 1 FROM shard_home_invite_claims c WHERE c.provider=OLD.provider AND c.subject=OLD.subject)))
        AND NOT EXISTS(SELECT 1 FROM invite_revocation_mutation_marker m WHERE m.operation_id=b.operation_id))
      BEGIN SELECT RAISE(ABORT, 'invite_revocation_active'); END`;
  }),
  ...["INSERT", "UPDATE", "DELETE"].map((action) => {
    const ids = action === "INSERT" ? ["NEW"] : action === "DELETE" ? ["OLD"] : ["OLD", "NEW"];
    const affected = ids.map((id) => `(EXISTS(SELECT 1 FROM shard_home_invite_claims c
      WHERE c.provider=${id}.provider AND c.subject=${id}.subject AND c.email=b.email)
      OR (EXISTS(SELECT 1 FROM identity_homes h WHERE h.provider=${id}.provider AND h.subject=${id}.subject AND h.user_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM shard_home_invite_claims c WHERE c.provider=h.provider AND c.subject=h.subject))
        AND NOT EXISTS(SELECT 1 FROM invite_registration_marker r WHERE NOT EXISTS(SELECT 1 FROM invite_revocation_fences f WHERE f.email=r.email))))`).join(" OR ");
    return `CREATE TRIGGER invite_revocation_token_${action.toLowerCase()} BEFORE ${action} ON shard_home_claim_tokens
      WHEN EXISTS(SELECT 1 FROM invite_revocation_fences b WHERE (${affected})
        AND NOT EXISTS(SELECT 1 FROM invite_revocation_mutation_marker m WHERE m.operation_id=b.operation_id))
      BEGIN SELECT RAISE(ABORT, 'invite_revocation_active'); END`;
  }),
];

type Barrier = { operation_id: string; email: string; email_fingerprint: string; generation: string | null };
type ClaimRow = RevokedShardClaim & { state: "pending" | "absent" | "created" | "closed"; user_id: string | null; vault_id: string | null } & Record<string, SqlStorageValue>;
type Deps = {
  sql: SqlStorage;
  storage: DurableObjectStorage;
  transaction: <T>(fn: () => T) => T;
  // A keyed digest binds a completed opaque operation to its normalized email
  // without retaining the email itself in the long-lived receipt.
  fingerprint: (operation: string, email: string) => Promise<string>;
  verifyRollout: () => void;
  seal: (claim: RevokedShardClaim) => Promise<ShardClaimSeal>;
  close: (claim: RevokedShardClaim) => Promise<void>;
  // Must delete only the captured generation, inside the caller's transaction.
  removeInvite: (email: string, generation: string) => void;
  waitMs?: number;
};
export type InviteRevocationStatus = { state: "pending"; remaining: number; orphans: number } | { state: "complete" } | { state: "unknown" };

// Canonical lowercase prevents replaying the same UUID with different casing.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RETRY_MS = 60_000;
const MAX_ROWS = 10_000;
const MAX_CLAIMS = 1_000;

/** Durable per-email barrier; never treats an unknown RPC result as absence. */
export class InviteRevocation {
  constructor(private readonly d: Deps) {}
  private row(): Barrier | undefined {
    return this.d.sql.exec<Barrier>(`SELECT operation_id,email,email_fingerprint,generation FROM invite_revocation_barrier WHERE slot=1`).toArray()[0];
  }
  active(): boolean { return !!this.row(); }
  activeOperation(operation: string): boolean { return this.row()?.operation_id === operation; }
  private validateOperation(operation: string): void {
    if (typeof operation !== "string" || !uuid.test(operation)) throw new AppError("invalid", "invalid invitation revocation");
  }

  status(operation: string): InviteRevocationStatus {
    this.validateOperation(operation);
    const active = this.row();
    const row = active?.operation_id === operation ? active : this.d.sql.exec<Barrier>(`SELECT operation_id,email,email_fingerprint,generation FROM invite_revocation_quarantines WHERE operation_id=?`, operation).toArray()[0];
    if (row?.operation_id === operation) {
      const counts = this.d.sql.exec<{ remaining: number; orphans: number }>(`SELECT count(*) AS remaining,
        coalesce(sum(CASE WHEN state='created' THEN 1 ELSE 0 END),0) AS orphans
        FROM invite_revocation_claims WHERE operation_id=? AND state<>'closed'`, operation).one();
      return { state: "pending", remaining: counts.remaining, orphans: counts.orphans };
    }
    if (this.d.sql.exec(`SELECT operation_id FROM invite_revocation_receipts WHERE operation_id=?`, operation).toArray().length)
      return { state: "complete" };
    return { state: "unknown" };
  }

  /** Snapshot every unbound matching-email claim, including older generations. */
  private snapshot(operation: string, email: string): void {
    if (this.d.sql.exec(`SELECT t.provider FROM shard_home_claim_tokens t
        LEFT JOIN identity_homes h ON h.provider=t.provider AND h.subject=t.subject
        LEFT JOIN shard_home_invite_claims c ON c.provider=t.provider AND c.subject=t.subject
        WHERE t.provider='google' AND (h.provider IS NULL OR h.shard IS NULL OR
          (c.provider IS NOT NULL AND (c.token IS NOT t.token OR c.user_id IS NOT h.user_id)) OR
          (h.user_id IS NULL AND c.provider IS NULL)) LIMIT 1`).toArray().length)
      throw new AppError("unavailable", "account placement requires review");
    if (this.d.sql.exec(`SELECT h.provider FROM identity_homes h LEFT JOIN shard_home_invite_claims c
        ON c.provider=h.provider AND c.subject=h.subject
        WHERE h.provider='google' AND h.shard IS NOT NULL AND h.user_id IS NULL AND c.provider IS NULL LIMIT 1`).toArray().length)
      throw new AppError("unavailable", "legacy account placement requires review");
    let scanned = 0, selected = 0;
    const rows = this.d.sql.exec<{
      provider: SqlStorageValue; subject: SqlStorageValue; token: SqlStorageValue; email: SqlStorageValue; generation: SqlStorageValue; user_id: SqlStorageValue;
      home_shard: SqlStorageValue; home_user: SqlStorageValue; home_state: SqlStorageValue; home_generation: SqlStorageValue; home_token: SqlStorageValue;
    }>(`SELECT c.provider,c.subject,c.token,c.email,c.generation,c.user_id,
        h.shard AS home_shard,h.user_id AS home_user,h.placement_state AS home_state,h.generation AS home_generation,t.token AS home_token
      FROM shard_home_invite_claims c
      LEFT JOIN identity_homes h ON h.provider=c.provider AND h.subject=c.subject
      LEFT JOIN shard_home_claim_tokens t ON t.provider=c.provider AND t.subject=c.subject LIMIT 10001`);
    for (const row of rows) {
      if (++scanned > MAX_ROWS) throw new AppError("unavailable", "invitation claim inventory requires review");
      const claim = { token: row.token, email: row.email, generation: row.generation };
      if (row.provider !== "google" || typeof row.subject !== "string" || !row.subject || row.subject.length > 1024 ||
          !validShardInviteClaim(claim) || row.home_token !== claim.token || !Number.isInteger(row.home_shard) ||
          (row.home_shard as number) < 0 || (row.home_shard as number) > 15 || row.home_state !== "open" ||
          row.home_generation !== null || row.user_id !== row.home_user ||
          (row.user_id !== null && (typeof row.user_id !== "string" || !row.user_id)))
        throw new AppError("unavailable", "invitation claim requires review");
      if (row.user_id !== null || claim.email !== email) continue;
      if (++selected > MAX_CLAIMS) throw new AppError("unavailable", "invitation claim inventory requires review");
      this.d.sql.exec(`INSERT INTO invite_revocation_claims(operation_id,token,provider,subject,shard,email,generation,state)
        VALUES (?,?,'google',?,?,?,?,'pending')`, operation, claim.token, row.subject, row.home_shard as number, claim.email, claim.generation);
    }
  }

  /** Persist the barrier, snapshot and recovery alarm atomically before RPCs. */
  async begin(emailInput: string, operation: string): Promise<InviteRevocationStatus> {
    this.validateOperation(operation);
    if (typeof emailInput !== "string" || !emailInput.trim() || emailInput.length > 320)
      throw new AppError("invalid", "invalid invitation revocation");
    const email = emailInput.trim().toLowerCase();
    if (email.length > 320) throw new AppError("invalid", "invalid invitation revocation");
    const fingerprint = await this.d.fingerprint(operation, email);
    if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint))
      throw new AppError("unavailable", "invitation revocation requires review");
    await this.d.storage.transaction(async () => {
      const receipt = this.d.sql.exec<{ email_fingerprint: string }>(
        `SELECT email_fingerprint FROM invite_revocation_receipts WHERE operation_id=?`, operation,
      ).toArray()[0];
      if (receipt) {
        if (receipt.email_fingerprint !== fingerprint) throw new AppError("conflict", "invitation revocation changed");
        return;
      }
      const quarantined = this.d.sql.exec<{ operation_id: string; email: string; email_fingerprint: string }>(
        `SELECT operation_id,email,email_fingerprint FROM invite_revocation_quarantines WHERE operation_id=? OR email=?`, operation, email,
      ).toArray();
      if (quarantined.length) {
        if (quarantined.length !== 1 || quarantined[0]!.operation_id !== operation || quarantined[0]!.email !== email || quarantined[0]!.email_fingerprint !== fingerprint)
          throw new AppError("conflict", "invitation revocation changed");
        return;
      }
      const existing = this.row();
      if (existing) {
        if (existing.operation_id === operation && (existing.email !== email || existing.email_fingerprint !== fingerprint))
          throw new AppError("conflict", "invitation revocation changed");
        if (existing.operation_id !== operation)
          throw new AppError("unavailable", "invitation revocation is busy");
      } else {
        this.d.verifyRollout();
        if (this.d.sql.exec(`SELECT slot FROM invite_inventory_barrier LIMIT 1`).toArray().length)
          throw new AppError("unavailable", "invitation inventory is busy");
        const grant = this.d.sql.exec<{ generation: string | null }>(`SELECT generation FROM invites WHERE email=?`, email).toArray()[0];
        if (grant && (typeof grant.generation !== "string" || !/^[a-f0-9]{32}$/.test(grant.generation)))
          throw new AppError("unavailable", "invitation requires review");
        this.d.sql.exec(`INSERT INTO invite_revocation_barrier(slot,operation_id,email,email_fingerprint,generation,created_at) VALUES (1,?,?,?,?,?)`,
          operation, email, fingerprint, grant?.generation ?? null, Date.now());
        this.snapshot(operation, email);
      }
      const at = Date.now() + RETRY_MS, old = await this.d.storage.getAlarm();
      if (old === null || old > at) await this.d.storage.setAlarm(at);
    });
    return this.status(operation);
  }

  private claim(row: ClaimRow): RevokedShardClaim {
    return { operationId: row.operationId, provider: row.provider, subject: row.subject, shard: row.shard,
      token: row.token, email: row.email, generation: row.generation };
  }

  /** Resume from persisted receipts. Created accounts remain quarantined/pending. */
  async resume(): Promise<void> {
    const barrier = this.row();
    if (!barrier) return;
    this.d.verifyRollout();
    const operation = barrier.operation_id;
    const rows = this.d.sql.exec<ClaimRow>(`SELECT operation_id AS operationId,provider,subject,shard,token,email,generation,state,user_id,vault_id
      FROM invite_revocation_claims WHERE operation_id=? AND state IN ('pending','absent') ORDER BY token LIMIT 8`, operation).toArray();
    const jobs = Promise.allSettled(rows.map(async (row) => {
      const claim = this.claim(row);
      try {
        if (row.state === "pending") {
          const result = await this.d.seal(claim);
          if (!result || !["absent", "created", "closed"].includes(result.state)) throw new Error("invalid_claim_seal");
          // A closed response without our own prior persisted absent receipt
          // is not evidence of the ordering that authorized closure.
          if (result.state === "closed") throw new Error("unexpected_closed_claim");
          if (result.state === "created" && (typeof result.userId !== "string" || !result.userId ||
              directoryNameForUser(result.userId) !== `directory-${claim.shard}` ||
              typeof result.vaultId !== "string" || !/^[a-f0-9]{64}$/i.test(result.vaultId))) throw new Error("invalid_claim_seal");
          this.d.transaction(() => {
            if (this.row()?.operation_id !== operation) return;
            this.d.sql.exec(`UPDATE invite_revocation_claims SET state=?,user_id=?,vault_id=? WHERE operation_id=? AND token=? AND state='pending'`,
              result.state, result.state === "created" ? result.userId : null, result.state === "created" ? result.vaultId : null, operation, row.token);
          });
          if (result.state !== "absent") return;
        }
        await this.d.close(claim);
        this.d.transaction(() => {
          if (this.row()?.operation_id !== operation) return;
          this.d.sql.exec(`UPDATE invite_revocation_claims SET state='closed' WHERE operation_id=? AND token=? AND state='absent'`, operation, row.token);
        });
      } catch { /* Unknown outcome remains pending for the prearmed alarm. */ }
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, this.d.waitMs ?? 30_000); });
    await Promise.race([jobs, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    this.d.transaction(() => {
      this.d.verifyRollout();
      const current = this.row();
      if (!current || current.operation_id !== operation || current.email !== barrier.email || current.email_fingerprint !== barrier.email_fingerprint || current.generation !== barrier.generation) return;
      const unsettled = this.d.sql.exec<{ state: string; user_id: string | null; vault_id: string | null }>(
        `SELECT state,user_id,vault_id FROM invite_revocation_claims WHERE operation_id=? AND state<>'closed'`, operation,
      ).toArray();
      if (unsettled.length) {
        // Unknown and absent-but-not-yet-closed dispatches stay active. A
        // discovered account stays quarantined; neither its data nor its
        // permanent shard token tombstone is removed here.
        if (unsettled.some((r) => r.state !== "created" || !r.user_id || !r.vault_id)) return;
        this.d.sql.exec(`INSERT INTO invite_quarantine_marker(slot,operation_id) VALUES (1,?)`, operation);
        try {
          this.d.sql.exec(`INSERT INTO invite_revocation_quarantines(operation_id,email,email_fingerprint,generation,created_at)
            SELECT operation_id,email,email_fingerprint,generation,created_at FROM invite_revocation_barrier WHERE operation_id=?`, operation);
          this.d.sql.exec(`DELETE FROM invite_revocation_barrier WHERE slot=1 AND operation_id=?`, operation);
        } finally { this.d.sql.exec(`DELETE FROM invite_quarantine_marker WHERE slot=1`); }
        return;
      }
      const grant = this.d.sql.exec<{ generation: string | null }>(`SELECT generation FROM invites WHERE email=?`, barrier.email).toArray()[0];
      if (grant && (typeof grant.generation !== "string" || !/^[a-f0-9]{32}$/.test(grant.generation)))
        throw new AppError("unavailable", "invitation requires review");
      if ((grant?.generation ?? null) !== barrier.generation) throw new AppError("unavailable", "invitation changed; review required");
      this.d.sql.exec(`INSERT INTO invite_revocation_mutation_marker(slot,operation_id) VALUES (1,?)`, operation);
      try {
        // Every old token is tombstoned before releasing its unbound home.
        const closed = this.d.sql.exec<{ provider: string; subject: string; token: string }>(
          `SELECT provider,subject,token FROM invite_revocation_claims WHERE operation_id=? AND state='closed'`, operation,
        ).toArray();
        for (const item of closed) {
          const before = this.d.sql.exec(`SELECT provider FROM identity_homes WHERE provider=? AND subject=? AND user_id IS NULL
            AND EXISTS(SELECT 1 FROM shard_home_invite_claims c WHERE c.provider=? AND c.subject=? AND c.token=? AND c.user_id IS NULL)`,
            item.provider, item.subject, item.provider, item.subject, item.token).toArray();
          if (before.length !== 1) throw new AppError("unavailable", "account placement changed; review required");
          this.d.sql.exec(`DELETE FROM identity_homes WHERE provider=? AND subject=? AND user_id IS NULL`, item.provider, item.subject);
          if (this.d.sql.exec(`SELECT provider FROM identity_homes WHERE provider=? AND subject=?`, item.provider, item.subject).toArray().length)
            throw new AppError("unavailable", "account placement changed; review required");
        }
        if (barrier.generation !== null) this.d.removeInvite(barrier.email, barrier.generation);
      } finally { this.d.sql.exec(`DELETE FROM invite_revocation_mutation_marker WHERE slot=1`); }
      this.d.sql.exec(`INSERT INTO invite_revocation_receipts(operation_id,email_fingerprint) VALUES (?,?)`, operation, barrier.email_fingerprint);
      this.d.sql.exec(`DELETE FROM invite_revocation_claims WHERE operation_id=?`, operation);
      this.d.sql.exec(`DELETE FROM invite_revocation_barrier WHERE slot=1 AND operation_id=?`, operation);
    });
  }
}
