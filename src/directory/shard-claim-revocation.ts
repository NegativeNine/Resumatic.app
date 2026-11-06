import { AppError } from "../shared/errors";
import { contentDigest } from "../shared/operations";
import { validShardInviteClaim } from "./shard-invite-binding";

/** Exact global claim and revocation operation sent to its designated shard. */
export interface RevokedShardClaim {
  operationId: string;
  provider: "google";
  subject: string;
  shard: number;
  token: string;
  email: string;
  generation: string | null;
}

export type ShardClaimSeal =
  | { state: "absent" }
  | { state: "created"; userId: string; vaultId: string }
  | { state: "closed" };

/**
 * Token tombstones survive receipt closure, so an old target RPC cannot
 * create an account after the revocation coordinator has stopped waiting.
 * The digest binds retries to one exact tuple without retaining its email or
 * subject in a closed tombstone. A created receipt keeps owner IDs until a
 * separately verified orphan-erasure protocol can settle it.
 */
export const SHARD_CLAIM_REVOCATION_MIGRATIONS = [
  `CREATE TABLE shard_revoked_invite_claims (
    token TEXT PRIMARY KEY, operation_id TEXT NOT NULL, tuple_digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('absent','created','closed')),
    user_id TEXT, vault_id TEXT,
    CHECK((state='created' AND user_id IS NOT NULL AND vault_id IS NOT NULL) OR
      (state IN ('absent','closed') AND user_id IS NULL AND vault_id IS NULL))
  )`,
  `CREATE TRIGGER shard_revoked_invite_claim_delete BEFORE DELETE ON shard_revoked_invite_claims
   BEGIN SELECT RAISE(ABORT, 'shard_invite_tombstone_required'); END`,
  `CREATE TRIGGER shard_revoked_invite_claim_update BEFORE UPDATE ON shard_revoked_invite_claims
   WHEN NEW.token IS NOT OLD.token OR NEW.operation_id IS NOT OLD.operation_id OR NEW.tuple_digest IS NOT OLD.tuple_digest
     OR OLD.state <> 'absent' OR NEW.state <> 'closed' OR NEW.user_id IS NOT NULL OR NEW.vault_id IS NOT NULL
   BEGIN SELECT RAISE(ABORT, 'shard_invite_tombstone_immutable'); END`,
  `CREATE TABLE shard_invite_create_marker (
    provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, token TEXT NOT NULL,
    PRIMARY KEY(provider,subject,user_id)
  )`,
  `CREATE INDEX shard_invite_account_bindings_token ON shard_invite_account_bindings(token)`,
  `CREATE INDEX shard_identity_claim_tokens_token ON shard_identity_claim_tokens(token)`,
  `CREATE TRIGGER shard_invite_create_marker_open BEFORE INSERT ON shard_invite_create_marker
   WHEN EXISTS(SELECT 1 FROM shard_revoked_invite_claims WHERE token=NEW.token)
   BEGIN SELECT RAISE(ABORT, 'shard_invite_claim_sealed'); END`,
  `CREATE TRIGGER shard_revoked_token_insert BEFORE INSERT ON shard_identity_claim_tokens
   WHEN EXISTS(SELECT 1 FROM shard_revoked_invite_claims WHERE token=NEW.token)
   BEGIN SELECT RAISE(ABORT, 'shard_invite_claim_sealed'); END`,
  `CREATE TRIGGER shard_revocation_identity_insert BEFORE INSERT ON identities
   WHEN NEW.provider='google' AND EXISTS(SELECT 1 FROM meta WHERE key='shard_invite_revocation_guard' AND value='1')
    AND NOT EXISTS(SELECT 1 FROM shard_invite_create_marker m
      WHERE m.provider=NEW.provider AND m.subject=NEW.subject AND m.user_id=NEW.user_id
       AND NOT EXISTS(SELECT 1 FROM shard_revoked_invite_claims s WHERE s.token=m.token))
   BEGIN SELECT RAISE(ABORT, 'shard_invite_registration_required'); END`,
];

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function checked(value: RevokedShardClaim): RevokedShardClaim {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.operationId !== "string" || !uuid.test(value.operationId) || value.provider !== "google" ||
      typeof value.subject !== "string" || !value.subject || value.subject.length > 1024 ||
      !Number.isInteger(value.shard) || value.shard < 0 || value.shard > 15 ||
      !validShardInviteClaim({ token: value.token, email: value.email, generation: value.generation }))
    throw new AppError("invalid", "invalid shard invitation revocation");
  // Copy before hashing: no mutable caller-owned object crosses the await.
  return { operationId: value.operationId, provider: "google", subject: value.subject, shard: value.shard,
    token: value.token, email: value.email, generation: value.generation };
}

type Row = { operation_id: string; tuple_digest: string; state: string; user_id: string | null; vault_id: string | null };

export class ShardClaimRevocation {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transaction: <T>(fn: () => T) => T,
    private readonly mayTarget: (shard: number, userId?: string) => boolean,
  ) {}

  /** Call inside the same transaction as the target identity insertion. */
  beginCreate(provider: string, subject: string, userId: string, token: string): void {
    this.assertOpen(token);
    this.sql.exec(`INSERT INTO shard_invite_create_marker(provider,subject,user_id,token) VALUES (?,?,?,?)`, provider, subject, userId, token);
  }

  /** Call in finally within that transaction. */
  endCreate(provider: string, subject: string, userId: string): void {
    this.sql.exec(`DELETE FROM shard_invite_create_marker WHERE provider=? AND subject=? AND user_id=?`, provider, subject, userId);
  }

  /** A sealed token must also be checked after any awaited initialization. */
  assertOpen(token: string): void {
    if (typeof token !== "string" || !uuid.test(token)) throw new AppError("invalid", "invalid shard invitation claim");
    if (this.sql.exec(`SELECT token FROM shard_revoked_invite_claims WHERE token=?`, token).toArray().length)
      throw new AppError("forbidden", "this invitation claim is no longer available");
  }

  async seal(input: RevokedShardClaim): Promise<ShardClaimSeal> {
    const claim = checked(input);
    if (!this.mayTarget(claim.shard)) throw new AppError("invalid", "invalid shard invitation target");
    const digest = await contentDigest(["shard-claim-revocation-v1", claim.operationId, claim.provider,
      claim.subject, claim.shard, claim.token, claim.email, claim.generation]);
    return this.transaction(() => {
      const existing = this.sql.exec<Row>(`SELECT operation_id,tuple_digest,state,user_id,vault_id FROM shard_revoked_invite_claims WHERE token=?`, claim.token).toArray()[0];
      if (existing) {
        if (existing.operation_id !== claim.operationId || existing.tuple_digest !== digest)
          throw new AppError("conflict", "shard invitation revocation changed");
        if (existing.state === "closed") {
          if (existing.user_id !== null || existing.vault_id !== null) throw new AppError("unavailable", "shard invitation revocation requires review");
          return { state: "closed" };
        }
        if (existing.state === "absent" && existing.user_id === null && existing.vault_id === null) return { state: "absent" };
        if (existing.state === "created" && typeof existing.user_id === "string" && this.mayTarget(claim.shard, existing.user_id) &&
            typeof existing.vault_id === "string" && /^[a-f0-9]{64}$/i.test(existing.vault_id))
          return { state: "created", userId: existing.user_id, vaultId: existing.vault_id };
        throw new AppError("unavailable", "shard invitation revocation requires review");
      }
      // Creation markers are normally inserted and removed in the same SQLite
      // transaction. A committed marker is ambiguous and cannot prove absence.
      if (this.sql.exec(`SELECT 1 FROM shard_invite_create_marker WHERE token=? OR (provider=? AND subject=?) LIMIT 1`,
        claim.token, claim.provider, claim.subject).toArray().length)
        throw new AppError("unavailable", "shard invitation claim requires review");
      const identities = this.sql.exec<{ user_id: string }>(`SELECT user_id FROM identities WHERE provider=? AND subject=? LIMIT 2`, claim.provider, claim.subject).toArray();
      const bindings = this.sql.exec<{ user_id: string; provider: string; subject: string; token: string; email: string; generation: string | null }>(
        `SELECT user_id,provider,subject,token,email,generation FROM shard_invite_account_bindings
         WHERE token=? OR (provider=? AND subject=?) LIMIT 2`, claim.token, claim.provider, claim.subject,
      ).toArray();
      const tokens = this.sql.exec<{ user_id: string; provider: string; subject: string; token: string }>(
        `SELECT user_id,provider,subject,token FROM shard_identity_claim_tokens
         WHERE token=? OR (provider=? AND subject=?) LIMIT 2`, claim.token, claim.provider, claim.subject,
      ).toArray();
      let userId: string | null = null, vaultId: string | null = null;
      if (identities.length || bindings.length || tokens.length) {
        if (identities.length !== 1 || bindings.length !== 1 || tokens.length !== 1)
          throw new AppError("unavailable", "shard invitation claim requires review");
        const binding = bindings[0]!, token = tokens[0]!;
        userId = identities[0]!.user_id;
        const rows = this.sql.exec<{ email: string; state: string; vault_id: string }>(
          `SELECT u.email,u.state,v.vault_id FROM users u JOIN vaults v ON v.user_id=u.user_id WHERE u.user_id=? LIMIT 2`, userId,
        ).toArray();
        if (typeof userId !== "string" || !this.mayTarget(claim.shard, userId) || rows.length !== 1 ||
            typeof rows[0]!.vault_id !== "string" || !/^[a-f0-9]{64}$/i.test(rows[0]!.vault_id) ||
            rows[0]!.email !== claim.email || !["active", "deleting"].includes(rows[0]!.state) ||
            binding.user_id !== userId || binding.provider !== claim.provider || binding.subject !== claim.subject ||
            binding.token !== claim.token || binding.email !== claim.email || binding.generation !== claim.generation ||
            token.user_id !== userId || token.provider !== claim.provider || token.subject !== claim.subject || token.token !== claim.token)
          throw new AppError("unavailable", "shard invitation claim requires review");
        vaultId = rows[0]!.vault_id;
      }
      this.sql.exec(`INSERT INTO meta(key,value) VALUES ('shard_invite_revocation_guard','1') ON CONFLICT(key) DO UPDATE SET value='1'`);
      this.sql.exec(`INSERT INTO shard_revoked_invite_claims(token,operation_id,tuple_digest,state,user_id,vault_id) VALUES (?,?,?,?,?,?)`,
        claim.token, claim.operationId, digest, userId === null ? "absent" : "created", userId, vaultId);
      return userId === null ? { state: "absent" } : { state: "created", userId, vaultId: vaultId! };
    });
  }

  /** Redact an absent receipt; a discovered account needs separate erasure. */
  async close(input: RevokedShardClaim): Promise<void> {
    const claim = checked(input);
    const observed = await this.seal(claim);
    if (observed.state === "created") throw new AppError("unavailable", "orphan account requires reconciliation");
    if (observed.state === "closed") return;
    this.transaction(() => {
      const row = this.sql.exec<Row>(`SELECT operation_id,tuple_digest,state,user_id,vault_id FROM shard_revoked_invite_claims WHERE token=?`, claim.token).one();
      if (row.operation_id !== claim.operationId || row.state !== "absent" || row.user_id !== null || row.vault_id !== null)
        throw new AppError("unavailable", "shard invitation revocation requires review");
      this.sql.exec(`UPDATE shard_revoked_invite_claims SET state='closed' WHERE token=? AND state='absent'`, claim.token);
    });
  }
}
