import { AppError } from "../shared/errors";

/** The exact shard finalization and invitation claim being attested. */
export type InviteTarget = {
  userId: string;
  vaultId: string;
  operationId: string;
  finalGeneration: string;
  email: string;
  provider: "google";
  subject: string;
  claimToken: string;
  generation: string | null;
};

// A target proof is meaningful only while all of its source rows remain
// unchanged. These guards deliberately fence whole tables on that one shard;
// this may delay unrelated writes until the coordinator closes the seal.
export const INVITE_TARGET_SEAL_MIGRATIONS = [
  `CREATE TABLE shard_invite_target_seals (
    operation_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, vault_id TEXT NOT NULL,
    deletion_operation TEXT NOT NULL, final_generation TEXT NOT NULL, email TEXT NOT NULL,
    provider TEXT NOT NULL, subject TEXT NOT NULL, claim_token TEXT NOT NULL, generation TEXT
  )`,
  `CREATE TABLE shard_invite_target_close_marker (operation_id TEXT PRIMARY KEY)`,
  `CREATE TRIGGER shard_invite_target_insert_guard BEFORE INSERT ON shard_invite_target_seals
   WHEN NOT EXISTS(SELECT 1 FROM shard_invite_inventory WHERE operation_id=NEW.operation_id AND state='active')
   BEGIN SELECT RAISE(ABORT, 'invite_target_seal_required'); END`,
  `CREATE TRIGGER shard_invite_target_update_guard BEFORE UPDATE ON shard_invite_target_seals
   BEGIN SELECT RAISE(ABORT, 'invite_target_seal_immutable'); END`,
  `CREATE TRIGGER shard_invite_target_delete_guard BEFORE DELETE ON shard_invite_target_seals
   WHEN NOT EXISTS(SELECT 1 FROM shard_invite_target_close_marker WHERE operation_id=OLD.operation_id)
   BEGIN SELECT RAISE(ABORT, 'invite_target_close_required'); END`,
  // Prevent an older close implementation from acknowledging closure while
  // it has left an identifying target proof, or from changing the receipt.
  ...["UPDATE", "DELETE"].map((action) =>
    `CREATE TRIGGER shard_invite_target_inventory_${action.toLowerCase()} BEFORE ${action} ON shard_invite_inventory
     WHEN EXISTS(SELECT 1 FROM shard_invite_target_seals WHERE operation_id=OLD.operation_id)
     BEGIN SELECT RAISE(ABORT, 'invite_target_close_required'); END`,
  ),
  ...[
    "vaults", "vault_initializations", "account_final_sweeps", "account_invite_deletions",
    "retired_vaults", "vault_replacements", "identities", "shard_identity_claim_tokens",
    "shard_invite_account_bindings", "shard_deletion_releases", "placement_identities", "placement_finalizations",
  ].flatMap((table) => ["INSERT", "UPDATE", "DELETE"].map((action) =>
    `CREATE TRIGGER shard_invite_target_${table}_${action.toLowerCase()} BEFORE ${action} ON ${table}
     WHEN EXISTS(SELECT 1 FROM shard_invite_target_seals)
     BEGIN SELECT RAISE(ABORT, 'invite_target_sealed'); END`,
  )),
];

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Called only within the shard's existing synchronous seal transaction. */
export class InviteTargetSeal {
  constructor(private readonly sql: SqlStorage, private readonly mayExclude: (userId: string) => boolean) {}

  private validateInput(target: InviteTarget, email: string, excludedUserId: string): void {
    if (!target || typeof target !== "object" || target.userId !== excludedUserId || !this.mayExclude(target.userId) ||
        typeof target.vaultId !== "string" || !/^[0-9a-f]{64}$/i.test(target.vaultId) ||
        typeof target.operationId !== "string" || !uuid.test(target.operationId) ||
        typeof target.finalGeneration !== "string" || !uuid.test(target.finalGeneration) ||
        target.provider !== "google" || typeof target.subject !== "string" || !target.subject || target.subject.length > 1024 ||
        typeof target.claimToken !== "string" || !uuid.test(target.claimToken) ||
        typeof target.email !== "string" || target.email !== email ||
        (target.generation !== null && (typeof target.generation !== "string" || !/^[a-f0-9]{32}$/.test(target.generation))))
      throw new AppError("invalid", "invalid invitation target");
  }

  /** An unattributed lock or close marker requires reconciliation. */
  idle(): boolean {
    return this.sql.exec(`SELECT operation_id FROM shard_invite_target_seals UNION ALL SELECT operation_id FROM shard_invite_target_close_marker LIMIT 1`).toArray().length === 0;
  }

  /** Validate the exact owner, destroyed finalization and creation-time claim. */
  validate(target: InviteTarget, email: string, excludedUserId: string): void {
    this.validateInput(target, email, excludedUserId);
    const owner = this.sql.exec<{ vault_swept: SqlStorageValue; final_swept: SqlStorageValue }>(`SELECT v.swept_at AS vault_swept, a.swept_at AS final_swept FROM vaults v
      JOIN users u ON u.user_id=v.user_id
      JOIN account_final_sweeps a ON a.vault_id=v.vault_id AND a.user_id=u.user_id
      JOIN account_invite_deletions d ON d.vault_id=v.vault_id AND d.user_id=u.user_id
      JOIN shard_invite_account_bindings b ON b.user_id=u.user_id
      JOIN identities i ON i.user_id=u.user_id AND i.provider=b.provider AND i.subject=b.subject
      JOIN shard_identity_claim_tokens t ON t.user_id=u.user_id AND t.provider=b.provider AND t.subject=b.subject AND t.token=b.token
      WHERE v.vault_id=? AND v.user_id=? AND u.email=? AND u.state='deleting' AND v.state='swept'
        AND v.swept_at=a.swept_at AND a.generation=? AND a.phase='destroyed' AND a.invite_closed=0
        AND d.operation_id=? AND b.provider=? AND b.subject=? AND b.email=? AND b.token=? AND b.generation IS ?`,
      target.vaultId, target.userId, target.email, target.finalGeneration, target.operationId,
      target.provider, target.subject, target.email, target.claimToken, target.generation,
    ).toArray();
    const retired = this.sql.exec(`SELECT vault_id FROM retired_vaults WHERE user_id=? OR vault_id=? LIMIT 1`, target.userId, target.vaultId).toArray();
    const swept = owner[0];
    if (owner.length !== 1 || retired.length || !swept || typeof swept.vault_swept !== "number" ||
        !Number.isSafeInteger(swept.vault_swept) || swept.vault_swept <= 0 ||
        typeof swept.final_swept !== "number" || swept.final_swept !== swept.vault_swept)
      throw new AppError("unavailable", "invitation target requires review");
  }

  install(attempt: string, target: InviteTarget): void {
    this.sql.exec(`INSERT INTO shard_invite_target_seals
      (operation_id,user_id,vault_id,deletion_operation,final_generation,email,provider,subject,claim_token,generation)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, attempt, target.userId, target.vaultId, target.operationId,
      target.finalGeneration, target.email, target.provider, target.subject, target.claimToken, target.generation);
  }

  matches(attempt: string, target?: InviteTarget): boolean {
    if (this.sql.exec(`SELECT operation_id FROM shard_invite_target_close_marker WHERE operation_id=?`, attempt).toArray().length)
      return false;
    const rows = this.sql.exec(`SELECT operation_id FROM shard_invite_target_seals WHERE operation_id=?`, attempt).toArray();
    if (!target) return rows.length === 0;
    return rows.length === 1 && this.sql.exec(`SELECT operation_id FROM shard_invite_target_seals
      WHERE operation_id=? AND user_id=? AND vault_id=? AND deletion_operation=? AND final_generation=?
        AND email=? AND provider=? AND subject=? AND claim_token=? AND generation IS ?`, attempt, target.userId, target.vaultId,
      target.operationId, target.finalGeneration, target.email, target.provider, target.subject, target.claimToken, target.generation).toArray().length === 1;
  }

  clear(attempt: string): void {
    if (!this.sql.exec(`SELECT operation_id FROM shard_invite_target_seals WHERE operation_id=?`, attempt).toArray().length) return;
    this.sql.exec(`INSERT INTO shard_invite_target_close_marker(operation_id) VALUES (?)`, attempt);
    try { this.sql.exec(`DELETE FROM shard_invite_target_seals WHERE operation_id=?`, attempt); }
    finally { this.sql.exec(`DELETE FROM shard_invite_target_close_marker WHERE operation_id=?`, attempt); }
  }
}
